import { WebSocket } from 'ws';
import {
  callerSilenceMs,
  callerSpokeClearlySince,
  noCallerVoiceSince,
  trackCallerVoice,
  callerPauseFinalizeMs,
} from './caller-voice-activity';
import { isRepeatOfLastProcessedTurn } from './transcript-dedupe';
import { checkFastBargeIn } from './fast-barge-in';
import { clearBackchannelCandidate, handleCallerBackchannel } from './caller-backchannel';
import { logVoiceDebugText } from './debug-dialogue';
import { writeDebugLog } from './debug-log';
import type { CallSession, SttEvent, SttFinalTrigger, SttWord } from './types';
import { CallSessionManager } from './manager';
import { speculateStructuredTurn } from './structured-turn/engine';
import {
  isNameCollectionBlocking,
  isVoiceDialogueIncompleteTranscript,
} from './conversation-state';
import { logger } from '../../../shared/logger/pino';
import * as Sentry from '@sentry/node';
import { describeTranscript } from './pii-redact';
import {
  voiceProviderErrorsTotal,
  voiceSilenceGuardTotal,
  voiceSttProviderAudioMessagesTotal,
  voiceSttProviderChunkBytes,
  voiceNoCallerVoiceTranscriptTotal,
} from '../../../shared/observability/metrics';
import {
  getSttChunkMs,
  STT_CHUNK_MS_DEFAULT,
  STT_CHUNK_SAFETY_EXTRA_MS,
} from '../../../shared/stt-chunking';
import { telnyxBytesPerMs } from './telnyx-codec';
import { mapSttAudioClock } from './stt-audio-clock';
import { buildSttKeyterms } from './stt-keyterms';
export { buildSttKeyterms } from './stt-keyterms';
import {
  createDeepgramSttAdapter,
  type NormalizedSttProviderMessage,
  type SttProviderAdapter,
  buildCartesiaTurnsUrl,
  createCartesiaTurnsSttAdapter,
} from './stt-provider-adapter';
import { resolveVoiceFeatureSnapshot } from './feature-flags';
import { addSttAudioSamples } from '../../usage/voice-usage.service';
import { alertTerminalSttUnavailable, recordSttConnectionUnavailable } from './stt-alerts';
import { voiceConfig } from '../../../env';
import { filterAssistantEcho, hasBargeInWordThreshold } from './assistant-echo';
import {
  describeInterruptionEvidence,
  hasInterruptionEvidence,
  isNoiseTurn,
} from './barge-in-evidence';
import { expectsSpelledLetters } from './structured-turn/fact-guards';
import { cancelNoInputRecovery, scheduleUnheardRecovery } from './no-input-recovery';
import { resumeInterruptedGreeting } from './greeting-resume';
import {
  closeInkParallel,
  peekReadyInkTranscript,
  openInkParallel,
  partySizeDiffers,
  resolveInkTranscript,
  sendInkAudio,
} from './stt-ink-parallel';

export const STT_RETRY_BACKOFF_MS = [500, 1_000, 2_000] as const;
export const STT_MAX_CONSECUTIVE_FAILURES = 4;
export const STT_MAX_RECONNECTIONS_PER_CALL = 8;
export const STT_CONNECT_TIMEOUT_MS = 2_500;
// Laisse passer quatre délais de connexion (4 × 2,5 s) et le backoff
// (3,5 s) avant le repli déclenché par la limite d'échecs consécutifs.
export const STT_UNAVAILABLE_DEADLINE_MS = 15_000;
export const DIALOGUE_V2_INCOMPLETE_HOLD_MS = 900;

export type SttWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocket;

function terminalSttReason(
  messageType: string | undefined,
): Extract<SttEvent, { type: 'Unavailable' }>['reason'] | null {
  const normalized = messageType?.toLowerCase() ?? '';
  if (normalized.includes('quota')) return 'quota';
  if (normalized.includes('unaccepted_terms') || normalized.includes('terms')) return 'terms';
  if (
    normalized.includes('auth') ||
    normalized.includes('unauthorized') ||
    normalized.includes('forbidden')
  )
    return 'auth';
  return null;
}

function clearSttRecoveryTimers(session: CallSession): void {
  if (session.sttRetryTimer) clearTimeout(session.sttRetryTimer);
  if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
  if (session.sttConnectionDeadlineTimer) clearTimeout(session.sttConnectionDeadlineTimer);
  session.sttRetryTimer = null;
  session.sttConnectTimeout = null;
  session.sttConnectionDeadlineTimer = null;
  if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
  session.sttKeepAliveTimer = null;
}

/**
 * Secours Ink-2, pour tous les restaurants : quand Deepgram est déclaré indisponible, l'appel bascule une fois sur
 * Cartesia Ink-2 en mode tours au lieu d'être coupé. Sans `CARTESIA_API_KEY`, ou si le secours a déjà servi, le
 * parcours d'indisponibilité habituel reprend.
 */
export function isSttInkFallbackEnabled(
  restaurantId: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(restaurantId && (env.CARTESIA_API_KEY ?? '').trim());
}

function switchToInkFallback(
  session: CallSession,
  reason: Extract<SttEvent, { type: 'Unavailable' }>['reason'],
  message: string,
): boolean {
  if (
    session.sttInkFallbackUsed ||
    session.sttAdapter?.id !== 'deepgram' ||
    !isSttInkFallbackEnabled(session.restaurantId)
  ) {
    return false;
  }
  session.sttInkFallbackUsed = true;
  if (session.sttProviderOpenedOnce) flushDeepgramFinalPartsForSafety(session);
  clearSttRecoveryTimers(session);
  clearDeepgramStallTimer(session);
  const previous = session.sttWs;
  session.sttWs = null;
  session.sttReady = null;
  if (previous) {
    try {
      session.sttAdapter.close(previous, 1000, 'switching to fallback STT');
    } catch {
      // La socket Deepgram est déjà perdue.
    }
  }
  // L'Ink-2 parallèle éventuel ferait double emploi avec le secours.
  closeInkParallel(session).catch(() => undefined);
  session.sttAdapter = createCartesiaTurnsSttAdapter({ model: 'ink-2' });
  session.sttConsecutiveFailures = 0;
  session.sttReconnectAttempts = 0;
  session.sttTerminalFailure = false;
  logger.warn(
    { callId: session.callControlId, reason, err: message.slice(0, 200) },
    '[stt] Deepgram unavailable, switching to Ink-2 fallback',
  );
  voiceProviderErrorsTotal.inc({ provider: 'deepgram_stt', type: 'fallback_ink' });
  connectStt(session).catch(() => {
    // La tentative journalise son échec ; un second échec coupe l'appel comme avant.
  });
  return true;
}

function triggerSttUnavailable(
  session: CallSession,
  reason: Extract<SttEvent, { type: 'Unavailable' }>['reason'],
  message: string,
): void {
  if (session.ended || session.sttFallbackTriggered) return;
  if (switchToInkFallback(session, reason, message)) return;
  if (session.sttProviderOpenedOnce) flushDeepgramFinalPartsForSafety(session);
  session.sttTerminalFailure = true;
  session.sttFallbackTriggered = true;
  clearSttRecoveryTimers(session);
  session.audioBuffer = [];
  if (reason === 'connection') {
    const provider = metricProvider(session);
    voiceProviderErrorsTotal.inc({
      provider,
      type: 'connection_unavailable',
    });
    recordSttConnectionUnavailable(undefined, provider).catch((error) =>
      logger.warn({ err: error }, '[stt] Could not dispatch connection alert'),
    );
  } else if (reason === 'quota' || reason === 'auth' || reason === 'terms') {
    alertTerminalSttUnavailable(reason, undefined, metricProvider(session)).catch((error) =>
      logger.warn({ err: error }, '[stt] Could not dispatch terminal provider alert'),
    );
  }
  const ws = session.sttWs;
  session.sttWs = null;
  session.sttReady = null;
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(1011, 'STT unavailable');
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    } catch {
      // Un socket déjà fermée n'empêche pas le repli parlé.
    }
  }
  session.onSttEvent?.({ type: 'Unavailable', reason, message });
}

function ensureSttAvailabilityDeadline(session: CallSession): void {
  if (
    session.sttConnectionDeadlineTimer ||
    session.sttTerminalFailure ||
    session.sttFallbackTriggered
  )
    return;
  session.sttConnectionDeadlineTimer = setTimeout(() => {
    session.sttConnectionDeadlineTimer = null;
    if (session.sttWs?.readyState === WebSocket.OPEN) return;
    triggerSttUnavailable(
      session,
      'connection',
      'Speech-to-text did not become available before the connection deadline',
    );
  }, STT_UNAVAILABLE_DEADLINE_MS);
}

function handleSttConnectionFailure(
  session: CallSession,
  error: Error,
  createSocket: SttWebSocketFactory,
): void {
  if (!session.ended && session.sttProviderOpenedOnce) {
    flushDeepgramFinalPartsForSafety(session);
  }
  if (session.ended || session.sttTerminalFailure || session.sttFallbackTriggered) return;
  session.sttConsecutiveFailures = (session.sttConsecutiveFailures ?? 0) + 1;
  if (session.sttConsecutiveFailures >= STT_MAX_CONSECUTIVE_FAILURES) {
    triggerSttUnavailable(session, 'connection', error.message);
    return;
  }
  if ((session.sttReconnectAttempts ?? 0) >= STT_MAX_RECONNECTIONS_PER_CALL) {
    triggerSttUnavailable(session, 'connection', error.message);
    return;
  }

  ensureSttAvailabilityDeadline(session);
  if (session.sttRetryTimer) return;
  const delay =
    STT_RETRY_BACKOFF_MS[
      Math.min(session.sttConsecutiveFailures - 1, STT_RETRY_BACKOFF_MS.length - 1)
    ];
  session.sttRetryTimer = setTimeout(() => {
    session.sttRetryTimer = null;
    if (session.ended || session.sttTerminalFailure || session.sttFallbackTriggered) return;
    session.sttReconnectAttempts = (session.sttReconnectAttempts ?? 0) + 1;
    connectStt(session, undefined, createSocket).catch(() => {
      // The connection attempt records its own failure and schedules the next retry.
    });
  }, delay);
}

export const STT_SPELLING_EOT_GRACE_MS = 650;
export const STT_AUDIO_BUFFER_MAX = 400;

const MAX_TURN_PARTIALS = 30;

export const DEEPGRAM_ENDPOINTING_MS = 200;
export const DEEPGRAM_UTTERANCE_END_MS = 1_000;

export function buildDeepgramSttUrl(
  codec: CallSession['codec'],
  keyterms: readonly string[] = buildSttKeyterms(),
  model: 'nova-3' | 'flux-general-multi' = 'nova-3',
  options: { numerals?: boolean; punctuate?: boolean; mipOptOut?: boolean } = {},
): string {
  const encoding = codec === 'PCMA' ? 'alaw' : codec === 'PCMU' ? 'mulaw' : 'linear16';
  const sampleRate = codec === 'L16' ? 16000 : 8000;
  const numerals = options.numerals ?? true;
  const punctuate = options.punctuate ?? false;
  const mipOptOut = options.mipOptOut ?? voiceConfig.VOICE_DEEPGRAM_MIP_OPT_OUT !== 'false';
  if (model === 'flux-general-multi') {
    const params = new URLSearchParams({
      model,
      language_hint: 'fr',
      encoding,
      sample_rate: String(sampleRate),
      eot_threshold: '0.7',
      eager_eot_threshold: '0.5',
      eot_timeout_ms: String(
        voiceConfig.VOICE_DEEPGRAM_UTTERANCE_END_MS ?? DEEPGRAM_UTTERANCE_END_MS,
      ),
      numerals: String(numerals),
      mip_opt_out: String(mipOptOut),
    });
    for (const keyterm of keyterms) params.append('keyterm', keyterm);
    return `wss://${voiceConfig.DEEPGRAM_API_HOST}/v2/listen?${params.toString()}`;
  }
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'fr',
    encoding,
    sample_rate: String(sampleRate),
    interim_results: 'true',
    endpointing: String(voiceConfig.VOICE_DEEPGRAM_ENDPOINTING_MS ?? DEEPGRAM_ENDPOINTING_MS),
    utterance_end_ms: String(
      voiceConfig.VOICE_DEEPGRAM_UTTERANCE_END_MS ?? DEEPGRAM_UTTERANCE_END_MS,
    ),
    vad_events: 'true',
    smart_format: 'false',
    numerals: String(numerals),
    punctuate: String(punctuate),
    mip_opt_out: String(mipOptOut),
  });
  for (const keyterm of keyterms) params.append('keyterm', keyterm);
  return `wss://${voiceConfig.DEEPGRAM_API_HOST}/v1/listen?${params.toString()}`;
}

