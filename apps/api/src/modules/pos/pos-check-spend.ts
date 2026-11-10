import { Prisma } from '@prisma/client';
import { db } from '../../shared/db/client';
import { evaluateCapability } from '../entitlements/entitlement.service';

/**
 * Dépense réelle lue à la demande depuis les tickets `MATCHED` (aucune donnée stockée).
 * `REVIEW` et `UNMATCHED` ne comptent jamais. Montants nets des remboursements.
 */
export interface CustomerRealSpend {
  total: string;
  checkCount: number;
  averageAddition: string;
  /** Null when no matched reservation has covers to divide by. */
  averagePerCover: string | null;
  lastAddition: { at: string; amount: string };
}

export interface ReservationAddition {
  total: string;
  at: string;
  table: string | null;
}

type CheckAmounts = {
  total: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
  openedAt: Date;
  closedAt: Date | null;
  tableReference?: string | null;
};

function netOf(check: CheckAmounts): Prisma.Decimal {
  return check.total.minus(check.refundedAmount);
}

function atOf(check: CheckAmounts): Date {
  return check.closedAt ?? check.openedAt;
}

async function posConnectAllowed(restaurantId: string): Promise<boolean> {
  return (await evaluateCapability(restaurantId, 'pos.connect')).allowed;
}

/** One grouped query for the whole customer; `null` when the plan lacks pos.connect or no ticket is matched. */
export async function getCustomerRealSpend(
  restaurantId: string,
  customerId: string,
): Promise<CustomerRealSpend | null> {
  if (!(await posConnectAllowed(restaurantId))) return null;
  const matches = await db.reservationCheckMatch.findMany({
    where: { restaurantId, status: 'MATCHED', reservation: { customerId, restaurantId } },
    select: {
      reservationId: true,
      reservation: { select: { partySize: true } },
      posCheck: {
        select: { id: true, total: true, refundedAmount: true, openedAt: true, closedAt: true },
      },
    },
  });
  if (matches.length === 0) return null;

  // A ticket can match two reservations of the same guest: count it once. Same for covers.
  const checks = new Map<string, CheckAmounts>();
  const covers = new Map<string, number>();
  for (const match of matches) {
    checks.set(match.posCheck.id, match.posCheck);
    covers.set(match.reservationId, match.reservation.partySize);
  }

  let total = new Prisma.Decimal(0);
  let last: CheckAmounts | null = null;
  for (const check of checks.values()) {
    total = total.plus(netOf(check));
    if (!last || atOf(check) > atOf(last)) last = check;
  }
  const coverCount = [...covers.values()].reduce((sum, n) => sum + n, 0);
  const count = checks.size;

  return {
    total: total.toFixed(2),
    checkCount: count,
    averageAddition: total.div(count).toDecimalPlaces(2).toFixed(2),
    averagePerCover: coverCount > 0 ? total.div(coverCount).toDecimalPlaces(2).toFixed(2) : null,
    lastAddition: { at: atOf(last!).toISOString(), amount: netOf(last!).toFixed(2) },
  };
}

/** The addition linked to one reservation (`MATCHED` only); `null` when none or no pos.connect. */
export async function getReservationAddition(
  restaurantId: string,
  reservationId: string,
): Promise<ReservationAddition | null> {
  if (!(await posConnectAllowed(restaurantId))) return null;
  const matches = await db.reservationCheckMatch.findMany({
    where: { restaurantId, reservationId, status: 'MATCHED' },
    select: {
      posCheck: {
        select: {
          total: true,
          refundedAmount: true,
          openedAt: true,
          closedAt: true,
          tableReference: true,
        },
      },
    },
  });
  if (matches.length === 0) return null;

  let total = new Prisma.Decimal(0);
  let last: CheckAmounts = matches[0]!.posCheck;
  for (const { posCheck } of matches) {
    total = total.plus(netOf(posCheck));
    if (atOf(posCheck) > atOf(last)) last = posCheck;
  }
  return {
    total: total.toFixed(2),
    at: atOf(last).toISOString(),
    table: last.tableReference ?? null,
  };
}
