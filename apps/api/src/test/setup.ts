import { vi } from 'vitest';

// Ink-2 en parallèle s'ouvre à chaque connexion Deepgram dès qu'une clé Cartesia est présente : jamais de vraie
// socket Cartesia pendant les tests (stt-ink-parallel.test.ts teste le module réel avec une socket simulée).
vi.mock('../modules/voice/stream/stt-ink-parallel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/voice/stream/stt-ink-parallel')>()),
  openInkParallel: vi.fn(async () => undefined),
}));

// ── Mock @prisma/client ──
vi.mock('@prisma/client', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class PrismaClient {
    restaurant = {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    posConnection = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    posCheck = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    reservationCheckMatch = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    reservationPaymentPolicy = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    reservationPayment = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    reservationPaymentEvent = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    };
    restaurantAccount = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    restaurantAccountMembership = {
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
    restaurantAccountBilling = {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    restaurantBilling = {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    stripeWebhookEvent = {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    giftCardCheckout = {
      findUniqueOrThrow: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    giftCardPaymentEntry = {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
    };
    giftCardDelivery = {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'delivery-test' }),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    giftCardRefundRequest = {
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    giftCard = {
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      aggregate: vi.fn(),
    };
    giftCardContribution = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      findMany: vi.fn(),
    };
    giftCardPack = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    call = {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    };
    customer = {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };
    customerGroupProfile = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    customerGroupMembership = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
    demoRequest = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    reputationFeedbackRequest = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    reputationFeedback = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    };
    reputationRecoveryTask = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    loyaltyBenefit = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    loyaltyGrant = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    experience = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    experienceSession = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    experienceReservation = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    experienceCheckout = {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    experiencePaymentEvent = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    };
    event = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    eventSession = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    eventTicketType = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    eventOrder = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    eventTicket = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    eventWaitlistEntry = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    distributionConnection = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    distributionSyncRun = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    distributionAvailabilitySnapshot = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    };
    distributionReservationLink = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    };
    distributionWebhookEvent = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    };
    customerIdentity = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    customerTimelineEvent = {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    };
    customerMetricSnapshot = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    customerPreference = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    customerTag = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
    };
    customerTagAssignment = {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
    };
    customerMergeAudit = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
    };
    customerSegment = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    };
    customerConsent = {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    };
    marketingPermission = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    marketingPermissionEvent = {
      create: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    marketingSuppression = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
    };
    marketingCampaign = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    };
    marketingAutomation = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    };
    marketingAutomationDispatch = {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    campaignAudienceMember = {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    };
    campaignMessage = {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
    };
    marketingConversion = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    };
    marketingFrequencyWindow = {
      findMany: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      update: vi.fn(),
      delete: vi.fn(),
    };
    marketingAttributionLink = {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      upsert: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      delete: vi.fn(),
    };
    reservation = {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    };
    reservationAuditLog = {
      findFirst: vi.fn(),
      create: vi.fn(),
    };
    onboardingEvent = {
      create: vi.fn().mockResolvedValue({ id: 'test-evt-1' }),
      findMany: vi.fn().mockResolvedValue([]),
    };
    usageEvent = {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      groupBy: vi.fn().mockResolvedValue([]),
    };
    usageMonthlyRollup = {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      deleteMany: vi.fn(),
    };
    usageTariff = {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    };
    usageReconciliationAdjustment = {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn(),
    };
    outboxEvent = {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    $executeRaw = vi.fn().mockResolvedValue(0);
    $queryRaw = vi.fn().mockResolvedValue([{ '1': 1 }]);
    $transaction = vi.fn(async (callback: (tx: PrismaClient) => unknown) => callback(this));
    $disconnect = vi.fn();
  }
  return {
    ...actual, // preserve Prisma namespace (PrismaClientKnownRequestError, Prisma.JsonNull, etc.)
    PrismaClient,
  };
});

