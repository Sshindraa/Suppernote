/**
 * Tests de concurrence et de fallback Redis down.
 *
 * Tourne contre la vraie DB locale Postgres (DATABASE_URL dans
 * packages/database/.env). Ces tests sont marqués `integration` et
 * exclus par défaut ; ils sont exécutés par le script `pnpm test:int`.
 *
 * Pré-requis : avoir appliqué les migrations Phase 0 et créé un
 * restaurant de test.
 *
 * Le mock Prisma global (src/test/setup.ts) est bypass via vi.unmock
 * pour avoir accès aux vraies tables idempotency_records, agentic_holds,
 * reservation_audit_log, etc.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('@prisma/client');

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { HoldConflictError, HoldService } from '../core/hold.service.js';
import { AuditLogService } from '../core/audit-log.service.js';
import { buildPolicySnapshot } from '../core/policies.service.js';
import { PrismaIdempotencyStore } from '../core/prisma-store.js';
import {
  IdempotencyService,
  computeIdempotencyScope,
  hashPayload,
} from '../core/idempotency.service.js';
import {
  ReservationService,
  ReservationSlotUnavailableError,
} from '../core/reservation.service.js';
import { ReservationService as LegacyReservationService } from '../../reservations/reservation.service';
import {
  compareReservationContractResults,
  normalizeReservationContractResult,
} from '../../reservations/contract-shadow-harness';
import {
  creationProjection,
  isConfirmedReservation,
  isReservationState,
  type CreatableReservationState,
} from '../../../shared/reservations/reservation-state';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service.js';
import { TableAllocationService } from '../../floor-plan/table-allocation.service.js';
import { ConsentService } from '../../rgpd/consent.service.js';
import Fastify from 'fastify';
import { connectRoutes } from '../../connect/connect.routes';

const prisma = new PrismaClient();
const audit = new AuditLogService(prisma);
const holds = new HoldService(prisma, audit);
const idemStore = new PrismaIdempotencyStore(prisma);
const idem = new IdempotencyService(idemStore);
const runIntegration = process.env.AGENTIC_INT_TESTS === '1';
const describeIntegration = runIntegration ? describe : describe.skip;

let testRestaurantId: string;
let testFloorPlanId: string;
let testTableId: string;

const policy = buildPolicySnapshot({
  policyVersion: '2026-06-20',
  maxPartySize: 12,
  minLeadTimeMinutes: 30,
  requireManualValidation: false,
  quoteTtlSeconds: 300,
  holdTtlSeconds: 420,
  noShowPolicy: 'warning',
  notificationChannels: ['sms'],
  capacitySpecials: {},
});

const ACTIVE_RESERVATION_STATES = ['PENDING', 'CONFIRMED', 'SEATED'] as const;
type ActiveReservationState = (typeof ACTIVE_RESERVATION_STATES)[number];

/** Même grille que `policy`, avec la validation manuelle activée. */
const manualValidationPolicy = buildPolicySnapshot({
  policyVersion: '2026-06-20',
  maxPartySize: 12,
  minLeadTimeMinutes: 30,
  requireManualValidation: true,
  quoteTtlSeconds: 300,
  holdTtlSeconds: 420,
  noShowPolicy: 'warning',
  notificationChannels: ['sms'],
  capacitySpecials: {},
});

/** Numéros déterministes et uniques par exécution (pas de collision intra-run). */
let parityPhoneOffset = 0;

function parityPhone(): string {
  parityPhoneOffset += 1;
  return `+3360000${String(parityPhoneOffset).padStart(4, '0')}`;
}

function parityIdempotency(seed: string) {
  return {
    scope: `${testRestaurantId}:parity:${seed}`,
    key: `parity-${seed}`,
    payloadHash: hashPayload({ seed }),
    ttlSeconds: 60,
  };
}

let capacitySlotOffset = 0;

function nextCapacitySlot(): { date: string; startsAt: Date; endsAt: Date } {
  const startsAt = new Date(Date.UTC(2099, 5, 5 + capacitySlotOffset, 17, 0, 0));
  capacitySlotOffset += 1;
  return {
    date: startsAt.toISOString().slice(0, 10),
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
  };
}

async function createCapacityReservation(args: {
  state: ActiveReservationState;
  tableId: string | null;
  startsAt: Date;
  endsAt: Date;
}): Promise<string> {
  const id = `capacity-reservation-${randomUUID()}`;
  await prisma.reservation.create({
    data: {
      id,
      restaurantId: testRestaurantId,
      reservedAt: args.startsAt,
      partySize: 4,
      customerName: 'Capacity test',
      customerPhone: '+33600000000',
      channel: 'MCP',
      state: args.state,
      status: args.state === 'SEATED' ? 'SEATED' : 'CONFIRMED',
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      createdByClient: 'test:capacity',
      consents: {},
      privacyPolicyVersion: '2026-06-20',
      tableId: args.tableId,
    },
  });
  return id;
}

async function createCapacityHold(args: {
  tableId: string | null;
  startsAt: Date;
  endsAt: Date;
}): Promise<string> {
  const id = `capacity-hold-${randomUUID()}`;
  await prisma.agenticHold.create({
    data: {
      id,
      restaurantId: testRestaurantId,
      type: 'HOLD',
      partySize: 4,
      slotStart: args.startsAt,
      slotEnd: args.endsAt,
      channel: 'MCP',
      holdToken: `capacity-token-${randomUUID()}`,
      expiresAt: new Date(args.endsAt.getTime() + 10 * 60 * 1000),
      status: 'ACTIVE',
      policyVersion: '2026-06-20',
      tableId: args.tableId,
    },
  });
  return id;
}

async function slotAvailability(
  service: CapacityAwareAvailabilityService,
  date: string,
): Promise<boolean> {
  const result = await service.getAvailability({
    restaurantId: testRestaurantId,
    date,
    partySize: 4,
  });
  const slot = result.slots.find((candidate) => candidate.time === '19:00');
  expect(slot).toBeDefined();
  return slot?.available ?? false;
}

