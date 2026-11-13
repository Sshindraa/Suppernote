import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  EventOrderStatus,
  EventSessionStatus,
  EventStatus,
  EventTicketStatus,
  EventTicketTypeStatus,
  EventWaitlistStatus,
} from '@prisma/client';
import { z } from 'zod';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import {
  cancelEventOrder,
  cancelEventWaitlist,
  checkInEventTicket,
  createEvent,
  createEventOrder,
  createEventSession,
  createEventTicketType,
  EventConflictError,
  EventCustomerNotFoundError,
  EventInputError,
  EventNotFoundError,
  EventOrderNotFoundError,
  EventOrderStateError,
  EventSessionNotFoundError,
  EventTicketNotFoundError,
  EventTicketStateError,
  EventTicketTypeNotFoundError,
  EventWaitlistNotFoundError,
  expireEventSessions,
  issueEventOrderInvoice,
  joinEventWaitlist,
  listEventOrders,
  listEvents,
  listEventSessions,
  listEventTickets,
  listEventTicketTypes,
  listEventWaitlist,
  promoteEventWaitlist,
  refundEventOrder,
  updateEvent,
  updateEventSession,
  updateEventTicketType,
} from './event.service';

const EventParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const SessionParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
  sessionId: z.string().trim().min(1).max(128),
});
const TicketTypeParamsSchema = SessionParamsSchema.extend({
  ticketTypeId: z.string().trim().min(1).max(128),
});
const OrderParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const TicketParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const WaitlistParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });

const CreateEventBodySchema = z.object({
  key: z.string().trim().min(2).max(64),
  name: z.string().min(1).max(160),
  description: z.string().max(2_000).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  status: z.nativeEnum(EventStatus).optional(),
});
const UpdateEventBodySchema = CreateEventBodySchema.omit({ key: true }).partial();
const EventListQuerySchema = z.object({
  status: z.nativeEnum(EventStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const CreateSessionBodySchema = z.object({
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  capacity: z.number().int().min(1).max(10_000),
});
const UpdateSessionBodySchema = CreateSessionBodySchema.partial().extend({
  status: z.nativeEnum(EventSessionStatus).optional(),
});
const SessionListQuerySchema = z.object({
  status: z.nativeEnum(EventSessionStatus).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const CreateTicketTypeBodySchema = z.object({
  key: z.string().trim().min(2).max(48),
  name: z.string().min(1).max(120),
  priceCents: z.number().int().min(0).max(1_000_000),
  currency: z.string().trim().length(3).optional(),
  maxPerOrder: z.number().int().min(1).max(100).optional(),
});
const UpdateTicketTypeBodySchema = CreateTicketTypeBodySchema.omit({ key: true })
  .partial()
  .extend({ status: z.nativeEnum(EventTicketTypeStatus).optional() });
const TicketTypeListQuerySchema = z.object({
  status: z.nativeEnum(EventTicketTypeStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const OrderListQuerySchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  customerId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(EventOrderStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const CreateOrderBodySchema = z.object({
  ticketTypeId: z.string().trim().min(1).max(128),
  customerId: z.string().trim().min(1).max(128).optional(),
  reservationId: z.string().trim().min(1).max(128).optional(),
  quantity: z.number().int().min(1).max(100).default(1),
});
const RefundBodySchema = z.object({ reason: z.string().max(1_000).nullable().optional() });
const InvoiceBodySchema = z.object({ invoiceNumber: z.string().trim().min(1).max(120).optional() });
const TicketListQuerySchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  orderId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(EventTicketStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const CheckInBodySchema = z.object({ code: z.string().trim().min(12).max(64) });
const WaitlistListQuerySchema = z.object({
  eventId: z.string().trim().min(1).max(128).optional(),
  sessionId: z.string().trim().min(1).max(128).optional(),
  status: z.nativeEnum(EventWaitlistStatus).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
const JoinWaitlistBodySchema = z.object({
  customerId: z.string().trim().min(1).max(128).optional(),
  phone: z.string().trim().min(6).max(32).optional(),
  quantity: z.number().int().min(1).max(100).default(1),
});
const PromoteWaitlistBodySchema = z.object({ ticketTypeId: z.string().trim().min(1).max(128) });
const IdempotencyKeySchema = z.string().trim().min(8).max(200);

function eventsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.EVENTS_ENABLED === 'true';
}

function readIdempotencyKey(request: FastifyRequest, required = false): string | undefined {
  const value = request.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (candidate === undefined) {
    if (required)
      throw new EventInputError('EVENT_IDEMPOTENCY_INVALID', "Une clé d'idempotence est requise.");
    return undefined;
  }
  return IdempotencyKeySchema.parse(candidate);
}

async function requireEventFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (eventsEnabled()) return;
  return reply.status(503).send({
    error: 'EVENTS_DISABLED',
    message: "Les événements restent désactivés jusqu'à la qualification du pilote.",
  });
}

async function requireEventReadRole(
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
    error: 'EVENTS_ROLE_REQUIRED',
    message: "La lecture des événements est réservée à l'équipe du site.",
  });
}

async function requireEventWriteRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'EVENTS_ROLE_REQUIRED',
    message: 'La gestion des événements est réservée aux responsables.',
  });
}

function sendEventError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (
    error instanceof EventNotFoundError ||
    error instanceof EventSessionNotFoundError ||
    error instanceof EventTicketTypeNotFoundError ||
    error instanceof EventOrderNotFoundError ||
    error instanceof EventTicketNotFoundError ||
    error instanceof EventWaitlistNotFoundError ||
    error instanceof EventCustomerNotFoundError
  )
    return reply.status(404).send({ error: error.code });
  if (
    error instanceof EventConflictError ||
    error instanceof EventOrderStateError ||
    error instanceof EventTicketStateError
  )
    return reply.status(409).send({ error: error.code });
  if (error instanceof EventInputError)
    return reply.status(400).send({ error: error.code, message: error.message });
  return undefined;
}

const eventRead = [
  requireOrg(),
  requireCapability('events.manage'),
  requireEventReadRole,
  requireEventFeature,
];
const eventWrite = [
  requireOrg(),
  requireCapability('events.manage'),
  requireEventWriteRole,
  requireEventFeature,
];
const eventCheckIn = [
  requireOrg(),
  requireCapability('events.manage'),
  requireEventReadRole,
  requireEventFeature,
];

/**
 * Provider-neutral event and ticket routes. Orders reserve a shared session
 * capacity and issue opaque codes; no payment, messaging or partner channel is
 * contacted until a separate pilot has qualified those contracts.
 */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', { preHandler: eventRead }, async (request, reply) => {
    const query = EventListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEvents({
          restaurantId: request.restaurantId,
          status: query.status,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/events', { preHandler: eventWrite }, async (request, reply) => {
    const body = CreateEventBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createEvent({
          restaurantId: request.restaurantId,
          ...body,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.patch('/events/:id', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = EventParamsSchema.parse(request.params);
    const body = UpdateEventBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await updateEvent({ restaurantId: request.restaurantId, eventId: id, ...body }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.get('/events/:id/sessions', { preHandler: eventRead }, async (request, reply) => {
    const { id } = EventParamsSchema.parse(request.params);
    const query = SessionListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEventSessions({
          restaurantId: request.restaurantId,
          eventId: id,
          status: query.status,
          from: query.from,
          to: query.to,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/events/:id/sessions', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = EventParamsSchema.parse(request.params);
    const body = CreateSessionBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createEventSession({
          restaurantId: request.restaurantId,
          eventId: id,
          ...body,
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.patch(
    '/events/:id/sessions/:sessionId',
    { preHandler: eventWrite },
    async (request, reply) => {
      const { id, sessionId } = SessionParamsSchema.parse(request.params);
      const body = UpdateSessionBodySchema.parse(request.body);
      try {
        return reply.send({
          data: await updateEventSession({
            restaurantId: request.restaurantId,
            eventId: id,
            sessionId,
            ...body,
          }),
        });
      } catch (error) {
        return sendEventError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get('/events/:id/ticket-types', { preHandler: eventRead }, async (request, reply) => {
    const { id } = EventParamsSchema.parse(request.params);
    const query = TicketTypeListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEventTicketTypes({
          restaurantId: request.restaurantId,
          eventId: id,
          status: query.status,
          limit: query.limit,
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/events/:id/ticket-types', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = EventParamsSchema.parse(request.params);
    const body = CreateTicketTypeBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createEventTicketType({
          restaurantId: request.restaurantId,
          eventId: id,
          ...body,
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.patch(
    '/events/:id/ticket-types/:ticketTypeId',
    { preHandler: eventWrite },
    async (request, reply) => {
      const { id, ticketTypeId } = TicketTypeParamsSchema.parse(request.params);
      const body = UpdateTicketTypeBodySchema.parse(request.body);
      try {
        return reply.send({
          data: await updateEventTicketType({
            restaurantId: request.restaurantId,
            eventId: id,
            ticketTypeId,
            ...body,
          }),
        });
      } catch (error) {
        return sendEventError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.get('/event-orders', { preHandler: eventRead }, async (request, reply) => {
    const query = OrderListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEventOrders({ restaurantId: request.restaurantId, ...query }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post(
    '/events/:id/sessions/:sessionId/orders',
    { preHandler: eventRead },
    async (request, reply) => {
      const { id, sessionId } = SessionParamsSchema.parse(request.params);
      const body = CreateOrderBodySchema.parse(request.body);
      try {
        const data = await createEventOrder({
          restaurantId: request.restaurantId,
          eventId: id,
          sessionId,
          ...body,
          idempotencyKey: readIdempotencyKey(request),
          actor: request.userId ?? 'unknown',
        });
        return reply.status(data.replayed ? 200 : 201).send({ data });
      } catch (error) {
        return sendEventError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post('/event-orders/:id/cancel', { preHandler: eventRead }, async (request, reply) => {
    const { id } = OrderParamsSchema.parse(request.params);
    try {
      return reply.send({
        data: await cancelEventOrder({ restaurantId: request.restaurantId, orderId: id }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/event-orders/:id/invoice', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = OrderParamsSchema.parse(request.params);
    const body = InvoiceBodySchema.parse(request.body);
    try {
      const data = await issueEventOrderInvoice({
        restaurantId: request.restaurantId,
        orderId: id,
        ...body,
      });
      return reply.send({ data });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/event-orders/:id/refund', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = OrderParamsSchema.parse(request.params);
    const body = RefundBodySchema.parse(request.body);
    try {
      const data = await refundEventOrder({
        restaurantId: request.restaurantId,
        orderId: id,
        idempotencyKey: readIdempotencyKey(request, true)!,
        ...body,
      });
      return reply.send({ data });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.get('/event-tickets', { preHandler: eventRead }, async (request, reply) => {
    const query = TicketListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEventTickets({ restaurantId: request.restaurantId, ...query }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/event-tickets/check-in', { preHandler: eventCheckIn }, async (request, reply) => {
    const body = CheckInBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await checkInEventTicket({
          restaurantId: request.restaurantId,
          code: body.code,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/event-tickets/:id/check-in', { preHandler: eventCheckIn }, async (request, reply) => {
    const { id } = TicketParamsSchema.parse(request.params);
    const body = CheckInBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await checkInEventTicket({
          restaurantId: request.restaurantId,
          ticketId: id,
          code: body.code,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.get('/event-waitlist', { preHandler: eventRead }, async (request, reply) => {
    const query = WaitlistListQuerySchema.parse(request.query);
    try {
      return reply.send({
        data: await listEventWaitlist({ restaurantId: request.restaurantId, ...query }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post(
    '/events/:id/sessions/:sessionId/waitlist',
    { preHandler: eventRead },
    async (request, reply) => {
      const { id, sessionId } = SessionParamsSchema.parse(request.params);
      const body = JoinWaitlistBodySchema.parse(request.body);
      try {
        const data = await joinEventWaitlist({
          restaurantId: request.restaurantId,
          eventId: id,
          sessionId,
          ...body,
          idempotencyKey: readIdempotencyKey(request),
          actor: request.userId ?? 'unknown',
        });
        return reply.status(data.replayed ? 200 : 201).send({ data });
      } catch (error) {
        return sendEventError(error, reply) ?? Promise.reject(error);
      }
    },
  );
  app.post('/event-waitlist/:id/cancel', { preHandler: eventRead }, async (request, reply) => {
    const { id } = WaitlistParamsSchema.parse(request.params);
    try {
      return reply.send({
        data: await cancelEventWaitlist({ restaurantId: request.restaurantId, entryId: id }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post('/event-waitlist/:id/promote', { preHandler: eventWrite }, async (request, reply) => {
    const { id } = WaitlistParamsSchema.parse(request.params);
    const body = PromoteWaitlistBodySchema.parse(request.body);
    try {
      return reply.send({
        data: await promoteEventWaitlist({
          restaurantId: request.restaurantId,
          entryId: id,
          ...body,
          actor: request.userId ?? 'unknown',
        }),
      });
    } catch (error) {
      return sendEventError(error, reply) ?? Promise.reject(error);
    }
  });
  app.post(
    '/api/internal/events/sessions/expire',
    { preHandler: [requirePlatformOperator()] },
    async (request, reply) => {
      const limit = z
        .object({ limit: z.coerce.number().int().min(1).max(1_000).default(1_000) })
        .parse(request.query).limit;
      try {
        return reply.send({ closed: await expireEventSessions({ limit }) });
      } catch (error) {
        return sendEventError(error, reply) ?? Promise.reject(error);
      }
    },
  );
}

export { eventsEnabled };
