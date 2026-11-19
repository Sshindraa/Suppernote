'use client';

import { useCallback, useEffect, useState } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/StatusBadge';

/** Annulation ou modification faite par le client avec son lien (aucun envoi au restaurant). */
export type CustomerChange = {
  reservationId: string;
  kind: 'cancelled' | 'modified';
  at: string;
  customerName: string;
  partySize: number;
  startsAt: string;
  previousStartsAt: string | null;
  previousPartySize: number | null;
};

const REFRESH_MS = 60_000;
const hour = (iso: string) => format(new Date(iso), 'HH:mm');

/** Changements des dernières 24 h, du plus récent au plus ancien, rafraîchis chaque minute. */
export function useCustomerChanges(): CustomerChange[] {
  const { get, orgId } = useApi();
  const [changes, setChanges] = useState<CustomerChange[]>([]);
  const load = useCallback(async () => {
    if (!orgId) return;
    try {
      const rows = await get<CustomerChange[]>('v2/reservations/customer-changes');
      setChanges(
        Array.isArray(rows)
          ? rows.filter(
              (row) =>
                (row?.kind === 'cancelled' || row?.kind === 'modified') &&
                typeof row.reservationId === 'string' &&
                !Number.isNaN(Date.parse(row.at)) &&
                !Number.isNaN(Date.parse(row.startsAt)),
            )
          : [],
      );
    } catch {
      // Signal secondaire : la liste des réservations affiche déjà ses propres erreurs.
    }
  }, [get, orgId]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  return changes;
}

/** Dernier changement client de chaque réservation (la liste arrive triée du plus récent). */
export function latestChangeByReservation(changes: CustomerChange[]) {
  const map = new Map<string, CustomerChange>();
  for (const change of changes)
    if (!map.has(change.reservationId)) map.set(change.reservationId, change);
  return map;
}

export function describeCustomerChange(change: CustomerChange): string {
  const when = format(new Date(change.startsAt), 'EEEE d MMMM', { locale: fr });
  if (change.kind === 'cancelled')
    return `${change.customerName} a annulé (${change.partySize} pers., ${when} à ${hour(change.startsAt)})`;
  const time =
    change.previousStartsAt && change.previousStartsAt !== change.startsAt
      ? `${hour(change.previousStartsAt)} → ${hour(change.startsAt)}`
      : hour(change.startsAt);
  const size =
    change.previousPartySize && change.previousPartySize !== change.partySize
      ? `${change.previousPartySize} → ${change.partySize} pers.`
      : `${change.partySize} pers.`;
  return `${change.customerName} a modifié : ${when}, ${time}, ${size}`;
}

export function CustomerChangeBadge({ change }: { change?: CustomerChange }) {
  if (!change) return null;
  return (
    <StatusBadge level="action">
      {change.kind === 'cancelled' ? 'Annulée' : 'Modifiée'} par le client à {hour(change.at)}
    </StatusBadge>
  );
}

const seenKey = (orgId: string) => `customer-changes-seen:${orgId}`;

/** Bandeau des changements clients pas encore vus sur cet appareil. */
export function CustomerChangesBanner({ changes }: { changes: CustomerChange[] }) {
  const { orgId } = useApi();
  const [seenAt, setSeenAt] = useState<string | null>(null);
  useEffect(() => {
    if (!orgId) return;
    try {
      setSeenAt(localStorage.getItem(seenKey(orgId)));
    } catch {
      setSeenAt(null);
    }
  }, [orgId]);
  const unseen = changes.filter((change) => !seenAt || change.at > seenAt);
  if (!orgId || unseen.length === 0) return null;
  const markSeen = () => {
    const latest = unseen[0].at;
    setSeenAt(latest);
    try {
      localStorage.setItem(seenKey(orgId), latest);
    } catch {
      // Stockage indisponible : le bandeau est masqué jusqu'au rechargement.
    }
  };
  return (
    <section
      role="status"
      className="rounded-xl border border-border bg-muted/50 p-4 transition-all duration-200"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-1.5">
          <p className="text-sm font-semibold">
            {unseen.length === 1
              ? '1 changement fait par un client'
              : `${unseen.length} changements faits par des clients`}
          </p>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {unseen.map((change) => (
              <li key={`${change.reservationId}-${change.at}`}>
                <span className="tabular-nums">{hour(change.at)}</span> ·{' '}
                {describeCustomerChange(change)}
              </li>
            ))}
          </ul>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={markSeen}
          className="shrink-0 transition-all duration-200"
        >
          J’ai vu
        </Button>
      </div>
    </section>
  );
}
