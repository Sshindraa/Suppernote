import { logger } from '../../shared/logger/pino';
/**
 * Gift card crowdfunding service — cagnottes pour cartes cadeaux.
 *
 * Flow :
 *   1. createCrowdfunding : crée une GiftCard type=CROWDFUNDED, amount=0, status=ACTIVE
 *   2. contribute : ajoute une GiftCardContribution (paiement Stripe vérifié)
 *   3. closeCrowdfunding : calcule le total, enregistre la commission, met à jour la carte
 *      (amount = total, remainingAmount = amount, status=ACTIVE, type=CROWDFUNDED)
 *   4. getPublicStatus : retourne le statut public de la cagnotte (sans auth)
 */
import type { PrismaClient, GiftCard, GiftCardContribution } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { GiftCardRefundService } from './gift-card-refund.service';
import {
  giftCardAmountCents,
  giftCardHash,
  lockGiftCard,
  lockGiftCardPayment,
} from './gift-card-finance.util';
import { GiftCardService } from './gift-card.service';
import { retrievePaymentIntent } from './stripe.service';
import { enqueueGiftCardDelivery } from './gift-card-delivery.service';
import { DEFAULT_TRANSACTION_OPTIONS } from '../../shared/db/transaction-options';
import type {
  CreateCrowdfundingInput,
  ContributeInput,
  PublicCrowdfundingStatus,
  PublicContribution,
} from './gift-card.types';

export class CrowdfundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrowdfundingError';
  }
}

