/**
 * Handler WebSocket Telnyx Media Stream — orchestrator.
 *
 * Reçoit l'audio en temps réel de Telnyx, le forwarde à Deepgram (Cartesia Ink-2 en secours),
 * reçoit les transcripts, les envoie au LLM, génère du TTS Cartesia,
 * et renvoie l'audio à Telnyx via le stream bidirectionnel.
 *
 * Barge-in : quand le caller parle pendant le TTS, la reconnaissance détecte
 * UtteranceStart → on clear le buffer Telnyx → on réécoute.
 *
 * Architecture :
 *   - debug-log.ts       → writeDebugLog (utilitaire partagé)
 *   - session-persistence.ts → persistSttCall, persistLatencyTrace (DB)
 *   - tts-handler.ts     → speakTtsStreamed, cleanTextForTts, etc. (Cartesia)
 *   - llm-handler.ts     → handleSttEvent, processTranscriptStreaming, etc. (Deepgram, Ink-2)
 *   - handler.ts (this)  → registerMediaStreamRoutes, handleTelnyxMessage (orchestrator)
 *
 * NOTE: audio-buffer.ts n'a pas été créé car la gestion du buffer audio
 * (session.audioBuffer) se fait dans stt-bridge.ts, pas dans ce
 * handler. Il n'y a pas de logique de buffer à extraire ici.
 */

import type { FastifyInstance } from 'fastify';
import { buildFixedGreeting, greetingSalutation } from '../agent-identity';
import '@fastify/websocket';
import { WebSocket } from 'ws';
import { timingSafeEqual } from 'node:crypto';
import type { TelnyxStreamMessage, SttEvent, CallSession } from './types';
import { CallSessionManager } from './manager';
import { sendAudioToStt, closeStt, connectStt, sttProviderId } from './stt-bridge';
import { resolveVoiceFeatureSnapshot } from './feature-flags';
import { decodeTelnyxToPcm16, telnyxCodecProfile } from './telnyx-codec';
import { L16EndianProbe, WidebandProbe } from './wideband';
import { logger } from '../../../shared/logger/pino';
import { captureException } from '../../../shared/sentry/client';
import { writeDebugLog } from './debug-log';
import { persistSttCall, persistLatencyTrace } from './session-persistence';
import { speakTtsStreamed } from './tts-handler';
import { logAudioOutSummary } from './outbound-audio';
import { handleSttEvent, extractRestaurantName } from './llm-handler';
import { redactPii } from './pii-redact';
import { acknowledgeCallEnding } from './call-ending';
import { startTestCallRecording } from '../call-recording.service';
import { startNoiseSuppression } from '../noise-suppression';
import { finalizeVoiceUsage } from '../../usage/voice-usage.service';
import { finalizeVoiceCall } from '../call-finalization.service';
import { observedTtsProvider } from './turn-telemetry';
import { callFinalizationDependencies } from '../call-finalization.dependencies';
import { getVoiceLlmRuntimeInfo } from '../llm-provider';
import { voiceWidebandDetectedTotal } from '../../../shared/observability/metrics';

/**
 * Finalisation métier d'un appel depuis le stream : le WebSocket peut se
 * fermer avant que `/voice/telnyx/end` n'arrive, l'appel doit tout de même
 * produire un outcome exploitable et programmer la récupération commerciale.
 * Le webhook peut ensuite compléter les faits grâce à l'écriture monotone.
 */
function finalizeSessionCall(
  app: FastifyInstance,
  session: CallSession,
  source: 'stream-close' | 'stream-error',
  log: { error: (obj: unknown, msg?: string) => void },
): void {
  try {
    finalizeVoiceCall(
      session.callLegId,
      {
        source,
        restaurantId: session.restaurantId,
        transcript: session.transcript,
        sttProvider: session.sttProviderUsed ?? null,
        endedReason: source === 'stream-error' ? 'error' : null,
        handoffConclusion: session.handoffConclusion,
        conversationIntent: session.conversation?.intent ?? null,
        llmProvider:
          session.currentTurn?.llmProvider ??
          session.voiceTurnHistory?.find((turn) => turn.llmProvider)?.llmProvider ??
          null,
        ttsProvider: observedTtsProvider(session),
        to: session.to,
        customerPhone: session.from,
      },
      callFinalizationDependencies(app),
    ).catch((err) => log.error({ err }, '[stream] finalizeVoiceCall failed'));
  } catch (err) {
    // La fermeture du stream ne doit jamais être interrompue par la
    // finalisation : le worker de rattrapage reprendra l'appel.
    log.error({ err }, '[stream] finalizeVoiceCall threw synchronously');
  }
}

