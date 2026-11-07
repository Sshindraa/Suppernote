import crypto from 'crypto';
import { redisCache } from '../../shared/redis/client';
import { TTS_CACHE_TTL_SECONDS, TTS_CACHE_MIN_LENGTH } from '@suppernote/config';

function cacheKey(text: string, voiceId: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(text + '|' + voiceId)
    .digest('hex')
    .slice(0, 16);
  return `tts:${hash}`;
}

export async function getTtsCached(text: string, voiceId: string): Promise<Buffer | null> {
  if (text.length < TTS_CACHE_MIN_LENGTH) return null;
  const key = cacheKey(text, voiceId);
  const raw = await redisCache.getBuffer(key);
  // Glissant : un audio utilisé ne périme jamais, un audio abandonné disparaît tout seul.
  if (raw) redisCache.expire(key, TTS_CACHE_TTL_SECONDS).catch(() => undefined);
  return raw ?? null;
}

export async function setTtsCached(text: string, voiceId: string, audio: Buffer): Promise<void> {
  if (text.length < TTS_CACHE_MIN_LENGTH) return;
  await redisCache.set(cacheKey(text, voiceId), audio, 'EX', TTS_CACHE_TTL_SECONDS);
}

export const WARMUP_PHRASES = [
  'Un instant, je vérifie ça pour vous...',
  'Bien sûr, avec plaisir.',
  'Je vous transfère immédiatement.',
  'Réservation confirmée !',
  'Nous sommes fermés ce créneau.',
  "Pouvez-vous répéter s'il vous plaît ?",
];
