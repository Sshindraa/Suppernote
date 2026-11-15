import type { Prisma } from '@prisma/client';
import { enqueue } from './outbox.service';

export async function enqueueReservationConfirmation(
  tx: Prisma.TransactionClient,
  reservation: {
    id: string;
    restaurantId: string;
    state: string;
    customerPhone: string | null;
    customerEmail?: string | null;
    channel: string;
    isTest?: boolean;
  },
): Promise<boolean> {
  // Confirmation par e-mail pour le web, l'équipe et les assistants IA (MCP) ; SMS en plus
  // seulement pour une réservation créée par l'équipe. Le téléphone a son propre envoi SMS.
  const emailChannel = ['WEB', 'ADMIN', 'MCP'].includes(reservation.channel);
  const smsChannel = reservation.channel === 'ADMIN';
  if (reservation.state !== 'CONFIRMED') return false;
  let queued = false;
  if (emailChannel && reservation.customerEmail && !reservation.isTest) {
    await enqueue(tx, {
      restaurantId: reservation.restaurantId,
      topic: 'reservation-confirmation-email',
      aggregateType: 'reservation',
      aggregateId: reservation.id,
      eventType: 'reservation.confirmation_email.requested',
      idempotencyKey: `reservation-confirmation-email:${reservation.id}`,
      payload: { reservationId: reservation.id },
    });
    queued = true;
  }
  if (!smsChannel || !reservation.customerPhone) return queued;
  const restaurant = await tx.restaurant.findUnique({
    where: { id: reservation.restaurantId },
    select: { smsConfirmEnabled: true },
  });
  if (restaurant?.smsConfirmEnabled !== true) return queued;
  await enqueue(tx, {
    restaurantId: reservation.restaurantId,
    topic: 'reservation-confirmation',
    aggregateType: 'reservation',
    aggregateId: reservation.id,
    eventType: 'reservation.confirmation.requested',
    idempotencyKey: `reservation-confirmation:${reservation.id}`,
    payload: { reservationId: reservation.id },
  });
  return true;
}
