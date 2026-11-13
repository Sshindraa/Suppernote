/**
 * Banc narrowband — exécution des conditions sur les mêmes clips.
 *
 *   A : 16 kHz natif                        → Scribe `pcm_16000` (référence haute)
 *   B : passe-bande → 8 kHz → A-law → 8 kHz → Scribe `pcm_8000` (prod actuelle)
 *   C : B puis upsampling 16 kHz            → Scribe `pcm_16000`
 *   D : B mais envoi par chunks de 100 ms   → Scribe `pcm_8000`
 *   E : B avec `language_code=fr`
 *   F : B avec filtrage Scribe du bruit de fond
 *
 * Les paramètres Scribe (langues, keyterms, VAD, stratégie de commit) sont lus
 * depuis `scribe-url.cjs` (l'ancienne URL de production, sortie de `stt-bridge.ts`). E et F ne changent que leur
 * condition; F omet aussi `include_timestamps`, incompatible avec le filtre.
 *
 * À lancer depuis `apps/api`, où se trouvent les clés :
 *   node --env-file=.env --import tsx scripts/voice-stt-bench/nb-run.ts > .data/nb-results.json
 *
 * Cache TTS 16 kHz dans `.data/audio16/`, jamais commité. Aucune PII : les
 * phrases sont synthétiques et les logs ne contiennent que des identifiants.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { NB_CORPUS, NOISE_SEEDS, CLEAN_REPEATS, clipVoice } from './nb-corpus';
import {
  addBackgroundNoise,
  alawRoundTrip,
  applyPacketLoss,
  backgroundNoiseOnly,
  downsampleBy2,
  noiseControlLossSeed,
  packetLossSeed,
  telephoneBandpass,
  upsampleBy2,
} from './nb-dsp';
import { synthesize16k, type TtsProvider } from './nb-tts';
import {
  BENCH_CONFIRM_LIMIT,
  BENCH_TRAILING_SILENCE_S,
  estimateBenchCost,
  formatCostEstimate,
  requireBenchKey,
  requireSharedKey,
} from './nb-keys';

const { buildSttUrl } = require('./scribe-url.cjs') as {
  buildSttUrl: (
    model?: string,
    codec?: 'PCMA' | 'PCMU',
    turnConfig?: unknown,
    options?: {
      restaurantName?: string;
      filterBackgroundAudio?: boolean;
      languages?: readonly string[];
    },
  ) => string;
};

const DATA_DIR = join(__dirname, '.data');
const AUDIO_DIR = join(DATA_DIR, 'audio16');
const NOISE_CONTROL_MS = 4_000;

export type Condition = 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
export type Variant = 'clean' | 'noisy';

interface ConditionSpec {
  format: 'pcm_16000' | 'pcm_8000';
  sampleRate: 16000 | 8000;
  chunkMs: number;
  prepare: (native16k: Buffer) => Buffer;
  /**
   * Langue imposée à Scribe. Absent = comportement de production (détection
   * automatique sur `fr,en,es,it,de,pt,nl`). Présent = `language_code` forcé et
   * `secondary_languages` restreints (voir `scribeUrl`).
   */
  language?: { primary: string; secondaries: readonly string[] };
  filterBackgroundAudio?: boolean;
}

const narrowband8k = (native16k: Buffer): Buffer =>
  alawRoundTrip(downsampleBy2(telephoneBandpass(native16k, 16000)));

export const CONDITIONS: Record<Condition, ConditionSpec> = {
  A: { format: 'pcm_16000', sampleRate: 16000, chunkMs: 20, prepare: (audio) => audio },
  B: { format: 'pcm_8000', sampleRate: 8000, chunkMs: 20, prepare: narrowband8k },
  C: {
    format: 'pcm_16000',
    sampleRate: 16000,
    chunkMs: 20,
    prepare: (audio) => upsampleBy2(narrowband8k(audio)),
  },
  D: { format: 'pcm_8000', sampleRate: 8000, chunkMs: 100, prepare: narrowband8k },
  // E = B avec la langue verrouillée sur le français : Scribe ne peut plus
  // basculer sur l'anglais ou le néerlandais pendant un appel court et bruité.
  E: {
    format: 'pcm_8000',
    sampleRate: 8000,
    chunkMs: 20,
    prepare: narrowband8k,
    language: { primary: 'fr', secondaries: [] },
  },
  // F = B avec le filtre de bruit Scribe, sans autre changement.
  F: {
    format: 'pcm_8000',
    sampleRate: 8000,
    chunkMs: 20,
    prepare: narrowband8k,
    filterBackgroundAudio: true,
  },
};

