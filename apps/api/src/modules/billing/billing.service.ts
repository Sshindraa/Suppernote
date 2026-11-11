import { PRICING_CATALOG_VERSION, TRIAL_DAYS, VAT_MENTION } from '@suppernote/shared';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';
import { Prisma, type Plan } from '@prisma/client';
import { db } from '../../shared/db/client';
import { logger } from '../../shared/logger/pino';
import { queues } from '../../shared/queue/queues';
import { buildBillingNotificationJobId } from '../../shared/queue/job-options';
import { resolveAccountOwnerEmail } from '../restaurants/account-email.service';
import type { BillingNotificationJobData } from './billing-notification.worker';
import type { ActivityRecap } from './billing-notification-emails';
import { loadActivityRecap } from './billing-activity';

export const PUBLIC_BILLING_PLANS = ['essential', 'pro', 'multi-site'] as const;
export type PublicBillingPlan = (typeof PUBLIC_BILLING_PLANS)[number];

export const BILLING_INTERVALS = ['monthly', 'annual'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

const PLAN_TO_DATABASE: Record<PublicBillingPlan, Plan> = {
  // STARTER is the historical database value used for the Essential offer.
  essential: 'STARTER',
  pro: 'PRO',
  'multi-site': 'PREMIUM',
};

const PRICE_ENV_BY_PLAN: Record<
  PublicBillingPlan,
  Record<BillingInterval, keyof NodeJS.ProcessEnv>
> = {
  essential: {
    monthly: 'STRIPE_PRICE_ESSENTIAL_MONTHLY',
    annual: 'STRIPE_PRICE_ESSENTIAL_ANNUAL',
  },
  pro: {
    monthly: 'STRIPE_PRICE_PRO_MONTHLY',
    annual: 'STRIPE_PRICE_PRO_ANNUAL',
  },
  'multi-site': {
    monthly: 'STRIPE_PRICE_MULTI_SITE_MONTHLY',
    annual: 'STRIPE_PRICE_MULTI_SITE_ANNUAL',
  },
};

const MULTI_SITE_ADDON_PRICE_ENV_BY_INTERVAL: Record<BillingInterval, keyof NodeJS.ProcessEnv> = {
  monthly: 'STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY',
  annual: 'STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL',
};

const MIN_MULTI_SITE_COUNT = 1;
const MAX_MULTI_SITE_COUNT = 100;
const CHECKOUT_IDEMPOTENCY_BUCKET_MS = 24 * 60 * 60 * 1000;
const STRIPE_EVENT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Statuses of an ended subscription. A restaurant whose subscription reached one of them is
 * suspended: the voice agent stops answering until a new subscription starts. `past_due` is not
 * here: Stripe retries the payment and the service keeps running meanwhile.
 */
const SUSPENDED_SUBSCRIPTION_STATUSES = ['canceled', 'incomplete_expired', 'unpaid'];

export class BillingNotConfiguredError extends Error {
  readonly code = 'BILLING_NOT_CONFIGURED';

  constructor() {
    super('Stripe Billing is not configured');
    this.name = 'BillingNotConfiguredError';
  }
}

export class BillingRestaurantNotFoundError extends Error {
  readonly code = 'RESTAURANT_NOT_FOUND';

  constructor() {
    super('Restaurant not found');
    this.name = 'BillingRestaurantNotFoundError';
  }
}

export class BillingCheckoutError extends Error {
  readonly code = 'BILLING_CHECKOUT_FAILED';

  constructor() {
    super('Unable to create billing checkout session');
    this.name = 'BillingCheckoutError';
  }
}

export class BillingCustomerNotFoundError extends Error {
  readonly code = 'BILLING_CUSTOMER_NOT_FOUND';

  constructor() {
    super('No Stripe customer is associated with this account');
    this.name = 'BillingCustomerNotFoundError';
  }
}

export class BillingAlreadySubscribedError extends Error {
  readonly code = 'BILLING_ALREADY_SUBSCRIBED';

  constructor() {
    super('Restaurant already has an active subscription');
    this.name = 'BillingAlreadySubscribedError';
  }
}

export class BillingInvalidSiteCountError extends Error {
  readonly code = 'INVALID_SITE_COUNT';

  constructor() {
    super('Multi-restaurant requires between 1 and 100 establishments');
    this.name = 'BillingInvalidSiteCountError';
  }
}

let stripeClient: Stripe | null = null;

function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env.STRIPE_SECRET_KEY?.trim();
    if (!key) throw new BillingNotConfiguredError();
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

function isPublicBillingPlan(value: string): value is PublicBillingPlan {
  return (PUBLIC_BILLING_PLANS as readonly string[]).includes(value);
}

function isBillingInterval(value: string): value is BillingInterval {
  return (BILLING_INTERVALS as readonly string[]).includes(value);
}

export function resolvePriceId(plan: PublicBillingPlan, billing: BillingInterval): string | null {
  const envName = PRICE_ENV_BY_PLAN[plan][billing];
  const value = process.env[envName]?.trim();
  return value?.startsWith('price_') ? value : null;
}

export function resolveMultiSiteAddonPriceId(billing: BillingInterval): string | null {
  const envName = MULTI_SITE_ADDON_PRICE_ENV_BY_INTERVAL[billing];
  const value = process.env[envName]?.trim();
  return value?.startsWith('price_') ? value : null;
}

function normalizeSiteCount(plan: PublicBillingPlan, siteCount?: number): number {
  if (plan !== 'multi-site') return 1;
  const normalized = siteCount ?? 2;
  if (
    !Number.isInteger(normalized) ||
    normalized < MIN_MULTI_SITE_COUNT ||
    normalized > MAX_MULTI_SITE_COUNT
  ) {
    throw new BillingInvalidSiteCountError();
  }
  return normalized;
}

export function getPublicPlanFromPriceId(priceId: string): PublicBillingPlan | null {
  for (const plan of PUBLIC_BILLING_PLANS) {
    for (const interval of BILLING_INTERVALS) {
      if (resolvePriceId(plan, interval) === priceId) return plan;
    }
  }
  return null;
}

function getBillingIntervalFromPriceId(priceId: string): BillingInterval | null {
  for (const plan of PUBLIC_BILLING_PLANS) {
    for (const interval of BILLING_INTERVALS) {
      if (resolvePriceId(plan, interval) === priceId) return interval;
    }
  }
  return null;
}

/** Converts Stripe's recurring cadence to the public billing vocabulary. */
export function billingIntervalFromStripeRecurringInterval(
  interval: string | null | undefined,
): BillingInterval | null {
  if (interval === 'month') return 'monthly';
  if (interval === 'year') return 'annual';
  return null;
}

function billingIntervalFromStripePrice(
  price: { recurring?: { interval?: string | null } | null } | null | undefined,
): BillingInterval | null {
  return billingIntervalFromStripeRecurringInterval(price?.recurring?.interval);
}

function storedBillingInterval(value: string | null | undefined): BillingInterval | null {
  const normalized = value?.trim();
  return normalized && isBillingInterval(normalized) ? normalized : null;
}

/**
 * The active price map only identifies prices offered to new customers. A
 * subscriber can legitimately keep a retired price forever, so the durable
 * cadence captured from Stripe takes over when the price is no longer current.
 */
export function resolveBillingIntervalForStatus(
  priceId: string | null | undefined,
  persistedInterval: string | null | undefined,
): BillingInterval | null {
  return (
    (priceId ? getBillingIntervalFromPriceId(priceId) : null) ??
    storedBillingInterval(persistedInterval)
  );
}

function getPublicPlanFromDatabasePlan(plan: Plan | null | undefined): PublicBillingPlan | null {
  if (plan === 'PRO') return 'pro';
  if (plan === 'PREMIUM') return 'multi-site';
  if (plan === 'STARTER') return 'essential';
  return null;
}

export interface BillingStatus {
  /** Public offer name; Stripe identifiers are intentionally never returned. */
  plan: PublicBillingPlan | null;
  subscriptionStatus: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  entitledSiteCount: number;
  accountScoped: boolean;
  /** True once a subscription existed and ended: the voice agent no longer answers. */
  suspended: boolean;
  /** Present while the subscription is in its free trial. */
  trial?: BillingTrial;
}

export interface BillingTrial {
  startedAt: string;
  endsAt: string;
  totalDays: number;
  /** Whole days left, rounded up; 0 on the last day. */
  daysLeft: number;
  /** What Suppernote did during the trial; only when requested (dashboard), never on the call path. */
  recap?: ActivityRecap;
}

type BillingStatusProjection = {
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  subscriptionPriceId?: string | null;
  subscriptionBillingInterval?: string | null;
  subscriptionCurrentPeriodEnd?: Date | null;
  subscriptionCancelAtPeriodEnd?: boolean | null;
  entitledSiteCount?: number | null;
};

/**
 * Returns the billing projection visible to an authenticated restaurant.
 * Account-scoped billing is preferred for multi-site accounts; legacy
 * single-site rows remain supported during the additive migration.
 */
export async function getBillingStatus(input: {
  restaurantId: string;
  accountId?: string;
  /** Adds the trial activity recap (three counts): for the dashboard only. */
  includeTrialRecap?: boolean;
}): Promise<BillingStatus> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: { plan: true, accountId: true },
  });
  if (!restaurant) throw new BillingRestaurantNotFoundError();

  const accountId = restaurant.accountId ?? input.accountId;
  const accountBilling = accountId
    ? ((await db.restaurantAccountBilling.findUnique({
        where: { accountId },
      })) as BillingStatusProjection | null)
    : null;

  let billingAnchorId = input.restaurantId;
  if (accountId) {
    const primary = await db.restaurant.findFirst({
      where: { accountId, isPrimary: true, siteStatus: { not: 'ARCHIVED' } },
      select: { id: true },
    });
    billingAnchorId = primary?.id ?? input.restaurantId;
  }

  const siteBilling = (await db.restaurantBilling.findUnique({
    where: { restaurantId: billingAnchorId },
  })) as BillingStatusProjection | null;
  const projection = accountBilling ?? siteBilling;
  const priceId = projection?.subscriptionPriceId ?? null;
  const plan =
    (priceId ? getPublicPlanFromPriceId(priceId) : null) ??
    getPublicPlanFromDatabasePlan(restaurant.plan);
  const periodEnd = projection?.subscriptionCurrentPeriodEnd;

  return {
    plan,
    subscriptionStatus: projection?.subscriptionStatus ?? null,
    billingInterval: resolveBillingIntervalForStatus(
      priceId,
      projection?.subscriptionBillingInterval,
    ),
    currentPeriodEnd: periodEnd instanceof Date ? periodEnd.toISOString() : null,
    cancelAtPeriodEnd: projection?.subscriptionCancelAtPeriodEnd === true,
    entitledSiteCount:
      typeof projection?.entitledSiteCount === 'number' && projection.entitledSiteCount > 0
        ? projection.entitledSiteCount
        : 1,
    accountScoped: Boolean(accountId && accountBilling),
    suspended: isSuspendedProjection(projection),
    ...(projection?.subscriptionStatus === 'trialing' && periodEnd instanceof Date
      ? {
          trial: await buildTrial(billingAnchorId, periodEnd, input.includeTrialRecap === true),
        }
      : {}),
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

async function buildTrial(
  restaurantId: string,
  endsAt: Date,
  includeRecap: boolean,
): Promise<BillingTrial> {
  const startedAt = new Date(endsAt.getTime() - TRIAL_DAYS * DAY_MS);
  return {
    startedAt: startedAt.toISOString(),
    endsAt: endsAt.toISOString(),
    totalDays: TRIAL_DAYS,
    daysLeft: Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / DAY_MS)),
    ...(includeRecap ? { recap: await loadActivityRecap(restaurantId, startedAt) } : {}),
  };
}

