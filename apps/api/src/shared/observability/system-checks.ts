/**
 * Checks métier du monitoring pilote — exécutés toutes les 5 minutes par le
 * worker system-health. Chaque check retourne un SystemFinding actionnable
 * (résumé + détail en français) que le worker dispatche ensuite sur les
 * canaux configurés (email / webhook / SMS / Sentry) avec cooldown Redis.
 *
 * Couverture :
 *   - files BullMQ inaccessibles (Redis en erreur)
 *   - jobs en échec (failed ≥ seuil) ou bloqués (dead-letter non vide, backlog)
 *   - appels Telnyx sans transcription ou sans outcome (24h, grâce 15 min)
 *   - réservations confirmées sans SMS de confirmation tracé (24h, grâce 30 min)
 *
 * Les checks « API/dashboard down », « Redis totalement arrêté », « backup
 * quotidien absent » et « disque/mémoire » sont couverts par le watchdog VPS
 * (scripts/ops/sokar-watchdog.sh) car ils ne peuvent pas être détectés depuis
 * le process API lui-même.
 */

import type { PrismaClient } from '@prisma/client';
import { queues } from '../queue/queues';
import { logger } from '../logger/pino';

// ─── Types ─────────────────────────────────────────────────

export interface QueueStateCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  paused: number;
}

export interface SystemFinding {
  /** Identifiant stable de l'alerte (ex: 'failed_jobs'). */
  kind: string;
  severity: 'warning' | 'critical';
  /** Suffixe de clé de cooldown (ex: nom de la queue, 'global'). */
  identifier: string;
  summary: string;
  detail: string;
}

// ─── Seuils ────────────────────────────────────────────────

/** Jobs failed cumulés dans une file à partir duquel on alerte. */
export const FAILED_JOBS_THRESHOLD = 5;
/** Backlog (waiting + delayed) à partir duquel on alerte sur une file. */
export const BACKLOG_JOBS_THRESHOLD = 100;
/** Fenêtre d'analyse des appels sans transcription/outcome. */
export const CALLS_WINDOW_HOURS = 24;
/** Un appel a 15 min pour recevoir sa transcription avant d'être compté. */
export const CALLS_GRACE_MINUTES = 15;
/** Fenêtre d'analyse des réservations sans SMS de confirmation. */
export const SMS_WINDOW_HOURS = 24;
/** Une réservation a 30 min pour que son SMS de confirmation parte. */
export const SMS_GRACE_MINUTES = 30;
/** Nombre d'appels manquants à partir duquel l'alerte devient critique. */
export const CALLS_CRITICAL_COUNT = 3;

/** Événement d'audit écrit par outbound-confirm.worker après envoi du SMS. */
export const CONFIRMATION_SMS_SENT_EVENT = 'reservation_confirmation_sms_sent';

// ─── Files BullMQ ──────────────────────────────────────────

