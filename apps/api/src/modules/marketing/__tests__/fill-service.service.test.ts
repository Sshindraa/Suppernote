import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { CapacityAwareAvailabilityService } from '../../floor-plan/availability-capacity-aware.service';
import {
  buildAudience,
  createMarketingCampaign,
  ensureCampaignMessages,
  HOLDOUT_INCLUSION_REASON,
  readRemainingDailyEmailBudget,
  type CampaignAudienceMemberDraft,
} from '../marketing-campaign.service';
import {
  createServiceFillDraft,
  isTargetServiceFull,
  planServiceFill,
  previewServiceFill,
  serviceAvailability,
  serviceWindow,
} from '../fill-service.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    reservation: { findMany: vi.fn(), aggregate: vi.fn() },
    $transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})),
    restaurant: { findUnique: vi.fn().mockResolvedValue({ name: 'Chez Suppernote' }) },
  },
}));
vi.mock('../../floor-plan/availability-capacity-aware.service', () => ({
  CapacityAwareAvailabilityService: vi.fn(),
}));
vi.mock('../marketing-campaign.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../marketing-campaign.service')>()),
  buildAudience: vi.fn(),
  createMarketingCampaign: vi.fn(),
  readRemainingDailyEmailBudget: vi.fn(),
  estimateCampaignCost: vi
    .fn()
    .mockResolvedValue({ amount: null, currency: 'EUR', status: 'NOT_AVAILABLE' }),
}));

const NOW = new Date('2026-11-02T10:00:00.000Z');
// Mercredi 4 novembre 2026, heure de Paris (UTC+1).
const DATE = '2026-11-04';
const WEDNESDAY_LUNCH = new Date('2026-10-07T11:30:00.000Z'); // mercredi 13 h 30, Paris
const SERVICE_DAY_NOON = new Date('2026-11-04T11:30:00.000Z');
const SATURDAY_DINNER = new Date('2026-10-10T17:00:00.000Z'); // samedi 19 h, Paris

function member(customerId: string): CampaignAudienceMemberDraft {
  return { customerId, inclusionReason: 'CHANNEL_OPT_IN', snapshot: { permissionSource: 'X' } };
}

function members(count: number): CampaignAudienceMemberDraft[] {
  return Array.from({ length: count }, (_, index) => member(`customer-${index}`));
}

/** Deux visites le mercredi midi, récentes : palier CRENEAU pour ce service. */
function slotRegulars(count: number): Array<{ customerId: string; reservedAt: Date }> {
  return Array.from({ length: count }, (_, index) => index).flatMap((index) => [
    { customerId: `customer-${index}`, reservedAt: WEDNESDAY_LUNCH },
    { customerId: `customer-${index}`, reservedAt: WEDNESDAY_LUNCH },
  ]);
}

/** Quatre mercredis midi passés, chacun avec 10 couverts réservés peu avant le service. */
const LATE_HISTORY = ['2026-10-28', '2026-10-21', '2026-10-14', '2026-10-07'].map((day) => {
  const reservedAt = new Date(`${day}T11:30:00.000Z`);
  return { reservedAt, createdAt: new Date(reservedAt.getTime() - 3600_000), partySize: 10 };
});

function mockAudience(list: CampaignAudienceMemberDraft[]) {
  vi.mocked(buildAudience).mockResolvedValue({
    channel: 'SMS',
    audienceVersion: 1,
    candidateCount: list.length,
    eligibleCount: list.length,
    excludedByReason: {},
    sample: [],
    members: list,
  });
}

