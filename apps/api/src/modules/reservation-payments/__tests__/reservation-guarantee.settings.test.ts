import { Prisma, ReservationPaymentType } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stripe = vi.hoisted(() => ({ retrieveConnectedAccount: vi.fn() }));
vi.mock('../../gift-cards/stripe.service', () => stripe);

import { db } from '../../../shared/db/client';
import {
  CardGuaranteeSettingsSchema,
  getCardGuaranteeSettings,
  saveCardGuaranteeSettings,
} from '../reservation-guarantee.settings';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const input = CardGuaranteeSettingsSchema.parse({
  enabled: true,
  minPartySize: 6,
  protectedDates: ['2026-12-31', '2026-02-14', '2026-12-31'],
  amountPerPerson: '25',
  cancellationHours: 24,
});

describe('réglages de l’empreinte bancaire', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      giftCardStripeAccountId: 'acct_resto',
    } as never);
    stripe.retrieveConnectedAccount.mockResolvedValue({ chargesEnabled: true });
    // Premier appel : dernière version connue ; ensuite : relecture du réglage.
    vi.mocked(db.reservationPaymentPolicy.findFirst)
      .mockReset()
      .mockResolvedValue(null)
      .mockResolvedValueOnce({ version: 3 } as never);
    vi.mocked(db.reservationPaymentPolicy.create).mockResolvedValue({
      id: 'policy-4',
      restaurantId: 'rest-1',
      version: 4,
      type: ReservationPaymentType.CARD_GUARANTEE,
      amountMode: 'PER_PERSON',
      amount: new Prisma.Decimal('25'),
      minPartySize: 6,
      cancellationHours: 24,
      rules: {},
      activeFrom: NOW,
      activeUntil: null,
      createdAt: NOW,
    } as never);
    vi.mocked(db.reservationPaymentPolicy.updateMany).mockResolvedValue({ count: 1 });
  });

  it('dédoublonne et trie les dates protégées', () => {
    expect(input.protectedDates).toEqual(['2026-02-14', '2026-12-31']);
  });

  it('crée une nouvelle version et clôt les précédentes', async () => {
    await saveCardGuaranteeSettings('rest-1', input, NOW);
    expect(db.reservationPaymentPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          restaurantId: 'rest-1',
          version: 4,
          type: ReservationPaymentType.CARD_GUARANTEE,
          amountMode: 'PER_PERSON',
          minPartySize: 6,
          rules: { protectedDates: ['2026-02-14', '2026-12-31'] },
        }),
      }),
    );
    expect(db.reservationPaymentPolicy.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        restaurantId: 'rest-1',
        type: ReservationPaymentType.CARD_GUARANTEE,
        id: { not: 'policy-4' },
      }),
      data: { activeUntil: NOW },
    });
  });

  it('refuse d’activer tant que le compte Stripe ne peut pas encaisser', async () => {
    stripe.retrieveConnectedAccount.mockResolvedValue({ chargesEnabled: false });
    await expect(saveCardGuaranteeSettings('rest-1', input, NOW)).rejects.toMatchObject({
      code: 'PAYMENT_PROVIDER_NOT_READY',
    });
    expect(db.reservationPaymentPolicy.create).not.toHaveBeenCalled();
  });

  it.each([
    ['aucun déclencheur', { minPartySize: null, protectedDates: [] }, 'PAYMENT_POLICY_INVALID'],
    ['montant trop élevé', { amountPerPerson: '250' }, 'PAYMENT_AMOUNT_INVALID'],
  ])('refuse un réglage incohérent : %s', async (_label, overrides, code) => {
    await expect(
      saveCardGuaranteeSettings('rest-1', { ...input, ...overrides }, NOW),
    ).rejects.toMatchObject({ code });
  });

  it('coupe l’empreinte sans toucher Stripe', async () => {
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockReset().mockResolvedValue(null);
    const result = await saveCardGuaranteeSettings('rest-1', { ...input, enabled: false }, NOW);
    expect(result.enabled).toBe(false);
    expect(stripe.retrieveConnectedAccount).not.toHaveBeenCalled();
    expect(db.reservationPaymentPolicy.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { activeUntil: NOW } }),
    );
  });

  it('relit le réglage en vigueur', async () => {
    vi.mocked(db.reservationPaymentPolicy.findFirst)
      .mockReset()
      .mockResolvedValue({
        version: 4,
        amount: new Prisma.Decimal('25'),
        minPartySize: null,
        cancellationHours: 48,
        rules: { protectedDates: ['2026-12-31'] },
      } as never);
    await expect(getCardGuaranteeSettings('rest-1', NOW)).resolves.toEqual({
      enabled: true,
      minPartySize: null,
      protectedDates: ['2026-12-31'],
      amountPerPerson: '25.00',
      cancellationHours: 48,
      version: 4,
    });
  });
});
