import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { reservationManagementRoutes } from '../reservation-management.routes';
import { reservationManagementUrl } from '../reservation-management';
import { snapshotCancellationPolicy } from '../../../shared/reservations/cancellation-policy';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';
import { CustomerService } from '../../customers/customer.service';
import { deactivateMarketingConversions } from '../../marketing/marketing-attribution.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    reservation: { findUnique: vi.fn(), update: vi.fn() },
    reservationAuditLog: { create: vi.fn() },
    reservationPayment: { findFirst: vi.fn().mockResolvedValue(null) },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));
vi.mock('../../customers/customer.service', () => ({
  CustomerService: { recordReservationEvent: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../../marketing/marketing-attribution.service', () => ({
  deactivateMarketingConversions: vi.fn().mockResolvedValue(0),
}));

const row = {
  id: randomUUID(),
  restaurantId: randomUUID(),
  createdAt: new Date(),
  reservedAt: new Date(Date.now() + 7 * 86400000),
  startsAt: null,
  endsAt: null,
  customerPhone: '+33600000000',
  customerName: 'Private',
  state: 'CONFIRMED',
  status: 'CONFIRMED',
  partySize: 2,
  tableId: 'table',
  consumedHoldId: null,
  consents: {},
  channel: 'WEB',
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
  restaurant: {
    name: 'Exemple',
    timezone: 'Europe/Paris',
    phoneNumber: '+33100000000',
    formattedAddress: null,
  },
};
let current: typeof row;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('RESERVATION_MANAGEMENT_ENABLED', 'true');
  vi.stubEnv('RESERVATION_SELF_CANCELLATION_ENABLED', 'true');
  vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', randomBytes(32).toString('hex'));
  vi.stubEnv('DASHBOARD_URL', 'https://suppernote.com');
  current = { ...row };
  vi.mocked(db.reservation.findUnique).mockImplementation((async () => current) as never);
  vi.mocked(db.reservation.update).mockImplementation((({
    data,
  }: {
    data: Record<string, unknown>;
  }) => {
    current = { ...current, ...data } as typeof row;
    return Promise.resolve(current);
  }) as never);
  vi.mocked(db.$transaction).mockImplementation((async (fn: (tx: typeof db) => Promise<unknown>) =>
    fn(db)) as never);
  vi.spyOn(CapacityAwareAvailabilityService, 'invalidateAvailability').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
async function harness(
  run: (post: (body: Record<string, unknown>) => Promise<any>) => Promise<void>,
) {
  const app = Fastify();
  await app.register(reservationManagementRoutes);
  const token = new URL(reservationManagementUrl(row)!).hash.slice(1);
  try {
    await run((body) =>
      app.inject({
        method: 'POST',
        url: '/public/reservation-management',
        payload: { token, ...body },
      }),
    );
  } finally {
    await app.close();
  }
}
describe('autonomous cancellation contract through the canonical lifecycle', () => {
  it.each([
    [false, 1],
    [true, 0],
  ])('cancelling with isTest=%s records %i CRM/marketing write', async (isTest, calls) => {
    current = { ...row, isTest } as typeof row;
    await harness(async (post) => {
      const view = await post({ action: 'view' });
      const confirmationToken = view.json().cancellation.confirmationToken;
      const cancelled = await post({ action: 'cancel', confirmed: true, confirmationToken });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json().state).toBe('CANCELLED');
      expect(CustomerService.recordReservationEvent).toHaveBeenCalledTimes(calls);
      expect(deactivateMarketingConversions).toHaveBeenCalledTimes(calls);
    });
  });
  it('only cancels after confirmation, writes state/status once and invalidates capacity', async () => {
    await harness(async (post) => {
      const view = await post({ action: 'view' });
      expect(view.json().cancellation.available).toBe(true);
      expect(db.reservation.update).not.toHaveBeenCalled();
      const confirmationToken = view.json().cancellation.confirmationToken;
      expect((await post({ action: 'cancel', confirmationToken })).statusCode).toBe(400);
      const cancelled = await post({ action: 'cancel', confirmed: true, confirmationToken });
      expect(cancelled.statusCode).toBe(200);
      expect(cancelled.json()).toMatchObject({
        state: 'CANCELLED',
        cancellation: { available: false },
      });
      expect(db.reservation.update).toHaveBeenCalledWith({
        where: { id: row.id, restaurantId: row.restaurantId },
        data: { state: 'CANCELLED', status: 'CANCELLED' },
      });
      expect(db.$queryRaw).toHaveBeenCalled();
      expect(CapacityAwareAvailabilityService.invalidateAvailability).toHaveBeenCalledWith(
        row.restaurantId,
      );
      expect(
        (await post({ action: 'cancel', confirmed: true, confirmationToken })).json().state,
      ).toBe('CANCELLED');
      expect(db.reservation.update).toHaveBeenCalledTimes(1);
      expect(db.reservationAuditLog.create).toHaveBeenCalledTimes(1);
      expect((await post({ action: 'view' })).json().state).toBe('CANCELLED');
    });
  });
  it.each(['changed', 'late', 'payment', 'tampered'])(
    'rejects %s conditions with no mutation',
    async (mode) => {
      await harness(async (post) => {
        const view = await post({ action: 'view' });
        let confirmationToken = view.json().cancellation.confirmationToken;
        if (mode === 'changed') current = { ...current, partySize: 3 };
        if (mode === 'late') current = { ...current, reservedAt: new Date() };
        if (mode === 'payment')
          current = { ...current, _count: { ...current._count, reservationPayments: 1 } };
        if (mode === 'tampered') confirmationToken = confirmationToken.slice(0, -3) + 'AAA';
        expect(
          (await post({ action: 'cancel', confirmed: true, confirmationToken })).statusCode,
        ).toBe(409);
        expect(db.reservation.update).not.toHaveBeenCalled();
        expect(db.reservationAuditLog.create).not.toHaveBeenCalled();
      });
    },
  );
});
