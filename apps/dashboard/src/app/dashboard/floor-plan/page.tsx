'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useApi } from '@/lib/api';
import { useSiteSelection } from '@/features/sites/site-context';
import { getErrorMessage, type FloorPlan, type FloorPlanSummary } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FloorPlanCanvas } from './_components/FloorPlanCanvas';
import { FloorPlanCrud } from './_components/FloorPlanCrud';
import { DataFetchError } from '@/components/DataFetchError';
import { Plus } from 'lucide-react';

function getDefaultFloorPlan(floorPlans: FloorPlanSummary[]): FloorPlanSummary | null {
  return (
    floorPlans.find((fp) => fp.isDefault && fp.isActive) ??
    floorPlans.find((fp) => fp.isActive) ??
    floorPlans[0] ??
    null
  );
}

export default function FloorPlanPage() {
  const { orgId, get, post } = useApi();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeView = searchParams.get('view') === 'edit-plan' ? 'edit-plan' : 'service-live';
  // Créer un plan est réservé aux responsables : l'équipe de service et la lecture seule voient une consigne.
  const { activeSite } = useSiteSelection();
  const canEditPlan =
    !activeSite?.role || activeSite.role === 'OWNER' || activeSite.role === 'MANAGER';
  const requestedFloorPlanId = searchParams.get('floorPlanId');
  const reportedReservationId = searchParams.get('reservationId');
  const reportedDelayReportId = searchParams.get('delayReportId');
  const reportedServiceDate = searchParams.get('serviceDate');
  const reportedDelayMinutes = Number(searchParams.get('delayMinutes'));
  const initialDelayImpact =
    reportedReservationId && Number.isInteger(reportedDelayMinutes) && reportedDelayMinutes >= 5
      ? {
          reservationId: reportedReservationId,
          delayMinutes: Math.min(reportedDelayMinutes, 180),
          delayReportId: reportedDelayReportId ?? undefined,
          serviceDate:
            reportedServiceDate && /^\d{4}-\d{2}-\d{2}$/.test(reportedServiceDate)
              ? reportedServiceDate
              : undefined,
        }
      : null;
  const [designTab, setDesignTab] = useState<'visual' | 'crud'>('visual');

  const [floorPlans, setFloorPlans] = useState<FloorPlanSummary[] | null>(null);
  const [selectedFloorPlanId, setSelectedFloorPlanId] = useState<string | null>(null);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createIsDefault, setCreateIsDefault] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  // Erreur de création : affichée dans la fenêtre elle-même, pas derrière son voile.
  const [createError, setCreateError] = useState('');

  const clearReportedDelay = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('reservationId');
    params.delete('delayMinutes');
    params.delete('delayReportId');
    params.delete('serviceDate');
    const query = params.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const loadFloorPlans = useCallback(async () => {
    if (!orgId) return;
    setListLoading(true);
    setListError('');
    try {
      const data = await get<FloorPlanSummary[]>(`restaurants/${orgId}/floor-plans`);
      setFloorPlans(data);
      const defaultPlan = getDefaultFloorPlan(data);
      let persistedFloorPlanId: string | null = null;
      try {
        persistedFloorPlanId = window.localStorage.getItem(`sokar.floor-plan.${orgId}`);
      } catch {
        // Local storage may be unavailable in a private browsing context.
      }
      setSelectedFloorPlanId((prev) => {
        const persistedPlan = data.find((plan) => plan.id === persistedFloorPlanId);
        return persistedPlan?.id ?? prev ?? defaultPlan?.id ?? null;
      });
    } catch (err) {
      setListError(getErrorMessage(err, 'Impossible de charger les plans de salle'));
    } finally {
      setListLoading(false);
    }
  }, [orgId, get]);

  useEffect(() => {
    if (!requestedFloorPlanId || !floorPlans) return;
    if (floorPlans.some((plan) => plan.id === requestedFloorPlanId)) {
      setSelectedFloorPlanId(requestedFloorPlanId);
    }
  }, [floorPlans, requestedFloorPlanId]);

  useEffect(() => {
    void loadFloorPlans();
  }, [loadFloorPlans]);

  async function handleCreateFloorPlan(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !createName.trim()) return;
    setCreateLoading(true);
    setCreateError('');
    try {
      const created = await post<FloorPlan>(`restaurants/${orgId}/floor-plans`, {
        name: createName.trim(),
        isDefault: createIsDefault,
      });
      await loadFloorPlans();
      setSelectedFloorPlanId(created.id);
      try {
        window.localStorage.setItem(`sokar.floor-plan.${orgId}`, created.id);
        window.dispatchEvent(new Event('suppernote:floor-plans-changed'));
      } catch {
        // Local storage may be unavailable in a private browsing context.
      }
      const params = new URLSearchParams(searchParams.toString());
      params.set('floorPlanId', created.id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      setCreateDialogOpen(false);
      setCreateName('');
      setCreateIsDefault(false);
    } catch (err) {
      setCreateError(getErrorMessage(err, 'Impossible de créer le plan de salle.'));
    } finally {
      setCreateLoading(false);
    }
  }

  function openFloorPlanEditor() {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'edit-plan');
    if (selectedFloorPlanId) params.set('floorPlanId', selectedFloorPlanId);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  if (!orgId) {
    return (
      <div className="space-y-6">
        <Card className="suppernote-card">
          <CardContent className="p-8 text-center text-muted-foreground">
            <Skeleton className="mx-auto h-8 w-48 rounded-full" />
            <p className="mt-4 text-sm">Chargement de l&apos;organisation...</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div
      className={
        activeView === 'edit-plan'
          ? 'space-y-3'
          : 'flex flex-1 flex-col min-h-0 space-y-2 sm:space-y-4 md:space-y-6'
      }
    >
      {listError && (
        <DataFetchError message={listError} onRetry={loadFloorPlans} retrying={listLoading} />
      )}

      {listLoading || (floorPlans === null && !listError) ? (
        <Skeleton className="h-10 w-64 rounded-lg" />
      ) : floorPlans === null ? null : floorPlans.length === 0 ? (
        listError ? null : (
          <div className="suppernote-empty">
            <p className="text-sm">Aucun plan de salle</p>
            <p className="text-xs opacity-60">
              Dessinez votre salle pour suivre le service en direct.
            </p>
            {canEditPlan ? (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreateDialogOpen(true)}
                className="mt-4 transition-all duration-200"
              >
                Créer votre premier plan
              </Button>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                Demandez à un responsable de créer le plan de salle.
              </p>
            )}
          </div>
        )
      ) : null}

      {activeView === 'edit-plan' && selectedFloorPlanId && (
        <div className="flex min-w-0 items-center gap-x-3">
          <div
            role="tablist"
            aria-label="Mode d’édition"
            className="flex min-w-0 shrink-0 items-center gap-0.5 rounded-md border border-border bg-card p-0.5"
          >
            <Button
              type="button"
              role="tab"
              variant={designTab === 'visual' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setDesignTab('visual')}
              aria-selected={designTab === 'visual'}
              className="h-7 px-2.5 text-xs"
            >
              Plan visuel
            </Button>
            <Button
              type="button"
              role="tab"
              variant={designTab === 'crud' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setDesignTab('crud')}
              aria-selected={designTab === 'crud'}
              className="h-7 px-2.5 text-xs"
            >
              Tables
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="create-floor-plan"
            onClick={() => setCreateDialogOpen(true)}
            title="Créer un plan de salle supplémentaire (ex. Terrasse, Étage) — le plan ouvert reste inchangé"
            className="ml-auto h-7 shrink-0 gap-1.5 whitespace-nowrap px-2 text-xs text-muted-foreground"
          >
            <Plus size={14} aria-hidden="true" />
            Nouveau plan
          </Button>
        </div>
      )}

      {selectedFloorPlanId && activeView === 'service-live' && (
        <FloorPlanCanvas
          key={`service-live-${selectedFloorPlanId}`}
          orgId={orgId}
          mode="service"
          floorPlanId={selectedFloorPlanId}
          initialDelayImpact={initialDelayImpact}
          onInitialDelayApplied={clearReportedDelay}
          onRequestEdit={openFloorPlanEditor}
        />
      )}
      {selectedFloorPlanId && activeView === 'edit-plan' && designTab === 'visual' && (
        <FloorPlanCanvas
          key={`design-visual-${selectedFloorPlanId}`}
          orgId={orgId}
          mode="design"
          floorPlanId={selectedFloorPlanId}
        />
      )}
      {selectedFloorPlanId && activeView === 'edit-plan' && designTab === 'crud' && (
        <FloorPlanCrud
          key={`design-crud-${selectedFloorPlanId}`}
          floorPlanId={selectedFloorPlanId}
        />
      )}

      {!selectedFloorPlanId &&
        !listLoading &&
        !listError &&
        floorPlans !== null &&
        floorPlans.length > 0 && (
          <div className="suppernote-empty">
            <p className="text-sm">Aucun plan de salle sélectionné.</p>
          </div>
        )}

      <Dialog
        open={createDialogOpen}
        onOpenChange={(open) => {
          setCreateDialogOpen(open);
          if (!open) setCreateError('');
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={handleCreateFloorPlan}>
            <DialogHeader>
              <DialogTitle>Créer un plan de salle</DialogTitle>
              <DialogDescription>
                Créez un plan de salle supplémentaire. Le plan ouvert reste inchangé. Vous pouvez le
                définir comme plan par défaut.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="floor-plan-name">Nom du plan</Label>
                <Input
                  id="floor-plan-name"
                  value={createName}
                  onChange={(e) => {
                    setCreateName(e.target.value);
                    setCreateError('');
                  }}
                  placeholder="Ex. : Terrasse"
                  disabled={createLoading}
                  className="bg-card border-border"
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Plan par défaut</p>
                  <p className="text-xs text-muted-foreground">
                    Ce plan sera celui utilisé par défaut pour le service.
                  </p>
                </div>
                <Switch
                  checked={createIsDefault}
                  onCheckedChange={setCreateIsDefault}
                  disabled={createLoading}
                  aria-label="Définir comme plan par défaut"
                />
              </div>
              {createError ? (
                <p role="alert" className="text-sm text-destructive">
                  {createError}
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setCreateDialogOpen(false);
                  setCreateError('');
                }}
                disabled={createLoading}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={!createName.trim() || createLoading}>
                Créer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
