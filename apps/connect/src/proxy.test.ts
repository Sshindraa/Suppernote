/**
 * Tests unitaires pour le proxy Connect.
 *
 * Vérifie la politique de framing : /widget/* doit pouvoir être embarqué
 * dans un iframe cross-origin, le reste du site reste protégé.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { proxy } from './proxy';

function makeNextUrl(href: string): URL {
  const url = new URL(href);
  // NextURL exposes a .clone() method that plain URL lacks — needed for rewrite paths.
  (url as unknown as { clone: () => URL }).clone = () => makeNextUrl(url.href);
  return url;
}

function makeRequest(
  pathname: string,
  options: {
    userAgent?: string;
    preview?: string;
    host?: string;
    search?: Record<string, string>;
  } = {},
): Parameters<typeof proxy>[0] {
  const origin = options.host ? `https://${options.host}` : 'https://suppernote.com';
  const url = new URL(pathname, origin);
  if (options.preview) url.searchParams.set('preview', options.preview);
  Object.entries(options.search ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const nextUrl = makeNextUrl(url.href);
  const headers = new Headers({ 'user-agent': options.userAgent ?? 'Mozilla/5.0' });
  if (options.host) headers.set('host', options.host);
  return {
    nextUrl,
    headers,
    method: 'GET',
  } as unknown as Parameters<typeof proxy>[0];
}

function getCspFrameAncestors(response: ReturnType<typeof proxy>): string | null {
  const csp = response.headers.get('Content-Security-Policy');
  if (!csp) return null;
  const match = csp.match(/frame-ancestors ([^;]+)/);
  return match ? match[1] : null;
}

function getCsp(response: ReturnType<typeof proxy>): string | null {
  return response.headers.get('Content-Security-Policy');
}

describe('proxy framing policy', () => {
  it.each([
    ['/restaurant', "'none'"],
    ['/widget', '*'],
  ])(
    'laisse le slug Suppernote %s être résolu par l’API sans réécriture externe',
    (prefix, framing) => {
      const response = proxy(makeRequest(`${prefix}/chez-suppernote-demo?date=2026-11-04`));
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
      expect(response.headers.get('x-middleware-next')).toBe('1');
      expect(getCspFrameAncestors(response)).toBe(framing);
    },
  );

  it('denies framing by default', () => {
    const response = proxy(makeRequest('/restaurant/chez-sokar-demo'));
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(getCspFrameAncestors(response)).toBe("'none'");
  });

  it('allows framing on /widget/* from any origin without X-Frame-Options', () => {
    const response = proxy(makeRequest('/widget/chez-sokar-demo'));
    expect(response.headers.get('X-Frame-Options')).toBeNull();
    expect(getCspFrameAncestors(response)).toBe('*');
  });

  it('keeps preview framing restricted to dashboard origin', () => {
    const previousDashboardUrl = process.env.DASHBOARD_URL;
    process.env.DASHBOARD_URL = 'http://localhost:3000';

    try {
      const response = proxy(makeRequest('/restaurant/chez-sokar-demo', { preview: '1' }));
      expect(response.headers.get('X-Frame-Options')).toBeNull();
      expect(getCspFrameAncestors(response)).toBe("'self' http://localhost:3000");
    } finally {
      if (previousDashboardUrl === undefined) delete process.env.DASHBOARD_URL;
      else process.env.DASHBOARD_URL = previousDashboardUrl;
    }
  });

  it('allows browser calls to the configured public API origin', () => {
    const previousApiUrl = process.env.API_URL;
    const previousPublicApiUrl = process.env.NEXT_PUBLIC_API_URL;
    process.env.API_URL = 'http://internal-api:4000';
    process.env.NEXT_PUBLIC_API_URL = 'https://api.suppernote.example';

    try {
      const response = proxy(makeRequest('/widget/chez-sokar-demo'));
      expect(getCsp(response)).toContain("connect-src 'self' https://api.suppernote.example");
    } finally {
      if (previousApiUrl === undefined) delete process.env.API_URL;
      else process.env.API_URL = previousApiUrl;
      if (previousPublicApiUrl === undefined) delete process.env.NEXT_PUBLIC_API_URL;
      else process.env.NEXT_PUBLIC_API_URL = previousPublicApiUrl;
    }
  });

  it('allows Stripe.js and its payment frames', () => {
    const response = proxy(makeRequest('/widget/chez-sokar-demo/gift-card'));
    const csp = getCsp(response);

    expect(csp).toContain('script-src');
    expect(csp).toContain('https://js.stripe.com');
    expect(csp).toContain('connect-src');
    expect(csp).toContain('https://api.stripe.com');
    expect(csp).toContain("frame-src 'self' https://js.stripe.com https://hooks.stripe.com");
  });

  it('allows Next dev eval only in development', () => {
    const env = process.env as Record<string, string | undefined>;
    const previousNodeEnv = env.NODE_ENV;
    env.NODE_ENV = 'development';

    try {
      const devResponse = proxy(makeRequest('/widget/chez-sokar-demo'));
      expect(getCsp(devResponse)).toContain("script-src 'self'");
      expect(getCsp(devResponse)).toContain("'unsafe-eval'");

      env.NODE_ENV = 'production';
      const productionResponse = proxy(makeRequest('/widget/chez-sokar-demo'));
      expect(getCsp(productionResponse)).not.toContain("'unsafe-eval'");
    } finally {
      if (previousNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = previousNodeEnv;
    }
  });
});

describe('proxy subdomain routing (*.suppernote.com)', () => {
  // Le custom domain flow nécessite API_URL pour déclencher le rewrite.
  let originalApiUrl: string | undefined;
  beforeAll(() => {
    originalApiUrl = process.env.API_URL;
    process.env.API_URL = 'http://localhost:4000';
  });
  afterAll(() => {
    if (originalApiUrl === undefined) delete process.env.API_URL;
    else process.env.API_URL = originalApiUrl;
  });

  it('rewrites chezmario.suppernote.com to /restaurant/chezmario', () => {
    const response = proxy(makeRequest('/', { host: 'chezmario.suppernote.com' }));
    // NextResponse.rewrite returns a response whose .headers includes the rewritten URL
    // in the `x-middleware-rewrite` header (Next.js internal).
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'http://chezmario.suppernote.com/restaurant/chezmario',
    );
  });

  it('does not rewrite www.suppernote.com (primary host)', () => {
    const response = proxy(makeRequest('/', { host: 'www.suppernote.com' }));
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('does not rewrite suppernote.com (primary host)', () => {
    const response = proxy(makeRequest('/', { host: 'suppernote.com' }));
    expect(response.headers.get('x-middleware-rewrite')).toBeNull();
  });

  it('rewrites custom domain reserve.chezmario.fr to /custom-domain', () => {
    const response = proxy(makeRequest('/', { host: 'reserve.chezmario.fr' }));
    const rewrite = response.headers.get('x-middleware-rewrite');
    expect(rewrite).toContain('/custom-domain');
    expect(rewrite).toContain('host=reserve.chezmario.fr');
  });

  it('does not rewrite to /restaurant/ when slug is empty (host === .suppernote.com)', () => {
    // host = ".suppernote.com" → slug would be empty → no subdomain rewrite.
    // Falls through to custom-domain flow (not a /restaurant/ rewrite).
    const response = proxy(makeRequest('/', { host: '.suppernote.com' }));
    const rewrite = response.headers.get('x-middleware-rewrite');
    // Soit pas de rewrite, soit un rewrite vers /custom-domain (jamais /restaurant/).
    if (rewrite) {
      expect(rewrite).not.toContain('/restaurant/');
    }
  });

  it('rewrites multi-dot subdomain foo.bar.suppernote.com to /restaurant/foo.bar', () => {
    // Le slug est tout ce qui précède .suppernote.com, y compris les dots internes.
    // foo.bar.suppernote.com → slug = "foo.bar" → /restaurant/foo.bar
    // Comportement documenté : on accepte les dots dans le slug (pas de validation
    // de format ici — la page /restaurant/[slug] retournera notFound() si invalide).
    const response = proxy(makeRequest('/', { host: 'foo.bar.suppernote.com' }));
    expect(response.headers.get('x-middleware-rewrite')).toBe(
      'http://foo.bar.suppernote.com/restaurant/foo.bar',
    );
  });

  it('handles uppercase subdomain (browsers lowercase the host, but test the edge)', () => {
    // Les navigateurs lowercaset le host avant l'envoi. Si un client envoie
    // quand même un host en majuscules (ex: CHEZMARIO.suppernote.com), le proxy
    // match car endsWith('.suppernote.com') est sensible à la casse mais le suffixe
    // .suppernote.com reste en minuscules. Le slug est préservé en majuscules dans
    // la rewrite — la page /restaurant/[slug] retournera notFound() car les slugs
    // en DB sont lowercase. Comportement documenté : pas de normalisation de casse
    // dans le proxy (Edge), la validation se fait côté page.
    const response = proxy(makeRequest('/', { host: 'CHEZMARIO.suppernote.com' }));
    const rewrite = response.headers.get('x-middleware-rewrite');
    expect(rewrite).toContain('/restaurant/CHEZMARIO');
  });
});

describe('privacy CSP bootstrap', () => {
  it('forwards the response nonce to Next rendering through the request CSP', () => {
    const first = proxy(makeRequest('/privacy'));
    const second = proxy(makeRequest('/privacy'));
    const nonce = first.headers.get('x-middleware-request-x-nonce');
    expect(nonce).toBeTruthy();
    expect(first.headers.get('x-middleware-request-content-security-policy')).toBe(
      `script-src 'nonce-${nonce}'`,
    );
    expect(getCsp(first)).toContain(`'nonce-${nonce}'`);
    expect(getCsp(first)).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(second.headers.get('x-middleware-request-x-nonce')).not.toBe(nonce);
  });

  it('does not change the request policy of other routes', () => {
    const response = proxy(makeRequest('/restaurant/chez-sokar-demo'));
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBeNull();
  });
});
