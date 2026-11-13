import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  store: new Map<string, string>(),
  findMany: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  cancel: vi.fn(),
  add: vi.fn(),
}));
vi.mock('../../../shared/db/client', () => ({
  db: {
    reservation: { findMany: state.findMany, update: state.update, updateMany: state.updateMany },
  },
}));
vi.mock('../../../shared/redis/client', () => ({
  redisCache: {
    get: vi.fn(async (key: string) => state.store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && state.store.has(key)) return null;
      state.store.set(key, value);
      return 'OK';
    }),
    eval: vi.fn(async (_script: string, _count: number, key: string, token: string) => {
      if (state.store.get(key) !== token) return 0;
      state.store.delete(key);
      return 1;
    }),
  },
}));
vi.mock('../../../shared/queue/queues', () => ({ queues: { smsManager: { add: state.add } } }));
vi.mock('../../reservations/reservation.service', () => ({
  ReservationService: { update: state.cancel },
}));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { handleReply, parseReply } from '../reply-handler';

const reservation = {
  id: 'res-1',
  restaurantId: 'rest-1',
  customerName: 'Client',
  partySize: 2,
  reservedAt: new Date('2026-07-15T19:30:00Z'),
  status: 'CONFIRMED',
  state: 'CONFIRMED',
  confirmationStatus: 'PENDING',
  restaurant: { id: 'rest-1', name: 'Restaurant', managerPhone: 'manager' },
};

describe('inbound replies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.store.clear();
    state.findMany.mockResolvedValue([reservation]);
    state.update.mockResolvedValue(reservation);
    state.updateMany.mockResolvedValue({ count: 1 });
    state.cancel.mockResolvedValue(reservation);
    state.add.mockResolvedValue({});
  });

  it('refuses contradictory text', () => {
    expect(parseReply('oui je veux annuler')).toBe('UNKNOWN');
    expect(parseReply('oui')).toBe('CONFIRMED');
    expect(parseReply('non')).toBe('CANCELLED');
  });

  it('never selects a reservation when more than one is eligible, and flags it as uncorrelated', async () => {
    state.findMany.mockResolvedValue([
      reservation,
      { ...reservation, id: 'res-2', restaurantId: 'rest-2' },
    ]);
    expect(await handleReply('customer', 'NON', 'sms', 'message-1')).toMatchObject({
      action: 'uncorrelated',
    });
    expect(state.cancel).not.toHaveBeenCalled();
  });

  it('does not confirm a reservation that changed state during processing', async () => {
    state.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await handleReply('customer', 'OUI', 'sms', 'message-1')).toMatchObject({
      action: 'no_reservation',
    });
    expect(state.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'CONFIRMED',
          state: 'CONFIRMED',
          confirmationStatus: 'PENDING',
        }),
      }),
    );
  });

  it('deduplicates a successful reply even when a second reservation becomes eligible', async () => {
    await handleReply('customer', 'NON', 'sms', 'message-1');
    state.findMany.mockResolvedValue([{ ...reservation, id: 'res-2' }]);
    await handleReply('customer', 'NON', 'sms', 'message-1');
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.cancel).toHaveBeenCalledWith(
      'res-1',
      'rest-1',
      { status: 'CANCELLED' },
      'customer:sms-reply',
    );
    expect(state.add).toHaveBeenCalledTimes(1);
  });

  it('rejects simultaneous deliveries of the same message while one is processing', async () => {
    let release!: () => void;
    state.findMany.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([reservation]);
        }),
    );
    const first = handleReply('customer', 'NON', 'sms', 'message-1');
    await vi.waitFor(() => expect(state.findMany).toHaveBeenCalledTimes(1));
    await expect(handleReply('customer', 'NON', 'sms', 'message-1')).rejects.toThrow(
      'already being processed',
    );
    release();
    await first;
    expect(state.cancel).toHaveBeenCalledTimes(1);
  });

  it('propagates cancellation failures and keeps the original reservation for the retry', async () => {
    state.cancel.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(handleReply('customer', 'NON', 'sms', 'message-1')).rejects.toThrow(
      'database unavailable',
    );
    await handleReply('customer', 'NON', 'sms', 'message-1');
    expect(state.findMany.mock.calls[1][0].where).toMatchObject({ id: 'res-1' });
  });

  it('recovers a notification queue failure after cancellation without cancelling twice', async () => {
    state.add.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(handleReply('customer', 'NON', 'sms', 'message-1')).rejects.toThrow(
      'queue unavailable',
    );
    state.findMany.mockResolvedValue([{ ...reservation, state: 'CANCELLED', status: 'CANCELLED' }]);
    await handleReply('customer', 'NON', 'sms', 'message-1');
    expect(state.cancel).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenCalledTimes(2);
  });

  it('requires a provider message identifier', async () => {
    await expect(handleReply('customer', 'NON', 'sms')).rejects.toThrow('ID required');
    expect(state.findMany).not.toHaveBeenCalled();
  });
});
