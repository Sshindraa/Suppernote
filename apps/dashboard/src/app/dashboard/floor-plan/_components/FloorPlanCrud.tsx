'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { useIsMobile } from '@/lib/useMediaQuery';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertCircle, LayoutGrid, Plus, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataFetchError } from '@/components/DataFetchError';

type Section = {
  id: string;
  name: string;
  position: number;
  tables: Table[];
};

type Table = {
  id: string;
  name: string;
  capacity: number;
  minCapacity: number;
  isActive: boolean;
  positionX: number | null;
  positionY: number | null;
  shape: string | null;
};

type FloorPlan = {
  id: string;
  name: string | null;
  sections: Section[];
  /** Toutes les tables du plan, y compris celles dessinées dans « Plan visuel » sans section. */
  tables?: Table[];
};

/** Met à jour une table où qu'elle soit : dans une section, ou dans la liste « sans section ». */
function mapTables(plan: FloorPlan, update: (table: Table) => Table): FloorPlan {
  return {
    ...plan,
    sections: plan.sections.map((section) => ({ ...section, tables: section.tables.map(update) })),
    ...(plan.tables ? { tables: plan.tables.map(update) } : {}),
  };
}

function removeTable(plan: FloorPlan, tableId: string): FloorPlan {
  return {
    ...plan,
    sections: plan.sections.map((section) => ({
      ...section,
      tables: section.tables.filter((table) => table.id !== tableId),
    })),
    ...(plan.tables ? { tables: plan.tables.filter((table) => table.id !== tableId) } : {}),
  };
}

