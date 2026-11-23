import { db } from '../db/client';
import { redisCache } from '../redis/client';
import { logger } from '../logger/pino';
import { dispatchAlert } from '../observability/alert-dispatcher';

/**
 * Surveillance de ce que le watchdog VPS ne voit pas, lancée depuis l'API (process distinct des
 * workers) :
 *  - les workers BullMQ consomment-ils encore ? Une file joignable ne prouve pas qu'un worker la
 *    lit ; sans eux, confirmations, rappels et e-mails s'accumulent en silence ;
 *  - la ligne téléphonique répond-elle ? Numéro actif, relié à une application d'appel active dont
 *    le webhook pointe sur cette API.
 * Une alerte par incident (verrou Redis), et une alerte de rétablissement.
 */

export const WORKER_HEARTBEAT_KEY = 'sokar:workers:heartbeat';
const HEARTBEAT_INTERVAL_MS = 60_000;
export const WORKER_HEARTBEAT_STALE_MS = 3 * 60_000;
const WATCH_INTERVAL_MS = 5 * 60_000;
const INCIDENT_LATCH_TTL_SECONDS = 24 * 60 * 60;
const TELNYX_TIMEOUT_MS = 10_000;

type HeartbeatStore = {
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
};

/** Appelé par le process workers : écrit l'heure courante chaque minute. */
export function startWorkerHeartbeat(store: HeartbeatStore = redisCache): () => void {
  const beat = (): void => {
    store.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 600).catch((error: unknown) => {
      logger.warn({ err: error }, '[watchtower] Worker heartbeat write failed');
    });
  };
  beat();
  const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Âge du dernier battement des workers, ou null s'il n'y en a aucun. */
export async function readWorkerHeartbeatAgeMs(
  store: Pick<HeartbeatStore, 'get'> = redisCache,
  now = Date.now(),
): Promise<number | null> {
  const raw = await store.get(WORKER_HEARTBEAT_KEY);
  const at = Number(raw);
  return raw && Number.isFinite(at) ? Math.max(0, now - at) : null;
}

export type LineCheck = { ok: true } | { ok: false; reason: string };

type TelnyxGet = (path: string) => Promise<{ ok: boolean; status: number; data: unknown }>;

