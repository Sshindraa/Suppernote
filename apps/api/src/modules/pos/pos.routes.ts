import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { requireOrg } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import { IMPORT_BODY_LIMIT_BYTES, IMPORT_CSV_MAX_CHARS } from '../customers/customer-import';
import {
  createOrUpdatePosConnection,
  disconnectPosConnection,
  getPosConnectionHealth,
  listPosConnections,
  PosConnectionInputError,
  PosConnectionNotFoundError,
  PosConnectionStateError,
} from './pos-connection.service';
import type { PosCheckInput } from './pos-connector';
import {
  POS_CHECK_FIELDS,
  POS_CHECK_FIELD_LABELS,
  POS_CSV_ROW_LIMIT,
  readPosCheckCsv,
  type PosCheckMapping,
  type PosCsvReading,
} from './pos-check-csv';
import {
  importPosChecks,
  PosCheckInputError,
  upsertReservationCheckMatch,
  type PosImportResult,
} from './pos-sync.service';
import { matchTicketsToReservations } from './pos-check-auto-match';
import { listPosChecks } from './pos-check-list';

const ConnectionIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

const ConnectionBodySchema = z.object({
  provider: z.string().trim().min(1).max(64),
  externalLocationId: z.string().trim().min(1).max(191),
  credentialReference: z.string().trim().min(1).max(191),
});

const DecimalInputSchema = z.union([
  z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d+)?$/),
  z.number().finite().nonnegative(),
]);

const MatchingHintsSchema = z
  .object({
    reservationExternalId: z.string().trim().min(1).max(256).nullable().optional(),
    partySize: z.number().int().min(1).max(100).nullable().optional(),
    customerPhone: z.string().trim().min(1).max(64).nullable().optional(),
    customerToken: z.string().trim().min(1).max(256).nullable().optional(),
    conflict: z.boolean().optional(),
  })
  .nullable()
  .optional();

const CheckBodySchema = z.object({
  externalId: z.string().trim().min(1).max(256),
  externalRevision: z.string().trim().min(1).max(128).nullable().optional(),
  openedAt: z.coerce.date(),
  closedAt: z.coerce.date().nullable().optional(),
  tableReference: z.string().trim().min(1).max(128).nullable().optional(),
  subtotal: DecimalInputSchema,
  tax: DecimalInputSchema,
  tip: DecimalInputSchema.nullable().optional(),
  discount: DecimalInputSchema.nullable().optional(),
  total: DecimalInputSchema,
  refundedAmount: DecimalInputSchema.nullable().optional(),
  currency: z.string().trim().length(3).optional(),
  rawPayload: z.unknown().optional(),
  reservationId: z.string().trim().min(1).max(128).nullable().optional(),
  matchingHints: MatchingHintsSchema,
});

const ImportBodySchema = z.object({
  checks: z.array(CheckBodySchema).min(1).max(500),
  dryRun: z.boolean().default(true),
  nextCursor: z.string().trim().max(512).nullable().optional(),
});

const CsvImportBodySchema = z.object({
  csv: z.string().min(1).max(IMPORT_CSV_MAX_CHARS),
  mapping: z
    .object(
      Object.fromEntries(
        POS_CHECK_FIELDS.map((field) => [field, z.string().max(200).nullable().optional()]),
      ),
    )
    .optional(),
  dryRun: z.boolean().default(true),
  /** Set by the dashboard after the first piece: the file's header row, or none. */
  hasHeader: z.boolean().optional(),
  /** Line of the piece's first row in the original file minus one: keeps the report's line numbers. */
  lineOffset: z.number().int().min(0).max(10_000_000).default(0),
});

const ReviewCheckBodySchema = z.object({ decision: z.enum(['confirm', 'reject']) });

