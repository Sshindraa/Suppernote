import pino, { type Logger, type LoggerOptions } from 'pino';
import { randomUUID } from 'node:crypto';

const isDev = process.env.NODE_ENV !== 'production';

export const REDACT_CENSOR = '[REDACTED]';

export function safeRequestUrl(url: string | undefined): string | undefined {
  return url?.startsWith('/voice/stream/') ||
    url?.startsWith('/api/rgpd/confirm-link') ||
    url?.startsWith('/sms/brevo/events')
    ? url.split('?')[0]
    : url;
}

/**
 * Centralised redaction paths for every Pino logger instance (worker logger
 * and Fastify request logger). Keep this list in sync with the env vars that
 * can contain secrets or PII.
 *
 * Patterns with `*` match any key named exactly like the suffix at any depth.
 * Concrete `env.X` paths match when the `env` object is logged.
 */
export const REDACT_PATHS = [
  // HTTP headers
  'req.headers.authorization',
  'req.headers.cookie',

  // Generic secret-like keys
  '*.password',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.holdToken',

  // PII
  'phone',
  '*.phone',
  'phoneNumber',
  '*.phoneNumber',
  'phone_number',
  '*.phone_number',
  'callerPhone',
  '*.callerPhone',
  'caller_phone',
  '*.caller_phone',
  'customerPhone',
  '*.customerPhone',
  'customer_phone',
  '*.customer_phone',
  'customerPhoneNormalized',
  '*.customerPhoneNormalized',
  'targetPhone',
  '*.targetPhone',
  'targetPhoneNumber',
  '*.targetPhoneNumber',
  'msisdn',
  '*.msisdn',
  // Provider payloads use generic `from`/`to` keys for phone numbers. These
  // names are redacted centrally so a new webhook log cannot leak a caller by
  // accident. State-machine logs use fromState/toState instead.
  'from',
  '*.from',
  'to',
  '*.to',
  'email',
  '*.email',
  'customerEmail',
  '*.customerEmail',

  // Application env vars that contain secrets (used when `env` is logged)
  'env.SENTRY_DSN',
  'env.CLERK_SECRET_KEY',
  'env.CARTESIA_API_KEY',
  'env.TELNYX_API_KEY',
  'env.TELNYX_PUBLIC_KEY',
  'env.TELNYX_WEBHOOK_SECRET',
  'env.GOOGLE_PLACES_API_KEY',
  'env.STRIPE_SECRET_KEY',
  'env.STRIPE_WEBHOOK_SECRET',
  'env.RESEND_API_KEY',
  'env.DATABASE_URL',
  'env.REDIS_URL',
  'env.METRICS_BASIC_AUTH_PASSWORD',
  'env.AGENT_DEV_KEY',
  'env.OPENAI_RESERVE_HMAC_KEY',
  'env.SERVICE_COPILOT_TELEMETRY_SECRET',
  'env.ELEVENLABS_API_KEY',
  'env.CONFIGCAT_SDK_KEY',
];

/**
 * Base Pino logger for the Suppernote API.
 *
 * Conventions:
 * - Every log line is a single JSON object in production (PM2 / log shippers
 *   parse it as-is) and a pretty-printed colorized line in dev.
 * - We never log secrets, PII, or full payloads — only correlation IDs
 *   (request_id, restaurant_id, call_id) and the actual error.
 * - Levels: `debug` (dev only) / `info` (state transitions, business events)
 *   / `warn` (handled 4xx, recoverable errors) / `error` (unhandled 5xx).
 *
 * Context propagation:
 * - For HTTP requests: `request.log` is a child of this logger, enriched
 *   with `request_id` by the onRequest hook in main.ts.
 * - For WebSocket voice sessions: the voice handler creates a child logger
 *   with `call_id` and reuses it for every event in the call's lifecycle.
 * - For BullMQ workers: the worker wraps its handler in a child logger
 *   enriched with `queue` and `job_id`.
 *
 * Helper: `withContext()` returns a child logger with extra bindings.
 * This is the only sanctioned way to add context — avoids accidentally
 * shadowing fields that Pino auto-injects (level, time, pid, hostname).
 */
const baseOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
  base: {
    service: 'sokar-api',
    env: process.env.NODE_ENV ?? 'development',
  },
  redact: {
    paths: REDACT_PATHS,
    censor: REDACT_CENSOR,
  },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: () => `,"time":"${new Date().toISOString()}"`,
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
    : undefined,
};

export const logger: Logger = pino(baseOptions);

/**
 * Returns a new logger with the given bindings merged into the base context.
 * Bindings are additive (Pino child loggers don't override parent bindings
 * unless you pass the same key).
 *
 * @example
 *   const log = withContext(logger, { restaurant_id: 'rest-123' });
 *   log.info({ call_id: 'abc' }, 'incoming call');
 *   // → { service: 'sokar-api', restaurant_id: 'rest-123', call_id: 'abc', msg: 'incoming call' }
 */
export function withContext(parent: Logger, bindings: Record<string, unknown>): Logger {
  return parent.child(bindings);
}

/**
 * Generate a request ID. Used by the Fastify onRequest hook to stamp every
 * incoming HTTP request with a unique correlation ID.
 *
 * Format: 24-char hex prefix of a UUID v4. Short enough to log without
 * dominating the line, long enough to be globally unique within a 24h window
 * for any realistic request volume.
 */
export function newRequestId(): string {
  return randomUUID().split('-')[0];
}
