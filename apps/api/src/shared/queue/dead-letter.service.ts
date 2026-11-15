/**
 * Dead-letter queue operations.
 *
 * Every worker that uses `setupWorkerListeners` moves a job here once it has
 * exhausted its attempts (`workers/helper.ts`). Without this module the queue
 * was write-only: the backlog was alerted on, but nothing could inspect or
 * replay a job.
 *
 * Two payload copies are stored on purpose:
 *
 * - `data`: the untouched job payload. It is required to replay the job, and
 *   Redis already holds the same payload in the origin queue, so this adds no
 *   new storage location for secrets.
 * - `dataPreview`: the redacted payload. This is the only version returned by
 *   read paths (CLI listing, future operator UI, logs).
 *
 * Legacy entries written before this module only contain the redacted payload
 * under `data` and no `payloadVersion`. They stay readable but are refused for
 * replay, because a redacted payload cannot be replayed faithfully.
 */

import type { Job, Queue } from 'bullmq';
import { queues } from './queues';
import {
  agenticExpireHoldQueue,
  agenticExpireQuoteQueue,
  agenticNotifyQueue,
  agenticWaitingListExpireQueue,
} from '../../modules/agentic-reservations/workers/queues';

export const DEAD_LETTER_PAYLOAD_VERSION = 1;

/** Upper bound on how many dead-letter jobs a listing scans. */
export const DEAD_LETTER_LIST_WINDOW = 500;

const SECRET_KEY_PATTERN = /token|secret|apikey|api_key|authorization|password/i;
// Données personnelles des jobs (SMS, e-mails, réservations) : jamais dans les logs ni Sentry.
const PII_KEY_PATTERN =
  /phone|email|address|firstname|lastname|fullname|customername|guestname|^name$|^to$|^from$|^body$|^message$|^text$|notes?$|specialrequests/i;

/**
 * Redacts secret-looking and personal-data keys at any depth. Used for logs, Sentry and the
 * read paths of this module — never for the replayable payload.
 */
export function redactJobData(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(
    JSON.stringify(value, (key, nested) => {
      if (SECRET_KEY_PATTERN.test(key) || PII_KEY_PATTERN.test(key)) return '[REDACTED]';
      return nested;
    }),
  );
}

export interface DeadLetterPayload {
  readonly payloadVersion: number;
  readonly originalQueue: string;
  readonly originalJobId: string | null;
  readonly originalJobName: string;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly stack?: string;
  readonly data: unknown;
  readonly dataPreview: unknown;
  readonly failedAt: string;
}

export interface DeadLetterJobSummary {
  readonly deadLetterJobId: string;
  readonly originalQueue: string;
  readonly originalJobName: string;
  readonly originalJobId: string | null;
  readonly attemptsMade: number;
  readonly failedReason: string;
  readonly failedAt: string | null;
  readonly deadLetteredAt: string | null;
  readonly replayable: boolean;
  readonly dataPreview: unknown;
}

export interface DeadLetterDeps {
  readonly deadLetterQueue: Queue;
  readonly resolveQueue: (queueName: string) => Queue | undefined;
}

export interface BuildDeadLetterPayloadInput {
  readonly queueName: string;
  readonly jobName: string;
  readonly jobId?: string | null;
  readonly attemptsMade: number;
  readonly data: unknown;
  readonly error: { readonly message: string; readonly stack?: string };
  readonly failedAt?: Date;
}

