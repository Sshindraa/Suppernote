/**
 * Alert evaluation engine — lit les métriques Prometheus en mémoire,
 * compare avec le snapshot précédent, et décide si les fonctions d'alerte
 * doivent être déclenchées.
 *
 * Architecture :
 *   1. captureSnapshot() — lit les valeurs actuelles des counters/histograms
 *   2. computeCounterRate() — diff entre snapshot actuel et précédent
 *   3. computeHistogramP95() — p95 sur les deltas de buckets (fenêtre de 5 min)
 *   4. evaluateAlerts() — orchestre les 4 checks et retourne un résultat structuré
 *
 * Time-windowing :
 *   Les counters Prometheus sont monotones depuis le démarrage du process.
 *   Pour obtenir un "taux sur 5 min", on diff les valeurs entre deux ticks
 *   du cron. Le snapshot précédent est stocké en Redis (TTL 15 min) par le
 *   worker.
 *
 * P95 estimation :
 *   Les histograms prom-client exposent des buckets cumulatifs (le="100"
 *   donne le nombre d'observations <= 100ms). On calcule le delta de chaque
 *   bucket entre deux snapshots, puis on interpole linéairement pour estimer
 *   le p95 sur la fenêtre.
 *
 * Edge cases gérés :
 *   - Premier run (pas de snapshot précédent) → skip rate-based alerts
 *   - Process restart (valeurs actuelles < précédentes) → skip ce tick,
 *     le snapshot actuel devient la nouvelle baseline
 *   - Aucune requête dans la fenêtre (total delta = 0) → rate = 0, pas d'alerte
 */

import type { Counter, Histogram } from 'prom-client';
import {
  alertErrorRateHigh,
  alertConnect5xxRateHigh,
  alertConnectLatencyHigh,
  alertConnectQueueBacklog,
} from './alerts';
import { httpRequestsTotal, connectRequestDuration } from './metrics';

// ─── Types ────────────────────────────────────────────────

/** Snapshot d'un counter : key = labels sérialisées, value = valeur cumulée. */
export type CounterSnapshot = Record<string, number>;

/**
 * Snapshot des buckets d'un histogram : key = labels sérialisées (sans `le`),
 * value = map { le → count cumulatif }.
 */
export type HistogramBucketSnapshot = Record<string, Record<string, number>>;

/** Snapshot complet des métriques relevant des alertes. */
export interface MetricSnapshot {
  timestamp: number;
  counters: {
    /** suppernote_http_requests_total{status_class} — global API. */
    httpRequests: CounterSnapshot;
    /** suppernote_connect_request_duration_ms_count{route,status} — Connect. */
    connectRequestCount: CounterSnapshot;
  };
  histograms: {
    /** suppernote_connect_request_duration_ms_bucket{route,status,le} — Connect. */
    connectRequestBuckets: HistogramBucketSnapshot;
  };
}

/** Résultat d'une évaluation d'alerte individuelle. */
export interface AlertResult {
  kind: string;
  triggered: boolean;
  suppressed: boolean;
  detail: Record<string, unknown>;
}

/** Résultat global d'un tick d'évaluation. */
export interface EvaluationResult {
  evaluatedAt: number;
  windowMs: number;
  alerts: AlertResult[];
  errors: string[];
  /** True si le snapshot précédent était absent ou invalide (first run / restart). */
  baselineReset: boolean;
}

/** Interface pour le cooldown (implémentée par le worker via Redis). */
export interface AlertCooldown {
  shouldSuppress(kind: string, identifier: string): Promise<boolean>;
  markFired(kind: string, identifier: string): Promise<void>;
}

// ─── Constantes ────────────────────────────────────────────

/** Buckets de l'histogram connectRequestDuration (cf. metrics.ts). */
const CONNECT_DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000];

/** Seuil de détection de process restart : si > 50% des valeurs décroissent. */
const RESTART_DETECTION_RATIO = 0.5;

// ─── Helpers ───────────────────────────────────────────────

