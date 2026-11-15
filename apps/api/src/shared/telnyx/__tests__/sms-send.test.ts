import { afterEach, describe, expect, it, vi } from 'vitest';
import telnyx, { sendSms } from '../client';
import { recordAcceptedMessagingUsage } from '../../../modules/usage/messaging-usage.service';

vi.mock('../../../modules/usage/messaging-usage.service', () => ({
  recordAcceptedMessagingUsage: vi.fn(),
}));

describe('SMS adapter error boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('routes SMS to Brevo only when SMS_PROVIDER=brevo', async () => {
    vi.stubEnv('SMS_PROVIDER', 'brevo');
    vi.stubEnv('BREVO_API_KEY', 'test-brevo-key-not-real');
    const create = vi.spyOn(telnyx.messages, 'create');
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ messageId: 77 }), { status: 201 }));
    await expect(sendSms('+33600000000', 'Fixture message')).resolves.toMatchObject({
      outcome: 'success',
      provider: 'brevo',
      providerMessageId: '77',
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it('uses a dedicated SMS sender without changing the voice sender', async () => {
    vi.stubEnv('TELNYX_SMS_FROM', 'SOKAR');
    vi.stubEnv('TELNYX_FROM_NUMBER', '+33100000000');
    const create = vi
      .spyOn(telnyx.messages, 'create')
      .mockResolvedValueOnce({ data: { id: 'receipt-1' } } as never);
    await sendSms('+33600000000', 'Fixture message');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ from: 'SOKAR' }));
    expect(process.env.TELNYX_FROM_NUMBER).toBe('+33100000000');
  });

  it('preserves the historical sender when the SMS sender is unset', async () => {
    vi.stubEnv('TELNYX_SMS_FROM', '');
    vi.stubEnv('TELNYX_FROM_NUMBER', '+33100000000');
    const create = vi
      .spyOn(telnyx.messages, 'create')
      .mockResolvedValueOnce({ data: { id: 'receipt-2' } } as never);
    await sendSms('+33600000000', 'Fixture message');
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ from: '+33100000000' }));
  });

  it('isolates staging delivery callbacks from the shared production profile', async () => {
    vi.stubEnv('TELNYX_SMS_WEBHOOK_URL', 'https://api-staging.suppernote.com/sms/telnyx/inbound');
    const create = vi
      .spyOn(telnyx.messages, 'create')
      .mockResolvedValueOnce({ data: { id: 'receipt-3' } } as never);
    await sendSms('+33600000000', 'Fixture message');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        webhook_url: 'https://api-staging.suppernote.com/sms/telnyx/inbound',
        use_profile_webhooks: false,
      }),
    );
  });

  it('sanitizes the actual adapter rejection without making a second request', async () => {
    const create = vi.spyOn(telnyx.messages, 'create').mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE_MESSAGE_BODY'), {
        statusCode: 400,
        responseBody: { errors: [{ code: '40305', detail: 'PRIVATE_PHONE_NUMBER' }] },
      }),
    );

    await expect(sendSms('+33600000000', 'Fixture message')).rejects.toMatchObject({
      name: 'TelnyxSmsSendError',
      message: 'Telnyx SMS send failed (HTTP 400, 40305)',
      notificationResult: 'failure_certain',
      providerErrorCodes: ['40305'],
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('keeps network failures ambiguous and never retries internally', async () => {
    const create = vi
      .spyOn(telnyx.messages, 'create')
      .mockRejectedValueOnce(Object.assign(new Error('PRIVATE_RECIPIENT'), { code: 'ECONNRESET' }));

    await expect(sendSms('+33600000000', 'Fixture message')).rejects.toMatchObject({
      message: 'Telnyx SMS send failed',
      notificationResult: 'unknown',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { data: { id: '   ' } }])(
    'does not report provider success without a usable receipt (%j)',
    async (response) => {
      const create = vi.spyOn(telnyx.messages, 'create').mockResolvedValueOnce(response as never);
      await expect(
        sendSms('+33600000000', 'Fixture message', {
          restaurantId: 'rest-1',
          sourceType: 'reservation_confirmation',
          sourceId: 'res-1',
        }),
      ).resolves.toMatchObject({
        outcome: 'unknown',
      });
      expect(create).toHaveBeenCalledTimes(1);
      expect(recordAcceptedMessagingUsage).not.toHaveBeenCalled();
    },
  );
});
