import * as Sentry from '@sentry/node';

/**
 * Centralized Sentry client for the Suppernote API.
 *
 * Why a wrapper?
 *
 * 1. **Single init point**: Sentry must be initialized *before* the Fastify
 *    app is built so that route handlers and the global error handler are
 *    instrumented. Calling `Sentry.init` inside `start()` (after `buildApp()`)
 *    is too late.
 *
 * 2. **No-op when DSN is absent**: dev/test environments don't need a DSN.
 *    The helper functions below silently do nothing when Sentry is disabled,
 *    so callers never have to guard with `if (process.env.SENTRY_DSN)`.
 *
 * 3. **Consistent tags/context**: every event carries `service: api`,
 *    the environment, and the release.
 */

let isInitialized = false;

/**
 * Reset the internal init flag. **Test only.**
 */
export function __resetSentryForTests(): void {
  isInitialized = false;
}

function getRelease(): string | undefined {
  return (
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_COMMIT_SHA ??
    undefined
  );
}

/**
 * Initialize Sentry. Safe to call multiple times (subsequent calls are no-ops).
 * Should be called as early as possible in the process lifecycle.
 */
export function initSentry(): void {
  if (isInitialized) return;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    // Sentry is opt-in via env var. In dev/test this is expected.
    isInitialized = true;
    return;
  }

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    release: getRelease(),
    // Performance: sample 100% of transactions in dev, 10% in production.
    // Override via env var for incidents or gradual rollouts.
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE ?? '0.1'),
    // Error events: always send errors, but allow killing the pipe via
    // SENTRY_SAMPLE_RATE if Sentry itself becomes noisy.
    sampleRate: parseFloat(process.env.SENTRY_SAMPLE_RATE ?? '1.0'),
    // Filter out common client errors that we handle gracefully.
    beforeSend(event) {
      // Drop 4xx client errors unless they are unexpected (e.g. 429 from a
      // provider might be interesting, but 400 validation errors are not).
      const status = event.contexts?.response?.status_code as number | undefined;
      if (status && status >= 400 && status < 500) {
        return null;
      }
      return event;
    },
  });

  isInitialized = true;
}

/**
 * Is Sentry enabled for this process?
 */
export function sentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

/**
 * Report an exception to Sentry (no-op if Sentry is not configured).
 */
export function captureException(
  err: unknown,
  context?: {
    extra?: Record<string, unknown>;
    tags?: Record<string, string | number | boolean | undefined>;
  },
): void {
  if (!sentryEnabled()) return;

  // Drop undefined tag values so Sentry doesn't reject the event.
  const tags: Record<string, string | number | boolean> = {};
  if (context?.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      if (value !== undefined) {
        tags[key] = value;
      }
    }
  }

  Sentry.captureException(err, {
    extra: context?.extra,
    tags: {
      service: 'api',
      ...tags,
    },
  });
}

/**
 * Report a message to Sentry (no-op if Sentry is not configured).
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = 'info',
  context?: {
    extra?: Record<string, unknown>;
    tags?: Record<string, string | number | boolean | undefined>;
  },
): void {
  if (!sentryEnabled()) return;

  const tags: Record<string, string | number | boolean> = {};
  if (context?.tags) {
    for (const [key, value] of Object.entries(context.tags)) {
      if (value !== undefined) {
        tags[key] = value;
      }
    }
  }

  Sentry.captureMessage(message, {
    level,
    extra: context?.extra,
    tags: {
      service: 'api',
      ...tags,
    },
  });
}

/**
 * Flush pending Sentry events. Call during graceful shutdown.
 */
export async function closeSentry(timeoutMs = 2000): Promise<void> {
  if (!sentryEnabled()) return;

  await Sentry.close(timeoutMs);
}

// Re-export the raw SDK for advanced use cases (scopes, transactions, etc.).
export { Sentry };
