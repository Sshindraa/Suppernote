import type { Reservation } from '@prisma/client';
/**
 * Reservation service : crée, transitionne, annule les réservations.
 *
 * Pipeline createReservation :
 *   1. validateReservationAgainstPolicy
 *   2. checkAvailability (peut être court-circuité par un holdToken fourni)
 *   3. IdempotencyService.reserve (si canal agentic)
 *   4. HoldService.consumeHold (si holdToken fourni)
 *   5. INSERT Reservation + ReservationAuditLog dans une transaction
 *   6. IdempotencyService.complete
 *
 * Pipeline cancelReservation :
 *   1. assertCanTransition (state machine)
 *   2. UPDATE state + releaseHold (si applicable) dans une transaction
 *   3. audit log
 *
 * Pipeline transitionState (utilisé par SEATED / HONORED / NO_SHOW) :
 *   1. assertCanTransition
 *   2. UPDATE state + audit dans une transaction
 */

import { Prisma } from '@prisma/client';
import { enqueueReservationConfirmation } from '../../../shared/outbox/reservation-confirmation';
import type { PrismaClient, ReservationState } from '@prisma/client';
import { AuditLogService } from './audit-log.service.js';
import { logger } from '../../../shared/logger/pino';
import {
  generateHoldToken,
  HoldAlreadyConsumedError,
  HoldConflictError,
  HoldNotFoundError,
  HoldService,
} from './hold.service.js';
import {
  IdempotencyConflictError,
  IdempotencyPendingError,
  IdempotencyService,
} from './idempotency.service.js';
import { type PolicySnapshot, validateReservationAgainstPolicy } from './policies.service.js';
import { type ReservationChannel } from './state-machine.js';
import {
  inferReservationObservationSource,
  observeReservationMutation,
} from '../../../shared/observability/reservation-contract';
import {
  ACTIVE_RESERVATION_STATES,
  reservationOverlapWhere,
} from '../../../shared/reservations/capacity.js';
import { isReservationOverlapViolation } from '../../../shared/reservations/overlap-violation';
import { resolveServiceDurationMinutes } from '../../floor-plan/floor-plan.types';
import {
  creationProjection,
  type CreatableReservationState,
} from '../../../shared/reservations/reservation-state.js';
import { GiftCardService } from '../../gift-cards/gift-card.service.js';
import { TableAllocationService } from '../../floor-plan/table-allocation.service.js';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service.js';
import { findUnassignedSeatingConflict } from '../../floor-plan/unassigned-seating.js';
import type { GiftCardApplicationResult } from '../../gift-cards/gift-card.types.js';
import {
  IDEMPOTENCY_POLL_INTERVAL_MS,
  IDEMPOTENCY_MAX_WAIT_ATTEMPTS,
} from '../../../shared/constants/timeouts.js';
import { DEFAULT_TRANSACTION_OPTIONS } from '../../../shared/db/transaction-options';
import { CustomerService } from '../../customers/customer.service';
import {
  deactivateMarketingConversions,
  recordMarketingAttributionClick,
  recordMarketingConversion,
  recordMarketingHonoredConversions,
} from '../../marketing/marketing-attribution.service';
import {
  ReservationLifecycleService,
  ReservationNotFoundError,
} from '../../reservations/reservation-lifecycle.service.js';

export { ReservationNotFoundError } from '../../reservations/reservation-lifecycle.service.js';

export class ReservationAlreadyExistsError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`Reservation already exists for this idempotency key: ${idempotencyKey}`);
    this.name = 'ReservationAlreadyExistsError';
  }
}

export class ReservationSlotUnavailableError extends Error {
  constructor(
    public readonly restaurantId: string,
    public readonly startsAt: Date,
    public readonly partySize: number,
  ) {
    super(
      `Reservation slot unavailable: restaurant=${restaurantId} startsAt=${startsAt.toISOString()} party=${partySize}`,
    );
    this.name = 'ReservationSlotUnavailableError';
  }
}

export class ReservationModificationNotAllowedError extends Error {
  constructor() {
    super('Reservation cannot be modified in its current state');
    this.name = 'ReservationModificationNotAllowedError';
  }
}

