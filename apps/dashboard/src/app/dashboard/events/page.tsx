'use client';
import { useSearchParams } from 'next/navigation';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Ticket,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { FeatureLockCard } from '@/components/FeatureLockCard';
import { useApi } from '@/lib/api';
import { featureLockFromError, type FeatureLock } from '@/lib/api-error';
import { getErrorMessage } from '@/types/api';

type EventStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
type SessionStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
type TicketTypeStatus = 'ACTIVE' | 'INACTIVE';
type OrderStatus = 'CONFIRMED' | 'CANCELLED' | 'REFUND_PENDING' | 'REFUNDED';
type TicketStatus = 'ISSUED' | 'CHECKED_IN' | 'CANCELLED' | 'REFUNDED';

type RestaurantEvent = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  timezone: string;
  status: EventStatus;
  sessionCount: number;
  ticketTypeCount: number;
  orderCount: number;
  waitlistCount: number;
};
type Session = {
  id: string;
  eventId: string;
  startsAt: string;
  endsAt: string;
  capacity: number;
  status: SessionStatus;
  event: { key: string; name: string; status: EventStatus };
  orderCount: number;
  ticketCount: number;
  waitlistCount: number;
};
type TicketType = {
  id: string;
  eventId: string;
  key: string;
  name: string;
  priceCents: number;
  currency: string;
  maxPerOrder: number;
  status: TicketTypeStatus;
  orderCount: number;
  ticketCount: number;
};
type Order = {
  id: string;
  eventId: string;
  sessionId: string;
  ticketTypeId: string;
  quantity: number;
  unitPriceCents: number;
  totalPriceCents: number;
  currency: string;
  status: OrderStatus;
  invoiceNumber: string | null;
  invoicedAt: string | null;
  refundedAt: string | null;
  cancelledAt: string | null;
  event: { key: string; name: string };
  session: { startsAt: string; endsAt: string };
  ticketType: { key: string; name: string; priceCents: number; currency: string };
  customerName: string | null;
  phoneLast4: string | null;
  ticketCount: number;
};
type EventTicket = {
  id: string;
  eventId: string;
  sessionId: string;
  orderId: string;
  ticketTypeId: string;
  codeLast4: string;
  status: TicketStatus;
  checkedInAt: string | null;
  event: { key: string; name: string };
  session: { startsAt: string; endsAt: string };
  ticketType: { key: string; name: string };
  customerName: string | null;
  phoneLast4: string | null;
};
type ListResponse<T> = { data?: T[] };
type MutationResponse<T> = { data?: T };

