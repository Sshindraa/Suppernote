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
        tableId: true,
        customerPhone: true,
      },
    });
    if (!reservation) continue;
    matches.push(
      await upsertReservationCheckMatch({
        restaurantId,
        reservationId: reservation.id,
        posCheckId: persisted.id,
        reservation: reservation,
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
        reading = readPosCheckCsv(parsed.data.csv, parsed.data.mapping as PosCheckMapping);
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
      const connection = await createOrUpdatePosConnection(request.restaurantId, FILE_CONNECTION);
      let matched = 0;
      try {
        for (let start = 0; start < reading.checks.length; start += IMPORT_CHUNK_SIZE) {
          const chunk = reading.checks.slice(start, start + IMPORT_CHUNK_SIZE);
          const result = await importPosChecks({
            restaurantId: request.restaurantId,
            connectionId: connection.id,
            checks: chunk,
            dryRun,
          });
          if (!dryRun) {
            const matches = await matchImportedChecks(request.restaurantId, chunk, result);
            matched += matches.filter((match) => match.status === 'MATCHED').length;
          }
        }
      } catch (error) {
        return sendPosError(error, reply) ?? Promise.reject(error);
      }

      return reply.send({
        data: {
          dryRun,
          columns: { headers: reading.headers, mapping: reading.mapping },
          counts: {
            imported: reading.checks.length,
            skipped: reading.skipped.length,
            withReservation: reading.withReservation,
            matched,
          },
          missing: reading.missing,
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
}

export { posConnectorsEnabled };
