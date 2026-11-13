import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';

vi.mock('../../../../shared/redis/client', () => ({
  redisQueue: {
    url: 'redis://localhost:6379',
    set: vi.fn().mockResolvedValue('OK'),
    get: vi.fn().mockResolvedValue(null),
    del: vi.fn().mockResolvedValue(1),
    eval: vi.fn().mockResolvedValue(0),
  },
}));
vi.mock('../../../../shared/db/client', () => ({
  db: {},
}));
vi.mock('../../gift-card-email.service', () => ({
  sendExpirationReminder: vi.fn(),
}));
vi.mock('../../../../shared/queue/workers/helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { sendExpirationReminder } from '../../gift-card-email.service';
import {
  processGiftCardReminderJob,
  type GiftCardReminderDependencies,
  type GiftCardReminderJobData,
} from '../gift-card-reminder.worker';

function makeClaimStore() {
  const claims = new Map<string, string>();
  const store = {
    async set(
      key: string,
      value: string,
      _expirationMode: 'EX',
      _expirationSeconds: number,
      existenceMode?: 'NX',
    ) {
      if (existenceMode === 'NX' && claims.has(key)) return null;
      claims.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      return claims.get(key) ?? null;
    },
    async del(key: string) {
      claims.delete(key);
      return 1;
    },
    async eval(
      _script: string,
      _numberOfKeys: number,
      key: string,
      token: string,
      nextValue: string,
    ) {
      const current = claims.get(key);
      if (!current || !current.includes(`\"token\":\"${token}\"`)) return 0;
      if (nextValue === '__DELETE__') claims.delete(key);
      else claims.set(key, nextValue);
      return 1;
    },
  };
  return { claims, store };
}

function makeReconciliationQueue() {
  const jobIds = new Set<string>();
  const queue = {
    add: vi.fn(async (_name: string, _data: unknown, options: { jobId: string }) => {
      jobIds.add(options.jobId);
    }),
  };
  return { queue, jobIds };
}

const card = {
  id: 'gc-1',
  code: 'gift-card-code',
  shortCode: 'SKR-TEST-01',
  amount: { toNumber: () => 100 },
  remainingAmount: { toNumber: () => 75 },
  recipientName: 'Bob',
  recipientEmail: 'bob@example.com',
  expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
  restaurant: { id: 'rest-1', name: 'Chez Suppernote' },
};

function makeJob(): Job<GiftCardReminderJobData> {
  return {
    id: 'job-gift-card-reminder',
    name: 'gift-card-reminder-scan',
    data: { kind: 'scan' },
  } as unknown as Job<GiftCardReminderJobData>;
}

function makeDependencies() {
  const { claims, store } = makeClaimStore();
  const db = {
    giftCard: {
      findMany: vi.fn().mockResolvedValue([card]),
      findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE', reminderSentAt: null }),
      update: vi.fn().mockResolvedValue(card),
    },
  };
  const deps: GiftCardReminderDependencies = {
    db: db as unknown as PrismaClient,
    sendExpirationReminder,
    claimStore: store,
  };
  return { db, deps, claims };
}

describe('gift-card-reminder.worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(sendExpirationReminder).mockResolvedValue(undefined);
  });

  it('déduplique deux scans concurrents pour la même carte', async () => {
    const { db, deps } = makeDependencies();

    await Promise.all([
      processGiftCardReminderJob(makeJob(), deps),
      processGiftCardReminderJob(makeJob(), deps),
    ]);

    expect(sendExpirationReminder).toHaveBeenCalledTimes(1);
    expect(db.giftCard.update).toHaveBeenCalledTimes(1);
  });

  it('ne renvoie pas un rappel si la carte n’est plus active', async () => {
    const { db, deps } = makeDependencies();
    vi.mocked(db.giftCard.findUnique).mockResolvedValue({
      status: 'CANCELLED',
      reminderSentAt: null,
    } as never);

    await processGiftCardReminderJob(makeJob(), deps);

    expect(sendExpirationReminder).not.toHaveBeenCalled();
  });

  it('propage le refus certain à BullMQ et libère la claim', async () => {
    const { deps, claims } = makeDependencies();
    vi.mocked(sendExpirationReminder).mockRejectedValueOnce(
      Object.assign(new Error('Resend refused'), { statusCode: 400 }),
    );

    await expect(processGiftCardReminderJob(makeJob(), deps)).rejects.toThrow('Resend refused');

    expect(claims.size).toBe(0);
    expect(deps.db.giftCard.update).not.toHaveBeenCalled();
  });

  it('conserve la claim et réconcilie un timeout email sans doublon', async () => {
    const { deps, claims } = makeDependencies();
    const { queue, jobIds } = makeReconciliationQueue();
    deps.reconciliationQueue = queue;
    vi.mocked(sendExpirationReminder).mockRejectedValue(new Error('Resend timeout'));

    await processGiftCardReminderJob(makeJob(), deps);
    await processGiftCardReminderJob(makeJob(), deps);

    expect(sendExpirationReminder).toHaveBeenCalledTimes(1);
    expect(deps.db.giftCard.update).not.toHaveBeenCalled();
    expect(claims.size).toBe(1);
    expect(jobIds.size).toBe(1);
  });
});
