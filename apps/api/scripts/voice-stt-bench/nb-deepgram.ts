/**
 * Comparatif rapide Deepgram (Nova-3 et Flux) sur le corpus du banc narrowband.
 *
 * Même protocole que `nb-cartesia.ts` : clips `say` en cache, condition B
 * (chaîne téléphonique 8 kHz envoyée en A-law, comme Telnyx), 1 passage propre
 * + le 1er seed de bruit, sessions en parallèle.
 *
 *   BENCH_DG_MODEL=nova-3 : /v1/listen, language=fr, Finalize après l'audio.
 *   BENCH_DG_MODEL=flux   : /v2/listen, flux-general-multi + language_hint=fr ;
 *                           fin de tour détectée par Flux (ForceEndTurn en secours).
 *
 * BENCH_DG_FORMAT=smart|numerals|none compare le formatage sur les mêmes clips.
 * Clé : `DEEPGRAM_BENCH_API_KEY` ou `DEEPGRAM_API_KEY` (jamais affichée). Sortie : JSON `BenchRecord`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import WebSocket from 'ws';
import { NB_CORPUS, NOISE_SEEDS } from './nb-corpus';
import { requireBenchKey } from './nb-keys';
import {
  addBackgroundNoise,
  alawRoundTrip,
  applyPacketLoss,
  downsampleBy2,
  seedFromString,
  telephoneBandpass,
} from './nb-dsp';

const AUDIO_DIR = join(__dirname, '.data', 'audio16');
const CHUNK_MS = 80;
const BYTES_PER_MS = 8; // A-law 8 kHz
const TRAILING_SILENCE_MS = 1500;
const MAX_AUDIO_SECONDS = 660;
const NOVA_3_STREAMING_USD_PER_MINUTE = 0.0048;
const KEYTERM_USD_PER_MINUTE = 0.0013;

type Model = 'nova-3' | 'flux';
type FormatMode = 'smart' | 'numerals' | 'none';

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

function deepgramUrl(model: Model, formatMode: FormatMode): string {
  const params = new URLSearchParams({ encoding: 'alaw', sample_rate: '8000' });
  if (model === 'flux') {
    params.set('model', 'flux-general-multi');
    params.append('language_hint', 'fr');
    params.append('keyterm', 'Chez Suppernote');
    return `wss://api.deepgram.com/v2/listen?${params}`;
  }
  params.set('model', 'nova-3');
  params.set('language', 'fr');
  params.set('smart_format', String(formatMode === 'smart'));
  params.set('numerals', String(formatMode === 'numerals'));
  params.set('punctuate', 'true');
  const { buildSttKeyterms } = require('../../dist/modules/voice/stream/stt-bridge.js') as {
    buildSttKeyterms: (restaurantName?: string) => string[];
  };
  for (const keyterm of buildSttKeyterms('Chez Suppernote')) params.append('keyterm', keyterm);
  return `wss://api.deepgram.com/v1/listen?${params}`;
}

async function streamToDeepgram(
  audio: Buffer,
  model: Model,
  formatMode: FormatMode,
  apiKey: string,
): Promise<{ transcript: string; latencyMs: number; error: string | null }> {
  const ws = new WebSocket(deepgramUrl(model, formatMode), {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const finals: string[] = [];
  let speechEndAt = 0;
  let turnEndAt = 0;

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
        // Latence = fin de parole → transcript final (fin de tour pour Flux).
        latencyMs: speechEndAt && turnEndAt ? turnEndAt - speechEndAt : -1,
        error,
      });
    };
    const timer = setTimeout(() => finish(finals.length ? null : 'timeout'), 30_000);

    ws.on('error', (err) => finish(`ws: ${err.message}`));
    ws.on('unexpected-response', (_req, res) => finish(`http ${res.statusCode}`));
    ws.on('open', async () => {
      const payload = Buffer.concat([
        audio,
        Buffer.alloc(TRAILING_SILENCE_MS * BYTES_PER_MS, 0xd5),
      ]);
      const step = CHUNK_MS * BYTES_PER_MS;
      for (let offset = 0; offset < payload.length && !settled; offset += step) {
        if (offset >= audio.length && !speechEndAt) speechEndAt = Date.now();
        ws.send(payload.subarray(offset, offset + step));
        await new Promise((r) => setTimeout(r, CHUNK_MS));
      }
      if (settled) return;
      if (model === 'flux') {
        // Flux n'a pas conclu seul le tour dans le silence envoyé : on force.
        if (!turnEndAt) ws.send(JSON.stringify({ type: 'ForceEndTurn' }));
        setTimeout(() => finish(null), 2_000);
      } else {
        ws.send(JSON.stringify({ type: 'Finalize' }));
        setTimeout(() => {
          try {
            ws.send(JSON.stringify({ type: 'CloseStream' }));
          } catch {
            /* fermée */
          }
        }, 1_500);
      }
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
      if (model === 'flux') {
        if (type === 'TurnInfo' && event.event === 'EndOfTurn') {
          const text = typeof event.transcript === 'string' ? event.transcript.trim() : '';
          if (text) finals.push(text);
          if (!turnEndAt) turnEndAt = Date.now();
        } else if (type === 'Error') {
          finish(String(event.description ?? event.code ?? 'error').slice(0, 200));
        }
        return;
      }
      if (type === 'Results') {
        const channel = event.channel as { alternatives?: Array<{ transcript?: string }> };
        const text = channel?.alternatives?.[0]?.transcript?.trim() ?? '';
        if (event.is_final && text) {
          finals.push(text);
          turnEndAt = Date.now();
        }
        return;
      }
      if (type === 'Metadata') {
        finish(null);
        return;
      }
      if (type === 'Error') finish(String(event.description ?? 'error').slice(0, 200));
    });
    ws.on('close', () => finish(null));
  });
}