export function buildInitialGreeting(
  restaurantName: string,
  timezone = 'Europe/Paris',
  now = new Date(),
): string {
  return buildFixedGreeting(restaurantName, greetingSalutation(now, timezone));
}

/**
 * Enregistre la route WebSocket pour le media stream Telnyx.
 * Utilise @fastify/websocket pour la gestion des connexions WS.
 */
export function registerMediaStreamRoutes(app: FastifyInstance): void {
  app.get('/voice/stream/:callId', { websocket: true }, (socket, req) => {
    const callId = (req.params as { callId: string }).callId;
    const mgr = CallSessionManager.getInstance();
    const candidate = mgr.get(callId);
    const token = (req.query as { token?: unknown }).token;
    if (
      !candidate?.streamToken ||
      typeof token !== 'string' ||
      Buffer.byteLength(token) !== Buffer.byteLength(candidate.streamToken) ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(candidate.streamToken)) ||
      candidate.ended ||
      (candidate.telnyxWs && candidate.telnyxWs.readyState !== WebSocket.CLOSED)
    ) {
      socket.close(1008, 'unauthorized');
      return;
    }

    // Per-call child logger. Every log line emitted from this WS handler
    // (and from any function it calls) will carry `call_id`, which makes
    // it possible to grep a single call's full lifecycle in production:
    //   pm2 logs | jq 'select(.call_id == "v3:abc123")'
    // The base logger is the shared one (so secrets redaction and the
    // service/env bindings still apply).
    const log = logger.child({ call_id: callId });
    log.info('[stream] New Telnyx WS connection for call');

    // Récupérer la session créée par call.initiated
    let session: CallSession | undefined;
    let started = false;

    socket.on('message', (raw: Buffer) => {
      try {
        const msg: TelnyxStreamMessage = JSON.parse(raw.toString());
        if (msg.event === 'connected' && !started) return;
        if (!started) {
          if (
            msg.event !== 'start' ||
            msg.start?.call_control_id !== callId ||
            mgr.get(callId) !== candidate ||
            (candidate.telnyxWs && candidate.telnyxWs.readyState !== WebSocket.CLOSED)
          ) {
            socket.close(1008, 'invalid stream');
            return;
          }
          started = true;
          if (candidate.streamStartTimer) clearTimeout(candidate.streamStartTimer);
          candidate.streamStartTimer = null;
        } else if (
          msg.event === 'start' ||
          candidate.telnyxWs !== socket ||
          mgr.get(callId) !== candidate
        ) {
          socket.close(1008, 'invalid stream');
          return;
        }
        session = handleTelnyxMessage(msg, callId, socket, mgr) ?? session;
      } catch (err) {
        log.error({ err }, '[stream] Parse error');
      }
    });

    socket.on('close', () => {
      log.info('[stream] Telnyx WS closed');
      if (session && session.telnyxWs === socket) {
        finishL16Endian(session);
        finishWideband(session);
        session.ended = true;
        session.state = 'IDLE';
        session.isSpeaking = false;
        // Persister les traces avant cleanup (fire-and-forget, mais avec catch
        // pour éviter unhandledRejection silencieux dans un WS handler).
        persistLatencyTrace(session).catch((err) =>
          log.error({ err }, '[stream] persistLatencyTrace failed'),
        );
        persistSttCall(session).catch((err) =>
          log.error({ err }, '[stream] persistSttCall failed'),
        );
        finalizeVoiceUsage(session).catch((err) =>
          log.error({ err }, '[stream] finalizeVoiceUsage failed'),
        );
        finalizeSessionCall(app, session, 'stream-close', log);
        closeStt(session);
        if (mgr.get(session.callControlId) === session) mgr.delete(session.callControlId);
      }
    });

    socket.on('error', (err: Error) => {
      log.error({ err }, `[stream] Error for call: ${err.message}`);
      captureException(err, {
        tags: { service: 'handler', event: 'websocket-error' },
        extra: { callId },
      });
      if (session && session.telnyxWs === socket) {
        finishL16Endian(session);
        finishWideband(session);
        session.ended = true;
        session.state = 'IDLE';
        session.isSpeaking = false;
        persistLatencyTrace(session).catch((err) =>
          log.error({ err }, '[stream] persistLatencyTrace failed (error path)'),
        );
        persistSttCall(session).catch((err) =>
          log.error({ err }, '[stream] persistSttCall failed (error path)'),
        );
        finalizeVoiceUsage(session).catch((err) =>
          log.error({ err }, '[stream] finalizeVoiceUsage failed (error path)'),
        );
        finalizeSessionCall(app, session, 'stream-error', log);
        closeStt(session);
        if (mgr.get(session.callControlId) === session) mgr.delete(session.callControlId);
      }
    });
  });
}

