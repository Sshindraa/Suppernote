import { WebSocket } from 'ws';
import { recordVoicePeak } from '../call-capacity';
import { createHash, randomBytes } from 'node:crypto';
import type { CallSession, CallState, ChatMessage, LlmRequestKind } from './types';
import { voiceConfig } from '../../../env';
import { validateToolArgs } from '../tool-schemas';
import {
  ReservationService,
  type AvailabilityResult,
} from '../../reservations/reservation.service';
import {
  CARD_GUARANTEE_NO_PHONE_FACT,
  VOICE_CARD_GUARANTEE_HOLD_MS,
  cardGuaranteeCreatedFact,
  voiceCardGuaranteeTerms,
} from '../card-guarantee-facts';
import { enqueueCardGuaranteeSms } from '../../reservation-payments/reservation-guarantee.sms';
import { db } from '../../../shared/db/client';
import { logger } from '../../../shared/logger/pino';
import * as Sentry from '@sentry/node';
import { telnyxFetch } from '../../../shared/telnyx/http-agent';
import { zonedTimeToUtc } from '../../floor-plan/availability-capacity-aware.service';
import { createConversationState } from './conversation-controller';
import {
  getActivePendingInteraction,
  getReservationConfirmationKey,
  isNameCollectionBlocking,
  voiceMaxPartySize,
} from './conversation-state';
import { authorizeVoiceTool, type VoiceToolAuthorizationBasis } from './voice-action-policy';
import { recordVoiceTurnEvent } from './turn-telemetry';
import { splitHeardReply } from './interrupted-reply';
import { clearFastBargeIn } from './fast-barge-in';
import { recordDebugTool } from './debug-dialogue';
import {
  getVoiceLlmEndpoint,
  getVoiceLlmModel,
  getVoiceLlmProvider,
  isOpenRouterParallelFor,
  isOpenRouterPrimaryFor,
  type VoiceLlmProvider,
} from '../llm-provider';
import {
  addLlmUsage,
  addLlmKindUsage,
  estimateMessagesTokens,
  estimateTokenCount,
} from '../../usage/voice-usage.service';
import {
  voiceLlmFallbackTotal,
  voiceLlmHedgeTotal,
  voiceProviderErrorsTotal,
  voiceActiveSessionsGauge,
  voiceCallsTotal,
  voiceTransfersTotal,
  type VoiceTransferMotive,
  type VoiceTransferOutcome,
} from '../../../shared/observability/metrics';
import {
  alertLlmCircuitOpened,
  alertLlmFallbackUnavailable,
  alertLlmPrimaryUnavailable,
  recordLlmBothProvidersFailed,
  recordLlmHedgeFired,
  type LlmTurnFailureCause,
} from './llm-alerts';
import { armSilenceRecovery, cancelNoInputRecovery } from './no-input-recovery';

function recordVoiceTransfer(
  session: CallSession,
  authorizationBasis: VoiceToolAuthorizationBasis | undefined,
  outcome: VoiceTransferOutcome,
): void {
  const motive: VoiceTransferMotive =
    authorizationBasis?.kind === 'human_fallback_choice'
      ? 'dialogue_stall'
      : authorizationBasis?.kind === 'name_spelling_escalation'
        ? 'name_spelling'
        : authorizationBasis?.kind === 'group_size'
          ? 'group_size'
          : 'caller_request';
  voiceTransfersTotal.inc({
    motive,
    intent: session.conversation.intent ?? 'none',
    outcome,
    restaurant_id: session.restaurantId || 'unknown',
  });
}

// ─── LLM error classification for voice_provider_errors_total ──────────
// Fournisseur LLM unique : Cerebras. Le label de la métrique porte son nom.

type LlmProvider = VoiceLlmProvider;
/** Le fournisseur qui a réellement répondu : le principal, ou OpenRouter en repli. */
type LlmProviderUsed = LlmProvider | 'openrouter';
type StreamChunkRead = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>;

type FallbackReason =
  | 'quota'
  | 'rate_limited'
  | 'server_error'
  | 'client_error'
  | 'circuit_open'
  | 'first_chunk_timeout'
  | 'hedge'
  | 'timeout'
  | 'network';

interface StructuredStreamRequest {
  responseFormat: StructuredResponseFormat;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

/** Les alertes ne doivent jamais ralentir ni casser un tour : lancées sans attente. */
function notify(alert: Promise<unknown>): void {
  alert.catch(() => undefined);
}

/** Flux LLM ouvert, premier fragment déjà lu. */
/** Au-delà, la chronologie du flux structuré est journalisée (médiane habituelle : environ 400 ms). */
const SLOW_STRUCTURED_STREAM_MS = 1500;

/** Un fragment SSE porte du texte : `"content":"` suivi d'au moins un caractère. */
const SSE_CONTENT_RE = /"content"\s*:\s*"(?!")/;

/** Lit le flux jusqu'au premier fragment de texte et rend tous les octets lus jusque-là en une lecture. */
async function readUntilContent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<StreamChunkRead> {
  const parts: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let seen = '';
  for (;;) {
    const read = await reader.read();
    if (read.done) {
      return parts.length ? { done: false, value: Buffer.concat(parts) } : read;
    }
    parts.push(read.value);
    seen += decoder.decode(read.value, { stream: true });
    if (SSE_CONTENT_RE.test(seen)) {
      return { done: false, value: parts.length === 1 ? read.value : Buffer.concat(parts) };
    }
  }
}

interface OpenedStream {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  provider: LlmProviderUsed;
  firstRead: StreamChunkRead;
}

/** Premier résultat non nul ; null quand toutes les promesses ont échoué ou renvoyé null. */
function firstNonNull<T>(
  promises: Array<Promise<T | null>>,
): Promise<{ index: number; value: T } | null> {
  return new Promise((resolve) => {
    let pending = promises.length;
    const settleEmpty = () => {
      pending -= 1;
      if (pending === 0) resolve(null);
    };
    promises.forEach((promise, index) => {
      promise.then((value) => (value ? resolve({ index, value }) : settleEmpty()), settleEmpty);
    });
  });
}

/** Hébergeurs OpenRouter du repli : ordre configuré, avec repli sur les autres si tous échouent. */
function providerList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
}

/**
 * Hébergeurs OpenRouter du repli. Les appels contiennent des données personnelles (noms, numéros) :
 * par défaut, seuls les hébergeurs qui ne conservent rien et n'entraînent rien sur les requêtes
 * sont admis (`zdr`, `data_collection: deny`) ; VOICE_STRUCTURED_FALLBACK_ZERO_RETENTION=false lève
 * cette exigence. Ceux de la liste d'exclusion sont écartés même en secours.
 */
function fallbackProviderPreferences(): Record<string, unknown> {
  const order = providerList(voiceConfig.VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER);
  const ignore = providerList(voiceConfig.VOICE_STRUCTURED_FALLBACK_PROVIDER_IGNORE);
  const zeroRetention = voiceConfig.VOICE_STRUCTURED_FALLBACK_ZERO_RETENTION !== 'false';
  return {
    require_parameters: true,
    ...(zeroRetention ? { zdr: true, data_collection: 'deny' } : {}),
    ...(order.length ? { order, allow_fallbacks: true } : { sort: 'latency' }),
    ...(ignore.length ? { ignore } : {}),
  };
}

/** Pourquoi le fournisseur principal n'a pas pu prendre le tour (catégories pour la métrique). */
function classifyFallbackReason(input: { status?: number; error?: unknown }): FallbackReason {
  if (input.status === 402) return 'quota';
  if (input.status === 429) return 'rate_limited';
  if (input.status !== undefined) return input.status >= 500 ? 'server_error' : 'client_error';
  const name = input.error instanceof Error ? input.error.name : '';
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network';
}

function classifyLlmHttpStatus(status: number): string {
  if (status === 429) return '429';
  if (status >= 400 && status < 500) return '4xx';
  return '5xx';
}

function recordLlmHttpError(provider: LlmProvider, status: number): void {
  voiceProviderErrorsTotal.inc({ provider, type: classifyLlmHttpStatus(status) });
}

