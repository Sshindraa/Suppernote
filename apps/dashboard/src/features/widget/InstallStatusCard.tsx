'use client';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { describeInstallStatus, type Heartbeat } from './website-check';

type Props = {
  heartbeats: Heartbeat[] | null;
  heartbeatsError: string | null;
  canVerify: boolean;
  verifying: boolean;
  onVerify: () => void;
};

export function InstallStatusCard({
  heartbeats,
  heartbeatsError,
  canVerify,
  verifying,
  onVerify,
}: Props) {
  if (heartbeatsError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {heartbeatsError}
      </p>
    );
  }
  if (heartbeats === null) {
    return <Skeleton className="h-16 w-full rounded-xl" />;
  }

  const status = describeInstallStatus(heartbeats, new Date());
  const needsVerify = status.tone !== 'ok';

  return (
    <section aria-labelledby="install-status-title" className="space-y-3">
      <h2 id="install-status-title" className="text-base font-semibold">
        Statut de l’installation
      </h2>
      <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-sm">
          <span
            aria-hidden
            className={
              status.tone === 'ok'
                ? 'h-2 w-2 rounded-full bg-foreground'
                : status.tone === 'stale'
                  ? 'h-2 w-2 rounded-full bg-destructive'
                  : 'h-2 w-2 rounded-full bg-muted-foreground'
            }
          />
          {status.message}
        </p>
        {needsVerify && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canVerify || verifying}
            onClick={onVerify}
            className="shrink-0 transition-all duration-200"
          >
            {verifying ? 'Vérification…' : 'Vérifier l’installation'}
          </Button>
        )}
      </div>
    </section>
  );
}
