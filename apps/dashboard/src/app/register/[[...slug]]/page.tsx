'use client';

import {
  PRICING_CATALOG,
  TRIAL_DAYS,
  VAT_MENTION,
  pricingTotalCents,
  formatPriceCents,
} from '@suppernote/shared';

import { SignUp, useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ArrowUpRight, Loader2 } from 'lucide-react';
import LoginCallSimulation from '../../login/login-call-simulation';
import LoginHeadline from '../../login/login-headline';
import '../../login/login.css';
import '../../brand-palette.css';

const SIGNUP_PLANS = {
  essential: { label: 'Essential', billingLabel: 'facturation annuelle' },
  pro: { label: 'Pro', billingLabel: 'facturation annuelle' },
  'multi-site': { label: 'Multi-restaurant', billingLabel: 'facturation annuelle' },
} as const;

type SignupSelection = {
  slug: keyof typeof SIGNUP_PLANS;
  billing: 'monthly' | 'annual';
  label: (typeof SIGNUP_PLANS)[keyof typeof SIGNUP_PLANS]['label'];
  billingLabel: string;
  siteCount?: number;
};

function readSiteCount(value: string | null): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 100 ? parsed : 2;
}

function readSignupSelection(search: string): SignupSelection | null {
  const params = new URLSearchParams(search);
  const plan = params.get('plan') as keyof typeof SIGNUP_PLANS | null;
  const offer = plan ? SIGNUP_PLANS[plan] : undefined;
  if (!plan || !offer) return null;
  const billing = params.get('billing') === 'monthly' ? 'monthly' : 'annual';
  return {
    slug: plan,
    billing,
    label: offer.label,
    billingLabel: billing === 'monthly' ? 'facturation mensuelle' : offer.billingLabel,
    ...(plan === 'multi-site' ? { siteCount: readSiteCount(params.get('sites')) } : {}),
  };
}

function selectionQuery(selection: SignupSelection): string {
  const params = new URLSearchParams({
    subscribe_plan: selection.slug,
    billing: selection.billing,
  });
  if (selection.slug === 'multi-site') params.set('sites', String(selection.siteCount ?? 2));
  return `?${params.toString()}`;
}

// Même composition que la page de connexion (voir login/[[...slug]]/page.tsx).
function RegisterShell({ children }: { children: ReactNode }) {
  return (
    <main className="suppernote-login dark brand-palette">
      <div className="suppernote-login__frame">
        <aside className="suppernote-login__story" aria-label="Votre restaurant avec Suppernote">
          <Link href="/" className="suppernote-login__brand" aria-label="Suppernote, accueil">
            <Image src="/logo-suppernote-white.svg" alt="" width={36} height={36} priority />
            <span>Suppernote</span>
          </Link>

          <div className="suppernote-login__paths" aria-hidden="true">
            <svg viewBox="0 0 700 800" fill="none" preserveAspectRatio="xMidYMid slice">
              {Array.from({ length: 18 }, (_, index) => (
                <path
                  key={index}
                  className="suppernote-login__path"
                  d={`M ${-300 + index * 24} -80 C ${440 + index * 14} 80, ${-280 + index * 20} 480, ${460 + index * 25} 880`}
                  stroke="currentColor"
                  strokeWidth={0.65 + index * 0.025}
                  style={{ animationDelay: `${index * -0.6}s` }}
                />
              ))}
            </svg>
          </div>

          <div className="suppernote-login__story-content">
            <span className="suppernote-login__eyebrow">LE FUTUR, C’EST AUJOURD’HUI</span>
            <LoginHeadline />
            <LoginCallSimulation />
          </div>
        </aside>

        <section className="suppernote-login__access" aria-labelledby="register-title">
          <header className="suppernote-login__header">
            <Link href="/" className="suppernote-login__back">
              <ArrowLeft size={15} aria-hidden="true" /> Accueil
            </Link>
            <Link
              href="/"
              className="suppernote-login__mobile-brand"
              aria-label="Suppernote, accueil"
            >
              <Image src="/logo-suppernote-white.svg" alt="" width={28} height={28} />
              <span>Suppernote</span>
            </Link>
          </header>

          <div className="suppernote-login__form">{children}</div>

          <footer className="suppernote-login__footer">
            <span>© {new Date().getFullYear()} Suppernote</span>
            <Link href="/privacy">Confidentialité</Link>
          </footer>
        </section>
      </div>
    </main>
  );
}

