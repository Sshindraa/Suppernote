#!/usr/bin/env tsx
/**
 * Génère le rapport d'un appel enregistré depuis le poste local, sans rien déployer.
 *
 * Tout ce qui est privé reste sur le VPS ou dans un dossier hors dépôt : l'enregistrement, le
 * dialogue et les journaux sont lus par SSH ; la clé Deepgram ne quitte pas le VPS (le script distant
 * lit le WAV sur stdin et ne renvoie que la réponse de Deepgram). Sert à valider le rapport sur des
 * appels déjà enregistrés avant d'activer le déclenchement automatique.
 *
 *   pnpm --filter @suppernote/api exec tsx scripts/call-report-local.ts <début-de-l-id-d-appel> [--out dossier] [--host deploy@suppernote]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  engineQuery,
  parseDeepgramResponse,
  type Transcriber,
} from '../src/modules/voice/call-report/deepgram-batch';
import { generateCallReport } from '../src/modules/voice/call-report/generate';
import { renderMarkdown } from '../src/modules/voice/call-report/markdown';
import type { ReportCall, ReportTurnRow } from '../src/modules/voice/call-report/types';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const selector = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
const host = flag('--host', process.env.SOKAR_SSH_HOST ?? 'deploy@suppernote');
const outRoot = flag('--out', path.join(os.tmpdir(), 'sokar-call-reports'));
if (!selector) throw new Error('Usage : call-report-local.ts <début-de-l-id-d-appel>');

function ssh(command: string, input?: Buffer): Buffer {
  const result = spawnSync('ssh', [host, command], { input, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) {
    const noise = result.stderr
      .toString()
      .split('\n')
      .filter((line) => line && !line.includes('"level":30'));
    throw new Error(`ssh a échoué : ${noise.slice(-3).join(' / ') || result.status}`);
  }
  return result.stdout;
}

const REMOTE_FETCH = String.raw`
const { db } = require('./dist/shared/db/client.js');
const { getPrivateRecording } = require('./dist/modules/voice/call-recording.service.js');
(async () => {
  const [selector] = process.argv.slice(1);
  const call = await db.call.findFirst({
    where: { id: { startsWith: selector } }, orderBy: { createdAt: 'desc' },
    select: { id: true, restaurantId: true, callSid: true, recordingStatus: true, recordingStorageKey: true,
              recordingStartedAt: true, createdAt: true, durationSec: true, outcome: true, intent: true },
  });
  if (!call) { process.stderr.write('Appel introuvable\n'); process.exit(2); }
  if (call.recordingStatus !== 'AVAILABLE' || !call.recordingStorageKey) {
    process.stderr.write('Enregistrement indisponible (' + call.recordingStatus + ')\n'); process.exit(3);
  }
  const object = await getPrivateRecording(call.recordingStorageKey);
  const chunks = [];
  for await (const chunk of object.Body) chunks.push(chunk);
  const header = Buffer.from(JSON.stringify(call) + '\n');
  process.stdout.write(Buffer.concat([header, ...chunks]), () => process.exit(0));
})().catch((err) => { process.stderr.write(String(err && err.message) + '\n'); process.exit(1); });
`;

const REMOTE_TURNS = String.raw`
T=$(sed -n "s/^SOKAR_VOICE_READ_TOKEN=//p" .env | head -1 | tr -d '"')
curl -sf -H "Authorization: Bearer $T" "http://127.0.0.1:4000/api/internal/voice/calls/$1"
`;

const REMOTE_DEEPGRAM = String.raw`
(async () => {
  const chunks = []; for await (const c of process.stdin) chunks.push(c);
  const r = await fetch('https://api.deepgram.com/v1/listen?' + process.argv[2], {
    method: 'POST',
    headers: { Authorization: 'Token ' + process.env.DEEPGRAM_API_KEY, 'Content-Type': 'audio/wav' },
    body: Buffer.concat(chunks) });
  process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() }), () => process.exit(0));
})();
`;

/** Lignes de journal de la fenêtre de l'appel : minutes UTC concernées, tous les fichiers de rotation. */
function fetchLogLines(createdAt: string, durationSec: number): string[] {
  const start = Date.parse(createdAt) - 30_000;
  const end = Date.parse(createdAt) + (durationSec + 90) * 1000;
  const minutes = new Set<string>();
  for (let at = start; at <= end; at += 30_000)
    minutes.add(new Date(at).toISOString().slice(0, 16));
  const patterns = [...minutes].map((minute) => `-e '"time":"${minute}'`).join(' ');
  const command = `cd /var/log/suppernote && (zcat -f api-out.log.*.gz 2>/dev/null; cat api-out.log.1 api-out.log 2>/dev/null) | grep -F ${patterns} || true`;
  return ssh(command).toString().split('\n').filter(Boolean);
}

