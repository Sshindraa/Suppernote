import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  ExperienceReservationStatus,
  ExperienceSessionStatus,
  ExperienceStatus,
  Prisma,
} from '@prisma/client';
import { z } from 'zod';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import { RATE_LIMIT_PUBLIC_READ, RATE_LIMIT_PUBLIC_WRITE } from '../../plugins/rate-limit.policy';
import { db } from '../../shared/db/client';
import {
  cancelPublicExperienceCheckout,
  createPublicExperienceCheckout,
  ExperienceCheckoutError,
  getExperiencePaymentReadiness,
  getPublicExperienceCheckout,
  listPublicExperiences,
} from './experience-payment.service';
import {
  cancelExperienceReservation,
  createExperience,
  deleteExperience,
  createExperienceSession,
  expireExperienceSessions,
  ExperienceConflictError,
  ExperienceCustomerNotFoundError,
  ExperienceInputError,
  ExperienceNotFoundError,
  ExperienceReservationNotFoundError,
  ExperienceReservationStateError,
  ExperienceSessionNotFoundError,
  listExperienceReservations,
  listExperiences,
  listExperienceSessions,
  reserveExperience,
  updateExperience,
  updateExperienceSession,
} from './experience.service';

const ExperienceParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const SessionParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().min(1).max(128),
});
const ReservationParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });

const CreateExperienceBodySchema = z.object({
  key: z.string().trim().min(2).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(1_000).nullable().optional(),
  durationMinutes: z.number().int().min(15).max(1_440),
  priceCents: z.number().int().min(0).max(1_000_000),
  currency: z.string().trim().length(3).optional(),
  capacity: z.number().int().min(1).max(1_000),
  status: z.nativeEnum(ExperienceStatus).optional(),
});
const UpdateExperienceBodySchema = CreateExperienceBodySchema.omit({ key: true }).partial();
const ExperienceListQuerySchema = z.object({
  status: z.nativeEnum(ExperienceStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const CreateSessionBodySchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  capacityOverride: z.number().int().min(1).max(1_000).nullable().optional(),
});
const UpdateSessionBodySchema = CreateSessionBodySchema.partial().extend({
  status: z.nativeEnum(ExperienceSessionStatus).optional(),
});
const SessionListQuerySchema = z.object({
  status: z.nativeEnum(ExperienceSessionStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const ReservationListQuerySchema = z.object({
  experienceId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  customerId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(ExperienceReservationStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const ReserveBodySchema = z.object({
  customerId: z.string().trim().min(1).max(128).optional(),
  reservationId: z.string().trim().min(1).max(128).optional(),
  quantity: z.number().int().min(1).max(1_000).default(1),
});

const IdempotencyKeySchema = z.string().trim().min(8).max(200);
const PublicExperienceSlugSchema = z.object({ slug: z.string().trim().min(1).max(160) });
const PublicExperienceCheckoutParamsSchema = PublicExperienceSlugSchema.extend({
  checkoutId: z.string().trim().guid(),
});
const PublicExperienceCheckoutBodySchema = z.object({
  experienceId: z.string().trim().guid(),
  sessionId: z.string().trim().guid(),
  quantity: z.number().int().min(1).max(20),
});
const PublicExperienceCheckoutStatusQuerySchema = z.object({
  session_id: z.string().trim().min(1).max(255),
});
const ExperiencePaymentCommissionSchema = z.object({
  restaurantId: z.string().trim().guid(),
  commissionRate: z.number().min(0).max(1).nullable(),
});

function experiencesEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.EXPERIENCES_ENABLED === 'true';
}

function experienceBookingEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return experiencesEnabled(environment) && environment.EXPERIENCE_BOOKING_ENABLED === 'true';
}

async function requireExperienceFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (experiencesEnabled()) return;
  return reply.status(503).send({
    error: 'EXPERIENCES_DISABLED',
    message: 'Les expériences restent désactivées jusqu’à la qualification du pilote.',
  });
}

async function requireExperienceReadRole(
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
    error: 'EXPERIENCES_ROLE_REQUIRED',
    message: 'La lecture des expériences est réservée à l’équipe du site.',
  });
}

async function requireExperienceWriteRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'EXPERIENCES_ROLE_REQUIRED',
    message: 'La gestion des expériences est réservée aux responsables.',
  });
}

function readIdempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) return undefined;
  return IdempotencyKeySchema.parse(candidate);
}

function sendExperienceError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (error instanceof ExperienceCheckoutError) {
    return reply.status(error.statusCode).send({ error: error.code });
  }
  if (
    error instanceof ExperienceNotFoundError ||
    error instanceof ExperienceSessionNotFoundError ||
    error instanceof ExperienceReservationNotFoundError ||
    error instanceof ExperienceCustomerNotFoundError
  ) {
    return reply.status(404).send({ error: error.code });
  }
  if (
    error instanceof ExperienceConflictError ||
    error instanceof ExperienceReservationStateError
  ) {
    return reply.status(409).send({ error: error.code });
  }
  if (error instanceof ExperienceInputError) {
    return reply.status(400).send({ error: error.code, message: error.message });
  }
  return undefined;
}

const experienceRead = [
  requireOrg(),
  requireCapability('experiences.manage'),
  requireExperienceReadRole,
  requireExperienceFeature,
];
const experienceWrite = [
  requireOrg(),
  requireCapability('experiences.manage'),
  requireExperienceWriteRole,
  requireExperienceFeature,
];
const experienceConsume = experienceRead;

/**
 * Provider-neutral catalogue and session reservations. This foundation owns
 * capacity and price snapshots but deliberately does not take payment or
 * publish to a third-party events channel.
 */
