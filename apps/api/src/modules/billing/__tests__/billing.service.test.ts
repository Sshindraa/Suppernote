import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import {
  BillingWebhookInProgressError,
  buildCheckoutIdempotencyKey,
  billingIntervalFromStripeRecurringInterval,
  handleBillingWebhook,
  reconcileBillingFromStripe,
  resolveBillingIntervalForStatus,
} from '../billing.service';

describe('billing.service - changement de catalogue', () => {
  it('ne réutilise pas la clé Checkout de l’ancienne grille', () => {
    const now = new Date('2026-10-14T00:00:00Z');
    const bucket = Math.floor(now.getTime() / (24 * 60 * 60 * 1000));
    const legacySource = ['account-1', 'multi-site', 'annual', 3, `auto:${bucket}`].join('|');
    const legacyKey = `sokar-checkout-${createHash('sha256').update(legacySource).digest('hex').slice(0, 48)}`;
    const input = {
      restaurantId: 'restaurant-1',
      scopeId: 'account-1',
      plan: 'multi-site' as const,
      billing: 'annual' as const,
      siteCount: 3,
      now,
    };
    expect(buildCheckoutIdempotencyKey(input)).not.toBe(legacyKey);
    expect(buildCheckoutIdempotencyKey(input)).toBe(buildCheckoutIdempotencyKey(input));
  });
});

describe('billing.service - cadence des prix migrés', () => {
  afterEach(() => {
    delete process.env.STRIPE_PRICE_ESSENTIAL_ANNUAL;
  });

  it('préserve la cadence persistée pour un abonnement sur un ancien prix', () => {
    process.env.STRIPE_PRICE_ESSENTIAL_ANNUAL = 'price_essential_2026';

    expect(resolveBillingIntervalForStatus('price_essential_historic', 'monthly')).toBe('monthly');
    expect(resolveBillingIntervalForStatus('price_essential_2026', 'monthly')).toBe('annual');
    expect(resolveBillingIntervalForStatus('price_essential_historic', 'quarterly')).toBeNull();
  });

  it('convertit uniquement les cadences Stripe prises en charge', () => {
    expect(billingIntervalFromStripeRecurringInterval('month')).toBe('monthly');
    expect(billingIntervalFromStripeRecurringInterval('year')).toBe('annual');
    expect(billingIntervalFromStripeRecurringInterval('week')).toBeNull();
  });
});

