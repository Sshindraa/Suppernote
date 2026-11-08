'use client';

import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { useOnboarding } from './onboarding-provider';
import { capturePlanChoice } from './pending-plan';
import { ONBOARDING_TASK_KEYS } from './types';
import { TRACK_STEPS } from './tracks';

/** Un parcours reporté ou un état indisponible ne déverrouille jamais le dashboard. */
export function OnboardingAccessBoundary({
  children,
  onboarding,
  controls,
  enforceAccess = true,
  crmQualificationRestaurantIds = [],
}: {
  children: ReactNode;
  onboarding: ReactNode;
  controls?: ReactNode;
  enforceAccess?: boolean;
  crmQualificationRestaurantIds?: string[];
}) {
  const { state, loading, refresh } = useOnboarding();
  const pathname = usePathname();
  const router = useRouter();
  const complete =
    state &&
    ONBOARDING_TASK_KEYS.every((key) =>
      state.steps.some((step) => step.key === key && step.status === 'completed'),
    );
  // Accès demandé pour le restaurant de test RGPD, sans activer ses canaux.
  const testRestaurant = state?.restaurant?.id === 'org_3ITQ1oVrrbAPwz0xJKAq084CBAc';

  // Exception de qualification déclarée côté serveur : aucun canal n'est marqué terminé.
  // L'API conserve ses contrôles Clerk, de rôle, de site et de formule.
  const crmQualification = Boolean(
    state?.restaurant?.id &&
    crmQualificationRestaurantIds.includes(state.restaurant.id) &&
    (pathname === '/dashboard/customers' || pathname.startsWith('/dashboard/customers/')) &&
    TRACK_STEPS.socle.every((key) =>
      state.steps.some((step) => step.key === key && step.status === 'completed'),
    ),
  );

  // La formule choisie sur la page Tarifs arrive dans l'adresse, que la redirection ci-dessous
  // efface : on la garde pour l'écran « Choisissez votre formule » de l'inscription.
  useEffect(() => {
    capturePlanChoice(window.location.search);
  }, []);

  useEffect(() => {
    if (!enforceAccess || loading) return;
    if (complete && pathname === '/onboarding') {
      router.replace('/dashboard');
    } else if (
      !complete &&
      !testRestaurant &&
      !crmQualification &&
      pathname.startsWith('/dashboard')
    ) {
      router.replace('/onboarding');
    }
  }, [complete, testRestaurant, crmQualification, enforceAccess, loading, pathname, router]);

  if (!enforceAccess) return <>{children}</>;

  if (!loading && (complete || testRestaurant || crmQualification) && pathname !== '/onboarding')
    return <>{children}</>;
  if (!loading && complete && pathname === '/onboarding') {
    return (
      <main
        role="status"
        className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground"
      >
        Votre espace Suppernote est prêt…
      </main>
    );
  }

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      <div className="w-full">
        <div className="absolute right-4 top-4 z-20 flex items-center gap-3">{controls}</div>
        {loading ? (
          <p
            role="status"
            className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground"
          >
            Vérification de votre configuration…
          </p>
        ) : !state ? (
          <div role="alert" className="rounded-2xl border border-border bg-card p-6">
            <p className="text-sm text-muted-foreground">
              La configuration est momentanément indisponible. Réessayez pour reprendre votre
              parcours.
            </p>
            <Button onClick={() => void refresh()} className="mt-4 transition-all duration-200">
              Réessayer
            </Button>
          </div>
        ) : (
          onboarding
        )}
      </div>
    </main>
  );
}
