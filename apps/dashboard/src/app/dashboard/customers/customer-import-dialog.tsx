'use client';

import { useState } from 'react';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

const FIELDS = [
  { key: 'lastName', label: 'Nom' },
  { key: 'firstName', label: 'Prénom' },
  { key: 'name', label: 'Nom complet' },
  { key: 'phone', label: 'Téléphone' },
  { key: 'email', label: 'E-mail' },
  { key: 'birthday', label: 'Anniversaire' },
  { key: 'notes', label: 'Notes' },
] as const;

type Field = (typeof FIELDS)[number]['key'];
type Mapping = Partial<Record<Field, string | null>>;

type PreviewLine = {
  name: string | null;
  phone: string | null;
  email: string | null;
  birthMonth: number | null;
  birthDay: number | null;
};

type ImportResult = {
  dryRun: boolean;
  columns: { headers: string[]; mapping: Mapping };
  counts: { created: number; completed: number; skipped: number };
  reasons: { line: number; reason: string }[];
  preview: PreviewLine[];
};

/** Same limit as the API: a larger file is refused there, so refuse it before uploading. */
const MAX_FILE_CHARS = 5_000_000;

type Step = 'file' | 'verify' | 'report';

export function CustomerImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  const { post } = useApi();
  const [step, setStep] = useState<Step>('file');
  const [csv, setCsv] = useState('');
  const [mapping, setMapping] = useState<Mapping>({});
  const [verified, setVerified] = useState<ImportResult | null>(null);
  const [report, setReport] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setStep('file');
    setCsv('');
    setMapping({});
    setVerified(null);
    setReport(null);
    setLoading(false);
    setError('');
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /** Dry run: detects or applies the column mapping and counts what would happen. Writes nothing. */
  async function analyse(text: string, nextMapping?: Mapping) {
    setLoading(true);
    setError('');
    try {
      const res = await post<{ data: ImportResult }>('customers/import', {
        csv: text,
        dryRun: true,
        ...(nextMapping ? { mapping: fullMapping(nextMapping) } : {}),
      });
      setVerified(res.data);
      setMapping(res.data.columns.mapping);
      setStep('verify');
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible d'analyser le fichier"));
    } finally {
      setLoading(false);
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    if (file.size > MAX_FILE_CHARS) {
      setError('Ce fichier est trop volumineux pour être importé.');
      return;
    }
    const text = await file.text();
    setCsv(text);
    await analyse(text);
  }

  async function importNow() {
    setLoading(true);
    setError('');
    try {
      const res = await post<{ data: ImportResult }>('customers/import', {
        csv,
        dryRun: false,
        mapping: fullMapping(mapping),
      });
      setReport(res.data);
      setStep('report');
      onImported?.();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible d'importer le fichier"));
    } finally {
      setLoading(false);
    }
  }

  const hasPhone = Boolean(mapping.phone);
  const importable = verified ? verified.counts.created + verified.counts.completed : 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Importer des clients</DialogTitle>
          <DialogDescription>
            {step === 'file' && 'Choisissez le fichier CSV exporté depuis votre ancien outil.'}
            {step === 'verify' &&
              'Vérifiez les colonnes avant d’importer. Rien n’est enregistré pour l’instant.'}
            {step === 'report' && 'Voici le compte rendu de l’import.'}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {step === 'file' ? (
          loading ? (
            <div className="space-y-2" aria-busy="true">
              <p className="text-sm text-muted-foreground">Analyse du fichier…</p>
              <Skeleton className="h-10 w-full rounded-xl" />
            </div>
          ) : (
            <input
              type="file"
              accept=".csv,text/csv"
              aria-label="Fichier CSV à importer"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-foreground"
              onChange={(event) => void handleFile(event.target.files?.[0])}
            />
          )
        ) : null}

        {step === 'verify' && verified ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <label key={field.key} className="space-y-1 text-sm">
                  <span className="text-muted-foreground">{field.label}</span>
                  <select
                    aria-label={field.label}
                    className="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                    value={mapping[field.key] ?? ''}
                    disabled={loading}
                    onChange={(event) => {
                      const next = { ...mapping, [field.key]: event.target.value || null };
                      setMapping(next);
                      void analyse(csv, next);
                    }}
                  >
                    <option value="">Ne pas importer</option>
                    {verified.columns.headers.map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>

            {!hasPhone ? (
              <p className="text-sm text-destructive">
                Choisissez la colonne du téléphone : sans elle, aucun client ne peut être importé.
              </p>
            ) : null}

            {verified.preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Le fichier ne contient aucune ligne de client.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Aperçu des 5 premières lignes</p>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {verified.preview.map((line, index) => (
                    <li key={index} className="flex justify-between gap-3 px-3 py-2">
                      <span className="truncate">{line.name ?? 'Sans nom'}</span>
                      <span className="tabular-nums text-muted-foreground">
                        {line.phone ?? 'Téléphone invalide'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-sm tabular-nums">
              {verified.counts.created} à créer · {verified.counts.completed} à compléter ·{' '}
              {verified.counts.skipped} ignorée(s)
            </p>
            <Reasons reasons={verified.reasons} />
          </div>
        ) : null}

        {step === 'report' && report ? (
          <div className="space-y-3">
            <p className="text-sm tabular-nums">
              {report.counts.created} créé(s) · {report.counts.completed} complété(s) ·{' '}
              {report.counts.skipped} ignoré(s)
            </p>
            <Reasons reasons={report.reasons} />
          </div>
        ) : null}

        <DialogFooter>
          {step === 'verify' ? (
            <>
              <Button type="button" variant="outline" disabled={loading} onClick={reset}>
                Changer de fichier
              </Button>
              <Button
                type="button"
                disabled={loading || !hasPhone || importable === 0}
                onClick={() => void importNow()}
              >
                {loading ? 'Import…' : `Importer ${importable} client(s)`}
              </Button>
            </>
          ) : null}
          {step === 'report' ? (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Fermer
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Reasons({ reasons }: { reasons: { line: number; reason: string }[] }) {
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, 5);
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>Lignes ignorées :</p>
      <ul className="list-disc pl-5">
        {shown.map((item) => (
          <li key={item.line}>
            Ligne {item.line} : {item.reason}
          </li>
        ))}
      </ul>
      {reasons.length > shown.length ? <p>et {reasons.length - shown.length} autre(s).</p> : null}
    </div>
  );
}

/** The API treats a mapping as the full choice: every field is sent, `null` when not imported. */
function fullMapping(mapping: Mapping): Record<Field, string | null> {
  return Object.fromEntries(
    FIELDS.map((field) => [field.key, mapping[field.key] ?? null]),
  ) as Record<Field, string | null>;
}