export function buildDeadLetterPayload(input: BuildDeadLetterPayloadInput): DeadLetterPayload {
  return {
    payloadVersion: DEAD_LETTER_PAYLOAD_VERSION,
    originalQueue: input.queueName,
    originalJobId: input.jobId ?? null,
    originalJobName: input.jobName,
    attemptsMade: input.attemptsMade,
    failedReason: input.error.message,
    ...(input.error.stack ? { stack: input.error.stack } : {}),
    data: input.data,
    dataPreview: redactJobData(input.data),
    failedAt: (input.failedAt ?? new Date()).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a stored payload. Returns `null` for legacy or malformed entries so
 * callers can display them without trusting their shape.
 */
export function parseDeadLetterPayload(value: unknown): DeadLetterPayload | null {
  if (!isRecord(value)) return null;
  const { originalQueue, originalJobName, failedReason } = value;
  if (typeof originalQueue !== 'string' || originalQueue.length === 0) return null;
  if (typeof originalJobName !== 'string' || originalJobName.length === 0) return null;
  if (typeof failedReason !== 'string') return null;

  return {
    payloadVersion: typeof value.payloadVersion === 'number' ? value.payloadVersion : 0,
    originalQueue,
    originalJobId: typeof value.originalJobId === 'string' ? value.originalJobId : null,
    originalJobName,
    attemptsMade: typeof value.attemptsMade === 'number' ? value.attemptsMade : 0,
    failedReason,
    ...(typeof value.stack === 'string' ? { stack: value.stack } : {}),
    data: value.data,
    dataPreview: 'dataPreview' in value ? value.dataPreview : undefined,
    failedAt: typeof value.failedAt === 'string' ? value.failedAt : '',
  };
}

/**
 * A payload can be replayed only when it was written with the raw (unredacted)
 * data. Legacy entries default to `payloadVersion: 0` and are therefore refused.
 */
export function isReplayablePayload(payload: DeadLetterPayload | null): boolean {
  if (!payload) return false;
  return payload.payloadVersion >= DEAD_LETTER_PAYLOAD_VERSION;
}

export function summarizeDeadLetterJob(job: Job): DeadLetterJobSummary {
  const payload = parseDeadLetterPayload(job.data);
  return {
    deadLetterJobId: String(job.id),
    originalQueue: payload?.originalQueue ?? 'unknown',
    originalJobName: payload?.originalJobName ?? job.name,
    originalJobId: payload?.originalJobId ?? null,
    attemptsMade: payload?.attemptsMade ?? 0,
    failedReason: payload?.failedReason ?? '',
    failedAt: payload?.failedAt || null,
    deadLetteredAt: job.timestamp ? new Date(job.timestamp).toISOString() : null,
    replayable: isReplayablePayload(payload),
    dataPreview: payload?.dataPreview,
  };
}

export interface ListDeadLetterOptions {
  readonly queue?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export async function listDeadLetterJobs(
  deps: DeadLetterDeps,
  options: ListDeadLetterOptions = {},
): Promise<DeadLetterJobSummary[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 20, DEAD_LETTER_LIST_WINDOW));
  const offset = Math.max(0, options.offset ?? 0);
  const window = Math.min(offset + limit * 4, DEAD_LETTER_LIST_WINDOW);

  const jobs = await deps.deadLetterQueue.getJobs(
    ['waiting', 'delayed', 'active', 'failed'],
    0,
    window - 1,
    false,
  );

  const summaries = jobs
    .map((job) => summarizeDeadLetterJob(job))
    .filter((summary) => !options.queue || summary.originalQueue === options.queue)
    .sort((left, right) => (right.failedAt ?? '').localeCompare(left.failedAt ?? ''));

  return summaries.slice(offset, offset + limit);
}

export interface DeadLetterStats {
  /** Exact count, read from the Redis counters. */
  readonly total: number;
  /** How many entries were inspected to build the breakdown below. */
  readonly scanned: number;
  readonly byOriginalQueue: Record<string, number>;
  readonly oldestFailedAt: string | null;
}

export async function getDeadLetterStats(deps: DeadLetterDeps): Promise<DeadLetterStats> {
  const counts = await deps.deadLetterQueue.getJobCounts('waiting', 'delayed', 'active', 'failed');
  const total = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0);

  const jobs = await deps.deadLetterQueue.getJobs(
    ['waiting', 'delayed', 'active', 'failed'],
    0,
    DEAD_LETTER_LIST_WINDOW - 1,
    false,
  );

  const byOriginalQueue: Record<string, number> = {};
  let oldestFailedAt: string | null = null;
  for (const job of jobs) {
    const summary = summarizeDeadLetterJob(job);
    byOriginalQueue[summary.originalQueue] = (byOriginalQueue[summary.originalQueue] ?? 0) + 1;
    if (summary.failedAt && (!oldestFailedAt || summary.failedAt < oldestFailedAt)) {
      oldestFailedAt = summary.failedAt;
    }
  }

  return { total, scanned: jobs.length, byOriginalQueue, oldestFailedAt };
}

