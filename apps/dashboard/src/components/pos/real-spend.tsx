/** Dépense réelle issue des tickets de caisse rapprochés (API : lecture à la demande). */

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';

export interface CustomerRealSpend {
  total: string;
  checkCount: number;
  averageAddition: string;
  averagePerCover: string | null;
  lastAddition: { at: string; amount: string };
}

export interface ReservationAddition {
  total: string;
  at: string;
  table: string | null;
}

export function formatEuro(value: string | number): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount)
    : String(value);
}

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString('fr-FR', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** Rendu seulement quand la fiche a une dépense réelle : aucun bloc vide, aucune invitation. */
export function CustomerRealSpendCard({ spend }: { spend?: CustomerRealSpend | null }) {
  if (!spend) return null;
  return (
    <section
      aria-labelledby="customer-real-spend-title"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <h2 id="customer-real-spend-title" className="text-sm font-medium">
        Dépense réelle
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <Item label="Total" value={formatEuro(spend.total)} />
        <Item label="Addition moyenne" value={formatEuro(spend.averageAddition)} />
        {spend.averagePerCover ? (
          <Item label="Par couvert" value={formatEuro(spend.averagePerCover)} />
        ) : null}
        <Item
          label="Dernière addition"
          value={`${formatEuro(spend.lastAddition.amount)} · ${formatDay(spend.lastAddition.at)}`}
        />
      </dl>
    </section>
  );
}

/** Libellé de table tel que saisi en caisse : « Table 12 » ou « Terrasse » restent tels quels, « 12 » devient « Table 12 ». */
export function tableLabel(name: string): string {
  return /^\p{L}/u.test(name) ? name : `Table ${name}`;
}

/** Une ligne « Addition » du détail de réservation, à placer dans sa grille `dl`. */
export function ReservationAdditionLine({ addition }: { addition?: ReservationAddition | null }) {
  if (!addition) return null;
  const table = addition.table ? ` · ${tableLabel(addition.table)}` : '';
  return (
    <div className="col-span-2">
      <dt className="text-muted-foreground">Addition</dt>
      <dd>{`${formatEuro(addition.total)} · ${formatTime(addition.at)}${table}`}</dd>
    </div>
  );
}

/**
 * Addition de la réservation, lue seulement si `enabled` (droit pos.connect). Une réponse pour une
 * autre réservation n'est jamais renvoyée (évite d'afficher l'addition précédente).
 */
export function useReservationAddition(
  reservationId: string,
  enabled: boolean,
): ReservationAddition | null {
  const { get } = useApi();
  const [loaded, setLoaded] = useState<{ id: string; value: ReservationAddition | null } | null>(
    null,
  );

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    get<{ data: ReservationAddition | null }>(`reservations/${reservationId}/addition`)
      .then((response) => {
        if (active) setLoaded({ id: reservationId, value: response.data });
      })
      .catch(() => {
        if (active) setLoaded({ id: reservationId, value: null });
      });
    return () => {
      active = false;
    };
    // `get` changes identity on each render; only the reservation or the right refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservationId, enabled]);

  return enabled && loaded?.id === reservationId ? loaded.value : null;
}
