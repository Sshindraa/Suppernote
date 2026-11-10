/**
 * CSV reading shared by the customer and ticket imports. Pure TypeScript: runs in the API and in
 * the dashboard. Personal values pass through here, so callers must not log them.
 */
export type CsvRecord = { line: number; cells: string[] };

export function normalizeHeader(value: string): string {
  return value
    .replace(/^﻿/, '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** `;` or `,`, whichever the header line uses more (French Excel exports use `;`). */
function detectDelimiter(text: string): ';' | ',' {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const commas = head.split(',').length - 1;
  const semicolons = head.split(';').length - 1;
  return commas > semicolons ? ',' : ';';
}

/** RFC 4180 reader: quoted cells, `""` escapes, newlines inside quotes, CRLF or LF. */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.replace(/^﻿/, '');
  const delimiter = detectDelimiter(text);
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;

  const endRecord = () => {
    cells.push(cell);
    if (cells.some((value) => value.trim() !== '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || cells.length > 0) endRecord();
  return records;
}

/**
 * Header name for each field, by synonym. `synonyms` compare against `normalizeHeader`. Each header
 * is used for at most one field, and the first matching header wins.
 */
export function detectColumns<F extends string>(
  headers: string[],
  synonyms: Record<F, string[]>,
  fields: readonly F[],
): Partial<Record<F, string>> {
  const mapping: Partial<Record<F, string>> = {};
  const used = new Set<string>();
  for (const field of fields) {
    const header = headers.find(
      (candidate) => !used.has(candidate) && synonyms[field].includes(normalizeHeader(candidate)),
    );
    if (header !== undefined) {
      mapping[field] = header;
      used.add(header);
    }
  }
  return mapping;
}

/**
 * French Excel saves CSV as Windows-1252 unless told otherwise: try UTF-8 strictly (a stray byte
 * such as « é » in Windows-1252 makes it throw), then fall back to Windows-1252.
 */
export function decodeCsvBytes(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

/** Tells whether one cell value looks like a given kind of data. */
export type ContentTester = (value: string) => boolean;

/** French or international phone number: 9 to 15 digits, spaces, dots, dashes and brackets allowed. */
export const looksLikePhone: ContentTester = (value) => {
  const text = value.trim();
  if (!/^\+?[\d\s.()-]+$/.test(text)) return false;
  const digits = text.replace(/\D/g, '').length;
  return digits >= 9 && digits <= 15;
};

export const looksLikeEmail: ContentTester = (value) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());

/** `JJ/MM/AAAA`, `JJ/MM` or `AAAA-MM-JJ`, with an optional time. */
export const looksLikeDate: ContentTester = (value) => {
  const text = value.trim();
  return (
    /^\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(text) ||
    /^\d{4}-\d{1,2}-\d{1,2}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(text)
  );
};

/** `12`, `12,50`, `12.50`, optionally with the euro sign. Ticket amounts only. */
export const looksLikeAmount: ContentTester = (value) =>
  /^-?\d{1,6}(?:[.,]\d{1,2})?\s*€?$/.test(value.trim());

/**
 * Row of the header, by synonym: the first of the first ten records that names at least one known
 * column (ties go to the earliest). -1 when none does: the file has no header row.
 */
export function locateHeader(
  records: CsvRecord[],
  isKnown: (normalizedName: string) => boolean,
): number {
  let best = -1;
  let bestHits = 0;
  records.slice(0, 10).forEach((record, index) => {
    const hits = record.cells.filter((cell) => isKnown(normalizeHeader(cell))).length;
    if (hits > bestHits) {
      best = index;
      bestHits = hits;
    }
  });
  return best;
}

/** Share of non-empty values that pass a test, needed before a column is taken by content. */
const CONTENT_THRESHOLD = 0.8;

/**
 * Columns found from their values, for the fields still unmapped. A field takes a column only when
 * exactly one unused column passes its test on most of its values: an ambiguous file is left for
 * the owner to choose on screen, never guessed.
 */
export function detectColumnsByContent<F extends string>(
  headers: string[],
  rows: string[][],
  testers: Partial<Record<F, ContentTester>>,
  fields: readonly F[],
  taken: Partial<Record<F, string>>,
  rejects: Partial<Record<F, RegExp>> = {},
): Partial<Record<F, string>> {
  const found: Partial<Record<F, string>> = {};
  const used = new Set<number>(
    headers.flatMap((header, index) =>
      Object.values<string | undefined>(taken).includes(header) ? [index] : [],
    ),
  );
  for (const field of fields) {
    const test = testers[field];
    if (!test || taken[field] !== undefined || found[field] !== undefined) continue;
    const reject = rejects[field];
    const candidates = headers.flatMap((header, index) => {
      if (used.has(index)) return [];
      // A column whose name says it holds something else (an amount, say) is never this field.
      if (reject?.test(normalizeHeader(header))) return [];
      const values = rows.map((row) => (row[index] ?? '').trim()).filter((value) => value !== '');
      if (values.length === 0) return [];
      const passing = values.filter(test).length;
      return passing / values.length >= CONTENT_THRESHOLD ? [index] : [];
    });
    if (candidates.length !== 1) continue;
    const index = candidates[0]!;
    used.add(index);
    found[field] = headers[index]!;
  }
  return found;
}
