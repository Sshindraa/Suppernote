import { beforeEach, describe, expect, it, vi } from 'vitest';

const add = vi.fn();
vi.mock('../queues', () => ({
  queues: { reconciliation: { add: (...args: unknown[]) => add(...args) } },
}));
vi.mock('../../logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../logger/pino';
import { requestGreetingWarm } from '../greeting-warm';

describe('requestGreetingWarm', () => {
  beforeEach(() => vi.clearAllMocks());

  it('ajoute la tâche avec une déduplication de 60 s', () => {
    add.mockResolvedValue(undefined);
    requestGreetingWarm();
    expect(add).toHaveBeenCalledWith(
      'greeting-warm',
      { kind: 'greeting-warm' },
      { deduplication: { id: 'greeting-warm-request', ttl: 60_000 } },
    );
  });

  it('ne lève jamais quand la file est indisponible', async () => {
    add.mockRejectedValue(new Error('redis down'));
    expect(() => requestGreetingWarm()).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalled();
  });
});