/** Fournisseur de reconnaissance de la session (« deepgram », « cartesia » en secours), pour les journaux. */
export function sttProviderId(session: CallSession): SttProviderAdapter['id'] {
  return sttAdapterForSession(session).id;
}

function sttAdapterForSession(session: CallSession): SttProviderAdapter {
  return (session.sttAdapter ??= createDeepgramSttAdapter({
    model: resolveVoiceFeatureSnapshot(session).deepgramModel,
  }));
}

interface SttTurnTiming {
  transcriptProvider?: string;
  speechEndAt?: number;
  sttFinalAt?: number;
  finalTrigger?: SttFinalTrigger;
  providerResultEndMs?: number;
  providerLastWordEndMs?: number;
  receivedAtAudioMs?: number;
  audioClockDriftMs?: number;
  firstPartialAt?: number;
  afterBargeIn?: boolean;
}

function metricProvider(session: CallSession): SttProviderAdapter['metricLabel'] {
  return sttAdapterForSession(session).metricLabel;
}

function sttTimingFromOffset(
  session: CallSession,
  offsetMs?: number,
  finalTrigger: SttFinalTrigger = 'speech_final',
  providerResultEndMs?: number,
  providerLastWordEndMs?: number,
): SttTurnTiming {
  const sttFinalAt = Date.now();
  const adapter = session.sttAdapter;
  const audioClock =
    session.sttConnectionAudioStartedAt !== undefined && adapter
      ? mapSttAudioClock({
          connectionAudioStartedAt: session.sttConnectionAudioStartedAt,
          now: sttFinalAt,
          sentBytes: session.sttConnectionAudioBytesSent ?? 0,
          bytesPerMs: adapter.chunkBytesPerMs(session.codec),
          providerOffsetMs: offsetMs,
        })
      : undefined;
  const firstPartialAt =
    session.sttFirstPartialAt !== undefined
      ? Math.max(
          0,
          session.sttFirstPartialAt - (session.sttTurnStartedAt ?? session.sttFirstPartialAt),
        )
      : undefined;
  const speechEndAt =
    audioClock?.speechEndAt ??
    (session.sttAdapter?.id === 'deepgram'
      ? undefined
      : (session.sttLastNonEmptyPartialAt ?? session.sttLastSpeechStartedAt));
  return {
    ...(speechEndAt !== undefined ? { speechEndAt } : {}),
    sttFinalAt,
    finalTrigger,
    ...(providerResultEndMs !== undefined ? { providerResultEndMs } : {}),
    ...(providerLastWordEndMs !== undefined ? { providerLastWordEndMs } : {}),
    ...(audioClock ? { receivedAtAudioMs: audioClock.receivedAtAudioMs } : {}),
    ...(audioClock ? { audioClockDriftMs: audioClock.audioClockDriftMs } : {}),
    ...(firstPartialAt !== undefined ? { firstPartialAt } : {}),
    afterBargeIn: session.sttAfterBargeIn === true,
  };
}

function withFinalTrigger(
  timing: SttTurnTiming | undefined,
  finalTrigger: SttFinalTrigger,
): SttTurnTiming {
  return { ...(timing ?? {}), finalTrigger };
}

function resetSttTurnDiagnostics(session: CallSession): void {
  session.sttTurnStartedAt = undefined;
  session.sttFirstPartialAt = undefined;
  session.sttAfterBargeIn = false;
}

function mergeSttTiming(previous?: SttTurnTiming, next?: SttTurnTiming): SttTurnTiming | undefined {
  if (!previous && !next) return undefined;
  return {
    ...(previous ?? {}),
    ...(next ?? {}),
    ...(previous?.transcriptProvider &&
    next?.transcriptProvider &&
    previous.transcriptProvider !== next.transcriptProvider
      ? { transcriptProvider: 'mixed-stt' }
      : {}),
  };
}

function clearPendingSttEndOfTurn(session: CallSession): void {
  if (session.sttEndOfTurnTimer) {
    clearTimeout(session.sttEndOfTurnTimer);
    session.sttEndOfTurnTimer = null;
  }
  session.pendingSttEndOfTurn = null;
}

function transcriptWords(transcript: string): string[] {
  return transcript.trim().split(/\s+/u).filter(Boolean);
}

function mergeSttTranscripts(previous: string, next: string): string {
  const previousWords = transcriptWords(previous);
  const nextWords = transcriptWords(next);
  if (previousWords.length === 0) return next.trim();
  if (nextWords.length === 0) return previous.trim();

  const normalizeWord = (word: string) => word.toLocaleLowerCase('fr-FR');
  const previousNormalized = previousWords.map(normalizeWord);
  const nextNormalized = nextWords.map(normalizeWord);
  const startsWith = (full: string[], prefix: string[]) =>
    prefix.length <= full.length && prefix.every((word, index) => full[index] === word);

  if (startsWith(nextNormalized, previousNormalized)) return next.trim();
  if (startsWith(previousNormalized, nextNormalized)) return previous.trim();

  const maxOverlap = Math.min(previousWords.length, nextWords.length);
  for (let overlap = maxOverlap; overlap > 0; overlap--) {
    const previousSuffix = previousNormalized.slice(previousWords.length - overlap);
    const nextPrefix = nextNormalized.slice(0, overlap);
    if (previousSuffix.every((word, index) => word === nextPrefix[index])) {
      return [...previousWords, ...nextWords.slice(overlap)].join(' ');
    }
  }
  return [...previousWords, ...nextWords].join(' ');
}

function mergeIncompleteDialogueTranscript(previous: string, next: string): string {
  const normalize = (value: string) =>
    value
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLocaleLowerCase('fr-FR')
      .replace(/[^\p{L}\p{N}]/gu, '');
  const previousWords = transcriptWords(previous);
  const nextWords = transcriptWords(next);
  const previousNormalized = previousWords.map(normalize);
  const nextNormalized = nextWords.map(normalize);
  if (
    previousNormalized.length <= nextNormalized.length &&
    previousNormalized.every((word, index) => word === nextNormalized[index])
  ) {
    return next.trim();
  }
  if (
    nextNormalized.length <= previousNormalized.length &&
    nextNormalized.every((word, index) => word === previousNormalized[index])
  ) {
    return previous.trim();
  }
  return mergeSttTranscripts(previous, next);
}

function clearSemanticHold(
  session: CallSession,
): NonNullable<CallSession['sttSemanticHold']> | null {
  const hold = session.sttSemanticHold ?? null;
  if (hold?.timer) clearTimeout(hold.timer);
  session.sttSemanticHold = null;
  return hold;
}

function holdIncompleteDialogueTranscript(
  session: CallSession,
  transcript: string,
  words?: SttWord[],
  languageCode?: string,
  timing?: SttTurnTiming,
): void {
  const previous = clearSemanticHold(session);
  const mergedWords =
    previous?.words || words ? [...(previous?.words ?? []), ...(words ?? [])] : undefined;
  const hold = {
    transcript: previous
      ? mergeIncompleteDialogueTranscript(previous.transcript, transcript)
      : transcript,
    ...(mergedWords ? { words: mergedWords } : {}),
    ...((languageCode ?? previous?.languageCode)
      ? { languageCode: languageCode ?? previous?.languageCode }
      : {}),
    ...(mergeSttTiming(previous?.timing, timing)
      ? { timing: mergeSttTiming(previous?.timing, timing) }
      : {}),
    holdMs: DIALOGUE_V2_INCOMPLETE_HOLD_MS,
    timer: null,
  };
  session.sttSemanticHold = hold;
  logger.debug(
    { callId: session.callControlId, holdMs: hold.holdMs, reason: 'incomplete_dialogue_turn' },
    '[stt] Holding incomplete dialogue turn',
  );
  armSemanticHoldTimer(session, hold);
}

function armSemanticHoldTimer(
  session: CallSession,
  hold: NonNullable<CallSession['sttSemanticHold']>,
): void {
  if (hold.timer) clearTimeout(hold.timer);
  hold.timer = setTimeout(() => {
    if (session.sttSemanticHold !== hold) return;
    session.sttSemanticHold = null;
    dispatchUtteranceEnd(
      session,
      hold.transcript,
      hold.words,
      hold.languageCode,
      withFinalTrigger(hold.timing, 'semantic_hold'),
    );
  }, hold.holdMs);
}

/**
 * Fin de tour hybride (secours Ink-2) : après la fin de tour du fournisseur, attend un délai variable
 * selon la phrase. Si le client reprend pendant l'attente, la suite est
 * fusionnée au texte retenu au lieu de créer un second tour.
 */
function dispatchOrHoldUtteranceEnd(
  session: CallSession,
  transcript: string,
  words?: SttWord[],
  languageCode?: string,
  timing?: SttTurnTiming,
): void {
  // Fin de tour détectée : vider le tampon pour que le fournisseur ait vu tout l'audio
  // avant que le tour soit traité.
  flushSttChunkBuffer(session);
  const previous = clearSemanticHold(session);
  const merged = previous
    ? isVoiceDialogueIncompleteTranscript(previous.transcript)
      ? mergeIncompleteDialogueTranscript(previous.transcript, transcript)
      : mergeSttTranscripts(previous.transcript, transcript)
    : transcript;
  const mergedWords = previous?.words && words ? [...previous.words, ...words] : words;
  const mergedLanguage = languageCode ?? previous?.languageCode;
  const mergedTiming = mergeSttTiming(previous?.timing, timing);

  const { holdMs, reason } = getSmartEndpointDelay(merged);
  if (holdMs === 0) {
    dispatchUtteranceEnd(session, merged, mergedWords, mergedLanguage, mergedTiming);
    return;
  }

  logger.debug({ callId: session.callControlId, reason, holdMs }, '[stt] Holding end of turn');
  const hold: NonNullable<CallSession['sttSemanticHold']> = {
    transcript: merged,
    ...(mergedWords ? { words: mergedWords } : {}),
    ...(mergedLanguage ? { languageCode: mergedLanguage } : {}),
    ...(mergedTiming ? { timing: mergedTiming } : {}),
    holdMs,
    timer: null,
  };
  session.sttSemanticHold = hold;
  armSemanticHoldTimer(session, hold);
}

function dispatchUtteranceEnd(
  session: CallSession,
  transcript: string,
  words?: SttWord[],
  languageCode?: string,
  timing?: SttTurnTiming,
): void {
  flushSttChunkBuffer(session);
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return;
  // Un tour fusionné avec Ink ne possède pas de mots/confiances alignés sur tout son texte.
  if (timing?.transcriptProvider === 'cartesia-ink-2' || timing?.transcriptProvider === 'mixed-stt')
    words = undefined;
  if (languageCode) session.sttLanguageCode = languageCode;
  const sttFinalAt = timing?.sttFinalAt ?? Date.now();
  const speechEndAt =
    timing?.speechEndAt ??
    (session.sttAdapter?.id === 'deepgram' ? undefined : session.sttLastNonEmptyPartialAt);
  const turnDispatchedAt = Date.now();
  if (speechEndAt !== undefined) session.sttConsumedSpeechEndAt = speechEndAt;
  const firstPartialAt =
    timing?.firstPartialAt ??
    (session.sttFirstPartialAt !== undefined
      ? Math.max(
          0,
          session.sttFirstPartialAt - (session.sttTurnStartedAt ?? session.sttFirstPartialAt),
        )
      : undefined);
  logger.info(
    {
      callId: session.callControlId,
      ...describeTranscript(cleanTranscript),
      ...(languageCode ? { languageCode } : {}),
    },
    '[stt] End of turn',
  );
  session.onSttEvent?.({
    type: 'UtteranceEnd',
    transcript: cleanTranscript,
    transcriptProvider: timing?.transcriptProvider ?? session.sttProviderUsed ?? session.sttModel,
    ...(words ? { words } : {}),
    ...(languageCode ? { languageCode } : {}),
    ...(speechEndAt !== undefined ? { speechEndAt } : {}),
    sttFinalAt,
    turnDispatchedAt,
    finalTrigger: timing?.finalTrigger ?? 'speech_final',
    ...(timing?.providerResultEndMs !== undefined
      ? { providerResultEndMs: timing.providerResultEndMs }
      : {}),
    ...(timing?.providerLastWordEndMs !== undefined
      ? { providerLastWordEndMs: timing.providerLastWordEndMs }
      : {}),
    ...(timing?.receivedAtAudioMs !== undefined
      ? { receivedAtAudioMs: timing.receivedAtAudioMs }
      : {}),
    ...(timing?.audioClockDriftMs !== undefined
      ? { audioClockDriftMs: timing.audioClockDriftMs }
      : {}),
    ...(firstPartialAt !== undefined ? { firstPartialAt } : {}),
    afterBargeIn: timing?.afterBargeIn === true || session.sttAfterBargeIn === true,
  });
  session.sttLastNonEmptyPartialAt = undefined;
  session.sttLastSpeechStartedAt = undefined;
  resetSttTurnDiagnostics(session);
}

