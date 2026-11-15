const createTelnyx: (key: string) => import('telnyx').TelnyxClient = require('telnyx');
import * as https from 'https';
import { sanitizeSmsProviderError } from './sms-error';
import {
  extractProviderMessageId,
  type NotificationProviderResult,
  type NotificationSendResult,
} from '../queue/notification-idempotency';
import {
  recordAcceptedMessagingUsage,
  type MessagingUsageContext,
} from '../../modules/usage/messaging-usage.service';
import { getSmsProvider, sendBrevoSms } from '../brevo/sms-client';

// Agent keep-alive persistant pour le SDK Telnyx (balance, SMS, WhatsApp, outbound calls).
// Évite le handshake TLS (~113ms) à chaque appel en réutilisant la connexion.
const telnyxHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30_000,
  maxSockets: 20,
  maxFreeSockets: 10,
  timeout: 60_000,
});

type TelnyxClient = import('telnyx').TelnyxClient;

let _telnyx: TelnyxClient | null = null;

function getTelnyx(): TelnyxClient {
  if (!_telnyx) {
    if (!process.env.TELNYX_API_KEY) {
      throw new Error('TELNYX_API_KEY is required');
    }
    _telnyx = createTelnyx(process.env.TELNYX_API_KEY);
    (_telnyx as unknown as { setHttpAgent: (a: https.Agent) => void }).setHttpAgent(
      telnyxHttpsAgent,
    );
  }
  return _telnyx;
}

