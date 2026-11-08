import { Worker } from 'bullmq';
import { redisCache, redisQueue } from '../../redis/client';
import { logger } from '../../logger/pino';
import { dispatchAlert } from '../../observability/alert-dispatcher';
import { setupWorkerListeners } from './helper';
import {
  CRITICAL_RUNWAY_DAYS,
  WARNING_RUNWAY_DAYS,
  runwayLevel,
} from '../../observability/alert-math';
import { trackRunway } from '../../observability/runway-store';

const REQUEST_TIMEOUT_MS = 10_000;
const LATCH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Solde Telnyx : à zéro, plus d'appels ni de SMS, sans erreur visible côté application. L'alerte part selon
 * les jours de réserve au rythme de dépense réel (alert-math.ts), pas selon un montant fixe. Une alerte par
 * niveau franchi, relâchée après recharge. Le quota ElevenLabs a son propre worker.
 */
export const TELNYX_BALANCE_LEVELS = [
  { name: 'low', severity: 'warning' },
  { name: 'critical', severity: 'critical' },
] as const;

type Level = { name: string; severity: 'warning' | 'critical' };

export interface ProviderBalanceDependencies {
  readonly claimStore: {
    set(
      key: string,
      value: string,
      expiryMode: 'EX',
      ttlSeconds: number,
      condition: 'NX',
    ): Promise<string | null>;
    del(key: string): Promise<number>;
  };
  readonly dispatch: typeof dispatchAlert;
}

const defaultDependencies: ProviderBalanceDependencies = {
  claimStore: redisCache,
  dispatch: dispatchAlert,
};

export async function dispatchLevelAlerts(
  args: {
    provider: 'telnyx';
    remaining: number;
    runwayDays: number | null;
    levels: readonly Level[];
    summary: (level: Level) => string;
    detail: string[];
  },
  dependencies: ProviderBalanceDependencies = defaultDependencies,
): Promise<{ dispatched: number; suppressed: number }> {
  let dispatched = 0;
  let suppressed = 0;
  const current = runwayLevel(args.remaining, args.runwayDays);
  const reached = current === 'critical' ? 2 : current === 'warning' ? 1 : 0;
  for (const [index, level] of args.levels.entries()) {
    const key = `sokar:provider-balance:${args.provider}:${level.name}`;
    if (index >= reached) {
      // Rythme de dépense inconnu : on ne touche pas aux verrous plutôt que de réarmer à tort.
      if (args.runwayDays === null && args.remaining > 0) continue;
      try {
        await dependencies.claimStore.del(key);
      } catch (error) {
        logger.warn(
          { err: error, provider: args.provider },
          '[provider-balance] Latch reset failed',
        );
      }
      continue;
    }
    let claimed = false;
    try {
      claimed =
        (await dependencies.claimStore.set(key, '1', 'EX', LATCH_TTL_SECONDS, 'NX')) === 'OK';
    } catch (error) {
      // Redis en panne : pas d'alerte plutôt qu'une alerte toutes les heures.
      logger.warn({ err: error, provider: args.provider }, '[provider-balance] Claim failed');
    }
    if (!claimed) {
      suppressed++;
      continue;
    }
    await dependencies.dispatch({
      kind: `${args.provider}_balance_${level.name}`,
      severity: level.severity,
      summary: args.summary(level),
      detail: args.detail.join('\n'),
    });
    dispatched++;
  }
  return { dispatched, suppressed };
}

export type BalanceFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** Crédit Telnyx disponible (solde + découvert autorisé), ou null sans clé. */
export async function fetchTelnyxAvailableCredit(
  options: { apiKey?: string; fetcher?: BalanceFetch } = {},
): Promise<{ available: number; currency: string } | null> {
  const apiKey = (options.apiKey ?? process.env.TELNYX_API_KEY)?.trim();
  if (!apiKey) return null;
  const fetcher: BalanceFetch = options.fetcher ?? fetch;
  const response = await fetcher('https://api.telnyx.com/v2/balance', {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Telnyx balance request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { available_credit?: string; currency?: string };
  };
  const available = Number(payload.data?.available_credit);
  if (!Number.isFinite(available)) throw new Error('Telnyx balance response is invalid');
  return { available, currency: payload.data?.currency ?? 'USD' };
}

export async function checkProviderBalances(
  dependencies: ProviderBalanceDependencies = defaultDependencies,
): Promise<void> {
  const telnyx = await fetchTelnyxAvailableCredit().catch((error: unknown) => {
    logger.warn({ err: error }, '[provider-balance] Telnyx balance unavailable');
    return null;
  });
  if (telnyx) {
    const { spendPerDay, runway } = await trackRunway('telnyx', telnyx.available, {
      value: telnyx.available,
      kind: 'balance',
    });
    const alerts = await dispatchLevelAlerts(
      {
        provider: 'telnyx',
        remaining: telnyx.available,
        runwayDays: runway,
        levels: TELNYX_BALANCE_LEVELS,
        summary: () =>
          telnyx.available <= 0
            ? 'Solde Telnyx épuisé'
            : `Solde Telnyx : ${runway?.toFixed(1)} jours de réserve (${telnyx.available.toFixed(2)} ${telnyx.currency})`,
        detail: [
          `available=${telnyx.available.toFixed(2)} ${telnyx.currency}`,
          `spendPerDay=${spendPerDay === null ? 'inconnu' : spendPerDay.toFixed(2)} ${telnyx.currency}`,
          `runwayDays=${runway === null ? 'inconnu' : Number.isFinite(runway) ? runway.toFixed(1) : 'illimité'}`,
          `seuils=${WARNING_RUNWAY_DAYS} jours (week-end couvert) puis ${CRITICAL_RUNWAY_DAYS} jour (agir aujourd’hui)`,
          'À zéro : plus d’appels entrants ni de SMS, les numéros peuvent être suspendus.',
          'Action : recharger Telnyx et activer la recharge automatique.',
        ],
      },
      dependencies,
    );
    logger.info(
      {
        available: telnyx.available,
        runwayDays: runway === null || !Number.isFinite(runway) ? null : Number(runway.toFixed(1)),
        ...alerts,
      },
      '[provider-balance] Telnyx checked',
    );
  }
}

export const providerBalanceWorker = new Worker(
  'provider-balance',
  async () => {
    await checkProviderBalances();
  },
  { connection: redisQueue },
);

setupWorkerListeners(providerBalanceWorker);
