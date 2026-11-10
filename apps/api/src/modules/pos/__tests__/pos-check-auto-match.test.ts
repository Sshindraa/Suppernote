import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { matchTicketsToReservations, type AutoMatchTicket } from '../pos-check-auto-match';

const RESTAURANT = 'test-rest-1';
// 20:15 in Paris, in winter (UTC+1).
const OPENED = new Date('2026-12-31T19:15:00.000Z');

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    restaurantId: RESTAURANT,
    reservedAt: OPENED,
    startsAt: null,
    partySize: 2,
    table: { name: '12' },
    ...overrides,
  };
}

function ticket(overrides: Partial<AutoMatchTicket> = {}): AutoMatchTicket {
  return {
    id: 'check-1',
    openedAt: OPENED,
    tableReference: '12',
    partySize: 2,
    ...overrides,
  };
}

function persistedStatus(callIndex = 0): string | undefined {
  const call = vi.mocked(db.reservationCheckMatch.upsert).mock.calls[callIndex]?.[0];
  return (call?.create as { status?: string } | undefined)?.status;
}

describe('matchTicketsToReservations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.reservation.findMany).mockResolvedValue([] as never);
    vi.mocked(db.reservationCheckMatch.upsert).mockResolvedValue({} as never);
  });

  it('rapproche une table, une heure et des couverts compatibles (MATCHED)', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([reservation()] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket()],
      persist: true,
    });

    expect(outcome).toEqual({ matched: 1, review: 0 });
    expect(persistedStatus()).toBe('MATCHED');
    expect(db.reservationCheckMatch.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { reservationId_posCheckId: { reservationId: 'res-1', posCheckId: 'check-1' } },
      }),
    );
  });

  it('une table et une heure sans couverts reste à vérifier (REVIEW)', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([reservation()] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket({ partySize: null })],
      persist: true,
    });

    expect(outcome).toEqual({ matched: 0, review: 1 });
    expect(persistedStatus()).toBe('REVIEW');
  });

  it('ne rapproche rien quand aucune réservation n’est proche', async () => {
    const twoHoursLater = new Date(OPENED.getTime() + 120 * 60_000);
    vi.mocked(db.reservation.findMany).mockResolvedValue([
      reservation({ reservedAt: twoHoursLater }),
    ] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket()],
      persist: true,
    });

    expect(outcome).toEqual({ matched: 0, review: 0 });
    expect(db.reservationCheckMatch.upsert).not.toHaveBeenCalled();
  });

  it('une égalité entre deux réservations donne REVIEW, jamais MATCHED', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([
      reservation({ id: 'res-1' }),
      reservation({ id: 'res-2' }),
    ] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket()],
      persist: true,
    });

    expect(outcome).toEqual({ matched: 0, review: 1 });
    expect(persistedStatus()).toBe('REVIEW');
  });

  it('ne retient jamais une réservation d’un autre restaurant', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([
      reservation({ restaurantId: 'autre-restaurant' }),
    ] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket()],
      persist: true,
    });

    expect(outcome).toEqual({ matched: 0, review: 0 });
    expect(db.reservationCheckMatch.upsert).not.toHaveBeenCalled();
  });

  it('interroge la base une seule fois pour tout un lot', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([reservation()] as never);

    await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [
        ticket({ id: 'check-1' }),
        ticket({ id: 'check-2' }),
        ticket({ id: 'check-3', tableReference: '7' }),
      ],
      persist: true,
    });

    expect(db.reservation.findMany).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.reservation.findMany).mock.calls[0]?.[0]).toMatchObject({
      where: expect.objectContaining({ restaurantId: RESTAURANT, isTest: false }),
    });
  });

  it('n’écrit rien en essai (persist: false) mais compte les rapprochements', async () => {
    vi.mocked(db.reservation.findMany).mockResolvedValue([reservation()] as never);

    const outcome = await matchTicketsToReservations({
      restaurantId: RESTAURANT,
      tickets: [ticket()],
      persist: false,
    });

    expect(outcome).toEqual({ matched: 1, review: 0 });
    expect(db.reservationCheckMatch.upsert).not.toHaveBeenCalled();
  });
});
