/**
 * Retrait marketing demandé par la personne (POST /api/rgpd/withdraw-marketing).
 *
 * Avant : seul l'accord historique (CustomerConsent.marketingOptIn) passait à false, ce qui ne
 * bloquait pas les permissions par canal ni le registre d'opposition. Désormais chaque fiche CRM du
 * sujet est retirée sur tous les canaux, comme un STOP ou un lien de désinscription.
 *
 * Ordre : l'accord historique d'abord (fermer le plus vite possible), puis les fiches. Un échec du
 * registre remonte en MARKETING_OPTOUT_REGISTER_UNAVAILABLE : la requête est rejouable, les écritures
 * sont idempotentes.
 */
import type { PrismaClient } from '@prisma/client';
import {
  customerPhoneLookupValues,
  normalizeCustomerPhone,
} from '../customers/customer-crm.service';
import {
  MARKETING_CHANNELS,
  withdrawMarketingPermission,
} from '../marketing/marketing-permission.service';
import { ConsentService } from './consent.service';
import { withMergedCustomers } from './merged-customers';

export const RGPD_WITHDRAWAL_SOURCE = 'RGPD_WITHDRAWAL';

export async function withdrawSubjectMarketing(args: {
  prisma: PrismaClient;
  subject: string;
  now?: Date;
}): Promise<{ consentsWithdrawn: number; customersWithdrawn: number }> {
  const now = args.now ?? new Date();
  const phones = customerPhoneLookupValues(args.subject);
  const subjectHashes = phones.map((phone) => ConsentService.hashSubject(phone));

  const consent = await args.prisma.customerConsent.updateMany({
    where: { subjectHash: { in: subjectHashes }, marketingOptIn: true },
    data: { marketingOptIn: false },
  });

  const normalizedPhone = normalizeCustomerPhone(args.subject);
  const found =
    (await args.prisma.customer.findMany({
      where: normalizedPhone
        ? {
            OR: [
              { phone: { in: phones } },
              { identities: { some: { type: 'PHONE', normalizedValue: normalizedPhone } } },
            ],
          }
        : { phone: { in: phones } },
      select: { id: true, restaurantId: true, phone: true },
    })) ?? [];
  const customers = await withMergedCustomers(args.prisma.customer, found);

  for (const customer of customers) {
    // Le registre est propre à chaque restaurant : sans restaurant, rien ne peut être écrit.
    if (!customer.restaurantId) throw new Error('CUSTOMER_RESTAURANT_MISSING');
    for (const channel of MARKETING_CHANNELS) {
      // Lève aussi les fiches fusionnées ; une erreur du registre n'est pas avalée.
      await withdrawMarketingPermission({
        restaurantId: customer.restaurantId,
        customerId: customer.id,
        channel,
        source: RGPD_WITHDRAWAL_SOURCE,
        occurredAt: now,
      });
    }
  }

  return { consentsWithdrawn: consent.count, customersWithdrawn: customers.length };
}
