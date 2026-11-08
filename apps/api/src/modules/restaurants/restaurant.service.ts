import { db } from '../../shared/db/client';
import { getCachedContext, setCachedContext, redisCache } from '../../shared/redis/client';
import * as Sentry from '@sentry/node';
import {
  CARTESIA_MODEL,
  DEFAULT_MAX_PARTY_SIZE,
  DEFAULT_CARTESIA_VOICE_ID,
  INTERNAL_CALL_ALERT_THRESHOLD,
  REDIS_CTX_TTL_SECONDS,
} from '@suppernote/config';
import { voiceConfig } from '../../env';
import { getRestaurantPlanOverride } from '../../shared/configcat';
import { DAY_SECONDS } from '../../shared/constants/time.js';
import { getVoiceLlmProvider, type VoiceLlmProvider } from '../voice/llm-provider';
import { isPublicConnectPage } from '../connect/connect.types';
import { normalizeOpeningHours, isConnectDemoSlug } from '@suppernote/shared';

// Fixture synthétique de prisma/seed.ts : jamais une destination de transfert réelle.
const DEMO_SEED_MANAGER_PHONE = '+33601020304';

/** TTL du compteur mensuel d'appels : ~33 jours en secondes */
const MONTHLY_CALL_COUNTER_TTL_SECONDS = 33 * DAY_SECONDS;

interface SafeProviderConfig {
  readonly carrier: string;
  readonly sttProvider: 'deepgram';
  readonly sttModel: string;
  readonly llmProvider: VoiceLlmProvider;
  readonly llmModel: string;
  readonly ttsProvider: 'cartesia';
  readonly ttsModel: string;
  readonly voiceId: string;
}

interface CachedRestaurantContext {
  readonly id: string;
  readonly name: string;
  readonly slug: string | null;
  readonly publishedAt: Date | null;
  readonly agenticOptIn: boolean;
  readonly onlineReservationsActive: boolean;
  readonly plan: string;
  readonly managerPhone: string;
  readonly managerEmail: string;
  readonly phoneNumber: string;
  readonly timezone: string;
  readonly formattedAddress: string | null;
  readonly city: string | null;
  readonly cuisineType: string[];
  /** Contextes en cache d'avant ces champs : `loadContext` les recalcule sous 5 min. */
  readonly practicalInfo?: unknown;
  readonly dietary?: string[];
  readonly ambiance?: string[];
  readonly openingHours: unknown;
  readonly carrier: string;
  readonly smsConfirmEnabled: boolean;
  readonly giftCardMinimumAmount: number | null;
  /**
   * Taille de groupe réservable automatiquement (incluse), partagée avec le
   * canal agentique. Sans ligne de réglages : 7, comme le téléphone avant.
   */
  readonly maxPartySize: number;
  readonly personality: {
    readonly id: string;
    readonly restaurantId: string;
    readonly profileType: string;
    readonly speakingRate: unknown;
    readonly volume: unknown;
    readonly pitchShift: unknown;
    readonly fillerStyle: string;
    readonly microphoneThreshold: number;
    readonly targetLatencyMs: number;
    readonly systemPromptExtra: string | null;
    readonly voiceIdCa: string | null;
    readonly pronunciationDictId: string | null;
    readonly emotion: string | null;
    readonly updatedAt: Date;
  } | null;
  readonly providerConfig: SafeProviderConfig;
}

function getCurrentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function buildProviderConfig(restaurant: {
  carrier: string;
  personality: { voiceIdCa: string | null } | null;
}): SafeProviderConfig {
  return {
    carrier: restaurant.carrier,
    sttProvider: 'deepgram',
    sttModel: 'nova-3',
    llmProvider: getVoiceLlmProvider(),
    llmModel: voiceConfig.VOICE_LLM_MODEL,
    ttsProvider: 'cartesia',
    ttsModel: CARTESIA_MODEL,
    voiceId:
      restaurant.personality?.voiceIdCa ??
      process.env.CARTESIA_VOICE_ID ??
      DEFAULT_CARTESIA_VOICE_ID,
  };
}

function toCachedRestaurantContext(restaurant: {
  id: string;
  name: string;
  slug: string | null;
  publishedAt: Date | null;
  agenticOptIn: boolean;
  plan: string;
  managerPhone: string;
  managerEmail: string;
  phoneNumber: string;
  timezone: string;
  formattedAddress: string | null;
  city: string | null;
  cuisineType: string[];
  practicalInfo: unknown;
  dietary: string[];
  ambiance: string[];
  openingHours: unknown;
  carrier: string;
  smsConfirmEnabled: boolean;
  giftCardMinimumAmount: number | null;
  exposureSettings: { maxPartySize: number; connectPublished: boolean } | null;
  personality: CachedRestaurantContext['personality'];
}): CachedRestaurantContext {
  return {
    id: restaurant.id,
    name: restaurant.name,
    slug: restaurant.slug,
    publishedAt: restaurant.publishedAt,
    agenticOptIn: restaurant.agenticOptIn,
    onlineReservationsActive: isPublicConnectPage(restaurant),
    plan: restaurant.plan,
    managerPhone:
      isConnectDemoSlug(restaurant.slug ?? '') &&
      restaurant.managerPhone === DEMO_SEED_MANAGER_PHONE
        ? ''
        : restaurant.managerPhone,
    managerEmail: restaurant.managerEmail,
    phoneNumber: restaurant.phoneNumber,
    timezone: restaurant.timezone,
    formattedAddress: restaurant.formattedAddress ?? null,
    city: restaurant.city ?? null,
    cuisineType: restaurant.cuisineType ?? [],
    practicalInfo: restaurant.practicalInfo ?? {},
    dietary: restaurant.dietary ?? [],
    ambiance: restaurant.ambiance ?? [],
    openingHours: restaurant.openingHours,
    carrier: restaurant.carrier,
    smsConfirmEnabled: restaurant.smsConfirmEnabled,
    giftCardMinimumAmount: restaurant.giftCardMinimumAmount,
    maxPartySize: restaurant.exposureSettings?.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE,
    personality: restaurant.personality,
    providerConfig: buildProviderConfig(restaurant),
  };
}

