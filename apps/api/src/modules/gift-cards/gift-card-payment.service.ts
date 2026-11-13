/**
 * Gift card payment service — orchestre le paiement Stripe + création de carte + notifications.
 *
 * Flow :
 *   1. Vérifier que le PaymentIntent Stripe est succeeded
 *   2. Calculer la commission Suppernote = amount * restaurant.giftCardCommissionRate
 *   3. Créer la GiftCard avec stripePaymentIntentId, stripePaymentStatus, suppernoteCommissionAmount
 *   4. Déclencher les notifications (email expéditeur, email destinataire, WhatsApp, notif restaurateur)
 */
import { Prisma, type PrismaClient, type GiftCard } from '@prisma/client';
import { GiftCardCheckoutService } from './gift-card-checkout.service';
import { giftCardHash, lockGiftCardPayment } from './gift-card-finance.util';
import { DEFAULT_TRANSACTION_OPTIONS } from '../../shared/db/transaction-options';
import { GiftCardRefundService } from './gift-card-refund.service';
import { GiftCardService } from './gift-card.service';
import { retrievePaymentIntent } from './stripe.service';
import { logger } from '../../shared/logger/pino';
import { enqueueGiftCardDelivery } from './gift-card-delivery.service';
import { recordGiftCardPurchaseTimelineEvent } from '../customers/customer-activity-timeline';

export type PurchaseWithPaymentInput = {
  restaurantId: string;
  paymentIntentId: string;
  checkoutId?: string;
  accessToken?: string;
  amount?: number;
  packId?: string;
  occasion?: string;
  senderName?: string;
  senderEmail?: string;
  senderPhone?: string;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  message?: string;
  templateId?: string;
  customImageUrl?: string;
  preferredDate?: Date;
  preferredTime?: string;
  preferredPartySize?: number;
};

export class GiftCardPaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GiftCardPaymentError';
  }
}

export class GiftCardPaymentConflictError extends GiftCardPaymentError {
  constructor(message = 'Ce paiement a déjà été utilisé pour une carte cadeau') {
    super(message);
    this.name = 'GiftCardPaymentConflictError';
  }
}

