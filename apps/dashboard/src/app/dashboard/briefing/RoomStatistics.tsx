import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useApi } from '@/lib/api';
import {
  getErrorMessage,
  type FloorPlan,
  type FloorPlanSummary,
  type PlanningReservation,
} from '@/types/api';
import { getTableStatus } from '../floor-plan/_components/table-status';
import { StatsPanel } from './StatsPanel';

export function RoomStatistics({ today }: { today: string }) {
  const { get, orgId } = useApi();
  const [date, setDate] = useState(today);
  const [planId, setPlanId] = useState('');
  const [plans, setPlans] = useState<FloorPlanSummary[]>([]);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<
    { plan: FloorPlan; reservations: PlanningReservation[] } | { error: string } | null
  >(null);

  useEffect(() => {
    if (!orgId) return;
    const controller = new AbortController();
    void get<FloorPlanSummary[]>(`restaurants/${orgId}/floor-plans`, { signal: controller.signal })
      .then((items) => {
        if (!controller.signal.aborted) setPlans(items.filter((plan) => plan.isActive));
      })
      .catch(() => {
        if (!controller.signal.aborted) setPlans([]);
      });
    return () => controller.abort();
  }, [get, orgId, attempt]);

  useEffect(() => {
    setResult(null);
    if (!orgId) return;
    const controller = new AbortController();
    const base = `restaurants/${orgId}`;
    const query = new URLSearchParams({ date });
    if (planId) query.set('floorPlanId', planId);
    void Promise.all([
      get<FloorPlan>(planId ? `${base}/floor-plans/${planId}` : `${base}/floor-plan`, {
        signal: controller.signal,
      }),
      get<PlanningReservation[]>(`${base}/floor-plan/reservations?${query}`, {
        signal: controller.signal,
      }),
    ])
      .then(([plan, reservations]) => {
        if (!controller.signal.aborted) setResult({ plan, reservations });
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          setResult({
            error: getErrorMessage(err, 'Impossible de charger les statistiques de salle.'),
          });
        }
      });
    return () => controller.abort();
  }, [get, orgId, date, planId, attempt]);

  const data = result && 'plan' in result ? result : null;
  const tables = data
    ? Array.from(
        new Map(
          [
            ...(data.plan.tables ?? []),
            ...data.plan.sections.flatMap((section) => section.tables),
          ].map((table) => [table.id, table]),
        ).values(),
      )
    : [];
  const tableIds = new Set(tables.map((table) => table.id));
  const reservations =
    data?.reservations.filter((r) => !r.tableId || tableIds.has(r.tableId)) ?? [];
  const now = new Date();
  const statuses = new Map(
    tables.map((table) => [table.id, getTableStatus(table, reservations, now)]),
  );

  return (
    <section aria-labelledby="room-statistics-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="room-statistics-heading" className="text-lg font-semibold">
          Statistiques de salle
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {plans.length > 1 ? (
            <select
              aria-label="Plan des statistiques"
              className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm"
              value={planId}
              onChange={(event) => setPlanId(event.target.value)}
            >
              <option value="">Plan par défaut</option>
              {plans
                .filter((plan) => !plan.isDefault)
                .map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name}
                  </option>
                ))}
            </select>
          ) : null}
          <Input
            type="date"
            aria-label="Date des statistiques"
            className="h-9 w-auto"
            value={date}
            onChange={(event) => setDate(event.target.value || today)}
          />
        </div>
      </div>
      {result && 'error' in result ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <p role="alert">{result.error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAttempt((count) => count + 1)}
          >
            Réessayer les statistiques
          </Button>
        </div>
      ) : data ? (
        <StatsPanel
          reservations={reservations}
          allTables={tables}
          tableStatuses={statuses}
          liveDate={date}
        />
      ) : (
        <p role="status" className="text-sm text-muted-foreground">
          Chargement des statistiques…
        </p>
      )}
    </section>
  );
}
