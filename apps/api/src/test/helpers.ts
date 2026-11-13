import { buildApp } from '../main';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { vi } from 'vitest';

vi.mock('../modules/gift-cards/managed-connect-verification', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../modules/gift-cards/managed-connect-verification')>();
  return { ...actual, managedConnectVerified: vi.fn(() => true) };
});

vi.mock('../plugins/clerk', () => ({
  isClerkConfigured: vi.fn(() => true),
  registerClerk: vi.fn().mockResolvedValue(undefined),
  requireOrg: () => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      const testRestaurantId = req.headers?.['x-test-restaurant-id'];
      req.restaurantId = typeof testRestaurantId === 'string' ? testRestaurantId : 'test-rest-1';
      req.siteId = 'test-rest-1';
      req.accountId = req.headers?.['x-test-legacy'] ? undefined : 'test-account-1';
      req.clerkOrganizationId = 'test-rest-1';
      const requestedRole = req.headers?.['x-test-site-role'];
      req.siteRole =
        requestedRole === 'STAFF' ||
        requestedRole === 'MANAGER' ||
        requestedRole === 'READ_ONLY' ||
        requestedRole === 'ORG_MEMBER'
          ? requestedRole
          : 'OWNER';
      req.userId = 'test-user-1';
      // La politique de rôles est celle du vrai requireOrg, appliquée seulement à la demande : les
      // tests qui envoient un rôle pour tester une route ne doivent pas être arrêtés avant elle.
      if (req.headers?.['x-test-enforce-role-policy']) {
        const { evaluateRolePolicy } = await import('../modules/restaurants/role-policy');
        const decision = evaluateRolePolicy({
          role: req.siteRole,
          method: req.method,
          route: req.routeOptions?.url,
        });
        if (!decision.allowed) return reply.status(403).send({ error: decision.code });
      }
    };
  },
  requirePlatformOperator: () => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      // Un restaurateur connecté mais hors de la liste des opérateurs Suppernote.
      if (req.headers?.['x-test-not-operator']) {
        return reply.status(403).send({ error: 'Suppernote operator access required' });
      }
      req.userId = 'test-operator-1';
    };
  },
  requireAuth: () => {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const authHeader = req.headers?.authorization;
      if (!authHeader) {
        return reply.status(401).send({ error: 'Authentication required' });
      }
      req.userId = 'test-user-1';
    };
  },
}));

