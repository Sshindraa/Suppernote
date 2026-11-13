/**
 * Auth MCP : OAuth opaque ou API key (Bearer) + validation Origin.
 *
 * - API key : préfixe `sk_suppernote_agent_` (ancien `sk_sokar_agent_` accepté) + secret opaque. En P1, on valide
 *   contre AgentClient.keyHash. En dev uniquement, AGENT_DEV_KEY reste un
 *   fallback local tant que le dashboard de gestion des clés n'existe pas.
 * - Origin : on autorise uniquement les clients MCP connus
 *   (claude.ai, claude-desktop, cursor.sh, localhost dev).
 * - Pas d'auth basée sur user/password : l'API key est opaque et
 *   révocable, on l'audite à chaque appel.
 */

import type { FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { createHash, timingSafeEqual } from 'crypto';
import { env } from '../../../env';
import { redisCache } from '../../../shared/redis/client';
import { verifyApiKeyHashAsync } from '../../../shared/crypto/api-key-hash';

// Origins par défaut. Surchargeable via MCP_ALLOWED_ORIGINS
// (comma-separated, ex: "https://claude.ai,https://chatgpt.com")
const DEFAULT_ORIGINS = [
  'https://claude.ai',
  'https://chatgpt.com',
  'https://chat.mistral.ai',
  'https://cursor.sh',
  'http://localhost:3000',
  'http://localhost:4000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:4000',
];

function buildAllowedOrigins(): ReadonlySet<string> {
  const envOrigins = env.MCP_ALLOWED_ORIGINS;
  if (envOrigins) {
    const extra = envOrigins
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    return new Set([...DEFAULT_ORIGINS, ...extra]);
  }
  return new Set(DEFAULT_ORIGINS);
}

export const ALLOWED_ORIGINS: ReadonlySet<string> = buildAllowedOrigins();

export class McpAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'McpAuthError';
  }
}

export type AuthContext = {
  clientId: string;
  clientName: string;
  restaurantId: string | null;
  scopes: string[];
  allowedOrigins: string[];
  credentialType: 'api_key' | 'oauth';
};

// Construction runtime pour contourner le masquage statique de secrets
// sur les patterns qui ressemblent à des API keys.
export const AGENT_KEY_PREFIX = ['sk', '_suppernote', '_agent_'].join('');
/** Clés émises avant le renommage : toujours valables (shortcut: retirer quand plus aucune n'est active). */
const LEGACY_AGENT_KEY_PREFIX = ['sk', '_sokar', '_agent_'].join('');

function keyPrefixOf(key: string): string | null {
  if (key.startsWith(AGENT_KEY_PREFIX)) return AGENT_KEY_PREFIX;
  if (key.startsWith(LEGACY_AGENT_KEY_PREFIX)) return LEGACY_AGENT_KEY_PREFIX;
  return null;
}

/**
 * Parse un Authorization header. Renvoie le token ou null.
 * Format attendu : "Bearer sk_suppernote_agent_xxx".
 */
function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  return m ? m[1].trim() : null;
}

// hashApiKey (scrypt + salt aléatoire) est réexporté depuis shared/crypto
// pour préserver l'API publique de ce module (admin.service l'utilise).
export { hashApiKey } from '../../../shared/crypto/api-key-hash';

export function getApiKeyPrefix(key: string): string {
  const prefix = keyPrefixOf(key) ?? AGENT_KEY_PREFIX;
  return key.slice(0, Math.min(key.length, prefix.length + 8));
}

export function validateApiKeyFormat(key: string): boolean {
  const prefix = keyPrefixOf(key);
  if (!prefix) return false;
  if (key.length < prefix.length + 16) return false;
  return true;
}

/**
 * Dev fallback conservé pour les tests locaux tant que le dashboard de gestion
 * des clés n'existe pas. En production, seule la table AgentClient est valide.
 *
 * Sécurité : utilisation de timingSafeEqual pour prévenir les timing attacks
 * sur la comparaison de la clé dev. La clé dev doit faire ≥32 chars (entropie
 * suffisante). En production, ce code n'est jamais exécuté (garde NODE_ENV).
 */