function recordLlmException(
  provider: LlmProvider,
  err: unknown,
  sessionSignal?: AbortSignal,
): void {
  const isAbort = err instanceof Error && err.name === 'AbortError';
  const isSessionAbort = isAbort && sessionSignal?.aborted;
  voiceProviderErrorsTotal.inc({
    provider,
    type: isSessionAbort ? 'session_abort' : 'timeout',
  });
}

/**
 * Détecte une annulation de session (barge-in, raccroché) — pas un timeout.
 * Dans ce cas, on ne doit PAS enregistrer une failure provider ni lancer de
 * nouvelle requête : la session est terminée, le signal est déjà aborted et
 * toute requête ultérieure échouerait immédiatement.
 */
/** Délai dépassé (premier texte ou délai total) : le principal était lent, pas en erreur. */
function turnFailureCause(error: unknown): LlmTurnFailureCause {
  if (
    error instanceof Error &&
    (error.name === 'TimeoutError' || /timed out/i.test(error.message))
  ) {
    return 'primary_slow';
  }
  return 'primary_failed';
}

function isSessionAbortError(err: unknown, sessionSignal?: AbortSignal): boolean {
  return err instanceof Error && err.name === 'AbortError' && !!sessionSignal?.aborted;
}

/** `response_format` OpenAI-compatible en JSON Schema strict. */
export interface StructuredResponseFormat {
  type: 'json_schema';
  json_schema: { name: string; strict: true; schema: unknown };
}

interface VoiceToolExecutionControl {
  terminalReply: string | null;
}

function buildVoiceToolPolicyDenialReply(
  reason: Exclude<ReturnType<typeof authorizeVoiceTool>, { status: 'allowed' }>['reason'],
): string {
  switch (reason) {
    case 'confirmation_required':
      return 'Je n’ai pas créé la réservation. Je dois d’abord vous relire les détails et recueillir votre accord explicite.';
    case 'name_confirmation_required':
      return "Je dois d'abord confirmer l'orthographe de votre nom. Pouvez-vous me redonner les lettres, s'il vous plaît ?";
    case 'explicit_transfer_required':
      return "Je n'ai pas lancé le transfert. Si vous souhaitez parler au gérant, dites-le-moi clairement.";
    case 'manager_unconfigured':
      return "Je n'ai pas de ligne directe configurée pour le gérant. Je peux prendre un message à lui transmettre.";
    case 'explicit_message_required':
      return "Je n'ai enregistré aucun message. Voulez-vous en laisser un pour le gérant ?";
    case 'intent_required':
    case 'unknown_tool':
      return 'Je ne peux pas effectuer cette action sans votre demande explicite. Pouvez-vous préciser ce que vous souhaitez ?';
  }
}

function managerRecoveryOffer(
  session: CallSession,
  situation: string,
  executionControl?: VoiceToolExecutionControl,
): string {
  const offer = session.managerPhone?.trim()
    ? 'Souhaitez-vous que je vous passe le gérant ?'
    : 'Souhaitez-vous laisser un message au gérant ?';
  const reply = `${situation} ${offer}`;
  if (executionControl) executionControl.terminalReply = reply;
  return reply;
}

/**
 * Ce que le compte rendu de création dit du SMS de confirmation : le réglage du restaurant (`smsConfirmEnabled`),
 * jamais une affirmation d'envoi. Réglage inconnu (contexte en cache d'avant ce champ) : le compte rendu n'en dit rien.
 */
export function confirmationSmsStatement(enabled: boolean | undefined): string {
  if (enabled === true) {
    return ' Le SMS de confirmation est activé pour ce restaurant : il va être envoyé au client.';
  }
  if (enabled === false) {
    return " Le SMS de confirmation est désactivé pour ce restaurant : aucun SMS n'est envoyé au client.";
  }
  return '';
}

function terminalToolReply(
  executionControl: VoiceToolExecutionControl | undefined,
  reply: string,
): string {
  if (executionControl) executionControl.terminalReply = reply;
  return reply;
}

/**
 * Regroupe tous les messages `system` en un seul, placé en tête.
 *
 * Le prompt, la consigne de langue et le contexte éphémère sont des messages
 * `system` distincts. Le template de chat Qwen de Cerebras refuse tout message `system` qui n'est pas le premier (400
 * `System message must be at the beginning`). L'ordre des consignes est
 * conservé ; les autres messages ne sont pas modifiés.
 */
export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
  const systemContents = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content.trim())
    .filter(Boolean);
  const rest = messages.filter((message) => message.role !== 'system');
  if (systemContents.length === 0) return rest;
  return [{ role: 'system', content: systemContents.join('\n\n') }, ...rest];
}

/**
 * Circuit breaker simple pour les providers LLM voice.
 * Après N échecs consécutifs, le provider est marqué "open" (skip) pendant
 * un cooldown. Au prochain appel après le cooldown, on tente une requête
 * "half-open" : si elle réussit, le breaker se ferme ; si elle échoue,
 * le cooldown redémarre.
 *
 * État in-memory (non persistant) — se réinitialise au redémarrage du process.
 * Suffisant pour un outage temporaire ; ne remplace pas un monitoring externe.
 */
interface CircuitBreakerState {
  failures: number;
  openedAt: number | null; // timestamp ms, null = closed
}

const CIRCUIT_BREAKER_THRESHOLD = 3; // 3 échecs consécutifs → open
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000; // 30s de cooldown

const circuitBreakers: Record<LlmProvider, CircuitBreakerState> = {
  cerebras: { failures: 0, openedAt: null },
};

function isCircuitBreakerOpen(provider: LlmProvider): boolean {
  const state = circuitBreakers[provider];
  if (state.openedAt === null) return false;
  const elapsed = Date.now() - state.openedAt;
  if (elapsed >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    // Half-open : on laisse passer une requête pour tester le provider
    logger.info({ provider }, `[circuit-breaker] ${provider} entering half-open state`);
    return false;
  }
  return true;
}

function recordProviderSuccess(provider: LlmProvider): void {
  const wasOpen = circuitBreakers[provider].openedAt !== null;
  circuitBreakers[provider] = { failures: 0, openedAt: null };
  if (wasOpen) {
    logger.info({ provider }, `[circuit-breaker] ${provider} closed (recovered)`);
  }
}

function recordProviderFailure(provider: LlmProvider): void {
  const state = circuitBreakers[provider];
  state.failures++;
  if (state.failures >= CIRCUIT_BREAKER_THRESHOLD) {
    const wasOpen = state.openedAt !== null;
    state.openedAt = Date.now();
    if (!wasOpen) {
      logger.warn(
        { provider, failures: state.failures },
        `[circuit-breaker] ${provider} opened after ${state.failures} consecutive failures`,
      );
      notify(alertLlmCircuitOpened());
    } else {
      logger.warn(
        { provider, failures: state.failures },
        `[circuit-breaker] ${provider} half-open request failed, cooldown restarted`,
      );
    }
  }
}

function resetCircuitBreaker(provider: LlmProvider): void {
  circuitBreakers[provider] = { failures: 0, openedAt: null };
}

// Exporté pour les tests
export function _resetCircuitBreakersForTesting(): void {
  resetCircuitBreaker('cerebras');
}

/** Résout `'timeout'` si la promesse n'aboutit pas avant `timeoutMs`. */
async function raceTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Timeout par requête LLM (ms). Si le provider ne répond pas dans ce délai,
 * on abort et la dégradation vocale prend le relais. La valeur est validée
 * dans env.ts.
 */
/**
 * Combine le signal de session avec un timeout par requête.
 * Retourne un signal qui abort si l'un des deux se déclenche.
 */
function withRequestTimeout(sessionSignal?: AbortSignal): AbortSignal {
  // AbortSignal.any est disponible en Node 20+
  const timeoutSignal = AbortSignal.timeout(voiceConfig.VOICE_LLM_TIMEOUT_MS);
  if (!sessionSignal) return timeoutSignal;
  return AbortSignal.any([sessionSignal, timeoutSignal]);
}

export class CallSessionManager {
  // shortcut: sessions are lost on restart; use shared recovery before enabling multiple API processes.
  private readonly sessions = new Map<string, CallSession>();

