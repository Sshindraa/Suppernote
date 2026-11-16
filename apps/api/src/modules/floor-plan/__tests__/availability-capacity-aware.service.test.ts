import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import type {
  PrismaClient,
  Restaurant,
  RestaurantExposureSettings,
  Table,
  Reservation,
  AgenticHold,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import {
  CapacityAwareAvailabilityService,
  markTooSoonSlotsUnavailable,
  zonedTimeToUtc,
} from '../availability-capacity-aware.service.js';
import { findUnassignedSeatingConflict } from '../unassigned-seating';

vi.mock('../../../shared/redis/client', () => {
  const store = new Map<string, string>();
  const reset = () => store.clear();

  const redisCache = {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    incr: vi.fn(async (key: string) => {
      const val = Number(store.get(key) ?? 0) + 1;
      store.set(key, String(val));
      return val;
    }),
    expire: vi.fn(async () => 1),
    del: vi.fn(async (key: string) => {
      store.delete(key);
      return 1;
    }),
    __resetStore: reset,
  };

  return {
    redisCache,
    redisSession: {},
    redisQueue: { on: vi.fn() },
    getCachedContext: vi.fn(),
    setCachedContext: vi.fn(),
  };
});

import { redisCache } from '../../../shared/redis/client';

type MinimalRestaurant = Restaurant & { exposureSettings: RestaurantExposureSettings | null };

function makeRestaurant(
  overrides: Partial<Omit<MinimalRestaurant, 'openingHours'>> & {
    id: string;
    openingHours: unknown;
  },
): MinimalRestaurant {
  return {
    id: overrides.id,
    accountId: overrides.accountId ?? null,
    isPrimary: overrides.isPrimary ?? false,
    siteStatus: overrides.siteStatus ?? 'ACTIVE',
    name: overrides.name ?? 'Resto',
    plan: overrides.plan ?? 'STARTER',
    serviceCopilotLegacyAccess: overrides.serviceCopilotLegacyAccess ?? false,
    managerPhone: overrides.managerPhone ?? '+33100000000',
    managerEmail: overrides.managerEmail ?? 'manager@example.com',
    phoneNumber: overrides.phoneNumber ?? '+33100000000',
    openingHours: overrides.openingHours as Prisma.JsonValue,
    carrier: overrides.carrier ?? 'vapi',
    smsConfirmEnabled: overrides.smsConfirmEnabled ?? true,
    theforkSavings: (overrides.theforkSavings ?? 0) as unknown as Prisma.Decimal,
    onboardingTasks: overrides.onboardingTasks ?? {},
    onboardingDone: overrides.onboardingDone ?? false,
    onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
    onboardingActivatedAt: overrides.onboardingActivatedAt ?? null,
    onboardingLastSeenAt: overrides.onboardingLastSeenAt ?? null,
    firstCallAt: overrides.firstCallAt ?? null,
    provisioningStatus: overrides.provisioningStatus ?? 'PENDING',
    telnyxPhoneNumberId: overrides.telnyxPhoneNumberId ?? null,
    forwardingConfiguredAt: overrides.forwardingConfiguredAt ?? null,
    testCallValidatedAt: overrides.testCallValidatedAt ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    slug: overrides.slug ?? null,
    canonicalUrl: overrides.canonicalUrl ?? null,
    websiteUrl: overrides.websiteUrl ?? null,
    platformUrl: overrides.platformUrl ?? null,
    lat: overrides.lat ?? null,
    lng: overrides.lng ?? null,
    formattedAddress: overrides.formattedAddress ?? null,
    timezone: overrides.timezone ?? 'Europe/Paris',
    phoneE164: overrides.phoneE164 ?? null,
    cuisineType: overrides.cuisineType ?? [],
    priceRange: overrides.priceRange ?? null,
    ambiance: overrides.ambiance ?? [],
    noiseLevel: overrides.noiseLevel ?? null,
    dietary: overrides.dietary ?? [],
    attributeConfidence: overrides.attributeConfidence ?? {},
    practicalInfo: overrides.practicalInfo ?? {},
    agenticOptIn: overrides.agenticOptIn ?? false,
    openaiReserveEnabled: overrides.openaiReserveEnabled ?? false,
    policyVersion: overrides.policyVersion ?? '2026-06-20',
    description: overrides.description ?? null,
    city: overrides.city ?? null,
    country: overrides.country ?? 'FR',
    postalCode: overrides.postalCode ?? null,
    coverImageUrl: overrides.coverImageUrl ?? null,
    publishedAt: overrides.publishedAt ?? null,
    googlePlaceId: overrides.googlePlaceId ?? null,
    googleRating: overrides.googleRating ?? null,
    googleReviewCount: overrides.googleReviewCount ?? null,
    googleRatingSyncedAt: overrides.googleRatingSyncedAt ?? null,
    giftCardMinimumAmount: overrides.giftCardMinimumAmount ?? null,
    giftCardCommissionRate: (overrides.giftCardCommissionRate ?? 0.05) as unknown as Prisma.Decimal,
    giftCardStripeAccountId: null,
    giftCardStripePendingAccountId: null,
    giftCardEnabled: overrides.giftCardEnabled ?? false,
    experienceStripeAccountId: overrides.experienceStripeAccountId ?? null,
    experienceCommissionRate: (overrides.experienceCommissionRate ??
      null) as unknown as Prisma.Decimal | null,
    crmSensitiveNoteRoles: overrides.crmSensitiveNoteRoles ?? null,
    exposureSettings: overrides.exposureSettings ?? null,
  };
}

function makeExposureSettings(
  overrides: Partial<RestaurantExposureSettings> & { restaurantId: string },
): RestaurantExposureSettings {
  return {
    restaurantId: overrides.restaurantId,
    mcpEnabled: overrides.mcpEnabled ?? false,
    openaiReserveEnabled: overrides.openaiReserveEnabled ?? false,
    exposedCreneaux: overrides.exposedCreneaux ?? [],
    maxPartySize: overrides.maxPartySize ?? 12,
    minLeadTimeMinutes: overrides.minLeadTimeMinutes ?? 30,
    requireManualValidation: overrides.requireManualValidation ?? false,
    quoteTtlSeconds: overrides.quoteTtlSeconds ?? 300,
    holdTtlSeconds: overrides.holdTtlSeconds ?? 420,
    noShowPolicy: overrides.noShowPolicy ?? 'warning',
    notificationChannels: overrides.notificationChannels ?? ['sms', 'email'],
    capacitySpecials: overrides.capacitySpecials ?? {},
    connectPublished: overrides.connectPublished ?? false,
    connectAgentic: overrides.connectAgentic ?? false,
    connectPublishedAt: overrides.connectPublishedAt ?? null,
    connectDescription: overrides.connectDescription ?? null,
    customDomain: overrides.customDomain ?? null,
    customDomainStatus: overrides.customDomainStatus ?? null,
    customDomainValidatedAt: overrides.customDomainValidatedAt ?? null,
    customDomainCfId: overrides.customDomainCfId ?? null,
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

function makeTable(
  overrides: Partial<Table> & { id: string; capacity: number; floorPlanId: string },
): Table {
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
  };
}

function makeReservation(
  overrides: Partial<Reservation> & {
    id: string;
    tableId: string | null;
    startsAt: Date | null;
    endsAt: Date | null;
  },
): Reservation {
  return {
    id: overrides.id,
    restaurantId: overrides.restaurantId ?? 'r-1',
    callId: overrides.callId ?? null,
    customerId: overrides.customerId ?? null,
    reservedAt: overrides.reservedAt ?? overrides.startsAt ?? new Date(),
    partySize: overrides.partySize ?? 2,
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
  overrides: Partial<AgenticHold> & {
    id: string;
    tableId: string | null;
    slotStart: Date;
    slotEnd: Date;
  },
): AgenticHold {
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

function makeMockPrisma(initial: {
  restaurant?: MinimalRestaurant;
  tables?: Table[];
  reservations?: Reservation[];
  holds?: AgenticHold[];
}) {
  const restaurant = initial.restaurant;
  const tables = initial.tables ?? [];
  const reservations = initial.reservations ?? [];
  const holds = initial.holds ?? [];
  const floorPlanId = tables[0]?.floorPlanId ?? 'fp-1';
  const floorPlanRestaurantId = restaurant?.id ?? RESTAURANT_ID;
  const floorPlanToRestaurant: Record<string, string> = {};
  for (const t of tables) {
    floorPlanToRestaurant[t.floorPlanId] = floorPlanRestaurantId;
  }

  const prisma = {
    restaurant: {
      findUnique: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const id = where.id as string | undefined;
        if (id === restaurant?.id) {
          return restaurant ?? null;
        }
        return null;
      },
    },
    floorPlan: {
      findFirst: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        if (restaurantId === restaurant?.id) {
          return { id: floorPlanId };
        }
        return null;
      },
    },
    table: {
      findFirst: async () => tables.find((table) => table.isActive) ?? null,
      findMany: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const floorPlanId = where.floorPlanId as string | undefined;
        const floorPlanRel = where.floorPlan as
          | { restaurantId?: string; isActive?: boolean }
          | undefined;
        const isActive = where.isActive as boolean | undefined;
        const capacity = where.capacity as { gte?: number } | undefined;
        const sectionId = where.sectionId as string | undefined;
        return tables.filter((t) => {
          if (floorPlanId && t.floorPlanId !== floorPlanId) return false;
          if (
            floorPlanRel?.restaurantId &&
            floorPlanToRestaurant[t.floorPlanId] !== floorPlanRel.restaurantId
          ) {
            return false;
          }
          if (isActive === true && !t.isActive) return false;
          if (capacity?.gte && t.capacity < capacity.gte) return false;
          if (sectionId && t.sectionId !== sectionId) return false;
          return true;
        });
      },
    },
    reservation: {
      findMany: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        const state = where.state as { in?: string[] } | undefined;
        const tableId = where.tableId as { not?: string | null } | undefined;
        const startsAt = where.startsAt as { gte?: Date; lt?: Date } | undefined;
        const reservedAt = where.reservedAt as { gte?: Date; lt?: Date } | undefined;
        const or = where.OR as Array<Record<string, unknown>> | undefined;
        return reservations.filter((r) => {
          if (restaurantId && r.restaurantId !== restaurantId) return false;
          if (where.isTest === false && r.isTest) return false;
          if (state?.in && !state.in.includes(r.state)) return false;
          const tableIdNot = tableId?.not;
          if (tableIdNot === null && r.tableId === null) return false;
          if (tableIdNot != null && r.tableId !== tableIdNot) return false;
          if (or) {
            const matchesRange = (value: Date | null | undefined, range: unknown) => {
              if (!(value instanceof Date)) return false;
              const bounds = range as { gte?: Date; gt?: Date; lt?: Date };
              return (
                (!bounds.gte || value >= bounds.gte) &&
                (!bounds.gt || value > bounds.gt) &&
                (!bounds.lt || value < bounds.lt)
              );
            };
            const matchesOr = or.some((condition) => {
              if ('startsAt' in condition) {
                if (condition.startsAt === null) {
                  return (
                    r.startsAt === null &&
                    matchesRange(r.reservedAt, condition.reservedAt) &&
                    (condition.endsAt === null
                      ? r.endsAt === null
                      : !condition.endsAt || matchesRange(r.endsAt, condition.endsAt))
                  );
                }
                if (!matchesRange(r.startsAt, condition.startsAt)) return false;
                if ('endsAt' in condition && condition.endsAt === null) {
                  return r.endsAt === null;
                }
                if ('endsAt' in condition && condition.endsAt) {
                  return matchesRange(r.endsAt, condition.endsAt);
                }
                return true;
              }
              if ('reservedAt' in condition) {
                return matchesRange(r.reservedAt, condition.reservedAt);
              }
              return false;
            });
            if (!matchesOr) return false;
          } else {
            if (startsAt?.gte && (!r.startsAt || r.startsAt < startsAt.gte)) return false;
            if (startsAt?.lt && (!r.startsAt || r.startsAt >= startsAt.lt)) return false;
            if (reservedAt?.gte && r.reservedAt < reservedAt.gte) return false;
            if (reservedAt?.lt && r.reservedAt >= reservedAt.lt) return false;
          }
          return true;
        });
      },
    },
    agenticHold: {
      findMany: async (args: unknown) => {
        const where = ((args as Record<string, unknown>).where ?? {}) as Record<string, unknown>;
        const restaurantId = where.restaurantId as string | undefined;
        const status = where.status as string | undefined;
        const expiresAt = where.expiresAt as { gt?: Date } | undefined;
        const tableId = where.tableId as { not?: string | null } | undefined;
        const slotStart = where.slotStart as { gte?: Date; lt?: Date } | undefined;
        const slotEnd = where.slotEnd as { gt?: Date } | undefined;
        return holds.filter((h) => {
          if (restaurantId && h.restaurantId !== restaurantId) return false;
          if (status && h.status !== status) return false;
          if (expiresAt?.gt && !(h.expiresAt > expiresAt.gt)) return false;
          const tableIdNot = tableId?.not;
          if (tableIdNot === null && h.tableId === null) return false;
          if (tableIdNot != null && h.tableId !== tableIdNot) return false;
          if (slotStart?.gte && h.slotStart < slotStart.gte) return false;
          if (slotStart?.lt && h.slotStart >= slotStart.lt) return false;
          if (slotEnd?.gt && h.slotEnd <= slotEnd.gt) return false;
          return true;
        });
      },
    },
  } as unknown as PrismaClient;

  return { prisma };
}

