import type { PrismaClient } from '@prisma/client';
import { db } from '../../shared/db/client';
import { sendEmail } from '../../shared/email';
import { logger } from '../../shared/logger/pino';
import { redisQueue } from '../../shared/redis/client';
import { queues } from '../../shared/queue/queues';
import {
  acquireNotificationClaim,
  buildNotificationClaimKey,
  classifyNotificationError,
  enqueueNotificationReconciliation,
  normalizeNotificationSendResult,
  NotificationProviderRefusedError,
  recordNotificationResult,
  type NotificationClaimStore,
  type NotificationReconciliationQueue,
} from '../../shared/queue/notification-idempotency';
import { recordNotificationProviderResult } from '../../shared/observability/metrics';
import { isSlotStartPast, utcToZonedParts } from '../../shared/timezone/restaurant-time';
import { normalizeCustomerEmail } from '../customers/customer-crm.service';
import {
  buildMarketingConsentUrl,
  createMarketingConsentToken,
} from '../marketing/marketing-unsubscribe.service';
import { marketingEmailConsentStatus } from '../marketing/marketing-consent.service';
import { reservationManagementUrl } from './reservation-management';

/** Audit append-only : une confirmation e-mail est partie. Sert aussi à ne pas la renvoyer. */
export const CONFIRMATION_EMAIL_SENT_EVENT = 'CONFIRMATION_EMAIL_SENT';

