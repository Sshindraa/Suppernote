import { decodeCsvBytes } from '@suppernote/shared';

/** What the owner may drop: CSV as is, Excel converted in the browser. */
export const IMPORT_FILE_ACCEPT =
  '.csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Text of the file in the CSV format the API reads. An .xlsx is converted here, first sheet only,
 * with the parser loaded on demand so the rest of the dashboard does not pay for it.
 */
export async function readImportFile(file: File): Promise<string> {
  if (/\.xlsx$/i.test(file.name)) {
    const { readSheet } = await import('read-excel-file/browser');
    const rows = await readSheet(file);
    return rowsToCsv(rows);
  }
  return decodeCsvBytes(await file.arrayBuffer());
}

/**
 * Cells joined with `;` (the French Excel separator), quoted when they hold a separator, a quote or
 * a line break. Dates become « JJ/MM/AAAA HH:MM », the form the ticket reader expects.
 */
export function rowsToCsv(rows: unknown[][]): string {
  return rows
    .filter((row) => row.some((cell) => cell !== null && cell !== undefined && cell !== ''))
    .map((row) => row.map(cellToText).map(quoteIfNeeded).join(';'))
    .join('\n');
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return '';
  if (cell instanceof Date) {
    const pad = (value: number) => String(value).padStart(2, '0');
    const day = `${pad(cell.getDate())}/${pad(cell.getMonth() + 1)}/${cell.getFullYear()}`;
    const hasTime = cell.getHours() !== 0 || cell.getMinutes() !== 0;
    return hasTime ? `${day} ${pad(cell.getHours())}:${pad(cell.getMinutes())}` : day;
  }
  return String(cell);
}

function quoteIfNeeded(text: string): string {
  return /[;"\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Column choices remembered for the next import, in this browser only. Never personal data. */
const STORAGE_PREFIX = 'suppernote:import-columns:';

export function rememberColumns(key: string, mapping: Record<string, string | null | undefined>) {
  try {
    const kept = Object.fromEntries(
      Object.entries(mapping).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(kept));
  } catch {
    // Private mode or blocked storage: the next import simply detects the columns again.
  }
}

/** Remembered choices whose column still exists in this file. Empty when none or unreadable. */
export function recallColumns(key: string, headers: string[]): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && headers.includes(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}