beforeAll(async () => {
  if (!runIntegration) return;
  // Chaque exécution utilise des identifiants uniques. La fixture peut donc
  // tourner plusieurs fois sur la même base sans tenter de supprimer des
  // réservations référencées par l'audit append-only.
  testRestaurantId = `resto-test-concurrency-${randomUUID()}`;
  testFloorPlanId = `floor-plan-test-concurrency-${randomUUID()}`;
  testTableId = `table-test-concurrency-${randomUUID()}`;
  const testPhoneNumber = `+331${Date.now().toString().slice(-8)}`;

  const r = await prisma.restaurant.create({
    data: {
      id: testRestaurantId,
      name: 'Resto Test Concurrency',
      slug: testRestaurantId,
      managerPhone: '+33600000000',
      managerEmail: 'test@example.com',
      phoneNumber: testPhoneNumber,
      openingHours: {
        monday: { open: '00:00', close: '23:59' },
        tuesday: { open: '00:00', close: '23:59' },
        wednesday: { open: '00:00', close: '23:59' },
        thursday: { open: '00:00', close: '23:59' },
        friday: { open: '00:00', close: '23:59' },
        saturday: { open: '00:00', close: '23:59' },
        sunday: { open: '00:00', close: '23:59' },
      },
      agenticOptIn: true,
    },
  });
  testRestaurantId = r.id;

  const floorPlan = await prisma.floorPlan.create({
    data: {
      id: testFloorPlanId,
      restaurantId: testRestaurantId,
      name: 'Plan de test concurrence',
      isDefault: true,
      isActive: true,
    },
  });
  testFloorPlanId = floorPlan.id;

  const table = await prisma.table.create({
    data: {
      id: testTableId,
      floorPlanId: testFloorPlanId,
      name: 'Table test concurrence',
      capacity: 12,
      minCapacity: 1,
      isActive: true,
    },
  });
  expect(table.id).toBe(testTableId);
});

afterAll(async () => {
  if (!runIntegration) return;
  // Les audits sont append-only et empêchent la suppression des réservations
  // qui leur sont liées. Les identifiants uniques isolent la fixture ; la CI
  // détruit la base éphémère en fin de job (et le runbook local supprime le
  // conteneur dédié après validation).
  await prisma.$disconnect();
});

describeIntegration('concurrency — partial unique index enforcement', () => {
  it('1000 req simultanées sur le même slot → 1 seul hold, 999 conflits', async () => {
    const slotStart = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);

    // Cleanup avant test
    await prisma.agenticHold.deleteMany({
      where: {
        restaurantId: testRestaurantId,
        slotStart,
        type: 'HOLD',
      },
    });

    const promises = Array.from({ length: 1000 }, () =>
      holds
        .createHold({
          restaurantId: testRestaurantId,
          partySize: 4,
          slotStart,
          slotEnd,
          channel: 'MCP',
          policy,
          actor: 'agent:concurrency-test',
        })
        .then(() => 'ok' as const)
        .catch((err) => {
          if (err instanceof HoldConflictError) return 'conflict' as const;
          throw err;
        }),
    );

    const results = await Promise.all(promises);
    const oks = results.filter((r) => r === 'ok').length;
    const conflicts = results.filter((r) => r === 'conflict').length;

    expect(oks).toBe(1);
    expect(conflicts).toBe(999);
    expect(oks + conflicts).toBe(1000);

    // Vérifie qu'il n'y a bien qu'un seul hold ACTIVE en DB
    const activeCount = await prisma.agenticHold.count({
      where: {
        restaurantId: testRestaurantId,
        slotStart,
        type: 'HOLD',
        status: 'ACTIVE',
      },
    });
    expect(activeCount).toBe(1);
  }, 30_000);

  it('après expiration du premier hold, un nouveau hold peut être créé', async () => {
    const slotStart = new Date(Date.now() + 48 * 60 * 60 * 1000);
    const slotEnd = new Date(slotStart.getTime() + 90 * 60 * 1000);

    await prisma.agenticHold.deleteMany({
      where: { restaurantId: testRestaurantId, slotStart, type: 'HOLD' },
    });

    const h1 = await holds.createHold({
      restaurantId: testRestaurantId,
      partySize: 2,
      slotStart,
      slotEnd,
      channel: 'MCP',
      policy,
      actor: 'agent:test1',
    });
    expect(h1.status).toBe('ACTIVE');

    // Force expiration
    await prisma.agenticHold.update({
      where: { id: h1.id },
      data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
    });

    // Nouveau hold doit passer
    const h2 = await holds.createHold({
      restaurantId: testRestaurantId,
      partySize: 2,
      slotStart,
      slotEnd,
      channel: 'MCP',
      policy,
      actor: 'agent:test2',
    });
    expect(h2.status).toBe('ACTIVE');
    expect(h2.id).not.toBe(h1.id);
  });
});

