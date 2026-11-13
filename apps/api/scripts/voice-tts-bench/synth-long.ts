/**
 * Textes longs (3 à 4 phrases) pour le juge audio : synthèse d'un fournisseur à la fois.
 * Cartesia Sonic 3.6 (WebSocket, réglages de production) ou ElevenLabs v4 Turbo (HTTP, Hamet).
 *
 * Usage depuis apps/api :
 *   BENCH_MAX_CREDITS=2000 pnpm exec tsx --env-file=.env scripts/voice-tts-bench/synth-long.ts --provider=cartesia
 *   BENCH_MAX_CREDITS=2000 pnpm exec tsx --env-file=.env scripts/voice-tts-bench/synth-long.ts --provider=eleven
 *   (--dry-run : estimation sans appel réseau)
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { WebSocket, type RawData } from 'ws';

const TEXTS = [
  {
    id: 't1',
    text: "Bonjour, ici Chez Suppernote. Je peux vous réserver une table pour quatre personnes samedi soir. Vous préférez vers vingt heures trente, ou plutôt vers vingt et une heures ? Je note votre nom : c'est bien Lefèvre ?",
  },
  {
    id: 't2',
    text: "Très bien, c'est noté. La table est réservée pour mardi à dix-neuf heures quarante-cinq, au nom de Moreau. Si vous avez une allergie ou une demande particulière, dites-le-moi maintenant. Je vous enverrai la confirmation par message dans quelques minutes.",
  },
  {
    id: 't3',
    text: "Désolé, la terrasse est complète ce soir. En revanche, je peux vous proposer une table à l'intérieur, près de la fenêtre, à partir de vingt heures. Est-ce que cela vous convient ? Sinon, je peux regarder pour demain.",
  },
  {
    id: 't4',
    text: 'Pour nous joindre, le numéro est le zéro six trois neuf neuf huit un deux trois quatre. Si vous ne recevez pas la confirmation, rappelez-nous avant dix-huit heures. Nous serons ravis de vous accueillir.',
  },
  {
    id: 't5',
    text: "Votre réservation est modifiée : nous serons finalement douze personnes vendredi, à vingt heures. La carte change chaque semaine, je vous la présenterai à l'arrivée. Souhaitez-vous une chaise haute pour un enfant de deux ans ?",
  },
  {
    id: 't6',
    text: "Bonsoir, je suis désolée, nous fermons à vingt-trois heures. Pour un dîner en semaine, je vous conseille de réserver au moins deux jours à l'avance. Merci d'avoir appelé, à très bientôt.",
  },
  {
    id: 't7',
    text: 'Bienvenue ! Vous avez réservé une table pour trois, jeudi, à douze heures trente. Le parking le plus proche se trouve rue de la Paix, à deux minutes à pied. Je vous souhaite une très belle journée.',
  },
  {
    id: 't8',
    text: 'Il me reste une place à dix-neuf heures et une autre à vingt-deux heures. Laquelle préférez-vous ? Je peux aussi installer une chaise haute pour votre bébé si vous en avez besoin.',
  },
];

const CARTESIA_WS_URL = 'wss://api.cartesia.ai/tts/websocket';
const CARTESIA_VERSION = '2026-03-01';
const CARTESIA_MODEL = 'sonic-3.6';
const CARTESIA_LOCALE = 'fr-FR';
const CARTESIA_NORMALIZATION = 'auto';
const ELEVEN_MODEL = 'eleven_v4_turbo';
const ELEVEN_VOICE_ID = 'lPojg5cGgbhot31LKO2z'; // Hamet, bibliothèque
const ELEVEN_CREDITS_PER_CHAR = 0.5;

const providerArg = process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
if (providerArg !== 'cartesia' && providerArg !== 'eleven') {
  throw new Error('--provider=cartesia ou --provider=eleven requis');
}
const provider = providerArg;
const dryRun = process.argv.includes('--dry-run');
const maxCredits = Number(process.env.BENCH_MAX_CREDITS);
if (!Number.isFinite(maxCredits) || maxCredits <= 0) {
  throw new Error('BENCH_MAX_CREDITS doit être un nombre positif');
}

const chars = TEXTS.reduce((sum, t) => sum + t.text.length, 0);
const credits = provider === 'cartesia' ? chars : chars * ELEVEN_CREDITS_PER_CHAR;
// eslint-disable-next-line no-console
console.log(
  `Fournisseur : ${provider} | ${TEXTS.length} textes, ${chars} caractères | estimation ${Math.round(credits)} crédits (plafond ${maxCredits})`,
);
if (credits > maxCredits) throw new Error('Estimation au-dessus du plafond BENCH_MAX_CREDITS');
if (dryRun) {
  // eslint-disable-next-line no-console
  console.log('Dry-run : aucun appel réseau.');
  process.exit(0);
}

const cartesiaKey = process.env.CARTESIA_API_KEY?.trim() ?? '';
const cartesiaVoiceId = process.env.CARTESIA_VOICE_ID?.trim() ?? '';
const elevenKey = process.env.ELEVENLABS_API_KEY?.trim() ?? '';
if (provider === 'cartesia' && (!cartesiaKey || !cartesiaVoiceId)) {
  throw new Error('CARTESIA_API_KEY ou CARTESIA_VOICE_ID absente');
}
if (provider === 'eleven' && !elevenKey) throw new Error('ELEVENLABS_API_KEY absente');

const OUT = join(process.cwd(), 'scripts', 'voice-tts-bench', '.data', 'ecoute-long', 'synth');
mkdirSync(OUT, { recursive: true });

interface Synthesis {
  ttfaMs: number;
  totalMs: number;
  pcm: Buffer;
}

/** Cartesia en WebSocket, comme le chemin v2 de production (cartesia-context.ts). */
function synthCartesia(text: string): Promise<Synthesis> {
  return new Promise((resolve, reject) => {
    const url = new URL(CARTESIA_WS_URL);
    url.searchParams.set('cartesia_version', CARTESIA_VERSION);
    const ws = new WebSocket(url.toString(), { headers: { 'X-API-Key': cartesiaKey } });
    const chunks: Buffer[] = [];
    let t0 = 0;
    let ttfaMs = 0;
    let settled = false;
    const timer = setTimeout(() => {
      ws.terminate();
      fail(new Error('Cartesia : délai dépassé'));
    }, 30_000);

    function fail(error: Error): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }

    ws.on('open', () => {
      t0 = performance.now();
      ws.send(
        JSON.stringify({
          model_id: CARTESIA_MODEL,
          transcript: text,
          voice: { mode: 'id', id: cartesiaVoiceId },
          locale: CARTESIA_LOCALE,
          normalization: CARTESIA_NORMALIZATION,
          context_id: randomUUID(),
          output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
          continue: false,
          max_buffer_delay_ms: 0,
        }),
      );
    });
    ws.on('message', (raw: RawData) => {
      const msg = JSON.parse(raw.toString()) as {
        type?: string;
        done?: boolean;
        data?: string;
        message?: string;
      };
      if (msg.type === 'error') {
        ws.close();
        fail(new Error(`Cartesia : ${msg.message ?? 'erreur'}`));
        return;
      }
      if (msg.type === 'chunk' && msg.data) {
        if (chunks.length === 0) ttfaMs = performance.now() - t0;
        chunks.push(Buffer.from(msg.data, 'base64'));
      }
      if (msg.done === true || msg.type === 'done') {
        const totalMs = performance.now() - t0;
        ws.close();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({ ttfaMs, totalMs, pcm: Buffer.concat(chunks) });
        }
      }
    });
    ws.on('error', (error) => fail(error));
    ws.on('close', () => fail(new Error('Cartesia : connexion fermée avant la fin')));
  });
}