/** Lit les compteurs de toutes les files ; null par file si Redis répond mal. */
export async function collectQueueStates(): Promise<Record<string, QueueStateCounts | null>> {
  const entries = await Promise.all(
    Object.values(queues).map(async (queue) => {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused');
        const state: QueueStateCounts = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
          paused: counts.paused ?? 0,
        };
        return [queue.name, state] as const;
      } catch (err) {
        logger.warn({ err, queue: queue.name }, '[system-health] getJobCounts failed');
        return [queue.name, null] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Évalue les compteurs de chaque file. `null` = getJobCounts a échoué
 * (Redis inaccessible ou en erreur) — c'est le seul signal « Redis/BullMQ
 * en erreur » disponible depuis le process API ; l'arrêt total de Redis est
 * détecté par le watchdog VPS.
 */
export function evaluateQueueStates(
  states: Record<string, QueueStateCounts | null>,
): SystemFinding[] {
  const findings: SystemFinding[] = [];

  for (const [queue, counts] of Object.entries(states)) {
    if (counts === null) {
      findings.push({
        kind: 'queue_unreachable',
        severity: 'critical',
        identifier: queue,
        summary: `File BullMQ « ${queue} » inaccessible`,
        detail: [
          `Impossible de lire les compteurs de la file « ${queue} » (getJobCounts en échec).`,
          'Redis est probablement arrêté ou en erreur : les workers BullMQ ne traitent plus rien.',
          'Vérifier : docker compose -f infra/docker-compose.yml ps (service redis), logs API.',
        ].join('\n'),
      });
      continue;
    }

    if (queue === 'dead-letter') {
      if (counts.waiting > 0) {
        findings.push({
          kind: 'dead_letter_backlog',
          severity: 'critical',
          identifier: 'dead-letter',
          summary: `${counts.waiting} job(s) en dead-letter`,
          detail: [
            `La file dead-letter contient ${counts.waiting} job(s) ayant épuisé toutes leurs tentatives.`,
            'Ces jobs ne seront jamais rejoués automatiquement : investigation manuelle requise.',
            'Trier puis rejouer : pnpm --filter @suppernote/api ops:dead-letter list (puis replay <jobId> --confirm).',
            'Procédure complète : docs/runbooks/dead-letter.md. Logs API : grep "job failed".',
          ].join('\n'),
        });
      }
      continue;
    }

    if (counts.failed >= FAILED_JOBS_THRESHOLD) {
      findings.push({
        kind: 'failed_jobs',
        severity: 'critical',
        identifier: queue,
        summary: `${counts.failed} jobs en échec dans la file « ${queue} »`,
        detail: [
          `La file « ${queue} » compte ${counts.failed} jobs failed (seuil ${FAILED_JOBS_THRESHOLD}),`,
          `${counts.waiting} en attente, ${counts.active} actifs, ${counts.delayed} planifiés.`,
          'Vérifier les logs API (grep "job failed" + nom de la file) et la dead-letter.',
        ].join('\n'),
      });
    }

    const backlog = counts.waiting + counts.delayed;
    if (backlog >= BACKLOG_JOBS_THRESHOLD) {
      findings.push({
        kind: 'queue_backlog',
        severity: 'warning',
        identifier: queue,
        summary: `Backlog de ${backlog} jobs dans la file « ${queue} »`,
        detail: [
          `La file « ${queue} » accumule ${counts.waiting} jobs en attente et ${counts.delayed} planifiés`,
          `(seuil ${BACKLOG_JOBS_THRESHOLD}). Le worker ne suit pas : crash, Redis lent ou pic de trafic.`,
        ].join('\n'),
      });
    }
  }

  return findings;
}

// ─── Mémoire de Redis ──────────────────────────────────────

/**
 * À 70 % du plafond il reste 30 % de marge pour réagir (relever le plafond ou nettoyer) avant que Redis
 * ne refuse les écritures, ce qui ferait échouer les files de tâches. Le plafond lui-même est lu dans
 * Redis (`maxmemory`), jamais recopié ici.
 */
export const REDIS_MEMORY_WARNING_RATIO = 0.7;

export interface RedisMemory {
  usedBytes: number;
  /** Plafond `maxmemory` en octets ; 0 = aucun plafond. */
  maxBytes: number;
}

export function evaluateRedisMemory(memory: RedisMemory): SystemFinding | null {
  const mb = (bytes: number) => `${Math.round(bytes / 1_048_576)} Mo`;
  if (memory.maxBytes <= 0) {
    return {
      kind: 'redis_no_memory_cap',
      severity: 'warning',
      identifier: 'global',
      summary: 'Redis n’a aucun plafond de mémoire',
      detail: [
        `Redis utilise ${mb(memory.usedBytes)} sans plafond (maxmemory = 0).`,
        'Le plafond est perdu quand le conteneur redémarre tant que infra/docker-compose.yml',
        'n’a pas été appliqué : sokar-deploy-root apply-redis-config prod.',
      ].join('\n'),
    };
  }
  const ratio = memory.usedBytes / memory.maxBytes;
  if (ratio < REDIS_MEMORY_WARNING_RATIO) return null;
  return {
    kind: 'redis_memory_high',
    severity: 'warning',
    identifier: 'global',
    summary: `Redis à ${Math.round(ratio * 100)} % de son plafond de mémoire`,
    detail: [
      `${mb(memory.usedBytes)} utilisés sur ${mb(memory.maxBytes)} (alerte à ${Math.round(REDIS_MEMORY_WARNING_RATIO * 100)} %).`,
      'Au plafond, Redis refuse les écritures (noeviction) : les files de tâches échouent.',
      'Relever maxmemory dans infra/docker-compose.yml puis appliquer avec apply-redis-config,',
      'ou chercher ce qui grossit (cache audio, jobs conservés).',
    ].join('\n'),
  };
}

// ─── Webhooks Telnyx en erreur ─────────────────────────────

/** Santé des webhooks lue dans Redis (voir webhook-health.ts) : fenêtre de 15 min contre la semaine. */
export interface TelnyxWebhookHealth {
  window: { errors: number; total: number };
  baseline: { errors: number; total: number };
  abnormal: boolean;
  expected: number | null;
}

/**
 * Alerte quand les erreurs de la fenêtre sont trop nombreuses pour le hasard au regard du taux habituel
 * (voir alert-math.ts), ou, sans historique fiable, quand la majorité des webhooks échoue.
 */
export function evaluateTelnyxWebhookHealth(health: TelnyxWebhookHealth): SystemFinding | null {
  if (!health.abnormal) return null;
  const { window, baseline, expected } = health;
  return {
    kind: 'telnyx_webhook_errors',
    severity: 'critical',
    identifier: 'global',
    summary: `${window.errors} webhooks Telnyx en erreur sur ${window.total} en 15 min`,
    detail: [
      `${window.errors} webhooks sur ${window.total} ont été rejetés (signature invalide) ou ont répondu 5xx`,
      expected === null
        ? 'sur les 15 dernières minutes : la majorité échoue (historique de la semaine insuffisant).'
        : `sur les 15 dernières minutes, pour ${expected.toFixed(2)} attendus au taux habituel de la semaine ` +
          `(${baseline.errors} erreurs sur ${baseline.total}).`,
      'Les appels entrants ne sont peut-être plus traités.',
      "Vérifier les logs API (grep 'telnyx-guard' et 'voice/telnyx'), la clé publique",
      'TELNYX_PUBLIC_KEY et la file telnyx-webhooks.',
    ].join('\n'),
  };
}

// ─── Appels sans transcription / sans réponse ──────────────

export interface CallMissingTranscript {
  callSid: string;
  restaurantId: string;
  createdAt: Date;
  hasTranscript: boolean;
  outcome: string | null;
}

/**
 * Appels Telnyx des dernières 24h (hors grâce de 15 min) sans transcription
 * ou sans outcome — symptôme d'un pipeline voix cassé (STT ElevenLabs down,
 * webhook /voice/telnyx/end jamais reçu, stream WebSocket interrompu).
 */
export async function findCallsWithoutTranscript(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<CallMissingTranscript[]> {
  const windowStart = new Date(now.getTime() - CALLS_WINDOW_HOURS * 3_600_000);
  const graceEnd = new Date(now.getTime() - CALLS_GRACE_MINUTES * 60_000);

  const calls = await db.call.findMany({
    where: {
      carrier: 'telnyx',
      createdAt: { gte: windowStart, lte: graceEnd },
      OR: [{ transcript: null }, { outcome: null }],
    },
    select: { callSid: true, restaurantId: true, createdAt: true, transcript: true, outcome: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return calls.map((c) => ({
    callSid: c.callSid,
    restaurantId: c.restaurantId,
    createdAt: c.createdAt,
    hasTranscript: c.transcript !== null,
    outcome: c.outcome,
  }));
}

export function evaluateCallsWithoutTranscript(
  calls: CallMissingTranscript[],
): SystemFinding | null {
  if (calls.length === 0) return null;
  const samples = calls
    .slice(0, 5)
    .map(
      (c) =>
        `  - ${c.callSid} (${c.createdAt.toISOString()}, ${c.hasTranscript ? 'sans outcome' : 'sans transcription'})`,
    )
    .join('\n');
  return {
    kind: 'calls_without_transcript',
    severity: calls.length >= CALLS_CRITICAL_COUNT ? 'critical' : 'warning',
    identifier: 'global',
    summary: `${calls.length} appel(s) sans transcription ou sans réponse sur 24h`,
    detail: [
      `${calls.length} appel(s) Telnyx n'ont ni transcription ni outcome après 15 min :`,
      samples,
      'Le pipeline voix est peut-être cassé (ElevenLabs STT, stream WebSocket, webhook /voice/telnyx/end).',
      'Vérifier les logs API (grep "voice/stream") et relancer un appel test.',
    ].join('\n'),
  };
}

// ─── Réservations sans SMS de confirmation ─────────────────

export interface ReservationMissingSms {
  id: string;
  restaurantId: string;
  customerName: string;
  createdAt: Date;
}

/**
 * Réservations créées dans la fenêtre (bornée par `since`) avec un téléphone
 * client et smsConfirmEnabled, dont le SMS de confirmation n'a pas été tracé
 * (pas d'audit reservation_confirmation_sms_sent écrit par le worker
 * outbound-confirm après envoi réussi).
 *
 * `since` est le marqueur de démarrage du check (Redis, posé au premier tick)
 * pour ne pas flaguer les réservations antérieures à l'existence de l'audit.
 */
export async function findReservationsWithoutConfirmationSms(
  db: PrismaClient,
  since: Date,
  now: Date = new Date(),
): Promise<ReservationMissingSms[]> {
  const windowStart = new Date(
    Math.max(since.getTime(), now.getTime() - SMS_WINDOW_HOURS * 3_600_000),
  );
  const graceEnd = new Date(now.getTime() - SMS_GRACE_MINUTES * 60_000);
  if (windowStart >= graceEnd) return [];

  return db.reservation.findMany({
    where: {
      createdAt: { gte: windowStart, lte: graceEnd },
      customerPhone: { not: null },
      restaurant: { smsConfirmEnabled: true },
      // Une demande PENDING ne doit pas être signalée comme un SMS manquant :
      // elle n'est pas encore confirmée côté métier.
      state: 'CONFIRMED',
      auditLog: { none: { event: CONFIRMATION_SMS_SENT_EVENT } },
    },
    select: { id: true, restaurantId: true, customerName: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
}

export function evaluateReservationsWithoutSms(
  reservations: ReservationMissingSms[],
): SystemFinding | null {
  if (reservations.length === 0) return null;
  const samples = reservations
    .slice(0, 5)
    .map((r) => `  - ${r.customerName} (${r.id}, créée ${r.createdAt.toISOString()})`)
    .join('\n');
  return {
    kind: 'reservations_without_sms',
    severity: 'warning',
    identifier: 'global',
    summary: `${reservations.length} réservation(s) créée(s) sans SMS de confirmation`,
    detail: [
      `${reservations.length} réservation(s) avec téléphone client n'ont pas de trace d'envoi du SMS`,
      'de confirmation après 30 min :',
      samples,
      'Vérifier la file « sms-client » (jobs failed), les logs outbound-confirm et le solde Telnyx.',
    ].join('\n'),
  };
}
