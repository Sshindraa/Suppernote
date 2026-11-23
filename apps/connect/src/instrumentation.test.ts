import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/nextjs';

vi.mock('@sentry/nextjs', () => ({ init: vi.fn(), captureRequestError: vi.fn() }));

describe('instrumentation Connect', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(Sentry.init).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each(['nodejs', 'edge'])(
    'charge la config serveur Sentry sur le runtime %s',
    async (runtime) => {
      vi.stubEnv('NEXT_RUNTIME', runtime);
      vi.stubEnv('SENTRY_DSN', 'https://cle@o1.ingest.de.sentry.io/1');
      vi.stubEnv('SENTRY_ENVIRONMENT', 'staging');
      const { register } = await import('./instrumentation');
      await register();
      expect(Sentry.init).toHaveBeenCalledTimes(1);
      expect(Sentry.init).toHaveBeenCalledWith(
        expect.objectContaining({
          dsn: 'https://cle@o1.ingest.de.sentry.io/1',
          environment: 'staging',
        }),
      );
    },
  );

  it('ne charge rien hors des runtimes serveur', async () => {
    vi.stubEnv('NEXT_RUNTIME', '');
    const { register } = await import('./instrumentation');
    await register();
    expect(Sentry.init).not.toHaveBeenCalled();
  });

  it('remonte les erreurs de requête à Sentry', async () => {
    const { onRequestError } = await import('./instrumentation');
    expect(onRequestError).toBe(Sentry.captureRequestError);
  });
});
