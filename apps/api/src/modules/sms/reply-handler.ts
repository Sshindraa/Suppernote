import { db } from '../../shared/db/client';
import { ReservationService } from '../reservations/reservation.service';
import { logger } from '../../shared/logger/pino';
import { observeReservationMutation } from '../../shared/observability/reservation-contract';
import { redisCache } from '../../shared/redis/client';
import { queues } from '../../shared/queue/queues';
import { createHash, randomUUID } from 'node:crypto';
import { parseReply, type ReplyIntent } from './reply-parser';
export { parseReply, type ReplyIntent } from './reply-parser';

/**
 * Parser et handler partagés pour les réponses entrantes SMS et WhatsApp.
 *
 * Le client reçoit un rappel J-1. S'il répond NON, on annule la résa.
 * S'il répond OUI, on marque comme confirmé (bonus, pas requis).
 * Pas de réponse = normal, la résa reste confirmée.
 */

export interface HandleReplyResult {
  intent: ReplyIntent;
  reservationId?: string;
  action?: 'confirmed' | 'cancelled' | 'no_reservation' | 'uncorrelated';
}

/**
 * Traite une réponse entrante d'un client (SMS ou WhatsApp).
 *
 * @param from Numéro du client (E.164)
 * @param text Texte de la réponse
 * @param channel Canal d'origine ('sms' | 'whatsapp') — pour logging
 * @returns Résultat du traitement
 */
export async function handleReply(
  from: string,
  text: string,
  channel: 'sms' | 'whatsapp',
  messageId?: string,
): Promise<HandleReplyResult> {
  if (!messageId) throw new Error('Inbound message ID required');
  const eventKey = `inbound-reply:${createHash('sha256').update(`${channel}:${messageId}`).digest('hex')}`;
  const lockKey = `${eventKey}:lock`;
  const lockToken = randomUUID();
  if (!(await redisCache.set(lockKey, lockToken, 'EX', 300, 'NX'))) {
    throw new Error('Inbound message is already being processed');
  }
  try {
    return await handleLockedReply(from, text, channel, eventKey);
  } finally {
    await redisCache.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1,
      lockKey,
      lockToken,
    );
  }
}

