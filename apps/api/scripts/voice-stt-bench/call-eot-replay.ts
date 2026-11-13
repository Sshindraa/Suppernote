/**
 * Rejeu de vraies pistes appelant vers Nova-3 et Flux, en parallèle et au rythme réel, pour comparer la
 * décision de fin de tour sur le même audio. Les enregistrements (MP3 deux pistes, appelant à gauche) sont
 * récupérés par `scripts/ops/voice_call_audio.py` hors du dépôt : c'est une donnée personnelle, comme les
 * transcriptions écrites dans le fichier de sortie, qui doit rester hors du dépôt.
 *
 * Réglages des sockets : ceux de la production (`buildDeepgramSttUrl`), sans keyterms. Trames de 20 ms en
 * A-law 8 kHz comme Telnyx. Chaque événement est daté par l'audio déjà envoyé à sa réception (`atAudioMs`),
 * donc délai réseau compris, identique pour les deux modèles.
 *
 * Coût : durée des pistes × (0,0048 $/min Nova-3 + 0,0078 $/min Flux multilingue).
 *
 *   cd apps/api && node --env-file=.env --import tsx scripts/voice-stt-bench/call-eot-replay.ts \
 *     --audio-dir "$TMPDIR/suppernote-call-audio" --out "$TMPDIR/eot-replay.json" [--concurrency 6] [--only 28511b65,...]
 *   Options Flux : --eot-threshold 0.7 --eager-eot-threshold 0.5 --eot-timeout-ms 1000 --models nova-3,flux-general-multi
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHUNK_MS = 20;
const BYTES_PER_MS = 8;
const TAIL_SILENCE_MS = 3_000;
const ALAW_SILENCE = 0xd5;
const USD_PER_MINUTE = { 'nova-3': 0.0048, 'flux-general-multi': 0.0078 } as const;
type Model = keyof typeof USD_PER_MINUTE;

interface Options {
  audioDir: string;
  out: string;
  concurrency: number;
  only: string[] | null;
  models: Model[];
  eotThreshold: string;
  eagerEotThreshold: string;
  eotTimeoutMs: string;
}

export interface ReplayEvent {
  atAudioMs: number;
  /** Nova : Results/UtteranceEnd/SpeechStarted ; Flux : événement TurnInfo. */
  kind: string;
  transcript?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  fromFinalize?: boolean;
  /** Fin du dernier mot selon le fournisseur (ms d'audio). */
  lastWordEndMs?: number;
  eotConfidence?: number;
  trigger?: string;
}

export interface ReplayResult {
  call: string;
  model: Model;
  audioMs: number;
  error: string | null;
  events: ReplayEvent[];
}

function parseArgs(argv: string[]): Options {
  const value = (name: string, fallback?: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : fallback;
  };
  const audioDir = value('audio-dir');
  const out = value('out');
  if (!audioDir || !out) throw new Error('--audio-dir et --out sont obligatoires');
  return {
    audioDir,
    out,
    concurrency: Number(value('concurrency', '6')),
    only: value('only')?.split(',') ?? null,
    models: (value('models', 'nova-3,flux-general-multi') ?? '').split(',') as Model[],
    eotThreshold: value('eot-threshold', '0.7')!,
    eagerEotThreshold: value('eager-eot-threshold', '0.5')!,
    eotTimeoutMs: value('eot-timeout-ms', '1000')!,
  };
}

/** Mêmes paramètres que `buildDeepgramSttUrl` (stt-bridge.ts) en production, sans keyterms. */
function socketUrl(model: Model, options: Options): string {
  const host =
    process.env.DEEPGRAM_API_HOST === 'api.deepgram.com'
      ? 'api.deepgram.com'
      : 'api.eu.deepgram.com';
  if (model === 'flux-general-multi') {
    const params = new URLSearchParams({
      model,
      language_hint: 'fr',
      encoding: 'alaw',
      sample_rate: '8000',
      eot_threshold: options.eotThreshold,
      eager_eot_threshold: options.eagerEotThreshold,
      eot_timeout_ms: options.eotTimeoutMs,
      numerals: 'true',
      mip_opt_out: 'true',
    });
    return `wss://${host}/v2/listen?${params}`;
  }
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'fr',
    encoding: 'alaw',
    sample_rate: '8000',
    interim_results: 'true',
    endpointing: '200',
    utterance_end_ms: '1000',
    vad_events: 'true',
    smart_format: 'false',
    numerals: 'true',
    punctuate: 'false',
    mip_opt_out: 'true',
  });
  return `wss://${host}/v1/listen?${params}`;
}

