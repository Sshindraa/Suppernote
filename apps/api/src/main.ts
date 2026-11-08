import { env } from './env';

import { initSentry, captureException, closeSentry } from './shared/sentry/client';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { setupFastifyErrorHandler } from '@sentry/node';
import { db } from './shared/db/client';
import { redisCache } from './shared/redis/client';
import { queues } from './shared/queue/queues';
import {
  logger,
  newRequestId,
  REDACT_PATHS,
  REDACT_CENSOR,
  safeRequestUrl,
} from './shared/logger/pino';
import { telnyxVoiceRoutes } from './modules/voice/telnyx.pipeline';
import { warmupTelnyxConnection } from './shared/telnyx/http-agent';
import { initGreetingCache } from './modules/voice/stream/greeting-cache';
import { waitForVoiceCallsToEnd } from './modules/voice/stream/shutdown-drain';
import { startCapacitySampler } from './modules/voice/capacity-sampler';
import { startCapacityLimitPublisher } from './modules/voice/call-capacity';
import { initVoiceFillerCache } from './modules/voice/stream/voice-filler';
import { reservationManagementRoutes } from './modules/reservations/reservation-management.routes';
import { smsInboundRoutes } from './modules/sms/sms-inbound.routes';
import { metaWhatsAppWebhookRoutes } from './modules/whatsapp/meta-webhook.routes';
import { whatsappWebhookRoutes } from './modules/whatsapp/whatsapp-webhook.routes';
import { restaurantRoutes } from './modules/restaurants/restaurant.routes';
import { teamRoutes } from './modules/restaurants/team.routes';
import { customerRoutes } from './modules/customers/customer.routes';
import { customerCrmRoutes } from './modules/customers/customer-crm.routes';
import { customerSegmentRoutes } from './modules/customers/customer-segment.routes';
import { marketingRoutes } from './modules/marketing/marketing.routes';
import { marketingProviderRoutes } from './modules/marketing/marketing-provider.routes';
import { analyticsRoutes } from './modules/analytics/analytics.routes';
import { reservationRoutes } from './modules/reservations/reservation.routes';
import { callRoutes } from './modules/calls/call.routes';
import { voiceReadRoutes } from './modules/voice/voice-read.routes';
import { dashboardRoutes } from './modules/dashboard/dashboard.routes';
import { companionRoutes } from './modules/companion/companion.routes';
import { reactivationRoutes } from './modules/dashboard/reactivation.routes';
import { authSyncRoutes } from './modules/auth/auth.routes';
import { testRoutes } from './modules/test/test.routes';
import { agenticAdminRoutes } from './modules/agentic-reservations/admin/admin.routes';
import { mcpRoutes } from './modules/agentic-reservations/mcp/server';
import { genericAgentRoutes } from './modules/agentic-reservations/generic-agent/generic-agent.routes';
import { oauthRoutes } from './modules/agentic-reservations/mcp/oauth';
import { openaiReserveRoutes } from './modules/agentic-reservations/openai-reserve/openai-reserve.routes';
import { rgpdRoutes } from './modules/rgpd/rgpd.routes';
import { observabilityRoutes } from './shared/observability/observability.routes';
import { httpRequestsTotal } from './shared/observability/metrics';
import { connectRoutes } from './modules/connect/connect.routes';
import { floorPlanRoutes } from './modules/floor-plan/floor-plan.routes';
import { giftCardRoutes } from './modules/gift-cards/gift-card.routes';
import { giftCardPackRoutes } from './modules/gift-cards/gift-card-pack.routes';
import { demoRequestRoutes } from './modules/demo-requests/demo-request.routes';
import { billingRoutes } from './modules/billing/billing.routes';
import { entitlementRoutes } from './modules/entitlements/entitlement.routes';
import { usageRoutes } from './modules/usage/usage.routes';
import { pilotRoutes } from './modules/pilot/pilot.routes';
import { flagsRoutes } from './modules/admin/flags.routes';
import { onboardingFunnelRoutes } from './modules/admin/onboarding-funnel.routes';
import { provisioningRoutes } from './modules/admin/provisioning.routes';
import { restaurantHealthRoutes } from './modules/admin/restaurant-health.routes';
import { voiceCapacityRoutes } from './modules/admin/voice-capacity.routes';
import { adminCustomerRepairRoutes } from './modules/admin/customer-repair.routes';
import { posRoutes } from './modules/pos/pos.routes';
import { reservationPaymentRoutes } from './modules/reservation-payments/reservation-payment.routes';
import { customerGroupRoutes } from './modules/customer-groups/customer-group.routes';
import { reputationRoutes } from './modules/reputation/reputation.routes';
import { loyaltyRoutes } from './modules/loyalty/loyalty.routes';
import { experienceRoutes } from './modules/experiences/experience.routes';
import { eventRoutes } from './modules/events/event.routes';
import { distributionRoutes } from './modules/distribution/distribution.routes';
import { registerCors } from './plugins/cors';
import { registerRateLimit } from './plugins/rate-limit';
import { registerClerk } from './plugins/clerk';
import fastifyWebsocket from '@fastify/websocket';
import { registerMediaStreamRoutes } from './modules/voice/stream/handler';
import { registerLiveDemoStreamRoute } from './modules/voice/demo/demo-stream';
import { startWatchtower, startWorkerHeartbeat } from './shared/health/watchtower';
import { checkHealth } from './shared/health/checks';
import { registerJobSchedulers } from './shared/queue/schedulers';

