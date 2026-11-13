import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { GiftCardCheckoutService } from '../gift-card-checkout.service';
import { GiftCardPaymentService } from '../gift-card-payment.service';
import { GiftCardOperationsService } from '../gift-card-operations.service';
import { GiftCardService } from '../gift-card.service';
import { GiftCardCrowdfundingService } from '../gift-card-crowdfunding.service';
import { GiftCardRefundService } from '../gift-card-refund.service';
import { giftCardHash } from '../gift-card-finance.util';
import { retrievePaymentIntent, createRefund, createPaymentIntent } from '../stripe.service';
import {
  enqueueGiftCardDelivery,
  processGiftCardDelivery,
  recoverGiftCardDeliveries,
} from '../gift-card-delivery.service';
import {
  retryGiftCardDelivery,
  resendGiftCardRecipient,
  resolveGiftCardDelivery,
} from '../gift-card-delivery-operations.service';
import { sendRecipientGiftCard } from '../gift-card-email.service';
vi.mock('../stripe.service', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  retrievePaymentIntent: vi.fn(),
  createRefund: vi.fn(),
  createPaymentIntent: vi.fn(),
  retrieveConnectedAccount: vi.fn(async (id: string) => ({
    id,
    chargesEnabled: true,
    payoutsEnabled: true,
    detailsSubmitted: true,
  })),
}));

import { generateUniqueShortCode } from '../gift-card-code.util';

const url = process.env.GIFT_CARD_FINANCE_TEST_DATABASE_URL;
const token = `${randomUUID()}${randomUUID()}`;
let prisma: PrismaClient;
let restaurantId: string;

// This suite must never write to a shared or remote database.
if (url) {
  const target = new URL(url);
  if (
    !['127.0.0.1', 'localhost'].includes(target.hostname) ||
    target.pathname !== '/sokar_gift_card_finance'
  ) {
    throw new Error('Gift card finance integration tests require the dedicated local database');
  }
}

