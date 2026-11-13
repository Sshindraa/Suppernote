import type { Job } from 'bullmq';
import { ReservationPaymentStatus, type PrismaClient } from '@prisma/client';
import { formatGuaranteeEuros } from '@suppernote/shared';
import { logger } from '../../shared/logger/pino';
import { queues } from '../../shared/queue/queues';
import { buildReservationNotificationJobId } from '../../shared/queue/job-options';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  classifyNotificationError,
  normalizeNotificationSendResult,
  NotificationProviderRefusedError,
  recordNotificationResult,
  type NotificationClaimStore,
} from '../../shared/queue/notification-idempotency';
import type { sendSms } from '../../shared/telnyx/client';
import { utcToZonedParts } from '../../shared/timezone/restaurant-time';
import { cardGuaranteePageUrl, cardGuaranteeToken } from './reservation-guarantee.public';

export type CardGuaranteeSmsKind = 'link' | 'expired';
export type CardGuaranteeSmsJobData = { paymentId: string; restaurantId: string; nonce: string };

const JOB_PREFIX = 'card-guarantee-';

export function isCardGuaranteeSmsJob(name: string): boolean {
  return name.startsWith(JOB_PREFIX);
}

/**
 * Met en file le SMS du lien d'empreinte ou de son expiration. Le `nonce` distingue un renvoi
 * voulu par l'équipe d'une relivraison du même envoi, dédoublonnée par le claim.
 */
export async function enqueueCardGuaranteeSms(
  kind: CardGuaranteeSmsKind,
  payment: { id: string; restaurantId: string },
  nonce = 'first',
): Promise<void> {
  await queues.smsClient.add(
    `${JOB_PREFIX}${kind}`,
    { paymentId: payment.id, restaurantId: payment.restaurantId, nonce },
    { jobId: `card-guarantee_${kind}_${payment.id}_${nonce}` },
  );
}

/**
 * Une réservation prise hors web (voix, équipe) confirmée par l'enregistrement de la carte reçoit
 * le SMS de confirmation habituel ; le web a déjà la sienne par la page `/garantie` et l'e-mail.
 */
export async function enqueueConfirmationAfterCardGuarantee(
  db: Pick<PrismaClient, 'reservation'>,
  reservation: { id: string; restaurantId: string },
): Promise<void> {
  const row = await db.reservation.findFirst({
    where: { id: reservation.id, restaurantId: reservation.restaurantId },
    select: { id: true, channel: true, customerPhone: true },
  });
  if (!row?.customerPhone || row.channel === 'WEB' || row.channel === 'ADMIN') return;
  // Le worker relit la réservation : seul l'identifiant compte dans la charge utile.
  await queues.smsClient.add(
    'client-confirm',
    { reservationId: row.id },
    { jobId: buildReservationNotificationJobId('confirmation-after-guarantee', row.id) },
  );
}

function money(amount: { toFixed(digits: number): string }): string {
  return formatGuaranteeEuros(amount.toFixed(2));
}

export async function processCardGuaranteeSmsJob(
  job: Job<CardGuaranteeSmsJobData>,
  deps: {
    db: PrismaClient;
    sendSms: typeof sendSms;
    claimStore: NotificationClaimStore;
  },
): Promise<void> {
  const kind: CardGuaranteeSmsKind = job.name === `${JOB_PREFIX}expired` ? 'expired' : 'link';
  const { paymentId, restaurantId, nonce } = job.data;
  const payment = await deps.db.reservationPayment.findFirst({
    where: { id: paymentId, restaurantId },
    select: {
      id: true,
      restaurantId: true,
      status: true,
      amount: true,
      expiresAt: true,
      reservation: {
        select: {
          state: true,
          customerPhone: true,
          partySize: true,
          startsAt: true,
          reservedAt: true,
          restaurant: { select: { name: true, slug: true, timezone: true } },
        },
      },
    },
  });
  const reservation = payment?.reservation;
  const eligible =
    payment &&
    reservation?.customerPhone &&
    (kind === 'link'
      ? payment.status === ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD &&
        !!payment.expiresAt &&
        payment.expiresAt > new Date() &&
        !!reservation.restaurant.slug
      : payment.status === ReservationPaymentStatus.EXPIRED && reservation.state === 'EXPIRED');
  if (!payment || !reservation?.customerPhone || !eligible) {
    logger.info({ paymentId, kind }, 'card guarantee SMS skipped: no longer eligible');
    return;
  }
  const token = kind === 'link' ? cardGuaranteeToken(payment) : null;
  if (kind === 'link' && !token) {
    logger.warn({ paymentId }, 'card guarantee SMS skipped: links not configured');
    return;
  }

  const { name, slug, timezone } = reservation.restaurant;
  const startsAt = reservation.startsAt ?? reservation.reservedAt;
  const local = utcToZonedParts(startsAt, timezone);
  const day = startsAt.toLocaleDateString('fr-FR', { timeZone: timezone });
  const time = local.time.replace(':', 'h');
  const people = `${reservation.partySize} pers.`;
  const deadline = payment.expiresAt
    ? utcToZonedParts(payment.expiresAt, timezone).time.replace(':', 'h')
    : null;
  const text =
    kind === 'link'
      ? `${name} : pour confirmer votre table du ${day} à ${time} (${people}), enregistrez votre carte ici : ${cardGuaranteePageUrl(slug!, token!)} Aucun montant n’est débité aujourd’hui (jusqu’à ${money(payment.amount)} en cas d’absence ou d’annulation tardive).${deadline ? ` Sans carte avant ${deadline}, la table sera libérée.` : ''}`
      : `${name} : votre carte n’a pas été enregistrée à temps, votre réservation du ${day} à ${time} n’est pas confirmée et la table a été libérée. Pour réserver à nouveau, contactez le restaurant.`;

  const claimKey = buildNotificationClaimKey(`card-guarantee-${kind}-sms`, `${paymentId}:${nonce}`);
  const claim = await acquireNotificationClaim(deps.claimStore, claimKey, {
    provider: 'telnyx',
    channel: 'sms',
  });
  if (!claim.acquired || !claim.token) {
    logger.info({ paymentId, kind }, 'card guarantee SMS skipped: duplicate claim');
    return;
  }
  try {
    const result = normalizeNotificationSendResult(
      await deps.sendSms(reservation.customerPhone, text, {
        restaurantId,
        sourceType: `card_guarantee_${kind}`,
        sourceId: `${paymentId}:${nonce}`,
        metadata: { messageType: `card_guarantee_${kind}` },
      }),
      'telnyx',
      'sms',
    );
    await recordNotificationResult(deps.claimStore, claimKey, claim.token, result.outcome, {
      provider: result.provider,
      channel: result.channel,
      ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
    });
    if (result.outcome === 'failure_certain') {
      throw new NotificationProviderRefusedError(result.provider, result.channel);
    }
    logger.info({ paymentId, kind, outcome: result.outcome }, 'card guarantee SMS sent');
  } catch (err) {
    if (err instanceof NotificationProviderRefusedError) throw err;
    const outcome = classifyNotificationError(err);
    await recordNotificationResult(deps.claimStore, claimKey, claim.token, outcome, {
      provider: 'telnyx',
      channel: 'sms',
    });
    if (outcome === 'unknown') {
      logger.warn({ paymentId, kind, outcome }, 'card guarantee SMS result unknown');
      return;
    }
    throw err;
  }
}
