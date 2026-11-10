import { detectColumns, parseCsv } from '@suppernote/shared';
import type { PosCheckInput } from './pos-connector';
import { normalizePosCheckInput, PosCheckInputError } from './pos-sync.service';

/** Ticket fields the file reader understands; the owner can remap any of them on screen. */
export const POS_CHECK_FIELDS = [
  'externalId',
  'openedAt',
  'closedAt',
  'table',
  'subtotal',
  'tax',
  'tip',
  'discount',
  'total',
  'partySize',
  'reservationId',
] as const;
export type PosCheckField = (typeof POS_CHECK_FIELDS)[number];
/** Field → header name in the file. `null` means the field is not read. */
export type PosCheckMapping = Partial<Record<PosCheckField, string | null>>;

/** Fields a file must provide: without them a ticket cannot be identified, dated or totalled. */
const REQUIRED_FIELDS: readonly PosCheckField[] = [
  'externalId',
  'openedAt',
  'subtotal',
  'tax',
  'total',
];

export const POS_CHECK_FIELD_LABELS: Record<PosCheckField, string> = {
  externalId: 'Numéro de ticket',
  openedAt: 'Ouverture',
  closedAt: 'Clôture',
  table: 'Table',
  subtotal: 'Sous-total',
  tax: 'TVA',
  tip: 'Pourboire',
  discount: 'Remise',
  total: 'Total',
  partySize: 'Couverts',
  reservationId: 'Réservation',
};

// Synonyms are compared after `normalizeHeader` (lowercase, no accents, letters and digits only).
const SYNONYMS: Record<PosCheckField, string[]> = {
  externalId: [
    'numeroticket',
    'numerodeticket',
    'ticket',
    'ticketid',
    'idticket',
    'numerofacture',
    'facture',
  ],
  openedAt: [
    'ouverture',
    'dateouverture',
    'heureouverture',
    'ouvert',
    'debut',
    'opened',
    'openedat',
  ],
  closedAt: [
    'cloture',
    'datecloture',
    'heurecloture',
    'fermeture',
    'datefermeture',
    'clos',
    'closed',
  ],
  table: ['table', 'numerotable', 'tableref', 'tablename', 'emplacement'],
  subtotal: ['soustotal', 'montantht', 'totalht', 'ht', 'subtotal'],
  tax: ['tva', 'montanttva', 'totaltva', 'taxe', 'vat', 'tax'],
  tip: ['pourboire', 'pourboires', 'tip', 'tips', 'gratification'],
  discount: ['remise', 'remises', 'reduction', 'discount'],
  total: ['total', 'totalttc', 'montantttc', 'montant', 'ttc', 'totalamount'],
  partySize: ['couverts', 'couvert', 'nbcouverts', 'nombredecouverts', 'convives', 'covers'],
  reservationId: ['reservation', 'idreservation', 'numeroreservation', 'reservationid'],
};

/** Tickets per import request: keeps the whole request under the 30 s proxy timeout. */
export const POS_CSV_ROW_LIMIT = 2_000;

export type PosCsvSkip = { line: number; reason: string };

export interface PosCsvReading {
  headers: string[];
  mapping: PosCheckMapping;
  checks: PosCheckInput[];
  skipped: PosCsvSkip[];
  /** Rows that name a reservation: only these can be linked to one. */
  withReservation: number;
  /** Required fields with no column: a preview still works so the owner can pick one on screen. */
  missing: PosCheckField[];
}

const PARIS = 'Europe/Paris';

/** Offset of Europe/Paris from UTC, in minutes, at that instant. */
function parisOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PARIS,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second'),
  );
  return (asUtc - at.getTime()) / 60_000;
}

/**
 * `JJ/MM/AAAA HH:MM[:SS]` (or ISO) read as Paris local time. Date-only values are refused: a ticket
 * without its time cannot be matched to a service.
 */
export function parseParisDateTime(value: string): Date | null {
  const french = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  const match = french ?? iso;
  if (!match) return null;
  const [day, month, year] = french
    ? [Number(match[1]), Number(match[2]), Number(match[3])]
    : [Number(match[3]), Number(match[2]), Number(match[1])];
  const [hour, minute, second] = [Number(match[4]), Number(match[5]), Number(match[6] ?? 0)];
  if (hour > 23 || minute > 59 || second > 59) return null;
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const probe = new Date(naive);
  if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month - 1) return null;
  // Two passes so the offset is right on either side of a DST change.
  const first = naive - parisOffsetMinutes(probe) * 60_000;
  return new Date(naive - parisOffsetMinutes(new Date(first)) * 60_000);
}