/** Pendant une collecte de nom, un segment retenu attend tant que l'appelant parle (silence réel exigé). */
const SPELLING_VOICE_QUIET_MS = 400;
/** Une partielle récente annonce le texte du segment suivant : on l'attend pour le recoller. */
const SPELLING_PARTIAL_RECENT_MS = 1_000;
/** Attente maximale d'un segment retenu, quoi qu'on entende (bruit pris pour de la voix, ligne ouverte). */
const SPELLING_MAX_HOLD_MS = 3_000;
const SPELLING_RECHECK_MS = 100;

/**
 * Appel 8e7b1db1 : « Houët, H-O-U-E-T » arrivait en deux segments (« …wet h » puis « o u e t »). La
 * reconnaissance met environ 1 s à produire le texte des lettres : la pause fixe de 600 ms expirait
 * pendant que l'appelant épelait encore, le premier segment partait seul (jugé douteux, donc jeté,
 * avec son « h ») et le suivant ne portait plus que « o u e t ». Ici l'audio entrant tranche : tant
 * que de la voix est reçue, ou qu'un texte suivant est annoncé, le segment retenu attend.
 */
function spellingContinuationExpected(
  session: CallSession,
  pending: NonNullable<CallSession['pendingSttEndOfTurn']>,
  now: number,
): boolean {
  const createdAt = pending.createdAt ?? now;
  if (now - createdAt >= SPELLING_MAX_HOLD_MS) return false;
  const silence = callerSilenceMs(session, now);
  const quietMs =
    Number.isFinite(silence) && (session.callerVoice?.trackedMs ?? 0) >= 500
      ? Math.max(SPELLING_VOICE_QUIET_MS, spellingSilenceBudgetMs(session))
      : SPELLING_VOICE_QUIET_MS;
  if (silence < quietMs) return true;
  const partialAt = session.sttLastNonEmptyPartialAt;
  return (
    partialAt !== undefined && partialAt > createdAt && now - partialAt < SPELLING_PARTIAL_RECENT_MS
  );
}

/**
 * Le profil d'épellation est actif : collecte du nom, ou ré-épellation. Une réponse qui n'est pas de
 * l'épellation (« c'est ça ») n'a aucune raison d'attendre encore des lettres (appel 8ae1e63e :
 * 600 ms d'attente sur la confirmation, le tour le plus lent).
 */
function isSpellingTurn(session: CallSession, transcript: string): boolean {
  const confirmingSpelling = session.structuredTurn?.lastAwaiting === 'customerNameConfirmation';
  return (
    (isNameCollectionBlocking(session) ||
      session.conversation.pendingQuestion === 'customerName') &&
    !(confirmingSpelling && !looksLikeSpelledLetters(transcript))
  );
}

/**
 * Un segment d'épellation est retenu et le nouveau texte est lui aussi fait de lettres : c'est la suite de la même
 * épellation, que le dialogue attende encore le nom ou non. Appel 3ba7c66f : le modèle avait répondu sans attendre
 * le nom (doute), `isSpellingTurn` était faux, et le « a » qui interrompait l'agent partait seul AVANT le segment
 * retenu (« a 2 s »), puis était écarté par lui. Structurel : aucune liste de mots.
 */
function continuesHeldSpelling(session: CallSession, transcript: string): boolean {
  const held = session.pendingSttEndOfTurn;
  return (
    Boolean(held) &&
    looksLikeSpelledLetters(held!.transcript) &&
    looksLikeSpelledLetters(transcript)
  );
}

/** Le texte se recolle à l'épellation en cours : profil d'épellation actif, ou suite de lettres d'un segment retenu. */
function spellingContinues(session: CallSession, transcript: string): boolean {
  return isSpellingTurn(session, transcript) || continuesHeldSpelling(session, transcript);
}

function spellingSilenceBudgetMs(session: CallSession): number {
  return Math.max(
    voiceConfig.VOICE_DEEPGRAM_SPELLING_SILENCE_MS,
    callerPauseFinalizeMs(session, voiceConfig.VOICE_DEEPGRAM_SPELLING_SILENCE_MS),
  );
}

/** Budget de silence déjà écoulé déduit, avec une grâce minimale pour les fragments STT tardifs. */
export function spellingEndOfTurnDelayMs(session: CallSession, now = Date.now()): number {
  if (session.sttAdapter?.id !== 'deepgram') return STT_SPELLING_EOT_GRACE_MS;
  const legacy = Math.max(
    0,
    voiceConfig.VOICE_DEEPGRAM_SPELLING_SILENCE_MS - voiceConfig.VOICE_DEEPGRAM_ENDPOINTING_MS,
  );
  const silence = callerSilenceMs(session, now);
  if (!Number.isFinite(silence) || (session.callerVoice?.trackedMs ?? 0) < 500) return legacy;
  return Math.max(Math.min(200, legacy), spellingSilenceBudgetMs(session) - silence);
}

function schedulePendingSttEndOfTurn(
  session: CallSession,
  delayMs = STT_SPELLING_EOT_GRACE_MS,
): void {
  if (session.sttEndOfTurnTimer) clearTimeout(session.sttEndOfTurnTimer);
  const release = (): void => {
    const pending = session.pendingSttEndOfTurn;
    if (pending && spellingContinuationExpected(session, pending, Date.now())) {
      session.sttEndOfTurnTimer = setTimeout(release, SPELLING_RECHECK_MS);
      return;
    }
    session.pendingSttEndOfTurn = null;
    session.sttEndOfTurnTimer = null;
    if (pending)
      dispatchUtteranceEnd(
        session,
        pending.transcript,
        pending.words,
        pending.languageCode,
        withFinalTrigger(pending.timing, 'spelling_hold'),
      );
  };
  session.sttEndOfTurnTimer = setTimeout(release, delayMs);
}

function flushPendingSttEndOfTurn(session: CallSession): void {
  const pending = session.pendingSttEndOfTurn;
  if (!pending) return;
  if (session.sttEndOfTurnTimer) {
    clearTimeout(session.sttEndOfTurnTimer);
    session.sttEndOfTurnTimer = null;
  }
  session.pendingSttEndOfTurn = null;
  dispatchUtteranceEnd(
    session,
    pending.transcript,
    pending.words,
    pending.languageCode,
    withFinalTrigger(pending.timing, 'spelling_hold'),
  );
}

function sendSessionAudioChunk(session: CallSession, telnyxAudio: Buffer): void {
  if (!session.sttWs) return;
  const adapter = sttAdapterForSession(session);
  const audio = adapter.toProviderAudio(session.codec, telnyxAudio);
  adapter.sendAudio(session.sttWs, audio);
  if (adapter.id === 'deepgram') {
    sendInkAudio(session, telnyxAudio);
  }
  session.sttConnectionAudioBytesSent = (session.sttConnectionAudioBytesSent ?? 0) + audio.length;
  addSttAudioSamples(session, adapter.samplesForAudio(session.codec, audio.length), adapter.id);
  session.sttFirstAudioChunkSent = true;
  const chunkMs = String(getSttChunkMs());
  voiceSttProviderAudioMessagesTotal.inc({ provider: adapter.id, chunk_ms: chunkMs });
  voiceSttProviderChunkBytes.observe({ provider: adapter.id }, audio.length);
}

function clearSttChunkTimer(session: CallSession): void {
  if (session.sttChunkTimer) {
    clearTimeout(session.sttChunkTimer);
    session.sttChunkTimer = null;
  }
}

/**
 * Envoie le tampon de regroupement s'il reste des octets. Idempotent : appelé
 * avant chaque étape qui ne doit pas laisser d'audio en attente (commit manuel,
 * fin de tour, barge-in, fermeture, reconnexion, fin d'appel).
 */
export function flushSttChunkBuffer(session: CallSession): void {
  clearSttChunkTimer(session);
  const buffered = session.sttChunkBuffer;
  session.sttChunkBuffer = null;
  if (buffered && buffered.length > 0) deliverSttAudio(session, buffered);
}

/** Envoie dès que la socket est ouverte, sinon met en file pour la reconnexion. */
function deliverSttAudio(session: CallSession, audio: Buffer): void {
  if (session.sttWs?.readyState === WebSocket.OPEN) {
    sendSessionAudioChunk(session, audio);
    return;
  }
  if (session.audioBuffer.length >= STT_AUDIO_BUFFER_MAX) session.audioBuffer.shift();
  session.audioBuffer.push(audio);
}

function appendSttChunk(session: CallSession, input: Buffer, chunkMs: number): void {
  const accumulated = session.sttChunkBuffer
    ? Buffer.concat([session.sttChunkBuffer, input])
    : input;
  const targetBytes = chunkMs * telnyxBytesPerMs(session.codec);
  if (accumulated.length >= targetBytes) {
    clearSttChunkTimer(session);
    session.sttChunkBuffer = null;
    deliverSttAudio(session, accumulated);
    return;
  }
  session.sttChunkBuffer = accumulated;
  if (!session.sttChunkTimer) {
    // Le flux peut s'interrompre avant que le tampon soit plein : on l'envoie
    // quand même après la durée cible + 20 ms.
    session.sttChunkTimer = setTimeout(() => {
      session.sttChunkTimer = null;
      flushSttChunkBuffer(session);
    }, chunkMs + STT_CHUNK_SAFETY_EXTRA_MS);
  }
}

/**
 * À l'ouverture de la socket : rejoue d'abord la file de reconnexion (trames
 * les plus anciennes), puis le tampon partiel courant, pour ne rien perdre ni
 * réordonner.
 */
export function resumeSttAfterOpen(session: CallSession): void {
  for (const chunk of session.audioBuffer) sendSessionAudioChunk(session, chunk);
  session.audioBuffer = [];
  flushSttChunkBuffer(session);
}

const SAFE_STT_PROVIDER_ERROR_TYPES = new Set([
  'auth_error',
  'quota_exceeded',
  'transcriber_error',
  'input_error',
  'invalid_request',
  'error',
  'commit_throttled',
  'unaccepted_terms',
  'rate_limited',
  'queue_overflow',
  'resource_exhausted',
  'session_time_limit_exceeded',
  'chunk_size_exceeded',
  'insufficient_audio_activity',
]);

function sttErrorMetricType(messageType: string | undefined): string {
  if (!messageType) return 'provider_error';
  if (/auth/iu.test(messageType)) return 'auth';
  if (/quota/iu.test(messageType)) return 'quota';
  if (/terms/iu.test(messageType)) return 'terms';
  if (/rate|throttl/iu.test(messageType)) return 'rate_limited';
  if (/queue|resource/iu.test(messageType)) return 'capacity';
  if (/session_time/iu.test(messageType)) return 'session_limit';
  if (/input|chunk/iu.test(messageType)) return 'input';
  if (/invalid/iu.test(messageType)) return 'invalid_request';
  return 'provider_error';
}

/** Un commit terminé par une ellipse est un fragment, pas un tour exploitable. */
export function isLikelyIncompleteTranscript(transcript: string): boolean {
  return /(?:\.\.\.|…)\s*$/u.test(transcript.trim());
}

/**
 * Les marqueurs de ponctuation isolés sont parfois émis par le VAD au début
 * d'un appel. Ils ne peuvent pas constituer une prise de parole exploitable.
 */
export function isPunctuationOnlyTranscript(transcript: string): boolean {
  const normalized = transcript.trim();
  return Boolean(normalized) && !/[\p{L}\p{N}]/u.test(normalized);
}

