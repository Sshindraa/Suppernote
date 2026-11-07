/**
 * Logique TTS (Text-to-Speech) — Cartesia + fallback Telnyx native.
 *
 * Extrait de handler.ts. Ces fonctions prennent une CallSession en
 * paramètre et lisent son état (state, ended, telnyxWs, codec,
 * latencyTrace) ; les jalons TTS sont enregistrés par turn-telemetry.
 */

import { WebSocket } from 'ws';
import { CARTESIA_MODEL } from '@suppernote/config';
import type { CallSession } from './types';
import {
  effectiveVoiceLanguage,
  effectiveVoiceLocale,
  type VoiceLanguageCode,
} from './voice-language';
import {
  buildCartesiaCacheVariant,
  CARTESIA_NORMALIZATION,
  getCartesiaGenerationConfig,
  getCartesiaPronunciationDictId,
  getCartesiaVoiceId,
} from './cartesia-config';
import {
  buildElevenLabsCacheVariant,
  buildElevenLabsTtsRequest,
  elevenLabsTtsModel,
  elevenLabsTtsStreamingEnabled,
  elevenLabsTtsVoiceId,
  telephonyTtsProvider,
} from './elevenlabs-tts';
import { getTtsCached, setTtsCached } from '../tts-cache';
import { logger } from '../../../shared/logger/pino';
import { telnyxFetch } from '../../../shared/telnyx/http-agent';
import { captureException } from '../../../shared/sentry/client';
import { writeDebugLog } from './debug-log';
import { describeTranscript } from './pii-redact';
import { persistLatencyTrace } from './session-persistence';
import { VOICE_PROVIDER_TIMEOUT_MS, fetchWithTimeout } from '../../../shared/resilience';
import {
  CARTESIA_RETRY_DELAY_MS,
  CARTESIA_TTS_MAX_ATTEMPTS,
  TTS_INITIAL_BUFFER_FRAMES,
  TTS_UNDERFEED_PAUSE_MS,
  TTS_PACE_PAUSE_MS,
} from './constants';
import { splitTelnyxAudioFrames } from './audio-frames';
import { noteAudioDropped, noteAudioFrameSent } from './outbound-audio';
import {
  encodeTelnyxFromPcm16,
  padTelnyxFrame,
  telnyxCodecProfile,
  telnyxFrameBytes,
} from './telnyx-codec';
import {
  markVoiceTurnAudioSent,
  noteAgentAudioStarted,
  markVoiceTurnTtsSynthesisFirstByte,
  recordVoiceTurnEventIfCurrent,
} from './turn-telemetry';
import {
  voiceProviderErrorsTotal,
  voiceTtsCacheTotal,
} from '../../../shared/observability/metrics';
import {
  addCartesiaTtsCharacters,
  addElevenLabsTtsCharacters,
} from '../../usage/voice-usage.service';
import {
  recordDebugAgentSpeech,
  rememberRecentAgentSpeech,
  settleDebugSpeech,
} from './debug-dialogue';

export function isSessionActiveForTts(session: CallSession, generation?: number): boolean {
  return (
    !session.ended &&
    (session.state === 'SPEAKING' || session.state === 'CLOSING') &&
    session.telnyxWs.readyState === WebSocket.OPEN &&
    (generation === undefined || (session.ttsGeneration ?? 0) === generation)
  );
}

/** Un accueil sans cache retarde le premier son de l'appelant : on le voit dans les journaux et les métriques. */
function noteTtsCacheLookup(session: CallSession, hit: boolean): void {
  const kind = session.greetingPlaying ? 'greeting' : 'reply';
  voiceTtsCacheTotal.inc({ kind, result: hit ? 'hit' : 'miss' });
  if (kind === 'greeting' && !hit) {
    logger.warn(
      { callId: session.callControlId },
      '[greeting] cache miss: the first sound will be delayed',
    );
  }
}