export class GiftCardCrowdfundingService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Crée une cagnotte (GiftCard type=CROWDFUNDED, amount=0).
   * Le `title` est stocké dans `occasion`, le `message` dans `message`.
   * Le créateur est stocké dans `senderName` / `senderEmail`.
   */
  async createCrowdfunding(input: CreateCrowdfundingInput): Promise<GiftCard> {
    if (input.crowdfundedUntil <= new Date()) {
      throw new CrowdfundingError('La date butoir doit être dans le futur');
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: input.restaurantId },
      select: { giftCardEnabled: true },
    });
    if (!restaurant?.giftCardEnabled)
      throw new CrowdfundingError('Cartes cadeaux non disponibles pour ce restaurant');
    const service = new GiftCardService(this.prisma);
    return service.create({
      restaurantId: input.restaurantId,
      amount: 0,
      type: 'CROWDFUNDED',
      targetAmount: input.targetAmount,
      crowdfundedUntil: input.crowdfundedUntil,
      occasion: input.title,
      senderName: input.creatorName,
      senderEmail: input.creatorEmail,
      recipientName: input.recipientName,
      recipientEmail: input.recipientEmail,
      recipientPhone: input.recipientPhone,
      message: input.message,
      templateId: input.templateId,
      createdBy: 'CLIENT',
      purchaseReference: 'crowdfunding',
    });
  }

  /**
   * Contribue à une cagnotte.
   * Vérifie le PaymentIntent Stripe, la deadline, et le statut de la cagnotte.
   */
  async contribute(
    input: ContributeInput & { accessToken?: string },
    paymentIntentId: string,
    webhook?: { stripeAccountId?: string; checkoutId?: string },
  ): Promise<GiftCardContribution | null> {
    // tenant-scoping: global — Resolve unique checkout, then require its access-token hash or signed Stripe account before using the snapshot.
    const checkout = await this.prisma.giftCardCheckout.findUnique({
      where: webhook?.checkoutId
        ? { id: webhook.checkoutId }
        : { stripePaymentIntentId: paymentIntentId },
    });
    if (
      checkout &&
      (checkout.kind !== 'CONTRIBUTION' ||
        (checkout.stripePaymentIntentId && checkout.stripePaymentIntentId !== paymentIntentId) ||
        (webhook
          ? checkout.stripeAccountId !== webhook.stripeAccountId
          : giftCardHash(input.accessToken ?? '') !== checkout.accessTokenHash))
    ) {
      throw new CrowdfundingError('Accès à la contribution refusé.');
    }
    if (!checkout && webhook?.stripeAccountId)
      throw new CrowdfundingError('Commande Connect introuvable');
    const pi = await retrievePaymentIntent(paymentIntentId, checkout?.stripeAccountId);
    if (checkout) {
      const snapshot = checkout.payload as unknown as ContributeInput;
      if (
        snapshot.code !== input.code ||
        (!webhook && giftCardAmountCents(input.amount) !== checkout.amountCents)
      ) {
        throw new CrowdfundingError('La contribution ne correspond pas à la commande.');
      }
      input = snapshot;
    }
    // tenant-scoping: global — Public card code bootstrap; contribution must match its verified payment and restaurant.
    const card = await this.prisma.giftCard.findUnique({ where: { code: input.code } });
    if (!card) throw new CrowdfundingError('Cagnotte introuvable');
    const cents = giftCardAmountCents(input.amount);
    if (
      pi.status !== 'succeeded' ||
      pi.currency.toLowerCase() !== 'eur' ||
      pi.amount !== cents ||
      pi.amountReceived !== cents ||
      pi.disputed ||
      pi.pendingRefund ||
      (checkout
        ? pi.metadata.checkoutId !== checkout.id ||
          checkout.giftCardId !== card.id ||
          checkout.restaurantId !== card.restaurantId ||
          pi.metadata.restaurantId !== card.restaurantId
        : pi.metadata.type !== 'crowdfunding_contribution' ||
          pi.metadata.giftCardCode !== card.code ||
          Number(pi.metadata.amount) !== input.amount)
    ) {
      throw new CrowdfundingError('Le paiement ne correspond pas à cette contribution.');
    }
    const result = await this.prisma.$transaction(async (tx) => {
      await lockGiftCardPayment(tx, paymentIntentId);
      if (checkout) {
        const current = await tx.giftCardCheckout.findUniqueOrThrow({
          where: { id: checkout.id, restaurantId: checkout.restaurantId },
        });
        if (current.status === 'PAYMENT_REVIEW')
          throw new CrowdfundingError('Cette commande nécessite une vérification du paiement.');
      }
      // tenant-scoping: global — Global payment uniqueness must detect reuse by another restaurant; reject mismatched card/kind.
      const entry = await tx.giftCardPaymentEntry.findUnique({ where: { paymentIntentId } });
      if (entry && (entry.kind !== 'CONTRIBUTION' || entry.giftCardId !== card.id)) {
        throw new CrowdfundingError('Ce paiement est déjà affecté à un autre achat.');
      }
      const existing = await tx.giftCardContribution.findFirst({
        where: { stripePaymentIntentId: paymentIntentId },
      });
      if (existing) {
        if (existing.giftCardId !== card.id || !existing.amount.equals(input.amount))
          throw new CrowdfundingError('Paiement déjà utilisé');
        return { contribution: existing, created: false, refund: false };
      }
      if (
        entry ||
        // tenant-scoping: global — Collision check across all restaurants: the same payment cannot purchase and contribute.
        (await tx.giftCard.findFirst({ where: { stripePaymentIntentId: paymentIntentId } }))
      ) {
        throw new CrowdfundingError('Ce paiement est déjà utilisé pour une carte cadeau.');
      }
      await lockGiftCard(tx, card.id);
      const activeCard = await tx.giftCard.findUnique({
        where: { id: card.id, restaurantId: card.restaurantId },
      });
      if (
        !activeCard ||
        activeCard.type !== 'CROWDFUNDED' ||
        activeCard.closedAt ||
        activeCard.status !== 'ACTIVE' ||
        (activeCard.crowdfundedUntil && activeCard.crowdfundedUntil <= new Date()) ||
        (pi.refundedAmount ?? 0) > 0
      ) {
        const refundCents = cents - (pi.refundedAmount ?? 0);
        if (refundCents > 0)
          await tx.giftCardRefundRequest.upsert({
            where: { idempotencyKey: `gift-card-rejected:${paymentIntentId}` },
            update: {},
            create: {
              giftCardId: card.id,
              paymentIntentId,
              amountCents: refundCents,
              stripeAccountId: checkout?.stripeAccountId,
              actor: 'stripe:webhook',
              reason: 'REJECTED_CONTRIBUTION',
              idempotencyKey: `gift-card-rejected:${paymentIntentId}`,
            },
          });
        if (checkout)
          await tx.giftCardCheckout.update({
            where: { id: checkout.id, restaurantId: checkout.restaurantId },
            data: { status: 'REFUND_PENDING' },
          });
        return { contribution: null, created: false, refund: true };
      }
      const contribution = await tx.giftCardContribution.create({
        data: {
          giftCardId: card.id,
          contributorName: input.contributorName,
          contributorEmail: input.contributorEmail ?? null,
          amount: new Prisma.Decimal(input.amount),
          stripePaymentIntentId: paymentIntentId,
          isPublicName: input.isPublicName,
          message: input.message ?? null,
        },
      });
      await tx.giftCardPaymentEntry.create({
        data: {
          paymentIntentId,
          restaurantId: card.restaurantId,
          giftCardId: card.id,
          contributionId: contribution.id,
          kind: 'CONTRIBUTION',
          amountCents: cents,
          currency: 'eur',
          stripeAccountId: checkout?.stripeAccountId,
        },
      });
      if (checkout)
        await tx.giftCardCheckout.update({
          where: { id: checkout.id, restaurantId: checkout.restaurantId },
          data: { status: 'FULFILLED' },
        });
      for (const kind of ['contribution_email', 'organizer_email'] as const)
        await enqueueGiftCardDelivery(tx, {
          restaurantId: card.restaurantId,
          giftCardId: card.id,
          kind,
          referenceId: contribution.id,
        });
      return { contribution, created: true, refund: false };
    }, DEFAULT_TRANSACTION_OPTIONS);
    if (result.refund) {
      const refundCents = cents - (pi.refundedAmount ?? 0);
      if (refundCents > 0)
        await new GiftCardRefundService(this.prisma).refundRejectedContribution({
          giftCardId: card.id,
          paymentIntentId,
          amountCents: refundCents,
          stripeAccountId: checkout?.stripeAccountId,
        });
      return null;
    }
    const contribution = result.contribution!;
    if (!result.created) return contribution;

    return contribution;
  }

  /**
   * Clôture une cagnotte et transforme en carte cadeau utilisable.
   *
   * - Calcule le total des contributions
   * - Déduit la commission Suppernote (5% par défaut, configurable sur le restaurant)
   * - Met à jour la GiftCard : amount = total - commission, remainingAmount = amount,
   *   type = SINGLE, status = ACTIVE, closedAt = now
   * - Envoie email + WhatsApp au destinataire avec le code final
   */
  async closeCrowdfunding(giftCardId: string, restaurantId: string): Promise<GiftCard> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { name: true, giftCardCommissionRate: true },
    });
    if (!restaurant) throw new CrowdfundingError('Restaurant introuvable');
    const { updated, card, totalCollected, commissionAmount, finalAmount } =
      await this.prisma.$transaction(async (tx) => {
        await lockGiftCard(tx, giftCardId);
        const card = await tx.giftCard.findFirst({
          where: { id: giftCardId, restaurantId },
          include: { contributions: true },
        });
        if (!card || card.type !== 'CROWDFUNDED')
          throw new CrowdfundingError('Cagnotte introuvable');
        if (card.closedAt)
          return {
            updated: card,
            card,
            totalCollected: card.amount.toNumber(),
            commissionAmount: card.suppernoteCommissionAmount.toNumber(),
            finalAmount: card.amount.toNumber(),
          };
        if (card.status !== 'ACTIVE')
          throw new CrowdfundingError("Cette cagnotte n'est plus active");
        const entries = await tx.giftCardPaymentEntry.findMany({
          where: { giftCardId, restaurantId: card.restaurantId },
        });
        const total = card.contributions.reduce((sum, c) => {
          const refunded =
            entries.find((e) => e.paymentIntentId === c.stripePaymentIntentId)
              ?.refundedAmountCents ?? 0;
          return sum.plus(
            Prisma.Decimal.max(0, c.amount.minus(new Prisma.Decimal(refunded).div(100))),
          );
        }, new Prisma.Decimal(0));
        if (total.lte(0)) throw new CrowdfundingError('Aucune contribution encaissée à clôturer.');
        const checkouts = await tx.giftCardCheckout.findMany({
          where: { giftCardId, restaurantId: card.restaurantId, kind: 'CONTRIBUTION' },
        });
        const commission = card.contributions
          .reduce((sum, contribution) => {
            const entry = entries.find(
              (e) => e.paymentIntentId === contribution.stripePaymentIntentId,
            );
            const checkout = checkouts.find(
              (c) => c.stripePaymentIntentId === contribution.stripePaymentIntentId,
            );
            const retained = Prisma.Decimal.max(
              0,
              contribution.amount.minus(
                new Prisma.Decimal(entry?.refundedAmountCents ?? 0).div(100),
              ),
            );
            const fee = checkout
              ? new Prisma.Decimal(checkout.amountCents)
                  .mul(checkout.commissionRate)
                  .toDecimalPlaces(0)
                  .div(100)
              : contribution.amount
                  .mul(restaurant.giftCardCommissionRate ?? 0.05)
                  .toDecimalPlaces(2);
            return sum.plus(
              contribution.amount.gt(0) ? fee.mul(retained).div(contribution.amount) : 0,
            );
          }, new Prisma.Decimal(0))
          .toDecimalPlaces(2);
        // The restaurant bears the fee: the recipient keeps the full face value.
        const updated = await tx.giftCard.update({
          where: { id: card.id, restaurantId: card.restaurantId },
          data: {
            status: 'ACTIVE',
            amount: total,
            remainingAmount: total,
            suppernoteCommissionAmount: commission,
            closedAt: new Date(),
            expiresAt: new Date(new Date().setMonth(new Date().getMonth() + card.validityMonths)),
          },
        });
        for (const kind of ['closure_email', 'recipient_whatsapp'] as const)
          await enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: card.id, kind });
        return {
          updated,
          card,
          totalCollected: total.toNumber(),
          commissionAmount: commission.toNumber(),
          finalAmount: total.toNumber(),
        };
      }, DEFAULT_TRANSACTION_OPTIONS);
    // A replay must not reset the balance or send another gift.
    if (card.closedAt) return updated;

    logger.info(
      { giftCardId, totalCollected, commissionAmount, finalAmount },
      '[crowdfunding] Cagnotte clôturée',
    );

    return updated;
  }

  /**
   * Statut public d'une cagnotte (accessible sans authentification).
   */
  async getPublicStatus(code: string): Promise<PublicCrowdfundingStatus> {
    const card = await this.prisma.giftCard.findUnique({
      where: { code },
      include: {
        contributions: { orderBy: { contributedAt: 'desc' } },
        restaurant: { select: { name: true } },
      },
    });

    if (!card) {
      throw new CrowdfundingError('Cagnotte introuvable');
    }

    if (card.type !== 'CROWDFUNDED') {
      throw new CrowdfundingError("Cette carte cadeau n'est pas une cagnotte");
    }

    const entries = await this.prisma.giftCardPaymentEntry.findMany({
      where: { giftCardId: card.id, restaurantId: card.restaurantId },
    });
    const collectedAmount = card.contributions.reduce(
      (sum, c) =>
        sum +
        Math.max(
          0,
          c.amount.toNumber() -
            (entries.find((e) => e.paymentIntentId === c.stripePaymentIntentId)
              ?.refundedAmountCents ?? 0) /
              100,
        ),
      0,
    );

    const publicContributions: PublicContribution[] = card.contributions
      .filter((c) => c.isPublicName || c.message)
      .map((c) => ({
        id: c.id,
        contributorName: c.isPublicName ? c.contributorName : null,
        amount: c.amount.toNumber(),
        message: c.message,
        contributedAt: c.contributedAt.toISOString(),
      }));

    return {
      code: card.code,
      shortCode: card.shortCode,
      title: card.occasion ?? 'Cagnotte',
      occasion: card.occasion,
      recipientName: card.recipientName ?? '',
      restaurantName: card.restaurant.name,
      collectedAmount,
      targetAmount: card.targetAmount?.toNumber() ?? null,
      contributionsCount: card.contributions.length,
      crowdfundedUntil: card.crowdfundedUntil?.toISOString() ?? null,
      status: (card.closedAt && card.status === 'ACTIVE'
        ? 'CLOSED'
        : card.status) as PublicCrowdfundingStatus['status'],
      contributions: publicContributions,
      creatorName: card.senderName ?? '',
      message: card.message,
    };
  }
}