async function handleLockedReply(
  from: string,
  text: string,
  channel: 'sms' | 'whatsapp',
  eventKey: string,
): Promise<HandleReplyResult> {
  const intent = parseReply(text);

  if (intent === 'UNKNOWN') {
    logger.info(
      { hasFrom: Boolean(from), textLength: text.length, channel },
      'inbound reply: unparseable, ignoring',
    );
    return { intent };
  }

  // Fenêtre de recherche élargie : [hier 00:00, J+1 23:59]
  // Couvre les edge cases :
  // - client répond J+1 pour une résa d'hier (résa hors fenêtre = pas matchée, OK)
  // - client répond tard le J-1 pour une résa du lendemain
  // - client répond tôt le jour J pour une résa du soir
  const now = new Date();
  const yesterdayStart = new Date(now);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  const tomorrowEnd = new Date(now);
  tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);
  tomorrowEnd.setHours(23, 59, 59, 999);

  const saved = await redisCache.get(eventKey);
  if (saved === 'ignored' || saved === 'done') return { intent, action: 'no_reservation' };
  const matches = await db.reservation.findMany({
    where: {
      ...(saved ? { id: saved } : {}),
      customerPhone: from,
      // `status` est une projection lossy de `state` : une réservation en
      // validation manuelle (`state = PENDING`) ou déjà installée
      // (`state = HONORED`) porte encore `status = CONFIRMED`. Exiger les deux
      // colonnes évite d'annuler une réservation qui n'était pas ferme, et
      // aligne ce filtre sur `isConfirmedReservation` (R1-4).
      ...(saved ? {} : { status: 'CONFIRMED', state: 'CONFIRMED', confirmationStatus: 'PENDING' }),
      reservedAt: { gte: yesterdayStart, lte: tomorrowEnd },
    },
    include: {
      restaurant: { select: { id: true, name: true, managerPhone: true } },
    },
    take: 2,
  });
  // A shared sender cannot identify a restaurant; never guess when several match.
  if (matches.length !== 1) {
    // Pas de cache « ignored » ici : si la file de relecture échoue, Telnyx réessaie et doit repasser par cette étape.
    if (!saved) return { intent, action: 'uncorrelated' };
    return { intent, action: 'no_reservation' };
  }
  const reservation = matches[0];
  if (!saved) await redisCache.set(eventKey, reservation.id, 'EX', 7 * 24 * 60 * 60);

  const stillConfirmed = reservation.state === 'CONFIRMED' && reservation.status === 'CONFIRMED';
  const alreadyCancelled =
    saved &&
    reservation.state === 'CANCELLED' &&
    reservation.status === 'CANCELLED' &&
    intent === 'CANCELLED';
  if (!stillConfirmed && !alreadyCancelled) {
    await redisCache.set(eventKey, 'done', 'EX', 7 * 24 * 60 * 60);
    return { intent, action: 'no_reservation' };
  }

  if (!reservation) {
    logger.info({ hasFrom: Boolean(from), channel }, 'inbound reply: no pending reservation found');
    return { intent, action: 'no_reservation' };
  }

  if (intent === 'CONFIRMED') {
    const changed = await db.reservation.updateMany({
      where: {
        id: reservation.id,
        restaurantId: reservation.restaurantId,
        status: 'CONFIRMED',
        state: 'CONFIRMED',
        confirmationStatus: 'PENDING',
      },
      data: {
        confirmationStatus: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });
    await redisCache.set(eventKey, 'done', 'EX', 7 * 24 * 60 * 60);
    if (changed.count === 0) return { intent, action: 'no_reservation' };
    observeReservationMutation({
      source: 'direct',
      operation: 'confirmation_reply',
      status: reservation.status,
      state: reservation.state,
      idempotency: 'not_applicable',
      audit: 'not_applicable',
      notification: 'not_sent',
      capacity: 'unchanged',
    });
    logger.info(
      { reservationId: reservation.id, hasFrom: Boolean(from), channel },
      'reservation confirmed via reply',
    );
    return { intent, reservationId: reservation.id, action: 'confirmed' };
  }

  // intent === 'CANCELLED'
  try {
    if (reservation.status !== 'CANCELLED' || reservation.state !== 'CANCELLED') {
      await ReservationService.update(
        reservation.id,
        reservation.restaurantId,
        { status: 'CANCELLED' },
        'customer:sms-reply',
      );
    }
    await db.reservation.update({
      where: { id: reservation.id },
      data: {
        confirmationStatus: 'CANCELLED',
        confirmedAt: new Date(),
      },
    });
    // SMS au gérant : table libérée
    if (reservation.restaurant.managerPhone) {
      await queues.smsManager.add(
        'reply-cancellation',
        {
          restaurantId: reservation.restaurant.id,
          reservationId: reservation.id,
          channel,
        },
        { jobId: `inbound_reply_${createHash('sha256').update(eventKey).digest('hex')}` },
      );
    }

    observeReservationMutation({
      source: 'direct',
      operation: 'cancel',
      status: 'CANCELLED',
      state: 'CANCELLED',
      idempotency: 'not_applicable',
      audit: 'written',
      notification: reservation.restaurant.managerPhone ? 'queued' : 'not_sent',
      capacity: 'released',
    });

    await redisCache.set(eventKey, 'done', 'EX', 7 * 24 * 60 * 60);

    logger.info(
      { reservationId: reservation.id, hasFrom: Boolean(from), channel },
      'reservation cancelled via reply',
    );
    return { intent, reservationId: reservation.id, action: 'cancelled' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { err: message, reservationId: reservation.id, channel },
      'failed to cancel reservation via reply',
    );
    throw err;
  }
}
