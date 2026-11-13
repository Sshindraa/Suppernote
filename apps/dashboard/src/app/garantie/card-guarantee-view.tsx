'use client';

import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, CircleX, CreditCard, Loader2 } from 'lucide-react';
import { CARD_GUARANTEE_ACCEPT_LABEL, cardGuaranteeNotice } from '@suppernote/shared';
import { Button } from '@/components/ui/button';
import { SuppernoteLogo } from '@/components/SuppernoteLogo';

type GuaranteeStatus = {
  status: 'awaiting_card' | 'confirmed' | 'expired' | 'cancelled';
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  amountPerPerson: string;
  totalAmount: string;
  cancellationHours: number;
  freeCancellationUntil: string;
  expiresAt: string | null;
};

type Link = { slug: string; token: string; retour: string | null };

/** Le retour Stripe peut précéder le webhook de quelques secondes : on revérifie un moment. */
const POLL_INTERVAL_MS = 2_000;
const POLL_ATTEMPTS = 15;

// shortcut: affichage à l'heure de Paris, à revoir si un restaurant hors fuseau français arrive.
function formatInstant(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Paris',
  }).format(new Date(iso));
}

function formatDay(date: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

function readLink(): Link | null {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('r');
  const token = params.get('t');
  return slug && token ? { slug, token, retour: params.get('retour') } : null;
}

function apiPath(link: Link, suffix = ''): string {
  return `/api/proxy/public/r/${encodeURIComponent(link.slug)}/card-guarantee/${encodeURIComponent(link.token)}${suffix}`;
}

export default function CardGuaranteeView() {
  const [link, setLink] = useState<Link | null>(null);
  const [data, setData] = useState<GuaranteeStatus | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [accepted, setAccepted] = useState(false);
  const [opening, setOpening] = useState(false);
  const [actionError, setActionError] = useState('');
  const [checking, setChecking] = useState(false);

  const load = useCallback(async (current: Link): Promise<GuaranteeStatus | null> => {
    const res = await fetch(apiPath(current), { cache: 'no-store' });
    if (res.status === 404) {
      setState('not_found');
      return null;
    }
    if (!res.ok) throw new Error('status');
    const body = (await res.json()) as GuaranteeStatus;
    setData(body);
    setState('ready');
    return body;
  }, []);

  useEffect(() => {
    const current = readLink();
    setLink(current);
    if (!current) {
      setState('not_found');
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (attempt: number) => {
      try {
        const body = await load(current);
        if (cancelled || !body) return;
        const waiting = current.retour === 'ok' && body.status === 'awaiting_card';
        setChecking(waiting && attempt < POLL_ATTEMPTS);
        if (waiting && attempt < POLL_ATTEMPTS) {
          timer = setTimeout(() => void poll(attempt + 1), POLL_INTERVAL_MS);
        }
      } catch {
        if (!cancelled) setState('error');
      }
    };
    void poll(1);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  async function openCheckout() {
    if (!link || !accepted) return;
    setOpening(true);
    setActionError('');
    try {
      const res = await fetch(apiPath(link, '/checkout'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accepted: true }),
      });
      const body = (await res.json().catch(() => ({}))) as { checkoutUrl?: string };
      if (res.ok && body.checkoutUrl) {
        window.location.assign(body.checkoutUrl);
        return;
      }
      if (res.status === 409) {
        await load(link);
        return;
      }
      setActionError('La page d’enregistrement n’a pas pu s’ouvrir. Réessayez dans un instant.');
    } catch {
      setActionError('La page d’enregistrement n’a pas pu s’ouvrir. Réessayez dans un instant.');
    } finally {
      setOpening(false);
    }
  }

  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="mx-auto max-w-lg space-y-6">
        <SuppernoteLogo className="h-6 w-auto" />
        <section className="space-y-5 rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
          {state === 'loading' && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Chargement de votre réservation…
            </p>
          )}

          {state === 'not_found' && (
            <Message
              icon={<CircleX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
              title="Lien introuvable"
              text="Ce lien n’est pas valide. Vérifiez qu’il est complet, ou contactez le restaurant."
            />
          )}

          {state === 'error' && (
            <Message
              icon={<CircleX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
              title="Service momentanément indisponible"
              text="Votre réservation n’a pas pu être chargée. Rechargez la page dans un instant."
            />
          )}

          {state === 'ready' && data && (
            <>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">{data.restaurantName}</p>
                <p className="text-lg font-semibold">
                  {formatDay(data.date)} · {data.time.replace(':', 'h')} · {data.partySize}{' '}
                  {data.partySize > 1 ? 'personnes' : 'personne'}
                </p>
              </div>

              {data.status === 'confirmed' && (
                <Message
                  icon={<CheckCircle2 className="h-5 w-5 text-primary" aria-hidden="true" />}
                  title="Votre réservation est confirmée"
                  text={`Votre carte est enregistrée, aucun montant n’a été débité. Vous pouvez annuler gratuitement jusqu’au ${formatInstant(data.freeCancellationUntil)}.`}
                />
              )}

              {data.status === 'expired' && (
                <Message
                  icon={<CircleX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
                  title="Le délai est dépassé"
                  text="La carte n’a pas été enregistrée à temps : la réservation n’est pas confirmée et la table a été libérée. Vous pouvez refaire une demande auprès du restaurant."
                />
              )}

              {data.status === 'cancelled' && (
                <Message
                  icon={<CircleX className="h-5 w-5 text-muted-foreground" aria-hidden="true" />}
                  title="Réservation annulée"
                  text="Cette réservation a été annulée. Aucun montant ne sera prélevé."
                />
              )}

              {data.status === 'awaiting_card' && checking && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Nous vérifions l’enregistrement de votre carte…
                </p>
              )}

              {data.status === 'awaiting_card' && !checking && (
                <div className="space-y-4">
                  <p className="flex items-center gap-2 font-semibold">
                    <CreditCard className="h-5 w-5" aria-hidden="true" />
                    {link?.retour === 'annule'
                      ? 'L’enregistrement de votre carte n’est pas terminé'
                      : 'Empreinte bancaire demandée'}
                  </p>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {cardGuaranteeNotice({
                      restaurantName: data.restaurantName,
                      partySize: data.partySize,
                      terms: data,
                    })}
                  </p>
                  {data.expiresAt && (
                    <p className="text-sm text-muted-foreground">
                      Votre table est réservée jusqu’au {formatInstant(data.expiresAt)}.
                    </p>
                  )}
                  <label className="flex items-start gap-3 text-sm">
                    <input
                      type="checkbox"
                      checked={accepted}
                      onChange={(event) => setAccepted(event.target.checked)}
                      disabled={opening}
                      className="mt-0.5 h-4 w-4 shrink-0 transition-all duration-200"
                    />
                    <span>{CARD_GUARANTEE_ACCEPT_LABEL}</span>
                  </label>
                  {actionError && (
                    <p className="text-sm text-destructive" role="alert">
                      {actionError}
                    </p>
                  )}
                  <Button
                    type="button"
                    onClick={() => void openCheckout()}
                    disabled={!accepted || opening}
                    className="w-full transition-all duration-200"
                  >
                    {opening && (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                    )}
                    Enregistrer ma carte
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Page sécurisée par Stripe, au nom du restaurant. Suppernote ne voit pas votre
                    numéro de carte.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </main>
  );
}

function Message({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex items-start gap-3">
      {icon}
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        <p className="text-sm leading-relaxed text-muted-foreground">{text}</p>
      </div>
    </div>
  );
}
