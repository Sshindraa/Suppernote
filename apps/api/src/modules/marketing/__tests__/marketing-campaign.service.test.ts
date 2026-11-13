import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketingCampaignStatus, MarketingPermissionStatus, Prisma } from '@prisma/client';
import { db } from '../../../shared/db/client';
import { marketingOptOutHash } from '../marketing-opt-out.service';
import {
  cancelMarketingCampaign,
  createMarketingCampaign,
  assertDailyEmailBudget,
  readRemainingDailyEmailBudget,
  prepareMarketingCampaign,
  scheduleMarketingCampaign,
  startMarketingCampaign,
  previewMarketingAudience,
  previewMarketingCampaign,
  toMarketingHtml,
  updateMarketingCampaign,
} from '../marketing-campaign.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    customer: { findMany: vi.fn(), findFirst: vi.fn() },
    restaurant: { findUnique: vi.fn() },
    customerSegment: { findFirst: vi.fn() },
    customerConsent: { findMany: vi.fn() },
    marketingPermission: { findMany: vi.fn() },
    marketingSuppression: { findMany: vi.fn() },
    marketingFrequencyWindow: { findMany: vi.fn() },
    marketingOptOut: { findMany: vi.fn() },
    usageTariff: { findFirst: vi.fn() },
    marketingCampaign: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    campaignAudienceMember: { findMany: vi.fn(), createMany: vi.fn(), deleteMany: vi.fn() },
    campaignMessage: { count: vi.fn(), createMany: vi.fn() },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  },
}));

const DEFINITION = {
  version: 1 as const,
  operator: 'AND' as const,
  conditions: [{ field: 'isVip' as const, op: 'EQ' as const, value: true }],
};

type Filter = string | { in: string[] };
type Range = { gte?: Date; lt?: Date };
type CampaignWhere = {
  OR?: CampaignWhere[];
  status?: Filter;
  scheduledAt?: Range;
  automationDispatches?: { some: object };
};
type MessageWhere = {
  channel?: Filter;
  status?: Filter;
  acceptedAt?: Range;
  campaign?: CampaignWhere;
};
type MessageRow = {
  channel: string;
  status: string;
  acceptedAt: Date | null;
  campaign: { status: string; scheduledAt: Date | null; isAutomation?: boolean };
};

const BUDGET_NOW = new Date('2030-01-10T12:00:00.000Z');
const YESTERDAY = new Date('2030-01-09T12:00:00.000Z');

function matchesFilter(value: string, filter: Filter | undefined): boolean {
  if (filter === undefined) return true;
  return typeof filter === 'string' ? value === filter : filter.in.includes(value);
}

function matchesRange(value: Date | null, range: Range | undefined): boolean {
  if (range === undefined) return true;
  if (value === null) return false;
  return (
    (range.gte === undefined || value >= range.gte) && (range.lt === undefined || value < range.lt)
  );
}

function matchesCampaign(campaign: MessageRow['campaign'], where: CampaignWhere): boolean {
  if (where.OR) return where.OR.some((clause) => matchesCampaign(campaign, clause));
  return (
    matchesFilter(campaign.status, where.status) &&
    matchesRange(campaign.scheduledAt, where.scheduledAt) &&
    (where.automationDispatches === undefined || campaign.isAutomation === true)
  );
}

/** Évalue le `where` de `campaignMessage.count` sur des lignes en mémoire : pas de base dans les tests. */
function countMessages(rows: MessageRow[], where: MessageWhere): number {
  return rows.filter(
    (row) =>
      matchesFilter(row.channel, where.channel) &&
      matchesFilter(row.status, where.status) &&
      matchesRange(row.acceptedAt, where.acceptedAt) &&
      (where.campaign === undefined || matchesCampaign(row.campaign, where.campaign)),
  ).length;
}

function emailRows(count: number, row: Omit<MessageRow, 'channel'>): MessageRow[] {
  return Array.from({ length: count }, () => ({ channel: 'EMAIL', ...row }));
}

function mockMessages(rows: MessageRow[]): void {
  vi.mocked(db.campaignMessage.count).mockImplementation((async ({
    where,
  }: {
    where: MessageWhere;
  }) => countMessages(rows, where)) as never);
}

function mockCampaigns(
  campaigns: Array<{ id: string; status: string; audienceCount: number }>,
): void {
  vi.mocked(db.marketingCampaign.findFirst).mockImplementation((async ({
    where,
  }: {
    where: { id: string };
  }) => {
    const campaign = campaigns.find((item) => item.id === where.id);
    return campaign ? { channel: 'EMAIL', scheduledAt: null, ...campaign } : null;
  }) as never);
}

