/**
 * Sites suspendus ou archivés côté MCP / agent générique : aucune nouvelle réservation,
 * mais annulation et consultation des réservations existantes restent possibles.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { McpToolRegistry, type ToolContext } from '../registry';
import type { McpRateLimiter } from '../../rate-limit';

const RESTAURANT_ID = '550e8400-e29b-41d4-a716-446655440001';
const RESERVATION_ID = '550e8400-e29b-41d4-a716-446655440000';
const PHONE = '+33612345678';

const ctx: ToolContext = {
  clientId: 'client-a',
  clientName: 'Agent A',
  restaurantId: null,
  scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
  actor: 'agent:client-a',
  transport: 'mcp',
};

const SLOT = { slotStart: '2026-12-01T19:00:00Z', slotEnd: '2026-12-01T21:00:00Z' };

/** Simule la base : le restaurant n'est trouvé que si son statut n'est pas exclu par `where`. */
function makeRegistry(siteStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
  const restaurantRow = {
    timezone: 'Europe/Paris',
    exposureSettings: { maxPartySize: 12, minLeadTimeMinutes: 0, exposedCreneaux: [] },
    floorPlans: [{ tables: [{ capacity: 6 }] }],
  };
  const prisma = {
    restaurant: {
      findFirst: vi.fn(async (args: { where: { siteStatus?: { notIn: string[] } } }) =>
        args.where.siteStatus?.notIn.includes(siteStatus) ? null : restaurantRow,
      ),
    },
    reservation: {
      findUnique: vi.fn().mockResolvedValue({
        id: RESERVATION_ID,
        restaurantId: RESTAURANT_ID,
        createdByClient: ctx.actor,
        customerPhone: PHONE,
        state: 'CONFIRMED',
        partySize: 2,
        startsAt: new Date('2026-12-01T19:00:00Z'),
        endsAt: new Date('2026-12-01T21:00:00Z'),
        createdAt: new Date('2026-09-28T19:00:00Z'),
      }),
    },
  } as unknown as PrismaClient;
  const limiter = {
    check: vi.fn().mockResolvedValue({ allowed: true }),
  } as unknown as McpRateLimiter;
  const registry = new McpToolRegistry(prisma, limiter);
  const availabilityService = { checkAvailability: vi.fn().mockResolvedValue({ available: true }) };
  (registry as unknown as Record<string, unknown>).availabilityService = availabilityService;
  return { registry, availabilityService };
}

describe.each(['SUSPENDED', 'ARCHIVED'] as const)('MCP — site %s', (siteStatus) => {
  it('check_availability : NOT_FOUND, aucune disponibilité calculée', async () => {
    const { registry, availabilityService } = makeRegistry(siteStatus);
    const result = await registry.checkAvailability(
      { restaurantId: RESTAURANT_ID, partySize: 2, ...SLOT },
      ctx,
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(availabilityService.checkAvailability).not.toHaveBeenCalled();
  });

  it('create_hold : NOT_FOUND', async () => {
    const { registry } = makeRegistry(siteStatus);
    const result = await registry.createQuoteOrHold(
      { restaurantId: RESTAURANT_ID, partySize: 2, ...SLOT },
      ctx,
      'hold',
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('create_reservation : NOT_FOUND', async () => {
    const { registry } = makeRegistry(siteStatus);
    const result = await registry.createReservation(
      {
        restaurantId: RESTAURANT_ID,
        partySize: 2,
        startsAt: SLOT.slotStart,
        endsAt: SLOT.slotEnd,
        customerName: 'Alice',
        customerPhone: PHONE,
        idempotencyKey: 'idem-site-inactif-1',
        consents: { reservationProcessing: true },
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('join_waiting_list : NOT_FOUND', async () => {
    const { registry } = makeRegistry(siteStatus);
    const result = await registry.joinWaitingList(
      {
        restaurantId: RESTAURANT_ID,
        partySize: 2,
        ...SLOT,
        customerFirstName: 'Alice',
        customerPhone: PHONE,
        consents: { waitingListProcessing: true, reservationProcessing: true },
      },
      ctx,
    );

    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('cancel_reservation : une réservation existante reste annulable', async () => {
    const { registry } = makeRegistry(siteStatus);
    const cancel = vi
      .spyOn(
        (registry as unknown as { reservationService: { cancelReservation: () => Promise<void> } })
          .reservationService,
        'cancelReservation',
      )
      .mockResolvedValue(undefined);

    const result = await registry.cancelReservation(
      { reservationId: RESERVATION_ID, customerPhone: PHONE },
      ctx,
    );

    expect(result).toMatchObject({ ok: true, data: { cancelled: true } });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe('MCP — site actif', () => {
  it('check_availability passe la condition de site comme avant', async () => {
    const { registry, availabilityService } = makeRegistry('ACTIVE');
    const result = await registry.checkAvailability(
      { restaurantId: RESTAURANT_ID, partySize: 2, ...SLOT },
      ctx,
    );

    expect(result.ok).toBe(true);
    expect(availabilityService.checkAvailability).toHaveBeenCalledTimes(1);
  });
});
