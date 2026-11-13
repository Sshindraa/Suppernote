import { isLocalGiftCardTest } from './gift-card-local-test';
import { giftCardOperationsRoutes } from './gift-card-operations.routes';
import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Prisma, GiftCard, GiftCardRedemption } from '@prisma/client';
import { getDemoSlugAlias } from '@suppernote/shared';
import { db } from '../../shared/db/client';
import { requireOrg } from '../../plugins/clerk';
import {
  managedConnectVerified,
  managedConnectVerificationRequired,
} from './managed-connect-verification';
import { GiftCardService } from './gift-card.service';
import { GiftCardSlotsService } from './gift-card-slots.service';
import { GiftCardBookService } from './gift-card-book.service';
import { recommendGiftCardAmount } from './gift-card-recommender';
import {
  constructWebhookEvent,
  retrieveConnectedAccount,
  createConnectedAccount,
  createConnectedAccountLink,
  createConnectedAccountSession,
  managedConnectTestEnabled,
  managedConnectTestPublicKey,
  createManagedTestAccount,
  configureManagedTestAccount,
  createManagedTestSession,
  isManagedTestAccount,
} from './stripe.service';
import { GiftCardPaymentConflictError, GiftCardPaymentService } from './gift-card-payment.service';
import { GiftCardCheckoutService } from './gift-card-checkout.service';
import { GiftCardCrowdfundingService } from './gift-card-crowdfunding.service';
import { generateGiftCardPdf } from './gift-card-pdf.service';
import { logger } from '../../shared/logger/pino';
import { checkRateLimit, rateLimitKey, getClientIp } from '../../shared/redis/rate-limit';
import { RATE_LIMIT_PROVIDER_WEBHOOK } from '../../plugins/rate-limit.policy';
import { retrievePaymentIntent } from './stripe.service';
import { giftCardHash } from './gift-card-finance.util';
import { recordGiftCardPurchaseTimelineEvent } from '../customers/customer-activity-timeline';
import { GIFT_CARD_MESSAGE_MAX_LENGTH, GIFT_CARD_IMAGE_URL_MAX_LENGTH } from './constants';
import { handleBillingWebhook } from '../billing/billing.service';
import {
  handleExperienceCheckoutStripeEvent,
  handleExperienceRefundStripeEvent,
} from '../experiences/experience-payment.service';

const ListGiftCardsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'REDEEMED', 'EXPIRED', 'CANCELLED', 'CLOSED']).optional(),
  type: z.enum(['SINGLE', 'CROWDFUNDED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  search: z.string().optional(),
});

const CreateGiftCardSchema = z
  .object({
    amount: z.coerce.number().positive().optional(),
    packId: z.string().optional(),
    recipientName: z.string().min(1).max(100).optional(),
    recipientEmail: z.string().email().max(255).optional(),
    recipientPhone: z.string().max(50).optional(),
    senderName: z.string().min(1).max(100).optional(),
    message: z.string().max(GIFT_CARD_MESSAGE_MAX_LENGTH).optional(),
    occasion: z.string().max(100).optional(),
    preferredDate: z.coerce.date().optional(),
    preferredTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    preferredPartySize: z.coerce.number().int().min(1).optional(),
    expiresAt: z.coerce
      .date()
      .optional()
      .refine((date) => !date || date > new Date(), {
        message: "La date d'expiration doit être dans le futur",
      }),
  })
  .refine((data) => data.amount || data.packId, {
    message: 'Le montant ou le pack est requis',
  });

const UpdateGiftCardSchema = z.object({
  recipientName: z.string().min(1).max(100).optional(),
  recipientEmail: z.string().email().max(255).optional(),
  recipientPhone: z.string().max(50).optional(),
  senderName: z.string().min(1).max(100).optional(),
  message: z.string().max(1000).optional(),
  occasion: z.string().max(100).optional(),
  expiresAt: z.coerce
    .date()
    .optional()
    .refine((date) => !date || date > new Date(), {
      message: "La date d'expiration doit être dans le futur",
    }),
});

const CheckGiftCardSchema = z.object({
  code: z.string().min(1),
});

const RecommendGiftCardSchema = z.object({
  restaurantId: z.string().optional(),
  priceRange: z.string().optional(),
  occasion: z.string().optional(),
  partySize: z.coerce.number().int().min(1).optional(),
  budget: z.coerce.number().positive().optional(),
});

const PaymentIntentSchema = z.object({
  idempotencyKey: z.string().guid().optional(),
  accessToken: z.string().min(32).max(128).optional(),
  restaurantId: z.string(),
  amount: z.coerce.number().positive().optional(),
  packId: z.string().optional(),
  occasion: z.string().max(100).optional(),
  senderName: z.string().min(1).max(100).optional(),
  senderEmail: z.string().email().max(255).optional(),
  senderPhone: z.string().max(50).optional(),
  recipientName: z.string().min(1).max(100).optional(),
  recipientEmail: z.string().email().max(255).optional(),
  recipientPhone: z.string().max(50).optional(),
  message: z.string().max(1000).optional(),
  templateId: z.string().max(100).optional(),
  customImageUrl: z.string().url().max(GIFT_CARD_IMAGE_URL_MAX_LENGTH).optional(),
  preferredDate: z.coerce.date().optional(),
  preferredTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  preferredPartySize: z.coerce.number().int().min(1).optional(),
});