describe.skipIf(!url)('gift card finance — real PostgreSQL transactions', () => {
  beforeAll(async () => {
    const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');
    prisma = new actual.PrismaClient({ datasources: { db: { url: url! } } });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(sendRecipientGiftCard).mockResolvedValue({
      outcome: 'success',
      provider: 'resend',
      channel: 'email',
      providerMessageId: 'provider-test',
    });
    vi.mocked(generateUniqueShortCode).mockImplementation(async () => `SKR-${randomUUID()}`);
    const restaurant = await prisma.restaurant.create({
      data: {
        name: 'Finance test',
        managerPhone: '',
        managerEmail: '',
        phoneNumber: randomUUID(),
        openingHours: {},
        giftCardEnabled: true,
        giftCardStripeAccountId: `acct_${randomUUID()}`,
      },
    });
    restaurantId = restaurant.id;
  });

  async function purchaseOrder() {
    const paymentIntentId = `pi_${randomUUID()}`;
    const payload = { restaurantId, amount: 100, recipientName: 'Snapshot recipient' };
    const order = await prisma.giftCardCheckout.create({
      data: {
        restaurantId,
        kind: 'PURCHASE',
        amountCents: 10000,
        commissionRate: 0.05,
        stripeAccountId: 'acct_test',
        payload,
        payloadHash: giftCardHash(JSON.stringify(payload)),
        accessTokenHash: giftCardHash(token),
        idempotencyKey: randomUUID(),
        stripePaymentIntentId: paymentIntentId,
      },
    });
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: paymentIntentId,
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      metadata: { checkoutId: order.id, restaurantId, type: 'gift_card_purchase' },
    });
    return { restaurantId, checkoutId: order.id, paymentIntentId, accessToken: token };
  }

  it('issues exactly one card when browser and webhook finalize simultaneously', async () => {
    const input = await purchaseOrder();
    const service = new GiftCardPaymentService(prisma);
    const [browser, webhook] = await Promise.all([
      service.purchaseWithPayment(input),
      service.purchaseWithPayment(input, { stripeAccountId: 'acct_test' }),
    ]);
    expect(browser.id).toBe(webhook.id);
    expect(browser.recipientName).toBe('Snapshot recipient');
    expect(await prisma.giftCard.count({ where: { restaurantId } })).toBe(1);
    expect(await prisma.giftCardPaymentEntry.count({ where: { restaurantId } })).toBe(1);
    await expect(service.purchaseWithPayment({ ...input, accessToken: 'wrong' })).rejects.toThrow(
      'Accès',
    );
  });

  async function reservation() {
    return prisma.reservation.create({
      data: {
        restaurantId,
        reservedAt: new Date(),
        partySize: 2,
        customerName: 'Finance test',
      },
    });
  }
  async function card() {
    return prisma.giftCard.create({
      data: { restaurantId, amount: 100, remainingAmount: 100, suppernoteCommissionAmount: 0 },
    });
  }

  it('rolls back financial issuance if its durable notification cannot be persisted', async () => {
    const input = await purchaseOrder();
    const blocked = prisma.$extends({
      query: {
        outboxEvent: {
          create() {
            throw new Error('outbox unavailable');
          },
        },
      },
    }) as unknown as PrismaClient;
    await expect(new GiftCardPaymentService(blocked).purchaseWithPayment(input)).rejects.toThrow(
      'outbox unavailable',
    );
    expect(await prisma.giftCard.count({ where: { restaurantId } })).toBe(0);
    expect(await prisma.giftCardDelivery.count({ where: { restaurantId } })).toBe(0);
    expect(await prisma.giftCardPaymentEntry.count({ where: { restaurantId } })).toBe(0);
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    expect(await prisma.giftCardDelivery.count({ where: { giftCardId: gift.id } })).toBe(5);
    const events = await prisma.outboxEvent.findMany({
      where: { restaurantId, topic: 'gift-card-delivery' },
    });
    expect(events).toHaveLength(5);
    for (const event of events)
      expect(Object.keys(event.payload as object)).toEqual(['deliveryId']);
    expect(sendRecipientGiftCard).not.toHaveBeenCalled();
  });

  it('allows one provider submission for simultaneous workers and ignores a completed replay', async () => {
    const gift = await card();
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { recipientEmail: 'recipient@example.invalid' },
    });
    const delivery = await prisma.$transaction((tx) =>
      enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: gift.id, kind: 'recipient_email' }),
    );
    await Promise.all([
      processGiftCardDelivery(prisma, delivery.id),
      processGiftCardDelivery(prisma, delivery.id),
    ]);
    await processGiftCardDelivery(prisma, delivery.id);
    expect(sendRecipientGiftCard).toHaveBeenCalledOnce();
    const stored = await prisma.giftCardDelivery.findUniqueOrThrow({ where: { id: delivery.id } });
    expect(stored).toMatchObject({
      status: 'SENT',
      attempts: 1,
      providerMessageId: 'provider-test',
    });
  });

  it('blocks resend after an ambiguous provider response and isolates manual retries by restaurant', async () => {
    const gift = await card();
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { recipientEmail: 'recipient@example.invalid' },
    });
    const delivery = await prisma.$transaction((tx) =>
      enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: gift.id, kind: 'recipient_email' }),
    );
    vi.mocked(sendRecipientGiftCard).mockRejectedValueOnce(
      Object.assign(new Error('lost response'), { code: 'ECONNRESET' }),
    );
    await processGiftCardDelivery(prisma, delivery.id);
    await processGiftCardDelivery(prisma, delivery.id);
    expect(sendRecipientGiftCard).toHaveBeenCalledOnce();
    expect(
      (await prisma.giftCardDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('UNKNOWN');
    await expect(
      retryGiftCardDelivery(prisma, restaurantId, gift.id, delivery.id, 'manager'),
    ).rejects.toThrow('ne peut pas');
    await expect(
      resendGiftCardRecipient(prisma, {
        restaurantId,
        giftCardId: gift.id,
        channel: 'email',
        idempotencyKey: randomUUID(),
        actor: 'manager',
      }),
    ).rejects.toThrow('incertain');
    await expect(
      retryGiftCardDelivery(prisma, randomUUID(), gift.id, delivery.id, 'manager'),
    ).rejects.toThrow('introuvable');
  });

  it('retries only a certain rejection and records a provider-checked manual resolution', async () => {
    const gift = await card();
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { recipientEmail: 'recipient@example.invalid' },
    });
    const delivery = await prisma.$transaction((tx) =>
      enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: gift.id, kind: 'recipient_email' }),
    );
    vi.mocked(sendRecipientGiftCard).mockRejectedValueOnce(
      Object.assign(new Error('provider rejected'), { statusCode: 400 }),
    );
    await expect(processGiftCardDelivery(prisma, delivery.id)).rejects.toThrow(
      'GIFT_CARD_DELIVERY_FAILED',
    );
    expect(
      (await prisma.giftCardDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('FAILED');
    const retries = await Promise.allSettled([
      retryGiftCardDelivery(prisma, restaurantId, gift.id, delivery.id, 'manager'),
      retryGiftCardDelivery(prisma, restaurantId, gift.id, delivery.id, 'manager'),
    ]);
    expect(retries.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    await processGiftCardDelivery(prisma, delivery.id);
    expect(sendRecipientGiftCard).toHaveBeenCalledTimes(2);
    await prisma.giftCardDelivery.update({
      where: { id: delivery.id },
      data: { status: 'UNKNOWN' },
    });
    await expect(
      resolveGiftCardDelivery(prisma, {
        restaurantId: randomUUID(),
        giftCardId: gift.id,
        deliveryId: delivery.id,
        actor: 'manager',
        resolution: 'accepted',
        providerCaseReference: 'case-test',
      }),
    ).rejects.toThrow('introuvable');
    await resolveGiftCardDelivery(prisma, {
      restaurantId,
      giftCardId: gift.id,
      deliveryId: delivery.id,
      actor: 'manager',
      resolution: 'accepted',
      providerCaseReference: 'case-test',
    });
    expect(
      (await prisma.giftCardDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).status,
    ).toBe('SENT');
    expect(
      await prisma.reservationAuditLog.count({
        where: {
          event: 'gift_card_delivery_resolved',
          metadata: { path: ['deliveryId'], equals: delivery.id },
        },
      }),
    ).toBe(1);
  });

  it('keeps an explicit recipient resend idempotent and blocks overlapping new resends', async () => {
    const gift = await card();
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { recipientEmail: 'recipient@example.invalid' },
    });
    const input = {
      restaurantId,
      giftCardId: gift.id,
      channel: 'email' as const,
      idempotencyKey: randomUUID(),
      actor: 'manager',
    };
    const rows = await Promise.all([
      resendGiftCardRecipient(prisma, input),
      resendGiftCardRecipient(prisma, input),
    ]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(await prisma.giftCardDelivery.count({ where: { giftCardId: gift.id } })).toBe(1);
    await expect(
      resendGiftCardRecipient(prisma, { ...input, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('en cours');
  });

  it('recovers a forgotten pending delivery and keeps an interrupted provider submission uncertain', async () => {
    const gift = await card();
    const pending = await prisma.$transaction((tx) =>
      enqueueGiftCardDelivery(tx, { restaurantId, giftCardId: gift.id, kind: 'recipient_email' }),
    );
    await prisma.giftCardDelivery.update({
      where: { id: pending.id },
      data: { updatedAt: new Date(0) },
    });
    await Promise.all([recoverGiftCardDeliveries(prisma), recoverGiftCardDeliveries(prisma)]);
    expect(
      await prisma.outboxEvent.count({
        where: {
          restaurantId,
          idempotencyKey: { startsWith: `gift-card-recovery:${pending.id}:` },
        },
      }),
    ).toBe(1);
    await prisma.giftCardDelivery.update({
      where: { id: pending.id },
      data: { status: 'IN_PROGRESS', startedAt: new Date(0) },
    });
    await recoverGiftCardDeliveries(prisma);
    expect(
      (await prisma.giftCardDelivery.findUniqueOrThrow({ where: { id: pending.id } })).status,
    ).toBe('UNKNOWN');
    await processGiftCardDelivery(prisma, pending.id);
    expect(sendRecipientGiftCard).not.toHaveBeenCalled();
  });

  it('associates a reservation without spending its balance', async () => {
    const gift = await card();
    const booking = await reservation();
    const result = await new GiftCardService(prisma).associateToReservation({
      restaurantId,
      reservationId: booking.id,
      code: gift.code,
    });
    expect(result.paymentStatus).toBe('ASSOCIATED');
    expect(
      (
        await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })
      ).remainingAmount.toNumber(),
    ).toBe(100);
    expect(await prisma.giftCardRedemption.count({ where: { giftCardId: gift.id } })).toBe(0);
  });

  it('records a simultaneous repeated debit once, and rejects a changed amount', async () => {
    const gift = await card();
    const booking = await reservation();
    const service = new GiftCardService(prisma);
    const input = {
      restaurantId,
      reservationId: booking.id,
      code: gift.code,
      reservationAmount: 60,
    };
    const results = await Promise.all([
      service.applyToReservation(input),
      service.applyToReservation(input),
    ]);
    expect(results.map((r) => r.remainingAmount)).toEqual([40, 40]);
    expect(await prisma.giftCardRedemption.count({ where: { giftCardId: gift.id } })).toBe(1);
    await expect(service.applyToReservation({ ...input, reservationAmount: 70 })).rejects.toThrow();
  });

  it('deduplicates a cashier ticket across simultaneous retries with different request keys', async () => {
    const gift = await card();
    const service = new GiftCardOperationsService(prisma);
    const input = {
      restaurantId,
      giftCardId: gift.id,
      billAmount: 60,
      ticketReference: '2026-09-30/T42',
      actor: 'test',
      idempotencyKey: randomUUID(),
    };
    const receipts = await Promise.all([
      service.debit(input),
      service.debit({ ...input, ticketReference: '2026-09-30/t42', idempotencyKey: randomUUID() }),
    ]);
    expect(receipts[0].id).toBe(receipts[1].id);
    expect(receipts[0].remainingAmount).toBe(40);
    expect(await prisma.giftCardRedemption.count({ where: { giftCardId: gift.id } })).toBe(1);
    await expect(service.debit({ ...input, billAmount: 61 })).rejects.toThrow(
      'informations différentes',
    );
    const other = await card();
    await expect(
      service.debit({ ...input, giftCardId: other.id, idempotencyKey: randomUUID() }),
    ).rejects.toThrow('informations différentes');
  });

  it('caps the cashier debit at the remaining balance and records the complement', async () => {
    const gift = await card();
    const service = new GiftCardOperationsService(prisma);
    const input = {
      restaurantId,
      giftCardId: gift.id,
      billAmount: 150,
      ticketReference: randomUUID(),
      actor: 'test',
      idempotencyKey: randomUUID(),
    };
    const result = await service.debit(input);
    expect(result).toMatchObject({
      billAmount: 150,
      appliedAmount: 100,
      remainingAmount: 0,
      complementAmount: 50,
    });
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })).status).toBe(
      'REDEEMED',
    );
    expect((await service.debit(input)).id).toBe(result.id);
    await expect(
      service.debit({ ...input, ticketReference: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toThrow('ne peut pas');
  });

  it('scopes cashier operations to the restaurant and rejects frozen and expired cards', async () => {
    const gift = await card();
    const service = new GiftCardOperationsService(prisma);
    const input = {
      restaurantId,
      giftCardId: gift.id,
      billAmount: 30,
      ticketReference: randomUUID(),
      actor: 'test',
      idempotencyKey: randomUUID(),
    };
    await expect(service.debit({ ...input, restaurantId: randomUUID() })).rejects.toThrow(
      'introuvable',
    );
    await prisma.giftCard.update({ where: { id: gift.id }, data: { status: 'PAYMENT_REVIEW' } });
    await expect(service.debit(input)).rejects.toThrow('ne peut pas');
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { status: 'ACTIVE', expiresAt: new Date(0) },
    });
    await expect(service.debit(input)).rejects.toThrow('ne peut pas');
    expect(await prisma.giftCardRedemption.count({ where: { giftCardId: gift.id } })).toBe(0);
  });

  it('records a cashier debit against the associated reservation without a second legacy debit', async () => {
    const gift = await card();
    const booking = await reservation();
    const legacy = new GiftCardService(prisma);
    await legacy.associateToReservation({
      restaurantId,
      reservationId: booking.id,
      code: gift.code,
    });
    const before = await new GiftCardOperationsService(prisma).detail(gift.id, restaurantId);
    expect(before.associatedReservations.map((row) => row.id)).toEqual([booking.id]);
    const result = await new GiftCardOperationsService(prisma).debit({
      restaurantId,
      giftCardId: gift.id,
      billAmount: 120,
      ticketReference: randomUUID(),
      reservationId: booking.id,
      actor: 'test',
      idempotencyKey: randomUUID(),
    });
    expect(result.complementAmount).toBe(20);
    const replay = await legacy.applyToReservation({
      restaurantId,
      reservationId: booking.id,
      code: gift.code,
      reservationAmount: 120,
    });
    expect(replay.appliedAmount).toBe(100);
    expect(await prisma.giftCardRedemption.count({ where: { giftCardId: gift.id } })).toBe(1);
  });

  it('separates manual issuance from registered Stripe captures in the operational balance sheet', async () => {
    const manual = await card();
    await prisma.giftCard.update({ where: { id: manual.id }, data: { createdBy: 'DASHBOARD' } });
    const input = await purchaseOrder();
    await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    const overview = await new GiftCardOperationsService(prisma).overview(restaurantId);
    expect(overview).toMatchObject({
      capturedAmount: 100,
      refundedAmount: 0,
      manuallyIssuedAmount: 100,
      availableBalance: 200,
      trackedPaymentCount: 1,
    });
    const history = await new GiftCardOperationsService(prisma).detail(manual.id, restaurantId);
    expect(history.redemptions).toEqual([]);
    await expect(
      new GiftCardOperationsService(prisma).detail(manual.id, randomUUID()),
    ).rejects.toThrow('introuvable');
  });

  it('serializes cancellation against a debit and prevents spending after cancellation', async () => {
    const gift = await card();
    const booking = await reservation();
    const service = new GiftCardService(prisma);
    await Promise.allSettled([
      service.cancel(gift.id, restaurantId),
      service.applyToReservation({
        restaurantId,
        reservationId: booking.id,
        code: gift.code,
        reservationAmount: 60,
      }),
    ]);
    const final = await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } });
    expect(final.status).toBe('CANCELLED');
    expect(final.remainingAmount.toNumber()).toBe(0);
    await expect(
      service.applyToReservation({
        restaurantId,
        reservationId: booking.id,
        code: gift.code,
        reservationAmount: 10,
      }),
    ).rejects.toThrow();
  });

  it('credits a repeated crowdfunding payment once and rejects a mismatched payment amount', async () => {
    const gift = await prisma.giftCard.create({
      data: {
        restaurantId,
        amount: 0,
        remainingAmount: 0,
        suppernoteCommissionAmount: 0,
        type: 'CROWDFUNDED',
        crowdfundedUntil: new Date(Date.now() + 86400000),
      },
    });
    const paymentIntentId = `pi_${randomUUID()}`;
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: paymentIntentId,
      status: 'succeeded',
      amount: 2000,
      amountReceived: 2000,
      currency: 'eur',
      metadata: {
        type: 'crowdfunding_contribution',
        giftCardCode: gift.code,
        amount: '20',
        restaurantId,
      },
    });
    const service = new GiftCardCrowdfundingService(prisma);
    const input = { code: gift.code, amount: 20, contributorName: 'Test', isPublicName: false };
    const results = await Promise.all([
      service.contribute(input, paymentIntentId),
      service.contribute(input, paymentIntentId),
    ]);
    expect(results[0]?.id).toBe(results[1]?.id);
    expect(await prisma.giftCardContribution.count({ where: { giftCardId: gift.id } })).toBe(1);
    await expect(service.contribute({ ...input, amount: 200 }, paymentIntentId)).rejects.toThrow();
    await expect(service.closeCrowdfunding(gift.id, 'other-restaurant')).rejects.toThrow();
  });

  it('applies cumulative external refunds once even when events are repeated', async () => {
    const input = await purchaseOrder();
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: input.paymentIntentId,
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      refundedAmount: 2500,
      metadata: { restaurantId },
    });
    const refunds = new GiftCardRefundService(prisma);
    await Promise.all([
      refunds.reconcilePayment(input.paymentIntentId, 'acct_test'),
      refunds.reconcilePayment(input.paymentIntentId, 'acct_test'),
    ]);
    expect(
      (
        await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })
      ).remainingAmount.toNumber(),
    ).toBe(75);
  });

  it('persists a single refund request and uses the same provider idempotency key on retries', async () => {
    const input = await purchaseOrder();
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    vi.mocked(createRefund).mockResolvedValue({
      id: `re_${randomUUID()}`,
      amount: 10000,
      status: 'succeeded',
    });
    await new GiftCardRefundService(prisma).cancel(gift.id, restaurantId, 'test');
    await new GiftCardRefundService(prisma).cancel(gift.id, restaurantId, 'test');
    expect(await prisma.giftCardRefundRequest.count({ where: { giftCardId: gift.id } })).toBe(1);
    expect(createRefund).toHaveBeenCalledTimes(1);
    expect(createRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeAccountId: 'acct_test',
        idempotencyKey: `gift-card-cancel:${gift.id}:${input.paymentIntentId}`,
      }),
    );
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })).status).toBe(
      'CANCELLED',
    );
  });
  it('keeps the paid face value at closure and does not reset a consumed balance on replay', async () => {
    const gift = await prisma.giftCard.create({
      data: {
        restaurantId,
        amount: 0,
        remainingAmount: 0,
        suppernoteCommissionAmount: 0,
        type: 'CROWDFUNDED',
        crowdfundedUntil: new Date(Date.now() + 86400000),
      },
    });
    const paymentIntentId = `pi_${randomUUID()}`;
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: paymentIntentId,
      status: 'succeeded',
      amount: 2000,
      amountReceived: 2000,
      currency: 'eur',
      metadata: {
        type: 'crowdfunding_contribution',
        giftCardCode: gift.code,
        amount: '20',
        restaurantId,
      },
    });
    const crowdfunding = new GiftCardCrowdfundingService(prisma);
    const input = { code: gift.code, amount: 20, contributorName: 'Test', isPublicName: false };
    await crowdfunding.contribute(input, paymentIntentId);
    const closed = await crowdfunding.closeCrowdfunding(gift.id, restaurantId);
    expect(closed.amount.toNumber()).toBe(20);
    const booking = await reservation();
    await new GiftCardService(prisma).applyToReservation({
      restaurantId,
      reservationId: booking.id,
      code: gift.code,
      reservationAmount: 5,
    });
    const replay = await crowdfunding.closeCrowdfunding(gift.id, restaurantId);
    expect(replay.remainingAmount.toNumber()).toBe(15);
    vi.mocked(createRefund).mockResolvedValue({
      id: `re_${randomUUID()}`,
      amount: 2000,
      status: 'succeeded',
    });
    const latePi = `pi_${randomUUID()}`;
    expect(await crowdfunding.contribute(input, latePi)).toBeNull();
    expect(
      await prisma.giftCardRefundRequest.count({
        where: { paymentIntentId: latePi, status: 'succeeded' },
      }),
    ).toBe(1);
    expect(
      (
        await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })
      ).remainingAmount.toNumber(),
    ).toBe(15);
  });

  it('freezes the balance while an external refund is pending and restores it if the refund fails', async () => {
    const input = await purchaseOrder();
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    const pi = {
      id: input.paymentIntentId,
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      refundedAmount: 0,
      metadata: { restaurantId },
      pendingRefund: true,
    };
    vi.mocked(retrievePaymentIntent).mockResolvedValue(pi);
    const refunds = new GiftCardRefundService(prisma);
    await refunds.reconcilePayment(input.paymentIntentId, 'acct_test');
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })).status).toBe(
      'REFUND_REVIEW',
    );
    expect((await new GiftCardService(prisma).validateCode(gift.code, restaurantId)).valid).toBe(
      false,
    );
    vi.mocked(retrievePaymentIntent).mockResolvedValue({ ...pi, pendingRefund: false });
    await refunds.reconcilePayment(input.paymentIntentId, 'acct_test');
    expect((await new GiftCardService(prisma).validateCode(gift.code, restaurantId)).valid).toBe(
      true,
    );
  });
  it('keeps a card blocked until all its payments are clear of disputes', async () => {
    const input = await purchaseOrder();
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment(input);
    const otherId = `pi_${randomUUID()}`;
    await prisma.giftCardPaymentEntry.create({
      data: {
        paymentIntentId: otherId,
        giftCardId: gift.id,
        restaurantId,
        kind: 'CONTRIBUTION',
        amountCents: 1000,
        stripeAccountId: 'acct_test',
      },
    });
    await prisma.giftCard.update({
      where: { id: gift.id },
      data: { status: 'PAYMENT_REVIEW', stripePaymentStatus: 'disputed' },
    });
    const base = {
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      refundedAmount: 0,
      metadata: { restaurantId },
    };
    let otherDisputed = true;
    vi.mocked(retrievePaymentIntent).mockImplementation(async (id) => ({
      ...base,
      id,
      disputed: id === otherId && otherDisputed,
    }));
    const refunds = new GiftCardRefundService(prisma);
    await refunds.reconcilePayment(input.paymentIntentId, 'acct_test');
    expect((await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } })).status).toBe(
      'PAYMENT_REVIEW',
    );
    otherDisputed = false;
    await refunds.reconcilePayment(input.paymentIntentId, 'acct_test');
    const card = await prisma.giftCard.findUniqueOrThrow({ where: { id: gift.id } });
    expect(card.status).toBe('ACTIVE');
    expect(card.stripePaymentStatus).toBe('succeeded');
  });
  it('fulfills the frozen pack and commission even after the catalogue changes', async () => {
    const pack = await prisma.giftCardPack.create({
      data: {
        restaurantId,
        name: 'Original pack',
        amount: 100,
        minPartySize: 2,
        maxPartySize: 2,
      },
    });
    const paymentIntentId = `pi_${randomUUID()}`;
    vi.mocked(createPaymentIntent).mockResolvedValue({
      id: paymentIntentId,
      clientSecret: randomUUID(),
    });
    const checkout = await new GiftCardCheckoutService(prisma).purchase({
      restaurantId,
      packId: pack.id,
      recipientName: 'Original recipient',
      accessToken: token,
      idempotencyKey: randomUUID(),
    });
    await prisma.giftCardPack.update({
      where: { id: pack.id },
      data: { amount: 200, name: 'New pack' },
    });
    await prisma.restaurant.update({
      where: { id: restaurantId },
      data: { giftCardCommissionRate: 0.1 },
    });
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: paymentIntentId,
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      metadata: {
        checkoutId: checkout.checkoutId,
        restaurantId,
        type: 'gift_card_purchase',
      },
    });
    const gift = await new GiftCardPaymentService(prisma).purchaseWithPayment({
      restaurantId,
      paymentIntentId,
      checkoutId: checkout.checkoutId,
      accessToken: token,
      recipientName: 'Changed recipient',
    });
    expect(gift.amount.toNumber()).toBe(100);
    expect(gift.suppernoteCommissionAmount.toNumber()).toBe(5);
    expect(gift.recipientName).toBe('Original recipient');
    expect(gift.packSnapshot).toMatchObject({ name: 'Original pack', amount: 100 });
  });
});
