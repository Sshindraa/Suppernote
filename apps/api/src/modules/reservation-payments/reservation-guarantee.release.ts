import { type Prisma, ReservationPaymentStatus } from '@prisma/client';
import { db } from '../../shared/db/client';
import { logger } from '../../shared/logger/pino';
import {
  detachReservationGuaranteeCard,
  expireExperienceCheckoutSession,
} from '../gift-cards/stripe.service';

const OPEN_STATUSES = [
  ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
  ReservationPaymentStatus.REQUIRES_ACTION,
  ReservationPaymentStatus.AUTHORIZED,
];

function snapshotOf(value: Prisma.JsonValue): { type?: unknown; cancellationHours?: unknown } {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as { type?: unknown; cancellationHours?: unknown })
    : {};
}

/**
 * Appelé dans la transaction qui annule une réservation. Une empreinte encore en attente, ou une
 * carte enregistrée annulée dans le délai gratuit, est fermée (`CANCELLED`) : plus aucun
 * prélèvement possible. Une annulation tardive garde l'empreinte `AUTHORIZED` (prélevable).
 * Ne dépend pas du service de cycle de vie, qui l'importe.
 */
export async function releaseCardGuaranteeOnCancel(
  tx: Prisma.TransactionClient,
  reservation: { id: string; restaurantId: string; startsAt: Date | null; reservedAt: Date },
  now = new Date(),
): Promise<boolean> {
  const payment = await tx.reservationPayment.findFirst({
    where: {
      restaurantId: reservation.restaurantId,
      reservationId: reservation.id,
      status: { in: OPEN_STATUSES },
    },
    orderBy: [{ createdAt: 'desc' }],
    select: { id: true, status: true, policySnapshot: true },
  });
  if (!payment) return false;
  const snapshot = snapshotOf(payment.policySnapshot);
  if (snapshot.type !== 'CARD_GUARANTEE') return false;
  const hours = typeof snapshot.cancellationHours === 'number' ? snapshot.cancellationHours : 24;
  const startsAt = reservation.startsAt ?? reservation.reservedAt;
  const free =
    payment.status !== ReservationPaymentStatus.AUTHORIZED ||
    now.getTime() <= startsAt.getTime() - hours * 3_600_000;
  if (!free) return false;
  const updated = await tx.reservationPayment.updateMany({
    where: { id: payment.id, restaurantId: reservation.restaurantId, status: payment.status },
    data: { status: ReservationPaymentStatus.CANCELLED },
  });
  return updated.count === 1;
}

/** Après la transaction : ferme la page Stripe et détache la carte d'une empreinte fermée. */
export async function cleanUpCancelledCardGuarantee(
  restaurantId: string,
  reservationId: string,
): Promise<void> {
  try {
    const payment = await db.reservationPayment.findFirst({
      where: { restaurantId, reservationId, status: ReservationPaymentStatus.CANCELLED },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        id: true,
        stripeAccountId: true,
        stripeCheckoutSessionId: true,
        stripePaymentMethodId: true,
      },
    });
    if (!payment?.stripeAccountId) return;
    if (payment.stripePaymentMethodId) {
      await detachReservationGuaranteeCard(payment.stripePaymentMethodId, payment.stripeAccountId);
    } else if (payment.stripeCheckoutSessionId) {
      await expireExperienceCheckoutSession(
        payment.stripeCheckoutSessionId,
        payment.stripeAccountId,
      );
    }
  } catch (error) {
    // Hygiène seulement : l'empreinte est déjà fermée en base, aucun prélèvement n'est possible.
    logger.warn(
      { reservationId, err: error instanceof Error ? error.message : String(error) },
      'reservation guarantee: Stripe cleanup after cancellation failed',
    );
  }
}
