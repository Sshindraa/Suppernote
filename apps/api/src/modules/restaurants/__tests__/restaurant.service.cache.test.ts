import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_CTX_TTL_SECONDS, VOICE_LLM_MODEL_DEFAULT } from '@suppernote/config';
import { voiceConfig } from '../../../env';

vi.mock('../../../shared/db/client', () => ({
  db: {
    restaurant: {
      findUniqueOrThrow: vi.fn(),
    },
  },
}));

vi.mock('../../../shared/redis/client', () => ({
  redisCache: {
    del: vi.fn().mockResolvedValue(1),
    incr: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  },
  getCachedContext: vi.fn(),
  setCachedContext: vi.fn(),
}));

const restaurantFromDb = {
  id: 'rest-1',
  name: 'Chez Cache',
  slug: 'chez-cache',
  publishedAt: new Date('2026-09-01T10:00:00.000Z'),
  agenticOptIn: true,
  plan: 'STARTER',
  managerPhone: '+33600000000',
  managerEmail: 'boss@sokar.test',
  phoneNumber: 'pn-cache',
  openingHours: { mon: { open: '12:00', close: '22:00' } },
  carrier: 'telnyx',
  smsConfirmEnabled: true,
  exposureSettings: {
    connectPublished: true,
  },
  personality: {
    id: 'personality-1',
    restaurantId: 'rest-1',
    profileType: 'BISTROT_BRASSERIE',
    speakingRate: '1.0',
    pitchShift: '1.0',
    fillerStyle: 'CASUAL',
    microphoneThreshold: -42,
    targetLatencyMs: 140,
    systemPromptExtra: 'Suggère les plats du jour.',
    voiceIdCa: 'voice-from-personality',
    updatedAt: new Date('2026-06-20T10:00:00.000Z'),
  },
};

describe('RestaurantService context cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CARTESIA_API_KEY;
  });

  it('lit le contexte restaurant depuis Redis sans toucher Prisma en cache hit', async () => {
    const { db } = await import('../../../shared/db/client');
    const { getCachedContext } = await import('../../../shared/redis/client');
    const { RestaurantService } = await import('../restaurant.service');

    const cached = {
      id: 'rest-1',
      name: 'Chez Cache',
      openingHours: {},
      personality: null,
      providerConfig: { llmModel: VOICE_LLM_MODEL_DEFAULT },
    };
    vi.mocked(getCachedContext).mockResolvedValue(cached);

    const result = await RestaurantService.loadContext('pn-cache');

    expect(result).toBe(cached);
    expect(getCachedContext).toHaveBeenCalledWith('phone:pn-cache');
    expect(db.restaurant.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('ne fournit jamais le numéro de secours fictif du seed au pipeline de la démo', async () => {
    const { db } = await import('../../../shared/db/client');
    const { getCachedContext } = await import('../../../shared/redis/client');
    const { RestaurantService } = await import('../restaurant.service');
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...restaurantFromDb,
      slug: 'chez-suppernote-demo',
      managerPhone: '+33601020304',
    } as never);
    const result = await RestaurantService.loadContext('pn-demo');
    expect(result.managerPhone).toBe('');
  });

  it('protège aussi le contexte démo déjà présent dans Redis', async () => {
    const { getCachedContext } = await import('../../../shared/redis/client');
    const { RestaurantService } = await import('../restaurant.service');
    vi.mocked(getCachedContext).mockResolvedValue({
      ...restaurantFromDb,
      slug: 'chez-suppernote-demo',
      managerPhone: '+33601020304',
    } as never);
    expect((await RestaurantService.loadContext('pn-demo')).managerPhone).toBe('');
  });

  it.each([
    ['restaurant réel', 'chez-cache', '+33601020304'],
    ['secours démo configuré', 'chez-suppernote-demo', '+33600000000'],
  ])(
    'conserve le numéro du %s sans exclusion approximative',
    async (_label, slug, managerPhone) => {
      const { db } = await import('../../../shared/db/client');
      const { getCachedContext } = await import('../../../shared/redis/client');
      const { RestaurantService } = await import('../restaurant.service');
      vi.mocked(getCachedContext).mockResolvedValue(null);
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
        ...restaurantFromDb,
        slug,
        managerPhone,
      } as never);
      expect((await RestaurantService.loadContext('pn-other')).managerPhone).toBe(managerPhone);
    },
  );

  it('cache uniquement le contexte utile au voice pipeline avec TTL court et sans secrets', async () => {
    const { db } = await import('../../../shared/db/client');
    const { getCachedContext, setCachedContext } = await import('../../../shared/redis/client');
    const { RestaurantService } = await import('../restaurant.service');

    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      restaurantFromDb as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const result = await RestaurantService.loadContext('pn-cache');

    expect(db.restaurant.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { phoneNumber: 'pn-cache' },
      select: expect.any(Object),
    });
    expect(setCachedContext).toHaveBeenCalledWith('phone:pn-cache', result, REDIS_CTX_TTL_SECONDS);
    expect(result.onlineReservationsActive).toBe(true);

    const cachedPayload = JSON.stringify(vi.mocked(setCachedContext).mock.calls[0][1]);
    expect(cachedPayload).toContain('Suggère les plats du jour.');
    expect(cachedPayload).toContain('voice-from-personality');
    // Le modèle effectivement configuré, pas la constante par défaut : le .env
    // local peut le surcharger, et c'est ce modèle-là qui part en cache.
    expect(cachedPayload).toContain(voiceConfig.VOICE_LLM_MODEL);
    expect(cachedPayload).toContain('cartesia');
    expect(cachedPayload).toContain('nova-3');
    expect(cachedPayload).not.toContain('secret-refresh-token-never-cache');
    expect(cachedPayload).not.toContain('CARTESIA_API_KEY');
    expect(cachedPayload).not.toContain('test-cartesia-key');
  });

  it.each([
    { agenticOptIn: false },
    { publishedAt: null },
    { slug: null },
    { exposureSettings: { connectPublished: false } },
  ])('désactive les réservations Connect sans publication complète', async (overrides) => {
    const { db } = await import('../../../shared/db/client');
    const { getCachedContext } = await import('../../../shared/redis/client');
    const { RestaurantService } = await import('../restaurant.service');

    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...restaurantFromDb,
      ...overrides,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const result = await RestaurantService.loadContext('pn-cache');

    expect(result.onlineReservationsActive).toBe(false);
  });

  it('invalide le cache par clé téléphone', async () => {
    const { redisCache } = await import('../../../shared/redis/client');
    const { invalidateRestaurantContextCache } = await import('../restaurant.service');

    await invalidateRestaurantContextCache('pn-cache');
    await invalidateRestaurantContextCache(null);

    expect(redisCache.del).toHaveBeenCalledTimes(1);
    expect(redisCache.del).toHaveBeenCalledWith('phone:pn-cache');
  });
});
