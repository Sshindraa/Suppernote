/**
 * Signaux « embed.js vu sur ce site » stockés dans Redis, un champ par origine.
 * Clé `embed:heartbeat:<restaurantId>` (hash), TTL 30 jours. Aucune donnée visiteur (ni IP ni UA).
 */
import { z } from 'zod';
import type { Redis } from 'ioredis';

export const HEARTBEAT_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Plafond d'origines par restaurant : évite qu'un tiers gonfle le hash avec des origines inventées. */
export const HEARTBEAT_MAX_ORIGINS = 50;

export type HeartbeatRedis = Pick<Redis, 'hset' | 'hgetall' | 'hlen' | 'hexists' | 'expire'>;

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

export async function recordHeartbeat(
  redis: HeartbeatRedis,
  restaurantId: string,
  input: Omit<HeartbeatInput, 'slug'>,
  now: Date = new Date(),
): Promise<void> {
  const key = heartbeatKey(restaurantId);
  const isKnownOrigin = await redis.hexists(key, input.origin);
  if (!isKnownOrigin && (await redis.hlen(key)) >= HEARTBEAT_MAX_ORIGINS) return;
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
