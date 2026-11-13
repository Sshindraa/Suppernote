import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { getBillingDetails, createBillingPortalSession } from '../billing.service';

const read = (globalThis as unknown as { __stripeRead: Record<string, ReturnType<typeof vi.fn>> })
  .__stripeRead;
const portal = (
  globalThis as unknown as { __stripeBillingPortalSessionCreate: ReturnType<typeof vi.fn> }
).__stripeBillingPortalSessionCreate;
const scope = { restaurantId: 'test-rest-1', accountId: 'test-account-1' };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = 'sk_test_unit';
  vi.mocked(db.restaurant.findUnique).mockResolvedValue({
    id: scope.restaurantId,
    accountId: scope.accountId,
  } as never);
  vi.mocked(db.restaurant.findFirst).mockResolvedValue({ id: 'primary-site' } as never);
  vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
    stripeCustomerId: 'cus_account',
    stripeSubscriptionId: 'sub_account',
  } as never);
  vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue({
    stripeCustomerId: 'cus_site_wrong',
    stripeSubscriptionId: 'sub_wrong',
  } as never);
  read.customer.mockResolvedValue({
    id: 'cus_account',
    invoice_settings: {
      default_payment_method: {
        card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        billing_details: { name: 'NEVER_RETURN' },
      },
    },
  });
  read.subscription.mockResolvedValue({
    id: 'sub_account',
    customer: 'cus_account',
    status: 'active',
    currency: 'eur',
    cancel_at_period_end: false,
    current_period_end: 1800000000,
    items: {
      data: [
        {
          quantity: 1,
          price: {
            id: 'price_existing',
            unit_amount: 19900,
            currency: 'eur',
            recurring: { interval: 'month', interval_count: 1 },
          },
        },
      ],
    },
  });
  read.invoices.mockResolvedValue({
    has_more: true,
    data: [
      {
        number: 'INV-1',
        created: 1790000000,
        status: 'paid',
        total: 19900,
        currency: 'eur',
        customer: 'cus_account',
        customer_email: 'NEVER_RETURN',
        invoice_pdf: 'https://pay.stripe.com/invoice/test/pdf',
        hosted_invoice_url: 'https://invoice.stripe.com/i/test',
      },
      { status: 'draft' },
    ],
  });
});
afterAll(closeApp);

describe('billing details, account isolation and portal flows', () => {
  it('uses the account anchor, returns only minimal payment/invoice data', async () => {
    const result = await getBillingDetails(scope);
    expect(read.customer).toHaveBeenCalledWith('cus_account', expect.anything());
    expect(read.subscription).toHaveBeenCalledWith('sub_account', expect.anything());
    expect(read.invoices).toHaveBeenCalledWith({ customer: 'cus_account', limit: 20 });
    expect(result.paymentMethod).toEqual({
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
    });
    expect(result.subscription?.recurringAmount).toBe(19900);
    expect(result.invoices).toHaveLength(1);
    expect(result.hasMoreInvoices).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /NEVER_RETURN|cus_account|sub_account|price_existing/,
    );
  });
  it('sums multiple subscription items and quantities without guessing mixed intervals', async () => {
    const subscription = {
      customer: 'cus_account',
      status: 'active',
      currency: 'eur',
      cancel_at_period_end: false,
      items: {
        data: [
          {
            quantity: 1,
            price: {
              unit_amount: 19900,
              currency: 'eur',
              recurring: { interval: 'month', interval_count: 1 },
            },
          },
        ],
      },
    };
    read.subscription.mockResolvedValue(subscription);
    subscription.items.data.push({
      quantity: 2,
      price: {
        unit_amount: 9900,
        currency: 'eur',
        recurring: { interval: 'month', interval_count: 1 },
      },
    });
    const multi = await getBillingDetails(scope);
    expect(multi.subscription?.recurringAmount).toBe(39700);
    expect(multi.subscription?.canUpdatePlan).toBe(false);
    subscription.items.data[1].price.recurring.interval = 'year';
    expect((await getBillingDetails(scope)).subscription?.recurringAmount).toBeNull();
  });
  it('does not fall back to another site customer when the account row has none', async () => {
    vi.mocked(db.restaurantAccountBilling.findUnique).mockResolvedValue({
      stripeCustomerId: null,
    } as never);
    const result = await getBillingDetails(scope);
    expect(result.hasCustomer).toBe(false);
    expect(read.customer).not.toHaveBeenCalled();
  });
  it('rejects an inconsistent subscription/customer association', async () => {
    read.subscription.mockResolvedValueOnce({ customer: 'cus_other' });
    await expect(getBillingDetails(scope)).rejects.toThrow();
  });
  it('handles no payment method without leaking any customer object', async () => {
    read.customer.mockResolvedValueOnce({ invoice_settings: {} });
    expect((await getBillingDetails(scope)).hasPaymentMethod).toBe(false);
  });
  it.each(['payment_method', 'subscription_update', 'subscription_cancel'] as const)(
    'opens the %s flow in French and returns to Suppernote',
    async (intent) => {
      await createBillingPortalSession({ ...scope, intent, returnTo: 'billing' });
      expect(portal).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_account',
          locale: 'fr',
          return_url: expect.stringContaining('/dashboard/billing?billing=portal-return'),
          flow_data: expect.objectContaining({
            type: intent === 'payment_method' ? 'payment_method_update' : intent,
          }),
        }),
      );
    },
  );
  it('uses the full portal when the subscription has its own payment method', async () => {
    read.subscription.mockResolvedValueOnce({ default_payment_method: 'pm_subscription' });
    await createBillingPortalSession({ ...scope, intent: 'payment_method', returnTo: 'billing' });
    expect(portal).toHaveBeenCalledWith(
      expect.not.objectContaining({ flow_data: expect.anything() }),
    );
  });
  it('rejects invoice requests without authentication', async () => {
    const response = await (await getApp()).inject({ method: 'GET', url: '/billing/details' });
    expect(response.statusCode).toBe(401);
  });
  it.each(['MANAGER', 'STAFF', 'READ_ONLY'])(
    'denies private billing details to %s',
    async (role) => {
      const response = await (
        await getApp()
      ).inject({
        method: 'GET',
        url: '/billing/details',
        headers: { authorization: 'Bearer test', 'x-test-site-role': role },
      });
      expect(response.statusCode).toBe(403);
      expect(read.customer).not.toHaveBeenCalled();
    },
  );
  it('marks private invoice responses no-store', async () => {
    const response = await (
      await getApp()
    ).inject({ method: 'GET', url: '/billing/details', headers: { authorization: 'Bearer test' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('rejects client-supplied Stripe IDs and redirect targets', async () => {
    const response = await (
      await getApp()
    ).inject({
      method: 'POST',
      url: '/billing/portal-session',
      headers: { authorization: 'Bearer test' },
      payload: { customer: 'cus_other', returnTo: 'https://evil.example' },
    });
    expect(response.statusCode).toBe(400);
    expect(portal).not.toHaveBeenCalled();
  });
  it('returns an explicit provider failure without pretending invoices are empty', async () => {
    read.invoices.mockRejectedValueOnce(new Error('private provider error'));
    const response = await (
      await getApp()
    ).inject({ method: 'GET', url: '/billing/details', headers: { authorization: 'Bearer test' } });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain('private provider error');
  });
});