/**
 * Détecte les répétitions qui proviennent souvent d'un écho acoustique ou
 * d'un bruit téléphonique. Les mots d'interruption (« non », « stop », ...)
 * restent autorisés afin de préserver le barge-in volontaire.
 */
export function isLikelyRepeatedNoiseTranscript(transcript: string): boolean {
  const words = transcript
    .toLocaleLowerCase('fr-FR')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
  if (words.length < 3) return false;

  const interruptionWords = new Set(['non', 'no', 'stop', 'attends', 'attendez', 'wait']);
  const noiseWords = new Set(['ah', 'euh', 'heu', 'hum', 'hmm', 'oh', 'waouh', 'wow']);
  const counts = new Map<string, number>();
  for (const word of words) counts.set(word, (counts.get(word) ?? 0) + 1);
  const [topWord, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? [];
  return Boolean(
    topWord &&
    topCount >= 3 &&
    topCount / words.length >= 0.6 &&
    noiseWords.has(topWord) &&
    !interruptionWords.has(topWord),
  );
}

function lowSignalTranscriptReason(
  transcript: string,
): 'incomplete' | 'repetition' | 'punctuation' | null {
  if (isPunctuationOnlyTranscript(transcript)) return 'punctuation';
  if (isLikelyIncompleteTranscript(transcript)) return 'incomplete';
  if (isLikelyRepeatedNoiseTranscript(transcript)) return 'repetition';
  return null;
}

/** La reconnaissance livre ses mots après le son qui les a produits : marge avant le début d'énoncé. */
const VOICE_EVIDENCE_MARGIN_MS = 1_500;
/** Sans début d'énoncé connu (texte validé sans partielle), on cherche de la voix sur cette durée. */
const VOICE_EVIDENCE_LOOKBACK_MS = 4_000;
/**
 * La voix d'un tour déjà envoyé à l'agent ne prouve pas le texte suivant. Appel 6a70dff9 : « pour
 * quatre » traité, puis un « 4 » fantôme 1,3 s après la fin de la voix passait grâce à la marge
 * ci-dessus et coupait la réponse. Il faut de la voix arrivée au-delà de la fin des mots du tour
 * traité, à cette tolérance près (souffle, traîne de la dernière syllabe). Mesuré sur 12 appels
 * enregistrés : la voix d'un vrai tour suivant dépasse cette fin d'au moins 348 ms (médiane 6 s),
 * celle du « 4 » fantôme de −103 ms.
 */
const VOICE_CONSUMED_TOLERANCE_MS = 150;

/** Garde « pas de voix, pas de tour » : actif par défaut, `VOICE_REQUIRE_CALLER_VOICE=false` le coupe. */
export function callerVoiceGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.VOICE_REQUIRE_CALLER_VOICE?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
}

/**
 * Une transcription que l'audio entrant ne confirme pas (aucune voix depuis le début de l'énoncé) est un
 * fantôme de la reconnaissance : bruit, ou écho de l'agent. Elle n'interrompt rien et n'ouvre aucun tour.
 */
function isTranscriptWithoutCallerVoice(
  session: CallSession,
  stage: 'partial' | 'committed',
  now = Date.now(),
): boolean {
  if (!callerVoiceGateEnabled()) return false;
  const turnStartedAt = session.sttTurnStartedAt ?? session.sttLastSpeechStartedAt;
  const consumedUntil =
    session.sttConsumedSpeechEndAt !== undefined
      ? session.sttConsumedSpeechEndAt + VOICE_CONSUMED_TOLERANCE_MS
      : Number.NEGATIVE_INFINITY;
  const since = Math.max(
    consumedUntil,
    turnStartedAt !== undefined
      ? turnStartedAt - VOICE_EVIDENCE_MARGIN_MS
      : now - VOICE_EVIDENCE_LOOKBACK_MS,
  );
  if (!noCallerVoiceSince(session, since)) return false;
  voiceNoCallerVoiceTranscriptTotal.inc({ stage });
  logger.info(
    {
      callId: session.callControlId,
      stage,
      agentSpeaking: session.state === 'SPEAKING',
      callerSilenceMs: Math.round(Math.min(callerSilenceMs(session, now), 99_999)),
    },
    '[stt] Transcript ignored: no caller voice in the incoming audio',
  );
  return true;
}

/**
 * Un mot seul, peu sûr et bref ne coupe pas l'agent (appel f2200632 : « rouge » à 0,28 a coupé
 * l'accueil). Pendant l'accueil, l'exigence est plus forte.
 */
function lacksInterruptionEvidence(
  session: CallSession,
  transcript: string,
  words: readonly SttWord[] | undefined,
): boolean {
  const evidence = describeInterruptionEvidence(transcript, words);
  const greeting = session.greetingPlaying === true;
  if (hasInterruptionEvidence(evidence, { greeting })) return false;
  logger.info(
    {
      callId: session.callControlId,
      greeting,
      wordCount: evidence.wordCount,
      minWordConfidence: evidence.minConfidence,
      voiceMs: evidence.voiceMs,
    },
    '[barge-in] Refused: a single weak word is not enough to interrupt',
  );
  return true;
}

function handleBargeInFromTranscript(
  session: CallSession,
  mgr: CallSessionManager,
  transcript: string,
  words?: readonly SttWord[],
): void {
  if (session.state !== 'SPEAKING' || !transcript.trim()) return;
  if (lacksInterruptionEvidence(session, transcript, words)) return;
  const lowSignalReason = lowSignalTranscriptReason(transcript);
  if (lowSignalReason) {
    logger.debug(
      {
        callId: session.callControlId,
        reason: lowSignalReason,
        transcriptLength: transcript.trim().length,
      },
      '[barge-in] Ignoring low-signal transcript',
    );
    return;
  }
  const evidence = describeInterruptionEvidence(transcript, words);
  logger.info(
    {
      callId: session.callControlId,
      ...describeTranscript(transcript.trim()),
      greeting: session.greetingPlaying === true,
      wordCount: evidence.wordCount,
      minWordConfidence: evidence.minConfidence,
      voiceMs: evidence.voiceMs,
    },
    '[barge-in] User spoke while assistant was speaking. Interrupting.',
  );
  session.sttAfterBargeIn = true;
  // Un barge-in coupe le TTS : l'audio déjà capté doit partir maintenant,
  // sinon il resterait dans le tampon de regroupement.
  flushSttChunkBuffer(session);
  session.abortController?.abort();
  session.abortController = null;
  mgr.handleBargeIn(session);
}

function emitPartialTranscript(
  session: CallSession,
  transcript: string,
  words?: readonly SttWord[],
): void {
  let cleanTranscript = transcript.trim();
  let allowBargeIn = true;
  if (!cleanTranscript) return;
  if (isTranscriptWithoutCallerVoice(session, 'partial')) return;

  const echo = filterAssistantEcho(session, cleanTranscript, 'partial');
  if (echo.suppressed) return;
  cleanTranscript = echo.transcript;
  allowBargeIn = hasBargeInWordThreshold(echo);
  // Le texte du tour que l'agent est en train de traiter ou de dire : ni interruption, ni nouveau tour.
  if (isRepeatOfLastProcessedTurn(session, cleanTranscript)) return;
  if (handleCallerBackchannel(session, cleanTranscript, 'partial', words)) return;

  if (isVoiceDialogueIncompleteTranscript(cleanTranscript)) {
    if (allowBargeIn)
      handleBargeInFromTranscript(
        session,
        CallSessionManager.getInstance(),
        cleanTranscript,
        words,
      );
    const hold = session.sttSemanticHold;
    if (hold) {
      if (hold.timer) clearTimeout(hold.timer);
      hold.timer = null;
      hold.transcript = mergeIncompleteDialogueTranscript(hold.transcript, cleanTranscript);
      hold.holdMs = DIALOGUE_V2_INCOMPLETE_HOLD_MS;
      armSemanticHoldTimer(session, hold);
    }
    session.turnTranscript = mergeSttTranscripts(session.turnTranscript, cleanTranscript);
    return;
  }

  const lowSignalReason = lowSignalTranscriptReason(cleanTranscript);
  if (lowSignalReason) {
    // Conserver le texte pour que le commit stable suivant puisse le remplacer,
    // sans déclencher d'interruption ou de LLM spéculatif sur le fragment.
    if (lowSignalReason === 'incomplete') {
      session.turnTranscript = mergeSttTranscripts(session.turnTranscript, cleanTranscript);
    }
    return;
  }

  const mgr = CallSessionManager.getInstance();
  if (allowBargeIn) handleBargeInFromTranscript(session, mgr, cleanTranscript, words);

  const semanticHold = session.sttSemanticHold;
  if (semanticHold?.timer) {
    // Le client reprend sa phrase : le tour retenu reste ouvert jusqu'au
    // prochain commit, qui le fusionnera.
    clearTimeout(semanticHold.timer);
    semanticHold.timer = null;
  }

  if (!session.turnTranscript.trim() && !semanticHold) {
    // La suite d'une épellation se recolle au segment retenu ; tout autre début de parole le clôt.
    if (!(session.pendingSttEndOfTurn && spellingContinues(session, cleanTranscript)))
      flushPendingSttEndOfTurn(session);
    session.turnPartials = [];
    session.onSttEvent?.({ type: 'UtteranceStart' });
  } else if (session.state === 'PROCESSING' && cleanTranscript !== session.turnTranscript) {
    session.onSttEvent?.({ type: 'SpeechResumed' });
  }

  session.turnTranscript = mergeSttTranscripts(session.turnTranscript, cleanTranscript);
  // Partielles bornées : elles servent à voir si une valeur a changé en cours de tour.
  const partials = (session.turnPartials ??= []);
  if (partials.at(-1) !== cleanTranscript) partials.push(cleanTranscript);
  if (partials.length > MAX_TURN_PARTIALS) partials.splice(0, partials.length - MAX_TURN_PARTIALS);
}

