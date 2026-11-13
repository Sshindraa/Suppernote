import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_COLLECTION_METHODS,
} from '@suppernote/shared';
import { MarketingCampaignStatus } from '@prisma/client';
import { db } from '../../shared/db/client';
import { queues } from '../../shared/queue/queues';
import { requireOrg } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import { CustomerSegmentDefinitionSchema } from '../customers/customer-segment.service';
import {
  CAMPAIGN_CHANNELS,
  cancelMarketingCampaign,
  createMarketingCampaign,
  getMarketingCampaign,
  listMarketingCampaigns,
  prepareMarketingCampaign,
  previewMarketingAudience,
  previewMarketingCampaign,
  scheduleMarketingCampaign,
  startMarketingCampaign,
  testMarketingCampaign,
  updateMarketingCampaign,
} from './marketing-campaign.service';
import {
  listMarketingAutomations,
  MARKETING_AUTOMATION_TYPES,
  upsertMarketingAutomation,
} from './marketing-automation.service';
import {
  createMarketingAttributionLink,
  deactivateMarketingConversions,
  defaultAttributionExpiry,
  recordMarketingAttributionClick,
  recordMarketingConversion,
} from './marketing-attribution.service';
import {
  listMarketingPermissions,
  MARKETING_CHANNELS,
  upsertMarketingPermission,
  withdrawMarketingPermission,
} from './marketing-permission.service';
import {
  recordConfirmationEmailConsent,
  recordStaffMarketingConsent,
  restaurantNameForConsent,
} from './marketing-consent.service';
import {
  consumeMarketingUnsubscribeToken,
  verifyMarketingConsentToken,
  verifyMarketingUnsubscribeToken,
} from './marketing-unsubscribe.service';
import {
  renderConsentDonePage,
  renderConsentPage,
  renderUnsubscribeConfirmPage,
  renderUnsubscribeDonePage,
  renderUnsubscribeInvalidPage,
  renderUnsubscribeRetryPage,
} from './marketing-unsubscribe.page';
import {
  getMarketingCampaignReport,
  marketingCampaignReportToCsv,
} from './marketing-report.service';
import { getMarketingProviderReadiness } from './marketing-provider.service';
import { createServiceFillDraft, previewServiceFill } from './fill-service.service';
import {
  dismissFillSuggestion,
  invalidateFillSuggestions,
  listFillSuggestions,
} from './fill-suggestions.service';
import { RATE_LIMIT_PUBLIC_TOKEN } from '../../plugins/rate-limit.policy';

/**
 * Public token endpoints (attribution click, unsubscribe). They are
 * unauthenticated and guarded only by an opaque token, so they use the
 * stricter `PUBLIC_TOKEN` tier instead of the global budget.
 */
const publicTokenRouteOptions = {
  config: { rateLimit: RATE_LIMIT_PUBLIC_TOKEN },
};

const CustomerIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});
const ChannelParamsSchema = CustomerIdParamsSchema.extend({
  channel: z.enum(MARKETING_CHANNELS),
});
const PermissionBodySchema = z.object({
  status: z.enum(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN']),
  source: z.string().trim().min(1).max(80),
  proofVersion: z.string().trim().min(1).max(80).nullable().optional(),
  proof: z.string().trim().min(1).max(512).nullable().optional(),
  proofHash: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/)
    .nullable()
    .optional(),
});

const StaffConsentParamsSchema = CustomerIdParamsSchema.extend({
  channel: z.enum(MARKETING_CONSENT_CHANNELS),
});
const StaffConsentBodySchema = z.object({
  method: z.enum(MARKETING_CONSENT_COLLECTION_METHODS),
});

const AudiencePreviewSchema = z
  .object({
    channel: z.enum(CAMPAIGN_CHANNELS),
    segmentId: z.string().trim().min(1).max(128).optional(),
    definition: CustomerSegmentDefinitionSchema.optional(),
    sampleLimit: z.coerce.number().int().min(1).max(20).optional(),
  })
  .refine((body) => Boolean(body.segmentId) !== (body.definition !== undefined), {
    message: 'segmentId or definition is required, but not both',
    path: ['segmentId'],
  });

const CampaignCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  objective: z.string().trim().min(1).max(120),
  channel: z.enum(CAMPAIGN_CHANNELS),
  segmentId: z.string().trim().min(1).max(128),
  subject: z.string().trim().min(1).max(200).nullable().optional(),
  bodyTemplate: z.string().trim().min(1).max(10_000),
  scheduledAt: z.coerce.date().nullable().optional(),
  timezone: z.string().trim().min(1).max(80).optional(),
});
const CampaignUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    objective: z.string().trim().min(1).max(120).optional(),
    channel: z.enum(CAMPAIGN_CHANNELS).optional(),
    segmentId: z.string().trim().min(1).max(128).optional(),
    subject: z.string().trim().min(1).max(200).nullable().optional(),
    bodyTemplate: z.string().trim().min(1).max(10_000).optional(),
    scheduledAt: z.coerce.date().nullable().optional(),
    timezone: z.string().trim().min(1).max(80).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, { message: 'at least one field is required' });

const FillServiceSchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), 'date invalide'),
  service: z.enum(['midi', 'soir']),
  channel: z.enum(CAMPAIGN_CHANNELS),
});
const FillServiceCreateSchema = FillServiceSchema.extend({
  subject: z.string().trim().min(1).max(200).nullable().optional(),
  bodyTemplate: z.string().trim().min(1).max(10_000),
});
/** Refus d'un remplissage, avec un message lisible ; le code reste stable pour le dashboard. */
const FILL_SERVICE_CONFLICTS: Record<string, { error: string; message: string }> = {
  NO_EMPTY_FORECAST: {
    error: 'FILL_SERVICE_NO_EMPTY_FORECAST',
    message: 'Aucune place vide probable pour ce service : il devrait se remplir sans message.',
  },
  BUDGET_EXHAUSTED: {
    error: 'FILL_SERVICE_BUDGET_EXHAUSTED',
    message: 'Le budget d’e-mails du jour est épuisé : choisissez le SMS ou réessayez demain.',
  },
  SERVICE_CLOSED: {
    error: 'FILL_SERVICE_CLOSED',
    message: 'Le restaurant n’ouvre pas ce service ce jour-là.',
  },
  CAPACITY_UNKNOWN: {
    error: 'FILL_SERVICE_CAPACITY_UNKNOWN',
    message: 'Le plan de salle n’est pas renseigné : la capacité de ce service est inconnue.',
  },
  SERVICE_FULL: {
    error: 'FILL_SERVICE_FULL',
    message: 'Ce service est complet : plus aucun créneau pour 2 couverts.',
  },
  NO_CANDIDATE: {
    error: 'FILL_SERVICE_NO_CANDIDATE',
    message:
      'Aucun client joignable pour ce service : consentement, opposition ou réservation le jour même.',
  },
};

const CampaignIdParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});
const CampaignListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const AutomationTypeParamsSchema = z.object({
  type: z.enum(MARKETING_AUTOMATION_TYPES),
});
const AutomationUpsertSchema = z.object({
  enabled: z.boolean(),
  channel: z.enum(CAMPAIGN_CHANNELS),
  config: z.record(z.string(), z.unknown()),
});
const CampaignScheduleBodySchema = z.object({
  scheduledAt: z.coerce.date(),
});
const AttributionLinkBodySchema = z.object({
  customerId: z.string().trim().min(1).max(128),
  expiresAt: z.coerce.date().optional(),
});
const ConversionBodySchema = z.object({
  customerId: z.string().trim().min(1).max(128),
  reservationId: z.string().trim().min(1).max(128).nullable().optional(),
  conversionType: z.enum(['RESERVATION_CREATED', 'RESERVATION_HONORED']),
  attributedAt: z.coerce.date().optional(),
  windowEndsAt: z.coerce.date().nullable().optional(),
});
const ClickBodySchema = z.object({
  token: z.string().trim().min(20).max(4096),
});
const DeactivateConversionBodySchema = z.object({
  reservationId: z.string().trim().min(1).max(128),
});

const requireCrmAdvanced = [requireOrg(), requireCapability('customers.advanced')];
const requireMarketingCampaigns = [requireOrg(), requireCapability('marketing.campaigns')];
const requireMarketingAutomations = [requireOrg(), requireCapability('marketing.automations')];
const requireMarketingAttribution = [requireOrg(), requireCapability('marketing.attribution')];

function isOppositionRegistered(error: unknown): boolean {
  return error instanceof Error && error.message === 'MARKETING_OPPOSITION_REGISTERED';
}

