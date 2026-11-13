/**
 * Tests for the Stripe gift-card service.
 *
 * setup.ts mocke le module `stripe.service` avec des vi.fn()s. On le
 * démocke pour exécuter la vraie implémentation, qui s'appuie sur le
 * mock du SDK Stripe (également défini dans setup.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../stripe.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual };
});

const sdk = vi.hoisted(() => ({
  create: vi.fn(),
  retrieve: vi.fn(),
  refundCreate: vi.fn(),
  refundRetrieve: vi.fn(),
  refundList: vi.fn(),
  rawRequest: vi.fn(),
  accountRetrieve: vi.fn(),
  accountLinkCreate: vi.fn(),
  accountSessionCreate: vi.fn(),
  customerCreate: vi.fn(),
  checkoutSessionCreate: vi.fn(),
}));

vi.mock('stripe', () => {
  let shouldThrow = false;

  class StripeCardError extends Error {
    constructor(
      readonly raw: unknown,
      readonly code?: string,
      readonly decline_code?: string,
    ) {
      super('card error');
    }
  }

  class Stripe {
    static errors = { StripeCardError };
    customers = { create: sdk.customerCreate };
    checkout = { sessions: { create: sdk.checkoutSessionCreate } };
    rawRequest = sdk.rawRequest;
    accounts = { retrieve: sdk.accountRetrieve };
    accountLinks = { create: sdk.accountLinkCreate };
    accountSessions = { create: sdk.accountSessionCreate };
    paymentIntents = {
      create: sdk.create.mockResolvedValue({ id: 'pi_test', client_secret: 'pi_t_s' }),
      retrieve: sdk.retrieve.mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 10000,
        amount_received: 10000,
        application_fee_amount: 500,
        currency: 'eur',
        metadata: { restaurantId: 'rest-1', amount: '100' },
      }),
    };
    refunds = {
      create: sdk.refundCreate.mockResolvedValue({
        id: 're_test',
        amount: 2500,
        status: 'succeeded',
      }),
      retrieve: sdk.refundRetrieve,
      list: sdk.refundList.mockResolvedValue({ data: [], has_more: false }),
    };
    webhooks = {
      constructEvent: vi.fn().mockImplementation(() => {
        if (shouldThrow) {
          throw new Error('invalid signature');
        }
        return {
          type: 'payment_intent.succeeded',
          data: { object: { id: 'pi_test', status: 'succeeded' } },
        };
      }),
    };

    static setWebhookShouldThrow(value: boolean) {
      shouldThrow = value;
    }
  }

  return {
    default: Stripe,
    __StripeCardError: StripeCardError,
    __setWebhookShouldThrow: (value: boolean) => {
      shouldThrow = value;
    },
  };
});

import Stripe from 'stripe';
import {
  createPaymentIntent,
  retrievePaymentIntent,
  constructWebhookEvent,
  createRefund,
  chargeReservationGuarantee,
  createReservationGuaranteeSetupSession,
  createConnectedAccountSession,
  managedConnectTestEnabled,
  createManagedTestAccount,
  configureManagedTestAccount,
} from '../stripe.service';

describe('stripe.service', () => {
  it('restricts managed onboarding to an allowlisted restaurant and Stripe test keys', async () => {
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_ENABLED', 'true');
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS', 'rest-1');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
    try {
      expect(managedConnectTestEnabled('rest-1')).toBe(true);
      expect(managedConnectTestEnabled('rest-2')).toBe(false);
      vi.stubEnv('STRIPE_SECRET_KEY', 'sk_live_example');
      expect(managedConnectTestEnabled('rest-1')).toBe(false);
      await expect(createManagedTestAccount('rest-1')).rejects.toThrow('indisponible');
      expect(sdk.rawRequest).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('resumes a configured test account without consuming the token twice', async () => {
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_ENABLED', 'true');
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS', 'rest-1');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
    sdk.rawRequest.mockResolvedValue({
      livemode: false,
      metadata: { restaurantId: 'rest-1', source: 'sokar_managed_test' },
      applied_configurations: ['merchant'],
    });
    try {
      await configureManagedTestAccount('rest-1', 'acct_test', 'accttok_test');
      expect(sdk.rawRequest).toHaveBeenCalledTimes(1);
      expect(sdk.rawRequest).toHaveBeenCalledWith(
        'GET',
        '/v2/core/accounts/acct_test',
        undefined,
        expect.any(Object),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses a pending account belonging to another restaurant', async () => {
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_ENABLED', 'true');
    vi.stubEnv('STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS', 'rest-1');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test_example');
    sdk.rawRequest.mockResolvedValue({
      livemode: false,
      metadata: { restaurantId: 'other', source: 'sokar_managed_test' },
      applied_configurations: [],
    });
    try {
      await expect(
        configureManagedTestAccount('rest-1', 'acct_test', 'accttok_test'),
      ).rejects.toThrow('incompatible');
      expect(sdk.rawRequest).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('grants an onboarding-only session without disabling Stripe authentication', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', 'pk_test');
    sdk.accountSessionCreate.mockResolvedValue({ client_secret: 'mock' });
    try {
      expect(await createConnectedAccountSession('acct_existing')).toEqual({
        clientSecret: 'mock',
        publishableKey: 'pk_test',
      });
      expect(sdk.accountSessionCreate).toHaveBeenCalledWith({
        account: 'acct_existing',
        components: { account_onboarding: { enabled: true } },
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('does not open a session without a configured public key', async () => {
    vi.stubEnv('STRIPE_PUBLISHABLE_KEY', '');
    try {
      await expect(createConnectedAccountSession('acct_existing')).rejects.toThrow('clé publique');
      expect(sdk.accountSessionCreate).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    (
      Stripe as unknown as { setWebhookShouldThrow?: (value: boolean) => void }
    ).setWebhookShouldThrow?.(false);
  });

  function setWebhookSecret(value: string | undefined) {
    const envKey = 'STRIPE_WEBHOOK_SECRET';
    if (value === undefined) {
      delete process.env[envKey];
    } else {
      process.env[envKey] = value;
    }
  }

  describe('createPaymentIntent', () => {
    it('crée un payment intent et retourne id + clientSecret', async () => {
      const result = await createPaymentIntent({
        amount: 10000,
        currency: 'eur',
        metadata: { restaurantId: 'rest-1' },
      });

      expect(result.id).toBe('pi_test');
      expect(result.clientSecret).toBe('pi_t_s');
    });
  });

  describe('retrievePaymentIntent', () => {
    it("récupère le statut d'un payment intent", async () => {
      const result = await retrievePaymentIntent('pi_test');

      expect(result.id).toBe('pi_test');
      expect(result.status).toBe('succeeded');
      expect(result.amount).toBe(10000);
      expect(result.amountReceived).toBe(10000);
      expect(result.currency).toBe('eur');
      expect(result.metadata.restaurantId).toBe('rest-1');
    });
  });

  describe('constructWebhookEvent', () => {
    it('construit et vérifie un event Stripe depuis le webhook', async () => {
      const event = await constructWebhookEvent('raw-payload', 't=signature');

      expect(event.type).toBe('payment_intent.succeeded');
    });

    it('retourne erreur si STRIPE_WEBHOOK_SECRET est manquant', async () => {
      const previous = process.env.STRIPE_WEBHOOK_SECRET;
      setWebhookSecret(undefined);
      try {
        await expect(constructWebhookEvent('raw-payload', 't=signature')).rejects.toThrow(
          'STRIPE_WEBHOOK_SECRET is required',
        );
      } finally {
        setWebhookSecret(previous);
      }
    });

    it('fonctionne avec plusieurs secrets webhook séparés par des virgules', async () => {
      const previous = process.env.STRIPE_WEBHOOK_SECRET;
      setWebhookSecret('whsec_a,whsec_b');
      try {
        const event = await constructWebhookEvent('raw-payload', 't=signature');
        expect(event.type).toBe('payment_intent.succeeded');
      } finally {
        setWebhookSecret(previous);
      }
    });

    it('retourne erreur quand tous les secrets de la liste échouent', async () => {
      const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
      setWebhookSecret('whsec_a,whsec_b');
      (
        Stripe as unknown as { setWebhookShouldThrow?: (value: boolean) => void }
      ).setWebhookShouldThrow?.(true);
      try {
        await expect(constructWebhookEvent('raw-payload', 't=signature')).rejects.toThrow(
          'invalid signature',
        );
      } finally {
        setWebhookSecret(previousSecret);
        (
          Stripe as unknown as { setWebhookShouldThrow?: (value: boolean) => void }
        ).setWebhookShouldThrow?.(false);
      }
    });
  });
  it('creates direct charges on the restaurant account with the platform fee and a stable key', async () => {
    await createPaymentIntent({
      amount: 10000,
      currency: 'eur',
      metadata: { checkoutId: 'checkout' },
      stripeAccountId: 'acct_restaurant',
      applicationFeeAmount: 500,
      idempotencyKey: 'checkout-key',
    });
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 10000, application_fee_amount: 500 }),
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'checkout-key' },
    );
  });

  it('retrieves payment state inside the correct connected account', async () => {
    await retrievePaymentIntent('pi_test', 'acct_restaurant');
    expect(sdk.retrieve).toHaveBeenCalledWith(
      'pi_test',
      { expand: ['latest_charge'] },
      { stripeAccount: 'acct_restaurant' },
    );
  });

  it('refunds the restaurant charge and its application fee with the same retry key', async () => {
    await createRefund({
      paymentIntentId: 'pi_test',
      amount: 2500,
      stripeAccountId: 'acct_restaurant',
      idempotencyKey: 'refund-key',
    });
    expect(sdk.refundCreate).toHaveBeenCalledWith(
      { payment_intent: 'pi_test', amount: 2500, refund_application_fee: true },
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'refund-key' },
    );
  });
  it('does not request an application fee refund when the restaurant charge had no fee', async () => {
    sdk.retrieve.mockResolvedValueOnce({ application_fee_amount: null });
    await createRefund({
      paymentIntentId: 'pi_zero_fee',
      amount: 2500,
      stripeAccountId: 'acct_restaurant',
      idempotencyKey: 'refund-no-fee',
    });
    expect(sdk.refundCreate).toHaveBeenCalledWith(
      expect.objectContaining({ refund_application_fee: false }),
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'refund-no-fee' },
    );
  });
});

describe('Stripe Connect account creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a French merchant with Accounts v2 and stable restaurant idempotency', async () => {
    sdk.rawRequest.mockResolvedValue({ id: 'acct_testMerchant' });
    const { createConnectedAccount } = await import('../stripe.service');
    await expect(createConnectedAccount('rest-1', 'owner@example.invalid')).resolves.toBe(
      'acct_testMerchant',
    );
    expect(sdk.rawRequest).toHaveBeenCalledWith(
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
        metadata: { restaurantId: 'rest-1', source: 'sokar_gift_cards' },
      },
      { apiVersion: '2026-08-26.dahlia', idempotencyKey: 'gift-card-connect-v2:rest-1:hosted' },
    );
  });

  it.each([null, {}, { id: 'not-an-account' }])(
    'rejects malformed provider account responses: %j',
    async (response) => {
      sdk.rawRequest.mockResolvedValue(response);
      const { createConnectedAccount } = await import('../stripe.service');
      await expect(createConnectedAccount('rest-1', 'owner@example.invalid')).rejects.toThrow(
        'compte connecté valide',
      );
    },
  );

  it('keeps readiness and onboarding compatible with v2-created account IDs', async () => {
    sdk.accountRetrieve.mockResolvedValue({
      id: 'acct_testMerchant',
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
    });
    sdk.accountLinkCreate.mockResolvedValue({ url: 'https://connect.stripe.com/setup/test' });
    vi.stubEnv('DASHBOARD_URL', 'https://staging.suppernote.com');
    const { retrieveConnectedAccount, createConnectedAccountLink } =
      await import('../stripe.service');
    try {
      await expect(retrieveConnectedAccount('acct_testMerchant')).resolves.toEqual({
        id: 'acct_testMerchant',
        chargesEnabled: true,
        payoutsEnabled: true,
        detailsSubmitted: true,
        onboardingState: 'ready',
        actionItems: [],
        deadline: null,
      });
      await createConnectedAccountLink('acct_testMerchant');
      expect(sdk.accountLinkCreate).toHaveBeenCalledWith({
        account: 'acct_testMerchant',
        type: 'account_onboarding',
        refresh_url: 'https://staging.suppernote.com/dashboard/gift-cards?stripeConnect=refresh',
        return_url: 'https://staging.suppernote.com/dashboard/gift-cards?stripeConnect=return',
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('empreinte bancaire de réservation', () => {
  beforeEach(() => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
    sdk.customerCreate.mockReset().mockResolvedValue({ id: 'cus_new' });
    sdk.checkoutSessionCreate
      .mockReset()
      .mockResolvedValue({ id: 'cs_1', url: 'https://checkout.stripe.test/cs_1' });
    sdk.create.mockReset().mockResolvedValue({ id: 'pi_capture', status: 'succeeded' });
  });

  const setupInput = {
    stripeAccountId: 'acct_restaurant',
    metadata: { type: 'reservation_guarantee', reservationPaymentId: 'payment-1' },
    customerEmail: 'client@example.test',
    successUrl: 'https://suppernote.test/ok',
    cancelUrl: 'https://suppernote.test/annule',
    expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    customText: 'Aucun montant n’est débité aujourd’hui.',
    customerIdempotencyKey: 'customer-key',
    idempotencyKey: 'setup-key',
  };

  it('ouvre une page Stripe en mode setup sur le compte du restaurant', async () => {
    const result = await createReservationGuaranteeSetupSession({
      ...setupInput,
      stripeCustomerId: null,
    });
    expect(result).toEqual({
      sessionId: 'cs_1',
      url: 'https://checkout.stripe.test/cs_1',
      customerId: 'cus_new',
    });
    expect(sdk.customerCreate).toHaveBeenCalledWith(
      { email: 'client@example.test', metadata: setupInput.metadata },
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'customer-key' },
    );
    expect(sdk.checkoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'setup',
        customer: 'cus_new',
        payment_method_types: ['card'],
        expires_at: Math.floor(setupInput.expiresAt.getTime() / 1000),
        metadata: setupInput.metadata,
        setup_intent_data: { metadata: setupInput.metadata },
      }),
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'setup-key' },
    );
  });

  it('réutilise le client Stripe déjà créé', async () => {
    await createReservationGuaranteeSetupSession({ ...setupInput, stripeCustomerId: 'cus_old' });
    expect(sdk.customerCreate).not.toHaveBeenCalled();
    expect(sdk.checkoutSessionCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: 'cus_old' }),
      expect.anything(),
    );
  });

  const chargeInput = {
    stripeAccountId: 'acct_restaurant',
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    amountCents: 6000,
    currency: 'EUR',
    metadata: { type: 'reservation_guarantee' },
    receiptEmail: null,
    idempotencyKey: 'capture-key',
  };

  it('prélève hors session avec la clé d’idempotence fournie', async () => {
    await expect(chargeReservationGuarantee(chargeInput)).resolves.toEqual({
      ok: true,
      paymentIntentId: 'pi_capture',
      status: 'succeeded',
    });
    expect(sdk.create).toHaveBeenCalledWith(
      {
        amount: 6000,
        currency: 'eur',
        customer: 'cus_1',
        payment_method: 'pm_1',
        off_session: true,
        confirm: true,
        metadata: { type: 'reservation_guarantee' },
      },
      { stripeAccount: 'acct_restaurant', idempotencyKey: 'capture-key' },
    );
  });

  it('renvoie un refus bancaire sans relancer', async () => {
    const { __StripeCardError } = (await import('stripe')) as unknown as {
      __StripeCardError: new (raw: unknown, code?: string, decline?: string) => Error;
    };
    sdk.create.mockRejectedValueOnce(
      new __StripeCardError(
        { payment_intent: { id: 'pi_declined' } },
        'authentication_required',
        undefined,
      ),
    );
    await expect(chargeReservationGuarantee(chargeInput)).resolves.toEqual({
      ok: false,
      paymentIntentId: 'pi_declined',
      failureCode: 'authentication_required',
    });
    expect(sdk.create).toHaveBeenCalledTimes(1);
  });
});
