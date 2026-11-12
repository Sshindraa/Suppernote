/**
 * Availability service : coarse search + precise check de disponibilité.
 *
 * Coarse search : "quels restos ont des dispos à cette date pour N personnes ?"
 * Precise check : "le resto X a-t-il une table dispo à 19:30 pour 4 ?"
 *
 * Source de vérité : on regarde les AgenticHold ACTIVE et les Reservation
 * CONFIRMED/PENDING/SEATED. Les holds EXPIRED (même en avance) sont ignorés.
 *
 * Le modèle P0 ultra-conservateur : 1 seule table par slot/party_size.
 * Donc check_availability renvoie "available" si aucun hold actif + aucune
 * résa confirmée pour exactement (restaurant, slotStart, partySize).
 */

import type { PrismaClient } from '@prisma/client';
import { canonicalDemoSlug, isConnectDemoSlug } from '@suppernote/shared';
import type { RestaurantPolicyInput } from './policies.service.js';
import { buildPolicySnapshot } from './policies.service.js';
import {
  CapacityAwareAvailabilityService,
  zonedTimeToUtc,
} from '../../floor-plan/availability-capacity-aware.service.js';

/**
 * Les établissements fictifs de démonstration (`CONNECT_DEMO_SLUGS`) ne sortent pas d'une recherche
 * ouverte : un assistant IA ne doit pas les proposer à un vrai client. Ils restent accessibles quand
 * on les nomme exactement (« Chez Sokar »), ce qui sert aux essais et aux relecteurs d'annuaire.
 */
export function isHiddenDemoRestaurant(
  restaurant: { name: string; slug: string | null },
  restaurantName?: string,
): boolean {
  if (!restaurant.slug || !isConnectDemoSlug(restaurant.slug)) return false;
  const requested = restaurantName?.trim().toLocaleLowerCase('fr-FR');
  return !requested || requested !== restaurant.name.trim().toLocaleLowerCase('fr-FR');
}

/** Garde-fou : nombre max de candidats restaurant à évaluer par recherche */
const SEARCH_CANDIDATES_MAX = 200;

export type AvailabilityQuery = {
  restaurantId: string;
  partySize: number;
  slotStart: Date;
  slotEnd: Date;
};

export type AvailabilityResult = {
  available: boolean;
  alternativeSlots?: Array<{ startsAt: string; endsAt: string }>;
  conflictingHoldId?: string;
  conflictingReservationId?: string;
  reason?: 'hold_active' | 'reservation_confirmed' | 'party_size_exceeds_capacity' | 'unknown';
  /** Maximum party size that can be booked online for this restaurant. */
  maxOnlinePartySize?: number;
};

export type CapacityLimitHint = {
  restaurantId: string;
  name: string;
  slug: string | null;
  formattedAddress: string | null;
  cuisineType: string[];
  priceRange: number | null;
  maxOnlinePartySize: number;
};

export type RestaurantSearchResult = {
  restaurantId: string;
  name: string;
  slug: string | null;
  formattedAddress: string | null;
  cuisineType: string[];
  priceRange: number | null;
  distanceMeters: number | null;
};

type FloorPlanCapacitySnapshot = {
  tables?: Array<{ capacity: number }>;
};

/**
 * The online limit is the most restrictive of the restaurant policy and the
 * largest active physical table. Keeping this calculation in one place avoids
 * exposing a policy limit that the floor plan cannot actually fulfil.
 */
export function resolveEffectiveMaxPartySize(args: {
  policyMaxPartySize?: number | null;
  floorPlans?: FloorPlanCapacitySnapshot[] | null;
}): number | null {
  const policyMax =
    typeof args.policyMaxPartySize === 'number' && args.policyMaxPartySize > 0
      ? args.policyMaxPartySize
      : null;
  const tableCapacities = (args.floorPlans ?? [])
    .flatMap((floorPlan) => floorPlan.tables ?? [])
    .map((table) => table.capacity)
    .filter((capacity) => Number.isFinite(capacity) && capacity > 0);
  const physicalMax = tableCapacities.length > 0 ? Math.max(...tableCapacities) : null;

  if (policyMax === null) return physicalMax;
  if (physicalMax === null) return policyMax;
  return Math.min(policyMax, physicalMax);
}

export class AvailabilityService {
  private readonly capacityAware: CapacityAwareAvailabilityService;

  constructor(private readonly prisma: PrismaClient) {
    this.capacityAware = new CapacityAwareAvailabilityService(prisma);
  }

  /**
   * Coarse search : retourne les restos qui ont de la dispo pour une plage
   * donnée. Utilise une heuristique simple (count des holds + résas actives
   * par resto) et filtre ceux qui ont de la marge.
   */
  async searchAvailableRestaurants(args: {
    city: string;
    restaurantName?: string;
    partySize: number;
    slotStart: Date;
    slotEnd: Date;
    cuisineType?: string[];
    maxResults: number;
    cursor?: string;
  }): Promise<RestaurantSearchResult[]> {
    return (await this.searchAvailableRestaurantsPage(args)).results;
  }

