import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const genericQueue = {
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
  };
  const eveningReportQueue = {
    upsertJobScheduler: vi.fn().mockResolvedValue(undefined),
    getJobSchedulers: vi.fn().mockResolvedValue([]),
    removeJobScheduler: vi.fn().mockResolvedValue(true),
  };
  const queues = new Proxy(
    { eveningReport: eveningReportQueue },
    {
      get(target, property) {
        return Reflect.get(target, property) ?? genericQueue;
      },
    },
  );

  return {
    db: { restaurant: { findMany: vi.fn().mockResolvedValue([]) } },
    logger: { error: vi.fn(), info: vi.fn() },
    genericQueue,
    eveningReportQueue,
    queues,
  };
});

vi.mock('../../../env', () => ({ env: { EVENING_REPORTS_ENABLED: false } }));
vi.mock('../../db/client', () => ({ db: mocks.db }));
vi.mock('../../logger/pino', () => ({ logger: mocks.logger }));
vi.mock('../queues', () => ({ queues: mocks.queues }));

import { registerJobSchedulers } from '../schedulers';

describe('registerJobSchedulers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes existing nightly report schedulers while email reports are disabled', async () => {
    mocks.eveningReportQueue.getJobSchedulers.mockResolvedValue([
      { key: 'nightly-restaurant-a', name: 'nightly' },
      { key: 'nightly-restaurant-b', name: 'nightly' },
      { key: 'other-scheduler', name: 'other' },
    ]);

    await registerJobSchedulers();

    expect(mocks.eveningReportQueue.removeJobScheduler).toHaveBeenCalledTimes(2);
    expect(mocks.eveningReportQueue.removeJobScheduler).toHaveBeenNthCalledWith(
      1,
      'nightly-restaurant-a',
    );
    expect(mocks.eveningReportQueue.removeJobScheduler).toHaveBeenNthCalledWith(
      2,
      'nightly-restaurant-b',
    );
    expect(mocks.eveningReportQueue.upsertJobScheduler).not.toHaveBeenCalled();
    expect(mocks.db.restaurant.findMany).not.toHaveBeenCalled();
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalled();
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'elevenlabs-subscription-hourly',
      { pattern: '0 * * * *', tz: 'Europe/Paris' },
      { name: 'refresh-subscription' },
    );
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'voice-quality-metrics-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'voice-quality-gauges' },
    );
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'voice-capacity-check',
      { pattern: '40 * * * *', tz: 'Europe/Paris' },
      { name: 'voice-capacity-check', data: { kind: 'voice-capacity-check' } },
    );
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'greeting-warm',
      { pattern: '25 * * * *', tz: 'Europe/Paris' },
      { name: 'greeting-warm', data: { kind: 'greeting-warm' } },
    );
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'test-reservation-purge',
      { pattern: '5 * * * *', tz: 'Europe/Paris' },
      { name: 'test-reservation-purge', data: { kind: 'test-reservation-purge' } },
    );
    expect(mocks.genericQueue.upsertJobScheduler).toHaveBeenCalledWith(
      'reservation-payment-expiry',
      { every: 60 * 1000 },
      { name: 'reservation-payment-expiry', data: { kind: 'reservation-payment-expiry' } },
    );
  });
});
