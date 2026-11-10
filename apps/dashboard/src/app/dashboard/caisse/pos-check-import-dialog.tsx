'use client';

import { ImportDialog } from '@/components/import/import-dialog';

/** Ticket fields, in the order the owner sees them. Labels match the API's `POS_CHECK_FIELD_LABELS`. */
const FIELDS = [
  { key: 'externalId', label: 'Numéro de ticket', required: true },
  { key: 'openedAt', label: 'Ouverture', required: true },
  { key: 'closedAt', label: 'Clôture' },
  { key: 'table', label: 'Table' },
  { key: 'subtotal', label: 'Sous-total', required: true },
  { key: 'tax', label: 'TVA', required: true },
  { key: 'tip', label: 'Pourboire' },
  { key: 'discount', label: 'Remise' },
  { key: 'total', label: 'Total', required: true },
  { key: 'partySize', label: 'Couverts' },
  { key: 'reservationId', label: 'Réservation' },
] as const;

type Field = (typeof FIELDS)[number]['key'];

type PreviewLine = { externalId: string; tableReference: string | null; total: string };

type Counts = {
  imported?: number;
  skipped?: number;
  withReservation?: number;
  matched?: number;
  toReview?: number;
};

/** Tickets: each one is checked on its own; a bad row is skipped with its line number. */
export function PosCheckImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  return (
    <ImportDialog<Field>
      open={open}
      onOpenChange={onOpenChange}
      onImported={onImported}
      title="Importer des tickets de caisse"
      intro="Déposez l’export des tickets de votre caisse. Vous voyez le résumé avant tout enregistrement."
      endpoint="pos/checks/csv-import"
      fields={FIELDS}
      rememberKey="pos-checks"
      maxRows={1_500}
      emptyPreviewText="Le fichier ne contient aucun ticket exploitable."
      toPreviewLine={(row) => {
        const line = row as PreviewLine;
        return {
          primary: `${line.externalId}${line.tableReference ? ` · table ${line.tableReference}` : ''}`,
          secondary: formatEuro(line.total),
        };
      }}
      summaryLines={(raw) => {
        const counts = raw as Counts;
        const lines = [
          `${counts.imported ?? 0} ticket(s) à importer · ${counts.skipped ?? 0} ignoré(s)`,
          `Rapprochements probables : ${counts.matched ?? 0} · à vérifier : ${counts.toReview ?? 0} (calculés à l’import)`,
        ];
        if ((counts.withReservation ?? 0) > 0) {
          lines.push(`${counts.withReservation} ticket(s) avec une réservation`);
        }
        return lines;
      }}
      importableCount={(counts) => counts.imported ?? 0}
      importLabel={(counts) => `Importer ${counts.imported ?? 0} ticket(s)`}
      reportLines={(counts) => [
        `${counts.imported ?? 0} importé(s) · ${counts.skipped ?? 0} ignoré(s) · ${counts.matched ?? 0} rapproché(s) · ${counts.toReview ?? 0} à vérifier`,
      ]}
    />
  );
}

function formatEuro(value: string): string {
  const amount = Number(value);
  return Number.isFinite(amount)
    ? new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(amount)
    : value;
}
