import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';

const AUTH = { authorization: 'Bearer fake-token' };

const mocks = vi.hoisted(() => ({ getSystemMetrics: vi.fn() }));
vi.mock('../system-metrics.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../system-metrics.service')>()),
  getSystemMetrics: mocks.getSystemMetrics,
}));

describe('admin /admin/system-metrics', () => {
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSystemMetrics.mockResolvedValue([
      { id: 'calls', title: 'Appels', unit: 'appels', series: [] },
    ]);
  });

  it('refuse sans authentification', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system-metrics' });
    expect(res.statusCode).toBe(401);
  });

  it('rend les panneaux pour la période demandée (24h par défaut)', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/system-metrics', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(mocks.getSystemMetrics).toHaveBeenCalledWith('24h');
    expect(res.json()).toMatchObject({ ok: true, range: '24h', panels: [{ id: 'calls' }] });

    await app.inject({ method: 'GET', url: '/admin/system-metrics?range=7d', headers: AUTH });
    expect(mocks.getSystemMetrics).toHaveBeenLastCalledWith('7d');
  });

  it.each(['1h', 'abc', '30d'])('rejette la période %s', async (range) => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/admin/system-metrics?range=${range}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.getSystemMetrics).not.toHaveBeenCalled();
  });
});
