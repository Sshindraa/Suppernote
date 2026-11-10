/**
 * Table reading shared by the customer and ticket imports, and the cutting of big files into
 * pieces the server accepts. Pure TypeScript: runs in the API and in the dashboard.
 */
import {
  detectColumns,
  detectColumnsByContent,
  locateHeader,
  parseCsv,
  type ContentTester,
  type CsvRecord,
} from './csv';

export type TableReading<F extends string> = {
  headers: string[];
  /** Line of the header row in the file (plus `lineOffset`), or null when the file has none. */
  headerLine: number | null;
  /** Body rows, with their line numbers (plus `lineOffset`). */
  rows: CsvRecord[];
  mapping: Partial<Record<F, string>>;
  /** Fields found from the values, not from a header name: the owner should check them. */
  byContent: F[];
  /** Required fields with no column. */
  missing: F[];
};

export type TableOptions<F extends string> = {
  synonyms: Record<F, string[]>;
  fields: readonly F[];
  required: readonly F[];
  testers?: Partial<Record<F, ContentTester>>;
  /** Column names (normalised) that can never hold this field, whatever their values. */
  rejects?: Partial<Record<F, RegExp>>;
  /** Column chosen by the owner (or remembered): nothing is detected when this is given. */
  requested?: Partial<Record<F, string | null>>;
  /** `false`: the file has no header row. Unset: found by its names, or treated as absent. */
  hasHeader?: boolean;
  /** Added to every line number: the piece starts at this line of the original file. */
  lineOffset?: number;
};

/** How many values per column are looked at when reading by content. */
const SAMPLE_ROWS = 200;

/**
 * Reads a table: finds the header row (skipping title lines), maps columns by name, then by
 * content for the required fields and the ones the content tests cover. Throws a readable Error
 * when a requested column is absent from the file.
 */
export function readTable<F extends string>(
  input: string,
  options: TableOptions<F>,
): TableReading<F> {
  const offset = options.lineOffset ?? 0;
  const records = parseCsv(input);
  const knownNames = new Set(Object.values<string[]>(options.synonyms).flat());

  let index = -1;
  if (options.hasHeader !== false) {
    index = locateHeader(records, (name) => knownNames.has(name));
    // No known name: the first row is a header unless one of its cells looks like data.
    if (index < 0 && (options.hasHeader === true || !firstRowHasData(records, options.testers))) {
      index = records.length > 0 ? 0 : -1;
    }
  }

  const headerRecord = index >= 0 ? records[index] : null;
  const headers = headerRecord
    ? headerRecord.cells.map((cell) => cell.trim())
    : syntheticHeaders(records.slice(0, 10));
  const rows = headerRecord ? records.slice(index + 1) : records;

  const mapping: Partial<Record<F, string>> = {};
  const byContent: F[] = [];
  if (options.requested) {
    for (const field of options.fields) {
      const column = options.requested[field];
      if (!column) continue;
      if (!headers.includes(column)) {
        throw new Error(`Colonne introuvable dans le fichier : ${column}`);
      }
      mapping[field] = column;
    }
  } else {
    Object.assign(mapping, detectColumns(headers, options.synonyms, options.fields));
    const sample = rows.slice(0, SAMPLE_ROWS).map((row) => row.cells);
    const found = detectColumnsByContent(
      headers,
      sample,
      options.testers ?? {},
      options.fields,
      mapping,
      options.rejects ?? {},
    );
    for (const field of options.fields) {
      if (found[field] !== undefined) {
        mapping[field] = found[field];
        byContent.push(field);
      }
    }
  }

  const missing = options.required.filter((field) => !mapping[field]);
  const shiftedRows = rows.map((row) => ({ ...row, line: row.line + offset }));
  return {
    headers,
    headerLine: headerRecord ? headerRecord.line + offset : null,
    rows: shiftedRows,
    mapping,
    byContent: options.requested ? [] : byContent,
    missing,
  };
}

/** True when the first row holds a value that looks like a phone, an e-mail, a date or an amount. */
function firstRowHasData<F extends string>(
  records: CsvRecord[],
  testers: Partial<Record<F, ContentTester>> | undefined,
): boolean {
  const first = records[0];
  if (!first || !testers) return false;
  const tests = Object.values<ContentTester | undefined>(testers).filter(
    (test): test is ContentTester => test !== undefined,
  );
  return first.cells.some((cell) => {
    const value = cell.trim();
    return value !== '' && tests.some((test) => test(value));
  });
}

/** `Colonne 1`, `Colonne 2`… for a file without header row: the widest of the first records. */
function syntheticHeaders(records: CsvRecord[]): string[] {
  const width = Math.max(0, ...records.map((record) => record.cells.length));
  return Array.from({ length: width }, (_, i) => `Colonne ${i + 1}`);
}

/** Physical lines of a raw fragment: a quoted newline counts, as in `parseCsv`. */
function newlines(raw: string): number {
  return raw.split('\n').length - 1;
}

type RawRecord = { start: number; end: number; line: number; filled: boolean };

/** Record boundaries of a CSV text, with the character range and physical line of each record. */
function scanRecords(text: string): RawRecord[] {
  const records: RawRecord[] = [];
  let inQuotes = false;
  let line = 1;
  let start = 0;
  let startLine = 1;
  const push = (end: number) => {
    const filled = text.slice(start, end).trim() !== '';
    records.push({ start, end, line: startLine, filled });
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') i++;
      else if (ch === '"') inQuotes = false;
      else if (ch === '\n') line++;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === '\n' || ch === '\r') {
      push(i);
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      start = i + 1;
      startLine = line;
    }
  }
  if (start < text.length) push(text.length);
  return records;
}

/** A piece of a file, ready to send: its CSV text, how many rows it holds, and its line offset. */
export type CsvPiece = { csv: string; rows: number; lineOffset: number };

/**
 * Cuts a file into pieces under `maxChars` and `maxRows`. Each piece starts with the header row
 * (when there is one), so the server reads every piece the same way. `lineOffset` maps the piece's
 * line numbers back to the original file, so the report keeps the owner's line numbers.
 */
export function splitCsvText(
  text: string,
  options: { headerLine: number | null; maxChars: number; maxRows: number },
): CsvPiece[] {
  const records = scanRecords(text);
  const headerIndex =
    options.headerLine === null
      ? -1
      : records.findIndex((record) => record.line === options.headerLine);
  const header = headerIndex >= 0 ? records[headerIndex] : null;
  const headerRaw = header ? text.slice(header.start, header.end) : '';
  const headerSpan = header ? newlines(headerRaw) : 0;
  // Line of the first body row inside a piece that starts with the header.
  const firstBodyLine = header ? 2 + headerSpan : 1;

  const body = records.slice(headerIndex + 1);
  const pieces: CsvPiece[] = [];
  let group: RawRecord[] = [];
  let rows = 0;

  const flush = () => {
    const first = group[0];
    const last = group[group.length - 1];
    if (first && last && rows > 0) {
      const slice = text.slice(first.start, last.end);
      const csv = header ? `${headerRaw}\n${slice}` : slice;
      pieces.push({ csv, rows, lineOffset: first.line - firstBodyLine });
    }
    group = [];
    rows = 0;
  };

  for (const record of body) {
    const first = group[0];
    const size = first ? record.end - first.start : 0;
    const withHeader = size + (header ? headerRaw.length + 1 : 0);
    if (first && (withHeader > options.maxChars || (record.filled && rows >= options.maxRows))) {
      flush();
    }
    group.push(record);
    if (record.filled) rows += 1;
  }
  flush();
  return pieces;
}
