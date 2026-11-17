import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CANCELLATION_POLICY,
  snapshotCancellationPolicy,
} from '../../../shared/reservations/cancellation-policy';
import {
  cancellationOffer,
  verifyCancellationOffer,
  type CancellationReservation,
} from '../reservation-cancellation';

const now = new Date('2026-10-17T12:00:00Z');
const row: CancellationReservation = {
  id: 'reservation',
  restaurantId: 'restaurant',
  createdAt: now,
  state: 'CONFIRMED',
  startsAt: new Date('2026-10-20T17:30:00Z'),
  reservedAt: new Date('2026-10-20T17:30:00Z'),
  partySize: 2,
  giftCardRedemptionSnap: null,
  cancellationPolicySnap: snapshotCancellationPolicy(
    { cancellationPolicy: "Annulation gratuite jusqu'à 24 heures avant le service." },
    'v1',
  ),
  _count: {
    reservationPayments: 0,
    giftCardRedemptions: 0,
    experienceReservations: 0,
    eventOrders: 0,
    distributionReservationLinks: 0,
  },
};
beforeEach(() => {
  vi.stubEnv('RESERVATION_SELF_CANCELLATION_ENABLED', 'true');
  vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
});
afterEach(() => vi.unstubAllEnvs());
describe('frozen onboarding cancellation conditions', () => {
  it.each([2, 24, 48])('uses the configured %s hours, not the default', (hours) => {
    const snap = snapshotCancellationPolicy(
      { cancellationPolicy: `Annulation gratuite jusqu'à ${hours} heures avant le service.` },
      'v1',
    );
    const offer = cancellationOffer(
      { ...row, cancellationPolicySnap: snap },
      'bearer',
      'Europe/Paris',
      now,
    );
    expect(offer.available).toBe(true);
    expect(offer.deadline).toBe(new Date(row.startsAt!.getTime() - hours * 3600000).toISOString());
    expect(offer.message).toContain(hours === 2 ? '17:30' : '19:30');
  });
  it.each([
    null,
    {},
    { freeUntilMinutesBefore: 120, version: 'old' },
    snapshotCancellationPolicy({ cancellationPolicy: 'Pas d’annulation gratuite.' }, 'v1'),
    snapshotCancellationPolicy({ cancellationPolicy: 'Autres conditions' }, 'v1'),
  ])('requires restaurant review for legacy, missing or custom terms: %j', (snap) => {
    expect(
      cancellationOffer({ ...row, cancellationPolicySnap: snap }, 'bearer', 'Europe/Paris', now)
        .available,
    ).toBe(false);
  });
  it('applies the 2-hour default when the restaurant has no rule', () => {
    for (const specials of [{}, null, { cancellationPolicy: '   ' }]) {
      const snap = snapshotCancellationPolicy(specials, 'v1');
      expect(snap).toMatchObject({
        selfService: 'free_before_deadline',
        freeUntilMinutesBefore: 120,
      });
      expect(snap.terms).toBe(DEFAULT_CANCELLATION_POLICY);
    }
    expect(snapshotCancellationPolicy({ depositRequired: true }, 'v1').selfService).toBe('contact');
  });
  it('does not authorize a financial booking, even before the deadline', () => {
    expect(
      cancellationOffer(
        { ...row, _count: { ...row._count, reservationPayments: 1 } },
        'bearer',
        'Europe/Paris',
        now,
      ).available,
    ).toBe(false);
    const snap = snapshotCancellationPolicy(
      {
        cancellationPolicy: "Annulation gratuite jusqu'à 24 heures avant le service.",
        depositRequired: true,
      },
      'v1',
    );
    expect(
      cancellationOffer({ ...row, cancellationPolicySnap: snap }, 'bearer', 'Europe/Paris', now)
        .available,
    ).toBe(false);
  });
  it('rejects at the exact deadline and never quotes a fee after it', () => {
    const offer = cancellationOffer(
      row,
      'bearer',
      'Europe/Paris',
      new Date('2026-10-19T17:30:00Z'),
    );
    expect(offer).toMatchObject({ available: false, deadline: '2026-10-19T17:30:00.000Z' });
    expect(offer.confirmationToken).toBeUndefined();
  });
  it('requires a fresh explicit offer bound to the recipient, tenant and booking details', () => {
    const token = cancellationOffer(row, 'bearer', 'Europe/Paris', now).confirmationToken!;
    expect(verifyCancellationOffer(row, 'bearer', token, now)).toBe(true);
    expect(verifyCancellationOffer(row, 'other', token, now)).toBe(false);
    for (const change of [
      { restaurantId: 'other' },
      { partySize: 3 },
      { state: 'SEATED' },
      { startsAt: new Date('2026-10-21T17:30:00Z') },
      { cancellationPolicySnap: null },
    ])
      expect(verifyCancellationOffer({ ...row, ...change }, 'bearer', token, now)).toBe(false);
    expect(verifyCancellationOffer(row, 'bearer', token, new Date(now.getTime() + 600000))).toBe(
      false,
    );
  });
  it('is off by default', () => {
    vi.stubEnv('RESERVATION_SELF_CANCELLATION_ENABLED', 'false');
    expect(cancellationOffer(row, 'bearer', 'Europe/Paris', now).available).toBe(false);
  });
});
