import { db } from '../../shared/db/client';
import {
  scoreReservationCheckMatch,
  type ReservationMatchCandidate,
} from './reservation-check-matcher.service';
import { upsertReservationCheckMatch } from './pos-sync.service';

/** Same window as the matcher's time rule: a ticket opened within 45 minutes of the reservation. */
const WINDOW_MS = 45 * 60_000;
/** Reservations that cannot have been served: never a candidate. */
const CLOSED_STATES = ['CANCELLED', 'NO_SHOW', 'FAILED', 'EXPIRED'] as const;

export interface AutoMatchTicket {
  /** Persisted check id, or a local key in a dry run (nothing is written). */
  id: string;
  openedAt: Date;
  tableReference: string | null;
  partySize: number | null;
}

export interface AutoMatchOutcome {
  matched: number;
  review: number;
}

/**
 * Links tickets that name no reservation to the best reservation of the same restaurant. One query
 * per call, whatever the number of tickets. Only MATCHED and REVIEW are kept; a ticket with no
 * candidate at score 50 or more is left unmatched. A tie at the top is REVIEW, never MATCHED.
 * Nothing here touches a customer profile.
 */
export async function matchTicketsToReservations(args: {
  restaurantId: string;
  tickets: AutoMatchTicket[];
  persist: boolean;
}): Promise<AutoMatchOutcome> {
  const outcome: AutoMatchOutcome = { matched: 0, review: 0 };
  if (args.tickets.length === 0) return outcome;

  const times = args.tickets.map((ticket) => ticket.openedAt.getTime());
  const from = new Date(Math.min(...times) - WINDOW_MS);
  const to = new Date(Math.max(...times) + WINDOW_MS);
  const rows = await db.reservation.findMany({
    where: {
      restaurantId: args.restaurantId,
      isTest: false,
      status: { notIn: ['CANCELLED', 'NO_SHOW'] },
      state: { notIn: [...CLOSED_STATES] },
      OR: [
        { startsAt: { gte: from, lte: to } },
        { startsAt: null, reservedAt: { gte: from, lte: to } },
      ],
    },
    select: {
      id: true,
      restaurantId: true,
      reservedAt: true,
      startsAt: true,
      partySize: true,
      table: { select: { name: true } },
    },
  });
  // Tenant scope checked twice: a reservation of another restaurant is never a candidate.
  const candidates = rows
    .filter((row) => row.restaurantId === args.restaurantId)
    .map(
      (row): ReservationMatchCandidate => ({
        id: row.id,
        reservedAt: row.reservedAt,
        startsAt: row.startsAt,
        partySize: row.partySize,
        // The table name, not its id: the matcher compares the ticket's table label with it.
        tableReference: row.table?.name ?? null,
      }),
    );

  for (const ticket of args.tickets) {
    const check = {
      id: ticket.id,
      openedAt: ticket.openedAt,
      partySize: ticket.partySize,
      tableReference: ticket.tableReference,
    };
    const scored = candidates
      .filter((reservation) => {
        const time = reservation.startsAt ?? reservation.reservedAt;
        return (
          time != null &&
          Math.abs(new Date(time).getTime() - ticket.openedAt.getTime()) <= WINDOW_MS
        );
      })
      .map((reservation) => ({
        reservation,
        result: scoreReservationCheckMatch({ reservation, check }),
      }))
      .filter(({ result }) => result.status !== 'UNMATCHED')
      .sort((a, b) => b.result.score - a.result.score);

    const best = scored[0];
    if (!best) continue;
    const tie = scored[1]?.result.score === best.result.score;
    const status = best.result.status === 'MATCHED' && tie ? 'REVIEW' : best.result.status;
    if (status === 'MATCHED') outcome.matched += 1;
    else outcome.review += 1;

    if (args.persist) {
      await upsertReservationCheckMatch({
        restaurantId: args.restaurantId,
        reservationId: best.reservation.id,
        posCheckId: ticket.id,
        reservation: best.reservation,
        check,
        reviewOnly: tie,
      });
    }
  }
  return outcome;
}
