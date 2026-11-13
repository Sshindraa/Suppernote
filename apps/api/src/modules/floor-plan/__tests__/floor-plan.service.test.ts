/**
 * Service-level tests for FloorPlanService.
 *
 * Mocks `@prisma/client` (preserving the `Prisma` namespace so
 * `Prisma.PrismaClientKnownRequestError` P2002 is real) and drives
 * the service methods directly — no Fastify, no HTTP.
 *
 * Covers:
 * - Phase 3: getPlanning derives `seatedAt` from the audit log
 *   (reservation_seated event), not from a column.
 * - Phase 4: createWalkIn is atomic under concurrency — a P2002 on
 *   the partial unique index (idempotency_scope+key) returns the
 *   existing reservation id instead of throwing / double-inserting.
 * - P3: multi-floor-plan list and create.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { FloorPlanNotFoundError, FloorPlanService } from '../floor-plan.service';
import { TableAllocationService, TableAllocationError } from '../table-allocation.service.js';
import { CapacityAwareAvailabilityService } from '../availability-capacity-aware.service.js';

function makePrismaMock() {
  const table = { findFirst: vi.fn(), create: vi.fn(), upsert: vi.fn() };
  const wall = { create: vi.fn(), upsert: vi.fn() };
  const floorPlanZone = { create: vi.fn(), upsert: vi.fn() };
  const reservation = {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  const reservationAuditLog = { findMany: vi.fn(), create: vi.fn() };
  const posCheck = { findMany: vi.fn().mockResolvedValue([]) };
  const restaurant = { findUnique: vi.fn() };
  const floorPlan = {
    findFirst: vi.fn().mockResolvedValue({ id: 'fp-1', tables: [], sections: [], walls: [] }),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  };

  const prisma: any = {
    table,
    wall,
    floorPlanZone,
    reservation,
    reservationAuditLog,
    posCheck,
    restaurant,
    floorPlan,
    $transaction: vi.fn(async (fn: any) =>
      fn({ table, reservation, reservationAuditLog, restaurant, floorPlan }),
    ),
  };
  return {
    prisma,
    table,
    wall,
    floorPlanZone,
    reservation,
    reservationAuditLog,
    restaurant,
    floorPlan,
  };
}

const P2002 = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '0.0.1',
  });

describe('FloorPlanService', () => {
  let svc: FloorPlanService;
  let mocks: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    mocks = makePrismaMock();
    svc = new FloorPlanService(mocks.prisma);
    vi.spyOn(TableAllocationService.prototype, 'assertTableAvailableForSeating').mockResolvedValue(
      undefined,
    );
  });

  describe('isolation multi-tenant des floor plans', () => {
    it('refuse la mise à jour avant toute écriture pour un autre restaurant', async () => {
      mocks.floorPlan.findFirst.mockResolvedValue(null);

      await expect(
        svc.updateFloorPlanById('restaurant-a', 'floor-plan-b', { name: 'Intrusif' }),
      ).rejects.toBeInstanceOf(FloorPlanNotFoundError);

      expect(mocks.floorPlan.updateMany).not.toHaveBeenCalled();
      expect(mocks.floorPlan.update).not.toHaveBeenCalled();
    });
  });

  describe('créations rejouables', () => {
    it('réutilise la même table quand une création est rejouée', async () => {
      const id = 'db72dc3f-1bd7-4271-9a23-c6c053c3d673';
      const created = { id, floorPlanId: 'fp-1', name: 'T1', capacity: 4 };
      mocks.table.upsert.mockResolvedValue(created);

      const result = await svc.createTable('rest-1', { id, name: 'T1', capacity: 4 });

      expect(result).toBe(created);
      expect(mocks.table.upsert).toHaveBeenCalledWith({
        where: { id },
        create: expect.objectContaining({ id, floorPlanId: 'fp-1', name: 'T1' }),
        update: {},
      });
    });

    it('réutilise le même mur quand une création est rejouée', async () => {
      const id = 'db72dc3f-1bd7-4271-9a23-c6c053c3d673';
      const created = { id, floorPlanId: 'fp-1', x1: 0, y1: 0, x2: 10, y2: 0 };
      mocks.wall.upsert.mockResolvedValue(created);

      const result = await svc.createWall('rest-1', { id, x1: 0, y1: 0, x2: 10, y2: 0 });

      expect(result).toBe(created);
      expect(mocks.wall.upsert).toHaveBeenCalledWith({
        where: { id },
        create: expect.objectContaining({ id, floorPlanId: 'fp-1' }),
        update: {},
      });
    });

    it('réutilise la même zone quand une création est rejouée', async () => {
      const id = 'db72dc3f-1bd7-4271-9a23-c6c053c3d673';
      const created = {
        id,
        floorPlanId: 'fp-1',
        name: 'Terrasse',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      };
      mocks.floorPlanZone.upsert.mockResolvedValue(created);

      const result = await svc.createZone('rest-1', {
        id,
        name: 'Terrasse',
        x: 0,
        y: 0,
        width: 100,
        height: 80,
      });

      expect(result).toBe(created);
      expect(mocks.floorPlanZone.upsert).toHaveBeenCalledWith({
        where: { id },
        create: expect.objectContaining({ id, floorPlanId: 'fp-1' }),
        update: {},
      });
    });

    it('refuse un identifiant déjà associé à un autre plan', async () => {
      const id = 'db72dc3f-1bd7-4271-9a23-c6c053c3d673';
      mocks.table.upsert.mockResolvedValue({ id, floorPlanId: 'fp-other' });

      await expect(svc.createTable('rest-1', { id, name: 'T1', capacity: 4 })).rejects.toThrow(
        FloorPlanNotFoundError,
      );
      expect(mocks.table.upsert).toHaveBeenCalledWith({
        where: { id },
        create: expect.objectContaining({ id, floorPlanId: 'fp-1' }),
        update: {},
      });
    });
  });

  describe('getPlanning — Phase 3 (seatedAt dérivé de l audit log)', () => {
    it('mappe seatedAt depuis levent reservation_seated', async () => {
      const seatedAt = new Date('2026-07-17T22:55:48.567Z');
      mocks.reservation.findMany.mockResolvedValue([
        {
          id: 'res-1',
          state: 'SEATED',
          tableId: 't1',
          partySize: 2,
          startsAt: new Date('2026-07-17T22:30:00Z'),
          endsAt: new Date('2026-07-17T23:30:00Z'),
          customerName: 'Jean',
        },
      ]);
      mocks.reservationAuditLog.findMany.mockResolvedValue([
        { reservationId: 'res-1', event: 'reservation_seated', createdAt: seatedAt },
      ]);

      const out = await svc.getPlanning('rest-1', '2026-07-18');

      expect(out).toHaveLength(1);
      expect(out[0].seatedAt?.toISOString()).toBe(seatedAt.toISOString());
    });

    it('renvoie paidAt quand une addition est clôturée sur la table après linstallation', async () => {
      const seatedAt = new Date('2026-07-17T22:55:00Z');
      const paidAt = new Date('2026-07-17T23:40:00Z');
      mocks.floorPlan.findFirst.mockResolvedValueOnce({
        id: 'fp-1',
        tables: [{ id: 't4', name: 'T4', sectionId: null }],
        sections: [],
        walls: [],
      });
      mocks.reservation.findMany.mockResolvedValue([
        {
          id: 'res-1',
          state: 'SEATED',
          tableId: 't4',
          partySize: 2,
          startsAt: new Date('2026-07-17T22:30:00Z'),
          endsAt: new Date('2026-07-18T00:30:00Z'),
          customerName: 'Jean',
        },
      ]);
      mocks.reservationAuditLog.findMany.mockResolvedValue([
        { reservationId: 'res-1', event: 'reservation_seated', createdAt: seatedAt },
      ]);
      mocks.prisma.posCheck.findMany.mockResolvedValueOnce([
        // Addition des clients précédents, clôturée avant l'installation : ignorée.
        { closedAt: new Date('2026-07-17T22:00:00Z'), tableReference: '4' },
        { closedAt: paidAt, tableReference: 'Table 12' },
        { closedAt: paidAt, tableReference: '4' },
      ]);

      const out = await svc.getPlanning('rest-1', '2026-07-18');

      expect(out[0].paidAt?.toISOString()).toBe(paidAt.toISOString());
    });

    it('laisse seatedAt null sil y a aucun event seated', async () => {
      mocks.reservation.findMany.mockResolvedValue([
        {
          id: 'res-2',
          state: 'CONFIRMED',
          tableId: 't2',
          partySize: 4,
          startsAt: new Date('2026-07-18T19:00:00Z'),
          endsAt: new Date('2026-07-18T21:00:00Z'),
          customerName: 'Marie',
        },
      ]);
      mocks.reservationAuditLog.findMany.mockResolvedValue([]);

      const out = await svc.getPlanning('rest-1', '2026-07-18');

      expect(out[0].seatedAt).toBeNull();
    });
  });

  describe('createWalkIn — Phase 4 (atomicité idempotency)', () => {
    it('crée une résa SEATED + audit reservation_seated', async () => {
      mocks.table.findFirst.mockResolvedValue({ id: 't1' });
      const created = { id: 'walk-new' };
      mocks.reservation.create.mockResolvedValue(created);
      mocks.reservationAuditLog.create.mockResolvedValue({ id: 'log-1' });

      const out = await svc.createWalkIn({
        restaurantId: 'rest-1',
        tableId: 't1',
        partySize: 3,
        customerName: 'Walk-in',
        idempotencyKey: 'k-abc',
      });

      expect(out.id).toBe('walk-new');
      expect(mocks.reservation.create).toHaveBeenCalledTimes(1);
      const createArg = mocks.reservation.create.mock.calls[0][0];
      expect(createArg.data.state).toBe('SEATED');
      expect(createArg.data.source).toBe('WALK_IN');
      expect(createArg.data.idempotencyKey).toBe('k-abc');
      expect(mocks.reservationAuditLog.create).toHaveBeenCalledTimes(1);
      const logArg = mocks.reservationAuditLog.create.mock.calls[0][0];
      expect(logArg.data.event).toBe('reservation_seated');
      expect(logArg.data.fromState).toBeNull();
      expect(logArg.data.toState).toBe('SEATED');
      expect(TableAllocationService.prototype.assertTableAvailableForSeating).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: 'rest-1',
          tableId: 't1',
          partySize: 3,
          startsAt: expect.any(Date),
          endsAt: expect.any(Date),
        }),
        expect.any(Object),
      );
    });

    describe('durée de repas et disponibilité', () => {
      const MINUTE = 60_000;
      const place = () =>
        svc.createWalkIn({
          restaurantId: 'rest-1',
          tableId: 't1',
          partySize: 2,
          idempotencyKey: 'k-duree',
        });
      const serviceMinutes = () => {
        const { startsAt, endsAt } = mocks.reservation.create.mock.calls[0][0].data;
        return (endsAt.getTime() - startsAt.getTime()) / MINUTE;
      };
      let invalidate: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        mocks.reservation.create.mockResolvedValue({ id: 'walk-new' });
        invalidate = vi
          .spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability')
          .mockResolvedValue(undefined);
        // Les espions sur le prototype et la méthode statique survivent d'un test à l'autre.
        invalidate.mockClear();
        vi.mocked(TableAllocationService.prototype.assertTableAvailableForSeating).mockClear();
      });

      it('bloque la table pendant la durée de repas réglée par le restaurant', async () => {
        mocks.restaurant.findUnique.mockResolvedValue({
          exposureSettings: { capacitySpecials: { serviceDurationMinutes: 150 } },
        });

        await place();

        expect(serviceMinutes()).toBe(150);
        const checked = vi.mocked(TableAllocationService.prototype.assertTableAvailableForSeating)
          .mock.calls[0][0];
        expect((checked.endsAt.getTime() - checked.startsAt.getTime()) / MINUTE).toBe(150);
      });

      it('retombe sur 2 h quand le restaurant n’a pas réglé de durée', async () => {
        mocks.restaurant.findUnique.mockResolvedValue({
          exposureSettings: { capacitySpecials: { default: { seats: 40, tables: 10 } } },
        });
        await place();
        expect(serviceMinutes()).toBe(120);
      });

      it('retombe sur 2 h quand le restaurant n’a pas de réglages', async () => {
        mocks.restaurant.findUnique.mockResolvedValue({ exposureSettings: null });
        await place();
        expect(serviceMinutes()).toBe(120);
      });

      it('le personnel n’est pas soumis au délai minimum en ligne : placer un client maintenant fonctionne', async () => {
        mocks.restaurant.findUnique.mockResolvedValue({
          exposureSettings: { capacitySpecials: {}, minLeadTimeMinutes: 120 },
        });

        const placed = await place();

        expect(placed.id).toBe('walk-new');
        const { startsAt } = mocks.reservation.create.mock.calls[0][0].data;
        // Le client est assis à l'instant même (début = maintenant), pas dans 2 h.
        expect(Math.abs(startsAt.getTime() - Date.now())).toBeLessThan(5_000);
      });

      it('nomme « Sans réservation » un client placé sans nom', async () => {
        await place();
        expect(mocks.reservation.create.mock.calls[0][0].data.customerName).toBe(
          'Sans réservation',
        );
      });

      it('invalide le cache de disponibilité : la table n’est plus proposée tout de suite', async () => {
        await place();
        expect(invalidate).toHaveBeenCalledTimes(1);
        expect(invalidate).toHaveBeenCalledWith('rest-1');
      });

      it('n’invalide rien quand la requête est un rejeu idempotent', async () => {
        mocks.reservation.create.mockRejectedValueOnce(P2002());
        mocks.reservation.findFirst.mockResolvedValue({ id: 'existing-walk' });
        await place();
        expect(invalidate).not.toHaveBeenCalled();
      });
    });

    it('lève TableAllocationError si la table est introuvable ou indisponible', async () => {
      vi.mocked(
        TableAllocationService.prototype.assertTableAvailableForSeating,
      ).mockRejectedValueOnce(new TableAllocationError('TABLE_NOT_FOUND', 'Table introuvable'));

      await expect(
        svc.createWalkIn({
          restaurantId: 'rest-1',
          tableId: 't-hack',
          partySize: 2,
          idempotencyKey: 'k-x',
        }),
      ).rejects.toThrow(TableAllocationError);
      expect(mocks.reservation.create).not.toHaveBeenCalled();
    });

    it('survit un P2002 concurrent (idempotency) en retournant la résa existante', async () => {
      mocks.table.findFirst.mockResolvedValue({ id: 't1' });
      // 1er create lève P2002 (un autre thread a déjà inséré) ; refetch retourne existing
      mocks.reservation.create.mockRejectedValueOnce(P2002());
      mocks.reservation.findFirst.mockResolvedValue({ id: 'existing-walk' });

      const out = await svc.createWalkIn({
        restaurantId: 'rest-1',
        tableId: 't1',
        partySize: 2,
        idempotencyKey: 'k-race',
      });

      expect(out.id).toBe('existing-walk');
      // Pas de 2e create (le refetch a résolu le conflit)
      expect(mocks.reservation.create).toHaveBeenCalledTimes(1);
    });

    it('chevauchement sur la table (23P01) → TABLE_NOT_AVAILABLE, pas une erreur générique', async () => {
      mocks.table.findFirst.mockResolvedValue({ id: 't1' });
      mocks.reservation.create.mockRejectedValueOnce(
        new Error('conflicting key violates exclusion constraint "reservations_no_overlap_active"'),
      );

      await expect(
        svc.createWalkIn({
          restaurantId: 'rest-1',
          tableId: 't1',
          partySize: 2,
          idempotencyKey: 'k-overlap',
        }),
      ).rejects.toMatchObject({ name: 'TableAllocationError', code: 'TABLE_NOT_AVAILABLE' });
    });

    it('relance une erreur non-P2002', async () => {
      mocks.table.findFirst.mockResolvedValue({ id: 't1' });
      mocks.reservation.create.mockRejectedValueOnce(new Error('DB down'));

      await expect(
        svc.createWalkIn({
          restaurantId: 'rest-1',
          tableId: 't1',
          partySize: 2,
          idempotencyKey: 'k-err',
        }),
      ).rejects.toThrow('DB down');
    });
  });

  describe('Multi floor plan', () => {
    it('listFloorPlans retourne la liste des plans avec le compte de tables', async () => {
      mocks.floorPlan.findMany.mockResolvedValue([
        {
          id: 'fp-1',
          name: 'Salle principale',
          isDefault: true,
          isActive: true,
          _count: { tables: 4 },
        },
        {
          id: 'fp-2',
          name: 'Terrasse',
          isDefault: false,
          isActive: true,
          _count: { tables: 2 },
        },
      ]);

      const out = await svc.listFloorPlans('rest-1');

      expect(out).toHaveLength(2);
      expect(out[0]).toEqual({
        id: 'fp-1',
        name: 'Salle principale',
        isDefault: true,
        isActive: true,
        tableCount: 4,
      });
      expect(out[1]).toEqual({
        id: 'fp-2',
        name: 'Terrasse',
        isDefault: false,
        isActive: true,
        tableCount: 2,
      });
    });

    it('createFloorPlan crée un deuxième plan et désactive les autres defaults si demandé', async () => {
      mocks.floorPlan.updateMany.mockResolvedValue({ count: 1 });
      mocks.floorPlan.create.mockResolvedValue({
        id: 'fp-2',
        name: 'Terrasse',
        isDefault: true,
        isActive: true,
        restaurantId: 'rest-1',
      });

      const out = await svc.createFloorPlan('rest-1', { name: 'Terrasse', isDefault: true });

      expect(mocks.floorPlan.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { restaurantId: 'rest-1', isDefault: true },
          data: { isDefault: false },
        }),
      );
      const createArg = mocks.floorPlan.create.mock.calls[0][0];
      expect(createArg.data.name).toBe('Terrasse');
      expect(createArg.data.isDefault).toBe(true);
      expect(out.id).toBe('fp-2');
    });

    it('createFloorPlan sans isDefault crée un plan non-default', async () => {
      mocks.floorPlan.updateMany.mockResolvedValue({ count: 0 });
      mocks.floorPlan.create.mockResolvedValue({
        id: 'fp-3',
        name: 'Jardin',
        isDefault: false,
        isActive: true,
        restaurantId: 'rest-1',
      });

      const out = await svc.createFloorPlan('rest-1', { name: 'Jardin' });

      expect(mocks.floorPlan.updateMany).not.toHaveBeenCalled();
      const createArg = mocks.floorPlan.create.mock.calls[0][0];
      expect(createArg.data.isDefault).toBe(false);
      expect(out.id).toBe('fp-3');
    });
  });
});
