import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';

vi.mock('@sentry/nextjs', () => ({ init: vi.fn(), captureRouterTransitionStart: vi.fn() }));

async function loadClient(path: string) {
  window.history.replaceState(null, '', path);
  vi.resetModules();
  await import('../instrumentation-client');
  return vi.mocked(Sentry.init).mock.calls.at(-1)?.[0];
}

describe('Sentry navigateur du dashboard', () => {
  beforeEach(() => {
    vi.mocked(Sentry.init).mockClear();
    vi.stubEnv('NEXT_PUBLIC_SENTRY_DSN', 'https://cle@o1.ingest.de.sentry.io/1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('envoie l’environnement baké au build et reste actif sur une page ordinaire', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_ENVIRONMENT', 'staging');
    const options = await loadClient('/dashboard');
    expect(options).toMatchObject({ enabled: true, environment: 'staging' });
  });

  it('retombe sur NODE_ENV quand NEXT_PUBLIC_SENTRY_ENVIRONMENT est absent', async () => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_ENVIRONMENT', undefined);
    const options = await loadClient('/dashboard');
    expect(options?.environment).toBe(process.env.NODE_ENV);
  });

  it.each(['/r', '/r/', '/r/demo'])('désactive le SDK sur la page privée %s', async (path) => {
    vi.stubEnv('NEXT_PUBLIC_SENTRY_ENVIRONMENT', 'staging');
    const options = await loadClient(`${path}#fragment-prive`);
    expect(options).toMatchObject({ enabled: false });
  });
});
