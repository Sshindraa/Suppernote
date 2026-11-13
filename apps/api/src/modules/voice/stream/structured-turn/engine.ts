/**
 * Moteur de tour structuré (canary). Un appel au modèle comprend le tour,
 * tient le brouillon, choisit une action et formule la réponse. Le code valide
 * les faits proposés, exécute les actions autorisées et rend leur résultat au
 * modèle pour la formulation. Aucune règle lexicale n'interprète l'appelant.
 */
import { logVoiceDebugText } from '../debug-dialogue';
import { callerSilenceMs } from '../caller-voice-activity';
import type { CallSession, DebugSpeechEntry } from '../types';
import { observeSemanticSignalsShadow } from '../turn-plan-shadow';
import type { CallSessionManager } from '../manager';
import { cleanTextForTts, isSessionActiveForTts, speakTtsStreamed } from '../tts-handler';
import { createContextTtsTurn } from '../context-tts';
import { effectiveVoiceLanguage } from '../voice-language';
import { finishCall } from '../call-ending';
import { isElevenLabsDialogueEnabledFor } from '../elevenlabs-dialogue-context';
import {
  markVoiceTurnLlmFirstPhrase,
  markVoiceTurnLlmFirstToken,
  recordVoiceTurnEvent,
  recordVoiceTurnEventIfCurrent,
} from '../turn-telemetry';
import {
  buildLlmFailurePlan,
  getReservationConfirmationKey,
  voiceMaxPartySize,
} from '../conversation-state';
import {
  appendDebugSpeechText,
  recordDebugAgentSpeech,
  rememberRecentAgentSpeech,
  recordDebugTool,
  settleDebugSpeech,
} from '../debug-dialogue';
import { logger } from '../../../../shared/logger/pino';
import { voiceTtsContextFailureTotal } from '../../../../shared/observability/metrics';
import {
  STRUCTURED_TURN_SCHEMA_NAME,
  AFTER_ACTION_SCHEMA_NAME,
  AFTER_ACTION_ACTIONS,
  buildAfterActionJsonSchema,
  parseAfterActionOutput,
  buildStructuredTurnJsonSchema,
  parseStructuredTurnOutput,
  type StructuredTurnAction,
  type StructuredTurnOutput,
} from './schema';
import {
  applyProposedDraft,
  authorizeStructuredAction,
  canResumeConfirmation,
  updateConfirmationState,
  bookingKey,
  createStructuredTurnState,
  isBookingComplete,
  dayPartInTimezone,
  todayInTimezone,
  type StructuredTurnState,
  parseStreamedCustomerName,
  parseStreamedDraft,
  outsideOpeningHoursFact,
  partySizeCorrectionFact,
  spelledNameFact,
  reconcileSpelledName,
  requestedSlotConflict,
  sizesWithoutTable,
  timeGivenWithoutPartySize,
  QuestionOnlyGuard,
  wordCount,
} from './fact-guards';
import { lettersOnly, nameForSpeech, readbackFact, sayReadsLetters } from './name-readback';
import {
  awaitCallerAfterJudgeDisagreement,
  startTurnEndJudge,
  type JudgeDisagreementOutcome,
} from './turn-end-judge';
import { replyContentNotFullyHeard } from '../interrupted-reply';
import { buildStructuredTurnMessages, type StructuredRecoveryKind } from './prompt';
import { cancelSpeculation, startSpeculation, takeSpeculation } from './speculation';
import { PhraseSplitter, SayStreamExtractor } from './say-stream';
import { replyScopeOf } from './reply-scope';
import { conversationContinuityEnabledFor } from '../feature-flags';
import { createTurnFiller, waitForVoiceFiller } from '../voice-filler';

/** Le modèle a répondu, mais sans rien d'exploitable : ce n'est pas une panne du fournisseur. */
class UnusableTurnOutputError extends Error {}

function responseFormat(
  actions?: readonly StructuredTurnAction[],
  options: { turnCompleteOnly?: boolean; understanding?: boolean; tone?: boolean } = {},
) {
  return {
    type: 'json_schema' as const,
    json_schema: {
      name: STRUCTURED_TURN_SCHEMA_NAME,
      strict: true as const,
      schema: buildStructuredTurnJsonSchema(actions, options),
    },
  };
}

/** Au-delà, seuls les créneaux les plus proches de l'heure demandée sont donnés au modèle. */
const MAX_SLOTS_IN_RESULT = 12;

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** « dimanche 27 septembre » pour une date AAAA-MM-JJ. */
function spokenDay(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return 'ce jour-là';
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function nearestSlots(slots: string[], time: string): string[] {
  if (slots.length <= MAX_SLOTS_IN_RESULT || !time) return slots.slice(0, MAX_SLOTS_IN_RESULT);
  const target = minutesOf(time);
  return [...slots]
    .sort((left, right) => Math.abs(minutesOf(left) - target) - Math.abs(minutesOf(right) - target))
    .slice(0, MAX_SLOTS_IN_RESULT)
    .sort();
}

const PENDING_BY_AWAITING: Partial<
  Record<StructuredTurnOutput['awaiting'], CallSession['conversation']['pendingQuestion']>
> = {
  date: 'date',
  time: 'time',
  partySize: 'partySize',
  customerName: 'customerName',
  // Relecture de l'orthographe : l'appelant peut ré-épeler, le profil STT d'épellation reste actif.
  customerNameConfirmation: 'customerName',
  confirmation: 'confirmation',
  confirmationResume: 'confirmation',
  humanFallback: 'humanFallback',
};

/** Miroir du brouillon dans l'état historique : télémétrie, finalisation, profil STT. */
function mirrorConversation(session: CallSession, state: StructuredTurnState): void {
  const { conversation } = session;
  const { draft } = state;
  if (draft.date || draft.time || draft.partySize || draft.customerName) {
    conversation.intent = conversation.intent ?? 'reservation';
  }
  conversation.slots.date = draft.date || undefined;
  conversation.slots.time = draft.time || undefined;
  conversation.slots.partySize = draft.partySize || undefined;
  conversation.slots.customerName = draft.customerName.trim() || undefined;
  conversation.pendingQuestion = PENDING_BY_AWAITING[state.lastAwaiting] ?? null;
}

interface PassResult {
  output: StructuredTurnOutput;
  spoken: boolean;
  /** Le brouillon annoncé par le modèle vise un créneau que les disponibilités lues excluent : rien n'a été dit. */
  slotConflict: boolean;
  /** Fait à donner au second passage quand l'heure visée est hors horaires (sinon lecture des créneaux). */
  hoursFact?: string;
  /** Fait à donner au second passage quand le nom relu porte des mots non épelés : rien n'a été dit. */
  nameFact?: string;
  /** Fait à donner au second passage quand une réponse douteuse porte un nombre qui corrige peut-être la taille du groupe. */
  correctionFact?: string;
  /** Verdict du juge de fin de tour pour ce passage (absent : juge non actif sur ce passage). */
  judge?: 'complete' | 'incomplete' | 'unavailable';
  /** `turnComplete` du modèle avant le verdict du juge (présent quand le juge est actif). */
  modelComplete?: boolean;
  /** Issue d'un désaccord juge « inachevé » / modèle « fini » (absent : pas de désaccord). */
  disagreement?: JudgeDisagreementOutcome;
}

/**
 * Silence après un tour jugé inachevé avant de répondre quand même : l'appelant
 * cherchait peut-être ses mots mais attend maintenant une réponse.
 *
 * Mesuré depuis la dernière voix suivie, sinon depuis la réception de la transcription finale.
 * Le silence déjà écoulé chez le STT et pendant le calcul ne crée pas un second budget.
 * Sur 14 reprises réelles après un tour inachevé, l'appelant reprend en 1,0 à 4,4 s (médiane
 * ~2,2 s) ; réglable sans déploiement par VOICE_INCOMPLETE_TURN_SILENCE_MS.
 */
import { currentInkDisagreementNote } from '../stt-ink-parallel';
import { cardGuaranteeAvailabilityFact, voiceCardGuaranteeTerms } from '../../card-guarantee-facts';

export const INCOMPLETE_TURN_SILENCE_MS = 2_000;

export function incompleteTurnSilenceMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_INCOMPLETE_TURN_SILENCE_MS ?? INCOMPLETE_TURN_SILENCE_MS);
  return Number.isFinite(parsed) && parsed >= 800 && parsed <= 6_000
    ? parsed
    : INCOMPLETE_TURN_SILENCE_MS;
}