describeIntegration('concurrency — un créneau gardé bloque une table, pas le restaurant', () => {
  const TABLE_COUNT = 3;
  let multiRestaurantId: string;
  let multiTableIds: string[];

  beforeAll(async () => {
    multiRestaurantId = `resto-test-multi-table-${randomUUID()}`;
    const floorPlanId = `floor-plan-test-multi-table-${randomUUID()}`;
    await prisma.restaurant.create({
      data: {
        id: multiRestaurantId,
        name: 'Resto Test Multi Tables',
        slug: multiRestaurantId,
        managerPhone: '+33600000001',
        managerEmail: 'multi@example.com',
        phoneNumber: `+332${Date.now().toString().slice(-8)}`,
        openingHours: {
          monday: { open: '00:00', close: '23:59' },
          tuesday: { open: '00:00', close: '23:59' },
          wednesday: { open: '00:00', close: '23:59' },
          thursday: { open: '00:00', close: '23:59' },
          friday: { open: '00:00', close: '23:59' },
          saturday: { open: '00:00', close: '23:59' },
          sunday: { open: '00:00', close: '23:59' },
        },
        agenticOptIn: true,
      },
    });
    await prisma.floorPlan.create({
      data: {
        id: floorPlanId,
        restaurantId: multiRestaurantId,
        name: 'Plan multi tables',
        isDefault: true,
        isActive: true,
      },
    });
    multiTableIds = [];
    for (let index = 0; index < TABLE_COUNT; index++) {
      const id = `table-test-multi-${index}-${randomUUID()}`;
      multiTableIds.push(id);
      await prisma.table.create({
        data: {
          id,
          floorPlanId,
          name: `Table ${index + 1}`,
          capacity: 2,
          minCapacity: 1,
          isActive: true,
        },
      });
    }
  });

  function holdOnce(slotStart: Date, partySize = 2) {
    return holds
      .createHold({
        restaurantId: multiRestaurantId,
        partySize,
        slotStart,
        slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
        channel: 'MCP',
        policy,
        actor: 'agent:multi-table-test',
      })
      .then((hold) => ({ outcome: 'ok' as const, hold }))
      .catch((err) => {
        if (err instanceof HoldConflictError) return { outcome: 'conflict' as const };
        throw err;
      });
  }

  it('refuse une section préférée d’un autre restaurant sur PostgreSQL', async () => {
    const plan = await prisma.floorPlan.findFirstOrThrow({
      where: { restaurantId: multiRestaurantId },
    });
    const section = await prisma.section.create({
      data: { floorPlanId: plan.id, name: 'Étrangère' },
    });
    await prisma.table.update({ where: { id: multiTableIds[0] }, data: { sectionId: section.id } });
    const slotStart = new Date('2099-09-09T19:00:00Z');
    const hold = await holds.createHold({
      restaurantId: testRestaurantId,
      partySize: 2,
      slotStart,
      slotEnd: new Date(slotStart.getTime() + 90 * 60_000),
      channel: 'WEB',
      policy,
      actor: 'test:cross-tenant',
      preferredSectionId: section.id,
    });
    expect(hold.tableId).toBe(testTableId);
    const foreignStart = new Date('2099-09-09T21:00:00Z');
    await expect(
      new ReservationService(prisma, audit, holds, idem).createReservation(
        {
          restaurantId: testRestaurantId,
          partySize: 2,
          startsAt: foreignStart,
          endsAt: new Date(foreignStart.getTime() + 90 * 60_000),
          customerName: 'Client',
          customerPhone: parityPhone(),
          channel: 'MCP',
          actor: 'test:cross-tenant',
          policy,
          tableId: multiTableIds[0],
        },
        {
          scope: `${testRestaurantId}:foreign-table`,
          key: randomUUID(),
          payloadHash: hashPayload({ foreignStart }),
          ttlSeconds: 60,
        },
      ),
    ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
  });

  it('deux clients, même heure et mêmes couverts : chacun obtient sa table', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 1, 19, 0, 0));
    const first = await holdOnce(slotStart);
    const second = await holdOnce(slotStart);

    expect(first.outcome).toBe('ok');
    expect(second.outcome).toBe('ok');
    if (first.outcome === 'ok' && second.outcome === 'ok') {
      expect(first.hold.tableId).not.toBe(second.hold.tableId);
    }
  });

  it('confirme deux holds simultanés de même taille sur deux tables distinctes', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 10, 19));
    const first = await holdOnce(slotStart);
    const second = await holdOnce(slotStart);
    if (first.outcome !== 'ok' || second.outcome !== 'ok') throw new Error('hold creation failed');
    const service = new ReservationService(prisma, audit, holds, idem);
    const results = await Promise.all(
      [first.hold, second.hold].map((hold, index) =>
        service.createReservation(
          {
            restaurantId: multiRestaurantId,
            partySize: 2,
            startsAt: slotStart,
            endsAt: hold.slotEnd,
            customerName: `Client ${index}`,
            customerPhone: parityPhone(),
            channel: 'MCP',
            actor: 'test:multi-confirm',
            policy,
            tableId: hold.tableId,
            holdToken: hold.holdToken!,
          },
          {
            scope: `${multiRestaurantId}:audit:${hold.id}`,
            key: hold.id,
            payloadHash: hashPayload({ holdId: hold.id }),
            ttlSeconds: 60,
          },
        ),
      ),
    );
    const created = await prisma.reservation.findMany({
      where: { id: { in: results.map((r) => r.reservationId) } },
    });
    expect(created).toHaveLength(2);
    expect(new Set(created.map((row) => row.tableId)).size).toBe(2);
  });

  it('rejoue une confirmation publique perdue sans créer deux réservations ou consentements', async () => {
    await prisma.restaurant.update({
      where: { id: multiRestaurantId },
      data: { publishedAt: new Date() },
    });
    await prisma.restaurantExposureSettings.upsert({
      where: { restaurantId: multiRestaurantId },
      create: { restaurantId: multiRestaurantId, connectPublished: true },
      update: { connectPublished: true },
    });
    const held = await holdOnce(new Date('2099-09-20T19:00:00Z'));
    if (held.outcome !== 'ok') throw new Error('hold creation failed');
    expect((await holdOnce(held.hold.slotStart)).outcome).toBe('ok');
    expect((await holdOnce(held.hold.slotStart)).outcome).toBe('ok');
    const app = Fastify();
    const analytics = vi.fn();
    app.decorate('queues', {
      connectAnalytics: { add: analytics },
    } as unknown as typeof app.queues);
    await app.register(connectRoutes);
    const payload = {
      holdToken: held.hold.holdToken,
      customer: { firstName: 'Client', phone: parityPhone() },
      specialRequests: 'Terrasse',
    };
    try {
      const [first, parallel] = await Promise.all([
        app.inject({ method: 'POST', url: `/public/r/${multiRestaurantId}/confirm`, payload }),
        app.inject({ method: 'POST', url: `/public/r/${multiRestaurantId}/confirm`, payload }),
      ]);
      expect(first.statusCode).toBe(200);
      expect(parallel.statusCode).toBe(200);
      expect(parallel.json().reservationId).toBe(first.json().reservationId);
      const replay = await app.inject({
        method: 'POST',
        url: `/public/r/${multiRestaurantId}/confirm`,
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({
        reservationId: first.json().reservationId,
        reused: true,
      });
      const changed = await app.inject({
        method: 'POST',
        url: `/public/r/${multiRestaurantId}/confirm`,
        payload: { ...payload, specialRequests: 'Intérieur' },
      });
      expect(changed.statusCode).toBe(409);
      expect(await prisma.reservation.count({ where: { consumedHoldId: held.hold.id } })).toBe(1);
      expect(
        await prisma.customerConsent.count({
          where: {
            restaurantId: multiRestaurantId,
            subjectHash: ConsentService.hashSubject(payload.customer.phone),
          },
        }),
      ).toBe(1);
      expect(analytics).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('annule le consentement et la réservation ensemble si la transaction échoue', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 17, 19));
    const held = await holdOnce(slotStart);
    if (held.outcome !== 'ok') throw new Error('hold creation failed');
    const before = await prisma.customerConsent.count({
      where: { restaurantId: multiRestaurantId },
    });
    const service = new ReservationService(prisma, audit, holds, idem);
    await expect(
      service.createReservation(
        {
          restaurantId: multiRestaurantId,
          partySize: 2,
          startsAt: slotStart,
          endsAt: held.hold.slotEnd,
          customerName: 'Client',
          customerPhone: parityPhone(),
          channel: 'WEB',
          actor: 'connect:web',
          policy,
          tableId: held.hold.tableId,
          holdToken: held.hold.holdToken!,
          beforeCreate: async (tx) => {
            await new ConsentService(tx).recordConsent({
              restaurantId: multiRestaurantId,
              customerId: null,
              reservationId: null,
              subject: '+33600000000',
              channel: 'WEB',
              context: 'web_booking_intent',
              consents: { reservationProcessing: true },
            });
            throw new Error('transaction failed');
          },
        },
        {
          scope: `${multiRestaurantId}:audit:rollback`,
          key: randomUUID(),
          payloadHash: hashPayload({ holdId: held.hold.id }),
          ttlSeconds: 60,
        },
      ),
    ).rejects.toThrow('transaction failed');
    expect(await prisma.customerConsent.count({ where: { restaurantId: multiRestaurantId } })).toBe(
      before,
    );
    expect(await prisma.reservation.count({ where: { consumedHoldId: held.hold.id } })).toBe(0);
    expect(
      (await prisma.agenticHold.findUniqueOrThrow({ where: { id: held.hold.id } })).status,
    ).toBe('ACTIVE');
  });

  it('sérialise deux changements de couverts vers la dernière grande table', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 11, 19));
    const slotEnd = new Date(slotStart.getTime() + 90 * 60_000);
    const plan = await prisma.floorPlan.findFirstOrThrow({
      where: { restaurantId: multiRestaurantId },
    });
    const large = await prisma.table.create({
      data: { floorPlanId: plan.id, name: 'Grande', capacity: 4, minCapacity: 1, isActive: true },
    });
    const rows = await Promise.all(
      multiTableIds.slice(0, 2).map((tableId, index) =>
        prisma.reservation.create({
          data: {
            restaurantId: multiRestaurantId,
            tableId,
            reservedAt: slotStart,
            startsAt: slotStart,
            endsAt: slotEnd,
            partySize: 2,
            customerName: `Client ${index}`,
            state: 'CONFIRMED',
            status: 'CONFIRMED',
          },
        }),
      ),
    );
    const results = await Promise.allSettled(
      rows.map((row) =>
        LegacyReservationService.update(row.id, multiRestaurantId, {
          partySize: 4,
          customerName: 'Modifié',
        }),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const stored = await prisma.reservation.findMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    expect(
      stored.filter(
        (row) => row.tableId === large.id && row.partySize === 4 && row.customerName === 'Modifié',
      ),
    ).toHaveLength(1);
    expect(
      stored.filter((row) => row.partySize === 2 && row.customerName !== 'Modifié'),
    ).toHaveLength(1);
    await prisma.table.update({ where: { id: large.id }, data: { isActive: false } });
  });

  it('attribue une seule table lors de deux demandes simultanées pour une réservation sans table', async () => {
    const start = new Date(Date.UTC(2099, 8, 12, 19));
    const row = await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        reservedAt: start,
        startsAt: start,
        endsAt: new Date(start.getTime() + 90 * 60_000),
        partySize: 2,
        customerName: 'Client',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    const results = await Promise.all([
      LegacyReservationService.allocateTable(row.id, multiRestaurantId),
      LegacyReservationService.allocateTable(row.id, multiRestaurantId),
    ]);
    expect(results[0].tableId).toBeTruthy();
    expect(results[1].tableId).toBe(results[0].tableId);
  });

  it('garde statut, nom et couverts atomiques dans la modification historique', async () => {
    const start = new Date(Date.UTC(2099, 8, 13, 19));
    const row = await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        tableId: multiTableIds[0],
        reservedAt: start,
        startsAt: start,
        endsAt: new Date(start.getTime() + 90 * 60_000),
        partySize: 2,
        customerName: 'Avant',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    const result = await LegacyReservationService.update(row.id, multiRestaurantId, {
      status: 'CANCELLED',
      partySize: 4,
      customerName: 'Après',
    });
    expect(result).toMatchObject({
      state: 'CANCELLED',
      status: 'CANCELLED',
      partySize: 4,
      customerName: 'Après',
    });
  });

  it('ne change aucun champ si les nouveaux couverts ne tiennent sur aucune table', async () => {
    const start = new Date(Date.UTC(2099, 8, 18, 19));
    const row = await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        tableId: multiTableIds[0],
        reservedAt: start,
        startsAt: start,
        endsAt: new Date(start.getTime() + 90 * 60_000),
        partySize: 2,
        customerName: 'Avant',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    await expect(
      LegacyReservationService.update(row.id, multiRestaurantId, {
        status: 'CONFIRMED',
        partySize: 20,
        customerName: 'Après',
      }),
    ).rejects.toThrow('SLOT_NOT_AVAILABLE');
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      state: 'CONFIRMED',
      status: 'CONFIRMED',
      partySize: 2,
      customerName: 'Avant',
      tableId: multiTableIds[0],
    });
  });

  it('refuse de marquer installée une réservation dont la table est trop petite', async () => {
    const start = new Date(Date.now() + 60 * 60_000);
    const row = await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        tableId: multiTableIds[0],
        reservedAt: start,
        startsAt: start,
        endsAt: new Date(start.getTime() + 90 * 60_000),
        partySize: 2,
        customerName: 'Avant',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    await expect(
      LegacyReservationService.update(row.id, multiRestaurantId, {
        status: 'SEATED',
        partySize: 4,
        customerName: 'Après',
      }),
    ).rejects.toThrow('SLOT_NOT_AVAILABLE');
    expect(await prisma.reservation.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      state: 'CONFIRMED',
      status: 'CONFIRMED',
      partySize: 2,
      customerName: 'Avant',
      tableId: multiTableIds[0],
    });
  });

  it('reconstruit la durée historique même au passage de minuit', async () => {
    const start = new Date('2099-09-14T21:30:00Z');
    await prisma.restaurantExposureSettings.upsert({
      where: { restaurantId: multiRestaurantId },
      create: { restaurantId: multiRestaurantId, capacitySpecials: { serviceDurationMinutes: 90 } },
      update: { capacitySpecials: { serviceDurationMinutes: 90 } },
    });
    const row = await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        tableId: multiTableIds[0],
        reservedAt: start,
        startsAt: null,
        endsAt: null,
        partySize: 2,
        customerName: 'Ancienne',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    const allocation = new TableAllocationService(prisma);
    const interval = {
      startsAt: new Date('2099-09-14T22:30:00Z'),
      endsAt: new Date('2099-09-14T23:00:00Z'),
    };
    expect(await allocation.isTableAvailable({ tableId: multiTableIds[0], ...interval })).toBe(
      false,
    );
    expect(
      await allocation.isTableAvailable({
        tableId: multiTableIds[0],
        startsAt: new Date('2099-09-14T23:00:00Z'),
        endsAt: new Date('2099-09-15T00:00:00Z'),
      }),
    ).toBe(true);
    await prisma.reservation.update({ where: { id: row.id }, data: { tableId: null } });
    const allocate = () =>
      prisma.$transaction((tx) =>
        allocation.allocate({ restaurantId: multiRestaurantId, partySize: 2, ...interval }, tx),
      );
    // Sans table, l'ancienne réservation n'occupe qu'une table : il en reste une pour le candidat.
    expect(await allocate()).not.toBeNull();
    // Les autres tables prises, sa durée reconstruite au-delà de minuit occupe la dernière.
    await prisma.reservation.createMany({
      data: multiTableIds.slice(1).map((tableId) => ({
        restaurantId: multiRestaurantId,
        tableId,
        reservedAt: interval.startsAt,
        startsAt: interval.startsAt,
        endsAt: interval.endsAt,
        partySize: 2,
        customerName: 'Occupée',
        state: 'CONFIRMED' as const,
        status: 'CONFIRMED' as const,
      })),
    });
    expect(await allocate()).toBeNull();
  });

  it('ignore les réservations test avec et sans table dans les contrôles de capacité', async () => {
    const start = new Date('2099-09-16T19:00:00Z');
    const end = new Date(start.getTime() + 90 * 60_000);
    for (const tableId of [null, multiTableIds[0]]) {
      await prisma.reservation.create({
        data: {
          restaurantId: multiRestaurantId,
          tableId,
          reservedAt: start,
          startsAt: start,
          endsAt: end,
          partySize: 2,
          customerName: 'Test',
          isTest: true,
          state: 'CONFIRMED',
          status: 'CONFIRMED',
        },
      });
    }
    const allocation = new TableAllocationService(prisma);
    expect(
      await allocation.isTableAvailable({
        tableId: multiTableIds[0],
        startsAt: start,
        endsAt: end,
      }),
    ).toBe(true);
    const candidate = await prisma.$transaction((tx) =>
      allocation.allocate(
        { restaurantId: multiRestaurantId, partySize: 2, startsAt: start, endsAt: end },
        tx,
      ),
    );
    expect(candidate).toBeTruthy();
    const available = await new CapacityAwareAvailabilityService(prisma).getAvailability({
      restaurantId: multiRestaurantId,
      date: '2099-09-16',
      partySize: 2,
    });
    expect(available.slots.find((slot) => slot.time === '21:00')?.available).toBe(true);
    const service = new ReservationService(prisma, audit, holds, idem);
    const created = await service.createReservation(
      {
        restaurantId: multiRestaurantId,
        partySize: 2,
        startsAt: start,
        endsAt: end,
        customerName: 'Client réel',
        customerPhone: parityPhone(),
        channel: 'MCP',
        actor: 'test:real-after-test',
        policy,
      },
      {
        scope: `${multiRestaurantId}:real-after-test`,
        key: randomUUID(),
        payloadHash: hashPayload({ startsAt: start }),
        ttlSeconds: 60,
      },
    );
    expect(created.reservationId).toBeTruthy();
  });

  it('reste conservateur pour une nouvelle réservation sans table', async () => {
    const start = new Date('2099-09-19T19:00:00Z');
    const end = new Date(start.getTime() + 90 * 60_000);
    await prisma.reservation.create({
      data: {
        restaurantId: multiRestaurantId,
        tableId: multiTableIds[0],
        reservedAt: start,
        startsAt: start,
        endsAt: end,
        partySize: 2,
        customerName: 'Déjà réservé',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    const service = new ReservationService(prisma, audit, holds, idem);
    await expect(
      service.createReservation(
        {
          restaurantId: multiRestaurantId,
          partySize: 3,
          startsAt: start,
          endsAt: end,
          customerName: 'Sans table',
          customerPhone: parityPhone(),
          channel: 'MCP',
          actor: 'test:unassigned',
          policy,
        },
        {
          scope: `${multiRestaurantId}:unassigned`,
          key: randomUUID(),
          payloadHash: hashPayload({ startsAt: start }),
          ttlSeconds: 60,
        },
      ),
    ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
  });

  it('30 requêtes simultanées pour 3 tables : exactement 3 holds, sur 3 tables distinctes', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 2, 19, 0, 0));
    const results = await Promise.all(Array.from({ length: 30 }, () => holdOnce(slotStart)));

    const oks = results.filter((result) => result.outcome === 'ok');
    expect(oks).toHaveLength(TABLE_COUNT);
    expect(results.filter((result) => result.outcome === 'conflict')).toHaveLength(
      30 - TABLE_COUNT,
    );
    const tables = new Set(
      oks.map((result) => (result.outcome === 'ok' ? result.hold.tableId : '')),
    );
    expect(tables.size).toBe(TABLE_COUNT);
  }, 30_000);

  it('une même table ne porte jamais deux holds actifs à la même heure (index en base)', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 3, 19, 0, 0));
    const base = {
      restaurantId: multiRestaurantId,
      type: 'HOLD' as const,
      partySize: 2,
      slotStart,
      slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
      channel: 'MCP' as const,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      policyVersion: 'test',
      tableId: multiTableIds[0],
    };
    await prisma.agenticHold.create({ data: base });

    await expect(
      prisma.agenticHold.create({ data: { ...base, partySize: 4 } }),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
    // Une autre table, même heure, même nombre de couverts : accepté.
    await expect(
      prisma.agenticHold.create({ data: { ...base, tableId: multiTableIds[1] } }),
    ).resolves.toBeTruthy();
  });

  it('un hold historique sans table garde l’ancienne règle (un par heure et couverts)', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 4, 19, 0, 0));
    const base = {
      restaurantId: multiRestaurantId,
      type: 'HOLD' as const,
      partySize: 2,
      slotStart,
      slotEnd: new Date(slotStart.getTime() + 90 * 60 * 1000),
      channel: 'MCP' as const,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
      policyVersion: 'test',
      tableId: null,
    };
    await prisma.agenticHold.create({ data: base });
    await expect(prisma.agenticHold.create({ data: base })).rejects.toMatchObject({
      code: 'P2002',
    });
  });

  it('un hold expiré libère sa table pour le suivant', async () => {
    const slotStart = new Date(Date.UTC(2099, 8, 5, 19, 0, 0));
    const results = await Promise.all(
      Array.from({ length: TABLE_COUNT }, () => holdOnce(slotStart)),
    );
    expect(results.every((result) => result.outcome === 'ok')).toBe(true);
    const one = results[0];
    if (one?.outcome !== 'ok') throw new Error('hold attendu');

    expect((await holdOnce(slotStart)).outcome).toBe('conflict');
    await prisma.agenticHold.update({
      where: { id: one.hold.id },
      data: { status: 'EXPIRED', expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await holdOnce(slotStart)).outcome).toBe('ok');
  });
});

