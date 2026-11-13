import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { ProvisioningService } from '../provisioning.service';

const telnyxMock = vi.hoisted(() => ({
  list: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../shared/telnyx/client', () => ({
  default: { phoneNumbers: telnyxMock },
  placeOutboundCall: vi.fn(),
}));

type Row = Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>;

const ENV_KEYS = ['NODE_ENV', 'TELNYX_API_KEY', 'TELNYX_CONNECTION_ID'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  for (const key of ENV_KEYS) {
    if (key in values) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  vi.mocked(db.restaurant.findMany).mockResolvedValue([]);
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('ProvisioningService.listAvailableNumbers', () => {
  it('en développement sans clé Telnyx, propose un jeu fictif marqué comme tel', async () => {
    setEnv({ NODE_ENV: 'development', TELNYX_API_KEY: undefined });

    const { numbers, source } = await ProvisioningService.listAvailableNumbers();

    expect(source).toBe('dev-fallback');
    expect(numbers.length).toBeGreaterThan(0);
    expect(telnyxMock.list).not.toHaveBeenCalled();
  });

  it('en production sans clé Telnyx, ne propose aucun numéro fictif', async () => {
    setEnv({ NODE_ENV: 'production', TELNYX_API_KEY: undefined });

    expect(await ProvisioningService.listAvailableNumbers()).toEqual({
      numbers: [],
      source: 'unavailable',
    });
  });

  it('si Telnyx échoue, la liste est vide et signalée, même hors production', async () => {
    setEnv({ NODE_ENV: 'development', TELNYX_API_KEY: 'k-test' });
    telnyxMock.list.mockRejectedValue(new Error('Telnyx indisponible'));

    expect(await ProvisioningService.listAvailableNumbers()).toEqual({
      numbers: [],
      source: 'unavailable',
    });
  });

  it('un compte Telnyx sans numéro donne une liste vide mais fiable, sans jeu fictif', async () => {
    setEnv({ NODE_ENV: 'production', TELNYX_API_KEY: 'k-test' });
    telnyxMock.list.mockResolvedValue({ data: [], meta: { total_pages: 1 } });

    expect(await ProvisioningService.listAvailableNumbers()).toEqual({
      numbers: [],
      source: 'telnyx',
    });
  });

  it('lit toutes les pages du compte Telnyx, pas seulement les 50 premiers numéros', async () => {
    setEnv({ NODE_ENV: 'production', TELNYX_API_KEY: 'k-test' });
    const page = (start: number, count: number) => ({
      data: Array.from({ length: count }, (_, index) => ({
        id: `tnx-${start + index}`,
        phone_number: `+3318900${String(start + index).padStart(4, '0')}`,
        status: 'active',
      })),
      meta: { total_pages: 3 },
    });
    telnyxMock.list
      .mockResolvedValueOnce(page(0, 100))
      .mockResolvedValueOnce(page(100, 100))
      .mockResolvedValueOnce(page(200, 30));

    const { numbers, source } = await ProvisioningService.listAvailableNumbers();

    expect(source).toBe('telnyx');
    expect(numbers).toHaveLength(230);
    expect(telnyxMock.list).toHaveBeenCalledTimes(3);
    expect(telnyxMock.list).toHaveBeenLastCalledWith({ page: { number: 3, size: 100 } });
  });

  it('indique à quel restaurant un numéro est déjà attribué', async () => {
    setEnv({ NODE_ENV: 'production', TELNYX_API_KEY: 'k-test' });
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { id: 'r1', name: 'Chez Émile', phoneNumber: '+33189000001', telnyxPhoneNumberId: 't1' },
      { id: 'r2', name: 'Sans numéro', phoneNumber: '+000sans-numero', telnyxPhoneNumberId: null },
    ] as never);
    telnyxMock.list.mockResolvedValue({
      data: [
        { id: 't1', phone_number: '+33189000001', status: 'active' },
        { id: 't2', phone_number: '+33189000002', status: 'active' },
      ],
    });

    const { numbers } = await ProvisioningService.listAvailableNumbers();

    expect(numbers[0]).toMatchObject({
      assignedToRestaurantId: 'r1',
      assignedToRestaurantName: 'Chez Émile',
    });
    expect(numbers[1]).toMatchObject({ assignedToRestaurantId: null });
  });
});

