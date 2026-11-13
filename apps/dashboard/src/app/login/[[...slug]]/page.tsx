'use client';

import { SignIn, useAuth } from '@clerk/nextjs';
import { useRouter } from 'next/navigation';
import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { ArrowLeft, ArrowUpRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import LoginCallSimulation from '../login-call-simulation';
import LoginHeadline from '../login-headline';
import '../login.css';
import '../../brand-palette.css';

// Composition inspired by Efferd's Auth Page, adapted to Suppernote's identity.
function LoginShell({ children }: { children: ReactNode }) {
  // Dans l'appli iOS, les liens de découverte ne servent pas : la coque se signale par son user-agent.
  const inShell = useSyncExternalStore(
    () => () => {},
    () => navigator.userAgent.includes('SuppernoteIOS') || navigator.userAgent.includes('SokarIOS'),
    () => false,
  );
  return (
    <main className="suppernote-login dark brand-palette" data-shell={inShell ? 'ios' : undefined}>
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

        <section className="suppernote-login__access" aria-labelledby="login-title">
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

          <div className="suppernote-login__form">
            <div className="suppernote-login__intro">
              <span className="suppernote-login__eyebrow">VOTRE ESPACE SUPPERNOTE</span>
              <h1 id="login-title">Ravis de vous revoir.</h1>
              <p>Tout est prêt pour votre prochain service.</p>
            </div>
            {children}
            <p className="suppernote-login__signup">
              Vous découvrez Suppernote ?{' '}
              <Link href="/register">
                Créer votre compte <ArrowUpRight size={14} aria-hidden="true" />
              </Link>
            </p>
          </div>

          <footer className="suppernote-login__footer">
            <span>© {new Date().getFullYear()} Suppernote</span>
            <Link href="/privacy">Confidentialité</Link>
          </footer>
        </section>
      </div>
    </main>
  );
}

function LoginLoading() {
  return (
    <div className="space-y-4" role="status" aria-label="Chargement de la connexion">
      <div className="h-11 rounded-xl bg-secondary motion-safe:animate-pulse" />
      <div className="h-11 rounded-xl bg-secondary motion-safe:animate-pulse" />
      <div className="py-2">
        <div className="h-px bg-border" />
      </div>
      <div className="h-4 w-28 rounded bg-secondary motion-safe:animate-pulse" />
      <div className="h-11 rounded-xl border border-border bg-card motion-safe:animate-pulse" />
      <div className="h-11 rounded-xl bg-primary/20 motion-safe:animate-pulse" />
      <span className="sr-only">Chargement de la connexion…</span>
    </div>
  );
}

function ConnectedLogin() {
  const { isLoaded, isSignedIn } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && isSignedIn) router.replace('/dashboard');
  }, [isLoaded, isSignedIn, router]);

  return (
    <LoginShell>
      {isLoaded && isSignedIn ? (
        <div role="status" className="flex items-center gap-3 py-8 text-sm text-muted-foreground">
          <Loader2 size={18} className="motion-safe:animate-spin" aria-hidden="true" />
          Redirection vers votre espace…
        </div>
      ) : !isLoaded ? (
        <LoginLoading />
      ) : (
        <SignIn
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
    </LoginShell>
  );
}

export default function LoginPage() {
  // Providers deliberately omits Clerk without a publishable key. Render the
  // unavailable state rather than invoking useAuth outside its provider.
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return (
      <LoginShell>
        <div className="space-y-4">
          <label htmlFor="login-email" className="block text-sm font-medium">
            Adresse e-mail
          </label>
          <Input
            id="login-email"
            type="email"
            placeholder="vous@restaurant.fr"
            disabled
            className="h-11 rounded-xl"
          />
          <Button disabled className="h-11 w-full rounded-xl">
            Continuer
          </Button>
          <p role="status" className="text-sm leading-relaxed text-muted-foreground">
            La connexion est momentanément indisponible. Veuillez réessayer dans quelques instants.
          </p>
          <Button
            variant="outline"
            className="w-full rounded-xl transition-all duration-200"
            onClick={() => window.location.reload()}
          >
            Réessayer
          </Button>
        </div>
      </LoginShell>
    );
  }

  return <ConnectedLogin />;
}
