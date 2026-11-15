import { createHash, timingSafeEqual } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { RATE_LIMIT_PROVIDER_WEBHOOK } from '../../plugins/rate-limit.policy';
import { normalizeBrevoSmsEvent, storeBrevoSmsStatus } from '../../shared/brevo/sms-client';
import { redisQueue } from '../../shared/redis/client';
import { applyMarketingProviderEvent } from '../marketing/marketing-provider.service';

const BrevoSmsEventSchema = z
  .object({
    messageId: z.union([z.number(), z.string()]).optional(),
    msg_status: z.string().optional(),
    error_code: z.union([z.number(), z.string()]).optional(),
  })
  .passthrough();

// Brevo peut regrouper ses événements : un objet seul ou un tableau.
const BrevoSmsEventsBodySchema = z.union([
  BrevoSmsEventSchema,
  z.array(BrevoSmsEventSchema).max(500),
]);

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/** Brevo ne signe pas ses webhooks : secret dans l'URL, comparé à temps constant. */
export function isValidBrevoWebhookToken(provided: unknown, expected: string | undefined): boolean {
  if (!expected?.trim() || typeof provided !== 'string' || !provided) return false;
  return timingSafeEqual(digest(provided), digest(expected.trim()));
}

/**
 * Événements de livraison des SMS Brevo (`webUrl` de chaque envoi). Ramenés aux statuts
 * existants (sent, delivered, delivery_failed) ; le numéro et le texte d'une réponse ne sont jamais journalisés.
 */
export async function brevoSmsEventRoutes(app: FastifyInstance) {
  app.post(
    '/sms/brevo/events',
    { config: { rateLimit: RATE_LIMIT_PROVIDER_WEBHOOK } },
    async (req, reply) => {
      const expected = process.env.BREVO_SMS_WEBHOOK_SECRET;
      if (!expected?.trim()) return reply.status(503).send({ error: 'NOT_CONFIGURED' });
      const token = (req.query as Record<string, unknown> | undefined)?.token;
      if (!isValidBrevoWebhookToken(token, expected)) {
        return reply.status(401).send({ error: 'UNAUTHORIZED' });
      }

      const parsed = BrevoSmsEventsBodySchema.safeParse(req.body);
      if (!parsed.success) return reply.status(400).send({ result: 'ignored' });
      const events = Array.isArray(parsed.data) ? parsed.data : [parsed.data];

      let applied = 0;
      for (const event of events) {
        const messageId = event.messageId === undefined ? '' : String(event.messageId).trim();
        const status = normalizeBrevoSmsEvent(event.msg_status);
        // `skip` arrive avec messageId 0 : rien à rattacher.
        if (!status || !messageId || messageId === '0') continue;
        if (!(await storeBrevoSmsStatus(redisQueue, messageId, status))) continue;
        applied++;
        await applyMarketingProviderEvent({
          provider: 'brevo',
          providerMessageId: messageId,
          eventType: `sms.${event.msg_status}`,
          providerStatus: status,
          ...(status === 'delivery_failed'
            ? { errorCode: `BREVO_${String(event.error_code ?? event.msg_status)}` }
            : {}),
        });
        const log =
          status === 'delivery_failed' ? req.log.warn.bind(req.log) : req.log.info.bind(req.log);
        log({ messageId, status, providerStatus: event.msg_status }, `Brevo SMS ${status}`);
      }
      return reply.send({ result: 'ok', applied });
    },
  );
}