describe('marketing campaign control plane', () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.customerSegment.findFirst).mockResolvedValue({
      id: 'segment-1',
      definition: DEFINITION,
    } as never);
    vi.mocked(db.customer.findMany).mockResolvedValue([
      {
        id: 'c1',
        name: 'Alice',
        isVip: true,
        phone: '+33601020304',
        emailNormalized: 'a@example.test',
      },
      { id: 'c2', name: 'Bob', isVip: true, phone: '+33601020305', emailNormalized: null },
      {
        id: 'c3',
        name: 'Claire',
        isVip: true,
        phone: '+33601020306',
        emailNormalized: 'c@example.test',
      },
      {
        id: 'c4',
        name: 'Dan',
        isVip: true,
        phone: '+33601020307',
        emailNormalized: 'd@example.test',
      },
    ] as never);
    vi.mocked(db.marketingPermission.findMany).mockResolvedValue([
      { customerId: 'c1', status: MarketingPermissionStatus.OPTED_IN, source: 'WEB' },
      { customerId: 'c3', status: MarketingPermissionStatus.OPTED_OUT, source: 'UNSUBSCRIBE' },
    ] as never);
    vi.mocked(db.marketingSuppression.findMany).mockResolvedValue([
      { customerId: 'c4', channel: null, reason: 'BOUNCE' },
    ] as never);
    vi.mocked(db.marketingFrequencyWindow.findMany).mockResolvedValue([
      { customerId: 'c2', sendCount: 3 },
    ] as never);
    vi.mocked(db.customerConsent.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([]);
    vi.mocked(db.usageTariff.findFirst).mockResolvedValue(null);
  });

  it('returns an explainable, consented audience and exclusion reasons', async () => {
    const preview = await previewMarketingAudience({
      restaurantId: 'restaurant-1',
      channel: 'SMS',
      segmentId: 'segment-1',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });

    expect(preview).toMatchObject({
      candidateCount: 4,
      eligibleCount: 1,
      excludedByReason: { 'SUPPRESSED:BOUNCE': 1, FREQUENCY_CAP: 1, OPTED_OUT: 1 },
      sample: [{ id: 'c1', inclusionReason: 'CHANNEL_OPT_IN' }],
    });
    expect(JSON.stringify(preview)).not.toContain('+336');
    expect(db.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ restaurantId: 'restaurant-1' }) }),
    );
  });

  it('excludes an address found in the opt-out register even with a stored opt-in', async () => {
    vi.stubEnv('MARKETING_OPTOUT_HASH_SECRET', 'k'.repeat(40));
    vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([
      { addressHash: marketingOptOutHash('restaurant-1', 'SMS', '+33601020304') },
    ] as never);

    const preview = await previewMarketingAudience({
      restaurantId: 'restaurant-1',
      channel: 'SMS',
      segmentId: 'segment-1',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });

    expect(preview).toMatchObject({
      eligibleCount: 0,
      optOutRegisterChecked: true,
      excludedByReason: expect.objectContaining({ OPTED_OUT_REGISTER: 1 }),
    });
    expect(db.marketingOptOut.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ restaurantId: 'restaurant-1', channel: 'SMS' }),
      }),
    );
  });

  it('says so when the register could not be consulted because its key is missing', async () => {
    vi.stubEnv('MARKETING_OPTOUT_HASH_SECRET', '');
    const preview = await previewMarketingAudience({
      restaurantId: 'restaurant-1',
      channel: 'SMS',
      segmentId: 'segment-1',
      now: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(preview.optOutRegisterChecked).toBe(false);
    expect(db.marketingOptOut.findMany).not.toHaveBeenCalled();
  });

  it('creates a draft and stores an immutable audience snapshot in one transaction', async () => {
    vi.mocked(db.marketingCampaign.create).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.DRAFT,
      audienceCount: 1,
    } as never);
    const campaign = await createMarketingCampaign({
      restaurantId: 'restaurant-1',
      name: 'Relance VIP',
      objective: 'Remplir le déjeuner',
      channel: 'SMS',
      segmentId: 'segment-1',
      bodyTemplate:
        'Bonjour {{customer.firstName}}, réservez ici {{reservationLink}} — {{unsubscribeUrl}}',
      createdBy: 'user-1',
    });

    expect(campaign.id).toBe('campaign-1');
    expect(db.marketingCampaign.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        restaurantId: 'restaurant-1',
        status: MarketingCampaignStatus.DRAFT,
        audienceCount: 1,
        createdByHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    });
    expect(db.campaignAudienceMember.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ campaignId: 'campaign-1', customerId: 'c1' })],
    });
  });

  it('requires an unsubscribe variable and prevents preparation of an empty draft', async () => {
    await expect(
      createMarketingCampaign({
        restaurantId: 'restaurant-1',
        name: 'Sans lien',
        objective: 'Test',
        channel: 'SMS',
        segmentId: 'segment-1',
        bodyTemplate: 'Bonjour',
      }),
    ).rejects.toThrow('must include {{unsubscribeUrl}}');

    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-empty',
      status: MarketingCampaignStatus.DRAFT,
      audienceCount: 0,
    } as never);
    await expect(
      prepareMarketingCampaign({ restaurantId: 'restaurant-1', campaignId: 'campaign-empty' }),
    ).rejects.toThrow('AUDIENCE_EMPTY');
  });

  it('une campagne READY oubliée ne bloque pas le lancement d’une autre campagne', async () => {
    mockCampaigns([{ id: 'campaign-b', status: MarketingCampaignStatus.READY, audienceCount: 30 }]);
    mockMessages(
      emailRows(40, {
        status: 'PENDING',
        acceptedAt: null,
        campaign: { status: 'READY', scheduledAt: null },
      }),
    );
    vi.mocked(db.marketingCampaign.updateMany).mockResolvedValue({ count: 1 } as never);

    await expect(
      startMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-b',
        now: BUDGET_NOW,
      }),
    ).resolves.toBeDefined();
    expect(db.marketingCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: MarketingCampaignStatus.SENDING }),
      }),
    );
  });

  it('une automatisation prête réserve son audience : elle part à la même passe', async () => {
    mockCampaigns([{ id: 'campaign-b', status: MarketingCampaignStatus.READY, audienceCount: 30 }]);
    mockMessages(
      emailRows(30, {
        status: 'PENDING',
        acceptedAt: null,
        campaign: { status: 'READY', scheduledAt: null, isAutomation: true },
      }),
    );
    vi.mocked(db.marketingCampaign.updateMany).mockResolvedValue({ count: 1 } as never);

    await expect(
      startMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-b',
        now: BUDGET_NOW,
      }),
    ).rejects.toThrow('MARKETING_DAILY_BUDGET_EXCEEDED');
    expect(db.marketingCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('refuse un envoi immédiat qui dépasse le reste du jour, sans rien lancer', async () => {
    mockCampaigns([{ id: 'campaign-b', status: MarketingCampaignStatus.READY, audienceCount: 20 }]);
    // 25 e-mails acceptés aujourd’hui : il reste 15, la campagne en demande 20.
    mockMessages(
      emailRows(25, {
        status: 'ACCEPTED',
        acceptedAt: BUDGET_NOW,
        campaign: { status: 'SENT', scheduledAt: null },
      }),
    );
    vi.mocked(db.marketingCampaign.updateMany).mockResolvedValue({ count: 1 } as never);

    await expect(
      startMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-b',
        now: BUDGET_NOW,
      }),
    ).rejects.toThrow('MARKETING_DAILY_BUDGET_EXCEEDED');
    expect(db.marketingCampaign.updateMany).not.toHaveBeenCalled();
  });

  it('compte les envois en cours et les acceptés du jour, jamais ceux de la veille', async () => {
    mockMessages([
      ...emailRows(20, {
        status: 'PENDING',
        acceptedAt: null,
        campaign: { status: 'SENDING', scheduledAt: null },
      }),
      ...emailRows(40, {
        status: 'ACCEPTED',
        acceptedAt: YESTERDAY,
        campaign: { status: 'SENT', scheduledAt: null },
      }),
    ]);
    const tx = db as unknown as Prisma.TransactionClient;

    await expect(assertDailyEmailBudget(tx, 20, BUDGET_NOW)).resolves.toBeUndefined();
    await expect(assertDailyEmailBudget(tx, 21, BUDGET_NOW)).rejects.toThrow(
      'MARKETING_DAILY_BUDGET_EXCEEDED',
    );
  });

  it('lecture du budget : même calcul que le lancement, mais sans verrou global', async () => {
    mockMessages(
      emailRows(20, {
        status: 'PENDING',
        acceptedAt: null,
        campaign: { status: 'SENDING', scheduledAt: null },
      }),
    );
    vi.mocked(db.$executeRaw).mockClear();
    const locked = await assertDailyEmailBudget(
      db as unknown as Prisma.TransactionClient,
      20,
      BUDGET_NOW,
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    vi.mocked(db.$executeRaw).mockClear();

    const remaining = await readRemainingDailyEmailBudget(BUDGET_NOW);

    expect(locked).toBeUndefined();
    expect(remaining).toBe(20);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('programme selon le jour d’envoi : une campagne d’un autre jour ne prend pas le budget', async () => {
    mockMessages(
      emailRows(30, {
        status: 'PENDING',
        acceptedAt: null,
        campaign: { status: 'SCHEDULED', scheduledAt: new Date('2030-01-10T18:00:00.000Z') },
      }),
    );
    mockCampaigns([
      { id: 'campaign-next-day', status: MarketingCampaignStatus.READY, audienceCount: 30 },
      { id: 'campaign-same-day', status: MarketingCampaignStatus.READY, audienceCount: 30 },
    ]);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      status: MarketingCampaignStatus.SCHEDULED,
    } as never);

    await expect(
      scheduleMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-next-day',
        scheduledAt: new Date('2030-01-11T09:00:00.000Z'),
      }),
    ).resolves.toMatchObject({ status: MarketingCampaignStatus.SCHEDULED });
    await expect(
      scheduleMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-same-day',
        scheduledAt: new Date('2030-01-10T20:00:00.000Z'),
      }),
    ).rejects.toThrow('MARKETING_DAILY_BUDGET_EXCEEDED');
    expect(db.marketingCampaign.update).toHaveBeenCalledTimes(1);
  });

  it('la préparation ne consulte plus le budget : une campagne prête ne réserve rien', async () => {
    mockMessages(
      emailRows(40, {
        status: 'ACCEPTED',
        acceptedAt: BUDGET_NOW,
        campaign: { status: 'SENT', scheduledAt: null },
      }),
    );
    mockCampaigns([
      { id: 'campaign-email', status: MarketingCampaignStatus.DRAFT, audienceCount: 30 },
    ]);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-email',
      status: MarketingCampaignStatus.READY,
    } as never);

    await expect(
      prepareMarketingCampaign({ restaurantId: 'restaurant-1', campaignId: 'campaign-email' }),
    ).resolves.toMatchObject({ status: MarketingCampaignStatus.READY });
  });

  it('renders a campaign from its immutable snapshot and reports billable units', async () => {
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      name: 'Relance déjeuner',
      objective: 'Remplir le service',
      channel: 'SMS',
      status: MarketingCampaignStatus.DRAFT,
      subject: null,
      bodyTemplate:
        'Bonjour {{customer.firstName}}, réservez chez {{restaurant.name}} {{reservationLink}} {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceCount: 3,
      restaurant: { name: 'Chez Suppernote' },
    } as never);
    vi.mocked(db.campaignAudienceMember.findMany).mockResolvedValue([
      { customerId: 'customer-1' },
    ] as never);
    vi.mocked(db.customer.findFirst).mockResolvedValue({ name: 'Alice Martin' } as never);

    const preview = await previewMarketingCampaign({
      restaurantId: 'restaurant-1',
      campaignId: 'campaign-1',
    });

    expect(preview).toMatchObject({
      campaign: { id: 'campaign-1', status: MarketingCampaignStatus.DRAFT },
      audience: { captured: 3, eligible: 3, sampleCustomer: 'Alice Martin' },
      render: { body: expect.stringContaining('Bonjour Alice'), usedFallbackCustomer: false },
      usage: {
        category: 'SMS_SEGMENTS',
        unitsPerMessage: 1,
        totalUnits: 3,
        encoding: 'gsm7',
      },
      costEstimate: { amount: null, status: 'NOT_AVAILABLE' },
    });
    expect(JSON.stringify(preview)).not.toContain('customer-1');
  });

  it('calcule le coût du preview avec le tarif fournisseur versionné', async () => {
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      name: 'Relance déjeuner',
      objective: 'Remplir le service',
      channel: 'SMS',
      status: MarketingCampaignStatus.DRAFT,
      subject: null,
      bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      scheduledAt: new Date('2026-09-20T12:00:00.000Z'),
      timezone: 'Europe/Paris',
      audienceCount: 3,
      restaurant: { name: 'Chez Suppernote' },
    } as never);
    vi.mocked(db.campaignAudienceMember.findMany).mockResolvedValue([
      { customerId: 'customer-1' },
    ] as never);
    vi.mocked(db.customer.findFirst).mockResolvedValue({ name: 'Alice Martin' } as never);
    vi.mocked(db.usageTariff.findFirst).mockResolvedValue({
      id: 'tariff-telnyx-sms',
      category: 'SMS_SEGMENTS',
      provider: 'telnyx',
      unit: 'segments',
      pricePerUnit: new Prisma.Decimal('0.0075'),
      currency: 'EUR',
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      effectiveTo: null,
      version: 1,
      source: 'invoice:telnyx:2026-09',
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
    } as never);

    const preview = await previewMarketingCampaign({
      restaurantId: 'restaurant-1',
      campaignId: 'campaign-1',
    });

    expect(preview.costEstimate).toEqual({
      amount: '0.022500',
      currency: 'EUR',
      status: 'PRICED',
      reason: 'PROVIDER_TARIFF_RECONCILED',
      tariffId: 'tariff-telnyx-sms',
      pricePerUnit: '0.007500000',
    });
    expect(db.usageTariff.findFirst).toHaveBeenCalledWith({
      where: {
        category: 'SMS_SEGMENTS',
        provider: 'telnyx',
        unit: 'segments',
        currency: 'EUR',
        effectiveFrom: { lte: new Date('2026-09-20T12:00:00.000Z') },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date('2026-09-20T12:00:00.000Z') } }],
      },
      orderBy: [{ effectiveFrom: 'desc' }, { version: 'desc' }],
    });
  });

  it('updates draft copy while keeping the audience snapshot stable', async () => {
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'restaurant-1',
      name: 'Ancien nom',
      objective: 'Ancien objectif',
      channel: 'SMS',
      status: MarketingCampaignStatus.DRAFT,
      subject: null,
      bodyTemplate: 'Ancien {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceVersion: 1,
      audienceCount: 4,
      segmentId: 'segment-1',
    } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      name: 'Nouveau nom',
      bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      status: MarketingCampaignStatus.DRAFT,
    } as never);

    const updated = await updateMarketingCampaign({
      restaurantId: 'restaurant-1',
      campaignId: 'campaign-1',
      changes: {
        name: 'Nouveau nom',
        bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      },
    });

    expect(updated).toMatchObject({ id: 'campaign-1', name: 'Nouveau nom' });
    expect(db.campaignAudienceMember.deleteMany).not.toHaveBeenCalled();
    expect(db.marketingCampaign.update).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: expect.objectContaining({
        name: 'Nouveau nom',
        bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      }),
    });
  });

  it('refuses de changer le canal d’une campagne READY dont le snapshot est figé', async () => {
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-ready',
      restaurantId: 'restaurant-1',
      name: 'Prête',
      objective: 'Test',
      channel: 'SMS',
      status: MarketingCampaignStatus.READY,
      subject: null,
      bodyTemplate: 'Bonjour {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceVersion: 1,
      audienceCount: 1,
      segmentId: 'segment-1',
    } as never);

    await expect(
      updateMarketingCampaign({
        restaurantId: 'restaurant-1',
        campaignId: 'campaign-ready',
        changes: { channel: 'EMAIL', subject: 'Objet' },
      }),
    ).rejects.toThrow('CAMPAIGN_AUDIENCE_FROZEN');
    expect(db.marketingCampaign.update).not.toHaveBeenCalled();
  });

  it('keeps tenant scope and only cancels cancellable campaigns', async () => {
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.READY,
      audienceCount: 1,
    } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.CANCELLED,
    } as never);
    await expect(
      cancelMarketingCampaign({ restaurantId: 'restaurant-1', campaignId: 'campaign-1' }),
    ).resolves.toMatchObject({ status: MarketingCampaignStatus.CANCELLED });
    expect(db.marketingCampaign.findFirst).toHaveBeenCalledWith({
      where: { id: 'campaign-1', restaurantId: 'restaurant-1' },
    });
  });
  it('rend les adresses cliquables dans l’e-mail sans laisser passer de balise', () => {
    expect(
      toMarketingHtml(
        'Réservez : https://suppernote.com/book/chez-sokar?a=1&b=2.\n<script>x</script> (https://exemple.test/u?token=abc)',
      ),
    ).toBe(
      'Réservez : <a href="https://suppernote.com/book/chez-sokar?a=1&amp;b=2">https://suppernote.com/book/chez-sokar?a=1&amp;b=2</a>.<br>&lt;script&gt;x&lt;/script&gt; (<a href="https://exemple.test/u?token=abc">https://exemple.test/u?token=abc</a>)',
    );

    expect(
      toMarketingHtml('Réservez : https://suppernote.com/book?a=1&b=2. Autre : https://ex.test', {
        'https://suppernote.com/book?a=1&b=2': 'Réserver une table',
      }),
    ).toBe(
      'Réservez : <a href="https://suppernote.com/book?a=1&amp;b=2">Réserver une table</a>. ' +
        'Autre : <a href="https://ex.test">https://ex.test</a>',
    );
  });
});
