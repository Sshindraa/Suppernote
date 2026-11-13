/**
 * Route-level tests for the public widget endpoint.
 *
 * GET /public/widget/:slug — utilisé par l'iframe suppernote.com/widget/{slug}.
 * Doit fonctionner pour tous les restos (publiés ou pas sur Suppernote Connect),
 * contrairement à /public/r/:slug qui filtre sur connectPublished.
 */
import { describe, it, expect, vi, afterAll, beforeEach } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

describe('GET /public/widget/:slug', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('résout le nouveau slug sur la fiche legacy avant la migration des données', async () => {
    const app = await getApp();
    const fakeRestaurant = {
      id: 'rest-uuid-123',
      name: 'Chez Suppernote',
      slug: 'chez-sokar-demo',
      openingHours: { mon: { open: '12:00', close: '14:30' } },
      phoneNumber: '+33123456789',
      city: 'Lyon',
      cuisineType: ['bistro'],
      coverImageUrl: null,
      formattedAddress: '1 rue de la Paix, Lyon',
      floorPlans: [{ sections: [{ id: 'section-terrasse', name: 'Terrasse' }] }],
    };
    const findUnique = vi.mocked(db.restaurant.findUnique);
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(fakeRestaurant as never);

    const res = await app.inject({
      method: 'GET',
      url: '/public/widget/chez-suppernote-demo',
    });

    expect(res.statusCode).toBe(200);
    expect(findUnique).toHaveBeenCalledWith({
      where: { slug: 'chez-suppernote-demo' },
      select: expect.objectContaining({ id: true, name: true, openingHours: true }),
    });
    expect(findUnique).toHaveBeenLastCalledWith({
      where: { slug: 'chez-sokar-demo' },
      select: expect.objectContaining({ id: true, name: true, openingHours: true }),
    });
    const body = res.json();
    expect(body.bookingEnabled).toBe(false);
    expect(body).not.toHaveProperty('exposureSettings');
    expect(body.id).toBe('rest-uuid-123');
    expect(body.slug).toBe('chez-suppernote-demo');
    expect(body.sections).toEqual([{ id: 'section-terrasse', name: 'Terrasse' }]);
  });

  it('annonce la réservation disponible seulement pour une publication complète', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: 'rest-1',
      slug: 'chez-sokar-demo',
      name: 'Chez Suppernote',
      publishedAt: new Date(),
      agenticOptIn: true,
      exposureSettings: { connectPublished: true },
    } as never);
    const response = await app.inject({ method: 'GET', url: '/public/widget/chez-sokar-demo' });
    expect(response.json().bookingEnabled).toBe(true);
    expect(response.json()).not.toHaveProperty('agenticOptIn');
    expect(response.json().slug).toBe('chez-suppernote-demo');
  });

  it('résout encore le slug legacy après la migration de la fiche stockée', async () => {
    const findUnique = vi.mocked(db.restaurant.findUnique);
    findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: 'rest-1',
      slug: 'chez-suppernote-demo',
      name: 'Chez Suppernote',
      publishedAt: new Date(),
      agenticOptIn: true,
      exposureSettings: { connectPublished: true },
      floorPlans: [],
    } as never);

    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/public/widget/chez-sokar-demo',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().slug).toBe('chez-suppernote-demo');
    expect(findUnique).toHaveBeenNthCalledWith(1, {
      where: { slug: 'chez-sokar-demo' },
      select: expect.anything(),
    });
    expect(findUnique).toHaveBeenNthCalledWith(2, {
      where: { slug: 'chez-suppernote-demo' },
      select: expect.anything(),
    });
  });

  it('renvoie 404 quand le slug est inconnu', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

    const res = await app.inject({
      method: 'GET',
      url: '/public/widget/does-not-exist',
    });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'Restaurant not found' });
  });
});