/** Tant que des mots sont en cours de reconnaissance, on ne répond pas par-dessus l'appelant. */
const INCOMPLETE_TURN_RECHECK_MS = 700;
const INCOMPLETE_TURN_MAX_DEFERRALS = 5;

/** Dite si la relance après un silence ne produit toujours aucune phrase. */
export const CALLER_FINISHED_FALLBACK = 'Oui, je vous écoute ?';

/**
 * Début de phrase d'une relance après silence qui n'a pas encore parlé : il revient au tour qui la dépasse, et
 * l'entrée d'historique que la relance avait ajoutée (sans réponse) est retirée pour ne pas la compter deux fois.
 */
function reclaimUnansweredFragment(
  session: CallSession,
  state: StructuredTurnState,
): string | null {
  const fragment = state.unansweredFragment ?? null;
  state.unansweredFragment = null;
  if (!fragment) return null;
  const last = session.history.at(-1);
  if (last?.role === 'user' && last.content === fragment) {
    session.history.pop();
    session.turnCount--;
  }
  return fragment;
}

const incompleteTurnTimers = new WeakMap<CallSession, ReturnType<typeof setTimeout>>();

function clearIncompleteTurnTimer(session: CallSession): void {
  const timer = incompleteTurnTimers.get(session);
  if (timer) clearTimeout(timer);
  incompleteTurnTimers.delete(session);
}

function armIncompleteTurnTimer(
  session: CallSession,
  mgr: CallSessionManager,
  fragment: string,
  turnStartedAt: number,
): void {
  clearIncompleteTurnTimer(session);
  let deferrals = 0;
  const silenceBudgetMs = incompleteTurnSilenceMs();
  const hasAudioClock = () =>
    (session.callerVoice?.trackedMs ?? 0) >= 500 && session.callerVoice?.lastVoiceAt !== undefined;
  const remainingSilenceMs = () =>
    silenceBudgetMs - (hasAudioClock() ? callerSilenceMs(session) : Date.now() - turnStartedAt);
  const fire = () => {
    incompleteTurnTimers.delete(session);
    if (session.ended || session.ending) return;
    if (session.structuredTurn?.pendingFragment !== fragment) return;
    // Une reprise audio peut précéder les mots : réévaluer le silence, avec le report borné existant.
    const remainingMs = remainingSilenceMs();
    if (
      (session.sttDeepgramPendingInterim === true || remainingMs > 0) &&
      deferrals < INCOMPLETE_TURN_MAX_DEFERRALS
    ) {
      deferrals++;
      const delayMs = session.sttDeepgramPendingInterim
        ? INCOMPLETE_TURN_RECHECK_MS
        : Math.min(INCOMPLETE_TURN_RECHECK_MS, Math.max(20, remainingMs));
      const timer = setTimeout(fire, delayMs);
      timer.unref?.();
      incompleteTurnTimers.set(session, timer);
      return;
    }
    recordVoiceTurnEvent(session, 'dialogue_guard', {
      guard: 'incomplete_turn_silence',
      outcome:
        session.sttDeepgramPendingInterim === true || remainingMs > 0
          ? 'released_at_cap'
          : 'released_after_silence',
      deferrals,
      remainingMs: Math.max(0, remainingMs),
    });
    const generation = ++session.responseGeneration;
    runStructuredTurn(
      session,
      '',
      mgr,
      () => !session.ended && session.responseGeneration === generation,
      { callerFinished: true },
    ).catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.name : String(err), callId: session.callControlId },
        '[structured-turn] Silent-caller turn failed',
      );
    });
  };
  const remainingMs = remainingSilenceMs();
  // Grâce existante pour recevoir une suite tardive, même si le budget de silence est déjà écoulé.
  const remaining = Math.max(300, remainingMs);
  recordVoiceTurnEvent(session, 'dialogue_guard', {
    guard: 'incomplete_turn_silence',
    outcome: 'scheduled',
    clock: hasAudioClock() ? 'caller_audio' : 'turn_received',
    silenceBudgetMs,
    elapsedSilenceMs: Math.max(0, silenceBudgetMs - remainingMs),
    remainingMs: remaining,
  });
  const timer = setTimeout(fire, remaining);
  timer.unref?.();
  incompleteTurnTimers.set(session, timer);
  precomputeSilentCallerReply(session, mgr, fragment);
}

/**
 * Prépare pendant l'attente la réponse que le minuteur demandera si l'appelant se tait : même requête,
 * lancée tout de suite par la spéculation. Si l'appelant se tait, `runPass` la reprend (clé identique) et
 * la réponse part sans nouvel appel au modèle ; s'il reprend la parole, une nouvelle spéculation ou le tour
 * suivant l'abandonne. Rien n'est dit ni exécuté ici. Appel bb50c0d3 du 16/10/2026 : environ 1 s d'attente
 * puis un passage complet (jusqu'à 1,5 s) après chaque phrase finie jugée inachevée.
 */
function precomputeSilentCallerReply(
  session: CallSession,
  mgr: CallSessionManager,
  fragment: string,
): void {
  const state = session.structuredTurn;
  if (!state) return;
  const today = todayInTimezone(session.timezone || 'Europe/Paris');
  const { messages, format } = passRequest(session, state, fragment, [...session.history], today, {
    callerFinished: true,
  });
  startSpeculation(session, mgr, messages, format);
}

/** Attente maximale d'une lecture de créneaux en cours au début d'un tour. */
export const DAY_PREFETCH_WAIT_MS = 150;
/** Borne du nombre de requêtes de créneaux par jour lu. */
const MAX_PREFETCH_PARTY_SIZE = 12;

const dayPrefetches = new WeakMap<CallSession, { date: string; promise: Promise<void> }>();

/**
 * Lit en tâche de fond les créneaux réels du jour pour chaque taille de groupe
 * (quelques millisecondes par taille). Le modèle les reçoit dans l'ÉTAT
 * VÉRIFIÉ et peut annoncer la disponibilité sans second appel. Une lecture
 * déjà en cours pour ce jour est réutilisée.
 */