export default function RegisterPage() {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();
  const [selectedPlan, setSelectedPlan] = useState<SignupSelection | null>(null);

  // Conserve le choix effectué depuis la page Tarifs sans dépendre de Clerk.
  useEffect(() => {
    setSelectedPlan(readSignupSelection(window.location.search));
  }, []);

  // Redirection si déjà connecté
  useEffect(() => {
    if (isLoaded && isSignedIn) {
      const selection = readSignupSelection(window.location.search);
      const query = selection ? selectionQuery(selection) : '';
      router.replace(`/dashboard${query}`);
    }
  }, [isLoaded, isSignedIn, router]);

  if (isLoaded && isSignedIn) {
    return (
      <RegisterShell>
        <div role="status" className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" />
          Redirection vers votre espace…
        </div>
      </RegisterShell>
    );
  }

  return (
    <RegisterShell>
      <div className="suppernote-login__intro">
        <span className="suppernote-login__eyebrow">
          {selectedPlan
            ? `FORMULE ${selectedPlan.label.toUpperCase()}${selectedPlan.siteCount ? ` · ${selectedPlan.siteCount} ${selectedPlan.siteCount === 1 ? 'ÉTABLISSEMENT' : 'ÉTABLISSEMENTS'}` : ''} · ${selectedPlan.billingLabel.toUpperCase()}`
            : 'CRÉATION DE VOTRE ESPACE'}
        </span>
        <h1 id="register-title">Créez votre compte.</h1>
        {!selectedPlan && <p>{TRIAL_DAYS} jours offerts, sans carte bancaire.</p>}
      </div>

      {selectedPlan && (
        <div className="mb-6 space-y-4">
          {selectedPlan.slug === 'multi-site' && (
            <div className="rounded-xl border border-border bg-card/50 p-4">
              <label htmlFor="multi-site-count" className="text-sm font-medium text-foreground">
                Nombre d’établissements
              </label>
              <input
                id="multi-site-count"
                type="number"
                min={1}
                max={100}
                value={selectedPlan.siteCount ?? 2}
                onChange={(event) =>
                  setSelectedPlan({
                    ...selectedPlan,
                    siteCount: readSiteCount(event.target.value),
                  })
                }
                className="mt-2 flex h-11 w-full rounded-xl border border-input bg-card px-3 py-2 text-sm text-foreground transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="mt-2 text-xs text-muted-foreground">
                {PRICING_CATALOG['multi-site'].monthlyCents / 100} €/mois, premier établissement
                inclus, puis {PRICING_CATALOG['multi-site-addon'].monthlyCents / 100} €/mois par
                établissement supplémentaire.
              </p>
            </div>
          )}

          <p className="text-sm text-muted-foreground" aria-label="Récapitulatif de facturation">
            {TRIAL_DAYS} jours offerts, sans carte bancaire, puis{' '}
            {formatPriceCents(
              pricingTotalCents(
                selectedPlan.slug,
                selectedPlan.billing === 'annual',
                selectedPlan.siteCount ?? 1,
              ),
            )}{' '}
            €
            {selectedPlan.billing === 'annual'
              ? ' facturés par an, engagement de 12 mois.'
              : ' facturés chaque mois.'}{' '}
            {VAT_MENTION}.
          </p>
        </div>
      )}

      {!isLoaded ? (
        <div className="space-y-4" role="status" aria-label="Chargement de l’inscription">
          <div className="h-11 rounded-xl bg-secondary motion-safe:animate-pulse" />
          <div className="h-11 rounded-xl border border-border bg-card motion-safe:animate-pulse" />
          <div className="h-11 rounded-xl border border-border bg-card motion-safe:animate-pulse" />
          <div className="h-11 rounded-xl bg-primary/20 motion-safe:animate-pulse" />
          <span className="sr-only">Chargement de l’inscription…</span>
        </div>
      ) : (
        <SignUp
          forceRedirectUrl={
            selectedPlan ? `/dashboard${selectionQuery(selectedPlan)}` : '/dashboard'
          }
          appearance={{
            variables: {
              colorPrimary: 'hsl(var(--primary))',
              colorBackground: 'hsl(var(--background))',
              colorText: 'hsl(var(--foreground))',
              colorTextSecondary: 'hsl(var(--muted-foreground))',
              borderRadius: '0.75rem',
            },
            elements: {
              rootBox: 'w-full',
              cardBox: 'w-full shadow-none',
              card: 'w-full bg-transparent shadow-none border-0 p-0',
              main: 'gap-5',
              header: 'hidden',
              socialButtonsBlockButton:
                'min-h-11 rounded-xl border border-border bg-secondary text-foreground shadow-none transition-all duration-200 hover:bg-accent',
              socialButtonsBlockButtonText: 'font-medium text-sm',
              formFieldLabel: 'text-sm font-medium text-foreground',
              formFieldInput:
                'h-11 rounded-xl border border-input bg-card text-foreground shadow-none transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring',
              formButtonPrimary:
                'min-h-11 rounded-xl bg-primary text-primary-foreground shadow-none transition-all duration-200 hover:bg-primary/90',
              footer: 'hidden',
              dividerLine: 'bg-border',
              dividerText: 'text-muted-foreground text-xs',
              identityPreviewText: 'text-foreground',
              formResendCodeLink: 'text-foreground',
              formFieldAction: 'text-foreground',
            },
          }}
        />
      )}

      <p className="suppernote-login__signup">
        Déjà client ?{' '}
        <Link href="/login">
          Se connecter <ArrowUpRight size={14} aria-hidden="true" />
        </Link>
      </p>
    </RegisterShell>
  );
}
