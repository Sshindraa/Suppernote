import { ReservationPaymentStatus, ReservationPaymentType } from '@prisma/client';
import { db } from '../../shared/db/client';
import {
  ReservationPaymentPolicyNotFoundError,
  ReservationPaymentReservationNotFoundError,
  ReservationPaymentStateError,
  createCardGuaranteePaymentInTransaction,
} from './reservation-payment.service';
import { cardGuaranteeLinksConfigured } from './reservation-guarantee.public';
import { enqueueCardGuaranteeSms } from './reservation-guarantee.sms';

/** Une demande de l'équipe reste ouverte 24 h au plus (limite d'une page Stripe), et jamais après le service. */
const STAFF_REQUEST_MAX_MS = 24 * 60 * 60 * 1000;

const OPEN_STATUSES = [
  ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
  ReservationPaymentStatus.REQUIRES_ACTION,
  ReservationPaymentStatus.AUTHORIZED,
];

/**
 * « Demander une empreinte » sur une réservation déjà prise (téléphone, équipe) : le client reçoit
 * le lien par SMS. La réservation reste confirmée ; seule la politique en vigueur fixe le montant.
 */
export async function requestCardGuaranteeByStaff(input: {
  restaurantId: string;
  reservationId: string;
  now?: Date;
}): Promise<{ paymentId: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const reservation = await db.reservation.findFirst({
    where: { id: input.reservationId, restaurantId: input.restaurantId },
    select: {
      id: true,
      state: true,
      partySize: true,
      startsAt: true,
      reservedAt: true,
      customerPhone: true,
      restaurant: { select: { slug: true, giftCardStripeAccountId: true } },
    },
  });
  if (!reservation) throw new ReservationPaymentReservationNotFoundError();
  const startsAt = reservation.startsAt ?? reservation.reservedAt;
  if (
    !['PENDING', 'CONFIRMED'].includes(reservation.state) ||
    startsAt <= now ||
    !reservation.customerPhone ||
    !reservation.restaurant.slug ||
    !reservation.restaurant.giftCardStripeAccountId ||
    !cardGuaranteeLinksConfigured()
  ) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  const open = await db.reservationPayment.findFirst({
    where: {
      restaurantId: input.restaurantId,
      reservationId: reservation.id,
      status: { in: OPEN_STATUSES },
    },
    select: { id: true },
  });
  if (open) throw new ReservationPaymentStateError('PAYMENT_IDEMPOTENCY_CONFLICT');
  const policy = await db.reservationPaymentPolicy.findFirst({
    where: {
      restaurantId: input.restaurantId,
      type: ReservationPaymentType.CARD_GUARANTEE,
      activeFrom: { lte: now },
      OR: [{ activeUntil: null }, { activeUntil: { gt: now } }],
    },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  if (!policy) throw new ReservationPaymentPolicyNotFoundError();

  const expiresAt = new Date(Math.min(now.getTime() + STAFF_REQUEST_MAX_MS, startsAt.getTime()));
  const paymentId = await db.$transaction((tx) =>
    createCardGuaranteePaymentInTransaction(tx, {
      restaurantId: input.restaurantId,
      reservationId: reservation.id,
      policyId: policy.id,
      partySize: reservation.partySize,
      expiresAt,
      idempotencyKey: `card-guarantee:${reservation.id}:${now.getTime()}`,
    }),
  );
  await enqueueCardGuaranteeSms('link', { id: paymentId, restaurantId: input.restaurantId });
  return { paymentId, expiresAt };
}

/** « Renvoyer le lien » tant que la carte n'est pas enregistrée et que le délai court. */
export async function resendCardGuaranteeLink(input: {
  restaurantId: string;
  reservationId: string;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const payment = await db.reservationPayment.findFirst({
    where: { restaurantId: input.restaurantId, reservationId: input.reservationId },
    orderBy: [{ createdAt: 'desc' }],
    select: { id: true, restaurantId: true, status: true, expiresAt: true },
  });
  if (
    !payment ||
    payment.status !== ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD ||
    !payment.expiresAt ||
    payment.expiresAt <= now
  ) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  await enqueueCardGuaranteeSms('link', payment, String(now.getTime()));
}
