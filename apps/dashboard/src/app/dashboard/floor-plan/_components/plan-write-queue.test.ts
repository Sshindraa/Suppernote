import { ApiError } from '@/lib/api-error';
import { describe, expect, it, vi } from 'vitest';
import { PlanWriteQueue, type PlanWriteStatus } from './plan-write-queue';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('PlanWriteQueue', () => {
  it('séquence les écritures d’un même objet et laisse les autres avancer', async () => {
    let status: PlanWriteStatus = null;
    const queue = new PlanWriteQueue((next) => {
      status = next;
    });
    const first = deferred<string>();
    const second = deferred<string>();
    const secondStarted = deferred<void>();
    const calls: string[] = [];

    const firstWrite = queue.enqueue('table:T2', () => {
      calls.push('T2 première');
      return first.promise;
    });
    const secondWrite = queue.enqueue('table:T2', () => {
      calls.push('T2 seconde');
      secondStarted.resolve();
      return second.promise;
    });
    const otherWrite = queue.enqueue('table:T3', async () => {
      calls.push('T3');
      return 'ok';
    });

    expect(calls).toEqual(['T2 première', 'T3']);
    expect(status).toBe('saving');
    await otherWrite;
    first.resolve('ok');
    await firstWrite;
    await secondStarted.promise;
    expect(calls).toEqual(['T2 première', 'T3', 'T2 seconde']);

    second.resolve('ok');
    await secondWrite;
    expect(status).toBe('saved');
  });

  it('ne rejoue pas une valeur refusée et accepte sa correction', async () => {
    const publish = vi.fn();
    const queue = new PlanWriteQueue(publish);
    const rejected = vi.fn().mockRejectedValue(new ApiError('Coordonnée invalide', 400, null));

    await expect(queue.enqueue('tables:T2', rejected)).rejects.toThrow('Coordonnée invalide');
    expect(publish).toHaveBeenLastCalledWith('invalid');
    await queue.retryFailed();
    expect(rejected).toHaveBeenCalledOnce();
    await queue.enqueue('tables:T2', async () => 'ok');
    expect(publish).toHaveBeenLastCalledWith('saved');
  });

  it('garde une écriture en échec en tête jusqu’à sa reprise', async () => {
    let status: PlanWriteStatus = null;
    const queue = new PlanWriteQueue((next) => {
      status = next;
    });
    const firstWrite = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('ok');
    const laterWrite = vi.fn().mockResolvedValue('ok');

    const failed = queue.enqueue('table:T2', firstWrite);
    await expect(failed).rejects.toThrow('offline');
    const later = queue.enqueue('table:T2', laterWrite);

    expect(status).toBe('error');
    expect(laterWrite).not.toHaveBeenCalled();
    await queue.retryFailed();
    await later;

    expect(firstWrite).toHaveBeenCalledTimes(2);
    expect(laterWrite).toHaveBeenCalledOnce();
    expect(status).toBe('saved');
  });
});
