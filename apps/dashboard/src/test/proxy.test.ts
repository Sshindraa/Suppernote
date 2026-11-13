import { describe, it, expect, vi } from 'vitest';
import { auth } from '@clerk/nextjs/server';
import { authenticatedHeaders, forwardedHeaders } from '../app/api/proxy/forwarded-headers';

vi.mock('@clerk/nextjs/server', () => ({
  auth: vi.fn(),
}));

/**
 * Garde-fou non-régression : le proxy Next.js /api/proxy/* doit forwarder
 * X-Forwarded-For vers l'API afin que le rate-limit global Fastify s'applique
 * par IP cliente réelle (et non par 127.0.0.1, le proxy local).
 *
 * Contexte (juillet 2026) : toutes les requêtes dashboard passaient par le
 * proxy Next.js et étaient rate-limitées comme venant de 127.0.0.1 (100 req/min
 * partagées entre tous les utilisateurs → 429 en boucle). Le fix : forwarder
 * X-Forwarded-For + activer trustProxy côté API.
 */
function mockReq(
  headers: Record<string, string>,
  url = 'https://dashboard.test/api/proxy/restaurants/sites',
) {
  return {
    nextUrl: new URL(url),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  } as unknown as Parameters<typeof forwardedHeaders>[0];
}

describe('forwardedHeaders — proxy Next.js', () => {
  it("forward X-Forwarded-For vers l'API", () => {
    const headers = forwardedHeaders(mockReq({ 'x-forwarded-for': '203.0.113.7' }));
    expect(headers['X-Forwarded-For']).toBe('203.0.113.7');
  });

  it('forward X-Request-ID pour le tracing end-to-end', () => {
    const headers = forwardedHeaders(mockReq({ 'x-request-id': 'req-abc-123' }));
    expect(headers['X-Request-ID']).toBe('req-abc-123');
  });

  it('forward le site actif vers le resolver API', () => {
    const headers = forwardedHeaders(mockReq({ 'x-sokar-site-id': 'site_123' }));
    expect(headers['X-Suppernote-Site-ID']).toBe('site_123');
  });

  it('forward le site actif passé par un lecteur audio sans header custom', () => {
    const headers = forwardedHeaders(
      mockReq({}, 'https://dashboard.test/api/proxy/calls/c1/recording?siteId=site_123'),
    );
    expect(headers['X-Suppernote-Site-ID']).toBe('site_123');
  });

  it("forward le cookie Clerk pour l'authentification", () => {
    const headers = forwardedHeaders(mockReq({ cookie: '__session=clerk-session-token' }));
    expect(headers.Cookie).toBe('__session=clerk-session-token');
  });

  it('forwarde une autorisation déjà fournie par un appelant', () => {
    const headers = forwardedHeaders(mockReq({ authorization: 'Bearer clerk-session-token' }));
    expect(headers.Authorization).toBe('Bearer clerk-session-token');
  });

  it('privilégie le Bearer Clerk et retire le cookie de handshake', async () => {
    const getToken = vi.fn().mockResolvedValue('server-session-token');
    vi.mocked(auth).mockResolvedValue({ getToken } as never);

    const headers = await authenticatedHeaders(mockReq({ cookie: '__clerk_handshake=truncated' }));

    expect(headers.Authorization).toBe('Bearer server-session-token');
    expect(headers.Cookie).toBeUndefined();
    expect(getToken).toHaveBeenCalledOnce();
  });

  it('forward Range pour permettre la lecture et la navigation audio', () => {
    const headers = forwardedHeaders(mockReq({ range: 'bytes=100-499' }));
    expect(headers.Range).toBe('bytes=100-499');
  });

  it('forward Idempotency-Key pour les mutations rejouables', () => {
    const headers = forwardedHeaders(mockReq({ 'idempotency-key': 'merge-123' }));
    expect(headers['Idempotency-Key']).toBe('merge-123');
  });

  it("forward X-Identity-Token : sans lui l'export RGPD d'un client échoue toujours", () => {
    const headers = forwardedHeaders(mockReq({ 'x-identity-token': 'jeton-verifie' }));
    expect(headers['X-Identity-Token']).toBe('jeton-verifie');
  });

  it('omet les headers absents (pas de valeur vide)', () => {
    const headers = forwardedHeaders(mockReq({}));
    expect(headers).toEqual({});
  });

  it('forward tous les headers simultanément', () => {
    const headers = forwardedHeaders(
      mockReq({
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
        'x-request-id': 'req-xyz',
        'x-suppernote-site-id': 'site_123',
        'idempotency-key': 'merge-123',
        cookie: '__session=tok',
      }),
    );
    expect(headers).toEqual({
      'X-Forwarded-For': '203.0.113.7, 10.0.0.1',
      'X-Request-ID': 'req-xyz',
      'X-Suppernote-Site-ID': 'site_123',
      'Idempotency-Key': 'merge-123',
      Cookie: '__session=tok',
    });
  });
});
