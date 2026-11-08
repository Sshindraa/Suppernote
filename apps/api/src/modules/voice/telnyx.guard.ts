import { FastifyRequest, FastifyReply } from 'fastify';
import { telnyxWebhookEventsTotal } from '../../shared/observability/metrics';
import { recordWebhookOutcome } from '../../shared/observability/webhook-health';

function _toBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function fromBase64(str: string): Uint8Array {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}

/** Label borné pour la métrique webhook, dérivé de l'URL de la route. */
export function webhookEventLabel(url: string | undefined): string {
  if (!url) return 'other';
  if (url.startsWith('/voice/telnyx/end')) return 'voice_end';
  if (url.startsWith('/voice/telnyx')) return 'voice';
  if (url.startsWith('/sms/')) return 'sms';
  if (url.startsWith('/whatsapp/')) return 'whatsapp';
  return 'other';
}

/** Compte un webhook rejeté par le guard (signature absente ou invalide). */
function trackRejected(req: FastifyRequest): void {
  try {
    telnyxWebhookEventsTotal.inc({ event: webhookEventLabel(req.url), result: 'rejected' });
    recordWebhookOutcome('rejected');
  } catch {
    // La métrique ne doit jamais casser le guard.
  }
}

export async function telnyxWebhookGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const signature = req.headers['telnyx-signature-ed25519'] as string | undefined;
  const timestamp = req.headers['telnyx-timestamp'] as string | undefined;
  if (!signature || !timestamp) {
    req.log.warn({ headers: Object.keys(req.headers) }, 'telnyx-guard: missing headers');
    trackRejected(req);
    reply.status(403).send({ error: 'Forbidden' });
    return;
  }
  try {
    const { default: telnyx } = await import('telnyx');
    // Use the raw body string (preserved by addContentTypeParser) to verify
    // the signature. Re-serializing JSON.stringify(req.body) can change key
    // order and break the Ed25519 signature check.
    const rawBody = req.rawBody as string | undefined;
    if (!rawBody) {
      throw new Error('rawBody not available — content-type parser not configured?');
    }
    telnyx.webhooks.constructEvent(
      rawBody,
      fromBase64(signature),
      timestamp,
      fromBase64(process.env.TELNYX_PUBLIC_KEY!),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errName = err instanceof Error ? err.constructor.name : undefined;
    const errStack =
      err instanceof Error ? err.stack?.split('\n').slice(0, 3).join(' | ') : undefined;
    req.log.error(
      {
        err: message,
        errType: errName,
        errStack,
        signatureLen: signature.length,
        timestamp,
        publicKeyLen: process.env.TELNYX_PUBLIC_KEY?.length,
      },
      'telnyx-guard: signature verification failed',
    );
    trackRejected(req);
    reply.status(403).send({ error: 'Forbidden' });
    return;
  }
}
