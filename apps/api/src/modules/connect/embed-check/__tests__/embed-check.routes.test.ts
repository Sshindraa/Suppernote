import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { getApp, closeApp } from '../../../../test/helpers';
import { db } from '../../../../shared/db/client';
import { redisCache } from '../../../../shared/redis/client';

// Redis de test : le module redis est chargé par le setup avant ce fichier, donc on remplace les
// seules commandes utilisées sur l'instance partagée (celle que lisent les routes).
const store = { hashes: new Map<string, Map<string, string>>() };

function hashOf(key: string): Map<string, string> {
  let value = store.hashes.get(key);
  if (!value) {
    value = new Map();
    store.hashes.set(key, value);
  }
  return value;
}

Object.assign(redisCache, {
  hset: vi.fn(async (key: string, field: string, value: string) => {
    hashOf(key).set(field, value);
    return 1;
  }),
  hexists: vi.fn(async (key: string, field: string) => (hashOf(key).has(field) ? 1 : 0)),
  hlen: vi.fn(async (key: string) => hashOf(key).size),
  hgetall: vi.fn(async (key: string) => Object.fromEntries(hashOf(key))),
  expire: vi.fn(async () => 1),
});

const AUTH = { authorization: 'Bearer test-token' };
const HEARTBEAT_URL = '/public/embed/heartbeat';
const CHEZ_X_KEY = 'embed:heartbeat:rest-x';

function heartbeat(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'chez-x',
    origin: 'https://chez-x.fr/menu?ref=1',
    version: '1.2.0',
    mode: 'inline',
    buttons: 2,
    ...overrides,
  };
}

function mockRestaurants() {
  vi.mocked(db.restaurant.findUnique).mockImplementation((async (args: {
    where: { slug?: string; id?: string };
  }) => {
    if (args.where.slug === 'chez-x') return { id: 'rest-x' };
    if (args.where.slug === 'rate-x') return { id: 'rest-rate' };
    if (args.where.id === 'test-rest-1') return { slug: 'chez-x' };
    return null;
  }) as never);
}

let app: FastifyInstance;

