/**
 * OpenAI Reserve service : expose le business feed (paginé, change-detection)
 * + tool restaurant_reservation au format Apps SDK.
 *
 * Les données viennent de `restaurants` (filtre openaiReserveEnabled = true).
 * Le format de sortie est verrouillé par les Zod schemas OpenAI.
 */

import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { canonicalDemoSlug } from '@suppernote/shared';
import {
  type Business,
  type BusinessAddress,
  type FeedQuery,
  type FeedResponse,
  type RestaurantReservationInput,
  type RestaurantReservationOutput,
} from './schemas';
import { WIDGET_PUBLIC_URL } from './constants';
import { env } from '../../../env';
import { redisCache } from '../../../shared/redis/client';
import { alertFailOpen } from '../../../shared/observability/alerts';

// TTL du cache Redis pour le business feed (en secondes).
// Le feed ne change pas a chaque requete (les restaurants n'activent/desactivent
// pas openaiReserveEnabled en continu). 120s = bon compromis fraicheur/charge DB.
const FEED_CACHE_TTL_SECONDS = 120;

export class OpenaiReserveService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly cache:
      | Redis
      | {
          get: (k: string) => Promise<string | null>;
          set: (k: string, v: string, mode?: string, ttl?: number) => Promise<string>;
        } = redisCache,
  ) {}

  /**
   * Business feed : retourne la liste paginée des restos qui ont
   * activé OpenAI Reserve et qui ont tous les champs requis.
   *
   * Note : on NE ré-exporte PAS un resto qui n'a pas lat/lng/phone/website.
   * C'est volontaire — c'est l'admin (Phase 2) qui gate opt-in sur ces champs.
   */
  async getBusinessFeed(query: FeedQuery): Promise<FeedResponse> {
    // Cache Redis : si la meme requete (page + page_size + changes_token) arrive
    // dans les 120s, on sert le cache sans taper Prisma. Fail-open si Redis down.
    const cacheKey = `openai-reserve:feed:${query.page}:${query.page_size}:${query.changes_token ?? ''}`;
    try {
      const cached = await this.cache.get(cacheKey);
      if (cached) {
        return JSON.parse(cached) as FeedResponse;
      }
    } catch (err) {
      // Redis down — fail-open, on continue sans cache
      alertFailOpen({ source: 'openai_reserve_cache', reason: 'cache_get_failed', err });
    }

    const where = {
      openaiReserveEnabled: true,
      // Filtre les restos qui n'ont pas tous les champs requis.
      // Si l'un des champs est null, le Prisma `not: null` le rejette.
      lat: { not: null },
      lng: { not: null },
      phoneE164: { not: null },
      websiteUrl: { not: null },
      formattedAddress: { not: null },
    } as const;

    const total = await this.prisma.restaurant.count({ where });
    const totalPages = Math.max(1, Math.ceil(total / query.page_size));

    // Si on a un changes_token, on pourrait ne retourner que les deltas.
    // Phase 4 : on retourne le full payload à chaque fois et on note
    // le timestamp comme nouveau changes_token.
    const restaurants = await this.prisma.restaurant.findMany({
      where,
      select: {
        id: true,
        name: true,
        slug: true,
        formattedAddress: true,
        phoneE164: true,
        websiteUrl: true,
        lat: true,
        lng: true,
        cuisineType: true,
        priceRange: true,
        openingHours: true,
      },
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.page_size,
      take: query.page_size,
    });

    const businesses: Business[] = restaurants.map((r) => this.toBusiness(r));

    // Si le caller passe un changes_token, on indique si la donnée a changé.
    // Phase 4 : on retourne toujours true (full reload). En production,
    // on stockerait un hash ETag et on comparerait.
    const checksum = query.changes_token ? this.computeChecksum(businesses) : true;

    const response: FeedResponse = {
      checksum,
      page: query.page,
      page_size: query.page_size,
      total_pages: totalPages,
      total,
      businesses,
      changes_token: query.changes_token || new Date().toISOString(),
    };

    // Met a jour le cache Redis (fail-open si Redis down)
    try {
      await this.cache.set(cacheKey, JSON.stringify(response), 'EX', FEED_CACHE_TTL_SECONDS);
    } catch (err) {
      // Redis down — fail-open, on continue sans cacher
      alertFailOpen({ source: 'openai_reserve_cache', reason: 'cache_set_failed', err });
    }

    return response;
  }

  /**
   * Tool restaurant_reservation : retourne la sortie que le widget charge.
   */
  async restaurantReservation(
    input: RestaurantReservationInput,
  ): Promise<RestaurantReservationOutput> {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: input.restaurant_id },
      select: {
        id: true,
        name: true,
        formattedAddress: true,
        lat: true,
        lng: true,
        openaiReserveEnabled: true,
        slug: true,
      },
    });

    if (!restaurant || !restaurant.openaiReserveEnabled) {
      throw new Error('Restaurant not found or not OpenAI Reserve enabled');
    }

    // Si le widget a passé une address optimistique, on l'utilise
    // pour éviter le loading state. Sinon on rebuild depuis la DB.
    let address: BusinessAddress | undefined;
    if (input.restaurant_address) {
      address = {
        line1: input.restaurant_address.address,
        locality: input.restaurant_address.city,
        region: input.restaurant_address.state,
        postal_code: input.restaurant_address.zipcode,
        country: input.restaurant_address.country,
        formatted: input.restaurant_address.address,
      };
    } else if (restaurant.formattedAddress) {
      address = this.parseAddress(restaurant.formattedAddress) as BusinessAddress;
    }

    return {
      restaurant_id: restaurant.id,
      restaurant_name: input.restaurant_name || restaurant.name,
      restaurant_address: address,
      widget_resource_url: WIDGET_PUBLIC_URL,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  private toNumberSafe(v: unknown): number {
    if (v == null) return 0;
    if (
      typeof v === 'object' &&
      v !== null &&
      typeof (v as { toNumber?: unknown }).toNumber === 'function'
    ) {
      return (v as { toNumber: () => number }).toNumber();
    }
    return Number(v);
  }

  private toBusiness(r: {
    id: string;
    name: string;
    slug: string | null;
    formattedAddress: string | null;
    phoneE164: string | null;
    websiteUrl: string | null;
    lat: unknown;
    lng: unknown;
    cuisineType: string[] | null;
    priceRange: number | null;
    openingHours: unknown;
  }): Business {
    // lat/lng sont stockés en Decimal dans Prisma → on appelle toNumber() si
    // présent, sinon Number() qui marche pour number et string.
    const latitude = this.toNumberSafe(r.lat);
    const longitude = this.toNumberSafe(r.lng);

    // Parse formattedAddress : "1 rue de Paris, 75001 Paris, France"
    // → décomposé en line1/locality/region/postal_code/country
    const address = this.parseAddress(r.formattedAddress);

    return {
      id: r.id,
      name: r.name,
      address,
      location: { latitude, longitude },
      phone_number: r.phoneE164 || '',
      website_url: r.websiteUrl,
      platform_url: `${env.SITE_URL}/restaurant/${canonicalDemoSlug(r.slug ?? r.id)}`,
      cuisine_type: r.cuisineType,
      price_range: r.priceRange,
      opening_hours: r.openingHours as Record<string, string[]> | null,
    };
  }

  private parseAddress(formatted: string | null): BusinessAddress | string {
    if (!formatted) return '';
    // Best-effort split sur la virgule. Si le format est custom, on renvoie
    // le formatted brut. OpenAI accepte l'un ou l'autre.
    const parts = formatted.split(',').map((s) => s.trim());
    if (parts.length < 2) return formatted;

    return {
      line1: parts[0],
      locality: parts[parts.length - 3] || parts[1],
      region: parts[parts.length - 2] || '',
      postal_code: '',
      country: 'FR',
      formatted,
    };
  }

  private computeChecksum(businesses: Business[]): boolean {
    // Hash simple : count + first/last IDs. OpenAI s'en sert pour savoir
    // si le feed a bougé depuis la dernière sync.
    if (businesses.length === 0) return false;
    const first = businesses[0].id;
    const last = businesses[businesses.length - 1].id;
    return `${businesses.length}:${first}:${last}` !== '0::';
  }
}