async function main(): Promise<void> {
  const apiKey = requireBenchKey('DEEPGRAM_BENCH_API_KEY', 'DEEPGRAM_API_KEY');
  const model = (process.env.BENCH_DG_MODEL ?? 'nova-3') as Model;
  if (!['nova-3', 'flux'].includes(model)) throw new Error('BENCH_DG_MODEL invalide');
  const formatMode = (process.env.BENCH_DG_FORMAT ?? 'smart') as FormatMode;
  if (!['smart', 'numerals', 'none'].includes(formatMode)) {
    throw new Error('BENCH_DG_FORMAT doit valoir smart, numerals ou none');
  }
  const limit = Number(process.env.BENCH_LIMIT ?? NB_CORPUS.length);
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 20);
  const noiseIndex = Number(process.env.BENCH_NOISE_INDEX ?? 0);
  const noise = NOISE_SEEDS[noiseIndex];
  const onlyNoisy = process.env.BENCH_VARIANTS === 'noisy';

  const tasks: Array<{ record: Record<string, unknown>; audio: Buffer }> = [];
  for (const clip of NB_CORPUS.slice(0, limit)) {
    const index = NB_CORPUS.indexOf(clip);
    const native = cachedSay16k(clip.text, index);
    const variants = [
      ...(onlyNoisy ? [] : [{ variant: 'clean', pcm: native, seed: null, snrDb: null }]),
      {
        variant: 'noisy',
        pcm: addBackgroundNoise(native, 16000, { snrDb: noise.snrDb, seed: noise.seed }),
        seed: noise.seed,
        snrDb: noise.snrDb,
      },
    ];
    for (const v of variants) {
      let pcm = alawRoundTrip(downsampleBy2(telephoneBandpass(v.pcm, 16000)));
      if (v.variant === 'noisy') {
        pcm = applyPacketLoss(pcm, 8000, {
          lossRate: 0.02,
          seed: seedFromString(`${clip.id}-B-${v.variant}-${noiseIndex}`),
        });
      }
      tasks.push({
        audio: pcm16ToAlaw(pcm),
        record: {
          clipId: clip.id,
          text: clip.text,
          category: clip.critical[0]?.category ?? 'n/a',
          condition: 'B',
          formatMode,
          variant: v.variant,
          repeat: v.variant === 'noisy' ? noiseIndex : 0,
          noiseSeed: v.seed,
          snrDb: v.snrDb,
          audioMs: Math.round((pcm.length / 2 / 8000) * 1000),
          messagesSent: 0,
        },
      });
    }
  }

  const speechSec = tasks.reduce((s, t) => s + Number(t.record.audioMs) / 1000, 0);
  const totalAudioSec = speechSec + (tasks.length * TRAILING_SILENCE_MS) / 1000;
  const maxAudioSec = Number(process.env.BENCH_DG_MAX_AUDIO_SECONDS ?? MAX_AUDIO_SECONDS);
  if (!Number.isFinite(maxAudioSec) || maxAudioSec <= 0) {
    throw new Error('BENCH_DG_MAX_AUDIO_SECONDS doit être un nombre positif');
  }
  if (totalAudioSec > maxAudioSec) {
    throw new Error(
      `Budget dépassé : ${Math.ceil(totalAudioSec)} s estimées, plafond ${maxAudioSec} s`,
    );
  }
  const keytermMinutes = totalAudioSec / 60;
  const estimatedCost = keytermMinutes * (NOVA_3_STREAMING_USD_PER_MINUTE + KEYTERM_USD_PER_MINUTE);
  process.stderr.write(
    `Estimation avant envoi : ${model}/${formatMode}, ${tasks.length} sessions, ` +
      `${speechSec.toFixed(1)} s de parole + ${(tasks.length * TRAILING_SILENCE_MS) / 1000} s ` +
      `de silence = ${totalAudioSec.toFixed(1)} s au total. ` +
      `Coût indicatif Nova-3 + keyterms : $${estimatedCost.toFixed(4)} USD ` +
      `(tarifs PAYG affichés, hors taxes/arrondis).\n`,
  );
  if (tasks.length > 8 && process.env.BENCH_CONFIRM !== '1') {
    throw new Error('BENCH_CONFIRM=1 obligatoire pour plus de 8 sessions');
  }
  if (process.env.BENCH_DG_DRY_RUN === '1') return;

  const results: Array<Record<string, unknown>> = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let creditError = false;
  async function worker(): Promise<void> {
    while (next < tasks.length && !creditError) {
      const i = next++;
      const t = tasks[i];
      const r = await streamToDeepgram(t.audio, model, formatMode, apiKey!);
      if (r.error && /402|credit|balance|quota|insufficient/i.test(r.error)) creditError = true;
      results[i] = {
        ...t.record,
        transcript: r.transcript,
        latencyMs: r.latencyMs,
        error: r.error,
        detectedLanguage: null,
      };
      done++;
      process.stderr.write(`\r${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write('\n');
  if (creditError) process.stderr.write('ARRÊT : erreur de crédits Deepgram.\n');
  process.stdout.write(`${JSON.stringify(results.filter(Boolean), null, 2)}\n`, () =>
    process.exit(0),
  );
}

main().catch((error) => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exit(1);
});
