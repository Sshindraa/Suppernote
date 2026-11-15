import { createHash } from 'node:crypto';
import type {
  NotificationProviderResult,
  NotificationSendResult,
} from '../queue/notification-idempotency';
import {
  recordAcceptedMessagingUsage,
  type MessagingUsageContext,
} from '../../modules/usage/messaging-usage.service';

const BREVO_SMS_URL = 'https://api.brevo.com/v3/transactionalSMS/send';
const BREVO_TIMEOUT_MS = 10_000;
const DEFAULT_SENDER = 'Suppernote';

/** Fournisseur global des SMS ; Telnyx tant que l'expéditeur Brevo n'est pas validé. */
export function getSmsProvider(environment: NodeJS.ProcessEnv = process.env): 'telnyx' | 'brevo' {
  return environment.SMS_PROVIDER?.trim().toLowerCase() === 'brevo' ? 'brevo' : 'telnyx';
}

/** URL déclarée à Brevo par message (`webUrl`) ; absente sans secret, pour ne jamais exposer une route ouverte. */
export function brevoSmsWebhookUrl(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = environment.BREVO_SMS_WEBHOOK_SECRET?.trim();
  if (!secret) return undefined;
  const base = (environment.PUBLIC_API_URL?.trim() || 'https://api.suppernote.com').replace(
    /\/+$/,
    '',
  );
  return `${base}/sms/brevo/events?token=${encodeURIComponent(secret)}`;
}

/** Erreur sans corps de réponse ni clé ; `notificationResult` pilote relance et idempotence. */
function brevoError(
  message: string,
  notificationResult: NotificationProviderResult,
  statusCode?: number,
) {
  return Object.assign(new Error(message), {
    name: 'BrevoSmsSendError',
    ...(statusCode ? { statusCode } : {}),
    notificationResult,
  });
}

function describeStatus(status: number): string {
  switch (status) {
    case 400:
      return 'requete refusee';
    case 401:
      return 'cle API refusee';
    case 402:
      return 'credits SMS insuffisants';
    case 403:
      return 'droit insuffisant';
    case 429:
      return 'limite de debit atteinte';
    default:
      return status >= 500 ? 'erreur Brevo' : 'refus Brevo';
  }
}

/**
 * Même contrat que `sendSms` Telnyx. Un 4xx est un refus certain (rien n'est parti, relance possible) ;
 * un 5xx ou un timeout est inconnu (le message a peut-être été accepté : jamais de renvoi aveugle).
 */
export async function sendBrevoSms(
  to: string,
  text: string,
  usage?: MessagingUsageContext,
  fetchImpl: typeof fetch = fetch,
): Promise<NotificationSendResult> {
  const apiKey = process.env.BREVO_API_KEY?.trim();
  if (!apiKey) throw brevoError('BREVO_API_KEY is required for SMS', 'failure_certain');
  const recipient = to.replace(/\D/g, '');
  if (recipient.length < 8) throw brevoError('Brevo SMS: invalid recipient', 'failure_certain');
  const webUrl = brevoSmsWebhookUrl();

  let response: Response;
  try {
    response = await fetchImpl(BREVO_SMS_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: process.env.BREVO_SMS_SENDER?.trim() || DEFAULT_SENDER,
        recipient,
        content: text,
        type: 'transactional',
        tag: 'suppernote',
        ...(webUrl ? { webUrl } : {}),
        // Les textes sont écrits en GSM-7 (PR #727) ; l'Unicode diviserait la taille d'un segment.
        unicodeEnabled: false,
      }),
      signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw brevoError(
      timeout ? 'Brevo SMS send timed out' : 'Brevo SMS send failed (network)',
      'unknown',
    );
  }

  if (!response.ok) {
    const status = response.status;
    throw brevoError(
      `Brevo SMS send failed (HTTP ${status}, ${describeStatus(status)})`,
      status >= 500 || status === 408 ? 'unknown' : 'failure_certain',
      status,
    );
  }

  const body = (await response.json().catch(() => null)) as { messageId?: unknown } | null;
  const rawId = body?.messageId;
  const providerMessageId =
    typeof rawId === 'number' || (typeof rawId === 'string' && rawId.trim())
      ? String(rawId).trim()
      : undefined;
  const result: NotificationSendResult = {
    outcome: providerMessageId ? 'success' : 'unknown',
    provider: 'brevo',
    channel: 'sms',
    ...(providerMessageId ? { providerMessageId } : {}),
  };
  if (usage && result.outcome === 'success') {
    await recordAcceptedMessagingUsage({
      channel: 'sms',
      provider: 'brevo',
      text,
      providerMessageId,
      context: usage,
    });
  }
  return result;
}

/** Statuts de livraison ramenés à ceux déjà suivis pour Telnyx. */
export type BrevoSmsDeliveryStatus = 'sent' | 'delivered' | 'delivery_failed';

export function normalizeBrevoSmsEvent(
  msgStatus: string | undefined,
): BrevoSmsDeliveryStatus | null {
  switch (msgStatus?.trim().toLowerCase()) {
    case 'sent':
    case 'accepted':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'soft_bounce':
    case 'hard_bounce':
    case 'rej':
    case 'rejected':
    case 'bl':
    case 'blocked':
    case 'blacklisted':
    case 'skip':
      return 'delivery_failed';
    default:
      // replied, subscribe, unsubscribed : pas un statut de livraison.
      return null;
  }
}

export interface BrevoStatusStore {
  eval: (script: string, numberOfKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  get(key: string): Promise<string | null>;
}

const RANK: Record<BrevoSmsDeliveryStatus, number> = { sent: 1, delivery_failed: 2, delivered: 3 };
const TTL_SECONDS = 7 * 24 * 60 * 60;
// Un échec tardif n'efface jamais un « delivered » ; un doublon ne change rien (idempotent).
// Retourne 1 si le statut a avancé, 0 sinon.
const STORE_STATUS = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local incoming = tonumber(ARGV[1])
if incoming > current then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  return 1
end
return 0
`;

function statusKey(messageId: string): string {
  return `sms:brevo:status:${createHash('sha256').update(messageId).digest('hex')}`;
}

export async function storeBrevoSmsStatus(
  store: BrevoStatusStore,
  messageId: string,
  status: BrevoSmsDeliveryStatus,
): Promise<boolean> {
  return (await store.eval(STORE_STATUS, 1, statusKey(messageId), RANK[status], TTL_SECONDS)) === 1;
}

/**
 * Brevo n'a pas de lecture d'un message par identifiant : on lit le dernier statut reçu par webhook.
 * Un échec de livraison n'est pas un refus certain d'envoi : il reste en relecture, jamais renvoyé.
 */
export async function lookupBrevoSms(
  store: BrevoStatusStore,
  messageId: string,
): Promise<NotificationProviderResult> {
  try {
    const rank = await store.get(statusKey(messageId));
    return rank === '1' || rank === '3' ? 'success' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Les identifiants Brevo sont numériques, ceux de Telnyx des UUID. */
export function isBrevoMessageId(messageId: string): boolean {
  return /^\d+$/.test(messageId.trim());
}
