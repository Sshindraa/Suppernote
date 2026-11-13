import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { clerkClient } from '@clerk/fastify';
import type { Prisma } from '@prisma/client';
import {
  canonicalDemoSlug,
  getDemoSlugAlias,
  isOfficialDemoSlug,
  normalizePhone,
} from '@suppernote/shared';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { publicReadMax } from '../../plugins/rate-limit';
import { trackOnboardingEvent, type OnboardingAnalyticsEvent } from '../analytics/events.service';
import { placeOutboundCall } from '../../shared/telnyx/client';
import { logger } from '../../shared/logger/pino';
import { env } from '../../env';
import { isPublicConnectPage } from '../connect/connect.types';
import { isTestBookingEnabled, issueTestBookingToken } from '../connect/test-booking';
import {
  getOnboardingPlaceDetails,
  isOnboardingPlacesEnabled,
  searchOnboardingPlaces,
} from './onboarding-places.service';
import {
  applyOnboardingTransition,
  computeOnboardingState,
  DEFAULT_HOURS,
  hasConfiguredRules,
  hasUsablePhone,
  normalizeTasks,
  type OnboardingTask,
  type OnboardingTaskState,
  UpdateOnboardingSchema,
} from './onboarding.service';
import { OpeningHoursSchema } from './opening-hours.schema';
import {
  hasAnsweredPracticalInfo,
  mergePracticalInfo,
  normalizePracticalInfo,
  PracticalInfoUpdateSchema,
  syncManagedFeatures,
} from './practical-info';
import {
  applyQuickFloorSetup,
  loadFloorStats,
  loadFloorSummary,
  QuickFloorSetupSchema,
} from './onboarding-floor.service';
import { invalidateRestaurantContextCache } from './restaurant.service';
import { resolveStyledGreeting } from '../voice/stream/styled-greeting';
import { requestGreetingWarm } from '../../shared/queue/greeting-warm';
import { computeConnectScore } from '../connect/connect-score.service';
import {
  createCustomHostname,
  getCustomHostname,
  deleteCustomHostname,
  verifyCname,
  isCloudflareSaaSEnabled,
} from '../connect/cloudflare-saas.service';
import { synthesizeText, isCartesiaConfigured } from '../voice/cartesia-synth';
import {
  CARTESIA_NORMALIZATION,
  buildCartesiaCacheVariant,
  getCartesiaGenerationConfig,
  getCartesiaVoiceId,
} from '../voice/stream/cartesia-config';
import { normalizeVoiceLocale } from '../voice/stream/voice-language';
import { CARTESIA_MODEL } from '@suppernote/config';
import { redisCache } from '../../shared/redis/client';
import { isVoicePipelineEnabled } from '../../shared/configcat';
import {
  LIVE_DEMO_MAX_DURATION_SEC,
  buildLiveDemoWsUrl,
  issueLiveDemoTicket,
  liveDemoUnavailableReason,
} from '../voice/demo/live-demo';
import {
  listAccessibleRestaurantSites,
  lockAccountMemberships,
  RestaurantContextError,
} from './site-context';
import {
  assertClerkOrganizationMember,
  ClerkMembershipVerificationError,
} from './clerk-membership.service';
import { SOKAR_ROLE_METADATA_KEY } from './team.service';

type RestaurantWithIncludes = Prisma.RestaurantGetPayload<{
  include: { personality: true; exposureSettings: true; images: true };
}>;

const ONBOARDING_EVENT_BY_ACTION: Partial<
  Record<z.infer<typeof UpdateOnboardingSchema>['action'], OnboardingAnalyticsEvent>
> = {
  start: 'onboarding_step_started',
  complete: 'onboarding_step_completed',
  skip: 'onboarding_step_skipped',
  block: 'onboarding_step_blocked',
  activate: 'onboarding_activated',
  first_call: 'onboarding_first_call',
};

// Le plan est une projection de Billing et ne peut pas être fourni par le
// restaurateur, ni à la création ni à la mise à jour. La base applique STARTER
// par défaut ; Stripe ou un opérateur Suppernote fait évoluer cette projection.
const RestaurantProfileSchema = z.object({
  name: z.string().min(2).max(100),
  managerPhone: z.string().regex(/^\+?[0-9]{10,15}$/),
  managerEmail: z.string().email(),
  phoneNumber: z.string().min(5),
  openingHours: OpeningHoursSchema,
  giftCardMinimumAmount: z.number().int().min(0).optional(),
  giftCardEnabled: z.boolean().optional(),
});

const CreateRestaurantSchema = RestaurantProfileSchema;

const CreateSiteSchema = z.object({
  name: z.string().trim().min(2).max(100),
  // Ligne publique du site (le « Téléphone du site » saisi dans le dashboard), enregistrée dans
  // `phoneE164`. Ce n'est pas le numéro Suppernote : celui-ci est attribué par un opérateur.
  phoneNumber: z.string().trim().min(5).max(32),
  managerPhone: z.string().trim().max(32).default(''),
  managerEmail: z
    .string()
    .trim()
    .refine((value) => value === '' || z.string().email().safeParse(value).success, {
      message: 'Adresse email invalide',
    })
    .default(''),
  openingHours: z.record(z.string(), z.unknown()).default({}),
});

const UpdateSiteSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    siteStatus: z.enum(['ACTIVE', 'SUSPENDED', 'ARCHIVED']).optional(),
  })
  .refine((value) => value.name !== undefined || value.siteStatus !== undefined, {
    message: 'Aucune modification fournie',
  });

const SiteMemberSchema = z.object({
  clerkUserId: z.string().trim().min(1).max(128),
  role: z.enum(['MANAGER', 'STAFF', 'READ_ONLY']).default('STAFF'),
});

const UpdatePersonalitySchema = z.object({
  profileType: z.enum(['BISTROT_BRASSERIE', 'GASTRONOMIQUE', 'SEMI_GASTRO']).optional(),
  fillerStyle: z.enum(['CASUAL', 'FORMAL', 'WARM']).optional(),
  speakingRate: z.number().min(0.5).max(2.0).optional(),
  volume: z.number().min(0.5).max(2.0).optional(),
  emotion: z.string().trim().max(64).optional(),
  pitchShift: z.number().min(0.5).max(2.0).optional(),
  microphoneThreshold: z.number().int().min(-80).max(0).optional(),
  targetLatencyMs: z.number().int().min(40).max(500).optional(),
  voiceIdCa: z.string().optional(),
  pronunciationDictId: z.string().trim().max(128).optional(),
  systemPromptExtra: z.string().max(2000).optional(),
});

const CapacitySpecialsSchema = z
  .object({
    totalCapacity: z.number().int().optional(),
    serviceDuration: z.number().int().optional(),
    serviceDurationMinutes: z.number().int().optional(),
    defaultServiceDurationMinutes: z.number().int().optional(),
    cancellationPolicy: z.string().max(280).optional(),
    depositRequired: z.boolean().optional(),
    depositAmount: z.number().optional(),
    depositThreshold: z.number().int().optional(),
    waitingListEnabled: z.boolean().optional(),
    waitingListMaxEntriesPerSlot: z.number().int().min(1).optional(),
  })
  .passthrough();

// Le numéro Suppernote (`phoneNumber`) aiguille les appels entrants : seul un opérateur Suppernote l'attribue
// (POST /admin/provisioning/:id/assign-phone). Le restaurateur ne peut pas le modifier ici ; un
// `phoneNumber` envoyé est ignoré.
const UpdateRestaurantSchema = RestaurantProfileSchema.omit({ phoneNumber: true })
  .extend({
    phoneE164: z.string().trim().max(32).optional().nullable(),
    googlePlaceId: z.string().trim().max(200).optional().nullable(),
    capacitySpecials: CapacitySpecialsSchema.optional(),
  })
  .partial();

const OnboardingPlaceSearchSchema = z.object({
  query: z.string().trim().min(2).max(120),
  sessionToken: z.string().guid(),
});
const OnboardingPlaceDetailsSchema = z.object({
  placeId: z.string().trim().min(5).max(200),
  sessionToken: z.string().guid(),
});

