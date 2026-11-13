import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  DistributionConnectionStatus,
  DistributionProvider,
  DistributionReservationLinkStatus,
  DistributionSyncDirection,
  DistributionSyncRunStatus,
  DistributionWebhookStatus,
} from '@prisma/client';
import { z } from 'zod';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import {
  createDistributionSyncRun,
  createOrUpdateDistributionConnection,
  disconnectDistributionConnection,
  DistributionConflictError,
  DistributionConnectionNotFoundError,
  DistributionInputError,
  DistributionReservationNotFoundError,
  DistributionStateError,
  DistributionSyncRunNotFoundError,
  DistributionWebhookNotFoundError,
  finishDistributionSyncRun,
  finishDistributionWebhook,
  getDistributionConnection,
  ingestDistributionWebhook,
  linkDistributionReservation,
  listDistributionAvailability,
  listDistributionConnections,
  listDistributionReservationLinks,
  listDistributionSyncRuns,
  listDistributionWebhooks,
  upsertDistributionAvailability,
} from './distribution.service';

const ConnectionParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const RunParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const WebhookParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const ProviderSchema = z.nativeEnum(DistributionProvider);
const ConnectionBodySchema = z.object({
  provider: ProviderSchema,
  externalAccountId: z.string().trim().min(1).max(191).nullable().optional(),
  credentialReference: z.string().trim().min(1).max(200).nullable().optional(),
  configFingerprint: z.unknown().optional(),
  status: z.nativeEnum(DistributionConnectionStatus).optional(),
});
const RunBodySchema = z.object({
  direction: z.nativeEnum(DistributionSyncDirection),
  windowStart: z.coerce.date().nullable().optional(),
  windowEnd: z.coerce.date().nullable().optional(),
  sourceCursor: z.string().trim().max(512).nullable().optional(),
});
const RunListQuerySchema = z.object({
  connectionId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(DistributionSyncRunStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const FinishRunBodySchema = z.object({
  restaurantId: z.string().trim().min(1).max(128),
  status: z.enum([
    DistributionSyncRunStatus.SUCCEEDED,
    DistributionSyncRunStatus.FAILED,
    DistributionSyncRunStatus.NEEDS_REVIEW,
  ]),
  pushedCount: z.number().int().min(0).max(100_000).optional(),
  pulledCount: z.number().int().min(0).max(100_000).optional(),
  failedCount: z.number().int().min(0).max(100_000).optional(),
  targetCursor: z.string().trim().max(512).nullable().optional(),
  errorCode: z.string().trim().max(128).nullable().optional(),
});
const AvailabilityBodySchema = z.object({
  slotKey: z.string().trim().min(1).max(160),
  serviceDate: z.coerce.date(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  partySize: z.number().int().min(1).max(100),
  available: z.number().int().min(0).max(10_000),
  capacity: z.number().int().min(0).max(10_000),
  sourceRevision: z.string().trim().max(128).nullable().optional(),
  payloadHash: z.string().trim().length(64).nullable().optional(),
});
const AvailabilityQuerySchema = z.object({
  serviceDate: z.coerce.date().optional(),
  partySize: z.coerce.number().int().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});
const ReservationLinkBodySchema = z.object({
  reservationId: z.string().trim().min(1).max(128),
  externalReservationId: z.string().trim().min(1).max(191),
  source: z.string().trim().min(1).max(80),
});
const LinkListQuerySchema = z.object({
  connectionId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(DistributionReservationLinkStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const WebhookBodySchema = z.object({
  restaurantId: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(128).nullable().optional(),
  provider: ProviderSchema,
  externalEventId: z.string().trim().min(1).max(256),
  eventType: z.string().trim().min(1).max(120),
  payload: z.unknown().optional(),
  payloadHash: z.string().trim().length(64).nullable().optional(),
});
const WebhookListQuerySchema = z.object({
  connectionId: z.string().trim().min(1).max(128).optional(),
  provider: ProviderSchema.optional(),
  status: z.nativeEnum(DistributionWebhookStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const FinishWebhookBodySchema = z.object({
  restaurantId: z.string().trim().min(1).max(128),
  status: z.enum([
    DistributionWebhookStatus.PROCESSED,
    DistributionWebhookStatus.IGNORED,
    DistributionWebhookStatus.FAILED,
  ]),
  errorCode: z.string().trim().max(128).nullable().optional(),
});

function distributionEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.DISTRIBUTION_ENABLED === 'true';
}

function readIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate)
    throw new DistributionInputError(
      'DISTRIBUTION_IDEMPOTENCY_INVALID',
      "Une clé d'idempotence est requise.",
    );
  return candidate;
}

async function requireDistributionFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (distributionEnabled()) return;
  return reply.status(503).send({
    error: 'DISTRIBUTION_DISABLED',
    message: 'Les canaux partenaires restent désactivés jusqu’à la qualification d’un pilote.',
  });
}

async function requireDistributionReadRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (
    request.siteRole === 'OWNER' ||
    request.siteRole === 'MANAGER' ||
    request.siteRole === 'STAFF'
  )
    return;
  return reply.status(403).send({
    error: 'DISTRIBUTION_ROLE_REQUIRED',
    message: "La lecture des canaux est réservée à l'équipe du site.",
  });
}

async function requireDistributionWriteRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'DISTRIBUTION_ROLE_REQUIRED',
    message: 'La gestion des canaux est réservée aux responsables.',
  });
}

const distributionRead = [
  requireOrg(),
  requireCapability('distribution.manage'),
  requireDistributionReadRole,
  requireDistributionFeature,
];
const distributionWrite = [
  requireOrg(),
  requireCapability('distribution.manage'),
  requireDistributionWriteRole,
  requireDistributionFeature,
];

function sendDistributionError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (
    error instanceof DistributionConnectionNotFoundError ||
    error instanceof DistributionReservationNotFoundError ||
    error instanceof DistributionSyncRunNotFoundError ||
    error instanceof DistributionWebhookNotFoundError
  )
    return reply.status(404).send({ error: error.code });
  if (error instanceof DistributionConflictError || error instanceof DistributionStateError)
    return reply.status(409).send({ error: error.code, message: error.message });
  if (error instanceof DistributionInputError)
    return reply.status(400).send({ error: error.code, message: error.message });
  return undefined;
}

/**
 * Provider-neutral distribution contract. Provider adapters and signed public
 * webhooks are deliberately not registered until a pilot chooses a channel.
 */
export async function distributionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/distribution/connections', { preHandler: distributionRead }, async (request, reply) => {
    try {
      return reply.send({ data: await listDistributionConnections(request.restaurantId) });
    } catch (error) {
      return sendDistributionError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post(
    '/distribution/connections',
    { preHandler: distributionWrite },
    async (request, reply) => {
      const body = ConnectionBodySchema.parse(request.body);
      try {
        return reply.status(201).send({
          data: await createOrUpdateDistributionConnection({
            restaurantId: request.restaurantId,
            ...body,
          }),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get(
    '/distribution/connections/:id',
    { preHandler: distributionRead },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      try {
        return reply.send({ data: await getDistributionConnection(request.restaurantId, id) });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post(
    '/distribution/connections/:id/disconnect',
    { preHandler: distributionWrite },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      try {
        return reply.send({
          data: await disconnectDistributionConnection(request.restaurantId, id),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get(
    '/distribution/connections/:id/availability',
    { preHandler: distributionRead },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      const query = AvailabilityQuerySchema.parse(request.query);
      try {
        return reply.send({
          data: await listDistributionAvailability({
            restaurantId: request.restaurantId,
            connectionId: id,
            ...query,
          }),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post(
    '/distribution/connections/:id/availability',
    { preHandler: distributionWrite },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      const body = AvailabilityBodySchema.parse(request.body);
      try {
        return reply.status(201).send({
          data: await upsertDistributionAvailability({
            restaurantId: request.restaurantId,
            connectionId: id,
            ...body,
          }),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get('/distribution/sync-runs', { preHandler: distributionRead }, async (request, reply) => {
    const query = RunListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listDistributionSyncRuns({ restaurantId: request.restaurantId, ...query }),
      });
    } catch (error) {
      return sendDistributionError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post(
    '/distribution/connections/:id/sync-runs',
    { preHandler: distributionWrite },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      const body = RunBodySchema.parse(request.body);
      try {
        const data = await createDistributionSyncRun({
          restaurantId: request.restaurantId,
          connectionId: id,
          ...body,
          idempotencyKey: readIdempotencyKey(request),
          actor: request.userId ?? 'unknown',
        });
        return reply.status(data.replayed ? 200 : 201).send({ data });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get(
    '/distribution/reservation-links',
    { preHandler: distributionRead },
    async (request, reply) => {
      const query = LinkListQuerySchema.parse(request.query);
      try {
        return reply.send({
          data: await listDistributionReservationLinks({
            restaurantId: request.restaurantId,
            ...query,
          }),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post(
    '/distribution/connections/:id/reservation-links',
    { preHandler: distributionWrite },
    async (request, reply) => {
      const { id } = ConnectionParamsSchema.parse(request.params);
      const body = ReservationLinkBodySchema.parse(request.body);
      try {
        return reply.status(201).send({
          data: await linkDistributionReservation({
            restaurantId: request.restaurantId,
            connectionId: id,
            ...body,
          }),
        });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get('/distribution/webhooks', { preHandler: distributionRead }, async (request, reply) => {
    const query = WebhookListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listDistributionWebhooks({ restaurantId: request.restaurantId, ...query }),
      });
    } catch (error) {
      return sendDistributionError(error, reply) ?? Promise.reject(error);
    }
  });

  // Adapter fixtures and future signed provider callbacks enter through an
  // operator-only envelope until a provider-specific public contract exists.
  app.post(
    '/api/internal/distribution/webhook-events',
    { preHandler: [requirePlatformOperator()] },
    async (request, reply) => {
      const body = WebhookBodySchema.parse(request.body);
      try {
        return reply.status(201).send({ data: await ingestDistributionWebhook(body) });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post(
    '/api/internal/distribution/webhook-events/:id/finish',
    { preHandler: [requirePlatformOperator()] },
    async (request, reply) => {
      const { id } = WebhookParamsSchema.parse(request.params);
      const body = FinishWebhookBodySchema.parse(request.body);
      try {
        return reply.send({ data: await finishDistributionWebhook({ ...body, webhookId: id }) });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post(
    '/api/internal/distribution/sync-runs/:id/finish',
    { preHandler: [requirePlatformOperator()] },
    async (request, reply) => {
      const { id } = RunParamsSchema.parse(request.params);
      const body = FinishRunBodySchema.parse(request.body);
      try {
        return reply.send({ data: await finishDistributionSyncRun({ ...body, runId: id }) });
      } catch (error) {
        return sendDistributionError(error, reply) ?? Promise.reject(error);
      }
    },
  );
}

export { distributionEnabled };