const telnyx = new Proxy({} as TelnyxClient, {
  get(_, prop: string | symbol) {
    return (getTelnyx() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

export default telnyx;

/**
 * Expéditeur des SMS. `TELNYX_SMS_FROM` accepte un numéro rattaché à un profil de messagerie ou un
 * identifiant alphanumérique (« SUPPERNOTE », envoi sans réponse possible) ; à défaut, le numéro d'appel.
 * Un numéro fixe sans profil de messagerie ne peut pas envoyer de SMS : c'est l'état constaté en
 * production le 17/10/2026, d'où cette variable distincte de `TELNYX_FROM_NUMBER`.
 */
export function smsSender(environment: NodeJS.ProcessEnv = process.env): string {
  const from = environment.TELNYX_SMS_FROM?.trim() || environment.TELNYX_FROM_NUMBER?.trim();
  if (!from) throw new Error('TELNYX_SMS_FROM or TELNYX_FROM_NUMBER is required for SMS');
  return from;
}

export async function sendSms(
  to: string,
  text: string,
  usage?: MessagingUsageContext,
): Promise<void | NotificationSendResult> {
  // Choix global (`SMS_PROVIDER`), jamais par restaurant : les appelants gardent `sendSms`.
  if (getSmsProvider() === 'brevo') return sendBrevoSms(to, text, usage);
  const t = getTelnyx();
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const response = await t.messages
    .create({
      from: smsSender(),
      to,
      text,
      ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
      ...(process.env.TELNYX_SMS_WEBHOOK_URL
        ? { webhook_url: process.env.TELNYX_SMS_WEBHOOK_URL, use_profile_webhooks: false }
        : {}),
    })
    .catch((error: unknown) => {
      throw sanitizeSmsProviderError(error);
    });
  const result = normalizeTelnyxSendResponse(response, 'sms');
  if (usage && result.outcome === 'success') {
    await recordAcceptedMessagingUsage({
      channel: 'sms',
      provider: 'telnyx',
      text,
      providerMessageId: result.providerMessageId,
      context: usage,
    });
  }
  return result;
}

/**
 * Envoie un message WhatsApp texte simple via Telnyx Messaging API.
 *
 * Utilise le même endpoint messages.create que sendSms, avec type: 'whatsapp'
 * pour forcer le routage via WhatsApp Business (au lieu de SMS).
 *
 * Le numéro `from` doit être WhatsApp-enabled (embedded signup Telnyx).
 * Si TELNYX_WHATSAPP_FROM n'est pas défini, on fallback sur TELNYX_FROM_NUMBER.
 *
 * @param to  Numéro du destinataire (E.164, ex: +33612345678)
 * @param text Contenu du message texte
 */
export async function sendWhatsApp(
  to: string,
  text: string,
  usage?: MessagingUsageContext,
): Promise<void | NotificationSendResult> {
  const t = getTelnyx();
  const from = process.env.TELNYX_WHATSAPP_FROM ?? process.env.TELNYX_FROM_NUMBER;
  if (!from) {
    throw new Error('TELNYX_WHATSAPP_FROM or TELNYX_FROM_NUMBER is required for WhatsApp');
  }
  const messagingProfileId = process.env.TELNYX_MESSAGING_PROFILE_ID;
  const response = await t.messages.create({
    from,
    to,
    text,
    // Le SDK Telnyx ne type pas `type` pour messages.create, mais l'API REST
    // accepte type: 'whatsapp' pour router via WhatsApp Business.
    ...({ type: 'whatsapp' } as Record<string, string>),
    ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {}),
  });
  const result = normalizeTelnyxSendResponse(response, 'whatsapp');
  if (usage && result.outcome === 'success') {
    await recordAcceptedMessagingUsage({
      channel: 'whatsapp',
      provider: 'telnyx',
      text,
      providerMessageId: result.providerMessageId,
      context: usage,
    });
  }
  return result;
}

type TelnyxMessageDeliveryStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'expired'
  | 'sending_failed'
  | 'delivery_unconfirmed'
  | 'delivered'
  | 'delivery_failed';

export function normalizeTelnyxSendResponse(
  response: unknown,
  channel: 'sms' | 'whatsapp' = 'sms',
): NotificationSendResult {
  const providerMessageId = extractProviderMessageId(response)?.trim() || undefined;
  return {
    outcome: providerMessageId ? 'success' : 'unknown',
    provider: 'telnyx',
    channel,
    ...(providerMessageId ? { providerMessageId } : {}),
  };
}

function extractTelnyxMessageStatus(response: unknown): TelnyxMessageDeliveryStatus | undefined {
  const root =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const payload =
    root?.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;
  const recipients = payload?.to;
  if (!Array.isArray(recipients) || !recipients[0] || typeof recipients[0] !== 'object') {
    return undefined;
  }
  const status = (recipients[0] as Record<string, unknown>).status;
  return typeof status === 'string' ? (status as TelnyxMessageDeliveryStatus) : undefined;
}

export function classifyTelnyxMessageResponse(response: unknown): NotificationProviderResult {
  const status = extractTelnyxMessageStatus(response);
  if (status === 'sending_failed' || status === 'expired') return 'failure_certain';
  if (
    status === 'queued' ||
    status === 'sending' ||
    status === 'sent' ||
    status === 'delivered' ||
    status === 'delivery_failed'
  ) {
    // The claim protects the accepted provider request, not final handset
    // delivery. A delivery failure must not trigger a blind duplicate.
    return 'success';
  }
  return 'unknown';
}

/**
 * Queries a Telnyx message without exposing the provider response to callers.
 * A retrieval error is deliberately unknown: a failed lookup is not proof
 * that the original message was not accepted.
 */
export async function lookupTelnyxMessage(
  providerMessageId: string,
): Promise<NotificationProviderResult> {
  try {
    const response = await getTelnyx().messages.retrieve(providerMessageId);
    return classifyTelnyxMessageResponse(response);
  } catch {
    return 'unknown';
  }
}

export interface OutboundCallOptions {
  webhookUrl: string;
  clientState?: Record<string, unknown>;
  connectionId?: string;
  timeoutSecs?: number;
}

export interface OutboundCallResult {
  callControlId: string;
}

export type OutboundCallRequest = Parameters<TelnyxClient['calls']['create']>[0];

/**
 * Paramètres de création d'un appel sortant. Telnyx exige une application d'appel (`connection_id`) : à défaut
 * de le transmettre, on prend `TELNYX_CONNECTION_ID`, puis on refuse explicitement plutôt que d'envoyer un
 * appel que Telnyx rejetterait sans message clair.
 */
export function buildOutboundCallParams(
  to: string,
  options: OutboundCallOptions,
): OutboundCallRequest {
  const from = process.env.TELNYX_FROM_NUMBER;
  if (!from) {
    throw new Error('TELNYX_FROM_NUMBER is required for outbound calls');
  }
  const connectionId = options.connectionId ?? process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    throw new Error('TELNYX_CONNECTION_ID is required for outbound calls');
  }

  return {
    to,
    from,
    connection_id: connectionId,
    webhook_url: options.webhookUrl,
    webhook_url_method: 'POST',
    client_state: options.clientState
      ? Buffer.from(JSON.stringify(options.clientState)).toString('base64')
      : undefined,
    timeout: options.timeoutSecs ?? 30,
  };
}

export async function placeOutboundCall(
  to: string,
  options: OutboundCallOptions,
): Promise<OutboundCallResult> {
  const t = getTelnyx();
  const response = await t.calls.create(buildOutboundCallParams(to, options));

  const callControlId = response?.data?.call_control_id ?? response?.call_control_id;
  if (!callControlId) {
    throw new Error('Telnyx outbound call: missing call_control_id in response');
  }
  return { callControlId };
}
