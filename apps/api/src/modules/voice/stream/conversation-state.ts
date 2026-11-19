/**
 * État de conversation et lecture des tours que le tour structuré utilise : interactions en attente,
 * clé de confirmation de réservation, blocage pendant la collecte du nom, extraction d'horaires et de
 * nombres dits, plan de repli quand le modèle échoue (`buildLlmFailurePlan`).
 *
 * Extrait tel quel de `conversation-controller.ts` (dialogue déterministe historique) : aucun
 * changement de comportement, seulement un autre fichier.
 */

import type {
  CallSession,
  ConversationState,
  PendingInteraction,
  PendingInteractionKind,
} from './types';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { effectiveVoiceLanguage, type VoiceLanguageCode } from './voice-language';
import { recordVoiceReadbackForTurn } from './voice-quality';
import type { VoiceQualityKind } from '../../../shared/observability/metrics';
import { type AssistantInteractionProposal } from './voice-action-policy';

export interface AssistantReplyEmissionPlan {
  reply: string;
  proposal: AssistantInteractionProposal;
}

export function getActivePendingInteraction(
  session: Pick<CallSession, 'conversation'>,
): PendingInteraction | null {
  return (
    [...(session.conversation.pendingInteractions ?? [])]
      .reverse()
      .find((interaction) => interaction.status === 'active') ?? null
  );
}

