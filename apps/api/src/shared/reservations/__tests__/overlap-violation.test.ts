import { describe, expect, it } from 'vitest';
import { isReservationOverlapViolation } from '../overlap-violation';

describe('isReservationOverlapViolation', () => {
  it('reconnaît le nom de la contrainte EXCLUDE dans le message Prisma', () => {
    const error = new Error(
      'Invalid `prisma.reservation.create()` invocation: conflicting key violates exclusion constraint "reservations_no_overlap_active"',
    );
    expect(isReservationOverlapViolation(error)).toBe(true);
  });

  it('reconnaît le code 23P01 remonté dans meta', () => {
    const error = Object.assign(new Error('Raw query failed'), { meta: { code: '23P01' } });
    expect(isReservationOverlapViolation(error)).toBe(true);
  });

  it('ignore les autres erreurs, y compris les doublons (P2002)', () => {
    expect(isReservationOverlapViolation(new Error('Unique constraint failed'))).toBe(false);
    expect(isReservationOverlapViolation({ meta: { code: '23P01' } })).toBe(false);
    expect(isReservationOverlapViolation(null)).toBe(false);
  });
});
