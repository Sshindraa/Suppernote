import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { AuditLogService } from '../core/audit-log.service.js';
import { HoldNotFoundError, HoldService } from '../core/hold.service.js';
import {
  IdempotencyService,
  type IdempotencyStore,
  hashPayload,
} from '../core/idempotency.service.js';
import { buildPolicySnapshot } from '../core/policies.service.js';
import {
  ReservationService,
  ReservationSlotUnavailableError,
} from '../core/reservation.service.js';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service.js';
import { TableAllocationService } from '../../floor-plan/table-allocation.service';
import { matchesWhere } from '../../../test/prisma-where';
import * as confirmationOutbox from '../../../shared/outbox/reservation-confirmation';
import { CustomerService } from '../../customers/customer.service';
import * as marketingAttribution from '../../marketing/marketing-attribution.service';
import { GiftCardService } from '../../gift-cards/gift-card.service.js';

type HoldRow = {
  id: string;
  restaurantId: string;
  type: 'QUOTE' | 'HOLD';
  partySize: number;
  slotStart: Date;
  slotEnd: Date;
  channel: string;
  holdToken: string | null;
  quoteToken: string | null;
  expiresAt: Date;
  consumedAt: Date | null;
  status: 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'RELEASED';
  policyVersion: string;
  reservationId: string | null;
  tableId: string | null;
  createdAt: Date;
};

type ReservationRow = {
  id: string;
  restaurantId: string;
  partySize: number;
  reservedAt: Date;
  startsAt: Date | null;
  endsAt: Date | null;
  tableId: string | null;
  state:
    | 'PENDING'
    | 'CONFIRMED'
    | 'SEATED'
    | 'HONORED'
    | 'CANCELLED'
    | 'NO_SHOW'
    | 'FAILED'
    | 'EXPIRED';
  status: 'CONFIRMED' | 'CANCELLED' | 'SEATED' | 'NO_SHOW';
  consumedHoldId: string | null;
};

function makeIdempotencyStore(): IdempotencyStore {
  const records = new Map<
    string,
    {
      payloadHash: string;
      reservationId: string | null;
      status: 'pending' | 'completed' | 'failed';
      expiresAt: Date;
    }
  >();

  return {
    async get(scope, key) {
      return records.get(`${scope}::${key}`) ?? null;
    },
    async insertPending({ scope, key, payloadHash, expiresAt }) {
      const recordKey = `${scope}::${key}`;
      if (records.has(recordKey)) {
        const err = new Error('unique violation') as Error & { code: string };
        err.code = 'P2002';
        throw err;
      }
      records.set(recordKey, { payloadHash, reservationId: null, status: 'pending', expiresAt });
    },
    async markCompleted({ scope, key, reservationId }) {
      const recordKey = `${scope}::${key}`;
      const existing = records.get(recordKey);
      if (!existing) throw new Error('not found');
      records.set(recordKey, { ...existing, reservationId, status: 'completed' });
    },
    async markFailed({ scope, key }) {
      const recordKey = `${scope}::${key}`;
      const existing = records.get(recordKey);
      if (!existing) return;
      records.set(recordKey, { ...existing, status: 'failed' });
    },
    async purgeExpired() {
      return 0;
    },
  };
}

