'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Receipt, Upload } from 'lucide-react';
import { useApi } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { useCapabilities } from '@/lib/use-capabilities';
import { getErrorMessage } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { DataFetchError } from '@/components/DataFetchError';
import { PosCheckImportDialog } from './pos-check-import-dialog';

type PosConnection = {
  provider: string;
  status: string;
  lastSuccessAt: string | null;
};

type PageState =
  | { kind: 'loading' }
  | { kind: 'disabled' }
  | { kind: 'forbidden' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; lastImportAt: string | null };

/** The file connection is the one this page writes to; provider connections are not shown yet. */
const FILE_PROVIDER = 'csv-file';

function stateFromError(err: unknown): PageState {
  if (err instanceof ApiError && err.code === 'POS_CONNECTORS_DISABLED')
    return { kind: 'disabled' };
  if (err instanceof ApiError && err.status === 403) return { kind: 'forbidden' };
  return {
    kind: 'error',
    message: getErrorMessage(err, 'Impossible de charger la caisse pour le moment.'),
  };
}

export default function CaissePage() {
  const { get } = useApi();
  const capabilities = useCapabilities();
  const [state, setState] = useState<PageState>({ kind: 'loading' });
  const [importOpen, setImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Wait for the server's answer: a restaurant without the capability never calls the API.
    if (capabilities === null || capabilities['pos.connect'] !== true) return;
    const controller = new AbortController();
    get<{ data: PosConnection[] }>('pos/connections', { signal: controller.signal })
      .then((response) => {
        if (controller.signal.aborted) return;
        const file = response.data.find((connection) => connection.provider === FILE_PROVIDER);
        setState({ kind: 'ready', lastImportAt: file?.lastSuccessAt ?? null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState(stateFromError(err));
      });
    return () => controller.abort();
  }, [capabilities, get, reloadKey]);

  function reload() {
    setState({ kind: 'loading' });
    setReloadKey((key) => key + 1);
  }

  if (capabilities === null) return <PageSkeleton />;

  if (capabilities['pos.connect'] !== true) {
    return (
      <PageShell>
        <EmptyCard
          title="La caisse n’est pas incluse dans votre formule"
          text="L’import des tickets de caisse est proposé avec les formules Pro et Multi-restaurant."
        />
      </PageShell>
    );
  }

  if (state.kind === 'loading') return <PageSkeleton />;

  if (state.kind === 'disabled') {
    return (
      <PageShell>
        <EmptyCard
          title="Import de tickets pas encore ouvert"
          text="L’import des tickets de caisse n’est pas encore ouvert pour votre restaurant. Nous vous préviendrons dès qu’il sera disponible."
        />
      </PageShell>
    );
  }

  if (state.kind === 'forbidden') {
    return (
      <PageShell>
        <EmptyCard
          title="Réservé aux responsables"
          text="Seuls le propriétaire et les responsables du restaurant peuvent importer les tickets de caisse."
        />
      </PageShell>
    );
  }

  if (state.kind === 'error') {
    return (
      <PageShell>
        <DataFetchError message={state.message} onRetry={reload} />
      </PageShell>
    );
  }

  return (
    <PageShell>
      <section className="flex flex-col gap-4 rounded-xl border border-border bg-card p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-semibold">Importer les tickets</h2>
          <p className="text-sm text-muted-foreground">
            {state.lastImportAt
              ? `Dernier import : ${formatDateTime(state.lastImportAt)}`
              : 'Aucun ticket importé pour l’instant.'}
          </p>
        </div>
        <Button
          type="button"
          className="transition-all duration-200"
          onClick={() => setImportOpen(true)}
        >
          <Upload className="mr-2 h-4 w-4" aria-hidden="true" />
          Importer un fichier CSV
        </Button>
      </section>

      <section className="rounded-xl border border-dashed border-border p-6 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Tickets importés</p>
        <p className="mt-1">
          Le détail des tickets et leur rapprochement avec les réservations seront affichés ici dans
          une prochaine version.
        </p>
      </section>

      <PosCheckImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={reload} />
    </PageShell>
  );
}

function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 p-6 md:p-8">
      <header className="flex items-center gap-3">
        <Receipt className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Caisse</h1>
          <p className="text-sm text-muted-foreground">
            Mesurez la dépense réelle par table à partir de vos tickets.
          </p>
        </div>
      </header>
      {children}
    </div>
  );
}

function EmptyCard({ title, text }: { title: string; text: string }) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{text}</p>
    </section>
  );
}

function PageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6 md:p-8" aria-busy="true">
      <Skeleton className="h-8 w-40 rounded-xl" />
      <Skeleton className="h-24 w-full rounded-xl" />
    </div>
  );
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
