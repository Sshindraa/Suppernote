import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { processTranscriptStreaming } from '../stream/llm-handler';
import { createConversationState } from '../stream/conversation-controller';
import type { StructuredTurnOutput } from '../stream/structured-turn/schema';
import {
  CALLER_FINISHED_FALLBACK,
  incompleteTurnSilenceMs,
  speculateStructuredTurn,
  generateRecoveryReply,
} from '../stream/structured-turn/engine';
import {
  bookingKey,
  createStructuredTurnState,
  todayInTimezone,
} from '../stream/structured-turn/fact-guards';
import { turnJudgeDisagreementSilenceMs } from '../stream/structured-turn/turn-end-judge';
import type { CallSession } from '../stream/types';
import type { CallSessionManager } from '../stream/manager';
import { speakTtsStreamed } from '../stream/tts-handler';
import { __resetMetrics } from '../../../shared/observability/metrics';
import { systemOf } from './helpers/system-of';

vi.mock('../stream/tts-handler', () => ({
  speakTtsStreamed: vi.fn().mockResolvedValue(undefined),
  isSessionActiveForTts: vi.fn().mockReturnValue(true),
  cleanTextForTts: (text: string) => text,
}));
const contextTurn: {
  push: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  hasAudioOutput: boolean;
  onHoldCancelled?: () => void;
} = {
  push: vi.fn(),
  finish: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  hasAudioOutput: false,
};
vi.mock('../stream/cartesia-context', () => ({
  createCartesiaContextTurn: vi.fn(() => null),
}));
vi.mock('../../../shared/telnyx/http-agent', () => ({
  telnyxFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const RESTAURANT_ID = 'resto-structured';
const TOMORROW = (() => {
  const date = new Date(`${todayInTimezone('Europe/Paris')}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
})();

function turn(overrides: Partial<StructuredTurnOutput> = {}): StructuredTurnOutput {
  return {
    turnComplete: true,
    interpretation: 'answer',
    draft: { date: '', time: '', partySize: 0, customerName: '' },
    awaiting: 'none',
    action: 'none',
    message: '',
    confidence: 'high',
    say: '',
    ...overrides,
  };
}

function fixture() {
  const session = {
    callControlId: 'cc-structured',
    restaurantId: RESTAURANT_ID,
    timezone: 'Europe/Paris',
    from: '+33600000000',
    systemPrompt: "Tu es l'assistant vocal de Test Resto.",
    state: 'LISTENING',
    ended: false,
    responseGeneration: 0,
    ttsGeneration: 0,
    history: [],
    turnCount: 1,
    conversation: createConversationState(),
    telnyxWs: { readyState: WebSocket.OPEN, send: vi.fn() },
  } as unknown as CallSession;
  const outputs: StructuredTurnOutput[] = [];
  const judgeCalls = { count: 0 };
  const judgeScript = { next: (): Promise<string> => Promise.resolve('{"complete":true}') };
  const mgr = {
    handleBargeIn: vi.fn(),
    transition: vi.fn((s: CallSession, state: CallSession['state']) => {
      s.state = state;
      return true;
    }),
    cleanup: vi.fn((s: CallSession) => {
      s.ended = true;
      s.state = 'IDLE';
    }),
    // Le modèle est simulé : sa sortie est émise par petits fragments, comme en streaming.
    streamStructuredCompletion: vi.fn(
      async (
        _session: CallSession,
        _messages: unknown,
        format: { json_schema?: { name?: string } },
        options: { onDelta: (delta: string) => void },
      ) => {
        // Le juge de fin de tour (requête minimale) a son propre script de verdicts.
        if (format?.json_schema?.name === 'turn_end_judge') {
          judgeCalls.count++;
          return judgeScript.next();
        }
        const next = outputs.shift();
        if (!next) throw new Error('no scripted model output');
        const json = JSON.stringify(next);
        for (let index = 0; index < json.length; index += 7) {
          options.onDelta(json.slice(index, index + 7));
        }
        return json;
      },
    ),
    getTableRanges: vi.fn(async () => [{ capacity: 12, minCapacity: 1 }]),
    getAvailability: vi.fn(async (_s: CallSession, date: string, partySize: number) => ({
      restaurantId: RESTAURANT_ID,
      date,
      partySize,
      slots: ['19:00', '19:30', '20:00'],
      allSlots: [],
    })),
    createReservationFromConversation: vi.fn(async (s: CallSession) => {
      s.reservationCreatedAt = Date.now();
      return 'Réservation confirmée.';
    }),
    handoffToManager: vi.fn().mockResolvedValue('Je vous passe le gérant.'),
    recordCallerMessage: vi.fn().mockResolvedValue('Message enregistré.'),
  } as unknown as CallSessionManager;
  return { session, mgr, outputs, judgeCalls, judgeScript };
}

function spoken(): string[] {
  return vi.mocked(speakTtsStreamed).mock.calls.map(([, text]) => String(text));
}

beforeEach(() => {
  __resetMetrics();
  vi.clearAllMocks();
  return () => vi.unstubAllEnvs();
});

const verdict = (complete: boolean) => () => Promise.resolve(JSON.stringify({ complete }));
const modelCalls = (mgr: CallSessionManager) =>
  vi
    .mocked(mgr.streamStructuredCompletion)
    .mock.calls.filter(
      ([, , format]) =>
        (format as { json_schema?: { name?: string } }).json_schema?.name !== 'turn_end_judge',
    );

describe('juge de fin de tour séparé : décision de répondre', () => {
  it('se tait et garde le fragment quand le juge dit inachevé, même si le modèle disait fini', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    outputs.push(turn({ awaiting: 'time', say: 'Très bien, vers quelle heure ?' }));

    await processTranscriptStreaming(session, 'je voudrais bien venir', mgr);

    expect(spoken()).toEqual([]);
    expect(session.history).toEqual([]);
    expect(session.structuredTurn?.pendingFragment).toBe('je voudrais bien venir');
    expect(session.state).toBe('LISTENING');
  });

  it('répond normalement quand juge et modèle disent fini : un appel du juge, un du modèle', async () => {
    const { session, mgr, outputs, judgeCalls, judgeScript } = fixture();
    judgeScript.next = verdict(true);
    outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));

    await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

    expect(spoken()).toEqual(['Bien sûr.', 'Pour quel jour ?']);
    expect(judgeCalls.count).toBe(1);
    expect(modelCalls(mgr)).toHaveLength(1);
  });

  it('refait la réponse quand le juge dit fini et que le modèle se taisait (turnComplete=false)', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(true);
    outputs.push(
      turn({ turnComplete: false, interpretation: 'unclear', confidence: 'low' }),
      turn({ awaiting: 'date', say: 'Pour quel jour ?' }),
    );

    await processTranscriptStreaming(session, 'trois personnes', mgr);

    expect(spoken()).toEqual(['Pour quel jour ?']);
    const calls = modelCalls(mgr);
    expect(calls).toHaveLength(2);
    const second = systemOf(calls[1][1] as Array<{ role?: string; content: string }>).content;
    expect(second).toContain("L'appelant s'est tu");
  });

  it('retient la phrase tant que le juge n’a pas répondu, puis la dit', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    let release: (value: string) => void = () => undefined;
    judgeScript.next = () => new Promise<string>((resolve) => (release = resolve));
    outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));

    const done = processTranscriptStreaming(session, 'je voudrais réserver', mgr);
    await vi.waitFor(() => expect(modelCalls(mgr)).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(spoken()).toEqual([]);

    release('{"complete":true}');
    await done;
    expect(spoken()).toEqual(['Bien sûr.', 'Pour quel jour ?']);
  });

  it('retombe sur le turnComplete du modèle quand le juge échoue', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = () => Promise.reject(new Error('indisponible'));
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));
    await processTranscriptStreaming(session, 'je voudrais réserver', mgr);
    expect(spoken()).toEqual(['Pour quel jour ?']);

    const second = fixture();
    second.judgeScript.next = () => Promise.reject(new Error('indisponible'));
    second.outputs.push(turn({ turnComplete: false, interpretation: 'unclear' }));
    await processTranscriptStreaming(second.session, 'trois non non', second.mgr);
    expect(second.session.structuredTurn?.pendingFragment).toBe('trois non non');
  });

  it('retombe sur le turnComplete du modèle quand le juge dépasse son délai', async () => {
    vi.stubEnv('VOICE_TURN_JUDGE_TIMEOUT_MS', '200');
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = () => new Promise<string>(() => undefined);
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));

    const startedAt = Date.now();
    await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

    expect(spoken()).toEqual(['Pour quel jour ?']);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });
});

describe('juge de fin de tour séparé : clôture sémantique (partielle stable)', () => {
  it('le verdict du juge ferme le tour à la place du turnComplete du modèle', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));
    const onVerdict = vi.fn();

    speculateStructuredTurn(session, mgr, 'je voudrais bien venir', onVerdict);
    await vi.waitFor(() => expect(onVerdict).toHaveBeenCalledTimes(1));

    expect(onVerdict).toHaveBeenCalledWith(false);
  });

  it('sans verdict du juge, le turnComplete du modèle ferme le tour comme avant', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = () => Promise.reject(new Error('indisponible'));
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));
    const onVerdict = vi.fn();

    speculateStructuredTurn(session, mgr, 'je voudrais réserver', onVerdict);
    await vi.waitFor(() => expect(onVerdict).toHaveBeenCalledTimes(1));

    expect(onVerdict).toHaveBeenCalledWith(true);
  });

  it('un seul verdict est envoyé, même quand le modèle et le juge répondent', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(true);
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));
    const onVerdict = vi.fn();

    speculateStructuredTurn(session, mgr, 'je voudrais réserver', onVerdict);
    await vi.waitFor(() => expect(onVerdict).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(onVerdict).toHaveBeenCalledTimes(1);
    expect(onVerdict).toHaveBeenCalledWith(true);
  });
});

describe('juge de fin de tour séparé : désaccord avec le modèle', () => {
  // Le juge attend la suite, le modèle a fini et sa réponse est prête : seul le silence réel de l'appelant tranche.
  const withVoice = (session: CallSession, silentForMs: number) => {
    session.callerVoice = {
      noiseFloor: 0,
      trackedMs: 10_000,
      voiceRun: 0,
      lastVoiceAt: Date.now() - silentForMs,
    };
  };

  it('dit la réponse déjà prête quand l’appelant reste silencieux, sans second appel du modèle', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    withVoice(session, 2_000);
    outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));

    await processTranscriptStreaming(session, 'bonjour je voudrais faire vous êtes ouvert', mgr);

    expect(spoken()).toEqual(['Bien sûr.', 'Pour quel jour ?']);
    expect(modelCalls(mgr)).toHaveLength(1);
    expect(session.structuredTurn?.pendingFragment ?? null).toBeNull();
  });

  it('attend que le silence atteigne le seuil avant de parler', async () => {
    vi.stubEnv('VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS', '1000');
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    withVoice(session, 700);
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));

    const startedAt = Date.now();
    await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
    expect(spoken()).toEqual(['Pour quel jour ?']);
  });

  it('se tait et garde le fragment quand l’appelant reprend la parole pendant l’attente', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    withVoice(session, 100);
    outputs.push(turn({ awaiting: 'time', say: 'Très bien, vers quelle heure ?' }));

    const done = processTranscriptStreaming(session, 'demain à 14 heures non', mgr);
    setTimeout(() => {
      if (session.callerVoice) session.callerVoice.lastVoiceAt = Date.now();
    }, 150);
    await done;

    expect(spoken()).toEqual([]);
    expect(session.structuredTurn?.pendingFragment).toBe('demain à 14 heures non');
  });

  it('garde le verdict du juge quand la règle est désactivée (0)', async () => {
    vi.stubEnv('VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS', '0');
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    withVoice(session, 2_000);
    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));

    await processTranscriptStreaming(session, 'je voudrais bien venir', mgr);

    expect(spoken()).toEqual([]);
    expect(session.structuredTurn?.pendingFragment).toBe('je voudrais bien venir');
  });

  it('ne change rien quand le juge et le modèle disent tous deux inachevé', async () => {
    const { session, mgr, outputs, judgeScript } = fixture();
    judgeScript.next = verdict(false);
    withVoice(session, 2_000);
    outputs.push(turn({ turnComplete: false, interpretation: 'unclear', confidence: 'low' }));

    await processTranscriptStreaming(session, 'non h o u e', mgr);

    expect(spoken()).toEqual([]);
    expect(session.structuredTurn?.pendingFragment).toBe('non h o u e');
  });

  it('borne le seuil de silence (0 désactive)', () => {
    expect(turnJudgeDisagreementSilenceMs({})).toBe(1_200);
    expect(turnJudgeDisagreementSilenceMs({ VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS: '0' })).toBe(
      0,
    );
    expect(
      turnJudgeDisagreementSilenceMs({ VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS: '900' }),
    ).toBe(900);
    expect(
      turnJudgeDisagreementSilenceMs({ VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS: '100' }),
    ).toBe(1_200);
    expect(
      turnJudgeDisagreementSilenceMs({ VOICE_TURN_JUDGE_DISAGREEMENT_SILENCE_MS: '9000' }),
    ).toBe(1_200);
  });
});