function isSuspendedProjection(projection: BillingStatusProjection | null): boolean {
  // Only a subscription that existed and ended suspends the service: accounts that never
  // subscribed (pilots, demo restaurant, legacy) keep their current behaviour.
  return Boolean(
    projection?.stripeSubscriptionId &&
    SUSPENDED_SUBSCRIPTION_STATUSES.includes(projection.subscriptionStatus ?? ''),
  );
}

/**
 * Whether the restaurant's service is suspended for billing reasons. Fails open: a billing
 * lookup error must never drop a paying restaurant's calls.
 */
export async function isBillingSuspended(restaurantId: string): Promise<boolean> {
  try {
    return (await getBillingStatus({ restaurantId })).suspended;
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), restaurantId },
      '[billing] Suspension check failed, service kept running',
    );
    return false;
  }
}

function stripeObjectId(value: string | { id: string } | null | undefined): string | null {
  return typeof value === 'string' ? value : (value?.id ?? null);
}

function normalizeEmail(value: string | null | undefined): string | undefined {
  const email = value?.trim();
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : undefined;
}

function normalizeIdempotencyKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized.slice(0, 200) : undefined;
}

/**
 * Stripe accepts an idempotency key for Checkout requests. We hash the
 * restaurant and commercial choice so a retry cannot collide with another
 * tenant or another plan. Without a client key, the 24-hour bucket still
 * absorbs double-clicks and network retries during the purchase window.
 */
export type CheckoutReturnTo = 'settings' | 'onboarding' | 'billing';

