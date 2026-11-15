import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../db/client';
import { queues } from '../../queues';
import { processOutboxDeliveryJob, type OutboxDeliveryJobData } from '../outbox-delivery.worker';
import { processReservationConfirmationEmail } from '../../../../modules/reservations/reservation-confirmation-email';

vi.mock('../../../db/client', () => ({
  db: {
    outboxEvent: { findUnique: vi.fn() },
    reservation: { findUnique: vi.fn() },
  },
}));
vi.mock('../../queues', () => ({ queues: { smsClient: { add: vi.fn().mockResolvedValue({}) } } }));
vi.mock('../../../redis/client', () => ({ redisQueue: {} }));
vi.mock('../helper', () => ({
  setupWorkerListeners: vi.fn(),
  jobLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
vi.mock('../../../../modules/gift-cards/gift-card-delivery.service', () => ({
  processGiftCardDelivery: vi.fn(),
}));
vi.mock('../../../../modules/usage/usage-tariff.service', () => ({
  recordPricedUsageEvent: vi.fn(),
}));
vi.mock('../../../../modules/reservations/reservation-confirmation-email', () => ({
  processReservationConfirmationEmail: vi.fn().mockResolvedValue('sent'),
}));

describe('confirmation outbox delivery', () => {
  const job = { data: { outboxEventId: 'event-1' } } as Job<OutboxDeliveryJobData>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.reservation.findUnique).mockResolvedValue({
      id: 'res-1',
      status: 'CONFIRMED',
      state: 'CONFIRMED',
      customerPhone: '+33600000000',
      customerName: 'Example',
      reservedAt: new Date('2099-07-02T17:00:00Z'),
      partySize: 2,
      restaurant: { name: 'Example', timezone: 'Europe/Paris', smsConfirmEnabled: true },
    } as never);
  });
  it('hands the e-mail intent to the confirmation e-mail processor, not to SMS', async () => {
    vi.mocked(db.outboxEvent.findUnique).mockResolvedValue({
      restaurantId: 'rest-1',
      topic: 'reservation-confirmation-email',
      aggregateId: 'res-1',
      payload: { reservationId: 'res-1' },
    } as never);
    await processOutboxDeliveryJob(job);
    expect(processReservationConfirmationEmail).toHaveBeenCalledWith({
      reservationId: 'res-1',
      restaurantId: 'rest-1',
    });
    expect(queues.smsClient.add).not.toHaveBeenCalled();
  });

  it('routes repeated deliveries to the same SMS job with its historical payload', async () => {
    vi.mocked(db.outboxEvent.findUnique).mockResolvedValue({
      restaurantId: 'rest-1',
      topic: 'reservation-confirmation',
      aggregateId: 'res-1',
      payload: { reservationId: 'res-1' },
    } as never);
    await processOutboxDeliveryJob(job);
    await processOutboxDeliveryJob(job);
    expect(db.reservation.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'res-1', restaurantId: 'rest-1' } }),
    );
    expect(queues.smsClient.add).toHaveBeenNthCalledWith(
      1,
      'client-confirm',
      {
        reservationId: 'res-1',
        customerPhone: '+33600000000',
        customerName: 'Example',
        restaurantName: 'Example',
        date: '02/07/2099',
        time: '19:00',
        partySize: 2,
      },
      { jobId: 'reservation-notification_confirmation_res-1' },
    );
    expect(vi.mocked(queues.smsClient.add).mock.calls[0]).toEqual(
      vi.mocked(queues.smsClient.add).mock.calls[1],
    );
  });
  it('keeps the WEB fallback SMS when the restaurant turned SMS off, not with an e-mail', async () => {
    vi.mocked(db.outboxEvent.findUnique).mockResolvedValue({
      restaurantId: 'rest-1',
      topic: 'reservation-confirmation',
      aggregateId: 'res-1',
      payload: { reservationId: 'res-1' },
    } as never);
    const booking = {
      id: 'res-1',
      status: 'CONFIRMED',
      state: 'CONFIRMED',
      channel: 'WEB',
      customerEmail: null,
      isTest: false,
      customerPhone: '+33600000000',
      customerName: 'Example',
      reservedAt: new Date('2099-07-02T17:00:00Z'),
      partySize: 2,
      restaurant: { name: 'Example', timezone: 'Europe/Paris', smsConfirmEnabled: false },
    };
    vi.mocked(db.reservation.findUnique).mockResolvedValueOnce(booking as never);
    await processOutboxDeliveryJob(job);
    expect(queues.smsClient.add).toHaveBeenCalledTimes(1);
    vi.mocked(db.reservation.findUnique).mockResolvedValueOnce({
      ...booking,
      customerEmail: 'client@example.com',
    } as never);
    await processOutboxDeliveryJob(job);
    expect(queues.smsClient.add).toHaveBeenCalledTimes(1);
  });
  it('rejects an aggregate/payload mismatch', async () => {
    vi.mocked(db.outboxEvent.findUnique).mockResolvedValue({
      restaurantId: 'rest-1',
      topic: 'reservation-confirmation',
      aggregateId: 'res-2',
      payload: { reservationId: 'res-1' },
    } as never);
    await expect(processOutboxDeliveryJob(job)).rejects.toThrow(
      'INVALID_RESERVATION_CONFIRMATION_PAYLOAD',
    );
    expect(queues.smsClient.add).not.toHaveBeenCalled();
  });

  it('skips a missing booking when dispatch happens later', async () => {
    vi.mocked(db.outboxEvent.findUnique).mockResolvedValue({
      restaurantId: 'rest-1',
      topic: 'reservation-confirmation',
      aggregateId: 'res-1',
      payload: { reservationId: 'res-1' },
    } as never);
    vi.mocked(db.reservation.findUnique).mockResolvedValue(null);
    await processOutboxDeliveryJob(job);
    expect(queues.smsClient.add).not.toHaveBeenCalled();
  });
});
