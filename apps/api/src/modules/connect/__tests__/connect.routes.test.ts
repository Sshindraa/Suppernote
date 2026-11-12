/**
 * Tests routes Suppernote Connect — T2.
 *
 * Couvre (acceptance criteria spec v1.1 §10 T2) :
 * - GET /public/r/:slug → 200 si publié
 * - GET /public/r/inexistant → 404
 * - GET /public/r/:slug/availability → slots valides
 * - POST /hold puis POST /confirm avec Idempotency-Key
 * - POST /confirm replay même payload = même réponse
 * - POST /confirm replay payload différent = 409 Conflict
 * - source=chatgpt forcée à 'web' si connectAgentic=false
 * - Pas d'auth requise (pas de 401 sans Authorization)
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type Mock } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PublicRestaurantDto } from '../connect.types';
import { randomBytes, randomUUID } from 'node:crypto';
import { MARKETING_CONSENT_VERSION } from '@suppernote/shared';

/**
 * Copie volontaire de l'invariant de publication (cf. `PUBLIC_CONNECT_WHERE`).
 * Le test doit énoncer le contrat indépendamment de l'implémentation : s'appuyer
 * sur la constante rendrait le contrôle insensible à la suppression d'une
 * condition, ce qui est précisément la dérive à détecter.
 */
const EXPECTED_PUBLIC_PREDICATE = {
  exposureSettings: { connectPublished: true },
  publishedAt: { not: null },
  slug: {
    not: null,
    notIn: expect.arrayContaining([
      'chez-suppernote-demo',
      'chez-sokar-demo',
      'chez-sokar-bistrot-paris',
    ]),
  },
  agenticOptIn: true,
};

vi.mock('../../marketing/marketing-consent.service', () => ({
  recordBookingMarketingConsent: vi
    .fn()
    .mockResolvedValue({ EMAIL: 'RECORDED', SMS: 'NOT_REQUESTED' }),
}));
vi.mock('../../floor-plan/availability-capacity-aware.service', () => {
  const CapacityAwareAvailabilityService = vi.fn().mockImplementation(function (this: {
    getAvailability: ReturnType<typeof vi.fn>;
  }) {
    this.getAvailability = vi
      .fn()
      .mockImplementation((args: { partySize: number; date: string }) => ({
        restaurantId: 'rest-123',
        date: args.date,
        partySize: args.partySize,
        slots: [{ time: '20:00', available: true }],
      }));
  });
  (
    CapacityAwareAvailabilityService as unknown as { invalidateAvailability: Mock<() => unknown> }
  ).invalidateAvailability = vi.fn().mockResolvedValue(undefined);

  return {
    CapacityAwareAvailabilityService,
    DEFAULT_RESTAURANT_TIMEZONE: 'Europe/Paris',
    zonedTimeToUtc: vi.fn().mockImplementation((_date: string, time: string) => {
      const [h, m] = time.split(':').map(Number);
      return new Date(Date.UTC(2026, 5, 29, h, m));
    }),
    // Le stub ne modélise pas de fuseau : on re-rend l'instant tel quel, ce qui
    // laisse les attentes du test sur l'heure inchangées.
    utcToZonedParts: vi.fn().mockImplementation((instant: Date) => ({
      date: instant.toISOString().slice(0, 10),
      time: instant.toISOString().slice(11, 16),
    })),
  };
});

vi.mock('../../floor-plan/table-allocation.service', () => ({
  TableAllocationService: vi.fn().mockImplementation(function (this: {
    allocate: ReturnType<typeof vi.fn>;
  }) {
    this.allocate = vi.fn().mockResolvedValue({ id: 'table-1' });
  }),
}));

import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { recordBookingMarketingConsent } from '../../marketing/marketing-consent.service';
import { redisCache } from '../../../shared/redis/client';
import { ReservationService } from '../../agentic-reservations/core/reservation.service';
import { PolicyValidationError } from '../../agentic-reservations/core/policies.service';
import {
  computeIdempotencyScope,
  hashPayload,
} from '../../agentic-reservations/core/idempotency.service';
import { ConfirmInputSchema } from '../connect.types';
import { hashPhone } from '../connect.service';
import { ConsentService } from '../../rgpd/consent.service';
import * as connectRateLimit from '../connect-rate-limit';
import { consumeTestBookingQuota, issueTestBookingToken } from '../test-booking';

const SLUG = 'chez-suppernote-demo';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';
const CONFIRM_HOLD_TOKEN = ['tok', 'confirm'].join('-');
const TEST_HOLD_TOKEN = ['tok', 'test'].join('-');

const mockPublishedRestaurant: PublicRestaurantDto = {
  id: RESTAURANT_ID,
  slug: SLUG,
  name: 'Chez Sokar',
  description: 'Bistrot français à Lyon',
  address: {
    line1: '12 Rue de la République, 69001 Lyon',
    postalCode: '69001',
    city: 'Lyon',
    country: 'FR',
  },
  phone: '+334****0000',
  cuisineTypes: ['Bistrot', 'Française'],
  priceRange: '€€',
  openingHours: [
    { day: 'monday', open: '12:00', close: '14:30' },
    { day: 'monday', open: '19:00', close: '22:30' },
  ],
  reservationUrl: `https://suppernote.com/r/${SLUG}/book`,
  images: { cover: undefined, gallery: [] },
  acceptsReservations: true,
  publishedAt: '2026-06-24T00:00:00.000Z',
  connectAgentic: false,
};

