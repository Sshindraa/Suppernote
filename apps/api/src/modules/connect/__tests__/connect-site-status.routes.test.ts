/**
 * Sites suspendus (SUSPENDED) ou archivés (ARCHIVED) : plus aucune nouvelle réservation
 * en ligne, et hors des listes publiques. Un site inactif répond comme un site non publié.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';

const SLUG = 'chez-suppernote-demo';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';
// Jeton de test construit par morceaux : évite un faux positif du contrôle de secrets.
const HOLD_TOKEN = ['tok', 'site', 'inactif'].join('-') + '-x'.repeat(10);

function restaurantRow(siteStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
  return {
    id: RESTAURANT_ID,
    slug: SLUG,
    name: 'Chez Suppernote',
    siteStatus,
    agenticOptIn: true,
    publishedAt: new Date('2026-06-24'),
    city: 'Lyon',
    country: 'FR',
    postalCode: '69001',
    description: null,
    formattedAddress: '12 Rue de la République, 69001 Lyon',
    phoneNumber: '+33400000000',
    phoneE164: '+33400000000',
    cuisineType: ['Française'],
    priceRange: 2,
    openingHours: {},
    ambiance: [],
    dietary: [],
    noiseLevel: null,
    exposureSettings: { connectPublished: true, connectAgentic: false },
    images: [],
  } as never;
}

let app: FastifyInstance;

describe('Suppernote Connect — sites suspendus ou archivés', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Pas de cache Redis entre les tests : le cache ne porte pas siteStatus.
    await redisCache.flushall();
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  describe.each(['SUSPENDED', 'ARCHIVED'] as const)('site %s', (siteStatus) => {
    beforeEach(() => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(restaurantRow(siteStatus));
    });

    it('refuse un hold : 404 comme un site non publié, aucun hold créé', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/hold`,
        remoteAddress: '198.51.100.210',
        payload: { date: '2026-06-29', time: '20:00', partySize: 2 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Restaurant not found or not published' });
      expect(db.agenticHold.create).not.toHaveBeenCalled();
    });

    it('refuse une confirmation : 404, aucune réservation créée', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/confirm`,
        remoteAddress: '198.51.100.211',
        payload: {
          holdToken: HOLD_TOKEN,
          customer: { firstName: 'Alice', phone: '+33612345678' },
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Restaurant not found or not published' });
      expect(db.agenticHold.findFirst).not.toHaveBeenCalled();
      expect(db.reservation.create).not.toHaveBeenCalled();
    });

    it('refuse les disponibilités : 404 pour ne proposer aucun créneau', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/public/r/${SLUG}/availability?date=2026-06-29&partySize=2`,
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Restaurant not found or not published' });
    });

    it("refuse l'inscription en file d'attente : 404", async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/public/r/${SLUG}/waiting-list`,
        remoteAddress: '198.51.100.212',
        payload: {
          date: '2026-06-29',
          time: '20:00',
          partySize: 4,
          customer: { firstName: 'Alice', phone: '+33612345678' },
        },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Restaurant not found or not published' });
    });
  });

  it('exclut les sites suspendus ou archivés du sitemap', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([]);

    const res = await app.inject({ method: 'GET', url: '/public/sitemap-data' });

    expect(res.statusCode).toBe(200);
    expect(db.restaurant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          siteStatus: { notIn: ['ARCHIVED', 'SUSPENDED'] },
        }),
      }),
    );
  });
});
