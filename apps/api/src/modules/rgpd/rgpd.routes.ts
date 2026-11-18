/**
 * Routes RGPD : right-to-erasure, data-export, privacy-policy,
 * identity-verification (OTP SMS / lien signé email).
 *
 * Architecture sécurité (Phase 7+ — levée du stop P0) :
 *   - POST /api/rgpd/request-verification : envoie OTP ou lien signé
 *   - POST /api/rgpd/confirm-verification : valide OTP/lien, renvoie verificationToken
 *   - GET  /api/rgpd/confirm-link        : équivalent GET pour les liens email
 *   - POST /api/rgpd/erase               : REQUIERT verificationToken (header)
 *   - POST /api/rgpd/export              : REQUIERT verificationToken (header)
 *   - POST /api/rgpd/withdraw-marketing  : REQUIERT verificationToken (header)
 *   - GET  /api/rgpd/privacy-policy      : public
 *
 * Le verificationToken est un one-shot à 10 min, lié au (subject, intent).
 * Anti-rejeu : on vérifie que `subject` du token = `subject` du payload.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ErasureService, ErasureSubjectNotFoundError } from './erasure.service';
import { ExportService, ExportSubjectNotFoundError } from './export.service';
import { withdrawSubjectMarketing } from './marketing-withdrawal.service';
import { PRIVACY_POLICY_TEXT, PRIVACY_POLICY_SUMMARY } from './privacy-policy';
import {
  IdentityVerificationService,
  IdentityVerificationError,
} from './identity-verification.service';
import { logger } from '../../shared/logger/pino';
import { db } from '../../shared/db/client';
import { redisCache } from '../../shared/redis/client';
import {
  rgpdRateLimit,
  RATE_LIMIT_CONFIRM_LINK_MAX,
  RATE_LIMIT_CONFIRM_VERIFICATION_MAX,
  RATE_LIMIT_ERASE_MAX,
  RATE_LIMIT_EXPORT_MAX,
  RATE_LIMIT_REQUEST_VERIFICATION_MAX,
  RATE_LIMIT_WITHDRAW_MARKETING_MAX,
} from './constants';

const RequestVerificationSchema = z.object({
  subject: z.string().min(8).max(254),
  intent: z.enum(['erase', 'export']),
  email: z.string().email().optional(),
  captchaToken: z.string().optional(),
});

const ConfirmVerificationSchema = z.object({
  subject: z.string().min(8).max(254),
  intent: z.enum(['erase', 'export']),
  code: z.string().length(6).optional(),
  token: z.string().min(10).optional(),
});

const EraseSchema = z.object({
  subject: z.string().min(8).max(254),
  reason: z.string().max(500).optional(),
});

const ExportSchema = z.object({
  subject: z.string().min(8).max(254),
});

export async function rgpdRoutes(app: FastifyInstance): Promise<void> {
  const erasureService = new ErasureService(db);
  const exportService = new ExportService(db);
  const verificationService = new IdentityVerificationService(db, redisCache);

  // ─── 1. Demande de vérification d'identité ──────────────

  app.post(
    '/api/rgpd/request-verification',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_REQUEST_VERIFICATION_MAX) } },
    async (req, reply) => {
      const parse = RequestVerificationSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parse.error.format() });
      }
      try {
        const result = await verificationService.requestVerification({
          ...parse.data,
          ip: req.ip,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          const status = err.code === 'RATE_LIMITED' ? 429 : 400;
          return reply.status(status).send({ code: err.code, error: err.message });
        }
        logger.error(
          { err: err instanceof Error ? { message: err.message, stack: err.stack } : err },
          'request-verification failed',
        );
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 2. Confirmation (OTP ou token) ──────────────────────

  app.post(
    '/api/rgpd/confirm-verification',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_CONFIRM_VERIFICATION_MAX) } },
    async (req, reply) => {
      const parse = ConfirmVerificationSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parse.error.format() });
      }
      try {
        const result = await verificationService.confirmVerification(parse.data);
        return reply.send(result);
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          const status =
            err.code === 'RATE_LIMITED'
              ? 429
              : err.code === 'NOT_FOUND' || err.code === 'EXPIRED'
                ? 410
                : 400;
          return reply.status(status).send({ code: err.code, error: err.message });
        }
        logger.error({ err }, 'confirm-verification failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 3. Confirmation via lien email (GET) ───────────────
  // Le lien email contient UNIQUEMENT le token. Le subject est lu depuis
  // le token signé (anti-confusion : on ne peut pas confirmer le token
  // de Bob en prétendant être Alice). Le token est one-shot (jti tracké).

  app.get(
    '/api/rgpd/confirm-link',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_CONFIRM_LINK_MAX) } },
    async (req, reply) => {
      const q = req.query as { token?: string };
      if (!q.token) {
        return reply
          .status(400)
          .type('text/html')
          .send('<html><body><h1>❌ Paramètres manquants</h1><p>token requis.</p></body></html>');
      }
      try {
        const confirmed = await verificationService.confirmSignedLinkToken(q.token);
        const verificationToken = escapeHtml(confirmed.verificationToken);
        const intent = escapeHtml(confirmed.intent);
        const subject = escapeHtml(confirmed.subject);
        return reply.type('text/html').send(
          `<html><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:20px">
          <h1>✅ Vérification confirmée</h1>
          <p>Votre identité a été vérifiée. Voici votre token à usage unique (valide 10 min) :</p>
          <pre style="background:#f4f4f4;padding:12px;border-radius:4px;word-break:break-all">${verificationToken}</pre>
          <p><strong>Action suivante :</strong> utilisez ce token dans le header <code>X-Identity-Token</code> pour appeler <code>POST /api/rgpd/${intent}</code> avec le subject <code>${subject}</code>.</p>
        </body></html>`,
        );
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          return reply
            .status(400)
            .type('text/html')
            .send(`<html><body><h1>❌ ${err.code}</h1><p>${err.message}</p></body></html>`);
        }
        logger.error({ err }, 'confirm-link failed');
        return reply
          .status(500)
          .type('text/html')
          .send('<html><body><h1>Internal error</h1></body></html>');
      }
    },
  );

  // ─── 4. Helper : extrait + vérifie le token du header ───

  async function requireVerifiedIdentity(
    req: FastifyRequest,
    reply: FastifyReply,
    expectedIntent: 'erase' | 'export' | 'withdraw_marketing',
  ): Promise<{ subject: string; jti?: string } | null> {
    const token = req.headers['x-identity-token'];
    if (!token || typeof token !== 'string') {
      reply.status(401).send({
        code: 'IDENTITY_REQUIRED',
        error: 'X-Identity-Token header required. Call /api/rgpd/request-verification first.',
      });
      return null;
    }
    try {
      return await verificationService.verifyVerificationToken(
        token,
        expectedIntent === 'withdraw_marketing' ? 'export' : expectedIntent,
        expectedIntent === 'erase',
      );
    } catch (err) {
      if (err instanceof IdentityVerificationError) {
        reply.status(401).send({ code: err.code, error: err.message });
        return null;
      }
      throw err;
    }
  }

  // ─── 5. Erase (REQUIERT identité vérifiée) ──────────────

  app.post(
    '/api/rgpd/erase',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_ERASE_MAX) } },
    async (req, reply) => {
      const parse = EraseSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parse.error.format() });
      }
      const verified = await requireVerifiedIdentity(req, reply, 'erase');
      if (!verified) return;
      if (!verified.jti) {
        return reply
          .status(401)
          .send({ code: 'IDENTITY_REQUIRED', error: 'Invalid erasure token' });
      }
      if (verified.subject !== parse.data.subject) {
        return reply.status(403).send({
          code: 'SUBJECT_MISMATCH',
          error: 'Verified identity does not match the subject in the payload',
        });
      }
      try {
        const result = await erasureService.eraseSubject({
          subject: parse.data.subject,
          reason: parse.data.reason ?? 'user_request',
          actor: 'rgpd:user',
          verificationJti: verified.jti,
        });
        return reply.send({
          ok: true,
          anonymized: {
            reservations: result.reservationsAnonymized,
            calls: result.callsAnonymized,
            consentsRetained: result.consentsRetained,
          },
          erasedAt: result.erasedAt.toISOString(),
        });
      } catch (err) {
        if (err instanceof IdentityVerificationError) {
          return reply.status(401).send({ code: err.code, error: err.message });
        }
        if (err instanceof ErasureSubjectNotFoundError) {
          return reply.status(404).send({ code: 'SUBJECT_NOT_FOUND', error: err.message });
        }
        // Transaction annulée (jeton compris) : la même demande peut être rejouée.
        if (err instanceof Error && err.message === 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE') {
          return reply.status(503).send({
            code: 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE',
            error: 'Opposition register unavailable, retry the request',
          });
        }
        // Nom d'erreur seulement : le message Prisma peut contenir le numéro du sujet.
        logger.error({ err: err instanceof Error ? err.name : 'unknown' }, 'rgpd erase failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 6. Export (REQUIERT identité vérifiée) ─────────────

  app.post(
    '/api/rgpd/export',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_EXPORT_MAX) } },
    async (req, reply) => {
      const parse = ExportSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parse.error.format() });
      }
      const verified = await requireVerifiedIdentity(req, reply, 'export');
      if (!verified) return;
      if (verified.subject !== parse.data.subject) {
        return reply.status(403).send({
          code: 'SUBJECT_MISMATCH',
          error: 'Verified identity does not match the subject in the payload',
        });
      }
      try {
        const result = await exportService.exportSubject({ subject: parse.data.subject });
        return reply.send(result);
      } catch (err) {
        if (err instanceof ExportSubjectNotFoundError) {
          return reply.status(404).send({ code: 'SUBJECT_NOT_FOUND', error: err.message });
        }
        logger.error({ err }, 'rgpd export failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 7. Withdraw marketing (REQUIERT identité) ──────────

  app.post(
    '/api/rgpd/withdraw-marketing',
    { config: { rateLimit: rgpdRateLimit(RATE_LIMIT_WITHDRAW_MARKETING_MAX) } },
    async (req, reply) => {
      const parse = ExportSchema.safeParse(req.body);
      if (!parse.success) {
        return reply.status(400).send({ error: 'Invalid payload', details: parse.error.format() });
      }
      const verified = await requireVerifiedIdentity(req, reply, 'withdraw_marketing');
      if (!verified) return;
      if (verified.subject !== parse.data.subject) {
        return reply.status(403).send({
          code: 'SUBJECT_MISMATCH',
          error: 'Verified identity does not match the subject in the payload',
        });
      }
      try {
        const result = await withdrawSubjectMarketing({ prisma: db, subject: parse.data.subject });
        return reply.send({
          ok: true,
          updated: result.consentsWithdrawn,
          customersWithdrawn: result.customersWithdrawn,
        });
      } catch (err) {
        // Registre d'opposition indisponible : rien n'est validé côté personne, la requête peut être rejouée.
        if (err instanceof Error && err.message === 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE') {
          return reply.status(503).send({
            code: 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE',
            error: 'Opposition register unavailable, retry the request',
          });
        }
        logger.error({ err: err instanceof Error ? err.name : 'unknown' }, 'rgpd withdraw failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );

  // ─── 8. Privacy policy (public) ─────────────────────────

  app.get('/api/rgpd/privacy-policy', async (_req, reply) => {
    return reply.send({
      summary: PRIVACY_POLICY_SUMMARY,
      text: PRIVACY_POLICY_TEXT,
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
