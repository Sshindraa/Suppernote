import { Prisma, ReservationPaymentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripe = vi.hoisted(() => ({
  createReservationGuaranteeSetupSession: vi.fn(),
  chargeReservationGuarantee: vi.fn(),
  createRefund: vi.fn(),
  expireExperienceCheckoutSession: vi.fn(),
  retrieveConnectedAccount: vi.fn(),
}));
vi.mock('../../gift-cards/stripe.service', () => stripe);

import { db } from '../../../shared/db/client';
import {
  captureCardGuarantee,
  expireReservationPayments,
  refundCardGuarantee,
  startCardGuaranteeSetup,
} from '../reservation-payment.service';

const NOW = new Date('2026-11-21T10:00:00.000Z');
const UPDATED_AT = new Date('2026-11-20T22:00:00.000Z');

function guarantee(overrides: Record<string, unknown> = {}) {
  const { reservation, ...rest } = overrides;
  return {
    id: 'payment-1',
    restaurantId: 'rest-1',
    reservationId: 'reservation-1',
    policyId: 'policy-1',
    status: ReservationPaymentStatus.AUTHORIZED,
    amount: new Prisma.Decimal('120.00'),
    currency: 'EUR',
    stripeAccountId: 'acct_resto',
    stripeSetupIntentId: 'seti_1',
    stripePaymentIntentId: null,
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: 'pm_1',
    stripeCheckoutSessionId: 'cs_1',
    capturedAmount: null,
    refundedAmount: null,
    termsAcceptedAt: null,
    disputeStatus: null,
    idempotencyKey: 'key-1',
    policySnapshot: { type: 'CARD_GUARANTEE' },
    expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    failureCode: null,
    lastProviderEventAt: null,
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    reservation: {
      status: 'NO_SHOW',
      state: 'NO_SHOW',
      startsAt: new Date('2026-11-20T19:00:00.000Z'),
      reservedAt: new Date('2026-11-20T19:00:00.000Z'),
      customerEmail: 'client@example.test',
      ...(reservation as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

const CAPTURE = { restaurantId: 'rest-1', reservationId: 'reservation-1', actorUserId: 'user-1' };

describe('empreinte bancaire : prélèvement et remboursement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.reservationPayment.update).mockResolvedValue({} as never);
  });

  it('prélève après une absence avec une clé qui dédoublonne le double clic', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guarantee() as never);
    stripe.chargeReservationGuarantee.mockResolvedValue({
      ok: true,
      paymentIntentId: 'pi_1',
      status: 'succeeded',
    });

    const result = await captureCardGuarantee({ ...CAPTURE, amount: '60', now: NOW });

    expect(result).toEqual({ outcome: 'PENDING_CONFIRMATION', amount: '60.00' });
    expect(stripe.chargeReservationGuarantee).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: 'acct_resto',
        amountCents: 6000,
        idempotencyKey: `reservation-guarantee-capture:payment-1:${UPDATED_AT.getTime()}`,
        metadata: expect.objectContaining({ type: 'reservation_guarantee' }),
      }),
    );
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1', restaurantId: 'rest-1' },
      data: {
        stripePaymentIntentId: 'pi_1',
        capturedAmount: new Prisma.Decimal('60'),
        capturedByUserId: 'user-1',
        failureCode: null,
      },
    });
  });

  it.each([
    ['réservation honorée', { reservation: { status: 'CONFIRMED' } }, NOW],
    [
      'carte pas encore enregistrée',
      { status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD },
      NOW,
    ],
    ['plus de 7 jours après le service', {}, new Date('2026-11-27T19:00:01.000Z')],
  ])('refuse de prélever : %s', async (_label, overrides, now) => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guarantee(overrides) as never);
    await expect(captureCardGuarantee({ ...CAPTURE, now })).rejects.toMatchObject({
      code: 'PAYMENT_CAPTURE_NOT_ALLOWED',
    });
    expect(stripe.chargeReservationGuarantee).not.toHaveBeenCalled();
  });

  it('refuse un montant supérieur à l’empreinte annoncée', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guarantee() as never);
    await expect(captureCardGuarantee({ ...CAPTURE, amount: 150, now: NOW })).rejects.toMatchObject(
      { code: 'PAYMENT_AMOUNT_INVALID' },
    );
  });

  it('refuse un second prélèvement en attente de confirmation', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guarantee({
        capturedAmount: new Prisma.Decimal('120'),
        stripePaymentIntentId: 'pi_1',
      }) as never,
    );
    await expect(captureCardGuarantee({ ...CAPTURE, now: NOW })).rejects.toMatchObject({
      code: 'PAYMENT_CAPTURE_IN_PROGRESS',
    });
  });

  it('garde la carte et note le refus de la banque', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guarantee() as never);
    stripe.chargeReservationGuarantee.mockResolvedValue({
      ok: false,
      paymentIntentId: 'pi_declined',
      failureCode: 'authentication_required',
    });

    await expect(captureCardGuarantee({ ...CAPTURE, now: NOW })).resolves.toEqual({
      outcome: 'DECLINED',
      failureCode: 'authentication_required',
    });
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1', restaurantId: 'rest-1' },
      data: {
        stripePaymentIntentId: 'pi_declined',
        capturedAmount: null,
        failureCode: 'authentication_required',
      },
    });
  });

  it('rembourse au plus le reste prélevé', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guarantee({
        status: ReservationPaymentStatus.PARTIALLY_REFUNDED,
        stripePaymentIntentId: 'pi_1',
        capturedAmount: new Prisma.Decimal('60.00'),
        refundedAmount: new Prisma.Decimal('20.00'),
      }) as never,
    );
    stripe.createRefund.mockResolvedValue({ id: 're_1', amount: 4000, status: 'succeeded' });

    await expect(
      refundCardGuarantee({ restaurantId: 'rest-1', reservationId: 'reservation-1', amount: 41 }),
    ).rejects.toMatchObject({ code: 'PAYMENT_REFUND_NOT_ALLOWED' });
    await expect(
      refundCardGuarantee({ restaurantId: 'rest-1', reservationId: 'reservation-1' }),
    ).resolves.toEqual({ refundId: 're_1', amount: '40.00' });
    expect(stripe.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentIntentId: 'pi_1',
        amount: 4000,
        stripeAccountId: 'acct_resto',
      }),
    );
  });
});