/** Sérialise les labels en une clé stable (triée). */
function labelsKey(labels: Record<string, string>): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(',');
}

/** Classe un code HTTP en status_class. */
function statusClass(code: number): string {
  if (code < 400) return '2xx';
  if (code < 500) return '4xx';
  return '5xx';
}

// ─── Snapshot capture ──────────────────────────────────────

/** Capture les valeurs actuelles d'un counter dans un CounterSnapshot. */
export async function captureCounter(counter: Counter<string>): Promise<CounterSnapshot> {
  const snap: CounterSnapshot = {};
  const metric = await counter.get();
  for (const { labels, value } of metric.values) {
    snap[labelsKey(labels as Record<string, string>)] = value;
  }
  return snap;
}

/**
 * Capture les buckets cumulatifs d'un histogram.
 * Retourne :
 *   - buckets : key = labels sans `le`, value = { le → count }
 *   - counts  : key = labels sans `le`, value = count total (entrée sans `le`)
 */
export async function captureHistogram(histogram: Histogram<string>): Promise<{
  buckets: HistogramBucketSnapshot;
  counts: CounterSnapshot;
}> {
  const buckets: HistogramBucketSnapshot = {};
  const counts: CounterSnapshot = {};
  const metric = await histogram.get();
  for (const { labels, value } of metric.values) {
    const lbls = labels as Record<string, string>;
    const le = lbls.le;
    if (le !== undefined) {
      const { le: _strip, ...rest } = lbls;
      const key = labelsKey(rest);
      if (!buckets[key]) buckets[key] = {};
      buckets[key][le] = value;
    } else {
      const key = labelsKey(lbls);
      counts[key] = value;
    }
  }
  return { buckets, counts };
}

/**
 * Capture un snapshot complet de toutes les métriques relevant des alertes.
 * Cette fonction lit les métriques en mémoire (prom-client) — pas d'I/O externe.
 */
export async function captureSnapshot(): Promise<MetricSnapshot> {
  const { buckets, counts } = await captureHistogram(connectRequestDuration);
  return {
    timestamp: Date.now(),
    counters: {
      httpRequests: await captureCounter(httpRequestsTotal),
      connectRequestCount: counts,
    },
    histograms: {
      connectRequestBuckets: buckets,
    },
  };
}

// ─── Rate computation ──────────────────────────────────────

/**
 * Calcule un rate entre deux snapshots de counter.
 *
 * @param prev       Snapshot précédent (null si premier run)
 * @param cur        Snapshot actuel
 * @param matchFn    Filtre les entrées qui comptent comme "numérateur" (ex: 5xx)
 * @param totalFn    Filtre les entrées qui comptent comme "dénominateur" (ex: all)
 * @returns { rate, count, total } — rate = count/total, 0 si pas de précédent ou total ≤ 0
 */
export function computeCounterRate(
  prev: CounterSnapshot | null,
  cur: CounterSnapshot,
  matchFn: (key: string) => boolean,
  totalFn: (key: string) => boolean,
): { rate: number; count: number; total: number } {
  if (!prev) return { rate: 0, count: 0, total: 0 };

  let count = 0;
  let total = 0;
  for (const [key, value] of Object.entries(cur)) {
    const prevValue = prev[key] ?? 0;
    const delta = value - prevValue;
    if (matchFn(key)) count += delta;
    if (totalFn(key)) total += delta;
  }

  if (total <= 0) return { rate: 0, count: Math.max(0, count), total: 0 };
  return { rate: count / total, count, total };
}

// ─── P95 estimation from histogram bucket deltas ───────────

/**
 * Estime le p95 à partir des deltas de buckets cumulatifs.
 *
 * @param prevBuckets  Buckets cumulatifs précédents (null si premier run)
 * @param curBuckets   Buckets cumulatifs actuels
 * @returns p95 en ms, ou 0 si pas de précédent ou aucune observation
 */