export class GiftCardPaymentService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Paiement + création de carte + notifications.
   * Retourne la carte cadeau créée.
   */
  async purchaseWithPayment(
    input: PurchaseWithPaymentInput,
    webhook?: { stripeAccountId?: string },
  ): Promise<GiftCard> {
    // tenant-scoping: global — Unique checkout bootstrap; access token or authenticated Stripe account is checked before fulfillment.
    const checkout = await this.prisma.giftCardCheckout.findUnique({
      where: input.checkoutId
        ? { id: input.checkoutId }
        : { stripePaymentIntentId: input.paymentIntentId },
    });
    if (checkout) {
      if (
        checkout.kind !== 'PURCHASE' ||
        checkout.restaurantId !== input.restaurantId ||
        (checkout.stripePaymentIntentId &&
          checkout.stripePaymentIntentId !== input.paymentIntentId) ||
        (webhook
          ? checkout.stripeAccountId !== webhook.stripeAccountId
          : giftCardHash(input.accessToken ?? '') !== checkout.accessTokenHash)
      ) {
        throw new GiftCardPaymentError('Accès à la commande refusé.');
      }
    } else if (webhook?.stripeAccountId) {
      throw new GiftCardPaymentError('Commande du compte connecté introuvable.');
    }
    const pi = await retrievePaymentIntent(input.paymentIntentId, checkout?.stripeAccountId);
    if (
      pi.status !== 'succeeded' ||
      pi.disputed ||
      pi.pendingRefund ||
      (pi.refundedAmount ?? 0) > 0
    ) {
      throw new GiftCardPaymentError('Le paiement ne peut pas activer une carte cadeau.');
    }
    if (
      pi.metadata.type === 'crowdfunding_contribution' ||
      (checkout && pi.metadata.checkoutId !== checkout.id)
    ) {
      throw new GiftCardPaymentError('Le paiement ne correspond pas à cet achat.');
    }
    if (checkout) {
      const snapshot = checkout.payload as Record<string, unknown>;
      input = {
        ...snapshot,
        restaurantId: checkout.restaurantId,
        paymentIntentId: input.paymentIntentId,
        amount: checkout.amountCents / 100,
        preferredDate: snapshot.preferredDate
          ? new Date(String(snapshot.preferredDate))
          : undefined,
      } as PurchaseWithPaymentInput;
    }
    const restaurantId = pi.metadata.restaurantId;
    if (!restaurantId) {
      throw new GiftCardPaymentError('Les informations du paiement sont incomplètes.');
    }
    if (input.restaurantId !== restaurantId) {
      throw new GiftCardPaymentError('Le restaurant ne correspond pas au paiement.');
    }

    const packId = checkout ? input.packId : pi.metadata.packId || undefined;
    const metadataAmount = checkout
      ? checkout.amountCents / 100
      : pi.metadata.amount
        ? Number(pi.metadata.amount)
        : undefined;
    if (
      !packId &&
      (metadataAmount === undefined || !Number.isFinite(metadataAmount) || metadataAmount <= 0)
    ) {
      throw new GiftCardPaymentError('Les informations du montant sont incomplètes.');
    }
    if (input.packId !== undefined && input.packId !== packId) {
      throw new GiftCardPaymentError('Le pack ne correspond pas au paiement.');
    }
    if (input.amount !== undefined && input.amount !== metadataAmount) {
      throw new GiftCardPaymentError('Le montant ne correspond pas au paiement.');
    }

    // 2. Charger le restaurant pour le taux de commission et les infos
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        name: true,
        giftCardCommissionRate: true,
        managerEmail: true,
        managerPhone: true,
        giftCardMinimumAmount: true,
      },
    });

    if (!restaurant) {
      throw new GiftCardPaymentError('Restaurant introuvable');
    }

    // 3. Déterminer le montant
    let amount: number;
    if (checkout) {
      amount = checkout.amountCents / 100;
    } else if (packId) {
      const pack = await this.prisma.giftCardPack.findFirst({
        where: { id: packId, restaurantId },
        select: { amount: true },
      });
      if (!pack) {
        throw new GiftCardPaymentError('Pack cadeau introuvable');
      }
      amount = pack.amount.toNumber();
    } else {
      amount = metadataAmount!;
    }

    if (pi.currency.toLowerCase() !== 'eur') {
      throw new GiftCardPaymentError('La devise du paiement n’est pas acceptée.');
    }
    const expectedAmountInCents = Math.round(amount * 100);
    if (pi.amount !== expectedAmountInCents || pi.amountReceived !== expectedAmountInCents) {
      throw new GiftCardPaymentError('Le montant du paiement ne correspond pas à la commande.');
    }

    // Vérifier le montant minimum
    const minAmount = restaurant.giftCardMinimumAmount ?? 10;
    if (!checkout && amount < minAmount) {
      throw new GiftCardPaymentError(`Le montant minimum est de ${minAmount}€`);
    }

    // 4. Calculer la commission
    const commissionRate = checkout
      ? checkout.commissionRate.toNumber()
      : restaurant.giftCardCommissionRate
        ? restaurant.giftCardCommissionRate.toNumber()
        : 0.05;
    const suppernoteCommissionAmount = Math.round(amount * commissionRate * 100) / 100;

    // 5. Créer la carte cadeau
    const { card, created } = await this.prisma.$transaction(async (tx) => {
      await lockGiftCardPayment(tx, input.paymentIntentId);
      if (checkout) {
        const current = await tx.giftCardCheckout.findUniqueOrThrow({
          where: { id: checkout.id, restaurantId: checkout.restaurantId },
        });
        if (!['OPEN', 'FULFILLED'].includes(current.status))
          throw new GiftCardPaymentError('Cette commande nécessite une vérification du paiement.');
      }
      // tenant-scoping: global — Global payment ledger collision check; reject any conflicting kind or restaurant.
      const entry = await tx.giftCardPaymentEntry.findUnique({
        where: { paymentIntentId: input.paymentIntentId },
      });
      if (entry && (entry.kind !== 'PURCHASE' || entry.restaurantId !== restaurantId))
        throw new GiftCardPaymentConflictError();
      // tenant-scoping: global — Global payment uniqueness: reject a card owned by another restaurant before returning it.
      const existing = await tx.giftCard.findFirst({
        where: { stripePaymentIntentId: input.paymentIntentId },
      });
      if (existing) {
        if (existing.restaurantId !== restaurantId || (!checkout && !webhook))
          throw new GiftCardPaymentConflictError();
        if (checkout)
          await tx.giftCardCheckout.update({
            where: { id: checkout.id, restaurantId: checkout.restaurantId },
            data: { status: 'FULFILLED' },
          });
        return { card: existing, created: false };
      }
      if (
        entry ||
        (await tx.giftCardContribution.findFirst({
          where: { stripePaymentIntentId: input.paymentIntentId },
        }))
      ) {
        throw new GiftCardPaymentConflictError();
      }
      const service = new GiftCardService(tx as PrismaClient);
      const card = await service.create({
        restaurantId,
        amount,
        packId,
        verifiedAmount: checkout ? amount : undefined,
        packSnapshot: checkout
          ? ((checkout.payload as Record<string, unknown>).packSnapshot as Prisma.InputJsonValue)
          : undefined,
        occasion: input.occasion,
        senderName: input.senderName,
        senderEmail: input.senderEmail,
        senderPhone: input.senderPhone,
        recipientName: input.recipientName,
        recipientEmail: input.recipientEmail,
        recipientPhone: input.recipientPhone,
        message: input.message,
        createdBy: 'CLIENT',
        purchaseReference: input.paymentIntentId,
        stripePaymentIntentId: input.paymentIntentId,
        stripePaymentStatus: 'succeeded',
        templateId: input.templateId,
        customImageUrl: input.customImageUrl,
        suppernoteCommissionAmount,
        preferredDate: input.preferredDate,
        preferredTime: input.preferredTime,
        preferredPartySize: input.preferredPartySize,
      });
      await tx.giftCardPaymentEntry.create({
        data: {
          paymentIntentId: input.paymentIntentId,
          restaurantId,
          giftCardId: card.id,
          kind: 'PURCHASE',
          amountCents: expectedAmountInCents,
          currency: 'eur',
          stripeAccountId: checkout?.stripeAccountId,
        },
      });
      if (checkout)
        await tx.giftCardCheckout.update({
          where: { id: checkout.id, restaurantId: checkout.restaurantId },
          data: { status: 'FULFILLED' },
        });
      for (const kind of [
        'sender_email',
        'recipient_email',
        'restaurant_email',
        'recipient_whatsapp',
        'restaurant_sms',
      ] as const)
        await enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: card.id, kind });
      return { card, created: true };
    }, DEFAULT_TRANSACTION_OPTIONS);
    if (!created) return card;

    await recordGiftCardPurchaseTimelineEvent(card);
    return card;
  }

  /**
   * Gère un webhook Stripe payment_intent.succeeded.
   *
   * Reconstruit un PurchaseWithPaymentInput complet à partir des metadata du
   * PaymentIntent et appelle purchaseWithPayment pour créer la carte + notifications.
   *
   * Idempotent : si une carte existe déjà pour ce PI, on la retourne sans recréer.
   * Si les metadata sont incomplètes (pas de restaurantId), on log un warning et
   * retourne null.
   */
  async handleStripeWebhook(
    paymentIntentId: string,
    metadata: Record<string, string>,
    stripeAccountId?: string,
  ): Promise<GiftCard | null> {
    if (metadata.checkoutId) {
      const checkout = await new GiftCardCheckoutService(this.prisma).findForPayment(
        metadata,
        paymentIntentId,
      );
      if (!checkout || checkout.kind !== 'PURCHASE')
        throw new GiftCardPaymentError('Commande introuvable.');
      return this.purchaseWithPayment(
        {
          restaurantId: checkout.restaurantId,
          paymentIntentId,
          checkoutId: checkout.id,
        },
        { stripeAccountId },
      );
    }
    if (stripeAccountId) throw new GiftCardPaymentError('Commande Connect introuvable.');
    const existing = await this.prisma.giftCard.findFirst({
      where: { stripePaymentIntentId: paymentIntentId },
    });
    if (existing) return existing;

    // Vérifier que les metadata contiennent au moins restaurantId
    if (!metadata.restaurantId) {
      logger.warn(
        { paymentIntentId },
        '[gift-card-payment] Webhook: no restaurantId in metadata, skipping',
      );
      return null;
    }

    // Reconstruire l'input à partir des metadata
    const input: PurchaseWithPaymentInput = {
      restaurantId: metadata.restaurantId,
      paymentIntentId,
    };

    if (metadata.amount) {
      input.amount = parseFloat(metadata.amount);
    }
    if (metadata.packId) {
      input.packId = metadata.packId;
    }
    if (metadata.occasion) {
      input.occasion = metadata.occasion;
    }
    if (metadata.senderName) {
      input.senderName = metadata.senderName;
    }
    if (metadata.senderEmail) {
      input.senderEmail = metadata.senderEmail;
    }
    if (metadata.senderPhone) {
      input.senderPhone = metadata.senderPhone;
    }
    if (metadata.recipientName) {
      input.recipientName = metadata.recipientName;
    }
    if (metadata.recipientEmail) {
      input.recipientEmail = metadata.recipientEmail;
    }
    if (metadata.recipientPhone) {
      input.recipientPhone = metadata.recipientPhone;
    }
    if (metadata.message) {
      input.message = metadata.message;
    }
    if (metadata.templateId) {
      input.templateId = metadata.templateId;
    }
    if (metadata.customImageUrl) {
      input.customImageUrl = metadata.customImageUrl;
    }
    if (metadata.preferredDate) {
      input.preferredDate = new Date(metadata.preferredDate);
    }
    if (metadata.preferredTime) {
      input.preferredTime = metadata.preferredTime;
    }
    if (metadata.preferredPartySize) {
      input.preferredPartySize = parseInt(metadata.preferredPartySize, 10);
    }

    // Vérifier que l'on a soit amount soit packId
    if (!input.amount && !input.packId) {
      logger.warn(
        { paymentIntentId, metadataKeys: Object.keys(metadata) },
        '[gift-card-payment] Webhook: incomplete metadata (no amount or packId), skipping',
      );
      return null;
    }

    logger.info(
      { paymentIntentId, restaurantId: input.restaurantId },
      '[gift-card-payment] Webhook: reconstructing purchase from metadata',
    );

    return this.purchaseWithPayment(input, {});
  }

  /**
   * Gère un webhook Stripe payment_intent.payment_failed.
   *
   * Met à jour le statut Stripe de la carte cadeau associée, sans jamais
   * créer de carte (le paiement a échoué). Idempotent : ne met à jour que si
   * le statut Stripe n'est pas déjà terminal ; si aucune carte n'existe,
   * on log et on sort silencieusement.
   */
  async handlePaymentFailed(
    paymentIntentId: string,
    metadata?: Record<string, string>,
  ): Promise<void> {
    const safeMetadata = metadata ? this.redactMetadata(metadata) : undefined;
    logger.info(
      {
        paymentIntentId,
        metadata: safeMetadata,
        metadataKeys: metadata ? Object.keys(metadata) : [],
      },
      '[gift-card-payment] Payment failed webhook received',
    );

    try {
      const existing = await this.prisma.giftCard.findFirst({
        where: { stripePaymentIntentId: paymentIntentId },
      });

      if (!existing) {
        logger.info(
          { paymentIntentId },
          '[gift-card-payment] No gift card found for failed payment, nothing to update',
        );
        return;
      }

      const terminalStatuses = ['succeeded', 'failed', 'canceled'];
      if (existing.stripePaymentStatus && terminalStatuses.includes(existing.stripePaymentStatus)) {
        logger.info(
          {
            paymentIntentId,
            giftCardId: existing.id,
            stripePaymentStatus: existing.stripePaymentStatus,
          },
          '[gift-card-payment] Gift card already in a terminal Stripe state, skipping',
        );
        return;
      }

      await this.prisma.giftCard.update({
        where: { id: existing.id, restaurantId: existing.restaurantId },
        data: { stripePaymentStatus: 'failed' },
      });

      logger.info(
        { paymentIntentId, giftCardId: existing.id },
        '[gift-card-payment] Gift card Stripe status updated to failed',
      );
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      logger.error(
        { paymentIntentId, err: errorMessage },
        '[gift-card-payment] Failed to update gift card status for failed payment',
      );
    }
  }

  private redactMetadata(metadata: Record<string, string>): Record<string, string> {
    const redacted: Record<string, string> = {};
    const piiKeys = new Set([
      'senderemail',
      'recipientemail',
      'senderphone',
      'recipientphone',
      'sendername',
      'recipientname',
      'message',
    ]);
    for (const [key, value] of Object.entries(metadata)) {
      redacted[key] = piiKeys.has(key.toLowerCase()) ? '[REDACTED]' : value;
    }
    return redacted;
  }

  /**
   * Gère un webhook Stripe charge.refunded.
   * Met à jour le statut Stripe de la carte cadeau associée.
   */
  async handleRefundUpdated(
    paymentIntentId: string,
    _refundStatus: string,
    stripeAccountId?: string,
  ): Promise<void> {
    await new GiftCardRefundService(this.prisma).reconcilePayment(paymentIntentId, stripeAccountId);
  }
}
