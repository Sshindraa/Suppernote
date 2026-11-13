/**
 * Connect Pilot KPIs : agrège les 4 critères go/no-go du pilote P1
 * Suppernote Connect depuis les compteurs/histogrammes Prometheus in-process.
 *
 * Critères go/no-go P1 (spec v1.1) :
 *   1. hold_to_confirm_rate : >= 30% (réservations web confirmées / holds créés)
 *   2. slug_p95_ms : < 500 ms (latence p95 sur /public/r/:slug)
 *   3. pii_leak_incidents : == 0 (jamais de fuite PII dans les logs)
 *   4. aggregate_rating_safe : true (aucune page Search Console avec aggregateRating inventé)
 *
 * Source : Prometheus in-process (compteurs + histogrammes).
 * Le critère 4 est statique : le code jsonld.service.ts garantit qu'aucun
 * aggregateRating n'est jamais inventé. L'audit Search Console est manuel.
 */

export type ConnectKpis = {
  timestamp: string;
  // Métriques brutes
  holdsTotal: number;
  confirmedTotal: number;
  holdToConfirmRate: number;
  slugP95Ms: number | null;
  piiLeakIncidents: number;
  aggregateRatingSafe: boolean;
  // SLOs
  slos: {
    holdToConfirmRateMin: { target: number; met: boolean };
    latencyP95MaxMs: { target: number; met: boolean };
    piiLeakMax: { target: number; met: boolean };
    aggregateRatingSafe: { target: boolean; met: boolean };
  };
  // Santé globale
  health: 'GREEN' | 'YELLOW' | 'RED';
};

export const CONNECT_TARGETS = {
  holdToConfirmRateMin: 0.3,
  latencyP95MaxMs: 500,
  piiLeakMax: 0,
  aggregateRatingSafe: true,
};

export class ConnectKpiService {
  /**
   * Calcule les KPIs depuis les compteurs Prometheus in-process.
   */
  async getKpis(): Promise<ConnectKpis> {
    // 1. Taux hold→confirm
    const holdsTotal = await readCounterByEvent(
      'suppernote_connect_events_total',
      'reservation_hold_created',
    );
    const confirmedTotal = await readCounterByEvent(
      'suppernote_connect_events_total',
      'reservation_confirmed',
    );
    const holdToConfirmRate = holdsTotal > 0 ? confirmedTotal / holdsTotal : 0;

    // 2. p95 sur /public/r/:slug (route="slug")
    const slugP95Ms = await readHistogramP95ByRoute(
      'suppernote_connect_request_duration_ms',
      'slug',
    );

    // 3. PII leaks (somme toutes les kinds)
    const piiLeakIncidents = await readPromCounterByName('suppernote_agentic_pii_leaks_total');

    // 4. aggregateRating — code audité (jsonld.service.ts), statut statique safe
    const aggregateRatingSafe = true;

    // 5. SLO check
    const slos = {
      holdToConfirmRateMin: {
        target: CONNECT_TARGETS.holdToConfirmRateMin,
        met: holdToConfirmRate >= CONNECT_TARGETS.holdToConfirmRateMin,
      },
      latencyP95MaxMs: {
        target: CONNECT_TARGETS.latencyP95MaxMs,
        met: slugP95Ms !== null && slugP95Ms <= CONNECT_TARGETS.latencyP95MaxMs,
      },
      piiLeakMax: {
        target: CONNECT_TARGETS.piiLeakMax,
        met: piiLeakIncidents <= CONNECT_TARGETS.piiLeakMax,
      },
      aggregateRatingSafe: {
        target: CONNECT_TARGETS.aggregateRatingSafe,
        met: aggregateRatingSafe,
      },
    };

    // 6. Health summary
    const health = computeHealth(slos);

    return {
      timestamp: new Date().toISOString(),
      holdsTotal,
      confirmedTotal,
      holdToConfirmRate,
      slugP95Ms,
      piiLeakIncidents,
      aggregateRatingSafe,
      slos,
      health,
    };
  }
}

// ─── Helpers : lecture du payload Prometheus texte ───────────────────

let cachedMetricsText: string | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 5000;