describeIntegration('idempotency — partial unique index on (scope, key)', () => {
  it('mêmes scope+key : 1 seule résa créée, N renvoient le même résultat', async () => {
    const scope = computeIdempotencyScope({
      restaurantId: testRestaurantId,
      channel: 'MCP',
      clientId: 'concurrency-test',
    });
    const key = 'idem-test-key-1';
    const payload = { partySize: 4, startsAt: '2026-12-01T19:00:00Z' };
    const payloadHash = hashPayload(payload);

    // Cleanup
    await prisma.idempotencyRecord.deleteMany({ where: { scope, key } });
    await prisma.reservation.deleteMany({
      where: { restaurantId: testRestaurantId, idempotencyScope: scope, idempotencyKey: key },
    });

    const attempts = Array.from({ length: 50 }, async () => {
      const result = await idem.reserve({ scope, key, payloadHash, ttlSeconds: 60 });
      return result;
    });

    const results = await Promise.all(attempts);
    const reserved = results.filter((r) => r === 'reserved').length;
    const reused = results.filter((r) => r === 'reused').length;
    expect(reserved).toBe(1);
    expect(reused).toBe(49);
    expect(reserved + reused).toBe(50);
  });

  it('mêmes scope+key mais payload différent → IdempotencyConflictError', async () => {
    const scope = computeIdempotencyScope({
      restaurantId: testRestaurantId,
      channel: 'MCP',
      clientId: 'conflict-test',
    });
    const key = 'idem-conflict-key';
    const payload1 = { partySize: 2, startsAt: '2026-12-02T19:00:00Z' };
    const payload2 = { partySize: 4, startsAt: '2026-12-02T19:00:00Z' };
    const hash1 = hashPayload(payload1);
    const hash2 = hashPayload(payload2);

    await prisma.idempotencyRecord.deleteMany({ where: { scope, key } });

    // Premier insert
    await idem.reserve({ scope, key, payloadHash: hash1, ttlSeconds: 60 });
    await idem.complete({ scope, key, payloadHash: hash1, reservationId: 'fake-res' });

    // Deuxième insert avec payload différent
    await expect(idem.reserve({ scope, key, payloadHash: hash2, ttlSeconds: 60 })).rejects.toThrow(
      /conflict/i,
    );
  });
});

