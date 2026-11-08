/**
 * Test de charge du pipeline vocal (R1-3).
 *
 * Mesure ce que Suppernote contrôle réellement quand N appels arrivent en même temps :
 * acceptation WebSocket, traitement des trames média, mémoire et CPU du process.
 * Les fournisseurs (Telnyx, ElevenLabs, Cartesia) sont neutralisés par des clés
 * factices : leurs latences sont externes et ne se mesurent pas ici.
 *
 * Usage (depuis apps/api) :
 *   node --import tsx scripts/voice-load-test.ts --sessions 20 --duration 15
 *   node --import tsx scripts/voice-load-test.ts --sessions 20 --json > rapport.json
 *
 * Le harnais démarre sa propre API, sur son propre port et sa propre base Redis,
 * puis supprime les enregistrements d'appel qu'il a créés.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { WebSocket } from 'ws';

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

interface Args {
  sessions: number;
  durationSec: number;
  port: number;
  json: boolean;
  restaurantPhone: string;
}

function parseArgs(raw: string[]): Args {
  const args: Args = {
    sessions: 20,
    durationSec: 15,
    port: 4300,
    json: false,
    restaurantPhone: process.env.LOAD_TEST_RESTAURANT_PHONE ?? '+33102030405',
  };
  for (let index = 0; index < raw.length; index++) {
    const arg = raw[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--sessions') args.sessions = Number.parseInt(raw[++index] ?? '', 10);
    else if (arg === '--duration') args.durationSec = Number.parseInt(raw[++index] ?? '', 10);
    else if (arg === '--port') args.port = Number.parseInt(raw[++index] ?? '', 10);
    else if (arg === '--restaurant-phone')
      args.restaurantPhone = raw[++index] ?? args.restaurantPhone;
    else if (arg === '--help' || arg === '-h') {
      log('Usage: voice-load-test.ts [--sessions N] [--duration S] [--port P] [--json]');
      process.exit(0);
    }
  }
  return args;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * La route de simulation passe par `recordMonthlyCall`, qui compte les appels par
 * établissement dans Redis (plus de refus horaire depuis la suppression du disjoncteur). Le harnais
 * travaille sur une base Redis isolée : on remet uniquement ces compteurs à zéro
 * pour pouvoir créer N sessions, sans toucher aux autres clés.
 */
async function resetMarginCounters(redisUrl: string): Promise<number> {
  const url = new URL(redisUrl);
  const baseDb = url.pathname && url.pathname !== '/' ? Number(url.pathname.slice(1)) || 0 : 0;
  url.pathname = `/${baseDb + 1}`;
  const client = new Redis(url.toString(), { maxRetriesPerRequest: 2 });
  try {
    const keys = await client.keys('infra:calls:*');
    if (keys.length === 0) return 0;
    return await client.del(...keys);
  } finally {
    await client.quit().catch(() => undefined);
  }
}

async function waitForHealth(baseUrl: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // pas encore prêt
    }
    await sleep(500);
  }
  throw new Error(`API non prête après ${timeoutMs} ms`);
}

