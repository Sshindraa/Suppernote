import type { Reservation } from '@/types/api';

export async function getDayReservations(
  get: <T>(path: string, options?: { signal?: AbortSignal }) => Promise<T>,
  date: string,
  signal?: AbortSignal,
): Promise<Reservation[]> {
  const path = `v2/reservations/day?date=${date}`;
  const rows = signal ? await get<Reservation[]>(path, { signal }) : await get<Reservation[]>(path);
  if (!Array.isArray(rows)) throw new Error('Réponse de réservations invalide.');
  return rows;
}
