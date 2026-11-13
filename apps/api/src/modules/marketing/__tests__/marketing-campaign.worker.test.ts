import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketingCampaignStatus, MarketingMessageStatus } from '@prisma/client';
import type { Job } from 'bullmq';
import type { PrismaClient } from '@prisma/client';
import { marketingOptOutHash } from '../marketing-opt-out.service';
import { isTargetServiceFull } from '../fill-service.service';
import {
  marketingRecipientAllowlist,
  processMarketingCampaignJob,
  type MarketingCampaignWorkerDependencies,
} from '../marketing-campaign.worker';

vi.mock('../fill-service.service', () => ({
  isTargetServiceFull: vi.fn().mockResolvedValue(false),
}));

function makeJob(): Job<{ campaignId: string; restaurantId: string }> {
  return {
    id: 'job-1',
    name: 'send-campaign',
    data: { campaignId: 'campaign-1', restaurantId: 'restaurant-1' },
  } as unknown as Job<{ campaignId: string; restaurantId: string }>;
}

function makeDependencies() {
  const campaignMessageFindMany = vi
    .fn()
    .mockResolvedValueOnce([
      {
        id: 'message-1',
        customerId: 'customer-1',
        customer: {
          id: 'customer-1',
          name: 'Alice Martin',
          phone: '+33601020304',
          emailNormalized: null,
        },
      },
    ])
    .mockResolvedValue([]);
  const campaignMessageUpdateMany = vi
    .fn()
    .mockImplementation((args: { where?: { updatedAt?: unknown } }) =>
      Promise.resolve({ count: args.where?.updatedAt ? 0 : 1 }),
    );
  const db = {
    marketingCampaign: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'campaign-1',
        restaurantId: 'restaurant-1',
        channel: 'SMS',
        status: MarketingCampaignStatus.READY,
        subject: null,
        bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
        restaurant: { name: 'Chez Suppernote', slug: 'chez-sokar' },
      }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
    campaignAudienceMember: {
      findMany: vi.fn().mockResolvedValue([{ id: 'audience-1', customerId: 'customer-1' }]),
    },
    campaignMessage: {
      findMany: campaignMessageFindMany,
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: campaignMessageUpdateMany,
      count: vi.fn().mockResolvedValue(0),
    },
    marketingPermission: { findUnique: vi.fn().mockResolvedValue(null) },
    marketingSuppression: { findFirst: vi.fn().mockResolvedValue(null) },
    marketingOptOut: { findMany: vi.fn().mockResolvedValue([]) },
    marketingFrequencyWindow: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn(),
    },
    customerConsent: { findFirst: vi.fn().mockResolvedValue(null) },
    customer: { findFirst: vi.fn().mockResolvedValue({ id: 'customer-1' }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (callback: (tx: unknown) => unknown) => callback(db)),
  } as unknown as PrismaClient;
  const sendSms = vi.fn().mockResolvedValue({
    outcome: 'success',
    provider: 'telnyx',
    channel: 'sms',
    providerMessageId: 'telnyx-1',
  });
  const deps: MarketingCampaignWorkerDependencies = {
    db: db as MarketingCampaignWorkerDependencies['db'],
    sendSms,
    sendEmail: vi.fn(),
    sendWhatsApp: vi.fn(),
    createUnsubscribeToken: vi.fn().mockResolvedValue('unsubscribe-token'),
    sendsEnabled: true,
    marketingEmailFrom: 'bonjour@news.suppernote.test',
    now: () => new Date('2026-09-13T12:00:00.000Z'),
  };
  return { db, deps, sendSms };
}

const ACCEPTED_EMAIL = {
  outcome: 'success',
  provider: 'resend',
  channel: 'email',
  providerMessageId: 'resend-1',
};

/** Une campagne e-mail prête, dont un seul destinataire a donné son accord. */
function mockEmailCampaign(
  db: PrismaClient,
  managerEmail: string,
  campaign: {
    status?: MarketingCampaignStatus;
    scheduledAt?: Date | null;
    audienceCount?: number;
  } = {},
) {
  vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
  vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
    id: 'campaign-1',
    restaurantId: 'restaurant-1',
    channel: 'EMAIL',
    status: MarketingCampaignStatus.READY,
    subject: 'Une table vous attend',
    bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
    restaurant: { name: 'Chez Suppernote, Paris', slug: 'chez-sokar', managerEmail },
    ...campaign,
  } as never);
  vi.mocked(db.campaignMessage.findMany)
    .mockReset()
    .mockResolvedValueOnce([
      {
        id: 'message-1',
        customerId: 'customer-1',
        customer: {
          id: 'customer-1',
          name: 'Alice Martin',
          phone: '',
          emailNormalized: 'alice@example.com',
        },
      },
    ] as never)
    .mockResolvedValue([]);
}