describe('ProvisioningService.assignPhoneNumber : lien avec l’application voix', () => {
  const restaurant = {
    id: 'rest-1',
    name: 'Chez Suppernote',
    phoneNumber: '+000rest-1',
    provisioningStatus: 'PENDING',
    telnyxPhoneNumberId: null,
    forwardingConfiguredAt: null,
    testCallValidatedAt: null,
    firstCallAt: null,
    onboardingTasks: {},
  };

  /** Dernier état de lien écrit en base par l'attribution. */
  function persistedLink() {
    const calls = vi.mocked(db.restaurant.update).mock.calls;
    const last = calls.at(-1)?.[0].data as {
      onboardingTasks?: { phone?: { metadata?: Record<string, unknown> } };
    };
    return last.onboardingTasks?.phone?.metadata?.voiceAppLink;
  }

  beforeEach(() => {
    vi.mocked(db.restaurant.findFirst).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue(restaurant as unknown as Row);
    vi.mocked(db.restaurant.update).mockResolvedValue({
      ...restaurant,
      phoneNumber: '+33451221999',
      onboardingTasks: {},
    } as unknown as Awaited<ReturnType<typeof db.restaurant.update>>);
    telnyxMock.update.mockResolvedValue({});
  });

  it('relie le numéro à l’application voix et l’enregistre', async () => {
    setEnv({ TELNYX_API_KEY: 'k-test', TELNYX_CONNECTION_ID: 'conn-1' });

    await ProvisioningService.assignPhoneNumber('rest-1', '+33451221999', 'tnx-1');

    expect(telnyxMock.update).toHaveBeenCalledWith('tnx-1', { connection_id: 'conn-1' });
    expect(persistedLink()).toBe('linked');
  });

  it('enregistre l’échec quand Telnyx refuse, sans empêcher l’attribution', async () => {
    setEnv({ TELNYX_API_KEY: 'k-test', TELNYX_CONNECTION_ID: 'conn-1' });
    telnyxMock.update.mockRejectedValue(new Error('refusé'));

    await expect(
      ProvisioningService.assignPhoneNumber('rest-1', '+33451221999', 'tnx-1'),
    ).resolves.toBeDefined();
    expect(persistedLink()).toBe('failed');
  });

  it('signale l’absence de TELNYX_CONNECTION_ID', async () => {
    setEnv({ TELNYX_API_KEY: 'k-test', TELNYX_CONNECTION_ID: undefined });

    await ProvisioningService.assignPhoneNumber('rest-1', '+33451221999', 'tnx-1');

    expect(telnyxMock.update).not.toHaveBeenCalled();
    expect(persistedLink()).toBe('skipped_no_connection_id');
  });

  it('signale un numéro saisi à la main (aucun identifiant Telnyx)', async () => {
    setEnv({ TELNYX_API_KEY: 'k-test', TELNYX_CONNECTION_ID: 'conn-1' });

    await ProvisioningService.assignPhoneNumber('rest-1', '+33451221999');

    expect(telnyxMock.update).not.toHaveBeenCalled();
    expect(persistedLink()).toBe('skipped_manual_number');
  });

  it('signale l’absence de configuration Telnyx', async () => {
    setEnv({ TELNYX_API_KEY: undefined, TELNYX_CONNECTION_ID: 'conn-1' });

    await ProvisioningService.assignPhoneNumber('rest-1', '+33451221999', 'tnx-1');

    expect(persistedLink()).toBe('skipped_no_telnyx');
  });
});

describe('ProvisioningService.getProvisioningStatus : état du lien', () => {
  const base = {
    id: 'rest-1',
    name: 'Chez Suppernote',
    city: null,
    phoneNumber: '+33451221999',
    provisioningStatus: 'PHONE_ASSIGNED',
    telnyxPhoneNumberId: 'tnx-1',
    forwardingConfiguredAt: null,
    testCallValidatedAt: null,
    firstCallAt: null,
  };

  it('relit l’état enregistré à l’attribution', async () => {
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...base,
      onboardingTasks: { phone: { status: 'completed', metadata: { voiceAppLink: 'failed' } } },
    } as unknown as Row);

    const status = await ProvisioningService.getProvisioningStatus('rest-1');
    expect(status.steps.assignment.voiceAppLink).toBe('failed');
  });

  it('un numéro attribué avant l’enregistrement du lien a un état inconnu', async () => {
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...base,
      onboardingTasks: {
        phone: { status: 'completed', metadata: { assignedPhone: '+33451221999' } },
      },
    } as unknown as Row);

    const status = await ProvisioningService.getProvisioningStatus('rest-1');
    expect(status.steps.assignment.voiceAppLink).toBeNull();
  });

  it('un restaurant sans numéro n’a pas d’état de lien', async () => {
    vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValue({
      ...base,
      phoneNumber: '+000rest-1',
      onboardingTasks: { phone: { status: 'pending', metadata: { voiceAppLink: 'linked' } } },
    } as unknown as Row);

    const status = await ProvisioningService.getProvisioningStatus('rest-1');
    expect(status.steps.assignment.voiceAppLink).toBeNull();
  });
});
