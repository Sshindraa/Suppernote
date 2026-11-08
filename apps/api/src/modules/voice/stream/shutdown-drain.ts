import { logger } from '../../../shared/logger/pino';
import { voiceActiveSessionsGauge } from '../../../shared/observability/metrics';

/** Délai laissé aux appels en cours à l'arrêt de l'API (doit rester sous `kill_timeout` de PM2). */
export const VOICE_SHUTDOWN_GRACE_MS = 25_000;

export async function activeVoiceSessions(): Promise<number> {
  const { values } = await voiceActiveSessionsGauge.get();
  return values[0]?.value ?? 0;
}

/**
 * Attend la fin des appels vocaux avant de fermer l'API (sessions en mémoire : fermer les coupe).
 * Rend le nombre d'appels encore actifs à l'échéance, 0 si tout est terminé.
 */
export async function waitForVoiceCallsToEnd(
  options: {
    graceMs?: number;
    pollMs?: number;
    activeCount?: () => Promise<number>;
  } = {},
): Promise<number> {
  const {
    graceMs = VOICE_SHUTDOWN_GRACE_MS,
    pollMs = 500,
    activeCount = activeVoiceSessions,
  } = options;
  const deadline = Date.now() + graceMs;
  let active = await activeCount();
  if (active > 0)
    logger.info({ active, graceMs }, '[shutdown] waiting for live voice calls to end');
  while (active > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    active = await activeCount();
  }
  if (active > 0) logger.warn({ active }, '[shutdown] voice calls still live at deadline, closing');
  return active;
}
