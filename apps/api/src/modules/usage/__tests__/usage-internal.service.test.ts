import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { getInternalUsageSummary } from '../usage-internal.service';

describe('internal usage summary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('aggregates quantities, costs and pricing status by restaurant/category', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'rest-1',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(2),
        estimatedCost: new Prisma.Decimal('0.12'),
        metadata: { costStatus: 'PRICED' },
      },
      {
        restaurantId: 'rest-1',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(1),
        estimatedCost: new Prisma.Decimal(0),
        metadata: { costStatus: 'UNPRICED' },
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'rest-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);

    await expect(getInternalUsageSummary({ monthKey: '2026-09' })).resolves.toEqual([
      {
        restaurantId: 'rest-1',
        restaurantName: 'Chez Suppernote',
        plan: 'PRO',
        category: 'SMS_SEGMENTS',
        quantity: '3.000000',
        estimatedCostEur: '0.120000',
        pricedCostEur: '0.120000',
        costStatus: 'MIXED',
        pricedEvents: 1,
        unpricedEvents: 1,
      },
    ]);
  });

  it('returns no rows without loading restaurant metadata', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([]);

    await expect(
      getInternalUsageSummary({ monthKey: '2026-09', restaurantId: 'rest-empty' }),
    ).resolves.toEqual([]);
    expect(db.restaurant.findMany).not.toHaveBeenCalled();
  });
});
