import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { queues } from '../../../shared/queue/queues';
import { placeOutboundCall } from '../../../shared/telnyx/client';

vi.mock('../../../shared/telnyx/client', () => ({
  placeOutboundCall: vi.fn(),
}));

const baseRestaurant = {
  id: 'test-rest-1',
  name: 'Le Bistrot',
  managerPhone: '+33612345678',
  managerEmail: 'restaurant@suppernote.com',
  phoneNumber: '+33123456789',
  phoneE164: '+33611112222',
  openingHours: { tue: { open: '12:00', close: '22:00' } },
  onboardingTasks: null,
  onboardingDone: false,
  onboardingCompletedAt: null,
  onboardingActivatedAt: null,
  onboardingLastSeenAt: null,
  firstCallAt: null,
  personality: { id: 'personality-1' },
};
const PLACES_SESSION_ID = '00000000-0000-4000-8000-000000000000';

describe('restaurant.routes - onboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await closeApp();
  });

  it('bloque la complétion téléphone tant qu’aucun numéro Suppernote n’est attribué', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      phoneNumber: '+000test-rest',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'phone' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/numéro Suppernote attribué/i);
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('garde la recherche Google Places fermée tant que son drapeau dédié est désactivé', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-server-key');
    vi.stubEnv('GOOGLE_PLACES_ONBOARDING_ENABLED', 'false');
    try {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/restaurant/onboarding/places/autocomplete',
        headers: { authorization: 'Bearer test' },
        payload: {
          query: 'Le Bistrot Lyon',
          sessionToken: PLACES_SESSION_ID,
        },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toMatch(/saisir les informations manuellement/i);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('déclenche un appel test vers le numéro public enregistré du restaurant', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      baseRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );
    vi.mocked(db.restaurant.update).mockResolvedValue({
      ...baseRestaurant,
      onboardingTasks: {
        phone: {
          status: 'completed',
          metadata: {
            testCallControlId: 'call-control-1',
          },
        },
      },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);
    vi.mocked(placeOutboundCall).mockResolvedValue({ callControlId: 'call-control-1' });

    const res = await app.inject({
      method: 'POST',
      url: '/restaurant/onboarding/test-call',
      headers: { authorization: 'Bearer test', host: 'api.test.local' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      callControlId: 'call-control-1',
      message: 'Appel test déclenché. Confirmez sa réception après avoir entendu l’assistant.',
    });
    expect(placeOutboundCall).toHaveBeenCalledWith(
      '+33611112222',
      expect.objectContaining({
        webhookUrl: 'http://api.test.local/voice/telnyx',
        clientState: expect.objectContaining({
          kind: 'onboarding_test_call',
          restaurantId: 'test-rest-1',
        }),
        timeoutSecs: 30,
      }),
    );
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'test-rest-1' },
        data: expect.objectContaining({
          onboardingTasks: expect.objectContaining({
            phone: expect.objectContaining({
              metadata: expect.objectContaining({ testCallControlId: 'call-control-1' }),
            }),
          }),
          onboardingLastSeenAt: expect.any(Date),
        }),
      }),
    );
  });

  it('ne marque pas first_call quand Telnyx échoue à déclencher l’appel test', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      baseRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );
    vi.mocked(placeOutboundCall).mockRejectedValue(new Error('Telnyx unavailable'));

    const res = await app.inject({
      method: 'POST',
      url: '/restaurant/onboarding/test-call',
      headers: { authorization: 'Bearer test', host: 'api.test.local' },
      payload: {},
    });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe('TELNYX_FAILED');
    expect(res.json().error).toMatch(/appel test/i);
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('refuse de valider first_call sans confirmation du dernier appel', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      onboardingTasks: {
        phone: { status: 'completed', metadata: { testCallControlId: 'expected-call' } },
      },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: {
        action: 'first_call',
        task: 'phone',
        metadata: { testCallControlId: 'other-call' },
      },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'TEST_CALL_NOT_CONFIRMED' });
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('valide first_call après confirmation du dernier appel déclenché', async () => {
    const app = await getApp();
    const pending = {
      ...baseRestaurant,
      onboardingTasks: {
        phone: { status: 'completed', metadata: { testCallControlId: 'expected-call' } },
      },
    };
    const validated = {
      ...pending,
      firstCallAt: new Date('2099-06-19T12:00:00.000Z'),
      testCallValidatedAt: new Date('2099-06-19T12:00:00.000Z'),
    };
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce(
      pending as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );
    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      validated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: {
        action: 'first_call',
        task: 'phone',
        metadata: { testCallControlId: 'expected-call' },
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstCallAt: expect.any(Date),
          testCallValidatedAt: expect.any(Date),
        }),
      }),
    );
  });

  it('renvoie 409 + code NO_PHONE_ASSIGNED quand test-call est appelé sans numéro Suppernote', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      phoneNumber: '+000test-rest',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

    const res = await app.inject({
      method: 'POST',
      url: '/restaurant/onboarding/test-call',
      headers: { authorization: 'Bearer test', host: 'api.test.local' },
      payload: { phoneNumber: '+33611112222' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_PHONE_ASSIGNED');
    expect(res.json().error).toMatch(/numéro Suppernote attribué/i);
    expect(placeOutboundCall).not.toHaveBeenCalled();
  });

  it('planifie une relance J+3 quand une étape onboarding avance sans être terminé', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      openingHours: {},
      personality: null,
      phoneNumber: '+000test-rest',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);
    vi.mocked(db.restaurant.update).mockResolvedValue({
      ...baseRestaurant,
      openingHours: {},
      personality: null,
      phoneNumber: '+000test-rest',
      onboardingTasks: {},
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'restaurant' },
    });

    expect(res.statusCode).toBe(200);
    expect(queues.onboarding.add).toHaveBeenCalledWith(
      'reengagement-stalled-test-rest-1',
      { restaurantId: 'test-rest-1', type: 'stalled' },
      expect.objectContaining({ jobId: 'reengagement-stalled-test-rest-1' }),
    );
  });

  describe('GET /restaurants/check-slug', () => {
    it('renvoie 400 si le paramètre slug est absent', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/check-slug',
        headers: { authorization: 'Bearer test' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/slug requis/i);
    });

    it('renvoie 400 si le format du slug est invalide', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/check-slug',
        query: { slug: 'Bistrot_Suppernote' },
        headers: { authorization: 'Bearer test' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/format/i);
    });

    it('renvoie available: true si le slug est disponible ou appartient au restaurant courant', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/check-slug',
        query: { slug: 'bistrot-dispo' },
        headers: { authorization: 'Bearer test' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: true });
    });

    it('renvoie available: false si le slug est déjà utilisé par un autre restaurant', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: 'autre-rest-id',
        slug: 'bistrot-pris',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

      const res = await app.inject({
        method: 'GET',
        url: '/restaurants/check-slug',
        query: { slug: 'bistrot-pris' },
        headers: { authorization: 'Bearer test' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ available: false });
    });
  });

  describe('PATCH /restaurants/:id/connect', () => {
    it.each(['chez-suppernote-demo', 'chez-sokar-demo'])(
      'réserve le slug de démonstration %s',
      async (slug) => {
        const app = await getApp();
        vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);
        const headers = { authorization: 'Bearer test' };
        const availability = await app.inject({
          method: 'GET',
          url: '/restaurants/check-slug',
          headers,
          query: { slug },
        });
        expect(availability.json()).toEqual({ available: false });

        const update = await app.inject({
          method: 'PATCH',
          url: '/restaurants/test-rest-1/connect',
          headers,
          payload: { slug },
        });
        expect(update.statusCode).toBe(409);
      },
    );

    it('renvoie 409 si le slug est déjà utilisé par un autre restaurant', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: 'autre-rest-id',
        slug: 'slug-pris',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/connect',
        headers: { authorization: 'Bearer test' },
        payload: { slug: 'slug-pris' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/déjà utilisé/i);
    });

    it('met à jour les infos du restaurant et de ses exposure settings', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(null);

      vi.mocked(db.restaurantExposureSettings.upsert).mockResolvedValue({
        restaurantId: 'test-rest-1',
        capacitySpecials: {},
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.upsert>>);

      const updatedRest = {
        ...baseRestaurant,
        slug: 'nouveau-slug',
        description: 'Bistrot sympa',
        coverImageUrl: 'http://img.url',
      };

      const updatedSettings = {
        restaurantId: 'test-rest-1',
        maxPartySize: 8,
        connectPublished: true,
        capacitySpecials: { totalCapacity: 35 },
      };

      vi.mocked(db.restaurant.update).mockResolvedValue(
        updatedRest as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
      );
      vi.mocked(db.restaurantExposureSettings.update).mockResolvedValue(
        updatedSettings as unknown as Awaited<
          ReturnType<typeof db.restaurantExposureSettings.update>
        >,
      );

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/connect',
        headers: { authorization: 'Bearer test' },
        payload: {
          slug: 'nouveau-slug',
          description: 'Bistrot sympa',
          coverImageUrl: 'http://img.url',
          maxPartySize: 8,
          connectPublished: true,
          capacitySpecials: { totalCapacity: 35 },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(db.restaurantExposureSettings.upsert).toHaveBeenCalledWith({
        where: { restaurantId: 'test-rest-1' },
        create: { restaurantId: 'test-rest-1' },
        update: {},
      });
      expect(res.json()).toEqual({
        restaurant: expect.objectContaining({ slug: 'nouveau-slug', description: 'Bistrot sympa' }),
        exposureSettings: expect.objectContaining({ maxPartySize: 8, connectPublished: true }),
      });
    });

    it('refuse de publier une page sans slug', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: 'test-rest-1',
        slug: null,
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
      vi.mocked(db.restaurantExposureSettings.upsert).mockResolvedValue({
        restaurantId: 'test-rest-1',
        capacitySpecials: {},
      } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.upsert>>);

      const res = await app.inject({
        method: 'PATCH',
        url: '/restaurants/test-rest-1/connect',
        headers: { authorization: 'Bearer test' },
        payload: { connectPublished: true },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'CONNECT_SLUG_REQUIRED', missing: ['slug'] });
      expect(db.restaurant.update).not.toHaveBeenCalled();
      expect(db.restaurantExposureSettings.update).not.toHaveBeenCalled();
    });
  });

  describe('POST /restaurants/:id/images', () => {
    it('ajoute une image et met à jour coverImageUrl si isCover est true', async () => {
      const app = await getApp();
      vi.mocked(db.restaurantImage.create).mockResolvedValue({
        id: 'img-1',
        restaurantId: 'test-rest-1',
        url: 'http://image.url/cover.jpg',
        isCover: true,
      } as unknown as Awaited<ReturnType<typeof db.restaurantImage.create>>);

      const res = await app.inject({
        method: 'POST',
        url: '/restaurants/test-rest-1/images',
        headers: { authorization: 'Bearer test' },
        payload: {
          url: 'http://image.url/cover.jpg',
          isCover: true,
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual(expect.objectContaining({ id: 'img-1', isCover: true }));
      expect(db.restaurantImage.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'test-rest-1', isCover: true },
        data: { isCover: false },
      });
      expect(db.restaurant.update).toHaveBeenCalledWith({
        where: { id: 'test-rest-1' },
        data: { coverImageUrl: 'http://image.url/cover.jpg' },
      });
    });
  });
});