// db mock — contains all Prisma models used by tests.
// We split $transaction's tx from the top-level db to avoid the
// "object literal cannot have multiple properties with the same name"
// TS error that would happen if `restaurant` appeared both at top
// level and inside the transaction callback argument.
vi.mock('../shared/db/client', () => {
  const txMock = {
    restaurant: { update: vi.fn() },
    posConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    posCheck: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationCheckMatch: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationPaymentPolicy: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationPayment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reservationPaymentEvent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    restaurantExposureSettings: { upsert: vi.fn(), findUnique: vi.fn() },
    reservationAuditLog: { create: vi.fn() },
    reservation: { count: vi.fn() },
    agentClient: {
      create: vi.fn(),
      update: vi.fn(),
    },
    floorPlan: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    section: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    table: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: { capacity: null },
        _max: { capacity: null },
      }),
    },
    reactivationCampaign: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    giftCard: {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue({ id: 'tx-card' }),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn(),
    },
    giftCardRedemption: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    giftCardContribution: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    giftCardPack: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customer: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerGroupProfile: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customerGroupMembership: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    reputationFeedbackRequest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reputationFeedback: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    reputationRecoveryTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    loyaltyBenefit: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    loyaltyGrant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experience: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    experienceSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experienceReservation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experienceCheckout: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experiencePaymentEvent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    event: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    eventSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventTicketType: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    eventOrder: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventTicket: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventWaitlistEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerIdentity: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerTimelineEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    customerMetricSnapshot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerTag: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    customerTagAssignment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerMergeAudit: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    marketingPermission: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    marketingPermissionEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
    },
    marketingSuppression: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingCampaign: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    marketingAutomation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    marketingAutomationDispatch: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    campaignAudienceMember: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    campaignMessage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingProviderReconciliation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'tx-reconciliation-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    marketingConversion: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingFrequencyWindow: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingAttributionLink: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  };

  const dbObj = {
    demoRequest: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    restaurant: {
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    reputationFeedbackRequest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reputationFeedback: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    reputationRecoveryTask: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    loyaltyBenefit: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    loyaltyGrant: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experience: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    experienceSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experienceReservation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experienceCheckout: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    experiencePaymentEvent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    event: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    eventSession: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventTicketType: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    eventOrder: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventTicket: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    eventWaitlistEntry: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    distributionConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    distributionSyncRun: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    distributionAvailabilitySnapshot: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    distributionReservationLink: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    distributionWebhookEvent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    posConnection: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    posCheck: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationCheckMatch: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationPaymentPolicy: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    reservationPayment: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    reservationPaymentEvent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    restaurantAccount: {
      upsert: vi.fn().mockResolvedValue({ id: 'test-account-1' }),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    restaurantAccountMembership: {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'test-membership-1' }),
      upsert: vi.fn().mockResolvedValue({ id: 'test-membership-1' }),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    restaurantAccountBilling: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    restaurantBilling: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    stripeWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    agentPersonality: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    agentClient: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    restaurantExposureSettings: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    reservationAuditLog: {
      create: vi.fn(),
      findFirst: vi.fn(),
    },
    reservation: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
    waitingListEntry: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    customer: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    customerGroupProfile: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    customerGroupMembership: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
    customerIdentity: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerTimelineEvent: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    customerMetricSnapshot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerPreference: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerTag: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    },
    customerTagAssignment: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    customerMergeAudit: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    },
    customerSegment: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    marketingPermission: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingOptOut: {
      upsert: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    marketingPermissionEvent: {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingSuppression: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    marketingCampaign: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    marketingAutomation: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    marketingAutomationDispatch: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    campaignAudienceMember: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    campaignMessage: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
    },
    marketingProviderReconciliation: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn(),
      upsert: vi.fn().mockResolvedValue({ id: 'reconciliation-1' }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    marketingConversion: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      delete: vi.fn(),
    },
    marketingFrequencyWindow: {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    marketingAttributionLink: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
    },
    voiceDebugTurn: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    call: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    latencyTrace: {
      findMany: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    voiceCallTelemetry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      aggregate: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    voiceTurnTelemetry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(),
    },
    customerConsent: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    agenticHold: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    restaurantImage: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    },
    onboardingEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'test-evt-1' }),
    },
    floorPlan: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    section: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    table: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
      groupBy: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: { capacity: null },
        _max: { capacity: null },
      }),
    },
    reactivationCampaign: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    giftCard: {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn(),
    },
    giftCardRedemption: {
      aggregate: vi.fn().mockResolvedValue({ _sum: { amount: null } }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    giftCardContribution: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findMany: vi.fn(),
    },
    giftCardPack: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    identityVerificationOtp: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    signedTokenUsage: {
      create: vi.fn(),
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    usageEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    },
    usageMonthlyRollup: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    usageTariff: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    },
    usageReconciliationAdjustment: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    outboxEvent: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    giftCardCheckout: {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    giftCardPaymentEntry: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    },
    giftCardDelivery: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'delivery-test' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    giftCardRefundRequest: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      update: vi.fn(),
    },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (fn: unknown) => {
      if (Array.isArray(fn)) {
        return Promise.all(fn);
      }
      if (typeof fn !== 'function') {
        throw new Error('Mock $transaction expects a function or array');
      }
      // Fusionner txMock avec db : pour chaque modèle, on crée un proxy
      // qui préfère les mocks définis sur db (où les tests font vi.mocked)
      // mais retombe sur txMock pour les modèles uniquement dans txMock.
      const mergedTx = new Proxy({} as Record<string, unknown>, {
        get: (_target, prop) => {
          const propStr = prop as string;
          const dbModel = (dbObj as Record<string, unknown>)[propStr];
          if (dbModel !== undefined) return dbModel;
          const txModel = (txMock as Record<string, unknown>)[propStr];
          if (txModel !== undefined) return txModel;
          return undefined;
        },
      });
      return fn(mergedTx);
    }),
  };

  return { db: dbObj };
});

