import { ReservationPaymentType } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { retrieveConnectedAccount } from '../gift-cards/stripe.service';
import {
  ReservationPaymentInputError,
  ReservationPaymentStateError,
  createReservationPaymentPolicy,
} from './reservation-payment.service';

/** Réglages de l'écran « Empreinte bancaire » (spec §2–§3). */
export const CardGuaranteeSettingsSchema = z.object({
  enabled: z.boolean(),
  minPartySize: z.number().int().min(1).max(100).nullable(),
  protectedDates: z
    .array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .max(60)
    .transform((dates) => [...new Set(dates)].sort()),
  amountPerPerson: z.union([z.string().trim(), z.number().finite()]),
  cancellationHours: z.number().int().min(0).max(72),
});
export type CardGuaranteeSettingsInput = z.infer<typeof CardGuaranteeSettingsSchema>;

export type CardGuaranteeSettings = {
  enabled: boolean;
  minPartySize: number | null;
  protectedDates: string[];
  amountPerPerson: string;
  cancellationHours: number;
  version: number | null;
};

const DEFAULTS: CardGuaranteeSettings = {
  enabled: false,
  minPartySize: 6,
  protectedDates: [],
  amountPerPerson: '20.00',
  cancellationHours: 24,
  version: null,
};

function activeWhere(restaurantId: string, now: Date) {
  return {
    restaurantId,
    type: ReservationPaymentType.CARD_GUARANTEE,
    activeFrom: { lte: now },
    OR: [{ activeUntil: null }, { activeUntil: { gt: now } }],
  };
}

/** Réglage en vigueur, ou les valeurs proposées par défaut si l'empreinte est coupée. */
export async function getCardGuaranteeSettings(
  restaurantId: string,
  now = new Date(),
): Promise<CardGuaranteeSettings> {
  const active = await db.reservationPaymentPolicy.findFirst({
    where: activeWhere(restaurantId, now),
    orderBy: { version: 'desc' },
    select: {
      version: true,
      amount: true,
      minPartySize: true,
      cancellationHours: true,
      rules: true,
    },
  });
  if (!active) return DEFAULTS;
  const rules = (active.rules ?? {}) as { protectedDates?: unknown };
  return {
    enabled: true,
    minPartySize: active.minPartySize,
    protectedDates: Array.isArray(rules.protectedDates)
      ? rules.protectedDates.filter((date): date is string => typeof date === 'string')
      : [],
    amountPerPerson: active.amount.toFixed(2),
    cancellationHours: active.cancellationHours,
    version: active.version,
  };
}

/**
 * Activer ou modifier crée une nouvelle version de la politique (les réservations déjà prises
 * gardent leur snapshot) et clôt les précédentes ; couper clôt la version en vigueur.
 */
export async function saveCardGuaranteeSettings(
  restaurantId: string,
  input: CardGuaranteeSettingsInput,
  now = new Date(),
): Promise<CardGuaranteeSettings> {
  if (input.enabled) {
    if (input.minPartySize === null && input.protectedDates.length === 0) {
      throw new ReservationPaymentInputError(
        'PAYMENT_POLICY_INVALID',
        'Choisissez un nombre de couverts ou au moins une date.',
      );
    }
    const amount = Number(input.amountPerPerson);
    if (!Number.isFinite(amount) || amount < 1 || amount > 200) {
      throw new ReservationPaymentInputError(
        'PAYMENT_AMOUNT_INVALID',
        'Le montant par personne est compris entre 1 et 200 €.',
      );
    }
    // tenant-scoping: global — table Restaurant, id du restaurant de la session.
    const restaurant = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { giftCardStripeAccountId: true },
    });
    const account = restaurant?.giftCardStripeAccountId
      ? await retrieveConnectedAccount(restaurant.giftCardStripeAccountId)
      : null;
    if (!account?.chargesEnabled) {
      throw new ReservationPaymentStateError('PAYMENT_PROVIDER_NOT_READY');
    }
    const created = await createReservationPaymentPolicy({
      restaurantId,
      type: ReservationPaymentType.CARD_GUARANTEE,
      amountMode: 'PER_PERSON',
      amount: input.amountPerPerson,
      minPartySize: input.minPartySize,
      cancellationHours: input.cancellationHours,
      rules: { protectedDates: input.protectedDates },
      activeFrom: now,
    });
    await db.reservationPaymentPolicy.updateMany({
      where: { ...activeWhere(restaurantId, now), id: { not: created.id } },
      data: { activeUntil: now },
    });
  } else {
    await db.reservationPaymentPolicy.updateMany({
      where: activeWhere(restaurantId, now),
      data: { activeUntil: now },
    });
  }
  return getCardGuaranteeSettings(restaurantId, new Date(now.getTime() + 1));
}
