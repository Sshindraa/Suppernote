import { Prisma, UsageAdjustmentStatus, type UsageCategory } from '@prisma/client';
import { db } from '../../shared/db/client';
import { monthBounds } from './usage.service';

/** Stable column order for the operator/accounting export. */
export const USAGE_ACCOUNTING_EXPORT_COLUMNS = [
  'schema_version',
  'month',
  'row_type',
  'restaurant_id',
  'restaurant_name',
  'plan',
  'category',
  'provider',
  'unit',
  'period_start',
  'period_end',
  'quantity',
  'cost_eur',
  'currency',
  'cost_status',
  'event_count',
  'source',
  'report_hash',
  'adjustment_id',
  'adjustment_status',
  'reason',
] as const;

export type UsageAccountingExportRow = {
  readonly schemaVersion: 1;
  readonly month: string;
  readonly rowType: 'USAGE' | 'ADJUSTMENT';
  readonly restaurantId: string | null;
  readonly restaurantName: string | null;
  readonly plan: string | null;
  readonly category: UsageCategory;
  readonly provider: string;
  readonly unit: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly quantity: string;
  readonly costEur: string;
  readonly currency: 'EUR';
  readonly costStatus: 'PRICED' | 'UNPRICED' | 'MIXED' | 'ADJUSTMENT' | 'UNALLOCATED';
  readonly eventCount: number | null;
  /** `usage_event` for ledger rows, or the evidence reference for adjustments. */
  readonly source: string | null;
  readonly reportHash: string | null;
  readonly adjustmentId: string | null;
  readonly adjustmentStatus: UsageAdjustmentStatus | null;
  readonly reason: string | null;
};

function decimal(value: Prisma.Decimal | string | number): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function isPriced(metadata: unknown, estimatedCost: Prisma.Decimal): boolean {
  if (metadata && typeof metadata === 'object') {
    const status = (metadata as Record<string, unknown>).costStatus;
    if (status === 'PRICED') return true;
    if (status === 'UNPRICED') return false;
  }
  return !estimatedCost.isZero();
}

function dimensionKey(input: {
  restaurantId: string;
  category: UsageCategory;
  provider: string;
  unit: string;
}): string {
  return [
    input.restaurantId,
    input.category,
    input.provider.toLowerCase(),
    input.unit.toLowerCase(),
  ].join('|');
}

