'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import ReservationView, { type Reservation } from '@/app/r/reservation-view';
import { ReservationDatePicker } from './reservation-date-picker';
import { Skeleton } from '@/components/ui/skeleton';
import { getGiftCardOrigin } from '@/lib/gift-card-origin';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';
import { getParentOrigin } from '@/app/widget/[restaurantId]/post-message-security';
import {
  bookingSlotsOf,
  buildMarketingConsentLabel,
  CARD_GUARANTEE_ACCEPT_LABEL,
  cardGuaranteeNotice,
  MARKETING_CONSENT_VERSION,
  type CardGuaranteeTerms,
  normalizeOpeningHours,
  type MarketingConsentChannel,
} from '@suppernote/shared';
import {
  Calendar as CalendarIcon,
  Clock,
  MapPin,
  Info,
  Users,
  ChevronRight,
  CheckCircle2,
  CreditCard,
  AlertCircle,
  ChevronLeft,
  ArrowLeft,
  Phone,
  User,
  Mail,
  Utensils,
  Loader2,
  Gift,
  X,
} from 'lucide-react';

const reservationTheme: CSSProperties & Record<`--${string}`, string> = {
  '--reservation-scrim': '0 0% 0%',
  '--reservation-bg': '34 32% 92%',
  '--reservation-wash': '34 38% 96%',
  '--reservation-panel': '0 0% 100%',
  '--reservation-ink': '24 10% 10%',
  '--reservation-soft': '24 6% 42%',
  '--reservation-muted': '24 5% 64%',
  '--reservation-line': '28 20% 88%',
  // Accents de réservation alignés sur la palette Suppernote : ivoire, taupe et champagne.
  // Les états d'erreur restent signalés par le rouge natif du composant.
  '--reservation-accent': '38 8% 48%',
  '--reservation-glow': '38 12% 60%',
  '--reservation-success': '24 10% 34%',
  '--reservation-confirmed': '142 42% 24%',
  '--reservation-confirmed-bg': '142 28% 86%',
};

const FRENCH_DAYS = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const FRENCH_DAYS_SHORT = ['DIM', 'LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM'];
const FRENCH_MONTHS = [
  'Janvier',
  'Février',
  'Mars',
  'Avril',
  'Mai',
  'Juin',
  'Juillet',
  'Août',
  'Septembre',
  'Octobre',
  'Novembre',
  'Décembre',
];
const FRENCH_MONTHS_SHORT = [
  'janv.',
  'févr.',
  'mars',
  'avr.',
  'mai',
  'juin',
  'juil.',
  'août',
  'sept.',
  'oct.',
  'nov.',
  'déc.',
];
const FALLBACK_RESTAURANT_IMAGE =
  'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80';
const FALLBACK_DISH_IMAGE =
  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=600&q=80';

function formatLongFrenchDate(date: Date) {
  return `${FRENCH_DAYS[date.getDay()]} ${date.getDate()} ${FRENCH_MONTHS[
    date.getMonth()
  ].toLowerCase()}`;
}

function formatShortFrenchDate(date: Date) {
  return `${date.getDate()} ${FRENCH_MONTHS_SHORT[date.getMonth()]}`;
}

/**
 * Stripe refuse d'être affiché dans une iframe : on ouvre la page dans la fenêtre principale,
 * ou dans un nouvel onglet si le site hôte l'interdit. Un lien de secours reste affiché.
 */
function openTopLevel(url: string) {
  try {
    if (window.top && window.top !== window) {
      window.top.location.assign(url);
      return;
    }
    window.location.assign(url);
  } catch {
    window.open(url, '_blank', 'noopener');
  }
}

function triggerHaptic() {
  if (typeof window === 'undefined') return;
  navigator.vibrate?.(8);
}

interface OpeningHours {
  open: string;
  close: string;
  services?: Array<{ open: string; close: string }>;
}

interface RestaurantPublic {
  slug?: string;
  bookingEnabled?: boolean;
  giftCardEnabled?: boolean;
  whatsappReminderOptInEnabled?: boolean;
  id: string;
  name: string;
  openingHours: Record<string, OpeningHours | null>;
  heroImageUrl?: string;
  imageUrl?: string;
  coverImageUrl?: string;
  galleryImages?: string[];
  cuisine?: string;
  city?: string;
  address?: string;
  formattedAddress?: string;
  phoneNumber?: string;
  tags?: string[];
}

interface ConfirmedReservation {
  managementUrl?: string;
  whatsappWithdrawalToken?: string;
  id: string;
  restaurantId: string;
  reservedAt: string;
  partySize: number;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  status: string;
}

interface AvailabilityResponse {
  restaurantId: string;
  date: string;
  partySize: number;
  slots: string[];
}

function formatDateParam(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseRequestedDate(value: string | null, now: Date): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (formatDateParam(date) !== value) return null;

  const firstDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const lastDay = new Date(firstDay);
  lastDay.setDate(lastDay.getDate() + 89);
  return date >= firstDay && date <= lastDay ? date : null;
}

function parseRequestedPartySize(value: string | null): number | null {
  if (!value || !/^[1-8]$/.test(value)) return null;
  return Number(value);
}

function parseRequestedTime(value: string | null): string | null {
  return value && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : null;
}

/** Erreur d'une route publique : garde le statut et le corps (ex. 409 `waitingListEnabled`). */
class PublicApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown>,
  ) {
    super(message);
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Le message apparaît en haut du panneau, souvent défilé plus bas : le ramener sous les yeux du client.
function revealOnMount(element: HTMLElement | null) {
  element?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

function toInternationalPhone(input: string): string {
  const normalized = input.replace(/\s/g, '');
  return normalized.startsWith('+') ? normalized : `+33${normalized.replace(/^0/, '')}`;
}

async function publicApiFetch<T = unknown>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `/api/proxy/${path.replace(/^\//, '')}`;

  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  let data: Record<string, unknown> = {};
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    const errorMsg = data.error || data.message || `Erreur ${res.status}`;
    throw new PublicApiError(
      typeof errorMsg === 'string' ? errorMsg : `Erreur ${res.status}`,
      res.status,
      data,
    );
  }

  return data as T;
}

export type WidgetModification = {
  date: string;
  time: string;
  partySize: number;
  restaurantName: string;
  restaurantAddress?: string | null;
  restaurantPhone?: string | null;
  demo?: boolean;
  close?: () => void;
  cancel?: () => void;
  terms?: string;
  maxDate?: string;
  getOptions: (
    partySize: number,
    date: string,
  ) => Promise<{
    slots: Array<{ time: string; proposalToken: string }>;
    maxPartySize: number;
    message: string;
  }>;
  confirm: (proposalToken: string) => Promise<void>;
  onBusyChange: (busy: boolean) => void;
};
const emptyQuery = new URLSearchParams();

