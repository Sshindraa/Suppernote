/**
 * Tests for AvailabilityService (coarse search + precise check + policy lookup).
 *
 * - searchAvailableRestaurants : query candidates par (city, partySize, cuisineType)
 *   puis check slot-par-slot, renvoie jusqu'à maxResults.
 * - checkAvailability : si resto introuvable → unknown, sinon délègue à
 *   CapacityAwareAvailabilityService.
 * - getPolicyFor : assemble RestaurantPolicyInput depuis exposureSettings +
 *   restaurant.policyVersion, et construit le snapshot via buildPolicySnapshot.
 *
 * On instancie le service avec un fake PrismaClient qui simule juste les
 * méthodes utilisées, plutôt que de s'appuyer sur le mock partagé (qui
 * ne couvre pas tous les modèles de ce service).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvailabilityService, isHiddenDemoRestaurant } from '../core/availability.service';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';

const RESTAURANT_ID = 'rest-1';
const PARTY_SIZE = 4;

function makeFakePrisma(
  overrides: Partial<{
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    restaurant: {
      findMany: overrides.findMany ?? vi.fn(),
      findUnique: overrides.findUnique ?? vi.fn(),
      findFirst: overrides.findFirst ?? vi.fn(),
    },
    restaurantExposureSettings: {
      findUnique: vi.fn(),
    },
  } as unknown as ConstructorParameters<typeof AvailabilityService>[0];
}

describe('AvailabilityService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('searchAvailableRestaurants', () => {
    it('retourne un tableau vide si aucun candidat ne correspond', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));

      const result = await service.searchAvailableRestaurants({
        city: 'Paris',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
        maxResults: 10,
      });

      expect(findMany).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it('filtre les candidats par ville (formattedAddress contains)', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'r-paris',
          name: 'Bistrot Paris',
          slug: 'bistrot-paris',
          lat: 48.85,
          lng: 2.35,
          formattedAddress: '12 Rue de la Paix, 75002 Paris',
          cuisineType: ['Française'],
          priceRange: 2,
        },
        {
          id: 'r-lyon',
          name: 'Bouchon Lyon',
          slug: 'bouchon-lyon',
          lat: 45.76,
          lng: 4.83,
          formattedAddress: '5 Place Bellecour, 69002 Lyon',
          cuisineType: ['Bistrot'],
          priceRange: 1,
        },
      ]);
      const findUnique = vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' });

      // UTC 19:00 correspond à 21:00 à Paris en septembre.
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockImplementation(
        async ({ restaurantId }) => {
          const available = restaurantId === 'r-paris';
          return {
            restaurantId,
            date: '2026-09-01',
            partySize: PARTY_SIZE,
            slots: [{ time: '21:00', available }],
          };
        },
      );

      const service = new AvailabilityService(makeFakePrisma({ findMany, findUnique }));
      const result = await service.searchAvailableRestaurants({
        city: 'Paris',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
        maxResults: 10,
      });

      // Seul r-paris (ville OK + slot dispo) doit être retenu
      expect(result).toHaveLength(1);
      expect(result[0].restaurantId).toBe('r-paris');
      expect(result[0].name).toBe('Bistrot Paris');
      expect(result[0].slug).toBe('bistrot-paris');
      expect(result[0].formattedAddress).toBe('12 Rue de la Paix, 75002 Paris');
      expect(result[0].cuisineType).toEqual(['Française']);
      expect(result[0].priceRange).toBe(2);
      expect(result[0].distanceMeters).toBeNull();
    });

    it("respecte maxResults et arrête la boucle dès qu'on a assez de résultats", async () => {
      const candidates = Array.from({ length: 25 }, (_, i) => ({
        id: `r-${i}`,
        name: `R ${i}`,
        slug: `r-${i}`,
        lat: 48.85,
        lng: 2.35,
        formattedAddress: `${i} Rue de Paris`,
      }));
      const findMany = vi.fn().mockResolvedValue(candidates);
      const findUnique = vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' });

      const getAvailabilitySpy = vi
        .spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability')
        .mockImplementation(async ({ restaurantId }) => ({
          restaurantId,
          date: '2026-09-01',
          partySize: PARTY_SIZE,
          slots: [{ time: '21:00', available: true }],
        }));

      const service = new AvailabilityService(makeFakePrisma({ findMany, findUnique }));
      const result = await service.searchAvailableRestaurants({
        city: 'Paris',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
        maxResults: 3,
      });

      expect(result).toHaveLength(3);
      // Vérifie qu'on a arrêté la boucle après 3 (early break, pas 25 appels)
      expect(getAvailabilitySpy).toHaveBeenCalledTimes(3);
    });

    it('applique le filtre cuisineType sur la query Prisma', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));

      await service.searchAvailableRestaurants({
        city: 'Paris',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
        maxResults: 5,
        cuisineType: ['Italien', 'Japonais'],
      });

      // Le filtre cuisineType est passé via cuisineType.hasSome
      const call = findMany.mock.calls[0][0];
      expect(call.where.cuisineType).toEqual({ hasSome: ['Italien', 'Japonais'] });
    });

    it('omet le filtre cuisineType si non fourni', async () => {
      const findMany = vi.fn().mockResolvedValue([]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));

      await service.searchAvailableRestaurants({
        city: 'Paris',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
        maxResults: 5,
      });

      const call = findMany.mock.calls[0][0];
      expect(call.where.cuisineType).toBeUndefined();
    });

    it('recherche un restaurant par nom et conserve sa fiche même sans disponibilité au créneau', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'r-sokar',
          name: 'Chez Sokar',
          slug: 'chez-sokar',
          lat: 45.76,
          lng: 4.83,
          formattedAddress: '12 Rue de la République, 69001 Lyon',
          cuisineType: ['Bistrot'],
          priceRange: 2,
        },
      ]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));
      vi.spyOn(service, 'checkAvailability').mockResolvedValue({ available: false });

      const result = await service.searchAvailableRestaurantsPage({
        city: 'Lyon',
        restaurantName: 'Chez Sokar',
        partySize: 2,
        slotStart: new Date('2026-09-17T17:00:00Z'),
        slotEnd: new Date('2026-09-17T19:00:00Z'),
        maxResults: 5,
      });

      expect(findMany.mock.calls[0][0].where.name).toEqual({
        contains: 'Chez Sokar',
        mode: 'insensitive',
      });
      expect(result.results).toEqual([]);
      expect(result.restaurantMatches).toEqual([{ restaurantId: 'r-sokar', name: 'Chez Sokar' }]);
    });

    it('publie le slug canonique dans les résultats MCP pendant la transition', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'r-demo',
          name: 'Chez Suppernote',
          slug: 'chez-sokar-demo',
          formattedAddress: '12 Rue de la République, 69001 Lyon',
          cuisineType: ['Bistrot'],
          priceRange: 2,
          exposureSettings: { maxPartySize: 6 },
          floorPlans: [{ tables: [{ capacity: 6 }] }],
        },
      ]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));
      vi.spyOn(service, 'checkAvailability').mockResolvedValue({ available: true });

      const results = await service.searchAvailableRestaurantsPage({
        city: 'Lyon',
        restaurantName: 'Chez Suppernote',
        partySize: 2,
        slotStart: new Date('2026-09-17T17:00:00Z'),
        slotEnd: new Date('2026-09-17T19:00:00Z'),
        maxResults: 5,
      });
      expect(results.results[0].slug).toBe('chez-suppernote-demo');
    });

    it('expose la limite en ligne quand un groupe dépasse la capacité', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'r-lyon',
          name: 'Chez Lyon',
          slug: 'chez-lyon',
          formattedAddress: '12 Rue de la République, 69001 Lyon',
          cuisineType: ['Bistrot', 'Française'],
          priceRange: 2,
          exposureSettings: { maxPartySize: 12 },
          floorPlans: [{ tables: [{ capacity: 2 }, { capacity: 6 }] }],
        },
      ]);
      const service = new AvailabilityService(makeFakePrisma({ findMany }));

      const result = await service.findCapacityLimits({
        city: 'Lyon',
        partySize: 20,
        maxResults: 5,
      });

      expect(result).toEqual([
        {
          restaurantId: 'r-lyon',
          name: 'Chez Lyon',
          slug: 'chez-lyon',
          formattedAddress: '12 Rue de la République, 69001 Lyon',
          cuisineType: ['Bistrot', 'Française'],
          priceRange: 2,
          maxOnlinePartySize: 6,
        },
      ]);
    });
  });

  describe('checkAvailability', () => {
    it("retourne available=false + reason=unknown si le restaurant n'existe pas", async () => {
      const findUnique = vi.fn().mockResolvedValue(null);
      const service = new AvailabilityService(makeFakePrisma({ findUnique }));

      const result = await service.checkAvailability({
        restaurantId: 'inexistant',
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result.available).toBe(false);
      expect(result.reason).toBe('unknown');
    });

    it('retourne available=true si le slot est marqué dispo par CapacityAware', async () => {
      const findUnique = vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' });
      // Le DTO utilise l'heure locale du restaurant (21:00 à Paris).
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-09-01',
        partySize: PARTY_SIZE,
        slots: [{ time: '21:00', available: true }],
      } as never);

      const service = new AvailabilityService(makeFakePrisma({ findUnique }));
      const result = await service.checkAvailability({
        restaurantId: RESTAURANT_ID,
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result.available).toBe(true);
    });

    it('retourne la limite exacte si le groupe dépasse la capacité en ligne', async () => {
      const findUnique = vi.fn().mockResolvedValue({
        timezone: 'Europe/Paris',
        exposureSettings: { maxPartySize: 12 },
        floorPlans: [{ tables: [{ capacity: 6 }] }],
      });
      const service = new AvailabilityService(makeFakePrisma({ findUnique }));

      const result = await service.checkAvailability({
        restaurantId: RESTAURANT_ID,
        partySize: 7,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result).toEqual({
        available: false,
        reason: 'party_size_exceeds_capacity',
        maxOnlinePartySize: 6,
      });
    });

    it('accepte 8 personnes avec le plafond standard et une table de 8', async () => {
      const findUnique = vi.fn().mockResolvedValue({
        timezone: 'Europe/Paris',
        exposureSettings: { maxPartySize: 8 },
        floorPlans: [{ tables: [{ capacity: 8 }] }],
      });
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-09-01',
        partySize: 8,
        slots: [{ time: '21:00', available: true }],
      } as never);

      const service = new AvailabilityService(makeFakePrisma({ findUnique }));
      const result = await service.checkAvailability({
        restaurantId: RESTAURANT_ID,
        partySize: 8,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result.available).toBe(true);
    });

    it("retourne available=false si le slot n'est pas dans la liste", async () => {
      const findUnique = vi.fn().mockResolvedValue({ timezone: 'Europe/Paris' });
      // On met un slot à 17:00 alors que la recherche porte sur 21:00.
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-09-01',
        partySize: PARTY_SIZE,
        slots: [{ time: '17:00', available: true }],
      } as never);

      const service = new AvailabilityService(makeFakePrisma({ findUnique }));
      const result = await service.checkAvailability({
        restaurantId: RESTAURANT_ID,
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result.available).toBe(false);
    });

    it('utilise Europe/Paris par défaut si timezone est null', async () => {
      const findUnique = vi.fn().mockResolvedValue({ timezone: null });
      vi.spyOn(CapacityAwareAvailabilityService.prototype, 'getAvailability').mockResolvedValue({
        restaurantId: RESTAURANT_ID,
        date: '2026-09-01',
        partySize: PARTY_SIZE,
        slots: [],
      } as never);

      const service = new AvailabilityService(makeFakePrisma({ findUnique }));
      const result = await service.checkAvailability({
        restaurantId: RESTAURANT_ID,
        partySize: PARTY_SIZE,
        slotStart: new Date('2026-09-01T19:00:00Z'),
        slotEnd: new Date('2026-09-01T20:30:00Z'),
      });

      expect(result.available).toBe(false);
      expect(CapacityAwareAvailabilityService.prototype.getAvailability).toHaveBeenCalledWith(
        expect.objectContaining({ restaurantId: RESTAURANT_ID }),
      );
    });
  });

  describe('getPolicyFor', () => {
    it('construit le policy snapshot depuis exposureSettings + restaurant.policyVersion', async () => {
      const fakePrisma = {
        restaurant: {
          findUnique: vi.fn().mockResolvedValue({ policyVersion: '2026-09-15' }),
        },
        restaurantExposureSettings: {
          findUnique: vi.fn().mockResolvedValue({
            restaurantId: RESTAURANT_ID,
            maxPartySize: 12,
            minLeadTimeMinutes: 30,
            requireManualValidation: false,
            quoteTtlSeconds: 300,
            holdTtlSeconds: 600,
            noShowPolicy: 'warn',
            notificationChannels: ['sms'],
            capacitySpecials: null,
          }),
        },
      } as unknown as ConstructorParameters<typeof AvailabilityService>[0];

      const service = new AvailabilityService(fakePrisma);
      const { policy, settings } = await service.getPolicyFor(RESTAURANT_ID);

      expect(settings?.maxPartySize).toBe(12);
      expect(settings?.policyVersion).toBe('2026-09-15');
      expect(settings?.notificationChannels).toEqual(['sms']);
      expect(policy.maxPartySize).toBe(12);
      expect(policy.policyVersion).toBe('2026-09-15');
    });

    it('utilise les valeurs par défaut si exposureSettings est null', async () => {
      const fakePrisma = {
        restaurant: {
          findUnique: vi.fn().mockResolvedValue({ policyVersion: '2026-06-20' }),
        },
        restaurantExposureSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as unknown as ConstructorParameters<typeof AvailabilityService>[0];

      const service = new AvailabilityService(fakePrisma);
      const { policy, settings } = await service.getPolicyFor(RESTAURANT_ID);

      expect(settings?.maxPartySize).toBeNull();
      expect(policy.policyVersion).toBe('2026-06-20');
    });

    it("utilise un policyVersion par défaut si restaurant n'existe pas", async () => {
      const fakePrisma = {
        restaurant: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
        restaurantExposureSettings: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      } as unknown as ConstructorParameters<typeof AvailabilityService>[0];

      const service = new AvailabilityService(fakePrisma);
      const { policy } = await service.getPolicyFor('inconnu');

      // Le code fallback sur '2026-06-20'
      expect(policy.policyVersion).toBe('2026-06-20');
    });
  });
});

// ─── Créneaux passés, moteur réel ───────────────────────────────────────
// Seule la base est en doublure : le moteur de disponibilités et sa règle « créneau passé » sont les
// vrais. Jeudi 2 juillet 2026, 15:00 à Paris (13:00 UTC).
describe('AvailabilityService.checkAvailability — créneaux passés', () => {
  const NOW = new Date('2026-07-02T13:00:00.000Z');
  const paris = (time: string, date = '2026-07-02') => new Date(`${date}T${time}:00+02:00`);

  function makeEnginePrisma() {
    const restaurant = {
      timezone: 'Europe/Paris',
      openingHours: {
        thu: { open: '12:00', close: '22:30' },
        fri: { open: '12:00', close: '22:30' },
      },
      exposureSettings: { maxPartySize: 12, capacitySpecials: {} },
      floorPlans: [{ tables: [{ capacity: 4 }] }],
    };
    return {
      restaurant: { findUnique: vi.fn().mockResolvedValue(restaurant) },
      reservation: { findMany: vi.fn().mockResolvedValue([]) },
      agenticHold: { findMany: vi.fn().mockResolvedValue([]) },
      table: {
        findMany: vi
          .fn()
          .mockResolvedValue([{ id: 't-1', capacity: 4, minCapacity: 1, sectionId: null }]),
      },
    } as unknown as ConstructorParameters<typeof AvailabilityService>[0];
  }

  const check = (start: Date) =>
    new AvailabilityService(makeEnginePrisma()).checkAvailability({
      restaurantId: RESTAURANT_ID,
      partySize: 2,
      slotStart: start,
      slotEnd: new Date(start.getTime() + 2 * 60 * 60 * 1000),
    });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un créneau passé n’est plus disponible, et ses alternatives sont toutes à venir', async () => {
    const result = await check(paris('12:00'));

    expect(result.available).toBe(false);
    expect(result.alternativeSlots?.length).toBeGreaterThan(0);
    for (const alternative of result.alternativeSlots ?? []) {
      expect(new Date(alternative.startsAt).getTime()).toBeGreaterThan(NOW.getTime());
    }
  });

  it('un créneau qui commence exactement maintenant est passé', async () => {
    expect((await check(paris('15:00'))).available).toBe(false);
  });

  it('un créneau à venir reste disponible, aujourd’hui comme demain', async () => {
    expect((await check(paris('19:00'))).available).toBe(true);
    expect((await check(paris('12:00', '2026-07-03'))).available).toBe(true);
  });
});

describe('isHiddenDemoRestaurant', () => {
  const demo = { name: 'Chez Suppernote', slug: 'chez-suppernote-demo' };
  const legacyDemo = { name: 'Chez Suppernote', slug: 'chez-sokar-demo' };
  const demoBranch = {
    name: 'Chez Suppernote — Bar à sushi',
    slug: 'chez-sokar-sushi-lyon',
  };
  const real = { name: 'Le Bistrot', slug: 'le-bistrot-lyon' };

  it('masque les établissements de démo dans une recherche ouverte', () => {
    expect(isHiddenDemoRestaurant(demo)).toBe(true);
    expect(isHiddenDemoRestaurant(legacyDemo)).toBe(true);
    expect(isHiddenDemoRestaurant(demoBranch, 'Chez Suppernote')).toBe(true);
    expect(isHiddenDemoRestaurant(real)).toBe(false);
  });

  it('les montre quand on les nomme exactement, pour les essais et les relecteurs', () => {
    expect(isHiddenDemoRestaurant(demo, ' chez suppernote ')).toBe(false);
    expect(isHiddenDemoRestaurant(legacyDemo, ' chez suppernote ')).toBe(false);
    expect(isHiddenDemoRestaurant(demoBranch, 'Chez Suppernote — Bar à sushi')).toBe(false);
  });
});
