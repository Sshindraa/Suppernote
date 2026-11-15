import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../modules/usage/messaging-usage.service', () => ({
  recordAcceptedMessagingUsage: vi.fn().mockResolvedValue(undefined),
}));

import { recordAcceptedMessagingUsage } from '../../../modules/usage/messaging-usage.service';
import { classifyNotificationError } from '../../queue/notification-idempotency';
import {
  brevoSmsWebhookUrl,
  getSmsProvider,
  isBrevoMessageId,
  lookupBrevoSms,
  normalizeBrevoSmsEvent,
  sendBrevoSms,
  storeBrevoSmsStatus,
  type BrevoStatusStore,
} from '../sms-client';

// Valeurs factices : aucun secret réel dans les tests.
const FAKE_KEY = 'test-brevo-key-not-real';
const FAKE_SECRET = 'x'.repeat(40);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('sendBrevoSms', () => {
  beforeEach(() => {
    vi.stubEnv('BREVO_API_KEY', FAKE_KEY);
    vi.stubEnv('BREVO_SMS_SENDER', '');
    vi.stubEnv('BREVO_SMS_WEBHOOK_SECRET', FAKE_SECRET);
    vi.stubEnv('PUBLIC_API_URL', 'https://api-staging.example.test/');
    vi.mocked(recordAcceptedMessagingUsage).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('envoie le corps attendu et renvoie le messageId en succès', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { messageId: 1511882900100020 }));
    const result = await sendBrevoSms(
      '+33 6 12 34 56 78',
      'Bonjour',
      {
        restaurantId: 'r1',
        sourceType: 'reservation',
        sourceId: 's1',
      },
      fetchImpl,
    );

    expect(result).toEqual({
      outcome: 'success',
      provider: 'brevo',
      channel: 'sms',
      providerMessageId: '1511882900100020',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.brevo.com/v3/transactionalSMS/send');
    expect(init.headers['api-key']).toBe(FAKE_KEY);
    expect(JSON.parse(init.body)).toEqual({
      sender: 'Suppernote',
      recipient: '33612345678',
      content: 'Bonjour',
      type: 'transactional',
      tag: 'suppernote',
      webUrl: `https://api-staging.example.test/sms/brevo/events?token=${FAKE_SECRET}`,
      unicodeEnabled: false,
    });
    expect(recordAcceptedMessagingUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'brevo',
        channel: 'sms',
        providerMessageId: '1511882900100020',
      }),
    );
  });

  it('4xx : refus certain, message clair sans clé', async () => {
    for (const [status, label] of [
      [400, 'requete refusee'],
      [401, 'cle API refusee'],
      [402, 'credits SMS insuffisants'],
      [429, 'limite de debit atteinte'],
    ] as const) {
      const fetchImpl = vi
        .fn()
        .mockResolvedValue(jsonResponse(status, { code: 'x', message: 'raw' }));
      const error = await sendBrevoSms('+33612345678', 'x', undefined, fetchImpl).catch((e) => e);
      expect(error.message).toBe(`Brevo SMS send failed (HTTP ${status}, ${label})`);
      expect(error.message).not.toContain(FAKE_KEY);
      expect(error.message).not.toContain('612345678');
      expect(classifyNotificationError(error)).toBe('failure_certain');
    }
    expect(recordAcceptedMessagingUsage).not.toHaveBeenCalled();
  });

  it('5xx : inconnu, jamais de renvoi aveugle', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    const error = await sendBrevoSms('+33612345678', 'x', undefined, fetchImpl).catch((e) => e);
    expect(error.message).toBe('Brevo SMS send failed (HTTP 503, erreur Brevo)');
    expect(classifyNotificationError(error)).toBe('unknown');
  });

  it('timeout : inconnu', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fetchImpl = vi.fn().mockRejectedValue(timeout);
    const error = await sendBrevoSms('+33612345678', 'x', undefined, fetchImpl).catch((e) => e);
    expect(error.message).toBe('Brevo SMS send timed out');
    expect(classifyNotificationError(error)).toBe('unknown');
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('201 sans messageId : inconnu', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {}));
    await expect(sendBrevoSms('+33612345678', 'x', undefined, fetchImpl)).resolves.toMatchObject({
      outcome: 'unknown',
      provider: 'brevo',
    });
  });

  it('sans clé : refus certain avant tout appel', async () => {
    vi.stubEnv('BREVO_API_KEY', '');
    const fetchImpl = vi.fn();
    const error = await sendBrevoSms('+33612345678', 'x', undefined, fetchImpl).catch((e) => e);
    expect(classifyNotificationError(error)).toBe('failure_certain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sans secret de webhook : aucun webUrl', async () => {
    vi.stubEnv('BREVO_SMS_WEBHOOK_SECRET', '');
    expect(brevoSmsWebhookUrl()).toBeUndefined();
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { messageId: 1 }));
    await sendBrevoSms('+33612345678', 'x', undefined, fetchImpl);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).webUrl).toBeUndefined();
  });
});