/** ElevenLabs en HTTP streaming, comme le pack précédent. */
async function synthEleven(text: string): Promise<Synthesis> {
  const t0 = performance.now();
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream?output_format=pcm_16000`,
    {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVEN_MODEL }),
    },
  );
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS ${res.status}: ${detail.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let ttfaMs = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      if (chunks.length === 0) ttfaMs = performance.now() - t0;
      chunks.push(Buffer.from(value));
    }
  }
  return { ttfaMs, totalMs: performance.now() - t0, pcm: Buffer.concat(chunks) };
}

function writeWav(name: string, pcm: Buffer): void {
  const raw = join(OUT, `${name}.pcm`);
  writeFileSync(raw, pcm);
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    's16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-i',
    raw,
    join(OUT, `${name}.wav`),
  ]);
  rmSync(raw);
}

async function main(): Promise<void> {
  for (const item of TEXTS) {
    const sample =
      provider === 'cartesia' ? await synthCartesia(item.text) : await synthEleven(item.text);
    writeWav(`${provider}-${item.id}`, sample.pcm);
    // eslint-disable-next-line no-console
    console.log(
      `${item.id} | TTFA ${Math.round(sample.ttfaMs)} ms | total ${Math.round(sample.totalMs)} ms | audio ${(sample.pcm.length / 32000).toFixed(2)} s`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`Fichiers écrits dans ${OUT}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
