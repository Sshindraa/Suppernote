/**
 * Banc « deuxième transcription » — Scribe Realtime (A) contre Scribe batch (B)
 * sur exactement le même audio.
 *
 * À lancer sur le serveur, où se trouvent les clés (jamais copiées ailleurs) :
 *   node --env-file=.env scripts/voice-stt-bench/second-opinion.cjs phrases.json audio-dir > second-opinion.json
 *
 * La synthèse Cartesia n'est pas déterministe : l'audio dégradé de chaque phrase
 * est donc écrit une fois dans `audio-dir` (`<id>.pcm`, PCM 16 bits 8 kHz), puis
 * relu tel quel pour les deux moteurs et pour toute relance. Ce dossier reste
 * sur le serveur (`.data/`, ignoré par git).
 * Sortie par phrase : { id, realtime: {...}, batch: { transcript, words, latencyMs, error } }.
 */
const fs = require('node:fs');
const path = require('node:path');
const { degrade, synthesize, transcribe, requireBenchConfig } = require('./transcribe.cjs');

const apiRoot = path.resolve(__dirname, '../..');
const { buildSttKeyterms } = require(path.join(apiRoot, 'dist/modules/voice/stream/stt-bridge.js'));

const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 4);
const BATCH_MODEL = process.env.BENCH_BATCH_MODEL ?? 'scribe_v2';

/** En-tête WAV autour du PCM 8 kHz : le batch n'accepte le PCM brut qu'à 16 kHz. */
function toWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Scribe batch, français, mêmes termes que la production. */
async function transcribeBatch(pcm, elevenLabsBenchKey) {
  const form = new FormData();
  form.append('model_id', BATCH_MODEL);
  form.append('language_code', 'fr');
  form.append('timestamps_granularity', 'word');
  form.append('tag_audio_events', 'false');
  for (const keyterm of buildSttKeyterms('Chez Suppernote')) form.append('keyterms', keyterm);
  form.append('file', new Blob([toWav(pcm)], { type: 'audio/wav' }), 'phrase.wav');
  const host = process.env.ELEVENLABS_STT_HOST ?? 'api.elevenlabs.io';
  const started = Date.now();
  const response = await fetch(`https://${host}/v1/speech-to-text`, {
    method: 'POST',
    headers: { 'xi-api-key': elevenLabsBenchKey },
    body: form,
  });
  const latencyMs = Date.now() - started;
  if (!response.ok) {
    return { transcript: '', words: [], latencyMs, error: `batch ${response.status}` };
  }
  const body = await response.json();
  const words = (body.words ?? [])
    .filter((word) => word.type === 'word' && word.text)
    .map((word) => ({ word: word.text, logprob: word.logprob ?? null }));
  return { transcript: (body.text ?? '').trim(), words, latencyMs, error: null };
}

async function main() {
  const phrases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const { elevenLabsBenchKey, cartesiaBenchKey } = requireBenchConfig(phrases);
  const audioDir = process.argv[3];
  fs.mkdirSync(audioDir, { recursive: true });
  const results = new Array(phrases.length);
  let next = 0;
  async function worker() {
    while (next < phrases.length) {
      const index = next++;
      const phrase = phrases[index];
      const file = path.join(audioDir, `${phrase.id}.pcm`);
      try {
        if (!fs.existsSync(file)) {
          fs.writeFileSync(
            file,
            degrade(await synthesize({ ...phrase, cartesiaBenchKey }), phrase),
          );
        }
        const audio = fs.readFileSync(file);
        const [realtime, batch] = await Promise.all([
          transcribe(audio, elevenLabsBenchKey),
          transcribeBatch(audio, elevenLabsBenchKey),
        ]);
        results[index] = { id: phrase.id, durationMs: audio.length / 16, realtime, batch };
      } catch (err) {
        results[index] = { id: phrase.id, error: err.message };
      }
      process.stderr.write(`\r${results.filter(Boolean).length}/${phrases.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stderr.write('\n');
  process.stdout.write(`${JSON.stringify(results, null, 2)}\n`, () => process.exit(0));
}

main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
