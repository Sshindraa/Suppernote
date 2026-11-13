import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../../../shared/db/client';
import { redisCache } from '../../../shared/redis/client';
import {
  buildDuplicateCandidates,
  mergeCustomerProfiles,
  previewCustomerMerge,
} from '../customer-merge.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    customer: { findMany: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    customerIdentity: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    customerTimelineEvent: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
    customerMetricSnapshot: { deleteMany: vi.fn(), upsert: vi.fn() },
    customerPreference: { delete: vi.fn(), update: vi.fn() },
    customerTagAssignment: { delete: vi.fn(), update: vi.fn() },
    customerConsent: { findMany: vi.fn(), updateMany: vi.fn() },
    reservation: { findMany: vi.fn(), updateMany: vi.fn() },
    giftCard: { findMany: vi.fn(), updateMany: vi.fn() },
    experienceReservation: { updateMany: vi.fn() },
    reputationFeedbackRequest: { updateMany: vi.fn() },
    reputationFeedback: { updateMany: vi.fn() },
    reputationRecoveryTask: { updateMany: vi.fn() },
    loyaltyGrant: { updateMany: vi.fn() },
    marketingPermission: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    marketingPermissionEvent: { findMany: vi.fn(), updateMany: vi.fn() },
    marketingSuppression: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    marketingAutomationDispatch: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    campaignAudienceMember: { findMany: vi.fn(), update: vi.fn() },
    campaignMessage: { findMany: vi.fn(), updateMany: vi.fn() },
    marketingConversion: { findMany: vi.fn(), updateMany: vi.fn() },
    marketingFrequencyWindow: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    marketingAttributionLink: { findMany: vi.fn(), update: vi.fn(), delete: vi.fn() },
    customerMergeAudit: { findUnique: vi.fn(), create: vi.fn() },
    outboxEvent: { create: vi.fn() },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (callback: (tx: typeof db) => unknown) => callback(db)),
  },
}));

vi.mock('../../../shared/redis/client', () => ({
  redisCache: { del: vi.fn().mockResolvedValue(1) },
}));

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    restaurantId: 'restaurant-1',
    phone: '+33612345678',
    emailNormalized: null,
    birthMonth: null,
    birthDay: null,
    preferredLocale: null,
    mergedIntoId: null,
    archivedAt: null,
    name: 'Alice Martin',
    isVip: false,
    notes: null,
    specialOccasion: null,
    lastSeenAt: null,
    lastCallAt: null,
    partySizeTypical: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    identities: [],
    preferences: [],
    metricSnapshot: null,
    tagAssignments: [],
    ...overrides,
  };
}

