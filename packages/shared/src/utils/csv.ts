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