const ListChecksQuerySchema = z.object({
  cursor: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Same ceiling as the JSON import, so one page of tickets stays under the proxy timeout. */
const IMPORT_CHUNK_SIZE = 500;

/**
 * A ticket file is not a provider: its connection carries no secret, only a fixed reference that
 * the secret-reference rule accepts. Unique per restaurant by provider.
 */
const FILE_CONNECTION = {
  provider: 'csv-file',
  externalLocationId: 'fichier',
  credentialReference: 'file:csv-import',
};

function posConnectorsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.POS_CONNECTORS_ENABLED === 'true';
}

async function requirePosRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'POS_ROLE_REQUIRED',
    message: 'L’accès aux connexions de caisse est réservé aux responsables.',
  });
}

async function requirePosFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (posConnectorsEnabled()) return;
  return reply.status(503).send({
    error: 'POS_CONNECTORS_DISABLED',
    message: 'Les connecteurs de caisse sont désactivés jusqu’à la qualification d’un pilote.',
  });
}

const requirePosRead = [
  requireOrg(),
  requireCapability('pos.connect'),
  requirePosRole,
  requirePosFeature,
];
const requirePosWrite = [
  requireOrg(),
  requireCapability('pos.connect'),
  requirePosRole,
  requirePosFeature,
];

function sendPosError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (error instanceof PosConnectionNotFoundError) {
    return reply.status(404).send({ error: error.code });
  }
  if (error instanceof PosConnectionStateError) {
    return reply.status(409).send({ error: error.code });
  }
  if (error instanceof PosConnectionInputError || error instanceof PosCheckInputError) {
    return reply.status(400).send({ error: error.code, message: error.message });
  }
  return undefined;
}

/**
 * Matching is opt-in per imported row. Reservation data is always re-read through the tenant scope;
 * a low-confidence result is only a review suggestion and never enriches a customer profile.
 */
async function matchImportedChecks(
  restaurantId: string,
  checks: PosCheckInput[],
  result: PosImportResult,
) {
  const matches = [];
  for (const input of checks) {
    if (!input.reservationId) continue;
    const persisted = result.checks.find((check) => check.externalId === input.externalId) as
      | { id?: string; openedAt: string; tableReference: string | null }
      | undefined;
    if (!persisted?.id) continue;
    const reservation = await db.reservation.findFirst({
      where: { id: input.reservationId, restaurantId },
      select: {
        id: true,
        reservedAt: true,
        startsAt: true,
        partySize: true,
        customerPhone: true,
        table: { select: { name: true } },
      },
    });
    if (!reservation) continue;
    matches.push(
      await upsertReservationCheckMatch({
        restaurantId,
        reservationId: reservation.id,
        posCheckId: persisted.id,
        reservation: {
          id: reservation.id,
          reservedAt: reservation.reservedAt,
          startsAt: reservation.startsAt,
          partySize: reservation.partySize,
          customerPhone: reservation.customerPhone,
          // The table name: the ticket carries a table label, never a table id.
          tableReference: reservation.table?.name ?? null,
        },
        check: {
          id: persisted.id,
          openedAt: persisted.openedAt,
          tableReference: persisted.tableReference,
          ...input.matchingHints,
        },
      }),
    );
  }
  return matches;
}