function persistFirstAudioFrame(session: CallSession, turnId?: string): void {
  // Sans trace de latence (accueil, relances), l'audio part quand même : la fenêtre anti-écho s'ouvre.
  noteAgentAudioStarted(session);
  if (!session.latencyTrace || session.latencyTrace.totalE2eMs !== undefined) return;

  markVoiceTurnAudioSent(session, { ttsPath: 'http_stream', isFiller: false }, turnId);
  persistLatencyTrace(session).catch((err) =>
    logger.error(
      { err, callId: session.callControlId },
      '[speakTtsStreamed] persistLatencyTrace failed',
    ),
  );
}

/** Trames envoyées à Telnyx pour une seule réplique (dialogue de test). */
type FragmentFrameTally = { frames: number };

async function sendPacedAudioFrames(
  session: CallSession,
  audio: Buffer,
  generation?: number,
  turnId?: string,
  tally?: FragmentFrameTally,
): Promise<number> {
  const frames = splitTelnyxAudioFrames(audio, session.codec);
  let framesSent = 0;

  for (const frame of frames) {
    if (!isSessionActiveForTts(session, generation)) {
      noteAudioDropped(session, frames.length - framesSent, generation);
      break;
    }
    const encoded = encodeTelnyxFromPcm16(session.codec, frame);
    session.telnyxWs.send(
      JSON.stringify({ event: 'media', media: { payload: encoded.toString('base64') } }),
    );
    noteAudioFrameSent(session, encoded.length);
    framesSent++;
    if (tally) tally.frames++;
    persistFirstAudioFrame(session, turnId);
    await new Promise((resolve) => setTimeout(resolve, TTS_PACE_PAUSE_MS));
  }

  return framesSent;
}

/**
 * Blocs envoyés au TTS pour un texte déjà nettoyé : un seul, pour garder l'intonation.
 * Partagé avec le précache de l'accueil (greeting-cache.ts) : les clés de cache ne correspondent
 * que si les deux découpent pareil. Un découpage différent rend l'accueil muet pendant la synthèse.
 */
export function ttsSegments(cleanedText: string): string[] {
  return [addNaturalPauses(cleanedText)];
}

/**
 * Ajoute des pauses naturelles dans le texte en forçant la ponctuation.
 * Cartesia Sonic marque une pause sur les virgules et points.
 */
export function addNaturalPauses(text: string): string {
  let result = text
    .replace(/\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Forcer un point à la fin si absent
  if (!/[.!?]$/.test(result)) result += '.';

  return result;
}

/**
 * Pause de secours pour d'anciens consommateurs qui synthétisent plusieurs
 * segments. Le chemin live envoie un segment prosodique complet à Cartesia et
 * laisse Sonic déduire la pause depuis la ponctuation.
 */
export function getInterSentencePauseMs(_previousSentence: string): number {
  return 0;
}

export function cleanTextForTts(text: string, language: VoiceLanguageCode = 'fr'): string {
  let cleaned = text;

  // 1. Remove emojis
  cleaned = cleaned.replace(
    /[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}]/gu,
    '',
  );

  // 2. Remove Markdown bold/italic
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '$1');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '$1');
  cleaned = cleaned.replace(/__([^_]+)__/g, '$1');
  cleaned = cleaned.replace(/_([^_]+)_/g, '$1');

  // 3. Développe les symboles et abréviations qui sonnent artificiellement
  // lorsqu'ils sont lus littéralement par un moteur TTS.
  if (language === 'fr') {
    cleaned = cleaned
      .replace(/&/g, ' et ')
      .replace(/€/g, ' euros')
      .replace(/%/g, ' pour cent')
      .replace(/\bMme\.?\s/gi, 'Madame ')
      // Pas après « , » : dans une relecture épelée (« A, S, S, A, M, M. »), le M final est une lettre.
      .replace(/(?<!,\s?)\bM\.\s/g, 'Monsieur ');
  }

  // 4. Rend un numéro français lisible en groupes. Les virgules laissent une
  // micro-pause sans transformer le numéro en une suite de chiffres isolés.
  cleaned = cleaned.replace(
    /(?<!\d)(0[1-9])[ .-]?(\d{2})[ .-]?(\d{2})[ .-]?(\d{2})[ .-]?(\d{2})(?!\d)/g,
    '$1, $2, $3, $4, $5',
  );

  // 5. Normalise les heures pour une prononciation téléphonique fluide.
  if (language === 'fr') {
    cleaned = cleaned.replace(/\b([01]?\d|2[0-3])\s*(?:h|:)\s*([0-5]\d)\b/gi, '$1 heures $2');
    cleaned = cleaned.replace(/\b(\d+)\s*h\b/g, '$1 heures');
  }

  // 6. Space out alphanumeric codes (e.g. BB344719 -> B. B. 3. 4. 4. 7. 1. 9.)
  cleaned = cleaned.replace(/\b([A-Z0-9]{5,})\b/g, (match) => {
    if (/\d/.test(match)) {
      return match.split('').join('. ');
    }
    return match;
  });

  return cleaned.replace(/\s{2,}/g, ' ').trim();
}

