import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOrg } from '../../plugins/clerk';
import { ReservationService, RESERVATION_REPLAY_SCOPE_MISMATCH } from './reservation.service';
import { requireReservationService } from './reservation-auth';
import {
  AvailabilityQuerySchema,
  CreateReservationSchema,
  ReservationQuerySchema,
} from './reservation.schema';
import { ERROR_CODE_MESSAGES, RESERVATION_STATUS_VALUES, normalizePhone } from '@suppernote/shared';
import { db } from '../../shared/db/client';
import {
  ReservationService as AgenticReservationService,
  ReservationModificationNotAllowedError,
  ReservationNotFoundError,
  ReservationSlotUnavailableError,
} from '../agentic-reservations/core/reservation.service';
import { AuditLogService } from '../agentic-reservations/core/audit-log.service';
import { HoldService, HoldConflictError } from '../agentic-reservations/core/hold.service';
import {
  IdempotencyService,
  IdempotencyConflictError,
  IdempotencyPendingError,
  computeIdempotencyScope,
  hashPayload,
} from '../agentic-reservations/core/idempotency.service';
import { PrismaIdempotencyStore } from '../agentic-reservations/core/prisma-store';
import {
  buildPolicySnapshot,
  PolicyValidationError,
} from '../agentic-reservations/core/policies.service';
import { CapacityAwareAvailabilityService } from '../floor-plan/availability-capacity-aware.service';
import { resolveServiceDurationMinutes } from '../floor-plan/floor-plan.types';
import { normalizeCustomerEmail } from '../customers/customer-crm.service';
import { reservationManagementUrl } from './reservation-management';
import {
  createWhatsAppReminderConsent,
  withdrawWhatsAppReminderConsent,
} from '../connect/whatsapp-consent';
import {
  isSlotTooSoon,
  leadTimeRefusal,
  loadMinLeadTimeMinutes,
} from '../../shared/reservations/lead-time';

// --- auth/public split ---
// Les routes GET/PATCH/DELETE nécessitent une organisation (dashboard manager).
// POST /reservations reste disponible pour les intégrations legacy, mais elle
// est interne : le pipeline vocal appelle ReservationService directement et
// les réservations Connect passent par les routes hold/confirm signées.

const UpdateReservationSchema = z.object({
  status: z.enum(RESERVATION_STATUS_VALUES).optional(),
  customerName: z.string().min(1).max(200).optional(),
  partySize: z.number().int().min(1).max(20).optional(),
});

const StaffModificationSchema = UpdateReservationSchema.omit({ status: true }).extend({
  startsAt: z.string().datetime({ offset: true }).optional(),
  specialRequests: z.string().max(500).nullable().optional(),
});

const StaffCreationSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    partySize: z.number().int().min(1).max(20),
    customerName: z.string().trim().min(1).max(200),
    customerPhone: z
      .string()
      .max(40)
      .regex(/^[+\d\s.()-]+$/)
      .transform(normalizePhone)
      .pipe(z.string().regex(/^\+?[0-9]{10,15}$/)),
    customerEmail: z.string().trim().email().max(254).optional(),
    specialRequests: z.string().max(500).optional(),
    overbook: z.boolean().optional(),
    idempotencyKey: z.string().uuid(),
  })
  .strict();

function createSlotNotAvailableError() {
  const error = new Error(ERROR_CODE_MESSAGES.SLOT_NOT_AVAILABLE);
  error.name = 'SLOT_NOT_AVAILABLE';
  return Object.assign(error, { statusCode: 409 });
}