function sampleProcess(child: ChildProcess): { rssKb: number; cpuPercent: number } | null {
  if (!child.pid) return null;
  try {
    const out = execSync(`ps -o rss=,pcpu= -p ${child.pid}`, { encoding: 'utf8' }).trim();
    const [rss, cpu] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(rss)) return null;
    return { rssKb: rss, cpuPercent: Number.isFinite(cpu) ? cpu : 0 };
  } catch {
    return null;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = `http://127.0.0.1:${args.port}`;
  const wsBase = `ws://127.0.0.1:${args.port}`;
  const apiDir = path.resolve(process.cwd());
  const prisma = new PrismaClient();

  // Le build compilé est représentatif de la production ; `tsx` sert de repli
  // quand `dist/` n'existe pas encore.
  const compiledEntry = path.join(apiDir, 'dist', 'main.js');
  const useCompiled = existsSync(compiledEntry);
  const entryArgs = useCompiled ? ['dist/main.js'] : ['--import', 'tsx', 'src/main.ts'];

  log(
    `[load] démarrage de l'API sur :${args.port} (${useCompiled ? 'build compilé' : 'tsx'}, fournisseurs neutralisés)`,
  );
  const child = spawn('node', entryArgs, {
    cwd: apiDir,
    env: {
      ...process.env,
      PORT: String(args.port),
      HOST: '127.0.0.1',
      ENABLE_TEST_ROUTES: 'true',
      RUN_WORKERS_IN_PROCESS: 'false',
      // Le .env de dev peut activer le log de requêtes Prisma : illisible ici.
      DEBUG: '',
      REDIS_URL: process.env.LOAD_TEST_REDIS_URL ?? 'redis://localhost:6379/9',
      TELNYX_API_KEY: 'x',
      ELEVENLABS_API_KEY: 'x',
      CARTESIA_API_KEY: 'x',
      STRIPE_SECRET_KEY: 'sk_test_load_test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const childLog: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => childLog.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => childLog.push(chunk.toString()));

  const callIds: string[] = [];
  const createdCallIds: string[] = [];
  const connectLatencies: number[] = [];
  const rssSamples: number[] = [];
  const cpuSamples: number[] = [];
  let framesSent = 0;
  let socketsOpened = 0;
  let socketsFailed = 0;

  try {
    await waitForHealth(baseUrl);
    log('[load] API prête');

    const reset = await resetMarginCounters(
      process.env.LOAD_TEST_REDIS_URL ?? 'redis://localhost:6379/9',
    );
    if (reset > 0) log(`[load] ${reset} compteur(s) de marge réinitialisé(s) (Redis isolé)`);

    const baseline = sampleProcess(child);
    if (baseline) rssSamples.push(baseline.rssKb);

    for (let index = 0; index < args.sessions; index++) {
      const response = await fetch(`${baseUrl}/api/test/simulate-call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callerPhone: `+3360000${String(index).padStart(4, '0')}`,
          restaurantPhone: args.restaurantPhone,
          mode: 'mock',
        }),
      });
      if (!response.ok) {
        throw new Error(`simulate-call a échoué (${response.status}): ${await response.text()}`);
      }
      const payload = (await response.json()) as { callControlId: string };
      callIds.push(payload.callControlId);
      createdCallIds.push(payload.callControlId);
    }
    log(`[load] ${callIds.length} session(s) créée(s)`);

    const sampler = setInterval(() => {
      const sample = sampleProcess(child);
      if (sample) {
        rssSamples.push(sample.rssKb);
        cpuSamples.push(sample.cpuPercent);
      }
    }, 500);

    const frame = Buffer.alloc(160, 0xff).toString('base64');
    const sockets: WebSocket[] = [];

    await Promise.all(
      callIds.map(
        (callControlId) =>
          new Promise<void>((resolve) => {
            const startedAt = Date.now();
            const socket = new WebSocket(`${wsBase}/voice/stream/${callControlId}`);
            sockets.push(socket);

            socket.on('open', () => {
              socketsOpened += 1;
              connectLatencies.push(Date.now() - startedAt);
              socket.send(
                JSON.stringify({
                  event: 'start',
                  start: {
                    call_control_id: callControlId,
                    call_leg_id: callControlId,
                    from: '+33600000000',
                    to: args.restaurantPhone,
                    media_format: { encoding: 'PCMU', sample_rate: 8000, channels: 1 },
                  },
                }),
              );
              resolve();
            });

            socket.on('error', () => {
              socketsFailed += 1;
              resolve();
            });
          }),
      ),
    );

    log(`[load] ${socketsOpened} connexion(s) ouverte(s), ${socketsFailed} échec(s)`);

    const frameIntervalMs = 20;
    const ticks = Math.floor((args.durationSec * 1000) / frameIntervalMs);
    for (let tick = 0; tick < ticks; tick++) {
      for (const socket of sockets) {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({ event: 'media', media: { track: 'inbound', payload: frame } }),
          );
          framesSent += 1;
        }
      }
      await sleep(frameIntervalMs);
    }

    clearInterval(sampler);

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ event: 'stop' }));
        socket.close();
      }
    }
    await sleep(1_000);

    const peakRssKb = rssSamples.length > 0 ? Math.max(...rssSamples) : 0;
    const baselineRssKb = rssSamples[0] ?? 0;
    const peakCpu = cpuSamples.length > 0 ? Math.max(...cpuSamples) : 0;
    const meanCpu =
      cpuSamples.length > 0 ? cpuSamples.reduce((a, b) => a + b, 0) / cpuSamples.length : 0;

    const report = {
      generatedAt: new Date().toISOString(),
      sessions: args.sessions,
      durationSec: args.durationSec,
      socketsOpened,
      socketsFailed,
      connectLatencyMs: {
        p50: percentile(connectLatencies, 50),
        p95: percentile(connectLatencies, 95),
        max: connectLatencies.length > 0 ? Math.max(...connectLatencies) : 0,
      },
      framesSent,
      framesPerSecond: Math.round(framesSent / Math.max(1, args.durationSec)),
      memory: {
        baselineRssKb,
        peakRssKb,
        deltaRssKb: peakRssKb - baselineRssKb,
        perSessionKb:
          args.sessions > 0 ? Math.round((peakRssKb - baselineRssKb) / args.sessions) : 0,
      },
      cpu: { peakPercent: peakCpu, meanPercent: Number(meanCpu.toFixed(1)) },
    };

    if (args.json) {
      log(JSON.stringify(report, null, 2));
    } else {
      log('');
      log(`Sessions              : ${report.sessions}`);
      log(`Connexions ouvertes   : ${report.socketsOpened} (échecs : ${report.socketsFailed})`);
      log(
        `Latence de connexion  : p50 ${report.connectLatencyMs.p50} ms / p95 ${report.connectLatencyMs.p95} ms`,
      );
      log(`Trames envoyées       : ${framesSent} (${report.framesPerSecond}/s)`);
      log(
        `Mémoire process       : +${report.memory.deltaRssKb} Ko (${report.memory.perSessionKb} Ko/session)`,
      );
      log(
        `CPU process           : pic ${report.cpu.peakPercent} % / moyenne ${report.cpu.meanPercent} %`,
      );
      log('');
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`[load] ÉCHEC : ${message}`);
    log(childLog.slice(-20).join(''));
    return 1;
  } finally {
    child.kill('SIGTERM');
    await sleep(1_000);
    if (!child.killed) child.kill('SIGKILL');

    if (createdCallIds.length > 0) {
      try {
        const deleted = await prisma.call.deleteMany({ where: { id: { in: createdCallIds } } });
        log(`[load] nettoyage : ${deleted.count} enregistrement(s) d'appel supprimé(s)`);
      } catch (cleanupError) {
        log(
          `[load] nettoyage impossible : ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        );
      }
    }
    await prisma.$disconnect();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('[load] échec inattendu', error);
    process.exitCode = 1;
  });
