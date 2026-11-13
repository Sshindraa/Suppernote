import { describe, expect, it, vi } from 'vitest';
import { executeTool, type McpToolRegistry, type ToolContext } from '../registry';

const context: ToolContext = {
  clientId: 'client-a',
  clientName: 'Test client',
  restaurantId: null,
  scopes: ['mcp:read'],
  actor: 'agent:client-a',
  transport: 'mcp',
};

describe('answer_availability', () => {
  it('returns only the human-facing sentence, without the structured search window', async () => {
    const args = {
      city: 'Lyon',
      partySize: 2,
      restaurantName: 'Chez Suppernote',
      slotStart: '2026-10-01T19:00:00',
      timezone: 'Europe/Paris',
    };
    const searchRestaurants = vi.fn().mockResolvedValue({
      ok: true,
      data: {
        searchOutcome: 'available',
        requestedRestaurant: {
          id: '550e8400-e29b-41d4-a716-446655440000',
          name: 'Chez Suppernote',
          status: 'available',
        },
        restaurants: [
          {
            id: '550e8400-e29b-41d4-a716-446655440000',
            name: 'Chez Suppernote',
            slug: 'chez-sokar',
            formattedAddress: 'Lyon',
            cuisineType: [],
            priceRange: null,
            maxOnlinePartySize: 6,
            availableSlots: [
              {
                startsAt: '2026-10-01T17:00:00.000Z',
                endsAt: '2026-10-01T19:00:00.000Z',
              },
            ],
          },
        ],
        capacityLimits: [],
      },
    });
    const registry = { searchRestaurants } as unknown as McpToolRegistry;

    const result = await executeTool(registry, 'answer_availability', args, context);

    expect(searchRestaurants).toHaveBeenCalledWith(args, context);
    expect(result).toEqual({
      ok: true,
      data: {
        message:
          'Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h.',
      },
    });
  });
});