const RESTAURANT_ID = 'r-1';
const FLOOR_PLAN_ID = 'fp-1';
const date = '2026-07-02';
const openingHours = {
  monday: { open: '12:00', close: '14:30' },
  tuesday: { open: '12:00', close: '14:30' },
  wednesday: { open: '12:00', close: '14:30' },
  thursday: { open: '12:00', close: '22:30' },
  friday: { open: '12:00', close: '14:30' },
  saturday: { open: '19:00', close: '22:30' },
  sunday: { open: '19:00', close: '22:30' },
};

function makeBaseRestaurant(capacitySpecials: unknown = {}, hours: unknown = openingHours) {
  return makeRestaurant({
    id: RESTAURANT_ID,
    timezone: 'Europe/Paris',
    openingHours: hours,
    exposureSettings: makeExposureSettings({
      restaurantId: RESTAURANT_ID,
      capacitySpecials: capacitySpecials as Prisma.JsonValue,
    }),
  });
}

// Les dates de ces tests sont fixes : l'horloge est figée avant elles, sinon leurs créneaux seraient
// (à juste titre) passés et indisponibles. Les cas « passé » ont leur propre describe plus bas.
const BEFORE_FIXTURE_DATES = new Date('2026-07-01T06:00:00.000Z');

describe('CapacityAwareAvailabilityService', () => {
  beforeEach(() => {
    (redisCache as unknown as { __resetStore: () => void }).__resetStore();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_FIXTURE_DATES);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expose les créneaux sans table au personnel seulement, en respectant les réservations non attribuées', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [],
      reservations: [
        makeReservation({
          id: 'r1',
          tableId: null,
          startsAt: new Date('2026-07-02T17:00:00Z'),
          endsAt: new Date('2026-07-02T19:00:00Z'),
        }),
      ],
    });
    const service = new CapacityAwareAvailabilityService(prisma);
    const staff = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      allowWithoutTables: true,
    });
    const web = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });
    expect(staff.slots.find((slot) => slot.time === '20:00')?.available).toBe(false);
    expect(staff.slots.some((slot) => slot.available)).toBe(true);
    expect(web.slots.every((slot) => !slot.available)).toBe(true);
  });

  it('retourne le contrat AvailabilityDto attendu', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(dto.restaurantId).toBe(RESTAURANT_ID);
    expect(dto.date).toBe(date);
    expect(dto.partySize).toBe(2);
    expect(dto.slots.length).toBeGreaterThan(0);
    expect(dto.slots[0]).toHaveProperty('time');
    expect(dto.slots[0]).toHaveProperty('available');
  });

  it('génère des créneaux au déjeuner et au dîner sans ouvrir la pause', async () => {
    const splitHours = {
      ...openingHours,
      thursday: {
        open: '12:00',
        close: '22:30',
        services: [
          { open: '12:00', close: '14:30' },
          { open: '19:00', close: '22:30' },
        ],
      },
    };
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant({}, splitHours),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });
    const times = dto.slots.map((slot) => slot.time);

    expect(times).toContain('12:00');
    expect(times).toContain('19:00');
    expect(times).not.toContain('15:00');
    expect(times).not.toContain('18:30');
  });

  it('arrête les créneaux de chaque service à sa dernière réservation', async () => {
    const splitHours = {
      ...openingHours,
      thursday: {
        open: '12:00',
        close: '22:30',
        slots: [
          { open: '12:00', close: '14:30', lastBooking: '13:30' },
          { open: '19:00', close: '22:30', lastBooking: '21:30' },
        ],
      },
    };
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant({}, splitHours),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });
    const times = dto.slots.map((slot) => slot.time);

    expect(times).toContain('13:30');
    expect(times).not.toContain('14:00');
    expect(times).toContain('21:30');
    expect(times).not.toContain('22:00');
  });

  it('garde le dernier créneau avant la fermeture quand lastBooking est absent', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });
    const times = dto.slots.map((slot) => slot.time);

    expect(times.at(-1)).toBe('22:00');
  });

  it('propose après minuit sur le jour calendrier suivant', async () => {
    const overnightHours = {
      ...openingHours,
      thursday: {
        open: '22:00',
        close: '02:00',
        slots: [{ open: '22:00', close: '02:00' }],
      },
      friday: null,
    };
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant({}, overnightHours),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date: '2026-07-03',
      partySize: 2,
    });
    const times = dto.slots.map((slot) => slot.time);

    expect(times).toContain('00:00');
    expect(times).toContain('01:30');
    expect(times).not.toContain('02:00');
  });

  it('créneau disponible si au moins une table libre', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20).toBeDefined();
    expect(slot20!.available).toBe(true);
  });

  it('créneau indisponible si toutes les tables occupées', async () => {
    const startsAt = new Date('2026-07-02T17:00:00Z');
    const endsAt = new Date('2026-07-02T19:00:00Z');
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
      reservations: [makeReservation({ id: 'r-1', tableId: 't-1', startsAt, endsAt })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20!.available).toBe(false);
  });

  it('réservation PENDING avec projection status CONFIRMED bloque la capacité', async () => {
    const startsAt = new Date('2026-07-02T17:00:00Z');
    const endsAt = new Date('2026-07-02T19:00:00Z');
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
      reservations: [
        makeReservation({
          id: 'r-pending',
          tableId: 't-1',
          startsAt,
          endsAt,
          status: 'CONFIRMED',
          state: 'PENDING',
        }),
      ],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20!.available).toBe(false);
  });

  it('réservation active sans table bloque la capacité globale', async () => {
    const startsAt = new Date('2026-07-02T17:00:00Z');
    const endsAt = new Date('2026-07-02T19:00:00Z');
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
      reservations: [
        makeReservation({
          id: 'r-pending-unassigned',
          tableId: null,
          startsAt,
          endsAt,
          status: 'CONFIRMED',
          state: 'PENDING',
        }),
      ],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(dto.slots.find((s) => s.time === '20:00')?.available).toBe(false);
  });

  it('hold actif sans table bloque la capacité globale', async () => {
    const slotStart = new Date('2026-07-02T17:00:00Z');
    const slotEnd = new Date('2026-07-02T19:00:00Z');
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
      holds: [
        makeHold({
          id: 'h-unassigned',
          tableId: null,
          slotStart,
          slotEnd,
          expiresAt: new Date(Date.now() + 10 * 60_000),
        }),
      ],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(dto.slots.find((s) => s.time === '20:00')?.available).toBe(false);
  });

  it('partySize supérieur à la plus grande table → indisponible', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 6 });

    expect(dto.slots.every((s) => !s.available)).toBe(true);
  });

  it('serviceDurationMinutes lu depuis capacitySpecials', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant({ serviceDurationMinutes: 90 }),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(dto.slots.length).toBeGreaterThan(0);
    // 12:00 à 22:30 → 90min slots = 12:00, 13:30, 15:00, 16:30, 18:00, 19:30, 21:00
    expect(dto.slots.some((s) => s.time === '18:00')).toBe(true);
    expect(dto.slots.some((s) => s.time === '19:30')).toBe(true);
  });

  it('fallback 120 min si serviceDuration non configuré', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    // 12:00 à 22:30 → 120min slots = 12:00, 14:00, 16:00, 18:00, 20:00, 22:00
    expect(dto.slots.some((s) => s.time === '18:00')).toBe(true);
    expect(dto.slots.some((s) => s.time === '20:00')).toBe(true);
  });

  it('timezone respectée : jour correct pour la date', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    // 2026-07-02 est un jeudi, donc service du midi en Europe/Paris
    expect(dto.slots.some((s) => s.time === '12:00')).toBe(true);
  });

  it('retourne [] si le restaurant est introuvable', async () => {
    const { prisma } = makeMockPrisma({});

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: 'inconnu', date, partySize: 2 });

    expect(dto.slots).toEqual([]);
  });

  it('met en cache Redis avec TTL', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(redisCache.set).toHaveBeenCalledWith(
      expect.stringContaining('availability:v:r-1'),
      expect.any(String),
      'EX',
      30,
    );
  });

  it('retourne le résultat en cache au second appel', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const first = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
    });
    const second = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
    });

    expect(second).toEqual(first);
    expect(redisCache.set).toHaveBeenCalledTimes(1);
  });

  it('invalide le cache sur mutation', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const first = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
    });

    await CapacityAwareAvailabilityService.invalidateAvailability(RESTAURANT_ID);

    const second = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
    });

    expect(second).toEqual(first);
    expect(redisCache.incr).toHaveBeenCalledWith(expect.stringContaining('availability:v:r-1'));
    expect(redisCache.set).toHaveBeenCalledTimes(2);
  });

  it('ne range pas sous la nouvelle version un calcul commencé avant une mutation', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });
    // Une réservation est validée pendant que le premier calcul lit la base.
    const restaurantDb = prisma.restaurant as unknown as {
      findUnique: (args: unknown) => Promise<unknown>;
    };
    const readRestaurant = restaurantDb.findUnique;
    let mutated = false;
    restaurantDb.findUnique = async (args) => {
      if (!mutated) {
        mutated = true;
        await CapacityAwareAvailabilityService.invalidateAvailability(RESTAURANT_ID);
      }
      return readRestaurant(args);
    };

    const service = new CapacityAwareAvailabilityService(prisma);
    await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });
    await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    // Le second appel recalcule : le premier résultat, périmé, n'a pas été servi depuis le cache.
    expect(redisCache.set).toHaveBeenCalledTimes(2);
  });

  it('honore la section préférée quand une table de cette section est libre', async () => {
    const sectionId = 'section-terrasse';
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-inside', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
        makeTable({ id: 't-terrasse', floorPlanId: FLOOR_PLAN_ID, capacity: 4, sectionId }),
      ],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      preferredSectionId: sectionId,
    });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20!.available).toBe(true);
  });

  it('ne retombe pas sur les autres sections si la section préférée est pleine', async () => {
    const sectionId = 'section-terrasse';
    const startsAt = new Date('2026-07-02T17:00:00Z');
    const endsAt = new Date('2026-07-02T19:00:00Z');
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-inside', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
        makeTable({ id: 't-terrasse', floorPlanId: FLOOR_PLAN_ID, capacity: 4, sectionId }),
      ],
      reservations: [makeReservation({ id: 'r-1', tableId: 't-terrasse', startsAt, endsAt })],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      preferredSectionId: sectionId,
    });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20!.available).toBe(false);
  });

  it('agrège les tables actives de tous les floor plans actifs du restaurant', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-main', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
        makeTable({ id: 't-second', floorPlanId: 'fp-2', capacity: 4 }),
      ],
    });

    const service = new CapacityAwareAvailabilityService(prisma);
    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    const slot20 = dto.slots.find((s) => s.time === '20:00');
    expect(slot20!.available).toBe(true);
  });
});