describeIntegration('audit log — append-only enforcement', () => {
  it('UPDATE sur reservation_audit_log est rejeté par le trigger', async () => {
    // Crée un log
    const log = await prisma.reservationAuditLog.create({
      data: {
        event: 'hold_created',
        actor: 'test',
        metadata: {},
      },
    });

    // Tente un UPDATE
    await expect(
      prisma.reservationAuditLog.update({
        where: { id: log.id },
        data: { actor: 'tampered' },
      }),
    ).rejects.toThrow();

    // Cleanup
    await prisma.reservationAuditLog
      .deleteMany({
        where: { id: log.id },
      })
      .catch(() => {
        // Le trigger refuse DELETE — c'est attendu, on le démontre ici
      });
  });

  it('DELETE sur reservation_audit_log est rejeté par le trigger', async () => {
    const log = await prisma.reservationAuditLog.create({
      data: {
        event: 'hold_created',
        actor: 'test',
        metadata: {},
      },
    });

    await expect(prisma.reservationAuditLog.delete({ where: { id: log.id } })).rejects.toThrow();
  });
});

describeIntegration('reservation pagination', () => {
  it('returns every reservation once across pages when times are identical', async () => {
    const date = '2098-02-03';
    const ids = Array.from({ length: 115 }, () => randomUUID());
    await prisma.reservation.createMany({
      data: ids.map((id) => ({
        id,
        restaurantId: testRestaurantId,
        reservedAt: new Date(`${date}T12:00:00Z`),
        partySize: 2,
        customerName: 'Pagination test',
      })),
    });
    const pages = await Promise.all(
      [0, 50, 100].map((offset) =>
        LegacyReservationService.findByRestaurant(testRestaurantId, date, { limit: 50, offset }),
      ),
    );
    expect(pages.map((page) => page.length)).toEqual([50, 50, 15]);
    expect(pages.flat().map((reservation) => reservation.id)).toEqual([...ids].sort());
  });

  it('keeps a consistent day when a reservation moves between pages', async () => {
    const date = '2098-02-04';
    const ids = Array.from({ length: 60 }, () => randomUUID()).sort();
    await prisma.reservation.createMany({
      data: ids.map((id) => ({
        id,
        restaurantId: testRestaurantId,
        reservedAt: new Date(`${date}T12:00:00Z`),
        partySize: 2,
        customerName: 'Pagination test',
      })),
    });
    const findPage = LegacyReservationService.findByRestaurant.bind(LegacyReservationService);
    const spy = vi
      .spyOn(LegacyReservationService, 'findByRestaurant')
      .mockImplementation(async (...args) => {
        const page = await findPage(...args);
        if (args[2]?.offset === 0) {
          await prisma.reservation.update({
            where: { id: ids[59] },
            data: { reservedAt: new Date(`${date}T10:00:00Z`) },
          });
        }
        return page;
      });
    try {
      const rows = await LegacyReservationService.findDaySnapshot(testRestaurantId, date);
      expect(rows.map((row) => row.id)).toEqual(ids);
      expect(rows.find((row) => row.id === ids[59])?.reservedAt).toEqual(
        new Date(`${date}T12:00:00Z`),
      );
      expect(
        (await prisma.reservation.findUniqueOrThrow({ where: { id: ids[59] } })).reservedAt,
      ).toEqual(new Date(`${date}T10:00:00Z`));
    } finally {
      spy.mockRestore();
    }
  });
});