export type ReservationConfirmationEmailData = {
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  managementUrl?: string;
  consentUrl?: string;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * Confirmation transactionnelle : aucune offre dans le corps. La ligne de consentement reste en pied,
 * discrète, et n'apparaît que si `consentUrl` est fourni.
 */
export function buildReservationConfirmationEmail(data: ReservationConfirmationEmailData): {
  subject: string;
  html: string;
} {
  const name = escapeHtml(data.restaurantName);
  const people = data.partySize === 1 ? '1 personne' : `${data.partySize} personnes`;
  const manage = data.managementUrl
    ? `<p>Pour modifier ou annuler, <a href="${escapeHtml(data.managementUrl)}">ouvrez votre réservation</a>, ou appelez le restaurant.</p>`
    : '<p>Pour modifier ou annuler, appelez le restaurant.</p>';
  const consent = data.consentUrl
    ? `<p style="margin-top: 32px; font-size: 12px; color: #64748b;"><a href="${escapeHtml(data.consentUrl)}" style="color: #64748b;">Recevoir les offres et actualités du restaurant ${name}</a></p>`
    : '';
  return {
    // Un objet sur une seule ligne : pas de retour à la ligne venu du nom du restaurant.
    subject: `Votre réservation au restaurant ${data.restaurantName.replace(/\s+/g, ' ').trim()} est confirmée`,
    html: `<div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: #0F172A;">Votre réservation est confirmée</h1>
  <p>Vous avez réservé une table au restaurant <strong>${name}</strong> le <strong>${escapeHtml(data.date)}</strong> à <strong>${escapeHtml(data.time)}</strong> pour <strong>${people}</strong>.</p>
  ${manage}
  ${consent}
</div>`,
  };
}

export type ReservationConfirmationEmailDependencies = {
  db: PrismaClient;
  sendEmail: typeof sendEmail;
  claimStore: NotificationClaimStore;
  reconciliationQueue?: NotificationReconciliationQueue;
};

function defaultDependencies(): ReservationConfirmationEmailDependencies {
  return { db, sendEmail, claimStore: redisQueue, reconciliationQueue: queues.reconciliation };
}

type ConfirmationReservation = {
  id: string;
  restaurantId: string;
  customerId: string | null;
  partySize: number;
  createdAt: Date;
  reservedAt: Date;
  customerPhone: string | null;
  restaurant: { name: string; timezone: string };
};

/** Lien « recevoir les offres », seulement si la ligne peut être proposée à cette adresse. */
async function consentLinkFor(
  reservation: ConfirmationReservation,
  address: string,
): Promise<string | undefined> {
  if (!reservation.customerId) return undefined;
  try {
    const status = await marketingEmailConsentStatus({
      restaurantId: reservation.restaurantId,
      customerId: reservation.customerId,
      address,
    });
    if (status !== 'OFFERABLE') return undefined;
    const token = await createMarketingConsentToken({
      restaurantId: reservation.restaurantId,
      customerId: reservation.customerId,
      reservationId: reservation.id,
    });
    return buildMarketingConsentUrl(token);
  } catch (error) {
    // Un secret absent ou une lecture en échec retire seulement la ligne : la confirmation part quand même.
    logger.warn(
      { reservationId: reservation.id, err: error instanceof Error ? error.name : 'unknown' },
      '[confirmation-email] consent line skipped',
    );
    return undefined;
  }
}

function skipped(reservationId: string, reason: string): 'skipped' {
  logger.info({ reservationId, reason }, '[confirmation-email] skipped');
  return 'skipped';
}

async function requeueUnknown(
  deps: ReservationConfirmationEmailDependencies,
  claimKey: string,
  providerMessageId?: string,
): Promise<void> {
  if (!deps.reconciliationQueue) return;
  await enqueueNotificationReconciliation(deps.reconciliationQueue, {
    claimKey,
    provider: 'resend',
    channel: 'email',
    ...(providerMessageId ? { providerMessageId } : {}),
  });
}

/**
 * Envoie la confirmation e-mail d'une réservation confirmée (web, équipe ou assistant IA). Idempotent : un claim par
 * réservation, puis un audit `CONFIRMATION_EMAIL_SENT`. Aucune adresse n'est journalisée.
 */
export async function processReservationConfirmationEmail(
  args: { reservationId: string; restaurantId: string },
  deps: ReservationConfirmationEmailDependencies = defaultDependencies(),
): Promise<'sent' | 'unknown' | 'skipped'> {
  const reservation = await deps.db.reservation.findFirst({
    where: { id: args.reservationId, restaurantId: args.restaurantId },
    select: {
      id: true,
      restaurantId: true,
      customerId: true,
      customerEmail: true,
      partySize: true,
      status: true,
      state: true,
      channel: true,
      isTest: true,
      reservedAt: true,
      startsAt: true,
      createdAt: true,
      customerPhone: true,
      restaurant: { select: { name: true, timezone: true } },
    },
  });
  if (
    !reservation ||
    !['WEB', 'ADMIN', 'MCP'].includes(reservation.channel) ||
    reservation.isTest
  ) {
    return skipped(args.reservationId, 'not-eligible');
  }
  if (reservation.status !== 'CONFIRMED' || reservation.state !== 'CONFIRMED') {
    return skipped(args.reservationId, 'not-confirmed');
  }
  const address = reservation.customerEmail
    ? normalizeCustomerEmail(reservation.customerEmail)
    : null;
  if (!address) return skipped(args.reservationId, 'no-email');
  const startsAt = reservation.startsAt ?? reservation.reservedAt;
  if (isSlotStartPast(startsAt)) return skipped(args.reservationId, 'past');
  const alreadySent = await deps.db.reservationAuditLog.findFirst({
    where: { reservationId: reservation.id, event: CONFIRMATION_EMAIL_SENT_EVENT },
    select: { id: true },
  });
  if (alreadySent) return skipped(args.reservationId, 'already-sent');

  const claimKey = buildNotificationClaimKey('reservation-confirmation-email', reservation.id);
  const claim = await acquireNotificationClaim(deps.claimStore, claimKey, {
    provider: 'resend',
    channel: 'email',
  });
  if (!claim.acquired || !claim.token) {
    if (claim.record?.status === 'unknown') {
      await requeueUnknown(deps, claimKey, claim.record.providerMessageId);
    }
    return skipped(args.reservationId, 'duplicate-claim');
  }

  try {
    const email = buildReservationConfirmationEmail({
      restaurantName: reservation.restaurant.name,
      date: startsAt.toLocaleDateString('fr-FR', {
        timeZone: reservation.restaurant.timezone,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }),
      time: utcToZonedParts(startsAt, reservation.restaurant.timezone).time,
      partySize: reservation.partySize,
      managementUrl: reservationManagementUrl(reservation),
      consentUrl: await consentLinkFor(reservation, address),
    });
    const result = normalizeNotificationSendResult(
      await deps.sendEmail({
        to: address,
        subject: email.subject,
        html: email.html,
        usage: {
          restaurantId: reservation.restaurantId,
          sourceType: 'reservation_confirmation_email',
          sourceId: reservation.id,
          metadata: { messageType: 'reservation_confirmation_email' },
        },
      }),
      'resend',
      'email',
    );
    recordNotificationProviderResult('resend', 'email', result.outcome);
    const transitioned = await recordNotificationResult(
      deps.claimStore,
      claimKey,
      claim.token,
      result.outcome,
      {
        provider: result.provider,
        channel: result.channel,
        ...(result.providerMessageId ? { providerMessageId: result.providerMessageId } : {}),
      },
    );
    if (result.outcome === 'failure_certain') {
      throw new NotificationProviderRefusedError(result.provider, result.channel);
    }
    if (result.outcome === 'unknown') {
      if (transitioned) await requeueUnknown(deps, claimKey, result.providerMessageId);
      logger.warn(
        { reservationId: reservation.id },
        '[confirmation-email] provider result unknown',
      );
      return 'unknown';
    }
    await deps.db.reservationAuditLog.create({
      data: {
        reservationId: reservation.id,
        actor: 'system',
        event: CONFIRMATION_EMAIL_SENT_EVENT,
        metadata: { channel: 'email' },
      },
    });
    logger.info({ reservationId: reservation.id }, '[confirmation-email] sent');
    return 'sent';
  } catch (error) {
    if (error instanceof NotificationProviderRefusedError) throw error;
    const outcome = classifyNotificationError(error);
    recordNotificationProviderResult('resend', 'email', outcome);
    const transitioned = await recordNotificationResult(
      deps.claimStore,
      claimKey,
      claim.token,
      outcome,
      { provider: 'resend', channel: 'email' },
    );
    if (outcome !== 'unknown') throw error;
    if (transitioned) await requeueUnknown(deps, claimKey);
    logger.warn({ reservationId: reservation.id }, '[confirmation-email] provider result unknown');
    return 'unknown';
  }
}
