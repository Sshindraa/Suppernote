import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSession } from '../stream/types';

vi.mock('../../../shared/logger/pino', () => ({
  logger: { info: vi.fn() },
}));

import { logger } from '../../../shared/logger/pino';
import { __resetMetrics, renderMetrics } from '../../../shared/observability/metrics';
import { markVoiceTurnAudioSent, wordConfidenceStats } from '../stream/turn-telemetry';
import {
  completeVoiceTurnInput,
  markVoiceTurnLlmFirstToken,
  markVoiceTurnTtsSynthesisFirstByte,
  observedTtsProvider,
  recordVoiceTurnEvent,
  snapshotVoiceTurnTelemetry,
  startVoiceTurn,
} from '../stream/turn-telemetry';

type LoggedVoiceTurn = {
  event?: string;
  phase?: string;
  sequence?: number;
  endOfSpeechToSttFinalMs?: number;
  finalTrigger?: string;
  providerResultEndMs?: number;
  providerLastWordEndMs?: number;
  receivedAtAudioMs?: number;
  audioClockDriftMs?: number;
  firstPartialAt?: number;
  afterBargeIn?: boolean;
};

type LoggedPayload = {
  voiceTurn?: LoggedVoiceTurn;
};

function makeSession(): CallSession {
  return {
    callControlId: 'call-telemetry-1',
    currentTurn: null,
    conversation: { intent: 'reservation', pendingQuestion: 'time' },
  } as CallSession;
}

