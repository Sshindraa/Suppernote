/**
 * Retrait marketing demandé par la personne : chaque fiche CRM du sujet est retirée sur tous les
 * canaux, l'accord historique passe à false pour toutes les variantes du numéro, et une erreur du
 * registre d'opposition remonte (le routeur répond 503).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { withdrawSubjectMarketing, RGPD_WITHDRAWAL_SOURCE } from '../marketing-withdrawal.service';
import { ConsentService } from '../consent.service';
import { withdrawMarketingPermission } from '../../marketing/marketing-permission.service';

vi.mock('../../marketing/marketing-permission.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../marketing/marketing-permission.service')>();
  return { ...actual, withdrawMarketingPermission: vi.fn().mockResolvedValue({}) };
});

// Les fiches fusionnées sont testées ailleurs ; ici on garde la liste telle quelle.
vi.mock('../merged-customers', () => ({
  withMergedCustomers: async (_finder: unknown, found: unknown[]) => found,
}));

function makePrisma(customers: { id: string; restaurantId: string; phone: string }[]) {
  return {
    customerConsent: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
    customer: {
      findMany: vi.fn().mockResolvedValue(customers),
    },
  } as unknown as PrismaClient;
}

describe('withdrawSubjectMarketing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retire chaque fiche CRM du sujet sur SMS, e-mail et WhatsApp', async () => {
    const prisma = makePrisma([
      { id: 'cust-1', restaurantId: 'rest-1', phone: '+33612345678' },
      { id: 'cust-2', restaurantId: 'rest-2', phone: '+33612345678' },
    ]);

    const result = await withdrawSubjectMarketing({ prisma, subject: '+33612345678' });

    expect(result).toEqual({ consentsWithdrawn: 2, customersWithdrawn: 2 });
    expect(withdrawMarketingPermission).toHaveBeenCalledTimes(6);
    for (const channel of ['SMS', 'EMAIL', 'WHATSAPP']) {
      expect(withdrawMarketingPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: 'rest-1',
          customerId: 'cust-1',
          channel,
          source: RGPD_WITHDRAWAL_SOURCE,
        }),
      );
    }
  });

  it("met l'accord historique à false pour toutes les variantes du numéro", async () => {
    const prisma = makePrisma([]);

    await withdrawSubjectMarketing({ prisma, subject: '+33612345678' });

    const call = (prisma.customerConsent.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const hashes = call.where.subjectHash.in as string[];
    expect(hashes).toContain(ConsentService.hashSubject('+33612345678'));
    expect(hashes).toContain(ConsentService.hashSubject('0612345678'));
    expect(call.data).toEqual({ marketingOptIn: false });
    expect(withdrawMarketingPermission).not.toHaveBeenCalled();
  });

  it('remonte MARKETING_OPTOUT_REGISTER_UNAVAILABLE sans avaler l’erreur', async () => {
    const prisma = makePrisma([{ id: 'cust-1', restaurantId: 'rest-1', phone: '+33612345678' }]);
    vi.mocked(withdrawMarketingPermission).mockRejectedValueOnce(
      new Error('MARKETING_OPTOUT_REGISTER_UNAVAILABLE'),
    );

    await expect(withdrawSubjectMarketing({ prisma, subject: '+33612345678' })).rejects.toThrow(
      'MARKETING_OPTOUT_REGISTER_UNAVAILABLE',
    );
  });
});
