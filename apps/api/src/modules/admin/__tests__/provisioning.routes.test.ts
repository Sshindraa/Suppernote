import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import telnyx from '../../../shared/telnyx/client';

const AUTH = { authorization: 'Bearer fake-token' };

vi.mock('../../../shared/telnyx/client', () => ({
  default: {
    phoneNumbers: {
      list: vi.fn().mockResolvedValue({ data: [] }),
      update: vi.fn().mockResolvedValue({}),
    },
  },
  placeOutboundCall: vi.fn().mockResolvedValue({ callControlId: 'test-call-control-123' }),
}));

describe('admin provisioning routes', () => {
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('GET /admin/provisioning/available-numbers retourne la liste des numéros', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([]);
    (
      telnyx as unknown as { phoneNumbers: { list: ReturnType<typeof vi.fn> } }
    ).phoneNumbers.list.mockResolvedValueOnce({
      data: [{ id: 'tnx-1', phone_number: '+33451221999', status: 'active' }],
    });

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/provisioning/available-numbers',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.source).toBe('telnyx');
    expect(body.numbers).toEqual([
      expect.objectContaining({ id: 'tnx-1', phoneNumber: '+33451221999' }),
    ]);
  });

  it('GET /admin/provisioning/available-numbers ne remplace jamais un compte Telnyx vide par de faux numéros', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([]);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/provisioning/available-numbers',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, numbers: [], source: 'telnyx' });
  });

  it('GET /admin/provisioning/:restaurantId retourne le statut de provisioning', async () => {
    const mockRestaurant = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'PHONE_ASSIGNED',
      telnyxPhoneNumberId: 'tnx-123',
      forwardingConfiguredAt: new Date('2026-07-22T10:00:00Z'),
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {},
    };

    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce(
      mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/provisioning/test-rest-1',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status.restaurantId).toBe('test-rest-1');
    expect(body.status.hasAssignedPhone).toBe(true);
    expect(body.status.steps.assignment.completed).toBe(true);
    expect(body.status.forwardingCode).toBe('*21*+33451221528#');
  });

  describe('fin de la salle dans le statut de provisioning', () => {
    const done = (completedAt: string) => ({ status: 'completed', completedAt });
    const restaurant = (overrides: Record<string, unknown>) => ({
      id: 'resto',
      name: 'Chez Émile',
      city: 'Lyon',
      phoneNumber: '+000chez-emile',
      provisioningStatus: 'PENDING',
      telnyxPhoneNumberId: null,
      forwardingConfiguredAt: null,
      testCallValidatedAt: null,
      firstCallAt: null,
      managerName: 'Émile Dupont',
      managerEmail: 'emile@gerant.test',
      managerPhone: '+33612345678',
      onboardingTasks: {},
      ...overrides,
    });
    const asRestaurant = (value: unknown) =>
      value as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>;

    it('renvoie la fin de la salle (la plus récente des trois tâches) et la ville', async () => {
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce(
        asRestaurant(
          restaurant({
            onboardingTasks: {
              restaurant: done('2026-10-12T08:00:00.000Z'),
              hours: done('2026-10-12T08:05:00.000Z'),
              floor: done('2026-10-12T08:30:00.000Z'),
            },
          }),
        ),
      );
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/provisioning/resto',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toMatchObject({
        city: 'Lyon',
        hasAssignedPhone: false,
        floorCompletedAt: '2026-10-12T08:30:00.000Z',
      });
    });

    it('renvoie null tant que la salle n’est pas terminée', async () => {
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce(
        asRestaurant(
          restaurant({
            onboardingTasks: {
              restaurant: done('2026-10-12T08:00:00.000Z'),
              hours: done('2026-10-12T08:05:00.000Z'),
              floor: { status: 'current' },
            },
          }),
        ),
      );
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/provisioning/resto',
        headers: AUTH,
      });
      expect(res.json().status.floorCompletedAt).toBeNull();
    });

    it('la liste porte ce champ pour chaque restaurant, sans donnée du gérant', async () => {
      vi.mocked(db.restaurant.findMany).mockResolvedValueOnce([
        { id: 'a' },
        { id: 'b' },
      ] as unknown as Awaited<ReturnType<typeof db.restaurant.findMany>>);
      vi.mocked(db.restaurant.findUniqueOrThrow)
        .mockResolvedValueOnce(
          asRestaurant(
            restaurant({
              id: 'a',
              onboardingTasks: {
                restaurant: done('2026-10-12T08:00:00.000Z'),
                hours: done('2026-10-12T08:05:00.000Z'),
                floor: done('2026-10-12T08:30:00.000Z'),
              },
            }),
          ),
        )
        .mockResolvedValueOnce(asRestaurant(restaurant({ id: 'b', city: null })));
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/admin/provisioning/restaurants',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const { restaurants } = res.json();
      expect(
        restaurants.map((r: { floorCompletedAt: string | null }) => r.floorCompletedAt),
      ).toEqual(['2026-10-12T08:30:00.000Z', null]);
      expect(restaurants[1].city).toBeNull();
      const body = res.body;
      for (const personal of ['Émile Dupont', 'emile@gerant.test', '+33612345678']) {
        expect(body).not.toContain(personal);
      }
    });
  });

  it('POST /admin/provisioning/:restaurantId/assign-phone attribue un numéro et met à jour le statut', async () => {
    const mockRestaurant = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+000test-rest-1',
      provisioningStatus: 'PENDING',
      telnyxPhoneNumberId: null,
      forwardingConfiguredAt: null,
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {},
    };

    vi.mocked(db.restaurant.findFirst).mockResolvedValueOnce(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(
      mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const updatedRestaurant = {
      ...mockRestaurant,
      phoneNumber: '+33451221528',
      provisioningStatus: 'PHONE_ASSIGNED',
      telnyxPhoneNumberId: 'tnx-999',
    };

    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      updatedRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/assign-phone',
      headers: AUTH,
      payload: {
        phoneNumber: '+33451221528',
        telnyxPhoneNumberId: 'tnx-999',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.message).toContain('+33451221528');
    expect(db.restaurant.update).toHaveBeenCalled();
  });

  it('POST /admin/provisioning/:restaurantId/verify-webhook valide le webhook', async () => {
    const mockRestaurant = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'PHONE_ASSIGNED',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: null,
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {},
    };

    const updated = {
      ...mockRestaurant,
      provisioningStatus: 'WEBHOOK_READY',
      forwardingConfiguredAt: null,
    };

    vi.mocked(db.restaurant.findUniqueOrThrow)
      .mockResolvedValueOnce(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      )
      .mockResolvedValueOnce(
        updated as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );

    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      updated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/verify-webhook',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.status.steps.webhook.completed).toBe(true);
    expect(body.status.steps.forwarding.completed).toBe(false);
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({ forwardingConfiguredAt: expect.anything() }),
      }),
    );
  });

  it('POST /admin/provisioning/:restaurantId/mark-forwarding enregistre l’attestation opérateur', async () => {
    const mockRestaurant = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'WEBHOOK_READY',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: null,
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {},
    };

    const updated = {
      ...mockRestaurant,
      forwardingConfiguredAt: new Date('2026-07-22T10:05:00Z'),
    };

    vi.mocked(db.restaurant.findUniqueOrThrow)
      .mockResolvedValueOnce(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      )
      .mockResolvedValueOnce(
        updated as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );
    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      updated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/mark-forwarding',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      status: { steps: { forwarding: { completed: true } } },
    });
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { forwardingConfiguredAt: expect.any(Date) },
      }),
    );
  });

  it('POST /admin/provisioning/:restaurantId/test-call déclenche un appel test', async () => {
    const mockRestaurant = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      managerPhone: '+33612345678',
      provisioningStatus: 'WEBHOOK_READY',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: new Date(),
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {},
    };

    vi.mocked(db.restaurant.findUnique).mockResolvedValueOnce({
      managerPhone: '+33612345678',
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

    const updated = {
      ...mockRestaurant,
      provisioningStatus: 'TEST_CALL_PENDING',
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {
        phone: {
          status: 'completed',
          metadata: { testCallControlId: 'test-call-control-123' },
        },
      },
    };

    vi.mocked(db.restaurant.findUniqueOrThrow)
      .mockResolvedValueOnce(
        mockRestaurant as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      )
      .mockResolvedValueOnce(
        updated as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );

    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      updated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/test-call',
      headers: AUTH,
      payload: {
        targetPhoneNumber: '+33612345678',
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.callControlId).toBe('test-call-control-123');
    expect(body.message).toContain('+33612345678');
    expect(body.status.provisioningStatus).toBe('TEST_CALL_PENDING');
    expect(body.status.steps.testCall.completed).toBe(false);
  });

  it('POST /admin/provisioning/:restaurantId/validate-test-call confirme uniquement le dernier appel', async () => {
    const requested = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'TEST_CALL_PENDING',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: new Date('2026-07-22T10:00:00Z'),
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {
        phone: {
          status: 'completed',
          metadata: { testCallControlId: 'test-call-control-123' },
        },
      },
    };
    const validated = {
      ...requested,
      provisioningStatus: 'TEST_CALL_COMPLETED',
      testCallValidatedAt: new Date('2026-07-22T10:10:00Z'),
      firstCallAt: new Date('2026-07-22T10:10:00Z'),
    };

    vi.mocked(db.restaurant.findUniqueOrThrow)
      .mockResolvedValueOnce(
        requested as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      )
      .mockResolvedValueOnce(
        validated as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );
    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      validated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/validate-test-call',
      headers: AUTH,
      payload: { callControlId: 'test-call-control-123' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      status: {
        provisioningStatus: 'TEST_CALL_COMPLETED',
        steps: { testCall: { completed: true } },
      },
    });
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          testCallValidatedAt: expect.any(Date),
          provisioningStatus: 'TEST_CALL_COMPLETED',
        }),
      }),
    );
  });

  it('refuse de confirmer un appel test dont l’identifiant ne correspond pas', async () => {
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce({
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'TEST_CALL_PENDING',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: new Date(),
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingTasks: {
        phone: { status: 'completed', metadata: { testCallControlId: 'expected-call' } },
      },
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/validate-test-call',
      headers: AUTH,
      payload: { callControlId: 'other-call' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'TEST_CALL_NOT_PENDING' });
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('refuse de finaliser un provisioning sans preuve d’appel test', async () => {
    const incomplete = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'WEBHOOK_READY',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: new Date('2026-07-22T10:00:00Z'),
      testCallValidatedAt: null,
      firstCallAt: null,
      onboardingActivatedAt: null,
      onboardingTasks: {},
    };

    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce(
      incomplete as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/complete',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'PROVISIONING_NOT_READY',
      missing: ['test_call'],
    });
    expect(db.restaurant.update).not.toHaveBeenCalled();
  });

  it('finalise un provisioning dont les preuves sont présentes sans les fabriquer', async () => {
    const ready = {
      id: 'test-rest-1',
      name: 'Chez Suppernote Test',
      phoneNumber: '+33451221528',
      provisioningStatus: 'ACTIVE',
      telnyxPhoneNumberId: 'tnx-999',
      forwardingConfiguredAt: new Date('2026-07-22T10:00:00Z'),
      testCallValidatedAt: new Date('2026-07-22T10:05:00Z'),
      firstCallAt: new Date('2026-07-22T10:05:00Z'),
      onboardingActivatedAt: null,
      onboardingTasks: {},
    };
    const updated = { ...ready, onboardingActivatedAt: new Date('2026-07-22T10:10:00Z') };

    vi.mocked(db.restaurant.findUniqueOrThrow)
      .mockResolvedValueOnce(
        ready as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      )
      .mockResolvedValueOnce(
        updated as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>,
      );
    vi.mocked(db.restaurant.update).mockResolvedValueOnce(
      updated as unknown as Awaited<ReturnType<typeof db.restaurant.update>>,
    );

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/provisioning/test-rest-1/complete',
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(db.restaurant.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ provisioningStatus: 'ACTIVE' }),
      }),
    );
    const updateData = vi.mocked(db.restaurant.update).mock.calls.at(-1)?.[0].data as Record<
      string,
      unknown
    >;
    expect(updateData.forwardingConfiguredAt).toBeUndefined();
    expect(updateData.testCallValidatedAt).toBeUndefined();
  });
});
