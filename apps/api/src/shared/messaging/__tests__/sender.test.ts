import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../telnyx/client', () => ({
  sendSms: vi.fn(),
}));
vi.mock('../../whatsapp/client', () => ({
  getWhatsAppProvider: vi.fn(() => 'telnyx'),
  isWhatsAppConfigured: vi.fn(),
  sendWhatsAppTemplate: vi.fn(),
}));
vi.mock('../../../modules/analytics/events.service', () => ({
  trackMessagingEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../logger/pino', () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { trackMessagingEvent } from '../../../modules/analytics/events.service';
import { logger } from '../../logger/pino';
import { sendReminder } from '../sender';
import {
  getWhatsAppProvider,
  isWhatsAppConfigured,
  sendWhatsAppTemplate,
} from '../../whatsapp/client';
import { sendSms } from '../../telnyx/client';
import {
  buildNotificationClaimKey,
  getNotificationClaim,
  type NotificationClaimStore,
  type NotificationReconciliationQueue,
} from '../../queue/notification-idempotency';

function makeClaimStore() {
  const values = new Map<string, string>();
  const store: NotificationClaimStore = {
    async set(key, value, _expirationMode, _expirationSeconds, existenceMode) {
      if (existenceMode === 'NX' && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) {
      return values.get(key) ?? null;
    },
    async del(key) {
      values.delete(key);
      return 1;
    },
    async eval(_script, _numberOfKeys, key, token, nextValue) {
      const raw = values.get(key);
      if (!raw || !(JSON.parse(raw) as { token?: string }).token) return 0;
      if ((JSON.parse(raw) as { token?: string }).token !== token) return 0;
      if (nextValue === '__DELETE__') values.delete(key);
      else values.set(key, nextValue);
      return 1;
    },
  };
  return { store, values };
}

function makeReconciliationQueue() {
  const jobIds = new Set<string>();
  const jobs: Array<{ name: string; data: unknown; jobId: string }> = [];
  const queue: NotificationReconciliationQueue = {
    async add(name, data, options) {
      if (jobIds.has(options.jobId)) return;
      jobIds.add(options.jobId);
      jobs.push({ name, data, jobId: options.jobId });
    },
  };
  return { queue, jobs };
}

const params = {
  to: '+33612345678',
  restaurantName: 'Chez Suppernote',
  restaurantId: 'rest-1',
  reservationId: 'res-1',
  customerId: 'customer-1',
  date: 'jeudi 2 juillet 2026',
  time: '19:00',
  partySize: 2,
  whatsappOptIn: true,
  reservationChannel: 'WEB',
};

describe('WhatsApp-only reservation reminders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWhatsAppProvider).mockReturnValue('telnyx');
    vi.mocked(isWhatsAppConfigured).mockReturnValue(true);
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      outcome: 'success',
      provider: 'telnyx',
      channel: 'whatsapp',
      providerMessageId: 'whatsapp-1',
    });
  });

  it.each([undefined, false])('skips without explicit agreement (%s)', async (whatsappOptIn) => {
    expect(await sendReminder({ ...params, whatsappOptIn })).toMatchObject({
      skipped: 'no_whatsapp_consent',
      success: false,
    });
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(sendSms).not.toHaveBeenCalled();
  });

  it.each(['PHONE', 'MCP', undefined])(
    'never reminds a non-web booking (%s)',
    async (reservationChannel) => {
      expect(await sendReminder({ ...params, reservationChannel })).toMatchObject({
        skipped: 'non_web_booking',
      });
      expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
      expect(sendSms).not.toHaveBeenCalled();
    },
  );

  it('skips unavailable WhatsApp without creating a claim or SMS', async () => {
    vi.mocked(isWhatsAppConfigured).mockReturnValue(false);
    const { store, values } = makeClaimStore();
    expect(await sendReminder(params, { claimStore: store })).toMatchObject({
      skipped: 'whatsapp_unavailable',
    });
    expect(values.size).toBe(0);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('deduplicates accepted WhatsApp reminders without sending SMS', async () => {
    const { store } = makeClaimStore();
    await sendReminder(params, { claimStore: store });
    expect(await sendReminder(params, { claimStore: store })).toMatchObject({
      success: true,
      channel: 'whatsapp',
    });
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
    expect(trackMessagingEvent).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'whatsapp', success: true }),
    );
  });

  it('retries an explicit refusal only on WhatsApp', async () => {
    vi.mocked(sendWhatsAppTemplate).mockResolvedValueOnce({
      outcome: 'failure_certain',
      provider: 'telnyx',
      channel: 'whatsapp',
    });
    const { store } = makeClaimStore();
    expect(await sendReminder(params, { claimStore: store })).toMatchObject({
      outcome: 'failure_certain',
      channel: 'whatsapp',
    });
    expect(
      await getNotificationClaim(
        store,
        buildNotificationClaimKey('reservation-reminder-whatsapp', params.reservationId),
      ),
    ).toBeNull();
    await sendReminder(params, { claimStore: store });
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(2);
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('never falls back to SMS after a thrown provider refusal', async () => {
    vi.mocked(sendWhatsAppTemplate).mockRejectedValue(
      Object.assign(new Error('provider refusal'), { statusCode: 400 }),
    );
    expect(await sendReminder(params)).toMatchObject({
      outcome: 'failure_certain',
      channel: 'whatsapp',
    });
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('preserves unknown Meta claims across a provider switch', async () => {
    vi.mocked(getWhatsAppProvider).mockReturnValue('meta');
    vi.mocked(sendWhatsAppTemplate).mockResolvedValue({
      provider: 'meta',
      channel: 'whatsapp',
      outcome: 'unknown',
      providerMessageId: 'wamid-unknown',
    });
    const { store } = makeClaimStore();
    const { queue, jobs } = makeReconciliationQueue();
    await sendReminder(params, { claimStore: store, reconciliationQueue: queue });
    vi.mocked(getWhatsAppProvider).mockReturnValue('telnyx');
    expect(
      await sendReminder(params, { claimStore: store, reconciliationQueue: queue }),
    ).toMatchObject({ provider: 'meta', outcome: 'unknown' });
    expect(sendWhatsAppTemplate).toHaveBeenCalledTimes(1);
    expect(sendSms).not.toHaveBeenCalled();
    expect(jobs).toHaveLength(1);
  });

  it('preserves a historical SMS unknown claim without sending either channel', async () => {
    const { store, values } = makeClaimStore();
    values.set(
      buildNotificationClaimKey('reservation-reminder-sms', params.reservationId),
      JSON.stringify({
        version: 1,
        status: 'unknown',
        provider: 'telnyx',
        channel: 'sms',
        updatedAt: new Date().toISOString(),
        providerMessageId: 'old-sms',
      }),
    );
    expect(await sendReminder(params, { claimStore: store })).toMatchObject({
      channel: 'sms',
      outcome: 'unknown',
    });
    expect(sendSms).not.toHaveBeenCalled();
    expect(sendWhatsAppTemplate).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
