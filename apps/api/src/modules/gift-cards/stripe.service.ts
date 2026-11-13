/**
 * Stripe service — Payment Intents + webhook pour les cartes cadeaux.
 *
 * En dev, utiliser les clés de test Stripe (sk_test_*).
 * Le webhook nécessite une URL publique (ngrok ou domaine de prod).
 */
import Stripe from 'stripe';
import { describeConnectedAccount } from './gift-card-connect-status';
import { logger } from '../../shared/logger/pino';

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) {
      throw new Error('STRIPE_SECRET_KEY is required');
    }
    // R1-2 : bornes explicites plutôt que les défauts du SDK. `timeout` évite
    // qu'un paiement reste en vol, `maxNetworkRetries` rejoue uniquement les
    // erreurs réseau (Stripe ne rejoue jamais un 4xx).
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      timeout: 10_000,
      maxNetworkRetries: 2,
    });
  }
  return _stripe;
}

export type CreatePaymentIntentInput = {
  amount: number; // en centimes
  currency: string;
  metadata: Record<string, string>;
  idempotencyKey?: string;
  stripeAccountId?: string;
  applicationFeeAmount?: number;
};

/**
 * Crée un PaymentIntent Stripe pour un paiement carte cadeau.
 * Retourne le client_secret à utiliser côté client avec Stripe Elements.
 */
export async function createPaymentIntent(input: CreatePaymentIntentInput): Promise<{
  id: string;
  clientSecret: string;
}> {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.create(
    {
      amount: input.amount,
      currency: input.currency,
      metadata: input.metadata,
      ...(input.applicationFeeAmount !== undefined
        ? { application_fee_amount: input.applicationFeeAmount }
        : {}),
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    },
    {
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.stripeAccountId ? { stripeAccount: input.stripeAccountId } : {}),
    },
  );
  return {
    id: intent.id,
    clientSecret: intent.client_secret!,
  };
}

export async function createExperienceCheckoutSession(input: {
  amountCents: number;
  applicationFeeCents: number;
  currency: string;
  restaurantId: string;
  experienceCheckoutId: string;
  experienceName: string;
  sessionStartsAt: Date;
  quantity: number;
  expiresAt: Date;
  successUrl: string;
  cancelUrl: string;
  stripeAccountId: string;
  idempotencyKey: string;
}) {
  const session = await getStripe().checkout.sessions.create(
    {
      mode: 'payment',
      locale: 'fr',
      payment_method_types: ['card'],
      line_items: [
        {
          quantity: input.quantity,
          price_data: {
            currency: input.currency.toLowerCase(),
            unit_amount: input.amountCents / input.quantity,
            product_data: {
              name: input.experienceName,
              description: `Date du ${input.sessionStartsAt.toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Paris' })}`,
            },
          },
        },
      ],
      phone_number_collection: { enabled: true },
      custom_fields: [
        {
          key: 'guest_name',
          label: { type: 'custom', custom: 'Nom complet' },
          optional: false,
          text: { minimum_length: 2, maximum_length: 120 },
          type: 'text',
        },
      ],
      customer_creation: 'always',
      metadata: {
        type: 'experience_checkout',
        restaurantId: input.restaurantId,
        experienceCheckoutId: input.experienceCheckoutId,
      },
      ...(input.amountCents > 0
        ? {
            payment_intent_data: {
              ...(input.applicationFeeCents > 0
                ? { application_fee_amount: input.applicationFeeCents }
                : {}),
              metadata: {
                type: 'experience_checkout',
                restaurantId: input.restaurantId,
                experienceCheckoutId: input.experienceCheckoutId,
              },
            },
          }
        : {}),
      expires_at: Math.floor(input.expiresAt.getTime() / 1_000),
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
    },
    { idempotencyKey: input.idempotencyKey, stripeAccount: input.stripeAccountId },
  );
  if (!session.url) throw new Error('Stripe n’a pas fourni de lien de paiement.');
  return {
    id: session.id,
    url: session.url,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
  };
}

export async function expireExperienceCheckoutSession(sessionId: string, stripeAccountId: string) {
  const stripe = getStripe();
  try {
    return await stripe.checkout.sessions.expire(sessionId, { stripeAccount: stripeAccountId });
  } catch (error) {
    const current = await stripe.checkout.sessions.retrieve(sessionId, {
      stripeAccount: stripeAccountId,
    });
    if (current.status === 'expired' || current.status === 'complete') return current;
    throw error;
  }
}

export async function retrieveExperienceCheckoutSession(
  sessionId: string,
  stripeAccountId: string,
) {
  const session = await getStripe().checkout.sessions.retrieve(sessionId, {
    stripeAccount: stripeAccountId,
  });
  if (!session.url) throw new Error('Le lien de paiement Stripe n’est plus disponible.');
  return {
    id: session.id,
    url: session.url,
    paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : null,
  };
}

