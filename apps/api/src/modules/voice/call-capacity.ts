import { redisCache } from '../../shared/redis/client';
import { dispatchAlert, type AlertPayload } from '../../shared/observability/alert-dispatcher';
import {
  voiceCapacityLimitGauge,
  voiceCapacityPeakGauge,
  voiceCapacityUtilizationGauge,
} from '../../shared/observability/metrics';
import { activeVoiceSessions } from './stream/shutdown-drain';

/**
 * Seuil d'appels simultanés par processus API, suivi pour être relevé AVANT d'être atteint.
 * Le refus d'un appel au seuil n'est qu'un dernier filet : l'usage réel (pic sur 7 jours) est comparé
 * au seuil chaque heure, et une alerte part à 50 % (anticiper) puis 70 % (relever maintenant).
 * Le seuil vient de VOICE_MAX_CONCURRENT_CALLS. Valeur par défaut = estimation, pas une mesure sur le VPS :
 * mesure locale du 21/09 (saturation vers 100 sessions sans STT ni TTS réels), voir
 * docs/audits/2026-09-21-voice-load-report.md.
 */
export const DEFAULT_MAX_CONCURRENT_CALLS = 60;
const PEAK_RETENTION_DAYS = 7;
const WARNING_RATIO = 0.5;
const CRITICAL_RATIO = 0.7;

export function maxConcurrentCalls(raw = process.env.VOICE_MAX_CONCURRENT_CALLS): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CONCURRENT_CALLS;
}

voiceCapacityLimitGauge.set(maxConcurrentCalls());

// ── Seuil courant : réglé depuis le dashboard admin, sinon variable d'environnement, sinon défaut ──

const OVERRIDE_KEY = 'sokar:voice:capacity-limit';
const OVERRIDE_CACHE_MS = 15_000;
export const CAPACITY_LIMIT_MIN = 1;
export const CAPACITY_LIMIT_MAX = 500;

export type CapacitySource = 'dashboard' | 'env' | 'default';

export interface CapacityLimit {
  limit: number;
  source: CapacitySource;
  setBy?: string;
  setAt?: string;
}

export interface LimitStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

let limitCache: { value: CapacityLimit; at: number } | null = null;

function envLimit(): CapacityLimit {
  const fromEnv = process.env.VOICE_MAX_CONCURRENT_CALLS;
  return {
    limit: maxConcurrentCalls(fromEnv),
    source: Number.isInteger(Number(fromEnv)) && Number(fromEnv) > 0 ? 'env' : 'default',
  };
}

/** Seuil en vigueur. Lecture Redis mise en cache 15 s : aucun coût sur le chemin d'un appel. */
export async function currentCapacityLimit(
  store: LimitStore = redisCache as unknown as LimitStore,
  now = Date.now(),
): Promise<CapacityLimit> {
  if (limitCache && now - limitCache.at < OVERRIDE_CACHE_MS) return limitCache.value;
  let value = envLimit();
  try {
    const raw = await store.get(OVERRIDE_KEY);
    const parsed = raw ? (JSON.parse(raw) as { limit?: number; by?: string; at?: string }) : null;
    if (parsed && Number.isInteger(parsed.limit) && (parsed.limit as number) > 0) {
      value = {
        limit: parsed.limit as number,
        source: 'dashboard',
        setBy: parsed.by,
        setAt: parsed.at,
      };
    }
  } catch {
    // Redis indisponible : on garde la variable d'environnement, jamais un refus d'appel.
  }
  limitCache = { value, at: now };
  voiceCapacityLimitGauge.set(value.limit);
  return value;
}

export async function setCapacityLimit(
  limit: number,
  actor: string,
  store: LimitStore = redisCache as unknown as LimitStore,
): Promise<CapacityLimit> {
  if (!Number.isInteger(limit) || limit < CAPACITY_LIMIT_MIN || limit > CAPACITY_LIMIT_MAX) {
    throw new RangeError(
      `limit must be an integer between ${CAPACITY_LIMIT_MIN} and ${CAPACITY_LIMIT_MAX}`,
    );
  }
  const at = new Date().toISOString();
  await store.set(OVERRIDE_KEY, JSON.stringify({ limit, by: actor, at }));
  limitCache = null;
  return currentCapacityLimit(store);
}

export async function clearCapacityLimit(
  store: LimitStore = redisCache as unknown as LimitStore,
): Promise<CapacityLimit> {
  await store.del(OVERRIDE_KEY);
  limitCache = null;
  return currentCapacityLimit(store);
}

/** Dernier filet : refuse un appel seulement quand le seuil est atteint (le suivi doit l'avoir fait relever avant). */
export async function isAtCallCapacity(
  activeCount: () => Promise<number> = activeVoiceSessions,
  limit?: number,
): Promise<boolean> {
  const max = limit ?? (await currentCapacityLimit()).limit;
  return (await activeCount()) >= max;
}

// ── Suivi du pic quotidien ─────────────────────────────────────────────────────────────────

export interface PeakStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

const dayKey = (date: Date): string => `sokar:voice:peak:${date.toISOString().slice(0, 10)}`;

let localPeak = { day: '', value: 0 };