/** Piste appelant (canal gauche) en A-law 8 kHz, via ffmpeg. */
function callerTrack(mp3: string): Buffer {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      mp3,
      '-af',
      'pan=mono|c0=c0',
      '-ar',
      '8000',
      '-acodec',
      'pcm_alaw',
      '-f',
      'alaw',
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.toString().slice(0, 200)}`);
  return result.stdout;
}

function lastWordEnd(words: unknown): number | undefined {
  if (!Array.isArray(words)) return undefined;
  const end = words.reduce<number>((max, word) => {
    const value = Number((word as { end?: unknown }).end);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  return end > 0 ? Math.round(end * 1000) : undefined;
}

function toEvent(
  model: Model,
  message: Record<string, unknown>,
  atAudioMs: number,
): ReplayEvent | null {
  if (model === 'flux-general-multi') {
    if (message.type !== 'TurnInfo') return null;
    return {
      atAudioMs,
      kind: String(message.event),
      transcript: typeof message.transcript === 'string' ? message.transcript.trim() : '',
      lastWordEndMs: lastWordEnd(message.words),
      ...(typeof message.end_of_turn_confidence === 'number'
        ? { eotConfidence: message.end_of_turn_confidence }
        : {}),
      ...(typeof message.trigger === 'string' ? { trigger: message.trigger } : {}),
    };
  }
  if (message.type === 'UtteranceEnd') {
    const end = Number(message.last_word_end);
    return {
      atAudioMs,
      kind: 'UtteranceEnd',
      ...(Number.isFinite(end) ? { lastWordEndMs: Math.round(end * 1000) } : {}),
    };
  }
  if (message.type === 'SpeechStarted') return { atAudioMs, kind: 'SpeechStarted' };
  if (message.type !== 'Results') return null;
  const channel = message.channel as {
    alternatives?: Array<{ transcript?: string; words?: unknown }>;
  };
  const alternative = channel?.alternatives?.[0];
  return {
    atAudioMs,
    kind: 'Results',
    transcript: alternative?.transcript?.trim() ?? '',
    isFinal: message.is_final === true,
    speechFinal: message.speech_final === true,
    fromFinalize: message.from_finalize === true,
    lastWordEndMs: lastWordEnd(alternative?.words),
  };
}

async function replay(
  call: string,
  model: Model,
  audio: Buffer,
  options: Options,
): Promise<ReplayResult> {
  const events: ReplayEvent[] = [];
  let sent = 0;
  let error: string | null = null;
  const ws = new WebSocket(socketUrl(model, options), {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ''}` },
  });
  ws.on('message', (raw, binary) => {
    if (binary) return;
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === 'Error') error = String(message.code ?? message.description ?? 'error');
      const event = toEvent(model, message, Math.round(sent / BYTES_PER_MS));
      if (event) events.push(event);
    } catch {
      // Message illisible : ignoré.
    }
  });
  ws.on('error', (err) => {
    error ??= err.message.slice(0, 80);
  });
  const opened = await new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('unexpected-response', (_request, response) => {
      error = `http_${response.statusCode}`;
      response.resume();
      resolve(false);
    });
    ws.once('error', () => resolve(false));
  });
  if (!opened) return { call, model, audioMs: 0, error, events };
  const payload = Buffer.concat([
    audio,
    Buffer.alloc(TAIL_SILENCE_MS * BYTES_PER_MS, ALAW_SILENCE),
  ]);
  const step = CHUNK_MS * BYTES_PER_MS;
  const startedAt = Date.now();
  for (
    let offset = 0;
    offset < payload.length && ws.readyState === WebSocket.OPEN;
    offset += step
  ) {
    ws.send(payload.subarray(offset, offset + step));
    sent += Math.min(step, payload.length - offset);
    // Rythme réel calé sur l'horloge, pas sur des attentes cumulées.
    const due = startedAt + (offset + step) / BYTES_PER_MS;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CloseStream' }));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    ws.close();
  }
  return { call, model, audioMs: Math.round(sent / BYTES_PER_MS), error, events };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY absente');
  const calls = readdirSync(options.audioDir)
    .filter((name) => existsSync(join(options.audioDir, name, 'call.mp3')))
    .filter((name) => !options.only || options.only.includes(name))
    .sort();
  const tracks = new Map(
    calls.map((call) => [call, callerTrack(join(options.audioDir, call, 'call.mp3'))]),
  );
  const minutes =
    [...tracks.values()].reduce((sum, track) => sum + track.length / BYTES_PER_MS, 0) / 60_000;
  const usd = options.models.reduce((sum, model) => sum + minutes * USD_PER_MINUTE[model], 0);
  // eslint-disable-next-line no-console -- sortie du banc
  console.log(
    `${calls.length} pistes, ${minutes.toFixed(1)} min, modèles ${options.models.join('+')} : ~${usd.toFixed(2)} $`,
  );
  const jobs = calls.flatMap((call) => options.models.map((model) => ({ call, model })));
  const results: ReplayResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const result = await replay(job.call, job.model, tracks.get(job.call)!, options);
      results.push(result);
      // eslint-disable-next-line no-console -- sortie du banc
      console.log(
        `${job.call} ${job.model} ${result.error ?? 'ok'} (${results.length}/${jobs.length})`,
      );
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency) }, worker));
  writeFileSync(
    options.out,
    JSON.stringify({ options: { ...options, audioDir: undefined }, results }),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
