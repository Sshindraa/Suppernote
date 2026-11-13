import type { PrismaClient } from '@prisma/client';

interface CustomerRef {
  id: string;
  restaurantId?: string;
  phone: string;
}

type CustomerFinder = Pick<PrismaClient['customer'], 'findMany'>;

/**
 * Ajoute aux fiches trouvées celles qui ont été fusionnées dedans (`mergedIntoId`),
 * récursivement et dans le même restaurant : une fiche source archivée garde ses
 * données personnelles et doit suivre l'effacement et l'export.
 */
export async function withMergedCustomers<T extends CustomerRef>(
  customer: CustomerFinder,
  found: T[],
): Promise<CustomerRef[]> {
  const all = new Map<string, CustomerRef>(found.map((c) => [c.id, c]));
  let frontier: CustomerRef[] = [...found];
  while (frontier.length > 0) {
    const parents = new Map(frontier.map((c) => [c.id, c]));
    const rows =
      (await customer.findMany({
        where: { mergedIntoId: { in: [...parents.keys()] } },
        select: { id: true, restaurantId: true, phone: true, mergedIntoId: true },
      })) ?? [];
    frontier = rows.filter(
      (row) =>
        !all.has(row.id) &&
        row.mergedIntoId != null &&
        parents.get(row.mergedIntoId)?.restaurantId === row.restaurantId,
    );
    for (const row of frontier) all.set(row.id, row);
  }
  return [...all.values()];
}
