import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { LoyaltyBenefitStatus, LoyaltyGrantStatus } from '@prisma/client';
import { z } from 'zod';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import {
  createLoyaltyBenefit,
  expireLoyaltyGrants,
  issueLoyaltyGrant,
  listLoyaltyBenefits,
  listLoyaltyGrants,
  LoyaltyBenefitNotFoundError,
  LoyaltyCustomerNotFoundError,
  LoyaltyGrantConflictError,
  LoyaltyGrantNotFoundError,
  LoyaltyGrantStateError,
  LoyaltyInputError,
  LoyaltyNotEligibleError,
  LOYALTY_BENEFIT_RULES,
  redeemLoyaltyGrant,
  updateLoyaltyBenefit,
  voidLoyaltyGrant,
} from './loyalty.service';

const BenefitParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const GrantParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const BenefitRuleSchema = z.enum(LOYALTY_BENEFIT_RULES);
const CreateBenefitBodySchema = z.object({
  key: z.string().trim().min(2).max(48),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).nullable().optional(),
  rule: BenefitRuleSchema.optional(),
  ruleValue: z.number().int().min(1).max(5_000_000).nullable().optional(),
  costCents: z.number().int().min(0).max(1_000_000).nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  validityDays: z.number().int().min(1).max(365).optional(),
  maxUsesPerCustomer: z.number().int().min(1).max(100).optional(),
});
const UpdateBenefitBodySchema = CreateBenefitBodySchema.partial().extend({
  status: z.nativeEnum(LoyaltyBenefitStatus).optional(),
});
const BenefitListQuerySchema = z.object({
  status: z.nativeEnum(LoyaltyBenefitStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const GrantListQuerySchema = z.object({
  customerId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(LoyaltyGrantStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const IssueGrantBodySchema = z.object({
  benefitId: z.string().trim().min(1).max(128),
  customerId: z.string().trim().min(1).max(128),
  reservationId: z.string().trim().min(1).max(128).optional(),
});
const RedeemGrantBodySchema = z.object({
  code: z.string().trim().min(12).max(64),
  reservationId: z.string().trim().min(1).max(128).optional(),
  note: z.string().max(1_000).nullable().optional(),
});
const VoidGrantBodySchema = z.object({ note: z.string().max(1_000).nullable().optional() });
const IdempotencyKeySchema = z.string().trim().min(8).max(200);

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  return IdempotencyKeySchema.parse(candidate);
}

async function requireLoyaltyReadRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (
    request.siteRole === 'OWNER' ||
    request.siteRole === 'MANAGER' ||
    request.siteRole === 'STAFF'
  ) {
    return;
  }
  return reply.status(403).send({
    error: 'LOYALTY_ROLE_REQUIRED',
    message: 'La lecture des avantages est réservée à l’équipe du site.',
  });
}

async function requireLoyaltyWriteRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'LOYALTY_ROLE_REQUIRED',
    message: 'La gestion des avantages est réservée aux responsables.',
  });
}

function sendLoyaltyError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (
    error instanceof LoyaltyBenefitNotFoundError ||
    error instanceof LoyaltyCustomerNotFoundError ||
    error instanceof LoyaltyGrantNotFoundError
  ) {
    return reply.status(404).send({ error: error.code });
  }
  if (error instanceof LoyaltyGrantConflictError) {
    return reply.status(409).send({ error: error.code });
  }
  if (error instanceof LoyaltyGrantStateError) {
    return reply.status(409).send({ error: error.code });
  }
  if (error instanceof LoyaltyNotEligibleError) {
    return reply.status(422).send({ error: error.code, reason: error.reason });
  }
  if (error instanceof LoyaltyInputError) {
    return reply.status(400).send({ error: error.code, message: error.message });
  }
  return undefined;
}

