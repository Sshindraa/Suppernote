/**
 * Suppernote Connect — signal « embed.js vu » et contrôle de site (tableau de bord).
 *
 * Routes :
 *   POST /public/embed/heartbeat          (public, sendBeacon text/plain ou JSON, toujours 204)
 *   POST /dashboard/website-check         (Clerk, restaurant du contexte)
 *   GET  /dashboard/website-check/heartbeats
 *
 * Aucune donnée visiteur n'est stockée. Pas de réglage par restaurant : actif pour tous.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import { logger } from '../../../shared/logger/pino';
import { requireOrg } from '../../../plugins/clerk';
import { HeartbeatSchema, readHeartbeats, recordHeartbeat } from './embed-heartbeat.store';
import { inspectWebsite } from './website-check.service';

export const EMBED_HEARTBEAT_PATH = '/public/embed/heartbeat';
const HEARTBEAT_RATE_MAX_PER_MINUTE = 30;
const ANY_ORIGIN_CORS = { origin: '*', credentials: false };

const WebsiteCheckBodySchema = z.object({
  url: z.string().min(1).max(2048),
});

/** Corps brut (text/plain) ou déjà parsé (JSON) → objet validé, ou null si invalide. */
function parseHeartbeatBody(body: unknown) {
  let value = body;
  if (typeof body === 'string') {
    try {
      value = JSON.parse(body);
    } catch {
      return null;
    }
  }
  const parsed = HeartbeatSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Clé de rate limit : IP + slug. Le slug vient du corps, lu avant le preHandler. */
function heartbeatRateKey(req: FastifyRequest): string {
  const slug = parseHeartbeatBody(req.body)?.slug ?? '';
  return `embed-heartbeat:${req.ip}:${slug}`;
}

export async function embedCheckRoutes(app: FastifyInstance): Promise<void> {
  // Sous-scope : parseur text/plain (sendBeacon) et CORS « * » ne touchent que ces routes.
  await app.register(async (scope) => {
    scope.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => {
      done(null, body);
    });

    scope.options(
      EMBED_HEARTBEAT_PATH,
      { config: { cors: ANY_ORIGIN_CORS } },
      async (_req, reply) => reply.status(204).send(),
    );

    scope.post(
      EMBED_HEARTBEAT_PATH,
      {
        bodyLimit: 4096,
        config: {
          cors: ANY_ORIGIN_CORS,
          rateLimit: {
            max: HEARTBEAT_RATE_MAX_PER_MINUTE,
            timeWindow: '1 minute',
            hook: 'preHandler',
            keyGenerator: heartbeatRateKey,
            // Un beacon ne lit pas la réponse : on reste sur 204 même au-delà du quota.
            errorResponseBuilder: () => ({ statusCode: 204, error: 'No Content', message: '' }),
          },
        },
      },
      async (req, reply) => {
        const input = parseHeartbeatBody(req.body);
        if (input) {
          try {
            // tenant-scoping: global — route publique : le slug du script est la seule identité connue.
            const restaurant = await db.restaurant.findUnique({
              where: { slug: input.slug },
              select: { id: true },
            });
            if (restaurant) await recordHeartbeat(redisCache, restaurant.id, input);
          } catch (err) {
            logger.warn(
              { err: err instanceof Error ? err.name : 'unknown' },
              'embed heartbeat dropped',
            );
          }
        }
        return reply.status(204).send();
      },
    );
  });

  app.post('/dashboard/website-check', { preHandler: requireOrg() }, async (req, reply) => {
    const body = WebsiteCheckBodySchema.safeParse(req.body);
    if (!body.success) {
      return reply.status(400).send({ error: 'url required' });
    }
    const restaurantId = req.restaurantId as string;
    const restaurant = await db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { slug: true },
    });
    if (!restaurant) {
      return reply.status(404).send({ error: 'Restaurant not found' });
    }
    const [inspection, heartbeats] = await Promise.all([
      inspectWebsite(body.data.url, restaurant.slug ?? ''),
      readHeartbeats(redisCache, restaurantId),
    ]);
    logger.info({ fetchError: inspection.fetchError }, 'dashboard website check');
    return reply.send({ ...inspection, heartbeats });
  });

  app.get(
    '/dashboard/website-check/heartbeats',
    { preHandler: requireOrg() },
    async (req, reply) => {
      const heartbeats = await readHeartbeats(redisCache, req.restaurantId as string);
      return reply.send({ heartbeats });
    },
  );
}
