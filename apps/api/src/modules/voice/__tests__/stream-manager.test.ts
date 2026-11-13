/**
 * Tests complémentaires pour CallSessionManager.
 *
 * manager.integration.test.ts couvre déjà : lifecycle, state machine de base,
 * barge-in, cleanup.
 *
 * Ce fichier couvre ce qui n'est PAS testé par l'integration test :
 *  - Singleton pattern & get/delete edge cases
 *  - create() avec overrides (giftCardMinimumAmount, personality)
 *  - State machine : transitions invalides rejetées
 *  - executeTool() : réservation, message au gérant, transfert
 *  - fournisseur LLM en streaming : secours OpenRouter, circuit breaker, timeout
 *  - cleanup ferme le WS ElevenLabs s'il est OPEN
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  CallSessionManager,
  _resetCircuitBreakersForTesting,
  mergeSystemMessages,
} from '../stream/manager';
import { voiceConfig, type VoiceConfig } from '../../../env';
import type { CallSession, ChatMessage } from '../stream/types';
import { getReservationConfirmationKey } from '../stream/conversation-state';

// ── Module mocks ───────────────────────────────────────────────────────────

vi.mock('../../reservations/reservation.service', () => ({
  ReservationService: {
    create: vi.fn(),
    update: vi.fn(),
    availability: vi.fn(),
  },
}));

vi.mock('../../../shared/db/client', () => ({
  db: {
    call: {
      findUnique: vi.fn().mockResolvedValue({ id: 'call-record-1', restaurantId: 'rest-1' }),
    },
    restaurant: {
      findUnique: vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' }),
    },
    reservation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    reservationAuditLog: {
      create: vi.fn(),
    },
    message: {
      create: vi.fn(),
    },
    reservationPayment: {
      findFirst: vi.fn(),
    },
  },
}));

const guarantee = vi.hoisted(() => ({ terms: vi.fn(), sms: vi.fn() }));
vi.mock('../card-guarantee-facts', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  voiceCardGuaranteeTerms: guarantee.terms,
}));
vi.mock('../../reservation-payments/reservation-guarantee.sms', () => ({
  enqueueCardGuaranteeSms: guarantee.sms,
}));

const { mockGiftCardCreate } = vi.hoisted(() => ({
  mockGiftCardCreate: vi.fn().mockResolvedValue({ id: 'gc-1', code: 'SKR-ABC123' }),
}));

const { mockTelnyxFetch } = vi.hoisted(() => ({
  mockTelnyxFetch: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../../shared/telnyx/http-agent', () => ({ telnyxFetch: mockTelnyxFetch }));

vi.mock('../../gift-cards/gift-card.service', () => ({
  GiftCardService: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.create = mockGiftCardCreate;
  }),
}));

vi.mock('../../gift-cards/gift-card-recommender', () => ({
  recommendGiftCardAmount: vi.fn().mockReturnValue({
    amount: 50,
    messageSuggestion: 'Un beau cadeau !',
  }),
}));

vi.mock('../../../shared/telnyx/client', () => ({
  sendSms: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../analytics/events.service', () => ({
  trackGiftCardEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../shared/logger/pino', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ── Imports under test ─────────────────────────────────────────────────────

import { ReservationService } from '../../reservations/reservation.service';
import { db } from '../../../shared/db/client';

// ── Helpers ────────────────────────────────────────────────────────────────

const CEREBRAS_TEST_KEY = ['test', 'cerebras', 'api', 'key'].join('-');
const OPENROUTER_TEST_KEY = ['test', 'openrouter', 'api', 'key'].join('-');

function makeTelnyxWs(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    OPEN: WebSocket.OPEN,
    CLOSED: WebSocket.CLOSED,
  } as unknown as WebSocket;
}

function makeSession(overrides: Partial<CallSession> = {}): CallSession {
  const mgr = CallSessionManager.getInstance();
  return mgr.create({
    callControlId: overrides.callControlId ?? 'cc-test-1',
    callSessionId: 'cs-test-1',
    from: '+33****0001',
    to: '+33****0000',
    restaurantId: 'rest-1',
    restaurantName: 'Test Resto',
    managerPhone: overrides.managerPhone,
    systemPrompt: "Tu es l'assistant vocal de Test Resto.",
    isVip: false,
    telnyxWs: overrides.telnyxWs ?? makeTelnyxWs(),
    callLegId: 'leg-test-1',
    codec: 'PCMA',
    giftCardMinimumAmount: overrides.giftCardMinimumAmount,
    personality: overrides.personality,
    demo: overrides.demo,
  });
}

function authorizeReservation(
  session: CallSession,
  date: string,
  time: string,
  partySize: number,
  customerName: string,
): void {
  session.conversation.intent = 'reservation';
  session.conversation.slots = { date, time, partySize, customerName };
  session.conversation.nameCollection.state = 'confirmed';
  session.conversation.nameCollection.confirmedName = customerName;
  session.conversation.lastAvailabilityResult = {
    key: `${date}:${time}:${partySize}`,
    date,
    time,
    partySize,
    slots: [time],
  };
  session.conversation.pendingReservationConfirmationKey = getReservationConfirmationKey(session);
  session.conversation.confirmedReservationKey = getReservationConfirmationKey(session);
}

type VoiceConfigSnapshot = Pick<
  VoiceConfig,
  | 'VOICE_LLM_MODEL'
  | 'VOICE_LLM_TIMEOUT_MS'
  | 'VOICE_LLM_PROVIDER'
  | 'CEREBRAS_BASE_URL'
  | 'CEREBRAS_API_KEY'
  | 'OPENROUTER_API_KEY'
  | 'OPENROUTER_BASE_URL'
  | 'OPENROUTER_FALLBACK_BASE_URL'
>;

function snapshotVoiceConfig(): VoiceConfigSnapshot {
  return {
    VOICE_LLM_MODEL: voiceConfig.VOICE_LLM_MODEL,
    VOICE_LLM_TIMEOUT_MS: voiceConfig.VOICE_LLM_TIMEOUT_MS,
    VOICE_LLM_PROVIDER: voiceConfig.VOICE_LLM_PROVIDER,
    CEREBRAS_BASE_URL: voiceConfig.CEREBRAS_BASE_URL,
    CEREBRAS_API_KEY: voiceConfig.CEREBRAS_API_KEY,
    OPENROUTER_API_KEY: voiceConfig.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: voiceConfig.OPENROUTER_BASE_URL,
    OPENROUTER_FALLBACK_BASE_URL: voiceConfig.OPENROUTER_FALLBACK_BASE_URL,
  };
}

function restoreVoiceConfig(snapshot: VoiceConfigSnapshot): void {
  Object.assign(voiceConfig, snapshot);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('CallSessionManager — singleton & CRUD', () => {
  it('expire une session sans flux sans interrompre une session connectée', () => {
    vi.useFakeTimers();
    try {
      const mgr = new CallSessionManager();
      const create = (id: string, ws: WebSocket | null) =>
        mgr.create({
          callControlId: id,
          callSessionId: id,
          from: '',
          to: '',
          restaurantId: 'rest-1',
          restaurantName: 'Test',
          systemPrompt: '',
          isVip: false,
          telnyxWs: ws as WebSocket,
          callLegId: id,
          codec: 'PCMA',
        });
      const abandoned = create('abandoned', null);
      const active = create('active', makeTelnyxWs());
      vi.advanceTimersByTime(10 * 60_000);
      expect(mgr.get('abandoned')).toBeUndefined();
      expect(abandoned.ended).toBe(true);
      expect(mgr.get('active')).toBe(active);
      mgr.delete('active');
    } finally {
      vi.useRealTimers();
    }
  });
  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
  });

  it('getInstance retourne la même instance (singleton)', () => {
    const a = CallSessionManager.getInstance();
    const b = CallSessionManager.getInstance();
    expect(a).toBe(b);
  });

  it('get retourne undefined pour un callControlId inconnu', () => {
    const mgr = CallSessionManager.getInstance();
    expect(mgr.get('unknown-cc-id')).toBeUndefined();
  });

  it("delete est un no-op si la session n'existe pas", () => {
    const mgr = CallSessionManager.getInstance();
    expect(() => mgr.delete('nonexistent')).not.toThrow();
  });

  it('create puis get retourne la session avec les bonnes valeurs', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession({ callControlId: 'cc-crud-1' });

    expect(mgr.get('cc-crud-1')).toBe(session);
    expect(session.restaurantName).toBe('Test Resto');
    expect(session.state).toBe('IDLE');
    expect(session.history).toHaveLength(2);
    expect(session.history[0].role).toBe('system');
    expect(session.history[1].role).toBe('assistant');
    expect(session.history[1].content).toBe('Bonjour, Test Resto !');
  });

  it('create utilise giftCardMinimumAmount=10 par défaut', () => {
    const session = makeSession();
    expect(session.giftCardMinimumAmount).toBe(10);
  });

  it('create respecte giftCardMinimumAmount personnalisé', () => {
    const session = makeSession({ giftCardMinimumAmount: 25 });
    expect(session.giftCardMinimumAmount).toBe(25);
  });

  it('create assigne personality=null par défaut', () => {
    const session = makeSession();
    expect(session.personality).toBeNull();
  });

  it('create respecte personality personnalisée', () => {
    const personality = { fillerStyle: 'WARM' as const, systemPromptExtra: 'Soyez chaleureux.' };
    const session = makeSession({ personality });
    expect(session.personality).toEqual(personality);
  });

  it('delete supprime la session du Map', () => {
    const mgr = CallSessionManager.getInstance();
    makeSession({ callControlId: 'cc-del-1' });
    expect(mgr.get('cc-del-1')).toBeDefined();

    mgr.delete('cc-del-1');
    expect(mgr.get('cc-del-1')).toBeUndefined();
  });
});

describe('CallSessionManager — state machine edge cases', () => {
  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
  });

  it('rejette IDLE → PROCESSING (transition invalide)', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    expect(mgr.transition(session, 'PROCESSING')).toBe(false);
    expect(session.state).toBe('IDLE');
  });

  it('rejette LISTENING → SPEAKING (transition invalide)', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    mgr.transition(session, 'LISTENING');
    expect(mgr.transition(session, 'SPEAKING')).toBe(false);
    expect(session.state).toBe('LISTENING');
  });

  it('rejette SPEAKING → PROCESSING (transition invalide)', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    mgr.transition(session, 'SPEAKING');
    expect(mgr.transition(session, 'PROCESSING')).toBe(false);
    expect(session.state).toBe('SPEAKING');
  });

  it('accepte PROCESSING → LISTENING (annulation)', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    mgr.transition(session, 'LISTENING');
    mgr.transition(session, 'PROCESSING');
    expect(mgr.transition(session, 'LISTENING')).toBe(true);
    expect(session.state).toBe('LISTENING');
  });

  it('accepte PROCESSING → IDLE (reset)', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    mgr.transition(session, 'LISTENING');
    mgr.transition(session, 'PROCESSING');
    expect(mgr.transition(session, 'IDLE')).toBe(true);
    expect(session.state).toBe('IDLE');
  });

  it('met à jour lastActivityAt sur chaque transition valide', () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    const before = session.lastActivityAt;
    // Force a small delay
    session.lastActivityAt = before - 1000;
    mgr.transition(session, 'LISTENING');
    expect(session.lastActivityAt).toBeGreaterThan(before - 1000);
  });
});

describe('CallSessionManager — tool execution', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    originalFetch = globalThis.fetch;
    vi.clearAllMocks();
    // Re-set the mock implementation after clearAllMocks
    mockGiftCardCreate.mockResolvedValue({ id: 'gc-1', code: 'SKR-ABC123' });
    vi.mocked(db.call.findUnique).mockReset();
    mockTelnyxFetch.mockResolvedValue({ ok: true });
    vi.mocked(db.call.findUnique).mockResolvedValue({
      id: 'call-record-1',
      restaurantId: 'rest-1',
    } as unknown as Awaited<ReturnType<typeof db.call.findUnique>>);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('createReservation : le compte rendu reflète le réglage du SMS de confirmation du restaurant', () => {
    async function created(smsConfirmEnabled: boolean | undefined) {
      vi.mocked(ReservationService.create).mockResolvedValue({
        id: 'res-sms',
      } as unknown as Awaited<ReturnType<typeof ReservationService.create>>);
      const mgr = CallSessionManager.getInstance();
      const session = makeSession();
      if (smsConfirmEnabled !== undefined) session.smsConfirmEnabled = smsConfirmEnabled;
      authorizeReservation(session, '2026-07-16', '19:30', 2, 'Jean');
      return mgr.createReservationFromConversation(session);
    }

    it('SMS désactivé pour ce restaurant : le compte rendu le dit et n’annonce aucun envoi', async () => {
      const reply = await created(false);
      expect(reply).toContain('Réservation confirmée pour Jean');
      expect(reply).toContain('désactivé pour ce restaurant');
      expect(reply).not.toContain('va être envoyé');
    });

    it('SMS activé : le compte rendu dit qu’il est activé et va être envoyé', async () => {
      const reply = await created(true);
      expect(reply).toContain('activé pour ce restaurant');
      expect(reply).toContain('va être envoyé');
      expect(reply).not.toContain('désactivé');
    });

    it('réglage inconnu (contexte en cache d’avant ce champ) : rien n’est dit du SMS', async () => {
      const reply = await created(undefined);
      expect(reply).toContain('Réservation confirmée pour Jean');
      expect(reply).not.toContain('SMS');
    });
  });

  describe('createReservation avec empreinte bancaire', () => {
    afterEach(() => guarantee.terms.mockReset().mockResolvedValue(null));
    const TERMS = {
      policyId: 'policy-1',
      amountPerPerson: '20.00',
      totalAmount: '80.00',
      currency: 'EUR',
      cancellationHours: 24,
    };

    it('tient la réservation en attente, envoie le lien par SMS et ne la dit pas confirmée', async () => {
      guarantee.terms.mockResolvedValue(TERMS);
      vi.mocked(ReservationService.create).mockResolvedValue({
        id: 'res-guarantee',
      } as unknown as Awaited<ReturnType<typeof ReservationService.create>>);
      vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({
        id: 'payment-1',
        restaurantId: 'rest-1',
      } as never);
      const mgr = CallSessionManager.getInstance();
      const session = makeSession();
      session.smsConfirmEnabled = true;
      authorizeReservation(session, '2026-07-16', '19:30', 4, 'Jean');

      const reply = await mgr.createReservationFromConversation(session);

      expect(ReservationService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          partySize: 4,
          cardGuarantee: { policyId: 'policy-1', expiresAt: expect.any(Date) },
        }),
      );
      const { expiresAt } = vi.mocked(ReservationService.create).mock.calls[0][0].cardGuarantee!;
      expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(119 * 60_000);
      expect(guarantee.sms).toHaveBeenCalledWith('link', {
        id: 'payment-1',
        restaurantId: 'rest-1',
      });
      expect(reply).toContain('EN ATTENTE');
      expect(reply).not.toContain('Réservation confirmée');
      expect(reply).not.toContain('va être envoyé');
    });

    it('sans numéro pour le lien : ne crée rien et oriente vers le gérant', async () => {
      guarantee.terms.mockResolvedValue(TERMS);
      const mgr = CallSessionManager.getInstance();
      const session = makeSession();
      session.from = '';
      authorizeReservation(session, '2026-07-16', '19:30', 4, 'Jean');

      const reply = await mgr.createReservationFromConversation(session);

      expect(ReservationService.create).not.toHaveBeenCalled();
      expect(reply).toContain('gérant');
    });
  });

  it('createReservationFromConversation : utilise le créneau vérifié et le nom confirmé', async () => {
    vi.mocked(ReservationService.create).mockResolvedValue({
      id: 'res-direct-1',
    } as unknown as Awaited<ReturnType<typeof ReservationService.create>>);

    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    session.conversation.slots = {
      date: '2026-07-16',
      time: '12:00',
      partySize: 4,
      customerName: 'AKKIF',
    };
    session.conversation.nameCollection.state = 'confirmed';
    session.conversation.nameCollection.confirmedName = 'AKKIF';
    session.conversation.lastAvailabilityResult = {
      key: '2026-07-16:12:00:4',
      date: '2026-07-16',
      time: '12:00',
      partySize: 4,
      slots: ['12:00', '12:30'],
    };
    session.conversation.pendingReservationConfirmationKey = getReservationConfirmationKey(session);
    session.conversation.confirmedReservationKey = getReservationConfirmationKey(session);

    const reply = await mgr.createReservationFromConversation(session);

    expect(reply).toContain('Réservation confirmée');
    expect(ReservationService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        restaurantId: 'rest-1',
        callId: 'call-record-1',
        partySize: 4,
        customerName: 'AKKIF',
        customerPhone: '+33****0001',
      }),
    );
  });
});

describe('CallSessionManager — session de démonstration (onboarding)', () => {
  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    vi.clearAllMocks();
    mockTelnyxFetch.mockResolvedValue({ ok: true });
  });

  it('create marque la session demo uniquement sur demande', () => {
    expect(makeSession({ callControlId: 'cc-demo-off' }).demo).toBeUndefined();
    expect(makeSession({ callControlId: 'cc-demo-on', demo: true }).demo).toBe(true);
  });

  it('simule la réservation : réponse de confirmation, aucune écriture en base', async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession({ demo: true });
    authorizeReservation(session, '2026-07-16', '19:30', 2, 'Jean');

    const reply = await mgr.createReservationFromConversation(session);

    expect(reply).toContain('Réservation confirmée pour Jean');
    expect(ReservationService.create).not.toHaveBeenCalled();
    expect(db.call.findUnique).not.toHaveBeenCalled();
    expect(session.reservationCreatedAt).toBeDefined();
  });

  it('garde la relecture et l’accord explicite avant de simuler la réservation', async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession({ demo: true });
    authorizeReservation(session, '2026-07-16', '19:30', 2, 'Jean');
    session.conversation.confirmedReservationKey = null;

    const reply = await mgr.createReservationFromConversation(session);

    expect(reply).toBeNull();
    expect(session.reservationCreatedAt).toBeUndefined();
  });

  it('simule le message au gérant : aucune écriture en base', async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession({ demo: true });

    const reply = await mgr.recordCallerMessage(session, 'Rappelez-moi demain');

    expect(reply).toContain('Rappelez-moi demain');
    expect(db.message.create).not.toHaveBeenCalled();
    expect(db.call.findUnique).not.toHaveBeenCalled();
  });

  it('ne transfère jamais vers le gérant : aucun appel Telnyx', async () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession({ demo: true, managerPhone: '+33612345678' });

    const reply = await mgr.handoffToManager(session, {
      kind: 'human_fallback_choice',
      choice: 'transfer',
    });

    // Un fait pour le modèle, pas une réplique : il dit la vraie raison (démonstration), sans parler du gérant.
    expect(reply).toContain('démonstration');
    expect(reply).toContain('sans affirmer');
    expect(mockTelnyxFetch).not.toHaveBeenCalled();
    expect(session.handoffInProgress).toBeFalsy();
    expect(session.handoffConclusion).toBe('demo_no_transfer');
  });
});

describe('CallSessionManager — cleanup avancé', () => {
  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
  });

  it("ferme le WS ElevenLabs s'il est OPEN", () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    const sttWs = { readyState: WebSocket.OPEN, close: vi.fn() } as unknown as WebSocket;
    session.sttWs = sttWs;

    mgr.cleanup(session);

    expect(sttWs.close).toHaveBeenCalled();
    expect(session.sttWs).toBeNull();
  });

  it("ne ferme pas le WS ElevenLabs s'il n'est pas OPEN", () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    const sttWs = { readyState: WebSocket.CLOSED, close: vi.fn() } as unknown as WebSocket;
    session.sttWs = sttWs;

    mgr.cleanup(session);

    expect(sttWs.close).not.toHaveBeenCalled();
    expect(session.sttWs).toBeNull();
  });

  it("vide l'audioBuffer", () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    session.audioBuffer.push(Buffer.from('chunk1'), Buffer.from('chunk2'));

    mgr.cleanup(session);

    expect(session.audioBuffer).toEqual([]);
  });

  it("abort l'AbortController en cours", () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    const ac = new AbortController();
    const abortSpy = vi.spyOn(ac, 'abort');
    session.abortController = ac;

    mgr.cleanup(session);

    expect(abortSpy).toHaveBeenCalled();
    expect(session.abortController).toBeNull();
  });

  it("clear le speechFinalTimer s'il existe", () => {
    const mgr = CallSessionManager.getInstance();
    const session = makeSession();
    const timer = setTimeout(() => {}, 60_000);
    session.speechFinalTimer = timer;

    mgr.cleanup(session);

    expect(session.speechFinalTimer).toBeNull();
  });
});

// ── Circuit breaker + timeout ──────────────────────────────────────────────

type LlmOpts = {
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
};

/** Accès au fetchLlmStreaming privé pour vérifier le chemin SSE. */
function callFetchLlmStreaming(
  mgr: CallSessionManager,
  messages: ChatMessage[],
  opts: LlmOpts,
  session: CallSession = {
    restaurantId: 'rest-stream-test',
    voiceFeatureSnapshot: {
      deepgramModel: 'nova-3',
    },
  } as CallSession,
): Promise<{ response: Response; provider: string }> {
  return (
    mgr as unknown as {
      fetchLlmStreaming: (
        s: CallSession,
        m: ChatMessage[],
        o: LlmOpts,
      ) => Promise<{ response: Response; provider: string }>;
    }
  ).fetchLlmStreaming(session, messages, opts);
}