export type ReplayDeadLetterResult =
  | {
      readonly status: 'replayed';
      readonly deadLetterJobId: string;
      readonly queue: string;
      readonly replayedJobId: string | null;
      readonly jobName: string;
    }
  | { readonly status: 'not_found'; readonly deadLetterJobId: string }
  | { readonly status: 'unknown_queue'; readonly deadLetterJobId: string; readonly queue: string }
  | {
      readonly status: 'not_replayable';
      readonly deadLetterJobId: string;
      readonly reason: string;
    };

/**
 * Re-enqueues a dead-letter job on its origin queue with its original name and
 * payload, then removes the dead-letter entry.
 *
 * The new job intentionally gets a fresh BullMQ id: reusing the original id
 * would collide with the failed job still retained in the origin queue.
 */
export async function replayDeadLetterJob(
  deps: DeadLetterDeps,
  deadLetterJobId: string,
): Promise<ReplayDeadLetterResult> {
  const job = await deps.deadLetterQueue.getJob(deadLetterJobId);
  if (!job) return { status: 'not_found', deadLetterJobId };

  const payload = parseDeadLetterPayload(job.data);
  if (!isReplayablePayload(payload) || !payload) {
    return {
      status: 'not_replayable',
      deadLetterJobId,
      reason:
        'Entry stored before replay support: payload was redacted and cannot be replayed faithfully.',
    };
  }

  const target = deps.resolveQueue(payload.originalQueue);
  if (!target) {
    return { status: 'unknown_queue', deadLetterJobId, queue: payload.originalQueue };
  }

  const replayed = await target.add(payload.originalJobName, payload.data, {
    removeOnComplete: 1000,
    removeOnFail: false,
  });
  await job.remove();

  return {
    status: 'replayed',
    deadLetterJobId,
    queue: payload.originalQueue,
    replayedJobId: replayed?.id ? String(replayed.id) : null,
    jobName: payload.originalJobName,
  };
}

export type DiscardDeadLetterResult =
  | { readonly status: 'discarded'; readonly deadLetterJobId: string; readonly reason: string }
  | { readonly status: 'not_found'; readonly deadLetterJobId: string }
  | { readonly status: 'invalid_argument'; readonly message: string };

/** Removes a dead-letter entry after an explicit human triage decision. */
export async function discardDeadLetterJob(
  deps: DeadLetterDeps,
  deadLetterJobId: string,
  reason: string,
): Promise<DiscardDeadLetterResult> {
  if (!reason || reason.trim().length < 3) {
    return {
      status: 'invalid_argument',
      message: 'A discard reason of at least 3 characters is required.',
    };
  }

  const job = await deps.deadLetterQueue.getJob(deadLetterJobId);
  if (!job) return { status: 'not_found', deadLetterJobId };

  await job.remove();
  return { status: 'discarded', deadLetterJobId, reason: reason.trim() };
}

export function createDeadLetterDeps(): DeadLetterDeps {
  const registry = new Map<string, Queue>();
  for (const queue of Object.values(queues)) {
    registry.set(queue.name, queue);
  }
  for (const queue of [
    agenticExpireHoldQueue,
    agenticExpireQuoteQueue,
    agenticNotifyQueue,
    agenticWaitingListExpireQueue,
  ]) {
    registry.set(queue.name, queue);
  }

  return {
    deadLetterQueue: queues.deadLetter,
    resolveQueue: (queueName) => registry.get(queueName),
  };
}
