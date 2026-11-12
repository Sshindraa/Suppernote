import {
  ExperienceCheckoutStatus,
  ExperienceReservationStatus,
  ExperienceSessionStatus,
  ExperienceStatus,
  Prisma,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import { canonicalDemoSlug, getDemoSlugAlias } from '@suppernote/shared';
import { db } from '../../shared/db/client';
import {
  createExperienceCheckoutSession,
  createRefund,
  expireExperienceCheckoutSession,
  retrieveConnectedAccount,
  retrieveExperienceCheckoutSession,
} from '../gift-cards/stripe.service';
import { normalizeCustomerPhone } from '../customers/customer-crm.service';

const CHECKOUT_HOLD_MS = 35 * 60 * 1_000;
const PUBLIC_EXPERIENCE_LIMIT = 100;

export class ExperienceCheckoutError extends Error {
  constructor(
    readonly code:
      | 'EXPERIENCE_NOT_FOUND'
      | 'EXPERIENCE_SESSION_NOT_FOUND'
      | 'EXPERIENCE_CAPACITY_EXCEEDED'
      | 'EXPERIENCE_CHECKOUT_IDEMPOTENCY_CONFLICT'
      | 'EXPERIENCE_PAYMENT_NOT_CONFIGURED'
      | 'EXPERIENCE_STRIPE_NOT_READY'
      | 'EXPERIENCE_CHECKOUT_NOT_FOUND'
      | 'EXPERIENCE_REFUND_FAILED'
      | 'EXPERIENCE_PAYMENT_EVENT_INVALID',
    readonly statusCode = 409,
  ) {
    super(code);
    this.name = 'ExperienceCheckoutError';
  }
}

function hashIdempotencyKey(restaurantId: string, key: string): string {
  return createHash('sha256').update(`experience-checkout:${restaurantId}:${key}`).digest('hex');
}

function hashActor(value: string): string {
  return createHash('sha256').update(`experience-public:${value}`).digest('hex');
}

function slugUrl(slug: string, query: string): string {
  const origin = (process.env.CONNECT_URL ?? process.env.SITE_URL ?? '').replace(/\/$/, '');
  if (!origin) throw new Error('CONNECT_URL or SITE_URL is required for experience checkout.');
  return `${origin}/restaurant/${encodeURIComponent(slug)}/experiences${query}`;
}

async function experienceRestaurantBySlug(slug: string) {
  // tenant-scoping: global — resolve the restaurant root by its unique public slug; all child records use the returned restaurantId.
  const select = {
    id: true,
    name: true,
    publishedAt: true,
    exposureSettings: { select: { connectPublished: true } },
    experienceStripeAccountId: true,
    giftCardStripeAccountId: true,
    experienceCommissionRate: true,
  } as const;
  const alias = getDemoSlugAlias(slug);
  return (
    (await db.restaurant.findUnique({ where: { slug }, select })) ??
    (alias
      ? // tenant-scoping: global — the unique public alias resolves the restaurant root.
        await db.restaurant.findUnique({ where: { slug: alias }, select })
      : null)
  );
}

async function publicRestaurant(slug: string) {
  const restaurant = await experienceRestaurantBySlug(slug);
  if (!restaurant?.publishedAt || !restaurant.exposureSettings?.connectPublished) return null;
  return restaurant;
}

export async function getExperiencePaymentReadiness(restaurantId: string) {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      slug: true,
      publishedAt: true,
      experienceStripeAccountId: true,
      giftCardStripeAccountId: true,
      experienceCommissionRate: true,
      exposureSettings: { select: { connectPublished: true } },
    },
  });
  if (!restaurant) throw new ExperienceCheckoutError('EXPERIENCE_NOT_FOUND', 404);

  const stripeAccountId =
    restaurant.experienceStripeAccountId ?? restaurant.giftCardStripeAccountId;
  let chargesEnabled = false;
  let payoutsEnabled = false;
  let stripeStatus: 'not_configured' | 'not_ready' | 'ready' | 'unavailable' = 'not_configured';
  if (stripeAccountId) {
    try {
      const account = await retrieveConnectedAccount(stripeAccountId);
      chargesEnabled = account.chargesEnabled;
      payoutsEnabled = account.payoutsEnabled;
      stripeStatus = chargesEnabled && payoutsEnabled ? 'ready' : 'not_ready';
    } catch {
      stripeStatus = 'unavailable';
    }
  }

  const commissionRate = restaurant.experienceCommissionRate?.toNumber() ?? null;
  const bookingEnabled =
    process.env.EXPERIENCES_ENABLED === 'true' && process.env.EXPERIENCE_BOOKING_ENABLED === 'true';
  const restaurantPublished = Boolean(
    restaurant.slug && restaurant.publishedAt && restaurant.exposureSettings?.connectPublished,
  );
  const canBook =
    bookingEnabled && restaurantPublished && stripeStatus === 'ready' && commissionRate !== null;

  return {
    canBook,
    bookingEnabled,
    restaurantPublished,
    stripeStatus,
    chargesEnabled,
    payoutsEnabled,
    commissionConfigured: commissionRate !== null,
    commissionRatePercent: commissionRate === null ? null : commissionRate * 100,
    blocker: canBook
      ? null
      : !bookingEnabled
        ? 'pilot_closed'
        : !restaurantPublished
          ? 'restaurant_unpublished'
          : stripeStatus === 'not_configured'
            ? 'stripe_not_configured'
            : stripeStatus === 'unavailable'
              ? 'stripe_unavailable'
              : stripeStatus === 'not_ready'
                ? 'stripe_not_ready'
                : 'commission_not_configured',
  } as const;
}