describe('créneaux passés', () => {
  // Jeudi 2 juillet 2026, restaurant à Paris (UTC+2) ouvert de 12:00 à 22:30 : créneaux de 12:00 à 22:00.
  // Vendredi 3 juillet : 12:00 à 14:30.
  const parisNow = (time: string) => new Date(`2026-07-02T${time}:00+02:00`);
  const tomorrow = '2026-07-03';

  function setup(hours: unknown = openingHours, timezone = 'Europe/Paris') {
    const restaurant = makeBaseRestaurant({}, hours);
    const { prisma } = makeMockPrisma({
      restaurant: { ...restaurant, timezone },
      tables: [makeTable({ id: 't-1', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
    });
    return new CapacityAwareAvailabilityService(prisma);
  }

  const slotOf = (dto: { slots: Array<{ time: string; available: boolean }> }, time: string) =>
    dto.slots.find((slot) => slot.time === time);

  beforeEach(() => {
    (redisCache as unknown as { __resetStore: () => void }).__resetStore();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_FIXTURE_DATES);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('à 15:00 à Paris : 12:00 est indisponible, 19:00 est inchangé', async () => {
    const service = setup();

    const dto = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      now: parisNow('15:00'),
    });

    expect(slotOf(dto, '12:00')?.available).toBe(false);
    expect(slotOf(dto, '14:30')?.available).toBe(false);
    expect(slotOf(dto, '15:00')?.available).toBe(false);
    expect(slotOf(dto, '15:30')?.available).toBe(true);
    expect(slotOf(dto, '19:00')?.available).toBe(true);
  });

  it('garde les créneaux passés dans le tableau : indisponibles, jamais introuvables', async () => {
    const service = setup();
    const before = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      now: parisNow('06:00'),
    });
    (redisCache as unknown as { __resetStore: () => void }).__resetStore();

    const after = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      now: parisNow('15:00'),
    });

    expect(after.slots.map((slot) => slot.time)).toEqual(before.slots.map((slot) => slot.time));
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    expect(slotOf(after, '12:00')).toEqual({ time: '12:00', available: false });
  });

  it('ne change rien pour les jours suivants et ferme les jours précédents', async () => {
    const service = setup();
    const now = parisNow('15:00');

    const later = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date: tomorrow,
      partySize: 2,
      now,
    });
    const earlier = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date: '2026-07-01',
      partySize: 2,
      now,
    });

    expect(later.slots.length).toBeGreaterThan(0);
    expect(later.slots.every((slot) => slot.available)).toBe(true);
    expect(earlier.slots.length).toBeGreaterThan(0);
    expect(earlier.slots.every((slot) => !slot.available)).toBe(true);
  });

  it('un créneau qui commence exactement maintenant est passé', async () => {
    const service = setup();

    const exactly = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      now: parisNow('12:00'),
    });
    expect(slotOf(exactly, '12:00')?.available).toBe(false);
    expect(slotOf(exactly, '12:30')?.available).toBe(true);

    (redisCache as unknown as { __resetStore: () => void }).__resetStore();
    const justBefore = await service.getAvailability({
      restaurantId: RESTAURANT_ID,
      date,
      partySize: 2,
      now: new Date(parisNow('12:00').getTime() - 1),
    });
    expect(slotOf(justBefore, '12:00')?.available).toBe(true);
  });

  it('lit l’horloge par défaut quand `now` n’est pas fourni', async () => {
    vi.setSystemTime(parisNow('15:00'));
    const service = setup();

    const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize: 2 });

    expect(slotOf(dto, '12:00')?.available).toBe(false);
    expect(slotOf(dto, '19:00')?.available).toBe(true);
  });

  describe('autour de minuit, serveur ou navigateur en UTC et restaurant à Paris', () => {
    it('00:30 à Paris le 3 (22:30 UTC le 2) : le 2 est entièrement passé, le 3 entièrement à venir', async () => {
      const service = setup();
      const now = new Date('2026-07-02T22:30:00.000Z');
      expect(now.toISOString().slice(0, 10)).toBe('2026-07-02');

      const thursday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        now,
      });
      const friday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date: tomorrow,
        partySize: 2,
        now,
      });

      expect(thursday.slots.every((slot) => !slot.available)).toBe(true);
      expect(friday.slots.every((slot) => slot.available)).toBe(true);
    });

    it('23:59:59 à Paris le 2 : le dernier créneau du 2 est passé, le 3 est à venir', async () => {
      const service = setup();
      const now = new Date('2026-07-02T21:59:59.000Z');

      const thursday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        now,
      });
      const friday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date: tomorrow,
        partySize: 2,
        now,
      });

      expect(slotOf(thursday, '22:00')?.available).toBe(false);
      expect(slotOf(friday, '12:00')?.available).toBe(true);
    });

    it('suit le fuseau du restaurant, pas celui de l’appelant : 13:00 à New York', async () => {
      const service = setup(openingHours, 'America/New_York');
      const now = new Date('2026-07-02T17:00:00.000Z'); // 13:00 à New York, 19:00 à Paris

      const dto = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        now,
      });

      expect(slotOf(dto, '12:30')?.available).toBe(false);
      expect(slotOf(dto, '13:00')?.available).toBe(false);
      expect(slotOf(dto, '13:30')?.available).toBe(true);
      expect(slotOf(dto, '19:00')?.available).toBe(true);
    });
  });

  describe('cache de 30 secondes', () => {
    it('ne repropose pas un créneau devenu passé pendant que la valeur est en cache', async () => {
      const service = setup();
      const args = { restaurantId: RESTAURANT_ID, date, partySize: 2 };

      const first = await service.getAvailability({ ...args, now: parisNow('14:59') });
      expect(slotOf(first, '15:00')?.available).toBe(true);
      expect(redisCache.set).toHaveBeenCalledTimes(1);

      // 30 secondes plus tard : le créneau de 15:00 a commencé, la valeur est toujours en cache.
      const second = await service.getAvailability({
        ...args,
        now: new Date(parisNow('15:00').getTime() + 10_000),
      });

      expect(redisCache.set).toHaveBeenCalledTimes(1);
      expect(slotOf(second, '15:00')?.available).toBe(false);
      expect(slotOf(second, '15:30')?.available).toBe(true);
    });

    it('stocke le résultat brut, avec le fuseau, jamais le résultat filtré', async () => {
      const service = setup();

      await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        now: parisNow('15:00'),
      });

      const stored = JSON.parse(vi.mocked(redisCache.set).mock.calls[0][1] as string) as {
        timeZone: string;
        dto: { slots: Array<{ time: string; available: boolean }> };
      };
      expect(stored.timeZone).toBe('Europe/Paris');
      expect(slotOf(stored.dto, '12:00')?.available).toBe(true);
    });

    it('ignore une valeur en cache à l’ancien format (le résultat seul) et la recalcule', async () => {
      const service = setup();
      const args = { restaurantId: RESTAURANT_ID, date, partySize: 2, now: parisNow('15:00') };
      await service.getAvailability(args);
      const key = vi.mocked(redisCache.set).mock.calls[0][0] as string;
      const stale = JSON.stringify({
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        slots: [{ time: '12:00', available: true }],
      });
      await redisCache.set(key, stale);
      vi.mocked(redisCache.set).mockClear();

      const dto = await service.getAvailability(args);

      expect(vi.mocked(redisCache.set)).toHaveBeenCalledTimes(1);
      expect(dto.slots.length).toBeGreaterThan(1);
      expect(slotOf(dto, '12:00')?.available).toBe(false);
    });

    it('ne modifie pas le résultat qu’il reçoit', () => {
      const dto = {
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        slots: [{ time: '12:00', available: true }],
      };

      const marked = markTooSoonSlotsUnavailable(dto, 'Europe/Paris', parisNow('15:00'));

      expect(marked.slots[0].available).toBe(false);
      expect(dto.slots[0].available).toBe(true);
    });

    it('indique aussi le passé pour les créneaux déjà complets, sans confondre avec le délai', () => {
      const dto = {
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        slots: [
          { time: '14:00', available: false },
          { time: '15:00', available: true },
          { time: '15:30', available: true },
        ],
      };
      const result = markTooSoonSlotsUnavailable(dto, 'Europe/Paris', parisNow('15:00'), 120, true);
      expect(result.slots).toEqual([
        { time: '14:00', available: false, past: true },
        { time: '15:00', available: false, past: true },
        { time: '15:30', available: false, past: false },
      ]);
    });
  });

  describe('délai minimum de réservation (surfaces en ligne)', () => {
    const args = { restaurantId: RESTAURANT_ID, date, partySize: 2 };

    it('avec 2 h à 15:00 : 16:30 est indisponible, 17:00 (maintenant + 2 h pile) est réservable', async () => {
      const service = setup();

      const dto = await service.getAvailability({
        ...args,
        now: parisNow('15:00'),
        minLeadTimeMinutes: 120,
      });

      expect(slotOf(dto, '15:30')?.available).toBe(false);
      expect(slotOf(dto, '16:30')?.available).toBe(false);
      expect(slotOf(dto, '17:00')?.available).toBe(true);
      expect(slotOf(dto, '19:00')?.available).toBe(true);
    });

    it('avec 30 min à 15:00 : 15:00 est passé, 15:30 (maintenant + 30 min pile) est réservable', async () => {
      const service = setup();

      const dto = await service.getAvailability({
        ...args,
        now: parisNow('15:00'),
        minLeadTimeMinutes: 30,
      });

      expect(slotOf(dto, '15:00')?.available).toBe(false);
      expect(slotOf(dto, '15:30')?.available).toBe(true);
    });

    it('sans délai (voix, personnel), le même créneau reste réservable', async () => {
      const service = setup();

      const dto = await service.getAvailability({ ...args, now: parisNow('15:00') });

      expect(slotOf(dto, '15:30')?.available).toBe(true);
      expect(slotOf(dto, '16:30')?.available).toBe(true);
    });

    it('garde la forme de la réponse : les créneaux trop proches restent dans le tableau', async () => {
      const service = setup();
      const without = await service.getAvailability({ ...args, now: parisNow('15:00') });
      (redisCache as unknown as { __resetStore: () => void }).__resetStore();

      const withLead = await service.getAvailability({
        ...args,
        now: parisNow('15:00'),
        minLeadTimeMinutes: 120,
      });

      expect(withLead.slots.map((slot) => slot.time)).toEqual(
        without.slots.map((slot) => slot.time),
      );
      expect(Object.keys(withLead).sort()).toEqual(Object.keys(without).sort());
      expect(slotOf(withLead, '16:00')).toEqual({ time: '16:00', available: false });
    });

    it('applique le délai après le cache : une valeur lue sans délai ne fuit pas vers un appelant en ligne', async () => {
      const service = setup();

      // La voix lit d'abord (sans délai) : le cache reçoit le résultat brut.
      const voice = await service.getAvailability({ ...args, now: parisNow('15:00') });
      expect(slotOf(voice, '16:00')?.available).toBe(true);
      expect(redisCache.set).toHaveBeenCalledTimes(1);

      // Une page en ligne lit ensuite la même valeur en cache, avec son délai de 2 h.
      const online = await service.getAvailability({
        ...args,
        now: parisNow('15:00'),
        minLeadTimeMinutes: 120,
      });

      expect(redisCache.set).toHaveBeenCalledTimes(1); // lecture en cache, pas de recalcul
      expect(slotOf(online, '16:00')?.available).toBe(false);
      expect(slotOf(online, '17:00')?.available).toBe(true);

      // Et l'inverse : le résultat « en ligne » n'a pas pollué le cache pour la voix.
      const voiceAgain = await service.getAvailability({ ...args, now: parisNow('15:00') });
      expect(slotOf(voiceAgain, '16:00')?.available).toBe(true);
    });

    it('stocke le résultat brut : le délai n’entre ni dans la valeur ni dans la clé', async () => {
      const service = setup();

      await service.getAvailability({ ...args, now: parisNow('15:00'), minLeadTimeMinutes: 120 });

      const [key, value] = vi.mocked(redisCache.set).mock.calls[0] as unknown as [string, string];
      expect(key).not.toMatch(/120|lead/i);
      const stored = JSON.parse(value) as {
        dto: { slots: Array<{ time: string; available: boolean }> };
      };
      expect(slotOf(stored.dto, '16:00')?.available).toBe(true);
    });

    it('un délai d’un jour ferme le début de demain, pas l’après-midi', async () => {
      const service = setup();
      const now = parisNow('15:00'); // jeudi 15:00

      const friday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date: tomorrow,
        partySize: 2,
        now,
        minLeadTimeMinutes: 1440,
      });

      // Vendredi 12:00 est dans 21 h, 14:00 dans 23 h : tous deux sous les 24 h de délai.
      expect(slotOf(friday, '12:00')?.available).toBe(false);
      expect(slotOf(friday, '14:00')?.available).toBe(false);
    });

    it('traverse minuit : à 23:30 avec 2 h, le début de demain est trop proche', async () => {
      const service = setup();

      const friday = await service.getAvailability({
        restaurantId: RESTAURANT_ID,
        date: tomorrow,
        partySize: 2,
        now: parisNow('23:30'),
        minLeadTimeMinutes: 120,
      });

      // Vendredi 12:00 est dans 12 h 30 : réservable malgré le délai de 2 h.
      expect(slotOf(friday, '12:00')?.available).toBe(true);
    });

    it('markTooSoonSlotsUnavailable ne modifie pas le résultat reçu et gère un délai géant', () => {
      const dto = {
        restaurantId: RESTAURANT_ID,
        date,
        partySize: 2,
        slots: [{ time: '19:00', available: true }],
      };

      const marked = markTooSoonSlotsUnavailable(dto, 'Europe/Paris', parisNow('15:00'), 120);
      const huge = markTooSoonSlotsUnavailable(dto, 'Europe/Paris', parisNow('15:00'), 10_000);

      expect(marked.slots[0].available).toBe(true);
      expect(huge.slots[0].available).toBe(false);
      expect(dto.slots[0].available).toBe(true);
    });
  });
});

