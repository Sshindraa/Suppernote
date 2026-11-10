import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import { looksLikeEmail, looksLikePhone, readTable } from '@suppernote/shared';
import { readWithAiColumns, type ColumnAiReading, type ColumnAiSpec } from '../column-ai';

vi.mock('../../companion/companion.service', () => {
  class CompanionUpstreamError extends Error {}
  return { CompanionUpstreamError, completeWithoutTools: vi.fn() };
});

type Field = 'phone' | 'email' | 'name';
const spec: ColumnAiSpec<Field> = {
  fields: ['phone', 'email', 'name'],
  labels: { phone: 'Téléphone', email: 'E-mail', name: 'Nom' },
  required: ['phone'],
  tests: { phone: looksLikePhone, email: looksLikeEmail },
};

const CSV = 'Nom;Mobile;Tel2\nAlice;0612345678;0699999999\nBob;0698765432;0677777777';
const headers = ['Nom', 'Mobile', 'Tel2'];

function reading(overrides: Partial<ColumnAiReading<Field>> = {}): ColumnAiReading<Field> {
  return { headers, headerLine: 1, mapping: {}, byContent: [], ...overrides };
}

/** Re-read as the readers do: a mapping in, the same reading shape out. */
function reread(mapping: Partial<Record<Field, string>>) {
  return { ...reading({ mapping }), missing: [] as Field[] };
}

function modelAnswers(answer: unknown) {
  return vi.fn(
    async () => ({ text: typeof answer === 'string' ? answer : JSON.stringify(answer) }) as never,
  );
}

const log = { info: vi.fn() } as unknown as FastifyBaseLogger;

async function run(input: {
  reading?: ColumnAiReading<Field>;
  complete: ReturnType<typeof modelAnswers> | ReturnType<typeof vi.fn>;
  csv?: string;
}) {
  const rereadSpy = vi.fn(reread);
  const result = await readWithAiColumns({
    csv: input.csv ?? CSV,
    reading: input.reading ?? reading(),
    lineOffset: 0,
    spec,
    reread: rereadSpy,
    log,
    complete: input.complete as never,
  });
  return { result, rereadSpy };
}

