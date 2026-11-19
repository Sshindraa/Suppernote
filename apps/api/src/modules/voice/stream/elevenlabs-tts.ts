import { CARTESIA_MODEL } from '@suppernote/config';

/**
 * Synthèse vocale ElevenLabs pour le téléphone (chemin HTTP, un segment par requête).
 *
 * Bascule depuis Cartesia : `VOICE_TTS_PROVIDER=elevenlabs`. ElevenLabs produit nativement
 * le G.711 et le PCM16 demandés par Telnyx : aucun transcodage, les octets reçus se mettent
 * en cache et se jouent exactement comme ceux de Cartesia. Cartesia reste le défaut.
 *
 * Par défaut, le point de synthèse classique renvoie l'audio d'un segment d'un bloc.
 * `ELEVENLABS_TTS_STREAMING=true` passe sur `/stream`, dont le premier octet arrive plus tôt.
 * Même corps, mêmes en-têtes, même format : seule l'URL change.
 */

export const ELEVENLABS_TTS_ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';
export const DEFAULT_ELEVENLABS_TTS_MODEL = 'eleven_v4_turbo';

export type TelephonyTtsProvider = 'cartesia' | 'elevenlabs';

/** Fournisseur TTS du téléphone. Cartesia tant que la variable n'est pas `elevenlabs`. */
export function telephonyTtsProvider(): TelephonyTtsProvider {
  return process.env.VOICE_TTS_PROVIDER === 'elevenlabs' ? 'elevenlabs' : 'cartesia';
}

/**
 * Phrases hors tour (secours, au revoir) : ElevenLabs dès que sa clé est présente, comme les tours normaux
 * (décision du 16/10 : ElevenLabs seulement). Sans clé, le fournisseur téléphone habituel.
 */
export function offTurnTtsProvider(env: NodeJS.ProcessEnv = process.env): TelephonyTtsProvider {
  return env.ELEVENLABS_API_KEY?.trim() ? 'elevenlabs' : telephonyTtsProvider();
}

/**
 * Étiquette fournisseur + modèle écrite sur l'appel (`calls.tts_provider`), par ex. `elevenlabs-eleven_v4_turbo`.
 * Toute autre valeur (`telnyx-native`) est rendue telle quelle.
 */
export function ttsProviderWithModel(provider: string): string {
  if (provider === 'elevenlabs') return `elevenlabs-${elevenLabsTtsModel()}`;
  if (provider === 'cartesia') return `cartesia-${CARTESIA_MODEL}`;
  return provider;
}

/** Synthèse en flux (`/stream`) pour le téléphone. Désactivée tant que la variable n'est pas exactement `true`. */
export function elevenLabsTtsStreamingEnabled(): boolean {
  return process.env.ELEVENLABS_TTS_STREAMING === 'true';
}

export function elevenLabsTtsModel(): string {
  return process.env.ELEVENLABS_TTS_MODEL?.trim() || DEFAULT_ELEVENLABS_TTS_MODEL;
}

/** Voix ElevenLabs utilisée pour tous les appels (pas encore de voix par restaurant). */
export function elevenLabsTtsVoiceId(): string | null {
  return process.env.ELEVENLABS_TTS_VOICE_ID?.trim() || null;
}

/** Format de sortie natif ElevenLabs pour l'étiquette du profil Telnyx (`alaw8k`, `mulaw8k`, `pcm16k`). */
export function elevenLabsOutputFormat(codecLabel: string): string {
  switch (codecLabel) {
    case 'alaw8k':
      return 'alaw_8000';
    case 'mulaw8k':
      return 'ulaw_8000';
    case 'pcm16k':
      return 'pcm_16000';
    default:
      throw new Error(`Format ElevenLabs inconnu pour le codec ${codecLabel}`);
  }
}

/** Code langue ISO 639-1 attendu par ElevenLabs, dérivé de la locale (fr-FR → fr). */
export function elevenLabsLanguageCode(locale: string): string {
  const language = locale.split('-')[0]?.toLowerCase() ?? '';
  return /^[a-z]{2}$/.test(language) ? language : 'fr';
}

/**
 * Clé de cache des segments ElevenLabs. Elle commence par `elevenlabs|` : un buffer Cartesia
 * et un buffer ElevenLabs ne peuvent jamais se répondre, même pour la même phrase et le même codec.
 */
export function buildElevenLabsCacheVariant(options: {
  voiceId: string;
  model: string;
  locale: string;
  codec: string;
}): string {
  return [
    'elevenlabs',
    options.voiceId,
    options.model,
    elevenLabsLanguageCode(options.locale),
    options.codec,
  ].join('|');
}

export interface ElevenLabsTtsRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Requête HTTP de synthèse d'un segment. La clé d'API n'apparaît que dans l'en-tête. */
export function buildElevenLabsTtsRequest(options: {
  apiKey: string;
  voiceId: string;
  model: string;
  text: string;
  locale: string;
  codec: string;
  /** `true` : point de synthèse en flux (`/stream`), même corps et mêmes en-têtes. */
  streaming?: boolean;
}): ElevenLabsTtsRequest {
  const outputFormat = elevenLabsOutputFormat(options.codec);
  const voice = encodeURIComponent(options.voiceId);
  const path = options.streaming ? `${voice}/stream` : voice;
  return {
    url: `${ELEVENLABS_TTS_ENDPOINT}/${path}?output_format=${outputFormat}`,
    headers: {
      'xi-api-key': options.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text: options.text,
      model_id: options.model,
      language_code: elevenLabsLanguageCode(options.locale),
      apply_text_normalization: 'on',
    }),
  };
}
