import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

const statuses = vi.hoisted(() => new Map<string, number>());

vi.mock('../../../shared/brevo/sms-client', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../shared/brevo/sms-client')>();
  const rank = { sent: 1, delivery_failed: 2, delivered: 3 } as const;
  return {
    ...original,
    // Émulation en mémoire du script Redis (le rang ne fait que monter).
    storeBrevoSmsStatus: vi.fn(async (_store: unknown, id: string, status: keyof typeof rank) => {
      if (rank[status] <= (statuses.get(id) ?? 0)) return false;
      statuses.set(id, rank[status]);
      return true;
    }),
  };
});

vi.mock('../../marketing/marketing-provider.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../marketing/marketing-provider.service')>()),
  applyMarketingProviderEvent: vi.fn().mockResolvedValue({ matched: false, changed: false }),
}));

import { getApp, closeApp } from '../../../test/helpers';
import { applyMarketingProviderEvent } from '../../marketing/marketing-provider.service';
import { isValidBrevoWebhookToken } from '../brevo-sms-events.routes';

const SECRET = 'y'.repeat(40);
const mockApply = vi.mocked(applyMarketingProviderEvent);

describe('POST /sms/brevo/events', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    statuses.clear();
    process.env.BREVO_SMS_WEBHOOK_SECRET = SECRET;
    app = await getApp();
  });

  afterAll(async () => {
    delete process.env.BREVO_SMS_WEBHOOK_SECRET;
    await closeApp();
  });

  const post = (body: unknown, token: string | null = SECRET) =>
    app.inject({
      method: 'POST',
      url: token === null ? '/sms/brevo/events' : `/sms/brevo/events?token=${token}`,
      payload: body as object,
    });

  it('refuse un jeton absent ou faux', async () => {
    expect((await post({ messageId: 1, msg_status: 'delivered' }, null)).statusCode).toBe(401);
    expect((await post({ messageId: 1, msg_status: 'delivered' }, 'z'.repeat(40))).statusCode).toBe(
      401,
    );
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('503 tant que le secret n’est pas configuré', async () => {
    delete process.env.BREVO_SMS_WEBHOOK_SECRET;
    expect((await post({ messageId: 1, msg_status: 'delivered' })).statusCode).toBe(503);
  });

  it('compare le jeton sans dépendre de sa longueur', () => {
    expect(isValidBrevoWebhookToken(SECRET, SECRET)).toBe(true);
    expect(isValidBrevoWebhookToken('court', SECRET)).toBe(false);
    expect(isValidBrevoWebhookToken(undefined, SECRET)).toBe(false);
    expect(isValidBrevoWebhookToken(SECRET, undefined)).toBe(false);
  });

  it.each([
    ['sent', 'sent'],
    ['accepted', 'sent'],
    ['delivered', 'delivered'],
    ['soft_bounce', 'delivery_failed'],
    ['hard_bounce', 'delivery_failed'],
    ['rej', 'delivery_failed'],
    ['bl', 'delivery_failed'],
  ])('mappe %s sur %s', async (msgStatus, expected) => {
    const response = await post({
      messageId: 123,
      msg_status: msgStatus,
      to: '33612345678',
      error_code: 23,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ result: 'ok', applied: 1 });
    expect(mockApply).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'brevo',
        providerMessageId: '123',
        providerStatus: expected,
      }),
    );
  });

  it('ignore les événements qui ne sont pas des livraisons', async () => {
    const response = await post([
      { messageId: 5, msg_status: 'replied', reply: 'OUI' },
      { messageId: 0, msg_status: 'skip' },
    ]);
    expect(response.json()).toEqual({ result: 'ok', applied: 0 });
    expect(mockApply).not.toHaveBeenCalled();
  });

  it('idempotent : un doublon ou un échec après delivered ne change rien', async () => {
    const response = await post([
      { messageId: 9, msg_status: 'delivered' },
      { messageId: 9, msg_status: 'delivered' },
      { messageId: 9, msg_status: 'hard_bounce' },
    ]);
    expect(response.json()).toEqual({ result: 'ok', applied: 1 });
    expect(mockApply).toHaveBeenCalledTimes(1);
  });

  it('400 sur un corps invalide', async () => {
    expect((await post({ messageId: { bad: true } })).statusCode).toBe(400);
  });
});