const UpdateConnectSchema = z.object({
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(200).optional().nullable(),
  formattedAddress: z.string().max(200).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  postalCode: z.string().max(20).optional().nullable(),
  country: z.string().max(10).default('FR').optional(),
  lat: z.number().optional().nullable(),
  lng: z.number().optional().nullable(),
  cuisineType: z.array(z.string()).optional(),
  priceRange: z.number().min(1).max(4).optional().nullable(),
  ambiance: z.array(z.string()).optional(),
  dietary: z.array(z.string()).optional(),
  coverImageUrl: z.string().optional().nullable(),
  maxPartySize: z.number().int().min(1).max(100).optional(),
  connectPublished: z.boolean().optional(),
  connectAgentic: z.boolean().optional(),
  capacitySpecials: CapacitySpecialsSchema.optional(),
  // Suppernote Connect P2 — premium subdomain
  customDomain: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i)
    .max(253)
    .optional()
    .nullable(),
});

const PostImageSchema = z.object({
  url: z.string(),
  isCover: z.boolean().default(false),
  position: z.number().int().default(0),
  alt: z.string().optional(),
});

function onboardingPayload(
  restaurant: RestaurantWithIncludes,
  state: ReturnType<typeof computeOnboardingState>,
) {
  return {
    readiness: state.readiness,
    onboardingDone: state.onboardingDone,
    voiceOnboardingDone: state.voiceOnboardingDone,
    connectOnboardingDone: state.connectOnboardingDone,
    minimumViableDone: state.minimumViableDone,
    onboardingCompletedAt: restaurant.onboardingCompletedAt,
    onboardingActivatedAt: restaurant.onboardingActivatedAt,
    onboardingLastSeenAt: restaurant.onboardingLastSeenAt,
    firstCallAt: restaurant.firstCallAt,
    currentStep: state.currentStep,
    completedCount: state.completedCount,
    totalCount: state.totalCount,
    progress: state.progress,
    voiceProgress: state.voiceProgress,
    connectProgress: state.connectProgress,
    steps: state.steps,
    defaultHours: DEFAULT_HOURS,
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      managerPhone: restaurant.managerPhone,
      managerEmail: restaurant.managerEmail,
      phoneE164: restaurant.phoneE164,
      googlePlaceId: restaurant.googlePlaceId,
      phoneNumber: restaurant.phoneNumber,
      phoneAssigned: hasUsablePhone(restaurant.phoneNumber),
      openingHours: restaurant.openingHours,
      personality: restaurant.personality,
      practicalInfo: normalizePracticalInfo(restaurant.practicalInfo),
      // Suppernote Connect
      slug: restaurant.slug,
      description: restaurant.description,
      formattedAddress: restaurant.formattedAddress,
      city: restaurant.city,
      postalCode: restaurant.postalCode,
      country: restaurant.country,
      lat: restaurant.lat ? Number(restaurant.lat) : null,
      lng: restaurant.lng ? Number(restaurant.lng) : null,
      cuisineType: restaurant.cuisineType,
      priceRange: restaurant.priceRange,
      ambiance: restaurant.ambiance,
      dietary: restaurant.dietary,
      coverImageUrl: restaurant.coverImageUrl,
      images: restaurant.images || [],
      exposureSettings: restaurant.exposureSettings || null,
    },
  };
}