/**
 * Sonde de bande large : part de l'énergie au-dessus de 4 kHz sur les premières
 * secondes de parole. Sert à savoir si L16 apporte réellement quelque chose sur
 * les appels réels. Aucune PII : seule une énergie agrégée est calculée, et le
 * buffer est libéré dès la décision prise.
 */
function trackWideband(session: CallSession, payload: string): void {
  const profile = telnyxCodecProfile(session.codec);
  if (!profile.wideband || session.widebandDetected !== undefined) return;
  session.widebandProbe ??= new WidebandProbe(profile.sampleRate);
  const pcm = decodeTelnyxToPcm16(session.codec, Buffer.from(payload, 'base64'));
  const decision = session.widebandProbe.add(pcm);
  if (decision === null) return;
  session.widebandDetected = decision;
  voiceWidebandDetectedTotal.inc({
    detected: decision ? 'true' : 'false',
    codec: session.codec,
  });
  session.widebandProbe = null;
}

function finishWideband(session: CallSession): void {
  if (session.codec !== 'L16' || session.widebandDetected !== undefined) return;
  const detected = session.widebandProbe?.finish() ?? false;
  session.widebandDetected = detected;
  session.widebandProbe = null;
  voiceWidebandDetectedTotal.inc({ detected: detected ? 'true' : 'false', codec: 'L16' });
}

function logL16Endian(
  session: CallSession,
  rms: { bigEndianRms: number; littleEndianRms: number },
): void {
  if (session.l16EndianLogged) return;
  session.l16EndianLogged = true;
  session.l16EndianProbe = null;
  logger.info(
    { media_format: session.l16MediaFormat ?? null, ...rms },
    '[stream] L16 endian probe',
  );
}

function trackL16Endian(session: CallSession, payload: string): void {
  if (session.codec !== 'L16' || session.l16EndianLogged) return;
  session.l16EndianProbe ??= new L16EndianProbe();
  const rms = session.l16EndianProbe.add(Buffer.from(payload, 'base64'));
  if (rms) logL16Endian(session, rms);
}

function finishL16Endian(session: CallSession): void {
  if (session.codec !== 'L16' || session.l16EndianLogged) return;
  logL16Endian(session, (session.l16EndianProbe ?? new L16EndianProbe()).finish());
}

/**
 * Gère chaque message du WebSocket Telnyx et retourne la session mise à jour.
 * Exporté pour la démonstration navigateur, qui parle le même protocole.
 */
