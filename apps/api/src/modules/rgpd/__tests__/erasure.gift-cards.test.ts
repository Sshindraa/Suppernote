/**
 * Effacement : cartes cadeaux (noms, contacts, messages), checkouts (payload), contributions et
 * notes de fidélité. Montants, soldes, codes et statuts restent pour la comptabilité.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ErasureService, ErasureSubjectNotFoundError } from '../erasure.service';

function makePrisma(overrides: {
  giftCards?: { id: string }[];
  checkouts?: { id: string; payload: unknown }[];
  crmCustomers?: {
    id: string;
    restaurantId: string;
    phone: string;
    emailNormalized: string | null;
  }[];
}) {
  const giftCards = overrides.giftCards ?? [];
  const crmCustomers = overrides.crmCustomers ?? [];
  const prisma = {
    reservation: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    call: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerConsent: {
      findFirst: vi.fn().mockResolvedValue({ id: 'consent-1' }),
      count: vi.fn().mockResolvedValue(1),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customer: {
      findMany: vi.fn().mockResolvedValue(crmCustomers),
      update: vi.fn().mockResolvedValue({}),
    },
    marketingSuppression: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingPermission: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    message: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    voiceDebugTurn: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    $queryRaw: vi.fn(),
    giftCard: {
      findFirst: vi.fn().mockResolvedValue(giftCards[0] ?? null),
      findMany: vi.fn().mockResolvedValue(giftCards),
      updateMany: vi.fn().mockResolvedValue({ count: giftCards.length }),
    },
    giftCardContribution: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    giftCardCheckout: {
      findMany: vi.fn().mockResolvedValue(overrides.checkouts ?? []),
      update: vi.fn().mockResolvedValue({}),
    },
    giftCardDelivery: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    loyaltyGrant: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    reservationAuditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma;
}

const SUBJECT = '+33612345678';

describe('ErasureService — cartes cadeaux, checkouts et fidélité', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('efface les noms, contacts et messages du sujet sur ses cartes, sans toucher montant ni code', async () => {
    const prisma = makePrisma({ giftCards: [{ id: 'gc-1' }] });
    const service = new ErasureService(prisma as unknown as PrismaClient);

    const result = await service.eraseSubject({
      subject: SUBJECT,
      reason: 'user_request',
      actor: 'rgpd:user',
    });

    expect(result.giftCardsAnonymized).toBe(1);
    const updates = (prisma.giftCard.updateMany as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0].data,
    );
    const written = Object.assign({}, ...updates);
    expect(written).toMatchObject({
      senderName: null,
      senderEmail: null,
      senderPhone: null,
      recipientName: null,
      recipientEmail: null,
      recipientPhone: null,
      message: null,
    });
    for (const key of [
      'amount',
      'remainingAmount',
      'code',
      'status',
      'suppernoteCommissionAmount',
    ]) {
      expect(written).not.toHaveProperty(key);
    }
  });

  it('retire le payload de checkout (contacts, message) et garde montant et packSnapshot', async () => {
    const prisma = makePrisma({
      giftCards: [{ id: 'gc-1' }],
      checkouts: [
        {
          id: 'co-1',
          payload: {
            senderName: 'Camille',
            senderPhone: SUBJECT,
            recipientEmail: 'lea@example.com',
            message: 'Joyeux anniversaire',
            amount: 50,
            packSnapshot: { name: 'Pack dîner' },
          },
        },
      ],
    });
    const service = new ErasureService(prisma as unknown as PrismaClient);

    await service.eraseSubject({ subject: SUBJECT, reason: 'user_request', actor: 'rgpd:user' });

    expect(prisma.giftCardCheckout.update).toHaveBeenCalledWith({
      where: { id: 'co-1' },
      data: { payload: { amount: 50, packSnapshot: { name: 'Pack dîner' } } },
    });
  });

  it('retire la note libre de fidélité des fiches effacées, sans supprimer la ligne', async () => {
    const prisma = makePrisma({
      crmCustomers: [
        { id: 'cust-1', restaurantId: 'rest-1', phone: SUBJECT, emailNormalized: null },
      ],
    });
    const service = new ErasureService(prisma as unknown as PrismaClient);

    await service.eraseSubject({ subject: SUBJECT, reason: 'user_request', actor: 'rgpd:user' });

    expect(prisma.loyaltyGrant.updateMany).toHaveBeenCalledWith({
      where: { customerId: { in: ['cust-1'] }, redemptionNote: { not: null } },
      data: { redemptionNote: null },
    });
  });

  it('considère un sujet connu seulement par ses cartes comme trouvé (pas de 404)', async () => {
    const prisma = makePrisma({ giftCards: [{ id: 'gc-1' }] });
    prisma.customerConsent.findFirst.mockResolvedValue(null);
    const service = new ErasureService(prisma as unknown as PrismaClient);

    await expect(
      service.eraseSubject({ subject: SUBJECT, reason: 'user_request', actor: 'rgpd:user' }),
    ).resolves.toMatchObject({ giftCardsAnonymized: 1 });
  });

  it('404 si le sujet n’a aucune trace, cartes incluses', async () => {
    const prisma = makePrisma({});
    prisma.customerConsent.findFirst.mockResolvedValue(null);
    const service = new ErasureService(prisma as unknown as PrismaClient);

    await expect(
      service.eraseSubject({ subject: SUBJECT, reason: 'user_request', actor: 'rgpd:user' }),
    ).rejects.toBeInstanceOf(ErasureSubjectNotFoundError);
  });
});
