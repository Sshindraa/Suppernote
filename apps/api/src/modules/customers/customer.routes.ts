import { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { db } from '../../shared/db/client';
import { redisCache } from '../../shared/redis/client';
import { requireOrg } from '../../plugins/clerk';
import {
  CreateCustomerSchema,
  UpdateCustomerSchema,
  ToggleVipSchema,
  CustomerParamsSchema,
  CustomerQuerySchema,
} from './customer.schema';
import {
  normalizeCustomerEmail,
  normalizeCustomerPhone,
  upsertCustomerIdentity,
} from './customer-crm.service';
import {
  canViewSensitiveNotes,
  canWriteSensitiveNotes,
  redactSensitiveCustomerFields,
} from './customer-privacy';
import { findCustomerForPhone } from './customer.service';
import { buildCustomersCsv } from './customer-export';
import {
  IMPORT_ROW_LIMIT,
  ImportCustomersSchema,
  ImportReading,
  applyCustomerImport,
  readCustomerImport,
} from './customer-import';
import {
  countCustomersByLifecycle,
  filterCustomerIdsByVisits,
  withCustomerLifecycles,
  loadCustomerVisitStats,
  loadComputedCustomerVisits,
} from './customer-lifecycle';
import { requireCapability } from '../entitlements/entitlement.guard';
import { evaluateCapability } from '../entitlements/entitlement.service';
import {
  buildServiceCard,
  loadReservationServiceCards,
  SERVICE_CARD_MAX_RESERVATIONS,
} from './customer-service-card';

const ServiceCardQuerySchema = z.object({
  reservationIds: z
    .string()
    .trim()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().min(1).max(128)).min(1).max(SERVICE_CARD_MAX_RESERVATIONS)),
});

async function canWriteCustomerNotes(
  restaurantId: string | undefined,
  siteRole: string | undefined,
): Promise<boolean> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { crmSensitiveNoteRoles: true },
  });
  return canWriteSensitiveNotes(siteRole, restaurant?.crmSensitiveNoteRoles);
}

/**
 * Filtre de recherche, commun aux écrans Clients et CRM Pro : le nom (sans tenir compte de la
 * casse), l'email ou le numéro. Les numéros sont stockés en
 * E.164 (« +33612345678 ») alors qu'on tape « 06 12 34 56 78 » : on compare les chiffres, avec et sans le
 * 0 de tête, pour qu'une saisie française entière ou partielle retrouve le client.
 */
export function buildCustomerSearchFilter(search: string): Prisma.CustomerWhereInput[] {
  const filters: Prisma.CustomerWhereInput[] = [
    { name: { contains: search, mode: 'insensitive' } },
    { emailNormalized: { contains: search.toLowerCase() } },
  ];
  const digits = search.replace(/\D/g, '');
  if (digits.length >= 2) {
    const variants = new Set([digits, digits.replace(/^0+/, '')]);
    for (const variant of variants) {
      if (variant.length >= 2) filters.push({ phone: { contains: variant } });
    }
  }
  return filters;
}

const COMPUTED_FILTER_SCAN_LIMIT = 5_000;
const EXPORT_LIMIT = 10_000;

async function canViewCustomerNotes(
  restaurantId: string,
  siteRole: string | undefined,
): Promise<boolean> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { crmSensitiveNoteRoles: true },
  });
  return canViewSensitiveNotes(siteRole, restaurant?.crmSensitiveNoteRoles);
}