describe('marketing campaign worker', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.API_URL = 'https://api.suppernote.test';
    vi.stubEnv('MARKETING_OPTOUT_HASH_SECRET', 'k'.repeat(40));
  });

  it('recontrôle le consentement, rend le message et persiste un accept provider', async () => {
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toEqual({
      processed: 1,
      accepted: 1,
      failed: 0,
    });
    expect(sendSms).toHaveBeenCalledWith(
      '+33601020304',
      expect.stringContaining('Bonjour Alice'),
      expect.objectContaining({ sourceType: 'marketing_campaign', sourceId: 'message-1' }),
    );
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'message-1', status: MarketingMessageStatus.SENDING },
        data: expect.objectContaining({
          status: MarketingMessageStatus.ACCEPTED,
          providerMessageId: 'telnyx-1',
        }),
      }),
    );
    expect(db.marketingCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ acceptedCount: { increment: 1 } }),
      }),
    );
  });

  it('annule la ligne si le consentement est retiré entre snapshot et envoi', async () => {
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({
      status: 'OPTED_OUT',
    } as never);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      processed: 1,
      accepted: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MarketingMessageStatus.CANCELLED, errorCode: 'OPTED_OUT' },
      }),
    );
  });

  it('annule si le numéro a changé avant le dernier contrôle', async () => {
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
    vi.mocked(db.customer.findFirst)
      .mockResolvedValueOnce({ id: 'customer-1' } as never)
      .mockResolvedValueOnce(null);

    await processMarketingCampaignJob(makeJob(), deps);
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.customer.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ phone: '+33601020304' }),
      }),
    );
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MarketingMessageStatus.CANCELLED, errorCode: 'CUSTOMER_INACTIVE' },
      }),
    );
  });

  it('n’envoie pas à une adresse inscrite au registre d’opposition, même avec un accord en base', async () => {
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
    const hash = marketingOptOutHash('restaurant-1', 'SMS', '+33601020304');
    vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([{ addressHash: hash }] as never);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      processed: 1,
      accepted: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MarketingMessageStatus.CANCELLED, errorCode: 'OPTED_OUT_REGISTER' },
      }),
    );
  });

  it('n’envoie rien tant que la clé du registre est absente (échec fermé)', async () => {
    vi.stubEnv('MARKETING_OPTOUT_HASH_SECRET', '');
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);

    await processMarketingCampaignJob(makeJob(), deps);
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: MarketingMessageStatus.CANCELLED,
          errorCode: 'OPT_OUT_REGISTER_UNAVAILABLE',
        },
      }),
    );
  });

  it('crée un lien d attribution par destinataire et l injecte dans reservationLink', async () => {
    const { db, deps, sendSms } = makeDependencies();
    const attributionToken = ['v1', 'payload', 'signature'].join('.');
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'restaurant-1',
      channel: 'SMS',
      status: MarketingCampaignStatus.READY,
      subject: null,
      bodyTemplate: 'Réservez ici : {{reservationLink}}',
      restaurant: { name: 'Chez Suppernote', slug: 'chez-sokar' },
    } as never);
    const createAttributionLink = vi.fn().mockResolvedValue({
      token: attributionToken,
      link: { id: 'link-1' },
    });
    deps.createAttributionLink = createAttributionLink as never;

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      processed: 1,
      accepted: 1,
    });
    expect(createAttributionLink).toHaveBeenCalledWith({
      restaurantId: 'restaurant-1',
      campaignId: 'campaign-1',
      customerId: 'customer-1',
      issuedAt: new Date('2026-09-13T12:00:00.000Z'),
    });
    expect(sendSms).toHaveBeenCalledWith(
      '+33601020304',
      `Réservez ici : http://localhost:3000/book/chez-sokar?marketingAttributionToken=${attributionToken}`,
      expect.anything(),
    );
  });
  it('envoie un e-mail avec liens cliquables et en-têtes de désinscription en un clic', async () => {
    const { db, deps } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'restaurant-1',
      channel: 'EMAIL',
      status: MarketingCampaignStatus.READY,
      subject: 'Une table vous attend',
      bodyTemplate: 'Bonjour {{customer.firstName}}\nSe désinscrire : {{unsubscribeUrl}}',
      restaurant: {
        name: 'Chez Suppernote',
        slug: 'chez-sokar',
        managerEmail: 'manager@chez-suppernote.test',
        formattedAddress: '1 rue de Test, 75001 Paris',
      },
    } as never);
    vi.mocked(db.campaignMessage.findMany)
      .mockReset()
      .mockResolvedValueOnce([
        {
          id: 'message-1',
          customerId: 'customer-1',
          customer: {
            id: 'customer-1',
            name: 'Alice Martin',
            phone: '',
            emailNormalized: 'alice@example.com',
          },
        },
      ] as never)
      .mockResolvedValue([]);
    const sendEmail = vi.fn().mockResolvedValue({
      outcome: 'success',
      provider: 'resend',
      channel: 'email',
      providerMessageId: 'resend-1',
    });
    deps.sendEmail = sendEmail as never;

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      accepted: 1,
      failed: 0,
    });
    const unsubscribeUrl =
      'https://api.suppernote.test/marketing/unsubscribe?token=unsubscribe-token';
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Une table vous attend',
        html:
          `Bonjour Alice<br>Se désinscrire : <a href="${unsubscribeUrl}">Se désinscrire</a>` +
          '<br><br>Chez Suppernote, 1 rue de Test, 75001 Paris<br>' +
          'Vous recevez ce message car vous avez accepté de recevoir les actualités de ce restaurant par e-mail.',
        headers: {
          'List-Unsubscribe': `<${unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        },
      }),
    );
  });
  it('se met en pause sans rien envoyer quand le service visé est complet', async () => {
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValueOnce({
      id: 'campaign-1',
      restaurantId: 'restaurant-1',
      channel: 'SMS',
      status: MarketingCampaignStatus.READY,
      subject: null,
      bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      restaurant: { name: 'Chez Suppernote', slug: 'chez-sokar' },
      targetServiceStart: new Date('2026-11-04T11:00:00.000Z'),
      targetServiceEnd: new Date('2026-11-04T15:00:00.000Z'),
    } as never);
    vi.mocked(db.campaignMessage.count).mockResolvedValueOnce(1);
    vi.mocked(isTargetServiceFull).mockResolvedValueOnce(true);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toEqual({
      processed: 0,
      accepted: 0,
      failed: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.marketingCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MarketingCampaignStatus.PAUSED, lastErrorCode: 'TARGET_SERVICE_FULL' },
      }),
    );
  });

  it('lit la liste blanche sans tenir compte de la casse ni des espaces', () => {
    expect(marketingRecipientAllowlist({})).toBeNull();
    expect(marketingRecipientAllowlist({ MARKETING_RECIPIENT_ALLOWLIST: ' , ' })).toBeNull();
    expect(
      marketingRecipientAllowlist({
        MARKETING_RECIPIENT_ALLOWLIST: ' Testeur@Example.com , +33600000000 ',
      }),
    ).toEqual(new Set(['testeur@example.com', '+33600000000']));
  });

  it('annule sans appeler le fournisseur un destinataire hors liste blanche', async () => {
    vi.stubEnv('MARKETING_RECIPIENT_ALLOWLIST', 'testeur@example.com');
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      processed: 1,
      accepted: 0,
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(db.marketingFrequencyWindow.updateMany).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: MarketingMessageStatus.CANCELLED, errorCode: 'NOT_IN_TEST_ALLOWLIST' },
      }),
    );
  });

  it('envoie à un destinataire présent dans la liste blanche', async () => {
    vi.stubEnv('MARKETING_RECIPIENT_ALLOWLIST', '+33601020304');
    const { db, deps, sendSms } = makeDependencies();
    vi.mocked(db.marketingPermission.findUnique).mockResolvedValue({ status: 'OPTED_IN' } as never);

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      accepted: 1,
    });
    expect(sendSms).toHaveBeenCalledTimes(1);
  });

  it('envoie depuis l’expéditeur marketing dédié, au nom du restaurant, avec son adresse en Reply-To', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'Manager@Chez-Suppernote.test');
    const sendEmail = vi.fn().mockResolvedValue(ACCEPTED_EMAIL);
    deps.sendEmail = sendEmail as never;

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      accepted: 1,
    });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Chez Suppernote, Paris" <bonjour@news.suppernote.test>',
        replyTo: 'manager@chez-suppernote.test',
      }),
    );
  });

  it('n’ajoute aucun Reply-To quand le restaurant n’a pas d’adresse valide', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'pas une adresse');
    const sendEmail = vi.fn().mockResolvedValue(ACCEPTED_EMAIL);
    deps.sendEmail = sendEmail as never;

    await processMarketingCampaignJob(makeJob(), deps);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ replyTo: null }));
  });

  it('une programmation partie avant sa date repasse le contrôle pour le jour réel d’envoi', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test', {
      status: MarketingCampaignStatus.SCHEDULED,
      scheduledAt: new Date('2030-01-15T09:00:00.000Z'),
      audienceCount: 30,
    });
    // Le 10, 20 e-mails sont déjà acceptés : il ne reste que 20 sur 30 demandés.
    vi.mocked(db.campaignMessage.count).mockImplementation((async ({
      where,
    }: {
      where: { acceptedAt?: unknown };
    }) => (where.acceptedAt ? 20 : 0)) as never);
    const sendEmail = vi.fn();
    deps.sendEmail = sendEmail as never;
    deps.now = () => new Date('2030-01-10T10:00:00.000Z');

    await expect(processMarketingCampaignJob(makeJob(), deps)).rejects.toThrow(
      'MARKETING_DAILY_BUDGET_EXCEEDED',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).not.toHaveBeenCalled();
    expect(db.marketingCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: MarketingCampaignStatus.READY,
          lastErrorCode: 'MARKETING_DAILY_BUDGET_EXCEEDED',
        },
      }),
    );
  });

  it('une programmation le jour J n’est pas bloquée par ses propres messages', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test', {
      status: MarketingCampaignStatus.SCHEDULED,
      scheduledAt: new Date('2030-01-10T09:00:00.000Z'),
      audienceCount: 30,
    });
    // Ses 30 messages attendent le jour J : sans exclusion de soi-même, 30 + 30 dépasseraient 40.
    vi.mocked(db.campaignMessage.count).mockImplementation((async ({
      where,
    }: {
      where: { acceptedAt?: unknown; campaignId?: unknown };
    }) => (where.acceptedAt || where.campaignId ? 0 : 30)) as never);
    const sendEmail = vi.fn().mockResolvedValue({
      outcome: 'success',
      provider: 'resend',
      channel: 'email',
      providerMessageId: 'resend-1',
    });
    deps.sendEmail = sendEmail as never;
    deps.now = () => new Date('2030-01-10T10:00:00.000Z');

    await expect(processMarketingCampaignJob(makeJob(), deps)).resolves.toMatchObject({
      accepted: 1,
    });
    expect(db.campaignMessage.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ campaignId: { not: 'campaign-1' } }),
      }),
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  const decrement = { data: { sendCount: { decrement: 1 } } };

  it('rend le créneau de fréquence et garde le motif quand la liste blanche refuse l’envoi', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test');
    deps.sendEmail = vi.fn().mockResolvedValue({
      outcome: 'failure_certain',
      provider: 'resend',
      channel: 'email',
      reason: 'RECIPIENT_NOT_ALLOWLISTED',
    }) as never;

    await processMarketingCampaignJob(makeJob(), deps);

    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MarketingMessageStatus.FAILED,
          errorCode: 'RECIPIENT_NOT_ALLOWLISTED',
        }),
      }),
    );
    expect(db.marketingFrequencyWindow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        ...decrement,
        where: expect.objectContaining({
          restaurantId: 'restaurant-1',
          customerId: 'customer-1',
          channel: 'EMAIL',
        }),
      }),
    );
  });

  it('rend le créneau quand Resend refuse et masque l’adresse dans le code d’erreur', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test');
    deps.sendEmail = vi
      .fn()
      .mockRejectedValue(new Error('Resend API error: invalid to alice@example.com')) as never;

    await processMarketingCampaignJob(makeJob(), deps);

    expect(db.campaignMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ errorCode: 'RESEND_API_ERROR:_INVALID_TO_EMAIL' }),
      }),
    );
    expect(db.marketingFrequencyWindow.updateMany).toHaveBeenCalledWith(
      expect.objectContaining(decrement),
    );
  });

  it('garde le créneau quand on ne sait pas si le message est parti', async () => {
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test');
    deps.sendEmail = vi.fn().mockResolvedValue({
      outcome: 'unknown',
      provider: 'resend',
      channel: 'email',
    }) as never;

    await processMarketingCampaignJob(makeJob(), deps);

    expect(db.marketingFrequencyWindow.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining(decrement),
    );
  });

  it('refuse l’envoi e-mail sans MARKETING_EMAIL_FROM, sans jamais se rabattre sur EMAIL_FROM', async () => {
    vi.stubEnv('EMAIL_FROM', 'noreply@suppernote.com');
    const { db, deps } = makeDependencies();
    mockEmailCampaign(db, 'manager@chez-suppernote.test');
    deps.marketingEmailFrom = null;
    const sendEmail = vi.fn();
    deps.sendEmail = sendEmail as never;

    await expect(processMarketingCampaignJob(makeJob(), deps)).rejects.toThrow(
      'MARKETING_EMAIL_FROM_MISSING',
    );
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.campaignMessage.updateMany).not.toHaveBeenCalled();
    expect(db.marketingCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          status: MarketingCampaignStatus.READY,
          lastErrorCode: 'MARKETING_EMAIL_FROM_MISSING',
        },
      }),
    );
  });
});
