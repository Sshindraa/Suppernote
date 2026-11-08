/**
 * Seuils d'alerte CALCULÉS plutôt que posés à la main.
 *
 *  - Erreurs : une fenêtre est anormale quand ses erreurs sont trop nombreuses pour le hasard, d'après le
 *    taux d'erreur habituel de la semaine (loi de Poisson). Le niveau de confiance se déduit du nombre de
 *    fausses alertes toléré : une par semaine.
 *  - Réserve (crédit, solde) : une alerte part quand le temps restant avant épuisement, au rythme de dépense
 *    réel, devient plus court que le temps qu'il faut pour réagir.
 */

/** Évaluations par semaine (une toutes les 5 minutes) : une fausse alerte tolérée par semaine. */
export const EVALUATIONS_PER_WEEK = (7 * 24 * 60) / 5;
export const FALSE_ALARM_PROBABILITY = 1 / EVALUATIONS_PER_WEEK;
/** Sous ce nombre d'événements de référence, le taux habituel n'est pas fiable (convention statistique). */
export const MIN_BASELINE_EVENTS = 30;
/** Sans référence : alerte si la majorité échoue, avec au moins trois événements pour parler de majorité. */
export const MIN_EVENTS_WITHOUT_BASELINE = 3;

/** P(X ≥ k) pour une loi de Poisson de moyenne lambda. */
export function poissonTailAtLeast(k: number, lambda: number): number {
  if (k <= 0) return 1;
  let term = Math.exp(-lambda);
  let cumulative = 0;
  for (let i = 0; i < k; i++) {
    cumulative += term;
    term *= lambda / (i + 1);
  }
  return Math.max(0, 1 - cumulative);
}

export interface ErrorCounts {
  errors: number;
  total: number;
}

export interface ErrorRateVerdict {
  abnormal: boolean;
  /** Erreurs attendues dans la fenêtre au taux habituel ; null sans référence fiable. */
  expectedErrors: number | null;
  /** Probabilité d'observer au moins ces erreurs au hasard ; null sans référence fiable. */
  probability: number | null;
}

export function errorRateVerdict(window: ErrorCounts, baseline: ErrorCounts): ErrorRateVerdict {
  if (window.errors <= 0 || window.total <= 0) {
    return { abnormal: false, expectedErrors: null, probability: null };
  }
  if (baseline.total < MIN_BASELINE_EVENTS) {
    return {
      abnormal: window.total >= MIN_EVENTS_WITHOUT_BASELINE && window.errors * 2 > window.total,
      expectedErrors: null,
      probability: null,
    };
  }
  // Taux habituel lissé (Laplace) : une semaine sans erreur ne rend pas la prochaine impossible.
  const usualRate = (baseline.errors + 1) / (baseline.total + 2);
  const expectedErrors = window.total * usualRate;
  const probability = poissonTailAtLeast(window.errors, expectedErrors);
  return { abnormal: probability < FALSE_ALARM_PROBABILITY, expectedErrors, probability };
}

// ── Réserve : jours restants au rythme de dépense réel ───────────────────────────────────

/** Trois jours couvrent un week-end : une alerte le vendredi laisse le temps de recharger le lundi. */
export const WARNING_RUNWAY_DAYS = 3;
/** Un jour : il faut agir aujourd'hui. */
export const CRITICAL_RUNWAY_DAYS = 1;
/** Une journée complète au minimum pour mesurer une dépense : elle contient les pointes de service. */
export const MIN_SPEND_HISTORY_HOURS = 24;

export interface Reading {
  at: number;
  value: number;
}

const DAY_MS = 86_400_000;

/**
 * Dépense par jour d'après des relevés triés par date. `cumulative` : un compteur qui ne fait que monter
 * (consommation totale). `balance` : un solde qui baisse à la dépense et remonte aux recharges, seules les
 * baisses comptent. Null tant que l'historique couvre moins de MIN_SPEND_HISTORY_HOURS.
 */
export function dailySpend(readings: Reading[], kind: 'cumulative' | 'balance'): number | null {
  if (readings.length < 2) return null;
  const spanMs = readings[readings.length - 1].at - readings[0].at;
  if (spanMs < MIN_SPEND_HISTORY_HOURS * 3_600_000) return null;
  let spent = 0;
  if (kind === 'cumulative') {
    spent = Math.max(0, readings[readings.length - 1].value - readings[0].value);
  } else {
    for (let i = 1; i < readings.length; i++) {
      spent += Math.max(0, readings[i - 1].value - readings[i].value);
    }
  }
  return spent / (spanMs / DAY_MS);
}

/** Jours restants avant épuisement ; null si la dépense est inconnue, Infinity si elle est nulle. */
export function runwayDays(remaining: number, spendPerDay: number | null): number | null {
  if (spendPerDay === null) return null;
  if (spendPerDay <= 0) return Infinity;
  return Math.max(0, remaining) / spendPerDay;
}

export type RunwayLevel = 'ok' | 'warning' | 'critical';

export function runwayLevel(remaining: number, runway: number | null): RunwayLevel {
  if (remaining <= 0) return 'critical';
  if (runway === null) return 'ok';
  if (runway < CRITICAL_RUNWAY_DAYS) return 'critical';
  if (runway < WARNING_RUNWAY_DAYS) return 'warning';
  return 'ok';
}
