import { Worker, type Job } from 'bullmq';
import { redisQueue } from '../../redis/client';
import { sendSms } from '../../telnyx/client';
import { setupWorkerListeners, jobLogger } from './helper';
import { queues } from '../queues';
import { CALL_RECOVERY_WORKER_CONCURRENCY } from '../constants';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  classifyNotificationError,
  enqueueNotificationReconciliation,
  normalizeNotificationSendResult,
  NotificationProviderRefusedError,
  recordNotificationResult,
  type NotificationClaimStore,
  type NotificationProviderResult,
  type NotificationReconciliationQueue,
} from '../notification-idempotency';
import { recordNotificationProviderResult } from '../../observability/metrics';
import type { MessagingUsageContext } from '../../../modules/usage/messaging-usage.service';
import { fitToOneSegment, smsSafeText } from '../../messaging/confirmation-text';

export interface CallRecoveryJobData {
  callId: string;
  restaurantId: string;
  customerPhone: string;
  customerName: string | null;
  restaurantName: string;
  restaurantSlug: string | null;
  restaurantPhone: string | null;
  reason: 'no_action_with_intent' | 'handoff_dropped' | 'transport_error';
}

export interface CallRecoveryDependencies {
  claimStore: NotificationClaimStore;
  sendSms: typeof sendSms;
  reconciliationQueue?: NotificationReconciliationQueue;
  /**
   * Vérifie qu'aucune réservation n'a finalement été créée pour cet appel.
   * Le webhook de fin peut devancer de quelques secondes la création d'une
   * réservation ; sans ce contrôle, un client déjà réservé recevrait un SMS
   * de récupération.
   */
  reservationLookup?: (callId: string) => Promise<boolean>;
}

async function hasReservationForCall(callId: string): Promise<boolean> {
  const { db } = await import('../../db/client');
  // tenant-scoping: global — `callId` est unique sur Reservation : c'est une
  // lecture d'identité, pas une requête tenant.
  const reservation = await db.reservation.findFirst({
    where: { callId },
    select: { id: true },
  });
  return Boolean(reservation);
}

function resolveDependencies(
  input: NotificationClaimStore | CallRecoveryDependencies,
): CallRecoveryDependencies {
  if ('claimStore' in input) return input;
  return {
    claimStore: input,
    sendSms,
    reconciliationQueue: queues.reconciliation,
    reservationLookup: hasReservationForCall,
  };
}

async function requeueUnknownRecovery(
  queue: NotificationReconciliationQueue | undefined,
  claimKey: string,
  providerMessageId?: string,
): Promise<void> {
  if (!queue) return;
  await enqueueNotificationReconciliation(queue, {
    claimKey,
    provider: 'telnyx',
    channel: 'sms',
    ...(providerMessageId ? { providerMessageId } : {}),
  });
}

/**
 * Sends a single follow-up SMS to a caller whose reservation attempt
 * did not finalize. Idempotent via callId — BullMQ jobId = the same key.
 *
 * Failure handling: the queue policy (5 attempts with exponential backoff)
 * retries certain refusals; on terminal failure the job is moved to
 * dead-letter via setupWorkerListeners.
 */
