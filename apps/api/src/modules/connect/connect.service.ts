/**
 * Suppernote Connect — Service principal.
 *
 * Responsabilités :
 * - lookup restaurant par slug
 * - vérif gating (connectPublished + connectAgentic)
 * - agrège Restaurant + ExposureSettings + RestaurantImage
 * - sérialise en PublicRestaurantDto
 * - cache Redis 60s
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import { logger } from '../../shared/logger/pino';
import { env } from '../../env';
import {
  canonicalDemoSlug,
  getDemoSlugAlias,
  normalizeOpeningHours as normalizeSharedOpeningHours,
} from '@suppernote/shared';
import {
  type OpeningHoursDay,
  type OpeningHoursSpec,
  PUBLIC_CONNECT_WHERE,
  DISCOVERABLE_CONNECT_WHERE,
  type PublicRestaurantDto,
  isPublicConnectPage,
  priceRangeToSymbol,
} from './connect.types';

const CACHE_TTL_SECONDS = 60;
const CACHE_KEY_PREFIX = 'connect:restaurant:';

export class ConnectService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly redis: Redis,
  ) {}

  /**
   * Récupère un restaurant publié par slug.
   * Renvoie null si introuvable, non publié, ou slug manquant.
   */
  async getPublishedBySlug(
    slug: string,
    options?: { preview?: boolean },
  ): Promise<PublicRestaurantDto | null> {
    const isPreview = options?.preview === true;
    const cacheKey = `${CACHE_KEY_PREFIX}${slug}`;

    if (!isPreview) {
      try {
        const cached = await this.redis.get(cacheKey);
        if (cached) {
          return JSON.parse(cached) as PublicRestaurantDto;
        }
      } catch (err) {
        // Cache miss / Redis down — fallback DB. On log mais on ne throw pas.
        logger.warn(
          { err: err instanceof Error ? err.message : err, slug },
          'connect cache read failed, falling back to DB',
        );
      }
    }

    const include = {
      exposureSettings: true,
      images: {
        orderBy: [{ isCover: 'desc' }, { position: 'asc' }],
      },
    } satisfies Prisma.RestaurantInclude;
    const alias = getDemoSlugAlias(slug);
    // tenant-scoping: global — the unique public slug resolves the public Connect page.
    const restaurant =
      (await this.prisma.restaurant.findUnique({ where: { slug }, include })) ??
      (alias ? await this.prisma.restaurant.findUnique({ where: { slug: alias }, include }) : null);

    if (!restaurant) {
      return null;
    }

    // Gating: la page publique requiert connectPublished + publishedAt + slug
    // (Bypassé en preview mode). Prédicat partagé, cf. connect.types.ts.
    if (!isPreview) {
      if (!isPublicConnectPage(restaurant)) {
        return null;
      }
    }

    const dto = this.toPublicDto(restaurant);

    // Cache write (best-effort, uniquement hors preview)
    if (!isPreview) {
      try {
        await this.redis.set(cacheKey, JSON.stringify(dto), 'EX', CACHE_TTL_SECONDS);
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err, slug },
          'connect cache write failed',
        );
      }
    }

    return dto;
  }

  /**
   * Récupère plusieurs restaurants publiés par slug en une seule query.
   * Évite un N+1 vs N appels à `getPublishedBySlug`.
   * Retourne les DTOs dans le même ordre que `slugs` (les slugs introuvables
   * ou non publiés sont filtrés).
   */
  async getPublishedBySlugs(slugs: string[]): Promise<PublicRestaurantDto[]> {
    if (slugs.length === 0) return [];

    const rows = await this.prisma.restaurant.findMany({
      where: {
        ...PUBLIC_CONNECT_WHERE,
        // On cherche des slugs précis : `in` remplace le `not: null` du where
        // partagé (une comparaison à des chaînes exclut déjà null).
        slug: { in: slugs },
      },
      include: {
        exposureSettings: true,
        images: {
          orderBy: [{ isCover: 'desc' }, { position: 'asc' }],
        },
      },
    });

    const dtoBySlug = new Map<string, PublicRestaurantDto>();
    for (const r of rows) {
      if (r.slug) dtoBySlug.set(r.slug, this.toPublicDto(r));
    }

    // Préserver l'ordre des slugs d'entrée (comportement identique à N getPublishedBySlug)
    return slugs
      .map((s) => dtoBySlug.get(s))
      .filter((d): d is PublicRestaurantDto => d !== undefined);
  }

  /**
   * Liste paginée des restaurants publiés (Phase 6 — scalabilité homepage).
   * Pagination réelle en DB (skip/take), pas en mémoire.
   * Retourne le DTO complet pour chaque restaurant (pour la grille homepage).
   */
  async getPublishedRestaurants(
    page: number,
    limit: number,
  ): Promise<{
    restaurants: PublicRestaurantDto[];
    total: number;
    page: number;
    limit: number;
  }> {
    const where = DISCOVERABLE_CONNECT_WHERE;

    const [total, rows] = await Promise.all([
      this.prisma.restaurant.count({ where }),
      this.prisma.restaurant.findMany({
        where,
        include: {
          exposureSettings: true,
          images: {
            orderBy: [{ isCover: 'desc' }, { position: 'asc' }],
          },
        },
        orderBy: { publishedAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const restaurants = rows.map((r) => this.toPublicDto(r));
    return { restaurants, total, page, limit };
  }

  /**
   * Invalide le cache d'un restaurant (à appeler sur update).
   * Le nom de la méthode matche le pattern des autres services Suppernote.
   */
  async invalidateSlugCache(slug: string): Promise<void> {
    try {
      await this.redis.del(`${CACHE_KEY_PREFIX}${slug}`);
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : err, slug },
        'connect cache invalidate failed',
      );
    }
  }

  /**
   * Helper: sérialise le modèle Prisma Restaurant en PublicRestaurantDto.
   * Gère le format openingHours (JSON libre) et l'extraction de la cover.
   */
  private toPublicDto(r: PublicRestaurantSource): PublicRestaurantDto {
    const slug = canonicalDemoSlug(r.slug!);
    const city = r.city ?? '';
    const country = r.country ?? 'FR';
    const addressLine1 = r.formattedAddress ?? '';

    // OpeningHours est un JSON libre (cf. seed: { tue: { open, close }, ... })
    const openingHours = normalizeOpeningHours(r.openingHours);

    // Cover: première image avec isCover=true, sinon première
    const cover = r.images.find((i) => i.isCover)?.url ?? r.images[0]?.url;
    const gallery = r.images.filter((i) => !i.isCover && i.url !== cover).map((i) => i.url);

    return {
      id: r.id,
      slug,
      name: r.name,
      description: r.description ?? undefined,
      address: {
        line1: addressLine1,
        postalCode: r.postalCode ?? undefined,
        city,
        country,
      },
      phone: r.phoneE164 ?? r.phoneNumber,
      cuisineTypes: r.cuisineType,
      priceRange: priceRangeToSymbol(r.priceRange),
      openingHours,
      reservationUrl: `${env.SITE_URL}/book/${slug}`,
      images: {
        cover,
        gallery,
      },
      ambiance: r.ambiance.length > 0 ? r.ambiance : undefined,
      dietary: r.dietary.length > 0 ? r.dietary : undefined,
      noiseLevel: r.noiseLevel ?? undefined,
      acceptsReservations: true,
      publishedAt: r.publishedAt!.toISOString(),
      timezone: r.timezone ?? undefined,
      connectAgentic: r.exposureSettings?.connectAgentic ?? false,
      lat: r.lat ? Number(r.lat) : undefined,
      lng: r.lng ? Number(r.lng) : undefined,
      aggregateRating:
        r.googleRating != null && r.googleReviewCount != null
          ? {
              ratingValue: r.googleRating,
              reviewCount: r.googleReviewCount,
              provider: 'google' as const,
            }
          : undefined,
    };
  }
}

/** Type du résultat Prisma findUnique avec les includes qu'on a demandés */
export type PublicRestaurantSource = {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  formattedAddress: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  phoneNumber: string;
  phoneE164: string | null;
  cuisineType: string[];
  priceRange: number | null;
  openingHours: unknown; // JSON
  ambiance: string[];
  dietary: string[];
  noiseLevel: string | null;
  agenticOptIn: boolean;
  publishedAt: Date | null;
  timezone?: string | null;
  lat: Prisma.Decimal | null;
  lng: Prisma.Decimal | null;
  googleRating: number | null;
  googleReviewCount: number | null;
  googlePlaceId: string | null;
  exposureSettings: {
    connectPublished: boolean;
    connectAgentic: boolean;
  } | null;
  images: { url: string; isCover: boolean; position: number }[];
};

/**
 * Normalise openingHours JSON en tableau plat trié par jour et par service.
 * Le format seed est { tue: { open, close }, ... }.
 * Le format étendu garde ces champs et ajoute services: [{ open, close }, ...].
 * Format alternatif { dayOfWeek, opens, closes }[] est aussi supporté.
 */
function normalizeOpeningHours(raw: unknown): OpeningHoursSpec {
  const dayByIndex: OpeningHoursDay['day'][] = [
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  const dayOrder: OpeningHoursDay['day'][] = [
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
  ];

  return normalizeSharedOpeningHours(raw)
    .map(({ dayIndex, open, close }) => ({ day: dayByIndex[dayIndex], open, close }))
    .sort(
      (a, b) => dayOrder.indexOf(a.day) - dayOrder.indexOf(b.day) || a.open.localeCompare(b.open),
    );
}

/** Hash helper pour le phone (RGPD anonymisation logs) */
export function hashPhone(phone: string): string {
  return createHash('sha256').update(phone.toLowerCase()).digest('hex').slice(0, 32);
}
