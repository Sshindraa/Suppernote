import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { McpToolRegistry } from '../registry';
import { McpRateLimiter } from '../../rate-limit';
import { SearchRestaurantsOutputSchema } from '../schemas';

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
      }),
    },
    reservationAuditLog: { create: vi.fn().mockResolvedValue({}) },
  }) as unknown as PrismaClient;

const makeRateLimiter = () =>
  ({ check: vi.fn().mockResolvedValue({ allowed: true }) }) as unknown as McpRateLimiter;

describe('McpToolRegistry.searchRestaurants capacity guidance', () => {
  it('renvoie la capacité en ligne au lieu de laisser le client conclure à tort que le restaurant est introuvable', async () => {
    const registry = new McpToolRegistry(makePrisma(), makeRateLimiter());
    const availabilityService = {
      searchAvailableRestaurantsPage: vi.fn().mockResolvedValue({ results: [] }),
      findCapacityLimits: vi.fn().mockResolvedValue([
        {
          restaurantId: '550e8400-e29b-41d4-a716-446655440003',
          name: 'Chez Suppernote',
          slug: 'chez-sokar',
          formattedAddress: '12 Rue de la République, 69001 Lyon',
          cuisineType: ['Bistrot', 'Française'],
          priceRange: 2,
          maxOnlinePartySize: 6,
        },
      ]),
    };
    (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;

    const result = await registry.searchRestaurants(
      {
        city: 'Lyon',
        partySize: 20,
        slotStart: '2026-09-17T20:00:00+02:00',
        slotEnd: '2026-09-17T22:00:00+02:00',
      },
      {
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toEqual({
      ok: true,
      data: {
        searchOutcome: 'capacity_exceeded',
        restaurants: [],
        capacityLimits: [
          {
            id: '550e8400-e29b-41d4-a716-446655440003',
            name: 'Chez Suppernote',
            slug: 'chez-sokar',
            formattedAddress: '12 Rue de la République, 69001 Lyon',
            cuisineType: ['Bistrot', 'Française'],
            priceRange: 2,
            maxOnlinePartySize: 6,
          },
        ],
        nextCursor: undefined,
      },
    });
    if (result.ok) expect(SearchRestaurantsOutputSchema.safeParse(result.data).success).toBe(true);
    expect(availabilityService.findCapacityLimits).toHaveBeenCalledWith({
      city: 'Lyon',
      partySize: 20,
      cuisineType: undefined,
      maxResults: 5,
    });
  });

  it('indique que des résultats vides ne prouvent pas que le restaurant est introuvable', async () => {
    const registry = new McpToolRegistry(makePrisma(), makeRateLimiter());
    const availabilityService = {
      searchAvailableRestaurantsPage: vi.fn().mockResolvedValue({ results: [] }),
      findCapacityLimits: vi.fn().mockResolvedValue([]),
    };
    (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;

    const result = await registry.searchRestaurants(
      {
        city: 'Lyon',
        partySize: 2,
        slotStart: '2026-09-17T19:00:00+02:00',
      },
      {
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        searchOutcome: 'no_exact_slot_available',
        restaurants: [],
        capacityLimits: [],
      },
    });
    expect(availabilityService.searchAvailableRestaurantsPage).toHaveBeenCalledWith(
      expect.objectContaining({
        slotStart: new Date('2026-09-17T17:00:00.000Z'),
        slotEnd: new Date('2026-09-17T19:00:00.000Z'),
      }),
    );
    if (result.ok) expect(SearchRestaurantsOutputSchema.safeParse(result.data).success).toBe(true);
  });

  it('distingue une fiche nommée trouvée mais indisponible du restaurant introuvable', async () => {
    const registry = new McpToolRegistry(makePrisma(), makeRateLimiter());
    const restaurantId = '550e8400-e29b-41d4-a716-446655440003';
    const availabilityService = {
      searchAvailableRestaurantsPage: vi.fn().mockResolvedValue({
        results: [],
        restaurantMatches: [{ restaurantId, name: 'Chez Suppernote' }],
      }),
      findCapacityLimits: vi.fn().mockResolvedValue([]),
    };
    (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;

    const result = await registry.searchRestaurants(
      {
        city: 'Lyon',
        restaurantName: 'Chez Suppernote',
        partySize: 2,
        slotStart: '2026-09-17T19:00:00+02:00',
      },
      {
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        searchOutcome: 'no_exact_slot_available',
        requestedRestaurant: {
          id: restaurantId,
          name: 'Chez Suppernote',
          status: 'unavailable',
        },
        restaurants: [],
      },
    });
    expect(availabilityService.searchAvailableRestaurantsPage).toHaveBeenCalledWith(
      expect.objectContaining({ city: 'Lyon', restaurantName: 'Chez Suppernote' }),
    );
    if (result.ok) expect(SearchRestaurantsOutputSchema.safeParse(result.data).success).toBe(true);
  });

  it('signale sans UUID qu’aucune fiche MCP du nom demandé ne correspond à cette ville', async () => {
    const registry = new McpToolRegistry(makePrisma(), makeRateLimiter());
    const availabilityService = {
      searchAvailableRestaurantsPage: vi
        .fn()
        .mockResolvedValue({ results: [], restaurantMatches: [] }),
      findCapacityLimits: vi.fn().mockResolvedValue([]),
    };
    (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;

    const result = await registry.searchRestaurants(
      {
        city: 'Lyon',
        restaurantName: 'Chez Suppernote',
        partySize: 2,
        slotStart: '2026-09-17T19:00:00+02:00',
      },
      {
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'test',
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: {
        requestedRestaurant: { name: 'Chez Suppernote', status: 'not_found' },
      },
    });
    if (result.ok) expect(SearchRestaurantsOutputSchema.safeParse(result.data).success).toBe(true);
  });

  it('continues past filtered restaurants and consumes the cursor', async () => {
    const prisma = makePrisma();
    vi.mocked(prisma.restaurant.findFirst).mockResolvedValueOnce(null);
    const registry = new McpToolRegistry(prisma, makeRateLimiter());
    const restaurantId = '550e8400-e29b-41d4-a716-446655440003';
    const availabilityService = {
      searchAvailableRestaurantsPage: vi
        .fn()
        .mockResolvedValueOnce({
          results: [
            {
              restaurantId: '550e8400-e29b-41d4-a716-446655440001',
              name: 'Hidden',
              slug: 'hidden',
            },
          ],
          nextCursor: '550e8400-e29b-41d4-a716-446655440002',
        })
        .mockResolvedValueOnce({
          results: [
            {
              restaurantId,
              name: 'Chez Suppernote',
              slug: 'chez-sokar',
              formattedAddress: '12 Rue de la République, 69001 Lyon',
              cuisineType: ['Bistrot', 'Française'],
              priceRange: 2,
              distanceMeters: null,
            },
          ],
        }),
      findCapacityLimits: vi.fn(),
    };
    (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;
    const result = await registry.searchRestaurants(
      {
        city: 'Lyon',
        partySize: 2,
        slotStart: '2026-12-17T20:00:00+01:00',
        slotEnd: '2026-12-17T22:00:00+01:00',
        maxResults: 1,
      },
      {
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: null,
        scopes: ['mcp:read'],
        actor: 'agent:client-1',
      },
    );
    expect(result).toMatchObject({
      ok: true,
      data: {
        searchOutcome: 'available',
        restaurants: [
          {
            id: restaurantId,
            formattedAddress: '12 Rue de la République, 69001 Lyon',
            cuisineType: ['Bistrot', 'Française'],
            priceRange: 2,
            availableSlots: [
              {
                startsAt: '2026-12-17T19:00:00.000Z',
                endsAt: '2026-12-17T21:00:00.000Z',
              },
            ],
          },
        ],
        nextCursor: undefined,
      },
    });
    if (result.ok) expect(SearchRestaurantsOutputSchema.safeParse(result.data).success).toBe(true);
    expect(availabilityService.searchAvailableRestaurantsPage).toHaveBeenCalledTimes(2);
    expect(availabilityService.searchAvailableRestaurantsPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: '550e8400-e29b-41d4-a716-446655440002' }),
    );
  });
});
