'use client';

import { ImportDialog } from '@/components/import/import-dialog';

/** Fields the importer understands; the owner can remap any of them on screen. */
const FIELDS = [
  { key: 'lastName', label: 'Nom' },
  { key: 'firstName', label: 'Prénom' },
  { key: 'name', label: 'Nom complet' },
  { key: 'phone', label: 'Téléphone', required: true },
  { key: 'email', label: 'E-mail' },
  { key: 'birthday', label: 'Anniversaire' },
  { key: 'notes', label: 'Notes' },
] as const;

type Field = (typeof FIELDS)[number]['key'];

type PreviewLine = { name: string | null; phone: string | null };

/** Clients: the API creates the new ones and completes the empty fields of the known ones. */
export function CustomerImportDialog({
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
      title="Importer des clients"
      intro="Déposez le fichier de vos clients. Vous voyez le résumé avant tout enregistrement."
      endpoint="customers/import"
      fields={FIELDS}
      rememberKey="customers"
      maxRows={5_000}
      emptyPreviewText="Le fichier ne contient aucune ligne de client."
      toPreviewLine={(row) => {
        const line = row as PreviewLine;
        return {
          primary: line.name ?? 'Sans nom',
          secondary: line.phone ?? 'Téléphone invalide',
        };
      }}
      summaryLines={(counts) => [
        `${counts.created ?? 0} à créer · ${counts.completed ?? 0} à compléter · ${counts.skipped ?? 0} ignorée(s)`,
      ]}
      importableCount={(counts) => (counts.created ?? 0) + (counts.completed ?? 0)}
      importLabel={(counts) =>
        `Importer ${(counts.created ?? 0) + (counts.completed ?? 0)} client(s)`
      }
      reportLines={(counts) => [
        `${counts.created ?? 0} créé(s) · ${counts.completed ?? 0} complété(s) · ${counts.skipped ?? 0} ignoré(s)`,
      ]}
    />
  );
}