const loyaltyRead = [requireOrg(), requireCapability('reputation.loyalty'), requireLoyaltyReadRole];
const loyaltyWrite = [
  requireOrg(),
  requireCapability('reputation.loyalty'),
  requireLoyaltyWriteRole,
];
const loyaltyConsume = [
  requireOrg(),
  requireCapability('reputation.loyalty'),
  requireLoyaltyReadRole,
];

/**
 * Provider-neutral benefits. This module issues and redeems bounded perks but
 * deliberately never sends a message or calls a payment/review provider.
 */
export async function loyaltyRoutes(app: FastifyInstance): Promise<void> {
  app.get('/loyalty/benefits', { preHandler: loyaltyRead }, async (request, reply) => {
    const query = BenefitListQuerySchema.parse(request.query);
    return reply.send({
      data: await listLoyaltyBenefits({
        restaurantId: request.restaurantId,
        status: query.status,
        limit: query.limit,
      }),
    });
  });

  app.post('/loyalty/benefits', { preHandler: loyaltyWrite }, async (request, reply) => {
    const body = CreateBenefitBodySchema.parse(request.body);
    try {
      const benefit = await createLoyaltyBenefit({
        restaurantId: request.restaurantId,
        ...body,
        actor: request.userId ?? 'unknown',
      });
      return reply.status(201).send({ data: benefit });
    } catch (error) {
      return sendLoyaltyError(error, reply) ?? Promise.reject(error);
    }
  });

  app.patch('/loyalty/benefits/:id', { preHandler: loyaltyWrite }, async (request, reply) => {
    const { id } = BenefitParamsSchema.parse(request.params);
    const body = UpdateBenefitBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await updateLoyaltyBenefit({
          restaurantId: request.restaurantId,
          benefitId: id,
          ...body,
        }),
      });
    } catch (error) {
      return sendLoyaltyError(error, reply) ?? Promise.reject(error);
    }
  });

  app.get('/loyalty/grants', { preHandler: loyaltyRead }, async (request, reply) => {
    const query = GrantListQuerySchema.parse(request.query);
    return reply.send({
      data: await listLoyaltyGrants({
        restaurantId: request.restaurantId,
        customerId: query.customerId,
        status: query.status,
        limit: query.limit,
      }),
    });
  });

  app.post('/loyalty/grants', { preHandler: loyaltyWrite }, async (request, reply) => {
    const body = IssueGrantBodySchema.parse(request.body);
    try {
      const result = await issueLoyaltyGrant({
        restaurantId: request.restaurantId,
        ...body,
        idempotencyKey: readIdempotencyKey(request),
        actor: request.userId ?? 'unknown',
      });
      return reply.status(result.replayed ? 200 : 201).send({ data: result });
    } catch (error) {
      return sendLoyaltyError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post('/loyalty/grants/:id/redeem', { preHandler: loyaltyConsume }, async (request, reply) => {
    const { id } = GrantParamsSchema.parse(request.params);
    const body = RedeemGrantBodySchema.parse(request.body);
    try {
      const result = await redeemLoyaltyGrant({
        restaurantId: request.restaurantId,
        grantId: id,
        ...body,
        actor: request.userId ?? 'unknown',
      });
      return reply.send({ data: result });
    } catch (error) {
      return sendLoyaltyError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post('/loyalty/grants/:id/void', { preHandler: loyaltyWrite }, async (request, reply) => {
    const { id } = GrantParamsSchema.parse(request.params);
    const body = VoidGrantBodySchema.parse(request.body ?? {});
    try {
      return reply.send({
        data: await voidLoyaltyGrant({
          restaurantId: request.restaurantId,
          grantId: id,
          actor: request.userId ?? 'unknown',
          note: body.note,
        }),
      });
    } catch (error) {
      return sendLoyaltyError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post(
    '/api/internal/loyalty/grants/expire',
    { preHandler: requirePlatformOperator() },
    async (_request, reply) => {
      return reply.send({ expiredCount: await expireLoyaltyGrants() });
    },
  );
}
