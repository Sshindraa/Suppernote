'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  Calendar,
  Users,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Clock,
  ArrowLeft,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { cardGuaranteeNotice, fetchWithTimeout, type CardGuaranteeTerms } from '@suppernote/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RestaurantReservationInput = {
  restaurant_id: string;
  restaurant_name?: string;
  restaurant_slug?: string;
  marketingAttributionToken?: string;
  restaurant_image?: string;
  restaurant_address?: {
    address: string;
    city: string;
    state: string;
    zipcode: string;
    country: string;
  };
};

type WindowWithOpenAI = Window & {
  openai?: {
    toolInput?: RestaurantReservationInput;
    toolOutput?: unknown;
    setWidgetState?: (state: unknown) => void;
  };
};

type Slot = {
  time: string;
  available: boolean;
};

type AvailabilityResponse = {
  restaurantId: string;
  date: string;
  partySize: number;
  slots: Slot[];
};

type HoldResponse = {
  holdId: string;
  holdToken: string;
  expiresAt: string;
  status: 'pending';
};

type ConfirmResponse = {
  managementUrl?: string;
  reservationId: string;
  status: 'confirmed';
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
};

type Step = 'details' | 'slots' | 'customer' | 'confirmed';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

/**
 * Lit les inputs passés par ChatGPT via window.openai.toolInput.
 * En standalone (hors ChatGPT), lit depuis l'URL ?slug=... ou ?restaurant_id=...
 */
function readToolInput(): RestaurantReservationInput | null {
  if (typeof window === 'undefined') return null;
  const w = window as WindowWithOpenAI;
  if (w.openai?.toolInput) return w.openai.toolInput;

  // Fallback standalone (pour le dev local et tests URL)
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug');
  if (slug) {
    return {
      restaurant_id: params.get('restaurant_id') || slug,
      restaurant_name: params.get('restaurant_name') || undefined,
      restaurant_slug: slug,
      marketingAttributionToken: params.get('marketingAttributionToken') || undefined,
    };
  }
  const restaurant_id = params.get('restaurant_id');
  if (restaurant_id) {
    return {
      restaurant_id,
      restaurant_name: params.get('restaurant_name') || undefined,
      restaurant_slug: params.get('restaurant_slug') || undefined,
      marketingAttributionToken: params.get('marketingAttributionToken') || undefined,
    };
  }
  return null;
}

/** Retourne la date du jour au format YYYY-MM-DD (min pour l'input date). */
function todayISO(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

/** Valide un numéro de téléphone au format E.164 (+CC...). */
function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}

/** Code renvoyé par l'API quand le créneau est dans le délai minimum de réservation du restaurant. */
const INSUFFICIENT_LEAD_TIME = 'INSUFFICIENT_LEAD_TIME';

/**
 * Un 409 peut vouloir dire « créneau pris » ou « créneau trop proche ». Dans le second cas, l'API
 * fournit déjà le message en français (« … au moins 2 h à l'avance ») : on l'affiche tel quel au lieu
 * du faux « vient d'être réservé ». `null` si ce n'est pas un refus de délai.
 */
function leadTimeMessageFrom(body: { code?: unknown; error?: unknown }): string | null {
  return body.code === INSUFFICIENT_LEAD_TIME && typeof body.error === 'string' ? body.error : null;
}

async function leadTimeMessageOf(res: Response): Promise<string | null> {
  if (res.status !== 409) return null;
  try {
    return leadTimeMessageFrom((await res.json()) as { code?: unknown; error?: unknown });
  } catch {
    return null;
  }
}

/**
 * Mappe une erreur HTTP/ réseau en message utilisateur français.
 * Gère notamment le 409 (slot déjà pris).
 */
function mapApiError(status: number, fallback: string): string {
  if (status === 404) return 'Restaurant introuvable. Vérifiez le lien de réservation.';
  if (status === 409) return "Ce créneau vient d'être réservé. Veuillez en choisir un autre.";
  if (status === 410) return 'Cette réservation a expiré. Veuillez recommencer.';
  if (status >= 500)
    return 'Le service est temporairement indisponible. Réessayez dans un instant.';
  return fallback;
}

// ---------------------------------------------------------------------------
// Composant
// ---------------------------------------------------------------------------

