import type { CallSession } from './types';

/** Rien d'entendu (ou coupure non mesurée) : tout l'accueil ; tout entendu : rien à reprendre. */
export function unheardGreeting(session: CallSession): string {
  const heard = session.interruptedReply;
  return (heard ? heard.unheard : (session.greetingText ?? '')).trim();
}

/**
 * Accueil coupé par un vrai tour de l'appelant (appels du 20/11 : coupé à 1,3 s, l'annonce IA jamais
 * entendue). Le modèle en est informé pour sa première réponse (`consumeAiNotHeard`) : l'annonce est
 * obligatoire (règlement européen sur l'IA, article 50), il la formule lui-même.
 */
export function keepUnheardGreeting(session: CallSession): void {
  if (!session.greetingInterrupted) return;
  if (/\bIA\b/.test(session.interruptedReply?.heard ?? '')) return;
  session.greetingAiUnheard = true;
}
