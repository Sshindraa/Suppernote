/**
 * Pilot KPIs : agrège les 5 KPIs cibles du pilote depuis la DB
 * (Postgres = source de vérité) + cross-check avec les compteurs
 * Prometheus in-process pour les compteurs d'incidents.
 *
 * KPIs cibles (Phase 7) :
 *   1. reservations_total : >= 100 cumulés sur 4 semaines
 *   2. honor_rate : > 50% (réservations HONORED / total finalisées)
 *   3. double_booking_attempts : == 0 (jamais ne devrait arriver)
 *   4. pii_leak_incidents : == 0 (jamais ne devrait arriver)
 *   5. check_availability_p95_ms : < 800 ms
 *
 * Source de vérité : Postgres (count par état). Prometheus sert
 * uniquement pour les compteurs d'incidents (double_booking, pii_leak)
 * qui ne sont pas en DB.
 */

import type { PrismaClient } from '@prisma/client';
import { doubleBookingAttemptsTotal, piiLeaksTotal } from '../../shared/observability/metrics';

export type PilotKpis = {
  timestamp: string;
  // KPIs cibles
  reservationsTotal: number;
  reservationsHonored: number;
  reservationsPending: number;
  reservationsCancelled: number;
  reservationsNoShow: number;
  honorRate: number;
  doubleBookingAttempts: number;
  piiLeakIncidents: number;
  checkAvailabilityP95Ms: number | null;
  // SLOs
  slos: {
    reservationsMin: { target: number; met: boolean };
    honorRateMin: { target: number; met: boolean };
    doubleBookingMax: { target: number; met: boolean };
    piiLeakMax: { target: number; met: boolean };
    latencyP95MaxMs: { target: number; met: boolean };
  };
  // Santé globale
  health: 'GREEN' | 'YELLOW' | 'RED';
};

export const PILOT_TARGETS = {
  reservationsMin: 100,
  honorRateMin: 0.5,
  doubleBookingMax: 0,
  piiLeakMax: 0,
  latencyP95MaxMs: 800,
};

export class PilotKpiService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Calcule les KPIs depuis la DB + compteurs Prometheus in-process.
   */
  async getKpis(): Promise<PilotKpis> {
    // 1. Source de vérité : DB — un seul groupBy au lieu de 5 count() séquentiels
    const countsByState = await this.prisma.reservation.groupBy({
      by: ['state'],
      _count: { state: true },
    });
    const countByState = new Map(countsByState.map((c) => [c.state, c._count.state]));
    const reservationsTotal = countsByState.reduce((sum, c) => sum + c._count.state, 0);
    const reservationsHonored = countByState.get('HONORED') ?? 0;
    const reservationsPending =
      (countByState.get('PENDING') ?? 0) +
      (countByState.get('CONFIRMED') ?? 0) +
      (countByState.get('SEATED') ?? 0);
    const reservationsCancelled = countByState.get('CANCELLED') ?? 0;
    const reservationsNoShow = countByState.get('NO_SHOW') ?? 0;

    // 2. Compteurs Prometheus (incidents — pas en DB)
    const dbaCount = await readCounterValue(doubleBookingAttemptsTotal);
    const piiCount = await readCounterValues(piiLeaksTotal);

    // 3. Latence p95 — calculé depuis l'histogramme Prometheus check_availability
    const p95 = await readHistogramP95('suppernote_agentic_check_availability_duration_ms');

    // 4. Honor rate (sur résas finalisées : HONORED + CANCELLED + NO_SHOW)
    const finalized = reservationsHonored + reservationsCancelled + reservationsNoShow;
    const honorRate = finalized > 0 ? reservationsHonored / finalized : 0;

    // 5. SLO check
    const slos = {
      reservationsMin: {
        target: PILOT_TARGETS.reservationsMin,
        met: reservationsTotal >= PILOT_TARGETS.reservationsMin,
      },
      honorRateMin: {
        target: PILOT_TARGETS.honorRateMin,
        met: honorRate >= PILOT_TARGETS.honorRateMin,
      },
      doubleBookingMax: {
        target: PILOT_TARGETS.doubleBookingMax,
        met: dbaCount <= PILOT_TARGETS.doubleBookingMax,
      },
      piiLeakMax: {
        target: PILOT_TARGETS.piiLeakMax,
        met: piiCount <= PILOT_TARGETS.piiLeakMax,
      },
      latencyP95MaxMs: {
        target: PILOT_TARGETS.latencyP95MaxMs,
        met: p95 !== null && p95 <= PILOT_TARGETS.latencyP95MaxMs,
      },
    };

    // 6. Health summary
    const health = computeHealth(slos);

    return {
      timestamp: new Date().toISOString(),
      reservationsTotal,
      reservationsHonored,
      reservationsPending,
      reservationsCancelled,
      reservationsNoShow,
      honorRate,
      doubleBookingAttempts: dbaCount,
      piiLeakIncidents: piiCount,
      checkAvailabilityP95Ms: p95,
      slos,
      health,
    };
  }
}