const RESTAURANT_CONTEXT_SELECT = {
  id: true,
  name: true,
  slug: true,
  publishedAt: true,
  agenticOptIn: true,
  plan: true,
  managerPhone: true,
  managerEmail: true,
  phoneNumber: true,
  timezone: true,
  formattedAddress: true,
  city: true,
  cuisineType: true,
  practicalInfo: true,
  dietary: true,
  ambiance: true,
  openingHours: true,
  carrier: true,
  smsConfirmEnabled: true,
  giftCardMinimumAmount: true,
  exposureSettings: {
    select: {
      maxPartySize: true,
      connectPublished: true,
    },
  },
  personality: {
    select: {
      id: true,
      restaurantId: true,
      profileType: true,
      speakingRate: true,
      volume: true,
      pitchShift: true,
      fillerStyle: true,
      microphoneThreshold: true,
      targetLatencyMs: true,
      systemPromptExtra: true,
      voiceIdCa: true,
      pronunciationDictId: true,
      emotion: true,
      updatedAt: true,
    },
  },
} as const;

export async function invalidateRestaurantContextCache(phoneNumber: string | null | undefined) {
  if (!phoneNumber) return;
  await redisCache.del(`phone:${phoneNumber}`);
}

export class RestaurantService {
  static async loadContext(phoneNumberId: string): Promise<CachedRestaurantContext> {
    const cacheKey = `phone:${phoneNumberId}`;
    const cached = await getCachedContext(cacheKey);
    if (cached) {
      const context = cached as CachedRestaurantContext;
      if (
        isConnectDemoSlug(context.slug ?? '') &&
        context.managerPhone === DEMO_SEED_MANAGER_PHONE
      ) {
        return { ...context, managerPhone: '' };
      }
      return context;
    }

    // tenant-scoping: global — résolution du tenant lui-même par son numéro Suppernote unique (routage
    // d'un appel entrant) : il n'existe pas encore de `restaurantId` à filtrer.
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { phoneNumber: phoneNumberId },
      select: RESTAURANT_CONTEXT_SELECT,
    });
    const context = toCachedRestaurantContext(restaurant);

    // Apply plan override from ConfigCat. Fail-open: if SDK is absent or the
    // dashboard returns an invalid value, the DB plan is preserved.
    const effectivePlan = await getRestaurantPlanOverride(restaurant.id, context.plan);
    const contextWithPlan =
      effectivePlan === context.plan ? context : { ...context, plan: effectivePlan };

    await setCachedContext(cacheKey, contextWithPlan, REDIS_CTX_TTL_SECONDS);
    return contextWithPlan;
  }

  /**
   * Contexte vocal d'un restaurant identifié par son id, sans cache. Sert à la démonstration
   * d'onboarding : le restaurant n'a pas encore de numéro Suppernote, et la personnalité vient d'être
   * modifiée, donc un contexte en cache serait périmé.
   */
  static async loadContextById(restaurantId: string): Promise<CachedRestaurantContext> {
    // tenant-scoping: global — `Restaurant` est le tenant lui-même : la clé primaire est celle du
    // restaurant authentifié (ticket de démonstration émis pour `req.restaurantId`).
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: RESTAURANT_CONTEXT_SELECT,
    });
    const context = toCachedRestaurantContext(restaurant);
    const effectivePlan = await getRestaurantPlanOverride(restaurant.id, context.plan);
    return effectivePlan === context.plan ? context : { ...context, plan: effectivePlan };
  }

  /**
   * Compte les appels du mois et prévient (Sentry) au-delà du seuil de suivi interne. Il n'y a plus de
   * disjoncteur horaire : il refusait des appels sur un chiffre posé à la main (200/h) ; le plafond d'appels
   * simultanés (call-capacity.ts) protège le serveur.
   */
  static async recordMonthlyCall(restaurantId: string): Promise<void> {
    const monthKey = getCurrentMonthKey();
    const countKey = `infra:calls:${restaurantId}:${monthKey}`;
    const count = await redisCache.incr(countKey);
    if (count === 1) await redisCache.expire(countKey, MONTHLY_CALL_COUNTER_TTL_SECONDS);

    if (count > INTERNAL_CALL_ALERT_THRESHOLD) {
      Sentry.captureMessage(`[MARGIN] Restaurant ${restaurantId} atteint ${count} appels ce mois`, {
        level: 'warning',
        tags: { restaurantId, monthKey },
      });
    }
  }

  static isOpen(ctx: { openingHours: unknown }, date: string, time: string): boolean {
    const d = new Date(`${date}T${time}`);
    const mins = d.getHours() * 60 + d.getMinutes();
    return normalizeOpeningHours(ctx.openingHours).some((period) => {
      if (period.dayIndex !== d.getDay()) return false;
      const [openHour, openMinute] = period.open.split(':').map(Number);
      const [closeHour, closeMinute] = period.close.split(':').map(Number);
      const opensAt = openHour * 60 + openMinute;
      const closesAt = closeHour * 60 + closeMinute;
      return mins >= opensAt && mins < closesAt;
    });
  }
}
