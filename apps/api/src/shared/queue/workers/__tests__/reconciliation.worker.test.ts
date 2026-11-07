import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../../redis/client', () => ({
  redisQueue: {
    url: 'redis://localhost:6379',
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('../../../db/client', () => ({ db: {} }));
vi.mock('../../../../modules/voice/stream/greeting-cache', () => ({
  initGreetingCache: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../email', () => ({ lookupResendEmail: vi.fn() }));
vi.mock('../../../telnyx/client', () => ({ lookupTelnyxMessage: vi.fn() }));
vi.mock('../../queues', () => ({
  queues: {
    deadLetter: { add: vi.fn().mockResolvedValue(undefined) },
    reconciliation: { add: vi.fn().mockResolvedValue(undefined) },
  },
}));
vi.mock('../helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { initGreetingCache } from '../../../../modules/voice/stream/greeting-cache';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  getNotificationClaim,
  NOTIFICATION_CLAIM_LEASE_SECONDS,
  recordNotificationResult,
  type NotificationClaimStore,
  type NotificationReconciliationJobData,
} from '../../notification-idempotency';
import {
  processReconciliationJob,
  type ReconciliationJobData,
  type ReconciliationDependencies,
} from '../reconciliation.worker';

function makeClaimStore() {
  const values = new Map<string, string>();
  const scan = vi.fn(async (cursor: string) => {
    return ['0', cursor === '0' ? [...values.keys()] : []] as [string, string[]];
  });
  const store: NotificationClaimStore = {
    async set(key, value, _expirationMode, _expirationSeconds, existenceMode) {
      if (existenceMode === 'NX' && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async del(key) {
      values.delete(key);
      return 1;
    },
    async eval(script, _numberOfKeys, key, token, ...args) {
      const raw = values.get(key);
      if (!raw) return 0;
      const current = JSON.parse(raw) as { token?: string; status?: string };
      if (current.token !== token) return 0;
      const guardedByStatus = script.includes('local status =');
      const expectedStatus = guardedByStatus ? args[0] : undefined;
      const nextValue = guardedByStatus ? args[1] : args[0];
      if (guardedByStatus && current.status !== expectedStatus) return 0;
      if (nextValue === '__DELETE__') values.delete(key);
      else values.set(key, nextValue);
      return 1;
    },
    scan: scan as unknown as NonNullable<NotificationClaimStore['scan']>,
  };
  return { store, values, scan };
}

function makeQueue() {
  const acceptedJobIds = new Set<string>();
  const jobs: Array<{ name: string; data: unknown; jobId: string }> = [];
  const queue = {
    add: vi.fn(async (name: string, data: unknown, options: { jobId: string }) => {
      if (!acceptedJobIds.has(options.jobId)) {
        acceptedJobIds.add(options.jobId);
        jobs.push({ name, data, jobId: options.jobId });
      }
    }),
  };
  return { queue, jobs };
}

function makeJob(
  overrides: Partial<Omit<NotificationReconciliationJobData, 'kind' | 'claimKey'>> & {
    claimKey?: string;
  } = {},
): Job<NotificationReconciliationJobData> {
  return {
    id: 'notification-reconciliation-job',
    name: 'notification-status',
    data: {
      kind: 'notification',
      claimKey: overrides.claimKey ?? buildNotificationClaimKey('reminder', 'res-1'),
      provider: overrides.provider ?? 'telnyx',
      channel: overrides.channel ?? 'sms',
      ...(overrides.providerMessageId ? { providerMessageId: overrides.providerMessageId } : {}),
    },
  } as unknown as Job<NotificationReconciliationJobData>;
}

async function makeUnknownClaim(
  store: NotificationClaimStore,
  key: string,
  providerMessageId?: string,
) {
  const attempt = await acquireNotificationClaim(store, key, {
    provider: 'telnyx',
    channel: 'sms',
  });
  await recordNotificationResult(store, key, attempt.token!, 'unknown', {
    provider: 'telnyx',
    channel: 'sms',
    ...(providerMessageId ? { providerMessageId } : {}),
  });
}

function makeDependencies(
  store: NotificationClaimStore,
  lookupProviderMessage: ReconciliationDependencies['lookupProviderMessage'],
  deadLetterQueue: ReconciliationDependencies['deadLetterQueue'],
  options: {
    reconciliationQueue?: ReconciliationDependencies['reconciliationQueue'];
    repairNotification?: ReconciliationDependencies['repairNotification'];
  } = {},
): ReconciliationDependencies {
  return {
    db: {} as PrismaClient,
    claimStore: store,
    lookupProviderMessage,
    deadLetterQueue,
    ...(options.reconciliationQueue ? { reconciliationQueue: options.reconciliationQueue } : {}),
    repairNotification: options.repairNotification ?? vi.fn().mockResolvedValue('not_required'),
  };
}

describe('reconciliation.worker notification outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marque un succès provider réconcilié sans envoyer ni ouvrir la DLQ', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-success');
    await makeUnknownClaim(store, key, 'msg-success');
    const lookupProviderMessage = vi.fn().mockResolvedValue('success');
    const { queue: deadLetterQueue, jobs } = makeQueue();

    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-success' }),
      makeDependencies(store, lookupProviderMessage, deadLetterQueue),
    );

    expect(lookupProviderMessage).toHaveBeenCalledWith({
      provider: 'telnyx',
      channel: 'sms',
      providerMessageId: 'msg-success',
    });
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'success' });
    expect(jobs).toHaveLength(0);
  });

  it('libère la claim uniquement après une preuve d’échec certain', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-failed');
    await makeUnknownClaim(store, key, 'msg-failed');
    const lookupProviderMessage = vi.fn().mockResolvedValue('failure_certain');
    const { queue: deadLetterQueue, jobs } = makeQueue();

    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-failed' }),
      makeDependencies(store, lookupProviderMessage, deadLetterQueue),
    );

    expect(await getNotificationClaim(store, key)).toBeNull();
    expect(jobs).toHaveLength(0);
  });

  it('conserve unknown et crée une seule revue manuelle déterministe', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-unknown');
    await makeUnknownClaim(store, key, 'msg-unknown');
    const lookupProviderMessage = vi.fn().mockResolvedValue('unknown');
    const { queue: deadLetterQueue, jobs } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue);

    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-unknown' }),
      deps,
    );
    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-unknown' }),
      deps,
    );

    expect(lookupProviderMessage).toHaveBeenCalledTimes(2);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'notification-reconciliation-manual' });
  });

  it('envoie sans consultation les claims sans identifiant vers la revue manuelle', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-no-id');
    await makeUnknownClaim(store, key);
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue, jobs } = makeQueue();

    await processReconciliationJob(
      makeJob({ claimKey: key }),
      makeDependencies(store, lookupProviderMessage, deadLetterQueue),
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
  });

  it('ne consulte ni ne renvoie un provider pour une claim encore en cours', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-in-progress');
    await acquireNotificationClaim(store, key, { provider: 'telnyx', channel: 'sms' });
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue, jobs } = makeQueue();

    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-in-progress' }),
      makeDependencies(store, lookupProviderMessage, deadLetterQueue),
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'in_progress' });
  });

  it('accorde un seul lease lors de deux réconciliations concurrentes', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-concurrent');
    await makeUnknownClaim(store, key, 'msg-concurrent');
    const lookupProviderMessage = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'success' as const;
    });
    const { queue: deadLetterQueue } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue);

    await Promise.all([
      processReconciliationJob(
        makeJob({ claimKey: key, providerMessageId: 'msg-concurrent' }),
        deps,
      ),
      processReconciliationJob(
        makeJob({ claimKey: key, providerMessageId: 'msg-concurrent' }),
        deps,
      ),
    ]);

    expect(lookupProviderMessage).toHaveBeenCalledTimes(1);
    expect(deps.repairNotification).toHaveBeenCalledTimes(1);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'success' });
  });

  it('récupère une claim in_progress orpheline sans rappeler le provider', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-orphan');
    const attempt = await acquireNotificationClaim(store, key, {
      provider: 'telnyx',
      channel: 'sms',
    });
    const record = JSON.parse(values.get(key)!) as Record<string, unknown>;
    record.updatedAt = new Date(
      Date.now() - NOTIFICATION_CLAIM_LEASE_SECONDS * 1000 - 1,
    ).toISOString();
    values.set(key, JSON.stringify(record));
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue } = makeQueue();
    const { queue: reconciliationQueue, jobs } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue,
    });

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(attempt.token).toBeTruthy();
    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'notification-status' });
  });

  it('simule un arrêt brutal après le provider puis reprend sans second envoi', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-crash');
    const sendProvider = vi.fn().mockResolvedValue({ id: 'msg-crash' });
    const attempt = await acquireNotificationClaim(store, key, {
      provider: 'telnyx',
      channel: 'sms',
    });

    await sendProvider();
    // Crash simulé : l'appel provider a répondu, mais recordNotificationResult
    // n'a pas encore pu exécuter la transition Redis.
    const record = JSON.parse(values.get(key)!) as Record<string, unknown>;
    record.providerMessageId = 'msg-crash';
    record.updatedAt = new Date(
      Date.now() - NOTIFICATION_CLAIM_LEASE_SECONDS * 1000 - 1,
    ).toISOString();
    values.set(key, JSON.stringify(record));

    const lookupProviderMessage = vi.fn().mockResolvedValue('success');
    const { queue: deadLetterQueue } = makeQueue();
    const { queue: reconciliationQueue, jobs } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue,
    });

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation-crash',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );
    await processReconciliationJob(
      {
        id: 'recovered-notification',
        name: 'notification-status',
        data: jobs[0].data,
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(attempt.token).toBeTruthy();
    expect(sendProvider).toHaveBeenCalledTimes(1);
    expect(lookupProviderMessage).toHaveBeenCalledTimes(1);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'success' });
  });

  it('ne touche pas une claim active pendant le balayage', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-active-sweep');
    await acquireNotificationClaim(store, key, {
      provider: 'telnyx',
      channel: 'sms',
    });
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue } = makeQueue();
    const { queue: reconciliationQueue, jobs } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue,
    });

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation-active',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'in_progress' });
  });

  it('répare la trace d’une confirmation acceptée sans appeler le fournisseur', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-email', 'res-1');
    const claim = await acquireNotificationClaim(store, key, {
      provider: 'resend',
      channel: 'email',
    });
    await recordNotificationResult(store, key, claim.token!, 'success', {
      provider: 'resend',
      channel: 'email',
    });
    const record = JSON.parse(values.get(key)!);
    record.updatedAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    values.set(key, JSON.stringify(record));
    const repairNotification = vi.fn().mockResolvedValue('repaired');
    const lookup = vi.fn();
    const { queue } = makeQueue();
    await processReconciliationJob(
      { id: 'sweep', name: 'sms', data: { kind: 'sms' } } as unknown as Job<ReconciliationJobData>,
      makeDependencies(store, lookup, queue, { repairNotification }),
    );
    expect(repairNotification).toHaveBeenCalledWith(key, expect.any(Date));
    expect(lookup).not.toHaveBeenCalled();
  });

  it('conserve unknown si la queue de réconciliation est indisponible', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-queue-down');
    await acquireNotificationClaim(store, key, {
      provider: 'telnyx',
      channel: 'sms',
    });
    const record = JSON.parse(values.get(key)!) as Record<string, unknown>;
    record.updatedAt = new Date(
      Date.now() - NOTIFICATION_CLAIM_LEASE_SECONDS * 1000 - 1,
    ).toISOString();
    values.set(key, JSON.stringify(record));
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue);

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation-queue-down',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
  });

  it('n’envoie rien si le balayage Redis devient indisponible', async () => {
    const { store, scan } = makeClaimStore();
    scan.mockRejectedValueOnce(new Error('Redis unavailable'));
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue, jobs } = makeQueue();
    const { queue: reconciliationQueue } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue,
    });

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation-redis-down',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(reconciliationQueue.add).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(0);
  });

  it('envoie une claim legacy sans token vers la revue manuelle', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-legacy');
    values.set(key, 'claimed');
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue, jobs } = makeQueue();
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue: makeQueue().queue,
    });

    await processReconciliationJob(
      {
        id: 'daily-sms-reconciliation-legacy',
        name: 'sms',
        data: { kind: 'sms', dayKey: '2026-09-01' },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ name: 'notification-reconciliation-manual' });
  });

  it('ne renvoie pas après un échec de création du job de réconciliation', async () => {
    const { store, values } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-requeue-failed');
    await acquireNotificationClaim(store, key, {
      provider: 'telnyx',
      channel: 'sms',
    });
    const record = JSON.parse(values.get(key)!) as Record<string, unknown>;
    record.updatedAt = new Date(
      Date.now() - NOTIFICATION_CLAIM_LEASE_SECONDS * 1000 - 1,
    ).toISOString();
    record.providerMessageId = 'msg-requeue-failed';
    values.set(key, JSON.stringify(record));
    const lookupProviderMessage = vi.fn();
    const { queue: deadLetterQueue } = makeQueue();
    const reconciliationQueue = {
      add: vi.fn().mockRejectedValue(new Error('Redis queue unavailable')),
    };
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      reconciliationQueue,
    });

    await processReconciliationJob(
      {
        id: 'requeue-failed',
        name: 'sms',
        data: {
          kind: 'sms',
          dayKey: '2026-09-01',
        },
      } as unknown as Job<ReconciliationJobData>,
      deps,
    );

    expect(lookupProviderMessage).not.toHaveBeenCalled();
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
    expect(reconciliationQueue.add).toHaveBeenCalledTimes(1);
  });

  it('laisse unknown et ouvre une revue si la réparation locale est impossible', async () => {
    const { store } = makeClaimStore();
    const key = buildNotificationClaimKey('reservation-confirmation-sms', 'res-repair-failed');
    await makeUnknownClaim(store, key, 'msg-repair-failed');
    const lookupProviderMessage = vi.fn().mockResolvedValue('success');
    const { queue: deadLetterQueue, jobs } = makeQueue();
    const repairNotification = vi.fn().mockResolvedValue('manual');
    const deps = makeDependencies(store, lookupProviderMessage, deadLetterQueue, {
      repairNotification,
    });

    await processReconciliationJob(
      makeJob({ claimKey: key, providerMessageId: 'msg-repair-failed' }),
      deps,
    );

    expect(repairNotification).toHaveBeenCalledWith(key, expect.any(Date));
    expect(await getNotificationClaim(store, key)).toMatchObject({ status: 'unknown' });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].data).toMatchObject({ reason: 'local_repair_failed' });
  });
});

