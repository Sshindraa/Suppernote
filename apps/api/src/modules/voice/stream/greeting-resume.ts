/**
 * Reprise de l'accueil coupé par un bruit. Quand la coupure vient de l'audio seul (le détecteur de
 * voix de `fast-barge-in`) et que la transcription qui suit est un bruit (un mot seul, peu sûr), il
 * n'y a pas de tour à traiter : l'accueil reprend là où l'appelant l'a entendu s'arrêter.
 */
import { logger } from '../../../shared/logger/pino';
import { CallSessionManager } from './manager';
import { unheardGreeting } from './greeting-unheard';
import { speakTtsStreamed } from './tts-handler';
import type { CallSession } from './types';

export function resumeInterruptedGreeting(session: CallSession): void {
  if (!session.greetingInterrupted || session.ended) return;
  session.greetingInterrupted = false;
  const heard = session.interruptedReply;
  const text = unheardGreeting(session);
  session.interruptedReply = undefined;
  if (!text.trim()) return;
  const mgr = CallSessionManager.getInstance();
  // LISTENING ne mène pas directement à SPEAKING : on passe par PROCESSING, comme une réponse.
  if (session.state === 'LISTENING') mgr.transition(session, 'PROCESSING');
  if (!mgr.transition(session, 'SPEAKING')) return;
  logger.info(
    { callId: session.callControlId, fromStart: !heard || heard.heard === '' },
    '[greeting] Resuming the greeting after a noise',
  );
  speakTtsStreamed(session, text)
    .catch((err: unknown) =>
      logger.warn({ err, callId: session.callControlId }, '[greeting] Resume failed'),
    )
    .finally(() => {
      if (!session.ended && session.state === 'SPEAKING') mgr.transition(session, 'LISTENING');
    });
}
