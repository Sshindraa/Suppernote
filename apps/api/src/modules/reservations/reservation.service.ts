import { snapshotCancellationPolicy } from '../../shared/reservations/cancellation-policy';
import { isReservationOverlapViolation } from '../../shared/reservations/overlap-violation';
import { db } from '../../shared/db/client';
import {
  Prisma,
  type Reservation,
  type ReservationChannel,
  type ReservationState,
  type ReservationStatus,
  type Restaurant,
} from '@prisma/client';
import { queues } from '../../shared/queue/queues';
import { logger } from '../../shared/logger/pino';
import {
  CapacityAwareAvailabilityService,
  DEFAULT_RESTAURANT_TIMEZONE,
  utcToZonedParts,
} from '../floor-plan/availability-capacity-aware.service';
import {
  TableAllocationService,
  TableAllocationError,
} from '../floor-plan/table-allocation.service';
import { resolveServiceDurationMinutes } from '../floor-plan/floor-plan.types';
import { isSlotStartPast } from '../../shared/timezone/restaurant-time';
import {
  observeReservationMutation,
  type ReservationNotificationObservation,
} from '../../shared/observability/reservation-contract';
import { buildReservationNotificationJobId } from '../../shared/queue/job-options';
import { CustomerService } from '../customers/customer.service';
import { creationProjection, stateForStatus } from '../../shared/reservations/reservation-state';
import {
  deactivateMarketingConversions,
  recordMarketingAttributionClick,
  recordMarketingConversion,
  recordMarketingHonoredConversions,
} from '../marketing/marketing-attribution.service';
import { ReservationLifecycleService } from './reservation-lifecycle.service.js';
import { createCardGuaranteePaymentInTransaction } from '../reservation-payments/reservation-payment.service';
import {
  ACTIVE_RESERVATION_STATES,
  reservationOverlapWhere,
} from '../../shared/reservations/capacity';

const availability = new CapacityAwareAvailabilityService(db);
const tableAllocation = new TableAllocationService(db);
const lifecycle = new ReservationLifecycleService(db);

export interface CreateReservationInput {
  restaurantId: string;
  callId?: string;
  reservedAt: Date;
  partySize: number;
  customerName: string;
  customerPhone?: string;
  marketingAttributionToken?: string;
  consents?: Prisma.InputJsonObject;
  channel?: ReservationChannel;
  /**
   * Empreinte bancaire demandée (voix) : la réservation naît `PENDING`, la place est tenue et
   * l'empreinte est écrite dans la même transaction ; le lien part par SMS après la création.
   */
  cardGuarantee?: { policyId: string; expiresAt: Date };
}

interface AvailabilitySlot {
  time: string;
  available: boolean;
  reason?: 'closed' | 'past' | 'local_conflict';
}

export interface AvailabilityResult {
  restaurantId: string;
  date: string;
  partySize: number;
  slots: string[];
  allSlots: AvailabilitySlot[];
}

function reservationLifecycleEvent(
  state: ReservationState | null | undefined,
): 'RESERVATION_CANCELLED' | 'RESERVATION_HONORED' | 'RESERVATION_NO_SHOW' | null {
  switch (state) {
    case 'CANCELLED':
      return 'RESERVATION_CANCELLED';
    case 'HONORED':
      return 'RESERVATION_HONORED';
    case 'NO_SHOW':
      return 'RESERVATION_NO_SHOW';
    default:
      return null;
  }
}

function getLegacyStatus(
  status: Prisma.ReservationUpdateInput['status'],
): ReservationStatus | null {
  return typeof status === 'string' ? (status as ReservationStatus) : null;
}

function getLegacyState(state: Prisma.ReservationUpdateInput['state']): ReservationState | null {
  return typeof state === 'string' ? (state as ReservationState) : null;
}

type ReservationQualityField = 'date' | 'time' | 'party_size';

function directUpdateValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return 'set' in value ? (value as { set?: unknown }).set : undefined;
}

function asUpdateDate(value: unknown): Date | null {
  const direct = directUpdateValue(value);
  if (direct instanceof Date && Number.isFinite(direct.getTime())) return direct;
  if (typeof direct === 'string') {
    const parsed = new Date(direct);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return null;
}

function zonedDateTimeParts(value: Date, timeZone: string): { date: string; time: string } {
  const options: Intl.DateTimeFormatOptions = {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', options);
  } catch {
    // A stale invalid restaurant timezone must not block reservation updates.
    formatter = new Intl.DateTimeFormat('en-CA', { ...options, timeZone: 'UTC' });
  }
  const parts = formatter.formatToParts(value);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    time: `${values.hour}:${values.minute}`,
  };
}