  private static instance: CallSessionManager;
  static getInstance(): CallSessionManager {
    if (!this.instance) this.instance = new CallSessionManager();
    return this.instance;
  }

  create(opts: {
    callControlId: string;
    callSessionId: string;
    from: string;
    to: string;
    restaurantId: string;
    restaurantName: string;
    deepgramKeyterms?: string[];
    managerPhone?: string | null;
    onlineReservationsActive?: boolean;
    /** `Restaurant.smsConfirmEnabled` : le SMS de confirmation de réservation est actif pour ce restaurant. */
    smsConfirmEnabled?: boolean;
    timezone?: string;
    openingHours?: CallSession['openingHours'];
    /** Taille de groupe réservable automatiquement (incluse) ; absent : 7. */
    maxPartySize?: number;
    /** Montant minimum carte cadeau — défaut 10€ */
    giftCardMinimumAmount?: number;
    systemPrompt: string;
    isVip: boolean;
    telnyxWs: WebSocket;
    callLegId: string;
    codec: 'PCMA' | 'PCMU' | 'L16';
    /** Appel de démonstration depuis le navigateur : aucun effet de bord réel (voir `CallSession.demo`). */
    demo?: boolean;
    /** Style de la maison pour l'accueil composé (voir styled-greeting.ts). */
    greetingStyle?: { profileType?: string; fillerStyle?: string };
    personality?: {
      fillerStyle: 'CASUAL' | 'FORMAL' | 'WARM';
      systemPromptExtra?: string | null;
      speakingRate?: number | null;
      voiceIdCa?: string | null;
      pronunciationDictId?: string | null;
      volume?: number | null;
      emotion?: string | null;
    } | null;
  }): CallSession {
    const restaurantName = opts.restaurantName;
    const giftCardMinimumAmount = opts.giftCardMinimumAmount ?? 10;

    const greeting = `Bonjour, ${restaurantName} !`;

    const session: CallSession = {
      callControlId: opts.callControlId,
      ...(opts.demo ? {} : { streamToken: randomBytes(32).toString('base64url') }),
      callSessionId: opts.callSessionId,
      callLegId: opts.callLegId,
      from: opts.from,
      to: opts.to,
      restaurantId: opts.restaurantId,
      openingHours: opts.openingHours ?? null,
      ...(opts.maxPartySize !== undefined ? { maxPartySize: opts.maxPartySize } : {}),
      restaurantName,
      ...(opts.deepgramKeyterms ? { deepgramKeyterms: opts.deepgramKeyterms } : {}),
      managerPhone: opts.managerPhone ?? null,
      onlineReservationsActive: opts.onlineReservationsActive ?? false,
      ...(opts.smsConfirmEnabled === undefined
        ? {}
        : { smsConfirmEnabled: opts.smsConfirmEnabled }),
      timezone: opts.timezone ?? 'Europe/Paris',
      giftCardMinimumAmount,
      systemPrompt: opts.systemPrompt,
      state: 'IDLE',
      ended: false,
      turnCount: 0,
      isVip: opts.isVip,
      telnyxWs: opts.telnyxWs,
      codec: opts.codec,
      ...(opts.demo ? { demo: true } : {}),
      history: [
        { role: 'system', content: opts.systemPrompt },
        { role: 'assistant', content: greeting },
      ],
      sttWs: null,
      sttReady: null,
      sttConsecutiveFailures: 0,
      sttReconnectAttempts: 0,
      sttRetryTimer: null,
      sttConnectTimeout: null,
      sttConnectionDeadlineTimer: null,
      sttTerminalFailure: false,
      sttFallbackTriggered: false,
      sttFallbackSpoken: false,
      onSttEvent: null,
      sttLanguageCode: undefined,
      voiceLanguageCode: 'fr',
      voiceLanguageCandidate: null,
      sttFirstAudioChunkSent: false,
      audioBuffer: [],
      isSpeaking: false,
      ttsPlayback: Promise.resolve(),
      ttsGeneration: 0,
      responseGeneration: 0,
      ttsContext: null,
      currentTurn: null,
      voiceTurnHistory: [],
      voiceCallTelemetry: {},
      bargeInChunks: 0,
      abortController: null,
      transcript: '',
      turnTranscript: '',
      speechFinalTimer: null,
      lastActivityAt: Date.now(),
      createdAt: Date.now(),
      personality: opts.personality ?? null,
      ...(opts.greetingStyle ? { greetingStyle: opts.greetingStyle } : {}),
      conversation: createConversationState(),
    };
    this.sessions.set(sessionIdKey(opts.callControlId), session);
    if (!opts.demo) {
      session.streamStartTimer = setTimeout(() => {
        if (this.get(opts.callControlId) === session && !session.telnyxWs)
          this.delete(opts.callControlId);
      }, 10 * 60_000);
      session.streamStartTimer.unref?.();
    }
    // Capacité locale (R1-3) : la jauge suit le nombre de sessions tenues par
    // ce process, pour alerter avant la saturation CPU mesurée à ~100 sessions.
    voiceActiveSessionsGauge.set(this.sessions.size);
    recordVoicePeak(this.sessions.size);
    voiceCallsTotal.inc({ restaurant_id: session.restaurantId || 'unknown' });
    return session;
  }

  get(ccId: string): CallSession | undefined {
    return this.sessions.get(sessionIdKey(ccId));
  }

  delete(ccId: string): void {
    const session = this.sessions.get(sessionIdKey(ccId));
    if (session) {
      this.cleanup(session);
      this.sessions.delete(sessionIdKey(ccId));
      voiceActiveSessionsGauge.set(this.sessions.size);
    }
  }