export async function experienceRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/experiences/payment-readiness',
    { preHandler: experienceRead },
    async (request, reply) => {
      try {
        return reply.send({ data: await getExperiencePaymentReadiness(request.restaurantId) });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.patch(
    '/api/internal/experiences/payment-config',
    { preHandler: requirePlatformOperator() },
    async (request, reply) => {
      const { restaurantId, commissionRate } = ExperiencePaymentCommissionSchema.parse(
        request.body,
      );
      const restaurant = await db.restaurant.updateMany({
        where: { id: restaurantId },
        data: {
          experienceCommissionRate:
            commissionRate === null ? null : new Prisma.Decimal(commissionRate),
        },
      });
      if (restaurant.count !== 1) return reply.status(404).send({ error: 'RESTAURANT_NOT_FOUND' });
      return reply.send({ data: { restaurantId, commissionConfigured: commissionRate !== null } });
    },
  );

  app.get(
    '/public/r/:slug/experiences',
    { config: { rateLimit: RATE_LIMIT_PUBLIC_READ } },
    async (request, reply) => {
      if (!experienceBookingEnabled()) {
        return reply.status(503).send({ error: 'EXPERIENCE_BOOKING_DISABLED' });
      }
      const { slug } = PublicExperienceSlugSchema.parse(request.params);
      try {
        return reply.send({ data: await listPublicExperiences(slug) });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/public/r/:slug/experiences/checkout',
    { config: { rateLimit: RATE_LIMIT_PUBLIC_WRITE } },
    async (request, reply) => {
      if (!experienceBookingEnabled()) {
        return reply.status(503).send({ error: 'EXPERIENCE_BOOKING_DISABLED' });
      }
      const { slug } = PublicExperienceSlugSchema.parse(request.params);
      const body = PublicExperienceCheckoutBodySchema.parse(request.body);
      const idempotencyKey = readIdempotencyKey(request);
      if (!idempotencyKey) return reply.status(400).send({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
      try {
        return reply.status(201).send({
          data: await createPublicExperienceCheckout({ slug, ...body, idempotencyKey }),
        });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.get(
    '/public/r/:slug/experiences/checkout/:checkoutId/status',
    { config: { rateLimit: RATE_LIMIT_PUBLIC_READ } },
    async (request, reply) => {
      const params = PublicExperienceCheckoutParamsSchema.parse(request.params);
      const { session_id: stripeSessionId } = PublicExperienceCheckoutStatusQuerySchema.parse(
        request.query,
      );
      try {
        return reply.send({
          data: await getPublicExperienceCheckout({ ...params, stripeSessionId }),
        });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/public/r/:slug/experiences/checkout/:checkoutId/cancel',
    { config: { rateLimit: RATE_LIMIT_PUBLIC_WRITE } },
    async (request, reply) => {
      const params = PublicExperienceCheckoutParamsSchema.parse(request.params);
      const { session_id: stripeSessionId } = PublicExperienceCheckoutStatusQuerySchema.parse(
        request.query,
      );
      try {
        return reply.send({
          data: await cancelPublicExperienceCheckout({ ...params, stripeSessionId }),
        });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.get('/experiences', { preHandler: experienceRead }, async (request, reply) => {
    const query = ExperienceListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listExperiences({
          restaurantId: request.restaurantId,
          status: query.status,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post('/experiences', { preHandler: experienceWrite }, async (request, reply) => {
    const body = CreateExperienceBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createExperience({
          restaurantId: request.restaurantId,
          ...body,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.delete('/experiences/:id', { preHandler: experienceWrite }, async (request, reply) => {
    const { id } = ExperienceParamsSchema.parse(request.params);
    try {
      await deleteExperience({ restaurantId: request.restaurantId, experienceId: id });
      return reply.status(204).send();
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.patch('/experiences/:id', { preHandler: experienceWrite }, async (request, reply) => {
    const { id } = ExperienceParamsSchema.parse(request.params);
    const body = UpdateExperienceBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await updateExperience({
          restaurantId: request.restaurantId,
          experienceId: id,
          ...body,
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.get('/experiences/:id/sessions', { preHandler: experienceRead }, async (request, reply) => {
    const { id } = ExperienceParamsSchema.parse(request.params);
    const query = SessionListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listExperienceSessions({
          restaurantId: request.restaurantId,
          experienceId: id,
          status: query.status,
          from: query.from,
          to: query.to,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post('/experiences/:id/sessions', { preHandler: experienceWrite }, async (request, reply) => {
    const { id } = ExperienceParamsSchema.parse(request.params);
    const body = CreateSessionBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createExperienceSession({
          restaurantId: request.restaurantId,
          experienceId: id,
          ...body,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.patch(
    '/experiences/:id/sessions/:sessionId',
    { preHandler: experienceWrite },
    async (request, reply) => {
      const { id, sessionId } = SessionParamsSchema.parse(request.params);
      const body = UpdateSessionBodySchema.parse(request.body);
      try {
        return reply.send({
          data: await updateExperienceSession({
            restaurantId: request.restaurantId,
            experienceId: id,
            sessionId,
            ...body,
          }),
        });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.get('/experience-reservations', { preHandler: experienceRead }, async (request, reply) => {
    const query = ReservationListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listExperienceReservations({
          restaurantId: request.restaurantId,
          experienceId: query.experienceId,
          sessionId: query.sessionId,
          customerId: query.customerId,
          status: query.status,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendExperienceError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post(
    '/experiences/:id/sessions/:sessionId/reservations',
    { preHandler: experienceConsume },
    async (request, reply) => {
      const { id, sessionId } = SessionParamsSchema.parse(request.params);
      const body = ReserveBodySchema.parse(request.body ?? {});
      try {
        const result = await reserveExperience({
          restaurantId: request.restaurantId,
          experienceId: id,
          sessionId,
          ...body,
          idempotencyKey: readIdempotencyKey(request),
          actor: request.userId ?? 'unknown',
        });
        return reply.status(result.replayed ? 200 : 201).send({ data: result });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/experience-reservations/:id/cancel',
    { preHandler: experienceConsume },
    async (request, reply) => {
      const { id } = ReservationParamsSchema.parse(request.params);
      try {
        return reply.send({
          data: await cancelExperienceReservation({
            restaurantId: request.restaurantId,
            reservationId: id,
            actor: request.userId ?? 'unknown',
          }),
        });
      } catch (error) {
        return sendExperienceError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/api/internal/experiences/sessions/expire',
    { preHandler: requirePlatformOperator() },
    async (_request, reply) => {
      if (!experiencesEnabled()) return reply.status(503).send({ error: 'EXPERIENCES_DISABLED' });
      return reply.send({ expiredCount: await expireExperienceSessions() });
    },
  );
}

export { experiencesEnabled };