/**
 * Empreinte bancaire : page Stripe hébergée en mode `setup` sur le compte du restaurant.
 * Aucun montant n'est débité ; la carte est gardée pour un éventuel prélèvement hors session.
 */
export async function createReservationGuaranteeSetupSession(input: {
  stripeAccountId: string;
  stripeCustomerId: string | null;
  metadata: Record<string, string>;
  customerEmail?: string | null;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
  customText: string;
  customerIdempotencyKey: string;
  idempotencyKey: string;
}): Promise<{ sessionId: string; url: string; customerId: string }> {
  const stripe = getStripe();
  const options = { stripeAccount: input.stripeAccountId };
  const customerId =
    input.stripeCustomerId ??
    (
      await stripe.customers.create(
        {
          ...(input.customerEmail ? { email: input.customerEmail } : {}),
          metadata: input.metadata,
        },
        { ...options, idempotencyKey: input.customerIdempotencyKey },
      )
    ).id;
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'setup',
      customer: customerId,
      payment_method_types: ['card'],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      expires_at: Math.floor(input.expiresAt.getTime() / 1_000),
      locale: 'fr',
      metadata: input.metadata,
      setup_intent_data: { metadata: input.metadata },
      custom_text: { submit: { message: input.customText.slice(0, 1_200) } },
    },
    { ...options, idempotencyKey: input.idempotencyKey },
  );
  if (!session.url) throw new Error('Stripe n’a pas retourné de lien d’enregistrement de carte.');
  return { sessionId: session.id, url: session.url, customerId };
}

/**
 * Prélèvement d'une empreinte, hors session, sur décision de l'équipe.
 * Un refus bancaire ou une authentification exigée est renvoyé, jamais relancé.
 */
export async function chargeReservationGuarantee(input: {
  stripeAccountId: string;
  stripeCustomerId: string;
  stripePaymentMethodId: string;
  amountCents: number;
  currency: string;
  metadata: Record<string, string>;
  receiptEmail?: string | null;
  idempotencyKey: string;
}): Promise<
  | { ok: true; paymentIntentId: string; status: string }
  | { ok: false; paymentIntentId: string | null; failureCode: string }
> {
  try {
    const intent = await getStripe().paymentIntents.create(
      {
        amount: input.amountCents,
        currency: input.currency.toLowerCase(),
        customer: input.stripeCustomerId,
        payment_method: input.stripePaymentMethodId,
        off_session: true,
        confirm: true,
        metadata: input.metadata,
        ...(input.receiptEmail ? { receipt_email: input.receiptEmail } : {}),
      },
      { stripeAccount: input.stripeAccountId, idempotencyKey: input.idempotencyKey },
    );
    return { ok: true, paymentIntentId: intent.id, status: intent.status };
  } catch (error) {
    if (error instanceof Stripe.errors.StripeCardError) {
      const intent = (error.raw as { payment_intent?: { id?: string } } | undefined)
        ?.payment_intent;
      return {
        ok: false,
        paymentIntentId: intent?.id ?? null,
        failureCode: (error.decline_code ?? error.code ?? 'card_declined').slice(0, 120),
      };
    }
    throw error;
  }
}

/** Détache la carte d'une empreinte fermée ; une carte déjà détachée n'est pas une erreur. */
export async function detachReservationGuaranteeCard(
  paymentMethodId: string,
  stripeAccountId: string,
): Promise<void> {
  try {
    await getStripe().paymentMethods.detach(
      paymentMethodId,
      {},
      { stripeAccount: stripeAccountId },
    );
  } catch (error) {
    if (error instanceof Stripe.errors.StripeInvalidRequestError) return;
    throw error;
  }
}

/**
 * Récupère le statut d'un PaymentIntent.
 */
export async function retrievePaymentIntent(
  paymentIntentId: string,
  stripeAccountId?: string,
): Promise<{
  id: string;
  status: string;
  amount: number;
  amountReceived: number;
  currency: string;
  metadata: Record<string, string>;
  refundedAmount?: number;
  disputed?: boolean;
  pendingRefund?: boolean;
  clientSecret?: string | null;
}> {
  const stripe = getStripe();
  const intent = await stripe.paymentIntents.retrieve(
    paymentIntentId,
    { expand: ['latest_charge'] },
    stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
  );
  const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
  const refunds = charge
    ? await stripe.refunds.list(
        { payment_intent: intent.id, limit: 100 },
        stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
      )
    : null;
  return {
    id: intent.id,
    status: intent.status,
    amount: intent.amount,
    amountReceived: intent.amount_received,
    currency: intent.currency,
    metadata: intent.metadata,
    refundedAmount: charge?.amount_refunded ?? 0,
    disputed: charge?.disputed ?? false,
    pendingRefund: Boolean(
      refunds?.has_more ||
      refunds?.data.some((refund) =>
        ['pending', 'requires_action'].includes(refund.status ?? 'pending'),
      ),
    ),
    clientSecret: intent.client_secret,
  };
}

