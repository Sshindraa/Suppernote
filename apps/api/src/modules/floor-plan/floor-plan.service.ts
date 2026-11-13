import { Prisma } from '@prisma/client';
import type {
  PrismaClient,
  Section,
  Table,
  TableCombination,
  Wall,
  FloorPlanZone,
} from '@prisma/client';
import {
  CapacityAwareAvailabilityService,
  zonedTimeToUtc,
} from './availability-capacity-aware.service.js';
import { resolveServiceDurationMinutes } from './floor-plan.types.js';
import { TableAllocationError, TableAllocationService } from './table-allocation.service.js';
import { observeReservationMutation } from '../../shared/observability/reservation-contract';
import { creationProjection } from '../../shared/reservations/reservation-state';
import { isReservationOverlapViolation } from '../../shared/reservations/overlap-violation';

/** Capacité minimale par défaut d'une table (1 personne) */
const DEFAULT_TABLE_MIN_CAPACITY = 1;

export class FloorPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloorPlanValidationError';
  }
}

export class FloorPlanNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FloorPlanNotFoundError';
  }
}

const FLOOR_PLAN_INCLUDE = {
  sections: {
    orderBy: { position: 'asc' },
    include: {
      tables: { orderBy: [{ positionX: 'asc' }, { positionY: 'asc' }, { name: 'asc' }] },
    },
  },
  tables: {
    orderBy: [{ positionX: 'asc' }, { positionY: 'asc' }, { name: 'asc' }],
  },
  walls: { orderBy: { createdAt: 'asc' } },
  zones: {
    orderBy: [{ sectionId: 'asc' }, { name: 'asc' }],
    include: { section: { select: { id: true, name: true } } },
  },
  tableCombinations: {
    orderBy: { createdAt: 'asc' },
    include: { members: { select: { tableId: true } } },
  },
} satisfies Prisma.FloorPlanInclude;

export type FloorPlanWithSections = {
  id: string;
  name: string;
  width: number;
  height: number;
  restaurantId: string;
  isDefault: boolean;
  isActive: boolean;
  sections: Array<
    Section & {
      tables: Table[];
    }
  >;
  tables: Table[];
  walls: Wall[];
  zones: Array<FloorPlanZone & { section: { id: string; name: string } | null }>;
  tableCombinations: Array<
    Pick<TableCombination, 'id' | 'floorPlanId' | 'name' | 'createdAt' | 'updatedAt'> & {
      members: Array<{ tableId: string }>;
    }
  >;
};

export type FloorPlanSummary = {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  tableCount: number;
};

export type PlanningReservation = {
  id: string;
  tableId: string | null;
  tableName: string | null;
  sectionName: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  partySize: number;
  customerName: string | null;
  state: string;
  seatedAt: Date | null;
};

export type CreateSectionInput = {
  name: string;
  position?: number;
};

export type UpdateSectionInput = Partial<CreateSectionInput>;

export type CreateTableInput = {
  id?: string;
  sectionId?: string | null;
  name: string;
  capacity: number;
  minCapacity?: number;
  positionX?: number | null;
  positionY?: number | null;
  width?: number | null;
  height?: number | null;
  rotation?: number;
  shape?: string;
  assignedServer?: string | null;
};

export type UpdateTableInput = Omit<Partial<CreateTableInput>, 'id'> & {
  isActive?: boolean;
};

export type CreateFloorPlanInput = {
  name: string;
  isDefault?: boolean;
};

export type UpdateFloorPlanInput = Partial<CreateFloorPlanInput> & {
  isActive?: boolean;
  width?: number;
  height?: number;
};

export type CreateWallInput = {
  id?: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type?: string;
  name?: string | null;
};

export type UpdateWallInput = Omit<Partial<CreateWallInput>, 'id'>;

export type CreateZoneInput = {
  id?: string;
  name: string;
  sectionId?: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
};

export type UpdateZoneInput = Omit<Partial<CreateZoneInput>, 'id'>;

export type CreateTableCombinationInput = {
  tableIds: string[];
  name?: string | null;
};

export class FloorPlanService {
  private readonly tableAllocation: TableAllocationService;

