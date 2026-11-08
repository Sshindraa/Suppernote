import { Worker } from 'bullmq';
import { redisCache, redisQueue } from '../../redis/client';
import { openRouterCreditUsd } from '../../observability/metrics';
import { logger } from '../../logger/pino';
import { dispatchAlert } from '../../observability/alert-dispatcher';
import { setupWorkerListeners } from './helper';
import {
  CRITICAL_RUNWAY_DAYS,
  WARNING_RUNWAY_DAYS,
  runwayLevel,
} from '../../observability/alert-math';
import { trackRunway } from '../../observability/runway-store';

const CREDITS_PATH = '/credits';
const REQUEST_TIMEOUT_MS = 10_000;
const LATCH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Le repli du modèle vocal, le juge automatique et le scoring Jev dépendent du crédit OpenRouter :
 * à zéro, le filet de sécurité disparaît sans que rien ne casse visiblement. L'alerte part selon les jours
 * de réserve au rythme de dépense réel (alert-math.ts), pas selon un montant fixe : 2 $ ne veulent rien dire
 * sans la dépense quotidienne.
 */
export const OPENROUTER_CREDIT_LEVELS = [
  { name: 'low', severity: 'warning' },
  { name: 'critical', severity: 'critical' },
] as const;

export interface OpenRouterCreditDependencies {
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

/** Une alerte par niveau franchi ; le verrou se relâche quand la réserve remonte (recharge). */
export async function dispatchOpenRouterCreditAlerts(
  remainingUsd: number,
  runway: { days: number | null; spendPerDay: number | null },
  dependencies: OpenRouterCreditDependencies = { claimStore: redisCache, dispatch: dispatchAlert },
): Promise<{ dispatched: number; suppressed: number }> {
  let dispatched = 0;
  let suppressed = 0;
  const level = runwayLevel(remainingUsd, runway.days);
  const reached = level === 'critical' ? 2 : level === 'warning' ? 1 : 0;
  for (const [index, entry] of OPENROUTER_CREDIT_LEVELS.entries()) {
    const key = `sokar:openrouter:credit:${entry.name}`;
    if (index >= reached) {
      // Rythme de dépense inconnu : on ne touche pas aux verrous plutôt que de réarmer à tort.
      if (runway.days === null && remainingUsd > 0) continue;
      try {
        await dependencies.claimStore.del(key);
      } catch (error) {
        logger.warn({ err: error, level: entry.name }, '[openrouter-credit] Could not reset latch');
      }
      continue;
    }
    let claimed = false;
    try {
      claimed =
        (await dependencies.claimStore.set(key, '1', 'EX', LATCH_TTL_SECONDS, 'NX')) === 'OK';
    } catch (error) {
      // Redis en panne : pas d'alerte plutôt qu'une alerte toutes les heures.
      logger.warn({ err: error, level: entry.name }, '[openrouter-credit] Could not claim alert');
    }
    if (!claimed) {
      suppressed++;
      continue;
    }
    await dependencies.dispatch({
      kind: `openrouter_credit_${entry.name}`,
      severity: entry.severity,
      summary:
        remainingUsd <= 0
          ? 'Crédit OpenRouter épuisé'
          : `Crédit OpenRouter : ${runway.days?.toFixed(1)} jours de réserve (${remainingUsd.toFixed(2)} $)`,
      detail: [
        `remainingUsd=${remainingUsd.toFixed(2)}`,
        `spendPerDayUsd=${runway.spendPerDay?.toFixed(2) ?? 'inconnu'}`,
        `runwayDays=${runway.days === null ? 'inconnu' : Number.isFinite(runway.days) ? runway.days.toFixed(1) : 'illimité'}`,
        `seuils=${WARNING_RUNWAY_DAYS} jours (week-end couvert) puis ${CRITICAL_RUNWAY_DAYS} jour (agir aujourd’hui)`,
        'Sans crédit : plus de repli du modèle vocal, plus de scoring Jev ni de juge automatique.',
        'Action : recharger le crédit OpenRouter (recharge automatique conseillée).',
      ].join('\n'),
    });
    dispatched++;
  }
  return { dispatched, suppressed };
}

export type CreditFetch = (
  url: string,
  init: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

/** Crédit restant et consommation cumulée en dollars, ou null si la clé est absente. Lève sur une réponse invalide. */
export async function fetchOpenRouterRemainingUsd(
  options: { apiKey?: string; baseUrl?: string; fetcher?: CreditFetch } = {},
): Promise<{ remainingUsd: number; totalUsageUsd: number } | null> {
  const apiKey = (options.apiKey ?? process.env.OPENROUTER_API_KEY)?.trim();
  if (!apiKey) return null;
  const baseUrl =
    options.baseUrl ?? process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const fetcher: CreditFetch = options.fetcher ?? fetch;
  const response = await fetcher(`${baseUrl}${CREDITS_PATH}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`OpenRouter credits request failed with HTTP ${response.status}`);
  const payload = (await response.json()) as {
    data?: { total_credits?: number; total_usage?: number };
  };
  const total = payload.data?.total_credits;
  const usage = payload.data?.total_usage;
  if (!Number.isFinite(total) || !Number.isFinite(usage)) {
    throw new Error('OpenRouter credits response is invalid');
  }
  return { remainingUsd: (total as number) - (usage as number), totalUsageUsd: usage as number };
}

export const openRouterCreditWorker = new Worker(
  'openrouter-credit',
  async () => {
    const credit = await fetchOpenRouterRemainingUsd();
    if (credit === null) return;
    const { remainingUsd, totalUsageUsd } = credit;
    openRouterCreditUsd.set(remainingUsd);
    const { spendPerDay, runway } = await trackRunway('openrouter', remainingUsd, {
      value: totalUsageUsd,
      kind: 'cumulative',
    });
    const alerts = await dispatchOpenRouterCreditAlerts(remainingUsd, {
      days: runway,
      spendPerDay,
    });
    logger.info(
      {
        remainingUsd: Number(remainingUsd.toFixed(2)),
        spendPerDayUsd: spendPerDay === null ? null : Number(spendPerDay.toFixed(2)),
        runwayDays: runway === null || !Number.isFinite(runway) ? null : Number(runway.toFixed(1)),
        ...alerts,
      },
      '[openrouter-credit] Credit checked',
    );
  },
  { connection: redisQueue },
);

setupWorkerListeners(openRouterCreditWorker);
