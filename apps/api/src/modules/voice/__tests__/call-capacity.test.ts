import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/redis/client', () => ({
  redisCache: { get: vi.fn(), mget: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  checkVoiceCapacityHeadroom,
  clearCapacityLimit,
  currentCapacityLimit,
  getVoiceCapacityReport,
  setCapacityLimit,
  isAtCallCapacity,
  maxConcurrentCalls,
  recordVoicePeak,
  type CapacityCheckDeps,
} from '../call-capacity';

describe('plafond d’appels simultanés', () => {
  it('lit VOICE_MAX_CONCURRENT_CALLS, sinon aucun seuil imposé', () => {
    expect(maxConcurrentCalls('25')).toBe(25);
    expect(maxConcurrentCalls(undefined)).toBeNull();
    expect(maxConcurrentCalls('0')).toBeNull();
    expect(maxConcurrentCalls('abc')).toBeNull();
    expect(maxConcurrentCalls('2.5')).toBeNull();
  });

  it('refuse à partir du plafond, pas avant', async () => {
    expect(await isAtCallCapacity(async () => 59, 60)).toBe(false);
    expect(await isAtCallCapacity(async () => 60, 60)).toBe(true);
    expect(await isAtCallCapacity(async () => 75, 60)).toBe(true);
  });
});

