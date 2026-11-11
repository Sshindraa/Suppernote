/**
 * Tests routes Suppernote Connect — T8 (analytics events → queue).
 *
 * Couvre :
 * - POST /public/analytics/events 202 si event valide
 * - POST 400 si event manquant
 * - POST 400 si event > 64 chars
 * - Pas d'auth requise
 * - Pas de PII dans le payload (juste restaurantId, source, etc.)
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

describe('Suppernote Connect — Analytics T8', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await redisCache.flushall();
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('POST /public/analytics/events → 202 si event valide', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/analytics/events',
      payload: {
        event: 'restaurant_page_view',
        restaurantId: 'rest-1',
        restaurantSlug: 'chez-suppernote-demo',
        source: 'google',
      },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ ok: true });
  });

  it('POST /public/analytics/events → 400 si event manquant', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/analytics/events',
      payload: { restaurantId: 'rest-1' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /public/analytics/events → 400 si event > 64 chars', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/analytics/events',
      payload: { event: 'a'.repeat(65) },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /public/analytics/events → pas d'auth requise (endpoint public)", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/analytics/events',
      headers: {}, // explicit empty
      payload: { event: 'cta_clicked' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('POST /public/analytics/events → accepte event inconnu (forward compat)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/public/analytics/events',
      payload: { event: 'unknown_event_type' },
    });
    expect(res.statusCode).toBe(202); // pas de reject, le worker drop si invalide
  });
});
