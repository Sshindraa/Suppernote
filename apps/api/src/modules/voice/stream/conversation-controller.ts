import type {
  CallSession,
  ConversationState,
  DayPeriod,
  DialogueStallLevel,
  HumanFallbackMode,
  PendingInteraction,
  PendingInteractionKind,
  PendingInteractionStatus,
  NameCollection,
  PendingQuestion,
  SpellingToken,
  VoiceSpeechAct,
} from './types';
import { normalizeOpeningHours } from '@suppernote/shared';
import {
  EXPECTED_ANSWER_THRESHOLDS,
  rankExpectedAnswers,
  resolveExpectedAnswer,
} from './expected-answer';
import {
  confusableNeighbours,
  decideSlotConfidence,
  unstableAlternatives,
  valueConfidence,
  type ConfidenceSlotKind,
} from './slot-confidence';
import { effectiveVoiceLanguage } from './voice-language';
import {
  observeVoiceReadbackResponse,
  recordVoiceChoiceResponse,
  recordVoiceQuestionForTurn,
} from './voice-quality';
import type { VoiceQualityKind } from '../../../shared/observability/metrics';
import {
  decideAssistantInteractionPolicy,
  decideTurnPolicy,
  type AssistantInteractionPolicyDecision,
  type PartySizeEvidence,
} from './turn-policy';
import { type AssistantInteractionProposal } from './voice-action-policy';
import {
  AssistantReplyEmissionPlan,
  getActivePendingInteraction,
  normalizeTranscript,
  getReservationConfirmationKey,
  extractCorrectionTail,
  isNameCollectionBlocking,
  FRENCH_NUMBER_UNITS,
  FRENCH_NUMBER_TENS,
  extractConversationSlots,
  FRENCH_PARTY_SIZE_WORDS,
  formatAvailabilitySlot,
  selectClosestAvailabilitySlots,
  buildNaturalReadBack,
  SPOKEN_PARTY_SIZE_PATTERN,
  partySizeFromNumberToken,
  voiceMaxPartySize,
  finalAssistantQuestion,
  buildExplicitInteractionReplyPlan,
} from './conversation-state';

export function createNameCollection(): NameCollection {
  return {
    state: 'idle',
    partialCandidate: '',
    tokens: [],
    ambiguousPositions: [],
    clarificationCount: 0,
    awaitingCorrection: false,
    presentedCandidate: null,
    confirmedName: null,
    fallbackRecorded: false,
  };
}

export function createConversationState(): ConversationState {
  return {
    intent: null,
    slots: {},
    toolInFlight: null,
    lastAvailabilityCheck: null,
    lastAvailabilityResult: null,
    pendingQuestion: null,
    lastAssistantQuestion: null,
    pendingInteractions: [],
    nextPendingInteractionId: 1,
    pendingReservationConfirmationKey: null,
    confirmedReservationKey: null,
    spellingCandidate: null,
    nameCollection: createNameCollection(),
    misunderstandingCount: 0,
    stalledTurns: 0,
    stallSignature: null,
    humanFallbackOffered: false,
    humanFallbackMode: null,
    lastDialogueGuard: null,
    closing: false,
  };
}

function interactionDomain(kind: PendingInteractionKind): PendingInteractionKind {
  return kind === 'partySizeConfirmation' ? 'partySize' : kind;
}

function syncPendingInteractionProjection(session: Pick<CallSession, 'conversation'>): void {
  const interaction = getActivePendingInteraction(session);
  session.conversation.pendingQuestion =
    interaction && interaction.kind !== 'open' ? interaction.kind : null;
  session.conversation.lastAssistantQuestion = interaction?.prompt ?? null;
  session.conversation.humanFallbackOffered = interaction?.kind === 'humanFallback';
  session.conversation.humanFallbackMode =
    interaction?.kind === 'humanFallback' ? (interaction.fallbackMode ?? null) : null;
}

/** Ouvre ou actualise une interaction en conservant l'historique de son cycle de vie. */
export function activatePendingInteraction(
  session: CallSession,
  kind: PendingInteractionKind,
  prompt: string,
  details: { fallbackMode?: Exclude<HumanFallbackMode, null>; candidatePartySize?: number } = {},
): PendingInteraction {
  const { pendingInteractions } = session.conversation;
  const active = getActivePendingInteraction(session);
  const qualityKind = voiceQualityKindForInteraction(kind);
  if (qualityKind) {
    const repeated = voiceQualityKindForInteraction(active?.kind) === qualityKind;
    recordVoiceQuestionForTurn(session, qualityKind, 'flag_on', repeated);
  }
  if (active?.kind === kind) {
    active.prompt = prompt;
    active.resumePolicy = null;
    active.intentContext = session.conversation.intent;
    active.fallbackMode = details.fallbackMode;
    active.candidatePartySize = details.candidatePartySize;
    syncPendingInteractionProjection(session);
    return active;
  }
  if (active) active.status = 'cancelled';

  const resumable = [...pendingInteractions]
    .reverse()
    .find(
      (interaction) =>
        interaction.status === 'suspended' &&
        interaction.resumePolicy === 'resume_after_child' &&
        interaction.kind === kind,
    );
  if (resumable) {
    resumable.status = 'active';
    resumable.prompt = prompt;
    resumable.resumePolicy = null;
    resumable.fallbackMode = details.fallbackMode;
    resumable.candidatePartySize = details.candidatePartySize;
    for (const interaction of pendingInteractions) {
      if (
        interaction !== resumable &&
        interaction.status === 'suspended' &&
        interaction.resumePolicy === 'discard_on_detour'
      ) {
        interaction.status = 'cancelled';
      }
    }
    syncPendingInteractionProjection(session);
    return resumable;
  }

  for (const interaction of pendingInteractions) {
    if (interaction.status !== 'suspended') continue;
    if (
      interaction.resumePolicy === 'discard_on_detour' ||
      interactionDomain(interaction.kind) === interactionDomain(kind)
    ) {
      interaction.status = 'cancelled';
    }
  }

  const interaction: PendingInteraction = {
    id: session.conversation.nextPendingInteractionId++,
    kind,
    prompt,
    status: 'active',
    resumePolicy: null,
    intentContext: session.conversation.intent,
    ...details,
  };
  pendingInteractions.push(interaction);
  // Keep a bounded per-call trace while retaining recent terminal states.
  if (pendingInteractions.length > 64)
    pendingInteractions.splice(0, pendingInteractions.length - 64);
  syncPendingInteractionProjection(session);
  return interaction;
}

function voiceQualityKindForInteraction(
  kind: PendingInteractionKind | null | undefined,
): VoiceQualityKind | null {
  if (kind === 'partySize' || kind === 'partySizeConfirmation') return 'party_size';
  if (kind === 'date') return 'date';
  if (kind === 'time' || kind === 'timeChoice') return 'time';
  return null;
}

/** Termine l'interaction active et reprend, si possible, une interaction suspendue. */
export function finishActivePendingInteraction(
  session: Pick<CallSession, 'conversation'>,
  status: Extract<PendingInteractionStatus, 'resolved' | 'cancelled'>,
  fulfilledDomain?: PendingInteractionKind,
): void {
  const active = getActivePendingInteraction(session);
  if (active) active.status = status;
  if (fulfilledDomain) {
    for (const interaction of session.conversation.pendingInteractions) {
      if (
        interaction.status === 'suspended' &&
        interactionDomain(interaction.kind) === interactionDomain(fulfilledDomain)
      ) {
        interaction.status = 'cancelled';
      }
    }
  }
  if (status === 'resolved') {
    const resumable = [...session.conversation.pendingInteractions]
      .reverse()
      .find(
        (interaction) =>
          interaction.status === 'suspended' && interaction.resumePolicy === 'resume_after_child',
      );
    if (resumable) {
      resumable.status = 'active';
      resumable.resumePolicy = null;
    }
  }
  syncPendingInteractionProjection(session);
}

function cancelAllPendingInteractions(session: CallSession): void {
  for (const interaction of session.conversation.pendingInteractions) {
    if (interaction.status === 'active' || interaction.status === 'suspended') {
      interaction.status = 'cancelled';
    }
  }
  syncPendingInteractionProjection(session);
}

function resumeSuspendedPendingInteraction(session: CallSession): void {
  if (getActivePendingInteraction(session)) return;
  const resumable = [...session.conversation.pendingInteractions]
    .reverse()
    .find(
      (interaction) =>
        interaction.status === 'suspended' && interaction.resumePolicy === 'resume_after_child',
    );
  for (const interaction of session.conversation.pendingInteractions) {
    if (interaction.status === 'suspended' && interaction.resumePolicy === 'discard_on_detour') {
      interaction.status = 'cancelled';
    }
  }
  if (resumable) {
    resumable.status = 'active';
    resumable.resumePolicy = null;
  }
  syncPendingInteractionProjection(session);
}

/** Invalide l'accord de réservation dès que le brouillon n'est plus identique. */
export function clearReservationConfirmation(session: Pick<CallSession, 'conversation'>): void {
  session.conversation.pendingReservationConfirmationKey = null;
  session.conversation.confirmedReservationKey = null;
  if (session.conversation.pendingQuestion === 'confirmation') {
    finishActivePendingInteraction(session, 'cancelled');
  }
}

function containsCorrectionMarker(normalized: string): boolean {
  return extractCorrectionTail(normalized) !== normalized;
}

interface LexicalToken {
  text: string;
  punctuation: boolean;
}

function tokenizeSpellingTranscript(value: string): LexicalToken[] {
  return (value.match(/\p{L}+|\p{N}+|[-,:;.!?]/gu) ?? []).map((text) => ({
    text,
    punctuation: /^[\-,:;.!?]$/u.test(text),
  }));
}

/**
 * Tokens que la reconnaissance peut produire quand l'appelant épelle un nom en français.
 * Les mots phonétiques ne sont interprétés comme des lettres que dans un
 * contexte qui ressemble réellement à une épellation.
 */
const SPOKEN_LETTER_TOKENS: Record<string, string> = {
  a: 'A',
  be: 'B',
  b: 'B',
  ce: 'C',
  c: 'C',
  de: 'D',
  d: 'D',
  e: 'E',
  f: 'F',
  efe: 'F',
  ef: 'F',
  eff: 'F',
  effe: 'F',
  ge: 'G',
  g: 'G',
  ache: 'H',
  h: 'H',
  i: 'I',
  j: 'J',
  ji: 'J',
  dji: 'J',
  ka: 'K',
  k: 'K',
  elle: 'L',
  l: 'L',
  emme: 'M',
  m: 'M',
  enne: 'N',
  n: 'N',
  o: 'O',
  p: 'P',
  pe: 'P',
  ku: 'Q',
  q: 'Q',
  erre: 'R',
  r: 'R',
  esse: 'S',
  s: 'S',
  te: 'T',
  t: 'T',
  u: 'U',
  ve: 'V',
  v: 'V',
  w: 'W',
  x: 'X',
  ix: 'X',
  y: 'Y',
  zede: 'Z',
  z: 'Z',
  // Prononciations anglaises fréquemment produites par la reconnaissance.
  ay: 'A',
  bee: 'B',
  see: 'C',
  dee: 'D',
  ee: 'E',
  gee: 'G',
  aitch: 'H',
  eye: 'I',
  jay: 'J',
  kay: 'K',
  ell: 'L',
  el: 'L',
  em: 'M',
  en: 'N',
  oh: 'O',
  owe: 'O',
  pee: 'P',
  cue: 'Q',
  ar: 'R',
  are: 'R',
  ess: 'S',
  tee: 'T',
  you: 'U',
  vee: 'V',
  doubleyou: 'W',
  ex: 'X',
  why: 'Y',
  zee: 'Z',
  zed: 'Z',
};