function statusForError(error: unknown): number {
  if (!(error instanceof Error)) return 500;
  if (error.message === 'CUSTOMER_NOT_FOUND' || error.message === 'SEGMENT_NOT_FOUND') return 404;
  if (error.message === 'CAMPAIGN_NOT_FOUND') return 404;
  if (
    error.message === 'CAMPAIGN_NOT_DRAFT' ||
    error.message === 'CAMPAIGN_NOT_CANCELLABLE' ||
    error.message === 'AUDIENCE_EMPTY' ||
    error.message === 'CAMPAIGN_NOT_READY' ||
    error.message === 'CAMPAIGN_ALREADY_RUNNING' ||
    error.message === 'CAMPAIGN_NOT_DUE'
  ) {
    return 409;
  }
  if (error.message === 'MARKETING_SENDS_DISABLED') return 503;
  if (error.message === 'MARKETING_QUEUE_ENQUEUE_UNKNOWN') return 503;
  if (error.message.startsWith('AUTOMATION_CANDIDATES_TOO_LARGE:')) return 413;
  if (error.message.startsWith('AUDIENCE_TOO_LARGE:')) return 413;
  if (
    error.message === 'ATTRIBUTION_SECRET_NOT_CONFIGURED' ||
    error.message === 'INVALID_ATTRIBUTION_TOKEN' ||
    error.message === 'ATTRIBUTION_TOKEN_EXPIRED'
  ) {
    return 400;
  }
  return 400;
}

/** Messages français pour les refus d'état d'une campagne (le texte du service reste un code interne). */
const CAMPAIGN_CONFLICT_MESSAGES: Record<string, string> = {
  AUDIENCE_EMPTY: 'Aucun destinataire n’a donné son consentement : il n’y a rien à préparer.',
  CAMPAIGN_NOT_DRAFT: 'Cette campagne n’est plus un brouillon.',
  CAMPAIGN_NOT_CANCELLABLE: 'Cette campagne ne peut plus être annulée.',
  CAMPAIGN_NOT_READY: 'Cette campagne n’est pas encore prête à partir.',
  CAMPAIGN_ALREADY_RUNNING: 'Cette campagne est déjà en cours d’envoi.',
  CAMPAIGN_NOT_DUE: 'Cette campagne n’est pas encore à l’heure de son envoi.',
  MARKETING_DAILY_BUDGET_EXCEEDED:
    'Audience trop grande pour aujourd’hui : le budget d’e-mails marketing du jour ne couvre pas cette campagne. Réessayez demain ou choisissez un segment plus petit.',
};

/** Même refus, formulé pour une programmation : le budget visé est celui du jour prévu. */
const SCHEDULE_CONFLICT_MESSAGES: Record<string, string> = {
  ...CAMPAIGN_CONFLICT_MESSAGES,
  MARKETING_DAILY_BUDGET_EXCEEDED:
    'Audience trop grande pour ce jour-là : le budget d’e-mails marketing de ce jour ne couvre pas cette campagne. Choisissez un autre jour ou un segment plus petit.',
};

/** Réponse 409 lisible pour un refus d'état connu ; `null` pour toute autre erreur. */
function campaignConflict(
  error: unknown,
  messages: Record<string, string> = CAMPAIGN_CONFLICT_MESSAGES,
): { error: string; message: string } | null {
  if (!(error instanceof Error)) return null;
  const message = messages[error.message];
  return message ? { error: error.message, message } : null;
}

/**
 * Faute de saisie dans le message ou les réglages d'une règle / d'une campagne : le service lève des
 * erreurs anglaises internes, que le restaurateur ne peut pas lire. `null` pour toute autre erreur.
 */
function marketingContentProblem(error: unknown): string | null {
  if (error instanceof z.ZodError) {
    return 'Certains réglages ne sont pas valides. Vérifiez le message et les délais.';
  }
  if (!(error instanceof Error)) return null;
  const text = error.message;
  if (text === 'marketing template must include {{unsubscribeUrl}}') {
    return 'Le message doit contenir {{unsubscribeUrl}} : le lien de désinscription est obligatoire.';
  }
  const variable = /^template variable is not allow-listed: (.+)$/.exec(text);
  if (variable) return `Le message utilise une variable inconnue : ${variable[1]}.`;
  if (text === 'email campaign requires a subject') return 'Indiquez un objet pour l’e-mail.';
  if (text === 'subject must contain at most 200 characters') {
    return 'L’objet est trop long (200 caractères au maximum).';
  }
  if (text === 'subject is only supported for email campaigns') {
    return 'L’objet ne sert que pour les e-mails : videz-le pour un SMS ou un message WhatsApp.';
  }
  if (/^bodyTemplate must contain between 1 and \d+ characters$/.test(text)) {
    return 'Le message est vide ou trop long.';
  }
  if (text === 'timezone must be a valid IANA timezone') {
    return 'Le fuseau horaire n’est pas valide. Exemple : Europe/Paris.';
  }
  return null;
}

