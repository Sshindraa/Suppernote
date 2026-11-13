/**
 * Suppernote Connect — Routes publiques Fastify.
 *
 * Préfixe : /public/r/:slug
 *
 * Endpoints (cf. spec v1.1 §6.2) :
 *   GET    /public/r/:slug
 *   GET    /public/r/:slug/availability
 *   POST   /public/r/:slug/hold
 *   POST   /public/r/:slug/confirm
 *
 * Pas de Clerk sur les routes publiques. La seule exception est la route
 * interne `/api/internal/connect-kpis`, qui exige une identité opérateur :
 * elle passe par le vhost public, donc « interne » ne protège rien.
 * CORS : origines suppernote.com (géré par plugins/cors.ts)
 */

import type { FastifyInstance } from 'fastify';
import type { Prisma, Table } from '@prisma/client';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  isReservationManagementEnabled,
  reservationManagementUrl,
} from '../reservations/reservation-management';
import { createWhatsAppReminderConsent, withdrawWhatsAppReminderConsent } from './whatsapp-consent';
import {
  canonicalDemoSlug,
  getDemoSlugAlias,
  slugifyCity,
  slugifyCuisine,
} from '@suppernote/shared';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { db } from '../../shared/db/client';
import { redisCache } from '../../shared/redis/client';
import { logger } from '../../shared/logger/pino';
import { ConnectService, hashPhone } from './connect.service';
import { normalizeCustomerEmail } from '../customers/customer-crm.service';
import {
  CapacityAwareAvailabilityService,
  DEFAULT_RESTAURANT_TIMEZONE,
  utcToZonedParts,
  zonedTimeToUtc,
} from '../floor-plan/availability-capacity-aware.service';
import { TableAllocationService } from '../floor-plan/table-allocation.service';
import { resolveServiceDurationMinutes } from '../floor-plan/floor-plan.types';
import { isSlotStartPast } from '../../shared/timezone/restaurant-time';
import {
  DEFAULT_ONLINE_MIN_LEAD_TIME_MINUTES,
  INSUFFICIENT_LEAD_TIME,
  isSlotTooSoon,
  leadTimeRefusal,
  loadMinLeadTimeMinutes,
} from '../../shared/reservations/lead-time';
import {
  CancelWaitingListTokenSchema,
  WaitingListJoinInputSchema,
} from '../floor-plan/waiting-list.types';
import { HoldConflictError, HoldService } from '../agentic-reservations/core/hold.service';
import { ReservationService } from '../agentic-reservations/core/reservation.service';
import { canHoldSlot } from '../agentic-reservations/core/hold-slot-limit';
import { AuditLogService } from '../agentic-reservations/core/audit-log.service';
import { IdempotencyService } from '../agentic-reservations/core/idempotency.service';
import { PrismaIdempotencyStore } from '../agentic-reservations/core/prisma-store';
import {
  buildPolicySnapshot,
  PolicyValidationError,
  type PolicySnapshot,
} from '../agentic-reservations/core/policies.service';
import { WaitingListService } from '../agentic-reservations/core/waiting-list.service';
import {
  WaitingListAlreadyExistsError,
  WaitingListAlreadyPromotedError,
  WaitingListDisabledError,
  WaitingListEntryNotFoundError,
  WaitingListSlotFullError,
} from '../agentic-reservations/core/waiting-list.errors';
import { ConsentService } from '../rgpd/consent.service';
import { requireSokarOperator } from '../../plugins/clerk';
import { publicReadMax } from '../../plugins/rate-limit';
import {
  computeIdempotencyScope,
  hashPayload,
} from '../agentic-reservations/core/idempotency.service';
import {
  AvailabilityQuerySchema,
  CardGuaranteeCheckoutSchema,
  CardGuaranteeTokenParamSchema,
  ConfirmInputSchema,
  HoldInputSchema,
  DISCOVERABLE_CONNECT_WHERE,
  SlugParamSchema,
  normalizeConnectSource,
  type Source,
} from './connect.types';
import { emitConnectEvent } from './connect-analytics';
import { createCardGuaranteePaymentInTransaction } from '../reservation-payments/reservation-payment.service';
import {
  WEB_CARD_GUARANTEE_HOLD_MS,
  cardGuaranteePageUrl,
  cardGuaranteeToken,
  findCardGuaranteeTerms,
  openCardGuaranteeCheckout,
  publicCardGuaranteeStatus,
  verifyCardGuaranteeToken,
  type CardGuaranteeTerms,
} from '../reservation-payments/reservation-guarantee.public';
import { ConnectKpiService } from './connect-kpis.service';
import { recordBookingMarketingConsent } from '../marketing/marketing-consent.service';
import { canConfirm, recordFailedConfirm } from './connect-rate-limit';
import {
  consumeTestBookingQuota,
  isTestBookingEnabled,
  verifyTestBookingToken,
} from './test-booking';
import { connectRequestDuration } from '../../shared/observability/metrics';
import { observeReservationMutation } from '../../shared/observability/reservation-contract';
import {
  RATE_LIMIT_PREVIEW_MAX,
  RATE_LIMIT_SITEMAP_MAX,
  RATE_LIMIT_RESTAURANTS_MAX,
  RATE_LIMIT_CITIES_MAX,
  RATE_LIMIT_CITY_DETAIL_MAX,
  RATE_LIMIT_ANALYTICS_MAX,
  RATE_LIMIT_AVAILABILITY_MAX,
  RATE_LIMIT_HOLD_MAX,
  RATE_LIMIT_CONFIRM_MAX,
  RATE_LIMIT_WAITING_LIST_JOIN_MAX,
  RATE_LIMIT_WAITING_LIST_CANCEL_MAX,
  RATE_LIMIT_RESOLVE_CUSTOM_DOMAIN_MAX,
  PAGINATION_DEFAULT_LIMIT,
  PAGINATION_MAX_LIMIT,
} from './constants';

/**
 * Map une URL vers un nom de route lisible pour les labels Prometheus.
 * Évite la cardinalité infinie (pas de slug dans le label).
 */
function routeLabel(url: string): string {
  if (url.startsWith('/public/r/') && url.endsWith('/availability')) return 'availability';
  if (url.startsWith('/public/r/') && url.endsWith('/hold')) return 'hold';
  if (url.startsWith('/public/r/') && url.endsWith('/confirm')) return 'confirm';
  if (url.startsWith('/public/r/')) return 'slug';
  if (url.startsWith('/public/cities/')) return 'city';
  if (url === '/public/cities') return 'cities';
  if (url === '/public/sitemap-data') return 'sitemap-data';
  if (url === '/public/analytics/events') return 'analytics-events';
  if (url.startsWith('/public/restaurants')) return 'restaurants';
  return 'other';
}

const TEST_BOOKING_REFUSED_MESSAGE =
  'Ce lien de test a expiré. Relancez-le depuis votre tableau de bord.';
const TEST_BOOKING_QUOTA_MESSAGE =
  'Vous avez atteint la limite de 5 réservations test sur 24 heures.';

/**
 * Réservation test : `undefined` sans jeton (circuit réel), `true` si le jeton
 * est valide pour ce restaurant et le drapeau actif, `false` sinon (403).
 * Le jeton n'est jamais journalisé.
 */
