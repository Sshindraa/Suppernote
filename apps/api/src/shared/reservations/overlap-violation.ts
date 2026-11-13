/**
 * Chevauchement de deux réservations actives sur une même table : la contrainte EXCLUDE
 * `reservations_no_overlap_active` lève 23P01. Prisma le remonte avec le nom de la
 * contrainte dans le message (voir reservation-modification.integration.test.ts).
 */
export function isReservationOverlapViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const meta = (error as { meta?: { code?: unknown } }).meta;
  return meta?.code === '23P01' || error.message.includes('reservations_no_overlap_active');
}
