/**
 * Comparatif rapide Cartesia Ink 2 (STT) sur le corpus du banc narrowband.
 *
 * Mêmes clips (cache `say` de `.data/audio16/`), même bruit et mêmes pertes que
 * `nb-run.ts`, pour comparer aux résultats Scribe de `.data/nb-results.json`.
 * Conditions : A (16 kHz natif, pcm_s16le) et B (chaîne téléphonique 8 kHz,
 * envoyée en pcm_alaw comme Telnyx la fournit). 1 répétition propre + le 1er
 * seed de bruit, envoi temps réel par chunks de 100 ms, sessions en parallèle.
 *
 * Clé : `CARTESIA_BENCH_API_KEY` ou `CARTESIA_API_KEY` ; `BENCH_MAX_CREDITS` plafonne le coût avant envoi.
 * Sortie : JSON au format `BenchRecord`, scorable par `nb-score.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import WebSocket from 'ws';
import { NB_CORPUS, NOISE_SEEDS } from './nb-corpus';
import { requireBenchCreditBudget, requireBenchKey } from './nb-keys';
import {
  addBackgroundNoise,
  alawRoundTrip,
  applyPacketLoss,
  downsampleBy2,
  seedFromString,
  telephoneBandpass,
} from './nb-dsp';

const AUDIO_DIR = join(__dirname, '.data', 'audio16');
const CHUNK_MS = 100;
const TRAILING_SILENCE_MS = 600;

type Condition = 'A' | 'B';

function cachedSay16k(text: string, index: number): Buffer {
  const key = createHash('sha256').update(`${index}|${text}`).digest('hex').slice(0, 16);
  const file = join(AUDIO_DIR, `${key}.pcm`);
  if (!existsSync(file)) throw new Error(`audio say absent du cache pour ${index}`);
  return readFileSync(file);
}

/** PCM16 LE → octets A-law (G.711), pour envoyer ce que Telnyx envoie. */
function pcm16ToAlaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2);
  for (let i = 0; i < out.length; i++) {
    let sample = pcm.readInt16LE(i * 2);
    const sign = sample >= 0 ? 0x80 : 0x00;
    if (sample < 0) sample = -sample - 1;
    if (sample > 32635) sample = 32635;
    let exponent = 7;
    for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
    const mantissa = (sample >> (exponent === 0 ? 4 : exponent + 3)) & 0x0f;
    out[i] = (sign | (exponent << 4) | mantissa) ^ 0x55;
  }
  return out;
}

async function streamToCartesia(
  audio: Buffer,
  condition: Condition,
  apiKey: string,
): Promise<{
  transcript: string;
  latencyMs: number;
  error: string | null;
  language: string | null;
}> {
  const encoding = condition === 'A' ? 'pcm_s16le' : 'pcm_alaw';
  const sampleRate = condition === 'A' ? 16000 : 8000;
  const bytesPerMs = condition === 'A' ? 32 : 8;
  const params = new URLSearchParams({
    model: process.env.CARTESIA_STT_MODEL ?? 'ink-2',
    encoding,
    sample_rate: String(sampleRate),
    cartesia_version: '2026-08-14',
  });
  params.append('keyterm', 'Chez Suppernote');
  const ws = new WebSocket(`wss://api.cartesia.ai/stt/websocket?${params}`, {
    headers: { 'X-API-Key': apiKey, 'Cartesia-Version': '2026-08-14' },
  });
  const finals: string[] = [];
  let language: string | null = null;
  let finalizeAt = 0;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* déjà fermée */
      }
      resolve({
        transcript: finals.join(' ').replace(/\s+/g, ' ').trim(),
        latencyMs: finalizeAt ? Date.now() - finalizeAt : -1,
        error,
        language,
      });
    };
    const timer = setTimeout(() => finish(finals.length ? null : 'timeout'), 30_000);

    ws.on('error', (err) => finish(`ws: ${err.message}`));
    ws.on('unexpected-response', (_req, res) => finish(`http ${res.statusCode}`));
    ws.on('open', async () => {
      const payload = Buffer.concat([
        audio,
        Buffer.alloc(TRAILING_SILENCE_MS * bytesPerMs, encoding === 'pcm_alaw' ? 0xd5 : 0),
      ]);
      const step = CHUNK_MS * bytesPerMs;
      for (let offset = 0; offset < payload.length && !settled; offset += step) {
        ws.send(payload.subarray(offset, offset + step));
        await new Promise((r) => setTimeout(r, CHUNK_MS));
      }
      if (settled) return;
      finalizeAt = Date.now();
      ws.send('finalize');
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const type = String(event.type ?? '');
      if (type === 'transcript') {
        if (typeof event.language === 'string') language = event.language;
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        if (event.is_final && text) finals.push(text);
        return;
      }
      if (type === 'flush_done' || type === 'done') {
        finish(null);
        return;
      }
      if (type === 'error') {
        finish(String(event.message ?? event.title ?? 'error').slice(0, 200));
      }
    });
  });
}