export async function reservationRoutes(app: FastifyInstance) {
  app.post(
    '/public/reservations/whatsapp-consent/withdraw',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parsed = z
        .object({
          restaurantId: z.string().min(1).max(100),
          reservationId: z.string().min(1).max(100),
          token: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid request' });
      const { restaurantId, reservationId, token } = parsed.data;
      const outcome = await withdrawWhatsAppReminderConsent(db, restaurantId, reservationId, token);
      if (outcome === 'not_found') return reply.status(404).send({ error: 'Not found' });
      if (outcome === 'conflict') return reply.status(409).send({ error: 'Veuillez réessayer.' });
      return reply.send({ status: 'withdrawn' });
    },
  );
  app.get('/reservations', { preHandler: requireOrg() }, async (req, reply) => {
    const query = ReservationQuerySchema.parse(req.query);
    const reservations = await ReservationService.findByRestaurant(req.restaurantId!, query.date);
    return reply.send(reservations);
  });

  app.get('/v2/reservations', { preHandler: requireOrg() }, async (req, reply) => {
    const query = ReservationQuerySchema.parse(req.query);
    const reservations = await ReservationService.findByRestaurant(req.restaurantId!, query.date, {
      limit: query.limit,
      offset: query.offset,
    });
    return reply.send(reservations);
  });

  app.get('/v2/reservations/day', { preHandler: requireOrg() }, async (req, reply) => {
    const { date } = z.object({ date: z.string().date() }).parse(req.query);
    return reply.send(await ReservationService.findDaySnapshot(req.restaurantId!, date));
  });

  app.get('/reservations/staff-availability', { preHandler: requireOrg() }, async (req, reply) => {
    const query = AvailabilityQuerySchema.extend({
      partySize: z.coerce.number().int().min(1).max(20),
    }).parse(req.query);
    const result = await new CapacityAwareAvailabilityService(db).getAvailability({
      restaurantId: req.restaurantId!,
      date: query.date,
      partySize: query.partySize,
      allowWithoutTables: true,
      includePast: true,
    });
    return reply.send({
      slots: result.slots.map(({ time, available, past }) => ({
        time,
        available,
        past: past === true,
      })),
    });
  });

  app.post('/reservations/staff', { preHandler: requireOrg() }, async (req, reply) => {
    const body = StaffCreationSchema.parse(req.body);
    const restaurantId = req.restaurantId!;
    const settings = await db.restaurantExposureSettings.findUnique({ where: { restaurantId } });
    if (!settings)
      return reply
        .status(409)
        .send({ error: 'Les règles de réservation de ce restaurant ne sont pas configurées.' });
    const policy = buildPolicySnapshot({
      policyVersion: '2026-06-20',
      maxPartySize: settings.maxPartySize,
      minLeadTimeMinutes: 0,
      requireManualValidation: settings.requireManualValidation,
      quoteTtlSeconds: settings.quoteTtlSeconds,
      holdTtlSeconds: settings.holdTtlSeconds,
      noShowPolicy: settings.noShowPolicy,
      notificationChannels: settings.notificationChannels,
      capacitySpecials: settings.capacitySpecials as Record<string, unknown> | null,
    });
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(
      startsAt.getTime() +
        resolveServiceDurationMinutes(settings.capacitySpecials as Record<string, unknown> | null) *
          60_000,
    );
    const audit = new AuditLogService(db);
    const service = new AgenticReservationService(
      db,
      audit,
      new HoldService(db, audit),
      new IdempotencyService(new PrismaIdempotencyStore(db)),
    );
    const { idempotencyKey, overbook, ...fields } = body;
    try {
      const result = await service.createReservation(
        {
          ...fields,
          startsAt,
          endsAt,
          restaurantId,
          channel: 'ADMIN',
          actor: `staff:${req.userId}`,
          customerEmail: body.customerEmail ? normalizeCustomerEmail(body.customerEmail) : null,
          policy,
          allowOverbook: overbook === true,
        },
        {
          scope: computeIdempotencyScope({ restaurantId, channel: 'ADMIN' }),
          key: idempotencyKey,
          payloadHash: hashPayload({
            ...fields,
            startsAt,
            customerEmail: body.customerEmail ? normalizeCustomerEmail(body.customerEmail) : null,
            overbook: overbook === true,
          }),
          ttlSeconds: 86400,
        },
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof ReservationSlotUnavailableError || err instanceof HoldConflictError)
        return reply.status(409).send({
          error: `Ce créneau est complet pour ${body.partySize} couverts.`,
          code: 'SLOT_FULL',
        });
      if (err instanceof IdempotencyConflictError || err instanceof IdempotencyPendingError)
        return reply
          .status(409)
          .send({ error: 'Cette demande ne peut pas être rejouée.', code: 'IDEMPOTENCY_CONFLICT' });
      if (err instanceof PolicyValidationError)
        return reply.status(400).send({ error: err.message, code: err.code });
      throw err;
    }
  });

  app.get('/restaurants/:id/availability', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = AvailabilityQuerySchema.parse(req.query);
    // Page /book : surface en ligne, donc soumise au délai minimum du restaurant.
    const availability = await ReservationService.availability(id, query.date, query.partySize, {
      minLeadTimeMinutes: await loadMinLeadTimeMinutes(db, id),
    });
    return reply.send(availability);
  });

  app.post('/reservations', { preHandler: requireReservationService }, async (req, reply) => {
    const body = CreateReservationSchema.parse(req.body);
    if (body.whatsappReminderConsent?.accepted && process.env.WHATSAPP_CONSENT_ENABLED !== 'true') {
      return reply
        .status(409)
        .send({ error: 'Le rappel WhatsApp n’est pas disponible actuellement.' });
    }
    const whatsappConsent = createWhatsAppReminderConsent(
      body.whatsappReminderConsent?.accepted === true,
    );
    // Cette route est la création de la page /book (la voix passe par ReservationService, sans HTTP) :
    // elle applique le délai minimum, comme l'affichage des créneaux. Le service, lui, ne l'applique
    // pas : la voix et le personnel ne sont pas concernés.
    const minLeadTimeMinutes = await loadMinLeadTimeMinutes(db, body.restaurantId);
    if (isSlotTooSoon(new Date(body.reservedAt), minLeadTimeMinutes)) {
      return reply.status(409).send(leadTimeRefusal(minLeadTimeMinutes));
    }
    try {
      const reservation = await ReservationService.create({
        restaurantId: body.restaurantId,
        ...(body.whatsappReminderConsent ? { channel: 'WEB' as const } : {}),
        callId: body.callId,
        reservedAt: new Date(body.reservedAt),
        partySize: body.partySize,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
        marketingAttributionToken: body.marketingAttributionToken,
        ...(body.whatsappReminderConsent ? { consents: whatsappConsent.consents } : {}),
      });
      const saved = reservation.consents as Record<string, unknown> | null;
      return reply.status(201).send({
        ...reservation,
        managementUrl: reservationManagementUrl(reservation),
        ...(whatsappConsent.withdrawalToken &&
        saved?.whatsappWithdrawalTokenHash === whatsappConsent.consents.whatsappWithdrawalTokenHash
          ? { whatsappWithdrawalToken: whatsappConsent.withdrawalToken }
          : {}),
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'SLOT_NOT_AVAILABLE') {
        throw createSlotNotAvailableError();
      }
      if (err instanceof Error && err.message === RESERVATION_REPLAY_SCOPE_MISMATCH) {
        return reply.status(409).send({ error: 'RESERVATION_REPLAY_REJECTED' });
      }
      throw err;
    }
  });

  app.post('/reservations/:id/allocate-table', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = await ReservationService.allocateTable(id, req.restaurantId!);
      return reply.send(updated);
    } catch (err) {
      if (err instanceof Error && err.message === 'SLOT_NOT_AVAILABLE') {
        throw createSlotNotAvailableError();
      }
      throw err;
    }
  });

  app.post(
    '/reservations/:id/staff-modification',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const body = StaffModificationSchema.parse(req.body);
      const audit = new AuditLogService(db);
      const service = new AgenticReservationService(
        db,
        audit,
        new HoldService(db, audit),
        new IdempotencyService(new PrismaIdempotencyStore(db)),
      );
      try {
        return reply.send(
          await service.modifyReservation({
            ...body,
            startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
            preserveDuration: true,
            reservationId: id,
            restaurantId: req.restaurantId!,
            actor: `staff:${req.userId}`,
            publicClient: false,
            auditMetadata: { source: 'staff' },
          }),
        );
      } catch (err) {
        if (err instanceof ReservationNotFoundError)
          return reply.status(404).send({ error: 'Not found' });
        if (err instanceof ReservationModificationNotAllowedError)
          return reply.status(409).send({ error: 'Cette réservation ne peut plus être modifiée.' });
        if (err instanceof ReservationSlotUnavailableError)
          return reply
            .status(409)
            .send({ error: `Ce créneau est complet pour ${err.partySize} couverts.` });
        throw err;
      }
    },
  );

  app.patch('/reservations/:id', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateReservationSchema.parse(req.body);
    const restaurantId = req.restaurantId!;
    const updated = await ReservationService.update(id, restaurantId, body);
    return reply.send(updated);
  });

  app.delete('/reservations/:id', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId!;
    await ReservationService.delete(id, restaurantId);
    return reply.status(204).send();
  });
}
