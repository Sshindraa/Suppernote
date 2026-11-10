/** Dépense réelle issue des tickets de caisse rapprochés (API : lecture à la demande). */

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

/** Une ligne « Addition » du détail de réservation, à placer dans sa grille `dl`. */
export function ReservationAdditionLine({ addition }: { addition?: ReservationAddition | null }) {
  if (!addition) return null;
  const table = addition.table ? ` · Table ${addition.table}` : '';
  return (
    <div className="col-span-2">
      <dt className="text-muted-foreground">Addition</dt>
      <dd>{`${formatEuro(addition.total)} · ${formatTime(addition.at)}${table}`}</dd>
    </div>
  );
}