export type CreateRefundInput = {
  paymentIntentId: string;
  amount?: number; // montant en centimes (optionnel = remboursement total)
  idempotencyKey?: string;
  stripeAccountId?: string;
};

/**
 * Crée un remboursement Stripe sur un PaymentIntent.
 */
export async function createRefund(
  input: CreateRefundInput,
): Promise<{ id: string; amount: number; status: string }> {
  const stripe = getStripe();
  const payment = input.stripeAccountId
    ? await stripe.paymentIntents.retrieve(
        input.paymentIntentId,
        {},
        { stripeAccount: input.stripeAccountId },
      )
    : null;
  const refund = await stripe.refunds.create(
    {
      payment_intent: input.paymentIntentId,
      amount: input.amount,
      refund_application_fee: Boolean(
        input.stripeAccountId && (payment?.application_fee_amount ?? 0) > 0,
      ),
    },
    {
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.stripeAccountId ? { stripeAccount: input.stripeAccountId } : {}),
    },
  );
  return { id: refund.id, amount: refund.amount, status: refund.status ?? 'pending' };
}

export async function retrieveRefund(refundId: string, stripeAccountId?: string) {
  const refund = await getStripe().refunds.retrieve(
    refundId,
    stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
  );
  return { id: refund.id, amount: refund.amount, status: refund.status ?? 'pending' };
}

export async function retrieveConnectedAccount(accountId: string) {
  const account = await getStripe().accounts.retrieve(accountId);
  return {
    id: account.id,
    chargesEnabled: account.charges_enabled,
    payoutsEnabled: account.payouts_enabled,
    detailsSubmitted: account.details_submitted,
    ...describeConnectedAccount(account),
  };
}

// Pin Accounts v2 only: billing and payment APIs retain the SDK's existing version.
const CONNECT_ACCOUNTS_API_VERSION = '2026-08-26.dahlia';

// This experimental path is restricted to explicitly selected sandbox restaurants.
export function managedConnectTestEnabled(restaurantId: string): boolean {
  return (
    process.env.STRIPE_MANAGED_CONNECT_TEST_ENABLED === 'true' &&
    process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_') === true &&
    process.env.STRIPE_PUBLISHABLE_KEY?.startsWith('pk_test_') === true &&
    (process.env.STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS ?? '')
      .split(',')
      .map((id) => id.trim())
      .includes(restaurantId)
  );
}

export function managedConnectTestPublicKey(restaurantId: string): string {
  if (!managedConnectTestEnabled(restaurantId)) throw new Error('Configuration indisponible.');
  return process.env.STRIPE_PUBLISHABLE_KEY!.trim();
}

export async function createManagedTestAccount(restaurantId: string): Promise<string> {
  if (!managedConnectTestEnabled(restaurantId)) throw new Error('Configuration indisponible.');
  const account = (await getStripe().rawRequest(
    'POST',
    '/v2/core/accounts',
    { identity: { country: 'FR' }, metadata: { restaurantId, source: MANAGED_TEST_SOURCE } },
    {
      apiVersion: CONNECT_ACCOUNTS_API_VERSION,
      idempotencyKey: `gift-card-managed-test:${restaurantId}`,
    },
  )) as unknown as { id?: unknown };
  if (typeof account.id !== 'string' || !/^acct_[A-Za-z0-9]+$/.test(account.id)) {
    throw new Error('Stripe n’a pas retourné de compte connecté valide.');
  }
  return account.id;
}

export async function configureManagedTestAccount(
  restaurantId: string,
  accountId: string,
  accountToken: string,
): Promise<void> {
  if (!managedConnectTestEnabled(restaurantId)) throw new Error('Configuration indisponible.');
  const stripe = getStripe();
  const account = (await stripe.rawRequest('GET', `/v2/core/accounts/${accountId}`, undefined, {
    apiVersion: CONNECT_ACCOUNTS_API_VERSION,
  })) as unknown as {
    livemode?: boolean;
    metadata?: Record<string, string>;
    applied_configurations?: string[];
  };
  if (
    account.metadata?.restaurantId !== restaurantId ||
    !isManagedTestSource(account.metadata?.source) ||
    account.livemode !== false
  ) {
    throw new Error('Compte de test incompatible.');
  }
  if (account.applied_configurations?.includes('merchant')) return;
  await stripe.rawRequest(
    'POST',
    `/v2/core/accounts/${accountId}`,
    {
      account_token: accountToken,
      dashboard: 'none',
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: {
        currency: 'eur',
        locales: ['fr-FR'],
        responsibilities: { fees_collector: 'application', losses_collector: 'application' },
      },
    },
    { apiVersion: CONNECT_ACCOUNTS_API_VERSION },
  );
}

