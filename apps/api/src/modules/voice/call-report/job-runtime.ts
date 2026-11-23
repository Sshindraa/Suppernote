/**
 * Câblage réel de la tâche de rapport d'appel : base, stockage privé, journaux de l'API, Deepgram,
 * et mise en file depuis le worker. Voir job.ts pour la logique.
 */
import { db } from '../../../shared/db/client';
import { LONG_TRANSACTION_OPTIONS } from '../../../shared/db/transaction-options';
import { logger } from '../../../shared/logger/pino';
import { buildTelnyxWebhookJobId } from '../../../shared/queue/job-options';
import { redisQueue } from '../../../shared/redis/client';
import {
  getPrivateRecording,
  isTestCallRecordingEnabled,
  putPrivateObject,
} from '../call-recording.service';
import { buildCallDetail } from '../voice-read.routes';
import { transcribeWithDeepgram, type Transcriber } from './deepgram-batch';
import {
  buildCallReportJob,
  reportLimit,
  reserveReportSlot,
  type ReportCallRow,
  type ReportJobDeps,
  type ReportJobResult,
} from './job';
import { readCallLogLines } from './log-files';
import type { ReportTurnRow } from './types';

export const CALL_REPORT_JOB_NAME = 'build-call-report';
const REPORT_COUNTER_KEY = 'call-report:generated';
const DEFAULT_LOG_DIR = '/var/log/suppernote';

function deepgramTranscriber(): Transcriber {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  if (!apiKey) throw new Error('DEEPGRAM_API_KEY not configured');
  return (wav, engine) => transcribeWithDeepgram(wav, engine, { apiKey });
}

async function readBytes(body: unknown): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return new Uint8Array(Buffer.concat(chunks));
}

export function createReportJobDeps(): ReportJobDeps {
  return {
    isAllowed: isTestCallRecordingEnabled,
    findCall: async (callLegId): Promise<ReportCallRow | null> => {
      // tenant-scoping: global — le restaurant est contrôlé juste après contre la liste des restaurants de test.
      return db.call.findUnique({
        where: { callSid: callLegId },
        select: {
          id: true,
          restaurantId: true,
          callSid: true,
          createdAt: true,
          durationSec: true,
          outcome: true,
          intent: true,
          recordingStatus: true,
          recordingStorageKey: true,
          recordingStartedAt: true,
        },
      });
    },
    loadTurns: async (call): Promise<ReportTurnRow[]> => {
      const detail = await buildCallDetail({
        id: call.id,
        restaurantId: call.restaurantId,
        createdAt: call.createdAt,
        durationSec: call.durationSec,
        intent: call.intent,
        outcome: call.outcome,
        sttProvider: null,
        llmProvider: null,
        ttsProvider: null,
      });
      return detail.turns;
    },
    readRecording: async (storageKey) => readBytes((await getPrivateRecording(storageKey)).Body),
    readLogs: (fromMs, toMs) =>
      readCallLogLines({
        dir: process.env.CALL_REPORT_LOG_DIR ?? DEFAULT_LOG_DIR,
        fromMs,
        toMs,
      }),
    reserveSlot: () => reserveReportSlot(redisQueue, reportLimit()),
    releaseSlot: async () => {
      if (reportLimit() !== null) await redisQueue.decr(REPORT_COUNTER_KEY);
    },
    transcribe: (wav, engine) => deepgramTranscriber()(wav, engine),
    store: async (storageKey, body, contentType, call) => {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM calls WHERE id = ${call.id} AND restaurant_id = ${call.restaurantId} FOR UPDATE`;
        const current = await tx.call.findFirst({
          where: {
            id: call.id,
            restaurantId: call.restaurantId,
            recordingStatus: 'AVAILABLE',
            recordingStorageKey: call.recordingStorageKey,
          },
          select: { id: true },
        });
        if (!current) throw new Error('CALL_RECORDING_NO_LONGER_AVAILABLE');
        await putPrivateObject(storageKey, body, contentType);
      }, LONG_TRANSACTION_OPTIONS);
    },
    log: logger,
  };
}

/** Exécutée par le worker : ne lève jamais d'exception. */
export async function runCallReportJob(callLegId: string): Promise<ReportJobResult> {
  return buildCallReportJob(callLegId, createReportJobDeps());
}

/**
 * Appelée par le worker quand l'enregistrement vient d'être stocké. Met la tâche en file, une seule
 * tentative : un rapport manquant ne doit jamais retomber sur le reste.
 */
export async function enqueueCallReport(
  callLegId: string,
  queue: { add: (name: string, data: unknown, opts: Record<string, unknown>) => Promise<unknown> },
): Promise<void> {
  try {
    await queue.add(
      CALL_REPORT_JOB_NAME,
      { callLegId },
      {
        jobId: buildTelnyxWebhookJobId(CALL_REPORT_JOB_NAME, callLegId),
        attempts: 1,
        removeOnComplete: 200,
        removeOnFail: 200,
      },
    );
  } catch (err) {
    logger.warn(
      { callLegId, err: err instanceof Error ? err.message : String(err) },
      '[call-report] could not enqueue (no effect on the recording)',
    );
  }
}
