/**
 * Événements de transcription (Deepgram, Ink-2 en secours) : fins de tour, reprises de parole,
 * indisponibilité de la reconnaissance, puis remise du tour au moteur structuré
 * (`structured-turn/engine.ts`), qui comprend le tour, répond et exécute les actions.
 *
 * Extrait de handler.ts. Ces fonctions prennent une CallSession et un CallSessionManager en paramètres
 * et mutent l'état de la session (state, transcript, etc.) : le handler principal délègue en passant la
 * session par référence.
 */

import { WebSocket } from 'ws';
import type { SttEvent, CallSession } from './types';
import type { CallSessionManager } from './manager';
import { finishCall } from './call-ending';
import { runStructuredTurn } from './structured-turn/engine';
import { logger } from '../../../shared/logger/pino';
import { captureException } from '../../../shared/sentry/client';
import { writeDebugLog } from './debug-log';
import { describeTranscript } from './pii-redact';
import { speakTtsStreamed } from './tts-handler';
import { offTurnTtsProvider } from './elevenlabs-tts';
import { recordVoiceTurnEvent, completeVoiceTurnInput, startVoiceTurn } from './turn-telemetry';
import { TRANSCRIPT_DEDUPE_WINDOW_MS } from '../../../shared/constants/timeouts.js';
import { isNameCollectionBlocking } from './conversation-state';
import {
  dialogueContextOf,
  isRepeatOfLastProcessedTurn,
  normalizeTranscriptForDedupe,
} from './transcript-dedupe';
import {
  effectiveVoiceLanguage,
  hasReliableLanguageEvidence,
  normalizeVoiceLanguage,
  resolveVoiceLanguage,
} from './voice-language';

const recentTranscripts = new WeakMap<
  CallSession,
  { normalized: string; at: number; dialogueContext: string }
>();

export { normalizeTranscriptForDedupe };

export function shouldSkipDuplicateTranscript(session: CallSession, transcript: string): boolean {
  const normalized = normalizeTranscriptForDedupe(transcript);
  if (!normalized) return true;

  // Le même mot peut être une réponse légitime à deux questions successives
  // (« oui » pour valider le nom, puis « oui » pour valider le récapitulatif).
  // Le contexte métier distingue ces tours tout en filtrant les doublons STT
  // qui répètent exactement le même événement.
  const dialogueContext = dialogueContextOf(session);
  const previous = recentTranscripts.get(session);
  const now = Date.now();
  if (
    previous &&
    previous.normalized === normalized &&
    previous.dialogueContext === dialogueContext &&
    now - previous.at < TRANSCRIPT_DEDUPE_WINDOW_MS
  ) {
    return true;
  }

  recentTranscripts.set(session, { normalized, at: now, dialogueContext });
  return false;
}