const PurchaseWithPaymentSchema = z
  .object({
    restaurantId: z.string(),
    paymentIntentId: z.string().min(1),
    checkoutId: z.string().guid().optional(),
    accessToken: z.string().min(32).max(128).optional(),
    amount: z.coerce.number().positive().optional(),
    packId: z.string().optional(),
    occasion: z.string().max(100).optional(),
    senderName: z.string().min(1).max(100).optional(),
    senderEmail: z.string().email().max(255).optional(),
    senderPhone: z.string().max(50).optional(),
    recipientName: z.string().min(1).max(100).optional(),
    recipientEmail: z.string().email().max(255).optional(),
    recipientPhone: z.string().max(50).optional(),
    message: z.string().max(GIFT_CARD_MESSAGE_MAX_LENGTH).optional(),
    templateId: z.string().max(100).optional(),
    customImageUrl: z.string().url().max(GIFT_CARD_IMAGE_URL_MAX_LENGTH).optional(),
    preferredDate: z.coerce.date().optional(),
    preferredTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    preferredPartySize: z.coerce.number().int().min(1).optional(),
  })
  .refine((data) => data.amount || data.packId || data.checkoutId, {
    message: 'Le montant, le pack ou la commande est requis',
  });

const ApplyGiftCardSchema = z.object({
  code: z.string().min(1),
  restaurantId: z.string(),
  reservationId: z.string(),
  reservationAmount: z.coerce.number().positive(),
});

// ─── P3 — Crowdfunding schemas ─────────────────────────────────────

const CreateCrowdfundingSchema = z.object({
  restaurantId: z.string(),
  title: z.string().min(1).max(200),
  occasion: z.string().max(100).optional(),
  recipientName: z.string().min(1).max(100),
  recipientEmail: z.string().email().max(255).optional(),
  recipientPhone: z.string().max(50).optional(),
  creatorName: z.string().min(1).max(100),
  creatorEmail: z.string().email().max(255),
  targetAmount: z.coerce.number().positive().optional(),
  crowdfundedUntil: z.coerce.date(),
  templateId: z.string().max(100).optional(),
  message: z.string().max(1000).optional(),
});

const CrowdfundingPaymentIntentSchema = z.object({
  idempotencyKey: z.string().guid().optional(),
  accessToken: z.string().min(32).max(128).optional(),
  amount: z.coerce.number().positive(),
  contributorName: z.string().min(1).max(100),
  contributorEmail: z.string().email().max(255).optional(),
  isPublicName: z.boolean().default(true),
  message: z.string().max(1000).optional(),
});

const ContributeSchema = z.object({
  accessToken: z.string().min(32).max(128).optional(),
  paymentIntentId: z.string().min(1),
  contributorName: z.string().min(1).max(100),
  contributorEmail: z.string().email().max(255).optional(),
  amount: z.coerce.number().positive(),
  isPublicName: z.boolean().default(true),
  message: z.string().max(1000).optional(),
});

const SuggestSlotsSchema = z.object({
  partySize: z.coerce.number().int().min(1).optional(),
  preferredDate: z.coerce.date().optional(),
  preferredTime: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
});

const BookSlotSchema = z.object({
  slotIndex: z.coerce.number().int().min(0).max(2),
  customer: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().min(1).max(100).optional(),
    phone: z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone must be E.164 (e.g. +33612345678)'),
    email: z.string().email().optional().or(z.literal('')),
  }),
});

function maskCode(code: string): string {
  if (code.length <= 8) {
    return '****' + code.slice(-4);
  }
  return code.slice(0, 4) + '-****-****-' + code.slice(-4);
}

export function serializeGiftCard(
  card: GiftCard & { redemptions?: GiftCardRedemption[]; pack?: { name: string } | null },
) {
  return {
    id: card.id,
    restaurantId: card.restaurantId,
    code: maskCode(card.code),
    shortCode: card.shortCode ?? null,
    amount: card.amount.toNumber(),
    remainingAmount: card.remainingAmount.toNumber(),
    currency: card.currency,
    status: card.status,
    purchasedAt: card.purchasedAt,
    expiresAt: card.expiresAt,
    validityMonths: card.validityMonths,
    packId: card.packId,
    packName: (card.packSnapshot as { name?: string } | null)?.name ?? card.pack?.name ?? null,
    preferredDate: card.preferredDate,
    preferredTime: card.preferredTime,
    preferredPartySize: card.preferredPartySize,
    senderName: card.senderName,
    senderEmail: card.senderEmail,
    senderPhone: card.senderPhone,
    recipientName: card.recipientName,
    recipientEmail: card.recipientEmail,
    recipientPhone: card.recipientPhone,
    message: card.message,
    occasion: card.occasion,
    customerId: card.customerId,
    createdBy: card.createdBy,
    purchaseReference: card.purchaseReference,
    stripePaymentStatus: card.stripePaymentStatus,
    templateId: card.templateId,
    sokarCommissionAmount: card.sokarCommissionAmount?.toNumber() ?? 0,
    type: card.type,
    targetAmount: card.targetAmount?.toNumber() ?? null,
    crowdfundedUntil: card.crowdfundedUntil,
    closedAt: card.closedAt,
  };
}