describe('empreinte bancaire : page Stripe et expiration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.reservationPayment.update).mockResolvedValue({} as never);
  });

  const SETUP = {
    restaurantId: 'rest-1',
    paymentId: 'payment-1',
    successUrl: 'https://suppernote.test/ok',
    cancelUrl: 'https://suppernote.test/annule',
    customText: 'Aucun montant n’est débité aujourd’hui.',
    termsAcceptedAt: new Date('2026-11-13T10:59:00.000Z'),
    now: new Date('2026-11-13T11:00:00.000Z'),
  };

  it('refuse tant que le compte Stripe du restaurant ne peut pas encaisser', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guarantee({ status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD }) as never,
    );
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      giftCardStripeAccountId: 'acct_resto',
    } as never);
    stripe.retrieveConnectedAccount.mockResolvedValue({ chargesEnabled: false });

    await expect(startCardGuaranteeSetup(SETUP)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_NOT_READY',
    });
    expect(stripe.createReservationGuaranteeSetupSession).not.toHaveBeenCalled();
  });

  it('ouvre une page neuve, ferme la précédente et garde au moins 30 min chez Stripe', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guarantee({ status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD }) as never,
    );
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      giftCardStripeAccountId: 'acct_resto',
    } as never);
    stripe.retrieveConnectedAccount.mockResolvedValue({ chargesEnabled: true });
    stripe.expireExperienceCheckoutSession.mockResolvedValue({});
    stripe.createReservationGuaranteeSetupSession.mockResolvedValue({
      sessionId: 'cs_2',
      url: 'https://checkout.stripe.test/cs_2',
      customerId: 'cus_1',
    });

    await expect(startCardGuaranteeSetup(SETUP)).resolves.toEqual({
      url: 'https://checkout.stripe.test/cs_2',
      expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    });
    expect(stripe.expireExperienceCheckoutSession).toHaveBeenCalledWith('cs_1', 'acct_resto');
    expect(stripe.createReservationGuaranteeSetupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeCustomerId: 'cus_1',
        expiresAt: new Date('2026-11-13T12:00:00.000Z'),
      }),
    );
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1', restaurantId: 'rest-1' },
      data: {
        stripeAccountId: 'acct_resto',
        stripeCustomerId: 'cus_1',
        stripeCheckoutSessionId: 'cs_2',
        termsAcceptedAt: SETUP.termsAcceptedAt,
      },
    });
  });

  it('libère la place tenue et ferme la page Stripe à l’expiration', async () => {
    vi.mocked(db.reservationPayment.findMany).mockResolvedValue([
      {
        id: 'payment-1',
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        stripeAccountId: 'acct_resto',
        stripeCheckoutSessionId: 'cs_1',
      },
    ] as never);
    vi.mocked(db.reservationPayment.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.reservation.findUnique).mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'rest-1',
      partySize: 6,
      status: 'CONFIRMED',
      state: 'PENDING',
      startsAt: new Date('2026-11-20T19:00:00.000Z'),
      endsAt: new Date('2026-11-20T21:00:00.000Z'),
      reservedAt: new Date('2026-11-20T19:00:00.000Z'),
      tableId: null,
      consumedHoldId: null,
    } as never);
    vi.mocked(db.reservation.update).mockResolvedValue({
      id: 'reservation-1',
      state: 'EXPIRED',
    } as never);
    vi.mocked(db.reservationAuditLog.create).mockResolvedValue({ id: 'audit-1' } as never);
    stripe.expireExperienceCheckoutSession.mockResolvedValue({});

    await expect(expireReservationPayments(NOW)).resolves.toBe(1);
    expect(db.reservationPayment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        status: {
          in: [
            ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
            ReservationPaymentStatus.REQUIRES_ACTION,
          ],
        },
      },
      data: { status: ReservationPaymentStatus.EXPIRED },
    });
    expect(db.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'EXPIRED' }) }),
    );
    expect(stripe.expireExperienceCheckoutSession).toHaveBeenCalledWith('cs_1', 'acct_resto');
  });

  it('ne touche pas une empreinte confirmée entre-temps par le webhook', async () => {
    vi.mocked(db.reservationPayment.findMany).mockResolvedValue([
      {
        id: 'payment-1',
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        stripeAccountId: 'acct_resto',
        stripeCheckoutSessionId: 'cs_1',
      },
    ] as never);
    vi.mocked(db.reservationPayment.updateMany).mockResolvedValue({ count: 0 } as never);

    await expect(expireReservationPayments(NOW)).resolves.toBe(0);
    expect(db.reservation.update).not.toHaveBeenCalled();
    expect(stripe.expireExperienceCheckoutSession).not.toHaveBeenCalled();
  });
});
