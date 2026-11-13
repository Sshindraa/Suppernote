import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, ReservationPaymentStatus } from '@prisma/client';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { constructWebhookEvent, retrievePaymentIntent } from '../../gift-cards/stripe.service';

const META = {
  type: 'reservation_guarantee',
  restaurantId: 'test-rest-1',
  reservationPaymentId: 'payment-1',
  reservationId: 'reservation-1',
};

function guaranteeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'payment-1',
    restaurantId: 'test-rest-1',
    reservationId: 'reservation-1',
    policyId: 'policy-1',
    status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
    amount: new Prisma.Decimal('120.00'),
    currency: 'EUR',
    stripeAccountId: 'acct_resto',
    stripeSetupIntentId: null,
    stripePaymentIntentId: null,
    stripeCustomerId: 'cus_1',
    stripePaymentMethodId: null,
    stripeCheckoutSessionId: 'cs_1',
    capturedAmount: null,
    refundedAmount: null,
    termsAcceptedAt: null,
    disputeStatus: null,
    idempotencyKey: 'payment-key-1',
    policySnapshot: { type: 'CARD_GUARANTEE' },
    expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    failureCode: null,
    lastProviderEventAt: null,
    createdAt: new Date('2026-11-13T10:00:00.000Z'),
    updatedAt: new Date('2026-11-13T10:00:00.000Z'),
    ...overrides,
  };
}

function stripeEvent(type: string, object: Record<string, unknown>, account = 'acct_resto') {
  vi.mocked(constructWebhookEvent).mockResolvedValueOnce({
    id: `evt_${type}`,
    created: 1_794_000_000,
    type,
    account,
    data: { object },
  } as never);
}

async function postWebhook() {
  const app = await getApp();
  return app.inject({
    method: 'POST',
    url: '/webhooks/stripe',
    headers: { 'stripe-signature': 't=1,v1=test', 'content-type': 'application/json' },
    payload: '{}',
  });
}