export async function giftCardRoutes(app: FastifyInstance): Promise<void> {
  await giftCardOperationsRoutes(app);
  const service = new GiftCardService(db);
  const slotsService = new GiftCardSlotsService(db);
  const bookService = new GiftCardBookService(db, slotsService);

  app.get('/public/gift-cards/:code/beneficiary', async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { code } = z.object({ code: z.string().min(1).max(100) }).parse(req.params);
    if (!(await checkRateLimit(rateLimitKey('gift-card-beneficiary', getClientIp(req)), 30))) {
      return reply.status(429).send({ error: 'Trop de demandes. Réessayez dans une minute.' });
    }
    const card = await service.findByCodeOrShortCodeWithPack(code);
    if (!card) return reply.status(404).send({ error: 'Carte cadeau introuvable' });
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: card.restaurantId },
      select: { name: true, slug: true },
    });
    const validation = await service.validateCode(code, card.restaurantId);
    return reply.send({
      displayCode: card.shortCode ?? code,
      amount: card.amount.toNumber(),
      remainingAmount: card.remainingAmount.toNumber(),
      expiresAt: card.expiresAt,
      status: card.status,
      usable: validation.valid,
      restaurantName: restaurant.name,
      restaurantSlug: restaurant.slug,
      packName: (card.packSnapshot as { name?: string } | null)?.name ?? card.pack?.name ?? null,
    });
  });

  app.post('/public/gift-cards/checkouts/:id/status', async (req, reply) => {
    const { id } = z.object({ id: z.string().guid() }).parse(req.params);
    const { accessToken } = z.object({ accessToken: z.string().min(32).max(128) }).parse(req.body);
    // tenant-scoping: global — Public checkout status: unique ID plus access-token hash required before any response or fulfillment.
    const checkout = await db.giftCardCheckout.findUnique({ where: { id } });
    if (!checkout || checkout.accessTokenHash !== giftCardHash(accessToken))
      return reply.status(404).send({ error: 'Commande introuvable' });
    if (!checkout.stripePaymentIntentId) return reply.status(202).send({ status: 'PREPARING' });
    const pi = await retrievePaymentIntent(
      checkout.stripePaymentIntentId,
      checkout.stripeAccountId,
    );
    const result: Record<string, unknown> = {
      status: pi.status,
      paymentIntentId: pi.id,
      stripeAccountId: checkout.stripeAccountId,
    };
    if (pi.status === 'succeeded') {
      if (checkout.kind === 'PURCHASE') {
        const card = await new GiftCardPaymentService(db).purchaseWithPayment({
          restaurantId: checkout.restaurantId,
          paymentIntentId: pi.id,
          checkoutId: checkout.id,
          accessToken,
        });
        const snapshot = checkout.payload as Record<string, unknown>;
        result.card = {
          id: card.id,
          code: card.code,
          shortCode: card.shortCode,
          amount: card.amount.toNumber(),
          remainingAmount: card.remainingAmount.toNumber(),
          status: card.status,
          packName: (snapshot.packSnapshot as { name?: string } | null)?.name ?? null,
          preferredDate: card.preferredDate,
          preferredTime: card.preferredTime,
          preferredPartySize: card.preferredPartySize,
          stripePaymentStatus: card.stripePaymentStatus,
          pdfUrl: `${process.env.API_URL ?? ''}/public/gift-cards/${card.shortCode ?? card.code}/pdf`,
        };
      } else {
        const contribution = await new GiftCardCrowdfundingService(db).contribute(
          {
            ...(checkout.payload as unknown as import('./gift-card.types').ContributeInput),
            accessToken,
          },
          pi.id,
        );
        result.contribution = contribution
          ? {
              id: contribution.id,
              amount: contribution.amount.toNumber(),
              contributedAt: contribution.contributedAt,
            }
          : null;
      }
    } else if (pi.status !== 'canceled') result.clientSecret = pi.clientSecret;
    return reply.send(result);
  });

  app.get(
    '/restaurants/:id/gift-cards/test-context',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      reply.header('Cache-Control', 'no-store');
      if (id !== req.restaurantId) return reply.status(403).send({ error: 'Accès refusé' });
      if (!isLocalGiftCardTest(id)) return reply.send({ enabled: false });
      if (req.siteRole !== 'OWNER')
        return reply.status(403).send({ error: 'Action réservée au propriétaire' });
      const restaurant = await db.restaurant.findUniqueOrThrow({
        where: { id: req.restaurantId },
        select: { slug: true, giftCardEnabled: true },
      });
      if (!restaurant.slug) return reply.send({ enabled: false });
      return reply.send({
        enabled: true,
        purchaseUrl: `http://localhost:4002/widget/${encodeURIComponent(restaurant.slug)}/gift-card`,
        beneficiaryBaseUrl: 'http://localhost:4002/gift-card/',
        giftCardEnabled: restaurant.giftCardEnabled,
        emailConfigured: !!process.env.RESEND_API_KEY,
        smsConfigured: !!process.env.TELNYX_API_KEY && !!process.env.TELNYX_FROM_NUMBER,
      });
    },
  );
  app.get(
    '/restaurants/:id/gift-cards/stripe-connect',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== req.restaurantId) return reply.status(403).send({ error: 'Accès refusé' });
      reply.header('Cache-Control', 'no-store');
      const restaurant = await db.restaurant.findUniqueOrThrow({
        where: { id: req.restaurantId },
        select: { giftCardStripeAccountId: true },
      });
      if (!restaurant.giftCardStripeAccountId)
        return reply.send({
          connected: false,
          chargesEnabled: false,
          payoutsEnabled: false,
          canConfigure: req.siteRole === 'OWNER',
          detailsSubmitted: false,
          onboardingState: 'configuration_required',
          actionItems: [
            'Renseigner les informations de votre établissement et votre compte bancaire',
          ],
          deadline: null,
          ...(req.siteRole === 'OWNER' && managedConnectTestEnabled(id)
            ? { managedTestPublishableKey: managedConnectTestPublicKey(id) }
            : {}),
        });
      const account = await retrieveConnectedAccount(restaurant.giftCardStripeAccountId);
      return reply.send({
        connected: true,
        chargesEnabled: account.chargesEnabled,
        payoutsEnabled: account.payoutsEnabled,
        canConfigure: req.siteRole === 'OWNER',
        detailsSubmitted: account.detailsSubmitted,
        onboardingState: account.onboardingState,
        actionItems: account.actionItems,
        deadline: account.deadline,
        ...(managedConnectTestEnabled(id) &&
        (await isManagedTestAccount(id, restaurant.giftCardStripeAccountId))
          ? { managedTest: true }
          : {}),
      });
    },
  );
  app.post(
    '/restaurants/:id/gift-cards/stripe-connect/onboarding',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== req.restaurantId || req.siteRole !== 'OWNER')
        return reply.status(403).send({ error: 'Accès réservé au propriétaire' });
      const restaurant = await db.restaurant.findUniqueOrThrow({
        where: { id: req.restaurantId },
        select: {
          giftCardStripeAccountId: true,
          giftCardStripePendingAccountId: true,
          managerEmail: true,
        },
      });
      if (
        !restaurant.giftCardStripeAccountId &&
        (restaurant.giftCardStripePendingAccountId || managedConnectTestEnabled(id))
      )
        return reply.status(409).send({ error: 'Utilisez la configuration intégrée.' });
      const accountId =
        restaurant.giftCardStripeAccountId ??
        (await createConnectedAccount(id, restaurant.managerEmail));
      await db.restaurant.update({ where: { id }, data: { giftCardStripeAccountId: accountId } });
      const link = await createConnectedAccountLink(accountId);
      return reply.send({ url: link.url });
    },
  );

  app.post(
    '/restaurants/:id/gift-cards/stripe-connect/session',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== req.restaurantId || req.siteRole !== 'OWNER')
        return reply.status(403).send({ error: 'Accès réservé au propriétaire' });
      const restaurant = await db.restaurant.findUniqueOrThrow({
        where: { id: req.restaurantId },
        select: {
          giftCardStripeAccountId: true,
          giftCardStripePendingAccountId: true,
          managerEmail: true,
        },
      });
      if (
        !restaurant.giftCardStripeAccountId &&
        (restaurant.giftCardStripePendingAccountId || managedConnectTestEnabled(id))
      )
        return reply.status(409).send({ error: 'Utilisez la configuration intégrée.' });
      const accountId =
        restaurant.giftCardStripeAccountId ??
        (await createConnectedAccount(id, restaurant.managerEmail));
      if (!restaurant.giftCardStripeAccountId) {
        await db.restaurant.update({
          where: { id: req.restaurantId },
          data: { giftCardStripeAccountId: accountId },
        });
      }
      const managed = await isManagedTestAccount(id, accountId);
      reply.header('Cache-Control', 'no-store');
      if (managed && !managedConnectVerified(req))
        return reply.status(403).send(managedConnectVerificationRequired);
      return reply.send(
        managed
          ? await createManagedTestSession(id, accountId)
          : await createConnectedAccountSession(accountId),
      );
    },
  );

  app.post(
    '/restaurants/:id/gift-cards/stripe-connect/managed-test',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      if (id !== req.restaurantId || req.siteRole !== 'OWNER')
        return reply.status(403).send({ error: 'Accès réservé au propriétaire' });
      if (!managedConnectTestEnabled(id)) return reply.status(404).send({ error: 'Indisponible' });
      reply.header('Cache-Control', 'no-store');
      if (!managedConnectVerified(req))
        return reply.status(403).send(managedConnectVerificationRequired);
      const parsed = z
        .object({
          accountToken: z
            .string()
            .regex(/^accttok_[A-Za-z0-9_]+$/)
            .max(128),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Jeton invalide' });
      try {
        const pendingId = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gift-card-connect:${id}`}, 0))`;
            const restaurant = await tx.restaurant.findUniqueOrThrow({
              where: { id: req.restaurantId },
              select: { giftCardStripeAccountId: true, giftCardStripePendingAccountId: true },
            });
            if (restaurant.giftCardStripeAccountId) return restaurant.giftCardStripeAccountId;
            if (restaurant.giftCardStripePendingAccountId)
              return restaurant.giftCardStripePendingAccountId;
            const accountId = await createManagedTestAccount(id);
            await tx.restaurant.update({
              where: { id: req.restaurantId },
              data: { giftCardStripePendingAccountId: accountId },
            });
            return accountId;
          },
          { timeout: 30000 },
        );
        const accountId = await db.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`gift-card-connect:${id}`}, 0))`;
            const restaurant = await tx.restaurant.findUniqueOrThrow({
              where: { id: req.restaurantId },
              select: { giftCardStripeAccountId: true, giftCardStripePendingAccountId: true },
            });
            if (restaurant.giftCardStripeAccountId) return restaurant.giftCardStripeAccountId;
            if (restaurant.giftCardStripePendingAccountId !== pendingId)
              throw new Error('Compte en attente modifié.');
            await configureManagedTestAccount(id, pendingId, parsed.data.accountToken);
            await tx.restaurant.update({
              where: { id: req.restaurantId },
              data: { giftCardStripeAccountId: pendingId, giftCardStripePendingAccountId: null },
            });
            return pendingId;
          },
          { timeout: 30000 },
        );
        if (!(await isManagedTestAccount(id, accountId)))
          return reply.status(409).send({ error: 'Compte incompatible.' });
        reply.header('Cache-Control', 'no-store');
        return reply.send(await createManagedTestSession(id, accountId));
      } catch {
        req.log.error('La configuration des paiements de test a échoué.');
        return reply.status(503).send({ error: 'Configuration indisponible. Veuillez réessayer.' });
      }
    },
  );

  // ─── Admin routes ─────────────────────────────────────────────────

  app.get('/restaurants/:id/gift-cards', { preHandler: requireOrg() }, async (req, reply) => {
    const restaurantId = (req.params as { id: string }).id;
    if (restaurantId !== req.restaurantId) {
      return reply.status(403).send({ error: 'Accès refusé' });
    }

    const query = ListGiftCardsQuerySchema.parse(req.query);
    const where: Prisma.GiftCardWhereInput = { restaurantId };
    if (query.status) {
      where.status = query.status;
    }
    if (query.type) {
      where.type = query.type;
    }
    if (query.search) {
      where.OR = [
        { recipientEmail: { contains: query.search, mode: 'insensitive' } },
        { recipientName: { contains: query.search, mode: 'insensitive' } },
        { senderName: { contains: query.search, mode: 'insensitive' } },
        { occasion: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [items, total] = await Promise.all([
      db.giftCard.findMany({
        where,
        skip: query.offset,
        take: query.limit,
        orderBy: { purchasedAt: 'desc' },
        include: { redemptions: { orderBy: { redeemedAt: 'desc' } }, pack: true },
      }),
      db.giftCard.count({ where }),
    ]);

    return reply.send({
      items: items.map(serializeGiftCard),
      total,
      limit: query.limit,
      offset: query.offset,
    });
  });

  app.post('/restaurants/:id/gift-cards', { preHandler: requireOrg() }, async (req, reply) => {
    const restaurantId = (req.params as { id: string }).id;
    if (restaurantId !== req.restaurantId) {
      return reply.status(403).send({ error: 'Accès refusé' });
    }

    const body = CreateGiftCardSchema.parse(req.body);
    const card = await service.create({
      ...body,
      restaurantId,
      createdBy: 'DASHBOARD',
    });
    await recordGiftCardPurchaseTimelineEvent(card);

    return reply.status(201).send(serializeGiftCard(card));
  });

  app.get(
    '/restaurants/:id/gift-cards/:giftCardId',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id: restaurantId, giftCardId } = req.params as { id: string; giftCardId: string };
      if (restaurantId !== req.restaurantId) {
        return reply.status(403).send({ error: 'Accès refusé' });
      }

      const card = await db.giftCard.findFirst({
        where: { id: giftCardId, restaurantId },
        include: { redemptions: { orderBy: { redeemedAt: 'desc' } }, pack: true },
      });

      if (!card) {
        return reply.status(404).send({ error: 'Carte cadeau introuvable' });
      }

      return reply.send(serializeGiftCard(card));
    },
  );

  app.patch(
    '/restaurants/:id/gift-cards/:giftCardId',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id: restaurantId, giftCardId } = req.params as { id: string; giftCardId: string };
      if (restaurantId !== req.restaurantId) {
        return reply.status(403).send({ error: 'Accès refusé' });
      }

      const existing = await db.giftCard.findFirst({
        where: { id: giftCardId, restaurantId },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Carte cadeau introuvable' });
      }

      const body = UpdateGiftCardSchema.parse(req.body);
      const card = await db.giftCard.update({
        where: { id: giftCardId },
        data: {
          ...(body.recipientName !== undefined && { recipientName: body.recipientName }),
          ...(body.recipientEmail !== undefined && { recipientEmail: body.recipientEmail }),
          ...(body.recipientPhone !== undefined && { recipientPhone: body.recipientPhone }),
          ...(body.senderName !== undefined && { senderName: body.senderName }),
          ...(body.message !== undefined && { message: body.message }),
          ...(body.occasion !== undefined && { occasion: body.occasion }),
          ...(body.expiresAt !== undefined && { expiresAt: body.expiresAt }),
        },
        include: { redemptions: { orderBy: { redeemedAt: 'desc' } }, pack: true },
      });

      return reply.send(serializeGiftCard(card));
    },
  );

  app.post(
    '/restaurants/:id/gift-cards/:giftCardId/cancel',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id: restaurantId, giftCardId } = req.params as { id: string; giftCardId: string };
      if (restaurantId !== req.restaurantId) {
        return reply.status(403).send({ error: 'Accès refusé' });
      }

      const card = await service.cancel(
        giftCardId,
        restaurantId,
        `dashboard:${req.userId ?? 'unknown'}`,
      );
      return reply.send(serializeGiftCard(card));
    },
  );

  app.get('/restaurants/:id/gift-cards/stats', { preHandler: requireOrg() }, async (req, reply) => {
    const restaurantId = (req.params as { id: string }).id;
    if (restaurantId !== req.restaurantId) {
      return reply.status(403).send({ error: 'Accès refusé' });
    }

    const stats = await service.getStats(restaurantId);
    return reply.send(stats);
  });

  // ─── Public routes ────────────────────────────────────────────────

  app.get('/public/gift-cards/packs/:slug', async (req, reply) => {
    const slug = (req.params as { slug: string }).slug;
    const select = { id: true, giftCardEnabled: true } as const;
    const alias = getDemoSlugAlias(slug);
    // tenant-scoping: global — resolve the unique public slug; packs are fetched by restaurantId.
    const restaurant =
      (await db.restaurant.findUnique({ where: { slug }, select })) ??
      (alias ? await db.restaurant.findUnique({ where: { slug: alias }, select }) : null);
    if (!restaurant) {
      return reply.status(404).send({ error: 'Restaurant introuvable' });
    }
    if (!restaurant.giftCardEnabled) {
      return reply.status(404).send({ error: 'Cartes cadeaux non disponibles' });
    }

    const packs = await db.giftCardPack.findMany({
      where: { restaurantId: restaurant.id, isActive: true },
      orderBy: { amount: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        amount: true,
        minPartySize: true,
        maxPartySize: true,
      },
    });

    return reply.send(packs.map((p) => ({ ...p, amount: p.amount.toNumber() })));
  });

  app.post('/public/gift-cards/check', async (req, reply) => {
    if (!(await checkRateLimit(rateLimitKey('gift-card-code-lookup', getClientIp(req)), 20))) {
      return reply.status(429).send({ error: 'Trop de demandes. Réessayez dans une minute.' });
    }
    const body = CheckGiftCardSchema.parse(req.body);
    const result = await service.validateCode(body.code);

    if (!result.valid) {
      return reply.send({ valid: false });
    }

    const card = result.giftCard;
    const restaurant = await db.restaurant.findUnique({
      where: { id: card.restaurantId },
      select: { name: true },
    });

    return reply.send({
      valid: true,
      giftCard: {
        amount: card.amount.toNumber(),
        remainingAmount: card.remainingAmount.toNumber(),
        status: card.status,
        expiresAt: card.expiresAt,
        restaurantName: restaurant?.name ?? null,
      },
    });
  });

  app.post('/public/gift-cards/recommend', async (req, reply) => {
    const body = RecommendGiftCardSchema.parse(req.body);
    const recommendation = recommendGiftCardAmount({
      priceRange: body.priceRange,
      occasion: body.occasion,
      partySize: body.partySize,
      budget: body.budget,
    });

    return reply.send(recommendation);
  });

  app.post('/public/gift-cards/apply', { preHandler: requireOrg() }, async (req, reply) => {
    const body = ApplyGiftCardSchema.parse(req.body);
    if (body.restaurantId !== req.restaurantId)
      return reply.status(403).send({ error: 'Accès refusé' });
    const result = await service.applyToReservation({
      code: body.code,
      restaurantId: body.restaurantId,
      reservationId: body.reservationId,
      reservationAmount: body.reservationAmount,
      actor: `dashboard:${req.userId ?? 'unknown'}`,
    });

    return reply.send(result);
  });

  app.post('/public/gift-cards/:code/slots', async (req, reply) => {
    if (!(await checkRateLimit(rateLimitKey('gift-card-code-lookup', getClientIp(req)), 20))) {
      return reply.status(429).send({ error: 'Trop de demandes. Réessayez dans une minute.' });
    }
    const code = (req.params as { code: string }).code;
    const body = SuggestSlotsSchema.parse(req.body);

    const slots = await slotsService.suggestSlots({
      giftCardCode: code,
      partySize: body.partySize,
      preferredDate: body.preferredDate,
      preferredTime: body.preferredTime,
    });

    return reply.send({ slots });
  });

  app.post('/public/gift-cards/:code/book', async (req, reply) => {
    if (!(await checkRateLimit(rateLimitKey('gift-card-code-lookup', getClientIp(req)), 20))) {
      return reply.status(429).send({ error: 'Trop de demandes. Réessayez dans une minute.' });
    }
    const code = (req.params as { code: string }).code;
    const body = BookSlotSchema.parse(req.body);

    const result = await bookService.book({
      code,
      slotIndex: body.slotIndex,
      customer: body.customer,
    });

    return reply.send({
      reservationId: result.reservationId,
      status: 'confirmed',
      state: result.state,
      giftCardApplication: result.giftCardApplication,
    });
  });

  // ─── P2 — Stripe Payment Intent ──────────────────────────────────
  app.post('/public/gift-cards/payment-intent', async (req, reply) => {
    // Rate limiting : 10 req/min/IP
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(rateLimitKey('gift-card-pi', ip));
    if (!allowed) {
      return reply.status(429).send({ error: 'Trop de requêtes. Réessayez dans une minute.' });
    }

    const body = PaymentIntentSchema.parse(req.body);

    try {
      return reply.send(await new GiftCardCheckoutService(db).purchase(body));
    } catch (err) {
      return reply
        .status(
          err instanceof Error &&
            err.message === 'Cartes cadeaux non disponibles pour ce restaurant'
            ? 403
            : 400,
        )
        .send({ error: err instanceof Error ? err.message : 'Impossible de préparer le paiement' });
    }
  });

  // ─── P2 — Purchase with payment ──────────────────────────────────
  app.post('/public/gift-cards/purchase', async (req, reply) => {
    const body = PurchaseWithPaymentSchema.parse(req.body);
    const paymentService = new GiftCardPaymentService(db);

    try {
      const card = await paymentService.purchaseWithPayment({
        restaurantId: body.restaurantId,
        paymentIntentId: body.paymentIntentId,
        checkoutId: body.checkoutId,
        accessToken: body.accessToken,
        amount: body.amount,
        packId: body.packId,
        occasion: body.occasion,
        senderName: body.senderName,
        senderEmail: body.senderEmail,
        senderPhone: body.senderPhone,
        recipientName: body.recipientName,
        recipientEmail: body.recipientEmail,
        recipientPhone: body.recipientPhone,
        message: body.message,
        templateId: body.templateId,
        customImageUrl: body.customImageUrl,
        preferredDate: body.preferredDate,
        preferredTime: body.preferredTime,
        preferredPartySize: body.preferredPartySize,
      });

      const pack = card.packId
        ? await db.giftCardPack.findUnique({ where: { id: card.packId }, select: { name: true } })
        : null;

      return reply.status(201).send({
        id: card.id,
        code: card.code,
        shortCode: card.shortCode,
        amount: card.amount.toNumber(),
        remainingAmount: card.remainingAmount.toNumber(),
        status: card.status,
        packName: (card.packSnapshot as { name?: string } | null)?.name ?? pack?.name ?? null,
        preferredDate: card.preferredDate,
        preferredTime: card.preferredTime,
        preferredPartySize: card.preferredPartySize,
        stripePaymentStatus: card.stripePaymentStatus,
        pdfUrl: `${process.env.API_URL ?? ''}/public/gift-cards/${card.code}/pdf`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, '[gift-card-routes] Purchase with payment failed');
      if (err instanceof GiftCardPaymentConflictError) {
        return reply.status(409).send({ error: message });
      }
      return reply.status(400).send({ error: message });
    }
  });

  // ─── P2 — PDF download ───────────────────────────────────────────
  app.get('/public/gift-cards/:code/pdf', async (req, reply) => {
    if (!(await checkRateLimit(rateLimitKey('gift-card-code-lookup', getClientIp(req)), 20))) {
      return reply.status(429).send({ error: 'Trop de demandes. Réessayez dans une minute.' });
    }
    const code = (req.params as { code: string }).code;

    // Accepter shortCode (SKR-...) ou code UUID
    const card = code.startsWith('SKR-')
      ? await db.giftCard.findUnique({
          where: { shortCode: code },
          include: { restaurant: { select: { name: true } }, pack: { select: { name: true } } },
        })
      : await db.giftCard.findUnique({
          where: { code },
          include: { restaurant: { select: { name: true } }, pack: { select: { name: true } } },
        });

    if (!card) {
      return reply.status(404).send({ error: 'Carte cadeau introuvable' });
    }

    if (card.status === 'CANCELLED') {
      return reply.status(400).send({ error: 'Cette carte cadeau est annulée' });
    }

    try {
      const pdfBuffer = await generateGiftCardPdf(card);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', `attachment; filename="carte-cadeau-${card.code}.pdf"`);
      return reply.send(pdfBuffer);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        { err: errMsg, stack: err instanceof Error ? err.stack : undefined, code },
        '[gift-card-routes] PDF generation failed',
      );
      return reply.status(500).send({ error: 'Impossible de générer le PDF' });
    }
  });

  // ─── P3 — Crowdfunding routes ────────────────────────────────────

  // Créer une cagnotte
  app.post('/public/gift-cards/crowdfunding', async (req, reply) => {
    const body = CreateCrowdfundingSchema.parse(req.body);
    const service = new GiftCardCrowdfundingService(db);

    try {
      const card = await service.createCrowdfunding({
        restaurantId: body.restaurantId,
        title: body.title,
        occasion: body.occasion,
        recipientName: body.recipientName,
        recipientEmail: body.recipientEmail,
        recipientPhone: body.recipientPhone,
        creatorName: body.creatorName,
        creatorEmail: body.creatorEmail,
        targetAmount: body.targetAmount,
        crowdfundedUntil: body.crowdfundedUntil,
        templateId: body.templateId,
        message: body.message,
      });

      return reply.status(201).send({
        id: card.id,
        code: card.code,
        shortCode: card.shortCode,
        type: card.type,
        title: card.occasion,
        crowdfundedUntil: card.crowdfundedUntil,
        targetAmount: card.targetAmount?.toNumber() ?? null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, '[gift-card-routes] Crowdfunding creation failed');
      return reply.status(400).send({ error: message });
    }
  });

  // Créer un PaymentIntent pour une contribution
  app.post('/public/gift-cards/crowdfunding/:code/payment-intent', async (req, reply) => {
    // Rate limiting : 10 req/min/IP
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(rateLimitKey('crowdfunding-pi', ip));
    if (!allowed) {
      return reply.status(429).send({ error: 'Trop de requêtes. Réessayez dans une minute.' });
    }

    const code = (req.params as { code: string }).code;
    const body = CrowdfundingPaymentIntentSchema.parse(req.body);

    try {
      return reply.send(await new GiftCardCheckoutService(db).contribution({ code, ...body }));
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : 'Impossible de préparer la contribution',
      });
    }
  });

  // Confirmer une contribution
  app.post('/public/gift-cards/crowdfunding/:code/contribute', async (req, reply) => {
    const code = (req.params as { code: string }).code;
    const body = ContributeSchema.parse(req.body);
    const service = new GiftCardCrowdfundingService(db);

    try {
      const contribution = await service.contribute(
        {
          code,
          contributorName: body.contributorName,
          contributorEmail: body.contributorEmail,
          amount: body.amount,
          accessToken: body.accessToken,
          isPublicName: body.isPublicName,
          message: body.message,
        },
        body.paymentIntentId,
      );

      if (!contribution) return reply.status(202).send({ status: 'REFUND_PENDING' });
      return reply.status(201).send({
        id: contribution.id,
        amount: contribution.amount.toNumber(),
        contributedAt: contribution.contributedAt,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, '[gift-card-routes] Contribution failed');
      return reply.status(400).send({ error: message });
    }
  });

  // Statut public d'une cagnotte
  app.get('/public/gift-cards/crowdfunding/:code', async (req, reply) => {
    const code = (req.params as { code: string }).code;
    const service = new GiftCardCrowdfundingService(db);

    try {
      const status = await service.getPublicStatus(code);
      return reply.send(status);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(404).send({ error: message });
    }
  });

  // Clôturer une cagnotte (dashboard — authentifié)
  app.post('/api/gift-cards/:id/close', { preHandler: requireOrg() }, async (req, reply) => {
    const giftCardId = (req.params as { id: string }).id;
    const restaurantId = (req.query as { restaurantId?: string }).restaurantId;

    // Vérifier que la cagnotte appartient au restaurant du user
    if (restaurantId && restaurantId !== req.restaurantId) {
      return reply.status(403).send({ error: 'Accès refusé' });
    }

    const service = new GiftCardCrowdfundingService(db);

    try {
      const card = await service.closeCrowdfunding(giftCardId, req.restaurantId!);
      return reply.send(serializeGiftCard(card));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, '[gift-card-routes] Close crowdfunding failed');
      return reply.status(400).send({ error: message });
    }
  });

  // ─── P2 — Stripe webhook ─────────────────────────────────────────
  // Provider tier: the global 100 req/min budget must not throttle Stripe.
  const stripeWebhookRouteOptions = {
    config: { rateLimit: RATE_LIMIT_PROVIDER_WEBHOOK },
  };
  app.post('/webhooks/stripe', stripeWebhookRouteOptions, async (req, reply) => {
    // Rate limiting avant vérification de signature (route publique).
    // Le budget applicatif ci-dessous (300/min) reste la limite effective :
    // il est plus strict que le palier webhook (600/min) déclaré sur la route.
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(rateLimitKey('stripe-webhook', ip), 300);
    if (!allowed) {
      return reply.status(429).send({ error: 'Trop de requêtes. Réessayez dans une minute.' });
    }

    const signature = req.headers['stripe-signature'] as string | undefined;
    if (!signature) {
      return reply.status(400).send({ error: 'Missing stripe-signature header' });
    }

    // En production, un content type parser raw body doit être configuré
    // pour que req.rawBody soit disponible (signature verification Stripe).
    // Fallback : si rawBody n'est pas set, on stringify req.body.
    const rawBody = (req as { rawBody?: string }).rawBody ?? JSON.stringify(req.body ?? {});

    let event: Awaited<ReturnType<typeof constructWebhookEvent>>;
    try {
      event = await constructWebhookEvent(rawBody, signature);
    } catch (err: unknown) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        '[gift-card-routes] Stripe webhook signature verification failed',
      );
      return reply.status(400).send({ error: 'Webhook signature verification failed' });
    }

    try {
      if (
        [
          'checkout.session.completed',
          'checkout.session.async_payment_succeeded',
          'checkout.session.expired',
        ].includes(event.type)
      ) {
        const result = await handleExperienceCheckoutStripeEvent({
          eventId: event.id,
          eventType: event.type,
          occurredAt: new Date(event.created * 1_000),
          payloadHash: createHash('sha256').update(rawBody).digest('hex'),
          accountId: event.account ?? null,
          session: event.data.object as Stripe.Checkout.Session,
        });
        if (
          !result.handled &&
          !(
            event.type === 'checkout.session.completed' &&
            !event.account &&
            (await handleBillingWebhook(event))
          )
        ) {
          logger.info(
            { eventType: event.type },
            '[stripe-webhook] Unhandled checkout session event',
          );
        }
      } else if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as { id: string; metadata?: Record<string, string> };
        const paymentService = new GiftCardPaymentService(db);
        if (pi.metadata?.type === 'experience_checkout') {
          // Déjà confirmé via checkout.session.* ; ici ce serait une 500 en boucle de retry.
          logger.info({ paymentIntentId: pi.id }, '[stripe-webhook] Experience PI ignored');
        } else if (pi.metadata?.type === 'crowdfunding_contribution') {
          let details: import('./gift-card.types').ContributeInput;
          if (pi.metadata.checkoutId) {
            const checkout = await new GiftCardCheckoutService(db).findForPayment(
              pi.metadata,
              pi.id,
            );
            if (!checkout) throw new Error('Commande de contribution introuvable');
            details = checkout.payload as unknown as import('./gift-card.types').ContributeInput;
          } else {
            details = {
              code: pi.metadata.giftCardCode,
              amount: Number(pi.metadata.amount),
              contributorName: pi.metadata.contributorName ?? '',
              contributorEmail: pi.metadata.contributorEmail,
              message: pi.metadata.message,
              isPublicName: pi.metadata.isPublicName === 'true',
            };
          }
          await new GiftCardCrowdfundingService(db).contribute(details, pi.id, {
            stripeAccountId: event.account,
            checkoutId: pi.metadata.checkoutId,
          });
        } else if (pi.metadata?.checkoutId || pi.metadata?.restaurantId) {
          await paymentService.handleStripeWebhook(pi.id, pi.metadata ?? {}, event.account);
        }
      } else if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object as { id: string; metadata?: Record<string, string> };
        const paymentService = new GiftCardPaymentService(db);
        await paymentService.handlePaymentFailed(pi.id, pi.metadata ?? {});
      } else if (
        [
          'charge.refunded',
          'refund.created',
          'refund.updated',
          'refund.failed',
          'charge.dispute.created',
          'charge.dispute.closed',
        ].includes(event.type)
      ) {
        const charge = event.data.object as {
          payment_intent?: string | { id: string } | null;
          status: string;
          charge?: string;
        };
        let paymentIntentId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id;
        if (!paymentIntentId && charge.charge) {
          const { retrieveChargePaymentIntent } = await import('./stripe.service');
          paymentIntentId = await retrieveChargePaymentIntent(charge.charge, event.account);
        }
        if (paymentIntentId) {
          if (event.type.startsWith('refund.')) {
            await handleExperienceRefundStripeEvent({
              eventId: event.id,
              eventType: event.type,
              occurredAt: new Date(event.created * 1_000),
              payloadHash: createHash('sha256').update(rawBody).digest('hex'),
              accountId: event.account ?? null,
              refund: event.data.object as Stripe.Refund,
            });
          }
          const paymentService = new GiftCardPaymentService(db);
          await paymentService.handleRefundUpdated(paymentIntentId, charge.status, event.account);
        }
      } else if (!event.account && (await handleBillingWebhook(event))) {
        logger.info(
          { eventType: event.type },
          '[stripe-webhook] Subscription billing state updated',
        );
      } else {
        logger.info(
          { eventType: event.type },
          '[gift-card-routes] Unhandled Stripe webhook event type',
        );
      }

      return reply.send({ received: true });
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        '[gift-card-routes] Stripe webhook processing failed',
      );
      return reply.status(500).send({ error: 'WEBHOOK_PROCESSING_FAILED' });
    }
  });
}