  async searchAvailableRestaurantsPage(args: {
    city: string;
    restaurantName?: string;
    partySize: number;
    slotStart: Date;
    slotEnd: Date;
    cuisineType?: string[];
    maxResults: number;
    cursor?: string;
  }): Promise<{
    results: RestaurantSearchResult[];
    restaurantMatches: Array<Pick<RestaurantSearchResult, 'restaurantId' | 'name'>>;
    nextCursor?: string;
  }> {
    // Étape 1 : candidats (filtre ville + cuisine + opt-in)
    const candidates = await this.prisma.restaurant.findMany({
      where: {
        ...(args.cursor ? { id: { gt: args.cursor } } : {}),
        ...(args.restaurantName
          ? { name: { contains: args.restaurantName.trim(), mode: 'insensitive' as const } }
          : {}),
        agenticOptIn: true,
        exposureSettings: {
          is: {
            mcpEnabled: true,
          },
        },
        ...(args.cuisineType && args.cuisineType.length > 0
          ? { cuisineType: { hasSome: args.cuisineType } }
          : {}),
      },
      orderBy: { id: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        lat: true,
        lng: true,
        formattedAddress: true,
        cuisineType: true,
        priceRange: true,
      },
      take: SEARCH_CANDIDATES_MAX, // garde-fou
    });

    // Filtre grossier par adresse/ville (le partial match se fait côté DB via
    // un LIKE — l'index GIN pg_trgm accélérera en P1)
    const lowerCity = args.city.toLowerCase();
    // Étape 2 : pour chaque candidat, vérifie la dispo sur le slot exact
    const results: Array<{
      id: string;
      name: string;
      slug: string | null;
      formattedAddress: string | null;
      cuisineType: string[];
      priceRange: number | null;
    }> = [];
    const restaurantMatches: Array<Pick<RestaurantSearchResult, 'restaurantId' | 'name'>> = [];
    let lastScannedId: string | undefined;
    for (const c of candidates) {
      lastScannedId = c.id;
      const addr = c.formattedAddress?.toLowerCase() ?? '';
      if (lowerCity.length > 0 && !addr.includes(lowerCity)) continue;
      if (isHiddenDemoRestaurant(c, args.restaurantName)) continue;
      if (args.restaurantName) restaurantMatches.push({ restaurantId: c.id, name: c.name });
      const check = await this.checkAvailability({
        restaurantId: c.id,
        partySize: args.partySize,
        slotStart: args.slotStart,
        slotEnd: args.slotEnd,
      });
      if (check.available) {
        results.push({
          id: c.id,
          name: c.name,
          slug: c.slug ? canonicalDemoSlug(c.slug) : null,
          formattedAddress: c.formattedAddress,
          cuisineType: c.cuisineType,
          priceRange: c.priceRange,
        });
        if (results.length >= args.maxResults) break;
      }
    }

    return {
      results: results.map((r) => ({
        restaurantId: r.id,
        name: r.name,
        slug: r.slug,
        formattedAddress: r.formattedAddress,
        cuisineType: r.cuisineType,
        priceRange: r.priceRange,
        distanceMeters: null, // PostGIS en P1 si besoin
      })),
      restaurantMatches,
      nextCursor:
        lastScannedId &&
        (results.length >= args.maxResults || candidates.length >= SEARCH_CANDIDATES_MAX)
          ? lastScannedId
          : undefined,
    };
  }

