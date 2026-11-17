import {
  modificationAccess,
  modificationOptions,
  confirmModification,
  ModificationConflict,
} from './reservation-modification';
import { CustomerService } from '../customers/customer.service';
import { deactivateMarketingConversions } from '../marketing/marketing-attribution.service';
import { Prisma } from '@prisma/client';
import { DEFAULT_TRANSACTION_OPTIONS } from '../../shared/db/transaction-options';
import {
  ReservationLifecycleService,
  type ReservationLifecycleResult,
} from './reservation-lifecycle.service';
import { CapacityAwareAvailabilityService } from '../floor-plan/availability-capacity-aware.service';
import {
  cancellationRelations,
  cancellationOffer,
  verifyCancellationOffer,
  CancellationConflict,
} from './reservation-cancellation';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { utcToZonedParts } from '../../shared/timezone/restaurant-time';
import {
  isReservationManagementEnabled,
  parseReservationManagementToken,
  verifyReservationManagementToken,
} from './reservation-management';

export async function reservationManagementRoutes(app: FastifyInstance) {
  app.post(
    '/public/reservation-management',
    {
      logLevel: 'silent',
      bodyLimit: 2048,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
      if (!isReservationManagementEnabled())
        return reply.code(404).send({ error: 'Lien indisponible.' });
      const input = z
        .object({
          token: z.string().max(100),
          action: z.enum(['view', 'withdraw_whatsapp', 'cancel', 'modification_options', 'modify']),
          confirmed: z.boolean().optional(),
          confirmationToken: z.string().max(80).optional(),
          proposalToken: z.string().max(1500).optional(),
          partySize: z.number().int().min(1).max(50).optional(),
          date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
        })
        .strict()
        .safeParse(req.body);
      if (!input.success) return reply.code(400).send({ error: 'Demande invalide.' });
      if (
        input.data.action === 'cancel' &&
        (input.data.confirmed !== true || !input.data.confirmationToken)
      )
        return reply.code(400).send({ error: 'Veuillez confirmer explicitement l’annulation.' });
      if (
        input.data.action === 'modify' &&
        (input.data.confirmed !== true || !input.data.proposalToken)
      )
        return reply.code(400).send({ error: 'Veuillez confirmer explicitement la modification.' });
      if (input.data.action === 'modification_options' && !input.data.partySize)
        return reply.code(400).send({ error: 'Veuillez choisir le nombre de personnes.' });
      const parsed = parseReservationManagementToken(input.data.token, new Date(), true);
      if (!parsed) return reply.code(404).send({ error: 'Lien invalide ou expiré.' });
      try {
        let row = await db.reservation.findUnique({
          where: { id: parsed.id },
          include: {
            ...cancellationRelations,
            restaurant: {
              select: {
                name: true,
                timezone: true,
                phoneNumber: true,
                formattedAddress: true,
                exposureSettings: { select: { requireManualValidation: true } },
              },
            },
          },
        });
        if (!row || !verifyReservationManagementToken(input.data.token, row))
          return reply.code(404).send({ error: 'Lien invalide ou expiré.' });
        if (input.data.action === 'modification_options')
          return reply.send(
            await modificationOptions(
              db,
              row,
              input.data.token,
              input.data.partySize!,
              input.data.date,
            ),
          );
        if (input.data.action === 'modify') {
          await confirmModification(db, row, input.data.token, input.data.proposalToken!);
          row = await db.reservation.findUniqueOrThrow({
            where: { id: row.id, restaurantId: row.restaurantId },
            include: {
              ...cancellationRelations,
              restaurant: {
                select: {
                  name: true,
                  timezone: true,
                  phoneNumber: true,
                  formattedAddress: true,
                  exposureSettings: { select: { requireManualValidation: true } },
                },
              },
            },
          });
        }
        if (input.data.action === 'cancel') {
          const initial = row;
          const lifecycle = new ReservationLifecycleService(db);
          let transition: ReservationLifecycleResult | undefined;
          row = await db.$transaction(async (tx) => {
            await tx.$queryRaw(
              Prisma.sql`SELECT id FROM reservations WHERE id = ${initial.id} AND restaurant_id = ${initial.restaurantId} FOR UPDATE`,
            );
            const current = await tx.reservation.findUnique({
              where: { id: initial.id, restaurantId: initial.restaurantId },
              include: {
                ...cancellationRelations,
                restaurant: {
                  select: {
                    name: true,
                    timezone: true,
                    phoneNumber: true,
                    formattedAddress: true,
                    exposureSettings: { select: { requireManualValidation: true } },
                  },
                },
              },
            });
            if (!current || !verifyReservationManagementToken(input.data.token, current))
              throw new CancellationConflict(
                'La réservation a changé. Veuillez rouvrir votre lien.',
              );
            // Replaying a completed cancellation is a read, never a second mutation/audit.
            if (current.state === 'CANCELLED') return current;
            const offer = cancellationOffer(current, input.data.token, current.restaurant.timezone);
            if (!offer.available) throw new CancellationConflict(offer.message);
            if (!verifyCancellationOffer(current, input.data.token, input.data.confirmationToken!))
              throw new CancellationConflict(
                'Les détails ou les conditions ont changé. Veuillez les vérifier à nouveau.',
              );
            transition = await lifecycle.transitionInTransaction(tx, {
              reservationId: current.id,
              restaurantId: current.restaurantId,
              toState: 'CANCELLED',
              actor: 'customer:personal-link',
              metadata: { source: 'personal_reservation', conditionsConfirmed: true },
              operation: 'cancel',
              observationSource: 'direct',
              allowAlreadyInTarget: true,
              auditConsumedHoldRelease: true,
            });
            return { ...current, ...transition.reservation };
          }, DEFAULT_TRANSACTION_OPTIONS);
          if (transition) {
            await lifecycle.finalizeTransition(
              {
                reservationId: row.id,
                restaurantId: row.restaurantId,
                toState: 'CANCELLED',
                actor: 'customer:personal-link',
                observationSource: 'direct',
              },
              transition,
            );
          } else {
            // Also heal availability after a response was lost during cache invalidation.
            await CapacityAwareAvailabilityService.invalidateAvailability(row.restaurantId);
          }
        }
        // Une réservation test ne doit créer ni fiche client ni écriture marketing.
        if (input.data.action === 'cancel' && row.state === 'CANCELLED' && !row.isTest) {
          await Promise.allSettled([
            CustomerService.recordReservationEvent({
              restaurantId: row.restaurantId,
              reservationId: row.id,
              customerId: row.customerId,
              phone: row.customerPhone,
              name: row.customerName,
              eventType: 'RESERVATION_CANCELLED',
            }),
            deactivateMarketingConversions({
              restaurantId: row.restaurantId,
              reservationId: row.id,
            }),
          ]);
        }
        const consents =
          row.consents && typeof row.consents === 'object' && !Array.isArray(row.consents)
            ? row.consents
            : {};
        const whatsapp = (consents as Record<string, unknown>).transactionalWhatsapp === true;
        if (input.data.action === 'withdraw_whatsapp' && whatsapp) {
          const result = await db.reservation.updateMany({
            where: {
              id: row.id,
              restaurantId: row.restaurantId,
              consents: { equals: consents },
            },
            data: {
              consents: {
                ...consents,
                transactionalWhatsapp: false,
                whatsappWithdrawnAt: new Date().toISOString(),
              },
            },
          });
          if (result.count !== 1)
            return reply.code(409).send({ error: 'La réservation a changé. Veuillez réessayer.' });
        }
        const local = utcToZonedParts(row.startsAt ?? row.reservedAt, row.restaurant.timezone);
        return reply.send({
          restaurantName: row.restaurant.name,
          restaurantAddress: row.restaurant.formattedAddress ?? null,
          startsAt: (row.startsAt ?? row.reservedAt).toISOString(),
          endsAt: row.endsAt?.toISOString() ?? null,
          restaurantPhone: /^\+?[0-9 ()-]{6,24}$/.test(row.restaurant.phoneNumber)
            ? row.restaurant.phoneNumber
            : null,
          date: local.date,
          time: local.time,
          partySize: row.partySize,
          state: row.state,
          test: row.isTest === true,
          cancellation: cancellationOffer(row, input.data.token, row.restaurant.timezone),
          modification: modificationAccess(
            row,
            input.data.token,
            row.restaurant.timezone,
            row.restaurant.exposureSettings?.requireManualValidation,
          ),
          whatsappReminder: {
            visible: row.channel === 'WEB' && (whatsapp || 'whatsappConsentProof' in consents),
            enabled: input.data.action === 'withdraw_whatsapp' ? false : whatsapp,
          },
        });
      } catch (error) {
        if (error instanceof CancellationConflict || error instanceof ModificationConflict)
          return reply.code(409).send({ error: error.message });
        return reply.code(503).send({ error: 'Service indisponible. Veuillez réessayer.' });
      }
    },
  );
}
