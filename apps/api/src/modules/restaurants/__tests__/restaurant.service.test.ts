/**
 * Tests for the central RestaurantService.
 *
 * Couvre :
 *  - loadContext : cache hit/miss, projection des champs,
 *    application du plan override (ConfigCat), TTL Redis.
 *  - invalidateRestaurantContextCache : no-op si phoneNumber vide.
 *  - recordMonthlyCall : incrément mensuel, Sentry sur seuil.
 *  - isOpen : pure function, ouvre/ferme selon openingHours, cas closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REDIS_CTX_TTL_SECONDS } from '@suppernote/config';

// Mock des dépendances AVANT l'import du service
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

vi.mock('../../../shared/configcat', () => ({
  getRestaurantPlanOverride: vi.fn().mockImplementation(async (_id, currentPlan) => currentPlan),
}));

vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
}));

import { db } from '../../../shared/db/client';
import { redisCache, getCachedContext, setCachedContext } from '../../../shared/redis/client';
import { getRestaurantPlanOverride } from '../../../shared/configcat';
import * as Sentry from '@sentry/node';
import { RestaurantService, invalidateRestaurantContextCache } from '../restaurant.service';

const FULL_RESTAURANT = {
  id: 'rest-1',
  name: 'Chez Suppernote',
  slug: 'chez-sokar',
  plan: 'STARTER',
  managerPhone: '+336****0000',
  managerEmail: 'boss@suppernote.test',
  phoneNumber: 'pn-1234',
  timezone: 'Europe/Paris',
  formattedAddress: '42 rue Exemple, Lyon',
  city: 'Lyon',
  cuisineType: ['bistrot'],
  openingHours: { mon: { open: '12:00', close: '22:00' } },
  carrier: 'telnyx',
  smsConfirmEnabled: true,
  giftCardMinimumAmount: 50,
  personality: {
    id: 'p-1',
    restaurantId: 'rest-1',
    profileType: 'BISTROT',
    speakingRate: '1.0',
    pitchShift: '1.0',
    fillerStyle: 'CASUAL',
    microphoneThreshold: -42,
    targetLatencyMs: 140,
    systemPromptExtra: null,
    voiceIdCa: 'voice-x',
    updatedAt: new Date('2026-06-20T10:00:00.000Z'),
  },
};

describe('RestaurantService.loadContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retourne le cache si présent, sans interroger la DB', async () => {
    // On étend l'objet avec un champ sentinelle pour pouvoir l'identifier
    const cached = { ...FULL_RESTAURANT, _fromCache: true };
    vi.mocked(getCachedContext).mockResolvedValue(
      cached as unknown as Awaited<ReturnType<typeof getCachedContext>>,
    );

    const result = (await RestaurantService.loadContext('pn-1234')) as unknown as Record<
      string,
      unknown
    >;

    expect(result._fromCache).toBe(true);
    expect(db.restaurant.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(setCachedContext).not.toHaveBeenCalled();
  });

  it.each([
    ['seuil 10 réglé pour le canal agentique', { maxPartySize: 10 }, 10],
    ['seuil 7', { maxPartySize: 7 }, 7],
    ['pas de ligne de réglages', null, 7],
  ])('charge le seuil de groupe du téléphone : %s', async (_label, exposureSettings, expected) => {
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...FULL_RESTAURANT,
      exposureSettings,
    } as never);

    const result = await RestaurantService.loadContext('pn-1234');

    expect(result.maxPartySize).toBe(expected);
  });

  it('charge depuis la DB, construit le context, met en cache, et le retourne', async () => {
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(FULL_RESTAURANT as never);

    const result = await RestaurantService.loadContext('pn-1234');

    expect(db.restaurant.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { phoneNumber: 'pn-1234' },
      select: expect.objectContaining({
        id: true,
        name: true,
        phoneNumber: true,
        timezone: true,
        formattedAddress: true,
        city: true,
        cuisineType: true,
        personality: expect.objectContaining({ select: expect.any(Object) }),
      }),
    });
    expect(setCachedContext).toHaveBeenCalledWith(
      'phone:pn-1234',
      expect.objectContaining({ id: 'rest-1', name: 'Chez Suppernote' }),
      REDIS_CTX_TTL_SECONDS,
    );
    expect(result.id).toBe('rest-1');
    expect(result.name).toBe('Chez Suppernote');
    expect(result.providerConfig.sttProvider).toBe('deepgram');
    expect(result.providerConfig.ttsProvider).toBe('cartesia');
  });

  it('applique le plan override si ConfigCat renvoie une autre valeur', async () => {
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(FULL_RESTAURANT as never);
    vi.mocked(getRestaurantPlanOverride).mockResolvedValue('PRO');

    const result = await RestaurantService.loadContext('pn-1234');

    expect(getRestaurantPlanOverride).toHaveBeenCalledWith('rest-1', 'STARTER');
    expect(result.plan).toBe('PRO');
    // Le cache doit être écrit avec le plan overridé
    const writeCall = vi.mocked(setCachedContext).mock.calls[0];
    expect(writeCall[1]).toMatchObject({ plan: 'PRO' });
  });

  it('préserve le plan DB si ConfigCat renvoie la même valeur (no-op)', async () => {
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(FULL_RESTAURANT as never);
    vi.mocked(getRestaurantPlanOverride).mockResolvedValue('STARTER'); // même valeur

    const result = await RestaurantService.loadContext('pn-1234');

    expect(result.plan).toBe('STARTER');
  });

  it('utilise la voiceId du personality si présente', async () => {
    vi.mocked(getCachedContext).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(FULL_RESTAURANT as never);

    const result = await RestaurantService.loadContext('pn-1234');

    expect(result.providerConfig.voiceId).toBe('voice-x');
  });
});

describe('invalidateRestaurantContextCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supprime la clé phone:<phoneNumber> du cache', async () => {
    await invalidateRestaurantContextCache('+336****0000');
    expect(redisCache.del).toHaveBeenCalledWith('phone:+336****0000');
  });

  it('no-op si phoneNumber est null', async () => {
    await invalidateRestaurantContextCache(null);
    expect(redisCache.del).not.toHaveBeenCalled();
  });

  it('no-op si phoneNumber est undefined', async () => {
    await invalidateRestaurantContextCache(undefined);
    expect(redisCache.del).not.toHaveBeenCalled();
  });

  it('no-op si phoneNumber est une chaîne vide', async () => {
    await invalidateRestaurantContextCache('');
    expect(redisCache.del).not.toHaveBeenCalled();
  });
});

describe('RestaurantService.recordMonthlyCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('incrémente le compteur mensuel et met un TTL de 33 jours', async () => {
    vi.mocked(redisCache.incr).mockResolvedValueOnce(1);

    await RestaurantService.recordMonthlyCall('rest-1');

    expect(redisCache.incr).toHaveBeenCalledTimes(1);
    expect(redisCache.incr).toHaveBeenCalledWith(
      expect.stringMatching(/^infra:calls:rest-1:\d{4}-\d{2}$/),
    );
    expect(redisCache.expire).toHaveBeenCalledWith(
      expect.stringMatching(/^infra:calls:rest-1:\d{4}-\d{2}$/),
      33 * 24 * 3600,
    );
  });

  it('ne compte plus par heure et ne refuse jamais un appel', async () => {
    vi.mocked(redisCache.incr).mockResolvedValue(9999);

    await expect(RestaurantService.recordMonthlyCall('rest-1')).resolves.toBeUndefined();

    expect(redisCache.incr).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('[CIRCUIT_BREAKER]'),
      expect.anything(),
    );
  });

  it('émet un warning Sentry quand le seuil mensuel est dépassé', async () => {
    vi.mocked(redisCache.incr).mockResolvedValueOnce(9999);

    await RestaurantService.recordMonthlyCall('rest-1');

    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      expect.stringContaining('[MARGIN]'),
      expect.objectContaining({ level: 'warning' }),
    );
  });

  it('ne set pas expire sur les incréments suivants (TTL déjà fixé)', async () => {
    vi.mocked(redisCache.incr).mockResolvedValueOnce(5);

    await RestaurantService.recordMonthlyCall('rest-1');

    expect(redisCache.expire).not.toHaveBeenCalled();
  });
});

describe('RestaurantService.isOpen', () => {
  // dayMap: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  // getDay() : sun=0, mon=1, ... sat=6

  it("retourne true si le créneau est dans la fenêtre d'ouverture", () => {
    // 2026-09-07 est un lundi
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '14:30')).toBe(true);
  });

  it("retourne true pile à l'heure d'ouverture (inclusif)", () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '12:00')).toBe(true);
  });

  it("retourne false pile à l'heure de fermeture (exclusif)", () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '22:00')).toBe(false);
  });

  it("retourne false avant l'heure d'ouverture", () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '11:30')).toBe(false);
  });

  it("retourne false après l'heure de fermeture", () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '23:00')).toBe(false);
  });

  it('retourne false si le jour est fermé (openingHours[day] null)', () => {
    const ctx = { openingHours: { sun: null, mon: { open: '12:00', close: '22:00' } } };
    // 2026-09-06 est un dimanche
    expect(RestaurantService.isOpen(ctx, '2026-09-06', '14:00')).toBe(false);
  });

  it("retourne false si le jour n'est pas dans openingHours", () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '22:00' } } };
    // 2026-09-08 est un mardi, pas dans openingHours
    expect(RestaurantService.isOpen(ctx, '2026-09-08', '14:00')).toBe(false);
  });

  it('gère les minutes (12:30 est dans la fenêtre 12:00-13:00)', () => {
    const ctx = { openingHours: { mon: { open: '12:00', close: '13:00' } } };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '12:30')).toBe(true);
  });

  it('samedi : le code utilise dayMap = sun=0..sat=6', () => {
    const ctx = { openingHours: { sat: { open: '18:00', close: '23:30' } } };
    // 2026-09-12 est un samedi
    expect(RestaurantService.isOpen(ctx, '2026-09-12', '20:00')).toBe(true);
  });

  it('respecte la coupure entre le déjeuner et le dîner', () => {
    const ctx = {
      openingHours: {
        mon: {
          open: '12:00',
          close: '22:30',
          services: [
            { open: '12:00', close: '14:30' },
            { open: '19:00', close: '22:30' },
          ],
        },
      },
    };
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '13:00')).toBe(true);
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '16:00')).toBe(false);
    expect(RestaurantService.isOpen(ctx, '2026-09-07', '20:00')).toBe(true);
  });
});
