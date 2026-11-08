import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSokarOperator } from '../../plugins/clerk';
import { RATE_LIMIT_PUBLIC_WRITE } from '../../plugins/rate-limit.policy';
import {
  createDemoRequest,
  getDemoRequestSummary,
  listDemoRequests,
  markDemoRequestTest,
  markDemoRequestNotified,
  notifyDemoRequest,
  recordDemoRequestInteraction,
  updateDemoRequestStatus,
} from './demo-request.service';

const DEMO_REQUEST_STATUSES = ['NEW', 'CONTACTED', 'DEMO_DONE', 'CLOSED'] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

const PublicDemoRequestBody = z.object({
  idempotencyKey: z.string().guid(),
  establishmentName: z.string().trim().min(2).max(120),
  contactEmail: z
    .string()
    .trim()
    .max(254)
    .email()
    .transform((value) => value.toLowerCase()),
  contactPhone: optionalText(32).refine(
    (value) => value === undefined || /^[+0-9 ().-]+$/.test(value),
    { message: 'invalid_phone' },
  ),
  currentTool: optionalText(120),
  mainProblem: optionalText(500),
  pageVersion: z.string().trim().min(1).max(40).default('demo-v1'),
});

const OperatorListQuery = z.object({
  status: z.enum(DEMO_REQUEST_STATUSES).optional(),
  isTest: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  active: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const OperatorStatusBody = z.object({
  status: z.enum(DEMO_REQUEST_STATUSES),
});

const OperatorInteractionBody = z
  .object({ occurredAt: z.string().datetime({ offset: true }).optional() })
  .strict();

const DemoRequestParams = z.object({
  id: z.string().min(1).max(64),
});

/** Erreur réduite à son code : le message Prisma peut reprendre les valeurs saisies. */
function persistenceErrorCode(error: unknown): string {
  return typeof (error as { code?: unknown })?.code === 'string'
    ? String((error as { code: string }).code)
    : 'UNKNOWN';
}

export async function demoRequestRoutes(app: FastifyInstance) {
  // Formulaire de la vitrine : aucun compte requis. Le rate-limit public limite les envois en masse.
  app.post(
    '/public/demo-requests',
    { config: { rateLimit: RATE_LIMIT_PUBLIC_WRITE } },
    async (request, reply) => {
      const body = request.body as { website?: unknown } | undefined;
      // Champ piège invisible pour un humain : un bot qui le remplit reçoit un succès sans effet.
      if (typeof body?.website === 'string' && body.website.trim() !== '') {
        return reply.status(202).send({ data: { id: null, replayed: false } });
      }

      const parsed = PublicDemoRequestBody.safeParse(request.body);
      if (!parsed.success) {
        const fields = [
          ...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? 'body'))),
        ];
        return reply.status(400).send({ error: 'VALIDATION_ERROR', fields });
      }

      let result: Awaited<ReturnType<typeof createDemoRequest>>;
      try {
        result = await createDemoRequest(parsed.data);
      } catch (error) {
        request.log.error(
          { errorCode: persistenceErrorCode(error) },
          'demo_request.persist_failed',
        );
        return reply.status(503).send({ error: 'DEMO_REQUEST_UNAVAILABLE' });
      }

      if (!result.replayed) {
        try {
          const notified = await notifyDemoRequest(result.record);
          if (notified) {
            await markDemoRequestNotified(result.record.id);
          } else {
            request.log.warn(
              { demoRequestId: result.record.id },
              'demo_request.notification_not_accepted',
            );
          }
        } catch (error) {
          // La demande reste enregistrée ; le suivi opérateur voit qu'aucune notification n'est partie.
          request.log.warn(
            { demoRequestId: result.record.id, errorCode: persistenceErrorCode(error) },
            'demo_request.notification_failed',
          );
        }
        request.log.info({ demoRequestId: result.record.id }, 'demo_request.created');
      }

      return reply.status(result.replayed ? 200 : 201).send({
        data: {
          id: result.record.id,
          status: result.record.status,
          replayed: result.replayed,
        },
      });
    },
  );

  // Suivi opérateur : liste et statut, réservés aux opérateurs Suppernote (SOKAR_OPERATOR_USER_IDS).
  app.get(
    '/admin/demo-requests',
    { preHandler: requireSokarOperator() },
    async (request, reply) => {
      const query = OperatorListQuery.safeParse(request.query);
      if (!query.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR' });
      }
      const items = await listDemoRequests(query.data);
      return reply.send({ data: items });
    },
  );

  app.get(
    '/admin/demo-requests/summary',
    { preHandler: requireSokarOperator() },
    async (_request, reply) => {
      return reply.send(await getDemoRequestSummary());
    },
  );

  app.patch(
    '/admin/demo-requests/:id/test',
    { preHandler: requireSokarOperator() },
    async (request, reply) => {
      const params = DemoRequestParams.safeParse(request.params);
      const body = z.object({ isTest: z.boolean() }).strict().safeParse(request.body);
      if (!params.success || !body.success)
        return reply.status(400).send({ error: 'VALIDATION_ERROR' });
      const updated = await markDemoRequestTest(params.data.id, body.data.isTest);
      if (!updated) return reply.status(404).send({ error: 'DEMO_REQUEST_NOT_FOUND' });
      return reply.send({ data: updated });
    },
  );

  app.patch(
    '/admin/demo-requests/:id',
    { preHandler: requireSokarOperator() },
    async (request, reply) => {
      const params = DemoRequestParams.safeParse(request.params);
      const body = OperatorStatusBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR' });
      }

      const updated = await updateDemoRequestStatus(params.data.id, body.data.status);
      if (!updated) {
        return reply.status(404).send({ error: 'DEMO_REQUEST_NOT_FOUND' });
      }
      return reply.send({ data: updated });
    },
  );

  app.post(
    '/admin/demo-requests/:id/interaction',
    { preHandler: requireSokarOperator() },
    async (request, reply) => {
      const params = DemoRequestParams.safeParse(request.params);
      const body = OperatorInteractionBody.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR' });
      }

      const occurredAt = body.data.occurredAt ? new Date(body.data.occurredAt) : new Date();
      if (occurredAt.getTime() > Date.now()) {
        return reply.status(400).send({ error: 'VALIDATION_ERROR' });
      }

      const updated = await recordDemoRequestInteraction(params.data.id, occurredAt);
      if (!updated) {
        return reply.status(404).send({ error: 'DEMO_REQUEST_NOT_FOUND' });
      }
      return reply.send({ data: updated });
    },
  );
}