function dispatchCommittedTranscript(
  session: CallSession,
  transcript: string,
  words?: SttWord[],
  languageCode?: string,
  timing?: SttTurnTiming,
): void {
  let cleanTranscript = transcript.trim() || session.turnTranscript.trim();
  let allowBargeIn = true;
  session.turnTranscript = '';
  if (!cleanTranscript) return;
  if (isTranscriptWithoutCallerVoice(session, 'committed')) {
    resetSttTurnDiagnostics(session);
    return;
  }

  const echo = filterAssistantEcho(session, cleanTranscript, 'committed');
  if (echo.suppressed) return;
  cleanTranscript = echo.transcript;
  allowBargeIn = hasBargeInWordThreshold(echo);
  if (!allowBargeIn && session.state === 'SPEAKING') return;
  if (isRepeatOfLastProcessedTurn(session, cleanTranscript)) {
    logger.info(
      {
        callId: session.callControlId,
        agentSpeaking: session.state === 'SPEAKING',
        ...describeTranscript(cleanTranscript),
      },
      '[stt] Ignoring a repeat of the turn just processed',
    );
    resetSttTurnDiagnostics(session);
    return;
  }

  if (handleCallerBackchannel(session, cleanTranscript, 'committed', words)) {
    if (timing?.speechEndAt !== undefined) session.sttConsumedSpeechEndAt = timing.speechEndAt;
    session.turnPartials = [];
    resetSttTurnDiagnostics(session);
    return;
  }

  if (isVoiceDialogueIncompleteTranscript(cleanTranscript)) {
    if (allowBargeIn)
      handleBargeInFromTranscript(
        session,
        CallSessionManager.getInstance(),
        cleanTranscript,
        words,
      );
    holdIncompleteDialogueTranscript(session, cleanTranscript, words, languageCode, timing);
    return;
  }

  const lowSignalReason = lowSignalTranscriptReason(cleanTranscript);
  if (lowSignalReason) {
    logger.info(
      {
        callId: session.callControlId,
        reason: lowSignalReason,
        transcriptLength: cleanTranscript.length,
      },
      '[stt] Ignoring low-signal committed transcript',
    );
    // Un tour retenu ne doit jamais rester bloqué derrière un commit ignoré.
    const hold = session.sttSemanticHold;
    if (hold && !hold.timer) armSemanticHoldTimer(session, hold);
    return;
  }

  // Un mot seul, peu sûr et bref est un bruit : pas de tour, l'agent continue d'écouter. Si ce bruit
  // a coupé l'accueil (coupure sur l'audio seul), l'accueil reprend où il s'était arrêté.
  if (
    isNoiseTurn(describeInterruptionEvidence(cleanTranscript, words), {
      letterExpected: expectsSpelledLetters(session.structuredTurn?.lastAwaiting),
      transcript: cleanTranscript,
    })
  ) {
    logger.info(
      {
        callId: session.callControlId,
        agentSpeaking: session.state === 'SPEAKING',
        ...describeTranscript(cleanTranscript),
      },
      '[stt] Ignoring a single weak word: noise, not a turn',
    );
    resetSttTurnDiagnostics(session);
    resumeInterruptedGreeting(session);
    return;
  }
  // Pendant la parole de l'agent, un mot seul sans preuve ne l'a pas coupé : il n'ouvre pas de tour non plus.
  if (
    session.state === 'SPEAKING' &&
    session.greetingPlaying &&
    lacksInterruptionEvidence(session, cleanTranscript, words)
  ) {
    resetSttTurnDiagnostics(session);
    return;
  }

  // Le partial est normalement le premier signal de barge-in, mais le fournisseur
  // peut engager un transcript sans partial observable sur une connexion
  // courte. Le commit doit donc rester suffisant pour interrompre le TTS.
  if (allowBargeIn)
    handleBargeInFromTranscript(session, CallSessionManager.getInstance(), cleanTranscript, words);
  session.greetingInterrupted = false;

  if (spellingContinues(session, cleanTranscript)) {
    const held = session.pendingSttEndOfTurn;
    // Un segment inachevé retenu avant l'épellation (« ce serait bien au nom de ») fait partie du même tour : sans
    // cela il restait dans le tampon et se recollait au tour suivant (appel 3ba7c66f : « … non non »).
    const previous = clearSemanticHold(session);
    const joinPrevious = (next: string): string =>
      previous
        ? isVoiceDialogueIncompleteTranscript(previous.transcript)
          ? mergeIncompleteDialogueTranscript(previous.transcript, next)
          : mergeSttTranscripts(previous.transcript, next)
        : next;
    const mergedWords = [...(previous?.words ?? []), ...(held?.words ?? []), ...(words ?? [])];
    const mergedLanguage = languageCode ?? held?.languageCode ?? previous?.languageCode;
    const mergedTiming = mergeSttTiming(mergeSttTiming(previous?.timing, held?.timing), timing);
    // Lettres recollées telles quelles : pas de dédoublonnage de recouvrement (« l » + « l e »).
    session.pendingSttEndOfTurn = {
      transcript: held
        ? `${joinPrevious(held.transcript)} ${cleanTranscript}`
        : joinPrevious(cleanTranscript),
      ...(mergedWords.length ? { words: mergedWords } : {}),
      ...(mergedLanguage ? { languageCode: mergedLanguage } : {}),
      ...(mergedTiming ? { timing: mergedTiming } : {}),
      createdAt: Date.now(),
    };
    const spellingDelay = spellingEndOfTurnDelayMs(session);
    schedulePendingSttEndOfTurn(session, spellingDelay);
    return;
  }
  if (session.sttAdapter?.id === 'deepgram') {
    const previous = clearSemanticHold(session);
    if (previous) {
      const mergedTranscript = isVoiceDialogueIncompleteTranscript(previous.transcript)
        ? mergeIncompleteDialogueTranscript(previous.transcript, cleanTranscript)
        : mergeSttTranscripts(previous.transcript, cleanTranscript);
      const mergedWords = previous.words && words ? [...previous.words, ...words] : words;
      dispatchUtteranceEnd(
        session,
        mergedTranscript,
        mergedWords,
        languageCode ?? previous.languageCode,
        mergeSttTiming(previous.timing, timing),
      );
      return;
    }
    dispatchUtteranceEnd(session, cleanTranscript, words, languageCode, timing);
    return;
  }
  dispatchOrHoldUtteranceEnd(session, cleanTranscript, words, languageCode, timing);
}

function dispatchDeepgramFinalParts(
  session: CallSession,
  finalTrigger: SttFinalTrigger = 'speech_final',
  utteranceEndOffsetMs?: number,
  utteranceLastWordEndMs?: number,
): void {
  const parts = session.sttDeepgramFinalParts ?? [];
  session.sttDeepgramFinalParts = [];
  session.sttDeepgramFinalizeRequested = false;
  releaseSilenceFlushHold(session);
  const transcript = parts.reduce(
    (merged, part) => mergeSttTranscripts(merged, part.transcript),
    '',
  );
  if (!transcript.trim()) return;
  const words = parts.flatMap((part) => part.words ?? []);
  const resultEndMs = parts.reduce(
    (latest, part) => Math.max(latest, part.providerResultEndMs ?? 0),
    0,
  );
  const lastWordEndMs = Math.max(
    utteranceLastWordEndMs ?? 0,
    ...parts.map((part) => part.providerLastWordEndMs ?? 0),
  );
  const speechEndOffsetMs =
    lastWordEndMs ||
    utteranceEndOffsetMs ||
    resultEndMs ||
    parts.reduce((latest, part) => Math.max(latest, part.speechEndOffsetMs ?? 0), 0);
  const languageCode = [...parts].reverse().find((part) => part.languageCode)?.languageCode ?? 'fr';
  const timing = sttTimingFromOffset(
    session,
    speechEndOffsetMs || undefined,
    finalTrigger,
    resultEndMs || undefined,
    lastWordEndMs || undefined,
  );
  const send = (finalTranscript: string, source: 'deepgram' | 'ink'): void => {
    session.sttFinalCount = (session.sttFinalCount ?? 0) + 1;
    // Ink-2 et Deepgram ne s'accordent pas sur le nombre de personnes : à faire confirmer dans le
    // récapitulatif de ce tour (remplace la confiance par mot de Deepgram, qui ne décrit plus ce texte).
    if (source === 'ink' && partySizeDiffers(finalTranscript, transcript)) {
      session.sttInkNote = {
        heard: finalTranscript,
        secondHeard: transcript,
        at: Date.now(),
        validThrough: session.sttFinalCount,
      };
    }
    dispatchCommittedTranscript(
      session,
      finalTranscript,
      source === 'deepgram' && words.length ? words : undefined,
      languageCode,
      {
        ...timing,
        transcriptProvider:
          source === 'ink' ? 'cartesia-ink-2' : (session.sttProviderUsed ?? session.sttModel),
      },
    );
  };
  if (!session.sttInk?.ready) {
    send(transcript, 'deepgram');
    return;
  }
  // Ink-2 en parallèle : attente plafonnée de son texte, phrases envoyées dans l'ordre. Le tampon de la
  // phrase est vidé maintenant, pas après l'attente : ce qui arrive entre-temps appartient à la suivante.
  session.turnTranscript = '';
  session.sttInkDispatchChain = (session.sttInkDispatchChain ?? Promise.resolve())
    .then(async () => {
      let resolved: Awaited<ReturnType<typeof resolveInkTranscript>> = {
        transcript,
        source: 'deepgram',
        waitedMs: 0,
      };
      try {
        resolved = await resolveInkTranscript(session, transcript);
      } catch {
        // Deepgram seul.
      }
      logger.info(
        {
          callId: session.callControlId,
          source: resolved.source,
          waitedMs: resolved.waitedMs,
          deepgram: describeTranscript(transcript),
          ink: resolved.inkTranscript ? describeTranscript(resolved.inkTranscript) : undefined,
        },
        '[stt-ink] final transcript',
      );
      logVoiceDebugText(session, 'stt_comparison', {
        deepgramTranscript: transcript,
        inkTranscript: resolved.inkTranscript,
        selectedSource: resolved.source,
      });
      const nextPhrase = session.turnTranscript;
      send(resolved.transcript, resolved.source);
      if (nextPhrase && !session.turnTranscript) session.turnTranscript = nextPhrase;
    })
    .catch((error: unknown) => {
      logger.error(
        {
          callId: session.callControlId,
          err: error instanceof Error ? error.message : String(error),
        },
        '[stt-ink] dispatch failed',
      );
    });
}

export function flushDeepgramFinalPartsForSafety(session: CallSession): void {
  if (session.sttDeepgramFinalParts?.length) {
    dispatchDeepgramFinalParts(session, 'safety_flush');
  }
}

/**
 * Journal des événements Deepgram qui décident de la fin d'un tour, sans
 * texte : ordre, offsets fournisseur et audio envoyé à la réception.
 */
function logDeepgramEvent(
  session: CallSession,
  kind: 'final_segment' | 'utterance_end',
  fields: Record<string, boolean | number | undefined>,
): void {
  const bytesPerMs = session.sttAdapter?.chunkBytesPerMs(session.codec);
  const partials = session.sttDeepgramPartials;
  const now = Date.now();
  logger.info(
    {
      callId: session.callControlId,
      kind,
      ...fields,
      // Partielles reçues depuis le dernier segment final : combien, combien
      // de changements, et depuis quand plus rien ne bouge.
      partialCount: partials?.count ?? 0,
      partialChanges: partials?.changes ?? 0,
      msSinceLastPartial: partials ? now - partials.lastAt : undefined,
      msSinceLastPartialChange: partials ? now - partials.lastChangeAt : undefined,
      lastPartialWordCount: partials?.lastWordCount,
      receivedAtAudioMs: bytesPerMs
        ? Math.round((session.sttConnectionAudioBytesSent ?? 0) / bytesPerMs)
        : undefined,
    },
    '[stt] Deepgram turn event',
  );
}

/** Sans changement de la partielle pendant ce délai, on force la fin du segment. */
export function deepgramStallFinalizeMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_DEEPGRAM_STALL_FINALIZE_MS ?? 1_200);
  return Number.isFinite(parsed) && parsed >= 300 && parsed <= 10_000 ? parsed : 1_200;
}

/** Au plus ce nombre de mots, une partielle est une réponse courte (« 4 », « oui », « demain »). */
export const DEEPGRAM_SHORT_PARTIAL_MAX_WORDS = 2;

/**
 * Délai de partielle figée pour une réponse courte. Appel c5d6b07d : « 4 » attendait
 * 2,7 s avant la fin de tour, dont 1,2 s de partielle figée. Une fin trop tôt reste
 * rattrapable : le tour structuré renvoie turnComplete=false et recolle le fragment.
 * Par défaut égal au délai normal (désactivé).
 */
export function deepgramShortStallFinalizeMs(env: NodeJS.ProcessEnv = process.env): number {
  const fallback = deepgramStallFinalizeMs(env);
  const parsed = Number(env.VOICE_DEEPGRAM_SHORT_STALL_FINALIZE_MS ?? fallback);
  return Number.isFinite(parsed) && parsed >= 300 && parsed <= fallback ? parsed : fallback;
}

/**
 * Épellation lettre par lettre : la plupart des mots sont des lettres isolées
 * (« h o u e t », « a 2 k i f »). Structurel, sans liste de mots : « c'est ça » n'en est pas.
 */
export function looksLikeSpelledLetters(transcript: string): boolean {
  const tokens = transcript
    .toLowerCase()
    .split(/[\s,.;:!?-]+/u)
    .filter(Boolean);
  if (tokens.length < 2) return tokens.length === 1 && /^\p{L}$/u.test(tokens[0]);
  const singles = tokens.filter((token) => /^[\p{L}\p{N}]$/u.test(token)).length;
  return singles / tokens.length >= 0.5;
}

/**
 * Silence réel exigé chez l'appelant avant une fin de tour forcée (partielle figée, jugement du
 * modèle). 0 désactive la garde. Appel 5cebe456 : 11 fins de tour forcées sur 17 tombaient pendant la
 * parole ; la règle « 350 ms sans voix sur l'audio entrant » en classait 15 sur 17 juste, sans en manquer.
 */
export function deepgramSilenceGuardMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_STT_SILENCE_GUARD_MS ?? 350);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 2_000 ? parsed : 350;
}

/**
 * Silence réel exigé avant une fin de tour forcée PENDANT UNE ÉPELLATION. Les pauses entre deux groupes de
 * lettres durent souvent plus d'une seconde (appel 8043662c : « …assam un » jugé fini à 428 ms de silence, le « a »
 * suivant perdu ; appel 3ba7c66f : « a 2 » finalisé par la partielle figée à 360 ms). 0 : la garde normale.
 */
export function deepgramSpellingSilenceGuardMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_STT_SPELLING_SILENCE_GUARD_MS ?? 1_200);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 3_000 ? parsed : 1_200;
}