describe('billing.service - Stripe subscription webhooks', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockReset();
    vi.mocked(db.restaurantBilling.findUnique).mockReset();
    vi.mocked(db.restaurantBilling.upsert).mockReset();
    vi.mocked(db.restaurantAccountBilling.findUnique).mockReset();
    vi.mocked(db.restaurantAccountBilling.upsert).mockReset();
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    delete process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY;
  });

  it('active une formule depuis checkout.session.completed', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);

    const handled = await handleBillingWebhook({
      type: 'checkout.session.completed',
      id: 'evt_checkout_1',
      created: 100,
      data: {
        object: {
          mode: 'subscription',
          id: 'cs_test',
          client_reference_id: 'test-rest-1',
          customer: 'cus_test',
          subscription: 'sub_test',
          metadata: { restaurantId: 'test-rest-1', plan: 'pro', billing: 'monthly' },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).toHaveBeenCalledWith({
      where: { id: 'test-rest-1' },
      data: { plan: 'PRO' },
    });
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId: 'test-rest-1' },
        create: expect.objectContaining({
          stripeCustomerId: 'cus_test',
          stripeSubscriptionId: 'sub_test',
          subscriptionStatus: 'active',
          subscriptionPriceId: 'price_pro_monthly_test',
        }),
      }),
    );
  });

  it('enregistre un Checkout d’essai comme période d’essai, pas comme abonnement actif', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);

    const handled = await handleBillingWebhook({
      type: 'checkout.session.completed',
      id: 'evt_checkout_trial',
      created: 100,
      data: {
        object: {
          mode: 'subscription',
          id: 'cs_trial',
          client_reference_id: 'test-rest-1',
          customer: 'cus_test',
          subscription: 'sub_trial',
          payment_status: 'no_payment_required',
          metadata: { restaurantId: 'test-rest-1', plan: 'pro', billing: 'monthly', trial: 'true' },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ subscriptionStatus: 'trialing' }),
        update: expect.objectContaining({ subscriptionStatus: 'trialing' }),
      }),
    );
  });

  it('projette le quota multi-site au niveau du compte', async () => {
    process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY = 'price_multi_site_monthly_test';
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      accountId: 'account_1',
    } as never);

    const handled = await handleBillingWebhook({
      type: 'checkout.session.completed',
      id: 'evt_checkout_multi_1',
      created: 101,
      data: {
        object: {
          mode: 'subscription',
          id: 'cs_multi_test',
          client_reference_id: 'test-rest-1',
          customer: 'cus_multi_test',
          subscription: 'sub_multi_test',
          metadata: {
            restaurantId: 'test-rest-1',
            plan: 'multi-site',
            billing: 'monthly',
            siteCount: '3',
          },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurantAccountBilling.upsert).toHaveBeenCalledWith({
      where: { accountId: 'account_1' },
      create: expect.objectContaining({
        accountId: 'account_1',
        entitledSiteCount: 3,
        stripeSubscriptionId: 'sub_multi_test',
      }),
      update: expect.objectContaining({ entitledSiteCount: 3 }),
    });
  });

  it('synchronise le statut et rétrograde au plan Essential après suppression', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const subscription = {
      id: 'sub_test',
      customer: 'cus_test',
      metadata: { restaurantId: 'test-rest-1', plan: 'pro' },
      status: 'canceled',
      cancel_at_period_end: false,
      current_period_end: 1_800_000_000,
      items: { data: [{ price: { id: 'price_pro_monthly_test' } }] },
    };

    const handled = await handleBillingWebhook({
      type: 'customer.subscription.deleted',
      id: 'evt_subscription_deleted_1',
      created: 200,
      data: { object: subscription },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).toHaveBeenCalledWith({
      where: { id: 'test-rest-1' },
      data: { plan: 'STARTER' },
    });
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          stripeSubscriptionId: 'sub_test',
          subscriptionStatus: 'canceled',
          subscriptionCancelAtPeriodEnd: false,
        }),
      }),
    );
  });

  it('ignore un événement Stripe déjà traité sans remuter le restaurant', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue({
      eventId: 'evt_duplicate',
      status: 'processed',
    } as unknown as Awaited<ReturnType<typeof db.stripeWebhookEvent.findUnique>>);

    const handled = await handleBillingWebhook({
      type: 'customer.subscription.updated',
      id: 'evt_duplicate',
      created: 300,
      data: { object: {} },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).not.toHaveBeenCalled();
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
  });

  it('demande à Stripe de réessayer si un autre worker traite encore l’événement', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue({
      eventId: 'evt_in_flight',
      status: 'processing',
      lastAttemptAt: new Date(),
    } as unknown as Awaited<ReturnType<typeof db.stripeWebhookEvent.findUnique>>);

    await expect(
      handleBillingWebhook({
        type: 'customer.subscription.updated',
        id: 'evt_in_flight',
        created: 300,
        data: { object: {} },
      } as never),
    ).rejects.toBeInstanceOf(BillingWebhookInProgressError);
    expect(db.restaurant.update).not.toHaveBeenCalled();
    expect(db.stripeWebhookEvent.update).not.toHaveBeenCalled();
  });

  it('suit le prix après un changement de formule depuis le portail Stripe', async () => {
    // Le portail change le prix mais laisse la metadata posée par Checkout.
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);

    const handled = await handleBillingWebhook({
      type: 'customer.subscription.updated',
      id: 'evt_portal_upgrade',
      created: 600,
      data: {
        object: {
          id: 'sub_test',
          customer: 'cus_test',
          metadata: { restaurantId: 'test-rest-1', plan: 'essential', billing: 'monthly' },
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1_800_000_000,
          items: { data: [{ price: { id: 'price_pro_monthly_test' } }] },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).toHaveBeenCalledWith({
      where: { id: 'test-rest-1' },
      data: { plan: 'PRO' },
    });
  });

  it('ignore un événement plus ancien que le dernier checkpoint de facturation', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      lastStripeEventCreated: 500,
      lastStripeEventId: 'evt_newer',
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

    const handled = await handleBillingWebhook({
      type: 'customer.subscription.updated',
      id: 'evt_older',
      created: 400,
      data: {
        object: {
          id: 'sub_test',
          customer: 'cus_test',
          metadata: { restaurantId: 'test-rest-1', plan: 'pro' },
          status: 'active',
          cancel_at_period_end: false,
          current_period_end: 1_800_000_000,
          items: { data: [{ price: { id: 'price_pro_monthly_test' } }] },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).not.toHaveBeenCalled();
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
  });

  it('passe en période de grâce après un échec de paiement sans retirer le plan', async () => {
    const billing = {
      restaurantId: 'test-rest-1',
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_test',
      subscriptionStatus: 'active',
      subscriptionPriceId: 'price_pro_monthly_test',
      subscriptionCurrentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      subscriptionCancelAtPeriodEnd: true,
      lastStripeEventCreated: null,
      lastStripeEventId: null,
    };
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(billing as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: 'account_1' } as never);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      accountId: 'account_1',
      entitledSiteCount: 3,
    } as never);

    const handled = await handleBillingWebhook({
      type: 'invoice.payment_failed',
      id: 'evt_invoice_failed_1',
      created: 400,
      data: {
        object: {
          customer: 'cus_test',
          subscription: 'sub_test',
          metadata: {},
          period_end: 1_790_000_000,
          lines: { data: [] },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).not.toHaveBeenCalled();
    expect(db.restaurantAccountBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'account_1' },
        create: expect.objectContaining({
          subscriptionStatus: 'past_due',
          entitledSiteCount: 3,
          subscriptionCancelAtPeriodEnd: true,
        }),
        update: expect.objectContaining({
          subscriptionStatus: 'past_due',
          entitledSiteCount: 3,
          subscriptionCancelAtPeriodEnd: true,
        }),
      }),
    );
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId: 'test-rest-1' },
        update: expect.objectContaining({
          subscriptionStatus: 'past_due',
          subscriptionCancelAtPeriodEnd: true,
        }),
      }),
    );
  });

  it('réactive l’abonnement et conserve le quota après invoice.paid', async () => {
    process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY = 'price_multi_site_monthly_test';
    const billing = {
      restaurantId: 'test-rest-1',
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_multi_test',
      subscriptionStatus: 'past_due',
      subscriptionPriceId: 'price_multi_site_monthly_test',
      subscriptionCurrentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      subscriptionCancelAtPeriodEnd: false,
      lastStripeEventCreated: null,
      lastStripeEventId: null,
    };
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(billing as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: 'account_1' } as never);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      accountId: 'account_1',
      entitledSiteCount: 4,
    } as never);

    const handled = await handleBillingWebhook({
      type: 'invoice.paid',
      id: 'evt_invoice_paid_1',
      created: 500,
      data: {
        object: {
          customer: 'cus_test',
          subscription: 'sub_multi_test',
          metadata: { plan: 'multi-site', billing: 'monthly', siteCount: '4' },
          period_end: 1_793_000_000,
          lines: { data: [{ price: { id: 'price_multi_site_monthly_test' } }] },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurant.update).toHaveBeenCalledWith({
      where: { id: 'test-rest-1' },
      data: { plan: 'PREMIUM' },
    });
    expect(db.restaurantAccountBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'account_1' },
        create: expect.objectContaining({
          subscriptionStatus: 'active',
          entitledSiteCount: 4,
          subscriptionPriceId: 'price_multi_site_monthly_test',
        }),
        update: expect.objectContaining({ subscriptionStatus: 'active', entitledSiteCount: 4 }),
      }),
    );
  });

  it('garde la période d’essai sur la facture à 0 € qui ouvre l’essai', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeCustomerId: 'cus_test',
      stripeSubscriptionId: 'sub_trial',
      subscriptionStatus: 'trialing',
      lastStripeEventCreated: null,
      lastStripeEventId: null,
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: null } as never);

    const handled = await handleBillingWebhook({
      type: 'invoice.paid',
      id: 'evt_invoice_trial',
      created: 600,
      data: {
        object: {
          customer: 'cus_test',
          subscription: 'sub_trial',
          billing_reason: 'subscription_create',
          amount_paid: 0,
          metadata: {},
          lines: { data: [{ price: { id: 'price_pro_monthly_test' } }] },
        },
      },
    } as never);

    expect(handled).toBe(true);
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'trialing' }),
      }),
    );
  });
});

