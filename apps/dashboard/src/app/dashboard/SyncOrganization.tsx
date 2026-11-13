'use client';

import { useAuth, useOrganization } from '@clerk/nextjs';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

/** Provisionne le compte connecté, avec reprise bornée des erreurs transitoires. */
export function SyncOrganization() {
  const { isSignedIn } = useAuth();
  const { organization } = useOrganization();
  const organizationId = organization?.id;
  const [retry, setRetry] = useState(0);
  const [failure, setFailure] = useState<{ organizationId: string; retry: number } | null>(null);

  useEffect(() => {
    if (!isSignedIn || !organizationId) return;

    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function sync(attempt: number) {
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 10_000);
      let retryable = true;
      let retryAfterMs: number | undefined;
      try {
        const res = await fetch('/api/auth/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: request.signal,
        });
        if (cancelled) return;
        if (res.ok) {
          setFailure(null);
          // Le provider multi-site peut avoir chargé avant la création du restaurant.
          window.dispatchEvent(new Event('suppernote:organization-synced'));
          return;
        }
        retryable = res.status >= 500 || res.status === 429;
        const retryAfterSeconds = Number(res.headers.get('retry-after'));
        if (retryAfterSeconds > 0) retryAfterMs = retryAfterSeconds * 1_000;
      } catch {
        // Une erreur réseau ou un délai dépassé ne valide jamais la synchronisation.
      } finally {
        clearTimeout(timeout);
      }
      if (cancelled) return;
      if (retryable && attempt < 2) {
        // Le délai annoncé par l'API (429) prime sur la reprise par défaut.
        retryTimer = setTimeout(
          () => void sync(attempt + 1),
          retryAfterMs ?? 1_000 * (attempt + 1),
        );
      } else {
        setFailure({ organizationId: organizationId!, retry });
      }
    }

    void sync(0);
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      controller?.abort();
    };
  }, [isSignedIn, organizationId, retry]);

  if (
    !isSignedIn ||
    !failure ||
    failure.organizationId !== organizationId ||
    failure.retry !== retry
  ) {
    return null;
  }

  return (
    <div role="alert" className="m-6 rounded-xl border border-border bg-card p-6 text-foreground">
      <p>Impossible de préparer votre compte. Réessayez pour poursuivre votre inscription.</p>
      <Button
        className="mt-4 transition-all duration-200"
        onClick={() => setRetry((value) => value + 1)}
      >
        Réessayer
      </Button>
    </div>
  );
}
