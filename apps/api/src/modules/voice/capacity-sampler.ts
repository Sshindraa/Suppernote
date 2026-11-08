import { redisCache } from '../../shared/redis/client';
import { logger } from '../../shared/logger/pino';
import { activeVoiceSessions } from './stream/shutdown-drain';
import type { CapacityStats } from './capacity-model';

/**
 * Mesure en continu ce que coûtent les appels réels : toutes les 10 s, la fraction de cœur et le RSS du
 * processus, comparés à leur niveau sans appel, divisés par le nombre d'appels actifs. Les cumuls vivent
 * dans Redis (ils survivent aux redémarrages) ; capacity-model.ts en tire le seuil.
 */
export const SAMPLE_INTERVAL_MS = 10_000;
export const STATS_KEY = 'sokar:voice:capacity-stats';
/** Poids de la mesure courante dans la moyenne du niveau au repos. */
const IDLE_SMOOTHING = 0.1;

export interface StatsStore {
  hincrbyfloat(key: string, field: string, increment: number): Promise<unknown>;
  hset(key: string, field: string, value: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export async function readCapacityStats(
  store: StatsStore = redisCache as unknown as StatsStore,
): Promise<CapacityStats> {
  const h = await store.hgetall(STATS_KEY);
  const num = (key: string): number | null => {
    const value = Number(h[key]);
    return h[key] !== undefined && Number.isFinite(value) ? value : null;
  };
  return {
    idleCpu: num('idleCpu'),
    idleRss: num('idleRss'),
    activeSamples: num('activeSamples') ?? 0,
    sumSessions: num('sumSessions') ?? 0,
    sumDeltaCpu: num('sumDeltaCpu') ?? 0,
    sumDeltaRss: num('sumDeltaRss') ?? 0,
  };
}

interface SamplerState {
  idleCpu: number | null;
  idleRss: number | null;
}

/** Une mesure : met à jour le niveau au repos (aucun appel) ou les cumuls (au moins un appel). */
export async function recordCapacitySample(
  sample: { active: number; cpu: number; rss: number },
  state: SamplerState,
  store: StatsStore = redisCache as unknown as StatsStore,
): Promise<void> {
  if (sample.active === 0) {
    state.idleCpu =
      state.idleCpu === null
        ? sample.cpu
        : state.idleCpu + IDLE_SMOOTHING * (sample.cpu - state.idleCpu);
    state.idleRss =
      state.idleRss === null
        ? sample.rss
        : state.idleRss + IDLE_SMOOTHING * (sample.rss - state.idleRss);
    await store.hset(STATS_KEY, 'idleCpu', String(state.idleCpu));
    await store.hset(STATS_KEY, 'idleRss', String(state.idleRss));
    return;
  }
  // Sans niveau au repos connu, rien de fiable à retrancher : on attend un premier échantillon sans appel.
  if (state.idleCpu === null || state.idleRss === null) return;
  await store.hincrbyfloat(STATS_KEY, 'activeSamples', 1);
  await store.hincrbyfloat(STATS_KEY, 'sumSessions', sample.active);
  await store.hincrbyfloat(STATS_KEY, 'sumDeltaCpu', Math.max(0, sample.cpu - state.idleCpu));
  await store.hincrbyfloat(STATS_KEY, 'sumDeltaRss', Math.max(0, sample.rss - state.idleRss));
}

/** Démarre l'échantillonnage (processus API seulement). Rend la fonction d'arrêt. */
export function startCapacitySampler(
  options: {
    intervalMs?: number;
    activeCount?: () => Promise<number>;
    store?: StatsStore;
  } = {},
): () => void {
  const { intervalMs = SAMPLE_INTERVAL_MS, activeCount = activeVoiceSessions, store } = options;
  const state: SamplerState = { idleCpu: null, idleRss: null };
  // Reprendre le niveau au repos déjà connu évite d'attendre un nouveau silence après un redémarrage.
  readCapacityStats(store)
    .then((stats) => {
      state.idleCpu ??= stats.idleCpu;
      state.idleRss ??= stats.idleRss;
    })
    .catch(() => undefined);

  let lastUsage = process.cpuUsage();
  let lastAt = process.hrtime.bigint();
  const timer = setInterval(() => {
    const usage = process.cpuUsage(lastUsage);
    const now = process.hrtime.bigint();
    const elapsedMicros = Number(now - lastAt) / 1000;
    lastUsage = process.cpuUsage();
    lastAt = now;
    activeCount()
      .then((active) =>
        recordCapacitySample(
          {
            active,
            cpu: (usage.user + usage.system) / elapsedMicros,
            rss: process.memoryUsage().rss,
          },
          state,
          store,
        ),
      )
      .catch((err) => logger.debug({ err }, '[capacity] sample skipped'));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