/** Channel-specific permission and durable campaign control plane. */
export async function marketingRoutes(app: FastifyInstance) {
  app.get(
    '/marketing/providers/readiness',
    { preHandler: requireMarketingCampaigns },
    async (_request, reply) => reply.send({ data: getMarketingProviderReadiness() }),
  );

  app.get(
    '/crm/customers/:id/marketing-permissions',
    { preHandler: requireCrmAdvanced },
    async (request, reply) => {
      const { id } = CustomerIdParamsSchema.parse(request.params);
      try {
        const permissions = await listMarketingPermissions({
          restaurantId: request.restaurantId!,
          customerId: id,
        });
        return reply.send({ data: permissions });
      } catch (error) {
        if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') {
          return reply.status(404).send({ error: 'CUSTOMER_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.put(
    '/crm/customers/:id/marketing-permissions/:channel',
    { preHandler: requireCrmAdvanced },
    async (request, reply) => {
      const { id, channel } = ChannelParamsSchema.parse(request.params);
      const body = PermissionBodySchema.parse(request.body);
      try {
        const permission = await upsertMarketingPermission({
          restaurantId: request.restaurantId!,
          customerId: id,
          channel,
          status: body.status,
          source: body.source,
          proofVersion: body.proofVersion,
          proof: body.proof,
          proofHash: body.proofHash,
          actorUserId: request.userId,
          occurredAt: new Date(),
        });
        return reply.send({ data: permission });
      } catch (error) {
        if (isOppositionRegistered(error)) {
          return reply.status(409).send({ error: 'MARKETING_OPPOSITION_REGISTERED' });
        }
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CUSTOMER_NOT_FOUND' });
        throw error;
      }
    },
  );

  app.post(
    '/crm/customers/:id/marketing-permissions/:channel/consent',
    { preHandler: requireCrmAdvanced },
    async (request, reply) => {
      const { id, channel } = StaffConsentParamsSchema.parse(request.params);
      const { method } = StaffConsentBodySchema.parse(request.body);
      try {
        const permission = await recordStaffMarketingConsent({
          restaurantId: request.restaurantId!,
          customerId: id,
          channel,
          method,
          actorUserId: request.userId,
        });
        return reply.send({ data: permission });
      } catch (error) {
        if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') {
          return reply.status(404).send({ error: 'CUSTOMER_NOT_FOUND' });
        }
        if (error instanceof Error && error.message === 'CUSTOMER_EMAIL_REQUIRED') {
          return reply.status(409).send({ error: 'CUSTOMER_EMAIL_REQUIRED' });
        }
        if (isOppositionRegistered(error)) {
          return reply.status(409).send({ error: 'MARKETING_OPPOSITION_REGISTERED' });
        }
        throw error;
      }
    },
  );

  app.delete(
    '/crm/customers/:id/marketing-permissions/:channel',
    { preHandler: requireCrmAdvanced },
    async (request, reply) => {
      const { id, channel } = ChannelParamsSchema.parse(request.params);
      try {
        const permission = await withdrawMarketingPermission({
          restaurantId: request.restaurantId!,
          customerId: id,
          channel,
          source: 'DASHBOARD_WITHDRAWAL',
          actorUserId: request.userId,
        });
        return reply.send({ data: permission });
      } catch (error) {
        if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') {
          return reply.status(404).send({ error: 'CUSTOMER_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/marketing/automations',
    { preHandler: requireMarketingAutomations },
    async (request, reply) => {
      const automations = await listMarketingAutomations({ restaurantId: request.restaurantId! });
      return reply.send({ data: automations });
    },
  );

  app.put(
    '/marketing/automations/:type',
    { preHandler: requireMarketingAutomations },
    async (request, reply) => {
      const { type } = AutomationTypeParamsSchema.parse(request.params);
      const body = AutomationUpsertSchema.parse(request.body);
      try {
        const automation = await upsertMarketingAutomation({
          restaurantId: request.restaurantId!,
          type,
          channel: body.channel,
          config: body.config,
          enabled: body.enabled,
        });
        return reply.send({ data: automation });
      } catch (error) {
        const problem = marketingContentProblem(error);
        if (problem)
          return reply.status(400).send({ error: 'INVALID_AUTOMATION', message: problem });
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/audience-preview',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const body = AudiencePreviewSchema.parse(request.body);
      try {
        const preview = await previewMarketingAudience({
          restaurantId: request.restaurantId!,
          channel: body.channel,
          segmentId: body.segmentId,
          definition: body.definition,
          sampleLimit: body.sampleLimit,
        });
        return reply.send(preview);
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'SEGMENT_NOT_FOUND' });
        if (status === 413) return reply.status(status).send({ error: 'AUDIENCE_TOO_LARGE' });
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const body = CampaignCreateSchema.parse(request.body);
      try {
        const campaign = await createMarketingCampaign({
          restaurantId: request.restaurantId!,
          name: body.name,
          objective: body.objective,
          channel: body.channel,
          segmentId: body.segmentId,
          subject: body.subject,
          bodyTemplate: body.bodyTemplate,
          scheduledAt: body.scheduledAt,
          timezone: body.timezone,
          createdBy: request.userId ?? undefined,
        });
        return reply.status(201).send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'SEGMENT_NOT_FOUND' });
        if (status === 413) return reply.status(status).send({ error: 'AUDIENCE_TOO_LARGE' });
        const problem = marketingContentProblem(error);
        if (problem) return reply.status(400).send({ error: 'INVALID_CAMPAIGN', message: problem });
        throw error;
      }
    },
  );

  // Remplissage d'un service creux : direction seule (voir role-policy.ts), rien n'est envoyé.
  app.post(
    '/marketing/fill-service/preview',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const body = FillServiceSchema.parse(request.body);
      try {
        const preview = await previewServiceFill({ restaurantId: request.restaurantId!, ...body });
        return reply.send({ data: preview });
      } catch (error) {
        if (statusForError(error) === 413) {
          return reply.status(413).send({ error: 'AUDIENCE_TOO_LARGE' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/marketing/fill-service',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const body = FillServiceCreateSchema.parse(request.body);
      try {
        const { plan, campaign } = await createServiceFillDraft({
          restaurantId: request.restaurantId!,
          date: body.date,
          service: body.service,
          channel: body.channel,
          name: `Service ${body.service} du ${body.date}`,
          objective: 'Remplir un service creux',
          subject: body.subject,
          bodyTemplate: body.bodyTemplate,
          createdBy: request.userId ?? undefined,
        });
        if (!campaign) {
          const conflict =
            FILL_SERVICE_CONFLICTS[
              plan.status !== 'PLANNED'
                ? plan.status
                : plan.budgetExhausted
                  ? 'BUDGET_EXHAUSTED'
                  : plan.emptyPlaces === 0
                    ? 'NO_EMPTY_FORECAST'
                    : 'NO_CANDIDATE'
            ];
          return reply.status(409).send(conflict);
        }
        await invalidateFillSuggestions(request.restaurantId!);
        return reply.status(201).send({
          data: {
            id: campaign.id,
            status: campaign.status,
            audienceCount: campaign.audienceCount,
            targetServiceStart: campaign.targetServiceStart,
            targetServiceEnd: campaign.targetServiceEnd,
          },
        });
      } catch (error) {
        if (statusForError(error) === 413) {
          return reply.status(413).send({ error: 'AUDIENCE_TOO_LARGE' });
        }
        const problem = marketingContentProblem(error);
        if (problem) return reply.status(400).send({ error: 'INVALID_CAMPAIGN', message: problem });
        throw error;
      }
    },
  );

  // Services creux à remplir : lecture seule, sans nom ni téléphone.
  app.get(
    '/marketing/fill-suggestions',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) =>
      reply.send({ data: await listFillSuggestions({ restaurantId: request.restaurantId! }) }),
  );

  app.post(
    '/marketing/fill-suggestions/dismiss',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const body = FillServiceSchema.pick({ date: true, service: true }).parse(request.body);
      try {
        await dismissFillSuggestion({ restaurantId: request.restaurantId!, ...body });
      } catch (error) {
        request.log.warn({ err: error }, 'fill suggestion dismiss unavailable');
        return reply.status(503).send({ error: 'DISMISS_UNAVAILABLE' });
      }
      return reply.status(204).send();
    },
  );

  app.get(
    '/marketing/campaigns',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const query = CampaignListQuerySchema.parse(request.query);
      const campaigns = await listMarketingCampaigns({
        restaurantId: request.restaurantId!,
        limit: query.limit,
      });
      return reply.send({ data: campaigns });
    },
  );

  app.get(
    '/marketing/campaigns/:id',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const campaign = await getMarketingCampaign({
        restaurantId: request.restaurantId!,
        campaignId: id,
      });
      if (!campaign) return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
      return reply.send({ data: campaign });
    },
  );

  app.patch(
    '/marketing/campaigns/:id',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const body = CampaignUpdateSchema.parse(request.body);
      try {
        const campaign = await updateMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
          changes: body,
        });
        return reply.send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CAMPAIGN_NOT_FOUND' });
        if (error instanceof Error && error.message === 'CAMPAIGN_NOT_EDITABLE') {
          return reply.status(409).send({ error: error.message });
        }
        if (error instanceof Error && error.message === 'CAMPAIGN_AUDIENCE_FROZEN') {
          return reply.status(409).send({ error: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/preview',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const preview = await previewMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply.send({ data: preview });
      } catch (error) {
        if (error instanceof Error && error.message === 'CAMPAIGN_NOT_FOUND') {
          return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/test',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const result = await testMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply.send({ data: result });
      } catch (error) {
        if (error instanceof Error && error.message === 'CAMPAIGN_NOT_FOUND') {
          return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/marketing/campaigns/:id/report',
    { preHandler: requireMarketingAttribution },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const report = await getMarketingCampaignReport({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply.send({ data: report });
      } catch (error) {
        if (error instanceof Error && error.message === 'CAMPAIGN_NOT_FOUND') {
          return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.get(
    '/marketing/campaigns/:id/report.csv',
    { preHandler: requireMarketingAttribution },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const report = await getMarketingCampaignReport({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply
          .type('text/csv; charset=utf-8')
          .header('Content-Disposition', `attachment; filename="suppernote-campaign-${id}.csv"`)
          .send(marketingCampaignReportToCsv(report));
      } catch (error) {
        if (error instanceof Error && error.message === 'CAMPAIGN_NOT_FOUND') {
          return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
        }
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/prepare',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const campaign = await prepareMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply.send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CAMPAIGN_NOT_FOUND' });
        const conflict = campaignConflict(error);
        if (conflict) return reply.status(409).send(conflict);
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/cancel',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      try {
        const campaign = await cancelMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        return reply.send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CAMPAIGN_NOT_FOUND' });
        const conflict = campaignConflict(error);
        if (conflict) return reply.status(409).send(conflict);
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/schedule',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const body = CampaignScheduleBodySchema.parse(request.body);
      if (process.env.MARKETING_SENDS_ENABLED !== 'true') {
        return reply.status(503).send({ error: 'MARKETING_SENDS_DISABLED' });
      }
      try {
        const campaign = await scheduleMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
          scheduledAt: body.scheduledAt,
        });
        const delay = Math.max(body.scheduledAt.getTime() - Date.now(), 0);
        try {
          await queues.marketingCampaign.add(
            'send-campaign',
            { campaignId: id, restaurantId: request.restaurantId! },
            { jobId: `marketing-campaign-${id}`, delay },
          );
        } catch (error) {
          await db.marketingCampaign.update({
            where: { id: campaign.id },
            data: {
              status: MarketingCampaignStatus.FAILED,
              completedAt: new Date(),
              lastErrorCode: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN',
            },
          });
          throw new Error('MARKETING_QUEUE_ENQUEUE_UNKNOWN', { cause: error });
        }
        return reply.send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CAMPAIGN_NOT_FOUND' });
        if (status === 503)
          return reply.status(status).send({ error: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN' });
        const conflict = campaignConflict(error, SCHEDULE_CONFLICT_MESSAGES);
        if (conflict) return reply.status(409).send(conflict);
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/send',
    { preHandler: requireMarketingCampaigns },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      if (process.env.MARKETING_SENDS_ENABLED !== 'true') {
        return reply.status(503).send({ error: 'MARKETING_SENDS_DISABLED' });
      }
      try {
        const campaign = await startMarketingCampaign({
          restaurantId: request.restaurantId!,
          campaignId: id,
        });
        try {
          await queues.marketingCampaign.add(
            'send-campaign',
            { campaignId: id, restaurantId: request.restaurantId! },
            { jobId: `marketing-campaign-${id}` },
          );
        } catch (error) {
          await db.marketingCampaign.update({
            where: { id: campaign.id },
            data: {
              status: MarketingCampaignStatus.FAILED,
              completedAt: new Date(),
              lastErrorCode: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN',
            },
          });
          throw new Error('MARKETING_QUEUE_ENQUEUE_UNKNOWN', { cause: error });
        }
        return reply.send({ data: campaign });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) return reply.status(status).send({ error: 'CAMPAIGN_NOT_FOUND' });
        if (status === 503)
          return reply.status(status).send({ error: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN' });
        const conflict = campaignConflict(error);
        if (conflict) return reply.status(409).send(conflict);
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/attribution-links',
    { preHandler: requireMarketingAttribution },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const body = AttributionLinkBodySchema.parse(request.body);
      try {
        const link = await createMarketingAttributionLink({
          restaurantId: request.restaurantId!,
          campaignId: id,
          customerId: body.customerId,
          expiresAt: body.expiresAt ?? defaultAttributionExpiry(),
        });
        return reply.status(201).send({
          data: {
            token: link.token,
            link: {
              id: link.link.id,
              campaignId: link.link.campaignId,
              customerId: link.link.customerId,
              expiresAt: link.link.expiresAt,
            },
          },
        });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) {
          const errorCode =
            error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND'
              ? 'CUSTOMER_NOT_FOUND'
              : 'CAMPAIGN_NOT_FOUND';
          return reply.status(status).send({ error: errorCode });
        }
        throw error;
      }
    },
  );

  // Public click endpoint: it records only a timestamp and never returns the
  // campaign or customer identifiers to the browser.
  app.post('/marketing/attribution/click', publicTokenRouteOptions, async (request, reply) => {
    const body = ClickBodySchema.parse(request.body);
    try {
      const link = await recordMarketingAttributionClick({ token: body.token });
      return reply.send({ data: { clicked: Boolean(link) } });
    } catch (error) {
      const status = statusForError(error);
      if (status === 400) return reply.status(400).send({ error: 'INVALID_ATTRIBUTION_TOKEN' });
      throw error;
    }
  });

  // Désinscription. Un GET (lien de l'e-mail, ouvert aussi par les anti-virus et aperçus de lien)
  // ne change rien : il affiche une confirmation. Le POST désinscrit ; il accepte le jeton dans le
  // corps (formulaire ou JSON) ou dans l'URL, comme le fait le « un clic » RFC 8058
  // (`List-Unsubscribe-Post`) des messageries. La réponse ne reprend jamais téléphone ou e-mail.
  const UnsubscribeTokenSchema = z.string().trim().min(20).max(4096);
  const isUnsubscribeTokenError = (error: unknown): boolean =>
    error instanceof Error &&
    (error.message === 'INVALID_UNSUBSCRIBE_TOKEN' ||
      error.message === 'UNSUBSCRIBE_TOKEN_EXPIRED' ||
      error.message === 'MARKETING_UNSUBSCRIBE_SECRET_NOT_CONFIGURED');
  const sendUnsubscribePage = (reply: FastifyReply, status: number, html: string) =>
    reply
      .status(status)
      .header('cache-control', 'no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex')
      .header(
        'content-security-policy',
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
      )
      .type('text/html; charset=utf-8')
      .send(html);

  app.post('/marketing/unsubscribe', publicTokenRouteOptions, async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown };
    const query = (request.query ?? {}) as { token?: unknown };
    const candidate = UnsubscribeTokenSchema.safeParse(body.token ?? query.token);
    const fromBrowserForm =
      String(request.headers['content-type'] ?? '').startsWith(
        'application/x-www-form-urlencoded',
      ) && String(request.headers.accept ?? '').includes('text/html');
    if (!candidate.success) {
      if (fromBrowserForm) return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
      return reply.status(400).send({ error: 'INVALID_UNSUBSCRIBE_TOKEN' });
    }
    try {
      const result = await consumeMarketingUnsubscribeToken({ token: candidate.data });
      if (fromBrowserForm) {
        return sendUnsubscribePage(reply, 200, renderUnsubscribeDonePage(result.channel));
      }
      return reply.send({ data: { unsubscribed: true, channel: result.channel } });
    } catch (error) {
      if (isUnsubscribeTokenError(error)) {
        if (fromBrowserForm) return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
        return reply.status(400).send({ error: 'INVALID_UNSUBSCRIBE_TOKEN' });
      }
      if (error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND') {
        if (fromBrowserForm) return sendUnsubscribePage(reply, 404, renderUnsubscribeInvalidPage());
        return reply.status(404).send({ error: 'CUSTOMER_NOT_FOUND' });
      }
      // Le jeton est signé et sans état : le même lien permet de réessayer.
      if (error instanceof Error && error.message === 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE') {
        if (fromBrowserForm) return sendUnsubscribePage(reply, 503, renderUnsubscribeRetryPage());
        return reply.status(503).send({ error: 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE' });
      }
      throw error;
    }
  });

  app.get('/marketing/unsubscribe', publicTokenRouteOptions, async (request, reply) => {
    const query = (request.query ?? {}) as { token?: unknown };
    const candidate = UnsubscribeTokenSchema.safeParse(query.token);
    if (!candidate.success) {
      return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
    }
    try {
      verifyMarketingUnsubscribeToken(candidate.data);
    } catch (error) {
      if (isUnsubscribeTokenError(error)) {
        return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
      }
      throw error;
    }
    return sendUnsubscribePage(reply, 200, renderUnsubscribeConfirmPage(candidate.data));
  });

  // Consentement par lien, sur le modèle de la désinscription : le GET n'enregistre rien.
  // Seul un POST avec la case cochée enregistre l'accord.
  const sendConsentForm = async (reply: FastifyReply, token: string, notice?: string) => {
    const { restaurantId } = verifyMarketingConsentToken(token);
    const restaurantName = await restaurantNameForConsent(restaurantId);
    if (!restaurantName) return sendUnsubscribePage(reply, 404, renderUnsubscribeInvalidPage());
    return sendUnsubscribePage(reply, 200, renderConsentPage({ token, restaurantName, notice }));
  };

  app.get('/marketing/consent', publicTokenRouteOptions, async (request, reply) => {
    const query = (request.query ?? {}) as { token?: unknown };
    const candidate = UnsubscribeTokenSchema.safeParse(query.token);
    if (!candidate.success) return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
    try {
      return await sendConsentForm(reply, candidate.data);
    } catch (error) {
      if (isUnsubscribeTokenError(error)) {
        return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
      }
      throw error;
    }
  });

  app.post('/marketing/consent', publicTokenRouteOptions, async (request, reply) => {
    const body = (request.body ?? {}) as { token?: unknown; consent?: unknown };
    const candidate = UnsubscribeTokenSchema.safeParse(body.token);
    if (!candidate.success) return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
    try {
      if (body.consent !== 'on') {
        return await sendConsentForm(
          reply,
          candidate.data,
          'Aucune case cochée : rien n’a été enregistré.',
        );
      }
      const { restaurantId, customerId, reservationId } = verifyMarketingConsentToken(
        candidate.data,
      );
      const outcome = await recordConfirmationEmailConsent({
        restaurantId,
        customerId,
        reservationId,
      });
      return sendUnsubscribePage(reply, 200, renderConsentDonePage(outcome));
    } catch (error) {
      if (isUnsubscribeTokenError(error)) {
        return sendUnsubscribePage(reply, 400, renderUnsubscribeInvalidPage());
      }
      throw error;
    }
  });

  app.post(
    '/marketing/campaigns/:id/conversions',
    { preHandler: requireMarketingAttribution },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const body = ConversionBodySchema.parse(request.body);
      try {
        const result = await recordMarketingConversion({
          restaurantId: request.restaurantId!,
          campaignId: id,
          customerId: body.customerId,
          reservationId: body.reservationId,
          conversionType: body.conversionType,
          attributedAt: body.attributedAt,
          windowEndsAt: body.windowEndsAt,
        });
        return reply.status(result.created ? 201 : 200).send({ data: result });
      } catch (error) {
        const status = statusForError(error);
        if (status === 404) {
          const errorCode =
            error instanceof Error && error.message === 'CUSTOMER_NOT_FOUND'
              ? 'CUSTOMER_NOT_FOUND'
              : 'CAMPAIGN_NOT_FOUND';
          return reply.status(status).send({ error: errorCode });
        }
        throw error;
      }
    },
  );

  app.post(
    '/marketing/campaigns/:id/conversions/deactivate',
    { preHandler: requireMarketingAttribution },
    async (request, reply) => {
      const { id } = CampaignIdParamsSchema.parse(request.params);
      const body = DeactivateConversionBodySchema.parse(request.body);
      const campaign = await getMarketingCampaign({
        restaurantId: request.restaurantId!,
        campaignId: id,
      });
      if (!campaign) return reply.status(404).send({ error: 'CAMPAIGN_NOT_FOUND' });
      const count = await deactivateMarketingConversions({
        restaurantId: request.restaurantId!,
        reservationId: body.reservationId,
      });
      return reply.send({ data: { deactivated: count } });
    },
  );
}