// ── Mock ioredis ──
vi.mock('ioredis', () => {
  class Redis {
    get = vi.fn();
    set = vi.fn();
    del = vi.fn();
    incr = vi.fn().mockResolvedValue(1);
    expire = vi.fn().mockResolvedValue(1);
    ping = vi.fn().mockResolvedValue('PONG');
    quit = vi.fn();
  }
  return { default: Redis };
});

// ── Mock BullMQ ──
vi.mock('bullmq', () => {
  class Queue {
    name: string;
    constructor(name: string) {
      this.name = name;
    }
    add = vi.fn().mockResolvedValue({});
    upsertJobScheduler = vi.fn().mockResolvedValue({});
  }
  class Worker {
    on = vi.fn();
    close = vi.fn();
  }
  return { Queue, Worker };
});

// ── Mock Sentry ──
vi.mock('@sentry/node', () => ({
  captureMessage: vi.fn(),
  captureException: vi.fn(),
  init: vi.fn(),
  close: vi.fn(),
  setupFastifyErrorHandler: vi.fn(),
}));

const notificationProviderMocks = vi.hoisted(() => ({
  resendSend: vi.fn().mockResolvedValue({ data: { id: 'test-email-id' }, error: null }),
  resendGet: vi.fn().mockResolvedValue({ data: { last_event: 'delivered' }, error: null }),
  telnyxCreate: vi.fn().mockResolvedValue({}),
  telnyxRetrieve: vi.fn().mockResolvedValue({}),
}));
(globalThis as Record<string, unknown>).__sokarNotificationProviderMocks =
  notificationProviderMocks;

