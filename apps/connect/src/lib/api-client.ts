/**
 * Suppernote Connect — API client.
 *
 * En T4, on fetch l'API publique Fastify (apps/api) plutôt que d'importer
 * directement @suppernote/database. Cf. spec connect-v1.1 §6.6 :
 *   "apps/connect appelle GET /public/sitemap-data plutôt que
 *    d'importer du code apps/api directement."
 *
 * Avantages :
 * - Pas de couplage Prisma dans le build Next.js (sinon il faudrait
 *   builder le package database — anti-pattern workspace).
 * - API contractuel : le JSON est le même pour le front, l'admin, et les
 *   tests externes.
 * - Cacheable côté CDN (cf. spec §17.3 performance cible).
 *
 * Tradeoff : 1 requête HTTP supplémentaire par page. Acceptable
 * parce que (1) Next.js ISR cache 60s, (2) le cache L'API côté Fastify
 *   est 60s, (3) Cloudflare cache en edge.
 */

import { fetchWithTimeout } from '@suppernote/shared';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';

async function getApiUrl(): Promise<string> {
  // In server components, prefer API_URL (internal, no DNS resolution overhead).
  // Falls back to NEXT_PUBLIC_API_URL for client-side usage.
  if (typeof window === 'undefined') {
    return process.env.API_URL ?? 'http://localhost:3001';
  }
  return process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL ?? 'http://localhost:3001';
}

export type PublicRestaurantDto = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  address: {
    line1: string;
    postalCode?: string;
    city: string;
    country: string;
  };
  phone: string;
  cuisineTypes: string[];
  priceRange?: string;
  openingHours: Array<{ day: string; open: string; close: string }>;
  reservationUrl: string;
  images: { cover?: string; gallery: string[] };
  ambiance?: string[];
  dietary?: string[];
  noiseLevel?: string;
  acceptsReservations: boolean;
  publishedAt: string;
  /** Fuseau IANA du restaurant (absent pour une ancienne réponse en cache : Europe/Paris). */
  timezone?: string;
  connectAgentic: boolean;
  // Note agrégée (importée Google Places, Phase 3). Absent si pas de Place ID.
  aggregateRating?: {
    ratingValue: number;
    reviewCount: number;
    provider: 'google';
  };
};

export type WidgetRestaurantDto = {
  bookingEnabled?: boolean;
  id: string;
  slug: string;
  name: string;
  city: string;
  phoneNumber: string;
  cuisineType: string[];
  openingHours: Array<{ day: string; open: string; close: string }>;
  formattedAddress: string;
  coverImageUrl?: string | null;
  connectAgentic?: boolean;
  giftCardEnabled?: boolean;
  sections: Array<{ id: string; name: string }>;
};

export type AvailabilityDto = {
  restaurantId: string;
  date: string;
  partySize: number;
  slots: Array<{ time: string; available: boolean }>;
};

export type SitemapRestaurantEntry = {
  slug: string;
  updatedAt: string;
  publishedAt: string;
};

/**
 * Une limitation (429) ou une panne de l'API n'est pas une absence : on lève une erreur au lieu de
 * renvoyer null ou une liste vide, sinon la page publierait un faux « introuvable » ou un catalogue
 * vide. Next garde alors la dernière donnée en cache, ou affiche sa page d'erreur.
 */
// 400 = slug invalide : la page n'existe pas plus qu'en 404.
function isNotFound(res: Response): boolean {
  return res.status === 404 || res.status === 400;
}

function apiUnavailable(path: string, res: Response): Error {
  return new Error(`public API unavailable (${path} ${res.status})`);
}

/**
 * Récupère un restaurant publié par slug.
 * Renvoie null si introuvable ou non publié (404 géré).
 */
export async function fetchPublicRestaurant(
  slug: string,
  options: { revalidate?: number; tags?: string[]; preview?: boolean } = {},
): Promise<PublicRestaurantDto | null> {
  const query = options.preview ? '?preview=1' : '';
  const res = await fetch(`${await getApiUrl()}/public/r/${slug}${query}`, {
    next: {
      revalidate: options.preview ? 0 : (options.revalidate ?? 60),
      tags: options.tags ?? [`restaurant:${slug}`],
    },
  });
  if (isNotFound(res)) return null;
  if (!res.ok) throw apiUnavailable('/public/r/:slug', res);
  return (await res.json()) as PublicRestaurantDto;
}

/**
 * Récupère un restaurant par slug pour le widget embeddable.
 * Endpoint : GET /public/widget/:slug
 * Contrairement à /public/r/:slug, ce endpoint ne filtre pas sur
 * connectPublished et fonctionne pour tous les restaurants.
 */
export async function fetchWidgetRestaurant(
  slug: string,
  options: { revalidate?: number; tags?: string[] } = {},
): Promise<WidgetRestaurantDto | null> {
  const res = await fetch(`${await getApiUrl()}/public/widget/${slug}`, {
    next: {
      revalidate: options.revalidate ?? 60,
      tags: options.tags ?? [`widget:restaurant:${slug}`],
    },
  });
  if (isNotFound(res)) return null;
  if (!res.ok) throw apiUnavailable('/public/widget/:slug', res);
  return (await res.json()) as WidgetRestaurantDto;
}

