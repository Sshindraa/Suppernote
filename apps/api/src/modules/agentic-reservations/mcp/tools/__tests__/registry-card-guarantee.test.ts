import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const guarantee = vi.hoisted(() => ({ terms: vi.fn() }));
vi.mock('../../../../reservation-payments/reservation-guarantee.public', () => ({
  findCardGuaranteeTerms: guarantee.terms,
}));

import { McpToolRegistry } from '../registry';
import type { McpRateLimiter } from '../../rate-limit';

const RESTAURANT_ID = '550e8400-e29b-41d4-a716-446655440000';

const makePrisma = () =>
  ({
    restaurant: {
      findFirst: vi.fn().mockResolvedValue({
        timezone: 'Europe/Paris',
        exposureSettings: { maxPartySize: 12, minLeadTimeMinutes: 0, exposedCreneaux: [] },
        floorPlans: [{ tables: [{ capacity: 8 }] }],
      }),
      findUnique: vi.fn().mockResolvedValue({ slug: 'chez-test' }),
    },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  }) as unknown as PrismaClient;

const ctx = {
  clientId: 'c1',
  clientName: 'test',
  restaurantId: null,
  scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
  actor: 'agent:test',
};

const input = {
  restaurantId: RESTAURANT_ID,
  partySize: 6,
  startsAt: '2026-12-31T19:00:00Z',
  endsAt: '2026-12-31T21:00:00Z',
  customerName: 'Alice',
  customerPhone: '+33612345678',
  idempotencyKey: 'mcp-key-1',
  consents: { reservationProcessing: true },
};

describe('McpToolRegistry.createReservation et empreinte bancaire', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-13T10:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('renvoie vers la page du restaurant sans rien créer', async () => {
    guarantee.terms.mockResolvedValue({ policyId: 'policy-1', totalAmount: '120.00' });
    const registry = new McpToolRegistry(makePrisma(), {
      check: vi.fn().mockResolvedValue({ allowed: true }),
    } as unknown as McpRateLimiter);
    const create = vi.fn();
    (registry as unknown as Record<string, unknown>).reservationService = {
      createReservation: create,
    };

    const result = await registry.createReservation(input, ctx);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CARD_GUARANTEE_REQUIRED');
    expect(result.error).toContain('/book/chez-test');
    expect(guarantee.terms).toHaveBeenCalledWith({
      restaurantId: RESTAURANT_ID,
      partySize: 6,
      localDate: '2026-12-31',
    });
    expect(create).not.toHaveBeenCalled();
  });
});