/** `12,50` and `12.50` are both accepted; spaces and the euro sign are ignored. Null when invalid. */
export function parseFrenchAmount(value: string): string | null {
  const compact = value.replace(/[\s  €]/g, '').replace(',', '.');
  return /^\d+(\.\d{1,2})?$/.test(compact) ? compact : null;
}

/**
 * Reads a ticket export into provider-neutral checks. Each row is checked with the same rules as the
 * JSON import; a bad row is skipped with its line number and reason, never the whole file. Throws a
 * readable Error only when a mapped column is absent from the file. Ticket values stay in memory.
 */
export function readPosCheckCsv(input: string, requested?: PosCheckMapping): PosCsvReading {
  const records = parseCsv(input);
  const [header, ...body] = records;
  const headers = header ? header.cells.map((cell) => cell.trim()) : [];
  const mapping: PosCheckMapping = requested ?? detectColumns(headers, SYNONYMS, POS_CHECK_FIELDS);
  for (const field of POS_CHECK_FIELDS) {
    const column = mapping[field];
    if (column && !headers.includes(column)) {
      throw new Error(`Colonne introuvable dans le fichier : ${column}`);
    }
  }
  const missing = REQUIRED_FIELDS.filter((field) => !mapping[field]);

  const checks: PosCheckInput[] = [];
  const skipped: PosCsvSkip[] = [];
  const seen = new Set<string>();
  for (const { line, cells } of body) {
    const result = readRow(cells, headers, mapping);
    if (typeof result === 'string') {
      skipped.push({ line, reason: result });
      continue;
    }
    if (seen.has(result.externalId)) {
      skipped.push({ line, reason: 'ticket déjà présent dans le fichier' });
      continue;
    }
    seen.add(result.externalId);
    checks.push(result);
  }

  return {
    headers,
    mapping,
    checks,
    skipped,
    withReservation: checks.filter((check) => check.reservationId).length,
    missing,
  };
}

/** A checked ticket, or the reason the row is skipped. */
function readRow(
  cells: string[],
  headers: string[],
  mapping: PosCheckMapping,
): PosCheckInput | string {
  const text = (field: PosCheckField): string => {
    const column = mapping[field];
    if (!column) return '';
    return (cells[headers.indexOf(column)] ?? '').trim();
  };

  const externalId = text('externalId');
  if (!externalId) return 'numéro de ticket manquant';
  const openedAt = parseParisDateTime(text('openedAt'));
  if (!openedAt) return 'date d’ouverture invalide (attendu JJ/MM/AAAA HH:MM)';
  const closedRaw = text('closedAt');
  const closedAt = closedRaw ? parseParisDateTime(closedRaw) : null;
  if (closedRaw && !closedAt) return 'date de clôture invalide (attendu JJ/MM/AAAA HH:MM)';

  const amount = (field: 'subtotal' | 'tax' | 'tip' | 'discount' | 'total'): string | null => {
    const raw = text(field);
    if (!raw) return null;
    return parseFrenchAmount(raw) ?? 'montant_invalide';
  };
  const amounts = {
    subtotal: amount('subtotal'),
    tax: amount('tax'),
    tip: amount('tip'),
    discount: amount('discount'),
    total: amount('total'),
  };
  for (const field of ['subtotal', 'tax', 'total'] as const) {
    if (amounts[field] === null) return `montant manquant : ${POS_CHECK_FIELD_LABELS[field]}`;
    if (amounts[field] === 'montant_invalide') {
      return `montant invalide : ${POS_CHECK_FIELD_LABELS[field]}`;
    }
  }
  for (const field of ['tip', 'discount'] as const) {
    if (amounts[field] === 'montant_invalide') {
      return `montant invalide : ${POS_CHECK_FIELD_LABELS[field]}`;
    }
  }

  const partyRaw = text('partySize');
  const partySize = /^\d{1,3}$/.test(partyRaw) ? Number(partyRaw) : null;
  const check: PosCheckInput = {
    externalId,
    openedAt,
    closedAt,
    tableReference: text('table') || null,
    subtotal: amounts.subtotal as string,
    tax: amounts.tax as string,
    tip: amounts.tip,
    discount: amounts.discount,
    total: amounts.total as string,
    reservationId: text('reservationId') || null,
    matchingHints: partySize ? { partySize } : null,
  };
  try {
    normalizePosCheckInput(check);
  } catch (error) {
    if (error instanceof PosCheckInputError) return error.message;
    throw error;
  }
  return check;
}
