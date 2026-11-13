import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient, Reservation } from '@prisma/client';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';
import { TableAllocationService } from '../../floor-plan/table-allocation.service';
import {
  ReservationLifecycleService,
  ReservationNotFoundError,
} from '../reservation-lifecycle.service';

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  const startsAt = new Date('2099-06-05T19:00:00.000Z');
  return {
    id: 'reservation-1',
    restaurantId: 'restaurant-1',
    callId: null,
    customerId: null,
    reservedAt: startsAt,
    partySize: 2,
    customerName: 'Test customer',
    customerPhone: null,
    status: 'CONFIRMED',
    confirmationStatus: 'NONE',
    confirmationSentAt: null,
    source: 'PHONE',
    channel: 'PHONE',
    state: 'CONFIRMED',
    startsAt,
    endsAt: new Date('2099-06-05T21:00:00.000Z'),
    specialRequests: null,
    createdByClient: null,
    cancellationPolicySnap: null,
    noShowPolicySnap: null,
    consents: {},
    privacyPolicyVersion: null,
    idempotencyScope: null,
    idempotencyKey: null,
    idempotencyPayloadHash: null,
    consumedHoldId: null,
    tableId: null,
    estimatedRevenue: null,
    giftCardRedemptionSnap: null,
    giftCardComplementAmount: null,
    createdAt: new Date('2099-06-01T00:00:00.000Z'),
    updatedAt: new Date('2099-06-01T00:00:00.000Z'),
    ...overrides,
  } as Reservation;
}

