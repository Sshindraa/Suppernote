import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Prisma } from '@prisma/client';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { constructWebhookEvent, retrievePaymentIntent } from '../stripe.service';
import * as stripeService from '../stripe.service';
import * as localTest from '../gift-card-local-test';
import * as verification from '../managed-connect-verification';
import { checkRateLimit } from '../../../shared/redis/rate-limit';
import { logger } from '../../../shared/logger/pino.js';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';
import { ReservationService } from '../../agentic-reservations/core/reservation.service';
import { GiftCardPaymentService } from '../gift-card-payment.service';

// Le handler webhook envoie un vrai SMS Telnyx (gift-card-payment.service).
// Sans mock, un appel réseau réel traîne sous charge parallèle → test flaky (~15s).
vi.mock('../../../shared/telnyx/client', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../shared/telnyx/client')>();
  return { ...mod, sendSms: vi.fn().mockResolvedValue(undefined) };
});

function d(value: number) {
  return new Prisma.Decimal(value);
}

const AUTH = { authorization: 'Bearer fake-token' };
const RESTAURANT_ID = 'test-rest-1';

describe('gift-card routes', () => {
  describe('local test context', () => {
    it('does not read restaurant data outside the local test guard', async () => {
      const guard = vi.spyOn(localTest, 'isLocalGiftCardTest').mockReturnValue(false);
      const app = await getApp();
      const response = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/test-context`,
        headers: AUTH,
      });
      expect(response.json()).toEqual({ enabled: false });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(db.restaurant.findUniqueOrThrow).not.toHaveBeenCalled();
      guard.mockRestore();
    });
    it('restricts demo tools to its owner and scoped restaurant', async () => {
      const guard = vi.spyOn(localTest, 'isLocalGiftCardTest').mockReturnValue(true);
      const app = await getApp();
      for (const [id, headers, code] of [
        [RESTAURANT_ID, {}, 401],
        ['other', AUTH, 403],
        [RESTAURANT_ID, { ...AUTH, 'x-test-site-role': 'STAFF' }, 403],
        [RESTAURANT_ID, { ...AUTH, 'x-test-site-role': 'MANAGER' }, 403],
      ] as const) {
        const response = await app.inject({
          method: 'GET',
          url: `/restaurants/${id}/gift-cards/test-context`,
          headers,
        });
        expect(response.statusCode).toBe(code);
      }
      guard.mockRestore();
    });
    it('returns local buyer links without exposing provider credentials', async () => {
      const guard = vi.spyOn(localTest, 'isLocalGiftCardTest').mockReturnValue(true);
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
        slug: 'demo',
        giftCardEnabled: true,
      } as never);
      const app = await getApp();
      const response = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/test-context`,
        headers: AUTH,
      });
      expect(response.json()).toMatchObject({
        enabled: true,
        purchaseUrl: 'http://localhost:4002/widget/demo/gift-card',
        beneficiaryBaseUrl: 'http://localhost:4002/gift-card/',
        giftCardEnabled: true,
      });
      expect(typeof response.json().emailConfigured).toBe('boolean');
      expect(Object.keys(response.json()).sort()).toEqual(
        [
          'enabled',
          'purchaseUrl',
          'beneficiaryBaseUrl',
          'giftCardEnabled',
          'emailConfigured',
          'smsConfigured',
        ].sort(),
      );
      guard.mockRestore();
    });
  });

  describe('embedded Connect onboarding', () => {
    it('refuses account setup and session renewal until the owner has reverified', async () => {
      vi.spyOn(stripeService, 'managedConnectTestEnabled').mockReturnValue(true);
      vi.spyOn(stripeService, 'isManagedTestAccount').mockResolvedValue(true);
      const session = vi.spyOn(stripeService, 'createManagedTestSession');
      vi.mocked(verification.managedConnectVerified).mockReturnValue(false);
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
        giftCardStripeAccountId: 'acct_existing',
      } as never);
      const app = await getApp();
      for (const route of ['managed-test', 'session']) {
        const response = await app.inject({
          method: 'POST',
          url: `/restaurants/${RESTAURANT_ID}/gift-cards/stripe-connect/${route}`,
          headers: AUTH,
          payload:
            route === 'managed-test' ? { accountToken: ['accttok', 'example'].join('_') } : {},
        });
        expect(response.statusCode).toBe(403);
        expect(response.json().clerk_error.reason).toBe('reverification-error');
      }
      expect(session).not.toHaveBeenCalled();
      vi.mocked(verification.managedConnectVerified).mockReturnValue(true);
      vi.restoreAllMocks();
    });
    it('resumes a completed test account after the original response was lost', async () => {
      const enabled = vi.spyOn(stripeService, 'managedConnectTestEnabled').mockReturnValue(true);
      const managed = vi.spyOn(stripeService, 'isManagedTestAccount').mockResolvedValue(true);
      const session = vi
        .spyOn(stripeService, 'createManagedTestSession')
        .mockResolvedValue({ clientSecret: 'mock', publishableKey: 'pk_test' });
      const configure = vi.spyOn(stripeService, 'configureManagedTestAccount');
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
        giftCardStripeAccountId: 'acct_existing',
        giftCardStripePendingAccountId: null,
      } as never);
      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/stripe-connect/managed-test`,
        headers: AUTH,
        payload: { accountToken: ['accttok', 'example'].join('_') },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(session).toHaveBeenCalledWith(RESTAURANT_ID, 'acct_existing');
      expect(configure).not.toHaveBeenCalled();
      enabled.mockRestore();
      managed.mockRestore();
      session.mockRestore();
      configure.mockRestore();
    });
    it('limits the experimental route to an allowed owner and a valid account token', async () => {
      const enabled = vi.spyOn(stripeService, 'managedConnectTestEnabled').mockReturnValue(true);
      const app = await getApp();
      for (const [restaurant, headers, code] of [
        [RESTAURANT_ID, {}, 401],
        ['other', AUTH, 403],
        [RESTAURANT_ID, { ...AUTH, 'x-test-site-role': 'STAFF' }, 403],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/restaurants/${restaurant}/gift-cards/stripe-connect/managed-test`,
          headers,
          payload: { accountToken: ['accttok', 'example'].join('_') },
        });
        expect(response.statusCode).toBe(code);
      }
      const invalid = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/stripe-connect/managed-test`,
        headers: AUTH,
        payload: { accountToken: 'invalid' },
      });
      expect(invalid.statusCode).toBe(400);
      enabled.mockReturnValue(false);
      const disabled = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/stripe-connect/managed-test`,
        headers: AUTH,
        payload: { accountToken: ['accttok', 'example'].join('_') },
      });
      expect(disabled.statusCode).toBe(404);
      enabled.mockRestore();
    });
    it('rejects anonymous, foreign tenant, staff and manager requests before accessing Stripe', async () => {
      const session = vi
        .spyOn(stripeService, 'createConnectedAccountSession')
        .mockResolvedValue({ clientSecret: 'mock', publishableKey: 'pk_test' });
      const app = await getApp();
      for (const [restaurant, headers, code] of [
        [RESTAURANT_ID, {}, 401],
        ['other', AUTH, 403],
        [RESTAURANT_ID, { ...AUTH, 'x-test-site-role': 'STAFF' }, 403],
        [RESTAURANT_ID, { ...AUTH, 'x-test-site-role': 'MANAGER' }, 403],
      ] as const) {
        const response = await app.inject({
          method: 'POST',
          url: `/restaurants/${restaurant}/gift-cards/stripe-connect/session`,
          headers,
        });
        expect(response.statusCode).toBe(code);
      }
      expect(session).not.toHaveBeenCalled();
      session.mockRestore();
    });
    it('reuses the existing account and creates a fresh non-cacheable session on every request', async () => {
      const session = vi
        .spyOn(stripeService, 'createConnectedAccountSession')
        .mockResolvedValue({ clientSecret: 'mock', publishableKey: 'pk_test' });
      const create = vi.spyOn(stripeService, 'createConnectedAccount');
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
        giftCardStripeAccountId: 'acct_existing',
        managerEmail: 'owner@example.invalid',
      } as never);
      const app = await getApp();
      for (let i = 0; i < 2; i++) {
        const response = await app.inject({
          method: 'POST',
          url: `/restaurants/${RESTAURANT_ID}/gift-cards/stripe-connect/session`,
          headers: AUTH,
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.json()).toEqual({
          clientSecret: 'mock',
          publishableKey: 'pk_test',
        });
      }
      expect(session).toHaveBeenNthCalledWith(1, 'acct_existing');
      expect(session).toHaveBeenCalledTimes(2);
      expect(create).not.toHaveBeenCalled();
      session.mockRestore();
      create.mockRestore();
    });
  });
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);
    vi.mocked(db.giftCardPaymentEntry.findMany).mockResolvedValue([]);
    vi.mocked(db.giftCardCheckout.findUnique).mockResolvedValue(null);
    vi.mocked(db.giftCardCheckout.upsert).mockImplementation(((args: {
      create: Record<string, unknown>;
    }) =>
      Promise.resolve({
        ...args.create,
        id: '00000000-0000-4000-8000-000000000001',
        createdAt: new Date(),
        stripePaymentIntentId: null,
      })) as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      name: 'Test Resto',
      giftCardEnabled: true,
      giftCardStripeAccountId: 'acct_test',
      giftCardMinimumAmount: 10,
      giftCardCommissionRate: d(0.05),
    } as never);
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: 'pi_test',
      status: 'succeeded',
      amount: 12000,
      amountReceived: 12000,
      currency: 'eur',
      metadata: { restaurantId: RESTAURANT_ID, amount: '120', packId: '' },
    });
  });

  describe('cashier operations', () => {
    it('requires authentication and rejects another restaurant before looking up a card', async () => {
      const app = await getApp();
      const anon = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/card/operations`,
      });
      expect(anon.statusCode).toBe(401);
      const foreign = await app.inject({
        method: 'GET',
        url: '/restaurants/other/gift-cards/card/operations',
        headers: AUTH,
      });
      expect(foreign.statusCode).toBe(403);
      expect(db.giftCard.findFirst).not.toHaveBeenCalled();
    });
    it('validates cent precision and requires a ticket and UUID retry key', async () => {
      const app = await getApp();
      for (const body of [
        {
          billAmount: 1.001,
          ticketReference: 'T42',
          idempotencyKey: '00000000-0000-4000-8000-000000000001',
        },
        { billAmount: 10, ticketReference: '', idempotencyKey: 'invalid' },
      ]) {
        const result = await app.inject({
          method: 'POST',
          url: `/restaurants/${RESTAURANT_ID}/gift-cards/card/redeem`,
          headers: { ...AUTH, 'x-test-site-role': 'STAFF' },
          payload: body,
        });
        expect(result.statusCode).toBe(400);
      }
      expect(db.giftCard.findFirst).not.toHaveBeenCalled();
    });
    it('restricts delivery management to owner/manager and scopes the target delivery', async () => {
      const app = await getApp();
      const url = `/restaurants/${RESTAURANT_ID}/gift-cards/card/operations/deliveries/delivery/retry`;
      const staff = await app.inject({
        method: 'POST',
        url,
        headers: { ...AUTH, 'x-test-site-role': 'STAFF' },
      });
      expect(staff.statusCode).toBe(403);
      expect(db.giftCardDelivery.findFirst).not.toHaveBeenCalled();
      const foreign = await app.inject({
        method: 'POST',
        url: url.replace(RESTAURANT_ID, 'other'),
        headers: AUTH,
      });
      expect(foreign.statusCode).toBe(403);
      const manager = await app.inject({
        method: 'POST',
        url,
        headers: { ...AUTH, 'x-test-site-role': 'MANAGER' },
      });
      expect(manager.statusCode).toBe(404);
      expect(db.giftCardDelivery.findFirst).toHaveBeenCalledWith({
        where: { id: 'delivery', giftCardId: 'card', restaurantId: RESTAURANT_ID },
      });
    });

    it('requires a provider case reference before resolving uncertainty', async () => {
      const app = await getApp();
      const result = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/card/operations/deliveries/delivery/resolve`,
        headers: AUTH,
        payload: { resolution: 'not_accepted', providerCaseReference: 'personal@example.invalid' },
      });
      expect(result.statusCode).toBe(400);
      expect(db.giftCardDelivery.updateMany).not.toHaveBeenCalled();
    });

    it('reserves the financial export for managers and validates its date range', async () => {
      const app = await getApp();
      const url = `/restaurants/${RESTAURANT_ID}/gift-cards/operations/export?from=2026-09-01&until=2026-09-30`;
      const staff = await app.inject({
        method: 'GET',
        url,
        headers: { ...AUTH, 'x-test-site-role': 'STAFF' },
      });
      expect(staff.statusCode).toBe(403);
      expect(db.giftCardPaymentEntry.findMany).not.toHaveBeenCalled();
      const invalid = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/operations/export?from=2026-02-30&until=2026-09-30`,
        headers: AUTH,
      });
      expect(invalid.statusCode).toBe(400);
      vi.mocked(db.giftCardRedemption.findMany).mockResolvedValue([]);
      const owner = await app.inject({ method: 'GET', url, headers: AUTH });
      expect(owner.statusCode).toBe(200);
      expect(owner.json()).toMatchObject({
        rowCount: 0,
        filename: 'cartes-cadeaux-2026-09-01-2026-09-30.csv',
      });
      expect(db.giftCardPaymentEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            restaurantId: RESTAURANT_ID,
            createdAt: { gte: new Date('2026-09-01'), lt: new Date('2026-10-01') },
          },
        }),
      );
    });

    it('looks up a card only within the selected restaurant and normalizes its short code', async () => {
      const app = await getApp();
      const result = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/operations/lookup`,
        headers: AUTH,
        payload: { code: 'skr-abcd-12' },
      });
      expect(result.statusCode).toBe(404);
      expect(db.giftCard.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            restaurantId: RESTAURANT_ID,
            OR: [{ code: 'skr-abcd-12' }, { shortCode: 'SKR-ABCD-12' }],
          },
        }),
      );
    });
  });

  describe('admin routes', () => {
    it('retourne 401 sans auth', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('liste les cartes cadeaux du restaurant', async () => {
      vi.mocked(db.giftCard.findMany).mockResolvedValue([
        {
          id: 'gc-1',
          restaurantId: RESTAURANT_ID,
          code: 'abc-1234-5678-9012',
          amount: d(100),
          remainingAmount: d(100),
          currency: 'EUR',
          status: 'ACTIVE',
          createdBy: 'DASHBOARD',
          purchaseReference: 'manual',
          redemptions: [],
          contributions: [],
        } as unknown as Awaited<ReturnType<typeof db.giftCard.findMany>>[number],
      ]);
      vi.mocked(db.giftCard.count).mockResolvedValue(1);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].code).toContain('****');
    });

    it('le total reflète le filtre status (pas le total global)', async () => {
      // 3 cartes : 2 ACTIVE, 1 REDEEMED. On filtre par status=ACTIVE → total doit être 2.
      const baseCard = {
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234-5678-9012',
        amount: d(100),
        remainingAmount: d(100),
        currency: 'EUR',
        createdBy: 'DASHBOARD',
        purchaseReference: 'manual',
        redemptions: [],
        contributions: [],
      };
      vi.mocked(db.giftCard.findMany).mockResolvedValue([
        { id: 'gc-a', status: 'ACTIVE', ...baseCard },
        { id: 'gc-b', status: 'ACTIVE', ...baseCard },
      ] as unknown as Awaited<ReturnType<typeof db.giftCard.findMany>>);
      (
        vi.mocked(db.giftCard.count) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation((args: unknown) => {
        const a = args as { where?: { status?: string; restaurantId?: string } };
        // Si le filtre status est transmis au count, on retourne 2 ; sinon 3 (bug).
        if (a?.where?.status === 'ACTIVE') return 2;
        return 3;
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards?status=ACTIVE`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      // Vérifie que count a bien reçu le filtre status dans son where
      expect(vi.mocked(db.giftCard.count)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
      );
    });

    it('le total reflète le filtre search (pas le total global)', async () => {
      // 3 cartes au total, 1 correspond au terme "Alice".
      vi.mocked(db.giftCard.findMany).mockResolvedValue([
        {
          id: 'gc-a',
          restaurantId: RESTAURANT_ID,
          code: 'abc-1234-5678-9012',
          amount: d(100),
          remainingAmount: d(100),
          currency: 'EUR',
          status: 'ACTIVE',
          createdBy: 'DASHBOARD',
          purchaseReference: 'manual',
          recipientName: 'Alice',
          redemptions: [],
          contributions: [],
        },
      ] as unknown as Awaited<ReturnType<typeof db.giftCard.findMany>>);
      (
        vi.mocked(db.giftCard.count) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation((args: unknown) => {
        const a = args as { where?: { OR?: unknown[]; restaurantId?: string } };
        // Si le filtre search (OR) est transmis au count, on retourne 1 ; sinon 3 (bug).
        if (a?.where?.OR && a.where.OR.length > 0) return 1;
        return 3;
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards?search=Alice`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(1);
      // Vérifie que count a bien reçu le filtre OR (search) dans son where
      expect(vi.mocked(db.giftCard.count)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
      );
    });

    it('le total reflète le filtre type (pas le total global)', async () => {
      // 3 cartes au total, 2 sont de type SINGLE.
      vi.mocked(db.giftCard.findMany).mockResolvedValue([
        {
          id: 'gc-a',
          restaurantId: RESTAURANT_ID,
          code: 'abc-1234-5678-9012',
          amount: d(100),
          remainingAmount: d(100),
          currency: 'EUR',
          status: 'ACTIVE',
          type: 'SINGLE',
          createdBy: 'DASHBOARD',
          purchaseReference: 'manual',
          redemptions: [],
          contributions: [],
        },
        {
          id: 'gc-b',
          restaurantId: RESTAURANT_ID,
          code: 'def-5678-9012-3456',
          amount: d(50),
          remainingAmount: d(50),
          currency: 'EUR',
          status: 'ACTIVE',
          type: 'SINGLE',
          createdBy: 'DASHBOARD',
          purchaseReference: 'manual',
          redemptions: [],
          contributions: [],
        },
      ] as unknown as Awaited<ReturnType<typeof db.giftCard.findMany>>);
      (
        vi.mocked(db.giftCard.count) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation((args: unknown) => {
        const a = args as { where?: { type?: string; restaurantId?: string } };
        // Si le filtre type est transmis au count, on retourne 2 ; sinon 3 (bug).
        if (a?.where?.type) return 2;
        return 3;
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards?type=SINGLE`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      // Vérifie que count a bien reçu le filtre type dans son where
      expect(vi.mocked(db.giftCard.count)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ type: 'SINGLE' }) }),
      );
    });

    it('crée une carte cadeau manuelle', async () => {
      vi.mocked(db.giftCard.create).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234-5678-9012',
        amount: d(100),
        remainingAmount: d(100),
        currency: 'EUR',
        status: 'ACTIVE',
        createdBy: 'DASHBOARD',
        purchaseReference: 'manual',
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards`,
        headers: AUTH,
        payload: { amount: 100, recipientName: 'Alice', recipientEmail: 'alice@example.com' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.amount).toBe(100);
      expect(body.createdBy).toBe('DASHBOARD');
    });

    it('annule une carte cadeau', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        status: 'ACTIVE',
        amount: d(100),
        remainingAmount: d(100),
        currency: 'EUR',
        stripePaymentIntentId: null,
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);
      vi.mocked(db.giftCard.update).mockResolvedValue({
        id: 'gc-1',
        status: 'CANCELLED',
        remainingAmount: d(0),
        amount: d(100),
        currency: 'EUR',
        code: 'abc-1234',
        createdBy: 'DASHBOARD',
        purchaseReference: 'manual',
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.update>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/gc-1/cancel`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('CANCELLED');
    });

    it('retourne les stats', async () => {
      (
        vi.mocked(db.giftCard.aggregate) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation((args: unknown) => {
        const a = args as { _sum?: { amount?: true; remainingAmount?: true } };
        if (a._sum?.amount) {
          return { _sum: { amount: d(150) } };
        }
        if (a._sum?.remainingAmount) {
          return { _sum: { remainingAmount: d(50) } };
        }
        return { _sum: null };
      });
      (
        vi.mocked(db.giftCard.count) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation((args: unknown) => {
        const a = args as { where?: { status?: string; packId?: string } };
        if (a?.where?.status === 'REDEEMED') return 1;
        if (a?.where?.status === 'ACTIVE') return 1;
        if (a?.where?.packId) return 0;
        return 2;
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards/stats`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalSoldAmount).toBe(150);
      expect(body.totalCount).toBe(2);
    });
  });

  describe('public routes', () => {
    it('vérifie le solde d une carte cadeau', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234',
        amount: d(100),
        remainingAmount: d(60),
        status: 'ACTIVE',
        expiresAt: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        name: 'Chez Suppernote',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/check',
        payload: { code: 'abc-1234' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.giftCard.remainingAmount).toBe(60);
      expect(body.giftCard.restaurantName).toBe('Chez Suppernote');
    });

    it('retourne une recommandation', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/recommend',
        payload: { priceRange: '€€', occasion: 'anniversaire', partySize: 2 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.amount).toBe('number');
      expect(body.messageSuggestion).toContain('Offrez');
    });

    it('retourne 404 sur /packs/:slug quand giftCardEnabled est false', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        giftCardEnabled: false,
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/public/gift-cards/packs/test-slug',
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Cartes cadeaux non disponibles');
    });

    it('résout le nouveau slug avant la migration de la fiche stockée', async () => {
      const findUnique = vi.mocked(db.restaurant.findUnique);
      findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: RESTAURANT_ID, giftCardEnabled: true } as never);
      vi.mocked(db.giftCardPack.findMany).mockResolvedValue([] as never);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/public/gift-cards/packs/chez-suppernote-demo',
      });

      expect(res.statusCode).toBe(200);
      expect(findUnique).toHaveBeenNthCalledWith(1, {
        where: { slug: 'chez-suppernote-demo' },
        select: { id: true, giftCardEnabled: true },
      });
      expect(findUnique).toHaveBeenNthCalledWith(2, {
        where: { slug: 'chez-sokar-demo' },
        select: { id: true, giftCardEnabled: true },
      });
    });

    it('retourne 403 sur /payment-intent quand giftCardEnabled est false', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        giftCardMinimumAmount: 10,
        giftCardEnabled: false,
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/payment-intent',
        payload: {
          restaurantId: RESTAURANT_ID,
          amount: 100,
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Cartes cadeaux non disponibles pour ce restaurant');
    });

    it('achète une carte cadeau avec paiement Stripe', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        name: 'Test Resto',
        giftCardCommissionRate: d(0.05),
        giftCardMinimumAmount: 10,
        managerEmail: 'manager@test.com',
        managerPhone: '+33100000000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.giftCard.create).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234-5678-9012',
        amount: d(120),
        remainingAmount: d(120),
        currency: 'EUR',
        status: 'ACTIVE',
        createdBy: 'CLIENT',
        purchaseReference: 'pi_test',
        stripePaymentIntentId: 'pi_test',
        stripePaymentStatus: 'succeeded',
        sokarCommissionAmount: d(6),
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/purchase',
        payload: {
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 120,
          recipientName: 'Alice',
          recipientEmail: 'alice@example.com',
          senderName: 'Bob',
          senderEmail: 'bob@example.com',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.amount).toBe(120);
      expect(body.code).toBeDefined();
      expect(body.code).not.toContain('****');
      expect(body.stripePaymentStatus).toBe('succeeded');
      expect(body.pdfUrl).toContain('/pdf');
    });

    it('achète un pack expérience avec paiement Stripe', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 15000,
        amountReceived: 15000,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '150', packId: 'pack-1' },
      });
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        name: 'Test Resto',
        giftCardCommissionRate: d(0.05),
        giftCardMinimumAmount: 10,
        managerEmail: 'manager@test.com',
        managerPhone: '+33100000000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.giftCardPack.findFirst).mockResolvedValue({
        id: 'pack-1',
        restaurantId: RESTAURANT_ID,
        amount: d(150),
      } as unknown as Awaited<ReturnType<typeof db.giftCardPack.findFirst>>);
      vi.mocked(db.giftCard.create).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234-5678-9012',
        amount: d(150),
        remainingAmount: d(150),
        currency: 'EUR',
        status: 'ACTIVE',
        createdBy: 'CLIENT',
        purchaseReference: 'pi_test',
        stripePaymentIntentId: 'pi_test',
        stripePaymentStatus: 'succeeded',
        sokarCommissionAmount: d(7.5),
        packId: 'pack-1',
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);
      vi.mocked(db.giftCardPack.findUnique).mockResolvedValue({
        id: 'pack-1',
        name: 'Menu dégustation',
      } as unknown as Awaited<ReturnType<typeof db.giftCardPack.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/purchase',
        payload: {
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          packId: 'pack-1',
          recipientName: 'Alice',
          recipientEmail: 'alice@example.com',
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.amount).toBe(150);
      expect(body.packName).toBe('Menu dégustation');
    });

    it('crée un payment intent Stripe', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        giftCardMinimumAmount: 10,
        giftCardEnabled: true,
        giftCardStripeAccountId: 'acct_test',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/payment-intent',
        payload: {
          restaurantId: RESTAURANT_ID,
          amount: 100,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.paymentIntentId).toBeDefined();
      expect(body.clientSecret).toBeDefined();
    });

    it("télécharge le PDF d'une carte cadeau", async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234-5678-9012',
        amount: d(100),
        remainingAmount: d(100),
        currency: 'EUR',
        status: 'ACTIVE',
        validityMonths: 12,
        message: 'Joyeux anniversaire',
        occasion: 'Anniversaire',
        senderName: 'Bob',
        recipientName: 'Alice',
        expiresAt: new Date('2027-01-01'),
        restaurant: { name: 'Test Resto' },
        pack: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/public/gift-cards/abc-1234-5678-9012/pdf',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
    });

    it('propose des créneaux pour une carte cadeau', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234',
        amount: d(100),
        remainingAmount: d(100),
        status: 'ACTIVE',
        expiresAt: null,
        preferredPartySize: 2,
        preferredDate: new Date('2026-08-15'),
        pack: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-08-15',
        partySize: 2,
        slots: [
          { time: '19:00', available: true },
          { time: '19:30', available: true },
          { time: '20:00', available: true },
        ],
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/abc-1234/slots',
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slots).toHaveLength(3);
    });

    it('réserve un créneau avec la carte cadeau', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234',
        amount: d(100),
        remainingAmount: d(100),
        status: 'ACTIVE',
        expiresAt: null,
        preferredPartySize: 2,
        pack: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        timezone: 'Europe/Paris',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue({
        maxPartySize: 12,
        minLeadTimeMinutes: 30,
        quoteTtlSeconds: 300,
        holdTtlSeconds: 420,
        noShowPolicy: 'warning',
        requireManualValidation: false,
        capacitySpecials: null,
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findUnique>>);
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-08-15',
        partySize: 2,
        slots: [
          { time: '19:00', available: true },
          { time: '19:30', available: true },
          { time: '20:00', available: true },
        ],
      });
      vi.spyOn(ReservationService.prototype, 'createReservation').mockResolvedValue({
        reservationId: 'res-1',
        state: 'CONFIRMED',
        reused: false,
        giftCardApplication: {
          reservationId: 'res-1',
          giftCardId: 'gc-1',
          appliedAmount: 100,
          remainingAmount: 0,
          paymentStatus: 'FULLY_COVERED',
          complementAmount: 0,
        },
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/abc-1234/book',
        payload: {
          slotIndex: 0,
          customer: { firstName: 'Alice', lastName: 'Dupont', phone: '+33612345678' },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.reservationId).toBeDefined();
    });

    it('applique une carte cadeau à une réservation', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-1',
        restaurantId: RESTAURANT_ID,
        code: 'abc-1234',
        amount: d(100),
        remainingAmount: d(100),
        status: 'ACTIVE',
        expiresAt: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.giftCard.update).mockResolvedValue({
        id: 'gc-1',
        remainingAmount: d(40),
        status: 'ACTIVE',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.update>>);
      vi.mocked(db.$queryRaw).mockResolvedValue([
        { id: 'gc-1', remainingAmount: d(100), status: 'ACTIVE' },
      ] as unknown as Awaited<ReturnType<typeof db.$queryRaw>>);
      (
        vi.mocked(db.$transaction) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementation(async (fn: unknown) => {
        if (Array.isArray(fn)) {
          return Promise.all(fn);
        }
        return (fn as (tx: unknown) => unknown)(db);
      });

      vi.mocked(db.reservation.findFirst).mockResolvedValue({
        id: 'res-1',
        restaurantId: RESTAURANT_ID,
      } as never);
      vi.mocked(db.giftCardRedemption.create).mockResolvedValue({
        id: 'redemption-1',
        redeemedAt: new Date(),
      } as never);
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/apply',
        headers: AUTH,
        payload: {
          code: 'abc-1234',
          restaurantId: RESTAURANT_ID,
          reservationId: 'res-1',
          reservationAmount: 60,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.appliedAmount).toBe(60);
      expect(body.remainingAmount).toBe(40);
      expect(body.paymentStatus).toBe('PARTIAL');
    });
  });

  describe('stripe webhook', () => {
    it('transmet les confirmations Checkout de souscription à la facturation', async () => {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        id: 'evt_billing_checkout',
        created: 100,
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_billing',
            mode: 'subscription',
            customer: 'cus_billing',
            subscription: 'sub_billing',
            metadata: { restaurantId: RESTAURANT_ID, plan: 'pro', billing: 'monthly' },
          },
        },
      } as never);
      vi.mocked(db.stripeWebhookEvent.findUnique).mockResolvedValue(null);
      vi.mocked(db.restaurantBilling.findUnique).mockResolvedValue(null);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': 't=123,v1=fake', 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(db.restaurantBilling.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { restaurantId: RESTAURANT_ID },
          create: expect.objectContaining({ stripeSubscriptionId: 'sub_billing' }),
        }),
      );
    });

    const WEBHOOK_METADATA = {
      restaurantId: RESTAURANT_ID,
      amount: '120',
      packId: '',
      occasion: 'Anniversaire',
      senderName: 'Bob',
      senderEmail: 'bob@example.com',
      senderPhone: '+33612345678',
      recipientName: 'Alice',
      recipientEmail: 'alice@example.com',
      recipientPhone: '+33687654321',
      message: 'Joyeux anniversaire',
      templateId: 'classic',
      customImageUrl: '',
      preferredDate: '',
      preferredTime: '',
      preferredPartySize: '',
    };

    function mockWebhookEvent(piId: string, metadata: Record<string, string>) {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        type: 'payment_intent.succeeded',
        data: { object: { id: piId, metadata } },
      } as unknown as Awaited<ReturnType<typeof constructWebhookEvent>>);
    }

    it('ignore un payment_intent.succeeded d’expérience (géré par checkout.session.*)', async () => {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        id: 'evt_experience_pi',
        created: 100,
        type: 'payment_intent.succeeded',
        account: 'acct_x',
        data: {
          object: {
            id: 'pi_experience_1',
            metadata: {
              type: 'experience_checkout',
              restaurantId: RESTAURANT_ID,
              experienceCheckoutId: 'exp_checkout_1',
            },
          },
        },
      } as never);
      const handleSpy = vi.spyOn(GiftCardPaymentService.prototype, 'handleStripeWebhook');

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'stripe-signature': 't=123,v1=fake', 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      expect(handleSpy).not.toHaveBeenCalled();
      handleSpy.mockRestore();
    });

    it('recrée une carte cadeau depuis le webhook avec metadata complètes', async () => {
      mockWebhookEvent('pi_webhook_1', WEBHOOK_METADATA);
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_webhook_1',
        status: 'succeeded',
        amount: 12000,
        amountReceived: 12000,
        currency: 'eur',
        metadata: WEBHOOK_METADATA,
      });
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        name: 'Test Resto',
        giftCardCommissionRate: d(0.05),
        giftCardMinimumAmount: 10,
        managerEmail: 'manager@test.com',
        managerPhone: '+33100000000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.giftCard.create).mockResolvedValue({
        id: 'gc-wb-1',
        restaurantId: RESTAURANT_ID,
        code: 'wb-1234-5678-9012',
        amount: d(120),
        remainingAmount: d(120),
        currency: 'EUR',
        status: 'ACTIVE',
        createdBy: 'CLIENT',
        purchaseReference: 'pi_webhook_1',
        stripePaymentIntentId: 'pi_webhook_1',
        stripePaymentStatus: 'succeeded',
        sokarCommissionAmount: d(6),
        redemptions: [],
        contributions: [],
      } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.succeeded' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect(db.giftCard.create).toHaveBeenCalled();
    });

    it('ne recrée pas de doublon (idempotence par stripePaymentIntentId)', async () => {
      mockWebhookEvent('pi_existing', WEBHOOK_METADATA);
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-existing',
        restaurantId: RESTAURANT_ID,
        code: 'old-1234-5678-9012',
        amount: d(120),
        remainingAmount: d(120),
        status: 'ACTIVE',
        stripePaymentIntentId: 'pi_existing',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.succeeded' },
      });

      expect(res.statusCode).toBe(200);
      // La carte ne doit pas être recréée
      expect(db.giftCard.create).not.toHaveBeenCalled();
    });

    it('retourne 200 sans recréer si les metadata sont incomplètes', async () => {
      mockWebhookEvent('pi_incomplete', { restaurantId: RESTAURANT_ID });
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.succeeded' },
      });

      expect(res.statusCode).toBe(200);
      expect(db.giftCard.create).not.toHaveBeenCalled();
    });

    it('retourne 429 quand la limite webhook est dépassée', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue(false);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.succeeded' },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: 'Trop de requêtes. Réessayez dans une minute.' });

      // Restore default mock behavior for following tests
      vi.mocked(checkRateLimit).mockResolvedValue(true);
    });

    it('retourne 400 sans stripe-signature header', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: { 'content-type': 'application/json' },
        payload: { type: 'payment_intent.succeeded' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('retourne 200 pour un webhook payment_intent.payment_failed et met à jour la carte', async () => {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_failed', metadata: { restaurantId: RESTAURANT_ID } } },
      } as unknown as Awaited<ReturnType<typeof constructWebhookEvent>>);
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-failed',
        stripePaymentIntentId: 'pi_failed',
        stripePaymentStatus: 'pending',
        status: 'ACTIVE',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);
      vi.mocked(db.giftCard.update).mockResolvedValue({
        id: 'gc-failed',
        stripePaymentStatus: 'failed',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.update>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.payment_failed' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect(db.giftCard.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'gc-failed' },
          data: { stripePaymentStatus: 'failed' },
        }),
      );
    });

    it('retourne 200 pour payment_intent.payment_failed sans carte existante', async () => {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_failed_unknown', metadata: {} } },
      } as unknown as Awaited<ReturnType<typeof constructWebhookEvent>>);
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'payment_intent.payment_failed' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect(db.giftCard.update).not.toHaveBeenCalled();
    });

    it('retourne 200 pour un event Stripe non géré et log', async () => {
      vi.mocked(constructWebhookEvent).mockResolvedValue({
        type: 'invoice.payment_succeeded',
        data: { object: { id: 'inv_test' } },
      } as unknown as Awaited<ReturnType<typeof constructWebhookEvent>>);
      const infoSpy = vi.spyOn(logger, 'info');

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/stripe',
        headers: {
          'stripe-signature': 't=123,v1=fake',
          'content-type': 'application/json',
        },
        payload: { type: 'invoice.payment_succeeded' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ received: true });
      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'invoice.payment_succeeded' }),
        '[gift-card-routes] Unhandled Stripe webhook event type',
      );

      infoSpy.mockRestore();
    });
  });

  // ─── P3 — Crowdfunding ───────────────────────────────────────────
  describe('crowdfunding routes', () => {
    const CROWDFUNDING_CODE = 'crowd-test-code';
    const FUTURE_DATE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    beforeEach(() => {
      vi.mocked(db.giftCard.create).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        amount: d(0),
        remainingAmount: d(0),
        currency: 'EUR',
        status: 'ACTIVE',
        type: 'CROWDFUNDED',
        targetAmount: null,
        crowdfundedUntil: new Date(FUTURE_DATE),
        closedAt: null,
        purchasedAt: new Date(),
        expiresAt: null,
        validityMonths: 12,
        packId: null,
        preferredDate: null,
        preferredTime: null,
        preferredPartySize: null,
        senderName: 'Jean',
        senderEmail: 'jean@example.com',
        senderPhone: null,
        recipientName: 'Marie',
        recipientEmail: 'marie@example.com',
        recipientPhone: null,
        message: null,
        occasion: 'Cagnotte anniversaire Marie',
        customerId: null,
        createdBy: 'CLIENT',
        purchaseReference: 'crowdfunding',
        stripePaymentIntentId: null,
        stripePaymentStatus: 'pending',
        templateId: null,
        customImageUrl: null,
        sokarCommissionAmount: d(0),
      } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);
    });

    it('crée une cagnotte via POST /public/gift-cards/crowdfunding', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/crowdfunding',
        headers: { 'content-type': 'application/json' },
        payload: {
          restaurantId: RESTAURANT_ID,
          title: 'Cagnotte anniversaire Marie',
          recipientName: 'Marie',
          recipientEmail: 'marie@example.com',
          creatorName: 'Jean',
          creatorEmail: 'jean@example.com',
          crowdfundedUntil: FUTURE_DATE,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.code).toBe(CROWDFUNDING_CODE);
      expect(body.type).toBe('CROWDFUNDED');
      expect(body.title).toBe('Cagnotte anniversaire Marie');
      expect(db.giftCard.create).toHaveBeenCalled();
    });

    it('retourne 400 si la date butoir est dans le passé', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/crowdfunding',
        headers: { 'content-type': 'application/json' },
        payload: {
          restaurantId: RESTAURANT_ID,
          title: 'Test',
          recipientName: 'Marie',
          creatorName: 'Jean',
          creatorEmail: 'jean@example.com',
          crowdfundedUntil: '2020-01-01T00:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('retourne le statut public d une cagnotte', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        amount: d(0),
        remainingAmount: d(0),
        status: 'ACTIVE',
        type: 'CROWDFUNDED',
        targetAmount: null,
        crowdfundedUntil: new Date(FUTURE_DATE),
        closedAt: null,
        occasion: 'Cagnotte anniversaire Marie',
        senderName: 'Jean',
        senderEmail: 'jean@example.com',
        recipientName: 'Marie',
        message: 'Un message',
        contributions: [],
        restaurant: { name: 'Test Resto' },
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/public/gift-cards/crowdfunding/${CROWDFUNDING_CODE}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.code).toBe(CROWDFUNDING_CODE);
      expect(body.title).toBe('Cagnotte anniversaire Marie');
      expect(body.recipientName).toBe('Marie');
      expect(body.collectedAmount).toBe(0);
      expect(body.contributionsCount).toBe(0);
      expect(body.status).toBe('ACTIVE');
    });

    it('retourne 404 pour une cagnotte inexistante', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue(null);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/public/gift-cards/crowdfunding/nonexistent',
      });

      expect(res.statusCode).toBe(404);
    });

    it('crée un payment intent pour une contribution', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'ACTIVE',
        crowdfundedUntil: new Date(FUTURE_DATE),
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/public/gift-cards/crowdfunding/${CROWDFUNDING_CODE}/payment-intent`,
        headers: { 'content-type': 'application/json' },
        payload: {
          amount: 20,
          contributorName: 'Paul',
          contributorEmail: 'paul@example.com',
          isPublicName: true,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.paymentIntentId).toBe('pi_test');
      expect(body.clientSecret).toBe('pi_t_s');
    });

    it('refuse un payment intent si la cagnotte est clôturée', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'CLOSED',
        crowdfundedUntil: new Date(FUTURE_DATE),
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/public/gift-cards/crowdfunding/${CROWDFUNDING_CODE}/payment-intent`,
        headers: { 'content-type': 'application/json' },
        payload: {
          amount: 20,
          contributorName: 'Paul',
          isPublicName: true,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('refuse un payment intent si la deadline est dépassée', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'ACTIVE',
        crowdfundedUntil: new Date('2020-01-01'),
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/public/gift-cards/crowdfunding/${CROWDFUNDING_CODE}/payment-intent`,
        headers: { 'content-type': 'application/json' },
        payload: {
          amount: 20,
          contributorName: 'Paul',
          isPublicName: true,
        },
      });

      expect(res.statusCode).toBe(400);
    });

    it('confirme une contribution via POST /contribute', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'ACTIVE',
        crowdfundedUntil: new Date(FUTURE_DATE),
        occasion: 'Cagnotte',
        senderName: 'Jean',
        senderEmail: 'jean@example.com',
        recipientName: 'Marie',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 2000,
        amountReceived: 2000,
        currency: 'eur',
        metadata: {
          type: 'crowdfunding_contribution',
          giftCardCode: CROWDFUNDING_CODE,
          amount: '20',
        },
      });
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        name: 'Test Resto',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.giftCardContribution.create).mockResolvedValue({
        id: 'contrib-1',
        giftCardId: 'gc-crowd-1',
        contributorName: 'Paul',
        contributorEmail: 'paul@example.com',
        amount: d(20),
        contributedAt: new Date(),
        stripePaymentIntentId: 'pi_test',
        isPublicName: true,
        message: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCardContribution.create>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/public/gift-cards/crowdfunding/${CROWDFUNDING_CODE}/contribute`,
        headers: { 'content-type': 'application/json' },
        payload: {
          paymentIntentId: 'pi_test',
          contributorName: 'Paul',
          contributorEmail: 'paul@example.com',
          amount: 20,
          isPublicName: true,
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe('contrib-1');
      expect(body.amount).toBe(20);
      expect(db.giftCardContribution.create).toHaveBeenCalled();
    });

    it('clôture une cagnotte via POST /api/gift-cards/:id/close', async () => {
      const contributions = [
        { id: 'c1', amount: d(50), stripePaymentIntentId: 'pi_1' },
        { id: 'c2', amount: d(30), stripePaymentIntentId: 'pi_2' },
      ];

      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'ACTIVE',
        amount: d(0),
        remainingAmount: d(0),
        occasion: 'Cagnotte',
        recipientName: 'Marie',
        recipientEmail: 'marie@example.com',
        recipientPhone: '+33612345678',
        contributions,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        name: 'Test Resto',
        giftCardCommissionRate: d(0.05),
        managerEmail: 'manager@test.com',
        managerPhone: '+33100000000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.giftCard.update).mockResolvedValue({
        id: 'gc-crowd-1',
        restaurantId: RESTAURANT_ID,
        code: CROWDFUNDING_CODE,
        type: 'CROWDFUNDED',
        status: 'ACTIVE',
        amount: d(80), // 80 - 4 (5% commission)
        remainingAmount: d(80),
        currency: 'EUR',
        sokarCommissionAmount: d(4),
        closedAt: new Date(),
        purchasedAt: new Date(),
        expiresAt: null,
        validityMonths: 12,
        packId: null,
        preferredDate: null,
        preferredTime: null,
        preferredPartySize: null,
        senderName: 'Jean',
        senderEmail: 'jean@example.com',
        senderPhone: null,
        recipientName: 'Marie',
        recipientEmail: 'marie@example.com',
        recipientPhone: '+33612345678',
        message: null,
        occasion: 'Cagnotte',
        customerId: null,
        createdBy: 'CLIENT',
        purchaseReference: 'crowdfunding',
        stripePaymentIntentId: null,
        stripePaymentStatus: 'pending',
        templateId: null,
        customImageUrl: null,
        targetAmount: null,
        crowdfundedUntil: new Date(FUTURE_DATE),
      } as unknown as Awaited<ReturnType<typeof db.giftCard.update>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: `/api/gift-cards/gc-crowd-1/close?restaurantId=${RESTAURANT_ID}`,
        headers: { ...AUTH },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.type).toBe('CROWDFUNDED');
      expect(body.amount).toBe(80);
      expect(body.sokarCommissionAmount).toBe(4);
      expect(body.status).toBe('ACTIVE');
      expect(db.giftCard.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'gc-crowd-1', restaurantId: RESTAURANT_ID },
          data: expect.objectContaining({
            status: 'ACTIVE',
            sokarCommissionAmount: d(4),
          }),
        }),
      );
    });
  });

  // ─── Rate limiting ───────────────────────────────────────────────
  describe('rate limiting', () => {
    it('retourne 429 quand la limite est dépassée sur /payment-intent', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue(false);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/payment-intent',
        headers: { 'content-type': 'application/json' },
        payload: {
          restaurantId: RESTAURANT_ID,
          amount: 50,
        },
      });

      expect(res.statusCode).toBe(429);
      expect(res.json().error).toMatch(/Trop de requêtes/);

      // Restaurer le mock pour les autres tests
      vi.mocked(checkRateLimit).mockResolvedValue(true);
    });

    it('retourne 429 quand la limite est dépassée sur crowdfunding/:code/payment-intent', async () => {
      vi.mocked(checkRateLimit).mockResolvedValue(false);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/crowdfunding/test-code/payment-intent',
        headers: { 'content-type': 'application/json' },
        payload: {
          amount: 20,
          contributorName: 'Paul',
          isPublicName: true,
        },
      });

      expect(res.statusCode).toBe(429);

      // Restaurer le mock pour les autres tests
      vi.mocked(checkRateLimit).mockResolvedValue(true);
    });
  });

  // ─── shortCode ───────────────────────────────────────────────────
  describe('shortCode', () => {
    it('GET /public/gift-cards/:shortCode/pdf fonctionne avec un shortCode', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-sc-1',
        restaurantId: RESTAURANT_ID,
        code: 'uuid-1234',
        shortCode: 'SKR-TEST-01',
        amount: d(100),
        remainingAmount: d(100),
        status: 'ACTIVE',
        currency: 'EUR',
        validityMonths: 12,
        purchasedAt: new Date(),
        expiresAt: null,
        packId: null,
        preferredDate: null,
        preferredTime: null,
        preferredPartySize: null,
        senderName: 'Bob',
        senderEmail: 'bob@example.com',
        senderPhone: null,
        recipientName: 'Alice',
        recipientEmail: 'alice@example.com',
        recipientPhone: null,
        message: null,
        occasion: null,
        customerId: null,
        createdBy: 'CLIENT',
        purchaseReference: null,
        stripePaymentIntentId: null,
        stripePaymentStatus: 'succeeded',
        templateId: null,
        customImageUrl: null,
        sokarCommissionAmount: d(5),
        type: 'SINGLE',
        targetAmount: null,
        crowdfundedUntil: null,
        closedAt: null,
        restaurant: { name: 'Test Resto' },
        pack: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/public/gift-cards/SKR-TEST-01/pdf',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      // Vérifier que findUnique a été appelé avec shortCode
      expect(db.giftCard.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { shortCode: 'SKR-TEST-01' },
        }),
      );
    });

    it('POST /public/gift-cards/check fonctionne avec un shortCode', async () => {
      vi.mocked(db.giftCard.findUnique).mockResolvedValue({
        id: 'gc-sc-1',
        restaurantId: RESTAURANT_ID,
        code: 'uuid-1234',
        shortCode: 'SKR-TEST-01',
        amount: d(100),
        remainingAmount: d(100),
        status: 'ACTIVE',
        expiresAt: null,
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findUnique>>);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        name: 'Test Resto',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/public/gift-cards/check',
        headers: { 'content-type': 'application/json' },
        payload: { code: 'SKR-TEST-01' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.giftCard.amount).toBe(100);
    });

    it('serializeGiftCard inclut shortCode', async () => {
      vi.mocked(db.giftCard.findMany).mockResolvedValue([
        {
          id: 'gc-1',
          restaurantId: RESTAURANT_ID,
          code: 'abc-1234-5678-9012',
          shortCode: 'SKR-X7F2-9K',
          amount: d(100),
          remainingAmount: d(100),
          currency: 'EUR',
          status: 'ACTIVE',
          createdBy: 'DASHBOARD',
          purchaseReference: 'manual',
          redemptions: [],
          contributions: [],
        } as unknown as Awaited<ReturnType<typeof db.giftCard.findMany>>[number],
      ]);
      vi.mocked(db.giftCard.count).mockResolvedValue(1);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: `/restaurants/${RESTAURANT_ID}/gift-cards`,
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items[0].shortCode).toBe('SKR-X7F2-9K');
    });
  });
  it('exposes a beneficiary balance without sender or recipient contact details', async () => {
    vi.mocked(db.giftCard.findUnique).mockResolvedValue({
      id: 'gift',
      restaurantId: RESTAURANT_ID,
      code: 'gift-code',
      shortCode: 'SKR-TEST-01',
      amount: d(100),
      remainingAmount: d(75),
      status: 'ACTIVE',
      expiresAt: null,
      senderEmail: 'private-sender',
      recipientEmail: 'private-recipient',
      recipientName: 'Private recipient',
      stripePaymentIntentId: null,
      pack: null,
    } as never);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      name: 'Restaurant public',
      slug: 'test-resto',
    } as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/public/gift-cards/SKR-TEST-01/beneficiary',
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({
      remainingAmount: 75,
      usable: true,
      restaurantSlug: 'test-resto',
    });
    expect(response.body).not.toContain('private-');
    expect(response.body).not.toContain('Private recipient');
  });

  it('requires restaurant authentication for a real debit', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/public/gift-cards/apply',
      payload: {
        code: 'gift-code',
        restaurantId: RESTAURANT_ID,
        reservationId: 'reservation',
        reservationAmount: 20,
      },
    });
    expect(response.statusCode).toBe(401);
    expect(db.giftCardRedemption.create).not.toHaveBeenCalled();
  });
});
