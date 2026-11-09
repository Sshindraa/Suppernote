/**
 * Route-level tests for floorPlanRoutes.
 *
 * Pattern: Fastify `inject()` against `getApp()` (shared helper with
 * requireOrg mocked to inject `req.restaurantId = 'test-rest-1'`).
 * We spy on `FloorPlanService` methods to drive the route contract
 * (status, tenant scoping, Zod validation) without touching the DB.
 *
 * Covers Phases 2 & 4:
 * - PATCH .../state  → 204 + transitionState called with scoped id
 * - POST  .../walk-ins → 201 + createWalkIn called with scoped id
 * - tenant isolation: `:id` differing from auth context → 403
 * - Zod rejection: missing tableId → 400
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import * as entitlementService from '../../entitlements/entitlement.service';
import { FloorPlanNotFoundError, FloorPlanService } from '../floor-plan.service';
import { ReservationService } from '../../agentic-reservations/core/reservation.service';
import { WaitingListService } from '../../agentic-reservations/core/waiting-list.service';
import { CapacityAwareAvailabilityService } from '../availability-capacity-aware.service';
import { TableAllocationService, TableAllocationError } from '../table-allocation.service';
import { ServiceCopilotDelayImpactService } from '../service-copilot-delay-impact.service';
import {
  DelayRecoveryConflictError,
  ServiceCopilotDelayRecoveryService,
} from '../service-copilot-delay-recovery.service';
import { ServiceCopilotDelayRecoveryHistoryService } from '../service-copilot-delay-recovery-history.service';
import { ServiceCopilotPulseService } from '../service-copilot-pulse.service';
import { ServiceCopilotTelemetryService } from '../service-copilot-telemetry.service';

describe('floorPlanRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(entitlementService, 'evaluateCapability').mockImplementation(
      async (_id, capability) => ({ capability, allowed: true, plan: 'pro' }),
    );
  });

  afterAll(async () => {
    await closeApp();
  });

  describe('Zones et tables combinables', () => {
    it('crée une zone dans le plan demandé', async () => {
      const app = await getApp();
      const zone = {
        id: 'zone-1',
        floorPlanId: 'fp-1',
        sectionId: null,
        name: 'Terrasse',
        x: 32,
        y: 32,
        width: 360,
        height: 220,
        rotation: 0,
      };
      const spy = vi.spyOn(FloorPlanService.prototype, 'createZone').mockResolvedValue(zone as any);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/zones',
        headers: { authorization: 'Bearer test' },
        payload: { ...zone, id: undefined },
      });

      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        'test-rest-1',
        expect.objectContaining({ name: 'Terrasse', width: 360 }),
        'fp-1',
      );
      expect(res.json()).toEqual(zone);
    });

    it('refuse une combinaison hors du tenant', async () => {
      const app = await getApp();
      const spy = vi.spyOn(FloorPlanService.prototype, 'createTableCombination');

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/other-rest/floor-plan/table-combinations',
        headers: { authorization: 'Bearer test' },
        payload: { tableIds: ['table-1', 'table-2'], floorPlanId: 'fp-1' },
      });

      expect(res.statusCode).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });

    it('persiste une combinaison de tables sélectionnées', async () => {
      const app = await getApp();
      const combination = {
        id: 'combination-1',
        floorPlanId: 'fp-1',
        name: null,
        tableIds: ['table-1', 'table-2'],
      };
      const spy = vi
        .spyOn(FloorPlanService.prototype, 'createTableCombination')
        .mockResolvedValue(combination);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/table-combinations',
        headers: { authorization: 'Bearer test' },
        payload: { tableIds: combination.tableIds, floorPlanId: 'fp-1' },
      });

      expect(res.statusCode).toBe(201);
      expect(spy).toHaveBeenCalledWith(
        'test-rest-1',
        { tableIds: combination.tableIds, floorPlanId: 'fp-1' },
        'fp-1',
      );
      expect(res.json()).toEqual(combination);
    });
  });

  describe('PATCH /restaurants/:id/floor-plan/state', () => {
    it('retourne 204 et appelle transitionState avec le bon scope', async () => {
      const app = await getApp();
      vi.spyOn(ReservationService.prototype, 'transitionState').mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/state',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', state: 'SEATED' },
      });

      expect(res.statusCode).toBe(204);
      expect(ReservationService.prototype.transitionState).toHaveBeenCalledWith({
        reservationId: 'res-1',
        restaurantId: 'test-rest-1',
        toState: 'SEATED',
        actor: 'test-rest-1',
      });
    });

    it('retourne 403 si :id diffère du contexte auth (tenant isolation)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(ReservationService.prototype, 'transitionState')
        .mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/other-rest/floor-plan/reservations/res-1/state',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', state: 'SEATED' },
      });

      expect(res.statusCode).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });

    it('retourne 400 si state invalide (Zod)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(ReservationService.prototype, 'transitionState')
        .mockResolvedValue(undefined);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/state',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', state: 'CANCELLED' },
      });

      expect(res.statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });

    it('retourne 409 si la table est indisponible (TableAllocationError)', async () => {
      const app = await getApp();
      vi.spyOn(ReservationService.prototype, 'transitionState').mockRejectedValue(
        new TableAllocationError('TABLE_NOT_AVAILABLE', 'Table non disponible'),
      );

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/state',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', state: 'SEATED' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('POST /restaurants/:id/service-copilot/delay-impact', () => {
    it('retourne une simulation read-only dans le périmètre du restaurant', async () => {
      const app = await getApp();
      const simulate = vi
        .spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate')
        .mockResolvedValue({
          feasible: false,
          delayMinutes: 20,
          summary: 'Aucune table alternative.',
          safeguards: ['Aucune modification n’a été effectuée.'],
        });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/delay-impact',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', delayMinutes: 20 },
      });

      expect(res.statusCode).toBe(200);
      expect(simulate).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        reservationId: 'res-1',
        delayMinutes: 20,
      });
      expect(res.json().summary).toBe('Aucune table alternative.');
    });

    it('refuse une simulation pour un autre restaurant', async () => {
      const app = await getApp();
      const simulate = vi.spyOn(ServiceCopilotDelayImpactService.prototype, 'simulate');

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/other-rest/service-copilot/delay-impact',
        headers: { authorization: 'Bearer test' },
        payload: { reservationId: 'res-1', delayMinutes: 20 },
      });

      expect(res.statusCode).toBe(403);
      expect(simulate).not.toHaveBeenCalled();
    });
  });

  describe('POST /restaurants/:id/service-copilot/delay-impact/apply', () => {
    const payload = {
      reservationId: 'res-1',
      delayMinutes: 20,
      alternativeTableId: 'table-7',
      waitingListEntryId: 'waiting-1',
      waitingListAcceptanceConfirmed: true,
      idempotencyKey: 'delay-op-1',
    };

    it('applique seulement un plan explicitement confirmé', async () => {
      const app = await getApp();
      const apply = vi
        .spyOn(ServiceCopilotDelayRecoveryService.prototype, 'apply')
        .mockResolvedValue({
          delayedReservationId: 'res-1',
          promotedReservationId: 'res-2',
          operationId: 'delay-op-1',
        });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/delay-impact/apply',
        headers: { authorization: 'Bearer test' },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(apply).toHaveBeenCalledWith({
        ...payload,
        restaurantId: 'test-rest-1',
        delayReportId: undefined,
        actor: 'test-rest-1',
      });
    });

    it('retourne 409 si le plan a changé avant confirmation', async () => {
      const app = await getApp();
      vi.spyOn(ServiceCopilotDelayRecoveryService.prototype, 'apply').mockRejectedValue(
        new DelayRecoveryConflictError('Le plan a changé.'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/delay-impact/apply',
        headers: { authorization: 'Bearer test' },
        payload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Le plan a changé.');
    });
  });

  describe('POST /restaurants/:id/service-copilot/delay-impact/revert', () => {
    const payload = { reservationId: 'res-1', operationId: 'delay-op-1' };

    it('annule un plan dans le restaurant authentifié', async () => {
      const app = await getApp();
      const revert = vi
        .spyOn(ServiceCopilotDelayRecoveryService.prototype, 'revert')
        .mockResolvedValue({
          delayedReservationId: 'res-1',
          promotedReservationId: 'res-2',
          waitingListEntryId: 'waiting-1',
          operationId: 'delay-op-1',
        });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/delay-impact/revert',
        headers: { authorization: 'Bearer test' },
        payload,
      });

      expect(res.statusCode).toBe(200);
      expect(revert).toHaveBeenCalledWith({
        ...payload,
        restaurantId: 'test-rest-1',
        actor: 'test-rest-1',
      });
    });

    it('retourne 409 si le service a évolué depuis l’application', async () => {
      const app = await getApp();
      vi.spyOn(ServiceCopilotDelayRecoveryService.prototype, 'revert').mockRejectedValue(
        new DelayRecoveryConflictError('Le plan a évolué.'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/delay-impact/revert',
        headers: { authorization: 'Bearer test' },
        payload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('Le plan a évolué.');
    });

    it('refuse l’annulation pour un autre restaurant', async () => {
      const app = await getApp();
      const revert = vi.spyOn(ServiceCopilotDelayRecoveryService.prototype, 'revert');

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/other-rest/service-copilot/delay-impact/revert',
        headers: { authorization: 'Bearer test' },
        payload,
      });

      expect(res.statusCode).toBe(403);
      expect(revert).not.toHaveBeenCalled();
    });
  });

  describe('GET /restaurants/:id/service-copilot/delay-recoveries', () => {
    it('retourne l’historique persistant de la date demandée', async () => {
      const app = await getApp();
      const list = vi
        .spyOn(ServiceCopilotDelayRecoveryHistoryService.prototype, 'list')
        .mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/delay-recoveries?date=2026-07-22&limit=5',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ recoveries: [] });
      expect(list).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        date: '2026-07-22',
        limit: 5,
      });
    });

    it('refuse une date invalide', async () => {
      const app = await getApp();
      const list = vi.spyOn(ServiceCopilotDelayRecoveryHistoryService.prototype, 'list');

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/delay-recoveries?date=22-07-2026',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(400);
      expect(list).not.toHaveBeenCalled();
    });

    it('isole l’historique par restaurant', async () => {
      const app = await getApp();
      const list = vi.spyOn(ServiceCopilotDelayRecoveryHistoryService.prototype, 'list');

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/other-rest/service-copilot/delay-recoveries?date=2026-07-22',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(403);
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('POST /restaurants/:id/floor-plan/walk-ins', () => {
    it('retourne 201 et appelle createWalkIn avec le bon scope', async () => {
      const app = await getApp();
      vi.spyOn(FloorPlanService.prototype, 'createWalkIn').mockResolvedValue({ id: 'walk-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/walk-ins',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 'table-1', partySize: 3, idempotencyKey: 'k1' },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBe('walk-1');
      expect(FloorPlanService.prototype.createWalkIn).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        tableId: 'table-1',
        partySize: 3,
        idempotencyKey: 'k1',
      });
    });

    it('retourne 403 si :id diffère du contexte auth (tenant isolation)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(FloorPlanService.prototype, 'createWalkIn')
        .mockResolvedValue({ id: 'walk-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/other-rest/floor-plan/walk-ins',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 'table-1', partySize: 3, idempotencyKey: 'k1' },
      });

      expect(res.statusCode).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });

    it('retourne 400 si tableId manquant (Zod)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(FloorPlanService.prototype, 'createWalkIn')
        .mockResolvedValue({ id: 'walk-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/walk-ins',
        headers: { authorization: 'Bearer test' },
        payload: { partySize: 3, idempotencyKey: 'k1' },
      });

      expect(res.statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });

    it('retourne 400 si partySize hors borne (Zod)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(FloorPlanService.prototype, 'createWalkIn')
        .mockResolvedValue({ id: 'walk-1' });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/walk-ins',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 'table-1', partySize: 0, idempotencyKey: 'k1' },
      });

      expect(res.statusCode).toBe(400);
      expect(spy).not.toHaveBeenCalled();
    });

    it('retourne 409 si la table est indisponible (TableAllocationError)', async () => {
      const app = await getApp();
      vi.spyOn(FloorPlanService.prototype, 'createWalkIn').mockRejectedValue(
        new TableAllocationError('TABLE_NOT_AVAILABLE', 'Table non disponible'),
      );

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/walk-ins',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 'table-1', partySize: 3, idempotencyKey: 'k1' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('Phase 5 — suggest-table / assign-table', () => {
    it('suggest-table retourne le top-3 explicable (200+json, pas de mutation)', async () => {
      const app = await getApp();
      vi.mocked(db.reservation.findUnique).mockResolvedValue({
        restaurantId: 'test-rest-1',
        partySize: 2,
        startsAt: new Date(),
        endsAt: new Date(),
        tableId: 't-current',
      } as never);
      const suggestSpy = vi.spyOn(TableAllocationService.prototype, 'suggest').mockResolvedValue([
        {
          table: {
            id: 't-suggested',
            name: 'Table 12',
            capacity: 2,
            minCapacity: 1,
            sectionId: 'sec-1',
          },
          score: 100,
          reasons: ['Capacité exacte pour 2 couverts'],
        },
      ] as never);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/suggest-table',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tableId).toBe('t-suggested');
      expect(body.suggestions).toHaveLength(1);
      expect(body.suggestions[0].reasons[0]).toContain('Capacité exacte');
      expect(suggestSpy).toHaveBeenCalledWith(
        expect.objectContaining({ restaurantId: 'test-rest-1', partySize: 2 }),
        3,
      );
    });

    it('suggest-table retourne tableId null quand aucune table n est disponible', async () => {
      const app = await getApp();
      vi.mocked(db.reservation.findUnique).mockResolvedValue({
        restaurantId: 'test-rest-1',
        partySize: 8,
        startsAt: new Date(),
        endsAt: new Date(),
        tableId: null,
      } as never);
      vi.spyOn(TableAllocationService.prototype, 'suggest').mockResolvedValue([] as never);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/suggest-table',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.tableId).toBeNull();
      expect(body.suggestions).toEqual([]);
    });

    it('suggest-table retourne 404 si la réservation nexiste pas (tenant scope)', async () => {
      const app = await getApp();
      vi.mocked(db.reservation.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-404/suggest-table',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('assign-table retourne 204 et appelle reallocate (commit transactionnel)', async () => {
      const app = await getApp();
      const reallocateSpy = vi
        .spyOn(TableAllocationService.prototype, 'reallocate')
        .mockResolvedValue({ id: 'res-1', tableId: 't-new' } as never);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/assign-table',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 't-new' },
      });

      expect(res.statusCode).toBe(204);
      expect(reallocateSpy).toHaveBeenCalledWith('test-rest-1', 'res-1', 't-new');
    });

    it('assign-table retourne 409 si la table est indisponible (TableAllocationError)', async () => {
      const app = await getApp();
      vi.spyOn(TableAllocationService.prototype, 'reallocate').mockRejectedValue(
        new TableAllocationError('TABLE_NOT_AVAILABLE', 'Target table is not available'),
      );

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/reservations/res-1/assign-table',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 't-taken' },
      });

      expect(res.statusCode).toBe(409);
    });

    it('assign-table retourne 403 si :id diffère du contexte auth (tenant isolation)', async () => {
      const app = await getApp();
      const spy = vi
        .spyOn(TableAllocationService.prototype, 'reallocate')
        .mockResolvedValue({ id: 'res-1', tableId: 't-new' } as never);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/other-rest/floor-plan/reservations/res-1/assign-table',
        headers: { authorization: 'Bearer test' },
        payload: { tableId: 't-new' },
      });

      expect(res.statusCode).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('Multi floor plans — /restaurants/:id/floor-plans', () => {
    it('GET retourne 200 et la liste des floor plans', async () => {
      const app = await getApp();
      const listSpy = vi
        .spyOn(FloorPlanService.prototype, 'listFloorPlans')
        .mockResolvedValue([
          { id: 'fp-1', name: 'Salle', isDefault: true, isActive: true, tableCount: 4 },
        ]);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plans',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(listSpy).toHaveBeenCalledWith('test-rest-1');
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('fp-1');
    });

    it('POST retourne 201 et crée un nouveau floor plan', async () => {
      const app = await getApp();
      const createSpy = vi
        .spyOn(FloorPlanService.prototype, 'createFloorPlan')
        .mockResolvedValue({ id: 'fp-2' } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plans',
        headers: { authorization: 'Bearer test' },
        payload: { name: 'Terrasse' },
      });

      expect(res.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith('test-rest-1', { name: 'Terrasse' });
      const body = res.json();
      expect(body.id).toBe('fp-2');
    });

    it('GET /:floorPlanId retourne 200 et le floor plan', async () => {
      const app = await getApp();
      const getSpy = vi
        .spyOn(FloorPlanService.prototype, 'getFloorPlanById')
        .mockResolvedValue({ id: 'fp-1', restaurantId: 'test-rest-1' } as never);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plans/fp-1',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(getSpy).toHaveBeenCalledWith('test-rest-1', 'fp-1');
    });

    it('PATCH /:floorPlanId retourne 200 et met à jour le floor plan', async () => {
      const app = await getApp();
      const updateSpy = vi
        .spyOn(FloorPlanService.prototype, 'updateFloorPlanById')
        .mockResolvedValue({ id: 'fp-1', restaurantId: 'test-rest-1' } as never);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plans/fp-1',
        headers: { authorization: 'Bearer test' },
        payload: { name: 'Salle principale', isDefault: true },
      });

      expect(res.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith('test-rest-1', 'fp-1', {
        name: 'Salle principale',
        isDefault: true,
      });
    });

    it('DELETE /:floorPlanId retourne 204', async () => {
      const app = await getApp();
      const deleteSpy = vi.spyOn(FloorPlanService.prototype, 'deleteFloorPlan').mockResolvedValue();

      const res = await app.inject({
        method: 'DELETE',
        url: '/restaurants/test-rest-1/floor-plans/fp-1',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(204);
      expect(deleteSpy).toHaveBeenCalledWith('test-rest-1', 'fp-1');
    });

    it('GET /:floorPlanId retourne 404 pour un floor plan d’un autre restaurant', async () => {
      const app = await getApp();
      vi.spyOn(FloorPlanService.prototype, 'getFloorPlanById').mockRejectedValue(
        new FloorPlanNotFoundError('Floor plan introuvable'),
      );

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/floor-plans/fp-other',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(404);
    });

    it('PATCH /:floorPlanId vérifie le tenant avant toute mutation', async () => {
      const app = await getApp();
      const updateSpy = vi
        .spyOn(FloorPlanService.prototype, 'updateFloorPlanById')
        .mockRejectedValue(new FloorPlanNotFoundError('Floor plan introuvable'));

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plans/fp-other',
        headers: { authorization: 'Bearer test' },
        payload: { name: 'Ne doit pas changer' },
      });

      expect(res.statusCode).toBe(404);
      expect(updateSpy).toHaveBeenCalledWith('test-rest-1', 'fp-other', {
        name: 'Ne doit pas changer',
      });
    });

    it('DELETE /:floorPlanId retourne 404 pour un floor plan d’un autre restaurant', async () => {
      const app = await getApp();
      vi.spyOn(FloorPlanService.prototype, 'deleteFloorPlan').mockRejectedValue(
        new FloorPlanNotFoundError('Floor plan introuvable'),
      );

      const res = await app.inject({
        method: 'DELETE',
        url: '/restaurants/test-rest-1/floor-plans/fp-other',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('Waiting list admin routes', () => {
    it('admin list retourne les entrées', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        timezone: 'Europe/Paris',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.spyOn(WaitingListService.prototype, 'list').mockResolvedValue([
        { id: 'wl-1', partySize: 4, status: 'PENDING' },
      ] as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.list>>);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/waiting-list?date=2026-06-29',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe('wl-1');
    });

    it('admin promote crée une réservation', async () => {
      const app = await getApp();
      vi.mocked(db.waitingListEntry.findUnique).mockResolvedValue({
        id: 'wl-1',
        restaurantId: 'test-rest-1',
      } as unknown as Awaited<ReturnType<typeof db.waitingListEntry.findUnique>>);
      const promoteSpy = vi.spyOn(WaitingListService.prototype, 'promoteEntry').mockResolvedValue({
        id: 'res-1',
        restaurantId: 'test-rest-1',
        state: 'CONFIRMED',
      } as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.promoteEntry>>);
      const invalidateSpy = vi.spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability');

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/waiting-list/wl-1/promote',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.id).toBe('res-1');
      expect(promoteSpy).toHaveBeenCalledWith('wl-1');
      expect(invalidateSpy).toHaveBeenCalledWith('test-rest-1');
    });

    it('admin promote retourne 409 quand aucune table compatible', async () => {
      const app = await getApp();
      vi.mocked(db.waitingListEntry.findUnique).mockResolvedValue({
        id: 'wl-1',
        restaurantId: 'test-rest-1',
      } as unknown as Awaited<ReturnType<typeof db.waitingListEntry.findUnique>>);
      vi.spyOn(WaitingListService.prototype, 'promoteEntry').mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/waiting-list/wl-1/promote',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'no_compatible_table' });
    });

    it('admin delete marque lentrée comme annulée', async () => {
      const app = await getApp();
      const cancelSpy = vi.spyOn(WaitingListService.prototype, 'cancelByStaff').mockResolvedValue({
        id: 'wl-1',
        status: 'CANCELLED',
      } as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.cancelByStaff>>);

      const res = await app.inject({
        method: 'DELETE',
        url: '/restaurants/test-rest-1/waiting-list/wl-1',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(204);
      expect(cancelSpy).toHaveBeenCalledWith('wl-1', 'test-rest-1');
    });
  });

  describe('GET /restaurants/:id/service-copilot/telemetry-summary', () => {
    it('retourne les métriques shadow mode du restaurant authentifié', async () => {
      const app = await getApp();
      const getSummary = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'getSummary')
        .mockResolvedValue({
          from: '2026-07-15T18:00:00.000Z',
          to: '2026-07-22T18:00:00.000Z',
          totals: {
            observed: 0,
            opened: 0,
            applied: 4,
            reverted: 0,
            conflicted: 1,
            expired: 0,
            ignored: 2,
          },
          byKind: [],
        });

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/telemetry-summary?days=7',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(getSummary).toHaveBeenCalledWith({ restaurantId: 'test-rest-1', days: 7 });
      expect(res.json().totals.applied).toBe(4);
    });

    it('refuse un autre restaurant et une période invalide', async () => {
      const app = await getApp();
      const getSummary = vi.spyOn(ServiceCopilotTelemetryService.prototype, 'getSummary');

      const invalidDays = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/telemetry-summary?days=91',
        headers: { authorization: 'Bearer test' },
      });
      const wrongTenant = await app.inject({
        method: 'GET',
        url: '/restaurants/other-rest/service-copilot/telemetry-summary?days=7',
        headers: { authorization: 'Bearer test' },
      });

      expect(invalidDays.statusCode).toBe(400);
      expect(wrongTenant.statusCode).toBe(403);
      expect(getSummary).not.toHaveBeenCalled();
    });
  });

  describe('POST /restaurants/:id/service-copilot/telemetry', () => {
    it('enregistre un événement signé dans le bon restaurant', async () => {
      const app = await getApp();
      const recordClientEvent = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'recordClientEvent')
        .mockResolvedValue({ idempotent: false });

      const jwtSample = 'mock-telemetry-token-string-value-valid';
      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/telemetry',
        headers: { authorization: 'Bearer test' },
        payload: {
          token: jwtSample,
          event: 'VIEWED',
          idempotencyKey: 'view-delay-1',
          clientTime: '2026-07-22T18:00:00.000Z',
        },
      });

      expect(res.statusCode).toBe(204);
      expect(recordClientEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          restaurantId: 'test-rest-1',
          event: 'VIEWED',
          idempotencyKey: 'view-delay-1',
        }),
      );
    });

    it('refuse un événement invalide ou un autre restaurant', async () => {
      const app = await getApp();
      const recordClientEvent = vi.spyOn(
        ServiceCopilotTelemetryService.prototype,
        'recordClientEvent',
      );

      const invalid = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/telemetry',
        headers: { authorization: 'Bearer test' },
        payload: { token: 'short', event: 'APPLIED', idempotencyKey: 'bad' },
      });
      const jwtSample = 'mock-telemetry-token-string-value-valid';
      const wrongTenant = await app.inject({
        method: 'POST',
        url: '/restaurants/other-rest/service-copilot/telemetry',
        headers: { authorization: 'Bearer test' },
        payload: {
          token: jwtSample,
          event: 'VIEWED',
          idempotencyKey: 'wrong-tenant',
        },
      });

      expect(invalid.statusCode).toBe(400);
      expect(wrongTenant.statusCode).toBe(403);
      expect(recordClientEvent).not.toHaveBeenCalled();
    });
  });

  describe('revue après service et action serveur du Copilot', () => {
    it('retourne les recommandations à qualifier uniquement dans le restaurant authentifié', async () => {
      const app = await getApp();
      const listReviewItems = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'listReviewItems')
        .mockResolvedValue([
          {
            id: 'occ-1',
            kind: 'table-soon-free',
            status: 'expired',
            createdAt: '2026-07-22T18:00:00.000Z',
            expiresAt: '2026-07-22T18:15:00.000Z',
          },
        ]);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/telemetry-review?days=7',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().occurrences).toHaveLength(1);
      expect(listReviewItems).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        days: 7,
        limit: 25,
      });
    });

    it('enregistre une qualification post-service dans le périmètre du restaurant', async () => {
      const app = await getApp();
      const recordManualOutcome = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'recordManualOutcome')
        .mockResolvedValue({ idempotent: false });

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/telemetry-review/occ-1',
        headers: { authorization: 'Bearer test' },
        payload: { event: 'APPLIED' },
      });

      expect(res.statusCode).toBe(204);
      expect(recordManualOutcome).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        occurrenceId: 'occ-1',
        event: 'APPLIED',
        actor: 'test-user-1',
      });
    });

    it('applique un rééquilibrage seulement si le jeton et l’état attendu concordent', async () => {
      const app = await getApp();
      vi.spyOn(ServiceCopilotTelemetryService.prototype, 'getTokenContext').mockReturnValue({
        occurrenceKey: 'server-rebalance:table-1',
        kind: 'server-rebalance',
        entityId: 'table-1',
        ruleVersion: 'v1',
        expiresAt: '2026-08-01T18:00:00.000Z',
        metrics: { fromServer: 'Alice', toServer: 'Benoît' },
      });
      vi.mocked(db.table.updateMany).mockResolvedValue({ count: 1 } as never);
      const recordServerEvent = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'recordServerEvent')
        .mockResolvedValue({ idempotent: false });

      const sampleJwt = 'mock-telemetry-token-string-value-valid';
      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/actions/server-rebalance',
        headers: { authorization: 'Bearer test' },
        payload: { token: sampleJwt },
      });

      expect(res.statusCode).toBe(204);
      expect(db.table.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'table-1', assignedServer: 'Alice' }),
          data: { assignedServer: 'Benoît' },
        }),
      );
      expect(recordServerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'APPLIED', occurrenceKey: 'server-rebalance:table-1' }),
      );
    });

    it('retourne 409 et trace le conflit quand le serveur de la table a changé', async () => {
      const app = await getApp();
      vi.spyOn(ServiceCopilotTelemetryService.prototype, 'getTokenContext').mockReturnValue({
        occurrenceKey: 'server-rebalance:table-1',
        kind: 'server-rebalance',
        entityId: 'table-1',
        ruleVersion: 'v1',
        expiresAt: '2026-08-01T18:00:00.000Z',
        metrics: { fromServer: 'Alice', toServer: 'Benoît' },
      });
      vi.mocked(db.table.updateMany).mockResolvedValue({ count: 0 } as never);
      const recordServerEvent = vi
        .spyOn(ServiceCopilotTelemetryService.prototype, 'recordServerEvent')
        .mockResolvedValue({ idempotent: false });

      const sampleJwt = 'mock-telemetry-token-string-value-valid';
      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/service-copilot/actions/server-rebalance',
        headers: { authorization: 'Bearer test' },
        payload: { token: sampleJwt },
      });

      expect(res.statusCode).toBe(409);
      expect(recordServerEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'CONFLICTED', reasonCode: 'table_assignment_changed' }),
      );
    });
  });

  describe('GET /restaurants/:id/service-copilot/pulse', () => {
    it('retourne le pouls opérationnel de la date demandée', async () => {
      const app = await getApp();
      const getPulse = vi
        .spyOn(ServiceCopilotPulseService.prototype, 'getPulse')
        .mockResolvedValue({
          date: '2026-07-22',
          generatedAt: '2026-07-22T17:30:00.000Z',
          isLiveDate: true,
          status: 'attention',
          headline: '1 arrivée à installer',
          lateArrivals: 0,
          arrivalsToSeat: 1,
          arrivalsNext30Minutes: 2,
          seatedTables: 4,
          pendingWaitingList: 1,
          confirmedReservations: 9,
        });

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/pulse?date=2026-07-22',
        headers: { authorization: 'Bearer test' },
      });

      expect(res.statusCode).toBe(200);
      expect(getPulse).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        date: '2026-07-22',
      });
      expect(res.json().headline).toBe('1 arrivée à installer');
    });

    it('refuse une date invalide et un autre restaurant', async () => {
      const app = await getApp();
      const getPulse = vi.spyOn(ServiceCopilotPulseService.prototype, 'getPulse');

      const invalidDate = await app.inject({
        method: 'GET',
        url: '/restaurants/test-rest-1/service-copilot/pulse?date=22-07-2026',
        headers: { authorization: 'Bearer test' },
      });
      const wrongTenant = await app.inject({
        method: 'GET',
        url: '/restaurants/other-rest/service-copilot/pulse?date=2026-07-22',
        headers: { authorization: 'Bearer test' },
      });

      expect(invalidDate.statusCode).toBe(400);
      expect(wrongTenant.statusCode).toBe(403);
      expect(getPulse).not.toHaveBeenCalled();
    });
  });

  describe('Affectation serveur — assignedServer', () => {
    it('crée une table avec un serveur affecté', async () => {
      const app = await getApp();
      const id = 'db72dc3f-1bd7-4271-9a23-c6c053c3d673';
      const createSpy = vi.spyOn(FloorPlanService.prototype, 'createTable').mockResolvedValue({
        id: 'table-2',
        name: 'T2',
        capacity: 2,
        minCapacity: 1,
        assignedServer: 'Camille',
        isActive: true,
      } as unknown as Awaited<ReturnType<typeof FloorPlanService.prototype.createTable>>);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/floor-plan/tables',
        headers: { authorization: 'Bearer test' },
        payload: { id, sectionId: 'sec-1', name: 'T2', capacity: 2, assignedServer: 'Camille' },
      });

      expect(res.statusCode).toBe(201);
      expect(createSpy).toHaveBeenCalledWith(
        'test-rest-1',
        expect.objectContaining({ id, assignedServer: 'Camille' }),
        undefined,
      );
      expect(res.json()).toMatchObject({ name: 'T2', assignedServer: 'Camille' });
    });

    it('met à jour le serveur affecté à une table', async () => {
      const app = await getApp();
      const updateSpy = vi.spyOn(FloorPlanService.prototype, 'updateTable').mockResolvedValue({
        id: 'table-1',
        name: 'T1',
        capacity: 4,
        assignedServer: 'Léa',
      } as unknown as Awaited<ReturnType<typeof FloorPlanService.prototype.updateTable>>);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/tables/table-1',
        headers: { authorization: 'Bearer test' },
        payload: { assignedServer: 'Léa' },
      });

      expect(res.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        'test-rest-1',
        'table-1',
        expect.objectContaining({ assignedServer: 'Léa' }),
        undefined,
      );
      expect(res.json().assignedServer).toBe('Léa');
    });

    it('désaffecte le serveur d une table avec assignedServer null', async () => {
      const app = await getApp();
      const updateSpy = vi.spyOn(FloorPlanService.prototype, 'updateTable').mockResolvedValue({
        id: 'table-1',
        name: 'T1',
        capacity: 4,
        assignedServer: null,
      } as unknown as Awaited<ReturnType<typeof FloorPlanService.prototype.updateTable>>);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/floor-plan/tables/table-1',
        headers: { authorization: 'Bearer test' },
        payload: { assignedServer: null },
      });

      expect(res.statusCode).toBe(200);
      expect(updateSpy).toHaveBeenCalledWith(
        'test-rest-1',
        'table-1',
        expect.objectContaining({ assignedServer: null }),
        undefined,
      );
      expect(res.json().assignedServer).toBeNull();
    });
  });
});
