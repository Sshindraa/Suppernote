import type { CallSession } from './types';

/** Rien d'entendu (ou coupure non mesurée) : tout l'accueil ; tout entendu : rien à reprendre. */
export function unheardGreeting(session: CallSession): string {
  const heard = session.interruptedReply;
  return (heard ? heard.unheard : (session.greetingText ?? '')).trim();
}

/**
 * Accueil coupé par un vrai tour de l'appelant (appels du 20/11 : coupé à 1,3 s, l'annonce IA jamais
 * entendue). Le reste est dit en tête de la prochaine réplique de l'agent (cf. `speakTtsStreamed`).
 */
export function keepUnheardGreeting(session: CallSession): void {
  if (!session.greetingInterrupted) return;
  session.greetingUnheard = unheardGreeting(session) || undefined;
}

/** Reste d'accueil à dire avant `text`, une seule fois. */
export function prependUnheardGreeting(session: CallSession, text: string): string {
  const unheard = session.greetingUnheard;
  if (!unheard || session.greetingPlaying) return text;
  session.greetingUnheard = undefined;
  return `${unheard} ${text}`;
}