/** Report maximal cumulé de la garde : au-delà, le comportement d'avant reprend (bruit, écho). */
export function deepgramSilenceGuardMaxDeferMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_STT_SILENCE_GUARD_MAX_DEFER_MS ?? 1_500);
  return Number.isFinite(parsed) && parsed >= 300 && parsed <= 5_000 ? parsed : 1_500;
}

/**
 * Relève au silence, pour tous les restaurants. Appel du 21/10
 * sur Chez Suppernote : « midi 30 » n'est arrivé en partielle que 2,1 s après le dernier mot, sans speech_final ;
 * la partielle figée n'a pu partir que 500 ms plus tard (2,6 s de silence). Nova-3 retient souvent un
 * énoncé court isolé ; un `Finalize` le rend en ~40 ms (sonde sur 94 tours courts enregistrés).
 */
/**
 * Fin de phrase sur silence local, pour tous les restaurants : une partielle Deepgram attend, et l'appelant se tait depuis plus longtemps que ses propres pauses
 * habituelles (`callerPauseFinalizeMs`, détection locale). Sans elle, une partielle figée attend 1,2 s après son dernier changement (12 % des tours en
 * prod du 14 au 21/10/2026, fin de parole → transcription p90 1,56 s). Jamais pendant une épellation, dont les
 * pauses sont plus longues (garde dédiée) ; une seule fois par partielle.
 */
/**
 * Silence local exigé tant que les pauses de l'appelant ne sont pas connues (moins de 3 observées) : 300 à
 * 1500 ms, 600 par défaut. Ensuite, le seuil suit ses propres pauses (`callerPauseFinalizeMs`).
 */
export function deepgramLocalSilenceFinalizeMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_DEEPGRAM_LOCAL_SILENCE_FINALIZE_MS ?? 600);
  return Number.isFinite(parsed) && parsed >= 300 && parsed <= 1_500 ? parsed : 600;
}

export function maybeFinalizeDeepgramOnLocalSilence(
  session: CallSession,
  now = Date.now(),
): boolean {
  const partial = session.sttDeepgramPartials?.lastText?.trim();
  if (
    session.ended ||
    session.state !== 'LISTENING' ||
    session.sttAdapter?.id !== 'deepgram' ||
    !session.sttDeepgramPendingInterim ||
    session.sttDeepgramFinalizeRequested ||
    !partial ||
    session.sttDeepgramLocalSilenceFinalizedText === partial
  ) {
    return false;
  }
  // Silence infini = aucune voix entendue sur la ligne (partielle née d'un écho) : rien à clore.
  const silentMs = callerSilenceMs(session, now);
  const thresholdMs = callerPauseFinalizeMs(session, deepgramLocalSilenceFinalizeMs());
  if (!Number.isFinite(silentMs) || silentMs < thresholdMs) return false;
  // Épellation attendue par le dialogue, ou lettres isolées sans qu'il l'attende : pauses longues, garde dédiée.
  if (isSpellingTurn(session, partial) || looksLikeSpelledLetters(partial)) return false;
  session.sttDeepgramLocalSilenceFinalizedText = partial;
  return requestDeepgramFinalize(session, { trigger: 'local_silence' });
}

/**
 * Silence réel de l'appelant avant la relève. 700 ms : sur les enregistrements, à 500 ms la relève
 * devance souvent un speech_final qui arrivait de lui-même ; à 700 ms elle ne sert plus qu'aux mots retenus.
 */
export function deepgramSilenceFlushMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_DEEPGRAM_SILENCE_FLUSH_MS ?? 700);
  return Number.isFinite(parsed) && parsed >= 300 && parsed <= 3_000 ? parsed : 700;
}

const silenceGuardTimers = new WeakMap<CallSession, ReturnType<typeof setTimeout>>();
const deepgramStallTimers = new WeakMap<CallSession, ReturnType<typeof setTimeout>>();
const speculationTimers = new WeakMap<CallSession, ReturnType<typeof setTimeout>>();

/** Stabilité de partielle avant de lancer la spéculation du tour structuré. */
export function structuredSpeculationDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_STRUCTURED_SPECULATION_MS ?? 250);
  return Number.isFinite(parsed) && parsed >= 50 && parsed <= 2_000 ? parsed : 250;
}

/**
 * Silence de l'appelant (audio entrant) avant de lancer la spéculation : à la pause, pas pendant la
 * parole ni après un délai fixe. La requête part dès que l'appelant s'arrête, pour que la réponse soit
 * prête pendant l'attente avant le premier son. 0 : ancien déclenchement (partielle stable 250 ms).
 */
export function structuredSpeculationPauseMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.VOICE_STRUCTURED_SPECULATION_PAUSE_MS ?? 150);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1_000 ? parsed : 150;
}

/** Garde-fou : une ligne bruitée sans vrai silence finit par lancer la spéculation quand même. */
const SPECULATION_MAX_PAUSE_WAITS = 25;

function armSpeculationTimer(session: CallSession, transcript: string): void {
  const previous = speculationTimers.get(session);
  if (previous) clearTimeout(previous);
  const pauseMs = structuredSpeculationPauseMs();
  const usePause = pauseMs > 0 && session.callerVoice !== undefined;
  let waits = 0;
  const schedule = (delayMs: number) => {
    const timer = setTimeout(fire, delayMs);
    timer.unref?.();
    speculationTimers.set(session, timer);
  };
  const fire = () => {
    speculationTimers.delete(session);
    if (!session.sttDeepgramPendingInterim) return;
    if (session.sttDeepgramPartials?.lastText !== transcript) return;
    if (usePause) {
      const silentMs = callerSilenceMs(session);
      if (silentMs < pauseMs && waits++ < SPECULATION_MAX_PAUSE_WAITS) {
        schedule(Math.max(40, pauseMs - silentMs + 10));
        return;
      }
    }
    const readyInk = peekReadyInkTranscript(session);
    if (readyInk) {
      speculateStructuredTurn(session, CallSessionManager.getInstance(), readyInk);
      return;
    }
    speculateStructuredTurn(session, CallSessionManager.getInstance(), transcript, (complete) =>
      finalizeOnSemanticEndOfTurn(session, transcript, complete),
    );
  };
  schedule(
    usePause ? Math.max(60, pauseMs - callerSilenceMs(session)) : structuredSpeculationDelayMs(),
  );
}
const deepgramFinalizeReasons = new WeakMap<
  CallSession,
  'utterance_end' | 'stalled' | 'silence_flush' | 'local_silence'
>();

/**
 * Relève au silence : l'appelant a parlé (voix claire sur l'audio entrant), se tait depuis
 * `deepgramSilenceFlushMs`, et Deepgram n'a rien rendu depuis. `Finalize` lui fait rendre ce qu'il retient.
 * Le texte rendu ne clôt pas le tour : il est traité comme une partielle (voir `holdSilenceFlushText`).
 */
