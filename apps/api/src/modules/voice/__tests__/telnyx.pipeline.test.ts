/**
 * Integration tests for the Telnyx voice webhook pipeline.
 *
 * Covers:
 *  - call.initiated
 *      • happy path: loadContext, checkMarginHealth, isVoicePipelineEnabled,
 *        CustomerService.lookupOrCreate, db.call.create, CallSessionManager.create,
 *        queues.telnyxWebhooks.add
 *      • guard rails: circuit breaker, feature-flag kill switch, restaurant not found,
 *        VIP push
 *  - call.hangup: duration update, incrementVisit only when a reservation was made
 *  - /voice/telnyx/end: upsert with the detected outcome
 *  - default branch: returns { result: 'ignored' }
 *
 * The preHandler (telnyx.guard) is mocked so tests don't have to forge an Ed25519
 * signature. The real guard is unit-tested in telnyx.guard.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

// ── Module mocks (must come before importing the app) ──────────────────────

// Skip the Ed25519 signature guard — it's covered in telnyx.guard.test.ts.
vi.mock('../call-capacity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../call-capacity')>()),
  isAtCallCapacity: vi.fn().mockResolvedValue(false),
  recordVoicePeak: vi.fn(),
}));

vi.mock('../telnyx.guard', () => ({
  telnyxWebhookGuard: vi.fn(async (_req: FastifyRequest, _reply: FastifyReply) => undefined),
}));

vi.mock('../../restaurants/restaurant.service', () => ({
  RestaurantService: {
    loadContext: vi.fn(),
    checkMarginHealth: vi.fn(),
  },
}));

vi.mock('../../customers/customer.service', () => ({
  CustomerService: {
    lookupOrCreate: vi.fn(),
    buildVipPromptExtra: vi.fn(),
    withVoiceProfile: vi.fn((_restaurantId: string, customer: unknown) =>
      Promise.resolve(customer),
    ),
    returningCustomerFirstName: vi.fn(() => 'Jean'),
    recordCallActivity: vi.fn(() => Promise.resolve()),
    incrementVisit: vi.fn(),
  },
}));

vi.mock('../../../shared/configcat', () => ({
  isVoicePipelineEnabled: vi.fn(),
  FLAGS: {
    VOICE_PIPELINE_ENABLED: 'voice_pipeline_enabled',
    SPECULATIVE_LLM: 'speculative_llm',
    RESTAURANT_PLAN: 'restaurant_plan',
  },
}));

vi.mock('../../billing/billing.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../billing/billing.service')>()),
  isBillingSuspended: vi.fn(async () => false),
}));

// Mock telnyxFetch (used for direct answer call instead of BullMQ queue)
vi.mock('../../../shared/telnyx/http-agent', () => ({
  telnyxFetch: vi.fn(
    async () =>
      new Response('{"data":{}}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ),
  warmupTelnyxConnection: vi.fn(async () => undefined),
}));

// ── Imports under test (must come AFTER the vi.mock calls) ─────────────────

import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { queues } from '../../../shared/queue/queues';
import { RestaurantService } from '../../restaurants/restaurant.service';
import { CustomerService } from '../../customers/customer.service';
import { isVoicePipelineEnabled } from '../../../shared/configcat';
import { telnyxFetch } from '../../../shared/telnyx/http-agent';
import { isBillingSuspended } from '../../billing/billing.service';
import { CallSessionManager } from '../stream/manager';

const mockLoadContext = vi.mocked(RestaurantService.loadContext);
const mockCheckMarginHealth = vi.mocked(RestaurantService.checkMarginHealth);
const mockLookupOrCreate = vi.mocked(CustomerService.lookupOrCreate);
const mockBuildVipPromptExtra = vi.mocked(CustomerService.buildVipPromptExtra);
const mockIncrementVisit = vi.mocked(CustomerService.incrementVisit);
const mockIsVoicePipelineEnabled = vi.mocked(isVoicePipelineEnabled);
const mockTelnyxFetch = vi.mocked(telnyxFetch);
const mockIsBillingSuspended = vi.mocked(isBillingSuspended);

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRestaurantCtx(
  overrides: Partial<{
    id: string;
    name: string;
    openingHours: unknown;
    personality: unknown;
    onlineReservationsActive: boolean;
  }> = {},
): Awaited<ReturnType<typeof RestaurantService.loadContext>> {
  return {
    id: 'rest-1',
    name: 'Le Bistrot',
    openingHours: { mon: { open: '12:00', close: '14:30' } },
    personality: null,
    onlineReservationsActive: false,
    ...overrides,
  } as unknown as Awaited<ReturnType<typeof RestaurantService.loadContext>>;
}

function makeInitiatedPayload(
  overrides: Partial<{
    call_control_id: string;
    call_leg_id: string;
    from: string;
    to: string;
  }> = {},
) {
  return {
    data: {
      event_type: 'call.initiated',
      payload: {
        call_control_id: 'cc-1',
        call_leg_id: 'leg-1',
        from: '+33****0001',
        to: '+33****0000',
        direction: 'incoming',
        ...overrides,
      },
    },
  };
}

function makeHangupPayload(
  overrides: Partial<{
    call_control_id: string;
    call_leg_id: string;
    from: string;
    to: string;
    duration_sec: number;
  }> = {},
) {
  return {
    data: {
      event_type: 'call.hangup',
      payload: {
        call_control_id: 'cc-1',
        call_leg_id: 'leg-1',
        from: '+33****0001',
        to: '+33****0000',
        direction: 'incoming',
        duration_sec: 42,
        ...overrides,
      },
    },
  };
}

function makeEndPayload(overrides: Record<string, unknown> = {}) {
  return {
    call_leg_id: 'leg-end-1',
    transcript: null,
    ended_reason: null,
    started_at: null,
    ended_at: null,
    stt_provider: null,
    llm_provider: null,
    tts_provider: null,
    from: '+33****0001',
    to: '+33****0000',
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

import { isAtCallCapacity } from '../call-capacity';

describe('POST /voice/telnyx — call.initiated', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.VIP_PUSH_ENABLED;
    // Each test gets a fresh CallSessionManager singleton
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  const knownCaller = {
    id: 'cust-1',
    name: 'Jean',
    isVip: false,
    specialOccasion: null,
    notes: null,
    lastCallAt: null,
    partySizeTypical: null,
  };

  it('tout restaurant : profil CRM chargé et contexte client', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue(knownCaller);
    mockBuildVipPromptExtra.mockReturnValue('');

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(CustomerService.withVoiceProfile).toHaveBeenCalledWith('rest-1', knownCaller);
    expect(mockBuildVipPromptExtra).toHaveBeenCalled();
    expect(CustomerService.returningCustomerFirstName).toHaveBeenCalled();
  });

  it('happy path: pre-creates the session and enqueues the answer job', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx({ onlineReservationsActive: true }));
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue({
      id: 'cust-1',
      name: 'Jean',
      isVip: false,
      specialOccasion: null,
      notes: null,
      lastCallAt: null,
      partySizeTypical: null,
    });
    mockBuildVipPromptExtra.mockReturnValue('');

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });

    expect(mockLoadContext).toHaveBeenCalledWith('+33****0000');
    expect(mockCheckMarginHealth).toHaveBeenCalledWith('rest-1');
    expect(mockIsVoicePipelineEnabled).toHaveBeenCalledWith('rest-1');
    expect(mockLookupOrCreate).toHaveBeenCalledWith('rest-1', '+33****0001');

    expect(db.call.create).toHaveBeenCalledWith({
      data: {
        callSid: 'leg-1',
        restaurantId: 'rest-1',
        carrier: 'telnyx',
        // Le numéro d'appelant est persisté dès l'init : le rattrapage des
        // appels incomplets en a besoin pour la récupération commerciale.
        callerPhone: '+33****0001',
      },
    });

    // Session was pre-created so the WS start event can find it.
    const mgr = CallSessionManager.getInstance();
    const session = mgr.get('cc-1');
    expect(session).toBeDefined();
    expect(session!.restaurantId).toBe('rest-1');
    expect(session!.callLegId).toBe('leg-1');
    expect(session!.state).toBe('IDLE');
    expect(session!.codec).toBe('PCMA');
    expect(session!.isVip).toBe(false);
    expect(session!.onlineReservationsActive).toBe(true);

    // Answer call was made directly via telnyxFetch (not enqueued to BullMQ)
    expect(mockTelnyxFetch).toHaveBeenCalledWith(
      '/v2/calls/cc-1/actions/answer',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': expect.any(String),
        }),
        body: expect.stringContaining('wss://'),
      }),
    );
  });

  it('rejoue la réponse via la queue quand Telnyx renvoie une erreur HTTP', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockBuildVipPromptExtra.mockReturnValue('');
    mockTelnyxFetch.mockResolvedValueOnce(
      new Response('{"error":"provider down"}', { status: 503 }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(queues.telnyxWebhooks.add).toHaveBeenCalledWith(
        'answer-call',
        expect.objectContaining({
          callControlId: 'cc-1',
          callLegId: 'leg-1',
          codec: 'PCMA',
          streamUrl: expect.stringContaining('wss://'),
          idempotencyKey: expect.any(String),
        }),
        expect.objectContaining({ jobId: expect.any(String) }),
      );
    });
  });

  it('rejoue la réponse via la queue après une erreur réseau Telnyx', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockBuildVipPromptExtra.mockReturnValue('');
    mockTelnyxFetch.mockRejectedValueOnce(new Error('connect ETIMEDOUT'));

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(queues.telnyxWebhooks.add).toHaveBeenCalledWith(
        'answer-call',
        expect.objectContaining({ callControlId: 'cc-1', callLegId: 'leg-1' }),
        expect.objectContaining({ jobId: expect.any(String) }),
      );
    });
  });

  it('renvoie une erreur si le décrochage et son secours échouent tous les deux', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockTelnyxFetch.mockRejectedValueOnce(new Error('network unavailable'));
    vi.mocked(queues.telnyxWebhooks.add).mockRejectedValueOnce(new Error('queue unavailable'));
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });
    expect(res.statusCode).toBe(500);
  });

  it('demande un rejeu si la recherche du restaurant échoue temporairement', async () => {
    mockLoadContext.mockRejectedValueOnce(new Error('database unavailable'));
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });
    expect(res.statusCode).toBe(500);
  });

  it('conserve la session active lorsque Telnyx répète le début de l’appel', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    const first = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });
    expect(first.statusCode).toBe(200);
    const original = CallSessionManager.getInstance().get('cc-1')!;
    original.transcript = 'conversation en cours';
    vi.mocked(db.call.create).mockRejectedValueOnce(
      Object.assign(new Error('duplicate'), { code: 'P2002' }),
    );
    vi.mocked(db.call.findFirst).mockResolvedValueOnce({
      outcome: null,
      durationSec: null,
    } as never);
    const replay = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });
    expect(replay.statusCode).toBe(200);
    expect(vi.mocked(db.call.findFirst)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callSid: 'leg-1', restaurantId: 'rest-1' } }),
    );
    expect(CallSessionManager.getInstance().get('cc-1')).toBe(original);
    expect(original.transcript).toBe('conversation en cours');
  });

  it('réutilise une seule session pour deux notifications simultanées', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    const manager = CallSessionManager.getInstance();
    const create = vi.spyOn(manager, 'create');

    const replies = await Promise.all(
      [1, 2].map(() =>
        app.inject({ method: 'POST', url: '/voice/telnyx', payload: makeInitiatedPayload() }),
      ),
    );

    expect(replies.map((reply) => reply.statusCode)).toEqual([200, 200]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(manager.get('cc-1')).toBeDefined();
    create.mockRestore();
  });

  it('returns 200 and does nothing when loadContext throws (unknown phone number)', async () => {
    mockLoadContext.mockRejectedValue(
      Object.assign(new Error('Restaurant not found'), { code: 'P2025' }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload({ to: '+33****9999' }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
    expect(mockCheckMarginHealth).not.toHaveBeenCalled();
    expect(queues.telnyxWebhooks.add).not.toHaveBeenCalled();
    expect(CallSessionManager.getInstance().get('cc-1')).toBeUndefined();
  });

  it('drops the call when margin health (circuit breaker) is unsafe', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
    // With Promise.all, lookupOrCreate runs in parallel with checkMarginHealth.
    // The guard still prevents session creation and answer call.
    expect(mockTelnyxFetch).not.toHaveBeenCalled();
    expect(CallSessionManager.getInstance().get('cc-1')).toBeUndefined();
  });

  it('drops the call when the voice pipeline feature flag is off (kill switch)', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
    // With Promise.all, lookupOrCreate runs in parallel with isVoicePipelineEnabled.
    // The guard still prevents session creation and answer call.
    expect(mockTelnyxFetch).not.toHaveBeenCalled();
    expect(CallSessionManager.getInstance().get('cc-1')).toBeUndefined();
  });

  it('plays a short message instead of a voice session when the subscription has ended', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockIsBillingSuspended.mockResolvedValueOnce(true);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
    expect(mockIsBillingSuspended).toHaveBeenCalledWith('rest-1');
    expect(mockTelnyxFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockTelnyxFetch.mock.calls[0] as [string, { body: string }];
    expect(path).toBe('/v2/calls/cc-1/actions/answer');
    const state = JSON.parse(
      Buffer.from(JSON.parse(init.body).client_state, 'base64').toString('utf8'),
    );
    expect(state).toEqual({ kind: 'billing_suspended_call', name: 'Le Bistrot' });
    expect(CallSessionManager.getInstance().get('cc-1')).toBeUndefined();
  });

  it('plays a busy message instead of a voice session when the call capacity is reached', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    vi.mocked(isAtCallCapacity).mockResolvedValueOnce(true);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockTelnyxFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockTelnyxFetch.mock.calls[0] as [string, { body: string }];
    expect(path).toBe('/v2/calls/cc-1/actions/answer');
    const state = JSON.parse(
      Buffer.from(JSON.parse(init.body).client_state, 'base64').toString('utf8'),
    );
    expect(state).toEqual({ kind: 'billing_suspended_call', name: 'Le Bistrot', busy: true });
    expect(CallSessionManager.getInstance().get('cc-1')).toBeUndefined();
  });

  it('sends a VIP push notification when the caller is VIP and VIP_PUSH_ENABLED=true', async () => {
    process.env.VIP_PUSH_ENABLED = 'true';
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue({
      id: 'cust-vip',
      name: 'Mme Dupont',
      isVip: true,
      specialOccasion: null,
      notes: null,
      lastCallAt: null,
      partySizeTypical: null,
    });
    mockBuildVipPromptExtra.mockReturnValue('⭐ VIP — Mme Dupont, 12 visites.');

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(queues.smsManager.add).toHaveBeenCalledWith(
      'vip-alert',
      expect.objectContaining({
        restaurantId: 'rest-1',
        message: '⭐ VIP en ligne : Mme Dupont — appel entrant',
      }),
      { jobId: expect.any(String) },
    );
  });

  it('does NOT send a VIP push when VIP_PUSH_ENABLED is unset (default off)', async () => {
    // process.env.VIP_PUSH_ENABLED is deleted in beforeEach
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue({
      id: 'cust-vip',
      name: 'Mme Dupont',
      isVip: true,
      specialOccasion: null,
      notes: null,
      lastCallAt: null,
      partySizeTypical: null,
    });
    mockBuildVipPromptExtra.mockReturnValue('');

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(queues.smsManager.add).not.toHaveBeenCalled();
  });

  it('handles missing caller (payload.from absent) without throwing', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockBuildVipPromptExtra.mockReturnValue('');

    const payload = makeInitiatedPayload();
    delete (payload.data.payload as Record<string, unknown>).from;

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(mockLookupOrCreate).not.toHaveBeenCalled();
    const session = CallSessionManager.getInstance().get('cc-1');
    expect(session).toBeDefined();
    expect(session!.isVip).toBe(false);
  });

  it('swallows Prisma P2002 (duplicate call record) silently on retry', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue({
      id: 'cust-1',
      name: null,
      isVip: false,
      specialOccasion: null,
      notes: null,
      lastCallAt: null,
      partySizeTypical: null,
    });
    mockBuildVipPromptExtra.mockReturnValue('');

    const dupError = new Error('Unique constraint failed') as Error & { code: string };
    dupError.code = 'P2002';
    vi.mocked(db.call.create).mockRejectedValueOnce(dupError);
    vi.mocked(db.call.findFirst).mockResolvedValueOnce(undefined as never);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    // The .catch() on db.call.create must swallow P2002.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
  });
});

describe('POST /voice/telnyx — call.hangup', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('updates the call duration in seconds (rounded)', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({ reservation: null } as unknown as Awaited<
      ReturnType<typeof db.call.findUnique>
    >);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload({ duration_sec: 42.7 }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ok' });
    expect(db.call.update).toHaveBeenCalledWith({
      where: { callSid: 'leg-1' },
      data: { durationSec: 43 },
    });
  });

  it('records final telephony usage once the call can be attributed', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({
      id: 'call-1',
      restaurantId: 'rest-1',
      restaurant: { accountId: 'account-1' },
      reservation: null,
    } as never);
    vi.mocked(db.usageEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.usageEvent.create).mockResolvedValue({ id: 'usage-1' } as never);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload({ duration_sec: 42.7 }),
    });

    expect(res.statusCode).toBe(200);
    expect(db.usageEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: 'rest-1',
        accountId: 'account-1',
        category: 'TELEPHONY_SECONDS',
        provider: 'telnyx',
        sourceEventKey: 'telnyx:call:leg-1:final',
      }),
    });
  });

  it('enqueues recording recovery when a test recording remains pending at hangup', async () => {
    process.env.CALL_RECORDING_ENABLED = 'true';
    vi.mocked(db.call.findUnique).mockResolvedValue({
      reservation: null,
      recordingStatus: 'PENDING',
    } as unknown as Awaited<ReturnType<typeof db.call.findUnique>>);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(queues.telnyxWebhooks.add).toHaveBeenCalledWith(
      'recover-recording',
      { callLegId: 'leg-1' },
      expect.objectContaining({ attempts: 5, delay: 30_000 }),
    );
    delete process.env.CALL_RECORDING_ENABLED;
  });

  it('finalise le hangup sans inventer de durée quand duration_sec manque', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({ reservation: null } as unknown as Awaited<
      ReturnType<typeof db.call.findUnique>
    >);
    const payload = makeHangupPayload();
    delete (payload.data.payload as Record<string, unknown>).duration_sec;

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload,
    });

    expect(res.statusCode).toBe(200);
    // Aucune durée inventée...
    expect(db.call.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ durationSec: expect.anything() }),
      }),
    );
    // ...mais l'appel est bien finalisé : le hangup seul suffit désormais.
    expect(db.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callSid: 'leg-1' },
        data: expect.objectContaining({ outcome: 'NO_ACTION' }),
      }),
    );
  });

  it('increments the customer visit count when the call produced a reservation', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({
      reservation: { id: 'res-1' },
    } as unknown as Awaited<ReturnType<typeof db.call.findUnique>>);
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockLoadContext).toHaveBeenCalledWith('+33****0000');
    expect(mockIncrementVisit).toHaveBeenCalledWith('rest-1', '+33****0001', {
      reservationId: 'res-1',
      occurredAt: expect.any(Date),
    });
  });

  it('does NOT increment visits when the call had no reservation', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({ reservation: null } as unknown as Awaited<
      ReturnType<typeof db.call.findUnique>
    >);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(mockIncrementVisit).not.toHaveBeenCalled();
  });
});

describe('POST /voice/telnyx — unhandled event types', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('returns { result: "ignored" } for unknown event types (no side effects)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: {
        data: {
          event_type: 'call.something.weird',
          payload: {
            call_control_id: 'cc-x',
            call_leg_id: 'leg-x',
            from: '+33****0001',
            to: '+33****0000',
            direction: 'incoming',
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'ignored' });
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(queues.telnyxWebhooks.add).not.toHaveBeenCalled();
  });
});

describe('POST /voice/telnyx — call.recording.saved', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.CALL_RECORDING_ENABLED = 'true';
    app = await getApp();
  });

  afterAll(async () => {
    delete process.env.CALL_RECORDING_ENABLED;
    await closeApp();
  });

  it('enqueues immediate private storage of the MP3', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: {
        data: {
          event_type: 'call.recording.saved',
          payload: {
            call_control_id: 'cc-1',
            call_leg_id: 'leg-1',
            from: '+33****0001',
            to: '+33****0000',
            direction: 'incoming',
            recording_id: 'rec-1',
            recording_urls: { mp3: 'https://recordings.telnyx.com/signed.mp3' },
            recording_started_at: '2026-07-22T10:00:00.000Z',
            recording_ended_at: '2026-07-22T10:01:00.000Z',
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(queues.telnyxWebhooks.add).toHaveBeenCalledWith(
      'store-recording',
      expect.objectContaining({
        callLegId: 'leg-1',
        recordingId: 'rec-1',
        downloadUrl: 'https://recordings.telnyx.com/signed.mp3',
        startedAt: '2026-07-22T10:00:00.000Z',
        endedAt: '2026-07-22T10:01:00.000Z',
      }),
      { jobId: expect.any(String) },
    );
  });
});

// ─── /voice/telnyx/end — restaurantId resolution regression suite ──────────
//
// Background: the guard (telnyxWebhookGuard) only verifies the Ed25519
// signature; it does NOT populate `req.restaurantId`. Pre-fix, the /end route
// used `req.restaurantId ?? ''` as the fallback in db.call.upsert({create}),
// which silently created orphan Call rows (Prisma FK violation, masked by the
// upsert error path). The fix resolves restaurantId from (1) an authMiddleware
// attribute, then (2) RestaurantService.loadContext(req.body.to), and refuses
// with 400 if neither is available.

describe('POST /voice/telnyx/end — restaurantId resolution', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('resolves restaurantId via loadContext(to) when req.restaurantId is unset', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    vi.mocked(db.call.findUnique).mockResolvedValue(null);
    vi.mocked(db.call.create).mockResolvedValue({ id: 'call-1' } as unknown as Awaited<
      ReturnType<typeof db.call.create>
    >);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: makeEndPayload(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(mockLoadContext).toHaveBeenCalledWith('+33****0000');
    expect(db.call.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          callSid: 'leg-end-1',
          restaurantId: 'rest-1',
        }),
      }),
    );
  });

  it('returns 400 when neither req.restaurantId nor `to` can resolve a restaurant', async () => {
    // No `to` in payload, no req.restaurantId
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: { call_leg_id: 'leg-orphan' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'restaurantId is required' });
    expect(db.call.create).not.toHaveBeenCalled();
  });

  it('returns 400 when `to` is present but loadContext cannot find a restaurant', async () => {
    mockLoadContext.mockRejectedValue(new Error('Restaurant not found'));

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: makeEndPayload({ to: '+33****9999' }),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'restaurantId is required' });
    expect(db.call.create).not.toHaveBeenCalled();
  });
});

// ─── /voice/telnyx — call.initiated — non-P2002 Prisma errors must throw ──
//
// Background: pre-fix, the .catch on db.call.create logged non-P2002 errors
// and then silently continued, leaving the system in a DB-inconsistent state
// (call record missing, session created, answer job enqueued, audio flowing).
// The fix narrows the catch to P2002 only and re-throws everything else so
// Fastify returns 500 and the webhook is retried by Telnyx.

describe('POST /voice/telnyx — call.initiated — non-P2002 Prisma error handling', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('rethrows a non-P2002 Prisma error from db.call.create (returns 500)', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    mockCheckMarginHealth.mockResolvedValue(true);
    mockIsVoicePipelineEnabled.mockResolvedValue(true);
    mockLookupOrCreate.mockResolvedValue({
      id: 'cust-1',
      name: null,
      isVip: false,
      specialOccasion: null,
      notes: null,
      lastCallAt: null,
      partySizeTypical: null,
    });
    mockBuildVipPromptExtra.mockReturnValue('');

    const fkError = new Error('Foreign key constraint failed') as Error & { code: string };
    fkError.code = 'P2003';
    vi.mocked(db.call.create).mockRejectedValueOnce(fkError);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeInitiatedPayload(),
    });

    // P2003 is not a benign race — the row genuinely failed to write.
    // The handler must surface the failure (5xx) so the webhook is retried.
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // Session must NOT have been pre-created: we abort before any side effects.
    const session = CallSessionManager.getInstance().get('cc-1');
    expect(session).toBeUndefined();
    expect(queues.telnyxWebhooks.add).not.toHaveBeenCalled();
  });
});

// ─── Finalisation commune : un appel terminé doit produire un résultat ────
//
// `call.hangup` et `/voice/telnyx/end` peuvent arriver dans n'importe quel
// ordre, en double, ou pas du tout. Les deux chemins convergent vers la même
// finalisation, qui ne régresse jamais et n'efface jamais une donnée complète.

describe('finalisation commune des appels — ordre, doublons et pannes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    (CallSessionManager as unknown as { instance: CallSessionManager }).instance =
      new CallSessionManager();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  const finalizedCall = {
    id: 'call-1',
    restaurantId: 'rest-1',
    callSid: 'leg-end-1',
    durationSec: 61,
    transcript: 'Bonjour je voudrais réserver pour quatre personnes',
    intent: 'RESERVATION',
    outcome: 'NO_ACTION',
    sttProvider: 'deepgram-nova-3',
    llmProvider: 'cerebras',
    ttsProvider: 'cartesia-sonic',
    reservation: null,
    messages: [],
  };

  it('un /end tardif et vide n’efface ni la transcription ni l’outcome', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    vi.mocked(db.call.findUnique).mockResolvedValue(
      finalizedCall as unknown as Awaited<ReturnType<typeof db.call.findUnique>>,
    );

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: makeEndPayload({ transcript: null, started_at: null, ended_at: null }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    // Rien à écrire : le hangup avait déjà posé des valeurs plus complètes.
    expect(db.call.update).not.toHaveBeenCalled();
  });

  it('un /end tardif ne dégrade pas une réservation déjà enregistrée', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    vi.mocked(db.call.findUnique).mockResolvedValue({
      ...finalizedCall,
      outcome: 'RESERVED',
      reservation: { id: 'res-1' },
    } as unknown as Awaited<ReturnType<typeof db.call.findUnique>>);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: makeEndPayload({ transcript: 'Bonjour' }),
    });

    expect(res.statusCode).toBe(200);
    expect(db.call.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'NO_ACTION' }),
      }),
    );
  });

  it('le hangup finalise l’appel même sans session en mémoire', async () => {
    vi.mocked(db.call.findUnique).mockResolvedValue({
      ...finalizedCall,
      outcome: null,
      transcript: null,
      intent: null,
      durationSec: null,
      sttProvider: null,
      llmProvider: null,
      ttsProvider: null,
    } as unknown as Awaited<ReturnType<typeof db.call.findUnique>>);

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: makeHangupPayload({ duration_sec: 61 }),
    });

    expect(res.statusCode).toBe(200);
    expect(db.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callSid: 'leg-1' },
        data: expect.objectContaining({
          outcome: 'NO_ACTION',
          sttProvider: 'deepgram-nova-3',
        }),
      }),
    );
  });

  it('répond 503 et laisse le rattrapage reprendre quand la base tombe', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    vi.mocked(db.call.findUnique).mockRejectedValue(new Error('Connection lost'));

    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx/end',
      payload: makeEndPayload(),
    });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'finalization_unavailable' });
  });

  it('n’envoie qu’une seule récupération pour un même appel rejoué', async () => {
    mockLoadContext.mockResolvedValue(makeRestaurantCtx());
    vi.mocked(db.call.findUnique).mockResolvedValue(null);
    vi.mocked(db.call.create).mockResolvedValue({ id: 'call-1' } as unknown as Awaited<
      ReturnType<typeof db.call.create>
    >);
    const payload = makeEndPayload({
      transcript: 'Je voudrais réserver une table demain soir',
    });

    await app.inject({ method: 'POST', url: '/voice/telnyx/end', payload });
    await app.inject({ method: 'POST', url: '/voice/telnyx/end', payload });

    expect(queues.callRecovery.add).toHaveBeenCalledTimes(2);
    const jobIds = vi
      .mocked(queues.callRecovery.add)
      .mock.calls.map((call) => (call[2] as { jobId: string }).jobId);
    expect(new Set(jobIds).size).toBe(1);
  });
});

describe('POST /voice/telnyx — appel de test sortant du provisioning', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await getApp();
  });

  afterAll(async () => {
    await closeApp();
  });

  const testCallState = Buffer.from(
    JSON.stringify({ kind: 'onboarding_test_call', restaurantId: 'rest-1' }),
  ).toString('base64');

  function testCallEvent(eventType: string) {
    return {
      data: {
        event_type: eventType,
        payload: {
          call_control_id: 'v3:test-call',
          client_state: testCallState,
          to: '+33612345678',
          from: '+33100000000',
        },
      },
    };
  }

  it('ne cherche pas de restaurant par le numéro du gérant et fait entendre le message au décroché', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: testCallEvent('call.answered'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'spoken' });
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(mockTelnyxFetch).toHaveBeenCalledWith(
      '/v2/calls/v3%3Atest-call/actions/speak',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('raccroche une fois le message lu', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/voice/telnyx',
      payload: testCallEvent('call.speak.ended'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ result: 'hung_up' });
    expect(mockLoadContext).not.toHaveBeenCalled();
    expect(mockTelnyxFetch).toHaveBeenCalledWith(
      '/v2/calls/v3%3Atest-call/actions/hangup',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
