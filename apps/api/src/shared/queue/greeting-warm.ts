import { logger } from '../logger/pino';
import { queues } from './queues';

/**
 * Demande la préparation des accueils vocaux sans attendre le passage horaire (voir `greeting-warm`).
 * Appelée quand un nom, un style ou un numéro change. Les demandes rapprochées n'en font qu'une
 * (déduplication 60 s) et un échec ne bloque jamais l'appelant : la tâche horaire reste le filet.
 */
export function requestGreetingWarm(): void {
  const warn = (err: unknown) =>
    logger.warn({ err }, '[greetings] warm request failed (non-blocking)');
  try {
    queues.reconciliation
      .add(
        'greeting-warm',
        { kind: 'greeting-warm' },
        { deduplication: { id: 'greeting-warm-request', ttl: 60_000 } },
      )
      .catch(warn);
  } catch (err) {
    warn(err);
  }
}