describe('billing.service - e-mails de fin d’essai et de coupure', () => {
  const trialStart = 1_792_000_000;
  const trialEnd = trialStart + 14 * 24 * 60 * 60;

  function subscriptionEvent(type: string, overrides: Record<string, unknown> = {}) {
    return {
      type,
      id: `evt_${type}`,
      created: trialEnd - 100,
      data: {
        object: {
          id: 'sub_trial',
          customer: 'cus_test',
          status: 'trialing',
          trial_start: trialStart,
          trial_end: trialEnd,
          cancel_at_period_end: false,
          current_period_end: trialEnd,
          metadata: { restaurantId: 'test-rest-1', plan: 'essential', billing: 'monthly' },
          items: { data: [{ price: { id: 'price_unknown' } }] },
          ...overrides,
        },
      },
    } as never;
  }

  async function addCalls() {
    const { queues } = await import('../../../shared/queue/queues');
    return vi.mocked(queues.billingNotifications.add);
  }

  it('garde la fin d’essai quand Stripe ne la porte plus que sur l’article (API 2025-03+)', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);

    await handleBillingWebhook(
      subscriptionEvent('customer.subscription.created', {
        current_period_end: undefined,
        items: { data: [{ price: { id: 'price_unknown' }, current_period_end: trialEnd }] },
      }),
    );

    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          subscriptionStatus: 'trialing',
          subscriptionCurrentPeriodEnd: new Date(trialEnd * 1000),
        }),
      }),
    );
  });

  it('prend la fin de période de la ligne facturée, pas la date de la facture d’essai', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeSubscriptionId: 'sub_trial',
    } as never);

    await handleBillingWebhook({
      type: 'invoice.paid',
      id: 'evt_trial_invoice',
      created: trialStart,
      data: {
        object: {
          customer: 'cus_test',
          subscription: 'sub_trial',
          billing_reason: 'subscription_create',
          amount_paid: 0,
          metadata: {},
          period_end: trialStart,
          lines: { data: [{ period: { start: trialStart, end: trialEnd } }] },
        },
      },
    } as never);

    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          subscriptionStatus: 'trialing',
          subscriptionCurrentPeriodEnd: new Date(trialEnd * 1000),
        }),
      }),
    );
  });

  it('programme le rappel de fin d’essai à réception de trial_will_end', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const add = await addCalls();
    add.mockClear();

    await handleBillingWebhook(subscriptionEvent('customer.subscription.trial_will_end'));

    expect(add).toHaveBeenCalledWith(
      'trial-ending',
      expect.objectContaining({
        kind: 'trial-ending',
        restaurantId: 'test-rest-1',
        subscriptionId: 'sub_trial',
        trialEndsAt: new Date(trialEnd * 1000).toISOString(),
        since: new Date(trialStart * 1000).toISOString(),
      }),
      { jobId: 'billing-notification_trial-ending_sub_trial' },
    );
  });

  it('prévient de la coupure quand l’essai se termine sans carte', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const add = await addCalls();
    add.mockClear();

    await handleBillingWebhook(
      subscriptionEvent('customer.subscription.deleted', {
        status: 'canceled',
        ended_at: trialEnd + 60,
      }),
    );

    expect(add).toHaveBeenCalledWith(
      'service-suspended',
      expect.objectContaining({ kind: 'service-suspended', endedFromTrial: true }),
      { jobId: 'billing-notification_service-suspended_sub_trial' },
    );
  });

  it('distingue une résiliation après la période d’essai', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const add = await addCalls();
    add.mockClear();

    await handleBillingWebhook(
      subscriptionEvent('customer.subscription.deleted', {
        status: 'canceled',
        ended_at: trialEnd + 60 * 24 * 60 * 60,
      }),
    );

    expect(add).toHaveBeenCalledWith(
      'service-suspended',
      expect.objectContaining({ endedFromTrial: false }),
      expect.anything(),
    );
  });

  it('ne programme rien pour une simple mise à jour d’abonnement', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    const add = await addCalls();
    add.mockClear();

    await handleBillingWebhook(subscriptionEvent('customer.subscription.updated'));

    expect(add).not.toHaveBeenCalled();
  });
});

