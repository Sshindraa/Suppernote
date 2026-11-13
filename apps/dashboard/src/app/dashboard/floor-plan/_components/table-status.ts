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

  // Une table assise reste occupée après la fin de son créneau : seul le serveur la libère.
  const current = tableRes.find((r) => r.state === 'SEATED' && !isAfter(parseISO(r.startsAt), now));

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

/**
 * Début de la prochaine réservation pas encore assise sur la table ; null si rien d'autre aujourd'hui.
 * Une réservation commencée depuis moins d'une heure compte encore : ses clients attendent peut-être.
 */
export function getFreeUntil(
  table: FloorPlanTable,
  reservations: PlanningReservation[],
  now: Date,
): Date | null {
  const starts = reservations
    .filter(
      (r) =>
        r.tableId === table.id &&
        ['PENDING', 'CONFIRMED'].includes(r.state) &&
        isAfter(parseISO(r.startsAt), new Date(now.getTime() - 60 * 60_000)) &&
        isSameDay(parseISO(r.startsAt), now),
    )
    .map((r) => parseISO(r.startsAt).getTime());
  return starts.length ? new Date(Math.min(...starts)) : null;
}

/** Durée d'un repas : la durée médiane des créneaux réservés du jour, 90 min à défaut. */
export function getMealMinutes(reservations: PlanningReservation[]): number {
  const durations = reservations
    .map((r) => differenceInMinutes(parseISO(r.endsAt), parseISO(r.startsAt)))
    .filter((minutes) => minutes > 0)
    .sort((a, b) => a - b);
  return durations.length ? durations[Math.floor(durations.length / 2)] : 90;
}