/**
 * Lecture défensive d'un counter prom-client via son payload texte.
 * On parse `suppernote_agentic_xxx{kind="phone"} 1` directement. C'est
 * stable et indépendant des changements d'API privée.
 */
async function readCounterValue(_metric: unknown): Promise<number> {
  return readPromCounterByName('suppernote_agentic_double_booking_attempts_total');
}

async function readCounterValues(_metric: unknown): Promise<number> {
  // Pour piiLeaks on somme toutes les combinaisons kind
  return readPromCounterByName('suppernote_agentic_pii_leaks_total');
}

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

async function readPromCounterByName(name: string): Promise<number> {
  try {
    const text = await getMetricsText();
    let total = 0;
    for (const line of text.split('\n')) {
      if (!line.startsWith(name)) continue;
      // Match: name{labels} value  OU  name value
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
 * Calcule le p95 d'un histogramme Prometheus à partir du payload texte.
 * Retourne `null` si l'histogramme n'a aucune observation.
 *
 * Algorithme :
 *   1. Parse les buckets cumulatifs `name_bucket{le="X"} count`.
 *   2. Total = bucket `+Inf`.
 *   3. Seuil = 0.95 * total.
 *   4. p95 = plus petit `le` dont le count cumulé >= seuil.
 *
 * C'est une approximation par interpolation constante (bucket upper bound),
 * cohérente avec `histogram_quantile(0.95, ...)` de PromQL.
 */
async function readHistogramP95(name: string): Promise<number | null> {
  try {
    const text = await getMetricsText();
    const buckets = new Map<number, number>();
    let total = 0;

    for (const line of text.split('\n')) {
      if (!line.startsWith(`${name}_bucket`)) continue;
      // Match : name_bucket{le="5"} 12  OU  name_bucket{le="+Inf"} 99
      const m = line.match(/le="([^"]+)"\}\s+(\d+(?:\.\d+)?)\s*$/);
      if (!m) continue;
      const le = m[1];
      const count = parseFloat(m[2]);
      if (le === '+Inf') {
        total = count;
      } else {
        const upperBound = parseFloat(le);
        if (!Number.isNaN(upperBound)) {
          buckets.set(upperBound, count);
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

function computeHealth(slos: PilotKpis['slos']): 'GREEN' | 'YELLOW' | 'RED' {
  // RED si pii_leak > 0 ou double_booking > 0 (critique)
  if (!slos.piiLeakMax.met || !slos.doubleBookingMax.met) return 'RED';
  // YELLOW si latency > target ou honor rate < target (dégradation)
  if (!slos.latencyP95MaxMs.met || !slos.honorRateMin.met) return 'YELLOW';
  // GREEN si tous les SLOs critiques sont met
  return 'GREEN';
}