export async function restaurantRoutes(app: FastifyInstance) {
  const getOnboarding = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const restaurant = await app.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { personality: true, exposureSettings: true, images: true },
    });

    const floorStats = await loadFloorStats(app.db, restaurantId);
    const state = computeOnboardingState({ ...restaurant, floorStats });
    const completedAt =
      state.onboardingDone && !restaurant.onboardingCompletedAt
        ? new Date()
        : restaurant.onboardingCompletedAt;

    const updated = await app.db.restaurant.update({
      where: { id: restaurantId },
      data: {
        onboardingTasks: state.tasks as unknown as Prisma.InputJsonValue,
        onboardingDone: state.onboardingDone,
        onboardingCompletedAt: completedAt,
        onboardingLastSeenAt: new Date(),
      },
      include: { personality: true, exposureSettings: true, images: true },
    });

    return reply.send(
      onboardingPayload(updated, computeOnboardingState({ ...updated, floorStats })),
    );
  };

  const patchOnboarding = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const body = UpdateOnboardingSchema.parse(req.body ?? {});
    const restaurant = await app.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { personality: true, exposureSettings: true, images: true },
    });

    if (body.action === 'first_call') {
      const phoneMetadata = normalizeTasks(restaurant.onboardingTasks).phone.metadata ?? {};
      const pendingCallControlId = phoneMetadata.testCallControlId;
      const providedCallControlId = body.metadata?.testCallControlId;
      if (
        typeof pendingCallControlId !== 'string' ||
        typeof providedCallControlId !== 'string' ||
        pendingCallControlId !== providedCallControlId
      ) {
        return reply.status(409).send({
          code: 'TEST_CALL_NOT_CONFIRMED',
          error:
            "Confirmez la réception du dernier appel test avant de valider cette étape d'onboarding.",
        });
      }
    }

    if (
      body.action === 'complete' &&
      body.task === 'phone' &&
      !hasUsablePhone(restaurant.phoneNumber)
    ) {
      return reply.status(409).send({
        error:
          "Aucun numéro Suppernote attribué. Cette étape sera déverrouillée dès qu'un numéro sera ajouté au restaurant.",
      });
    }

    const floorStats = await loadFloorStats(app.db, restaurantId);
    if (body.action === 'complete' && body.task === 'floor' && floorStats.tableCount === 0) {
      return reply.status(409).send({
        code: 'NO_TABLES',
        error:
          'Ajoutez au moins une table : sans table, Suppernote ne peut proposer aucun créneau.',
      });
    }
    if (
      body.action === 'complete' &&
      body.task === 'floor' &&
      !hasConfiguredRules(restaurant.exposureSettings?.capacitySpecials)
    ) {
      return reply.status(409).send({
        code: 'NO_RULES',
        error: 'Enregistrez vos règles de réservation, dont la durée d’un repas.',
      });
    }
    if (
      body.action === 'complete' &&
      body.task === 'floor' &&
      !hasAnsweredPracticalInfo(restaurant.practicalInfo, restaurant.ambiance)
    ) {
      return reply.status(409).send({
        code: 'NO_PRACTICAL_INFO',
        error:
          'Répondez aux questions pratiques (terrasse, parking, accessibilité, animaux, menu enfant, privatisation) : vos clients les posent avant de réserver.',
      });
    }

    const currentState = computeOnboardingState({ ...restaurant, floorStats });
    if (body.action === 'complete' && body.task === 'channels' && !currentState.readiness.ready) {
      return reply.status(409).send({
        code: 'NOT_READY_TO_BOOK',
        error:
          'Complétez les horaires, les tables et les règles de réservation avant de continuer vers Suppernote Connect.',
      });
    }
    if (body.action === 'activate' && !currentState.onboardingDone) {
      return reply.status(409).send({
        error:
          "La mise en service ne peut pas être activée tant que l'onboarding n'est pas complet.",
      });
    }
    if (body.action === 'activate' && !currentState.readiness.ready) {
      return reply.status(409).send({
        code: 'NOT_READY_TO_BOOK',
        error:
          'Vos clients ne peuvent pas encore réserver : complétez les horaires, les tables et les règles de réservation.',
      });
    }

    let tasks: Record<OnboardingTask, OnboardingTaskState>;
    try {
      tasks = applyOnboardingTransition(currentState.tasks, body);
    } catch (err: unknown) {
      return reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
    }

    const now = new Date();
    if (body.action === 'first_call') {
      tasks.phone = {
        ...tasks.phone,
        status: 'completed',
        completedAt: tasks.phone.completedAt ?? now.toISOString(),
        metadata: {
          ...(tasks.phone.metadata ?? {}),
          testCallValidatedAt: now.toISOString(),
        },
      };
    }
    const nextState = computeOnboardingState({ ...restaurant, floorStats, onboardingTasks: tasks });
    const updated = await app.db.restaurant.update({
      where: { id: restaurantId },
      data: {
        onboardingTasks: nextState.tasks as unknown as Prisma.InputJsonValue,
        onboardingDone: nextState.onboardingDone,
        onboardingCompletedAt:
          nextState.onboardingDone && !restaurant.onboardingCompletedAt
            ? now
            : restaurant.onboardingCompletedAt,
        onboardingActivatedAt:
          body.action === 'activate' && !restaurant.onboardingActivatedAt
            ? now
            : restaurant.onboardingActivatedAt,
        firstCallAt:
          body.action === 'first_call' && !restaurant.firstCallAt ? now : restaurant.firstCallAt,
        testCallValidatedAt:
          body.action === 'first_call' && !restaurant.testCallValidatedAt
            ? now
            : restaurant.testCallValidatedAt,
        onboardingLastSeenAt: now,
      },
      include: { personality: true, exposureSettings: true, images: true },
    });

    const updatedState = computeOnboardingState({ ...updated, floorStats });
    const event = ONBOARDING_EVENT_BY_ACTION[body.action];
    if (event) {
      trackOnboardingEvent({
        event,
        restaurantId,
        userId: req.userId,
        task: body.task,
        metadata: {
          ...body.metadata,
          progress: updatedState.progress,
          completedCount: updatedState.completedCount,
          onboardingDone: updatedState.onboardingDone,
          reason: body.reason,
        },
      }).catch((err) => app.log.error({ err, restaurantId }, 'trackOnboardingEvent failed'));
    }

    // ─── Re-engagement : replace le timer à chaque interaction
    // Si onboardé mais pas de firstCall → rappel J+7 "testez votre assistant"
    // Sinon → rappel J+3 "il vous reste X étapes"
    const reengagementType: 'stalled' | 'inactive' | null = updatedState.onboardingDone
      ? updated.firstCallAt
        ? null
        : 'inactive'
      : updatedState.onboardingDone === false
        ? 'stalled'
        : null;
    if (reengagementType) {
      const delayDays = reengagementType === 'inactive' ? 7 : 3;
      const jobName = `reengagement-${reengagementType}`;
      await app.queues.onboarding.add(
        `${jobName}-${restaurantId}`,
        { restaurantId, type: reengagementType },
        { delay: delayDays * 24 * 60 * 60 * 1000, jobId: `${jobName}-${restaurantId}` },
      );
    }

    return reply.send(onboardingPayload(updated, updatedState));
  };

  // Création directe d'un restaurant avec son numéro : réservée aux opérateurs Suppernote. Les
  // restaurateurs passent par l'inscription (POST /api/auth/sync), qui pose un numéro provisoire.
  app.post('/restaurants', { preHandler: requirePlatformOperator() }, async (req, reply) => {
    const body = CreateRestaurantSchema.parse(req.body);
    try {
      const restaurant = await app.db.restaurant.create({
        data: body as Prisma.RestaurantUncheckedCreateInput,
      });
      await app.queues.eveningReport.upsertJobScheduler(
        `nightly-${restaurant.id}`,
        { pattern: '0 23 * * *', tz: 'Europe/Paris' },
        { name: 'nightly', data: { restaurantId: restaurant.id } },
      );
      return reply.status(201).send(restaurant);
    } catch (err: unknown) {
      if ((err as { code?: string })?.code === 'P2002') {
        return reply.status(409).send({ error: 'Phone number already registered' });
      }
      throw err;
    }
  });

  app.get('/restaurant/onboarding', { preHandler: requireOrg() }, getOnboarding);
  app.get('/api/restaurant/onboarding', { preHandler: requireOrg() }, getOnboarding);
  app.patch('/restaurant/onboarding', { preHandler: requireOrg() }, patchOnboarding);
  app.patch('/api/restaurant/onboarding', { preHandler: requireOrg() }, patchOnboarding);

  const getOnboardingFloor = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const [tables, stats] = await Promise.all([
      loadFloorSummary(app.db, restaurantId),
      loadFloorStats(app.db, restaurantId),
    ]);
    return reply.send({ tables, stats });
  };

  const putOnboardingFloor = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const body = QuickFloorSetupSchema.parse(req.body ?? {});
    const result = await applyQuickFloorSetup(app.db, restaurantId, body);
    const tables = await loadFloorSummary(app.db, restaurantId);
    return reply.send({ tables, ...result });
  };

  const putOnboardingPractical = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const body = PracticalInfoUpdateSchema.parse(req.body ?? {});
    const current = await app.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { practicalInfo: true, ambiance: true },
    });
    const practicalInfo = mergePracticalInfo(
      normalizePracticalInfo(current.practicalInfo),
      body.practicalInfo,
    );
    const updated = await app.db.restaurant.update({
      where: { id: restaurantId },
      data: {
        practicalInfo: practicalInfo as unknown as Prisma.InputJsonValue,
        ambiance: syncManagedFeatures(current.ambiance, body.practicalInfo),
        ...(body.dietary ? { dietary: body.dietary } : {}),
      },
      select: { practicalInfo: true, ambiance: true, dietary: true, phoneNumber: true, slug: true },
    });
    // L'assistant vocal lit ces faits depuis le contexte en cache, la page Connect depuis le sien.
    await invalidateRestaurantContextCache(updated.phoneNumber);
    if (updated.slug) {
      await app.redisCache.del(`connect:restaurant:${updated.slug}`).catch(() => {});
    }
    return reply.send({
      practicalInfo: normalizePracticalInfo(updated.practicalInfo),
      ambiance: updated.ambiance,
      dietary: updated.dietary,
    });
  };

  app.get('/restaurant/onboarding/floor', { preHandler: requireOrg() }, getOnboardingFloor);
  app.get('/api/restaurant/onboarding/floor', { preHandler: requireOrg() }, getOnboardingFloor);
  app.put('/restaurant/onboarding/floor', { preHandler: requireOrg() }, putOnboardingFloor);
  app.put('/api/restaurant/onboarding/floor', { preHandler: requireOrg() }, putOnboardingFloor);
  app.put('/restaurant/onboarding/practical', { preHandler: requireOrg() }, putOnboardingPractical);
  app.put(
    '/api/restaurant/onboarding/practical',
    { preHandler: requireOrg() },
    putOnboardingPractical,
  );

  // Site selector source of truth for the multi-site dashboard. The active
  // site is still enforced by requireOrg() on every subsequent route.
  app.get('/restaurants/sites', { preHandler: requireOrg() }, async (req, reply) => {
    try {
      const sites = await listAccessibleRestaurantSites(app.db, {
        organizationId: req.clerkOrganizationId ?? req.restaurantId,
        userId: req.userId,
      });
      return reply.send({
        accountId: req.accountId ?? null,
        activeSiteId: req.siteId ?? req.restaurantId,
        sites,
      });
    } catch (error) {
      if (error instanceof RestaurantContextError) {
        return reply.status(error.code === 'ACCOUNT_SUSPENDED' ? 403 : 404).send({
          error: error.code,
          message: 'Établissements indisponibles ou accès refusé.',
        });
      }
      throw error;
    }
  });

  // Les opérations de cycle de vie d'un établissement sont réservées au
  // propriétaire du compte. Le rôle est résolu côté serveur ; l'UI ne peut
  // pas s'auto-attribuer un accès en envoyant un autre accountId.
  app.post('/restaurants/sites', { preHandler: requireOrg() }, async (req, reply) => {
    if (req.siteRole !== 'OWNER' || !req.accountId) {
      return reply.status(403).send({ error: 'SITE_ADMIN_REQUIRED' });
    }

    const input = CreateSiteSchema.parse(req.body ?? {});
    const [account, currentSite, activeSiteCount] = await Promise.all([
      app.db.restaurantAccount.findUnique({
        where: { id: req.accountId },
        select: { id: true, status: true },
      }),
      app.db.restaurant.findUnique({
        where: { id: req.restaurantId },
        select: { accountId: true, plan: true },
      }),
      app.db.restaurant.count({
        where: { accountId: req.accountId, siteStatus: { not: 'ARCHIVED' } },
      }),
    ]);

    if (!account || account.status !== 'ACTIVE' || currentSite?.accountId !== req.accountId) {
      return reply.status(404).send({ error: 'ACCOUNT_NOT_FOUND' });
    }

    const accountBilling = await app.db.restaurantAccountBilling.findUnique({
      where: { accountId: req.accountId },
      select: { entitledSiteCount: true },
    });
    const entitledSiteCount =
      accountBilling?.entitledSiteCount ?? (currentSite.plan === 'PREMIUM' ? 2 : 1);
    if (activeSiteCount >= entitledSiteCount) {
      return reply.status(402).send({
        error: 'MULTI_SITE_SUBSCRIPTION_REQUIRED',
        message: 'La formule Multi-restaurant est nécessaire pour ajouter un établissement.',
      });
    }

    try {
      const restaurant = await app.db.restaurant.create({
        data: {
          accountId: req.accountId,
          isPrimary: false,
          siteStatus: 'ACTIVE',
          name: input.name,
          // Numéro Suppernote provisoire, comme à l'inscription : un opérateur attribue le vrai numéro
          // (provisioning). La ligne saisie par le restaurateur est sa ligne publique.
          phoneNumber: `+000site-${randomUUID()}`,
          phoneE164: normalizePhone(input.phoneNumber),
          managerPhone: input.managerPhone,
          managerEmail: input.managerEmail,
          openingHours: input.openingHours as Prisma.InputJsonValue,
          plan: currentSite.plan,
          provisioningStatus: 'PENDING',
        },
      });

      try {
        await app.queues.eveningReport.upsertJobScheduler(
          `nightly-${restaurant.id}`,
          { pattern: '0 23 * * *', tz: 'Europe/Paris' },
          { name: 'nightly', data: { restaurantId: restaurant.id } },
        );
      } catch (error) {
        req.log.warn({ err: error, restaurantId: restaurant.id }, 'Failed to schedule site report');
      }

      return reply.status(201).send({
        id: restaurant.id,
        name: restaurant.name,
        siteStatus: restaurant.siteStatus,
        isPrimary: restaurant.isPrimary,
        role: 'OWNER',
      });
    } catch (error: unknown) {
      if ((error as { code?: string })?.code === 'P2002') {
        return reply.status(409).send({ error: 'PHONE_NUMBER_ALREADY_REGISTERED' });
      }
      throw error;
    }
  });

  app.patch('/restaurants/sites/:id', { preHandler: requireOrg() }, async (req, reply) => {
    if (req.siteRole !== 'OWNER' || !req.accountId) {
      return reply.status(403).send({ error: 'SITE_ADMIN_REQUIRED' });
    }

    const { id } = req.params as { id: string };
    const input = UpdateSiteSchema.parse(req.body ?? {});
    const site = await app.db.restaurant.findUnique({
      where: { id },
      select: { id: true, accountId: true, isPrimary: true, siteStatus: true, name: true },
    });
    if (!site || site.accountId !== req.accountId) {
      return reply.status(404).send({ error: 'SITE_NOT_FOUND' });
    }

    const deactivatingPrimary =
      site.isPrimary &&
      input.siteStatus !== undefined &&
      input.siteStatus !== 'ACTIVE' &&
      input.siteStatus !== site.siteStatus;

    const updated = await app.db.$transaction(async (tx) => {
      if (deactivatingPrimary) {
        const replacement = await tx.restaurant.findFirst({
          where: {
            accountId: req.accountId,
            id: { not: id },
            siteStatus: 'ACTIVE',
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        if (!replacement) return null;
        await tx.restaurant.update({
          where: { id: replacement.id },
          data: { isPrimary: true },
        });
      }

      return tx.restaurant.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.siteStatus !== undefined ? { siteStatus: input.siteStatus } : {}),
          ...(deactivatingPrimary ? { isPrimary: false } : {}),
        },
        select: { id: true, name: true, siteStatus: true, isPrimary: true },
      });
    });
    if (!updated) {
      return reply.status(409).send({
        error: 'PRIMARY_SITE_REQUIRED',
        message: 'Conservez au moins un établissement actif avant de désactiver le principal.',
      });
    }
    return reply.send({ ...updated, role: 'OWNER' });
  });

  app.post('/restaurants/sites/:id/members', { preHandler: requireOrg() }, async (req, reply) => {
    if (req.siteRole !== 'OWNER' || !req.accountId) {
      return reply.status(403).send({ error: 'SITE_ADMIN_REQUIRED' });
    }

    const { id: restaurantId } = req.params as { id: string };
    const input = SiteMemberSchema.parse(req.body ?? {});
    const site = await app.db.restaurant.findUnique({
      where: { id: restaurantId },
      select: { id: true, accountId: true, siteStatus: true },
    });
    if (!site || site.accountId !== req.accountId || site.siteStatus === 'ARCHIVED') {
      return reply.status(404).send({ error: 'SITE_NOT_FOUND' });
    }

    try {
      const { existing, membership } = await app.db.$transaction(
        async (tx) => {
          await lockAccountMemberships(tx, req.accountId!);
          await assertClerkOrganizationMember({
            organizationId: req.clerkOrganizationId,
            userId: input.clerkUserId,
          });
          const accountMembership = await tx.restaurantAccountMembership.findFirst({
            where: { accountId: req.accountId, restaurantId: null, clerkUserId: input.clerkUserId },
            select: { role: true },
          });
          if (accountMembership?.role === 'READ_ONLY' && input.role !== 'READ_ONLY') {
            return { existing: null, membership: null };
          }
          const existing = await tx.restaurantAccountMembership.findFirst({
            where: { accountId: req.accountId, restaurantId, clerkUserId: input.clerkUserId },
          });
          const membership = existing
            ? await tx.restaurantAccountMembership.update({
                where: { id: existing.id },
                data: { role: input.role },
              })
            : await tx.restaurantAccountMembership.create({
                data: {
                  accountId: req.accountId!,
                  restaurantId,
                  clerkUserId: input.clerkUserId,
                  role: input.role,
                },
              });
          return { existing, membership };
        },
        { timeout: 30000 },
      );
      if (!membership) {
        return reply.status(409).send({
          error: 'ACCOUNT_READ_ONLY',
          message:
            'Ce membre est en lecture seule sur tout le compte. Modifiez d’abord son rôle de compte.',
        });
      }
      return reply.status(existing ? 200 : 201).send({
        id: membership.id,
        restaurantId,
        clerkUserId: input.clerkUserId,
        role: membership.role,
      });
    } catch (error) {
      if (error instanceof ClerkMembershipVerificationError) {
        if (error.code === 'NOT_MEMBER') {
          return reply.status(422).send({
            error: 'CLERK_MEMBER_REQUIRED',
            message: 'L’utilisateur doit d’abord appartenir à votre organisation Clerk.',
          });
        }
        req.log.error({ err: error }, 'Clerk membership verification unavailable');
        return reply.status(503).send({
          error: 'CLERK_MEMBERSHIP_UNAVAILABLE',
          message: 'Impossible de vérifier l’utilisateur auprès de Clerk.',
        });
      }
      throw error;
    }
  });

  app.delete(
    '/restaurants/sites/:id/members/:clerkUserId',
    { preHandler: requireOrg() },
    async (req, reply) => {
      if (req.siteRole !== 'OWNER' || !req.accountId) {
        return reply.status(403).send({ error: 'SITE_ADMIN_REQUIRED' });
      }

      const { id: restaurantId, clerkUserId } = req.params as {
        id: string;
        clerkUserId: string;
      };
      const site = await app.db.restaurant.findUnique({
        where: { id: restaurantId },
        select: { accountId: true },
      });
      if (!site || site.accountId !== req.accountId) {
        return reply.status(404).send({ error: 'SITE_NOT_FOUND' });
      }

      try {
        const removed = await app.db.$transaction(
          async (tx) => {
            await lockAccountMemberships(tx, req.accountId!);
            const membership = await tx.restaurantAccountMembership.findFirst({
              where: { accountId: req.accountId, restaurantId, clerkUserId },
            });
            if (!membership) return false;
            const remaining = await tx.restaurantAccountMembership.count({
              where: { accountId: req.accountId, clerkUserId, id: { not: membership.id } },
            });
            if (!remaining) {
              if (!req.clerkOrganizationId) throw new Error('Missing Clerk organization');
              try {
                await clerkClient.organizations.updateOrganizationMembershipMetadata({
                  organizationId: req.clerkOrganizationId,
                  userId: clerkUserId,
                  publicMetadata: { [SOKAR_ROLE_METADATA_KEY]: 'REVOKED' },
                });
              } catch (error) {
                if ((error as { status?: number } | null)?.status !== 404) throw error;
              }
            }
            await tx.restaurantAccountMembership.delete({ where: { id: membership.id } });
            return true;
          },
          { timeout: 30000 },
        );
        if (!removed) return reply.status(404).send({ error: 'SITE_MEMBER_NOT_FOUND' });
      } catch {
        return reply.status(503).send({
          error: 'CLERK_MEMBERSHIP_UNAVAILABLE',
          message: 'Impossible de retirer cet accès pour le moment.',
        });
      }
      return reply.status(204).send();
    },
  );

  app.get('/restaurants/:id', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    return reply.send(
      await app.db.restaurant.findUniqueOrThrow({
        where: { id },
        include: { personality: true, exposureSettings: true },
      }),
    );
  });

  app.get(
    '/restaurants/:id/public',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const restaurant = await app.db.restaurant.findUniqueOrThrow({
          where: { id },
          select: {
            id: true,
            publishedAt: true,
            agenticOptIn: true,
            exposureSettings: { select: { connectPublished: true } },
            slug: true,
            giftCardEnabled: true,
            name: true,
            openingHours: true,
            phoneNumber: true,
          },
        });
        const {
          publishedAt: _publishedAt,
          agenticOptIn: _agenticOptIn,
          exposureSettings: _exposureSettings,
          ...publicRestaurant
        } = restaurant;
        return reply.send({
          ...publicRestaurant,
          bookingEnabled: isPublicConnectPage(restaurant),
          whatsappReminderOptInEnabled: process.env.WHATSAPP_CONSENT_ENABLED === 'true',
        });
      } catch (err) {
        app.log.error({ err }, 'Restaurant fetch failed');
        return reply.status(404).send({ error: 'Restaurant not found' });
      }
    },
  );

  // Public route by slug — used by the embeddable widget (suppernote.com/widget/{slug}).
  // Renvoie les champs nécessaires au rendu de l'iframe + l'id Prisma
  // pour que le widget puisse enchaîner sur les routes /restaurants/{id}/*.
  // Pas d'auth : endpoint public, même politique que /restaurants/:id/public.
  //
  // Note : on n'utilise PAS /public/r/:slug (déjà déclaré par Suppernote Connect) parce
  // que ce dernier filtre sur connectPublished. Les métadonnées restent accessibles
  // pour les aperçus/cartes cadeaux ; bookingEnabled annonce la capacité de réserver.
  app.get(
    '/public/widget/:slug',
    { config: { rateLimit: { max: publicReadMax(60), timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { slug } = req.params as { slug: string };
      try {
        const select = {
          id: true,
          publishedAt: true,
          agenticOptIn: true,
          exposureSettings: { select: { connectPublished: true } },
          name: true,
          openingHours: true,
          phoneNumber: true,
          // Champs Suppernote Connect utiles pour le rendu
          slug: true,
          city: true,
          cuisineType: true,
          coverImageUrl: true,
          formattedAddress: true,
          giftCardEnabled: true,
          floorPlans: {
            where: { isDefault: true, isActive: true },
            select: {
              sections: {
                select: { id: true, name: true },
                orderBy: { name: 'asc' },
              },
            },
          },
        } satisfies Prisma.RestaurantSelect;
        const alias = getDemoSlugAlias(slug);
        // tenant-scoping: global — resolve the unique public slug; only public widget data is returned.
        const restaurant =
          (await app.db.restaurant.findUnique({ where: { slug }, select })) ??
          (alias ? await app.db.restaurant.findUnique({ where: { slug: alias }, select }) : null);
        if (!restaurant) return reply.status(404).send({ error: 'Restaurant not found' });
        const defaultFloorPlan = restaurant.floorPlans?.[0];
        const {
          publishedAt: _publishedAt,
          agenticOptIn: _agenticOptIn,
          exposureSettings: _exposureSettings,
          ...publicRestaurant
        } = restaurant;
        return reply.send({
          ...publicRestaurant,
          slug: canonicalDemoSlug(restaurant.slug ?? slug),
          bookingEnabled: isPublicConnectPage(restaurant),
          sections: defaultFloorPlan?.sections ?? [],
          whatsappReminderOptInEnabled: process.env.WHATSAPP_CONSENT_ENABLED === 'true',
        });
      } catch (err) {
        app.log.error({ err, slug }, 'Restaurant fetch by slug (widget) failed');
        return reply.status(404).send({ error: 'Restaurant not found' });
      }
    },
  );

  app.patch('/restaurants/:id', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const body = UpdateRestaurantSchema.parse(req.body ?? {});
    const { capacitySpecials, ...restaurantData } = body;

    const current = await app.db.restaurant.findUniqueOrThrow({
      where: { id },
      select: { phoneNumber: true, name: true },
    });

    if (capacitySpecials) {
      const currentSettings = await app.db.restaurantExposureSettings.upsert({
        where: { restaurantId: id },
        create: { restaurantId: id },
        update: {},
      });
      const mergedCapacitySpecials = {
        ...((currentSettings.capacitySpecials as Record<string, unknown>) || {}),
        ...capacitySpecials,
      };
      await app.db.restaurantExposureSettings.update({
        where: { restaurantId: id },
        data: { capacitySpecials: mergedCapacitySpecials as unknown as Prisma.InputJsonValue },
      });
    }

    const updated = await app.db.restaurant.update({ where: { id }, data: restaurantData });
    if (updated.name !== current.name) requestGreetingWarm();
    await Promise.all(
      Array.from(new Set([current.phoneNumber, updated.phoneNumber])).map((phoneNumber) =>
        invalidateRestaurantContextCache(phoneNumber),
      ),
    );
    // Invalider le cache Connect (données publiques du restaurant)
    if (updated.slug) {
      await app.redisCache.del(`connect:restaurant:${updated.slug}`).catch(() => {});
    }
    return reply.send(updated);
  });

  // ─── Personnalité de l'agent vocal ─────────────────────────────

  app.get('/restaurants/:id/personality', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const personality = await app.db.agentPersonality.findUnique({ where: { restaurantId: id } });
    return reply.send(personality ?? {});
  });

  app.patch('/restaurants/:id/personality', { preHandler: requireOrg() }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const body = UpdatePersonalitySchema.parse(req.body);

    const personality = await app.db.agentPersonality.upsert({
      where: { restaurantId: id },
      create: { restaurantId: id, ...body },
      update: body,
    });

    // Invalider le cache du restaurant pour que le nouveau system prompt soit pris en compte
    const restaurant = await app.db.restaurant.findUniqueOrThrow({ where: { id } });
    await invalidateRestaurantContextCache(restaurant.phoneNumber);

    // Accueil composé pour ce style : prêt avant le prochain appel (jamais bloquant en cas d'échec).
    await resolveStyledGreeting(
      restaurant.name,
      { profileType: personality.profileType, fillerStyle: personality.fillerStyle },
      { attempts: 2, timeoutMs: 4_000 },
    ).catch(() => null);
    requestGreetingWarm();

    return reply.send(personality);
  });

  // ─── Appel test onboarding : vérifie la ligne publique du restaurant ───────
  // Le déclenchement est journalisé comme appel en attente ; la validation
  // intervient uniquement après confirmation explicite du gérant.

  const TestCallSchema = z.object({
    // Compatibilité avec les anciennes versions du dashboard. Le serveur utilise phoneE164.
    phoneNumber: z.string().optional(),
  });
  const TestCallPhoneSchema = z.string().regex(/^\+[1-9]\d{9,14}$/);

  const postTestCall = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    TestCallSchema.parse(req.body ?? {});
    const restaurant = await app.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { personality: true },
    });

    if (!hasUsablePhone(restaurant.phoneNumber)) {
      return reply.status(409).send({
        code: 'NO_PHONE_ASSIGNED',
        error:
          "Aucun numéro Suppernote attribué à ce restaurant. L'appel test vérifie que le renvoi arrive jusqu'à ce numéro : l'équipe Suppernote doit d'abord vous en attribuer un. Vous pouvez continuer les autres étapes en attendant, et contacter le support si l'attribution tarde.",
      });
    }

    const restaurantPhone = TestCallPhoneSchema.safeParse(
      normalizePhone(restaurant.phoneE164?.trim() ?? ''),
    );
    if (!restaurantPhone.success) {
      return reply.status(409).send({
        code: 'NO_RESTAURANT_PHONE',
        error: 'Renseignez le numéro public du restaurant au format international.',
      });
    }

    const baseUrl = process.env.PUBLIC_API_URL ?? `${req.protocol}://${req.headers.host}`;
    const webhookUrl = `${baseUrl}/voice/telnyx`;

    try {
      const { callControlId } = await placeOutboundCall(restaurantPhone.data, {
        webhookUrl,
        clientState: {
          kind: 'onboarding_test_call',
          restaurantId,
        },
        timeoutSecs: 30,
      });

      const now = new Date();
      const tasks = normalizeTasks(restaurant.onboardingTasks);
      tasks.phone = {
        ...tasks.phone,
        metadata: {
          ...(tasks.phone.metadata ?? {}),
          testCallControlId: callControlId,
          testCallRequestedAt: now.toISOString(),
        },
      };
      await app.db.restaurant.update({
        where: { id: restaurantId },
        data: {
          onboardingTasks: tasks as unknown as Prisma.InputJsonValue,
          onboardingLastSeenAt: now,
        },
      });

      return reply.send({
        ok: true,
        callControlId,
        message: 'Appel test déclenché. Confirmez sa réception après avoir entendu l’assistant.',
      });
    } catch (err: unknown) {
      logger.error({ err, restaurantId }, '[onboarding] test call failed');
      return reply.status(502).send({
        code: 'TELNYX_FAILED',
        error:
          "L'appel test n'a pas pu être déclenché (opérateur injoignable ou erreur réseau). Réessayez dans quelques minutes, ou contactez le support si le problème persiste.",
        detail:
          process.env.NODE_ENV === 'production'
            ? undefined
            : String(err instanceof Error ? err.message : err),
      });
    }
  };

  // ─── Demo call (audio preview, pas d'appel Telnyx réel) ────────────────
  // Synthétise un script fixe avec la personnalité courante du restaurant
  // pour donner un aha moment mid-onboarding (étape 3, avant l'étape phone).
  // Fallback transcript-only si CARTESIA_API_KEY absente (dev local par design).
  const DemoCallSchema = z.object({
    scriptId: z.enum(['reservation', 'cancellation', 'menu']).default('reservation'),
  });

  const DEMO_SCRIPTS: Record<string, (name: string) => string> = {
    reservation: (name) =>
      `Bonjour, ici ${name}. Je regarde les disponibilités pour deux personnes ce soir. Vous souhaiteriez venir vers quelle heure ?`,
    cancellation: (name) => `Bonjour, ici ${name}. Bien sûr. À quel nom est la réservation ?`,
    menu: (name) =>
      `Bonjour, ici ${name}. Je peux regarder ça avec vous. Vous cherchez plutôt un plat ou une entrée végétarienne ?`,
  };

  const postDemoCall = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;
    const body = DemoCallSchema.parse(req.body ?? {});
    const restaurant = await app.db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      include: { personality: true },
    });

    const scriptFn = DEMO_SCRIPTS[body.scriptId] ?? DEMO_SCRIPTS.reservation;
    const transcript = scriptFn(restaurant.name);

    if (!isCartesiaConfigured()) {
      // Dev local par design : pas de clé Cartesia → transcript seul.
      return reply.send({
        audio: null,
        transcript,
        scriptId: body.scriptId,
        fallback: true,
        message: 'Audio disponible après configuration de la clé Cartesia.',
      });
    }

    // Cache Redis 5 min : évite un 2e call Cartesia (~1s) quand l'utilisateur
    // rejoue le même scénario. Le hash du texte invalide aussi le cache dès
    // qu'un script change ; la variante couvre voix, locale et réglages.
    const speed = restaurant.personality?.speakingRate
      ? Number(restaurant.personality.speakingRate)
      : undefined;
    const locale = normalizeVoiceLocale('fr-FR') ?? 'fr-FR';
    const voiceId = getCartesiaVoiceId({ personality: restaurant.personality });
    const generationConfig = getCartesiaGenerationConfig({
      personality: restaurant.personality
        ? {
            fillerStyle: restaurant.personality.fillerStyle,
            speakingRate: speed,
            volume: restaurant.personality.volume ? Number(restaurant.personality.volume) : 1,
            emotion: restaurant.personality.emotion,
          }
        : null,
    });
    const cacheVariant = buildCartesiaCacheVariant({
      voiceId,
      locale,
      codec: 'mp3-24k',
      generationConfig,
      pronunciationDictId: restaurant.personality?.pronunciationDictId ?? undefined,
    });
    const scriptHash = createHash('sha256').update(transcript).digest('hex').slice(0, 12);
    const cacheKey = `demo-call:${restaurantId}:${body.scriptId}:${scriptHash}:${CARTESIA_MODEL}:${CARTESIA_NORMALIZATION}:${cacheVariant}`;
    const cached = await redisCache.getBuffer(cacheKey);
    if (cached) {
      // Hit cache : on track l'event quand même (l'utilisateur a écouté)
      trackOnboardingEvent({
        event: 'onboarding_demo_call_played',
        restaurantId,
        userId: req.userId,
        task: 'knowledge',
        metadata: { scriptId: body.scriptId, hasAudio: true, cached: true },
      }).catch((err) => app.log.error({ err, restaurantId }, 'trackOnboardingEvent failed'));

      reply.type('audio/mpeg');
      return reply.send(cached);
    }

    try {
      const audio = await synthesizeText({
        text: transcript,
        speed,
        voiceId,
        locale,
        normalization: CARTESIA_NORMALIZATION,
        pronunciationDictId: restaurant.personality?.pronunciationDictId ?? undefined,
      });

      if (!audio) {
        return reply.send({ audio: null, transcript, scriptId: body.scriptId, fallback: true });
      }

      // Stocke l'audio en cache pour 5 minutes
      await redisCache.set(cacheKey, audio, 'EX', 300);

      trackOnboardingEvent({
        event: 'onboarding_demo_call_played',
        restaurantId,
        userId: req.userId,
        task: 'knowledge',
        metadata: { scriptId: body.scriptId, hasAudio: true },
      }).catch((err) => app.log.error({ err, restaurantId }, 'trackOnboardingEvent failed'));

      reply.type('audio/mpeg');
      return reply.send(audio);
    } catch (err: unknown) {
      logger.error(
        { err, restaurantId, scriptId: body.scriptId },
        '[onboarding] demo call TTS failed',
      );
      return reply.status(502).send({
        code: 'CARTESIA_FAILED',
        error:
          "La synthèse vocale n'a pas pu être générée. Réessayez dans quelques minutes, ou contactez le support si le problème persiste.",
        transcript,
        detail:
          process.env.NODE_ENV === 'production'
            ? undefined
            : String(err instanceof Error ? err.message : err),
      });
    }
  };

  // ─── Démonstration en direct (appel navigateur, pipeline vocal réel) ────
  // Émet un ticket à usage unique : le WebSocket `/voice/demo-stream/:ticket` est public, c'est ce
  // ticket (émis ici, après authentification) qui l'autorise. Aucune écriture métier n'est faite
  // pendant la démonstration : les réservations et messages sont simulés par la session `demo`.
  const postLiveDemo = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;

    const unavailable = liveDemoUnavailableReason();
    if (unavailable || !(await isVoicePipelineEnabled(restaurantId))) {
      return reply.status(503).send({
        code: 'LIVE_DEMO_UNAVAILABLE',
        error:
          "L'appel en direct n'est pas disponible pour le moment. Vous pouvez écouter l'aperçu pré-enregistré.",
      });
    }

    const issued = await issueLiveDemoTicket(redisCache, restaurantId);
    if (!issued.ok) {
      return reply.status(429).send({
        code: 'LIVE_DEMO_DAILY_LIMIT',
        error:
          "Vous avez atteint le nombre d'appels d'essai pour aujourd'hui. Réessayez demain ou écoutez l'aperçu pré-enregistré.",
      });
    }

    trackOnboardingEvent({
      event: 'onboarding_demo_call_played',
      restaurantId,
      userId: req.userId,
      task: 'knowledge',
      metadata: { mode: 'live' },
    }).catch((err) => app.log.error({ err, restaurantId }, 'trackOnboardingEvent failed'));

    const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
    return reply.send({
      ticket: issued.ticket,
      wsUrl: buildLiveDemoWsUrl(publicUrl, issued.ticket),
      maxDurationSec: LIVE_DEMO_MAX_DURATION_SEC,
    });
  };

  const patchConnect = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const body = UpdateConnectSchema.parse(req.body ?? {});

    if (body.slug && isOfficialDemoSlug(body.slug)) {
      return reply.status(409).send({ error: 'Ce slug est réservé à la démonstration.' });
    }

    // 1. Check slug uniqueness if provided
    if (body.slug) {
      const existing = await app.db.restaurant.findUnique({
        where: { slug: body.slug },
      });
      if (existing && existing.id !== restaurantId) {
        return reply
          .status(409)
          .send({ error: 'Ce slug est déjà utilisé par un autre restaurant.' });
      }
    }

    // 2. Fetch existing settings to merge capacitySpecials
    const currentSettings = await app.db.restaurantExposureSettings.upsert({
      where: { restaurantId },
      create: { restaurantId },
      update: {},
    });

    const currentCapacitySpecials =
      (currentSettings.capacitySpecials as Record<string, unknown>) || {};
    const newCapacitySpecials = {
      ...currentCapacitySpecials,
      ...(body.capacitySpecials || {}),
    };

    // 3. Prepare updates
    const now = new Date();
    const restaurantData: Prisma.RestaurantUpdateInput = {};
    if (body.slug !== undefined) restaurantData.slug = body.slug;
    if (body.description !== undefined) restaurantData.description = body.description;
    if (body.formattedAddress !== undefined)
      restaurantData.formattedAddress = body.formattedAddress;
    if (body.city !== undefined) restaurantData.city = body.city;
    if (body.postalCode !== undefined) restaurantData.postalCode = body.postalCode;
    if (body.country !== undefined) restaurantData.country = body.country;
    if (body.lat !== undefined) restaurantData.lat = body.lat;
    if (body.lng !== undefined) restaurantData.lng = body.lng;
    if (body.cuisineType !== undefined) restaurantData.cuisineType = body.cuisineType;
    if (body.priceRange !== undefined) restaurantData.priceRange = body.priceRange;
    if (body.ambiance !== undefined) restaurantData.ambiance = body.ambiance;
    if (body.dietary !== undefined) restaurantData.dietary = body.dietary;
    if (body.coverImageUrl !== undefined) restaurantData.coverImageUrl = body.coverImageUrl;

    // Gating activation / publication.
    // La page publique exige `connectPublished && slug && publishedAt`
    // (cf. connect.service.ts) : publier sans slug marquerait la fiche comme
    // publiée sans jamais créer de page, et l'opérateur le découvrirait sans
    // message d'erreur.
    if (body.connectPublished) {
      const currentRestaurant = await app.db.restaurant.findUnique({
        where: { id: restaurantId },
        select: { slug: true },
      });
      const effectiveSlug = body.slug ?? currentRestaurant?.slug ?? null;
      if (!effectiveSlug) {
        return reply.status(409).send({
          code: 'CONNECT_SLUG_REQUIRED',
          missing: ['slug'],
        });
      }
      restaurantData.publishedAt = now;
      restaurantData.agenticOptIn = true;
    }

    const settingsData: Prisma.RestaurantExposureSettingsUpdateInput = {
      capacitySpecials: newCapacitySpecials as unknown as Prisma.InputJsonValue,
    };
    if (body.maxPartySize !== undefined) settingsData.maxPartySize = body.maxPartySize;
    if (body.connectPublished !== undefined) {
      settingsData.connectPublished = body.connectPublished;
      if (body.connectPublished) {
        settingsData.connectPublishedAt = now;
      }
    }
    if (body.connectAgentic !== undefined) settingsData.connectAgentic = body.connectAgentic;

    // Suppernote Connect P2 — premium subdomain
    if (body.customDomain !== undefined) {
      const newDomain = body.customDomain;
      const existingDomain = currentSettings.customDomain;

      if (newDomain === null) {
        // Désactivation : supprimer le Custom Hostname sur Cloudflare + clear DB
        if (existingDomain && currentSettings.customDomainCfId) {
          try {
            await deleteCustomHostname(currentSettings.customDomainCfId);
          } catch (err) {
            logger.warn(
              { err, cfId: currentSettings.customDomainCfId },
              '[connect] Failed to delete CF Custom Hostname (continuing)',
            );
          }
        }
        settingsData.customDomain = null;
        settingsData.customDomainStatus = null;
        settingsData.customDomainValidatedAt = null;
        settingsData.customDomainCfId = null;
      } else if (newDomain !== existingDomain) {
        // Changement de domaine : vérifier unicité + provisionner sur Cloudflare
        const conflict = await app.db.restaurantExposureSettings.findFirst({
          where: { customDomain: newDomain, restaurantId: { not: restaurantId } },
        });
        if (conflict) {
          return reply
            .status(409)
            .send({ error: 'Ce domaine est déjà utilisé par un autre restaurant.' });
        }

        // Supprimer l'ancien Custom Hostname si existant
        if (existingDomain && currentSettings.customDomainCfId) {
          try {
            await deleteCustomHostname(currentSettings.customDomainCfId);
          } catch (err) {
            logger.warn(
              { err, cfId: currentSettings.customDomainCfId },
              '[connect] Failed to delete old CF Custom Hostname (continuing)',
            );
          }
        }

        if (isCloudflareSaaSEnabled()) {
          try {
            const cfResult = await createCustomHostname(newDomain);
            settingsData.customDomain = newDomain;
            settingsData.customDomainStatus = cfResult.status;
            settingsData.customDomainCfId = cfResult.id;
            settingsData.customDomainValidatedAt = cfResult.status === 'active' ? now : null;
          } catch (err) {
            logger.error(
              { err, domain: newDomain },
              '[connect] CF Custom Hostname creation failed',
            );
            return reply
              .status(502)
              .send({ error: 'Impossible de provisionner le domaine sur Cloudflare. Réessayez.' });
          }
        } else {
          // Dev/test mode : pas de Cloudflare, on stocke juste le domaine
          settingsData.customDomain = newDomain;
          settingsData.customDomainStatus = 'pending';
          settingsData.customDomainCfId = null;
          settingsData.customDomainValidatedAt = null;
        }
      }
    }

    // 4. Update Database in a transaction
    const [updatedRestaurant, updatedSettings] = await app.db.$transaction([
      app.db.restaurant.update({
        where: { id: restaurantId },
        data: restaurantData,
        include: { personality: true, images: true },
      }),
      app.db.restaurantExposureSettings.update({
        where: { restaurantId },
        data: settingsData,
      }),
    ]);

    // Invalidate caches
    await invalidateRestaurantContextCache(updatedRestaurant.phoneNumber);
    if (updatedRestaurant.slug) {
      const cacheKey = `connect:restaurant:${updatedRestaurant.slug}`;
      await app.redisCache.del(cacheKey);
    }
    if (updatedSettings.customDomain) {
      const domainCacheKey = `connect:custom-domain:${updatedSettings.customDomain}`;
      await app.redisCache.del(domainCacheKey);
    }

    return reply.send({
      restaurant: updatedRestaurant,
      exposureSettings: updatedSettings,
    });
  };

  const postImage = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const body = PostImageSchema.parse(req.body ?? {});

    if (body.isCover) {
      await app.db.restaurantImage.updateMany({
        where: { restaurantId, isCover: true },
        data: { isCover: false },
      });
    }

    const image = await app.db.restaurantImage.create({
      data: {
        restaurantId,
        url: body.url,
        isCover: body.isCover,
        position: body.position,
        alt: body.alt,
      },
    });

    if (body.isCover) {
      await app.db.restaurant.update({
        where: { id: restaurantId },
        data: { coverImageUrl: body.url },
      });
    }

    return reply.status(201).send(image);
  };

  const checkSlug = async (req: FastifyRequest, reply: FastifyReply) => {
    const { slug } = req.query as { slug?: string };
    if (!slug) {
      return reply.status(400).send({ error: 'Slug requis' });
    }
    const regex = /^[a-z0-9-]+$/;
    if (!regex.test(slug)) {
      return reply.status(400).send({
        error: 'Format du slug invalide (lettres minuscules, chiffres, tirets uniquement)',
      });
    }
    const existing = await app.db.restaurant.findUnique({
      where: { slug },
    });
    const available = !isOfficialDemoSlug(slug) && (!existing || existing.id === req.restaurantId);
    return reply.send({ available });
  };

  app.post('/restaurant/onboarding/test-call', { preHandler: requireOrg() }, postTestCall);
  app.post('/api/restaurant/onboarding/test-call', { preHandler: requireOrg() }, postTestCall);

  // Lien Connect signé pour réserver « comme un client » sans polluer le restaurant.
  // Le jeton n'est jamais journalisé.
  app.post(
    '/restaurant/test-booking-link',
    { preHandler: requireOrg(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!isTestBookingEnabled()) {
        return reply.status(404).send({ code: 'TEST_BOOKING_DISABLED' });
      }
      const restaurant = await app.db.restaurant.findUnique({
        where: { id: req.restaurantId },
        select: {
          slug: true,
          publishedAt: true,
          agenticOptIn: true,
          exposureSettings: { select: { connectPublished: true } },
        },
      });
      if (!restaurant || !restaurant.slug || !isPublicConnectPage(restaurant)) {
        return reply.status(409).send({
          code: 'PAGE_NOT_PUBLISHED',
          error: 'Publiez d’abord votre page pour la tester.',
        });
      }
      const url = new URL(`/restaurant/${encodeURIComponent(restaurant.slug)}`, env.SITE_URL);
      url.searchParams.set('testBooking', issueTestBookingToken(req.restaurantId));
      return reply.send({ url: url.toString() });
    },
  );

  const postOnboardingPlaceSearch = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOnboardingPlacesEnabled()) {
      return reply.status(503).send({
        error:
          'La recherche de restaurant n’est pas disponible. Vous pouvez saisir les informations manuellement.',
      });
    }
    const body = OnboardingPlaceSearchSchema.parse(req.body);
    try {
      const suggestions = await searchOnboardingPlaces(body.query, body.sessionToken);
      return reply.send({ suggestions });
    } catch (err) {
      app.log.warn(
        { reason: err instanceof Error ? err.message : 'unknown' },
        '[onboarding] Google Places search failed',
      );
      return reply.status(502).send({ error: 'La recherche est temporairement indisponible.' });
    }
  };

  const postOnboardingPlaceDetails = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isOnboardingPlacesEnabled()) {
      return reply.status(503).send({
        error:
          'La recherche de restaurant n’est pas disponible. Vous pouvez saisir les informations manuellement.',
      });
    }
    const body = OnboardingPlaceDetailsSchema.parse(req.body);
    try {
      const place = await getOnboardingPlaceDetails(body.placeId, body.sessionToken);
      return reply.send(place);
    } catch (err) {
      app.log.warn(
        { reason: err instanceof Error ? err.message : 'unknown' },
        '[onboarding] Google Places details failed',
      );
      return reply.status(502).send({ error: 'Les informations du lieu sont indisponibles.' });
    }
  };

  app.post(
    '/restaurant/onboarding/places/autocomplete',
    { preHandler: requireOrg(), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    postOnboardingPlaceSearch,
  );
  app.post(
    '/restaurant/onboarding/places/details',
    { preHandler: requireOrg(), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    postOnboardingPlaceDetails,
  );

  app.post(
    '/restaurant/onboarding/demo-call',
    { preHandler: requireOrg(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    postDemoCall,
  );
  app.post(
    '/api/restaurant/onboarding/demo-call',
    { preHandler: requireOrg(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    postDemoCall,
  );

  app.post(
    '/restaurant/onboarding/live-demo',
    { preHandler: requireOrg(), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    postLiveDemo,
  );
  app.post(
    '/api/restaurant/onboarding/live-demo',
    { preHandler: requireOrg(), config: { rateLimit: { max: 6, timeWindow: '1 minute' } } },
    postLiveDemo,
  );

  app.patch('/restaurants/:id/connect', { preHandler: requireOrg() }, patchConnect);
  app.patch('/api/restaurants/:id/connect', { preHandler: requireOrg() }, patchConnect);

  // Suppernote Connect — GET settings
  // Returns the restaurant's Suppernote Connect configuration (gating flags, slug, page URL).
  const getConnect = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;

    const restaurant = await app.db.restaurant.findUnique({
      where: { id: restaurantId },
      include: { exposureSettings: true },
    });

    if (!restaurant) {
      return reply.status(404).send({ error: 'Restaurant not found' });
    }

    const slug = restaurant.slug;
    const exposure = restaurant.exposureSettings;

    return reply.send({
      restaurantId,
      slug,
      name: restaurant.name,
      connectPublished: exposure?.connectPublished ?? false,
      connectAgentic: exposure?.connectAgentic ?? false,
      connectPublishedAt: exposure?.connectPublishedAt?.toISOString() ?? null,
      pageUrl: slug ? `${env.SITE_URL}/restaurant/${slug}` : null,
      capacitySpecials: (exposure?.capacitySpecials as Record<string, unknown> | null) ?? null,
      customDomain: exposure?.customDomain ?? null,
      customDomainStatus: exposure?.customDomainStatus ?? null,
    });
  };

  app.get('/restaurants/:id/connect', { preHandler: requireOrg() }, getConnect);
  app.get('/api/restaurants/:id/connect', { preHandler: requireOrg() }, getConnect);

  // Suppernote Connect — GET score de complétude
  // Calcule le score de profil 0-100% + items manquants + copy contextuel.
  const getConnectScore = async (req: FastifyRequest, reply: FastifyReply) => {
    const restaurantId = req.restaurantId;

    const restaurant = await app.db.restaurant.findUnique({
      where: { id: restaurantId },
      include: {
        exposureSettings: true,
        images: { select: { id: true } },
      },
    });

    if (!restaurant) {
      return reply.status(404).send({ error: 'Restaurant not found' });
    }

    const score = computeConnectScore({
      restaurant,
      exposure: restaurant.exposureSettings,
      images: restaurant.images,
    });

    return reply.send(score);
  };

  app.get('/restaurants/:id/connect/score', { preHandler: requireOrg() }, getConnectScore);
  app.get('/api/restaurants/:id/connect/score', { preHandler: requireOrg() }, getConnectScore);

  // Suppernote Connect P2 — premium subdomain verification
  const verifyCustomDomainDns = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const restaurantId = req.restaurantId;
    if (id !== restaurantId) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    const settings = await app.db.restaurantExposureSettings.findUnique({
      where: { restaurantId },
    });
    if (!settings?.customDomain) {
      return reply.status(400).send({ error: 'Aucun domaine personnalisé configuré.' });
    }

    // 1. Vérifier le CNAME localement (feedback immédiat)
    const cnameResult = await verifyCname(settings.customDomain);

    // 2. Si CF est configuré, rafraîchir le statut depuis Cloudflare
    let cfStatus: string | null = null;
    if (settings.customDomainCfId && isCloudflareSaaSEnabled()) {
      try {
        const cfResult = await getCustomHostname(settings.customDomainCfId);
        cfStatus = cfResult.status;
        const now = new Date();
        await app.db.restaurantExposureSettings.update({
          where: { restaurantId },
          data: {
            customDomainStatus: cfResult.status,
            customDomainValidatedAt:
              cfResult.status === 'active' ? now : settings.customDomainValidatedAt,
          },
        });
      } catch (err) {
        logger.warn({ err, cfId: settings.customDomainCfId }, '[connect] CF status refresh failed');
      }
    }

    return reply.send({
      domain: settings.customDomain,
      cnameValid: cnameResult.valid,
      cnameTarget: cnameResult.target,
      message: cnameResult.message,
      cfStatus,
      overallStatus: cfStatus ?? (cnameResult.valid ? 'dns_validated' : 'pending'),
    });
  };

  app.post(
    '/restaurants/:id/connect/verify-dns',
    { preHandler: requireOrg(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    verifyCustomDomainDns,
  );
  app.post(
    '/api/restaurants/:id/connect/verify-dns',
    { preHandler: requireOrg(), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    verifyCustomDomainDns,
  );

  app.post('/restaurants/:id/images', { preHandler: requireOrg() }, postImage);
  app.post('/api/restaurants/:id/images', { preHandler: requireOrg() }, postImage);
  app.get('/restaurants/check-slug', { preHandler: requireOrg() }, checkSlug);
  app.get('/api/restaurants/check-slug', { preHandler: requireOrg() }, checkSlug);
}
