/**
 * Pré-génération des greetings audio par restaurant au boot.
 *
 * Le greeting "Bonjour, ici {restaurant}, je suis Léa, l'assistante IA. Je vous écoute." est la
 * première
 * chose que le client entend. Sans cache, il faut ~400-800ms pour le
 * synthétiser via Cartesia au premier appel. En pré-générant au boot et en
 * cachant dans Redis (via le TTS cache existant), le greeting devient un
 * cache hit instantané (~2ms lookup Redis).
 *
 * Stratégie :
 * 1. Au boot, charger tous les restaurants actifs depuis la DB
 * 2. Pour chaque restaurant, appliquer le même pipeline que speakTtsStreamed
 *    (cleanTextForTts → ttsSegments, partagé)
 * 3. Pour chaque phrase, générer l'audio via Cartesia et cacher dans Redis
 *    via setTtsCached (même cache que le TTS runtime)
 * 4. Au runtime, speakTtsStreamed trouve un cache hit pour chaque phrase
 *    → playback immédiat (~2ms Redis lookup vs ~400-800ms Cartesia synthesis)
 *
 * IMPORTANT : Le pipeline de transformation du texte (clean + pauses + split)
 * doit être identique à celui de speakTtsStreamed, sinon les clés de cache
 * ne correspondront pas.
 */
import { db } from '../../../shared/db/client';
import { logger } from '../../../shared/logger/pino';
import { getTtsCached, setTtsCached } from '../tts-cache';
import { cleanTextForTts, ttsSegments } from './tts-handler';
import { CARTESIA_MODEL, DEFAULT_CARTESIA_VOICE_ID } from '@suppernote/config';
import { buildCartesiaCacheVariant, CARTESIA_NORMALIZATION } from './cartesia-config';
import {
  buildElevenLabsCacheVariant,
  buildElevenLabsTtsRequest,
  elevenLabsTtsModel,
  elevenLabsTtsVoiceId,
  telephonyTtsProvider,
} from './elevenlabs-tts';
import { getTelnyxCodec, telnyxCodecProfile, type TelnyxCodecProfile } from './telnyx-codec';

/** Profil codec Telnyx courant : PCMA par défaut, L16 si le flag est actif. */
function greetingCodecProfile(): TelnyxCodecProfile {
  return telnyxCodecProfile(getTelnyxCodec());
}
import { normalizeVoiceLocale } from './voice-language';
import { buildFixedGreeting } from '../agent-identity';
import { hasStyledGreeting, resolveStyledGreeting } from './styled-greeting';

/**
 * Construit le texte du greeting pour un restaurant.
 * Doit être identique à buildInitialGreeting dans handler.ts.
 * L'appelant est informé dès le décroché qu'il parle à une IA (règlement européen sur l'IA,
 * article 50, applicable depuis le 2 août 2026).
 */
export function buildGreetingText(restaurantName: string): string {
  return buildFixedGreeting(restaurantName);
}

/**
 * Génère une phrase via Cartesia TTS (format PCMA 8kHz, compatible Telnyx).
 * Utilise l'endpoint /tts/bytes (HTTP, non-streaming) pour simplicité.
 *
 * Retry automatique sur 429 (concurrency limit free tier = 2) avec backoff
 * exponentiel : 500ms, 1000ms, 2000ms.
 */
async function generateSentenceAudio(text: string, voiceId: string): Promise<Buffer> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const request =
      telephonyTtsProvider() === 'elevenlabs'
        ? buildElevenLabsTtsRequest({
            apiKey: process.env.ELEVENLABS_API_KEY ?? '',
            voiceId,
            model: elevenLabsTtsModel(),
            text,
            locale: 'fr-FR',
            codec: greetingCodecProfile().label,
          })
        : {
            url: 'https://api.cartesia.ai/tts/bytes',
            headers: {
              'Cartesia-Version': '2026-03-01',
              'X-API-Key': process.env.CARTESIA_API_KEY ?? '',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model_id: CARTESIA_MODEL,
              transcript: text,
              voice: { mode: 'id', id: voiceId },
              locale: normalizeVoiceLocale('fr-FR') ?? 'fr-FR',
              normalization: CARTESIA_NORMALIZATION,
              output_format: {
                container: 'raw',
                encoding: greetingCodecProfile().cartesiaEncoding,
                sample_rate: greetingCodecProfile().sampleRate,
              },
            }),
          };
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    });

    if (response.ok) {
      return Buffer.from(await response.arrayBuffer());
    }

    // 429 = concurrency limit — retry avec backoff
    if (response.status === 429 && attempt < maxRetries) {
      await response.text().catch(() => {});
      const delayMs = 500 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }

    throw new Error(`Cartesia TTS ${response.status}: ${await response.text()}`);
  }
  throw new Error('Cartesia TTS: max retries exceeded');
}