vi.mock('../shared/redis/client', () => {
  // In-memory Map pour que les tests OAuth puissent faire set→get.
  // Les tests existants qui font get sans set auront toujours null (comportement inchangé).
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  const expiring = new Set<string>();
  return {
    redisCache: {
      defineCommand: vi.fn(),
      rateLimit: vi.fn(
        (
          _key: string,
          _window: number,
          _max: number,
          _continue: boolean,
          _backoff: boolean,
          cb: (error: null, result: number[]) => void,
        ) => cb(null, [1, 60000]),
      ),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      getBuffer: vi.fn().mockResolvedValue(null),
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: vi.fn(async (key: string) => {
        const had = store.has(key);
        store.delete(key);
        return had ? 1 : 0;
      }),
      flushall: vi.fn(async () => {
        store.clear();
        counters.clear();
        expiring.clear();
        return 'OK';
      }),
      // Rate limiter support (McpRateLimiter + connect-rate-limit)
      script: vi.fn(async () => 'mock-sha1'),
      evalsha: vi.fn(async () => [1, 59, 0] as [number, number, number]),
      incr: vi.fn(async (key: string) => {
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return count;
      }),
      expire: vi.fn(async (key: string) => {
        expiring.add(key);
        return 1;
      }),
      // Comme Redis : -2 clé absente, -1 clé sans expiration.
      ttl: vi.fn(async (key: string) => {
        if (!store.has(key) && !counters.has(key)) return -2;
        return expiring.has(key) ? 60 : -1;
      }),
      // Used by OAuth checkOauthRate for atomic INCR + PEXPIRE
      eval: vi.fn(async (_script: string, _numKeys: number, key: string, ...args: string[]) => {
        if (_numKeys === 4) {
          const [accessKey, refreshKey, oldAccessKey, expected, next] = args;
          if (store.get(key) !== expected) return 0;
          store.set(accessKey, next);
          if (refreshKey) store.set(refreshKey, next);
          store.delete(key);
          if (oldAccessKey) store.delete(oldAccessKey);
          return 1;
        }
        const count = (counters.get(key) ?? 0) + 1;
        counters.set(key, count);
        return count;
      }),
      status: 'ready',
    },
    redisQueue: {
      on: vi.fn(),
    },
    getCachedContext: vi.fn().mockResolvedValue(null),
    setCachedContext: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../shared/queue/queues', () => ({
  queues: {
    deadLetter: { add: vi.fn().mockResolvedValue({}) },
    eveningReport: {
      upsertJobScheduler: vi.fn(),
    },
    onboarding: {
      add: vi.fn(),
    },
    reconciliation: {
      upsertJobScheduler: vi.fn(),
    },
    smsManager: {
      add: vi.fn(),
    },
    callRecovery: {
      add: vi.fn().mockResolvedValue({}),
    },
    telnyxWebhooks: {
      add: vi.fn(),
    },
    analytics: {
      add: vi.fn().mockResolvedValue({}),
    },
    connectAnalytics: {
      add: vi.fn().mockResolvedValue({}),
    },
    confirmationSms: {
      add: vi.fn().mockResolvedValue({}),
    },
    reactivation: {
      add: vi.fn().mockResolvedValue({}),
    },
    marketingCampaign: {
      add: vi.fn().mockResolvedValue({}),
    },
    marketingAutomation: {
      add: vi.fn().mockResolvedValue({}),
    },
    marketingProviderReconciliation: {
      add: vi.fn().mockResolvedValue({}),
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    },
    reputationFeedbackExpiry: {
      add: vi.fn().mockResolvedValue({}),
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    },
    loyaltyGrantExpiry: {
      add: vi.fn().mockResolvedValue({}),
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    },
    experienceSessionExpiry: {
      add: vi.fn().mockResolvedValue({}),
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    },
    eventSessionExpiry: {
      add: vi.fn().mockResolvedValue({}),
      upsertJobScheduler: vi.fn().mockResolvedValue({}),
    },
  },
}));

let app: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!app) {
    app = await buildApp();
    await app.ready();
  }
  return app;
}

export async function closeApp(): Promise<void> {
  if (app) {
    await app.close();
    app = null;
  }
}
