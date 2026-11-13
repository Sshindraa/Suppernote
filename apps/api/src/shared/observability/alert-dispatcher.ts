/**
 * Dispatcher d'alertes ops — envoie réellement les alertes aux humains.
 *
 * Canaux (tous optionnels, configurés par env) :
 *   - logs Pino + Sentry    : toujours actifs (Sentry no-op si SENTRY_DSN absent)
 *   - ALERT_EMAIL_TO        : email(s) via le transport Resend existant (virgules)
 *   - ALERT_WEBHOOK_URL     : webhook Slack/Discord ({ "text": "..." })
 *   - ALERT_SMS_TO          : SMS Telnyx — réservé aux alertes critiques
 *
 * Garanties :
 *   - Ne throw jamais : un canal en panne ne doit pas casser le worker de
 *     monitoring (chaque envoi est isolé dans son try/catch).
 *   - Chaque tentative est comptée dans suppernote_alerts_sent_total{kind,channel,result}
 *     pour détecter un canal silencieusement cassé.
 */

import { sendEmail } from '../email';
import { sendSms } from '../telnyx/client';
import { captureMessage } from '../sentry/client';
import { logger } from '../logger/pino';
import { alertsSentTotal } from './metrics';

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertPayload {
  /** Identifiant stable de l'alerte (ex: 'calls_without_transcript'). */
  kind: string;
  severity: AlertSeverity;
  /** Une ligne, en français, actionnable. */
  summary: string;
  /** Détails multi-lignes : compteurs, échantillons, pistes de diagnostic. */
  detail: string;
  /**
   * Override SMS : true = envoyer un SMS même en warning,
   * false = ne jamais envoyer de SMS pour cette alerte.
   * Défaut : SMS uniquement si severity === 'critical'.
   */
  sms?: boolean;
  /** Email can be grouped separately while retaining the other incident channels. */
  email?: boolean;
}

export interface ChannelResult {
  channel: 'sentry' | 'email' | 'webhook' | 'sms';
  ok: boolean;
  error?: string;
}

/** Échappe le HTML pour le corps email. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function track(kind: string, channel: ChannelResult['channel'], ok: boolean): void {
  try {
    alertsSentTotal.inc({ kind, channel, result: ok ? 'ok' : 'error' });
  } catch {
    // La métrique ne doit jamais casser le dispatch.
  }
}

async function tryEmail(payload: AlertPayload, recipients: string): Promise<ChannelResult> {
  try {
    const subject = `[Suppernote ${payload.severity.toUpperCase()}] ${payload.summary}`;
    const html = [
      `<p><strong>${escapeHtml(payload.summary)}</strong></p>`,
      `<pre style="font-family:monospace;white-space:pre-wrap">${escapeHtml(payload.detail)}</pre>`,
      `<p style="color:#666;font-size:12px">Alerte ${payload.kind} — monitoring Suppernote</p>`,
    ].join('');
    const result = await sendEmail({ to: recipients, subject, html });
    if (result?.outcome !== 'success') {
      return { channel: 'email', ok: false, error: 'Email non accepté par le transport' };
    }
    return { channel: 'email', ok: true };
  } catch (err) {
    return { channel: 'email', ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function dispatchAlertEmail(
  payload: AlertPayload,
): Promise<ChannelResult | undefined> {
  const recipients = process.env.ALERT_EMAIL_TO;
  if (!recipients) return undefined;
  const result = await tryEmail(payload, recipients);
  track(payload.kind, 'email', result.ok);
  if (!result.ok) logger.error({ alert: payload.kind }, 'Grouped alert email was not accepted');
  return result;
}

async function tryWebhook(payload: AlertPayload, url: string): Promise<ChannelResult> {
  try {
    const icon =
      payload.severity === 'critical' ? '🚨' : payload.severity === 'warning' ? '⚠️' : 'ℹ️';
    const text = `${icon} [Suppernote ${payload.severity.toUpperCase()}] ${payload.summary}\n${payload.detail}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { channel: 'webhook', ok: false, error: `HTTP ${res.status}` };
      }
    } finally {
      clearTimeout(timeout);
    }
    return { channel: 'webhook', ok: true };
  } catch (err) {
    return {
      channel: 'webhook',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function trySms(payload: AlertPayload, to: string): Promise<ChannelResult> {
  try {
    // SMS : message court, sans le détail complet (coût + lisibilité).
    const text = `[Suppernote ${payload.severity.toUpperCase()}] ${payload.summary}`.slice(0, 300);
    await sendSms(to, text);
    return { channel: 'sms', ok: true };
  } catch (err) {
    return { channel: 'sms', ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Envoie une alerte sur tous les canaux configurés.
 * Retourne le résultat par canal (pour les tests et le logging du worker).
 */
export async function dispatchAlert(payload: AlertPayload): Promise<ChannelResult[]> {
  // 1. Logs + Sentry — toujours.
  const logContext = { alert: payload.kind, severity: payload.severity, detail: payload.detail };
  if (payload.severity === 'info') logger.info(logContext, payload.summary);
  else logger.error(logContext, payload.summary);
  captureMessage(
    `[${payload.severity}] ${payload.summary}`,
    payload.severity === 'critical' ? 'error' : payload.severity,
    {
      tags: { alert: payload.kind },
      extra: { detail: payload.detail },
    },
  );
  track(payload.kind, 'sentry', true);

  const results: ChannelResult[] = [];

  // 2. Webhook Slack/Discord.
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (webhookUrl) {
    const result = await tryWebhook(payload, webhookUrl);
    track(payload.kind, 'webhook', result.ok);
    results.push(result);
  }

  // 3. Email Resend (destinataires séparés par des virgules).
  const emailTo = process.env.ALERT_EMAIL_TO;
  if (emailTo && payload.email !== false) {
    const result = await tryEmail(payload, emailTo);
    track(payload.kind, 'email', result.ok);
    results.push(result);
  }

  // 4. SMS — critiques uniquement par défaut.
  const smsTo = process.env.ALERT_SMS_TO;
  const wantsSms = payload.sms ?? payload.severity === 'critical';
  if (smsTo && wantsSms) {
    const result = await trySms(payload, smsTo);
    track(payload.kind, 'sms', result.ok);
    results.push(result);
  }

  if (results.length === 0 && !(emailTo && payload.email === false)) {
    logger.warn(
      { alert: payload.kind },
      "Aucun canal d'alerte configuré (ALERT_EMAIL_TO / ALERT_WEBHOOK_URL / ALERT_SMS_TO) — alerte limitée aux logs et Sentry",
    );
  }

  const failures = results.filter((r) => !r.ok);
  if (failures.length > 0) {
    logger.error({ alert: payload.kind, failures }, "Un ou plusieurs canaux d'alerte ont échoué");
  }

  return results;
}
