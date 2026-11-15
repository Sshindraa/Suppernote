'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Phone,
  Check,
  Loader2,
  MessageCircle,
  CircleDashed,
  CircleX,
  ChevronDown,
  MapPin,
  CalendarPlus,
  Navigation,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { SuppernoteLogo } from '@/components/SuppernoteLogo';
import { cn } from '@/lib/utils';
import styles from './reservation-view.module.css';
import { ReservationModification } from './reservation-modification';
import { createReservationDemo } from './reservation-demo';

export type Reservation = {
  restaurantName: string;
  restaurantPhone: string | null;
  restaurantAddress?: string | null;
  startsAt?: string;
  endsAt?: string | null;
  date: string;
  time: string;
  partySize: number;
  state: string;
  test?: boolean;
  cancellation?: {
    available: boolean;
    deadline: string | null;
    message: string;
    terms?: string;
    confirmationToken?: string;
  };
  modification?: { available: boolean; message: string; maxDate?: string };
  whatsappReminder: { visible: boolean; enabled: boolean };
};
const STATES: Record<string, string> = {
  CONFIRMED: 'Confirmée',
  PENDING: 'En attente',
  CANCELLED: 'Annulée',
  SEATED: 'Sur place',
  HONORED: 'Terminée',
  NO_SHOW: 'Absence enregistrée',
  EXPIRED: 'Expirée',
  FAILED: 'Non confirmée',
};

