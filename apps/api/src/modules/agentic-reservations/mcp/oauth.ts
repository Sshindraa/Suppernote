/**
 * OAuth 2.0 pour MCP — flow Authorization Code avec PKCE.
 *
 * Implémente le minimum pour que Claude.ai, ChatGPT et Mistral
 * puissent s'enregistrer comme Custom Connectors via OAuth discovery.
 *
 * Endpoints:
 * - GET  /.well-known/oauth-authorization-server  → metadata (RFC 8414)
 * - POST /oauth/register                           → dynamic client registration (RFC 7591)
 * - GET  /oauth/authorize                          → consent page (auto-approve MVP)
 * - POST /oauth/authorize                          → process consent, redirect with code
 * - POST /oauth/token                              → exchange code → token, refresh token
 *
 * Stockage Redis (db 1, redisCache) :
 * - sokar:oauth:client:<clientId>    → JSON { secret, redirectUris, name } (TTL 365j)
 * - sokar:oauth:code:<code>          → JSON { clientId, restaurantId, scopes, redirectUri, codeChallenge, codeChallengeMethod } (TTL 10min)
 * - sokar:oauth:token:<token>        → JSON { clientId, restaurantId, scopes } (TTL 30j)
 * - sokar:oauth:refresh:<token>      → JSON { clientId, restaurantId, scopes } (TTL 90j)
 *
 * Sécurité :
 * - Les codes et tokens sont des crypto.randomUUID() (128 bits d'entropie).
 * - PKCE S256 obligatoire si le client fournit un code_challenge.
 * - Les redirect_uri sont validés contre ceux enregistrés lors du register.
 * - En production, l'issuer est lu depuis OAUTH_ISSUER_URL.
 *
 * Production : le consentement est public (pas de login Clerk).
 * Le restaurateur active MCP dans son dashboard (coté admin, avec Clerk).
 * Le client (ChatGPT, Claude.ai, Mistral) fait un simple approve/deny.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { redisCache } from '../../../shared/redis/client';
import { logger } from '../../../shared/logger/pino';
import { env } from '../../../env';
import type { AuthContext } from './auth';

// ─── TTLs ──────────────────────────────────────────────
const TTL_CLIENT = 60 * 60 * 24 * 365; // 365 jours
const TTL_CODE = 60 * 10; // 10 minutes
const TTL_TOKEN = 60 * 60 * 24 * 30; // 30 jours
const TTL_REFRESH = 60 * 60 * 24 * 90; // 90 jours

// ─── Helpers ───────────────────────────────────────────

export function getIssuer(): string {
  return env.OAUTH_ISSUER_URL || env.API_URL;
}

export function getProtectedResourceMetadataUrl(): string {
  return `${getIssuer().replace(/\/+$/u, '')}/.well-known/oauth-protected-resource`;
}

function buildAuthorizationRedirect(
  redirectUri: string,
  parameters: Record<string, string>,
): string {
  const redirect = new URL(redirectUri);
  for (const [name, value] of Object.entries(parameters)) {
    redirect.searchParams.set(name, value);
  }
  redirect.searchParams.set('iss', getIssuer());
  return redirect.toString();
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

/** URL publique canonique utilisée par les pages OAuth Suppernote. */
function getPublicSiteUrl(): string {
  const configuredSiteUrl = process.env.SITE_URL?.trim();

  if (configuredSiteUrl) {
    try {
      const siteUrl = new URL(configuredSiteUrl);
      if (!['localhost', '127.0.0.1', '::1'].includes(siteUrl.hostname)) {
        return siteUrl.origin;
      }
    } catch {
      // Utiliser l'URL canonique si SITE_URL est absent ou mal formé.
    }
  }

  return 'https://suppernote.com';
}

/** URL de l'icône officielle utilisée par Suppernote Connect. */
function getBrandIconUrl(): string {
  const siteUrl = getPublicSiteUrl();
  return siteUrl.endsWith('/icon.svg') ? siteUrl : `${siteUrl}/icon.svg`;
}

/**
 * Vérifie un code_verifier PKCE contre le code_challenge stocké.
 */
function verifyPkce(
  codeVerifier: string,
  codeChallenge: string | undefined,
  method: string | undefined,
): boolean {
  if (!codeChallenge) return true; // Pas de PKCE demandé
  // S256 uniquement — 'plain' est déprécié (RFC 7636) et refusé
  if (method === 'S256') {
    const computed = base64url(createHash('sha256').update(codeVerifier).digest());
    return computed === codeChallenge;
  }
  return false;
}

