'use client';

import { useId, useState, type FormEvent } from 'react';
import { Loader2, UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';

/** Nom affiché d'un client placé sans réservation et sans nom. */
export const WALK_IN_DEFAULT_NAME = 'Sans réservation';

export type WalkInTable = { id: string; name: string; capacity: number };

/** Deux personnes, ou moins si la table est plus petite. */
export function defaultWalkInPartySize(capacity: number): number {
  return Math.max(1, Math.min(2, capacity));
}

/** Un message clair pour le restaurateur, jamais le texte brut de l'API. */
export function walkInErrorMessage(err: unknown): string {
  if ((err as { status?: number } | null)?.status === 409) {
    return 'Cette table n’est pas disponible : elle est déjà occupée ou réservée. Choisissez une autre table.';
  }
  return getErrorMessage(err, 'Impossible de placer ce client. Réessayez dans un instant.');
}

/**
 * Placer un client sans réservation sur une table libre : un bouton, puis un petit formulaire (nombre
 * de personnes, nom facultatif). Le composant porte son propre état de chargement et d'erreur ; il
 * disparaît avec la table libre dès que la réservation apparaît sur le plan.
 */
export function WalkInPlacement({
  table,
  onPlace,
  className,
}: {
  table: WalkInTable;
  /** Doit rejeter avec un `Error` dont le message est affiché tel quel. */
  onPlace: (partySize: number, customerName?: string) => Promise<void>;
  className?: string;
}) {
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [partySize, setPartySize] = useState(String(defaultWalkInPartySize(table.capacity)));
  const [customerName, setCustomerName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsedPartySize = Number(partySize);
  const partySizeValid =
    partySize.trim() !== '' &&
    Number.isInteger(parsedPartySize) &&
    parsedPartySize >= 1 &&
    parsedPartySize <= table.capacity;

  if (!open) {
    return (
      <Button
        type="button"
        size="sm"
        className={cn(
          'h-auto min-h-10 min-w-0 flex-1 whitespace-normal py-2 text-center font-medium leading-tight transition-all duration-200',
          className,
        )}
        onClick={() => setOpen(true)}
      >
        <UserPlus size={15} aria-hidden="true" className="mr-1.5 shrink-0" />
        Walk-in
      </Button>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!partySizeValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onPlace(parsedPartySize, customerName.trim() || undefined);
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : walkInErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      aria-label="Placer un client sans réservation"
      onSubmit={submit}
      className={cn(
        'w-full space-y-3 rounded-lg border border-border bg-background p-3 text-left',
        className,
      )}
    >
      <p className="text-sm font-medium text-foreground">
        Walk-in
        <span className="font-normal text-muted-foreground">
          {' · '}
          {table.name}
        </span>
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-party-size`} className="text-xs">
          Nombre de personnes
        </Label>
        <Input
          id={`${fieldId}-party-size`}
          type="number"
          inputMode="numeric"
          min={1}
          max={table.capacity}
          value={partySize}
          onChange={(event) => setPartySize(event.target.value)}
          disabled={submitting}
          aria-invalid={!partySizeValid}
          aria-describedby={`${fieldId}-party-size-hint`}
          className="h-9"
        />
        <p
          id={`${fieldId}-party-size-hint`}
          className={cn('text-xs', partySizeValid ? 'text-muted-foreground' : 'text-destructive')}
        >
          Entre 1 et {table.capacity} personnes pour cette table.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${fieldId}-name`} className="text-xs">
          Nom (facultatif)
        </Label>
        <Input
          id={`${fieldId}-name`}
          type="text"
          maxLength={120}
          value={customerName}
          onChange={(event) => setCustomerName(event.target.value)}
          disabled={submitting}
          placeholder={WALK_IN_DEFAULT_NAME}
          className="h-9"
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          className="h-9 flex-1 transition-all duration-200"
          disabled={!partySizeValid || submitting}
        >
          {submitting ? (
            <>
              <Loader2 size={14} aria-hidden="true" className="mr-1.5 animate-spin" />
              Placement…
            </>
          ) : (
            'Placer le client'
          )}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-9 transition-all duration-200"
          disabled={submitting}
          onClick={() => {
            setOpen(false);
            setError(null);
          }}
        >
          Annuler
        </Button>
      </div>
    </form>
  );
}
