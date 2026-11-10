import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { getCustomerRealSpend, getReservationAddition } from '../pos-check-spend';

const D = (value: string) => new Prisma.Decimal(value);

function match(
  reservationId: string,
  check: {
    id: string;
    total: string;
    refund?: string;
    closedAt?: string | null;
    partySize?: number;
  },
  status = 'MATCHED',
) {
  return {
    reservationId,
    status,
    reservation: { partySize: check.partySize ?? 2 },
    posCheck: {
      id: check.id,
      total: D(check.total),
      refundedAmount: D(check.refund ?? '0'),
      openedAt: new Date('2026-11-01T19:00:00.000Z'),
      closedAt:
        check.closedAt === undefined ? null : check.closedAt ? new Date(check.closedAt) : null,
      tableReference: '4',
    },
  };
}

describe('pos-check-spend', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
  });

  describe('getCustomerRealSpend', () => {
    it('additionne les tickets MATCHED, déduit les remboursements et calcule les moyennes', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([
        match('r1', {
          id: 'c1',
          total: '60.00',
          partySize: 2,
          closedAt: '2026-11-01T21:00:00.000Z',
        }),
        match('r2', {
          id: 'c2',
          total: '40.50',
          refund: '10.00',
          partySize: 3,
          closedAt: '2026-11-08T20:30:00.000Z',
        }),
      ] as never);

      const spend = await getCustomerRealSpend('rest-1', 'cust-1');

      expect(spend).toEqual({
        total: '90.50',
        checkCount: 2,
        averageAddition: '45.25',
        averagePerCover: '18.10',
        lastAddition: { at: '2026-11-08T20:30:00.000Z', amount: '30.50' },
      });
    });

    it('filtre par restaurant et par statut MATCHED, en une seule requête', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([] as never);

      await getCustomerRealSpend('rest-1', 'cust-1');

      expect(db.reservationCheckMatch.findMany).toHaveBeenCalledTimes(1);
      expect(vi.mocked(db.reservationCheckMatch.findMany).mock.calls[0]?.[0]).toMatchObject({
        where: {
          restaurantId: 'rest-1',
          status: 'MATCHED',
          reservation: { customerId: 'cust-1', restaurantId: 'rest-1' },
        },
      });
    });

    it('compte un ticket rattaché à deux réservations une seule fois', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([
        match('r1', { id: 'c1', total: '50.00', partySize: 2 }),
        match('r2', { id: 'c1', total: '50.00', partySize: 2 }),
      ] as never);

      const spend = await getCustomerRealSpend('rest-1', 'cust-1');

      expect(spend).toMatchObject({ total: '50.00', checkCount: 1, averagePerCover: '12.50' });
    });

    it('renvoie null sans ticket rapproché (le champ est alors absent de la fiche)', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([] as never);

      expect(await getCustomerRealSpend('rest-1', 'cust-1')).toBeNull();
    });

    it('renvoie null sans droit pos.connect, sans interroger les tickets', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'ESSENTIAL' } as never);

      expect(await getCustomerRealSpend('rest-1', 'cust-1')).toBeNull();
      expect(db.reservationCheckMatch.findMany).not.toHaveBeenCalled();
    });
  });

  describe('getReservationAddition', () => {
    it('renvoie le total net, l’heure de l’addition et la table du ticket', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([
        match('r1', {
          id: 'c1',
          total: '72.40',
          refund: '2.40',
          closedAt: '2026-11-08T21:15:00.000Z',
        }),
      ] as never);

      expect(await getReservationAddition('rest-1', 'r1')).toEqual({
        total: '70.00',
        at: '2026-11-08T21:15:00.000Z',
        table: '4',
      });
      expect(vi.mocked(db.reservationCheckMatch.findMany).mock.calls[0]?.[0]).toMatchObject({
        where: { restaurantId: 'rest-1', reservationId: 'r1', status: 'MATCHED' },
      });
    });

    it('renvoie null sans addition MATCHED ni droit pos.connect', async () => {
      vi.mocked(db.reservationCheckMatch.findMany).mockResolvedValue([] as never);
      expect(await getReservationAddition('rest-1', 'r1')).toBeNull();

      vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'ESSENTIAL' } as never);
      expect(await getReservationAddition('rest-1', 'r1')).toBeNull();
    });
  });
});