export default function ReservationView({
  demo = false,
  confirmation,
  actions,
  notice,
  footer,
}: {
  demo?: boolean;
  confirmation?: {
    reservation: Reservation;
    managementUrl?: string;
    withdrawWhatsapp?: () => Promise<void>;
  };
  actions?: ReactNode;
  /** Ligne sous les cartons : comment la confirmation arrive. */
  notice?: ReactNode;
  /** Bloc sous « Modifier ou annuler » (carte cadeau après une réservation). */
  footer?: ReactNode;
}) {
  const token = useRef('');
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [withdrawn, setWithdrawn] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const cancelInFlight = useRef(false);

  const demoSession = useRef<ReturnType<typeof createReservationDemo> | null>(null);
  const demoRequest = useCallback(async (body: Record<string, unknown>) => {
    demoSession.current ??= createReservationDemo();
    return demoSession.current(body);
  }, []);
  const request = useCallback(
    async (action: 'view' | 'withdraw_whatsapp' | 'cancel', confirmationToken?: string) => {
      if (demo)
        return (await demoRequest({
          action,
          confirmationToken,
          confirmed: action === 'cancel',
        })) as Reservation;
      const response = await fetch('/api/reservation-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: token.current,
          action,
          ...(action === 'cancel' ? { confirmed: true, confirmationToken } : {}),
        }),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new Error(
          response.status === 404
            ? 'Ce lien est invalide ou a expiré.'
            : 'La demande n’a pas pu être confirmée. Veuillez réessayer.',
        );
      return (await response.json()) as Reservation;
    },
    [demo, demoRequest],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    setReservation(null);
    setWithdrawn(false);
    setCancelOpen(false);
    setCancelError('');
    setBusy(false);
    token.current = confirmation
      ? (confirmation.managementUrl?.split('#')[1] ?? '')
      : window.location.hash.slice(1);
    if (confirmation) {
      setReservation(confirmation.reservation);
      setLoading(false);
      if (!/^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/.test(token.current)) {
        token.current = '';
        return;
      }
    }
    const currentToken = token.current;
    if (!demo && !/^[A-Za-z0-9_-]{27}\.[A-Za-z0-9_-]{43}$/.test(token.current)) {
      setError('Ouvrez le lien personnel reçu avec votre confirmation.');
      setLoading(false);
      return;
    }
    try {
      const current = await request('view');
      if (currentToken === token.current) setReservation(current);
    } catch (e) {
      if (currentToken === token.current)
        setError(e instanceof Error ? e.message : 'Service indisponible.');
    } finally {
      if (currentToken === token.current) setLoading(false);
    }
  }, [request, demo, confirmation]);

  useEffect(() => {
    void load();
    window.addEventListener('hashchange', load);
    return () => window.removeEventListener('hashchange', load);
  }, [load]);

  async function withdraw() {
    if (!reservation?.whatsappReminder.enabled || busy) return;
    setBusy(true);
    setError('');
    const currentToken = token.current;
    try {
      const current =
        confirmation?.withdrawWhatsapp && !token.current
          ? await confirmation.withdrawWhatsapp().then(() => ({
              ...reservation,
              whatsappReminder: { visible: true, enabled: false },
            }))
          : await request('withdraw_whatsapp');
      if (currentToken === token.current) {
        setReservation(current);
        setWithdrawn(true);
      }
    } catch {
      if (currentToken === token.current)
        setError('Le retrait n’a pas pu être confirmé. Veuillez réessayer.');
    } finally {
      if (currentToken === token.current) setBusy(false);
    }
  }

  async function cancelReservation() {
    const offer = reservation?.cancellation;
    if (cancelInFlight.current || busy || !offer?.available || !offer.confirmationToken) return;
    cancelInFlight.current = true;
    setBusy(true);
    setCancelError('');
    const currentToken = token.current;
    try {
      const current = await request('cancel', offer.confirmationToken);
      if (currentToken === token.current) {
        setReservation(current);
        setCancelOpen(false);
      }
    } catch {
      // A timeout can happen after the commit: read the actual state before offering a retry.
      try {
        const current = await request('view');
        if (currentToken === token.current) {
          setReservation(current);
          if (current.state === 'CANCELLED') setCancelOpen(false);
          else
            setCancelError(
              'L’annulation n’a pas été confirmée. Vérifiez les conditions puis réessayez.',
            );
        }
      } catch {
        if (currentToken === token.current)
          setCancelError(
            'Impossible de vérifier l’annulation. Vérifiez votre connexion puis rouvrez ce lien avant de réessayer.',
          );
      }
    } finally {
      cancelInFlight.current = false;
      if (currentToken === token.current) setBusy(false);
    }
  }

  function addToCalendar() {
    if (!reservation?.startsAt || !confirmed) return;
    const escape = (value: string) =>
      value.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, '\\$&');
    const stamp = (value: string) =>
      new Date(value)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}/, '');
    const content = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Suppernote//Reservation//FR',
      'BEGIN:VEVENT',
      `UID:${crypto.randomUUID()}@suppernote.com`,
      `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(reservation.startsAt)}`,
      ...(reservation.endsAt ? [`DTEND:${stamp(reservation.endsAt)}`] : []),
      `SUMMARY:${escape(`${demo ? '[Démonstration] ' : ''}Table chez ${reservation.restaurantName}`)}`,
      `DESCRIPTION:${escape(`Réservation pour ${reservation.partySize} ${reservation.partySize === 1 ? 'personne' : 'personnes'}.`)}`,
      ...(reservation.restaurantAddress
        ? [`LOCATION:${escape(reservation.restaurantAddress)}`]
        : []),
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ].join('\r\n');
    const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = demo ? 'reservation-demo.ics' : 'reservation.ics';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const bookingDate = reservation ? new Date(`${reservation.date}T12:00:00Z`) : null;
  const confirmed = reservation?.state === 'CONFIRMED';
  const renderedToken = token.current;
  const terminal = ['CANCELLED', 'EXPIRED', 'FAILED', 'NO_SHOW'].includes(reservation?.state ?? '');
  const StatusIcon = confirmed ? Check : terminal ? CircleX : CircleDashed;

  return (
    <main className={cn(styles.page, 'min-h-screen bg-background text-foreground')}>
      <div className={styles.shell}>
        <header className={styles.navigation}>
          <div className="flex items-center gap-2">
            <SuppernoteLogo className="h-5 w-5 text-foreground" />
            <span className="font-serif text-xl">Suppernote</span>
          </div>
          <h1 className="sr-only">Ma réservation</h1>
          {demo && <p className={styles.demo}>Aperçu de démonstration</p>}
          {reservation?.test && (
            <p className={styles.demo}>Réservation test · supprimée automatiquement sous 24 h</p>
          )}
        </header>
        {loading ? (
          <div
            role="status"
            className="flex min-h-80 items-center justify-center gap-3 text-muted-foreground"
          >
            <Loader2 className="h-5 w-5 animate-spin" /> Chargement de la réservation…
          </div>
        ) : reservation ? (
          <>
            <section aria-label="Détails de la réservation" className={styles.booking}>
              <p role="status" data-terminal={terminal} className={styles.status}>
                <StatusIcon className="h-3.5 w-3.5" aria-hidden="true" />
                {confirmed ? 'Confirmée' : (STATES[reservation.state] ?? 'Enregistrée')}
              </p>
              <h2 className={styles.restaurant}>{reservation.restaurantName}</h2>
              {reservation.restaurantAddress && (
                <p className={styles.address}>
                  <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {reservation.restaurantAddress}
                </p>
              )}
              <dl className={styles.fan}>
                <div className={cn(styles.ticket, styles.dateTicket)}>
                  <dt className="sr-only">Date</dt>
                  <dd className={styles.ticketBody}>
                    <span className={styles.weekday}>
                      {bookingDate &&
                        new Intl.DateTimeFormat('fr-FR', {
                          weekday: 'long',
                          timeZone: 'UTC',
                        }).format(bookingDate)}
                    </span>
                    <span className={styles.largeNumber}>{bookingDate?.getUTCDate()}</span>
                    <span className={styles.ticketCaption}>
                      {bookingDate &&
                        new Intl.DateTimeFormat('fr-FR', { month: 'long', timeZone: 'UTC' }).format(
                          bookingDate,
                        )}{' '}
                      {bookingDate?.getUTCFullYear()}
                    </span>
                  </dd>
                </div>
                <div className={cn(styles.ticket, styles.timeTicket)}>
                  <dt className="sr-only">Heure</dt>
                  <dd className={styles.ticketBody}>
                    <span className={styles.timeNumber}>{reservation.time.replace(':', 'h')}</span>
                  </dd>
                </div>
                <div className={cn(styles.ticket, styles.guestsTicket)}>
                  <dt className="sr-only">Couverts</dt>
                  <dd className={styles.ticketBody}>
                    <span className={styles.largeNumber}>{reservation.partySize}</span>
                    <span className={styles.ticketCaption}>
                      {reservation.partySize === 1 ? 'personne' : 'personnes'}
                    </span>
                  </dd>
                </div>
              </dl>
              {notice && <p className={styles.notice}>{notice}</p>}
              <div className={styles.primaryActions}>
                {confirmed && reservation.startsAt && (
                  <Button
                    onClick={addToCalendar}
                    className="min-h-11 rounded-full px-5 transition-all duration-200"
                  >
                    <CalendarPlus className="h-3.5 w-3.5" aria-hidden="true" />
                    Ajouter au calendrier
                  </Button>
                )}
                {reservation.restaurantAddress &&
                  (demo ? (
                    <Button
                      disabled
                      variant="link"
                      title="Indisponible dans la démonstration"
                      className={cn(styles.directions, 'min-h-11 transition-all duration-200')}
                    >
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
                      Itinéraire
                    </Button>
                  ) : (
                    <Button
                      asChild
                      variant="link"
                      className={cn(styles.directions, 'min-h-11 transition-all duration-200')}
                    >
                      <a
                        href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${reservation.restaurantName}, ${reservation.restaurantAddress}`)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                      >
                        <Navigation className="h-3.5 w-3.5" aria-hidden="true" />
                        Itinéraire
                      </a>
                    </Button>
                  ))}
                {actions}
              </div>
            </section>
            <details className={styles.management}>
              <summary className={cn(styles.managementToggle, 'transition-all duration-200')}>
                Modifier ou annuler
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
              </summary>
              <div className={styles.details}>
                {reservation.modification?.available && !terminal && (
                  <ReservationModification
                    key={renderedToken}
                    booking={reservation}
                    token={renderedToken}
                    demoRequest={demo ? demoRequest : undefined}
                    disabled={busy}
                    terms={reservation.cancellation?.terms}
                    onCancelRequest={() => {
                      if (token.current === renderedToken) {
                        setCancelError('');
                        setCancelOpen(true);
                      }
                    }}
                    onUpdated={(updated) => {
                      if (token.current === renderedToken) setReservation(updated);
                    }}
                  />
                )}
                {reservation.cancellation && !terminal && (
                  <section
                    aria-label="Conditions d’annulation"
                    className="space-y-2 text-xs leading-relaxed"
                  >
                    {reservation.cancellation.terms && <p>{reservation.cancellation.terms}</p>}
                    <p className="text-muted-foreground">{reservation.cancellation.message}</p>
                    {reservation.cancellation.available && (
                      <Button
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setCancelError('');
                          setCancelOpen(true);
                        }}
                        className="min-h-11 rounded-none border-0 bg-transparent px-0 text-xs font-normal text-foreground/80 underline decoration-foreground/30 underline-offset-4 shadow-none transition-all duration-200 hover:bg-transparent hover:text-foreground hover:decoration-foreground/70"
                      >
                        Annuler la réservation
                      </Button>
                    )}
                  </section>
                )}
                <section className={styles.contactGroup}>
                  {!reservation.modification?.available &&
                    (demo ? (
                      <button
                        type="button"
                        disabled
                        title="Indisponible dans la démonstration"
                        className={styles.manageLink}
                      >
                        {reservation.cancellation
                          ? 'Demander une modification'
                          : 'Modifier ou annuler'}
                      </button>
                    ) : reservation.restaurantPhone ? (
                      <a
                        href={`tel:${reservation.restaurantPhone.replace(/[^+0-9]/g, '')}`}
                        title="Contacter le restaurant par téléphone pour modifier ou annuler"
                        className={cn(styles.manageLink, 'transition-all duration-200')}
                      >
                        {reservation.cancellation
                          ? 'Demander une modification'
                          : 'Modifier ou annuler'}
                      </a>
                    ) : (
                      <span className={styles.manageLabel}>Modifier ou annuler</span>
                    ))}
                  {demo ? (
                    <Button
                      disabled
                      title="Indisponible dans la démonstration"
                      variant="outline"
                      className={cn(styles.contact, 'min-h-11 transition-all duration-200')}
                    >
                      <Phone className="mr-2 h-4 w-4" /> Appeler le restaurant
                    </Button>
                  ) : reservation.restaurantPhone ? (
                    <Button
                      asChild
                      variant="outline"
                      className={cn(styles.contact, 'min-h-11 transition-all duration-200')}
                    >
                      <a href={`tel:${reservation.restaurantPhone.replace(/[^+0-9]/g, '')}`}>
                        <Phone className="mr-2 h-4 w-4" /> Appeler le restaurant
                      </a>
                    </Button>
                  ) : (
                    <p className="mt-4 text-xs text-muted-foreground">
                      Veuillez contacter directement le restaurant.
                    </p>
                  )}
                </section>
                {reservation.whatsappReminder.visible && (
                  <details className={styles.preferences} aria-busy={busy}>
                    <summary
                      className={cn(styles.preferencesToggle, 'transition-all duration-200')}
                    >
                      <span>Préférences de rappel</span>
                      <ChevronDown
                        className={cn(styles.chevron, 'h-3.5 w-3.5')}
                        aria-hidden="true"
                      />
                    </summary>
                    <div className="mt-4 flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <label
                          htmlFor="whatsapp-reminder"
                          className="flex items-center gap-2 text-sm"
                        >
                          <MessageCircle className="h-4 w-4 shrink-0" aria-hidden="true" /> Rappel
                          WhatsApp
                        </label>
                        <p
                          id="reminder-description"
                          className="mt-2 max-w-56 text-xs leading-relaxed text-muted-foreground"
                        >
                          {reservation.whatsappReminder.enabled
                            ? 'Rappel autorisé.'
                            : 'Rappel désactivé.'}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 pt-0.5">
                        <span
                          className="flex h-4 w-4 items-center justify-center"
                          aria-live="polite"
                        >
                          {busy && (
                            <Loader2 className="h-4 w-4 animate-spin" aria-label="Enregistrement" />
                          )}
                        </span>
                        <Switch
                          id="whatsapp-reminder"
                          aria-describedby="reminder-description"
                          checked={reservation.whatsappReminder.enabled}
                          onCheckedChange={() => void withdraw()}
                          disabled={busy || !reservation.whatsappReminder.enabled}
                          className="transition-all duration-200"
                        />
                      </div>
                    </div>
                    {withdrawn && (
                      <p
                        role="status"
                        className="mt-4 text-xs leading-relaxed text-muted-foreground"
                      >
                        Votre accord a été retiré. Un rappel déjà en cours peut encore arriver.
                      </p>
                    )}
                  </details>
                )}
              </div>
            </details>
            {footer}
          </>
        ) : null}
        {error && (
          <div className="my-10 border-l-2 border-destructive pl-4">
            <p role="alert" className="text-sm">
              {error}
            </p>
            <Button
              variant="outline"
              onClick={() => (reservation ? void withdraw() : void load())}
              className="mt-3 min-h-11 transition-all duration-200"
            >
              Réessayer
            </Button>
          </div>
        )}
      </div>
      <Dialog
        open={cancelOpen}
        onOpenChange={(open) => {
          if (!cancelInFlight.current) setCancelOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={!busy}
          className={cn(styles.page, 'max-w-sm bg-background text-foreground')}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Annuler votre réservation ?</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {reservation?.restaurantName} · {reservation?.date} à {reservation?.time} ·{' '}
              {reservation?.partySize} personnes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-xs leading-relaxed">
            {reservation?.cancellation?.terms && <p>{reservation.cancellation.terms}</p>}
            <p>{reservation?.cancellation?.message}</p>
            <p>Votre table sera libérée. Cette action est définitive.</p>
            {cancelError && <p role="alert">{cancelError}</p>}
          </div>
          <DialogFooter className="gap-2 sm:flex-col sm:space-x-0">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setCancelOpen(false)}
              className="transition-all duration-200"
            >
              Conserver ma réservation
            </Button>
            <Button
              disabled={busy || !reservation?.cancellation?.available}
              onClick={() => void cancelReservation()}
              className="transition-all duration-200"
            >
              {busy ? 'Annulation en cours…' : 'Confirmer l’annulation'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
