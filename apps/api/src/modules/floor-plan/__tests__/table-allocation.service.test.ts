import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Table, Reservation, AgenticHold, PrismaClient } from '@prisma/client';
import { TableAllocationService, TableAllocationError } from '../table-allocation.service.js';
import { matchesWhere } from '../../../test/prisma-where';

type MockTable = Table & {
  section: { id: string; name: string; position: number } | null;
  floorPlan?: { id: string; restaurantId: string; isActive: boolean; isDefault: boolean } | null;
};

type MockReservation = Reservation;

type MockHold = AgenticHold;

const BLOCKING_RESERVATION_STATES = ['PENDING', 'CONFIRMED', 'SEATED'];

function makeMockPrisma(
  initial: {
    tables?: MockTable[];
    reservations?: MockReservation[];
    holds?: MockHold[];
  } = {},
) {
  const tables = new Map(initial.tables?.map((t) => [t.id, t]) ?? []);
  const reservations = new Map(initial.reservations?.map((r) => [r.id, r]) ?? []);
  const holds = new Map(initial.holds?.map((h) => [h.id, h]) ?? []);
  const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
  const floorPlanByRestaurant = new Map<
    string,
    { id: string; restaurantId: string; isActive: boolean; isDefault: boolean }
  >();
  for (const t of tables.values()) {
    const rId = t.floorPlan?.restaurantId;
    if (rId && !floorPlanByRestaurant.has(rId)) {
      floorPlanByRestaurant.set(rId, {
        id: t.floorPlan?.id ?? t.floorPlanId,
        restaurantId: rId,
        isActive: t.floorPlan?.isActive ?? true,
        isDefault: t.floorPlan?.isDefault ?? true,
      });
    }
  }

  const prisma = {
    restaurantExposureSettings: { findUnique: async () => null },
    restaurant: { findUnique: async () => ({ timezone: 'Europe/Paris' }) },
    floorPlan: {
      findFirst: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        const isActive = where.isActive as boolean | undefined;
        const isDefault = where.isDefault as boolean | undefined;
        const fp = floorPlanByRestaurant.get(restaurantId as string);
        if (!fp) return null;
        if (isActive === true && !fp.isActive) return null;
        if (isActive === false && fp.isActive) return null;
        if (isDefault === true && !fp.isDefault) return null;
        if (isDefault === false && fp.isDefault) return null;
        return fp;
      },
    },
    table: {
      findMany: async (args: unknown) => {
        let result = Array.from(tables.values());
        const typedArgs = args as { where?: Record<string, unknown>; orderBy?: unknown[] };
        const where = (typedArgs.where ?? {}) as Record<string, unknown>;
        const orderBy = (typedArgs.orderBy ?? []) as unknown[];

        const whereFloorPlanId = where.floorPlanId as string | undefined;
        const isActive = where.isActive as boolean | undefined;
        const capacity = where.capacity as { gte?: number } | undefined;
        const minCapacity = where.minCapacity as { lte?: number } | undefined;
        const id = where.id as { notIn?: string[] } | undefined;
        const sectionId = where.sectionId as string | undefined;
        const floorPlanRel = where.floorPlan as
          | { isActive?: boolean; restaurantId?: string }
          | undefined;

        if (whereFloorPlanId) {
          result = result.filter((t) => t.floorPlanId === whereFloorPlanId);
        }
        if (floorPlanRel?.restaurantId) {
          result = result.filter((t) => t.floorPlan?.restaurantId === floorPlanRel.restaurantId);
        }
        if (floorPlanRel?.isActive === true) {
          result = result.filter((t) => t.floorPlan?.isActive !== false);
        }
        if (isActive === true) {
          result = result.filter((t) => t.isActive);
        }
        if (isActive === false) {
          result = result.filter((t) => !t.isActive);
        }
        const gte = capacity?.gte;
        if (typeof gte === 'number') {
          result = result.filter((t) => t.capacity >= gte);
        }
        const lte = minCapacity?.lte;
        if (typeof lte === 'number') {
          result = result.filter((t) => t.minCapacity <= lte);
        }
        const notIn = id?.notIn;
        if (Array.isArray(notIn)) {
          result = result.filter((t) => !notIn.includes(t.id));
        }
        if (sectionId) {
          result = result.filter((t) => t.sectionId === sectionId);
        }

        result.sort((a, b) => {
          for (const clause of orderBy) {
            const order = clause as Record<string, unknown>;
            const capacityDir = order.capacity as string | undefined;
            const minCapacityDir = order.minCapacity as string | undefined;
            const nameDir = order.name as string | undefined;

            if (capacityDir) {
              const diff = a.capacity - b.capacity;
              if (diff !== 0) return capacityDir === 'asc' ? diff : -diff;
            }
            if (minCapacityDir) {
              const diff = a.minCapacity - b.minCapacity;
              if (diff !== 0) return minCapacityDir === 'asc' ? diff : -diff;
            }
            if (nameDir) {
              const diff = a.name.localeCompare(b.name);
              if (diff !== 0) return nameDir === 'asc' ? diff : -diff;
            }
          }
          return 0;
        });

        return result.map((t) => ({ ...t, section: t.section }));
      },
      findFirst: async (args: unknown) => {
        const typedArgs = args as { where?: Record<string, unknown> };
        const where = (typedArgs.where ?? {}) as Record<string, unknown>;
        const id = where.id as string | undefined;
        const floorPlan = where.floorPlan as { restaurantId?: string } | undefined;
        const isActive = where.isActive as boolean | undefined;
        const capacity = where.capacity as { gte?: number } | undefined;
        const minCapacity = where.minCapacity as { lte?: number } | undefined;

        for (const t of tables.values()) {
          if (id !== undefined && t.id !== id) continue;
          if (floorPlan?.restaurantId && t.floorPlan?.restaurantId !== floorPlan.restaurantId) {
            continue;
          }
          if (isActive === true && !t.isActive) continue;
          if (isActive === false && t.isActive) continue;
          if (typeof capacity?.gte === 'number' && t.capacity < capacity.gte) continue;
          if (typeof minCapacity?.lte === 'number' && t.minCapacity > minCapacity.lte) continue;
          return { ...t, section: t.section };
        }
        return null;
      },
      findUniqueOrThrow: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const id = where.id as string;
        const t = tables.get(id);
        if (!t) throw new Error(`Table not found: ${id}`);
        return t;
      },
    },
    reservation: {
      findMany: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        return Array.from(reservations.values()).filter((r) => matchesWhere(r, where));
      },
      findFirst: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        const tableId = where.tableId;
        const state = where.state as { in?: string[] } | undefined;
        const or = where.OR as Array<Record<string, unknown>> | undefined;
        const matchesRange = (value: Date | null | undefined, range: unknown) => {
          if (!(value instanceof Date)) return false;
          const bounds = range as { gte?: Date; gt?: Date; lt?: Date };
          return (
            (!bounds.gte || value >= bounds.gte) &&
            (!bounds.gt || value > bounds.gt) &&
            (!bounds.lt || value < bounds.lt)
          );
        };
        for (const reservation of reservations.values()) {
          if (restaurantId && reservation.restaurantId !== restaurantId) continue;
          if (where.isTest === false && reservation.isTest) continue;
          if ((where.id as { not?: string } | undefined)?.not === reservation.id) continue;
          if (tableId === null && reservation.tableId !== null) continue;
          if (state?.in && !state.in.includes(reservation.state)) continue;
          if (
            or &&
            !or.some((condition) => {
              if ('startsAt' in condition && condition.startsAt === null) {
                return (
                  reservation.startsAt === null &&
                  matchesRange(reservation.reservedAt, condition.reservedAt)
                );
              }
              if (
                'startsAt' in condition &&
                !matchesRange(reservation.startsAt, condition.startsAt)
              ) {
                return false;
              }
              if ('endsAt' in condition && condition.endsAt === null) {
                return reservation.endsAt === null;
              }
              if ('endsAt' in condition && condition.endsAt) {
                return matchesRange(reservation.endsAt, condition.endsAt);
              }
              return true;
            })
          )
            continue;
          return { id: reservation.id };
        }
        return null;
      },
      findUniqueOrThrow: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const id = where.id as string;
        const r = reservations.get(id);
        if (!r) throw new Error(`Reservation not found: ${id}`);
        return r;
      },
      update: async (args: unknown) => {
        const typedArgs = args as {
          where: Record<string, unknown>;
          data?: Record<string, unknown>;
        };
        const id = typedArgs.where.id as string;
        const r = reservations.get(id);
        if (!r) throw new Error(`Reservation not found: ${id}`);
        const data = typedArgs.data ?? ({} as Record<string, unknown>);
        const updated = { ...r, ...data } as unknown as MockReservation;
        reservations.set(id, updated);
        return updated;
      },
    },
    reservationAuditLog: {
      create: async (args: unknown) => args,
    },
    agenticHold: {
      findMany: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        return Array.from(holds.values()).filter((h) => matchesWhere(h, where));
      },
      findFirst: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        const tableId = where.tableId;
        const status = where.status as string | undefined;
        const expiresAt = where.expiresAt as { gt?: Date } | undefined;
        const slotStart = where.slotStart as { lt?: Date } | undefined;
        const slotEnd = where.slotEnd as { gt?: Date } | undefined;
        for (const hold of holds.values()) {
          if (restaurantId && hold.restaurantId !== restaurantId) continue;
          if (tableId === null && hold.tableId !== null) continue;
          if (status && hold.status !== status) continue;
          if (expiresAt?.gt && hold.expiresAt <= expiresAt.gt) continue;
          if (slotStart?.lt && hold.slotStart >= slotStart.lt) continue;
          if (slotEnd?.gt && hold.slotEnd <= slotEnd.gt) continue;
          return { id: hold.id };
        }
        return null;
      },
    },
    $queryRaw: async (arg: unknown) => {
      const s = arg as { sql?: string; values?: unknown[] };
      const sql = s.sql ?? '';
      const values = s.values ?? [];
      rawQueries.push({ sql, values });

      if (sql.includes('floor_plan_tables')) {
        return [{ id: values[0] as string }];
      }

      if (sql.includes('reservations')) {
        const [tableId, startsAt, endsAt, excludeId] = values;
        for (const r of reservations.values()) {
          if (r.tableId !== tableId) continue;
          if (!BLOCKING_RESERVATION_STATES.includes(r.state)) continue;
          if (!r.startsAt || !r.endsAt) continue;
          if (excludeId && r.id === excludeId) continue;
          if (r.startsAt < (endsAt as Date) && r.endsAt > (startsAt as Date)) {
            return [{ exists: 1 }];
          }
        }
        return [];
      }

      if (sql.includes('agentic_holds')) {
        const [tableId, startsAt, endsAt, excludeId] = values;
        const now = new Date();
        for (const h of holds.values()) {
          if (h.tableId !== tableId) continue;
          if (h.status !== 'ACTIVE') continue;
          if (!(h.expiresAt > now)) continue;
          if (!h.slotStart || !h.slotEnd) continue;
          if (excludeId && h.id === excludeId) continue;
          if (h.slotStart < (endsAt as Date) && h.slotEnd > (startsAt as Date)) {
            return [{ exists: 1 }];
          }
        }
        return [];
      }

      return [{ id: 'locked' }];
    },
    $executeRaw: async () => 1,
    $transaction: async (fn: unknown) => {
      if (Array.isArray(fn)) {
        return Promise.all(fn as unknown[]);
      }
      return (fn as (p: typeof prisma) => unknown)(prisma);
    },
  } as unknown as PrismaClient;

  return { prisma, tables, reservations, holds, rawQueries };
}

