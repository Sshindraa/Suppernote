'use client';

import { useRef, useState, type KeyboardEvent } from 'react';
import { FileSpreadsheet } from 'lucide-react';
import { splitCsvText, type CsvPiece } from '@suppernote/shared';
import { useApi } from '@/lib/api';
import { getErrorMessage } from '@/types/api';
import { useSiteSelection } from '@/features/sites/site-context';
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
import { cn } from '@/lib/utils';
import { IMPORT_FILE_ACCEPT, readImportFile, recallColumns, rememberColumns } from './import-file';

/**
 * Under the 1 MiB body limit of nginx, with room for JSON escapes and accents, and under the
 * 30 s proxy timeout for one piece. Bigger files are cut into pieces, never refused.
 */
export const MAX_PIECE_CHARS = 250_000;

export type ImportFieldDef<F extends string> = { key: F; label: string; required?: boolean };
export type ImportCounts = Record<string, number>;
export type ImportReasonItem = { line: number; reason: string };
export type ImportLineView = { primary: string; secondary: string };
export type ImportMapping<F extends string> = Partial<Record<F, string | null>>;

/** What the API answers for one piece. The dashboard only adds these pieces together. */
export type ImportPieceResult<F extends string> = {
  dryRun: boolean;
  columns: {
    headers: string[];
    headerLine: number | null;
    mapping: ImportMapping<F>;
    byContent?: F[];
  };
  counts: ImportCounts;
  reasons: ImportReasonItem[];
  preview: unknown[];
};

export type ImportDialogProps<F extends string> = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
  title: string;
  intro: string;
  endpoint: string;
  fields: readonly ImportFieldDef<F>[];
  /** Keeps the column choices for the next import of this restaurant, in this browser. */
  rememberKey: string;
  /** Rows per piece: under the API's row ceiling. */
  maxRows: number;
  emptyPreviewText: string;
  toPreviewLine: (row: unknown) => ImportLineView;
  summaryLines: (counts: ImportCounts) => string[];
  importableCount: (counts: ImportCounts) => number;
  importLabel: (counts: ImportCounts) => string;
  reportLines: (counts: ImportCounts) => string[];
};

type Status = 'empty' | 'analysing' | 'ready' | 'importing' | 'partial' | 'done';

type Analysis<F extends string> = {
  headers: string[];
  headerLine: number | null;
  mapping: ImportMapping<F>;
  /** Fields found from their values: shown for the owner to check. */
  uncertain: F[];
  counts: ImportCounts;
  reasons: ImportReasonItem[];
  preview: unknown[];
};

type Progress = { done: number; total: number };

const REASON_LIMIT = 5;
const UNREADABLE_MESSAGE =
  'Impossible de lire ce fichier. Vérifiez qu’il s’agit d’un fichier CSV ou Excel (.xlsx).';
const EMPTY_FILE_MESSAGE = 'Ce fichier est vide.';

