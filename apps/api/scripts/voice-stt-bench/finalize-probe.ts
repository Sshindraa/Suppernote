/**
 * Sonde `Finalize` sur les réponses courtes : Nova-3 rend-il tout de suite un mot qu'il n'a pas encore
 * transcrit, si on lui envoie `Finalize` peu après la fin de voix mesurée ?
 *
 * Pour chaque tour court des enregistrements (`turns.json` d'`eot_pauses.py`, voix ≤ 1,5 s), la piste
 * appelant est rejouée au rythme réel sur une fenêtre [début − 2,5 s, fin + 3 s], deux fois : sans commande
 * (témoin) et avec `Finalize` à fin de voix + `--finalize-after-ms`. Paramètres de socket : ceux de la
 * production (`buildDeepgramSttUrl`), sans keyterms, A-law 8 kHz en trames de 20 ms. Chaque événement est
 * daté par l'audio déjà envoyé (`atAudioMs`, repère de l'appel entier).
 *
 * Les enregistrements et les transcriptions sont des données personnelles : `--audio-dir` et `--out`
 * restent hors du dépôt. Coût : ~2 × 5,5 s × tours × 0,0048 $/min.
 *
 *   cd apps/api && node --env-file=.env --import tsx scripts/voice-stt-bench/finalize-probe.ts \
 *     --audio-dir "$TMPDIR/suppernote-call-audio" --turns "$TMPDIR/eot-turns.json" --out "$TMPDIR/probe.json" \
 *     [--finalize-after-ms 500] [--max-speech-ms 1500] [--concurrency 8]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

const CHUNK_MS = 20;
const BYTES_PER_MS = 8;
const LEAD_MS = 2_500;
const TAIL_MS = 3_000;
const USD_PER_MINUTE = 0.0048;

interface Turn {
  call: string;
  A: number;
  segs: Array<[number, number]>;
  speech: number;
}

interface ProbeEvent {
  atAudioMs: number;
  kind: string;
  transcript?: string;
  isFinal?: boolean;
  speechFinal?: boolean;
  fromFinalize?: boolean;
  lastWordEndMs?: number;
}

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : fallback;
}

function socketUrl(): string {
  const host =
    process.env.DEEPGRAM_API_HOST === 'api.deepgram.com'
      ? 'api.deepgram.com'
      : 'api.eu.deepgram.com';
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
    ].concat(['-f', 'alaw', '-']),
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`ffmpeg: ${result.stderr.toString().slice(0, 200)}`);
  return result.stdout;
}

function toEvent(message: Record<string, unknown>, atAudioMs: number): ProbeEvent | null {
  if (message.type === 'UtteranceEnd') return { atAudioMs, kind: 'UtteranceEnd' };
  if (message.type === 'SpeechStarted') return { atAudioMs, kind: 'SpeechStarted' };
  if (message.type !== 'Results') return null;
  const alternative = (
    message.channel as { alternatives?: Array<{ transcript?: string; words?: unknown }> }
  )?.alternatives?.[0];
  const words = Array.isArray(alternative?.words)
    ? (alternative.words as Array<{ end?: number }>)
    : [];
  const end = words.reduce((max, word) => Math.max(max, Number(word.end) || 0), 0);
  return {
    atAudioMs,
    kind: 'Results',
    transcript: alternative?.transcript?.trim() ?? '',
    isFinal: message.is_final === true,
    speechFinal: message.speech_final === true,
    fromFinalize: message.from_finalize === true,
    ...(end > 0 ? { lastWordEndMs: Math.round(end * 1000) } : {}),
  };
}

async function run(
  audio: Buffer,
  fromMs: number,
  toMs: number,
  finalizeAtMs: number | null,
): Promise<{ events: ProbeEvent[]; error: string | null }> {
  const events: ProbeEvent[] = [];
  let error: string | null = null;
  let sentMs = fromMs;
  const ws = new WebSocket(socketUrl(), {
    headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ''}` },
  });
  ws.on('message', (raw, binary) => {
    if (binary) return;
    try {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.type === 'Error') error = String(message.code ?? 'error');
      const event = toEvent(message, sentMs);
      if (event) {
        // Les horodatages de mots sont relatifs au début du flux : ramenés au repère de l'appel.
        if (event.lastWordEndMs !== undefined) event.lastWordEndMs += fromMs;
        events.push(event);
      }
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
  if (!opened) return { events, error };
  const step = CHUNK_MS * BYTES_PER_MS;
  const start = fromMs * BYTES_PER_MS;
  const stop = Math.min(audio.length, toMs * BYTES_PER_MS);
  const startedAt = Date.now();
  let finalized = finalizeAtMs === null;
  for (let offset = start; offset < stop && ws.readyState === WebSocket.OPEN; offset += step) {
    ws.send(audio.subarray(offset, Math.min(offset + step, stop)));
    sentMs = Math.round((offset + step) / BYTES_PER_MS);
    if (!finalized && sentMs >= finalizeAtMs!) {
      ws.send(JSON.stringify({ type: 'Finalize' }));
      events.push({ atAudioMs: sentMs, kind: 'FinalizeSent' });
      finalized = true;
    }
    const due = startedAt + (offset - start + step) / BYTES_PER_MS;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, due - Date.now())));
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'CloseStream' }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    ws.close();
  }
  return { events, error };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const audioDir = arg(argv, 'audio-dir');
  const turnsPath = arg(argv, 'turns');
  const out = arg(argv, 'out');
  if (!audioDir || !turnsPath || !out) throw new Error('--audio-dir, --turns et --out requis');
  if (!process.env.DEEPGRAM_API_KEY) throw new Error('DEEPGRAM_API_KEY absente');
  const afterMs = Number(arg(argv, 'finalize-after-ms', '500'));
  const maxSpeechMs = Number(arg(argv, 'max-speech-ms', '1500'));
  const concurrency = Number(arg(argv, 'concurrency', '8'));
  const turns = (JSON.parse(readFileSync(turnsPath, 'utf8')) as Turn[]).filter(
    (turn) => turn.speech <= maxSpeechMs,
  );
  const tracks = new Map<string, Buffer>();
  for (const turn of turns) {
    if (!tracks.has(turn.call)) {
      tracks.set(turn.call, callerTrack(join(audioDir, turn.call, 'call.mp3')));
    }
  }
  const jobs = turns.flatMap((turn) => [
    { turn, probe: false },
    { turn, probe: true },
  ]);
  const seconds = jobs.reduce((sum, job) => {
    const speechStart = job.turn.segs[0][0];
    const end = job.turn.segs[job.turn.segs.length - 1][1];
    return sum + (end + TAIL_MS - Math.max(0, speechStart - LEAD_MS)) / 1000;
  }, 0);
  // eslint-disable-next-line no-console -- sortie du banc
  console.log(
    `${turns.length} tours, ${jobs.length} sessions, ~${((seconds / 60) * USD_PER_MINUTE).toFixed(2)} $`,
  );
  const results: unknown[] = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const { turn, probe } = jobs[next++];
      const E = turn.segs[turn.segs.length - 1][1];
      const from = Math.max(0, turn.segs[0][0] - LEAD_MS);
      const result = await run(
        tracks.get(turn.call)!,
        from,
        E + TAIL_MS,
        probe ? E + afterMs : null,
      );
      results.push({ call: turn.call, A: turn.A, E, probe, afterMs, ...result });
      // eslint-disable-next-line no-console -- sortie du banc
      console.log(`${results.length}/${jobs.length} ${result.error ?? 'ok'}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  writeFileSync(out, JSON.stringify({ afterMs, results }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
