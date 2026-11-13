import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { db } from '../../../shared/db/client';
import { ReservationService } from '../reservation.service';

vi.mock('../../../shared/db/client', () => {
  const mockDb = {
    restaurant: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
    restaurantExposureSettings: {
      findUnique: vi.fn(),
    },
    reservation: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findUniqueOrThrow: vi.fn(),
    },
    floorPlan: {
      findFirst: vi.fn().mockResolvedValue({ id: 'fp-1' }),
    },
    table: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          { id: 'table-1', floorPlanId: 'fp-1', capacity: 4, minCapacity: 1, isActive: true },
        ]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    agenticHold: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    reservationAuditLog: {
      create: vi.fn(),
    },
    reservationPayment: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'locked' }]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (fn: (tx: PrismaClient) => Promise<unknown>) => fn(mockDb)),
  } as unknown as PrismaClient;

  return { db: mockDb };
});

vi.mock('../../../shared/queue/queues', () => ({
  queues: {
    smsClient: {
      add: vi.fn(),
    },
  },
}));

describe('ReservationService', () => {
  const mockRestaurant = {
    id: 'rest-123',
    name: 'Chez Test',
    smsConfirmEnabled: true,
    timezone: 'Europe/Paris',
    openingHours: {
      mon: { open: '12:00', close: '23:00' },
      tue: { open: '12:00', close: '23:00' },
      wed: { open: '12:00', close: '23:00' },
      thu: { open: '12:00', close: '23:00' },
      fri: { open: '12:00', close: '23:00' },
      sat: { open: '12:00', close: '23:00' },
      sun: { open: '12:00', close: '23:00' },
    },
    exposureSettings: {
      capacitySpecials: null,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.reservation.findMany).mockResolvedValue([]);
    vi.mocked(db.agenticHold.findMany).mockResolvedValue([]);
    vi.mocked(db.floorPlan.findFirst).mockResolvedValue({ id: 'fp-1' } as unknown as Awaited<
      ReturnType<typeof db.floorPlan.findFirst>
    >);
    vi.mocked(db.table.findMany).mockResolvedValue([
      { id: 'table-1', floorPlanId: 'fp-1', capacity: 4, minCapacity: 1, isActive: true },
    ] as unknown as Awaited<ReturnType<typeof db.table.findMany>>);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue(
      mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>,
    );
    vi.mocked(db.$queryRaw).mockResolvedValue([{ id: 'locked' }] as unknown as Awaited<
      ReturnType<typeof db.$queryRaw>
    >);
  });

  describe('create', () => {
    it('should create reservation locally', async () => {
      const mockReservation = {
        id: 'res-456',
        restaurantId: 'rest-123',
        reservedAt: new Date('2099-06-05T19:00:00'),
        partySize: 4,
        customerName: 'Alice',
        customerPhone: '+33612345678',
      };

      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );
      vi.mocked(db.reservation.create).mockResolvedValue(
        mockReservation as unknown as Awaited<ReturnType<typeof db.reservation.create>>,
      );

      const input = {
        restaurantId: 'rest-123',
        reservedAt: new Date('2099-06-05T19:00:00'),
        partySize: 4,
        customerName: 'Alice',
        customerPhone: '+33612345678',
      };

      const result = await ReservationService.create(input);

      expect(db.reservation.create).toHaveBeenCalled();
      expect(result.id).toBe('res-456');
    });
  });

  describe('update', () => {
    it('audits only changed reservation fields without recording their values', async () => {
      const originalDate = new Date('2099-06-05T19:00:00.000Z');
      const updatedDate = new Date('2099-06-06T20:00:00.000Z');
      const mockReservationWithRest = {
        id: 'res-456',
        restaurantId: 'rest-123',
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        reservedAt: originalDate,
        startsAt: originalDate,
        partySize: 4,
        restaurant: mockRestaurant,
      };
      const updatedReservation = {
        ...mockReservationWithRest,
        reservedAt: updatedDate,
        startsAt: updatedDate,
        partySize: 5,
      };

      vi.mocked(db.reservation.findUniqueOrThrow).mockResolvedValue(
        mockReservationWithRest as unknown as Awaited<
          ReturnType<typeof db.reservation.findUniqueOrThrow>
        >,
      );
      vi.mocked(db.reservation.update).mockResolvedValue(
        updatedReservation as unknown as Awaited<ReturnType<typeof db.reservation.update>>,
      );

      await ReservationService.update('res-456', 'rest-123', {
        reservedAt: updatedDate,
        startsAt: updatedDate,
        partySize: 5,
      });

      expect(db.reservationAuditLog.create).toHaveBeenCalledWith({
        data: {
          event: 'reservation_fields_changed',
          reservationId: 'res-456',
          actor: 'legacy:reservation-update',
          fromState: 'CONFIRMED',
          toState: 'CONFIRMED',
          metadata: {
            source: 'legacy_reservation_update',
            changedFields: ['party_size', 'date', 'time'],
          },
        },
      });
    });

    it('compares date and time in the restaurant timezone across a daylight-saving change', async () => {
      const originalDate = new Date('2026-10-24T17:00:00.000Z');
      const updatedDate = new Date('2026-10-25T18:00:00.000Z');
      const mockReservationWithRest = {
        id: 'res-456',
        restaurantId: 'rest-123',
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        reservedAt: originalDate,
        startsAt: originalDate,
        partySize: 4,
        restaurant: mockRestaurant,
      };
      vi.mocked(db.reservation.findUniqueOrThrow).mockResolvedValue(
        mockReservationWithRest as unknown as Awaited<
          ReturnType<typeof db.reservation.findUniqueOrThrow>
        >,
      );
      vi.mocked(db.reservation.update).mockResolvedValue({
        ...mockReservationWithRest,
        reservedAt: updatedDate,
        startsAt: updatedDate,
      } as unknown as Awaited<ReturnType<typeof db.reservation.update>>);

      await ReservationService.update('res-456', 'rest-123', {
        reservedAt: updatedDate,
        startsAt: updatedDate,
      });

      expect(db.reservationAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            metadata: {
              source: 'legacy_reservation_update',
              changedFields: ['date'],
            },
          }),
        }),
      );
    });

    it('routes a state-only lifecycle patch through the canonical projection', async () => {
      const mockReservationWithRest = {
        id: 'res-456',
        restaurantId: 'rest-123',
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        restaurant: mockRestaurant,
      };
      const updatedReservation = {
        ...mockReservationWithRest,
        status: 'CANCELLED',
        state: 'CANCELLED',
      };

      vi.mocked(db.reservation.findUniqueOrThrow).mockResolvedValue(
        mockReservationWithRest as unknown as Awaited<
          ReturnType<typeof db.reservation.findUniqueOrThrow>
        >,
      );
      vi.mocked(db.reservation.update).mockResolvedValue(
        updatedReservation as unknown as Awaited<ReturnType<typeof db.reservation.update>>,
      );

      await ReservationService.update('res-456', 'rest-123', { state: 'CANCELLED' });

      expect(db.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-456', restaurantId: 'rest-123' },
        data: { status: 'CANCELLED', state: 'CANCELLED' },
      });
      expect(db.reservationAuditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          event: 'reservation_cancelled',
          fromState: 'CONFIRMED',
          toState: 'CANCELLED',
        }),
      });
    });
  });

  describe('delete', () => {
    it('should close reservation and preserve audit history', async () => {
      const mockReservationWithRest = {
        id: 'res-456',
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        restaurant: mockRestaurant,
      };
      const updatedReservation = {
        ...mockReservationWithRest,
        status: 'CANCELLED',
        state: 'CANCELLED',
      };

      vi.mocked(db.reservation.findUniqueOrThrow).mockResolvedValue(
        mockReservationWithRest as unknown as Awaited<
          ReturnType<typeof db.reservation.findUniqueOrThrow>
        >,
      );
      vi.mocked(db.reservation.update).mockResolvedValueOnce(
        updatedReservation as unknown as Awaited<ReturnType<typeof db.reservation.update>>,
      );

      await ReservationService.delete('res-456', 'rest-123');

      expect(db.reservation.update).toHaveBeenCalledWith({
        where: { id: 'res-456', restaurantId: 'rest-123' },
        data: { status: 'CANCELLED', state: 'CANCELLED' },
      });
      expect(db.reservationAuditLog.create).toHaveBeenCalledWith({
        data: {
          event: 'reservation_deleted',
          reservationId: 'res-456',
          actor: 'legacy:reservation-delete',
          fromState: 'CONFIRMED',
          toState: 'CANCELLED',
          metadata: {
            source: 'legacy_reservation_service',
            mode: 'terminal_state',
          },
        },
      });
      expect(db.reservation.delete).not.toHaveBeenCalled();
    });

    it('is idempotent when reservation is already terminally closed', async () => {
      const cancelledReservation = {
        id: 'res-456',
        status: 'CANCELLED',
        state: 'CANCELLED',
        restaurant: mockRestaurant,
      };

      vi.mocked(db.reservation.findUniqueOrThrow).mockResolvedValue(
        cancelledReservation as unknown as Awaited<
          ReturnType<typeof db.reservation.findUniqueOrThrow>
        >,
      );

      await ReservationService.delete('res-456', 'rest-123');

      expect(db.reservation.update).not.toHaveBeenCalled();
      expect(db.reservationAuditLog.create).not.toHaveBeenCalled();
      expect(db.reservation.delete).not.toHaveBeenCalled();
    });
  });

  describe('availability', () => {
    it('should return capacity-aware slots', async () => {
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );
      // Simule une réservation occupant la table de 12:00 à 14:00 (heure locale Paris)
      vi.mocked(db.reservation.findMany).mockResolvedValue([
        {
          tableId: 'table-1',
          startsAt: new Date('2099-06-05T10:00:00Z'), // 12:00 Paris
          endsAt: new Date('2099-06-05T12:00:00Z'), // 14:00 Paris
        },
      ] as unknown as Awaited<ReturnType<typeof db.reservation.findMany>>);

      const result = await ReservationService.availability('rest-123', '2099-06-05', 2);

      expect(result.slots).toContain('14:00');
      expect(result.slots).not.toContain('12:30');
      expect(result.allSlots.find((slot) => slot.time === '12:30')).toMatchObject({
        available: false,
      });
    });

    it('should reject create outside opening hours', async () => {
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );

      await expect(
        ReservationService.create({
          restaurantId: 'rest-123',
          reservedAt: new Date('2099-06-05T02:00:00'), // 04:00 Paris, fermé
          partySize: 2,
          customerName: 'Alice',
        }),
      ).rejects.toThrow('SLOT_NOT_AVAILABLE');

      expect(db.reservation.create).not.toHaveBeenCalled();
    });
  });
});
