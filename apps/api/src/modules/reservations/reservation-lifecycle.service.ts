import {
  Prisma,
  type PrismaClient,
  type Reservation,
  type ReservationState,
  type ReservationStatus,
} from '@prisma/client';
import {
  assertCanTransition,
  InvalidStateInvariantError,
  type ReservationState as DomainReservationState,
} from '../../shared/reservations/reservation-state-machine.js';
import {
  inferReservationObservationSource,
  observeReservationMutation,
  reservationCapacityEffect,
  type ReservationCapacityObservation,
  type ReservationObservationOperation,
  type ReservationObservationSource,
} from '../../shared/observability/reservation-contract';
import { CapacityAwareAvailabilityService } from '../floor-plan/availability-capacity-aware.service.js';
import { TableAllocationService } from '../floor-plan/table-allocation.service.js';
import { transitionProjection } from '../../shared/reservations/reservation-state.js';
import { DEFAULT_TRANSACTION_OPTIONS } from '../../shared/db/transaction-options';
import { enqueueReservationConfirmation } from '../../shared/outbox/reservation-confirmation';
import { enqueue } from '../../shared/outbox/outbox.service';

import {
  cleanUpCancelledCardGuarantee,
  releaseCardGuaranteeOnCancel,
} from '../reservation-payments/reservation-guarantee.release';

