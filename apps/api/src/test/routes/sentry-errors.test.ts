/**
 * Integration test: verify that unhandled 500s in Fastify routes are reported
 * to Sentry via the centralized client.
 *
 * We mock the Clerk plugin so requests don't get rejected before reaching the
 * test route. The global test setup mocks @sentry/node, so we spy on the SDK's
 * captureException to assert the wiring works end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('@sentry/node', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
  close: vi.fn(),
  setupFastifyErrorHandler: vi.fn(),
}));

vi.mock('../../../src/plugins/clerk', () => ({
  registerClerk: vi.fn().mockResolvedValue(undefined),
  requireOrg: () => async () => undefined,
  requirePlatformOperator: () => async () => undefined,
  requireAuth: () => async () => undefined,
}));

import { buildApp } from '../../../src/main';
import * as Sentry from '@sentry/node';

const mockCaptureException = vi.mocked(Sentry.captureException);

describe('Sentry error reporting integration', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.SENTRY_DSN = 'https://test@sentry.io/1';
    app = await buildApp();
    app.get('/__test_throw', async () => {
      throw new Error('boom in test route');
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reports a thrown 500 error to Sentry', async () => {
    const res = await app.inject({ method: 'GET', url: '/__test_throw' });

    expect(res.statusCode).toBe(500);
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const captured = mockCaptureException.mock.calls[0][0] as Error;
    expect(captured.message).toBe('boom in test route');
  });
});