// Initialize Sentry as early as possible so that instrumentation hooks are
// registered before the Fastify app (and its error handler) are built.
initSentry();

export async function buildApp() {
  const isDev = process.env.NODE_ENV !== 'production';

  // Use Fastify's default Pino logger (it already creates a Pino instance
  // with sane defaults). We provide a `childLoggerFactory` so every request's
  // child logger is enriched with `request_id` — and honours an inbound
  // `x-request-id` header for end-to-end correlation across services.
  //
  // Our shared `logger` instance (imported above) is used by the application
  // code (startup, shutdown, workers, etc.). Fastify's request-scoped
  // loggers are children of the Fastify internal Pino instance. They share
  // the same redaction patterns via the options below.
  //
  // The `as never` cast on `logger`: Fastify 5's type inference for the
  // options object narrows the logger type to `never` when a child logger
  // factory is provided. The runtime value is correct (Pino options), this
  // only restores the right type at compile time.
  const trustedProxyIps = env.TRUSTED_PROXY_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const app = Fastify({
    // Nginx et le dashboard Next.js proxy sont les seuls reverse proxies.
    // Nécessaire pour que req.ip reflète le vrai client (X-Forwarded-For)
    // et que le rate-limit global s'applique par utilisateur, pas par 127.0.0.1.
    trustProxy: trustedProxyIps,
    logger: {
      level: process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info'),
      base: { service: 'sokar-api', env: process.env.NODE_ENV ?? 'development' },
      serializers: {
        req(request: {
          method?: string;
          url?: string;
          hostname?: string;
          remoteAddress?: string;
          remotePort?: number;
        }) {
          return {
            method: request.method,
            url: safeRequestUrl(request.url),
            hostname: request.hostname,
            remoteAddress: request.remoteAddress,
            remotePort: request.remotePort,
          };
        },
      },
      redact: {
        paths: REDACT_PATHS,
        censor: REDACT_CENSOR,
      },
    } as never,
    childLoggerFactory: (loggerInstance, bindings, opts, rawReq) => {
      const headerId = (rawReq as { headers?: Record<string, unknown> }).headers?.['x-request-id'];
      const headerStr = Array.isArray(headerId) ? headerId[0] : headerId;
      const requestId =
        typeof headerStr === 'string' && headerStr.length > 0 ? headerStr : newRequestId();
      bindings.request_id = requestId;
      // Stash on the raw request so the onRequest hook / handlers can read it.
      (rawReq as { requestId?: string }).requestId = requestId;
      return loggerInstance.child(bindings, opts);
    },
    // Versioning des endpoints publics Connect (Phase 6) :
    // /public/v1/* est un alias de /public/* (transition progressive).
    // rewriteUrl s'exécute AVANT le routing Fastify (contrairement à un hook
    // onRequest, qui s'exécute après que la route a été matchée — trop tard).
    // Cf. https://fastify.dev/docs/latest/Reference/Server/#rewriteurl
    rewriteUrl(req) {
      const url = req.url ?? '/';
      if (url.startsWith('/public/v1/')) {
        return `/public/${url.slice('/public/v1/'.length)}`;
      }
      return url;
    },
  });

  // Stamp every incoming request with a request_id (set by childLoggerFactory
  // above). The request's logger (`req.log`) is a child of the base logger
  // that automatically includes this id on every log line for that request.
  // To trace a request end-to-end in production logs, grep for the request_id.
  app.addHook('onRequest', (request, _reply, done) => {
    // childLoggerFactory already attached requestId; this hook is a no-op
    // kept for documentation and future per-request setup.
    done();
  });

  // Global HTTP request counter — alimente alertErrorRateHigh via le worker
  // alert-evaluation. Exécuté après toutes les routes (y compris 404).
  app.addHook('onResponse', (request, reply, done) => {
    const code = reply.statusCode;
    const statusClass = code < 400 ? '2xx' : code < 500 ? '4xx' : '5xx';
    httpRequestsTotal.inc({ status_class: statusClass });
    done();
  });

  app.decorate('db', db);
  app.decorate('redisCache', redisCache);
  app.decorate('queues', queues);

  // Preserve raw body for webhook signature verification (Telnyx signs the
  // exact bytes received — re-serializing JSON can change key order and
  // invalidate the signature). The raw body is exposed as `request.rawBody`.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body: string, done) => {
    (req as { rawBody?: string }).rawBody = body;
    try {
      const json = body.length === 0 ? null : JSON.parse(body);
      done(null, json);
    } catch (err: unknown) {
      done(err as Error, undefined);
    }
  });

  // OAuth 2.0 endpoints (token, register) reçoivent du form-urlencoded.
  // @fastify/formbody gère tous les edge cases d'encodage (notamment + → espace).
  // Ne jamais remplacer par un parser custom — c'est comme ça qu'on a eu le bug
  // des scopes collés ("mcp:read+mcp:reserve+mcp:cancel" au lieu de 3 séparés).
  await app.register(import('@fastify/formbody'));

  // Global error handler — Zod validation errors → 400 propre
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'Validation Error',
        details: error.issues.map((e) => ({
          path: e.path.join('.'),
          message: e.message,
        })),
      });
    }

    const err = error as Error;
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error({ err: error, path: request.url }, 'Unhandled error');
      captureException(error, {
        extra: { path: request.url, method: request.method, requestId: request.id },
        tags: { route: request.url },
      });
    } else {
      request.log.warn({ err: error, path: request.url, statusCode }, 'Handled client error');
    }

    reply.status(statusCode).send({
      error: err.name ?? 'InternalServerError',
      message:
        process.env.NODE_ENV === 'production' && statusCode >= 500
          ? 'Une erreur interne est survenue.'
          : err.message,
      statusCode,
    });
  });

  // Install the Sentry Fastify error handler *after* our custom handler so it
  // wraps and augments it. Sentry will send 500s to its own backend as well.
  setupFastifyErrorHandler(app);

  await registerCors(app);
  await registerRateLimit(app);
  await registerClerk(app);
  await app.register(fastifyWebsocket);
  registerMediaStreamRoutes(app);
  registerLiveDemoStreamRoute(app);

  await app.register(telnyxVoiceRoutes);
  await app.register(smsInboundRoutes);
  await app.register(reservationManagementRoutes);
  await app.register(whatsappWebhookRoutes);
  await app.register(metaWhatsAppWebhookRoutes);
  await app.register(marketingProviderRoutes);
  await app.register(restaurantRoutes);
  await app.register(teamRoutes);
  await app.register(customerRoutes);
  await app.register(customerCrmRoutes);
  await app.register(customerSegmentRoutes);
  await app.register(marketingRoutes);
  await app.register(analyticsRoutes);
  await app.register(reservationRoutes);
  await app.register(callRoutes);
  await app.register(voiceReadRoutes);
  await app.register(dashboardRoutes);
  await app.register(companionRoutes);
  await app.register(reactivationRoutes);
  await app.register(authSyncRoutes);
  await app.register(agenticAdminRoutes);
  await app.register(mcpRoutes);
  await app.register(genericAgentRoutes);
  await app.register(oauthRoutes);
  await app.register(openaiReserveRoutes);
  await app.register(rgpdRoutes);
  await app.register(connectRoutes);
  await app.register(floorPlanRoutes);
  await app.register(giftCardRoutes);
  await app.register(giftCardPackRoutes);
  await app.register(demoRequestRoutes);
  await app.register(billingRoutes);
  await app.register(entitlementRoutes);
  await app.register(usageRoutes);
  await app.register(observabilityRoutes);
  await app.register(pilotRoutes);
  await app.register(flagsRoutes);
  await app.register(onboardingFunnelRoutes);
  await app.register(provisioningRoutes);
  await app.register(restaurantHealthRoutes);
  await app.register(voiceCapacityRoutes);
  await app.register(adminCustomerRepairRoutes);
  await app.register(posRoutes);
  await app.register(reservationPaymentRoutes);
  await app.register(customerGroupRoutes);
  await app.register(reputationRoutes);
  await app.register(loyaltyRoutes);
  await app.register(experienceRoutes);
  await app.register(eventRoutes);
  await app.register(distributionRoutes);

  // Routes de test — uniquement si ENABLE_TEST_ROUTES=true explicitement (SEC-005)
  if (env.ENABLE_TEST_ROUTES === 'true') {
    await app.register(testRoutes);
  }

  app.get('/health', async (_req, reply) => {
    const result = await checkHealth();
    // 503 if any core check failed (db/redis/queues).
    // 200 if only voice providers failed (api still serves non-voice).
    const coreOk = ['db', 'redis', 'queues'].every((name) => result.checks[name]?.status === 'ok');
    return reply.status(coreOk ? 200 : 503).send(result);
  });

  // Alias K8s-style : /healthz (même handler)
  app.get('/healthz', async (_req, reply) => {
    const result = await checkHealth();
    const coreOk = ['db', 'redis', 'queues'].every((name) => result.checks[name]?.status === 'ok');
    return reply.status(coreOk ? 200 : 503).send(result);
  });

  // Liveness probe (toujours OK si le process tourne, sans check DB/Redis)
  app.get('/livez', async (_req, reply) => {
    return reply.send({ status: 'ok' });
  });

  return app;
}

