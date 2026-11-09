import { useMemo } from 'react';
import { addMinutes, format, isWithinInterval, parseISO, startOfDay } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AlertTriangle, CircleCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { FloorPlanTable, PlanningReservation } from '@/types/api';
import type { TableStatus } from '../floor-plan/_components/table-status';

type StatsPanelProps = {
  reservations: PlanningReservation[];
  allTables: FloorPlanTable[];
  tableStatuses: Map<string, { status: TableStatus; reservation: PlanningReservation | null }>;
  liveDate: string;
};

export function StatsPanel({ reservations, allTables, tableStatuses, liveDate }: StatsPanelProps) {
  const now = new Date();
  const stats = useMemo(() => {
    const activeTables = allTables.filter((t) => t.isActive);
    const inactiveTables = allTables.filter((t) => !t.isActive);
    const totalCapacity = activeTables.reduce((sum, t) => sum + t.capacity, 0);

    const seated = reservations.filter((r) => r.state === 'SEATED' && r.tableId);
    const seatedCovers = seated.reduce((sum, r) => sum + r.partySize, 0);
    const occupancyRate = totalCapacity > 0 ? Math.round((seatedCovers / totalCapacity) * 100) : 0;

    const activeReservations = reservations.filter((r) =>
      ['CONFIRMED', 'SEATED'].includes(r.state),
    );
    const plannedCovers = activeReservations.reduce((sum, r) => sum + r.partySize, 0);

    const lateCount = [...tableStatuses.values()].filter((s) => s.status === 'late').length;
    const upcomingCount = [...tableStatuses.values()].filter((s) => s.status === 'upcoming').length;
    const occupiedCount = [...tableStatuses.values()].filter((s) => s.status === 'occupied').length;
    const freeCount = [...tableStatuses.values()].filter((s) => s.status === 'free').length;

    return {
      activeTables: activeTables.length,
      inactiveTables: inactiveTables.length,
      totalCapacity,
      seatedCovers,
      occupancyRate,
      plannedCovers,
      lateCount,
      upcomingCount,
      occupiedCount,
      freeCount,
      totalReservations: reservations.length,
    };
  }, [allTables, reservations, tableStatuses]);

  const forecast = useMemo(() => {
    const dayStart = startOfDay(parseISO(liveDate));
    const slots = Array.from({ length: 48 }, (_, i) => addMinutes(dayStart, i * 30));
    return slots
      .map((slot) => {
        const covers = reservations.reduce((sum, r) => {
          if (!r.startsAt || !r.endsAt || r.state === 'CANCELLED' || r.state === 'NO_SHOW') {
            return sum;
          }
          const start = parseISO(r.startsAt);
          const end = parseISO(r.endsAt);
          if (isWithinInterval(slot, { start, end })) {
            return sum + r.partySize;
          }
          return sum;
        }, 0);
        const newArrivals = reservations.filter((r) => {
          if (!r.startsAt || r.state === 'CANCELLED' || r.state === 'NO_SHOW') return false;
          const start = parseISO(r.startsAt);
          return format(start, 'HH:mm') === format(slot, 'HH:mm');
        }).length;
        return { time: format(slot, 'HH:mm'), covers, newArrivals };
      })
      .filter((s) => s.covers > 0 || s.newArrivals > 0);
  }, [reservations, liveDate]);

  const maxSlotCovers = Math.max(1, ...forecast.map((s) => s.covers));

  const { legacyUnseatedCount, legacyUnseatedExamples } = useMemo(() => {
    const excluded = new Set(['CANCELLED', 'NO_SHOW']);
    const matches = reservations.filter((r) => !excluded.has(r.state) && !r.tableId);
    return {
      legacyUnseatedCount: matches.length,
      legacyUnseatedExamples: matches.slice(0, 3).map((r) => ({
        id: r.id,
        time: r.startsAt ? format(parseISO(r.startsAt), 'HH:mm', { locale: fr }) : '--:--',
        customerName: r.customerName,
        partySize: r.partySize,
      })),
    };
  }, [reservations]);

  const overCapacitySlots = useMemo(
    () => forecast.filter((slot) => slot.covers > stats.totalCapacity),
    [forecast, stats.totalCapacity],
  );

  return (
    <div className="space-y-0">
      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-2xl font-semibold">{stats.occupancyRate}%</p>
          <p className="text-xs text-muted-foreground">Taux d&apos;occupation</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.seatedCovers} / {stats.totalCapacity} places
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-2xl font-semibold">{stats.plannedCovers}</p>
          <p className="text-xs text-muted-foreground">Couverts prévus</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.totalReservations} réservation{stats.totalReservations > 1 ? 's' : ''}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-2xl font-semibold">{stats.activeTables}</p>
          <p className="text-xs text-muted-foreground">Tables actives</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.inactiveTables} inactive{stats.inactiveTables > 1 ? 's' : ''}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-2xl font-semibold">{stats.occupiedCount}</p>
          <p className="text-xs text-muted-foreground">En service</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stats.upcomingCount} prochaines · {stats.lateCount} retard
          </p>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h3 className="mb-4 text-sm font-semibold">Prévisions de couverts par créneau (30 min)</h3>
        {forecast.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune réservation sur cette journée.</p>
        ) : (
          <div className="space-y-3">
            {forecast.slice(0, 20).map((slot) => (
              <div key={slot.time} className="flex items-start gap-3">
                <div className="w-12 shrink-0 text-xs font-medium tabular-nums">{slot.time}</div>
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <span className="whitespace-nowrap text-xs font-medium tabular-nums">
                      {slot.covers} couverts
                    </span>
                    {slot.newArrivals > 0 ? (
                      <Badge variant="outline" className="whitespace-nowrap text-xs">
                        {slot.newArrivals} arrivée{slot.newArrivals > 1 ? 's' : ''} à {slot.time}
                      </Badge>
                    ) : null}
                  </div>
                  <div
                    className="h-2 rounded-full bg-primary transition-all"
                    style={{ width: `${(slot.covers / maxSlotCovers) * 100}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <Card className="mt-6">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm font-semibold">
            <AlertTriangle className="text-warning" size={16} />
            Alertes
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {legacyUnseatedCount === 0 && overCapacitySlots.length === 0 ? (
            <div className="flex items-center gap-2 text-sm text-success">
              <CircleCheck size={16} />
              Aucune alerte.
            </div>
          ) : (
            <>
              {legacyUnseatedCount > 0 && (
                <div className="rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle size={16} />
                    {legacyUnseatedCount} réservation{legacyUnseatedCount > 1 ? 's' : ''} sans table
                  </div>
                  {legacyUnseatedExamples.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {legacyUnseatedExamples.map((item) => (
                        <li key={item.id} className="text-xs">
                          {item.time} ·{' '}
                          {item.customerName
                            ? `${item.customerName} · ${item.partySize} couverts`
                            : `${item.partySize} couverts`}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {overCapacitySlots.length > 0 && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
                  <div className="flex items-center gap-2 font-medium">
                    <AlertTriangle size={16} />
                    Surcapacité détectée
                  </div>
                  <ul className="mt-2 space-y-1">
                    {overCapacitySlots.map((slot) => (
                      <li key={slot.time} className="flex items-center justify-between text-xs">
                        <span>{slot.time}</span>
                        <Badge variant="destructive" className="text-xs">
                          {slot.covers} / {stats.totalCapacity}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