describe('billing.service - événements Stripe de la même seconde (recette du 21/10)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const second = 1_792_614_589;
  const retrieve = () =>
    (globalThis as Record<string, unknown>).__stripeSubscriptionRetrieve as ReturnType<
      typeof vi.fn
    >;
  const liveActive = {
    id: 'sub_early',
    customer: 'cus_test',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: second + 30 * 24 * 60 * 60,
    trial_start: second - 3 * 24 * 60 * 60,
    trial_end: second,
    metadata: { restaurantId: 'test-rest-1', plan: 'essential', billing: 'monthly' },
    items: { data: [{ price: { id: 'price_unknown' } }] },
  };

  function subscriptionEvent(type: string, id: string, object: Record<string, unknown>) {
    return { type, id, created: second, data: { object } } as never;
  }

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurantBilling.findUnique).mockReset();
    vi.mocked(db.restaurantBilling.upsert).mockReset();
    vi.mocked(db.restaurantBilling.update).mockReset();
    vi.mocked(db.restaurantBilling.findMany).mockReset();
    vi.mocked(db.restaurantAccountBilling.upsert).mockReset();
    vi.mocked(db.restaurant.findUnique).mockReset();
    retrieve().mockReset();
  });

  it("le rappel de fin d'essai ne réécrit jamais l'état de l'abonnement", async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      subscriptionStatus: 'active',
      lastStripeEventCreated: second,
      lastStripeEventId: 'evt_1UT68wHCZZuqZF0hDLiJAoDJ',
    } as never);

    const handled = await handleBillingWebhook(
      subscriptionEvent('customer.subscription.trial_will_end', 'evt_1UT68wHCZZuqZF0hKxDl5v5o', {
        ...liveActive,
        status: 'trialing',
        trial_end: second + 3 * 24 * 60 * 60,
      }),
    );

    expect(handled).toBe(true);
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
    expect(db.restaurantAccountBilling.upsert).not.toHaveBeenCalled();
    expect(db.restaurant.update).not.toHaveBeenCalled();
    const { queues } = await import('../../../shared/queue/queues');
    expect(queues.billingNotifications.add).toHaveBeenCalledWith(
      'trial-ending',
      expect.objectContaining({ kind: 'trial-ending', subscriptionId: 'sub_early' }),
      expect.anything(),
    );
  });

  it("à la même seconde, l'activation n'est plus écartée par l'ordre alphabétique des identifiants", async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    // Un instantané « essai » déjà appliqué porte un identifiant plus grand que l'activation.
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      subscriptionStatus: 'trialing',
      lastStripeEventCreated: second,
      lastStripeEventId: 'evt_1UT68wHCZZuqZF0hKxDl5v5o',
    } as never);
    retrieve().mockResolvedValue(liveActive);

    await handleBillingWebhook(
      subscriptionEvent(
        'customer.subscription.updated',
        'evt_1UT68wHCZZuqZF0hDLiJAoDJ',
        liveActive,
      ),
    );

    expect(retrieve()).toHaveBeenCalledWith('sub_early');
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'active' }),
      }),
    );
  });

  it("à la même seconde, un instantané d'événement ancien cède à l'état actuel chez Stripe", async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      subscriptionStatus: 'active',
      lastStripeEventCreated: second,
      lastStripeEventId: 'evt_A',
    } as never);
    retrieve().mockResolvedValue(liveActive);

    await handleBillingWebhook(
      subscriptionEvent('customer.subscription.updated', 'evt_Z', {
        ...liveActive,
        status: 'trialing',
      }),
    );

    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'active' }),
      }),
    );
  });

  it("à la même seconde, une facture reprend le statut actuel de l'abonnement", async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeSubscriptionId: 'sub_early',
      subscriptionStatus: 'canceled',
      lastStripeEventCreated: second,
      lastStripeEventId: 'evt_Z',
    } as never);
    retrieve().mockResolvedValue({ ...liveActive, status: 'canceled' });

    await handleBillingWebhook({
      type: 'invoice.payment_failed',
      id: 'evt_A',
      created: second,
      data: {
        object: {
          customer: 'cus_test',
          subscription: 'sub_early',
          billing_reason: 'subscription_cycle',
          amount_paid: 0,
          metadata: {},
          lines: { data: [] },
        },
      },
    } as never);

    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'canceled' }),
      }),
    );
  });

  it('à la même seconde, une lecture Stripe impossible fait échouer le webhook pour qu’il soit relivré', async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      lastStripeEventCreated: second,
      lastStripeEventId: 'evt_A',
    } as never);
    retrieve().mockRejectedValue(new Error('stripe unavailable'));

    await expect(
      handleBillingWebhook(subscriptionEvent('customer.subscription.updated', 'evt_B', liveActive)),
    ).rejects.toThrow('stripe unavailable');
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
    expect(db.stripeWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it("un événement plus récent s'applique sans relire Stripe", async () => {
    vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      lastStripeEventCreated: second - 10,
      lastStripeEventId: 'evt_Z',
    } as never);

    await handleBillingWebhook(
      subscriptionEvent('customer.subscription.updated', 'evt_A', liveActive),
    );

    expect(retrieve()).not.toHaveBeenCalled();
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'active' }),
      }),
    );
  });
});