function prefetchDayAvailability(
  session: CallSession,
  mgr: CallSessionManager,
  state: StructuredTurnState,
  date: string,
): Promise<void> {
  const inFlight = dayPrefetches.get(session);
  if (inFlight?.date === date) return inFlight.promise;
  const maxSize = Math.min(voiceMaxPartySize(session), MAX_PREFETCH_PARTY_SIZE);
  const sizes = Array.from({ length: maxSize }, (_, index) => index + 1);
  const promise = Promise.all([
    Promise.all(sizes.map((size) => mgr.getAvailability(session, date, size))),
    // Plages des tables : inconnues (liste vide) si la lecture échoue, la disponibilité garde alors son comportement.
    Promise.resolve(mgr.getTableRanges(session)).catch(() => []),
  ])
    .then(([results, ranges]) => {
      if (state.draft.date !== date) return;
      // Jour fermé : pas de raccourci, la vérification garde sa phrase fixe
      // « Nous sommes fermés… » (sinon le modèle répondait « c'est noté »).
      if (results.every((result) => result.slots.length === 0 && result.allSlots.length === 0)) {
        state.dayAvailability = null;
        return;
      }
      state.dayAvailability = {
        date,
        closed: results.every(
          (result) => result.slots.length === 0 && result.allSlots.length === 0,
        ),
        slotsBySize: Object.fromEntries(
          results.map((result, index) => [sizes[index], result.slots]),
        ),
        noTableSizes: sizesWithoutTable(ranges, maxSize),
      };
    })
    .catch((err: unknown) => {
      logger.warn(
        { err: err instanceof Error ? err.name : String(err), callId: session.callControlId },
        '[structured-turn] Day availability prefetch failed',
      );
    })
    .finally(() => {
      if (dayPrefetches.get(session)?.promise === promise) dayPrefetches.delete(session);
    });
  dayPrefetches.set(session, { date, promise });
  return promise;
}

async function waitAtMost(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
  if (timer) clearTimeout(timer);
}

/** Créneaux du jour lus d'avance pour le brouillon, s'ils le couvrent. */
function prefetchedSlots(state: StructuredTurnState): string[] | null {
  const { draft, dayAvailability } = state;
  if (!dayAvailability || dayAvailability.date !== draft.date || draft.partySize < 1) return null;
  const slots = dayAvailability.slotsBySize[draft.partySize];
  // Aucun créneau pour ce nombre : même règle, la vérification annonce « complet ».
  return slots?.length ? slots : null;
}

/** Requête d'un passage : partagée par le tour et par la spéculation. */
function passRequest(
  session: CallSession,
  state: StructuredTurnState,
  transcript: string,
  history: CallSession['history'],
  today: string,
  extra: {
    actionResult?: string;
    afterAction?: boolean;
    callerFinished?: boolean;
    recovery?: StructuredRecoveryKind;
    /** Actions que le schéma autorise : le moteur peut en retirer (un congé refusé ne se rejoue pas). */
    actions?: readonly StructuredTurnAction[];
  } = {},
) {
  // Le ton n'a d'effet que sur la voix ElevenLabs Dialogue : ailleurs, le modèle ne le choisit pas.
  const tone = isElevenLabsDialogueEnabledFor(session.restaurantId);
  const replyScope = conversationContinuityEnabledFor(session.restaurantId)
    ? replyScopeOf(
        state.lastAwaiting,
        transcript,
        history.filter((message) => message.role === 'assistant').at(-1)?.content ?? '',
        state.reservationCreated,
      )
    : undefined;
  const secondOpinion = currentInkDisagreementNote(session, state.reservationCreated);
  const messages = buildStructuredTurnMessages({
    systemPrompt: session.systemPrompt,
    history,
    transcript,
    state,
    canResumeConfirmation: canResumeConfirmation(
      state,
      !session.interruptedReply || !replyContentNotFullyHeard(session.interruptedReply),
    ),
    ...(secondOpinion ? { secondOpinion } : {}),
    openingHours: session.openingHours,
    today,
    dayPart: dayPartInTimezone(session.timezone || 'Europe/Paris'),
    understanding: true,
    ...(replyScope ? { replyScope } : {}),
    ...(tone ? { tone } : {}),
    ...extra,
  });
  // Relance après un silence (appel cdc95509) : le modèle répondait encore
  // turnComplete=false et une phrase vide ; le schéma impose maintenant true.
  const format = extra.afterAction
    ? {
        type: 'json_schema' as const,
        json_schema: {
          name: AFTER_ACTION_SCHEMA_NAME,
          strict: true as const,
          schema: buildAfterActionJsonSchema({ tone }),
        },
      }
    : responseFormat(
        replyScope
          ? ['none']
          : (extra.actions ?? (extra.actionResult ? AFTER_ACTION_ACTIONS : undefined)),
        {
          turnCompleteOnly: extra.callerFinished === true || extra.recovery !== undefined,
          understanding: true,
          ...(tone ? { tone } : {}),
        },
      );
  return { messages, format };
}

/**
 * Partielle Deepgram stable pendant que l'agent écoute : lance en avance le
 * premier passage, sans rien dire ni exécuter (voir speculation.ts).
 */
export function speculateStructuredTurn(
  session: CallSession,
  mgr: CallSessionManager,
  partialTranscript: string,
  onVerdict?: (turnComplete: boolean) => void,
): void {
  if (session.ended || session.ending || session.state !== 'LISTENING') return;
  const state = session.structuredTurn ?? createStructuredTurnState();
  const transcript = [state.pendingFragment, partialTranscript]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  if (!transcript) return;
  const today = todayInTimezone(session.timezone || 'Europe/Paris');
  const { messages, format } = passRequest(session, state, transcript, [...session.history], today);
  if (!onVerdict) {
    startSpeculation(session, mgr, messages, format, onVerdict);
    return;
  }
  // Juge de fin de tour séparé (turn-end-judge.ts), en parallèle du passage anticipé : son verdict ferme le tour.
  // Sans verdict du juge (délai dépassé, erreur), le `turnComplete` du modèle ferme le tour comme avant.
  let judged: boolean | null | undefined;
  let modelVerdict: boolean | undefined;
  let decide: ((complete: boolean) => void) | undefined = onVerdict;
  const settle = () => {
    if (!decide || judged === undefined) return;
    const verdict = judged ?? modelVerdict;
    if (verdict === undefined) return;
    const send = decide;
    decide = undefined;
    send(verdict);
  };
  startTurnEndJudge(session, mgr, transcript)
    .then((verdict) => {
      judged = verdict;
      settle();
    })
    .catch(() => undefined);
  startSpeculation(session, mgr, messages, format, (verdict) => {
    modelVerdict = verdict;
    settle();
  });
}

/**
 * Relance formulée par le modèle (voir StructuredRecoveryKind) quand l'appelant n'a pas été entendu ou ne dit
 * rien. Rend la phrase, ou null : modèle indisponible, réponse invalide, vide, ou qui demande une action. Le
 * code ne juge que la structure ; l'appelant garde alors sa phrase de secours.
 */
export async function generateRecoveryReply(
  session: CallSession,
  mgr: Partial<Pick<CallSessionManager, 'streamStructuredCompletion'>>,
  kind: StructuredRecoveryKind,
  signal?: AbortSignal,
): Promise<string | null> {
  if (typeof mgr.streamStructuredCompletion !== 'function') return null;
  const state = session.structuredTurn ?? createStructuredTurnState();
  const today = todayInTimezone(session.timezone || 'Europe/Paris');
  const { messages, format } = passRequest(session, state, '', [...session.history], today, {
    recovery: kind,
  });
  const text = await mgr.streamStructuredCompletion(session, messages, format, {
    ...(signal ? { signal } : {}),
    kind: 'recovery',
    onDelta: () => undefined,
  });
  const output = parseStructuredTurnOutput(text);
  if (!output || output.action !== 'none' || !output.say.trim()) return null;
  // Comme pour un tour : la voix surjoue les points d'exclamation.
  return output.say.trim().replace(/\s*!/g, '.');
}

