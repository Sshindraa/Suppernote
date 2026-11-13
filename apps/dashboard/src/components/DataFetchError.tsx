'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

type DataFetchErrorProps = {
  message: string;
  onRetry: () => void;
  retrying?: boolean;
};

/**
 * État d'erreur commun aux écrans opérationnels.
 *
 * Une panne temporaire ne doit pas laisser le restaurateur devant un message
 * sans action, ni lui faire croire que la liste est réellement vide.
 */
export function DataFetchError({ message, onRetry, retrying = false }: DataFetchErrorProps) {
  return (
    <div role="alert" className="suppernote-error items-start justify-between sm:items-center">
      <div className="flex min-w-0 items-start gap-3">
        <AlertCircle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
        <p className="min-w-0">{message}</p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={onRetry}
        disabled={retrying}
      >
        <RefreshCw size={14} className={retrying ? 'animate-spin' : undefined} aria-hidden="true" />
        {retrying ? 'Nouvel essai…' : 'Réessayer'}
      </Button>
    </div>
  );
}
