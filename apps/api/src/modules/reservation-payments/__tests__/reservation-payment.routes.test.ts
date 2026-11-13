import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

const AUTH = { authorization: 'Bearer test' };

function policyRow() {
  return {
    id: 'policy-1',
    restaurantId: 'test-rest-1',
    version: 1,
    type: 'DEPOSIT',
    amountMode: 'PER_PERSON',
    amount: new Prisma.Decimal('15.00'),
    minPartySize: 2,
    cancellationHours: 24,
    rules: {},
    activeFrom: new Date('2026-09-01T00:00:00.000Z'),
    activeUntil: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
  };
}

describe('reservation payment foundation routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'false');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeApp();
  });

  it('reste fermé par défaut avant la qualification du marchand', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/reservation-payment-policies',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: 'RESERVATION_PAYMENTS_DISABLED' });
  });

  it('refuse Essential avant même le flag runtime', async () => {
    vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'true');
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'STARTER' } as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/reservation-payment-policies',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('CAPABILITY_NOT_INCLUDED');
  });

  it('prévisualise une policy et un montant sans appeler Stripe ni écrire', async () => {
    vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'true');
    vi.mocked(db.reservation.findFirst).mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'test-rest-1',
      partySize: 3,
      status: 'CONFIRMED',
      state: 'CONFIRMED',
    } as never);
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue(policyRow() as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/reservations/reservation-1/payment/prepare',
      headers: AUTH,
      payload: {
        idempotencyKey: 'payment-key-1',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      id: null,
      amount: '45.00',
      dryRun: true,
      providerConfigured: false,
      requiresProviderSetup: true,
    });
    expect(db.reservationPayment.create).not.toHaveBeenCalled();
  });

  it('enregistre une policy versionnée uniquement quand le flag est explicitement ouvert', async () => {
    vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'true');
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue(null);
    vi.mocked(db.reservationPaymentPolicy.create).mockResolvedValue(policyRow() as never);
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/reservation-payment-policies',
      headers: AUTH,
      payload: {
        type: 'DEPOSIT',
        amountMode: 'PER_PERSON',
        amount: '15.00',
        minPartySize: 2,
        cancellationHours: 24,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({ version: 1, amount: '15.00' });
    expect(JSON.stringify(response.json())).not.toContain('stripeAccountId');
  });
});
