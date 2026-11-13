import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  UsageAdjustmentStatus,
  UsageCategory,
  type UsageReconciliationAdjustment,
} from '@prisma/client';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { db } from '../../shared/db/client';
import {
  currentMonthKey,
  getCurrentUsage,
  getUsageHistory,
  UsageInputError,
} from './usage.service';
import { buildUsageQuotaSnapshot } from './usage-quota.service';
import { getInternalMarginReport, getInternalUsageSummary } from './usage-internal.service';
import {
  getUsageAccountingExport,
  usageAccountingExportToCsv,
} from './usage-accounting-export.service';
import {
  UsageAdjustmentConflictError,
  UsageAdjustmentInputError,
  UsageAdjustmentNotFoundError,
  UsageAdjustmentStateError,
  decideUsageAdjustment,
  recordUsageAdjustment,
} from './usage-adjustment.service';

const MonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const HistoryQuerySchema = z.object({ from: MonthSchema, to: MonthSchema });
const InternalUsageQuerySchema = z.object({
  month: MonthSchema.optional(),
  restaurantId: z.string().trim().min(1).max(128).optional(),
});
const AdjustmentDecimalSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^-?\d+(?:\.\d+)?$/),
  z.number().finite(),
]);
const AdjustmentDateSchema = z.string().datetime({ offset: true });
const AdjustmentCreateSchema = z.object({
  reportHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i),
  evidenceRef: z.string().trim().min(1).max(191),
  scopeKey: z.string().trim().min(1).max(191),
  restaurantId: z.string().trim().min(1).max(128).nullable().optional(),
  category: z.nativeEnum(UsageCategory),
  provider: z.string().trim().min(1).max(64),
  unit: z.string().trim().min(1).max(32),
  periodStart: AdjustmentDateSchema,
  periodEnd: AdjustmentDateSchema,
  quantityDelta: AdjustmentDecimalSchema,
  costDeltaEur: AdjustmentDecimalSchema,
  reason: z.string().trim().min(1).max(512),
});
const AdjustmentDecisionSchema = z.object({
  status: z.enum([UsageAdjustmentStatus.APPROVED, UsageAdjustmentStatus.REJECTED]),
  reason: z.string().trim().min(1).max(512),
});
const AdjustmentQuerySchema = z.object({
  status: z.nativeEnum(UsageAdjustmentStatus).optional(),
  scopeKey: z.string().trim().min(1).max(191).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().trim().min(1).max(128).optional(),
});
const AdjustmentIdParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });

function operatorHash(request: FastifyRequest): string {
  return createHash('sha256')
    .update(request.userId ?? 'unknown')
    .digest('hex');
}

function serializeAdjustment(adjustment: UsageReconciliationAdjustment) {
  return {
    id: adjustment.id,
    idempotencyKey: adjustment.idempotencyKey,
    reportHash: adjustment.reportHash,
    evidenceRef: adjustment.evidenceRef,
    scopeKey: adjustment.scopeKey,
    restaurantId: adjustment.restaurantId,
    category: adjustment.category,
    provider: adjustment.provider,
    unit: adjustment.unit,
    periodStart: adjustment.periodStart.toISOString(),
    periodEnd: adjustment.periodEnd.toISOString(),
    quantityDelta: adjustment.quantityDelta.toFixed(6),
    costDeltaEur: adjustment.costDeltaEur.toFixed(6),
    status: adjustment.status,
    reason: adjustment.reason,
    decisionReason: adjustment.decisionReason,
    createdAt: adjustment.createdAt.toISOString(),
    updatedAt: adjustment.updatedAt.toISOString(),
  };
}

async function requireInternalUsageToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  const expected = process.env.SOKAR_INTERNAL_USAGE_TOKEN?.trim();
  if (!expected) {
    return reply.status(503).send({ error: 'INTERNAL_USAGE_TOKEN_NOT_CONFIGURED' });
  }
  const suppliedHeader = request.headers['x-sokar-internal-usage-token'];
  const supplied = Array.isArray(suppliedHeader) ? suppliedHeader[0] : suppliedHeader;
  if (!supplied) return reply.status(401).send({ error: 'INTERNAL_USAGE_UNAUTHORIZED' });
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    return reply.status(401).send({ error: 'INTERNAL_USAGE_UNAUTHORIZED' });
  }
}

