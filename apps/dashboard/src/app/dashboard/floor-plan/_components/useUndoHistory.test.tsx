import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useUndoHistory } from './useUndoHistory';

type Snapshot = { id: string; x: number };

function action(beforeX: number, afterX: number) {
  return {
    before: { id: 'table-1', x: beforeX },
    after: { id: 'table-1', x: afterX },
  };
}

describe('useUndoHistory', () => {
  it('retourne le snapshot précédent puis le snapshot suivant', () => {
    const { result } = renderHook(() => useUndoHistory<Snapshot>());

    act(() => result.current.record(action(10, 40)));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);

    let undone: Snapshot | null = null;
    act(() => {
      undone = result.current.undo();
    });
    expect(undone).toEqual({ id: 'table-1', x: 10 });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);

    let redone: Snapshot | null = null;
    act(() => {
      redone = result.current.redo();
    });
    expect(redone).toEqual({ id: 'table-1', x: 40 });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(false);
  });

  it('invalide redo après une nouvelle action', () => {
    const { result } = renderHook(() => useUndoHistory<Snapshot>());

    act(() => result.current.record(action(10, 40)));
    act(() => result.current.undo());
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.record(action(10, 70)));
    expect(result.current.canRedo).toBe(false);
    expect(result.current.redo()).toBeNull();
  });

  it('conserve les 50 dernières actions', () => {
    const { result } = renderHook(() => useUndoHistory<Snapshot>());

    act(() => {
      for (let index = 0; index < 51; index += 1) {
        result.current.record(action(index, index + 1));
      }
    });

    let oldest: Snapshot | null = null;
    act(() => {
      for (let index = 0; index < 50; index += 1) {
        oldest = result.current.undo();
      }
    });

    expect(oldest).toEqual({ id: 'table-1', x: 1 });
    expect(result.current.undo()).toBeNull();
  });

  it('retire une action dont l\u2019enregistrement a échoué, sans toucher aux autres', () => {
    const { result } = renderHook(() => useUndoHistory<Snapshot>());
    const kept = action(0, 10);
    const failed = action(10, 40);

    act(() => result.current.record(kept));
    act(() => result.current.record(failed));
    act(() => result.current.discard(failed));

    let undone: Snapshot | null = null;
    act(() => {
      undone = result.current.undo();
    });
    expect(undone).toEqual({ id: 'table-1', x: 0 });
    expect(result.current.canUndo).toBe(false);
  });
});