export function ReservationWidget() {
  const [input, setInput] = useState<RestaurantReservationInput | null>(null);
  const [step, setStep] = useState<Step>('details');

  // Étape 1 : date + party size
  const [date, setDate] = useState('');
  const [partySize, setPartySize] = useState(2);

  // Étape 2 : créneaux
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedTime, setSelectedTime] = useState('');

  // Étape 3 : formulaire client
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [specialRequests, setSpecialRequests] = useState('');
  const [website, setWebsite] = useState(''); // honeypot anti-bot
  const [submitting, setSubmitting] = useState(false);

  // États globaux
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmResponse | null>(null);
  const [guaranteeRedirect, setGuaranteeRedirect] = useState<{
    terms: CardGuaranteeTerms;
    bookingUrl: string | null;
  } | null>(null);

  useEffect(() => {
    setInput(readToolInput());
  }, []);

  const slug = useMemo(() => input?.restaurant_slug, [input]);
  const marketingAttributionToken = input?.marketingAttributionToken;

  useEffect(() => {
    if (!marketingAttributionToken || marketingAttributionToken.length < 20) return;
    void fetchWithTimeout(`${API_URL}/marketing/attribution/click`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: marketingAttributionToken }),
    }).catch(() => undefined);
  }, [marketingAttributionToken]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /** Étape 1 → Étape 2 : fetch availability. */
  async function handleFetchSlots(e: React.FormEvent) {
    e.preventDefault();
    setGuaranteeRedirect(null);
    if (!slug) {
      setError('Slug du restaurant manquant — impossible de charger les créneaux.');
      return;
    }
    if (!date) {
      setError('Choisissez une date.');
      return;
    }
    setError(null);
    setLoadingSlots(true);
    setSlots([]);
    setSelectedTime('');

    const w = window as WindowWithOpenAI;
    w.openai?.setWidgetState?.({ status: 'loading_slots', date, partySize });

    try {
      const url = `${API_URL}/public/r/${encodeURIComponent(slug)}/availability?date=${encodeURIComponent(date)}&partySize=${partySize}`;
      const res = await fetchWithTimeout(url, { method: 'GET' });
      if (!res.ok) {
        setError(mapApiError(res.status, 'Impossible de charger les créneaux.'));
        return;
      }
      const data = (await res.json()) as AvailabilityResponse;
      setSlots(data.slots || []);
      setStep('slots');
      w.openai?.setWidgetState?.({ status: 'slots_loaded', slotCount: data.slots?.length || 0 });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('La requête a expiré. Vérifiez votre connexion et réessayez.');
      } else {
        setError('Erreur réseau. Vérifiez votre connexion et réessayez.');
      }
    } finally {
      setLoadingSlots(false);
    }
  }

  /**
   * Sélection d'un créneau → Étape 3. Une table soumise à empreinte bancaire se termine sur la
   * page du restaurant : la carte ne se saisit pas dans un assistant (spec empreinte v1).
   */
  async function handleSelectSlot(time: string) {
    setSelectedTime(time);
    setError(null);
    try {
      const res = await fetchWithTimeout(
        `${API_URL}/public/r/${encodeURIComponent(slug ?? '')}/card-guarantee?date=${encodeURIComponent(date)}&partySize=${partySize}`,
        { method: 'GET' },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          cardGuarantee: CardGuaranteeTerms | null;
          bookingUrl?: string;
        };
        if (body.cardGuarantee) {
          setGuaranteeRedirect({ terms: body.cardGuarantee, bookingUrl: body.bookingUrl ?? null });
          return;
        }
      }
    } catch {
      // Le serveur revérifie à la confirmation (409 card_guarantee_required).
    }
    setStep('customer');
  }

  /** Étape 3 → POST /hold puis POST /confirm. */
  async function handleConfirm(e: React.FormEvent) {
    e.preventDefault();

    // Honeypot : si rempli, c'est un bot — on silent-fail.
    if (website) return;

    if (!slug) {
      setError('Slug du restaurant manquant.');
      return;
    }
    if (!firstName.trim()) {
      setError('Indiquez votre prénom.');
      return;
    }
    if (!isValidE164(phone)) {
      setError('Numéro de téléphone invalide. Format attendu : +33 6 12 34 56 78.');
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('Adresse e-mail invalide.');
      return;
    }

    setError(null);
    setSubmitting(true);

    const w = window as WindowWithOpenAI;
    w.openai?.setWidgetState?.({ status: 'submitting', date, time: selectedTime, partySize });

    try {
      // 1. Hold
      const holdUrl = `${API_URL}/public/r/${encodeURIComponent(slug)}/hold`;
      const holdRes = await fetchWithTimeout(holdUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date,
          time: selectedTime,
          partySize,
          source: 'chatgpt',
          website,
        }),
      });

      if (holdRes.status === 409) {
        const tooSoon = await leadTimeMessageOf(holdRes);
        setError(tooSoon ?? "Ce créneau vient d'être réservé. Veuillez en choisir un autre.");
        setStep('slots');
        // Rafraîchit la disponibilité
        setSlots((prev) =>
          prev.map((s) => (s.time === selectedTime ? { ...s, available: false } : s)),
        );
        setSelectedTime('');
        return;
      }
      if (!holdRes.ok) {
        setError(mapApiError(holdRes.status, 'Impossible de réserver ce créneau.'));
        return;
      }

      const hold = (await holdRes.json()) as HoldResponse;

      // 2. Confirm
      const confirmUrl = `${API_URL}/public/r/${encodeURIComponent(slug)}/confirm`;
      const confirmRes = await fetchWithTimeout(confirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          holdToken: hold.holdToken,
          customer: {
            firstName: firstName.trim(),
            lastName: lastName.trim() || undefined,
            phone: phone.trim(),
            email: email.trim() || undefined,
          },
          specialRequests: specialRequests.trim() || undefined,
          ...(marketingAttributionToken ? { marketingAttributionToken } : {}),
          source: 'chatgpt',
          website,
        }),
      });

      if (!confirmRes.ok) {
        const refusal =
          confirmRes.status === 409
            ? ((await confirmRes.json().catch(() => ({}))) as {
                code?: unknown;
                error?: unknown;
                cardGuarantee?: CardGuaranteeTerms;
                bookingUrl?: string;
              })
            : {};
        if (refusal.error === 'card_guarantee_required' && refusal.cardGuarantee) {
          setGuaranteeRedirect({
            terms: refusal.cardGuarantee,
            bookingUrl: refusal.bookingUrl ?? null,
          });
          setStep('slots');
          return;
        }
        const tooSoon = leadTimeMessageFrom(refusal);
        if (tooSoon) {
          // Le créneau est devenu trop proche entre le hold et la confirmation : retour aux horaires.
          setError(tooSoon);
          setStep('slots');
          setSlots((prev) =>
            prev.map((s) => (s.time === selectedTime ? { ...s, available: false } : s)),
          );
          setSelectedTime('');
          return;
        }
        setError(mapApiError(confirmRes.status, 'La confirmation a échoué. Veuillez réessayer.'));
        return;
      }

      const conf = (await confirmRes.json()) as ConfirmResponse;
      setConfirmation(conf);
      setStep('confirmed');
      w.openai?.setWidgetState?.({ status: 'confirmed', reservationId: conf.reservationId });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setError('La requête a expiré. Vérifiez votre connexion et réessayez.');
      } else {
        setError('Erreur réseau. Vérifiez votre connexion et réessayez.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  // -------------------------------------------------------------------------
  // Rendu
  // -------------------------------------------------------------------------

  // Pas de slug / pas d'input
  if (!input) {
    return (
      <div
        className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground"
        role="status"
      >
        En attente des données du restaurant…
      </div>
    );
  }

  if (!slug) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
        <div className="flex items-center gap-2">
          <AlertCircle size={18} />
          <p className="font-medium">Lien de réservation invalide</p>
        </div>
        <p className="mt-2 text-muted-foreground">
          Le slug du restaurant est manquant. Veuillez utiliser le lien fourni par le restaurant.
        </p>
      </div>
    );
  }

  // Étape 4 : confirmation
  if (step === 'confirmed' && confirmation) {
    const dateLabel = new Date(`${confirmation.date}T${confirmation.time}`).toLocaleString(
      'fr-FR',
      {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      },
    );
    return (
      <div
        className="rounded-lg border border-primary/30 bg-primary/5 p-6 animate-fade-in"
        role="status"
        aria-live="polite"
      >
        <div className="flex items-center gap-2 text-primary">
          <CheckCircle2 size={20} />
          <p className="font-semibold">C&apos;est réservé !</p>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {confirmation.restaurantName || input.restaurant_name || 'Le restaurant'} vous attend le{' '}
          <strong className="text-foreground">{dateLabel}</strong> pour{' '}
          <strong className="text-foreground">{confirmation.partySize}</strong> personne
          {confirmation.partySize > 1 ? 's' : ''}.
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          N° de réservation :{' '}
          <strong className="text-foreground">{confirmation.reservationId}</strong>
        </p>
        {confirmation.managementUrl && (
          <a
            href={confirmation.managementUrl}
            referrerPolicy="no-referrer"
            className="mt-4 inline-flex min-h-11 items-center underline transition-all duration-200"
          >
            Gérer ma réservation
          </a>
        )}
      </div>
    );
  }

  // Étape 1 : date + party size
  if (step === 'details') {
    return (
      <form
        onSubmit={handleFetchSlots}
        className="space-y-4 rounded-lg border border-border bg-card p-5 animate-fade-in"
        aria-label="Détails de la réservation"
      >
        <header>
          <h2 className="text-lg font-semibold leading-tight">
            {input.restaurant_name || 'Réserver une table'}
          </h2>
          {input.restaurant_address && (
            <p className="text-sm text-muted-foreground mt-1">
              {input.restaurant_address.address}, {input.restaurant_address.city}
            </p>
          )}
        </header>

        <div className="space-y-2">
          <label htmlFor="party-size" className="flex items-center gap-2 text-sm font-medium">
            <Users size={14} aria-hidden />
            Nombre de personnes
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={partySize <= 1}
              onClick={() => setPartySize(partySize - 1)}
              aria-label="Diminuer le nombre de personnes"
              className="h-9 w-9 rounded-md border border-border bg-background text-sm font-medium transition-all duration-200 hover:bg-muted disabled:opacity-50"
            >
              −
            </button>
            <span
              id="party-size"
              className="w-12 text-center text-base font-semibold tabular-nums"
              aria-live="polite"
            >
              {partySize}
            </span>
            <button
              type="button"
              disabled={partySize >= 20}
              onClick={() => setPartySize(partySize + 1)}
              aria-label="Augmenter le nombre de personnes"
              className="h-9 w-9 rounded-md border border-border bg-background text-sm font-medium transition-all duration-200 hover:bg-muted disabled:opacity-50"
            >
              +
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <label htmlFor="res-date" className="flex items-center gap-2 text-sm font-medium">
            <Calendar size={14} aria-hidden />
            Choisissez une date
          </label>
          <input
            id="res-date"
            type="date"
            min={todayISO()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={cn(
              'w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm',
              'ring-offset-background transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
            required
          />
        </div>

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle size={14} aria-hidden />
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loadingSlots || !date}
          className={cn(
            'w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium',
            'transition-all duration-200 hover:bg-primary/90',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            'flex items-center justify-center gap-2',
          )}
        >
          {loadingSlots ? (
            <>
              <Loader2 size={14} className="animate-spin" aria-hidden />
              Recherche des créneaux…
            </>
          ) : (
            'Voir les créneaux'
          )}
        </button>
      </form>
    );
  }

  // Étape 2 : grille de créneaux
  if (step === 'slots') {
    const availableSlots = slots.filter((s) => s.available);
    return (
      <div
        className="space-y-4 rounded-lg border border-border bg-card p-5 animate-fade-in"
        aria-label="Créneaux disponibles"
      >
        <header className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold leading-tight">
              {input.restaurant_name || 'Créneaux'}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {new Date(`${date}T00:00`).toLocaleDateString('fr-FR', {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}{' '}
              · {partySize} personne{partySize > 1 ? 's' : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              setStep('details');
              setError(null);
              setGuaranteeRedirect(null);
            }}
            aria-label="Retour aux détails"
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft size={14} aria-hidden />
            Retour
          </button>
        </header>

        {availableSlots.length === 0 ? (
          <div className="rounded-md border border-border bg-muted/40 p-6 text-center text-sm text-muted-foreground">
            <Clock size={24} className="mx-auto mb-2 opacity-50" aria-hidden />
            Aucun créneau disponible pour cette date.
            <br />
            Essayez une autre date.
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2" role="listbox" aria-label="Choisissez un horaire">
            {slots.map((slot) => (
              <button
                key={slot.time}
                type="button"
                disabled={!slot.available}
                onClick={() => void handleSelectSlot(slot.time)}
                aria-disabled={!slot.available}
                className={cn(
                  'h-10 rounded-md border text-sm font-medium transition-all duration-200',
                  slot.available
                    ? 'border-border bg-background hover:border-primary hover:bg-primary/5 text-foreground'
                    : 'border-border bg-muted/40 text-muted-foreground/50 cursor-not-allowed line-through',
                )}
              >
                {slot.time}
              </button>
            ))}
          </div>
        )}

        {guaranteeRedirect && (
          <div
            className="space-y-3 rounded-md border border-border bg-muted/40 p-4 text-sm"
            role="status"
          >
            <p className="leading-relaxed text-muted-foreground">
              {cardGuaranteeNotice({
                restaurantName: input.restaurant_name || 'Le restaurant',
                partySize,
                terms: guaranteeRedirect.terms,
              })}
            </p>
            {guaranteeRedirect.bookingUrl ? (
              <a
                href={`${guaranteeRedirect.bookingUrl}?date=${encodeURIComponent(date)}&partySize=${partySize}&time=${encodeURIComponent(selectedTime)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 font-medium text-primary-foreground transition-all duration-200 hover:bg-primary/90"
              >
                Terminer sur la page du restaurant
              </a>
            ) : (
              <p>Contactez le restaurant pour terminer cette réservation.</p>
            )}
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
            <AlertCircle size={14} aria-hidden />
            {error}
          </div>
        )}
      </div>
    );
  }

  // Étape 3 : formulaire client
  return (
    <form
      onSubmit={handleConfirm}
      className="space-y-4 rounded-lg border border-border bg-card p-5 animate-fade-in"
      aria-label="Vos coordonnées"
    >
      <header className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold leading-tight">Vos coordonnées</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {new Date(`${date}T${selectedTime}`).toLocaleString('fr-FR', {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}{' '}
            · {partySize} personne{partySize > 1 ? 's' : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setStep('slots');
            setError(null);
          }}
          aria-label="Retour aux créneaux"
          className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} aria-hidden />
          Retour
        </button>
      </header>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label htmlFor="first-name" className="text-sm font-medium">
            Prénom <span className="text-destructive">*</span>
          </label>
          <input
            id="first-name"
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoComplete="given-name"
            required
            className={cn(
              'w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm',
              'ring-offset-background transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="last-name" className="text-sm font-medium">
            Nom
          </label>
          <input
            id="last-name"
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            autoComplete="family-name"
            className={cn(
              'w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm',
              'ring-offset-background transition-all duration-200',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            )}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="phone" className="text-sm font-medium">
          Téléphone <span className="text-destructive">*</span>
        </label>
        <input
          id="phone"
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="+33 6 12 34 56 78"
          autoComplete="tel"
          required
          className={cn(
            'w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm',
            'ring-offset-background transition-all duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        />
        <p className="text-xs text-muted-foreground">Format international, ex. +33 6 12 34 56 78</p>
      </div>

      <div className="space-y-1.5">
        <label htmlFor="email" className="text-sm font-medium">
          E-mail
        </label>
        <input
          id="email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className={cn(
            'w-full h-10 rounded-md border border-border bg-background px-3 py-2 text-sm',
            'ring-offset-background transition-all duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        />
      </div>

      <div className="space-y-1.5">
        <label htmlFor="special-requests" className="text-sm font-medium">
          Demandes particulières
        </label>
        <textarea
          id="special-requests"
          value={specialRequests}
          onChange={(e) => setSpecialRequests(e.target.value)}
          rows={2}
          placeholder="Allergies, table près de la fenêtre, occasion spéciale…"
          className={cn(
            'w-full rounded-md border border-border bg-background px-3 py-2 text-sm resize-none',
            'ring-offset-background transition-all duration-200',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          )}
        />
      </div>

      {/* Honeypot anti-bot — caché visuellement, ignoré par les utilisateurs réels */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-[-9999px]">
        <label htmlFor="website">Ne pas remplir</label>
        <input
          id="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(e) => setWebsite(e.target.value)}
        />
      </div>

      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
          <AlertCircle size={14} aria-hidden />
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={cn(
          'w-full h-10 rounded-md bg-primary text-primary-foreground text-sm font-medium',
          'transition-all duration-200 hover:bg-primary/90',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          'flex items-center justify-center gap-2',
        )}
      >
        {submitting ? (
          <>
            <Loader2 size={14} className="animate-spin" aria-hidden />
            Confirmation…
          </>
        ) : (
          'Confirmer la réservation'
        )}
      </button>
    </form>
  );
}
