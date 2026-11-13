/**
 * Routes OpenAI Reserve : business feed + tool restaurant_reservation.
 *
 * Spec : https://developers.openai.com/apps-sdk/guides/restaurant-reservation-conversion-spec
 *
 * Routes :
 *   GET  /v1/businesses           : feed paginé (filtre openaiReserveEnabled)
 *   POST /v1/tools/restaurant_reservation : tool Apps SDK conforme spec
 *   GET  /v1/tools                : discovery (liste les tools publics)
 *
 * ─── Risque accepté ─────────────────────────────────────────────────
 *
 * Ce feed est public car OpenAI Apps SDK l'ingère sans auth. Pour limiter
 * le scraping, on expose un mécanisme HMAC partagé (RES-007) : si
 * OPENAI_RESERVE_HMAC_KEY est configuré, le paramètre ?signature est requis.
 * Le rate limit sur /v1/businesses est passé à 10 req/min/IP.
 *
 * Mitigations en place :
 *   1. HMAC partagé optionnel sur /v1/businesses (RES-007)
 *   2. Rate limit strict 10 req/min/IP sur /v1/businesses
 *   3. Cache Redis TTL 120s sur getBusinessFeed() — le scraping répété
 *      tape le cache, pas la DB
 *   4. Métrique Prometheus suppernote_openai_reserve_feed_requests_total{status}
 *      pour détecter un volume anormal
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OpenaiReserveService } from './openai-reserve.service';
import { WIDGET_RESOURCE_URI, TOOL_NAME } from './constants';
import { FeedQuerySchema, RestaurantReservationInputSchema } from './schemas';
import { logger } from '../../../shared/logger/pino';
import { db } from '../../../shared/db/client';
import { openaiReserveFeedRequestsTotal } from '../../../shared/observability/metrics';
import { env } from '../../../env';
import { verifyOpenaiReserveRequest } from './signature';

// Rate limit strict pour /v1/businesses (RES-007). Un HMAC valide permet de
// s'authentifier, mais le rate limit IP reste actif comme safety net.
const RATE_LIMIT_BUSINESSES_MAX = 10;

export async function openaiReserveRoutes(app: FastifyInstance): Promise<void> {
  const service = new OpenaiReserveService(db);

  // GET /v1/businesses : business feed
  // Rate limit strict (10 req/min/IP) + HMAC partagé optionnel (RES-007).
  // Si OPENAI_RESERVE_HMAC_KEY est configuré, le paramètre ?signature est
  // requis. Cela permet de partager un feed signé avec OpenAI sans exposer
  // publiquement les données aux scrapers.
  app.get(
    '/v1/businesses',
    {
      config: { rateLimit: { max: RATE_LIMIT_BUSINESSES_MAX, timeWindow: '1 minute' } },
      preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
        if (
          env.OPENAI_RESERVE_HMAC_KEY &&
          !verifyOpenaiReserveRequest(req, env.OPENAI_RESERVE_HMAC_KEY)
        ) {
          openaiReserveFeedRequestsTotal.inc({ status: '401' });
          return reply.status(401).send({ error: 'Invalid or missing signature' });
        }
      },
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = FeedQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        openaiReserveFeedRequestsTotal.inc({ status: '400' });
        return reply.status(400).send({
          error: 'Invalid query',
          details: parsed.error.format(),
        });
      }
      try {
        const feed = await service.getBusinessFeed(parsed.data);
        openaiReserveFeedRequestsTotal.inc({ status: '200' });
        return reply.send(feed);
      } catch (err: unknown) {
        logger.error({ err }, 'openai-reserve feed failed');
        openaiReserveFeedRequestsTotal.inc({ status: '500' });
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // POST /v1/tools/restaurant_reservation : tool Apps SDK
  // Le tool retourne la structure Apps SDK avec _meta.ui.resourceUri.
  // Rate limit 30 req/min/IP — cohérent avec le feed.
  app.post(
    '/v1/tools/restaurant_reservation',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = RestaurantReservationInputSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid input',
          details: parsed.error.format(),
        });
      }
      try {
        const result = await service.restaurantReservation(parsed.data);
        // Format Apps SDK : _meta.ui.resourceUri indique au runtime
        // qu'il faut charger le widget depuis cette URL.
        return reply.send({
          result,
          _meta: {
            ui: {
              resourceUri: WIDGET_RESOURCE_URI,
            },
          },
        });
      } catch (err: unknown) {
        logger.error({ err }, 'openai-reserve tool failed');
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(404).send({ error: message });
      }
    },
  );

  // GET /v1/tools : list public tools (Apps SDK discovery)
  // Rate limit 30 req/min/IP — cohérent avec les autres routes /v1/*.
  app.get(
    '/v1/tools',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (_req, reply) => {
      return reply.send({
        tools: [
          {
            name: TOOL_NAME,
            description:
              'Open the Suppernote restaurant reservation widget for the given restaurant.',
            input_schema: {
              type: 'object',
              properties: {
                restaurant_id: { type: 'string', description: 'Restaurant ID from business feed' },
                restaurant_name: { type: 'string' },
                restaurant_image: { type: 'string' },
                restaurant_address: {
                  type: 'object',
                  properties: {
                    address: { type: 'string' },
                    city: { type: 'string' },
                    state: { type: 'string' },
                    zipcode: { type: 'string' },
                    country: { type: 'string' },
                  },
                },
              },
              required: ['restaurant_id'],
            },
            _meta: {
              ui: {
                resourceUri: WIDGET_RESOURCE_URI,
              },
            },
          },
        ],
      });
    },
  );
}
