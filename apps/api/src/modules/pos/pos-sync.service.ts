import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { db } from '../../shared/db/client';
import {
  assertPosConnectionForImport,
  PosConnectionNotFoundError,
  PosConnectionStateError,
} from './pos-connection.service';
import type {
  NormalizedPosCheckInput,
  PosCheckInput,
  PosCheckView,
  PosMatchingHints,
} from './pos-connector';
import {
  scoreReservationCheckMatch,
  type PosCheckMatchCandidate,
  type ReservationCheckMatchResult,
  type ReservationMatchCandidate,
} from './reservation-check-matcher.service';

const MAX_PAYLOAD_BYTES = 200_000;
const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_REVISION_LENGTH = 128;
const MAX_TABLE_REFERENCE_LENGTH = 128;
const MAX_MONEY = new Prisma.Decimal('10000000000');

export class PosCheckInputError extends Error {
  constructor(
    readonly code:
      | 'POS_CHECK_EXTERNAL_ID_INVALID'
      | 'POS_CHECK_DATE_INVALID'
      | 'POS_CHECK_CLOSED_BEFORE_OPENED'
      | 'POS_CHECK_AMOUNT_INVALID'
      | 'POS_CHECK_CURRENCY_INVALID'
      | 'POS_CHECK_PAYLOAD_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'PosCheckInputError';
  }
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(canonicalize(value));
  return serialized === undefined ? 'null' : serialized;
}

function parseDate(value: Date | string | null | undefined, field: string): Date | null {
  if (value === null || value === undefined) {
    if (field === 'closedAt') return null;
    throw new PosCheckInputError('POS_CHECK_DATE_INVALID', `${field} est obligatoire.`);
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PosCheckInputError('POS_CHECK_DATE_INVALID', `${field} doit être une date valide.`);
  }
  return date;
}

function parseMoney(value: Prisma.Decimal | string | number | null | undefined, field: string) {
  const raw = value === null || value === undefined ? '0' : value;
  let parsed: Prisma.Decimal;
  try {
    parsed = new Prisma.Decimal(raw);
  } catch {
    throw new PosCheckInputError(
      'POS_CHECK_AMOUNT_INVALID',
      `${field} doit être un montant valide.`,
    );
  }
  if (
    !parsed.isFinite() ||
    parsed.isNegative() ||
    parsed.gte(MAX_MONEY) ||
    (parsed.decimalPlaces() ?? 0) > 2
  ) {
    throw new PosCheckInputError(
      'POS_CHECK_AMOUNT_INVALID',
      `${field} doit être positif et comporter au plus deux décimales.`,
    );
  }
  return parsed;
}

function optionalText(
  value: string | null | undefined,
  field: string,
  maxLength: number,
): string | null {
  if (value === null || value === undefined) return null;
  const normalized = value.trim();
  if (normalized.length === 0) return null;
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new PosCheckInputError('POS_CHECK_EXTERNAL_ID_INVALID', `${field} est invalide.`);
  }
  return normalized;
}

function normalizeCurrency(value: string | null | undefined): string {
  const currency = (value ?? 'EUR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PosCheckInputError(
      'POS_CHECK_CURRENCY_INVALID',
      'La devise doit être un code ISO-4217.',
    );
  }
  return currency;
}

function sanitizeHints(hints: PosMatchingHints | null | undefined): PosMatchingHints | null {
  if (!hints) return null;
  return {
    reservationExternalId: optionalText(hints.reservationExternalId, 'reservationExternalId', 256),
    partySize: hints.partySize === null || hints.partySize === undefined ? null : hints.partySize,
    customerPhone: optionalText(hints.customerPhone, 'customerPhone', 64),
    customerToken: optionalText(hints.customerToken, 'customerToken', 256),
    conflict: hints.conflict === true,
  };
}

