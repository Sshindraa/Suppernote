'use client';

import Link from 'next/link';
import { StatusBadge as StatusPill } from '@/components/StatusBadge';
import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react';
import { toast } from 'sonner';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { normalizePhone } from '@suppernote/shared';
import { addDays, format, isSameDay, parseISO } from 'date-fns';
import { fr } from 'date-fns/locale';
import { useApi } from '../../../lib/api';
import { getDayReservations } from '@/lib/day-reservations';
import {
  getErrorMessage,
  type ServiceCardBadge,
  type Reservation,
  type ReservationState,
  type WaitingListEntry,
  type WaitingListStatus,
} from '@/types/api';
import { ApiError } from '@/lib/api-error';
import { useIsMobile } from '@/lib/useMediaQuery';
import { cn, formatPhone } from '@/lib/utils';
import MobileDataCard from '@/components/MobileDataCard';
import { ReservationAdditionLine, useReservationAddition } from '@/components/pos/real-spend';
import { useCapabilities } from '@/lib/use-capabilities';
import { ReservationCardGuarantee } from '@/features/card-guarantee/reservation-card-guarantee';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ChevronLeft, ChevronRight, MoreHorizontal, StickyNote } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ReservationDatePicker } from '@/components/reservation/reservation-date-picker';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataFetchError } from '@/components/DataFetchError';
import {
  ServiceBadgeList,
  ServiceCardBadges,
  useServiceCards,
} from '@/components/reservation/service-card-badges';

const eur = new Intl.NumberFormat('fr-FR', {
  style: 'currency',
  currency: 'EUR',
  maximumFractionDigits: 0,
});

const reservationState = (reservation: Reservation): ReservationState =>
  reservation.state ?? reservation.status;

const isActiveForTable = (state: ReservationState | string) =>
  state === 'PENDING' || state === 'CONFIRMED' || state === 'SEATED';

type ReservationAction = 'confirm' | 'allocate' | 'seat' | 'honor' | 'cancel' | 'no-show';

function actionsForReservation(reservation: Reservation): {
  primary: ReservationAction | null;
  secondary: ReservationAction[];
} {
  const state = reservationState(reservation);
  if (state === 'PENDING') return { primary: 'confirm', secondary: ['cancel'] };
  if (state === 'CONFIRMED') {
    return {
      primary: reservation.tableId ? 'seat' : 'allocate',
      secondary: [
        'cancel',
        ...(new Date(reservation.reservedAt) <= new Date() ? ['no-show' as const] : []),
      ],
    };
  }
  if (state === 'SEATED') {
    return { primary: 'honor', secondary: ['no-show'] };
  }
  return { primary: null, secondary: [] };
}

const actionLabels: Record<ReservationAction, string> = {
  confirm: 'Confirmer',
  allocate: 'Attribuer une table',
  seat: 'Installer',
  honor: 'Terminer',
  cancel: 'Annuler',
  'no-show': 'Marquer absent',
};

const dateTheme = {
  '--reservation-wash': 'var(--background)',
  '--reservation-panel': 'var(--card)',
  '--reservation-ink': 'var(--foreground)',
  '--reservation-soft': 'var(--muted-foreground)',
  '--reservation-muted': 'var(--muted-foreground)',
  '--reservation-line': 'var(--border)',
  '--reservation-accent': 'var(--primary)',
} as CSSProperties;
const channelLabel = (channel?: string | null) =>
  ({
    PHONE: 'Téléphone',
    WEB: 'En ligne',
    MCP: 'Assistant IA',
    OPENAI_RESERVE: 'ChatGPT',
    ADMIN: 'Équipe',
    API: 'API',
  })[channel ?? ''] ?? 'Non renseigné';

function ReservationNote({ note }: { note: string }) {
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            onKeyDown={(event) => event.stopPropagation()}
            className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          >
            <StickyNote size={13} className="shrink-0" aria-hidden="true" />
            <span className="truncate">{note}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-sm whitespace-pre-wrap break-words">{note}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type Tab = 'reservations' | 'waiting-list';

type CustomerSuggestion = {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  visitCount: number | null;
  lastVisitAt: string | null;
  badges: ServiceCardBadge[];
};

type WaitingListApiEntry = WaitingListEntry & {
  preferredSection?: { name: string } | null;
};

function mapWaitingListEntries(data: unknown[]): WaitingListEntry[] {
  return data.map((item) => {
    const entry = item as WaitingListApiEntry;
    return {
      ...entry,
      preferredSectionName: entry.preferredSectionName ?? entry.preferredSection?.name ?? null,
    };
  });
}

/** Jour demandé par l'URL, AAAA-MM-JJ ; null si absent ou inexistant. */
function requestedDay(value: string | null): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const day = parseISO(value);
  return Number.isNaN(day.getTime()) ? null : day;
}