describe('customer merge service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.$queryRaw).mockResolvedValue([] as never);
    vi.mocked(db.$transaction).mockImplementation(async (callback: (tx: typeof db) => unknown) =>
      callback(db),
    );
    for (const model of [
      db.reservation,
      db.giftCard,
      db.customerConsent,
      db.customerTimelineEvent,
      db.marketingPermission,
      db.marketingPermissionEvent,
      db.marketingSuppression,
      db.marketingAutomationDispatch,
      db.campaignAudienceMember,
      db.campaignMessage,
      db.marketingConversion,
      db.marketingFrequencyWindow,
      db.marketingAttributionLink,
    ]) {
      vi.mocked(model.findMany).mockResolvedValue([] as never);
    }
    for (const model of [
      db.reservation,
      db.giftCard,
      db.experienceReservation,
      db.reputationFeedbackRequest,
      db.reputationFeedback,
      db.reputationRecoveryTask,
      db.loyaltyGrant,
      db.customerConsent,
      db.customerTimelineEvent,
      db.marketingPermissionEvent,
      db.marketingConversion,
    ]) {
      vi.mocked(model.updateMany).mockResolvedValue({ count: 0 } as never);
    }
    vi.mocked(db.customerIdentity.findMany).mockResolvedValue([] as never);
    vi.mocked(db.customerMergeAudit.findUnique).mockResolvedValue(null as never);
    vi.mocked(db.customerMergeAudit.create).mockResolvedValue({
      id: 'merge-audit-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
      summary: { sourceCount: 1 },
    } as never);
    vi.mocked(db.customer.update).mockResolvedValue({} as never);
    vi.mocked(db.customer.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.customerTimelineEvent.create).mockResolvedValue({ id: 'timeline-merge' } as never);
    vi.mocked(db.outboxEvent.create).mockResolvedValue({ id: 'outbox-merge' } as never);
    vi.mocked(db.customer.findMany).mockResolvedValue([] as never);
  });

  it('ne propose pas un doublon sur le nom seul et explique le score', () => {
    const candidates = buildDuplicateCandidates([
      {
        id: 'a',
        name: 'Élodie Martin',
        phone: '+33600000001',
        emailNormalized: null,
        isVip: false,
        archivedAt: null,
      },
      {
        id: 'b',
        name: 'Elodie Martin',
        phone: '+33600000002',
        emailNormalized: null,
        isVip: false,
        archivedAt: null,
      },
      {
        id: 'c',
        name: 'Autre nom',
        phone: '00 33 6 00 00 00 01',
        emailNormalized: 'client@example.com',
        isVip: true,
        archivedAt: null,
      },
    ]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ id: 'a:c', score: 80 });
    expect(candidates[0]?.reasons).toEqual([
      { code: 'PHONE_MATCH', points: 80, label: 'Téléphone normalisé identique' },
    ]);
  });

  it('ignore les valeurs partagées par un groupe trop large', () => {
    const candidates = buildDuplicateCandidates(
      Array.from({ length: 101 }, (_, index) => ({
        id: `customer-${index}`,
        name: `Client ${index}`,
        phone: '+33600000000',
        emailNormalized: null,
        isVip: false,
        archivedAt: null,
      })),
    );
    expect(candidates).toEqual([]);
  });

  it('retourne un aperçu avec conflits de préférences et permissions', async () => {
    vi.mocked(db.customer.findMany).mockResolvedValue([
      customer({
        id: 'target',
        name: 'Cible',
        phone: '+33611111111',
        preferences: [
          {
            id: 'pref-target',
            customerId: 'target',
            key: 'preferred_language',
            value: 'fr',
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
          },
        ],
      }),
      customer({
        id: 'source',
        name: 'Source',
        phone: '+33622222222',
        preferences: [
          {
            id: 'pref-source',
            customerId: 'source',
            key: 'preferred_language',
            value: 'en',
            updatedAt: new Date('2026-02-01T00:00:00.000Z'),
          },
        ],
      }),
    ] as never);
    vi.mocked(db.customerConsent.findMany).mockResolvedValue([
      { id: 'consent-1', customerId: 'source' },
    ] as never);
    vi.mocked(db.marketingPermission.findMany).mockResolvedValue([
      {
        id: 'permission-target',
        customerId: 'target',
        channel: 'SMS',
        status: 'OPTED_IN',
      },
      {
        id: 'permission-source',
        customerId: 'source',
        channel: 'SMS',
        status: 'OPTED_OUT',
      },
    ] as never);

    const preview = await previewCustomerMerge({
      restaurantId: 'restaurant-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
    });
    expect(preview.conflicts.preferences).toEqual([
      expect.objectContaining({ key: 'preferred_language', resolutionRequired: true }),
    ]);
    expect(preview.conflicts.permissions[0]).toMatchObject({
      channel: 'SMS',
      restrictiveStatus: 'OPTED_OUT',
    });
    expect(preview.impact.identities).toBe(0);
  });

  it('fusionne dans une transaction sérialisable et rejoue la même clé sans second audit', async () => {
    const rows = [
      customer({ id: 'target', name: 'Cible', phone: '+33611111111' }),
      // An exact phone match is the primary duplicate signal and must be
      // mergeable; the source identity is deduplicated during the transaction.
      customer({ id: 'source', name: 'Source', phone: '+33611111111' }),
    ];
    vi.mocked(db.customer.findMany)
      .mockResolvedValueOnce(rows as never)
      .mockResolvedValueOnce([{ phone: '+33611111111' }, { phone: '+33611111111' }] as never);
    vi.mocked(db.reservation.updateMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(db.giftCard.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.customerConsent.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.customerTimelineEvent.updateMany).mockResolvedValue({ count: 4 } as never);
    vi.mocked(db.marketingConversion.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.customerMergeAudit.create).mockResolvedValue({
      id: 'merge-audit-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
      summary: { sourceCount: 1, reservationsMoved: 2 },
    } as never);

    const first = await mergeCustomerProfiles({
      restaurantId: 'restaurant-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
      actor: 'user-1',
      idempotencyKey: 'merge-key-1',
    });
    expect(first).toMatchObject({ auditId: 'merge-audit-1', replayed: false });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(db.customer.updateMany).toHaveBeenCalledWith({
      where: { restaurantId: 'restaurant-1', id: { in: ['source'] } },
      data: { mergedIntoId: 'target', archivedAt: expect.any(Date) },
    });
    expect(redisCache.del).toHaveBeenCalledTimes(2);
    for (const model of [
      db.experienceReservation,
      db.reputationFeedbackRequest,
      db.reputationFeedback,
      db.reputationRecoveryTask,
      db.loyaltyGrant,
    ]) {
      expect(model.updateMany).toHaveBeenCalledWith({
        where: { restaurantId: 'restaurant-1', customerId: { in: ['source'] } },
        data: { customerId: 'target' },
      });
    }

    const payloadHash = vi.mocked(db.customerMergeAudit.create).mock.calls[0]?.[0]?.data
      ?.payloadHash;
    expect(payloadHash).toEqual(expect.any(String));
    vi.mocked(db.customerMergeAudit.findUnique).mockResolvedValue({
      id: 'merge-audit-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
      payloadHash,
      summary: { sourceCount: 1, reservationsMoved: 2 },
    } as never);
    const replay = await mergeCustomerProfiles({
      restaurantId: 'restaurant-1',
      targetCustomerId: 'target',
      sourceCustomerIds: ['source'],
      actor: 'user-1',
      idempotencyKey: 'merge-key-1',
    });
    expect(replay.replayed).toBe(true);
    expect(db.customerMergeAudit.create).toHaveBeenCalledTimes(1);
  });
});