const telnyxGet: TelnyxGet = async (path) => {
  const base = process.env.TELNYX_API_URL ?? 'https://api.telnyx.com';
  const response = await fetch(`${base}${path}`, {
    headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` },
    signal: AbortSignal.timeout(TELNYX_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: unknown };
  return { ok: response.ok, status: response.status, data: body.data };
};

/** Vérifie un numéro Telnyx et l'application d'appel qui le reçoit. */
export async function checkPhoneLine(
  phoneNumberId: string,
  apiUrl: string,
  get: TelnyxGet = telnyxGet,
): Promise<LineCheck> {
  const number = await get(`/v2/phone_numbers/${encodeURIComponent(phoneNumberId)}`);
  if (!number.ok) return { ok: false, reason: `numéro introuvable (HTTP ${number.status})` };
  const { status, connection_id: connectionId } = (number.data ?? {}) as {
    status?: string;
    connection_id?: string | null;
  };
  if (status !== 'active') return { ok: false, reason: `numéro au statut « ${status} »` };
  if (!connectionId) return { ok: false, reason: 'numéro relié à aucune application d’appel' };

  const app = await get(`/v2/call_control_applications/${encodeURIComponent(connectionId)}`);
  if (!app.ok) return { ok: false, reason: `application d’appel introuvable (HTTP ${app.status})` };
  const { active, webhook_event_url: webhook } = (app.data ?? {}) as {
    active?: boolean;
    webhook_event_url?: string;
  };
  if (!active) return { ok: false, reason: 'application d’appel désactivée' };
  let expectedHost: string | null = null;
  try {
    expectedHost = new URL(apiUrl).host;
  } catch {
    expectedHost = null;
  }
  if (!webhook || (expectedHost && !webhook.includes(expectedHost))) {
    return {
      ok: false,
      reason: `webhook d’appel ailleurs que sur cette API (${webhook ?? 'aucun'})`,
    };
  }
  return { ok: true };
}

export interface WatchtowerDependencies {
  readonly latch: {
    set(
      key: string,
      value: string,
      mode: 'EX',
      ttl: number,
      condition: 'NX',
    ): Promise<string | null>;
    del(key: string): Promise<number>;
  };
  readonly dispatch: typeof dispatchAlert;
}

const defaultDependencies: WatchtowerDependencies = {
  latch: redisCache,
  dispatch: dispatchAlert,
};

/** Ouvre ou referme un incident ; une seule alerte à l'ouverture, une au rétablissement. */
export async function reportIncident(
  args: { key: string; failing: boolean; summary: string; detail: string; recovered: string },
  dependencies: WatchtowerDependencies = defaultDependencies,
): Promise<'opened' | 'ongoing' | 'recovered' | 'ok'> {
  const latchKey = `sokar:watchtower:${args.key}`;
  if (args.failing) {
    const opened =
      (await dependencies.latch.set(latchKey, '1', 'EX', INCIDENT_LATCH_TTL_SECONDS, 'NX')) ===
      'OK';
    if (!opened) return 'ongoing';
    await dependencies.dispatch({
      kind: `watchtower_${args.key}`,
      severity: 'critical',
      summary: args.summary,
      detail: args.detail,
    });
    return 'opened';
  }
  const hadIncident = (await dependencies.latch.del(latchKey)) > 0;
  if (!hadIncident) return 'ok';
  await dependencies.dispatch({
    kind: `watchtower_${args.key}_recovered`,
    severity: 'info',
    summary: args.recovered,
    detail: args.recovered,
  });
  return 'recovered';
}

export async function runWatchtower(
  dependencies: WatchtowerDependencies = defaultDependencies,
): Promise<void> {
  const age = await readWorkerHeartbeatAgeMs();
  const workersDown = age === null || age > WORKER_HEARTBEAT_STALE_MS;
  await reportIncident(
    {
      key: 'workers',
      failing: workersDown,
      summary: 'Workers Suppernote arrêtés : confirmations, rappels et e-mails ne partent plus',
      detail: [
        age === null
          ? 'Aucun battement des workers.'
          : `Dernier battement il y a ${Math.round(age / 1000)} s.`,
        'Vérifier : pm2 status suppernote-workers, pm2 logs suppernote-workers, puis pm2 restart suppernote-workers.',
      ].join('\n'),
      recovered: 'Workers Suppernote rétablis.',
    },
    dependencies,
  );

  if (!process.env.TELNYX_API_KEY) return;
  // tenant-scoping: global — contrôle d'exploitation de toutes les lignes, sans lecture métier.
  const lines = await db.restaurant.findMany({
    where: { telnyxPhoneNumberId: { not: null }, siteStatus: { not: 'ARCHIVED' } },
    select: { id: true, name: true, telnyxPhoneNumberId: true },
  });
  const apiUrl = process.env.API_URL ?? '';
  for (const line of lines) {
    const result = await checkPhoneLine(line.telnyxPhoneNumberId as string, apiUrl).catch(
      (error: unknown): LineCheck => ({
        ok: false,
        reason: `Telnyx injoignable (${error instanceof Error ? error.message : String(error)})`,
      }),
    );
    await reportIncident(
      {
        key: `phone-line:${line.id}`,
        failing: !result.ok,
        summary: `Ligne téléphonique hors service : ${line.name}`,
        detail: [
          result.ok ? '' : `Cause : ${result.reason}.`,
          'Les appels de ce restaurant n’arrivent plus à Suppernote. Vérifier le numéro et l’application d’appel dans le portail Telnyx.',
        ].join('\n'),
        recovered: `Ligne téléphonique rétablie : ${line.name}.`,
      },
      dependencies,
    );
  }
}

/** Démarre la surveillance dans l'API ; premier passage après une période de grâce. */
export function startWatchtower(): () => void {
  const run = (): void => {
    runWatchtower().catch((error: unknown) => {
      logger.warn({ err: error }, '[watchtower] Run failed');
    });
  };
  const timer = setInterval(run, WATCH_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
