'use client';

import { useEffect, useMemo, useState } from 'react';
import { useApi } from '@/lib/api';
import { getErrorMessage, type FloorPlan, type PlanningReservation } from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, BarChart3, LayoutGrid, Users, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';

type StatsTabProps = {
  orgId: string;
};

export function StatsTab({ orgId }: StatsTabProps) {
  const { get } = useApi();

  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null);
  const [reservations, setReservations] = useState<PlanningReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!orgId) return;

    const today = format(new Date(), 'yyyy-MM-dd');

    async function fetchData() {
      try {
        setLoading(true);
        const [fp, res] = await Promise.all([
          get<FloorPlan>(`restaurants/${orgId}/floor-plan`),
          get<PlanningReservation[]>(`restaurants/${orgId}/floor-plan/reservations?date=${today}`),
        ]);
        setFloorPlan(fp);
        setReservations(res);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de charger les statistiques'));
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, [orgId, get]);

  const stats = useMemo(() => {
    const tables = floorPlan?.tables ?? floorPlan?.sections.flatMap((s) => s.tables) ?? [];

    const activeTables = tables.filter((t) => t.isActive);
    const inactiveTables = tables.filter((t) => !t.isActive);
    const totalCapacity = tables.reduce((sum, t) => sum + t.capacity, 0);
    const activeCapacity = activeTables.reduce((sum, t) => sum + t.capacity, 0);
    const covers = reservations.reduce((sum, r) => sum + r.partySize, 0);
    const occupancyRate = activeCapacity > 0 ? (covers / activeCapacity) * 100 : 0;
    const unassigned = reservations.filter((r) => !r.tableId).length;

    return {
      activeTables: activeTables.length,
      inactiveTables: inactiveTables.length,
      totalCapacity,
      activeCapacity,
      covers,
      occupancyRate,
      unassigned,
    };
  }, [floorPlan, reservations]);

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-36 w-full rounded-2xl" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="suppernote-error">
        <AlertCircle size={18} />
        {error}
      </div>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card className="suppernote-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <BarChart3 size={16} />
            Taux d&apos;occupation
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">{Math.round(stats.occupancyRate)}%</div>
          <p className="text-sm text-muted-foreground">
            {stats.covers} couverts sur {stats.activeCapacity} places actives
          </p>
        </CardContent>
      </Card>

      <Card className="suppernote-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <LayoutGrid size={16} />
            Tables actives / inactives
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">
            {stats.activeTables}{' '}
            <span className="text-base font-normal text-muted-foreground">
              / {stats.inactiveTables}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {stats.activeTables + stats.inactiveTables} tables au total
          </p>
        </CardContent>
      </Card>

      <Card className="suppernote-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Users size={16} />
            Capacité totale
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">{stats.totalCapacity}</div>
          <p className="text-sm text-muted-foreground">{stats.activeCapacity} places actives</p>
        </CardContent>
      </Card>

      <Card className="suppernote-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle size={16} />
            Réservations sans table
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-3xl font-semibold">{stats.unassigned}</div>
          <p className="text-sm text-muted-foreground">
            sur {reservations.length} réservations aujourd&apos;hui
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
