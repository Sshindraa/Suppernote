import { Prisma, UsageAdjustmentStatus } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

const AUTH = { authorization: 'Bearer fake-token' };

describe('usage routes', () => {
  afterAll(async () => {
    vi.unstubAllEnvs();
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'STARTER' } as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([]);
    vi.mocked(db.usageEvent.groupBy).mockResolvedValue([]);
    vi.mocked(db.usageMonthlyRollup.findMany).mockResolvedValue([]);
  });

  it('requires authentication', async () => {
    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/usage/current' });
    expect(response.statusCode).toBe(401);
  });

  it('returns observed quantities with an explicit unlimited customer policy', async () => {
    vi.mocked(db.usageEvent.groupBy).mockResolvedValue([
      { category: 'TELEPHONY_SECONDS', _sum: { quantity: new Prisma.Decimal(125) } },
    ] as never);

    const app = await getApp();
    const response = await app.inject({ method: 'GET', url: '/usage/current', headers: AUTH });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.usage).toEqual([{ category: 'TELEPHONY_SECONDS', quantity: '125.000000' }]);
    expect(body.customerUsagePolicy).toBe('UNLIMITED');
    expect(body.included).toEqual({ voiceMinutes: null, smsSegments: null });
    expect(body.limitsEnforced).toEqual({ voiceMinutes: false, smsSegments: false });
    expect(JSON.stringify(body)).not.toMatch(/cost|margin|provider/i);
  });

  it('returns bounded monthly history without estimated costs', async () => {
    vi.mocked(db.usageMonthlyRollup.findMany).mockResolvedValue([
      {
        restaurantId: 'test-rest-1',
        monthKey: '2026-08',
        category: 'SMS_SEGMENTS',
        quantity: new Prisma.Decimal(4),
        estimatedCost: new Prisma.Decimal('0.32'),
        updatedAt: new Date(),
      },
    ]);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/usage/history?from=2026-08&to=2026-09',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      from: '2026-08',
      to: '2026-09',
      months: [
        { month: '2026-08', categories: [{ category: 'SMS_SEGMENTS', quantity: '4.000000' }] },
      ],
    });
  });

  it('rejects malformed or reversed periods', async () => {
    const app = await getApp();
    const malformed = await app.inject({
      method: 'GET',
      url: '/usage/history?from=2026-13&to=2026-09',
      headers: AUTH,
    });
    expect(malformed.statusCode).toBe(400);

    const reversed = await app.inject({
      method: 'GET',
      url: '/usage/history?from=2026-10&to=2026-09',
      headers: AUTH,
    });
    expect(reversed.statusCode).toBe(400);

    const tooWide = await app.inject({
      method: 'GET',
      url: '/usage/history?from=2024-01&to=2026-09',
      headers: AUTH,
    });
    expect(tooWide.statusCode).toBe(400);
  });

  it('protects the internal margin feed with a dedicated token', async () => {
    vi.stubEnv('SOKAR_INTERNAL_USAGE_TOKEN', 'usage-secret');
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([]);

    const app = await getApp();
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/internal/usage/margin?month=2026-09',
      headers: { 'x-sokar-internal-usage-token': 'wrong' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/api/internal/usage/margin?month=2026-09',
      headers: { 'x-sokar-internal-usage-token': 'usage-secret' },
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ month: '2026-09', rows: [] });
  });

  it('does not expose the internal feed when its token is absent', async () => {
    vi.stubEnv('SOKAR_INTERNAL_USAGE_TOKEN', '');
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/api/internal/usage/margin',
    });
    expect(response.statusCode).toBe(503);
  });

  it('expose la projection de marge uniquement à un opérateur Suppernote', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([]);
    const app = await getApp();

    const unauthorized = await app.inject({ method: 'GET', url: '/admin/usage/margin' });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/admin/usage/margin?month=2026-09',
      headers: AUTH,
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({
      month: '2026-09',
      priceSource: 'LOCAL_CATALOG',
      revenueStatus: 'NOT_STRIPE_RECONCILED',
      rows: [],
    });
  });

  it('expose uniquement un probe d accès sans information sensible', async () => {
    const app = await getApp();

    const unauthorized = await app.inject({ method: 'GET', url: '/admin/access' });
    expect(unauthorized.statusCode).toBe(401);

    const authorized = await app.inject({
      method: 'GET',
      url: '/admin/access',
      headers: AUTH,
    });
    expect(authorized.statusCode).toBe(200);
    expect(authorized.json()).toEqual({ allowed: true });
  });

  it('pagine la file des corrections avec un curseur stable', async () => {
    const createdAt = new Date('2026-09-14T12:00:00.000Z');
    const adjustment = {
      id: 'adjustment-1',
      idempotencyKey: 'b'.repeat(64),
      reportHash: 'a'.repeat(64),
      evidenceRef: 'vault://invoice.json',
      scopeKey: 'global',
      restaurantId: null,
      category: 'SMS_SEGMENTS',
      provider: 'telnyx',
      unit: 'segments',
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      quantityDelta: new Prisma.Decimal('-2'),
      costDeltaEur: new Prisma.Decimal('0.015'),
      status: UsageAdjustmentStatus.OPEN,
      reason: 'Invoice correction',
      decisionReason: null,
      createdByHash: 'c'.repeat(64),
      decidedByHash: null,
      decidedAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValue([
      adjustment,
      { ...adjustment, id: 'adjustment-2', createdAt: new Date(createdAt.getTime() - 1000) },
    ] as never);

    const app = await getApp();
    const firstPage = await app.inject({
      method: 'GET',
      url: '/admin/usage/reconciliation-adjustments?limit=1&status=OPEN',
      headers: AUTH,
    });

    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.json()).toMatchObject({
      data: [{ id: 'adjustment-1', status: 'OPEN' }],
      hasMore: true,
      nextCursor: 'adjustment-1',
    });
    expect(db.usageReconciliationAdjustment.findMany).toHaveBeenLastCalledWith({
      where: { status: 'OPEN' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });

    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValueOnce([
      { ...adjustment, id: 'adjustment-2' },
    ] as never);
    const secondPage = await app.inject({
      method: 'GET',
      url: '/admin/usage/reconciliation-adjustments?limit=1&cursor=adjustment-1',
      headers: AUTH,
    });

    expect(secondPage.json()).toMatchObject({
      data: [{ id: 'adjustment-2' }],
      hasMore: false,
      nextCursor: null,
    });
    expect(db.usageReconciliationAdjustment.findMany).toHaveBeenLastCalledWith({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
      cursor: { id: 'adjustment-1' },
      skip: 1,
    });
  });

  it('expose un export comptable CSV réservé à un opérateur', async () => {
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([
      {
        restaurantId: 'rest-1',
        category: 'SMS_SEGMENTS',
        provider: 'telnyx',
        unit: 'segments',
        quantity: new Prisma.Decimal('2'),
        estimatedCost: new Prisma.Decimal('0.015'),
        metadata: { costStatus: 'PRICED' },
      },
    ] as never);
    vi.mocked(db.usageReconciliationAdjustment.findMany).mockResolvedValue([]);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'rest-1', name: 'Chez Suppernote', plan: 'PRO' },
    ] as never);

    const app = await getApp();
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/admin/usage/accounting-export.csv?month=2026-09',
    });
    expect(unauthorized.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: '/admin/usage/accounting-export.csv?month=2026-09',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain(
      'suppernote-usage-accounting-2026-09.csv',
    );
    expect(response.body).toContain('"row_type"');
    expect(response.body).toContain('"USAGE"');
    expect(response.body).toContain('"Chez Suppernote"');
  });

  it('enregistre une correction de rapprochement sans exposer l identité opérateur', async () => {
    const adjustment = {
      id: 'adjustment-1',
      idempotencyKey: 'b'.repeat(64),
      reportHash: 'a'.repeat(64),
      evidenceRef: 'vault://invoices/telnyx-2026-09.json',
      scopeKey: 'restaurant:rest-1',
      restaurantId: 'rest-1',
      category: 'SMS_SEGMENTS',
      provider: 'telnyx',
      unit: 'segments',
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      quantityDelta: new Prisma.Decimal('-2'),
      costDeltaEur: new Prisma.Decimal('0.015'),
      status: UsageAdjustmentStatus.OPEN,
      reason: 'Provider invoice includes two rejected segments.',
      decisionReason: null,
      createdByHash: 'c'.repeat(64),
      decidedByHash: null,
      decidedAt: null,
      createdAt: new Date('2026-09-14T12:00:00.000Z'),
      updatedAt: new Date('2026-09-14T12:00:00.000Z'),
    };
    vi.mocked(db.usageReconciliationAdjustment.findUnique).mockResolvedValueOnce(null);
    vi.mocked(db.usageReconciliationAdjustment.create).mockResolvedValue(adjustment as never);

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/usage/reconciliation-adjustments',
      headers: AUTH,
      payload: {
        reportHash: 'a'.repeat(64),
        evidenceRef: 'vault://invoices/telnyx-2026-09.json',
        scopeKey: 'restaurant:rest-1',
        restaurantId: 'rest-1',
        category: 'SMS_SEGMENTS',
        provider: 'Telnyx',
        unit: 'Segments',
        periodStart: '2026-09-01T00:00:00.000Z',
        periodEnd: '2026-10-01T00:00:00.000Z',
        quantityDelta: '-2',
        costDeltaEur: '0.015',
        reason: 'Provider invoice includes two rejected segments.',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      id: 'adjustment-1',
      status: 'OPEN',
      quantityDelta: '-2.000000',
    });
    expect(response.json().data.createdByHash).toBeUndefined();
    expect(db.usageReconciliationAdjustment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ createdByHash: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    });
  });

  it('décide une correction avec une transition atomique', async () => {
    const open = {
      id: 'adjustment-1',
      idempotencyKey: 'b'.repeat(64),
      reportHash: 'a'.repeat(64),
      evidenceRef: 'vault://invoices/telnyx-2026-09.json',
      scopeKey: 'restaurant:rest-1',
      restaurantId: 'rest-1',
      category: 'SMS_SEGMENTS',
      provider: 'telnyx',
      unit: 'segments',
      periodStart: new Date('2026-09-01T00:00:00.000Z'),
      periodEnd: new Date('2026-10-01T00:00:00.000Z'),
      quantityDelta: new Prisma.Decimal('-2'),
      costDeltaEur: new Prisma.Decimal('0.015'),
      status: UsageAdjustmentStatus.OPEN,
      reason: 'Provider invoice includes two rejected segments.',
      decisionReason: null,
      createdByHash: 'c'.repeat(64),
      decidedByHash: null,
      decidedAt: null,
      createdAt: new Date('2026-09-14T12:00:00.000Z'),
      updatedAt: new Date('2026-09-14T12:00:00.000Z'),
    };
    const approved = {
      ...open,
      status: UsageAdjustmentStatus.APPROVED,
      decisionReason: 'Validated against provider invoice.',
      decidedByHash: 'd'.repeat(64),
      decidedAt: new Date('2026-09-14T12:05:00.000Z'),
    };
    vi.mocked(db.usageReconciliationAdjustment.findUnique)
      .mockResolvedValueOnce(open as never)
      .mockResolvedValueOnce(approved as never);
    vi.mocked(db.usageReconciliationAdjustment.updateMany).mockResolvedValue({ count: 1 });

    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/admin/usage/reconciliation-adjustments/adjustment-1/decision',
      headers: AUTH,
      payload: { status: 'APPROVED', reason: 'Validated against provider invoice.' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('APPROVED');
    expect(db.usageReconciliationAdjustment.updateMany).toHaveBeenCalledWith({
      where: { id: 'adjustment-1', status: UsageAdjustmentStatus.OPEN },
      data: expect.objectContaining({ status: UsageAdjustmentStatus.APPROVED }),
    });
  });
});