export function computeHistogramP95(
  prevBuckets: Record<string, number> | null,
  curBuckets: Record<string, number>,
): number {
  if (!prevBuckets) return 0;

  // Calcule les deltas cumulatifs par bucket
  const allLe = [...CONNECT_DURATION_BUCKETS, Infinity];
  const deltas: Array<{ le: number; cumulative: number }> = [];
  let totalCount = 0;

  for (const le of allLe) {
    const leStr = le === Infinity ? '+Inf' : String(le);
    const curVal = curBuckets[leStr] ?? 0;
    const prevVal = prevBuckets[leStr] ?? 0;
    const delta = Math.max(0, curVal - prevVal);
    deltas.push({ le, cumulative: delta });
    if (le === Infinity) totalCount = delta;
  }

  if (totalCount === 0) return 0;

  const target = 0.95 * totalCount;

  // Trouve le bucket où le p95 tombe et interpole
  let prevCumulative = 0;
  let prevLe = 0;
  for (const { le, cumulative } of deltas) {
    if (cumulative >= target) {
      const bucketCount = cumulative - prevCumulative;
      if (bucketCount === 0) return prevLe;
      const fraction = (target - prevCumulative) / bucketCount;
      return Math.round(prevLe + fraction * (le - prevLe));
    }
    prevCumulative = cumulative;
    prevLe = le;
  }

  // Fallback : retourne le plus grand bucket fini
  return CONNECT_DURATION_BUCKETS[CONNECT_DURATION_BUCKETS.length - 1];
}

// ─── Process restart detection ─────────────────────────────

/**
 * Détecte si le process a redémarré entre deux snapshots.
 * Si une proportion significative de valeurs a diminué, c'est que le counter
 * a été remis à zéro (restart). Dans ce cas, le snapshot actuel devient
 * la nouvelle baseline — on skip les alertes rate-based ce tick.
 */
export function detectedRestart(prev: MetricSnapshot, cur: MetricSnapshot): boolean {
  let decreased = 0;
  let total = 0;

  for (const [key, value] of Object.entries(cur.counters.httpRequests)) {
    const prevValue = prev.counters.httpRequests[key] ?? 0;
    total++;
    if (value < prevValue) decreased++;
  }

  for (const [key, value] of Object.entries(cur.counters.connectRequestCount)) {
    const prevValue = prev.counters.connectRequestCount[key] ?? 0;
    total++;
    if (value < prevValue) decreased++;
  }

  if (total === 0) return false;
  return decreased / total > RESTART_DETECTION_RATIO;
}

// ─── Alert evaluation ──────────────────────────────────────

/**
 * Orchestre l'évaluation des 4 alertes à partir des snapshots.
 *
 * @param params.prevSnapshot  Snapshot précédent (null si premier run)
 * @param params.curSnapshot   Snapshot actuel
 * @param params.queueLength   Longueur de la queue connect-analytics (null si échec)
 * @param params.cooldown      Interface de cooldown (Redis-based, implémentée par le worker)
 * @param params.windowMin     Fenêtre d'évaluation en minutes (ex: 5)
 */
