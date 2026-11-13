'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Historique undo/redo borné pour les mutations de géométrie du plan.
 *
 * Le hook ne connaît ni l'API ni le canvas : il retourne uniquement le
 * snapshot à appliquer. Cela garde la pile déterministe et laisse le
 * composant propriétaire répercuter le changement localement puis en base.
 */

export type HistoryAction<T> = {
  before: T;
  after: T;
};

export type UndoHistory<T> = {
  record: (action: HistoryAction<T>) => void;
  /** Retourne le snapshot précédent, ou null si la pile est vide. */
  undo: () => T | null;
  /** Retourne le snapshot suivant, ou null si la pile est vide. */
  redo: () => T | null;
  /** Retire une action enregistrée (la mutation correspondante a échoué en base). */
  discard: (action: HistoryAction<T>) => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: () => void;
};

const HISTORY_LIMIT = 50;

export function useUndoHistory<T>(): UndoHistory<T> {
  const pastRef = useRef<HistoryAction<T>[]>([]);
  const futureRef = useRef<HistoryAction<T>[]>([]);
  // Re-render uniquement quand les indicateurs canUndo/canRedo changent.
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((version) => version + 1), []);

  const record = useCallback(
    (action: HistoryAction<T>) => {
      pastRef.current.push(action);
      if (pastRef.current.length > HISTORY_LIMIT) pastRef.current.shift();
      futureRef.current = [];
      bump();
    },
    [bump],
  );

  const undo = useCallback((): T | null => {
    const action = pastRef.current.pop();
    if (!action) return null;
    futureRef.current.push(action);
    bump();
    return action.before;
  }, [bump]);

  const redo = useCallback((): T | null => {
    const action = futureRef.current.pop();
    if (!action) return null;
    pastRef.current.push(action);
    bump();
    return action.after;
  }, [bump]);

  const discard = useCallback(
    (action: HistoryAction<T>) => {
      pastRef.current = pastRef.current.filter((entry) => entry !== action);
      futureRef.current = futureRef.current.filter((entry) => entry !== action);
      bump();
    },
    [bump],
  );

  const reset = useCallback(() => {
    pastRef.current = [];
    futureRef.current = [];
    bump();
  }, [bump]);

  return {
    record,
    undo,
    redo,
    canUndo: pastRef.current.length > 0,
    canRedo: futureRef.current.length > 0,
    discard,
    reset,
  };
}
