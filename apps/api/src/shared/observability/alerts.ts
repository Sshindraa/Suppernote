/**
 * Service d'alertes Suppernote.
 *
 * Centralise les alertes critiques qui doivent déclencher Sentry
 * + idéalement PagerDuty (Phase 6+). Les alertes sont typées
 * pour qu'on puisse les grep + filtrer en prod.
 *
 * Alertes Phase 6 :
 *   - double_booking : une tentative de double booking (jamais ne devrait arriver)
 *   - pii_leak : PII détectée dans une tool response
 *   - error_rate_high : 5xx > 1% sur une fenêtre de 5 min (à implémenter en cron)
 */

import { captureException, captureMessage } from '../sentry/client';
import { doubleBookingAttemptsTotal, piiLeaksTotal, failOpenTotal } from './metrics';
import { logger } from '../logger/pino';

export type AlertKind =
  | 'double_booking'
  | 'pii_leak'
  | 'error_rate_high'
  | 'agent_unavailable'
  | 'connect_latency_high'
  | 'connect_queue_backlog'
  | 'connect_5xx_rate_high'
  | 'fail_open';

export function alertDoubleBooking(args: {
  restaurantId: string;
  partySize: number;
  slotStart: string;
  attemptedBy: string;
}): void {
  doubleBookingAttemptsTotal.inc();
  logger.error(
    {
      alert: 'double_booking',
      ...args,
    },
    'DOUBLE BOOKING ATTEMPT — should never happen with partial unique index',
  );
  captureException(new Error('Double booking attempt'), {
    tags: { alert: 'double_booking' },
    extra: args,
  });
}

export function alertPiiLeak(args: {
  tool: string;
  kind: 'phone' | 'email' | 'hex';
  path: string;
  sample: string;
}): void {
  piiLeaksTotal.inc({ kind: args.kind });
  logger.error(
    {
      alert: 'pii_leak',
      ...args,
    },
    'PII LEAK in tool response — redaction failed',
  );
  captureException(new Error('PII leak in tool response'), {
    tags: { alert: 'pii_leak', kind: args.kind, tool: args.tool },
    extra: args,
  });
}

export function alertErrorRateHigh(args: { rate5xx: number; windowMin: number }): void {
  if (args.rate5xx < 0.01) return; // < 1%, on n'alerte pas
  logger.error(
    {
      alert: 'error_rate_high',
      ...args,
    },
    `5xx rate ${(args.rate5xx * 100).toFixed(2)}% exceeds 1% threshold`,
  );
  captureMessage(`5xx rate high: ${(args.rate5xx * 100).toFixed(2)}%`, 'error', {
    tags: { alert: 'error_rate_high' },
    extra: args,
  });
}

export function alertAgentUnavailable(args: { agent: string; reason: string }): void {
  logger.error({ alert: 'agent_unavailable', ...args }, 'Agent IA indisponible');
  captureException(new Error('Agent unavailable'), {
    tags: { alert: 'agent_unavailable', agent: args.agent },
    extra: args,
  });
}

/**
 * Alerte : latence p95 des routes Connect > 500ms.
 * Déclenchée par un cron ou un check périodique (cf. connect-alerts.worker.ts).
 */
export function alertConnectLatencyHigh(args: { p95Ms: number; route: string }): void {
  if (args.p95Ms < 500) return;
  logger.error(
    { alert: 'connect_latency_high', ...args },
    `Connect p95 latency ${args.p95Ms}ms > 500ms threshold on ${args.route}`,
  );
  captureMessage(`Connect p95 latency high: ${args.p95Ms}ms on ${args.route}`, 'warning', {
    tags: { alert: 'connect_latency_high', route: args.route },
    extra: args,
  });
}

/**
 * Alerte : backlog de la queue connect-analytics > 1000 events.
 * Indique que l'worker ne suit pas (Redis down, worker crash, ou pic de trafic).
 */
export function alertConnectQueueBacklog(args: { queueLength: number }): void {
  if (args.queueLength < 1000) return;
  logger.error(
    { alert: 'connect_queue_backlog', ...args },
    `Connect analytics queue backlog ${args.queueLength} > 1000 threshold`,
  );
  captureMessage(`Connect queue backlog: ${args.queueLength} events`, 'warning', {
    tags: { alert: 'connect_queue_backlog' },
    extra: args,
  });
}

/**
 * Alerte : taux de 5xx sur les routes Connect > 1%.
 * Détecte les pannes API qui impactent le booking.
 */
export function alertConnect5xxRateHigh(args: { rate5xx: number; windowMin: number }): void {
  if (args.rate5xx < 0.01) return;
  logger.error(
    { alert: 'connect_5xx_rate_high', ...args },
    `Connect 5xx rate ${(args.rate5xx * 100).toFixed(2)}% exceeds 1% threshold`,
  );
  captureMessage(`Connect 5xx rate high: ${(args.rate5xx * 100).toFixed(2)}%`, 'error', {
    tags: { alert: 'connect_5xx_rate_high' },
    extra: args,
  });
}

/**
 * Alerte fail-open : un service Redis/cache est down et le service a
 * continué en mode dégradé (laisse passer plutôt que de bloquer).
 *
 * Comportement :
 *   - Incrémente le compteur Prometheus suppernote_fail_open_total{source}
 *   - logger.warn avec le détail
 *   - NE PAS appeler captureException à chaque fail-open individuel
 *     (ce serait du bruit Sentry à chaque hoquet Redis). L'alerte Sentry
 *     viendra de la règle de seuil agrégée (étape 3), pas de l'événement unitaire.
 *
 * @param source  - 'mcp_rate_limit' | 'connect_rate_limit' | 'openai_reserve_cache' | 'idempotency' | ...
 * @param reason  - cause lisible ('redis_down', 'cache_get_failed', 'cache_set_failed', ...)
 * @param err     - erreur originale (optionnel)
 */
export function alertFailOpen(args: { source: string; reason: string; err?: unknown }): void {
  failOpenTotal.inc({ source: args.source });
  logger.warn(
    { alert: 'fail_open', source: args.source, reason: args.reason, err: args.err },
    `Fail-open: ${args.source} ${args.reason} — service continues in degraded mode`,
  );
}