function scribeUrl(spec: ConditionSpec): string {
  const model = process.env.BENCH_STT_MODEL;
  const base = buildSttUrl(model, 'PCMA', undefined, {
    restaurantName: 'Chez Suppernote',
    // `languages: []` supprime toutes les `secondary_languages` : sans liste,
    // Scribe ne peut pas dériver vers une autre langue que `language_code`.
    ...(spec.language ? { languages: spec.language.secondaries } : {}),
    filterBackgroundAudio: spec.filterBackgroundAudio,
  });
  const url = new URL(base);
  url.searchParams.set('audio_format', spec.format);
  if (spec.language) url.searchParams.set('language_code', spec.language.primary);
  // Surcharge facultative (mock local, autre hôte) : ne change que l'origine.
  if (process.env.BENCH_STT_URL) {
    const override = new URL(process.env.BENCH_STT_URL);
    url.protocol = override.protocol;
    url.host = override.host;
    url.pathname = override.pathname;
  }
  return url.toString();
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface StreamResult {
  transcript: string;
  words: Array<{ word: string; logprob: number | null }>;
  partials: string[];
  latencyMs: number;
  messagesSent: number;
  error: string | null;
  detectedLanguage: string | null;
}

async function streamToScribe(
  audio: Buffer,
  spec: ConditionSpec,
  apiKey: string,
): Promise<StreamResult> {
  return new Promise((resolve) => {
    const ws = new WebSocket(scribeUrl(spec), { headers: { 'xi-api-key': apiKey } });
    const committed: string[] = [];
    let lastPlainCommit: string | null = null;
    const words: StreamResult['words'] = [];
    const partials: string[] = [];
    let messagesSent = 0;
    let endOfSpeechAt = 0;
    let lastCommitAt = 0;
    let detectedLanguage: string | null = null;
    let finished = false;
    const bytesPerChunk = Math.round((spec.sampleRate * 2 * spec.chunkMs) / 1000);

    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolve({
        transcript: committed.join(' ').trim(),
        words,
        partials,
        latencyMs: lastCommitAt && endOfSpeechAt ? lastCommitAt - endOfSpeechAt : -1,
        messagesSent,
        error,
        detectedLanguage,
      });
    };

    const hardTimer = setTimeout(() => finish(committed.length ? null : 'timeout'), 40_000);
    ws.on('error', (error: Error) => finish(error.message));
    ws.on('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode ?? 0;
      response.resume();
      finish(`handshake_http_${statusCode}`);
    });

    ws.on('message', async (raw: WebSocket.RawData) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const type = typeof event.message_type === 'string' ? event.message_type : '';
      if (typeof event.language_code === 'string') {
        detectedLanguage = event.language_code;
      }

      if (type === 'session_started') {
        const send = (chunk: Buffer) => {
          ws.send(
            JSON.stringify({
              message_type: 'input_audio_chunk',
              audio_base_64: chunk.toString('base64'),
              sample_rate: spec.sampleRate,
            }),
          );
          messagesSent++;
        };
        for (let offset = 0; offset < audio.length; offset += bytesPerChunk) {
          send(audio.subarray(offset, offset + bytesPerChunk));
          await sleep(spec.chunkMs);
        }
        endOfSpeechAt = Date.now();
        const silence = Buffer.alloc(bytesPerChunk);
        // Silence final pour franchir la VAD (0,95 s) et laisser Scribe committer.
        for (let sent = 0; sent < Math.ceil(1600 / spec.chunkMs); sent++) {
          send(silence);
          await sleep(spec.chunkMs);
        }
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          if (committed.length && Date.now() - lastCommitAt > 300) break;
          await sleep(100);
        }
        finish(null);
        return;
      }

      if (type === 'partial_transcript') {
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        if (text && partials.at(-1) !== text) partials.push(text);
        return;
      }

      if (type === 'committed_transcript' || type === 'committed_transcript_with_timestamps') {
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        // Scribe émet le même segment en `committed_transcript` puis en
        // `..._with_timestamps` : on ne le compte qu'une fois (comme la prod).
        const duplicate =
          type === 'committed_transcript_with_timestamps' && lastPlainCommit === text;
        lastPlainCommit = type === 'committed_transcript' ? text : null;
        // Le texte n'est compté qu'une fois ; les mots horodatés restent collectés.
        if (text && !duplicate) committed.push(text);
        lastCommitAt = Date.now();
        const list = Array.isArray(event.words) ? event.words : [];
        for (const word of list as Array<Record<string, unknown>>) {
          const value = typeof word.text === 'string' ? word.text : word.word;
          if (typeof value !== 'string' || word.type === 'spacing') continue;
          words.push({
            word: value,
            logprob: typeof word.logprob === 'number' ? word.logprob : null,
          });
        }
        return;
      }

      if (/(?:error|rate.?limit|quota)/i.test(type)) {
        finish(type || 'scribe_error');
      }
    });
  });
}