export function maybeFlushDeepgramOnSilence(session: CallSession, now = Date.now()): boolean {
  const ws = session.sttWs;
  if (
    session.ended ||
    session.state !== 'LISTENING' ||
    session.sttAdapter?.id !== 'deepgram' ||
    session.sttDeepgramPendingInterim ||
    session.sttDeepgramFinalizeRequested ||
    ws?.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  const since = Math.max(
    session.sttDeepgramLastTextAt ?? 0,
    session.sttDeepgramSilenceFlushAt ?? 0,
  );
  if (!callerSpokeClearlySince(session, since + 1)) return false;
  const silentMs = callerSilenceMs(session, now);
  if (silentMs < deepgramSilenceFlushMs()) return false;
  session.sttDeepgramSilenceFlushAt = now;
  session.sttDeepgramFinalizeRequested = true;
  deepgramFinalizeReasons.set(session, 'silence_flush');
  logger.info(
    { callId: session.callControlId, callerSilenceMs: Math.round(Math.min(silentMs, 99_999)) },
    '[stt] Caller silent with no Deepgram text, Finalize sent',
  );
  session.sttAdapter.finalize(ws);
  return true;
}

/**
 * Réponse à la relève : le texte rendu reste dans les segments finaux et devient la partielle en cours.
 * Les règles habituelles décident de la fin du tour (partielle figée, garde de silence, épellation, verdict
 * du modèle) ; à leur échéance, `requestDeepgramFinalize` envoie le tour sans redemander `Finalize`.
 */
function holdSilenceFlushText(session: CallSession, wordCount: number): void {
  const parts = session.sttDeepgramFinalParts ?? [];
  const text = parts.reduce((merged, part) => mergeSttTranscripts(merged, part.transcript), '');
  logger.info(
    { callId: session.callControlId, wordCount, heldWordCount: text.split(/\s+/).length },
    '[stt] Silence flush returned text, held as partial',
  );
  const now = Date.now();
  session.sttDeepgramFlushHeld = true;
  session.sttDeepgramPendingInterim = true;
  session.sttDeepgramPartials = {
    count: 1,
    changes: 1,
    lastAt: now,
    lastChangeAt: now,
    lastText: text,
    lastWordCount: text.split(/\s+/).length,
  };
  armDeepgramStallTimer(session);
  armSpeculationTimer(session, text);
}

function releaseSilenceFlushHold(session: CallSession): void {
  if (!session.sttDeepgramFlushHeld) return;
  session.sttDeepgramFlushHeld = false;
  session.sttDeepgramPendingInterim = false;
  session.sttDeepgramPartials = undefined;
  clearDeepgramStallTimer(session);
}

function clearDeepgramStallTimer(session: CallSession): void {
  const held = silenceGuardTimers.get(session);
  if (held) clearTimeout(held);
  silenceGuardTimers.delete(session);
  const timer = deepgramStallTimers.get(session);
  if (timer) clearTimeout(timer);
  deepgramStallTimers.delete(session);
  const speculation = speculationTimers.get(session);
  if (speculation) clearTimeout(speculation);
  speculationTimers.delete(session);
}

/**
 * Appel 25650799 : Deepgram tenait « peut-être vers 18 heures 30 » en partielle
 * inchangée pendant 7,6 s, sans speech_final ni UtteranceEnd, sur une piste
 * appelant silencieuse → 8,8 s de silence. Une partielle figée déclenche
 * désormais `Finalize` ; la réponse clôt le tour comme après UtteranceEnd.
 */
function armDeepgramStallTimer(session: CallSession): void {
  clearDeepgramStallTimer(session);
  const words = session.sttDeepgramPartials?.lastWordCount ?? 0;
  const short = words > 0 && words <= DEEPGRAM_SHORT_PARTIAL_MAX_WORDS;
  const stallMs = short ? deepgramShortStallFinalizeMs() : deepgramStallFinalizeMs();
  const timer = setTimeout(() => {
    deepgramStallTimers.delete(session);
    requestDeepgramFinalize(session, { trigger: 'stall', stallMs, short });
  }, stallMs);
  timer.unref?.();
  deepgramStallTimers.set(session, timer);
}

/** Envoie `Finalize` si un segment Deepgram est en attente ; la réponse clôt le tour. */
function requestDeepgramFinalize(
  session: CallSession,
  fields: {
    trigger: 'stall' | 'semantic' | 'local_silence';
    stallMs?: number;
    short?: boolean;
    /** Phrase sur laquelle le modèle a jugé le tour fini : si la partielle a changé, ce verdict ne vaut plus. */
    expectedText?: string;
    /** Début du report de la garde de silence, pour en borner la durée cumulée. */
    heldSince?: number;
  },
): boolean {
  const ws = session.sttWs;
  if (
    session.ended ||
    session.sttAdapter?.id !== 'deepgram' ||
    !session.sttDeepgramPendingInterim ||
    session.sttDeepgramFinalizeRequested ||
    ws?.readyState !== WebSocket.OPEN
  ) {
    return false;
  }
  if (
    fields.expectedText !== undefined &&
    session.sttDeepgramPartials?.lastText !== fields.expectedText
  ) {
    return false;
  }
  // Garde de silence : une fin de tour forcée ne tombe pas pendant que l'appelant parle encore. Pendant une
  // épellation, la pause entre deux groupes de lettres peut dépasser une seconde : la garde est plus longue.
  const baseGuardMs = deepgramSilenceGuardMs();
  const spelling =
    baseGuardMs > 0 &&
    isSpellingTurn(session, fields.expectedText ?? session.sttDeepgramPartials?.lastText ?? '');
  const guardMs = spelling ? Math.max(baseGuardMs, deepgramSpellingSilenceGuardMs()) : baseGuardMs;
  const maxDeferMs = spelling
    ? Math.max(deepgramSilenceGuardMaxDeferMs(), guardMs + 600)
    : deepgramSilenceGuardMaxDeferMs();
  if (guardMs > 0) {
    const now = Date.now();
    const silentMs = callerSilenceMs(session, now);
    const heldSince = fields.heldSince ?? now;
    if (silentMs < guardMs) {
      if (now - heldSince < maxDeferMs) {
        voiceSilenceGuardTotal.inc({ outcome: 'held' });
        const previous = silenceGuardTimers.get(session);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(
          () => {
            silenceGuardTimers.delete(session);
            requestDeepgramFinalize(session, { ...fields, heldSince });
          },
          Math.max(30, guardMs - silentMs + 10),
        );
        timer.unref?.();
        silenceGuardTimers.set(session, timer);
        return false;
      }
      voiceSilenceGuardTotal.inc({ outcome: 'released_at_cap' });
    } else if (fields.heldSince !== undefined) {
      voiceSilenceGuardTotal.inc({ outcome: 'released_after_silence' });
    }
  }
  if (session.sttDeepgramFlushHeld) {
    // Texte déjà rendu par la relève : rien n'attend chez Deepgram, le tour part tel quel.
    logVoiceDebugText(session, 'flush_held_released', {
      trigger: fields.trigger,
      partial: session.sttDeepgramPartials?.lastText,
      callerSilenceMs: Math.round(Math.min(callerSilenceMs(session), 99_999)),
    });
    releaseSilenceFlushHold(session);
    dispatchDeepgramFinalParts(session, 'silence_flush');
    return true;
  }
  session.sttDeepgramFinalizeRequested = true;
  deepgramFinalizeReasons.set(
    session,
    fields.trigger === 'local_silence' ? 'local_silence' : 'stalled',
  );
  logVoiceDebugText(session, 'finalize_sent', {
    trigger: fields.trigger,
    partial: session.sttDeepgramPartials?.lastText,
    callerSilenceMs: Math.round(Math.min(callerSilenceMs(session), 99_999)),
  });
  logger.info(
    {
      callId: session.callControlId,
      ...fields,
      partialCount: session.sttDeepgramPartials?.count,
      msSinceLastPartialChange: session.sttDeepgramPartials
        ? Date.now() - session.sttDeepgramPartials.lastChangeAt
        : undefined,
    },
    fields.trigger === 'semantic'
      ? '[stt] Model judged the turn complete, Finalize sent'
      : fields.trigger === 'local_silence'
        ? '[stt] Caller silent after speech, Finalize sent'
        : '[stt] Deepgram partial stalled, Finalize sent',
  );
  session.sttAdapter.finalize(ws);
  return true;
}

/**
 * Fin de tour jugée par le modèle, sans liste de phrases : le premier passage
 * spéculatif dit si l'appelant a fini (`turnComplete`). Vrai, et la partielle n'a
 * pas bougé depuis : inutile d'attendre le minuteur de partielle figée. Faux : on
 * ne fait rien, le minuteur reste le filet de sécurité.
 */
export function finalizeOnSemanticEndOfTurn(
  session: CallSession,
  speculatedTranscript: string,
  turnComplete: boolean,
): boolean {
  if (!turnComplete) return false;
  if (session.state !== 'LISTENING') return false;
  if (session.sttDeepgramPartials?.lastText !== speculatedTranscript) return false;
  return requestDeepgramFinalize(session, {
    trigger: 'semantic',
    expectedText: speculatedTranscript,
  });
}

export function handleNormalizedSttMessage(
  session: CallSession,
  event: NormalizedSttProviderMessage,
): void {
  switch (event.type) {
    case 'session_started':
      return;
    case 'partial':
      if (event.transcript.trim()) {
        cancelNoInputRecovery(session);
        session.sttConsecutiveFailures = 0;
        const partialAt = Date.now();
        session.sttLastNonEmptyPartialAt = partialAt;
        session.sttTurnStartedAt ??= session.sttLastSpeechStartedAt ?? partialAt;
        session.sttFirstPartialAt ??= partialAt;
        if (session.sttAdapter?.id === 'deepgram') {
          session.sttDeepgramLastTextAt = partialAt;
          // L'appelant a repris après une relève : sa vraie partielle prend le relais, le `Finalize` qui la
          // clôt rendra aussi le texte gardé.
          session.sttDeepgramFlushHeld = false;
          session.sttDeepgramPendingInterim = true;
          const partials = (session.sttDeepgramPartials ??= {
            count: 0,
            changes: 0,
            lastAt: partialAt,
            lastChangeAt: partialAt,
            lastText: '',
            lastWordCount: 0,
          });
          partials.count++;
          partials.lastAt = partialAt;
          if (event.transcript !== partials.lastText) {
            partials.changes++;
            partials.lastChangeAt = partialAt;
            partials.lastText = event.transcript;
            partials.lastWordCount = event.transcript.trim().split(/\s+/).length;
            armDeepgramStallTimer(session);
            armSpeculationTimer(session, event.transcript);
          }
        }
      }
      emitPartialTranscript(session, event.transcript, event.words);
      return;
    case 'turn_commit':
      if (event.transcript.trim()) session.sttConsecutiveFailures = 0;
      dispatchCommittedTranscript(
        session,
        event.transcript,
        undefined,
        undefined,
        sttTimingFromOffset(session),
      );
      return;
    case 'final_segment': {
      logVoiceDebugText(session, 'final_segment', {
        text: event.transcript,
        speechFinal: event.speechFinal,
        fromFinalize: event.fromFinalize === true,
      });
      const parts = (session.sttDeepgramFinalParts ??= []);
      if (event.transcript.trim()) {
        parts.push({
          transcript: event.transcript,
          ...(event.words ? { words: event.words } : {}),
          ...(event.languageCode ? { languageCode: event.languageCode } : {}),
          ...(event.speechEndOffsetMs !== undefined
            ? { speechEndOffsetMs: event.speechEndOffsetMs }
            : {}),
          ...(event.providerResultEndMs !== undefined
            ? { providerResultEndMs: event.providerResultEndMs }
            : {}),
          ...(event.providerLastWordEndMs !== undefined
            ? { providerLastWordEndMs: event.providerLastWordEndMs }
            : {}),
        });
        session.sttConsecutiveFailures = 0;
      }
      if (event.transcript.trim()) cancelNoInputRecovery(session);
      else if (event.speechFinal && !parts.length && session.sttAdapter?.id === 'deepgram') {
        // Parole détectée mais aucun mot reconnu (« euh… trois » rendu vide) :
        // sans relance, l'appelant attend une réponse qui ne vient jamais.
        scheduleUnheardRecovery(session, CallSessionManager.getInstance());
      }
      if (session.sttAdapter?.id === 'deepgram') {
        session.sttDeepgramPendingInterim = false;
        logDeepgramEvent(session, 'final_segment', {
          speechFinal: event.speechFinal,
          fromFinalize: event.fromFinalize === true,
          empty: !event.transcript.trim(),
          providerResultEndMs: event.providerResultEndMs,
          providerLastWordEndMs: event.providerLastWordEndMs,
        });
        if (event.transcript.trim()) {
          session.sttDeepgramLastTextAt = Date.now();
          session.sttDeepgramPartials = undefined;
          clearDeepgramStallTimer(session);
        }
        if (
          event.fromFinalize &&
          session.sttDeepgramFinalizeRequested &&
          deepgramFinalizeReasons.get(session) === 'silence_flush'
        ) {
          // Réponse à la relève au silence, speech_final ou non : elle ne clôt pas le tour.
          session.sttDeepgramFinalizeRequested = false;
          deepgramFinalizeReasons.delete(session);
          if (event.transcript.trim()) {
            holdSilenceFlushText(session, event.transcript.trim().split(/\s+/).length);
          }
          return;
        }
      }
      if (event.speechFinal) dispatchDeepgramFinalParts(session, 'speech_final');
      else if (session.sttDeepgramFinalizeRequested) {
        // Réponse au `Finalize` (from_finalize) : elle clôt le tour, que
        // Deepgram la marque speech_final ou non.
        dispatchDeepgramFinalParts(
          session,
          deepgramFinalizeReasons.get(session) === 'stalled'
            ? 'stalled_finalize'
            : deepgramFinalizeReasons.get(session) === 'local_silence'
              ? 'silence_finalize'
              : 'utterance_end_finalize',
        );
      }
      return;
    }
    case 'utterance_end':
      if (session.sttAdapter?.id === 'deepgram') {
        const hasFinalParts = Boolean(session.sttDeepgramFinalParts?.length);
        logDeepgramEvent(session, 'utterance_end', {
          hasFinalParts,
          pendingInterim: session.sttDeepgramPendingInterim === true,
          providerLastWordEndMs: event.providerLastWordEndMs,
        });
        if (hasFinalParts) {
          dispatchDeepgramFinalParts(
            session,
            'utterance_end',
            event.speechEndOffsetMs,
            event.providerLastWordEndMs,
          );
        } else if (
          session.sttDeepgramPendingInterim &&
          !session.sttDeepgramFinalizeRequested &&
          session.sttWs?.readyState === WebSocket.OPEN
        ) {
          // Plus aucun mot depuis utterance_end_ms, mais Deepgram garde le
          // segment ouvert (bruit de ligne sans silence) : on force sa sortie
          // au lieu d'attendre l'endpointing, jusqu'à 4 s sur l'appel a8012c5c.
          session.sttDeepgramFinalizeRequested = true;
          deepgramFinalizeReasons.set(session, 'utterance_end');
          session.sttAdapter.finalize(session.sttWs);
        }
      }
      return;
    case 'speech_started':
      clearBackchannelCandidate(session);
      cancelNoInputRecovery(session);
      session.sttLastSpeechStartedAt =
        event.speechStartOffsetMs !== undefined &&
        session.sttConnectionAudioStartedAt !== undefined &&
        session.sttAdapter
          ? (mapSttAudioClock({
              connectionAudioStartedAt: session.sttConnectionAudioStartedAt,
              now: Date.now(),
              sentBytes: session.sttConnectionAudioBytesSent ?? 0,
              bytesPerMs: session.sttAdapter.chunkBytesPerMs(session.codec),
              providerOffsetMs: event.speechStartOffsetMs,
            }).speechEndAt ?? Date.now())
          : Date.now();
      session.sttTurnStartedAt ??= session.sttLastSpeechStartedAt;
      return;
    case 'provider_error': {
      const safeType = SAFE_STT_PROVIDER_ERROR_TYPES.has(event.messageType)
        ? event.messageType
        : sttErrorMetricType(event.messageType);
      const message = `${metricProvider(session)} provider error (${safeType})`;
      logger.error(
        {
          callId: session.callControlId,
          provider: metricProvider(session),
          type: sttErrorMetricType(event.messageType),
        },
        '[stt] Provider error',
      );
      voiceProviderErrorsTotal.inc({
        provider: metricProvider(session),
        type: sttErrorMetricType(event.messageType),
      });
      const terminalReason = terminalSttReason(event.messageType);
      if (terminalReason) triggerSttUnavailable(session, terminalReason, message);
      else session.onSttEvent?.({ type: 'Error', message });
      return;
    }
  }
}

/**
 * Traite un message brut du fournisseur de la session (Deepgram, ou Ink-2 en secours), comme le fait la
 * socket : normalisation par l'adaptateur, puis `handleNormalizedSttMessage`.
 */
export function handleSttMessage(session: CallSession, msg: Record<string, unknown>): void {
  const adapter = sttAdapterForSession(session);
  for (const event of adapter.normalizeMessage(Buffer.from(JSON.stringify(msg)))) {
    handleNormalizedSttMessage(session, event);
  }
}

export function connectStt(
  session: CallSession,
  onEvent?: (event: SttEvent) => void,
  createSocket: SttWebSocketFactory = (url, options) => new WebSocket(url, options),
): Promise<void> {
  if (onEvent) session.onSttEvent = onEvent;
  const adapter = sttAdapterForSession(session);
  // Ink-2 en parallèle (restaurants listés) : ouverte une fois par appel, sans effet sur Deepgram.
  if (adapter.id === 'deepgram') {
    openInkParallel(session, {
      onCompleteTranscript: (transcript) =>
        speculateStructuredTurn(session, CallSessionManager.getInstance(), transcript),
    }).catch(() => undefined);
  }
  if (session.sttReady) return session.sttReady;
  if (session.sttRetryTimer || session.sttTerminalFailure || session.sttFallbackTriggered) {
    return Promise.resolve();
  }

  if (process.env.NODE_ENV === 'test') {
    session.sttReady = Promise.resolve();
    return session.sttReady;
  }
  const apiKey =
    adapter.id === 'deepgram'
      ? (process.env.DEEPGRAM_API_KEY ?? '')
      : (process.env.CARTESIA_API_KEY ?? '');
  if (!apiKey) {
    triggerSttUnavailable(
      session,
      'configuration',
      adapter.id === 'deepgram'
        ? 'DEEPGRAM_API_KEY is not configured'
        : 'CARTESIA_API_KEY is not configured',
    );
    return Promise.resolve();
  }

  session.sttModel = adapter.model;
  ensureSttAvailabilityDeadline(session);
  let ws: WebSocket;
  try {
    const deepgramFeatures = resolveVoiceFeatureSnapshot(session);
    const url =
      adapter.id === 'cartesia'
        ? buildCartesiaTurnsUrl(session.codec, session.restaurantName)
        : buildDeepgramSttUrl(
            session.codec,
            session.deepgramKeyterms ?? [],
            adapter.model as 'nova-3' | 'flux-general-multi',
            {
              numerals: deepgramFeatures.deepgramNumeralsEnabled,
              punctuate: deepgramFeatures.deepgramPunctuateEnabled,
            },
          );
    const headers: Record<string, string> =
      adapter.id === 'deepgram'
        ? { Authorization: `Token ${apiKey}` }
        : { 'X-API-Key': apiKey, 'Cartesia-Version': '2026-03-01' };
    ws = adapter.open({ url, headers, createSocket });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    handleSttConnectionFailure(session, error, createSocket);
    return Promise.reject(error);
  }

  let opened = false;
  let failureHandled = false;
  const ready = new Promise<void>((resolve, reject) => {
    session.sttWs = ws;

    ws.on('open', () => {
      if (session.ended || session.sttWs !== ws) {
        ws.close(1000, 'call ended');
        resolve();
        return;
      }
      opened = true;
      session.sttProviderOpenedOnce = true;
      session.sttProviderUsed =
        adapter.id === 'deepgram' ? `deepgram-${adapter.model}` : 'cartesia-ink-2';
      if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
      session.sttConnectTimeout = null;
      if (session.sttConnectionDeadlineTimer) clearTimeout(session.sttConnectionDeadlineTimer);
      session.sttConnectionDeadlineTimer = null;
      // An open provider socket proves availability. Count only consecutive
      // failed opens/closures, while the per-call reconnection budget remains.
      session.sttConsecutiveFailures = 0;
      const pendingAudioBytes =
        session.audioBuffer.reduce((total, chunk) => total + chunk.length, 0) +
        (session.sttChunkBuffer?.length ?? 0);
      session.sttConnectionAudioStartedAt =
        Date.now() - pendingAudioBytes / telnyxBytesPerMs(session.codec);
      session.sttConnectionAudioBytesSent = 0;
      session.sttDeepgramFinalParts = [];
      session.sttDeepgramPendingInterim = false;
      session.sttDeepgramFinalizeRequested = false;
      session.sttDeepgramFlushHeld = false;
      session.sttDeepgramPartials = undefined;
      clearDeepgramStallTimer(session);
      if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
      session.sttKeepAliveTimer =
        adapter.id === 'deepgram' ? setInterval(() => adapter.keepAlive(ws), 5_000) : null;
      session.sttKeepAliveTimer?.unref?.();
      writeDebugLog(
        `[stt] ${adapter.id} connected for call ` +
          session.callControlId +
          '; sending ' +
          session.audioBuffer.length +
          ' buffered chunks',
      );
      logger.info(
        { callId: session.callControlId, provider: adapter.id },
        '[stt] Provider connected',
      );
      session.sttFirstAudioChunkSent = false;
      resumeSttAfterOpen(session);
      resolve();
    });

    ws.on('message', (raw: Buffer) => {
      if (adapter.id === 'deepgram' && (session.ended || session.sttWs !== ws)) return;
      try {
        for (const event of adapter.normalizeMessage(raw)) {
          handleNormalizedSttMessage(session, event);
        }
      } catch (err) {
        writeDebugLog('[stt] Provider message parse error', err);
        logger.error({ err, callId: session.callControlId }, '[stt] Message parse error');
      }
    });

    ws.on('error', (err: Error) => {
      if (failureHandled || session.sttWs !== ws) return;
      failureHandled = true;
      writeDebugLog(`[stt] ${adapter.id} WebSocket error for call ${session.callControlId}`, err);
      logger.error(
        { err, callId: session.callControlId, provider: adapter.id },
        '[stt] WebSocket error',
      );
      voiceProviderErrorsTotal.inc({ provider: adapter.metricLabel, type: 'ws_error' });
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { service: 'stt-bridge', provider: adapter.metricLabel, event: 'websocket-error' },
          extra: { callId: session.callControlId },
        });
      }
      if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
      session.sttConnectTimeout = null;
      if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
      session.sttKeepAliveTimer = null;
      if (session.sttWs === ws) session.sttWs = null;
      if (session.sttReady === ready) session.sttReady = null;
      if (!opened) reject(err);
      handleSttConnectionFailure(session, err, createSocket);
    });

    ws.on('unexpected-response', (_request, response) => {
      if (failureHandled || session.sttWs !== ws) return;
      failureHandled = true;
      response.resume();
      if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
      session.sttConnectTimeout = null;
      if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
      session.sttKeepAliveTimer = null;
      if (session.sttWs === ws) session.sttWs = null;
      if (session.sttReady === ready) session.sttReady = null;
      const statusCode = response.statusCode ?? 0;
      const error = new Error(`${adapter.id} WebSocket handshake failed with HTTP ${statusCode}`);
      if (statusCode === 401 || statusCode === 403) {
        voiceProviderErrorsTotal.inc({ provider: adapter.metricLabel, type: 'auth' });
        if (!opened) reject(error);
        triggerSttUnavailable(session, 'auth', error.message);
        ws.terminate();
      } else {
        voiceProviderErrorsTotal.inc({ provider: adapter.metricLabel, type: 'ws_error' });
        if (!opened) reject(error);
        handleSttConnectionFailure(session, error, createSocket);
      }
    });

    ws.on('close', (code: number) => {
      logger.info(
        { callId: session.callControlId, code, provider: adapter.id },
        '[stt] Provider connection closed',
      );
      if (failureHandled || session.sttWs !== ws) return;
      failureHandled = true;
      if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
      session.sttConnectTimeout = null;
      if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
      session.sttKeepAliveTimer = null;
      session.sttWs = null;
      if (session.sttReady === ready) session.sttReady = null;
      const error = new Error(`${adapter.id} WebSocket closed before the call ended`);
      if (!opened) reject(error);
      handleSttConnectionFailure(session, error, createSocket);
    });

    session.sttConnectTimeout = setTimeout(() => {
      if (failureHandled || opened || session.sttWs !== ws) return;
      failureHandled = true;
      session.sttConnectTimeout = null;
      if (session.sttKeepAliveTimer) clearInterval(session.sttKeepAliveTimer);
      session.sttKeepAliveTimer = null;
      session.sttWs = null;
      if (session.sttReady === ready) session.sttReady = null;
      const error = new Error(`${adapter.id} WebSocket connection timed out`);
      reject(error);
      handleSttConnectionFailure(session, error, createSocket);
      ws.terminate();
    }, STT_CONNECT_TIMEOUT_MS);
  });

  session.sttReady = ready;
  return ready;
}