export class ReservationNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Reservation not found: id=${id}`);
    this.name = 'ReservationNotFoundError';
  }
}

export type ReservationLifecycleResult = {
  reservation: Reservation;
  previous: Reservation;
  fromState: ReservationState;
  toState: ReservationState;
  capacity: ReservationCapacityObservation;
  mutated: boolean;
};

export type ReservationLifecycleTransitionInput = {
  reservationId: string;
  restaurantId: string;
  toState: ReservationState;
  actor: string;
  metadata?: Record<string, unknown>;
  /** PII-free field names for day/time/party-size edit measurement. */
  changedFields?: Array<'date' | 'time' | 'party_size'>;
  /** Preserve a caller-specific audit event such as reservation_deleted. */
  auditEvent?: string;
  /** Preserve the legacy operation label while using the canonical writer. */
  operation?: ReservationObservationOperation;
  observationSource?: ReservationObservationSource;
  /** Additional fields (PII or operational fields) updated atomically. */
  additionalData?: Prisma.ReservationUpdateInput;
  /** Idempotent close for DELETE/repeated operational actions. */
  allowAlreadyInTarget?: boolean;
  /** Treat a provider/webhook transition as a conditional no-op if the row moved. */
  onlyIfFromState?: ReservationState;
  /** Keep the historical hold consumption proof when cancelling. */
  auditConsumedHoldRelease?: boolean;
  /** Snapshot already loaded by a compatibility adapter. */
  snapshot?: Reservation;
};

/**
 * Canonical writer for reservation lifecycle mutations.
 *
 * Creation remains channel-specific because voice, Connect and agentic flows
 * have different idempotency, hold, policy and notification contracts. The
 * lifecycle transitions exposed by the legacy and agentic reservation services pass
 * through this writer so that the state machine, status projection, audit and
 * capacity invalidation cannot diverge between their callers. Transactional
 * workflows with their own atomicity boundary (payment confirmation and delay
 * recovery) remain explicit adapters and are documented separately.
 */
export class ReservationLifecycleService {
  private readonly tableAllocation: TableAllocationService;

  constructor(private readonly prisma: PrismaClient) {
    this.tableAllocation = new TableAllocationService(prisma);
  }

  async transition(args: ReservationLifecycleTransitionInput): Promise<ReservationLifecycleResult> {
    const result = await this.prisma.$transaction(
      (tx) => this.transitionInTransaction(tx, args),
      DEFAULT_TRANSACTION_OPTIONS,
    );
    await this.finalizeTransition(args, result);
    return result;
  }

  /**
   * Applies the canonical mutation inside an existing transaction.
   *
   * Payment webhooks and delay recovery update several aggregates atomically;
   * they use this method inside their transaction and call `finalizeTransition`
   * only after the outer transaction commits.
   */
  async transitionInTransaction(
    tx: Prisma.TransactionClient,
    args: ReservationLifecycleTransitionInput,
  ): Promise<ReservationLifecycleResult> {
    // SEATED vérifie la capacité du restaurant : son verrou doit précéder le verrou de ligne,
    // comme dans les autres chemins, sinon interblocage avec la promotion Service Copilot.
    if (args.toState === 'SEATED') {
      await this.tableAllocation.lockRestaurantCapacity(tx, args.restaurantId);
    }
    // Serialize lifecycle decisions for one tenant/row. The fallback keeps
    // lightweight compatibility fakes usable in unit tests; real Prisma
    // clients always expose `$queryRaw`.
    const queryRaw = (tx as unknown as { $queryRaw?: (query: unknown) => Promise<unknown> })
      .$queryRaw;
    if (typeof queryRaw === 'function') {
      await queryRaw.call(
        tx,
        Prisma.sql`SELECT id FROM "reservations" WHERE id = ${args.reservationId} AND restaurant_id = ${args.restaurantId} FOR UPDATE`,
      );
    }

    const findUnique = (
      tx.reservation as unknown as {
        findUnique?: (query: {
          where: { id: string; restaurantId: string };
        }) => Promise<Reservation | null | undefined>;
      }
    ).findUnique;
    const queried =
      typeof findUnique === 'function'
        ? await findUnique.call(tx.reservation, {
            where: { id: args.reservationId, restaurantId: args.restaurantId },
          })
        : undefined;
    const previous = queried === undefined ? args.snapshot : queried;
    if (!previous) throw new ReservationNotFoundError(args.reservationId);

    const fromState = previous.state as ReservationState;
    if (args.onlyIfFromState && fromState !== args.onlyIfFromState) {
      return {
        previous,
        reservation: previous,
        fromState,
        toState: args.toState,
        capacity: 'unchanged' as const,
        mutated: false,
      };
    }
    const sameState = fromState === args.toState;
    if (!sameState || !args.allowAlreadyInTarget) {
      if (sameState) {
        throw new Error(`Reservation already in state: ${args.toState}`);
      }
      assertCanTransition(
        fromState as DomainReservationState,
        args.toState as DomainReservationState,
        {
          tableId: previous.tableId,
          startsAt: previous.startsAt ?? previous.reservedAt,
          endsAt: previous.endsAt,
        },
      );
    }

    if (args.toState === 'SEATED' && !sameState) {
      if (!previous.tableId) {
        throw new InvalidStateInvariantError('SEATED requires a tableId');
      }
      const now = new Date();
      if (previous.endsAt && previous.endsAt <= now) {
        throw new InvalidStateInvariantError('Cannot seat a reservation that has already ended');
      }
      const startsAt = now;
      const endsAt = previous.endsAt ?? new Date(now.getTime() + 2 * 60 * 60 * 1000);
      await this.tableAllocation.assertTableAvailableForSeating(
        {
          restaurantId: args.restaurantId,
          tableId: previous.tableId,
          partySize: previous.partySize,
          startsAt,
          endsAt,
          excludeReservationId: previous.id,
        },
        tx,
      );
    }

    const additionalData = { ...(args.additionalData ?? {}) };
    // State and status are owned by this gateway. A compatibility caller may
    // pass a Prisma update object containing either field; silently ignoring
    // it prevents a second projection rule from reappearing.
    delete additionalData.state;
    delete additionalData.status;

    const projection = transitionProjection(args.toState, previous.status as ReservationStatus);
    const shouldWrite = !sameState || Object.keys(additionalData).length > 0;
    if (!shouldWrite) {
      return {
        previous,
        reservation: previous,
        fromState,
        toState: args.toState,
        capacity: 'unchanged' as const,
        mutated: false,
      };
    }

    const reservation = await tx.reservation.update({
      where: { id: args.reservationId, restaurantId: args.restaurantId },
      data: { ...additionalData, ...projection },
    });

    if (!sameState && args.toState === 'CONFIRMED') {
      await enqueueReservationConfirmation(tx, reservation);
    }

    if (!sameState && args.toState === 'CANCELLED') {
      await releaseCardGuaranteeOnCancel(tx, reservation, args.actor);
    }

    if (
      !sameState &&
      args.toState === 'HONORED' &&
      reservation.customerEmail &&
      reservation.customerId &&
      !reservation.isTest
    ) {
      await enqueue(tx, {
        restaurantId: reservation.restaurantId,
        topic: 'reputation-feedback-email',
        aggregateType: 'reservation',
        aggregateId: reservation.id,
        eventType: 'reputation.feedback_email.requested',
        idempotencyKey: `reputation-feedback-email:${reservation.id}`,
        payload: { reservationId: reservation.id },
        availableAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
    }

    if (!sameState) {
      if (
        args.auditConsumedHoldRelease &&
        args.toState === 'CANCELLED' &&
        previous.consumedHoldId
      ) {
        // tenant-scoping: global — identifiant unique déjà rattaché à la
        // réservation verrouillée dans cette transaction tenant-scopée.
        const hold = await tx.agenticHold.findUnique({ where: { id: previous.consumedHoldId } });
        if (hold?.status === 'CONSUMED') {
          await tx.reservationAuditLog.create({
            data: {
              event: 'hold_released',
              holdId: hold.id,
              reservationId: previous.id,
              actor: args.actor,
              metadata: { reason: 'reservation_cancelled' },
            },
          });
        }
      }

      await tx.reservationAuditLog.create({
        data: {
          event: args.auditEvent ?? this.eventForTransition(args.toState),
          reservationId: previous.id,
          actor: args.actor,
          fromState,
          toState: args.toState,
          metadata: {
            ...(args.metadata ?? {}),
            ...(args.changedFields?.length ? { changedFields: args.changedFields } : {}),
          } as Prisma.InputJsonValue,
        },
      });
    } else if (args.changedFields?.length) {
      await tx.reservationAuditLog.create({
        data: {
          event: 'reservation_fields_changed',
          reservationId: previous.id,
          actor: args.actor,
          fromState,
          toState: args.toState,
          metadata: {
            ...(args.metadata ?? {}),
            changedFields: args.changedFields,
          } as Prisma.InputJsonValue,
        },
      });
    }

    return {
      previous,
      reservation,
      fromState,
      toState: args.toState,
      capacity: reservationCapacityEffect(fromState, args.toState),
      mutated: true,
    };
  }

  async finalizeTransition(
    args: ReservationLifecycleTransitionInput,
    result: ReservationLifecycleResult,
  ): Promise<void> {
    if (result.mutated && args.toState === 'CANCELLED') {
      await cleanUpCancelledCardGuarantee(args.restaurantId, args.reservationId);
    }
    if (result.capacity !== 'unchanged') {
      await CapacityAwareAvailabilityService.invalidateAvailability(args.restaurantId);
    }

    if (result.mutated) {
      observeReservationMutation({
        source: args.observationSource ?? inferReservationObservationSource(args.actor),
        operation: args.operation ?? (args.toState === 'CANCELLED' ? 'cancel' : 'transition'),
        status: result.reservation.status,
        state: result.reservation.state,
        idempotency: 'not_applicable',
        audit: result.fromState !== result.toState ? 'written' : 'not_applicable',
        notification: 'not_sent',
        capacity: result.capacity,
      });
    }
  }

  private eventForTransition(toState: ReservationState): string {
    switch (toState) {
      case 'SEATED':
        return 'reservation_seated';
      case 'HONORED':
        return 'reservation_honored';
      case 'NO_SHOW':
        return 'reservation_no_show';
      case 'CANCELLED':
        return 'reservation_cancelled';
      case 'FAILED':
        return 'reservation_failed';
      case 'EXPIRED':
        return 'hold_expired';
      default:
        return 'state_transition';
    }
  }
}