function cacheKey(text: string, voice: string): string {
  return createHash('sha256').update(`${voice}|${text}`).digest('hex').slice(0, 16);
}

async function getNative16k(
  text: string,
  voice: string,
  provider: TtsProvider,
  apiKey: string | undefined,
): Promise<Buffer> {
  mkdirSync(AUDIO_DIR, { recursive: true });
  const file = join(AUDIO_DIR, `${cacheKey(text, voice)}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  const audio = await synthesize16k({ text, voice, provider, apiKey: apiKey ?? '' });
  writeFileSync(file, audio);
  return audio;
}

export interface BenchRecord {
  clipId: string;
  text: string;
  category: string;
  condition: Condition;
  variant: Variant;
  repeat: number;
  noiseSeed: number | null;
  snrDb: number | null;
  audioMs: number;
  latencyMs: number;
  messagesSent: number;
  transcript: string;
  error: string | null;
  detectedLanguage: string | null;
  noiseOnly?: boolean;
}

async function main(): Promise<void> {
  const ttsProvider = (process.env.BENCH_TTS_PROVIDER ?? 'cartesia') as TtsProvider;
  const conditions = (process.env.BENCH_CONDITIONS ?? 'A,B,C,D')
    .toUpperCase()
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is Condition => value in CONDITIONS);
  const variants = (process.env.BENCH_VARIANTS ?? 'clean,noisy')
    .toLowerCase()
    .split(',')
    .map((value) => value.trim() as Variant);
  const limit = Number(process.env.BENCH_LIMIT ?? NB_CORPUS.length);
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 6);
  const clips = NB_CORPUS.slice(0, Math.max(1, Math.min(limit, NB_CORPUS.length)));

  // Clé Cartesia de banc prioritaire, sinon runtime ; clé ElevenLabs unique.
  const elevenLabsKey = requireSharedKey('ELEVENLABS_API_KEY');
  const ttsKey =
    ttsProvider === 'cartesia'
      ? requireBenchKey('CARTESIA_BENCH_API_KEY', 'CARTESIA_API_KEY')
      : ttsProvider === 'elevenlabs'
        ? requireSharedKey('ELEVENLABS_API_KEY')
        : undefined; // `say` : synthèse locale, aucune clé.

  // Estimation affichée avant toute synthèse ou envoi Scribe.
  const sessionsPerCondition =
    (variants.includes('clean') ? CLEAN_REPEATS : 0) +
    (variants.includes('noisy') ? NOISE_SEEDS.length : 0);
  const noiseControlConditions = conditions.includes('F') ? (['B', 'F'] as const) : [];
  const noiseControlSessions = noiseControlConditions.length * NOISE_SEEDS.length;
  const noiseControlSeconds =
    noiseControlSessions * (NOISE_CONTROL_MS / 1000 + BENCH_TRAILING_SILENCE_S);
  const estimate = estimateBenchCost(
    clips.map((clip) => clip.text),
    conditions.length,
    sessionsPerCondition,
    noiseControlSessions,
    noiseControlSeconds,
  );
  process.stderr.write(
    `${formatCostEstimate(estimate)} ` +
      (ttsProvider === 'say' ? 'TTS local say : aucun coût API TTS.\n' : '\n'),
  );
  if (clips.length > BENCH_CONFIRM_LIMIT && process.env.BENCH_CONFIRM !== '1') {
    throw new Error(
      `${clips.length} clips dépasse la limite de confirmation (${BENCH_CONFIRM_LIMIT}). ` +
        `Relance avec BENCH_CONFIRM=1 après avoir validé le budget.`,
    );
  }

  const tasks: Array<{
    record: Omit<
      BenchRecord,
      'transcript' | 'latencyMs' | 'messagesSent' | 'error' | 'detectedLanguage'
    >;
    audio: Buffer;
    spec: ConditionSpec;
  }> = [];

  for (const clip of clips) {
    const index = NB_CORPUS.indexOf(clip);
    // `say` sélectionne ses voix par index ; Cartesia/ElevenLabs par identifiant.
    const voice = ttsProvider === 'say' ? String(index) : clipVoice(index, ttsProvider);
    const native = await getNative16k(clip.text, voice, ttsProvider, ttsKey);
    const variantAudio: Array<{
      variant: Variant;
      repeat: number;
      seed: number | null;
      snrDb: number | null;
      pcm: Buffer;
    }> = [];
    if (variants.includes('clean')) {
      for (let repeat = 0; repeat < CLEAN_REPEATS; repeat++) {
        variantAudio.push({ variant: 'clean', repeat, seed: null, snrDb: null, pcm: native });
      }
    }
    if (variants.includes('noisy')) {
      for (const [repeat, noise] of NOISE_SEEDS.entries()) {
        variantAudio.push({
          variant: 'noisy',
          repeat,
          seed: noise.seed,
          snrDb: noise.snrDb,
          pcm: addBackgroundNoise(native, 16000, { snrDb: noise.snrDb, seed: noise.seed }),
        });
      }
    }

    for (const condition of conditions) {
      const spec = CONDITIONS[condition];
      for (const variant of variantAudio) {
        const prepared = spec.prepare(variant.pcm);
        const lossSeed = packetLossSeed(clip.id, condition, variant.variant, variant.repeat);
        const audio =
          variant.variant === 'noisy'
            ? applyPacketLoss(prepared, spec.sampleRate, { lossRate: 0.02, seed: lossSeed })
            : prepared;
        tasks.push({
          spec,
          audio,
          record: {
            clipId: clip.id,
            text: clip.text,
            category: clip.critical[0]?.category ?? 'n/a',
            condition,
            variant: variant.variant,
            repeat: variant.repeat,
            noiseSeed: variant.seed,
            snrDb: variant.snrDb,
            audioMs: Math.round((audio.length / 2 / spec.sampleRate) * 1000),
          },
        });
      }
    }
  }

  for (const [repeat, noise] of NOISE_SEEDS.entries()) {
    const noise16k = backgroundNoiseOnly(16000, NOISE_CONTROL_MS, {
      rms: 600,
      seed: noise.seed,
    });
    for (const condition of noiseControlConditions) {
      const spec = CONDITIONS[condition];
      const prepared = spec.prepare(noise16k);
      const audio = applyPacketLoss(prepared, spec.sampleRate, {
        lossRate: 0.02,
        seed: noiseControlLossSeed(condition, repeat),
      });
      tasks.push({
        spec,
        audio,
        record: {
          clipId: `noise-only-${repeat + 1}`,
          text: '',
          category: 'noise_only',
          condition,
          variant: 'noisy',
          repeat,
          noiseSeed: noise.seed,
          snrDb: noise.snrDb,
          audioMs: Math.round((audio.length / 2 / spec.sampleRate) * 1000),
          noiseOnly: true,
        },
      });
    }
  }

  const audioMinutes =
    tasks.reduce((sum, task) => sum + task.record.audioMs / 1000 + BENCH_TRAILING_SILENCE_S, 0) /
    60;
  process.stderr.write(
    `Banc narrowband : ${clips.length} clips, conditions ${conditions.join('/')}, ` +
      `variantes ${variants.join('/')}, ${tasks.length} sessions Scribe, ` +
      `${audioMinutes.toFixed(1)} min d'audio avec silences VAD.\n`,
  );

  const results: BenchRecord[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const index = next++;
      const task = tasks[index];
      try {
        const stream = await streamToScribe(task.audio, task.spec, elevenLabsKey);
        results[index] = {
          ...task.record,
          transcript: stream.transcript,
          latencyMs: stream.latencyMs,
          messagesSent: stream.messagesSent,
          error: stream.error,
          detectedLanguage: stream.detectedLanguage,
        };
      } catch (error) {
        results[index] = {
          ...task.record,
          transcript: '',
          latencyMs: -1,
          messagesSent: 0,
          error: error instanceof Error ? error.message : String(error),
          detectedLanguage: null,
        };
      }
      done++;
      process.stderr.write(`\r${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  process.stderr.write('\n');
  mkdirSync(DATA_DIR, { recursive: true });
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`, () => process.exit(0));
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exit(1);
  });
}