/** Map provider data to a deterministic, storage-safe ticket projection. */
export function normalizePosCheckInput(input: PosCheckInput): NormalizedPosCheckInput {
  const externalId = input.externalId.trim();
  if (
    externalId.length === 0 ||
    externalId.length > MAX_EXTERNAL_ID_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(externalId)
  ) {
    throw new PosCheckInputError('POS_CHECK_EXTERNAL_ID_INVALID', 'externalId est invalide.');
  }

  const openedAt = parseDate(input.openedAt, 'openedAt')!;
  const closedAt = parseDate(input.closedAt, 'closedAt');
  if (closedAt && closedAt.getTime() < openedAt.getTime()) {
    throw new PosCheckInputError(
      'POS_CHECK_CLOSED_BEFORE_OPENED',
      'closedAt ne peut pas précéder openedAt.',
    );
  }

  const normalized: NormalizedPosCheckInput = {
    externalId,
    externalRevision: optionalText(input.externalRevision, 'externalRevision', MAX_REVISION_LENGTH),
    openedAt,
    closedAt,
    tableReference: optionalText(
      input.tableReference,
      'tableReference',
      MAX_TABLE_REFERENCE_LENGTH,
    ),
    subtotal: parseMoney(input.subtotal, 'subtotal'),
    tax: parseMoney(input.tax, 'tax'),
    tip: parseMoney(input.tip, 'tip'),
    discount: parseMoney(input.discount, 'discount'),
    total: parseMoney(input.total, 'total'),
    refundedAmount: parseMoney(input.refundedAmount, 'refundedAmount'),
    currency: normalizeCurrency(input.currency),
    rawPayloadHash: '',
    reservationId: optionalText(input.reservationId, 'reservationId', 128),
    matchingHints: sanitizeHints(input.matchingHints),
  };

  const payload =
    input.rawPayload === undefined
      ? {
          externalId: normalized.externalId,
          externalRevision: normalized.externalRevision,
          openedAt: normalized.openedAt,
          closedAt: normalized.closedAt,
          tableReference: normalized.tableReference,
          subtotal: normalized.subtotal,
          tax: normalized.tax,
          tip: normalized.tip,
          discount: normalized.discount,
          total: normalized.total,
          refundedAmount: normalized.refundedAmount,
          currency: normalized.currency,
        }
      : input.rawPayload;
  const serializedPayload = stableStringify(payload);
  if (Buffer.byteLength(serializedPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new PosCheckInputError(
      'POS_CHECK_PAYLOAD_TOO_LARGE',
      'Le payload POS dépasse la taille maximale autorisée.',
    );
  }
  normalized.rawPayloadHash = createHash('sha256').update(serializedPayload).digest('hex');
  return normalized;
}

function serializeDecimal(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function serializePosCheck(row: {
  id: string;
  connectionId: string;
  externalId: string;
  externalRevision: string | null;
  openedAt: Date;
  closedAt: Date | null;
  tableReference: string | null;
  subtotal: Prisma.Decimal;
  tax: Prisma.Decimal;
  tip: Prisma.Decimal;
  discount: Prisma.Decimal;
  total: Prisma.Decimal;
  refundedAmount: Prisma.Decimal;
  currency: string;
  rawPayloadHash: string;
  importedAt: Date;
  updatedAt: Date;
}): PosCheckView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    externalId: row.externalId,
    externalRevision: row.externalRevision,
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt?.toISOString() ?? null,
    tableReference: row.tableReference,
    subtotal: serializeDecimal(row.subtotal),
    tax: serializeDecimal(row.tax),
    tip: serializeDecimal(row.tip),
    discount: serializeDecimal(row.discount),
    total: serializeDecimal(row.total),
    refundedAmount: serializeDecimal(row.refundedAmount),
    currency: row.currency,
    rawPayloadHash: row.rawPayloadHash,
    importedAt: row.importedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type PosCheckWriter = Pick<Prisma.TransactionClient, 'posCheck'>;

async function upsertNormalizedPosCheck(
  writer: PosCheckWriter,
  args: { restaurantId: string; connectionId: string; input: NormalizedPosCheckInput },
) {
  const { restaurantId, connectionId, input } = args;
  return writer.posCheck.upsert({
    where: {
      connectionId_externalId: { connectionId, externalId: input.externalId },
    },
    create: {
      restaurantId,
      connectionId,
      externalId: input.externalId,
      externalRevision: input.externalRevision,
      openedAt: input.openedAt,
      closedAt: input.closedAt,
      tableReference: input.tableReference,
      subtotal: input.subtotal,
      tax: input.tax,
      tip: input.tip,
      discount: input.discount,
      total: input.total,
      refundedAmount: input.refundedAmount,
      currency: input.currency,
      rawPayloadHash: input.rawPayloadHash,
    },
    update: {
      externalRevision: input.externalRevision,
      openedAt: input.openedAt,
      closedAt: input.closedAt,
      tableReference: input.tableReference,
      subtotal: input.subtotal,
      tax: input.tax,
      tip: input.tip,
      discount: input.discount,
      total: input.total,
      refundedAmount: input.refundedAmount,
      currency: input.currency,
      rawPayloadHash: input.rawPayloadHash,
    },
  });
}

export interface PosImportResult {
  dryRun: boolean;
  processedCount: number;
  nextCursor: string | null;
  checks: Array<
    PosCheckView | Omit<PosCheckView, 'id' | 'connectionId' | 'importedAt' | 'updatedAt'>
  >;
}

/**
 * Normalize and persist a page atomically. The cursor is advanced only after
 * all upserts commit, which keeps polling retries idempotent.
 */
export async function importPosChecks(args: {
  restaurantId: string;
  connectionId: string;
  checks: PosCheckInput[];
  dryRun?: boolean;
  nextCursor?: string | null;
}): Promise<PosImportResult> {
  const normalized = args.checks.map(normalizePosCheckInput);
  await assertPosConnectionForImport(args.restaurantId, args.connectionId);

  if (args.dryRun !== false) {
    return {
      dryRun: true,
      processedCount: normalized.length,
      nextCursor: args.nextCursor ?? null,
      checks: normalized.map((input) => ({
        externalId: input.externalId,
        externalRevision: input.externalRevision,
        openedAt: input.openedAt.toISOString(),
        closedAt: input.closedAt?.toISOString() ?? null,
        tableReference: input.tableReference,
        subtotal: input.subtotal.toFixed(2),
        tax: input.tax.toFixed(2),
        tip: input.tip.toFixed(2),
        discount: input.discount.toFixed(2),
        total: input.total.toFixed(2),
        refundedAmount: input.refundedAmount.toFixed(2),
        currency: input.currency,
        rawPayloadHash: input.rawPayloadHash,
      })),
    };
  }

  const rows = await db.$transaction(async (tx) =>
    Promise.all(
      normalized.map((input) =>
        upsertNormalizedPosCheck(tx, {
          restaurantId: args.restaurantId,
          connectionId: args.connectionId,
          input,
        }),
      ),
    ),
  );

  const now = new Date();
  await db.posConnection.update({
    where: { id: args.connectionId },
    data: {
      status: 'ACTIVE',
      lastAttemptAt: now,
      lastSuccessAt: now,
      lastErrorCode: null,
      ...(args.nextCursor !== undefined ? { cursor: args.nextCursor } : {}),
    },
  });

  return {
    dryRun: false,
    processedCount: rows.length,
    nextCursor: args.nextCursor ?? null,
    checks: rows.map(serializePosCheck),
  };
}

/** Persist one explainable reservation/ticket link after explicit candidate data was supplied. */
export async function upsertReservationCheckMatch(args: {
  restaurantId: string;
  reservationId: string;
  posCheckId: string;
  reservation: ReservationMatchCandidate;
  check: PosCheckMatchCandidate;
  reviewedByHash?: string | null;
  /** Ties between candidates: a MATCHED score is kept for a human to confirm, as REVIEW. */
  reviewOnly?: boolean;
}): Promise<ReservationCheckMatchResult & { reservationId: string; posCheckId: string }> {
  const scored = scoreReservationCheckMatch({ reservation: args.reservation, check: args.check });
  const result =
    args.reviewOnly && scored.status === 'MATCHED'
      ? { ...scored, status: 'REVIEW' as const }
      : scored;
  await db.reservationCheckMatch.upsert({
    where: {
      reservationId_posCheckId: { reservationId: args.reservationId, posCheckId: args.posCheckId },
    },
    create: {
      restaurantId: args.restaurantId,
      reservationId: args.reservationId,
      posCheckId: args.posCheckId,
      method: result.method,
      confidence: new Prisma.Decimal(result.confidence.toFixed(3)),
      status: result.status,
      reviewedByHash: args.reviewedByHash ?? null,
    },
    update: {
      method: result.method,
      confidence: new Prisma.Decimal(result.confidence.toFixed(3)),
      status: result.status,
      reviewedByHash: args.reviewedByHash ?? null,
    },
  });
  return { ...result, reservationId: args.reservationId, posCheckId: args.posCheckId };
}

export { PosConnectionNotFoundError, PosConnectionStateError };
