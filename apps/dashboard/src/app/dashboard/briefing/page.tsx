'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { ServiceCardBadges, useServiceCards } from '@/components/reservation/service-card-badges';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useApi } from '@/lib/api';
import { getDayReservations } from '@/lib/day-reservations';
import { cn } from '@/lib/utils';
import { getErrorMessage, type Reservation } from '@/types/api';
import { RoomStatistics } from './RoomStatistics';
import { summarizeBriefing, upcomingReservations } from './briefing-summary';

export default function BriefingPage() {
  const { get, orgId } = useApi();
  const [reservations, setReservations] = useState<Reservation[] | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const today = format(new Date(), 'yyyy-MM-dd');

  useEffect(() => {
    if (!orgId) return;
    const controller = new AbortController();
    getDayReservations(get, today, controller.signal)
      .then((data) => setReservations(data))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(getErrorMessage(err, 'Impossible de charger le briefing.'));
      });
    return () => controller.abort();
  }, [get, orgId, today, attempt]);

  const rows = upcomingReservations(reservations ?? []);
  const serviceCards = useServiceCards(rows.map((reservation) => reservation.id));
  const summary = summarizeBriefing(
    rows.map((reservation) => ({ reservation, card: serviceCards.cards.get(reservation.id) })),
  );
  const tiles = [
    { label: 'Réservations', value: summary.reservations },
    { label: 'Couverts', value: summary.covers },
    { label: 'Allergies', value: summary.allergies, alert: true },
    { label: 'Habitués', value: summary.regulars },
    { label: 'Occasions', value: summary.occasions },
    { label: 'Risque d’absence', value: summary.noShowRisks, alert: true },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">
          Briefing du service
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Aujourd’hui, {format(new Date(), 'EEEE d MMMM', { locale: fr })}
        </p>
      </div>

      {error ? (
        <Card className="border-destructive/40">
          <CardContent className="flex items-start gap-3 pt-6 text-sm text-destructive">
            <div className="space-y-3">
              <p role="alert">{error}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="transition-all duration-200"
                onClick={() => {
                  setError('');
                  setAttempt((count) => count + 1);
                }}
              >
                Réessayer
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : reservations === null ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-24 rounded-2xl" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune réservation à servir aujourd’hui.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {tiles.map((tile) => (
              <Card
                key={tile.label}
                className={cn(tile.value > 0 && tile.alert && 'border-foreground bg-secondary')}
              >
                <CardContent className="flex h-full flex-col justify-between gap-2 p-4">
                  <p className="text-sm font-medium leading-tight text-muted-foreground">
                    {tile.label}
                  </p>
                  <p className="text-3xl font-semibold tabular-nums leading-none tracking-tight text-foreground">
                    {tile.value}
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardContent className="p-0">
              <ol aria-label="Réservations du jour" className="divide-y divide-border text-sm">
                {rows.map((reservation) => {
                  const customerId = serviceCards.cards.get(reservation.id)?.customerId;
                  return (
                    <li
                      key={reservation.id}
                      className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="flex min-w-0 items-center gap-4">
                        <time
                          dateTime={reservation.reservedAt}
                          className="w-14 shrink-0 font-semibold tabular-nums"
                        >
                          {format(new Date(reservation.reservedAt), 'HH:mm')}
                        </time>
                        <div className="min-w-0">
                          {customerId ? (
                            <Link
                              href={`/dashboard/customers/crm/${customerId}`}
                              className="block break-words font-medium transition-all duration-200 hover:underline"
                            >
                              {reservation.customerName}
                            </Link>
                          ) : (
                            <p className="break-words font-medium">{reservation.customerName}</p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {reservation.partySize} couvert
                            {reservation.partySize > 1 ? 's' : ''}
                            {reservation.table?.name ? ` · ${reservation.table.name}` : ''}
                          </p>
                        </div>
                      </div>
                      <ServiceCardBadges reservationId={reservation.id} state={serviceCards} />
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>
        </>
      )}
      <RoomStatistics key={orgId} today={today} />
    </div>
  );
}
