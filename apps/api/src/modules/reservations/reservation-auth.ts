import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The legacy reservation endpoint is an internal compatibility surface. Voice
 * calls use ReservationService directly; public Connect reservations use the
 * signed hold/confirm routes. Keeping this endpoint anonymous would allow a
 * caller who knows a call id to replay it and receive customer data.
 */
export const RESERVATION_SERVICE_TOKEN_HEADER = 'x-suppernote-reservation-token';
/** Ancien nom, accepté pour les appelants pas encore mis à jour (shortcut: retirer en phase 5). */
export const LEGACY_RESERVATION_SERVICE_TOKEN_HEADER = 'x-sokar-reservation-token';

export async function requireReservationService(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const expected = process.env.RESERVATION_SERVICE_TOKEN;
  if (!expected || expected.length < 32) {
    req.log.error('RESERVATION_SERVICE_TOKEN is not configured');
    await reply.status(503).send({ error: 'RESERVATION_SERVICE_NOT_CONFIGURED' });
    return;
  }

  const suppliedHeader =
    req.headers[RESERVATION_SERVICE_TOKEN_HEADER] ??
    req.headers[LEGACY_RESERVATION_SERVICE_TOKEN_HEADER];
  const supplied = Array.isArray(suppliedHeader) ? suppliedHeader[0] : suppliedHeader;
  if (!supplied) {
    await reply.status(401).send({ error: 'RESERVATION_SERVICE_AUTH_REQUIRED' });
    return;
  }

  const expectedBytes = Buffer.from(expected, 'utf8');
  const suppliedBytes = Buffer.from(supplied, 'utf8');
  const valid =
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);

  if (!valid) {
    req.log.warn('Invalid legacy reservation service token');
    await reply.status(401).send({ error: 'RESERVATION_SERVICE_AUTH_INVALID' });
  }
}