async function start() {
  const app = await buildApp();

  // Mesure ce que coûtent les appels réels : c'est de là que vient le seuil d'appels simultanés.
  const stopCapacitySampler = startCapacitySampler();
  const stopCapacityLimitPublisher = startCapacityLimitPublisher();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down gracefully...');
    stopCapacitySampler();
    stopCapacityLimitPublisher();
    // Les sessions vocales vivent en mémoire : fermer l'API coupe les appels en cours.
    await waitForVoiceCallsToEnd().catch((err) => logger.warn({ err }, 'Voice drain failed'));
    await app.close();
    await closeSentry();
    process.exit(0);
  };
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => logger.error({ err }, 'SIGTERM shutdown failed'));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => logger.error({ err }, 'SIGINT shutdown failed'));
  });

  try {
    const address = await app.listen({
      port: Number(process.env.PORT ?? 4000),
      host: process.env.HOST ?? '0.0.0.0',
    });
    logger.info({ address }, 'Suppernote API listening');
    // Notifier PM2 que l'API est prête à accepter du trafic (P0 DEP-005).
    if (typeof process.send === 'function') {
      process.send('ready');
    }
    // Workers arrêtés, ligne téléphonique hors service : alerte par e-mail (watchtower.ts).
    startWatchtower();
  } catch (err) {
    logger.error(err);
    logger.warn('Failed to listen on port 4000 — will exit gracefully for PM2 restart');
    process.exitCode = 1;
    return;
  }

  // Pré-génération des greetings audio par restaurant au boot.
  // Le greeting "Bonjour, ici {restaurant}, je suis Léa, l'assistante IA. Je vous écoute." est la
  // première
  // chose que le client entend. Sans cache, il faut ~400-800ms pour le
  // synthétiser via Cartesia. Pré-généré → cache hit instantané au runtime.
  // Fire-and-forget : ne bloque pas l'API.
  setImmediate(() => {
    initGreetingCache()
      .then(() => logger.info('Greeting cache warmup complete'))
      .catch((err) => logger.warn({ err }, 'Greeting cache warmup failed (non-blocking)'));
  });

  // Petits mots d'attente (voir voice-filler.ts) : banque préchargée au démarrage.
  setImmediate(() => {
    initVoiceFillerCache().catch((err) =>
      logger.warn({ err }, 'Voice filler cache warmup failed (non-blocking)'),
    );
  });

  // Warm-up Telnyx : pré-chauffe la connexion TLS vers l'API Telnyx (EU)
  // pour que le premier appel téléphonique n'ait pas à payer le handshake
  // TLS de ~113ms. Fire-and-forget.
  setImmediate(() => {
    warmupTelnyxConnection()
      .then(() => logger.info('Telnyx connection warmed (keep-alive ready)'))
      .catch((err) => logger.warn({ err }, 'Telnyx warmup failed (non-blocking)'));
  });

  // Workers et jobs récurrents : soit dans ce process (développement), soit
  // dans le process dédié `dist/worker.js` (production, PM2 `sokar-workers`).
  // En production l'écosystème PM2 force RUN_WORKERS_IN_PROCESS=false.
  if (env.RUN_WORKERS_IN_PROCESS === 'true') {
    setImmediate(() => {
      import('./workers/index')
        .then(() => {
          startWorkerHeartbeat();
          return registerJobSchedulers();
        })
        .catch((err) => logger.error({ err }, 'Worker bootstrap failed (in-process mode)'));
    });
  }
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[unhandledRejection]');
});

if (!process.env.VITEST) {
  // start() returns a Promise we don't await — the function logs its own
  // errors and Fastify's listen() callback handles boot failures.
  start().catch((err) => console.error('[start] failed:', err));
}