// ── Mock Resend (HTTP API email, remplace nodemailer) ──
vi.mock('../shared/email/rate-limit', () => ({
  waitForResendSlot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('resend', () => ({
  Resend: class MockResend {
    emails = {
      send: notificationProviderMocks.resendSend,
      get: notificationProviderMocks.resendGet,
    };
  },
}));

// ── Mock telnyx (SDK CJS, non compatible ESM via vitest) ──
vi.mock('telnyx', () => ({
  createTelnyx: () => ({
    messages: {
      create: notificationProviderMocks.telnyxCreate,
      retrieve: notificationProviderMocks.telnyxRetrieve,
    },
  }),
}));

vi.mock('../../shared/telnyx/client', () => ({
  default: {
    messages: { create: vi.fn().mockResolvedValue({}) },
  },
  sendSms: vi.fn().mockResolvedValue(undefined),
  sendWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock Stripe (SDK non nécessaire en tests unitaires) ──
const stripeMocks = vi.hoisted(() => ({
  customerRetrieve: vi.fn(),
  invoiceList: vi.fn(),
  customerCreate: vi.fn().mockResolvedValue({ id: 'cus_test' }),
  subscriptionCreate: vi.fn().mockResolvedValue({
    id: 'sub_trial_test',
    created: 1_792_000_000,
    trial_end: 1_792_000_000 + 14 * 24 * 60 * 60,
    status: 'trialing',
  }),
  subscriptionRetrieve: vi.fn().mockResolvedValue({
    id: 'sub_trial_test',
    status: 'trialing',
    metadata: {},
    items: { data: [] },
  }),
  subscriptionList: vi.fn().mockResolvedValue({ data: [], has_more: false }),
  checkoutSessionList: vi.fn().mockResolvedValue({ data: [], has_more: false }),
  checkoutSessionExpire: vi.fn().mockResolvedValue({ status: 'expired' }),
  checkoutSessionCreate: vi
    .fn()
    .mockResolvedValue({ id: 'cs_test', url: 'https://checkout.stripe.test/cs_test' }),
  billingPortalSessionCreate: vi
    .fn()
    .mockResolvedValue({ url: 'https://billing.stripe.test/portal' }),
}));
(globalThis as Record<string, unknown>).__sokarStripeCheckoutSessionCreate =
  stripeMocks.checkoutSessionCreate;
(globalThis as Record<string, unknown>).__sokarStripeBillingPortalSessionCreate =
  stripeMocks.billingPortalSessionCreate;
(globalThis as Record<string, unknown>).__sokarStripeCustomerCreate = stripeMocks.customerCreate;
(globalThis as Record<string, unknown>).__sokarStripeSubscriptionCreate =
  stripeMocks.subscriptionCreate;
(globalThis as Record<string, unknown>).__sokarStripeSubscriptionRetrieve =
  stripeMocks.subscriptionRetrieve;
(globalThis as Record<string, unknown>).__sokarStripeSubscriptionList =
  stripeMocks.subscriptionList;
(globalThis as Record<string, unknown>).__sokarStripeCheckoutSessionList =
  stripeMocks.checkoutSessionList;
(globalThis as Record<string, unknown>).__sokarStripeCheckoutSessionExpire =
  stripeMocks.checkoutSessionExpire;

(globalThis as Record<string, unknown>).__sokarStripeRead = {
  customer: stripeMocks.customerRetrieve,
  subscription: stripeMocks.subscriptionRetrieve,
  invoices: stripeMocks.invoiceList,
};

vi.mock('stripe', () => {
  class Stripe {
    customers = {
      create: stripeMocks.customerCreate,
      retrieve: stripeMocks.customerRetrieve,
    };
    subscriptions = {
      create: stripeMocks.subscriptionCreate,
      retrieve: stripeMocks.subscriptionRetrieve,
      list: stripeMocks.subscriptionList,
    };
    checkout = {
      sessions: {
        create: stripeMocks.checkoutSessionCreate,
        list: stripeMocks.checkoutSessionList,
        expire: stripeMocks.checkoutSessionExpire,
      },
    };
    billingPortal = {
      sessions: {
        create: stripeMocks.billingPortalSessionCreate,
      },
    };
    invoices = { list: stripeMocks.invoiceList };
    paymentIntents = {
      create: vi.fn().mockResolvedValue({ id: 'pi_test', client_secret: 'pi_t_s' }),
      retrieve: vi.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }),
    };
    webhooks = {
      constructEvent: vi.fn().mockReturnValue({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_test', status: 'succeeded' } },
      }),
    };
  }
  return { default: Stripe };
});

// ── Mock stripe.service (fonctions mockables par les tests) ──
vi.mock('../modules/gift-cards/stripe.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    retrieveConnectedAccount: vi.fn().mockResolvedValue({
      id: 'acct_test',
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    }),
    createPaymentIntent: vi.fn().mockResolvedValue({ id: 'pi_test', clientSecret: 'pi_t_s' }),
    retrievePaymentIntent: vi.fn().mockResolvedValue({ id: 'pi_test', status: 'succeeded' }),
    constructWebhookEvent: vi.fn().mockResolvedValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_test', status: 'succeeded' } },
    }),
  };
});

// ── Mock rate-limit (Redis non requis en tests unitaires) ──
vi.mock('../shared/redis/rate-limit', () => ({
  checkRateLimit: vi.fn().mockResolvedValue(true),
  rateLimitKey: (route: string, ip: string) => `ratelimit:${route}:${ip}`,
  getClientIp: (req: { ip?: string; headers?: Record<string, string | string[]> }) =>
    req.ip ?? req.headers?.['x-forwarded-for'] ?? 'test-ip',
}));

// ── Mock gift-card-code.util (shortCode fixe en tests) ──
vi.mock('../modules/gift-cards/gift-card-code.util', () => ({
  generateShortCode: vi.fn(() => 'SKR-TEST-01'),
  generateUniqueShortCode: vi.fn().mockResolvedValue('SKR-TEST-01'),
}));

// ── Mock gift-card-email.service (emails non envoyés en tests) ──
vi.mock('../modules/gift-cards/gift-card-email.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendSenderReceipt: vi.fn().mockResolvedValue(undefined),
    sendRecipientGiftCard: vi.fn().mockResolvedValue(undefined),
    sendRestaurantSaleNotification: vi.fn().mockResolvedValue(undefined),
    sendContributionConfirmation: vi.fn().mockResolvedValue(undefined),
    sendCrowdfundingContributionNotification: vi.fn().mockResolvedValue(undefined),
    sendCrowdfundingClosed: vi.fn().mockResolvedValue(undefined),
  };
});

