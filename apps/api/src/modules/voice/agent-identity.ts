import { localHour } from './stream/relative-day';

/**
 * Identité de l'assistant au téléphone. L'appelant doit savoir dès le décroché qu'il parle à une IA
 * (règlement européen sur l'IA, article 50, applicable depuis le 2 août 2026) : l'accueil le dit,
 * et l'assistant le confirme si on le lui demande. Le prénom suit la voix actuelle, féminine.
 */
export const AGENT_NAME = 'Léa';
export const AGENT_TITLE = "l'assistante IA";

/** « bonsoir » de 18 h à 5 h, heure du restaurant ; « bonjour » sinon. */
export function greetingSalutation(now: Date, timezone: string): 'bonjour' | 'bonsoir' {
  const hour = localHour(now, timezone);
  return hour >= 18 || hour < 5 ? 'bonsoir' : 'bonjour';
}

/**
 * Accueil fixe, comme une hôtesse qui décroche : le nom de la maison, le prénom et l'annonce IA, puis la salutation
 * de l'heure à la fin (appel du 22/11 : « bonjour » en tête, l'appelant répondait par-dessus avant l'annonce IA ;
 * appel du 18/11 : l'accueil composé « Bienvenue chez…, comment puis-je vous aider ? » sonnait long).
 */
export function buildFixedGreeting(
  restaurantName: string,
  salutation: 'bonjour' | 'bonsoir' = 'bonjour',
): string {
  return `${restaurantName}, ${AGENT_NAME}, ${AGENT_TITLE}, ${salutation} !`;
}