const SPELLING_FILLER_TOKENS = new Set([
  'et',
  'puis',
  'ensuite',
  'par',
  'lettre',
  'lettres',
  'euh',
  'heu',
  'comme',
  'and',
  'then',
  'next',
  'please',
  'uh',
  'um',
  'oui',
  'alors',
  'voila',
  'ben',
  'hein',
  'bon',
  'ok',
  'donc',
]);
const NON_NAME_PREFIX_TOKENS = new Set([
  ...SPELLING_FILLER_TOKENS,
  'a',
  'au',
  'aux',
  'bonjour',
  'de',
  'des',
  'du',
  'en',
  'est',
  'je',
  'la',
  'le',
  'les',
  'merci',
  'mon',
  'nom',
  'non',
  'pour',
  'suis',
  'un',
  'une',
]);

const NAME_INTRODUCTION_PATTERN =
  /\b(?:au nom de|un nom de|(?:en|un) nombre de actifs?|nom de|mon nom est|mon nom|je m appelle|je suis|my name is|the name is|under the name of|this is)\b/u;
const SPELLING_INTRODUCTION_PATTERN =
  /\b(?:epel(?:er|e|ez|ant)?|epell(?:er|e|ez|ant)?|lettres?(?: par lettre)?|alphabet|spell(?:ing|ed)?|letter by letter)\b/u;
const FULL_RESTART_MARKER_PATTERN =
  /\b(?:je recommence|je reprends|je vous redonne|je vais vous redonner|let me start again|i will spell it again|my name is|under the name of)\b/u;
const CONTINUATION_MARKER_PATTERN =
  /\b(?:la suite|le reste|continue(?:r|z)?|the rest|continuing|next)\b/u;
/**
 * La reconnaissance peut placer « non » ou « pardon » devant une nouvelle épellation.
 * Retirer uniquement ce préfixe permet de reconnaître la correction sans
 * transformer une phrase ordinaire contenant « non » en suite de lettres.
 */
const SPELLING_CORRECTION_PREFIX_PATTERN =
  /^(?:non|pardon|excusez|en fait|je me suis trompe|je voulais dire|j ai dit|no|sorry|actually|i meant|i said)\s+/u;

export interface SpelledNameCandidate {
  /** Lettres normalisées, par exemple `KIF` ou `DUPONT`. */
  value: string;
  /** Vrai lorsque chaque token utile est une lettre sans bruit inconnu. */
  confident: boolean;
}

export interface DetailedSpelledNameCandidate extends SpelledNameCandidate {
  /** Candidat avec des `?` aux positions que le transcript ne permet pas d'identifier. */
  partialCandidate: string;
  tokens: SpellingToken[];
  ambiguousPositions: number[];
  hasExplicitSpellingCue: boolean;
  hasNameIntroduction: boolean;
  /** Un court segment de lettres sans marqueur, susceptible d'être continué. */
  isFragment: boolean;
}

function tokenToSpokenLetter(token: string, allowPhoneticWords = true): string | null {
  if (/^[a-z]$/u.test(token)) return SPOKEN_LETTER_TOKENS[token] ?? token.toUpperCase();
  return allowPhoneticWords ? (SPOKEN_LETTER_TOKENS[token] ?? null) : null;
}

function isSpokenSeparator(token: string): string | null {
  if (token === 'tiret') return '-';
  if (token === 'apostrophe') return "'";
  if (token === 'espace') return ' ';
  return null;
}

function isSpellingFiller(token: string): boolean {
  return SPELLING_FILLER_TOKENS.has(token);
}

function parseLetterAt(
  tokens: LexicalToken[],
  index: number,
  allowPhoneticWords: boolean,
): { value: string; nextIndex: number } | null {
  const token = tokens[index]?.text;
  if (!token || tokens[index]?.punctuation) return null;

  if (token === 'i' && tokens[index + 1]?.text === 'grec') {
    return { value: 'Y', nextIndex: index + 2 };
  }

  const value = tokenToSpokenLetter(token, allowPhoneticWords);
  return value ? { value, nextIndex: index + 1 } : null;
}

function parseSeparatorAt(
  tokens: LexicalToken[],
  index: number,
): { value: string; nextIndex: number } | null {
  const token = tokens[index]?.text;
  if (!token || tokens[index]?.punctuation) return null;

  if (token === 'trait' && tokens[index + 1]?.text === 'd' && tokens[index + 2]?.text === 'union') {
    return { value: '-', nextIndex: index + 3 };
  }
  if (token === 'trait' && tokens[index + 1]?.text === 'union') {
    return { value: '-', nextIndex: index + 2 };
  }

  const value = isSpokenSeparator(token);
  return value === null ? null : { value, nextIndex: index + 1 };
}

function hasWord(tokens: LexicalToken[], word: string): boolean {
  return tokens.some((token) => !token.punctuation && token.text === word);
}

function countLikelyLetters(tokens: LexicalToken[], allowPhoneticWords: boolean): number {
  let count = 0;
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].punctuation) continue;
    if (parseLetterAt(tokens, index, allowPhoneticWords)) count++;
    else if (parseSeparatorAt(tokens, index)) count++;
  }
  return count;
}

function isBareSpellingSequence(tokens: LexicalToken[]): boolean {
  const words = tokens.filter((token) => !token.punctuation);
  if (words.length < 2 || words.length > 14) return false;

  return words.every((token, index) => {
    if (isSpellingFiller(token.text) || token.text === 'grec') return true;
    if (/^[a-z]$/u.test(token.text)) return true;
    if (token.text === 'double' || token.text === 'deux' || token.text === '2') {
      return Boolean(words[index + 1]) && !words[index + 1].punctuation;
    }
    return Boolean(SPOKEN_LETTER_TOKENS[token.text] || isSpokenSeparator(token.text));
  });
}

function lastMarkerEnd(normalized: string, markers: Array<RegExpMatchArray | null>): number {
  return markers
    .filter((marker): marker is RegExpMatchArray => Boolean(marker))
    .reduce((end, marker) => Math.max(end, (marker.index ?? 0) + marker[0].length), 0);
}

function addSpellingToken(
  output: SpellingToken[],
  parts: string[],
  raw: string,
  value: string | null,
  kind: SpellingToken['kind'],
  letterPosition: { value: number },
): void {
  const position = letterPosition.value;
  output.push({ position, raw, value, kind });
  if (kind === 'letter') {
    parts.push(value ?? '?');
    letterPosition.value++;
  } else if (kind === 'separator') {
    parts.push(value ?? '');
  } else {
    parts.push('?');
    letterPosition.value++;
  }
}

function findNextComparatorStart(
  tokens: LexicalToken[],
  start: number,
  allowPhoneticWords: boolean,
): number {
  let seenExampleToken = false;
  for (let index = start; index < tokens.length; index++) {
    if (tokens[index].punctuation) return index + 1;
    const letter = parseLetterAt(tokens, index, allowPhoneticWords);
    if (letter && (tokens[letter.nextIndex]?.text === 'comme' || seenExampleToken)) {
      return index;
    }
    seenExampleToken = true;
  }
  return tokens.length;
}

/**
 * Parse une épellation sans utiliser de correction orthographique ou de nom
 * probable. La forme détaillée conserve chaque zone inconnue et sa position ;
 * le wrapper historique garde uniquement `value` et `confident`.
 */
function parseSpelledNameTranscriptCore(transcript: string): DetailedSpelledNameCandidate | null {
  const normalized = normalizeTranscript(transcript);
  if (!normalized) return null;

  // Une correction courte (« Non, A D K I F ») reste une épellation. Le
  // préfixe est ignoré uniquement en tête ; « je ne sais pas, non… » reste
  // donc une phrase ordinaire et ne passe pas dans ce parseur.
  const spellingInput = normalized.replace(SPELLING_CORRECTION_PREFIX_PATTERN, '');
  const nameIntroductionMatch = spellingInput.match(NAME_INTRODUCTION_PATTERN);
  const spellingIntroductionMatch = spellingInput.match(SPELLING_INTRODUCTION_PATTERN);
  const fullRestartMarkerMatch = spellingInput.match(FULL_RESTART_MARKER_PATTERN);
  const continuationMarkerMatch = spellingInput.match(CONTINUATION_MARKER_PATTERN);
  const hasNameIntroduction = Boolean(nameIntroductionMatch);
  const lexicalTranscript = tokenizeSpellingTranscript(spellingInput);
  const hasExplicitSpellingCue =
    Boolean(spellingIntroductionMatch) ||
    hasWord(lexicalTranscript, 'comme') ||
    hasWord(lexicalTranscript, 'tiret') ||
    hasWord(lexicalTranscript, 'apostrophe') ||
    hasWord(lexicalTranscript, 'espace') ||
    hasWord(lexicalTranscript, 'trait');

  const markerEnd = lastMarkerEnd(spellingInput, [
    nameIntroductionMatch,
    spellingIntroductionMatch,
    fullRestartMarkerMatch,
    continuationMarkerMatch,
  ]);
  const tail = markerEnd > 0 ? spellingInput.slice(markerEnd).trim() : spellingInput;
  const tokens = tokenizeSpellingTranscript(tail);
  if (!tokens.length) return null;

  const comparatorCue = hasWord(tokens, 'comme');
  const likelyBareSequence = isBareSpellingSequence(tokens);
  const allowPhoneticWords =
    hasExplicitSpellingCue ||
    likelyBareSequence ||
    (hasNameIntroduction && countLikelyLetters(tokens, true) >= 2);

  const output: SpellingToken[] = [];
  const parts: string[] = [];
  let unknownTokenCount = 0;
  let knownLetterCount = 0;
  const letterPosition = { value: 0 };

  for (let index = 0; index < tokens.length; ) {
    const lexical = tokens[index];
    if (lexical.punctuation || isSpellingFiller(lexical.text)) {
      index++;
      continue;
    }

    if (lexical.text === 'i' && tokens[index + 1]?.text === 'grec') {
      addSpellingToken(output, parts, 'i grec', 'Y', 'letter', letterPosition);
      knownLetterCount++;
      index += 2;
      continue;
    }

    if (
      (lexical.text === 'double' || lexical.text === 'deux' || lexical.text === '2') &&
      !tokens[index + 1]?.punctuation
    ) {
      const doubled = parseLetterAt(tokens, index + 1, allowPhoneticWords);
      if (doubled) {
        const raw = lexical.text + ' ' + tokens[index + 1].text;
        if (
          (doubled.value === 'V' &&
            (tokens[index + 1].text === 've' || tokens[index + 1].text === 'v')) ||
          (doubled.value === 'U' && tokens[index + 1].text === 'u')
        ) {
          addSpellingToken(output, parts, raw, 'W', 'letter', letterPosition);
          knownLetterCount++;
        } else {
          const overlapsPreviousLetter =
            output.at(-1)?.kind === 'letter' && output.at(-1)?.value === doubled.value;
          if (overlapsPreviousLetter) {
            addSpellingToken(output, parts, raw, doubled.value, 'letter', letterPosition);
            knownLetterCount++;
          } else {
            addSpellingToken(output, parts, raw, doubled.value, 'letter', letterPosition);
            addSpellingToken(output, parts, raw, doubled.value, 'letter', letterPosition);
            knownLetterCount += 2;
          }
        }
        index = doubled.nextIndex;
        continue;
      }
      unknownTokenCount++;
      addSpellingToken(output, parts, lexical.text, null, 'ambiguous', letterPosition);
      index++;
      continue;
    }

    const separator = parseSeparatorAt(tokens, index);
    if (separator) {
      addSpellingToken(output, parts, lexical.text, separator.value, 'separator', letterPosition);
      index = separator.nextIndex;
      continue;
    }

    const letter = parseLetterAt(tokens, index, allowPhoneticWords);
    if (letter) {
      addSpellingToken(output, parts, lexical.text, letter.value, 'letter', letterPosition);
      knownLetterCount++;

      if (tokens[letter.nextIndex]?.text === 'comme') {
        index = findNextComparatorStart(tokens, letter.nextIndex + 1, allowPhoneticWords);
      } else {
        index = letter.nextIndex;
      }
      continue;
    }

    if (lexical.text === 'grec') {
      index++;
      continue;
    }

    unknownTokenCount++;
    addSpellingToken(output, parts, lexical.text, null, 'ambiguous', letterPosition);
    index++;
  }

  const value = output
    .filter((token) => token.kind !== 'ambiguous')
    .map((token) => token.value ?? '')
    .join('');
  const partialCandidate = parts.join('');
  const ambiguousPositions = output
    .filter((token) => token.kind === 'ambiguous')
    .map((token) => token.position);
  const meaningfulTokenCount = output.length;
  const minimumLetters = spellingIntroductionMatch || comparatorCue ? 1 : 2;

  if (knownLetterCount < minimumLetters || value.length > 64) return null;

  const hasNoUnknowns = unknownTokenCount === 0;
  const shortLetterSequence =
    !hasNameIntroduction &&
    !spellingIntroductionMatch &&
    !comparatorCue &&
    hasNoUnknowns &&
    meaningfulTokenCount <= knownLetterCount + 2;

  if (
    !hasNameIntroduction &&
    !spellingIntroductionMatch &&
    !comparatorCue &&
    !shortLetterSequence
  ) {
    return null;
  }

  // Un mot ordinaire avec un seul artefact reconnu n'est pas une épellation.
  // Une introduction de nom n'autorise le bruit que s'il reste plusieurs lettres
  // réellement comprises ; le bruit est conservé, jamais corrigé par hypothèse.
  if (
    unknownTokenCount > 0 &&
    !spellingIntroductionMatch &&
    !comparatorCue &&
    (!hasNameIntroduction || knownLetterCount < 3)
  ) {
    return null;
  }

  if (unknownTokenCount > 0 && knownLetterCount < 3) return null;

  return {
    value,
    confident: hasNoUnknowns,
    partialCandidate,
    tokens: output,
    ambiguousPositions,
    hasExplicitSpellingCue,
    hasNameIntroduction,
    isFragment:
      !hasNameIntroduction &&
      !spellingIntroductionMatch &&
      !comparatorCue &&
      knownLetterCount <= 2 &&
      hasNoUnknowns,
  };
}