describeIntegration('legacy reservation delete — terminal state with audit', () => {
  it('clôture une réservation auditée sans suppression physique', async () => {
    const slot = nextCapacitySlot();
    const reservationId = await createCapacityReservation({
      state: 'CONFIRMED',
      tableId: testTableId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });

    await prisma.reservationAuditLog.create({
      data: {
        event: 'reservation_table_released',
        reservationId,
        actor: 'test',
        fromState: 'CONFIRMED',
        toState: 'CONFIRMED',
        metadata: {},
      },
    });

    await LegacyReservationService.delete(reservationId, testRestaurantId);

    const retained = await prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { status: true, state: true },
    });
    expect(retained).toMatchObject({ status: 'CANCELLED', state: 'CANCELLED' });

    const deletionAudit = await prisma.reservationAuditLog.findFirst({
      where: { reservationId, event: 'reservation_deleted' },
    });
    expect(deletionAudit).toBeTruthy();
    expect(deletionAudit?.fromState).toBe('CONFIRMED');
    expect(deletionAudit?.toState).toBe('CANCELLED');

    const operationalRows = await LegacyReservationService.findByRestaurant(testRestaurantId);
    expect(operationalRows.some((row) => row.id === reservationId)).toBe(false);
  });
});

describeIntegration('capacity — active reservations with or without table', () => {
  it.each(ACTIVE_RESERVATION_STATES)(
    '%s bloque avec ou sans table dans CapacityAwareAvailabilityService',
    async (state) => {
      const withTable = nextCapacitySlot();
      const withoutTable = nextCapacitySlot();
      const reservationIds = await Promise.all([
        createCapacityReservation({
          state,
          tableId: testTableId,
          startsAt: withTable.startsAt,
          endsAt: withTable.endsAt,
        }),
        createCapacityReservation({
          state,
          tableId: null,
          startsAt: withoutTable.startsAt,
          endsAt: withoutTable.endsAt,
        }),
      ]);

      try {
        const service = new CapacityAwareAvailabilityService(prisma);

        await expect(slotAvailability(service, withTable.date)).resolves.toBe(false);
        await expect(slotAvailability(service, withoutTable.date)).resolves.toBe(false);
      } finally {
        await prisma.reservation.deleteMany({ where: { id: { in: reservationIds } } });
      }
    },
  );
});

