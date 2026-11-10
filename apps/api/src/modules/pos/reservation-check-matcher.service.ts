export const RESERVATION_CHECK_MATCH_STATUSES = ['MATCHED', 'REVIEW', 'UNMATCHED'] as const;
export type ReservationCheckMatchStatus = (typeof RESERVATION_CHECK_MATCH_STATUSES)[number];

export type ReservationCheckMatchMethod =
  | 'RESERVATION_EXTERNAL_ID'
  | 'CUSTOMER_TOKEN'
  | 'TABLE_AND_TIME'
  | 'TABLE'
  | 'TIME_WINDOW'
  | 'PARTY_SIZE'
  | 'SCORING'
  | 'NONE';

export interface ReservationMatchCandidate {
  id: string;
  reservedAt?: Date | string | null;
  startsAt?: Date | string | null;
  partySize?: number | null;
  tableId?: string | null;
  tableReference?: string | null;
  customerPhone?: string | null;
  customerToken?: string | null;
  reservationExternalId?: string | null;
}

export interface PosCheckMatchCandidate {
  id: string;
  openedAt: Date | string;
  partySize?: number | null;
  tableReference?: string | null;
  customerPhone?: string | null;
  customerToken?: string | null;
  reservationExternalId?: string | null;
  /** Set by a caller when another confirmed reservation conflicts with this ticket. */
  conflict?: boolean;
}

export interface ReservationCheckMatchResult {
  score: number;
  confidence: number;
  status: ReservationCheckMatchStatus;
  method: ReservationCheckMatchMethod;
  reasons: string[];
}

const WINDOW_MINUTES = 45;

function dateValue(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function tokenValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function phoneValue(value: string | null | undefined): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 6 ? digits : null;
}

/**
 * Table label as compared between a ticket and a reservation: « Table 12 », « T12 », « 12 » and
 * « n°12 » are the same table. Letters and digits only, accents and case ignored.
 */
export function normalizeTableLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const base = value.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const withoutWord = base.replace(/^table\b\s*/, '');
  const normalized = withoutWord
    .replace(/^(?:t|n|no|num|numero|n°|nº)\s*[°º.:-]?\s*(?=\d)/, '')
    .replace(/[^a-z0-9]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function sameTable(reservation: ReservationMatchCandidate, check: PosCheckMatchCandidate): boolean {
  const reservationTable = normalizeTableLabel(reservation.tableReference ?? reservation.tableId);
  const checkTable = normalizeTableLabel(check.tableReference);
  return Boolean(reservationTable && checkTable && reservationTable === checkTable);
}

function sameCustomerToken(
  reservation: ReservationMatchCandidate,
  check: PosCheckMatchCandidate,
): boolean {
  const reservationPhone = phoneValue(reservation.customerPhone);
  const checkPhone = phoneValue(check.customerPhone);
  if (reservationPhone && checkPhone && reservationPhone === checkPhone) return true;

  const reservationToken = tokenValue(reservation.customerToken);
  const checkToken = tokenValue(check.customerToken);
  return Boolean(reservationToken && checkToken && reservationToken === checkToken);
}

function compatiblePartySize(
  reservation: ReservationMatchCandidate,
  check: PosCheckMatchCandidate,
): boolean {
  if (!Number.isInteger(reservation.partySize) || !Number.isInteger(check.partySize)) return false;
  if ((reservation.partySize ?? 0) <= 0 || (check.partySize ?? 0) <= 0) return false;
  return Math.abs((reservation.partySize ?? 0) - (check.partySize ?? 0)) <= 1;
}

/**
 * Calculate the explainable v1 reservation → ticket score.
 *
 * The function is pure and therefore safe to run in shadow mode. A caller may
 * persist only the returned method/score/status; no profile enrichment should
 * happen unless the returned status is MATCHED.
 */
export function scoreReservationCheckMatch(args: {
  reservation: ReservationMatchCandidate;
  check: PosCheckMatchCandidate;
}): ReservationCheckMatchResult {
  const { reservation, check } = args;
  let score = 0;
  const reasons: string[] = [];

  const reservationExternalId = tokenValue(reservation.reservationExternalId);
  const checkExternalId = tokenValue(check.reservationExternalId);
  const exactReservationId = Boolean(
    reservationExternalId && checkExternalId && reservationExternalId === checkExternalId,
  );
  if (exactReservationId) {
    score = 100;
    reasons.push('reservation_external_id_exact');
  }

  const tableMatch = sameTable(reservation, check);
  if (tableMatch) {
    score += 35;
    reasons.push('same_table');
  }

  const reservationTime = dateValue(reservation.startsAt ?? reservation.reservedAt);
  const checkTime = dateValue(check.openedAt);
  const withinTimeWindow = Boolean(
    reservationTime !== null &&
    checkTime !== null &&
    Math.abs(reservationTime - checkTime) <= WINDOW_MINUTES * 60_000,
  );
  if (withinTimeWindow) {
    score += 30;
    reasons.push('opened_within_45_minutes');
  }

  const partyMatch = compatiblePartySize(reservation, check);
  if (partyMatch) {
    score += 20;
    reasons.push('compatible_party_size');
  }

  const customerTokenMatch = sameCustomerToken(reservation, check);
  if (customerTokenMatch) {
    score += 40;
    reasons.push('same_customer_phone_or_token');
  }

  if (check.conflict) {
    score -= 50;
    reasons.push('conflicting_confirmed_reservation');
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const status: ReservationCheckMatchStatus =
    boundedScore >= 80 ? 'MATCHED' : boundedScore >= 50 ? 'REVIEW' : 'UNMATCHED';

  const method: ReservationCheckMatchMethod = exactReservationId
    ? 'RESERVATION_EXTERNAL_ID'
    : customerTokenMatch
      ? 'CUSTOMER_TOKEN'
      : tableMatch && withinTimeWindow
        ? 'TABLE_AND_TIME'
        : tableMatch
          ? 'TABLE'
          : withinTimeWindow
            ? 'TIME_WINDOW'
            : partyMatch
              ? 'PARTY_SIZE'
              : reasons.length > 0
                ? 'SCORING'
                : 'NONE';

  return {
    score: boundedScore,
    confidence: boundedScore / 100,
    status,
    method,
    reasons,
  };
}