export default function ReservationWidget({
  restaurantId,
  query: searchParams = emptyQuery,
  modification,
}: {
  restaurantId: string;
  query?: URLSearchParams;
  modification?: WidgetModification;
}) {
  const requestedDateParam = searchParams.get('date');
  const requestedPartySize = parseRequestedPartySize(searchParams.get('partySize'));
  const requestedTime = parseRequestedTime(searchParams.get('time'));
  const requestedDate = parseRequestedDate(requestedDateParam, new Date());
  const isEmbedded = Boolean(modification) || searchParams.get('embedded') === '1';
  const marketingAttributionToken = searchParams.get('marketingAttributionToken') ?? '';
  // Any present test parameter must stay in the test path, including an invalid/empty token.
  // The API rejects it; never fall back to creating a real reservation.
  const testBookingToken = searchParams.get('testBooking');
  const testBooking = testBookingToken !== null;
  const giftCardCode = searchParams.get('giftCardCode')?.trim().slice(0, 100);
  // Origine explicite du parent, passée par le snippet embed Suppernote.
  // Priorité sur document.referrer (qui peut être vide avec Referrer-Policy: no-referrer).
  const explicitParentOrigin = searchParams.get('parentOrigin');

  // Record the campaign click as soon as the public booking page opens. The
  // endpoint only stores a timestamp and never exposes the customer or
  // campaign identifiers. Invalid/expired links are ignored so attribution
  // cannot affect the booking UX.
  useEffect(() => {
    if (testBooking) return;
    if (marketingAttributionToken.length < 20 || marketingAttributionToken.length > 4096) return;
    void publicApiFetch('POST', 'marketing/attribution/click', {
      token: marketingAttributionToken,
    }).catch(() => undefined);
  }, [marketingAttributionToken, testBooking]);

  const [modificationSlots, setModificationSlots] = useState<
    Array<{ time: string; proposalToken: string }>
  >([]);
  const [maxPartySize, setMaxPartySize] = useState(8);
  const [optionsMessage, setOptionsMessage] = useState('');

  // Restaurant public metadata
  const [restaurant, setRestaurant] = useState<RestaurantPublic | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Booking Flow State
  const [step, setStep] = useState<1 | 2>(1);
  const [partySize, setPartySize] = useState<number>(
    modification?.partySize ?? requestedPartySize ?? 2,
  );
  const [selectedDate, setSelectedDate] = useState<Date | null>(
    modification ? new Date(`${modification.date}T12:00:00`) : null,
  );
  const [selectedTime, setSelectedTime] = useState<string>(modification?.time ?? '');
  const selectedTimeRef = useRef(selectedTime);
  selectedTimeRef.current = selectedTime;
  const requestedSlotRef = useRef<{ date: string; partySize: number; time: string } | null>(
    requestedDate && requestedPartySize && requestedTime
      ? { date: formatDateParam(requestedDate), partySize: requestedPartySize, time: requestedTime }
      : null,
  );
  const [selectionNotice, setSelectionNotice] = useState('');
  const [weekOffset, setWeekOffset] = useState<number | null>(null);
  const [chosenService, setChosenService] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'party' | 'date' | 'time'>('party');
  const [availabilityRefreshing, setAvailabilityRefreshing] = useState(false);
  const [availabilityError, setAvailabilityError] = useState('');
  const [availabilityRetryNonce, setAvailabilityRetryNonce] = useState(0);
  const [availabilityDate, setAvailabilityDate] = useState('');
  const [availableSlots, setAvailableSlots] = useState<string[]>([]);
  const dateSectionRef = useRef<HTMLDivElement | null>(null);
  const timeSectionRef = useRef<HTMLDivElement | null>(null);

  // Contact details
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [whatsappOptIn, setWhatsappOptIn] = useState(false);
  // Jamais pré-cochées ; une case n'apparaît qu'avec la coordonnée correspondante.
  const [marketingConsent, setMarketingConsent] = useState<
    Record<MarketingConsentChannel, boolean>
  >({ EMAIL: false, SMS: false });

  // Liste d'attente : proposée quand le créneau choisi vient d'être pris (409 sur le hold).
  // Créneau refusé (date|heure|couverts) : l'offre disparaît dès que le choix change.
  const [waitingListOfferKey, setWaitingListOfferKey] = useState<string | null>(null);
  const [waitingListResult, setWaitingListResult] = useState<{
    entryId: string;
    position: number;
    actionToken: string;
  } | null>(null);
  const [waitingListCancelled, setWaitingListCancelled] = useState(false);
  const [waitingListBusy, setWaitingListBusy] = useState(false);

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  // Empreinte bancaire : conditions de la table choisie, acceptation, puis page Stripe.
  const [cardGuarantee, setCardGuarantee] = useState<CardGuaranteeTerms | null>(null);
  const [cardGuaranteeAccepted, setCardGuaranteeAccepted] = useState(false);
  const [cardGuaranteeUrl, setCardGuaranteeUrl] = useState<string | null>(null);
  const [confirmedReservation, setConfirmedReservation] = useState<ConfirmedReservation | null>(
    null,
  );

  // Gift card modal — embed la page Connect /widget/[slug]/gift-card en iframe
  // imbriquée. L'overlay reste dans l'iframe du widget résa, donc l'utilisateur
  // ne perd pas son contexte de réservation.
  const [showGiftCard, setShowGiftCard] = useState(false);
  const [giftCardHeight, setGiftCardHeight] = useState<number | null>(null);
  const giftCardIframeRef = useRef<HTMLIFrameElement | null>(null);
  const giftCardOrigin = useMemo(
    () => (typeof window === 'undefined' ? '' : getGiftCardOrigin(window.location.origin)),
    [],
  );
  const giftCardUrl = useMemo(() => {
    if (!giftCardOrigin || !restaurantId) return '';
    return `${giftCardOrigin}/widget/${encodeURIComponent(restaurant?.slug || restaurantId)}/gift-card?embedded=1`;
  }, [giftCardOrigin, restaurantId, restaurant?.slug]);

  // Auto-resize iframe when embedded (même mécanisme que le widget Connect).
  // On cible l'origine du parent (dérivée du referrer) plutôt que '*' afin
  // d'éviter qu'un site intermédiaire n'intercepte les messages de resize.
  useEffect(() => {
    if (modification || !isEmbedded || typeof window === 'undefined') return;
    const sendHeight = () => {
      const height = document.body.scrollHeight;
      const parentOrigin = getParentOrigin(explicitParentOrigin);
      if (parentOrigin) {
        window.parent.postMessage({ type: 'sokar-widget-resize', height }, parentOrigin);
      }
    };
    sendHeight();
    const observer = new ResizeObserver(sendHeight);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [isEmbedded, explicitParentOrigin, modification]);

  // Listen for resize messages from the nested gift-card iframe (Connect).
  // En production elle partage notre origine ; en dev elle tourne sur le port Connect 4002.
  // On forwarde aussi au parent si on est soi-même embedded, pour que le
  // site du resto ajuste la hauteur totale du widget — en ciblant l'origine
  // du parent plutôt que '*'.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onMessage = (e: MessageEvent) => {
      // Validation stricte : origine Connect attendue et source = iframe cadeau.
      if (e.origin !== giftCardOrigin) return;
      if (!giftCardIframeRef.current || e.source !== giftCardIframeRef.current.contentWindow)
        return;
      if (e.data?.type !== 'sokar-widget-resize' || typeof e.data?.height !== 'number') return;
      setGiftCardHeight(e.data.height);
      if (isEmbedded) {
        const parentOrigin = getParentOrigin(explicitParentOrigin);
        if (parentOrigin) {
          window.parent.postMessage(
            { type: 'sokar-widget-resize', height: document.body.scrollHeight },
            parentOrigin,
          );
        }
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [giftCardOrigin, isEmbedded, explicitParentOrigin]);

  // Load public restaurant info.
  // Le path param peut être un slug (URL friendly) ou un id Prisma.
  // On essaie d'abord /public/widget/{slug} qui résout via le slug
  // (endpoint public, ne filtre pas sur connectPublished).
  // Si 404, fallback sur /restaurants/{id}/public pour rétrocompat.
  useEffect(() => {
    if (modification) {
      setRestaurant({
        id: restaurantId,
        name: modification.restaurantName,
        address: modification.restaurantAddress ?? undefined,
        openingHours: {},
      });
      setLoading(false);
      return;
    }
    if (!restaurantId) return;
    (async () => {
      try {
        let data: RestaurantPublic;
        try {
          data = await publicApiFetch<RestaurantPublic>('GET', `public/widget/${restaurantId}`);
        } catch (slugErr: unknown) {
          // Fallback : on tente avec l'id direct (rétrocompat avec les URLs /widget/{uuid})
          data = await publicApiFetch<RestaurantPublic>(
            'GET',
            `restaurants/${restaurantId}/public`,
          );
        }
        if (data.bookingEnabled === false) {
          setRestaurant(null);
          setError(
            'La réservation en ligne n’est pas disponible pour ce restaurant. Veuillez le contacter.',
          );
          return;
        }
        setRestaurant(data);
        setSelectedDate(parseRequestedDate(requestedDateParam, new Date()) ?? new Date());
      } catch (err: unknown) {
        setError(getErrorMessage(err, 'Impossible de trouver ce restaurant'));
      } finally {
        setLoading(false);
      }
    })();
  }, [restaurantId, requestedDateParam, modification]);

  const dateBounds = useMemo(() => {
    const first = new Date();
    first.setHours(0, 0, 0, 0);
    const last = new Date(first);
    last.setDate(last.getDate() + 89);
    return { min: formatDateParam(first), max: modification?.maxDate ?? formatDateParam(last) };
  }, [modification]);
  // One week of shortcuts; the date field gives access to the following months.
  const days = useMemo(() => {
    const first = new Date(`${dateBounds.min}T12:00:00`);
    const selected = selectedDate ? formatDateParam(selectedDate) : dateBounds.min;
    const distance = Math.max(
      0,
      Math.round(
        (Date.parse(`${selected}T12:00:00Z`) - Date.parse(`${dateBounds.min}T12:00:00Z`)) /
          86400000,
      ),
    );
    first.setDate(first.getDate() + (weekOffset ?? Math.floor(distance / 7)) * 7);
    const result: Date[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(first);
      date.setDate(date.getDate() + i);
      if (formatDateParam(date) <= dateBounds.max) result.push(date);
    }
    return result;
  }, [selectedDate, dateBounds, weekOffset]);

  function moveWeek(offset: number) {
    const current = Math.round(
      (Date.parse(`${formatDateParam(days[0])}T12:00:00Z`) -
        Date.parse(`${dateBounds.min}T12:00:00Z`)) /
        (7 * 86400000),
    );
    const maximum = Math.floor(
      (Date.parse(`${dateBounds.max}T12:00:00Z`) - Date.parse(`${dateBounds.min}T12:00:00Z`)) /
        (7 * 86400000),
    );
    setWeekOffset(Math.min(maximum, Math.max(0, current + offset)));
  }

  // Créneaux de 30 min de chaque service, jusqu'à sa dernière réservation
  const getSlotsForDate = useCallback(
    (date: Date) => {
      if (!restaurant?.openingHours) return [];
      const periods = normalizeOpeningHours(restaurant.openingHours).filter(
        (period) => period.dayIndex === date.getDay(),
      );
      const slots = periods.flatMap((period) => bookingSlotsOf(period));

      return [...new Set(slots)].sort();
    },
    [restaurant],
  );

  const timeSlots = useMemo(() => {
    if (!selectedDate || availabilityDate !== formatDateParam(selectedDate)) return [];
    return availableSlots;
  }, [availableSlots, availabilityDate, selectedDate]);

  useEffect(() => {
    // Attend que le restaurant soit chargé (= on a l'id Prisma résolu depuis
    // le slug) avant de fetch les dispos. Sinon on passerait le slug à une
    // route qui attend un id → 404.
    if (!restaurant || !selectedDate || success) return;
    const resolvedId = restaurant.id;
    const date = formatDateParam(selectedDate);
    let cancelled = false;

    setAvailabilityRefreshing(true);
    setAvailabilityError('');
    setAvailabilityDate(date);
    setAvailableSlots([]);
    setModificationSlots([]);

    (async () => {
      try {
        const choices = modification ? await modification.getOptions(partySize, date) : null;
        const data = choices
          ? { slots: choices.slots.map((slot) => slot.time) }
          : await publicApiFetch<AvailabilityResponse>(
              'GET',
              `restaurants/${resolvedId}/availability?date=${date}&partySize=${partySize}`,
            );
        if (!cancelled && choices) {
          setModificationSlots(choices.slots);
          setMaxPartySize(choices.maxPartySize);
          setOptionsMessage(choices.message);
        }
        if (cancelled) return;
        const previousTime = selectedTimeRef.current;
        if (modification && previousTime && !data.slots.includes(previousTime))
          setSelectionNotice(
            `L’horaire ${previousTime.replace(':', 'h')} n’est pas disponible pour ce choix. Sélectionnez un autre horaire.`,
          );
        setAvailableSlots(data.slots);
        const requestedSlot = requestedSlotRef.current;
        if (requestedSlot?.date === date && requestedSlot.partySize === partySize) {
          requestedSlotRef.current = null;
          if (data.slots.includes(requestedSlot.time)) {
            setSelectedTime(requestedSlot.time);
          } else {
            setSelectedTime('');
            setSelectionNotice(
              `Le créneau de ${requestedSlot.time.replace(':', 'h')} n’est plus disponible. Choisissez un autre horaire.`,
            );
          }
        } else {
          setSelectedTime((current) => (current && !data.slots.includes(current) ? '' : current));
        }
      } catch (err: unknown) {
        if (cancelled) return;
        setAvailabilityError(getErrorMessage(err, 'Disponibilités indisponibles.'));
        setAvailableSlots([]);
        setSelectedTime('');
      } finally {
        if (!cancelled) setAvailabilityRefreshing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [restaurant, selectedDate, partySize, success, availabilityRetryNonce, modification]);

  const nextOpeningDay = useMemo(() => {
    for (const date of days) {
      if (selectedDate && formatDateParam(date) <= formatDateParam(selectedDate)) continue;
      const slots = getSlotsForDate(date);
      if (slots.length > 0) {
        return date;
      }
    }
    return null;
  }, [days, selectedDate, getSlotsForDate]);

  const lunchSlots = useMemo(
    () =>
      timeSlots.filter((time) => {
        const hour = Number(time.split(':')[0]);
        return hour >= 11 && hour < 15;
      }),
    [timeSlots],
  );
  const dinnerSlots = useMemo(
    () =>
      timeSlots.filter((time) => {
        const hour = Number(time.split(':')[0]);
        return hour >= 18;
      }),
    [timeSlots],
  );
  const otherSlots = useMemo(
    () =>
      timeSlots.filter((time) => {
        const hour = Number(time.split(':')[0]);
        return hour < 11 || (hour >= 15 && hour < 18);
      }),
    [timeSlots],
  );

  const serviceGroups = [
    { title: 'Déjeuner', slots: lunchSlots },
    { title: 'Dîner', slots: dinnerSlots },
    { title: 'Autres horaires', slots: otherSlots },
  ].filter((group) => group.slots.length > 0);
  const selectedService =
    serviceGroups.find((group) => group.title === chosenService) ??
    serviceGroups.find((group) => group.slots.includes(selectedTime)) ??
    serviceGroups[0];

  const labelClass =
    'flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))] sm:text-[11px] lg:text-[10px]';
  const softPillClass =
    'border border-white/60 bg-white/[0.52] text-[hsl(var(--reservation-soft))] shadow-sm backdrop-blur-2xl transition-all duration-200 hover:-translate-y-0.5 hover:border-white/80 hover:bg-white/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--reservation-accent)/0.22)]';
  const selectedPillClass = `${modification ? 'scale-100' : 'scale-105'} border-[hsl(var(--reservation-ink))] bg-[hsl(var(--reservation-ink))] text-[hsl(var(--reservation-panel))] shadow-lg shadow-black/10 hover:bg-[hsl(var(--reservation-ink))] hover:text-[hsl(var(--reservation-panel))]`;
  const fieldClass =
    'h-[3.25rem] w-full rounded-2xl border border-white/60 bg-white/38 px-5 text-sm font-medium text-[hsl(var(--reservation-ink))] shadow-inner outline-none backdrop-blur-2xl transition-all duration-200 placeholder:text-[hsl(var(--reservation-muted))] focus:border-white/80 focus:bg-white/62 focus:ring-2 focus:ring-[hsl(var(--reservation-accent)/0.18)]';

  const backgroundClass =
    'relative min-h-screen overflow-hidden bg-[hsl(var(--reservation-bg))] font-sans text-[hsl(var(--reservation-ink))] antialiased';
  const backgroundStyle = {
    ...reservationTheme,
    backgroundImage:
      'radial-gradient(circle at 50% 20%, hsl(var(--reservation-glow)/0.2), transparent 18rem), linear-gradient(145deg, hsl(var(--reservation-wash)) 0%, hsl(var(--reservation-bg)) 46%, hsl(34 20% 86%) 100%)',
  };
  const consoleClass =
    // Mobile: bottom sheet — opaque enough for Safari, scrollable, and safe-area aware.
    'absolute bottom-0 left-1/2 -translate-x-1/2 z-10 w-full max-h-[min(68dvh,36rem)] sm:max-h-[50dvh] lg:max-h-[50dvh] overflow-y-auto scrollbar-none rounded-t-[2.25rem] rounded-b-none border border-white/70 bg-[hsl(var(--reservation-wash)/0.96)] px-3.5 pb-[calc(env(safe-area-inset-bottom)+6.5rem)] pt-2 shadow-[0_-24px_80px_rgba(0,0,0,0.18)] backdrop-blur-2xl ' +
    // Tablet+: bottom sheet styling and layout spacing
    'sm:p-6 sm:pb-8 sm:max-w-[48rem] ' +
    // Desktop: larger, compact reservation console that fits in one viewport.
    'lg:bottom-4 lg:max-h-[calc(100dvh-2rem)] lg:max-w-[74rem] lg:overflow-y-auto lg:rounded-[1.75rem] lg:px-4 lg:py-3';
  const glassCardClass =
    'rounded-[1.6rem] border border-white/[0.62] bg-white/[0.58] shadow-sm backdrop-blur-2xl sm:bg-white/[0.34]';

  const selectionKey = `${selectedDate ? formatDateParam(selectedDate) : ''}|${selectedTime}|${partySize}`;

  // Les conditions d'empreinte s'affichent avant les coordonnées ; le serveur les revérifie.
  const guaranteeDate = selectedDate ? formatDateParam(selectedDate) : '';
  const guaranteeSlug = restaurant?.slug || restaurantId;
  useEffect(() => {
    setCardGuarantee(null);
    setCardGuaranteeAccepted(false);
    if (step !== 2 || modification || testBooking || !guaranteeDate || !guaranteeSlug) return;
    let cancelled = false;
    publicApiFetch<{ cardGuarantee: CardGuaranteeTerms | null }>(
      'GET',
      `public/r/${encodeURIComponent(guaranteeSlug)}/card-guarantee?date=${guaranteeDate}&partySize=${partySize}`,
    )
      .then((data) => {
        if (!cancelled) setCardGuarantee(data.cardGuarantee ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [step, modification, testBooking, guaranteeDate, guaranteeSlug, partySize]);
  const waitingListOffer = waitingListOfferKey === selectionKey;

  const consentChannels: MarketingConsentChannel[] = [
    ...(EMAIL_PATTERN.test(customerEmail.trim()) ? (['EMAIL'] as const) : []),
    ...(customerPhone.trim() ? (['SMS'] as const) : []),
  ];

  async function handleJoinWaitingList() {
    if (!restaurant || !selectedDate || !selectedTime || waitingListBusy) return;
    setWaitingListBusy(true);
    setError('');
    try {
      const result = await publicApiFetch<{
        entryId: string;
        position: number;
        actionToken: string;
      }>('POST', `public/r/${encodeURIComponent(restaurant.slug || restaurantId)}/waiting-list`, {
        date: formatDateParam(selectedDate),
        time: selectedTime,
        partySize,
        customer: {
          firstName: customerName.trim(),
          phone: toInternationalPhone(customerPhone),
          ...(customerEmail.trim() ? { email: customerEmail.trim() } : {}),
        },
        source: 'web',
      });
      setWaitingListResult(result);
      setWaitingListOfferKey(null);
    } catch (err) {
      const code = err instanceof PublicApiError ? err.data.error : undefined;
      if (code === 'slot_now_available') {
        setWaitingListOfferKey(null);
        setError('Une table vient de se libérer : vous pouvez confirmer la réservation.');
      } else if (code === 'waiting_list_full') {
        setError("La liste d'attente est complète pour ce créneau.");
      } else {
        setError(getErrorMessage(err, "Impossible de rejoindre la liste d'attente."));
      }
    } finally {
      setWaitingListBusy(false);
    }
  }

  async function handleCancelWaitingList() {
    if (!restaurant || !waitingListResult || waitingListBusy) return;
    setWaitingListBusy(true);
    setError('');
    try {
      const token = encodeURIComponent(waitingListResult.actionToken);
      await publicApiFetch(
        'DELETE',
        `public/r/${encodeURIComponent(restaurant.slug || restaurantId)}/waiting-list/${encodeURIComponent(waitingListResult.entryId)}?token=${token}`,
      );
      setWaitingListCancelled(true);
    } catch (err) {
      const code = err instanceof PublicApiError ? err.data.error : undefined;
      setError(
        code === 'already_promoted'
          ? 'Votre inscription a déjà été transformée en réservation.'
          : getErrorMessage(err, "Impossible d'annuler l'inscription."),
      );
    } finally {
      setWaitingListBusy(false);
    }
  }

  // Submit Reservation
  async function handleSubmit() {
    if (!restaurant) {
      setError('Restaurant introuvable. Rafraîchissez la page.');
      return;
    }
    if (modification) {
      const proposal = modificationSlots.find((slot) => slot.time === selectedTime);
      if (!proposal || submitting) return;
      setSubmitting(true);
      modification.onBusyChange(true);
      setError('');
      try {
        await modification.confirm(proposal.proposalToken);
      } catch (err) {
        setError(getErrorMessage(err, 'La modification n’a pas pu être confirmée.'));
        setStep(1);
        setSelectedTime('');
        setAvailabilityRetryNonce((value) => value + 1);
      } finally {
        setSubmitting(false);
        modification.onBusyChange(false);
      }
      return;
    }
    if (!selectedDate || !selectedTime || !customerName || !customerPhone) {
      setError('Veuillez remplir tous les champs requis');
      return;
    }

    const phoneDigits = customerPhone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
      setError('Veuillez entrer un numéro de téléphone valide (10 chiffres minimum).');
      return;
    }

    setSubmitting(true);
    setError('');

    const [hours, minutes] = selectedTime.split(':').map(Number);
    const reservedAt = new Date(selectedDate);
    reservedAt.setHours(hours, minutes, 0, 0);

    try {
      const phone = toInternationalPhone(customerPhone);
      // Une case cochée dont la coordonnée a ensuite été effacée n'est pas envoyée.
      const consentEmail = marketingConsent.EMAIL && consentChannels.includes('EMAIL');
      const consentSms = marketingConsent.SMS && consentChannels.includes('SMS');
      // Public bookings use a signed hold, never the internal service endpoint.
      const path = `public/r/${encodeURIComponent(restaurant.slug || restaurantId)}`;
      const testFields = testBooking ? { testBookingToken } : {};
      const hold = await publicApiFetch<{ holdToken: string }>('POST', `${path}/hold`, {
        date: formatDateParam(selectedDate),
        time: selectedTime,
        partySize,
        source: 'web',
        ...testFields,
      });
      const confirmation = await publicApiFetch<{
        reservationId: string;
        status: string;
        managementUrl?: string;
        whatsappWithdrawalToken?: string;
        cardGuarantee?: { checkoutUrl: string | null; pageUrl: string };
      }>('POST', `${path}/confirm`, {
        holdToken: hold.holdToken,
        ...(cardGuarantee && cardGuaranteeAccepted
          ? { cardGuarantee: { accepted: true, totalAmount: cardGuarantee.totalAmount } }
          : {}),
        customer: { firstName: customerName, phone, email: customerEmail || undefined },
        source: 'web',
        ...testFields,
        ...(!testBooking && giftCardCode ? { giftCardCode } : {}),
        ...(!testBooking && restaurant.whatsappReminderOptInEnabled
          ? {
              whatsappReminderConsent: {
                accepted: whatsappOptIn,
                version: 'whatsapp-reminder-2026-10-17',
              },
            }
          : {}),
        ...(!testBooking && marketingAttributionToken ? { marketingAttributionToken } : {}),
        ...(!testBooking && (consentEmail || consentSms)
          ? {
              marketingConsent: {
                ...(consentEmail ? { email: true } : {}),
                ...(consentSms ? { sms: true } : {}),
                version: MARKETING_CONSENT_VERSION,
              },
            }
          : {}),
      });
      if (confirmation.status === 'awaiting_card_guarantee' && confirmation.cardGuarantee) {
        const target = confirmation.cardGuarantee.checkoutUrl ?? confirmation.cardGuarantee.pageUrl;
        setCardGuaranteeUrl(target);
        openTopLevel(target);
        return;
      }
      const res: ConfirmedReservation = {
        id: confirmation.reservationId,
        restaurantId: restaurant.id,
        reservedAt: reservedAt.toISOString(),
        partySize,
        customerName,
        customerPhone: phone,
        status: confirmation.status,
        managementUrl: confirmation.managementUrl,
        whatsappWithdrawalToken: confirmation.whatsappWithdrawalToken,
      };

      setConfirmedReservation(res);
      setSuccess(true);
    } catch (err: unknown) {
      const message = getErrorMessage(err, '');
      if (
        err instanceof PublicApiError &&
        err.status === 409 &&
        message === 'card_guarantee_required'
      ) {
        setCardGuarantee((err.data.cardGuarantee as CardGuaranteeTerms | undefined) ?? null);
        setCardGuaranteeAccepted(false);
        setError(
          'Les conditions d’empreinte bancaire ont changé. Lisez-les et cochez la case pour continuer.',
        );
      } else if (
        err instanceof PublicApiError &&
        err.status === 409 &&
        message === 'no_table_available'
      ) {
        setWaitingListOfferKey(
          err.data.waitingListEnabled === true && !testBooking ? selectionKey : null,
        );
        setError(
          "Ce créneau vient d'être réservé. Choisissez une autre heure" +
            (err.data.waitingListEnabled === true && !testBooking
              ? " ou inscrivez-vous sur la liste d'attente."
              : '.'),
        );
      } else if (message === 'SLOT_NOT_AVAILABLE') {
        setError(
          "Ce créneau horaire vient de se faire réserver ou n'est plus disponible. Veuillez choisir une autre heure.",
        );
      } else {
        setError(message || 'Une erreur est survenue lors de la réservation.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const bookingConfirmation = useMemo(() => {
    if (!confirmedReservation || !restaurant || !selectedDate) return null;
    return {
      reservation: {
        restaurantName: restaurant.name,
        restaurantPhone: restaurant.phoneNumber ?? null,
        restaurantAddress: restaurant.formattedAddress ?? restaurant.address,
        startsAt: confirmedReservation.reservedAt,
        date: formatDateParam(selectedDate),
        time: selectedTime,
        partySize: confirmedReservation.partySize,
        state: confirmedReservation.status.toUpperCase(),
        test: testBooking,
        whatsappReminder: {
          visible: Boolean(confirmedReservation.whatsappWithdrawalToken),
          enabled: Boolean(confirmedReservation.whatsappWithdrawalToken),
        },
      } satisfies Reservation,
      managementUrl: confirmedReservation.managementUrl,
      withdrawWhatsapp: confirmedReservation.whatsappWithdrawalToken
        ? async () => {
            await publicApiFetch(
              'POST',
              `public/r/${encodeURIComponent(restaurant.slug || restaurantId)}/whatsapp-consent/withdraw`,
              {
                reservationId: confirmedReservation.id,
                token: confirmedReservation.whatsappWithdrawalToken,
              },
            );
          }
        : undefined,
    };
  }, [confirmedReservation, restaurant, selectedDate, selectedTime, testBooking, restaurantId]);

  if (loading) {
    return (
      <div className={backgroundClass} style={backgroundStyle}>
        <div
          className="absolute inset-x-0 top-0 z-[1] h-[50dvh] bg-cover bg-center lg:h-[42dvh]"
          style={{
            backgroundImage: `linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.45), rgba(0,0,0,0.75)), url("${FALLBACK_RESTAURANT_IMAGE}")`,
          }}
        />
        <div className="absolute inset-x-0 top-0 z-[2] flex h-[46dvh] flex-col items-center justify-center px-6 text-center lg:h-[24dvh]">
          <Skeleton className="h-4 w-20 bg-white/30" />
          <Skeleton className="mt-2 h-10 w-48 bg-white/30" />
          <Skeleton className="mt-2 h-4 w-32 bg-white/30" />
        </div>
        <main className="relative h-[100dvh] w-full overflow-hidden">
          <div className={consoleClass}>
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <Skeleton className="h-11 w-11 rounded-full bg-white/50" />
                  <Skeleton className="h-4 w-36 bg-white/50" />
                </div>
                <Skeleton className="h-8 w-28 rounded-full bg-white/50" />
              </div>
              <div className="space-y-2">
                <Skeleton className="h-14 w-36 bg-white/50" />
                <Skeleton className="h-14 w-48 bg-white/50" />
              </div>
              <div className={cn(glassCardClass, 'space-y-4 p-4')}>
                <Skeleton className="h-4 w-32 bg-white/50" />
                <div className="flex gap-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <Skeleton key={i} className="h-10 w-10 rounded-full bg-white/50" />
                  ))}
                </div>
                <div className="flex gap-2">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-16 w-14 rounded-2xl bg-white/50" />
                  ))}
                </div>
              </div>
              <Skeleton className="h-[3.25rem] w-full rounded-full bg-white/50" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  if (error && !restaurant) {
    return (
      <div className={backgroundClass} style={backgroundStyle}>
        <main className="relative h-[100dvh] w-full overflow-hidden">
          <div
            className={cn(
              consoleClass,
              'p-6 text-center flex flex-col items-center justify-center min-h-[30dvh]',
            )}
          >
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-destructive/50 bg-destructive/10 text-destructive">
              <AlertCircle size={28} />
            </div>
            <h1 className="text-xl font-bold text-[hsl(var(--reservation-ink))]">Oups !</h1>
            <p className="mt-2 text-sm text-[hsl(var(--reservation-soft))]">{error}</p>
          </div>
        </main>
      </div>
    );
  }

  const restaurantImage =
    restaurant?.heroImageUrl ||
    restaurant?.coverImageUrl ||
    restaurant?.imageUrl ||
    FALLBACK_RESTAURANT_IMAGE;
  const cardImage =
    restaurant?.imageUrl || restaurant?.coverImageUrl || restaurantImage || FALLBACK_DISH_IMAGE;
  const restaurantSubtitle =
    restaurant?.cuisine && restaurant?.city
      ? `${restaurant.cuisine} · ${restaurant.city}`
      : restaurant?.tags?.length
        ? restaurant.tags.slice(0, 3).join(' · ')
        : restaurant?.city || restaurant?.address || 'Dîner · Terrasse · Cocktails';
  const selectedDateLong = selectedDate ? formatLongFrenchDate(selectedDate) : 'Date à choisir';
  const selectedDateShort = selectedDate ? formatShortFrenchDate(selectedDate) : 'Date';
  const hasService = timeSlots.length > 0;
  const selectedOpeningSlots = selectedDate ? getSlotsForDate(selectedDate) : [];
  const isOpen = Boolean(modification) || selectedOpeningSlots.length > 0;
  const isFullyBooked =
    !availabilityRefreshing && !availabilityError && isOpen && timeSlots.length === 0;
  const serviceLabel =
    dinnerSlots.length > 0 && lunchSlots.length > 0
      ? 'Table'
      : dinnerSlots.length > 0
        ? 'Dîner'
        : lunchSlots.length > 0
          ? 'Déjeuner'
          : 'Réservation';
  const isOriginalSelection = Boolean(
    modification &&
    selectedDate &&
    formatDateParam(selectedDate) === modification.date &&
    partySize === modification.partySize &&
    selectedTime === modification.time,
  );
  const reservationStatus = isOriginalSelection
    ? 'Confirmée'
    : selectedTime
      ? modification
        ? 'Nouveau choix'
        : 'À confirmer'
      : availabilityError
        ? 'Disponibilités indisponibles'
        : availabilityRefreshing
          ? 'Vérification en cours'
          : isFullyBooked
            ? 'Complet'
            : hasService
              ? 'Créneaux disponibles'
              : isOpen
                ? 'Ouvert'
                : 'Fermé';
  const reservationTitle = selectedTime
    ? `Table à ${selectedTime.replace(':', 'h')}`
    : isFullyBooked
      ? 'Toutes les tables sont réservées'
      : isOpen
        ? `${serviceLabel} au ${restaurant?.name || 'restaurant'}`
        : 'Choisissez une autre date';
  const nextOpeningDayLabel = nextOpeningDay ? formatLongFrenchDate(nextOpeningDay) : '';

  const canProceed =
    step === 1
      ? Boolean(selectedTime)
      : Boolean(
          !submitting &&
          !cardGuaranteeUrl &&
          (modification || (customerName && customerPhone)) &&
          (!cardGuarantee || cardGuaranteeAccepted),
        );
  const primaryCtaLabel =
    step === 1
      ? availabilityRefreshing
        ? 'Chargement des créneaux...'
        : availabilityError
          ? 'Réessayer'
          : isOriginalSelection
            ? 'Continuer'
            : selectedTime
              ? modification
                ? `Continuer · ${selectedTime.replace(':', 'h')}`
                : `Continuer · ${selectedTime.replace(':', 'h')}`
              : isFullyBooked
                ? nextOpeningDay
                  ? 'Voir le prochain jour ouvert'
                  : 'Choisir une autre date'
                : hasService
                  ? 'Sélectionnez un horaire'
                  : nextOpeningDay
                    ? 'Voir le prochain jour ouvert'
                    : 'Choisir une autre date'
      : submitting
        ? 'Validation...'
        : modification
          ? 'Confirmer la modification'
          : cardGuarantee
            ? 'Continuer vers l’enregistrement de la carte'
            : 'Valider la réservation';
  const unchanged = Boolean(
    modification &&
    selectedDate &&
    formatDateParam(selectedDate) === modification.date &&
    partySize === modification.partySize &&
    selectedTime === modification.time,
  );
  const primaryCtaDisabled =
    step === 1
      ? availabilityRefreshing ||
        unchanged ||
        Boolean(modification && !selectedTime && !availabilityError)
      : !canProceed;

  function goToNextOpeningDay() {
    if (!nextOpeningDay) return;
    triggerHaptic();
    requestedSlotRef.current = null;
    setSelectionNotice('');
    setSelectedDate(nextOpeningDay);
    setSelectedTime('');
    setActiveSection('time');
    setTimeout(() => {
      timeSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    }, 80);
  }

  function handlePrimaryAction() {
    if (step === 1 && availabilityError) {
      setAvailabilityRetryNonce((nonce) => nonce + 1);
      return;
    }
    if (step === 1 && !selectedTime && (!hasService || isFullyBooked)) {
      if (nextOpeningDay) {
        goToNextOpeningDay();
      } else {
        setActiveSection('date');
        dateSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      }
      return;
    }

    if (step === 1 && hasService && !selectedTime && !isFullyBooked) {
      setError('Choisissez un créneau horaire pour continuer.');
      setActiveSection('time');
      setTimeout(() => {
        timeSectionRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
      }, 80);
      return;
    }

    if (step === 1 && selectedTime) {
      triggerHaptic();
      setStep(2);
      setError('');
      return;
    }

    if (step === 2) {
      handleSubmit();
    }
  }

  const giftCardOverlay = (
    <div style={reservationTheme}>
      {showGiftCard && (
        <div
          className="fixed inset-0 z-[100] flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center"
          onClick={() => setShowGiftCard(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Offrir une carte cadeau"
        >
          <div
            className="relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:max-w-md sm:rounded-3xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[hsl(var(--reservation-line))] px-4 py-3">
              <div className="flex items-center gap-2">
                <Gift size={18} className="text-[hsl(var(--reservation-glow))]" />
                <span className="text-[15px] font-extrabold text-[hsl(var(--reservation-ink))]">
                  Carte cadeau
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowGiftCard(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full text-[hsl(var(--reservation-soft))] transition-colors hover:bg-black/5"
                aria-label="Fermer"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {giftCardUrl && (
                <iframe
                  ref={giftCardIframeRef}
                  src={giftCardUrl}
                  title="Offrir une carte cadeau"
                  className="block w-full border-0"
                  style={{ height: giftCardHeight ? `${giftCardHeight}px` : '70dvh' }}
                  loading="lazy"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  if (success && confirmedReservation && restaurant && selectedDate) {
    return (
      <ReservationView
        confirmation={bookingConfirmation ?? undefined}
        actions={
          <>
            <button
              type="button"
              onClick={() => {
                requestedSlotRef.current = null;
                setSelectionNotice('');
                setSuccess(false);
                setStep(1);
                setSelectedTime('');
                setCustomerName('');
                setCustomerPhone('');
                setCustomerEmail('');
                setPartySize(2);
                setError('');
                setConfirmedReservation(null);
                setWhatsappOptIn(false);
                setSelectedDate(new Date());
              }}
              className="min-h-11 text-xs text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
            >
              Faire une autre réservation
            </button>
            {!isEmbedded && (
              <Link
                href={`/restaurant/${restaurant.slug ?? restaurantId}${testBooking ? `?${new URLSearchParams({ testBooking: testBookingToken })}` : ''}`}
                className="min-h-11 content-center text-xs text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
              >
                Retour
              </Link>
            )}
            {!testBooking && restaurant.giftCardEnabled !== false && (
              <button
                type="button"
                onClick={() => setShowGiftCard(true)}
                className="min-h-11 text-xs text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
              >
                Offrir une carte cadeau
              </button>
            )}
            {giftCardOverlay}
          </>
        }
      />
    );
  }

  return (
    <div className={backgroundClass} style={backgroundStyle}>
      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white/30 to-transparent" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[34rem] w-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[hsl(var(--reservation-glow)/0.11)] blur-3xl" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,hsl(var(--reservation-ink)/0.025)_1px,transparent_1px)] bg-[length:96px_96px] opacity-30" />

      <main className="relative h-[100dvh] w-full overflow-hidden">
        <div
          className={cn('absolute inset-x-0 top-0 z-[1] h-[50dvh] bg-cover bg-center')}
          style={{
            backgroundImage: `linear-gradient(rgba(0,0,0,0.2), rgba(0,0,0,0.45), rgba(0,0,0,0.75)), url("${restaurantImage}")`,
          }}
        />

        <div
          className={cn(
            'absolute inset-x-0 top-0 z-[2] flex h-[46dvh] flex-col items-center justify-center px-6 text-center',
          )}
        >
          {!isEmbedded && (
            <Link
              href={`/restaurant/${restaurant?.slug ?? restaurantId}${testBooking ? `?${new URLSearchParams({ testBooking: testBookingToken })}` : ''}`}
              className="absolute left-4 top-4 z-[3] inline-flex items-center gap-1.5 rounded-full border border-white/40 bg-white/25 px-3 py-2 text-sm font-semibold text-white shadow-sm backdrop-blur-2xl transition-all duration-200 hover:bg-white/35 hover:gap-2.5"
            >
              <ArrowLeft size={16} />
              Retour
            </Link>
          )}
          <div className="mb-2 flex flex-wrap items-center justify-center gap-2">
            <p className="rounded-full bg-[hsl(var(--reservation-scrim)/0.3)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--reservation-panel)/0.9)] backdrop-blur-md">
              {success ? 'Confirmation' : modification ? 'Modifier la réservation' : 'Réserver'}
            </p>
            {(modification?.demo || testBooking) && (
              <span className="rounded-full bg-[hsl(var(--reservation-scrim)/0.3)] px-2.5 py-1.5 text-[10px] font-medium text-[hsl(var(--reservation-panel)/0.85)] backdrop-blur-md">
                {testBooking ? 'Réservation test' : 'Mode démo'}
              </span>
            )}
          </div>
          <h1 className="mt-1 text-[2.35rem] sm:text-4xl md:text-5xl font-black leading-none tracking-[-0.04em] text-white drop-shadow-lg">
            {restaurant?.name || 'Restaurant'}
          </h1>
          {restaurant?.address ? (
            modification?.demo ? (
              <p className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-[hsl(var(--reservation-panel)/0.85)]">
                <MapPin size={14} aria-hidden="true" />
                {restaurant.address}
              </p>
            ) : (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${restaurant.name}, ${restaurant.address}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
                className="mt-3 inline-flex min-h-11 max-w-md items-center gap-1.5 text-sm font-medium text-[hsl(var(--reservation-panel)/0.85)] transition-all duration-200 hover:text-[hsl(var(--reservation-panel))] hover:underline"
              >
                <MapPin size={14} aria-hidden="true" />
                {restaurant.address}
              </a>
            )
          ) : (
            <p className="mt-3 text-sm font-medium text-[hsl(var(--reservation-panel)/0.85)]">
              {restaurantSubtitle}
            </p>
          )}
        </div>
        <section
          className={cn(
            consoleClass,
            modification && 'pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pb-8',
            modification && 'lg:h-[min(26rem,calc(100dvh-2rem))]',
          )}
        >
          {/* Drag handle — mobile only */}
          <div className="mx-auto mb-1.5 mt-0.5 h-1 w-10 shrink-0 rounded-full bg-black/10 sm:hidden" />

          {/* Progress bar — mobile only */}
          <div className="mx-auto mb-3 grid grid-cols-2 gap-2 px-1 sm:hidden">
            <div className="h-1.5 rounded-full bg-[hsl(var(--reservation-ink))]" />
            <div
              className={cn(
                'h-1.5 rounded-full transition-colors',
                step === 2 ? 'bg-[hsl(var(--reservation-ink))]' : 'bg-black/10',
              )}
            />
          </div>

          <div className="pointer-events-none absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/80 to-transparent" />
          <div className="pointer-events-none absolute -top-24 left-1/2 h-48 w-48 -translate-x-1/2 rounded-full bg-[hsl(var(--reservation-glow)/0.16)] blur-3xl" />

          <div className="relative z-10 space-y-2 sm:space-y-6 lg:space-y-1">
            {modification?.close && (
              <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                <button
                  type="button"
                  disabled={submitting}
                  onClick={modification.close}
                  className="inline-flex min-h-11 items-center gap-1.5 text-xs font-medium text-[hsl(var(--reservation-soft))] transition-all duration-200 hover:text-[hsl(var(--reservation-ink))] disabled:opacity-50"
                >
                  <ArrowLeft size={14} aria-hidden="true" />
                  Quitter sans modifier
                </button>
                {modification.cancel && (
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={modification.cancel}
                    className="min-h-11 text-xs text-[hsl(var(--reservation-soft))] underline underline-offset-4 transition-all duration-200 hover:text-[hsl(var(--reservation-ink))] disabled:opacity-50"
                  >
                    Annuler ma réservation
                  </button>
                )}
              </div>
            )}

            {/* Header tablet */}
            <header className="hidden items-center justify-between gap-3 sm:flex lg:hidden">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/70 bg-white/50 text-[hsl(var(--reservation-soft))] shadow-sm backdrop-blur-2xl">
                  <Utensils size={18} />
                </div>
                <div className="min-w-0">
                  <p className="truncate text-sm font-bold text-[hsl(var(--reservation-ink))]">
                    {restaurant?.name || 'Restaurant'}
                  </p>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--reservation-muted))]">
                    {success
                      ? 'Confirmation'
                      : modification
                        ? 'Modifier la réservation'
                        : 'Réserver'}
                  </p>
                </div>
              </div>
            </header>

            {testBooking && (
              <p
                role="status"
                className="rounded-2xl border border-border bg-background p-3 text-sm text-foreground"
              >
                Réservation test · supprimée automatiquement sous 24 h. Les notifications dépendent
                les options du restaurant ; cette réservation n’apparaîtra pas dans votre planning.
              </p>
            )}

            {
              <div
                className={cn(
                  'space-y-2 lg:grid lg:grid-cols-[minmax(18rem,0.74fr)_minmax(0,1.76fr)] lg:gap-5 lg:space-y-0',
                )}
              >
                {/* Colonne gauche */}
                <div className="space-y-3 sm:space-y-4 lg:space-y-3">
                  <>
                    <div className="relative overflow-hidden rounded-[1.75rem] border border-white/70 bg-[hsl(var(--reservation-line)/0.72)] p-3 shadow-sm backdrop-blur-2xl sm:rounded-[2rem] sm:p-4 lg:rounded-[1.35rem] lg:p-3">
                      <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[hsl(var(--reservation-glow)/0.16)] blur-2xl" />
                      <p className="pb-3 text-[10px] font-bold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))] sm:text-xs">
                        {step === 2
                          ? modification
                            ? 'Votre nouveau choix'
                            : 'Résumé'
                          : 'Votre réservation'}
                      </p>
                      <div className="relative flex items-center gap-3">
                        <div
                          className="h-24 w-24 shrink-0 rounded-[1.45rem] bg-cover bg-center shadow-sm sm:h-28 sm:w-28 sm:rounded-[1.6rem] lg:h-[4.9rem] lg:w-[4.9rem] lg:rounded-[1.1rem]"
                          style={{ backgroundImage: `url("${cardImage}")` }}
                        />
                        <div className="min-w-0 flex-1">
                          {!(modification && step === 2) && (
                            <span
                              className={cn(
                                'inline-flex rounded-full bg-white/75 px-3 py-1 text-[11px] font-extrabold text-[hsl(var(--reservation-ink))] shadow-sm backdrop-blur-xl',
                                reservationStatus === 'Confirmée'
                                  ? 'bg-[hsl(var(--reservation-confirmed-bg))] text-[hsl(var(--reservation-confirmed))]'
                                  : reservationStatus === 'Créneaux disponibles'
                                    ? 'text-[hsl(var(--reservation-success))]'
                                    : reservationStatus === 'Fermé'
                                      ? 'text-[hsl(var(--reservation-soft))]'
                                      : reservationStatus === 'Complet'
                                        ? 'text-red-600'
                                        : 'text-[hsl(var(--reservation-ink))]',
                              )}
                            >
                              {reservationStatus}
                            </span>
                          )}
                          <h2 className="mt-2 line-clamp-2 text-[17px] font-black leading-tight tracking-[-0.03em] text-[hsl(var(--reservation-ink))] sm:text-lg lg:text-[15px]">
                            {reservationTitle}
                          </h2>
                          <p className="mt-1 text-[12px] font-semibold leading-snug text-[hsl(var(--reservation-soft))] sm:text-sm lg:text-xs">
                            {modification ? (
                              <>
                                <span className="block">{selectedDateLong}</span>
                                <span className="block whitespace-nowrap">
                                  {partySize} {partySize > 1 ? 'personnes' : 'personne'}
                                </span>
                              </>
                            ) : (
                              <>
                                {selectedDateLong} ·{' '}
                                <span className="whitespace-nowrap">
                                  {partySize} {partySize > 1 ? 'personnes' : 'personne'}
                                </span>
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div
                      className={cn(
                        'hidden grid-cols-[minmax(0,1.2fr)_auto_minmax(0,1fr)] items-start gap-3 rounded-[1.4rem] border border-white/60 bg-white/40 p-3 shadow-sm backdrop-blur-2xl sm:grid lg:rounded-[1.1rem] lg:p-3',
                        modification && step === 2 && 'grid-cols-1',
                      )}
                    >
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))]">
                          Ambiance
                        </p>
                        <div className="mt-2 flex items-center">
                          {(restaurant?.galleryImages?.length
                            ? restaurant.galleryImages.slice(0, 3)
                            : [cardImage, restaurantImage, FALLBACK_DISH_IMAGE]
                          ).map((img, idx) => (
                            <div
                              key={idx}
                              className="-mr-2 h-8 w-8 rounded-full border-2 border-white/80 bg-cover bg-center shadow-sm lg:h-7 lg:w-7"
                              style={{ backgroundImage: `url("${img}")` }}
                            />
                          ))}
                          <span className="ml-3 text-[11px] font-extrabold text-[hsl(var(--reservation-soft))]">
                            {restaurant?.tags?.slice(0, 2).join(' · ') || 'Terrasse'}
                          </span>
                        </div>
                      </div>
                      {!(modification && step === 2) && (
                        <>
                          <div className="min-h-12 w-px self-stretch bg-[hsl(var(--reservation-line))]" />
                          <div>
                            <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))]">
                              Votre date
                            </p>
                            <p className="mt-2 text-sm font-black leading-tight text-[hsl(var(--reservation-ink))]">
                              {selectedDateShort}
                            </p>
                            <p className="text-xs font-semibold text-[hsl(var(--reservation-soft))]">
                              {partySize} pers.
                            </p>
                          </div>
                        </>
                      )}
                    </div>

                    {step === 2 && !modification && (
                      <div className={cn(glassCardClass, 'flex overflow-hidden')}>
                        <div className="flex w-[6.5rem] flex-col items-center justify-center border-r border-white/50 bg-white/24 p-3 text-center">
                          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[hsl(var(--reservation-muted))]">
                            {selectedDate && FRENCH_DAYS[selectedDate.getDay()].substring(0, 3)}
                          </span>
                          <span className="my-0.5 text-3xl font-black tracking-normal text-[hsl(var(--reservation-ink))]">
                            {selectedDate?.getDate()}
                          </span>
                          <span className="text-[11px] font-semibold text-[hsl(var(--reservation-soft))]">
                            {selectedTime.replace(':', 'h')}
                          </span>
                        </div>
                        <div className="min-w-0 flex-1 p-4">
                          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[hsl(var(--reservation-accent))]">
                            Résumé
                          </p>
                          <h4 className="mt-1 truncate text-sm font-extrabold text-[hsl(var(--reservation-ink))]">
                            {restaurant?.name}
                          </h4>
                          <p className="mt-1 text-xs font-semibold text-[hsl(var(--reservation-soft))]">
                            {partySize} personne(s)
                          </p>
                        </div>
                      </div>
                    )}
                  </>
                </div>

                {/* Colonne droite */}
                <div
                  className={cn(
                    'space-y-4 pb-2 sm:space-y-5 lg:space-y-1.5 lg:pb-0 lg:pt-2',
                    modification && 'lg:pl-0 lg:pr-0',
                  )}
                >
                  {error && (
                    <div
                      ref={revealOnMount}
                      role="alert"
                      className="flex items-center gap-2 rounded-2xl border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
                    >
                      <AlertCircle size={16} className="shrink-0" />
                      <span>{error}</span>
                    </div>
                  )}

                  {(waitingListOffer || waitingListResult) && !modification && (
                    <div
                      ref={error ? undefined : revealOnMount}
                      role="status"
                      aria-live="polite"
                      className="space-y-3 rounded-2xl border border-white/70 bg-white/45 p-4 text-sm text-[hsl(var(--reservation-ink))] shadow-sm backdrop-blur-2xl"
                    >
                      <p className="font-black">Liste d&apos;attente</p>
                      {waitingListResult ? (
                        waitingListCancelled ? (
                          <p>Votre inscription a été annulée.</p>
                        ) : (
                          <>
                            <p>
                              Vous êtes inscrit (position indicative :{' '}
                              <strong>{waitingListResult.position}</strong>). Vous serez prévenu par
                              e-mail ou SMS si une table se libère.
                            </p>
                            <button
                              type="button"
                              onClick={() => void handleCancelWaitingList()}
                              disabled={waitingListBusy}
                              className="rounded-full border border-[hsl(var(--reservation-muted))] px-4 py-2 font-semibold transition-all duration-200 hover:bg-black/5 disabled:opacity-50"
                            >
                              {waitingListBusy ? 'Annulation…' : 'Annuler mon inscription'}
                            </button>
                          </>
                        )
                      ) : (
                        <>
                          <p>
                            {partySize} {partySize > 1 ? 'personnes' : 'personne'} ·{' '}
                            {selectedDateLong} · {selectedTime.replace(':', 'h')}
                          </p>
                          <button
                            type="button"
                            onClick={() => void handleJoinWaitingList()}
                            disabled={waitingListBusy}
                            className="rounded-full bg-[hsl(var(--reservation-ink))] px-4 py-2 font-semibold text-[hsl(var(--reservation-panel))] transition-all duration-200 hover:opacity-90 disabled:opacity-50"
                          >
                            {waitingListBusy ? 'Inscription…' : "Rejoindre la liste d'attente"}
                          </button>
                        </>
                      )}
                    </div>
                  )}

                  {step === 1 ? (
                    <div className="animate-in fade-in slide-in-from-bottom-4 duration-300 space-y-4 sm:space-y-5 lg:space-y-2">
                      <div
                        className={cn(
                          'space-y-2 sm:space-y-2.5 lg:space-y-1 transition-opacity duration-200',
                          activeSection !== 'party' && 'opacity-90',
                        )}
                        onClickCapture={() => setActiveSection('party')}
                      >
                        <label className={cn(labelClass)}>
                          <Users size={13} />
                          Nombre de personnes
                        </label>
                        <div className="scrollbar-none grid grid-flow-col auto-cols-fr gap-2 overflow-x-auto pb-1 lg:overflow-visible lg:pb-0">
                          {Array.from(
                            { length: Math.max(maxPartySize, partySize) },
                            (_, i) => i + 1,
                          ).map((size) => (
                            <button
                              key={size}
                              type="button"
                              aria-label={`${size} ${size > 1 ? 'personnes' : 'personne'}`}
                              aria-pressed={partySize === size}
                              onClick={() => {
                                triggerHaptic();
                                requestedSlotRef.current = null;
                                setSelectionNotice('');
                                if (size !== partySize) setAvailabilityRefreshing(true);
                                setPartySize(size);
                                if (!modification) setSelectedTime('');
                                setError('');
                                setActiveSection('date');
                              }}
                              className={cn(
                                'h-12 min-w-11 rounded-full text-[15px] font-extrabold transition-all duration-200 active:scale-95 sm:h-14 sm:text-base lg:h-11',
                                softPillClass,
                                partySize === size ? selectedPillClass : '',
                              )}
                            >
                              {size}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div
                        ref={dateSectionRef}
                        className={cn(
                          'space-y-2 sm:space-y-2.5 lg:space-y-1 transition-opacity duration-200',
                          activeSection !== 'date' && 'opacity-90',
                        )}
                        onClickCapture={() => setActiveSection('date')}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                          <span className={cn(labelClass)}>
                            <CalendarIcon size={13} /> Sélectionner la date
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              aria-label="Semaine précédente"
                              disabled={!days.length || formatDateParam(days[0]) <= dateBounds.min}
                              onClick={() => moveWeek(-1)}
                              className="flex h-11 w-9 items-center justify-center rounded-full text-[hsl(var(--reservation-soft))] transition-all duration-200 hover:bg-[hsl(var(--reservation-line)/0.5)] disabled:opacity-30"
                            >
                              <ChevronLeft size={16} />
                            </button>
                            <ReservationDatePicker
                              theme={reservationTheme}
                              min={dateBounds.min}
                              max={dateBounds.max}
                              value={selectedDate ? formatDateParam(selectedDate) : null}
                              onChange={(value) => {
                                const date = parseRequestedDate(value, new Date());
                                if (!date || value > dateBounds.max) return;
                                requestedSlotRef.current = null;
                                setSelectionNotice('');
                                setSelectedDate(date);
                                setWeekOffset(null);
                                if (!modification) setSelectedTime('');
                                setError('');
                                setActiveSection('time');
                              }}
                            />
                            <button
                              type="button"
                              aria-label="Semaine suivante"
                              disabled={
                                !days.length ||
                                formatDateParam(days[days.length - 1]) >= dateBounds.max
                              }
                              onClick={() => moveWeek(1)}
                              className="flex h-11 w-9 items-center justify-center rounded-full text-[hsl(var(--reservation-soft))] transition-all duration-200 hover:bg-[hsl(var(--reservation-line)/0.5)] disabled:opacity-30"
                            >
                              <ChevronRight size={16} />
                            </button>
                          </div>
                        </div>
                        <div className="scrollbar-none flex snap-x gap-2 overflow-x-auto pb-1 lg:grid lg:grid-cols-7 lg:gap-1.5 lg:overflow-visible lg:pb-0">
                          {days.map((date, idx) => {
                            const isSelected = selectedDate?.toDateString() === date.toDateString();
                            const dateSlots = getSlotsForDate(date);
                            const isOpen = Boolean(modification) || dateSlots.length > 0;
                            return (
                              <button
                                key={idx}
                                type="button"
                                aria-label={`${formatLongFrenchDate(date)} ${modification ? '' : isOpen ? 'ouvert' : 'fermé'}`}
                                aria-pressed={isSelected}
                                onClick={() => {
                                  triggerHaptic();
                                  requestedSlotRef.current = null;
                                  setSelectionNotice('');
                                  setSelectedDate(date);
                                  if (!modification) setSelectedTime('');
                                  setError('');
                                  setActiveSection('time');
                                  setTimeout(() => {
                                    timeSectionRef.current?.scrollIntoView?.({
                                      behavior: 'smooth',
                                      block: 'nearest',
                                    });
                                  }, 80);
                                }}
                                aria-disabled={!isOpen}
                                className={cn(
                                  'relative flex h-[4.4rem] min-w-[4.75rem] shrink-0 snap-center flex-col items-center justify-center overflow-hidden rounded-[1.35rem] text-center transition-all duration-200 active:scale-95 sm:h-[4.8rem] sm:min-w-[5rem] sm:rounded-[1.45rem] lg:h-11 lg:min-w-0 lg:rounded-xl',
                                  softPillClass,
                                  !isOpen && !isSelected
                                    ? 'text-[hsl(var(--reservation-soft))] opacity-70'
                                    : '',
                                  isSelected
                                    ? 'border-[hsl(var(--reservation-ink))] bg-[hsl(var(--reservation-ink))] text-[hsl(var(--reservation-panel))] shadow-lg shadow-black/10 hover:bg-[hsl(var(--reservation-ink))] hover:text-[hsl(var(--reservation-panel))]'
                                    : '',
                                )}
                              >
                                {!modification && isOpen && !isSelected && (
                                  <span className="absolute bottom-2 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-[hsl(var(--reservation-glow))] lg:bottom-auto lg:left-auto lg:right-1.5 lg:top-1.5 lg:h-1 lg:w-1 lg:translate-x-0" />
                                )}
                                {!isOpen && !isSelected && (
                                  <span className="absolute bottom-2 left-1/2 h-1 w-5 -translate-x-1/2 rounded-full bg-black/15 lg:bottom-auto lg:left-auto lg:right-1.5 lg:top-1.5 lg:w-2 lg:translate-x-0" />
                                )}
                                <span
                                  className={cn(
                                    'text-[22px] font-bold leading-none tracking-normal sm:text-2xl sm:leading-none lg:text-lg lg:leading-none',
                                    isSelected
                                      ? 'text-[hsl(var(--reservation-panel))]'
                                      : isOpen
                                        ? 'text-[hsl(var(--reservation-ink))]'
                                        : 'text-[hsl(var(--reservation-soft))]',
                                  )}
                                >
                                  {date.getDate()}
                                </span>
                                <span className="mt-1 text-[10px] font-semibold uppercase leading-none tracking-[0.08em] opacity-75">
                                  {FRENCH_DAYS_SHORT[date.getDay()]}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div
                        ref={timeSectionRef}
                        role="group"
                        aria-label="Créneaux horaires"
                        aria-busy={availabilityRefreshing}
                        className={cn(
                          'space-y-2 sm:space-y-2.5 lg:space-y-1 transition-opacity duration-200',
                          activeSection !== 'time' && 'opacity-90',
                        )}
                        onClickCapture={() => setActiveSection('time')}
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className={cn(labelClass)}>
                            <Clock size={13} />
                            Créneau horaire
                          </span>
                          {serviceGroups.length > 1 ? (
                            <div aria-label="Services" className="flex gap-1">
                              {serviceGroups.map((group) => (
                                <button
                                  type="button"
                                  key={group.title}
                                  aria-pressed={group.title === selectedService?.title}
                                  onClick={() => {
                                    setChosenService(group.title);
                                    if (!group.slots.includes(selectedTime)) setSelectedTime('');
                                  }}
                                  className={cn(
                                    'min-h-11 rounded-full px-3 text-xs font-medium transition-all duration-200',
                                    group.title === selectedService?.title
                                      ? 'bg-[hsl(var(--reservation-ink))] text-[hsl(var(--reservation-panel))]'
                                      : 'text-[hsl(var(--reservation-soft))] hover:bg-[hsl(var(--reservation-line)/0.5)]',
                                  )}
                                >
                                  {group.title}
                                </button>
                              ))}
                            </div>
                          ) : (
                            selectedService && (
                              <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))]">
                                {selectedService.title}
                              </span>
                            )
                          )}
                        </div>
                        {selectionNotice && !availabilityRefreshing && !availabilityError && (
                          <p
                            role="status"
                            className="rounded-xl border border-border bg-white/60 px-3 py-2 text-sm font-medium text-[hsl(var(--reservation-ink))]"
                          >
                            {selectionNotice}
                          </p>
                        )}
                        {availabilityRefreshing ? (
                          <div className="animate-in fade-in slide-in-from-right-2 duration-200 grid grid-cols-3 gap-2 lg:grid-cols-6">
                            {[1, 2, 3, 4, 5, 6].map((item) => (
                              <Skeleton
                                key={item}
                                className="h-12 rounded-full bg-white/55 lg:h-11"
                              />
                            ))}
                          </div>
                        ) : availabilityError ? (
                          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-[1.5rem] border border-destructive/50 bg-destructive/10 p-3 text-sm font-semibold text-destructive shadow-sm backdrop-blur-2xl sm:p-5 lg:rounded-[1.1rem] lg:p-2.5">
                            {availabilityError}
                          </div>
                        ) : timeSlots.length > 0 ? (
                          <div className="scrollbar-none max-h-[12rem] space-y-3 overflow-y-auto pr-1 lg:max-h-40 lg:space-y-3">
                            {serviceGroups
                              .filter((group) => group.title === selectedService?.title)
                              .map((group) => (
                                <div key={group.title}>
                                  <div className="grid grid-cols-3 gap-2 lg:flex-1 lg:grid-cols-6">
                                    {group.slots.map((time) => {
                                      const isSelected = selectedTime === time;
                                      return (
                                        <button
                                          key={time}
                                          type="button"
                                          aria-label={`Choisir le créneau ${time.replace(':', 'h')}`}
                                          aria-pressed={isSelected}
                                          onClick={() => {
                                            triggerHaptic();
                                            setSelectionNotice('');
                                            setSelectedTime(time);
                                            setError('');
                                          }}
                                          className={cn(
                                            'flex h-12 flex-col items-center justify-center gap-0.5 rounded-full px-4 text-center text-sm font-extrabold transition-all duration-200 active:scale-95 lg:h-11',
                                            softPillClass,
                                            isSelected ? selectedPillClass : '',
                                          )}
                                        >
                                          {time.replace(':', 'h')}
                                          {modification &&
                                            selectedDate &&
                                            formatDateParam(selectedDate) === modification.date &&
                                            partySize === modification.partySize &&
                                            time === modification.time && (
                                              <span className="text-[8px] font-medium leading-none opacity-75">
                                                Actuel
                                              </span>
                                            )}
                                        </button>
                                      );
                                    })}
                                  </div>
                                </div>
                              ))}
                          </div>
                        ) : (
                          <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-[1.5rem] border border-white/70 bg-white/50 p-3 shadow-sm backdrop-blur-2xl sm:p-5 lg:rounded-[1.1rem] lg:p-2.5">
                            <div className="flex items-start gap-3">
                              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/60 text-[hsl(var(--reservation-muted))] shadow-inner lg:h-9 lg:w-9">
                                <Utensils size={18} className="opacity-70" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-black tracking-tight text-[hsl(var(--reservation-ink))]">
                                  {isFullyBooked
                                    ? 'Complet ce jour-là'
                                    : 'Aucun service ce jour-là'}
                                </p>
                                <p className="mt-1 text-xs font-semibold leading-snug text-[hsl(var(--reservation-soft))]">
                                  {isFullyBooked
                                    ? modification
                                      ? 'Aucun créneau disponible pour ce jour et ce nombre de personnes.'
                                      : 'Toutes les tables sont réservées. Essayez une autre date.'
                                    : nextOpeningDayLabel
                                      ? `Prochain jour ouvert : ${nextOpeningDayLabel}. Les créneaux seront vérifiés après sélection.`
                                      : 'Essayez une autre date ou une autre taille de table.'}
                                </p>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="animate-in fade-in duration-200 motion-reduce:animate-none space-y-3">
                      {!modification && (
                        <button
                          type="button"
                          onClick={() => {
                            setStep(1);
                            setError('');
                          }}
                          className={cn(
                            'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-semibold transition-all duration-200',
                            modification
                              ? '-ml-3 text-xs text-[hsl(var(--reservation-soft))] hover:text-[hsl(var(--reservation-ink))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--reservation-accent))]'
                              : softPillClass,
                          )}
                        >
                          <ChevronLeft size={18} />
                          Retour aux créneaux
                        </button>
                      )}

                      {modification ? (
                        <div className="max-w-xl space-y-4 text-[hsl(var(--reservation-ink))]">
                          <h2 className="text-xl font-semibold tracking-tight sm:text-2xl">
                            Votre modification
                          </h2>
                          <dl className="space-y-1 rounded-2xl bg-[hsl(var(--reservation-line)/0.35)] px-4 sm:px-5">
                            {[
                              {
                                label: 'Date',
                                before: formatLongFrenchDate(
                                  new Date(`${modification.date}T12:00:00`),
                                ),
                                after: selectedDateLong,
                                changed:
                                  selectedDate &&
                                  formatDateParam(selectedDate) !== modification.date,
                              },
                              {
                                label: 'Horaire',
                                before: modification.time.replace(':', 'h'),
                                after: selectedTime.replace(':', 'h'),
                                changed: modification.time !== selectedTime,
                              },
                              {
                                label: 'Personnes',
                                before: String(modification.partySize),
                                after: String(partySize),
                                changed: modification.partySize !== partySize,
                              },
                            ]
                              .filter((item) => item.changed)
                              .map((item) => (
                                <div key={item.label} className="py-3 sm:py-3.5">
                                  <dt className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-[hsl(var(--reservation-soft))]">
                                    {item.label}
                                  </dt>
                                  <dd className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)] items-center gap-3 font-semibold">
                                    <span
                                      className={cn(
                                        'min-w-0 font-normal text-[hsl(var(--reservation-soft))]',
                                        item.label === 'Date'
                                          ? 'text-sm leading-snug sm:text-lg'
                                          : 'text-xl sm:text-2xl',
                                      )}
                                    >
                                      {item.before}
                                    </span>
                                    <ChevronRight
                                      size={22}
                                      className="text-[hsl(var(--reservation-muted))]"
                                      aria-hidden="true"
                                    />
                                    <span
                                      className={cn(
                                        'min-w-0 tracking-tight',
                                        item.label === 'Date'
                                          ? 'text-base leading-snug sm:text-xl'
                                          : 'text-3xl sm:text-4xl',
                                      )}
                                    >
                                      {item.after}
                                    </span>
                                  </dd>
                                </div>
                              ))}
                          </dl>
                          {modification.terms && (
                            <p className="max-w-lg text-xs leading-relaxed text-[hsl(var(--reservation-soft))]">
                              {modification.terms}
                            </p>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="space-y-1.5">
                            <label htmlFor="customerName" className={cn(labelClass, 'ml-2')}>
                              <User size={12} />
                              Nom complet *
                            </label>
                            <input
                              id="customerName"
                              value={customerName}
                              onChange={(e) => setCustomerName(e.target.value)}
                              placeholder="Alice Martin"
                              required
                              className={fieldClass}
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label htmlFor="customerPhone" className={cn(labelClass, 'ml-2')}>
                              <Phone size={12} />
                              Téléphone *
                            </label>
                            <input
                              id="customerPhone"
                              type="tel"
                              value={customerPhone}
                              onChange={(e) => setCustomerPhone(e.target.value)}
                              placeholder="0612345678"
                              required
                              className={fieldClass}
                            />
                          </div>

                          <div className="space-y-1.5">
                            <label htmlFor="customerEmail" className={cn(labelClass, 'ml-2')}>
                              <Mail size={12} />
                              Adresse Email (optionnel)
                            </label>
                            <input
                              id="customerEmail"
                              type="email"
                              value={customerEmail}
                              onChange={(e) => setCustomerEmail(e.target.value)}
                              placeholder="client@sokar.fr"
                              className={fieldClass}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {step === 2 &&
                    !modification &&
                    !testBooking &&
                    restaurant?.whatsappReminderOptInEnabled && (
                      <label className="flex items-start gap-3 text-sm text-[hsl(var(--reservation-ink))]">
                        <input
                          type="checkbox"
                          checked={whatsappOptIn}
                          onChange={(event) => setWhatsappOptIn(event.target.checked)}
                          disabled={submitting}
                          className="mt-1 h-4 w-4 shrink-0 transition-all duration-200"
                        />
                        <span>
                          J’accepte le rappel de cette réservation sur WhatsApp. Facultatif, sans
                          publicité. Retrait possible après confirmation ou auprès du restaurant.
                        </span>
                      </label>
                    )}

                  {step === 2 && !modification && !testBooking && consentChannels.length > 0 && (
                    <fieldset className="space-y-3 text-sm text-[hsl(var(--reservation-ink))]">
                      <legend className="font-semibold">Offres et actualités (facultatif)</legend>
                      {consentChannels.map((channel) => (
                        <label key={channel} className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            name={`marketing-consent-${channel.toLowerCase()}`}
                            checked={marketingConsent[channel]}
                            onChange={(event) =>
                              setMarketingConsent((current) => ({
                                ...current,
                                [channel]: event.target.checked,
                              }))
                            }
                            disabled={submitting}
                            className="mt-1 h-4 w-4 shrink-0 transition-all duration-200"
                          />
                          <span>{buildMarketingConsentLabel(channel, restaurant?.name ?? '')}</span>
                        </label>
                      ))}
                      <p className="text-xs text-[hsl(var(--reservation-soft))]">
                        Facultatif, sans effet sur votre réservation. Désinscription possible à tout
                        moment.{' '}
                        <a
                          href="/privacy"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline transition-all duration-200 hover:text-[hsl(var(--reservation-ink))]"
                        >
                          Informations sur le traitement de vos données
                        </a>
                      </p>
                    </fieldset>
                  )}

                  {step === 2 && !modification && cardGuarantee && (
                    <div className="space-y-3 rounded-2xl border border-[hsl(var(--reservation-line))] bg-white/60 p-4 text-sm text-[hsl(var(--reservation-ink))]">
                      <p className="flex items-start gap-2 font-semibold">
                        <CreditCard size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                        Empreinte bancaire demandée
                      </p>
                      <p className="leading-relaxed text-[hsl(var(--reservation-soft))]">
                        {cardGuaranteeNotice({
                          restaurantName: restaurant?.name ?? 'Le restaurant',
                          partySize,
                          terms: cardGuarantee,
                        })}
                      </p>
                      <label className="flex items-start gap-3">
                        <input
                          type="checkbox"
                          name="card-guarantee-accepted"
                          checked={cardGuaranteeAccepted}
                          onChange={(event) => setCardGuaranteeAccepted(event.target.checked)}
                          disabled={submitting || Boolean(cardGuaranteeUrl)}
                          className="mt-1 h-4 w-4 shrink-0 transition-all duration-200"
                        />
                        <span>{CARD_GUARANTEE_ACCEPT_LABEL}</span>
                      </label>
                      {cardGuaranteeUrl && (
                        <p role="status" className="text-[hsl(var(--reservation-soft))]">
                          Votre table est réservée pendant l’enregistrement de la carte.{' '}
                          <a
                            href={cardGuaranteeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold underline transition-all duration-200 hover:text-[hsl(var(--reservation-ink))]"
                          >
                            Ouvrir la page sécurisée
                          </a>
                        </p>
                      )}
                    </div>
                  )}

                  {step === 2 && !modification && selectedDate && selectedTime && (
                    <div className="rounded-2xl border border-white/70 bg-white/45 p-3 text-sm font-semibold text-[hsl(var(--reservation-soft))] shadow-sm backdrop-blur-2xl">
                      <p className="font-black text-[hsl(var(--reservation-ink))]">
                        {selectedDateLong} · {selectedTime.replace(':', 'h')}
                      </p>
                      <p>
                        {partySize} {partySize > 1 ? 'personnes' : 'personne'} · {restaurant?.name}
                      </p>
                    </div>
                  )}

                  {modification &&
                    optionsMessage &&
                    !timeSlots.length &&
                    !availabilityRefreshing && (
                      <p
                        className="text-xs leading-relaxed text-[hsl(var(--reservation-soft))]"
                        role="status"
                      >
                        {optionsMessage}
                      </p>
                    )}
                  {modification && step === 1 && (
                    <p
                      id="reservation-change-hint"
                      className="min-h-5 pb-1 text-xs leading-relaxed text-[hsl(var(--reservation-soft))]"
                    >
                      Choisissez une nouvelle date, un horaire ou le nombre de personnes.
                    </p>
                  )}
                  <div
                    className={cn(
                      'relative z-20 pt-2 lg:pt-0',
                      modification && step === 2 && 'lg:mt-4 lg:max-w-xl',
                      modification &&
                        'relative border-t border-[hsl(var(--reservation-line))] bg-[hsl(var(--reservation-wash))] p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] lg:static lg:border-0 lg:bg-transparent lg:p-0',
                    )}
                  >
                    <button
                      type="button"
                      onClick={handlePrimaryAction}
                      aria-describedby={
                        modification && step === 1 ? 'reservation-change-hint' : undefined
                      }
                      disabled={primaryCtaDisabled}
                      className={cn(
                        'flex h-14 w-full items-center justify-center gap-2 rounded-full text-[17px] font-extrabold shadow-lg transition-all duration-200 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--reservation-accent))] focus-visible:ring-offset-4 focus-visible:ring-offset-[hsl(var(--reservation-wash))] lg:h-11 lg:text-[15px]',
                        primaryCtaDisabled
                          ? 'cursor-not-allowed bg-white/60 text-[hsl(var(--reservation-soft))] shadow-sm'
                          : 'bg-[hsl(var(--reservation-ink))] text-white shadow-black/15 hover:-translate-y-0.5',
                        modification && step === 2 && 'shadow-sm',
                      )}
                    >
                      {primaryCtaLabel}
                      {!isOriginalSelection && (
                        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-white/12">
                          {submitting ? (
                            <Loader2 size={16} className="animate-spin" />
                          ) : step === 1 ? (
                            <ChevronRight size={17} />
                          ) : (
                            <CheckCircle2 size={17} />
                          )}
                        </span>
                      )}
                    </button>
                    {modification && step === 2 && (
                      <button
                        type="button"
                        onClick={() => {
                          setStep(1);
                          setError('');
                        }}
                        className="mx-auto mt-2 flex min-h-11 items-center justify-center gap-1.5 rounded-full px-4 text-xs font-medium text-[hsl(var(--reservation-soft))] transition-all duration-200 hover:text-[hsl(var(--reservation-ink))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--reservation-accent))]"
                      >
                        <ChevronLeft size={15} aria-hidden="true" />
                        Revenir aux créneaux
                      </button>
                    )}
                    {modification ? (
                      <p className="mt-2 flex items-center justify-center gap-1.5 text-center text-[10px] leading-relaxed text-[hsl(var(--reservation-soft))]">
                        <Info size={12} aria-hidden="true" />
                        Votre réservation reste inchangée jusqu’à votre confirmation.
                      </p>
                    ) : (
                      <p className="mt-2 px-4 text-center text-[11px] font-medium leading-relaxed text-[hsl(var(--reservation-soft))] lg:mt-1">
                        {step === 1
                          ? isOriginalSelection
                            ? 'Choisissez un autre jour, un autre horaire ou un autre nombre de personnes.'
                            : availabilityError
                              ? 'La disponibilité n’a pas pu être vérifiée. Réessayez.'
                              : (!hasService || isFullyBooked) && nextOpeningDay
                                ? `Prochain jour ouvert : ${nextOpeningDayLabel}. Les places restent à vérifier.`
                                : !hasService || isFullyBooked
                                  ? 'Essayez une autre date ou une autre taille de table.'
                                  : 'Sélectionnez un horaire pour continuer.'
                          : modification
                            ? 'Aucun changement avant votre confirmation.'
                            : 'Les notifications dépendent des options du restaurant.'}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            }

            <div className="hidden sm:flex items-center justify-center gap-1.5 pt-2 lg:pt-1">
              <span className="text-[10px] tracking-wide text-[hsl(var(--reservation-muted)/0.72)]">
                Propulsé par
              </span>
              <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-[hsl(var(--reservation-muted))]">
                Suppernote
              </span>
            </div>

            {/* Bouton « Offrir une carte cadeau » — footer du bottom sheet.
                Ouvre un overlay qui embed la page Connect /widget/[slug]/gift-card. */}
            {!modification && !testBooking && restaurant?.giftCardEnabled !== false && (
              <button
                type="button"
                onClick={() => setShowGiftCard(true)}
                className="mt-1 flex w-full items-center justify-center gap-2 rounded-full border border-[hsl(var(--reservation-line))] bg-white/70 py-2.5 text-[13px] font-bold text-[hsl(var(--reservation-ink))] shadow-sm transition-all duration-200 hover:bg-white active:scale-[0.98] lg:mt-0 lg:py-2 lg:text-[12px]"
              >
                <Gift size={15} className="text-[hsl(var(--reservation-glow))]" />
                Offrir une carte cadeau
              </button>
            )}
          </div>
        </section>

        {/* Overlay carte cadeau — modal desktop / sheet mobile.
            L'iframe imbriquée charge la page Connect qui gère son propre
            auto-resize via postMessage. */}
        {giftCardOverlay}
      </main>
    </div>
  );
}