export function handleTelnyxMessage(
  msg: TelnyxStreamMessage,
  callId: string,
  socket: WebSocket,
  mgr: CallSessionManager,
): CallSession | undefined {
  switch (msg.event) {
    case 'connected':
      logger.info({ callId }, '[stream] Telnyx connected');
      return;

    case 'start': {
      const start = msg.start!;
      const llmRuntime = getVoiceLlmRuntimeInfo();
      writeDebugLog(`[stream] Received start event for call ${start.call_control_id}`);
      logger.info(
        {
          callId: start.call_control_id,
          hasCaller: Boolean(start.from),
          encoding: start.media_format.encoding,
          llmProvider: llmRuntime.provider,
          llmModel: llmRuntime.model,
          openrouterKeyConfigured: llmRuntime.openrouterKeyConfigured,
          openrouterUsed: llmRuntime.openrouterUsed,
        },
        '[stream] Start call',
      );

      const session = mgr.get(start.call_control_id);
      if (!session) {
        writeDebugLog(`[stream] No session found for ${start.call_control_id}`);
        logger.warn({ callId: start.call_control_id }, '[stream] No session found for start event');
        return;
      }

      if (session.codec === 'L16') {
        session.l16MediaFormat = {
          encoding: start.media_format.encoding,
          sample_rate: start.media_format.sample_rate,
          channels: start.media_format.channels,
        };
      }

      // Les journaux portent le callControlId, la base le callSid : cette ligne les relie pour le rapport
      // automatique de l'appel (call-report). Journal seul, sans effet sur l'appel.
      logger.info(
        { callId: session.callControlId, callLegId: session.callLegId },
        '[voice-report] call linked',
      );

      resolveVoiceFeatureSnapshot(session);

      // Assigner le WebSocket Telnyx à la session (manquant — cause du silence)
      session.telnyxWs = socket;

      // Le provider STT est résolu une seule fois à l'ouverture du Media Stream.
      session.onSttEvent = (event: SttEvent) => handleSttEvent(event, session, mgr);
      connectStt(session)
        .then(() => {
          const provider = sttProviderId(session);
          writeDebugLog(`[stream] STT (${provider}) ready for ${start.call_control_id}`);
          logger.info({ callId: start.call_control_id, provider }, '[stream] STT ready');
        })
        .catch((err) => {
          const provider = sttProviderId(session);
          writeDebugLog(`[stream] STT (${provider}) failed to connect`, err);
          logger.error(
            { err, callId: start.call_control_id, provider },
            `[stream] STT failed to connect: ${(err as Error).message}`,
          );
          captureException(err as Error, {
            tags: { service: 'handler', action: 'elevenlabs-ready' },
            extra: { callId: start.call_control_id },
          });
        });

      // Jouer le message d'accueil immédiatement (ne dépend pas de ElevenLabs)
      const restaurantName = extractRestaurantName(session.systemPrompt);

      const fixedGreeting = buildInitialGreeting(restaurantName, session.timezone);
      const greetingPromise: Promise<string> = Promise.resolve(fixedGreeting);
      // Avant l'accueil : l'audio de l'appelant doit être nettoyé dès ses premiers mots.
      // Démonstration navigateur : pas de leg Telnyx, donc ni suppression de bruit ni enregistrement.
      if (!session.demo) {
        startNoiseSuppression(session).catch(() => undefined); // ne lève jamais ; garde-fou seulement
      }
      session.greetingText = fixedGreeting;
      session.greetingPlaying = true;
      // Dès le décroché : l'accueil et ses interruptions doivent figurer dans l'enregistrement.
      if (!session.demo) {
        startTestCallRecording(session).catch((err) => {
          logger.error(
            { err, callId: session.callControlId },
            '[stream] Failed to start test call recording',
          );
          captureException(err as Error, {
            tags: { service: 'handler', action: 'test-recording-start' },
            extra: { callId: session.callControlId },
          });
        });
      }
      mgr.transition(session, 'SPEAKING');
      greetingPromise
        .then((greeting) => {
          session.greetingText = greeting;
          writeDebugLog(`[stream] Speaking greeting: "${greeting}"`);
          return speakTtsStreamed(session, greeting);
        })
        .then(async () => {
          writeDebugLog(`[stream] Greeting spoken successfully, transitioning to LISTENING`);
          session.greetingPlaying = false;
          mgr.transition(session, 'LISTENING');
        })
        .catch((err) => {
          writeDebugLog(`[stream] Greeting TTS failed`, err);
          logger.error(
            { err, callId: session.callControlId },
            '[stream] Initial greeting TTS failed',
          );
          captureException(err, {
            tags: { service: 'handler', action: 'greeting-tts' },
            extra: { callId: session.callControlId },
          });
          session.greetingPlaying = false;
          mgr.transition(session, 'LISTENING');
        });

      return session;
    }

    case 'mark': {
      const session = mgr.get(callId);
      if (session && msg.mark) acknowledgeCallEnding(session, msg.mark.name);
      return session;
    }

    case 'media': {
      const payload = msg.media?.payload;
      if (!payload) return;

      // Le flux demandé à Telnyx est inbound_track. Cette garde évite qu'une
      // future modification du stream ne renvoie l'audio TTS sortant à la reconnaissance
      // et ne crée des faux transcripts/interruptions par écho.
      const track = msg.media?.track;
      if (track && track !== 'inbound' && track !== 'inbound_track') {
        return;
      }

      const session = mgr.get(callId);
      if (!session || session.ended || session.ending) return session;

      // Sonde de bande large sur les premières secondes de parole du client.
      trackL16Endian(session, payload);
      trackWideband(session, payload);

      // Forwarder l'audio à ElevenLabs
      sendAudioToStt(session, payload);

      return session;
    }

    case 'stop': {
      logger.info({ callId }, '[stream] Telnyx stream stop');
      const session = mgr.get(callId);
      if (session) {
        logAudioOutSummary(session);
        finishL16Endian(session);
        finishWideband(session);
        session.ended = true;
        session.state = 'IDLE';
        session.isSpeaking = false;
        persistLatencyTrace(session).catch((err) =>
          logger.error({ err, callId }, '[stream] persistLatencyTrace failed'),
        );
        persistSttCall(session).catch((err) =>
          logger.error({ err, callId }, '[stream] persistSttCall failed'),
        );
        finalizeVoiceUsage(session).catch((err) =>
          logger.error({ err, callId }, '[stream] finalizeVoiceUsage failed'),
        );
        closeStt(session);
        mgr.delete(session.callControlId);
      }
      return;
    }

    case 'dtmf':
      return;

    case 'error':
      logger.error({ callId, msg }, '[stream] Telnyx error event');
      const errorDetail = new Error(`Telnyx error event for call ${callId}`);
      captureException(errorDetail, {
        tags: { service: 'handler', event: 'telnyx-error' },
        extra: { callId, payload: redactPii(typeof msg === 'string' ? msg : JSON.stringify(msg)) },
      });
      return;

    default:
      return;
  }
}
