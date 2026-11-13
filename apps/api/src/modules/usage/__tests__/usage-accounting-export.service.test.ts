import { Prisma, UsageAdjustmentStatus } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import {
  getUsageAccountingExport,
  usageAccountingExportToCsv,
} from '../usage-accounting-export.service';

describe('usage accounting export', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('agrège le ledger par établissement et dimension, puis conserve les corrections séparées', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        provider: 'Telnyx',
        unit: 'Segments',
        quantity: new Prisma.Decimal('2'),
        estimatedCost: new Prisma.Decimal('0.015'),
        metadata: { costStatus: 'PRICED' },
      },
      {
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        provider: 'telnyx',
        unit: 'segments',
        quantity: new Prisma.Decimal('1'),
        estimatedCost: new Prisma.Decimal('0'),
        metadata: { costStatus: 'UNPRICED' },
      },
    ] as never);
    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValue([
      {
        id: 'adjustment-site',
        restaurantId: 'restaurant-1',
        category: 'SMS_SEGMENTS',
        provider: 'Telnyx',
        unit: 'Segments',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
        quantityDelta: new Prisma.Decimal('-1'),
        costDeltaEur: new Prisma.Decimal('0.007500'),
        reportHash: 'a'.repeat(64),
        evidenceRef: 'vault://invoice.csv',
        status: UsageAdjustmentStatus.APPROVED,
        reason: 'Correction fournisseur',
      },
      {
        id: 'adjustment-global',
        restaurantId: null,
        category: 'SMS_SEGMENTS',
        provider: 'Telnyx',
        unit: 'Segments',
        periodStart: new Date('2026-09-01T00:00:00.000Z'),
        periodEnd: new Date('2026-10-01T00:00:00.000Z'),
        quantityDelta: new Prisma.Decimal('4'),
        costDeltaEur: new Prisma.Decimal('-0.010000'),
        reportHash: 'b'.repeat(64),
        evidenceRef: 'vault://global-invoice.csv',
        status: UsageAdjustmentStatus.APPROVED,
        reason: 'Affectation à traiter',
      },
    ] as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'restaurant-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);

    const rows = await getUsageAccountingExport({ monthKey: '2026-09' });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      rowType: 'ADJUSTMENT',
      restaurantId: null,
      costStatus: 'UNALLOCATED',
      costEur: '-0.010000',
    });
    expect(rows[1]).toMatchObject({
      rowType: 'ADJUSTMENT',
      restaurantId: 'restaurant-1',
      costStatus: 'ADJUSTMENT',
      quantity: '-1.000000',
    });
    expect(rows[2]).toMatchObject({
      rowType: 'USAGE',
      restaurantId: 'restaurant-1',
      restaurantName: 'Chez Suppernote',
      category: 'SMS_SEGMENTS',
      quantity: '3.000000',
      costEur: '0.015000',
      costStatus: 'MIXED',
      eventCount: 2,
    });
    expect(db.usageEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { occurredAt: { gte: expect.any(Date), lt: expect.any(Date) } },
      }),
    );
    expect(db.usageReconciliationAdjustment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: UsageAdjustmentStatus.APPROVED }),
      }),
    );
  });

  it('échappe les cellules et conserve un ordre de colonnes stable', () => {
    const csv = usageAccountingExportToCsv({
      rows: [
        {
          schemaVersion: 1,
          month: '2026-09',
          rowType: 'USAGE',
          restaurantId: 'r-1',
          restaurantName: 'Chez, "Suppernote"',
          plan: 'PRO',
          category: 'EMAIL_MESSAGES',
          provider: 'resend',
          unit: 'messages',
          periodStart: '2026-09-01T00:00:00.000Z',
          periodEnd: '2026-10-01T00:00:00.000Z',
          quantity: '1.000000',
          costEur: '0.010000',
          currency: 'EUR',
          costStatus: 'PRICED',
          eventCount: 1,
          source: 'usage_event',
          reportHash: null,
          adjustmentId: null,
          adjustmentStatus: null,
          reason: null,
        },
      ],
    });

    expect(csv.split('\n')[0]).toContain('"schema_version","month","row_type"');
    expect(csv).toContain('"Chez, ""Suppernote"""');
    expect(csv.endsWith('\n')).toBe(true);
  });
});