function makeTable(
  overrides: Partial<MockTable> & {
    id: string;
    capacity: number;
    floorPlanId: string;
    restaurantId?: string;
  },
): MockTable {
  return {
    id: overrides.id,
    floorPlanId: overrides.floorPlanId,
    sectionId: overrides.sectionId ?? null,
    name: overrides.name ?? `Table ${overrides.id}`,
    capacity: overrides.capacity,
    minCapacity: overrides.minCapacity ?? 1,
    positionX: overrides.positionX ?? null,
    positionY: overrides.positionY ?? null,
    width: overrides.width ?? null,
    height: overrides.height ?? null,
    rotation: overrides.rotation ?? 0,
    shape: overrides.shape ?? 'rect',
    assignedServer: overrides.assignedServer ?? null,
    isActive: overrides.isActive ?? true,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    section: overrides.section ?? null,
    floorPlan:
      overrides.floorPlan ??
      ({
        id: overrides.floorPlanId,
        restaurantId: overrides.restaurantId ?? 'r-1',
        isActive: true,
        isDefault: true,
      } as MockTable['floorPlan']),
  };
}

function makeReservation(
  overrides: Partial<MockReservation> & {
    id: string;
    tableId: string | null;
    startsAt: Date;
    endsAt: Date;
    partySize: number;
  },
): MockReservation {
  return {
    id: overrides.id,
    restaurantId: overrides.restaurantId ?? 'r-1',
    callId: overrides.callId ?? null,
    customerId: overrides.customerId ?? null,
    reservedAt: overrides.reservedAt ?? overrides.startsAt,
    partySize: overrides.partySize,
    customerName: overrides.customerName ?? 'Client',
    customerPhone: overrides.customerPhone ?? null,
    customerEmail: overrides.customerEmail ?? null,
    status: overrides.status ?? 'CONFIRMED',
    estimatedRevenue: overrides.estimatedRevenue ?? null,
    confirmedRevenue: overrides.confirmedRevenue ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    channel: overrides.channel ?? 'PHONE',
    state: overrides.state ?? 'CONFIRMED',
    startsAt: overrides.startsAt,
    endsAt: overrides.endsAt,
    specialRequests: overrides.specialRequests ?? null,
    createdByClient: overrides.createdByClient ?? null,
    cancellationPolicySnap: overrides.cancellationPolicySnap ?? null,
    noShowPolicySnap: overrides.noShowPolicySnap ?? null,
    consents: overrides.consents ?? {},
    privacyPolicyVersion: overrides.privacyPolicyVersion ?? '2026-06-20',
    idempotencyScope: overrides.idempotencyScope ?? null,
    idempotencyKey: overrides.idempotencyKey ?? null,
    idempotencyPayloadHash: overrides.idempotencyPayloadHash ?? null,
    consumedHoldId: overrides.consumedHoldId ?? null,
    source: overrides.source ?? null,
    confirmationStatus: overrides.confirmationStatus ?? 'NOT_REQUIRED',
    confirmationSentAt: overrides.confirmationSentAt ?? null,
    confirmedAt: overrides.confirmedAt ?? null,
    tableId: overrides.tableId,
    giftCardRedemptionSnap: null,
    giftCardComplementAmount: null,
    isTest: false,
  };
}

