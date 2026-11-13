import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { getInternalMarginReport } from '../usage-internal.service';

describe('internal usage margin report', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([]);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([]);
    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValue([]);
  });

  it('sépare une marge calculable d’un coût encore non rapproché', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        category: 'TELEPHONY_SECONDS',
        quantity: new Prisma.Decimal(120),
        estimatedCost: new Prisma.Decimal('0.40'),
        metadata: { costStatus: 'PRICED' },
      },
      {
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(2),
        estimatedCost: new Prisma.Decimal(0),
        metadata: { costStatus: 'UNPRICED' },
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);

    const report = await getInternalMarginReport({ monthKey: '2026-09' });

    expect(report).toEqual([
      expect.objectContaining({
        restaurantId: 'restaurant-1',
        plan: 'PRO',
        catalogPriceEur: 299,
        estimatedCostEur: '0.400000',
        knownAdjustedCostEur: '0.400000',
        pricedEventCount: 1,
        unpricedEventCount: 1,
        costStatus: 'MIXED',
        grossMarginEur: null,
        grossMarginPercent: null,
      }),
    ]);
  });

  it('calcule la marge uniquement lorsque tous les événements sont tarifés', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        category: 'TELEPHONY_SECONDS',
        quantity: new Prisma.Decimal(120),
        estimatedCost: new Prisma.Decimal('12.50'),
        metadata: { costStatus: 'PRICED' },
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-1', name: 'Chez Suppernote', plan: 'STARTER' },
    ] as never);

    const report = await getInternalMarginReport({ monthKey: '2026-09' });

    expect(report[0]).toMatchObject({
      catalogPriceEur: 199,
      costStatus: 'PRICED',
      estimatedCostEur: '12.500000',
      knownAdjustedCostEur: '12.500000',
      pricedEventCount: 1,
      unpricedEventCount: 0,
      approvedAdjustmentCostEur: '0.000000',
      approvedAdjustmentCount: 0,
      adjustedCostEur: '12.500000',
      grossMarginEur: '186.500000',
      grossMarginPercent: '93.72',
    });
  });

  it('applique les corrections approuvées au coût sans modifier le coût source', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        category: 'TELEPHONY_SECONDS',
        quantity: new Prisma.Decimal(120),
        estimatedCost: new Prisma.Decimal('12.50'),
        metadata: { costStatus: 'PRICED' },
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);
    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        costDeltaEur: new Prisma.Decimal('1.25'),
      },
    ] as never);

    const report = await getInternalMarginReport({ monthKey: '2026-09' });

    expect(report[0]).toMatchObject({
      estimatedCostEur: '12.500000',
      knownAdjustedCostEur: '13.750000',
      pricedEventCount: 1,
      unpricedEventCount: 0,
      approvedAdjustmentCostEur: '1.250000',
      approvedAdjustmentCount: 1,
      adjustedCostEur: '13.750000',
      grossMarginEur: '285.250000',
      grossMarginPercent: '95.40',
    });
    expect(db.usageReconciliationAdjustment.findMany).toHaveBeenCalledWith({
      where: {
        status: 'APPROVED',
        periodStart: {
          gte: new Date('2026-09-01T00:00:00.000Z'),
          lt: new Date('2026-10-01T00:00:00.000Z'),
        },
        periodEnd: {
          gt: new Date('2026-09-01T00:00:00.000Z'),
          lte: new Date('2026-10-01T00:00:00.000Z'),
        },
        restaurantId: { not: null },
      },
      select: { restaurantId: true, costDeltaEur: true },
    });
  });

  it('inclut un établissement sans usage dans le cockpit opérateur', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-zero', name: 'Le Calme', plan: 'PRO' },
    ] as never);

    const report = await getInternalMarginReport({ monthKey: '2026-09' });

    expect(report).toEqual([
      expect.objectContaining({
        restaurantId: 'restaurant-zero',
        restaurantName: 'Le Calme',
        catalogPriceEur: 299,
        estimatedCostEur: '0.000000',
        adjustedCostEur: '0.000000',
        knownAdjustedCostEur: '0.000000',
        pricedEventCount: 0,
        unpricedEventCount: 0,
        costStatus: 'NO_USAGE',
        grossMarginEur: null,
        categories: [],
      }),
    ]);
  });

  it('classifies mixed events within one category and totals only priced event cost', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(2),
        estimatedCost: new Prisma.Decimal('0.12'),
        metadata: { costStatus: 'PRICED' },
      },
      {
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(1),
        estimatedCost: new Prisma.Decimal(0),
        metadata: { costStatus: 'UNPRICED' },
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);

    const report = await getInternalMarginReport({ monthKey: '2026-09' });

    expect(report[0]).toMatchObject({
      costStatus: 'MIXED',
      pricedEventCount: 1,
      unpricedEventCount: 1,
      knownAdjustedCostEur: '0.120000',
      grossMarginEur: null,
    });
  });
});