const mockExposureSettings = {
  maxPartySize: 12,
  minLeadTimeMinutes: 30,
  quoteTtlSeconds: 300,
  holdTtlSeconds: 420,
  requireManualValidation: false,
  noShowPolicy: 'warning',
  notificationChannels: ['sms', 'email'],
  capacitySpecials: {},
};

let app: FastifyInstance;

describe('Suppernote Connect — Routes publiques', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Les créneaux de ces tests sont fixes (29 juin) : l'horloge est figée avant eux, sinon le hold
    // refuserait un créneau passé ou dans le délai minimum.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-25T10:00:00.000Z'));
    // Clear le store Redis in-memory pour éviter les cache hits
    // entre tests (le helper partage une Map entre les `it()` du fichier).
    await redisCache.flushall();
    app = await getApp();
  });
  afterAll(async () => {
    vi.useRealTimers();
    await closeApp();
  });

  describe('GET /public/r/:slug', () => {
    it('retourne 200 + DTO si le restaurant est publié', async () => {
      const findUnique = vi.mocked(db.restaurant.findUnique);
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
        id: RESTAURANT_ID,
        slug: 'chez-sokar-demo',
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
        openingHours: { mon: { open: '12:00', close: '14:30' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slug).toBe(SLUG);
      expect(body.reservationUrl).toContain(`/book/${SLUG}`);
      expect(body.name).toBe('Chez Suppernote');
      expect(body.connectAgentic).toBe(false);
      expect(findUnique).toHaveBeenNthCalledWith(1, {
        where: { slug: SLUG },
        include: expect.anything(),
      });
      expect(findUnique).toHaveBeenNthCalledWith(2, {
        where: { slug: 'chez-sokar-demo' },
        include: expect.anything(),
      });
    });

    it('retourne 404 si restaurant inexistant', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/public/r/inexistant',
      });

      expect(res.statusCode).toBe(404);
    });

    it('retourne 404 si connectPublished=false', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        exposureSettings: {
          connectPublished: false, // NOT published
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('retourne 404 si agenticOptIn=false (acceptsReservations=false)', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: false, // NOT accepting reservations
        publishedAt: new Date('2026-06-24'),
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('retourne 400 si le query param preview est invalide', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}?preview=invalid`,
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /public/restaurants', () => {
    it('retourne 400 si page est invalide', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/public/restaurants?page=abc',
      });

      expect(res.statusCode).toBe(400);
    });

    it('retourne 400 si limit dépasse le maximum', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/public/restaurants?limit=999',
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /public/v1/r/:slug (alias versioning Phase 6)', () => {
    // La réécriture /public/v1/* -> /public/* se fait via rewriteUrl au niveau
    // du serveur Fastify (main.ts), exécutée AVANT le routing. Un hook onRequest
    // serait trop tard (route déjà matchée -> 404). Ce test verrouille le bon
    // fonctionnement de l'alias en conditions réelles (app.inject).
    it('retourne 200 + DTO via l alias /public/v1/ (réécriture rewriteUrl)', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        name: 'Chez Sokar',
        description: 'Bistrot français à Lyon',
        formattedAddress: '12 Rue de la République, 69001 Lyon',
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Bistrot', 'Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '14:30' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const res = await app.inject({
        method: 'GET',
        url: `/public/v1/r/${SLUG}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.slug).toBe(SLUG);
      expect(body.name).toBe('Chez Sokar');
    });

    it('retourne 404 via l alias /public/v1/ si restaurant inexistant', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/public/v1/r/inexistant',
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /public/sitemap-data', () => {
    it('retourne la liste des slugs publiés', async () => {
      vi.mocked(db.restaurant.findMany).mockResolvedValue([
        {
          slug: 'chez-sokar-demo',
          updatedAt: new Date('2026-06-24'),
          publishedAt: new Date('2026-06-20'),
        },
        {
          slug: 'autre-restaurant',
          updatedAt: new Date('2026-06-23'),
          publishedAt: new Date('2026-06-22'),
        },
      ] as unknown as Awaited<ReturnType<typeof db.restaurant.findMany>>);

      const res = await app.inject({
        method: 'GET',
        url: '/public/sitemap-data',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.restaurants).toHaveLength(2);
      expect(body.restaurants[0].slug).toBe('chez-suppernote-demo');
      expect(body.restaurants[0].updatedAt).toBe('2026-06-24T00:00:00.000Z');

      // Le sitemap doit annoncer exactement les fiches que la page détail
      // accepte de rendre : sinon il promet des URL en 404.
      expect(vi.mocked(db.restaurant.findMany)).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining(EXPECTED_PUBLIC_PREDICATE) }),
      );
    });

    it('filtre les slugs null', async () => {
      vi.mocked(db.restaurant.findMany).mockResolvedValue([
        { slug: 'ok', updatedAt: new Date('2026-06-24'), publishedAt: new Date() },
        { slug: null, updatedAt: new Date('2026-06-23'), publishedAt: new Date() },
      ] as unknown as Awaited<ReturnType<typeof db.restaurant.findMany>>);

      const res = await app.inject({
        method: 'GET',
        url: '/public/sitemap-data',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().restaurants).toHaveLength(1);
    });
  });

  describe('GET /public/resolve-custom-domain', () => {
    it('renvoie le slug canonique pour une fiche stockée sous le slug legacy', async () => {
      vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        restaurant: { slug: 'chez-sokar-demo' },
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

      const res = await app.inject({
        method: 'GET',
        url: '/public/resolve-custom-domain?host=chez-test.example',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ slug: 'chez-suppernote-demo' });
    });

    it('normalise aussi un slug legacy déjà présent dans le cache', async () => {
      await app.redisCache.set(
        'connect:custom-domain:chez-test.example',
        JSON.stringify({ slug: 'chez-sokar-demo' }),
        'EX',
        300,
      );

      const res = await app.inject({
        method: 'GET',
        url: '/public/resolve-custom-domain?host=chez-test.example',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ slug: 'chez-suppernote-demo' });
      expect(db.restaurantExposureSettings.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('GET /public/r/:slug/availability', () => {
    it('retourne les slots du jour', async () => {
      // Mock le restaurant
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '14:30' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.agenticHold.findMany).mockResolvedValue([]);
      vi.mocked(db.reservation.findMany).mockResolvedValue([]);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );

      // Use a Monday date for the test
      const mondayDate = '2026-06-29'; // Monday

      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/availability?date=${mondayDate}&partySize=2`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.date).toBe(mondayDate);
      expect(body.partySize).toBe(2);
      expect(body.slots.length).toBeGreaterThan(0);
    });

    it('retourne 400 si date mal formée', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/availability?date=not-a-date&partySize=2`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('retourne 400 si partySize invalide', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/availability?date=2026-06-29&partySize=99`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('accepte un preferredSectionId optionnel', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '14:30' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      vi.mocked(db.agenticHold.findMany).mockResolvedValue([]);
      vi.mocked(db.reservation.findMany).mockResolvedValue([]);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );

      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/availability?date=2026-06-29&partySize=2&preferredSectionId=11111111-1111-1111-1111-111111111111`,
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /public/r/:slug/hold', () => {
    it('refuse un créneau absent des horaires proposés avant de créer un hold', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date(),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        name: 'Chez Sokar',
        phoneNumber: '+33400000000',
        openingHours: {},
        images: [],
        cuisineType: [],
        ambiance: [],
        dietary: [],
        exposureSettings: { connectPublished: true, connectAgentic: false },
      } as never);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as never,
      );
      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        remoteAddress: '198.51.100.201',
        payload: { date: '2026-06-29', time: '04:00', partySize: 2 },
      });
      expect(res.statusCode).toBe(409);
      expect(db.agenticHold.create).not.toHaveBeenCalled();
    });

    it('crée un hold 5min et retourne holdToken', async () => {
      // Mock restaurant
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );
      vi.mocked(db.agenticHold.create).mockResolvedValue({
        id: 'hold_123',
        holdToken: 'tok_abc',
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        status: 'ACTIVE',
        restaurantId: RESTAURANT_ID,
        partySize: 4,
        slotStart: new Date('2026-06-29T20:00:00Z'),
        slotEnd: new Date('2026-06-29T21:30:00Z'),
        channel: 'WEB',
        type: 'HOLD',
        policyVersion: '2026-06-20',
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof db.agenticHold.create>>);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 4,
          source: 'web',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.holdId).toBe('hold_123');
      expect(body.holdToken).toBe('tok_abc');
      expect(body.status).toBe('pending');

      // Regression: l'event analytics reservation_hold_created doit être queueé.
      // Bug historique : le worker staging volait les jobs de prod (Redis DB partagé),
      // donc holdsTotal=0 dans les KPIs. Ce test vérifie que l'emit est bien appelé.
      expect(app.queues.connectAnalytics.add).toHaveBeenCalledWith(
        'connect-event',
        expect.objectContaining({
          event: 'reservation_hold_created',
          restaurantId: RESTAURANT_ID,
          restaurantSlug: SLUG,
          source: 'web',
        }),
        expect.any(Object),
      );
    });

    it("force source='web' si connectAgentic=false et source=chatgpt", async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false, // PAS d'agentic
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );
      vi.mocked(db.agenticHold.create).mockResolvedValue({
        id: 'hold_123',
        holdToken: 'tok_abc',
        expiresAt: new Date(),
        status: 'ACTIVE',
        restaurantId: RESTAURANT_ID,
        partySize: 4,
        slotStart: new Date(),
        slotEnd: new Date(),
        channel: 'WEB',
        type: 'HOLD',
        policyVersion: '2026-06-20',
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof db.agenticHold.create>>);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 4,
          source: 'chatgpt', // agentic mais le resto n'a pas activé
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // chatgpt doit être forcé à 'web' car connectAgentic=false
      expect(body.sourceNormalized).toBe('web');
    });

    it("préserve source='google' même si connectAgentic=false (SEO)", async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );
      vi.mocked(db.agenticHold.create).mockResolvedValue({
        id: 'hold_123',
        holdToken: 'tok_abc',
        expiresAt: new Date(),
        status: 'ACTIVE',
        restaurantId: RESTAURANT_ID,
        partySize: 4,
        slotStart: new Date(),
        slotEnd: new Date(),
        channel: 'WEB',
        type: 'HOLD',
        policyVersion: '2026-06-20',
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof db.agenticHold.create>>);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 4,
          source: 'google', // SEO direct, PAS agentic
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.sourceNormalized).toBe('google');
    });
  });

  describe('POST /public/r/:slug/confirm', () => {
    it('rejoue une confirmation consommée uniquement si la demande et le restaurant correspondent', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date(),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        name: 'Chez Sokar',
        phoneNumber: '+33400000000',
        openingHours: {},
        images: [],
        cuisineType: [],
        ambiance: [],
        dietary: [],
        exposureSettings: { connectPublished: true, connectAgentic: false },
      } as never);
      const holdId = 'hold-replay';
      vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
        id: holdId,
        restaurantId: RESTAURANT_ID,
        status: 'CONSUMED',
        reservationId: 'reservation-replay',
        partySize: 2,
        slotStart: new Date('2026-06-29T20:00:00Z'),
      } as never);
      const request = {
        holdToken: CONFIRM_HOLD_TOKEN,
        customer: { firstName: 'Alice', phone: '+33612345678', email: 'alice@example.invalid' },
        specialRequests: 'Terrasse',
      };
      const parsed = ConfirmInputSchema.parse(request);
      const expectedWhere = {
        id: 'reservation-replay',
        restaurantId: RESTAURANT_ID,
        consumedHoldId: holdId,
        idempotencyScope: computeIdempotencyScope({
          restaurantId: RESTAURANT_ID,
          channel: 'WEB',
          clientId: hashPhone(request.customer.phone),
        }),
        idempotencyKey: holdId,
        idempotencyPayloadHash: hashPayload({ holdId, ...parsed }),
        isTest: false,
      };
      const find = vi
        .spyOn(db.reservation, 'findFirst')
        .mockImplementation((async (args: { where?: unknown }) =>
          JSON.stringify(args?.where) === JSON.stringify(expectedWhere)
            ? ({ id: 'reservation-replay', state: 'CONFIRMED', source: 'web' } as never)
            : null) as never);
      const create = vi.spyOn(ReservationService.prototype, 'createReservation');
      const first = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: '198.51.100.202',
        payload: request,
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ reservationId: 'reservation-replay', reused: true });
      const changed = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: '198.51.100.202',
        payload: { ...request, specialRequests: 'Intérieur' },
      });
      expect(changed.statusCode).toBe(409);
      const otherPhone = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: '198.51.100.202',
        payload: { ...request, customer: { ...request.customer, phone: '+33612345679' } },
      });
      expect(otherPhone.statusCode).toBe(409);
      expect(create).not.toHaveBeenCalled();
      expect(db.customerConsent.create).not.toHaveBeenCalled();
      create.mockRestore();
      find.mockRestore();
    });
    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      'consomme un hold et conserve le choix WhatsApp (%s, replay %s)',
      async (accepted, reused) => {
        vi.stubEnv('WHATSAPP_CONSENT_ENABLED', 'true');
        vi.stubEnv('RESERVATION_MANAGEMENT_ENABLED', 'true');
        vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
        vi.stubEnv('DASHBOARD_URL', 'https://suppernote.com');
        const reservationId = randomUUID();
        vi.mocked(db.reservation.findUnique).mockResolvedValue({
          id: reservationId,
          restaurantId: RESTAURANT_ID,
          customerPhone: '+33612345678',
          createdAt: new Date(),
          reservedAt: new Date(Date.now() + 2 * 86_400_000),
        } as never);
        vi.mocked(db.restaurant.findUnique).mockResolvedValue({
          id: RESTAURANT_ID,
          slug: SLUG,
          agenticOptIn: true,
          publishedAt: new Date('2026-06-24'),
          city: 'Lyon',
          country: 'FR',
          postalCode: '69001',
          description: null,
          formattedAddress: '12 Rue',
          phoneNumber: '+334****0000',
          phoneE164: '+334****0000',
          cuisineType: ['Française'],
          priceRange: 2,
          openingHours: { mon: { open: '12:00', close: '22:00' } },
          ambiance: [],
          dietary: [],
          noiseLevel: null,
          exposureSettings: {
            connectPublished: true,
            connectAgentic: true,
          },
          images: [],
        } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
        vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
          mockExposureSettings as unknown as Awaited<
            ReturnType<typeof db.restaurantExposureSettings.findUnique>
          >,
        );
        vi.mocked(db.customerConsent.create).mockResolvedValue({
          id: 'consent-confirm',
        } as unknown as Awaited<ReturnType<typeof db.customerConsent.create>>);
        vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
          id: 'hold-confirm',
          holdToken: CONFIRM_HOLD_TOKEN,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000),
          restaurantId: RESTAURANT_ID,
          partySize: 2,
          slotStart: new Date('2026-06-29T20:00:00Z'),
          slotEnd: new Date('2026-06-29T21:30:00Z'),
          tableId: null,
        } as unknown as Awaited<ReturnType<typeof db.agenticHold.findFirst>>);

        const createReservation = vi
          .spyOn(ReservationService.prototype, 'createReservation')
          .mockResolvedValue({
            reservationId,
            state: 'CONFIRMED',
            reused,
          });

        try {
          const res = await app.inject({
            method: 'POST',
            url: `/public/r/${SLUG}/confirm`,
            payload: {
              holdToken: CONFIRM_HOLD_TOKEN,
              idempotencyKey: '11111111-1111-4111-8111-111111111111',
              whatsappReminderConsent: { accepted, version: 'whatsapp-reminder-2026-10-17' },
              customer: {
                firstName: 'Alice',
                phone: '+33612345678',
              },
            },
          });

          expect(res.statusCode).toBe(200);
          expect(res.json()).toMatchObject({
            reservationId,
            status: 'confirmed',
            state: 'CONFIRMED',
            reused,
          });
          expect(res.json().managementUrl).toMatch(/^https:\/\/suppernote.com\/r#[\w-]+\.[\w-]+$/);
          expect(createReservation).toHaveBeenCalledWith(
            expect.objectContaining({
              holdToken: CONFIRM_HOLD_TOKEN,
              actor: 'connect:web',
              channel: 'WEB',
              consents: expect.objectContaining({ transactionalWhatsapp: accepted }),
            }),
            expect.objectContaining({ key: '11111111-1111-4111-8111-111111111111' }),
          );
          if (accepted) {
            if (!reused) expect(res.json().whatsappWithdrawalToken).toMatch(/^[a-f0-9]{64}$/);
            expect(createReservation.mock.calls[0][0].consents).toMatchObject({
              whatsappConsentProof: expect.objectContaining({ purpose: 'reservation_reminder' }),
            });
          } else {
            expect(res.json().whatsappWithdrawalToken).toBeUndefined();
          }
          if (reused) {
            expect(app.queues.connectAnalytics.add).not.toHaveBeenCalled();
          } else {
            expect(app.queues.connectAnalytics.add).toHaveBeenCalledWith(
              'connect-event',
              expect.objectContaining({
                event: 'reservation_confirmed',
                reservationId,
              }),
              expect.any(Object),
            );
          }
        } finally {
          createReservation.mockRestore();
          vi.unstubAllEnvs();
        }
      },
    );

    describe('consentement marketing facultatif', () => {
      const consent = { email: true, sms: false, version: MARKETING_CONSENT_VERSION };

      async function confirmWith(args: {
        reused: boolean;
        marketingConsent?: unknown;
        customerId?: string | null;
      }) {
        const reservationId = randomUUID();
        vi.mocked(db.reservation.findUnique).mockResolvedValue({
          id: reservationId,
          customerId: args.customerId === undefined ? 'customer-1' : args.customerId,
        } as never);
        vi.mocked(db.restaurant.findUnique).mockResolvedValue({
          id: RESTAURANT_ID,
          slug: SLUG,
          name: 'Chez Sokar',
          agenticOptIn: true,
          publishedAt: new Date('2026-06-24'),
          city: 'Lyon',
          country: 'FR',
          postalCode: '69001',
          description: null,
          formattedAddress: '12 Rue',
          phoneNumber: '+334****0000',
          phoneE164: '+334****0000',
          cuisineType: ['Française'],
          priceRange: 2,
          openingHours: { mon: { open: '12:00', close: '22:00' } },
          ambiance: [],
          dietary: [],
          noiseLevel: null,
          exposureSettings: { connectPublished: true, connectAgentic: true },
          images: [],
        } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
        vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
          mockExposureSettings as unknown as Awaited<
            ReturnType<typeof db.restaurantExposureSettings.findUnique>
          >,
        );
        vi.mocked(db.customerConsent.create).mockResolvedValue({
          id: 'consent-confirm',
        } as unknown as Awaited<ReturnType<typeof db.customerConsent.create>>);
        vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
          id: 'hold-confirm',
          holdToken: CONFIRM_HOLD_TOKEN,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000),
          restaurantId: RESTAURANT_ID,
          partySize: 2,
          slotStart: new Date('2026-06-29T20:00:00Z'),
          slotEnd: new Date('2026-06-29T21:30:00Z'),
          tableId: null,
        } as unknown as Awaited<ReturnType<typeof db.agenticHold.findFirst>>);
        const createReservation = vi
          .spyOn(ReservationService.prototype, 'createReservation')
          .mockResolvedValue({ reservationId, state: 'CONFIRMED', reused: args.reused });
        try {
          return await app.inject({
            method: 'POST',
            url: `/public/r/${SLUG}/confirm`,
            payload: {
              holdToken: CONFIRM_HOLD_TOKEN,
              idempotencyKey: randomUUID(),
              ...(args.marketingConsent ? { marketingConsent: args.marketingConsent } : {}),
              customer: { firstName: 'Alice', phone: '+33612345678', email: 'alice@example.com' },
            },
          });
        } finally {
          createReservation.mockRestore();
        }
      }

      it('enregistre les cases cochées pour la fiche client de la réservation', async () => {
        const res = await confirmWith({ reused: false, marketingConsent: consent });
        expect(res.statusCode).toBe(200);
        expect(db.reservation.findUnique).toHaveBeenCalledWith({
          where: { id: expect.any(String), restaurantId: RESTAURANT_ID },
          select: { customerId: true },
        });
        expect(recordBookingMarketingConsent).toHaveBeenCalledWith({
          restaurantId: RESTAURANT_ID,
          restaurantName: 'Chez Sokar',
          customerId: 'customer-1',
          source: 'CONNECT',
          consent,
          email: 'alice@example.com',
        });
      });

      it('ne fait rien sans bloc de consentement (contrat existant) ni sur un rejeu', async () => {
        expect((await confirmWith({ reused: false })).statusCode).toBe(200);
        expect((await confirmWith({ reused: true, marketingConsent: consent })).statusCode).toBe(
          200,
        );
        expect(recordBookingMarketingConsent).not.toHaveBeenCalled();
      });

      it('ne fait jamais échouer la réservation si le consentement ne peut pas être enregistré', async () => {
        vi.mocked(recordBookingMarketingConsent).mockRejectedValueOnce(new Error('boom'));
        const res = await confirmWith({ reused: false, marketingConsent: consent });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toMatchObject({ status: 'confirmed' });
      });
    });

    it('retourne 410 si hold expiré', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: {
          connectPublished: true,
          connectAgentic: false,
        },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.agenticHold.findFirst).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        payload: {
          holdToken: 'hold-test-expired',
          customer: {
            firstName: 'Hamza',
            phone: '+33612345678',
          },
        },
      });

      expect(res.statusCode).toBe(410);
    });
  });

  describe('délai minimum de réservation en ligne', () => {
    // Le stub du moteur place le créneau « 20:00 » le 29 juin 2026 à 20:00 UTC.
    const SLOT_START = new Date('2026-06-29T20:00:00.000Z');
    const minutesBefore = (minutes: number) => new Date(SLOT_START.getTime() - minutes * 60_000);

    function mockPublished(minLeadTimeMinutes: number, connectAgentic = false) {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: { connectPublished: true, connectAgentic },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue({
        ...mockExposureSettings,
        minLeadTimeMinutes,
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findUnique>>);
    }

    const holdRequest = () =>
      app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        payload: { date: '2026-06-29', time: '20:00', partySize: 4, source: 'web' },
      });

    describe('POST /public/r/:slug/hold', () => {
      it('refuse un créneau dans le délai minimum : 409, code explicite, message en français', async () => {
        mockPublished(120);
        vi.setSystemTime(minutesBefore(90));

        const res = await holdRequest();

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error:
            'Ce créneau est trop proche : ce restaurant accepte les réservations au moins 2 h à l’avance.',
          code: 'INSUFFICIENT_LEAD_TIME',
          minLeadTimeMinutes: 120,
        });
        expect(db.agenticHold.create).not.toHaveBeenCalled();
      });

      it('ne propose pas la file d’attente pour un créneau trop proche', async () => {
        mockPublished(120);
        vi.setSystemTime(minutesBefore(90));

        const body = (await holdRequest()).json() as Record<string, unknown>;

        expect(body.waitingListEnabled).toBeUndefined();
      });

      it('accepte un créneau qui commence exactement à maintenant + délai', async () => {
        mockPublished(120);
        vi.setSystemTime(minutesBefore(120));
        vi.mocked(db.agenticHold.create).mockResolvedValue({
          id: 'hold_limit',
          holdToken: 'tok_abc',
          expiresAt: new Date(Date.now() + 5 * 60 * 1000),
          status: 'ACTIVE',
          restaurantId: RESTAURANT_ID,
          partySize: 4,
          slotStart: SLOT_START,
          slotEnd: new Date(SLOT_START.getTime() + 90 * 60_000),
          channel: 'WEB',
          type: 'HOLD',
          policyVersion: '2026-06-20',
          createdAt: new Date(),
        } as unknown as Awaited<ReturnType<typeof db.agenticHold.create>>);

        const res = await holdRequest();

        expect(res.statusCode).toBe(200);
        expect(res.json().holdId).toBe('hold_limit');
      });

      it('refuse une minute avant la limite', async () => {
        mockPublished(120);
        vi.setSystemTime(minutesBefore(119));

        expect((await holdRequest()).statusCode).toBe(409);
      });

      it('formate le délai : 30 min, 1 h 30', async () => {
        mockPublished(30);
        vi.setSystemTime(minutesBefore(20));
        expect(((await holdRequest()).json() as { error: string }).error).toContain(
          'au moins 30 min à l’avance',
        );

        mockPublished(90);
        vi.setSystemTime(minutesBefore(20));
        expect(((await holdRequest()).json() as { error: string }).error).toContain(
          'au moins 1 h 30 à l’avance',
        );
      });
    });

    describe('POST /public/r/:slug/confirm', () => {
      it('répond 409 et un message en français, plus un 500 anglais, quand le créneau est devenu trop proche', async () => {
        mockPublished(120, true);
        vi.mocked(db.customerConsent.create).mockResolvedValue({
          id: 'consent-lead',
        } as unknown as Awaited<ReturnType<typeof db.customerConsent.create>>);
        vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
          id: 'hold-lead',
          holdToken: CONFIRM_HOLD_TOKEN,
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000),
          restaurantId: RESTAURANT_ID,
          partySize: 2,
          slotStart: SLOT_START,
          slotEnd: new Date(SLOT_START.getTime() + 90 * 60_000),
          tableId: null,
        } as unknown as Awaited<ReturnType<typeof db.agenticHold.findFirst>>);
        const createReservation = vi
          .spyOn(ReservationService.prototype, 'createReservation')
          .mockRejectedValue(
            new PolicyValidationError(
              'Insufficient lead time: 90min avant, minimum 120min requis',
              'INSUFFICIENT_LEAD_TIME',
            ),
          );

        try {
          const res = await app.inject({
            method: 'POST',
            url: `/public/r/${SLUG}/confirm`,
            payload: {
              holdToken: CONFIRM_HOLD_TOKEN,
              idempotencyKey: '22222222-2222-4222-8222-222222222222',
              customer: { firstName: 'Alice', phone: '+33612345678' },
            },
          });

          expect(res.statusCode).toBe(409);
          expect(res.json()).toEqual({
            error:
              'Ce créneau est trop proche : ce restaurant accepte les réservations au moins 2 h à l’avance.',
            code: 'INSUFFICIENT_LEAD_TIME',
            minLeadTimeMinutes: 120,
          });
          expect((res.json() as { error: string }).error).not.toMatch(/Insufficient|lead time/i);
        } finally {
          createReservation.mockRestore();
        }
      });
    });
  });

  describe('réservation test (testBookingToken)', () => {
    const EXPIRED_MESSAGE = 'Ce lien de test a expiré. Relancez-le depuis votre tableau de bord.';
    const QUOTA_MESSAGE = 'Vous avez atteint la limite de 5 réservations test sur 24 heures.';
    const OTHER_RESTAURANT_ID = 'c0ffee00-eb72-4e05-bb9c-b576e39e33ba';

    function mockPublishedRestaurant() {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        slug: SLUG,
        agenticOptIn: true,
        publishedAt: new Date('2026-06-24'),
        city: 'Lyon',
        country: 'FR',
        postalCode: '69001',
        description: null,
        formattedAddress: '12 Rue',
        phoneNumber: '+334****0000',
        phoneE164: '+334****0000',
        cuisineType: ['Française'],
        priceRange: 2,
        openingHours: { mon: { open: '12:00', close: '22:00' } },
        ambiance: [],
        dietary: [],
        noiseLevel: null,
        exposureSettings: { connectPublished: true, connectAgentic: false },
        images: [],
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValue(
        mockExposureSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.findUnique>
        >,
      );
    }

    function mockActiveHold() {
      vi.mocked(db.agenticHold.findFirst).mockResolvedValue({
        id: 'hold-test',
        holdToken: CONFIRM_HOLD_TOKEN,
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 60_000),
        restaurantId: RESTAURANT_ID,
        partySize: 2,
        slotStart: new Date('2026-06-29T20:00:00Z'),
        slotEnd: new Date('2026-06-29T21:30:00Z'),
        tableId: null,
      } as unknown as Awaited<ReturnType<typeof db.agenticHold.findFirst>>);
    }

    function mockHoldCreate() {
      // Les mocks gardent leur implémentation d'un test à l'autre : aucun hold existant.
      vi.mocked(db.agenticHold.findFirst).mockResolvedValue(null);
      vi.mocked(db.agenticHold.create).mockResolvedValue({
        id: 'hold_test',
        holdToken: TEST_HOLD_TOKEN,
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        status: 'ACTIVE',
        restaurantId: RESTAURANT_ID,
        partySize: 2,
        slotStart: new Date('2026-06-29T20:00:00Z'),
        slotEnd: new Date('2026-06-29T21:30:00Z'),
        channel: 'WEB',
        type: 'HOLD',
        policyVersion: '2026-06-20',
        createdAt: new Date(),
      } as unknown as Awaited<ReturnType<typeof db.agenticHold.create>>);
    }

    // Le rate limit par IP de Fastify survit entre les tests (horloge figée) :
    // une adresse par requête garde ces tests indépendants des précédents.
    let ipCounter = 0;
    const nextIp = () => `198.51.100.${++ipCounter}`;

    const holdRequest = (testBookingToken?: string) =>
      app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        remoteAddress: nextIp(),
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 2,
          source: 'web',
          ...(testBookingToken !== undefined ? { testBookingToken } : {}),
        },
      });

    const confirmRequest = (testBookingToken?: string) =>
      app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: nextIp(),
        payload: {
          holdToken: CONFIRM_HOLD_TOKEN,
          idempotencyKey: '33333333-3333-4333-8333-333333333333',
          marketingAttributionToken: 'm'.repeat(40),
          giftCardCode: 'GIFT-TEST',
          customer: { firstName: 'Alice', phone: '+33612345678' },
          ...(testBookingToken !== undefined ? { testBookingToken } : {}),
        },
      });

    let createReservation: ReturnType<typeof vi.spyOn>;
    let recordConsent: ReturnType<typeof vi.spyOn>;
    let canConfirm: ReturnType<typeof vi.spyOn>;
    let recordFailedConfirm: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.stubEnv('TEST_BOOKING_ENABLED', 'true');
      vi.stubEnv('TEST_BOOKING_SECRET', randomBytes(32).toString('hex'));
      mockPublishedRestaurant();
      createReservation = vi
        .spyOn(ReservationService.prototype, 'createReservation')
        .mockResolvedValue({ reservationId: randomUUID(), state: 'CONFIRMED', reused: false });
      recordConsent = vi
        .spyOn(ConsentService.prototype, 'recordConsent')
        .mockResolvedValue(undefined as never);
      canConfirm = vi.spyOn(connectRateLimit, 'canConfirm').mockResolvedValue(true);
      recordFailedConfirm = vi
        .spyOn(connectRateLimit, 'recordFailedConfirm')
        .mockResolvedValue(undefined);
    });

    afterEach(() => {
      createReservation.mockRestore();
      recordConsent.mockRestore();
      canConfirm.mockRestore();
      recordFailedConfirm.mockRestore();
      vi.unstubAllEnvs();
    });

    const refusedTokens: Array<[string, () => string]> = [
      ['malformé', () => 'pas-un-jeton'],
      [
        'signature invalide',
        () => `${issueTestBookingToken(RESTAURANT_ID).split('.')[0]}.${'A'.repeat(43)}`,
      ],
      ['expiré', () => issueTestBookingToken(RESTAURANT_ID, new Date(Date.now() - 2 * 3600_000))],
      ["d'un autre restaurant", () => issueTestBookingToken(OTHER_RESTAURANT_ID)],
    ];

    it.each(refusedTokens)('hold : refuse un jeton %s avec 403', async (_label, token) => {
      const res = await holdRequest(token());

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: EXPIRED_MESSAGE });
      expect(db.agenticHold.create).not.toHaveBeenCalled();
      expect(app.queues.connectAnalytics.add).not.toHaveBeenCalled();
    });

    it.each(refusedTokens)('confirm : refuse un jeton %s avec 403', async (_label, token) => {
      mockActiveHold();

      const res = await confirmRequest(token());

      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: EXPIRED_MESSAGE });
      expect(createReservation).not.toHaveBeenCalled();
      expect(recordConsent).not.toHaveBeenCalled();
    });

    it('refuse un jeton valide quand le drapeau est coupé', async () => {
      const token = issueTestBookingToken(RESTAURANT_ID);
      vi.stubEnv('TEST_BOOKING_ENABLED', 'false');
      mockActiveHold();

      const hold = await holdRequest(token);
      const confirm = await confirmRequest(token);

      expect(hold.statusCode).toBe(403);
      expect(hold.json()).toEqual({ error: EXPIRED_MESSAGE });
      expect(confirm.statusCode).toBe(403);
      expect(confirm.json()).toEqual({ error: EXPIRED_MESSAGE });
      expect(db.agenticHold.create).not.toHaveBeenCalled();
      expect(createReservation).not.toHaveBeenCalled();
    });

    it('hold : crée le hold sans événement analytics avec un jeton valide', async () => {
      mockHoldCreate();

      const res = await holdRequest(issueTestBookingToken(RESTAURANT_ID));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ holdId: 'hold_test', holdToken: TEST_HOLD_TOKEN });
      expect(db.agenticHold.create).toHaveBeenCalled();
      expect(app.queues.connectAnalytics.add).not.toHaveBeenCalled();
    });

    it('confirm : crée une réservation test hors consentement, anti-spam et analytics', async () => {
      vi.stubEnv('RESERVATION_MANAGEMENT_ENABLED', 'true');
      vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
      vi.stubEnv('DASHBOARD_URL', 'https://suppernote.com');
      mockActiveHold();
      const reservationId = randomUUID();
      createReservation.mockResolvedValue({ reservationId, state: 'CONFIRMED', reused: false });
      vi.mocked(db.reservation.findUnique).mockResolvedValue({
        id: reservationId,
        restaurantId: RESTAURANT_ID,
        customerPhone: '+33612345678',
        createdAt: new Date(),
        reservedAt: new Date(Date.now() + 2 * 86_400_000),
      } as never);

      const res = await confirmRequest(issueTestBookingToken(RESTAURANT_ID));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ reservationId, status: 'confirmed', reused: false });
      expect(res.json().managementUrl).toMatch(/^https:\/\/suppernote.com\/r#[\w-]+\.[\w-]+$/);
      expect(createReservation).toHaveBeenCalledTimes(1);
      const [input, idempotency] = createReservation.mock.calls[0] as [
        Record<string, unknown>,
        { scope: string },
      ];
      expect(input).toMatchObject({ isTest: true, holdToken: CONFIRM_HOLD_TOKEN });
      expect(input.marketingAttributionToken).toBeUndefined();
      expect(input.giftCardCode).toBeUndefined();
      expect(input.giftCardReservationAmount).toBeUndefined();
      expect(idempotency.scope).toContain('test:');
      expect(recordConsent).not.toHaveBeenCalled();
      expect(canConfirm).not.toHaveBeenCalled();
      expect(recordFailedConfirm).not.toHaveBeenCalled();
      expect(app.queues.connectAnalytics.add).not.toHaveBeenCalled();
    });

    it("confirm : n'enregistre aucun consentement marketing pour une réservation test", async () => {
      mockActiveHold();

      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: nextIp(),
        payload: {
          holdToken: CONFIRM_HOLD_TOKEN,
          idempotencyKey: randomUUID(),
          customer: { firstName: 'Alice', phone: '+33612345678', email: 'alice@example.com' },
          marketingConsent: { email: true, sms: false, version: MARKETING_CONSENT_VERSION },
          testBookingToken: issueTestBookingToken(RESTAURANT_ID),
        },
      });

      expect(res.statusCode).toBe(200);
      expect(createReservation).toHaveBeenCalledTimes(1);
      expect(recordBookingMarketingConsent).not.toHaveBeenCalled();
    });

    it('confirm : un échec de création test ne compte ni anti-spam ni analytics', async () => {
      mockActiveHold();
      createReservation.mockRejectedValue(new Error('boom'));

      const res = await confirmRequest(issueTestBookingToken(RESTAURANT_ID));

      expect(res.statusCode).toBe(500);
      expect(recordFailedConfirm).not.toHaveBeenCalled();
      expect(app.queues.connectAnalytics.add).not.toHaveBeenCalled();
    });

    it('confirm : répond 429 sans création quand le quota est épuisé', async () => {
      mockActiveHold();
      for (let i = 0; i < 5; i++) await consumeTestBookingQuota(RESTAURANT_ID);

      const res = await confirmRequest(issueTestBookingToken(RESTAURANT_ID));

      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({ error: QUOTA_MESSAGE });
      expect(createReservation).not.toHaveBeenCalled();
    });

    it('confirm : sans jeton, le circuit réel reste inchangé', async () => {
      mockActiveHold();

      const res = await confirmRequest();

      expect(res.statusCode).toBe(200);
      const [input, idempotency] = createReservation.mock.calls[0] as [
        Record<string, unknown>,
        { scope: string },
      ];
      expect(input.isTest).toBeUndefined();
      expect(input.marketingAttributionToken).toBe('m'.repeat(40));
      expect(input.giftCardCode).toBe('GIFT-TEST');
      expect(idempotency.scope).not.toContain('test:');
      await (input.beforeCreate as (tx: typeof db) => Promise<void>)(db);
      expect(recordConsent).toHaveBeenCalled();
      expect(canConfirm).toHaveBeenCalled();
    });
  });
});
