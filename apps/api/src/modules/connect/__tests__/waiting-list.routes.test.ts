/**
 * Tests routes Suppernote Connect — Waiting list.
 *
 * Couvre :
 * - POST /public/r/:slug/waiting-list (join)
 * - DELETE /public/r/:slug/waiting-list/:entryId (cancel by token)
 * - hold 409 renvoie waitingListEnabled
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';
import { TableAllocationService } from '../../floor-plan/table-allocation.service';
import { WaitingListService } from '../../agentic-reservations/core/waiting-list.service';
import {
  WaitingListDisabledError,
  WaitingListSlotFullError,
  WaitingListAlreadyPromotedError,
} from '../../agentic-reservations/core/waiting-list.errors';
import { HoldService, HoldConflictError } from '../../agentic-reservations/core/hold.service';

const SLUG = 'chez-suppernote-demo';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';

const mockRestaurantRaw = {
  id: RESTAURANT_ID,
  slug: SLUG,
  name: 'Chez Suppernote',
  description: 'Bistrot français à Lyon',
  formattedAddress: '12 Rue de la République, 69001 Lyon',
  city: 'Lyon',
  country: 'FR',
  postalCode: '69001',
  phoneNumber: '+334****0000',
  phoneE164: '+334****0000',
  cuisineType: ['Bistrot', 'Française'],
  priceRange: 2,
  openingHours: {
    mon: { open: '12:00', close: '14:30' },
    tue: { open: '19:00', close: '22:30' },
    wed: { open: '19:00', close: '22:30' },
    thu: { open: '19:00', close: '22:30' },
    fri: { open: '19:00', close: '22:30' },
    sat: { open: '19:00', close: '22:30' },
    sun: { open: '19:00', close: '22:30' },
  },
  ambiance: [],
  dietary: [],
  noiseLevel: null,
  agenticOptIn: true,
  publishedAt: new Date('2026-06-24'),
  timezone: 'Europe/Paris',
  exposureSettings: {
    connectPublished: true,
    connectAgentic: false,
  },
  images: [],
  lat: null,
  lng: null,
  googleRating: null,
  googleReviewCount: null,
};

const baseSettings = {
  maxPartySize: 12,
  minLeadTimeMinutes: 30,
  quoteTtlSeconds: 300,
  holdTtlSeconds: 420,
  requireManualValidation: false,
  noShowPolicy: 'warning',
  notificationChannels: ['sms', 'email'],
  capacitySpecials: {
    waitingListEnabled: true,
    waitingListMaxEntriesPerSlot: 5,
    serviceDurationMinutes: 120,
  },
};

function mockRestaurantAndSettings(settings: Record<string, unknown> | null = baseSettings): void {
  vi.mocked(db.restaurant.findUnique).mockResolvedValue(
    mockRestaurantRaw as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>,
  );
  vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
    settings as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findUnique>>,
  );
}

let app: FastifyInstance;

describe('Suppernote Connect — Waiting list routes', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Les créneaux de ces tests sont fixes (29 juin) : l'horloge est figée avant eux, sinon la liste
    // d'attente refuserait des créneaux passés.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z'));
    await redisCache.flushall();
    app = await getApp();
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeApp();
  });

  describe('POST /public/r/:slug/waiting-list', () => {
    const basePayload = {
      date: '2026-06-29',
      time: '20:00',
      partySize: 4,
      customer: {
        firstName: 'Alice',
        lastName: 'Doe',
        phone: '+33612345678',
        email: 'alice@example.com',
      },
    };

    it('join success and response shape', async () => {
      mockRestaurantAndSettings();
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: false }],
      });
      vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
      vi.spyOn(WaitingListService.prototype, 'join').mockResolvedValue({
        entry: {
          id: 'wl-1',
          position: 1,
          expiresAt: new Date('2026-06-29T20:00:00.000Z'),
        },
        actionToken: 'wl-123',
      } as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.join>>);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: basePayload,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.entryId).toBe('wl-1');
      expect(body.position).toBe(1);
      expect(body.actionToken).toBe('wl-123');
      expect(body.expiresAt).toBe('2026-06-29T20:00:00.000Z');
    });

    it('uses the shared group-size default when exposure settings are missing', async () => {
      mockRestaurantAndSettings(null);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: { ...basePayload, partySize: 8 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'Party size 8 exceeds max (7)' });
    });

    it('rejected when waiting list disabled', async () => {
      mockRestaurantAndSettings({
        ...baseSettings,
        capacitySpecials: { waitingListEnabled: false },
      });
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: false }],
      });
      vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
      vi.spyOn(WaitingListService.prototype, 'join').mockRejectedValue(
        new WaitingListDisabledError(),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: basePayload,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'waiting_list_not_enabled' });
    });

    it('rejected when slot available (returns slot_now_available)', async () => {
      mockRestaurantAndSettings();
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: true }],
      });

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: basePayload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'slot_now_available' });
    });

    it('rejected when slot full', async () => {
      mockRestaurantAndSettings();
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: false }],
      });
      vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
      vi.spyOn(WaitingListService.prototype, 'join').mockRejectedValue(
        new WaitingListSlotFullError(RESTAURANT_ID, new Date(), 5),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: basePayload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'waiting_list_full' });
    });
  });

  describe('créneau passé', () => {
    it('refuse un créneau déjà commencé : invalid_slot, sans jamais rejoindre la liste', async () => {
      mockRestaurantAndSettings();
      // 20:30 à Paris : le créneau de 20:00 a commencé. Le moteur le renvoie « indisponible », ce qui
      // ne veut pas dire « complet » : la liste d'attente n'a de sens que pour un créneau à venir.
      vi.setSystemTime(new Date('2026-06-29T18:30:00.000Z'));
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: false }],
      });
      vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
      const join = vi.spyOn(WaitingListService.prototype, 'join');

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 4,
          customer: {
            firstName: 'Alice',
            lastName: 'Doe',
            phone: '+33612345678',
            email: 'alice@example.com',
          },
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_slot' });
      expect(join).not.toHaveBeenCalled();
    });
  });

  describe('délai minimum de réservation', () => {
    const payload = {
      date: '2026-06-29',
      time: '20:00',
      partySize: 4,
      customer: {
        firstName: 'Alice',
        lastName: 'Doe',
        phone: '+33612345678',
        email: 'alice@example.com',
      },
    };
    const slotFull = () => {
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-06-29',
        partySize: 4,
        slots: [{ time: '20:00', available: false }],
      });
      vi.spyOn(TableAllocationService.prototype, 'allocate').mockResolvedValue(null);
      return vi.spyOn(WaitingListService.prototype, 'join');
    };

    it('refuse un créneau dans le délai (2 h) : 409 explicite en français, sans rejoindre la liste', async () => {
      mockRestaurantAndSettings({ ...baseSettings, minLeadTimeMinutes: 120 });
      // 20:00 à Paris = 18:00 UTC ; il est 17:00 UTC : le créneau est dans 1 h, sous les 2 h.
      vi.setSystemTime(new Date('2026-06-29T17:00:00.000Z'));
      const join = slotFull();

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error:
          'Ce créneau est trop proche : ce restaurant accepte les réservations au moins 2 h à l’avance.',
        code: 'INSUFFICIENT_LEAD_TIME',
        minLeadTimeMinutes: 120,
      });
      expect(join).not.toHaveBeenCalled();
    });

    it('laisse rejoindre la liste d’un créneau complet hors délai', async () => {
      mockRestaurantAndSettings({ ...baseSettings, minLeadTimeMinutes: 120 });
      vi.setSystemTime(new Date('2026-06-29T16:00:00.000Z')); // dans 2 h pile
      const join = slotFull().mockResolvedValue({
        entry: {
          id: 'wl-1',
          position: 1,
          expiresAt: new Date('2026-06-29T20:00:00.000Z'),
        },
        actionToken: 'wl-123',
      } as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.join>>);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        payload,
      });

      expect(res.statusCode).toBe(201);
      expect(join).toHaveBeenCalledTimes(1);
    });
  });

  describe('DELETE /public/r/:slug/waiting-list/:entryId', () => {
    it('cancels by token', async () => {
      mockRestaurantAndSettings();
      vi.spyOn(WaitingListService.prototype, 'cancelByToken').mockResolvedValue({
        id: 'wl-1',
        status: 'CANCELLED',
      } as unknown as Awaited<ReturnType<typeof WaitingListService.prototype.cancelByToken>>);

      const res = await app.inject({
        method: 'DELETE',
        url: `/public/r/${SLUG}/waiting-list/wl-1?token=abc123`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'cancelled' });
    });

    it('cancel promoted entry fails', async () => {
      mockRestaurantAndSettings();
      vi.spyOn(WaitingListService.prototype, 'cancelByToken').mockRejectedValue(
        new WaitingListAlreadyPromotedError('wl-1'),
      );

      const res = await app.inject({
        method: 'DELETE',
        url: `/public/r/${SLUG}/waiting-list/wl-1?token=abc123`,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: 'already_promoted' });
    });
  });

  describe('POST /public/r/:slug/hold', () => {
    it('409 response includes waitingListEnabled', async () => {
      mockRestaurantAndSettings({
        ...baseSettings,
        capacitySpecials: { waitingListEnabled: true },
      });
      vi.spyOn(HoldService.prototype, 'createHold').mockRejectedValue(
        new HoldConflictError(RESTAURANT_ID, new Date('2026-06-29T20:00:00.000Z'), 4),
      );

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        payload: { date: '2026-06-29', time: '20:00', partySize: 4 },
      });

      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toBe('no_table_available');
      expect(body.waitingListEnabled).toBe(true);
    });
  });
});
