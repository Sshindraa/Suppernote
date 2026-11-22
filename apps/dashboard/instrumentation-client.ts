/**
 * Next.js 15 client instrumentation — Sentry init for browser.
 *
 * Replaces sentry.client.config.ts.
 * Next.js calls this on the client side.
 */
import * as Sentry from '@sentry/nextjs';

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN;
// Personal reservation links contain a bearer credential in the URL fragment.
const privateReservationPage =
  typeof window !== 'undefined' && /^\/r(?:\/demo)?\/?$/.test(window.location.pathname);
if (!dsn) {
  // eslint-disable-next-line no-console
  console.warn('[Sentry] NEXT_PUBLIC_SENTRY_DSN is not set; Sentry is disabled.');
}

Sentry.init({
  enabled: !privateReservationPage,
  dsn,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE ?? process.env.SENTRY_RELEASE ?? undefined,
  // Performance: 100% in dev, 10% in production (adjust via env for incidents).
  tracesSampleRate: parseFloat(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
  // Error sample rate (can be dropped to 0 to silence Sentry during incidents).
  sampleRate: parseFloat(process.env.NEXT_PUBLIC_SENTRY_SAMPLE_RATE ?? '1.0'),
  // Replay: disabled by default to avoid collecting PII from restaurant dashboards.
  // Enable explicitly via env if needed for specific debugging sessions.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: parseFloat(
    process.env.NEXT_PUBLIC_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? '0',
  ),
  debug: false,
});
