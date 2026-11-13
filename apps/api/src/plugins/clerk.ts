import { clerkPlugin, getAuth } from '@clerk/fastify';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  resolveRestaurantContext,
  RestaurantContextError,
  type RestaurantContext,
} from '../modules/restaurants/site-context';
import { claimInvitedMembership } from '../modules/restaurants/team.service';
import {
  evaluateRolePolicy,
  READ_ONLY_MESSAGE,
  ROLE_FORBIDDEN_MESSAGE,
} from '../modules/restaurants/role-policy';
import { db } from '../shared/db/client';

export function isClerkConfigured() {
  return Boolean(process.env.CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY);
}

export async function registerClerk(app: FastifyInstance) {
  if (!isClerkConfigured()) {
    app.log.warn('Clerk is not configured; protected API routes will return 503');
    return;
  }

  await app.register(clerkPlugin, {
    publishableKey: process.env.CLERK_PUBLISHABLE_KEY as string,
    secretKey: process.env.CLERK_SECRET_KEY as string,
    // Authentifier avant le limiteur global, qui compte par utilisateur (rate-limit.ts).
    hookName: 'onRequest',
  });
}

/**
 * Middleware qui exige une organisation (restaurant).
 * Injecte restaurantId (= orgId) et userId dans la requête.
 *
 * Logging: replaces the request's child logger with one enriched with
 * `restaurant_id` and `user_id`. Every subsequent `req.log.info(...)`
 * in the handler chain (and any DB/service call that uses the request
 * logger) automatically carries these bindings, which makes it
 * straightforward to filter production logs per tenant or per user
 * when debugging a 5xx reported by a specific restaurant.
 */
export function requireOrg() {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Staging demo mode : pas de session requise, on injecte le restaurant démo.
    // DEMO_STAGING n'est défini qu'en staging → la prod reste inchangée.
    const demoMode = process.env.NODE_ENV !== 'production' || process.env.DEMO_STAGING === '1';
    if (demoMode && process.env.DEMO_RESTAURANT_ID) {
      const demoRestaurantId = process.env.DEMO_RESTAURANT_ID;
      const demoAnchor = await db.restaurant.findUnique({
        where: { id: demoRestaurantId },
        select: { id: true, accountId: true, siteStatus: true },
      });
      if (!demoAnchor) {
        return reply.status(404).send({
          error: 'DEMO_RESTAURANT_NOT_FOUND',
          message: 'Restaurant de démonstration indisponible.',
        });
      }
      if (demoAnchor.siteStatus === 'SUSPENDED' || demoAnchor.siteStatus === 'ARCHIVED') {
        return reply.status(404).send({
          error: 'SITE_UNAVAILABLE',
          message: 'Établissement indisponible ou accès refusé.',
        });
      }
      const requestedSiteId = getRequestedSiteId(req);
      let demoRestaurant = demoAnchor;
      if (requestedSiteId && requestedSiteId !== demoRestaurantId) {
        if (!demoAnchor.accountId) {
          return reply.status(404).send({
            error: 'SITE_ACCESS_DENIED',
            message: 'Établissement indisponible ou accès refusé.',
          });
        }
        const requestedSite = await db.restaurant.findUnique({
          where: { id: requestedSiteId },
          select: { id: true, accountId: true, siteStatus: true },
        });
        if (
          !requestedSite ||
          requestedSite.accountId !== demoAnchor.accountId ||
          requestedSite.siteStatus === 'SUSPENDED' ||
          requestedSite.siteStatus === 'ARCHIVED'
        ) {
          return reply.status(404).send({
            error: 'SITE_ACCESS_DENIED',
            message: 'Établissement indisponible ou accès refusé.',
          });
        }
        demoRestaurant = requestedSite;
      }
      req.restaurantId = demoRestaurant.id;
      req.siteId = req.restaurantId;
      req.accountId = demoAnchor.accountId ?? undefined;
      req.clerkOrganizationId = demoRestaurantId;
      req.userId = process.env.DEMO_USER_ID ?? 'demo-user';
      req.siteRole = 'OWNER';
      req.log = req.log.child({
        restaurant_id: req.restaurantId,
        site_id: req.siteId,
        user_id: req.userId,
      });
      return;
    }

    if (!isClerkConfigured()) {
      return reply.status(503).send({ error: 'Authentication provider not configured' });
    }

    const { orgId, userId } = getAuth(req);
    if (!orgId) {
      return reply.status(401).send({ error: 'Organization required' });
    }

    const requestedSiteId = getRequestedSiteId(req);
    try {
      const context = await resolveContextForMember({
        organizationId: orgId,
        userId,
        requestedSiteId,
        allowUnassigned: req.routeOptions?.url === '/api/auth/sync' && req.method === 'POST',
      });
      req.restaurantId = context.siteId;
      req.siteId = context.siteId;
      req.accountId = context.accountId;
      req.clerkOrganizationId = context.clerkOrganizationId;
      req.siteRole = context.role;
      const decision = evaluateRolePolicy({
        role: context.role,
        method: req.method,
        route: req.routeOptions?.url,
      });
      if (!decision.allowed) {
        return reply.status(403).send({
          error: decision.code,
          message:
            decision.code === 'READ_ONLY_ACCESS' ? READ_ONLY_MESSAGE : ROLE_FORBIDDEN_MESSAGE,
        });
      }
    } catch (error) {
      if (error instanceof RestaurantContextError) {
        req.log.warn(
          { code: error.code, organization_id: orgId, requested_site_id: requestedSiteId ?? null },
          'Restaurant site context denied',
        );
        return reply.status(error.code === 'ACCOUNT_SUSPENDED' ? 403 : 404).send({
          error: error.code,
          message: 'Établissement indisponible ou accès refusé.',
        });
      }
      throw error;
    }
    req.userId = userId;
    // Re-bind req.log to a child logger that carries restaurant + user.
    // We keep request_id (already on the parent) by chaining .child().
    req.log = req.log.child({
      account_id: req.accountId ?? null,
      clerk_organization_id: orgId,
      restaurant_id: req.restaurantId,
      site_id: req.siteId,
      site_role: req.siteRole,
      user_id: userId ?? null,
    });
  };
}

