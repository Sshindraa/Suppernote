/**
 * Signaux « embed.js vu sur ce site » stockés dans Redis, un champ par origine.
 * Clé `embed:heartbeat:<restaurantId>` (hash), TTL 30 jours. Aucune donnée visiteur (ni IP ni UA).
 */
import { z } from 'zod';
import type { Redis } from 'ioredis';

export const HEARTBEAT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Plafond d'origines par restaurant : évite qu'un tiers gonfle le hash avec des origines inventées. */
export const HEARTBEAT_MAX_ORIGINS = 50;

export type HeartbeatRedis = Pick<Redis, 'hset' | 'hgetall' | 'hdel' | 'expire'>;

export interface EmbedHeartbeat {
  origin: string;
  at: string;
  version: string;
  mode: string;
  buttons: number;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export const HeartbeatSchema = z.object({
  slug: z.string().min(1).max(100),
  origin: z
    .string()
    .max(200)
    .refine(isHttpUrl, 'origin must be an http(s) URL')
    .transform((value) => new URL(value).origin),
  version: z.string().max(10),
  mode: z.enum(['inline', 'modal']),
  buttons: z.number().int().min(0).max(200),
});

export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;

export function heartbeatKey(restaurantId: string): string {
  return `embed:heartbeat:${restaurantId}`;
}

/** Origine de l'en-tête `Origin` (non falsifiable par un navigateur), ou undefined si absente/invalide. */
export function originFromHeader(value: string | undefined): string | undefined {
  if (!value || !isHttpUrl(value)) return undefined;
  return new URL(value).origin;
}

function instantOf(json: string): string {
  try {
    const { at } = JSON.parse(json) as { at?: unknown };
    return typeof at === 'string' ? at : '';
  } catch {
    return '';
  }
}

/** Origine la plus ancienne (`at` minimal). Une entrée illisible est considérée la plus ancienne. */
export function oldestOrigin(entries: Record<string, string>): string | undefined {
  let oldest: string | undefined;
  let oldestAt = '';
  for (const [origin, json] of Object.entries(entries)) {
    const at = instantOf(json);
    if (oldest === undefined || at < oldestAt) {
      oldest = origin;
      oldestAt = at;
    }
  }
  return oldest;
}

export async function recordHeartbeat(
  redis: HeartbeatRedis,
  restaurantId: string,
  input: Omit<HeartbeatInput, 'slug'>,
  now: Date = new Date(),
): Promise<void> {
  const key = heartbeatKey(restaurantId);
  const entries = await redis.hgetall(key);
  // Plafond atteint : on remplace la plus ancienne plutôt que d'ignorer la vraie origine.
  if (!(input.origin in entries) && Object.keys(entries).length >= HEARTBEAT_MAX_ORIGINS) {
    const evicted = oldestOrigin(entries);
    if (evicted !== undefined) await redis.hdel(key, evicted);
  }
  await redis.hset(
    key,
    input.origin,
    JSON.stringify({
      at: now.toISOString(),
      version: input.version,
      mode: input.mode,
      buttons: input.buttons,
    }),
  );
  await redis.expire(key, HEARTBEAT_TTL_SECONDS);
}

const StoredSchema = z.object({
  at: z.string(),
  version: z.string(),
  mode: z.string(),
  buttons: z.number(),
});

export async function readHeartbeats(
  redis: HeartbeatRedis,
  restaurantId: string,
): Promise<EmbedHeartbeat[]> {
  const raw = await redis.hgetall(heartbeatKey(restaurantId));
  const heartbeats: EmbedHeartbeat[] = [];
  for (const [origin, json] of Object.entries(raw)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const stored = StoredSchema.safeParse(parsed);
    if (stored.success) heartbeats.push({ origin, ...stored.data });
  }
  return heartbeats.sort((a, b) => b.at.localeCompare(a.at));
}