export async function evaluateAlerts(params: {
  prevSnapshot: MetricSnapshot | null;
  curSnapshot: MetricSnapshot;
  queueLength: number | null;
  cooldown: AlertCooldown;
  windowMin: number;
}): Promise<EvaluationResult> {
  const { prevSnapshot, curSnapshot, queueLength, cooldown, windowMin } = params;
  const alerts: AlertResult[] = [];
  const errors: string[] = [];

  // Détection de restart : si le process a redémarré, on skip les alertes
  // rate-based ce tick et on établit une nouvelle baseline.
  const baselineReset = prevSnapshot ? detectedRestart(prevSnapshot, curSnapshot) : true;
  const hasBaseline = prevSnapshot !== null && !baselineReset;

  // ── 1. Global API 5xx rate (alertErrorRateHigh) ──────────
  try {
    const { rate, count, total } = computeCounterRate(
      hasBaseline ? prevSnapshot!.counters.httpRequests : null,
      curSnapshot.counters.httpRequests,
      (key) => key.includes('status_class=5xx'),
      () => true,
    );

    const triggered = hasBaseline && rate >= 0.01 && total > 0;
    const suppressed = triggered && (await cooldown.shouldSuppress('error_rate_high', 'global'));
    if (triggered && !suppressed) {
      alertErrorRateHigh({ rate5xx: rate, windowMin });
      await cooldown.markFired('error_rate_high', 'global');
    }
    alerts.push({
      kind: 'error_rate_high',
      triggered,
      suppressed,
      detail: { rate, count, total, baselineReset },
    });
  } catch (err) {
    errors.push(`error_rate_high: ${(err as Error).message}`);
  }

  // ── 2. Connect 5xx rate (alertConnect5xxRateHigh) ────────
  try {
    const { rate, count, total } = computeCounterRate(
      hasBaseline ? prevSnapshot!.counters.connectRequestCount : null,
      curSnapshot.counters.connectRequestCount,
      (key) => key.includes('status=5xx'),
      () => true,
    );

    const triggered = hasBaseline && rate >= 0.01 && total > 0;
    const suppressed =
      triggered && (await cooldown.shouldSuppress('connect_5xx_rate_high', 'connect'));
    if (triggered && !suppressed) {
      alertConnect5xxRateHigh({ rate5xx: rate, windowMin });
      await cooldown.markFired('connect_5xx_rate_high', 'connect');
    }
    alerts.push({
      kind: 'connect_5xx_rate_high',
      triggered,
      suppressed,
      detail: { rate, count, total, baselineReset },
    });
  } catch (err) {
    errors.push(`connect_5xx_rate_high: ${(err as Error).message}`);
  }

  // ── 3. Connect latency p95 per route (alertConnectLatencyHigh) ──
  try {
    const prevBuckets = hasBaseline ? prevSnapshot!.histograms.connectRequestBuckets : null;
    const curBuckets = curSnapshot.histograms.connectRequestBuckets;

    // Évalue le p95 par route+status (uniquement pour les requêtes 2xx —
    // la latence des erreurs 5xx n'est pas representative de l'UX).
    for (const [key, buckets] of Object.entries(curBuckets)) {
      if (!key.includes('status=2xx')) continue;
      const routeMatch = key.match(/route=([^,]+)/);
      const route = routeMatch ? routeMatch[1] : 'unknown';

      const prevRouteBuckets = prevBuckets?.[key] ?? null;
      const p95Ms = computeHistogramP95(prevRouteBuckets, buckets);

      const triggered = hasBaseline && p95Ms >= 500;
      const suppressed =
        triggered && (await cooldown.shouldSuppress('connect_latency_high', route));
      if (triggered && !suppressed) {
        alertConnectLatencyHigh({ p95Ms, route });
        await cooldown.markFired('connect_latency_high', route);
      }
      alerts.push({
        kind: 'connect_latency_high',
        triggered,
        suppressed,
        detail: { route, p95Ms, baselineReset },
      });
    }
  } catch (err) {
    errors.push(`connect_latency_high: ${(err as Error).message}`);
  }

  // ── 4. Queue backlog (alertConnectQueueBacklog) ──────────
  // Pas besoin de baseline — la longueur actuelle de la queue est suffisante.
  try {
    const triggered = queueLength !== null && queueLength >= 1000;
    const suppressed =
      triggered && (await cooldown.shouldSuppress('connect_queue_backlog', 'connect-analytics'));
    if (triggered && !suppressed) {
      alertConnectQueueBacklog({ queueLength: queueLength! });
      await cooldown.markFired('connect_queue_backlog', 'connect-analytics');
    }
    alerts.push({
      kind: 'connect_queue_backlog',
      triggered,
      suppressed,
      detail: { queueLength, baselineReset: false },
    });
  } catch (err) {
    errors.push(`connect_queue_backlog: ${(err as Error).message}`);
  }

  return {
    evaluatedAt: Date.now(),
    windowMs: windowMin * 60_000,
    alerts,
    errors,
    baselineReset,
  };
}

// Re-export pour les tests
export { statusClass as _statusClass };