export async function speakTelnyxNative(session: CallSession, text: string): Promise<void> {
  writeDebugLog(
    `[speakTelnyxNative] Sending native Telnyx TTS speak command ${JSON.stringify(describeTranscript(text))}`,
  );
  if (session.ending?.nativePlayback) return;
  // Pas de leg Telnyx en démonstration : la voix native n'existe pas, la synthèse Cartesia est la seule voie.
  if (session.demo) return;
  if (session.ending) session.ending.nativePlayback = true;
  try {
    const language = effectiveVoiceLanguage(session);
    const nativeLanguage = effectiveVoiceLocale(session);
    const res = await telnyxFetch(`/v2/calls/${session.callControlId}/actions/speak`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
      },
      body: JSON.stringify({
        payload: session.ending
          ? language === 'en'
            ? 'Goodbye, have a great day.'
            : 'Au revoir, bonne journée.'
          : text,
        voice: 'female',
        language: nativeLanguage,
        payload_type: 'text',
        ...(session.ending
          ? { client_state: Buffer.from(session.ending.markName).toString('base64') }
          : {}),
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      writeDebugLog(`[speakTelnyxNative] Telnyx native speak failed: ${res.status} ${errText}`);
    } else {
      writeDebugLog(`[speakTelnyxNative] Telnyx native speak command sent successfully`);
      settleDebugSpeech(
        recordDebugAgentSpeech(
          session,
          session.ending
            ? effectiveVoiceLanguage(session) === 'en'
              ? 'Goodbye, have a great day.'
              : 'Au revoir, bonne journée.'
            : text,
        ),
        1,
        true,
      );
    }
  } catch (err: unknown) {
    writeDebugLog(`[speakTelnyxNative] Error in Telnyx native speak`, err);
  }
}

/**
 * Met un fragment TTS dans la file de lecture de l'appel.
 *
 * Le LLM stream peut livrer la phrase suivante pendant que Cartesia lit la
 * précédente. Sans cette file, les deux producteurs écrivent simultanément
 * sur le Media Stream Telnyx et la voix devient inintelligible. La tâche
 * suivante vérifie l'état de session à son démarrage : un barge-in annule
 * donc naturellement les fragments encore en attente.
 */
export async function speakTtsStreamed(session: CallSession, text: string): Promise<void> {
  const debugEntry = recordDebugAgentSpeech(session, text);
  const previousPlayback = session.ttsPlayback ?? Promise.resolve();
  const generation = session.ttsGeneration ?? 0;
  const turnId = session.currentTurn?.id;
  const playback = previousPlayback
    .catch((err: unknown) => {
      logger.warn(
        { err, callId: session.callControlId },
        '[speakTtsStreamed] Previous queued TTS playback failed',
      );
    })
    .then(async () => {
      // Compteur propre à ce fragment : un filler joué en parallèle ne s'y ajoute pas.
      const tally: FragmentFrameTally = { frames: 0 };
      let completed = false;
      try {
        await speakTtsFragment(session, text, generation, turnId, tally);
        completed = isSessionActiveForTts(session, generation);
      } finally {
        settleDebugSpeech(debugEntry, tally.frames, completed);
      }
    });

  // Conserver une chaîne résiliente : une erreur d'un fragment ne doit pas
  // empêcher les suivants d'être prononcés.
  session.ttsPlayback = playback.catch(() => undefined);
  return playback;
}

/**
 * Découpe un fragment en phrases et consomme le stream HTTP de Cartesia.
 * Cette fonction est appelée exclusivement via {@link speakTtsStreamed}.
 */
async function speakTtsFragment(
  session: CallSession,
  text: string,
  generation: number,
  turnId?: string,
  tally: FragmentFrameTally = { frames: 0 },
): Promise<void> {
  const language = effectiveVoiceLanguage(session);
  const cleanedText = cleanTextForTts(text, language);
  if (!cleanedText) return;
  if (!isSessionActiveForTts(session, generation)) {
    writeDebugLog(
      `[speakTtsStreamed] Session inactive, state=${session.state}, ended=${session.ended}, skipping synthesis`,
    );
    return;
  }

  writeDebugLog(
    `[speakTtsStreamed] Starting synthesis ${JSON.stringify(describeTranscript(cleanedText))}`,
  );
  // Ce que l'agent dit doit pouvoir être reconnu s'il revient par l'écho de l'appelant.
  rememberRecentAgentSpeech(session, cleanedText);
  const synthesisStartedAt = Date.now();
  recordVoiceTurnEventIfCurrent(session, turnId, 'tts_synthesis_started', {
    source: 'http_stream',
    characterCount: cleanedText.length,
  });

  // Profil du codec Telnyx : PCMA/PCMU (G.711 8 kHz) ou L16 (PCM16 16 kHz).
  const codecProfile = telnyxCodecProfile(session.codec);
  // Synthétiser la réponse complète conserve l'intonation entre les phrases.
  // Le contexte WebSocket applique la même continuité aux fragments LLM ; ce
  // chemin HTTP reste un fallback sans reset de prosodie local.
  const sentences = ttsSegments(cleanedText);

  writeDebugLog('[speakTtsStreamed] Synthesizing one prosodic segment');

  const provider = telephonyTtsProvider();
  // Libellés de logs et de Sentry : identiques à ceux d'avant la bascule pour Cartesia.
  const providerLabel = provider === 'elevenlabs' ? 'ElevenLabs' : 'Cartesia';
  const apiKey =
    provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : process.env.CARTESIA_API_KEY;
  const voiceId = provider === 'elevenlabs' ? elevenLabsTtsVoiceId() : getCartesiaVoiceId(session);
  if (!apiKey || !voiceId) {
    await speakTelnyxNative(
      session,
      language === 'en'
        ? 'Sorry, I am having a technical issue. Could you please repeat that?'
        : 'Désolé, je rencontre une petite difficulté technique. Pouvez-vous répéter ?',
    );
    recordVoiceTurnEventIfCurrent(session, turnId, 'tts_synthesis_completed', {
      source: 'native_fallback',
      durationMs: Date.now() - synthesisStartedAt,
    });
    recordVoiceTurnEventIfCurrent(session, turnId, 'tts_completed', {
      source: 'native_fallback',
      durationMs: Date.now() - synthesisStartedAt,
    });
    return;
  }

  // Clé de cache distincte par codec Telnyx (PCMA vs PCMU) — un buffer 24k pcm
  // n'est PAS réutilisable en 8k alaw. Inclure le format garantit l'invalidation
  // des anciens caches après migration 24k→8k.
  // Le modèle fait partie de la clé : l'alias continu invalide les buffers
  // quand Cartesia publie un nouveau snapshot stable.
  const locale = effectiveVoiceLocale(session);
  const generationConfig = getCartesiaGenerationConfig(session);
  const pronunciationDictId = getCartesiaPronunciationDictId(session);
  const cacheVoiceId =
    provider === 'elevenlabs'
      ? buildElevenLabsCacheVariant({
          voiceId,
          model: elevenLabsTtsModel(),
          locale,
          codec: codecProfile.label,
        })
      : buildCartesiaCacheVariant({
          voiceId,
          locale,
          codec: codecProfile.label,
          generationConfig,
          pronunciationDictId,
        });

  // ─── Traitement séquentiel d'un segment prosodique ──────────────────
  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i];
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    if (!isSessionActiveForTts(session, generation)) {
      writeDebugLog(`[speakTtsStreamed] Session inactive before sentence ${i}, stopping`);
      break;
    }

    // 1. Tenter le cache
    let cachedBuffer: Buffer | null = null;
    try {
      cachedBuffer = await getTtsCached(trimmed, cacheVoiceId);
    } catch (err: unknown) {
      writeDebugLog(`[speakTtsStreamed] TTS cache read failed`, err);
    }

    noteTtsCacheLookup(session, cachedBuffer !== null);
    if (cachedBuffer) {
      writeDebugLog(`[speakTtsStreamed] Cache HIT ${JSON.stringify(describeTranscript(trimmed))}`);
      markVoiceTurnTtsSynthesisFirstByte(session, 'cache', turnId);

      const framesSent = await sendPacedAudioFrames(
        session,
        cachedBuffer,
        generation,
        turnId,
        tally,
      );
      writeDebugLog(
        `[speakTtsStreamed] Sent ${framesSent} cached audio frames to Telnyx for sentence ${i}`,
      );
      recordVoiceTurnEventIfCurrent(session, turnId, 'tts_synthesis_completed', {
        source: 'cache',
        durationMs: Date.now() - synthesisStartedAt,
      });
      recordVoiceTurnEventIfCurrent(session, turnId, 'tts_completed', {
        source: 'cache',
        durationMs: Date.now() - synthesisStartedAt,
      });
      continue;
    }

    // 2. Cache MISS ➔ Requête de streaming à Cartesia (avec 1 retry)
    writeDebugLog(
      `[speakTtsStreamed] Cache MISS. Streaming from Cartesia for sentence: "${trimmed}"`,
    );
    try {
      // Demander directement à Cartesia le format compatible Telnyx Media Stream
      // (G.711 alaw/mulaw 8kHz) → supprime le downsampling applicatif 24k→8k
      // et économise ~30% CPU sur le VPS.
      const cartesiaBody = JSON.stringify({
        model_id: CARTESIA_MODEL,
        transcript: trimmed,
        voice: { mode: 'id', id: voiceId },
        locale,
        normalization: CARTESIA_NORMALIZATION,
        ...(generationConfig ? { generation_config: generationConfig } : {}),
        ...(pronunciationDictId ? { pronunciation_dict_id: pronunciationDictId } : {}),
        output_format: {
          container: 'raw',
          encoding: codecProfile.cartesiaEncoding,
          sample_rate: codecProfile.sampleRate,
        },
      });

      // Requête du fournisseur choisi : Cartesia par défaut, ElevenLabs si VOICE_TTS_PROVIDER=elevenlabs.
      const ttsRequest =
        provider === 'elevenlabs'
          ? buildElevenLabsTtsRequest({
              apiKey,
              voiceId,
              model: elevenLabsTtsModel(),
              text: trimmed,
              locale,
              codec: codecProfile.label,
              streaming: elevenLabsTtsStreamingEnabled(),
            })
          : {
              url: 'https://api.cartesia.ai/tts/bytes',
              headers: {
                'Cartesia-Version': '2026-03-01',
                'X-API-Key': apiKey,
                'Content-Type': 'application/json',
              },
              body: cartesiaBody,
            };

      let response: Response | null = null;
      for (let attempt = 0; attempt < CARTESIA_TTS_MAX_ATTEMPTS; attempt++) {
        try {
          // R1-2 : chaque tentative est bornée. Sans timeout, une socket
          // fournisseur qui ne répond plus laissait l'appel muet jusqu'à la mort
          // de la connexion, sans jamais déclencher la dégradation ci-dessous.
          response = await fetchWithTimeout(
            ttsRequest.url,
            { method: 'POST', headers: ttsRequest.headers, body: ttsRequest.body },
            VOICE_PROVIDER_TIMEOUT_MS,
          );
        } catch {
          writeDebugLog(`[speakTtsStreamed] ${providerLabel} timeout (tentative ${attempt + 1})`);
          voiceProviderErrorsTotal.inc({ provider, type: 'timeout' });
          response = null;
          if (attempt === 0) {
            await new Promise((r) => setTimeout(r, CARTESIA_RETRY_DELAY_MS));
            continue;
          }
          break;
        }
        if (response.ok) break;
        if (attempt === 0 && (response.status >= 500 || response.status === 429)) {
          writeDebugLog(
            `[speakTtsStreamed] Cartesia ${response.status}, retrying in ${CARTESIA_RETRY_DELAY_MS}ms...`,
          );
          await new Promise((r) => setTimeout(r, CARTESIA_RETRY_DELAY_MS));
          continue;
        }
        break; // 4xx non-retryable ou 2e échec
      }

      if (!response || !response.ok) {
        const status = response?.status ?? 0;
        writeDebugLog(`[speakTtsStreamed] ${providerLabel} stream failed after retry: ${status}`);
        logger.error(
          { callId: session.callControlId, status, provider },
          `[speakTtsStreamed] ${providerLabel} stream failed after retry`,
        );
        voiceProviderErrorsTotal.inc({
          provider,
          type: status === 429 ? '429' : '5xx',
        });
        const err = new Error(`${providerLabel} stream failed with status ${status}`);
        captureException(err, {
          tags: { service: 'handler', action: 'speakTtsStreamed', type: 'http-status' },
          extra: { callId: session.callControlId, status, ...describeTranscript(trimmed) },
        });
        if (!isSessionActiveForTts(session, generation)) return;
        await speakTelnyxNative(
          session,
          language === 'en'
            ? 'Sorry, I am having a technical issue. Could you please repeat that?'
            : 'Désolé, je rencontre une petite difficulté technique. Pouvez-vous répéter ?',
        );
        continue;
      }

      // Un cache hit ne déclenche aucun appel fournisseur. Ici, la réponse
      // du fournisseur a été acceptée : ses caractères deviennent facturables
      // même si le body de streaming est ensuite vide ou interrompu.
      if (provider === 'elevenlabs') addElevenLabsTtsCharacters(session, trimmed.length);
      else addCartesiaTtsCharacters(session, trimmed.length);

      if (!response.body) {
        writeDebugLog(`[speakTtsStreamed] Cartesia stream body is null`);
        continue;
      }

      const reader = response.body.getReader();
      const playbackQueue: Buffer[] = [];
      let streamFinished = false;
      let firstByteReceived = false;

      // Background playback loop (Consumer). It waits for a 100 ms jitter
      // buffer, then sends 100 ms G.711 frames at real time.
      const playPromise = (async () => {
        let framesSent = 0;
        let playbackStarted = false;
        while (true) {
          if (!isSessionActiveForTts(session, generation)) {
            writeDebugLog(`[speakTtsStreamed] Session inactive during stream playback, stopping`);
            noteAudioDropped(session, playbackQueue.length, generation);
            break;
          }

          if (
            !playbackStarted &&
            !streamFinished &&
            playbackQueue.length < TTS_INITIAL_BUFFER_FRAMES
          ) {
            await new Promise((r) => setTimeout(r, TTS_UNDERFEED_PAUSE_MS));
            continue;
          }
          playbackStarted = true;

          if (playbackQueue.length === 0) {
            if (streamFinished) {
              break; // Tout est lu
            }
            await new Promise((r) => setTimeout(r, TTS_UNDERFEED_PAUSE_MS)); // Sous-alimentation temporaire, attendre
            continue;
          }

          const frame = playbackQueue.shift()!;
          const encoded = encodeTelnyxFromPcm16(session.codec, frame);
          session.telnyxWs.send(
            JSON.stringify({ event: 'media', media: { payload: encoded.toString('base64') } }),
          );
          noteAudioFrameSent(session, encoded.length);
          framesSent++;
          tally.frames++;
          persistFirstAudioFrame(session, turnId);

          await new Promise((r) => setTimeout(r, TTS_PACE_PAUSE_MS));
        }
        writeDebugLog(
          `[speakTtsStreamed] Paced player sent ${framesSent} audio frames for sentence ${i}`,
        );
      })();

      // Streaming bytes reader (Producer) — audio G.711 8kHz, 1 byte = 1 sample.
      // 160 bytes = 20ms d'audio.
      let remainingBytes = Buffer.alloc(0);
      const accumulatedChunks: Buffer[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          streamFinished = true;
          break;
        }

        if (!firstByteReceived) {
          firstByteReceived = true;
          writeDebugLog(`[speakTtsStreamed] First Cartesia byte received for sentence ${i}`);
          markVoiceTurnTtsSynthesisFirstByte(session, `${provider}_http`, turnId);
        }

        const rawChunk = Buffer.from(value);
        accumulatedChunks.push(rawChunk);

        const fullBytes = Buffer.concat([remainingBytes, rawChunk]);

        // Découpe en trames de 100 ms selon le codec (800 octets en G.711,
        // 3200 octets en L16).
        const frameBytes = telnyxFrameBytes(session.codec);
        let offset = 0;
        while (offset + frameBytes <= fullBytes.length) {
          playbackQueue.push(fullBytes.slice(offset, offset + frameBytes));
          offset += frameBytes;
        }
        remainingBytes = fullBytes.slice(offset);
      }

      // Flush final — pad avec le silence du codec pour garder une trame de 100 ms.
      if (remainingBytes.length > 0) {
        playbackQueue.push(
          padTelnyxFrame(session.codec, remainingBytes, telnyxFrameBytes(session.codec)),
        );
      }

      streamFinished = true;
      await playPromise; // Attendre la fin de la lecture progressive
      recordVoiceTurnEventIfCurrent(session, turnId, 'tts_synthesis_completed', {
        source: `${provider}_http`,
        durationMs: Date.now() - synthesisStartedAt,
      });
      recordVoiceTurnEventIfCurrent(session, turnId, 'tts_completed', {
        source: `${provider}_http`,
        durationMs: Date.now() - synthesisStartedAt,
      });

      // 3. Mettre en cache Redis le buffer G.711 8kHz complet
      const codec8kFull = Buffer.concat(accumulatedChunks);
      try {
        await setTtsCached(trimmed, cacheVoiceId, codec8kFull);
      } catch (err: unknown) {
        writeDebugLog(`[speakTtsStreamed] TTS cache write failed`, err);
      }
    } catch (err: unknown) {
      writeDebugLog(
        `[speakTtsStreamed] Cartesia stream process error for sentence: "${trimmed}"`,
        err,
      );
      logger.error(
        { err, callId: session.callControlId },
        `[speakTtsStreamed] Cartesia stream process error: ${err instanceof Error ? err.message : String(err)}`,
      );
      voiceProviderErrorsTotal.inc({ provider: 'cartesia', type: 'ws_error' });
      captureException(err, {
        tags: { service: 'handler', action: 'speakTtsStreamed', type: 'exception' },
        extra: { callId: session.callControlId, ...describeTranscript(trimmed) },
      });
      recordVoiceTurnEventIfCurrent(session, turnId, 'tts_interrupted', {
        reason: isSessionActiveForTts(session, generation) ? 'error' : 'barge_in',
        ttsPath: 'http_stream',
      });
      if (!isSessionActiveForTts(session, generation)) return;
      await speakTelnyxNative(
        session,
        language === 'en'
          ? 'Sorry, I am having a technical issue. Could you please repeat that?'
          : 'Désolé, je rencontre une petite difficulté technique. Pouvez-vous répéter ?',
      );
    }
  }
}
