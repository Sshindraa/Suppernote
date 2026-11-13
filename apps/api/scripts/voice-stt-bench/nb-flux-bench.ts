/** Paired Nova-3 / Flux comparison on the same narrowband clips and noise seed. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { NB_CORPUS, NOISE_SEEDS } from './nb-corpus';
import {
  addBackgroundNoise,
  alawEncode,
  alawRoundTrip,
  applyPacketLoss,
  downsampleBy2,
  seedFromString,
  telephoneBandpass,
} from './nb-dsp';
import { synthesize16k } from './nb-tts';
import { buildSttKeyterms } from '../../src/modules/voice/stream/stt-keyterms';
import { requireBenchKey } from './nb-keys';

const AUDIO_DIR = join(__dirname, '.data', 'audio16');
const CHUNK_MS = 80;
const BYTES_PER_MS = 8;
const TRAILING_SILENCE_MS = 1_500;
const MAX_AUDIO_SECONDS = 660;
const NOVA_3_USD_PER_MINUTE = 0.0048;
const FLUX_MULTILINGUAL_USD_PER_MINUTE = 0.0078;
const KEYTERM_USD_PER_MINUTE = 0.0013;
const MODELS = ['nova-3', 'flux-general-multi'] as const;
type Model = (typeof MODELS)[number];
type Variant = 'clean' | 'noisy';
type Split = 'calibration' | 'validation';

const CALIBRATION_IDS = new Set([
  'c01',
  'c03',
  'c05',
  'c07',
  'c09',
  'h01',
  'h03',
  'h05',
  'h07',
  'd01',
  'd03',
  'n01',
  'n03',
  'n05',
  't01',
  't03',
]);

interface BenchTask {
  model: Model;
  clipId: string;
  split: Split;
  variant: Variant;
  text: string;
  audio: Buffer;
  noiseSeed: number | null;
  snrDb: number | null;
}

interface BenchResult extends Omit<BenchTask, 'audio'> {
  transcript: string;
  error: string | null;
  latencyMs: number | null;
  finalTrigger: string | null;
  messagesSent: number;
  audioSentMs: number;
}

function splitForClip(clipId: string): Split {
  return CALIBRATION_IDS.has(clipId) ? 'calibration' : 'validation';
}

async function cachedSay16k(text: string, index: number): Promise<Buffer> {
  const key = createHash('sha256').update(`${index}|${text}`).digest('hex').slice(0, 16);
  const file = join(AUDIO_DIR, `${key}.pcm`);
  if (existsSync(file)) return readFileSync(file);
  mkdirSync(AUDIO_DIR, { recursive: true });
  const audio = await synthesize16k({
    text,
    voice: String(index),
    provider: 'say',
    apiKey: '',
  });
  writeFileSync(file, audio);
  return audio;
}

function makeTasks(limit: number): Promise<BenchTask[]> {
  const noise = NOISE_SEEDS[0];
  return Promise.all(
    NB_CORPUS.slice(0, limit).map(async (clip) => {
      const native = await cachedSay16k(clip.text, NB_CORPUS.indexOf(clip));
      const noisyNative = addBackgroundNoise(native, 16_000, {
        snrDb: noise.snrDb,
        seed: noise.seed,
      });
      const variants: Array<{
        variant: Variant;
        native: Buffer;
        noiseSeed: number | null;
        snrDb: number | null;
      }> = [
        { variant: 'clean', native, noiseSeed: null, snrDb: null },
        { variant: 'noisy', native: noisyNative, noiseSeed: noise.seed, snrDb: noise.snrDb },
      ];

      return variants.flatMap((item) => {
        let pcm = alawRoundTrip(downsampleBy2(telephoneBandpass(item.native, 16_000)));
        if (item.variant === 'noisy') {
          pcm = applyPacketLoss(pcm, 8_000, {
            lossRate: 0.02,
            seed: seedFromString(`${clip.id}-B-${item.variant}-${noise.seed}`),
          });
        }
        const audio = alawEncode(pcm);
        return MODELS.map((model) => ({
          model,
          clipId: clip.id,
          split: splitForClip(clip.id),
          variant: item.variant,
          text: clip.text,
          audio,
          noiseSeed: item.noiseSeed,
          snrDb: item.snrDb,
        }));
      });
    }),
  ).then((groups) => groups.flat());
}

function deepgramUrl(model: Model, keyterms: readonly string[]): string {
  const params = new URLSearchParams({ encoding: 'alaw', sample_rate: '8000' });
  if (model === 'flux-general-multi') {
    params.set('model', model);
    params.set('language_hint', 'fr');
    params.set('eot_threshold', '0.7');
    params.set('eager_eot_threshold', '0.5');
    params.set('eot_timeout_ms', '1000');
  } else {
    params.set('model', model);
    params.set('language', 'fr');
    params.set('interim_results', 'true');
    params.set('endpointing', '300');
    params.set('utterance_end_ms', '1000');
    params.set('vad_events', 'true');
    params.set('smart_format', 'false');
    params.set('numerals', 'true');
  }
  for (const keyterm of keyterms) params.append('keyterm', keyterm);
  return `wss://api.deepgram.com/${model === 'nova-3' ? 'v1' : 'v2'}/listen?${params}`;
}

function safeProviderError(error: string): string {
  if (/402|credit|balance|quota|insufficient/iu.test(error)) return 'account_limit';
  return 'provider_error';
}

async function streamToDeepgram(
  task: BenchTask,
  apiKey: string,
  keyterms: readonly string[],
): Promise<BenchResult> {
  const ws = new WebSocket(deepgramUrl(task.model, keyterms), {
    headers: { Authorization: `Token ${apiKey}` },
  });
  const finalParts: string[] = [];
  let settled = false;
  let speechEndAt: number | null = null;
  let turnEndAt: number | null = null;
  let finalTrigger: string | null = null;
  let endControlTimer: ReturnType<typeof setTimeout> | undefined;
  let closeControlTimer: ReturnType<typeof setTimeout> | undefined;
  let finalizeSent = false;
  let messagesSent = 0;
  let sentBytes = 0;
  let timer: ReturnType<typeof setTimeout>;
  let finish: (error: string | null) => void;

  const result = new Promise<BenchResult>((resolve) => {
    finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (endControlTimer) clearTimeout(endControlTimer);
      if (closeControlTimer) clearTimeout(closeControlTimer);
      try {
        ws.close();
      } catch {
        // The socket may already be closed.
      }
      resolve({
        model: task.model,
        clipId: task.clipId,
        split: task.split,
        variant: task.variant,
        text: task.text,
        noiseSeed: task.noiseSeed,
        snrDb: task.snrDb,
        transcript: finalParts.join(' ').replace(/\s+/gu, ' ').trim(),
        error,
        latencyMs: turnEndAt !== null && speechEndAt !== null ? turnEndAt - speechEndAt : null,
        finalTrigger,
        messagesSent,
        audioSentMs: sentBytes / BYTES_PER_MS,
      });
    };

    timer = setTimeout(() => finish('timeout'), 15_000);
    ws.on('error', () => finish('websocket_error'));
    ws.on('unexpected-response', (_request, response) => {
      const code = response.statusCode ?? 0;
      response.resume();
      finish(code === 402 ? 'account_limit' : `http_${code}`);
    });
    ws.on('open', async () => {
      const payload = Buffer.concat([
        task.audio,
        Buffer.alloc(TRAILING_SILENCE_MS * BYTES_PER_MS, 0xd5),
      ]);
      const stepBytes = CHUNK_MS * BYTES_PER_MS;
      try {
        for (let offset = 0; offset < payload.length && !settled; offset += stepBytes) {
          const chunk = payload.subarray(offset, offset + stepBytes);
          const sentAt = Date.now();
          ws.send(chunk);
          messagesSent++;
          sentBytes += chunk.length;
          if (offset < task.audio.length && offset + chunk.length >= task.audio.length) {
            speechEndAt = sentAt + Math.max(0, task.audio.length - offset) / BYTES_PER_MS;
          }
          await new Promise((resolveDelay) => setTimeout(resolveDelay, CHUNK_MS));
        }
        if (!settled) {
          if (task.model === 'flux-general-multi') {
            try {
              ws.send(JSON.stringify({ type: 'ForceEndTurn' }));
              finalTrigger = 'force_end_turn';
            } catch {
              finish('control_send_error');
              return;
            }
          } else {
            try {
              ws.send(JSON.stringify({ type: 'Finalize' }));
              finalizeSent = true;
              finalTrigger = 'finalize';
              closeControlTimer = setTimeout(() => {
                if (!settled) {
                  try {
                    ws.send(JSON.stringify({ type: 'CloseStream' }));
                  } catch {
                    finish(finalParts.length ? null : 'missing_final');
                  }
                }
              }, 1_500);
            } catch {
              finish('control_send_error');
              return;
            }
          }
          endControlTimer = setTimeout(() => {
            if (settled) return;
            finish(finalParts.length ? 'missing_end_of_turn' : 'missing_final');
          }, 5_000);
        }
      } catch {
        finish('audio_send_error');
      }
    });
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      if (message.type === 'Error') {
        finish(safeProviderError(String(message.code ?? 'provider_error')));
        return;
      }
      if (task.model === 'flux-general-multi') {
        if (message.type === 'TurnInfo' && message.event === 'EndOfTurn') {
          const transcript =
            typeof message.transcript === 'string' ? message.transcript.trim() : '';
          if (transcript) finalParts.push(transcript);
          turnEndAt = Date.now();
          finalTrigger = finalTrigger ?? 'end_of_turn';
          finish(transcript ? null : 'empty_final');
        }
        return;
      }
      if (message.type === 'Results') {
        const channel = message.channel as
          | { alternatives?: Array<{ transcript?: string }> }
          | undefined;
        const transcript = channel?.alternatives?.[0]?.transcript?.trim() ?? '';
        if (message.is_final === true && transcript) {
          finalParts.push(transcript);
          if (finalizeSent) {
            turnEndAt = Date.now();
            finish(null);
            return;
          }
        }
        if (message.is_final === true && message.speech_final === true) {
          turnEndAt = Date.now();
          finalTrigger = 'speech_final';
          finish(finalParts.length ? null : 'empty_final');
        }
        return;
      }
      if (message.type === 'UtteranceEnd' && finalParts.length) {
        turnEndAt = Date.now();
        finalTrigger = 'utterance_end';
        finish(null);
      }
    });
    ws.on('close', () => {
      if (!settled)
        finish(finalParts.length ? 'closed_without_end_of_turn' : 'closed_without_final');
    });
  });

  return result;
}

async function main(): Promise<void> {
  if (process.env.BENCH_DG_MODEL && process.env.BENCH_DG_MODEL !== 'nova-3') {
    throw new Error('Ce comparatif fixe nova-3 et flux-general-multi; retirer BENCH_DG_MODEL.');
  }
  const limit = Number(process.env.BENCH_LIMIT ?? NB_CORPUS.length);
  if (!Number.isInteger(limit) || limit < 1 || limit > NB_CORPUS.length) {
    throw new Error(`BENCH_LIMIT doit être entre 1 et ${NB_CORPUS.length}`);
  }
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
    throw new Error('BENCH_CONCURRENCY doit être un entier entre 1 et 8');
  }

  const keyterms = buildSttKeyterms('Chez Suppernote');
  const tasks = await makeTasks(limit);
  const audioSeconds = tasks.reduce(
    (sum, task) => sum + task.audio.length / BYTES_PER_MS / 1000 + TRAILING_SILENCE_MS / 1000,
    0,
  );
  const perModelSeconds = Object.fromEntries(
    MODELS.map((model) => [
      model,
      tasks
        .filter((task) => task.model === model)
        .reduce(
          (sum, task) => sum + task.audio.length / BYTES_PER_MS / 1000 + TRAILING_SILENCE_MS / 1000,
          0,
        ),
    ]),
  ) as Record<Model, number>;
  const estimatedCost =
    (perModelSeconds['nova-3'] / 60) * (NOVA_3_USD_PER_MINUTE + KEYTERM_USD_PER_MINUTE) +
    (perModelSeconds['flux-general-multi'] / 60) *
      (FLUX_MULTILINGUAL_USD_PER_MINUTE + KEYTERM_USD_PER_MINUTE);
  process.stderr.write(
    `Estimation avant envoi: ${tasks.length} sessions, ` +
      `${perModelSeconds['nova-3'].toFixed(1)} s Nova-3 + ` +
      `${perModelSeconds['flux-general-multi'].toFixed(1)} s Flux multi, ` +
      `${audioSeconds.toFixed(1)} s fournisseur cumulées; ` +
      `coût indicatif total $${estimatedCost.toFixed(4)} USD (streaming + keyterms).\n`,
  );
  const maxAudioSeconds = Number(process.env.BENCH_DG_MAX_AUDIO_SECONDS ?? MAX_AUDIO_SECONDS);
  if (!Number.isFinite(maxAudioSeconds) || maxAudioSeconds <= 0) {
    throw new Error('BENCH_DG_MAX_AUDIO_SECONDS doit être positif');
  }
  if (audioSeconds > maxAudioSeconds) {
    throw new Error(
      `Plafond audio dépassé: ${Math.ceil(audioSeconds)} s estimées, plafond ${maxAudioSeconds} s`,
    );
  }
  if (process.env.BENCH_DG_DRY_RUN === '1') return;
  if (tasks.length > 8 && process.env.BENCH_CONFIRM !== '1') {
    throw new Error('BENCH_CONFIRM=1 obligatoire pour plus de 8 sessions');
  }

  const apiKey = requireBenchKey('DEEPGRAM_BENCH_API_KEY', 'DEEPGRAM_API_KEY');

  const results: BenchResult[] = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let accountLimitHit = false;
  async function worker(): Promise<void> {
    while (next < tasks.length && !accountLimitHit) {
      const index = next++;
      const result = await streamToDeepgram(tasks[index], apiKey, keyterms);
      if (result.error === 'account_limit') accountLimitHit = true;
      results[index] = result;
      done++;
      process.stderr.write(`\r${done}/${tasks.length}`);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stderr.write('\n');

  const output = process.env.BENCH_OUTPUT ?? join(__dirname, '.data', 'nb-flux-comparison.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(results.filter(Boolean), null, 2)}\n`);
  const failures = results.filter((result) => result?.error).length;
  process.stderr.write(
    `Résultats enregistrés dans ${output}; ${failures} session(s) en erreur.` +
      (accountLimitHit ? ' Limite de crédits atteinte; arrêt des nouvelles sessions.' : '') +
      '\n',
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Erreur du runner';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
