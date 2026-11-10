'use client';

import { useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataFetchError } from '@/components/DataFetchError';

export type PosCheckListItem = {
  id: string;
  externalId: string;
  openedAt: string;
  tableReference: string | null;
  total: string;
  currency: string;
  match: {
    status: string;
    confidence: number;
    reservation: { id: string; at: string; partySize: number; table: string | null };
  } | null;
};

type ListPage = { items: PosCheckListItem[]; nextCursor: string | null };

const PAGE_SIZE = 50;

/**
 * Tickets imported for this restaurant, most recent first. Remounted (via `key`) after an import or
 * a retry, which restarts the first page from the loading state.
 */
export function PosTicketList() {
  const [attempt, setAttempt] = useState(0);
  return <TicketListBody key={attempt} onRetry={() => setAttempt((value) => value + 1)} />;
}

function TicketListBody({ onRetry }: { onRetry: () => void }) {
  const { get } = useApi();
  const [items, setItems] = useState<PosCheckListItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    get<{ data: ListPage }>(`pos/checks?limit=${PAGE_SIZE}`)
      .then((response) => {
        if (cancelled) return;
        setItems(response.data.items);
        setNextCursor(response.data.nextCursor);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(getErrorMessage(err, 'Impossible de charger les tickets pour le moment.'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [get]);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const response = await get<{ data: ListPage }>(
        `pos/checks?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`,
      );
      setItems((current) => [...(current ?? []), ...response.data.items]);
      setNextCursor(response.data.nextCursor);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de charger la suite des tickets.'));
    } finally {
      setLoadingMore(false);
    }
  }

  if (error) {
    return <DataFetchError message={error} onRetry={onRetry} />;
  }

  if (items === null) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    );
  }

  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">Aucun ticket importé pour l’instant.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="divide-y divide-border rounded-xl border border-border">
        {items.map((ticket) => (
          <li
            key={ticket.id}
            className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium">
                Ticket {ticket.externalId}
                {ticket.tableReference ? ` · table ${ticket.tableReference}` : ''}
              </p>
              <p className="text-sm text-muted-foreground tabular-nums">
                {formatDateTime(ticket.openedAt)} · {formatEuro(ticket.total)}
              </p>
            </div>
            <MatchBadge match={ticket.match} />
          </li>
        ))}
      </ul>
      {nextCursor ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            disabled={loadingMore}
            className="transition-all duration-200"
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Chargement…' : 'Voir plus'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function MatchBadge({ match }: { match: PosCheckListItem['match'] }) {
  if (!match) {
    return <Badge variant="outline">Non rapproché</Badge>;
  }
  const at = formatTime(match.reservation.at);
  const details = `${at} · ${match.reservation.partySize} couvert(s)`;
  if (match.status === 'MATCHED') {
    return <Badge variant="secondary">Rapproché · {details}</Badge>;
  }
  return <Badge variant="outline">À vérifier · {details}</Badge>;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' }).format(date);
}

function formatEuro(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount)
    : value;
}
