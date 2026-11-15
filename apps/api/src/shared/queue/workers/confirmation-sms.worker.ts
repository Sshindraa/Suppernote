import { Worker, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { redisQueue } from '../../redis/client';
import { db } from '../../db/client';
import { sendReminder } from '../../messaging/sender';
import { setupWorkerListeners, jobLogger } from './helper';
import { formatDate } from '@suppernote/shared';
import { queues } from '../queues';
import { CONFIRMATION_SMS_WORKER_CONCURRENCY } from '../constants';
import { isConfirmedReservation } from '../../reservations/reservation-state';
import { utcToZonedParts } from '../../timezone/restaurant-time';
import { buildReservationNotificationJobId } from '../job-options';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  classifyNotificationError,
  enqueueNotificationReconciliation,
  NotificationProviderRefusedError,
  recordNotificationResult,
  type NotificationClaimStore,
  type NotificationProviderResult,
  type NotificationReconciliationQueue,
} from '../notification-idempotency';

/**
 * Worker pour l'envoi des rappels de réservation J-1.
 *
 * Canal : WhatsApp uniquement pour les reservations WEB avec accord.
 * Aucun secours SMS. Un resultat unknown reste bloque.
 *
 * Jobs :
 * 1. { kind: 'scan' } — Scanne les réservations de demain et envoie un rappel.
 * 2. { kind: 'send', reservationId } — Envoie un rappel pour une résa spécifique.
 */

export interface ConfirmationSmsJobData {
  kind: 'scan' | 'send';
  reservationId?: string;
}

export type ConfirmationSmsDependencies = {
  db: PrismaClient;
  sendReminder: typeof sendReminder;
  formatDate: typeof formatDate;
  claimStore: NotificationClaimStore;
  reconciliationQueue?: NotificationReconciliationQueue;
  reminderQueue?: Pick<typeof queues.confirmationSms, 'add'>;
  /** Compatibility mode for injected legacy fakes; production uses sender claims. */
  manageReminderClaims?: boolean;
};

function getDefaultDependencies(): ConfirmationSmsDependencies {
  return {
    db,
    sendReminder,
    formatDate,
    claimStore: redisQueue,
    reconciliationQueue: queues.reconciliation,
    reminderQueue: queues.confirmationSms,
    manageReminderClaims: true,
  };
}

