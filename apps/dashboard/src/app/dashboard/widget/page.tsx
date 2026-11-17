'use client';

// Parcours d'installation de la réservation sur le site du restaurant. Les couleurs ne sont pas
// réglables : le widget n'en tient pas compte.

import { useEffect, useState, useCallback } from 'react';
import { useApi } from '@/lib/api';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { DataFetchError } from '@/components/DataFetchError';
import { OnboardingLockBanner } from '@/features/onboarding/onboarding-guard';
import { getErrorMessage } from '@/types/api';
import { WidgetSetup } from '@/features/widget/WidgetSetup';

type ConnectSettings = {
  restaurantId: string;
  slug: string;
  name: string;
  connectPublished: boolean;
  websiteUrl?: string | null;
};

export default function WidgetIntegrationPage() {
  const { get, post, orgId } = useApi();
  const [settings, setSettings] = useState<ConnectSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(() => {
    if (!orgId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    get<ConnectSettings>(`restaurants/${orgId}/connect`)
      .then((s) => setSettings(s))
      .catch((err: unknown) => {
        setSettings(null);
        setError(getErrorMessage(err, 'Impossible de charger la configuration du widget.'));
      })
      .finally(() => setLoading(false));
  }, [orgId, get]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (!orgId && !loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          Sélectionnez un restaurant pour configurer le widget.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <OnboardingLockBanner task="connect-identity" />
      <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Widget</h1>

      {loading ? (
        <div className="space-y-6">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-96 w-full rounded-xl" />
        </div>
      ) : error ? (
        <DataFetchError message={error} onRetry={loadData} retrying={loading} />
      ) : !settings ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Aucune donnée disponible pour ce restaurant.
          </CardContent>
        </Card>
      ) : (
        <WidgetSetup slug={settings.slug} websiteUrl={settings.websiteUrl} api={{ get, post }} />
      )}
    </div>
  );
}