interface PronouncedNameSpellingMatch {
  candidate: DetailedSpelledNameCandidate;
  spokenName: string;
}

function extractSpokenNameLetters(prefix: string): string | null {
  const normalized = normalizeTranscript(prefix);
  const parsed = parseSpelledNameTranscriptCore(normalized);
  if (parsed?.confident) {
    const letters = parsed.value.replace(/[^A-Z]/gu, '');
    if (letters.length >= 2) return letters;
  }

  const introducedName = normalized.match(
    /^(?:au nom de|un nom de|nom de|mon nom est|mon nom|je m appelle|je suis|my name is|the name is|under the name of)\s+([\p{L}]+)$/u,
  )?.[1];
  const singleWord = /^[\p{L}]+$/u.test(normalized) ? normalized : null;
  const spokenName = introducedName ?? singleWord;
  if (!spokenName || spokenName.length < 2 || NON_NAME_PREFIX_TOKENS.has(spokenName)) {
    return null;
  }

  return spokenName.toLocaleUpperCase('fr-FR');
}

function isLetterSubsequence(prefix: string, candidate: string): boolean {
  let prefixIndex = 0;
  for (const letter of candidate) {
    if (letter === prefix[prefixIndex]) prefixIndex++;
  }
  return prefixIndex === prefix.length;
}

function findPronouncedNameSpellingMatch(transcript: string): PronouncedNameSpellingMatch | null {
  const words = normalizeTranscript(transcript).split(/\s+/u).filter(Boolean);
  if (words.length < 3) return null;

  for (let start = words.length - 2; start >= 1; start--) {
    const spokenName = extractSpokenNameLetters(words.slice(0, start).join(' '));
    if (!spokenName) continue;

    const candidate = parseSpelledNameTranscriptCore(words.slice(start).join(' '));
    if (!candidate?.confident || candidate.value.length < 2) continue;

    const spelledLetters = candidate.value.replace(/[^A-Z]/gu, '');
    if (isLetterSubsequence(spokenName, spelledLetters)) {
      return { candidate, spokenName };
    }
  }

  return null;
}

export function parseSpelledNameTranscriptDetailed(
  transcript: string,
): DetailedSpelledNameCandidate | null {
  return (
    findPronouncedNameSpellingMatch(transcript)?.candidate ??
    parseSpelledNameTranscriptCore(transcript)
  );
}

/** Wrapper de compatibilité avec la PR #116. */
export function parseSpelledNameTranscript(transcript: string): SpelledNameCandidate | null {
  const parsed = parseSpelledNameTranscriptDetailed(transcript);
  if (!parsed) return null;
  return { value: parsed.value, confident: parsed.confident };
}

export function classifyVoiceSpeechAct(transcript: string): VoiceSpeechAct {
  const normalized = normalizeTranscript(transcript);

  if (
    /^(?:allo+|vous etes(?: toujours)? la|vous m entendez|ca a coupe|hello|hi|are you(?: still)? there|can you hear me|did we get disconnected)$/.test(
      normalized,
    )
  ) {
    return 'liveness';
  }
  if (
    /^(?:oui|ouais|ok|okay|d accord|dac|hum hum|mh|mhm|bien sur|yes|yeah|yep|sure|right|correct|alright)$/.test(
      normalized,
    )
  ) {
    return 'backchannel';
  }
  if (
    /^(?:(?:non\s+){1,2})?(?:merci(?:\s+(?:c est tout|au revoir))?|c est tout(?:\s+merci)?|au revoir|bonne (?:journee|soiree)|a bientot|thanks?(?:\s+(?:that s all|goodbye))?|thank you(?:\s+(?:that s all|goodbye))?|that s all|goodbye|bye|have a (?:good|great) (?:day|evening)|see you soon)$/.test(
      normalized,
    )
  ) {
    return 'closing';
  }
  // Decline / fin de conversation : "non ça ira", "c'est bon", "ça va aller",
  // "pas besoin", "non merci", "c'est parfait merci", "non c'est bon merci"
  if (
    /^(?:non\s+)?(?:c est bon(?:\s+merci)?|ca ira(?:\s+merci)?|ca va aller|pas (?:besoin|la peine)|c est parfait(?:\s+merci)?|non merci|c est tout bon|laissez tomber|non c est bon|no thanks?|never mind|forget it|no need|that s fine)$/.test(
      normalized,
    )
  ) {
    return 'closing';
  }
  // Phrases contenant un pattern de clôture + texte supplémentaire :
  // "C'est bon, allez on arrête", "ça ira laissez tomber", "non c'est bon je raccroche"
  if (
    /\b(?:c est bon|ca ira|ca va aller|laissez tomber|on arrete|je raccroche|pas la peine|pas besoin|never mind|forget it|hang up|no need)\b/.test(
      normalized,
    ) &&
    !/\b(?:reserv|table|heure|personne|demain|aujourd|soir|midi|annul|book|reservation|table|people|tomorrow|today|tonight|cancel)\b/.test(
      normalized,
    )
  ) {
    return 'closing';
  }
  // La correction peut arriver au milieu d'une phrase (« 19 h 30, non
  // plutôt 20 h 30 »). Elle doit être classée avant toute vérification afin
  // que le brouillon et la disponibilité utilisent la nouvelle valeur.
  if (containsCorrectionMarker(normalized)) return 'correction';
  if (
    /^(?:non\b|plutot\b|en fait\b|j ai dit\b|je voulais dire\b|no\b|rather\b|actually\b|i said\b|i meant\b)/.test(
      normalized,
    )
  ) {
    return 'correction';
  }
  return 'content';
}

/** Réponses courtes dont le sens dépend de la question encore ouverte. */
export function isAffirmativeShortResponse(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  return /^(?:oui|ouais|ok(?:ay)?|d accord|dac|bien sur|exactement|tout a fait|ca marche|c est bon|c est bien ca|c est ca|ca me va|parfait|je confirme|oui (?:c est ca|c est bon|bien sur|exactement))$/.test(
    normalized,
  );
}

export function isNegativeShortResponse(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  return /^(?:non|pas du tout|ce n est pas ca|c est pas ca|je refuse|annulez?)$/.test(normalized);
}

/** Classifie une réponse courte avec la question actuellement attendue. */
export function classifyVoiceSpeechActInContext(
  session: CallSession,
  transcript: string,
): VoiceSpeechAct {
  const pending = session.conversation.pendingQuestion;
  if (pending === 'humanFallback' && isHumanFallbackDecline(transcript)) return 'correction';
  if (pending && (isAffirmativeShortResponse(transcript) || isNegativeShortResponse(transcript))) {
    return isNegativeShortResponse(transcript) ? 'correction' : 'content';
  }
  return classifyVoiceSpeechAct(transcript);
}

function inferIntent(transcript: string): ConversationState['intent'] {
  const normalized = normalizeTranscript(transcript);
  if (/\b(?:annul|supprim|cancel|cancellation)/.test(normalized)) return 'cancel';
  if (/\b(?:retard|en retard)/.test(normalized)) return 'delay';
  if (/\b(?:carte cadeau|bon cadeau|gift card|gift voucher)/.test(normalized)) return 'gift_card';
  if (/\b(?:message|rappeler|reclamation|call me back|speak to the manager)/.test(normalized))
    return 'message';
  if (/\b(?:reserv|table|place|book|booking|reserve|reservation)/.test(normalized))
    return 'reservation';
  if (
    /\b(?:disponib|possible|creneau|available|availability|opening|openings|slot)/.test(normalized)
  )
    return 'availability';
  return null;
}

export function getReadyAvailabilityRequest(session: CallSession): {
  date: string;
  time: string;
  partySize: number;
  key: string;
} | null {
  const { intent, slots, toolInFlight, lastAvailabilityCheck } = session.conversation;
  if ((intent !== 'reservation' && intent !== 'availability') || toolInFlight) return null;
  if (!slots.date || !slots.time || !slots.partySize) return null;

  const key = `${slots.date}:${slots.time}:${slots.partySize}`;
  if (lastAvailabilityCheck === key) return null;
  return { date: slots.date, time: slots.time, partySize: slots.partySize, key };
}

const CUSTOMER_NAME_STOP_WORDS = new Set([
  'a',
  'au',
  'avec',
  'bon',
  'ca',
  'c est',
  'd accord',
  'de',
  'demain',
  'des',
  'est',
  'heure',
  'je',
  'la',
  'le',
  'les',
  'midi',
  'mon',
  'nom',
  'oui',
  'parfait',
  'personne',
  'personnes',
  'pour',
  'reserver',
  'reservation',
  'table',
  'une',
  'vers',
  'vous',
]);

/**
 * Retient un nom parlé naturellement quand le client répond par exemple
 * « Akif » ou « au nom de Akif ». Les épellations restent entièrement
 * contrôlées par handleCustomerNameTurn.
 */