function mockFloor({
  tables,
  booked = 0,
  honored = [],
  busy = [],
  history = [],
  bookable = true,
  open = true,
}: {
  tables: Array<{ capacity: number; minCapacity: number }>;
  booked?: number;
  honored?: Array<{ customerId: string; reservedAt: Date }>;
  busy?: Array<{ customerId: string; reservedAt?: Date }>;
  /** Réservations passées servant à la prévision (arrivées tardives). */
  history?: Array<{ reservedAt: Date; createdAt: Date; partySize: number }>;
  /** Le moteur de disponibilité propose-t-il un créneau pour 2 couverts à 12 h 30 ? */
  bookable?: boolean;
  /** Le restaurant ouvre-t-il ce service ? Sinon, aucun créneau n'existe. */
  open?: boolean;
}) {
  // Une fonction (et non une flèche) : le service est instancié avec `new`.
  vi.mocked(CapacityAwareAvailabilityService).mockImplementation(function () {
    return {
      tableRanges: vi.fn().mockResolvedValue(tables),
      getAvailability: vi.fn().mockResolvedValue({
        slots: open ? [{ time: '12:30', available: bookable }] : [],
      }),
    };
  } as never);
  vi.mocked(db.reservation.aggregate).mockImplementation(((args: { _sum?: unknown }) =>
    Promise.resolve(
      args._sum ? { _sum: { partySize: booked } } : { _avg: { partySize: 2 } },
    )) as never);
  // Visites passées (états avec HONORED), historique de prévision (createdAt) et réservations actives.
  vi.mocked(db.reservation.findMany).mockImplementation(((args: {
    where: { state?: { in?: string[] } };
    select?: { createdAt?: boolean };
  }) => {
    if (args.select?.createdAt) return Promise.resolve(history);
    if (args.where.state?.in?.includes('HONORED')) return Promise.resolve(honored);
    return Promise.resolve(busy.map((row) => ({ reservedAt: SERVICE_DAY_NOON, ...row })));
  }) as never);
}

