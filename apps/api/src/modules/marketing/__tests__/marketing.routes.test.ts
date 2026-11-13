import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketingCampaignStatus, MarketingPermissionStatus } from '@prisma/client';
import { MARKETING_CONSENT_VERSION } from '@suppernote/shared';
import { closeApp, getApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { marketingOptOutHash } from '../marketing-opt-out.service';
import { queues } from '../../../shared/queue/queues';
import { createServiceFillDraft, previewServiceFill } from '../fill-service.service';
import {
  dismissFillSuggestion,
  invalidateFillSuggestions,
  listFillSuggestions,
} from '../fill-suggestions.service';

vi.mock('../fill-service.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../fill-service.service')>()),
  createServiceFillDraft: vi.fn(),
  previewServiceFill: vi.fn(),
}));

vi.mock('../fill-suggestions.service', () => ({
  listFillSuggestions: vi.fn(),
  dismissFillSuggestion: vi.fn(),
  invalidateFillSuggestions: vi.fn(),
}));

const AUTH = { authorization: 'Bearer test' };
const NOW = new Date('2026-09-14T10:00:00.000Z');
const DEFINITION = {
  version: 1,
  operator: 'AND',
  conditions: [{ field: 'isVip', op: 'EQ', value: true }],
};

describe('marketing control plane routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    process.env.MARKETING_ATTRIBUTION_SECRET = 'a'.repeat(48);
    process.env.MARKETING_OPTOUT_HASH_SECRET = 'o'.repeat(48);
    vi.mocked(db.marketingOptOut.upsert).mockResolvedValue({} as never);
    vi.mocked(db.marketingOptOut.deleteMany).mockResolvedValue({ count: 0 });
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
    vi.mocked(db.customerConsent.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingPermission.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingSuppression.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingFrequencyWindow.findMany).mockResolvedValue([]);
    vi.mocked(db.usageEvent.findMany).mockResolvedValue([]);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await closeApp();
  });

  it('expose la readiness provider sans valeurs sensibles', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'GET',
      url: '/marketing/providers/readiness',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      data: {
        sendsEnabled: expect.any(Boolean),
        sms: { configured: expect.any(Boolean), callbackConfigured: expect.any(Boolean) },
        email: { configured: expect.any(Boolean), callbackConfigured: expect.any(Boolean) },
        whatsapp: { configured: expect.any(Boolean), callbackConfigured: expect.any(Boolean) },
      },
    });
    expect(JSON.stringify(body)).not.toContain(process.env.TELNYX_API_KEY ?? '__missing_key__');
  });

  it('records a channel opt-in with proof and exposes a tenant-scoped permission list', async () => {
    const app = await getApp();
    vi.mocked(db.customer.findFirst).mockResolvedValue({ id: 'customer-1' } as never);
    vi.mocked(db.customer.findUnique).mockResolvedValue({ restaurantId: 'test-rest-1' } as never);
    vi.mocked(db.marketingPermission.upsert).mockResolvedValue({
      id: 'permission-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      status: MarketingPermissionStatus.OPTED_IN,
    } as never);
    vi.mocked(db.marketingPermissionEvent.create).mockResolvedValue({ id: 'event-1' } as never);

    const updated = await app.inject({
      method: 'PUT',
      url: '/crm/customers/customer-1/marketing-permissions/EMAIL',
      headers: AUTH,
      payload: {
        status: 'OPTED_IN',
        source: 'WEB_FORM',
        proofVersion: 'privacy-2026-09',
        proof: 'consent text version + checkbox',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      data: expect.objectContaining({ id: 'permission-1', status: 'OPTED_IN' }),
    });

    vi.mocked(db.marketingPermission.findMany).mockResolvedValue([
      { id: 'permission-1', channel: 'EMAIL', status: 'OPTED_IN' },
    ] as never);
    const listed = await app.inject({
      method: 'GET',
      url: '/crm/customers/customer-1/marketing-permissions',
      headers: AUTH,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({
      data: [{ id: 'permission-1', channel: 'EMAIL', status: 'OPTED_IN' }],
    });
    expect(db.marketingPermission.findMany).toHaveBeenCalledWith({
      where: { restaurantId: 'test-rest-1', customerId: 'customer-1' },
      orderBy: { channel: 'asc' },
    });
  });

  it('records an oral consent from the dashboard with its collection method as source', async () => {
    const app = await getApp();
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      id: 'customer-1',
      emailNormalized: 'client@example.com',
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      plan: 'PRO',
      name: 'Chez Suppernote',
    } as never);
    vi.mocked(db.customer.findUnique).mockResolvedValue({ restaurantId: 'test-rest-1' } as never);
    vi.mocked(db.marketingPermission.upsert).mockResolvedValue({
      id: 'permission-1',
      channel: 'EMAIL',
      status: MarketingPermissionStatus.OPTED_IN,
    } as never);
    vi.mocked(db.marketingPermissionEvent.create).mockResolvedValue({ id: 'event-1' } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/crm/customers/customer-1/marketing-permissions/EMAIL/consent',
      headers: AUTH,
      payload: { method: 'IN_PERSON' },
    });

    expect(response.statusCode).toBe(200);
    const upsert = vi.mocked(db.marketingPermission.upsert).mock.calls[0]?.[0];
    expect(upsert?.create).toMatchObject({
      restaurantId: 'test-rest-1',
      source: 'DASHBOARD_IN_PERSON',
      status: MarketingPermissionStatus.OPTED_IN,
    });
    expect(upsert?.create.proofVersion).toMatch(/^marketing-consent-/);
    expect(upsert?.create.proofHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a consent recorded by the team when an opposition is registered', async () => {
    const app = await getApp();
    vi.stubEnv('MARKETING_OPTOUT_HASH_SECRET', 'k'.repeat(40));
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      id: 'customer-1',
      emailNormalized: 'alice@example.com',
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      plan: 'PRO',
      name: 'Chez Suppernote',
    } as never);
    vi.mocked(db.marketingPermission.upsert).mockResolvedValue({ id: 'permission-1' } as never);
    vi.mocked(db.marketingPermissionEvent.create).mockResolvedValue({ id: 'event-1' } as never);
    vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([
      { addressHash: marketingOptOutHash('test-rest-1', 'EMAIL', 'alice@example.com') },
    ] as never);

    const response = await app.inject({
      method: 'POST',
      url: '/crm/customers/customer-1/marketing-permissions/EMAIL/consent',
      headers: AUTH,
      payload: { method: 'IN_PERSON' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: 'MARKETING_OPPOSITION_REGISTERED' });
    vi.unstubAllEnvs();
    vi.mocked(db.marketingOptOut.findMany).mockReset();
  });

  it('rejects an oral consent without a method, on an unknown channel or without an e-mail', async () => {
    const app = await getApp();
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      id: 'customer-1',
      emailNormalized: null,
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      plan: 'PRO',
      name: 'Chez Suppernote',
    } as never);
    const url = '/crm/customers/customer-1/marketing-permissions';

    const noMethod = await app.inject({
      method: 'POST',
      url: `${url}/EMAIL/consent`,
      headers: AUTH,
      payload: {},
    });
    expect(noMethod.statusCode).toBe(400);
    const whatsapp = await app.inject({
      method: 'POST',
      url: `${url}/WHATSAPP/consent`,
      headers: AUTH,
      payload: { method: 'PHONE' },
    });
    expect(whatsapp.statusCode).toBe(400);
    const noEmail = await app.inject({
      method: 'POST',
      url: `${url}/EMAIL/consent`,
      headers: AUTH,
      payload: { method: 'PHONE' },
    });
    expect(noEmail.statusCode).toBe(409);
    expect(noEmail.json()).toEqual({ error: 'CUSTOMER_EMAIL_REQUIRED' });
    expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
  });

  it('withdraws a consent from the dashboard under its own source', async () => {
    const app = await getApp();
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      id: 'customer-1',
      phone: '+33612345678',
    } as never);
    vi.mocked(db.customer.findUnique).mockResolvedValue({ restaurantId: 'test-rest-1' } as never);
    vi.mocked(db.marketingPermission.upsert).mockResolvedValue({ id: 'permission-1' } as never);
    vi.mocked(db.marketingPermissionEvent.create).mockResolvedValue({ id: 'event-1' } as never);

    const response = await app.inject({
      method: 'DELETE',
      url: '/crm/customers/customer-1/marketing-permissions/SMS',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(vi.mocked(db.marketingPermission.upsert).mock.calls[0]?.[0].create).toMatchObject({
      status: MarketingPermissionStatus.OPTED_OUT,
      source: 'DASHBOARD_WITHDRAWAL',
    });
  });

  it('previews and creates a draft campaign without sending to a provider', async () => {
    const app = await getApp();
    vi.mocked(db.customerSegment.findFirst).mockResolvedValue({
      id: 'segment-1',
      definition: DEFINITION,
    } as never);
    vi.mocked(db.customer.findMany).mockResolvedValue([
      {
        id: 'customer-1',
        name: 'Alice',
        isVip: true,
        phone: '+33601020304',
        emailNormalized: null,
      },
    ] as never);
    vi.mocked(db.marketingPermission.findMany).mockResolvedValue([
      { customerId: 'customer-1', channel: 'SMS', status: 'OPTED_IN', source: 'WEB' },
    ] as never);

    const preview = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/audience-preview',
      headers: AUTH,
      payload: { channel: 'SMS', segmentId: 'segment-1' },
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toMatchObject({ candidateCount: 1, eligibleCount: 1 });

    vi.mocked(db.marketingCampaign.create).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.DRAFT,
      audienceCount: 1,
    } as never);
    const created = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns',
      headers: AUTH,
      payload: {
        name: 'Relance déjeuner',
        objective: 'Remplir le service de midi',
        channel: 'SMS',
        segmentId: 'segment-1',
        bodyTemplate:
          'Bonjour {{customer.firstName}}, réservez {{reservationLink}} {{unsubscribeUrl}}',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toEqual({ data: expect.objectContaining({ id: 'campaign-1' }) });
    expect(db.campaignAudienceMember.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ campaignId: 'campaign-1', customerId: 'customer-1' })],
    });
  });

  it('expose et configure les trois automations derrière la capability Pro', async () => {
    const app = await getApp();
    vi.mocked(db.marketingAutomation.findMany).mockResolvedValue([
      {
        id: 'automation-1',
        restaurantId: 'test-rest-1',
        type: 'AFTER_FIRST_HONORED',
        channel: 'SMS',
        enabled: false,
      },
    ] as never);
    const listed = await app.inject({
      method: 'GET',
      url: '/marketing/automations',
      headers: AUTH,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ data: [expect.objectContaining({ id: 'automation-1' })] });

    vi.mocked(db.marketingAutomation.upsert).mockResolvedValue({
      id: 'automation-1',
      type: 'AFTER_FIRST_HONORED',
      enabled: true,
    } as never);
    const updated = await app.inject({
      method: 'PUT',
      url: '/marketing/automations/AFTER_FIRST_HONORED',
      headers: AUTH,
      payload: {
        enabled: true,
        channel: 'SMS',
        config: {
          bodyTemplate: 'Merci {{customer.firstName}} {{unsubscribeUrl}}',
          delayHours: 24,
        },
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({ data: expect.objectContaining({ id: 'automation-1' }) });
    expect(db.marketingAutomation.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { restaurantId_type: { restaurantId: 'test-rest-1', type: 'AFTER_FIRST_HONORED' } },
      }),
    );
  });

  it('prepares a non-empty draft and refuses campaign capability on Essential', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.DRAFT,
      audienceCount: 1,
    } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.READY,
    } as never);
    const prepared = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/prepare',
      headers: AUTH,
    });
    expect(prepared.statusCode).toBe(200);
    expect(prepared.json()).toEqual({
      data: { id: 'campaign-1', status: MarketingCampaignStatus.READY },
    });

    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'ESSENTIAL' } as never);
    const blocked = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/audience-preview',
      headers: AUTH,
      payload: { channel: 'SMS', segmentId: 'segment-1' },
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      error: 'CAPABILITY_NOT_INCLUDED',
      capability: 'marketing.campaigns',
    });
  });

  it('explique en français pourquoi une campagne vide ne se prépare pas', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.DRAFT,
      audienceCount: 0,
    } as never);
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/prepare',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'AUDIENCE_EMPTY',
      message: 'Aucun destinataire n’a donné son consentement : il n’y a rien à préparer.',
    });
  });

  it('explique en français qu’un envoi au-delà du reste du jour est refusé, sans rien lancer', async () => {
    process.env.MARKETING_SENDS_ENABLED = 'true';
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
      status: MarketingCampaignStatus.READY,
      channel: 'EMAIL',
      audienceCount: 41,
      scheduledAt: null,
    } as never);
    vi.mocked(db.campaignMessage.count).mockResolvedValue(0);
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/send',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'MARKETING_DAILY_BUDGET_EXCEEDED',
      message: expect.stringContaining('Audience trop grande pour aujourd’hui'),
    });
    expect(db.marketingCampaign.updateMany).not.toHaveBeenCalled();
    expect(queues.marketingCampaign.add).not.toHaveBeenCalled();
  });

  it('refuse une programmation au-delà du reste du jour d’envoi, sans la enregistrer', async () => {
    process.env.MARKETING_SENDS_ENABLED = 'true';
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
      status: MarketingCampaignStatus.READY,
      channel: 'EMAIL',
      audienceCount: 41,
      scheduledAt: null,
    } as never);
    vi.mocked(db.campaignMessage.count).mockResolvedValue(0);
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/schedule',
      headers: AUTH,
      payload: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'MARKETING_DAILY_BUDGET_EXCEEDED',
      message: expect.stringContaining('Audience trop grande pour ce jour-là'),
    });
    expect(db.marketingCampaign.update).not.toHaveBeenCalled();
    expect(queues.marketingCampaign.add).not.toHaveBeenCalled();
  });

  it('refuse une règle sans lien de désinscription avec un message lisible, pas une erreur 500', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'PUT',
      url: '/marketing/automations/DORMANT',
      headers: AUTH,
      payload: {
        enabled: true,
        channel: 'SMS',
        config: { bodyTemplate: 'Bonjour {{customer.firstName}}, vous nous manquez.' },
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'INVALID_AUTOMATION',
      message:
        'Le message doit contenir {{unsubscribeUrl}} : le lien de désinscription est obligatoire.',
    });
    expect(db.marketingAutomation.upsert).not.toHaveBeenCalled();
  });

  it('refuse une règle e-mail sans objet et un fuseau horaire inconnu', async () => {
    const app = await getApp();
    const noSubject = await app.inject({
      method: 'PUT',
      url: '/marketing/automations/DORMANT',
      headers: AUTH,
      payload: {
        enabled: false,
        channel: 'EMAIL',
        config: { bodyTemplate: 'Bonjour {{unsubscribeUrl}}' },
      },
    });
    expect(noSubject.statusCode).toBe(400);
    expect(noSubject.json().message).toBe('Indiquez un objet pour l’e-mail.');

    const badZone = await app.inject({
      method: 'PUT',
      url: '/marketing/automations/DORMANT',
      headers: AUTH,
      payload: {
        enabled: false,
        channel: 'SMS',
        config: { bodyTemplate: 'Bonjour {{unsubscribeUrl}}', timezone: 'Paris/France' },
      },
    });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json().message).toBe(
      'Le fuseau horaire n’est pas valide. Exemple : Europe/Paris.',
    );
  });

  it('returns a rendered campaign preview without creating provider messages', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      name: 'Relance déjeuner',
      objective: 'Remplir le service',
      channel: 'SMS',
      status: MarketingCampaignStatus.DRAFT,
      subject: null,
      bodyTemplate:
        'Bonjour {{customer.firstName}}, réservez {{reservationLink}} {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceCount: 2,
      restaurant: { name: 'Chez Suppernote' },
    } as never);
    vi.mocked(db.campaignAudienceMember.findMany).mockResolvedValue([
      { customerId: 'customer-1' },
    ] as never);
    vi.mocked(db.customer.findFirst).mockResolvedValue({ name: 'Alice Martin' } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/preview',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        campaign: { id: 'campaign-1', channel: 'SMS' },
        audience: { captured: 2, sampleCustomer: 'Alice Martin' },
        render: { body: expect.stringContaining('Bonjour Alice') },
        usage: { category: 'SMS_SEGMENTS', totalUnits: 2 },
        costEstimate: { status: 'NOT_AVAILABLE' },
      },
    });
    expect(db.campaignMessage.createMany).not.toHaveBeenCalled();
  });

  it('exposes a manager test as an explicit dry-run while sends are frozen', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      name: 'Test gérant',
      objective: 'Contrôle',
      channel: 'EMAIL',
      status: MarketingCampaignStatus.DRAFT,
      subject: 'Aperçu',
      bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceCount: 1,
      restaurant: { name: 'Chez Suppernote' },
    } as never);
    vi.mocked(db.campaignAudienceMember.findMany).mockResolvedValue([]);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/test',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      data: {
        mode: 'DRY_RUN',
        providerContacted: false,
        recipient: 'MANAGER',
        reason: 'PROVIDER_TEST_NOT_WIRED',
        preview: { render: { subject: 'Aperçu' } },
      },
    });
    expect(db.campaignMessage.create).not.toHaveBeenCalled();
  });

  it('modifie le contenu d’un brouillon et refuse de défiger un snapshot READY', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
      name: 'Ancienne campagne',
      objective: 'Ancien objectif',
      channel: 'SMS',
      status: MarketingCampaignStatus.DRAFT,
      subject: null,
      bodyTemplate: 'Ancien {{unsubscribeUrl}}',
      scheduledAt: null,
      timezone: 'Europe/Paris',
      audienceVersion: 1,
      audienceCount: 1,
      segmentId: 'segment-1',
    } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      name: 'Nouvelle campagne',
      status: MarketingCampaignStatus.DRAFT,
    } as never);

    const updated = await app.inject({
      method: 'PATCH',
      url: '/marketing/campaigns/campaign-1',
      headers: AUTH,
      payload: {
        name: 'Nouvelle campagne',
        bodyTemplate: 'Bonjour {{customer.firstName}} {{unsubscribeUrl}}',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toEqual({
      data: expect.objectContaining({ id: 'campaign-1', name: 'Nouvelle campagne' }),
    });

    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValueOnce({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
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
    const frozen = await app.inject({
      method: 'PATCH',
      url: '/marketing/campaigns/campaign-1',
      headers: AUTH,
      payload: { channel: 'EMAIL', subject: 'Objet' },
    });
    expect(frozen.statusCode).toBe(409);
    expect(frozen.json()).toEqual({ error: 'CAMPAIGN_AUDIENCE_FROZEN' });
  });

  it('télécharge le rapport CSV agrégé avec un content-disposition', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      name: 'Relance déjeuner',
      channel: 'SMS',
      status: MarketingCampaignStatus.SENT,
      audienceCount: 1,
      createdAt: new Date('2026-09-01T10:00:00.000Z'),
      completedAt: new Date('2026-09-01T10:05:00.000Z'),
    } as never);
    vi.mocked(db.campaignAudienceMember.findMany).mockResolvedValue([
      { customerId: 'c1' },
    ] as never);
    vi.mocked(db.campaignMessage.findMany).mockResolvedValue([
      { id: 'message-1', status: 'DELIVERED' },
    ] as never);
    vi.mocked(db.marketingAttributionLink.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingConversion.findMany).mockResolvedValue([]);
    vi.mocked(db.marketingPermissionEvent.findMany).mockResolvedValue([]);

    const response = await app.inject({
      method: 'GET',
      url: '/marketing/campaigns/campaign-1/report.csv',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('suppernote-campaign-campaign-1.csv');
    expect(response.body).toContain('"delivery_delivered","1"');
    expect(response.body).not.toContain('c1');
  });

  it('creates a signed attribution link and keeps the public click response opaque', async () => {
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({ id: 'campaign-1' } as never);
    vi.mocked(db.customer.findFirst).mockResolvedValue({ id: 'customer-1' } as never);
    vi.mocked(db.marketingAttributionLink.upsert).mockResolvedValue({
      id: 'link-1',
      campaignId: 'campaign-1',
      customerId: 'customer-1',
      expiresAt: new Date('2026-09-20T12:00:00.000Z'),
    } as never);

    const created = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/attribution-links',
      headers: AUTH,
      payload: { customerId: 'customer-1', expiresAt: '2026-09-20T12:00:00.000Z' },
    });
    expect(created.statusCode).toBe(201);
    const token = created.json().data.token as string;
    expect(token).toMatch(/^v1\./);
    expect(created.json().data).not.toHaveProperty('phone');

    const click = await app.inject({
      method: 'POST',
      url: '/marketing/attribution/click',
      payload: { token: `${token}tampered` },
    });
    expect(click.statusCode).toBe(400);
    expect(click.json()).toEqual({ error: 'INVALID_ATTRIBUTION_TOKEN' });
  });

  it('refuse le lancement tant que le flag fournisseur reste désactivé', async () => {
    delete process.env.MARKETING_SENDS_ENABLED;
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/send',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'MARKETING_SENDS_DISABLED' });
    expect(queues.marketingCampaign.add).not.toHaveBeenCalled();
  });

  it('programme une campagne READY dans la file avec un délai borné', async () => {
    process.env.MARKETING_SENDS_ENABLED = 'true';
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
      status: MarketingCampaignStatus.READY,
    } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.SCHEDULED,
    } as never);
    const scheduledAt = new Date(Date.now() + 60_000);
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/schedule',
      headers: AUTH,
      payload: { scheduledAt: scheduledAt.toISOString() },
    });
    expect(response.statusCode).toBe(200);
    expect(queues.marketingCampaign.add).toHaveBeenCalledWith(
      'send-campaign',
      { campaignId: 'campaign-1', restaurantId: 'test-rest-1' },
      expect.objectContaining({
        jobId: 'marketing-campaign-campaign-1',
        delay: expect.any(Number),
      }),
    );
  });

  it('marque la campagne en échec si l enqueue Redis est ambigu', async () => {
    process.env.MARKETING_SENDS_ENABLED = 'true';
    const app = await getApp();
    vi.mocked(db.marketingCampaign.findFirst).mockResolvedValue({
      id: 'campaign-1',
      restaurantId: 'test-rest-1',
      status: MarketingCampaignStatus.READY,
      scheduledAt: null,
    } as never);
    vi.mocked(db.marketingCampaign.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.marketingCampaign.update).mockResolvedValue({
      id: 'campaign-1',
      status: MarketingCampaignStatus.FAILED,
    } as never);
    vi.mocked(queues.marketingCampaign.add).mockRejectedValueOnce(new Error('redis unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/campaigns/campaign-1/send',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN' });
    expect(db.marketingCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MarketingCampaignStatus.FAILED,
          lastErrorCode: 'MARKETING_QUEUE_ENQUEUE_UNKNOWN',
        }),
      }),
    );
  });

  describe('désinscription publique', () => {
    async function unsubscribeToken(): Promise<string> {
      vi.mocked(db.customer.findFirst).mockResolvedValue({ id: 'customer-1' } as never);
      const { createMarketingUnsubscribeToken } = await import('../marketing-unsubscribe.service');
      return createMarketingUnsubscribeToken({
        restaurantId: 'test-rest-1',
        customerId: 'customer-1',
        channel: 'EMAIL',
      });
    }

    function mockWithdrawal() {
      vi.mocked(db.customer.findFirst).mockResolvedValue({
        id: 'customer-1',
        emailNormalized: 'client@example.test',
      } as never);
      vi.mocked(db.customer.findUnique).mockResolvedValue({ restaurantId: 'test-rest-1' } as never);
      vi.mocked(db.marketingPermission.upsert).mockResolvedValue({
        id: 'permission-1',
        customerId: 'customer-1',
        channel: 'EMAIL',
        status: MarketingPermissionStatus.OPTED_OUT,
      } as never);
      vi.mocked(db.marketingPermissionEvent.create).mockResolvedValue({ id: 'event-1' } as never);
    }

    it('formulaire navigateur : 503 invitant à réessayer, sans confirmer, quand le registre échoue', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      mockWithdrawal();
      vi.mocked(db.marketingOptOut.upsert).mockRejectedValueOnce(new Error('database unavailable'));
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/unsubscribe',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        payload: `token=${encodeURIComponent(token)}`,
      });
      expect(response.statusCode).toBe(503);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Veuillez réessayer');
      expect(response.body).not.toContain('Vous êtes désinscrit');
      expect(db.marketingPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ status: MarketingPermissionStatus.OPTED_OUT }),
        }),
      );
    });

    it('client JSON : 503 MARKETING_OPTOUT_REGISTER_UNAVAILABLE quand le registre échoue', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      mockWithdrawal();
      vi.mocked(db.marketingOptOut.upsert).mockRejectedValueOnce(new Error('database unavailable'));
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/unsubscribe',
        payload: { token },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'MARKETING_OPTOUT_REGISTER_UNAVAILABLE' });
    });

    it('un GET affiche une confirmation sans désinscrire (anti-virus, aperçus de lien)', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      vi.mocked(db.marketingPermission.upsert).mockClear();

      const response = await app.inject({
        method: 'GET',
        url: `/marketing/unsubscribe?token=${token}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.body).toContain('Me désinscrire');
      expect(response.body).toContain(`value="${token}"`);
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });

    it('un GET avec un jeton falsifié affiche une page lisible, sans rien modifier', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();

      const response = await app.inject({
        method: 'GET',
        url: `/marketing/unsubscribe?token=${token}x`,
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Ce lien n’est plus valide');
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });

    it('le formulaire du navigateur désinscrit et confirme en français', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      mockWithdrawal();

      const response = await app.inject({
        method: 'POST',
        url: '/marketing/unsubscribe',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        payload: `token=${encodeURIComponent(token)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/html');
      expect(response.body).toContain('Vous êtes désinscrit');
      expect(response.body).toContain('par e-mail');
      expect(db.marketingPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            channel: 'EMAIL',
            status: MarketingPermissionStatus.OPTED_OUT,
            source: 'UNSUBSCRIBE_LINK',
          }),
        }),
      );
    });

    it('le « un clic » de la messagerie (jeton dans l’URL, corps de formulaire) désinscrit', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      mockWithdrawal();

      const response = await app.inject({
        method: 'POST',
        url: `/marketing/unsubscribe?token=${encodeURIComponent(token)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: { unsubscribed: true, channel: 'EMAIL' } });
      expect(db.marketingPermission.upsert).toHaveBeenCalledTimes(1);
    });

    it('le corps JSON reste accepté et un jeton invalide est refusé', async () => {
      const app = await getApp();
      const token = await unsubscribeToken();
      mockWithdrawal();

      const ok = await app.inject({
        method: 'POST',
        url: '/marketing/unsubscribe',
        payload: { token },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ data: { unsubscribed: true, channel: 'EMAIL' } });

      vi.mocked(db.marketingPermission.upsert).mockClear();
      const bad = await app.inject({
        method: 'POST',
        url: '/marketing/unsubscribe',
        payload: { token: `${token}x` },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json()).toEqual({ error: 'INVALID_UNSUBSCRIBE_TOKEN' });
      const missing = await app.inject({ method: 'POST', url: '/marketing/unsubscribe' });
      expect(missing.statusCode).toBe(400);
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });
  });

  describe('consentement depuis la confirmation', () => {
    const CONSENT_FORM = 'application/x-www-form-urlencoded';
    const CHECKBOX = '<input type="checkbox" name="consent" value="on">';

    beforeEach(() => {
      process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(48);
      process.env.MARKETING_OPTOUT_HASH_SECRET = 'o'.repeat(48);
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        name: 'Chez Suppernote',
        plan: 'PRO',
      } as never);
      vi.mocked(db.customer.findFirst).mockResolvedValue({
        id: 'customer-1',
        emailNormalized: 'client@example.com',
      } as never);
      vi.mocked(db.marketingPermission.findFirst).mockResolvedValue(null);
      vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([]);
      vi.mocked(db.marketingPermission.upsert).mockResolvedValue({
        id: 'permission-1',
        customerId: 'customer-1',
        channel: 'EMAIL',
        status: MarketingPermissionStatus.OPTED_IN,
      } as never);
    });

    async function consentToken(): Promise<string> {
      vi.mocked(db.reservation.findFirst).mockResolvedValue({
        id: 'reservation-1',
        customerEmail: 'client@example.com',
      } as never);
      const { createMarketingConsentToken } = await import('../marketing-unsubscribe.service');
      return createMarketingConsentToken({
        restaurantId: 'test-rest-1',
        customerId: 'customer-1',
        reservationId: 'reservation-1',
      });
    }

    function consentPost(token: string, consent: boolean) {
      return {
        method: 'POST' as const,
        url: '/marketing/consent',
        headers: { 'content-type': CONSENT_FORM, accept: 'text/html' },
        payload: `token=${encodeURIComponent(token)}${consent ? '&consent=on' : ''}`,
      };
    }

    it('le GET montre la case non cochée sans rien enregistrer', async () => {
      const app = await getApp();
      const token = await consentToken();

      const response = await app.inject({
        method: 'GET',
        url: `/marketing/consent?token=${token}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(CHECKBOX);
      expect(response.body).toContain('les offres et actualités du restaurant Chez Suppernote');
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });

    it('un POST sans case cochée n’enregistre rien', async () => {
      const app = await getApp();
      const token = await consentToken();

      const response = await app.inject(consentPost(token, false));

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('Aucune case cochée');
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });

    it('une case cochée enregistre l’accord une seule fois', async () => {
      const app = await getApp();
      const token = await consentToken();

      const first = await app.inject(consentPost(token, true));
      expect(first.statusCode).toBe(200);
      expect(first.body).toContain('Merci');
      expect(db.marketingPermission.upsert).toHaveBeenCalledTimes(1);
      expect(db.marketingPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            status: MarketingPermissionStatus.OPTED_IN,
            source: 'CONFIRMATION_EMAIL',
            proofVersion: MARKETING_CONSENT_VERSION,
          }),
        }),
      );

      // Second envoi (double clic, rechargement) : l'accord existe, rien n'est réécrit.
      vi.mocked(db.marketingPermission.findFirst).mockResolvedValue({
        status: MarketingPermissionStatus.OPTED_IN,
      } as never);
      const second = await app.inject(consentPost(token, true));
      expect(second.statusCode).toBe(200);
      expect(second.body).toContain('déjà inscrit');
      expect(db.marketingPermission.upsert).toHaveBeenCalledTimes(1);
    });

    it('refuse un jeton expiré ou falsifié, sans rien enregistrer', async () => {
      const app = await getApp();
      const token = await consentToken();

      vi.setSystemTime(new Date(NOW.getTime() + 31 * 86_400_000));
      const expired = await app.inject(consentPost(token, true));
      expect(expired.statusCode).toBe(400);
      expect(expired.body).toContain('Ce lien n’est plus valide');

      vi.setSystemTime(NOW);
      const forged = await app.inject(consentPost(`${token}x`, true));
      expect(forged.statusCode).toBe(400);
      expect(db.marketingPermission.upsert).not.toHaveBeenCalled();
    });
  });
});