/** Returns only bounded field names; audit metadata never stores old/new values. */
function changedReservationQualityFields(
  existing: Reservation,
  data: Prisma.ReservationUpdateInput,
  timeZone: string,
): ReservationQualityField[] {
  const changed: ReservationQualityField[] = [];
  const nextPartySize = directUpdateValue(data.partySize);
  if (typeof nextPartySize === 'number' && nextPartySize !== existing.partySize) {
    changed.push('party_size');
  }

  const timeUpdates = [
    { current: existing.reservedAt, next: asUpdateDate(data.reservedAt) },
    { current: existing.startsAt ?? existing.reservedAt, next: asUpdateDate(data.startsAt) },
  ];
  for (const { current, next } of timeUpdates) {
    if (!next || next.getTime() === current.getTime()) continue;
    const currentParts = zonedDateTimeParts(current, timeZone);
    const nextParts = zonedDateTimeParts(next, timeZone);
    if (nextParts.date !== currentParts.date && !changed.includes('date')) changed.push('date');
    if (nextParts.time !== currentParts.time && !changed.includes('time')) changed.push('time');
  }
  return changed;
}

/**
 * Vérifie qu'une réservation existante correspond aux paramètres d'entrée.
 * En cas de mismatch (bug amont, retry avec args différents), on log un warning
 * mais on retourne quand même la réservation existante — la première création
 * est la source de vérité.
 */
function logReplayMismatch(input: CreateReservationInput, existing: Reservation): void {
  const mismatches: string[] = [];
  if (existing.partySize !== input.partySize) mismatches.push('partySize');
  if (existing.reservedAt.getTime() !== input.reservedAt.getTime()) mismatches.push('reservedAt');
  if (existing.customerName !== input.customerName) mismatches.push('customerName');
  if (mismatches.length > 0) {
    logger.warn(
      {
        callId: input.callId,
        reservationId: existing.id,
        mismatches,
      },
      '[ReservationService] Replay-safe: existing reservation params differ from input (first creation is source of truth)',
    );
  }
}

export const RESERVATION_REPLAY_SCOPE_MISMATCH = 'RESERVATION_REPLAY_SCOPE_MISMATCH';

/** A callId is an idempotency key, never a cross-tenant lookup key. */
function assertReplayScope(input: CreateReservationInput, existing: Reservation): void {
  if (existing.restaurantId !== input.restaurantId) {
    logger.warn(
      {
        callId: input.callId,
        requestedRestaurantId: input.restaurantId,
        actualRestaurantId: existing.restaurantId,
      },
      '[ReservationService] Rejected replay key from another restaurant',
    );
    throw new Error(RESERVATION_REPLAY_SCOPE_MISMATCH);
  }
}