/** Local POS foundation. Provider adapters are intentionally not registered yet. */
export async function posRoutes(app: FastifyInstance) {
  app.get('/pos/connections', { preHandler: requirePosRead }, async (request, reply) => {
    return reply.send({ data: await listPosConnections(request.restaurantId) });
  });

  app.post('/pos/connections', { preHandler: requirePosWrite }, async (request, reply) => {
    const body = ConnectionBodySchema.parse(request.body);
    try {
      return reply.status(201).send({
        data: await createOrUpdatePosConnection(request.restaurantId, body),
      });
    } catch (error) {
      return sendPosError(error, reply) ?? Promise.reject(error);
    }
  });

  app.get('/pos/connections/:id/health', { preHandler: requirePosRead }, async (request, reply) => {
    const { id } = ConnectionIdParamsSchema.parse(request.params);
    try {
      return reply.send({ data: await getPosConnectionHealth(request.restaurantId, id) });
    } catch (error) {
      return sendPosError(error, reply) ?? Promise.reject(error);
    }
  });

  app.post(
    '/pos/connections/:id/disconnect',
    { preHandler: requirePosWrite },
    async (request, reply) => {
      const { id } = ConnectionIdParamsSchema.parse(request.params);
      try {
        return reply.send({ data: await disconnectPosConnection(request.restaurantId, id) });
      } catch (error) {
        return sendPosError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/pos/connections/:id/checks/import',
    { preHandler: requirePosWrite },
    async (request, reply) => {
      const { id } = ConnectionIdParamsSchema.parse(request.params);
      const body = ImportBodySchema.parse(request.body);
      try {
        const result = await importPosChecks({
          restaurantId: request.restaurantId,
          connectionId: id,
          checks: body.checks as PosCheckInput[],
          dryRun: body.dryRun,
          nextCursor: body.nextCursor,
        });
        const matches = body.dryRun
          ? []
          : await matchImportedChecks(request.restaurantId, body.checks as PosCheckInput[], result);
        return reply.send({ data: result, matches });
      } catch (error) {
        return sendPosError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  /**
   * Imports a ticket export (CSV) into the file connection of this restaurant. `dryRun` checks the
   * columns and rows through the same service without writing tickets. Bad rows are skipped with a
   * reason; the rest is imported. Same ceiling as the customer import (nginx 1 MiB).
   */
  app.post(
    '/pos/checks/csv-import',
    {
      preHandler: requirePosWrite,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      bodyLimit: IMPORT_BODY_LIMIT_BYTES,
    },
    async (request, reply) => {
      const parsed = CsvImportBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_POS_CHECK_IMPORT' });
      let reading: PosCsvReading;
      try {
        reading = readPosCheckCsv(parsed.data.csv, parsed.data.mapping as PosCheckMapping, {
          hasHeader: parsed.data.hasHeader,
          lineOffset: parsed.data.lineOffset,
        });
      } catch (err: unknown) {
        return reply.status(400).send({
          error: 'INVALID_POS_CHECK_MAPPING',
          message: err instanceof Error ? err.message : 'Colonne introuvable.',
        });
      }
      const rows = reading.checks.length + reading.skipped.length;
      if (rows > POS_CSV_ROW_LIMIT) {
        return reply.status(422).send({
          error: 'POS_CHECK_IMPORT_TOO_LARGE',
          message: `Le fichier dépasse ${POS_CSV_ROW_LIMIT} tickets : découpez-le en plusieurs fichiers.`,
        });
      }

      const { dryRun } = parsed.data;
      if (reading.missing.length > 0 && !dryRun) {
        return reply.status(400).send({
          error: 'INVALID_POS_CHECK_MAPPING',
          message: `Colonne obligatoire non reconnue : ${reading.missing.map((field) => POS_CHECK_FIELD_LABELS[field]).join(', ')}.`,
        });
      }

      const restaurantId = request.restaurantId;
      // A dry run writes no connection. With none yet, importPosChecks has nothing to check against,
      // and the reader has already validated every row with the same rules.
      const existing = await db.posConnection.findUnique({
        where: { restaurantId_provider: { restaurantId, provider: FILE_CONNECTION.provider } },
        select: { id: true },
      });
      let connectionId: string | null = existing?.id ?? null;
      if (!dryRun) {
        connectionId = (await createOrUpdatePosConnection(restaurantId, FILE_CONNECTION)).id;
      }

      const counts = { matched: 0, toReview: 0 };
      try {
        for (let start = 0; start < reading.checks.length; start += IMPORT_CHUNK_SIZE) {
          const chunk = reading.checks.slice(start, start + IMPORT_CHUNK_SIZE);
          const result =
            connectionId === null
              ? null
              : await importPosChecks({ restaurantId, connectionId, checks: chunk, dryRun });

          // Ticket ids for matching: stored ids on import, local keys in a dry run (nothing written).
          const storedIds = new Map<string, string>();
          for (const check of result?.checks ?? []) {
            if ('id' in check && check.id) storedIds.set(check.externalId, check.id);
          }
          const autoTickets = chunk.flatMap((check, index) => {
            if (check.reservationId) return [];
            const id = dryRun ? `dry-${start + index}` : storedIds.get(check.externalId);
            if (!id) return [];
            return [
              {
                id,
                openedAt: new Date(check.openedAt),
                tableReference: check.tableReference ?? null,
                partySize: check.matchingHints?.partySize ?? null,
              },
            ];
          });
          const auto = await matchTicketsToReservations({
            restaurantId,
            tickets: autoTickets,
            persist: !dryRun,
          });
          counts.matched += auto.matched;
          counts.toReview += auto.review;

          // Rows that name a reservation are linked explicitly, as in the JSON import.
          if (!dryRun && result) {
            const explicit = await matchImportedChecks(restaurantId, chunk, result);
            counts.matched += explicit.filter((match) => match.status === 'MATCHED').length;
            counts.toReview += explicit.filter((match) => match.status === 'REVIEW').length;
          }
        }
      } catch (error) {
        return sendPosError(error, reply) ?? Promise.reject(error);
      }

      return reply.send({
        data: {
          dryRun,
          columns: {
            headers: reading.headers,
            headerLine: reading.headerLine,
            mapping: reading.mapping,
            byContent: reading.byContent,
          },
          missing: reading.missing,
          counts: {
            imported: reading.checks.length,
            skipped: reading.skipped.length,
            withReservation: reading.withReservation,
            matched: counts.matched,
            toReview: counts.toReview,
          },
          reasons: reading.skipped,
          preview: reading.checks.slice(0, 5).map((check) => ({
            externalId: check.externalId,
            openedAt: new Date(check.openedAt).toISOString(),
            tableReference: check.tableReference ?? null,
            total: String(check.total),
          })),
        },
      });
    },
  );

  /**
   * Confirms or rejects the reservation link a ticket still waits for (status REVIEW). Same guards as
   * the import. Confirming keeps the link (MATCHED); rejecting clears it (UNMATCHED).
   */
  app.post('/pos/checks/:id/review', { preHandler: requirePosWrite }, async (request, reply) => {
    const params = z.object({ id: z.string().trim().min(1).max(128) }).safeParse(request.params);
    const body = ReviewCheckBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'INVALID_POS_CHECK_REVIEW' });
    }
    const restaurantId = request.restaurantId;
    const match = await db.reservationCheckMatch.findFirst({
      where: { restaurantId, posCheckId: params.data.id, status: 'REVIEW' },
      orderBy: { confidence: 'desc' },
      select: { reservationId: true },
    });
    if (!match) {
      return reply.status(404).send({
        error: 'REVIEW_MATCH_NOT_FOUND',
        message: 'Aucun rapprochement à vérifier pour ce ticket.',
      });
    }
    // Scoped to the tenant and to the review state: a link decided meanwhile is left alone.
    const status = body.data.decision === 'confirm' ? 'MATCHED' : 'UNMATCHED';
    const updated = await db.reservationCheckMatch.updateMany({
      where: {
        restaurantId,
        reservationId: match.reservationId,
        posCheckId: params.data.id,
        status: 'REVIEW',
      },
      data: { status },
    });
    if (updated.count === 0) {
      return reply.status(409).send({
        error: 'REVIEW_MATCH_ALREADY_DECIDED',
        message: 'Ce rapprochement a déjà été vérifié. Actualisez la liste.',
      });
    }
    return reply.send({ data: { status } });
  });

  /** Imported tickets with their reservation link, most recent first. Same read rights as the other routes. */
  app.get('/pos/checks', { preHandler: requirePosRead }, async (request, reply) => {
    const parsed = ListChecksQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_POS_CHECK_QUERY' });
    return reply.send({ data: await listPosChecks(request.restaurantId, parsed.data) });
  });
}

export { posConnectorsEnabled };