export async function listPublicExperiences(slug: string, now = new Date()) {
  const restaurant = await publicRestaurant(slug);
  if (!restaurant) throw new ExperienceCheckoutError('EXPERIENCE_NOT_FOUND', 404);
  const rows = await db.experience.findMany({
    where: {
      restaurantId: restaurant.id,
      status: ExperienceStatus.ACTIVE,
      sessions: { some: { status: ExperienceSessionStatus.OPEN, startsAt: { gt: now } } },
    },
    orderBy: { name: 'asc' },
    take: PUBLIC_EXPERIENCE_LIMIT,
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      durationMinutes: true,
      priceCents: true,
      currency: true,
      capacity: true,
      sessions: {
        where: { status: ExperienceSessionStatus.OPEN, startsAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
        take: PUBLIC_EXPERIENCE_LIMIT,
        select: {
          id: true,
          startsAt: true,
          endsAt: true,
          capacityOverride: true,
          reservations: {
            where: { status: ExperienceReservationStatus.CONFIRMED },
            select: { quantity: true },
          },
          checkouts: {
            where: { status: ExperienceCheckoutStatus.OPEN, expiresAt: { gt: now } },
            select: { quantity: true },
          },
        },
      },
    },
  });

  return {
    restaurant: { name: restaurant.name },
    experiences: rows.map((experience) => ({
      id: experience.id,
      key: experience.key,
      name: experience.name,
      description: experience.description,
      durationMinutes: experience.durationMinutes,
      priceCents: experience.priceCents,
      currency: experience.currency,
      capacity: experience.capacity,
      sessions: experience.sessions.map((session) => {
        const used =
          session.reservations.reduce((total, row) => total + row.quantity, 0) +
          session.checkouts.reduce((total, row) => total + row.quantity, 0);
        const capacity = session.capacityOverride ?? experience.capacity;
        return {
          id: session.id,
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          capacity,
          remaining: Math.max(capacity - used, 0),
        };
      }),
    })),
  };
}