function makeFakes(hasTables = true, tableCapacities: number[] = [10], overlapOnCreate = false) {
  const holds = new Map<string, HoldRow>();
  const reservations = new Map<string, ReservationRow>();
  const audits: Record<string, unknown>[] = [];
  const createdReservationData: Record<string, unknown>[] = [];

  const prisma = {
    restaurant: { findUnique: vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' }) },
    restaurantExposureSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    table: {
      findFirst: vi.fn().mockResolvedValue(hasTables ? { id: 'table-1' } : null),
      findMany: vi.fn().mockResolvedValue(
        hasTables
          ? tableCapacities.map((capacity, index) => ({
              id: `table-${index + 1}`,
              sectionId: null,
              capacity,
              minCapacity: 1,
            }))
          : [],
      ),
    },
    $transaction: async (fn: unknown) =>
      (fn as unknown as (tx: PrismaClient) => Promise<unknown>)(prisma as unknown as PrismaClient),
    $queryRaw: async () => [{ id: 'locked' }],
    agenticHold: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const type = data.type as 'HOLD' | 'QUOTE';
        const status = (data.status as HoldRow['status'] | undefined) ?? 'ACTIVE';
        if (type === 'HOLD' && status === 'ACTIVE') {
          for (const hold of holds.values()) {
            const dSlotStart = data.slotStart;
            if (
              hold.restaurantId === data.restaurantId &&
              hold.partySize === data.partySize &&
              dSlotStart instanceof Date &&
              hold.slotStart.getTime() === dSlotStart.getTime() &&
              hold.type === 'HOLD' &&
              hold.status === 'ACTIVE'
            ) {
              const err = new Error('unique violation') as Error & { code: string };
              err.code = 'P2002';
              throw err;
            }
          }
        }

        const id = `hold-${holds.size + 1}`;
        const row: HoldRow = {
          id,
          restaurantId: data.restaurantId as string,
          type,
          partySize: data.partySize as number,
          slotStart: data.slotStart as Date,
          slotEnd: data.slotEnd as Date,
          channel: data.channel as string,
          holdToken: (data.holdToken as string | null | undefined) ?? null,
          quoteToken: (data.quoteToken as string | null | undefined) ?? null,
          expiresAt: data.expiresAt as Date,
          consumedAt: (data.consumedAt as Date | null | undefined) ?? null,
          status,
          policyVersion: data.policyVersion as string,
          reservationId: (data.reservationId as string | null | undefined) ?? null,
          tableId: (data.tableId as string | null | undefined) ?? null,
          createdAt: new Date(),
        };
        holds.set(id, row);
        return row;
      },
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        for (const hold of holds.values()) {
          if (where.restaurantId !== undefined && hold.restaurantId !== where.restaurantId)
            continue;
          if (where.type !== undefined && hold.type !== where.type) continue;
          if (where.status !== undefined && hold.status !== where.status) continue;
          if (where.tableId === null && hold.tableId !== null) continue;
          const idFilter = where.id as { not?: string } | undefined;
          if (idFilter?.not && hold.id === idFilter.not) continue;
          const expiresAt = where.expiresAt as { gt?: Date } | undefined;
          if (expiresAt?.gt && hold.expiresAt <= expiresAt.gt) continue;
          const slotStart = where.slotStart as { lt?: Date } | undefined;
          const slotEnd = where.slotEnd as { gt?: Date } | undefined;
          if (slotStart?.lt && hold.slotStart >= slotStart.lt) continue;
          if (slotEnd?.gt && hold.slotEnd <= slotEnd.gt) continue;
          return { id: hold.id };
        }
        return null;
      },
      findUnique: async ({ where }: { where: { id: string } }) => holds.get(where.id) ?? null,
      findMany: async ({
        where,
        select,
      }: {
        where: Record<string, unknown>;
        select?: Record<string, unknown>;
      }) =>
        Array.from(holds.values())
          .filter((hold) => matchesWhere(hold, where))
          .map((hold) =>
            select
              ? Object.fromEntries(
                  Object.keys(select).map((key) => [key, (hold as Record<string, unknown>)[key]]),
                )
              : hold,
          ),
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const hold = holds.get(where.id);
        if (!hold) throw new Error('not found');
        Object.assign(hold, data);
        return hold;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        let count = 0;
        for (const hold of holds.values()) {
          const idFilter = where.id as string | Record<string, unknown> | undefined;
          const inArr =
            typeof idFilter === 'object' && idFilter !== null
              ? ((idFilter as Record<string, unknown>).in as unknown[] | undefined)
              : undefined;
          if (inArr && !inArr.includes(hold.id)) continue;
          if (typeof idFilter === 'string' && hold.id !== idFilter) continue;
          if (where.status !== undefined && hold.status !== where.status) continue;
          if (where.type !== undefined && hold.type !== where.type) continue;
          const expiresAt = where.expiresAt as Record<string, unknown> | undefined;
          const lt = expiresAt?.lt;
          if (lt instanceof Date && !(hold.expiresAt.getTime() < lt.getTime())) continue;
          const gt = expiresAt?.gt;
          if (gt instanceof Date && !(hold.expiresAt.getTime() > gt.getTime())) continue;
          Object.assign(hold, data);
          count++;
        }
        return { count };
      },
    },
    reservation: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (overlapOnCreate) {
          throw new Error(
            'conflicting key violates exclusion constraint "reservations_no_overlap_active"',
          );
        }
        createdReservationData.push(data);
        const id = `reservation-${reservations.size + 1}`;
        const row: ReservationRow = {
          id,
          restaurantId: data.restaurantId as string,
          partySize: data.partySize as number,
          reservedAt: data.reservedAt as Date,
          startsAt: (data.startsAt as Date | null | undefined) ?? null,
          endsAt: (data.endsAt as Date | null | undefined) ?? null,
          tableId: (data.tableId as string | null | undefined) ?? null,
          state: data.state as ReservationRow['state'],
          status: data.status as ReservationRow['status'],
          consumedHoldId: (data.consumedHoldId as string | null | undefined) ?? null,
        };
        reservations.set(id, row);
        return row;
      },
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        Array.from(reservations.values())
          .map((reservation) => ({ isTest: false, createdAt: new Date(0), ...reservation }))
          .filter((reservation) => matchesWhere(reservation, where)),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const OR = where.OR as Record<string, unknown>[] | undefined;
        const state = where.state as Record<string, unknown> | undefined;
        const stateIn = state?.in as unknown[] | undefined;
        for (const reservation of reservations.values()) {
          if (reservation.restaurantId !== where.restaurantId) continue;
          if (where.partySize !== undefined && reservation.partySize !== where.partySize) continue;
          if (where.tableId === null && reservation.tableId !== null) continue;
          if (stateIn && !stateIn.includes(reservation.state)) continue;
          const or0 = OR?.[0];
          const or1 = OR?.[1];
          const or0ReservedAt = or0
            ? ((or0 as Record<string, unknown>).reservedAt as Date | null | undefined)
            : undefined;
          const sameReservedAt =
            or0ReservedAt instanceof Date &&
            reservation.reservedAt.getTime() === or0ReservedAt.getTime();
          const or1StartsAt = or1
            ? ((or1 as Record<string, unknown>).startsAt as Date | null | undefined)
            : undefined;
          const sameStartsAt =
            (or1StartsAt === null && reservation.startsAt === null) ||
            (or1StartsAt instanceof Date &&
              reservation.startsAt instanceof Date &&
              reservation.startsAt.getTime() === or1StartsAt.getTime());
          const overlap = OR?.some((condition) => {
            const starts = condition.startsAt as { lt?: Date } | null | undefined;
            const ends = condition.endsAt as { gt?: Date } | null | undefined;
            if (starts?.lt && ends?.gt && reservation.startsAt && reservation.endsAt) {
              return reservation.startsAt < starts.lt && reservation.endsAt > ends.gt;
            }
            if (condition.startsAt === null && condition.reservedAt) {
              const range = condition.reservedAt as { gte?: Date; lt?: Date };
              return (
                reservation.startsAt === null &&
                (!range.gte || reservation.reservedAt >= range.gte) &&
                (!range.lt || reservation.reservedAt < range.lt)
              );
            }
            return false;
          });
          if (sameReservedAt || sameStartsAt || overlap) return { id: reservation.id };
        }
        return null;
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        reservations.get(where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const reservation = reservations.get(where.id);
        if (!reservation) throw new Error('not found');
        Object.assign(reservation, data);
        return reservation;
      },
    },
    reservationAuditLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        audits.push(data);
        return data;
      },
    },
  } as unknown as PrismaClient;

  const audit = new AuditLogService(prisma);
  const holdService = new HoldService(prisma, audit);
  const idempotency = new IdempotencyService(makeIdempotencyStore());
  const reservationsService = new ReservationService(prisma, audit, holdService, idempotency);

  return {
    audits,
    createdReservationData,
    holdService,
    holds,
    reservations,
    reservationsService,
  };
}