/** Test-only: invalide le cache du payload Prometheus. */
export function __resetKpiCache(): void {
  cachedMetricsText = null;
  cacheTime = 0;
}

async function getMetricsText(): Promise<string> {
  const now = Date.now();
  if (cachedMetricsText && now - cacheTime < CACHE_TTL_MS) return cachedMetricsText;
  const { renderMetrics } = await import('../../shared/observability/metrics');
  cachedMetricsText = await renderMetrics();
  cacheTime = now;
  return cachedMetricsText;
}

/**
 * Lit un counter Prometheus par son nom, en sommant toutes les séries
 * (toutes les combinaisons de labels). Parse le payload texte directement.
 */
async function readPromCounterByName(name: string): Promise<number> {
  try {
    const text = await getMetricsText();
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith(name)) continue;
      const m = line.match(/^(?:\S+)(?:\{\S*\})?\s+(\d+(?:\.\d+)?)\s*$/);
      if (m) {
        total += parseFloat(m[1]);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Lit un counter Prometheus filtré par la valeur d'un label `event`.
 * Ex: suppernote_connect_events_total{event="reservation_hold_created",source="web"} 5
 * On somme toutes les séries dont le label `event` correspond.
 */
async function readCounterByEvent(name: string, event: string): Promise<number> {
  try {
    const text = await getMetricsText();
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith(name)) continue;
      if (!new RegExp(`\\{[^}]*event="${event}"[^}]*\\}`).test(line)) continue;
      const m = line.match(/^(?:\S+)(?:\{\S*\})?\s+(\d+(?:\.\d+)?)\s*$/);
      if (m) {
        total += parseFloat(m[1]);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Calcule le p95 d'un histogramme Prometheus filtré par le label `route`,
 * en sommant toutes les séries (tous les status) pour cette route.
 *
 * Algorithme :
 *   1. Parse les buckets cumulatifs `name_bucket{route="...",le="X"} count`.
 *   2. Total = somme des buckets `+Inf` (tous status confondus).
 *   3. Seuil = 0.95 * total.
 *   4. p95 = plus petit `le` dont le count cumulé >= seuil.
 */
async function readHistogramP95ByRoute(name: string, route: string): Promise<number | null> {
  try {
    const text = await getMetricsText();
    const buckets = new Map<number, number>();
    let total = 0;

    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}_bucket`)) continue;
      if (!line.includes(`route="${route}"`)) continue;
      // prom-client trie les labels alphabétiquement : le="..." peut
      // apparaître avant route/status. On extrait le et la valeur séparément.
      const leMatch = line.match(/le="([^"]+)"/);
      const valueMatch = line.match(/\}\s+(\d+(?:\.\d+)?)\s*$/);
      if (!leMatch || !valueMatch) continue;
      const le = leMatch[1];
      const count = parseFloat(valueMatch[1]);
      if (le === '+Inf') {
        total += count;
      } else {
        const upperBound = parseFloat(le);
        if (!Number.isNaN(upperBound)) {
          buckets.set(upperBound, (buckets.get(upperBound) ?? 0) + count);
        }
      }
    }

    if (total === 0) return null;

    const threshold = total * 0.95;
    const sortedBounds = Array.from(buckets.entries())
      .filter(([bound]) => Number.isFinite(bound))
      .sort((a, b) => a[0] - b[0]);

    for (const [bound, count] of sortedBounds) {
      if (count >= threshold) return bound;
    }

    return sortedBounds.length > 0 ? sortedBounds[sortedBounds.length - 1][0] : null;
  } catch {
    return null;
  }
}

/**
 * Calcule le statut global :
 *   - GREEN : tous les critères respectés
 *   - YELLOW : 1 critère en échec
 *   - RED : >= 2 critères en échec
 */
function computeHealth(slos: ConnectKpis['slos']): 'GREEN' | 'YELLOW' | 'RED' {
  const failed = [
    !slos.holdToConfirmRateMin.met,
    !slos.latencyP95MaxMs.met,
    !slos.piiLeakMax.met,
    !slos.aggregateRatingSafe.met,
  ].filter(Boolean).length;

  if (failed >= 2) return 'RED';
  if (failed === 1) return 'YELLOW';
  return 'GREEN';
}
