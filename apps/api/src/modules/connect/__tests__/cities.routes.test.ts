/**
 * Tests routes Suppernote Connect — T7 (pages locales).
 *
 * Couvre (acceptance criteria spec v1.1 §3.3 + §10) :
 * - GET /public/cities → liste filtrée 5+ restos
 * - GET /public/cities/:slug → restaurants d'une ville
 * - GET /public/cities/:slug?cuisine= → filtré par cuisine
 * - Règle 5/10/20 respectée (shouldIndex)
 * - 404 si ville introuvable
 * - 400 si slug invalide
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import type { FastifyInstance } from 'fastify';

/**
 * Copie volontaire de l'invariant de publication : le test doit énoncer le
 * contrat indépendamment de `PUBLIC_CONNECT_WHERE`, sinon retirer une condition
 * de la constante retirerait aussi l'attente (cf. connect.routes.test.ts).
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

const RESTAURANT_BASE = {
  id: 'rest-1',
  slug: 'chez-suppernote-demo',
  name: 'Chez Suppernote',
  description: 'Restaurant démo',
  phone: '+331****0405',
  address: {
    line1: '12 Rue Exemple',
    postalCode: '69001',
    city: 'Lyon',
    country: 'FR',
  },
  cuisineType: ['Italien'],
  priceRange: '€€',
  images: { cover: null, gallery: [] },
  rating: null,
  acceptsReservations: true,
  reservationUrl: 'https://suppernote.com/r/chez-suppernote-demo/book',
  published: true,
  publishedAt: '2026-06-24T10:00:00.000Z',
  connectAgentic: false,
  exposureSettings: {
    connectPublished: true,
    connectAgentic: false,
  },
  openingHours: {},
  attributes: {
    ambience: null,
    dietary: [],
    accessibility: [],
    features: [],
  },
  hasMenu: false,
  hasGallery: false,
  hasAvailability: false,
  latitude: null,
  longitude: null,
  paymentMethods: [],
  capacity: 40,
  averageMealPrice: 25,
  menuUrl: null,
  cancellationPolicy: null,
  noShowPolicy: null,
  depositRequired: false,
  languages: ['fr'],
  attributeConfidence: 0.8,
};

let app: FastifyInstance;

describe('Suppernote Connect — Pages locales T7', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await redisCache.flushall();
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('GET /public/cities → 200 + liste vide si <5 restos', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { city: 'Lyon', cuisineType: ['Italien'] },
      { city: 'Lyon', cuisineType: ['Japonais'] },
    ] as never);
    const res = await app.inject({ method: 'GET', url: '/public/cities' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.cities).toEqual([]); // <5 restos
  });

  it('GET /public/cities → 200 + ville listée si 5+ restos', async () => {
    const rows = [
      { city: 'Lyon', cuisineType: ['Italien'] },
      { city: 'Lyon', cuisineType: ['Italien'] },
      { city: 'Lyon', cuisineType: ['Japonais'] },
      { city: 'Lyon', cuisineType: ['Français'] },
      { city: 'Lyon', cuisineType: ['Pizza'] },
      { city: 'Marseille', cuisineType: ['Italien'] },
    ] as never;
    vi.mocked(db.restaurant.findMany).mockResolvedValue(rows);

    const res = await app.inject({ method: 'GET', url: '/public/cities' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.cities).toHaveLength(1); // seul Lyon (6 restos) >=5
    expect(data.cities[0].city).toBe('Lyon');
    expect(data.cities[0].citySlug).toBe('lyon');
    expect(data.cities[0].total).toBe(5);
    expect(data.cities[0].cuisines.length).toBe(4);

    // Même invariant que le sitemap et la page détail (cf. PUBLIC_CONNECT_WHERE).
    expect(vi.mocked(db.restaurant.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(EXPECTED_PUBLIC_PREDICATE) }),
    );
  });

  it('GET /public/cities/:slug → 200 + restaurants si indexable', async () => {
    // Mock le 1er findMany (calcul des villes) avec Lyon = 6 restos
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce(
      Array.from({ length: 6 }, () => ({ city: 'Lyon', cuisineType: ['Italien'] })) as never,
    );
    // Mock le 2e findMany (slugs après filtre) : 2 restos à Lyon
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([
      { slug: 'rest-1' },
      { slug: 'rest-2' },
    ] as never);
    // Mock le 3e findMany (getPublishedBySlugs — batch DTOs)
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([] as never);
    // Note : ce test vérifie la mécanique ville, pas la sérialisation DTO
    // (testée dans connect.routes.test.ts).
    const res = await app.inject({ method: 'GET', url: '/public/cities/lyon' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.city).toBe('Lyon');
    expect(data.totalInCity).toBe(6);
    expect(data.shouldIndex).toBe(true);

    // La 2e requête est celle qui liste les fiches de la ville : elle doit
    // porter le même invariant, sinon la page ville annonce des URL en 404.
    expect(vi.mocked(db.restaurant.findMany)).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ where: expect.objectContaining(EXPECTED_PUBLIC_PREDICATE) }),
    );
    expect(Array.isArray(data.restaurants)).toBe(true);
  });

  it('GET /public/cities/:slug → 200 + shouldIndex=false si <5 restos', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { city: 'Lyon', cuisineType: ['Italien'] },
    ] as never);
    const res = await app.inject({ method: 'GET', url: '/public/cities/lyon' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.shouldIndex).toBe(false);
    expect(data.reason).toBe('not_enough_inventory');
    expect(data.restaurants).toEqual([]);
  });

  it('GET /public/cities/:slug?cuisine=italien → 200 + filtré', async () => {
    const cityRows = [
      { city: 'Lyon', cuisineType: ['Italien'] },
      { city: 'Lyon', cuisineType: ['Italien'] },
      { city: 'Lyon', cuisineType: ['Japonais'] },
    ];
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce(cityRows as never);
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([{ slug: 'rest-1' }] as never);
    // Mock le 3e findMany (getPublishedBySlugs — batch DTOs)
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([] as never);

    const res = await app.inject({
      method: 'GET',
      url: '/public/cities/lyon?cuisine=italien',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.cuisine).toBe('Italien');
    expect(data.shouldIndex).toBe(false); // <10 restos total
  });

  it('GET /public/cities/:slug → 404 si ville inexistante', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { city: 'Marseille', cuisineType: ['Italien'] },
    ] as never);
    const res = await app.inject({ method: 'GET', url: '/public/cities/paris' });
    expect(res.statusCode).toBe(404);
  });

  it('GET /public/cities/:slug → 400 si slug invalide', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/public/cities/lyon__INVALID__',
    });
    expect(res.statusCode).toBe(400);
  });
});