describe('readWithAiColumns', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not call the model when the detection is enough', async () => {
    const complete = modelAnswers({});
    const { result } = await run({
      reading: reading({ mapping: { phone: 'Mobile' } }),
      complete,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
  });

  it('sends only headers and value shapes, and applies a coherent pick', async () => {
    const complete = modelAnswers({ phone: { column: 'Mobile', confidence: 'high' } });
    const { result, rereadSpy } = await run({ complete });

    expect(complete).toHaveBeenCalledTimes(1);
    const sent = (complete.mock.calls[0] as unknown as [{ user: string }])[0].user;
    for (const value of ['0612345678', '0698765432', 'Alice', 'Bob', '0699999999']) {
      expect(sent).not.toContain(value);
    }
    expect(sent).toContain('"shapes":["9999999999"]');
    expect(rereadSpy).toHaveBeenCalledWith({ phone: 'Mobile' });
    expect(result.fromAi).toEqual(['phone']);
  });

  it('rejects a column the file does not have', async () => {
    const complete = modelAnswers({ phone: { column: 'Inconnue', confidence: 'high' } });
    const { result, rereadSpy } = await run({ complete });
    expect(rereadSpy).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
  });

  it('refuses a pick whose values do not look like the field', async () => {
    const complete = modelAnswers({ phone: { column: 'Nom', confidence: 'high' } });
    const { result, rereadSpy } = await run({ complete });
    expect(rereadSpy).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
  });

  it('never replaces a column recognised by its header, even with a coherent pick', async () => {
    const complete = modelAnswers({ phone: { column: 'Tel2', confidence: 'high' } });
    const { rereadSpy, result } = await run({
      reading: reading({ mapping: { phone: 'Mobile' }, byContent: [] }),
      complete: modelAnswers({ email: { column: 'Mobile', confidence: 'high' } }),
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
    expect(rereadSpy).not.toHaveBeenCalled();
  });

  it('replaces a column found only by its content, when the pick is coherent', async () => {
    const { result, rereadSpy } = await run({
      reading: reading({ mapping: { phone: 'Nom' }, byContent: ['phone'] }),
      complete: modelAnswers({ phone: { column: 'Tel2', confidence: 'medium' } }),
    });
    expect(rereadSpy).toHaveBeenCalledWith({ phone: 'Tel2' });
    expect(result.fromAi).toEqual(['phone']);
  });

  it('keeps the detection when the model times out or fails', async () => {
    const { CompanionUpstreamError } = await import('../../companion/companion.service');
    const complete = vi.fn(async () => {
      throw new CompanionUpstreamError('timeout');
    });
    const { result, rereadSpy } = await run({ complete });
    expect(result.fromAi).toEqual([]);
    expect(rereadSpy).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenLastCalledWith(
      { columns: 3, outcome: 'unavailable', reason: 'timeout' },
      'column_ai',
    );
  });

  it('keeps the detection on an answer that is not JSON or not the expected shape', async () => {
    const notJson = await run({ complete: modelAnswers('pas du json') });
    expect(notJson.result.fromAi).toEqual([]);

    const badShape = await run({
      complete: modelAnswers({ phone: { column: 'Mobile', confidence: 'sûr' } }),
    });
    expect(badShape.result.fromAi).toEqual([]);
    expect(badShape.rereadSpy).not.toHaveBeenCalled();
  });

  it('does not call the model for a file wider than the limit', async () => {
    const wide = Array.from({ length: 61 }, (_, i) => `Col${i}`);
    const complete = modelAnswers({});
    await run({ reading: reading({ headers: wide }), complete, csv: wide.join(';') });
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not call the model when a header holds an e-mail', async () => {
    const complete = modelAnswers({});
    const headersWithEmail = ['Nom', 'contact@example.test', 'Tel2'];
    const { result } = await run({
      reading: reading({ headers: headersWithEmail }),
      csv: 'Nom;contact@example.test;Tel2\nAlice;0612345678;0699999999',
      complete,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
    expect(log.info).toHaveBeenLastCalledWith(
      { columns: 3, outcome: 'skipped', reason: 'value_in_header' },
      'column_ai',
    );
  });

  it('does not call the model when a header holds a phone number', async () => {
    const complete = modelAnswers({});
    const { result } = await run({
      reading: reading({ headers: ['Nom', '0612345678', 'Tel2'] }),
      csv: 'Nom;0612345678;Tel2\nAlice;0612345678;0699999999',
      complete,
    });
    expect(complete).not.toHaveBeenCalled();
    expect(result.fromAi).toEqual([]);
  });

  it('still calls the model for ordinary headers with a digit', async () => {
    const complete = modelAnswers({});
    await run({
      reading: reading({ headers: ['Nom', 'Mobile', 'Tel 2'] }),
      csv: 'Nom;Mobile;Tel 2\nAlice;0612345678;0699999999',
      complete,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps headers with five digits or fewer as allowed', async () => {
    const complete = modelAnswers({});
    await run({
      reading: reading({ headers: ['Nom', 'Ref 12345', 'Tel2'] }),
      csv: 'Nom;Ref 12345;Tel2\nAlice;0612345678;0699999999',
      complete,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('logs counts and outcome only, never a value or a header', async () => {
    await run({ complete: modelAnswers({ phone: { column: 'Mobile', confidence: 'high' } }) });
    const logged = JSON.stringify(
      (log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    );
    for (const value of ['0612345678', 'Alice', 'Mobile', 'Tel2']) {
      expect(logged).not.toContain(value);
    }
    expect(logged).toContain('applied');
  });
});

describe('readTable is the detection the model completes', () => {
  it('reports a missing required phone column so the model is asked', () => {
    const table = readTable('Nom;Ref\nAlice;A1', {
      synonyms: { phone: ['telephone'], email: ['email'], name: ['nom'] },
      fields: ['phone', 'email', 'name'],
      required: ['phone'],
      testers: { phone: looksLikePhone },
    });
    expect(table.missing).toEqual(['phone']);
  });
});