function TableLine({
  table,
  onToggle,
  onDelete,
}: {
  table: Table;
  onToggle: (checked: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between rounded-lg border p-3 transition-all duration-200',
        table.isActive ? 'border-border bg-card' : 'border-border bg-muted opacity-60',
      )}
    >
      <div>
        <p className="font-medium">{table.name}</p>
        <p className="text-xs text-muted-foreground">
          {table.capacity} couvert{table.capacity > 1 ? 's' : ''}
          {table.minCapacity > 1 && ` (min. ${table.minCapacity})`}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={table.isActive}
          onCheckedChange={onToggle}
          aria-label={`Activer ${table.name}`}
        />
        <button
          onClick={onDelete}
          className="p-2 text-muted-foreground hover:text-destructive rounded-lg hover:bg-accent transition-all duration-200"
          title="Supprimer la table"
          aria-label={`Supprimer la table ${table.name}`}
        >
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

export function FloorPlanCrud({ floorPlanId }: { floorPlanId?: string }) {
  const { get, patch, post, del, orgId } = useApi();
  const isMobile = useIsMobile();

  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [newTable, setNewTable] = useState({ name: '', capacity: '' });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingDeleteTableId, setPendingDeleteTableId] = useState<string | null>(null);
  const fetchFloorPlan = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const path = floorPlanId
        ? `restaurants/${orgId}/floor-plans/${floorPlanId}`
        : `restaurants/${orgId}/floor-plan`;
      const data = await get<FloorPlan>(path);
      setFloorPlan(data);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de charger le plan de salle.'));
    } finally {
      setLoading(false);
    }
  }, [orgId, get, floorPlanId]);

  useEffect(() => {
    void fetchFloorPlan();
  }, [fetchFloorPlan]);

  async function toggleTable(tableId: string, isActive: boolean) {
    if (!orgId) return;
    const previousIsActive =
      [
        ...(floorPlan?.sections.flatMap((section) => section.tables) ?? []),
        ...(floorPlan?.tables ?? []),
      ].find((table) => table.id === tableId)?.isActive ?? !isActive;
    try {
      setError('');
      setFloorPlan((prev) =>
        prev
          ? mapTables(prev, (table) => (table.id === tableId ? { ...table, isActive } : table))
          : prev,
      );
      await patch(`restaurants/${orgId}/floor-plan/tables/${tableId}`, {
        isActive,
        ...(floorPlanId ? { floorPlanId } : {}),
      });
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de modifier la table'));
      setFloorPlan((prev) =>
        prev
          ? mapTables(prev, (table) =>
              table.id === tableId ? { ...table, isActive: previousIsActive } : table,
            )
          : prev,
      );
    }
  }

  async function createTable(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !newTable.name.trim() || !newTable.capacity) return;
    try {
      setError('');
      const table = await post<Table>(`restaurants/${orgId}/floor-plan/tables`, {
        name: newTable.name.trim(),
        capacity: Number(newTable.capacity),
        ...(floorPlanId ? { floorPlanId } : {}),
      });
      setFloorPlan((prev) => (prev ? { ...prev, tables: [...(prev.tables ?? []), table] } : prev));
      setNewTable({ name: '', capacity: '' });
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de créer la table'));
    }
  }

  async function deleteTable(tableId: string) {
    if (!orgId) return;
    setPendingDeleteTableId(tableId);
    setConfirmOpen(true);
  }

  async function confirmDeleteTable() {
    const tableId = pendingDeleteTableId;
    if (!orgId || !tableId) return;
    setConfirmOpen(false);
    setPendingDeleteTableId(null);
    try {
      setError('');
      await del(
        `restaurants/${orgId}/floor-plan/tables/${tableId}${
          floorPlanId ? `?floorPlanId=${floorPlanId}` : ''
        }`,
      );
      setFloorPlan((prev) => (prev ? removeTable(prev, tableId) : prev));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de supprimer la table'));
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-40 rounded-full" />
          <Skeleton className="h-10 w-32 rounded-lg" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-48 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (!floorPlan) {
    return (
      <DataFetchError
        message={error || 'Impossible de charger le plan de salle.'}
        onRetry={() => void fetchFloorPlan()}
        retrying={loading}
      />
    );
  }

  const tables = [
    ...new Map(
      [...floorPlan.sections.flatMap((section) => section.tables), ...(floorPlan.tables ?? [])].map(
        (table) => [table.id, table],
      ),
    ).values(),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <LayoutGrid className="h-6 w-6 text-primary" />
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Plan de salle</h1>
        </div>
        <form onSubmit={createTable} className="flex flex-wrap items-end gap-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-table-name">Nom de la table</Label>
            <Input
              id="new-table-name"
              value={newTable.name}
              onChange={(event) => setNewTable({ ...newTable, name: event.target.value })}
            />
          </div>
          <div className="w-24 space-y-1.5">
            <Label htmlFor="new-table-capacity">Couverts</Label>
            <Input
              id="new-table-capacity"
              type="number"
              min={1}
              required
              value={newTable.capacity}
              onChange={(event) => setNewTable({ ...newTable, capacity: event.target.value })}
            />
          </div>
          <Button type="submit" size="sm" disabled={!newTable.name.trim() || !newTable.capacity}>
            <Plus size={16} /> Ajouter une table
          </Button>
        </form>
      </div>

      {error ? (
        <div className="sokar-error">
          <AlertCircle size={18} />
          {error}
        </div>
      ) : null}

      <Card className="sokar-card">
        <CardHeader>
          <h2 className="text-base font-semibold">Tables du plan</h2>
        </CardHeader>
        <CardContent className="space-y-2">
          {tables.length === 0 ? (
            <p className="text-sm text-muted-foreground">Aucune table dans ce plan.</p>
          ) : (
            tables.map((table) => (
              <TableLine
                key={table.id}
                table={table}
                onToggle={(checked) => toggleTable(table.id, checked)}
                onDelete={() => deleteTable(table.id)}
              />
            ))
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={confirmDeleteTable}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingDeleteTableId(null);
        }}
        title="Supprimer la table"
        description="Êtes-vous sûr de vouloir supprimer cette table ? Cette action est irréversible."
        confirmLabel="Supprimer"
        variant="destructive"
      />
    </div>
  );
}
