import { Worker, type Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { redisQueue } from '../../redis/client';
import { db } from '../../db/client';
import { queues } from '../queues';
import { lookupResendEmail } from '../../email';
import { lookupTelnyxMessage } from '../../telnyx/client';
import { lookupMetaStatus } from '../../whatsapp/meta-status';
import {
  recordNotificationClaimEvent,
  recordNotificationProviderResult,
} from '../../observability/metrics';
import { setupWorkerListeners, jobLogger } from './helper';
import {
  acquireNotificationReconciliationLease,
  buildNotificationReconciliationJobId,
  getNotificationClaim,
  recoverNotificationClaim,
  scanNotificationClaimKeys,
  type NotificationClaimStore,
  type NotificationProvider,
  type NotificationProviderResult,
  type NotificationReconciliationQueue,
  type NotificationReconciliationJobData,
} from '../notification-idempotency';
import { recordNotificationResult } from '../notification-idempotency';
import {
  repairNotificationAfterProviderSuccess,
  type NotificationRepairStatus,
} from '../notification-repair';
import {
  finalizeVoiceCall,
  type CallFinalizationDependencies,
} from '../../../modules/voice/call-finalization.service';
import { purgeTestReservations } from '../../../modules/reservations/test-reservation-purge';
import { purgeMarketingRetention } from '../../../modules/marketing/marketing-retention-purge';
import { expireReservationPayments } from '../../../modules/reservation-payments/reservation-payment.service';
import { initGreetingCache } from '../../../modules/voice/stream/greeting-cache';
import { checkVoiceCapacityHeadroom } from '../../../modules/voice/call-capacity';

interface DailyReconciliationJobData {
  readonly kind:
    | 'calls'
    | 'sms'
    | 'voice-finalization'
    | 'test-reservation-purge'
    | 'marketing-retention-purge'
    | 'reservation-payment-expiry'
    | 'greeting-warm'
    | 'voice-capacity-check';
  readonly dayKey?: string;
}

/** Fenêtre du rattrapage fréquent : garde les rappels utiles et borne le balayage. */
const VOICE_FINALIZATION_MIN_AGE_MS = 10 * 60 * 1000;
const VOICE_FINALIZATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const VOICE_FINALIZATION_BATCH_SIZE = 200;

export type ReconciliationJobData = DailyReconciliationJobData | NotificationReconciliationJobData;

export type NotificationProviderLookup = (input: {
  provider: NotificationProvider;
  channel: NotificationReconciliationJobData['channel'];
  providerMessageId: string;
}) => Promise<NotificationProviderResult>;

interface ManualReviewQueue {
  add(name: string, data: unknown, options: { jobId: string }): Promise<unknown>;
}

export interface ReconciliationDependencies {
  db: PrismaClient;
  claimStore: NotificationClaimStore;
  lookupProviderMessage: NotificationProviderLookup;
  deadLetterQueue: ManualReviewQueue;
  reconciliationQueue?: NotificationReconciliationQueue;
  repairNotification?: (claimKey: string, now?: Date) => Promise<NotificationRepairStatus>;
  /**
   * Injection de la finalisation d'appel : permet au rattrapage de déclencher
   * la récupération commerciale (le worker n'a pas le contexte restaurant).
   */
  enqueueRecovery?: CallFinalizationDependencies['enqueueRecovery'];
  loadRestaurantContext?: CallFinalizationDependencies['loadRestaurantContext'];
}

function getDefaultDependencies(): ReconciliationDependencies {
  return {
    db,
    claimStore: redisQueue,
    lookupProviderMessage: async ({ provider, providerMessageId }) => {
      if (provider === 'resend') return lookupResendEmail(providerMessageId);
      if (provider === 'meta') return lookupMetaStatus(redisQueue, providerMessageId);
      return lookupTelnyxMessage(providerMessageId);
    },
    deadLetterQueue: queues.deadLetter,
    reconciliationQueue: queues.reconciliation,
    repairNotification: (claimKey, now) =>
      repairNotificationAfterProviderSuccess(db, claimKey, now),
    // Le worker connaît la queue de récupération ; le contexte restaurant est
    // résolu depuis le numéro appelé quand le hint le porte.
    enqueueRecovery: async (input, callLegId) => {
      const { sanitizeJobId } = await import('../job-options');
      await queues.callRecovery.add('send-recovery-sms', input, {
        jobId: sanitizeJobId(`recovery_${callLegId}`),
      });
    },
    loadRestaurantContext: async (toNumber) => {
      const { RestaurantService } = await import('../../../modules/restaurants/restaurant.service');
      const ctx = await RestaurantService.loadContext(toNumber);
      return {
        id: ctx.id,
        name: ctx.name,
        slug: ctx.slug ?? null,
        phoneNumber: ctx.phoneNumber ?? null,
      };
    },
  };
}

function yesterdayKey(): string {
  return new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function getDayRange(dayKey = yesterdayKey()): { start: Date; end: Date; dayKey: string } {
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  const end = new Date(`${dayKey}T23:59:59.999Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error(`Invalid reconciliation dayKey: ${dayKey}`);
  }
  return { start, end, dayKey };
}

function buildManualReviewJobId(claimKey: string): string {
  return `${buildNotificationReconciliationJobId(claimKey)}_manual`;
}

async function enqueueManualReview(
  deps: ReconciliationDependencies,
  data: NotificationReconciliationJobData,
  reason:
    | 'provider_status_unavailable'
    | 'provider_message_id_missing'
    | 'local_repair_failed'
    | 'claim_metadata_missing',
): Promise<void> {
  await deps.deadLetterQueue.add(
    'notification-reconciliation-manual',
    {
      kind: 'notification-reconciliation-manual',
      claimKey: data.claimKey,
      provider: data.provider,
      channel: data.channel,
      ...(data.providerMessageId ? { providerMessageId: data.providerMessageId } : {}),
      reason,
      createdAt: new Date().toISOString(),
    },
    { jobId: buildManualReviewJobId(data.claimKey) },
  );
}

async function enqueueClaimReconciliation(
  deps: ReconciliationDependencies,
  data: NotificationReconciliationJobData,
): Promise<void> {
  if (!deps.reconciliationQueue) {
    throw new Error('notification reconciliation queue unavailable');
  }
  await deps.reconciliationQueue.add('notification-status', data, {
    jobId: buildNotificationReconciliationJobId(data.claimKey),
  });
}

async function sweepNotificationClaims(
  deps: ReconciliationDependencies,
  log: ReturnType<typeof jobLogger>,
): Promise<void> {
  if (!deps.claimStore.scan) {
    recordNotificationClaimEvent('scan_unavailable');
    log.warn('notification claim sweep skipped: Redis scan unavailable');
    return;
  }

  let keys: string[];
  try {
    keys = await scanNotificationClaimKeys(deps.claimStore);
  } catch (err) {
    recordNotificationClaimEvent('scan_failed');
    log.error({ err }, 'notification claim sweep failed');
    return;
  }

  for (const claimKey of keys) {
    let recovery;
    try {
      recovery = await recoverNotificationClaim(deps.claimStore, claimKey);
    } catch (err) {
      log.error({ err }, 'notification claim recovery failed');
      continue;
    }

    const record = recovery.record ?? (await getNotificationClaim(deps.claimStore, claimKey));
    if (!record) continue;
    if (record.status === 'success') {
      // Give the original worker time to write its audit before repairing it.
      if (
        /^notification:reservation-confirmation-(sms|email):/.test(claimKey) &&
        Date.now() - Date.parse(record.updatedAt) >= 15 * 60 * 1000
      ) {
        try {
          const acquired = await deps.claimStore.set(
            `audit-repair:${claimKey}`,
            '1',
            'EX',
            60,
            'NX',
          );
          if (!acquired) continue;
          const repair =
            deps.repairNotification ?? repairNotificationAfterProviderSuccess.bind(null, deps.db);
          await repair(claimKey, new Date());
        } catch (err) {
          log.error({ err }, 'successful notification audit repair failed');
        }
      }
      continue;
    }
    if (recovery.status === 'active') {
      recordNotificationClaimEvent('active');
      continue;
    }
    if (recovery.status === 'recovered') recordNotificationClaimEvent('orphan_recovered');
    if (recovery.status === 'raced') recordNotificationClaimEvent('raced');
    if (recovery.status === 'manual') recordNotificationClaimEvent('manual_review');

    const provider = record.provider;
    const channel = record.channel;
    const data =
      provider && channel
        ? {
            kind: 'notification' as const,
            claimKey,
            provider,
            channel,
            ...(record.providerMessageId ? { providerMessageId: record.providerMessageId } : {}),
          }
        : null;

    if (!data) {
      try {
        await enqueueManualReview(
          deps,
          {
            kind: 'notification',
            claimKey,
            provider: 'telnyx',
            channel: 'sms',
          },
          'claim_metadata_missing',
        );
      } catch (err) {
        recordNotificationClaimEvent('queue_unavailable');
        log.error({ err }, 'notification claim manual review enqueue failed');
      }
      continue;
    }

    try {
      await enqueueClaimReconciliation(deps, data);
      recordNotificationClaimEvent('unknown_requeued');
    } catch (err) {
      recordNotificationClaimEvent('queue_unavailable');
      log.error({ err }, 'notification claim reconciliation enqueue failed');
    }
  }

  log.info({ scanned: keys.length }, 'notification claim sweep complete');
}

async function processNotificationReconciliation(
  job: Job<NotificationReconciliationJobData>,
  deps: ReconciliationDependencies,
): Promise<void> {
  const log = jobLogger(job);
  const data = job.data;
  const claim = await getNotificationClaim(deps.claimStore, data.claimKey);

  if (!claim) {
    log.warn({ outcome: 'unknown' }, 'notification reconciliation claim not found');
    return;
  }
  if (claim.status === 'success') {
    log.info({ outcome: 'reconciled_success' }, 'notification reconciliation already successful');
    return;
  }
  if (claim.status !== 'unknown') {
    // A job can race with the worker before it records the provider result.
    // It must not query or send while the original attempt is in progress.
    log.info({ outcome: 'unknown' }, 'notification reconciliation deferred: claim in progress');
    return;
  }

  const lease = await acquireNotificationReconciliationLease(deps.claimStore, data.claimKey);
  if (!lease.acquired || !lease.token) {
    log.info({ outcome: 'unknown' }, 'notification reconciliation deferred: concurrent lease');
    return;
  }

  const leasedClaim = lease.record ?? claim;
  const provider = leasedClaim.provider ?? data.provider;
  const channel = leasedClaim.channel ?? data.channel;
  const providerMessageId = leasedClaim.providerMessageId ?? data.providerMessageId;
  const lookupData: NotificationReconciliationJobData = {
    kind: 'notification',
    claimKey: data.claimKey,
    provider,
    channel,
    ...(providerMessageId ? { providerMessageId } : {}),
  };

  if (!providerMessageId) {
    await recordNotificationResult(deps.claimStore, data.claimKey, lease.token, 'unknown', {
      provider,
      channel,
    });
    recordNotificationProviderResult(provider, channel, 'reconciled_unknown');
    try {
      await enqueueManualReview(deps, lookupData, 'provider_message_id_missing');
    } catch (err) {
      log.error({ err }, 'notification reconciliation manual review enqueue failed');
    }
    log.warn(
      { provider, channel, outcome: 'reconciled_unknown' },
      'notification reconciliation needs manual review: provider message id unavailable',
    );
    return;
  }

  let outcome: NotificationProviderResult;
  try {
    outcome = await deps.lookupProviderMessage({ provider, channel, providerMessageId });
  } catch {
    outcome = 'unknown';
  }

  if (outcome === 'success' || outcome === 'failure_certain') {
    if (outcome === 'success') {
      let repairStatus: NotificationRepairStatus = 'manual';
      try {
        const repair =
          deps.repairNotification ??
          ((claimKey: string, now?: Date) =>
            repairNotificationAfterProviderSuccess(deps.db, claimKey, now));
        repairStatus = await repair(data.claimKey, new Date());
      } catch (err) {
        log.error({ err }, 'notification local repair failed');
      }

      if (repairStatus === 'manual') {
        await recordNotificationResult(deps.claimStore, data.claimKey, lease.token, 'unknown', {
          provider,
          channel,
          providerMessageId,
        });
        recordNotificationProviderResult(provider, channel, 'reconciled_unknown');
        try {
          await enqueueManualReview(deps, lookupData, 'local_repair_failed');
        } catch (err) {
          log.error({ err }, 'notification local repair review enqueue failed');
        }
        log.warn(
          { provider, channel, outcome: 'reconciled_unknown', repairStatus },
          'notification provider accepted but local repair needs manual review',
        );
        return;
      }
    }

    const transitioned = await recordNotificationResult(
      deps.claimStore,
      data.claimKey,
      lease.token,
      outcome,
      {
        provider,
        channel,
        providerMessageId,
      },
    );
    recordNotificationProviderResult(
      provider,
      channel,
      outcome === 'success' ? 'reconciled_success' : 'reconciled_failure',
    );
    log.info(
      {
        provider,
        channel,
        outcome: outcome === 'success' ? 'reconciled_success' : 'reconciled_failure',
        transitioned,
      },
      'notification reconciliation completed',
    );
    return;
  }

  // Unknown remains unknown. The manual queue is deterministic and the claim
  // is intentionally not released, so a later retry cannot send blindly.
  await recordNotificationResult(deps.claimStore, data.claimKey, lease.token, 'unknown', {
    provider,
    channel,
    providerMessageId,
  });
  recordNotificationProviderResult(provider, channel, 'reconciled_unknown');
  try {
    await enqueueManualReview(deps, lookupData, 'provider_status_unavailable');
  } catch (err) {
    log.error({ err }, 'notification reconciliation manual review enqueue failed');
  }
  log.warn(
    { provider, channel, outcome: 'reconciled_unknown' },
    'notification reconciliation remains unknown',
  );
}

interface FinalizationLogger {
  error: (fields: Record<string, unknown>, message: string) => void;
}

/**
 * Rattrapage des appels incomplets et des récupérations non mises en file :
 * rejoue la finalisation commune sur chaque appel candidat. Les identifiants
 * BullMQ et claims du worker empêchent un second SMS si la tâche était déjà
 * partie. Un échec unitaire ne bloque pas le lot ; si la base est indisponible
 * pour tous les candidats, le retry BullMQ reprend le lot.
 */
async function finalizeIncompleteCalls(
  deps: ReconciliationDependencies,
  log: FinalizationLogger,
  callSids: string[],
): Promise<number> {
  let repaired = 0;
  let failures = 0;
  for (const callSid of callSids) {
    try {
      const result = await finalizeVoiceCall(
        callSid,
        { source: 'sweep' },
        {
          db: deps.db,
          ...(deps.enqueueRecovery ? { enqueueRecovery: deps.enqueueRecovery } : {}),
          ...(deps.loadRestaurantContext
            ? { loadRestaurantContext: deps.loadRestaurantContext }
            : {}),
        },
      );
      if (result.created || result.updatedFields.length > 0) repaired += 1;
    } catch (err) {
      failures += 1;
      log.error(
        { err: err instanceof Error ? err.message : String(err), callSid },
        'voice finalization failed for call',
      );
    }
  }
  if (failures > 0 && failures === callSids.length) {
    throw new Error(`voice finalization failed for all ${failures} candidate calls`);
  }
  return repaired;
}

export async function processReconciliationJob(
  job: Job<ReconciliationJobData>,
  deps: ReconciliationDependencies = getDefaultDependencies(),
): Promise<void> {
  const log = jobLogger(job);
  const data = job.data;

  if (data.kind === 'notification') {
    await processNotificationReconciliation(job as Job<NotificationReconciliationJobData>, deps);
    return;
  }

  if (data.kind === 'test-reservation-purge') {
    const deleted = await purgeTestReservations(deps.db);
    log.info({ deleted }, 'test reservation purge completed');
    return;
  }

  if (data.kind === 'voice-capacity-check') {
    const { peak, limit, level } = await checkVoiceCapacityHeadroom();
    log.info({ peak, limit, level }, 'voice capacity check completed');
    return;
  }

  if (data.kind === 'greeting-warm') {
    // Ne génère que les accueils manquants ; lire un accueil existant prolonge son expiration.
    await initGreetingCache();
    log.info('greeting warm completed');
    return;
  }

  if (data.kind === 'reservation-payment-expiry') {
    const expired = await expireReservationPayments();
    log.info({ expired }, 'reservation payment expiry completed');
    return;
  }

  if (data.kind === 'marketing-retention-purge') {
    const result = await purgeMarketingRetention(deps.db);
    log.info({ ...result }, 'marketing retention purge completed');
    return;
  }

  const { start, end, dayKey } = getDayRange(data.dayKey);

  if (data.kind === 'calls') {
    const calls = await deps.db.call.findMany({
      where: {
        carrier: 'telnyx',
        createdAt: { gte: start, lte: end },
        OR: [{ durationSec: null }, { outcome: null }],
      },
      select: {
        id: true,
        restaurantId: true,
        callSid: true,
        durationSec: true,
        outcome: true,
        createdAt: true,
      },
      take: 500,
    });

    // Rattrapage profond de la journée : on répare au lieu de seulement
    // journaliser, sinon un appel sans outcome reste inexploitable pour le
    // restaurant et pour la mesure produit.
    const repaired = await finalizeIncompleteCalls(
      deps,
      log,
      calls.map((call) => call.callSid),
    );

    log.warn(
      {
        dayKey,
        unresolvedCount: calls.length,
        repairedCount: repaired,
        unresolvedCallSids: calls.map((call) => call.callSid).slice(0, 25),
      },
      'call reconciliation completed',
    );
    return;
  }

  if (data.kind === 'voice-finalization') {
    const now = Date.now();
    let cursor: string | undefined;
    let candidates = 0;
    let repaired = 0;
    for (;;) {
      // tenant-scoping: global — balayage de maintenance : tous les
      // établissements sont concernés par le rattrapage de fin d'appel et des
      // récupérations commerciales dont l'enqueue aurait échoué.
      const calls = await deps.db.call.findMany({
        where: {
          carrier: 'telnyx',
          OR: [
            { outcome: null },
            {
              outcome: { in: ['NO_ACTION', 'ERROR'] },
              intent: 'RESERVATION',
              callerPhone: { not: null },
              reservation: { is: null },
              messages: { none: {} },
            },
          ],
          createdAt: {
            gte: new Date(now - VOICE_FINALIZATION_MAX_AGE_MS),
            lte: new Date(now - VOICE_FINALIZATION_MIN_AGE_MS),
          },
        },
        select: { callSid: true },
        orderBy: [{ createdAt: 'asc' }, { callSid: 'asc' }],
        take: VOICE_FINALIZATION_BATCH_SIZE,
        ...(cursor ? { cursor: { callSid: cursor }, skip: 1 } : {}),
      });
      if (calls.length === 0) break;
      candidates += calls.length;
      repaired += await finalizeIncompleteCalls(
        deps,
        log,
        calls.map((call) => call.callSid),
      );
      if (calls.length < VOICE_FINALIZATION_BATCH_SIZE) break;
      cursor = calls[calls.length - 1].callSid;
    }
    log.info({ dayKey, candidates, repaired }, 'voice finalization sweep completed');
    return;
  }

  await sweepNotificationClaims(deps, log);
  log.info({ dayKey }, 'sms reconciliation completed');
}

export const reconciliationWorker = new Worker(
  'reconciliation',
  (job) => processReconciliationJob(job as Job<ReconciliationJobData>),
  { connection: redisQueue, concurrency: 2 },
);

setupWorkerListeners(reconciliationWorker);