export async function customerRoutes(app: FastifyInstance) {
  app.get(
    '/customers/suggestions',
    { preHandler: requireOrg(), config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const query = z
        .object({
          search: z.string().trim().min(1).max(100),
          limit: z.coerce.number().int().min(1).max(5).default(5),
        })
        .parse(req.query);
      const restaurantId = req.restaurantId!;
      const customers = await db.customer.findMany({
        where: {
          restaurantId,
          archivedAt: null,
          mergedIntoId: null,
          OR: buildCustomerSearchFilter(query.search),
        },
        select: { id: true, name: true, phone: true, emailNormalized: true },
        orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
        take: query.limit,
      });
      const ids = customers.map((customer) => customer.id);
      if (!ids.length) return reply.send({ data: [] });
      const { allowed: isPro } = await evaluateCapability(restaurantId, 'customers.advanced');
      const now = new Date();
      const [stats, preferences] = await Promise.all([
        isPro ? loadCustomerVisitStats(restaurantId, ids, now) : Promise.resolve(new Map()),
        db.customerPreference.findMany({
          where: {
            restaurantId,
            customerId: { in: ids },
            key: { in: ['dietary_restrictions', 'accessibility_needs'] },
          },
          select: {
            customerId: true,
            key: true,
            value: true,
            source: true,
            confirmedAt: true,
            expiresAt: true,
          },
        }),
      ]);
      return reply.send({
        data: customers.map((customer) => {
          const visits = stats.get(customer.id);
          const card = buildServiceCard({
            reservationId: '',
            reservationDate: now,
            specialRequests: null,
            customer: { id: customer.id, birthMonth: null, birthDay: null, specialOccasion: null },
            visitDates: visits?.visitDates ?? [],
            noShows365d: visits?.noShows365d ?? 0,
            preferences: preferences
              .filter((preference) => preference.customerId === customer.id)
              .map((preference) => ({ ...preference, source: String(preference.source) })),
            timezone: 'Europe/Paris',
            now,
          });
          return {
            id: customer.id,
            name: customer.name,
            phone: customer.phone,
            email: customer.emailNormalized,
            visitCount: isPro ? (visits?.visitDates.length ?? 0) : null,
            lastVisitAt: isPro ? (visits?.visitDates.at(-1) ?? null) : null,
            badges: card.badges,
          };
        }),
      });
    },
  );
  app.get(
    '/customers',
    { preHandler: requireOrg(), config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const query = CustomerQuerySchema.parse(req.query);
      const restaurantId = req.restaurantId;
      const computedSort = query.sort === 'recent' ? undefined : query.sort;
      // Profils archivés exclus : un client effacé au titre du RGPD (nom « ANON », téléphone « erased:… »)
      // et un profil source déjà fusionné ne sont plus des clients. Le CRM et la segmentation
      // appliquent déjà la même règle ; le total suit puisqu'il partage ce `where`.
      const where: Prisma.CustomerWhereInput = {
        restaurantId,
        archivedAt: null,
        mergedIntoId: null,
      };
      if (query.phone) where.phone = query.phone;
      if (query.search) where.OR = buildCustomerSearchFilter(query.search);

      if (query.isVip !== undefined) where.isVip = query.isVip;
      // Derniers contacts d'abord ; `id` départage pour une pagination stable.
      const orderBy: Prisma.CustomerOrderByWithRelationInput[] = [
        { lastSeenAt: { sort: 'desc', nulls: 'last' } },
        { id: 'desc' },
      ];

      let customers;
      let total: number;
      const now = new Date();
      let loadedStats: Awaited<ReturnType<typeof loadComputedCustomerVisits>> | undefined;
      if (
        query.lifecycle !== undefined ||
        query.minHonored365d !== undefined ||
        computedSort !== undefined
      ) {
        // Statut et visites viennent des réservations : fonction de CRM Pro (offre Essential = CRM de base).
        await requireCapability('customers.advanced')(req, reply);
        if (reply.sent) return reply;
        // shortcut: le filtrage calculé porte sur les 5 000 premiers clients, à relever si un site les dépasse.
        const candidates = await db.customer.findMany({
          where: { ...where, restaurantId },
          orderBy,
          select: { id: true },
          take: COMPUTED_FILTER_SCAN_LIMIT,
        });
        const candidateIds = candidates.map((candidate) => candidate.id);
        loadedStats = await loadComputedCustomerVisits(restaurantId!, candidateIds, now);
        const matching = await filterCustomerIdsByVisits(
          restaurantId!,
          candidateIds,
          { ...query, sort: computedSort },
          now,
          loadedStats,
        );
        total = matching.length;
        const pageIds = matching.slice(query.offset, query.offset + query.limit);
        const rows = await db.customer.findMany({
          where: { restaurantId, id: { in: pageIds } },
        });
        const byId = new Map(rows.map((row) => [row.id, row]));
        customers = pageIds.flatMap((id) => byId.get(id) ?? []);
      } else {
        [customers, total] = await Promise.all([
          db.customer.findMany({
            where: { ...where, restaurantId },
            orderBy,
            take: query.limit,
            skip: query.offset,
          }),
          db.customer.count({ where }),
        ]);
      }
      const restaurant = await db.restaurant.findUnique({
        where: { id: restaurantId },
        select: { crmSensitiveNoteRoles: true },
      });

      const canViewNotes = canViewSensitiveNotes(req.siteRole, restaurant?.crmSensitiveNoteRoles);
      const withLifecycle = await withCustomerLifecycles(restaurantId, customers, now, loadedStats);
      return reply.send({
        data: withLifecycle.map((customer) =>
          canViewNotes ? customer : redactSensitiveCustomerFields(customer),
        ),
        total,
        limit: query.limit,
        offset: query.offset,
      });
    },
  );

  /** Customers per list segment (all, VIP, each lifecycle status), with the list's search. */
  app.get(
    '/customers/segment-counts',
    { preHandler: requireOrg(), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      await requireCapability('customers.advanced')(req, reply);
      if (reply.sent) return reply;
      const { search } = CustomerQuerySchema.parse(req.query);
      const restaurantId = req.restaurantId!;
      // Même périmètre que la liste : sans profils archivés ni fusionnés.
      const where: Prisma.CustomerWhereInput = {
        restaurantId,
        archivedAt: null,
        mergedIntoId: null,
      };
      if (search) where.OR = buildCustomerSearchFilter(search);
      const [all, vip, candidates] = await Promise.all([
        db.customer.count({ where: { ...where, restaurantId } }),
        db.customer.count({ where: { ...where, restaurantId, isVip: true } }),
        // shortcut: les statuts portent sur les 5 000 premiers clients, comme le filtre de la liste.
        db.customer.findMany({
          where: { ...where, restaurantId },
          orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
          select: { id: true },
          take: COMPUTED_FILTER_SCAN_LIMIT,
        }),
      ]);
      const lifecycle = await countCustomersByLifecycle(
        restaurantId,
        candidates.map((candidate) => candidate.id),
        new Date(),
      );
      return reply.send({ data: { all, vip, ...lifecycle } });
    },
  );

  /** Whole customer file as CSV, for the owner only: backup and portability, on every plan. */
  app.get(
    '/customers/export',
    {
      preHandler: [
        requireOrg(),
        requireCapability('customers.basic'),
        async (req, reply) => {
          if (req.siteRole === 'OWNER') return;
          return reply.status(403).send({
            error: 'CUSTOMER_EXPORT_OWNER_REQUIRED',
            message: 'Seul le propriétaire du site peut exporter le fichier clients.',
          });
        },
      ],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const restaurantId = req.restaurantId!;
      // shortcut: 10 000 clients maximum par export, à relever (ou paginer) si un site les dépasse.
      const customers = await db.customer.findMany({
        where: { restaurantId, archivedAt: null, mergedIntoId: null },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: EXPORT_LIMIT + 1,
      });
      // Un CSV partiel ferait croire à une sauvegarde complète : on refuse plutôt que de tronquer.
      if (customers.length > EXPORT_LIMIT) {
        return reply.status(422).send({
          error: 'CUSTOMER_EXPORT_TOO_LARGE',
          message: `Le fichier dépasse ${EXPORT_LIMIT} clients : l'export complet n'est pas disponible.`,
        });
      }
      const withVisits = await withCustomerLifecycles(restaurantId, customers);
      return reply.send({
        data: { csv: buildCustomersCsv(withVisits), count: withVisits.length },
      });
    },
  );

  /**
   * Imports a customer CSV (owner only, like the export). `dryRun` checks the columns and counts
   * without writing. Existing customers are completed, never overwritten; no consent is written.
   */
  app.post(
    '/customers/import',
    {
      preHandler: [
        requireOrg(),
        requireCapability('customers.basic'),
        async (req, reply) => {
          if (req.siteRole === 'OWNER') return;
          return reply.status(403).send({
            error: 'CUSTOMER_IMPORT_OWNER_REQUIRED',
            message: 'Seul le propriétaire du site peut importer le fichier clients.',
          });
        },
      ],
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      bodyLimit: 6 * 1024 * 1024,
    },
    async (req, reply) => {
      const parsed = ImportCustomersSchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ error: 'INVALID_CUSTOMER_IMPORT' });
      let reading: ImportReading;
      try {
        reading = readCustomerImport(parsed.data.csv, parsed.data.mapping);
      } catch (err: unknown) {
        return reply.status(400).send({
          error: 'INVALID_CUSTOMER_IMPORT_MAPPING',
          message: err instanceof Error ? err.message : 'Colonne introuvable.',
        });
      }
      // Un import partiel laisserait des clients manquants sans le dire : on refuse plutôt que de tronquer.
      if (reading.lines.length > IMPORT_ROW_LIMIT) {
        return reply.status(422).send({
          error: 'CUSTOMER_IMPORT_TOO_LARGE',
          message: `Le fichier dépasse ${IMPORT_ROW_LIMIT} clients : découpez-le en plusieurs fichiers.`,
        });
      }
      const outcome = await applyCustomerImport(req.restaurantId!, reading, parsed.data.dryRun);
      return reply.send({
        data: {
          dryRun: parsed.data.dryRun,
          columns: { headers: reading.headers, mapping: reading.mapping },
          ...outcome,
        },
      });
    },
  );

  /**
   * Badges shown next to each reservation during service, for a whole list in
   * one call. Never the manager's notes, never an unconfirmed voice suggestion.
   */
  app.get(
    '/customers/service-cards',
    { preHandler: requireOrg(), config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = ServiceCardQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'INVALID_RESERVATION_IDS' });
      }
      const data = await loadReservationServiceCards(req.restaurantId!, parsed.data.reservationIds);
      return reply.send({ data });
    },
  );

  app.post(
    '/customers',
    { preHandler: requireOrg(), config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = CreateCustomerSchema.parse(req.body);
      const restaurantId = req.restaurantId!;
      if (
        (body.notes !== undefined || body.specialOccasion !== undefined) &&
        !(await canWriteCustomerNotes(req.restaurantId, req.siteRole))
      ) {
        return reply.status(403).send({
          error: 'CUSTOMER_NOTES_WRITE_ROLE_REQUIRED',
          message:
            'La modification des notes et de l’occasion spéciale est réservée aux rôles autorisés à les consulter.',
        });
      }
      const emailNormalized = body.email ? normalizeCustomerEmail(body.email) : null;
      const normalizedPhone = normalizeCustomerPhone(body.phone);
      // Only the fields sent are written: an upsert of a known guest never resets VIP or blanks
      // a field the request did not mention.
      const fields = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(emailNormalized ? { emailNormalized } : {}),
        ...(body.birthMonth !== undefined ? { birthMonth: body.birthMonth } : {}),
        ...(body.birthDay !== undefined ? { birthDay: body.birthDay } : {}),
        ...(body.preferredLocale !== undefined ? { preferredLocale: body.preferredLocale } : {}),
        ...(body.notes !== undefined ? { notes: body.notes } : {}),
        ...(body.specialOccasion !== undefined ? { specialOccasion: body.specialOccasion } : {}),
        ...(body.isVip !== undefined ? { isVip: body.isVip } : {}),
      };
      try {
        const existing = await findCustomerForPhone(restaurantId, body.phone, normalizedPhone);
        const customer = existing
          ? await db.customer.update({ where: { id: existing.id, restaurantId }, data: fields })
          : await db.customer.create({
              data: { restaurantId, phone: normalizedPhone ?? body.phone, ...fields },
            });
        try {
          if (normalizedPhone) {
            await upsertCustomerIdentity({
              restaurantId,
              customerId: customer.id,
              type: 'PHONE',
              value: body.phone,
              source: 'MANUAL',
            });
          }
          if (emailNormalized) {
            await upsertCustomerIdentity({
              restaurantId,
              customerId: customer.id,
              type: 'EMAIL',
              value: body.email!,
              source: 'MANUAL',
            });
          }
        } catch {
          // A collision remains visible to the duplicate-review workflow; it
          // must not roll back an otherwise valid legacy customer upsert.
        }
        await redisCache.del(`customer:${restaurantId}:${normalizedPhone ?? body.phone}`);
        return reply
          .status(201)
          .send(
            (await canViewCustomerNotes(restaurantId, req.siteRole))
              ? customer
              : redactSensitiveCustomerFields(customer),
          );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')
          return reply.status(409).send({ error: 'Customer already exists' });
        throw err;
      }
    },
  );

  app.patch(
    '/customers/:id',
    { preHandler: requireOrg(), config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = CustomerParamsSchema.parse(req.params);
      const restaurantId = req.restaurantId;
      const body = UpdateCustomerSchema.parse(req.body);
      if (
        (body.notes !== undefined || body.specialOccasion !== undefined) &&
        !(await canWriteCustomerNotes(req.restaurantId, req.siteRole))
      ) {
        return reply.status(403).send({
          error: 'CUSTOMER_NOTES_WRITE_ROLE_REQUIRED',
          message:
            'La modification des notes et de l’occasion spéciale est réservée aux rôles autorisés à les consulter.',
        });
      }
      const { email, ...rest } = body;
      const data = {
        ...rest,
        ...(email !== undefined
          ? { emailNormalized: email ? normalizeCustomerEmail(email) : null }
          : {}),
      };
      const previous =
        email !== undefined
          ? await db.customer.findFirst({
              where: { id, restaurantId },
              select: { emailNormalized: true },
            })
          : null;
      const updated = await db.customer.update({ where: { id, restaurantId }, data });
      // A replaced or cleared email must stop matching this guest in duplicate detection.
      if (previous?.emailNormalized && previous.emailNormalized !== updated.emailNormalized) {
        await db.customerIdentity.deleteMany({
          where: {
            restaurantId,
            customerId: id,
            type: 'EMAIL',
            normalizedValue: previous.emailNormalized,
          },
        });
      }
      if (email) {
        try {
          await upsertCustomerIdentity({
            restaurantId,
            customerId: updated.id,
            type: 'EMAIL',
            value: email,
            source: 'MANUAL',
          });
        } catch {
          // Keep the profile mutation available; an identity collision is a
          // merge candidate and is handled by CRM duplicate review.
        }
      }
      await redisCache.del(
        `customer:${updated.restaurantId}:${normalizeCustomerPhone(updated.phone) ?? updated.phone}`,
      );
      return reply.send(
        (await canViewCustomerNotes(updated.restaurantId, req.siteRole))
          ? updated
          : redactSensitiveCustomerFields(updated),
      );
    },
  );

  // No hard delete: it cascaded the marketing opt-outs and consent proofs, so a customer who
  // called back became reachable again. Erasure goes through the RGPD anonymisation.

  app.post(
    '/customers/:id/vip',
    { preHandler: requireOrg(), config: { rateLimit: { max: 100, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = CustomerParamsSchema.parse(req.params);
      const restaurantId = req.restaurantId;
      const { isVip } = ToggleVipSchema.parse(req.body);
      const updated = await db.customer.update({ where: { id, restaurantId }, data: { isVip } });
      await redisCache.del(
        `customer:${updated.restaurantId}:${normalizeCustomerPhone(updated.phone) ?? updated.phone}`,
      );
      return reply.send(
        (await canViewCustomerNotes(updated.restaurantId, req.siteRole))
          ? updated
          : redactSensitiveCustomerFields(updated),
      );
    },
  );
}