describe('sans table : disponibilité et création restent d’accord', () => {
  beforeEach(() => {
    (redisCache as unknown as { __resetStore: () => void }).__resetStore();
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(BEFORE_FIXTURE_DATES);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SLOT_MINUTES = 120;
  const TIMES = ['17:00', '17:30', '18:00', '19:00', '20:00'];
  const parisAt = (time: string) => zonedTimeToUtc(date, time, 'Europe/Paris');

  /**
   * Pour chaque créneau et chaque taille de groupe : la disponibilité annonce « oui » exactement quand
   * la création accepterait la même réservation sans table.
   */
  async function expectSameVerdict(
    prisma: PrismaClient,
    partySizes: number[],
  ): Promise<Record<string, boolean>> {
    const service = new CapacityAwareAvailabilityService(prisma);
    const verdicts: Record<string, boolean> = {};
    for (const partySize of partySizes) {
      const dto = await service.getAvailability({ restaurantId: RESTAURANT_ID, date, partySize });
      for (const time of TIMES) {
        const startsAt = zonedTimeToUtc(date, time, 'Europe/Paris');
        const { conflict } = await findUnassignedSeatingConflict(prisma, {
          restaurantId: RESTAURANT_ID,
          partySize,
          startsAt,
          endsAt: new Date(startsAt.getTime() + SLOT_MINUTES * 60_000),
          now: new Date(),
        });
        const available = dto.slots.find((s) => s.time === time)?.available ?? false;
        expect(available, `${partySize} couverts à ${time}`).toBe(!conflict);
        verdicts[`${partySize}@${time}`] = available;
      }
    }
    return verdicts;
  }

  function withExposureSettings(prisma: PrismaClient): PrismaClient {
    return Object.assign(prisma, {
      restaurantExposureSettings: { findUnique: async () => ({ capacitySpecials: {} }) },
    }) as PrismaClient;
  }

  it('une réservation sans table n’occupe qu’une table : la place libre reste ouverte', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-2', floorPlanId: FLOOR_PLAN_ID, capacity: 2 }),
        makeTable({ id: 't-4', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
      ],
      reservations: [
        makeReservation({
          id: 'r-loose',
          tableId: null,
          partySize: 2,
          startsAt: parisAt('17:00'),
          endsAt: parisAt('19:00'),
        }),
      ],
    });
    const fake = withExposureSettings(prisma);

    const verdicts = await expectSameVerdict(fake, [2, 4, 6]);

    // Le groupe sans table prend la table de 2 ; celle de 4 reste libre à 17 h.
    expect(verdicts['4@17:00']).toBe(true);
    expect(verdicts['2@17:00']).toBe(true);
    expect(verdicts['6@17:00']).toBe(false);
  });

  it('jusqu’à saturation : deux groupes sans table, puis une table avec, ferment la plage', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-2', floorPlanId: FLOOR_PLAN_ID, capacity: 2 }),
        makeTable({ id: 't-4', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
      ],
      reservations: [
        makeReservation({
          id: 'r-loose-1',
          tableId: null,
          partySize: 2,
          startsAt: parisAt('17:00'),
          endsAt: parisAt('19:00'),
        }),
        makeReservation({
          id: 'r-assigned',
          tableId: 't-4',
          partySize: 4,
          startsAt: parisAt('17:00'),
          endsAt: parisAt('19:00'),
        }),
      ],
    });
    const fake = withExposureSettings(prisma);

    const verdicts = await expectSameVerdict(fake, [2, 4]);

    // Le groupe sans table prend la table de 2 ; la table de 4 est fixée : plus rien pour 2 couverts.
    expect(verdicts['2@17:00']).toBe(false);
    expect(verdicts['4@17:00']).toBe(false);
    // À 19 h, le créneau ne chevauche plus les réservations.
    expect(verdicts['2@19:00']).toBe(true);
  });

  it('un hold actif sans table occupe une table, comme une réservation', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [
        makeTable({ id: 't-2', floorPlanId: FLOOR_PLAN_ID, capacity: 2 }),
        makeTable({ id: 't-4', floorPlanId: FLOOR_PLAN_ID, capacity: 4 }),
      ],
      holds: [
        makeHold({
          id: 'h-loose',
          tableId: null,
          partySize: 2,
          slotStart: parisAt('17:00'),
          slotEnd: parisAt('19:00'),
          expiresAt: new Date(Date.now() + 10 * 60_000),
        }),
      ],
    });
    const fake = withExposureSettings(prisma);

    const verdicts = await expectSameVerdict(fake, [2, 4]);

    expect(verdicts['4@17:00']).toBe(true);
    expect(verdicts['2@17:00']).toBe(true);
  });

  it('aucune table compatible : un groupe trop grand est refusé par la disponibilité et la création', async () => {
    const { prisma } = makeMockPrisma({
      restaurant: makeBaseRestaurant(),
      tables: [makeTable({ id: 't-4', floorPlanId: FLOOR_PLAN_ID, capacity: 4 })],
      reservations: [
        makeReservation({
          id: 'r-loose',
          tableId: null,
          partySize: 2,
          startsAt: parisAt('17:00'),
          endsAt: parisAt('19:00'),
        }),
      ],
    });
    const fake = withExposureSettings(prisma);

    const verdicts = await expectSameVerdict(fake, [4, 6]);

    expect(verdicts['6@17:00']).toBe(false);
    expect(verdicts['4@17:00']).toBe(false);
  });
});