async function getJson<T>(key: string): Promise<T | null> {
  const raw = await redisCache.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function setJson(key: string, value: unknown, ttlSec: number): Promise<void> {
  await redisCache.set(key, JSON.stringify(value), 'EX', String(ttlSec));
}

const EXCHANGE_TOKEN_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
if KEYS[3] ~= '' then redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[4]) end
redis.call('DEL', KEYS[1])
if KEYS[4] ~= '' then redis.call('DEL', KEYS[4]) end
return 1
`;

async function exchangeToken(
  originalKey: string,
  original: AuthCode | StoredToken,
  next: StoredToken,
  previousAccessToken?: string,
): Promise<boolean> {
  const result = await redisCache.eval(
    EXCHANGE_TOKEN_SCRIPT,
    4,
    originalKey,
    `sokar:oauth:token:${next.accessToken}`,
    next.refreshToken ? `sokar:oauth:refresh:${next.refreshToken}` : '',
    previousAccessToken ? `sokar:oauth:token:${previousAccessToken}` : '',
    JSON.stringify(original),
    JSON.stringify(next),
    String(TTL_TOKEN),
    String(TTL_REFRESH),
  );
  return result === 1;
}

// ─── Types ─────────────────────────────────────────────

type RegisteredClient = {
  clientId: string;
  clientSecretHash: string | null; // SHA-256 hash, jamais le plaintext
  redirectUris: string[];
  clientName: string;
  createdAt: string;
  tokenEndpointAuthMethod: 'client_secret_basic' | 'client_secret_post' | 'none';
  grantTypes: string[];
  responseTypes: string[];
};

type AuthCode = {
  clientId: string;
  restaurantId: string | null; // null = public access (any MCP-enabled restaurant)
  restaurantName: string | null;
  scopes: string[];
  redirectUri: string;
  resource?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
};

type StoredToken = {
  clientId: string;
  restaurantId: string | null; // null = public access (any MCP-enabled restaurant)
  restaurantName: string | null;
  scopes: string[];
  resource?: string;
  accessToken: string;
  refreshToken: string;
};

// ─── Validation des tokens OAuth ───────────────────────

/**
 * Valide un token OAuth (opaque, stocké dans Redis).
 * Retourne un AuthContext si valide, null sinon.
 */
export async function validateOAuthToken(token: string): Promise<AuthContext | null> {
  const data = await getJson<StoredToken>(`sokar:oauth:token:${token}`);
  if (!data) return null;
  // Legacy tokens without resource remain valid until expiry; new tokens are bound below.
  if (data.resource !== undefined && data.resource !== getIssuer()) return null;

  // Convertir vers AuthContext (même forme que l'auth par API key)
  return {
    clientId: data.clientId,
    clientName: 'oauth-client',
    restaurantId: data.restaurantId,
    scopes: data.scopes,
    allowedOrigins: [],
    credentialType: 'oauth',
  };
}

// ─── Pre-allowed redirect URIs for known MCP platforms ──
// Si un client ne fait pas de DCR, on accepte ces redirect URIs
const KNOWN_REDIRECT_PATTERNS: { pattern: RegExp; name: string }[] = [
  { pattern: /^https:\/\/claude\.ai\/api\/mcp\/auth_callback$/, name: 'Claude' },
  { pattern: /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\/[a-zA-Z0-9_-]+$/, name: 'Claude' },
  {
    pattern: /^https:\/\/chatgpt\.com\/backend-api\/mcp\/[a-zA-Z0-9_-]+\/callback$/,
    name: 'ChatGPT',
  },
  {
    // ChatGPT's current custom-connector flow uses this callback shape.
    pattern: /^https:\/\/chatgpt\.com\/connector\/oauth\/[a-zA-Z0-9_-]+$/,
    name: 'ChatGPT',
  },
  {
    // Stable callback used when RFC 9207 issuer identification is advertised.
    pattern: /^https:\/\/chatgpt\.com\/connector_platform_oauth_redirect$/,
    name: 'ChatGPT',
  },
  { pattern: /^https:\/\/chat\.mistral\.ai\/[a-zA-Z0-9_-]+\/callback$/, name: 'Mistral' },
  { pattern: /^http:\/\/localhost:\d+\/callback$/, name: 'Claude Code' },
  { pattern: /^http:\/\/127\.0\.0\.1:\d+\/callback$/, name: 'Claude Code' },
];

function matchKnownRedirect(uri: string): string | null {
  for (const entry of KNOWN_REDIRECT_PATTERNS) {
    if (entry.pattern.test(uri)) return entry.name;
  }
  return null;
}

type TokenEndpointAuthMethod = RegisteredClient['tokenEndpointAuthMethod'];

function parseTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod | null {
  if (value === undefined) return 'client_secret_basic';
  if (value === 'client_secret_basic' || value === 'client_secret_post' || value === 'none') {
    return value;
  }
  return null;
}

function normalizeGrantTypes(value: unknown): string[] | null {
  if (value === undefined) return ['authorization_code', 'refresh_token'];
  if (!Array.isArray(value) || value.length === 0 || value.length > 2) return null;
  const grantTypes = [...new Set(value)];
  if (
    !grantTypes.includes('authorization_code') ||
    grantTypes.some((grantType) => !['authorization_code', 'refresh_token'].includes(grantType))
  ) {
    return null;
  }
  return grantTypes;
}

function normalizeResponseTypes(value: unknown): string[] | null {
  if (value === undefined) return ['code'];
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== 'code') return null;
  return ['code'];
}

function validateRedirectUri(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  try {
    const uri = new URL(value);
    if (uri.hash || uri.username || uri.password) return false;
    if (uri.protocol === 'https:') return true;
    if (uri.protocol !== 'http:' || !uri.port) return false;
    return ['localhost', '127.0.0.1', '[::1]'].includes(uri.hostname);
  } catch {
    return false;
  }
}

function normalizeRedirectUris(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10) return null;
  if (!value.every(validateRedirectUri)) return null;
  return [...new Set(value)];
}

function extractClientCredentials(req: FastifyRequest): {
  clientId?: string;
  clientSecret?: string;
  clientSecretSource?: 'basic' | 'body';
} {
  const body = (req.body ?? {}) as { client_id?: string; client_secret?: string };
  let clientId = body.client_id;
  let clientSecret = body.client_secret;
  let clientSecretSource: 'basic' | 'body' | undefined = clientSecret ? 'body' : undefined;

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Basic ')) {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator >= 0) {
      clientId = decoded.slice(0, separator);
      clientSecret = decoded.slice(separator + 1);
      clientSecretSource = 'basic';
    }
  }

  return { clientId, clientSecret, clientSecretSource };
}

function isValidClientAuthentication(
  client: RegisteredClient | null,
  clientSecret: string | undefined,
  clientSecretSource: 'basic' | 'body' | undefined,
): boolean {
  if (!client) return true; // Public pre-registered MCP clients use PKCE only.
  const method = client.tokenEndpointAuthMethod;
  if (method === 'none') return !clientSecret;
  if (method === 'client_secret_basic' && clientSecretSource !== 'basic') return false;
  if (method === 'client_secret_post' && clientSecretSource !== 'body') return false;
  if (!client.clientSecretHash || !clientSecret) return false;

  const providedHash = createHash('sha256').update(clientSecret).digest('hex');
  const provided = Buffer.from(providedHash);
  const expected = Buffer.from(client.clientSecretHash);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

async function deleteStoredTokenPair(tokenData: StoredToken): Promise<void> {
  const keys = [
    tokenData.accessToken ? `sokar:oauth:token:${tokenData.accessToken}` : null,
    tokenData.refreshToken ? `sokar:oauth:refresh:${tokenData.refreshToken}` : null,
  ].filter((key): key is string => Boolean(key));
  if (keys.length > 0) await redisCache.del(...keys);
}

// ─── Rate limit Redis pour endpoints OAuth ───────────
// Anti-brute-force sur /token, anti-spam sur /register.
// Partagé entre tous les processus/VM via redisCache (db 1).
const OAUTH_RATE_TOKEN = { max: 10, windowMs: 60_000, key: 'token' };
const OAUTH_RATE_REGISTER = { max: 5, windowMs: 60_000, key: 'register' };
const OAUTH_RATE_REVOKE = { max: 20, windowMs: 60_000, key: 'revoke' };

// INCR atomique + PEXPIRE uniquement à la première incrémentation (fenêtre fixe).
const OAUTH_RATE_LIMIT_SCRIPT = `
  local key = KEYS[1]
  local count = redis.call('INCR', key)
  if count == 1 then
    redis.call('PEXPIRE', key, ARGV[1])
  end
  return count
