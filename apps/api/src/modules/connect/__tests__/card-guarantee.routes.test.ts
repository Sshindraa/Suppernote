/**
 * Empreinte bancaire dans le tunnel Connect / widget : conditions affichées avant les
 * coordonnées, acceptation exigée, réservation tenue en attente de carte, page par jeton signé.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { Prisma, ReservationPaymentStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';

const guarantee = vi.hoisted(() => ({
  findCardGuaranteeTerms: vi.fn(),
  openCardGuaranteeCheckout: vi.fn(),
  createCardGuaranteePaymentInTransaction: vi.fn(),
}));
vi.mock('../../reservation-payments/reservation-guarantee.public', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  findCardGuaranteeTerms: guarantee.findCardGuaranteeTerms,
  openCardGuaranteeCheckout: guarantee.openCardGuaranteeCheckout,
}));
vi.mock('../../reservation-payments/reservation-payment.service', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createCardGuaranteePaymentInTransaction: guarantee.createCardGuaranteePaymentInTransaction,
}));
vi.mock('../../floor-plan/availability-capacity-aware.service', () => {
  const CapacityAwareAvailabilityService = vi.fn().mockImplementation(function (this: {
    getAvailability: ReturnType<typeof vi.fn>;
  }) {
    this.getAvailability = vi.fn();
  });
  (
    CapacityAwareAvailabilityService as unknown as { invalidateAvailability: Mock<() => unknown> }
  ).invalidateAvailability = vi.fn().mockResolvedValue(undefined);
  return {
    CapacityAwareAvailabilityService,
    DEFAULT_RESTAURANT_TIMEZONE: 'Europe/Paris',
    zonedTimeToUtc: vi.fn(),
    utcToZonedParts: vi.fn().mockImplementation((instant: Date) => ({
      date: instant.toISOString().slice(0, 10),
      time: instant.toISOString().slice(11, 16),
    })),
  };
});
vi.mock('../../floor-plan/table-allocation.service', () => ({
  TableAllocationService: vi.fn().mockImplementation(function (this: {
    allocate: ReturnType<typeof vi.fn>;
  }) {
    this.allocate = vi.fn().mockResolvedValue({ id: 'table-1' });
  }),
}));

import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import { ReservationService } from '../../agentic-reservations/core/reservation.service';
import { cardGuaranteeToken } from '../../reservation-payments/reservation-guarantee.public';

const SLUG = 'bistrot-garanti';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';
const PAYMENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HOLD_TOKEN = ['tok', 'guarantee'].join('-');
const TERMS = {
  policyId: 'policy-1',
  amountPerPerson: '20.00',
  totalAmount: '120.00',
  currency: 'EUR',
  cancellationHours: 24,
};

function publishedRestaurant() {
  vi.mocked(db.restaurant.findUnique).mockResolvedValue({
    id: RESTAURANT_ID,
    slug: SLUG,
    name: 'Bistrot Garanti',
    agenticOptIn: true,
    publishedAt: new Date('2026-06-24'),
    city: 'Lyon',
    country: 'FR',
    postalCode: '69001',
    formattedAddress: '12 Rue',
    phoneNumber: '+33400000000',
    priceRange: 2,
    openingHours: {},
    cuisineType: [],
    ambiance: [],
    dietary: [],
    images: [],
    timezone: 'Europe/Paris',
    exposureSettings: { connectPublished: true, connectAgentic: false },
  } as never);
  vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue({
    maxPartySize: 12,
    minLeadTimeMinutes: 30,
    quoteTtlSeconds: 300,
    holdTtlSeconds: 420,
    requireManualValidation: false,
    noShowPolicy: 'warning',
    notificationChannels: ['sms', 'email'],
    capacitySpecials: {},
  } as never);
}

let app: FastifyInstance;

describe('empreinte bancaire dans le tunnel public', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z'));
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'b'.repeat(64));
    vi.stubEnv('DASHBOARD_URL', 'https://suppernote.test');
    await redisCache.flushall();
    publishedRestaurant();
    app = await getApp();
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(async () => {
    vi.useRealTimers();
    await closeApp();
  });

  it('annonce les conditions sans identifiant interne', async () => {
    guarantee.findCardGuaranteeTerms.mockResolvedValue(TERMS);
    const res = await app.inject({
      method: 'GET',
      url: `/public/r/${SLUG}/card-guarantee?date=2026-06-29&partySize=6`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      cardGuarantee: {
        amountPerPerson: '20.00',
        totalAmount: '120.00',
        currency: 'EUR',
        cancellationHours: 24,
      },
      bookingUrl: expect.stringMatching(/\/book\/bistrot-garanti$/),
    });
    expect(res.json().cardGuarantee).not.toHaveProperty('policyId');
  });

  describe('POST /confirm', () => {
    const reservationId = randomUUID();

    beforeEach(() => {
      guarantee.findCardGuaranteeTerms.mockResolvedValue(TERMS);
      vi.mocked(db.customerConsent.create).mockResolvedValue({ id: 'consent-1' } as never);
      vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
        id: 'hold-1',
        holdToken: HOLD_TOKEN,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60_000),
        restaurantId: RESTAURANT_ID,
        partySize: 6,
        slotStart: new Date('2026-06-29T19:00:00Z'),
        slotEnd: new Date('2026-06-29T21:00:00Z'),
        tableId: null,
      } as never);
    });

    const confirm = (extra: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        payload: {
          holdToken: HOLD_TOKEN,
          customer: { firstName: 'Alice', phone: '+33612345678' },
          ...extra,
        },
      });

    it('refuse sans acceptation du montant affiché, sans rien créer', async () => {
      const create = vi.spyOn(ReservationService.prototype, 'createReservation');
      const missing = await confirm();
      const stale = await confirm({ cardGuarantee: { accepted: true, totalAmount: '100.00' } });
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({
        error: 'card_guarantee_required',
        cardGuarantee: { totalAmount: '120.00' },
      });
      expect(stale.statusCode).toBe(409);
      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
    });

    it('tient la place en attente de carte et renvoie la page Stripe', async () => {
      guarantee.createCardGuaranteePaymentInTransaction.mockResolvedValue(PAYMENT_ID);
      vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({
        id: PAYMENT_ID,
        restaurantId: RESTAURANT_ID,
        amount: new Prisma.Decimal('120.00'),
        expiresAt: new Date('2026-06-25T10:30:00.000Z'),
      } as never);
      guarantee.openCardGuaranteeCheckout.mockResolvedValue({
        url: 'https://checkout.stripe.test/cs_1',
        expiresAt: new Date('2026-06-25T10:30:00.000Z'),
      });
      const create = vi
        .spyOn(ReservationService.prototype, 'createReservation')
        .mockImplementation(async (input) => {
          await input.awaitingCardGuarantee?.({} as Prisma.TransactionClient, reservationId);
          return { reservationId, state: 'PENDING', reused: false };
        });

      const res = await confirm({ cardGuarantee: { accepted: true, totalAmount: '120.00' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        reservationId,
        status: 'awaiting_card_guarantee',
        state: 'PENDING',
        cardGuarantee: {
          checkoutUrl: 'https://checkout.stripe.test/cs_1',
          totalAmount: '120.00',
          cancellationHours: 24,
          expiresAt: '2026-06-25T10:30:00.000Z',
        },
      });
      expect(res.json().cardGuarantee.pageUrl).toMatch(
        /^https:\/\/suppernote\.test\/garantie\?r=bistrot-garanti&t=[0-9a-f]{32}\.[\w-]{43}$/,
      );
      expect(guarantee.createCardGuaranteePaymentInTransaction).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          restaurantId: RESTAURANT_ID,
          reservationId,
          policyId: 'policy-1',
          partySize: 6,
          expiresAt: new Date('2026-06-25T10:30:00.000Z'),
        }),
      );
      create.mockRestore();
    });

    it('garde la réservation tenue si Stripe ne répond pas', async () => {
      guarantee.createCardGuaranteePaymentInTransaction.mockResolvedValue(PAYMENT_ID);
      vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({
        id: PAYMENT_ID,
        restaurantId: RESTAURANT_ID,
        amount: new Prisma.Decimal('120.00'),
        expiresAt: new Date('2026-06-25T10:30:00.000Z'),
      } as never);
      guarantee.openCardGuaranteeCheckout.mockRejectedValue(new Error('stripe down'));
      const create = vi
        .spyOn(ReservationService.prototype, 'createReservation')
        .mockImplementation(async (input) => {
          await input.awaitingCardGuarantee?.({} as Prisma.TransactionClient, reservationId);
          return { reservationId, state: 'PENDING', reused: false };
        });

      const res = await confirm({ cardGuarantee: { accepted: true, totalAmount: '120.00' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        status: 'awaiting_card_guarantee',
        cardGuarantee: { checkoutUrl: null },
      });
      create.mockRestore();
    });
  });

  describe('page par jeton', () => {
    const token = () => cardGuaranteeToken({ id: PAYMENT_ID, restaurantId: RESTAURANT_ID })!;

    beforeEach(() => {
      vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({
        id: PAYMENT_ID,
        restaurantId: RESTAURANT_ID,
        status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
        amount: new Prisma.Decimal('120.00'),
        expiresAt: new Date('2026-06-25T12:00:00.000Z'),
        policySnapshot: { type: 'CARD_GUARANTEE', cancellationHours: 24 },
        reservation: {
          partySize: 6,
          startsAt: new Date('2026-06-29T19:00:00.000Z'),
          reservedAt: new Date('2026-06-29T19:00:00.000Z'),
        },
      } as never);
    });

    it('montre l’état sans nom ni téléphone', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/card-guarantee/${token()}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'awaiting_card',
        restaurantName: 'Bistrot Garanti',
        date: '2026-06-29',
        time: '19:00',
        partySize: 6,
        amountPerPerson: '20.00',
        totalAmount: '120.00',
        cancellationHours: 24,
        freeCancellationUntil: '2026-06-28T19:00:00.000Z',
        expiresAt: '2026-06-25T12:00:00.000Z',
      });
    });

    it('refuse un jeton signé pour un autre restaurant', async () => {
      const foreign = cardGuaranteeToken({ id: PAYMENT_ID, restaurantId: 'other-restaurant' })!;
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/card-guarantee/${foreign}`,
      });
      expect(res.statusCode).toBe(404);
    });

    it('rouvre la page Stripe seulement avec l’acceptation', async () => {
      guarantee.openCardGuaranteeCheckout.mockResolvedValue({
        url: 'https://checkout.stripe.test/cs_2',
        expiresAt: new Date('2026-06-25T12:00:00.000Z'),
      });
      const refused = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/card-guarantee/${token()}/checkout`,
        payload: {},
      });
      const opened = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/card-guarantee/${token()}/checkout`,
        payload: { accepted: true },
      });
      expect(refused.statusCode).toBe(400);
      expect(opened.statusCode).toBe(200);
      expect(opened.json()).toEqual({ checkoutUrl: 'https://checkout.stripe.test/cs_2' });
    });
  });
});