function makePrisma() {
  const tx = {
    restaurant: { findUnique: vi.fn().mockResolvedValue({ smsConfirmEnabled: true }) },
    outboxEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'event-confirmation' }),
    },
    reservation: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    reservationAuditLog: {
      create: vi.fn(),
    },
    reservationPayment: { findFirst: vi.fn().mockResolvedValue(null) },
    agenticHold: {
      findUnique: vi.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

describe('ReservationLifecycleService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queues confirmation atomically when a pending WEB booking is approved', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation({
      state: 'PENDING',
      channel: 'WEB',
      customerPhone: '+33600000000',
    });
    const current = { ...previous, state: 'CONFIRMED' };
    tx.reservation.findUnique.mockResolvedValue(previous);
    tx.reservation.update.mockResolvedValue(current);
    vi.spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability').mockResolvedValue(
      undefined,
    );
    await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'CONFIRMED',
      actor: 'manager',
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          topic: 'reservation-confirmation',
          payload: { reservationId: previous.id },
        }),
      }),
    );
  });

  it('queues private feedback exactly one day after an honoured visit', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation({
      state: 'SEATED',
      startsAt: new Date(Date.now() - 60_000),
      customerId: 'customer-1',
      customerEmail: 'client@example.invalid',
      isTest: false,
    });
    const current = { ...previous, state: 'HONORED' as const };
    tx.reservation.findUnique.mockResolvedValue(previous);
    tx.reservation.update.mockResolvedValue(current);
    vi.spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability').mockResolvedValue(
      undefined,
    );
    const before = Date.now();
    await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'HONORED',
      actor: 'manager',
    });
    const event = tx.outboxEvent.create.mock.calls[0][0].data;
    expect(event).toMatchObject({
      topic: 'reputation-feedback-email',
      payload: { reservationId: previous.id },
    });
    expect(event.availableAt.getTime()).toBeGreaterThanOrEqual(before + 86_400_000);
    expect(event.availableAt.getTime()).toBeLessThanOrEqual(Date.now() + 86_400_000);
  });

  it('scopes the row, projects cancellation, audits it and invalidates capacity', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation();
    const updated = makeReservation({ status: 'CANCELLED', state: 'CANCELLED' });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);
    vi.mocked(tx.reservation.update).mockResolvedValue(updated);
    const invalidate = vi
      .spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability')
      .mockResolvedValue(undefined);

    const result = await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'CANCELLED',
      actor: 'dashboard',
      metadata: { source: 'test' },
      observationSource: 'dashboard',
    });

    expect(tx.reservation.findUnique).toHaveBeenCalledWith({
      where: { id: previous.id, restaurantId: previous.restaurantId },
    });
    expect(tx.reservation.update).toHaveBeenCalledWith({
      where: { id: previous.id, restaurantId: previous.restaurantId },
      data: { state: 'CANCELLED', status: 'CANCELLED' },
    });
    expect(tx.reservationAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        event: 'reservation_cancelled',
        fromState: 'CONFIRMED',
        toState: 'CANCELLED',
      }),
    });
    expect(invalidate).toHaveBeenCalledWith(previous.restaurantId);
    expect(result.capacity).toBe('released');
  });

  it('SEATED prend le verrou restaurant avant le verrou de ligne (pas d’interblocage avec la promotion)', async () => {
    const { prisma, tx } = makePrisma();
    const rowLock = vi.fn().mockResolvedValue([]);
    Object.assign(tx, { $queryRaw: rowLock });
    const previous = makeReservation({
      tableId: 'table-1',
      startsAt: new Date('2099-06-05T19:00:00.000Z'),
      endsAt: new Date('2099-06-05T20:30:00.000Z'),
    });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);
    vi.mocked(tx.reservation.update).mockResolvedValue(
      makeReservation({ ...previous, state: 'SEATED', status: 'SEATED' }),
    );
    const lock = vi
      .spyOn(TableAllocationService.prototype, 'lockRestaurantCapacity')
      .mockResolvedValue(undefined);
    vi.spyOn(TableAllocationService.prototype, 'assertTableAvailableForSeating').mockResolvedValue(
      undefined,
    );
    vi.spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability').mockResolvedValue(
      undefined,
    );

    await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'SEATED',
      actor: 'dashboard',
      metadata: { source: 'test' },
      observationSource: 'dashboard',
    });

    expect(lock).toHaveBeenCalledWith(tx, previous.restaurantId);
    expect(rowLock).toHaveBeenCalled();
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(rowLock.mock.invocationCallOrder[0]);
  });

  it('rejects a terminal-to-confirmed transition before writing', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation({ status: 'CANCELLED', state: 'CANCELLED' });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);

    await expect(
      new ReservationLifecycleService(prisma).transition({
        reservationId: previous.id,
        restaurantId: previous.restaurantId,
        toState: 'CONFIRMED',
        actor: 'dashboard',
      }),
    ).rejects.toThrow('Invalid state transition: CANCELLED → CONFIRMED');
    expect(tx.reservation.update).not.toHaveBeenCalled();
    expect(tx.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it('ignore une confirmation fournisseur si la réservation a déjà changé d’état', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation({ status: 'CANCELLED', state: 'CANCELLED' });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);

    const result = await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'CONFIRMED',
      onlyIfFromState: 'PENDING',
      actor: 'payment:provider-webhook',
      operation: 'confirmation',
    });

    expect(result.mutated).toBe(false);
    expect(result.capacity).toBe('unchanged');
    expect(tx.reservation.update).not.toHaveBeenCalled();
    expect(tx.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it('allows an idempotent same-state operational patch without a fake audit event', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation();
    const updated = makeReservation({ customerName: 'Updated customer' });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);
    vi.mocked(tx.reservation.update).mockResolvedValue(updated);

    const result = await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'CONFIRMED',
      actor: 'dashboard',
      allowAlreadyInTarget: true,
      additionalData: { customerName: 'Updated customer' },
      observationSource: 'dashboard',
    });

    expect(result.mutated).toBe(true);
    expect(result.capacity).toBe('unchanged');
    expect(tx.reservationAuditLog.create).not.toHaveBeenCalled();
    expect(tx.reservation.update).toHaveBeenCalledWith({
      where: { id: previous.id, restaurantId: previous.restaurantId },
      data: { customerName: 'Updated customer', state: 'CONFIRMED', status: 'CONFIRMED' },
    });
  });

  it('keeps the consumed-hold release proof in the same transaction as cancellation', async () => {
    const { prisma, tx } = makePrisma();
    const previous = makeReservation({ consumedHoldId: 'hold-1' });
    const updated = makeReservation({
      consumedHoldId: 'hold-1',
      status: 'CANCELLED',
      state: 'CANCELLED',
    });
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(previous);
    vi.mocked(tx.reservation.update).mockResolvedValue(updated);
    vi.mocked(tx.agenticHold.findUnique).mockResolvedValue({
      status: 'CONSUMED',
      id: 'hold-1',
    } as never);

    await new ReservationLifecycleService(prisma).transition({
      reservationId: previous.id,
      restaurantId: previous.restaurantId,
      toState: 'CANCELLED',
      actor: 'agent:test',
      auditConsumedHoldRelease: true,
    });

    expect(tx.reservationAuditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.reservationAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'hold_released', holdId: 'hold-1' }),
    });
    expect(tx.reservationAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ event: 'reservation_cancelled' }),
    });
  });

  it('raises a stable not-found error for a missing tenant-scoped row', async () => {
    const { prisma, tx } = makePrisma();
    vi.mocked(tx.reservation.findUnique).mockResolvedValue(null);

    await expect(
      new ReservationLifecycleService(prisma).transition({
        reservationId: 'missing',
        restaurantId: 'restaurant-1',
        toState: 'CANCELLED',
        actor: 'dashboard',
      }),
    ).rejects.toBeInstanceOf(ReservationNotFoundError);
  });
});
