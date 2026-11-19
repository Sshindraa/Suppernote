import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import type { CallSession } from '../stream/types';
import {
  __setVoiceFillerAudioForTests,
  voiceFillerTexts,
  waitForVoiceFiller,
} from '../stream/voice-filler';
import type { CallSessionManager } from '../stream/manager';
import { partySizeCorrectionFact } from '../stream/structured-turn/fact-guards';
import { speakTtsStreamed } from '../stream/tts-handler';
import { voiceCardGuaranteeTerms } from '../card-guarantee-facts';
import { __resetMetrics, voiceTtsContextFailureTotal } from '../../../shared/observability/metrics';
import { logger } from '../../../shared/logger/pino';

vi.mock('../stream/tts-handler', () => ({
  speakTtsStreamed: vi.fn().mockResolvedValue(undefined),
  isSessionActiveForTts: vi.fn().mockReturnValue(true),
  cleanTextForTts: (text: string) => text,
}));
// Le tour Cartesia en contexte n'existe que pour les tests qui l'allument ; sinon le chemin HTTP reste en place.
const cartesiaContext = { enabled: false };
const contextTurn: {
  push: ReturnType<typeof vi.fn>;
  finish: ReturnType<typeof vi.fn>;
  cancel: ReturnType<typeof vi.fn>;
  hasAudioOutput: boolean;
  provider: 'cartesia' | 'elevenlabs';
  onHoldCancelled?: () => void;
} = {
  provider: 'cartesia',
  push: vi.fn(),
  finish: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn(),
  hasAudioOutput: false,
};
// Le juge de fin de tour tourne pour tous les restaurants : ici sans verdict, le `turnComplete` du modèle décide
// (le juge a ses propres tests, turn-end-judge-runtime.test.ts).
vi.mock('../stream/structured-turn/turn-end-judge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stream/structured-turn/turn-end-judge')>()),
  startTurnEndJudge: vi.fn(async () => null),
}));
// Tour ElevenLabs simulé par le contexte Cartesia ci-dessous : la vraie socket n'est jamais ouverte.
vi.mock('../stream/elevenlabs-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stream/elevenlabs-context')>()),
  createElevenLabsContextTurn: vi.fn(() => null),
}));
vi.mock('../stream/cartesia-context', () => ({
  createCartesiaContextTurn: vi.fn(() => (cartesiaContext.enabled ? contextTurn : null)),
}));
vi.mock('../../../shared/telnyx/http-agent', () => ({
  telnyxFetch: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
// Sans empreinte bancaire par défaut ; un test fixe des termes pour la voie avec empreinte.
vi.mock('../card-guarantee-facts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../card-guarantee-facts')>()),
  voiceCardGuaranteeTerms: vi.fn(async () => null),
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

// Sessions des tests : closes après chaque test, sinon une relance armée en temps réel (tour jugé
// inachevé, 2 s) se déclenche pendant un test suivant quand la suite est lente et parle à sa place.
const fixtureSessions: CallSession[] = [];

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
  fixtureSessions.push(session);
  const outputs: StructuredTurnOutput[] = [];
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
        format: {
          json_schema?: { name?: string; schema?: { properties?: Record<string, unknown> } };
        },
        options: { onDelta: (delta: string) => void },
      ) => {
        const next = outputs.shift();
        if (!next) throw new Error('no scripted model output');
        const generated =
          format.json_schema?.name === 'voice_action_reply'
            ? Object.fromEntries(
                Object.keys(format.json_schema.schema?.properties ?? {}).map((key) => [
                  key,
                  next[key as keyof StructuredTurnOutput],
                ]),
              )
            : next;
        const json = JSON.stringify(generated);
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
  return { session, mgr, outputs };
}

function spoken(): string[] {
  return vi.mocked(speakTtsStreamed).mock.calls.map(([, text]) => String(text));
}

beforeEach(() => {
  __resetMetrics();
  vi.clearAllMocks();
  return () => {
    for (const session of fixtureSessions.splice(0)) session.ended = true;
    cartesiaContext.enabled = false;
    vi.unstubAllEnvs();
  };
});

describe('tour structuré (canary)', () => {
  it('répond à une question posée en pleine réservation (appel 02fd0726, tour 4)', async () => {
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft: { date: TOMORROW, time: '', partySize: 4, customerName: '' },
      lastAwaiting: 'time',
    };
    outputs.push(
      turn({
        interpretation: 'question',
        draft: { date: TOMORROW, time: '', partySize: 4, customerName: '' },
        awaiting: 'time',
        say: 'Nous ouvrons de 19 h à 23 h. Vers quelle heure voulez-vous venir ?',
      }),
    );

    await processTranscriptStreaming(session, 'en fait vous êtes ouvert quelle heure plutôt', mgr);

    expect(spoken()).toEqual([
      'Nous ouvrons de 19 h à 23 h.',
      'Vers quelle heure voulez-vous venir ?',
    ]);
    expect(session.conversation.pendingQuestion).toBe('time');
  });

  it('termine poliment quand l’appelant renonce (appel e3e67025, tour 12)', async () => {
    vi.useFakeTimers();
    const { session, mgr, outputs } = fixture();
    outputs.push(
      turn({
        interpretation: 'end_call',
        action: 'end_call',
        say: 'Très bien, je n’enregistre rien. Bonne soirée.',
      }),
    );

    const pending = processTranscriptStreaming(session, 'non non non je préfère rien faire', mgr);
    await vi.advanceTimersByTimeAsync(16_000);
    await pending;
    vi.useRealTimers();

    expect(spoken()).toEqual(['Très bien, je n’enregistre rien. Bonne soirée.']);
    expect(mgr.cleanup).toHaveBeenCalledWith(session);
  });

  it('vérifie la disponibilité réelle puis laisse le modèle formuler le résultat', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({ draft, awaiting: 'customerName', say: '20 h est libre. À quel nom ?' }),
    );

    await processTranscriptStreaming(session, 'demain 20 h pour quatre', mgr);

    expect(mgr.getAvailability).toHaveBeenCalledWith(session, TOMORROW, 4);
    expect(session.structuredTurn?.availability?.slots).toContain('20:00');
    expect(spoken()).toEqual(['20 h est libre.', 'À quel nom ?']);
  });

  it('réduit seulement la réponse après disponibilité et conserve le brouillon vérifié', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({
        draft: { ...draft, time: '23:00', partySize: 9 },
        awaiting: 'customerName',
        say: 'À quel nom ?',
      }),
    );
    await processTranscriptStreaming(session, 'demain à vingt heures pour quatre', mgr);
    const requests = vi.mocked(mgr.streamStructuredCompletion).mock.calls;
    expect(requests[0][2]).toMatchObject({ json_schema: { name: 'voice_turn' } });
    expect(requests[1][2]).toMatchObject({ json_schema: { name: 'voice_action_reply' } });
    const format = requests[1][2] as {
      json_schema: { schema: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(format.json_schema.schema.properties)).toEqual([
      'awaiting',
      'action',
      'confidence',
      'say',
    ]);
    expect(session.structuredTurn?.draft).toEqual(draft);
    expect(mgr.getAvailability).toHaveBeenCalledWith(session, TOMORROW, 4);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
  });

  it('rejette une seconde action sans la rejouer ni annoncer sa fausse réussite', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({ draft, action: 'create_reservation', say: 'Votre réservation est confirmée.' }),
    );
    await processTranscriptStreaming(session, 'demain vingt heures pour quatre', mgr);
    expect(mgr.getAvailability).toHaveBeenCalledTimes(1);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    expect(spoken().join(' ')).not.toContain('Votre réservation est confirmée');
  });

  it('ne prononce rien du résultat compact si son préfixe contient un brouillon injecté', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(turn({ draft, action: 'check_availability' }));
    const stream = vi.mocked(mgr.streamStructuredCompletion);
    const scripted = stream.getMockImplementation()!;
    stream.mockImplementationOnce(scripted).mockImplementationOnce(async (_s, _m, _f, options) => {
      const raw = JSON.stringify({
        awaiting: 'none',
        action: 'none',
        confidence: 'high',
        draft: { ...draft, time: '23:00' },
        say: 'Réservation confirmée à vingt-trois heures. Suite.',
      });
      options.onDelta(raw);
      return raw;
    });
    await processTranscriptStreaming(session, 'demain vingt heures pour quatre', mgr);
    expect(spoken().join(' ')).not.toContain('vingt-trois');
    expect(session.structuredTurn?.draft).toEqual(draft);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
  });

  it('conserve le contrôle des lettres sur une relecture après disponibilité', async () => {
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = { ...createStructuredTurnState(), lastAwaiting: 'customerName' };
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: 'ASSAM' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({ draft, awaiting: 'customerNameConfirmation', say: 'Assam, est-ce bien cela ?' }),
    );
    await processTranscriptStreaming(session, 'A S S A M', mgr);
    expect(vi.mocked(mgr.streamStructuredCompletion).mock.calls[1][2]).toMatchObject({
      json_schema: { name: 'voice_action_reply' },
    });
    expect(spoken().join(' ')).not.toContain('Assam,');
    expect(spoken().join(' ')).toContain('A, S, S, A, M');
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
  });

  it('ne raccroche pas sur un congé incertain après une opération', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({ draft, action: 'end_call', confidence: 'low', say: 'Souhaitez-vous continuer ?' }),
    );
    await processTranscriptStreaming(session, 'demain vingt heures pour quatre', mgr);
    expect(mgr.cleanup).not.toHaveBeenCalled();
    expect(spoken()).toContain('Souhaitez-vous continuer ?');
  });

  it('en démonstration, le transfert devient un fait : le modèle parle, aucune réplique codée', async () => {
    const { session, mgr, outputs } = fixture();
    session.demo = true;
    vi.mocked(mgr.handoffToManager).mockResolvedValueOnce(
      'Le transfert vers le gérant est impossible pour le moment : propose de prendre un message pour lui.',
    );
    const draft = { date: TOMORROW, time: '20:00', partySize: 9, customerName: '' };
    outputs.push(
      turn({ draft, action: 'transfer', say: 'Pour neuf personnes, je passe par le gérant.' }),
      turn({ draft, awaiting: 'open', say: 'Je peux lui laisser un message, si vous voulez.' }),
    );

    await processTranscriptStreaming(session, 'oui passez le gérant', mgr);

    expect(mgr.handoffToManager).toHaveBeenCalledTimes(1);
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    expect(spoken().join(' ')).toContain('laisser un message');
    expect(spoken().join(' ')).not.toContain('impossible');
  });

  it('question déjà dite en flux : aucun second passage ne la répète (appel b54c75da)', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 2, customerName: '' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      lastAwaiting: 'partySize',
      availability: { date: TOMORROW, partySize: 2, slots: ['19:30', '20:00'] },
    };
    outputs.push(turn({ draft, awaiting: 'time', say: 'À quelle heure vous conviendrait-il ?' }));

    await processTranscriptStreaming(session, 'oui', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(spoken()).toEqual(['À quelle heure vous conviendrait-il ?']);
  });

  it('pas de second passage quand la question attendue a reçu sa réponse', async () => {
    const { session, mgr, outputs } = fixture();
    session.history.push({
      role: 'assistant',
      content: 'Pour combien de personnes souhaitez-vous réserver ?',
    });
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft: { date: TOMORROW, time: '', partySize: 0, customerName: '' },
      lastAwaiting: 'partySize',
    };
    outputs.push(
      turn({
        draft: { date: TOMORROW, time: '', partySize: 2, customerName: '' },
        awaiting: 'time',
        say: 'Pour deux, à quelle heure ?',
      }),
    );

    await processTranscriptStreaming(session, 'nous serons deux', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
  });

  it('annonce un jour fermé par une phrase fixe, sans second appel au modèle (appels a8012c5c, 0d49230d)', async () => {
    const { session, mgr, outputs } = fixture();
    vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
      restaurantId: RESTAURANT_ID,
      date: '2026-09-27',
      partySize: 7,
      slots: [],
      allSlots: [],
    });
    const draft = { date: TOMORROW, time: '14:00', partySize: 7, customerName: '' };
    outputs.push(turn({ draft, action: 'check_availability' }));

    await processTranscriptStreaming(session, 'non 7 pardon', mgr);

    expect(spoken().join(' ')).toMatch(
      /^Nous sommes fermés \S+ \d+ \S+\. Voulez-vous venir un autre jour \?$/,
    );
    expect(session.history.at(-1)?.content).toContain('fermés');
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(session.structuredTurn?.lastAwaiting).toBe('date');
  });

  it('dit « complet » plutôt que « pas compris » quand le jour ouvert est plein', async () => {
    const { session, mgr, outputs } = fixture();
    vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
      restaurantId: RESTAURANT_ID,
      date: '2026-09-26',
      partySize: 7,
      slots: [],
      allSlots: [{ time: '20:00', available: false }],
    });
    const draft = { date: TOMORROW, time: '20:00', partySize: 7, customerName: '' };
    outputs.push(turn({ draft, action: 'check_availability' }), turn({ draft, say: '' }));

    await processTranscriptStreaming(session, 'on sera sept', mgr);

    expect(spoken().join(' ')).toMatch(/^Je n'ai plus de table \S+ \d+ \S+ pour 7 personnes\./);
    expect(spoken().join(' ')).not.toContain('pas bien saisi');
  });

  it('ne dit pas « complet ce jour-là » quand aucune table n’accueille ce nombre : groupe, sans autre jour (appel 03b19223)', async () => {
    const { session, mgr, outputs } = fixture();
    vi.mocked(mgr.getTableRanges).mockResolvedValue([
      { capacity: 2, minCapacity: 1 },
      { capacity: 4, minCapacity: 1 },
      { capacity: 6, minCapacity: 2 },
    ]);
    vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
      restaurantId: RESTAURANT_ID,
      date: TOMORROW,
      partySize: 7,
      slots: [],
      allSlots: [{ time: '20:00', available: false }],
    });
    const draft = { date: TOMORROW, time: '20:00', partySize: 7, customerName: '' };
    outputs.push(
      turn({ draft, action: 'check_availability' }),
      turn({
        draft,
        awaiting: 'humanFallback',
        say: 'Aucune de nos tables n’accueille 7 personnes. Je peux vous passer le gérant ou prendre un message ?',
      }),
    );

    await processTranscriptStreaming(session, 'on sera sept', mgr);

    // Pas la phrase fixe du jour complet : le second passage reçoit le fait « aucune table ».
    expect(spoken().join(' ')).not.toMatch(/^Je n'ai plus de table/);
    expect(spoken().join(' ')).toContain('gérant');
    const secondContext = (
      vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[1] as Array<{ content: string }>
    )[0].content;
    expect(secondContext).toContain(
      'aucune table qui accueille 7 personnes, quel que soit le jour',
    );
    expect(secondContext).toContain('Ne propose ni autre jour');
  });

  it('garde la phrase du jour complet quand une table accueille ce nombre', async () => {
    const { session, mgr, outputs } = fixture();
    vi.mocked(mgr.getTableRanges).mockResolvedValue([{ capacity: 8, minCapacity: 1 }]);
    vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
      restaurantId: RESTAURANT_ID,
      date: TOMORROW,
      partySize: 7,
      slots: [],
      allSlots: [{ time: '20:00', available: false }],
    });
    const draft = { date: TOMORROW, time: '20:00', partySize: 7, customerName: '' };
    outputs.push(turn({ draft, action: 'check_availability' }), turn({ draft, say: '' }));

    await processTranscriptStreaming(session, 'on sera sept', mgr);

    expect(spoken().join(' ')).toMatch(/^Je n'ai plus de table \S+ \d+ \S+ pour 7 personnes\./);
  });

  describe('réponse douteuse qui porte un nombre alors que la taille du groupe est connue (appel 90834d63)', () => {
    const known = { date: TOMORROW, time: '14:30', partySize: 4, customerName: '' };
    // Ordre des clés du schéma réel : `understanding` précède le brouillon et `say`.
    const doubtful = (say: string, awaiting: StructuredTurnOutput['awaiting'] = 'customerName') =>
      ({
        turnComplete: true,
        reading: 'un non 5',
        understanding: 'doubtful',
        interpretation: 'unclear',
        draft: known,
        awaiting,
        action: 'none',
        message: '',
        confidence: 'low',
        say,
      }) as StructuredTurnOutput;
    const NAME_QUESTION = 'Pardon, je n’ai pas bien saisi. Sous quel nom je note la réservation ?';
    const setup = (
      draft = known,
      lastAwaiting: StructuredTurnOutput['awaiting'] = 'customerName',
    ) => {
      const fx = fixture();
      fx.session.structuredTurn = { ...createStructuredTurnState(), draft, lastAwaiting };
      return fx;
    };

    it('ne passe pas à la question suivante : le second passage reçoit le nombre à redemander', async () => {
      const { session, mgr, outputs } = setup();
      outputs.push(
        doubtful(NAME_QUESTION),
        doubtful('Vous avez dit cinq personnes ?', 'partySize'),
      );

      await processTranscriptStreaming(session, 'un non 5', mgr);

      expect(spoken()).toEqual(['Vous avez dit cinq personnes ?']);
      const secondContext = (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[1] as Array<{
          content: string;
        }>
      )[0].content;
      expect(secondContext).toContain('un non 5');
      expect(secondContext).toContain('4 personnes');
      expect(session.structuredTurn?.draft.partySize).toBe(4);
    });

    it('le cas du banc « second passage » porte exactement le fait produit par le moteur', () => {
      const cases = JSON.parse(
        readFileSync(
          path.join(__dirname, '../../../../scripts/fixtures/voice-behavior/cases.json'),
          'utf8',
        ),
      ) as { cases: Array<{ id: string; actionResult?: string }> };
      const second = cases.cases.find((c) => c.id === 'correction-nombre-douteuse-second-passage');
      const streamed = JSON.stringify({
        understanding: 'doubtful',
        draft: known,
        awaiting: 'customerName',
      });
      expect(second?.actionResult).toBe(partySizeCorrectionFact(streamed, 'un non 5', known));
    });

    it.each([
      ['aucun nombre dans l’énoncé', 'euh pardon', known, 'customerName', 'customerName'],
      ['le nombre est celui déjà noté', 'oui 4', known, 'customerName', 'customerName'],
      [
        'taille du groupe inconnue',
        'un non 5',
        { ...known, partySize: 0 },
        'customerName',
        'customerName',
      ],
      ['on attendait le nombre', 'un non 5', known, 'partySize', 'partySize'],
    ] as const)(
      'ne change rien : %s',
      async (_label, transcript, draft, lastAwaiting, awaiting) => {
        const { session, mgr, outputs } = setup(draft, lastAwaiting);
        outputs.push({ ...doubtful(NAME_QUESTION, awaiting), draft });

        await processTranscriptStreaming(session, transcript, mgr);

        expect(spoken().join(' ')).toBe(NAME_QUESTION);
        expect(vi.mocked(mgr.streamStructuredCompletion)).toHaveBeenCalledTimes(1);
      },
    );

    it('ne change rien quand le modèle a compris (understanding=clear)', async () => {
      const { session, mgr, outputs } = setup();
      outputs.push({
        ...doubtful('C’est noté. Sous quel nom ?'),
        understanding: 'clear',
        interpretation: 'answer',
        confidence: 'high',
      });

      await processTranscriptStreaming(session, 'ah non 5', mgr);

      expect(spoken().join(' ')).toBe('C’est noté. Sous quel nom ?');
      expect(vi.mocked(mgr.streamStructuredCompletion)).toHaveBeenCalledTimes(1);
    });
  });

  describe('heure donnée sans nombre de personnes : seule la question est dite (appel 03b19223)', () => {
    const dated = { date: TOMORROW, time: '', partySize: 0, customerName: '' };
    const timed = { ...dated, time: '20:00' };
    const asked = (overrides: Partial<StructuredTurnOutput>) => {
      const fx = fixture();
      fx.session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: dated,
        lastAwaiting: 'time',
      };
      fx.outputs.push(turn({ draft: timed, awaiting: 'partySize', ...overrides }));
      return fx;
    };

    it('retient la phrase qui accepte ou répète l’heure et garde la question, dans l’historique aussi', async () => {
      const { session, mgr } = asked({ say: 'Samedi à 20 heures, ça marche. Vous êtes combien ?' });

      await processTranscriptStreaming(session, 'pour 20 heures', mgr);

      expect(spoken()).toEqual(['Vous êtes combien ?']);
      expect(session.history.at(-1)).toEqual({ role: 'assistant', content: 'Vous êtes combien ?' });
    });

    it('journalise chaque phrase retirée, avec son texte, pour le restaurant de test', async () => {
      vi.stubEnv('VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS', RESTAURANT_ID);
      const { session, mgr } = asked({
        say: 'C’est possible. Samedi à 20 heures. Pour combien de personnes ?',
      });

      await processTranscriptStreaming(session, 'pour 20 heures', mgr);

      const dropped = vi
        .mocked(logger.info)
        .mock.calls.map(([fields]) => fields as Record<string, unknown>)
        .filter((fields) => fields.voiceDebug === 'phrase_dropped');
      expect(dropped.map((fields) => fields.text)).toEqual([
        'C’est possible.',
        'Samedi à 20 heures.',
      ]);
      expect(dropped.every((fields) => fields.reason === 'time_given_without_party_size')).toBe(
        true,
      );
    });

    it('ne journalise rien hors restaurant de test (le texte reste privé)', async () => {
      const { session, mgr } = asked({ say: 'Ça marche. Pour combien de personnes ?' });
      await processTranscriptStreaming(session, 'pour 20 heures', mgr);
      const dropped = vi
        .mocked(logger.info)
        .mock.calls.filter(
          ([fields]) => (fields as { voiceDebug?: string }).voiceDebug === 'phrase_dropped',
        );
      expect(dropped).toHaveLength(0);
    });

    it('retient plusieurs phrases déclaratives avant la question', async () => {
      const { session, mgr } = asked({
        say: 'C’est possible. Samedi à 20 heures. Pour combien de personnes ?',
      });
      await processTranscriptStreaming(session, 'pour 20 heures', mgr);
      expect(spoken()).toEqual(['Pour combien de personnes ?']);
    });

    it('dit la phrase telle quelle quand elle ne contient aucune question (jamais de silence)', async () => {
      const { session, mgr } = asked({ say: 'Très bien, 20 heures.' });
      await processTranscriptStreaming(session, 'pour 20 heures', mgr);
      expect(spoken()).toEqual(['Très bien, 20 heures.']);
    });

    it('ne touche pas la réponse à une question de l’appelant', async () => {
      const { session, mgr } = asked({
        interpretation: 'question',
        say: 'Oui, nous ouvrons à midi. Vous serez combien ?',
      });
      await processTranscriptStreaming(session, 'vous ouvrez à quelle heure', mgr);
      expect(spoken()).toEqual(['Oui, nous ouvrons à midi.', 'Vous serez combien ?']);
    });

    it('ne touche pas un tour où l’heure ne change pas, ni celui où le nombre est connu', async () => {
      const unchanged = fixture();
      unchanged.session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: timed,
        lastAwaiting: 'partySize',
      };
      unchanged.outputs.push(
        turn({
          draft: timed,
          awaiting: 'partySize',
          say: 'Je n’ai pas compris. Vous êtes combien ?',
        }),
      );
      await processTranscriptStreaming(unchanged.session, 'euh', unchanged.mgr);
      expect(spoken()).toEqual(['Je n’ai pas compris.', 'Vous êtes combien ?']);

      vi.mocked(speakTtsStreamed).mockClear();
      const known = fixture();
      known.session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: dated,
        lastAwaiting: 'time',
      };
      const withParty = { ...timed, partySize: 4 };
      known.outputs.push(
        turn({
          draft: withParty,
          awaiting: 'customerName',
          say: 'Pour quatre à 20 heures. À quel nom ?',
        }),
      );
      known.session.structuredTurn.availability = {
        date: TOMORROW,
        partySize: 4,
        slots: ['20:00'],
      };
      await processTranscriptStreaming(known.session, 'pour 20 heures, on sera quatre', known.mgr);
      expect(spoken()).toEqual(['Pour quatre à 20 heures.', 'À quel nom ?']);
    });
  });

  it('répond en un seul passage avec les créneaux du jour lus d’avance', async () => {
    const { session, mgr, outputs } = fixture();
    const dated = { date: TOMORROW, time: '', partySize: 0, customerName: '' };
    outputs.push(turn({ draft: dated, awaiting: 'time', say: 'Vers quelle heure ?' }));
    await processTranscriptStreaming(session, 'une table pour demain', mgr);
    // La lecture du jour part à la fin du tour, sans le ralentir.
    await vi.waitFor(() => expect(session.structuredTurn?.dayAvailability?.date).toBe(TOMORROW));
    expect(mgr.getAvailability).toHaveBeenCalledWith(session, TOMORROW, 1);

    vi.mocked(mgr.getAvailability).mockClear();
    const complete = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ draft: complete, awaiting: 'customerName', say: '20 h est libre. À quel nom ?' }),
    );
    await processTranscriptStreaming(session, '20 heures pour quatre', mgr);

    // Un seul appel au modèle, et le créneau est vérifié pour la réservation.
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    const context = (
      vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[1] as Array<{ content: string }>
    )[0].content;
    expect(context).toContain('"freeSlotsByPartySize"');
    expect(context).toContain('19:00→20:00');
    expect(session.structuredTurn?.availability).toEqual({
      date: TOMORROW,
      partySize: 4,
      slots: ['19:00', '19:30', '20:00'],
    });
    expect(spoken()).toContain('À quel nom ?');
  });

  describe('heure hors horaires du jour (profil ouvert le midi seulement)', () => {
    const LUNCH_ONLY = {
      tue: { open: '12:00', close: '14:30' },
      wed: { open: '12:00', close: '14:30' },
      sat: { open: '12:00', close: '23:00' },
    };
    // Prochain mardi à partir de demain : jour ouvert 12 h–14 h 30 dans ce profil.
    const NEXT_TUESDAY = (() => {
      const date = new Date(`${TOMORROW}T00:00:00.000Z`);
      while (date.getUTCDay() !== 2) date.setUTCDate(date.getUTCDate() + 1);
      return date.toISOString().slice(0, 10);
    })();
    const draftAt = (time: string) => ({
      date: NEXT_TUESDAY,
      time,
      partySize: 0,
      customerName: '',
    });
    const secondPassContext = (mgr: CallSessionManager) =>
      (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{ content: string }>
      )[0].content;

    it('ne laisse pas accepter « mardi à 20 heures » : silence, fait réel donné au second passage', async () => {
      const { session, mgr, outputs } = fixture();
      (session as { openingHours?: unknown }).openingHours = LUNCH_ONLY;
      outputs.push(
        turn({
          draft: draftAt('20:00'),
          awaiting: 'partySize',
          say: 'Mardi soir, ça tombe bien. Vous serez combien ?',
        }),
        turn({
          draft: draftAt(''),
          awaiting: 'time',
          say: 'Le mardi, nous fermons à 14 h 30. Quelle heure vous conviendrait ?',
        }),
      );

      await processTranscriptStreaming(session, 'mardi à 20 heures', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(secondPassContext(mgr)).toContain('en dehors des horaires du mardi (12:00–14:30)');
      expect(spoken().join(' ')).not.toContain('tombe bien');
      expect(spoken().join(' ')).toContain('14 h 30');
    });

    it("laisse parler normalement quand l'heure est dans le service", async () => {
      const { session, mgr, outputs } = fixture();
      (session as { openingHours?: unknown }).openingHours = LUNCH_ONLY;
      outputs.push(
        turn({
          draft: draftAt('13:00'),
          awaiting: 'partySize',
          say: 'Mardi à 13 heures. Vous serez combien ?',
        }),
      );

      await processTranscriptStreaming(session, 'mardi à 13 heures', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken()).toContain('Vous serez combien ?');
    });
  });

  describe('nom épelé suivi d’un mot que l’appelant n’a pas épelé', () => {
    const named = (customerName: string) => ({
      date: TOMORROW,
      time: '19:00',
      partySize: 4,
      customerName,
    });
    const secondPassContext = (mgr: CallSessionManager) =>
      (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{ content: string }>
      )[0].content;
    const askingName = () => {
      const fx = fixture();
      const state = createStructuredTurnState();
      state.draft = { ...named(''), customerName: '' };
      state.lastAwaiting = 'customerName';
      fx.session.structuredTurn = state;
      return fx;
    };

    it('se tait, retient le bon nom et laisse le modèle relire les lettres épelées', async () => {
      const { session, mgr, outputs } = askingName();
      outputs.push(
        turn({
          draft: named('HOUET DIMANCHE'),
          awaiting: 'customerNameConfirmation',
          say: 'Je répète : HOUET DIMANCHE, c’est bien ça ?',
        }),
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'h o u e t dimanche', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(secondPassContext(mgr)).toContain('customerName = « HOUET »');
      expect(spoken().join(' ')).not.toContain('DIMANCHE');
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('se tait aussi quand le modèle écrit un autre nom que les lettres épelées, sans mot collé', async () => {
      const { session, mgr, outputs } = askingName();
      outputs.push(
        turn({
          draft: named('Hoët'),
          awaiting: 'customerNameConfirmation',
          say: 'Je répète : Hoët, c’est bien ça ?',
        }),
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'hoët h o u e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(secondPassContext(mgr)).toContain('customerName = « Houet »');
      expect(spoken().join(' ')).not.toContain('Hoët');
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('ne dit jamais une relecture sans la lettre épelée quand la seconde passe garde le mot reconnu (appel 8f254faa)', async () => {
      const { session, mgr, outputs } = askingName();
      outputs.push(
        turn({
          draft: named('HOËT'),
          awaiting: 'customerNameConfirmation',
          say: 'Je relis : H, O, U, E, T. C’est bien ça ?',
        }),
        turn({
          draft: named('HOËT'),
          awaiting: 'customerNameConfirmation',
          say: 'Je relis : H, O, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'c’est au nom de hoët h o u e t', mgr);

      expect(spoken().join(' ')).not.toContain('H, O, E, T');
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('vérifie la relecture contre le nom retenu quand la seconde passe renvoie un brouillon sans nom (appel 8f254faa)', async () => {
      const { session, mgr, outputs } = askingName();
      outputs.push(
        turn({
          draft: named('HOËT'),
          awaiting: 'customerNameConfirmation',
          say: 'Je relis : H, O, U, E, T. C’est bien ça ?',
        }),
        turn({
          draft: named(''),
          awaiting: 'customerNameConfirmation',
          say: 'Je relis : H, O, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'c’est au nom de hoët h o u e t', mgr);

      expect(spoken().join(' ')).not.toContain('H, O, E, T');
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it.each(['open', 'customerName'] as const)(
      'vérifie aussi la relecture de la seconde passe qui déclare awaiting=%s',
      async (awaiting) => {
        const { session, mgr, outputs } = askingName();
        outputs.push(
          turn({
            draft: named('HOËT'),
            awaiting: 'customerNameConfirmation',
            say: 'Je relis : H, O, U, E, T. C’est bien ça ?',
          }),
          turn({
            draft: named('HOUET'),
            awaiting,
            say: 'Je relis : H, O, E, T. C’est bien ça ?',
          }),
        );

        await processTranscriptStreaming(session, 'c’est au nom de hoët h o u e t', mgr);

        expect(spoken().join(' ')).not.toContain('H, O, E, T');
        expect(spoken().join(' ')).toContain('H, O, U, E, T');
      },
    );

    it('ne change rien quand le nom relu est exactement ce qui a été épelé', async () => {
      const { session, mgr, outputs } = askingName();
      outputs.push(
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'h o u e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
    });

    it('ne se déclenche pas hors d’une épellation attendue', async () => {
      const { session, mgr, outputs } = fixture();
      outputs.push(
        turn({ draft: named('Jean Dupont'), awaiting: 'confirmation', say: 'Jean Dupont, ok ?' }),
      );

      await processTranscriptStreaming(session, 'jean dupont', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    });
  });

  describe('congé après la réservation : court et douteux on raccroche, long et douteux non', () => {
    const LONG = 'vous aviez dit la rue de la panne pour un tour ce ouais merci à la tasse'; // 15 mots
    const goodbye = (extra: Partial<StructuredTurnOutput> = {}) =>
      turn({
        interpretation: 'end_call',
        action: 'end_call',
        awaiting: 'none',
        say: 'Avec plaisir, bonne soirée.',
        ...extra,
      });
    const hungUp = async (
      transcript: string,
      first: StructuredTurnOutput,
      options: {
        reservationCreated?: boolean;
        lastAwaiting?: StructuredTurnOutput['awaiting'];
        second?: StructuredTurnOutput;
      } = {},
    ) => {
      vi.useFakeTimers();
      const fx = fixture();
      const state = createStructuredTurnState();
      state.reservationCreated = options.reservationCreated ?? true;
      state.lastAwaiting = options.lastAwaiting ?? 'none';
      fx.session.structuredTurn = state;
      fx.outputs.push(first);
      if (options.second) fx.outputs.push(options.second);
      const pending = processTranscriptStreaming(fx.session, transcript, fx.mgr);
      await vi.advanceTimersByTimeAsync(16_000);
      await pending;
      vi.useRealTimers();
      return fx;
    };

    it('raccroche sur un énoncé court que le modèle n’a pas compris (« Bisous » transcrit autrement)', async () => {
      const { mgr } = await hungUp(
        'dix nous',
        goodbye({ understanding: 'doubtful', interpretation: 'unclear' }),
      );
      expect(mgr.cleanup).toHaveBeenCalled();
      expect(spoken()).toEqual(['Avec plaisir, bonne soirée.']);
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    });

    it('ne raccroche pas sur une longue phrase jugée douteuse : le modèle redemande avec un fait', async () => {
      const { mgr, outputs } = await hungUp(
        LONG,
        goodbye({ understanding: 'doubtful', interpretation: 'unclear' }),
        {
          second: turn({
            awaiting: 'open',
            say: 'Je n’ai pas bien compris, pouvez-vous répéter ?',
          }),
        },
      );

      expect(outputs).toHaveLength(0);
      expect(mgr.cleanup).not.toHaveBeenCalled();
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      const context = (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{ content: string }>
      )[0].content;
      expect(context).toContain('non exécutée');
      expect(context).toContain('ne prends pas congé');
      // Le second passage ne peut plus choisir de raccrocher : le schéma n'autorise que « none ».
      const secondFormat = vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[2] as {
        json_schema: { schema: { properties: { action: { enum: string[] } } } };
      };
      expect(secondFormat.json_schema.schema.properties.action.enum).toEqual(['none']);
      expect(spoken().join(' ')).toBe('Je n’ai pas bien compris, pouvez-vous répéter ?');
      expect(spoken().join(' ')).not.toContain('bonne soirée');
    });

    it('même critère sans vérification de compréhension (interprétation « unclear »)', async () => {
      const { mgr } = await hungUp(LONG, goodbye({ interpretation: 'unclear' }), {
        second: turn({ awaiting: 'open', say: 'Pardon, pouvez-vous répéter ?' }),
      });
      expect(mgr.cleanup).not.toHaveBeenCalled();
      expect(spoken().join(' ')).toBe('Pardon, pouvez-vous répéter ?');
    });

    it('sans réservation créée, un court au revoir douteux ne ferme rien', async () => {
      const { mgr } = await hungUp(
        'dix nous',
        goodbye({ understanding: 'doubtful', interpretation: 'unclear' }),
        {
          reservationCreated: false,
          second: turn({ awaiting: 'open', say: 'Pardon, vous voulez quoi ?' }),
        },
      );
      expect(mgr.cleanup).not.toHaveBeenCalled();
    });

    it('après « Autre chose ? », un court énoncé douteux ne ferme rien : c’est peut-être une vraie question', async () => {
      const { mgr } = await hungUp(
        'ses ou le parking',
        goodbye({ understanding: 'doubtful', interpretation: 'unclear' }),
        {
          lastAwaiting: 'open',
          second: turn({ awaiting: 'open', say: 'Pardon, vous demandiez quoi ?' }),
        },
      );
      expect(mgr.cleanup).not.toHaveBeenCalled();
      expect(spoken().join(' ')).toBe('Pardon, vous demandiez quoi ?');
    });

    it('raccroche sur un long au revoir que le modèle a bien compris', async () => {
      const { mgr } = await hungUp(
        'merci beaucoup pour tout au revoir et bonne soirée à vous aussi',
        goodbye({ understanding: 'clear' }),
      );
      expect(mgr.cleanup).toHaveBeenCalled();
    });
  });

  describe('relance formulée par le modèle (generateRecoveryReply)', () => {
    const asking = () => {
      const fx = fixture();
      fx.session.history = [
        { role: 'user', content: 'demain' },
        { role: 'assistant', content: 'Vers quelle heure vous aimeriez venir ?' },
      ];
      return fx;
    };
    const requestOf = (mgr: CallSessionManager) =>
      vi.mocked(mgr.streamStructuredCompletion).mock.calls[0]?.[1] as Array<{
        role: string;
        content: string;
      }>;

    it('rend la phrase du modèle, après une requête sans énoncé et avec le type de relance', async () => {
      const { session, mgr, outputs } = asking();
      outputs.push(turn({ awaiting: 'time', say: 'Désolé, vous disiez ? Vers quelle heure ?' }));

      const reply = await generateRecoveryReply(session, mgr, 'unheard');

      expect(reply).toBe('Désolé, vous disiez ? Vers quelle heure ?');
      const messages = requestOf(mgr);
      expect(messages[0].content).toContain('RELANCE :');
      expect(messages[0].content).toContain('aucun mot n’a pu être reconnu'.replace('’', "'"));
      expect(messages.at(-1)).toEqual({ role: 'user', content: '(aucune parole reconnue)' });
      // L'historique réel n'est ni complété ni modifié par la relance.
      expect(session.history).toHaveLength(2);
    });

    it('adoucit les points d’exclamation, comme pour un tour', async () => {
      const { session, mgr, outputs } = asking();
      outputs.push(turn({ say: 'Vous êtes toujours là !' }));
      expect(await generateRecoveryReply(session, mgr, 'silence')).toBe('Vous êtes toujours là.');
    });

    it.each([
      ['une action demandée', turn({ action: 'check_availability', say: 'Je vérifie.' })],
      ['une phrase vide', turn({ say: '   ' })],
    ])('rend null pour %s : l’appelant garde sa phrase de secours', async (_label, output) => {
      const { session, mgr, outputs } = asking();
      outputs.push(output);
      expect(await generateRecoveryReply(session, mgr, 'silence')).toBeNull();
    });

    it('rend null sans appeler le modèle quand le gestionnaire n’y donne pas accès', async () => {
      const { session } = asking();
      expect(await generateRecoveryReply(session, {}, 'silence')).toBeNull();
    });
  });

  describe('quelques lettres après la relecture du nom (appel 6a70dff9)', () => {
    const named = (customerName: string) => ({
      date: TOMORROW,
      time: '19:00',
      partySize: 4,
      customerName,
    });
    const secondPassContext = (mgr: CallSessionManager) =>
      (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{ content: string }>
      )[0].content;
    /** L'agent vient de relire « H, O, U, T » (le E de « houet » avait été perdu). */
    const afterReadBack = () => {
      const fx = fixture();
      const state = createStructuredTurnState();
      state.draft = named('HOUT');
      state.lastAwaiting = 'customerNameConfirmation';
      fx.session.structuredTurn = state;
      return fx;
    };

    it('se tait quand le modèle recolle à la suite, aligne les lettres et relit le bon nom', async () => {
      const { session, mgr, outputs } = afterReadBack();
      outputs.push(
        turn({
          draft: named('HOUTET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, T, E, T. C’est bien ça ?',
        }),
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(secondPassContext(mgr)).toContain('customerName = « HOUET »');
      expect(spoken().join(' ')).not.toContain('T, E, T');
      expect(spoken().join(' ')).toContain('H, O, U, E, T');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('aligne aussi quand le modèle doute et ne change rien : le nom lu est le bon', async () => {
      const { session, mgr, outputs } = afterReadBack();
      outputs.push(
        turn({
          draft: named('HOUT'),
          awaiting: 'customerNameConfirmation',
          interpretation: 'unclear',
          understanding: 'doubtful',
          say: 'Pardon, pouvez-vous épeler le nom ?',
        }),
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(spoken().join(' ')).not.toContain('pouvez-vous épeler');
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('ne se déclenche pas quand le modèle a déjà le bon nom', async () => {
      const { session, mgr, outputs } = afterReadBack();
      outputs.push(
        turn({
          draft: named('HOUET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(session.structuredTurn?.draft.customerName).toBe('HOUET');
    });

    it('laisse le modèle quand la phrase n’est pas faite que de lettres', async () => {
      const { session, mgr, outputs } = afterReadBack();
      outputs.push(
        turn({
          draft: named('HOUTET'),
          awaiting: 'customerNameConfirmation',
          say: 'Donc H, O, U, T, E, T. C’est bien ça ?',
        }),
      );

      await processTranscriptStreaming(session, 'non e t', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    });
  });

  describe('créneau exclu par les disponibilités lues (appel 1b3f85e9)', () => {
    const conflicting = { date: TOMORROW, time: '15:30', partySize: 5, customerName: '' };
    const day = (slots: string[]) => ({
      date: TOMORROW,
      closed: false,
      slotsBySize: { 5: slots },
    });
    const secondPassContext = (mgr: CallSessionManager) =>
      (
        vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{ content: string }>
      )[0].content;

    it('ne promet pas le créneau, vérifie pour de bon et laisse le modèle proposer des alternatives', async () => {
      const { session, mgr, outputs } = fixture();
      session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: { ...conflicting, partySize: 0 },
        lastAwaiting: 'partySize',
        dayAvailability: day(['12:00', '18:30', '19:00']),
      };
      vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
        restaurantId: RESTAURANT_ID,
        date: TOMORROW,
        partySize: 5,
        slots: ['12:00', '18:30', '19:00'],
        allSlots: [
          { time: '12:00', available: true },
          { time: '15:30', available: true },
          { time: '18:30', available: true },
          { time: '19:00', available: true },
        ],
      });
      outputs.push(
        turn({
          draft: conflicting,
          awaiting: 'customerName',
          say: 'Pour 5, 15 h 30 est libre. C’est à quel nom ?',
        }),
        turn({
          draft: { ...conflicting, time: '' },
          awaiting: 'time',
          say: '15 h 30 n’est pas disponible pour 5. Je peux vous proposer 18 h 30.',
        }),
      );

      await processTranscriptStreaming(session, '5 5 5', mgr);

      expect(mgr.getAvailability).toHaveBeenCalledWith(session, TOMORROW, 5);
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(secondPassContext(mgr)).toContain("15:30 n'est pas disponible");
      expect(secondPassContext(mgr)).toContain('12:00, 18:30, 19:00');
      expect(spoken().join(' ')).not.toContain('est libre');
      expect(spoken().join(' ')).toContain('18 h 30');
    });

    it('laisse parler normalement quand le créneau est libre', async () => {
      const { session, mgr, outputs } = fixture();
      session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: { ...conflicting, partySize: 0 },
        lastAwaiting: 'partySize',
        dayAvailability: day(['12:00', '15:30', '19:00']),
      };
      outputs.push(
        turn({
          draft: conflicting,
          awaiting: 'customerName',
          say: 'Pour 5, 15 h 30 est libre. C’est à quel nom ?',
        }),
      );

      await processTranscriptStreaming(session, '5 personnes', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken()).toContain('C’est à quel nom ?');
    });

    it('ne répète pas l’indisponibilité quand l’appelant pose une autre question sans changer le créneau', async () => {
      const { session, mgr, outputs } = fixture();
      session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: conflicting,
        lastAwaiting: 'time',
        dayAvailability: day(['12:00', '18:30']),
      };
      outputs.push(
        turn({
          interpretation: 'question',
          draft: conflicting,
          awaiting: 'time',
          say: 'Oui, nous avons une terrasse.',
        }),
      );

      await processTranscriptStreaming(session, 'et vous avez une terrasse', mgr);

      // Un seul passage du modèle : pas de vérification déclenchée par le créneau resté en conflit.
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken()).toContain('Oui, nous avons une terrasse.');
      expect(spoken().join(' ')).not.toContain('disponible');
    });

    it('donne les faits réels au modèle quand la garde refuse la création (créneau non vérifié)', async () => {
      const { session, mgr, outputs } = fixture();
      session.structuredTurn = {
        ...createStructuredTurnState(),
        draft: { ...conflicting, customerName: 'Akkis' },
        lastAwaiting: 'confirmation',
        recapKey: bookingKey({ ...conflicting, customerName: 'Akkis' }),
        availability: { date: TOMORROW, partySize: 5, slots: ['12:00', '18:30'] },
      };
      vi.mocked(mgr.getAvailability).mockResolvedValueOnce({
        restaurantId: RESTAURANT_ID,
        date: TOMORROW,
        partySize: 5,
        slots: ['12:00', '18:30'],
        allSlots: [
          { time: '12:00', available: true },
          { time: '15:30', available: true },
          { time: '18:30', available: true },
        ],
      });
      const draft = { ...conflicting, customerName: 'Akkis' };
      outputs.push(
        turn({
          interpretation: 'affirmation',
          draft,
          action: 'create_reservation',
          awaiting: 'none',
        }),
        turn({
          draft,
          awaiting: 'time',
          say: '15 h 30 est complet pour 5. Je peux vous proposer 18 h 30.',
        }),
      );

      await processTranscriptStreaming(session, 'oui parfait', mgr);

      expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
      expect(mgr.getAvailability).toHaveBeenCalledWith(session, TOMORROW, 5);
      expect(secondPassContext(mgr)).toContain("15:30 n'est pas disponible");
      expect(spoken().join(' ')).toContain('18 h 30');
    });
  });

  it('ne crée pas la réservation sans récapitulatif accepté', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: 'Akkif' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      availability: { date: draft.date, partySize: 4, slots: ['20:00'] },
      lastAwaiting: 'customerName',
    };
    outputs.push(
      turn({ interpretation: 'answer', draft, action: 'create_reservation' }),
      turn({
        draft,
        awaiting: 'confirmation',
        say: 'Je récapitule : demain 20 h, quatre personnes, au nom de Akkif. C’est bon ?',
      }),
    );

    await processTranscriptStreaming(session, 'Akkif', mgr);

    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    expect(session.structuredTurn?.recapKey).toBe(bookingKey(draft));
  });

  it('envoie le nom à la voix en casse de nom propre, et les lettres relues telles quelles (appel 935ff343)', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '21:00', partySize: 3, customerName: 'HOUET' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      availability: { date: draft.date, partySize: 3, slots: ['21:00'] },
      lastAwaiting: 'customerNameConfirmation',
    };
    outputs.push(
      turn({
        interpretation: 'affirmation',
        draft,
        awaiting: 'confirmation',
        say: 'Je récapitule : une table pour 3 à 21 heures, au nom de HOUET. Je peux réserver ?',
      }),
    );

    await processTranscriptStreaming(session, 'c’est parfait', mgr);

    const voice = spoken().join(' ');
    expect(voice).toContain('au nom de Houet');
    expect(voice).not.toContain('HOUET');
  });

  it('reprend le texte Ink anticipé après une partielle Deepgram différente, sans parler avant le final', async () => {
    const { session, mgr, outputs } = fixture();
    outputs.push(
      turn({ say: 'Ancienne réponse à écarter.' }),
      turn({ say: 'Pour quel jour souhaitez-vous réserver ?', awaiting: 'date' }),
    );
    speculateStructuredTurn(session, mgr, 'je peux arriver');
    speculateStructuredTurn(session, mgr, 'Je voudrais réserver.');
    expect(spoken()).toEqual([]);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    await processTranscriptStreaming(session, 'Je voudrais réserver.', mgr);
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    expect(spoken()).toEqual(['Pour quel jour souhaitez-vous réserver ?']);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
  });

  it('reprend après terrasse et refus de transfert, puis réserve sans relecture forcée (3d6e51c6)', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 3, customerName: 'Test' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      lastAwaiting: 'confirmation',
      recapKey: bookingKey(draft),
      availability: { date: draft.date, partySize: 3, slots: ['20:00'] },
    };
    session.history.push({
      role: 'assistant',
      content: 'Demain à 20 heures, trois personnes, au nom de Test. Je réserve ?',
    });
    outputs.push(
      turn({
        draft,
        interpretation: 'question',
        awaiting: 'humanFallback',
        say: 'Je peux vous passer le gérant pour la terrasse. Vous le souhaitez ?',
      }),
    );
    await processTranscriptStreaming(session, 'Vous avez une terrasse ?', mgr);
    outputs.push(
      turn({
        draft,
        interpretation: 'decline',
        awaiting: 'confirmationResume',
        say: 'D’accord. Je confirme la réservation ?',
      }),
    );
    await processTranscriptStreaming(session, 'Non, pas besoin de transfert.', mgr);
    expect(session.structuredTurn?.resumableRecapKey).toBe(bookingKey(draft));
    expect(session.conversation.pendingQuestion).toBe('confirmation');
    const requests = vi.mocked(mgr.streamStructuredCompletion).mock.calls;
    expect(JSON.stringify(requests.at(-1)?.[1])).toContain('canResumeConfirmation');
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    outputs.push(turn({ draft, interpretation: 'affirmation', action: 'create_reservation' }));
    await processTranscriptStreaming(session, 'Oui.', mgr);
    expect(mgr.createReservationFromConversation).toHaveBeenCalledTimes(1);
    // Une passe par réponse, la confirmation du résultat réel comprise : pas de passe de refus/recap_not_read.
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(3);
    expect(spoken().slice(0, -1).join(' ')).toBe(
      [
        'Je peux vous passer le gérant pour la terrasse. Vous le souhaitez ?',
        'D’accord. Je confirme la réservation ?',
      ].join(' '),
    );
    expect(spoken().at(-1)).toMatch(
      /^Votre réservation est confirmée : \S.* à 20 h, pour 3 personnes\.$/,
    );
    expect(session.structuredTurn?.reservationCreated).toBe(true);
  });

  it('un refus bref du transfert garde le brouillon et bloque un raccrochage proposé à tort', async () => {
    vi.stubEnv('VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS', RESTAURANT_ID);
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 3, customerName: 'Test' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      lastAwaiting: 'humanFallback',
      resumableRecapKey: bookingKey(draft),
      availability: { date: draft.date, partySize: 3, slots: ['20:00'] },
    };
    session.history.push({
      role: 'assistant',
      content: 'Je vous passe le gérant pour la terrasse ?',
    });
    outputs.push(
      turn({
        draft: { ...draft, partySize: 8 },
        action: 'end_call',
        interpretation: 'end_call',
        say: 'Au revoir.',
      }),
      turn({
        draft,
        interpretation: 'decline',
        awaiting: 'confirmationResume',
        say: 'On confirme votre table ?',
      }),
    );
    await processTranscriptStreaming(session, 'Non, pas besoin.', mgr);
    expect(spoken().join(' ')).toBe('On confirme votre table ?');
    expect(session.ended).toBe(false);
    expect(session.structuredTurn?.draft).toEqual(draft);
    expect(session.structuredTurn?.resumableRecapKey).toBe(bookingKey(draft));
    expect(mgr.handoffToManager).not.toHaveBeenCalled();
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    for (const [, messages, format] of vi.mocked(mgr.streamStructuredCompletion).mock.calls) {
      expect(JSON.stringify(messages)).toContain('PORTÉE DE LA RÉPONSE');
      expect(
        (format as { json_schema: { schema: { properties: { action: { enum: string[] } } } } })
          .json_schema.schema.properties.action.enum,
      ).toEqual(['none']);
    }
    outputs.push(
      turn({ draft, interpretation: 'affirmation', action: 'create_reservation' }),
      turn({ draft, say: 'Votre table est réservée.' }),
    );
    await processTranscriptStreaming(session, 'Oui.', mgr);
    expect(mgr.createReservationFromConversation).toHaveBeenCalledTimes(1);
  });

  it('un non au récapitulatif demande ce qui change sans réserver ni terminer', async () => {
    vi.stubEnv('VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS', RESTAURANT_ID);
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 3, customerName: 'Test' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      lastAwaiting: 'confirmation',
      recapKey: bookingKey(draft),
    };
    session.history.push({
      role: 'assistant',
      content: 'Demain à vingt heures pour trois, au nom de Test. Je réserve ?',
    });
    outputs.push(
      turn({
        draft,
        interpretation: 'decline',
        awaiting: 'open',
        say: 'Que souhaitez-vous modifier ?',
      }),
    );
    await processTranscriptStreaming(session, 'Non.', mgr);
    expect(spoken()).toEqual(['Que souhaitez-vous modifier ?']);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
    expect(session.ended).toBe(false);
    expect(session.structuredTurn?.resumableRecapKey).toBeNull();
  });

  it('un abandon explicite après proposition de transfert reste respecté', async () => {
    vi.stubEnv('VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS', RESTAURANT_ID);
    vi.useFakeTimers();
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = { ...createStructuredTurnState(), lastAwaiting: 'humanFallback' };
    session.history.push({ role: 'assistant', content: 'Je vous passe le gérant ?' });
    outputs.push(turn({ interpretation: 'end_call', action: 'end_call', say: 'Au revoir.' }));
    const pending = processTranscriptStreaming(
      session,
      'Non, laissez tomber la réservation, au revoir.',
      mgr,
    );
    await vi.advanceTimersByTimeAsync(16_000);
    await pending;
    vi.useRealTimers();
    expect(
      JSON.stringify(vi.mocked(mgr.streamStructuredCompletion).mock.calls[0][1]),
    ).not.toContain('PORTÉE DE LA RÉPONSE');
    expect(spoken().join(' ')).toContain('Au revoir.');
    expect(mgr.cleanup).toHaveBeenCalledWith(session);
    expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
  });

  it('un oui entre transfert et message ne déclenche aucune des deux actions', async () => {
    vi.stubEnv('VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS', RESTAURANT_ID);
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = { ...createStructuredTurnState(), lastAwaiting: 'humanFallback' };
    session.history.push({
      role: 'assistant',
      content: 'Je vous passe le gérant ou je prends un message ?',
    });
    outputs.push(
      turn({ interpretation: 'affirmation', action: 'transfer' }),
      turn({ awaiting: 'humanFallback', say: 'Vous préférez le transfert ou le message ?' }),
    );
    await processTranscriptStreaming(session, 'Oui.', mgr);
    expect(mgr.handoffToManager).not.toHaveBeenCalled();
    expect(mgr.recordCallerMessage).not.toHaveBeenCalled();
    expect(spoken()).toEqual(['Vous préférez le transfert ou le message ?']);
  });

  it('crée la réservation après un oui au récapitulatif, et la confirme sans second appel', async () => {
    const { session, mgr, outputs } = fixture();
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: 'Akkif' };
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft,
      availability: { date: draft.date, partySize: 4, slots: ['20:00'] },
      lastAwaiting: 'confirmation',
      recapKey: bookingKey(draft),
    };
    outputs.push(turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }));

    await processTranscriptStreaming(session, 'oui c’est parfait', mgr);

    expect(mgr.createReservationFromConversation).toHaveBeenCalledTimes(1);
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(session.structuredTurn?.reservationCreated).toBe(true);
    expect(session.conversation.confirmedReservationKey).not.toBeNull();
  });

  describe('confirmation d’une réservation créée : un seul passage (appel du 19/11, 2,8 s)', () => {
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: 'Akkif' };
    const CONFIRMED = /^Votre réservation est confirmée : \S.* à 20 h, pour 4 personnes\.$/;

    function confirmingSession() {
      const fixed = fixture();
      fixed.session.structuredTurn = {
        ...createStructuredTurnState(),
        draft,
        availability: { date: draft.date, partySize: 4, slots: ['20:00'] },
        lastAwaiting: 'confirmation',
        recapKey: bookingKey(draft),
      };
      fixed.outputs.push(
        turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }),
      );
      return fixed;
    }

    it('dit la confirmation à partir du brouillon vérifié, sans second appel au modèle', async () => {
      const { session, mgr, outputs } = confirmingSession();

      await processTranscriptStreaming(session, 'oui c’est bon', mgr);

      expect(outputs).toHaveLength(0);
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken()).toEqual([expect.stringMatching(CONFIRMED)]);
      expect(session.history.at(-1)?.content).toBe(spoken()[0]);
      expect(session.structuredTurn?.lastAwaiting).toBe('none');
    });

    it('ajoute le SMS de confirmation seulement quand le restaurant l’envoie', async () => {
      const { session, mgr } = confirmingSession();
      session.smsConfirmEnabled = true;

      await processTranscriptStreaming(session, 'oui c’est bon', mgr);

      expect(spoken()).toEqual([
        expect.stringMatching(/ pour 4 personnes\. Un SMS de confirmation va vous être envoyé\.$/),
      ]);
    });

    it('avec empreinte bancaire, la réponse reste celle du second passage', async () => {
      vi.mocked(voiceCardGuaranteeTerms).mockResolvedValueOnce({
        amountPerPerson: 10,
        totalAmount: 40,
        cancellationHours: 2,
      } as never);
      const { session, mgr, outputs } = confirmingSession();
      const reply = 'Votre table est gardée. Le lien pour la carte vous arrive par SMS.';
      outputs.push(turn({ draft, say: reply }));

      await processTranscriptStreaming(session, 'oui c’est bon', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[2]).toMatchObject({
        json_schema: { name: 'voice_action_reply' },
      });
      expect(spoken().join(' ')).toBe(reply);
    });
  });

  it('dit la première phrase pendant la génération de say, avant le dernier fragment (say reste en dernier)', async () => {
    const { session, mgr, outputs } = fixture();
    // Fragments reçus en laissant tourner la boucle entre deux, comme le flux réel : le juge de fin de tour répond.
    // Pour chaque fragment, le nombre d'appels TTS déjà faits est relevé avant qu'il arrive.
    const spokenBefore: number[] = [];
    vi.mocked(mgr.streamStructuredCompletion).mockImplementation(async (_s, _m, _f, options) => {
      const next = outputs.shift();
      if (!next) throw new Error('no scripted model output');
      const json = JSON.stringify(next);
      for (let index = 0; index < json.length; index += 7) {
        spokenBefore.push(vi.mocked(speakTtsStreamed).mock.calls.length);
        options.onDelta(json.slice(index, index + 7));
        await new Promise((resolve) => setImmediate(resolve));
      }
      return json;
    });
    outputs.push(
      turn({
        draft: { date: TOMORROW, time: '20:00', partySize: 2, customerName: '' },
        awaiting: 'customerName',
        say: 'C’est possible. À quel nom ?',
      }),
    );

    await processTranscriptStreaming(session, 'demain 20 heures pour deux', mgr);

    // Le début de réponse part pendant la génération de say : sinon il attend la fin du JSON.
    expect(spokenBefore.at(-1)).toBeGreaterThan(0);
  });

  describe('récapitulatif coupé par l’appelant', () => {
    const RECAP = 'Donc, demain à 20 h, pour 4 personnes, au nom de Akkif. C’est bon ?';
    const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: 'Akkif' };
    function recapFixture(unheard: string) {
      const context = fixture();
      context.session.structuredTurn = {
        ...createStructuredTurnState(),
        draft,
        availability: { date: draft.date, partySize: 4, slots: ['20:00'] },
        lastAwaiting: 'confirmation',
        recapKey: bookingKey(draft),
      };
      context.session.interruptedReply = {
        said: RECAP,
        heard: RECAP.slice(0, RECAP.length - unheard.length).trim(),
        unheard,
      };
      return context;
    }

    it('ne réserve pas sur un oui dit avant d’avoir entendu tout le contenu, et donne la suite', async () => {
      const { session, mgr, outputs } = recapFixture(
        'pour 4 personnes, au nom de Akkif. C’est bon ?',
      );
      outputs.push(
        turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }),
        turn({
          draft,
          awaiting: 'confirmation',
          say: 'Pour 4 personnes, au nom de Akkif. C’est bon ?',
        }),
      );

      await processTranscriptStreaming(session, 'oui', mgr);

      expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();
      const secondPass = vi.mocked(mgr.streamStructuredCompletion).mock.calls[1]?.[1] as Array<{
        content: string;
      }>;
      expect(secondPass[0].content).toContain('entendu tout le récapitulatif');
      expect(secondPass[0].content).toContain('pour 4 personnes, au nom de Akkif');
      expect(session.interruptedReply).toBeUndefined();
    });

    it('accepte le oui suivant : un seul refus par récapitulatif', async () => {
      const { session, mgr, outputs } = recapFixture(
        'pour 4 personnes, au nom de Akkif. C’est bon ?',
      );
      outputs.push(
        turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }),
        turn({
          draft,
          awaiting: 'confirmation',
          say: 'Pour 4 personnes, au nom de Akkif. C’est bon ?',
        }),
      );
      await processTranscriptStreaming(session, 'oui', mgr);
      expect(mgr.createReservationFromConversation).not.toHaveBeenCalled();

      // L'appelant répond encore par-dessus la relecture : son accord vaut.
      session.interruptedReply = {
        said: RECAP,
        heard: 'Pour 4',
        unheard: 'personnes, au nom de Akkif. C’est bon ?',
      };
      outputs.push(
        turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }),
        turn({ draft, say: 'C’est réservé. Bonne soirée !' }),
      );
      await processTranscriptStreaming(session, 'oui', mgr);
      expect(mgr.createReservationFromConversation).toHaveBeenCalledTimes(1);
    });

    it('réserve quand seule la question finale n’a pas été entendue', async () => {
      const { session, mgr, outputs } = recapFixture('C’est bon ?');
      outputs.push(
        turn({ interpretation: 'affirmation', draft, action: 'create_reservation' }),
        turn({ draft, say: 'C’est réservé. Bonne soirée !' }),
      );

      await processTranscriptStreaming(session, 'oui', mgr);

      expect(mgr.createReservationFromConversation).toHaveBeenCalledTimes(1);
    });
  });

  it('jette la réponse préparée comme un barge-in quand l’appelant reprend avant le premier son', async () => {
    cartesiaContext.enabled = true;
    const { session, mgr, outputs } = fixture();
    outputs.push(turn({ say: 'Bonjour. Pour quel jour ?', awaiting: 'date' }));
    contextTurn.onHoldCancelled = undefined;

    await processTranscriptStreaming(session, 'oui bonjour', mgr);

    const onHoldCancelled = contextTurn.onHoldCancelled as (() => void) | undefined;
    expect(onHoldCancelled).toBeTypeOf('function');
    onHoldCancelled?.();
    expect(session.sttAfterBargeIn).toBe(true);
    expect(mgr.handleBargeIn).toHaveBeenCalledWith(session);
  });

  it('refuse une date passée proposée par le modèle', async () => {
    const { session, mgr, outputs } = fixture();
    outputs.push(
      turn({
        draft: { date: '2020-01-01', time: '', partySize: 2, customerName: '' },
        awaiting: 'date',
        say: 'Pour quel jour ?',
      }),
    );

    await processTranscriptStreaming(session, 'le premier janvier', mgr);

    expect(session.structuredTurn?.draft.date).toBe('');
    expect(session.structuredTurn?.draft.partySize).toBe(2);
  });

  it('dit une phrase de secours si la sortie du modèle est invalide', async () => {
    const { session, mgr } = fixture();
    vi.mocked(mgr.streamStructuredCompletion).mockResolvedValueOnce('{"say":');

    await processTranscriptStreaming(session, 'bonjour', mgr);

    expect(spoken()).toHaveLength(1);
    expect(session.state).toBe('LISTENING');
  });

  it('se tait quand l’appelant n’a pas fini et recolle le fragment (appel d89cdb48)', async () => {
    const { session, mgr, outputs } = fixture();
    const answer = turn({
      interpretation: 'question',
      awaiting: 'open',
      say: 'Pour six, je n’ai rien demain. Voulez-vous un autre jour ?',
    });
    // Le premier fragment inachevé prépare déjà une réponse (spéculation, toujours active) : elle
    // consomme une sortie du modèle, la seconde sert le tour recollé.
    outputs.push(
      turn({ turnComplete: false, interpretation: 'unclear', confidence: 'low' }),
      answer,
      answer,
    );

    await processTranscriptStreaming(session, 'pourquoi parce que vous n’acceptez pas les', mgr);

    expect(spoken()).toEqual([]);
    expect(session.state).toBe('LISTENING');
    expect(session.history).toEqual([]);
    expect(session.structuredTurn?.pendingFragment).toBe(
      'pourquoi parce que vous n’acceptez pas les',
    );

    await processTranscriptStreaming(session, 'groupes de six le dimanche', mgr);

    const lastMessages = vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[1] as Array<{
      content: string;
    }>;
    expect(lastMessages.at(-1)?.content).toBe(
      'pourquoi parce que vous n’acceptez pas les groupes de six le dimanche',
    );
    expect(spoken()).toEqual(['Pour six, je n’ai rien demain.', 'Voulez-vous un autre jour ?']);
    expect(session.structuredTurn?.pendingFragment).toBeNull();
  });

  it('répond quand même si l’appelant reste silencieux après un tour inachevé', async () => {
    vi.useFakeTimers();
    const { session, mgr, outputs } = fixture();
    outputs.push(
      turn({ turnComplete: false, interpretation: 'unclear', confidence: 'low' }),
      turn({
        interpretation: 'unclear',
        awaiting: 'open',
        say: 'Je vous écoute, prenez votre temps.',
      }),
    );

    await processTranscriptStreaming(session, 'non mais attends', mgr);
    expect(spoken()).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_100);
    vi.useRealTimers();

    expect(spoken()).toEqual(['Je vous écoute, prenez votre temps.']);
    expect(session.history.map((message) => message.content)).toEqual([
      'non mais attends',
      'Je vous écoute, prenez votre temps.',
    ]);
  });

  it('rend le début de phrase au tour suivant quand la relance après silence est dépassée (appel bb50c0d3)', async () => {
    // Épellation : « c'est au nom de à » (la lettre A) retenu, relance après silence, puis l'appelant
    // continue « f l e l o u » avant que la relance ait parlé. Le A ne doit pas disparaître.
    vi.useFakeTimers();
    const { session, mgr, outputs } = fixture();
    const stream = vi.mocked(mgr.streamStructuredCompletion);
    const scripted = stream.getMockImplementation()!;
    stream
      .mockImplementationOnce(scripted)
      // La relance reste en cours : le modèle n'a pas encore répondu quand l'appelant reprend.
      .mockImplementationOnce(() => new Promise<string>(() => undefined))
      .mockImplementation(scripted);
    outputs.push(
      turn({ turnComplete: false, interpretation: 'unclear' }),
      turn({
        awaiting: 'customerNameConfirmation',
        draft: { date: '', time: '', partySize: 0, customerName: 'AFLELOU' },
        say: 'A, F, L, E, L, O, U. C’est bien ça ?',
      }),
    );

    await processTranscriptStreaming(session, "c'est au nom de à", mgr);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    await processTranscriptStreaming(session, 'f l e l o u', mgr);
    vi.useRealTimers();

    const lastMessages = stream.mock.calls.at(-1)?.[1] as Array<{
      role: string;
      content: string;
    }>;
    expect(lastMessages.at(-1)?.content).toContain("c'est au nom de à f l e l o u");
    expect(session.history.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      "c'est au nom de à f l e l o u",
    ]);
  });

  describe('minuteur après un tour inachevé (appel 1b3f85e9)', () => {
    const scripted = (outputs: StructuredTurnOutput[]) =>
      outputs.push(
        turn({ turnComplete: false, interpretation: 'unclear', confidence: 'low' }),
        turn({ interpretation: 'unclear', awaiting: 'open', say: 'Je vous écoute.' }),
      );

    it('compte depuis le début du tour, pas depuis la réponse du modèle', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      await processTranscriptStreaming(session, 'trois non non', mgr);
      await vi.advanceTimersByTimeAsync(1_900);
      expect(spoken()).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it('déduit le silence audio déjà écoulé avant la réception du texte', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      session.callerVoice = {
        noiseFloor: 20,
        voiceRun: 0,
        trackedMs: 2_000,
        lastVoiceAt: Date.now() - 1_200,
      };
      await processTranscriptStreaming(session, 'trois non non', mgr);
      await vi.advanceTimersByTimeAsync(799);
      expect(spoken()).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it('garde une grâce de 300 ms si le budget audio est déjà écoulé', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      session.callerVoice = {
        noiseFloor: 20,
        voiceRun: 0,
        trackedMs: 4_000,
        lastVoiceAt: Date.now() - 3_000,
      };
      await processTranscriptStreaming(session, 'je voudrais', mgr);
      await vi.advanceTimersByTimeAsync(299);
      expect(spoken()).toEqual([]);
      await vi.advanceTimersByTimeAsync(2);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it('réévalue une reprise audio même sans transcription partielle', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      session.callerVoice = {
        noiseFloor: 20,
        voiceRun: 0,
        trackedMs: 2_000,
        lastVoiceAt: Date.now() - 1_200,
      };
      await processTranscriptStreaming(session, 'au nom de', mgr);
      await vi.advanceTimersByTimeAsync(500);
      session.callerVoice.lastVoiceAt = Date.now();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(spoken()).toEqual([]);
      await vi.advanceTimersByTimeAsync(701);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it.each([undefined, 499, 2_000])(
      'garde le délai historique sans audio fiable (%s ms)',
      async (trackedMs) => {
        vi.useFakeTimers();
        const { session, mgr, outputs } = fixture();
        scripted(outputs);
        session.callerVoice = {
          noiseFloor: 20,
          voiceRun: 0,
          trackedMs,
          lastVoiceAt: trackedMs === 2_000 ? undefined : Date.now() - 3_000,
        };
        await processTranscriptStreaming(session, 'je voudrais', mgr);
        await vi.advanceTimersByTimeAsync(1_999);
        expect(spoken()).toEqual([]);
        await vi.advanceTimersByTimeAsync(2);
        vi.useRealTimers();
        expect(spoken()).toEqual(['Je vous écoute.']);
      },
    );

    it('ne répond pas par-dessus l’appelant tant que des mots arrivent, puis répond', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      await processTranscriptStreaming(session, 'trois non non', mgr);
      session.sttDeepgramPendingInterim = true;
      await vi.advanceTimersByTimeAsync(2_100);
      expect(spoken()).toEqual([]);
      session.sttDeepgramPendingInterim = false;
      await vi.advanceTimersByTimeAsync(800);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it('borne le report : une transcription qui ne vient jamais ne bloque pas la réponse', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      await processTranscriptStreaming(session, 'trois non non', mgr);
      session.sttDeepgramPendingInterim = true;
      await vi.advanceTimersByTimeAsync(6_000);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });

    it('se règle par VOICE_INCOMPLETE_TURN_SILENCE_MS et ignore une valeur absurde', async () => {
      expect(incompleteTurnSilenceMs({})).toBe(2_000);
      expect(incompleteTurnSilenceMs({ VOICE_INCOMPLETE_TURN_SILENCE_MS: '1200' })).toBe(1_200);
      expect(incompleteTurnSilenceMs({ VOICE_INCOMPLETE_TURN_SILENCE_MS: '50' })).toBe(2_000);
      expect(incompleteTurnSilenceMs({ VOICE_INCOMPLETE_TURN_SILENCE_MS: 'vite' })).toBe(2_000);
      vi.useFakeTimers();
      vi.stubEnv('VOICE_INCOMPLETE_TURN_SILENCE_MS', '1000');
      const { session, mgr, outputs } = fixture();
      scripted(outputs);
      await processTranscriptStreaming(session, 'trois non non', mgr);
      await vi.advanceTimersByTimeAsync(1_100);
      vi.useRealTimers();
      expect(spoken()).toEqual(['Je vous écoute.']);
    });
  });

  it('impose turnComplete=true à la relance et ne dit jamais « pas compris » (appel cdc95509)', async () => {
    vi.useFakeTimers();
    const { session, mgr, outputs } = fixture();
    outputs.push(turn({ turnComplete: false, interpretation: 'unclear' }));
    await processTranscriptStreaming(session, 'bonjour je vous appelle pour', mgr);
    expect(spoken()).toEqual([]);

    // Le modèle rend encore une phrase vide : le filet parle à sa place.
    outputs.push(turn({ turnComplete: true, interpretation: 'unclear', say: '' }));
    await vi.advanceTimersByTimeAsync(2_600);

    const format = vi.mocked(mgr.streamStructuredCompletion).mock.calls.at(-1)?.[2] as {
      json_schema: { schema: { properties: { turnComplete: unknown } } };
    };
    expect(format.json_schema.schema.properties.turnComplete).toEqual({
      type: 'boolean',
      enum: [true],
    });
    expect(spoken()).toEqual([CALLER_FINISHED_FALLBACK]);
    expect(session.history.at(-1)?.content).toBe(CALLER_FINISHED_FALLBACK);
    vi.useRealTimers();
  });

  describe('contexte Cartesia (phrases enchaînées)', () => {
    beforeEach(() => {
      cartesiaContext.enabled = true;
      contextTurn.finish.mockResolvedValue(undefined);
      contextTurn.hasAudioOutput = false;
    });

    it('envoie toutes les phrases d’une réponse dans un seul contexte, sans HTTP', async () => {
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));
      await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

      expect(contextTurn.push.mock.calls.map(([text]) => text)).toEqual([
        'Bien sûr.',
        'Pour quel jour ?',
      ]);
      expect(contextTurn.finish).toHaveBeenCalledTimes(1);
      expect(speakTtsStreamed).not.toHaveBeenCalled();
      expect(session.ttsContext).toBeNull();
    });

    it('repasse par HTTP si le contexte échoue avant tout audio, et le compte', async () => {
      voiceTtsContextFailureTotal.reset();
      contextTurn.finish.mockRejectedValueOnce(new Error('socket closed'));
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));
      await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

      expect(spoken()).toEqual(['Bien sûr. Pour quel jour ?']);
      const { values } = await voiceTtsContextFailureTotal.get();
      expect(values).toEqual([
        { labels: { provider: 'cartesia', outcome: 'http_fallback' }, value: 1 },
      ]);
    });

    it('compte une réponse coupée en cours de route, sans la répéter en HTTP', async () => {
      voiceTtsContextFailureTotal.reset();
      contextTurn.finish.mockRejectedValueOnce(new Error('socket closed'));
      contextTurn.hasAudioOutput = true;
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));
      await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

      expect(speakTtsStreamed).not.toHaveBeenCalled();
      const { values } = await voiceTtsContextFailureTotal.get();
      expect(values).toEqual([
        { labels: { provider: 'cartesia', outcome: 'audio_cut' }, value: 1 },
      ]);
    });

    it('envoie le ton choisi avec la première phrase seulement', async () => {
      // Voix ElevenLabs Dialogue (clé présente) : le tour est simulé par le contexte ci-dessus.
      vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-elevenlabs-key');
      const { session, mgr, outputs } = fixture();
      // `tone` avant `say`, comme dans le schéma.
      const { say, ...rest } = turn({
        awaiting: 'partySize',
        say: 'Oh, quarante ans. Vous serez combien ?',
      });
      outputs.push({ ...rest, tone: 'cheerful', say });
      await processTranscriptStreaming(session, "c'est pour les quarante ans de ma femme", mgr);

      expect(contextTurn.push.mock.calls).toEqual([
        ['Oh, quarante ans.', { tone: 'cheerful' }],
        ['Vous serez combien ?', {}],
      ]);
      const format = vi.mocked(mgr.streamStructuredCompletion).mock.calls[0][2] as {
        json_schema: { schema: { properties: Record<string, unknown> } };
      };
      expect(format.json_schema.schema.properties).toHaveProperty('tone');
    });

    it('n’ajoute aucun ton sans voix ElevenLabs, ni pour none', async () => {
      vi.stubEnv('ELEVENLABS_API_KEY', '');
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));
      await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

      expect(contextTurn.push.mock.calls.map(([, options]) => options)).toEqual([{}, {}]);
      const format = vi.mocked(mgr.streamStructuredCompletion).mock.calls[0][2] as {
        json_schema: { schema: { properties: Record<string, unknown> } };
      };
      expect(format.json_schema.schema.properties).not.toHaveProperty('tone');
    });

    describe("petits mots d'attente", () => {
      const media = (session: CallSession) =>
        vi
          .mocked(session.telnyxWs.send)
          .mock.calls.filter(([payload]) => String(payload).includes('"media"')).length;
      beforeEach(() => {
        contextTurn.provider = 'elevenlabs';
        vi.stubEnv('VOICE_FILLER_DELAY_MS', '300');
        for (const text of voiceFillerTexts()) {
          __setVoiceFillerAudioForTests(text, 'PCMA', Buffer.alloc(1_600, 0x2a));
        }
      });
      afterEach(() => {
        contextTurn.provider = 'cartesia';
        for (const text of voiceFillerTexts()) __setVoiceFillerAudioForTests(text, 'PCMA', null);
      });
      function slowModel(mgr: CallSessionManager, delayMs: number): void {
        const original = vi.mocked(mgr.streamStructuredCompletion).getMockImplementation()!;
        vi.mocked(mgr.streamStructuredCompletion).mockImplementation(async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return original(...args);
        });
      }

      it('vérification réelle et réponse lente : un son part, la réponse suit', async () => {
        const { session, mgr, outputs } = fixture();
        session.codec = 'PCMA';
        slowModel(mgr, 450);
        const draft = { date: TOMORROW, time: '20:00', partySize: 4, customerName: '' };
        outputs.push(
          turn({ draft, action: 'check_availability' }),
          turn({ draft, awaiting: 'customerName', say: 'Il me reste vingt heures. À quel nom ?' }),
        );
        await processTranscriptStreaming(session, 'on serait quatre vers vingt heures', mgr);
        await waitForVoiceFiller(session);

        expect(media(session)).toBe(2);
        expect(contextTurn.push.mock.calls.map(([text]) => text)).toEqual([
          'Il me reste vingt heures.',
          'À quel nom ?',
        ]);
      });

      it('question simple, même lente : aucun son', async () => {
        const { session, mgr, outputs } = fixture();
        session.codec = 'PCMA';
        slowModel(mgr, 900);
        outputs.push(turn({ awaiting: 'partySize', say: 'Pour combien de personnes ?' }));
        await processTranscriptStreaming(session, 'je voudrais réserver demain', mgr);

        expect(media(session)).toBe(0);
      });
    });

    describe('phrases complètes ElevenLabs', () => {
      beforeEach(() => {
        contextTurn.provider = 'elevenlabs';
      });
      afterEach(() => {
        contextTurn.provider = 'cartesia';
      });
      const pushed = () => contextTurn.push.mock.calls.map(([text]) => text);
      // Le juge de fin de tour répond avant le premier mot du modèle, comme en appel : la voix peut partir tôt.
      function judgeFirst(mgr: CallSessionManager): void {
        const original = vi.mocked(mgr.streamStructuredCompletion).getMockImplementation()!;
        vi.mocked(mgr.streamStructuredCompletion).mockImplementation(async (...args) => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          return original(...args);
        });
      }

      it('garde le début à la virgule avec la phrase entière, puis envoie les suivantes', async () => {
        const { session, mgr, outputs } = fixture();
        judgeFirst(mgr);
        outputs.push(
          turn({ awaiting: 'partySize', say: 'Très bien, pour combien de personnes ? Merci.' }),
        );
        await processTranscriptStreaming(session, 'je voudrais réserver demain', mgr);

        expect(contextTurn.push.mock.calls).toEqual([
          ['Très bien, pour combien de personnes ?', { flush: true }],
          ['Merci.', { flush: true }],
        ]);
        // L'historique garde la phrase du modèle, entière.
        expect(session.history.at(-1)?.content).toBe(
          'Très bien, pour combien de personnes ? Merci.',
        );
      });

      it('le ton part avec la première phrase complète, une seule fois', async () => {
        vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-elevenlabs-key');
        const { session, mgr, outputs } = fixture();
        judgeFirst(mgr);
        const { say, ...rest } = turn({
          awaiting: 'partySize',
          say: 'Oh, quarante ans, quelle belle occasion. Vous serez combien ?',
        });
        outputs.push({ ...rest, tone: 'cheerful', say });
        await processTranscriptStreaming(session, "c'est pour les quarante ans de ma femme", mgr);

        expect(contextTurn.push.mock.calls).toEqual([
          ['Oh, quarante ans, quelle belle occasion.', { tone: 'cheerful', flush: true }],
          ['Vous serez combien ?', { flush: true }],
        ]);
      });

      it('sans effet hors ElevenLabs', async () => {
        contextTurn.provider = 'cartesia';
        const { session, mgr, outputs } = fixture();
        outputs.push(
          turn({ awaiting: 'partySize', say: 'Très bien, pour combien de personnes ?' }),
        );
        await processTranscriptStreaming(session, 'je voudrais réserver demain', mgr);

        expect(pushed()).toEqual(['Très bien, pour combien de personnes ?']);
      });

      it('rien ne part tant que l’appelant n’a pas fini (turnComplete=false)', async () => {
        const { session, mgr, outputs } = fixture();
        outputs.push(
          turn({
            turnComplete: false,
            interpretation: 'unclear',
            say: 'Très bien, je vous écoute.',
          }),
        );
        await processTranscriptStreaming(session, 'je voudrais', mgr);

        expect(contextTurn.push).not.toHaveBeenCalled();
      });

      it('rien ne part avant le résultat d’une action : seule la réponse du second passage est dite', async () => {
        const { session, mgr, outputs } = fixture();
        outputs.push(
          turn({
            action: 'check_availability',
            draft: { date: TOMORROW, time: '20:00', partySize: 2, customerName: '' },
            say: 'Un instant, je regarde.',
          }),
          turn({
            draft: { date: TOMORROW, time: '20:00', partySize: 2, customerName: '' },
            awaiting: 'customerName',
            say: 'C’est possible, à quel nom ?',
          }),
        );
        await processTranscriptStreaming(session, 'demain 20 heures pour deux', mgr);

        expect(pushed()).not.toContain('Un instant,');
        expect(pushed()[0]).toBe('C’est possible, à quel nom ?');
      });

      it('la relecture du nom n’est jamais coupée : elle reste retenue jusqu’à la vérification', async () => {
        const fx = fixture();
        const state = createStructuredTurnState();
        state.draft = { date: TOMORROW, time: '12:30', partySize: 5, customerName: '' };
        state.lastAwaiting = 'customerName';
        fx.session.structuredTurn = state;
        fx.outputs.push(
          turn({
            draft: { date: TOMORROW, time: '12:30', partySize: 5, customerName: 'ASSAMM' },
            awaiting: 'customerNameConfirmation',
            say: "Donc Assamm, avec deux s et deux m. C'est bien ça ?",
          }),
          turn({
            draft: { date: TOMORROW, time: '12:30', partySize: 5, customerName: 'ASSAMM' },
            awaiting: 'customerNameConfirmation',
            say: "Donc A, S, S, A, M, M. C'est bien ça ?",
          }),
        );
        await processTranscriptStreaming(fx.session, 'a 2 s a 2 m', fx.mgr);

        expect(pushed().join(' ')).not.toContain('Assamm');
        expect(pushed()).not.toContain('Donc Assamm,');
      });

      it('« question seule » actif : la phrase retirée n’est pas entamée', async () => {
        const fx = fixture();
        fx.session.structuredTurn = {
          ...createStructuredTurnState(),
          draft: { date: TOMORROW, time: '', partySize: 0, customerName: '' },
          lastAwaiting: 'time',
        };
        fx.outputs.push(
          turn({
            draft: { date: TOMORROW, time: '20:00', partySize: 0, customerName: '' },
            awaiting: 'partySize',
            say: 'Samedi soir, ça marche. Vous êtes combien ?',
          }),
        );
        await processTranscriptStreaming(fx.session, 'pour 20 heures', fx.mgr);

        expect(pushed()).toEqual(['Vous êtes combien ?']);
      });
    });

    it('ferme sans audio le contexte d’un tour où l’agent se tait', async () => {
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ turnComplete: false, interpretation: 'unclear' }));
      await processTranscriptStreaming(session, 'je voudrais', mgr);

      expect(contextTurn.cancel).toHaveBeenCalledWith('unused');
      expect(contextTurn.push).not.toHaveBeenCalled();
    });
  });

  describe('spéculation sur partielle stable', () => {
    it('reprend la requête lancée sur la partielle quand la phrase finale est identique', async () => {
      const { session, mgr, outputs } = fixture();
      outputs.push(turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }));
      speculateStructuredTurn(session, mgr, 'je voudrais réserver');
      expect(spoken()).toEqual([]);

      await processTranscriptStreaming(session, 'je voudrais réserver', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
      expect(spoken()).toEqual(['Bien sûr.', 'Pour quel jour ?']);
    });

    it('abandonne la spéculation quand la phrase finale diffère', async () => {
      const { session, mgr, outputs } = fixture();
      outputs.push(
        turn({ awaiting: 'date', say: 'Réponse spéculative.' }),
        turn({ awaiting: 'date', say: 'Pour quel jour ?' }),
      );
      speculateStructuredTurn(session, mgr, 'je voudrais');

      await processTranscriptStreaming(session, 'je voudrais réserver une table', mgr);

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(spoken()).toEqual(['Pour quel jour ?']);
    });

    it('prépare la réponse dès qu’un tour est jugé inachevé, et la dit sans nouvel appel si l’appelant se tait', async () => {
      // Appel bb50c0d3 du 16/10/2026 : phrase finie jugée inachevée, puis attente, puis passage complet.
      vi.useFakeTimers();
      // Heure figée au milieu d'une heure : la requête porte l'heure du restaurant (« 10 h, matin »), et une
      // attente qui franchit l'heure pile change la requête, donc la réponse préparée ne sert plus (CI du
      // 20/10, lancé à 10:59:58 à Paris : un troisième appel au modèle).
      vi.setSystemTime(new Date('2026-10-20T08:30:00.000Z'));
      const { session, mgr, outputs } = fixture();
      outputs.push(
        turn({ turnComplete: false, interpretation: 'new_request' }),
        turn({ awaiting: 'date', say: 'Bien sûr. Pour quel jour ?' }),
      );

      await processTranscriptStreaming(session, 'je vous appelle pour faire une réservation', mgr);
      // La réponse est déjà demandée, mais rien n'est dit pendant l'attente.
      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(spoken()).toEqual([]);

      await vi.advanceTimersByTimeAsync(2_100);
      vi.useRealTimers();

      expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
      expect(spoken()).toEqual(['Bien sûr.', 'Pour quel jour ?']);
    });

    it('jette la réponse préparée quand l’appelant reprend la parole', async () => {
      vi.useFakeTimers();
      const { session, mgr, outputs } = fixture();
      outputs.push(
        turn({ turnComplete: false, interpretation: 'new_request' }),
        turn({ awaiting: 'date', say: 'Réponse préparée.' }),
        turn({ awaiting: 'time', say: 'Pour samedi. Vers quelle heure ?' }),
      );

      await processTranscriptStreaming(session, 'je vous appelle pour', mgr);
      await processTranscriptStreaming(session, 'réserver samedi', mgr);
      await vi.advanceTimersByTimeAsync(2_100);
      vi.useRealTimers();

      expect(spoken()).toEqual(['Pour samedi.', 'Vers quelle heure ?']);
    });

    it('ne spécule pas pendant que l’agent parle', () => {
      const { session, mgr } = fixture();
      session.state = 'SPEAKING';
      speculateStructuredTurn(session, mgr, 'attendez');
      expect(mgr.streamStructuredCompletion).not.toHaveBeenCalled();
    });
  });
});

