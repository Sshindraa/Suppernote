/**
 * ConnectService.getPublishedBySlug : la réservation (forBooking) refuse un site inactif,
 * alors que la lecture et la gestion des réservations existantes ne changent pas.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { ConnectService } from '../connect.service';

const SLUG = 'chez-suppernote-demo';
const RESTAURANT_ID = 'ba5be41b-eb72-4e05-bb9c-b576e39e33ba';

function row(siteStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED') {
  return {
    id: RESTAURANT_ID,
    slug: SLUG,
    name: 'Chez Suppernote',
    siteStatus,
    agenticOptIn: true,
    publishedAt: new Date('2026-06-24'),
    city: 'Lyon',
    country: 'FR',
    postalCode: '69001',
    description: null,
    formattedAddress: '12 Rue de la République, 69001 Lyon',
    phoneNumber: '+33400000000',
    phoneE164: '+33400000000',
    cuisineType: ['Française'],
    priceRange: 2,
    openingHours: {},
    ambiance: [],
    dietary: [],
    noiseLevel: null,
    exposureSettings: { connectPublished: true, connectAgentic: false },
    images: [],
  };
}

function makeService(
  siteStatus: 'ACTIVE' | 'SUSPENDED' | 'ARCHIVED',
  cached: string | null = null,
) {
  const prisma = {
    restaurant: {
      findUnique: vi.fn().mockResolvedValue(row(siteStatus)),
    },
  } as unknown as PrismaClient;
  const redis = {
    get: vi.fn().mockResolvedValue(cached),
    set: vi.fn().mockResolvedValue('OK'),
  } as unknown as Redis;
  return { service: new ConnectService(prisma, redis), redis };
}

describe('ConnectService.getPublishedBySlug — site inactif', () => {
  it.each(['SUSPENDED', 'ARCHIVED'] as const)(
    'réservation : un site %s renvoie null',
    async (siteStatus) => {
      const { service } = makeService(siteStatus);
      expect(await service.getPublishedBySlug(SLUG, { forBooking: true })).toBeNull();
    },
  );

  it('réservation : un site actif passe comme avant', async () => {
    const { service } = makeService('ACTIVE');
    expect(await service.getPublishedBySlug(SLUG, { forBooking: true })).toMatchObject({
      slug: SLUG,
    });
  });

  it('réservation : ignore un DTO en cache et lit la base (siteStatus absent du cache)', async () => {
    const cachedDto = JSON.stringify({ slug: SLUG, name: 'Chez Suppernote' });
    const { service, redis } = makeService('SUSPENDED', cachedDto);

    expect(await service.getPublishedBySlug(SLUG, { forBooking: true })).toBeNull();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('lecture publique et gestion existante : un site suspendu reste lisible', async () => {
    const { service } = makeService('SUSPENDED');
    expect(await service.getPublishedBySlug(SLUG)).toMatchObject({ slug: SLUG });
  });
});