export async function runStructuredTurn(
  session: CallSession,
  rawTranscript: string,
  mgr: CallSessionManager,
  isCurrentResponse: () => boolean,
  options: { callerFinished?: boolean } = {},
): Promise<void> {
  const state = (session.structuredTurn ??= createStructuredTurnState());
  clearIncompleteTurnTimer(session);
  // Un début de phrase retenu au tour précédent est la même prise de parole. S'il était parti avec une
  // relance après silence restée muette (l'appelant a repris avant elle), il revient ici.
  const carried = state.pendingFragment ?? reclaimUnansweredFragment(session, state);
  const transcript = [carried, rawTranscript]
    .filter((part): part is string => Boolean(part?.trim()))
    .join(' ')
    .trim();
  state.pendingFragment = null;
  if (!transcript) return;
  if (options.callerFinished) state.unansweredFragment = transcript;
  const turnId = session.currentTurn?.id;
  const abortController = new AbortController();
  session.abortController = abortController;
  const isLive = () => isCurrentResponse() && !abortController.signal.aborted;
  const today = todayInTimezone(session.timezone || 'Europe/Paris');
  if (state.draft.date) {
    // Normalement déjà lue à la fin du tour précédent : l'attente est bornée.
    const needed =
      dayPrefetches.get(session)?.date === state.draft.date ||
      state.dayAvailability?.date !== state.draft.date;
    if (needed) {
      await waitAtMost(
        prefetchDayAvailability(session, mgr, state, state.draft.date),
        DAY_PREFETCH_WAIT_MS,
      );
    }
  }
  if (state.dayAvailability && state.dayAvailability.date !== state.draft.date) {
    state.dayAvailability = null;
  }
  const historyBefore = [...session.history];
  const replyScope = conversationContinuityEnabledFor(session.restaurantId)
    ? replyScopeOf(
        state.lastAwaiting,
        transcript,
        historyBefore.filter((message) => message.role === 'assistant').at(-1)?.content ?? '',
        state.reservationCreated,
      )
    : undefined;
  const ttsPromises: Promise<void>[] = [];
  // Toutes les phrases d'une réponse partent dans un même contexte TTS (Cartesia ou ElevenLabs) :
  // intonation continue et plus de blanc entre deux phrases (appels 0d49230d,
  // 88921164 : 1,2 à 1,6 s de silence entre « Avec plaisir ! » et la suite, la
  // phrase suivante n'étant synthétisée qu'après la fin de la précédente).
  // Le socket s'ouvre pendant la génération ; repli HTTP sans audio envoyé.
  const contextTts = createContextTtsTurn(session);
  if (contextTts) {
    session.ttsContext = contextTts;
    // L'appelant reprend la parole avant le premier son : la réponse préparée est jetée comme
    // un barge-in, avant qu'il en ait entendu un mot.
    contextTts.onHoldCancelled = () => {
      if (!isLive()) return;
      session.sttAfterBargeIn = true;
      session.abortController?.abort();
      session.abortController = null;
      mgr.handleBargeIn(session);
    };
  }
  // Petit mot d'attente pendant une vérification ou un enregistrement (voir voice-filler.ts) : `null` hors
  // restaurants listés.
  const filler = createTurnFiller(session, contextTts?.provider ?? null, {
    transcript,
    lastAwaiting: state.lastAwaiting,
    turnId,
    signal: abortController.signal,
    ...(options.callerFinished ? { callerFinished: true } : {}),
  });
  const spokenPhrases: string[] = [];
  // Ton choisi par le modèle (lu dans le flux, avant `say`) : il part avec la première phrase seulement,
  // la voix le garde pour la suite de la réponse. Jamais plus d'un par réponse.
  let replyTone: string | null = null;
  let toneSent = false;
  const toneForNextPhrase = (): { tone?: string } => {
    if (toneSent || !replyTone || replyTone === 'none') return {};
    toneSent = true;
    return { tone: replyTone };
  };
  let contextDebugEntry: DebugSpeechEntry | null = null;
  const flushSpeech = async () => {
    if (contextTts && spokenPhrases.length) {
      try {
        await contextTts.finish();
        settleDebugSpeech(contextDebugEntry, contextTts.framesSent, true);
      } catch (err) {
        const outcome = !isSessionActiveForTts(session)
          ? 'skipped'
          : contextTts.hasAudioOutput
            ? 'audio_cut'
            : 'http_fallback';
        voiceTtsContextFailureTotal.inc({ provider: contextTts.provider, outcome });
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            callId: session.callControlId,
            provider: contextTts.provider,
            outcome,
          },
          '[structured-turn] TTS context failed',
        );
        if (outcome === 'http_fallback') {
          await waitForVoiceFiller(session);
          await speakTtsStreamed(session, spokenPhrases.join(' ')).catch(() => undefined);
        }
      }
    }
    await Promise.all(ttsPromises);
  };
  const startedAt = Date.now();
  let firstPhraseSpoken = false;

  session.turnCount++;
  session.history.push({ role: 'user', content: transcript });
  mgr.transition(session, 'PROCESSING');
  recordVoiceTurnEvent(session, 'llm_started', { mode: 'structured' });

  // Nom que le modèle propose à ce tour (lu dans le flux avant `say`) : la voix doit aussi le recevoir en casse de nom propre.
  let proposedName = '';
  let replyAwaiting: StructuredTurnOutput['awaiting'] | undefined;
  const voiced = (phrase: string) =>
    nameForSpeech(nameForSpeech(phrase, state.draft.customerName), proposedName);

  const speakPhrase = (phrase: string) => {
    if (!isLive()) return;
    session.agentReplyAwaiting = replyAwaiting;
    if (!firstPhraseSpoken) {
      // La relance a parlé : son début de phrase a reçu sa réponse.
      if (options.callerFinished) state.unansweredFragment = null;
      firstPhraseSpoken = true;
      markVoiceTurnLlmFirstPhrase(session, turnId);
      mgr.transition(session, 'SPEAKING');
    }
    recordVoiceTurnEvent(session, 'llm_phrase_generated', {
      characterCount: phrase.length,
    });
    // La voix surjoue les points d'exclamation sur une phrase courte (« Avec
    // plaisiiir ! », appel 0d49230d) : ton posé côté synthèse.
    phrase = phrase.replace(/\s*!/g, '.');
    spokenPhrases.push(phrase);
    if (contextTts) {
      // Une réplique du relevé par réponse, mesurée par les trames du contexte
      // (appel 25650799 : relevé vide côté agent sans cela).
      if (contextDebugEntry) {
        appendDebugSpeechText(contextDebugEntry, phrase);
        // Les phrases suivantes reviennent aussi par l'écho : la référence anti-écho les garde.
        rememberRecentAgentSpeech(session, phrase);
      } else contextDebugEntry = recordDebugAgentSpeech(session, phrase);
      filler?.replyQueued();
      contextTts.push(cleanTextForTts(voiced(phrase), effectiveVoiceLanguage(session)), {
        ...toneForNextPhrase(),
        ...(contextTts.provider === 'elevenlabs' ? { flush: true } : {}),
      });
      return;
    }
    ttsPromises.push(speakTtsStreamed(session, voiced(phrase)).catch(() => undefined));
  };

  /** Fait sur le nom donné à la seconde passe : celle-ci relit alors le nom retenu. */
  let pendingNameFact: string | null = null;
  let afterExecutedAction = false;
  let actionReplyInterpretation: StructuredTurnOutput['interpretation'] = 'answer';

  const runPass = async (
    actionResult?: string,
    onlyActions?: readonly StructuredTurnAction[],
    forceFinished = false,
    useJudge = false,
  ): Promise<PassResult> => {
    const afterAction = actionResult !== undefined && afterExecutedAction;
    // Appelant jugé arrivé au bout de sa phrase (silence ou verdict du juge) : on répond, on ne retient plus.
    const finished = options.callerFinished === true || forceFinished;
    const extractor = new SayStreamExtractor();
    const splitter = new PhraseSplitter();
    let action: string | null = null;
    let turnComplete: boolean | null = afterAction ? true : null;
    const replyDraft = { ...state.draft };
    let replyPrefixValid = !afterAction;
    let slotConflict = false;
    let hoursFact: string | undefined;
    let nameFact: string | undefined;
    let correctionFact: string | undefined;
    let firstToken = true;
    // Relecture du nom : la phrase doit porter les lettres du nom, isolées et dans l'ordre (voir name-readback.ts).
    // Tant qu'elle n'est pas complète on la retient : sinon rien n'a été dit et le second passage reçoit les lettres.
    let readbackName: string | null = null;
    const held: string[] = [];
    const route = (phrase: string) =>
      readbackName !== null ? held.push(phrase) : speakPhrase(phrase);
    // L'appelant vient de donner l'heure, le nombre vaut encore 0 : seule la question est dite (voir
    // `timeGivenWithoutPartySize`). Les phrases qui la précèdent sont retenues ; sans question, elles sont dites.
    const questionOnly = new QuestionOnlyGuard((text) =>
      logVoiceDebugText(session, 'phrase_dropped', {
        text,
        reason: 'time_given_without_party_size',
      }),
    );
    const emit = (phrase: string) => {
      const active = !actionResult && timeGivenWithoutPartySize(extractor.raw, state.draft);
      questionOnly.push(phrase, active).forEach(route);
    };
    const { messages, format } = passRequest(session, state, transcript, historyBefore, today, {
      ...(actionResult ? { actionResult } : {}),
      ...(afterAction ? { afterAction: true } : {}),
      ...(finished ? { callerFinished: true } : {}),
      ...(onlyActions ? { actions: onlyActions } : {}),
    });
    // Juge de fin de tour séparé (turn-end-judge.ts) : son verdict remplace `turnComplete` du modèle pour décider de
    // parler. Tant qu'il n'a pas répondu, la phrase est retenue ; sans verdict (délai, erreur), `turnComplete` du modèle.
    const judging = useJudge && !finished;
    let judged = (judging ? undefined : null) as boolean | null | undefined;
    let unsaid = '';
    let firstSayText = true;
    const mayContinue = () => {
      const complete =
        finished ||
        (judged === undefined ? false : judged === null ? turnComplete === true : judged);
      // Ces courtes clarifications attendent la sortie complète pour contrôler aussi
      // que le brouillon n'a pas changé. Aucun congé ni fait réécrit ne part en streaming.
      return complete && !slotConflict && !replyScope;
    };
    const drainSaid = () => {
      if (!unsaid || action !== 'none' || !mayContinue() || !isLive()) return;
      const chunk = unsaid;
      unsaid = '';
      const phrases = splitter.push(chunk);
      phrases.forEach(emit);
    };
    const judgeSettled: Promise<void> = judging
      ? startTurnEndJudge(session, mgr, transcript).then((verdict) => {
          judged = verdict;
          drainSaid();
        })
      : Promise.resolve();
    const onDelta = (delta: string) => {
      if (!isLive()) return;
      if (firstToken) {
        firstToken = false;
        markVoiceTurnLlmFirstToken(session, turnId);
      }
      const sayText = extractor.push(delta);
      if (firstSayText && sayText.trim()) {
        firstSayText = false;
        recordVoiceTurnEventIfCurrent(session, turnId, 'llm_say_started', {
          pass: actionResult ? 2 : 1,
          contract: afterAction ? 'action_reply' : 'full_turn',
        });
      }
      unsaid += sayText;
      if (!replyPrefixValid) {
        // Les champs compacts sont tous avant say : les valider avant le premier son.
        const sayKey = /"say"\s*:/.exec(extractor.raw);
        if (
          !sayKey ||
          !parseAfterActionOutput(extractor.raw.slice(0, sayKey.index) + '"say":""}', replyDraft)
        )
          return;
        replyPrefixValid = true;
      }
      // `turnComplete` et `action` précèdent `say` dans le schéma : ils sont
      // connus quand la phrase commence.
      if (turnComplete === null) {
        const match = /"turnComplete"\s*:\s*(true|false)/.exec(extractor.raw);
        if (match) turnComplete = match[1] === 'true';
      }
      action ??= /"action"\s*:\s*"([a-z_]+)"/.exec(extractor.raw)?.[1] ?? null;
      // `awaiting` précède `say` : protéger le oui d'une confirmation avant même
      // la mise à jour définitive de lastAwaiting.
      replyAwaiting = /"awaiting"\s*:\s*"([A-Za-z]+)"/.exec(extractor.raw)?.[1] as
        | StructuredTurnOutput['awaiting']
        | undefined;
      replyTone ??= /"tone"\s*:\s*"([a-z]+)"/.exec(extractor.raw)?.[1] ?? null;
      // Créneau exclu par les disponibilités lues : le brouillon arrive avant `say`, on se tait avant
      // toute promesse et le passage suivant reçoit les faits réels (voir plus bas).
      if (!actionResult && !slotConflict && action === 'none') {
        const streamedDraft = parseStreamedDraft(extractor.raw);
        // Seulement quand le créneau vient de changer : si l'appelant pose une autre question sans
        // toucher à l'heure, la réponse ne doit pas répéter l'indisponibilité déjà annoncée.
        const before = state.draft;
        const changed =
          streamedDraft &&
          (streamedDraft.date !== before.date ||
            streamedDraft.time !== before.time ||
            streamedDraft.partySize !== before.partySize);
        const outsideHours =
          streamedDraft && changed
            ? outsideOpeningHoursFact(session.openingHours, streamedDraft)
            : null;
        if (
          streamedDraft &&
          changed &&
          (outsideHours || requestedSlotConflict(state.dayAvailability, streamedDraft))
        ) {
          slotConflict = true;
          hoursFact = outsideHours ?? undefined;
        }
        // Réponse douteuse qui porte un nombre alors que la taille du groupe est connue : on se tait, le second passage
        // reçoit le nombre à redemander (voir `partySizeCorrectionFact`).
        if (!slotConflict) {
          const fact = partySizeCorrectionFact(extractor.raw, transcript, state.draft);
          if (fact) {
            slotConflict = true;
            correctionFact = fact;
          }
        }
        // Nom relu différent des lettres épelées (lettre absente, mot collé) : on se tait avant de le dire.
        if (!slotConflict) {
          const streamedName = parseStreamedCustomerName(extractor.raw);
          if (streamedName) proposedName = streamedName;
          const fact = streamedName
            ? spelledNameFact(
                streamedName,
                transcript,
                state.lastAwaiting,
                state.draft.customerName,
              )
            : null;
          if (fact) {
            slotConflict = true;
            nameFact = fact;
          }
        }
      }
      // Le nom est connu avant `say` : si la phrase relit le nom, on la retient jusqu'à pouvoir vérifier ses lettres.
      if (readbackName === null && !slotConflict && action === 'none') {
        const awaitingNow = /"awaiting"\s*:\s*"([A-Za-z]+)"/.exec(extractor.raw)?.[1];
        // La passe qui suit un fait sur le nom est une relecture, quel que soit l'`awaiting` que le modèle déclare.
        const readbackPass = actionResult !== undefined && actionResult === pendingNameFact;
        if (awaitingNow === 'customerNameConfirmation' || readbackPass) {
          // Brouillon sans nom (seconde passe qui ne le répète pas, appel 8f254faa) : la relecture se vérifie
          // quand même, contre le nom déjà retenu. Sinon « H, O, E, T » passait pour « HOUET ».
          const streamed = afterAction
            ? replyDraft.customerName
            : parseStreamedCustomerName(extractor.raw);
          const proposed = streamed?.trim() ? streamed : state.draft.customerName;
          if (proposed?.trim()) {
            const expected = reconcileSpelledName(
              { ...state.draft, customerName: proposed },
              transcript,
              state.lastAwaiting,
              state.draft.customerName,
            ).customerName;
            if (lettersOnly(expected) !== null) readbackName = expected;
          }
        }
      }
      drainSaid();
    };
    // Premier passage : reprendre la requête déjà lancée sur la partielle stable
    // si elle est identique ; sinon (ou en cas d'échec) appel normal.
    let text: string | null = null;
    // Aussi pour la relance après un silence : sa réponse a pu être préparée pendant l'attente.
    const speculative = !actionResult
      ? takeSpeculation(session, messages, format, onDelta, abortController.signal)
      : null;
    if (speculative) {
      speculationUsed = true;
      text = await speculative.catch(() => null);
    }
    text ??= await mgr.streamStructuredCompletion(session, messages, format, {
      signal: abortController.signal,
      telemetryTurnId: turnId,
      kind: actionResult ? 'turn_after_action' : 'turn',
      onDelta,
    });
    let output = afterAction
      ? parseAfterActionOutput(text, replyDraft, actionReplyInterpretation)
      : parseStructuredTurnOutput(text);
    if (!output || !replyPrefixValid)
      throw new UnusableTurnOutputError('Invalid structured turn output');
    // Le juge a une échéance propre : on l'attend ici (il tourne depuis le début du passage, souvent déjà rendu).
    await judgeSettled;
    drainSaid();
    const modelComplete = output.turnComplete;
    // Désaccord (le juge attend la suite, le modèle a fini) : le silence réel de l'appelant tranche (voir
    // turnJudgeDisagreementSilenceMs). La réponse déjà prête part sans nouvelle requête au modèle.
    // Verdict brut du juge, pour les journaux : une réponse partie au silence reste un désaccord « inachevé ».
    const judgeVerdict = judged;
    let disagreement: JudgeDisagreementOutcome | undefined;
    if (judged === false && modelComplete && !finished) {
      disagreement = await awaitCallerAfterJudgeDisagreement(session, startedAt, isLive);
      if (disagreement === 'silent') {
        judged = true;
        drainSaid();
      }
    }
    if (typeof judged === 'boolean') output = { ...output, turnComplete: judged };
    if (judged === true && !modelComplete && spokenPhrases.length === 0 && !slotConflict) {
      // Le modèle jugeait l'appelant inachevé (say vide, par consigne) mais le juge dit qu'il a fini : réponse à refaire.
      return runPass(actionResult, onlyActions, true);
    }
    let finalOutput = output;
    const wouldSpeak =
      output.action === 'none' &&
      (output.turnComplete || finished) &&
      !slotConflict &&
      (!replyScope ||
        authorizeStructuredAction(state, output, state.draft, {
          maxPartySize: voiceMaxPartySize(session),
          replyScope,
        }).allowed);
    if (wouldSpeak) {
      if (replyScope && unsaid) {
        splitter.push(unsaid).forEach(emit);
        unsaid = '';
      }
      const rest = splitter.flush();
      if (rest) emit(rest);
      questionOnly.finish().forEach(route);
      if (readbackName !== null) {
        if (sayReadsLetters(output.say, readbackName)) {
          held.forEach(speakPhrase);
        } else if (!actionResult) {
          // La phrase ne porte pas les lettres du nom (nom dit comme un mot, graphie décrite) : rien n'est dit, le
          // second passage reçoit les lettres en données.
          slotConflict = true;
          nameFact = readbackFact(readbackName);
        } else {
          // Toujours pas de lettres isolées au second passage : le code dit les lettres, seule protection contre une
          // erreur de reconnaissance.
          const letters = lettersOnly(readbackName) ?? '';
          speakPhrase(letters);
          finalOutput = { ...output, say: letters, awaiting: 'customerNameConfirmation' };
        }
      }
    }
    const spoken = wouldSpeak && !slotConflict;
    // Ce qui est gardé dans l'historique est ce qui a été dit, pas la phrase que le modèle avait écrite.
    if (questionOnly.dropped > 0 && spoken)
      finalOutput = { ...finalOutput, say: spokenPhrases.join(' ') };
    return {
      output: finalOutput,
      spoken,
      slotConflict,
      ...(hoursFact ? { hoursFact } : {}),
      ...(nameFact ? { nameFact } : {}),
      ...(correctionFact ? { correctionFact } : {}),
      ...(judging
        ? {
            judge:
              typeof judgeVerdict !== 'boolean'
                ? ('unavailable' as const)
                : judgeVerdict
                  ? ('complete' as const)
                  : ('incomplete' as const),
            modelComplete,
            ...(disagreement ? { disagreement } : {}),
          }
        : {}),
    };
  };

  let speculationUsed = false;
  // Phrase dite si le second passage ne formule rien après l'action.
  let actionFallbackSay: string | null = null;
  // Un congé refusé : le second passage est limité à l'action « none ».
  let noHangUp = false;
  // Jour fermé ou complet : un fait simple, dit tel quel sans second passage
  // (appel 0d49230d : le modèle contredisait « FERMÉ » et promettait de réserver).
  const fixed: { reply: { say: string; awaiting: StructuredTurnOutput['awaiting'] } | null } = {
    reply: null,
  };

  const runAvailability = async (): Promise<string> => {
    afterExecutedAction = true;
    filler?.expectLongWait('check_availability');
    const { date, time, partySize } = state.draft;
    recordDebugTool(session, 'checkAvailability');
    recordVoiceTurnEvent(session, 'availability_started', {});
    const availabilityStartedAt = Date.now();
    // Lu en parallèle de la disponibilité : aucun délai ajouté au tour.
    const guaranteeTerms = voiceCardGuaranteeTerms({
      restaurantId: session.restaurantId,
      date,
      partySize,
      demo: Boolean(session.demo),
    }).catch(() => null);
    try {
      const result = await mgr.getAvailability(session, date, partySize);
      state.availability = { date, partySize, slots: result.slots };
      recordVoiceTurnEvent(session, 'availability_completed', {
        durationMs: Date.now() - availabilityStartedAt,
        slotCount: result.slots.length,
      });
      const offered = nearestSlots(result.slots, time);
      const requested = time
        ? result.slots.includes(time)
          ? ` ${time} est disponible.`
          : ` ${time} n'est pas disponible.`
        : '';
      if (result.slots.length) {
        const guarantee = await guaranteeTerms;
        return `Disponibilité réelle le ${date} pour ${partySize} personne(s) : créneaux libres ${offered.join(', ')}.${requested} Ne propose que ces horaires.${guarantee ? cardGuaranteeAvailabilityFact(guarantee) : ''}`;
      }
      const day = spokenDay(date);
      if (result.allSlots.length === 0) {
        // Aucun créneau généré : le restaurant n'ouvre pas ce jour-là.
        fixed.reply = {
          say: `Nous sommes fermés ${day}. Voulez-vous venir un autre jour ?`,
          awaiting: 'date',
        };
        return `Le restaurant est FERMÉ le ${date} (${day}) : aucun service ce jour-là. Dis-le clairement et propose un autre jour d'ouverture.`;
      }
      // Aucune table du restaurant n'accueille ce nombre (quel que soit le jour) : ce n'est pas « complet ce jour-là ».
      const ranges = await Promise.resolve(mgr.getTableRanges(session)).catch(() => []);
      if (sizesWithoutTable(ranges, partySize).includes(partySize)) {
        return `Le restaurant n'a aucune table qui accueille ${partySize} personnes, quel que soit le jour : un autre jour n'y changerait rien. Ne propose ni autre jour ni autre horaire. Traite ce nombre comme un groupe : propose le gérant ou de laisser un message (awaiting=humanFallback).`;
      }
      fixed.reply = {
        say: `Je n'ai plus de table ${day} pour ${partySize} personnes. Voulez-vous essayer un autre jour, ou que je prenne un message ?`,
        awaiting: 'open',
      };
      return `Complet le ${date} pour ${partySize} personne(s) : aucun créneau libre. Propose une autre date, le gérant ou un message.`;
    } catch (err) {
      recordVoiceTurnEvent(session, 'availability_failed', {
        durationMs: Date.now() - availabilityStartedAt,
      });
      logger.warn(
        { err: err instanceof Error ? err.name : String(err), callId: session.callControlId },
        '[structured-turn] Availability check failed',
      );
      actionFallbackSay =
        "Je n'arrive pas à vérifier les disponibilités pour le moment. Voulez-vous que je prenne un message pour le gérant ?";
      return "La vérification de disponibilité a échoué. N'annonce aucun horaire ; propose le gérant ou un message.";
    }
  };

  const runCreateReservation = async (): Promise<string> => {
    filler?.expectLongWait('create_reservation');
    const { date, time, partySize, customerName } = state.draft;
    const { conversation } = session;
    conversation.slots.date = date;
    conversation.slots.time = time;
    conversation.slots.partySize = partySize;
    conversation.slots.customerName = customerName.trim();
    conversation.lastAvailabilityResult = {
      key: `${date}:${time}:${partySize}`,
      date,
      time,
      partySize,
      slots: state.availability?.slots ?? [],
    };
    // L'accord a été vérifié par les garde-fous : récapitulatif lu, accepté.
    conversation.confirmedReservationKey = getReservationConfirmationKey(session);
    const createdBefore = session.reservationCreatedAt;
    const result = await mgr.createReservationFromConversation(session);
    afterExecutedAction = true;
    if (session.reservationCreatedAt !== createdBefore) state.reservationCreated = true;
    return (
      result ??
      "La réservation n'a pas pu être créée : les informations ne correspondent plus au créneau vérifié."
    );
  };

  const endCall = async (goodbye: string) => {
    await flushSpeech();
    session.history.push({ role: 'assistant', content: goodbye });
    await waitForVoiceFiller(session);
    await finishCall(session, mgr, goodbye);
  };

  try {
    const first = await runPass(undefined, undefined, false, true);
    actionReplyInterpretation = first.output.interpretation;
    // Une spéculation non reprise (requête différente, relance) ne sert plus.
    cancelSpeculation(session);
    if (!isLive()) return;
    if (!first.output.turnComplete && !options.callerFinished) {
      // L'appelant n'a pas fini : l'agent se tait et garde le début de phrase.
      session.history.pop();
      session.turnCount--;
      state.pendingFragment = transcript;
      recordVoiceTurnEvent(session, 'structured_turn', {
        pass: 1,
        turnComplete: false,
        interpretation: first.output.interpretation,
        confidence: first.output.confidence,
        ...(first.judge
          ? {
              judge: first.judge,
              modelComplete: first.modelComplete,
              ...(first.disagreement ? { judgeDisagreement: first.disagreement } : {}),
            }
          : {}),
      });
      mgr.transition(session, 'LISTENING');
      armIncompleteTurnTimer(session, mgr, transcript, startedAt);
      return;
    }
    const applied = applyProposedDraft(
      state.draft,
      replyScope ? { ...first.output, draft: state.draft } : first.output,
      { today },
    );
    state.draft = reconcileSpelledName(
      applied.draft,
      transcript,
      state.lastAwaiting,
      state.draft.customerName,
    );
    // Créneaux lus d'avance et couvrant le brouillon : ce sont des faits vérifiés,
    // la réservation reste soumise aux mêmes garde-fous.
    const prefetched = prefetchedSlots(state);
    if (prefetched) {
      state.availability = {
        date: state.draft.date,
        partySize: state.draft.partySize,
        slots: prefetched,
      };
    }
    // La réponse coupée n'a d'effet que sur ce tour : elle est consommée ici.
    const cutReply = session.interruptedReply;
    session.interruptedReply = undefined;
    const bookingId = isBookingComplete(state.draft) ? bookingKey(state.draft) : null;
    const recapCut =
      cutReply !== undefined &&
      replyContentNotFullyHeard(cutReply) &&
      bookingId !== null &&
      state.recapCutBlockedKey !== bookingId;
    const decision = authorizeStructuredAction(state, first.output, state.draft, {
      maxPartySize: voiceMaxPartySize(session),
      recapHeard: !recapCut,
      transcriptWords: wordCount(transcript),
      ...(replyScope ? { replyScope } : {}),
    });
    recordVoiceTurnEvent(session, 'structured_turn', {
      pass: 1,
      interpretation: first.output.interpretation,
      action: first.output.action,
      awaiting: first.output.awaiting,
      confidence: first.output.confidence,
      ...(first.output.understanding ? { understanding: first.output.understanding } : {}),
      changedFields: applied.changed.join(',') || null,
      rejectedFields: applied.rejected.join(',') || null,
      actionDecision: first.slotConflict
        ? first.hoursFact
          ? 'outside_hours'
          : first.nameFact
            ? 'spelled_name_mismatch'
            : first.correctionFact
              ? 'party_size_correction'
              : 'slot_conflict'
        : decision.allowed
          ? 'allowed'
          : decision.reason,
      prefetchedDay: Boolean(state.dayAvailability),
      speculated: speculationUsed,
      ...(first.judge
        ? {
            judge: first.judge,
            modelComplete: first.modelComplete,
            ...(first.disagreement ? { judgeDisagreement: first.disagreement } : {}),
          }
        : {}),
    });
    // Texte reçu et sortie brute du modèle, pour comprendre une erreur de compréhension (appel de test
    // du 30/09 : « vous êtes 20 demain » enregistré comme 20 h). Restaurants de test uniquement.
    logVoiceDebugText(session, 'structured_output', {
      transcript,
      say: first.output.say,
      draft: JSON.stringify(first.output.draft),
      ...(first.output.reading ? { reading: first.output.reading } : {}),
      ...(first.output.understanding ? { understanding: first.output.understanding } : {}),
      changedFields: applied.changed.join(',') || undefined,
      speculated: speculationUsed,
    });

    let final = first.output;
    let actionResult: string | null = null;
    if (!decision.allowed && decision.reason === 'slot_not_verified') {
      // Créneau non vérifié (appel 1b3f85e9) : un refus générique laissait l'appelant sans explication ni
      // alternative. La vérification réelle donne les créneaux libres et dit si l'heure demandée l'est.
      actionResult = await runAvailability();
    } else if (!decision.allowed && decision.reason === 'recap_not_heard' && cutReply) {
      // Un seul refus par récapitulatif : si l'appelant répond encore par-dessus, son accord vaut.
      state.recapCutBlockedKey = bookingId;
      actionResult = `La réservation n'est PAS encore faite : l'appelant a répondu avant d'avoir entendu tout le récapitulatif (il n'a pas entendu : « ${cutReply.unheard} »). Donne-lui brièvement la partie manquante, sans recopier ce qu'il a déjà entendu, et redemande son accord (awaiting=confirmation).`;
    } else if (!decision.allowed) {
      if (decision.reason === 'reply_scope_required') {
        noHangUp = true;
        actionResult =
          'Aucune action exécutée : la réponse brève concerne la proposition précédente, sans autoriser cette action. Suis PORTÉE DE LA RÉPONSE et pose la question utile pour poursuivre ou clarifier, sans reprendre tout le récapitulatif.';
      } else if (first.output.action === 'end_call') {
        // Congé refusé (énoncé long que le modèle n'a pas compris) : le second passage ne peut plus raccrocher.
        noHangUp = true;
        actionResult = `Action end_call non exécutée (${decision.reason}). Ce n'est pas un au revoir : ne prends pas congé, dis à l'appelant avec tes mots que tu n'as pas bien compris et demande-lui de répéter.`;
      } else {
        actionResult = `Action ${first.output.action} non exécutée (${decision.reason}). Poursuis la conversation sans l'annoncer comme faite.`;
      }
    } else if (first.slotConflict) {
      // Le modèle visait une heure hors horaires ou un créneau que les disponibilités lues excluent :
      // rien n'a été dit ; le second passage reçoit le fait réel.
      actionResult =
        first.hoursFact ?? first.nameFact ?? first.correctionFact ?? (await runAvailability());
      if (!first.hoursFact && first.nameFact) pendingNameFact = first.nameFact;
    } else {
      switch (first.output.action) {
        case 'end_call':
          if (first.output.say.trim()) {
            await endCall(first.output.say.trim());
            return;
          }
          actionResult =
            "L'appelant termine l'appel : formule un au revoir court, action=end_call.";
          break;
        case 'check_availability':
          actionResult = await runAvailability();
          break;
        case 'create_reservation':
          actionResult = await runCreateReservation();
          break;
        case 'take_message':
          if (first.output.message.trim()) {
            actionResult = await mgr.recordCallerMessage(session, first.output.message.trim());
            afterExecutedAction = true;
          } else {
            actionResult = "Message vide, non enregistré : demande ce qu'il faut transmettre.";
          }
          break;
        case 'transfer': {
          const reply = await mgr.handoffToManager(session, {
            kind: 'human_fallback_choice',
            choice: 'transfer',
          });
          if (!isLive()) return;
          if (session.demo) {
            // Démonstration : aucun transfert n'a eu lieu ; le résultat est un fait, le second passage parle.
            actionResult = reply;
            afterExecutedAction = true;
            break;
          }
          session.history.push({ role: 'assistant', content: reply });
          speakPhrase(reply);
          await flushSpeech();
          return;
        }
        case 'none':
          break;
      }
    }

    const fixedReply = fixed.reply;
    if (fixedReply) {
      speakPhrase(fixedReply.say);
      final = {
        ...first.output,
        action: 'none',
        say: fixedReply.say,
        awaiting: fixedReply.awaiting,
      };
      actionResult = null;
    }

    if (actionResult) {
      if (!isLive()) return;
      const second = await runPass(actionResult, noHangUp ? ['none'] : undefined);
      if (!isLive()) return;
      if (
        replyScope &&
        !authorizeStructuredAction(state, second.output, state.draft, {
          maxPartySize: voiceMaxPartySize(session),
          replyScope,
        }).allowed
      ) {
        throw new UnusableTurnOutputError('Reply scope clarification missing');
      }
      const reapplied = applyProposedDraft(
        state.draft,
        replyScope ? { ...second.output, draft: state.draft } : second.output,
        { today },
      );
      state.draft = reconcileSpelledName(
        reapplied.draft,
        transcript,
        state.lastAwaiting,
        state.draft.customerName,
      );
      recordVoiceTurnEvent(session, 'structured_turn', {
        pass: 2,
        contract: afterExecutedAction ? 'action_reply' : 'full_turn',
        interpretation: second.output.interpretation,
        action: second.output.action,
        awaiting: second.output.awaiting,
        confidence: second.output.confidence,
        ...(second.output.understanding ? { understanding: second.output.understanding } : {}),
        changedFields: reapplied.changed.join(',') || null,
        rejectedFields: reapplied.rejected.join(',') || null,
      });
      // Seconde passe (appel 8f254faa : relecture « H, O, E, T » alors que le premier passage disait « H, O, U, E, T ») :
      // ce que le code lui a demandé, ce que le modèle a produit, et ce qui a vraiment été dit.
      logVoiceDebugText(session, 'structured_output_pass2', {
        transcript,
        fact: actionResult.slice(0, 600),
        say: second.output.say,
        draft: JSON.stringify(second.output.draft),
        spoken: spokenPhrases.join(' | '),
        spokenByStream: second.spoken,
        stateName: state.draft.customerName,
      });
      final = second.output;
      if (!noHangUp && second.output.action === 'end_call' && second.output.confidence !== 'low') {
        if (second.output.say.trim()) {
          await endCall(second.output.say.trim());
          return;
        }
      } else if (!second.spoken && second.output.say.trim()) {
        // Une seconde action n'est jamais exécutée : la phrase reste dite.
        speakPhrase(second.output.say.trim());
      } else if (!second.output.say.trim() && actionFallbackSay) {
        // Phrase vide après l'action : dire le résultat plutôt que « je n'ai pas compris ».
        speakPhrase(actionFallbackSay);
        final = { ...second.output, say: actionFallbackSay, awaiting: 'open' };
      }
    }

    if (!final.say.trim() && options.callerFinished && final.action === 'none') {
      // Dernier filet de la relance : une invitation à continuer, jamais « pas compris ».
      final = { ...final, say: CALLER_FINISHED_FALLBACK, awaiting: 'open' };
      speakPhrase(CALLER_FINISHED_FALLBACK);
    }
    const said = final.say.trim();
    if (!said) throw new UnusableTurnOutputError('Structured turn produced no speech');
    session.conversation.llmFailureStreak = 0;
    updateConfirmationState(state, final, !cutReply || !replyContentNotFullyHeard(cutReply));
    mirrorConversation(session, state);
    // Lecture fraîche du jour pour le tour suivant, sans attendre.
    if (state.draft.date) {
      // Les erreurs sont journalisées dans la lecture elle-même.
      prefetchDayAvailability(session, mgr, state, state.draft.date).catch(() => undefined);
    }
    session.history.push({ role: 'assistant', content: said });
    observeSemanticSignalsShadow(session, {
      transcript,
      reply: said,
      previousQuestion:
        historyBefore.filter((message) => message.role === 'assistant').at(-1)?.content ?? null,
      activeInteraction: 'none',
      turnId,
      agentInterpretation: final.interpretation,
    });
    recordVoiceTurnEventIfCurrent(session, turnId, 'llm_completed', {
      mode: 'structured',
      durationMs: Date.now() - startedAt,
      characterCount: said.length,
    });
    await flushSpeech();
    if (isCurrentResponse()) mgr.transition(session, 'LISTENING');
  } catch (err) {
    if (!isLive()) return;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), callId: session.callControlId },
      '[structured-turn] Turn failed, spoken fallback',
    );
    recordVoiceTurnEventIfCurrent(session, turnId, 'llm_interrupted', {
      mode: 'structured',
      reason: 'error',
      durationMs: Date.now() - startedAt,
    });
    await flushSpeech();
    // Compteur perdu avec le mode à outils (#395) : sans lui, l'escalade vers le gérant ou un message
    // (deuxième échec d'affilée, voir buildLlmFailurePlan) ne se déclenchait plus.
    session.conversation.llmFailureStreak = (session.conversation.llmFailureStreak ?? 0) + 1;
    const cause = err instanceof UnusableTurnOutputError ? 'unusable' : 'technical';
    const fallback = buildLlmFailurePlan(session, cause).reply;
    session.history.push({ role: 'assistant', content: fallback });
    mgr.transition(session, 'SPEAKING');
    await waitForVoiceFiller(session);
    await speakTtsStreamed(session, fallback);
    if (isCurrentResponse()) mgr.transition(session, 'LISTENING');
  } finally {
    filler?.dispose();
    // Tour sans phrase (fragment retenu, relance, interruption) : le contexte
    // ouvert d'avance est fermé sans audio.
    if (contextTts && !spokenPhrases.length) contextTts.cancel('unused');
    // Réponse coupée ou échouée : ce qui n'a pas été fixé l'est ici.
    settleDebugSpeech(contextDebugEntry, contextTts?.framesSent ?? 0, false);
    if (session.ttsContext === contextTts) session.ttsContext = null;
    // Relance terminée sans être dépassée : son début de phrase est traité, même si elle s'est tue.
    if (options.callerFinished && isCurrentResponse()) state.unansweredFragment = null;
  }
}
