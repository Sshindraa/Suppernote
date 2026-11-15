import { Worker, type Job } from 'bullmq';
import { redisQueue, redisSession } from '../../redis/client';
import { sendSms } from '../../telnyx/client';
import { db } from '../../db/client';
import { queues } from '../queues';
import { setupWorkerListeners, jobLogger } from './helper';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  classifyNotificationError,
  enqueueNotificationReconciliation,
  getNotificationErrorProviderMessageId,
  normalizeNotificationSendResult,
  NotificationProviderRefusedError,
  recordNotificationResult,
} from '../notification-idempotency';
import { fitToOneSegment } from '../../messaging/confirmation-text';

export async function processManagerSmsJob(job: Job): Promise<void> {
  const log = jobLogger(job);
  const { restaurantId } = job.data;
  let { message, phoneNumber } = job.data;
  if (!job.id) throw new Error('manager SMS job id required');

  if (job.name !== 'reply-cancellation') {
    const rateKey = `sms:manager:${restaurantId}`;
    const allowed = await redisSession.set(
      rateKey,
      job.id,
      'EX',
      Number(process.env.SMS_RATE_LIMIT_SECONDS ?? 900),
      'NX',
    );
    if (!allowed && (await redisSession.get(rateKey)) !== job.id) {
      log.warn('[SMS] Manager alert rate-limited for restaurant');
      return;
    }
  }

  if (job.name === 'reply-cancellation') {
    const reservation = await db.reservation.findFirst({
      where: { id: job.data.reservationId, restaurantId },
      include: { restaurant: { select: { managerPhone: true, timezone: true } } },
    });
    if (!reservation?.restaurant.managerPhone) return;
    const dateStr = reservation.reservedAt.toLocaleDateString('fr-FR', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      timeZone: reservation.restaurant.timezone,
    });
    const timeStr = reservation.reservedAt.toLocaleTimeString('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: reservation.restaurant.timezone,
    });
    phoneNumber = reservation.restaurant.managerPhone;
    const via = job.data.channel === 'whatsapp' ? 'WhatsApp' : 'SMS';
    message = fitToOneSegment(
      reservation.customerName,
      (name) =>
        `Table libérée : ${name} a annulé sa résa du ${dateStr} ${timeStr} (${reservation.partySize} pers.) via ${via}.`,
    );
  }

  // Resolve the recipient before claiming a provider attempt, so database failures can retry.
  const to =
    phoneNumber ??
    (await db.restaurant.findUniqueOrThrow({ where: { id: restaurantId } })).managerPhone;
  const claimKey = buildNotificationClaimKey('manager-alert-sms', job.id);
  const claim = await acquireNotificationClaim(redisQueue, claimKey, {
    provider: 'telnyx',
    channel: 'sms',
  });
  if (!claim.acquired || !claim.token) {
    if (claim.record?.status === 'unknown') {
      await enqueueNotificationReconciliation(queues.reconciliation, {
        claimKey,
        provider: 'telnyx',
        channel: 'sms',
        ...(claim.record.providerMessageId
          ? { providerMessageId: claim.record.providerMessageId }
          : {}),
      });
    }
    return;
  }

  let resultRecorded = false;
  try {
    const result = normalizeNotificationSendResult(
      await sendSms(to, message, {
        restaurantId,
        sourceType: 'manager_alert',
        sourceId: `${restaurantId}:${job.id}`,
        metadata: { messageType: 'manager_alert' },
      }),
      'telnyx',
      'sms',
    );
    await recordNotificationResult(redisQueue, claimKey, claim.token, result.outcome, result);
    resultRecorded = true;
    if (result.outcome === 'failure_certain')
      throw new NotificationProviderRefusedError('telnyx', 'sms');
    if (result.outcome === 'unknown') {
      await enqueueNotificationReconciliation(queues.reconciliation, {
        claimKey,
        provider: 'telnyx',
        channel: 'sms',
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      });
      return;
    }
    log.info('[SMS] Manager alert sent');
  } catch (err) {
    if (resultRecorded || err instanceof NotificationProviderRefusedError) throw err;
    const outcome = classifyNotificationError(err);
    const providerMessageId = getNotificationErrorProviderMessageId(err);
    const transitioned = await recordNotificationResult(
      redisQueue,
      claimKey,
      claim.token,
      outcome,
      {
        provider: 'telnyx',
        channel: 'sms',
        ...(providerMessageId ? { providerMessageId } : {}),
      },
    );
    if (outcome === 'failure_certain') throw err;
    if (transitioned)
      await enqueueNotificationReconciliation(queues.reconciliation, {
        claimKey,
        provider: 'telnyx',
        channel: 'sms',
        ...(providerMessageId ? { providerMessageId } : {}),
      });
  }
}

export const smsManagerWorker = new Worker('sms-manager', processManagerSmsJob, {
  connection: redisQueue,
});
setupWorkerListeners(smsManagerWorker);