describe('suivi du pic d’appels simultanés', () => {
  it('n’écrit dans Redis que pour un nouveau pic du jour', async () => {
    const data = new Map<string, string>();
    const store = {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        data.set(k, v);
      }),
    };
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const day = new Date('2026-11-08T12:00:00Z');

    recordVoicePeak(3, store, day);
    await flush();
    recordVoicePeak(2, store, day); // sous le pic local : aucune lecture
    recordVoicePeak(3, store, day); // égal : aucune lecture
    recordVoicePeak(5, store, day);
    await flush();
    expect(store.get).toHaveBeenCalledTimes(2);
    expect(data.get('sokar:voice:peak:2026-11-08')).toBe('5');

    // Un nouveau jour repart de zéro.
    recordVoicePeak(1, store, new Date('2026-11-09T08:00:00Z'));
    await flush();
    expect(data.get('sokar:voice:peak:2026-11-09')).toBe('1');
  });

  it('ne lève jamais quand le client Redis est absent ou en panne', () => {
    expect(() => recordVoicePeak(9, {} as never, new Date('2026-12-01T00:00:00Z'))).not.toThrow();
    const broken = { get: vi.fn().mockRejectedValue(new Error('down')), set: vi.fn() };
    expect(() => recordVoicePeak(9, broken, new Date('2026-12-02T00:00:00Z'))).not.toThrow();
  });

  function check(peak: number, limit = 60) {
    const set = vi.fn().mockResolvedValue('OK');
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const deps: CapacityCheckDeps = {
      store: {
        mget: vi.fn().mockResolvedValue([String(peak), null, '4', null, null, null, null]),
        set,
      },
      dispatch,
      now: new Date('2026-11-08T12:00:00Z'),
      limit,
    };
    return { deps, set, dispatch };
  }

  it('ne dit rien sous 50 % du seuil', async () => {
    const { deps, dispatch } = check(20);
    expect((await checkVoiceCapacityHeadroom(deps)).level).toBe('ok');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('alerte à 50 % pour anticiper, à 70 % pour relever maintenant', async () => {
    const warning = check(30);
    expect((await checkVoiceCapacityHeadroom(warning.deps)).level).toBe('warning');
    expect(warning.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'voice_capacity_warning', severity: 'warning' }),
    );

    const critical = check(42);
    expect((await checkVoiceCapacityHeadroom(critical.deps)).level).toBe('critical');
    expect(critical.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'voice_capacity_critical', severity: 'critical' }),
    );
  });

  it('ne renvoie pas la même alerte deux fois dans la journée', async () => {
    const { deps, set, dispatch } = check(30);
    set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);
    await checkVoiceCapacityHeadroom(deps);
    await checkVoiceCapacityHeadroom(deps);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('seuil réglé depuis le dashboard', () => {
  function memoryStore() {
    const data = new Map<string, string>();
    return {
      get: vi.fn(async (k: string) => data.get(k) ?? null),
      set: vi.fn(async (k: string, v: string) => {
        data.set(k, v);
      }),
      del: vi.fn(async (k: string) => {
        data.delete(k);
      }),
    };
  }

  it('le seuil du dashboard prime, puis on revient à la variable d’environnement', async () => {
    vi.stubEnv('VOICE_MAX_CONCURRENT_CALLS', '40');
    const store = memoryStore();
    await clearCapacityLimit(store);
    expect(await currentCapacityLimit(store, Date.now() + 60_000)).toMatchObject({
      limit: 40,
      source: 'env',
    });

    const set = await setCapacityLimit(80, 'user_1', store);
    expect(set).toMatchObject({ limit: 80, source: 'dashboard', setBy: 'user_1' });

    expect(await clearCapacityLimit(store)).toMatchObject({ limit: 40, source: 'env' });
    vi.unstubAllEnvs();
  });

  it('sans réglage ni variable, le seuil est calculé sur les mesures', async () => {
    vi.stubEnv('VOICE_MAX_CONCURRENT_CALLS', '');
    vi.stubEnv('PROCESS_MEMORY_LIMIT_MB', '500');
    const store = memoryStore();
    await clearCapacityLimit(store);
    const stats = async () => ({
      idleCpu: 0.02,
      idleRss: 200 * 1024 * 1024,
      activeSamples: 400,
      sumSessions: 1_600,
      sumDeltaCpu: 16, // 1 % de cœur par appel
      sumDeltaRss: 1_600 * 2 * 1024 * 1024, // 2 Mo par appel
    });
    const result = await currentCapacityLimit(store, Date.now() + 300_000, stats);
    // CPU : 0,7 / 0,01 = 70. Mémoire : (500 × 0,8 − 200) / 2 = 100. Le plus bas des deux.
    expect(result).toMatchObject({ limit: 70, source: 'calculated' });
    expect(result.basis).toMatchObject({ binding: 'cpu', cpuLimit: 70, memoryLimit: 100 });
    vi.unstubAllEnvs();
  });

  it('refuse un seuil hors bornes sans rien écrire', async () => {
    const store = memoryStore();
    await expect(setCapacityLimit(0, 'u', store)).rejects.toThrow(RangeError);
    await expect(setCapacityLimit(501, 'u', store)).rejects.toThrow(RangeError);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('retombe sur l’environnement quand Redis est indisponible', async () => {
    vi.stubEnv('VOICE_MAX_CONCURRENT_CALLS', '30');
    const broken = {
      get: vi.fn().mockRejectedValue(new Error('down')),
      set: vi.fn(),
      del: vi.fn().mockResolvedValue(1),
    };
    await clearCapacityLimit({ ...memoryStore() });
    expect(await currentCapacityLimit(broken, Date.now() + 120_000)).toMatchObject({ limit: 30 });
    vi.unstubAllEnvs();
  });

  it('construit le rapport : usage, pic du jour, pic sur 7 jours et niveau', async () => {
    const now = new Date('2026-11-08T12:00:00Z');
    const report = await getVoiceCapacityReport({
      store: {
        mget: vi.fn().mockResolvedValue(['5', null, '31', null, null, '12', '9']),
        set: vi.fn(),
      },
      activeCount: async () => 4,
      now,
      limit: { limit: 60, source: 'calculated' },
    });
    expect(report).toMatchObject({
      limit: 60,
      activeNow: 4,
      peakToday: 9,
      peak7d: 31,
      level: 'warning',
      cpuMeasured: false,
    });
    expect(report.history).toHaveLength(7);
    expect(report.history[6].day).toBe('2026-11-08');
    expect(report.utilization).toBeCloseTo(31 / 60);
  });
});
