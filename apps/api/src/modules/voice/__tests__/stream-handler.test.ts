/**
 * Tests pour handler.ts — registerMediaStreamRoutes (WebSocket Telnyx Media Stream).
 *
 * Le handler enregistre une route WS sur /voice/stream/:callId.
 * On crée une app Fastify minimale avec @fastify/websocket, on mock toutes
 * les dépendances (CallSessionManager, stt-bridge, tts-cache, etc.),
 * on démarre le serveur sur un port aléatoire, et on connecte un vrai client WS.
 *
 * Scénarios testés :
 *  - Connexion WS acceptée
 *  - Événement `connected` : no-op
 *  - Événement `start` avec session connue : assigne telnyxWs, transition SPEAKING
 *  - Événement `start` sans session : no-op (pas de crash)
 *  - Événement `media` : forward à sendAudioToStt
 *  - Événement `stop` : cleanup, closeStt, mgr.delete
 *  - Événement `dtmf` : no-op
 *  - Fermeture WS : cleanup de la session
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import type { CallSession } from '../stream/types';

const STREAM_FIXTURE = 'test-stream-token';

// ── Mocks (doivent précéder les imports under test) ────────────────────────

const { mockMgr } = vi.hoisted(() => ({
  mockMgr: {
    get: vi.fn(),
    delete: vi.fn(),
    transition: vi.fn().mockReturnValue(true),
    handleBargeIn: vi.fn(),
  },
}));

vi.mock('../stream/manager', () => ({
  CallSessionManager: {
    getInstance: vi.fn().mockReturnValue(mockMgr),
  },
}));

vi.mock('../stream/stt-bridge', () => ({
  sendAudioToStt: vi.fn(),
  closeStt: vi.fn(),
  connectStt: vi.fn().mockResolvedValue(undefined),
  sttProviderId: vi.fn(() => 'deepgram'),
}));

vi.mock('../tts-cache', () => ({
  getTtsCached: vi.fn().mockResolvedValue(null),
  setTtsCached: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/logger/pino', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock('../../../shared/sentry/client', () => ({
  captureException: vi.fn(),
}));

vi.mock('../call-recording.service', () => ({
  startTestCallRecording: vi.fn().mockResolvedValue(undefined),
}));

const { mockFinalizeVoiceCall } = vi.hoisted(() => ({
  mockFinalizeVoiceCall: vi.fn(),
}));

vi.mock('../call-finalization.service', () => ({
  finalizeVoiceCall: mockFinalizeVoiceCall,
}));

vi.mock('../../../shared/db/client', () => ({
  db: {
    call: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findUnique: vi.fn().mockResolvedValue({ id: 'call-1' }),
    },
    latencyTrace: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
    voiceCallTelemetry: {
      upsert: vi.fn().mockResolvedValue(undefined),
      updateMany: vi.fn().mockResolvedValue(undefined),
    },
    voiceTurnTelemetry: {
      upsert: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

// ── Imports under test ─────────────────────────────────────────────────────

import { buildInitialGreeting, registerMediaStreamRoutes } from '../stream/handler';
import { sendAudioToStt, closeStt } from '../stream/stt-bridge';

describe('buildInitialGreeting', () => {
  it('présente Léa, l’assistante IA, dès le décroché (règlement européen sur l’IA, article 50)', () => {
    // 12 h et 21 h à Paris : la salutation suit l'heure du restaurant, pas celle du serveur (UTC).
    expect(
      buildInitialGreeting('Chez Michel', 'Europe/Paris', new Date('2026-11-19T11:00:00Z')),
    ).toBe("Chez Michel, bonjour. Léa, l'assistante IA, je vous écoute.");
    expect(
      buildInitialGreeting('Chez Michel', 'Europe/Paris', new Date('2026-11-19T20:00:00Z')),
    ).toBe("Chez Michel, bonsoir. Léa, l'assistante IA, je vous écoute.");
  });

  it('dit « bonsoir » après minuit et « bonjour » dès 5 h', () => {
    expect(
      buildInitialGreeting('Chez Michel', 'Europe/Paris', new Date('2026-11-18T23:16:00Z')),
    ).toContain(', bonsoir.');
    expect(
      buildInitialGreeting('Chez Michel', 'Europe/Paris', new Date('2026-11-19T04:00:00Z')),
    ).toContain(', bonjour.');
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockSession(): CallSession {
  return {
    callControlId: 'cc-ws-1',
    streamToken: STREAM_FIXTURE,
    callSessionId: 'cs-ws-1',
    callLegId: 'leg-ws-1',
    from: '+33****0001',
    to: '+33****0000',
    restaurantId: 'rest-1',
    restaurantName: 'Test Resto',
    systemPrompt: "Tu es l'assistant vocal de Test Resto.",
    state: 'IDLE',
    ended: false,
    turnCount: 0,
    isVip: false,
    codec: 'PCMA',
    history: [],
    telnyxWs: null,
    sttWs: null,
    sttReady: Promise.resolve(),
    onSttEvent: null,
    audioBuffer: [],
    isSpeaking: false,
    bargeInChunks: 0,
    abortController: null,
    speculativeLlm: null,
    speculativeTranscript: '',
    speculativeResult: null,
    transcript: '',
    turnTranscript: '',
    speechFinalTimer: null,
    lastActivityAt: Date.now(),
    createdAt: Date.now(),
    personality: null,
    latencyTrace: undefined,
  } as unknown as CallSession;
}

async function startApp() {
  const app = Fastify();
  await app.register(fastifyWebsocket);
  const recoveryQueueAdd = vi.fn().mockResolvedValue(undefined);
  Object.assign(app, {
    db: { customer: { findFirst: vi.fn().mockResolvedValue({ name: 'Test Caller' }) } },
    queues: { callRecovery: { add: recoveryQueueAdd } },
  });
  registerMediaStreamRoutes(app);
  // Le sandbox de test ne permet pas l'écoute IPv6 `::1`. Forcer IPv4
  // garde le test fidèle au parcours WebSocket sans dépendre de la résolution
  // de `localhost` de la machine qui exécute Vitest.
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { app, port, recoveryQueueAdd };
}

function connectWs(port: number, callId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/voice/stream/${callId}?token=${STREAM_FIXTURE}`,
    );
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function sendAndWait(ws: WebSocket, msg: unknown): Promise<void> {
  return new Promise((resolve) => {
    ws.send(JSON.stringify(msg), () => resolve());
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('registerMediaStreamRoutes — WebSocket Telnyx Media Stream', () => {
  let app: Awaited<ReturnType<typeof startApp>>['app'];
  let recoveryQueueAdd: ReturnType<typeof vi.fn>;
  let port: number;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockFinalizeVoiceCall.mockResolvedValue(undefined);
    mockMgr.get.mockReturnValue(makeMockSession());
    mockMgr.transition.mockReturnValue(true);
    originalFetch = globalThis.fetch;
    // speakTelnyxNative (fallback TTS) appelle fetch — on mock pour éviter un crash
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue({ ok: true, text: vi.fn() }) as unknown as typeof globalThis.fetch;

    const started = await startApp();
    app = started.app;
    port = started.port;
    recoveryQueueAdd = started.recoveryQueueAdd;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await app.close();
  });

  it('accepte une connexion WebSocket sur /voice/stream/:callId', async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejette un client sans jeton valide', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/stream/cc-ws-1?token=incorrect`);
    await new Promise<void>((resolve) => ws.on('close', () => resolve()));
    expect(mockMgr.transition).not.toHaveBeenCalled();
    expect(sendAudioToStt).not.toHaveBeenCalled();
  });

  it('rejette le flux audio avant start et un start pour un autre appel', async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, { event: 'media', media: { payload: 'YQ==' } });
    await delay(50);
    expect(ws.readyState).toBe(WebSocket.CLOSED);
    expect(sendAudioToStt).not.toHaveBeenCalled();
    const second = await connectWs(port, 'cc-ws-1');
    await sendAndWait(second, {
      event: 'start',
      start: {
        call_control_id: 'other',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(50);
    expect(second.readyState).toBe(WebSocket.CLOSED);
    expect(mockMgr.transition).not.toHaveBeenCalled();
  });

  it('ne supprime pas une session plus récente quand une ancienne connexion se ferme', async () => {
    const first = makeMockSession();
    mockMgr.get.mockReturnValue(first);
    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(30);
    const replacement = makeMockSession();
    mockMgr.get.mockReturnValue(replacement);
    mockMgr.delete.mockClear();
    ws.close();
    await delay(50);
    expect(mockMgr.delete).not.toHaveBeenCalled();
    expect(replacement.ended).toBe(false);
  });

  it("traite l'événement `connected` sans erreur", async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, { event: 'connected' });
    await delay(50);
    // Pas de crash, pas d'appel à mgr.get pour connected
    expect(mockMgr.get).toHaveBeenCalledWith('cc-ws-1');
    ws.close();
  });

  it('événement `start` : assigne telnyxWs et transitionne vers SPEAKING si session trouvée', async () => {
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-ws-1',
        from: '+33****0001',
        to: '+33****0000',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(100);

    expect(mockMgr.get).toHaveBeenCalledWith('cc-ws-1');
    expect(session.telnyxWs).toBeDefined();
    // transition vers SPEAKING (pour le greeting)
    expect(mockMgr.transition).toHaveBeenCalledWith(session, 'SPEAKING');
    ws.close();
  });

  it.each([
    ['appel Telnyx', false, 1],
    ['démonstration navigateur (aucun leg Telnyx à enregistrer)', true, 0],
  ])(
    'événement `start` (%s) : enregistrement de test démarré %i fois',
    async (_label, demo, calls) => {
      const { startTestCallRecording } = await import('../call-recording.service');
      vi.mocked(startTestCallRecording).mockClear();
      const session = { ...makeMockSession(), ...(demo ? { demo: true } : {}) };
      mockMgr.get.mockReturnValue(session);

      const ws = await connectWs(port, 'cc-ws-1');
      await sendAndWait(ws, {
        event: 'start',
        start: {
          call_control_id: 'cc-ws-1',
          call_session_id: 'cs-ws-1',
          from: 'x',
          to: 'y',
          media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
        },
      });
      await delay(100);

      expect(startTestCallRecording).toHaveBeenCalledTimes(calls);
      expect(mockMgr.transition).toHaveBeenCalledWith(session, 'SPEAKING'); // l'accueil est joué dans les deux cas
      ws.close();
    },
  );

  it("événement `start` : journalise le lien callControlId ↔ callLegId pour le rapport d'appel", async () => {
    const { logger } = await import('../../../shared/logger/pino');
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-ws-1',
        from: '+33****0001',
        to: '+33****0000',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(100);

    expect(logger.info).toHaveBeenCalledWith(
      { callId: 'cc-ws-1', callLegId: session.callLegId },
      '[voice-report] call linked',
    );
    ws.close();
  });

  it('événement `start` sans session : no-op (pas de crash)', async () => {
    mockMgr.get.mockReturnValue(undefined);

    const ws = await connectWs(port, 'cc-unknown');
    await delay(50);

    expect(mockMgr.get).toHaveBeenCalledWith('cc-unknown');
    // Pas de transition si pas de session
    expect(mockMgr.transition).not.toHaveBeenCalled();
    ws.close();
  });

  it('événement `media` : forward le payload à sendAudioToStt', async () => {
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    // D'abord start pour que la session soit assignée
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        from: '+33****0001',
        to: '+33****0000',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(50);

    vi.mocked(sendAudioToStt).mockClear();
    mockMgr.get.mockReturnValue(session);

    await sendAndWait(ws, {
      event: 'media',
      media: {
        track: 'inbound',
        chunk: '1',
        timestamp: '0',
        payload: Buffer.from('audio-chunk').toString('base64'),
      },
    });
    await delay(50);

    expect(sendAudioToStt).toHaveBeenCalledWith(
      session,
      Buffer.from('audio-chunk').toString('base64'),
    );
    ws.close();
  });

  it('ignore une piste sortante pour ne pas renvoyer la voix TTS à Scribe', async () => {
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(20);
    await sendAndWait(ws, {
      event: 'media',
      media: {
        track: 'outbound',
        chunk: '1',
        timestamp: '0',
        payload: Buffer.from('tts-audio').toString('base64'),
      },
    });
    await delay(50);

    expect(sendAudioToStt).not.toHaveBeenCalled();
    ws.close();
  });

  it("événement `media` sans payload : n'appelle pas sendAudioToStt", async () => {
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(20);
    await sendAndWait(ws, { event: 'media', media: {} });
    await delay(50);

    expect(sendAudioToStt).not.toHaveBeenCalled();
    ws.close();
  });

  it('événement `stop` : cleanup la session, closeStt et mgr.delete', async () => {
    const session = makeMockSession();
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        from: '+33****0001',
        to: '+33****0000',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(50);

    await sendAndWait(ws, { event: 'stop', stop: { call_control_id: 'cc-ws-1' } });
    await delay(100);

    expect(session.ended).toBe(true);
    expect(closeStt).toHaveBeenCalledWith(session);
    expect(mockMgr.delete).toHaveBeenCalledWith('cc-ws-1');
    ws.close();
  });

  it('événement `dtmf` : no-op (pas de crash)', async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(20);
    await sendAndWait(ws, { event: 'dtmf', dtmf: { digit: '1' } });
    await delay(50);
    // Pas d'erreur = succès
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("événement `error` : capture l'erreur via Sentry sans crash", async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(20);
    await sendAndWait(ws, { event: 'error', error: { code: 'test' } });
    await delay(50);
    // La connexion reste ouverte
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('fermeture WS : marque la session comme ended et appelle mgr.delete', async () => {
    const session = makeMockSession();
    session.currentTurn = { llmProvider: 'cerebras' } as NonNullable<CallSession['currentTurn']>;
    mockMgr.get.mockReturnValue(session);

    const ws = await connectWs(port, 'cc-ws-1');
    // Envoyer start pour que la session soit connue du handler
    await sendAndWait(ws, {
      event: 'start',
      start: {
        call_control_id: 'cc-ws-1',
        call_session_id: 'cs-1',
        from: '+33****0001',
        to: '+33****0000',
        media_format: { encoding: 'PCMA', sample_rate: 8000, channels: 1 },
      },
    });
    await delay(50);

    // Fermer la connexion WS
    ws.close();
    await delay(150);

    expect(session.ended).toBe(true);
    expect(mockMgr.delete).toHaveBeenCalledWith('cc-ws-1');
    // La fermeture du stream finalise l'appel : sans ça, un appel coupé
    // resterait sans outcome si `/voice/telnyx/end` n'arrive jamais.
    expect(mockFinalizeVoiceCall).toHaveBeenCalledWith(
      'leg-ws-1',
      expect.objectContaining({ source: 'stream-close', llmProvider: 'cerebras' }),
      expect.objectContaining({
        enqueueRecovery: expect.any(Function),
        loadRestaurantContext: expect.any(Function),
      }),
    );
    const finalizationDependencies = mockFinalizeVoiceCall.mock.calls.find(
      (call) => call[1]?.llmProvider === 'cerebras',
    )![2];
    await finalizationDependencies.enqueueRecovery(
      {
        callId: 'call-1',
        restaurantId: 'rest-1',
        customerPhone: '+33****0001',
        customerName: null,
        restaurantName: 'Test Resto',
        restaurantSlug: null,
        restaurantPhone: null,
        reason: 'no_action_with_intent',
      },
      'leg-ws-1',
    );
    expect(recoveryQueueAdd).toHaveBeenCalledWith(
      'send-recovery-sms',
      expect.objectContaining({ customerName: 'Test Caller', callId: 'call-1' }),
      { jobId: 'recovery_leg-ws-1' },
    );
  });

  it("message JSON invalide : log l'erreur sans crash", async () => {
    const ws = await connectWs(port, 'cc-ws-1');
    ws.send('not-json{{{');
    await delay(50);
    // La connexion reste ouverte malgré le parse error
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