describe('getSmsProvider', () => {
  it('Telnyx par défaut, Brevo seulement sur demande explicite', () => {
    expect(getSmsProvider({})).toBe('telnyx');
    expect(getSmsProvider({ SMS_PROVIDER: 'telnyx' })).toBe('telnyx');
    expect(getSmsProvider({ SMS_PROVIDER: 'BREVO ' })).toBe('brevo');
    expect(getSmsProvider({ SMS_PROVIDER: 'autre' })).toBe('telnyx');
  });
});

describe('statuts de livraison Brevo', () => {
  it.each([
    ['sent', 'sent'],
    ['accepted', 'sent'],
    ['delivered', 'delivered'],
    ['soft_bounce', 'delivery_failed'],
    ['hard_bounce', 'delivery_failed'],
    ['rej', 'delivery_failed'],
    ['bl', 'delivery_failed'],
    ['skip', 'delivery_failed'],
    ['replied', null],
    ['unsubscribed', null],
    [undefined, null],
  ])('%s → %s', (input, expected) => {
    expect(normalizeBrevoSmsEvent(input)).toBe(expected);
  });

  function memoryStore(): BrevoStatusStore {
    const data = new Map<string, string>();
    return {
      get: async (key) => data.get(key) ?? null,
      // Même règle que le script Lua : le rang ne fait que monter.
      eval: async (_script, _keys, key, rank) => {
        const current = Number(data.get(String(key)) ?? 0);
        if (Number(rank) > current) {
          data.set(String(key), String(rank));
          return 1;
        }
        return 0;
      },
    };
  }

  it('idempotent et un échec tardif n’efface pas un delivered', async () => {
    const store = memoryStore();
    expect(await storeBrevoSmsStatus(store, '42', 'sent')).toBe(true);
    expect(await storeBrevoSmsStatus(store, '42', 'sent')).toBe(false);
    expect(await storeBrevoSmsStatus(store, '42', 'delivered')).toBe(true);
    expect(await storeBrevoSmsStatus(store, '42', 'delivery_failed')).toBe(false);
    expect(await lookupBrevoSms(store, '42')).toBe('success');
  });

  it('échec de livraison ou statut absent : inconnu (relecture)', async () => {
    const store = memoryStore();
    await storeBrevoSmsStatus(store, '7', 'delivery_failed');
    expect(await lookupBrevoSms(store, '7')).toBe('unknown');
    expect(await lookupBrevoSms(store, '8')).toBe('unknown');
  });

  it('distingue les identifiants Brevo des UUID Telnyx', () => {
    expect(isBrevoMessageId('1511882900100020')).toBe(true);
    expect(isBrevoMessageId('40385f64-5717-4562-b3fc-2c963f66afa6')).toBe(false);
  });
});
