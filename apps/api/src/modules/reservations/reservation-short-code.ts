import { createHmac, randomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { reservationManagementUrl, secret } from './reservation-management';

// Code court (8 caractères base62) : le SMS reste sous les filtres opérateurs.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SHORT_CODE = /^[A-Za-z0-9]{8}$/;

type ShortCodeRow = {
  id: string;
  restaurantId: string;
  createdAt: Date;
  reservedAt: Date;
  customerPhone: string | null;
  managementShortCode?: string | null;
  managementShortCodePhone?: string | null;
};

export function generateShortCode(): string {
  let out = '';
  // Rejection sampling: 248 = 62 × 4, sans biais modulo.
  while (out.length < 8) {
    const byte = randomBytes(1)[0];
    if (byte < 248) out += ALPHABET[byte % 62];
  }
  return out;
}

function phoneDigest(phone: string | null): string | null {
  const key = secret();
  if (!phone) return null;
  if (!key) throw new Error('RESERVATION_MANAGEMENT_SECRET is not configured');
  return createHmac('sha256', key)
    .update('reservation-short-code-v1\0')
    .update(phone)
    .digest('hex');
}

export async function ensureReservationShortCode(
  db: PrismaClient,
  row: ShortCodeRow,
): Promise<string> {
  const digest = phoneDigest(row.customerPhone);
  if (row.managementShortCode && row.managementShortCodePhone === digest)
    return row.managementShortCode;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateShortCode();
    try {
      const { count } = await db.reservation.updateMany({
        where: { id: row.id, restaurantId: row.restaurantId },
        data: { managementShortCode: code, managementShortCodePhone: digest },
      });
      if (count !== 1) throw new Error('Reservation not found for short code');
      return code;
    } catch (err) {
      // P2002 : code déjà pris par une autre réservation, on retente.
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
  }
  throw new Error('Reservation short code generation failed');
}

/** Lien SMS complet (`/r/<code>`), ou undefined si la gestion est désactivée ou le lien expiré. */
export async function reservationShortManagementUrl(
  db: PrismaClient,
  row: ShortCodeRow,
): Promise<string | undefined> {
  const signed = reservationManagementUrl(row);
  if (!signed) return;
  const code = await ensureReservationShortCode(db, row);
  const url = new URL(signed);
  url.hash = '';
  url.pathname = `/r/${code}`;
  return url.toString();
}

/** Résout un code court vers le fragment signé actuel, ou undefined (inconnu, expiré, téléphone changé). */
export async function resolveReservationShortCode(
  db: PrismaClient,
  code: string,
  now = new Date(),
): Promise<string | undefined> {
  if (!SHORT_CODE.test(code)) return;
  const row = await db.reservation.findUnique({
    where: { managementShortCode: code },
    select: {
      id: true,
      restaurantId: true,
      createdAt: true,
      reservedAt: true,
      customerPhone: true,
      managementShortCodePhone: true,
    },
  });
  if (!row || row.managementShortCodePhone !== phoneDigest(row.customerPhone)) return;
  const signed = reservationManagementUrl(row, now);
  return signed ? new URL(signed).hash.slice(1) : undefined;
}