describe('billing.service - réparation des dossiers décalés', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const retrieve = () =>
    (globalThis as Record<string, unknown>).__stripeSubscriptionRetrieve as ReturnType<
      typeof vi.fn
    >;
  const stored = {
    restaurantId: 'test-rest-1',
    stripeSubscriptionId: 'sub_early',
    subscriptionStatus: 'trialing',
    lastStripeEventCreated: 1_792_614_589,
    lastStripeEventId: 'evt_1UT68wHCZZuqZF0hKxDl5v5o',
  };
  const live = {
    id: 'sub_early',
    customer: 'cus_test',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1_795_000_000,
    metadata: { restaurantId: 'test-rest-1', plan: 'essential' },
    items: { data: [{ price: { id: 'price_unknown' } }] },
  };

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurantBilling.findMany).mockReset();
    vi.mocked(db.restaurantBilling.upsert).mockReset();
    vi.mocked(db.restaurantAccountBilling.upsert).mockReset();
    vi.mocked(db.restaurant.findUnique).mockReset();
    retrieve().mockReset();
  });

  it("par défaut, liste l'écart sans rien écrire", async () => {
    vi.mocked(db.restaurantBilling.findMany).mockResolvedValue([stored] as never);
    retrieve().mockResolvedValue(live);

    const result = await reconcileBillingFromStripe({ apply: false });

    expect(result).toEqual([
      expect.objectContaining({
        restaurantId: 'test-rest-1',
        storedStatus: 'trialing',
        liveStatus: 'active',
        changed: true,
        applied: false,
      }),
    ]);
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
    expect(db.restaurantAccountBilling.upsert).not.toHaveBeenCalled();
  });

  it("avec apply, projette l'état Stripe sans avancer le checkpoint", async () => {
    vi.mocked(db.restaurantBilling.findMany).mockResolvedValue([stored] as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ accountId: 'account_1' } as never);
    retrieve().mockResolvedValue(live);

    const result = await reconcileBillingFromStripe({ apply: true });

    expect(result[0]).toEqual(expect.objectContaining({ changed: true, applied: true }));
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          subscriptionStatus: 'active',
          lastStripeEventCreated: stored.lastStripeEventCreated,
          lastStripeEventId: stored.lastStripeEventId,
        }),
      }),
    );
    expect(db.restaurantAccountBilling.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ subscriptionStatus: 'active' }),
      }),
    );
  });

  it('ne touche pas un dossier déjà aligné', async () => {
    vi.mocked(db.restaurantBilling.findMany).mockResolvedValue([
      { ...stored, subscriptionStatus: 'active' },
    ] as never);
    retrieve().mockResolvedValue(live);

    const result = await reconcileBillingFromStripe({ apply: true });

    expect(result[0]).toEqual(expect.objectContaining({ changed: false, applied: false }));
    expect(db.restaurantBilling.upsert).not.toHaveBeenCalled();
  });
});