describe('relecture du nom : les lettres isolées, vérifiées par le code (appel 8043662c)', () => {
  const named = (customerName: string) => ({
    date: TOMORROW,
    time: '12:30',
    partySize: 5,
    customerName,
  });
  const askingName = () => {
    const fx = fixture();
    const state = createStructuredTurnState();
    state.draft = named('');
    state.lastAwaiting = 'customerName';
    fx.session.structuredTurn = state;
    return fx;
  };
  const contextOf = (mgr: CallSessionManager, pass: number) =>
    (
      vi.mocked(mgr.streamStructuredCompletion).mock.calls[pass]?.[1] as Array<{ content: string }>
    )[0].content;

  it('dit la relecture du modèle quand elle porte chaque lettre isolée et dans l’ordre', async () => {
    const { session, mgr, outputs } = askingName();
    outputs.push(
      turn({
        draft: named('ASSAMM'),
        awaiting: 'customerNameConfirmation',
        say: "Je note A, S, S, A, M, M. C'est bien ça ?",
      }),
    );

    // « a deux s a deux m » : le nom ASSAMM, épelé avec deux lettres doublées.
    await processTranscriptStreaming(session, 'a 2 s a 2 m', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(spoken().join(' ')).toContain('A, S, S, A, M, M');
    expect(session.history.at(-1)?.content).toContain('A, S, S, A, M, M');
    expect(session.structuredTurn?.lastAwaiting).toBe('customerNameConfirmation');
  });

  it('se tait quand le modèle relit le nom comme un mot, puis redonne les lettres en données', async () => {
    const { session, mgr, outputs } = askingName();
    outputs.push(
      turn({
        draft: named('ASSAMM'),
        awaiting: 'customerNameConfirmation',
        say: "Donc Assamm, avec deux s et deux m. C'est bien ça ?",
      }),
      turn({
        draft: named('ASSAMM'),
        awaiting: 'customerNameConfirmation',
        say: "Donc A, S, S, A, M, M. C'est bien ça ?",
      }),
    );

    await processTranscriptStreaming(session, 'a 2 s a 2 m', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    const fact = contextOf(mgr, 1);
    expect(fact).toContain('« ASSAMM »');
    expect(fact).toContain('"letter":"S","count":2');
    const said = spoken().join(' ');
    expect(said).not.toContain('avec deux s');
    expect(said).toContain('A, S, S, A, M, M');
  });

  it('refuse aussi « A, deux S, A, deux M » : une lettre doublée doit s’écrire deux fois', async () => {
    const { session, mgr, outputs } = askingName();
    outputs.push(
      turn({
        draft: named('ASSAMM'),
        awaiting: 'customerNameConfirmation',
        say: "Donc A, deux S, A, deux M. C'est bien ça ?",
      }),
      turn({
        draft: named('ASSAMM'),
        awaiting: 'customerNameConfirmation',
        say: "Donc A, S, S, A, M, M. C'est bien ça ?",
      }),
    );

    await processTranscriptStreaming(session, 'a 2 s a 2 m', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    expect(spoken().join(' ')).not.toContain('deux S');
  });

  it('dit seulement les lettres quand le second passage ne les porte toujours pas', async () => {
    const { session, mgr, outputs } = askingName();
    const wrong = turn({
      draft: named('ASSAMM'),
      awaiting: 'customerNameConfirmation',
      say: "Donc Assamm, avec deux s et deux m. C'est bien ça ?",
    });
    outputs.push(wrong, wrong);

    await processTranscriptStreaming(session, 'a 2 s a 2 m', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    expect(spoken()).toEqual(['A, S, S, A, M, M']);
    expect(session.structuredTurn?.lastAwaiting).toBe('customerNameConfirmation');
    expect(session.structuredTurn?.draft.customerName).toBe('ASSAMM');
  });

  it('met les lettres du nom déjà retenu dans l’ÉTAT VÉRIFIÉ du premier passage', async () => {
    const { session, mgr, outputs } = fixture();
    const state = createStructuredTurnState();
    state.draft = named('ASSAMM');
    state.lastAwaiting = 'customerNameConfirmation';
    session.structuredTurn = state;
    outputs.push(
      turn({
        draft: named('ASSAM'),
        awaiting: 'customerNameConfirmation',
        say: "Je corrige : A, S, S, A, M. C'est bien ça ?",
      }),
    );

    await processTranscriptStreaming(session, 'non un seul m', mgr);

    expect(contextOf(mgr, 0)).toContain(
      '"nameLetters":[{"letter":"A","count":1},{"letter":"S","count":2}',
    );
    // Le nom change à ce tour : la relecture porte les lettres du NOUVEAU nom.
    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(session.structuredTurn?.draft.customerName).toBe('ASSAM');
    expect(spoken().join(' ')).toContain('A, S, S, A, M');
  });

  it('ne retient pas une phrase qui ne relit pas le nom (aucune confirmation d’orthographe)', async () => {
    const { session, mgr, outputs } = fixture();
    const state = createStructuredTurnState();
    state.draft = named('HOUET');
    state.lastAwaiting = 'confirmation';
    session.structuredTurn = state;
    outputs.push(
      turn({
        draft: named('HOUET'),
        awaiting: 'confirmation',
        say: 'Je réserve pour Houet, on est bon ?',
      }),
    );

    await processTranscriptStreaming(session, 'oui', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(1);
    expect(spoken().join(' ')).toContain('Houet');
  });
});

describe('repli parlé quand le tour échoue (appel du 19/10, 22 h 09)', () => {
  const TECHNICAL = "Désolée, j'ai eu un petit souci de mon côté. Pouvez-vous me le redire ?";
  const NOT_UNDERSTOOD = "Pardon, je n'ai pas bien saisi. Pouvez-vous répéter ?";
  const ESCALATION =
    'Je rencontre un petit souci technique. Je peux vous passer le gérant ou prendre un message. Que préférez-vous ?';

  it('panne du fournisseur : dit que le souci vient de nous, pas « pas compris »', async () => {
    const { session, mgr } = fixture();
    vi.mocked(mgr.streamStructuredCompletion).mockRejectedValueOnce(
      new Error('Cerebras queue timeout'),
    );

    await processTranscriptStreaming(session, 'je voudrais réserver pour demain soir', mgr);

    expect(spoken()).toEqual([TECHNICAL]);
    expect(session.history.at(-1)).toEqual({ role: 'assistant', content: TECHNICAL });
    expect(session.conversation.llmFailureStreak).toBe(1);
    // Le détecteur d'incompréhension ne compte pas une panne de notre côté.
    expect(session.conversation.misunderstandingCount).toBe(0);
  });

  it('sortie du modèle inexploitable : garde « je n’ai pas bien saisi »', async () => {
    const { session, mgr } = fixture();
    vi.mocked(mgr.streamStructuredCompletion).mockResolvedValueOnce('pas du JSON');

    await processTranscriptStreaming(session, 'euh hm', mgr);

    expect(spoken()).toEqual([NOT_UNDERSTOOD]);
  });

  it('propose le gérant ou un message au deuxième échec d’affilée', async () => {
    const { session, mgr } = fixture();
    session.managerPhone = '+33100000000';
    vi.mocked(mgr.streamStructuredCompletion)
      .mockRejectedValueOnce(new Error('upstream 503'))
      .mockRejectedValueOnce(new Error('upstream 503'));

    await processTranscriptStreaming(session, 'une table pour quatre', mgr);
    await processTranscriptStreaming(session, 'je disais une table pour quatre demain', mgr);

    expect(spoken()).toEqual([TECHNICAL, ESCALATION]);
  });

  it('un tour réussi remet le compteur à zéro', async () => {
    const { session, mgr, outputs } = fixture();
    session.managerPhone = '+33100000000';
    vi.mocked(mgr.streamStructuredCompletion).mockRejectedValueOnce(new Error('upstream 503'));
    await processTranscriptStreaming(session, 'une table pour quatre', mgr);

    outputs.push(turn({ awaiting: 'date', say: 'Pour quel jour ?' }));
    await processTranscriptStreaming(session, 'je disais une table pour quatre', mgr);
    expect(session.conversation.llmFailureStreak).toBe(0);

    vi.mocked(mgr.streamStructuredCompletion).mockRejectedValueOnce(new Error('upstream 503'));
    await processTranscriptStreaming(session, 'demain', mgr);

    expect(spoken()).toEqual([TECHNICAL, 'Pour quel jour ?', TECHNICAL]);
  });
});

describe('tour structuré : say vide, secours et voix hors tour', () => {
  it('tour compris, brouillon modifié, phrase vide : relance du modèle, pas de « répéter » (appel 548c73c5)', async () => {
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft: { date: TOMORROW, time: '19:00', partySize: 5, customerName: '' },
      lastAwaiting: 'partySize',
    };
    const corrected = { date: TOMORROW, time: '19:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ interpretation: 'correction', understanding: 'clear', draft: corrected, say: '' }),
      turn({
        interpretation: 'correction',
        understanding: 'clear',
        draft: corrected,
        awaiting: 'customerName',
        say: 'Très bien, pour quatre. Quel nom dois-je inscrire ?',
      }),
    );

    await processTranscriptStreaming(session, '5 non 4', mgr);

    expect(mgr.streamStructuredCompletion).toHaveBeenCalledTimes(2);
    expect(spoken().join(' ')).toContain('Quel nom dois-je inscrire');
    expect(spoken().join(' ')).not.toContain('répéter');
  });

  it('si la relance reste vide aussi, pose la question suivante du parcours au lieu de « répéter »', async () => {
    const { session, mgr, outputs } = fixture();
    session.structuredTurn = {
      ...createStructuredTurnState(),
      draft: { date: TOMORROW, time: '19:00', partySize: 5, customerName: '' },
      lastAwaiting: 'partySize',
    };
    const corrected = { date: TOMORROW, time: '19:00', partySize: 4, customerName: '' };
    outputs.push(
      turn({ interpretation: 'correction', understanding: 'clear', draft: corrected, say: '' }),
      turn({ interpretation: 'correction', understanding: 'clear', draft: corrected, say: '' }),
    );

    await processTranscriptStreaming(session, '5 non 4', mgr);

    expect(spoken().join(' ')).toBe('Quel nom dois-je inscrire pour la réservation ?');
  });

  it('le secours hors tour passe par ElevenLabs quand sa clé est présente', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-key');
    const { session, mgr } = fixture();
    // Aucune sortie scriptée : le modèle échoue, le secours est dit.
    await processTranscriptStreaming(session, 'bonjour je voudrais réserver', mgr);

    const calls = vi.mocked(speakTtsStreamed).mock.calls;
    expect(calls.at(-1)?.[2]).toBe('elevenlabs');
  });
});