describe('restaurant.routes - onboarding : salle et prêt à réserver', () => {
  const noTables = { _count: { _all: 0 }, _sum: { capacity: null }, _max: { capacity: null } };
  const withTables = { _count: { _all: 8 }, _sum: { capacity: 28 }, _max: { capacity: 6 } };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.table.aggregate).mockResolvedValue(
      noTables as unknown as Awaited<ReturnType<typeof db.table.aggregate>>,
    );
  });

  it('refuse de valider « Votre salle » tant qu’aucune table n’existe', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      baseRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'floor' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_TABLES');
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('refuse de valider « Votre salle et vos règles » sans règles enregistrées', async () => {
    const app = await getApp();
    vi.mocked(db.table.aggregate).mockResolvedValue(
      withTables as unknown as Awaited<ReturnType<typeof db.table.aggregate>>,
    );
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      exposureSettings: { capacitySpecials: { serviceDuration: 90 } },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'floor' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_RULES');
  });

  it('refuse de valider « Votre salle et vos règles » sans les réponses pratiques', async () => {
    const app = await getApp();
    vi.mocked(db.table.aggregate).mockResolvedValue(
      withTables as unknown as Awaited<ReturnType<typeof db.table.aggregate>>,
    );
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      exposureSettings: { capacitySpecials: { serviceDurationMinutes: 90 } },
      practicalInfo: { parking: 'onsite' },
      ambiance: [],
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'floor' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NO_PRACTICAL_INFO');
  });

  it('refuse la mise en service quand les clients ne peuvent pas encore réserver', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...baseRestaurant,
      // Étapes marquées faites, mais la salle a été vidée depuis : plus aucune table active.
      onboardingTasks: {
        floor: { status: 'completed' },
        channels: { status: 'completed' },
      },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'activate' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_READY_TO_BOOK');
  });

  it('refuse de continuer vers Connect tant que le socle est incomplet', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      baseRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
      payload: { action: 'complete', task: 'channels' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('NOT_READY_TO_BOOK');
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('expose l’état « prêt à réserver » dans la lecture de l’onboarding', async () => {
    const app = await getApp();
    const restaurant = {
      ...baseRestaurant,
      exposureSettings: { capacitySpecials: { serviceDurationMinutes: 90 } },
      practicalInfo: {
        terrace: true,
        parking: 'none',
        accessible: false,
        pets: 'no',
        kidsMenu: true,
        privatization: false,
      },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>;
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      restaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );
    vi.mocked(db.restaurant.update).mockResolvedValue(restaurant);
    vi.mocked(db.table.aggregate).mockResolvedValue(
      withTables as unknown as Awaited<ReturnType<typeof db.table.aggregate>>,
    );

    const res = await app.inject({
      method: 'GET',
      url: '/restaurant/onboarding',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().readiness).toMatchObject({
      ready: true,
      tableCount: 8,
      seatCount: 28,
      largestTableCapacity: 6,
    });
    expect(res.json().steps.find((step: { key: string }) => step.key === 'floor').status).toBe(
      'completed',
    );
  });

  it('renvoie les effectifs de la salle pour préremplir l’étape', async () => {
    const app = await getApp();
    vi.mocked(db.table.aggregate).mockResolvedValue(
      withTables as unknown as Awaited<ReturnType<typeof db.table.aggregate>>,
    );
    vi.mocked(db.table.groupBy).mockResolvedValue([
      { capacity: 2, _count: { _all: 4 } },
      { capacity: 6, _count: { _all: 4 } },
    ] as unknown as Awaited<ReturnType<typeof db.table.groupBy>>);

    const res = await app.inject({
      method: 'GET',
      url: '/restaurant/onboarding/floor',
      headers: { authorization: 'Bearer test' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      tables: [
        { capacity: 2, count: 4 },
        { capacity: 6, count: 4 },
      ],
      stats: { tableCount: 8, seatCount: 28, largestTableCapacity: 6 },
    });
  });

  it('refuse une salle sans table', async () => {
    const app = await getApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/restaurant/onboarding/floor',
      headers: { authorization: 'Bearer test' },
      payload: { tables: [{ capacity: 4, count: 0 }] },
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('restaurant.routes - onboarding : restaurant en pratique', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enregistre les faits, synchronise la fiche Connect et invalide les caches', async () => {
    const app = await getApp();
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      practicalInfo: { parking: 'onsite', kidsMenu: true },
      ambiance: ['brunch', 'terrasse'],
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);
    vi.mocked(db.restaurant.update).mockResolvedValue({
      practicalInfo: { kidsMenu: true, terrace: false, pets: 'terrace' },
      ambiance: ['brunch'],
      dietary: ['vegan'],
      phoneNumber: '+33123456789',
      slug: 'le-bistrot',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);

    const res = await app.inject({
      method: 'PUT',
      url: '/restaurant/onboarding/practical',
      headers: { authorization: 'Bearer test' },
      payload: {
        practicalInfo: { parking: null, terrace: false, pets: 'terrace' },
        dietary: ['vegan'],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'test-rest-1' },
        data: {
          practicalInfo: { kidsMenu: true, terrace: false, pets: 'terrace' },
          ambiance: ['brunch'],
          dietary: ['vegan'],
        },
      }),
    );
    expect(res.json()).toMatchObject({ dietary: ['vegan'], ambiance: ['brunch'] });
  });

  it('refuse une valeur hors liste', async () => {
    const app = await getApp();

    const res = await app.inject({
      method: 'PUT',
      url: '/restaurant/onboarding/practical',
      headers: { authorization: 'Bearer test' },
      payload: { practicalInfo: { parking: 'garage' } },
    });

    expect(res.statusCode).toBe(400);
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });
});