async function main(): Promise<void> {
  const apiKey = requireBenchKey('CARTESIA_BENCH_API_KEY', 'CARTESIA_API_KEY');
  const limit = Number(process.env.BENCH_LIMIT ?? NB_CORPUS.length);
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 20);
  const conditions = (process.env.BENCH_CONDITIONS ?? 'A,B').split(',') as Condition[];
  const noise = NOISE_SEEDS[0];

  const tasks: Array<{ record: Record<string, unknown>; audio: Buffer; condition: Condition }> = [];
  for (const clip of NB_CORPUS.slice(0, limit)) {
    const index = NB_CORPUS.indexOf(clip);
    const native = cachedSay16k(clip.text, index);
    const variants = [
      { variant: 'clean', repeat: 0, pcm: native, seed: null, snrDb: null },
      {
        variant: 'noisy',
        repeat: 0,
        pcm: addBackgroundNoise(native, 16000, { snrDb: noise.snrDb, seed: noise.seed }),
        seed: noise.seed,
        snrDb: noise.snrDb,
      },
    ];
    for (const condition of conditions) {
      for (const v of variants) {
        const sampleRate = condition === 'A' ? 16000 : 8000;
        let pcm =
          condition === 'A' ? v.pcm : alawRoundTrip(downsampleBy2(telephoneBandpass(v.pcm, 16000)));
        if (v.variant === 'noisy') {
          pcm = applyPacketLoss(pcm, sampleRate, {
            lossRate: 0.02,
            seed: seedFromString(`${clip.id}-${condition}-${v.variant}-${v.repeat}`),
          });
        }
        const audio = condition === 'A' ? pcm : pcm16ToAlaw(pcm);
        tasks.push({
          condition,
          audio,
          record: {
            clipId: clip.id,
            text: clip.text,
            category: clip.critical[0]?.category ?? 'n/a',
            condition,
            variant: v.variant,
            repeat: v.repeat,
            noiseSeed: v.seed,
            snrDb: v.snrDb,
            audioMs: Math.round((pcm.length / 2 / sampleRate) * 1000),
            messagesSent: 0,
          },
        });
      }
    }
  }

  const totalSec = tasks.reduce((s, t) => s + Number(t.record.audioMs) / 1000 + 0.6, 0);
  const estimatedCredits = totalSec * 3;
  const maxCredits = requireBenchCreditBudget(estimatedCredits);
  process.stderr.write(
    `Cartesia ${process.env.CARTESIA_STT_MODEL ?? 'ink-2'} : ${tasks.length} sessions, ` +
      `~${Math.round(totalSec)} s d'audio, ~${estimatedCredits.toFixed(1)} crédits estimés ` +
      `(plafond ${maxCredits}), ~${Math.round(totalSec / concurrency)} s de mur.\n`,
  );
  if (tasks.length > 8 && process.env.BENCH_CONFIRM !== '1') {
    throw new Error('BENCH_CONFIRM=1 obligatoire pour plus de 8 sessions');
  }

  const results: Array<Record<string, unknown>> = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let creditError = false;
  async function worker(): Promise<void> {
    while (next < tasks.length && !creditError) {
      const i = next++;
      const t = tasks[i];
      const r = await streamToCartesia(t.audio, t.condition, apiKey!);
      if (r.error && /402|credit|quota|insufficient/i.test(r.error)) creditError = true;
      results[i] = {
        ...t.record,
        transcript: r.transcript,
        latencyMs: r.latencyMs,
        error: r.error,
        detectedLanguage: r.language,
      };
      done++;
      process.stderr.write(`\r${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write('\n');
  if (creditError) process.stderr.write('ARRÊT : erreur de crédits Cartesia.\n');
  process.stdout.write(`${JSON.stringify(results.filter(Boolean), null, 2)}\n`, () =>
    process.exit(0),
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