// ── Mock gift-card-whatsapp.service (WhatsApp non envoyé en tests) ──
vi.mock('../modules/gift-cards/gift-card-whatsapp.service', () => ({
  sendRecipientWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock pdfkit (génération PDF non nécessaire en tests unitaires) ──
vi.mock('pdfkit', () => {
  class PDFDocument {
    page = { width: 297, height: 420 }; // A6 approx
    private handlers: Record<string, ((chunk?: unknown) => void)[]> = {};
    constructor(_opts?: unknown) {}
    pipe = vi.fn();
    fontSize = vi.fn().mockReturnThis();
    font = vi.fn().mockReturnThis();
    text = vi.fn().mockReturnThis();
    image = vi.fn().mockReturnThis();
    rect = vi.fn().mockReturnThis();
    fill = vi.fn().mockReturnThis();
    fillColor = vi.fn().mockReturnThis();
    strokeColor = vi.fn().mockReturnThis();
    moveTo = vi.fn().mockReturnThis();
    lineTo = vi.fn().mockReturnThis();
    stroke = vi.fn().mockReturnThis();
    moveDown = vi.fn().mockReturnThis();
    lineWidth = vi.fn().mockReturnThis();
    on(event: string, cb: (chunk?: unknown) => void) {
      if (!this.handlers[event]) this.handlers[event] = [];
      this.handlers[event].push(cb);
      return this;
    }
    end() {
      if (this.handlers['data']) {
        for (const cb of this.handlers['data']) cb(Buffer.from('mock-pdf'));
      }
      if (this.handlers['end']) {
        for (const cb of this.handlers['end']) cb();
      }
    }
  }
  return { default: PDFDocument };
});

// ── Mock lib/auth — valeur par défaut (surchargeable par les fichiers de test) ──
vi.mock('../../lib/auth', () => ({
  auth: {
    api: {
      getSession: vi.fn().mockResolvedValue(null),
    },
  },
}));

// ── Set test env vars ──
// DATABASE_URL par défaut : la DB locale sokar (Postgres brew).
// Surchargeable via env si besoin (CI, autre host).
process.env.DATABASE_URL ??= 'postgresql://sokar:***@localhost:5432/sokar';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.NODE_ENV = 'test';
process.env.TZ = 'Europe/Paris';
// URL vars requises par le schéma Zod de env.ts (validation centralisée).
// Valeurs localhost pour les tests — le .refine() prod allowlist ne s'active
// qu'en NODE_ENV=production.
process.env.PUBLIC_URL ??= 'http://localhost:4000';
process.env.SITE_URL ??= 'http://localhost:4002';
process.env.DASHBOARD_URL ??= 'http://localhost:3000';
process.env.API_URL ??= 'http://localhost:4000';
process.env.TELNYX_API_KEY = 'test-telnyx-key';
process.env.TELNYX_WEBHOOK_SECRET = 'test-telnyx-secret';
process.env.TELNYX_FROM_NUMBER = '+331****0000';
process.env.VIP_PUSH_ENABLED = 'false';
process.env.CLERK_PUBLISHABLE_KEY = 'pk_test_dummy-test-key';
process.env.CLERK_SECRET_KEY = 'sk_test_dummy-secret-key';
process.env.RESERVATION_SERVICE_TOKEN = ['test', 'reservation', 'service', 'token', 'fixture'].join(
  '-',
);
process.env.CEREBRAS_API_KEY = ['test', 'cerebras', 'api', 'key'].join('-');
process.env.CARTESIA_API_KEY = 'test-cartesia-key';
process.env.STRIPE_SECRET_KEY = 'sk_test';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_t';
process.env.RESEND_API_KEY ??= 're_test';
process.env.EMAIL_FROM ??= 'noreply@test.sokar.fr';
// Active explicitement les routes /api/test dans les tests (SEC-005).
process.env.ENABLE_TEST_ROUTES = 'true';