/** À appeler quand le nombre de sessions augmente. N'écrit dans Redis que pour un nouveau pic du jour. */
export function recordVoicePeak(
  active: number,
  store: PeakStore = redisCache,
  now = new Date(),
): void {
  const key = dayKey(now);
  if (localPeak.day !== key) localPeak = { day: key, value: 0 };
  if (active <= localPeak.value) return;
  localPeak.value = active;
  // Mesure seulement : un échec ne doit jamais gêner la création d'une session. Lecture puis écriture :
  // deux pics simultanés dans la même seconde peuvent s'écraser, l'écart reste de une session.
  try {
    store
      .get(key)
      .then((current) =>
        Number(current ?? 0) < active
          ? store.set(key, String(active), 'EX', (PEAK_RETENTION_DAYS + 1) * 86_400)
          : undefined,
      )
      .catch(() => undefined);
  } catch {
    // Redis indisponible ou client absent : le pic du jour est simplement manqué.
  }
}

// ── Contrôle horaire de la marge ───────────────────────────────────────────────────────────

export interface CapacityCheckDeps {
  readonly store: {
    mget(...keys: string[]): Promise<Array<string | null>>;
    set(
      key: string,
      value: string,
      mode: 'EX',
      seconds: number,
      cond: 'NX',
    ): Promise<string | null>;
  };
  readonly dispatch: (payload: AlertPayload) => Promise<unknown>;
  readonly now: Date;
  readonly limit: number;
}

export type CapacityLevel = 'ok' | 'warning' | 'critical';

export async function checkVoiceCapacityHeadroom(
  overrides: Partial<CapacityCheckDeps> = {},
): Promise<{ peak: number; limit: number; ratio: number; level: CapacityLevel }> {
  const deps: CapacityCheckDeps = {
    store: redisCache as unknown as CapacityCheckDeps['store'],
    dispatch: dispatchAlert,
    now: new Date(),
    limit: overrides.limit ?? (await currentCapacityLimit()).limit,
    ...overrides,
  };
  const keys = Array.from({ length: PEAK_RETENTION_DAYS }, (_, i) =>
    dayKey(new Date(deps.now.getTime() - i * 86_400_000)),
  );
  const peak = Math.max(0, ...(await deps.store.mget(...keys)).map((v) => Number(v ?? 0) || 0));
  const ratio = peak / deps.limit;
  voiceCapacityLimitGauge.set(deps.limit);
  voiceCapacityPeakGauge.set(peak);
  voiceCapacityUtilizationGauge.set(ratio);

  const level: CapacityLevel =
    ratio >= CRITICAL_RATIO ? 'critical' : ratio >= WARNING_RATIO ? 'warning' : 'ok';
  if (level === 'ok') return { peak, limit: deps.limit, ratio, level };

  // Un rappel par jour tant que la marge reste insuffisante.
  const claimed =
    (await deps.store
      .set(`sokar:voice:capacity-alert:${level}`, '1', 'EX', 86_400, 'NX')
      .catch(() => null)) === 'OK';
  if (claimed) {
    await deps.dispatch({
      kind: `voice_capacity_${level}`,
      severity: level === 'critical' ? 'critical' : 'warning',
      summary:
        level === 'critical'
          ? `Appels simultanés à ${Math.round(ratio * 100)} % du seuil : relever la capacité maintenant`
          : `Appels simultanés à ${Math.round(ratio * 100)} % du seuil : anticiper la hausse de capacité`,
      detail: [
        `pic sur 7 jours=${peak} appels simultanés`,
        `seuil actuel=${deps.limit} (VOICE_MAX_CONCURRENT_CALLS)`,
        'Le seuil par défaut est une estimation, pas une mesure sur le VPS : mesurer avec',
        'apps/api/scripts/voice-load-test.ts hors heures de service, puis relever le seuil',
        "ou ajouter un second processus avant de l'atteindre.",
      ].join('\n'),
    });
  }
  return { peak, limit: deps.limit, ratio, level };
}

// ── Rapport pour le dashboard admin ────────────────────────────────────────────────────────

export interface CapacityReport extends CapacityLimit {
  activeNow: number;
  peakToday: number;
  peak7d: number;
  utilization: number;
  level: CapacityLevel;
  thresholds: { warning: number; critical: number };
  history: Array<{ day: string; peak: number }>;
  measuredOnVps: false;
  generatedAt: string;
}

export async function getVoiceCapacityReport(
  deps: {
    store?: CapacityCheckDeps['store'];
    activeCount?: () => Promise<number>;
    now?: Date;
    limit?: CapacityLimit;
  } = {},
): Promise<CapacityReport> {
  const store = deps.store ?? (redisCache as unknown as CapacityCheckDeps['store']);
  const now = deps.now ?? new Date();
  const current = deps.limit ?? (await currentCapacityLimit());
  const days = Array.from(
    { length: PEAK_RETENTION_DAYS },
    (_, i) => new Date(now.getTime() - (PEAK_RETENTION_DAYS - 1 - i) * 86_400_000),
  );
  const values = await store.mget(...days.map(dayKey));
  const history = days.map((day, i) => ({
    day: day.toISOString().slice(0, 10),
    peak: Number(values[i] ?? 0) || 0,
  }));
  const peak7d = Math.max(0, ...history.map((h) => h.peak));
  const utilization = peak7d / current.limit;
  return {
    ...current,
    activeNow: await (deps.activeCount ?? activeVoiceSessions)(),
    peakToday: history[history.length - 1].peak,
    peak7d,
    utilization,
    level:
      utilization >= CRITICAL_RATIO ? 'critical' : utilization >= WARNING_RATIO ? 'warning' : 'ok',
    thresholds: { warning: WARNING_RATIO, critical: CRITICAL_RATIO },
    history,
    measuredOnVps: false,
    generatedAt: now.toISOString(),
  };
}
