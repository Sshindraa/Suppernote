'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import {
  getErrorMessage,
  type Restaurant,
  type FloorPlan,
  type FloorPlanTable,
  type PlanningReservation,
} from '@/types/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { normalizeOpeningHours } from '@suppernote/shared';
import { format, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { AlertCircle, Calendar, Clock, Users, UtensilsCrossed } from 'lucide-react';
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  useDraggable,
  useDroppable,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';

const DEFAULT_OPEN = '10:00';
const DEFAULT_CLOSE = '23:00';
const SLOT_HEIGHT = 64;

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const [h, m] = value.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
}

function minutesFromDate(iso: string): number {
  const d = parseISO(iso);
  return d.getHours() * 60 + d.getMinutes();
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function stateBadgeVariant(state: string) {
  switch (state) {
    case 'PENDING':
      return 'secondary';
    case 'CONFIRMED':
      return 'default';
    case 'SEATED':
      return 'outline';
    case 'CANCELLED':
    case 'NO_SHOW':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function stateLabel(state: string): string {
  switch (state) {
    case 'PENDING':
      return 'En attente';
    case 'CONFIRMED':
      return 'Confirmé';
    case 'SEATED':
      return 'Installé';
    case 'CANCELLED':
      return 'Annulé';
    case 'NO_SHOW':
      return 'No-show';
    default:
      return state;
  }
}

function formatSlotLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

type ReservationCardProps = {
  reservation: PlanningReservation;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  dragRef?: React.Ref<HTMLDivElement>;
  dragProps?: React.HTMLAttributes<HTMLDivElement>;
};

function ReservationCard({
  reservation,
  className,
  style,
  onClick,
  dragRef,
  dragProps,
}: ReservationCardProps) {
  return (
    <div
      ref={dragRef}
      className={cn(
        'rounded-md border border-border p-2 text-left transition-all duration-200 hover:ring-2 hover:ring-ring hover:ring-offset-1',
        reservation.state === 'CANCELLED' || reservation.state === 'NO_SHOW'
          ? 'bg-muted opacity-60'
          : 'bg-primary/10 hover:bg-primary/20',
        className,
      )}
      style={style}
      onClick={onClick}
      {...dragProps}
    >
      <p className="truncate text-xs font-medium text-foreground">
        {reservation.customerName || 'Sans nom'}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <Users size={12} className="text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{reservation.partySize}</span>
        <Badge variant={stateBadgeVariant(reservation.state)} className="text-[10px] px-1.5 py-0">
          {stateLabel(reservation.state)}
        </Badge>
      </div>
    </div>
  );
}

type DraggableReservationProps = {
  reservation: PlanningReservation;
  top: number;
  height: number;
  onClick: () => void;
};

function DraggableReservation({ reservation, top, height, onClick }: DraggableReservationProps) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: reservation.id,
    data: { reservation },
  });

  const style: React.CSSProperties = {
    top: `${top}px`,
    height: `${height}px`,
    transform: transform ? CSS.Transform.toString(transform) : undefined,
  };

  return (
    <ReservationCard
      reservation={reservation}
      className={cn('absolute left-1 right-1', isDragging && 'opacity-30')}
      style={style}
      onClick={onClick}
      dragRef={setNodeRef}
      dragProps={{ ...attributes, ...listeners }}
    />
  );
}

type DroppableTableColumnProps = {
  table: FloorPlanTable;
  slotCount: number;
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

function DroppableTableColumn({
  table,
  slotCount,
  className,
  style,
  children,
}: DroppableTableColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: table.id,
    data: { table },
    disabled: !table.isActive,
  });

  return (
    <div
      ref={setNodeRef}
      data-table-id={table.id}
      className={cn(
        'relative border-b border-r border-border transition-all duration-200',
        table.isActive ? 'bg-card/50' : 'bg-muted/50',
        isOver && 'bg-primary/10 border-primary',
        className,
      )}
      style={{ ...style, gridRow: `3 / span ${slotCount}` }}
    >
      {children}
    </div>
  );
}

type PlanningTabProps = {
  orgId: string;
};

