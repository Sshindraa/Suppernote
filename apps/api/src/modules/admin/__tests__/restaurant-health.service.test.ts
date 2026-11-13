import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRestaurantHealth } from '../restaurant-health.service';

const dbMocks = vi.hoisted(() => ({
  restaurantFindUnique: vi.fn(),
  callFindFirst: vi.fn(),
  reservationFindFirst: vi.fn(),
  auditFindFirst: vi.fn(),
}));

const queueStatesMock = vi.hoisted(() => vi.fn());

vi.mock('../../../shared/db/client', () => ({
  db: {
    restaurant: { findUnique: dbMocks.restaurantFindUnique },
    call: { findFirst: dbMocks.callFindFirst },
    reservation: { findFirst: dbMocks.reservationFindFirst },
    reservationAuditLog: { findFirst: dbMocks.auditFindFirst },
  },
}));

vi.mock('../../../shared/observability/system-checks', () => ({
  collectQueueStates: queueStatesMock,
}));

const restaurant = {
  id: 'resto-1',
  name: 'Chez Suppernote',
  slug: 'chez-sokar',
  phoneNumber: '+33451221528',
  carrier: 'telnyx',
  provisioningStatus: 'READY',
  telnyxPhoneNumberId: 'pn-123',
  forwardingConfiguredAt: new Date('2026-07-20T10:00:00Z'),
  testCallValidatedAt: new Date('2026-07-21T09:00:00Z'),
  firstCallAt: new Date('2026-07-21T09:05:00Z'),
  smsConfirmEnabled: true,
};

describe('buildRestaurantHealth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMocks.restaurantFindUnique.mockResolvedValue(restaurant);
    dbMocks.callFindFirst.mockResolvedValue({
      callSid: 'call-1',
      createdAt: new Date('2026-07-22T08:00:00Z'),
      durationSec: 95,
      outcome: 'RESERVED',
      transcript: 'bonjour, une table pour 2',
    });
    dbMocks.reservationFindFirst.mockImplementation(
      (args: { where: { confirmationSentAt?: unknown } }) => {
        // Premier appel = dernière réservation ; second = dernier rappel J-1.
        if (args.where.confirmationSentAt) {
          return Promise.resolve({
            id: 'resa-0',
            customerName: 'Ancien Client',
            confirmationSentAt: new Date('2026-07-21T17:00:00Z'),
          });
        }
        return Promise.resolve({
          id: 'resa-1',
          customerName: 'Martin Dupont',
          partySize: 4,
          reservedAt: new Date('2026-07-22T19:30:00Z'),
          createdAt: new Date('2026-07-22T08:01:00Z'),
          status: 'CONFIRMED',
          channel: 'PHONE',
        });
      },
    );
    dbMocks.auditFindFirst.mockResolvedValue({
      event: 'reservation_confirmation_sms_sent',
      createdAt: new Date('2026-07-22T08:01:30Z'),
      reservationId: 'resa-1',
    });
    queueStatesMock.mockResolvedValue({
      'sms-client': { waiting: 0, active: 0, delayed: 0, failed: 0, paused: 0 },
      'dead-letter': null,
    });
  });

  it('retourne null si le restaurant n’existe pas', async () => {
    dbMocks.restaurantFindUnique.mockResolvedValue(null);
    await expect(buildRestaurantHealth('inconnu')).resolves.toBeNull();
  });

  it('agrège numéro, dernier appel, réservation, SMS et workers', async () => {
    const health = await buildRestaurantHealth('resto-1');

    expect(health).not.toBeNull();
    expect(health!.restaurant.name).toBe('Chez Suppernote');
    expect(health!.phone).toMatchObject({
      number: '+33451221528',
      provisioningStatus: 'READY',
      smsConfirmEnabled: true,
    });
    expect(health!.lastCall).toMatchObject({
      callSid: 'call-1',
      outcome: 'RESERVED',
      hasTranscript: true,
    });
    expect(health!.lastReservation).toMatchObject({
      customerName: 'Martin Dupont',
      partySize: 4,
      status: 'CONFIRMED',
    });
    // L'audit SMS (08:01:30) est plus récent que le rappel J-1 (21/07 17:00).
    expect(health!.lastSms).toMatchObject({
      kind: 'reservation_confirmation_sms_sent',
      reservationId: 'resa-1',
    });
    expect(health!.workers).toEqual([
      {
        queue: 'sms-client',
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: 0,
        status: 'ok',
      },
      {
        queue: 'dead-letter',
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: 0,
        status: 'error',
      },
    ]);
  });

  it('lastSms retombe sur le rappel J-1 quand il est plus récent', async () => {
    dbMocks.auditFindFirst.mockResolvedValue(null);

    const health = await buildRestaurantHealth('resto-1');

    expect(health!.lastSms).toMatchObject({
      kind: 'reminder_j1',
      reservationId: 'resa-0',
      customerName: 'Ancien Client',
    });
  });

  it('gère un restaurant sans aucune activité', async () => {
    dbMocks.callFindFirst.mockResolvedValue(null);
    dbMocks.auditFindFirst.mockResolvedValue(null);
    dbMocks.reservationFindFirst.mockResolvedValue(null);

    const health = await buildRestaurantHealth('resto-1');

    expect(health!.lastCall).toBeNull();
    expect(health!.lastReservation).toBeNull();
    expect(health!.lastSms).toBeNull();
  });

  it('appel sans transcription → hasTranscript false', async () => {
    dbMocks.callFindFirst.mockResolvedValue({
      callSid: 'call-2',
      createdAt: new Date('2026-07-22T09:00:00Z'),
      durationSec: null,
      outcome: null,
      transcript: null,
    });

    const health = await buildRestaurantHealth('resto-1');

    expect(health!.lastCall).toMatchObject({ hasTranscript: false, outcome: null });
  });
});