export function extractPlainCustomerName(transcript: string, expectName = false): string | null {
  const normalized = normalizeTranscript(transcript);
  if (
    !normalized ||
    isAffirmativeShortResponse(transcript) ||
    isNegativeShortResponse(transcript)
  ) {
    return null;
  }

  const spelled = parseSpelledNameTranscriptDetailed(transcript);
  if (spelled?.confident || spelled?.isFragment) return null;

  const explicitMatch = transcript.match(
    /(?:au nom de|mon nom est|je m'appelle|je m’appelle|je suis|my name is|under the name of)\s+([^,.!?]+)/iu,
  );
  const rawCandidate = explicitMatch?.[1]?.trim() ?? (expectName ? transcript.trim() : '');
  const candidate = rawCandidate.replace(/[.!?,]+$/gu, '').trim();
  if (!candidate || candidate.length > 60 || /\d/u.test(candidate)) return null;

  const candidateWords = normalizeTranscript(candidate).split(/\s+/u).filter(Boolean);
  if (candidateWords.length === 0 || candidateWords.length > 4) return null;
  if (candidateWords.some((word) => CUSTOMER_NAME_STOP_WORDS.has(word))) return null;
  if (!candidateWords.every((word) => /^[\p{L}'’-]+$/u.test(word))) return null;

  return candidate;
}

/**
 * Moment de la journée exprimé par l'appelant (« demain soir », « à midi »).
 * « après-midi » n'est pas un service : il n'oriente pas les propositions.
 */
export function extractDayPeriod(transcript: string): DayPeriod | null {
  const text = normalizeTranscript(transcript).replace(/\bapres[\s-]midi\b/g, ' ');
  const dinner = /\b(?:soir|soiree|diner|dinner|tonight|evening)\b/.test(text);
  const lunch = /\b(?:midi|dejeuner|lunch|noon)\b/.test(text);
  if (dinner === lunch) return null;
  return dinner ? 'dinner' : 'lunch';
}

/** Créneaux compatibles avec le moment demandé : service du midi avant 15 h, du soir dès 18 h. */
export function filterSlotsByDayPeriod(slots: string[], period: DayPeriod | undefined): string[] {
  if (!period) return slots;
  return slots.filter((slot) => (period === 'lunch' ? slot < '15:00' : slot >= '18:00'));
}

export function asksForAvailabilityOptions(transcript: string): boolean {
  const text = normalizeTranscript(transcript);
  return /\b(?:disponib|creneaux?|horaires?|possible|available|availability|slots?)|\b(?:quelle heure|quand|what time)\b/.test(
    text,
  );
}

const OPENING_DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/**
 * Heures candidates d'après les horaires d'ouverture (pas de 15 min), pour le
 * jour demandé s'il est connu, sinon pour toute la semaine. Vide si inconnus.
 */
export function openingHourTimes(
  openingHours: CallSession['openingHours'],
  date?: string,
): string[] {
  if (!openingHours) return [];
  const dayIndexes = new Set(
    date ? [new Date(`${date}T12:00:00Z`).getUTCDay()] : [0, 1, 2, 3, 4, 5, 6],
  );
  const times = new Set<string>();
  const toMinutes = (value: string) => {
    const [h, m] = value.split(':').map(Number);
    return h * 60 + (m || 0);
  };
  for (const period of normalizeOpeningHours(openingHours)) {
    if (!dayIndexes.has(period.dayIndex)) continue;
    let close = toMinutes(period.close);
    const open = toMinutes(period.open);
    if (close <= open) close += 24 * 60;
    for (let minute = open; minute < close; minute += 15) {
      times.add(
        `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`,
      );
    }
  }
  return [...times].sort();
}

const WEEKDAY_TOKENS = new Set([
  'lundi',
  'mardi',
  'mercredi',
  'jeudi',
  'vendredi',
  'samedi',
  'dimanche',
  'demain',
  'aujourd',
]);

/** Au-delà, la phrase dit autre chose qu'une réponse courte à la question. */
const MAX_EXPECTED_ANSWER_WORDS = 8;

/**
 * Quand la réponse à une question fermée n'a donné aucune valeur exploitable,
 * cherche la réponse attendue la plus proche phonétiquement. Une valeur nette
 * est retenue ; deux valeurs proches donnent une question « X ou Y ? ».
 * Retourne le champ rempli, s'il y en a un.
 */
function applyExpectedAnswer(
  session: CallSession,
  activeKind: PendingInteractionKind | null,
  transcript: string,
  extracted: ConversationState['slots'],
  now: Date,
  previousChoice: ConversationState['answerChoice'] = null,
): 'partySize' | 'date' | 'time' | null {
  if (extracted.partySize || extracted.date || extracted.time) return null;
  if (isExploratoryUtterance(transcript)) return null;
  if (normalizeTranscript(transcript).split(' ').length > MAX_EXPECTED_ANSWER_WORDS) return null;

  const kind =
    activeKind === 'partySize'
      ? 'partySize'
      : activeKind === 'date'
        ? 'weekday'
        : activeKind === 'time'
          ? 'time'
          : null;
  if (!kind) return null;
  // Un nombre ou un jour déjà reconnaissable dans la phrase a été lu (ou
  // écarté) par l'analyseur normal : « nos trois enfants » ne veut pas dire
  // trois personnes. Le rapprochement ne sert qu'aux phrases sans valeur lisible.
  const tokens = normalizeTranscript(transcript).split(' ');
  if (
    kind === 'partySize' &&
    tokens.some(
      (token) =>
        /^\d+$/.test(token) ||
        FRENCH_NUMBER_UNITS[token] !== undefined ||
        FRENCH_NUMBER_TENS[token] !== undefined,
    )
  )
    return null;
  if (kind === 'weekday' && tokens.some((token) => WEEKDAY_TOKENS.has(token))) return null;

  // Réponse à « six ou dix ? » : seules les deux valeurs proposées comptent.
  const offered = previousChoice?.kind === kind ? previousChoice.values : undefined;
  // Heures possibles : créneaux vérifiés s'il y en a, sinon horaires
  // d'ouverture du jour demandé, sinon la liste par défaut du module.
  let allowedTimes: string[] | undefined = offered;
  if (kind === 'time' && !offered) {
    const known =
      session.conversation.lastAvailabilityResult?.slots ??
      openingHourTimes(session.openingHours, session.conversation.slots.date);
    const inPeriod = filterSlotsByDayPeriod(known, session.conversation.dayPeriod);
    allowedTimes = inPeriod.length ? inPeriod : known;
  }
  const decision = resolveExpectedAnswer(transcript, kind, offered ?? allowedTimes);
  const [best, second] = decision.candidates;
  session.conversation.lastExpectedAnswer = {
    kind,
    status: decision.status,
    bestScore: best ? Math.round(best.score * 1000) / 1000 : null,
    margin: best && second ? Math.round((second.score - best.score) * 1000) / 1000 : null,
  };
  // Au-delà du seuil du restaurant, un nombre deviné n'est jamais accepté
  // d'office. Un choix reste utile dès qu'une des deux valeurs est réservable
  // (« six ou dix ? ») ; la réponse à ce choix, elle, compte même au-delà.
  const limit = voiceMaxPartySize(session);
  const beyondVoiceLimit = (value: string) =>
    kind === 'partySize' && !offered && Number(value) > limit;
  if (decision.status === 'choice' && decision.values.every(beyondVoiceLimit)) return null;
  if (decision.status === 'accepted' && beyondVoiceLimit(decision.value)) return null;
  if (decision.status === 'choice') {
    session.conversation.answerChoice = { kind, values: decision.values };
    return null;
  }
  if (decision.status !== 'accepted') return null;
  // Une valeur devinée n'est jamais retenue en silence : elle est relue dans
  // la réponse suivante (question suivante ou réponse de disponibilité).
  session.conversation.phoneticAccepted = kind === 'weekday' ? 'date' : kind;

  if (kind === 'partySize') {
    extracted.partySize = Number(decision.value);
    return 'partySize';
  }
  if (kind === 'weekday') {
    const date = extractConversationSlots(
      decision.value,
      session.timezone ?? 'Europe/Paris',
      now,
    ).date;
    if (!date) return null;
    extracted.date = date;
    return 'date';
  }
  extracted.time = decision.value;
  return 'time';
}

const JS_WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function weekdayOfDate(date: string): string {
  return JS_WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()];
}

function toMinutes(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + (minute || 0);
}

/** L'heure tombe-t-elle dans les horaires du jour (de la semaine si le jour est inconnu) ? */
export function isWithinOpeningHours(
  openingHours: CallSession['openingHours'],
  date: string | undefined,
  time: string,
): boolean {
  if (!openingHours) return true;
  const dayIndexes = new Set(
    date ? [new Date(`${date}T12:00:00Z`).getUTCDay()] : [0, 1, 2, 3, 4, 5, 6],
  );
  const minute = toMinutes(time);
  return normalizeOpeningHours(openingHours).some((period) => {
    if (!dayIndexes.has(period.dayIndex)) return false;
    const open = toMinutes(period.open);
    let close = toMinutes(period.close);
    if (close <= open) close += 24 * 60; // service qui finit après minuit
    return (
      (minute >= open && minute < close) || (minute + 24 * 60 >= open && minute + 24 * 60 < close)
    );
  });
}

/**
 * Heure ouverte la plus proche à l'oreille : d'abord les confusions connues
 * (« dix » / « vingt-deux »), puis le rapprochement phonétique de la phase 1.
 */
function closestOpenTime(time: string, openTimes: readonly string[]): string | undefined {
  const known = confusableNeighbours('time', time).find((candidate) =>
    openTimes.includes(candidate),
  );
  if (known) return known;
  const [best] = rankExpectedAnswers(formatAvailabilitySlot(time), 'time', openTimes);
  return best && best.score <= EXPECTED_ANSWER_THRESHOLDS.maxScore ? best.value : undefined;
}

/**
 * Vraisemblance des heures (phase 1, indépendante de la confiance) : une heure
 * hors des horaires d'ouverture n'est jamais retenue en silence. Elle devient
 * « X ou Y ? » avec l'heure ouverte la plus proche à l'oreille, ou une relance
 * qui cite les horaires. Horaires inconnus : rien ne change.
 */
function applyTimePlausibility(
  session: CallSession,
  extracted: ConversationState['slots'],
  previousChoice: ConversationState['answerChoice'],
): void {
  const time = extracted.time;
  if (!time || !session.openingHours) return;
  const date = extracted.date ?? session.conversation.slots.date;
  const openTimes = openingHourTimes(session.openingHours, date);
  if (!openTimes.length) return;
  if (isWithinOpeningHours(session.openingHours, date, time)) return;
  delete extracted.time;
  // L'appelant maintient une heure fermée proposée au tour précédent : on
  // cite les horaires au lieu de reposer la même question.
  const maintained = previousChoice?.kind === 'time' && previousChoice.values.includes(time);
  const neighbour = maintained ? undefined : closestOpenTime(time, openTimes);
  if (neighbour && !session.conversation.answerChoice) {
    session.conversation.answerChoice = { kind: 'time', values: [time, neighbour] };
  } else {
    session.conversation.closedTimeReprompt = true;
  }
}

/**
 * Groupe au-delà du seuil du restaurant : le nombre n'est jamais retenu pour
 * une réservation automatique. Il est confirmé une fois (« Douze personnes,
 * c'est bien ça ? »), puis le tour est confié au gérant. Une valeur choisie
 * dans « X ou Y ? » vaut confirmation.
 */
function applyGroupThreshold(
  session: CallSession,
  transcript: string,
  extracted: ConversationState['slots'],
  previousChoice: ConversationState['answerChoice'],
  previousGroup: ConversationState['groupRequest'],
): void {
  const limit = voiceMaxPartySize(session);
  if (previousGroup && !previousGroup.confirmed) {
    const confirmed =
      extracted.partySize === previousGroup.partySize ||
      (extracted.partySize === undefined && isAffirmativeShortResponse(transcript));
    if (confirmed) {
      delete extracted.partySize;
      session.conversation.groupRequest = { partySize: previousGroup.partySize, confirmed: true };
      return;
    }
  }
  const partySize = extracted.partySize;
  if (partySize === undefined || partySize <= limit) return;
  delete extracted.partySize;
  session.conversation.groupRequest = {
    partySize,
    confirmed:
      previousChoice?.kind === 'partySize' && previousChoice.values.includes(String(partySize)),
  };
}

/** « Douze personnes, c'est bien ça ? » : confirmation explicite d'un groupe. */
export function buildGroupConfirmationPlan(
  session: CallSession,
): AssistantReplyEmissionPlan | null {
  const group = session.conversation.groupRequest;
  if (!group || group.confirmed) return null;
  const en = effectiveVoiceLanguage(session) === 'en';
  const spoken = en
    ? `${group.partySize} people`
    : `${FRENCH_PARTY_SIZE_WORDS[group.partySize] ?? group.partySize} personnes`;
  const reply = en
    ? `${spoken}, is that right?`
    : `${spoken.charAt(0).toUpperCase()}${spoken.slice(1)}, c'est bien ça ?`;
  return {
    reply,
    proposal: {
      source: 'explicit',
      operation: 'activate',
      interaction: {
        kind: 'partySizeConfirmation',
        prompt: reply,
        candidatePartySize: group.partySize,
      },
    },
  };
}

/** Heure fermée maintenue ou sans voisin ouvert : relance qui cite les horaires. */
export function buildClosedTimeRepromptPlan(
  session: CallSession,
): AssistantReplyEmissionPlan | null {
  if (!session.conversation.closedTimeReprompt || !session.openingHours) return null;
  const en = effectiveVoiceLanguage(session) === 'en';
  const date = session.conversation.slots.date;
  const days = date
    ? [OPENING_DAY_KEYS[new Date(`${date}T12:00:00Z`).getUTCDay()]]
    : OPENING_DAY_KEYS;
  const allowedDays = new Set(days.map((day) => OPENING_DAY_KEYS.indexOf(day)));
  const ranges = [
    ...new Set(
      normalizeOpeningHours(session.openingHours)
        .filter((period) => allowedDays.has(period.dayIndex))
        .map((slot) =>
          en
            ? `from ${formatAvailabilitySlot(slot.open, 'en')} to ${formatAvailabilitySlot(slot.close, 'en')}`
            : `de ${formatAvailabilitySlot(slot.open)} à ${formatAvailabilitySlot(slot.close)}`,
        ),
    ),
  ];
  if (!ranges.length) return null;
  const when = date
    ? en
      ? 'That day, we are open'
      : 'Ce jour-là, nous sommes ouverts'
    : en
      ? 'We are open'
      : 'Nous sommes ouverts';
  const primary = en
    ? `${when} ${ranges.join(' or ')}. What time would you like to come?`
    : `${when} ${ranges.join(' ou ')}. Vers quelle heure souhaitez-vous venir ?`;
  // Citer les horaires est déjà la reformulation : le compteur anti-boucle
  // reste actif pour proposer un humain si l'heure fermée persiste.
  if (registerDialogueStall(session, 'time') === 'escalate') {
    return buildHumanFallbackReplyPlan(session);
  }
  return buildExplicitInteractionReplyPlan(session, primary, 'time');
}

/**
 * Types sur lesquels la confirmation par la confiance agit vraiment
 * (le nombre de personnes) : la confiance de l'ancien moteur Scribe
 * sépare bien les nombres justes des faux, pas les heures (banc difficile).
 * Hors portée, la décision est seulement observée (`wouldBe…`).
 */
export function confidenceConfirmSlots(): Set<'partySize' | 'date' | 'time'> {
  return new Set(['partySize']);
}

const WOULD_BE = {
  readBack: 'wouldBeReadBack',
  choice: 'wouldBeChoice',
  reprompt: 'wouldBeReprompt',
} as const;

/**
 * Pour chaque valeur retenue ce tour (nombre, jour, heure), vérifie la
 * confiance des mots qui la portent et la stabilité des partielles.
 * Une valeur douteuse avec un voisin confusable devient « X ou Y ? » ; une
 * valeur très douteuse sans voisin est redemandée ; une heure hors des
 * horaires d'ouverture n'est jamais acceptée d'office.
 */
function applySlotConfidence(
  session: CallSession,
  transcript: string,
  extracted: ConversationState['slots'],
  now: Date,
): void {
  const scope = confidenceConfirmSlots();
  const evidence =
    session.sttEvidence &&
    normalizeTranscript(session.sttEvidence.transcript) === normalizeTranscript(transcript)
      ? session.sttEvidence
      : null;
  const timezone = session.timezone ?? 'Europe/Paris';
  const partialSlots = (evidence?.partials ?? []).map((partial) =>
    extractConversationSlots(partial, timezone, now),
  );
  const entries: NonNullable<ConversationState['lastSlotConfidence']> = [];

  const slots: Array<['partySize' | 'date' | 'time', ConfidenceSlotKind]> = [
    ['partySize', 'partySize'],
    ['date', 'weekday'],
    ['time', 'time'],
  ];
  for (const [slot, kind] of slots) {
    const raw = extracted[slot];
    if (raw === undefined) continue;
    const apply = scope.has(slot);
    const value = slot === 'date' ? weekdayOfDate(String(raw)) : String(raw);
    const partialValues = partialSlots.map((partial, index) => {
      // L'analyse exacte ignore les groupes de plus de 7 : « dix » dans une
      // partielle doit pourtant compter comme une valeur différente de « six ».
      if (slot === 'partySize') return partialPartySize(evidence!.partials[index]);
      const partialValue = partial[slot];
      if (partialValue === undefined) return undefined;
      return slot === 'date' ? weekdayOfDate(String(partialValue)) : String(partialValue);
    });
    const slotDate = extracted.date ?? session.conversation.slots.date;
    let openTimes = kind === 'time' ? openingHourTimes(session.openingHours, slotDate) : undefined;
    // La grille est au quart d'heure : une heure ouverte comme 20:10 n'y figure pas.
    if (openTimes?.length && isWithinOpeningHours(session.openingHours, slotDate, value)) {
      openTimes = [...openTimes, value];
    }
    const confidence = valueConfidence(kind, value, evidence?.words);
    const result = decideSlotConfidence({
      kind,
      value,
      confidence,
      partialAlternatives: unstableAlternatives(value, partialValues),
      openTimes,
    });
    // Un seul « X ou Y ? » par tour ; les autres valeurs douteuses sont relues.
    let decision = result.decision;
    if (decision === 'choice' && session.conversation.answerChoice) decision = 'readBack';

    if (!apply) {
      entries.push({
        kind,
        confidence: confidence === null ? null : Math.round(confidence * 100) / 100,
        unstable: result.unstable,
        decision: WOULD_BE[decision],
      });
      continue;
    }
    if (decision === 'choice' && result.choice) {
      session.conversation.answerChoice = { kind, values: result.choice };
      delete extracted[slot];
    } else if (decision === 'reprompt') {
      session.conversation.confidenceReprompt ??= {
        kind,
        outsideOpeningHours: result.outsideOpeningHours,
      };
      delete extracted[slot];
    }
    entries.push({
      kind,
      confidence: confidence === null ? null : Math.round(confidence * 100) / 100,
      unstable: result.unstable,
      decision,
    });
  }
  session.conversation.lastSlotConfidence = entries.length ? entries : null;
}

const PARTIAL_NUMBER_WORDS: Record<string, number> = {
  une: 1,
  un: 1,
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

/** Dernier nombre de 1 à 16 lu dans une partielle (« Dix personnes » → « 10 »). */
function partialPartySize(partial: string | undefined): string | undefined {
  if (!partial) return undefined;
  let found: number | undefined;
  for (const token of normalizeTranscript(partial).split(' ')) {
    const value = /^\d{1,2}$/.test(token) ? Number(token) : PARTIAL_NUMBER_WORDS[token];
    // « un / une » est presque toujours l'article (« une table ») : ignoré.
    if (value !== undefined && value >= 2 && value <= 16) found = value;
  }
  return found === undefined ? undefined : String(found);
}

/** Relance d'une valeur jugée trop incertaine, formulée autrement. */
export function buildConfidenceRepromptPlan(
  session: CallSession,
): AssistantReplyEmissionPlan | null {
  const reprompt = session.conversation.confidenceReprompt;
  if (!reprompt) return null;
  const en = effectiveVoiceLanguage(session) === 'en';
  if (reprompt.kind === 'time') {
    const openTimes = openingHourTimes(session.openingHours, session.conversation.slots.date);
    const primary =
      reprompt.outsideOpeningHours && openTimes.length
        ? en
          ? `We are open from ${formatAvailabilitySlot(openTimes[0], 'en')} that day. What time would you like to come?`
          : `Ce jour-là, nous sommes ouverts à partir de ${formatAvailabilitySlot(openTimes[0])}. Vers quelle heure souhaitez-vous venir ?`
        : en
          ? "Sorry, I didn't catch the time. What time would you like to come?"
          : "Pardon, je n'ai pas bien entendu l'heure. Vers quelle heure souhaitez-vous venir ?";
    return guardDialogueRepromptPlan(session, 'time', primary);
  }
  if (reprompt.kind === 'weekday') {
    return guardDialogueRepromptPlan(
      session,
      'date',
      en
        ? "Sorry, I didn't catch the day. Which day would you like to book?"
        : "Pardon, je n'ai pas bien entendu le jour. Pour quel jour souhaitez-vous réserver ?",
    );
  }
  return guardDialogueRepromptPlan(
    session,
    'partySize',
    en
      ? "Sorry, I didn't catch the number of people. How many will there be?"
      : "Pardon, je n'ai pas bien entendu le nombre de personnes. Vous serez combien ?",
  );
}

/** « Six ou dix ? » : question fermée entre les deux valeurs les plus proches. */
function spokenChoiceValue(
  kind: 'partySize' | 'weekday' | 'time',
  value: string,
  en: boolean,
): string {
  if (kind === 'partySize') {
    const n = Number(value);
    return en ? String(n) : (FRENCH_PARTY_SIZE_WORDS[n] ?? String(n));
  }
  if (kind === 'weekday') return value;
  return formatAvailabilitySlot(value, en ? 'en' : 'fr');
}

export function buildAnswerChoicePlan(session: CallSession): AssistantReplyEmissionPlan | null {
  const choice = session.conversation.answerChoice;
  if (!choice) return null;
  const en = effectiveVoiceLanguage(session) === 'en';
  const [first, second] = choice.values.map((value) => spokenChoiceValue(choice.kind, value, en));
  const suffix = choice.kind === 'partySize' ? (en ? ' people' : ' personnes') : '';
  // Les autres valeurs retenues au même tour sont relues dans la même phrase :
  // sinon une erreur sur l'une passe en silence (banc difficile, hv305).
  const readBack = buildNaturalReadBack(session);
  const primary = readBack
    ? `${readBack}${en ? `${first} or ${second}${suffix}?` : `${first} ou ${second}${suffix} ?`}`
    : en
      ? `Sorry, ${first} or ${second}${suffix}?`
      : `Pardon, ${first} ou ${second}${suffix} ?`;
  const key =
    choice.kind === 'partySize' ? 'partySize' : choice.kind === 'weekday' ? 'date' : 'time';
  return guardDialogueRepromptPlan(session, key, primary);
}

export function recordUserTurn(
  session: CallSession,
  transcript: string,
  speechAct: VoiceSpeechAct,
  now = new Date(),
): void {
  if (speechAct === 'closing') {
    observeVoiceReadbackResponse(session, {}, speechAct);
    const closingInteraction = getActivePendingInteraction(session);
    const decision = decideTurnPolicy(
      {
        speechAct,
        intent: session.conversation.intent,
        slots: session.conversation.slots,
        customerName: session.conversation.slots.customerName,
        activeInteractionKind:
          closingInteraction?.kind === 'open' ? null : (closingInteraction?.kind ?? null),
      },
      {
        intent: null,
        slots: {},
        partySizeEvidence: 'none',
        customerName: null,
        wantsAvailabilityOptions: false,
      },
    );
    if (decision.disposition !== 'close') return;
    session.conversation.closing = true;
    cancelAllPendingInteractions(session);
    if (decision.clearReservationConfirmation) clearReservationConfirmation(session);
    return;
  }

  const activeInteraction = getActivePendingInteraction(session);
  const activeKind =
    activeInteraction?.kind === 'open'
      ? null
      : (activeInteraction?.kind ?? session.conversation.pendingQuestion);
  const extracted = extractConversationSlots(transcript, session.timezone ?? 'Europe/Paris', now);
  let partySizeEvidence: PartySizeEvidence =
    extracted.partySize === undefined ? 'none' : 'explicit';

  if (activeKind === 'partySize' && extracted.partySize === undefined) {
    const contextualPartySize = extractContextualPartySize(transcript);
    if (contextualPartySize !== null) {
      extracted.partySize = contextualPartySize;
      partySizeEvidence = 'contextual';
    }
  }
  if (activeKind === 'partySizeConfirmation') {
    if (isAffirmativeShortResponse(transcript)) {
      const candidatePartySize = activeInteraction?.candidatePartySize;
      if (candidatePartySize !== undefined) {
        extracted.partySize = candidatePartySize;
        partySizeEvidence = 'confirmation';
      }
    } else {
      const contextualPartySize = extractContextualPartySize(transcript);
      if (contextualPartySize !== null) {
        extracted.partySize = contextualPartySize;
        partySizeEvidence = 'contextual';
      }
    }
  }

  const current = session.conversation.slots;
  const offered = session.conversation.offeredAvailability;
  if (
    offered &&
    activeKind === 'timeChoice' &&
    offered.date === current.date &&
    offered.partySize === current.partySize &&
    !extracted.date &&
    !extracted.partySize &&
    !extracted.time
  ) {
    const choice = normalizeTranscript(transcript).match(
      /^(?:(?:le|la|the) )?(premier|premiere|deuxieme|second|seconde|troisieme|dernier|derniere|first|second|third|last)(?: (?:creneau|horaire|one))?(?: s il vous plait| please)?$/,
    );
    if (choice) {
      const index = /premier|first/.test(choice[1])
        ? 0
        : /deuxieme|second/.test(choice[1])
          ? 1
          : /troisieme|third/.test(choice[1])
            ? 2
            : offered.slots.length - 1;
      const selectedTime = offered.slots[index];
      if (selectedTime) extracted.time = selectedTime;
    }
  }

  observeVoiceReadbackResponse(session, extracted, speechAct);

  const previousChoice = session.conversation.answerChoice ?? null;
  const previousGroup = session.conversation.groupRequest ?? null;
  session.conversation.answerChoice = null;
  session.conversation.groupRequest = null;
  session.conversation.closedTimeReprompt = false;
  session.conversation.justFilled = null;
  session.conversation.lastExpectedAnswer = null;
  session.conversation.phoneticAccepted = null;
  session.conversation.lastSlotConfidence = null;
  session.conversation.confidenceReprompt = null;
  if (speechAct === 'content' || speechAct === 'correction') {
    const resolved = applyExpectedAnswer(
      session,
      activeKind,
      transcript,
      extracted,
      now,
      previousChoice,
    );
    if (resolved === 'partySize') partySizeEvidence = 'contextual';
  }
  if (previousChoice) {
    const selectedValue =
      previousChoice.kind === 'partySize'
        ? extracted.partySize
        : previousChoice.kind === 'weekday'
          ? extracted.date
            ? weekdayOfDate(extracted.date)
            : undefined
          : extracted.time;
    const normalizedChoiceResponse = normalizeTranscript(transcript);
    const explicitlyNeither =
      /\b(?:aucun(?:e)?(?: des deux)?|ni l un ni l autre|neither|none of those)\b/u.test(
        normalizedChoiceResponse,
      );
    recordVoiceChoiceResponse(previousChoice, selectedValue, speechAct, explicitlyNeither);
  }
  if (speechAct === 'content' || speechAct === 'correction') {
    applyTimePlausibility(session, extracted, previousChoice);
    applySlotConfidence(session, transcript, extracted, now);
  }
  applyGroupThreshold(session, transcript, extracted, previousChoice, previousGroup);

  const wantsAvailabilityOptions = asksForAvailabilityOptions(transcript);
  const plainCustomerName = extractPlainCustomerName(
    transcript,
    session.conversation.pendingQuestion === 'customerName' && !isNameCollectionBlocking(session),
  );
  const decision = decideTurnPolicy(
    {
      speechAct,
      intent: session.conversation.intent,
      slots: current,
      customerName: current.customerName,
      activeInteractionKind: activeKind,
      ...(activeInteraction?.candidatePartySize !== undefined
        ? { activeInteractionCandidatePartySize: activeInteraction.candidatePartySize }
        : {}),
    },
    {
      intent: inferIntent(transcript),
      slots: extracted,
      partySizeEvidence,
      customerName: plainCustomerName,
      wantsAvailabilityOptions,
    },
  );
  if (decision.disposition === 'ignore') return;

  session.conversation.closing = false;
  const dayPeriod = extractDayPeriod(transcript);
  if (dayPeriod) session.conversation.dayPeriod = dayPeriod;
  if (decision.clearReservationConfirmation) clearReservationConfirmation(session);
  if (decision.intent) session.conversation.intent = decision.intent;
  if (decision.wantsAvailabilityOptions) session.conversation.wantsAvailabilityOptions = true;
  if (decision.invalidateAvailability) {
    session.conversation.offeredAvailability = undefined;
    session.conversation.lastAvailabilityResult = null;
    session.conversation.lastAvailabilityCheck = null;
  }
  session.conversation.justFilled = {
    partySize:
      decision.slots.partySize !== undefined && decision.slots.partySize !== current.partySize,
    date: decision.slots.date !== undefined && decision.slots.date !== current.date,
    time: decision.slots.time !== undefined && decision.slots.time !== current.time,
  };
  Object.assign(current, decision.slots);
  for (const slot of ['date', 'time', 'partySize'] as const) {
    const value = decision.slots[slot];
    if (value === undefined) continue;
    session.conversation.slotProvenance = {
      ...session.conversation.slotProvenance,
      [slot]: {
        source:
          slot === 'partySize' && partySizeEvidence !== 'none' ? partySizeEvidence : 'explicit',
        value,
      },
    };
  }
  if (decision.customerName) current.customerName = decision.customerName;

  if (activeInteraction && decision.resolveInteraction) {
    finishActivePendingInteraction(session, 'resolved', decision.resolveInteraction);
  }

  // Un tour qui a fait avancer le brouillon remet le garde-fou à zéro : la
  // relance suivante est une première relance, pas une répétition.
  if (decision.progressed) {
    // Une proposition de repli humain devient caduque dès que l'appelant
    // apporte une information : le parcours de réservation reprend.
    if (
      session.conversation.humanFallbackOffered ||
      session.conversation.pendingQuestion === 'humanFallback'
    ) {
      clearHumanFallback(session);
    } else {
      resetDialogueStall(session);
    }
  }
}

function asksForAvailabilityAlternative(transcript: string): boolean {
  const normalized = normalizeTranscript(transcript);
  return /\b(?:que|qu est ce que) (?:vous|tu) propose(?:z)?(?: quoi)?\b|\b(?:vous|tu) propose(?:z)? quoi\b|\b(?:je|on) (?:lui )?propose quoi\b|\bquelles? (?:sont les )?alternatives?\b|\bautres? (?:heure|horaire|creneau)\b|\b(?:sinon|une autre heure)\b|\bwhat else do you have\b|\bany other (?:time|slot)\b|\bwhat alternatives\b|\bwhat do you suggest\b/.test(
    normalized,
  );
}

export function buildAvailabilityFollowupPlan(
  session: CallSession,
  transcript: string,
): AssistantReplyEmissionPlan | null {
  if (!asksForAvailabilityAlternative(transcript)) return null;
  const result = session.conversation.lastAvailabilityResult;
  if (!result) return null;
  const language = effectiveVoiceLanguage(session);

  if (result.slots.length === 0) {
    const noAlternative =
      language === 'en'
        ? "I don't have another verified time that day."
        : "Je n'ai aucun autre créneau vérifié ce jour-là.";
    const reply = `${noAlternative} ${buildHumanFallbackOffer(session)}`;
    return buildExplicitInteractionReplyPlan(session, reply, 'humanFallback');
  }

  const alternatives = selectClosestAvailabilitySlots(result.time, result.slots)
    .map((slot) => formatAvailabilitySlot(slot, language))
    .join(language === 'en' ? ' or ' : ' ou ');
  const reply =
    language === 'en'
      ? `I can offer ${alternatives}. Which one works for you?`
      : `Je peux vous proposer ${alternatives}. Lequel vous convient ?`;
  return buildExplicitInteractionReplyPlan(session, reply, 'timeChoice');
}

export function buildAvailabilityFollowupResponse(
  session: CallSession,
  transcript: string,
): string | null {
  return buildAvailabilityFollowupPlan(session, transcript)?.reply ?? null;
}

export function buildReservationProgressPlan(
  session: CallSession,
  transcript = '',
): AssistantReplyEmissionPlan | null {
  const { intent, slots } = session.conversation;
  if (intent !== 'reservation' && intent !== 'availability') return null;
  // Une conversation qui se clôt ne doit plus relancer le formulaire.
  if (session.conversation.closing) return null;

  // Ne pas répondre déterministiquement si le transcript de l'utilisateur
  // n'est pas pertinent pour la réservation (plainte, question, frustration,
  // phrase longue ou complexe). Dans ce cas, laisser le LLM gérer.
  if (transcript) {
    const normalized = normalizeTranscript(transcript);
    // Mots qui indiquent que l'utilisateur ne répond pas à la question en attente
    if (
      /\b(?:pourquoi|comment|arrete|raccroche|laissez tomber|c est bon|allez|genant|bizarre|probleme|marche pas|entends pas|comprends pas|why|how|stop|hang up|never mind|problem|not working|can t hear|don t understand)\b/.test(
        normalized,
      )
    ) {
      return null;
    }
    // Si le transcript est long (> 60 chars) et ne contient aucune info de slot,
    // c'est probablement une phrase complexe → LLM
    const extracted = extractConversationSlots(transcript, session.timezone ?? 'Europe/Paris');
    const hasSlotInfo = Boolean(extracted.date || extracted.time || extracted.partySize);
    // Une question, une objection ou une demande d'explication n'est pas une
    // réponse au champ manquant : le LLM y répond dans le contexte plutôt que
    // de relancer le formulaire comme si l'appelant n'avait rien dit.
    if (!hasSlotInfo && isExploratoryUtterance(transcript)) return null;
    if (normalized.length > 60 && !hasSlotInfo) {
      return null;
    }
  }

  const language = effectiveVoiceLanguage(session);
  const readBack = buildNaturalReadBack(session);
  if (!slots.date)
    return guardDialogueRepromptPlan(
      session,
      'date',
      readBack + (language === 'en' ? 'What day would you like to come?' : 'Pour quel jour ?'),
    );
  if (!slots.partySize)
    return guardDialogueRepromptPlan(
      session,
      'partySize',
      readBack + (language === 'en' ? 'How many people will there be?' : 'Vous serez combien ?'),
    );
  if (!slots.time)
    return guardDialogueRepromptPlan(
      session,
      'time',
      readBack +
        (language === 'en'
          ? 'What time would you like to come?'
          : 'Vous voulez venir vers quelle heure ?'),
    );
  return null;
}

export function buildReservationProgressResponse(
  session: CallSession,
  transcript = '',
): string | null {
  return buildReservationProgressPlan(session, transcript)?.reply ?? null;
}

/**
 * Une question, une objection ou un aveu d'incompréhension demandent une
 * réponse contextualisée, jamais une relance mécanique du champ manquant.
 */
function isExploratoryUtterance(transcript: string): boolean {
  if (/\?/.test(transcript)) return true;
  const normalized = normalizeTranscript(transcript);
  return /\b(?:pourquoi|comment|qu est ce que|est ce que|c est quoi|expliquez|explique|je ne comprends pas|je comprends pas|je ne sais pas|why|how|what is|do you|can you|could you|i don t understand|i don t know)\b/.test(
    normalized,
  );
}

function isAmbiguousPartySizeReply(session: CallSession, transcript: string): boolean {
  if (session.conversation.pendingQuestion !== 'partySize') return false;
  const extracted = extractConversationSlots(transcript, session.timezone ?? 'Europe/Paris');
  if (extracted.partySize) return false;
  // Une autre information (date, heure) fait avancer la réservation : ce n'est
  // pas une réponse incomprise.
  if (extracted.date || extracted.time) return false;

  const normalized = normalizeTranscript(transcript);
  if (
    /\b(?:personne|personnes|on sera|nous serons|combien|people|guests|party|how many)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  // Réponse courte sans aucun fait exploitable, souvent un nombre mal transcrit
  // (« six personnes » → « super femme », appel du 24/09) : on redemande le
  // nombre au lieu de passer à la question suivante.
  const wordCount = normalized.split(' ').filter(Boolean).length;
  return wordCount > 0 && wordCount <= 5 && !isExploratoryUtterance(transcript);
}

/**
 * Détecte une proposition de repli humain (transfert gérant ou prise de
 * message) dans un texte de l'agent. La réponse de l'appelant doit alors
 * déclencher une action réelle au lieu de relancer le formulaire.
 */
export function isHumanFallbackOfferText(text: string): boolean {
  const normalized = normalizeTranscript(text);
  return containsHumanTransferOffer(normalized) || containsHumanMessageOffer(normalized);
}

function containsHumanTransferOffer(normalized: string): boolean {
  return /\b(?:passe(?:r)? le gerant|transferer au gerant|transfert au gerant|put you through|connect you to the manager)\b/.test(
    normalized,
  );
}

function containsHumanMessageOffer(normalized: string): boolean {
  return /\b(?:(?:prendre|prenne|laisser|laisse) un message|take a message|leave a message)\b/.test(
    normalized,
  );
}

/** Lit un nombre sans unité quand la question active attend explicitement les couverts. */
function extractContextualPartySize(transcript: string): number | null {
  const normalized = normalizeTranscript(transcript);
  const contextualPattern = new RegExp(
    `\\b(?:on (?:serait|sera|serons|est|ferait|fera|fait|vient)|nous (?:serions|serons|sommes|ferions|faisons|venons)|vous (?:etes|seriez|serez)|we (?:are|will be)|there (?:will be|are))\\s+(?:bien\\s+)?(?:a|pour)?\\s*${SPOKEN_PARTY_SIZE_PATTERN}\\b`,
    'g',
  );
  // « on sera une petite tablée », « on est un groupe » : un/une suivi d'un
  // autre mot que l'unité est un article, pas un nombre de couverts.
  const contextualMatches = [...normalized.matchAll(contextualPattern)].filter(
    (match) =>
      !/^une?$/.test(match[1]) ||
      !/^\s+(?!(?:personnes?|seule?|people|guests?|person)\b)\p{L}/u.test(
        normalized.slice((match.index ?? 0) + match[0].length),
      ),
  );
  if (contextualMatches.length) {
    const values = contextualMatches
      .map((match) => partySizeFromNumberToken(match[1]))
      .filter((value): value is number => value !== null);
    if (new Set(values).size === 1) return values[0];
    return null;
  }

  const bareAnswer = normalized.match(
    new RegExp(
      `^(?:oui |ouais |alors |ben |non |plutot |en fait )?(?:pour |for )?${SPOKEN_PARTY_SIZE_PATTERN}(?: personnes?| people| guests?)?(?: s il vous plait| svp| merci| please)?$`,
    ),
  );
  return bareAnswer ? partySizeFromNumberToken(bareAnswer[1]) : null;
}

function partySizeConfirmationCandidate(question: string): number | null {
  if (!question.includes('?')) return null;
  return extractContextualPartySize(question);
}

function humanFallbackModeFromText(text: string): 'choice' | 'transfer' | 'message' {
  const normalized = normalizeTranscript(text);
  const offersTransfer = containsHumanTransferOffer(normalized);
  const offersMessage = containsHumanMessageOffer(normalized);
  if (offersTransfer && offersMessage) return 'choice';
  return offersTransfer ? 'transfer' : 'message';
}

export function pendingQuestionFrom(question: string): PendingQuestion {
  const normalized = normalizeTranscript(question);
  // Proposition de repli humain : la réponse de l'appelant doit déclencher une
  // action réelle (transfert ou prise de message), pas une relance du formulaire.
  if (isHumanFallbackOfferText(question)) return 'humanFallback';
  if (partySizeConfirmationCandidate(question) !== null) return 'partySizeConfirmation';
  if (/\b(?:quelle date|quel jour|quand|what day|which day|what date|when)/.test(normalized))
    return 'date';
  if (
    /\b(?:ca vous irait|cela vous irait|quel(?:le)? horaire (?:choisissez|preferez|souhaitez)[ -]vous|quel(?:le)? creneau (?:choisissez|preferez|souhaitez)[ -]vous|quel horaire vous conviendrait|quel creneau vous conviendrait|quel horaire vous convient|quel creneau vous convient|entre .* horaires?|parmi .* horaires?|would either work|which one works|what time works)/.test(
      normalized,
    )
  )
    return 'timeChoice';
  if (
    /\b(?:quelle heure|a quelle heure|vers quelle heure|quel horaire|quel creneau|what time|which time)/.test(
      normalized,
    )
  )
    return 'time';
  if (/\b(?:combien de personnes|pour combien|vous serez combien)/.test(normalized)) {
    return 'partySize';
  }
  if (/\b(?:how many people|how many guests|how many of you|party size)/.test(normalized))
    return 'partySize';
  if (
    /\b(?:votre nom|quel est votre nom|au nom de qui|a quel nom|quel nom|nom pour la reservation|quelle est la (?:premiere|deuxieme|troisieme|quatrieme|cinquieme|sixieme) lettre|lettre par lettre|epeler|epellez?|what is your name|what name|under what name|spell your name|spelling)\b/.test(
      normalized,
    )
  )
    return 'customerName';
  if (/\b(?:telephone|numero|phone|telephone number|mobile)/.test(normalized))
    return 'customerPhone';
  if (
    /\b(?:vous me confirmez|confirmez[- ]vous|est[- ]ce correct|c est bien ca|c est bien cela|ca vous convient|cela vous convient|ca vous va|cela vous va|ca vous irait|cela vous irait|ca marche|c est bon(?: pour vous)?|c est correct|tout est bon|je confirme|on part la dessus|on valide|vous validez|je peux confirmer|je peux la reserver|je la reserve|je note|je valide|voulez[- ]vous que je reserve|souhaitez[- ]vous que je reserve|je lance la reservation|je cree la reservation|shall i book|may i confirm|should i book|is that correct|does that work)\b/.test(
      normalized,
    )
  )
    return 'confirmation';
  return null;
}

export function proposeAssistantInteractionFromLlmText(
  session: CallSession,
  reply: string,
): AssistantInteractionProposal {
  const lastQuestion = finalAssistantQuestion(reply);
  let pendingQuestion: PendingQuestion = null;
  if (lastQuestion) {
    // Une confirmation d'épellation (« A-K-I-F, c'est bien cela ? ») porte
    // sur le nom présenté, pas sur le récapitulatif de réservation. Le
    // contexte de collecte reste prioritaire sur le motif générique
    // « c'est bien cela ».
    pendingQuestion =
      isNameCollectionBlocking(session) &&
      session.conversation.nameCollection.state === 'confirming'
        ? 'customerName'
        : pendingQuestionFrom(lastQuestion);
  } else if (isNameCollectionBlocking(session)) {
    // L'état de collecte ne doit pas disparaître parce qu'une réponse
    // intermédiaire n'a pas de point d'interrogation exploitable.
    pendingQuestion = 'customerName';
  }
  // Une proposition de repli humain peut s'étaler sur plusieurs phrases : on
  // l'analyse sur le texte complet, pas seulement sur la dernière question.
  // L'état précédent ne survit pas à une nouvelle réponse de l'agent : une
  // question de réservation ultérieure remplace l'ancienne proposition.
  const fallbackOffer = isHumanFallbackOfferText(reply);
  const interactionKind: PendingInteractionKind | null = fallbackOffer
    ? 'humanFallback'
    : (pendingQuestion ?? (lastQuestion ? 'open' : null));
  if (!interactionKind) return { source: 'llm_text_fallback', operation: 'cancel' };
  return {
    source: 'llm_text_fallback',
    operation: 'activate',
    interaction: {
      kind: interactionKind,
      prompt: interactionKind === 'humanFallback' ? reply : (lastQuestion ?? reply),
      ...(fallbackOffer ? { fallbackMode: humanFallbackModeFromText(reply) } : {}),
      ...(interactionKind === 'partySizeConfirmation'
        ? {
            candidatePartySize: partySizeConfirmationCandidate(lastQuestion ?? reply) ?? undefined,
          }
        : {}),
    },
  };
}

function buildHumanFallbackReplyPlan(
  session: CallSession,
  reply = buildHumanFallbackOffer(session),
): AssistantReplyEmissionPlan {
  return buildExplicitInteractionReplyPlan(session, reply, 'humanFallback');
}

/**
 * Applies only a policy-approved assistant plan. `reply` is presentation and
 * contributes no question or interaction semantics here.
 */
export function recordAssistantReply(
  session: CallSession,
  reply: string,
  decision: AssistantInteractionPolicyDecision,
): void {
  if (decision.status !== 'accepted') return;

  if (decision.operation === 'activate' && decision.interaction) {
    if (decision.clearReservationConfirmation) clearReservationConfirmation(session);
    activatePendingInteraction(session, decision.interaction.kind, decision.interaction.prompt, {
      ...(decision.interaction.fallbackMode
        ? { fallbackMode: decision.interaction.fallbackMode }
        : {}),
      ...(decision.interaction.candidatePartySize !== undefined
        ? { candidatePartySize: decision.interaction.candidatePartySize }
        : {}),
    });
  } else if (decision.operation === 'cancel') {
    if (getActivePendingInteraction(session)) {
      finishActivePendingInteraction(session, 'cancelled');
    }
    resumeSuspendedPendingInteraction(session);
    if (decision.clearReservationConfirmation) clearReservationConfirmation(session);
  }

  if (decision.operation === 'activate' && decision.interaction?.kind === 'confirmation') {
    // L'accord reste lié au brouillon exact autorisé par la policy.
    session.conversation.pendingReservationConfirmationKey =
      decision.pendingReservationConfirmationKey;
    session.conversation.confirmedReservationKey = null;
  }

  if (
    /je n'ai pas (?:bien )?compris|pouvez-vous repeter|i (?:didn't|did not) understand|could you repeat|please repeat/i.test(
      reply,
    )
  ) {
    session.conversation.misunderstandingCount++;
  } else {
    // Une réponse métier cohérente confirme que le tour courant a été
    // compris : ne pas cumuler des incompréhensions anciennes.
    session.conversation.misunderstandingCount = 0;
  }
}

/** Proposes the legacy deterministic interpretation, then routes it through policy. */
export function recordAssistantReplyWithPolicy(
  session: CallSession,
  reply: string,
  proposal: AssistantInteractionProposal,
): void {
  const decision = decideAssistantInteractionPolicy(
    proposal,
    getReservationConfirmationKey(session),
  );
  if (decision.status === 'accepted') {
    recordAssistantReply(session, reply, decision);
    return;
  }

  const safeFallback = decideAssistantInteractionPolicy(
    { source: proposal.source, operation: 'cancel' },
    getReservationConfirmationKey(session),
  );
  if (safeFallback.status === 'accepted') recordAssistantReply(session, reply, safeFallback);
}

/** Use only for unstructured LLM text when its caller has no typed reply plan. */
export function recordAssistantReplyFromLlmTextFallback(session: CallSession, reply: string): void {
  recordAssistantReplyWithPolicy(
    session,
    reply,
    proposeAssistantInteractionFromLlmText(session, reply),
  );
}

/** Fil de dialogue suivi par le garde-fou anti-boucle. */
export type DialogueStallKey =
  | 'date'
  | 'time'
  | 'timeChoice'
  | 'partySize'
  | 'customerName'
  | 'customerPhone'
  | 'open';

/** Oublie le fil en cours : un tour qui a fait avancer le brouillon repart à zéro. */
export function resetDialogueStall(session: CallSession): void {
  session.conversation.stalledTurns = 0;
  session.conversation.stallSignature = null;
}

function dialogueStallKeyFromPendingQuestion(session: CallSession): DialogueStallKey {
  switch (session.conversation.pendingQuestion) {
    case 'date':
    case 'time':
    case 'timeChoice':
    case 'partySize':
    case 'customerName':
    case 'customerPhone':
      return session.conversation.pendingQuestion;
    case 'partySizeConfirmation':
      return 'partySize';
    default:
      return 'open';
  }
}

/**
 * Enregistre une relance déterministe et retourne le niveau de réponse.
 *
 * `ask` pour la première demande, `reformulate` quand la même question revient
 * sans progrès, `escalate` quand le blocage persiste : le dialogue ne doit
 * jamais rester coincé sur une phrase répétée à l'identique.
 */
export function registerDialogueStall(
  session: CallSession,
  key: DialogueStallKey,
): DialogueStallLevel {
  const conversation = session.conversation;
  if (conversation.stallSignature === key) {
    conversation.stalledTurns += 1;
  } else {
    conversation.stallSignature = key;
    conversation.stalledTurns = 1;
  }
  const level: DialogueStallLevel =
    conversation.stalledTurns >= 3
      ? 'escalate'
      : conversation.stalledTurns >= 2
        ? 'reformulate'
        : 'ask';
  conversation.lastDialogueGuard = { key, level, count: conversation.stalledTurns };
  return level;
}

/** Reformulation d'une question déjà posée, avec un exemple concret. */
function buildReformulatedPrompt(session: CallSession, key: DialogueStallKey): string {
  const en = effectiveVoiceLanguage(session) === 'en';
  switch (key) {
    case 'date':
      return en
        ? "I still don't have the day. Say for example “tomorrow” or “Friday”. Which day suits you?"
        : "Je n'ai pas encore le jour. Dites-moi par exemple « demain » ou « vendredi ». Quel jour vous convient ?";
    case 'time':
      return en
        ? 'What time would work for you? For example 7 PM or 8:30 PM.'
        : 'Quelle heure vous arrangerait ? Par exemple « 19 h » ou « 20 h 30 ».';
    case 'timeChoice':
      return en
        ? 'Which of the times I just offered would you like? Say “the first”, “the second”, or the exact time.'
        : 'Lequel des horaires que je viens de proposer préférez-vous ? Dites « le premier », « le deuxième », ou l’heure exacte.';
    case 'partySize':
      return en
        ? 'How many people should I book for? Just tell me a number, for example “four”.'
        : 'Je note combien de personnes ? Dites-moi simplement un nombre, par exemple « quatre ».';
    case 'customerName':
      return en
        ? 'What name should I put the booking under? You can also spell it letter by letter.'
        : 'Quel nom je note pour la réservation ? Vous pouvez aussi épeler votre nom, lettre par lettre.';
    case 'customerPhone':
      return en
        ? 'Which number may I use to text you the confirmation?'
        : 'Quel numéro je peux utiliser pour vous envoyer la confirmation par SMS ?';
    case 'open':
      return en
        ? 'Let’s restart simply. Tell me what you need: a table, a cancellation, or a message for the team.'
        : "Reprenons simplement. Dites-moi ce dont vous avez besoin : une table, une annulation ou un message pour l'équipe.";
  }
}

/**
 * Proposition de repli humain réellement disponible. Elle annonce uniquement
 * ce que le manager peut exécuter : transfert si une ligne gérant est
 * configurée, prise de message sinon.
 */
export function buildHumanFallbackOffer(session: CallSession): string {
  const en = effectiveVoiceLanguage(session) === 'en';
  let offer: string;
  if (session.managerPhone?.trim()) {
    offer = en
      ? 'I can put you through to the manager, or take a message for them. Which do you prefer?'
      : 'Je peux vous passer le gérant, ou prendre un message pour lui. Que préférez-vous ?';
  } else {
    offer = en
      ? 'I can take a message for the manager; they will call you back. Would you like me to do that?'
      : 'Je peux prendre un message pour le gérant, il vous rappellera. Voulez-vous que je le fasse ?';
  }
  return offer;
}

/** Efface l'état de repli humain quand la proposition n'est plus en attente. */
export function clearHumanFallback(
  session: CallSession,
  status: Extract<PendingInteractionStatus, 'resolved' | 'cancelled'> = 'cancelled',
): void {
  const active = getActivePendingInteraction(session);
  if (status === 'resolved') {
    // Un transfert ou un message termine le parcours vocal courant ; ne
    // réactive pas une ancienne question de réservation après cette action.
    for (const interaction of session.conversation.pendingInteractions) {
      if (interaction.status === 'suspended') interaction.status = 'cancelled';
    }
  }
  for (const interaction of session.conversation.pendingInteractions) {
    if (interaction.kind === 'humanFallback' && interaction.status === 'suspended') {
      interaction.status = status;
    }
  }
  if (active?.kind === 'humanFallback') {
    finishActivePendingInteraction(session, status);
  } else {
    syncPendingInteractionProjection(session);
  }
  resetDialogueStall(session);
}

function isHumanFallbackDecline(transcript: string): boolean {
  return /^(?:non merci|non merci beaucoup|no thanks?|pas besoin|ca ira|laissez tomber|never mind|forget it)$/.test(
    normalizeTranscript(transcript),
  );
}

/**
 * Applique le garde-fou à une relance : première formulation habituelle,
 * reformulation avec exemple, puis proposition de repli humain. La formulation
 * principale reste fournie par l'appelant pour que le message exact du tour
 * initial ne change pas.
 */
export function guardDialogueReprompt(
  session: CallSession,
  key: DialogueStallKey,
  primary: string,
): string {
  return guardDialogueRepromptPlan(session, key, primary).reply;
}

export function guardDialogueRepromptPlan(
  session: CallSession,
  key: DialogueStallKey,
  primary: string,
): AssistantReplyEmissionPlan {
  const level = registerDialogueStall(session, key);
  if (level === 'escalate') return buildHumanFallbackReplyPlan(session);
  const reply = level === 'reformulate' ? buildReformulatedPrompt(session, key) : primary;
  return buildExplicitInteractionReplyPlan(session, reply, key);
}

/** Réponses courtes qui ne nécessitent ni interprétation ni appel LLM.
 *
 * Volontairement minimal : on laisse le LLM gérer le stt conversationnel
 * (demander date/heure/nombre, répondre aux questions, gérer les corrections)
 * pour des réponses naturelles et variées. Le déterministe ne garde que :
 * - proposition de repli humain après 2 incompréhensions (sécurité)
 * - backchannel simple (l'utilisateur dit "oui" → reposer la dernière question)
 * - clarification nombre de personnes ambigu
 * - followup de disponibilité (alternatives proposées par l'outil)
 * - garde-fou anti-boucle : reformulation puis repli humain réel
 */
export function buildDeterministicTurnPlan(
  session: CallSession,
  speechAct: VoiceSpeechAct,
  transcript = '',
  options: { deferUnresolvedToModel?: boolean } = {},
): AssistantReplyEmissionPlan | null {
  // Une proposition de repli humain en attente est traitée par l'orchestrateur
  // (transfert ou message réellement exécuté) : le déterministe ne la répète pas.
  if (session.conversation.pendingQuestion === 'humanFallback') return null;

  // Décidés à ce tour par l'analyse de la réponse : ils passent avant la
  // relance générique d'une réponse courte.
  if (speechAct === 'content' || speechAct === 'correction') {
    const groupPlan = buildGroupConfirmationPlan(session);
    if (groupPlan) return groupPlan;
    const closedTimePlan = buildClosedTimeRepromptPlan(session);
    if (closedTimePlan) return closedTimePlan;
  }

  const pendingShortResponse = buildPendingQuestionReplyPlan(session, transcript);
  if (pendingShortResponse) return pendingShortResponse;

  // Deux incompréhensions consécutives constituent un échec de dialogue,
  // pas une invitation à poser une troisième fois la même question. On propose
  // un repli humain réel au lieu d'annoncer un transfert qui n'aurait pas lieu.
  if (speechAct === 'content' && session.conversation.misunderstandingCount >= 2) {
    return buildHumanFallbackReplyPlan(session);
  }

  if (
    speechAct === 'backchannel' &&
    session.conversation.pendingQuestion !== 'confirmation' &&
    session.conversation.lastAssistantQuestion
  ) {
    const primary =
      effectiveVoiceLanguage(session) === 'en'
        ? `All right. ${session.conversation.lastAssistantQuestion}`
        : `D'accord. ${session.conversation.lastAssistantQuestion}`;
    return guardDialogueRepromptPlan(
      session,
      dialogueStallKeyFromPendingQuestion(session),
      primary,
    );
  }

  if (speechAct === 'content' || speechAct === 'correction') {
    const answerChoicePlan = buildAnswerChoicePlan(session);
    if (answerChoicePlan) return answerChoicePlan;
    const confidenceRepromptPlan = buildConfidenceRepromptPlan(session);
    if (confidenceRepromptPlan) return confidenceRepromptPlan;
    // Canary TurnPlan : une réponse que les extracteurs n'ont pas comprise va
    // au modèle au lieu d'une relance mécanique de la même question.
    if (!options.deferUnresolvedToModel && isAmbiguousPartySizeReply(session, transcript)) {
      const primary =
        effectiveVoiceLanguage(session) === 'en'
          ? "I didn't catch the number of people. How many will there be?"
          : "Je n'ai pas bien compris le nombre de personnes. Vous serez combien ?";
      return guardDialogueRepromptPlan(session, 'partySize', primary);
    }
    // Followup de disponibilité : alternatives proposées par l'outil
    // (ces réponses dépendent du résultat de checkAvailability, pas du LLM)
    return buildAvailabilityFollowupPlan(session, transcript);
  }

  return null;
}

export function buildDeterministicTurnResponse(
  session: CallSession,
  speechAct: VoiceSpeechAct,
  transcript = '',
): string | null {
  return buildDeterministicTurnPlan(session, speechAct, transcript)?.reply ?? null;
}

/**
 * Garde-fou pour une réponse courte donnée à une question métier. Un « oui »
 * à « À quel nom je réserve ? » n'est pas un acquiescement à répéter : il
 * manque encore la valeur attendue.
 */
export function buildPendingQuestionReplyPlan(
  session: CallSession,
  transcript: string,
): AssistantReplyEmissionPlan | null {
  if (!isAffirmativeShortResponse(transcript)) return null;

  const en = effectiveVoiceLanguage(session) === 'en';
  const primary = ((): string | null => {
    switch (session.conversation.pendingQuestion) {
      case 'date':
        return en ? 'Which day would you like to book?' : "C'est pour quel jour ?";
      case 'time':
        return en ? 'What time would you like to come?' : 'Vers quelle heure ?';
      case 'timeChoice':
        return en ? 'Which time would work for you?' : 'Quel horaire vous conviendrait ?';
      case 'partySize':
        return en ? 'How many people should I book for?' : 'Vous serez combien ?';
      case 'partySizeConfirmation':
        return null;
      case 'customerName':
        if (
          session.conversation.nameCollection.state === 'confirming' &&
          session.conversation.nameCollection.presentedCandidate
        )
          return null;
        return en ? 'What name should I put the reservation under?' : "C'est à quel nom ?";
      case 'customerPhone':
        return en
          ? 'Which phone number may I use for the confirmation?'
          : 'Quel numéro de téléphone puis-je utiliser pour la confirmation ?';
      case 'confirmation':
      case 'humanFallback':
      case null:
        return null;
    }
  })();
  if (!primary) return null;
  // Une acquiescement répété sur la même question ne doit pas produire la même
  // phrase à l'identique : le garde-fou reformule, puis propose un repli humain.
  return guardDialogueRepromptPlan(session, dialogueStallKeyFromPendingQuestion(session), primary);
}

export function buildPendingQuestionResponse(
  session: CallSession,
  transcript: string,
): string | null {
  return buildPendingQuestionReplyPlan(session, transcript)?.reply ?? null;
}