describe('POST /public/embed/heartbeat', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.hashes.clear();
    mockRestaurants();
    app = await getApp();
  });
  afterAll(async () => {
    await closeApp();
  });

  it('accepte text/plain (sendBeacon) et stocke une entrée par origine, sans PII', async () => {
    const res = await app.inject({
      method: 'POST',
      url: HEARTBEAT_URL,
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      payload: JSON.stringify(heartbeat()),
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();

    const entry = JSON.parse(store.hashes.get(CHEZ_X_KEY)!.get('https://chez-x.fr')!);
    expect(entry).toEqual({
      at: expect.any(String),
      version: '1.2.0',
      mode: 'inline',
      buttons: 2,
    });
    expect(Object.keys(entry).sort()).toEqual(['at', 'buttons', 'mode', 'version']);
    expect(vi.mocked(redisCache.expire)).toHaveBeenCalledWith(CHEZ_X_KEY, 30 * 24 * 60 * 60);
  });

  it('accepte application/json', async () => {
    const res = await app.inject({
      method: 'POST',
      url: HEARTBEAT_URL,
      headers: { 'content-type': 'application/json' },
      payload: heartbeat({ origin: 'https://www.chez-x.fr', mode: 'modal', buttons: 0 }),
    });
    expect(res.statusCode).toBe(204);
    expect(store.hashes.get(CHEZ_X_KEY)!.has('https://www.chez-x.fr')).toBe(true);
  });

  it('répond 204 et ne stocke rien pour un slug inconnu', async () => {
    const res = await app.inject({
      method: 'POST',
      url: HEARTBEAT_URL,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(heartbeat({ slug: 'inconnu' })),
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(redisCache.hset)).not.toHaveBeenCalled();
  });

  it.each([
    ['origine non http', { origin: 'javascript:alert(1)' }],
    ['mode inconnu', { mode: 'popup' }],
    ['boutons hors bornes', { buttons: 500 }],
    ['version trop longue', { version: 'x'.repeat(11) }],
    ['champ manquant', { slug: undefined }],
  ])('valide le corps : %s → 204 sans écriture', async (_label, override) => {
    const res = await app.inject({
      method: 'POST',
      url: HEARTBEAT_URL,
      headers: { 'content-type': 'text/plain' },
      payload: JSON.stringify(heartbeat(override)),
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(redisCache.hset)).not.toHaveBeenCalled();
  });

  it('ignore un corps qui n’est pas du JSON', async () => {
    const res = await app.inject({
      method: 'POST',
      url: HEARTBEAT_URL,
      headers: { 'content-type': 'text/plain' },
      payload: 'pas du json',
    });
    expect(res.statusCode).toBe(204);
    expect(vi.mocked(redisCache.hset)).not.toHaveBeenCalled();
  });

  it('répond au préflight CORS pour une requête JSON cross-origin', async () => {
    const res = await app.inject({
      method: 'OPTIONS',
      url: HEARTBEAT_URL,
      headers: {
        origin: 'https://client.example',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('limite à 30 par minute et par IP+slug, toujours en 204', async () => {
    for (let i = 0; i < 35; i++) {
      const res = await app.inject({
        method: 'POST',
        url: HEARTBEAT_URL,
        headers: { 'content-type': 'text/plain' },
        payload: JSON.stringify(heartbeat({ slug: 'rate-x', origin: `https://rate-${i}.fr` })),
      });
      expect(res.statusCode).toBe(204);
    }
    const writes = vi
      .mocked(redisCache.hset)
      .mock.calls.filter(([key]) => key === 'embed:heartbeat:rest-rate');
    expect(writes).toHaveLength(30);
  });
});

describe('dashboard website-check', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    store.hashes.clear();
    mockRestaurants();
    app = await getApp();
    // Le contexte d'authentification de test est le restaurant `test-rest-1`.
    store.hashes.set(
      'embed:heartbeat:test-rest-1',
      new Map([
        [
          'https://chez-x.fr',
          JSON.stringify({
            at: '2026-11-16T10:00:00.000Z',
            version: '1.2.0',
            mode: 'inline',
            buttons: 2,
          }),
        ],
        [
          'https://old.chez-x.fr',
          JSON.stringify({
            at: '2026-11-01T10:00:00.000Z',
            version: '1.1.0',
            mode: 'modal',
            buttons: 1,
          }),
        ],
      ]),
    );
  });

  it('refuse sans authentification', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/website-check',
      payload: { url: 'https://chez-x.fr' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('renvoie blocked et les heartbeats même si le site est une IP privée', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/website-check',
      headers: AUTH,
      payload: { url: 'http://169.254.169.254/' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      url: 'http://169.254.169.254/',
      platform: 'unknown',
      providers: [],
      bookingLinks: [],
      scriptFound: false,
      slugMatches: null,
      framingBlocked: null,
      fetchError: 'blocked',
    });
    expect(body.heartbeats.map((h: { origin: string }) => h.origin)).toEqual([
      'https://chez-x.fr',
      'https://old.chez-x.fr',
    ]);
  });

  it('signale invalid_url pour un schéma interdit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/website-check',
      headers: AUTH,
      payload: { url: 'ftp://chez-x.fr' },
    });
    expect(res.json().fetchError).toBe('invalid_url');
  });

  it('refuse un corps sans url', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/website-check',
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET heartbeats renvoie seulement les signaux du restaurant', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/website-check/heartbeats',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json())).toEqual(['heartbeats']);
    expect(res.json().heartbeats).toHaveLength(2);
    expect(res.json().heartbeats[0]).toEqual({
      origin: 'https://chez-x.fr',
      at: '2026-11-16T10:00:00.000Z',
      version: '1.2.0',
      mode: 'inline',
      buttons: 2,
    });
  });
});