describe('empreinte bancaire via /webhooks/stripe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.reservationPaymentEvent.findUnique).mockResolvedValue(null);
    vi.mocked(db.reservationPaymentEvent.create).mockResolvedValue({ id: 'event-row' } as never);
    vi.mocked(db.reservationPayment.update).mockResolvedValue({} as never);
  });

  afterAll(async () => {
    await closeApp();
  });

  it('enregistre la carte, confirme la réservation tenue et ne touche pas aux cartes cadeaux', async () => {
    stripeEvent('setup_intent.succeeded', {
      id: 'seti_1',
      customer: 'cus_1',
      payment_method: 'pm_1',
      metadata: META,
    });
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guaranteeRow() as never);
    vi.mocked(db.reservation.findUnique).mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'test-rest-1',
      partySize: 6,
      reservedAt: new Date('2026-11-20T19:00:00.000Z'),
      startsAt: new Date('2026-11-20T19:00:00.000Z'),
      endsAt: new Date('2026-11-20T21:00:00.000Z'),
      tableId: null,
      status: 'CONFIRMED',
      state: 'PENDING',
      consumedHoldId: null,
    } as never);
    vi.mocked(db.reservation.update).mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'test-rest-1',
      status: 'CONFIRMED',
      state: 'CONFIRMED',
    } as never);
    vi.mocked(db.reservationAuditLog.create).mockResolvedValue({ id: 'audit-1' } as never);

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({
        status: ReservationPaymentStatus.AUTHORIZED,
        stripeSetupIntentId: 'seti_1',
        stripePaymentMethodId: 'pm_1',
        stripeCustomerId: 'cus_1',
      }),
    });
    expect(db.reservation.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'CONFIRMED' }) }),
    );
  });

  it('acquitte sans rien écrire un événement venant d’un autre compte Stripe', async () => {
    stripeEvent(
      'setup_intent.succeeded',
      { id: 'seti_1', customer: 'cus_1', payment_method: 'pm_1', metadata: META },
      'acct_other',
    );
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(guaranteeRow() as never);

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).not.toHaveBeenCalled();
    expect(db.reservationPaymentEvent.create).not.toHaveBeenCalled();
  });

  it('ne rejoue pas un événement déjà reçu', async () => {
    stripeEvent('setup_intent.succeeded', { id: 'seti_1', payment_method: 'pm_1', metadata: META });
    vi.mocked(db.reservationPaymentEvent.findUnique).mockResolvedValue({
      id: 'event-row',
      paymentId: 'payment-1',
      resultingStatus: ReservationPaymentStatus.AUTHORIZED,
    } as never);

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).not.toHaveBeenCalled();
  });

  it('passe en prélevé avec un montant inférieur à l’empreinte', async () => {
    stripeEvent('payment_intent.succeeded', {
      id: 'pi_capture',
      amount: 6000,
      amount_received: 6000,
      currency: 'eur',
      metadata: META,
    });
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guaranteeRow({
        status: ReservationPaymentStatus.AUTHORIZED,
        stripePaymentMethodId: 'pm_1',
      }) as never,
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({
        status: ReservationPaymentStatus.CAPTURED,
        stripePaymentIntentId: 'pi_capture',
        capturedAmount: new Prisma.Decimal('60'),
        failureCode: null,
      }),
    });
  });

  it('refuse un prélèvement supérieur à l’empreinte annoncée', async () => {
    stripeEvent('payment_intent.succeeded', {
      id: 'pi_capture',
      amount_received: 15000,
      currency: 'eur',
      metadata: META,
    });
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guaranteeRow({ status: ReservationPaymentStatus.AUTHORIZED }) as never,
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).not.toHaveBeenCalled();
  });

  it('garde la carte enregistrée quand la banque refuse le prélèvement', async () => {
    stripeEvent('payment_intent.payment_failed', {
      id: 'pi_capture',
      amount: 12000,
      currency: 'eur',
      last_payment_error: { code: 'card_declined', decline_code: 'insufficient_funds' },
      metadata: META,
    });
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guaranteeRow({
        status: ReservationPaymentStatus.AUTHORIZED,
        stripePaymentIntentId: 'pi_capture',
      }) as never,
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({
        status: ReservationPaymentStatus.AUTHORIZED,
        failureCode: 'insufficient_funds',
      }),
    });
  });

  it('rattache un remboursement partiel par le PaymentIntent enregistré', async () => {
    stripeEvent('charge.refunded', {
      id: 'ch_1',
      amount: 6000,
      amount_refunded: 2000,
      currency: 'eur',
      payment_intent: 'pi_capture',
    });
    vi.mocked(db.reservationPayment.findUnique).mockResolvedValue({
      id: 'payment-1',
      restaurantId: 'test-rest-1',
    } as never);
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guaranteeRow({
        status: ReservationPaymentStatus.CAPTURED,
        stripePaymentIntentId: 'pi_capture',
        capturedAmount: new Prisma.Decimal('60.00'),
      }) as never,
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: expect.objectContaining({
        status: ReservationPaymentStatus.PARTIALLY_REFUNDED,
        refundedAmount: new Prisma.Decimal('20'),
      }),
    });
    expect(retrievePaymentIntent).not.toHaveBeenCalled();
  });

  it('note un litige sans changer le statut du prélèvement', async () => {
    stripeEvent('charge.dispute.created', {
      id: 'dp_1',
      amount: 6000,
      currency: 'eur',
      status: 'needs_response',
      payment_intent: 'pi_capture',
    });
    vi.mocked(db.reservationPayment.findUnique).mockResolvedValue({
      id: 'payment-1',
      restaurantId: 'test-rest-1',
    } as never);
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      guaranteeRow({
        status: ReservationPaymentStatus.CAPTURED,
        stripePaymentIntentId: 'pi_capture',
        capturedAmount: new Prisma.Decimal('60.00'),
      }) as never,
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(200);
    expect(db.reservationPayment.update).toHaveBeenCalledWith({
      where: { id: 'payment-1' },
      data: { disputeStatus: 'needs_response' },
    });
  });

  it('laisse Stripe réessayer après une panne technique', async () => {
    stripeEvent('setup_intent.succeeded', { id: 'seti_1', payment_method: 'pm_1', metadata: META });
    vi.mocked(db.reservationPaymentEvent.findUnique).mockRejectedValueOnce(
      new Error('database unavailable'),
    );

    const response = await postWebhook();

    expect(response.statusCode).toBe(500);
  });
});