export type CreateReservationInput = {
  restaurantId: string;
  partySize: number;
  startsAt: Date;
  endsAt: Date;
  customerName: string;
  customerPhone: string;
  /** Optionnel : e-mail de confirmation (canal WEB), conservé comme le téléphone. */
  customerEmail?: string | null;
  channel: ReservationChannel;
  policy: PolicySnapshot;
  actor: string;
  /** Optionnel : hold token pour finaliser un hold existant */
  holdToken?: string;
  /** Optionnel : consentements collectés (RGPD) */
  consents?: {
    reservationProcessing: boolean;
    transactionalSms: boolean;
    transactionalEmail: boolean;
    marketingOptIn: boolean;
    transactionalWhatsapp?: boolean;
    whatsappConsentProof?: {
      version: string;
      purpose: string;
      acceptedAt: string;
      ipHash?: string;
    };
    whatsappWithdrawalTokenHash?: string;
  };
  /** Optionnel : policy snapshot figé à T */
  cancellationPolicySnap?: unknown;
  noShowPolicySnap?: unknown;
  /** Optionnel : requêtes spéciales */
  specialRequests?: string;
  allowOverbook?: boolean;
  beforeCreate?: (tx: Prisma.TransactionClient) => Promise<void>;
  /**
   * Empreinte bancaire : la réservation naît `PENDING` (la place est tenue) et la ligne de paiement
   * est écrite dans la même transaction, pour que l'expiration puisse toujours libérer la place.
   */
  awaitingCardGuarantee?: (tx: Prisma.TransactionClient, reservationId: string) => Promise<void>;
  /** Optionnel : tableId pré-allouée (ex. Connect hold) */
  tableId?: string | null;
  /** Optionnel : code carte cadeau à appliquer */
  giftCardCode?: string;
  /** Optionnel : montant estimé de la réservation pour l'application de la carte cadeau */
  giftCardReservationAmount?: number;
  /** Optionnel : token signé d'une campagne marketing */
  marketingAttributionToken?: string;
  /**
   * Réservation test du restaurateur : ni fiche client, ni chronologie CRM,
   * ni attribution marketing, ni carte cadeau. La confirmation part quand même.
   */
  isTest?: boolean;
};

export type CreateReservationResult = {
  reservationId: string;
  state: ReservationState;
  reused: boolean;
  giftCardApplication?: GiftCardApplicationResult;
};