export async function usageRoutes(app: FastifyInstance) {
  app.get('/usage/current', { preHandler: requireOrg() }, async (request, reply) => {
    const restaurantId = request.restaurantId;
    const month = currentMonthKey();
    const usage = await getCurrentUsage(restaurantId, month);

    // Suppernote sells an unlimited customer experience. The usage ledger remains
    // visible to the restaurant for transparency, while cost monitoring and
    // any operator budgets stay on the internal margin surface. Keep the
    // legacy `included`/`quotas` fields for compatible clients, but always
    // return the non-enforcing shape here so a plan change cannot introduce a
    // customer-facing cap by accident.
    const customerLimits = { voiceMinutesMonthly: null, smsMonthly: null } as const;
    const quotas = buildUsageQuotaSnapshot(usage, customerLimits);

    return reply.send({
      month,
      usage,
      customerUsagePolicy: 'UNLIMITED',
      included: {
        voiceMinutes: customerLimits.voiceMinutesMonthly,
        smsSegments: customerLimits.smsMonthly,
      },
      limitsEnforced: {
        voiceMinutes: false,
        smsSegments: false,
      },
      quotas,
    });
  });

  app.get('/usage/history', { preHandler: requireOrg() }, async (request, reply) => {
    const query = HistoryQuerySchema.parse(request.query);
    try {
      return reply.send({
        from: query.from,
        to: query.to,
        months: await getUsageHistory(request.restaurantId, query.from, query.to),
      });
    } catch (error) {
      if (error instanceof UsageInputError) {
        return reply.status(400).send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  /** Internal-only cost feed for margin and tariff reconciliation. */
  app.get(
    '/api/internal/usage/margin',
    { preHandler: requireInternalUsageToken },
    async (request, reply) => {
      const query = InternalUsageQuerySchema.parse(request.query);
      try {
        const month = query.month ?? currentMonthKey();
        return reply.send({
          month,
          rows: await getInternalUsageSummary({
            monthKey: month,
            restaurantId: query.restaurantId,
          }),
        });
      } catch (error) {
        if (error instanceof UsageInputError) {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Lightweight capability probe for the dashboard shell. It deliberately
   * returns no role, user or tenant information: a successful response only
   * means that the authenticated session belongs to the Suppernote operator
   * allowlist. Non-operators are rejected by the same guard as every other
   * internal route.
   */
  app.get('/admin/access', { preHandler: requirePlatformOperator() }, async (_request, reply) => {
    return reply.send({ allowed: true });
  });

  /** Operator dashboard projection. Never exposed through the org-scoped client route. */
  app.get(
    '/admin/usage/margin',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const query = InternalUsageQuerySchema.parse(request.query);
      try {
        const month = query.month ?? currentMonthKey();
        return reply.send({
          month,
          priceSource: 'LOCAL_CATALOG',
          revenueStatus: 'NOT_STRIPE_RECONCILED',
          rows: await getInternalMarginReport({
            monthKey: month,
            restaurantId: query.restaurantId,
          }),
        });
      } catch (error) {
        if (error instanceof UsageInputError) {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  /**
   * Operator-only, month-bounded accounting feed. Usage rows remain immutable
   * and approved corrections are separate rows; global corrections are marked
   * UNALLOCATED instead of being assigned implicitly.
   */
  app.get(
    '/admin/usage/accounting-export.csv',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const query = InternalUsageQuerySchema.parse(request.query);
      const month = query.month ?? currentMonthKey();
      const rows = await getUsageAccountingExport({
        monthKey: month,
        restaurantId: query.restaurantId,
      });
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="suppernote-usage-accounting-${month}.csv"`,
        )
        .send(usageAccountingExportToCsv({ rows }));
    },
  );

  /**
   * Operator-only review queue for invoice/ledger differences. These records
   * are accounting evidence; they never alter UsageEvent or rollups.
   */
  app.get(
    '/admin/usage/reconciliation-adjustments',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const query = AdjustmentQuerySchema.parse(request.query);
      const adjustments = await db.usageReconciliationAdjustment.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.scopeKey ? { scopeKey: query.scopeKey } : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      });
      const hasMore = adjustments.length > query.limit;
      const page = hasMore ? adjustments.slice(0, query.limit) : adjustments;
      return reply.send({
        data: page.map(serializeAdjustment),
        hasMore,
        nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
      });
    },
  );

  app.post(
    '/admin/usage/reconciliation-adjustments',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const body = AdjustmentCreateSchema.parse(request.body ?? {});
      try {
        const result = await recordUsageAdjustment({
          ...body,
          periodStart: new Date(body.periodStart),
          periodEnd: new Date(body.periodEnd),
          createdByHash: operatorHash(request),
        });
        return reply
          .status(result.created ? 201 : 200)
          .send({ data: serializeAdjustment(result.adjustment), replayed: !result.created });
      } catch (error) {
        if (error instanceof UsageAdjustmentInputError) {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        if (error instanceof UsageAdjustmentConflictError) {
          return reply.status(409).send({ error: error.code });
        }
        throw error;
      }
    },
  );

  app.post(
    '/admin/usage/reconciliation-adjustments/:id/decision',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const { id } = AdjustmentIdParamsSchema.parse(request.params);
      const body = AdjustmentDecisionSchema.parse(request.body ?? {});
      try {
        const adjustment = await decideUsageAdjustment({
          id,
          status: body.status,
          reason: body.reason,
          decidedByHash: operatorHash(request),
        });
        return reply.send({ data: serializeAdjustment(adjustment) });
      } catch (error) {
        if (error instanceof UsageAdjustmentNotFoundError) {
          return reply.status(404).send({ error: error.code });
        }
        if (error instanceof UsageAdjustmentStateError) {
          return reply.status(409).send({ error: error.code, status: error.status });
        }
        if (error instanceof UsageAdjustmentInputError) {
          return reply.status(400).send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
