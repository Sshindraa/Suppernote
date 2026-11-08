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
  dispatchOpenRouterCreditAlerts,
  fetchOpenRouterRemainingUsd,
  type OpenRouterCreditDependencies,
} from '../openrouter-credit.worker';

const TEST_KEY = ['test', 'openrouter', 'key'].join('-');

function makeDependencies() {
  const claimed = new Set<string>();
  const dispatch = vi.fn().mockResolvedValue([]);
  const dependencies: OpenRouterCreditDependencies = {
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

describe('crédit OpenRouter', () => {
  afterEach(() => vi.clearAllMocks());

  // Réserve en jours : 5 $ à 1 $/jour = 5 jours ; 2 $ = 2 jours ; 0,4 $ = 0,4 jour.
  const runway = (days: number | null, spendPerDay: number | null = 1) => ({ days, spendPerDay });

  it('alerte sous 3 jours de réserve, puis sous 1 jour, sans répéter à chaque heure', async () => {
    const { dependencies, dispatch } = makeDependencies();
    expect(await dispatchOpenRouterCreditAlerts(5, runway(5), dependencies)).toEqual({
      dispatched: 0,
      suppressed: 0,
    });
    expect(await dispatchOpenRouterCreditAlerts(2, runway(2), dependencies)).toEqual({
      dispatched: 1,
      suppressed: 0,
    });
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      kind: 'openrouter_credit_low',
      severity: 'warning',
    });
    expect(await dispatchOpenRouterCreditAlerts(1.9, runway(1.9), dependencies)).toEqual({
      dispatched: 0,
      suppressed: 1,
    });
    expect(await dispatchOpenRouterCreditAlerts(0.4, runway(0.4), dependencies)).toEqual({
      dispatched: 1,
      suppressed: 1,
    });
    expect(dispatch.mock.calls[1][0]).toMatchObject({
      kind: 'openrouter_credit_critical',
      severity: 'critical',
    });
  });

  it('un montant faible n’alerte pas si la dépense est faible : seule la réserve en jours compte', async () => {
    const { dependencies, dispatch } = makeDependencies();
    // 1 $ restant mais 0,01 $/jour : 100 jours de réserve.
    await dispatchOpenRouterCreditAlerts(1, runway(100, 0.01), dependencies);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('sans historique de dépense, n’alerte que sur un crédit épuisé', async () => {
    const { dependencies, dispatch } = makeDependencies();
    await dispatchOpenRouterCreditAlerts(0.3, runway(null, null), dependencies);
    expect(dispatch).not.toHaveBeenCalled();
    await dispatchOpenRouterCreditAlerts(0, runway(null, null), dependencies);
    expect(dispatch.mock.calls[0][0]).toMatchObject({ summary: 'Crédit OpenRouter épuisé' });
  });

  it('une recharge relâche les verrous : la baisse suivante alerte à nouveau', async () => {
    const { dependencies, dispatch } = makeDependencies();
    await dispatchOpenRouterCreditAlerts(0.1, runway(0.1), dependencies);
    expect(dispatch).toHaveBeenCalledTimes(2);
    await dispatchOpenRouterCreditAlerts(20, runway(20), dependencies);
    await dispatchOpenRouterCreditAlerts(1.9, runway(1.9), dependencies);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('lit le crédit restant (total moins usage), null sans clé, erreur si réponse invalide', async () => {
    const ok = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { total_credits: 10, total_usage: 4.9 } }),
    });
    const credit = await fetchOpenRouterRemainingUsd({ apiKey: TEST_KEY, fetcher: ok });
    expect(credit?.remainingUsd).toBeCloseTo(5.1);
    expect(credit?.totalUsageUsd).toBeCloseTo(4.9);
    expect(ok.mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/credits');
    expect(await fetchOpenRouterRemainingUsd({ apiKey: '  ', fetcher: ok })).toBeNull();
    const invalid = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await expect(
      fetchOpenRouterRemainingUsd({ apiKey: TEST_KEY, fetcher: invalid }),
    ).rejects.toThrow('invalid');
    const denied = vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) });
    await expect(
      fetchOpenRouterRemainingUsd({ apiKey: TEST_KEY, fetcher: denied }),
    ).rejects.toThrow('401');
  });
});