function reservationLifecycleEvent(
  state: ReservationState,
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

export class ReservationService {
  private readonly tableAllocation: TableAllocationService;
  private readonly lifecycle: ReservationLifecycleService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogService,
    private readonly holds: HoldService,
    private readonly idempotency: IdempotencyService,
  ) {
    this.tableAllocation = new TableAllocationService(this.prisma);
    this.lifecycle = new ReservationLifecycleService(this.prisma);
  }

  /**
   * Crée une réservation. Le flow complet est dans le service.
   */
  async createReservation(
    input: CreateReservationInput,
    idempotency: { scope: string; key: string; payloadHash: string; ttlSeconds: number },
  ): Promise<CreateReservationResult> {
    const observationSource = inferReservationObservationSource(input.actor, input.channel);

    // Un rejeu avec un hold consommé doit retrouver la réservation avant la
    // validation du token, qui n'est actif que pour la première création.
    if (input.holdToken) {
      const lookup = await this.idempotency.lookup(
        idempotency.scope,
        idempotency.key,
        idempotency.payloadHash,
      );
      if (lookup.kind === 'conflict') {
        throw new IdempotencyConflictError(idempotency.scope, idempotency.key);
      }
      if (lookup.kind === 'hit') {
        const existing = await this.waitForCompletedIdempotency(
          idempotency.scope,
          idempotency.key,
          idempotency.payloadHash,
        );
        if (existing) {
          observeReservationMutation({
            source: observationSource,
            operation: 'create_replay',
            state: existing.state,
            idempotency: 'reused',
            audit: 'not_applicable',
            notification: 'not_applicable',
            capacity: 'unchanged',
            mutated: false,
          });
          return existing;
        }
        throw new IdempotencyPendingError(idempotency.scope, idempotency.key);
      }
    }

    // 1. Valider la policy
    validateReservationAgainstPolicy(input.policy, {
      partySize: input.partySize,
      startsAt: input.startsAt,
      channel: input.channel,
    });

    // 2. Si un holdToken est fourni, vérifier qu'il existe et est valide
    let holdId: string | null = null;
    let tableId: string | null = input.allowOverbook ? null : (input.tableId ?? null);
    if (input.holdToken) {
      const hold = await this.holds.findActiveByToken(input.holdToken);
      if (!hold) {
        throw new HoldNotFoundError(input.holdToken);
      }
      if (
        hold.restaurantId !== input.restaurantId ||
        hold.partySize !== input.partySize ||
        hold.slotStart.getTime() !== input.startsAt.getTime() ||
        hold.slotEnd.getTime() !== input.endsAt.getTime() ||
        hold.type !== 'HOLD'
      ) {
        throw new HoldNotFoundError(input.holdToken);
      }
      holdId = hold.id;
      tableId = tableId ?? hold.tableId ?? null;
    }

    const isTest = input.isTest === true;
    let customerId: string | null = null;

    // 3. Réserver l'idempotence (Postgres first, Redis cache)
    const reserveResult = await this.idempotency.reserve({
      scope: idempotency.scope,
      key: idempotency.key,
      payloadHash: idempotency.payloadHash,
      ttlSeconds: idempotency.ttlSeconds,
    });

    if (reserveResult === 'reused') {
      const existing = await this.waitForCompletedIdempotency(
        idempotency.scope,
        idempotency.key,
        idempotency.payloadHash,
      );
      if (existing) {
        observeReservationMutation({
          source: observationSource,
          operation: 'create_replay',
          state: existing.state,
          idempotency: 'reused',
          audit: 'not_applicable',
          notification: 'not_applicable',
          capacity: 'unchanged',
          mutated: false,
        });
        return existing;
      }
      throw new IdempotencyPendingError(idempotency.scope, idempotency.key);
    }

    try {
      if (!isTest) {
        customerId = (
          await CustomerService.lookupOrCreate(
            input.restaurantId,
            input.customerPhone,
            input.customerName,
            { keepExistingName: true },
          )
        ).id;
      }
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          restaurantId: input.restaurantId,
        },
        '[AgenticReservationService] Customer CRM dual-write unavailable',
      );
    }

    // 4. INSERT dans une transaction
    let reservationId: string;
    let confirmationRequested = false;
    try {
      reservationId = await this.prisma.$transaction(async (tx) => {
        const now = new Date();
        let consumedHoldId: string | null = null;
        let shouldConsumeAfterReservation = false;

        // Le verrou advisory est posé au niveau du restaurant (et non du seul
        // startsAt) : deux créneaux qui se chevauchent doivent être sérialisés,
        // sinon chacun pourrait lire l'absence de conflit avant le commit de
        // l'autre. Le verdict de placement est celui de la disponibilité.
        await this.lockCapacitySlot(tx, input.restaurantId);
        const seating = input.allowOverbook
          ? null
          : await findUnassignedSeatingConflict(tx, {
              restaurantId: input.restaurantId,
              partySize: input.partySize,
              startsAt: input.startsAt,
              endsAt: input.endsAt,
              tableId,
              now,
              excludeHoldId: holdId,
            });
        if (seating?.conflict) {
          throw new ReservationSlotUnavailableError(
            input.restaurantId,
            input.startsAt,
            input.partySize,
          );
        }

        if (input.channel === 'ADMIN' && input.actor.startsWith('staff:') && !input.allowOverbook) {
          const hasTables = await tx.table.findFirst({
            where: {
              isActive: true,
              floorPlan: { restaurantId: input.restaurantId, isActive: true },
            },
            select: { id: true },
          });
          const table =
            hasTables &&
            (await this.tableAllocation.allocate(
              {
                restaurantId: input.restaurantId,
                partySize: input.partySize,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
              },
              tx,
            ));
          if (hasTables && !table)
            throw new ReservationSlotUnavailableError(
              input.restaurantId,
              input.startsAt,
              input.partySize,
            );
          if (table) tableId = table.id;
        }

        if (holdId) {
          const hold = await tx.agenticHold.findUnique({ where: { id: holdId } });
          if (!hold || hold.type !== 'HOLD') throw new HoldNotFoundError(input.holdToken ?? holdId);
          if (hold.status === 'CONSUMED') throw new HoldAlreadyConsumedError(hold.id);
          if (
            hold.status !== 'ACTIVE' ||
            hold.expiresAt.getTime() <= now.getTime() ||
            hold.restaurantId !== input.restaurantId ||
            hold.partySize !== input.partySize ||
            hold.slotStart.getTime() !== input.startsAt.getTime() ||
            hold.slotEnd.getTime() !== input.endsAt.getTime()
          ) {
            throw new HoldNotFoundError(input.holdToken ?? holdId);
          }

          await this.lockActiveHold(tx, hold.id, now);

          const consumed = await tx.agenticHold.updateMany({
            where: {
              id: hold.id,
              type: 'HOLD',
              status: 'ACTIVE',
              expiresAt: { gt: now },
            },
            data: {
              status: 'CONSUMED',
              consumedAt: now,
            },
          });
          if (consumed.count !== 1) {
            throw new HoldAlreadyConsumedError(hold.id);
          }
          consumedHoldId = hold.id;
        } else if (!input.allowOverbook) {
          await this.expireOverdueHoldForSlot(tx, {
            restaurantId: input.restaurantId,
            partySize: input.partySize,
            slotStart: input.startsAt,
            now,
          });

          try {
            const syntheticHold = await tx.agenticHold.create({
              data: {
                restaurantId: input.restaurantId,
                type: 'HOLD',
                partySize: input.partySize,
                slotStart: input.startsAt,
                slotEnd: input.endsAt,
                channel: input.channel,
                holdToken: generateHoldToken(),
                expiresAt: new Date(now.getTime() + input.policy.holdTtlSeconds * 1000),
                status: 'ACTIVE',
                policyVersion: input.policy.policyVersion,
              },
            });
            consumedHoldId = syntheticHold.id;
            shouldConsumeAfterReservation = true;
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
              throw new HoldConflictError(input.restaurantId, input.startsAt, input.partySize);
            }
            throw err;
          }
        }

        // Vérifier que la table pré-allouée est toujours disponible.
        if (tableId) {
          const belongsToRestaurant = await tx.table.findFirst({
            where: {
              id: tableId,
              isActive: true,
              capacity: { gte: input.partySize },
              minCapacity: { lte: input.partySize },
              floorPlan: { restaurantId: input.restaurantId, isActive: true },
            },
            select: { id: true },
          });
          if (!belongsToRestaurant) {
            throw new ReservationSlotUnavailableError(
              input.restaurantId,
              input.startsAt,
              input.partySize,
            );
          }
          const locked = await this.tableAllocation.lockTable(tx, tableId);
          if (!locked) {
            throw new ReservationSlotUnavailableError(
              input.restaurantId,
              input.startsAt,
              input.partySize,
            );
          }

          const stillAvailable = await this.tableAllocation.isTableAvailable(
            {
              tableId,
              startsAt: input.startsAt,
              endsAt: input.endsAt,
              // Le hold synthétique (ou le hold Connect consommé) est la
              // réservation de capacité courante ; il ne doit pas se
              // détecter lui-même comme blocker global.
              excludeHoldId: consumedHoldId ?? undefined,
            },
            tx,
          );
          if (!stillAvailable) {
            throw new ReservationSlotUnavailableError(
              input.restaurantId,
              input.startsAt,
              input.partySize,
            );
          }
        }

        // Avec un plan de salle, le verdict de placement couvre déjà les réservations et holds.
        const blockingReservation =
          input.allowOverbook || tableId || seating?.hasTables
            ? null
            : await this.findBlockingReservation(tx, {
                restaurantId: input.restaurantId,
                partySize: input.partySize,
                startsAt: input.startsAt,
                endsAt: input.endsAt,
              });
        if (blockingReservation) {
          throw new ReservationSlotUnavailableError(
            input.restaurantId,
            input.startsAt,
            input.partySize,
          );
        }
        if (!input.allowOverbook && !tableId && !seating?.hasTables) {
          const blockingHold = await tx.agenticHold.findFirst({
            where: {
              restaurantId: input.restaurantId,
              type: 'HOLD',
              status: 'ACTIVE',
              expiresAt: { gt: now },
              ...(consumedHoldId ? { id: { not: consumedHoldId } } : {}),
              slotStart: { lt: input.endsAt },
              slotEnd: { gt: input.startsAt },
            },
            select: { id: true },
          });
          if (blockingHold)
            throw new ReservationSlotUnavailableError(
              input.restaurantId,
              input.startsAt,
              input.partySize,
            );
        }

        // Une réservation test est invisible pour le restaurant : personne ne pourrait la valider.
        const initialState: CreatableReservationState =
          (input.policy.requireManualValidation || input.awaitingCardGuarantee) && !input.isTest
            ? 'PENDING'
            : 'CONFIRMED';

        await input.beforeCreate?.(tx);
        const reservation = await tx.reservation.create({
          data: {
            restaurantId: input.restaurantId,
            ...(customerId ? { customerId } : {}),
            ...(isTest ? { isTest: true } : {}),
            customerName: input.customerName,
            customerPhone: input.customerPhone,
            customerEmail: input.customerEmail ?? null,
            partySize: input.partySize,
            reservedAt: input.startsAt,
            channel: input.channel,
            ...creationProjection(initialState),
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            specialRequests: input.specialRequests,
            createdByClient: input.actor,
            cancellationPolicySnap: input.cancellationPolicySnap
              ? (input.cancellationPolicySnap as Prisma.InputJsonValue)
              : (input.policy.cancellation as Prisma.InputJsonValue),
            noShowPolicySnap: input.noShowPolicySnap
              ? (input.noShowPolicySnap as Prisma.InputJsonValue)
              : Prisma.JsonNull,
            consents: (input.consents ?? {}) as Prisma.InputJsonValue,
            privacyPolicyVersion: input.policy.policyVersion,
            idempotencyScope: idempotency.scope,
            idempotencyKey: idempotency.key,
            idempotencyPayloadHash: idempotency.payloadHash,
            consumedHoldId,
            tableId,
          },
        });

        if (input.awaitingCardGuarantee && !input.isTest) {
          await input.awaitingCardGuarantee(tx, reservation.id);
        }
        confirmationRequested = await enqueueReservationConfirmation(tx, reservation);

        if (consumedHoldId) {
          if (shouldConsumeAfterReservation) {
            await this.lockActiveHold(tx, consumedHoldId, now);
            const consumed = await tx.agenticHold.updateMany({
              where: {
                id: consumedHoldId,
                status: 'ACTIVE',
              },
              data: {
                status: 'CONSUMED',
                consumedAt: now,
                reservationId: reservation.id,
              },
            });
            if (consumed.count !== 1) {
              throw new HoldAlreadyConsumedError(consumedHoldId);
            }
          } else {
            await tx.agenticHold.update({
              where: { id: consumedHoldId },
              data: { reservationId: reservation.id },
            });
          }

          await tx.reservationAuditLog.create({
            data: {
              event: 'hold_consumed',
              reservationId: reservation.id,
              holdId: consumedHoldId,
              actor: input.actor,
              metadata: {
                slotStart: input.startsAt.toISOString(),
                partySize: input.partySize,
              },
            },
          });
        }

        // Audit
        await tx.reservationAuditLog.create({
          data: {
            event: 'reservation_created',
            reservationId: reservation.id,
            holdId: consumedHoldId,
            actor: input.actor,
            toState: initialState,
            metadata: {
              partySize: input.partySize,
              channel: input.channel,
              requiresManualValidation: input.policy.requireManualValidation,
              ...(input.allowOverbook ? { overbooked: true } : {}),
            },
          },
        });

        return reservation.id;
      }, DEFAULT_TRANSACTION_OPTIONS);
    } catch (err) {
      await this.idempotency.fail({ scope: idempotency.scope, key: idempotency.key });
      if (isReservationOverlapViolation(err)) {
        throw new ReservationSlotUnavailableError(
          input.restaurantId,
          input.startsAt,
          input.partySize,
        );
      }
      throw err;
    }

    // 5. Marquer l'idempotence comme complétée
    await this.idempotency.complete({
      scope: idempotency.scope,
      key: idempotency.key,
      payloadHash: idempotency.payloadHash,
      reservationId,
    });

    const final = await this.prisma.reservation.findUnique({ where: { id: reservationId } });

    if (!isTest) {
      try {
        await CustomerService.recordReservationEvent({
          restaurantId: input.restaurantId,
          customerId,
          phone: input.customerPhone,
          name: input.customerName,
          reservationId,
          eventType: 'RESERVATION_CREATED',
          occurredAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          { err: error instanceof Error ? error.message : String(error), reservationId },
          '[AgenticReservationService] Customer timeline projection unavailable',
        );
      }
    }

    // Campaign links are optional and best-effort: a malformed or expired
    // token must never block a valid agentic/web reservation. Resolve it to the
    // same tenant and customer before recording the created conversion.
    if (!isTest && input.marketingAttributionToken && customerId) {
      try {
        const link = await recordMarketingAttributionClick({
          token: input.marketingAttributionToken,
        });
        if (link && link.restaurantId === input.restaurantId && link.customerId === customerId) {
          await recordMarketingConversion({
            restaurantId: input.restaurantId,
            campaignId: link.campaignId,
            customerId,
            reservationId,
            conversionType: 'RESERVATION_CREATED',
            attributedAt: new Date(),
            windowEndsAt: link.expiresAt,
          });
        }
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId,
          },
          '[AgenticReservationService] Marketing attribution projection unavailable',
        );
      }
    }

    let giftCardApplication: GiftCardApplicationResult | undefined;
    let giftCardSnapshotUpdated = false;
    if (!isTest && input.giftCardCode) {
      try {
        giftCardApplication = await new GiftCardService(this.prisma).associateToReservation({
          code: input.giftCardCode,
          restaurantId: input.restaurantId,
          reservationId,
        });
        giftCardSnapshotUpdated = true;
      } catch (err) {
        logger.warn(
          { errorType: err instanceof Error ? err.name : 'unknown', reservationId },
          'gift card association failed after reservation creation',
        );
      }
    }

    observeReservationMutation({
      source: observationSource,
      operation: 'create',
      status: final?.status,
      state: final?.state ?? 'CONFIRMED',
      idempotency: 'keyed',
      audit: 'written',
      notification: confirmationRequested ? 'queued' : 'not_sent',
      capacity: 'reserved',
    });
    if (giftCardSnapshotUpdated) {
      observeReservationMutation({
        source: 'gift_card',
        operation: 'update',
        status: final?.status,
        state: final?.state ?? 'CONFIRMED',
        idempotency: 'not_applicable',
        audit: 'not_applicable',
        notification: 'not_applicable',
        capacity: 'unchanged',
      });
    }

    return {
      reservationId,
      state: (final?.state ?? 'CONFIRMED') as ReservationState,
      reused: false,
      giftCardApplication,
    };
  }

  /**
   * Transitionne une réservation vers un nouvel état.
   * Jette InvalidStateTransitionError ou InvalidStateInvariantError si la transition n'est pas autorisée.
   */
  async transitionState(args: {
    reservationId: string;
    restaurantId: string;
    toState: ReservationState;
    actor: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const lifecycle = await this.lifecycle.transition({
      reservationId: args.reservationId,
      restaurantId: args.restaurantId,
      toState: args.toState,
      actor: args.actor,
      metadata: args.metadata,
      operation: 'transition',
      observationSource: inferReservationObservationSource(args.actor),
    });
    const reservation = lifecycle.previous;
    const customerForProjection = {
      customerId: reservation.customerId,
      phone: reservation.customerPhone,
      name: reservation.customerName,
    };

    if (reservationLifecycleEvent(args.toState)) {
      try {
        await CustomerService.recordReservationEvent({
          restaurantId: args.restaurantId,
          customerId: customerForProjection.customerId,
          phone: customerForProjection.phone,
          name: customerForProjection.name,
          reservationId: args.reservationId,
          eventType: reservationLifecycleEvent(args.toState)!,
          occurredAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: args.reservationId,
          },
          '[AgenticReservationService] Customer lifecycle projection unavailable',
        );
      }
    }
    if (args.toState === 'HONORED' && customerForProjection?.customerId) {
      try {
        await recordMarketingHonoredConversions({
          restaurantId: args.restaurantId,
          reservationId: args.reservationId,
          customerId: customerForProjection.customerId,
          honoredAt: new Date(),
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: args.reservationId,
          },
          '[AgenticReservationService] Marketing honored conversion unavailable',
        );
      }
    }
    if (args.toState === 'CANCELLED') {
      try {
        await deactivateMarketingConversions({
          restaurantId: args.restaurantId,
          reservationId: args.reservationId,
        });
      } catch (error) {
        logger.warn(
          {
            err: error instanceof Error ? error.message : String(error),
            reservationId: args.reservationId,
          },
          '[AgenticReservationService] Marketing conversion deactivation unavailable',
        );
      }
    }
  }

  /** Modifie une réservation sous le même verrou de capacité que sa création. */
  async modifyReservation(args: {
    reservationId: string;
    restaurantId: string;
    actor: string;
    publicClient: boolean;
    customerPhone?: string;
    partySize?: number;
    startsAt?: Date;
    endsAt?: Date;
    customerName?: string;
    specialRequests?: string | null;
    preserveDuration?: boolean;
    /** Internal adapter authorization, rechecked under the same capacity/row locks. */
    beforeModify?: (tx: Prisma.TransactionClient, current: Reservation) => Promise<void>;
    auditMetadata?: Prisma.InputJsonObject;
  }): Promise<{ reservationId: string; state: ReservationState; changed: boolean }> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockCapacitySlot(tx, args.restaurantId);
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM reservations WHERE id = ${args.reservationId} AND restaurant_id = ${args.restaurantId} FOR UPDATE`,
      );
      const current = await tx.reservation.findFirst({
        where: { id: args.reservationId, restaurantId: args.restaurantId },
      });
      if (
        !current ||
        (args.publicClient &&
          (current.createdByClient !== args.actor ||
            !args.customerPhone ||
            current.customerPhone !== args.customerPhone))
      ) {
        throw new ReservationNotFoundError(args.reservationId);
      }
      if (current.state !== 'PENDING' && current.state !== 'CONFIRMED') {
        throw new ReservationModificationNotAllowedError();
      }

      await args.beforeModify?.(tx, current);

      const startsAt = args.startsAt ?? current.startsAt ?? current.reservedAt;
      const endsAt =
        args.preserveDuration && args.startsAt && current.endsAt
          ? new Date(
              args.startsAt.getTime() +
                current.endsAt.getTime() -
                (current.startsAt ?? current.reservedAt).getTime(),
            )
          : (args.endsAt ?? current.endsAt);
      const partySize = args.partySize ?? current.partySize;
      if (
        (!args.actor.startsWith('staff:') ||
          args.publicClient ||
          args.startsAt !== undefined ||
          args.partySize !== undefined) &&
        (!endsAt || endsAt <= startsAt || startsAt <= new Date())
      ) {
        throw new ReservationModificationNotAllowedError();
      }
      const capacityChanged =
        startsAt.getTime() !== (current.startsAt ?? current.reservedAt).getTime() ||
        endsAt?.getTime() !== current.endsAt?.getTime() ||
        partySize !== current.partySize;
      const nameChanged =
        args.customerName !== undefined && args.customerName !== current.customerName;
      const notesChanged =
        args.specialRequests !== undefined && args.specialRequests !== current.specialRequests;
      if (!capacityChanged && !nameChanged && !notesChanged) {
        return { reservation: current, changed: false, capacityChanged: false };
      }

      let tableId = current.tableId;
      if (capacityChanged) {
        if (!endsAt) throw new ReservationModificationNotAllowedError();
        const seating = await findUnassignedSeatingConflict(tx, {
          restaurantId: args.restaurantId,
          partySize,
          startsAt,
          endsAt,
          tableId,
          now: new Date(),
          excludeReservationId: current.id,
        });
        if (seating.conflict) {
          throw new ReservationSlotUnavailableError(args.restaurantId, startsAt, partySize);
        }
        if (tableId) {
          const table = await this.tableAllocation.allocate(
            {
              restaurantId: args.restaurantId,
              partySize,
              startsAt,
              endsAt,
              excludeReservationId: current.id,
            },
            tx,
          );
          if (!table) {
            throw new ReservationSlotUnavailableError(args.restaurantId, startsAt, partySize);
          }
          tableId = table.id;
        } else if (!seating.hasTables) {
          const otherReservation = await tx.reservation.findFirst({
            where: {
              restaurantId: args.restaurantId,
              isTest: false,
              id: { not: current.id },
              state: { in: [...ACTIVE_RESERVATION_STATES] },
              startsAt: { lt: endsAt },
              endsAt: { gt: startsAt },
            },
            select: { id: true },
          });
          const otherHold = await tx.agenticHold.findFirst({
            where: {
              restaurantId: args.restaurantId,
              type: 'HOLD',
              status: 'ACTIVE',
              expiresAt: { gt: new Date() },
              slotStart: { lt: endsAt },
              slotEnd: { gt: startsAt },
            },
            select: { id: true },
          });
          if (otherReservation || otherHold) {
            throw new ReservationSlotUnavailableError(args.restaurantId, startsAt, partySize);
          }
          const sameSlot = await this.findBlockingReservation(tx, {
            restaurantId: args.restaurantId,
            partySize,
            startsAt,
            endsAt,
            excludeReservationId: current.id,
          });
          if (sameSlot) {
            throw new ReservationSlotUnavailableError(args.restaurantId, startsAt, partySize);
          }
        }
      }

      const reservation = await tx.reservation.update({
        where: { id: current.id, restaurantId: args.restaurantId },
        data: {
          ...(capacityChanged
            ? { partySize, reservedAt: startsAt, startsAt, endsAt, tableId }
            : {}),
          ...(nameChanged ? { customerName: args.customerName } : {}),
          ...(notesChanged ? { specialRequests: args.specialRequests } : {}),
        },
      });
      await tx.reservationAuditLog.create({
        data: {
          event: 'reservation_fields_changed',
          reservationId: current.id,
          actor: args.actor,
          fromState: current.state,
          toState: current.state,
          metadata: {
            ...args.auditMetadata,
            source: args.auditMetadata?.source ?? 'mcp',
            changedFields: [
              ...(capacityChanged ? ['partySize', 'startsAt', 'endsAt', 'tableId'] : []),
              ...(nameChanged ? ['customerName'] : []),
              ...(notesChanged ? ['specialRequests'] : []),
            ],
          },
        },
      });
      return { reservation, changed: true, capacityChanged };
    }, DEFAULT_TRANSACTION_OPTIONS);

    if (result.capacityChanged) {
      try {
        await CapacityAwareAvailabilityService.invalidateAvailability(args.restaurantId);
      } catch (err) {
        logger.warn(
          { reservationId: args.reservationId, errorName: (err as Error)?.name },
          'MCP reservation availability cache invalidation failed',
        );
      }
    }
    if (result.changed) {
      observeReservationMutation({
        source: args.actor.startsWith('staff:')
          ? 'dashboard'
          : args.actor === 'customer:personal-link'
            ? 'direct'
            : 'mcp',
        operation: 'update',
        status: result.reservation.status,
        state: result.reservation.state,
        idempotency: 'not_applicable',
        audit: 'written',
        notification: 'not_sent',
        capacity: result.capacityChanged ? 'reserved' : 'unchanged',
      });
    }
    return {
      reservationId: result.reservation.id,
      state: result.reservation.state,
      changed: result.changed,
    };
  }

  /**
   * Annule une réservation et libère le hold si applicable.
   */
  async cancelReservation(args: {
    reservationId: string;
    actor: string;
    reason?: string;
    /** Optional tenant scope for callers that already resolved the row. */
    restaurantId?: string;
  }): Promise<void> {
    const snapshot = args.restaurantId
      ? undefined
      : await this.prisma.reservation.findUnique({ where: { id: args.reservationId } });
    if (!args.restaurantId && !snapshot) throw new ReservationNotFoundError(args.reservationId);
    const restaurantId = args.restaurantId ?? snapshot?.restaurantId;
    if (!restaurantId) throw new ReservationNotFoundError(args.reservationId);

    const lifecycle = await this.lifecycle.transition({
      reservationId: args.reservationId,
      restaurantId,
      toState: 'CANCELLED',
      actor: args.actor,
      metadata: args.reason ? { reason: args.reason } : {},
      operation: 'cancel',
      observationSource: inferReservationObservationSource(args.actor),
      auditConsumedHoldRelease: true,
      snapshot: snapshot ?? undefined,
    });
    const reservation = lifecycle.previous;

    try {
      await CustomerService.recordReservationEvent({
        restaurantId: reservation.restaurantId,
        customerId: reservation.customerId,
        phone: reservation.customerPhone,
        name: reservation.customerName,
        reservationId: reservation.id,
        eventType: 'RESERVATION_CANCELLED',
        occurredAt: new Date(),
      });
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          reservationId: reservation.id,
        },
        '[AgenticReservationService] Customer cancellation projection unavailable',
      );
    }

    try {
      await deactivateMarketingConversions({
        restaurantId: reservation.restaurantId,
        reservationId: reservation.id,
      });
    } catch (error) {
      logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
          reservationId: reservation.id,
        },
        '[AgenticReservationService] Marketing conversion deactivation unavailable',
      );
    }
  }

  private async waitForCompletedIdempotency(
    scope: string,
    key: string,
    payloadHash: string,
  ): Promise<CreateReservationResult | null> {
    for (let attempt = 0; attempt < IDEMPOTENCY_MAX_WAIT_ATTEMPTS; attempt++) {
      const existing = await this.idempotency.lookup(scope, key, payloadHash);
      if (existing.kind === 'conflict') {
        throw new ReservationAlreadyExistsError(key);
      }
      if (existing.kind === 'hit') {
        const reservation = await this.prisma.reservation.findUnique({
          where: { id: existing.reservationId },
        });
        if (reservation) {
          return {
            reservationId: reservation.id,
            state: reservation.state as ReservationState,
            reused: true,
          };
        }
      }
      await new Promise((resolve) => setTimeout(resolve, IDEMPOTENCY_POLL_INTERVAL_MS));
    }
    return null;
  }

  private async findBlockingReservation(
    tx: Prisma.TransactionClient,
    args: {
      restaurantId: string;
      partySize: number;
      startsAt: Date;
      endsAt: Date;
      excludeReservationId?: string;
    },
  ): Promise<{ id: string } | null> {
    const settings = await tx.restaurantExposureSettings.findUnique({
      where: { restaurantId: args.restaurantId },
      select: { capacitySpecials: true },
    });
    return tx.reservation.findFirst({
      where: {
        restaurantId: args.restaurantId,
        isTest: false,
        ...(args.excludeReservationId ? { id: { not: args.excludeReservationId } } : {}),
        OR: reservationOverlapWhere(
          args.startsAt,
          args.endsAt,
          resolveServiceDurationMinutes(settings?.capacitySpecials),
        ),
        state: { in: ['PENDING', 'CONFIRMED', 'SEATED'] },
      },
      select: { id: true },
    });
  }

  private async lockCapacitySlot(
    tx: Prisma.TransactionClient,
    restaurantId: string,
  ): Promise<void> {
    const query = Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${restaurantId}, 0))`;
    if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw(query);
      return;
    }
    await tx.$queryRaw(query);
  }

  private async expireOverdueHoldForSlot(
    tx: Prisma.TransactionClient,
    args: {
      restaurantId: string;
      partySize: number;
      slotStart: Date;
      now: Date;
    },
  ): Promise<void> {
    const overdue = await tx.agenticHold.findMany({
      where: {
        restaurantId: args.restaurantId,
        partySize: args.partySize,
        slotStart: args.slotStart,
        type: 'HOLD',
        status: 'ACTIVE',
        expiresAt: { lt: args.now },
      },
      select: { id: true, restaurantId: true },
    });

    for (const hold of overdue) {
      const updated = await tx.agenticHold.updateMany({
        where: {
          id: hold.id,
          status: 'ACTIVE',
          expiresAt: { lt: args.now },
        },
        data: { status: 'EXPIRED' },
      });
      if (updated.count !== 1) continue;

      await tx.reservationAuditLog.create({
        data: {
          event: 'hold_expired',
          holdId: hold.id,
          actor: 'system:reservation-service',
          metadata: { restaurantId: hold.restaurantId },
        },
      });
    }
  }

  private async lockActiveHold(
    tx: Prisma.TransactionClient,
    holdId: string,
    now: Date,
  ): Promise<void> {
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM agentic_holds WHERE id = ${holdId} AND status = 'ACTIVE' AND type = 'HOLD' AND expires_at > ${now} AT TIME ZONE 'UTC' FOR UPDATE`,
    );
    if (!locked || locked.length === 0) {
      throw new HoldAlreadyConsumedError(holdId);
    }
  }
}
