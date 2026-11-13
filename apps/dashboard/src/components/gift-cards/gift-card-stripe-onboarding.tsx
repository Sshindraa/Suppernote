'use client';

import { useEffect, useRef, useState } from 'react';
import { useReverification } from '@clerk/nextjs';
import type { StripeConnectInstance } from '@stripe/connect-js';
import { ConnectAccountOnboarding, ConnectComponentsProvider } from '@stripe/react-connect-js';
import { LoaderCircle } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { getErrorMessage } from '@/types/api';

type Session = { clientSecret: string; publishableKey: string };
type SessionPost = (
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
) => Promise<Session>;

/** Couleurs du thème courant, au format accepté par Connect.js (HSL à virgules, rayons en px). */
function connectAppearance(element: HTMLElement | null) {
  const tokens = getComputedStyle(document.documentElement);
  const color = (token: string) =>
    `hsl(${tokens.getPropertyValue(token).trim().split(/\s+/).join(', ')})`;
  const containerStyle = element ? getComputedStyle(element) : undefined;
  return {
    overlays: 'dialog' as const,
    variables: {
      colorPrimary: color('--primary'),
      colorBackground: color('--background'),
      colorText: color('--foreground'),
      colorDanger: color('--destructive'),
      borderRadius: containerStyle?.borderRadius,
      fontFamily: containerStyle?.fontFamily,
    },
  };
}

export function VerifiedGiftCardStripeOnboarding(props: {
  restaurantId: string;
  onClose: () => void;
  managedTestPublishableKey?: string;
}) {
  const { post } = useApi();
  const verifiedPost = useReverification(
    (path: string, body?: unknown, options?: { signal?: AbortSignal }) =>
      post<Session>(path, body, { ...options, allowReverificationHint: true }),
  );
  return <GiftCardStripeOnboarding {...props} sessionPost={verifiedPost} />;
}

export function GiftCardStripeOnboarding({
  restaurantId,
  onClose,
  managedTestPublishableKey,
  sessionPost,
}: {
  restaurantId: string;
  onClose: () => void;
  managedTestPublishableKey?: string;
  sessionPost?: SessionPost;
}) {
  const { post: apiPost } = useApi();
  const post: SessionPost = sessionPost ?? apiPost;
  const [instance, setInstance] = useState<StripeConnectInstance | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [initialSession, setInitialSession] = useState<Session | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  async function acceptAndStart() {
    if (!accepted || !managedTestPublishableKey?.startsWith('pk_test_')) return;
    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('https://api.stripe.com/v2/core/account_tokens', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${managedTestPublishableKey}`,
          'Content-Type': 'application/json',
          'Stripe-Version': '2026-08-26.dahlia',
        },
        body: JSON.stringify({
          identity: {
            attestations: { terms_of_service: { account: { shown_and_accepted: true } } },
          },
        }),
      });
      const token: { id?: string } = await response.json();
      if (!response.ok || !token.id) throw new Error('Impossible de préparer la configuration.');
      const session = await post(
        `restaurants/${restaurantId}/gift-cards/stripe-connect/managed-test`,
        { accountToken: token.id },
      );
      setInitialSession(session);
    } catch {
      setError('Impossible de préparer la configuration. Veuillez réessayer.');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (managedTestPublishableKey && !initialSession) return;
    let active = true;
    let connect: StripeConnectInstance | undefined;
    const abort = new AbortController();
    setInstance(null);
    setError('');
    const fetchSession = () =>
      post(
        `restaurants/${restaurantId}/gift-cards/stripe-connect/session`,
        {},
        { signal: abort.signal },
      );
    async function start() {
      try {
        const [{ loadConnectAndInitialize }, session] = await Promise.all([
          import('@stripe/connect-js/pure'),
          initialSession && attempt === 0 ? Promise.resolve(initialSession) : fetchSession(),
        ]);
        if (!active) return;
        let firstSecret: string | undefined = session.clientSecret;
        connect = loadConnectAndInitialize({
          publishableKey: session.publishableKey,
          locale: 'fr-FR',
          appearance: connectAppearance(container.current),
          fetchClientSecret: async () => {
            if (!active) throw new Error('Configuration fermée.');
            if (firstSecret) {
              const secret = firstSecret;
              firstSecret = undefined;
              return secret;
            }
            try {
              const renewed = await fetchSession();
              if (!active) throw new Error('Configuration fermée.');
              return renewed.clientSecret;
            } catch {
              if (active)
                setError(
                  'La session a été interrompue. Veuillez réessayer pour reprendre votre configuration.',
                );
              throw new Error('Impossible de renouveler la session de configuration.');
            }
          },
        });
        setInstance(connect);
      } catch (err) {
        if (active)
          setError(
            getErrorMessage(err, 'Impossible de charger la configuration des encaissements.'),
          );
      }
    }
    void start();
    return () => {
      active = false;
      abort.abort();
      void connect?.logout().catch(() => undefined);
    };
  }, [restaurantId, post, attempt, initialSession, managedTestPublishableKey]);

  // Le thème peut changer pendant la configuration : Stripe reçoit les nouvelles couleurs.
  useEffect(() => {
    if (!instance) return;
    const observer = new MutationObserver(() =>
      instance.update({ appearance: connectAppearance(container.current) }),
    );
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [instance]);

  return (
    <div
      ref={container}
      className="space-y-4 rounded-lg border border-border bg-background p-6 text-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="font-semibold">Configurer les encaissements</h3>
        <Button variant="outline" onClick={onClose} className="transition-all duration-200">
          Fermer et reprendre plus tard
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Renseignez les informations de votre établissement et votre compte bancaire ici. Votre
        progression est enregistrée par Stripe. Une fenêtre peut s’ouvrir pour vérifier votre
        connexion.
      </p>
      {managedTestPublishableKey && !initialSession ? (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>
              Je représente cet établissement et j’accepte les{' '}
              <a
                className="underline"
                href="https://stripe.com/connect-account/legal/full"
                target="_blank"
                rel="noreferrer"
              >
                conditions Stripe pour les comptes connectés
              </a>
              .
            </span>
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button disabled={!accepted || submitting} onClick={() => void acceptAndStart()}>
            {submitting ? 'Préparation…' : 'Continuer'}
          </Button>
        </div>
      ) : error ? (
        <div className="space-y-3">
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
          <Button
            onClick={() => setAttempt((value) => value + 1)}
            className="transition-all duration-200"
          >
            Réessayer la configuration
          </Button>
        </div>
      ) : instance ? (
        <ConnectComponentsProvider connectInstance={instance}>
          <ConnectAccountOnboarding
            onExit={onClose}
            onLoadError={() =>
              setError('Le formulaire Stripe n’a pas pu être chargé. Veuillez réessayer.')
            }
          />
        </ConnectComponentsProvider>
      ) : (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
          Chargement du formulaire sécurisé…
        </p>
      )}
    </div>
  );
}