export function extractRestaurantName(systemPrompt: string): string {
  const firstLine = systemPrompt.split('\n')[0] ?? '';
  const withoutPrefix = firstLine
    .replace(/^Tu es l'hôte d'accueil et assistant vocal chaleureux de /, '')
    .replace(/^Tu es l'assistant vocal (?:chaleureux )?de /, '');

  // Le nom est suivi d'instructions internes : elles ne doivent jamais être vocalisées.
  return withoutPrefix
    .replace(/\.\s+L'accueil a déjà été prononcé.*$/u, '')
    .replace(/\.$/, '')
    .trim();
}

/** Délai sans nouvelle transcription avant de retraiter une phrase interrompue. */
export const INTERRUPTED_TURN_RESUME_MS = 1_500;

/**
 * Une reprise de parole annule la réponse en cours. Si elle ne produit aucune
 * transcription (souffle, bruit), la phrase de l'appelant était perdue et il
 * attendait en silence (appel du 24/09, 6 s). On la conserve : fusionnée avec
 * la suite si elle arrive, retraitée seule sinon.
 */
function holdInterruptedTurn(session: CallSession, mgr: CallSessionManager): void {
  const transcript = session.lastProcessedTranscript;
  if (!transcript) return;
  if (session.interruptedTurn) clearTimeout(session.interruptedTurn.timer);
  session.interruptedTurn = {
    transcript,
    timer: armInterruptedTurnTimer(session, mgr, transcript),
  };
}

function armInterruptedTurnTimer(
  session: CallSession,
  mgr: CallSessionManager,
  transcript: string,
): ReturnType<typeof setTimeout> {
  return setTimeout(() => {
    if (session.interruptedTurn?.transcript !== transcript) return;
    session.interruptedTurn = null;
    if (session.ended || session.ending || session.state !== 'LISTENING') return;
    processTranscriptStreaming(session, transcript, mgr).catch((err) =>
      logger.error({ err, callId: session.callControlId }, '[stt] interrupted turn resume failed'),
    );
  }, INTERRUPTED_TURN_RESUME_MS);
}

function takeInterruptedTranscript(session: CallSession): string | null {
  const held = session.interruptedTurn;
  if (!held) return null;
  clearTimeout(held.timer);
  session.interruptedTurn = null;
  return held.transcript;
}

export function invalidatePendingVoiceResponse(
  session: CallSession,
  mgr: CallSessionManager,
): boolean {
  if (session.state !== 'PROCESSING') return false;
  session.abortController?.abort();
  session.abortController = null;
  session.responseGeneration++;
  session.ttsGeneration++;
  session.ttsContext?.cancel();
  session.ttsContext = null;
  session.conversation.toolInFlight = null;
  mgr.transition(session, 'LISTENING');
  return true;
}

function buildSttUnavailableCopy(session: CallSession): {
  readonly noManager: string;
  readonly manager: string;
  readonly transferFailed: string;
  readonly transferUnavailable: string;
} {
  const english = effectiveVoiceLanguage(session) === 'en';
  const opening = english
    ? "I'm sorry, I'm having a technical problem and I can't hear you clearly."
    : "Je suis désolé, j'ai un problème technique et je ne vous entends pas correctement.";
  const closing = session.onlineReservationsActive
    ? english
      ? 'You can book online. Goodbye.'
      : 'Vous pouvez réserver en ligne. Au revoir.'
    : english
      ? 'Please call back a little later. Goodbye.'
      : 'Vous pouvez rappeler un peu plus tard. Au revoir.';

  return {
    noManager: `${opening} ${closing}`,
    manager: `${opening} ${english ? "I'll put you through to the restaurant." : 'Je vous passe le restaurant.'}`,
    transferFailed: `${english ? "I couldn't put you through." : "Je n'ai pas réussi à vous transférer."} ${closing}`,
    transferUnavailable: `${english ? "I can't transfer you right now." : 'Je ne peux pas vous transférer pour le moment.'} ${closing}`,
  };
}

/**
 * Gère les événements de transcription (Deepgram, ou Ink-2 en secours).
 */
export function handleSttEvent(
  event: SttEvent,
  session: CallSession,
  mgr: CallSessionManager,
): void {
  if (session.ended || session.ending || session.handoffInProgress) return;
  switch (event.type) {
    case 'UtteranceStart': {
      if (session.currentTurn && session.state === 'PROCESSING') {
        recordVoiceTurnEvent(session, 'llm_interrupted', { reason: 'speech_resumed' });
        holdInterruptedTurn(session, mgr);
      }
      // Démarrer le chronomètre avant le commit final afin d'inclure le silence VAD.
      startVoiceTurn(session);
      // Annuler toute requête LLM en cours (le caller continue de parler)
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = null;
      }

      // Si on était en spéculation (PROCESSING), le caller continue → reset
      if (session.state === 'PROCESSING') {
        session.responseGeneration++;
        session.conversation.toolInFlight = null;
        mgr.transition(session, 'LISTENING');
      } else if (session.state === 'IDLE') {
        mgr.transition(session, 'LISTENING');
      }
      break;
    }

    case 'SpeechResumed': {
      if (!session.currentTurn) startVoiceTurn(session);
      else recordVoiceTurnEvent(session, 'speech_resumed');
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = null;
      }
      if (session.state === 'PROCESSING') {
        holdInterruptedTurn(session, mgr);
        session.responseGeneration++;
        session.conversation.toolInFlight = null;
        mgr.transition(session, 'LISTENING');
      }
      break;
    }

    case 'UtteranceEnd': {
      const interruptedTranscript = takeInterruptedTranscript(session);
      if (interruptedTranscript) {
        event.transcript = `${interruptedTranscript} ${event.transcript}`;
      }
      const sameRecentTranscript =
        !interruptedTranscript && isRepeatOfLastProcessedTurn(session, event.transcript);
      if (sameRecentTranscript) {
        logger.debug(
          { callId: session.callControlId, ...describeTranscript(event.transcript) },
          '[stt] Ignoring duplicate final for the current dialogue step',
        );
        break;
      }

      const hasPreviousFinal = session.latencyTrace?.sttFinalAt !== undefined;
      const distinctFinal =
        hasPreviousFinal &&
        (Boolean(interruptedTranscript) ||
          normalizeTranscriptForDedupe(session.lastProcessedTranscript ?? '') !==
            normalizeTranscriptForDedupe(event.transcript));
      if (distinctFinal) {
        invalidatePendingVoiceResponse(session, mgr);
        startVoiceTurn(session, event.transcript);
      }
      const detectedLanguage = normalizeVoiceLanguage(event.languageCode);
      if (detectedLanguage) {
        const previousLanguage = effectiveVoiceLanguage(session);
        const languageDecision = resolveVoiceLanguage(
          previousLanguage,
          detectedLanguage,
          event.transcript,
          session.turnCount,
          session.voiceLanguageCandidate,
        );
        session.voiceLanguageCandidate = languageDecision.candidate;
        if (languageDecision.accepted) {
          session.voiceLanguageCode = languageDecision.language;
        } else {
          logger.info(
            {
              callId: session.callControlId,
              previousLanguage,
              detectedLanguage,
              evidence: hasReliableLanguageEvidence(event.transcript),
            },
            '[voice-language] Ignoring unstable language detection',
          );
        }
        if (languageDecision.changed) {
          // Une spéculation lancée avant le commit peut avoir utilisé
          // l'ancienne langue (notamment sur un premier « yes »). Elle ne doit
          // jamais être réutilisée après un changement de langue détecté.
          session.abortController?.abort();
          session.abortController = null;
          logger.info(
            {
              callId: session.callControlId,
              previousLanguage,
              language: languageDecision.language,
            },
            '[voice-language] Updated dialogue language from the STT provider',
          );
        }
      }
      // Cumuler le transcript pour persistance et rattacher la fin au tour
      // commencé par UtteranceStart.
      session.transcript += (session.transcript ? ' ' : '') + event.transcript;
      completeVoiceTurnInput(session, event.transcript, event.words, event);
      session.sttEvidence = {
        transcript: event.transcript,
        words: event.words,
        partials: [...(session.turnPartials ?? [])],
      };
      session.turnPartials = [];

      const startFinalStreaming = () => {
        processTranscriptStreaming(session, event.transcript, mgr).catch((err) =>
          logger.error(
            { err, callId: session.callControlId },
            '[stt] processTranscriptStreaming failed',
          ),
        );
      };

      if (
        isNameCollectionBlocking(session) ||
        session.conversation?.pendingQuestion === 'customerName'
      ) {
        startFinalStreaming();
        break;
      }

      if (session.state === 'LISTENING' || session.state === 'IDLE') {
        startFinalStreaming();
      }
      break;
    }

    case 'Error': {
      logger.error(
        { callId: session.callControlId, errorMsg: event.message },
        `[stt] Error: ${event.message}`,
      );
      const err = new Error(`STT error: ${event.message}`);
      captureException(err, {
        tags: { service: 'handler', event: 'stt-error' },
        extra: { callId: session.callControlId },
      });
      speakTtsStreamed(
        session,
        effectiveVoiceLanguage(session) === 'en'
          ? "Sorry, I didn't understand. Could you repeat that, please?"
          : "Désolé, je n'ai pas bien compris. Pouvez-vous répéter ?",
        offTurnTtsProvider(),
      ).catch((err) =>
        logger.error(
          { err, callId: session.callControlId },
          '[stt] speakTtsStreamed fallback failed',
        ),
      );
      mgr.transition(session, 'LISTENING');
      break;
    }

    case 'Unavailable': {
      if (session.sttFallbackSpoken) break;
      session.sttFallbackSpoken = true;
      logger.error(
        { callId: session.callControlId, reason: event.reason },
        '[stt] Transcription unavailable; starting call fallback',
      );
      session.abortController?.abort();
      session.abortController = null;
      session.responseGeneration++;

      const managerConfigured = Boolean(session.managerPhone?.trim());
      const fallbackCopy = buildSttUnavailableCopy(session);
      if (!managerConfigured) {
        finishCall(session, mgr, fallbackCopy.noManager).catch((err) =>
          logger.error(
            { err, callId: session.callControlId },
            '[stt] Could not finish call after transcription outage',
          ),
        );
        break;
      }

      session.ttsGeneration++;
      session.ttsContext?.cancel();
      session.ttsContext = null;
      if (session.telnyxWs.readyState === WebSocket.OPEN) {
        session.telnyxWs.send(JSON.stringify({ event: 'clear' }));
      }
      if (session.state === 'LISTENING') mgr.transition(session, 'PROCESSING');
      if (session.state !== 'SPEAKING') mgr.transition(session, 'SPEAKING');
      (async () => {
        await speakTtsStreamed(session, fallbackCopy.manager, offTurnTtsProvider());
        if (session.ended || session.ending) return;
        await mgr.handoffToManager(session);
        if (session.handoffInProgress || session.ended || session.ending) return;
        await finishCall(session, mgr, fallbackCopy.transferFailed);
      })().catch((err) => {
        logger.error(
          { err, callId: session.callControlId },
          '[stt] Manager fallback after transcription outage failed',
        );
        if (!session.ended && !session.ending) {
          finishCall(session, mgr, fallbackCopy.transferUnavailable).catch((finishErr) =>
            logger.error(
              { err: finishErr, callId: session.callControlId },
              '[stt] Could not finish call after manager fallback failed',
            ),
          );
        }
      });
      break;
    }
  }
}

