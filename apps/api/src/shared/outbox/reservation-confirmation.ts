import type { Prisma } from '@prisma/client';
import { enqueue } from './outbox.service';

/**
 * Réservation web sans e-mail : le SMS est la seule confirmation possible, il part même quand le
 * restaurant a coupé `smsConfirmEnabled` (décision du 2026-11-15). Jamais pour une réservation test.
 */
export function isWebConfirmationSmsFallback(reservation: {
  channel: string;
  customerEmail?: string | null;
  isTest?: boolean;
}): boolean {
  return reservation.channel === 'WEB' && !reservation.customerEmail && !reservation.isTest;
}

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
  // Confirmation par e-mail pour le web, l'équipe et les assistants IA (MCP). SMS en plus pour une
  // réservation créée par l'équipe, et à la place de l'e-mail pour le web quand le client n'en a
  // pas donné (sinon il ne recevrait rien). Le téléphone a son propre envoi SMS.
  const emailChannel = ['WEB', 'ADMIN', 'MCP'].includes(reservation.channel);
  const webWithoutEmail = isWebConfirmationSmsFallback(reservation);
  const smsChannel = reservation.channel === 'ADMIN' || webWithoutEmail;
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
  if (webWithoutEmail) {
    await enqueueConfirmationSms(tx, reservation);
    return true;
  }
  const restaurant = await tx.restaurant.findUnique({
    where: { id: reservation.restaurantId },
    select: { smsConfirmEnabled: true },
  });
  if (restaurant?.smsConfirmEnabled !== true) return queued;
  await enqueueConfirmationSms(tx, reservation);
  return true;
}

async function enqueueConfirmationSms(
  tx: Prisma.TransactionClient,
  reservation: { id: string; restaurantId: string },
): Promise<void> {
  await enqueue(tx, {
    restaurantId: reservation.restaurantId,
    topic: 'reservation-confirmation',
    aggregateType: 'reservation',
    aggregateId: reservation.id,
    eventType: 'reservation.confirmation.requested',
    idempotencyKey: `reservation-confirmation:${reservation.id}`,
    payload: { reservationId: reservation.id },
  });
}