export default function ReservationsPage() {
  const { get, post, patch, del, orgId } = useApi();
  const isMobile = useIsMobile();

  const [creating, setCreating] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('reservations');

  const [reservations, setReservations] = useState<Reservation[]>([]);
  // Écran de chargement complet seulement au premier affichage ; un changement de date garde la barre
  // de dates à l'écran et remplace seulement la liste.
  const [initialLoading, setInitialLoading] = useState(true);
  const [reservationsLoading, setReservationsLoading] = useState(false);

  const [waitingList, setWaitingList] = useState<WaitingListEntry[]>([]);
  const [waitingListLoading, setWaitingListLoading] = useState(false);
  // Jour affiché, partagé par les réservations et la file d'attente : le service du jour d'abord.
  // Un lien avec `?date=` (carte « Ce soir ») le remplace, même quand la page est déjà ouverte.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlDate = searchParams.get('date');
  const [appliedUrlDate, setAppliedUrlDate] = useState(urlDate);
  const [selectedDate, setSelectedDate] = useState<Date>(() => requestedDay(urlDate) ?? new Date());
  if (urlDate !== appliedUrlDate) {
    setAppliedUrlDate(urlDate);
    const day = requestedDay(urlDate);
    if (day) setSelectedDate(day);
  }
  const dateParam = format(selectedDate, 'yyyy-MM-dd');

  // Réservation demandée par l'URL (`?reservation=`) : elle s'ouvre dès que la liste du jour est chargée.
  const requestedReservationId = searchParams.get('reservation');
  const requestedReservation = reservations.find(
    (reservation) => reservation.id === requestedReservationId,
  );
  const drawerReservation = selectedReservation ?? requestedReservation ?? null;

  function closeReservation() {
    setSelectedReservation(null);
    if (!requestedReservationId) return;
    // Sans ces paramètres, un nouveau clic sur la même carte ne rouvrirait rien, ni le bon jour.
    const params = new URLSearchParams(searchParams.toString());
    params.delete('reservation');
    params.delete('date');
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const [error, setError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingCancelId, setPendingCancelId] = useState<string | null>(null);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (
        event.key.toLowerCase() !== 'n' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.repeat ||
        creating ||
        selectedReservation ||
        document.querySelector('[role="dialog"]') ||
        target?.isContentEditable ||
        target?.closest('input, textarea, select, [role="dialog"]')
      )
        return;
      event.preventDefault();
      setCreating(true);
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [creating, selectedReservation]);
  useEffect(() => {
    if (!highlightedId) return;
    const timer = setTimeout(() => setHighlightedId(null), 5000);
    return () => clearTimeout(timer);
  }, [highlightedId]);

  const serviceCards = useServiceCards(reservations.map((reservation) => reservation.id));
  const countedReservations = reservations.filter(
    (reservation) => !['CANCELLED', 'NO_SHOW'].includes(reservationState(reservation)),
  );
  const hasEstimatedRevenue = reservations.some(
    (reservation) => reservation.estimatedRevenue != null,
  );

  const [promotingId, setPromotingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [entryToRemove, setEntryToRemove] = useState<WaitingListEntry | null>(null);

  const fetchReservations = useCallback(async () => {
    if (!orgId) return;
    setReservationsLoading(true);
    setError('');
    try {
      // Sans `date`, l'API renvoie tout l'historique du compte, du plus ancien au plus récent : le service
      // de ce soir finissait sous des centaines de lignes passées.
      const data = await getDayReservations(get, dateParam);
      setReservations(Array.isArray(data) ? data : []);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de charger les réservations'));
    } finally {
      setReservationsLoading(false);
      setInitialLoading(false);
    }
  }, [get, orgId, dateParam]);

  useEffect(() => {
    void fetchReservations();
  }, [fetchReservations]);

  const loadWaitingList = useCallback(async () => {
    if (!orgId) return;
    setWaitingListLoading(true);
    setError('');
    try {
      const data = await get<unknown[]>(`restaurants/${orgId}/waiting-list?date=${dateParam}`);
      setWaitingList(mapWaitingListEntries(Array.isArray(data) ? data : []));
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible de charger la file d'attente"));
    } finally {
      setWaitingListLoading(false);
    }
  }, [orgId, get, dateParam]);

  useEffect(() => {
    loadWaitingList();
  }, [loadWaitingList]);

  async function updateStatus(id: string, newStatus: Reservation['status']) {
    if (pendingActionId) return;
    setPendingActionId(id);
    try {
      setError('');
      const updated = await patch<Reservation>(`reservations/${id}`, { status: newStatus });
      setReservations((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Impossible de mettre à jour le statut'));
    } finally {
      setPendingActionId(null);
    }
  }

  async function transitionState(id: string, state: 'SEATED' | 'HONORED') {
    if (pendingActionId || !orgId) return;
    setPendingActionId(id);
    setError('');
    try {
      await patch<void>(`restaurants/${orgId}/floor-plan/reservations/${id}/state`, { state });
      setReservations((prev) =>
        prev.map((reservation) =>
          reservation.id === id
            ? { ...reservation, state, status: state === 'SEATED' ? 'SEATED' : reservation.status }
            : reservation,
        ),
      );
      try {
        const data = await getDayReservations(get, dateParam);
        setReservations(Array.isArray(data) ? data : []);
      } catch {
        toast.error('Statut mis à jour, mais la liste n’a pas pu être actualisée.');
      }
    } catch (err: unknown) {
      if (err instanceof ApiError && err.kind === 'conflict') {
        // La liste affichée est périmée (autre appareil) ou le créneau est terminé : on la rafraîchit.
        toast.error(
          'Cette réservation a changé entre-temps ou son créneau est terminé. Liste actualisée.',
        );
        try {
          const data = await getDayReservations(get, dateParam);
          setReservations(Array.isArray(data) ? data : []);
        } catch {
          /* le message ci-dessus suffit ; « Actualiser » reste disponible */
        }
      } else {
        toast.error(getErrorMessage(err, 'Impossible de mettre à jour la réservation.'));
      }
    } finally {
      setPendingActionId(null);
    }
  }

  function runReservationAction(reservation: Reservation, action: ReservationAction) {
    if (pendingActionId) return;
    if (action === 'confirm') return void updateStatus(reservation.id, 'CONFIRMED');
    if (action === 'allocate') return void allocateTable(reservation.id);
    if (action === 'seat') return void transitionState(reservation.id, 'SEATED');
    if (action === 'honor') return void transitionState(reservation.id, 'HONORED');
    if (action === 'cancel') {
      setPendingCancelId(reservation.id);
      setConfirmOpen(true);
      return;
    }
    if (action === 'no-show') return void updateStatus(reservation.id, 'NO_SHOW');
  }

  async function confirmCancelReservation() {
    if (!pendingCancelId || pendingActionId) return;
    const id = pendingCancelId;
    setPendingActionId(id);
    try {
      setError('');
      const updated = await patch<Reservation>(`reservations/${id}`, { status: 'CANCELLED' });
      setReservations((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Impossible d’annuler la réservation'));
    } finally {
      setConfirmOpen(false);
      setPendingCancelId(null);
      setPendingActionId(null);
    }
  }

  async function allocateTable(id: string) {
    if (pendingActionId) return;
    setPendingActionId(id);
    setError('');
    try {
      const updated = await post<Reservation>(`reservations/${id}/allocate-table`);
      setReservations((prev) => prev.map((r) => (r.id === id ? { ...r, ...updated } : r)));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Impossible d’attribuer une table'));
    } finally {
      setPendingActionId(null);
    }
  }

  async function promoteEntry(entry: WaitingListEntry) {
    setPromotingId(entry.id);
    try {
      await post(`restaurants/${orgId}/waiting-list/${entry.id}/promote`);
      toast.success('Table proposée');
      await loadWaitingList();
    } catch (err: unknown) {
      const msg = getErrorMessage(err, 'Impossible de proposer une table');
      if (msg === 'no_compatible_table' || msg.includes('no_compatible_table')) {
        toast.error('Aucune table compatible');
      } else if (msg.includes('already_promoted')) {
        toast.error('Cette demande a déjà reçu une table');
        await loadWaitingList();
      } else {
        toast.error(msg);
      }
    } finally {
      setPromotingId(null);
    }
  }

  async function removeEntry(entry: WaitingListEntry) {
    setRemovingId(entry.id);
    setError('');
    try {
      await del(`restaurants/${orgId}/waiting-list/${entry.id}`);
      setWaitingList((prev) => prev.filter((e) => e.id !== entry.id));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Impossible de retirer l'entrée"));
    } finally {
      setRemovingId(null);
      setEntryToRemove(null);
    }
  }

  if (initialLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-36 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6" style={dateTheme}>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Réservations</h1>
          <Button onClick={() => setCreating(true)}>+ Réservation</Button>
        </div>
        {activeTab === 'reservations' && (
          <span className="text-sm text-muted-foreground">
            {countedReservations.length} réservation{countedReservations.length === 1 ? '' : 's'} ·{' '}
            {countedReservations.reduce((sum, reservation) => sum + reservation.partySize, 0)}{' '}
            couverts
          </span>
        )}
        <Tabs
          value={activeTab}
          onValueChange={(value) => {
            setActiveTab(value as Tab);
            setError('');
          }}
        >
          <TabsList>
            <TabsTrigger value="reservations" className="transition-all duration-200">
              Réservations{' '}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {countedReservations.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="waiting-list" className="transition-all duration-200">
              File d&apos;attente{' '}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {waitingList.length}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Jour précédent"
          onClick={() => setSelectedDate((current) => addDays(current, -1))}
          className="transition-all duration-200"
        >
          <ChevronLeft size={16} />
        </Button>
        <ReservationDatePicker
          value={dateParam}
          min="1900-01-01"
          max="2100-12-31"
          theme={dateTheme}
          onChange={(value) => setSelectedDate(parseISO(value))}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label="Jour suivant"
          onClick={() => setSelectedDate((current) => addDays(current, 1))}
          className="transition-all duration-200"
        >
          <ChevronRight size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={isSameDay(selectedDate, new Date())}
          onClick={() => setSelectedDate(new Date())}
          className="transition-all duration-200"
        >
          Aujourd’hui
        </Button>
      </div>

      {error && (
        <DataFetchError
          message={error}
          onRetry={activeTab === 'waiting-list' ? loadWaitingList : fetchReservations}
          retrying={activeTab === 'waiting-list' ? waitingListLoading : reservationsLoading}
        />
      )}

      {activeTab === 'reservations' && (
        <>
          {reservationsLoading ? (
            <div className="space-y-2" aria-busy="true">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : reservations.length === 0 ? (
            error ? null : (
              <p className="text-sm text-muted-foreground">
                Aucune réservation le {format(selectedDate, 'EEEE d MMMM', { locale: fr })}{' '}
                <Link
                  href="/dashboard/widget"
                  className="font-medium text-foreground underline underline-offset-4 transition-all duration-200 hover:text-primary"
                >
                  Ouvrir le widget
                </Link>
              </p>
            )
          ) : isMobile ? (
            /* ========== MOBILE: Reservation Card List ========== */
            <div className="space-y-2.5">
              {reservations.map((res) =>
                (() => {
                  const state = reservationState(res);
                  const available = actionsForReservation(res);
                  return (
                    <MobileDataCard
                      key={res.id}
                      accentClass={highlightedId === res.id ? 'border-l-primary' : undefined}
                      onClick={() => setSelectedReservation(res)}
                      title={res.customerName}
                      subtitle={[
                        res.customerPhone && formatPhone(res.customerPhone),
                        channelLabel(res.channel),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                      badge={
                        <div className="flex flex-wrap gap-1">
                          <StatusBadge status={state} />
                          {res.overbooked && <StatusPill level="action">Surbooking</StatusPill>}
                        </div>
                      }
                      primaryAction={
                        available.primary
                          ? {
                              label:
                                pendingActionId === res.id
                                  ? 'En cours…'
                                  : actionLabels[available.primary],
                              disabled: pendingActionId !== null,
                              onClick: () => runReservationAction(res, available.primary!),
                            }
                          : undefined
                      }
                      actions={available.secondary.map((action) => ({
                        label: actionLabels[action],
                        colorClass: 'bg-secondary text-secondary-foreground',
                        onClick: () => runReservationAction(res, action),
                      }))}
                      details={[
                        {
                          label: 'Heure',
                          value: (
                            <span className="font-semibold tabular-nums text-foreground">
                              {format(new Date(res.reservedAt), 'HH:mm')}
                            </span>
                          ),
                        },
                        {
                          label: 'Couverts',
                          value: <span className="tabular-nums">{res.partySize} pers.</span>,
                        },
                        {
                          label: 'Table',
                          value: res.tableId ? (
                            (res.table?.name ?? '—')
                          ) : isActiveForTable(state) ? (
                            <StatusPill level="action">Sans table</StatusPill>
                          ) : (
                            '—'
                          ),
                        },
                        ...(res.specialRequests
                          ? [
                              {
                                label: 'Notes',
                                value: (
                                  <span className="line-clamp-2 whitespace-normal">
                                    {res.specialRequests}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        ...(serviceCards.loading ||
                        serviceCards.error ||
                        (serviceCards.cards.get(res.id)?.badges.length ?? 0) > 0
                          ? [
                              {
                                label: 'Fiche',
                                value: (
                                  <ServiceCardBadges reservationId={res.id} state={serviceCards} />
                                ),
                              },
                            ]
                          : []),
                        ...(hasEstimatedRevenue
                          ? [
                              {
                                label: 'Revenu estimé',
                                value:
                                  res.estimatedRevenue != null
                                    ? eur.format(res.estimatedRevenue)
                                    : '—',
                              },
                            ]
                          : []),
                      ]}
                    />
                  );
                })(),
              )}
            </div>
          ) : (
            /* ========== DESKTOP: Reservation Table ========== */
            <div className="sokar-card overflow-hidden">
              <div className="mobile-table-wrapper">
                <Table className="[&_th]:px-2 [&_td]:px-2">
                  <TableHeader>
                    <TableRow className="bg-muted/20 hover:bg-muted/20">
                      <TableHead className="w-[64px]">Heure</TableHead>
                      <TableHead className="min-w-[110px]">Client</TableHead>
                      <TableHead className="w-[70px] text-center">Couverts</TableHead>
                      {hasEstimatedRevenue && (
                        <TableHead className="hidden xl:table-cell">Revenu estimé</TableHead>
                      )}
                      <TableHead className="min-w-[90px]">Statut</TableHead>
                      <TableHead className="min-w-[85px]">Table</TableHead>
                      <TableHead className="w-[140px] text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reservations.map((res) => (
                      <TableRow
                        key={res.id}
                        className={cn(
                          'cursor-pointer transition-all duration-200 hover:bg-accent',
                          highlightedId === res.id && 'bg-accent',
                        )}
                        onClick={() => setSelectedReservation(res)}
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            setSelectedReservation(res);
                          }
                        }}
                      >
                        {(() => {
                          const state = reservationState(res);
                          return (
                            <>
                              <TableCell className="py-3">
                                <time
                                  dateTime={res.reservedAt}
                                  className="text-sm font-semibold tabular-nums text-foreground"
                                >
                                  {format(new Date(res.reservedAt), 'HH:mm')}
                                </time>
                              </TableCell>
                              <TableCell className="max-w-[220px] py-3">
                                <div className="min-w-0">
                                  <p className="truncate font-medium" title={res.customerName}>
                                    {res.customerName}
                                  </p>
                                  {res.overbooked && (
                                    <StatusPill level="action">Surbooking</StatusPill>
                                  )}
                                  {res.specialRequests && (
                                    <ReservationNote note={res.specialRequests} />
                                  )}
                                  {res.customerPhone ? (
                                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                                      {formatPhone(res.customerPhone)}
                                    </p>
                                  ) : null}
                                  <p className="mt-0.5 text-xs text-muted-foreground">
                                    {channelLabel(res.channel)}
                                  </p>
                                  <ServiceCardBadges
                                    reservationId={res.id}
                                    state={serviceCards}
                                    className="mt-1.5"
                                  />
                                </div>
                              </TableCell>
                              <TableCell className="py-3 text-center font-medium tabular-nums">
                                {res.partySize}
                              </TableCell>
                              {hasEstimatedRevenue && (
                                <TableCell className="hidden py-3 tabular-nums xl:table-cell">
                                  {res.estimatedRevenue != null
                                    ? eur.format(res.estimatedRevenue)
                                    : '—'}
                                </TableCell>
                              )}
                              <TableCell className="py-3">
                                <StatusBadge status={state} />
                              </TableCell>
                              <TableCell className="py-3">
                                {res.tableId ? (
                                  (res.table?.name ?? '—')
                                ) : isActiveForTable(state) ? (
                                  <div className="flex items-center gap-2">
                                    <StatusPill level="action">Sans table</StatusPill>
                                  </div>
                                ) : (
                                  '—'
                                )}
                              </TableCell>
                              <TableCell
                                className="py-3 text-right"
                                onClick={(event) => event.stopPropagation()}
                                onKeyDown={(event) => event.stopPropagation()}
                              >
                                {(() => {
                                  const available = actionsForReservation(res);
                                  return (
                                    <div className="flex items-center justify-end gap-1">
                                      {available.primary && (
                                        <Button
                                          size="sm"
                                          disabled={pendingActionId !== null}
                                          onClick={() =>
                                            runReservationAction(res, available.primary!)
                                          }
                                          className="h-8 whitespace-nowrap px-3 text-xs transition-all duration-200"
                                        >
                                          {pendingActionId === res.id
                                            ? 'En cours…'
                                            : actionLabels[available.primary]}
                                        </Button>
                                      )}
                                      {available.secondary.length > 0 && (
                                        <DropdownMenu>
                                          <DropdownMenuTrigger asChild>
                                            <Button
                                              variant="outline"
                                              size="icon"
                                              className="h-8 w-8 shrink-0 transition-all duration-200"
                                              disabled={pendingActionId !== null}
                                              aria-label={`Autres actions pour ${res.customerName}`}
                                            >
                                              <MoreHorizontal className="h-4 w-4" />
                                            </Button>
                                          </DropdownMenuTrigger>
                                          <DropdownMenuContent align="end">
                                            {available.secondary.map((action) => (
                                              <DropdownMenuItem
                                                key={action}
                                                onSelect={() => runReservationAction(res, action)}
                                              >
                                                {actionLabels[action]}
                                              </DropdownMenuItem>
                                            ))}
                                          </DropdownMenuContent>
                                        </DropdownMenu>
                                      )}
                                    </div>
                                  );
                                })()}
                              </TableCell>
                            </>
                          );
                        })()}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </>
      )}

      {activeTab === 'waiting-list' && (
        <div className="space-y-4">
          {waitingListLoading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full rounded-xl" />
              ))}
            </div>
          ) : waitingList.length === 0 ? (
            error ? null : (
              <p className="text-sm text-muted-foreground">
                Aucune demande en attente le {format(selectedDate, 'EEEE d MMMM', { locale: fr })}
              </p>
            )
          ) : isMobile ? (
            // Sur téléphone : une carte par demande, avec « Proposer une table » visible sans défilement latéral.
            <div className="space-y-2">
              {waitingList.map((entry) => (
                <div key={entry.id}>
                  <MobileDataCard
                    title={`#${entry.position} · ${`${entry.customerFirstName} ${entry.customerLastName ?? ''}`.trim()}`}
                    subtitle={entry.customerPhone ? formatPhone(entry.customerPhone) : undefined}
                    badge={<WaitingListStatusBadge status={entry.status} />}
                    details={[
                      { label: 'Couverts', value: entry.partySize },
                      {
                        label: 'Heure',
                        value: format(new Date(entry.slotStart), 'HH:mm'),
                      },
                      { label: 'Section', value: entry.preferredSectionName || '—' },
                    ]}
                    primaryAction={
                      entry.status === 'PENDING'
                        ? {
                            label: promotingId === entry.id ? 'Proposition…' : 'Proposer une table',
                            onClick: () => void promoteEntry(entry),
                            disabled: promotingId === entry.id,
                          }
                        : undefined
                    }
                    actions={[
                      {
                        label: 'Retirer',
                        colorClass: 'bg-secondary text-secondary-foreground',
                        onClick: () => setEntryToRemove(entry),
                      },
                    ]}
                  />
                </div>
              ))}
            </div>
          ) : (
            <div className="sokar-card overflow-hidden">
              <div className="mobile-table-wrapper">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="hidden xl:table-cell">Position</TableHead>
                      <TableHead>Nom</TableHead>
                      <TableHead className="hidden lg:table-cell">Téléphone</TableHead>
                      <TableHead>Couverts</TableHead>
                      <TableHead>Heure</TableHead>
                      <TableHead className="hidden xl:table-cell">Section</TableHead>
                      <TableHead>Statut</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {waitingList.map((entry) => (
                      <TableRow
                        key={entry.id}
                        className="transition-all duration-200 hover:bg-accent"
                      >
                        <TableCell className="hidden font-medium xl:table-cell">
                          #{entry.position}
                        </TableCell>
                        <TableCell>
                          {`${entry.customerFirstName} ${entry.customerLastName ?? ''}`.trim()}
                          <span className="block text-xs text-muted-foreground lg:hidden">
                            {entry.customerPhone ? formatPhone(entry.customerPhone) : '—'}
                          </span>
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                          {entry.customerPhone ? formatPhone(entry.customerPhone) : '—'}
                        </TableCell>
                        <TableCell>{entry.partySize}</TableCell>
                        <TableCell>{format(new Date(entry.slotStart), 'HH:mm')}</TableCell>
                        <TableCell className="hidden text-muted-foreground xl:table-cell">
                          {entry.preferredSectionName || <span className="opacity-50">—</span>}
                        </TableCell>
                        <TableCell>
                          <WaitingListStatusBadge status={entry.status} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            {entry.status === 'PENDING' && (
                              <Button
                                size="sm"
                                className="h-8 whitespace-nowrap px-3 text-xs"
                                disabled={promotingId === entry.id}
                                onClick={() => promoteEntry(entry)}
                              >
                                {promotingId === entry.id ? 'Proposition…' : 'Proposer une table'}
                              </Button>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-8 w-8 shrink-0 transition-all duration-200"
                                  disabled={removingId === entry.id}
                                  aria-label={`Autres actions pour ${`${entry.customerFirstName} ${entry.customerLastName ?? ''}`.trim()}`}
                                >
                                  <MoreHorizontal className="h-4 w-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setEntryToRemove(entry)}>
                                  Retirer
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>
      )}

      {creating && (
        <CreateReservation
          initialDate={dateParam}
          restaurantId={orgId!}
          get={get}
          post={post}
          onClose={() => setCreating(false)}
          onSaved={async (id, date) => {
            setCreating(false);
            setHighlightedId(id);
            if (date === dateParam) await fetchReservations();
            else setSelectedDate(parseISO(date));
          }}
        />
      )}

      {drawerReservation && (
        <ReservationDetails
          reservation={drawerReservation}
          onClose={closeReservation}
          onSaved={async () => {
            closeReservation();
            await fetchReservations();
          }}
          post={post}
        />
      )}

      <ConfirmDialog
        open={entryToRemove !== null}
        pending={removingId !== null}
        onConfirm={() => {
          if (entryToRemove) void removeEntry(entryToRemove);
        }}
        onCancel={() => setEntryToRemove(null)}
        title="Retirer de la file d'attente ?"
        description="Cette demande sera retirée de la file d'attente."
        confirmLabel="Confirmer le retrait"
        variant="destructive"
      />
      <ConfirmDialog
        open={confirmOpen}
        pending={pendingActionId === pendingCancelId && pendingCancelId !== null}
        onConfirm={confirmCancelReservation}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingCancelId(null);
        }}
        title="Annuler la réservation"
        description="Cette réservation passera au statut Annulée. Son historique restera conservé."
        confirmLabel="Annuler la réservation"
        variant="destructive"
      />
    </div>
  );
}

function CreateReservation({
  initialDate,
  restaurantId,
  get,
  post,
  onClose,
  onSaved,
}: {
  initialDate: string;
  restaurantId: string;
  get: ReturnType<typeof useApi>['get'];
  post: ReturnType<typeof useApi>['post'];
  onClose: () => void;
  onSaved: (id: string, date: string) => Promise<void>;
}) {
  const [partySize, setPartySize] = useState('2');
  const [date, setDate] = useState(initialDate);
  const [slot, setSlot] = useState<{ time: string; available: boolean } | null>(null);
  const [slots, setSlots] = useState<{ time: string; available: boolean; past: boolean }[]>([]);
  const [timezone, setTimezone] = useState('');
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [slotsError, setSlotsError] = useState('');
  const [reloadSlots, setReloadSlots] = useState(0);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [notes, setNotes] = useState('');
  const [search, setSearch] = useState('');
  const [searchField, setSearchField] = useState<'phone' | 'name' | null>(null);
  const [customers, setCustomers] = useState<CustomerSuggestion[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSuggestion | null>(null);
  const [searchError, setSearchError] = useState(false);
  const [confirmSlot, setConfirmSlot] = useState<{ time: string; available: boolean } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const [initialKey] = useState(() => crypto.randomUUID());
  const key = useRef<string | null>(initialKey);
  const lastPayload = useRef('');
  const size = Number(partySize);
  const validSize = Number.isInteger(size) && size >= 1 && size <= 20;
  const normalizedPhone = normalizePhone(phone);
  const validPhone = /^[+\d\s().-]+$/.test(phone) && /^\+33[1-9]\d{8}$/.test(normalizedPhone);
  const validEmail = !email.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const valid =
    validSize &&
    !!slot &&
    !!timezone &&
    validPhone &&
    name.trim().length > 0 &&
    name.trim().length <= 200 &&
    validEmail;

  useEffect(() => {
    if (!validSize) {
      setSlots([]);
      setSlotsLoading(false);
      return;
    }
    let current = true;
    setSlotsLoading(true);
    setSlotsError('');
    setSlots([]);
    Promise.all([
      get<{ slots: { time: string; available: boolean; past: boolean }[] }>(
        `reservations/staff-availability?date=${date}&partySize=${size}`,
      ),
      get<{ timezone: string }>(`restaurants/${restaurantId}`),
    ])
      .then(([result, restaurant]) => {
        if (current) {
          setSlots(result.slots);
          setTimezone(restaurant.timezone || 'Europe/Paris');
        }
      })
      .catch((err) => {
        if (current) setSlotsError(getErrorMessage(err, 'Impossible de charger les créneaux.'));
      })
      .finally(() => {
        if (current) setSlotsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [get, date, size, validSize, reloadSlots, restaurantId]);

  useEffect(() => {
    const term = search.trim();
    if (term.length < 2) {
      setCustomers([]);
      setSearchError(false);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      get<{ data: CustomerSuggestion[] }>(
        `customers/suggestions?search=${encodeURIComponent(term)}&limit=5`,
      )
        .then((result) => {
          if (current) {
            setCustomers(result.data ?? []);
            setSearchError(false);
          }
        })
        .catch(() => {
          if (current) {
            setCustomers([]);
            setSearchError(true);
          }
        });
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [get, search]);

  async function submit(selected = slot, forceNewKey = false) {
    if (
      inFlight.current ||
      !validSize ||
      !selected ||
      !timezone ||
      !validPhone ||
      !name.trim() ||
      name.trim().length > 200 ||
      !validEmail
    )
      return;
    const naive = new Date(`${date}T${selected.time}:00Z`);
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(naive);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((item) => item.type === type)?.value);
    const offset =
      Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute')) -
      naive.getTime();
    const instant = new Date(naive.getTime() - offset);
    if (Number.isNaN(instant.getTime())) {
      setError('Date ou heure invalide.');
      return;
    }
    const fields = {
      startsAt: instant.toISOString(),
      partySize: size,
      customerName: name.trim(),
      customerPhone: normalizedPhone,
      ...(email.trim() ? { customerEmail: email.trim() } : {}),
      ...(notes.trim() ? { specialRequests: notes.trim() } : {}),
      ...(selected.available ? {} : { overbook: true }),
    };
    const fingerprint = JSON.stringify(fields);
    if (forceNewKey || !key.current || (lastPayload.current && lastPayload.current !== fingerprint))
      key.current = crypto.randomUUID();
    lastPayload.current = fingerprint;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const result = await post<{ reservationId: string }>('reservations/staff', {
        ...fields,
        idempotencyKey: key.current,
      });
      toast.success('Réservation créée.');
      await onSaved(result.reservationId, date);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) key.current = crypto.randomUUID();
      setError(getErrorMessage(err, 'Impossible de créer la réservation.'));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }
  const visibleSlots = slots.filter((item) => !item.past);
  const suggestions = (customers.length > 0 || searchError) && (
    <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-md border border-border bg-popover p-2 text-popover-foreground shadow-md">
      {customers.map((customer) => (
        <button
          type="button"
          key={customer.id}
          className="block w-full rounded-md p-2 text-left text-sm transition-all duration-200 hover:bg-accent"
          onClick={() => {
            setName(customer.name ?? '');
            setPhone(formatPhone(customer.phone));
            setEmail(customer.email ?? '');
            setSelectedCustomer(customer);
            setSearch('');
            setSearchField(null);
            setCustomers([]);
          }}
        >
          <span className="block font-medium">
            {customer.name || 'Sans nom'} · {formatPhone(customer.phone)}
          </span>
          {customer.visitCount !== null && (
            <span className="block text-xs text-muted-foreground">
              {customer.visitCount === 0 ? '1re' : `${customer.visitCount + 1}e`} visite
              {customer.lastVisitAt
                ? ` · dernière le ${format(parseISO(customer.lastVisitAt), 'dd/MM')}`
                : ''}
            </span>
          )}
          <ServiceBadgeList badges={customer.badges} className="mt-1" />
        </button>
      ))}
      {searchError && (
        <p className="p-2 text-sm text-muted-foreground">Recherche client indisponible.</p>
      )}
    </div>
  );
  function changeDate(value: string) {
    setDate(value);
    setSlot(null);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        sidePanel
        style={dateTheme}
        className="left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:rounded-none"
      >
        <DialogTitle>Nouvelle réservation</DialogTitle>
        <DialogDescription>
          Choisissez un créneau et renseignez les coordonnées du client.
        </DialogDescription>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Couverts</legend>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 8 }, (_, i) => i + 1).map((n) => (
                <Button
                  key={n}
                  type="button"
                  size="sm"
                  variant={size === n ? 'default' : 'outline'}
                  aria-pressed={size === n}
                  onClick={() => {
                    setPartySize(String(n));
                    setSlot(null);
                  }}
                >
                  {n}
                </Button>
              ))}
              <Input
                aria-label="Nombre de couverts"
                className="w-20"
                type="number"
                min={1}
                max={20}
                step={1}
                value={partySize}
                onChange={(event) => {
                  setPartySize(event.target.value);
                  setSlot(null);
                }}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Jour</legend>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant={date === format(new Date(), 'yyyy-MM-dd') ? 'default' : 'outline'}
                onClick={() => changeDate(format(new Date(), 'yyyy-MM-dd'))}
              >
                Aujourd’hui
              </Button>
              <Button
                type="button"
                size="sm"
                variant={
                  date === format(addDays(new Date(), 1), 'yyyy-MM-dd') ? 'default' : 'outline'
                }
                onClick={() => changeDate(format(addDays(new Date(), 1), 'yyyy-MM-dd'))}
              >
                Demain
              </Button>
              <ReservationDatePicker
                value={date}
                min="1900-01-01"
                max="2100-12-31"
                theme={dateTheme}
                onChange={changeDate}
              />
            </div>
          </fieldset>
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Heure</legend>
            {!validSize ? (
              <p className="text-sm text-muted-foreground">Choisissez de 1 à 20 couverts.</p>
            ) : slotsLoading ? (
              <p role="status" className="text-sm text-muted-foreground">
                Chargement des créneaux…
              </p>
            ) : slotsError ? (
              <div className="text-sm text-destructive" role="alert">
                {slotsError}{' '}
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setReloadSlots((value) => value + 1)}
                >
                  Réessayer
                </Button>
              </div>
            ) : slots.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun créneau ce jour</p>
            ) : visibleSlots.length === 0 ? (
              <p className="text-sm text-muted-foreground">Aucun créneau restant aujourd’hui</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {visibleSlots.map((item) => (
                  <Button
                    key={item.time}
                    type="button"
                    size="sm"
                    variant={slot?.time === item.time ? 'default' : 'outline'}
                    aria-pressed={slot?.time === item.time}
                    aria-label={`${item.time}${item.available ? '' : ' — complet'}`}
                    className={
                      !item.available && slot?.time !== item.time ? 'text-muted-foreground' : ''
                    }
                    onClick={() => (item.available ? setSlot(item) : setConfirmSlot(item))}
                  >
                    {item.time}
                    {!item.available && ' · Complet'}
                  </Button>
                ))}
              </div>
            )}
          </fieldset>
          <div className="relative">
            <label className="block space-y-1 text-sm font-medium">
              Téléphone
              <Input
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(event) => {
                  setPhone(event.target.value);
                  setSelectedCustomer(null);
                  setSearchField('phone');
                  setSearch(event.target.value);
                  setCustomers([]);
                  setSearchError(false);
                }}
                required
              />
            </label>
            {searchField === 'phone' && suggestions}
          </div>
          <div className="relative">
            <label className="block space-y-1 text-sm font-medium">
              Nom
              <Input
                value={name}
                maxLength={200}
                onChange={(event) => {
                  setName(event.target.value);
                  setSelectedCustomer(null);
                  setSearchField('name');
                  setSearch(event.target.value);
                  setCustomers([]);
                  setSearchError(false);
                }}
                required
              />
            </label>
            {searchField === 'name' && suggestions}
          </div>
          {selectedCustomer && <ServiceBadgeList badges={selectedCustomer.badges} />}
          <label className="block space-y-1 text-sm font-medium">
            E-mail (facultatif)
            <Input
              type="email"
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor="new-reservation-notes">
              Notes
            </label>
            <div className="flex flex-wrap gap-2">
              {['Anniversaire', 'Allergie', 'Chaise bébé', 'Terrasse'].map((label) => (
                <Button
                  key={label}
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setNotes((current) => (current ? `${current}, ${label}`.slice(0, 500) : label))
                  }
                >
                  {label}
                </Button>
              ))}
            </div>
            <textarea
              id="new-reservation-notes"
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              maxLength={500}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {slot && !slot.available && (
            <p className="text-sm text-foreground">
              Surbooking : la réservation sera créée sans table.
            </p>
          )}
          <Button type="submit" disabled={!valid || saving}>
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </Button>
        </form>
        <ConfirmDialog
          open={confirmSlot !== null}
          title="Ce créneau est complet. Forcer quand même ?"
          description="La réservation sera créée sans table attribuée."
          confirmLabel="Forcer la réservation"
          onCancel={() => setConfirmSlot(null)}
          onConfirm={() => {
            const chosen = confirmSlot;
            setConfirmSlot(null);
            if (!chosen) return;
            setSlot(chosen);
            key.current = crypto.randomUUID();
            lastPayload.current = '';
            if (validSize && validPhone && name.trim() && validEmail) void submit(chosen);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

function ReservationDetails({
  reservation,
  onClose,
  onSaved,
  post,
}: {
  reservation: Reservation;
  onClose: () => void;
  onSaved: () => Promise<void>;
  post: ReturnType<typeof useApi>['post'];
}) {
  const originalDate = new Date(reservation.reservedAt);
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(format(originalDate, 'yyyy-MM-dd'));
  const [time, setTime] = useState(format(originalDate, 'HH:mm'));
  const [partySize, setPartySize] = useState(reservation.partySize);
  const [name, setName] = useState(reservation.customerName);
  const [notes, setNotes] = useState(reservation.specialRequests ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // Addition rapprochée : lue seulement avec le droit pos.connect, absente sans ticket MATCHED.
  const canSeeAddition = useCapabilities()?.['pos.connect'] === true;
  const addition = useReservationAddition(reservation.id, canSeeAddition);
  const validPartySize = Number.isInteger(partySize) && partySize >= 1 && partySize <= 20;
  const dateChanged =
    date !== format(originalDate, 'yyyy-MM-dd') || time !== format(originalDate, 'HH:mm');
  const changes = [
    ...(dateChanged
      ? [
          `Date et heure : ${format(originalDate, 'dd/MM/yyyy HH:mm')} → ${date.split('-').reverse().join('/')} ${time}`,
        ]
      : []),
    ...(validPartySize && partySize !== reservation.partySize
      ? [`Couverts : ${reservation.partySize} → ${partySize}`]
      : []),
    ...(name !== reservation.customerName ? [`Nom : ${reservation.customerName} → ${name}`] : []),
    ...(notes !== (reservation.specialRequests ?? '')
      ? [`Notes : ${reservation.specialRequests || '—'} → ${notes || '—'}`]
      : []),
  ];
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!changes.length || saving || !validPartySize) return;
    const startsAt = new Date(`${date}T${time}:00`);
    if (dateChanged && Number.isNaN(startsAt.getTime())) {
      setError('Veuillez saisir une date et une heure valides.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await post(`reservations/${reservation.id}/staff-modification`, {
        ...(dateChanged ? { startsAt: startsAt.toISOString() } : {}),
        ...(partySize !== reservation.partySize ? { partySize } : {}),
        ...(name !== reservation.customerName ? { customerName: name } : {}),
        ...(notes !== (reservation.specialRequests ?? '')
          ? { specialRequests: notes || null }
          : {}),
      });
      toast.success(
        dateChanged
          ? `Réservation déplacée au ${format(startsAt, 'dd/MM')} à ${format(startsAt, 'HH:mm')}`
          : 'Réservation modifiée.',
      );
      await onSaved();
    } catch (err) {
      setError(getErrorMessage(err, 'Impossible de modifier la réservation.'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        sidePanel
        style={dateTheme}
        className="left-auto right-0 top-0 h-dvh max-h-dvh w-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none sm:rounded-none"
      >
        <DialogTitle>
          Détail de la réservation{' '}
          {reservation.overbooked && <Badge variant="outline">Surbooking</Badge>}
        </DialogTitle>
        <DialogDescription>Informations et modification de la réservation.</DialogDescription>
        {!editing ? (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-2 gap-4">
              <div>
                <dt className="text-muted-foreground">Date et heure</dt>
                <dd>{format(originalDate, 'dd MMMM yyyy · HH:mm', { locale: fr })}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Couverts</dt>
                <dd>{reservation.partySize}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Nom</dt>
                <dd>{reservation.customerName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Téléphone</dt>
                <dd>{reservation.customerPhone ? formatPhone(reservation.customerPhone) : '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Canal</dt>
                <dd>{channelLabel(reservation.channel)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Table</dt>
                <dd>{reservation.table?.name || '—'}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Statut</dt>
                <dd>
                  <StatusBadge status={reservationState(reservation)} />
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Revenu estimé</dt>
                <dd>
                  {reservation.estimatedRevenue != null
                    ? new Intl.NumberFormat('fr-FR', {
                        style: 'currency',
                        currency: 'EUR',
                        maximumFractionDigits: 0,
                      }).format(reservation.estimatedRevenue)
                    : '—'}
                </dd>
              </div>
              <ReservationAdditionLine addition={addition} />
              <div className="col-span-2">
                <dt className="text-muted-foreground">Notes</dt>
                <dd className="whitespace-pre-wrap">{reservation.specialRequests || '—'}</dd>
              </div>
            </dl>
            <ReservationCardGuarantee
              reservation={{
                id: reservation.id,
                reservedAt: reservation.reservedAt,
                state: reservationState(reservation),
              }}
            />
            {(reservationState(reservation) === 'PENDING' ||
              reservationState(reservation) === 'CONFIRMED') && (
              <Button onClick={() => setEditing(true)}>Modifier</Button>
            )}
          </div>
        ) : (
          <form className="space-y-4" onSubmit={save}>
            <div className="space-y-1">
              <span className="text-sm font-medium">Date</span>
              <div>
                <ReservationDatePicker
                  value={date}
                  min="1900-01-01"
                  max="2100-12-31"
                  theme={dateTheme}
                  onChange={setDate}
                />
              </div>
            </div>
            <label className="block space-y-1 text-sm font-medium">
              Heure
              <Input
                type="time"
                step={time === format(originalDate, 'HH:mm') ? 'any' : 900}
                required
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Couverts
              <Input
                type="number"
                min={1}
                max={20}
                required
                value={Number.isNaN(partySize) ? '' : partySize}
                onChange={(e) => setPartySize(e.target.valueAsNumber)}
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Nom
              <Input
                required
                maxLength={200}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="block space-y-1 text-sm font-medium">
              Notes
              <textarea
                className="flex min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={500}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </label>
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-medium">Résumé des changements</p>
              {changes.length ? (
                <ul className="mt-2 space-y-1">
                  {changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-muted-foreground">Aucun changement.</p>
              )}
            </div>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !changes.length || !validPartySize}>
                {saving ? 'Enregistrement…' : 'Enregistrer'}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setEditing(false);
                  setError('');
                }}
              >
                Retour
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'CONFIRMED':
      return <StatusPill level="progress">Confirmée</StatusPill>;
    case 'CANCELLED':
      return <StatusPill level="error">Annulée</StatusPill>;
    case 'SEATED':
      return <StatusPill level="progress">Installée</StatusPill>;
    case 'NO_SHOW':
      return <StatusPill level="error">Absent</StatusPill>;
    case 'HONORED':
      return <StatusPill level="done">Terminée</StatusPill>;
    case 'FAILED':
      return <StatusPill level="error">Échouée</StatusPill>;
    case 'EXPIRED':
      return <StatusPill level="neutral">Expirée</StatusPill>;
    case 'PENDING':
      return <StatusPill level="action">En attente</StatusPill>;
    default:
      return <StatusPill level="neutral">{status}</StatusPill>;
  }
}

function WaitingListStatusBadge({ status }: { status: WaitingListStatus }) {
  switch (status) {
    case 'PENDING':
      return <StatusPill level="action">En attente</StatusPill>;
    case 'PROMOTED':
      return <StatusPill level="progress">Table proposée</StatusPill>;
    case 'CANCELLED':
      return <StatusPill level="error">Annulée</StatusPill>;
    case 'EXPIRED':
      return <StatusPill level="neutral">Expirée</StatusPill>;
    default:
      return <StatusPill level="neutral">{status}</StatusPill>;
  }
}
