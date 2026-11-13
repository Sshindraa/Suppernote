'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import {
  Search,
  MapPin,
  Clock,
  Users,
  CheckCircle2,
  XCircle,
  AlertCircle,
  ChevronDown,
  Loader2,
} from 'lucide-react';
import { useApi } from '@/lib/api';
import {
  getErrorMessage,
  type FloorPlan,
  type SimulationResult,
  type SimulationScenario,
} from '@/types/api';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

interface ServiceCopilotSimulatorProps {
  orgId: string;
  selectedFloorPlanId?: string;
}

function getStartsAt(minutesAhead: number): string {
  const now = new Date();
  const d = new Date(now.getTime() + minutesAhead * 60 * 1000);
  const rounded = Math.ceil(d.getMinutes() / 30) * 30;
  d.setMinutes(rounded, 0, 0);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function getDefaultStartsAt(): string {
  return getStartsAt(30);
}

function formatIso(iso: string): string {
  return format(parseISO(iso), 'dd MMM HH:mm', { locale: fr });
}

function ScenarioCard({ scenario, isBest }: { scenario: SimulationScenario; isBest: boolean }) {
  const isFeasible = scenario.feasible;
  const Icon = isFeasible ? CheckCircle2 : scenario.type === 'refuse' ? AlertCircle : XCircle;
  const iconColor = isFeasible
    ? 'text-success'
    : scenario.type === 'refuse'
      ? 'text-warning'
      : 'text-muted-foreground';

  return (
    <Card
      className={cn(
        'transition-all duration-200',
        isBest ? 'border-primary ring-1 ring-primary' : 'border-border',
      )}
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Icon size={20} className={cn('mt-0.5 shrink-0', iconColor)} />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <h3 className="font-semibold leading-tight text-foreground">{scenario.title}</h3>
              {isBest ? (
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                  Recommandé
                </span>
              ) : null}
            </div>
            <p className="text-sm text-muted-foreground">{scenario.reason}</p>
          </div>
        </div>

        {scenario.table && (
          <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
            <MapPin size={14} className="text-muted-foreground" />
            <span className="font-medium">{scenario.table.name}</span>
            <span className="text-muted-foreground">({scenario.table.capacity} couverts)</span>
            {scenario.table.sectionName && (
              <span className="text-muted-foreground">— {scenario.table.sectionName}</span>
            )}
          </div>
        )}

        {scenario.nextAvailableAt && (
          <div className="flex items-center gap-2 text-sm text-foreground">
            <Clock size={14} className="text-muted-foreground" />
            <span>Prochain créneau : {formatIso(scenario.nextAvailableAt)}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {scenario.metrics.estimatedWaitMinutes !== null ? (
            <span className="inline-flex items-center gap-1.5">
              <Clock size={13} aria-hidden="true" />
              {scenario.metrics.estimatedWaitMinutes === 0
                ? 'Sans attente'
                : `${scenario.metrics.estimatedWaitMinutes} min d’attente`}
            </span>
          ) : null}
          {scenario.metrics.coversGained > 0 ? (
            <span className="inline-flex items-center gap-1.5">
              <Users size={13} aria-hidden="true" />
              {scenario.metrics.coversGained} couvert
              {scenario.metrics.coversGained > 1 ? 's' : ''}
            </span>
          ) : null}
          {scenario.metrics.conflictsCreated > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-warning">
              <AlertCircle size={13} aria-hidden="true" />
              {scenario.metrics.conflictsCreated} conflit
              {scenario.metrics.conflictsCreated > 1 ? 's' : ''}
            </span>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2 pt-1">
          {scenario.actions
            // La page Réservations n'a pas de formulaire de création qui lise ces paramètres : le lien
            // « Créer la réservation » mènerait à une simple liste. Il reste masqué tant que ce n'est pas branché.
            .filter(
              (action) =>
                !(action.type === 'link' && action.href?.startsWith('/dashboard/reservations?')),
            )
            .map((action, idx) =>
              action.type === 'link' && action.href ? (
                <Link
                  key={idx}
                  href={action.href}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground transition-all duration-200 hover:bg-accent"
                >
                  {action.label}
                </Link>
              ) : action.type === 'api' ? (
                <Button
                  key={idx}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    // Les actions API sont volontairement non exécutées ici ;
                    // la simulation reste une prévisualisation read-only.
                  }}
                >
                  {action.label}
                </Button>
              ) : null,
            )}
        </div>
      </CardContent>
    </Card>
  );
}

function ServiceCopilotSimulatorContent({
  orgId,
  selectedFloorPlanId,
}: ServiceCopilotSimulatorProps) {
  const { get, post } = useApi();
  const [partySize, setPartySize] = useState<number>(2);
  const [startsAt, setStartsAt] = useState<string>(getDefaultStartsAt());
  const [endsAt, setEndsAt] = useState<string>('');
  const [preferredSectionId, setPreferredSectionId] = useState<string>('');
  const [showEndTime, setShowEndTime] = useState(false);

  const [sections, setSections] = useState<FloorPlan['sections']>([]);
  const [sectionsLoading, setSectionsLoading] = useState(false);

  const [result, setResult] = useState<SimulationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    if (!orgId || !selectedFloorPlanId) {
      setSections([]);
      setPreferredSectionId('');
      return;
    }

    let mounted = true;
    async function loadSections() {
      setSectionsLoading(true);
      try {
        const data = await get<FloorPlan>(
          `restaurants/${orgId}/floor-plans/${selectedFloorPlanId}`,
        );
        if (mounted) {
          setSections(data.sections ?? []);
        }
      } catch {
        if (mounted) setSections([]);
      } finally {
        if (mounted) setSectionsLoading(false);
      }
    }
    void loadSections();
    return () => {
      mounted = false;
    };
  }, [orgId, selectedFloorPlanId, get]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId) return;

    setLoading(true);
    setError('');
    try {
      const body = {
        partySize: Number(partySize),
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
        preferredSectionId: preferredSectionId || undefined,
      };
      const data = await post<SimulationResult>(
        `restaurants/${orgId}/service-copilot/simulate`,
        body,
      );
      setResult(data);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de simuler ce scénario'));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sim-party-size" className="flex items-center gap-1.5">
              <Users size={14} />
              Couverts
            </Label>
            <Input
              id="sim-party-size"
              type="number"
              min={1}
              max={99}
              value={partySize}
              onChange={(e) => setPartySize(Number(e.target.value))}
              className="bg-card"
              inputMode="numeric"
              disabled={loading}
              required
            />
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Raccourcis de groupe"
            >
              <span className="mr-1 text-[11px] text-muted-foreground">Raccourci</span>
              {[2, 4, 6, 8].map((size) => (
                <button
                  key={size}
                  type="button"
                  disabled={loading}
                  onClick={() => setPartySize(size)}
                  className={cn(
                    'min-w-8 rounded-full border px-2 py-1 text-xs font-medium transition-all duration-200',
                    partySize === size
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                  aria-pressed={partySize === size}
                  aria-label={`${size} couvert${size > 1 ? 's' : ''}`}
                >
                  {size}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sim-starts-at" className="flex items-center gap-1.5">
              <Clock size={14} />
              Arrivée
            </Label>
            <Input
              id="sim-starts-at"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="bg-card"
              disabled={loading}
              required
            />
            <div
              className="flex flex-wrap items-center gap-1.5"
              role="group"
              aria-label="Raccourcis d’arrivée"
            >
              <span className="mr-1 text-[11px] text-muted-foreground">Dans</span>
              {[30, 60, 120].map((minutes) => (
                <button
                  key={minutes}
                  type="button"
                  disabled={loading}
                  onClick={() => setStartsAt(getStartsAt(minutes))}
                  className="rounded-full border border-border px-2 py-1 text-xs font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground"
                >
                  {minutes < 60 ? `${minutes} min` : `${minutes / 60} h`}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sim-section" className="flex items-center gap-1.5">
              <MapPin size={14} />
              Zone souhaitée
            </Label>
            {sectionsLoading ? (
              <Skeleton className="h-10 w-full rounded-md" />
            ) : (
              <Select
                value={preferredSectionId || '__all__'}
                onValueChange={(value) => setPreferredSectionId(value === '__all__' ? '' : value)}
              >
                <SelectTrigger id="sim-section" className="bg-card">
                  <SelectValue placeholder="Toutes les zones" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">Toutes les zones</SelectItem>
                  {sections.map((section) => (
                    <SelectItem key={section.id} value={section.id}>
                      {section.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <button
            type="button"
            aria-expanded={showEndTime}
            aria-controls="sim-end-time"
            onClick={() => setShowEndTime((visible) => !visible)}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-all duration-200 hover:text-foreground"
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              className={cn('transition-transform duration-200', showEndTime && 'rotate-180')}
            />
            {showEndTime ? 'Masquer la fin prévue' : 'Ajouter une fin prévue'}
          </button>
          {showEndTime ? (
            <div id="sim-end-time" className="max-w-sm space-y-2">
              <Label htmlFor="sim-ends-at" className="flex items-center gap-1.5">
                <Clock size={14} />
                Fin prévue
              </Label>
              <Input
                id="sim-ends-at"
                type="datetime-local"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                placeholder="Durée par défaut du restaurant"
                className="bg-card"
                disabled={loading}
              />
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Button type="submit" disabled={loading} className="w-full sm:w-auto">
            {loading ? (
              <>
                <Loader2 size={16} className="animate-spin" aria-hidden="true" />
                Analyse…
              </>
            ) : (
              'Trouver une table'
            )}
          </Button>
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              Lecture seule · aucune réservation n’est créée.
            </p>
          )}
        </div>
      </form>

      {result ? (
        <div className="space-y-4" role="status" aria-live="polite">
          <div
            className={cn(
              'rounded-xl border p-4 transition-all duration-200',
              result.feasible
                ? 'border-success/20 bg-success/[0.04]'
                : 'border-warning/20 bg-warning/[0.04]',
            )}
          >
            <div className="flex items-start gap-3">
              {result.feasible ? (
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-success" />
              ) : (
                <AlertCircle size={20} className="mt-0.5 shrink-0 text-warning" />
              )}
              <p className="text-sm font-medium leading-relaxed text-foreground">
                {result.explanation}
              </p>
            </div>
          </div>

          {result.scenarios.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Options de placement
              </p>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {result.scenarios.map((scenario) => (
                  <ScenarioCard
                    key={scenario.id}
                    scenario={scenario}
                    isBest={scenario.id === result.bestScenarioId}
                  />
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Aucun scénario retourné.</p>
          )}
        </div>
      ) : (
        <div className="suppernote-empty min-h-0 p-3 sm:p-4">
          <p className="text-sm text-muted-foreground">
            Renseignez les couverts et l&apos;heure d&apos;arrivée pour voir les tables
            recommandées.
          </p>
        </div>
      )}
    </div>
  );
}

export function ServiceCopilotSimulator(props: ServiceCopilotSimulatorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Simuler un placement"
        className="h-8 shrink-0 gap-1.5 px-2 text-muted-foreground transition-all duration-200 hover:text-foreground"
        onClick={() => setDialogOpen(true)}
      >
        <Search size={14} aria-hidden="true" />
        Simuler
      </Button>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Simuler un placement</DialogTitle>
            <DialogDescription>
              Prévisualisez les tables pour un groupe sans réservation. Aucun client n’est placé.
            </DialogDescription>
          </DialogHeader>
          <ServiceCopilotSimulatorContent {...props} />
        </DialogContent>
      </Dialog>
    </>
  );
}
