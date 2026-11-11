// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));

vi.mock('@clerk/nextjs/server', () => ({
  clerkMiddleware: (handler: (auth: unknown, req: NextRequest) => unknown) => (req: NextRequest) =>
    handler(auth, req),
  createRouteMatcher: (patterns: string[]) => (req: NextRequest) =>
    patterns.some((pattern) => {
      const prefix = pattern.replace('(.*)', '');
      return pattern.endsWith('(.*)')
        ? req.nextUrl.pathname.startsWith(prefix)
        : req.nextUrl.pathname === prefix;
    }),
}));

async function runProxy(path: string) {
  const { default: proxy } = await import('./proxy');
  return proxy(new NextRequest(`https://dashboard.test${path}`), {} as never);
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('CI', '');
  // The SDK is mocked: this marker only selects the configured-auth branch.
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '1');
  vi.stubEnv('NEXT_PUBLIC_DEMO_RESTAURANT_ID', '');
  vi.stubEnv('NEXT_PUBLIC_DEMO_STAGING', '');
  auth.mockReset().mockResolvedValue({ userId: null });
});

afterEach(() => vi.unstubAllEnvs());

describe('Next proxy — protection Clerk', () => {
  it.each(['/dashboard', '/onboarding', '/admin', '/dashboard/admin/margin'])(
    'redirige %s vers la connexion sans session',
    async (path) => {
      const response = await runProxy(path);
      expect(response?.headers.get('location')).toBe('https://dashboard.test/login');
    },
  );

  it('laisse passer une session restaurant authentifiée', async () => {
    auth.mockResolvedValue({ userId: 'user_test' });
    expect(await runProxy('/dashboard')).toBeUndefined();
    expect(auth).toHaveBeenCalledOnce();
  });

  it('redirige une ancienne URL opérateur après authentification', async () => {
    auth.mockResolvedValue({ userId: 'user_test' });
    const response = await runProxy('/dashboard/admin/margin');
    expect(response?.headers.get('location')).toBe('https://dashboard.test/admin/margin');
  });

  it('garde les pages publiques accessibles sans session', async () => {
    expect(await runProxy('/login')).toBeUndefined();
    expect(auth).not.toHaveBeenCalled();
  });

  it('ne contourne pas la session opérateur en démo staging', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_RESTAURANT_ID', 'demo');
    vi.stubEnv('NEXT_PUBLIC_DEMO_STAGING', 'true');
    expect(await runProxy('/dashboard')).toBeUndefined();
    const response = await runProxy('/admin');
    expect(response?.headers.get('location')).toBe('https://dashboard.test/login');
  });

  it('réécrit le lien court de réservation en gardant le nouveau slug', async () => {
    const response = await runProxy('/book/chez-suppernote-demo?date=2026-11-04');
    expect(response?.headers.get('x-middleware-rewrite')).toBe(
      'https://dashboard.test/widget/chez-suppernote-demo?date=2026-11-04',
    );
    expect(auth).not.toHaveBeenCalled();
  });

  it.each(['/widget/chez-suppernote-demo', '/widget/chez-sokar-demo'])(
    'laisse le widget %s interroger son slug directement',
    async (path) => {
      const response = await runProxy(path);
      expect(response?.headers.get('x-middleware-rewrite')).toBeNull();
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it('conserve la réécriture publique de réservation et ses paramètres', async () => {
    const response = await runProxy('/book/chez-sokar?date=2026-10-20');
    expect(response?.headers.get('x-middleware-rewrite')).toBe(
      'https://dashboard.test/widget/chez-sokar?date=2026-10-20',
    );
    expect(auth).not.toHaveBeenCalled();
  });

  it.each([
    '/widget/chez-sokar',
    '/api/proxy/public/r/chez-sokar/hold',
    '/api/proxy/marketing/attribution/click',
    '/api/proxy/restaurants/r1/availability',
  ])('sert %s sans passer par Clerk (sous-domaines des restaurants)', async (path) => {
    const response = await runProxy(path);
    // Réponse « next » du chemin sans Clerk ; le chemin Clerk répondrait undefined ici.
    expect(response?.headers.get('x-middleware-next')).toBe('1');
  });

  it.each(['/widget/chez-sokar/admin', '/api/proxy/customers', '/api/proxy/restaurants/r1'])(
    'garde Clerk pour %s, hors de la liste publique du widget',
    async (path) => {
      expect(await runProxy(path)).toBeUndefined();
    },
  );

  it('refuse un démarrage production sans configuration Clerk', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', '');
    await expect(import('./proxy')).rejects.toThrow('manquant en production');
  });
});
