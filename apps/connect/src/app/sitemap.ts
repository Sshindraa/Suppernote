/**
 * Suppernote Connect — Sitemap dynamique Next.js.
 *
 * Utilise les endpoints publics /public/sitemap-data et /public/cities
 * (apps/api) plutôt que Prisma direct. Cf. spec v1.1 §6.6 + §7.5.
 *
 * Inclut :
 * - Pages de vitrine B2B (accueil, tarifs) et page assistant
 * - Pages restaurant /restaurant/[slug] (tous les publiés)
 * - Pages ville /restaurants/[city] (si ≥5 restos → indexable)
 * - Pages cuisine /restaurants/[city]/[cuisine] (si ville ≥10 ET cuisine ≥5)
 *
 * lastModified n'est renseigné que pour les fiches, dont la date est réelle. Un échec de l'API
 * fait échouer la génération au lieu de publier un sitemap tronqué.
 */

import type { MetadataRoute } from 'next';
import { isConnectDemoSlug } from '@suppernote/shared';
import { fetchSitemapSources } from '@/lib/api-client';

const SITE_URL = process.env.SITE_URL ?? 'https://suppernote.com';

// Rendu à la requête : le build n'appelle pas l'API (absente en CI). Les données restent en cache
// 5 min via fetchSitemapSources (next.revalidate). Une panne de l'API fait échouer la requête au
// lieu de publier un sitemap tronqué.
export const dynamic = 'force-dynamic';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const { restaurants: slugs, cities } = await fetchSitemapSources();

  const restaurantUrls: MetadataRoute.Sitemap = slugs
    .filter((entry) => !isConnectDemoSlug(entry.slug))
    .map((entry) => ({
      url: `${SITE_URL}/restaurant/${entry.slug}`,
      lastModified: new Date(entry.updatedAt ?? entry.publishedAt),
      changeFrequency: 'daily' as const,
      priority: 0.8,
    }));

  // Pages ville indexables (≥5 restos dans la ville)
  const cityUrls: MetadataRoute.Sitemap = cities.map((city) => ({
    url: `${SITE_URL}/restaurants/${city.citySlug}`,
    changeFrequency: 'weekly' as const,
    priority: 0.6,
  }));

  // Pages cuisine indexables (ville ≥10 restos ET cuisine ≥10, spec §7.4)
  const cuisineUrls: MetadataRoute.Sitemap = cities
    .filter((city) => city.total >= 10)
    .flatMap((city) =>
      city.cuisines
        .filter((cuisine) => cuisine.count >= 10)
        .map((cuisine) => ({
          url: `${SITE_URL}/restaurants/${city.citySlug}/${cuisine.slug}`,
          changeFrequency: 'weekly' as const,
          priority: 0.5,
        })),
    );

  // Pages de vitrine : servies par l'application dashboard, mais listées ici car le sitemap
  // publié par Nginx est celui de Connect.
  const staticPages: MetadataRoute.Sitemap = [
    {
      url: SITE_URL,
      changeFrequency: 'daily' as const,
      priority: 0.5,
    },
    {
      url: `${SITE_URL}/assistant`,
      changeFrequency: 'monthly' as const,
      priority: 0.4,
    },
    {
      url: `${SITE_URL}/pricing`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    },
    {
      url: `${SITE_URL}/demo`,
      changeFrequency: 'monthly' as const,
      priority: 0.6,
    },
  ];

  return [...staticPages, ...restaurantUrls, ...cityUrls, ...cuisineUrls];
}