describeIntegration('capacity — active holds with or without table', () => {
  it.each([
    { label: 'avec table', withTable: true, physicalAvailable: false },
    { label: 'sans table', withTable: false, physicalAvailable: true },
  ])(
    '$label : vérifie les deux prédicats de capacité',
    async ({ withTable, physicalAvailable }) => {
      const slot = nextCapacitySlot();
      const holdId = await createCapacityHold({
        tableId: withTable ? testTableId : null,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });

      try {
        const availability = new CapacityAwareAvailabilityService(prisma);
        const allocation = new TableAllocationService(prisma);

        await expect(slotAvailability(availability, slot.date)).resolves.toBe(false);
        await expect(
          allocation.isTableAvailable({
            tableId: testTableId,
            startsAt: slot.startsAt,
            endsAt: slot.endsAt,
          }),
        ).resolves.toBe(physicalAvailable);
      } finally {
        await prisma.agenticHold.delete({ where: { id: holdId } });
      }
    },
  );
});

describeIntegration('capacity — explicit table hold revalidation', () => {
  it.each([
    { label: 'réservation active sans table', blocker: 'reservation-global' as const },
    { label: 'hold actif sans table', blocker: 'hold-global' as const },
    { label: 'réservation active sur la table', blocker: 'reservation-table' as const },
    { label: 'hold actif sur la table', blocker: 'hold-table' as const },
  ])('$label : refuse un hold avec tableId explicite', async ({ blocker }) => {
    const slot = nextCapacitySlot();
    let reservationId: string | null = null;
    let holdId: string | null = null;

    if (blocker.startsWith('reservation')) {
      reservationId = await createCapacityReservation({
        state: 'CONFIRMED',
        tableId: blocker === 'reservation-table' ? testTableId : null,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });
    } else {
      holdId = await createCapacityHold({
        tableId: blocker === 'hold-table' ? testTableId : null,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });
    }

    try {
      await expect(
        holds.createHold({
          restaurantId: testRestaurantId,
          partySize: 4,
          slotStart: slot.startsAt,
          slotEnd: slot.endsAt,
          channel: 'MCP',
          policy,
          actor: 'agent:explicit-table-test',
          tableId: testTableId,
        }),
      ).rejects.toBeInstanceOf(HoldConflictError);

      const created = await prisma.agenticHold.count({
        where: {
          restaurantId: testRestaurantId,
          slotStart: slot.startsAt,
          type: 'HOLD',
          status: 'ACTIVE',
        },
      });
      expect(created).toBe(holdId ? 1 : 0);
    } finally {
      if (reservationId) {
        await prisma.reservation.delete({ where: { id: reservationId } });
      }
      if (holdId) {
        await prisma.agenticHold.delete({ where: { id: holdId } });
      }
    }
  });
});

describeIntegration('capacity — releaseTable', () => {
  it.each(ACTIVE_RESERVATION_STATES)(
    '%s détache la table sans changer la réservation ; la capacité globale reste bloquée',
    async (state) => {
      const slot = nextCapacitySlot();
      const reservationId = await createCapacityReservation({
        state,
        tableId: testTableId,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });

      const allocation = new TableAllocationService(prisma);
      await allocation.releaseTable(reservationId);

      const reservation = await prisma.reservation.findUniqueOrThrow({
        where: { id: reservationId },
        select: { tableId: true, state: true, status: true },
      });
      expect(reservation).toEqual({
        tableId: null,
        state,
        status: state === 'SEATED' ? 'SEATED' : 'CONFIRMED',
      });

      await expect(
        allocation.isTableAvailable({
          tableId: testTableId,
          startsAt: slot.startsAt,
          endsAt: slot.endsAt,
        }),
      ).resolves.toBe(true);
      await expect(
        slotAvailability(new CapacityAwareAvailabilityService(prisma), slot.date),
      ).resolves.toBe(false);
    },
  );
});

describeIntegration('capacity — réservation active sans table dans le chemin agentic', () => {
  it('masque le début du lendemain pour une ancienne réservation sans heure de fin', async () => {
    const start = new Date('2099-09-14T21:30:00Z');
    await prisma.reservation.create({
      data: {
        restaurantId: testRestaurantId,
        tableId: testTableId,
        reservedAt: start,
        startsAt: null,
        endsAt: null,
        partySize: 2,
        customerName: 'Ancienne',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
      },
    });
    const available = await new CapacityAwareAvailabilityService(prisma).getAvailability({
      restaurantId: testRestaurantId,
      date: '2099-09-15',
      partySize: 2,
    });
    expect(available.slots.find((slot) => slot.time === '00:30')?.available).toBe(false);
    expect(available.slots.find((slot) => slot.time === '01:30')?.available).toBe(true);
  });
  it.each(ACTIVE_RESERVATION_STATES)(
    '%s est bloquante pour findBlockingReservation même sans table',
    async (state) => {
      const slot = nextCapacitySlot();
      const reservationId = await createCapacityReservation({
        state,
        tableId: null,
        startsAt: slot.startsAt,
        endsAt: slot.endsAt,
      });
      const scope = `${testRestaurantId}:capacity-global:${state}:${randomUUID()}`;
      const key = `capacity-global-${randomUUID()}`;
      const service = new ReservationService(prisma, audit, holds, idem);

      try {
        await expect(
          service.createReservation(
            {
              restaurantId: testRestaurantId,
              partySize: 4,
              startsAt: slot.startsAt,
              endsAt: slot.endsAt,
              customerName: 'Capacity contender',
              customerPhone: '+33600000001',
              channel: 'MCP',
              policy,
              actor: 'test:capacity',
            },
            {
              scope,
              key,
              payloadHash: hashPayload({
                partySize: 4,
                startsAt: slot.startsAt.toISOString(),
              }),
              ttlSeconds: 60,
            },
          ),
        ).rejects.toBeInstanceOf(ReservationSlotUnavailableError);
      } finally {
        await prisma.reservation.delete({ where: { id: reservationId } });
        await prisma.idempotencyRecord.deleteMany({ where: { scope, key } });
      }
    },
  );
});

