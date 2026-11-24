import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deadLetterAdd: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  captureException: vi.fn(),
  registerWorker: vi.fn(),
}));

vi.mock('../../queues', () => ({ queues: { deadLetter: { add: mocks.deadLetterAdd } } }));
vi.mock('../registry', () => ({ registerWorker: mocks.registerWorker }));
vi.mock('../../../sentry/client', () => ({ captureException: mocks.captureException }));
vi.mock('../../../logger/pino', () => {
  const log = { warn: mocks.warn, error: mocks.error, info: mocks.info };
  return { logger: { ...log, child: () => log } };
});

import { isRepeatJob, moveFailedJobToDeadLetter, setupWorkerListeners } from '../helper';
import { renderMetrics, repeatJobExhaustedTotal } from '../../../observability/metrics';

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: '42',
    name: 'refresh-subscription',
    queueName: 'elevenlabs-subscription',
    data: { restaurantId: 'r1' },
    attemptsMade: 3,
    opts: { attempts: 3 },
    ...overrides,
  } as never;
}

const worker = { name: 'elevenlabs-subscription', on: vi.fn() } as never;
const timeout = new Error('ElevenLabs timeout');

describe('isRepeatJob', () => {
  it('reconnaît un job de job scheduler (id préfixé repeat:)', () => {
    expect(
      isRepeatJob({ id: 'repeat:elevenlabs-subscription-hourly:1795000000000', opts: {} }),
    ).toBe(true);
  });

  it('reconnaît opts.repeat', () => {
    expect(isRepeatJob({ id: '7', opts: { repeat: { pattern: '0 * * * *' } } })).toBe(true);
  });

  it('un job ordinaire ou sans id n’est pas répétitif', () => {
    expect(isRepeatJob({ id: '7', opts: { attempts: 3 } })).toBe(false);
    expect(isRepeatJob({ id: undefined, opts: {} })).toBe(false);
  });
});

describe('moveFailedJobToDeadLetter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repeatJobExhaustedTotal.reset();
    mocks.deadLetterAdd.mockResolvedValue(undefined);
  });

  it('job répétitif aux tentatives épuisées : pas de dead-letter, log warn et métrique', async () => {
    const job = makeJob({ id: 'repeat:elevenlabs-subscription-hourly:1795000000000' });

    await moveFailedJobToDeadLetter(worker, job, timeout);

    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(mocks.warn.mock.calls[0]?.[1]).toContain('not moved to dead-letter');
    const metrics = await renderMetrics();
    expect(metrics).toContain(
      'suppernote_repeat_job_exhausted_total{queue="elevenlabs-subscription",job_name="refresh-subscription"} 1',
    );
  });

  it('job avec opts.repeat (répétable historique) : pas de dead-letter', async () => {
    const job = makeJob({ opts: { attempts: 3, repeat: { pattern: '0 * * * *' } } });

    await moveFailedJobToDeadLetter(worker, job, timeout);

    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
  });

  it('job non répétitif aux tentatives épuisées : déplacé en dead-letter comme avant', async () => {
    await moveFailedJobToDeadLetter(worker, makeJob(), timeout);

    expect(mocks.deadLetterAdd).toHaveBeenCalledTimes(1);
    const [name, payload, opts] = mocks.deadLetterAdd.mock.calls[0] ?? [];
    expect(name).toBe('elevenlabs-subscription:refresh-subscription');
    expect(payload).toMatchObject({
      originalQueue: 'elevenlabs-subscription',
      originalJobId: '42',
      attemptsMade: 3,
    });
    expect(opts).toMatchObject({ jobId: 'dead_elevenlabs-subscription_42_3', removeOnFail: false });
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('tentatives restantes : ni dead-letter ni métrique, même pour un job répétitif', async () => {
    const job = makeJob({
      id: 'repeat:elevenlabs-subscription-hourly:1795000000000',
      attemptsMade: 1,
    });

    await moveFailedJobToDeadLetter(worker, job, timeout);

    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
    expect(await renderMetrics()).not.toContain(
      'suppernote_repeat_job_exhausted_total{queue="elevenlabs-subscription"',
    );
  });
});

describe('setupWorkerListeners — événement failed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deadLetterAdd.mockResolvedValue(undefined);
  });

  async function emitFailed(job: unknown) {
    const emitter = new EventEmitter();
    Object.assign(emitter, { name: 'elevenlabs-subscription' });
    setupWorkerListeners(emitter as never);
    emitter.emit('failed', job, timeout);
    // moveFailedJobToDeadLetter est lancé sans await dans le listener.
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('l’erreur reste capturée (Sentry) mais un job répétitif épuisé ne va pas en dead-letter', async () => {
    await emitFailed(makeJob({ id: 'repeat:elevenlabs-subscription-hourly:1795000000000' }));

    expect(mocks.captureException).toHaveBeenCalledTimes(1);
    expect(mocks.deadLetterAdd).not.toHaveBeenCalled();
  });

  it('un job ordinaire épuisé va en dead-letter', async () => {
    await emitFailed(makeJob());

    expect(mocks.deadLetterAdd).toHaveBeenCalledTimes(1);
  });
});