/**
 * Hôte réellement appelé. On compare l'hôte exact plutôt qu'une sous-chaîne :
 * `api.cerebras.ai.evil.test` contient `api.cerebras.ai`, ce que CodeQL signale à
 * juste titre (js/incomplete-url-substring-sanitization).
 */
function requestHost(input: unknown): string {
  return new URL(String(input)).host;
}

/** Mock fetch qui répond 503 (provider indisponible). */
function mockFetchProviderFail() {
  const fetchMock = vi.fn().mockImplementation((_url: string) => {
    return Promise.resolve({
      ok: false,
      status: 503,
      text: vi.fn().mockResolvedValue('Service Unavailable'),
      json: vi.fn().mockResolvedValue({}),
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

/** Mock fetch qui throw une TypeError (erreur réseau). */
function mockFetchProviderNetworkError() {
  const fetchMock = vi.fn().mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

/** Mock fetch qui ne résout jamais et rejette sur abort du signal. */
function mockFetchHanging() {
  const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      if (signal) {
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      }
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  return fetchMock;
}

describe('CallSessionManager — provider LLM unique, circuit breaker et timeout', () => {
  let originalFetch: typeof globalThis.fetch;
  let savedVoiceConfig: VoiceConfigSnapshot;

  beforeEach(() => {
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    originalFetch = globalThis.fetch;
    savedVoiceConfig = snapshotVoiceConfig();
    _resetCircuitBreakersForTesting();
    voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
    voiceConfig.OPENROUTER_API_KEY = undefined;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    _resetCircuitBreakersForTesting();
    restoreVoiceConfig(savedVoiceConfig);
    vi.useRealTimers();
  });

  describe('secours du tour structuré', () => {
    const format = {
      type: 'json_schema' as const,
      json_schema: { name: 'voice_turn', strict: true as const, schema: { type: 'object' } },
    };
    function sseBody(content: string): ReadableStream<Uint8Array> {
      const payload = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload));
          controller.close();
        },
      });
    }

    it('passe par OpenRouter quand Cerebras refuse (quota épuisé)', async () => {
      voiceConfig.VOICE_LLM_PROVIDER = 'cerebras';
      voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
      voiceConfig.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 402, body: null })
        .mockResolvedValueOnce({ ok: true, status: 200, body: sseBody('{"say":"Bonjour"}') });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const session = makeSession();
      const deltas: string[] = [];

      const text = await CallSessionManager.getInstance().streamStructuredCompletion(
        session,
        [{ role: 'user', content: 'bonjour' }],
        format,
        { onDelta: (delta) => deltas.push(delta) },
      );

      expect(text).toBe('{"say":"Bonjour"}');
      expect(deltas).toEqual(['{"say":"Bonjour"}']);
      const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      expect(requestHost(url)).toBe('openrouter.ai');
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body.response_format).toEqual(format);
      expect(body.provider).toEqual({
        require_parameters: true,
        zdr: true,
        data_collection: 'deny',
        order: voiceConfig.VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER.split(',').map((name) =>
          name.trim(),
        ),
        allow_fallbacks: true,
      });
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    it('utilise OPENROUTER_FALLBACK_BASE_URL pour le secours seul, sinon OPENROUTER_BASE_URL', async () => {
      voiceConfig.VOICE_LLM_PROVIDER = 'cerebras';
      voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
      voiceConfig.OPENROUTER_API_KEY = OPENROUTER_TEST_KEY;
      voiceConfig.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
      const fallbackUrl = async (fallbackBase: string | undefined) => {
        voiceConfig.OPENROUTER_FALLBACK_BASE_URL = fallbackBase;
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 402, body: null })
          .mockResolvedValueOnce({ ok: true, status: 200, body: sseBody('{"say":"ok"}') });
        globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
        await CallSessionManager.getInstance().streamStructuredCompletion(
          makeSession(),
          [{ role: 'user', content: 'bonjour' }],
          format,
          { onDelta: () => undefined },
        );
        return (fetchMock.mock.calls[1] as [string, RequestInit])[0];
      };

      expect(await fallbackUrl('https://eu.openrouter.ai/api/v1')).toBe(
        'https://eu.openrouter.ai/api/v1/chat/completions',
      );
      expect(await fallbackUrl(undefined)).toBe('https://openrouter.ai/api/v1/chat/completions');
    });

    it('compte chaque requête par sorte, sa part servie par le cache, et une requête en échec comme interrompue', async () => {
      voiceConfig.VOICE_LLM_PROVIDER = 'cerebras';
      voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
      voiceConfig.OPENROUTER_API_KEY = undefined;
      const usageChunk = `data: ${JSON.stringify({
        choices: [{ delta: { content: '{"say":"ok"}' } }],
        usage: {
          prompt_tokens: 5000,
          completion_tokens: 12,
          prompt_tokens_details: { cached_tokens: 4864 },
        },
      })}\n\ndata: [DONE]\n\n`;
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(usageChunk));
              controller.close();
            },
          }),
        })
        .mockResolvedValueOnce({ ok: false, status: 402, body: null });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
      const session = makeSession();
      const mgr = CallSessionManager.getInstance();
      const messages: ChatMessage[] = [{ role: 'user', content: 'bonjour' }];

      await mgr.streamStructuredCompletion(session, messages, format, {
        kind: 'turn',
        onDelta: () => undefined,
      });
      await expect(
        mgr.streamStructuredCompletion(session, messages, format, {
          kind: 'speculation',
          onDelta: () => undefined,
        }),
      ).rejects.toThrow();

      expect(session.voiceUsage?.llmByKind?.turn).toEqual({
        requests: 1,
        interrupted: 0,
        inputTokens: 5000,
        cachedInputTokens: 4864,
        outputTokens: 12,
      });
      expect(session.voiceUsage?.llmByKind?.speculation).toMatchObject({
        requests: 1,
        interrupted: 1,
        cachedInputTokens: 0,
        outputTokens: 0,
      });
      expect(session.voiceUsage?.llmByKind?.speculation?.inputTokens).toBeGreaterThan(0);
    });

    it('garde l’erreur d’origine sans clé de secours', async () => {
      voiceConfig.VOICE_LLM_PROVIDER = 'cerebras';
      voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
      voiceConfig.OPENROUTER_API_KEY = undefined;
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 402, body: null });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      await expect(
        CallSessionManager.getInstance().streamStructuredCompletion(
          makeSession(),
          [{ role: 'user', content: 'bonjour' }],
          format,
          { onDelta: () => undefined },
        ),
      ).rejects.toThrow('Structured LLM request failed (402)');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it('Cerebras reçoit la requête avec sa clé et un seul message system en tête', async () => {
    voiceConfig.VOICE_LLM_PROVIDER = 'cerebras';
    voiceConfig.CEREBRAS_API_KEY = CEREBRAS_TEST_KEY;
    voiceConfig.VOICE_LLM_MODEL = 'qwen-3.8-27b';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Prompt restaurant' },
      { role: 'system', content: 'Consigne de langue' },
      { role: 'assistant', content: 'Bonjour !' },
      { role: 'user', content: 'Une table demain soir ?' },
    ];
    const { provider } = await callFetchLlmStreaming(mgr, messages, {
      maxTokens: 100,
      temperature: 0.7,
    });

    expect(provider).toBe('cerebras');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(requestHost(url)).toBe('api.cerebras.ai');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CEREBRAS_TEST_KEY}`,
    );
    const body = JSON.parse(String(init.body)) as { model: string; messages: ChatMessage[] };
    expect(body.model).toBe('qwen-3.8-27b');
    expect(body.messages.filter((m) => m.role === 'system')).toHaveLength(1);
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: 'Prompt restaurant\n\nConsigne de langue',
    });
  });

  it('sans clé de secours, une erreur du fournisseur remonte à l’appelant (402)', async () => {
    // Une erreur fournisseur doit remonter à l'appelant, qui dégrade l'appel.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      text: vi.fn().mockResolvedValue('Payment Required'),
      json: vi.fn().mockResolvedValue({}),
      body: null,
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    const { response } = await callFetchLlmStreaming(mgr, messages, opts);
    expect(response.ok).toBe(false);
    expect(response.status).toBe(402);
    // Un seul appel : aucun second provider n'est sollicité sans clé de secours.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.every((u) => requestHost(u) === 'api.cerebras.ai')).toBe(true);
  });

  it('Cerebras expose le chemin streaming et le fournisseur utilisé', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, body: null });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    const { provider } = await callFetchLlmStreaming(mgr, messages, opts);
    expect(provider).toBe('cerebras');
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(requestHost(url)).toBe('api.cerebras.ai');
  });

  it('circuit breaker : court-circuite Cerebras après 3 échecs consécutifs', async () => {
    const fetchMock = mockFetchProviderFail();
    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    for (let i = 0; i < 3; i++) {
      const { response } = await callFetchLlmStreaming(mgr, messages, opts);
      expect(response.ok).toBe(false);
    }

    // 4e appel : le breaker est open, aucune requête ne part.
    fetchMock.mockClear();
    await expect(callFetchLlmStreaming(mgr, messages, opts)).rejects.toThrow(/circuit open/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('circuit breaker : se réinitialise après le cooldown', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchProviderFail();
    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    for (let i = 0; i < 3; i++) {
      await callFetchLlmStreaming(mgr, messages, opts);
    }

    vi.advanceTimersByTime(31_000);

    // Half-open : une requête de sonde repart.
    fetchMock.mockClear();
    await callFetchLlmStreaming(mgr, messages, opts);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('circuit breaker : un échec half-open redémarre le cooldown', async () => {
    vi.useFakeTimers();
    const fetchMock = mockFetchProviderFail();
    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    for (let i = 0; i < 3; i++) {
      await callFetchLlmStreaming(mgr, messages, opts);
    }
    vi.advanceTimersByTime(31_000);

    // Sonde half-open : elle échoue, le cooldown repart pour 30 s.
    await callFetchLlmStreaming(mgr, messages, opts);
    vi.advanceTimersByTime(29_000);

    fetchMock.mockClear();
    await expect(callFetchLlmStreaming(mgr, messages, opts)).rejects.toThrow(/circuit open/);
    expect(fetchMock).toHaveBeenCalledTimes(0);
  });

  it('timeout : abort la requête après VOICE_LLM_TIMEOUT_MS', async () => {
    voiceConfig.VOICE_LLM_TIMEOUT_MS = 100;
    mockFetchHanging();
    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    await expect(callFetchLlmStreaming(mgr, messages, opts)).rejects.toThrow();
  });

  it('erreur réseau : remonte à l’appelant sans repli', async () => {
    const fetchMock = mockFetchProviderNetworkError();
    const mgr = CallSessionManager.getInstance();
    const messages: ChatMessage[] = [{ role: 'user', content: 'test' }];
    const opts: LlmOpts = { maxTokens: 100, temperature: 0.7 };

    await expect(callFetchLlmStreaming(mgr, messages, opts)).rejects.toThrow(/fetch failed/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('mergeSystemMessages', () => {
  it('regroupe les consignes system en tête, dans leur ordre', () => {
    const merged = mergeSystemMessages([
      { role: 'system', content: 'Prompt' },
      { role: 'system', content: 'Langue' },
      { role: 'assistant', content: 'Bonjour !' },
      { role: 'system', content: 'Contexte disponibilité' },
      { role: 'user', content: 'Vendredi 22 h 30' },
    ]);

    expect(merged).toEqual([
      { role: 'system', content: 'Prompt\n\nLangue\n\nContexte disponibilité' },
      { role: 'assistant', content: 'Bonjour !' },
      { role: 'user', content: 'Vendredi 22 h 30' },
    ]);
  });

  it('laisse une conversation sans message system inchangée', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'Bonjour' }];

    expect(mergeSystemMessages(messages)).toEqual(messages);
  });
});
