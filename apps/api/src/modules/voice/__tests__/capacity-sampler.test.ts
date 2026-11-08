import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/redis/client', () => ({ redisCache: {} }));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { STATS_KEY, readCapacityStats, recordCapacitySample } from '../capacity-sampler';

function memoryStats() {
  const hash: Record<string, string> = {};
  return {
    hash,
    store: {
      hincrbyfloat: vi.fn(async (_key: string, field: string, inc: number) => {
        hash[field] = String(Number(hash[field] ?? 0) + inc);
      }),
      hset: vi.fn(async (_key: string, field: string, value: string) => {
        hash[field] = value;
      }),
      hgetall: vi.fn(async () => ({ ...hash })),
    },
  };
}

describe('échantillonnage du coût des appels', () => {
  it('apprend le niveau au repos, puis cumule le surcoût par appel', async () => {
    const { store } = memoryStats();
    const state = { idleCpu: null as number | null, idleRss: null as number | null };

    await recordCapacitySample({ active: 0, cpu: 0.02, rss: 200 }, state, store);
    await recordCapacitySample({ active: 4, cpu: 0.06, rss: 212 }, state, store);
    await recordCapacitySample({ active: 2, cpu: 0.04, rss: 206 }, state, store);

    const stats = await readCapacityStats(store);
    expect(stats).toMatchObject({ idleCpu: 0.02, idleRss: 200, activeSamples: 2, sumSessions: 6 });
    expect(stats.sumDeltaCpu).toBeCloseTo(0.06); // 0,04 + 0,02
    expect(stats.sumDeltaRss).toBe(18); // 12 + 6
    // Surcoût par appel = cumuls / cumul des appels : 0,01 de cœur, 3 octets.
    expect(stats.sumDeltaCpu / stats.sumSessions).toBeCloseTo(0.01);
    expect(stats.sumDeltaRss / stats.sumSessions).toBe(3);
  });

  it('n’enregistre rien tant que le niveau au repos est inconnu', async () => {
    const { store, hash } = memoryStats();
    await recordCapacitySample(
      { active: 3, cpu: 0.5, rss: 900 },
      { idleCpu: null, idleRss: null },
      store,
    );
    expect(hash).toEqual({});
    expect(store.hincrbyfloat).not.toHaveBeenCalled();
  });

  it('ne compte jamais un surcoût négatif', async () => {
    const { store } = memoryStats();
    const state = { idleCpu: 0.05, idleRss: 300 };
    await recordCapacitySample({ active: 1, cpu: 0.01, rss: 250 }, state, store);
    const stats = await readCapacityStats(store);
    expect(stats.sumDeltaCpu).toBe(0);
    expect(stats.sumDeltaRss).toBe(0);
    expect(STATS_KEY).toBe('sokar:voice:capacity-stats');
  });
});
