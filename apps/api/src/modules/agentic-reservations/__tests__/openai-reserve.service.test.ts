/**
 * Tests unitaires du service OpenAI Reserve.
 * Mock Prisma pour isoler la logique de mapping DB → format OpenAI.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { OpenaiReserveService } from '../openai-reserve/openai-reserve.service';
import { WIDGET_PUBLIC_URL } from '../openai-reserve/constants';

function makeMockPrisma() {
  return {
    restaurant: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as unknown as PrismaClient;
}

function makeMockCache() {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, _mode?: string, _ttl?: number) => {
      store.set(key, value);
      return 'OK';
    }),
    _store: store,
  } as unknown as Redis;
}

describe('OpenaiReserveService', () => {
  let prisma: ReturnType<typeof makeMockPrisma>;
  let cache: ReturnType<typeof makeMockCache>;
  let service: OpenaiReserveService;

  beforeEach(() => {
    prisma = makeMockPrisma();
    cache = makeMockCache();
    service = new OpenaiReserveService(prisma, cache);
    vi.clearAllMocks();
  });

  describe('getBusinessFeed', () => {
    it('calcule total_pages et expose la pagination', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(42);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([]);

      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });
      expect(result.total).toBe(42);
      expect(result.total_pages).toBe(3);
      expect(result.page).toBe(1);
      expect(result.page_size).toBe(20);
      expect(result.businesses).toEqual([]);
    });

    it('mappe les colonnes Prisma vers le format OpenAI', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(1);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([
        {
          id: 'r-1',
          name: 'Le Bistrot',
          slug: 'le-bistrot',
          formattedAddress: '1 rue de Paris, 75001 Paris, France',
          phoneE164: '+33****0000',
          websiteUrl: 'https://bistrot.example',
          lat: { toNumber: () => 48.86 },
          lng: { toNumber: () => 2.35 },
          cuisineType: ['french'],
          priceRange: 2,
          openingHours: { lun: ['12:00-14:30'] },
        },
      ] as unknown as Awaited<ReturnType<typeof prisma.restaurant.findMany>>);

      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });
      expect(result.businesses[0]).toMatchObject({
        id: 'r-1',
        name: 'Le Bistrot',
        location: { latitude: 48.86, longitude: 2.35 },
        phone_number: '+33****0000',
        website_url: 'https://bistrot.example',
        platform_url: 'http://localhost:4002/restaurant/le-bistrot',
        cuisine_type: ['french'],
        price_range: 2,
      });
    });

    it('émet le slug canonique pour la fiche de démonstration encore stockée sous son alias', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(1);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([
        {
          id: 'r-demo',
          name: 'Chez Suppernote',
          slug: 'chez-sokar-demo',
          formattedAddress: '1 rue de Paris, 75001 Paris, France',
          phoneE164: '+33123456789',
          websiteUrl: 'https://suppernote.com',
          lat: 48.86,
          lng: 2.35,
          cuisineType: ['french'],
          priceRange: 2,
          openingHours: {},
        },
      ] as unknown as Awaited<ReturnType<typeof prisma.restaurant.findMany>>);

      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });

      expect(result.businesses[0].platform_url).toBe(
        'http://localhost:4002/restaurant/chez-suppernote-demo',
      );
    });

    it('parse formattedAddress en structuré', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(1);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([
        {
          id: 'r-1',
          name: 'A',
          slug: 'a',
          formattedAddress: '12 rue Lafayette, 75009 Paris, France',
          phoneE164: '+33****0000',
          websiteUrl: 'https://a.example',
          lat: { toNumber: () => 48.87 },
          lng: { toNumber: () => 2.34 },
          cuisineType: null,
          priceRange: null,
          openingHours: null,
        },
      ] as unknown as Awaited<ReturnType<typeof prisma.restaurant.findMany>>);
      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });
      const addr = result.businesses[0].address as unknown as Record<string, unknown>;
      expect(addr.line1).toBe('12 rue Lafayette');
      expect(addr.country).toBe('FR');
      expect(addr.formatted).toBe('12 rue Lafayette, 75009 Paris, France');
    });

    it('utilise le string brut si le format ne se split pas', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(1);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([
        {
          id: 'r-1',
          name: 'A',
          slug: 'a',
          formattedAddress: 'un seul segment',
          phoneE164: '+33****0000',
          websiteUrl: 'https://a.example',
          lat: { toNumber: () => 0 },
          lng: { toNumber: () => 0 },
          cuisineType: null,
          priceRange: null,
          openingHours: null,
        },
      ] as unknown as Awaited<ReturnType<typeof prisma.restaurant.findMany>>);
      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });
      expect(result.businesses[0].address).toBe('un seul segment');
    });

    it('checksum = true si aucun changes_token fourni', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(0);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([]);
      const result = await service.getBusinessFeed({ page: 1, page_size: 20 });
      expect(result.checksum).toBe(true);
      expect(result.changes_token).toBeDefined();
    });

    it('checksum = false si feed vide et changes_token fourni', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(0);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([]);
      const result = await service.getBusinessFeed({
        page: 1,
        page_size: 20,
        changes_token: 'old',
      });
      expect(result.checksum).toBe(false);
    });
  });

  describe('restaurantReservation', () => {
    it('retourne widget_resource_url + restaurant_name', async () => {
      vi.mocked(prisma.restaurant.findUnique).mockResolvedValue({
        id: 'r-1',
        name: 'Le Bistrot',
        formattedAddress: '1 rue de Paris, Paris',
        lat: 48.86,
        lng: 2.35,
        openaiReserveEnabled: true,
        city: 'Paris',
        region: 'IDF',
        postalCode: '75001',
        countryCode: 'FR',
      } as unknown as Awaited<ReturnType<typeof prisma.restaurant.findUnique>>);

      const result = await service.restaurantReservation({ restaurant_id: 'r-1' });
      expect(result.restaurant_id).toBe('r-1');
      expect(result.restaurant_name).toBe('Le Bistrot');
      expect(result.widget_resource_url).toBe(WIDGET_PUBLIC_URL);
      expect(result.restaurant_address?.locality).toBe('Paris');
      expect(result.restaurant_address?.country).toBe('FR');
    });

    it('jette si restaurant pas openaiReserveEnabled', async () => {
      vi.mocked(prisma.restaurant.findUnique).mockResolvedValue({
        id: 'r-1',
        name: 'A',
        formattedAddress: 'x',
        lat: 0,
        lng: 0,
        openaiReserveEnabled: false,
        city: 'x',
        region: 'x',
        postalCode: 'x',
        countryCode: 'FR',
      } as unknown as Awaited<ReturnType<typeof prisma.restaurant.findUnique>>);
      await expect(service.restaurantReservation({ restaurant_id: 'r-1' })).rejects.toThrow(
        /not OpenAI Reserve enabled/,
      );
    });

    it('jette si restaurant introuvable', async () => {
      vi.mocked(prisma.restaurant.findUnique).mockResolvedValue(null);
      await expect(service.restaurantReservation({ restaurant_id: 'r-x' })).rejects.toThrow();
    });
  });

  describe('cache Redis sur getBusinessFeed', () => {
    it('sert le cache au 2e appel sans re-frapper Prisma', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(1);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([
        {
          id: 'r-1',
          name: 'Le Bistrot',
          slug: 'le-bistrot',
          formattedAddress: '1 rue de Paris, 75001 Paris, France',
          phoneE164: '+33123456789',
          websiteUrl: 'https://bistrot.example',
          lat: { toNumber: () => 48.86 },
          lng: { toNumber: () => 2.35 },
          cuisineType: ['french'],
          priceRange: 2,
          openingHours: { lun: ['12:00-14:30'] },
        },
      ] as unknown as Awaited<ReturnType<typeof prisma.restaurant.findMany>>);

      const query = { page: 1, page_size: 20 };
      const feed1 = await service.getBusinessFeed(query);
      expect(feed1.businesses).toHaveLength(1);
      expect(prisma.restaurant.findMany).toHaveBeenCalledTimes(1);

      // 2e appel : doit servir le cache, findMany ne doit pas être rappelé
      const feed2 = await service.getBusinessFeed(query);
      expect(feed2.businesses).toHaveLength(1);
      expect(prisma.restaurant.findMany).toHaveBeenCalledTimes(1); // toujours 1
      expect(cache.get).toHaveBeenCalledTimes(2);
      expect(cache.set).toHaveBeenCalledTimes(1);
    });

    it('fail-open si Redis down (continue sans cacher)', async () => {
      vi.mocked(prisma.restaurant.count).mockResolvedValue(0);
      vi.mocked(prisma.restaurant.findMany).mockResolvedValue([]);
      vi.mocked(cache.get).mockRejectedValue(new Error('Redis connection refused'));
      vi.mocked(cache.set).mockRejectedValue(new Error('Redis connection refused'));

      const feed = await service.getBusinessFeed({ page: 1, page_size: 20 });
      expect(feed.total).toBe(0);
      expect(prisma.restaurant.findMany).toHaveBeenCalledTimes(1);
    });
  });
});