/**
 * Parité des deux entrées d'écriture (R1-4).
 *
 * Les deux services restent deux implémentations, mais ils écrivent les mêmes
 * deux colonnes : `state` (agentic) et `status` (historique, projeté). Ce bloc
 * exécute les deux contre une vraie base et compare leurs sorties normalisées.
 * C'est ce qui rend le harness shadow utile : jusqu'ici il ne comparait que des
 * fixtures statiques, donc il ne pouvait pas détecter une divergence réelle.
 */
describeIntegration('contrat — parité des deux entrées d’écriture (R1-4)', () => {
  async function createViaLegacy(args: { startsAt: Date; name: string; phone: string }) {
    return LegacyReservationService.create({
      restaurantId: testRestaurantId,
      reservedAt: args.startsAt,
      partySize: 4,
      customerName: args.name,
      customerPhone: args.phone,
    });
  }

  async function createViaAgentic(args: {
    startsAt: Date;
    endsAt: Date;
    name: string;
    phone: string;
    policySnapshot?: typeof policy;
  }) {
    const service = new ReservationService(prisma, audit, holds, idem);
    return service.createReservation(
      {
        restaurantId: testRestaurantId,
        partySize: 4,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        customerName: args.name,
        customerPhone: args.phone,
        channel: 'MCP',
        policy: args.policySnapshot ?? policy,
        actor: 'test:parity',
      },
      parityIdempotency(randomUUID()),
    );
  }

  /** Snapshot normalisé, construit sur la ligne et l'audit réellement écrits. */
  async function readContract(reservationId: string, idempotency: 'keyed' | 'unkeyed') {
    const [row, audits] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({
        where: { id: reservationId },
        select: { status: true, state: true },
      }),
      prisma.reservationAuditLog.findMany({
        where: { reservationId },
        select: { event: true },
        orderBy: { event: 'asc' },
      }),
    ]);
    return normalizeReservationContractResult({
      outcome: 'committed',
      status: row.status,
      state: row.state,
      idempotency,
      auditEvents: audits.map((entry) => entry.event),
      notificationJobs: [],
      // Les deux scénarios sont des créations : la capacité vient d'être prise.
      capacity: 'reserved',
      hold: 'none',
    });
  }

  it('les deux services respectent la projection canonique à la création', async () => {
    const legacySlot = nextCapacitySlot();
    const legacy = await createViaLegacy({
      startsAt: legacySlot.startsAt,
      name: 'Parité legacy',
      phone: parityPhone(),
    });

    const agenticSlot = nextCapacitySlot();
    const agentic = await createViaAgentic({
      startsAt: agenticSlot.startsAt,
      endsAt: agenticSlot.endsAt,
      name: 'Parité agentic',
      phone: parityPhone(),
    });

    const rows = await prisma.reservation.findMany({
      where: { id: { in: [legacy.id, agentic.reservationId] } },
      select: { id: true, status: true, state: true },
    });
    expect(rows).toHaveLength(2);

    for (const row of rows) {
      expect(isReservationState(row.state)).toBe(true);
      // Invariant canonique : `status` est exactement ce que projette `state`.
      expect(row.status).toBe(creationProjection(row.state as CreatableReservationState).status);
      expect(row).toMatchObject({ status: 'CONFIRMED', state: 'CONFIRMED' });
    }
  });

  it('la validation manuelle reste non ferme malgré status=CONFIRMED', async () => {
    const slot = nextCapacitySlot();
    const phone = parityPhone();

    const created = await createViaAgentic({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      name: 'Parité validation manuelle',
      phone,
      policySnapshot: manualValidationPolicy,
    });

    const row = await prisma.reservation.findUniqueOrThrow({
      where: { id: created.reservationId },
      select: { status: true, state: true },
    });

    // Projection lossy assumée : l'énumération historique ne sait pas exprimer
    // « en attente de validation », donc `status` porte CONFIRMED.
    expect(row).toEqual({ status: 'CONFIRMED', state: 'PENDING' });
    expect(isConfirmedReservation(row)).toBe(false);

    // Filtre réel du handler de réponse SMS (status **et** state). C'est le bug
    // corrigé en R1-4 : sur `status` seul, un « NON » annulait cette ligne.
    const matched = await prisma.reservation.findFirst({
      where: {
        customerPhone: phone,
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        confirmationStatus: 'PENDING',
        reservedAt: {
          gte: new Date(slot.startsAt.getTime() - 24 * 60 * 60 * 1000),
          lte: new Date(slot.startsAt.getTime() + 24 * 60 * 60 * 1000),
        },
      },
      select: { id: true },
    });
    expect(matched).toBeNull();
  });

  it('le harness shadow compare les deux entrées sur des faits réels', async () => {
    const legacySlot = nextCapacitySlot();
    const legacy = await createViaLegacy({
      startsAt: legacySlot.startsAt,
      name: 'Parité shadow legacy',
      phone: parityPhone(),
    });

    const agenticSlot = nextCapacitySlot();
    const agentic = await createViaAgentic({
      startsAt: agenticSlot.startsAt,
      endsAt: agenticSlot.endsAt,
      name: 'Parité shadow agentic',
      phone: parityPhone(),
    });

    const comparison = compareReservationContractResults(
      await readContract(legacy.id, 'unkeyed'),
      await readContract(agentic.reservationId, 'keyed'),
    );

    expect(comparison.legacy).toMatchObject({ status: 'CONFIRMED', state: 'CONFIRMED' });
    expect(comparison.agentic).toMatchObject({ status: 'CONFIRMED', state: 'CONFIRMED' });

    // Les deux colonnes d'état sont identiques : c'est la convergence visée.
    // Les écarts restants sont assumés et restent visibles ici.
    expect(comparison.legacy.auditEvents).toEqual(['reservation_created']);
    // Le chemin agentic matérialise un hold même sans token fourni ; le chemin
    // legacy n'a pas cette notion.
    expect(comparison.agentic.auditEvents).toEqual(['hold_consumed', 'reservation_created']);

    // Toute différence supplémentaire fait échouer ce test, ce qui force une
    // décision explicite plutôt qu'une dérive silencieuse entre les deux entrées.
    expect(comparison.differences).toEqual(['idempotency', 'auditEvents']);
  });
});