function testBookingMode(token: string | undefined, restaurantId: string): boolean | undefined {
  if (token === undefined) return undefined;
  return isTestBookingEnabled() && verifyTestBookingToken(token, restaurantId);
}

function statusClass(code: number): string {
  if (code < 400) return '2xx';
  if (code < 500) return '4xx';
  return '5xx';
}

/** Conditions d'empreinte exposées au client, sans identifiant interne. */
function publicTerms(terms: CardGuaranteeTerms) {
  return {
    amountPerPerson: terms.amountPerPerson,
    totalAmount: terms.totalAmount,
    currency: terms.currency,
    cancellationHours: terms.cancellationHours,
  };
}

/**
 * Ouvre la page Stripe juste après la création. Un échec Stripe ne perd rien : la réservation
 * reste tenue et la page Suppernote propose de réessayer jusqu'à l'expiration.
 */
async function openGuaranteeAfterBooking(input: {
  paymentId: string;
  restaurantId: string;
  slug: string;
  restaurantName: string;
  terms: CardGuaranteeTerms;
}) {
  const payment = await db.reservationPayment.findFirst({
    where: { id: input.paymentId, restaurantId: input.restaurantId },
    select: { id: true, restaurantId: true, amount: true, expiresAt: true },
  });
  const token = payment ? cardGuaranteeToken(payment) : null;
  if (!payment || !token) return null;
  let checkoutUrl: string | null = null;
  try {
    ({ url: checkoutUrl } = await openCardGuaranteeCheckout({
      payment,
      slug: input.slug,
      restaurantName: input.restaurantName,
      cancellationHours: input.terms.cancellationHours,
      termsAcceptedAt: new Date(),
    }));
  } catch (error) {
    logger.warn(
      { paymentId: payment.id, err: error instanceof Error ? error.message : String(error) },
      'connect card guarantee checkout not opened',
    );
  }
  return {
    checkoutUrl,
    pageUrl: cardGuaranteePageUrl(input.slug, token),
    expiresAt: payment.expiresAt?.toISOString() ?? null,
    totalAmount: payment.amount.toFixed(2),
    cancellationHours: input.terms.cancellationHours,
  };
}

