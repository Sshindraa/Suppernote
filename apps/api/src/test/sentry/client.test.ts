/**
 * Tests for the centralized Sentry client.
 *
 * We mock the underlying @sentry/node SDK so these tests don't need a real
 * Sentry DSN and run offline in any environment.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  close: vi.fn(),
}));

// Import after the mock is registered.
import * as Sentry from '@sentry/node';
import {
  initSentry,
  captureException,
  captureMessage,
  closeSentry,
  sentryEnabled,
  __resetSentryForTests,
} from '../../../src/shared/sentry/client';

const mockInit = vi.mocked(Sentry.init);
const mockCaptureException = vi.mocked(Sentry.captureException);
const mockCaptureMessage = vi.mocked(Sentry.captureMessage);
const mockClose = vi.mocked(Sentry.close);

describe('sentry client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    __resetSentryForTests();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not call Sentry.init when SENTRY_DSN is missing', () => {
    delete process.env.SENTRY_DSN;
    initSentry();
    expect(mockInit).not.toHaveBeenCalled();
    expect(sentryEnabled()).toBe(false);
  });

  it('prefers SENTRY_ENVIRONMENT over NODE_ENV (staging runs with NODE_ENV=production)', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_ENVIRONMENT = 'staging';

    initSentry();

    expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ environment: 'staging' }));
  });

  it('falls back to NODE_ENV when SENTRY_ENVIRONMENT is unset', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.NODE_ENV = 'production';
    delete process.env.SENTRY_ENVIRONMENT;

    initSentry();

    expect(mockInit).toHaveBeenCalledWith(expect.objectContaining({ environment: 'production' }));
  });

  it('calls Sentry.init with the DSN and environment', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.NODE_ENV = 'production';
    process.env.SENTRY_RELEASE = 'v1.2.3';

    initSentry();

    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: 'https://test@sentry.io/1',
        environment: 'production',
        release: 'v1.2.3',
      }),
    );
    expect(sentryEnabled()).toBe(true);
  });

  it('uses env-driven sample rates', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    process.env.SENTRY_TRACES_SAMPLE_RATE = '0.5';
    process.env.SENTRY_SAMPLE_RATE = '0.25';

    initSentry();

    expect(mockInit).toHaveBeenCalledWith(
      expect.objectContaining({
        tracesSampleRate: 0.5,
        sampleRate: 0.25,
      }),
    );
  });

  it('captureException is a no-op when Sentry is disabled', () => {
    delete process.env.SENTRY_DSN;
    captureException(new Error('boom'));
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('captureException forwards to Sentry when enabled', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    const err = new Error('boom');

    captureException(err, { extra: { foo: 'bar' }, tags: { route: '/test' } });

    expect(mockCaptureException).toHaveBeenCalledWith(err, {
      extra: { foo: 'bar' },
      tags: { service: 'api', route: '/test' },
    });
  });

  it('captureMessage forwards to Sentry when enabled', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';

    captureMessage('something happened', 'warning', { tags: { area: 'voice' } });

    expect(mockCaptureMessage).toHaveBeenCalledWith('something happened', {
      level: 'warning',
      extra: undefined,
      tags: { service: 'api', area: 'voice' },
    });
  });

  it('closeSentry calls Sentry.close when enabled', async () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    await closeSentry(1000);
    expect(mockClose).toHaveBeenCalledWith(1000);
  });

  it('closeSentry is a no-op when disabled', async () => {
    delete process.env.SENTRY_DSN;
    await closeSentry();
    expect(mockClose).not.toHaveBeenCalled();
  });

  it('drops 4xx client errors via beforeSend', () => {
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    initSentry();

    const options = mockInit.mock.calls[0][0] as {
      beforeSend?: (event: Sentry.Event) => Sentry.Event | null;
    };
    expect(options.beforeSend).toBeDefined();

    const event400 = { contexts: { response: { status_code: 400 } } };
    expect(options.beforeSend!(event400)).toBeNull();

    const event500 = { contexts: { response: { status_code: 500 } } };
    expect(options.beforeSend!(event500)).toEqual(event500);
  });
});