function csvCell(value: unknown): string {
  let text = String(value ?? '');
  // Un texte commençant par = + - @ ou une tabulation devient une formule dans un tableur ;
  // les montants négatifs (« -1.20 ») restent des nombres.
  if (/^\s*[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function rowValue(
  row: UsageAccountingExportRow,
  column: (typeof USAGE_ACCOUNTING_EXPORT_COLUMNS)[number],
): unknown {
  switch (column) {
    case 'schema_version':
      return row.schemaVersion;
    case 'month':
      return row.month;
    case 'row_type':
      return row.rowType;
    case 'restaurant_id':
      return row.restaurantId;
    case 'restaurant_name':
      return row.restaurantName;
    case 'plan':
      return row.plan;
    case 'category':
      return row.category;
    case 'provider':
      return row.provider;
    case 'unit':
      return row.unit;
    case 'period_start':
      return row.periodStart;
    case 'period_end':
      return row.periodEnd;
    case 'quantity':
      return row.quantity;
    case 'cost_eur':
      return row.costEur;
    case 'currency':
      return row.currency;
    case 'cost_status':
      return row.costStatus;
    case 'event_count':
      return row.eventCount;
    case 'source':
      return row.source;
    case 'report_hash':
      return row.reportHash;
    case 'adjustment_id':
      return row.adjustmentId;
    case 'adjustment_status':
      return row.adjustmentStatus;
    case 'reason':
      return row.reason;
  }
}

/** Serialize the export with a stable schema and escaped cells. */
export function usageAccountingExportToCsv(input: {
  readonly rows: UsageAccountingExportRow[];
}): string {
  const header = USAGE_ACCOUNTING_EXPORT_COLUMNS.map(csvCell).join(',');
  const body = input.rows.map((row) =>
    USAGE_ACCOUNTING_EXPORT_COLUMNS.map((column) => csvCell(rowValue(row, column))).join(','),
  );
  return `${[header, ...body].join('\n')}\n`;
}

/**
 * Build a month-bounded accounting feed from immutable usage events and
 * approved reconciliation adjustments. No source row is mutated. Global
 * adjustments are exported explicitly as UNALLOCATED so downstream accounting
 * cannot silently assign them to a restaurant.
 */
export async function getUsageAccountingExport(input: {
  readonly monthKey: string;
  readonly restaurantId?: string;
}): Promise<UsageAccountingExportRow[]> {
  const { start, end } = monthBounds(input.monthKey);
  const [events, adjustments] = await Promise.all([
    db.usageEvent.findMany({
      where: {
        ...(input.restaurantId ? { restaurantId: input.restaurantId } : {}),
        occurredAt: { gte: start, lt: end },
      },
      select: {
        restaurantId: true,
        category: true,
        provider: true,
        unit: true,
        quantity: true,
        estimatedCost: true,
        metadata: true,
      },
    }),
    db.usageReconciliationAdjustment.findMany({
      where: {
        status: UsageAdjustmentStatus.APPROVED,
        // A multi-month correction must be split before it appears in a
        // monthly export; applying it in full would duplicate cost.
        periodStart: { gte: start, lt: end },
        periodEnd: { gt: start, lte: end },
        ...(input.restaurantId ? { restaurantId: input.restaurantId } : {}),
      },
      select: {
        id: true,
        restaurantId: true,
        category: true,
        provider: true,
        unit: true,
        periodStart: true,
        periodEnd: true,
        quantityDelta: true,
        costDeltaEur: true,
        reportHash: true,
        evidenceRef: true,
        status: true,
        reason: true,
      },
    }),
  ]);

  const restaurantIds = new Set<string>();
  for (const event of events) restaurantIds.add(event.restaurantId);
  for (const adjustment of adjustments) {
    if (adjustment.restaurantId) restaurantIds.add(adjustment.restaurantId);
  }
  const restaurants = restaurantIds.size
    ? await db.restaurant.findMany({
        where: { id: { in: [...restaurantIds] } },
        select: { id: true, name: true, plan: true },
      })
    : [];
  const restaurantById = new Map(restaurants.map((restaurant) => [restaurant.id, restaurant]));

  type UsageBucket = {
    restaurantId: string;
    category: UsageCategory;
    provider: string;
    unit: string;
    quantity: Prisma.Decimal;
    cost: Prisma.Decimal;
    pricedEvents: number;
    unpricedEvents: number;
  };
  const buckets = new Map<string, UsageBucket>();
  for (const event of events) {
    const provider = event.provider.trim().toLowerCase();
    const unit = event.unit.trim().toLowerCase();
    const key = dimensionKey({
      restaurantId: event.restaurantId,
      category: event.category,
      provider,
      unit,
    });
    const bucket = buckets.get(key) ?? {
      restaurantId: event.restaurantId,
      category: event.category,
      provider,
      unit,
      quantity: new Prisma.Decimal(0),
      cost: new Prisma.Decimal(0),
      pricedEvents: 0,
      unpricedEvents: 0,
    };
    const eventCost = decimal(event.estimatedCost);
    bucket.quantity = bucket.quantity.add(decimal(event.quantity));
    bucket.cost = bucket.cost.add(eventCost);
    if (isPriced(event.metadata, eventCost)) bucket.pricedEvents++;
    else bucket.unpricedEvents++;
    buckets.set(key, bucket);
  }

  const rows: UsageAccountingExportRow[] = [...buckets.values()].map((bucket) => ({
    schemaVersion: 1,
    month: input.monthKey,
    rowType: 'USAGE',
    restaurantId: bucket.restaurantId,
    restaurantName: restaurantById.get(bucket.restaurantId)?.name ?? null,
    plan: restaurantById.get(bucket.restaurantId)?.plan ?? null,
    category: bucket.category,
    provider: bucket.provider,
    unit: bucket.unit,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    quantity: bucket.quantity.toFixed(6),
    costEur: bucket.cost.toFixed(6),
    currency: 'EUR',
    costStatus:
      bucket.pricedEvents === 0 ? 'UNPRICED' : bucket.unpricedEvents === 0 ? 'PRICED' : 'MIXED',
    eventCount: bucket.pricedEvents + bucket.unpricedEvents,
    source: 'usage_event',
    reportHash: null,
    adjustmentId: null,
    adjustmentStatus: null,
    reason: null,
  }));

  for (const adjustment of adjustments) {
    const restaurant = adjustment.restaurantId ? restaurantById.get(adjustment.restaurantId) : null;
    rows.push({
      schemaVersion: 1,
      month: input.monthKey,
      rowType: 'ADJUSTMENT',
      restaurantId: adjustment.restaurantId,
      restaurantName: restaurant?.name ?? null,
      plan: restaurant?.plan ?? null,
      category: adjustment.category,
      provider: adjustment.provider.trim().toLowerCase(),
      unit: adjustment.unit.trim().toLowerCase(),
      periodStart: adjustment.periodStart.toISOString(),
      periodEnd: adjustment.periodEnd.toISOString(),
      quantity: decimal(adjustment.quantityDelta).toFixed(6),
      costEur: decimal(adjustment.costDeltaEur).toFixed(6),
      currency: 'EUR',
      costStatus: adjustment.restaurantId ? 'ADJUSTMENT' : 'UNALLOCATED',
      eventCount: null,
      source: adjustment.evidenceRef,
      reportHash: adjustment.reportHash,
      adjustmentId: adjustment.id,
      adjustmentStatus: adjustment.status,
      reason: adjustment.reason,
    });
  }

  rows.sort((left, right) => {
    const leftKey = [
      left.restaurantId ?? '',
      left.rowType,
      left.category,
      left.provider,
      left.unit,
      left.periodStart,
      left.adjustmentId ?? '',
    ].join('|');
    const rightKey = [
      right.restaurantId ?? '',
      right.rowType,
      right.category,
      right.provider,
      right.unit,
      right.periodStart,
      right.adjustmentId ?? '',
    ].join('|');
    return leftKey.localeCompare(rightKey);
  });
  return rows;
}
