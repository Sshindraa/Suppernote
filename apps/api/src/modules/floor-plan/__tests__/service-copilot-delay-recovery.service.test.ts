import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TableAllocationService } from '../table-allocation.service';
import { ServiceCopilotDelayImpactService } from '../service-copilot-delay-impact.service';
import { CapacityAwareAvailabilityService } from '../availability-capacity-aware.service';
import {
  computeDelayRecoveryPayloadHash,
  DelayRecoveryConflictError,
  ServiceCopilotDelayRecoveryService,
} from '../service-copilot-delay-recovery.service';

function makePrismaMock() {
  const tx = {
    $queryRaw: vi.fn(),
    reservation: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
    waitingListEntry: { findFirst: vi.fn(), update: vi.fn() },
    table: { findFirst: vi.fn() },
    reservationAuditLog: { create: vi.fn(), findFirst: vi.fn() },
    reservationPayment: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  const prisma = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    reservationAuditLog: { findFirst: vi.fn() },
  };
  return { prisma: prisma as any, tx };
}

const preflight = {
  feasible: true,
  summary: 'Plan sûr.',
  delayMinutes: 20,
  delayedReservation: {
    id: 'reservation-1',
    customerName: 'Camille Martin',
    originalTableName: 'T12',
    originalStartsAt: '2026-07-21T17:30:00.000Z',
    proposedStartsAt: '2026-07-21T17:50:00.000Z',
  },
  alternativeTable: { id: 'table-7', name: 'T7', capacity: 2, sectionId: 'salle' },
  waitingListEntry: {
    id: 'waiting-1',
    customerName: 'Lina Dupont',
    partySize: 2,
    requestedStartsAt: '2026-07-21T17:30:00.000Z',
    proposedStartsAt: '2026-07-21T17:30:00.000Z',
    proposedEndsAt: '2026-07-21T19:00:00.000Z',
    isAvailableNow: false,
  },
  safeguards: [],
};