export async function createPublicExperienceCheckout(input: {
  slug: string;
  experienceId: string;
  sessionId: string;
  quantity: number;
  idempotencyKey: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const restaurant = await publicRestaurant(input.slug);
  if (!restaurant) throw new ExperienceCheckoutError('EXPERIENCE_NOT_FOUND', 404);
  const stripeAccountId =
    restaurant.experienceStripeAccountId ?? restaurant.giftCardStripeAccountId;
  const commissionRate = restaurant.experienceCommissionRate?.toNumber();
  if (
    !stripeAccountId ||
    commissionRate === undefined ||
    commissionRate < 0 ||
    commissionRate > 1
  ) {
    throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_NOT_CONFIGURED', 503);
  }
  const account = await retrieveConnectedAccount(stripeAccountId);
  if (!account.chargesEnabled || !account.payoutsEnabled) {
    throw new ExperienceCheckoutError('EXPERIENCE_STRIPE_NOT_READY', 503);
  }
  const key = hashIdempotencyKey(restaurant.id, input.idempotencyKey);
  let checkout = await db.experienceCheckout.findFirst({
    where: { idempotencyKey: key, restaurantId: restaurant.id },
  });
  let sessionData: {
    id: string;
    startsAt: Date;
    experience: { name: string; currency: string };
  } | null = null;

  if (checkout) {
    if (
      checkout.restaurantId !== restaurant.id ||
      checkout.experienceId !== input.experienceId ||
      checkout.sessionId !== input.sessionId ||
      checkout.quantity !== input.quantity
    ) {
      throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_IDEMPOTENCY_CONFLICT');
    }
    if (checkout.status !== ExperienceCheckoutStatus.OPEN || checkout.expiresAt <= now) {
      throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_IDEMPOTENCY_CONFLICT', 410);
    }
    sessionData = await db.experienceSession.findFirst({
      where: { id: checkout.sessionId, restaurantId: restaurant.id },
      select: { id: true, startsAt: true, experience: { select: { name: true, currency: true } } },
    });
  } else {
    const expiresAt = new Date(now.getTime() + CHECKOUT_HOLD_MS);
    const created = await db.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`experience:${restaurant.id}:${input.sessionId}`}))`,
      );
      const session = await tx.experienceSession.findFirst({
        where: {
          id: input.sessionId,
          experienceId: input.experienceId,
          restaurantId: restaurant.id,
          status: ExperienceSessionStatus.OPEN,
          startsAt: { gt: now },
          experience: { status: ExperienceStatus.ACTIVE },
        },
        select: {
          id: true,
          startsAt: true,
          experience: { select: { name: true, currency: true, priceCents: true, capacity: true } },
          capacityOverride: true,
        },
      });
      if (!session) throw new ExperienceCheckoutError('EXPERIENCE_SESSION_NOT_FOUND', 404);
      const [reservations, checkouts] = await Promise.all([
        tx.experienceReservation.findMany({
          where: {
            sessionId: session.id,
            restaurantId: restaurant.id,
            status: ExperienceReservationStatus.CONFIRMED,
          },
          select: { quantity: true },
        }),
        tx.experienceCheckout.findMany({
          where: {
            sessionId: session.id,
            restaurantId: restaurant.id,
            status: ExperienceCheckoutStatus.OPEN,
            expiresAt: { gt: now },
          },
          select: { quantity: true },
        }),
      ]);
      const used =
        reservations.reduce((sum, row) => sum + row.quantity, 0) +
        checkouts.reduce((sum, row) => sum + row.quantity, 0);
      const capacity = session.capacityOverride ?? session.experience.capacity;
      if (used + input.quantity > capacity) {
        throw new ExperienceCheckoutError('EXPERIENCE_CAPACITY_EXCEEDED');
      }
      const unitPriceCents = session.experience.priceCents;
      const totalPriceCents = unitPriceCents * input.quantity;
      const sokarFeeCents = Math.round(totalPriceCents * commissionRate);
      const newCheckout = await tx.experienceCheckout.create({
        data: {
          restaurantId: restaurant.id,
          experienceId: input.experienceId,
          sessionId: session.id,
          quantity: input.quantity,
          unitPriceCents,
          totalPriceCents,
          sokarFeeCents,
          currency: session.experience.currency,
          stripeAccountId,
          idempotencyKey: key,
          expiresAt,
        },
      });
      return { checkout: newCheckout, session };
    });
    checkout = created.checkout;
    sessionData = created.session;
  }

  if (!checkout || !sessionData)
    throw new ExperienceCheckoutError('EXPERIENCE_SESSION_NOT_FOUND', 404);
  const sessionUrlBase = slugUrl(canonicalDemoSlug(input.slug), '');
  const stripeSession = checkout.stripeCheckoutSessionId
    ? await retrieveExperienceCheckoutSession(
        checkout.stripeCheckoutSessionId,
        checkout.stripeAccountId,
      )
    : await createExperienceCheckoutSession({
        amountCents: checkout.totalPriceCents,
        applicationFeeCents: checkout.sokarFeeCents,
        currency: checkout.currency,
        restaurantId: restaurant.id,
        experienceCheckoutId: checkout.id,
        experienceName: sessionData.experience.name,
        sessionStartsAt: sessionData.startsAt,
        quantity: checkout.quantity,
        expiresAt: checkout.expiresAt,
        successUrl: `${sessionUrlBase}?checkout=success&checkout_id=${checkout.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${sessionUrlBase}?checkout=cancelled&checkout_id=${checkout.id}&session_id={CHECKOUT_SESSION_ID}`,
        stripeAccountId: checkout.stripeAccountId,
        idempotencyKey: `experience-checkout:${checkout.id}`,
      });
  await db.experienceCheckout.update({
    where: { id: checkout.id, restaurantId: restaurant.id },
    data: {
      stripeCheckoutSessionId: stripeSession.id,
      stripePaymentIntentId: stripeSession.paymentIntentId,
    },
  });
  return {
    checkoutId: checkout.id,
    url: stripeSession.url,
    expiresAt: checkout.expiresAt,
  };
}

export async function getPublicExperienceCheckout(input: {
  slug: string;
  checkoutId: string;
  stripeSessionId: string;
}) {
  const restaurant = await experienceRestaurantBySlug(input.slug);
  if (!restaurant) throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_NOT_FOUND', 404);
  const checkout = await db.experienceCheckout.findFirst({
    where: {
      id: input.checkoutId,
      restaurantId: restaurant.id,
      stripeCheckoutSessionId: input.stripeSessionId,
    },
    select: {
      status: true,
      quantity: true,
      expiresAt: true,
      reservation: {
        select: {
          id: true,
          experience: { select: { name: true } },
          session: { select: { startsAt: true } },
        },
      },
    },
  });
  if (!checkout) throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_NOT_FOUND', 404);
  return {
    status:
      checkout.status === ExperienceCheckoutStatus.OPEN && checkout.expiresAt <= new Date()
        ? ExperienceCheckoutStatus.EXPIRED
        : checkout.status,
    reservation: checkout.reservation,
    quantity: checkout.quantity,
  };
}

export async function cancelPublicExperienceCheckout(input: {
  slug: string;
  checkoutId: string;
  stripeSessionId: string;
}) {
  const restaurant = await experienceRestaurantBySlug(input.slug);
  if (!restaurant) throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_NOT_FOUND', 404);
  const checkout = await db.experienceCheckout.findFirst({
    where: {
      id: input.checkoutId,
      restaurantId: restaurant.id,
      stripeCheckoutSessionId: input.stripeSessionId,
    },
    select: { id: true, status: true, stripeAccountId: true },
  });
  if (!checkout) throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_NOT_FOUND', 404);
  if (checkout.status !== ExperienceCheckoutStatus.OPEN) return { status: checkout.status };

  const stripeSession = await expireExperienceCheckoutSession(
    input.stripeSessionId,
    checkout.stripeAccountId,
  );
  if (stripeSession.status === 'expired') {
    await db.experienceCheckout.updateMany({
      where: {
        id: checkout.id,
        restaurantId: restaurant.id,
        status: ExperienceCheckoutStatus.OPEN,
      },
      data: { status: ExperienceCheckoutStatus.EXPIRED },
    });
    return { status: ExperienceCheckoutStatus.EXPIRED };
  }
  return { status: checkout.status };
}

async function persistExperienceRefund(input: {
  checkoutId: string;
  restaurantId: string;
  refund: { id: string; status: string };
  occurredAt?: Date;
}) {
  const mappedStatus =
    input.refund.status === 'succeeded'
      ? ExperienceCheckoutStatus.REFUNDED
      : input.refund.status === 'failed' || input.refund.status === 'canceled'
        ? ExperienceCheckoutStatus.REFUND_FAILED
        : ExperienceCheckoutStatus.REFUND_PENDING;
  await db.experienceCheckout.updateMany({
    where: {
      id: input.checkoutId,
      restaurantId: input.restaurantId,
      status: {
        notIn: [ExperienceCheckoutStatus.REFUNDED, ExperienceCheckoutStatus.REFUND_FAILED],
      },
    },
    data: {
      status: mappedStatus,
      stripeRefundId: input.refund.id,
      refundedAt:
        mappedStatus === ExperienceCheckoutStatus.REFUNDED
          ? (input.occurredAt ?? new Date())
          : null,
    },
  });
  return db.experienceCheckout.findUniqueOrThrow({
    where: { id: input.checkoutId, restaurantId: input.restaurantId },
    select: { status: true },
  });
}

export async function refundPaidExperienceReservation(input: {
  restaurantId: string;
  reservationId: string;
}): Promise<'pending' | 'refunded' | 'not_required'> {
  const checkout = await db.experienceCheckout.findFirst({
    where: { restaurantId: input.restaurantId, reservationId: input.reservationId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      stripeAccountId: true,
      stripePaymentIntentId: true,
      stripeRefundId: true,
    },
  });
  if (!checkout || checkout.status === ExperienceCheckoutStatus.EXPIRED) return 'not_required';
  if (checkout.status === ExperienceCheckoutStatus.REFUNDED) return 'refunded';
  if (checkout.status === ExperienceCheckoutStatus.REFUND_FAILED) {
    throw new ExperienceCheckoutError('EXPERIENCE_REFUND_FAILED', 409);
  }
  if (
    checkout.status !== ExperienceCheckoutStatus.PAID &&
    checkout.status !== ExperienceCheckoutStatus.REFUND_PENDING
  ) {
    return 'not_required';
  }
  if (!checkout.stripePaymentIntentId) {
    throw new ExperienceCheckoutError('EXPERIENCE_REFUND_FAILED', 409);
  }

  const refund = await createRefund({
    paymentIntentId: checkout.stripePaymentIntentId,
    idempotencyKey: `experience-cancel-refund:${checkout.id}`,
    stripeAccountId: checkout.stripeAccountId,
  });
  const stored = await persistExperienceRefund({
    checkoutId: checkout.id,
    restaurantId: checkout.restaurantId,
    refund,
  });
  if (stored.status === ExperienceCheckoutStatus.REFUND_FAILED) {
    throw new ExperienceCheckoutError('EXPERIENCE_REFUND_FAILED', 409);
  }
  return stored.status === ExperienceCheckoutStatus.REFUNDED ? 'refunded' : 'pending';
}

export type ExperienceCheckoutStripeEvent = {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  payloadHash: string;
  accountId: string | null;
  session: Stripe.Checkout.Session;
};

export async function handleExperienceRefundStripeEvent(input: {
  eventId: string;
  eventType: string;
  occurredAt: Date;
  payloadHash: string;
  accountId: string | null;
  refund: Stripe.Refund;
}) {
  const paymentIntentId =
    typeof input.refund.payment_intent === 'string'
      ? input.refund.payment_intent
      : input.refund.payment_intent?.id;
  if (!paymentIntentId) return { handled: false };
  // tenant-scoping: global — Stripe payment-intent IDs are globally unique; verify the connected account before any tenant write.
  const checkout = await db.experienceCheckout.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
    select: { id: true, restaurantId: true, stripeAccountId: true, status: true },
  });
  if (!checkout) return { handled: false };
  if (checkout.stripeAccountId !== input.accountId) {
    throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
  }

  return db.$transaction(async (tx) => {
    const seen = await tx.experiencePaymentEvent.findFirst({
      where: { providerEventId: input.eventId, restaurantId: checkout.restaurantId },
      select: { id: true },
    });
    if (seen) return { handled: true, replayed: true };
    const refundStatus = input.refund.status;
    const status =
      refundStatus === 'succeeded'
        ? ExperienceCheckoutStatus.REFUNDED
        : refundStatus === 'failed' || refundStatus === 'canceled'
          ? ExperienceCheckoutStatus.REFUND_FAILED
          : ExperienceCheckoutStatus.REFUND_PENDING;
    if (
      checkout.status !== ExperienceCheckoutStatus.REFUNDED &&
      checkout.status !== ExperienceCheckoutStatus.REFUND_FAILED
    ) {
      await tx.experienceCheckout.updateMany({
        where: {
          id: checkout.id,
          restaurantId: checkout.restaurantId,
          status: {
            notIn: [ExperienceCheckoutStatus.REFUNDED, ExperienceCheckoutStatus.REFUND_FAILED],
          },
        },
        data: {
          status,
          stripeRefundId: input.refund.id,
          refundedAt: status === ExperienceCheckoutStatus.REFUNDED ? input.occurredAt : null,
        },
      });
    }
    await tx.experiencePaymentEvent.create({
      data: {
        restaurantId: checkout.restaurantId,
        checkoutId: checkout.id,
        providerEventId: input.eventId,
        eventType: input.eventType,
        payloadHash: input.payloadHash,
        occurredAt: input.occurredAt,
      },
    });
    return { handled: true, replayed: false };
  });
}

export async function handleExperienceCheckoutStripeEvent(input: ExperienceCheckoutStripeEvent) {
  const session = input.session;
  const metadata = session.metadata ?? {};
  if (metadata.type !== 'experience_checkout') return { handled: false };
  const restaurantId = metadata.restaurantId;
  const checkoutId = metadata.experienceCheckoutId;
  if (!restaurantId || !checkoutId)
    throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
  const checkout = await db.experienceCheckout.findFirst({
    where: { id: checkoutId, restaurantId },
    include: { experience: true, session: true },
  });
  if (
    !checkout ||
    checkout.stripeAccountId !== input.accountId ||
    (checkout.stripeCheckoutSessionId && checkout.stripeCheckoutSessionId !== session.id)
  ) {
    throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
  }

  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id;
  const paymentCompleted =
    session.payment_status === 'paid' ||
    (checkout.totalPriceCents === 0 && session.payment_status === 'no_payment_required');
  if (input.eventType === 'checkout.session.expired') {
    return db.$transaction(async (tx) => {
      const seen = await tx.experiencePaymentEvent.findFirst({
        where: { providerEventId: input.eventId, restaurantId },
        select: { id: true },
      });
      if (seen) return { handled: true, replayed: true };
      await tx.experienceCheckout.updateMany({
        where: { id: checkout.id, restaurantId, status: ExperienceCheckoutStatus.OPEN },
        data: { status: ExperienceCheckoutStatus.EXPIRED },
      });
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: checkout.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return { handled: true, replayed: false };
    });
  }
  if (
    !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(
      input.eventType,
    )
  ) {
    return { handled: false };
  }
  if (
    !paymentCompleted ||
    (checkout.totalPriceCents > 0 && !paymentIntentId) ||
    session.amount_total !== checkout.totalPriceCents ||
    session.currency?.toUpperCase() !== checkout.currency
  ) {
    throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
  }

  if (
    checkout.status === ExperienceCheckoutStatus.PAID ||
    checkout.status === ExperienceCheckoutStatus.FREE ||
    checkout.status === ExperienceCheckoutStatus.REFUNDED ||
    checkout.status === ExperienceCheckoutStatus.REFUND_FAILED ||
    (checkout.status === ExperienceCheckoutStatus.REFUND_PENDING && checkout.stripeRefundId)
  ) {
    return db.$transaction(async (tx) => {
      const seen = await tx.experiencePaymentEvent.findFirst({
        where: { providerEventId: input.eventId, restaurantId },
        select: { id: true },
      });
      if (seen) return { handled: true, replayed: true };
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: checkout.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return { handled: true, replayed: true };
    });
  }

  const shouldRefund =
    checkout.status !== ExperienceCheckoutStatus.OPEN ||
    checkout.expiresAt <= input.occurredAt ||
    checkout.session.status !== ExperienceSessionStatus.OPEN ||
    checkout.session.startsAt <= input.occurredAt ||
    checkout.experience.status !== ExperienceStatus.ACTIVE;
  if (shouldRefund && checkout.totalPriceCents === 0) {
    return db.$transaction(async (tx) => {
      const seen = await tx.experiencePaymentEvent.findFirst({
        where: { providerEventId: input.eventId, restaurantId },
        select: { id: true },
      });
      if (seen) return { handled: true, replayed: true };
      await tx.experienceCheckout.update({
        where: { id: checkout.id, restaurantId },
        data: { status: ExperienceCheckoutStatus.EXPIRED },
      });
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: checkout.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return { handled: true, replayed: false, bookingUnavailable: true };
    });
  }
  if (shouldRefund) {
    if (!paymentIntentId) {
      throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
    }
    const refund = await createRefund({
      paymentIntentId,
      idempotencyKey: `experience-late-payment-refund:${checkout.id}`,
      stripeAccountId: checkout.stripeAccountId,
    });
    return db.$transaction(async (tx) => {
      const seen = await tx.experiencePaymentEvent.findFirst({
        where: { providerEventId: input.eventId, restaurantId },
        select: { id: true },
      });
      if (seen) return { handled: true, replayed: true };
      await tx.experienceCheckout.updateMany({
        where: {
          id: checkout.id,
          restaurantId,
          status: {
            notIn: [ExperienceCheckoutStatus.REFUNDED, ExperienceCheckoutStatus.REFUND_FAILED],
          },
        },
        data: {
          status:
            refund.status === 'succeeded'
              ? ExperienceCheckoutStatus.REFUNDED
              : refund.status === 'failed' || refund.status === 'canceled'
                ? ExperienceCheckoutStatus.REFUND_FAILED
                : ExperienceCheckoutStatus.REFUND_PENDING,
          stripePaymentIntentId: paymentIntentId,
          stripeRefundId: refund.id,
          refundedAt: refund.status === 'succeeded' ? new Date() : null,
        },
      });
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: checkout.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return { handled: true, replayed: false, refunded: true };
    });
  }

  const details = session.customer_details;
  const phone = details?.phone ? normalizeCustomerPhone(details.phone) : null;
  const email = details?.email?.trim().toLowerCase() || null;
  const submittedName = session.custom_fields.find((field) => field.key === 'guest_name');
  const customName = submittedName?.type === 'text' ? submittedName.text?.value?.trim() : null;
  const name = details?.name?.trim() || customName || null;
  const transactionResult = await db.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`experience:${restaurantId}:${checkout.sessionId}`}))`,
    );
    const seen = await tx.experiencePaymentEvent.findFirst({
      where: { providerEventId: input.eventId, restaurantId },
      select: { id: true },
    });
    if (seen) return { handled: true, replayed: true };
    const current = await tx.experienceCheckout.findFirst({
      where: { id: checkout.id, restaurantId },
      include: { experience: true, session: true },
    });
    if (!current) throw new ExperienceCheckoutError('EXPERIENCE_CHECKOUT_NOT_FOUND', 404);
    if (current.status === ExperienceCheckoutStatus.PAID) {
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: checkout.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return { handled: true, replayed: true };
    }
    if (
      current.status !== ExperienceCheckoutStatus.OPEN ||
      current.expiresAt <= input.occurredAt ||
      current.session.status !== ExperienceSessionStatus.OPEN ||
      current.session.startsAt <= input.occurredAt ||
      current.experience.status !== ExperienceStatus.ACTIVE
    ) {
      await tx.experienceCheckout.update({
        where: { id: current.id, restaurantId },
        data: {
          status:
            current.totalPriceCents === 0
              ? ExperienceCheckoutStatus.EXPIRED
              : ExperienceCheckoutStatus.REFUND_PENDING,
          stripePaymentIntentId: paymentIntentId,
        },
      });
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: current.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return current.totalPriceCents === 0
        ? { handled: true, replayed: false }
        : { handled: true, replayed: false, refundRequired: true as const };
    }
    const [reservations, otherCheckouts] = await Promise.all([
      tx.experienceReservation.findMany({
        where: {
          restaurantId,
          sessionId: current.sessionId,
          status: ExperienceReservationStatus.CONFIRMED,
        },
        select: { quantity: true },
      }),
      tx.experienceCheckout.findMany({
        where: {
          restaurantId,
          sessionId: current.sessionId,
          id: { not: current.id },
          status: ExperienceCheckoutStatus.OPEN,
          expiresAt: { gt: new Date() },
        },
        select: { quantity: true },
      }),
    ]);
    const used =
      reservations.reduce((sum, row) => sum + row.quantity, 0) +
      otherCheckouts.reduce((sum, row) => sum + row.quantity, 0);
    const capacity = current.session.capacityOverride ?? current.experience.capacity;
    if (used + current.quantity > capacity) {
      await tx.experienceCheckout.update({
        where: { id: current.id, restaurantId },
        data: {
          status:
            current.totalPriceCents === 0
              ? ExperienceCheckoutStatus.EXPIRED
              : ExperienceCheckoutStatus.REFUND_PENDING,
          stripePaymentIntentId: paymentIntentId,
        },
      });
      await tx.experiencePaymentEvent.create({
        data: {
          restaurantId,
          checkoutId: current.id,
          providerEventId: input.eventId,
          eventType: input.eventType,
          payloadHash: input.payloadHash,
          occurredAt: input.occurredAt,
        },
      });
      return current.totalPriceCents === 0
        ? { handled: true, replayed: false }
        : { handled: true, replayed: false, refundRequired: true as const };
    }
    let customerId: string | null = null;
    if (phone) {
      const customer = await tx.customer.upsert({
        where: { restaurantId_phone: { restaurantId, phone } },
        create: { restaurantId, phone, name, emailNormalized: email },
        update: { name: name ?? undefined, emailNormalized: email ?? undefined },
        select: { id: true },
      });
      customerId = customer.id;
    }
    const reservation = await tx.experienceReservation.create({
      data: {
        restaurantId,
        experienceId: current.experienceId,
        sessionId: current.sessionId,
        customerId,
        customerName: name,
        customerEmail: email,
        customerPhone: phone,
        idempotencyKey: `stripe-experience:${current.id}`,
        quantity: current.quantity,
        unitPriceCents: current.unitPriceCents,
        totalPriceCents: current.totalPriceCents,
        currency: current.currency,
        status: ExperienceReservationStatus.CONFIRMED,
        createdByHash: hashActor(current.id),
      },
    });
    await tx.experienceCheckout.update({
      where: { id: current.id, restaurantId },
      data: {
        status:
          current.totalPriceCents === 0
            ? ExperienceCheckoutStatus.FREE
            : ExperienceCheckoutStatus.PAID,
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
        reservationId: reservation.id,
      },
    });
    await tx.experiencePaymentEvent.create({
      data: {
        restaurantId,
        checkoutId: current.id,
        providerEventId: input.eventId,
        eventType: input.eventType,
        payloadHash: input.payloadHash,
        occurredAt: input.occurredAt,
      },
    });
    return { handled: true, replayed: false, reservationId: reservation.id };
  });

  if ('refundRequired' in transactionResult && transactionResult.refundRequired) {
    if (!paymentIntentId) {
      throw new ExperienceCheckoutError('EXPERIENCE_PAYMENT_EVENT_INVALID', 400);
    }
    const refund = await createRefund({
      paymentIntentId,
      idempotencyKey: `experience-late-payment-refund:${checkout.id}`,
      stripeAccountId: checkout.stripeAccountId,
    });
    await persistExperienceRefund({
      checkoutId: checkout.id,
      restaurantId: checkout.restaurantId,
      refund,
    });
    return { handled: true, replayed: false, refunded: true };
  }
  return transactionResult;
}

export async function expireExperienceCheckouts(input?: { now?: Date; limit?: number }) {
  const now = input?.now ?? new Date();
  const limit = Math.min(Math.max(input?.limit ?? 500, 1), 1_000);
  // tenant-scoping: global — scheduled expiry sweeps all tenants; the following update pairs each ID with its restaurantId.
  const rows = await db.experienceCheckout.findMany({
    where: { status: ExperienceCheckoutStatus.OPEN, expiresAt: { lte: now } },
    orderBy: { expiresAt: 'asc' },
    take: limit,
    select: { id: true, restaurantId: true },
  });
  if (rows.length === 0) return 0;
  const result = await db.experienceCheckout.updateMany({
    where: {
      OR: rows.map((row) => ({ id: row.id, restaurantId: row.restaurantId })),
      status: ExperienceCheckoutStatus.OPEN,
    },
    data: { status: ExperienceCheckoutStatus.EXPIRED },
  });
  return result.count;
}

export function newExperienceCheckoutIdempotencyKey(): string {
  return randomUUID();
}