describe('remplissage de service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('firstSlotAt : le premier créneau du service, même si l’API les renvoie non triés', async () => {
    vi.mocked(CapacityAwareAvailabilityService).mockImplementation(function () {
      return {
        getAvailability: vi.fn().mockResolvedValue({
          slots: [
            { time: '13:00', available: true },
            { time: '12:00', available: false },
          ],
        }),
      };
    } as never);
    const result = await serviceAvailability({
      restaurantId: 'r1',
      ...serviceWindow(DATE, 'midi'),
    });
    expect(result.firstSlotAt?.toISOString()).toBe('2026-11-04T11:00:00.000Z');
  });

  it('coupe le service à 16 h, heure de Paris', () => {
    expect(serviceWindow(DATE, 'midi').end.toISOString()).toBe('2026-11-04T15:00:00.000Z');
    expect(serviceWindow(DATE, 'soir').start.toISOString()).toBe('2026-11-04T15:00:00.000Z');
  });

  it('dit que la capacité est inconnue quand il n’y a pas de plan de salle, sans rien cibler', async () => {
    mockFloor({ tables: [] });
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(plan).toEqual({ status: 'CAPACITY_UNKNOWN' });
    expect(buildAudience).not.toHaveBeenCalled();
  });

  it('places libres = capacité des tables actives − couverts réservés', async () => {
    mockFloor({
      tables: [
        { capacity: 20, minCapacity: 2 },
        { capacity: 10, minCapacity: 1 },
      ],
      booked: 12,
    });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(plan).toMatchObject({ status: 'PLANNED', capacity: 30, booked: 12, freePlaces: 18 });
  });

  it('service non ouvert ce jour-là : ni plein ni ciblé', async () => {
    mockFloor({ tables: [{ capacity: 30, minCapacity: 1 }], open: false });
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(plan).toEqual({ status: 'SERVICE_CLOSED' });
    expect(buildAudience).not.toHaveBeenCalled();
  });

  it('service plein (aucun créneau pour 2 couverts, moteur de disponibilité) : aucune audience', async () => {
    mockFloor({ tables: [{ capacity: 30, minCapacity: 1 }], booked: 30, bookable: false });
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(plan).toEqual({ status: 'SERVICE_FULL', capacity: 30, booked: 30 });
    expect(buildAudience).not.toHaveBeenCalled();
  });

  it('classe par palier : le créneau d’abord, puis les réguliers', async () => {
    mockFloor({
      tables: [{ capacity: 100, minCapacity: 1 }],
      honored: [
        { customerId: 'b', reservedAt: SATURDAY_DINNER },
        { customerId: 'b', reservedAt: SATURDAY_DINNER },
        { customerId: 'b', reservedAt: SATURDAY_DINNER },
        { customerId: 'a', reservedAt: WEDNESDAY_LUNCH },
        { customerId: 'a', reservedAt: WEDNESDAY_LUNCH },
      ],
    });
    mockAudience([member('b'), member('a')]);
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 1,
    });
    expect(plan.status === 'PLANNED' && plan.members.map((m) => m.customerId)).toEqual(['a', 'b']);
    expect(plan.status === 'PLANNED' && plan.members[0].snapshot.affinity).toBe(2);
  });

  it('audience : s’arrête aux places vides probables, pas aux places libres', async () => {
    mockFloor({
      tables: [{ capacity: 36, minCapacity: 1 }],
      honored: slotRegulars(100),
      history: LATE_HISTORY,
    });
    mockAudience(members(100));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 7,
    });
    // 36 libres − 10 arrivées tardives = 26 vides ; 0,3 × 2 × 0,7 = 0,42 attendu par client → 62.
    expect(plan).toMatchObject({
      freePlaces: 36,
      emptyPlaces: 26,
      lateArrivals: 10,
      forecastSource: 'historique',
      targetSize: 62,
      candidateCount: 100,
      tiers: { CRENEAU: 62 },
      budgetExhausted: false,
    });
    expect(plan.status === 'PLANNED' && plan.members).toHaveLength(62);
  });

  it('vivier insuffisant : prend tous les éligibles', async () => {
    mockFloor({ tables: [{ capacity: 100, minCapacity: 1 }], honored: slotRegulars(5) });
    mockAudience(members(5));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 7,
    });
    expect(plan).toMatchObject({ targetSize: 5, forecastSource: 'simple', lateArrivals: 0 });
  });

  it('e-mail : plafonne les envois au budget restant ; SMS : pas de plafond budget', async () => {
    mockFloor({ tables: [{ capacity: 1000, minCapacity: 1 }], honored: slotRegulars(30) });
    mockAudience(members(30));
    vi.mocked(readRemainingDailyEmailBudget).mockResolvedValue(5);
    const args = { restaurantId: 'r1', date: DATE, service: 'midi' as const, now: NOW, seed: 7 };
    const email = await planServiceFill({ ...args, channel: 'EMAIL' });
    // 7 clients dont 2 témoins = 5 envois.
    expect(email).toMatchObject({ targetSize: 7, holdoutCount: 2, budgetExhausted: false });
    expect(readRemainingDailyEmailBudget).toHaveBeenCalledWith(NOW);
    // Chemin de lecture : aucune transaction, donc aucun verrou global.
    expect(db.$transaction).not.toHaveBeenCalled();
    vi.mocked(readRemainingDailyEmailBudget).mockClear();
    const sms = await planServiceFill({ ...args, channel: 'SMS' });
    expect(sms).toMatchObject({ targetSize: 30, budgetExhausted: false });
    expect(readRemainingDailyEmailBudget).not.toHaveBeenCalled();
  });

  it('budget nul : aucun membre, budgetExhausted vrai ; le brouillon est refusé', async () => {
    mockFloor({ tables: [{ capacity: 1000, minCapacity: 1 }], honored: slotRegulars(30) });
    mockAudience(members(30));
    vi.mocked(readRemainingDailyEmailBudget).mockResolvedValue(0);
    const result = await createServiceFillDraft({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'EMAIL',
      name: 'Midi calme',
      objective: 'Remplir le service',
      bodyTemplate: 'Bonjour {{unsubscribeUrl}}',
      now: NOW,
      seed: 7,
    });
    expect(result.plan).toMatchObject({ targetSize: 0, budgetExhausted: true, members: [] });
    expect(result.campaign).toBeNull();
    expect(createMarketingCampaign).not.toHaveBeenCalled();
  });

  it('exclut une réservation active à 6 jours du service, compte excludedNearby ; garde à 8 jours', async () => {
    mockFloor({
      tables: [{ capacity: 36, minCapacity: 1 }],
      busy: [
        { customerId: 'customer-0', reservedAt: new Date('2026-11-10T11:30:00.000Z') },
        { customerId: 'customer-1', reservedAt: new Date('2026-11-12T11:30:00.000Z') },
      ],
    });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 3,
    });
    expect(plan).toMatchObject({ candidateCount: 2, excludedSameDay: 0, excludedNearby: 1 });
  });

  it('un même client le jour même compte seulement dans excludedSameDay', async () => {
    mockFloor({
      tables: [{ capacity: 36, minCapacity: 1 }],
      busy: [
        { customerId: 'customer-0' },
        { customerId: 'customer-0', reservedAt: new Date('2026-11-07T11:30:00.000Z') },
      ],
    });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 3,
    });
    expect(plan).toMatchObject({ candidateCount: 2, excludedSameDay: 1, excludedNearby: 0 });
  });

  it('ne contacte pas SANS_VISITE', async () => {
    mockFloor({ tables: [{ capacity: 100, minCapacity: 1 }] });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 3,
    });
    expect(plan).toMatchObject({
      candidateCount: 3,
      targetSize: 0,
      members: [],
      tiers: {},
      excludedLowProbability: 3,
    });
  });

  it('aperçu : les clients SANS_VISITE écartés sont comptés dans excludedLowProbability', async () => {
    mockFloor({ tables: [{ capacity: 100, minCapacity: 1 }] });
    mockAudience(members(3));
    const preview = await previewServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(preview).toMatchObject({ candidateCount: 3, audience: 0, excludedLowProbability: 3 });
  });

  it('compte comme visite une réservation passée confirmée, jamais un no-show', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }] });
    mockAudience(members(1));
    await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    const visitQuery = vi
      .mocked(db.reservation.findMany)
      .mock.calls.map(([args]) => args?.where)
      .find((where) => (where?.state as { in?: string[] })?.in?.includes('HONORED'));
    expect((visitQuery?.state as { in: string[] }).in).toEqual(['CONFIRMED', 'SEATED', 'HONORED']);
    expect(visitQuery?.reservedAt).toMatchObject({ lt: NOW });
  });

  it("témoin : 30 % de l'audience, sans message, et reproductible avec la même graine", async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], honored: slotRegulars(30) });
    mockAudience(members(30));
    const args = {
      restaurantId: 'r1',
      date: DATE,
      service: 'midi' as const,
      channel: 'SMS' as const,
      now: NOW,
    };
    const first = await planServiceFill({ ...args, seed: 42 });
    const second = await planServiceFill({ ...args, seed: 42 });
    if (first.status !== 'PLANNED' || second.status !== 'PLANNED')
      throw new Error('expected a plan');
    const holdout = (plan: typeof first) =>
      plan.members
        .filter((m) => m.inclusionReason === HOLDOUT_INCLUSION_REASON)
        .map((m) => m.customerId);
    expect(first.holdoutCount).toBe(9);
    expect(holdout(first)).toHaveLength(9);
    expect(holdout(first)).toEqual(holdout(second));
    expect(first.members[0].snapshot.holdoutSeed).toBe(42);
  });

  it("la part contactée de l'arrêt à l'objectif vaut 70 %", async () => {
    // 10 places vides, 0,3 × 2 × 0,7 = 0,42 attendu par client : 23 × 0,42 < 10 ≤ 24 × 0,42.
    mockFloor({ tables: [{ capacity: 10, minCapacity: 1 }], honored: slotRegulars(30) });
    mockAudience(members(30));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 7,
    });
    expect(plan).toMatchObject({ emptyPlaces: 10, targetSize: 24, holdoutCount: 7 });
  });

  it('snapshot : tier et modelVersion v1 ; aucune phrase ni probabilité stockée', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], honored: slotRegulars(3) });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 3,
    });
    if (plan.status !== 'PLANNED') throw new Error('expected a plan');
    expect(plan.members).toHaveLength(3);
    for (const m of plan.members) {
      expect(m.snapshot).toMatchObject({ tier: 'CRENEAU', modelVersion: 'v1' });
      expect(Object.keys(m.snapshot).sort()).toEqual([
        'affinity',
        'holdoutSeed',
        'modelVersion',
        'permissionSource',
        'tier',
      ]);
    }
  });

  it('exclut le client qui a déjà une réservation ce jour-là', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], busy: [{ customerId: 'customer-0' }] });
    mockAudience(members(3));
    const plan = await planServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
      seed: 3,
    });
    expect(plan).toMatchObject({ candidateCount: 2, excludedSameDay: 1 });
    expect(plan.status === 'PLANNED' && plan.members.map((m) => m.customerId)).not.toContain(
      'customer-0',
    );
  });

  it('brouillon : passe par la création de campagne avec les membres et le service visé', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], honored: slotRegulars(3) });
    mockAudience(members(3));
    vi.mocked(createMarketingCampaign).mockResolvedValue({ id: 'campaign-1' } as never);
    const result = await createServiceFillDraft({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      name: 'Midi calme',
      objective: 'Remplir le service',
      bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      now: NOW,
      seed: 5,
    });
    expect(result.campaign).toEqual({ id: 'campaign-1' });
    expect(createMarketingCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        members: expect.any(Array),
        targetServiceStart: serviceWindow(DATE, 'midi').start,
        targetServiceEnd: serviceWindow(DATE, 'midi').end,
      }),
    );
  });

  it('service visé complet : pause ; capacité inconnue : rien ne bloque', async () => {
    const window = serviceWindow(DATE, 'midi');
    mockFloor({ tables: [{ capacity: 10, minCapacity: 1 }], bookable: false });
    await expect(isTargetServiceFull({ restaurantId: 'r1', ...window })).resolves.toBe(true);
    mockFloor({ tables: [{ capacity: 10, minCapacity: 1 }], bookable: true });
    await expect(isTargetServiceFull({ restaurantId: 'r1', ...window })).resolves.toBe(false);
    mockFloor({ tables: [], bookable: false });
    await expect(isTargetServiceFull({ restaurantId: 'r1', ...window })).resolves.toBe(false);
  });

  it('le témoin ne reçoit aucune ligne de message', async () => {
    const writer = {
      campaignAudienceMember: {
        findMany: vi.fn(({ where }: { where: { inclusionReason: { not: string } } }) =>
          Promise.resolve(
            [
              { id: 'm1', customerId: 'c1', inclusionReason: 'CHANNEL_OPT_IN' },
              { id: 'm2', customerId: 'c2', inclusionReason: HOLDOUT_INCLUSION_REASON },
            ].filter((row) => row.inclusionReason !== where.inclusionReason.not),
          ),
        ),
      },
      campaignMessage: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
    };
    await ensureCampaignMessages('campaign-1', 'SMS', writer as never);
    expect(writer.campaignMessage.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ audienceMemberId: 'm1', customerId: 'c1' })],
      }),
    );
  });

  it('aperçu : tiers en comptes, aucun identifiant de client ni nom', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], honored: slotRegulars(10) });
    mockAudience(members(10));
    const preview = await previewServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(preview).toMatchObject({
      status: 'PLANNED',
      full: false,
      freePlaces: 36,
      emptyPlaces: 36,
      forecastSource: 'simple',
      excludedNearby: 0,
      excludedLowProbability: 0,
      tiers: { CRENEAU: 10 },
      budgetExhausted: false,
      targetSize: 10,
      holdout: 3,
      sends: 7,
    });
    expect(preview.template.bodyTemplate).toContain('{{reservationLink}}');
    expect(preview.template.bodyTemplate).toContain('{{unsubscribeUrl}}');
    const keys = JSON.stringify(preview);
    expect(keys).not.toMatch(/"(name|phone|firstName|customerId)"/);
    expect(keys).not.toContain('customer-');
  });

  it('aperçu d’un service plein : indiqué comme plein, sans audience', async () => {
    mockFloor({ tables: [{ capacity: 36, minCapacity: 1 }], bookable: false });
    const preview = await previewServiceFill({
      restaurantId: 'r1',
      date: DATE,
      service: 'midi',
      channel: 'SMS',
      now: NOW,
    });
    expect(preview).toMatchObject({ status: 'SERVICE_FULL', full: true });
    expect(buildAudience).not.toHaveBeenCalled();
  });
});