export function normalizeSttTranscript(text: string): string {
  if (!text) return text;
  return text
    .replace(/\b(un|une)\s+résumé\b/gi, 'une réservation')
    .replace(/\bje\s+souhaite\s+un\s+résumé\b/gi, 'je souhaite une réservation');
}

/**
 * Version streaming : reçoit les phrases du LLM au fur et à mesure
 * et lance le TTS immédiatement sans attendre la réponse complète.
 */
export async function processTranscriptStreaming(
  session: CallSession,
  rawTranscript: string,
  mgr: CallSessionManager,
): Promise<void> {
  const transcript = normalizeSttTranscript(rawTranscript);
  if (!transcript.trim()) return;
  if (session.ended || session.ending || session.telnyxWs.readyState !== WebSocket.OPEN) {
    writeDebugLog(`[processTranscriptStreaming] Session ended or WS closed, skipping`);
    return;
  }
  if (shouldSkipDuplicateTranscript(session, transcript)) {
    writeDebugLog(
      `[processTranscriptStreaming] Skipping duplicate transcript ${JSON.stringify(describeTranscript(transcript))}`,
    );
    return;
  }
  session.lastProcessedTranscript = transcript;
  session.lastProcessedAt = Date.now();
  session.lastProcessedDialogueContext = dialogueContextOf(session);

  const responseGeneration = ++session.responseGeneration;
  const isCurrentResponse = () =>
    !session.ended && session.responseGeneration === responseGeneration;
  if (session.state === 'IDLE') mgr.transition(session, 'LISTENING');
  if (session.state === 'LISTENING') mgr.transition(session, 'PROCESSING');

  // Le modèle comprend et répond en un seul appel structuré ; aucune règle lexicale de ce fichier ne s'applique.
  await runStructuredTurn(session, transcript, mgr, isCurrentResponse);
}