`;

async function checkOauthRate(
  ip: string,
  config: { max: number; windowMs: number; key: string },
): Promise<boolean> {
  const redisKey = `sokar:oauth:rate:${config.key}:${ip}`;
  const count = Number(
    await redisCache['eval'](OAUTH_RATE_LIMIT_SCRIPT, 1, redisKey, config.windowMs),
  );
  return count <= config.max;
}

/**
 * Page publique d'usage du connecteur (installation, données, outils). Elle vit sur le site public
 * de l'environnement : api.suppernote.com → suppernote.com, api-staging.suppernote.com → staging.suppernote.com.
 */
export function mcpDocumentationUrl(
  issuer: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const configured = environment.MCP_DOCUMENTATION_URL?.trim();
  if (configured) return configured;
  const url = new URL(issuer);
  url.hostname = url.hostname.replace(/^api[.-]/, '');
  return `${url.origin}/assistants-ia`;
}

// ─── Routes ────────────────────────────────────────────

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const { db } = await import('../../../shared/db/client');

  // ── 0. Protected resource metadata (MCP spec 2025-06-18) ──
  app.get(
    '/.well-known/oauth-protected-resource',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const issuer = getIssuer();
      return reply.header('Cache-Control', 'public, max-age=3600').send({
        resource: issuer,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header'],
        scopes_supported: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        resource_documentation: mcpDocumentationUrl(issuer),
      });
    },
  );

  // ── 1. Metadata discovery (RFC 8414) ─────────────────
  app.get(
    '/.well-known/oauth-authorization-server',
    { config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const issuer = getIssuer();
      // Client ID Metadata Documents are not implemented; DCR remains available.
      return reply.header('Cache-Control', 'public, max-age=3600').send({
        issuer,
        authorization_response_iss_parameter_supported: true,
        authorization_endpoint: `${issuer}/oauth/authorize`,
        token_endpoint: `${issuer}/oauth/token`,
        registration_endpoint: `${issuer}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: [
          'client_secret_post',
          'client_secret_basic',
          'none',
        ],
        code_challenge_methods_supported: ['S256'],
        scopes_supported: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        revocation_endpoint: `${issuer}/oauth/revoke`,
      });
    },
  );

  // ── 2. Dynamic Client Registration (RFC 7591) ────────
  app.post('/oauth/register', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await checkOauthRate(req.ip, OAUTH_RATE_REGISTER))) {
      return reply
        .status(429)
        .send({ error: 'too_many_requests', error_description: 'Too many registrations' });
    }
    const body = req.body as {
      client_name?: string;
      redirect_uris?: string[];
      token_endpoint_auth_method?: string;
      grant_types?: string[];
      response_types?: string[];
    };

    const redirectUris = normalizeRedirectUris(body.redirect_uris);
    const tokenEndpointAuthMethod = parseTokenEndpointAuthMethod(body.token_endpoint_auth_method);
    const grantTypes = normalizeGrantTypes(body.grant_types);
    const responseTypes = normalizeResponseTypes(body.response_types);
    if (!redirectUris || !tokenEndpointAuthMethod || !grantTypes || !responseTypes) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description:
          'redirect_uris, token_endpoint_auth_method, grant_types and response_types must be valid',
      });
    }
    if (
      typeof body.client_name !== 'undefined' &&
      (typeof body.client_name !== 'string' ||
        body.client_name.length === 0 ||
        body.client_name.length > 200)
    ) {
      return reply.status(400).send({
        error: 'invalid_client_metadata',
        error_description: 'client_name must be between 1 and 200 characters',
      });
    }

    const clientId = randomUUID();
    const clientSecret = tokenEndpointAuthMethod === 'none' ? null : randomUUID() + randomUUID();
    const clientSecretHash = clientSecret
      ? createHash('sha256').update(clientSecret).digest('hex')
      : null;

    const client: RegisteredClient = {
      clientId,
      clientSecretHash,
      redirectUris,
      clientName: body.client_name || 'mcp-client',
      createdAt: new Date().toISOString(),
      tokenEndpointAuthMethod,
      grantTypes,
      responseTypes,
    };

    await setJson(`sokar:oauth:client:${clientId}`, client, TTL_CLIENT);

    logger.info({ clientId, clientName: client.clientName }, 'oauth: client registered');

    return reply.status(201).send({
      client_id: clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      ...(clientSecret ? { client_secret_expires_at: 0 } : {}),
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
  });

  // ── 3. Authorization endpoint ────────────────────────
  // GET  → affiche une page de consentement
  // POST → process le consentement, redirige avec un code

  app.get(
    '/oauth/authorize',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as {
        client_id?: string;
        redirect_uri?: string;
        response_type?: string;
        state?: string;
        scope?: string;
        restaurant_id?: string;
        resource?: string;
        code_challenge?: string;
        code_challenge_method?: string;
      };

      const requestedScopes = query.scope ? query.scope.split(' ').filter(Boolean) : ['mcp:read'];
      if (
        requestedScopes.length === 0 ||
        requestedScopes.some((scope) => !['mcp:read', 'mcp:reserve', 'mcp:cancel'].includes(scope))
      ) {
        return reply.status(400).type('text/html').send(renderError('Scope invalide', ''));
      }
      if (query.restaurant_id && !/^[0-9a-f-]{36}$/i.test(query.restaurant_id)) {
        return reply.status(400).type('text/html').send(renderError('Restaurant invalide', ''));
      }
      if (query.resource !== undefined && query.resource !== getIssuer()) {
        return reply.status(400).type('text/html').send(renderError('Ressource invalide', ''));
      }

      // Valider les params
      if (!query.client_id || !query.redirect_uri) {
        return reply
          .status(400)
          .type('text/html')
          .send(renderError('Paramètres manquants', 'client_id et redirect_uri sont requis.'));
      }

      if (query.response_type !== 'code') {
        return reply
          .status(400)
          .type('text/html')
          .send(renderError('Type non supporté', 'Seul response_type=code est supporté.'));
      }
      if (
        query.code_challenge_method !== 'S256' ||
        !query.code_challenge ||
        !/^[A-Za-z0-9_-]{43,128}$/.test(query.code_challenge)
      ) {
        return reply
          .status(400)
          .type('text/html')
          .send(renderError('PKCE requis', 'Utilisez code_challenge_method=S256.'));
      }

      const knownClientName = matchKnownRedirect(query.redirect_uri);

      // Valider le client
      const client = await getJson<RegisteredClient>(`sokar:oauth:client:${query.client_id}`);
      let clientName = query.client_id || 'Unknown';

      if (!client) {
        if (knownClientName) {
          clientName = knownClientName;
        } else {
          return reply
            .status(400)
            .type('text/html')
            .send(
              renderError(
                'Client inconnu',
                `Aucun client enregistré avec l'ID ${query.client_id}.`,
              ),
            );
        }
      } else {
        clientName = client.clientName;
        if (!client.redirectUris.includes(query.redirect_uri)) {
          return reply
            .status(400)
            .type('text/html')
            .send(
              renderError(
                'Redirect URI non autorisé',
                `L'URI ${query.redirect_uri} n'est pas enregistrée pour ce client.`,
              ),
            );
        }
      }

      // Claude et ChatGPT exigent `state` à leur callback pour corréler la
      // réponse OAuth avec la demande initiale. Sans ce champ, leur page de
      // callback affiche une erreur après le clic sur « Autoriser ».
      if (knownClientName && !query.state) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderError(
              'Paramètre state manquant',
              `Relancez la connexion depuis ${knownClientName} afin de générer un state valide.`,
            ),
          );
      }

      // Vérifier qu'au moins un restaurant a MCP activé — sinon le connector
      // est inutile. Pas de scoping Clerk : le MCP est un API publique pour les
      // clients (ChatGPT, Claude.ai, Mistral), pas pour les restaurateurs.
      const anyMcp = await db.restaurantExposureSettings.findFirst({
        where: {
          mcpEnabled: true,
          ...(query.restaurant_id ? { restaurantId: query.restaurant_id } : {}),
        },
        select: { restaurantId: true },
      });

      if (!anyMcp) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderError(
              'Aucun restaurant MCP',
              "Aucun restaurant n'a MCP activé. Activez MCP dans le dashboard Suppernote d'abord.",
            ),
          );
      }
      // tenant-scoping: global — l'authorize OAuth n'a pas encore de contexte
      // tenant ; on vérifie seulement que l'id demandé existe et a opté pour MCP.
      const scopedRestaurant = query.restaurant_id
        ? await db.restaurant.findUnique({
            where: { id: query.restaurant_id },
            select: { name: true, agenticOptIn: true },
          })
        : null;
      if (query.restaurant_id && !scopedRestaurant?.agenticOptIn) {
        return reply.status(400).type('text/html').send(renderError('Restaurant indisponible', ''));
      }

      // Générer un token CSRF pour protéger le consent form
      const csrfToken = randomUUID();
      await setJson(
        `sokar:oauth:csrf:${csrfToken}`,
        {
          clientId: query.client_id,
          redirectUri: query.redirect_uri,
          state: query.state || '',
          scopes: requestedScopes,
          codeChallenge: query.code_challenge || undefined,
          codeChallengeMethod: query.code_challenge_method || undefined,
          restaurantId: query.restaurant_id || null,
          restaurantName: scopedRestaurant?.name ?? null,
          resource: query.resource,
        },
        TTL_CODE, // 10 min — même TTL que les auth codes
      );

      return reply.type('text/html').send(
        renderConsentPage({
          clientName: clientName,
          clientId: query.client_id,
          redirectUri: query.redirect_uri,
          state: query.state || '',
          scope: requestedScopes.join(' '),
          restaurantName: scopedRestaurant?.name ?? null,
          resource: query.resource,
          codeChallenge: query.code_challenge || '',
          codeChallengeMethod: query.code_challenge_method || '',
          csrfToken,
        }),
      );
    },
  );

  app.post(
    '/oauth/authorize',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = req.body as {
        client_id?: string;
        redirect_uri?: string;
        state?: string;
        scope?: string;
        restaurant_id?: string;
        resource?: string;
        code_challenge?: string;
        code_challenge_method?: string;
        action?: string; // "approve" ou "deny"
        csrf_token?: string;
      };

      // Valider le token CSRF (protection contre les attaques cross-site
      // sur le consent form — que ce soit approve ou deny)
      if (!body.csrf_token) {
        return reply
          .status(403)
          .type('text/html')
          .send(renderError('Token CSRF manquant', 'Veuillez recharger la page de consentement.'));
      }
      const csrfData = await getJson<{
        clientId: string;
        redirectUri: string;
        state: string;
        scopes: string[];
        codeChallenge?: string;
        codeChallengeMethod?: string;
        restaurantId: string | null;
        restaurantName: string | null;
        resource?: string;
      }>(`sokar:oauth:csrf:${body.csrf_token}`);
      if (!csrfData) {
        return reply
          .status(403)
          .type('text/html')
          .send(
            renderError(
              'Token CSRF invalide',
              'Le token de consentement a expiré. Veuillez recharger la page.',
            ),
          );
      }
      // Supprimer le token (one-time use)
      await redisCache.del(`sokar:oauth:csrf:${body.csrf_token}`);

      // Vérifier la cohérence client_id / redirect_uri entre le CSRF et le form
      if (
        (body.client_id && body.client_id !== csrfData.clientId) ||
        (body.redirect_uri && body.redirect_uri !== csrfData.redirectUri) ||
        (body.state && body.state !== csrfData.state) ||
        (body.scope && body.scope !== csrfData.scopes.join(' ')) ||
        (body.restaurant_id && body.restaurant_id !== csrfData.restaurantId) ||
        (body.resource !== undefined && body.resource !== csrfData.resource) ||
        (body.code_challenge && body.code_challenge !== csrfData.codeChallenge) ||
        (body.code_challenge_method && body.code_challenge_method !== csrfData.codeChallengeMethod)
      ) {
        return reply
          .status(403)
          .type('text/html')
          .send(
            renderError(
              'Incohérence CSRF',
              'Les paramètres ne correspondent pas au token de consentement.',
            ),
          );
      }

      body.client_id = csrfData.clientId;
      body.redirect_uri = csrfData.redirectUri;
      body.state = csrfData.state;

      // Valider le client
      const postClient = await getJson<RegisteredClient>(`sokar:oauth:client:${body.client_id}`);

      if (!postClient) {
        const knownName = body.redirect_uri ? matchKnownRedirect(body.redirect_uri) : null;
        if (!knownName) {
          return reply
            .status(400)
            .type('text/html')
            .send(renderError('Client inconnu', 'Client non trouvé.'));
        }
      } else {
        if (!body.redirect_uri || !postClient.redirectUris.includes(body.redirect_uri)) {
          return reply.status(400).type('text/html').send(renderError('Redirect URI invalide', ''));
        }
      }

      const knownPostClientName = body.redirect_uri ? matchKnownRedirect(body.redirect_uri) : null;
      if (knownPostClientName && !body.state) {
        return reply
          .status(400)
          .type('text/html')
          .send(
            renderError(
              'Paramètre state manquant',
              `Relancez la connexion depuis ${knownPostClientName} afin de générer un state valide.`,
            ),
          );
      }

      // Si l'utilisateur a refusé
      if (body.action === 'deny') {
        if (!body.redirect_uri) {
          return reply.status(400).type('text/html').send(renderError('Redirect URI manquant', ''));
        }
        return reply.redirect(
          buildAuthorizationRedirect(body.redirect_uri, {
            error: 'access_denied',
            error_description: 'User denied access',
            ...(body.state ? { state: body.state } : {}),
          }),
        );
      }

      // Refuser les requêtes sans client_id valide
      if (!body.client_id) {
        return reply
          .status(400)
          .type('text/html')
          .send(renderError('Client manquant', 'client_id requis.'));
      }

      // Générer le code d'autorisation
      // restaurantId = null : le token MCP est public, il donne accès à tous
      // les restaurants qui ont MCP activé. Le scoping se fait au niveau des
      // tools (getMcpExposure vérifie mcpEnabled par restaurant).
      const code = randomUUID();

      const authCode: AuthCode = {
        clientId: body.client_id || '',
        restaurantId: csrfData.restaurantId,
        restaurantName: csrfData.restaurantName ?? null,
        scopes: csrfData.scopes,
        redirectUri: body.redirect_uri || '',
        resource: csrfData.resource,
        codeChallenge: csrfData.codeChallenge,
        codeChallengeMethod: csrfData.codeChallengeMethod,
      };

      await setJson(`sokar:oauth:code:${code}`, authCode, TTL_CODE);

      logger.info({ clientId: body.client_id }, 'oauth: authorization code issued (public)');

      // Rediriger vers le client avec le code
      if (!body.redirect_uri) {
        return reply.status(400).type('text/html').send(renderError('Redirect URI manquant', ''));
      }
      return reply.redirect(
        buildAuthorizationRedirect(body.redirect_uri, {
          code,
          ...(body.state ? { state: body.state } : {}),
        }),
      );
    },
  );

  // ── 4. Token endpoint ────────────────────────────────
  app.post('/oauth/token', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await checkOauthRate(req.ip, OAUTH_RATE_TOKEN))) {
      return reply
        .status(429)
        .send({ error: 'too_many_requests', error_description: 'Too many token requests' });
    }
    const body = req.body as {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      client_secret?: string;
      code_verifier?: string;
      refresh_token?: string;
      resource?: string;
    };

    // Auth client via Basic ou body, selon la méthode enregistrée.
    const { clientId, clientSecret, clientSecretSource } = extractClientCredentials(req);

    if (!clientId) {
      return reply
        .status(401)
        .send({ error: 'invalid_client', error_description: 'client_id required' });
    }

    // Valider le client (optionnel pour les public clients sans DCR)
    const tokenClient = await getJson<RegisteredClient>(`sokar:oauth:client:${clientId}`);

    if (!isValidClientAuthentication(tokenClient, clientSecret, clientSecretSource)) {
      return reply.status(401).send({
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    }

    const grantType = body.grant_type;

    // ── 4a. authorization_code ──────────────────────────
    if (grantType === 'authorization_code') {
      if (!body.code) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', error_description: 'code required' });
      }

      const authCode = await getJson<AuthCode>(`sokar:oauth:code:${body.code}`);
      if (!authCode) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'Invalid or expired code' });
      }

      // Valider le client AVANT de supprimer le code (sinon une typo
      // consomme le code définitivement et l'utilisateur ne peut pas réessayer)
      if (authCode.clientId !== clientId) {
        return reply.status(400).send({
          error: 'invalid_grant',
          error_description: 'Code was issued to a different client',
        });
      }

      if (body.resource !== authCode.resource) {
        return reply.status(400).send({
          error: 'invalid_target',
          error_description: 'resource must match the authorization request',
        });
      }

      // authorization_code exige exactement le redirect_uri autorisé.
      if (!body.redirect_uri || body.redirect_uri !== authCode.redirectUri) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      }

      // Vérifier PKCE
      if (authCode.codeChallenge) {
        if (!body.code_verifier) {
          return reply
            .status(400)
            .send({ error: 'invalid_grant', error_description: 'code_verifier required (PKCE)' });
        }
        if (!verifyPkce(body.code_verifier, authCode.codeChallenge, authCode.codeChallengeMethod)) {
          return reply
            .status(400)
            .send({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
      }

      // Générer les tokens
      const accessToken = randomUUID();
      const supportsRefreshToken = !tokenClient || tokenClient.grantTypes.includes('refresh_token');
      const refreshToken = supportsRefreshToken ? randomUUID() : '';

      const tokenData: StoredToken = {
        clientId,
        restaurantId: authCode.restaurantId,
        restaurantName: authCode.restaurantName,
        scopes: authCode.scopes,
        resource: authCode.resource ?? getIssuer(),
        accessToken,
        refreshToken,
      };

      if (!(await exchangeToken(`sokar:oauth:code:${body.code}`, authCode, tokenData))) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'Code already used' });
      }

      logger.info({ clientId, restaurantId: authCode.restaurantId }, 'oauth: access token issued');

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TTL_TOKEN,
        ...(supportsRefreshToken ? { refresh_token: refreshToken } : {}),
        scope: authCode.scopes.join(' '),
      });
    }

    // ── 4b. refresh_token ───────────────────────────────
    if (grantType === 'refresh_token') {
      if (tokenClient && !tokenClient.grantTypes.includes('refresh_token')) {
        return reply.status(400).send({
          error: 'unsupported_grant_type',
          error_description: 'refresh_token is not enabled for this client',
        });
      }
      if (!body.refresh_token) {
        return reply
          .status(400)
          .send({ error: 'invalid_request', error_description: 'refresh_token required' });
      }

      const oldToken = await getJson<StoredToken>(`sokar:oauth:refresh:${body.refresh_token}`);
      if (!oldToken) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'Invalid or expired refresh token' });
      }
      if (oldToken.clientId !== clientId) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'Refresh token client mismatch' });
      }
      const refreshResource = oldToken.resource ?? getIssuer();
      if (body.resource !== undefined && body.resource !== refreshResource) {
        return reply.status(400).send({
          error: 'invalid_target',
          error_description: 'resource must match the refresh token',
        });
      }

      // Générer de nouveaux tokens
      const accessToken = randomUUID();
      const refreshToken = randomUUID();

      const tokenData: StoredToken = {
        ...oldToken,
        resource: refreshResource,
        accessToken,
        refreshToken,
      };
      if (
        !(await exchangeToken(
          `sokar:oauth:refresh:${body.refresh_token}`,
          oldToken,
          tokenData,
          oldToken.accessToken,
        ))
      ) {
        return reply
          .status(400)
          .send({ error: 'invalid_grant', error_description: 'Refresh token already used' });
      }

      return reply.send({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: TTL_TOKEN,
        refresh_token: refreshToken,
        scope: oldToken.scopes.join(' '),
      });
    }

    return reply.status(400).send({
      error: 'unsupported_grant_type',
      error_description: `grant_type ${grantType} not supported`,
    });
  });

  // ── 5. Revocation (RFC 7009) — minimal avec auth client ──
  app.post('/oauth/revoke', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!(await checkOauthRate(req.ip, OAUTH_RATE_REVOKE))) {
      return reply
        .status(429)
        .send({ error: 'too_many_requests', error_description: 'Too many revocation requests' });
    }
    const body = req.body as { token?: string; token_type_hint?: string };
    const {
      clientId: revokeClientId,
      clientSecret,
      clientSecretSource,
    } = extractClientCredentials(req);

    if (!revokeClientId) {
      return reply
        .status(401)
        .send({ error: 'invalid_client', error_description: 'client_id required' });
    }

    const revokeClient = await getJson<RegisteredClient>(`sokar:oauth:client:${revokeClientId}`);
    if (!isValidClientAuthentication(revokeClient, clientSecret, clientSecretSource)) {
      return reply
        .status(401)
        .send({ error: 'invalid_client', error_description: 'Client authentication failed' });
    }

    if (body.token) {
      const tokenData =
        (await getJson<StoredToken>(`sokar:oauth:token:${body.token}`)) ??
        (await getJson<StoredToken>(`sokar:oauth:refresh:${body.token}`));

      // RFC 7009: rester opaque sur les jetons inconnus ou étrangers.
      if (tokenData && tokenData.clientId === revokeClientId) {
        if (tokenData.accessToken && tokenData.refreshToken) {
          await deleteStoredTokenPair(tokenData);
        } else {
          await redisCache.del(`sokar:oauth:token:${body.token}`);
          await redisCache.del(`sokar:oauth:refresh:${body.token}`);
        }
      }
    }
    return reply.status(200).send({});
  });
}

