import { differenceInMinutes, isAfter, isSameDay, isWithinInterval, parseISO } from 'date-fns';
import type { FloorPlanTable, PlanningReservation } from '@/types/api';

export type TableStatus = 'free' | 'reserved' | 'upcoming' | 'late' | 'occupied' | 'inactive';

export function getTableStatus(
  table: FloorPlanTable,
  reservations: PlanningReservation[],
  now: Date,
): { status: TableStatus; reservation: PlanningReservation | null } {
  if (!table.isActive) {
    return { status: 'inactive', reservation: null };
  }

  const tableRes = reservations.filter(
    (r) => r.tableId === table.id && !['CANCELLED', 'NO_SHOW'].includes(r.state),
  );

  const current = tableRes.find((r) => {
    const start = parseISO(r.startsAt);
    const end = parseISO(r.endsAt);
    return isWithinInterval(now, { start, end }) && r.state === 'SEATED';
  });

  if (current) {
    return { status: 'occupied', reservation: current };
  }

  const late = tableRes.find((r) => {
    const start = parseISO(r.startsAt);
    const end = parseISO(r.endsAt);
    return !isAfter(start, now) && isAfter(end, now) && ['PENDING', 'CONFIRMED'].includes(r.state);
  });

  if (late) {
    return { status: 'late', reservation: late };
  }

  const upcoming = tableRes.find((r) => {
    const start = parseISO(r.startsAt);
    const diff = differenceInMinutes(start, now);
    return (
      isAfter(start, now) &&
      diff <= 30 &&
      (isSameDay(start, now) || diff <= 30) &&
      ['PENDING', 'CONFIRMED'].includes(r.state)
    );
  });

  if (upcoming) {
    return { status: 'upcoming', reservation: upcoming };
  }

  const reserved = tableRes.find((r) => {
    const start = parseISO(r.startsAt);
    return (
      isAfter(start, now) && isSameDay(start, now) && ['PENDING', 'CONFIRMED'].includes(r.state)
    );
  });

  if (reserved) {
    return { status: 'reserved', reservation: reserved };
  }

  return { status: 'free', reservation: null };
}
