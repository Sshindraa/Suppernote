/**
 * Column recognition by a model, as a fallback of `readTable`. Pure: the model call lives in the API.
 * Only `maskValueShape` output may leave the server; `applyColumnSuggestion` checks the model's pick
 * against the real values here, locally, and never replaces a column recognised by its header.
 */
import { normalizeHeader, parseCsv, type ContentTester } from './csv';

const MAX_SHAPE_LENGTH = 12;
/** Share of sampled values that must pass a field's shape test for the model's pick to stand. */
const SHAPE_THRESHOLD = 0.8;

export type SuggestionConfidence = 'high' | 'medium' | 'low';
export type ColumnSuggestion<F extends string> = Partial<
  Record<F, { column: string | null; confidence: SuggestionConfidence }>
>;

/**
 * Shape of a value: digits become 9, capitals A, other letters a, punctuation and spaces kept, length
 * capped. No digit or letter of the original value survives, only its form.
 */
export function maskValueShape(value: string): string {
  let shape = '';
  let count = 0;
  for (const ch of value.trim()) {
    let out: string;
    if (/\p{N}/u.test(ch)) out = '9';
    else if (/\p{Lu}/u.test(ch)) out = 'A';
    else if (/\p{L}/u.test(ch)) out = 'a';
    else if (/[\p{P}\p{S}\p{Z}]/u.test(ch)) out = ch;
    else continue; // combining marks and control characters carry no form
    if (count === MAX_SHAPE_LENGTH) return `${shape}…`;
    shape += out;
    count++;
  }
  return shape;
}

/**
 * Shape test for a reference such as a ticket number: one short token with at least one digit.
 * Used only by the model's picks, so the header and content detection keeps its own tests.
 */
export const looksLikeReference: ContentTester = (value) =>
  /^[\p{L}\p{N}][\p{L}\p{N}\-_/.#]{0,39}$/u.test(value) && /\p{N}/u.test(value);

/** Distinct shapes of a column's values, in order of appearance. */
export function columnShapes(values: string[], limit = 3): string[] {
  const shapes = new Set<string>();
  for (const value of values) {
    if (shapes.size >= limit) break;
    shapes.add(maskValueShape(value));
  }
  return [...shapes];
}

/**
 * Non-empty values of each column, for the first `maxRows` body rows. `headerLine` is the header's
 * line in `csv` itself (no offset). Stays in memory: callers must not send or log these values.
 */
export function columnValues(
  csv: string,
  headers: string[],
  headerLine: number | null,
  maxRows: number,
): string[][] {
  const records = parseCsv(csv);
  const headerIndex = headerLine === null ? -1 : records.findIndex((r) => r.line === headerLine);
  const body = records.slice(headerIndex + 1, headerIndex + 1 + maxRows);
  return headers.map((_, index) =>
    body.map((record) => (record.cells[index] ?? '').trim()).filter((value) => value !== ''),
  );
}

/**
 * Adds the model's picks that pass every local check, and returns the mapping with them. A pick is
 * refused when: its confidence is low, the field is already recognised by header, the column is
 * unknown or already used, the field has no shape test, the column's values do not look like the
 * field, or the header is rejected for the field.
 */
export function applyColumnSuggestion<F extends string>(input: {
  fields: readonly F[];
  headers: string[];
  /** Non-empty values per header position (see `columnValues`). */
  values: string[][];
  mapping: Partial<Record<F, string>>;
  byContent: readonly F[];
  suggestion: ColumnSuggestion<F>;
  testers: Partial<Record<F, ContentTester>>;
  rejects?: Partial<Record<F, RegExp>>;
}): { mapping: Partial<Record<F, string>>; accepted: F[] } {
  const mapping: Partial<Record<F, string>> = { ...input.mapping };
  const accepted: F[] = [];
  const used = new Set<string>(
    Object.values<string | undefined>(mapping).filter((column): column is string => !!column),
  );

  for (const field of input.fields) {
    const proposal = input.suggestion[field];
    if (!proposal || !proposal.column || proposal.confidence === 'low') continue;
    const current = mapping[field];
    // A column recognised by its header is never replaced; one found by content can be.
    if (current && !input.byContent.includes(field)) continue;
    const column = proposal.column;
    if (column === current || used.has(column)) continue;
    const index = input.headers.indexOf(column);
    if (index < 0) continue;
    const test = input.testers[field];
    if (!test) continue;
    if (input.rejects?.[field]?.test(normalizeHeader(column))) continue;
    const values = input.values[index] ?? [];
    if (values.length === 0) continue;
    const matching = values.filter((value) => test(value)).length;
    if (matching / values.length < SHAPE_THRESHOLD) continue;

    if (current) used.delete(current);
    mapping[field] = column;
    used.add(column);
    accepted.push(field);
  }
  return { mapping, accepted };
}
