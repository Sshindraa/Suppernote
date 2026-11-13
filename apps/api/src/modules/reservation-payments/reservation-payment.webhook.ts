import { createHash } from 'node:crypto';
import type Stripe from 'stripe';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { logger } from '../../shared/logger/pino';
import {
  RESERVATION_GUARANTEE_METADATA_TYPE,
  ReservationPaymentInputError,
  ReservationPaymentNotFoundError,
  ReservationPaymentPolicyNotFoundError,
  ReservationPaymentReservationNotFoundError,
  ReservationPaymentStateError,
  applyReservationPaymentProviderEvent,
  type ReservationPaymentProviderEventResult,
} from './reservation-payment.service';
import { enqueueConfirmationAfterCardGuarantee } from './reservation-guarantee.sms';

const MetadataSchema = z.object({
  type: z.literal(RESERVATION_GUARANTEE_METADATA_TYPE),
  restaurantId: z.string().trim().min(1).max(128),
  reservationPaymentId: z.string().trim().min(1).max(128),
});

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function idValue(value: unknown): string | undefined {
  return stringValue(value) ?? stringValue((value as { id?: unknown } | null)?.id);
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export type ReservationPaymentWebhookOutcome =
  | ({ handled: true } & ReservationPaymentProviderEventResult)
  | { handled: true; rejected: string }
  | { handled: false };

/**
 * Aiguillage des événements d'empreinte reçus sur `/webhooks/stripe` (endpoint Connect partagé
 * avec les cartes cadeaux et les expériences). Il passe AVANT toute autre logique : un PaymentIntent
 * d'empreinte ne doit jamais atteindre la branche cartes cadeaux (même piège que #707).
 *
 * Un événement signé mais incohérent est acquitté (200) et journalisé : le rejouer ne le corrigerait
 * pas et des échecs répétés désactiveraient l'endpoint partagé. Une panne technique remonte (500).
 */
export async function handleReservationPaymentStripeEvent(
  event: Stripe.Event,
  rawBody: string,
): Promise<ReservationPaymentWebhookOutcome> {
  const object = event.data.object as unknown as Record<string, unknown>;
  const isChargeEvent = event.type.startsWith('charge.');
  let target: { restaurantId: string; paymentId: string } | null = null;

  const metadata = MetadataSchema.safeParse(object.metadata);
  if (metadata.success) {
    target = {
      restaurantId: metadata.data.restaurantId,
      paymentId: metadata.data.reservationPaymentId,
    };
  } else if (isChargeEvent) {
    // Remboursements et litiges : rattachés par le PaymentIntent déjà enregistré.
    const paymentIntentId = idValue(object.payment_intent);
    const row = paymentIntentId
      ? await db.reservationPayment.findUnique({
          where: { stripePaymentIntentId: paymentIntentId },
          select: { id: true, restaurantId: true },
        })
      : null;
    if (row) target = { restaurantId: row.restaurantId, paymentId: row.id };
  }
  if (!target) return { handled: false };

  const amount =
    event.type === 'payment_intent.succeeded'
      ? (numberValue(object.amount_received) ?? numberValue(object.amount))
      : numberValue(object.amount);
  const refundedAmount = numberValue(object.amount_refunded);
  const currency = stringValue(object.currency)?.toUpperCase();
  const occurredAt = new Date(event.created * 1000);
  const paymentIntentId = isChargeEvent
    ? idValue(object.payment_intent)
    : event.type.startsWith('payment_intent.')
      ? stringValue(object.id)
      : undefined;
  const isSetupIntent = event.type.startsWith('setup_intent.');
  const lastError = object.last_payment_error as
    | { decline_code?: unknown; code?: unknown }
    | null
    | undefined;

  try {
    const result = await applyReservationPaymentProviderEvent({
      restaurantId: target.restaurantId,
      paymentId: target.paymentId,
      providerEventId: event.id,
      eventType: event.type,
      occurredAt: Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
      payloadHash: createHash('sha256').update(rawBody).digest('hex'),
      stripeAccountId: event.account ?? null,
      // Un litige porte sur un montant à part : on ne le compare pas au prélèvement.
      ...(amount !== undefined && !event.type.startsWith('charge.dispute.')
        ? { amount: amount / 100 }
        : {}),
      ...(refundedAmount !== undefined ? { refundedAmount: refundedAmount / 100 } : {}),
      ...(currency ? { currency } : {}),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
      ...(isSetupIntent ? { stripeSetupIntentId: stringValue(object.id) } : {}),
      ...(isSetupIntent && idValue(object.payment_method)
        ? { stripePaymentMethodId: idValue(object.payment_method) }
        : {}),
      ...(isSetupIntent && idValue(object.customer)
        ? { stripeCustomerId: idValue(object.customer) }
        : {}),
      ...(event.type === 'payment_intent.payment_failed' ||
      event.type === 'payment_intent.requires_action'
        ? {
            failureCode:
              stringValue(lastError?.decline_code) ??
              stringValue(lastError?.code) ??
              (event.type === 'payment_intent.requires_action'
                ? 'authentication_required'
                : 'payment_failed'),
          }
        : {}),
      ...(event.type.startsWith('charge.dispute.') && stringValue(object.status)
        ? { disputeStatus: stringValue(object.status) }
        : {}),
    });
    if (result.reservationConfirmed && result.reservationId) {
      // Hors de la transaction : un échec de mise en file ne doit pas faire rejouer l'événement.
      await enqueueConfirmationAfterCardGuarantee(db, {
        id: result.reservationId,
        restaurantId: target.restaurantId,
      }).catch((error: unknown) =>
        logger.warn(
          {
            paymentId: target.paymentId,
            err: error instanceof Error ? error.message : String(error),
          },
          'reservation guarantee: confirmation SMS not queued',
        ),
      );
    }
    return { handled: true, ...result };
  } catch (error) {
    if (
      error instanceof ReservationPaymentInputError ||
      error instanceof ReservationPaymentStateError ||
      error instanceof ReservationPaymentNotFoundError ||
      error instanceof ReservationPaymentPolicyNotFoundError ||
      error instanceof ReservationPaymentReservationNotFoundError
    ) {
      logger.warn(
        { code: error.code, stripeEventId: event.id, paymentId: target.paymentId },
        'reservation payment webhook rejected',
      );
      return { handled: true, rejected: error.code };
    }
    throw error;
  }
}