export function buildCheckoutIdempotencyKey(input: {
  restaurantId: string;
  /** Account scope keeps two sites from creating two subscriptions. */
  scopeId?: string;
  plan: PublicBillingPlan;
  billing: BillingInterval;
  siteCount: number;
  /** Absent ou `settings` : la clé reste identique à celle d'avant l'option de retour. */
  returnTo?: CheckoutReturnTo;
  idempotencyKey?: string;
  now?: Date;
}): string {
  const bucket = Math.floor((input.now?.getTime() ?? Date.now()) / CHECKOUT_IDEMPOTENCY_BUCKET_MS);
  const source = [
    PRICING_CATALOG_VERSION,
    input.scopeId ?? input.restaurantId,
    input.plan,
    input.billing,
    input.siteCount,
    // Une session déjà créée garde ses adresses de retour : celle de l'inscription ne doit pas
    // réutiliser une session qui ramènerait vers les Réglages (ni l'inverse).
    ...(input.returnTo && input.returnTo !== 'settings' ? [`return:${input.returnTo}`] : []),
    normalizeIdempotencyKey(input.idempotencyKey) ?? `auto:${bucket}`,
  ].join('|');
  return `sokar-checkout-${createHash('sha256').update(source).digest('hex').slice(0, 48)}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function dashboardUrl(path: string): string {
  const base = (process.env.DASHBOARD_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return `${base}${path}`;
}

/** Returns the account's Stripe customer, creating it (with the VAT mention) on first use. */
async function ensureStripeCustomer(input: {
  restaurantId: string;
  accountId?: string | null;
  billingAnchor: { id: string; name: string; managerEmail: string | null };
  existingCustomerId: string | null;
}): Promise<{ customerId: string; emailChanged: boolean }> {
  const ownerEmail = await resolveAccountOwnerEmail(input.accountId);
  const email = normalizeEmail(ownerEmail) ?? normalizeEmail(input.billingAnchor.managerEmail);
  if (input.existingCustomerId) {
    if (!email) return { customerId: input.existingCustomerId, emailChanged: false };
    const stripe = getStripe();
    const customer = await stripe.customers.retrieve(input.existingCustomerId);
    const emailChanged = !('deleted' in customer) && customer.email !== email;
    if (emailChanged) await stripe.customers.update(input.existingCustomerId, { email });
    return { customerId: input.existingCustomerId, emailChanged };
  }
  const customer = await getStripe().customers.create(
    {
      name: input.billingAnchor.name,
      email,
      // VAT franchise: every invoice of this customer carries the legal mention.
      invoice_settings: { footer: VAT_MENTION },
      metadata: {
        restaurantId: input.restaurantId,
        ...(input.accountId ? { accountId: input.accountId } : {}),
      },
    },
    {
      idempotencyKey: `sokar-customer-${createHash('sha256')
        .update(input.accountId ?? input.billingAnchor.id)
        .digest('hex')
        .slice(0, 48)}`,
    },
  );
  await db.restaurantBilling.upsert({
    where: { restaurantId: input.billingAnchor.id },
    create: { restaurantId: input.billingAnchor.id, stripeCustomerId: customer.id },
    update: { stripeCustomerId: customer.id },
  });
  return { customerId: customer.id, emailChanged: false };
}

export class BillingTrialAlreadyUsedError extends Error {
  constructor() {
    super('Free trial already used for this account');
    this.name = 'BillingTrialAlreadyUsedError';
  }
}

async function stripeSubscriptions(customer: string): Promise<Stripe.Subscription[]> {
  const subscriptions: Stripe.Subscription[] = [];
  let startingAfter: string | undefined;
  do {
    const page = await getStripe().subscriptions.list({
      customer,
      status: 'all',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    subscriptions.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) throw new BillingCheckoutError();
  } while (startingAfter);
  return subscriptions;
}

async function closeOpenBillingSessions(
  customer: string,
  reusableId?: string,
  canRecover?: (session: Stripe.Checkout.Session) => boolean,
): Promise<Stripe.Checkout.Session | undefined> {
  let reusable: Stripe.Checkout.Session | undefined;
  let startingAfter: string | undefined;
  do {
    const page = await getStripe().checkout.sessions.list({
      customer,
      status: 'open',
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
    if (page.has_more && !startingAfter) throw new BillingCheckoutError();
    for (const session of page.data) {
      if (session.mode !== 'subscription') continue;
      if (!reusable && session.url && (session.id === reusableId || canRecover?.(session)))
        reusable = session;
      else await getStripe().checkout.sessions.expire(session.id);
    }
  } while (startingAfter);
  return reusable;
}

function activeStripeSubscription(
  subscriptions: Stripe.Subscription[],
): Stripe.Subscription | undefined {
  return subscriptions.find(
    (subscription) => !['canceled', 'incomplete_expired'].includes(subscription.status),
  );
}

/**
 * Starts the free trial on the chosen plan without Stripe Checkout (onboarding). No card is asked,
 * so Checkout would only be a detour: the restaurant adds a card, or changes plan, from the
 * customer portal before the end. Same Stripe settings as a Checkout trial, so the reminder,
 * suspension and portal flows apply unchanged.
 */
type StartTrialInput = {
  restaurantId: string;
  accountId?: string;
  plan?: PublicBillingPlan;
  billing?: BillingInterval;
  siteCount?: number;
};

export async function startTrial(
  input: StartTrialInput,
): Promise<{ status: 'trialing'; trialEndsAt: string }> {
  return withBillingLock(input.restaurantId, () => startTrialLocked(input));
}

async function startTrialLocked(
  input: StartTrialInput,
): Promise<{ status: 'trialing'; trialEndsAt: string }> {
  const plan = input.plan ?? 'essential';
  const interval = input.billing ?? 'monthly';
  const siteCount = normalizeSiteCount(plan, input.siteCount);
  const priceId = resolvePriceId(plan, interval);
  const addonPriceId =
    plan === 'multi-site' && siteCount > 1 ? resolveMultiSiteAddonPriceId(interval) : null;
  if (!priceId || (plan === 'multi-site' && siteCount > 1 && !addonPriceId)) {
    throw new BillingNotConfiguredError();
  }

  const restaurant = await db.restaurant.findUnique({ where: { id: input.restaurantId } });
  if (!restaurant) throw new BillingRestaurantNotFoundError();
  const accountId = restaurant.accountId ?? input.accountId;
  const accountBilling = accountId
    ? await db.restaurantAccountBilling.findUnique({ where: { accountId } })
    : null;
  const billingAnchor = accountId
    ? ((await db.restaurant.findFirst({
        where: { accountId, isPrimary: true, siteStatus: { not: 'ARCHIVED' } },
      })) ?? restaurant)
    : restaurant;
  const billing = await db.restaurantBilling.findUnique({
    where: { restaurantId: billingAnchor.id },
  });
  const current = accountBilling?.stripeSubscriptionId ? accountBilling : billing;
  const pendingTrialKey = current?.stripeCustomerId
    ? `sokar-trial-${current.stripeCustomerId}-${plan}-${interval}-${siteCount}`
    : null;
  if (
    current?.stripeSubscriptionId &&
    current.subscriptionStatus === 'trialing' &&
    pendingTrialKey &&
    billing?.checkoutIdempotencyKey === pendingTrialKey
  ) {
    const live = await retrieveLiveSubscription(current.stripeSubscriptionId);
    if (live.status !== 'trialing') throw new BillingAlreadySubscribedError();
    await applySubscriptionSnapshot(billingAnchor.id, live, false, {
      lastStripeEventCreated: current.lastStripeEventCreated ?? 0,
      lastStripeEventId: current.lastStripeEventId ?? '',
    });
    return {
      status: 'trialing',
      trialEndsAt: new Date(
        (live.trial_end ?? live.created + TRIAL_DAYS * 86400) * 1000,
      ).toISOString(),
    };
  }
  if (
    current?.stripeSubscriptionId &&
    ['active', 'trialing', 'past_due'].includes(current.subscriptionStatus ?? '')
  ) {
    throw new BillingAlreadySubscribedError();
  }
  // One free trial per account, as for Checkout.
  if (accountBilling?.stripeSubscriptionId || billing?.stripeSubscriptionId) {
    throw new BillingTrialAlreadyUsedError();
  }

  const { customerId } = await ensureStripeCustomer({
    restaurantId: restaurant.id,
    accountId,
    billingAnchor,
    existingCustomerId: accountBilling?.stripeCustomerId ?? billing?.stripeCustomerId ?? null,
  });
  const trialKey = `sokar-trial-${customerId}-${plan}-${interval}-${siteCount}`;
  if (
    billing?.checkoutIdempotencyKey &&
    !billing.checkoutSessionId &&
    billing.checkoutIdempotencyKey !== trialKey
  ) {
    throw new BillingCheckoutError();
  }
  const existingSubscriptions = await stripeSubscriptions(customerId);
  const existingSubscription = activeStripeSubscription(existingSubscriptions);
  if (existingSubscription) {
    if (
      billing?.checkoutIdempotencyKey === trialKey &&
      existingSubscription.status === 'trialing'
    ) {
      await applySubscriptionSnapshot(
        billingAnchor.id,
        existingSubscription as unknown as SubscriptionObject,
        false,
        {
          lastStripeEventCreated: existingSubscription.created - 1,
          lastStripeEventId: '',
        },
      );
      return {
        status: 'trialing',
        trialEndsAt: new Date(
          (existingSubscription.trial_end ?? existingSubscription.created + TRIAL_DAYS * 86400) *
            1000,
        ).toISOString(),
      };
    }
    throw new BillingAlreadySubscribedError();
  }
  if (existingSubscriptions.length) throw new BillingTrialAlreadyUsedError();
  if (
    billing?.checkoutIdempotencyKey === trialKey &&
    (!billing.checkoutCreatedAt ||
      Date.now() - billing.checkoutCreatedAt.getTime() >= 23 * 60 * 60 * 1000)
  ) {
    throw new BillingCheckoutError();
  }
  await closeOpenBillingSessions(customerId);
  if (activeStripeSubscription(await stripeSubscriptions(customerId)))
    throw new BillingAlreadySubscribedError();
  await db.restaurantBilling.update({
    where: { restaurantId: billingAnchor.id },
    data: {
      checkoutIdempotencyKey: trialKey,
      checkoutSessionId: null,
      checkoutSessionUrl: null,
      checkoutPlan: plan,
      checkoutBillingInterval: interval,
      checkoutSiteCount: siteCount,
      checkoutCreatedAt:
        billing?.checkoutIdempotencyKey === trialKey ? billing.checkoutCreatedAt : new Date(),
    },
  });
  const metadata = {
    restaurantId: restaurant.id,
    ...(accountId ? { accountId } : {}),
    plan,
    billing: interval,
    siteCount: String(siteCount),
    trial: 'true',
    source: 'onboarding',
  };
  let subscription: Stripe.Subscription;
  try {
    subscription = await getStripe().subscriptions.create(
      {
        customer: customerId,
        items: [
          { price: priceId },
          ...(addonPriceId ? [{ price: addonPriceId, quantity: siteCount - 1 }] : []),
        ],
        trial_period_days: TRIAL_DAYS,
        // No card at the end of the trial: Stripe cancels, and the deletion webhook suspends.
        trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        payment_settings: { save_default_payment_method: 'on_subscription' },
        metadata,
      },
      { idempotencyKey: trialKey },
    );
  } catch (error) {
    logger.error(
      { err: error instanceof Error ? error.message : String(error), accountId: accountId ?? null },
      '[billing] Stripe trial subscription creation failed',
    );
    throw new BillingCheckoutError();
  }

  // Project now so the dashboard shows the trial at once; the webhooks confirm it afterwards.
  const trialEnd = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
  const projection = {
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: 'trialing',
    subscriptionPriceId: priceId,
    subscriptionBillingInterval: interval,
    subscriptionCurrentPeriodEnd: trialEnd,
    subscriptionCancelAtPeriodEnd: false,
  };
  // Scoped to the account as well: the anchor always belongs to the caller's account.
  await db.restaurant.updateMany({
    where: { id: billingAnchor.id, ...(accountId ? { accountId } : {}) },
    data: { plan: PLAN_TO_DATABASE[plan] },
  });
  await projectAccountBilling(billingAnchor.id, {
    ...projection,
    plan: PLAN_TO_DATABASE[plan],
    entitledSiteCount: siteCount,
    // Older than any webhook about this subscription: the webhooks still apply after this.
    lastStripeEventCreated: subscription.created - 1,
    lastStripeEventId: '',
  });
  await db.restaurantBilling.upsert({
    where: { restaurantId: billingAnchor.id },
    create: { restaurantId: billingAnchor.id, ...projection },
    update: { ...projection, ...clearCheckoutAttempt() },
  });
  return {
    status: 'trialing',
    trialEndsAt: (trialEnd ?? new Date(Date.now() + TRIAL_DAYS * 86_400_000)).toISOString(),
  };
}

type CheckoutInput = {
  restaurantId: string;
  accountId?: string;
  plan: PublicBillingPlan;
  billing: BillingInterval;
  siteCount?: number;
  returnTo?: CheckoutReturnTo;
  idempotencyKey?: string;
};

export async function createCheckoutSession(
  input: CheckoutInput,
): Promise<{ id: string; url: string }> {
  return withBillingLock(input.restaurantId, () => createCheckoutSessionLocked(input));
}

async function createCheckoutSessionLocked(
  input: CheckoutInput,
): Promise<{ id: string; url: string }> {
  const priceId = resolvePriceId(input.plan, input.billing);
  const siteCount = normalizeSiteCount(input.plan, input.siteCount);
  const addonPriceId =
    input.plan === 'multi-site' && siteCount > 1
      ? resolveMultiSiteAddonPriceId(input.billing)
      : null;
  if (!priceId || (input.plan === 'multi-site' && siteCount > 1 && !addonPriceId)) {
    throw new BillingNotConfiguredError();
  }

  const restaurant = await db.restaurant.findUnique({ where: { id: input.restaurantId } });
  if (!restaurant) throw new BillingRestaurantNotFoundError();

  // The account ID comes from the authenticated site resolver. Once the
  // additive backfill has run, the database relation is the final authority;
  // a legacy restaurant can still use the historical single-site path.
  const accountId = restaurant.accountId ?? input.accountId;
  const accountBilling = accountId
    ? await db.restaurantAccountBilling.findUnique({ where: { accountId } })
    : null;
  const billingAnchor = accountId
    ? ((await db.restaurant.findFirst({
        where: { accountId, isPrimary: true, siteStatus: { not: 'ARCHIVED' } },
      })) ?? restaurant)
    : restaurant;
  const requestKey = buildCheckoutIdempotencyKey({
    ...input,
    restaurantId: billingAnchor.id,
    scopeId: accountId,
    siteCount,
  });

  const billing = await db.restaurantBilling.findUnique({
    where: { restaurantId: billingAnchor.id },
  });
  if (
    (accountBilling?.stripeSubscriptionId &&
      ['active', 'trialing', 'past_due'].includes(accountBilling.subscriptionStatus ?? '')) ||
    (billing?.stripeSubscriptionId &&
      ['active', 'trialing', 'past_due'].includes(billing.subscriptionStatus ?? ''))
  ) {
    throw new BillingAlreadySubscribedError();
  }
  const stripe = getStripe();
  const { customerId, emailChanged } = await ensureStripeCustomer({
    restaurantId: restaurant.id,
    accountId,
    billingAnchor,
    existingCustomerId: accountBilling?.stripeCustomerId ?? billing?.stripeCustomerId ?? null,
  });

  const sameAttempt =
    billing?.checkoutIdempotencyKey === requestKey ||
    Boolean(billing?.checkoutIdempotencyKey?.startsWith(`${requestKey}.`));
  let idempotencyKey = sameAttempt ? billing!.checkoutIdempotencyKey! : requestKey;
  if (billing?.checkoutIdempotencyKey && !billing.checkoutSessionId && !sameAttempt) {
    throw new BillingCheckoutError();
  }
  if (activeStripeSubscription(await stripeSubscriptions(customerId)))
    throw new BillingAlreadySubscribedError();
  const reusable = await closeOpenBillingSessions(
    customerId,
    !emailChanged && sameAttempt ? (billing?.checkoutSessionId ?? undefined) : undefined,
    !emailChanged && sameAttempt && !billing?.checkoutSessionId
      ? (session) =>
          session.metadata?.plan === input.plan &&
          session.metadata?.billing === input.billing &&
          session.metadata?.siteCount === String(siteCount)
      : undefined,
  );
  if (activeStripeSubscription(await stripeSubscriptions(customerId)))
    throw new BillingAlreadySubscribedError();
  if (reusable?.url) {
    await db.restaurantBilling.update({
      where: { restaurantId: billingAnchor.id },
      data: { checkoutSessionId: reusable.id, checkoutSessionUrl: reusable.url },
    });
    return { id: reusable.id, url: reusable.url };
  }
  if (sameAttempt && billing?.checkoutSessionId) {
    idempotencyKey = `${requestKey}.${createHash('sha256').update(billing.checkoutSessionId).digest('hex').slice(0, 16)}`;
  }
  if (
    sameAttempt &&
    !billing?.checkoutSessionId &&
    (!billing?.checkoutCreatedAt ||
      Date.now() - billing.checkoutCreatedAt.getTime() >= 23 * 60 * 60 * 1000)
  ) {
    throw new BillingCheckoutError();
  }
  await db.restaurantBilling.update({
    where: { restaurantId: billingAnchor.id },
    data: {
      checkoutIdempotencyKey: idempotencyKey,
      checkoutSessionId: null,
      checkoutSessionUrl: null,
      checkoutPlan: input.plan,
      checkoutBillingInterval: input.billing,
      checkoutSiteCount: siteCount,
      checkoutCreatedAt:
        sameAttempt && !billing?.checkoutSessionId
          ? (billing?.checkoutCreatedAt ?? new Date())
          : new Date(),
    },
  });

  // One free trial per account: an account that already had a subscription pays from day one.
  const trialEligible = !accountBilling?.stripeSubscriptionId && !billing?.stripeSubscriptionId;

  try {
    const lineItems = [
      { price: priceId, quantity: 1 },
      ...(addonPriceId ? [{ price: addonPriceId, quantity: siteCount - 1 }] : []),
    ];
    const session = await stripe.checkout.sessions.create(
      {
        mode: 'subscription',
        customer: customerId,
        client_reference_id: restaurant.id,
        line_items: lineItems,
        // The trial starts without a card; Stripe still asks for one when a payment is due.
        ...(trialEligible ? { payment_method_collection: 'if_required' as const } : {}),
        metadata: {
          restaurantId: restaurant.id,
          ...(accountId ? { accountId } : {}),
          plan: input.plan,
          billing: input.billing,
          siteCount: String(siteCount),
          ...(trialEligible ? { trial: 'true' } : {}),
        },
        subscription_data: {
          ...(trialEligible
            ? {
                trial_period_days: TRIAL_DAYS,
                // No card at the end of the trial: Stripe cancels the subscription, and the
                // `customer.subscription.deleted` webhook suspends the service.
                trial_settings: { end_behavior: { missing_payment_method: 'cancel' as const } },
              }
            : {}),
          metadata: {
            restaurantId: restaurant.id,
            ...(accountId ? { accountId } : {}),
            plan: input.plan,
            billing: input.billing,
            siteCount: String(siteCount),
          },
        },
        success_url: dashboardUrl(
          input.returnTo === 'billing'
            ? '/dashboard/billing?billing=success&session_id={CHECKOUT_SESSION_ID}'
            : input.returnTo === 'onboarding'
              ? '/onboarding?step=canaux&billing=success&session_id={CHECKOUT_SESSION_ID}'
              : '/dashboard/settings?billing=success&session_id={CHECKOUT_SESSION_ID}',
        ),
        cancel_url: dashboardUrl(
          input.returnTo === 'billing'
            ? '/dashboard/billing?billing=canceled'
            : input.returnTo === 'onboarding'
              ? '/onboarding?step=formule&billing=cancelled'
              : '/pricing?billing=cancelled',
        ),
      },
      { idempotencyKey },
    );

    if (!session.url) throw new BillingCheckoutError();
    await db.restaurantBilling.update({
      where: { restaurantId: billingAnchor.id },
      data: {
        checkoutIdempotencyKey: idempotencyKey,
        checkoutSessionId: session.id,
        checkoutSessionUrl: session.url,
        checkoutPlan: input.plan,
        checkoutBillingInterval: input.billing,
        checkoutSiteCount: siteCount,
        checkoutCreatedAt: new Date(),
      },
    });
    return { id: session.id, url: session.url };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await db.restaurantBilling.findUnique({
        where: { restaurantId: billingAnchor.id },
      });
      if (
        existing?.checkoutIdempotencyKey === idempotencyKey &&
        existing.checkoutSessionId &&
        existing.checkoutSessionUrl
      ) {
        return { id: existing.checkoutSessionId, url: existing.checkoutSessionUrl };
      }
    }
    if (error instanceof BillingCheckoutError) throw error;
    logger.error(
      { err: error instanceof Error ? error.message : String(error), restaurantId: restaurant.id },
      '[billing] Stripe Checkout session creation failed',
    );
    throw new BillingCheckoutError();
  }
}

/** Resolve only server-owned IDs; never accept customer/subscription IDs from the browser. */
async function billingContext(input: { restaurantId: string; accountId?: string }) {
  const restaurant = await db.restaurant.findUnique({ where: { id: input.restaurantId } });
  if (!restaurant) throw new BillingRestaurantNotFoundError();
  const accountId = restaurant.accountId ?? input.accountId;
  const accountBilling = accountId
    ? await db.restaurantAccountBilling.findUnique({ where: { accountId } })
    : null;
  const anchor = accountId
    ? ((await db.restaurant.findFirst({
        where: { accountId, isPrimary: true, siteStatus: { not: 'ARCHIVED' } },
      })) ?? restaurant)
    : restaurant;
  const siteBilling = await db.restaurantBilling.findUnique({ where: { restaurantId: anchor.id } });
  // An account billing row is authoritative, even before a Stripe customer is attached.
  const billing = accountBilling ?? siteBilling;
  return {
    customerId: billing?.stripeCustomerId ?? null,
    subscriptionId: billing?.stripeSubscriptionId ?? null,
  };
}

export interface BillingDetails {
  hasCustomer: boolean;
  hasPaymentMethod: boolean;
  subscription: {
    status: string;
    canUpdatePlan: boolean;
    plan: PublicBillingPlan | null;
    recurringAmount: number | null;
    currency: string;
    interval: string | null;
    intervalCount: number | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  invoices: {
    number: string | null;
    createdAt: string;
    status: string | null;
    total: number;
    currency: string;
    pdfUrl: string | null;
    hostedUrl: string | null;
  }[];
  hasMoreInvoices: boolean;
}

/** A bounded, read-only Stripe view. Full card/customer objects never leave the API. */
export async function getBillingDetails(input: {
  restaurantId: string;
  accountId?: string;
}): Promise<BillingDetails> {
  const { customerId, subscriptionId } = await billingContext(input);
  const empty: BillingDetails = {
    hasCustomer: false,
    hasPaymentMethod: false,
    subscription: null,
    paymentMethod: null,
    invoices: [],
    hasMoreInvoices: false,
  };
  if (!customerId) return empty;
  const stripe = getStripe();
  const [customer, subscription, invoices] = await Promise.all([
    stripe.customers.retrieve(customerId, { expand: ['invoice_settings.default_payment_method'] }),
    subscriptionId
      ? stripe.subscriptions.retrieve(subscriptionId, { expand: ['default_payment_method'] })
      : null,
    stripe.invoices.list({ customer: customerId, limit: 20 }),
  ]);
  if (customer.deleted) throw new BillingCustomerNotFoundError();
  // Do not display invoices or payment details if the stored subscription belongs elsewhere.
  if (subscription && stripeObjectId(subscription.customer) !== customerId)
    throw new BillingCustomerNotFoundError();
  const payment =
    subscription?.default_payment_method ?? customer.invoice_settings.default_payment_method;
  const card = payment && typeof payment !== 'string' ? payment.card : null;
  const items = subscription?.items.data ?? [];
  const first = items[0]?.price;
  const homogeneous =
    items.length > 0 &&
    items.every(
      ({ price }) =>
        price.unit_amount !== null &&
        price.currency === first?.currency &&
        price.recurring?.interval === first?.recurring?.interval &&
        price.recurring?.interval_count === first?.recurring?.interval_count,
    );
  return {
    hasCustomer: true,
    hasPaymentMethod: Boolean(payment || subscription?.default_source || customer.default_source),
    subscription: subscription
      ? {
          status: subscription.status,
          canUpdatePlan:
            subscription.items.data.length === 1 &&
            !subscription.schedule &&
            subscription.collection_method !== 'send_invoice',
          plan: first ? getPublicPlanFromPriceId(first.id) : null,
          recurringAmount: homogeneous
            ? items.reduce(
                (total, item) => total + item.price.unit_amount! * (item.quantity ?? 1),
                0,
              )
            : null,
          currency: subscription.currency,
          interval: first?.recurring?.interval ?? null,
          intervalCount: first?.recurring?.interval_count ?? null,
          cancelAtPeriodEnd: subscription.cancel_at_period_end,
          currentPeriodEnd: subscriptionPeriodEnd(subscription)?.toISOString() ?? null,
        }
      : null,
    paymentMethod: card
      ? { brand: card.brand, last4: card.last4, expMonth: card.exp_month, expYear: card.exp_year }
      : null,
    invoices: invoices.data
      .filter((invoice) => invoice.status !== 'draft')
      .map((invoice) => ({
        number: invoice.number,
        createdAt: new Date(invoice.created * 1000).toISOString(),
        status: invoice.status,
        total: invoice.total,
        currency: invoice.currency,
        pdfUrl: invoice.invoice_pdf ?? null,
        hostedUrl: invoice.hosted_invoice_url ?? null,
      })),
    hasMoreInvoices: invoices.has_more,
  };
}

/**
 * Opens Stripe's hosted customer portal. Billing remains account-scoped for
 * multi-site customers, while legacy restaurants keep their existing billing
 * row until the backfill is complete.
 */
export async function createBillingPortalSession(input: {
  restaurantId: string;
  accountId?: string;
  intent?: 'manage' | 'payment_method' | 'subscription_update' | 'subscription_cancel';
  returnTo?: 'settings' | 'billing';
}): Promise<{ url: string }> {
  const { customerId, subscriptionId } = await billingContext(input);
  if (!customerId) throw new BillingCustomerNotFoundError();
  const returnUrl = dashboardUrl(
    input.returnTo === 'billing'
      ? '/dashboard/billing?billing=portal-return'
      : '/dashboard/settings?billing=portal-return',
  );
  const type = input.intent === 'payment_method' ? 'payment_method_update' : input.intent;
  let flow: Stripe.BillingPortal.SessionCreateParams.FlowData | undefined;
  if (type === 'payment_method_update') {
    const subscription = subscriptionId
      ? await getStripe().subscriptions.retrieve(subscriptionId)
      : null;
    // This deep link changes only the customer's default. When the subscription overrides
    // that default, use the full portal so its payment settings remain visible.
    if (!subscription?.default_payment_method && !subscription?.default_source) {
      flow = { type, after_completion: { type: 'redirect', redirect: { return_url: returnUrl } } };
    }
  } else if (type === 'subscription_update' || type === 'subscription_cancel') {
    if (!subscriptionId) throw new BillingCustomerNotFoundError();
    flow = {
      type,
      [type]: { subscription: subscriptionId },
      after_completion: { type: 'redirect', redirect: { return_url: returnUrl } },
    };
  }
  try {
    const session = await getStripe().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      locale: 'fr',
      ...(flow ? { flow_data: flow } : {}),
    });
    if (!session.url) throw new BillingCheckoutError();
    return { url: session.url };
  } catch (error) {
    if (error instanceof BillingCheckoutError) throw error;
    // Stripe errors may contain customer data or session URLs; keep logs bounded.
    logger.error({ restaurantId: input.restaurantId }, '[billing] Stripe portal unavailable');
    throw new BillingCheckoutError();
  }
}

type SubscriptionObject = Stripe.Subscription & {
  metadata: Record<string, string>;
};

type SupportedBillingEvent =
  | 'checkout.session.completed'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'customer.subscription.trial_will_end'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'invoice.payment_succeeded';

type StripeEventClaim = 'claimed' | 'processed' | 'in-flight';

export class BillingWebhookInProgressError extends Error {
  readonly code = 'BILLING_WEBHOOK_IN_PROGRESS';

  constructor() {
    super('Stripe event is already being processed');
    this.name = 'BillingWebhookInProgressError';
  }
}

function eventCreated(event: Stripe.Event): number {
  return Number.isInteger(event.created) ? event.created : 0;
}

function eventId(event: Stripe.Event): string {
  return event.id || `synthetic:${event.type}:${eventCreated(event)}`;
}

function eventCheckpoint(event: Stripe.Event) {
  return {
    lastStripeEventCreated: eventCreated(event),
    lastStripeEventId: eventId(event),
  };
}

function clearCheckoutAttempt() {
  return {
    checkoutIdempotencyKey: null,
    checkoutSessionId: null,
    checkoutSessionUrl: null,
    checkoutPlan: null,
    checkoutBillingInterval: null,
    checkoutSiteCount: null,
    checkoutCreatedAt: null,
  };
}

type StripeEventOrder = 'stale' | 'tie' | 'newer';

/**
 * Orders an event against the last applied checkpoint by its `created` second only. Stripe
 * neither guarantees delivery order nor makes event IDs chronological, and several snapshots of
 * one subscription can share the same second (recette du 21/10/2026 : activation, factures et
 * rappel d'essai à la même seconde). A tie is therefore never resolved by comparing IDs: the
 * caller re-reads the subscription from Stripe, which is the current truth.
 */
async function compareStripeEvent(
  restaurantId: string,
  event: Stripe.Event,
  tx: Prisma.TransactionClient = db,
): Promise<StripeEventOrder> {
  const current = await tx.restaurantBilling.findUnique({
    where: { restaurantId },
  });
  const restaurant = await tx.restaurant.findUnique({
    where: { id: restaurantId },
    select: { accountId: true },
  });
  const account = restaurant?.accountId
    ? await tx.restaurantAccountBilling.findUnique({ where: { accountId: restaurant.accountId } })
    : null;
  const checkpoints = [current?.lastStripeEventCreated, account?.lastStripeEventCreated].filter(
    (value): value is number => value !== null && value !== undefined,
  );
  const lastCreated = checkpoints.length ? Math.max(...checkpoints) : null;
  if (lastCreated === null || lastCreated === undefined) return 'newer';
  const incomingCreated = eventCreated(event);
  if (incomingCreated < lastCreated) return 'stale';
  return incomingCreated === lastCreated ? 'tie' : 'newer';
}

/** Current subscription state from Stripe; an error propagates so Stripe redelivers the event. */
async function retrieveLiveSubscription(subscriptionId: string): Promise<SubscriptionObject> {
  return (await getStripe().subscriptions.retrieve(
    subscriptionId,
  )) as unknown as SubscriptionObject;
}

/**
 * Claims a Stripe event before mutating billing state. A unique event ID
 * handles provider retries; a short processing lease lets a crashed attempt
 * be retried without permanently acknowledging the event.
 */
async function claimStripeEvent(event: Stripe.Event): Promise<StripeEventClaim> {
  const id = eventId(event);
  const now = new Date();
  const existing = await db.stripeWebhookEvent.findUnique({ where: { eventId: id } });

  if (existing?.status === 'processed') return 'processed';
  if (
    existing?.status === 'processing' &&
    existing.lastAttemptAt &&
    now.getTime() - existing.lastAttemptAt.getTime() < STRIPE_EVENT_PROCESSING_TIMEOUT_MS
  ) {
    return 'in-flight';
  }

  if (existing) {
    await db.stripeWebhookEvent.update({
      where: { eventId: id },
      data: {
        status: 'processing',
        attempts: { increment: 1 },
        lastAttemptAt: now,
        error: null,
      },
    });
    return 'claimed';
  }

  try {
    await db.stripeWebhookEvent.create({
      data: {
        eventId: id,
        eventType: event.type,
        eventCreated: eventCreated(event),
        status: 'processing',
        attempts: 1,
        lastAttemptAt: now,
      },
    });
    return 'claimed';
  } catch (error) {
    // Another worker won the unique insert. Re-read the ledger so a concurrent
    // delivery is retried instead of being acknowledged while the first worker
    // can still fail or crash.
    if (isUniqueViolation(error)) {
      const winner = await db.stripeWebhookEvent.findUnique({ where: { eventId: id } });
      if (winner?.status === 'processed') return 'processed';
      return 'in-flight';
    }
    throw error;
  }
}

async function markStripeEventProcessed(event: Stripe.Event): Promise<void> {
  await db.stripeWebhookEvent.update({
    where: { eventId: eventId(event) },
    data: { status: 'processed', processedAt: new Date(), error: null },
  });
}

async function markStripeEventFailed(event: Stripe.Event, error: unknown): Promise<void> {
  await db.stripeWebhookEvent.update({
    where: { eventId: eventId(event) },
    data: {
      status: 'failed',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    },
  });
}

function subscriptionUpdateData(subscription: SubscriptionObject, deleted: boolean) {
  const priceId = subscription.items.data[0]?.price?.id;
  const billingInterval = billingIntervalFromStripePrice(subscription.items.data[0]?.price);
  return {
    stripeCustomerId: stripeObjectId(subscription.customer),
    stripeSubscriptionId: subscription.id,
    subscriptionStatus: deleted ? 'canceled' : subscription.status,
    subscriptionPriceId: priceId ?? undefined,
    ...(billingInterval ? { subscriptionBillingInterval: billingInterval } : {}),
    subscriptionCurrentPeriodEnd: subscriptionPeriodEnd(subscription),
    subscriptionCancelAtPeriodEnd: deleted ? false : subscription.cancel_at_period_end,
  };
}

/**
 * Stripe API versions from 2025-03 moved `current_period_end` from the subscription to each
 * item. Reading only the old field wiped the stored date, so the dashboard lost the trial
 * countdown. During a trial the period ends with the trial.
 */
function subscriptionPeriodEnd(subscription: SubscriptionObject): Date | null {
  const legacy = (subscription as { current_period_end?: number | null }).current_period_end;
  const item = subscription.items.data[0] as { current_period_end?: number | null } | undefined;
  const seconds =
    legacy ??
    item?.current_period_end ??
    (subscription.status === 'trialing' ? subscription.trial_end : null);
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null;
}

function metadataSiteCount(metadata: Record<string, string>): number {
  const parsed = Number(metadata.siteCount);
  return Number.isInteger(parsed) &&
    parsed >= MIN_MULTI_SITE_COUNT &&
    parsed <= MAX_MULTI_SITE_COUNT
    ? parsed
    : 1;
}

function metadataSiteCountOrUndefined(metadata: Record<string, string>): number | undefined {
  if (!metadata.siteCount) return undefined;
  const parsed = Number(metadata.siteCount);
  return Number.isInteger(parsed) &&
    parsed >= MIN_MULTI_SITE_COUNT &&
    parsed <= MAX_MULTI_SITE_COUNT
    ? parsed
    : undefined;
}

/**
 * Keep the multi-site entitlement at account scope. The historical
 * RestaurantBilling projection remains the source for single-site webhooks,
 * while this projection is what the site-management API uses for quotas.
 */
async function projectAccountBilling(
  restaurantId: string,
  data: {
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
    subscriptionStatus?: string | null;
    subscriptionPriceId?: string | null;
    subscriptionBillingInterval?: BillingInterval | null;
    plan?: Plan;
    entitledSiteCount: number;
    subscriptionCurrentPeriodEnd?: Date | null;
    subscriptionCancelAtPeriodEnd?: boolean;
    lastStripeEventCreated: number;
    lastStripeEventId: string;
  },
  tx: Prisma.TransactionClient = db,
): Promise<void> {
  const restaurant = await tx.restaurant.findUnique({
    where: { id: restaurantId },
    select: { accountId: true },
  });
  if (!restaurant?.accountId) return;

  if (data.plan) {
    await tx.restaurant.updateMany({
      where: { accountId: restaurant.accountId },
      data: { plan: data.plan },
    });
  }

  await tx.restaurantAccountBilling.upsert({
    where: { accountId: restaurant.accountId },
    create: {
      accountId: restaurant.accountId,
      stripeCustomerId: data.stripeCustomerId ?? null,
      stripeSubscriptionId: data.stripeSubscriptionId ?? null,
      subscriptionStatus: data.subscriptionStatus ?? null,
      subscriptionPriceId: data.subscriptionPriceId ?? null,
      subscriptionBillingInterval: data.subscriptionBillingInterval ?? null,
      entitledSiteCount: data.entitledSiteCount,
      entitlementSource: 'STRIPE',
      subscriptionCurrentPeriodEnd: data.subscriptionCurrentPeriodEnd ?? null,
      subscriptionCancelAtPeriodEnd: data.subscriptionCancelAtPeriodEnd ?? false,
      lastStripeEventCreated: data.lastStripeEventCreated,
      lastStripeEventId: data.lastStripeEventId,
    },
    update: {
      stripeCustomerId: data.stripeCustomerId ?? undefined,
      stripeSubscriptionId: data.stripeSubscriptionId ?? undefined,
      subscriptionStatus: data.subscriptionStatus ?? undefined,
      subscriptionPriceId: data.subscriptionPriceId ?? undefined,
      subscriptionBillingInterval: data.subscriptionBillingInterval ?? undefined,
      entitledSiteCount: data.entitledSiteCount,
      entitlementSource: 'STRIPE',
      subscriptionCurrentPeriodEnd: data.subscriptionCurrentPeriodEnd ?? null,
      subscriptionCancelAtPeriodEnd: data.subscriptionCancelAtPeriodEnd ?? false,
      lastStripeEventCreated: data.lastStripeEventCreated,
      lastStripeEventId: data.lastStripeEventId,
    },
  });
}

async function handleCheckoutCompleted(
  event: Stripe.Event,
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const session = event.data.object as Stripe.Checkout.Session;
  if (session.mode !== 'subscription') return false;
  const metadata = session.metadata ?? {};
  const eventRestaurantId = metadata.restaurantId ?? session.client_reference_id ?? undefined;
  const plan = metadata.plan && isPublicBillingPlan(metadata.plan) ? metadata.plan : null;
  if (!eventRestaurantId || !plan) return false;
  const restaurantId = await billingAnchorId(tx, eventRestaurantId);
  const subscriptionId = stripeObjectId(session.subscription);
  const order = await compareStripeEvent(restaurantId, event, tx);
  if (order === 'stale') return true;
  if (order === 'tie') {
    if (!subscriptionId) throw new BillingCheckoutError();
    const live = await retrieveLiveSubscription(subscriptionId);
    await applySubscriptionSnapshot(
      restaurantId,
      live,
      live.status === 'canceled',
      eventCheckpoint(event),
      tx,
    );
    return true;
  }
  const customerId = stripeObjectId(session.customer);
  const billingInterval =
    metadata.billing && isBillingInterval(metadata.billing) ? metadata.billing : 'monthly';
  const siteCount = metadataSiteCount(metadata);
  // A trial Checkout completes without payment: the subscription is `trialing`, not `active`.
  const subscriptionStatus = metadata.trial === 'true' ? 'trialing' : 'active';
  await tx.restaurant.update({
    where: { id: restaurantId },
    data: { plan: PLAN_TO_DATABASE[plan] },
  });
  // Project the account entitlement before advancing the legacy restaurant
  // checkpoint. If this write fails, Stripe can retry the event instead of
  // seeing a stale checkpoint and skipping the projection.
  await projectAccountBilling(
    restaurantId,
    {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus,
      subscriptionPriceId: resolvePriceId(plan, billingInterval),
      subscriptionBillingInterval: billingInterval,
      plan: PLAN_TO_DATABASE[plan],
      entitledSiteCount: siteCount,
      lastStripeEventCreated: eventCreated(event),
      lastStripeEventId: eventId(event),
    },
    tx,
  );
  await tx.restaurantBilling.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus,
      subscriptionPriceId: resolvePriceId(plan, billingInterval),
      subscriptionBillingInterval: billingInterval,
      ...eventCheckpoint(event),
      ...clearCheckoutAttempt(),
    },
    update: {
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus,
      subscriptionPriceId: resolvePriceId(plan, billingInterval),
      subscriptionBillingInterval: billingInterval,
      ...eventCheckpoint(event),
      ...clearCheckoutAttempt(),
    },
  });
  return true;
}

async function handleSubscriptionEvent(
  event: Stripe.Event,
  eventType:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted'
    | 'customer.subscription.trial_will_end',
  subscription: SubscriptionObject,
  tx: Prisma.TransactionClient,
  queueNotification: (restaurantId: string, subscription: SubscriptionObject) => void,
): Promise<boolean> {
  const metadata = subscription.metadata ?? {};
  let restaurantId: string | undefined = metadata.restaurantId;
  if (!restaurantId) {
    const existing = await tx.restaurantBilling.findUnique({
      where: { stripeSubscriptionId: subscription.id },
    });
    restaurantId = existing?.restaurantId;
  }
  if (!restaurantId) return false;
  restaurantId = await billingAnchorId(tx, restaurantId);

  // The trial reminder only schedules an e-mail (the worker re-checks it at send time). Its
  // snapshot can predate the subscription's current state: it never rewrites the projection.
  if (eventType === 'customer.subscription.trial_will_end') {
    queueNotification(restaurantId, subscription);
    return true;
  }

  const order = await compareStripeEvent(restaurantId, event, tx);
  if (order === 'stale') return true;
  const current = order === 'tie' ? await retrieveLiveSubscription(subscription.id) : subscription;
  const deleted = eventType === 'customer.subscription.deleted' || current.status === 'canceled';
  await applySubscriptionSnapshot(restaurantId, current, deleted, eventCheckpoint(event), tx);
  queueNotification(restaurantId, subscription);
  return true;
}

/**
 * Projects one subscription snapshot onto the restaurant and account billing records. Shared by
 * webhooks and by the reconciliation of records that an earlier same-second race left behind.
 */
async function applySubscriptionSnapshot(
  restaurantId: string,
  subscription: SubscriptionObject,
  deleted: boolean,
  checkpoint: { lastStripeEventCreated: number; lastStripeEventId: string },
  tx: Prisma.TransactionClient = db,
): Promise<void> {
  const metadata = subscription.metadata ?? {};
  const priceId = subscription.items.data[0]?.price?.id;
  const planFromMetadata =
    metadata.plan && isPublicBillingPlan(metadata.plan) ? metadata.plan : null;
  // The current price wins: a Stripe portal plan switch changes the price but keeps the
  // Checkout metadata. Metadata only covers historical prices absent from the catalogue.
  const plan = (priceId ? getPublicPlanFromPriceId(priceId) : null) ?? planFromMetadata;
  const billingData = subscriptionUpdateData(subscription, deleted);
  const siteCount = deleted ? 1 : metadataSiteCount(metadata);
  if (plan && deleted) {
    await tx.restaurant.update({ where: { id: restaurantId }, data: { plan: 'STARTER' } });
  } else if (plan) {
    await tx.restaurant.update({
      where: { id: restaurantId },
      data: { plan: PLAN_TO_DATABASE[plan] },
    });
  }
  // Keep this projection ahead of the legacy checkpoint for the same retry
  // reason as checkout.session.completed above.
  await projectAccountBilling(
    restaurantId,
    {
      ...billingData,
      plan: plan ? (deleted ? 'STARTER' : PLAN_TO_DATABASE[plan]) : undefined,
      entitledSiteCount: siteCount,
      ...checkpoint,
    },
    tx,
  );
  await tx.restaurantBilling.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      ...billingData,
      ...clearCheckoutAttempt(),
      ...checkpoint,
    },
    update: { ...billingData, ...clearCheckoutAttempt(), ...checkpoint },
  });
}

export interface BillingReconciliationResult {
  restaurantId: string;
  subscriptionId: string;
  storedStatus: string | null;
  liveStatus: string;
  changed: boolean;
  applied: boolean;
}

/**
 * Repairs billing records whose projected status differs from Stripe (for example a trial ended
 * early that stayed `trialing`, see the 21/10/2026 audit). Dry-run unless `apply` is set. Applying
 * re-projects the live subscription without moving the event checkpoint, so later webhooks keep
 * their normal ordering. Logs and results carry identifiers and statuses only.
 */
export async function reconcileBillingFromStripe(options: {
  apply: boolean;
  restaurantId?: string;
}): Promise<BillingReconciliationResult[]> {
  const records = await db.restaurantBilling.findMany({
    where: {
      stripeSubscriptionId: { not: null },
      ...(options.restaurantId ? { restaurantId: options.restaurantId } : {}),
    },
    select: {
      restaurantId: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
      lastStripeEventCreated: true,
      lastStripeEventId: true,
    },
    orderBy: { restaurantId: 'asc' },
  });
  const results: BillingReconciliationResult[] = [];
  for (const record of records) {
    if (!record.stripeSubscriptionId) continue;
    const live = await retrieveLiveSubscription(record.stripeSubscriptionId);
    const changed = record.subscriptionStatus !== live.status;
    if (changed && options.apply) {
      await applySubscriptionSnapshot(record.restaurantId, live, live.status === 'canceled', {
        lastStripeEventCreated: record.lastStripeEventCreated ?? 0,
        lastStripeEventId: record.lastStripeEventId ?? '',
      });
    }
    results.push({
      restaurantId: record.restaurantId,
      subscriptionId: record.stripeSubscriptionId,
      storedStatus: record.subscriptionStatus ?? null,
      liveStatus: live.status,
      changed,
      applied: changed && options.apply,
    });
  }
  return results;
}

function stripeDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === 'number' ? new Date(seconds * 1000) : null;
}

/**
 * Trial ending (Stripe sends `trial_will_end` three days before) and service suspended (the
 * subscription was deleted): one e-mail each per subscription, sent by the billing-notifications
 * worker, which checks again that it still applies at send time.
 */
async function enqueueBillingNotification(
  eventType: string,
  restaurantId: string,
  subscription: SubscriptionObject,
): Promise<void> {
  const since =
    stripeDate(subscription.trial_start) ??
    stripeDate(subscription.start_date) ??
    stripeDate(subscription.created) ??
    new Date();
  let data: BillingNotificationJobData | null = null;
  if (eventType === 'customer.subscription.trial_will_end') {
    const trialEnd = stripeDate(subscription.trial_end);
    if (!trialEnd) return;
    data = {
      kind: 'trial-ending',
      restaurantId,
      subscriptionId: subscription.id,
      since: since.toISOString(),
      trialEndsAt: trialEnd.toISOString(),
    };
  } else if (eventType === 'customer.subscription.deleted') {
    const trialEnd = stripeDate(subscription.trial_end);
    const endedAt =
      stripeDate(subscription.ended_at) ?? stripeDate(subscription.canceled_at) ?? new Date();
    // Ended within a day of the trial end: the trial expired without a card.
    const endedFromTrial = Boolean(
      trialEnd && Math.abs(endedAt.getTime() - trialEnd.getTime()) <= 24 * 60 * 60 * 1000,
    );
    data = {
      kind: 'service-suspended',
      restaurantId,
      subscriptionId: subscription.id,
      since: since.toISOString(),
      endedFromTrial,
    };
  }
  if (!data) return;
  await queues.billingNotifications.add(data.kind, data, {
    jobId: buildBillingNotificationJobId(data.kind, subscription.id),
  });
}

/** Whether a card (or other payment method) will pay this subscription at the end of the trial. */
export async function subscriptionHasPaymentMethod(subscriptionId: string): Promise<boolean> {
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId, {
    expand: ['customer'],
  });
  if (subscription.default_payment_method || subscription.default_source) return true;
  const customer = subscription.customer;
  if (typeof customer === 'string' || customer.deleted) return false;
  return Boolean(customer.invoice_settings?.default_payment_method || customer.default_source);
}

type InvoiceObject = Stripe.Invoice & {
  metadata?: Record<string, string> | null;
};

type InvoiceBillingRecord = {
  restaurantId: string;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  subscriptionStatus?: string | null;
  subscriptionPriceId?: string | null;
  subscriptionBillingInterval?: string | null;
  subscriptionCurrentPeriodEnd?: Date | null;
  subscriptionCancelAtPeriodEnd?: boolean;
};

function invoicePrice(invoice: InvoiceObject): {
  id: string;
  recurring?: { interval?: string | null } | null;
} | null {
  const line = invoice.lines?.data?.[0] as
    | {
        price?: string | { id: string; recurring?: { interval?: string | null } | null } | null;
      }
    | undefined;
  return typeof line?.price === 'object' && line.price ? line.price : null;
}

function invoicePriceId(invoice: InvoiceObject): string | undefined {
  return stripeObjectId(invoicePrice(invoice)) ?? undefined;
}

function invoiceBillingInterval(invoice: InvoiceObject): BillingInterval | null {
  return billingIntervalFromStripePrice(invoicePrice(invoice));
}

/**
 * End of the service period the invoice bills. `invoice.period_end` is the end of the usage
 * window that just closed (the invoice date for a subscription invoice), not the end of the
 * paid period: a trial start invoice would otherwise end the trial on day one.
 */
function invoicePeriodEnd(invoice: InvoiceObject): Date | undefined {
  const lineEnd = invoice.lines?.data
    ?.map((line) => line.period?.end)
    .filter((end): end is number => Number.isInteger(end) && end > 0)
    .sort((a, b) => b - a)[0];
  const seconds = lineEnd ?? invoice.period_end;
  return Number.isInteger(seconds) && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

async function findBillingForInvoice(
  invoice: InvoiceObject,
  tx: Prisma.TransactionClient = db,
): Promise<{ billing: InvoiceBillingRecord | null; restaurantId: string } | null> {
  const subscriptionId = stripeObjectId(invoice.subscription);
  const customerId = stripeObjectId(invoice.customer);
  let billing = subscriptionId
    ? ((await tx.restaurantBilling.findUnique({
        where: { stripeSubscriptionId: subscriptionId },
      })) as InvoiceBillingRecord | null)
    : null;

  if (!billing && customerId) {
    billing = (await tx.restaurantBilling.findUnique({
      where: { stripeCustomerId: customerId },
    })) as InvoiceBillingRecord | null;
  }

  const metadata = (invoice.metadata ?? {}) as Record<string, string>;
  const restaurantId = billing?.restaurantId ?? metadata.restaurantId;
  if (!restaurantId) return null;
  return { billing, restaurantId };
}

async function findAccountBillingForRestaurant(restaurantId: string, tx: Prisma.TransactionClient) {
  const restaurant = await tx.restaurant.findUnique({
    where: { id: restaurantId },
    select: { accountId: true },
  });
  if (!restaurant?.accountId) return null;
  return tx.restaurantAccountBilling.findUnique({ where: { accountId: restaurant.accountId } });
}

/**
 * Stripe's Billing Portal owns proration and cancellation scheduling. These
 * invoice events keep Suppernote's entitlement projection in sync with the
 * provider: a failed attempt enters the configured Stripe grace window as
 * `past_due`, a later `invoice.paid` reactivates it, and only
 * `customer.subscription.deleted` removes the plan.
 */
async function handleInvoiceEvent(
  event: Stripe.Event,
  eventType: 'invoice.paid' | 'invoice.payment_failed' | 'invoice.payment_succeeded',
  tx: Prisma.TransactionClient,
): Promise<boolean> {
  const invoice = event.data.object as unknown as InvoiceObject;
  const resolved = await findBillingForInvoice(invoice, tx);
  if (!resolved) return false;

  const { billing } = resolved;
  const restaurantId = await billingAnchorId(tx, resolved.restaurantId);
  const order = await compareStripeEvent(restaurantId, event, tx);
  if (order === 'stale') return true;

  const metadata = (invoice.metadata ?? {}) as Record<string, string>;
  const customerId = stripeObjectId(invoice.customer) ?? billing?.stripeCustomerId ?? null;
  const subscriptionId =
    stripeObjectId(invoice.subscription) ?? billing?.stripeSubscriptionId ?? null;
  const priceId = invoicePriceId(invoice) ?? billing?.subscriptionPriceId ?? null;
  const billingInterval =
    invoiceBillingInterval(invoice) ?? storedBillingInterval(billing?.subscriptionBillingInterval);
  const planFromMetadata =
    metadata.plan && isPublicBillingPlan(metadata.plan) ? metadata.plan : null;
  const plan = planFromMetadata ?? (priceId ? getPublicPlanFromPriceId(priceId) : null);
  const accountBilling = await findAccountBillingForRestaurant(restaurantId, tx);
  const siteCount =
    metadataSiteCountOrUndefined(metadata) ?? accountBilling?.entitledSiteCount ?? 1;
  const paid = eventType !== 'invoice.payment_failed';
  // A trial opens with a zero invoice marked paid: the subscription is still `trialing`.
  const trialStartInvoice =
    paid && invoice.billing_reason === 'subscription_create' && invoice.amount_paid === 0;
  // Same second as the last applied event: the invoice alone cannot tell which state is current,
  // so the subscription status comes from Stripe (see compareStripeEvent).
  const live =
    order === 'tie' && subscriptionId ? await retrieveLiveSubscription(subscriptionId) : null;
  if (live) {
    await applySubscriptionSnapshot(
      restaurantId,
      live,
      live.status === 'canceled',
      eventCheckpoint(event),
      tx,
    );
    return true;
  }
  const status = trialStartInvoice ? 'trialing' : paid ? 'active' : 'past_due';
  const periodEnd = invoicePeriodEnd(invoice) ?? billing?.subscriptionCurrentPeriodEnd ?? null;
  const cancelAtPeriodEnd = billing?.subscriptionCancelAtPeriodEnd ?? false;

  // A successful first or renewal invoice can carry the plan snapshot. A
  // failed attempt must leave the existing entitlement untouched during the
  // provider's grace window.
  const entitles = paid && Boolean(plan);
  if (entitles && plan) {
    await tx.restaurant.update({
      where: { id: restaurantId },
      data: { plan: PLAN_TO_DATABASE[plan] },
    });
  }

  await projectAccountBilling(
    restaurantId,
    {
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      subscriptionPriceId: priceId,
      ...(billingInterval ? { subscriptionBillingInterval: billingInterval } : {}),
      plan: entitles && plan ? PLAN_TO_DATABASE[plan] : undefined,
      entitledSiteCount: siteCount,
      subscriptionCurrentPeriodEnd: periodEnd,
      subscriptionCancelAtPeriodEnd: cancelAtPeriodEnd,
      lastStripeEventCreated: eventCreated(event),
      lastStripeEventId: eventId(event),
    },
    tx,
  );

  await tx.restaurantBilling.upsert({
    where: { restaurantId },
    create: {
      restaurantId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      subscriptionStatus: status,
      subscriptionPriceId: priceId,
      ...(billingInterval ? { subscriptionBillingInterval: billingInterval } : {}),
      subscriptionCurrentPeriodEnd: periodEnd,
      subscriptionCancelAtPeriodEnd: cancelAtPeriodEnd,
      ...eventCheckpoint(event),
      ...clearCheckoutAttempt(),
    },
    update: {
      stripeCustomerId: customerId ?? undefined,
      stripeSubscriptionId: subscriptionId ?? undefined,
      subscriptionStatus: status,
      subscriptionPriceId: priceId ?? undefined,
      ...(billingInterval ? { subscriptionBillingInterval: billingInterval } : {}),
      subscriptionCurrentPeriodEnd: periodEnd ?? undefined,
      subscriptionCancelAtPeriodEnd: cancelAtPeriodEnd,
      ...eventCheckpoint(event),
      ...clearCheckoutAttempt(),
    },
  });

  return true;
}

async function billingEventRestaurantId(event: Stripe.Event): Promise<string | undefined> {
  if (event.type.startsWith('invoice.')) {
    return (await findBillingForInvoice(event.data.object as InvoiceObject))?.restaurantId;
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    return session.metadata?.restaurantId ?? session.client_reference_id ?? undefined;
  }
  const subscription = event.data.object as SubscriptionObject;
  if (subscription.metadata?.restaurantId) return subscription.metadata.restaurantId;
  return (
    // tenant-scoping: global — lookup par ID d'abonnement Stripe (webhook signé).
    (await db.restaurantBilling.findUnique({ where: { stripeSubscriptionId: subscription.id } }))
      ?.restaurantId
  );
}

async function billingAnchorId(
  tx: Prisma.TransactionClient,
  restaurantId: string,
): Promise<string> {
  const restaurant = await tx.restaurant.findUnique({
    where: { id: restaurantId },
    select: { accountId: true },
  });
  if (!restaurant?.accountId) return restaurantId;
  const primary = await tx.restaurant.findFirst({
    where: { accountId: restaurant.accountId, isPrimary: true, siteStatus: { not: 'ARCHIVED' } },
    select: { id: true },
  });
  return primary?.id ?? restaurantId;
}

async function lockBillingScope(tx: Prisma.TransactionClient, restaurantId: string): Promise<void> {
  const restaurant = await tx.restaurant.findUnique({
    where: { id: restaurantId },
    select: { accountId: true },
  });
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`billing:${restaurant?.accountId ?? restaurantId}`}))`;
}

