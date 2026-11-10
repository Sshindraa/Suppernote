'use client';

import { useState } from 'react';
import { decodeCsvBytes } from '@suppernote/shared';
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

/** Ticket fields, in the order the owner sees them. Labels match the API's `POS_CHECK_FIELD_LABELS`. */
const FIELDS = [
  { key: 'externalId', label: 'Numéro de ticket', required: true },
  { key: 'openedAt', label: 'Ouverture', required: true },
  { key: 'closedAt', label: 'Clôture', required: false },
  { key: 'table', label: 'Table', required: false },
  { key: 'subtotal', label: 'Sous-total', required: true },
  { key: 'tax', label: 'TVA', required: true },
  { key: 'tip', label: 'Pourboire', required: false },
  { key: 'discount', label: 'Remise', required: false },
  { key: 'total', label: 'Total', required: true },
  { key: 'partySize', label: 'Couverts', required: false },
  { key: 'reservationId', label: 'Réservation', required: false },
] as const;

type Field = (typeof FIELDS)[number]['key'];
type Mapping = Partial<Record<Field, string | null>>;

type Reason = { line: number; reason: string };

type ImportResult = {
  dryRun: boolean;
  columns: { headers: string[]; mapping: Mapping };
  missing: Field[];
  counts: { imported: number; skipped: number; withReservation: number; matched: number };
  reasons: Reason[];
  preview: { externalId: string; openedAt: string; tableReference: string | null; total: string }[];
};

/** Mirrors the API: nginx lets 1 MiB of request body through, and the CSV text is capped at 700 000 characters. */
const MAX_BODY_BYTES = 1_048_576;
const MAX_CSV_CHARS = 700_000;
const TOO_LARGE_MESSAGE =
  'Ce fichier est trop volumineux pour être importé d’un coup (1 Mo ou 700 000 caractères au maximum). Découpez-le en plusieurs fichiers.';

type Step = 'file' | 'verify' | 'report';

export function PosCheckImportDialog({
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

  /** Checks the exact body size (the JSON that nginx counts) before sending, so the owner gets a clear message. */
  async function callImport(body: { csv: string; dryRun: boolean; mapping?: Mapping }) {
    const bytes = new TextEncoder().encode(JSON.stringify(body)).byteLength;
    if (body.csv.length > MAX_CSV_CHARS || bytes > MAX_BODY_BYTES) {
      throw new Error(TOO_LARGE_MESSAGE);
    }
    return post<{ data: ImportResult }>('pos/checks/csv-import', body);
  }

  /** Dry run: detects or applies the column mapping and counts what would happen. Writes no ticket. */
  async function analyse(text: string, nextMapping?: Mapping) {
    setLoading(true);
    setError('');
    try {
      const res = await callImport({
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
    const text = decodeCsvBytes(await file.arrayBuffer());
    setCsv(text);
    await analyse(text);
  }

  async function importNow() {
    setLoading(true);
    setError('');
    try {
      const res = await callImport({ csv, dryRun: false, mapping: fullMapping(mapping) });
      setReport(res.data);
      setStep('report');
      onImported?.();
    } catch (err: unknown) {
      setError(getErrorMessage(err, "Impossible d'importer le fichier"));
    } finally {
      setLoading(false);
    }
  }

  const missing = verified?.missing ?? [];
  const importable = verified?.counts.imported ?? 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Importer des tickets de caisse</DialogTitle>
          <DialogDescription>
            {step === 'file' &&
              'Choisissez le fichier CSV des tickets exporté depuis votre caisse.'}
            {step === 'verify' &&
              'Vérifiez les colonnes avant d’importer. Aucun ticket n’est enregistré pour l’instant.'}
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
            <div className="space-y-2">
              <input
                type="file"
                accept=".csv,text/csv"
                aria-label="Fichier CSV des tickets"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-3 file:py-2 file:text-foreground"
                onChange={(event) => void handleFile(event.target.files?.[0])}
              />
              <p className="text-sm text-muted-foreground">
                Enregistrez un export Excel en CSV avant l’import (Fichier › Enregistrer sous ›
                CSV). Un fichier .xlsx n’est pas accepté.
              </p>
            </div>
          )
        ) : null}

        {step === 'verify' && verified ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {FIELDS.map((field) => (
                <label key={field.key} className="space-y-1 text-sm">
                  <span className="text-muted-foreground">
                    {field.label}
                    {field.required ? ' *' : ''}
                  </span>
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

            {missing.length > 0 ? (
              <p className="text-sm text-destructive">
                Choisissez une colonne pour {missing.map(labelOf).join(', ')} : sans elle, aucun
                ticket ne peut être importé.
              </p>
            ) : null}

            {verified.preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Le fichier ne contient aucun ticket exploitable.
              </p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Aperçu des 5 premiers tickets</p>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {verified.preview.map((ticket) => (
                    <li key={ticket.externalId} className="flex justify-between gap-3 px-3 py-2">
                      <span className="truncate">
                        {ticket.externalId}
                        {ticket.tableReference ? ` · table ${ticket.tableReference}` : ''}
                      </span>
                      <span className="tabular-nums text-muted-foreground">
                        {formatEuro(ticket.total)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-sm tabular-nums">
              {verified.counts.imported} ticket(s) à importer · {verified.counts.skipped} ignoré(s)
              {verified.counts.withReservation > 0
                ? ` · ${verified.counts.withReservation} avec une réservation`
                : ''}
            </p>
            <Reasons reasons={verified.reasons} />
          </div>
        ) : null}

        {step === 'report' && report ? (
          <div className="space-y-3">
            <p className="text-sm tabular-nums">
              {report.counts.imported} importé(s) · {report.counts.skipped} ignoré(s) ·{' '}
              {report.counts.matched} rapproché(s) d’une réservation
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
                disabled={loading || missing.length > 0 || importable === 0}
                onClick={() => void importNow()}
              >
                {loading ? 'Import…' : `Importer ${importable} ticket(s)`}
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

function labelOf(field: Field): string {
  return FIELDS.find((item) => item.key === field)?.label ?? field;
}

function formatEuro(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount)
    : value;
}

function Reasons({ reasons }: { reasons: Reason[] }) {
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

/** The API treats a mapping as the full choice: every field is sent, `null` when not read. */
function fullMapping(mapping: Mapping): Mapping {
  return Object.fromEntries(FIELDS.map((field) => [field.key, mapping[field.key] ?? null]));
}
