/**
 * Tests for the gift card reminder email function.
 *
 * On teste sendExpirationReminder (la logique métier extraite du worker)
 * plutôt que le worker BullMQ directement — le wiring BullMQ est trivial.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

vi.mock('../gift-card-email.service', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendExpirationReminder: actual.sendExpirationReminder,
    sendRefundNotificationSender: actual.sendRefundNotificationSender,
    sendRefundNotificationRestaurant: actual.sendRefundNotificationRestaurant,
  };
});

vi.mock('../../../shared/email', () => ({
  sendEmail: vi.fn().mockResolvedValue(undefined),
}));

import { sendEmail } from '../../../shared/email';

type EmailService = typeof import('../gift-card-email.service');
let sendExpirationReminder: EmailService['sendExpirationReminder'];
let sendRefundNotificationSender: EmailService['sendRefundNotificationSender'];
let sendRefundNotificationRestaurant: EmailService['sendRefundNotificationRestaurant'];

beforeAll(async () => {
  const mod = await import('../gift-card-email.service');
  sendExpirationReminder = mod.sendExpirationReminder;
  sendRefundNotificationSender = mod.sendRefundNotificationSender;
  sendRefundNotificationRestaurant = mod.sendRefundNotificationRestaurant;
});

const mockSendEmail = vi.mocked(sendEmail);

const REMINDER_DATA = {
  giftCardId: 'gc-1',
  code: 'gc_full_long_id_123',
  shortCode: 'SKR-TEST-01',
  amount: 100,
  remainingAmount: 75,
  restaurantName: 'Chez Suppernote',
  recipientName: 'Bob',
  recipientEmail: 'bob@example.com',
  expiresAt: new Date('2026-12-31'),
};

describe('gift-card-reminder: sendExpirationReminder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
  });

  it("envoie le rappel au destinataire avec le solde et la date d'expiration", async () => {
    await sendExpirationReminder(REMINDER_DATA);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(call.to).toBe('bob@example.com');
    expect(call.subject).toBe('Votre carte cadeau Chez Suppernote expire bientôt');
    expect(call.html).toContain('75€');
    expect(call.html).toContain('SKR-TEST-01');
    expect(call.html).toContain('Chez Suppernote');
    expect(call.html).toContain('Bob');
  });

  it('utilise le code long en fallback si shortCode est null', async () => {
    await sendExpirationReminder({ ...REMINDER_DATA, shortCode: null });
    const call = mockSendEmail.mock.calls[0]?.[0] as { html: string };
    expect(call.html).toContain('gc_full_long_id_123');
  });

  it("omet le nom du destinataire s'il est null", async () => {
    await sendExpirationReminder({ ...REMINDER_DATA, recipientName: null });
    const call = mockSendEmail.mock.calls[0]?.[0] as { html: string };
    expect(call.html).toContain('Bonjour,');
    expect(call.html).not.toContain('Bonjour Bob');
  });

  it("rethrow l'erreur si sendEmail échoue", async () => {
    mockSendEmail.mockRejectedValueOnce(new Error('SMTP down'));
    await expect(sendExpirationReminder(REMINDER_DATA)).rejects.toThrow('SMTP down');
  });
});

describe('gift-card-reminder: refund notifications', () => {
  const REFUND_DATA = {
    giftCardId: 'gc-1',
    shortCode: 'SKR-TEST-01',
    code: 'gc_full_long_id_123',
    refundAmount: 50,
    restaurantName: 'Chez Suppernote',
    senderName: 'Alice',
    senderEmail: 'alice@example.com',
    restaurantEmail: 'manager@example.invalid',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSendEmail.mockResolvedValue(undefined);
  });

  it("envoie la notification de remboursement à l'expéditeur", async () => {
    await sendRefundNotificationSender(REFUND_DATA);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(call.to).toBe('alice@example.com');
    expect(call.subject).toBe('Remboursement carte cadeau Chez Suppernote');
    expect(call.html).toContain('50€');
    expect(call.html).toContain('SKR-TEST-01');
    expect(call.html).toContain('Alice');
  });

  it('skip si senderEmail est null', async () => {
    await sendRefundNotificationSender({ ...REFUND_DATA, senderEmail: null });
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('envoie la notification de remboursement au restaurateur', async () => {
    await sendRefundNotificationRestaurant(REFUND_DATA);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
    const call = mockSendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(call.to).toBe('manager@example.invalid');
    expect(call.subject).toBe('Carte cadeau annulée — Chez Suppernote');
    expect(call.html).toContain('50€');
    expect(call.html).toContain('SKR-TEST-01');
  });
});
