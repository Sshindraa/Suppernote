import { describe, expect, it, vi } from 'vitest';
import { PANELS, RANGES, getSystemMetrics, type Fetcher } from '../system-metrics.service';

const ok = (values: Array<[number, string]>) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'success', data: { result: [{ values }] } }),
});

describe('courbes de supervision', () => {
  const now = Date.UTC(2026, 10, 8, 12, 0, 0);

  it('interroge seulement des requêtes prédéfinies, sur la production', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(ok([[1_794_000_000, '3']]));
    await getSystemMetrics('24h', { now, fetcher });

    const queries = fetcher.mock.calls.map(([url]) => new URL(url).searchParams.get('query') ?? '');
    const expected = PANELS.flatMap((p) => p.series.map((s) => s.query));
    expect(queries.sort()).toEqual(expected.sort());
    // Production seulement : jamais les cibles du staging.
    for (const query of queries) expect(query).not.toContain('staging');
    expect(queries.every((q) => q.includes('job="sokar-'))).toBe(true);
  });

  it('calcule la fenêtre et le pas selon la période', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(ok([]));
    await getSystemMetrics('7d', { now, fetcher });
    const params = new URL(fetcher.mock.calls[0][0]).searchParams;
    expect(Number(params.get('end')) - Number(params.get('start'))).toBe(RANGES['7d'].seconds);
    expect(params.get('step')).toBe(String(RANGES['7d'].step));
  });

  it('convertit les points en millisecondes et écarte les valeurs non numériques', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue(
      ok([
        [100, '2.5'],
        [160, 'NaN'],
        [220, '4'],
      ]),
    );
    const panels = await getSystemMetrics('6h', { now, fetcher });
    expect(panels[0].series[0].points).toEqual([
      { t: 100_000, v: 2.5 },
      { t: 220_000, v: 4 },
    ]);
  });

  it('un panneau injoignable est signalé sans faire échouer les autres', async () => {
    const fetcher = vi.fn<Fetcher>().mockImplementation(async (url) => {
      if (new URL(url).searchParams.get('query')?.includes('sokar_redis_memory_ratio')) {
        throw new Error('timeout');
      }
      return ok([[100, '1']]);
    });
    const panels = await getSystemMetrics('24h', { now, fetcher });
    const redis = panels.find((p) => p.id === 'redis');
    expect(redis?.error).toBeTruthy();
    expect(redis?.series).toEqual([]);
    expect(panels.find((p) => p.id === 'calls')?.error).toBeUndefined();
  });

  it('une réponse Prometheus en erreur est traitée comme un panneau en erreur', async () => {
    const fetcher = vi.fn<Fetcher>().mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });
    const panels = await getSystemMetrics('24h', { now, fetcher });
    expect(panels.every((p) => p.error)).toBe(true);
  });
});
