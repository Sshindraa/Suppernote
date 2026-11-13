/**
 * TableAllocationService — allocation best-fit d'une table physique à une
 * réservation ou un hold.
 *
 * Contraintes :
 * - table.active = true
 * - table.capacity >= partySize
 * - table.minCapacity <= partySize (optionnel)
 * - pas de chevauchement avec une réservation bloquante sur la même table
 * - pas de chevauchement avec un hold actif sur la même table
 *
 * Stratégie par défaut : best-fit (plus petite table adaptée), puis préférence
 * de section.
 */

import { Prisma } from '@prisma/client';
import type { PrismaClient, Table, Reservation } from '@prisma/client';
import type {
  AllocateTableInput,
  AllocationSuggestion,
  TableAvailabilityCheck,
} from './floor-plan.types';
import { observeReservationMutation } from '../../shared/observability/reservation-contract';
import { CapacityAwareAvailabilityService } from './availability-capacity-aware.service.js';
import { findUnassignedSeatingConflict } from './unassigned-seating.js';

export class TableAllocationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Alloue la meilleure table disponible pour un créneau donné.
   * Renvoie null si aucune table n'est disponible.
   *
   * Verrouille chaque table candidate (FOR UPDATE SKIP LOCKED) avant de
   * vérifier sa disponibilité. Pour une prévisualisation sans verrou,
   * utiliser `suggest`.
   */
  async allocate(
    input: AllocateTableInput,
    tx?: Prisma.TransactionClient,
    options?: { readOnly?: boolean },
  ): Promise<Table | null> {
    const prisma = tx ?? this.prisma;

    // Une réservation ou un hold actif sans table réserve la capacité globale
    // du restaurant. Toutes les allocations (waiting-list, walk-in, legacy et
    // Connect) doivent respecter ce masque, pas uniquement le chemin agentic.
    if (tx) {
      await this.lockRestaurantCapacity(tx, input.restaurantId);
    }
    if (await this.hasGlobalCapacityConflict(input, tx)) {
      return null;
    }

    const tables = await this.findCandidateTables(input, tx);

    for (const table of tables) {
      // Verrouiller la ligne table pour éviter l'allocation concurrente.
      // SKIP LOCKED permet de passer à la candidate suivante si déjà verrouillée.
      // En mode lecture seule (dry-run), on saute le verrouillage pessimiste
      // pour ne pas bloquer les allocations concurrentes.
      if (!options?.readOnly) {
        const locked = await prisma.$queryRaw<{ id: string }[]>(
          Prisma.sql`SELECT id FROM floor_plan_tables WHERE id = ${table.id} FOR UPDATE SKIP LOCKED`,
        );

        if (!locked || locked.length === 0) {
          continue;
        }
      }

      const available = await this.isTableAvailable(
        {
          tableId: table.id,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          excludeReservationId: input.excludeReservationId,
        },
        tx,
      );
      if (available) {
        return table;
      }
    }

    return null;
  }

  /**
   * Prévisualise les meilleures tables disponibles (top `limit`) avec score et
   * raisons, SANS verrouiller les tables. Lecture seule — pour l'affichage
   * explicable dans le dashboard. L'attribution autoritaire reste
   * `assign-table`/`reallocate` (verrou + revalidation).
   */
  async suggest(input: AllocateTableInput, limit = 3): Promise<AllocationSuggestion[]> {
    const tables = await this.findCandidateTables(input);
    const suggestions: AllocationSuggestion[] = [];

    for (const table of tables) {
      const available = await this.isTableAvailable(
        { tableId: table.id, startsAt: input.startsAt, endsAt: input.endsAt },
        undefined,
      );
      if (!available) continue;

      suggestions.push({
        table: {
          id: table.id,
          name: table.name,
          capacity: table.capacity,
          minCapacity: table.minCapacity,
          sectionId: table.sectionId ?? null,
        },
        score: this.scoreCandidate(table, input),
        reasons: this.buildCandidateReasons(table, input),
      });

      if (suggestions.length >= limit) break;
    }

    // Tri décroissant par score (meilleur fit en premier). L'ordre de la query
    // (capacity asc) est déjà quasi-optimal, mais le score explicite rend le
    // classement stable et lisible côté UI.
    suggestions.sort((a, b) => b.score - a.score);
    return suggestions;
  }

  /**
   * Vérifie qu'une table est disponible sur un créneau donné.
   * Permet d'exclure une réservation ou un hold spécifique (utile pour
   * reallocation ou tests).
   */
  async isTableAvailable(
    check: TableAvailabilityCheck,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const [hasReservationConflict, hasHoldConflict] = await Promise.all([
      this.hasConflictingReservation(check, tx),
      this.hasConflictingHold(check, tx),
    ]);

    return !hasReservationConflict && !hasHoldConflict;
  }

  /**
   * Libère la table d'une réservation (met tableId à null).
   */
  async releaseTable(reservationId: string): Promise<void> {
    const released = await this.prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUniqueOrThrow({
        where: { id: reservationId },
        select: { id: true, restaurantId: true, tableId: true, state: true, status: true },
      });

      if (!reservation.tableId) return { ...reservation, hadTable: false };

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { tableId: null },
      });
      await tx.reservationAuditLog.create({
        data: {
          event: 'reservation_table_released',
          reservationId,
          actor: 'dashboard:table-allocation',
          fromState: reservation.state,
          toState: reservation.state,
          metadata: { tableId: reservation.tableId },
        },
      });
      return { ...updated, restaurantId: reservation.restaurantId, hadTable: true };
    });
    if (released.hadTable) {
      await CapacityAwareAvailabilityService.invalidateAvailability(released.restaurantId);
    }
    observeReservationMutation({
      source: 'dashboard',
      operation: 'release',
      status: released.status,
      state: released.state,
      idempotency: 'not_applicable',
      audit: released.hadTable ? 'written' : 'not_applicable',
      notification: 'not_applicable',
      // Détacher une table ne libère pas nécessairement la réservation :
      // findBlockingReservation peut encore la considérer active au créneau.
      capacity: 'not_released',
    });
  }

  /**
   * Réassigne une réservation à une autre table.
   * Vérifie la disponibilité avant de mettre à jour.
   */
  async reallocate(
    restaurantId: string,
    reservationId: string,
    newTableId: string,
  ): Promise<Reservation> {
    const reservation = await this.prisma.reservation.findUniqueOrThrow({
      where: { id: reservationId },
    });
    if (reservation.restaurantId !== restaurantId) {
      throw new TableAllocationError('RESERVATION_NOT_FOUND', 'Reservation not found');
    }

    const table = await this.prisma.table.findUniqueOrThrow({
      where: { id: newTableId },
      include: { floorPlan: true },
    });
    if (table.floorPlan.restaurantId !== restaurantId) {
      throw new TableAllocationError('TABLE_NOT_FOUND', 'Table not found');
    }

    if (table.floorPlan.restaurantId !== reservation.restaurantId) {
      throw new TableAllocationError(
        'TABLE_RESTAURANT_MISMATCH',
        'Table and reservation belong to different restaurants',
      );
    }

    if (!table.isActive) {
      throw new TableAllocationError('TABLE_NOT_ACTIVE', 'Table is not active');
    }

    if (table.capacity < reservation.partySize) {
      throw new TableAllocationError(
        'TABLE_CAPACITY_TOO_SMALL',
        'Capacity too small for party size',
      );
    }

    if (table.minCapacity > reservation.partySize) {
      throw new TableAllocationError(
        'TABLE_MIN_CAPACITY_TOO_HIGH',
        'Party size is below the table minimum capacity',
      );
    }

    if (!reservation.startsAt || !reservation.endsAt) {
      throw new TableAllocationError('RESERVATION_TIMES_MISSING', 'Reservation times are missing');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockRestaurantCapacity(tx, reservation.restaurantId);
      if (
        await this.hasGlobalCapacityConflict(
          {
            restaurantId: reservation.restaurantId,
            partySize: reservation.partySize,
            startsAt: reservation.startsAt as Date,
            endsAt: reservation.endsAt as Date,
            excludeReservationId: reservation.id,
            tableId: newTableId,
          },
          tx,
        )
      ) {
        throw new TableAllocationError('TABLE_NOT_AVAILABLE', 'Le créneau est bloqué globalement');
      }

      const locked = await this.lockTable(tx, newTableId);
      if (!locked) {
        throw new TableAllocationError('TABLE_NOT_AVAILABLE', 'Target table is not available');
      }

      const available = await this.isTableAvailable(
        {
          tableId: newTableId,
          startsAt: reservation.startsAt as Date,
          endsAt: reservation.endsAt as Date,
          excludeReservationId: reservationId,
        },
        tx,
      );

      if (!available) {
        throw new TableAllocationError('TABLE_NOT_AVAILABLE', 'Target table is not available');
      }

      const updated = await tx.reservation.update({
        where: { id: reservationId },
        data: { tableId: newTableId },
      });
      await tx.reservationAuditLog.create({
        data: {
          event: 'reservation_table_reallocated',
          reservationId,
          actor: 'dashboard:table-allocation',
          fromState: reservation.state,
          toState: reservation.state,
          metadata: {
            previousTableId: reservation.tableId,
            newTableId,
          },
        },
      });
      return updated;
    });

    await CapacityAwareAvailabilityService.invalidateAvailability(reservation.restaurantId);
    observeReservationMutation({
      source: 'dashboard',
      operation: 'reallocate',
      status: updated.status,
      state: updated.state,
      idempotency: 'not_applicable',
      audit: 'written',
      notification: 'not_applicable',
      capacity: 'unchanged',
    });
    return updated;
  }

  /**
   * Vérifie qu'une table est utilisable pour un placement (SEATED / walk-in).
   * Lance TableAllocationError si la table est introuvable, inactive, trop
   * petite, verrouillée par une autre opération, ou déjà occupée sur le créneau.
   */
  async assertTableAvailableForSeating(
    args: {
      restaurantId: string;
      tableId: string;
      partySize: number;
      startsAt: Date;
      endsAt: Date;
      excludeReservationId?: string;
    },
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await this.lockRestaurantCapacity(tx, args.restaurantId);
    if (
      await this.hasGlobalCapacityConflict(
        {
          restaurantId: args.restaurantId,
          partySize: args.partySize,
          startsAt: args.startsAt,
          endsAt: args.endsAt,
          excludeReservationId: args.excludeReservationId,
          tableId: args.tableId,
        },
        tx,
      )
    ) {
      throw new TableAllocationError('TABLE_NOT_AVAILABLE', 'Le créneau est bloqué globalement');
    }

    const table = await tx.table.findFirst({
      where: { id: args.tableId, floorPlan: { restaurantId: args.restaurantId } },
      select: { id: true, isActive: true, capacity: true, minCapacity: true },
    });

    if (!table) {
      throw new TableAllocationError('TABLE_NOT_FOUND', 'Table introuvable');
    }
    if (!table.isActive) {
      throw new TableAllocationError('TABLE_NOT_ACTIVE', 'Table inactive');
    }
    if (table.capacity < args.partySize) {
      throw new TableAllocationError('TABLE_CAPACITY_TOO_SMALL', 'Capacité insuffisante');
    }
    if (table.minCapacity > args.partySize) {
      throw new TableAllocationError(
        'TABLE_MIN_CAPACITY_TOO_HIGH',
        'Party size below table minimum',
      );
    }

    const locked = await this.lockTable(tx, args.tableId);
    if (!locked) {
      throw new TableAllocationError(
        'TABLE_NOT_AVAILABLE',
        'Table verrouillée par une autre opération',
      );
    }

    const available = await this.isTableAvailable(
      {
        tableId: args.tableId,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        excludeReservationId: args.excludeReservationId,
      },
      tx,
    );

    if (!available) {
      throw new TableAllocationError('TABLE_NOT_AVAILABLE', 'Table non disponible sur ce créneau');
    }
  }

  /**
   * Sélectionne les tables candidates (actives, capacité/minCapacity compatibles,
   * exclusions), triées best-fit. Partagé par `allocate` et `suggest`.
   */
  private async findCandidateTables(
    input: AllocateTableInput,
    tx?: Prisma.TransactionClient,
  ): Promise<Table[]> {
    const prisma = tx ?? this.prisma;

    const capacityFilter = {
      isActive: true,
      capacity: { gte: input.partySize },
      minCapacity: { lte: input.partySize },
      ...(input.excludeTableIds && input.excludeTableIds.length > 0
        ? { id: { notIn: input.excludeTableIds } }
        : {}),
    } as const;

    if (input.preferredSectionId) {
      const preferred = await prisma.table.findMany({
        where: {
          sectionId: input.preferredSectionId,
          floorPlan: { restaurantId: input.restaurantId, isActive: true },
          ...capacityFilter,
        },
        orderBy: [{ capacity: 'asc' }, { minCapacity: 'asc' }, { name: 'asc' }],
      });

      // Fallback : si la section préférée n'a aucune table compatible (capacité
      // ou toutes occupées), retomber sur le plan par défaut plutôt que de
      // renvoyer null. On marque `fromPreferredSectionFallback` pour que
      // `suggest` puisse l'expliquer dans les raisons.
      const floorPlan = await prisma.floorPlan.findFirst({
        where: { restaurantId: input.restaurantId, isActive: true, isDefault: true },
        select: { id: true },
      });
      if (!floorPlan) {
        return preferred;
      }
      const fallback = await prisma.table.findMany({
        where: {
          floorPlanId: floorPlan.id,
          ...capacityFilter,
          ...(preferred.length > 0 ? { id: { notIn: preferred.map((t) => t.id) } } : {}),
        },
        orderBy: [{ capacity: 'asc' }, { minCapacity: 'asc' }, { name: 'asc' }],
      });
      return [...preferred, ...fallback];
    }

    const floorPlan = await prisma.floorPlan.findFirst({
      where: { restaurantId: input.restaurantId, isActive: true, isDefault: true },
      select: { id: true },
    });
    if (!floorPlan) {
      return [];
    }

    return prisma.table.findMany({
      where: { floorPlanId: floorPlan.id, ...capacityFilter },
      orderBy: [{ capacity: 'asc' }, { minCapacity: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Score d'une candidate : plus la table est proche du nombre de couverts,
   * plus le score est élevé. Une table de la section préférée (si fournie) est
   * favorisée. Le score n'est qu'un ordre de tri — les `reasons` portent le
   * sens métier affiché.
   */
  private scoreCandidate(table: Table, input: AllocateTableInput): number {
    let score = 100 - (table.capacity - input.partySize) * 10;
    if (input.preferredSectionId && table.sectionId === input.preferredSectionId) {
      score += 15;
    }
    return score;
  }

  /**
   * Raisons FR (vouvoiement) expliquant la proposition, affichées telles quelles.
   */
  private buildCandidateReasons(table: Table, input: AllocateTableInput): string[] {
    const reasons: string[] = [];
    const spare = table.capacity - input.partySize;
    if (spare === 0) {
      reasons.push(`Capacité exacte pour ${input.partySize} couverts`);
    } else {
      reasons.push(`Table de ${table.capacity} couverts pour ${input.partySize} personnes`);
    }
    if (input.preferredSectionId && table.sectionId === input.preferredSectionId) {
      reasons.push('Dans votre section préférée');
    }
    if (spare === 0) {
      reasons.push('Optimise votre remplissage');
    }
    return reasons;
  }

  private async hasConflictingReservation(
    check: TableAvailabilityCheck,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const prisma = tx ?? this.prisma;
    const excludeClause = check.excludeReservationId
      ? Prisma.sql`AND r.id != ${check.excludeReservationId}`
      : Prisma.empty;
    const rows = await prisma.$queryRaw<Array<{ exists: number }>>(
      Prisma.sql`
        SELECT 1 as exists
        FROM reservations r
        LEFT JOIN restaurant_exposure_settings settings ON settings.restaurant_id = r.restaurant_id
        WHERE r.table_id = ${check.tableId}
          AND r.is_test = false
          AND r.state IN ('PENDING', 'CONFIRMED', 'SEATED')
          AND tsrange(
            COALESCE(r.starts_at, r.reserved_at),
            COALESCE(r.ends_at, COALESCE(r.starts_at, r.reserved_at) +
              INTERVAL '1 minute' * CASE
                WHEN CASE WHEN jsonb_typeof(settings.capacity_specials->'serviceDurationMinutes') = 'number'
                  THEN (settings.capacity_specials->>'serviceDurationMinutes')::numeric > 0 ELSE false END
                  THEN (settings.capacity_specials->>'serviceDurationMinutes')::double precision
                WHEN CASE WHEN jsonb_typeof(settings.capacity_specials->'defaultServiceDurationMinutes') = 'number'
                  THEN (settings.capacity_specials->>'defaultServiceDurationMinutes')::numeric > 0 ELSE false END
                  THEN (settings.capacity_specials->>'defaultServiceDurationMinutes')::double precision
                ELSE 120
              END)
          ) && tsrange(
            CAST(${check.startsAt} AS timestamptz) AT TIME ZONE 'UTC',
            CAST(${check.endsAt} AS timestamptz) AT TIME ZONE 'UTC'
          )
          ${excludeClause}
        LIMIT 1
      `,
    );
    return rows.length > 0 && Number(rows[0].exists) === 1;
  }

  /**
   * Conflit de placement pour un groupe sans table fixée : même verdict que la création et la
   * disponibilité (voir unassigned-seating.ts).
   */
  async hasGlobalCapacityConflict(
    input: AllocateTableInput & { tableId?: string | null },
    tx?: Prisma.TransactionClient,
    excludeHoldId?: string,
  ): Promise<boolean> {
    const { conflict } = await findUnassignedSeatingConflict(tx ?? this.prisma, {
      restaurantId: input.restaurantId,
      partySize: input.partySize,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      tableId: input.tableId ?? null,
      now: new Date(),
      excludeReservationId: input.excludeReservationId,
      excludeHoldId: excludeHoldId ?? null,
    });
    return conflict;
  }

  async lockRestaurantCapacity(tx: Prisma.TransactionClient, restaurantId: string): Promise<void> {
    const query = Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${restaurantId}, 0))`;
    // Les doubles Prisma historiques des tests n'exposent que $queryRaw ; le
    // client réel utilise $executeRaw, qui ne tente pas de désérialiser le
    // retour void de pg_advisory_xact_lock.
    if (typeof tx.$executeRaw === 'function') {
      await tx.$executeRaw(query);
      return;
    }
    await tx.$queryRaw(query);
  }

  private async hasConflictingHold(
    check: TableAvailabilityCheck,
    tx?: Prisma.TransactionClient,
  ): Promise<boolean> {
    const prisma = tx ?? this.prisma;
    const excludeClause = check.excludeHoldId
      ? Prisma.sql`AND id != ${check.excludeHoldId}`
      : Prisma.empty;
    const rows = await prisma.$queryRaw<Array<{ exists: number }>>(
      Prisma.sql`
        SELECT 1 as exists
        FROM agentic_holds
        WHERE table_id = ${check.tableId}
          AND status = 'ACTIVE'
          AND expires_at > NOW() AT TIME ZONE 'UTC'
          AND slot_start IS NOT NULL
          AND slot_end IS NOT NULL
          AND tsrange(slot_start, slot_end) && tsrange(
            CAST(${check.startsAt} AS timestamptz) AT TIME ZONE 'UTC',
            CAST(${check.endsAt} AS timestamptz) AT TIME ZONE 'UTC'
          )
          ${excludeClause}
        LIMIT 1
      `,
    );
    return rows.length > 0 && Number(rows[0].exists) === 1;
  }

  /**
   * Verrouille une table avec SELECT FOR UPDATE (sans SKIP LOCKED).
   * Renvoie true si la table a été verrouillée, false si elle est déjà verrouillée.
   */
  async lockTable(tx: Prisma.TransactionClient, tableId: string): Promise<boolean> {
    const locked = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM floor_plan_tables WHERE id = ${tableId} FOR UPDATE`,
    );
    return locked && locked.length > 0;
  }
}

export class TableAllocationError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TableAllocationError';
  }
}