function formatEur(cents: number): string {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}
function generatedKey(value: string, maxLength: number): string {
  return value
    .trim()
    .toLocaleLowerCase('fr-FR')
    .replace(/[œ]/g, 'oe')
    .replace(/[æ]/g, 'ae')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
function euroInputToCents(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!normalized) return null;
  const euros = Number(normalized);
  if (!Number.isFinite(euros) || euros < 0 || euros > 10_000) return null;
  return Math.round(euros * 100);
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
}
function defaultDateTime(offsetHours: number): string {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  date.setMinutes(Math.ceil(date.getMinutes() / 15) * 15, 0, 0);
  // Format attendu par un champ « datetime-local » : l'heure LOCALE, pas l'heure UTC (décalée d'1 à 2 h en France).
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Fuseau de l'événement en clair ; un identifiant technique ne s'affiche jamais. */
function timezoneLabel(timezone: string): string | null {
  return timezone === 'Europe/Paris' ? 'heure de Paris' : null;
}
function statusLabel(
  status: EventStatus | SessionStatus | TicketTypeStatus | OrderStatus | TicketStatus,
): string {
  return {
    DRAFT: 'Brouillon',
    ACTIVE: 'Actif',
    ARCHIVED: 'Archivé',
    OPEN: 'Ouverte',
    CLOSED: 'Fermée',
    CANCELLED: 'Annulée',
    INACTIVE: 'Inactive',
    CONFIRMED: 'Confirmée',
    REFUND_PENDING: 'Remboursement en attente',
    REFUNDED: 'Remboursée',
    ISSUED: 'Émis',
    CHECKED_IN: 'Contrôlé',
  }[status];
}
function statusVariant(
  status: EventStatus | SessionStatus | TicketTypeStatus | OrderStatus | TicketStatus,
): 'default' | 'secondary' | 'destructive' {
  if (
    status === 'ACTIVE' ||
    status === 'OPEN' ||
    status === 'CONFIRMED' ||
    status === 'ISSUED' ||
    status === 'CHECKED_IN'
  )
    return 'default';
  // Un brouillon ou une dernière étape à faire n'est pas une erreur : seul un remboursement en attente alerte.
  if (status === 'REFUND_PENDING') return 'destructive';
  return 'secondary';
}

export default function EventsPage() {
  const createRequested = useSearchParams().get('create') === '1';
  const { get, post, patch } = useApi();
  const [events, setEvents] = useState<RestaurantEvent[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [ticketTypes, setTicketTypes] = useState<TicketType[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [tickets, setTickets] = useState<EventTicket[]>([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [loading, setLoading] = useState(true);
  const [dataLoaded, setDataLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Module hors formule ou pas encore ouvert : un état normal, sans « Réessayer ».
  const [lock, setLock] = useState<FeatureLock | null>(null);
  const [notice, setNotice] = useState('');
  const [eventDialogOpen, setEventDialogOpen] = useState(false);
  const [dateDialogOpen, setDateDialogOpen] = useState(false);
  const [ticketDialogOpen, setTicketDialogOpen] = useState(false);
  const [ticketCodes, setTicketCodes] = useState<string[]>([]);
  const [checkInCode, setCheckInCode] = useState('');
  const [eventForm, setEventForm] = useState({ name: '' });
  const [sessionForm, setSessionForm] = useState({
    startsAt: defaultDateTime(48),
    endsAt: defaultDateTime(51),
    capacity: '40',
  });
  const [ticketForm, setTicketForm] = useState({
    name: '',
    priceEuros: '0',
    maxPerOrder: '10',
  });
  const [orderForm, setOrderForm] = useState({
    sessionId: '',
    ticketTypeId: '',
    customerId: '',
    quantity: '1',
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setLock(null);
    try {
      const eventResponse = await get<ListResponse<RestaurantEvent>>('events?limit=100');
      const nextEvents = Array.isArray(eventResponse.data) ? eventResponse.data : [];
      setEvents(nextEvents);
      const nextSelected =
        selectedEventId && nextEvents.some((item) => item.id === selectedEventId)
          ? selectedEventId
          : (nextEvents.find((item) => item.status === 'ACTIVE')?.id ?? nextEvents[0]?.id ?? '');
      setSelectedEventId(nextSelected);
      if (nextSelected) {
        // Commandes et billets de l'événement choisi seulement : filtrés par le serveur, ils ne sont plus
        // noyés parmi les 100 plus récents de tout le restaurant.
        const [orderResponse, ticketResponse, sessionResponse, ticketTypeResponse] =
          await Promise.all([
            get<ListResponse<Order>>(`event-orders?eventId=${nextSelected}&limit=100`),
            get<ListResponse<EventTicket>>(`event-tickets?eventId=${nextSelected}&limit=100`),
            get<ListResponse<Session>>(`events/${nextSelected}/sessions?limit=100`),
            get<ListResponse<TicketType>>(`events/${nextSelected}/ticket-types?limit=100`),
          ]);
        setOrders(Array.isArray(orderResponse.data) ? orderResponse.data : []);
        setTickets(Array.isArray(ticketResponse.data) ? ticketResponse.data : []);
        setSessions(Array.isArray(sessionResponse.data) ? sessionResponse.data : []);
        setTicketTypes(Array.isArray(ticketTypeResponse.data) ? ticketTypeResponse.data : []);
      } else {
        setOrders([]);
        setTickets([]);
        setSessions([]);
        setTicketTypes([]);
      }
    } catch (err: unknown) {
      const locked = featureLockFromError(err);
      if (locked) setLock(locked);
      else setError(getErrorMessage(err, 'Impossible de charger les événements.'));
      setEvents([]);
      setSessions([]);
      setTicketTypes([]);
      setOrders([]);
      setTickets([]);
    } finally {
      setLoading(false);
      setDataLoaded(true);
    }
  }, [get, selectedEventId]);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined' || loading || !dataLoaded || error) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('create') !== '1') return;
    url.searchParams.delete('create');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    setEventForm({ name: '' });
    setEventDialogOpen(true);
  }, [createRequested, dataLoaded, error, loading]);

  const selectedEvent = events.find((item) => item.id === selectedEventId) ?? null;
  const selectedOrders = useMemo(
    () => orders.filter((item) => item.eventId === selectedEventId),
    [orders, selectedEventId],
  );
  const selectedTickets = useMemo(
    () => tickets.filter((item) => item.eventId === selectedEventId),
    [tickets, selectedEventId],
  );
  const metrics = useMemo(
    () => ({
      active: events.filter((item) => item.status === 'ACTIVE').length,
      openDates: sessions.filter((item) => item.status === 'OPEN').length,
      confirmed: selectedOrders.filter((item) => item.status === 'CONFIRMED').length,
      checkedIn: selectedTickets.filter((item) => item.status === 'CHECKED_IN').length,
    }),
    [events, selectedOrders, selectedTickets, sessions],
  );
  const nextStep = !selectedEvent
    ? null
    : sessions.length === 0
      ? 'date'
      : ticketTypes.length === 0
        ? 'ticket'
        : selectedEvent.status === 'DRAFT'
          ? 'activate'
          : null;

  function openEventCreation() {
    setEventForm({ name: '' });
    setError('');
    setNotice('');
    setEventDialogOpen(true);
  }

  function openDateCreation() {
    setSessionForm({
      startsAt: defaultDateTime(48),
      endsAt: defaultDateTime(51),
      capacity: '40',
    });
    setError('');
    setDateDialogOpen(true);
  }

  function openTicketCreation() {
    setTicketForm({ name: '', priceEuros: '0', maxPerOrder: '10' });
    setError('');
    setTicketDialogOpen(true);
  }

  async function createEvent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = eventForm.name.trim();
    const key = generatedKey(name, 64);
    if (key.length < 2) {
      setError('Le nom doit contenir au moins deux lettres ou chiffres.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await post<MutationResponse<RestaurantEvent>>('events', { key, name });
      if (response.data) {
        setEvents((current) => [response.data!, ...current]);
        setSelectedEventId(response.data.id);
      }
      setEventForm({ name: '' });
      setEventDialogOpen(false);
      setNotice('Événement créé. Ajoutez maintenant une première date.');
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de créer l’événement'));
    } finally {
      setBusy(false);
    }
  }
  async function createSession(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEventId) return;
    setBusy(true);
    setError('');
    try {
      await post(`events/${selectedEventId}/sessions`, {
        startsAt: new Date(sessionForm.startsAt).toISOString(),
        endsAt: new Date(sessionForm.endsAt).toISOString(),
        capacity: Number(sessionForm.capacity),
      });
      setDateDialogOpen(false);
      setNotice('Date ajoutée.');
      await load();
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible d’ajouter la date'));
    } finally {
      setBusy(false);
    }
  }
  async function createTicketType(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEventId) return;
    const name = ticketForm.name.trim();
    const key = generatedKey(name, 48);
    const priceCents = euroInputToCents(ticketForm.priceEuros);
    if (key.length < 2) {
      setError('Le nom du tarif doit contenir au moins deux lettres ou chiffres.');
      return;
    }
    if (priceCents === null) {
      setError('Saisissez un prix valide compris entre 0 € et 10 000 €.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await post(`events/${selectedEventId}/ticket-types`, {
        key,
        name,
        priceCents,
        maxPerOrder: Number(ticketForm.maxPerOrder),
      });
      setTicketForm({ name: '', priceEuros: '0', maxPerOrder: '10' });
      setTicketDialogOpen(false);
      setNotice('Tarif ajouté.');
      await load();
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de créer le tarif'));
    } finally {
      setBusy(false);
    }
  }
  async function issueOrder(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedEventId || !orderForm.sessionId || !orderForm.ticketTypeId) return;
    setBusy(true);
    setError('');
    setTicketCodes([]);
    try {
      const response = await post<MutationResponse<Order & { ticketCodes?: string[] | null }>>(
        `events/${selectedEventId}/sessions/${orderForm.sessionId}/orders`,
        {
          ticketTypeId: orderForm.ticketTypeId,
          customerId: orderForm.customerId || undefined,
          quantity: Number(orderForm.quantity),
        },
        { headers: { 'Idempotency-Key': `dashboard-event-${Date.now()}` } },
      );
      if (response.data?.ticketCodes) setTicketCodes(response.data.ticketCodes);
      setNotice('Commande enregistrée. Conservez les codes billet affichés une seule fois.');
      await load();
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible d’enregistrer la commande'));
    } finally {
      setBusy(false);
    }
  }
  async function toggleEvent() {
    if (!selectedEvent) return;
    setBusy(true);
    setError('');
    try {
      await patch(`events/${selectedEvent.id}`, {
        status: selectedEvent.status === 'ACTIVE' ? 'DRAFT' : 'ACTIVE',
      });
      await load();
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de changer le statut'));
    } finally {
      setBusy(false);
    }
  }
  async function checkIn(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await post('event-tickets/check-in', { code: checkInCode });
      setCheckInCode('');
      setNotice('Billet contrôlé.');
      await load();
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Code billet refusé'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 p-6 md:p-8">
      <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Événements</h1>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              Pro
            </Badge>
          </div>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Organisez des soirées, menus spéciaux et événements à jauge limitée. Gérez plusieurs
            tarifs et contrôlez les billets à l’entrée.
          </p>
        </div>
        {lock ? null : (
          <Button onClick={openEventCreation} disabled={loading || busy}>
            <Plus className="mr-2 h-4 w-4" />
            Créer un événement
          </Button>
        )}
      </header>

      <Card className="bg-muted/30">
        <CardContent className="flex items-center gap-3 p-4">
          <ShieldAlert className="h-5 w-5 shrink-0 text-muted-foreground" />
          <Badge variant="outline" className="shrink-0 font-normal">
            Phase pilote
          </Badge>
          <p className="text-sm text-muted-foreground">
            Le paiement et la vente en ligne seront disponibles prochainement.
          </p>
        </CardContent>
      </Card>

      {lock && <FeatureLockCard lock={lock} feature="Événements" />}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <span className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="transition-all duration-200"
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            Réessayer
          </Button>
        </div>
      )}
      {notice && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-foreground"
        >
          <CheckCircle2 className="mt-0.5 h-4 w-4 text-primary" />
          <span>{notice}</span>
        </div>
      )}

      {loading && !dataLoaded ? (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : lock || (error && events.length === 0) ? null : events.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-[360px] flex-col items-center justify-center px-6 py-12 text-center">
            <div className="mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <CalendarDays className="h-7 w-7" />
            </div>
            <h2 className="text-xl font-semibold">Créez votre premier événement</h2>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Soirée dégustation, dîner spécial, concert ou brunch événementiel…
            </p>
            <p className="mt-1 max-w-xl text-sm text-muted-foreground">
              Ajoutez des dates, proposez plusieurs tarifs et gérez les billets à l’entrée.
            </p>
            <Button className="mt-6" onClick={openEventCreation} disabled={busy}>
              <Plus className="mr-2 h-4 w-4" />
              Créer un événement
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ['Événements actifs', metrics.active],
              ['Dates ouvertes', metrics.openDates],
              ['Commandes confirmées', metrics.confirmed],
              ['Billets contrôlés', metrics.checkedIn],
            ].map(([label, value]) => (
              <Card key={label as string}>
                <CardContent className="p-4">
                  <p className="text-sm text-muted-foreground">{label}</p>
                  <p className="mt-2 text-2xl font-semibold">{value}</p>
                </CardContent>
              </Card>
            ))}
          </div>
          <p className="-mt-3 text-xs text-muted-foreground">
            Les dates, commandes et billets concernent l’événement sélectionné.
          </p>
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Vos événements</CardTitle>
                <CardDescription>
                  Sélectionnez un événement pour gérer ses dates, ses tarifs et ses billets.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {events.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => setSelectedEventId(item.id)}
                    aria-pressed={item.id === selectedEventId}
                    className={`w-full rounded-lg border p-3 text-left transition-all duration-200 ${item.id === selectedEventId ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{item.name}</span>
                      <Badge variant={statusVariant(item.status)}>{statusLabel(item.status)}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.sessionCount} date{item.sessionCount === 1 ? '' : 's'} ·{' '}
                      {item.ticketTypeCount} tarif{item.ticketTypeCount === 1 ? '' : 's'} ·{' '}
                      {item.orderCount} commande{item.orderCount === 1 ? '' : 's'}
                    </p>
                  </button>
                ))}
              </CardContent>
            </Card>
            <div className="space-y-6">
              {selectedEvent ? (
                <>
                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle>{selectedEvent.name}</CardTitle>
                        <CardDescription>
                          {sessions.length} date{sessions.length === 1 ? '' : 's'} ·{' '}
                          {ticketTypes.length} tarif{ticketTypes.length === 1 ? '' : 's'}
                          {timezoneLabel(selectedEvent.timezone)
                            ? ` · ${timezoneLabel(selectedEvent.timezone)}`
                            : ''}
                        </CardDescription>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => void toggleEvent()}
                        disabled={
                          busy ||
                          (selectedEvent.status !== 'ACTIVE' &&
                            (sessions.length === 0 || ticketTypes.length === 0))
                        }
                      >
                        {selectedEvent.status === 'ACTIVE'
                          ? 'Mettre en brouillon'
                          : 'Activer l’événement'}
                      </Button>
                    </CardHeader>
                    <CardContent>
                      <Badge variant={statusVariant(selectedEvent.status)}>
                        {statusLabel(selectedEvent.status)}
                      </Badge>
                    </CardContent>
                  </Card>
                  {nextStep && (
                    <Card className="border-primary/20 bg-muted/20">
                      <CardContent className="flex flex-col justify-between gap-4 p-5 sm:flex-row sm:items-center">
                        <div>
                          <p className="font-medium">
                            {nextStep === 'activate' ? 'Prêt à être activé' : 'Prochaine étape'}
                          </p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {nextStep === 'date'
                              ? 'Ajoutez une première date avant de définir les tarifs.'
                              : nextStep === 'ticket'
                                ? 'Définissez un premier tarif pour préparer la billetterie.'
                                : 'Les dates et les tarifs sont prêts pour votre événement.'}
                          </p>
                        </div>
                        <Button
                          onClick={() => {
                            if (nextStep === 'date') openDateCreation();
                            else if (nextStep === 'ticket') openTicketCreation();
                            else void toggleEvent();
                          }}
                          disabled={busy}
                          className="shrink-0"
                        >
                          {nextStep === 'activate' ? (
                            <CheckCircle2 className="mr-2 h-4 w-4" />
                          ) : (
                            <Plus className="mr-2 h-4 w-4" />
                          )}
                          {nextStep === 'date'
                            ? 'Ajouter une date'
                            : nextStep === 'ticket'
                              ? 'Ajouter un tarif'
                              : 'Activer l’événement'}
                        </Button>
                      </CardContent>
                    </Card>
                  )}

                  <Card>
                    <CardHeader className="flex flex-row items-start justify-between gap-3">
                      <div>
                        <CardTitle>Prochaines dates</CardTitle>
                        <CardDescription>
                          Choisissez les horaires et le nombre de places.
                        </CardDescription>
                      </div>
                      <Button
                        variant="outline"
                        onClick={openDateCreation}
                        disabled={busy}
                        className="shrink-0"
                      >
                        <Plus className="mr-2 h-4 w-4" />
                        Ajouter une date
                      </Button>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {sessions.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Aucune date ajoutée.</p>
                      ) : (
                        sessions.map((item) => (
                          <div
                            key={item.id}
                            className="rounded-lg border border-border p-3 text-sm"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="font-medium">{formatDate(item.startsAt)}</span>
                              <Badge variant={statusVariant(item.status)}>
                                {statusLabel(item.status)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {item.capacity} places · {item.ticketCount} billet
                              {item.ticketCount === 1 ? '' : 's'} émis
                            </p>
                          </div>
                        ))
                      )}
                    </CardContent>
                  </Card>

                  {sessions.length > 0 && (
                    <Card>
                      <CardHeader className="flex flex-row items-start justify-between gap-3">
                        <div>
                          <CardTitle>Tarifs des billets</CardTitle>
                          <CardDescription>
                            Proposez plusieurs tarifs, par exemple Standard, Enfant ou VIP.
                          </CardDescription>
                        </div>
                        <Button
                          variant="outline"
                          onClick={openTicketCreation}
                          disabled={busy}
                          className="shrink-0"
                        >
                          <Plus className="mr-2 h-4 w-4" />
                          Ajouter un tarif
                        </Button>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {ticketTypes.length === 0 ? (
                          <p className="text-sm text-muted-foreground">Aucun tarif ajouté.</p>
                        ) : (
                          ticketTypes.map((item) => (
                            <div
                              key={item.id}
                              className="rounded-lg border border-border p-3 text-sm"
                            >
                              <div className="flex justify-between gap-2">
                                <span className="font-medium">{item.name}</span>
                                <span>{formatEur(item.priceCents)}</span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.ticketCount} billet{item.ticketCount === 1 ? '' : 's'} émis ·{' '}
                                {item.maxPerOrder} maximum par commande
                              </p>
                            </div>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  )}
                  {sessions.length > 0 &&
                    ticketTypes.length > 0 &&
                    selectedEvent.status === 'ACTIVE' && (
                      <Card>
                        <CardHeader>
                          <CardTitle>Enregistrer une commande</CardTitle>
                          <CardDescription>
                            Créez une commande au comptoir et remettez les billets au participant.
                          </CardDescription>
                        </CardHeader>
                        <CardContent>
                          <form className="grid gap-3 md:grid-cols-4" onSubmit={issueOrder}>
                            <div>
                              <Label htmlFor="order-session">Date</Label>
                              <select
                                id="order-session"
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                value={orderForm.sessionId}
                                onChange={(e) =>
                                  setOrderForm({ ...orderForm, sessionId: e.target.value })
                                }
                                required
                              >
                                <option value="">Choisir</option>
                                {sessions
                                  .filter((item) => item.status === 'OPEN')
                                  .map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {formatDate(item.startsAt)}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div>
                              <Label htmlFor="order-type">Tarif</Label>
                              <select
                                id="order-type"
                                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                                value={orderForm.ticketTypeId}
                                onChange={(e) =>
                                  setOrderForm({ ...orderForm, ticketTypeId: e.target.value })
                                }
                                required
                              >
                                <option value="">Choisir</option>
                                {ticketTypes
                                  .filter((item) => item.status === 'ACTIVE')
                                  .map((item) => (
                                    <option key={item.id} value={item.id}>
                                      {item.name} · {formatEur(item.priceCents)}
                                    </option>
                                  ))}
                              </select>
                            </div>
                            <div>
                              <Label htmlFor="order-quantity">Quantité</Label>
                              <Input
                                id="order-quantity"
                                type="number"
                                min="1"
                                max="100"
                                value={orderForm.quantity}
                                onChange={(e) =>
                                  setOrderForm({ ...orderForm, quantity: e.target.value })
                                }
                                required
                              />
                            </div>
                            <div className="flex items-end">
                              <Button type="submit" disabled={busy} className="w-full">
                                <Ticket className="mr-2 h-4 w-4" />
                                Créer la commande
                              </Button>
                            </div>
                          </form>
                          {ticketCodes.length > 0 && (
                            <div
                              role="status"
                              className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-3 text-sm"
                            >
                              <p className="font-medium">Billets à remettre au participant</p>
                              <code className="mt-2 block break-all text-xs">
                                {ticketCodes.join(' · ')}
                              </code>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    )}
                  {selectedTickets.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Contrôler les billets</CardTitle>
                        <CardDescription>
                          Scannez ou saisissez le code présenté à l’entrée.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <form className="flex gap-2" onSubmit={checkIn}>
                          <Input
                            value={checkInCode}
                            onChange={(e) => setCheckInCode(e.target.value)}
                            placeholder="Code du billet"
                            minLength={12}
                            maxLength={64}
                            required
                          />
                          <Button type="submit" disabled={busy}>
                            Contrôler
                          </Button>
                        </form>
                        <div className="mt-4 space-y-2">
                          {selectedTickets.slice(0, 20).map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between rounded-lg border border-border p-3 text-sm"
                            >
                              <span>
                                <span className="font-medium">••••{item.codeLast4}</span>
                                <span className="ml-2 text-muted-foreground">
                                  {item.ticketType.name}
                                </span>
                              </span>
                              <Badge variant={statusVariant(item.status)}>
                                {statusLabel(item.status)}
                              </Badge>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                  {selectedOrders.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>Historique des commandes</CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-2">
                        {selectedOrders.slice(0, 20).map((item) => (
                          <div
                            key={item.id}
                            className="rounded-lg border border-border p-3 text-sm"
                          >
                            <div className="flex justify-between gap-2">
                              <span>
                                {item.customerName ?? 'Participant'} · {item.ticketType.name} ·{' '}
                                {item.quantity}
                              </span>
                              <Badge variant={statusVariant(item.status)}>
                                {statusLabel(item.status)}
                              </Badge>
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {formatEur(item.totalPriceCents)} · {item.ticketCount} billet
                              {item.ticketCount === 1 ? '' : 's'}
                            </p>
                          </div>
                        ))}
                      </CardContent>
                    </Card>
                  )}
                </>
              ) : (
                <Card>
                  <CardContent className="flex min-h-[180px] items-center gap-3 p-6 text-sm text-muted-foreground">
                    <CalendarDays className="h-5 w-5 shrink-0" aria-hidden="true" />
                    Sélectionnez un événement pour gérer ses dates et sa billetterie.
                  </CardContent>
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      <Dialog
        open={eventDialogOpen}
        onOpenChange={(open) => {
          if (!busy) {
            setEventDialogOpen(open);
            if (!open) setError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nouvel événement</DialogTitle>
            <DialogDescription>
              Donnez un nom à votre événement. Vous ajouterez ses dates puis ses tarifs.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-5" onSubmit={createEvent}>
            <div className="space-y-2">
              <Label htmlFor="event-name">Nom de l’événement</Label>
              <Input
                id="event-name"
                value={eventForm.name}
                onChange={(event) => setEventForm({ name: event.target.value })}
                placeholder="Soirée dégustation"
                maxLength={160}
                required
              />
            </div>
            {eventDialogOpen && error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setEventDialogOpen(false)}
                disabled={busy}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={busy || !eventForm.name.trim()}>
                {busy ? 'Création…' : 'Créer l’événement'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dateDialogOpen}
        onOpenChange={(open) => {
          if (!busy) {
            setDateDialogOpen(open);
            if (!open) setError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Ajouter une date</DialogTitle>
            <DialogDescription>
              Choisissez les horaires et le nombre de places disponibles.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={createSession}>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event-start">Début</Label>
                <Input
                  id="event-start"
                  type="datetime-local"
                  value={sessionForm.startsAt}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, startsAt: event.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event-end">Fin</Label>
                <Input
                  id="event-end"
                  type="datetime-local"
                  value={sessionForm.endsAt}
                  onChange={(event) =>
                    setSessionForm({ ...sessionForm, endsAt: event.target.value })
                  }
                  required
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="event-capacity">Nombre de places</Label>
              <Input
                id="event-capacity"
                type="number"
                min="1"
                max="10000"
                value={sessionForm.capacity}
                onChange={(event) =>
                  setSessionForm({ ...sessionForm, capacity: event.target.value })
                }
                required
              />
            </div>
            {dateDialogOpen && error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setDateDialogOpen(false)}
                disabled={busy}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Enregistrement…' : 'Ajouter la date'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={ticketDialogOpen}
        onOpenChange={(open) => {
          if (!busy) {
            setTicketDialogOpen(open);
            if (!open) setError('');
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Nouveau tarif</DialogTitle>
            <DialogDescription>
              Créez une catégorie de billet, par exemple Standard, Enfant ou VIP.
            </DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={createTicketType}>
            <div className="space-y-2">
              <Label htmlFor="ticket-name">Nom du tarif</Label>
              <Input
                id="ticket-name"
                value={ticketForm.name}
                onChange={(event) => setTicketForm({ ...ticketForm, name: event.target.value })}
                placeholder="Entrée standard"
                maxLength={120}
                required
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ticket-price">Prix du billet</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="ticket-price"
                    type="text"
                    inputMode="decimal"
                    value={ticketForm.priceEuros}
                    onChange={(event) =>
                      setTicketForm({ ...ticketForm, priceEuros: event.target.value })
                    }
                    placeholder="25,00"
                    required
                  />
                  <span className="text-sm text-muted-foreground">€</span>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="ticket-max">Maximum par commande</Label>
                <Input
                  id="ticket-max"
                  type="number"
                  min="1"
                  max="100"
                  value={ticketForm.maxPerOrder}
                  onChange={(event) =>
                    setTicketForm({ ...ticketForm, maxPerOrder: event.target.value })
                  }
                  required
                />
              </div>
            </div>
            {ticketDialogOpen && error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setTicketDialogOpen(false)}
                disabled={busy}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Enregistrement…' : 'Ajouter le tarif'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
