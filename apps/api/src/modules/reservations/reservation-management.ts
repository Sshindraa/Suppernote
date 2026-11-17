import { createHmac, timingSafeEqual } from 'node:crypto';

type ManagedReservation = {
  id: string;
  restaurantId: string;
  createdAt: Date;
  reservedAt: Date;
  customerPhone: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = 86_400_000;

function secret(): Buffer | undefined {
  const value = process.env.RESERVATION_MANAGEMENT_SECRET;
  return value && /^[a-f0-9]{64}$/i.test(value) ? Buffer.from(value, 'hex') : undefined;
}

export function isReservationManagementEnabled(): boolean {
  return process.env.RESERVATION_MANAGEMENT_ENABLED === 'true' && !!secret();
}

function sign(payload: Buffer, row: ManagedReservation, key: Buffer): Buffer {
  // Bind access to this booking, tenant and recipient. A phone correction
  // invalidates previously issued links without storing the bearer token.
  return createHmac('sha256', key)
    .update('reservation-management-v1\0')
    .update(payload)
    .update(`\0${row.restaurantId}\0${row.createdAt.toISOString()}\0${row.customerPhone ?? ''}`)
    .digest();
}

export function reservationManagementUrl(
  row: ManagedReservation,
  now = new Date(),
): string | undefined {
  const key = secret();
  if (!isReservationManagementEnabled() || !key || !UUID.test(row.id)) return;
  if (!(row.createdAt instanceof Date) || !(row.reservedAt instanceof Date)) return;
  const expires = Math.floor(
    Math.min(row.createdAt.getTime() + 90 * DAY, row.reservedAt.getTime() + 7 * DAY) / 1000,
  );
  if (!Number.isFinite(expires) || expires <= now.getTime() / 1000 || expires > 0xffffffff) return;
  let url: URL;
  try {
    url = new URL('/r', process.env.DASHBOARD_URL);
  } catch {
    return;
  }
  if (
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)))
  )
    return;
  const payload = Buffer.alloc(20);
  Buffer.from(row.id.replace(/-/g, ''), 'hex').copy(payload);
  payload.writeUInt32BE(expires, 16);
  url.hash = `${payload.toString('base64url')}.${sign(payload, row, key).toString('base64url')}`;
  return url.toString();
}

export function parseReservationManagementToken(
  token: string,
  now = new Date(),
  deferExpiryToReservation = false,
): { id: string; payload: Buffer; signature: Buffer } | undefined {
  if (!/^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/.test(token)) return;
  const [data, mac] = token.split('.');
  const payload = Buffer.from(data, 'base64url');
  const signature = Buffer.from(mac, 'base64url');
  if (
    payload.toString('base64url') !== data ||
    signature.toString('base64url') !== mac ||
    (!deferExpiryToReservation && payload.readUInt32BE(16) <= now.getTime() / 1000)
  )
    return;
  const hex = payload.subarray(0, 16).toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { id, payload, signature };
}

export function verifyReservationManagementToken(
  token: string,
  row: ManagedReservation,
  now = new Date(),
): boolean {
  // A signed link follows a confirmed rescheduling; never extend beyond creation + 90 days.
  // Deferred parsing is only safe when followed by this recipient-bound HMAC check.
  const parsed = parseReservationManagementToken(token, now, true);
  const key = secret();
  return (
    !!parsed &&
    !!key &&
    parsed.id === row.id &&
    Math.min(
      row.createdAt.getTime() + 90 * DAY,
      Math.max(parsed.payload.readUInt32BE(16) * 1000, row.reservedAt.getTime() + 7 * DAY),
    ) > now.getTime() &&
    timingSafeEqual(sign(parsed.payload, row, key), parsed.signature)
  );
}