describe('remplissage de service (routes)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'PRO' } as never);
  });

  const SERVICE_BODY = { date: '2026-11-04', service: 'midi', channel: 'SMS' };
  const DRAFT_BODY = {
    ...SERVICE_BODY,
    bodyTemplate: 'Bonjour {{customer.firstName}}, réservez {{reservationLink}} {{unsubscribeUrl}}',
  };

  it('renvoie l’aperçu du moteur sans rien écrire ni contacter un fournisseur', async () => {
    const app = await getApp();
    vi.mocked(previewServiceFill).mockResolvedValue({
      status: 'PLANNED',
      full: false,
      audience: 30,
      holdout: 3,
      sends: 27,
    } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service/preview',
      headers: AUTH,
      payload: SERVICE_BODY,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: { status: 'PLANNED', holdout: 3 } });
    expect(previewServiceFill).toHaveBeenCalledWith({
      restaurantId: 'test-rest-1',
      ...SERVICE_BODY,
    });
    expect(createServiceFillDraft).not.toHaveBeenCalled();
    expect(queues.marketingCampaign.add).not.toHaveBeenCalled();
  });

  it('refuse une date ou un service invalides', async () => {
    const app = await getApp();
    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service/preview',
      headers: AUTH,
      payload: { ...SERVICE_BODY, service: 'nuit' },
    });
    expect(response.statusCode).toBe(400);
    expect(previewServiceFill).not.toHaveBeenCalled();
  });

  it('crée le brouillon et renvoie son id, sans envoi', async () => {
    const app = await getApp();
    vi.mocked(createServiceFillDraft).mockResolvedValue({
      plan: { status: 'PLANNED' },
      campaign: {
        id: 'campaign-fill-1',
        status: MarketingCampaignStatus.DRAFT,
        audienceCount: 27,
        targetServiceStart: new Date('2026-11-03T23:00:00.000Z'),
        targetServiceEnd: new Date('2026-11-04T15:00:00.000Z'),
      },
    } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service',
      headers: AUTH,
      payload: DRAFT_BODY,
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      data: expect.objectContaining({ id: 'campaign-fill-1', audienceCount: 27 }),
    });
    expect(queues.marketingCampaign.add).not.toHaveBeenCalled();
  });

  it.each([
    ['SERVICE_CLOSED', 409, 'FILL_SERVICE_CLOSED'],
    ['SERVICE_FULL', 409, 'FILL_SERVICE_FULL'],
    ['CAPACITY_UNKNOWN', 409, 'FILL_SERVICE_CAPACITY_UNKNOWN'],
    ['PLANNED', 409, 'FILL_SERVICE_NO_CANDIDATE'],
  ])('refuse un service %s sans brouillon (%i)', async (status, code, error) => {
    const app = await getApp();
    vi.mocked(createServiceFillDraft).mockResolvedValue({
      plan: { status },
      campaign: null,
    } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service',
      headers: AUTH,
      payload: DRAFT_BODY,
    });

    expect(response.statusCode).toBe(code);
    expect(response.json()).toMatchObject({ error });
  });

  it('budget nul → 409 FILL_SERVICE_BUDGET_EXHAUSTED', async () => {
    const app = await getApp();
    vi.mocked(createServiceFillDraft).mockResolvedValue({
      plan: { status: 'PLANNED', budgetExhausted: true, members: [] },
      campaign: null,
    } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service',
      headers: AUTH,
      payload: DRAFT_BODY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'FILL_SERVICE_BUDGET_EXHAUSTED' });
  });

  it('prévision à 0 → 409 FILL_SERVICE_NO_EMPTY_FORECAST', async () => {
    const app = await getApp();
    vi.mocked(createServiceFillDraft).mockResolvedValue({
      plan: { status: 'PLANNED', budgetExhausted: false, emptyPlaces: 0, members: [] },
      campaign: null,
    } as never);

    const response = await app.inject({
      method: 'POST',
      url: '/marketing/fill-service',
      headers: AUTH,
      payload: DRAFT_BODY,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'FILL_SERVICE_NO_EMPTY_FORECAST' });
  });

  it('refuse l’équipe de service et la lecture seule', async () => {
    const app = await getApp();
    for (const role of ['STAFF', 'READ_ONLY']) {
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/fill-service/preview',
        headers: { ...AUTH, 'x-test-site-role': role, 'x-test-enforce-role-policy': '1' },
        payload: SERVICE_BODY,
      });
      expect(response.statusCode).toBe(403);
    }
    expect(previewServiceFill).not.toHaveBeenCalled();
  });

  describe('suggestions de services creux', () => {
    const SUGGESTION = {
      date: '2026-11-04',
      service: 'soir',
      capacity: 40,
      freePlaces: 18,
      emptyPlaces: 14,
      forecastSource: 'historique',
    };

    it('refuse GET et POST sans la capability, 403', async () => {
      const app = await getApp();
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'ESSENTIAL' } as never);
      const list = await app.inject({
        method: 'GET',
        url: '/marketing/fill-suggestions',
        headers: AUTH,
      });
      const dismiss = await app.inject({
        method: 'POST',
        url: '/marketing/fill-suggestions/dismiss',
        headers: AUTH,
        payload: { date: '2026-11-04', service: 'soir' },
      });
      expect(list.statusCode).toBe(403);
      expect(dismiss.statusCode).toBe(403);
      expect(listFillSuggestions).not.toHaveBeenCalled();
      expect(dismissFillSuggestion).not.toHaveBeenCalled();
    });

    it('la réponse GET ne contient ni nom ni téléphone', async () => {
      const app = await getApp();
      vi.mocked(listFillSuggestions).mockResolvedValue([SUGGESTION] as never);
      const response = await app.inject({
        method: 'GET',
        url: '/marketing/fill-suggestions',
        headers: AUTH,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ data: [SUGGESTION] });
      expect(listFillSuggestions).toHaveBeenCalledWith({ restaurantId: 'test-rest-1' });
      expect(response.body).not.toMatch(/name|phone|email|customer/i);
    });

    it('POST dismiss ignore le service et répond 204', async () => {
      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/fill-suggestions/dismiss',
        headers: AUTH,
        payload: { date: '2026-11-04', service: 'soir' },
      });
      expect(response.statusCode).toBe(204);
      expect(dismissFillSuggestion).toHaveBeenCalledWith({
        restaurantId: 'test-rest-1',
        date: '2026-11-04',
        service: 'soir',
      });
    });

    it('POST dismiss : service invalide → 400', async () => {
      const app = await getApp();
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/fill-suggestions/dismiss',
        headers: AUTH,
        payload: { date: '2026-11-04', service: 'nuit' },
      });
      expect(response.statusCode).toBe(400);
      expect(dismissFillSuggestion).not.toHaveBeenCalled();
    });

    it('POST dismiss : Redis en panne → 503 DISMISS_UNAVAILABLE', async () => {
      const app = await getApp();
      vi.mocked(dismissFillSuggestion).mockRejectedValue(new Error('down'));
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/fill-suggestions/dismiss',
        headers: AUTH,
        payload: { date: '2026-11-04', service: 'soir' },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ error: 'DISMISS_UNAVAILABLE' });
    });

    it('POST /marketing/fill-service réussi appelle invalidateFillSuggestions', async () => {
      const app = await getApp();
      vi.mocked(createServiceFillDraft).mockResolvedValue({
        plan: { status: 'PLANNED' },
        campaign: {
          id: 'campaign-fill-2',
          status: MarketingCampaignStatus.DRAFT,
          audienceCount: 12,
          targetServiceStart: new Date('2026-11-04T15:00:00.000Z'),
          targetServiceEnd: new Date('2026-11-05T00:00:00.000Z'),
        },
      } as never);
      const response = await app.inject({
        method: 'POST',
        url: '/marketing/fill-service',
        headers: AUTH,
        payload: {
          date: '2026-11-04',
          service: 'soir',
          channel: 'SMS',
          bodyTemplate: 'Bonjour {{reservationLink}} {{unsubscribeUrl}}',
        },
      });
      expect(response.statusCode).toBe(201);
      expect(invalidateFillSuggestions).toHaveBeenCalledWith('test-rest-1');
    });
  });
});