const REMOTE_DEEPGRAM_FILE = `/tmp/sokar-call-report-dg-${process.pid}.cjs`;

/** Les réponses de Deepgram sont gardées (hors dépôt) : relancer le rapport ne coûte rien. `--refresh` les ignore. */
const cacheDir = path.join(outRoot, '.deepgram-cache');
const refresh = args.includes('--refresh');

const transcribe: Transcriber = async (wav, engine) => {
  const key = createHash('sha256').update(wav).update(engine).digest('hex').slice(0, 24);
  const cached = path.join(cacheDir, `${key}.json`);
  if (!refresh && existsSync(cached)) {
    return parseDeepgramResponse(engine, JSON.parse(readFileSync(cached, 'utf8')));
  }
  const remote = `cd /opt/suppernote/apps/api && node --env-file=.env ${REMOTE_DEEPGRAM_FILE} '${engineQuery(engine)}'`;
  const reply = JSON.parse(ssh(remote, Buffer.from(wav)).toString()) as {
    status: number;
    body: string;
  };
  if (reply.status !== 200)
    throw new Error(`Deepgram ${engine} : HTTP ${reply.status} ${reply.body.slice(0, 200)}`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, reply.body);
  return parseDeepgramResponse(engine, JSON.parse(reply.body));
};

async function main(): Promise<void> {
  const raw = ssh(
    `cd /opt/suppernote/apps/api && node --env-file=.env -e "$(cat)" ${selector}`,
    Buffer.from(REMOTE_FETCH),
  );
  const newline = raw.indexOf(10);
  const row = JSON.parse(raw.subarray(0, newline).toString()) as Record<
    string,
    string | number | null
  >;
  const mp3 = new Uint8Array(raw.subarray(newline + 1));
  const call: ReportCall = {
    id: String(row.id),
    restaurantId: String(row.restaurantId),
    callSid: String(row.callSid),
    createdAt: String(row.createdAt),
    durationSec: (row.durationSec as number | null) ?? null,
    outcome: (row.outcome as string | null) ?? null,
    intent: (row.intent as string | null) ?? null,
    recordingStartedAt: (row.recordingStartedAt as string | null) ?? null,
  };

  let turns: ReportTurnRow[] = [];
  try {
    const detail = JSON.parse(
      ssh(
        `cd /opt/suppernote/apps/api && bash -s -- ${call.id}`,
        Buffer.from(REMOTE_TURNS),
      ).toString(),
    ) as {
      turns?: ReportTurnRow[];
    };
    turns = detail.turns ?? [];
  } catch {
    process.stderr.write('Dialogue par tour indisponible : le rapport sera réduit.\n');
  }
  const logLines = fetchLogLines(call.createdAt, call.durationSec ?? 120);

  ssh(`cat > ${REMOTE_DEEPGRAM_FILE}`, Buffer.from(REMOTE_DEEPGRAM));
  let report;
  try {
    report = await generateCallReport({ call, turns, logLines, mp3 }, { transcribe });
  } finally {
    ssh(`rm -f ${REMOTE_DEEPGRAM_FILE}`);
  }
  const folder = path.join(outRoot, call.id.slice(0, 8));
  mkdirSync(folder, { recursive: true });
  writeFileSync(path.join(folder, 'report.json'), JSON.stringify(report, null, 1));
  const markdown = renderMarkdown(report);
  writeFileSync(path.join(folder, 'report.md'), markdown);
  process.stdout.write(markdown);
  process.stderr.write(
    `\nRapport écrit dans ${folder} (coût estimé ${report.costUsd.toFixed(4)} $)\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