// ─── HTML helpers ──────────────────────────────────────

/**
 * Typographies officielles de Suppernote Connect.
 *
 * Les pages OAuth sont rendues directement par l'API, en dehors du bundle
 * Next.js qui charge normalement ces polices via `next/font`. On reprend donc
 * les mêmes familles ici, avec des fallbacks système si le CDN est bloqué.
 */
const SUPPERNOTE_FONT_HEAD = `<link rel="preconnect" href="https://fonts.googleapis.com"/><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/><link href="https://fonts.googleapis.com/css2?family=Outfit:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet"/>`;

function renderConsentPage(params: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scope: string;
  restaurantName: string | null;
  resource?: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  csrfToken: string;
}): string {
  const {
    clientName,
    clientId,
    redirectUri,
    state,
    scope,
    restaurantName,
    codeChallenge,
    codeChallengeMethod,
    csrfToken,
  } = params;
  const grantedScopes = new Set(scope.split(' '));

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Suppernote — Connexion MCP</title>
  ${SUPPERNOTE_FONT_HEAD}
  <style>
    :root { color-scheme: dark; --suppernote-ink: #0f172a; --suppernote-blue: #0284c7; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    button, input { font: inherit; }
    body {
      font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--suppernote-ink);
      background-image: radial-gradient(circle at 15% 10%, rgba(2, 132, 199, 0.15), transparent 34%), radial-gradient(circle at 85% 90%, rgba(2, 132, 199, 0.08), transparent 36%);
      color: #fafafa;
      display: flex;
      justify-content: center;
      min-height: 100vh;
      padding: 28px 18px;
    }
    .card {
      position: relative;
      overflow: hidden;
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 24px;
      padding: 36px;
      max-width: 560px;
      width: 100%;
      margin: auto;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 12%;
      right: 12%;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--suppernote-blue), transparent);
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
    }
    .logo img {
      display: block;
      width: 34px;
      height: 34px;
      object-fit: contain;
      mix-blend-mode: screen;
    }
    .logo span {
      color: #fafafa;
      font-size: 22px;
      font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif;
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .eyebrow {
      color: #a3a3a3;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      margin-bottom: 14px;
      text-transform: uppercase;
    }
    .provider {
      align-items: center;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 999px;
      color: #e5e5e5;
      display: inline-flex;
      font-size: 13px;
      gap: 8px;
      margin-bottom: 18px;
      max-width: 100%;
      padding: 7px 11px;
    }
    .provider span:last-child {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .provider-dot {
      background: var(--suppernote-blue);
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(2, 132, 199, 0.12);
      flex: 0 0 auto;
      height: 6px;
      width: 6px;
    }
    h1 {
      font-size: clamp(24px, 4vw, 30px);
      font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif;
      font-weight: 650;
      letter-spacing: -0.035em;
      line-height: 1.12;
      margin-bottom: 12px;
    }
    .lead {
      color: #a3a3a3;
      font-size: 15px;
      line-height: 1.6;
      margin-bottom: 26px;
    }
    .lead strong {
      color: #f5f5f5;
      font-weight: 600;
    }
    .permissions {
      background: rgba(0, 0, 0, 0.18);
      border: 1px solid rgba(255, 255, 255, 0.09);
      border-radius: 16px;
      margin-bottom: 18px;
      padding: 8px 16px;
    }
    .permissions-title {
      color: #d4d4d4;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      padding: 10px 0 4px;
      text-transform: uppercase;
    }
    .scope-item {
      align-items: center;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
      color: #e5e5e5;
      display: flex;
      font-size: 14px;
      gap: 11px;
      padding: 13px 0;
    }
    .scope-item:last-child { border-bottom: 0; }
    .scope-icon {
      align-items: center;
      background: rgba(2, 132, 199, 0.14);
      border: 1px solid rgba(2, 132, 199, 0.28);
      border-radius: 8px;
      color: var(--suppernote-blue);
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 13px;
      font-weight: 800;
      height: 24px;
      justify-content: center;
      width: 24px;
    }
    .security {
      align-items: center;
      color: #8f8f8f;
      display: flex;
      font-size: 12px;
      gap: 8px;
      line-height: 1.4;
      margin-bottom: 24px;
    }
    .security-dot {
      background: #4ade80;
      border-radius: 50%;
      box-shadow: 0 0 0 4px rgba(74, 222, 128, 0.10);
      flex: 0 0 auto;
      height: 6px;
      width: 6px;
    }
    .actions {
      display: flex;
      gap: 12px;
    }
    button {
      flex: 1;
      padding: 12px 20px;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: transform 0.2s, background 0.2s, border-color 0.2s;
    }
    button:hover { transform: translateY(-1px); }
    .btn-approve {
      background: var(--suppernote-blue);
      color: #fff;
    }
    .btn-approve:hover { opacity: 0.9; }
    .btn-deny {
      flex: 0 0 auto;
      background: transparent;
      color: #a3a3a3;
      border: 1px solid #333;
      padding: 12px 20px;
    }
    .btn-deny:hover { border-color: #555; color: #fafafa; }
    @media (max-width: 520px) {
      .card { padding: 28px 22px; border-radius: 20px; }
      .actions { flex-direction: column-reverse; }
      .btn-deny { flex: 1; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><img src="${escapeAttr(getBrandIconUrl())}" alt="" /><span>Suppernote</span></div>
    <div class="eyebrow">Connexion sécurisée</div>
    <div class="provider"><span class="provider-dot"></span><span>${escapeHtml(clientName)}</span></div>
    <h1>Autoriser l’accès à Suppernote&nbsp;?</h1>
    <p class="lead"><strong>${escapeHtml(clientName)}</strong> demande l’accès à Suppernote pour rechercher des restaurants et gérer vos réservations.</p>
    ${restaurantName ? `<p class="lead">Accès limité au restaurant <strong>${escapeHtml(restaurantName)}</strong>.</p>` : '<p class="lead">Accès aux restaurants qui ont activé MCP.</p>'}

    <div class="permissions">
      <div class="permissions-title">Cette connexion permettra de</div>
      ${grantedScopes.has('mcp:read') ? '<div class="scope-item"><span class="scope-icon">✓</span><span>Rechercher des restaurants et vérifier les disponibilités</span></div>' : ''}
      ${grantedScopes.has('mcp:reserve') ? '<div class="scope-item"><span class="scope-icon">✓</span><span>Créer des réservations</span></div>' : ''}
      ${grantedScopes.has('mcp:cancel') ? '<div class="scope-item"><span class="scope-icon">✓</span><span>Annuler des réservations</span></div>' : ''}
    </div>

    <div class="security"><span class="security-dot"></span><span>Connexion protégée par OAuth 2.0 et PKCE.</span></div>

    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="action" value="approve"/>
      <input type="hidden" name="client_id" value="${escapeAttr(clientId)}"/>
      <input type="hidden" name="redirect_uri" value="${escapeAttr(redirectUri)}"/>
      <input type="hidden" name="state" value="${escapeAttr(state)}"/>
      <input type="hidden" name="scope" value="${escapeAttr(scope)}"/>
      <input type="hidden" name="code_challenge" value="${escapeAttr(codeChallenge)}"/>
      <input type="hidden" name="code_challenge_method" value="${escapeAttr(codeChallengeMethod)}"/>
      <input type="hidden" name="csrf_token" value="${escapeAttr(csrfToken)}"/>
      <div class="actions">
        <button type="submit" class="btn-approve">Autoriser l’accès</button>
        <button type="submit" name="action" value="deny" class="btn-deny">Refuser</button>
      </div>
    </form>
  </div>
</body>
</html>`;
}

function renderError(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Suppernote — Erreur</title>
  ${SUPPERNOTE_FONT_HEAD}
  <style>
    :root { color-scheme: dark; --suppernote-ink: #0f172a; --suppernote-blue: #0284c7; }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    button, input { font: inherit; }
    body {
      font-family: 'Plus Jakarta Sans', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--suppernote-ink);
      background-image: radial-gradient(circle at 15% 10%, rgba(2, 132, 199, 0.15), transparent 34%), radial-gradient(circle at 85% 90%, rgba(2, 132, 199, 0.08), transparent 36%);
      color: #fafafa;
      display: flex;
      justify-content: center;
      min-height: 100vh;
      padding: 28px 18px;
    }
    .card {
      position: relative;
      overflow: hidden;
      background: rgba(20, 20, 20, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.10);
      border-radius: 24px;
      padding: 36px;
      max-width: 520px;
      width: 100%;
      margin: auto;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.42);
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 12%;
      right: 12%;
      height: 2px;
      background: linear-gradient(90deg, transparent, var(--suppernote-blue), transparent);
    }
    .logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 28px;
    }
    .logo img {
      display: block;
      width: 34px;
      height: 34px;
      object-fit: contain;
      mix-blend-mode: screen;
    }
    .logo span {
      color: #fafafa;
      font-size: 22px;
      font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif;
      font-weight: 700;
      letter-spacing: -0.04em;
    }
    .eyebrow {
      color: #a3a3a3;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.12em;
      margin-bottom: 16px;
      text-transform: uppercase;
    }
    .status {
      align-items: center;
      background: rgba(248, 113, 113, 0.10);
      border: 1px solid rgba(248, 113, 113, 0.18);
      border-radius: 14px;
      color: #fb7185;
      display: inline-flex;
      font-size: 20px;
      font-weight: 800;
      height: 44px;
      justify-content: center;
      margin-bottom: 20px;
      width: 44px;
    }
    h1 {
      color: #f8fafc;
      font-size: clamp(24px, 4vw, 30px);
      font-family: 'Outfit', ui-sans-serif, system-ui, sans-serif;
      font-weight: 650;
      letter-spacing: -0.035em;
      line-height: 1.12;
      margin-bottom: 12px;
    }
    p { color: #a3a3a3; font-size: 15px; line-height: 1.6; margin-bottom: 26px; }
    .actions { display: flex; gap: 12px; }
    .btn {
      align-items: center;
      background: var(--suppernote-blue);
      border: 0;
      border-radius: 10px;
      color: #fff;
      display: inline-flex;
      font-size: 14px;
      font-weight: 650;
      justify-content: center;
      padding: 12px 18px;
      text-decoration: none;
      transition: transform 0.2s, background 0.2s;
    }
    .btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .hint { color: #737373; font-size: 12px; line-height: 1.5; margin-top: 18px; }
    @media (max-width: 520px) {
      .card { padding: 28px 22px; border-radius: 20px; }
      .actions { flex-direction: column; }
      .btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo"><img src="${escapeAttr(getBrandIconUrl())}" alt="" /><span>Suppernote</span></div>
    <div class="eyebrow">Suppernote / Connexion</div>
    <div class="status" aria-hidden="true">!</div>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <div class="actions"><a class="btn" href="${escapeAttr(getPublicSiteUrl())}">Retourner sur Suppernote</a></div>
    <div class="hint">Si vous êtes arrivé depuis un assistant, relancez la connexion depuis celui-ci.</div>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
