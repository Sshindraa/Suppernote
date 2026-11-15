import { describe, expect, it, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import {
  DEAD_LETTER_PAYLOAD_VERSION,
  buildDeadLetterPayload,
  createDeadLetterDeps,
  discardDeadLetterJob,
  getDeadLetterStats,
  isReplayablePayload,
  listDeadLetterJobs,
  parseDeadLetterPayload,
  redactJobData,
  replayDeadLetterJob,
  summarizeDeadLetterJob,
} from '../dead-letter.service';

const HOLD_MARKER = 'hold-token-abc123';
const REDACTED = '[REDACTED]';

function makeJob(input: {
  id: string;
  name?: string;
  data: unknown;
  failedAt?: string;
  timestamp?: number;
}): Job {
  return {
    id: input.id,
    name: input.name ?? 'process',
    data: input.data,
    timestamp: input.timestamp ?? Date.parse('2026-09-21T10:00:00.000Z'),
    remove: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job;
}

function makePayload(failedAt: string, queue = 'sms-client'): unknown {
  return buildDeadLetterPayload({
    queueName: queue,
    jobName: 'send',
    jobId: `origin-${failedAt}`,
    attemptsMade: 5,
    data: { reservationId: 'res-1', holdToken: HOLD_MARKER },
    error: { message: 'provider timeout' },
    failedAt: new Date(failedAt),
  });
}

function makeDeps(jobs: Job[] = []) {
  const targetAdd = vi.fn().mockResolvedValue({ id: 'replayed-1' });
  const targetQueue = { name: 'sms-client', add: targetAdd } as unknown as Queue;
  const deadLetterQueue = {
    name: 'dead-letter',
    getJobs: vi.fn().mockResolvedValue(jobs),
    getJobCounts: vi.fn().mockResolvedValue({
      waiting: jobs.length,
      delayed: 0,
      active: 0,
      failed: 0,
    }),
    getJob: vi.fn(async (id: string) => jobs.find((job) => String(job.id) === id) ?? null),
  } as unknown as Queue;

  return {
    deps: {
      deadLetterQueue,
      resolveQueue: vi.fn((name: string) => (name === 'sms-client' ? targetQueue : undefined)),
    },
    targetAdd,
  };
}

describe('dead-letter payload', () => {
  it('conserve le payload brut pour le rejeu et une preview masquée pour la lecture', () => {
    const payload = buildDeadLetterPayload({
      queueName: 'sms-client',
      jobName: 'send',
      jobId: 'origin-1',
      attemptsMade: 5,
      data: { reservationId: 'res-1', holdToken: HOLD_MARKER, nested: { apiKey: 'k' } },
      error: { message: 'boom', stack: 'stack' },
    });

    expect(payload.payloadVersion).toBe(DEAD_LETTER_PAYLOAD_VERSION);
    // Le rejeu exige la donnée réelle : elle est conservée telle quelle.
    expect(payload.data).toEqual({
      reservationId: 'res-1',
      holdToken: HOLD_MARKER,
      nested: { apiKey: 'k' },
    });
    // La lecture ne doit jamais exposer le secret.
    expect(payload.dataPreview).toEqual({
      reservationId: 'res-1',
      holdToken: REDACTED,
      nested: { apiKey: REDACTED },
    });
  });

  it('refuse un payload hérité sans version, donc non rejouable', () => {
    const legacy = {
      originalQueue: 'sms-client',
      originalJobName: 'send',
      attemptsMade: 5,
      failedReason: 'boom',
      data: { holdToken: REDACTED },
      failedAt: '2026-09-20T10:00:00.000Z',
    };

    const parsed = parseDeadLetterPayload(legacy);
    expect(parsed).not.toBeNull();
    expect(parsed?.payloadVersion).toBe(0);
    expect(isReplayablePayload(parsed)).toBe(false);
    expect(summarizeDeadLetterJob(makeJob({ id: 'dl-1', data: legacy })).replayable).toBe(false);
  });

  it('rejette un payload malformé', () => {
    expect(parseDeadLetterPayload(null)).toBeNull();
    expect(parseDeadLetterPayload('nope')).toBeNull();
    expect(parseDeadLetterPayload({ originalQueue: 'sms-client' })).toBeNull();
  });

  it('redacte les secrets et les données personnelles sans toucher au reste', () => {
    expect(
      redactJobData({
        phone: '+33612345678',
        password: 'p',
        ok: 1,
        reservation: { customerName: 'Jeanne', guestEmail: 'j@x.fr', partySize: 2 },
        to: '+33600000000',
        restaurantId: 'r-1',
      }),
    ).toEqual({
      phone: REDACTED,
      password: REDACTED,
      ok: 1,
      reservation: { customerName: REDACTED, guestEmail: REDACTED, partySize: 2 },
      to: REDACTED,
      restaurantId: 'r-1',
    });
  });
});

describe('listDeadLetterJobs', () => {
  it('trie du plus récent au plus ancien, filtre par file et n’expose jamais le brut', async () => {
    const jobs = [
      makeJob({ id: 'dl-old', data: makePayload('2026-09-19T10:00:00.000Z') }),
      makeJob({ id: 'dl-new', data: makePayload('2026-09-21T10:00:00.000Z') }),
      makeJob({
        id: 'dl-other',
        data: makePayload('2026-09-21T11:00:00.000Z', 'analytics'),
      }),
    ];
    const { deps } = makeDeps(jobs);

    const all = await listDeadLetterJobs(deps);
    expect(all.map((entry) => entry.deadLetterJobId)).toEqual(['dl-other', 'dl-new', 'dl-old']);
    expect(JSON.stringify(all)).not.toContain(HOLD_MARKER);
    expect(all[0]?.dataPreview).toEqual({
      reservationId: 'res-1',
      holdToken: REDACTED,
    });

    const filtered = await listDeadLetterJobs(deps, { queue: 'sms-client' });
    expect(filtered.map((entry) => entry.deadLetterJobId)).toEqual(['dl-new', 'dl-old']);

    const limited = await listDeadLetterJobs(deps, { queue: 'sms-client', limit: 1 });
    expect(limited.map((entry) => entry.deadLetterJobId)).toEqual(['dl-new']);

    const offset = await listDeadLetterJobs(deps, { queue: 'sms-client', offset: 1, limit: 1 });
    expect(offset.map((entry) => entry.deadLetterJobId)).toEqual(['dl-old']);
  });

  it('résume un job avec ses métadonnées de triage', async () => {
    const job = makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') });
    const summary = summarizeDeadLetterJob(job);

    expect(summary).toMatchObject({
      deadLetterJobId: 'dl-1',
      originalQueue: 'sms-client',
      originalJobName: 'send',
      originalJobId: 'origin-2026-09-21T10:00:00.000Z',
      attemptsMade: 5,
      failedReason: 'provider timeout',
      replayable: true,
    });
  });
});

describe('getDeadLetterStats', () => {
  it('compte par file d’origine et retient le plus ancien échec', async () => {
    const { deps } = makeDeps([
      makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') }),
      makeJob({ id: 'dl-2', data: makePayload('2026-09-19T10:00:00.000Z') }),
      makeJob({ id: 'dl-3', data: makePayload('2026-09-21T11:00:00.000Z', 'analytics') }),
    ]);

    await expect(getDeadLetterStats(deps)).resolves.toEqual({
      total: 3,
      scanned: 3,
      byOriginalQueue: { 'sms-client': 2, analytics: 1 },
      oldestFailedAt: '2026-09-19T10:00:00.000Z',
    });
  });

  it('rapporte le total exact quand la fenêtre de scan est partielle', async () => {
    const { deps } = makeDeps([
      makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') }),
    ]);
    vi.mocked(deps.deadLetterQueue.getJobCounts).mockResolvedValue({
      waiting: 900,
      delayed: 0,
      active: 0,
      failed: 0,
    } as never);

    const stats = await getDeadLetterStats(deps);
    expect(stats.total).toBe(900);
    expect(stats.scanned).toBe(1);
  });
});

describe('replayDeadLetterJob', () => {
  it('remet le job d’origine dans sa file puis retire l’entrée dead-letter', async () => {
    const job = makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') });
    const { deps, targetAdd } = makeDeps([job]);

    await expect(replayDeadLetterJob(deps, 'dl-1')).resolves.toEqual({
      status: 'replayed',
      deadLetterJobId: 'dl-1',
      queue: 'sms-client',
      replayedJobId: 'replayed-1',
      jobName: 'send',
    });

    expect(targetAdd).toHaveBeenCalledWith(
      'send',
      { reservationId: 'res-1', holdToken: HOLD_MARKER },
      { removeOnComplete: 1000, removeOnFail: false },
    );
    expect(job.remove).toHaveBeenCalledTimes(1);
  });

  it('refuse un payload hérité redacté et ne touche à rien', async () => {
    const legacy = {
      originalQueue: 'sms-client',
      originalJobName: 'send',
      attemptsMade: 5,
      failedReason: 'boom',
      data: { holdToken: REDACTED },
    };
    const job = makeJob({ id: 'dl-legacy', data: legacy });
    const { deps, targetAdd } = makeDeps([job]);

    const result = await replayDeadLetterJob(deps, 'dl-legacy');
    expect(result.status).toBe('not_replayable');
    expect(targetAdd).not.toHaveBeenCalled();
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('refuse une file d’origine inconnue', async () => {
    const job = makeJob({
      id: 'dl-1',
      data: makePayload('2026-09-21T10:00:00.000Z', 'gone-queue'),
    });
    const { deps, targetAdd } = makeDeps([job]);

    await expect(replayDeadLetterJob(deps, 'dl-1')).resolves.toEqual({
      status: 'unknown_queue',
      deadLetterJobId: 'dl-1',
      queue: 'gone-queue',
    });
    expect(targetAdd).not.toHaveBeenCalled();
  });

  it('signale un job absent', async () => {
    const { deps } = makeDeps([]);
    await expect(replayDeadLetterJob(deps, 'missing')).resolves.toEqual({
      status: 'not_found',
      deadLetterJobId: 'missing',
    });
  });
});

describe('discardDeadLetterJob', () => {
  it('exige un motif exploitable', async () => {
    const job = makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') });
    const { deps } = makeDeps([job]);

    const result = await discardDeadLetterJob(deps, 'dl-1', '  ');
    expect(result.status).toBe('invalid_argument');
    expect(job.remove).not.toHaveBeenCalled();
  });

  it('supprime l’entrée après triage', async () => {
    const job = makeJob({ id: 'dl-1', data: makePayload('2026-09-21T10:00:00.000Z') });
    const { deps } = makeDeps([job]);

    await expect(discardDeadLetterJob(deps, 'dl-1', 'doublon assumé')).resolves.toEqual({
      status: 'discarded',
      deadLetterJobId: 'dl-1',
      reason: 'doublon assumé',
    });
    expect(job.remove).toHaveBeenCalledTimes(1);
  });
});

describe('createDeadLetterDeps', () => {
  it('résout toutes les files connues et aucune file fantôme', () => {
    const deps = createDeadLetterDeps();

    expect(deps.deadLetterQueue.name).toBe('dead-letter');
    for (const name of [
      'sms-client',
      'telnyx-webhooks',
      'outbox-dispatcher',
      'agentic-expire-hold',
      'event-session-expiry',
      'marketing-campaign',
    ]) {
      expect(deps.resolveQueue(name), `queue ${name}`).toBeDefined();
    }
    expect(deps.resolveQueue('queue-that-does-not-exist')).toBeUndefined();
  });
});
