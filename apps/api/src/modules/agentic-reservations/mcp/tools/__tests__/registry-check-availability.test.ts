import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { McpToolRegistry } from '../registry';
import { McpRateLimiter } from '../../rate-limit';
import { renderMetrics } from '../../../../../shared/observability/metrics';
import { CheckAvailabilityOutputSchema } from '../schemas';

const makePrisma = () =>
  ({
    restaurant: {
      findFirst: vi.fn().mockResolvedValue({
        timezone: 'Europe/Paris',
        exposureSettings: {
          maxPartySize: 12,
          minLeadTimeMinutes: 0,
          exposedCreneaux: [],
        },
        floorPlans: [{ tables: [{ capacity: 6 }] }],
      } as unknown as Awaited<ReturnType<PrismaClient['restaurant']['findFirst']>>),
    },
    reservation: { count: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (cb: unknown) =>
      (cb as (tx: Record<string, unknown>) => Promise<unknown>)({}),
    ),
  }) as unknown as PrismaClient;

const makeRateLimiter = () =>
  ({
    check: vi.fn().mockResolvedValue({ allowed: true }),
  }) as unknown as McpRateLimiter;

describe('McpToolRegistry.checkAvailability metrics', () => {
  it("observe la durée même en cas d'erreur métier", async () => {
    const beforePayload = await renderMetrics();
    const beforeMatch = beforePayload.match(
      /suppernote_agentic_check_availability_duration_ms_count (\d+)/,
    );
    const before = beforeMatch ? parseInt(beforeMatch[1], 10) : 0;

    const prisma = makePrisma();
    const registry = new McpToolRegistry(prisma, makeRateLimiter());

    // Simule un service qui throw
    (registry as unknown as Record<string, unknown>).availabilityService = {
      checkAvailability: vi.fn().mockRejectedValue(new Error('DB down')),
    };

    const result = await registry.checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: '2026-12-01T19:00:00Z',
        slotEnd: '2026-12-01T21:00:00Z',
      },
      {
        clientId: 'c1',
        clientName: 'test',
        restaurantId: null,
        scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        actor: 'test',
      },
    );

    const afterPayload = await renderMetrics();
    const afterMatch = afterPayload.match(
      /suppernote_agentic_check_availability_duration_ms_count (\d+)/,
    );
    const after = afterMatch ? parseInt(afterMatch[1], 10) : 0;

    if (result.ok) {
      throw new Error('Expected checkAvailability to return a tool error');
    }
    expect(result.code).toBe('INTERNAL');
    expect(after).toBe(before + 1);
  });

  it('vérifie deux heures par défaut quand la fin manque', async () => {
    // Horloge épinglée : le créneau est refusé s'il est déjà passé, donc une date fixe
    // sans horloge fixe échoue dès que cette date arrive (CI du 01/10/2026 après 19 h).
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00.000Z') });
    try {
      const prisma = makePrisma();
      const registry = new McpToolRegistry(prisma, makeRateLimiter());
      const checkAvailability = vi.fn().mockResolvedValue({ available: true });
      (registry as unknown as Record<string, unknown>).availabilityService = {
        checkAvailability,
      };

      const result = await registry.checkAvailability(
        {
          restaurantId: '550e8400-e29b-41d4-a716-446655440000',
          partySize: 2,
          slotStart: '2026-10-01T19:00:00',
        },
        {
          clientId: 'c1',
          clientName: 'test',
          restaurantId: null,
          scopes: ['mcp:read'],
          actor: 'test',
        },
      );

      expect(checkAvailability).toHaveBeenCalledWith({
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: new Date('2026-10-01T17:00:00.000Z'),
        slotEnd: new Date('2026-10-01T19:00:00.000Z'),
      });
      expect(result).toMatchObject({ ok: true, data: { available: true, decision: 'available' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('convertit un horaire local MCP dans le fuseau du restaurant', async () => {
    vi.useFakeTimers({ now: new Date('2026-01-01T12:00:00.000Z') });
    try {
      const prisma = makePrisma();
      const registry = new McpToolRegistry(prisma, makeRateLimiter());
      const checkAvailability = vi.fn().mockResolvedValue({ available: true });
      (registry as unknown as Record<string, unknown>).availabilityService = {
        checkAvailability,
      };

      const result = await registry.checkAvailability(
        {
          restaurantId: '550e8400-e29b-41d4-a716-446655440000',
          partySize: 2,
          slotStart: '2026-09-10T20:00:00',
          slotEnd: '2026-09-10T22:00:00',
        },
        {
          clientId: 'c1',
          clientName: 'test',
          restaurantId: null,
          scopes: ['mcp:read', 'mcp:reserve'],
          actor: 'test',
        },
      );

      expect(result).toEqual({
        ok: true,
        data: {
          available: true,
          alternativeSlots: [],
          decision: 'available',
          recommendedAction: 'create_hold',
        },
      });
      if (result.ok) expect(CheckAvailabilityOutputSchema.parse(result.data)).toEqual(result.data);
      expect(checkAvailability).toHaveBeenCalledWith({
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: new Date('2026-09-10T18:00:00.000Z'),
        slotEnd: new Date('2026-09-10T20:00:00.000Z'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('retourne une erreur explicite pour un horaire local inexistant', async () => {
    const prisma = makePrisma();
    const registry = new McpToolRegistry(prisma, makeRateLimiter());
    const checkAvailability = vi.fn();
    (registry as unknown as Record<string, unknown>).availabilityService = {
      checkAvailability,
    };

    const result = await registry.checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: '2026-03-29T02:30:00',
        slotEnd: '2026-03-29T04:00:00',
      },
      {
        clientId: 'c1',
        clientName: 'test',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({ ok: false, code: 'INVALID_DATETIME' });
    expect(checkAvailability).not.toHaveBeenCalled();
  });

  it("ne recommande pas de créer un hold si le jeton n'a que le scope lecture", async () => {
    const prisma = makePrisma();
    const registry = new McpToolRegistry(prisma, makeRateLimiter());
    (registry as unknown as Record<string, unknown>).availabilityService = {
      checkAvailability: vi.fn().mockResolvedValue({ available: true }),
    };

    const result = await registry.checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: '2026-12-01T19:00:00Z',
        slotEnd: '2026-12-01T21:00:00Z',
      },
      {
        clientId: 'c1',
        clientName: 'test',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        available: true,
        decision: 'available',
        recommendedAction: 'request_reserve_scope',
      },
    });
  });

  it('recommande une alternative sans exposer les identifiants internes de conflit', async () => {
    const prisma = makePrisma();
    const registry = new McpToolRegistry(prisma, makeRateLimiter());
    const alternativeSlots = [
      {
        startsAt: '2026-12-01T21:00:00.000Z',
        endsAt: '2026-12-01T23:00:00.000Z',
      },
    ];
    (registry as unknown as Record<string, unknown>).availabilityService = {
      checkAvailability: vi.fn().mockResolvedValue({
        available: false,
        alternativeSlots,
        reason: 'hold_active',
        conflictingHoldId: '550e8400-e29b-41d4-a716-446655440001',
        conflictingReservationId: '550e8400-e29b-41d4-a716-446655440002',
      }),
    };

    const result = await registry.checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart: '2026-12-01T19:00:00Z',
        slotEnd: '2026-12-01T21:00:00Z',
      },
      {
        clientId: 'c1',
        clientName: 'test',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        available: false,
        alternativeSlots,
        reason: 'hold_active',
        decision: 'unavailable',
        recommendedAction: 'choose_alternative_slot',
      },
    });
    if (result.ok) expect(CheckAvailabilityOutputSchema.parse(result.data)).toEqual(result.data);
  });

  it('refuse un groupe supérieur à la capacité physique avec la limite exacte', async () => {
    const prisma = makePrisma();
    const registry = new McpToolRegistry(prisma, makeRateLimiter());

    const result = await registry.checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 7,
        slotStart: '2026-12-01T19:00:00Z',
        slotEnd: '2026-12-01T21:00:00Z',
      },
      {
        clientId: 'c1',
        clientName: 'test',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({ ok: false, code: 'POLICY_VIOLATION' });
    if (!result.ok) {
      expect(result.error).toContain('maxPartySize 6');
      expect(result.error).toContain('capacité maximale en ligne');
    }
  });
});

describe('McpToolRegistry.checkAvailability — créneaux passés (service et moteur réels)', () => {
  // Jeudi 2 juillet 2026, 15:00 à Paris. Le délai minimum est réglé à 0 : seule la règle « créneau
  // passé » du moteur peut alors refuser un créneau qui commence exactement maintenant.
  const NOW = new Date('2026-07-02T13:00:00.000Z');
  const TOOL_CONTEXT = {
    clientId: 'c1',
    clientName: 'test',
    restaurantId: null,
    scopes: ['mcp:read', 'mcp:reserve'],
    actor: 'test',
  };

  function makeEnginePrisma(minLeadTimeMinutes = 0) {
    const restaurant = {
      timezone: 'Europe/Paris',
      openingHours: {
        thu: { open: '12:00', close: '22:30' },
        fri: { open: '12:00', close: '22:30' },
      },
      exposureSettings: {
        maxPartySize: 12,
        minLeadTimeMinutes,
        exposedCreneaux: [],
        capacitySpecials: {},
      },
      floorPlans: [{ tables: [{ capacity: 6 }] }],
    };
    return {
      restaurant: {
        findFirst: vi.fn().mockResolvedValue(restaurant),
        findUnique: vi.fn().mockResolvedValue(restaurant),
      },
      reservation: { count: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
      agenticHold: { findMany: vi.fn().mockResolvedValue([]) },
      table: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 't-1', capacity: 6, minCapacity: 1, sectionId: null }]),
      },
    } as unknown as PrismaClient;
  }

  const call = (slotStart: string, minLeadTimeMinutes = 0) =>
    new McpToolRegistry(makeEnginePrisma(minLeadTimeMinutes), makeRateLimiter()).checkAvailability(
      {
        restaurantId: '550e8400-e29b-41d4-a716-446655440000',
        partySize: 2,
        slotStart,
        slotEnd: undefined,
      },
      TOOL_CONTEXT,
    );

  it('répond « indisponible » pour un créneau qui commence exactement maintenant', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const result = await call('2026-07-02T15:00:00');

      expect(result).toMatchObject({
        ok: true,
        data: { available: false, decision: 'unavailable' },
      });
      if (result.ok) {
        expect(CheckAvailabilityOutputSchema.parse(result.data)).toEqual(result.data);
        for (const alternative of (result.data as { alternativeSlots: Array<{ startsAt: string }> })
          .alternativeSlots) {
          expect(new Date(alternative.startsAt).getTime()).toBeGreaterThan(NOW.getTime());
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('répond « disponible » pour un créneau à venir', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      const result = await call('2026-07-02T19:00:00');
      expect(result).toMatchObject({ ok: true, data: { available: true, decision: 'available' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('délai minimum : le MCP le refuse déjà, comportement inchangé (POLICY_VIOLATION), limite exacte permise', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    try {
      // 2 h de délai à 15:00 : 16:30 est refusé, 17:00 (maintenant + 2 h pile) est disponible.
      const tooSoon = await call('2026-07-02T16:30:00', 120);
      expect(tooSoon).toMatchObject({ ok: false, code: 'POLICY_VIOLATION' });
      expect(tooSoon.ok ? '' : tooSoon.error).toMatch(/Insufficient lead time/);

      const atLimit = await call('2026-07-02T17:00:00', 120);
      expect(atLimit).toMatchObject({ ok: true, data: { available: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});