export async function connectRoutes(app: FastifyInstance): Promise<void> {
  const canal = new ConnectService(db, redisCache);
  const availability = new CapacityAwareAvailabilityService(db);
  const tableAllocation = new TableAllocationService(db);
  const audit = new AuditLogService(db);
  const holds = new HoldService(db, audit);
  const idempotency = new IdempotencyService(new PrismaIdempotencyStore(db));
  const reservations = new ReservationService(db, audit, holds, idempotency);
  const waitingList = new WaitingListService(db, tableAllocation, audit);

  // ─── Versioning : /public/v1/* → alias de /public/* (Phase 6) ───
  // La réécriture se fait au niveau du serveur (rewriteUrl dans main.ts),
  // exécutée AVANT le routing Fastify. Un hook onRequest ici serait trop tard
  // (le routing a déjà matché la route /public/v1/foo → 404).
  // Les anciens chemins /public/* restent fonctionnels (transition).

  // ─── Hook latence : enregistre la durée de chaque requête Connect ───
  // Spec v1.1 §11.2 : p95 < 500ms cible pour le pilote P1.
  app.addHook('onResponse', async (req, reply) => {
    const route = routeLabel(req.url);
    if (route === 'other') return; // ignore les routes non-Connect
    const durationMs = reply.elapsedTime;
    connectRequestDuration.observe({ route, status: statusClass(reply.statusCode) }, durationMs);
  });

  // ─── 1. GET /public/r/:slug ─────────────────────────────────

  const PreviewQuerySchema = z.object({
    preview: z.enum(['1', '0']).optional(),
  });

  app.get(
    '/public/r/:slug',
    {
      config: { rateLimit: { max: publicReadMax(RATE_LIMIT_PREVIEW_MAX), timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const parse = SlugParamSchema.safeParse(req.params);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: parse.error.format() });
      }

      const query = PreviewQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.status(400).send({ error: 'Invalid query', details: query.error.format() });
      }
      const isPreview = query.data.preview === '1';

      const restaurant = await canal.getPublishedBySlug(parse.data.slug, { preview: isPreview });
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      return reply.send({
        ...restaurant,
        whatsappReminderOptInEnabled: process.env.WHATSAPP_CONSENT_ENABLED === 'true',
      });
    },
  );

  // ─── 1b. GET /public/sitemap-data ────────────────────────────
  // Liste minimale (slug + updatedAt + publishedAt) des restaurants publiés.
  // Utilisé par apps/connect/src/app/sitemap.ts (cf. spec v1.1 §6.6).
  // Pas de PII, pas de description : juste ce qu'il faut pour le sitemap XML.

  // ─── 1c. GET /public/resolve-custom-domain ───────────────────
  // Résout un custom domain (host) → slug restaurant.
  // Utilisé par apps/connect/src/app/custom-domain/page.tsx (P2 premium subdomain).
  // Cache Redis 5 min pour éviter le lookup DB à chaque requête sur un custom domain.
  app.get(
    '/public/resolve-custom-domain',
    {
      config: {
        rateLimit: {
          max: publicReadMax(RATE_LIMIT_RESOLVE_CUSTOM_DOMAIN_MAX),
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const host = (req.query as { host?: string }).host;
      if (!host) {
        return reply.status(400).send({ error: 'Missing host parameter' });
      }

      // Cache Redis (5 min) — le mapping customDomain → slug change rarement
      const cacheKey = `connect:custom-domain:${host}`;
      const cached = await app.redisCache.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { slug: string | null };
        if (parsed.slug) {
          return reply.send({ slug: canonicalDemoSlug(parsed.slug) });
        }
        return reply.status(404).send({ slug: null });
      }

      const settings = await app.db.restaurantExposureSettings.findFirst({
        where: { customDomain: host, customDomainStatus: 'active' },
        select: { restaurantId: true, restaurant: { select: { slug: true } } },
      });
      const slug = settings?.restaurant.slug ? canonicalDemoSlug(settings.restaurant.slug) : null;
      // Cache le résultat (positif ou négatif) pendant 5 min
      await app.redisCache.set(cacheKey, JSON.stringify({ slug }), 'EX', 300);
      if (!slug) {
        return reply.status(404).send({ slug: null });
      }
      return reply.send({ slug });
    },
  );

  app.get(
    '/public/sitemap-data',
    {
      config: { rateLimit: { max: publicReadMax(RATE_LIMIT_SITEMAP_MAX), timeWindow: '1 minute' } },
    },
    async (_req, reply) => {
      const rows = await db.restaurant.findMany({
        where: DISCOVERABLE_CONNECT_WHERE,
        select: {
          slug: true,
          updatedAt: true,
          publishedAt: true,
        },
        orderBy: { updatedAt: 'desc' },
      });
      const restaurants = rows
        .filter((r): r is typeof r & { slug: string } => r.slug !== null)
        .map((r) => ({
          slug: canonicalDemoSlug(r.slug),
          updatedAt: (r.updatedAt ?? new Date()).toISOString(),
          publishedAt: (r.publishedAt ?? new Date()).toISOString(),
        }));
      return reply.send({ restaurants });
    },
  );

  // ─── 1b.ter GET /public/restaurants (Phase 6 — pagination) ───
  // Liste paginée des restaurants publiés (DTO complet pour la grille homepage).
  // Pagination réelle en DB (skip/take), pas en mémoire.
  // Query params : page (default 1), limit (default 12, max 50).

  const RestaurantsQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGINATION_MAX_LIMIT)
      .default(PAGINATION_DEFAULT_LIMIT),
  });

  app.get(
    '/public/restaurants',
    {
      config: {
        rateLimit: { max: publicReadMax(RATE_LIMIT_RESTAURANTS_MAX), timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const query = RestaurantsQuerySchema.safeParse(req.query ?? {});
      if (!query.success) {
        return reply.status(400).send({ error: 'Invalid query', details: query.error.format() });
      }
      const result = await canal.getPublishedRestaurants(query.data.page, query.data.limit);
      return reply.send(result);
    },
  );

  // ─── 1b.bis GET /public/cities (T7) ─────────────────────────
  // Liste des villes avec compteurs + cuisines (règle 5/10/20 §3.3)

  app.get(
    '/public/cities',
    {
      config: { rateLimit: { max: publicReadMax(RATE_LIMIT_CITIES_MAX), timeWindow: '1 minute' } },
    },
    async (_req, reply) => {
      const rows = await db.restaurant.findMany({
        where: {
          ...DISCOVERABLE_CONNECT_WHERE,
          city: { not: null },
        },
        select: { city: true, cuisineType: true },
      });

      const byCity = new Map<string, CityRow>();
      for (const r of rows) {
        if (!r.city) continue;
        const slug = slugifyCity(r.city);
        let entry = byCity.get(slug);
        if (!entry) {
          entry = { city: r.city, citySlug: slug, total: 0, cuisines: [] };
          byCity.set(slug, entry);
        }
        entry.total += 1;
        for (const cuisine of r.cuisineType) {
          const cSlug = slugifyCuisine(cuisine);
          const existing = entry.cuisines.find((c) => c.slug === cSlug);
          if (existing) {
            existing.count += 1;
          } else {
            entry.cuisines.push({ name: cuisine, slug: cSlug, count: 1 });
          }
        }
      }

      const cities = Array.from(byCity.values())
        .filter((c) => c.total >= 5)
        .sort((a, b) => b.total - a.total);

      return reply.send({ cities });
    },
  );

  // ─── 1b.ter GET /public/cities/:slug (T7) ────────────────────
  // Restaurants d'une ville (avec filtre cuisine optionnel).
  // Renvoie shouldIndex=false si pas assez d'inventaire.

  app.get(
    '/public/cities/:slug',
    {
      config: {
        rateLimit: { max: publicReadMax(RATE_LIMIT_CITY_DETAIL_MAX), timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const params = req.params as { slug: string };
      if (!isValidCitySlug(params.slug)) {
        return reply.status(400).send({ error: 'Invalid city slug' });
      }
      const queryParse = z.object({ cuisine: z.string().optional() }).safeParse(req.query);
      if (!queryParse.success) {
        return reply.status(400).send({ error: 'Invalid query' });
      }

      const allCities = await db.restaurant.findMany({
        where: { ...DISCOVERABLE_CONNECT_WHERE, city: { not: null } },
        select: { city: true, cuisineType: true },
      });
      const cityRow = allCities.find((r) => slugifyCity(r.city ?? '') === params.slug);
      if (!cityRow?.city) {
        return reply.status(404).send({ error: 'City not found' });
      }
      const cityName = cityRow.city;
      const cityRows = allCities.filter((r) => r.city === cityName);
      const totalInCity = cityRows.length;

      const cuisineFilter = queryParse.data.cuisine?.toLowerCase();
      let cuisineName: string | null = null;
      let cuisineCount = 0;
      if (cuisineFilter) {
        cuisineName =
          cityRows.flatMap((r) => r.cuisineType).find((c) => slugifyCuisine(c) === cuisineFilter) ??
          null;
        if (cuisineName) {
          cuisineCount = cityRows.filter((r) =>
            r.cuisineType.some((c) => slugifyCuisine(c) === cuisineFilter),
          ).length;
        }
      }

      const shouldIndexCity = totalInCity >= 5;
      const shouldIndexCuisine = !!cuisineFilter && totalInCity >= 10 && cuisineCount >= 5;

      if (cuisineFilter && !shouldIndexCuisine) {
        return reply.send({
          citySlug: params.slug,
          city: cityName,
          cuisine: cuisineName,
          totalInCity,
          cuisineCount,
          restaurants: [],
          shouldIndex: false,
          reason: 'not_enough_inventory',
        });
      }
      if (!cuisineFilter && !shouldIndexCity) {
        return reply.send({
          citySlug: params.slug,
          city: cityName,
          totalInCity,
          restaurants: [],
          shouldIndex: false,
          reason: 'not_enough_inventory',
        });
      }

      const restaurantsRaw = await db.restaurant.findMany({
        where: {
          ...DISCOVERABLE_CONNECT_WHERE,
          city: cityName,
          ...(cuisineFilter && cuisineName ? { cuisineType: { has: cuisineName } } : {}),
        },
        select: { slug: true },
      });
      const restaurantSlugs = restaurantsRaw.map((r) => r.slug).filter((s): s is string => !!s);
      const dtos = await canal.getPublishedBySlugs(restaurantSlugs);

      return reply.send({
        citySlug: params.slug,
        city: cityName,
        ...(cuisineFilter && cuisineName ? { cuisine: cuisineName, cuisineCount } : {}),
        totalInCity,
        restaurants: dtos,
        shouldIndex: cuisineFilter ? shouldIndexCuisine : shouldIndexCity,
      });
    },
  );

  // ─── 1c. POST /public/analytics/events ──────────────────────
  // Endpoint léger pour les events page_view / cta_clicked / etc.
  // En T8 (Phase 1), on push dans la queue BullMQ `connect-analytics`
  // qui incrémente les compteurs prom-client (cf. observability/metrics.ts).
  // Cf. spec v1.1 §16. Pas d'auth (events publics).
  // Best-effort : si la queue est down, on log et on renvoie 202 quand même.

  app.post(
    '/public/analytics/events',
    { config: { rateLimit: { max: RATE_LIMIT_ANALYTICS_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = (req.body ?? {}) as { event?: string; [key: string]: unknown };
      if (!body.event || typeof body.event !== 'string') {
        return reply.status(400).send({ error: 'event field required' });
      }
      if (body.event.length > 64) {
        return reply.status(400).send({ error: 'event name too long' });
      }
      // Validation soft : on accepte les events inconnus (forward compat) mais
      // on log un warning. Le worker drop les events invalides.
      await emitConnectEvent(app.queues.connectAnalytics, {
        event: body.event,
        restaurantId: body.restaurantId as string | undefined,
        restaurantSlug: body.restaurantSlug as string | undefined,
        city: body.city as string | undefined,
        source: (body.source as string | undefined) ?? 'web',
        utmSource: body.utmSource as string | undefined,
        utmMedium: body.utmMedium as string | undefined,
        utmCampaign: body.utmCampaign as string | undefined,
        date: body.date as string | undefined,
        time: body.time as string | undefined,
        partySize: body.partySize as number | undefined,
        reservationId: body.reservationId as string | undefined,
      });
      return reply.status(202).send({ ok: true });
    },
  );

  // ─── 2. GET /public/r/:slug/availability ────────────────────

  app.get(
    '/public/r/:slug/availability',
    {
      config: {
        rateLimit: { max: publicReadMax(RATE_LIMIT_AVAILABILITY_MAX), timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      if (!slugParse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: slugParse.error.format() });
      }
      const queryParse = AvailabilityQuerySchema.safeParse(req.query);
      if (!queryParse.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid query', details: queryParse.error.format() });
      }

      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      // Surface en ligne : le délai minimum du restaurant marque indisponibles les créneaux trop proches.
      const dto = await availability.getAvailability({
        restaurantId: restaurant.id,
        date: queryParse.data.date,
        partySize: queryParse.data.partySize,
        preferredSectionId: queryParse.data.preferredSectionId,
        minLeadTimeMinutes: await loadMinLeadTimeMinutes(db, restaurant.id),
      });

      return reply.send(dto);
    },
  );

  // ─── 3. POST /public/r/:slug/hold ───────────────────────────
  // Crée un hold temporaire 5min (TTL via policies.holdTtlSeconds)
  // Rate limit : 11 holds/min/IP (cf. spec v1.1 §10 T2 + §8.3).

  app.post(
    '/public/r/:slug/hold',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_HOLD_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      if (!slugParse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: slugParse.error.format() });
      }
      const bodyParse = HoldInputSchema.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: 'Invalid body', details: bodyParse.error.format() });
      }

      // Honeypot anti-bot : si le champ website est rempli, c'est un bot.
      // On retourne 202 (accepted) pour ne pas alerter le bot, mais on ne crée pas de hold.
      if (bodyParse.data.website) {
        logger.warn({ slug: slugParse.data.slug }, '[connect] Honeypot triggered on /hold');
        return reply
          .status(202)
          .send({ holdId: '', holdToken: '', expiresAt: '', status: 'pending' });
      }

      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      // Réservation test : jeton vérifié avant tout effet ; le hold suit le
      // circuit réel, sans événement analytics.
      const testMode = testBookingMode(bodyParse.data.testBookingToken, restaurant.id);
      if (testMode === false) {
        return reply.status(403).send({ error: TEST_BOOKING_REFUSED_MESSAGE });
      }
      const isTest = testMode === true;

      // Source normalization (cf. spec v1.1 §5.9)
      // - Si connectAgentic=false, on neutralise chatgpt/perplexity/bing → 'web'
      // - On préserve google (organic SEO), instagram, qr_code, etc.
      const source: Source = normalizeConnectSource(
        bodyParse.data.source,
        restaurant.connectAgentic,
      );

      const policy = await loadPolicy(restaurant.id);
      if (!policy) {
        return reply.status(409).send({ error: 'No policy configured for this restaurant' });
      }
      if (bodyParse.data.partySize > policy.maxPartySize) {
        return reply.status(409).send({
          error: `Party size ${bodyParse.data.partySize} exceeds max (${policy.maxPartySize})`,
        });
      }

      const settings = await db.restaurantExposureSettings.findUnique({
        where: { restaurantId: restaurant.id },
      });
      const serviceDurationMinutes = resolveServiceDurationMinutes(
        settings?.capacitySpecials as Record<string, unknown> | undefined,
      );

      const restaurantWithTz = await db.restaurant.findUnique({
        where: { id: restaurant.id },
        select: { timezone: true },
      });
      const timeZone = restaurantWithTz?.timezone ?? 'Europe/Paris';
      const slotStart = zonedTimeToUtc(bodyParse.data.date, bodyParse.data.time, timeZone);
      const slotEnd = new Date(slotStart.getTime() + serviceDurationMinutes * 60 * 1000);

      // Même règle que l'affichage : un créneau trop proche ne se bloque pas.
      if (isSlotTooSoon(slotStart, policy.minLeadTimeMinutes)) {
        return reply.status(409).send(leadTimeRefusal(policy.minLeadTimeMinutes));
      }

      const offered = await availability.getAvailability({
        restaurantId: restaurant.id,
        date: bodyParse.data.date,
        partySize: bodyParse.data.partySize,
        preferredSectionId: bodyParse.data.preferredSectionId,
        minLeadTimeMinutes: policy.minLeadTimeMinutes,
      });
      if (!offered.slots.some((slot) => slot.time === bodyParse.data.time && slot.available)) {
        return reply.status(409).send({
          error: 'no_table_available',
          waitingListEnabled:
            (settings?.capacitySpecials as Record<string, unknown> | undefined)
              ?.waitingListEnabled === true,
        });
      }

      if (!(await canHoldSlot({ restaurantId: restaurant.id, slotStart, clientIp: req.ip }))) {
        return reply.status(429).send({ error: 'hold_limit_reached' });
      }

      try {
        const hold = await holds.createHold({
          restaurantId: restaurant.id,
          partySize: bodyParse.data.partySize,
          slotStart,
          slotEnd,
          channel: 'WEB',
          policy,
          actor: 'connect:web',
          preferredSectionId: bodyParse.data.preferredSectionId,
        });

        // Émettre l'événement analytics reservation_hold_created (T9)
        if (!isTest) {
          await emitConnectEvent(app.queues.connectAnalytics, {
            event: 'reservation_hold_created',
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            city: restaurant.address.city,
            source,
            date: bodyParse.data.date,
            time: bodyParse.data.time,
            partySize: bodyParse.data.partySize,
          });
        }

        return reply.send({
          holdId: hold.id,
          holdToken: hold.holdToken,
          expiresAt: hold.expiresAt.toISOString(),
          status: 'pending',
          sourceNormalized: source,
        });
      } catch (err: unknown) {
        if (err instanceof HoldConflictError) {
          return reply.status(409).send({
            error: 'no_table_available',
            waitingListEnabled:
              (settings?.capacitySpecials as Record<string, unknown> | undefined)
                ?.waitingListEnabled === true,
          });
        }
        logger.error({ err, slug: slugParse.data.slug }, 'connect hold creation failed');
        if (!isTest) {
          await emitConnectEvent(app.queues.connectAnalytics, {
            event: 'reservation_failed',
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            city: restaurant.address.city,
            source,
            date: bodyParse.data.date,
            time: bodyParse.data.time,
            partySize: bodyParse.data.partySize,
          });
        }
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 4. POST /public/r/:slug/confirm ────────────────────────

  app.post(
    '/public/r/:slug/confirm',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_CONFIRM_MAX,
          timeWindow: '1 minute',
        },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      if (!slugParse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: slugParse.error.format() });
      }
      const bodyParse = ConfirmInputSchema.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: 'Invalid body', details: bodyParse.error.format() });
      }
      if (
        bodyParse.data.whatsappReminderConsent?.accepted &&
        process.env.WHATSAPP_CONSENT_ENABLED !== 'true'
      ) {
        return reply
          .status(409)
          .send({ error: 'Le rappel WhatsApp n’est pas disponible actuellement.' });
      }

      // Honeypot anti-bot : si le champ website est rempli, c'est un bot.
      // On retourne 202 (accepted) pour ne pas alerter le bot, mais on ne crée pas de résa.
      if (bodyParse.data.website) {
        logger.warn({ slug: slugParse.data.slug }, '[connect] Honeypot triggered on /confirm');
        return reply.status(202).send({ reservationId: '', status: 'confirmed' });
      }

      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      // Réservation test : jeton vérifié avant tout effet. La réservation suit le
      // circuit réel (hold, table, confirmation), sans consentement CRM, anti-spam
      // par téléphone, analytics, attribution marketing ni carte cadeau.
      const testMode = testBookingMode(bodyParse.data.testBookingToken, restaurant.id);
      if (testMode === false) {
        return reply.status(403).send({ error: TEST_BOOKING_REFUSED_MESSAGE });
      }
      const isTest = testMode === true;

      // Lookup hold
      const hold = await db.agenticHold.findFirst({
        where: { holdToken: bodyParse.data.holdToken, restaurantId: restaurant.id },
      });
      const phoneHash = hashPhone(bodyParse.data.customer.phone);
      const idempotencyScope = computeIdempotencyScope({
        restaurantId: restaurant.id,
        channel: 'WEB',
        clientId: isTest ? `test:${phoneHash}` : phoneHash,
      });
      const idempotencyKey = bodyParse.data.idempotencyKey ?? hold?.id;
      const payloadHash = hold ? hashPayload({ holdId: hold.id, ...bodyParse.data }) : null;
      if (hold?.status === 'CONSUMED' && hold.reservationId && idempotencyKey && payloadHash) {
        const existing = await db.reservation.findFirst({
          where: {
            id: hold.reservationId,
            restaurantId: restaurant.id,
            consumedHoldId: hold.id,
            idempotencyScope,
            idempotencyKey,
            idempotencyPayloadHash: payloadHash,
            isTest,
          },
        });
        if (!existing) return reply.status(409).send({ error: 'Confirmation cannot be replayed' });
        const pendingGuarantee =
          existing.state === 'PENDING'
            ? await db.reservationPayment.findFirst({
                where: {
                  restaurantId: restaurant.id,
                  reservationId: existing.id,
                  status: 'REQUIRES_PAYMENT_METHOD',
                },
                select: { id: true, restaurantId: true, expiresAt: true, amount: true },
              })
            : null;
        const pendingToken = pendingGuarantee ? cardGuaranteeToken(pendingGuarantee) : null;
        // tenant-scoping: global — table Restaurant, id déjà résolu.
        const restaurantTz = await db.restaurant.findUnique({
          where: { id: restaurant.id },
          select: { timezone: true },
        });
        const local = utcToZonedParts(
          hold.slotStart,
          restaurantTz?.timezone ?? DEFAULT_RESTAURANT_TIMEZONE,
        );
        return reply.send({
          reservationId: existing.id,
          ...(isReservationManagementEnabled()
            ? { managementUrl: reservationManagementUrl(existing) }
            : {}),
          status: pendingToken ? 'awaiting_card_guarantee' : 'confirmed',
          ...(pendingGuarantee && pendingToken
            ? {
                cardGuarantee: {
                  checkoutUrl: null,
                  pageUrl: cardGuaranteePageUrl(restaurant.slug, pendingToken),
                  expiresAt: pendingGuarantee.expiresAt?.toISOString() ?? null,
                  totalAmount: pendingGuarantee.amount.toFixed(2),
                },
              }
            : {}),
          state: existing.state,
          reused: true,
          restaurantName: restaurant.name,
          date: local.date,
          time: local.time,
          partySize: hold.partySize,
          source:
            existing.source ??
            normalizeConnectSource(bodyParse.data.source, restaurant.connectAgentic),
        });
      }
      if (!hold || hold.status !== 'ACTIVE' || hold.expiresAt < new Date()) {
        // Analytics : émettre reservation_hold_expired si le hold existait (spec §8.5)
        if (hold && !isTest) {
          await emitConnectEvent(app.queues.connectAnalytics, {
            event: 'reservation_hold_expired',
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            city: restaurant.address.city,
          });
        }
        return reply.status(410).send({ error: 'Hold expired or not found' });
      }

      const policy = await loadPolicy(restaurant.id);
      if (!policy) {
        return reply.status(409).send({ error: 'No policy configured for this restaurant' });
      }

      // Customer name
      const customerName = bodyParse.data.customer.lastName
        ? `${bodyParse.data.customer.firstName} ${bodyParse.data.customer.lastName}`.trim()
        : bodyParse.data.customer.firstName;

      // Table allocation : réutilise la table du hold si possible, sinon réalloue.
      let table: Table | null = null;

      if (hold.tableId) {
        const stillAvailable = await tableAllocation.isTableAvailable({
          tableId: hold.tableId,
          startsAt: hold.slotStart,
          endsAt: hold.slotEnd,
          excludeHoldId: hold.id,
        });
        if (stillAvailable) {
          table = await db.table.findUnique({ where: { id: hold.tableId } });
        }
      }

      if (!table) {
        table = await tableAllocation.allocate({
          restaurantId: restaurant.id,
          partySize: hold.partySize,
          startsAt: hold.slotStart,
          endsAt: hold.slotEnd,
        });
      }

      if (!table) {
        return reply.status(409).send({ error: 'Slot no longer available' });
      }

      // Quota des réservations test : consommé une fois le hold et la table validés,
      // juste avant la création.
      if (isTest && !(await consumeTestBookingQuota(restaurant.id))) {
        return reply.status(429).send({ error: TEST_BOOKING_QUOTA_MESSAGE });
      }

      // Source normalization (même logique que /hold, cf. spec v1.1 §5.9)
      const source: Source = normalizeConnectSource(
        bodyParse.data.source,
        restaurant.connectAgentic,
      );

      // Le hold est persisté en UTC : on le re-rend dans le fuseau du restaurant
      // avant de l'exposer, sinon un agent lit 17:00 pour une réservation à 19:00.
      const restaurantTz = await db.restaurant.findUnique({
        where: { id: restaurant.id },
        select: { timezone: true },
      });
      const { date: localDate, time: localTime } = utcToZonedParts(
        hold.slotStart,
        restaurantTz?.timezone ?? DEFAULT_RESTAURANT_TIMEZONE,
      );

      // Empreinte bancaire : le serveur décide ; le client doit avoir accepté le montant affiché.
      const guaranteeTerms: CardGuaranteeTerms | null = isTest
        ? null
        : await findCardGuaranteeTerms({
            restaurantId: restaurant.id,
            partySize: hold.partySize,
            localDate,
          });
      if (
        guaranteeTerms &&
        bodyParse.data.cardGuarantee?.totalAmount !== guaranteeTerms.totalAmount
      ) {
        return reply.status(409).send({
          error: 'card_guarantee_required',
          cardGuarantee: publicTerms(guaranteeTerms),
          bookingUrl: restaurant.reservationUrl,
        });
      }
      let guaranteePaymentId: string | null = null;

      // RGPD consent (channel=WEB, context=web_booking_intent)
      const ipHash = req.ip ? hashIp(req.ip) : undefined;
      const whatsappConsent = createWhatsAppReminderConsent(
        bodyParse.data.whatsappReminderConsent?.accepted === true,
        ipHash,
      );

      // Idempotency: scope = web:{restaurantId}:{phoneHash}, key = holdId
      // (le hold est unique, donc 2 confirms du même hold = même réponse)
      // Rate limit per-phone (spec §8.3: 5 confirmations/heure + anti-spam §8.6)
      // Les réservations test ont leur propre quota par restaurant.
      const allowed = isTest || (await canConfirm(phoneHash));
      if (!allowed) {
        return reply.status(429).send({
          error: 'Trop de tentatives. Réessayez plus tard ou appelez le restaurant.',
        });
      }

      // Scope distinct pour les tests : un rejeu test ne peut jamais renvoyer une
      // réservation réelle du même téléphone, ni l'inverse.
      try {
        const result = await reservations.createReservation(
          {
            restaurantId: restaurant.id,
            partySize: hold.partySize,
            startsAt: hold.slotStart,
            endsAt: hold.slotEnd,
            customerName,
            customerPhone: bodyParse.data.customer.phone,
            customerEmail: isTest
              ? null
              : normalizeCustomerEmail(bodyParse.data.customer.email ?? ''),
            channel: 'WEB',
            policy,
            actor: 'connect:web',
            ...(!isTest
              ? {
                  beforeCreate: async (tx) => {
                    await new ConsentService(tx).recordConsent({
                      restaurantId: restaurant.id,
                      customerId: null,
                      reservationId: null,
                      subject: bodyParse.data.customer.phone,
                      channel: 'WEB',
                      context: 'web_booking_intent',
                      consents: {
                        reservationProcessing: true,
                        transactionalSms: true,
                        transactionalEmail: !!bodyParse.data.customer.email,
                        marketingOptIn: false,
                      },
                      consentIpHash: ipHash,
                    });
                  },
                }
              : {}),
            holdToken: bodyParse.data.holdToken,
            specialRequests: bodyParse.data.specialRequests,
            tableId: table.id,
            ...(guaranteeTerms
              ? {
                  awaitingCardGuarantee: async (
                    tx: Prisma.TransactionClient,
                    reservationId: string,
                  ) => {
                    guaranteePaymentId = await createCardGuaranteePaymentInTransaction(tx, {
                      restaurantId: restaurant.id,
                      reservationId,
                      policyId: guaranteeTerms.policyId,
                      partySize: hold.partySize,
                      expiresAt: new Date(Date.now() + WEB_CARD_GUARANTEE_HOLD_MS),
                    });
                  },
                }
              : {}),
            ...(isTest
              ? { isTest: true }
              : {
                  marketingAttributionToken: bodyParse.data.marketingAttributionToken,
                  giftCardCode: bodyParse.data.giftCardCode,
                  giftCardReservationAmount:
                    Number(restaurant.priceRange ?? 2) * 25 * hold.partySize,
                }),
            consents: {
              ...whatsappConsent.consents,
              reservationProcessing: true,
              transactionalSms: true,
              transactionalEmail: !!bodyParse.data.customer.email,
              marketingOptIn: false,
            },
          },
          {
            scope: idempotencyScope,
            key: idempotencyKey!,
            payloadHash: payloadHash!,
            ttlSeconds: 86400,
          },
        );

        // Persister la source normalisée sur la réservation
        // (CreateReservationInput ne porte pas source, on patch direct)
        if (!result.reused) {
          await db.reservation.update({
            where: { id: result.reservationId },
            data: { source },
          });
          observeReservationMutation({
            source: 'connect',
            operation: 'source_patch',
            idempotency: 'not_applicable',
            audit: 'not_applicable',
            notification: 'not_sent',
            capacity: 'unchanged',
          });
        }

        // Consentement marketing : effet de bord facultatif, ne bloque jamais la réservation.
        // Un rejeu idempotent (reused) ne ré-enregistre rien, une réservation test non plus.
        if (!isTest && !result.reused && bodyParse.data.marketingConsent) {
          try {
            const booked = await db.reservation.findUnique({
              where: { id: result.reservationId, restaurantId: restaurant.id },
              select: { customerId: true },
            });
            await recordBookingMarketingConsent({
              restaurantId: restaurant.id,
              restaurantName: restaurant.name,
              customerId: booked?.customerId ?? null,
              source: 'CONNECT',
              consent: bodyParse.data.marketingConsent,
              email: bodyParse.data.customer.email,
            });
          } catch (consentError) {
            logger.warn(
              {
                restaurantId: restaurant.id,
                err: consentError instanceof Error ? consentError.name : 'unknown',
              },
              'connect marketing consent not recorded',
            );
          }
        }

        // Émettre l'événement analytics reservation_confirmed (T9)
        // Best-effort : si la queue est down, on log un warning mais on ne fail pas.
        if (!isTest && !result.reused) {
          await emitConnectEvent(app.queues.connectAnalytics, {
            event: 'reservation_confirmed',
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            city: restaurant.address.city,
            source,
            date: localDate,
            time: localTime,
            partySize: hold.partySize,
            reservationId: result.reservationId,
          });
        }

        const managed = isReservationManagementEnabled()
          ? await db.reservation.findUnique({
              where: { id: result.reservationId, restaurantId: restaurant.id },
            })
          : null;
        const cardGuarantee =
          guaranteePaymentId && guaranteeTerms
            ? await openGuaranteeAfterBooking({
                paymentId: guaranteePaymentId,
                restaurantId: restaurant.id,
                slug: restaurant.slug,
                restaurantName: restaurant.name,
                terms: guaranteeTerms,
              })
            : null;
        return reply.send({
          reservationId: result.reservationId,
          ...(managed ? { managementUrl: reservationManagementUrl(managed) } : {}),
          status: cardGuarantee ? 'awaiting_card_guarantee' : 'confirmed',
          ...(cardGuarantee ? { cardGuarantee } : {}),
          state: result.state,
          reused: result.reused,
          restaurantName: restaurant.name,
          date: localDate,
          time: localTime,
          partySize: hold.partySize,
          source,
          giftCardApplication: result.giftCardApplication,
          ...(!result.reused && whatsappConsent.withdrawalToken
            ? { whatsappWithdrawalToken: whatsappConsent.withdrawalToken }
            : {}),
        });
      } catch (err: unknown) {
        logger.error({ err, slug: slugParse.data.slug, holdId: hold.id }, 'connect confirm failed');
        if (!isTest) {
          // Anti-spam : enregistrer l'échec (spec §8.6)
          await recordFailedConfirm(phoneHash);
          // Analytics : émettre l'événement reservation_failed (spec §8.5)
          await emitConnectEvent(app.queues.connectAnalytics, {
            event: 'reservation_failed',
            restaurantId: restaurant.id,
            restaurantSlug: restaurant.slug,
            city: restaurant.address.city,
            source,
            date: localDate,
            time: localTime,
            partySize: hold.partySize,
          });
        }
        // Créneau devenu trop proche entre le hold et la confirmation : un refus clair, pas un 500.
        if (err instanceof PolicyValidationError && err.code === INSUFFICIENT_LEAD_TIME) {
          return reply.status(409).send(leadTimeRefusal(policy.minLeadTimeMinutes));
        }
        const message = err instanceof Error ? err.message : 'Internal error';
        if (message.toLowerCase().includes('idempot')) {
          return reply.status(409).send({ error: message });
        }
        if (message.toLowerCase().includes('hold')) {
          return reply.status(410).send({ error: message });
        }
        return reply.status(500).send({ error: message });
      }
    },
  );

  // ─── Empreinte bancaire ─────────────────────────────────────
  // Conditions pour une table (affichées avant la saisie des coordonnées), puis page d'une
  // empreinte en attente, accessible par un jeton signé (retour Stripe, lien SMS).

  app.get(
    '/public/r/:slug/card-guarantee',
    {
      config: {
        rateLimit: { max: publicReadMax(RATE_LIMIT_AVAILABILITY_MAX), timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      const queryParse = AvailabilityQuerySchema.safeParse(req.query);
      if (!slugParse.success || !queryParse.success) {
        return reply.status(400).send({ error: 'Invalid request' });
      }
      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }
      const terms = await findCardGuaranteeTerms({
        restaurantId: restaurant.id,
        partySize: queryParse.data.partySize,
        localDate: queryParse.data.date,
      });
      return reply.send({
        cardGuarantee: terms ? publicTerms(terms) : null,
        // Les assistants (ChatGPT) renvoient vers la page du restaurant pour l'empreinte (spec v1).
        bookingUrl: restaurant.reservationUrl,
      });
    },
  );

  async function loadGuaranteeByToken(params: unknown) {
    const parsed = CardGuaranteeTokenParamSchema.safeParse(params);
    if (!parsed.success) return null;
    const restaurant = await canal.getPublishedBySlug(parsed.data.slug);
    if (!restaurant) return null;
    const paymentId = verifyCardGuaranteeToken(parsed.data.token, restaurant.id);
    if (!paymentId) return null;
    const payment = await db.reservationPayment.findFirst({
      where: { id: paymentId, restaurantId: restaurant.id },
      select: {
        id: true,
        restaurantId: true,
        status: true,
        amount: true,
        expiresAt: true,
        policySnapshot: true,
        reservation: { select: { partySize: true, startsAt: true, reservedAt: true } },
      },
    });
    if (!payment) return null;
    const snapshot = (payment.policySnapshot ?? {}) as { cancellationHours?: unknown };
    const cancellationHours =
      typeof snapshot.cancellationHours === 'number' ? snapshot.cancellationHours : 24;
    return { restaurant, payment, cancellationHours };
  }

  app.get(
    '/public/r/:slug/card-guarantee/:token',
    {
      config: {
        rateLimit: { max: publicReadMax(RATE_LIMIT_AVAILABILITY_MAX), timeWindow: '1 minute' },
      },
    },
    async (req, reply) => {
      const found = await loadGuaranteeByToken(req.params);
      if (!found) return reply.status(404).send({ error: 'card_guarantee_not_found' });
      const { restaurant, payment, cancellationHours } = found;
      const startsAt = payment.reservation.startsAt ?? payment.reservation.reservedAt;
      // tenant-scoping: global — table Restaurant, id déjà résolu par le slug public.
      const restaurantTz = await db.restaurant.findUnique({
        where: { id: restaurant.id },
        select: { timezone: true },
      });
      const local = utcToZonedParts(
        startsAt,
        restaurantTz?.timezone ?? DEFAULT_RESTAURANT_TIMEZONE,
      );
      return reply.send({
        status: publicCardGuaranteeStatus(payment.status, payment.expiresAt),
        restaurantName: restaurant.name,
        date: local.date,
        time: local.time,
        partySize: payment.reservation.partySize,
        amountPerPerson: payment.amount.div(payment.reservation.partySize).toFixed(2),
        totalAmount: payment.amount.toFixed(2),
        cancellationHours,
        freeCancellationUntil: new Date(
          startsAt.getTime() - cancellationHours * 3_600_000,
        ).toISOString(),
        expiresAt: payment.expiresAt?.toISOString() ?? null,
      });
    },
  );

  app.post(
    '/public/r/:slug/card-guarantee/:token/checkout',
    { config: { rateLimit: { max: RATE_LIMIT_CONFIRM_MAX, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!CardGuaranteeCheckoutSchema.safeParse(req.body).success) {
        return reply.status(400).send({ error: 'card_guarantee_terms_required' });
      }
      const found = await loadGuaranteeByToken(req.params);
      if (!found) return reply.status(404).send({ error: 'card_guarantee_not_found' });
      if (
        publicCardGuaranteeStatus(found.payment.status, found.payment.expiresAt) !== 'awaiting_card'
      ) {
        return reply.status(409).send({ error: 'card_guarantee_closed' });
      }
      try {
        const { url } = await openCardGuaranteeCheckout({
          payment: found.payment,
          slug: found.restaurant.slug,
          restaurantName: found.restaurant.name,
          cancellationHours: found.cancellationHours,
          termsAcceptedAt: new Date(),
        });
        return reply.send({ checkoutUrl: url });
      } catch (error) {
        logger.warn(
          {
            paymentId: found.payment.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'connect card guarantee checkout failed',
        );
        return reply.status(503).send({ error: 'card_guarantee_unavailable' });
      }
    },
  );

  // ─── 5. POST /public/r/:slug/waiting-list ────────────────────
  // Rejoint la file d'attente pour un créneau plein.

  app.post(
    '/public/r/:slug/waiting-list',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_WAITING_LIST_JOIN_MAX,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      if (!slugParse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: slugParse.error.format() });
      }
      const bodyParse = WaitingListJoinInputSchema.safeParse(req.body);
      if (!bodyParse.success) {
        return reply.status(400).send({ error: 'Invalid body', details: bodyParse.error.format() });
      }

      const { date, time, partySize, customer, preferredSectionId, source } = bodyParse.data;

      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      const settings = await db.restaurantExposureSettings.findUnique({
        where: { restaurantId: restaurant.id },
      });

      const capacitySpecials = (settings?.capacitySpecials ?? {}) as Record<string, unknown>;
      const waitingListEnabled = capacitySpecials.waitingListEnabled === true;
      const waitingListMaxEntriesPerSlot =
        typeof capacitySpecials.waitingListMaxEntriesPerSlot === 'number'
          ? capacitySpecials.waitingListMaxEntriesPerSlot
          : 10;

      const maxPartySize = settings?.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE;
      if (partySize > maxPartySize) {
        return reply.status(409).send({
          error: `Party size ${partySize} exceeds max (${maxPartySize})`,
        });
      }

      const restaurantWithTz = await db.restaurant.findUnique({
        where: { id: restaurant.id },
        select: { timezone: true },
      });
      const timeZone = restaurantWithTz?.timezone ?? 'Europe/Paris';

      const serviceDurationMinutes = resolveServiceDurationMinutes(capacitySpecials);
      const slotStart = zonedTimeToUtc(date, time, timeZone);
      const slotEnd = new Date(slotStart.getTime() + serviceDurationMinutes * 60_000);

      const availabilityDto = await availability.getAvailability({
        restaurantId: restaurant.id,
        date,
        partySize,
        preferredSectionId,
      });

      const slot = availabilityDto.slots.find((s) => s.time === time);
      if (!slot) {
        return reply.status(400).send({ error: 'invalid_slot' });
      }
      // Un créneau passé est « indisponible » pour le moteur, mais il n'est pas « complet » : la liste
      // d'attente n'a de sens que pour un créneau à venir.
      if (isSlotStartPast(slotStart)) {
        return reply.status(400).send({ error: 'invalid_slot' });
      }
      // Surface en ligne : un créneau dans le délai minimum ne se réserve pas, donc ne s'attend pas non plus.
      const minLeadTimeMinutes =
        settings?.minLeadTimeMinutes ?? DEFAULT_ONLINE_MIN_LEAD_TIME_MINUTES;
      if (isSlotTooSoon(slotStart, minLeadTimeMinutes)) {
        return reply.status(409).send(leadTimeRefusal(minLeadTimeMinutes));
      }
      if (slot.available) {
        return reply.status(409).send({ error: 'slot_now_available' });
      }

      const allocatedTable = await tableAllocation.allocate(
        {
          restaurantId: restaurant.id,
          partySize,
          startsAt: slotStart,
          endsAt: slotEnd,
          preferredSectionId,
        },
        undefined,
        { readOnly: true },
      );

      if (allocatedTable) {
        return reply.status(409).send({ error: 'slot_now_available' });
      }

      try {
        const { entry, actionToken } = await waitingList.join({
          restaurantId: restaurant.id,
          partySize,
          customerFirstName: customer.firstName,
          customerLastName: customer.lastName,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          slotStart,
          preferredSectionId,
          source,
          waitingListEnabled,
          waitingListMaxEntriesPerSlot,
          serviceDurationMinutes,
        });

        await emitConnectEvent(app.queues.connectAnalytics, {
          event: 'waiting_list_joined',
          restaurantId: restaurant.id,
          restaurantSlug: restaurant.slug,
          city: restaurant.address.city,
          source,
          date,
          time,
          partySize,
        });

        return reply.status(201).send({
          entryId: entry.id,
          position: entry.position,
          actionToken,
          expiresAt: entry.expiresAt.toISOString(),
        });
      } catch (err: unknown) {
        if (err instanceof WaitingListSlotFullError) {
          return reply.status(409).send({ error: 'waiting_list_full' });
        }
        if (err instanceof WaitingListAlreadyExistsError) {
          return reply.status(409).send({ error: 'already_in_waiting_list' });
        }
        if (err instanceof WaitingListDisabledError) {
          return reply.status(400).send({ error: 'waiting_list_not_enabled' });
        }
        logger.error({ err, slug: slugParse.data.slug }, 'connect waiting-list join failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // Retrait du rappel WhatsApp : jeton dedie, sans modifier la reservation.
  app.post(
    '/public/r/:slug/whatsapp-consent/withdraw',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const params = SlugParamSchema.safeParse(req.params);
      const body = z
        .object({
          reservationId: z.string().min(1).max(100),
          token: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .safeParse(req.body);
      if (!params.success || !body.success)
        return reply.status(400).send({ error: 'Invalid request' });
      // tenant-scoping: global — resolve the public slug only; consent access then requires
      // the matching restaurant, reservation ID and withdrawal token (no booking data exposed).
      const alias = getDemoSlugAlias(params.data.slug);
      // tenant-scoping: global — this public endpoint only resolves the unique slug to an ID.
      const restaurant =
        (await db.restaurant.findUnique({
          where: { slug: params.data.slug },
          select: { id: true },
        })) ??
        (alias
          ? await db.restaurant.findUnique({ where: { slug: alias }, select: { id: true } })
          : null);
      if (!restaurant) return reply.status(404).send({ error: 'Not found' });
      const outcome = await withdrawWhatsAppReminderConsent(
        db,
        restaurant.id,
        body.data.reservationId,
        body.data.token,
      );
      if (outcome === 'not_found') return reply.status(404).send({ error: 'Not found' });
      if (outcome === 'conflict') return reply.status(409).send({ error: 'Veuillez réessayer.' });
      return reply.send({ status: 'withdrawn' });
    },
  );

  // ─── 6. DELETE /public/r/:slug/waiting-list/:entryId ──────────
  // Annule une entrée via son token d'action.

  app.delete(
    '/public/r/:slug/waiting-list/:entryId',
    {
      config: {
        rateLimit: {
          max: RATE_LIMIT_WAITING_LIST_CANCEL_MAX,
          timeWindow: '1 hour',
        },
      },
    },
    async (req, reply) => {
      const slugParse = SlugParamSchema.safeParse(req.params);
      if (!slugParse.success) {
        return reply.status(400).send({ error: 'Invalid slug', details: slugParse.error.format() });
      }
      const params = req.params as { entryId: string };
      const tokenParse = CancelWaitingListTokenSchema.safeParse(req.query ?? {});
      if (!tokenParse.success) {
        return reply
          .status(400)
          .send({ error: 'Invalid token', details: tokenParse.error.format() });
      }

      const restaurant = await canal.getPublishedBySlug(slugParse.data.slug);
      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found or not published' });
      }

      try {
        await waitingList.cancelByToken({
          entryId: params.entryId,
          actionToken: tokenParse.data.token,
          restaurantId: restaurant.id,
        });
        return reply.status(200).send({ status: 'cancelled' });
      } catch (err: unknown) {
        if (err instanceof WaitingListAlreadyPromotedError) {
          return reply.status(409).send({ error: 'already_promoted' });
        }
        if (err instanceof WaitingListEntryNotFoundError) {
          return reply.status(404).send({ error: 'entry_not_found' });
        }
        logger.error({ err, slug: slugParse.data.slug }, 'connect waiting-list cancel failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── KPIs pilote P1 (réservés aux opérateurs Suppernote) ───────────
  // GET /api/internal/connect-kpis : agrège les 4 critères go/no-go P1.
  // Même garde que /api/internal/pilot-kpis : la route est joignable depuis
  // Internet, « interne » ne décrit que son audience.
  const connectKpis = new ConnectKpiService();

  app.get(
    '/api/internal/connect-kpis',
    { preHandler: requireSokarOperator() },
    async (_req, reply) => {
      try {
        const kpis = await connectKpis.getKpis();
        return reply.send(kpis);
      } catch (err) {
        logger.error({ err }, 'connect kpis failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );
}

/**
 * Charge le PolicySnapshot depuis `RestaurantExposureSettings`.
 * Renvoie null si pas configuré (très rare en pratique — seed met des défauts).
 */
async function loadPolicy(restaurantId: string): Promise<PolicySnapshot | null> {
  const settings = await db.restaurantExposureSettings.findUnique({
    where: { restaurantId },
  });
  if (!settings) return null;
  return buildPolicySnapshot({
    policyVersion: settings.quoteTtlSeconds ? '2026-06-20' : '2026-06-20',
    maxPartySize: settings.maxPartySize,
    minLeadTimeMinutes: settings.minLeadTimeMinutes,
    requireManualValidation: settings.requireManualValidation,
    quoteTtlSeconds: settings.quoteTtlSeconds,
    holdTtlSeconds: settings.holdTtlSeconds,
    noShowPolicy: settings.noShowPolicy,
    notificationChannels: settings.notificationChannels,
    capacitySpecials: settings.capacitySpecials as Record<string, unknown> | null,
  });
}

/** Hash IP (RGPD) — SHA-256 truncated */
function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

// ─── Helpers T7 (pages locales) ───────────────────────────────

const CITY_SLUG_REGEX = /^[a-z0-9-]+$/;
function isValidCitySlug(s: string): boolean {
  return s.length >= 2 && s.length <= 80 && CITY_SLUG_REGEX.test(s);
}

type CityRow = {
  city: string;
  citySlug: string;
  total: number;
  cuisines: Array<{ name: string; slug: string; count: number }>;
};
