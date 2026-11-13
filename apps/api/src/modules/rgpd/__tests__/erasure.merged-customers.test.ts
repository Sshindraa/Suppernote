import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ErasureService } from '../erasure.service';
import { withMergedCustomers } from '../merged-customers';

const A = { id: 'cust-a', restaurantId: 'r1', phone: '+33601020304', mergedIntoId: null };
const B = { id: 'cust-b', restaurantId: 'r1', phone: '+33699999999', mergedIntoId: 'cust-a' };
const C = { id: 'cust-c', restaurantId: 'r1', phone: '+33688888888', mergedIntoId: 'cust-b' };
const OTHER_RESTAURANT = {
  id: 'cust-x',
  restaurantId: 'r2',
  phone: '+33677777777',
  mergedIntoId: 'cust-a',
};

function customerFinder() {
  return {
    findMany: vi.fn(async (args: { where: { mergedIntoId?: { in: string[] } } }) =>
      [B, C, OTHER_RESTAURANT].filter((c) => args.where.mergedIntoId?.in.includes(c.mergedIntoId)),
    ),
  };
}

describe('fiches fusionnées et RGPD', () => {
  it('suit mergedIntoId récursivement, dans le même restaurant seulement', async () => {
    const result = await withMergedCustomers(customerFinder() as never, [A]);
    expect(result.map((c) => c.id).sort()).toEqual(['cust-a', 'cust-b', 'cust-c']);
  });

  it("l'effacement par le téléphone de A anonymise aussi la fiche fusionnée B", async () => {
    const customer = {
      findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
        'mergedIntoId' in args.where
          ? customerFinder().findMany(args as never)
          : args.where.id
            ? [A, B, C]
            : [A],
      ),
      update: vi.fn(),
    };
    const model = () => ({
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      create: vi.fn().mockResolvedValue({}),
    });
    const models = new Map<string, unknown>();
    const prisma: unknown = new Proxy(
      { customer, $queryRaw: vi.fn(), $transaction: vi.fn() },
      {
        get(target, key: string) {
          if (key in target) return (target as Record<string, unknown>)[key];
          if (!models.has(key)) models.set(key, model());
          return models.get(key);
        },
      },
    );
    (prisma as { $transaction: ReturnType<typeof vi.fn> }).$transaction.mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(prisma),
    );

    await new ErasureService(prisma as PrismaClient).eraseSubject({
      subject: A.phone,
      reason: 'Article 17',
      actor: 'admin:test',
    });

    const erased = customer.update.mock.calls.map(([call]) => call.where.id).sort();
    expect(erased).toEqual(['cust-a', 'cust-b', 'cust-c']);
    expect(
      customer.update.mock.calls.find(([c]) => c.where.id === 'cust-b')?.[0].data,
    ).toMatchObject({ name: 'ANON', notes: null, emailNormalized: null });
  });
});