// ─── Rattrapage des appels restés incomplets ──────────────────────────────

describe('reconciliation.worker voice finalization sweep', () => {
  function makeVoiceDb(rows: Array<Record<string, unknown>>, options: { failAll?: boolean } = {}) {
    const table = new Map(rows.map((row) => [String(row.callSid), row]));
    const db = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      call: {
        findMany: vi.fn().mockResolvedValue(rows.map((row) => ({ callSid: row.callSid }))),
        findUnique: options.failAll
          ? vi.fn().mockRejectedValue(new Error('db down'))
          : vi.fn(
              async ({ where }: { where: { callSid: string } }) => table.get(where.callSid) ?? null,
            ),
        update: vi.fn(async ({ where, data }: { where: { callSid: string }; data: object }) => {
          const next = { ...(table.get(where.callSid) ?? {}), ...data };
          table.set(where.callSid, next);
          return next;
        }),
        create: vi.fn(),
      },
    };
    (db as unknown as Record<string, unknown>).$transaction = vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    );
    return db;
  }

  function makeVoiceDeps(db: unknown): ReconciliationDependencies {
    const { store } = makeClaimStore();
    return {
      db: db as PrismaClient,
      claimStore: store,
      lookupProviderMessage: vi.fn(),
      deadLetterQueue: { add: vi.fn() },
    };
  }

  function makeCallRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'call-1',
      restaurantId: 'rest-1',
      callSid: 'leg-1',
      callerPhone: '+33600000000',
      durationSec: 30,
      transcript: 'Bonjour je voudrais réserver une table demain soir',
      intent: null,
      outcome: null,
      sttProvider: null,
      llmProvider: null,
      ttsProvider: null,
      reservation: null,
      messages: [],
      ...overrides,
    };
  }

  it('finalise les appels sans outcome dans la fenêtre de rattrapage', async () => {
    const db = makeVoiceDb([makeCallRow()]);

    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      makeVoiceDeps(db),
    );

    expect(db.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callSid: 'leg-1' },
        data: expect.objectContaining({ outcome: 'NO_ACTION', intent: 'RESERVATION' }),
      }),
    );
  });

  it('parcourt plus de 200 candidats même si les premiers restent éligibles', async () => {
    const rows = Array.from({ length: 205 }, (_, i) =>
      makeCallRow({
        id: `call-${i}`,
        callSid: `leg-${i}`,
        outcome: 'NO_ACTION',
        intent: 'RESERVATION',
      }),
    );
    const db = makeVoiceDb(rows);
    db.call.findMany.mockResolvedValueOnce(
      rows.slice(0, 200).map((row) => ({ callSid: row.callSid })),
    );
    db.call.findMany.mockResolvedValueOnce(
      rows.slice(200).map((row) => ({ callSid: row.callSid })),
    );
    const enqueueRecovery = vi.fn().mockResolvedValue(undefined);
    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      { ...makeVoiceDeps(db), enqueueRecovery },
    );
    expect(db.call.findMany).toHaveBeenCalledTimes(2);
    expect(db.call.findMany.mock.calls[1][0]).toEqual(
      expect.objectContaining({ cursor: { callSid: 'leg-199' }, skip: 1 }),
    );
    expect(enqueueRecovery).toHaveBeenCalledTimes(205);
  });

  it('ne réécrit rien quand l’appel est déjà complet', async () => {
    const db = makeVoiceDb([
      makeCallRow({
        outcome: 'RESERVED',
        intent: 'RESERVATION',
        sttProvider: 'deepgram-nova-3',
        llmProvider: 'cerebras',
        ttsProvider: 'cartesia-sonic',
        reservation: { id: 'res-1' },
      }),
    ]);

    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      makeVoiceDeps(db),
    );

    expect(db.call.update).not.toHaveBeenCalled();
  });

  it('déclenche la récupération commerciale grâce au numéro persisté', async () => {
    const db = makeVoiceDb([makeCallRow()]);
    const enqueueRecovery = vi.fn().mockResolvedValue(undefined);
    const deps = makeVoiceDeps(db);

    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      { ...deps, enqueueRecovery },
    );

    // Le sweep ne dispose d'aucun hint webhook : le numéro vient de la ligne.
    expect(enqueueRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: 'call-1',
        customerPhone: '+33600000000',
        reason: 'no_action_with_intent',
      }),
      'leg-1',
    );
  });

  it('retente la récupération d’un appel déjà finalisé si l’enqueue précédent a échoué', async () => {
    const db = makeVoiceDb([makeCallRow({ outcome: 'NO_ACTION', intent: 'RESERVATION' })]);
    const enqueueRecovery = vi.fn().mockResolvedValue(undefined);
    const deps = makeVoiceDeps(db);

    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      { ...deps, enqueueRecovery },
    );

    expect(db.call.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ outcome: null }),
            expect.objectContaining({
              outcome: { in: ['NO_ACTION', 'ERROR'] },
              intent: 'RESERVATION',
              callerPhone: { not: null },
              reservation: { is: null },
              messages: { none: {} },
            }),
          ]),
        }),
      }),
    );
    expect(enqueueRecovery).toHaveBeenCalledWith(
      expect.objectContaining({ callId: 'call-1', reason: 'no_action_with_intent' }),
      'leg-1',
    );
  });

  it('classe un message enregistré en MESSAGE sans récupération', async () => {
    const db = makeVoiceDb([
      makeCallRow({ messages: [{ id: 'msg-1' }], callerPhone: '+33600000000' }),
    ]);
    const enqueueRecovery = vi.fn().mockResolvedValue(undefined);
    const deps = makeVoiceDeps(db);

    await processReconciliationJob(
      {
        name: 'voice-finalization',
        data: { kind: 'voice-finalization' },
      } as unknown as Job<ReconciliationJobData>,
      { ...deps, enqueueRecovery },
    );

    expect(db.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ outcome: 'MESSAGE' }),
      }),
    );
    expect(enqueueRecovery).not.toHaveBeenCalled();
  });

  it('relance le job quand la base est indisponible pour tous les candidats', async () => {
    const db = makeVoiceDb([makeCallRow()], { failAll: true });

    await expect(
      processReconciliationJob(
        {
          name: 'voice-finalization',
          data: { kind: 'voice-finalization' },
        } as unknown as Job<ReconciliationJobData>,
        makeVoiceDeps(db),
      ),
    ).rejects.toThrow('voice finalization failed for all 1 candidate calls');
  });

  it('répare aussi la réconciliation quotidienne au lieu de seulement journaliser', async () => {
    const db = makeVoiceDb([makeCallRow()]);

    await processReconciliationJob(
      {
        name: 'calls',
        data: { kind: 'calls', dayKey: '2026-09-21' },
      } as unknown as Job<ReconciliationJobData>,
      makeVoiceDeps(db),
    );

    expect(db.call.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { callSid: 'leg-1' },
        data: expect.objectContaining({ outcome: 'NO_ACTION' }),
      }),
    );
  });
});

describe('reconciliation.worker test reservation purge', () => {
  it('purge les réservations test via le kind dédié', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { reservation: { findMany } } as unknown as PrismaClient;
    const { store } = makeClaimStore();

    await processReconciliationJob(
      {
        name: 'test-reservation-purge',
        data: { kind: 'test-reservation-purge' },
      } as unknown as Job<ReconciliationJobData>,
      {
        db,
        claimStore: store,
        lookupProviderMessage: vi.fn(),
        deadLetterQueue: { add: vi.fn() },
      },
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isTest: true }) }),
    );
  });

  it('complète les accueils vocaux manquants au passage horaire', async () => {
    await processReconciliationJob({
      id: 'greeting-warm-job',
      data: { kind: 'greeting-warm' },
    } as unknown as Job<ReconciliationJobData>);

    expect(initGreetingCache).toHaveBeenCalledTimes(1);
  });
});