export class ReservationService {
  static async create(input: CreateReservationInput) {
    // Replay-safe : si une réservation existe déjà pour ce callId (retransmission
    // webhook, retry LLM, fallback), on retourne la réservation existante sans
    // recréer ni renvoyer un SMS. Le callId est unique en DB (schema.prisma).
    if (input.callId) {
      const existing = await db.reservation.findUnique({
        where: { callId: input.callId },
      });
      if (existing) {
        assertReplayScope(input, existing);
        logReplayMismatch(input, existing);
        logger.info(
          { callId: input.callId, reservationId: existing.id },
          '[ReservationService] Replay-safe: returning existing reservation for callId',
        );
        observeReservationMutation({
          source: 'voice',
          operation: 'create_replay',
          status: existing.status,
          state: existing.state,
          idempotency: 'reused',
          audit: 'not_applicable',
          notification: 'not_applicable',
          capacity: 'unchanged',
          mutated: false,
        });
        return existing;
      }
    }

    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: input.restaurantId },
      include: { exposureSettings: true },
    });

    const startTime = input.reservedAt;
    const serviceDurationMinutes = resolveServiceDurationMinutes(
      restaurant.exposureSettings?.capacitySpecials,
    );
    const endTime = new Date(startTime.getTime() + serviceDurationMinutes * 60 * 1000);

    const slotAvailability = await this.checkSlotAvailability(
      restaurant,
      startTime,
      input.partySize,
    );

    if (!slotAvailability.available) {
      logger.warn(
        { restaurantId: input.restaurantId, time: startTime, reason: slotAvailability.reason },
        '[ReservationService] Slot unavailable',
      );
      throw new Error('SLOT_NOT_AVAILABLE');
    }

    let customerId: string | null = null;
    if (input.customerPhone) {
      try {
        customerId = (
          await CustomerService.lookupOrCreate(
            input.restaurantId,
            input.customerPhone,
            input.customerName,
          )
        ).id;
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            restaurantId: input.restaurantId,
          },
          '[ReservationService] Customer CRM dual-write unavailable',
        );
      }
    }

    // 2. Allouer et créer la réservation dans une transaction pour éviter
    //    l'allocation concurrente de la même table.
    const reservation = await db.$transaction(async (tx) => {
      // Double-check inside la transaction : évite d'allouer une table si la
      // réservation existe déjà (race entre le check externe et la transaction).
      // Sans cela, une insertion concurrente entre le check externe et ici
      // entraînerait une allocation de table orpheline (leak) au commit.
      if (input.callId) {
        const existingInTx = await tx.reservation.findUnique({
          where: { callId: input.callId },
        });
        if (existingInTx) {
          assertReplayScope(input, existingInTx);
          logReplayMismatch(input, existingInTx);
          logger.info(
            { callId: input.callId, reservationId: existingInTx.id },
            '[ReservationService] Replay-safe: double-check in transaction found existing, skipping table allocation',
          );
          observeReservationMutation({
            source: 'voice',
            operation: 'create_replay',
            status: existingInTx.status,
            state: existingInTx.state,
            idempotency: 'reused',
            audit: 'not_applicable',
            notification: 'not_applicable',
            capacity: 'unchanged',
            mutated: false,
          });
          return existingInTx;
        }
      }

      const table = await tableAllocation.allocate(
        {
          restaurantId: input.restaurantId,
          partySize: input.partySize,
          startsAt: startTime,
          endsAt: endTime,
        },
        tx,
      );
      if (!table) {
        logger.warn(
          { restaurantId: input.restaurantId, time: startTime, partySize: input.partySize },
          '[ReservationService] No table available',
        );
        throw new Error('SLOT_NOT_AVAILABLE');
      }

      try {
        const created = await tx.reservation.create({
          data: {
            restaurantId: input.restaurantId,
            callId: input.callId,
            reservedAt: input.reservedAt,
            startsAt: input.reservedAt,
            endsAt: endTime,
            partySize: input.partySize,
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            ...(input.consents ? { consents: input.consents } : {}),
            ...(input.channel ? { channel: input.channel } : {}),
            ...(customerId ? { customerId } : {}),
            // `state` est écrit explicitement : s'en remettre au défaut Prisma
            // marchait par coïncidence et laissait la porte ouverte à une
            // divergence silencieuse avec `status` (R1-4).
            ...creationProjection(input.cardGuarantee ? 'PENDING' : 'CONFIRMED'),
            tableId: table.id,
            estimatedRevenue: input.partySize * 35,
            cancellationPolicySnap: snapshotCancellationPolicy(
              restaurant.exposureSettings?.capacitySpecials,
              'onboarding-v1',
            ),
          },
        });

        await tx.reservationAuditLog.create({
          data: {
            event: 'reservation_created',
            reservationId: created.id,
            actor: input.callId ? 'voice:reservation-service' : 'legacy:reservation-service',
            fromState: null,
            toState: input.cardGuarantee ? 'PENDING' : 'CONFIRMED',
            metadata: {
              source: 'legacy_reservation_service',
              callId: input.callId ?? null,
              partySize: input.partySize,
              ...(input.cardGuarantee ? { awaitingCardGuarantee: true } : {}),
            },
          },
        });

        if (input.cardGuarantee) {
          await createCardGuaranteePaymentInTransaction(tx, {
            restaurantId: input.restaurantId,
            reservationId: created.id,
            policyId: input.cardGuarantee.policyId,
            partySize: input.partySize,
            expiresAt: input.cardGuarantee.expiresAt,
          });
        }

        return created;
      } catch (err) {
        // Race ultra-étroite : un autre tx a inséré entre le double-check et le
        // create. On laisse l'erreur propager pour rollback la transaction
        // (y compris l'allocation de table) — évite le leak de table. Le caller
        // gère l'erreur gracieusement (transfert gérant). Le premier create a
        // réussi, la réservation existe ; le retry suivant la trouvera via le
        // check externe.
        if (isReservationOverlapViolation(err)) throw new Error('SLOT_NOT_AVAILABLE');
        throw err;
      }
    });

    if (reservation.customerPhone) {
      try {
        await CustomerService.recordReservationEvent({
          restaurantId: input.restaurantId,
          customerId,
          phone: reservation.customerPhone,
          name: reservation.customerName,
          reservationId: reservation.id,
          eventType: 'RESERVATION_CREATED',
          occurredAt: reservation.createdAt,
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: reservation.id,
          },
          '[ReservationService] Customer timeline projection unavailable',
        );
      }
    }

    // Campaign links are optional and best-effort: a malformed or expired
    // token must never block a valid reservation. The signed token is resolved
    // to a tenant/customer pair before recording a conversion.
    if (input.marketingAttributionToken && customerId) {
      try {
        const link = await recordMarketingAttributionClick({
          token: input.marketingAttributionToken,
        });
        if (link && link.restaurantId === input.restaurantId && link.customerId === customerId) {
          await recordMarketingConversion({
            restaurantId: input.restaurantId,
            campaignId: link.campaignId,
            customerId,
            reservationId: reservation.id,
            conversionType: 'RESERVATION_CREATED',
            attributedAt: new Date(),
            windowEndsAt: link.expiresAt,
          });
        }
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: reservation.id,
          },
          '[ReservationService] Marketing attribution projection unavailable',
        );
      }
    }

    // 4. Enqueue SMS confirmation to client
    let notification: ReservationNotificationObservation = 'not_applicable';
    // Une réservation en attente d'empreinte n'est pas confirmée : le SMS de confirmation part
    // seulement une fois la carte enregistrée (webhook), le lien d'empreinte à sa place.
    if (input.customerPhone && !input.cardGuarantee) {
      try {
        if (restaurant.smsConfirmEnabled) {
          await queues.smsClient.add(
            'client-confirm',
            {
              reservationId: reservation.id,
              customerPhone: input.customerPhone,
              customerName: input.customerName,
              restaurantName: restaurant.name,
              date: input.reservedAt.toLocaleDateString('fr-FR'),
              time: input.reservedAt.toLocaleTimeString('fr-FR', {
                hour: '2-digit',
                minute: '2-digit',
              }),
              partySize: input.partySize,
            },
            { jobId: buildReservationNotificationJobId('confirmation', reservation.id) },
          );
          notification = 'queued';
        }
      } catch (err) {
        notification = 'failed';
        logger.error({ err }, '[ReservationService] Failed to enqueue SMS confirmation');
      }
    }

    await CapacityAwareAvailabilityService.invalidateAvailability(input.restaurantId);
    observeReservationMutation({
      source: input.callId ? 'voice' : 'legacy_service',
      operation: 'create',
      status: reservation.status,
      state: reservation.state,
      idempotency: input.callId ? 'keyed' : 'unkeyed',
      audit: 'written',
      notification,
      capacity: 'reserved',
    });
    return reservation;
  }

  static async update(
    id: string,
    restaurantId: string,
    data: Prisma.ReservationUpdateInput,
    actor = 'legacy:reservation-update',
  ) {
    const reservation = await db.reservation.findUniqueOrThrow({
      where: { id, restaurantId },
      include: { restaurant: true },
    });
    const changedFields = changedReservationQualityFields(
      reservation,
      data,
      reservation.restaurant.timezone,
    );

    const status = getLegacyStatus(data.status);
    const requestedState = getLegacyState(data.state);
    const lifecycleFieldProvided = data.status !== undefined || data.state !== undefined;
    const projectedState = status ? stateForStatus(status) : requestedState;
    if (lifecycleFieldProvided && !projectedState) {
      throw new Error('Reservation lifecycle updates must use a concrete status or state');
    }
    if (status && requestedState && stateForStatus(status) !== requestedState) {
      throw new Error('Reservation status and state must describe the same lifecycle state');
    }
    let updated: Reservation;
    let stateChanged = false;
    let lifecycleMutation = false;

    const requestedPartySize = directUpdateValue(data.partySize);
    if (typeof requestedPartySize === 'number') {
      const transition = await db.$transaction(async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${restaurantId}, 0))`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM reservations WHERE id = ${id} AND restaurant_id = ${restaurantId} FOR UPDATE`,
        );
        const current = await tx.reservation.findUniqueOrThrow({ where: { id, restaurantId } });
        const targetState = projectedState ?? current.state;
        const additionalData = { ...data };
        delete additionalData.status;
        delete additionalData.state;
        if (
          requestedPartySize !== current.partySize &&
          ACTIVE_RESERVATION_STATES.includes(
            current.state as (typeof ACTIVE_RESERVATION_STATES)[number],
          ) &&
          ACTIVE_RESERVATION_STATES.includes(
            targetState as (typeof ACTIVE_RESERVATION_STATES)[number],
          )
        ) {
          const settings = await tx.restaurantExposureSettings.findUnique({
            where: { restaurantId },
            select: { capacitySpecials: true },
          });
          const duration = resolveServiceDurationMinutes(settings?.capacitySpecials);
          const startsAt = asUpdateDate(data.startsAt) ?? current.startsAt ?? current.reservedAt;
          const endsAt =
            asUpdateDate(data.endsAt) ??
            current.endsAt ??
            new Date(startsAt.getTime() + duration * 60_000);
          if (targetState === 'SEATED') {
            const now = new Date();
            if (!current.tableId || endsAt <= now)
              throw Object.assign(new Error('SLOT_NOT_AVAILABLE'), { statusCode: 409 });
            try {
              await tableAllocation.assertTableAvailableForSeating(
                {
                  restaurantId,
                  tableId: current.tableId,
                  partySize: requestedPartySize,
                  startsAt: now,
                  endsAt,
                  excludeReservationId: id,
                },
                tx,
              );
            } catch (error) {
              if (error instanceof TableAllocationError)
                throw Object.assign(new Error('SLOT_NOT_AVAILABLE'), { statusCode: 409 });
              throw error;
            }
          } else {
            const hasTables = await tx.table.findFirst({
              where: { isActive: true, floorPlan: { restaurantId, isActive: true } },
              select: { id: true },
            });
            if (hasTables) {
              const table = await tableAllocation.allocate(
                {
                  restaurantId,
                  partySize: requestedPartySize,
                  startsAt,
                  endsAt,
                  excludeReservationId: id,
                },
                tx,
              );
              if (!table) throw Object.assign(new Error('SLOT_NOT_AVAILABLE'), { statusCode: 409 });
              additionalData.table = { connect: { id: table.id } };
            } else {
              const [otherReservation, otherHold] = await Promise.all([
                tx.reservation.findFirst({
                  where: {
                    restaurantId,
                    isTest: false,
                    id: { not: id },
                    state: { in: [...ACTIVE_RESERVATION_STATES] },
                    OR: reservationOverlapWhere(startsAt, endsAt, duration),
                  },
                  select: { id: true },
                }),
                tx.agenticHold.findFirst({
                  where: {
                    restaurantId,
                    type: 'HOLD',
                    status: 'ACTIVE',
                    expiresAt: { gt: new Date() },
                    slotStart: { lt: endsAt },
                    slotEnd: { gt: startsAt },
                  },
                  select: { id: true },
                }),
              ]);
              if (otherReservation || otherHold)
                throw Object.assign(new Error('SLOT_NOT_AVAILABLE'), { statusCode: 409 });
            }
          }
        }
        return lifecycle.transitionInTransaction(tx, {
          reservationId: id,
          restaurantId,
          toState: targetState,
          actor,
          additionalData,
          metadata: { source: 'legacy_reservation_update' },
          changedFields: changedReservationQualityFields(
            current,
            data,
            reservation.restaurant.timezone,
          ),
          operation: targetState === 'CANCELLED' ? 'cancel' : 'update',
          observationSource: 'legacy_service',
          allowAlreadyInTarget: true,
          snapshot: current,
        });
      });
      await lifecycle.finalizeTransition(
        { reservationId: id, restaurantId, toState: transition.toState, actor },
        transition,
      );
      await CapacityAwareAvailabilityService.invalidateAvailability(restaurantId);
      updated = transition.reservation;
      stateChanged = transition.fromState !== transition.toState;
      lifecycleMutation = transition.mutated;
    } else if (projectedState) {
      const additionalData = { ...data };
      // The lifecycle gateway owns both columns. Other fields still travel in
      // the same transaction so dashboard edits remain atomic with a status
      // transition.
      delete additionalData.status;
      delete additionalData.state;

      const result = await lifecycle.transition({
        reservationId: id,
        restaurantId,
        toState: projectedState,
        actor,
        additionalData,
        metadata:
          projectedState === 'CANCELLED'
            ? {
                source: 'legacy_reservation_update',
                ...(changedFields.length ? { changedFields } : {}),
              }
            : {
                source: 'legacy_reservation_update',
                status,
                ...(changedFields.length ? { changedFields } : {}),
              },
        changedFields,
        operation: projectedState === 'CANCELLED' ? 'cancel' : 'update',
        observationSource: 'legacy_service',
        allowAlreadyInTarget: true,
        snapshot: reservation,
      });
      updated = result.reservation;
      stateChanged = result.fromState !== result.toState;
      lifecycleMutation = result.mutated;
    } else {
      updated = await db.$transaction(async (tx) => {
        const result = await tx.reservation.update({
          where: { id, restaurantId },
          data,
        });

        const fromState = reservation.state as ReservationState | null | undefined;
        const toState = result.state as ReservationState | null | undefined;
        if (fromState && toState && fromState !== toState) {
          await tx.reservationAuditLog.create({
            data: {
              event:
                toState === 'CANCELLED' ? 'reservation_cancelled' : 'reservation_state_changed',
              reservationId: id,
              actor,
              fromState,
              toState,
              metadata: {
                source: 'legacy_reservation_update',
                ...(changedFields.length ? { changedFields } : {}),
              },
            },
          });
        } else if (changedFields.length) {
          await tx.reservationAuditLog.create({
            data: {
              event: 'reservation_fields_changed',
              reservationId: id,
              actor,
              fromState,
              toState,
              metadata: {
                source: 'legacy_reservation_update',
                changedFields,
              },
            },
          });
        }

        return result;
      });
      stateChanged = reservation.state !== updated.state;
    }

    const lifecycleEvent = reservationLifecycleEvent(updated.state);
    if (lifecycleEvent && stateChanged && (reservation.customerPhone || reservation.customerId)) {
      try {
        await CustomerService.recordReservationEvent({
          restaurantId,
          customerId: reservation.customerId,
          phone: reservation.customerPhone,
          name: reservation.customerName,
          reservationId: updated.id,
          eventType: lifecycleEvent,
          occurredAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: updated.id,
          },
          '[ReservationService] Customer lifecycle projection unavailable',
        );
      }
      if (lifecycleEvent === 'RESERVATION_CANCELLED') {
        try {
          await deactivateMarketingConversions({ restaurantId, reservationId: updated.id });
        } catch (error) {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              reservationId: updated.id,
            },
            '[ReservationService] Marketing conversion deactivation unavailable',
          );
        }
      }
      if (lifecycleEvent === 'RESERVATION_HONORED') {
        try {
          await recordMarketingHonoredConversions({
            restaurantId,
            reservationId: updated.id,
            customerId: updated.customerId ?? reservation.customerId,
            honoredAt: new Date(),
          });
        } catch (error) {
          logger.warn(
            {
              err: error instanceof Error ? error.message : String(error),
              reservationId: updated.id,
            },
            '[ReservationService] Marketing honored conversion unavailable',
          );
        }
      }
    }

    if (!projectedState) {
      await CapacityAwareAvailabilityService.invalidateAvailability(restaurantId);
      observeReservationMutation({
        source: 'legacy_service',
        operation: 'update',
        status: updated.status,
        state: updated.state,
        idempotency: 'not_applicable',
        audit: stateChanged || changedFields.length ? 'written' : 'not_applicable',
        notification: 'not_applicable',
        capacity: 'unchanged',
      });
    } else if (!lifecycleMutation) {
      // A status-only replay with no state change still reached the canonical
      // writer, but did not mutate the row. Keep the observation explicit.
      observeReservationMutation({
        source: 'legacy_service',
        operation: projectedState === 'CANCELLED' ? 'cancel' : 'update',
        status: updated.status,
        state: updated.state,
        idempotency: 'not_applicable',
        audit: 'not_applicable',
        notification: 'not_applicable',
        capacity: 'unchanged',
        mutated: false,
      });
    }
    return updated;
  }

  static async delete(id: string, restaurantId: string) {
    const reservation = await db.reservation.findUniqueOrThrow({
      where: { id, restaurantId },
    });

    // Le contrat HTTP DELETE est conservé pour les callers historiques, mais
    // une réservation auditée ne doit plus être supprimée physiquement : la FK
    // de l'audit est append-only et l'effacement de la ligne ferait échouer
    // PostgreSQL. On clôture donc la réservation dans un état terminal tout en
    // conservant sa preuve métier.
    const needsTerminalTransition =
      reservation.status !== 'CANCELLED' || reservation.state !== 'CANCELLED';

    const lifecycleResult = needsTerminalTransition
      ? await lifecycle.transition({
          reservationId: id,
          restaurantId,
          toState: 'CANCELLED',
          actor: 'legacy:reservation-delete',
          metadata: {
            source: 'legacy_reservation_service',
            mode: 'terminal_state',
          },
          auditEvent: 'reservation_deleted',
          operation: 'delete',
          observationSource: 'legacy_service',
          allowAlreadyInTarget: true,
          auditConsumedHoldRelease: true,
          snapshot: reservation,
        })
      : null;
    const updated = lifecycleResult?.reservation ?? reservation;

    if (needsTerminalTransition && (reservation.customerPhone || reservation.customerId)) {
      try {
        await CustomerService.recordReservationEvent({
          restaurantId,
          customerId: reservation.customerId,
          phone: reservation.customerPhone,
          name: reservation.customerName,
          reservationId: updated.id,
          eventType: 'RESERVATION_CANCELLED',
          occurredAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: updated.id,
          },
          '[ReservationService] Customer cancellation projection unavailable',
        );
      }
      try {
        await deactivateMarketingConversions({ restaurantId, reservationId: updated.id });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: updated.id,
          },
          '[ReservationService] Marketing conversion deactivation unavailable',
        );
      }
    }

    if (!needsTerminalTransition) {
      observeReservationMutation({
        source: 'legacy_service',
        operation: 'delete',
        status: updated.status,
        state: updated.state,
        idempotency: 'not_applicable',
        audit: 'not_applicable',
        notification: 'not_applicable',
        capacity: 'unchanged',
        mutated: false,
      });
    }
  }

  static async allocateTable(id: string, restaurantId: string): Promise<Reservation> {
    const reservation = await db.reservation.findUniqueOrThrow({
      where: { id, restaurantId },
      include: {
        restaurant: { include: { exposureSettings: true } },
        table: { select: { name: true } },
      },
    });

    if (reservation.tableId) {
      observeReservationMutation({
        source: 'legacy_service',
        operation: 'allocate_replay',
        status: reservation.status,
        state: reservation.state,
        idempotency: 'not_applicable',
        audit: 'not_applicable',
        notification: 'not_applicable',
        capacity: 'unchanged',
        mutated: false,
      });
      return reservation;
    }

    const serviceDurationMinutes = resolveServiceDurationMinutes(
      reservation.restaurant.exposureSettings?.capacitySpecials,
    );

    const updated = await db.$transaction(async (tx) => {
      await tableAllocation.lockRestaurantCapacity(tx, restaurantId);
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM reservations WHERE id = ${id} AND restaurant_id = ${restaurantId} FOR UPDATE`,
      );
      const current = await tx.reservation.findUniqueOrThrow({
        where: { id, restaurantId },
        include: { table: { select: { name: true } } },
      });
      if (current.tableId) return current;
      const currentStartsAt = current.startsAt ?? current.reservedAt;
      const currentEndsAt =
        current.endsAt ?? new Date(currentStartsAt.getTime() + serviceDurationMinutes * 60_000);
      const table = await tableAllocation.allocate(
        {
          restaurantId,
          partySize: current.partySize,
          startsAt: currentStartsAt,
          endsAt: currentEndsAt,
          excludeReservationId: id,
        },
        tx,
      );

      if (!table) {
        const err = new Error('SLOT_NOT_AVAILABLE');
        err.name = 'SLOT_NOT_AVAILABLE';
        throw err;
      }

      const updated = await tx.reservation.update({
        where: { id },
        data: { tableId: table.id, startsAt: currentStartsAt, endsAt: currentEndsAt },
        include: { table: { select: { name: true } } },
      });
      await tx.reservationAuditLog.create({
        data: {
          event: 'reservation_table_allocated',
          reservationId: id,
          actor: 'legacy:table-allocation',
          fromState: reservation.state,
          toState: reservation.state,
          metadata: { tableId: table.id },
        },
      });
      return updated;
    });

    await CapacityAwareAvailabilityService.invalidateAvailability(restaurantId);
    observeReservationMutation({
      source: 'legacy_service',
      operation: 'allocate',
      status: updated.status,
      state: updated.state,
      idempotency: 'not_applicable',
      audit: 'written',
      notification: 'not_applicable',
      capacity: 'reserved',
    });
    return updated;
  }

  static async findByRestaurant(
    restaurantId: string,
    date?: string,
    pagination?: { limit: number; offset: number },
    client: Prisma.TransactionClient = db,
  ) {
    const where: Prisma.ReservationWhereInput = { restaurantId };
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      where.reservedAt = { gte: start, lte: end };
    }
    const reservations = await client.reservation.findMany({
      where: {
        ...where,
        // Le DELETE legacy est désormais une clôture terminale. L'événement
        // d'archive masque la ligne de la liste opérationnelle, sans supprimer
        // la réservation ni ses audits de la base.
        auditLog: { none: { event: 'reservation_deleted' } },
      },
      orderBy: pagination ? [{ reservedAt: 'asc' }, { id: 'asc' }] : { reservedAt: 'asc' },
      ...(pagination && { take: pagination.limit, skip: pagination.offset }),
      include: {
        table: { select: { name: true } },
        auditLog: {
          where: { event: 'reservation_created', metadata: { path: ['overbooked'], equals: true } },
          select: { id: true },
          take: 1,
        },
      },
    });
    return reservations.map(({ auditLog, ...reservation }) => ({
      ...reservation,
      overbooked: auditLog.length > 0,
    }));
  }

  static async findDaySnapshot(restaurantId: string, date: string) {
    return db.$transaction(
      async (tx) => {
        const rows: Awaited<ReturnType<typeof ReservationService.findByRestaurant>> = [];
        let page: typeof rows;
        do {
          page = await ReservationService.findByRestaurant(
            restaurantId,
            date,
            { limit: 50, offset: rows.length },
            tx,
          );
          rows.push(...page);
        } while (page.length === 50);
        return rows;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * `options.minLeadTimeMinutes` : délai minimum, passé par les surfaces EN LIGNE (page /book). La voix
   * et le personnel n'en passent pas : pour eux, seul le passé est indisponible.
   */
  static async availability(
    restaurantId: string,
    date: string,
    partySize: number,
    options: { minLeadTimeMinutes?: number } = {},
  ): Promise<AvailabilityResult> {
    const dto = await availability.getAvailability({
      restaurantId,
      date,
      partySize,
      minLeadTimeMinutes: options.minLeadTimeMinutes,
    });
    return {
      restaurantId: dto.restaurantId,
      date: dto.date,
      partySize: dto.partySize,
      slots: dto.slots.filter((slot) => slot.available).map((slot) => slot.time),
      allSlots: dto.slots,
    };
  }

  /** Plages d'accueil des tables actives (voir `CapacityAwareAvailabilityService.tableRanges`). */
  static async tableRanges(
    restaurantId: string,
  ): Promise<Array<{ capacity: number; minCapacity: number }>> {
    return availability.tableRanges(restaurantId);
  }

  private static async checkSlotAvailability(
    restaurant: Pick<Restaurant, 'id' | 'timezone'>,
    startTime: Date,
    partySize: number,
  ): Promise<{ available: boolean; reason?: AvailabilitySlot['reason'] }> {
    if (Number.isNaN(startTime.getTime())) {
      return { available: false, reason: 'closed' };
    }

    // Même règle que le moteur de disponibilités : un créneau commencé n'est plus réservable.
    if (isSlotStartPast(startTime)) {
      return { available: false, reason: 'past' };
    }

    // Les clés de créneaux sont en heure locale du restaurant, pas en heure du process.
    const zoned = utcToZonedParts(startTime, restaurant.timezone ?? DEFAULT_RESTAURANT_TIMEZONE);
    const dto = await availability.getAvailability({
      restaurantId: restaurant.id,
      date: zoned.date,
      partySize,
    });

    const slot = dto.slots.find((s) => s.time === zoned.time);
    if (!slot) {
      return { available: false, reason: 'closed' };
    }
    if (!slot.available) {
      return { available: false, reason: 'local_conflict' };
    }

    return { available: true };
  }
}
