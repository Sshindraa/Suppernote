import { describe, expect, it } from 'vitest';
import type { FloorPlanTable, PlanningReservation } from '@/types/api';
import { getFreeUntil, getMealMinutes, getTableStatus } from './table-status';

const now = new Date('2026-11-11T21:00:00');
const table = { id: 't5', isActive: true } as FloorPlanTable;
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const reservation = (
  state: string,
  start: number,
  end: number,
  id = `${state}-${start}`,
): PlanningReservation => ({
  id,
  tableId: 't5',
  tableName: 'T5',
  sectionName: null,
  startsAt: at(start),
  endsAt: at(end),
  partySize: 2,
  customerName: null,
  state,
  seatedAt: null,
});

describe('table-status, lecture dans le temps', () => {
  it('donne le début de la prochaine réservation, ou null si la table est libre ce soir', () => {
    expect(getFreeUntil(table, [reservation('CONFIRMED', 80, 200)], now)?.toISOString()).toBe(
      at(80),
    );
    expect(getFreeUntil(table, [reservation('CANCELLED', 80, 200)], now)).toBeNull();
  });

  it('garde une table assise occupée après la fin de son créneau', () => {
    expect(getTableStatus(table, [reservation('SEATED', -150, -30)], now).status).toBe('occupied');
  });

  it('prend la durée médiane des créneaux, 90 min sans réservation', () => {
    expect(
      getMealMinutes([
        reservation('CONFIRMED', 0, 60, 'a'),
        reservation('CONFIRMED', 0, 120, 'b'),
        reservation('CONFIRMED', 0, 150, 'c'),
      ]),
    ).toBe(120);
    expect(getMealMinutes([])).toBe(90);
  });
});