function makeHold(
  overrides: Partial<MockHold> & {
    id: string;
    tableId: string | null;
    slotStart: Date;
    slotEnd: Date;
  },
): MockHold {
  return {
    id: overrides.id,
    restaurantId: overrides.restaurantId ?? 'r-1',
    type: overrides.type ?? 'HOLD',
    partySize: overrides.partySize ?? 2,
    slotStart: overrides.slotStart,
    slotEnd: overrides.slotEnd,
    channel: overrides.channel ?? 'WEB',
    quoteToken: overrides.quoteToken ?? null,
    holdToken: overrides.holdToken ?? null,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 60 * 1000),
    consumedAt: overrides.consumedAt ?? null,
    status: overrides.status ?? 'ACTIVE',
    policyVersion: overrides.policyVersion ?? '2026-06-20',
    reservationId: overrides.reservationId ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    tableId: overrides.tableId,
  };
}

const restaurantId = 'r-1';
const floorPlanId = 'fp-1';
const sectionId = 's-1';
const section = { id: sectionId, name: 'Terrasse', position: 0 };

describe('TableAllocationService', () => {
  describe('allocate', () => {
    it('choisit la plus petite table adaptée (best fit)', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-4', floorPlanId, capacity: 4, name: 'Grande' }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2, name: 'Petite' }),
          makeTable({ id: 't-6', floorPlanId, capacity: 6, name: 'Très grande' }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
      });

      expect(table).not.toBeNull();
      expect(table!.id).toBe('t-2');
    });

    it('refuse toute allocation lorsqu’une réservation active sans table masque le créneau', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-2', floorPlanId, capacity: 2 })],
        reservations: [
          makeReservation({
            id: 'r-global',
            tableId: null,
            startsAt,
            endsAt: new Date('2026-07-02T21:00:00Z'),
            partySize: 2,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T20:00:00Z'),
        endsAt: new Date('2026-07-02T22:00:00Z'),
      });

      expect(table).toBeNull();
    });

    it('refuse toute allocation lorsqu’un hold actif sans table masque le créneau', async () => {
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-2', floorPlanId, capacity: 2 })],
        holds: [
          makeHold({
            id: 'h-global',
            tableId: null,
            slotStart: new Date('2026-07-02T19:00:00Z'),
            slotEnd: new Date('2026-07-02T21:00:00Z'),
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T20:00:00Z'),
        endsAt: new Date('2026-07-02T22:00:00Z'),
      });

      expect(table).toBeNull();
    });

    it('respecte la préférence de section', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({
            id: 't-inside',
            floorPlanId,
            capacity: 4,
            name: 'Intérieur',
            sectionId: null,
            section: null,
          }),
          makeTable({
            id: 't-terrasse',
            floorPlanId,
            capacity: 4,
            name: 'Terrasse',
            sectionId,
            section,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 4,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
        preferredSectionId: sectionId,
      });

      expect(table!.id).toBe('t-terrasse');
    });

    it('ne choisit jamais une section appartenant à un autre restaurant', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 'local', floorPlanId, capacity: 4 }),
          makeTable({
            id: 'foreign',
            floorPlanId: 'foreign-plan',
            capacity: 4,
            sectionId,
            floorPlan: {
              id: 'foreign-plan',
              restaurantId: 'other-restaurant',
              isActive: true,
              isDefault: true,
            },
          }),
        ],
      });
      const table = await new TableAllocationService(prisma).allocate({
        restaurantId,
        partySize: 4,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
        preferredSectionId: sectionId,
      });
      expect(table?.id).toBe('local');
    });

    it('retombe sur le plan par défaut si la section préférée ne peut pas accueillir le groupe', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({
            id: 't-inside',
            floorPlanId,
            capacity: 4,
            name: 'Intérieur',
            sectionId: null,
            section: null,
          }),
          makeTable({
            id: 't-terrasse',
            floorPlanId,
            capacity: 2,
            name: 'Terrasse',
            sectionId,
            section,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 4,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
        preferredSectionId: sectionId,
      });

      expect(table).not.toBeNull();
      expect(table!.id).toBe('t-inside');
    });

    it('allocate avec preferredSectionId choisit une table dans le floor plan de cette section', async () => {
      const fp2 = 'fp-2';
      const sectionTerrasse = { id: sectionId, name: 'Terrasse', position: 0 };
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({
            id: 't-inside',
            floorPlanId,
            capacity: 4,
            name: 'Intérieur',
            sectionId: null,
            section: null,
          }),
          makeTable({
            id: 't-terrasse',
            floorPlanId: fp2,
            capacity: 4,
            name: 'Terrasse',
            sectionId,
            section: sectionTerrasse,
            floorPlan: { id: fp2, restaurantId, isActive: true, isDefault: false },
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 4,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
        preferredSectionId: sectionId,
      });

      expect(table).not.toBeNull();
      expect(table!.id).toBe('t-terrasse');
    });

    it('ignore les tables inactives', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-active', floorPlanId, capacity: 2, name: 'Active' }),
          makeTable({
            id: 't-inactive',
            floorPlanId,
            capacity: 2,
            name: 'Inactive',
            isActive: false,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T19:00:00Z'),
        endsAt: new Date('2026-07-02T21:00:00Z'),
      });

      expect(table!.id).toBe('t-active');
    });

    it('détecte le chevauchement avec une réservation existante', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T20:00:00Z'),
        endsAt: new Date('2026-07-02T22:00:00Z'),
      });

      expect(table).toBeNull();
    });

    it('détecte le chevauchement avec un hold actif', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        holds: [makeHold({ id: 'h-1', tableId: 't-1', slotStart: startsAt, slotEnd: endsAt })],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T20:00:00Z'),
        endsAt: new Date('2026-07-02T22:00:00Z'),
      });

      expect(table).toBeNull();
    });

    it('ignore les holds expirés', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        holds: [
          makeHold({
            id: 'h-1',
            tableId: 't-1',
            slotStart: startsAt,
            slotEnd: endsAt,
            expiresAt: new Date('2026-07-01T00:00:00Z'),
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const table = await service.allocate({
        restaurantId,
        partySize: 2,
        startsAt: new Date('2026-07-02T20:00:00Z'),
        endsAt: new Date('2026-07-02T22:00:00Z'),
      });

      expect(table).not.toBeNull();
      expect(table!.id).toBe('t-1');
    });

    it('ne verrouille pas les tables en mode lecture seule', async () => {
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
      });

      // On garde le mock existant et on surcharge $queryRaw pour échouer
      // explicitement si le service tentait quand même un verrou en lecture seule.
      const readOnlyPrisma = {
        ...prisma,
        $queryRaw: async (arg: unknown) => {
          const sql = (arg as { sql?: string }).sql ?? '';
          if (sql.includes('FOR UPDATE')) {
            throw new Error('SELECT FOR UPDATE should not be called in readOnly mode');
          }
          return [];
        },
      } as unknown as PrismaClient;

      const service = new TableAllocationService(readOnlyPrisma);
      const table = await service.allocate(
        {
          restaurantId,
          partySize: 2,
          startsAt: new Date('2026-07-02T20:00:00Z'),
          endsAt: new Date('2026-07-02T22:00:00Z'),
        },
        undefined,
        { readOnly: true },
      );

      expect(table).not.toBeNull();
      expect(table!.id).toBe('t-1');
    });
  });

  describe('suggest', () => {
    const startsAt = new Date('2026-07-02T19:00:00Z');
    const endsAt = new Date('2026-07-02T21:00:00Z');

    it('retourne le top-3 trié best-fit avec score et raisons', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-6', floorPlanId, capacity: 6, name: 'Grande' }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2, name: 'Petite' }),
          makeTable({ id: 't-4', floorPlanId, capacity: 4, name: 'Moyenne' }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const out = await service.suggest({ restaurantId, partySize: 2, startsAt, endsAt }, 3);

      expect(out).toHaveLength(3);
      expect(out.map((s) => s.table.id)).toEqual(['t-2', 't-4', 't-6']);
      expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
      expect(out[1].score).toBeGreaterThanOrEqual(out[2].score);
      expect(out[0].reasons[0]).toContain('Capacité exacte');
      expect(out[0].table.name).toBe('Petite');
      expect(out[0].table.capacity).toBe(2);
    });

    it('respecte limit', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-4', floorPlanId, capacity: 4 }),
          makeTable({ id: 't-6', floorPlanId, capacity: 6 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const out = await service.suggest({ restaurantId, partySize: 2, startsAt, endsAt }, 2);

      expect(out).toHaveLength(2);
    });

    it('exclut les tables indisponibles (conflit de réservation)', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-4', floorPlanId, capacity: 4 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-2', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const out = await service.suggest({ restaurantId, partySize: 2, startsAt, endsAt }, 3);

      expect(out.map((s) => s.table.id)).toEqual(['t-4']);
    });

    it('ne verrouille JAMAIS les tables (pas de FOR UPDATE)', async () => {
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-2', floorPlanId, capacity: 2 })],
      });
      const rawSpy = vi.spyOn(prisma, '$queryRaw');

      const service = new TableAllocationService(prisma);
      await service.suggest({ restaurantId, partySize: 2, startsAt, endsAt }, 3);

      const lockCalls = rawSpy.mock.calls.filter((call) =>
        String((call[0] as { sql?: string })?.sql ?? '').includes('floor_plan_tables'),
      );
      expect(lockCalls).toHaveLength(0);
    });

    it('retourne [] quand aucune table n est disponible', async () => {
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 1 })],
      });

      const service = new TableAllocationService(prisma);
      const out = await service.suggest({ restaurantId, partySize: 8, startsAt, endsAt }, 3);

      expect(out).toEqual([]);
    });

    it('mentionne la section préférée dans les raisons', async () => {
      const section = { id: sectionId, name: 'Terrasse', position: 0 };
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({
            id: 't-terrasse',
            floorPlanId,
            capacity: 4,
            sectionId,
            section,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const out = await service.suggest(
        { restaurantId, partySize: 4, startsAt, endsAt, preferredSectionId: sectionId },
        3,
      );

      expect(out).toHaveLength(1);
      expect(out[0].reasons.join(' ')).toContain('section préférée');
    });
  });

  describe('releaseTable', () => {
    it('met Reservation.tableId à null', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma, reservations } = makeMockPrisma({
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      await service.releaseTable('r-1');

      expect(reservations.get('r-1')?.tableId).toBeNull();
      expect(reservations.get('r-1')?.status).toBe('CONFIRMED');
      expect(reservations.get('r-1')?.state).toBe('CONFIRMED');
    });
  });

  describe('isTableAvailable', () => {
    it('convertit les bornes JavaScript en timestamp UTC pour les plages PostgreSQL', async () => {
      const startsAt = new Date('2026-07-02T19:00:00.000Z');
      const endsAt = new Date('2026-07-02T21:00:00.000Z');
      const { prisma, rawQueries } = makeMockPrisma();
      const service = new TableAllocationService(prisma);

      await service.isTableAvailable({ tableId: 't-1', startsAt, endsAt });

      const rangeQueries = rawQueries.filter(
        (query) => query.sql.includes('reservations') || query.sql.includes('agentic_holds'),
      );
      expect(rangeQueries).toHaveLength(2);
      expect(rangeQueries.every((query) => query.sql.includes("AT TIME ZONE 'UTC'"))).toBe(true);
    });

    it('ignore le hold exclu avec excludeHoldId', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        holds: [
          makeHold({
            id: 'h-1',
            tableId: 't-1',
            slotStart: startsAt,
            slotEnd: endsAt,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const available = await service.isTableAvailable({
        tableId: 't-1',
        startsAt,
        endsAt,
        excludeHoldId: 'h-1',
      });

      expect(available).toBe(true);
    });

    it('retourne false si un autre hold occupe la table', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        holds: [
          makeHold({
            id: 'h-2',
            tableId: 't-1',
            slotStart: startsAt,
            slotEnd: endsAt,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const available = await service.isTableAvailable({
        tableId: 't-1',
        startsAt,
        endsAt,
        excludeHoldId: 'h-1',
      });

      expect(available).toBe(false);
    });
  });

  describe('reallocate', () => {
    it("refuse une réservation d'un autre restaurant", async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma, reservations } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
        ],
        reservations: [
          makeReservation({
            id: 'r-9',
            restaurantId: 'r-2',
            tableId: 't-1',
            startsAt,
            endsAt,
            partySize: 2,
          }),
        ],
      });
      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-9', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect((error as TableAllocationError).code).toBe('RESERVATION_NOT_FOUND');
      expect(reservations.get('r-9')?.tableId).toBe('t-1');
    });

    it("refuse une table d'un autre restaurant", async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma, reservations } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-9', floorPlanId, restaurantId: 'r-2', capacity: 2 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });
      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-9').catch((e) => e);
      expect((error as TableAllocationError).code).toBe('TABLE_NOT_FOUND');
      expect(reservations.get('r-1')?.tableId).toBe('t-1');
    });

    it('change la table de la réservation', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma, reservations } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      await service.reallocate('r-1', 'r-1', 't-2');

      expect(reservations.get('r-1')?.tableId).toBe('t-2');
    });

    it('rejette une table trop petite', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 4 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 4 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      await expect(service.reallocate('r-1', 'r-1', 't-2')).rejects.toThrow(TableAllocationError);
    });

    it("rejette une table d'un autre restaurant", async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2, restaurantId: 'r-2' }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_FOUND');
    });

    it('rejette une table inactive', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2, isActive: false }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_ACTIVE');
    });

    it('rejette une table avec minCapacity trop élevé', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 4 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 4, minCapacity: 3 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_MIN_CAPACITY_TOO_HIGH');
    });

    it('rejette si les temps de réservation sont manquants', async () => {
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
        ],
        reservations: [
          makeReservation({
            id: 'r-1',
            tableId: 't-1',
            partySize: 2,
            reservedAt: new Date('2026-07-02T19:00:00Z'),
            startsAt: null as unknown as Date,
            endsAt: null as unknown as Date,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('RESERVATION_TIMES_MISSING');
    });

    it('rejette si la table est déjà occupée sur le créneau', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [
          makeTable({ id: 't-1', floorPlanId, capacity: 2 }),
          makeTable({ id: 't-2', floorPlanId, capacity: 2 }),
        ],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
          makeReservation({
            id: 'r-2',
            tableId: 't-2',
            startsAt: new Date('2026-07-02T20:00:00Z'),
            endsAt: new Date('2026-07-02T22:00:00Z'),
            partySize: 2,
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service.reallocate('r-1', 'r-1', 't-2').catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_AVAILABLE');
    });
  });

  describe('assertTableAvailableForSeating', () => {
    it('réussit quand la table est disponible', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
      });

      const service = new TableAllocationService(prisma);
      await expect(
        service.assertTableAvailableForSeating(
          { restaurantId, tableId: 't-1', partySize: 2, startsAt, endsAt },
          prisma,
        ),
      ).resolves.toBeUndefined();
    });

    it('rejette une table introuvable', async () => {
      const { prisma } = makeMockPrisma();
      const service = new TableAllocationService(prisma);
      const error = await service
        .assertTableAvailableForSeating(
          {
            restaurantId,
            tableId: 't-missing',
            partySize: 2,
            startsAt: new Date(),
            endsAt: new Date(),
          },
          prisma,
        )
        .catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_FOUND');
    });

    it('rejette une table déjà occupée', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        reservations: [
          makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt, partySize: 2 }),
        ],
      });

      const service = new TableAllocationService(prisma);
      const error = await service
        .assertTableAvailableForSeating(
          { restaurantId, tableId: 't-1', partySize: 2, startsAt, endsAt },
          prisma,
        )
        .catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_AVAILABLE');
    });

    it('ignore la réservation actuelle avec excludeReservationId', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2 })],
        reservations: [
          makeReservation({
            id: 'r-1',
            tableId: 't-1',
            startsAt,
            endsAt,
            partySize: 2,
            state: 'SEATED',
          }),
        ],
      });

      const service = new TableAllocationService(prisma);
      await expect(
        service.assertTableAvailableForSeating(
          {
            restaurantId,
            tableId: 't-1',
            partySize: 2,
            startsAt,
            endsAt,
            excludeReservationId: 'r-1',
          },
          prisma,
        ),
      ).resolves.toBeUndefined();
    });

    it('rejette une table inactive', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2, isActive: false })],
      });

      const service = new TableAllocationService(prisma);
      const error = await service
        .assertTableAvailableForSeating(
          { restaurantId, tableId: 't-1', partySize: 2, startsAt, endsAt },
          prisma,
        )
        .catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_NOT_ACTIVE');
    });

    it('rejette une table trop petite', async () => {
      const startsAt = new Date('2026-07-02T19:00:00Z');
      const endsAt = new Date('2026-07-02T21:00:00Z');
      const { prisma } = makeMockPrisma({
        tables: [makeTable({ id: 't-1', floorPlanId, capacity: 2, minCapacity: 2 })],
      });

      const service = new TableAllocationService(prisma);
      const error = await service
        .assertTableAvailableForSeating(
          { restaurantId, tableId: 't-1', partySize: 1, startsAt, endsAt },
          prisma,
        )
        .catch((e) => e);
      expect(error).toBeInstanceOf(TableAllocationError);
      expect(error.code).toBe('TABLE_MIN_CAPACITY_TOO_HIGH');
    });
  });
});
