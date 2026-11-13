import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReservationPaymentStatus, ReservationPaymentType } from '@prisma/client';
import { formatGuaranteeEuros } from '@suppernote/shared';
import { db } from '../../shared/db/client';
import { evaluateCapability } from '../entitlements/entitlement.service';
import {
  computeReservationPaymentAmount,
  startCardGuaranteeSetup,
} from './reservation-payment.service';

/** Une place tenue sur le web attend la carte 30 min (minimum Stripe pour une page Checkout). */
export const WEB_CARD_GUARANTEE_HOLD_MS = 30 * 60 * 1000;

export type CardGuaranteeTerms = {
  policyId: string;
  amountPerPerson: string;
  totalAmount: string;
  currency: 'EUR';
  cancellationHours: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Même secret que les liens de gestion de réservation, avec une séparation de domaine explicite.
function linkKey(): Buffer | undefined {
  const value = process.env.RESERVATION_MANAGEMENT_SECRET;
  return value && /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : undefined;
}

function dashboardUrl(): URL | undefined {
  try {
    const url = new URL(process.env.DASHBOARD_URL ?? '');
    const local =
      process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname);
    return url.protocol === 'https:' || local ? url : undefined;
  } catch {
    return undefined;
  }
}

function signature(paymentId: string, restaurantId: string, key: Buffer): Buffer {
  return createHmac('sha256', key)
    .update('reservation-card-guarantee-v1\0')
    .update(`${paymentId}\0${restaurantId}`)
    .digest();
}

export function cardGuaranteeToken(payment: { id: string; restaurantId: string }): string | null {
  const key = linkKey();
  if (!key || !UUID.test(payment.id)) return null;
  return `${payment.id.replace(/-/g, '')}.${signature(payment.id, payment.restaurantId, key).toString('base64url')}`;
}

/** Renvoie l'identifiant de paiement si le jeton a été signé pour ce restaurant. */
export function verifyCardGuaranteeToken(token: string, restaurantId: string): string | null {
  const key = linkKey();
  const match = /^([0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!key || !match) return null;
  const hex = match[1]!;
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const expected = signature(id, restaurantId, key);
  const given = Buffer.from(match[2]!, 'base64url');
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

/**
 * Conditions d'empreinte pour une table donnée, ou `null` quand aucune n'est demandée :
 * fonction ouverte, formule incluse, compte Stripe du restaurant ouvert, liens signables, et
 * groupe à partir du seuil ou date protégée.
 */
export async function findCardGuaranteeTerms(input: {
  restaurantId: string;
  partySize: number;
  localDate: string;
  now?: Date;
}): Promise<CardGuaranteeTerms | null> {
  if (process.env.RESERVATION_PAYMENTS_ENABLED !== 'true' || !linkKey() || !dashboardUrl()) {
    return null;
  }
  if (!DATE.test(input.localDate)) return null;
  const now = input.now ?? new Date();
  const policy = await db.reservationPaymentPolicy.findFirst({
    where: {
      restaurantId: input.restaurantId,
      type: ReservationPaymentType.CARD_GUARANTEE,
      activeFrom: { lte: now },
      OR: [{ activeUntil: null }, { activeUntil: { gt: now } }],
    },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      amount: true,
      amountMode: true,
      minPartySize: true,
      cancellationHours: true,
      rules: true,
    },
  });
  if (!policy) return null;
  const rules = (policy.rules ?? {}) as { protectedDates?: unknown };
  const protectedDates = Array.isArray(rules.protectedDates) ? rules.protectedDates : [];
  const applies =
    (policy.minPartySize !== null && input.partySize >= policy.minPartySize) ||
    protectedDates.includes(input.localDate);
  if (!applies) return null;

  const [restaurant, capability] = await Promise.all([
    // tenant-scoping: global — table Restaurant, id déjà résolu par le slug public.
    db.restaurant.findUnique({
      where: { id: input.restaurantId },
      select: { giftCardStripeAccountId: true },
    }),
    evaluateCapability(input.restaurantId, 'reservations.payments'),
  ]);
  if (!restaurant?.giftCardStripeAccountId || !capability.allowed) return null;

  const total = computeReservationPaymentAmount(policy, input.partySize);
  return {
    policyId: policy.id,
    amountPerPerson: (policy.amountMode === 'PER_PERSON'
      ? policy.amount
      : total.div(input.partySize)
    ).toFixed(2),
    totalAmount: total.toFixed(2),
    currency: 'EUR',
    cancellationHours: policy.cancellationHours,
  };
}

/** Texte court affiché sur la page Stripe (spec §8). */
export function cardGuaranteeCheckoutText(input: {
  restaurantName: string;
  totalAmount: string;
  cancellationHours: number;
}): string {
  return (
    `Aucun montant n’est débité aujourd’hui. Si vous annulez moins de ${input.cancellationHours} h ` +
    `avant, ou si vous ne venez pas sans prévenir, ${input.restaurantName} pourra prélever jusqu’à ` +
    `${formatGuaranteeEuros(input.totalAmount)}.`
  );
}

/** Adresse de la page Suppernote d'une empreinte (retour Stripe, lien SMS). */
export function cardGuaranteePageUrl(
  slug: string,
  token: string,
  retour?: 'ok' | 'annule',
): string {
  const url = new URL('/garantie', dashboardUrl());
  url.searchParams.set('r', slug);
  url.searchParams.set('t', token);
  if (retour) url.searchParams.set('retour', retour);
  return url.toString();
}

/** Ouvre la page Stripe d'une empreinte en attente. */
export async function openCardGuaranteeCheckout(input: {
  payment: { id: string; restaurantId: string; amount: { toFixed(digits: number): string } };
  slug: string;
  restaurantName: string;
  cancellationHours: number;
  termsAcceptedAt: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const token = cardGuaranteeToken(input.payment);
  if (!token) throw new Error('Liens d’empreinte non configurés.');
  return startCardGuaranteeSetup({
    restaurantId: input.payment.restaurantId,
    paymentId: input.payment.id,
    successUrl: cardGuaranteePageUrl(input.slug, token, 'ok'),
    cancelUrl: cardGuaranteePageUrl(input.slug, token, 'annule'),
    customText: cardGuaranteeCheckoutText({
      restaurantName: input.restaurantName,
      totalAmount: input.payment.amount.toFixed(2),
      cancellationHours: input.cancellationHours,
    }),
    termsAcceptedAt: input.termsAcceptedAt,
  });
}

export type PublicCardGuaranteeStatus = 'awaiting_card' | 'confirmed' | 'expired' | 'cancelled';

export function publicCardGuaranteeStatus(
  status: ReservationPaymentStatus,
  expiresAt: Date | null,
  now = new Date(),
): PublicCardGuaranteeStatus {
  switch (status) {
    case ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD:
    case ReservationPaymentStatus.REQUIRES_ACTION:
      return expiresAt && expiresAt <= now ? 'expired' : 'awaiting_card';
    case ReservationPaymentStatus.CANCELLED:
      return 'cancelled';
    case ReservationPaymentStatus.EXPIRED:
    case ReservationPaymentStatus.FAILED:
      return 'expired';
    default:
      return 'confirmed';
  }
}