async function withBillingLock<T>(restaurantId: string, action: () => Promise<T>): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await lockBillingScope(tx, restaurantId);
      return action();
    },
    { timeout: 60000 },
  );
}

/**
 * Applies only subscription events. Gift-card events remain handled by the
 * existing payment service. Returning false lets the webhook route log an
 * unknown/non-subscription event without mutating tenant billing state.
 */
export async function handleBillingWebhook(event: Stripe.Event): Promise<boolean> {
  const supported = new Set<SupportedBillingEvent>([
    'checkout.session.completed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'customer.subscription.trial_will_end',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.payment_succeeded',
  ]);
  if (!supported.has(event.type as SupportedBillingEvent)) return false;

  const claim = await claimStripeEvent(event);
  if (claim === 'processed') return true;
  if (claim === 'in-flight') throw new BillingWebhookInProgressError();

  try {
    const restaurantId = await billingEventRestaurantId(event);
    let notification: { restaurantId: string; subscription: SubscriptionObject } | undefined;
    const handled = await db.$transaction(
      async (tx) => {
        if (restaurantId) await lockBillingScope(tx, restaurantId);
        return event.type === 'checkout.session.completed'
          ? handleCheckoutCompleted(event, tx)
          : event.type === 'invoice.paid' ||
              event.type === 'invoice.payment_failed' ||
              event.type === 'invoice.payment_succeeded'
            ? handleInvoiceEvent(event, event.type, tx)
            : handleSubscriptionEvent(
                event,
                event.type as Exclude<
                  SupportedBillingEvent,
                  | 'checkout.session.completed'
                  | 'invoice.paid'
                  | 'invoice.payment_failed'
                  | 'invoice.payment_succeeded'
                >,
                event.data.object as unknown as SubscriptionObject,
                tx,
                (id, subscription) => {
                  notification = { restaurantId: id, subscription };
                },
              );
      },
      { timeout: 30000 },
    );
    if (notification) {
      await enqueueBillingNotification(
        event.type,
        notification.restaurantId,
        notification.subscription,
      );
    }
    await markStripeEventProcessed(event);
    return handled;
  } catch (error) {
    try {
      await markStripeEventFailed(event, error);
    } catch (markError) {
      logger.error(
        { err: markError instanceof Error ? markError.message : String(markError) },
        '[billing] Failed to record Stripe event failure',
      );
    }
    throw error;
  }
}