/**
 * Pré-génère les greetings pour tous les restaurants actifs.
 * Fire-and-forget depuis main.ts — ne bloque pas l'API.
 *
 * @param restaurantNames Liste optionnelle pour tests. En prod, charge depuis la DB.
 */
export async function initGreetingCache(restaurantNames?: string[]): Promise<void> {
  const provider = telephonyTtsProvider();
  const apiKey =
    provider === 'elevenlabs' ? process.env.ELEVENLABS_API_KEY : process.env.CARTESIA_API_KEY;
  if (!apiKey) {
    logger.warn(
      `[greetings] No ${provider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'CARTESIA_API_KEY'} — greetings will not be pre-cached`,
    );
    return;
  }

  const voiceId =
    provider === 'elevenlabs'
      ? elevenLabsTtsVoiceId()
      : (process.env.CARTESIA_VOICE_ID ?? DEFAULT_CARTESIA_VOICE_ID);
  if (!voiceId) {
    const voiceEnv = provider === 'elevenlabs' ? 'ELEVENLABS_TTS_VOICE_ID' : 'CARTESIA_VOICE_ID';
    logger.warn(`[greetings] No ${voiceEnv} — greetings will not be pre-cached`);
    return;
  }
  // Clé de cache identique à celle utilisée par speakTtsStreamed (même fournisseur, même
  // modèle, même codec) : le modèle fait partie de la clé pour invalider les greetings
  // lorsque le fournisseur publie un nouveau snapshot.
  const cacheVoiceId =
    provider === 'elevenlabs'
      ? buildElevenLabsCacheVariant({
          voiceId,
          model: elevenLabsTtsModel(),
          locale: normalizeVoiceLocale('fr-FR') ?? 'fr-FR',
          codec: greetingCodecProfile().label,
        })
      : buildCartesiaCacheVariant({
          voiceId,
          locale: normalizeVoiceLocale('fr-FR') ?? 'fr-FR',
          codec: greetingCodecProfile().label,
        });

  // Textes à préparer : l'accueil fixe de chaque restaurant, plus l'accueil composé quand son style
  // n'est pas le défaut (c'est lui que l'appelant entend). Nom fourni : tests uniquement.
  const texts = new Map<string, string>(); // texte -> restaurant (journaux)
  if (restaurantNames) {
    for (const name of restaurantNames) texts.set(buildGreetingText(name), name);
  } else {
    try {
      // Seuls les restaurants dont le numéro est attribué reçoivent des appels (PENDING = pas encore).
      const restaurants = await db.restaurant.findMany({
        where: { provisioningStatus: { not: 'PENDING' } },
        select: { name: true, personality: { select: { profileType: true, fillerStyle: true } } },
      });
      for (const r of restaurants) {
        if (!r.name) continue;
        texts.set(buildGreetingText(r.name), r.name);
        const style = r.personality;
        if (!style || !hasStyledGreeting(style)) continue;
        // Compose (ou relit, en prolongeant sa durée de vie) le texte ; échec = l'accueil fixe suffit.
        const styled = await resolveStyledGreeting(r.name, style, {
          attempts: 2,
          timeoutMs: 4_000,
        }).catch(() => null);
        if (styled) texts.set(styled, r.name);
      }
    } catch (err) {
      logger.warn({ err }, '[greetings] Failed to load restaurants from DB');
      return;
    }
  }

  if (texts.size === 0) {
    logger.info('[greetings] No restaurants found — skipping greeting pre-cache');
    return;
  }

  let cached = 0;
  let skipped = 0;
  let failed = 0;

  for (const [greetingText, name] of texts) {
    // Reproduire le même pipeline que speakTtsStreamed :
    // cleanTextForTts → ttsSegments (le même découpage, sinon aucune clé ne correspond)
    const sentences = ttsSegments(cleanTextForTts(greetingText));

    for (const sentence of sentences) {
      // Vérifier si déjà en cache (évite de régénérer au restart)
      try {
        const existing = await getTtsCached(sentence, cacheVoiceId);
        if (existing) {
          skipped++;
          continue;
        }
      } catch {
        // Redis error — on continue et on génère
      }

      // Générer via Cartesia
      try {
        const audio = await generateSentenceAudio(sentence, voiceId);
        await setTtsCached(sentence, cacheVoiceId, audio);
        cached++;
      } catch (err) {
        logger.warn(
          { err, restaurant: name, sentence },
          '[greetings] Generation failed (non-blocking)',
        );
        failed++;
      }
    }
  }

  logger.info(
    `[greetings] Pre-cache: ${cached} generated, ${skipped} already cached, ${failed} failed (${texts.size} accueils)`,
  );
}
