import { randomBytes, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureReservationShortCode,
  generateShortCode,
  resolveReservationShortCode,
  reservationShortManagementUrl,
} from '../reservation-short-code';
import { verifyReservationManagementToken } from '../reservation-management';

const DAY = 86_400_000;

function makeDb(row: Record<string, unknown> | null) {
  return {
    reservation: {
      findUnique: vi.fn().mockResolvedValue(row),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  } as unknown as PrismaClient & {
    reservation: { findUnique: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  };
}

function base(now = Date.now()) {
  return {
    id: randomUUID(),
    restaurantId: randomUUID(),
    createdAt: new Date(now),
    reservedAt: new Date(now + 2 * DAY),
    customerPhone: '+33600000000',
  };
}

describe('reservation short code', () => {
  beforeEach(() => {
    vi.stubEnv('RESERVATION_MANAGEMENT_ENABLED', 'true');
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
    vi.stubEnv('DASHBOARD_URL', 'https://suppernote.com');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('generates unique 8-character base62 codes', () => {
    const codes = Array.from({ length: 5000 }, () => generateShortCode());
    expect(codes.every((code) => /^[A-Za-z0-9]{8}$/.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('reuses the stored code while the phone is unchanged', async () => {
    const row = base();
    const db = makeDb(null);
    const first = await ensureReservationShortCode(db, row);
    const stored = db.reservation.updateMany.mock.calls[0][0].data;
    expect(stored.managementShortCode).toBe(first);
    expect(stored.managementShortCodePhone).not.toContain('+33600000000');

    const again = await ensureReservationShortCode(db, {
      ...row,
      managementShortCode: stored.managementShortCode,
      managementShortCodePhone: stored.managementShortCodePhone,
    });
    expect(again).toBe(first);
    expect(db.reservation.updateMany).toHaveBeenCalledTimes(1);
  });

  it('retries when a generated code collides', async () => {
    const db = makeDb(null);
    const conflict = Object.assign(new Error('unique'), { code: 'P2002' });
    db.reservation.updateMany.mockRejectedValueOnce(conflict).mockResolvedValueOnce({ count: 1 });
    const code = await ensureReservationShortCode(db, base());
    expect(db.reservation.updateMany).toHaveBeenCalledTimes(2);
    expect(code).toMatch(/^[A-Za-z0-9]{8}$/);
  });

  it('builds a short SMS link under /r/<code>', async () => {
    const url = await reservationShortManagementUrl(makeDb(null), base());
    expect(url).toMatch(/^https:\/\/suppernote\.com\/r\/[A-Za-z0-9]{8}$/);
  });

  it('resolves a code to a token bound to the reservation', async () => {
    const row = base();
    const issuing = makeDb(null);
    const code = await ensureReservationShortCode(issuing, row);
    const stored = issuing.reservation.updateMany.mock.calls[0][0].data;
    const db = makeDb({ ...row, ...stored });
    const token = await resolveReservationShortCode(db, code);
    expect(token).toBeDefined();
    expect(verifyReservationManagementToken(token!, row)).toBe(true);
  });

  it('refuses unknown or malformed codes without a database lookup', async () => {
    const db = makeDb(null);
    expect(await resolveReservationShortCode(db, 'short')).toBeUndefined();
    expect(db.reservation.findUnique).not.toHaveBeenCalled();
    expect(await resolveReservationShortCode(db, 'AbC12xYz')).toBeUndefined();
  });

  it('invalidates the code when the phone has changed', async () => {
    const row = base();
    const issuing = makeDb(null);
    await ensureReservationShortCode(issuing, row);
    const stored = issuing.reservation.updateMany.mock.calls[0][0].data;
    const db = makeDb({
      ...row,
      customerPhone: '+33600000999',
      managementShortCode: stored.managementShortCode,
      managementShortCodePhone: stored.managementShortCodePhone,
    });
    expect(await resolveReservationShortCode(db, stored.managementShortCode)).toBeUndefined();
  });

  it('refuses an expired reservation link', async () => {
    const now = Date.now();
    const row = {
      ...base(now),
      createdAt: new Date(now - 100 * DAY),
      reservedAt: new Date(now - DAY),
    };
    const db = makeDb({ ...row, managementShortCode: 'AbC12xYz', managementShortCodePhone: null });
    expect(await resolveReservationShortCode(db, 'AbC12xYz')).toBeUndefined();
  });
});