export function PlanningTab({ orgId }: PlanningTabProps) {
  const { get, patch } = useApi();

  const [date, setDate] = useState<string>(format(new Date(), 'yyyy-MM-dd'));
  const [restaurant, setRestaurant] = useState<Restaurant | null>(null);
  const [floorPlan, setFloorPlan] = useState<FloorPlan | null>(null);
  const [reservations, setReservations] = useState<PlanningReservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const justDraggedRef = useRef(false);

  const [selected, setSelected] = useState<PlanningReservation | null>(null);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [patching, setPatching] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const loadData = useCallback(
    async (showLoading = false) => {
      setError('');
      if (showLoading) setLoading(true);

      try {
        const [r, fp, res] = await Promise.all([
          get<Restaurant>(`restaurants/${orgId}`),
          get<FloorPlan>(`restaurants/${orgId}/floor-plan`),
          get<PlanningReservation[]>(`restaurants/${orgId}/floor-plan/reservations?date=${date}`),
        ]);
        setRestaurant(r);
        setFloorPlan(fp);
        setReservations(res);
      } catch (err) {
        setError(getErrorMessage(err, 'Impossible de charger le planning'));
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [orgId, date, get],
  );

  useEffect(() => {
    if (!orgId) return;
    setLoading(true);
    loadData(true);

    // Un onglet caché ne relit pas : le planning se recharge au retour au premier plan.
    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (!interval) interval = setInterval(() => loadData(false), 30_000);
    };
    const stopPolling = () => {
      if (interval) clearInterval(interval);
      interval = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        loadData(false);
        startPolling();
      }
    };

    if (!document.hidden) startPolling();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [orgId, date, loadData]);

  const {
    sectionsForGrid,
    allTables,
    activeCapacity,
    covers,
    occupancyRate,
    unassignedCount,
    openMinutes,
    closeMinutes,
    slotCount,
    timeSlots,
    reservationsByTableId,
    reservationById,
  } = useMemo(() => {
    const sections =
      floorPlan?.sections && floorPlan.sections.some((s) => s.tables.length > 0)
        ? floorPlan.sections
        : floorPlan?.tables
          ? [{ id: 'default', name: '', position: 0, tables: floorPlan.tables }]
          : [];

    const tables = sections.flatMap((s) => s.tables);

    const dayIndex = parseISO(date).getDay();
    const servicePeriods = normalizeOpeningHours(restaurant?.openingHours).filter(
      (period) => period.dayIndex === dayIndex,
    );
    let open =
      servicePeriods.reduce<number | null>((earliest, period) => {
        const time = parseTime(period.open);
        return time == null ? earliest : earliest == null ? time : Math.min(earliest, time);
      }, null) ??
      parseTime(DEFAULT_OPEN) ??
      600;
    let close =
      servicePeriods.reduce<number | null>((latest, period) => {
        const time = parseTime(period.close);
        return time == null ? latest : latest == null ? time : Math.max(latest, time);
      }, null) ??
      parseTime(DEFAULT_CLOSE) ??
      1380;
    if (close <= open) close += 24 * 60;

    const count = Math.max(0, Math.floor((close - open) / 30));
    const slots = Array.from({ length: count }, (_, i) => {
      const minutes = open + i * 30;
      const isOpen = servicePeriods.length
        ? servicePeriods.some((period) => {
            const start = parseTime(period.open);
            let end = parseTime(period.close);
            if (start == null || end == null) return false;
            if (end <= start) end += 24 * 60;
            return minutes >= start && minutes < end;
          })
        : true;
      return { minutes, label: formatSlotLabel(minutes), isOpen };
    });

    const activeCap = tables.filter((t) => t.isActive).reduce((sum, t) => sum + t.capacity, 0);
    const cov = reservations.reduce((sum, r) => sum + r.partySize, 0);
    const rate = activeCap > 0 ? (cov / activeCap) * 100 : 0;
    const unassigned = reservations.filter((r) => !r.tableId).length;

    const byTable = new Map<string, PlanningReservation[]>();
    const byId = new Map<string, PlanningReservation>();
    for (const r of reservations) {
      byId.set(r.id, r);
      if (r.tableId) {
        const list = byTable.get(r.tableId) ?? [];
        list.push(r);
        byTable.set(r.tableId, list);
      }
    }

    return {
      sectionsForGrid: sections,
      allTables: tables,
      activeCapacity: activeCap,
      covers: cov,
      occupancyRate: rate,
      unassignedCount: unassigned,
      openMinutes: open,
      closeMinutes: close,
      slotCount: count,
      timeSlots: slots,
      reservationsByTableId: byTable,
      reservationById: byId,
    };
  }, [floorPlan, reservations, restaurant, date]);

  const activeReservation = activeDragId ? (reservationById.get(activeDragId) ?? null) : null;

  async function handleReassign() {
    if (!selected || !selectedTableId) return;
    setDialogError('');
    setPatching(true);

    try {
      await patch(`restaurants/${orgId}/floor-plan/reservations/${selected.id}`, {
        tableId: selectedTableId,
      });
      await loadData(false);
      setSelected(null);
      setSelectedTableId(null);
    } catch (err) {
      setDialogError(getErrorMessage(err, 'Impossible de réassigner la réservation'));
    } finally {
      setPatching(false);
    }
  }

  function openDialog(reservation: PlanningReservation) {
    setSelected(reservation);
    setSelectedTableId(reservation.tableId);
    setDialogError('');
  }

  function handleDragStart(event: DragStartEvent) {
    justDraggedRef.current = true;
    setActiveDragId(event.active.id as string);
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setActiveDragId(null);
    setTimeout(() => {
      justDraggedRef.current = false;
    }, 0);

    if (!over) return;

    const activeReservation = (
      active.data.current as { reservation?: PlanningReservation } | undefined
    )?.reservation;
    const targetTable = (over.data.current as { table?: FloorPlanTable } | undefined)?.table;

    if (!activeReservation || !targetTable) return;
    if (targetTable.id === activeReservation.tableId) return;

    try {
      await patch(`restaurants/${orgId}/floor-plan/reservations/${activeReservation.id}`, {
        tableId: targetTable.id,
      });
      await loadData(false);
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de réassigner la réservation'));
    }
  }

  if (loading && !floorPlan) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-28 w-full rounded-2xl" />
          ))}
        </div>
        <Skeleton className="h-10 w-full max-w-xs rounded-lg" />
        <Skeleton className="h-[600px] w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error ? (
        <div className="suppernote-error">
          <AlertCircle size={18} />
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-4">
        <Card className="suppernote-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Taux d&apos;occupation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold">{formatPercent(occupancyRate)}</span>
              <span className="text-sm text-muted-foreground">
                {covers} / {activeCapacity} couverts
              </span>
            </div>
          </CardContent>
        </Card>

        <Card className="suppernote-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Réservations
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{reservations.length}</div>
            <p className="text-sm text-muted-foreground">{unassignedCount} sans table</p>
          </CardContent>
        </Card>

        <Card className="suppernote-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tables</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-semibold">{allTables.length}</div>
            <p className="text-sm text-muted-foreground">
              {allTables.filter((t) => t.isActive).length} actives
            </p>
          </CardContent>
        </Card>

        <Card className="suppernote-card">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Date</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <Calendar size={18} className="text-muted-foreground" />
              <span className="text-lg font-medium">
                {format(parseISO(date), 'EEEE d MMMM', { locale: fr })}
              </span>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Label htmlFor="planning-date" className="text-sm text-muted-foreground">
            <Clock size={16} className="inline mr-1" />
            Jour
          </Label>
          <Input
            id="planning-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-44 bg-card border-border"
          />
        </div>
      </div>

      {allTables.length === 0 ? (
        <div className="suppernote-empty">
          <UtensilsCrossed size={40} className="opacity-30" />
          <p className="text-sm">Aucune table dans votre plan de salle</p>
          <p className="text-xs opacity-60">Créez des tables pour visualiser le planning.</p>
        </div>
      ) : (
        <Card className="suppernote-card overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-medium">
              Planning {format(parseISO(date), 'dd/MM/yyyy')}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-auto">
            <DndContext
              sensors={sensors}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              onDragCancel={handleDragCancel}
            >
              <div
                className="grid min-w-[800px]"
                style={{
                  gridTemplateColumns: `64px repeat(${allTables.length}, minmax(140px, 1fr))`,
                  gridTemplateRows: `auto auto repeat(${slotCount}, ${SLOT_HEIGHT}px)`,
                }}
              >
                {/* Section headers */}
                <div
                  className="sticky top-0 z-10 bg-background border-b border-border"
                  style={{ gridColumn: 1, gridRow: 1 }}
                />
                {sectionsForGrid.map((section, sectionIndex) => {
                  const start = sectionsForGrid
                    .slice(0, sectionIndex)
                    .reduce((acc, s) => acc + s.tables.length, 0);
                  if (section.tables.length === 0) return null;
                  return (
                    <div
                      key={section.id}
                      className="sticky top-0 z-10 bg-background border-b border-border p-2 text-center text-sm font-medium text-muted-foreground"
                      style={{
                        gridColumn: `${2 + start} / span ${section.tables.length}`,
                        gridRow: 1,
                      }}
                    >
                      {section.name}
                    </div>
                  );
                })}

                {/* Table headers */}
                <div
                  className="sticky top-0 z-10 bg-background border-b border-border"
                  style={{ gridColumn: 1, gridRow: 2 }}
                />
                {allTables.map((table, index) => (
                  <div
                    key={table.id}
                    data-table-id={table.id}
                    className="sticky top-0 z-10 bg-background border-b border-border p-2 text-center"
                    style={{ gridColumn: index + 2, gridRow: 2 }}
                  >
                    <p className="text-sm font-medium">{table.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {table.capacity} couverts{table.capacity > 1 ? 's' : ''}
                      {table.minCapacity > 1 && ` (min. ${table.minCapacity})`}
                    </p>
                  </div>
                ))}

                {/* Time slots */}
                {timeSlots.map((slot, index) => (
                  <div
                    key={slot.label}
                    title={slot.isOpen ? undefined : 'Restaurant fermé'}
                    className={cn(
                      'border-b border-border p-2 text-xs text-right',
                      slot.isOpen
                        ? 'text-muted-foreground'
                        : 'bg-muted/40 text-muted-foreground/70',
                    )}
                    style={{ gridColumn: 1, gridRow: index + 3 }}
                  >
                    {slot.label}
                  </div>
                ))}

                {/* Table columns */}
                {allTables.map((table, tableIndex) => {
                  const tableReservations = reservationsByTableId.get(table.id) ?? [];
                  return (
                    <DroppableTableColumn
                      key={table.id}
                      table={table}
                      slotCount={slotCount}
                      className={cn(table.isActive ? 'bg-card/50' : 'bg-muted/50')}
                      style={{ gridColumn: tableIndex + 2 }}
                    >
                      {timeSlots.map((_, slotIndex) => (
                        <div
                          key={slotIndex}
                          className={cn(
                            'absolute left-0 right-0 border-b border-border/50',
                            !timeSlots[slotIndex]?.isOpen && 'bg-muted/30',
                          )}
                          style={{
                            top: `${slotIndex * SLOT_HEIGHT}px`,
                            height: `${SLOT_HEIGHT}px`,
                          }}
                        />
                      ))}
                      {tableReservations.map((reservation) => {
                        const start = minutesFromDate(reservation.startsAt);
                        const end = minutesFromDate(reservation.endsAt);
                        const clampedStart = Math.max(start, openMinutes);
                        const clampedEnd = Math.min(end, closeMinutes);
                        const top = (clampedStart - openMinutes) * (SLOT_HEIGHT / 30);
                        const height = Math.max(
                          (clampedEnd - clampedStart) * (SLOT_HEIGHT / 30),
                          24,
                        );

                        return (
                          <DraggableReservation
                            key={reservation.id}
                            reservation={reservation}
                            top={top}
                            height={height}
                            onClick={() => {
                              if (justDraggedRef.current) {
                                justDraggedRef.current = false;
                                return;
                              }
                              openDialog(reservation);
                            }}
                          />
                        );
                      })}
                    </DroppableTableColumn>
                  );
                })}
              </div>

              <DragOverlay>
                {activeReservation ? (
                  <ReservationCard
                    reservation={activeReservation}
                    className="w-48 h-20 opacity-90 shadow-lg"
                    onClick={() => {}}
                  />
                ) : null}
              </DragOverlay>
            </DndContext>
          </CardContent>
        </Card>
      )}

      <Dialog
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setSelectedTableId(null);
            setDialogError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Réassigner la réservation</DialogTitle>
            <DialogDescription>
              {selected?.customerName || 'Sans nom'} — {selected?.partySize} couverts
            </DialogDescription>
          </DialogHeader>

          {dialogError ? (
            <div className="suppernote-error text-sm">
              <AlertCircle size={16} />
              {dialogError}
            </div>
          ) : null}

          <div className="space-y-3 py-2">
            <Label htmlFor="table-select" className="text-sm text-muted-foreground">
              Nouvelle table
            </Label>
            <Select
              value={selectedTableId ?? ''}
              onValueChange={(value) => setSelectedTableId(value)}
            >
              <SelectTrigger id="table-select" className="bg-card border-border">
                <SelectValue placeholder="Choisir une table" />
              </SelectTrigger>
              <SelectContent>
                {allTables.map((table) => {
                  const section = sectionsForGrid.find((s) =>
                    s.tables.some((t) => t.id === table.id),
                  );
                  const label = section?.name ? `${section.name} — ${table.name}` : table.name;
                  return (
                    <SelectItem key={table.id} value={table.id} disabled={!table.isActive}>
                      {label} ({table.capacity} couverts)
                      {!table.isActive && ' — inactive'}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setSelected(null);
                setSelectedTableId(null);
                setDialogError('');
              }}
            >
              Annuler
            </Button>
            <Button
              onClick={handleReassign}
              disabled={patching || !selectedTableId || selectedTableId === selected?.tableId}
            >
              {patching ? 'Enregistrement...' : 'Réassigner'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
