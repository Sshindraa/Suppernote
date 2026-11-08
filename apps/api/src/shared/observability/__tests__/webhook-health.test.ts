import { describe, expect, it, vi } from 'vitest';

vi.mock('../../redis/client', () => ({ redisCache: {} }));
vi.mock('../../logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { evaluateWebhookHealth, recordWebhookOutcome } from '../webhook-health';

function memoryStore() {
  const hashes = new Map<string, Record<string, number>>();
  return {
    hincrby: vi.fn(async (key: string, field: string, n: number) => {
      const h = hashes.get(key) ?? {};
      h[field] = (h[field] ?? 0) + n;
      hashes.set(key, h);
      return h[field];
    }),
    expire: vi.fn(async () => 1),
    hgetall: vi.fn(async (key: string) =>
      Object.fromEntries(Object.entries(hashes.get(key) ?? {}).map(([k, v]) => [k, String(v)])),
    ),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('santé des webhooks partagée entre processus', () => {
  it('compte les webhooks par tranche de 5 min et par jour, et lit la fenêtre contre la semaine', async () => {
    const store = memoryStore();
    const now = Date.UTC(2026, 10, 8, 12, 0, 0);
    // Une semaine normale : 2 000 webhooks, 1 erreur, les jours précédents.
    for (let d = 1; d <= 6; d++) {
      const at = now - d * 86_400_000;
      for (let i = 0; i < 334; i++) recordWebhookOutcome('processed', at, store);
    }
    recordWebhookOutcome('error', now - 2 * 86_400_000, store);
    // Les 15 dernières minutes : 6 erreurs sur 10.
    for (let i = 0; i < 4; i++) recordWebhookOutcome('processed', now - 60_000, store);
    for (let i = 0; i < 5; i++) recordWebhookOutcome('error', now - 120_000, store);
    recordWebhookOutcome('rejected', now - 180_000, store);
    await flush();
    await flush();

    const health = await evaluateWebhookHealth(now, store);

    expect(health.window).toEqual({ errors: 6, total: 10 });
    expect(health.baseline.total).toBeGreaterThan(1_900);
    expect(health.abnormal).toBe(true);
  });

  it('une panne Redis ne lève jamais et ne déclenche rien', async () => {
    const broken = {
      hincrby: vi.fn().mockRejectedValue(new Error('down')),
      expire: vi.fn(),
      hgetall: vi.fn().mockRejectedValue(new Error('down')),
    };
    expect(() => recordWebhookOutcome('error', Date.now(), broken)).not.toThrow();
    expect((await evaluateWebhookHealth(Date.now(), broken)).abnormal).toBe(false);
    expect(() => recordWebhookOutcome('error', Date.now(), {} as never)).not.toThrow();
  });
});
