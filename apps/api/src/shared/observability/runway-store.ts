import { redisCache } from '../redis/client';
import { dailySpend, runwayDays, type Reading } from './alert-math';

/** Relevés de crédit ou de solde gardés 8 jours, un par passage horaire. */
const RETENTION_MS = 8 * 86_400_000;

export interface ReadingStore {
  zadd(key: string, score: number, member: string): Promise<number>;
  zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number>;
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
  expire(key: string, seconds: number): Promise<number>;
}

const key = (name: string) => `sokar:runway:${name}`;

export async function recordReading(
  name: string,
  value: number,
  now = Date.now(),
  store: ReadingStore = redisCache as unknown as ReadingStore,
): Promise<void> {
  await store.zadd(key(name), now, `${now}:${value}`);
  await store.zremrangebyscore(key(name), '-inf', now - RETENTION_MS);
  await store.expire(key(name), Math.ceil(RETENTION_MS / 1000));
}

export async function loadReadings(
  name: string,
  now = Date.now(),
  store: ReadingStore = redisCache as unknown as ReadingStore,
): Promise<Reading[]> {
  const members = await store.zrangebyscore(key(name), now - RETENTION_MS, '+inf');
  return members
    .map((member) => {
      const [at, value] = member.split(':');
      return { at: Number(at), value: Number(value) };
    })
    .filter((r) => Number.isFinite(r.at) && Number.isFinite(r.value));
}

/** Enregistre le relevé du jour puis rend la dépense par jour et les jours de réserve. */
export async function trackRunway(
  name: string,
  remaining: number,
  reading: { value: number; kind: 'cumulative' | 'balance' },
  now = Date.now(),
  store?: ReadingStore,
): Promise<{ spendPerDay: number | null; runway: number | null }> {
  await recordReading(name, reading.value, now, store);
  const spendPerDay = dailySpend(await loadReadings(name, now, store), reading.kind);
  return { spendPerDay, runway: runwayDays(remaining, spendPerDay) };
}