export async function processCallRecoveryJob(
  job: Job,
  dependencies: NotificationClaimStore | CallRecoveryDependencies = redisQueue,
): Promise<void> {
  const log = jobLogger(job);
  const data = job.data as CallRecoveryJobData;
  const deps = resolveDependencies(dependencies);

  // Dernière vérification avant l'envoi : si une réservation a fini par être
  // créée (création en vol au moment du raccrochage), la récupération est
  // inutile et le SMS ne doit pas partir.
  if (deps.reservationLookup) {
    try {
      if (await deps.reservationLookup(data.callId)) {
        log.info({ callId: data.callId }, 'recovery SMS skipped: reservation was created');
        return;
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), callId: data.callId },
        'recovery reservation lookup failed',
      );
    }
  }

  const firstName = data.customerName ? smsSafeText(data.customerName).split(' ')[0] : '';
  const opening = firstName ? `Bonjour ${firstName}, ` : 'Bonjour, ';

  // Lien de réservation en ligne (Suppernote Connect) si le slug est disponible.
  const siteUrl = process.env.SITE_URL ?? 'https://suppernote.com';
  const bookingUrl =
    data.restaurantSlug != null ? `${siteUrl}/restaurant/${data.restaurantSlug}/book` : null;

  const tail = bookingUrl
    ? ` Réservez ici : ${bookingUrl}`
    : data.restaurantPhone
      ? ` Appelez le ${data.restaurantPhone} ou rappelez-nous.`
      : ' Rappelez-nous quand vous voulez.';

  const message = fitToOneSegment(
    data.restaurantName,
    (name) => `${opening}votre réservation chez ${name} n'est pas confirmée.${tail}`,
  );

  const claimKey = buildNotificationClaimKey('call-recovery-sms', data.callId);
  const claim = await acquireNotificationClaim(deps.claimStore, claimKey, {
    provider: 'telnyx',
    channel: 'sms',
  });
  if (!claim.acquired || !claim.token) {
    if (claim.record?.status === 'unknown') {
      try {
        await requeueUnknownRecovery(
          deps.reconciliationQueue,
          claimKey,
          claim.record.providerMessageId,
        );
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err), outcome: 'unknown' },
          'failed to requeue unknown recovery SMS',
        );
      }
    }
    log.info({ callId: data.callId, reason: data.reason }, 'recovery SMS skipped: duplicate claim');
    return;
  }

  try {
    const usageContext: MessagingUsageContext = {
      restaurantId: data.restaurantId,
      sourceType: 'call_recovery',
      sourceId: data.callId,
      metadata: { messageType: 'call_recovery', reason: data.reason },
    };
    const result = normalizeNotificationSendResult(
      await deps.sendSms(data.customerPhone, message, usageContext),
      'telnyx',
      'sms',
    );
    recordNotificationProviderResult('telnyx', 'sms', result.outcome);
    const transitioned = await recordNotificationResult(
      deps.claimStore,
      claimKey,
      claim.token,
      result.outcome,
      {
        provider: result.provider,
        channel: result.channel,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      },
    );
    if (result.outcome === 'unknown') {
      if (transitioned) {
        try {
          await requeueUnknownRecovery(
            deps.reconciliationQueue,
            claimKey,
            result.providerMessageId,
          );
        } catch (err) {
          log.error(
            { err: err instanceof Error ? err.message : String(err), outcome: 'unknown' },
            'failed to queue recovery SMS reconciliation',
          );
        }
      }
      log.warn({ outcome: 'unknown' }, 'recovery SMS provider result unknown');
      return;
    }
    if (result.outcome === 'failure_certain') {
      log.warn({ outcome: result.outcome }, 'recovery SMS provider refused the message');
      throw new NotificationProviderRefusedError(result.provider, result.channel);
    }
  } catch (err) {
    if (err instanceof NotificationProviderRefusedError) throw err;
    const outcome: NotificationProviderResult = classifyNotificationError(err);
    recordNotificationProviderResult('telnyx', 'sms', outcome);
    const providerMessageId =
      err &&
      typeof err === 'object' &&
      'providerMessageId' in err &&
      typeof (err as { providerMessageId?: unknown }).providerMessageId === 'string'
        ? (err as { providerMessageId: string }).providerMessageId
        : undefined;
    const transitioned = await recordNotificationResult(
      deps.claimStore,
      claimKey,
      claim.token,
      outcome,
      {
        provider: 'telnyx',
        channel: 'sms',
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    );
    if (outcome === 'unknown') {
      if (transitioned) {
        try {
          await requeueUnknownRecovery(deps.reconciliationQueue, claimKey, providerMessageId);
        } catch (reconciliationError) {
          log.error(
            {
              err:
                reconciliationError instanceof Error
                  ? reconciliationError.message
                  : String(reconciliationError),
              outcome: 'unknown',
            },
            'failed to queue recovery SMS reconciliation',
          );
        }
      }
      log.warn({ outcome }, 'recovery SMS provider result unknown');
      return;
    }
    throw err;
  }

  // Best-effort analytics event so the dashboard counter increments
  // even if a downstream reservation is never created.
  try {
    await queues.analytics.add('call-recovery-sent', {
      restaurantId: data.restaurantId,
      callId: data.callId,
      reason: data.reason,
      sentAt: new Date().toISOString(),
    });
  } catch (err) {
    log.warn({ err }, 'failed to enqueue recovery analytics event');
  }

  log.info({ callId: data.callId, reason: data.reason }, 'recovery SMS sent');
}

export const callRecoveryWorker = new Worker(
  'call-recovery',
  (job) => processCallRecoveryJob(job),
  {
    connection: redisQueue,
    concurrency: CALL_RECOVERY_WORKER_CONCURRENCY,
  },
);

setupWorkerListeners(callRecoveryWorker);
