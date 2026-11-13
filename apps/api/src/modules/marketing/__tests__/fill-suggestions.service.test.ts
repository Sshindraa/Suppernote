import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import { parisParts } from '../../companion/query-data';
import type { TonightService } from '../../companion/tonight';
import { forecastEmptyPlaces, loadForecastHistory, serviceWindow } from '../fill-forecast';
import {
  estimateFillCost,
  loadServiceFillContext,
  planOpenService,
  serviceAvailability,
  serviceCapacity,
} from '../fill-service.service';
import {
  dismissFillSuggestion,
  invalidateFillSuggestions,
  listFillSuggestions,
} from '../fill-suggestions.service';

vi.mock('../../../shared/db/client', () => ({
  db: { marketingCampaign: { findMany: vi.fn() }, restaurant: { findUnique: vi.fn() } },
}));
vi.mock('../../../shared/redis/client', () => ({
  redisCache: { get: vi.fn(), set: vi.fn(), del: vi.fn(), mget: vi.fn() },
}));
vi.mock('../fill-forecast', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fill-forecast')>()),
  loadForecastHistory: vi.fn(),
  forecastEmptyPlaces: vi.fn(),
}));
vi.mock('../fill-service.service', () => ({
  HOLDOUT_RATE: 0.3,
  serviceCapacity: vi.fn(),
  serviceAvailability: vi.fn(),
  loadServiceFillContext: vi.fn(),
  planOpenService: vi.fn(),
  estimateFillCost: vi.fn(),
}));

// Lundi 2 novembre 2026, 11 h à Paris (UTC+1).
const NOW = new Date('2026-11-02T10:00:00.000Z');
const TODAY = '2026-11-02';

type Floor = {
  capacity: number;
  free: number;
  open?: boolean;
  bookable?: boolean;
  /** Premier créneau, heure de Paris ; par défaut dans 10 h. */
  firstSlotAt?: Date | null;
};

/** Le jour et le service d'une fenêtre, pour piloter les mocks par service. */
function keyOf(start: Date): string {
  const date = parisParts(start).dayKey;
  const service: TonightService =
    start.getTime() === serviceWindow(date, 'midi').start.getTime() ? 'midi' : 'soir';
  return `${date}:${service}`;
}

type PlanOverrides = {
  members?: number;
  holdoutCount?: number;
  tiers?: Record<string, number>;
  budgetExhausted?: boolean;
  groupSize?: number;
};

/** Plan par service (clé date:service) ; par défaut, aucun envoi. */
function mockPlans(plans: Record<string, PlanOverrides> = {}) {
  vi.mocked(planOpenService).mockImplementation(((
    _context: unknown,
    args: { date: string; service: string },
  ) => {
    const plan = plans[`${args.date}:${args.service}`] ?? {};
    return {
      status: 'PLANNED',
      members: Array.from({ length: plan.members ?? 0 }, (_, i) => ({ customerId: `c${i}` })),
      holdoutCount: plan.holdoutCount ?? 0,
      tiers: plan.tiers ?? {},
      budgetExhausted: plan.budgetExhausted ?? false,
      groupSize: plan.groupSize ?? 2,
    };
  }) as never);
}

function mockFloor(floors: Record<string, Floor>, fallback?: Floor) {
  const pick = (start: Date) => floors[keyOf(start)] ?? fallback;
  vi.mocked(serviceCapacity).mockImplementation((async (args: { start: Date }) => {
    const floor = pick(args.start);
    if (!floor) return { known: false };
    return {
      known: true,
      capacity: floor.capacity,
      booked: floor.capacity - floor.free,
      free: floor.free,
    };
  }) as never);
  vi.mocked(serviceAvailability).mockImplementation((async (args: { start: Date }) => {
    const floor = pick(args.start);
    const open = floor?.open ?? true;
    return {
      open,
      bookable: open && (floor?.bookable ?? true),
      firstSlotAt: open ? (floor?.firstSlotAt ?? new Date(NOW.getTime() + 10 * 3_600_000)) : null,
    };
  }) as never);
}