describe('voice turn telemetry', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a stable opaque id and never logs the transcript in plain text', () => {
    const session = makeSession();
    const transcript = 'Je voudrais réserver demain pour deux personnes.';

    startVoiceTurn(session, transcript);
    recordVoiceTurnEvent(session, 'availability_completed', { durationMs: 125 });

    expect(session.currentTurn?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.currentTurn?.transcriptLength).toBe(transcript.length);
    expect(session.currentTurn?.transcriptFingerprint).toHaveLength(12);
    const logs = vi.mocked(logger.info).mock.calls.map(([payload]) => JSON.stringify(payload));
    expect(logs.some((entry) => entry.includes(transcript))).toBe(false);
    const structured = vi
      .mocked(logger.info)
      .mock.calls.map(([payload]) => payload as LoggedPayload);
    expect(structured[0]?.voiceTurn).toMatchObject({
      event: 'started',
      phase: 'speech',
      sequence: 1,
    });
    expect(structured[1]?.voiceTurn).toMatchObject({
      event: 'availability_completed',
      phase: 'availability',
      sequence: 2,
    });
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(2);
  });

  it('persiste le fournisseur du texte sélectionné au lieu du fournisseur primaire', () => {
    const session = makeSession();
    session.sttProviderUsed = 'deepgram-nova-3';
    completeVoiceTurnInput(session, 'une table demain', undefined, {
      transcriptProvider: 'cartesia-ink-2',
    });
    expect(session.currentTurn?.sttProvider).toBe('cartesia-ink-2');
    const final = vi
      .mocked(logger.info)
      .mock.calls.find(([payload]) => (payload as LoggedPayload).voiceTurn?.event === 'stt_final');
    expect((final?.[0] as { voiceTurn: Record<string, unknown> }).voiceTurn).toMatchObject({
      transcriptProvider: 'cartesia-ink-2',
    });
    expect((final?.[0] as { voiceTurn: Record<string, unknown> }).voiceTurn).not.toHaveProperty(
      'meanWordConfidence',
    );
  });

  it('redémarre la mesure de latence à chaque tour', () => {
    const session = makeSession();
    session.latencyTrace = { startTime: 1, llmFirstTokenMs: 999 };

    startVoiceTurn(session, 'Au revoir');

    expect(session.latencyTrace?.startTime).toBe(session.currentTurn?.startedAt);
    expect(session.latencyTrace?.llmFirstTokenMs).toBeUndefined();
  });

  it('mesure depuis la prise de parole et sépare premier token, synthèse et audio', () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      startVoiceTurn(session);
      vi.advanceTimersByTime(240);
      completeVoiceTurnInput(session, 'Deux personnes', [
        { word: 'Deux', start: 0, end: 0.1 },
        { word: 'personnes', start: 0.11, end: 0.18 },
      ]);
      vi.advanceTimersByTime(120);
      expect(markVoiceTurnLlmFirstToken(session)).toBe(360);
      vi.advanceTimersByTime(80);
      expect(markVoiceTurnTtsSynthesisFirstByte(session, 'cartesia')).toBe(440);
      vi.advanceTimersByTime(60);
      recordVoiceTurnEvent(session, 'tts_first_audio', { totalE2eMs: 500 });

      expect(session.latencyTrace).toMatchObject({
        sttFinalMs: 240,
        speechDurationMs: 180,
        llmFirstTokenMs: 360,
        ttsFirstByteMs: 440,
      });
      const events = vi
        .mocked(logger.info)
        .mock.calls.map(([payload]) => (payload as LoggedPayload).voiceTurn as LoggedVoiceTurn);
      expect(events.map((event) => event.event)).toEqual([
        'started',
        'stt_final',
        'llm_first_token',
        'tts_synthesis_first_byte',
        'tts_first_audio',
      ]);
      expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('étiquette un tour ElevenLabs comme ElevenLabs, et non comme Cartesia', () => {
    const session = makeSession();
    startVoiceTurn(session, 'Une table pour deux ?');
    recordVoiceTurnEvent(session, 'tts_synthesis_started', { source: 'elevenlabs_dialogue' });
    markVoiceTurnTtsSynthesisFirstByte(session, 'elevenlabs_dialogue');
    recordVoiceTurnEvent(session, 'tts_completed', { durationMs: 80 });

    const turns = snapshotVoiceTurnTelemetry(session);
    expect(turns[0]).toMatchObject({ ttsProvider: 'elevenlabs' });
  });

  it('étiquette le chemin HTTP et le cache selon le fournisseur configuré', () => {
    vi.stubEnv('VOICE_TTS_PROVIDER', 'elevenlabs');
    try {
      for (const source of ['elevenlabs_http', 'cache', 'http_stream']) {
        const session = makeSession();
        startVoiceTurn(session, 'Une table pour deux ?');
        recordVoiceTurnEvent(session, 'tts_synthesis_started', { source });
        expect(snapshotVoiceTurnTelemetry(session)[0]).toMatchObject({ ttsProvider: 'elevenlabs' });
      }
      const native = makeSession();
      startVoiceTurn(native, 'Une table ?');
      recordVoiceTurnEvent(native, 'tts_synthesis_started', { source: 'native_fallback' });
      expect(snapshotVoiceTurnTelemetry(native)[0]).toMatchObject({ ttsProvider: 'telnyx-native' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('donne à l’appel le fournisseur TTS le plus utilisé par ses tours, avec le modèle', () => {
    const session = makeSession();
    expect(observedTtsProvider(session)).toBeNull();
    for (const source of ['elevenlabs_dialogue', 'elevenlabs_dialogue', 'native_fallback']) {
      startVoiceTurn(session, 'Une table ?');
      recordVoiceTurnEvent(session, 'tts_synthesis_started', { source });
    }
    expect(observedTtsProvider(session)).toBe('elevenlabs-eleven_v4_turbo');
  });

  it('conserve le premier tour LLM quand le tour suivant est déterministe', () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      startVoiceTurn(session, 'Quels horaires avez-vous ?');
      recordVoiceTurnEvent(session, 'llm_started', { mode: 'live' });
      vi.advanceTimersByTime(120);
      markVoiceTurnLlmFirstToken(session);
      recordVoiceTurnEvent(session, 'tts_synthesis_started', { source: 'http_stream' });
      vi.advanceTimersByTime(80);
      markVoiceTurnTtsSynthesisFirstByte(session, 'cartesia');
      recordVoiceTurnEvent(session, 'tts_first_audio', { totalE2eMs: 200 });
      recordVoiceTurnEvent(session, 'tts_completed', { durationMs: 80 });

      vi.advanceTimersByTime(40);
      startVoiceTurn(session, 'Merci');
      recordVoiceTurnEvent(session, 'tts_synthesis_started', { source: 'http_stream' });
      recordVoiceTurnEvent(session, 'tts_completed', { durationMs: 20 });

      const turns = snapshotVoiceTurnTelemetry(session);
      expect(turns).toHaveLength(2);
      expect(turns[0]).toMatchObject({
        path: 'llm',
        sequence: 1,
        llmProvider: 'cerebras',
        llmModel: expect.any(String),
      });
      expect(turns[0]?.latencyTrace?.llmFirstTokenMs).toBe(120);
      expect(turns[1]).toMatchObject({ path: 'deterministic', sequence: 2 });
      expect(turns[1]?.latencyTrace?.llmFirstTokenMs).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('mesure la recherche de disponibilité et signale une relance en boucle', () => {
    vi.useFakeTimers();
    try {
      const session = makeSession();
      startVoiceTurn(session, 'Avez-vous une table ?');
      recordVoiceTurnEvent(session, 'availability_started');
      vi.advanceTimersByTime(350);
      recordVoiceTurnEvent(session, 'availability_completed');
      recordVoiceTurnEvent(session, 'availability_completed');
      recordVoiceTurnEvent(session, 'dialogue_guard', { level: 'reformulate', count: 2 });

      const [turn] = snapshotVoiceTurnTelemetry(session);
      expect(turn).toMatchObject({
        path: 'availability',
        availabilitySearches: 1,
        availabilityFailures: 0,
        loopDetected: true,
      });
      expect(turn?.latencyTrace?.availabilityDurationMs).toBe(350);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('métriques de référence par restaurant', () => {
    beforeEach(() => __resetMetrics());

    function restaurantSession(): CallSession {
      return {
        ...makeSession(),
        restaurantId: 'resto-1',
      } as CallSession;
    }

    it('mesure fin de parole → premier audio par chemin, décalage de repli inclus', async () => {
      vi.useFakeTimers();
      try {
        const session = restaurantSession();
        startVoiceTurn(session);
        completeVoiceTurnInput(session, 'Pour deux personnes.');
        recordVoiceTurnEvent(session, 'llm_started');
        vi.advanceTimersByTime(150);
        markVoiceTurnAudioSent(session);
        const metrics = await renderMetrics();
        expect(metrics).toContain(
          'suppernote_voice_end_of_speech_to_first_audio_ms_bucket{le="1250",path="llm",restaurant_id="resto-1"} 1',
        );
        expect(metrics).toContain(
          'suppernote_voice_end_of_speech_to_first_audio_ms_bucket{le="1000",path="llm",restaurant_id="resto-1"} 0',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('mesure les jalons end-of-speech→STT final et end-of-speech→premier audio', async () => {
      vi.useFakeTimers();
      try {
        const session = restaurantSession();
        startVoiceTurn(session);
        const startedAt = Date.now();
        vi.advanceTimersByTime(300);
        completeVoiceTurnInput(session, 'Pour deux personnes.', [], {
          speechEndAt: startedAt + 200,
          sttFinalAt: startedAt + 300,
          turnDispatchedAt: startedAt + 450,
          finalTrigger: 'speech_final',
          providerResultEndMs: 250,
          providerLastWordEndMs: 200,
          receivedAtAudioMs: 300,
          audioClockDriftMs: 50,
          firstPartialAt: 120,
          afterBargeIn: true,
        });
        vi.advanceTimersByTime(400);
        markVoiceTurnAudioSent(session, { isFiller: false });

        expect(session.latencyTrace).toMatchObject({
          endOfSpeechToSttFinalMs: 100,
          holdMs: 150,
          endOfSpeechToFirstAudioMs: 500,
          firstAudioIsFiller: false,
        });
        const sttFinalLog = vi
          .mocked(logger.info)
          .mock.calls.map(([payload]) => payload as LoggedPayload)
          .find(({ voiceTurn }) => voiceTurn?.event === 'stt_final');
        const persistedTurn = snapshotVoiceTurnTelemetry(session).at(-1);
        expect(sttFinalLog?.voiceTurn).toMatchObject({
          endOfSpeechToSttFinalMs: 100,
          finalTrigger: 'speech_final',
          providerResultEndMs: 250,
          providerLastWordEndMs: 200,
          receivedAtAudioMs: 300,
          audioClockDriftMs: 50,
          firstPartialAt: 120,
          afterBargeIn: true,
        });
        expect(persistedTurn?.latencyTrace?.endOfSpeechToSttFinalMs).toBe(
          sttFinalLog?.voiceTurn?.endOfSpeechToSttFinalMs,
        );
        const metrics = await renderMetrics();
        expect(metrics).toContain(
          'suppernote_voice_end_of_speech_to_stt_final_ms_bucket{le="100",provider="unknown",final_trigger="speech_final"} 1',
        );
        expect(metrics).toContain(
          'suppernote_voice_end_of_speech_to_first_audio_ms_bucket{le="500",path="unknown",restaurant_id="resto-1"} 1',
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('compte fausses fins de tour, fillers et statuts TurnPlan', async () => {
      const session = restaurantSession();
      startVoiceTurn(session);
      recordVoiceTurnEvent(session, 'speech_resumed');
      recordVoiceTurnEvent(session, 'llm_interrupted', { reason: 'speech_resumed' });
      recordVoiceTurnEvent(session, 'llm_interrupted', { reason: 'error' });
      recordVoiceTurnEvent(session, 'filler_started', { purpose: 'thinking' });
      recordVoiceTurnEvent(session, 'filler_interrupted', { purpose: 'thinking' });
      recordVoiceTurnEvent(session, 'turn_plan_shadow', { status: 'speech_missing' });
      const metrics = await renderMetrics();
      expect(metrics).toContain(
        'suppernote_voice_false_end_of_turn_total{restaurant_id="resto-1"} 2',
      );
      expect(metrics).toContain(
        'suppernote_voice_filler_events_total{outcome="interrupted",purpose="thinking",restaurant_id="resto-1"} 1',
      );
      expect(metrics).toContain(
        'suppernote_voice_turn_plan_shadow_by_restaurant_total{status="speech_missing",restaurant_id="resto-1"} 1',
      );
    });
  });
});

describe('wordConfidenceStats', () => {
  it('résume la confiance STT d’un tour sans le texte', () => {
    expect(
      wordConfidenceStats([
        { word: 'six', confidence: 0.58 },
        { word: 'personnes', confidence: 0.33 },
        { word: 'demain', confidence: 0.9 },
      ]),
    ).toEqual({ minWordConfidence: 0.33, meanWordConfidence: 0.603, lowConfidenceWordCount: 1 });
  });

  it('ne publie rien quand Scribe ne fournit pas de confiance', () => {
    expect(wordConfidenceStats([{ word: 'six' }])).toEqual({});
  });
});
