import { ApiError } from '@/lib/api-error';

export type PlanWriteStatus = 'saving' | 'saved' | 'error' | 'invalid' | null;

// shortcut: ordre limité à ce navigateur ; ajouter une version serveur si les éditeurs simultanés doivent être arbitrés.
type WriteTask = {
  run: () => Promise<unknown>;
  retry: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  failed: boolean;
  settled: boolean;
};

type WriteQueue = {
  tasks: WriteTask[];
  running: boolean;
};

export class PlanWriteQueue {
  private readonly queues = new Map<string, WriteQueue>();
  private readonly invalidKeys = new Set<string>();
  private pending = 0;
  private failed = 0;
  private hasWritten = false;

  constructor(private readonly onStatus: (status: PlanWriteStatus) => void) {}

  enqueue<T>(key: string, run: () => Promise<T>, retry: () => Promise<T> = run): Promise<T> {
    this.pending += 1;
    this.hasWritten = true;
    this.publish();

    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(key) ?? { tasks: [], running: false };
      queue.tasks.push({
        run,
        retry,
        resolve: (value) => resolve(value as T),
        reject,
        failed: false,
        settled: false,
      });
      this.queues.set(key, queue);
      void this.process(key);
    });
  }

  async retryFailed(): Promise<boolean> {
    const keys = [...this.queues.entries()]
      .filter(([, queue]) => queue.tasks[0]?.failed)
      .map(([key]) => key);
    await Promise.all(keys.map((key) => this.process(key, true)));
    return this.failed === 0;
  }

  private async process(key: string, retryFailed = false): Promise<void> {
    const queue = this.queues.get(key);
    const task = queue?.tasks[0];
    if (!queue || !task || queue.running || (task.failed && !retryFailed)) return;

    queue.running = true;
    try {
      const result = await (task.failed ? task.retry() : task.run());
      queue.tasks.shift();
      this.invalidKeys.delete(key);
      queue.running = false;
      this.pending -= 1;
      if (task.failed) this.failed -= 1;
      if (!task.settled) {
        task.settled = true;
        task.resolve(result);
      }
      if (queue.tasks.length === 0) this.queues.delete(key);
      this.publish();
      await this.process(key);
    } catch (error) {
      queue.running = false;
      const invalid = error instanceof ApiError && error.kind === 'invalid';
      if (invalid) {
        queue.tasks.shift();
        this.invalidKeys.add(key);
        this.pending -= 1;
        if (task.failed) this.failed -= 1;
        if (queue.tasks.length === 0) this.queues.delete(key);
      } else if (!task.failed) {
        task.failed = true;
        this.failed += 1;
      }
      if (!task.settled) {
        task.settled = true;
        task.reject(error);
      }
      this.publish();
      if (invalid) await this.process(key);
    }
  }

  private publish() {
    this.onStatus(
      this.failed > 0
        ? 'error'
        : this.pending > 0
          ? 'saving'
          : this.invalidKeys.size > 0
            ? 'invalid'
            : this.hasWritten
              ? 'saved'
              : null,
    );
  }
}