describe('suggestions de services creux', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(db.marketingCampaign.findMany).mockResolvedValue([] as never);
    vi.mocked(loadForecastHistory).mockResolvedValue([]);
    // Prévision neutre : les places vides sont les places libres.
    vi.mocked(forecastEmptyPlaces).mockImplementation(
      (args) =>
        ({ emptyPlaces: args.freePlaces, lateArrivals: 0, forecastSource: 'simple' }) as never,
    );
    vi.mocked(loadServiceFillContext).mockResolvedValue({ members: [] } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ name: 'Chez Suppernote' } as never);
    vi.mocked(estimateFillCost).mockResolvedValue({ amount: '1.50', status: 'PRICED' } as never);
    mockPlans();
    vi.stubEnv('MARKETING_SENDS_ENABLED', 'true');
    vi.mocked(redisCache.get).mockResolvedValue(null);
    vi.mocked(redisCache.set).mockResolvedValue('OK' as never);
    vi.mocked(redisCache.del).mockResolvedValue(1 as never);
    vi.mocked(redisCache.mget).mockImplementation((async (...keys: string[]) =>
      keys.map(() => null)) as never);
  });

  it('exclut service fermé, plein, capacité inconnue', async () => {
    mockFloor({
      [`${TODAY}:soir`]: { capacity: 20, free: 20, open: false },
      [`2026-11-03:midi`]: { capacity: 20, free: 20, bookable: false },
      [`2026-11-03:soir`]: { capacity: 20, free: 20 },
    });
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => `${s.date}:${s.service}`)).toEqual(['2026-11-03:soir']);
  });

  it('exclut un service ayant une campagne prévue, pas une campagne annulée', async () => {
    mockFloor(
      {
        [`${TODAY}:soir`]: { capacity: 20, free: 12 },
        [`2026-11-03:soir`]: { capacity: 20, free: 11 },
      },
      { capacity: 20, free: 0 },
    );
    vi.mocked(db.marketingCampaign.findMany).mockResolvedValue([
      { targetServiceStart: serviceWindow(TODAY, 'soir').start },
    ] as never);
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => `${s.date}:${s.service}`)).toEqual(['2026-11-03:soir']);
    const where = vi.mocked(db.marketingCampaign.findMany).mock.calls[0][0]?.where as {
      restaurantId: string;
      status: unknown;
    };
    expect(where.restaurantId).toBe('r1');
    expect(where.status).toEqual({ notIn: ['CANCELLED', 'FAILED'] });
  });

  it('seuil : retient 9 places vides sur 20 couverts, écarte 7', async () => {
    mockFloor({
      [`2026-11-03:soir`]: { capacity: 20, free: 9 },
      [`2026-11-04:soir`]: { capacity: 20, free: 7 },
    });
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => s.date)).toEqual(['2026-11-03']);
  });

  it('capacité 100 : écarte 29, retient 30', async () => {
    mockFloor({
      [`2026-11-03:soir`]: { capacity: 100, free: 29 },
      [`2026-11-04:soir`]: { capacity: 100, free: 30 },
    });
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => s.date)).toEqual(['2026-11-04']);
  });

  it('service du jour : écarte un premier créneau à moins de 2 h ou passé, retient à plus de 2 h', async () => {
    const at = (iso: string) => new Date(iso);
    mockFloor({
      // Midi à 12 h 30 Paris = 11 h 30 UTC : dans 1 h 30.
      [`${TODAY}:midi`]: { capacity: 20, free: 15, firstSlotAt: at('2026-11-02T11:30:00.000Z') },
      // Soir à 19 h Paris = 18 h UTC : dans 8 h.
      [`${TODAY}:soir`]: { capacity: 20, free: 14, firstSlotAt: at('2026-11-02T18:00:00.000Z') },
      // Créneau passé.
      [`2026-11-03:midi`]: { capacity: 20, free: 13, firstSlotAt: at('2026-11-02T09:00:00.000Z') },
    });
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => `${s.date}:${s.service}`)).toEqual([`${TODAY}:soir`]);

    // Un midi à 19 h : sa fenêtre commence à minuit mais son premier créneau est dans 8 h.
    mockFloor({
      [`${TODAY}:midi`]: { capacity: 20, free: 15, firstSlotAt: at('2026-11-02T18:00:00.000Z') },
    });
    const late = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(late.map((s) => `${s.date}:${s.service}`)).toEqual([`${TODAY}:midi`]);
  });

  it('horizon : aujourd’hui et les 6 jours suivants, 14 services évalués au plus', async () => {
    mockFloor({}, { capacity: 20, free: 0 });
    await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(serviceCapacity).toHaveBeenCalledTimes(14);
    const dates = new Set(
      vi.mocked(serviceCapacity).mock.calls.map(([args]) => parisParts(args.start).dayKey),
    );
    expect([...dates].sort()).toEqual([
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
      '2026-11-06',
      '2026-11-07',
      '2026-11-08',
    ]);
  });

  it('classement : places vides décroissantes, puis date la plus proche ; 3 au maximum', async () => {
    mockFloor({
      [`2026-11-03:soir`]: { capacity: 30, free: 12 },
      [`2026-11-04:soir`]: { capacity: 30, free: 20 },
      [`2026-11-05:soir`]: { capacity: 30, free: 12 },
      [`2026-11-06:soir`]: { capacity: 30, free: 25 },
      [`2026-11-07:soir`]: { capacity: 30, free: 10 },
    });
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => `${s.date}:${s.emptyPlaces}`)).toEqual([
      '2026-11-06:25',
      '2026-11-04:20',
      '2026-11-03:12',
    ]);
    expect(list[0]).toEqual({
      date: '2026-11-06',
      service: 'soir',
      capacity: 30,
      freePlaces: 25,
      emptyPlaces: 25,
      forecastSource: 'simple',
      sends: 0,
      tiers: {},
      costEstimate: null,
      canPrepare: false,
      prepareBlockedReason: 'NO_AUDIENCE',
    });
  });

  it('écarte un service ignoré', async () => {
    mockFloor({
      [`2026-11-03:soir`]: { capacity: 20, free: 15 },
      [`2026-11-04:soir`]: { capacity: 20, free: 14 },
    });
    vi.mocked(redisCache.mget).mockImplementation((async (...keys: string[]) =>
      keys.map((key) => (key.endsWith(':2026-11-03:soir') ? '1' : null))) as never);
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list.map((s) => s.date)).toEqual(['2026-11-04']);
  });

  it('sert le cache sans recalcul ; le cache contient seulement des champs de FillSuggestion', async () => {
    mockFloor({ [`2026-11-03:soir`]: { capacity: 20, free: 15 } });
    await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    const [key, value, mode, ttl] = vi.mocked(redisCache.set).mock.calls[0] as unknown as [
      string,
      string,
      string,
      number,
    ];
    expect(key).toBe('marketing:fill-suggestions:r1');
    expect(mode).toBe('EX');
    expect(ttl).toBe(1800);
    expect(Object.keys(JSON.parse(value)[0]).sort()).toEqual([
      'canPrepare',
      'capacity',
      'costEstimate',
      'date',
      'emptyPlaces',
      'forecastSource',
      'freePlaces',
      'prepareBlockedReason',
      'sends',
      'service',
      'tiers',
    ]);

    vi.clearAllMocks();
    vi.mocked(redisCache.get).mockResolvedValue(value);
    const cached = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(cached).toEqual(JSON.parse(value));
    expect(serviceCapacity).not.toHaveBeenCalled();
    expect(db.marketingCampaign.findMany).not.toHaveBeenCalled();
  });

  it('Redis en panne à la lecture et à l’écriture : la liste est calculée quand même', async () => {
    mockFloor({ [`2026-11-03:soir`]: { capacity: 20, free: 15 } });
    vi.mocked(redisCache.get).mockRejectedValue(new Error('down'));
    vi.mocked(redisCache.set).mockRejectedValue(new Error('down'));
    vi.mocked(redisCache.mget).mockRejectedValue(new Error('down'));
    const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(list).toHaveLength(1);
  });

  it('lecture des services ignorés en échec : la liste est servie mais le cache n’est pas écrit', async () => {
    mockFloor({ [`2026-11-03:soir`]: { capacity: 20, free: 15 } });
    vi.mocked(redisCache.mget).mockRejectedValue(new Error('down'));
    await listFillSuggestions({ restaurantId: 'r1', now: NOW });
    expect(redisCache.set).not.toHaveBeenCalled();
  });

  it('dismiss : clé marketing:fill-dismissed:{restaurant}:{date}:{service}, EX 604800, et supprime le cache', async () => {
    await dismissFillSuggestion({ restaurantId: 'r1', date: '2026-11-03', service: 'soir' });
    expect(redisCache.set).toHaveBeenCalledWith(
      'marketing:fill-dismissed:r1:2026-11-03:soir',
      '1',
      'EX',
      604800,
    );
    expect(redisCache.del).toHaveBeenCalledWith('marketing:fill-suggestions:r1');

    vi.mocked(redisCache.set).mockRejectedValue(new Error('down'));
    await expect(
      dismissFillSuggestion({ restaurantId: 'r1', date: '2026-11-03', service: 'soir' }),
    ).rejects.toThrow('down');
  });

  it('invalidate n’échoue jamais', async () => {
    vi.mocked(redisCache.del).mockRejectedValue(new Error('down'));
    await expect(invalidateFillSuggestions('r1')).resolves.toBeUndefined();
  });

  describe('envois, composition et coût', () => {
    const floors = {
      [`2026-11-03:soir`]: { capacity: 30, free: 12 },
      [`2026-11-04:soir`]: { capacity: 30, free: 20 },
      [`2026-11-05:soir`]: { capacity: 30, free: 25 },
    };

    it('charge le contexte une seule fois pour tous les services, sur le canal EMAIL', async () => {
      mockFloor(floors);
      await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(loadServiceFillContext).toHaveBeenCalledTimes(1);
      expect(loadServiceFillContext).toHaveBeenCalledWith({
        restaurantId: 'r1',
        channel: 'EMAIL',
        through: '2026-11-05',
        now: NOW,
      });
      expect(db.restaurant.findUnique).toHaveBeenCalledTimes(1);
      expect(planOpenService).toHaveBeenCalledTimes(3);
    });

    it('aucun service retenu : le contexte n’est pas chargé', async () => {
      mockFloor({}, { capacity: 20, free: 0 });
      await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(loadServiceFillContext).not.toHaveBeenCalled();
    });

    it('envois = audience − témoin, composition et coût estimé sur ces envois', async () => {
      mockFloor({ [`2026-11-03:soir`]: { capacity: 30, free: 12 } });
      mockPlans({
        '2026-11-03:soir': { members: 20, holdoutCount: 2, tiers: { CRENEAU: 8, CONNU: 12 } },
      });
      const [item] = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(item).toMatchObject({
        sends: 18,
        tiers: { CRENEAU: 8, CONNU: 12 },
        costEstimate: { amount: '1.50', status: 'PRICED' },
        canPrepare: true,
      });
      expect(estimateFillCost).toHaveBeenCalledWith({
        restaurantName: 'Chez Suppernote',
        channel: 'EMAIL',
        sends: 18,
        now: NOW,
      });
    });

    it('le coût n’est estimé que pour les 3 services renvoyés', async () => {
      mockFloor({
        [`2026-11-03:soir`]: { capacity: 30, free: 12 },
        [`2026-11-04:soir`]: { capacity: 30, free: 13 },
        [`2026-11-05:soir`]: { capacity: 30, free: 14 },
        [`2026-11-06:soir`]: { capacity: 30, free: 15 },
        [`2026-11-07:soir`]: { capacity: 30, free: 16 },
      });
      mockPlans({
        '2026-11-03:soir': { members: 10, tiers: { CRENEAU: 10 } },
        '2026-11-04:soir': { members: 10, tiers: { CRENEAU: 10 } },
        '2026-11-05:soir': { members: 10, tiers: { CRENEAU: 10 } },
        '2026-11-06:soir': { members: 10, tiers: { CRENEAU: 10 } },
        '2026-11-07:soir': { members: 10, tiers: { CRENEAU: 10 } },
      });
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(list).toHaveLength(3);
      expect(estimateFillCost).toHaveBeenCalledTimes(3);
      expect(list.every((s) => s.costEstimate !== null)).toBe(true);
    });

    it('canPrepare faux sans MARKETING_SENDS_ENABLED, budget épuisé ou zéro envoi : le service reste listé', async () => {
      mockFloor({ [`2026-11-03:soir`]: { capacity: 30, free: 12 } });
      const plan = { members: 10, holdoutCount: 1, tiers: { CRENEAU: 10 } };

      mockPlans({ '2026-11-03:soir': plan });
      vi.stubEnv('MARKETING_SENDS_ENABLED', 'false');
      expect((await listFillSuggestions({ restaurantId: 'r1', now: NOW }))[0]).toMatchObject({
        canPrepare: false,
        sends: 9,
      });

      vi.stubEnv('MARKETING_SENDS_ENABLED', 'true');
      mockPlans({ '2026-11-03:soir': { ...plan, budgetExhausted: true } });
      expect((await listFillSuggestions({ restaurantId: 'r1', now: NOW }))[0].canPrepare).toBe(
        false,
      );

      mockPlans({ '2026-11-03:soir': { members: 0 } });
      const none = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(none).toHaveLength(1);
      expect(none[0]).toMatchObject({ canPrepare: false, sends: 0, costEstimate: null });
    });

    it('prepareBlockedReason : priorité envois coupés, puis budget épuisé, puis aucun envoi ; null si préparable', async () => {
      mockFloor({ [`2026-11-03:soir`]: { capacity: 30, free: 12 } });
      const reason = async () =>
        (await listFillSuggestions({ restaurantId: 'r1', now: NOW }))[0].prepareBlockedReason;
      const empty = { members: 0, budgetExhausted: true };
      const ok = { members: 10, tiers: { CRENEAU: 10 } };

      mockPlans({ '2026-11-03:soir': ok });
      expect(await reason()).toBeNull();

      mockPlans({ '2026-11-03:soir': { ...ok, budgetExhausted: true } });
      expect(await reason()).toBe('BUDGET_EXHAUSTED');

      mockPlans({ '2026-11-03:soir': { members: 0 } });
      expect(await reason()).toBe('NO_AUDIENCE');

      // Budget épuisé et aucun envoi : le budget prime sur l'audience.
      mockPlans({ '2026-11-03:soir': empty });
      expect(await reason()).toBe('BUDGET_EXHAUSTED');

      // Envois coupés prime sur tout.
      vi.stubEnv('MARKETING_SENDS_ENABLED', 'false');
      expect(await reason()).toBe('SENDS_DISABLED');
      mockPlans({ '2026-11-03:soir': ok });
      expect(await reason()).toBe('SENDS_DISABLED');
    });

    it('AUDIENCE_TOO_LARGE : prepareBlockedReason NO_AUDIENCE', async () => {
      mockFloor(floors);
      vi.mocked(loadServiceFillContext).mockRejectedValue(new Error('AUDIENCE_TOO_LARGE:5000'));
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(list.map((s) => s.prepareBlockedReason)).toEqual([
        'NO_AUDIENCE',
        'NO_AUDIENCE',
        'NO_AUDIENCE',
      ]);
    });

    it('le champ passe dans le cache ; une ancienne entrée sans le champ reste lisible', async () => {
      mockFloor({ [`2026-11-03:soir`]: { capacity: 30, free: 12 } });
      await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      const cached = JSON.parse(vi.mocked(redisCache.set).mock.calls[0][1] as string);
      expect(cached[0].prepareBlockedReason).toBe('NO_AUDIENCE');

      const { prepareBlockedReason: _gone, ...legacy } = cached[0];
      vi.mocked(redisCache.get).mockResolvedValue(JSON.stringify([legacy]));
      const [item] = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(item).toEqual(legacy);
    });

    it('AUDIENCE_TOO_LARGE : services listés, canPrepare faux, sends 0, aucune erreur', async () => {
      mockFloor(floors);
      vi.mocked(loadServiceFillContext).mockRejectedValue(new Error('AUDIENCE_TOO_LARGE:5000'));
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(list).toHaveLength(3);
      for (const item of list) {
        expect(item).toMatchObject({ sends: 0, tiers: {}, costEstimate: null, canPrepare: false });
      }
      expect(planOpenService).not.toHaveBeenCalled();
    });

    it('une autre erreur de chargement remonte', async () => {
      mockFloor(floors);
      vi.mocked(loadServiceFillContext).mockRejectedValue(new Error('db down'));
      await expect(listFillSuggestions({ restaurantId: 'r1', now: NOW })).rejects.toThrow(
        'db down',
      );
    });

    it('classement : canPrepare d’abord, puis couverts attendus par envoi, puis date', async () => {
      mockFloor({
        [`2026-11-03:soir`]: { capacity: 30, free: 25 }, // non préparable, le plus de places vides
        [`2026-11-04:soir`]: { capacity: 30, free: 12 }, // préparable, score 0,3 × 2 × 0,7
        [`2026-11-05:soir`]: { capacity: 30, free: 11 }, // préparable, score 0,03 × 2 × 0,7
        [`2026-11-06:soir`]: { capacity: 30, free: 10 }, // préparable, même score que le 4
      });
      mockPlans({
        '2026-11-04:soir': { members: 10, tiers: { CRENEAU: 10 } },
        '2026-11-05:soir': { members: 10, tiers: { SANS_VISITE: 10 } },
        '2026-11-06:soir': { members: 5, tiers: { CRENEAU: 5 } },
      });
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(list.map((s) => s.date)).toEqual(['2026-11-04', '2026-11-06', '2026-11-05']);
      // Le non préparable est classé après, même avec plus de places vides, puis coupé à 3.
      expect(list.map((s) => s.canPrepare)).toEqual([true, true, true]);
    });

    it('sans service préparable, le classement reste par places vides puis date', async () => {
      mockFloor(floors);
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      expect(list.map((s) => s.date)).toEqual(['2026-11-05', '2026-11-04', '2026-11-03']);
    });

    it('la réponse et le cache ne contiennent ni score, ni customerId, ni membres', async () => {
      mockFloor({ [`2026-11-03:soir`]: { capacity: 30, free: 12 } });
      mockPlans({ '2026-11-03:soir': { members: 10, tiers: { CRENEAU: 10 } } });
      const list = await listFillSuggestions({ restaurantId: 'r1', now: NOW });
      const cached = vi.mocked(redisCache.set).mock.calls[0][1] as string;
      for (const text of [JSON.stringify(list), cached]) {
        expect(text).not.toMatch(/score|customerId|members|"c0"|booked/);
      }
    });
  });
});