export function sendAudioToStt(session: CallSession, audioPayload: string): void {
  if (session.sttTerminalFailure || session.sttFallbackTriggered) return;
  const input = Buffer.from(audioPayload, 'base64');
  checkFastBargeIn(session, trackCallerVoice(session, input), CallSessionManager.getInstance());
  maybeFlushDeepgramOnSilence(session);
  maybeFinalizeDeepgramOnLocalSilence(session);

  if (
    !session.sttWs &&
    !session.sttReady &&
    !session.sttRetryTimer &&
    !session.sttTerminalFailure &&
    !session.sttFallbackTriggered
  ) {
    connectStt(session).catch((_err) => {
      logger.error(
        { callId: session.callControlId, provider: metricProvider(session) },
        '[stt] Provider connection failed while sending audio',
      );
    });
  }

  const chunkMs = getSttChunkMs();
  if (chunkMs <= STT_CHUNK_MS_DEFAULT) {
    // Défaut : une trame = un message, chemin strictement inchangé.
    deliverSttAudio(session, input);
    return;
  }
  appendSttChunk(session, input, chunkMs);
}

export function closeStt(session: CallSession): void {
  // Fin d'appel : envoyer ce qui reste avant de couper la socket.
  flushSttChunkBuffer(session);
  closeInkParallel(session).catch(() => undefined);
  clearPendingSttEndOfTurn(session);
  clearSemanticHold(session);
  clearSttRecoveryTimers(session);
  clearDeepgramStallTimer(session);
  const ws = session.sttWs;
  session.sttWs = null;
  session.sttReady = null;
  const adapter = sttAdapterForSession(session);
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) adapter.finalize(ws);
      adapter.close(ws, 1000, 'call ended');
    } catch (_err) {
      logger.warn(
        { callId: session.callControlId, provider: adapter.id },
        '[stt] Failed to close provider socket',
      );
    }
  }
}

/** Attentes ajoutées après la fin de phrase (écoute Dialogue V2), selon la forme de la phrase. */
export const SMART_ENDPOINT_HOLD_COMPLETE_MS = 0;
export const SMART_ENDPOINT_HOLD_SUSPENDED_MS = 800;
export const SMART_ENDPOINT_HOLD_CORRECTION_MS = 600;
export const SMART_ENDPOINT_HOLD_NO_PUNCTUATION_MS = 400;

export type SmartEndpointReason = 'complete' | 'suspended' | 'correction' | 'no_punctuation';

/** Minuscules sans accents : « À » et « a » se comparent de la même façon. */
function normalizeForEndpoint(transcript: string): string {
  return transcript
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .toLowerCase()
    .trim();
}

// Fin en suspens : préposition, article, conjonction ou présentation
// laissée sans suite (« demain à », « au nom de », « je suis »).
const SUSPENDED_ENDING =
  /(?:^|[\s,])(?:pour|a|vers|de|du|des|d'|le|la|les|l'|au|aux|chez|avec|et|ou|mais|donc|alors|puis|du coup|au nom de|je suis|c'est|mon nom est|on sera|nous serons|il y aura|je voudrais|j'aimerais)\s*,?$/;
const CORRECTION_START = /^(?:non\s*[,.]?\s+\S|plutot\b|en fait\b|j'ai dit\b|je voulais dire\b)/;
const TERMINAL_PUNCTUATION = /[.!?]$/;
// Réponse courte, complète même sans ponctuation (« oui », « d'accord »).
const SHORT_ANSWER = /^(?:\S+)(?:\s+\S+)?$/;

/**
 * Délai d'attente supplémentaire avant d'envoyer un tour, une fois le
 * silence du fournisseur écoulé. 0 ms signifie que la phrase part tout de suite.
 */
export function getSmartEndpointDelay(transcript: string): {
  holdMs: number;
  reason: SmartEndpointReason;
} {
  const text = normalizeForEndpoint(transcript);
  if (SUSPENDED_ENDING.test(text)) {
    return { holdMs: SMART_ENDPOINT_HOLD_SUSPENDED_MS, reason: 'suspended' };
  }
  if (CORRECTION_START.test(text) && !TERMINAL_PUNCTUATION.test(text)) {
    return { holdMs: SMART_ENDPOINT_HOLD_CORRECTION_MS, reason: 'correction' };
  }
  if (TERMINAL_PUNCTUATION.test(text) || SHORT_ANSWER.test(text)) {
    return { holdMs: SMART_ENDPOINT_HOLD_COMPLETE_MS, reason: 'complete' };
  }
  return { holdMs: SMART_ENDPOINT_HOLD_NO_PUNCTUATION_MS, reason: 'no_punctuation' };
}
