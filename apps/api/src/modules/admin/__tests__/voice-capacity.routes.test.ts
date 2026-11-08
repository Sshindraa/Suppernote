import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';

const AUTH = { authorization: 'Bearer fake-token' };

const report = {
  limit: 60,
  source: 'default',
  activeNow: 2,
  peakToday: 7,
  peak7d: 12,
  utilization: 0.2,
  level: 'ok',
  thresholds: { warning: 0.5, critical: 0.7 },
  history: [{ day: '2026-11-08', peak: 7 }],
  measuredOnVps: false,
  generatedAt: '2026-11-08T12:00:00.000Z',
};

const mocks = vi.hoisted(() => ({
  getVoiceCapacityReport: vi.fn(),
  setCapacityLimit: vi.fn(),
  clearCapacityLimit: vi.fn(),
}));

vi.mock('../../voice/call-capacity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../voice/call-capacity')>()),
  ...mocks,
}));

describe('admin /admin/voice-capacity', () => {
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVoiceCapacityReport.mockResolvedValue(report);
    mocks.setCapacityLimit.mockResolvedValue({ limit: 80, source: 'dashboard' });
    mocks.clearCapacityLimit.mockResolvedValue({ limit: 60, source: 'default' });
  });

  it('refuse sans authentification', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/voice-capacity' });
    expect(res.statusCode).toBe(401);
  });

  it('retourne le seuil, l’usage et l’historique', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/admin/voice-capacity', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, capacity: report });
  });

  it('enregistre un nouveau seuil valide', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/voice-capacity',
      headers: AUTH,
      payload: { limit: 80 },
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.setCapacityLimit).toHaveBeenCalledWith(80, expect.any(String));
  });

  it.each([{ limit: 0 }, { limit: 501 }, { limit: 12.5 }, { limit: '80' }, {}])(
    'rejette un seuil invalide %j',
    async (payload) => {
      const app = await getApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/admin/voice-capacity',
        headers: AUTH,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(mocks.setCapacityLimit).not.toHaveBeenCalled();
    },
  );

  it('rétablit la valeur de l’environnement', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'DELETE', url: '/admin/voice-capacity', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(mocks.clearCapacityLimit).toHaveBeenCalledTimes(1);
  });
});