export function ImportDialog<F extends string>(props: ImportDialogProps<F>) {
  const { open, onOpenChange, onImported, title, intro, endpoint, fields, rememberKey, maxRows } =
    props;
  const { post } = useApi();
  const siteId = useSiteSelection()?.activeSiteId ?? 'default';
  const storageKey = `${rememberKey}:${siteId}`;
  const inputRef = useRef<HTMLInputElement>(null);

  const [status, setStatus] = useState<Status>('empty');
  const [text, setText] = useState('');
  const [analysis, setAnalysis] = useState<Analysis<F> | null>(null);
  const [pieces, setPieces] = useState<CsvPiece[]>([]);
  const [editing, setEditing] = useState(false);
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 });
  const [failure, setFailure] = useState<{
    index: number;
    message: string;
    counts: ImportCounts;
    reasons: ImportReasonItem[];
  } | null>(null);
  const [report, setReport] = useState<{
    counts: ImportCounts;
    reasons: ImportReasonItem[];
  } | null>(null);
  const [remembered, setRemembered] = useState(false);
  const [error, setError] = useState('');

  function reset() {
    setStatus('empty');
    setText('');
    setAnalysis(null);
    setPieces([]);
    setEditing(false);
    setProgress({ done: 0, total: 0 });
    setFailure(null);
    setReport(null);
    setRemembered(false);
    setError('');
  }

  function handleOpenChange(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  /** One request for one piece; the body is checked against the limits before it leaves. */
  async function send(
    piece: CsvPiece,
    body: { dryRun: boolean; mapping?: ImportMapping<F>; hasHeader?: boolean },
  ) {
    const payload = {
      csv: piece.csv,
      dryRun: body.dryRun,
      lineOffset: piece.lineOffset,
      ...(body.hasHeader === undefined ? {} : { hasHeader: body.hasHeader }),
      ...(body.mapping ? { mapping: body.mapping } : {}),
    };
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    if (bytes > 1_048_576) throw new Error('Ce morceau du fichier est trop lourd. Réessayez.');
    const res = await post<{ data: ImportPieceResult<F> }>(endpoint, payload);
    return res.data;
  }

  /** Every field is sent, `null` when not imported: the API reads the mapping as the full choice. */
  function fullMapping(mapping: ImportMapping<F>): ImportMapping<F> {
    return Object.fromEntries(
      fields.map((field) => [field.key, mapping[field.key] ?? null]),
    ) as ImportMapping<F>;
  }

  /** Dry run over every piece with the chosen columns: counts, preview, reasons. Writes nothing. */
  async function analyse(source: string, override?: ImportMapping<F>) {
    setStatus('analysing');
    setError('');
    setProgress({ done: 0, total: 0 });
    try {
      const probePiece = splitCsvText(source, {
        headerLine: null,
        maxChars: MAX_PIECE_CHARS,
        maxRows,
      })[0];
      if (!probePiece) throw new Error(EMPTY_FILE_MESSAGE);
      const probe = await send(probePiece, { dryRun: true });
      const headerLine = probe.columns.headerLine;
      const hasHeader = headerLine !== null;

      const kept = override ? {} : recallColumns(storageKey, probe.columns.headers);
      const mapping: ImportMapping<F> = override ?? {
        ...probe.columns.mapping,
        ...(kept as ImportMapping<F>),
      };
      const uncertain = override
        ? []
        : (probe.columns.byContent ?? []).filter((field) => kept[field] === undefined);
      setRemembered(!override && Object.keys(kept).length > 0);

      const allPieces = splitCsvText(source, { headerLine, maxChars: MAX_PIECE_CHARS, maxRows });
      const counts: ImportCounts = {};
      const reasons: ImportReasonItem[] = [];
      let preview: unknown[] = [];
      for (let index = 0; index < allPieces.length; index++) {
        setProgress({ done: index, total: allPieces.length });
        const result = await send(allPieces[index]!, {
          dryRun: true,
          mapping: fullMapping(mapping),
          hasHeader,
        });
        if (index === 0) preview = result.preview;
        addInto(counts, result.counts);
        reasons.push(...result.reasons);
      }

      setPieces(allPieces);
      setText(source);
      setAnalysis({
        headers: probe.columns.headers,
        headerLine,
        mapping,
        uncertain,
        counts,
        reasons,
        preview,
      });
      setEditing(uncertain.length > 0 || missingFields(mapping, fields).length > 0);
      setStatus('ready');
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible d’analyser le fichier.'));
      setStatus(analysis ? 'ready' : 'empty');
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setError('');
    setStatus('analysing');
    let source: string;
    try {
      source = await readImportFile(file);
    } catch {
      setError(UNREADABLE_MESSAGE);
      setStatus('empty');
      return;
    }
    await analyse(source);
  }

  /** Imports the pieces in order from `from`. A failed piece stops the run; earlier ones stay. */
  async function importFrom(
    from: number,
    base: { counts: ImportCounts; reasons: ImportReasonItem[] },
  ) {
    if (!analysis) return;
    setStatus('importing');
    setError('');
    setFailure(null);
    const mapping = analysis.mapping;
    const hasHeader = analysis.headerLine !== null;
    const counts = { ...base.counts };
    const reasons = [...base.reasons];
    for (let index = from; index < pieces.length; index++) {
      setProgress({ done: index, total: pieces.length });
      try {
        const result = await send(pieces[index]!, {
          dryRun: false,
          mapping: fullMapping(mapping),
          hasHeader,
        });
        if (index === 0) rememberColumns(storageKey, mapping);
        addInto(counts, result.counts);
        reasons.push(...result.reasons);
      } catch (err: unknown) {
        setFailure({
          index,
          message: getErrorMessage(err, 'Erreur inconnue.'),
          counts,
          reasons,
        });
        setProgress({ done: index, total: pieces.length });
        setStatus('partial');
        return;
      }
    }
    setProgress({ done: pieces.length, total: pieces.length });
    setReport({ counts, reasons });
    setStatus('done');
    onImported?.();
  }

  function changeColumn(field: F, column: string) {
    if (!analysis) return;
    const next = { ...analysis.mapping, [field]: column || null } as ImportMapping<F>;
    void analyse(text, next);
  }

  function handleDropKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      inputRef.current?.click();
    }
  }

  const missing = analysis ? missingFields(analysis.mapping, fields) : [];
  const importable = analysis ? props.importableCount(analysis.counts) : 0;
  const busy = status === 'analysing' || status === 'importing';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {status === 'done' ? 'Voici le compte rendu de l’import.' : intro}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {status === 'empty' ? (
          <div
            role="button"
            tabIndex={0}
            aria-label="Déposer un fichier, ou cliquer pour le choisir"
            onClick={() => inputRef.current?.click()}
            onKeyDown={handleDropKey}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              void handleFile(event.dataTransfer.files[0]);
            }}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border p-8 text-center transition-all duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            )}
          >
            <FileSpreadsheet className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm font-medium">
              Glissez votre fichier ici, ou cliquez pour le choisir
            </p>
            <p className="text-xs text-muted-foreground">Fichier CSV ou Excel (.xlsx)</p>
          </div>
        ) : null}

        <input
          ref={inputRef}
          type="file"
          accept={IMPORT_FILE_ACCEPT}
          aria-label="Fichier à importer"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void handleFile(file);
          }}
        />

        {busy ? (
          <div className="space-y-2" aria-busy="true">
            <p className="text-sm text-muted-foreground">
              {status === 'analysing' ? 'Analyse du fichier…' : 'Import en cours…'}
            </p>
            {progress.total > 1 ? <ProgressBar progress={progress} /> : null}
            <Skeleton className="h-10 w-full rounded-xl" />
          </div>
        ) : null}

        {status === 'ready' && analysis ? (
          <div className="space-y-4">
            {remembered ? (
              <p className="text-xs text-muted-foreground">
                Colonnes reprises de votre dernier import (mémorisées dans ce navigateur).
              </p>
            ) : null}

            {missing.length > 0 ? (
              <p className="text-sm text-destructive">
                Choisissez une colonne pour {missing.map(labelOf(fields)).join(', ')}. Sans elle,
                rien ne peut être importé.
              </p>
            ) : null}
            {analysis.uncertain.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                Nous avons reconnu {analysis.uncertain.map(labelOf(fields)).join(', ')} à partir du
                contenu des colonnes. Vérifiez que c’est bien cela.
              </p>
            ) : null}

            {editing ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {fields.map((field) => (
                  <label key={field.key} className="space-y-1 text-sm">
                    <span className="text-muted-foreground">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </span>
                    <select
                      aria-label={field.label}
                      className="block w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      value={analysis.mapping[field.key] ?? ''}
                      disabled={busy}
                      onChange={(event) => changeColumn(field.key, event.target.value)}
                    >
                      <option value="">Ne pas importer</option>
                      {analysis.headers.map((header) => (
                        <option key={header} value={header}>
                          {header}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            ) : (
              <button
                type="button"
                className="text-sm text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
                onClick={() => setEditing(true)}
              >
                Modifier les colonnes
              </button>
            )}

            {analysis.preview.length === 0 ? (
              <p className="text-sm text-muted-foreground">{props.emptyPreviewText}</p>
            ) : (
              <div className="space-y-2">
                <p className="text-sm font-medium">Aperçu des 5 premières lignes</p>
                <ul className="divide-y divide-border rounded-md border border-border text-sm">
                  {analysis.preview.map((row, index) => {
                    const line = props.toPreviewLine(row);
                    return (
                      <li key={index} className="flex justify-between gap-3 px-3 py-2">
                        <span className="truncate">{line.primary}</span>
                        <span className="tabular-nums text-muted-foreground">{line.secondary}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {props.summaryLines(analysis.counts).map((line) => (
              <p key={line} className="text-sm tabular-nums">
                {line}
              </p>
            ))}
            <Reasons reasons={analysis.reasons} />
          </div>
        ) : null}

        {status === 'partial' && failure ? (
          <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">
              Le morceau {failure.index + 1} sur {pieces.length} n’a pas pu être importé :{' '}
              {failure.message}. Les morceaux précédents sont bien enregistrés.
            </p>
            <p className="text-sm tabular-nums">{props.reportLines(failure.counts).join(' · ')}</p>
          </div>
        ) : null}

        {status === 'done' && report ? (
          <div className="space-y-3">
            {pieces.length > 1 ? (
              <p className="text-sm text-muted-foreground">
                Fichier importé en {pieces.length} morceaux.
              </p>
            ) : null}
            {props.reportLines(report.counts).map((line) => (
              <p key={line} className="text-sm tabular-nums">
                {line}
              </p>
            ))}
            <Reasons reasons={report.reasons} />
            <p className="text-xs text-muted-foreground">
              Les colonnes choisies sont mémorisées dans ce navigateur pour le prochain import.
            </p>
          </div>
        ) : null}

        <DialogFooter>
          {status === 'ready' && analysis ? (
            <>
              <Button type="button" variant="outline" onClick={reset}>
                Changer de fichier
              </Button>
              <Button
                type="button"
                disabled={missing.length > 0 || importable === 0}
                onClick={() => void importFrom(0, { counts: {}, reasons: [] })}
              >
                {props.importLabel(analysis.counts)}
              </Button>
            </>
          ) : null}
          {status === 'partial' && failure ? (
            <>
              <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                Arrêter là
              </Button>
              <Button
                type="button"
                onClick={() =>
                  void importFrom(failure.index, {
                    counts: failure.counts,
                    reasons: failure.reasons,
                  })
                }
              >
                Reprendre à partir du morceau {failure.index + 1}
              </Button>
            </>
          ) : null}
          {status === 'done' ? (
            <Button type="button" onClick={() => handleOpenChange(false)}>
              Fermer
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProgressBar({ progress }: { progress: Progress }) {
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label="Avancement de l’import"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.done}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full bg-primary transition-all duration-200"
          style={{ width: `${percent}%` }}
        />
      </div>
      <p className="text-xs tabular-nums text-muted-foreground">
        Morceau {Math.min(progress.done + 1, progress.total)} sur {progress.total}
      </p>
    </div>
  );
}

function Reasons({ reasons }: { reasons: ImportReasonItem[] }) {
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, REASON_LIMIT);
  return (
    <div className="space-y-1 text-sm text-muted-foreground">
      <p>Lignes ignorées :</p>
      <ul className="list-disc pl-5">
        {shown.map((item, index) => (
          <li key={`${item.line}-${index}`}>
            Ligne {item.line} : {item.reason}
          </li>
        ))}
      </ul>
      {reasons.length > shown.length ? <p>et {reasons.length - shown.length} autre(s).</p> : null}
    </div>
  );
}

/** Required fields with no column: they block the import, the others are simply left out. */
function missingFields<F extends string>(
  mapping: ImportMapping<F>,
  fields: readonly ImportFieldDef<F>[],
): F[] {
  return fields.filter((field) => field.required && !mapping[field.key]).map((field) => field.key);
}

function labelOf<F extends string>(fields: readonly ImportFieldDef<F>[]) {
  return (field: F) => fields.find((item) => item.key === field)?.label ?? field;
}

function addInto(target: ImportCounts, source: ImportCounts) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}