/**
 * Récupère les slots disponibles pour (restaurantId, date, partySize).
 * Endpoint : GET /public/r/:slug/availability
 */
export async function fetchAvailability(
  slug: string,
  args: { date: string; partySize: number },
): Promise<AvailabilityDto | null> {
  try {
    const params = new URLSearchParams({
      date: args.date,
      partySize: String(args.partySize),
    });
    const res = await fetch(`${await getApiUrl()}/public/r/${slug}/availability?${params}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return null;
    }
    return (await res.json()) as AvailabilityDto;
  } catch {
    return null;
  }
}

export type PaginatedRestaurantsDto = {
  restaurants: PublicRestaurantDto[];
  total: number;
  page: number;
  limit: number;
};

/**
 * Liste paginée des restaurants publiés (Phase 6 — scalabilité homepage).
 * Endpoint : GET /public/restaurants?page=1&limit=12
 * Pagination réelle en DB, pas en mémoire.
 */
export async function fetchPublicRestaurants(
  page = 1,
  limit = 12,
  options: { revalidate?: number } = {},
): Promise<PaginatedRestaurantsDto> {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  try {
    const res = await fetch(`${await getApiUrl()}/public/restaurants?${params}`, {
      next: { revalidate: options.revalidate ?? 300 },
    });
    if (!res.ok) throw apiUnavailable('/public/restaurants', res);
    return (await res.json()) as PaginatedRestaurantsDto;
  } catch (error) {
    // Au build (CI sans API), il n'y a encore aucun cache à préserver : la page part vide et l'ISR
    // la régénère avec les vraies données. Au runtime, l'erreur garde la dernière page en cache.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      return { restaurants: [], total: 0, page, limit };
    }
    throw error;
  }
}

/**
 * Liste tous les slugs publiés pour le sitemap.
 * Endpoint : GET /public/sitemap-data
 * Cf. spec v1.1 §6.6 (le T8 utilise cet endpoint plutôt que Prisma direct).
 */
export async function fetchPublishedSlugs(): Promise<SitemapRestaurantEntry[]> {
  try {
    const res = await fetch(`${await getApiUrl()}/public/sitemap-data`, {
      next: { revalidate: 300 }, // 5 min
    });
    if (!res.ok) {
      return [];
    }
    const data = (await res.json()) as { restaurants: SitemapRestaurantEntry[] };
    return data.restaurants;
  } catch {
    return [];
  }
}

/**
 * Liste des villes avec compteurs (T7).
 * Endpoint : GET /public/cities
 */
export async function fetchCities(): Promise<
  Array<{
    city: string;
    citySlug: string;
    total: number;
    cuisines: Array<{ name: string; slug: string; count: number }>;
  }>
> {
  try {
    const res = await fetch(`${await getApiUrl()}/public/cities`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as {
      cities: Array<{
        city: string;
        citySlug: string;
        total: number;
        cuisines: Array<{ name: string; slug: string; count: number }>;
      }>;
    };
    return data.cities;
  } catch {
    return [];
  }
}

/** Ville telle que renvoyée par GET /public/cities. */
export type SitemapCity = {
  city: string;
  citySlug: string;
  total: number;
  cuisines: Array<{ name: string; slug: string; count: number }>;
};

const SITEMAP_FETCH_TIMEOUT_MS = 5000;

/**
 * Sources du sitemap : fiches publiées et villes. Contrairement à fetchPublishedSlugs et
 * fetchCities, un échec lève une erreur : un sitemap bâti sur une liste vide serait mis en cache
 * par Next (ISR, 5 min) puis publié aux moteurs de recherche comme la liste complète.
 */
export async function fetchSitemapSources(): Promise<{
  restaurants: SitemapRestaurantEntry[];
  cities: SitemapCity[];
}> {
  const apiUrl = await getApiUrl();
  const [restaurantsRes, citiesRes] = await Promise.all([
    fetch(`${apiUrl}/public/sitemap-data`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
    }),
    fetch(`${apiUrl}/public/cities`, {
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(SITEMAP_FETCH_TIMEOUT_MS),
    }),
  ]);
  if (!restaurantsRes.ok || !citiesRes.ok) {
    throw new Error(
      `sitemap source unavailable (sitemap-data ${restaurantsRes.status}, cities ${citiesRes.status})`,
    );
  }
  const restaurants = (await restaurantsRes.json()) as { restaurants: SitemapRestaurantEntry[] };
  const cities = (await citiesRes.json()) as { cities: SitemapCity[] };
  return { restaurants: restaurants.restaurants, cities: cities.cities };
}

/**
 * Page ville (T7) : restaurants d'une ville (avec filtre cuisine optionnel).
 * Endpoint : GET /public/cities/:slug?cuisine=
 */
export async function fetchCityPage(
  citySlug: string,
  cuisine?: string,
): Promise<import('./cities').CityCuisinePageData | null> {
  const params = new URLSearchParams();
  if (cuisine) params.set('cuisine', cuisine);
  const url = `${await getApiUrl()}/public/cities/${citySlug}${params.toString() ? `?${params}` : ''}`;
  const res = await fetch(url, { next: { revalidate: 300 } });
  if (isNotFound(res)) return null;
  if (!res.ok) throw apiUnavailable('/public/cities/:slug', res);
  return (await res.json()) as import('./cities').CityCuisinePageData;
}