describe('ServiceCopilotDelayRecoveryService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(TableAllocationService.prototype, 'hasGlobalCapacityConflict').mockResolvedValue(
      false,
    );
  });

  it('applique les deux mutations seulement après revalidation sous verrou', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma);
    vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate').mockResolvedValue(preflight);
    vi.spyOn(TableAllocationService.prototype, 'isTableAvailable').mockResolvedValue(true);
    tx.reservation.findFirst.mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'rest-1',
      partySize: 2,
      tableId: 'table-12',
      startsAt: new Date('2026-07-21T17:30:00.000Z'),
      endsAt: new Date('2026-07-21T19:00:00.000Z'),
    });
    tx.waitingListEntry.findFirst.mockResolvedValue({
      id: 'waiting-1',
      restaurantId: 'rest-1',
      partySize: 2,
      customerFirstName: 'Lina',
      customerLastName: 'Dupont',
      customerPhone: '+33600000000',
      customerEmail: null,
      slotStart: new Date('2026-07-21T17:30:00.000Z'),
      slotEnd: new Date('2026-07-21T19:00:00.000Z'),
    });
    tx.table.findFirst
      .mockResolvedValueOnce({ id: 'table-12', capacity: 2, minCapacity: 1 })
      .mockResolvedValueOnce({ id: 'table-7', capacity: 2, minCapacity: 1 });
    tx.reservation.update.mockResolvedValue({ id: 'reservation-1' });
    tx.reservation.create.mockResolvedValue({ id: 'promoted-1' });

    const result = await service.apply({
      restaurantId: 'rest-1',
      reservationId: 'reservation-1',
      delayMinutes: 20,
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      actor: 'manager-1',
      waitingListAcceptanceConfirmed: true,
    });

    expect(result).toEqual({
      delayedReservationId: 'reservation-1',
      promotedReservationId: 'promoted-1',
      operationId: 'delay-recovery:reservation-1:20:table-7:waiting-1',
    });
    // 1 verrou restaurant (advisory) + 2 verrous de ligne + 2 verrous de table.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(5);
    expect(tx.reservation.update).toHaveBeenCalledWith({
      where: { id: 'reservation-1' },
      data: {
        tableId: 'table-7',
        startsAt: new Date('2026-07-21T17:50:00.000Z'),
        endsAt: new Date('2026-07-21T19:20:00.000Z'),
      },
    });
    expect(tx.waitingListEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'waiting-1' },
        data: expect.objectContaining({ status: 'PROMOTED' }),
      }),
    );
    expect(tx.reservationAuditLog.create).toHaveBeenCalledTimes(2);
    expect(tx.reservationAuditLog.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'reservation_delay_recovered',
          metadata: expect.objectContaining({
            changedFields: ['time'],
            idempotencyPayloadHash: expect.any(String),
            idempotencyVersion: 'v1',
            originalTableId: 'table-12',
            originalStartsAt: '2026-07-21T17:30:00.000Z',
            originalEndsAt: '2026-07-21T19:00:00.000Z',
            appliedStartsAt: '2026-07-21T17:50:00.000Z',
            appliedEndsAt: '2026-07-21T19:20:00.000Z',
            promotedStartsAt: '2026-07-21T17:30:00.000Z',
            promotedEndsAt: '2026-07-21T19:00:00.000Z',
          }),
        }),
      }),
    );
  });

  it('refuse la promotion si elle prendrait la capacité d’une réservation sans table', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma);
    vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate').mockResolvedValue(preflight);
    vi.spyOn(TableAllocationService.prototype, 'isTableAvailable').mockResolvedValue(true);
    vi.spyOn(TableAllocationService.prototype, 'hasGlobalCapacityConflict').mockResolvedValue(true);
    tx.reservation.findFirst.mockResolvedValue({
      id: 'reservation-1',
      restaurantId: 'rest-1',
      partySize: 2,
      tableId: 'table-12',
      startsAt: new Date('2026-07-21T17:30:00.000Z'),
      endsAt: new Date('2026-07-21T19:00:00.000Z'),
    });
    tx.waitingListEntry.findFirst.mockResolvedValue({
      id: 'waiting-1',
      restaurantId: 'rest-1',
      partySize: 2,
      customerFirstName: 'Lina',
      customerLastName: 'Dupont',
      customerPhone: '+33600000000',
      customerEmail: null,
    });
    tx.table.findFirst
      .mockResolvedValueOnce({ id: 'table-12', capacity: 2, minCapacity: 1 })
      .mockResolvedValueOnce({ id: 'table-7', capacity: 2, minCapacity: 1 });

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'table-7',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(DelayRecoveryConflictError);
    expect(tx.reservation.create).not.toHaveBeenCalled();
    expect(tx.reservation.update).not.toHaveBeenCalled();
  });

  it('n’écrit rien si le plan à confirmer ne correspond plus au préflight', async () => {
    const { prisma } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma);
    vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate').mockResolvedValue(preflight);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'other-table',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(DelayRecoveryConflictError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('refuse toute promotion sans acceptation explicite du groupe', async () => {
    const { prisma } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);
    const simulate = vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate');

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'table-7',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: false,
      }),
    ).rejects.toThrow('accepte la table');
    expect(simulate).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retourne le premier résultat pour une opération déjà appliquée, même sans clé cliente', async () => {
    const { prisma } = makePrismaMock();
    prisma.reservationAuditLog.findFirst.mockResolvedValue({
      metadata: {
        promotedReservationId: 'promoted-1',
        alternativeTableId: 'table-7',
        delayMinutes: 20,
        waitingListEntryId: 'waiting-1',
      },
    });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'table-7',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
      }),
    ).resolves.toEqual({
      delayedReservationId: 'reservation-1',
      promotedReservationId: 'promoted-1',
      operationId: 'delay-recovery:reservation-1:20:table-7:waiting-1',
      idempotent: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejette la même clé d’action lorsqu’elle porte un plan différent', async () => {
    const { prisma } = makePrismaMock();
    const firstPayload = {
      reservationId: 'reservation-1',
      delayMinutes: 20,
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      waitingListAcceptanceConfirmed: true,
      delayReportId: undefined,
    };
    prisma.reservationAuditLog.findFirst.mockResolvedValue({
      metadata: {
        promotedReservationId: 'promoted-1',
        alternativeTableId: firstPayload.alternativeTableId,
        delayMinutes: firstPayload.delayMinutes,
        waitingListEntryId: firstPayload.waitingListEntryId,
        idempotencyPayloadHash: computeDelayRecoveryPayloadHash(firstPayload),
      },
    });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 40,
        alternativeTableId: 'table-8',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
        idempotencyKey: 'same-action-key',
      }),
    ).rejects.toThrow('déjà été utilisée pour un autre plan');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('retourne le premier résultat lorsque la même clé porte exactement le même plan', async () => {
    const { prisma } = makePrismaMock();
    const payload = {
      reservationId: 'reservation-1',
      delayMinutes: 20,
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      waitingListAcceptanceConfirmed: true,
      delayReportId: undefined,
    };
    prisma.reservationAuditLog.findFirst.mockResolvedValue({
      metadata: {
        promotedReservationId: 'promoted-1',
        alternativeTableId: payload.alternativeTableId,
        delayMinutes: payload.delayMinutes,
        waitingListEntryId: payload.waitingListEntryId,
        idempotencyPayloadHash: computeDelayRecoveryPayloadHash(payload),
      },
    });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        ...payload,
        actor: 'manager-1',
        idempotencyKey: 'same-action-key',
      }),
    ).resolves.toEqual({
      delayedReservationId: 'reservation-1',
      promotedReservationId: 'promoted-1',
      operationId: 'same-action-key',
      idempotent: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejette aussi un rejeu divergent détecté seulement après le verrou transactionnel', async () => {
    const { prisma, tx } = makePrismaMock();
    const firstPayload = {
      reservationId: 'reservation-1',
      delayMinutes: 20,
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      waitingListAcceptanceConfirmed: true,
      delayReportId: undefined,
    };
    prisma.reservationAuditLog.findFirst.mockResolvedValue(null);
    tx.reservationAuditLog.findFirst.mockResolvedValue({
      metadata: {
        promotedReservationId: 'promoted-1',
        alternativeTableId: firstPayload.alternativeTableId,
        delayMinutes: firstPayload.delayMinutes,
        waitingListEntryId: firstPayload.waitingListEntryId,
        idempotencyPayloadHash: computeDelayRecoveryPayloadHash(firstPayload),
      },
    });
    vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate').mockResolvedValue({
      ...preflight,
      alternativeTable: { ...preflight.alternativeTable, id: 'table-8' },
    });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'table-8',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
        idempotencyKey: 'same-action-key',
      }),
    ).rejects.toThrow('déjà été utilisée pour un autre plan');
    expect(tx.$queryRaw).toHaveBeenCalledTimes(3);
    expect(tx.reservation.update).not.toHaveBeenCalled();
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('refuse de modifier le retard lié à un signalement vocal', async () => {
    const { prisma } = makePrismaMock();
    prisma.reservationAuditLog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ metadata: { delayMinutes: 25 } });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.apply({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        delayMinutes: 20,
        alternativeTableId: 'table-7',
        waitingListEntryId: 'waiting-1',
        actor: 'manager-1',
        waitingListAcceptanceConfirmed: true,
        delayReportId: 'delay-report-1',
      }),
    ).rejects.toThrow('ne correspond plus au retard signalé');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('restaure le plan initial seulement si les deux réservations sont inchangées', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma);
    const snapshot = {
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      promotedReservationId: 'promoted-1',
      originalTableId: 'table-12',
      originalStartsAt: '2026-07-21T17:30:00.000Z',
      originalEndsAt: '2026-07-21T19:00:00.000Z',
      appliedStartsAt: '2026-07-21T17:50:00.000Z',
      appliedEndsAt: '2026-07-21T19:20:00.000Z',
      promotedStartsAt: '2026-07-21T17:30:00.000Z',
      promotedEndsAt: '2026-07-21T19:00:00.000Z',
    };
    prisma.reservationAuditLog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ metadata: snapshot });
    tx.reservationAuditLog.findFirst.mockResolvedValue(null);
    tx.reservation.findFirst
      .mockResolvedValueOnce({
        id: 'reservation-1',
        state: 'CONFIRMED',
        tableId: 'table-7',
        startsAt: new Date(snapshot.appliedStartsAt),
        endsAt: new Date(snapshot.appliedEndsAt),
      })
      .mockResolvedValueOnce({
        id: 'promoted-1',
        state: 'CONFIRMED',
        status: 'CONFIRMED',
        source: 'service_copilot_delay_recovery',
        tableId: 'table-12',
        startsAt: new Date(snapshot.promotedStartsAt),
        endsAt: new Date(snapshot.promotedEndsAt),
      });
    tx.waitingListEntry.findFirst.mockResolvedValue({
      id: 'waiting-1',
      status: 'PROMOTED',
      promotedReservationId: 'promoted-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.table.findFirst
      .mockResolvedValueOnce({ id: 'table-12' })
      .mockResolvedValueOnce({ id: 'table-7' });
    tx.reservation.update
      .mockResolvedValueOnce({ id: 'reservation-1' })
      .mockResolvedValueOnce({ id: 'promoted-1', status: 'CANCELLED', state: 'CANCELLED' });
    const invalidate = vi
      .spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability')
      .mockResolvedValue(undefined);
    vi.spyOn(TableAllocationService.prototype, 'isTableAvailable').mockResolvedValue(true);

    await expect(
      service.revert({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        operationId: 'delay-report-1',
        actor: 'manager-1',
      }),
    ).resolves.toEqual({
      delayedReservationId: 'reservation-1',
      promotedReservationId: 'promoted-1',
      waitingListEntryId: 'waiting-1',
      operationId: 'delay-report-1',
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(7);
    expect(tx.reservation.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'reservation-1' },
      data: {
        tableId: 'table-12',
        startsAt: new Date(snapshot.originalStartsAt),
        endsAt: new Date(snapshot.originalEndsAt),
      },
    });
    expect(tx.reservation.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'promoted-1', restaurantId: 'rest-1' },
      data: { state: 'CANCELLED', status: 'CANCELLED' },
    });
    expect(tx.waitingListEntry.update).toHaveBeenCalledWith({
      where: { id: 'waiting-1' },
      data: { status: 'PENDING', promotedReservationId: null, promotedAt: null },
    });
    expect(tx.reservationAuditLog.create).toHaveBeenCalledTimes(3);
    expect(invalidate).toHaveBeenCalledWith('rest-1');
  });

  it('refuse le retour arrière si la réservation promue a déjà été installée', async () => {
    const { prisma, tx } = makePrismaMock();
    const service = new ServiceCopilotDelayRecoveryService(prisma);
    const snapshot = {
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      promotedReservationId: 'promoted-1',
      originalTableId: 'table-12',
      originalStartsAt: '2026-07-21T17:30:00.000Z',
      originalEndsAt: '2026-07-21T19:00:00.000Z',
      appliedStartsAt: '2026-07-21T17:50:00.000Z',
      appliedEndsAt: '2026-07-21T19:20:00.000Z',
      promotedStartsAt: '2026-07-21T17:30:00.000Z',
      promotedEndsAt: '2026-07-21T19:00:00.000Z',
    };
    prisma.reservationAuditLog.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ metadata: snapshot });
    tx.reservationAuditLog.findFirst.mockResolvedValue(null);
    tx.reservation.findFirst
      .mockResolvedValueOnce({
        id: 'reservation-1',
        state: 'CONFIRMED',
        tableId: 'table-7',
        startsAt: new Date(snapshot.appliedStartsAt),
        endsAt: new Date(snapshot.appliedEndsAt),
      })
      .mockResolvedValueOnce({
        id: 'promoted-1',
        state: 'SEATED',
        status: 'SEATED',
        source: 'service_copilot_delay_recovery',
        tableId: 'table-12',
        startsAt: new Date(snapshot.promotedStartsAt),
        endsAt: new Date(snapshot.promotedEndsAt),
      });
    tx.waitingListEntry.findFirst.mockResolvedValue({
      id: 'waiting-1',
      status: 'PROMOTED',
      promotedReservationId: 'promoted-1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    tx.table.findFirst.mockResolvedValue({ id: 'table' });

    await expect(
      service.revert({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        operationId: 'delay-report-1',
        actor: 'manager-1',
      }),
    ).rejects.toThrow('a évolué');
    expect(tx.reservation.update).not.toHaveBeenCalled();
    expect(tx.waitingListEntry.update).not.toHaveBeenCalled();
  });

  it('rend le retour arrière idempotent', async () => {
    const { prisma } = makePrismaMock();
    prisma.reservationAuditLog.findFirst.mockResolvedValue({
      metadata: { promotedReservationId: 'promoted-1', waitingListEntryId: 'waiting-1' },
    });
    const service = new ServiceCopilotDelayRecoveryService(prisma as any);

    await expect(
      service.revert({
        restaurantId: 'rest-1',
        reservationId: 'reservation-1',
        operationId: 'delay-report-1',
        actor: 'manager-1',
      }),
    ).resolves.toEqual({
      delayedReservationId: 'reservation-1',
      promotedReservationId: 'promoted-1',
      waitingListEntryId: 'waiting-1',
      operationId: 'delay-report-1',
      idempotent: true,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
