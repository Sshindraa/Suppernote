import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { buildCheckoutIdempotencyKey } from '../billing.service';

const clerkOrganization = vi.hoisted(() => vi.fn());
const clerkUser = vi.hoisted(() => vi.fn());
vi.mock('@clerk/fastify', () => ({
  clerkClient: {
    organizations: { getOrganization: clerkOrganization },
    users: { getUser: clerkUser },
  },
}));

const originalEnv = {
  secret: process.env.STRIPE_SECRET_KEY,
  price: process.env.STRIPE_PRICE_PRO_MONTHLY,
  annualPrice: process.env.STRIPE_PRICE_PRO_ANNUAL,
  multiSitePrice: process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY,
  multiSiteAddonPrice: process.env.STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY,
};

describe('billing.routes - checkout, portail et statut', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findFirst).mockReset();
    vi.mocked(db.restaurantAccountBilling.findUnique).mockReset();
    vi.mocked(db.restaurantBilling.findUnique).mockReset();
    vi.mocked(db.restaurantAccountMembership.findFirst).mockReset();
    clerkUser.mockReset();
    process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    delete process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY;
    delete process.env.STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY;
  });

  afterEach(() => {
    if (originalEnv.secret === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = originalEnv.secret;
    if (originalEnv.price === undefined) delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    else process.env.STRIPE_PRICE_PRO_MONTHLY = originalEnv.price;
    if (originalEnv.annualPrice === undefined) delete process.env.STRIPE_PRICE_PRO_ANNUAL;
    else process.env.STRIPE_PRICE_PRO_ANNUAL = originalEnv.annualPrice;
    if (originalEnv.multiSitePrice === undefined)
      delete process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY;
    else process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY = originalEnv.multiSitePrice;
    if (originalEnv.multiSiteAddonPrice === undefined)
      delete process.env.STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY;
    else process.env.STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY = originalEnv.multiSiteAddonPrice;
  });

  afterAll(async () => {
    await closeApp();
  });

  it('refuse une requête sans authentification', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('expose le statut d’abonnement sans divulguer les identifiants Stripe', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'PRO',
      accountId: 'test-account-1',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurant.findFirst).mockResolvedValue({
      id: 'test-rest-1',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findFirst>>);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      accountId: 'test-account-1',
      stripeCustomerId: 'cus_private',
      stripeSubscriptionId: 'sub_private',
      subscriptionStatus: 'past_due',
      subscriptionPriceId: 'price_pro_monthly_test',
      entitledSiteCount: 1,
      subscriptionCurrentPeriodEnd: new Date('2026-10-01T00:00:00.000Z'),
      subscriptionCancelAtPeriodEnd: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantAccountBilling.findUnique>>);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/billing/status',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plan: 'pro',
      subscriptionStatus: 'past_due',
      billingInterval: 'monthly',
      currentPeriodEnd: '2026-10-01T00:00:00.000Z',
      cancelAtPeriodEnd: true,
      entitledSiteCount: 1,
      accountScoped: true,
      suspended: false,
    });
    expect(JSON.stringify(response.json())).not.toContain('cus_private');
    expect(JSON.stringify(response.json())).not.toContain('sub_private');
  });

  it('valide strictement le plan et la cadence', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'starter', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('retourne une erreur explicite si le prix Stripe n’est pas configuré', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      error: 'BILLING_NOT_CONFIGURED',
      message: 'La souscription en ligne sera bientôt disponible.',
    });
  });

  it('réserve la facturation du compte au propriétaire', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test', 'x-test-site-role': 'STAFF' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: 'BILLING_OWNER_REQUIRED',
      message: 'Seul le propriétaire du compte peut gérer la facturation.',
    });
  });

  it('refuse les actions de facturation à un membre historique non vérifié', async () => {
    clerkOrganization.mockResolvedValue({ createdBy: 'another-user' });
    const app = await getApp();
    for (const [url, payload] of [
      ['/billing/checkout-session', { plan: 'pro', billing: 'monthly' }],
      ['/billing/trial', {}],
      ['/billing/portal-session', {}],
    ] as const) {
      const response = await app.inject({
        method: 'POST',
        url,
        payload,
        headers: {
          authorization: 'Bearer test',
          'x-test-legacy': '1',
          'x-test-site-role': 'ORG_MEMBER',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error).toBe('BILLING_OWNER_REQUIRED');
    }
  });

  it('permet au créateur vérifié d’accéder à la facturation historique', async () => {
    clerkOrganization.mockResolvedValue({ createdBy: 'test-user-1' });
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/trial',
      payload: {},
      headers: {
        authorization: 'Bearer test',
        'x-test-legacy': '1',
        'x-test-site-role': 'ORG_MEMBER',
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe('BILLING_NOT_CONFIGURED');
  });

  it('ouvre le portail Stripe pour le propriétaire', async () => {
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      accountId: 'test-account-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      accountId: 'test-account-1',
      stripeCustomerId: 'cus_account',
    } as unknown as Awaited<ReturnType<typeof db.restaurantAccountBilling.findUnique>>);
    vi.mocked(db.restaurant.findFirst).mockResolvedValue(null);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ url: 'https://billing.stripe.test/portal' });
    const portalCreate = (
      globalThis as unknown as {
        __stripeBillingPortalSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeBillingPortalSessionCreate;
    expect(portalCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({ customer: 'cus_account' }),
    );
  });

  it('refuse le portail quand aucun client Stripe n’est lié', async () => {
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      accountId: null,
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'BILLING_CUSTOMER_NOT_FOUND',
      message: 'Aucune souscription Stripe active pour ce compte.',
    });
  });

  it('crée une session Checkout hébergée pour le restaurant authentifié', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: 'cs_test',
      url: 'https://checkout.stripe.test/cs_test',
    });
    expect(db.restaurantBilling.upsert).toHaveBeenCalledWith({
      where: { restaurantId: 'test-rest-1' },
      create: { restaurantId: 'test-rest-1', stripeCustomerId: 'cus_test' },
      update: { stripeCustomerId: 'cus_test' },
    });
    const customerCreate = (
      globalThis as unknown as { __stripeCustomerCreate: { mock: { calls: unknown[][] } } }
    ).__stripeCustomerCreate;
    expect(customerCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        email: 'manager@example.com',
        invoice_settings: { footer: 'TVA non applicable, art. 293 B du CGI' },
      }),
    );
  });

  it('met à jour l’e-mail Stripe du propriétaire et invalide son ancien Checkout', async () => {
    const stripe = globalThis as unknown as {
      __stripeCheckoutSessionExpire: ReturnType<typeof vi.fn>;
      __stripeCheckoutSessionList: ReturnType<typeof vi.fn>;
      __stripeCustomerUpdate: ReturnType<typeof vi.fn>;
      __stripeRead: { customer: ReturnType<typeof vi.fn> };
    };
    stripe.__stripeRead.customer.mockResolvedValueOnce({
      id: 'cus_test',
      email: 'demo@sokar.com',
    });
    stripe.__stripeCustomerUpdate.mockResolvedValueOnce({
      id: 'cus_test',
      email: 'owner@example.com',
    });
    stripe.__stripeCheckoutSessionList.mockResolvedValueOnce({
      data: [{ id: 'cs_old', mode: 'subscription', url: 'https://checkout.stripe.test/cs_old' }],
      has_more: false,
    });
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      accountId: 'test-account-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeCustomerId: 'cus_test',
      checkoutIdempotencyKey: 'previous-attempt',
      checkoutSessionId: 'cs_old',
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);
    vi.mocked(db.restaurantAccountMembership.findFirst).mockResolvedValue({
      clerkUserId: 'owner-user',
    } as never);
    clerkUser.mockResolvedValue({
      primaryEmailAddressId: 'owner-email',
      emailAddresses: [
        {
          id: 'owner-email',
          emailAddress: 'owner@example.com',
          verification: { status: 'verified' },
        },
      ],
    });
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(200);
    expect(stripe.__stripeCustomerUpdate).toHaveBeenCalledWith('cus_test', {
      email: 'owner@example.com',
    });
    expect(stripe.__stripeCheckoutSessionExpire).toHaveBeenCalledWith('cs_old');
  });

  describe('retour vers l’inscription (returnTo)', () => {
    type CheckoutCreate = { mock: { calls: unknown[][] } };
    const checkoutCreate = () =>
      (globalThis as unknown as { __stripeCheckoutSessionCreate: CheckoutCreate })
        .__stripeCheckoutSessionCreate;

    async function checkout(payload: Record<string, unknown>) {
      process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: 'test-rest-1',
        name: 'Bistrot du Coin',
        managerEmail: 'manager@example.com',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);
      const app = await getApp();
      return app.inject({
        method: 'POST',
        url: '/billing/checkout-session',
        headers: { authorization: 'Bearer test' },
        payload: { plan: 'pro', billing: 'monthly', ...payload },
      });
    }

    it('ramène vers l’inscription, pas vers les Réglages qui sont derrière la barrière', async () => {
      const response = await checkout({ returnTo: 'onboarding' });

      expect(response.statusCode).toBe(200);
      const params = checkoutCreate().mock.calls.at(-1)?.[0] as {
        success_url: string;
        cancel_url: string;
      };
      expect(params.success_url).toMatch(/\/onboarding\?step=canaux&billing=success&session_id=/);
      expect(params.success_url).not.toContain('/dashboard/settings');
      expect(params.cancel_url).toMatch(/\/onboarding\?step=formule&billing=cancelled$/);
    });

    it('sans returnTo, les adresses de retour restent celles d’avant', async () => {
      const response = await checkout({});

      expect(response.statusCode).toBe(200);
      const params = checkoutCreate().mock.calls.at(-1)?.[0] as {
        success_url: string;
        cancel_url: string;
      };
      expect(params.success_url).toMatch(/\/dashboard\/settings\?billing=success&session_id=/);
      expect(params.cancel_url).toMatch(/\/pricing\?billing=cancelled$/);
    });

    it('refuse une valeur de retour inconnue', async () => {
      expect((await checkout({ returnTo: 'https://exemple.test' })).statusCode).toBe(400);
    });

    it('ne réutilise pas une session créée avec d’autres adresses de retour', () => {
      const base = {
        restaurantId: 'test-rest-1',
        plan: 'pro' as const,
        billing: 'monthly' as const,
        siteCount: 1,
        idempotencyKey: 'fixe',
      };
      const settings = buildCheckoutIdempotencyKey(base);
      expect(buildCheckoutIdempotencyKey({ ...base, returnTo: 'settings' })).toBe(settings);
      expect(buildCheckoutIdempotencyKey({ ...base, returnTo: 'onboarding' })).not.toBe(settings);
    });
  });

  it('sélectionne le prix annuel et transmet la cadence à Stripe', async () => {
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-annual',
      name: 'Bistrot Annuel',
      managerEmail: 'annual@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'annual' },
    });

    expect(response.statusCode).toBe(200);
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    expect(checkoutCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        line_items: [{ price: 'price_pro_annual_test', quantity: 1 }],
        metadata: expect.objectContaining({ billing: 'annual' }),
        subscription_data: expect.objectContaining({
          metadata: expect.objectContaining({ billing: 'annual' }),
        }),
      }),
    );
  });

  it('offre 14 jours d’essai sans carte sur un premier abonnement', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-trial',
      name: 'Bistrot Essai',
      managerEmail: 'essai@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(200);
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    expect(checkoutCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        payment_method_collection: 'if_required',
        subscription_data: expect.objectContaining({
          trial_period_days: 14,
          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
        }),
      }),
    );
  });

  it('ne réoffre pas d’essai à un compte qui a déjà eu un abonnement', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-returning',
      name: 'Bistrot de Retour',
      managerEmail: 'retour@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-returning',
      stripeCustomerId: 'cus_returning',
      stripeSubscriptionId: 'sub_ended',
      subscriptionStatus: 'canceled',
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(200);
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    const params = checkoutCreate.mock.calls.at(-1)?.[0] as {
      payment_method_collection?: string;
      subscription_data: Record<string, unknown>;
    };
    expect(params.payment_method_collection).toBeUndefined();
    expect(params.subscription_data.trial_period_days).toBeUndefined();
  });

  it('signale un compte suspendu après la fin de son abonnement', async () => {
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'STARTER',
      accountId: null,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeSubscriptionId: 'sub_ended',
      subscriptionStatus: 'canceled',
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/billing/status',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(
      expect.objectContaining({ subscriptionStatus: 'canceled', suspended: true }),
    );
  });

  it('expose le déroulé et le bilan de l’essai', async () => {
    const endsAt = new Date(Date.now() + 9 * 24 * 60 * 60 * 1000 - 60_000);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'STARTER',
      accountId: null,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeSubscriptionId: 'sub_trial',
      subscriptionStatus: 'trialing',
      subscriptionCurrentPeriodEnd: endsAt,
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);
    vi.mocked(db.call.count).mockResolvedValueOnce(47);
    (db.reservation as unknown as { aggregate: unknown }).aggregate = vi
      .fn()
      .mockResolvedValue({ _count: { _all: 18 }, _sum: { partySize: 52 } });
    vi.mocked(db.reservation.count).mockResolvedValueOnce(15);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/billing/status',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().trial).toEqual({
      startedAt: new Date(endsAt.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString(),
      endsAt: endsAt.toISOString(),
      totalDays: 14,
      daysLeft: 9,
      recap: { calls: 47, reservations: 18, covers: 52, phoneReservations: 15 },
    });
  });

  describe('POST /billing/trial (« Plus tard » de l’onboarding)', () => {
    type CreateMock = { mock: { calls: unknown[][] } };
    const subscriptionCreate = () =>
      (globalThis as unknown as { __stripeSubscriptionCreate: CreateMock })
        .__stripeSubscriptionCreate;

    beforeEach(() => {
      process.env.STRIPE_PRICE_ESSENTIAL_MONTHLY = 'price_essential_monthly_test';
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: 'test-rest-1',
        name: 'Bistrot du Coin',
        managerEmail: 'manager@example.com',
        accountId: null,
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    });

    it('démarre 14 jours d’essai sur Essential, sans carte ni Checkout', async () => {
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/billing/trial',
        headers: { authorization: 'Bearer test' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'trialing',
        trialEndsAt: new Date((1_792_000_000 + 14 * 24 * 60 * 60) * 1000).toISOString(),
      });
      expect(subscriptionCreate().mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          customer: 'cus_test',
          items: [{ price: 'price_essential_monthly_test' }],
          trial_period_days: 14,
          trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
          metadata: expect.objectContaining({
            restaurantId: 'test-rest-1',
            plan: 'essential',
            trial: 'true',
          }),
        }),
      );
      expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { restaurantId: 'test-rest-1' },
          update: expect.objectContaining({
            stripeSubscriptionId: 'sub_trial_test',
            subscriptionStatus: 'trialing',
          }),
        }),
      );
    });

    it('démarre l’essai sur la formule et la cadence choisies', async () => {
      process.env.STRIPE_PRICE_MULTI_SITE_ANNUAL = 'price_multi_annual_test';
      process.env.STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL = 'price_addon_annual_test';
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/billing/trial',
        headers: { authorization: 'Bearer test' },
        payload: { plan: 'multi-site', billing: 'annual', siteCount: 3 },
      });

      expect(response.statusCode).toBe(200);
      expect(subscriptionCreate().mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          items: [
            { price: 'price_multi_annual_test' },
            { price: 'price_addon_annual_test', quantity: 2 },
          ],
          metadata: expect.objectContaining({
            plan: 'multi-site',
            billing: 'annual',
            siteCount: '3',
          }),
        }),
      );
    });

    it('refuse un second essai sur le même compte', async () => {
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
        restaurantId: 'test-rest-1',
        stripeCustomerId: 'cus_old',
        stripeSubscriptionId: 'sub_ended',
        subscriptionStatus: 'canceled',
      } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/billing/trial',
        headers: { authorization: 'Bearer test' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('BILLING_TRIAL_ALREADY_USED');
    });

    it('refuse quand un abonnement est déjà en cours', async () => {
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
        restaurantId: 'test-rest-1',
        stripeCustomerId: 'cus_now',
        stripeSubscriptionId: 'sub_now',
        subscriptionStatus: 'trialing',
      } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/billing/trial',
        headers: { authorization: 'Bearer test' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toBe('BILLING_ALREADY_SUBSCRIBED');
    });
  });

  it('ne suspend pas un compte qui n’a jamais eu d’abonnement', async () => {
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      plan: 'STARTER',
      accountId: null,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/billing/status',
      headers: { authorization: 'Bearer test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ suspended: false }));
  });

  it('ancre le Checkout secondaire sur le compte et le site principal', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'secondary-site',
      accountId: 'account-1',
      name: 'Site secondaire',
      managerEmail: 'secondary@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurant.findFirst).mockResolvedValue({
      id: 'primary-site',
      accountId: 'account-1',
      name: 'Site principal',
      managerEmail: 'owner@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findFirst>>);
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      accountId: 'account-1',
      stripeCustomerId: 'cus_account',
      stripeSubscriptionId: null,
      subscriptionStatus: null,
    } as unknown as Awaited<ReturnType<typeof db.restaurantAccountBilling.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(200);
    expect(db.restaurantBilling.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { restaurantId: 'primary-site' } }),
    );
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    expect(checkoutCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        customer: 'cus_account',
        client_reference_id: 'secondary-site',
        metadata: expect.objectContaining({ accountId: 'account-1' }),
      }),
    );
  });

  it('réutilise la session Checkout lors d’un retry avec la même clé d’idempotence', async () => {
    const sessionList = (
      globalThis as unknown as {
        __stripeCheckoutSessionList: ReturnType<typeof vi.fn>;
      }
    ).__stripeCheckoutSessionList;
    sessionList.mockResolvedValueOnce({ data: [], has_more: false }).mockResolvedValueOnce({
      data: [{ id: 'cs_test', mode: 'subscription', url: 'https://checkout.stripe.test/cs_test' }],
      has_more: false,
    });
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        restaurantId: 'test-rest-1',
        stripeCustomerId: 'cus_test',
        checkoutIdempotencyKey: buildCheckoutIdempotencyKey({
          restaurantId: 'test-rest-1',
          scopeId: 'test-account-1',
          plan: 'pro',
          billing: 'monthly',
          siteCount: 1,
          idempotencyKey: 'checkout-retry-1',
        }),
        checkoutSessionId: 'cs_test',
        checkoutSessionUrl: 'https://checkout.stripe.test/cs_test',
      } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;

    const app = await getApp();
    const headers = {
      authorization: 'Bearer test',
      'idempotency-key': 'checkout-retry-1',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers,
      payload: { plan: 'pro', billing: 'monthly' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers,
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(checkoutCreate.mock.calls).toHaveLength(1);
  });

  it('bloque une seconde souscription qui pourrait facturer deux fois', async () => {
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
      restaurantId: 'test-rest-1',
      stripeSubscriptionId: 'sub_existing',
      subscriptionStatus: 'active',
    } as unknown as Awaited<ReturnType<typeof db.restaurantBilling.findUnique>>);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'pro', billing: 'monthly' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'BILLING_ALREADY_SUBSCRIBED',
      message: 'Une souscription est déjà active pour ce restaurant.',
    });
  });

  it('facture un établissement Multi-restaurant sans ligne supplémentaire ni prix addon', async () => {
    process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY = 'price_multi_site_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Restaurant',
      managerEmail: 'manager@example.com',
    } as never);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'multi-site', billing: 'monthly', siteCount: 1 },
    });
    expect(response.statusCode).toBe(200);
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    expect(checkoutCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        line_items: [{ price: 'price_multi_site_monthly_test', quantity: 1 }],
        metadata: expect.objectContaining({ siteCount: '1' }),
      }),
    );
  });

  it('facture la base et les établissements supplémentaires du Multi-restaurant', async () => {
    process.env.STRIPE_PRICE_MULTI_SITE_MONTHLY = 'price_multi_site_monthly_test';
    process.env.STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY = 'price_multi_site_addon_monthly_test';
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'test-rest-1',
      name: 'Bistrot du Coin',
      managerEmail: 'manager@example.com',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout-session',
      headers: { authorization: 'Bearer test' },
      payload: { plan: 'multi-site', billing: 'monthly', siteCount: 3 },
    });

    expect(response.statusCode).toBe(200);
    const checkoutCreate = (
      globalThis as unknown as {
        __stripeCheckoutSessionCreate: { mock: { calls: unknown[][] } };
      }
    ).__stripeCheckoutSessionCreate;
    expect(checkoutCreate.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        line_items: [
          { price: 'price_multi_site_monthly_test', quantity: 1 },
          { price: 'price_multi_site_addon_monthly_test', quantity: 2 },
        ],
        metadata: expect.objectContaining({ siteCount: '3' }),
      }),
    );
  });
});
