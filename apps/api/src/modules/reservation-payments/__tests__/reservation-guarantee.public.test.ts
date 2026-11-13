import { Prisma, ReservationPaymentStatus } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entitlements = vi.hoisted(() => ({ evaluateCapability: vi.fn() }));
vi.mock('../../entitlements/entitlement.service', () => entitlements);

import { db } from '../../../shared/db/client';
import {
  cardGuaranteeCheckoutText,
  cardGuaranteeToken,
  findCardGuaranteeTerms,
  publicCardGuaranteeStatus,
  verifyCardGuaranteeToken,
} from '../reservation-guarantee.public';
import { releaseCardGuaranteeOnCancel } from '../reservation-guarantee.release';

const PAYMENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy-1',
    amount: new Prisma.Decimal('20.00'),
    amountMode: 'PER_PERSON',
    minPartySize: 6,
    cancellationHours: 24,
    rules: { protectedDates: ['2026-12-31'] },
    ...overrides,
  };
}

describe('jeton de la page d’empreinte', () => {
  beforeEach(() => {
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'a'.repeat(64));
  });
  afterEach(() => vi.unstubAllEnvs());

  it('ne s’ouvre que pour le restaurant qui l’a émis', () => {
    const token = cardGuaranteeToken({ id: PAYMENT_ID, restaurantId: 'rest-1' })!;
    expect(verifyCardGuaranteeToken(token, 'rest-1')).toBe(PAYMENT_ID);
    expect(verifyCardGuaranteeToken(token, 'rest-2')).toBeNull();
    expect(verifyCardGuaranteeToken(`${token.slice(0, -1)}A`, 'rest-1')).toBeNull();
  });

  it('n’émet rien sans secret valide', () => {
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'trop-court');
    expect(cardGuaranteeToken({ id: PAYMENT_ID, restaurantId: 'rest-1' })).toBeNull();
  });
});

describe('conditions d’empreinte d’une table', () => {
  const NOW = new Date('2026-11-13T10:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'true');
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'a'.repeat(64));
    vi.stubEnv('DASHBOARD_URL', 'https://suppernote.test');
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue(policy() as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      giftCardStripeAccountId: 'acct_resto',
    } as never);
    entitlements.evaluateCapability.mockResolvedValue({ allowed: true });
  });
  afterEach(() => vi.unstubAllEnvs());

  const ask = (partySize: number, localDate = '2026-11-20') =>
    findCardGuaranteeTerms({ restaurantId: 'rest-1', partySize, localDate, now: NOW });

  it('s’applique à un groupe à partir du seuil', async () => {
    await expect(ask(6)).resolves.toEqual({
      policyId: 'policy-1',
      amountPerPerson: '20.00',
      totalAmount: '120.00',
      currency: 'EUR',
      cancellationHours: 24,
    });
    await expect(ask(5)).resolves.toBeNull();
  });

  it('s’applique à toutes les tables une date protégée', async () => {
    await expect(ask(2, '2026-12-31')).resolves.toMatchObject({ totalAmount: '40.00' });
  });

  it.each([
    ['fonction coupée', () => vi.stubEnv('RESERVATION_PAYMENTS_ENABLED', 'false')],
    [
      'compte Stripe absent',
      () =>
        vi
          .mocked(db.restaurant.findUnique)
          .mockResolvedValue({ giftCardStripeAccountId: null } as never),
    ],
    [
      'formule sans paiement',
      () => entitlements.evaluateCapability.mockResolvedValue({ allowed: false }),
    ],
    [
      'aucune politique',
      () => vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue(null),
    ],
  ])('ne demande rien : %s', async (_label, arrange) => {
    arrange();
    await expect(ask(8)).resolves.toBeNull();
  });

  it('annonce le montant maximal sur la page Stripe', () => {
    expect(
      cardGuaranteeCheckoutText({
        restaurantName: 'Chez Test',
        totalAmount: '120.00',
        cancellationHours: 24,
      }),
    ).toBe(
      'Aucun montant n’est débité aujourd’hui. Si vous annulez moins de 24 h avant, ou si vous ne ' +
        'venez pas sans prévenir, Chez Test pourra prélever jusqu’à 120 €.',
    );
  });

  it('expose un état simple au client', () => {
    expect(
      publicCardGuaranteeStatus(
        ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
        new Date(NOW.getTime() + 1),
        NOW,
      ),
    ).toBe('awaiting_card');
    expect(
      publicCardGuaranteeStatus(ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD, NOW, NOW),
    ).toBe('expired');
    expect(publicCardGuaranteeStatus(ReservationPaymentStatus.AUTHORIZED, null, NOW)).toBe(
      'confirmed',
    );
    expect(publicCardGuaranteeStatus(ReservationPaymentStatus.CANCELLED, null, NOW)).toBe(
      'cancelled',
    );
  });
});

describe('annulation d’une réservation garantie', () => {
  const startsAt = new Date('2026-11-20T19:00:00.000Z');
  const reservation = {
    id: 'reservation-1',
    restaurantId: 'rest-1',
    startsAt,
    reservedAt: startsAt,
  };
  const tx = {
    reservationPayment: { findFirst: vi.fn(), updateMany: vi.fn() },
  } as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(tx.reservationPayment.updateMany).mockResolvedValue({ count: 1 });
  });

  const payment = (status: ReservationPaymentStatus) => ({
    id: 'payment-1',
    status,
    policySnapshot: { type: 'CARD_GUARANTEE', cancellationHours: 24 },
  });

  it('ferme l’empreinte dans le délai gratuit', async () => {
    vi.mocked(tx.reservationPayment.findFirst).mockResolvedValue(
      payment(ReservationPaymentStatus.AUTHORIZED) as never,
    );
    await expect(
      releaseCardGuaranteeOnCancel(tx, reservation, new Date('2026-11-19T19:00:00.000Z')),
    ).resolves.toBe(true);
    expect(tx.reservationPayment.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'payment-1',
        restaurantId: 'rest-1',
        status: ReservationPaymentStatus.AUTHORIZED,
      },
      data: { status: ReservationPaymentStatus.CANCELLED },
    });
  });

  it('garde l’empreinte prélevable après le délai gratuit', async () => {
    vi.mocked(tx.reservationPayment.findFirst).mockResolvedValue(
      payment(ReservationPaymentStatus.AUTHORIZED) as never,
    );
    await expect(
      releaseCardGuaranteeOnCancel(tx, reservation, new Date('2026-11-19T19:00:01.000Z')),
    ).resolves.toBe(false);
    expect(tx.reservationPayment.updateMany).not.toHaveBeenCalled();
  });

  it('ferme toujours une empreinte dont la carte n’a pas été enregistrée', async () => {
    vi.mocked(tx.reservationPayment.findFirst).mockResolvedValue(
      payment(ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD) as never,
    );
    await expect(releaseCardGuaranteeOnCancel(tx, reservation, startsAt)).resolves.toBe(true);
  });
});