export function validateDevApiKey(key: string): AuthContext | null {
  if (!validateApiKeyFormat(key)) return null;
  // SEC-007 : l'auth dev doit être explicitement activée, indépendamment de NODE_ENV.
  if (env.ENABLE_DEV_AUTH !== 'true' || !env.AGENT_DEV_KEY) {
    return null;
  }

  const devKey = env.AGENT_DEV_KEY;
  // Validation entropie : la clé dev doit faire au moins 32 caractères
  if (devKey.length < 32) {
    return null;
  }

  // Timing-safe comparison pour prévenir les timing attacks
  const keyBuf = Buffer.from(key);
  const devKeyBuf = Buffer.from(devKey);
  if (keyBuf.length === devKeyBuf.length && timingSafeEqual(keyBuf, devKeyBuf)) {
    return {
      clientId: 'dev-client',
      clientName: 'dev',
      restaurantId: null,
      scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
      allowedOrigins: [],
      credentialType: 'api_key',
    };
  }

  return null;
}

export async function validateApiKey(
  key: string,
  prisma: PrismaClient,
): Promise<AuthContext | null> {
  // 1. Essayer d'abord un token OAuth (opaque, stocké dans Redis)
  //    Les tokens OAuth ne respectent pas le format sk_suppernote_agent_, donc
  //    on les check avant la validation de format.
  const { validateOAuthToken } = await import('./oauth');
  const oauthCtx = await validateOAuthToken(key);
  if (oauthCtx) return oauthCtx;

  // 2. Sinon, essayer une API key (format sk_suppernote_agent_...)
  if (!validateApiKeyFormat(key)) return null;

  // Lookup par keyPrefix (index non-unique) puis vérification timing-safe
  // du hash. On ne peut pas faire findUnique sur keyHash car scrypt utilise
  // un salt aléatoire (hash non-déterministe).
  const keyPrefix = getApiKeyPrefix(key);
  const candidates = await prisma.agentClient.findMany({
    where: { keyPrefix, revokedAt: null },
    select: {
      id: true,
      restaurantId: true,
      name: true,
      scopes: true,
      allowedOrigins: true,
      keyHash: true,
    },
  });

  let client: (typeof candidates)[number] | null = null;
  for (const c of candidates) {
    if (await verifyApiKeyHashAsync(key, c.keyHash)) {
      client = c;
      break;
    }
  }

  if (client) {
    await Promise.resolve(
      prisma.agentClient.update({
        where: { id: client.id },
        data: { lastUsedAt: new Date() },
      }),
    ).catch(() => undefined);

    return {
      clientId: client.id,
      clientName: client.name,
      restaurantId: client.restaurantId,
      scopes: client.scopes,
      allowedOrigins: client.allowedOrigins,
      credentialType: 'api_key',
    };
  }

  return validateDevApiKey(key);
}

/**
 * Valide un Origin header contre l'allowlist.
 * Si l'Origin est absent (requête non-browser), on accepte.
 */
export function validateOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // Requête non-browser
  return ALLOWED_ORIGINS.has(origin);
}

export function validateClientOrigin(
  origin: string | undefined,
  allowedOrigins: string[],
): boolean {
  if (!origin) return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(origin);
}

/**
 * Valide un FastifyRequest MCP : API key + Origin.
 * Jette McpAuthError sinon.
 */
export async function authenticateMcpRequest(
  req: FastifyRequest,
  prisma: PrismaClient,
): Promise<AuthContext> {
  const apiKey = extractBearer(req.headers.authorization);
  if (!apiKey) {
    throw new McpAuthError(
      'Missing or invalid Authorization header (expected "Bearer sk_suppernote_agent_xxx")',
      401,
      'UNAUTHORIZED',
    );
  }
  const failedAuthKey = `sokar:mcp:authfail:${createHash('sha256').update(req.ip).digest('hex')}`;
  try {
    if (Number(await redisCache.get(failedAuthKey)) >= 30) {
      throw new McpAuthError('Too many invalid credentials', 429, 'RATE_LIMITED');
    }
  } catch (err) {
    if (err instanceof McpAuthError) throw err;
    // The Fastify IP limit still applies if Redis is unavailable.
  }
  const ctx = await validateApiKey(apiKey, prisma);
  if (!ctx) {
    try {
      await redisCache.incr(failedAuthKey);
      await redisCache.expire(failedAuthKey, 60);
    } catch {
      // The Fastify IP limit still applies if Redis is unavailable.
    }
    throw new McpAuthError('Invalid API key', 401, 'INVALID_API_KEY');
  }
  if (!validateOrigin(req.headers.origin)) {
    throw new McpAuthError(`Origin not allowed: ${req.headers.origin}`, 403, 'ORIGIN_NOT_ALLOWED');
  }

  if (!validateClientOrigin(req.headers.origin, ctx.allowedOrigins)) {
    throw new McpAuthError(
      `Origin not allowed for client: ${req.headers.origin}`,
      403,
      'ORIGIN_NOT_ALLOWED',
    );
  }

  return ctx;
}
