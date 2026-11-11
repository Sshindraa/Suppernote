import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  fetchSitemapSources: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  fetchSitemapSources: api.fetchSitemapSources,
}));

import sitemap, * as route from './sitemap';

const SITE = 'https://suppernote.com';

const publishedRestaurant = {
  slug: 'chez-sokar',
  updatedAt: '2026-10-01T10:00:00.000Z',
  publishedAt: '2026-09-01T10:00:00.000Z',
};

describe('sitemap', () => {
  beforeEach(() => {
    api.fetchSitemapSources.mockReset();
  });

  it('liste les pages publiques de la vitrine et les fiches publiées', async () => {
    api.fetchSitemapSources.mockResolvedValue({
      restaurants: [publishedRestaurant],
      cities: [],
    });

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls).toEqual(
      expect.arrayContaining([
        SITE,
        `${SITE}/assistant`,
        `${SITE}/pricing`,
        `${SITE}/demo`,
        `${SITE}/restaurant/chez-sokar`,
      ]),
    );
  });

  it('exclut les fixtures explicites même si l’API précédente les retourne, sans filtre par nom', async () => {
    api.fetchSitemapSources.mockResolvedValue({
      restaurants: [
        publishedRestaurant,
        { ...publishedRestaurant, slug: 'chez-suppernote-demo' },
        { ...publishedRestaurant, slug: 'chez-sokar-demo' },
        { ...publishedRestaurant, slug: 'chez-sokar-bistrot-paris' },
      ],
      cities: [],
    });
    const urls = (await sitemap()).map((entry) => entry.url);
    expect(urls).toContain(`${SITE}/restaurant/chez-sokar`);
    expect(urls).not.toContain(`${SITE}/restaurant/chez-suppernote-demo`);
    expect(urls).not.toContain(`${SITE}/restaurant/chez-sokar-demo`);
    expect(urls).not.toContain(`${SITE}/restaurant/chez-sokar-bistrot-paris`);
    expect(urls).not.toContain(`${SITE}/solutions/assistant-telephonique-restaurant`);
  });

  it('publie les pages de vitrine même quand aucun restaurant n’est publié', async () => {
    api.fetchSitemapSources.mockResolvedValue({ restaurants: [], cities: [] });

    const urls = (await sitemap()).map((entry) => entry.url);

    expect(urls).toEqual([SITE, `${SITE}/assistant`, `${SITE}/pricing`, `${SITE}/demo`]);
  });

  it('échoue au lieu de publier un sitemap tronqué quand les données ne sont pas disponibles', async () => {
    api.fetchSitemapSources.mockRejectedValue(new Error('sitemap source unavailable'));

    await expect(sitemap()).rejects.toThrow('sitemap source unavailable');
  });

  it('ne fournit une date de modification que pour les fiches, dont la date est réelle', async () => {
    api.fetchSitemapSources.mockResolvedValue({
      restaurants: [publishedRestaurant],
      cities: [{ city: 'Paris', citySlug: 'paris', total: 12, cuisines: [] }],
    });

    const entries = await sitemap();
    const byUrl = (url: string) => entries.find((entry) => entry.url === url);

    expect(byUrl(`${SITE}/restaurant/chez-sokar`)?.lastModified).toEqual(
      new Date(publishedRestaurant.updatedAt),
    );
    expect(byUrl(SITE)?.lastModified).toBeUndefined();
    expect(byUrl(`${SITE}/pricing`)?.lastModified).toBeUndefined();
    expect(byUrl(`${SITE}/restaurants/paris`)?.lastModified).toBeUndefined();
  });

  it('est rendu à la requête, pour que le build ne dépende pas de la disponibilité de l’API', () => {
    expect(route.dynamic).toBe('force-dynamic');
  });
});