  constructor(private readonly prisma: PrismaClient) {
    this.tableAllocation = new TableAllocationService(prisma);
  }

  async getDefaultFloorPlan(
    restaurantId: string,
    options?: { name?: string },
  ): Promise<FloorPlanWithSections> {
    const existing = await this.prisma.floorPlan.findFirst({
      where: { restaurantId, isActive: true, isDefault: true },
      include: FLOOR_PLAN_INCLUDE,
    });

    if (existing) {
      return existing as unknown as FloorPlanWithSections;
    }

    const created = await this.prisma.floorPlan.create({
      data: {
        restaurantId,
        name: options?.name ?? 'Salle principale',
        width: 1400,
        height: 900,
        isDefault: true,
        isActive: true,
      },
      include: FLOOR_PLAN_INCLUDE,
    });

    return created as unknown as FloorPlanWithSections;
  }

  async getOrCreateFloorPlan(restaurantId: string): Promise<FloorPlanWithSections> {
    return this.getDefaultFloorPlan(restaurantId);
  }

  async listFloorPlans(restaurantId: string): Promise<FloorPlanSummary[]> {
    const rows = await this.prisma.floorPlan.findMany({
      where: { restaurantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        isDefault: true,
        isActive: true,
        _count: { select: { tables: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      isDefault: row.isDefault,
      isActive: row.isActive,
      tableCount: row._count.tables,
    }));
  }

  async getFloorPlanById(
    restaurantId: string,
    floorPlanId: string,
  ): Promise<FloorPlanWithSections> {
    const floorPlan = await this.prisma.floorPlan.findFirst({
      where: { id: floorPlanId, restaurantId },
      include: FLOOR_PLAN_INCLUDE,
    });

    if (!floorPlan) {
      throw new FloorPlanNotFoundError('Floor plan introuvable');
    }

    return floorPlan as unknown as FloorPlanWithSections;
  }

  async createFloorPlan(
    restaurantId: string,
    input: CreateFloorPlanInput,
  ): Promise<FloorPlanWithSections> {
    const isDefault = input.isDefault ?? false;

    const created = await this.prisma.$transaction(async (tx) => {
      if (isDefault) {
        await tx.floorPlan.updateMany({
          where: { restaurantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.floorPlan.create({
        data: {
          restaurantId,
          name: input.name,
          width: 1400,
          height: 900,
          isDefault,
          isActive: true,
        },
        include: FLOOR_PLAN_INCLUDE,
      });
    });

    return created as unknown as FloorPlanWithSections;
  }

  async updateFloorPlanById(
    restaurantId: string,
    floorPlanId: string,
    input: UpdateFloorPlanInput,
  ): Promise<FloorPlanWithSections> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.floorPlan.findFirst({
        where: { id: floorPlanId, restaurantId },
      });
      if (!existing) {
        throw new FloorPlanNotFoundError('Floor plan introuvable');
      }

      if (input.isDefault) {
        await tx.floorPlan.updateMany({
          where: { restaurantId: existing.restaurantId, isDefault: true, id: { not: floorPlanId } },
          data: { isDefault: false },
        });
      }

      return tx.floorPlan.update({
        where: { id: floorPlanId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.width !== undefined && { width: input.width }),
          ...(input.height !== undefined && { height: input.height }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
        },
        include: FLOOR_PLAN_INCLUDE,
      });
    });

    return updated as unknown as FloorPlanWithSections;
  }

  async updateFloorPlan(
    restaurantId: string,
    input: UpdateFloorPlanInput,
  ): Promise<FloorPlanWithSections> {
    const floorPlan = await this.getDefaultFloorPlan(restaurantId);
    return this.updateFloorPlanById(restaurantId, floorPlan.id, input);
  }

  async deleteFloorPlan(restaurantId: string, floorPlanId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const floorPlan = await tx.floorPlan.findFirst({
        where: { id: floorPlanId, restaurantId },
      });
      if (!floorPlan) {
        throw new FloorPlanNotFoundError('Floor plan introuvable');
      }

      if (floorPlan.isDefault) {
        const replacement = await tx.floorPlan.findFirst({
          where: { restaurantId: floorPlan.restaurantId, id: { not: floorPlanId }, isActive: true },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (replacement) {
          await tx.floorPlan.update({
            where: { id: replacement.id },
            data: { isDefault: true, isActive: true },
          });
        }
      }

      await tx.floorPlan.delete({ where: { id: floorPlanId } });
    });
  }

  private async resolveFloorPlanId(restaurantId: string, floorPlanId?: string): Promise<string> {
    if (floorPlanId) {
      const floorPlan = await this.prisma.floorPlan.findFirst({
        where: { id: floorPlanId, restaurantId, isActive: true },
        select: { id: true },
      });
      if (!floorPlan) {
        throw new FloorPlanNotFoundError('Floor plan introuvable');
      }
      return floorPlan.id;
    }

    const floorPlan = await this.getDefaultFloorPlan(restaurantId);
    return floorPlan.id;
  }

  async createSection(
    restaurantId: string,
    input: CreateSectionInput,
    floorPlanId?: string,
  ): Promise<Section> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const floorPlan = await this.prisma.floorPlan.findUnique({
      where: { id: resolvedFloorPlanId },
      include: { sections: { orderBy: { position: 'asc' } } },
    });
    if (!floorPlan) {
      throw new FloorPlanNotFoundError('Floor plan introuvable');
    }
    const position = input.position ?? floorPlan.sections.length;

    return this.prisma.section.create({
      data: {
        floorPlanId: resolvedFloorPlanId,
        name: input.name,
        position,
      },
    });
  }

  async updateSection(
    restaurantId: string,
    sectionId: string,
    input: UpdateSectionInput,
    floorPlanId?: string,
  ): Promise<Section> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, floorPlanId: resolvedFloorPlanId },
    });
    if (!section) {
      throw new FloorPlanNotFoundError('Section introuvable');
    }

    return this.prisma.section.update({
      where: { id: sectionId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.position !== undefined && { position: input.position }),
      },
    });
  }

  async deleteSection(
    restaurantId: string,
    sectionId: string,
    floorPlanId?: string,
  ): Promise<void> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, floorPlanId: resolvedFloorPlanId },
    });
    if (!section) {
      throw new FloorPlanNotFoundError('Section introuvable');
    }

    await this.prisma.section.delete({ where: { id: sectionId } });
  }

  async createTable(
    restaurantId: string,
    input: CreateTableInput,
    floorPlanId?: string,
  ): Promise<Table> {
    this.validateTable(input);

    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);

    if (input.sectionId) {
      const section = await this.prisma.section.findFirst({
        where: { id: input.sectionId, floorPlanId: resolvedFloorPlanId },
      });
      if (!section) {
        throw new FloorPlanNotFoundError('Section introuvable');
      }
    }

    const data = {
      floorPlanId: resolvedFloorPlanId,
      sectionId: input.sectionId ?? null,
      name: input.name,
      capacity: input.capacity,
      minCapacity: input.minCapacity ?? DEFAULT_TABLE_MIN_CAPACITY,
      positionX: input.positionX ?? null,
      positionY: input.positionY ?? null,
      width: input.width ?? null,
      height: input.height ?? null,
      rotation: input.rotation ?? 0,
      shape: input.shape ?? 'rect',
      assignedServer: input.assignedServer ?? null,
    };

    if (!input.id) return this.prisma.table.create({ data });

    const table = await this.prisma.table.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: {},
    });
    if (table.floorPlanId !== resolvedFloorPlanId) {
      throw new FloorPlanNotFoundError('Table introuvable');
    }
    return table;
  }

  async updateTable(
    restaurantId: string,
    tableId: string,
    input: UpdateTableInput,
    floorPlanId?: string,
  ): Promise<Table> {
    this.validateTable(input);

    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const table = await this.prisma.table.findFirst({
      where: { id: tableId, floorPlanId: resolvedFloorPlanId },
    });
    if (!table) {
      throw new FloorPlanNotFoundError('Table introuvable');
    }

    if (input.sectionId !== undefined && input.sectionId !== null) {
      const section = await this.prisma.section.findFirst({
        where: { id: input.sectionId, floorPlanId: resolvedFloorPlanId },
      });
      if (!section) {
        throw new FloorPlanNotFoundError('Section introuvable');
      }
    }

    return this.prisma.table.update({
      where: { id: tableId },
      data: {
        ...(input.sectionId !== undefined && { sectionId: input.sectionId ?? null }),
        ...(input.name !== undefined && { name: input.name }),
        ...(input.capacity !== undefined && { capacity: input.capacity }),
        ...(input.minCapacity !== undefined && { minCapacity: input.minCapacity }),
        ...(input.positionX !== undefined && { positionX: input.positionX ?? null }),
        ...(input.positionY !== undefined && { positionY: input.positionY ?? null }),
        ...(input.width !== undefined && { width: input.width ?? null }),
        ...(input.height !== undefined && { height: input.height ?? null }),
        ...(input.rotation !== undefined && { rotation: input.rotation }),
        ...(input.shape !== undefined && { shape: input.shape }),
        ...(input.assignedServer !== undefined && { assignedServer: input.assignedServer ?? null }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
      },
    });
  }

  async deleteTable(restaurantId: string, tableId: string, floorPlanId?: string): Promise<void> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const table = await this.prisma.table.findFirst({
      where: { id: tableId, floorPlanId: resolvedFloorPlanId },
      include: {
        reservations: {
          where: {
            isTest: false,
            startsAt: { gte: new Date() },
            state: { in: ['PENDING', 'CONFIRMED', 'SEATED'] },
          },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!table) {
      throw new FloorPlanNotFoundError('Table introuvable');
    }

    if (table.reservations.length > 0) {
      await this.prisma.table.update({
        where: { id: tableId },
        data: { isActive: false },
      });
      return;
    }

    await this.prisma.table.delete({ where: { id: tableId } });
  }

  async getPlanning(
    restaurantId: string,
    date: string,
    floorPlanId?: string,
  ): Promise<PlanningReservation[]> {
    let floorPlan: FloorPlanWithSections;
    if (floorPlanId) {
      const found = await this.prisma.floorPlan.findFirst({
        where: { id: floorPlanId, restaurantId },
        include: FLOOR_PLAN_INCLUDE,
      });
      if (!found) {
        throw new FloorPlanNotFoundError('Floor plan introuvable');
      }
      floorPlan = found as unknown as FloorPlanWithSections;
    } else {
      floorPlan = await this.getDefaultFloorPlan(restaurantId);
    }

    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { timezone: true },
    });
    const timeZone = restaurant?.timezone ?? 'Europe/Paris';
    const start = zonedTimeToUtc(date, '00:00', timeZone);
    const end = zonedTimeToUtc(date, '23:59:59.999', timeZone);

    const reservations = await this.prisma.reservation.findMany({
      where: {
        restaurantId,
        startsAt: { gte: start, lte: end },
        state: { in: ['PENDING', 'CONFIRMED', 'SEATED'] },
      },
      select: {
        id: true,
        tableId: true,
        startsAt: true,
        endsAt: true,
        partySize: true,
        customerName: true,
        state: true,
      },
      orderBy: { startsAt: 'asc' },
    });

    const tableMap = new Map(floorPlan.tables.map((t) => [t.id, t]));
    const sectionMap = new Map(floorPlan.sections.map((s) => [s.id, s]));

    const seatedLogs = await this.prisma.reservationAuditLog.findMany({
      where: {
        reservationId: { in: reservations.map((r) => r.id) },
        event: 'reservation_seated',
      },
      orderBy: { createdAt: 'asc' },
      select: { reservationId: true, createdAt: true },
    });
    const seatedAtByReservation = new Map<string, Date>();
    for (const log of seatedLogs) {
      if (log.reservationId && !seatedAtByReservation.has(log.reservationId)) {
        seatedAtByReservation.set(log.reservationId, log.createdAt);
      }
    }

    return reservations.map((r) => {
      const table = r.tableId ? (tableMap.get(r.tableId) ?? null) : null;
      const section = table?.sectionId ? (sectionMap.get(table.sectionId) ?? null) : null;
      return {
        id: r.id,
        tableId: r.tableId,
        tableName: table?.name ?? null,
        sectionName: section?.name ?? null,
        startsAt: r.startsAt,
        endsAt: r.endsAt,
        partySize: r.partySize,
        customerName: r.customerName,
        state: r.state,
        seatedAt: seatedAtByReservation.get(r.id) ?? null,
      };
    });
  }

  async createWalkIn(args: {
    restaurantId: string;
    tableId: string;
    partySize: number;
    customerName?: string;
    idempotencyKey: string;
  }): Promise<{ id: string }> {
    const now = new Date();
    // Même durée de repas que le moteur de disponibilités : la table reste bloquée au téléphone, en
    // ligne et sur MCP exactement le temps qu'un repas réservé la bloquerait.
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: args.restaurantId },
      select: { exposureSettings: { select: { capacitySpecials: true } } },
    });
    const serviceDurationMinutes = resolveServiceDurationMinutes(
      restaurant?.exposureSettings?.capacitySpecials,
    );
    const endsAt = new Date(now.getTime() + serviceDurationMinutes * 60 * 1000);
    const idempotencyScope = 'walk-in';
    const payloadHash = `${args.restaurantId}:${args.tableId}:${args.idempotencyKey}`;
    let replayed = false;
    let createdStatus: string | undefined;
    let createdState: string | undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      await this.tableAllocation.assertTableAvailableForSeating(
        {
          restaurantId: args.restaurantId,
          tableId: args.tableId,
          partySize: args.partySize,
          startsAt: now,
          endsAt,
        },
        tx,
      );

      try {
        const reservation = await tx.reservation.create({
          data: {
            restaurantId: args.restaurantId,
            tableId: args.tableId,
            partySize: args.partySize,
            customerName: args.customerName ?? 'Sans réservation',
            reservedAt: now,
            channel: 'API',
            ...creationProjection('SEATED'),
            startsAt: now,
            endsAt,
            createdByClient: args.restaurantId,
            idempotencyScope,
            idempotencyKey: args.idempotencyKey,
            idempotencyPayloadHash: payloadHash,
            source: 'WALK_IN',
          },
        });
        createdStatus = reservation.status;
        createdState = reservation.state;

        await tx.reservationAuditLog.create({
          data: {
            event: 'reservation_seated',
            reservationId: reservation.id,
            actor: args.restaurantId,
            // Une création walk-in n'est pas une transition PENDING → SEATED:
            // aucune réservation n'existait avant l'INSERT.
            fromState: null,
            toState: 'SEATED',
            metadata: { source: 'WALK_IN' },
          },
        });

        return { id: reservation.id };
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const existing = await tx.reservation.findFirst({
            where: { idempotencyScope, idempotencyKey: args.idempotencyKey },
            select: { id: true },
          });
          if (existing) {
            replayed = true;
            return { id: existing.id };
          }
        }
        if (isReservationOverlapViolation(err)) {
          throw new TableAllocationError(
            'TABLE_NOT_AVAILABLE',
            'Table non disponible sur ce créneau',
          );
        }
        throw err;
      }
    });

    // La disponibilité est mise en cache : sans cela, la table resterait proposée jusqu'à 30 s.
    if (!replayed) {
      await CapacityAwareAvailabilityService.invalidateAvailability(args.restaurantId);
    }

    observeReservationMutation({
      source: 'walk_in',
      operation: replayed ? 'create_replay' : 'create',
      status: createdStatus,
      state: createdState,
      idempotency: replayed ? 'reused' : 'keyed',
      audit: replayed ? 'not_applicable' : 'written',
      notification: 'not_applicable',
      capacity: replayed ? 'unchanged' : 'reserved',
      mutated: !replayed,
    });
    return result;
  }

  async createWall(
    restaurantId: string,
    input: CreateWallInput,
    floorPlanId?: string,
  ): Promise<Wall> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);

    const data = {
      floorPlanId: resolvedFloorPlanId,
      x1: input.x1,
      y1: input.y1,
      x2: input.x2,
      y2: input.y2,
      type: input.type ?? 'wall',
      name: input.name ?? null,
    };

    if (!input.id) return this.prisma.wall.create({ data });

    const wall = await this.prisma.wall.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: {},
    });
    if (wall.floorPlanId !== resolvedFloorPlanId) {
      throw new FloorPlanNotFoundError('Mur introuvable');
    }
    return wall;
  }

  async updateWall(
    restaurantId: string,
    wallId: string,
    input: UpdateWallInput,
    floorPlanId?: string,
  ): Promise<Wall> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const wall = await this.prisma.wall.findFirst({
      where: { id: wallId, floorPlanId: resolvedFloorPlanId },
    });
    if (!wall) {
      throw new FloorPlanNotFoundError('Mur introuvable');
    }

    return this.prisma.wall.update({
      where: { id: wallId },
      data: {
        ...(input.x1 !== undefined && { x1: input.x1 }),
        ...(input.y1 !== undefined && { y1: input.y1 }),
        ...(input.x2 !== undefined && { x2: input.x2 }),
        ...(input.y2 !== undefined && { y2: input.y2 }),
        ...(input.type !== undefined && { type: input.type }),
        ...(input.name !== undefined && { name: input.name ?? null }),
      },
    });
  }

  async deleteWall(restaurantId: string, wallId: string, floorPlanId?: string): Promise<void> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const wall = await this.prisma.wall.findFirst({
      where: { id: wallId, floorPlanId: resolvedFloorPlanId },
    });
    if (!wall) {
      throw new FloorPlanNotFoundError('Mur introuvable');
    }

    await this.prisma.wall.delete({ where: { id: wallId } });
  }

  async createZone(
    restaurantId: string,
    input: CreateZoneInput,
    floorPlanId?: string,
  ): Promise<FloorPlanZone> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    this.validateZone(input);
    await this.assertSectionBelongsToFloorPlan(input.sectionId, resolvedFloorPlanId);

    const data = {
      floorPlanId: resolvedFloorPlanId,
      sectionId: input.sectionId ?? null,
      name: input.name.trim(),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      rotation: input.rotation ?? 0,
    };

    if (!input.id) return this.prisma.floorPlanZone.create({ data });

    const zone = await this.prisma.floorPlanZone.upsert({
      where: { id: input.id },
      create: { id: input.id, ...data },
      update: {},
    });
    if (zone.floorPlanId !== resolvedFloorPlanId) {
      throw new FloorPlanNotFoundError('Zone introuvable');
    }
    return zone;
  }

  async updateZone(
    restaurantId: string,
    zoneId: string,
    input: UpdateZoneInput,
    floorPlanId?: string,
  ): Promise<FloorPlanZone> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const zone = await this.prisma.floorPlanZone.findFirst({
      where: { id: zoneId, floorPlanId: resolvedFloorPlanId },
    });
    if (!zone) throw new FloorPlanNotFoundError('Zone introuvable');

    const nextZone = { ...zone, ...input };
    this.validateZone(nextZone);
    await this.assertSectionBelongsToFloorPlan(input.sectionId, resolvedFloorPlanId);

    return this.prisma.floorPlanZone.update({
      where: { id: zoneId },
      data: {
        ...(input.sectionId !== undefined && { sectionId: input.sectionId ?? null }),
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.x !== undefined && { x: input.x }),
        ...(input.y !== undefined && { y: input.y }),
        ...(input.width !== undefined && { width: input.width }),
        ...(input.height !== undefined && { height: input.height }),
        ...(input.rotation !== undefined && { rotation: input.rotation }),
      },
    });
  }

  async deleteZone(restaurantId: string, zoneId: string, floorPlanId?: string): Promise<void> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const zone = await this.prisma.floorPlanZone.findFirst({
      where: { id: zoneId, floorPlanId: resolvedFloorPlanId },
      select: { id: true },
    });
    if (!zone) throw new FloorPlanNotFoundError('Zone introuvable');
    await this.prisma.floorPlanZone.delete({ where: { id: zoneId } });
  }

  async createTableCombination(
    restaurantId: string,
    input: CreateTableCombinationInput,
    floorPlanId?: string,
  ): Promise<{ id: string; floorPlanId: string; name: string | null; tableIds: string[] }> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const tableIds = [...new Set(input.tableIds)];
    if (tableIds.length < 2) {
      throw new FloorPlanValidationError('Sélectionnez au moins deux tables combinables');
    }

    const tables = await this.prisma.table.findMany({
      where: { id: { in: tableIds }, floorPlanId: resolvedFloorPlanId, isActive: true },
      select: { id: true },
    });
    if (tables.length !== tableIds.length) {
      throw new FloorPlanNotFoundError('Une table sélectionnée est introuvable');
    }

    const existing = await this.prisma.tableCombination.findMany({
      where: { floorPlanId: resolvedFloorPlanId },
      include: { members: { select: { tableId: true } } },
    });
    const normalized = [...tableIds].sort().join(':');
    const duplicate = existing.find(
      (combination) =>
        combination.members
          .map((member) => member.tableId)
          .sort()
          .join(':') === normalized,
    );
    if (duplicate) {
      return {
        id: duplicate.id,
        floorPlanId: duplicate.floorPlanId,
        name: duplicate.name,
        tableIds,
      };
    }

    const created = await this.prisma.tableCombination.create({
      data: {
        floorPlanId: resolvedFloorPlanId,
        name: input.name?.trim() || null,
        members: { create: tableIds.map((tableId) => ({ tableId })) },
      },
      include: { members: { select: { tableId: true } } },
    });

    return {
      id: created.id,
      floorPlanId: created.floorPlanId,
      name: created.name,
      tableIds: created.members.map((member) => member.tableId),
    };
  }

  async deleteTableCombination(
    restaurantId: string,
    combinationId: string,
    floorPlanId?: string,
  ): Promise<void> {
    const resolvedFloorPlanId = await this.resolveFloorPlanId(restaurantId, floorPlanId);
    const combination = await this.prisma.tableCombination.findFirst({
      where: { id: combinationId, floorPlanId: resolvedFloorPlanId },
      select: { id: true },
    });
    if (!combination) throw new FloorPlanNotFoundError('Combinaison introuvable');
    await this.prisma.tableCombination.delete({ where: { id: combinationId } });
  }

  private validateZone(input: Partial<CreateZoneInput>): void {
    if (!input.name?.trim() || input.name.trim().length > 120) {
      throw new FloorPlanValidationError(
        'Le nom de la zone doit contenir entre 1 et 120 caractères',
      );
    }
    for (const [label, value] of [
      ['x', input.x],
      ['y', input.y],
      ['largeur', input.width],
      ['hauteur', input.height],
    ] as const) {
      if (!Number.isInteger(value)) {
        throw new FloorPlanValidationError(`La ${label} de la zone doit être un entier`);
      }
    }
    if ((input.width ?? 0) <= 0 || (input.height ?? 0) <= 0) {
      throw new FloorPlanValidationError('Les dimensions de la zone doivent être positives');
    }
    if (input.rotation !== undefined && !Number.isInteger(input.rotation)) {
      throw new FloorPlanValidationError('La rotation de la zone doit être un entier');
    }
  }

  private async assertSectionBelongsToFloorPlan(
    sectionId: string | null | undefined,
    floorPlanId: string,
  ): Promise<void> {
    if (!sectionId) return;
    const section = await this.prisma.section.findFirst({
      where: { id: sectionId, floorPlanId },
      select: { id: true },
    });
    if (!section) throw new FloorPlanNotFoundError('Section introuvable');
  }

  private validateTable(input: Partial<CreateTableInput>): void {
    if (input.capacity !== undefined) {
      const minCapacity = input.minCapacity ?? DEFAULT_TABLE_MIN_CAPACITY;
      if (input.capacity < minCapacity) {
        throw new FloorPlanValidationError(
          'La capacité doit être supérieure ou égale à la capacité minimale',
        );
      }
      if (input.capacity < DEFAULT_TABLE_MIN_CAPACITY) {
        throw new FloorPlanValidationError("La capacité doit être d'au moins 1");
      }
    }
    if (input.minCapacity !== undefined && input.minCapacity < 1) {
      throw new FloorPlanValidationError("La capacité minimale doit être d'au moins 1");
    }
  }
}