  cleanup(session: CallSession): void {
    if (session.streamStartTimer) clearTimeout(session.streamStartTimer);
    session.streamStartTimer = null;
    session.ended = true;
    if (session.ending?.timer) clearTimeout(session.ending.timer);
    session.ending?.complete?.();
    session.state = 'IDLE';
    session.isSpeaking = false;
    session.ttsGeneration++;
    session.ttsContext?.cancel();
    session.ttsContext = null;
    if (session.speechFinalTimer) {
      clearTimeout(session.speechFinalTimer);
      session.speechFinalTimer = null;
    }
    if (session.sttEndOfTurnTimer) {
      clearTimeout(session.sttEndOfTurnTimer);
      session.sttEndOfTurnTimer = null;
    }
    if (session.sttRetryTimer) clearTimeout(session.sttRetryTimer);
    if (session.sttConnectTimeout) clearTimeout(session.sttConnectTimeout);
    if (session.sttConnectionDeadlineTimer) clearTimeout(session.sttConnectionDeadlineTimer);
    session.sttRetryTimer = null;
    session.sttConnectTimeout = null;
    session.sttConnectionDeadlineTimer = null;
    session.pendingSttEndOfTurn = null;
    if (session.sttSemanticHold?.timer) clearTimeout(session.sttSemanticHold.timer);
    session.sttSemanticHold = null;
    if (session.interruptedTurn?.timer) clearTimeout(session.interruptedTurn.timer);
    session.interruptedTurn = null;
    if (session.abortController) {
      session.abortController.abort();
      session.abortController = null;
    }
    for (const socket of [session.sttWs]) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      } else if (socket?.readyState === WebSocket.CONNECTING) {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
      }
    }
    session.sttWs = null;
    session.sttReady = null;
    session.audioBuffer = [];
    if (session.sttChunkTimer) {
      clearTimeout(session.sttChunkTimer);
      session.sttChunkTimer = null;
    }
    session.sttChunkBuffer = null;
  }

  // ─── State Machine ──────────────────────────────────────────────

  transition(session: CallSession, newState: CallState): boolean {
    if ((session.ended || session.ending) && newState !== 'IDLE' && newState !== 'CLOSING')
      return false;

    const valid: Record<CallState, CallState[]> = {
      IDLE: ['LISTENING', 'SPEAKING', 'CLOSING'],
      LISTENING: ['PROCESSING', 'IDLE', 'CLOSING'],
      PROCESSING: ['SPEAKING', 'LISTENING', 'IDLE', 'CLOSING'],
      SPEAKING: ['LISTENING', 'IDLE', 'CLOSING'],
      CLOSING: ['IDLE'],
    };

    if (!valid[session.state].includes(newState)) return false;

    const previousState = session.state;
    session.state = newState;
    session.lastActivityAt = Date.now();
    // Fin d'une réplique de l'agent : relance si l'appelant ne dit rien ; tout
    // autre changement d'état (l'appelant parle, clôture…) annule la relance.
    if (newState === 'LISTENING' && previousState === 'SPEAKING') armSilenceRecovery(session, this);
    else if (newState !== 'LISTENING') cancelNoInputRecovery(session);
    return true;
  }

  // ─── Barge-in ───────────────────────────────────────────────────

  handleBargeIn(session: CallSession): void {
    if (session.state !== 'SPEAKING') return;
    clearFastBargeIn(session);
    session.responseGeneration++;
    session.ttsGeneration++;
    if (session.greetingPlaying) session.greetingInterrupted = true;
    // Avant `cancel` : le contexte vide ses trames en attente. Sans contexte (voix HTTP), on ne sait pas.
    const snapshot = session.ttsContext?.interruptionSnapshot?.();
    session.interruptedReply = snapshot?.text.trim()
      ? splitHeardReply(snapshot.text, snapshot.playedMs, snapshot.totalMs, snapshot.alignment)
      : undefined;
    session.ttsContext?.cancel();
    session.ttsContext = null;
    this.sendTelnyxClear(session);
    this.transition(session, 'LISTENING');
    session.isSpeaking = false;
    recordVoiceTurnEvent(session, 'barge_in');
    recordVoiceTurnEvent(session, 'tts_interrupted', {
      reason: 'barge_in',
      ttsPath: 'http_stream',
    });
    logger.info({ callId: session.callControlId }, '[barge-in] Call interrupted');
  }

  private sendTelnyxClear(session: CallSession): void {
    if (session.telnyxWs.readyState !== WebSocket.OPEN) return;
    session.telnyxWs.send(JSON.stringify({ event: 'clear' }));
  }

  // ─── LLM Processing ─────────────────────────────────────────────

  async getAvailability(
    session: CallSession,
    date: string,
    partySize: number,
  ): Promise<AvailabilityResult> {
    return ReservationService.availability(session.restaurantId, date, partySize);
  }

  /** Plages d'accueil des tables du restaurant : distingue « complet ce jour » de « aucune table pour ce nombre ». */
  async getTableRanges(
    session: CallSession,
  ): Promise<Array<{ capacity: number; minCapacity: number }>> {
    return ReservationService.tableRanges(session.restaurantId);
  }

  /**
   * Finalise une réservation après la confirmation explicite du nom. Le
   * résultat de disponibilité doit correspondre exactement aux créneaux
   * courants ; cela permet de réserver sans repasser par un LLM qui pourrait
   * perdre le « oui » ou réécrire le nom épelé.
   */
  async createReservationFromConversation(session: CallSession): Promise<string | null> {
    const { slots, nameCollection, lastAvailabilityResult } = session.conversation;
    const customerName = nameCollection?.confirmedName ?? slots.customerName;
    if (!slots.date || !slots.time || !slots.partySize || !customerName) return null;

    const key = `${slots.date}:${slots.time}:${slots.partySize}`;
    if (lastAvailabilityResult?.key !== key || !lastAvailabilityResult.slots.includes(slots.time)) {
      return null;
    }

    const confirmationKey = getReservationConfirmationKey(session);
    if (!confirmationKey || session.conversation.confirmedReservationKey !== confirmationKey) {
      return null;
    }
    // Consommer l'accord avant l'appel réseau : un double événement STT ou un
    // retry ne doit jamais déclencher deux créations pour le même « oui ».
    session.conversation.confirmedReservationKey = null;

    return this.executeTool(
      session,
      'createReservation',
      JSON.stringify({
        date: slots.date,
        time: slots.time,
        partySize: slots.partySize,
        customerName,
        customerPhone: session.from,
      }),
      confirmationKey,
    );
  }

  /**
   * Exécute réellement le transfert vers le gérant. Une phrase qui annonce un
   * transfert ne doit jamais remplacer l'action côté Telnyx : c'est ce chemin
   * qui la déclenche après une proposition de repli humain acceptée.
   */
  async handoffToManager(
    session: CallSession,
    authorizationBasis?: VoiceToolAuthorizationBasis,
  ): Promise<string> {
    return this.executeTool(
      session,
      'handoffToManager',
      JSON.stringify({}),
      undefined,
      authorizationBasis,
    );
  }

  /**
   * Résout l'ID primaire du Call à partir du call_leg_id Telnyx.
   *
   * `call_leg_id` est le `callSid` métier du provider, pas la clé étrangère
   * Prisma utilisée par Reservation et Message. Ne jamais le transmettre
   * directement à ces tables : PostgreSQL rejetterait l'écriture (ou, pire,
   * l'idempotence de réservation ne fonctionnerait pas).
   */
  private async resolveCallRecordId(session: CallSession): Promise<string | null> {
    try {
      const call = await db.call.findUnique({
        where: { callSid: session.callLegId },
        select: { id: true, restaurantId: true },
      });

      if (!call) {
        logger.error(
          { callId: session.callControlId, callLegId: session.callLegId },
          '[tool] Call record missing for voice session',
        );
        return null;
      }

      // Defense-in-depth : un call_leg_id ne doit jamais pouvoir être réutilisé
      // pour rattacher une réservation ou un message au mauvais restaurant.
      if (call.restaurantId !== session.restaurantId) {
        logger.error(
          {
            callId: session.callControlId,
            callLegId: session.callLegId,
            callRestaurantId: call.restaurantId,
            sessionRestaurantId: session.restaurantId,
          },
          '[tool] Call record belongs to another restaurant',
        );
        return null;
      }

      return call.id;
    } catch (err) {
      logger.error(
        { err, callId: session.callControlId, callLegId: session.callLegId },
        '[tool] Failed to resolve internal Call record',
      );
      return null;
    }
  }

  /**
   * Message laissé pour le gérant, rédigé par le modèle du tour structuré. Le
   * choix du message vient de ce tour ; l'exécution passe par le même tool.
   */
  async recordCallerMessage(session: CallSession, message: string): Promise<string> {
    const customerName =
      session.structuredTurn?.draft.customerName.trim() ||
      session.conversation.slots.customerName ||
      'Client';
    return this.executeTool(
      session,
      'takeMessage',
      JSON.stringify({ customerName, message, callbackPhone: session.from }),
      undefined,
      { kind: 'human_fallback_choice', choice: 'message' },
    );
  }

  /**
   * Génération streaming à sortie JSON Schema stricte, sans outil. Chaque
   * fragment de contenu est transmis dès réception ; le texte complet est
   * renvoyé à la fin.
   */
  async streamStructuredCompletion(
    session: CallSession,
    messages: ChatMessage[],
    responseFormat: StructuredResponseFormat,
    options: {
      signal?: AbortSignal;
      telemetryTurnId?: string;
      maxTokens?: number;
      /** Sorte de requête, pour mesurer où partent les jetons (aucun effet sur la réponse). */
      kind?: LlmRequestKind;
      onDelta: (delta: string) => void;
    },
  ): Promise<string> {
    const kind = options.kind ?? 'other';
    let streamedText = '';
    try {
      const result = await this.runStructuredCompletion(session, messages, responseFormat, {
        ...options,
        onDelta: (delta) => {
          streamedText += delta;
          options.onDelta(delta);
        },
      });
      addLlmKindUsage(
        session,
        kind,
        result.inputTokens,
        result.outputTokens,
        false,
        result.cachedInputTokens,
      );
      return result.text;
    } catch (error) {
      // Interrompue (anticipation jetée, appelant qui reprend) ou en échec : le fournisseur a déjà reçu l'entrée.
      addLlmKindUsage(
        session,
        kind,
        estimateMessagesTokens(messages),
        estimateTokenCount(streamedText),
        true,
      );
      // Un tour entendu par l'appelant est resté sans réponse : compté une fois, ici. Le juge et
      // l'anticipation échouent sans que l'appelant l'entende ; un abandon (barge-in) n'est pas un échec.
      if (!options.signal?.aborted && kind !== 'judge' && kind !== 'speculation') {
        const cause = turnFailureCause(error);
        logger.warn(
          { callId: session.callControlId, kind, cause },
          '[llm-alerts] Turn without model answer counted',
        );
        notify(recordLlmBothProvidersFailed(cause));
      }
      throw error;
    }
  }

  private async runStructuredCompletion(
    session: CallSession,
    messages: ChatMessage[],
    responseFormat: StructuredResponseFormat,
    options: {
      signal?: AbortSignal;
      telemetryTurnId?: string;
      maxTokens?: number;
      onDelta: (delta: string) => void;
    },
  ): Promise<{
    text: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
  }> {
    const request = {
      responseFormat,
      maxTokens: options.maxTokens ?? 400,
      temperature: 0.3,
      signal: options.signal,
    };
    const startedAt = Date.now();
    const openRouterKey = voiceConfig.OPENROUTER_API_KEY?.trim();
    const opened =
      openRouterKey && isOpenRouterPrimaryFor(session.restaurantId)
        ? await this.openStructuredOpenRouterFirst(
            session,
            messages,
            request,
            voiceConfig.VOICE_LLM_OPENROUTER_PRIMARY_HEDGE_MS,
            openRouterKey,
          )
        : await this.openStructuredSequential(session, messages, request);
    const { provider, firstRead } = opened;
    const reader = opened.reader;
    const decoder = new TextDecoder();
    let nextRead: StreamChunkRead | null = firstRead;
    let pending = '';
    let text = '';
    let inputTokens: number | undefined;
    let cachedInputTokens = 0;
    let outputTokens: number | undefined;
    // Chronologie du flux, journalisée seulement s'il est lent : premier texte et plus longue pause.
    const openedMs = Date.now() - startedAt;
    let lastChunkAt = Date.now();
    let maxGapMs = 0;
    let firstTextMs: number | null = null;
    try {
      for (;;) {
        const { done, value } = nextRead ?? (await reader.read());
        nextRead = null;
        const now = Date.now();
        maxGapMs = Math.max(maxGapMs, now - lastChunkAt);
        lastChunkAt = now;
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice('data:'.length).trim();
          if (!payload || payload === '[DONE]') continue;
          try {
            const chunk = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                prompt_tokens_details?: { cached_tokens?: number } | null;
              } | null;
            };
            if (chunk.usage) {
              inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
              cachedInputTokens =
                chunk.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
              outputTokens = chunk.usage.completion_tokens ?? outputTokens;
            }
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) {
              firstTextMs ??= Date.now() - startedAt;
              text += delta;
              options.onDelta(delta);
            }
          } catch {
            // Ligne SSE incomplète ou non JSON : ignorée.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    const totalMs = Date.now() - startedAt;
    if (totalMs >= SLOW_STRUCTURED_STREAM_MS) {
      logger.warn(
        {
          callId: session.callControlId,
          provider,
          totalMs,
          openedMs,
          firstTextMs,
          maxGapMs,
          outputTokens,
        },
        '[llm-stream] slow structured stream',
      );
    }
    addLlmUsage(
      session,
      provider,
      options.telemetryTurnId ?? `turn-${session.turnCount}`,
      inputTokens ?? estimateMessagesTokens(messages),
      outputTokens ?? estimateTokenCount(text),
      inputTokens === undefined,
    );
    return {
      text,
      inputTokens: inputTokens ?? estimateMessagesTokens(messages),
      cachedInputTokens,
      outputTokens: outputTokens ?? estimateTokenCount(text),
    };
  }

  /**
   * Ouvre le flux du tour structuré, sans doublon : le principal d'abord, puis OpenRouter s'il
   * échoue ou si son premier fragment dépasse le délai maximal.
   */
  private async openStructuredSequential(
    session: CallSession,
    messages: ChatMessage[],
    request: StructuredStreamRequest,
  ): Promise<OpenedStream> {
    const primaryProvider = getVoiceLlmProvider();
    const { response, provider: firstProvider } = await this.fetchLlmStreaming(
      session,
      messages,
      request,
    );
    let provider: LlmProviderUsed = firstProvider;
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Structured LLM request failed (${response.status})`);
    }
    let reader = response.body.getReader();
    // Premier fragment trop lent : le modèle principal est abandonné pour ce tour (et compte comme
    // un échec pour le disjoncteur), OpenRouter reprend avant que l'appelant n'attende 8 s.
    // Le secours est demandé au délai maximal ; le principal n'est lâché que s'il répond.
    let fallback: Response | null = null;
    let firstRead = await this.readFirstChunk(
      reader,
      provider === primaryProvider ? voiceConfig.VOICE_LLM_FIRST_CHUNK_TIMEOUT_MS : undefined,
      async () => {
        fallback = await this.fetchFallbackStreaming(
          session,
          messages,
          request,
          'first_chunk_timeout',
          new Error('LLM first chunk timeout'),
        );
        return Boolean(fallback?.body);
      },
    );
    if (firstRead === 'timeout') {
      recordProviderFailure(primaryProvider);
      reader.cancel().catch(() => undefined);
      const rescue = fallback as Response | null;
      if (!rescue?.body) throw new Error('Structured LLM first chunk timed out, no fallback');
      provider = 'openrouter';
      reader = rescue.body.getReader();
      firstRead = await reader.read();
    }
    return { reader, provider, firstRead };
  }

  /**
   * Tous les restaurants dès que la clé OpenRouter est présente : le tour part d'abord chez
   * OpenRouter (modèle et réglages du relais) ; Cerebras devient le doublon si aucun texte n'est
   * arrivé après `hedgeMs` (0 = pas de doublon), et le repli immédiat si OpenRouter refuse. Le premier
   * flux qui produit du texte est gardé ; les deux sont bornés par le délai total.
   */
  private async openStructuredOpenRouterFirst(
    session: CallSession,
    messages: ChatMessage[],
    request: StructuredStreamRequest,
    hedgeMs: number,
    apiKey: string,
  ): Promise<OpenedStream> {
    const cerebras = getVoiceLlmProvider();
    const controllerA = new AbortController();
    const controllerA2 = new AbortController();
    const controllerB = new AbortController();
    const signalOf = (controller: AbortController): AbortSignal =>
      request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal;
    const startedAt = Date.now();
    const remainingMs = () =>
      Math.max(0, voiceConfig.VOICE_LLM_TIMEOUT_MS - (Date.now() - startedAt));
    let primaryError: unknown = null;

    // A : OpenRouter, jusqu'au délai total ; deux requêtes identiques pour les restaurants listés.
    const attemptOpenRouter = async (controller: AbortController): Promise<OpenedStream | null> => {
      const response = await this.fetchOpenRouterStreaming(
        messages,
        { ...request, signal: signalOf(controller) },
        apiKey,
      );
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        if ([401, 402, 403].includes(response.status)) {
          notify(alertLlmFallbackUnavailable(response.status));
        }
        throw new Error(`Structured LLM request failed (OpenRouter ${response.status})`);
      }
      const reader = response.body.getReader();
      const firstRead = await raceTimeout(readUntilContent(reader), remainingMs());
      if (firstRead === 'timeout') {
        reader.cancel().catch(() => undefined);
        return null;
      }
      return { reader, provider: 'openrouter' as const, firstRead };
    };
    const parallel = isOpenRouterParallelFor(session.restaurantId);
    const primary = (async (): Promise<OpenedStream | null> => {
      const controllers = parallel ? [controllerA, controllerA2] : [controllerA];
      const runs = controllers.map((controller) =>
        attemptOpenRouter(controller).catch((err: unknown) => {
          primaryError = err;
          return null;
        }),
      );
      const first = await firstNonNull(runs);
      if (!first) return null;
      if (runs.length > 1) {
        // L'autre requête est annulée : seul le premier texte compte.
        const loser = first.index === 0 ? 1 : 0;
        controllers[loser].abort();
        runs[loser].then(
          (late) => late?.reader.cancel().catch(() => undefined),
          () => undefined,
        );
        logger.info(
          {
            callId: session.callControlId,
            winner: first.index === 0 ? 'first' : 'second',
            firstChunkMs: Date.now() - startedAt,
          },
          '[llm-parallel] OpenRouter twin requests raced',
        );
      }
      return first.value;
    })();

    // Sans doublon (hedgeMs = 0), Cerebras ne sert que de repli : on attend la fin de A.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const early =
      hedgeMs > 0
        ? await Promise.race([
            primary,
            new Promise<'hedge'>((resolve) => {
              timer = setTimeout(() => resolve('hedge'), hedgeMs);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          })
        : await primary;
    if (early && early !== 'hedge') return early;
    // Abandon de l'appelant (barge-in, raccroché) : rien ne doit repartir.
    if (early === null && request.signal?.aborted) throw primaryError;

    // B : Cerebras, en doublon (A tarde) ou en repli (A a échoué net).
    const isHedge = early === 'hedge';
    if (isHedge) notify(recordLlmHedgeFired());
    const duplicate = (async (): Promise<OpenedStream | null> => {
      if (isCircuitBreakerOpen(cerebras)) return null;
      const response = await this.fetchProviderStreaming(
        messages,
        { ...request, signal: signalOf(controllerB) },
        getVoiceLlmModel(),
      );
      if (!response.ok || !response.body) {
        recordProviderFailure(cerebras);
        recordLlmHttpError(cerebras, response.status);
        await response.body?.cancel().catch(() => undefined);
        return null;
      }
      recordProviderSuccess(cerebras);
      const reader = response.body.getReader();
      const firstRead = await raceTimeout(readUntilContent(reader), remainingMs());
      if (firstRead === 'timeout') {
        reader.cancel().catch(() => undefined);
        return null;
      }
      return { reader, provider: cerebras, firstRead };
    })().catch(() => null);

    const winner = await firstNonNull([primary, duplicate]);
    if (!winner) {
      if (isHedge) voiceLlmHedgeTotal.inc({ outcome: 'both_failed' });
      if (primaryError) throw primaryError;
      throw new Error('Structured LLM first chunk timed out, no fallback');
    }
    const duplicateWon = winner.index === 1;
    if (duplicateWon) {
      controllerA.abort();
      controllerA2.abort();
    } else {
      controllerB.abort();
    }
    (duplicateWon ? primary : duplicate).then(
      (late) => late?.reader.cancel().catch(() => undefined),
      () => undefined,
    );
    if (isHedge) {
      voiceLlmHedgeTotal.inc({ outcome: duplicateWon ? 'hedge_won' : 'primary_won' });
      logger.info(
        {
          callId: session.callControlId,
          hedgeMs,
          primary: 'openrouter',
          winner: winner.value.provider,
          firstChunkMs: Date.now() - startedAt,
        },
        '[llm-hedge] hedged request raced the primary',
      );
    }
    return winner.value;
  }

  /**
   * Fetch LLM streaming : le provider actif d'abord ; s'il échoue avant le premier octet (quota,
   * 429, 5xx, réseau, coupure), OpenRouter prend le tour, pour le tour structuré comme pour le
   * chemin à outils des autres restaurants.
   */
  private async fetchLlmStreaming(
    session: CallSession,
    messages: ChatMessage[],
    opts: {
      responseFormat?: StructuredResponseFormat;
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
    },
    trace?: { fellBack: boolean },
  ): Promise<{ response: Response; provider: LlmProviderUsed }> {
    const provider = getVoiceLlmProvider();
    let primaryResponse: Response | null = null;
    let primaryError: unknown = null;
    let reason: FallbackReason = 'network';

    if (isCircuitBreakerOpen(provider)) {
      logger.warn({ provider }, '[circuit-breaker] provider LLM open, streaming ignoré');
      primaryError = new Error('LLM provider unavailable (circuit open)');
      reason = 'circuit_open';
    } else {
      try {
        const response = await this.fetchProviderStreaming(messages, opts, getVoiceLlmModel());
        if (response.ok) {
          recordProviderSuccess(provider);
          return { response, provider };
        }
        recordProviderFailure(provider);
        recordLlmHttpError(provider, response.status);
        if (response.status === 402) notify(alertLlmPrimaryUnavailable('quota'));
        else if (response.status === 401 || response.status === 403) {
          notify(alertLlmPrimaryUnavailable('auth'));
        }
        primaryResponse = response;
        primaryError = new Error(`LLM ${response.status}`);
        reason = classifyFallbackReason({ status: response.status });
      } catch (err) {
        if (isSessionAbortError(err, opts.signal)) {
          recordLlmException(provider, err, opts.signal);
          throw err;
        }
        recordProviderFailure(provider);
        recordLlmException(provider, err, opts.signal);
        primaryError = err;
        reason = classifyFallbackReason({ error: err });
      }
    }

    // Rien n'a encore été dit : un second fournisseur peut prendre le tour.
    if (trace) trace.fellBack = true;
    const fallback = await this.fetchFallbackStreaming(
      session,
      messages,
      opts,
      reason,
      primaryError,
    );
    if (fallback) {
      await primaryResponse?.body?.cancel().catch(() => undefined);
      return { response: fallback, provider: 'openrouter' };
    }
    // Pas de secours : comportement historique (l'appelant lit le corps de l'erreur ou reçoit l'exception).
    if (primaryResponse) return { response: primaryResponse, provider };
    throw primaryError;
  }

  /**
   * Requête OpenRouter du tour structuré, avec le modèle et les réglages du relais
   * (VOICE_STRUCTURED_FALLBACK_*). Sert au principal (GPT-6 Luna), au repli et au doublon.
   */
  private fetchOpenRouterStreaming(
    messages: ChatMessage[],
    opts: {
      responseFormat?: StructuredResponseFormat;
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
    },
    apiKey: string,
  ): Promise<Response> {
    // Adresse propre au secours vocal (routage UE possible sans toucher à Jev) ; sinon l'adresse commune.
    const baseUrl = voiceConfig.OPENROUTER_FALLBACK_BASE_URL ?? voiceConfig.OPENROUTER_BASE_URL;
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      signal: withRequestTimeout(opts.signal),
      body: JSON.stringify({
        model: voiceConfig.VOICE_STRUCTURED_FALLBACK_MODEL,
        messages: mergeSystemMessages(messages),
        max_tokens: opts.maxTokens,
        ...(voiceConfig.VOICE_STRUCTURED_FALLBACK_SAMPLING === 'false'
          ? {}
          : { temperature: opts.temperature, top_p: 0.8 }),
        reasoning:
          voiceConfig.VOICE_STRUCTURED_FALLBACK_REASONING === 'none'
            ? { effort: 'none' }
            : { enabled: false },
        ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
        // Uniquement des hébergeurs qui respectent les paramètres. Ordre imposé : le tri par latence
        // historique a donné des pointes de 5 à 30 s (mesures du 29/09) ; vide = ce tri.
        provider: fallbackProviderPreferences(),
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
  }

  /**
   * Secours : OpenRouter, routé vers l'hébergeur le plus rapide qui accepte les paramètres
   * demandés (JSON Schema strict pour le tour structuré, outils pour l'autre chemin). Utilisé
   * seulement quand le provider principal échoue avant le premier fragment (quota, 429, 5xx,
   * réseau, circuit ouvert, premier fragment trop lent). Renvoie null sans clé ou si le secours échoue.
   */
  private async fetchFallbackStreaming(
    session: CallSession,
    messages: ChatMessage[],
    opts: {
      responseFormat?: StructuredResponseFormat;
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
    },
    reason: FallbackReason,
    primaryError: unknown,
  ): Promise<Response | null> {
    const path = opts.responseFormat ? 'structured' : 'legacy';
    const apiKey = voiceConfig.OPENROUTER_API_KEY?.trim();
    const detail = primaryError instanceof Error ? primaryError.message : String(primaryError);
    if (!apiKey) {
      voiceLlmFallbackTotal.inc({ path, outcome: 'no_key', reason });
      logger.warn(
        { callId: session.callControlId, path, reason, detail },
        '[llm-fallback] Primary failed, no fallback key',
      );
      return null;
    }
    const startedAt = Date.now();
    try {
      const response = await this.fetchOpenRouterStreaming(messages, opts, apiKey);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        voiceLlmFallbackTotal.inc({ path, outcome: 'failed', reason });
        // Crédit épuisé ou clé refusée : le secours est hors service, doublons compris.
        if ([401, 402, 403].includes(response.status)) {
          notify(alertLlmFallbackUnavailable(response.status));
        }
        logger.error(
          { callId: session.callControlId, path, reason, detail, status: response.status },
          '[llm-fallback] Primary and fallback failed',
        );
        return null;
      }
      // Un doublon de hedging n'est pas un repli : il est compté par suppernote_voice_llm_hedge_total.
      if (reason === 'hedge') return response;
      voiceLlmFallbackTotal.inc({ path, outcome: 'used', reason });
      logger.warn(
        { callId: session.callControlId, path, reason, detail, fallbackMs: Date.now() - startedAt },
        '[llm-fallback] Primary failed, OpenRouter fallback used',
      );
      return response;
    } catch (err) {
      if (isSessionAbortError(err, opts.signal)) throw err;
      voiceLlmFallbackTotal.inc({ path, outcome: 'failed', reason });
      logger.error(
        {
          callId: session.callControlId,
          path,
          reason,
          detail,
          err: err instanceof Error ? err.name : String(err),
        },
        '[llm-fallback] Primary and fallback failed',
      );
      return null;
    }
  }

  /**
   * Premier fragment du flux, avec un délai maximal : un modèle principal lent (file d'attente,
   * incident partiel) ne doit pas laisser l'appelant attendre le délai total de 8 s.
   */
  /**
   * Lit jusqu'au premier fragment qui porte du texte, dans le délai donné. Un fragment sans texte
   * (rôle seul, ouvert d'emblée par Cerebras) ne compte pas : sinon un flux ouvert vite mais dont le
   * texte tarde échappe au hedging et au délai maximal (appel 80a153e6 du 16/10/2026). Les octets
   * lus avant sont rendus avec ce premier texte, rien n'est perdu.
   */
  private async readFirstChunk(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    timeoutMs?: number,
    rescueAvailable?: () => Promise<boolean>,
  ): Promise<StreamChunkRead | 'timeout'> {
    const firstText = readUntilContent(reader);
    if (!timeoutMs) return firstText;
    const early = await raceTimeout(firstText, timeoutMs);
    if (early !== 'timeout' || !rescueAvailable || (await rescueAvailable())) return early;
    // Sans secours, abandonner le principal ne laisse que « je n'ai pas compris » : mieux vaut
    // une réponse lente (appel du 19/10 22:09, Cerebras en file d'attente, OpenRouter en 402).
    // Le délai total de la requête borne toujours l'attente.
    return raceTimeout(firstText, Math.max(0, voiceConfig.VOICE_LLM_TIMEOUT_MS - timeoutMs));
  }

  /**
   * Fetch LLM streaming via l'API OpenAI-compatible de Cerebras.
   */
  private async fetchProviderStreaming(
    messages: ChatMessage[],
    opts: {
      responseFormat?: StructuredResponseFormat;
      maxTokens: number;
      temperature: number;
      signal?: AbortSignal;
    },
    model: string,
  ): Promise<Response> {
    const body = {
      model,
      messages: mergeSystemMessages(messages),
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
      top_p: 0.8,
      reasoning_effort: 'none',
      ...(opts.responseFormat ? { response_format: opts.responseFormat } : {}),
      stream: true,
      stream_options: { include_usage: true },
    };

    const { baseUrl, apiKey } = getVoiceLlmEndpoint();
    return fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      signal: withRequestTimeout(opts.signal),
      body: JSON.stringify(body),
    });
  }

  /**
   * Exécute un appel d'outil et retourne le résultat texte.
   */
  private async executeTool(
    session: CallSession,
    name: string,
    argsJson: string,
    reservationConfirmationKey?: string,
    authorizationBasis?: VoiceToolAuthorizationBasis,
    executionControl?: VoiceToolExecutionControl,
  ): Promise<string> {
    if (session.ending || session.ended) return 'Appel terminé.';
    recordDebugTool(session, name);
    try {
      const validated = validateToolArgs(name, argsJson);
      if (!validated.success) {
        logger.warn(
          { toolName: name, error: validated.error, callId: session.callControlId },
          '[tool] Zod validation rejected tool args',
        );
        return "Je n'ai pas pu comprendre les informations transmises. Pouvez-vous reformuler ?";
      }
      const args = validated.data as Record<string, any>;
      const activeInteraction = getActivePendingInteraction(session);
      const lastUserUtterance =
        [...session.history].reverse().find((message) => message.role === 'user')?.content ?? '';
      const authorization = authorizeVoiceTool({
        toolName: name,
        args,
        lastUserUtterance,
        intent: session.conversation.intent,
        slots: session.conversation.slots,
        lastAvailabilityResult: session.conversation.lastAvailabilityResult,
        currentReservationKey: getReservationConfirmationKey(session),
        authorizedReservationKey:
          reservationConfirmationKey ?? session.conversation.confirmedReservationKey,
        nameCollectionBlocked:
          isNameCollectionBlocking(session) ||
          Boolean(session.conversation.nameCollection?.fallbackRecorded),
        managerConfigured: Boolean(session.managerPhone?.trim()),
        pendingInteraction: activeInteraction
          ? {
              kind: activeInteraction.kind,
              intentContext: activeInteraction.intentContext ?? null,
              fallbackMode: activeInteraction.fallbackMode ?? undefined,
            }
          : null,
        authorizationBasis,
      });
      if (authorization.status === 'denied') {
        logger.warn(
          {
            toolName: name,
            reason: authorization.reason,
            callId: session.callControlId,
          },
          '[tool] Policy denied voice tool execution',
        );
        const denialReply = buildVoiceToolPolicyDenialReply(authorization.reason);
        if (executionControl) executionControl.terminalReply = denialReply;
        return denialReply;
      }

      switch (name) {
        case 'createReservation': {
          const { date, time, partySize, customerName, customerPhone } = args;
          // Groupe au-delà du seuil du restaurant : jamais réservé automatiquement.
          if (typeof partySize === 'number' && partySize > voiceMaxPartySize(session)) {
            return `Groupe de ${partySize} personnes : au-delà de ${voiceMaxPartySize(session)}, la réservation passe par le gérant. Confirme le nombre puis propose le gérant ou la prise de message.`;
          }

          // Même si un provider LLM contourne la réponse déterministe, une
          // épellation en attente ne doit jamais déclencher d'effet métier.
          if (
            isNameCollectionBlocking(session) ||
            session.conversation.nameCollection?.fallbackRecorded
          ) {
            return terminalToolReply(
              executionControl,
              "Je dois d'abord confirmer l'orthographe de votre nom. Pouvez-vous me redonner les lettres, s'il vous plaît ?",
            );
          }

          const draftKey = getReservationConfirmationKey(session);
          const authorizedKey =
            reservationConfirmationKey ?? session.conversation.confirmedReservationKey;
          const draftMatchesArgs =
            Boolean(draftKey) &&
            session.conversation.slots.date === date &&
            session.conversation.slots.time === time &&
            session.conversation.slots.partySize === partySize &&
            session.conversation.lastAvailabilityResult?.key === `${date}:${time}:${partySize}` &&
            Boolean(session.conversation.lastAvailabilityResult?.slots.includes(time));
          if (!draftKey || authorizedKey !== draftKey || !draftMatchesArgs) {
            return terminalToolReply(
              executionControl,
              'Je dois d’abord vous relire la réservation et recueillir votre accord explicite avant de la créer.',
            );
          }
          // Consommer l'accord juste avant l'effet métier. Le chemin
          // createReservationFromConversation transmet sa clé privée pour
          // éviter qu'un second événement STT ne réutilise le même « oui ».
          session.conversation.confirmedReservationKey = null;

          // Le nom confirmé par notre garde déterministe est la source de
          // vérité ; il ne peut pas être réécrit en mot plausible par le LLM.
          const confirmedCustomerName =
            session.conversation.nameCollection?.confirmedName ??
            session.conversation.slots.customerName;
          const reservationCustomerName = confirmedCustomerName ?? customerName ?? 'Client';

          // Démonstration d'onboarding : tout le parcours (disponibilité, relecture, accord, nom)
          // est réel, seule l'écriture est simulée. Rien n'est créé dans l'agenda du restaurant.
          if (session.demo) {
            session.reservationCreatedAt = Date.now();
            return terminalToolReply(
              executionControl,
              `Réservation confirmée pour ${reservationCustomerName}, le ${date} à ${time}, pour ${partySize ?? 1} personne(s).`,
            );
          }

          try {
            const callRecordId = await this.resolveCallRecordId(session);
            if (!callRecordId) {
              return managerRecoveryOffer(
                session,
                "Je n'ai pas pu rattacher cet appel ; la réservation n'a pas été créée.",
                executionControl,
              );
            }

            // Empreinte bancaire : la table est tenue, le lien part par SMS, jamais de carte au téléphone.
            const guarantee = await voiceCardGuaranteeTerms({
              restaurantId: session.restaurantId,
              date,
              partySize: partySize ?? 1,
            });
            const reservationPhone = customerPhone ?? session.from;
            if (guarantee && !reservationPhone) {
              return terminalToolReply(executionControl, CARD_GUARANTEE_NO_PHONE_FACT);
            }

            const created = await ReservationService.create({
              restaurantId: session.restaurantId,
              callId: callRecordId,
              // Heure locale du restaurant, jamais celle du serveur.
              reservedAt: zonedTimeToUtc(date, time, session.timezone || 'Europe/Paris'),
              partySize: partySize ?? 1,
              customerName: reservationCustomerName,
              customerPhone: reservationPhone,
              ...(guarantee
                ? {
                    cardGuarantee: {
                      policyId: guarantee.policyId,
                      expiresAt: new Date(Date.now() + VOICE_CARD_GUARANTEE_HOLD_MS),
                    },
                  }
                : {}),
            });
            session.reservationCreatedAt = Date.now();

            if (guarantee) {
              const payment = await db.reservationPayment.findFirst({
                where: { restaurantId: session.restaurantId, reservationId: created.id },
                select: { id: true, restaurantId: true },
              });
              if (payment) await enqueueCardGuaranteeSms('link', payment);
              return terminalToolReply(
                executionControl,
                cardGuaranteeCreatedFact({
                  customerName: reservationCustomerName,
                  date,
                  time,
                  partySize: partySize ?? 1,
                }),
              );
            }

            return terminalToolReply(
              executionControl,
              `Réservation confirmée pour ${reservationCustomerName}, le ${date} à ${time}, pour ${partySize ?? 1} personne(s).${confirmationSmsStatement(session.smsConfirmEnabled)}`,
            );
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error(
              { err: message, callId: session.callControlId },
              '[tool] ReservationService.create failed',
            );

            if (process.env.SENTRY_DSN) {
              Sentry.captureException(err, {
                tags: { service: 'manager-tool' },
                extra: { callId: session.callControlId },
              });
            }

            if (message === 'SLOT_NOT_AVAILABLE') {
              return terminalToolReply(
                executionControl,
                "Désolé, ce créneau horaire n'est pas disponible. Veuillez proposer une autre date ou heure.",
              );
            }

            return terminalToolReply(
              executionControl,
              "Désolé, une erreur technique est survenue lors de l'enregistrement de la réservation. Veuillez essayer un autre créneau ou demander à parler au gérant.",
            );
          }
        }

        case 'takeMessage': {
          const { customerName, message, callbackPhone } = args;

          if (session.demo) {
            return terminalToolReply(
              executionControl,
              `J'ai bien noté votre message pour le gérant : "${message}". Il vous recontactera${callbackPhone ? ` au ${callbackPhone}` : ''} dès que possible. Merci de votre appel.`,
            );
          }

          try {
            const callRecordId = await this.resolveCallRecordId(session);
            if (!callRecordId) {
              return managerRecoveryOffer(
                session,
                "Je n'ai pas pu rattacher votre message à cet appel ; il n'a pas été enregistré.",
                executionControl,
              );
            }

            await db.message.create({
              data: {
                restaurantId: session.restaurantId,
                callId: callRecordId,
                customerName: customerName ?? 'Client',
                customerPhone: callbackPhone ?? session.from,
                content: message,
                status: 'PENDING',
              },
            });

            return terminalToolReply(
              executionControl,
              `J'ai bien noté votre message pour le gérant : "${message}". Il vous recontactera${callbackPhone ? ` au ${callbackPhone}` : ''} dès que possible. Merci de votre appel.`,
            );
          } catch (err: unknown) {
            logger.error(
              {
                err: err instanceof Error ? err.message : String(err),
                callId: session.callControlId,
              },
              '[tool] takeMessage failed',
            );
            if (process.env.SENTRY_DSN) {
              Sentry.captureException(err, {
                tags: { service: 'manager-tool', tool: 'takeMessage' },
                extra: { callId: session.callControlId },
              });
            }
            return managerRecoveryOffer(
              session,
              "Je n'ai pas pu enregistrer votre message.",
              executionControl,
            );
          }
        }

        case 'handoffToManager':
          // Jamais de transfert réel pendant une démonstration : le gérant ne doit pas être appelé.
          // Le résultat est un fait pour le modèle, qui le dit avec ses mots (pas de réplique codée).
          if (session.demo) {
            session.handoffConclusion = 'demo_no_transfer';
            return "Transfert non effectué : cette conversation est une démonstration. Propose de prendre un message pour le gérant, sans affirmer qu'il est absent ou indisponible.";
          }
          if (!session.managerPhone?.trim()) {
            session.handoffConclusion = 'manager_unconfigured';
            recordVoiceTransfer(session, authorizationBasis, 'unconfigured');
            return terminalToolReply(
              executionControl,
              "Je n'ai pas de ligne directe configurée pour le gérant. Je peux prendre un message à transmettre immédiatement.",
            );
          }
          try {
            const transferResponse = await telnyxFetch(
              `/v2/calls/${session.callControlId}/actions/transfer`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
                },
                body: JSON.stringify({ to: session.managerPhone.trim() }),
                signal: AbortSignal.timeout(5_000),
              },
            );
            if (!transferResponse.ok) {
              const responseBody = await transferResponse.text().catch(() => '');
              session.handoffConclusion = 'manager_transfer_rejected';
              recordVoiceTransfer(session, authorizationBasis, 'rejected');
              logger.warn(
                {
                  callId: session.callControlId,
                  status: transferResponse.status,
                  body: responseBody.slice(0, 200),
                },
                '[tool] Manager transfer rejected',
              );
              return terminalToolReply(
                executionControl,
                "Je n'ai pas réussi à joindre le gérant. Je peux prendre un message à lui transmettre.",
              );
            }
            // Un 2xx signifie seulement que Telnyx a accepté la commande :
            // la sonnerie et le décroché du gérant ne sont pas encore connus.
            session.handoffInProgress = true;
            session.handoffConclusion = 'manager_transfer_requested';
            recordVoiceTransfer(session, authorizationBasis, 'requested');
            return terminalToolReply(
              executionControl,
              'Je lance le transfert vers le gérant, un instant.',
            );
          } catch (err) {
            session.handoffConclusion = 'manager_transfer_failed';
            recordVoiceTransfer(session, authorizationBasis, 'failed');
            logger.warn({ err, callId: session.callControlId }, '[tool] Manager transfer failed');
            return terminalToolReply(
              executionControl,
              "Le transfert vers le gérant n'a pas abouti. Je peux prendre un message à lui transmettre.",
            );
          }

        default:
          return `Outil inconnu : ${name}`;
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        { err, toolName: name, callId: session.callControlId },
        `[tool] Error executing ${name}: ${message}`,
      );
      if (process.env.SENTRY_DSN) {
        Sentry.captureException(err, {
          tags: { service: 'manager', tool: name },
          extra: { callId: session.callControlId },
        });
      }
      return `Erreur lors de l'exécution de ${name}.`;
    }
  }
}

function sessionIdKey(ccId: string): string {
  return createHash('sha256').update(ccId).digest('hex').slice(0, 16);
}
