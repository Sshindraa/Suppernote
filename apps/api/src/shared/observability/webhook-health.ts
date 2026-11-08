import { redisCache } from '../redis/client';
import { logger } from '../logger/pino';
import { errorRateVerdict, type ErrorCounts } from './alert-math';

/**
 * Santé des webhooks Telnyx, partagée entre processus. Le compteur prom-client vit dans l'API ; le contrôle
 * tourne dans le processus workers et ne le voyait jamais : l'alerte « webhook en erreur » était muette en
 * production. Les résultats sont donc comptés dans Redis : par tranche de 5 minutes (la fenêtre évaluée) et
 * par jour (le taux habituel de la semaine).
 */
export const WINDOW_BUCKETS = 3; // fenêtre évaluée : 15 minutes
const BUCKET_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const BASELINE_DAYS = 7;

export type WebhookOutcome = 'processed' | 'error' | 'rejected';

export interface WebhookStore {
  hincrby(key: string, field: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
}

const bucketKey = (at: number) => `sokar:telnyx-webhook:b:${Math.floor(at / BUCKET_MS)}`;
const dayKey = (at: number) => `sokar:telnyx-webhook:d:${Math.floor(at / DAY_MS)}`;

/** Ne casse jamais un webhook : une mesure perdue vaut mieux qu'un appel perdu. */
export function recordWebhookOutcome(
  outcome: WebhookOutcome,
  now = Date.now(),
  store: WebhookStore = redisCache as unknown as WebhookStore,
): void {
  try {
    const field = outcome === 'processed' ? 'ok' : 'err';
    for (const [key, ttl] of [
      [bucketKey(now), 3_600],
      [dayKey(now), (BASELINE_DAYS + 1) * 86_400],
    ] as const) {
      store
        .hincrby(key, field, 1)
        .then(() => store.expire(key, ttl))
        .catch(() => undefined);
    }
  } catch {
    // Redis absent ou en panne : la mesure est simplement manquée.
  }
}

function counts(hash: Record<string, string>): ErrorCounts {
  const ok = Number(hash.ok) || 0;
  const errors = Number(hash.err) || 0;
  return { errors, total: ok + errors };
}

const add = (a: ErrorCounts, b: ErrorCounts): ErrorCounts => ({
  errors: a.errors + b.errors,
  total: a.total + b.total,
});

/** Fenêtre récente et taux habituel de la semaine (fenêtre retirée pour ne pas se comparer à elle-même). */
export async function readWebhookHealth(
  now = Date.now(),
  store: WebhookStore = redisCache as unknown as WebhookStore,
): Promise<{ window: ErrorCounts; baseline: ErrorCounts }> {
  let window: ErrorCounts = { errors: 0, total: 0 };
  for (let i = 0; i < WINDOW_BUCKETS; i++) {
    window = add(window, counts(await store.hgetall(bucketKey(now - i * BUCKET_MS))));
  }
  let week: ErrorCounts = { errors: 0, total: 0 };
  for (let d = 0; d < BASELINE_DAYS; d++) {
    week = add(week, counts(await store.hgetall(dayKey(now - d * DAY_MS))));
  }
  return {
    window,
    baseline: {
      errors: Math.max(0, week.errors - window.errors),
      total: Math.max(0, week.total - window.total),
    },
  };
}

export async function evaluateWebhookHealth(
  now = Date.now(),
  store?: WebhookStore,
): Promise<{
  window: ErrorCounts;
  baseline: ErrorCounts;
  abnormal: boolean;
  expected: number | null;
}> {
  try {
    const { window, baseline } = await readWebhookHealth(now, store);
    const verdict = errorRateVerdict(window, baseline);
    return { window, baseline, abnormal: verdict.abnormal, expected: verdict.expectedErrors };
  } catch (err) {
    logger.warn({ err }, '[webhook-health] Could not read webhook counters');
    return {
      window: { errors: 0, total: 0 },
      baseline: { errors: 0, total: 0 },
      abnormal: false,
      expected: null,
    };
  }
}