  /**
   * Explains why a requested group is too large without pretending the
   * restaurant does not exist. This is intentionally separate from the
   * availability search so the normal result contract stays unchanged.
   */
  async findCapacityLimits(args: {
    city: string;
    restaurantName?: string;
    partySize: number;
    cuisineType?: string[];
    maxResults: number;
  }): Promise<CapacityLimitHint[]> {
    const candidates = await this.prisma.restaurant.findMany({
      where: {
        ...(args.restaurantName
          ? { name: { contains: args.restaurantName.trim(), mode: 'insensitive' as const } }
          : {}),
        agenticOptIn: true,
        exposureSettings: { is: { mcpEnabled: true } },
        ...(args.cuisineType && args.cuisineType.length > 0
          ? { cuisineType: { hasSome: args.cuisineType } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        formattedAddress: true,
        cuisineType: true,
        priceRange: true,
        exposureSettings: { select: { maxPartySize: true } },
        floorPlans: {
          where: { isActive: true },
          select: {
            tables: {
              where: { isActive: true },
              select: { capacity: true },
            },
          },
        },
      },
      take: SEARCH_CANDIDATES_MAX,
    });

    const lowerCity = args.city.toLowerCase();
    return candidates
      .filter((restaurant) => {
        const address = restaurant.formattedAddress?.toLowerCase() ?? '';
        if (isHiddenDemoRestaurant(restaurant, args.restaurantName)) return false;
        return lowerCity.length === 0 || address.includes(lowerCity);
      })
      .map((restaurant) => {
        const maxOnlinePartySize = resolveEffectiveMaxPartySize({
          policyMaxPartySize: restaurant.exposureSettings?.maxPartySize,
          floorPlans: restaurant.floorPlans,
        });
        if (maxOnlinePartySize === null || args.partySize <= maxOnlinePartySize) return null;
        return {
          restaurantId: restaurant.id,
          name: restaurant.name,
          slug: restaurant.slug ? canonicalDemoSlug(restaurant.slug) : null,
          formattedAddress: restaurant.formattedAddress,
          cuisineType: restaurant.cuisineType,
          priceRange: restaurant.priceRange,
          maxOnlinePartySize,
        } satisfies CapacityLimitHint;
      })
      .filter((hint): hint is CapacityLimitHint => hint !== null)
      .slice(0, args.maxResults);
  }

  /**
   * Precise check : est-ce que le slot est libre pour ce resto + party size ?
   * Renvoie un objet AvailabilityResult avec la raison du conflit.
   *
   * Wrapper autour de CapacityAwareAvailabilityService.
   */
  async checkAvailability(query: AvailabilityQuery): Promise<AvailabilityResult> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: query.restaurantId },
      select: {
        timezone: true,
        exposureSettings: { select: { maxPartySize: true } },
        floorPlans: {
          where: { isActive: true },
          select: {
            tables: {
              where: { isActive: true },
              select: { capacity: true },
            },
          },
        },
      },
    });
    if (!restaurant) {
      return { available: false, reason: 'unknown' };
    }

    const maxOnlinePartySize = resolveEffectiveMaxPartySize({
      policyMaxPartySize: restaurant.exposureSettings?.maxPartySize,
      floorPlans: restaurant.floorPlans,
    });
    if (maxOnlinePartySize !== null && query.partySize > maxOnlinePartySize) {
      return {
        available: false,
        reason: 'party_size_exceeds_capacity',
        maxOnlinePartySize,
      };
    }

    const timeZone = restaurant.timezone ?? 'Europe/Paris';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(query.slotStart);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    const dateStr = `${part('year')}-${part('month')}-${part('day')}`;
    const timeStr = `${part('hour')}:${part('minute')}`;

    const dto = await this.capacityAware.getAvailability({
      restaurantId: query.restaurantId,
      date: dateStr,
      partySize: query.partySize,
    });

    const slot = dto.slots.find((s) => s.time === timeStr);
    if (slot?.available) {
      return { available: true };
    }

    const durationMs = query.slotEnd.getTime() - query.slotStart.getTime();
    const alternativeSlots = dto.slots
      .filter((candidate) => candidate.available)
      .map((candidate) => zonedTimeToUtc(dateStr, candidate.time, timeZone))
      .filter((start) => start.getTime() > Date.now())
      .sort(
        (a, b) =>
          Math.abs(a.getTime() - query.slotStart.getTime()) -
          Math.abs(b.getTime() - query.slotStart.getTime()),
      )
      .slice(0, 5)
      .map((start) => ({
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + durationMs).toISOString(),
      }));
    return { available: false, reason: 'unknown', alternativeSlots };
  }

  /**
   * Renvoie les policy snapshot d'un restaurant.
   * Utilitaire pour chaînage avec hold.service et reservation.service.
   */
  async getPolicyFor(restaurantId: string): Promise<{
    policy: ReturnType<typeof buildPolicySnapshot>;
    settings: RestaurantPolicyInput | null;
  }> {
    const settings = await this.prisma.restaurantExposureSettings.findUnique({
      where: { restaurantId },
    });
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: { policyVersion: true },
    });

    const input: RestaurantPolicyInput = {
      policyVersion: restaurant?.policyVersion ?? '2026-06-20',
      maxPartySize: settings?.maxPartySize ?? null,
      minLeadTimeMinutes: settings?.minLeadTimeMinutes ?? null,
      requireManualValidation: settings?.requireManualValidation ?? null,
      quoteTtlSeconds: settings?.quoteTtlSeconds ?? null,
      holdTtlSeconds: settings?.holdTtlSeconds ?? null,
      noShowPolicy: settings?.noShowPolicy ?? null,
      notificationChannels: settings?.notificationChannels ?? [],
      capacitySpecials: (settings?.capacitySpecials as Record<string, unknown> | null) ?? null,
    };

    return {
      policy: buildPolicySnapshot(input),
      settings: input,
    };
  }
}