/**
 * Un invité qui vient d'accepter appartient à l'organisation Clerk mais n'a pas encore de
 * membership Suppernote : on lit le rôle de son invitation, on le rattache, puis on résout de nouveau.
 */
async function resolveContextForMember(input: {
  organizationId: string;
  userId?: string | null;
  requestedSiteId?: string;
  allowUnassigned?: boolean;
}): Promise<RestaurantContext> {
  try {
    return await resolveRestaurantContext(db, input);
  } catch (error) {
    if (
      error instanceof RestaurantContextError &&
      error.code === 'SITE_ACCESS_DENIED' &&
      input.userId
    ) {
      const claimed = await claimInvitedMembership({
        organizationId: input.organizationId,
        userId: input.userId,
      });
      if (claimed) return resolveRestaurantContext(db, input);
    }
    throw error;
  }
}

function getRequestedSiteId(req: FastifyRequest): string | undefined {
  const value = req.headers['x-sokar-site-id'];
  const siteId = Array.isArray(value) ? value[0] : value;
  const trimmed = siteId?.trim();
  return trimmed && trimmed.length <= 128 ? trimmed : undefined;
}

/**
 * Middleware qui exige une session utilisateur (login simple sans org).
 */
export function requireAuth(options: { allowDemo?: boolean } = {}) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Staging demo mode : voir requireOrg(). DEMO_STAGING isolé à la staging.
    const demoMode = process.env.NODE_ENV !== 'production' || process.env.DEMO_STAGING === '1';
    if (options.allowDemo !== false && demoMode && process.env.DEMO_RESTAURANT_ID) {
      req.userId = process.env.DEMO_USER_ID ?? 'demo-user';
      req.log = req.log.child({ user_id: req.userId });
      return;
    }

    if (!isClerkConfigured()) {
      return reply.status(503).send({ error: 'Authentication provider not configured' });
    }

    const { userId } = getAuth(req);
    if (!userId) {
      return reply.status(401).send({ error: 'Authentication required' });
    }
    req.userId = userId;
    req.log = req.log.child({ user_id: userId });
  };
}

/**
 * Middleware for Suppernote-wide operator actions.
 *
 * Organization membership is intentionally not enough here: provisioning and
 * restaurant-health routes can address any tenant. The allowlist is kept in
 * the server environment so a restaurant member can never grant themselves
 * operator access through a request body or a Clerk organization role.
 */
export function requirePlatformOperator() {
  // Les opérations globales exigent une vraie session en staging/production.
  // Le compte démo reste réservé à la prévisualisation locale.
  const authenticate = requireAuth({
    allowDemo: process.env.NODE_ENV !== 'production' && process.env.DEMO_STAGING !== '1',
  });

  return async (req: FastifyRequest, reply: FastifyReply) => {
    await authenticate(req, reply);
    if (reply.sent) return;

    const operatorIds = new Set(
      (process.env.SOKAR_OPERATOR_USER_IDS ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    );

    // The local demo has no Clerk session and uses the explicit demo user
    // injected by requireAuth(). Keep that preview usable without weakening
    // staging or production: DEMO_STAGING and NODE_ENV=production still
    // require the server-side allowlist above.
    const localDemoOperator =
      process.env.NODE_ENV !== 'production' &&
      process.env.DEMO_STAGING !== '1' &&
      Boolean(process.env.DEMO_RESTAURANT_ID) &&
      req.userId === (process.env.DEMO_USER_ID ?? 'demo-user');

    if (!req.userId || (!operatorIds.has(req.userId) && !localDemoOperator)) {
      req.log.warn({ user_id: req.userId ?? null }, 'Suppernote operator access denied');
      return reply.status(403).send({ error: 'Suppernote operator access required' });
    }
  };
}
