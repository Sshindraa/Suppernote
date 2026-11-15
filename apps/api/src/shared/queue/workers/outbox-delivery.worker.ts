import { processGiftCardDelivery } from '../../../modules/gift-cards/gift-card-delivery.service';
import { Worker, type Job } from 'bullmq';
import { redisQueue } from '../../redis/client';
import { db } from '../../db/client';
import { isWebConfirmationSmsFallback } from '../../outbox/reservation-confirmation';
import { queues } from '../queues';
import { buildReservationNotificationJobId } from '../job-options';
import { utcToZonedParts, isSlotStartPast } from '../../timezone/restaurant-time';
import { jobLogger, setupWorkerListeners } from './helper';
import {
  recordPricedUsageEvent,
  type RecordPricedUsageInput,
} from '../../../modules/usage/usage-tariff.service';
import { processReservationConfirmationEmail } from '../../../modules/reservations/reservation-confirmation-email';
import { sendReputationFeedbackEmail } from '../../../modules/reputation/reputation-email.service';

export interface OutboxDeliveryJobData {
  readonly outboxEventId: string;
}

/** Consume the currently supported outbox topic. Consumers remain idempotent. */
export async function processOutboxDeliveryJob(job: Job<OutboxDeliveryJobData>): Promise<void> {
  const log = jobLogger(job);
  const event = await db.outboxEvent.findUnique({ where: { id: job.data.outboxEventId } });
  if (!event) {
    log.warn({ outboxEventId: job.data.outboxEventId }, '[outbox] event not found');
    return;
  }

  if (event.topic === 'gift-card-delivery') {
    const payload = event.payload as { deliveryId?: unknown };
    if (typeof payload.deliveryId !== 'string' || !payload.deliveryId)
      throw new Error('INVALID_GIFT_CARD_DELIVERY_PAYLOAD');
    await processGiftCardDelivery(db, payload.deliveryId);
    return;
  }

  if (event.topic === 'usage') {
    const payload = event.payload as unknown as RecordPricedUsageInput & {
      occurredAt: string | Date;
    };
    const occurredAt =
      payload.occurredAt instanceof Date ? payload.occurredAt : new Date(payload.occurredAt);
    await recordPricedUsageEvent({ ...payload, occurredAt });
    log.info({ outboxEventId: event.id, topic: event.topic }, '[outbox] event consumed');
    return;
  }

  if (event.topic === 'reservation-confirmation') {
    const payload = event.payload as { reservationId?: unknown };
    if (
      typeof payload.reservationId !== 'string' ||
      !payload.reservationId ||
      !event.restaurantId ||
      payload.reservationId !== event.aggregateId
    ) {
      throw new Error('INVALID_RESERVATION_CONFIRMATION_PAYLOAD');
    }
    const reservation = await db.reservation.findUnique({
      where: { id: payload.reservationId, restaurantId: event.restaurantId },
      include: { restaurant: { select: { name: true, timezone: true, smsConfirmEnabled: true } } },
    });
    if (
      !reservation ||
      reservation.state !== 'CONFIRMED' ||
      reservation.status !== 'CONFIRMED' ||
      !reservation.customerPhone ||
      (!reservation.restaurant.smsConfirmEnabled && !isWebConfirmationSmsFallback(reservation))
    )
      return;
    const instant = reservation.startsAt ?? reservation.reservedAt;
    if (isSlotStartPast(instant)) return;
    await queues.smsClient.add(
      'client-confirm',
      // Preserve the historical queue payload for rolling deployments/rollback.
      // The current SMS worker rereads the booking before the provider call.
      {
        reservationId: payload.reservationId,
        customerPhone: reservation.customerPhone,
        customerName: reservation.customerName,
        restaurantName: reservation.restaurant.name,
        partySize: reservation.partySize,
        date: instant.toLocaleDateString('fr-FR', { timeZone: reservation.restaurant.timezone }),
        time: utcToZonedParts(instant, reservation.restaurant.timezone).time,
      },
      {
        jobId: buildReservationNotificationJobId('confirmation', payload.reservationId),
      },
    );
    return;
  }

  if (event.topic === 'reservation-confirmation-email') {
    const payload = event.payload as { reservationId?: unknown };
    if (
      typeof payload.reservationId !== 'string' ||
      !payload.reservationId ||
      !event.restaurantId ||
      payload.reservationId !== event.aggregateId
    ) {
      throw new Error('INVALID_RESERVATION_CONFIRMATION_EMAIL_PAYLOAD');
    }
    await processReservationConfirmationEmail({
      reservationId: payload.reservationId,
      restaurantId: event.restaurantId,
    });
    return;
  }

  if (event.topic === 'reputation-feedback-email') {
    const payload = event.payload as { reservationId?: unknown };
    if (
      typeof payload.reservationId !== 'string' ||
      !event.restaurantId ||
      payload.reservationId !== event.aggregateId
    ) {
      throw new Error('INVALID_REPUTATION_EMAIL_PAYLOAD');
    }
    const result = await sendReputationFeedbackEmail({
      reservationId: payload.reservationId,
      restaurantId: event.restaurantId,
    });
    if (result === 'defer') {
      const now = new Date();
      const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
      await queues.outboxDelivery.add(
        'deliver',
        { outboxEventId: event.id },
        {
          jobId: `feedback_${event.id}_${next}`,
          delay: Math.max(1000, next - now.getTime()),
          attempts: 5,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    }
    return;
  }

  throw new Error(`Unsupported outbox topic: ${event.topic}`);
}

export const outboxDeliveryWorker = new Worker('outbox-delivery', processOutboxDeliveryJob, {
  connection: redisQueue,
});

setupWorkerListeners(outboxDeliveryWorker);