export async function createManagedTestSession(restaurantId: string, accountId: string) {
  if (!managedConnectTestEnabled(restaurantId)) throw new Error('Configuration indisponible.');
  const session = await getStripe().accountSessions.create({
    account: accountId,
    components: {
      account_onboarding: { enabled: true, features: { disable_stripe_user_authentication: true } },
    },
  });
  return {
    clientSecret: session.client_secret,
    publishableKey: managedConnectTestPublicKey(restaurantId),
  };
}

export async function isManagedTestAccount(
  restaurantId: string,
  accountId: string,
): Promise<boolean> {
  if (!managedConnectTestEnabled(restaurantId)) return false;
  const account = await getStripe().accounts.retrieve(accountId);
  return (
    account.metadata?.restaurantId === restaurantId && isManagedTestSource(account.metadata?.source)
  );
}

export async function createConnectedAccount(restaurantId: string, _email: string) {
  // The pinned SDK supports raw v2 JSON requests but predates typed Accounts v2.
  // Account IDs remain interoperable with v1 Account Links and PaymentIntents.
  // French personal data must be tokenized if prefilled; Stripe onboarding collects it directly.
  const account = await getStripe().rawRequest(
    'POST',
    '/v2/core/accounts',
    {
      identity: { country: 'FR' },
      dashboard: 'full',
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: {
        currency: 'eur',
        locales: ['fr-FR'],
        responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
      },
      metadata: { restaurantId, source: 'suppernote_gift_cards' },
    },
    {
      apiVersion: CONNECT_ACCOUNTS_API_VERSION,
      idempotencyKey: `gift-card-connect-v2:${restaurantId}:hosted`,
    },
  );
  if (
    !account ||
    typeof account !== 'object' ||
    !('id' in account) ||
    typeof account.id !== 'string' ||
    !/^acct_[A-Za-z0-9]+$/.test(account.id)
  ) {
    throw new Error('Stripe n’a pas retourné de compte connecté valide.');
  }
  return account.id;
}

export async function retrieveChargePaymentIntent(chargeId: string, stripeAccountId?: string) {
  const charge = await getStripe().charges.retrieve(
    chargeId,
    stripeAccountId ? { stripeAccount: stripeAccountId } : undefined,
  );
  return typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;
}

export async function createConnectedAccountLink(accountId: string) {
  const origin = process.env.DASHBOARD_URL;
  if (!origin || !/^https:\/\//.test(origin)) throw new Error('DASHBOARD_URL HTTPS est requis');
  const base = new URL('/dashboard/gift-cards', origin).toString();
  return getStripe().accountLinks.create({
    account: accountId,
    type: 'account_onboarding',
    refresh_url: `${base}?stripeConnect=refresh`,
    return_url: `${base}?stripeConnect=return`,
  });
}

/** Short-lived, owner-scoped access to onboarding only; never persist or log this secret. */
export async function createConnectedAccountSession(accountId: string) {
  const publishableKey = process.env.STRIPE_PUBLISHABLE_KEY?.trim();
  if (!publishableKey?.startsWith('pk_')) {
    throw new Error('La clé publique Stripe est manquante pour la configuration intégrée.');
  }
  const session = await getStripe().accountSessions.create({
    account: accountId,
    components: { account_onboarding: { enabled: true } },
  });
  return { clientSecret: session.client_secret, publishableKey };
}

/**
 * Construit et vérifie un event Stripe depuis le webhook (signature verification).
 * Supporte une liste de secrets séparés par des virgules pour la rotation.
 */
const MANAGED_TEST_SOURCE = 'suppernote_managed_test';
/** Comptes de test créés avant le renommage : leur métadonnée Stripe garde l'ancien nom. */
function isManagedTestSource(source: string | undefined): boolean {
  return source === MANAGED_TEST_SOURCE || source === 'sokar_managed_test';
}

export async function constructWebhookEvent(
  payload: string,
  signature: string,
): Promise<Stripe.Event> {
  const rawSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!rawSecret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required');
  }

  const secrets = rawSecret
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) {
    throw new Error('STRIPE_WEBHOOK_SECRET is required');
  }

  const stripe = getStripe();
  let lastError: unknown;

  for (const secret of secrets) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (err: unknown) {
      lastError = err;
    }
  }

  throw lastError ?? new Error('STRIPE_WEBHOOK_SECRET is required');
}

export { logger };
