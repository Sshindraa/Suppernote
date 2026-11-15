import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { sanitizeJobId } from './job-options';

export type NotificationProvider = 'telnyx' | 'brevo' | 'resend' | 'meta';
export type NotificationChannel = 'sms' | 'whatsapp' | 'email';
export type NotificationProviderResult = 'success' | 'failure_certain' | 'unknown';
export type NotificationClaimStatus = 'in_progress' | 'unknown' | 'success';

/** Safe, non-PII error used to let BullMQ retry an explicit provider refusal. */
export class NotificationProviderRefusedError extends Error {
  readonly notificationResult = 'failure_certain' as const;

  constructor(
    readonly provider: NotificationProvider,
    readonly channel: NotificationChannel,
  ) {
    super(`${provider} ${channel} provider refused the notification`);
    this.name = 'NotificationProviderRefusedError';
  }
}

/** Receipt returned by a provider adapter without exposing provider payloads. */
export interface NotificationSendResult {
  outcome: NotificationProviderResult;
  provider: NotificationProvider;
  channel: NotificationChannel;
  providerMessageId?: string;
  /** Code sans donnée personnelle expliquant un `failure_certain`, repris dans les journaux. */
  reason?: string;
}

/** Minimal Redis surface needed by notification claims. */
export interface NotificationClaimStore {
  set(
    key: string,
    value: string,
    expirationMode: 'EX',
    expirationSeconds: number,
    existenceMode?: 'NX',
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  /** Optional in tests; the real ioredis client supports EVAL. */
  eval?(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  /** Optional in tests; used only by the daily reconciliation sweep. */
  scan?: Redis['scan'];
}

export interface NotificationClaimMetadata {
  provider: NotificationProvider;
  channel: NotificationChannel;
  providerMessageId?: string;
}

export interface NotificationClaimRecord extends Partial<NotificationClaimMetadata> {
  version: 1;
  status: NotificationClaimStatus;
  token?: string;
  updatedAt: string;
}

export interface NotificationClaimAttempt {
  acquired: boolean;
  token?: string;
  record?: NotificationClaimRecord;
}

export interface NotificationReconciliationJobData {
  readonly kind: 'notification';
  readonly claimKey: string;
  readonly provider: NotificationProvider;
  readonly channel: NotificationChannel;
  readonly providerMessageId?: string;
}

export interface NotificationReconciliationQueue {
  add(
    name: string,
    data: NotificationReconciliationJobData,
    options: { jobId: string },
  ): Promise<unknown>;
}

/** Long enough to cover provider retries and a duplicate scheduler run. */
export const NOTIFICATION_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Short lease used to distinguish a live provider attempt from an orphan. */
export const NOTIFICATION_CLAIM_LEASE_SECONDS = 15 * 60;
export const NOTIFICATION_CLAIM_SCAN_COUNT = 100;

export type NotificationClaimRecoveryStatus =
  | 'active'
  | 'not_found'
  | 'not_orphaned'
  | 'recovered'
  | 'manual'
  | 'raced';

export interface NotificationClaimRecoveryResult {
  status: NotificationClaimRecoveryStatus;
  record?: NotificationClaimRecord;
}

const CLAIM_COMPARE_AND_REPLACE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local token = '"token":"' .. ARGV[1] .. '"'
if not string.find(current, token, 1, true) then return 0 end
if ARGV[2] == '__DELETE__' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
end
return 1
`;

const CLAIM_COMPARE_AND_REPLACE_IF_STATUS_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if not current then return 0 end
local token = '"token":"' .. ARGV[1] .. '"'
local status = '"status":"' .. ARGV[2] .. '"'
if not string.find(current, token, 1, true) then return 0 end
if not string.find(current, status, 1, true) then return 0 end
if ARGV[3] == '__DELETE__' then
  redis.call('DEL', KEYS[1])
else
  redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
end
return 1
`;

export function buildNotificationClaimKey(kind: string, businessKey: string): string {
  return `notification:${sanitizeJobId(kind)}:${sanitizeJobId(businessKey)}`;
}

export function buildNotificationReconciliationJobId(claimKey: string): string {
  return sanitizeJobId(`notification-reconciliation_${claimKey}`);
}

function isProvider(value: unknown): value is NotificationProvider {
  return value === 'telnyx' || value === 'brevo' || value === 'resend' || value === 'meta';
}

function isChannel(value: unknown): value is NotificationChannel {
  return value === 'sms' || value === 'whatsapp' || value === 'email';
}

function isClaimStatus(value: unknown): value is NotificationClaimStatus {
  return value === 'in_progress' || value === 'unknown' || value === 'success';
}

function serializeClaim(record: NotificationClaimRecord): string {
  return JSON.stringify(record);
}

/**
 * Old Phase 3B values (`claimed`) are interpreted conservatively as an
 * in-progress attempt. They must never be treated as permission to resend.
 */
export function parseNotificationClaim(raw: string | null): NotificationClaimRecord | null {
  if (!raw) return null;
  if (raw === 'claimed') {
    return { version: 1, status: 'in_progress', updatedAt: '' };
  }

  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (!isClaimStatus(value.status) || value.version !== 1) return null;

    return {
      version: 1,
      status: value.status,
      ...(typeof value.token === 'string' ? { token: value.token } : {}),
      ...(isProvider(value.provider) ? { provider: value.provider } : {}),
      ...(isChannel(value.channel) ? { channel: value.channel } : {}),
      ...(typeof value.providerMessageId === 'string'
        ? { providerMessageId: value.providerMessageId }
        : {}),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : '',
    };
  } catch {
    return null;
  }
}

export async function getNotificationClaim(
  store: NotificationClaimStore,
  key: string,
): Promise<NotificationClaimRecord | null> {
  return parseNotificationClaim(await store.get(key));
}

export function isNotificationClaimOrphaned(
  record: NotificationClaimRecord,
  now = Date.now(),
  leaseSeconds = NOTIFICATION_CLAIM_LEASE_SECONDS,
): boolean {
  if (record.status !== 'in_progress') return false;
  if (!record.updatedAt) return true;
  const updatedAt = Date.parse(record.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return now - updatedAt >= leaseSeconds * 1000;
}

/**
 * Acquires a side-effect claim for a stable business key. The token makes
 * state transitions safe against a stale worker or a concurrent reconciler.
 */
export async function acquireNotificationClaim(
  store: NotificationClaimStore,
  key: string,
  metadata?: Partial<NotificationClaimMetadata>,
  ttlSeconds = NOTIFICATION_CLAIM_TTL_SECONDS,
): Promise<NotificationClaimAttempt> {
  const token = randomUUID();
  const record: NotificationClaimRecord = {
    version: 1,
    status: 'in_progress',
    token,
    ...(metadata?.provider ? { provider: metadata.provider } : {}),
    ...(metadata?.channel ? { channel: metadata.channel } : {}),
    ...(metadata?.providerMessageId ? { providerMessageId: metadata.providerMessageId } : {}),
    updatedAt: new Date().toISOString(),
  };
  const result = await store.set(key, serializeClaim(record), 'EX', ttlSeconds, 'NX');
  if (result === 'OK') return { acquired: true, token, record };

  return { acquired: false, record: (await getNotificationClaim(store, key)) ?? undefined };
}

/**
 * Backward-compatible boolean facade for callers that only need to know if
 * they own the claim. New code should use `acquireNotificationClaim` so it
 * can distinguish an unknown result from a concurrent in-progress attempt.
 */
export async function claimNotification(
  store: NotificationClaimStore,
  key: string,
  ttlSeconds = NOTIFICATION_CLAIM_TTL_SECONDS,
  metadata?: Partial<NotificationClaimMetadata>,
): Promise<boolean> {
  return (await acquireNotificationClaim(store, key, metadata, ttlSeconds)).acquired;
}

async function compareAndReplaceClaim(
  store: NotificationClaimStore,
  key: string,
  token: string,
  next: NotificationClaimRecord | null,
  ttlSeconds: number,
): Promise<boolean> {
  const serialized = next ? serializeClaim(next) : '__DELETE__';
  if (store.eval) {
    const result = await store.eval(
      CLAIM_COMPARE_AND_REPLACE_SCRIPT,
      1,
      key,
      token,
      serialized,
      String(ttlSeconds),
    );
    return result === 1 || result === '1';
  }

  // The fallback is intentionally only for simple fakes. Production uses
  // Redis EVAL so compare-and-replace is atomic across workers.
  const current = await getNotificationClaim(store, key);
  if (!current || current.token !== token) return false;
  if (!next) {
    await store.del(key);
    return true;
  }
  await store.set(key, serialized, 'EX', ttlSeconds);
  return true;
}

async function compareAndReplaceClaimIfStatus(
  store: NotificationClaimStore,
  key: string,
  token: string,
  expectedStatus: NotificationClaimStatus,
  next: NotificationClaimRecord | null,
  ttlSeconds: number,
): Promise<boolean> {
  const serialized = next ? serializeClaim(next) : '__DELETE__';
  if (store.eval) {
    const result = await store.eval(
      CLAIM_COMPARE_AND_REPLACE_IF_STATUS_SCRIPT,
      1,
      key,
      token,
      expectedStatus,
      serialized,
      String(ttlSeconds),
    );
    return result === 1 || result === '1';
  }

  const current = await getNotificationClaim(store, key);
  if (!current || current.token !== token || current.status !== expectedStatus) return false;
  if (!next) {
    await store.del(key);
    return true;
  }
  await store.set(key, serialized, 'EX', ttlSeconds);
  return true;
}

/**
 * Moves an unknown result back to an in-progress reconciliation lease. The
 * original token is retained so a late original worker result can still win
 * safely; only one reconciler can own the lease at a time.
 */
export async function acquireNotificationReconciliationLease(
  store: NotificationClaimStore,
  key: string,
  now = new Date().toISOString(),
): Promise<NotificationClaimAttempt> {
  const current = await getNotificationClaim(store, key);
  if (!current || current.status !== 'unknown' || !current.token) {
    return { acquired: false, record: current ?? undefined };
  }

  const next: NotificationClaimRecord = {
    ...current,
    status: 'in_progress',
    updatedAt: now,
  };
  const transitioned = await compareAndReplaceClaimIfStatus(
    store,
    key,
    current.token,
    'unknown',
    next,
    NOTIFICATION_CLAIM_TTL_SECONDS,
  );
  return transitioned
    ? { acquired: true, token: current.token, record: next }
    : { acquired: false, record: (await getNotificationClaim(store, key)) ?? undefined };
}

/**
 * Reclaims an old in-progress attempt conservatively. It never calls a
 * provider: an orphan becomes unknown and must go through reconciliation.
 */
export async function recoverNotificationClaim(
  store: NotificationClaimStore,
  key: string,
  now = Date.now(),
  leaseSeconds = NOTIFICATION_CLAIM_LEASE_SECONDS,
): Promise<NotificationClaimRecoveryResult> {
  const current = await getNotificationClaim(store, key);
  if (!current) return { status: 'not_found' };
  if (current.status !== 'in_progress') {
    return { status: 'not_orphaned', record: current };
  }
  if (!isNotificationClaimOrphaned(current, now, leaseSeconds)) {
    return { status: 'active', record: current };
  }
  if (!current.token || !current.provider || !current.channel) {
    return { status: 'manual', record: current };
  }

  const next: NotificationClaimRecord = {
    ...current,
    status: 'unknown',
    updatedAt: new Date().toISOString(),
  };
  const transitioned = await compareAndReplaceClaimIfStatus(
    store,
    key,
    current.token,
    'in_progress',
    next,
    NOTIFICATION_CLAIM_TTL_SECONDS,
  );
  if (transitioned) {
    return { status: 'recovered', record: (await getNotificationClaim(store, key)) ?? undefined };
  }

  const latest = await getNotificationClaim(store, key);
  return latest ? { status: 'raced', record: latest } : { status: 'not_found' };
}

/** Scans only the bounded notification namespace; never scans provider payloads. */
export async function scanNotificationClaimKeys(
  store: NotificationClaimStore,
  count = NOTIFICATION_CLAIM_SCAN_COUNT,
): Promise<string[]> {
  if (!store.scan) return [];
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await store.scan(
      cursor,
      'MATCH',
      'notification:*',
      'COUNT',
      String(count),
    );
    keys.push(...batch);
    cursor = nextCursor;
  } while (cursor !== '0');
  return keys;
}

export async function recordNotificationResult(
  store: NotificationClaimStore,
  key: string,
  token: string,
  outcome: NotificationProviderResult,
  metadata: Partial<NotificationClaimMetadata> = {},
  ttlSeconds = NOTIFICATION_CLAIM_TTL_SECONDS,
): Promise<boolean> {
  if (outcome === 'failure_certain') {
    return compareAndReplaceClaim(store, key, token, null, ttlSeconds);
  }

  const record: NotificationClaimRecord = {
    version: 1,
    status: outcome === 'success' ? 'success' : 'unknown',
    token,
    ...(metadata.provider ? { provider: metadata.provider } : {}),
    ...(metadata.channel ? { channel: metadata.channel } : {}),
    ...(metadata.providerMessageId ? { providerMessageId: metadata.providerMessageId } : {}),
    updatedAt: new Date().toISOString(),
  };
  return compareAndReplaceClaim(store, key, token, record, ttlSeconds);
}

/** Release only a certain failure; token-aware when available. */
export async function releaseNotificationClaim(
  store: NotificationClaimStore,
  key: string,
  token?: string,
): Promise<void> {
  if (token) {
    await compareAndReplaceClaim(store, key, token, null, NOTIFICATION_CLAIM_TTL_SECONDS);
    return;
  }
  await store.del(key);
}

export async function enqueueNotificationReconciliation(
  queue: NotificationReconciliationQueue,
  request: Omit<NotificationReconciliationJobData, 'kind'>,
): Promise<void> {
  const data: NotificationReconciliationJobData = { kind: 'notification', ...request };
  await queue.add('notification-status', data, {
    jobId: buildNotificationReconciliationJobId(request.claimKey),
  });
}

/**
 * Normalises an adapter that still returns void. A resolved call is an
 * explicit provider success; exceptions are classified separately by the
 * worker or sender that owns the claim.
 */
export function normalizeNotificationSendResult(
  result: NotificationSendResult | void,
  provider: NotificationProvider,
  channel: NotificationChannel,
): NotificationSendResult {
  if (!result) return { outcome: 'success', provider, channel };
  return {
    outcome: result.outcome,
    provider: result.provider ?? provider,
    channel: result.channel ?? channel,
    ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

export function extractProviderMessageId(value: unknown): string | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 3; depth++) {
    const record = asRecord(current);
    if (!record) return undefined;
    for (const key of ['providerMessageId', 'messageId', 'id']) {
      if (typeof record[key] === 'string' && record[key]) return record[key];
    }
    current = record.data ?? record.response ?? record.cause;
  }
  return undefined;
}

function extractStatusCode(value: unknown): number | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 3; depth++) {
    const record = asRecord(current);
    if (!record) return undefined;
    for (const key of ['status', 'statusCode', 'status_code']) {
      const candidate = record[key];
      if (typeof candidate === 'number') return candidate;
      if (typeof candidate === 'string' && /^\d{3}$/.test(candidate)) return Number(candidate);
    }
    current = record.response ?? record.cause;
  }
  return undefined;
}

/**
 * Conservative error classification. Only explicit 4xx/provider refusals or
 * local validation/configuration errors are certain failures. Network errors,
 * aborts, timeouts and 5xx remain unknown because acceptance may have happened.
 */
export function classifyNotificationError(error: unknown): NotificationProviderResult {
  const record = asRecord(error);
  const explicitOutcome = record?.notificationResult;
  if (
    explicitOutcome === 'success' ||
    explicitOutcome === 'failure_certain' ||
    explicitOutcome === 'unknown'
  ) {
    return explicitOutcome;
  }

  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    if (statusCode >= 500 || statusCode === 408) return 'unknown';
    if (statusCode >= 400 && statusCode < 500) return 'failure_certain';
  }

  const name = record?.name;
  const code = record?.code;
  if (
    name === 'AbortError' ||
    code === 'ABORT_ERR' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'EPIPE' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return 'unknown';
  }

  const message = record?.message;
  if (
    typeof message === 'string' &&
    /required|not set|not configured|invalid (phone|email|recipient|sender)|validation/i.test(
      message,
    )
  ) {
    return 'failure_certain';
  }

  return 'unknown';
}

export function getNotificationErrorProviderMessageId(error: unknown): string | undefined {
  return extractProviderMessageId(error);
}