const policy = buildPolicySnapshot({
  policyVersion: '2026-06-20',
  maxPartySize: 12,
  minLeadTimeMinutes: 0,
  requireManualValidation: false,
  quoteTtlSeconds: 300,
  holdTtlSeconds: 420,
  noShowPolicy: 'warning',
  notificationChannels: ['sms'],
  capacitySpecials: {},
});

describe('reservation.service', () => {
  it('creates a staff reservation without a table when no active tables exist', async () => {
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(false);
    try {
      const fakes = makeFakes(false);
      const startsAt = new Date(Date.now() + 3_600_000);
      await fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 3_600_000),
          customerName: 'Alice',
          customerPhone: '+33600000000',
          channel: 'ADMIN',
          actor: 'staff:user',
          policy,
        },
        {
          scope: 'staff',
          key: 'no-table',
          payloadHash: hashPayload({ startsAt }),
          ttlSeconds: 300,
        },
      );
      expect(fakes.createdReservationData[0]).toMatchObject({ tableId: null });
    } finally {
      intent.mockRestore();
    }
  });
  it('rejects a staff reservation if active tables exist but none is available', async () => {
    const allocate = vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      await expect(
        fakes.reservationsService.createReservation(
          {
            restaurantId: 'r-1',
            partySize: 2,
            startsAt,
            endsAt: new Date(startsAt.getTime() + 3_600_000),
            customerName: 'Alice',
            customerPhone: '+33600000000',
            channel: 'ADMIN',
            actor: 'staff:user',
            policy,
          },
          {
            scope: 'staff',
            key: 'no-free-table',
            payloadHash: hashPayload({ startsAt }),
            ttlSeconds: 300,
          },
        ),
      ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
    } finally {
      allocate.mockRestore();
    }
  });
  it('allocates a table and creates a staff reservation under the capacity lock', async () => {
    const allocate = vi
      .spyOn(TableAllocationService.prototype, 'allocate')
      .mockResolvedValue({ id: 'table-1' } as never);
    const lock = vi.spyOn(TableAllocationService.prototype, 'lockTable').mockResolvedValue(true);
    const available = vi
      .spyOn(TableAllocationService.prototype, 'isTableAvailable')
      .mockResolvedValue(true);
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(true);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      const input = {
        restaurantId: 'r-1',
        partySize: 4,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Alice',
        customerPhone: '+33600000000',
        customerEmail: 'alice@example.com',
        specialRequests: 'Terrasse',
        channel: 'ADMIN' as const,
        actor: 'staff:user',
        policy,
      };
      const key = {
        scope: 'staff',
        key: 'normal',
        payloadHash: hashPayload({ startsAt }),
        ttlSeconds: 300,
      };
      const first = await fakes.reservationsService.createReservation(input, key);
      const replay = await fakes.reservationsService.createReservation(input, key);
      expect(replay.reservationId).toBe(first.reservationId);
      expect(allocate).toHaveBeenCalledTimes(1);
      expect(fakes.createdReservationData).toHaveLength(1);
      expect(fakes.createdReservationData[0]).toMatchObject({
        channel: 'ADMIN',
        tableId: 'table-1',
        customerEmail: 'alice@example.com',
        specialRequests: 'Terrasse',
      });
    } finally {
      allocate.mockRestore();
      lock.mockRestore();
      available.mockRestore();
      intent.mockRestore();
    }
  });
  it('overbooks a blocked slot without a table or hold, records the override and replays the same reservation', async () => {
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(true);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      const input = {
        restaurantId: 'r-1',
        partySize: 4,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Alice',
        customerPhone: '+33600000000',
        customerEmail: 'alice@example.com',
        specialRequests: 'Terrasse',
        channel: 'ADMIN' as const,
        actor: 'staff:user',
        policy,
        allowOverbook: true,
      };
      fakes.reservations.set('blocking', {
        id: 'blocking',
        restaurantId: 'r-1',
        partySize: 4,
        reservedAt: startsAt,
        startsAt,
        endsAt: input.endsAt,
        tableId: null,
        state: 'CONFIRMED',
        status: 'CONFIRMED',
        consumedHoldId: null,
      });
      const key = {
        scope: 'staff',
        key: 'same-key',
        payloadHash: hashPayload({ startsAt }),
        ttlSeconds: 300,
      };
      const first = await fakes.reservationsService.createReservation(input, key);
      const replay = await fakes.reservationsService.createReservation(input, key);
      expect(replay.reservationId).toBe(first.reservationId);
      expect(fakes.createdReservationData).toHaveLength(1);
      expect(fakes.createdReservationData[0]).toMatchObject({
        channel: 'ADMIN',
        specialRequests: 'Terrasse',
        customerEmail: 'alice@example.com',
        tableId: null,
        consumedHoldId: null,
      });
      expect(fakes.holds.size).toBe(0);
      expect(fakes.audits).toContainEqual(
        expect.objectContaining({
          event: 'reservation_created',
          actor: 'staff:user',
          metadata: expect.objectContaining({ overbooked: true }),
        }),
      );
      expect(intent).toHaveBeenCalledTimes(1);
    } finally {
      intent.mockRestore();
    }
  });
  it('requests a transactional web confirmation only on first creation, not replay', async () => {
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(true);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      const input = {
        restaurantId: 'r-1',
        partySize: 2,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Example',
        customerPhone: '+33600000000',
        channel: 'WEB' as const,
        policy,
        actor: 'connect:web',
      };
      const key = {
        scope: 'web',
        key: 'confirmation',
        payloadHash: hashPayload({ startsAt }),
        ttlSeconds: 300,
      };
      const first = await fakes.reservationsService.createReservation(input, key);
      await fakes.reservationsService.createReservation(input, key);
      expect(intent).toHaveBeenCalledTimes(1);
      expect(intent).toHaveBeenCalledWith(
        expect.objectContaining({ reservationAuditLog: expect.any(Object) }),
        expect.objectContaining({ id: first.reservationId, state: 'CONFIRMED' }),
      );
    } finally {
      intent.mockRestore();
    }
  });
  it('crée une réservation avec hold synthétique consommé et audit', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const payloadHash = hashPayload({ restaurantId: 'r-1', partySize: 4, startsAt });

    const result = await fakes.reservationsService.createReservation(
      {
        restaurantId: 'r-1',
        partySize: 4,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Jean Test',
        customerPhone: '+33600000000',
        channel: 'MCP',
        policy,
        actor: 'agent:test',
      },
      {
        scope: 'scope-1',
        key: 'key-1',
        payloadHash,
        ttlSeconds: 300,
      },
    );

    expect(result.reused).toBe(false);
    expect(result.state).toBe('CONFIRMED');
    expect([...fakes.holds.values()][0].status).toBe('CONSUMED');
    expect(fakes.audits.map((audit) => audit.event)).toContain('hold_consumed');
    expect(fakes.audits.map((audit) => audit.event)).toContain('reservation_created');
  });

  it('une réservation sans table ne prend qu’une table : une seconde passe sur l’autre, une troisième est refusée', async () => {
    const fakes = makeFakes(true, [2, 10]);
    const startsAt = new Date(Date.now() + 3_600_000);
    const create = (key: string) =>
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Test',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
        },
        { scope: `scope-${key}`, key, payloadHash: hashPayload({ key }), ttlSeconds: 300 },
      );

    await expect(create('first')).resolves.toBeDefined();
    await expect(create('second')).resolves.toBeDefined();
    await expect(create('third')).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
    expect(fakes.reservations.size).toBe(2);
  });

  it('un hold sans table ne prend qu’une table : un autre groupe au même créneau passe sur l’autre', async () => {
    // Même couverts que le hold, l’index unique partiel one_active_hold_per_slot_no_table refuse
    // déjà un second hold sans table : ce cas reste à traiter (voir la PR), il n’est pas testé ici.
    const fakes = makeFakes(true, [2, 10]);
    const startsAt = new Date(Date.now() + 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
    fakes.holds.set('hold-loose', {
      id: 'hold-loose',
      restaurantId: 'r-1',
      type: 'HOLD',
      partySize: 2,
      slotStart: startsAt,
      slotEnd: endsAt,
      channel: 'WEB',
      holdToken: null,
      quoteToken: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      consumedAt: null,
      status: 'ACTIVE',
      policyVersion: policy.policyVersion,
      reservationId: null,
      tableId: null,
      createdAt: new Date(Date.now() - 60_000),
    });

    await expect(
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 4,
          startsAt,
          endsAt,
          customerName: 'Test',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
        },
        {
          scope: 'scope-hold',
          key: 'key-hold',
          payloadHash: hashPayload({ hold: 1 }),
          ttlSeconds: 300,
        },
      ),
    ).resolves.toBeDefined();
  });

  it('refuse un groupe qu’aucune table ne peut accueillir, même sans réservation', async () => {
    const fakes = makeFakes(true, [4]);
    const startsAt = new Date(Date.now() + 3_600_000);

    await expect(
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 6,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Test',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
        },
        {
          scope: 'scope-big',
          key: 'key-big',
          payloadHash: hashPayload({ big: 1 }),
          ttlSeconds: 300,
        },
      ),
    ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
  });

  it('rejette une deuxième réservation sur le même slot', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const baseInput = {
      restaurantId: 'r-1',
      partySize: 4,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      customerName: 'Jean Test',
      customerPhone: '+33600000000',
      channel: 'MCP' as const,
      policy,
      actor: 'agent:test',
    };

    await fakes.reservationsService.createReservation(baseInput, {
      scope: 'scope-1',
      key: 'key-1',
      payloadHash: hashPayload({ key: 1, startsAt }),
      ttlSeconds: 300,
    });

    await expect(
      fakes.reservationsService.createReservation(
        { ...baseInput, customerName: 'Marie Test' },
        {
          scope: 'scope-2',
          key: 'key-2',
          payloadHash: hashPayload({ key: 2, startsAt }),
          ttlSeconds: 300,
        },
      ),
    ).rejects.toThrow(ReservationSlotUnavailableError);
  });

  it('expire un hold actif dépassé avant de créer une réservation directe', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    fakes.holds.set('expired-hold', {
      id: 'expired-hold',
      restaurantId: 'r-1',
      type: 'HOLD',
      partySize: 4,
      slotStart: startsAt,
      slotEnd: new Date(startsAt.getTime() + 90 * 60_000),
      channel: 'MCP',
      holdToken: 'expired-token',
      quoteToken: null,
      expiresAt: new Date(Date.now() - 1_000),
      consumedAt: null,
      status: 'ACTIVE',
      policyVersion: policy.policyVersion,
      reservationId: null,
      tableId: null,
      createdAt: new Date(Date.now() - 10_000),
    });

    const result = await fakes.reservationsService.createReservation(
      {
        restaurantId: 'r-1',
        partySize: 4,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Jean Test',
        customerPhone: '+33600000000',
        channel: 'MCP',
        policy,
        actor: 'agent:test',
      },
      {
        scope: 'scope-expired',
        key: 'key-expired',
        payloadHash: hashPayload({ restaurantId: 'r-1', startsAt }),
        ttlSeconds: 300,
      },
    );

    expect(result.state).toBe('CONFIRMED');
    expect(fakes.holds.get('expired-hold')?.status).toBe('EXPIRED');
    expect(fakes.audits.map((audit) => audit.event)).toContain('hold_expired');
    expect([...fakes.holds.values()].filter((hold) => hold.status === 'CONSUMED')).toHaveLength(1);
  });

  it('rejects a hold whose end time differs from the reservation', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const heldEndsAt = new Date(startsAt.getTime() + 60 * 60_000);
    const durationHoldToken = ['duration', 'token'].join('-');
    fakes.holds.set('duration-hold', {
      id: 'duration-hold',
      restaurantId: 'r-1',
      type: 'HOLD',
      partySize: 4,
      slotStart: startsAt,
      slotEnd: heldEndsAt,
      channel: 'MCP',
      holdToken: durationHoldToken,
      quoteToken: null,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
      status: 'ACTIVE',
      policyVersion: policy.policyVersion,
      reservationId: null,
      tableId: null,
      createdAt: new Date(),
    });

    await expect(
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 4,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Jean Test',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
          holdToken: durationHoldToken,
        },
        {
          scope: 'scope-hold-duration',
          key: 'key-hold-duration',
          payloadHash: hashPayload({ holdDuration: true }),
          ttlSeconds: 300,
        },
      ),
    ).rejects.toThrow(HoldNotFoundError);
    expect(fakes.holds.get('duration-hold')?.status).toBe('ACTIVE');
  });

  it('caractérise la dualité : validation manuelle = state PENDING mais status CONFIRMED', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const manualPolicy = { ...policy, requireManualValidation: true };

    const result = await fakes.reservationsService.createReservation(
      {
        restaurantId: 'r-1',
        partySize: 4,
        startsAt,
        endsAt: new Date(startsAt.getTime() + 90 * 60_000),
        customerName: 'Jean Test',
        customerPhone: '+33600000000',
        channel: 'MCP',
        policy: manualPolicy,
        actor: 'agent:test',
      },
      {
        scope: 'scope-manual',
        key: 'key-manual',
        payloadHash: hashPayload({ manual: true, startsAt }),
        ttlSeconds: 300,
      },
    );

    const stored = [...fakes.reservations.values()][0];
    expect(result.state).toBe('PENDING');
    expect(stored.state).toBe('PENDING');
    expect(stored.status).toBe('CONFIRMED');
    expect(fakes.audits).toContainEqual(
      expect.objectContaining({
        event: 'reservation_created',
        toState: 'PENDING',
        metadata: expect.objectContaining({ requiresManualValidation: true }),
      }),
    );
  });

  it('refuse un créneau chevauchant une réservation active sans table, quelle que soit la taille', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    fakes.reservations.set('unassigned-active', {
      id: 'unassigned-active',
      restaurantId: 'r-1',
      partySize: 8,
      reservedAt: startsAt,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      tableId: null,
      state: 'CONFIRMED',
      status: 'CONFIRMED',
      consumedHoldId: null,
    });

    await expect(
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt: new Date(startsAt.getTime() + 30 * 60_000),
          endsAt: new Date(startsAt.getTime() + 120 * 60_000),
          customerName: 'Blocked client',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
        },
        {
          scope: 'scope-global-block',
          key: 'key-global-block',
          payloadHash: hashPayload({ global: true }),
          ttlSeconds: 300,
        },
      ),
    ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
  });

  it('chevauchement sur la table au create (23P01) → ReservationSlotUnavailableError', async () => {
    const fakes = makeFakes(true, [10], true);
    const startsAt = new Date(Date.now() + 3_600_000);

    await expect(
      fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Overlap client',
          customerPhone: '+33600000000',
          channel: 'MCP',
          policy,
          actor: 'agent:test',
        },
        {
          scope: 'scope-overlap-23p01',
          key: 'key-overlap-23p01',
          payloadHash: hashPayload({ overlap: true }),
          ttlSeconds: 300,
        },
      ),
    ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
  });

  it('rejoue une création agentic sans recréer hold, réservation ou audit', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const input = {
      restaurantId: 'r-1',
      partySize: 4,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 90 * 60_000),
      customerName: 'Jean Test',
      customerPhone: '+33600000000',
      channel: 'MCP' as const,
      policy,
      actor: 'agent:test',
    };
    const idempotency = {
      scope: 'scope-replay',
      key: 'key-replay',
      payloadHash: hashPayload({ replay: true, startsAt }),
      ttlSeconds: 300,
    };

    const first = await fakes.reservationsService.createReservation(input, idempotency);
    const holdCount = fakes.holds.size;
    const reservationCount = fakes.reservations.size;
    const auditCount = fakes.audits.length;

    const replay = await fakes.reservationsService.createReservation(input, idempotency);

    expect(replay).toEqual({
      reservationId: first.reservationId,
      state: first.state,
      reused: true,
    });
    expect(fakes.holds.size).toBe(holdCount);
    expect(fakes.reservations.size).toBe(reservationCount);
    expect(fakes.audits).toHaveLength(auditCount);
  });

  it('rejoue avant de revalider un hold déjà consommé', async () => {
    const fakes = makeFakes();
    const startsAt = new Date(Date.now() + 3_600_000);
    const endsAt = new Date(startsAt.getTime() + 90 * 60_000);
    const holdToken = 'test';
    const hold: HoldRow = {
      id: 'hold-replay',
      restaurantId: 'r-1',
      type: 'HOLD',
      partySize: 4,
      slotStart: startsAt,
      slotEnd: endsAt,
      channel: 'MCP',
      holdToken,
      quoteToken: null,
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: null,
      status: 'ACTIVE',
      policyVersion: policy.policyVersion,
      reservationId: null,
      tableId: null,
      createdAt: new Date(),
    };
    fakes.holds.set(hold.id, hold);
    const findActiveByToken = vi
      .spyOn(fakes.holdService, 'findActiveByToken')
      .mockResolvedValueOnce(hold as never)
      .mockResolvedValue(null);
    const input = {
      restaurantId: 'r-1',
      partySize: 4,
      startsAt,
      endsAt,
      customerName: 'Jean Test',
      customerPhone: '+33600000000',
      channel: 'MCP' as const,
      policy,
      actor: 'agent:test',
      holdToken,
    };
    const idempotency = {
      scope: 'scope-replay-with-hold',
      key: 'key-replay-with-hold',
      payloadHash: hashPayload({ replayWithHold: true, startsAt, holdToken }),
      ttlSeconds: 300,
    };

    const first = await fakes.reservationsService.createReservation(input, idempotency);
    const auditCount = fakes.audits.length;
    expect(hold.status).toBe('CONSUMED');

    const replay = await fakes.reservationsService.createReservation(input, idempotency);

    expect(replay).toEqual({
      reservationId: first.reservationId,
      state: first.state,
      reused: true,
    });
    expect(findActiveByToken).toHaveBeenCalledTimes(1);
    expect(fakes.reservations.size).toBe(1);
    expect(fakes.holds.size).toBe(1);
    expect(fakes.audits).toHaveLength(auditCount);
  });

  it('invalide le cache après une transition qui libère la capacité', async () => {
    const fakes = makeFakes();
    const reservation = {
      id: 'res-transition',
      restaurantId: 'r-1',
      partySize: 4,
      reservedAt: new Date(Date.now() + 3_600_000),
      startsAt: new Date(Date.now() + 3_600_000),
      endsAt: new Date(Date.now() + 5_400_000),
      tableId: null,
      state: 'CONFIRMED' as const,
      status: 'CONFIRMED' as const,
      consumedHoldId: null,
    };
    fakes.reservations.set(reservation.id, reservation);
    const invalidate = vi
      .spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability')
      .mockResolvedValue(undefined);

    await fakes.reservationsService.transitionState({
      reservationId: reservation.id,
      restaurantId: 'r-1',
      toState: 'FAILED',
      actor: 'agent:test',
    });

    expect(reservation.state).toBe('FAILED');
    expect(reservation.status).toBe('CONFIRMED');
    expect(invalidate).toHaveBeenCalledWith('r-1');
    expect(fakes.audits).toContainEqual(
      expect.objectContaining({
        event: 'reservation_failed',
        fromState: 'CONFIRMED',
        toState: 'FAILED',
      }),
    );
    invalidate.mockRestore();
  });

  it('crée une réservation test sans client CRM, attribution ni carte cadeau', async () => {
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(true);
    const lookupOrCreate = vi
      .spyOn(CustomerService, 'lookupOrCreate')
      .mockResolvedValue({ id: 'customer-1' } as never);
    const recordEvent = vi
      .spyOn(CustomerService, 'recordReservationEvent')
      .mockResolvedValue(undefined as never);
    const attribution = vi
      .spyOn(marketingAttribution, 'recordMarketingAttributionClick')
      .mockResolvedValue(null as never);
    const conversion = vi
      .spyOn(marketingAttribution, 'recordMarketingConversion')
      .mockResolvedValue(undefined as never);
    const giftCard = vi
      .spyOn(GiftCardService.prototype, 'associateToReservation')
      .mockResolvedValue({} as never);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      const result = await fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Jean Test',
          customerPhone: '+33600000000',
          channel: 'WEB',
          policy,
          actor: 'connect:web',
          isTest: true,
          marketingAttributionToken: 'x'.repeat(40),
          giftCardCode: 'GIFT-1',
          giftCardReservationAmount: 50,
        },
        {
          scope: 'web:test',
          key: 'key-test',
          payloadHash: hashPayload({ test: true, startsAt }),
          ttlSeconds: 300,
        },
      );

      expect(result.reused).toBe(false);
      expect(result.giftCardApplication).toBeUndefined();
      expect(fakes.createdReservationData).toHaveLength(1);
      expect(fakes.createdReservationData[0]).toMatchObject({ isTest: true });
      expect(fakes.createdReservationData[0]).not.toHaveProperty('customerId');
      expect(lookupOrCreate).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
      expect(attribution).not.toHaveBeenCalled();
      expect(conversion).not.toHaveBeenCalled();
      expect(giftCard).not.toHaveBeenCalled();
      expect(intent).toHaveBeenCalledTimes(1);
      expect(fakes.audits.map((audit) => audit.event)).toContain('reservation_created');
    } finally {
      intent.mockRestore();
      lookupOrCreate.mockRestore();
      recordEvent.mockRestore();
      attribution.mockRestore();
      conversion.mockRestore();
      giftCard.mockRestore();
    }
  });

  it('confirme une réservation test même si le restaurant valide à la main', async () => {
    const intent = vi
      .spyOn(confirmationOutbox, 'enqueueReservationConfirmation')
      .mockResolvedValue(true);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      const result = await fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Jean Test',
          customerPhone: '+33600000000',
          channel: 'WEB',
          policy: { ...policy, requireManualValidation: true },
          actor: 'connect:web',
          isTest: true,
        },
        {
          scope: 'web:test',
          key: 'key-test-manual',
          payloadHash: hashPayload({ test: true, manual: true, startsAt }),
          ttlSeconds: 300,
        },
      );

      expect(result.state).toBe('CONFIRMED');
      expect([...fakes.reservations.values()][0].state).toBe('CONFIRMED');
      expect(intent).toHaveBeenCalledTimes(1);
    } finally {
      intent.mockRestore();
    }
  });

  it('ne marque pas une réservation réelle comme test', async () => {
    const lookupOrCreate = vi
      .spyOn(CustomerService, 'lookupOrCreate')
      .mockResolvedValue({ id: 'customer-1' } as never);
    try {
      const fakes = makeFakes();
      const startsAt = new Date(Date.now() + 3_600_000);
      await fakes.reservationsService.createReservation(
        {
          restaurantId: 'r-1',
          partySize: 2,
          startsAt,
          endsAt: new Date(startsAt.getTime() + 90 * 60_000),
          customerName: 'Jean Test',
          customerPhone: '+33600000000',
          channel: 'WEB',
          policy,
          actor: 'connect:web',
        },
        {
          scope: 'web:real',
          key: 'key-real',
          payloadHash: hashPayload({ real: true, startsAt }),
          ttlSeconds: 300,
        },
      );
      expect(lookupOrCreate).toHaveBeenCalledTimes(1);
      expect(fakes.createdReservationData[0]).toMatchObject({ customerId: 'customer-1' });
      expect(fakes.createdReservationData[0]).not.toHaveProperty('isTest');
    } finally {
      lookupOrCreate.mockRestore();
    }
  });
});