export function isReminderDue(date: Date, timezone: string, now = new Date()): boolean {
  const today = utcToZonedParts(now, timezone).date;
  const tomorrow = new Date(`${today}T12:00:00.000Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  return date > now && utcToZonedParts(date, timezone).date === tomorrow.toISOString().slice(0, 10);
}

function isReminderEligible(reservation: {
  status: string;
  state: string;
  confirmationSentAt: Date | null;
}): boolean {
  // La confirmation client ne peut être envoyée qu'après la confirmation
  // métier : `status` est une projection lossy de `state` et ne suffit pas
  // seul. Prédicat partagé avec le handler de réponse SMS (R1-4).
  return isConfirmedReservation(reservation) && reservation.confirmationSentAt === null;
}

function getResultOutcome(
  result: Awaited<ReturnType<typeof sendReminder>>,
): NotificationProviderResult {
  return result.outcome ?? (result.success ? 'success' : 'failure_certain');
}

async function requeueUnknownClaim(
  reconciliationQueue: NotificationReconciliationQueue | undefined,
  claimKey: string,
  record: {
    provider?: 'telnyx' | 'brevo' | 'resend' | 'meta';
    channel?: 'sms' | 'whatsapp' | 'email';
    providerMessageId?: string;
  },
): Promise<void> {
  if (!reconciliationQueue || !record.provider || !record.channel) return;
  try {
    await enqueueNotificationReconciliation(reconciliationQueue, {
      claimKey,
      provider: record.provider,
      channel: record.channel,
      ...(record.providerMessageId ? { providerMessageId: record.providerMessageId } : {}),
    });
  } catch (err) {
    // The claim remains unknown. A future job can retry queue insertion without
    // touching the provider again.
    throw err;
  }
}

async function recordWorkerResult(
  deps: ConfirmationSmsDependencies,
  claimKey: string,
  token: string,
  result: Awaited<ReturnType<typeof sendReminder>>,
): Promise<void> {
  const outcome = getResultOutcome(result);
  const transitioned = await recordNotificationResult(deps.claimStore, claimKey, token, outcome, {
    provider: result.provider ?? 'telnyx',
    channel: result.channel,
    ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
  });
  if (outcome === 'unknown' && transitioned) {
    await requeueUnknownClaim(deps.reconciliationQueue, claimKey, {
      provider: result.provider ?? 'telnyx',
      channel: result.channel,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
    });
  }
}

async function processReminderForReservation(
  deps: ConfirmationSmsDependencies,
  log: ReturnType<typeof jobLogger>,
  r: {
    id: string;
    customerPhone: string | null;
    restaurantId: string;
    customerId: string | null;
    restaurant: { name: string; id: string; timezone: string };
    reservedAt: Date;
    startsAt?: Date | null;
    partySize: number;
    consents?: unknown;
    channel?: string;
  },
): Promise<Awaited<ReturnType<typeof sendReminder>>> {
  const instant = r.startsAt ?? r.reservedAt;
  if (!isReminderDue(instant, r.restaurant.timezone)) {
    return { channel: 'whatsapp', success: false, skipped: 'outside_reminder_window' };
  }
  if (!r.customerPhone) {
    return { channel: 'whatsapp', success: false, skipped: 'missing_recipient' };
  }
  const reminderParams = {
    to: r.customerPhone,
    restaurantName: r.restaurant.name,
    restaurantId: r.restaurantId,
    reservationId: r.id,
    customerId: r.customerId ?? undefined,
    date: deps.formatDate(instant, 'fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: r.restaurant.timezone,
    }),
    time: utcToZonedParts(instant, r.restaurant.timezone).time,
    partySize: r.partySize,
    reservationChannel: r.channel,
    whatsappOptIn:
      r.consents !== null &&
      typeof r.consents === 'object' &&
      !Array.isArray(r.consents) &&
      (r.consents as Record<string, unknown>).transactionalWhatsapp === true,
  };

  if (r.channel !== 'WEB' || !reminderParams.whatsappOptIn) {
    return {
      channel: 'whatsapp',
      success: false,
      skipped: r.channel !== 'WEB' ? 'non_web_booking' : 'no_whatsapp_consent',
    };
  }

  if (deps.manageReminderClaims) {
    return deps.sendReminder(reminderParams, {
      claimStore: deps.claimStore,
      reconciliationQueue: deps.reconciliationQueue,
    });
  }

  const claimKey = buildNotificationClaimKey('reservation-reminder', r.id);
  const attempt = await acquireNotificationClaim(deps.claimStore, claimKey, {
    provider: 'telnyx',
    channel: 'sms',
  });
  if (!attempt.acquired || !attempt.token) {
    if (attempt.record?.status === 'unknown') {
      try {
        await requeueUnknownClaim(deps.reconciliationQueue, claimKey, attempt.record);
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'failed to requeue unknown reminder',
        );
      }
    }
    log.info({ reservationId: r.id }, 'reminder skipped: claim is already owned');
    return { channel: 'sms', success: false, outcome: 'unknown', provider: 'telnyx' };
  }

  try {
    const result = await deps.sendReminder(reminderParams);
    if (result.skipped) {
      await recordNotificationResult(deps.claimStore, claimKey, attempt.token, 'failure_certain');
      return result;
    }
    await recordWorkerResult(deps, claimKey, attempt.token, result);
    return result;
  } catch (err) {
    const outcome = classifyNotificationError(err);
    const result = {
      channel: 'sms' as const,
      success: false,
      outcome,
      provider: 'telnyx' as const,
      error: err instanceof Error ? err.message : String(err),
    };
    await recordWorkerResult(deps, claimKey, attempt.token, result);
    if (outcome === 'failure_certain') throw err;
    log.error({ outcome }, 'reminder provider result unknown');
    return result;
  }
}

export async function processConfirmationSmsJob(
  job: Job<ConfirmationSmsJobData>,
  deps: ConfirmationSmsDependencies = getDefaultDependencies(),
): Promise<{
  sent: number;
  whatsappCount: number;
  smsCount: number;
  total: number;
} | void> {
  const log = jobLogger(job);
  const data = job.data;

  if (data.kind === 'scan') {
    // Broad UTC bounds cover tomorrow in every IANA timezone. Each current row
    // is checked against its own local calendar immediately before sending.
    const now = new Date();
    const horizon = new Date(now.getTime() + 72 * 60 * 60 * 1000);

    const reservations = await deps.db.reservation.findMany({
      where: {
        channel: 'WEB',
        status: 'CONFIRMED',
        OR: [
          { startsAt: { gt: now, lt: horizon } },
          { startsAt: null, reservedAt: { gt: now, lt: horizon } },
        ],
        customerPhone: { not: null },
        confirmationStatus: { in: ['NOT_REQUIRED', 'PENDING'] },
        confirmationSentAt: null,
      },
      include: { restaurant: { select: { name: true, id: true, timezone: true } } },
    });

    log.info({ count: reservations.length }, 'rappel scan: reservations to remind');

    let sent = 0;
    let whatsappCount = 0;
    let smsCount = 0;
    let retryQueueFailed = false;
    for (const r of reservations) {
      if (!r.customerPhone) continue;

      try {
        const latest = await deps.db.reservation.findUnique({
          where: { id: r.id },
          include: { restaurant: { select: { name: true, id: true, timezone: true } } },
        });
        if (!latest || !isReminderEligible(latest)) {
          log.info({ reservationId: r.id }, 'reminder skipped: reservation no longer eligible');
          continue;
        }
        const result = await processReminderForReservation(deps, log, latest);
        if (result.skipped) {
          log.info({ reservationId: r.id, reason: result.skipped }, 'reminder skipped');
          continue;
        }
        if (getResultOutcome(result) === 'success') {
          await deps.db.reservation.update({
            where: { id: r.id },
            data: {
              confirmationStatus: 'PENDING',
              confirmationSentAt: new Date(),
            },
          });
          sent++;
          if (result.channel === 'whatsapp') whatsappCount++;
          else smsCount++;
        } else if (getResultOutcome(result) === 'failure_certain') {
          log.warn(
            { reservationId: r.id, channel: result.channel, outcome: result.outcome },
            'reminder send refused — BullMQ will retry the deterministic job',
          );
          throw new NotificationProviderRefusedError(result.provider ?? 'telnyx', result.channel);
        } else {
          log.warn(
            { reservationId: r.id, channel: result.channel, outcome: result.outcome },
            'reminder send result unknown, status not updated',
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error({ err: message, reservationId: r.id }, 'failed to send reminder');
        try {
          if (!deps.reminderQueue) throw new Error('reminder queue unavailable');
          await deps.reminderQueue.add(
            'send-reminder',
            { kind: 'send', reservationId: r.id },
            { jobId: buildReservationNotificationJobId('reminder', r.id) },
          );
        } catch (queueError) {
          retryQueueFailed = true;
          log.error({ err: queueError, reservationId: r.id }, 'failed to queue reminder retry');
        }
      }
    }

    if (retryQueueFailed) throw new Error('failed to queue one or more reminder retries');
    log.info({ sent, whatsappCount, smsCount, total: reservations.length }, 'rappel scan complete');
    return { sent, whatsappCount, smsCount, total: reservations.length };
  }

  if (data.kind === 'send' && data.reservationId) {
    const r = await deps.db.reservation.findUniqueOrThrow({
      where: { id: data.reservationId },
      include: { restaurant: { select: { name: true, id: true, timezone: true } } },
    });
    if (!r.customerPhone) {
      log.warn({ reservationId: r.id }, 'no customer phone, skipping');
      return;
    }
    if (!isReminderEligible(r)) {
      log.info({ reservationId: r.id }, 'reminder skipped: reservation no longer eligible');
      return;
    }

    try {
      const result = await processReminderForReservation(deps, log, r);
      if (result.skipped) {
        log.info({ reservationId: r.id, reason: result.skipped }, 'reminder skipped');
        return;
      }
      if (getResultOutcome(result) === 'success') {
        await deps.db.reservation.update({
          where: { id: r.id },
          data: {
            confirmationStatus: 'PENDING',
            confirmationSentAt: new Date(),
          },
        });
        log.info({ reservationId: r.id, channel: result.channel }, 'reminder sent');
      } else if (getResultOutcome(result) === 'failure_certain') {
        log.warn(
          { reservationId: r.id, channel: result.channel, outcome: result.outcome },
          'reminder send refused — BullMQ will retry the deterministic job',
        );
        throw new NotificationProviderRefusedError(result.provider ?? 'telnyx', result.channel);
      } else {
        log.warn(
          { reservationId: r.id, channel: result.channel, outcome: result.outcome },
          'reminder send result unknown, status not updated',
        );
      }
    } catch (err) {
      throw err;
    }
  }
}

export const confirmationSmsWorker = new Worker(
  'confirmation-sms',
  (job) => processConfirmationSmsJob(job as Job<ConfirmationSmsJobData>),
  { connection: redisQueue, concurrency: CONFIRMATION_SMS_WORKER_CONCURRENCY },
);

setupWorkerListeners(confirmationSmsWorker);
