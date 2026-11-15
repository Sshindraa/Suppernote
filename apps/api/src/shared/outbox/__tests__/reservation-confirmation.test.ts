import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueueReservationConfirmation } from '../reservation-confirmation';
import { enqueue } from '../outbox.service';

vi.mock('../outbox.service', () => ({ enqueue: vi.fn().mockResolvedValue({ created: true }) }));

describe('transactional reservation confirmation intent', () => {
  beforeEach(() => vi.clearAllMocks());
  const reservation = {
    channel: 'WEB',
    id: 'res-1',
    restaurantId: 'rest-1',
    state: 'CONFIRMED',
    customerPhone: '+33600000000',
  };
  function transaction(enabled = true) {
    return {
      restaurant: { findUnique: vi.fn().mockResolvedValue({ smsConfirmEnabled: enabled }) },
    } as unknown as Prisma.TransactionClient;
  }
  it('writes an ID-only intent through the caller transaction and deterministic key', async () => {
    const tx = transaction();
    await enqueueReservationConfirmation(tx, { ...reservation, channel: 'ADMIN' });
    expect(enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        topic: 'reservation-confirmation',
        idempotencyKey: 'reservation-confirmation:res-1',
        payload: { reservationId: 'res-1' },
      }),
    );
    expect(JSON.stringify(vi.mocked(enqueue).mock.calls)).not.toContain('+336');
  });
  it.each(['PENDING', 'CANCELLED', 'SEATED'])(
    'never queues before confirmation or for terminal state %s',
    async (state) => {
      await enqueueReservationConfirmation(transaction(), { ...reservation, state });
      expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it('respects disabled confirmations and missing phones', async () => {
    const admin = { ...reservation, channel: 'ADMIN' };
    await enqueueReservationConfirmation(transaction(false), admin);
    await enqueueReservationConfirmation(transaction(), { ...admin, customerPhone: null });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('queues both confirmation intents for ADMIN and respects the SMS setting', async () => {
    await enqueueReservationConfirmation(transaction(), {
      ...reservation,
      channel: 'ADMIN',
      customerEmail: 'client@example.com',
    });
    expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.topic)).toEqual([
      'reservation-confirmation-email',
      'reservation-confirmation',
    ]);
    vi.mocked(enqueue).mockClear();
    await enqueueReservationConfirmation(transaction(false), {
      ...reservation,
      channel: 'ADMIN',
      customerEmail: 'client@example.com',
    });
    expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.topic)).toEqual([
      'reservation-confirmation-email',
    ]);
  });

  it('queues only the e-mail for WEB, even with the SMS setting on', async () => {
    const queued = await enqueueReservationConfirmation(transaction(), {
      ...reservation,
      customerEmail: 'client@example.com',
    });
    expect(queued).toBe(true);
    expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.topic)).toEqual([
      'reservation-confirmation-email',
    ]);
  });
  it('queues the e-mail for MCP when the assistant provided one, never an SMS', async () => {
    await enqueueReservationConfirmation(transaction(), {
      ...reservation,
      channel: 'MCP',
      customerEmail: 'client@example.com',
    });
    expect(vi.mocked(enqueue).mock.calls.map(([, event]) => event.topic)).toEqual([
      'reservation-confirmation-email',
    ]);
    vi.mocked(enqueue).mockClear();
    expect(
      await enqueueReservationConfirmation(transaction(), { ...reservation, channel: 'MCP' }),
    ).toBe(false);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('leaves PHONE to the voice confirmation path', async () => {
    await enqueueReservationConfirmation(transaction(), {
      ...reservation,
      channel: 'PHONE',
      customerEmail: 'client@example.com',
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('propagates intent persistence failure so creation can roll back', async () => {
    vi.mocked(enqueue).mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(
      enqueueReservationConfirmation(transaction(), { ...reservation, channel: 'ADMIN' }),
    ).rejects.toThrow('outbox unavailable');
  });
});

describe('confirmation e-mail intent', () => {
  beforeEach(() => vi.clearAllMocks());
  const tx = {} as Prisma.TransactionClient;
  const web = {
    channel: 'WEB',
    id: 'res-1',
    restaurantId: 'rest-1',
    state: 'CONFIRMED',
    customerPhone: null,
    customerEmail: 'client@example.com',
  };

  it('queues an ID-only e-mail intent for a web booking with an address, whatever the SMS setting', async () => {
    await enqueueReservationConfirmation(tx, web);
    expect(enqueue).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        topic: 'reservation-confirmation-email',
        idempotencyKey: 'reservation-confirmation-email:res-1',
        payload: { reservationId: 'res-1' },
      }),
    );
    expect(JSON.stringify(vi.mocked(enqueue).mock.calls)).not.toContain('client@example.com');
  });

  it.each([
    ['a test booking', { isTest: true }],
    ['a booking without address', { customerEmail: null }],
    ['a booking not yet confirmed', { state: 'PENDING' }],
    ['a booking made by voice', { channel: 'PHONE' }],
  ])('queues no e-mail intent for %s', async (_label, overrides) => {
    await enqueueReservationConfirmation(tx, { ...web, ...overrides });
    expect(enqueue).not.toHaveBeenCalled();
  });
});
