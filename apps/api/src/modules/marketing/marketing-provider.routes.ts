import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { MarketingProviderReconciliationStatus } from '@prisma/client';
import { db } from '../../shared/db/client';
import { verifyResendWebhookSignature } from '../../shared/email';
import {
  applyMarketingProviderEvent,
  ignoreMarketingProviderReconciliation,
  listMarketingProviderReconciliations,
  reconcileMarketingProviderEvents,
} from './marketing-provider.service';

const ResendWebhookSchema = z
  .object({
    type: z.string().trim().min(1).max(80),
    created_at: z.string().trim().max(80).optional(),
    data: z
      .object({
        email_id: z.string().trim().min(1).max(256),
        failed: z.object({ reason: z.string().max(512).optional() }).optional(),
        bounce: z.object({ type: z.string().max(128).optional() }).optional(),
      })
      .passthrough(),
  })
  .passthrough();

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function eventDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const ReconciliationQuerySchema = z.object({
  status: z.nativeEnum(MarketingProviderReconciliationStatus).optional(),
  provider: z.enum(['telnyx', 'resend']).optional(),
  restaurantId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const ReconciliationBodySchema = z.object({
  provider: z.enum(['telnyx', 'resend']).optional(),
  restaurantId: z.string().trim().min(1).max(128).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});
const ReconciliationIdParamsSchema = z.object({ id: z.string().trim().min(1).max(128) });
const IgnoreReconciliationBodySchema = z.object({
  reason: z.string().trim().min(1).max(80),
});

async function requireInternalMarketingToken(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  const expected = process.env.SOKAR_INTERNAL_MARKETING_TOKEN?.trim();
  if (!expected)
    return reply.status(503).send({ error: 'INTERNAL_MARKETING_TOKEN_NOT_CONFIGURED' });
  const suppliedHeader =
    request.headers['x-suppernote-internal-marketing-token'] ??
    request.headers['x-sokar-internal-marketing-token'];
  const supplied = Array.isArray(suppliedHeader) ? suppliedHeader[0] : suppliedHeader;
  if (!supplied) return reply.status(401).send({ error: 'INTERNAL_MARKETING_UNAUTHORIZED' });
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  if (
    expectedBytes.length !== suppliedBytes.length ||
    !timingSafeEqual(expectedBytes, suppliedBytes)
  ) {
    return reply.status(401).send({ error: 'INTERNAL_MARKETING_UNAUTHORIZED' });
  }
}

/** Signed provider callbacks for marketing delivery state. */
export async function marketingProviderRoutes(app: FastifyInstance) {
  app.post('/marketing/webhooks/resend', async (request, reply) => {
    const rawBody = (request as unknown as { rawBody?: unknown }).rawBody;
    if (typeof rawBody !== 'string') {
      return reply.status(400).send({ error: 'RAW_BODY_REQUIRED' });
    }

    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) return reply.status(503).send({ error: 'RESEND_WEBHOOK_NOT_CONFIGURED' });

    const valid = verifyResendWebhookSignature({
      payload: rawBody,
      id: headerValue(request.headers['svix-id']),
      timestamp: headerValue(request.headers['svix-timestamp']),
      signature: headerValue(request.headers['svix-signature']),
      secret,
    });
    if (!valid) return reply.status(403).send({ error: 'INVALID_RESEND_WEBHOOK_SIGNATURE' });

    const parsed = ResendWebhookSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'INVALID_RESEND_WEBHOOK_PAYLOAD' });

    const result = await applyMarketingProviderEvent(
      {
        provider: 'resend',
        providerMessageId: parsed.data.data.email_id,
        eventType: parsed.data.type,
        occurredAt: eventDate(parsed.data.created_at),
        payloadHash: createHash('sha256').update(rawBody).digest('hex'),
        errorCode:
          parsed.data.data.failed?.reason ?? parsed.data.data.bounce?.type ?? parsed.data.type,
      },
      db,
    );
    return reply.send({
      result: result.matched
        ? 'processed'
        : result.reconciliationId
          ? 'reconciliation_pending'
          : 'ignored',
      changed: result.changed,
      ...(result.reconciliationId ? { reconciliationId: result.reconciliationId } : {}),
    });
  });

  /** Internal operator view; no contact data or body is returned. */
  app.get(
    '/api/internal/marketing/reconciliation',
    { preHandler: requireInternalMarketingToken },
    async (request, reply) => {
      const query = ReconciliationQuerySchema.parse(request.query);
      return reply.send({
        data: await listMarketingProviderReconciliations({
          status: query.status,
          provider: query.provider,
          restaurantId: query.restaurantId,
          limit: query.limit,
        }),
      });
    },
  );

  app.post(
    '/api/internal/marketing/reconciliation/reconcile',
    { preHandler: requireInternalMarketingToken },
    async (request, reply) => {
      const body = ReconciliationBodySchema.parse(request.body ?? {});
      return reply.send({
        data: await reconcileMarketingProviderEvents(body),
      });
    },
  );

  app.post(
    '/api/internal/marketing/reconciliation/:id/ignore',
    { preHandler: requireInternalMarketingToken },
    async (request, reply) => {
      const { id } = ReconciliationIdParamsSchema.parse(request.params);
      const body = IgnoreReconciliationBodySchema.parse(request.body ?? {});
      try {
        await ignoreMarketingProviderReconciliation({ id, reason: body.reason });
        return reply.send({ ok: true });
      } catch (error) {
        if (error instanceof Error && error.message === 'RECONCILIATION_NOT_FOUND') {
          return reply.status(404).send({ error: 'RECONCILIATION_NOT_FOUND' });
        }
        if (error instanceof Error && error.message === 'RECONCILIATION_REASON_REQUIRED') {
          return reply.status(400).send({ error: 'RECONCILIATION_REASON_REQUIRED' });
        }
        throw error;
      }
    },
  );
}