export function normalizeTranscript(value: string): string {
  return value
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’']/gu, ' ')
    .replace(/[^\p{L}\p{N}:\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Identifiant stable du brouillon de réservation actuellement en mémoire.
 * L'accord de l'appelant est lié à toutes les valeurs du récapitulatif,
 * y compris le nom : une correction rend donc automatiquement l'accord
 * précédent inutilisable.
 */
export function getReservationConfirmationKey(
  session: Pick<CallSession, 'conversation'>,
): string | null {
  const { slots, nameCollection } = session.conversation;
  const customerName = nameCollection?.confirmedName ?? slots.customerName;
  if (!slots.date || !slots.time || !slots.partySize || !customerName) return null;

  const normalizedName = normalizeTranscript(customerName);
  if (!normalizedName) return null;
  return `${slots.date}:${slots.time}:${slots.partySize}:${normalizedName}`;
}

/**
 * Marqueurs utilisés par l'appelant pour remplacer une valeur déjà énoncée.
 * Le dernier marqueur gagne : « 19 h 30, non plutôt 20 h 30 » doit donc être
 * analysé à partir de « 20 h 30 », jamais à partir de la première heure.
 */
export const CORRECTION_MARKER_PATTERN =
  /\b(?:non(?:\s+plutot)?|plutot|en fait|je voulais dire|je prefere|finalement)\b/gu;

export function extractCorrectionTail(normalized: string): string {
  let lastMatch: RegExpMatchArray | null = null;
  for (const match of normalized.matchAll(CORRECTION_MARKER_PATTERN)) lastMatch = match;
  if (!lastMatch || lastMatch.index === undefined) return normalized;

  const tail = normalized.slice(lastMatch.index + lastMatch[0].length).trim();
  return tail || normalized;
}

export function isNameCollectionBlocking(session: CallSession): boolean {
  const collection = session.conversation?.nameCollection;
  if (
    collection &&
    (collection.state === 'collecting' ||
      collection.state === 'clarifying' ||
      collection.state === 'confirming')
  ) {
    return true;
  }
  return Boolean(session.conversation?.spellingCandidate);
}

export function isVoiceDialogueIncompleteTranscript(transcript: string): boolean {
  const trimmed = transcript.trim();
  const normalized = normalizeTranscript(trimmed).replace(/-/gu, ' ');
  if (/(?:\.\.\.|…|[\p{L}][‐‑–-])$/u.test(trimmed)) return true;
  return (
    /^(?:(?:euh|heu|hum|hmm|mmh|mh|mhm)(?:\s+|$))*$/u.test(normalized) ||
    /(?:^|\s)(?:est ce que|c est possible de|je voudrais|j aimerais|au nom de|je m appelle)$/u.test(
      normalized,
    )
  );
}

export function addDays(date: string, days: number): string {
  const result = new Date(`${date}T00:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}

export function localDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function nextWeekday(date: string, targetDay: number): string {
  const currentDay = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, (targetDay - currentDay + 7) % 7);
}

export const FRENCH_NUMBER_UNITS: Record<string, number> = {
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
};

export const FRENCH_NUMBER_TENS: Record<string, number> = {
  vingt: 20,
  trente: 30,
  quarante: 40,
  cinquante: 50,
};

export const ENGLISH_NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
};

export function parseFrenchNumberWords(value: string): number | null {
  const tokens = normalizeTranscript(value).replace(/-/gu, ' ').split(/\s+/u).filter(Boolean);
  if (!tokens.length) return null;

  if (tokens.length === 1)
    return FRENCH_NUMBER_UNITS[tokens[0]] ?? FRENCH_NUMBER_TENS[tokens[0]] ?? null;

  const tens = FRENCH_NUMBER_TENS[tokens[0]];
  if (tens === undefined) {
    if (tokens.length === 2 && tokens[0] === 'dix') {
      const unit = FRENCH_NUMBER_UNITS[tokens[1]];
      return unit !== undefined && unit >= 1 && unit <= 9 ? 10 + unit : null;
    }
    return null;
  }

  if (tokens.length === 2) {
    const unit = FRENCH_NUMBER_UNITS[tokens[1]];
    if (unit !== undefined && unit >= 1 && unit <= 9) return tens + unit;
  }
  if (tokens.length === 3 && tokens[1] === 'et' && (tokens[2] === 'un' || tokens[2] === 'une')) {
    return tens + 1;
  }
  return null;
}

/**
 * « à midi », « vers midi », « pour midi », « midi » seul ou « midi et quart » :
 * une heure. « après-midi », « ce midi », « un repas de midi » ne sont qu'un
 * moment de la journée (`dayPeriod`) : retenir 12:00 serait une heure devinée.
 */
export function isExplicitNoonTime(text: string): boolean {
  const withoutAfternoon = text.replace(/\bapres[\s-]midi\b/g, ' ');
  if (!/\bmidi\b/.test(withoutAfternoon)) return false;
  if (/\bmidi\s+(?:et\s+demie?|et\s+quart|trente|quinze|quarante cinq)\b/.test(withoutAfternoon))
    return true;
  if (/\b(?:a|vers|pour|avant|des|jusqu a)\s+midi\b/.test(withoutAfternoon)) return true;
  return /^\W*(?:euh\W+)?midi\W*$/.test(withoutAfternoon);
}

/** « midi », « midi et demi », « midi et quart », « midi trente », « midi quinze ». */
export function extractNoonTime(normalized: string): string {
  const tail = normalized.match(
    /\bmidi\s+(et\s+demie?|et\s+quart|trente|quinze|quarante cinq)\b/u,
  )?.[1];
  if (!tail) return '12:00';
  if (/demi|trente/.test(tail)) return '12:30';
  if (/quart|quinze/.test(tail)) return '12:15';
  return '12:45';
}

/**
 * ElevenLabs restitue parfois les heures en toutes lettres (« vers vingt
 * heures »). Cette forme doit être traitée comme une heure numérique avant de
 * demander une nouvelle fois le créneau au client.
 */
export function extractSpokenClockTime(normalized: string): string | null {
  const tokens = normalized.replace(/-/gu, ' ').split(/\s+/u).filter(Boolean);

  for (let hourIndex = 0; hourIndex < tokens.length; hourIndex++) {
    if (!['h', 'heure', 'heures'].includes(tokens[hourIndex])) continue;

    let hour: number | null = null;
    for (let length = 3; length >= 1; length--) {
      const start = hourIndex - length;
      if (start < 0) continue;
      const candidate = parseFrenchNumberWords(tokens.slice(start, hourIndex).join(' '));
      if (candidate !== null && candidate >= 0 && candidate <= 23) {
        hour = candidate;
        break;
      }
    }
    if (hour === null) continue;

    let minute = 0;
    if (tokens[hourIndex + 1] === 'et' && ['demi', 'demie'].includes(tokens[hourIndex + 2] ?? '')) {
      minute = 30;
    } else if (tokens[hourIndex + 1] === 'et' && tokens[hourIndex + 2] === 'quart') {
      minute = 15;
    } else if (
      tokens[hourIndex + 1] === 'moins' &&
      tokens[hourIndex + 2] === 'le' &&
      tokens[hourIndex + 3] === 'quart'
    ) {
      hour = (hour + 23) % 24;
      minute = 45;
    } else {
      // Forme la plus longue d'abord : « quarante cinq » vaut 45, pas 40.
      for (let length = 3; length >= 1; length--) {
        const candidate = parseFrenchNumberWords(
          tokens.slice(hourIndex + 1, hourIndex + 1 + length).join(' '),
        );
        if (candidate !== null && candidate >= 0 && candidate <= 59) {
          minute = candidate;
          break;
        }
      }
    }

    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  return null;
}

export function extractConversationSlots(
  transcript: string,
  timezone: string,
  now = new Date(),
): ConversationState['slots'] {
  const normalized = normalizeTranscript(transcript);
  const correctedTranscript = extractCorrectionTail(normalized);
  const slots: ConversationState['slots'] = {};

  const isoDate = correctedTranscript.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (isoDate) {
    slots.date = isoDate;
  } else if (/\b(?:aujourd hui|ce jour|ce soir|today|tonight)\b/.test(correctedTranscript)) {
    slots.date = localDate(now, timezone);
  } else if (/\bapres(?:- |-)demain\b|\bapres demain\b/.test(correctedTranscript)) {
    slots.date = addDays(localDate(now, timezone), 2);
  } else if (/\b(?:demain|tomorrow)\b/.test(correctedTranscript)) {
    slots.date = addDays(localDate(now, timezone), 1);
  } else {
    const weekday = correctedTranscript.match(
      /\b(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
    )?.[1];
    const weekdayIndex: Record<string, number> = {
      dimanche: 0,
      lundi: 1,
      mardi: 2,
      mercredi: 3,
      jeudi: 4,
      vendredi: 5,
      samedi: 6,
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };
    if (weekday) {
      slots.date = nextWeekday(localDate(now, timezone), weekdayIndex[weekday]);
    }
  }

  // ElevenLabs transcrit parfois « 19 30 » sans séparateur. On accepte cette
  // forme en plus de « 19:30 », « 19h30 » et « 19 heures 30 », tout en
  // conservant l'heure seule uniquement lorsqu'elle est explicitement suivie
  // de h/heures (pour ne pas confondre « 2 personnes » avec une heure).
  const englishAmPmMatch = correctedTranscript.match(
    /\b(?:at|around)?\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/,
  );
  if (englishAmPmMatch) {
    let hour = Number(englishAmPmMatch[1]);
    const minute = Number(englishAmPmMatch[2] ?? '0');
    if (englishAmPmMatch[3] === 'pm' && hour < 12) hour += 12;
    if (englishAmPmMatch[3] === 'am' && hour === 12) hour = 0;
    slots.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  }

  // L'ancien moteur Scribe écrivait « vingt et une heures » en « 20 et 1 heure » : sans cette
  // réécriture, l'heure lue était 01:00 (banc STT du 24/09).
  // Variantes : « 20 et 1 h 30 », « 20 h et 1 h 30 », « vingt et 1 h 30 ».
  const timeTranscript = correctedTranscript.replace(
    // Après « 20 h » / « 20 heures », « et un » n'est une heure que suivi de « h » :
    // « 20 heures et un enfant » reste 20:00.
    /\b(?:20\s*h(?:eures?)?\s+et\s+(?:1|un|une)(?=\s*h)|(?:20\s+et\s+(?:1|un|une)|vingt\s+et\s+1)(?=\s*h|\s|$))/gu,
    () => '21',
  );
  const timeMatch = slots.time
    ? null
    : timeTranscript.match(
        /\b(?:a|vers|at|around)?\s*([01]?\d|2[0-3])(?:(?:\s*(?::|h(?:eures?)?)\s*)([0-5]\d)?|\s+([0-5]\d))\b/,
      );
  if (timeMatch) {
    const hour = Number(timeMatch[1]);
    const minute = Number(timeMatch[2] ?? timeMatch[3] ?? '0');
    slots.time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  } else {
    const spokenClockTime = extractSpokenClockTime(timeTranscript);
    if (spokenClockTime) {
      slots.time = spokenClockTime;
    } else if (isExplicitNoonTime(correctedTranscript)) {
      // « à midi » est la formulation la plus courante au téléphone ; elle
      // doit déclencher la même vérification qu'une heure numérique.
      slots.time = extractNoonTime(correctedTranscript);
    } else if (/\b(?:a|vers)?\s*minuit\b/.test(correctedTranscript)) {
      slots.time = '00:00';
    }
  }

  // « huit heures ce soir », « 8 heures du soir » : une heure du matin suivie
  // de « soir » désigne le service du soir (lu 08:00 jusqu'ici).
  if (slots.time && /\b(?:du|ce|le) soir\b/u.test(correctedTranscript)) {
    const [hour, minute] = slots.time.split(':').map(Number);
    if (hour >= 1 && hour <= 11) {
      slots.time = `${String(hour + 12).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    }
  }

  const partyMatch = correctedTranscript.match(
    new RegExp(
      `\\b(?:pour|de|for|party of|table for)?\\s*${SPOKEN_PARTY_SIZE_PATTERN}\\s+(?:personnes?|people|guests?)\\b`,
    ),
  );
  if (partyMatch) {
    // Au-delà du seuil du restaurant, le nombre est lu quand même : c'est ce
    // qui permet de reconnaître un groupe et de le confier au gérant.
    const partySize = partySizeFromNumberToken(partyMatch[1]);
    if (partySize !== null) slots.partySize = partySize;
  }

  return slots;
}

export function buildAvailabilityReply(
  request: { date: string; time: string; partySize: number },
  availableSlots: string[],
  language: VoiceLanguageCode = 'fr',
): string {
  const time = formatAvailabilitySlot(request.time, language);
  if (language === 'en') {
    if (availableSlots.length === 0) {
      return `Unfortunately, we're fully booked that day for ${request.partySize} ${request.partySize === 1 ? 'person' : 'people'}. Would you like me to check another day?`;
    }
    if (availableSlots.includes(request.time)) {
      return `Yes, we have a table for ${request.partySize} ${request.partySize === 1 ? 'person' : 'people'} at ${time}. What name should I book it under?`;
    }
    const alternatives = selectClosestAvailabilitySlots(request.time, availableSlots)
      .map((slot) => formatAvailabilitySlot(slot, language))
      .join(' or ');
    return `That time, ${time}, is full, but I have ${alternatives} available. Would either work for you?`;
  }
  if (availableSlots.length === 0) {
    return `Ah, malheureusement on est complets ce jour-là pour ${request.partySize} personne${request.partySize > 1 ? 's' : ''}. Vous voulez que je regarde un autre jour ?`;
  }
  if (availableSlots.includes(request.time)) {
    return `Oui, nous avons de la place pour ${request.partySize} personne${request.partySize > 1 ? 's' : ''} à ${time}. À quel nom je réserve ?`;
  }
  const alternatives = selectClosestAvailabilitySlots(request.time, availableSlots)
    .map((slot) => slot.replace(/^0/, '').replace(':00', ' h').replace(':', ' h '))
    .join(' ou ');
  return `Alors ${time} c'est complet, par contre j'ai ${alternatives}. Ça vous irait ?`;
}

export function buildAvailabilityReplyPlan(
  session: CallSession,
  request: { date: string; time: string; partySize: number },
  availableSlots: string[],
  language: VoiceLanguageCode = 'fr',
): AssistantReplyEmissionPlan {
  // Un jour deviné par rapprochement est relu devant la réponse de
  // disponibilité, qui sinon ne cite que l'heure et le nombre de personnes.
  const reply =
    phoneticDateReadBack(session) + buildAvailabilityReply(request, availableSlots, language);
  const kind: PendingInteractionKind =
    availableSlots.length === 0
      ? 'date'
      : availableSlots.includes(request.time)
        ? 'customerName'
        : 'timeChoice';
  return buildExplicitInteractionReplyPlan(session, reply, kind);
}

/**
 * Pourquoi le tour n'a pas de réponse du modèle. `technical` : aucune réponse (erreur fournisseur,
 * délai, file d'attente) ; `unusable` : le modèle a répondu, mais rien d'exploitable (sortie invalide, vide).
 */
export type LlmFailureCause = 'technical' | 'unusable';

/**
 * Réponse parlée quand le LLM échoue (429, 5xx, timeout, requête refusée).
 *
 * Un silence fait raccrocher l'appelant : on répond toujours, de façon
 * déterministe, à partir de l'état vérifié. Si une disponibilité vient d'être
 * vérifiée pour la demande en cours, on reprend exactement ce résultat ; après
 * deux échecs consécutifs, on propose le gérant ou un message.
 *
 * Panne technique : la phrase dit que le souci vient de nous. « Je n'ai pas bien saisi » faisait croire
 * à l'appelant qu'il avait mal parlé alors que la transcription était exacte (appel du 19/10, 22 h 09).
 */
/**
 * Question suivante du parcours, d'après le brouillon : sert quand le modèle a compris sans répondre. Mêmes
 * formulations que les questions de réservation existantes.
 */
export function nextDraftQuestion(
  draft: { date: string; time: string; partySize: number; customerName: string },
  language: VoiceLanguageCode = 'fr',
): string | null {
  const en = language === 'en';
  if (!draft.date) return en ? 'Which day would you like to book?' : "C'est pour quel jour ?";
  if (!draft.time) return en ? 'What time would you like to come?' : 'Vers quelle heure ?';
  if (!draft.partySize) return en ? 'How many people should I book for?' : 'Vous serez combien ?';
  if (!draft.customerName)
    return en ? 'What name should I put the reservation under?' : "C'est à quel nom ?";
  return null;
}

export function buildLlmFailurePlan(
  session: CallSession,
  cause: LlmFailureCause = 'unusable',
  nextQuestion: string | null = null,
): AssistantReplyEmissionPlan {
  const language = effectiveVoiceLanguage(session);
  const streak = session.conversation.llmFailureStreak ?? 0;
  const managerConfigured = Boolean(session.managerPhone?.trim());

  if (streak >= 2) {
    const reply =
      language === 'en'
        ? managerConfigured
          ? "I'm having a technical issue. I can put you through to the manager or take a message. Which do you prefer?"
          : "I'm having a technical issue, but I can take a message for the manager. Would you like me to do that?"
        : managerConfigured
          ? 'Je rencontre un petit souci technique. Je peux vous passer le gérant ou prendre un message. Que préférez-vous ?'
          : 'Je rencontre un petit souci technique, mais je peux prendre un message pour le gérant. Voulez-vous que je le fasse ?';
    return buildExplicitInteractionReplyPlan(session, reply, 'humanFallback');
  }

  const { date, time, partySize } = session.conversation.slots;
  const lastAvailability = session.conversation.lastAvailabilityResult;
  if (date && time && partySize && lastAvailability?.key === `${date}:${time}:${partySize}`) {
    return buildAvailabilityReplyPlan(
      session,
      { date, time, partySize },
      lastAvailability.slots,
      language,
    );
  }

  if (cause === 'technical') {
    const reply =
      language === 'en'
        ? 'Sorry, I had a small glitch on my end. Could you tell me again?'
        : "Désolée, j'ai eu un petit souci de mon côté. Pouvez-vous me le redire ?";
    return buildExplicitInteractionReplyPlan(session, reply, 'open');
  }

  if (nextQuestion) return buildExplicitInteractionReplyPlan(session, nextQuestion, 'open');
  const reply =
    language === 'en'
      ? "Sorry, I didn't quite catch that. Could you say it again?"
      : "Pardon, je n'ai pas bien entendu. Vous pouvez répéter ?";
  return buildExplicitInteractionReplyPlan(session, reply, 'open');
}

export const FRENCH_PARTY_SIZE_WORDS: Record<number, string> = {
  1: 'une',
  2: 'deux',
  3: 'trois',
  4: 'quatre',
  5: 'cinq',
  6: 'six',
  7: 'sept',
  8: 'huit',
  9: 'neuf',
  10: 'dix',
  11: 'onze',
  12: 'douze',
  13: 'treize',
  14: 'quatorze',
  15: 'quinze',
  16: 'seize',
};

export function formatAvailabilitySlot(slot: string, language: VoiceLanguageCode = 'fr'): string {
  if (language === 'en') {
    const [hourValue, minuteValue] = slot.split(':').map(Number);
    const suffix = hourValue >= 12 ? 'PM' : 'AM';
    const hour = hourValue % 12 || 12;
    return minuteValue === 0
      ? `${hour} ${suffix}`
      : `${hour}:${String(minuteValue).padStart(2, '0')} ${suffix}`;
  }
  return slot.replace(/^0/, '').replace(':00', ' h').replace(':', ' h ');
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function selectClosestAvailabilitySlots(
  requestedTime: string,
  availableSlots: string[],
  limit = 2,
): string[] {
  const requestedMinutes = timeToMinutes(requestedTime);
  return [...availableSlots]
    .sort((left, right) => {
      const distance =
        Math.abs(timeToMinutes(left) - requestedMinutes) -
        Math.abs(timeToMinutes(right) - requestedMinutes);
      return distance || left.localeCompare(right);
    })
    .slice(0, limit);
}

/**
 * Relecture naturelle des valeurs comprises au tour précédent, glissée devant
 * la question suivante (« Six personnes, très bien. Pour quel jour ? »). Une
 * erreur de transcription (« cinq » pour « sept ») s'entend et se corrige tout
 * de suite, sans tour supplémentaire. La date est relue avec son numéro, pour
 * qu'une confusion de jour soit audible.
 */
export function phoneticDateReadBack(session: CallSession): string {
  return session.conversation.phoneticAccepted === 'date'
    ? buildNaturalReadBack(session, 'date')
    : '';
}

export function buildNaturalReadBack(session: CallSession, only?: 'date'): string {
  const justFilled = session.conversation.justFilled;
  if (!justFilled) return '';
  const filled: { partySize?: boolean; date?: boolean; time?: boolean } = only
    ? { date: justFilled.date }
    : {
        ...justFilled,
        // Une heure devinée est toujours relue, même si elle n'a pas changé.
        time: justFilled.time || session.conversation.phoneticAccepted === 'time',
      };
  const { partySize, date } = session.conversation.slots;
  const en = effectiveVoiceLanguage(session) === 'en';
  const parts: string[] = [];
  const readBacks: Array<{ kind: VoiceQualityKind; value: string | number }> = [];
  if (filled.partySize && partySize) {
    readBacks.push({ kind: 'party_size', value: partySize });
    parts.push(
      en
        ? `${partySize} ${partySize === 1 ? 'person' : 'people'}`
        : partySize === 1
          ? 'une personne'
          : `${FRENCH_PARTY_SIZE_WORDS[partySize] ?? partySize} personnes`,
    );
  }
  if (filled.date && date) {
    readBacks.push({ kind: 'date', value: date });
    parts.push(
      new Date(`${date}T12:00:00Z`).toLocaleDateString(en ? 'en-GB' : 'fr-FR', {
        weekday: 'long',
        day: 'numeric',
        timeZone: 'UTC',
      }),
    );
  }
  // L'heure est relue dans la question suivante (« Quatre personnes à 20 h,
  // très bien. ») ; la réponse de disponibilité, qui la cite déjà, n'appelle
  // cette relecture que pour le jour : pas de double relecture.
  const time = session.conversation.slots.time;
  if (filled.time && time) {
    readBacks.push({ kind: 'time', value: time });
    const spoken = formatAvailabilitySlot(time, en ? 'en' : 'fr');
    parts.push(parts.length ? `${en ? 'at' : 'à'} ${spoken}` : spoken);
  }
  if (!parts.length) return '';
  for (const readBack of readBacks) {
    recordVoiceReadbackForTurn(session, readBack.kind, readBack.value);
  }
  const phrase = parts.join(' ');
  return `${phrase.charAt(0).toUpperCase()}${phrase.slice(1)}, ${en ? 'great' : 'très bien'}. `;
}

/** Mots jusqu'à « vingt », chiffres jusqu'à 100 : de quoi reconnaître un groupe. */
export const SPOKEN_PARTY_SIZE_PATTERN =
  '(\\d{1,3}|zero|un|une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix[ -](?:sept|huit|neuf)|dix|onze|douze|treize|quatorze|quinze|seize|vingt|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|twenty)';

export const MAX_SPOKEN_PARTY_SIZE = 100;

export function partySizeFromNumberToken(token: string): number | null {
  const normalized = normalizeTranscript(token);
  const value =
    parseFrenchNumberWords(normalized) ??
    (normalized === 'twenty' ? 20 : ENGLISH_NUMBER_WORDS[normalized]) ??
    (/^\d{1,3}$/.test(normalized) ? Number(normalized) : null);
  // Le seuil du restaurant (`voiceMaxPartySize`) est appliqué au tour, pas ici :
  // un nombre au-delà doit être lu pour déclencher le parcours de groupe.
  return value !== null && value >= 1 && value <= MAX_SPOKEN_PARTY_SIZE ? value : null;
}

export function voiceMaxPartySize(session: Pick<CallSession, 'maxPartySize'>): number {
  const value = session.maxPartySize;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? Math.min(value, MAX_SPOKEN_PARTY_SIZE)
    : DEFAULT_MAX_PARTY_SIZE;
}

/** Extracts presentation text only; it does not infer an interaction kind. */
export function finalAssistantQuestion(reply: string): string | null {
  return reply.match(/([^.!?\n]+\?)\s*$/u)?.[1]?.trim() ?? null;
}

export function buildExplicitInteractionReplyPlan(
  session: CallSession,
  reply: string,
  kind: PendingInteractionKind,
): AssistantReplyEmissionPlan {
  const prompt = kind === 'humanFallback' ? reply : (finalAssistantQuestion(reply) ?? reply);
  const interaction: NonNullable<AssistantInteractionProposal['interaction']> = {
    kind,
    prompt,
    ...(kind === 'humanFallback'
      ? { fallbackMode: session.managerPhone?.trim() ? 'choice' : 'message' }
      : {}),
    ...(kind === 'partySizeConfirmation'
      ? {
          candidatePartySize: getActivePendingInteraction(session)?.candidatePartySize,
        }
      : {}),
  };
  return {
    reply,
    proposal: { source: 'explicit', operation: 'activate', interaction },
  };
}
