import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('bullmq', () => ({
  Worker: class {
    on = vi.fn();
  },
}));
vi.mock('../../../redis/client', () => ({ redisCache: {}, redisQueue: {} }));
vi.mock('../helper', () => ({ setupWorkerListeners: vi.fn() }));
vi.mock('../../../logger/pino', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  TELNYX_BALANCE_LEVELS,
  dispatchLevelAlerts,
  fetchTelnyxAvailableCredit,
  type ProviderBalanceDependencies,
} from '../provider-balance.worker';

const TEST_KEY = ['test', 'provider', 'key'].join('-');

function makeDependencies() {
  const claimed = new Set<string>();
  const dispatch = vi.fn().mockResolvedValue([]);
  const dependencies: ProviderBalanceDependencies = {
    claimStore: {
      set: vi.fn(async (key: string) => {
        if (claimed.has(key)) return null;
        claimed.add(key);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => (claimed.delete(key) ? 1 : 0)),
    },
    dispatch,
  };
  return { dependencies, dispatch };
}

const telnyxAlert = (remaining: number, runwayDays: number | null) => ({
  provider: 'telnyx' as const,
  remaining,
  runwayDays,
  levels: TELNYX_BALANCE_LEVELS,
  summary: () => `solde ${remaining}`,
  detail: [],
});

describe('alertes de solde fournisseur', () => {
  afterEach(() => vi.clearAllMocks());

  it('alerte une seule fois par niveau franchi, puis se relâche après une recharge', async () => {
    const { dependencies, dispatch } = makeDependencies();

    // 0,5 jour de réserve : les deux niveaux sont franchis d'un coup.
    expect(await dispatchLevelAlerts(telnyxAlert(2.43, 0.5), dependencies)).toEqual({
      dispatched: 2,
      suppressed: 0,
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'telnyx_balance_critical', severity: 'critical' }),
    );
    expect(await dispatchLevelAlerts(telnyxAlert(2.4, 0.49), dependencies)).toEqual({
      dispatched: 0,
      suppressed: 2,
    });

    await dispatchLevelAlerts(telnyxAlert(50, 20), dependencies);
    // 2 jours de réserve : seul le niveau d'avertissement est franchi.
    expect(await dispatchLevelAlerts(telnyxAlert(10, 2), dependencies)).toEqual({
      dispatched: 1,
      suppressed: 0,
    });
  });

  it('un solde bas ne déclenche rien tant que la dépense est faible', async () => {
    const { dependencies, dispatch } = makeDependencies();
    await dispatchLevelAlerts(telnyxAlert(4, 400), dependencies);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sans historique de dépense, n’alerte que sur un solde épuisé', async () => {
    const { dependencies, dispatch } = makeDependencies();
    await dispatchLevelAlerts(telnyxAlert(3, null), dependencies);
    expect(dispatch).not.toHaveBeenCalled();
    await dispatchLevelAlerts(telnyxAlert(0, null), dependencies);
    expect(dispatch).toHaveBeenCalled();
  });
});

describe('lecture des soldes', () => {
  it('lit le crédit Telnyx disponible', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { available_credit: '2.43', currency: 'USD' } }),
    });
    await expect(fetchTelnyxAvailableCredit({ apiKey: TEST_KEY, fetcher })).resolves.toEqual({
      available: 2.43,
      currency: 'USD',
    });
    await expect(fetchTelnyxAvailableCredit({ apiKey: '' })).resolves.toBeNull();
  });
});
