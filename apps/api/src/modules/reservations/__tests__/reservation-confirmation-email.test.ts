import type { PrismaClient } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotificationProviderRefusedError } from '../../../shared/queue/notification-idempotency';
import { marketingEmailConsentStatus } from '../../marketing/marketing-consent.service';
import {
  buildMarketingConsentUrl,
  createMarketingConsentToken,
} from '../../marketing/marketing-unsubscribe.service';
import {
  buildReservationConfirmationEmail,
  CONFIRMATION_EMAIL_SENT_EVENT,
  processReservationConfirmationEmail,
  type ReservationConfirmationEmailDependencies,
} from '../reservation-confirmation-email';

vi.mock('../../../shared/redis/client', () => ({ redisQueue: {} }));
vi.mock('../../../shared/queue/queues', () => ({ queues: { reconciliation: { add: vi.fn() } } }));
vi.mock('../../../shared/db/client', () => ({ db: {} }));
vi.mock('../../../shared/email', () => ({ sendEmail: vi.fn() }));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../marketing/marketing-consent.service', () => ({
  marketingEmailConsentStatus: vi.fn(),
}));
vi.mock('../../marketing/marketing-unsubscribe.service', () => ({
  createMarketingConsentToken: vi.fn(),
  buildMarketingConsentUrl: vi.fn(),
}));

const STARTS_AT = new Date('2099-10-27T18:30:00.000Z');
const ARGS = { reservationId: 'res-1', restaurantId: 'rest-1' };

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1',
    restaurantId: 'rest-1',
    customerId: 'cust-1',
    customerEmail: 'Client@Example.com',
    partySize: 2,
    status: 'CONFIRMED',
    state: 'CONFIRMED',
    channel: 'WEB',
    isTest: false,
    reservedAt: STARTS_AT,
    startsAt: STARTS_AT,
    createdAt: new Date('2099-10-01T10:00:00.000Z'),
    customerPhone: '+33612345678',
    restaurant: { name: 'Chez Suppernote', timezone: 'Europe/Paris' },
    ...overrides,
  };
}

function makeClaimStore() {
  const claims = new Map<string, string>();
  const set = vi.fn(
    async (key: string, value: string, _mode: 'EX', _seconds: number, existence?: 'NX') => {
      if (existence === 'NX' && claims.has(key)) return null;
      claims.set(key, value);
      return 'OK';
    },
  );
  const get = vi.fn(async (key: string) => claims.get(key) ?? null);
  const del = vi.fn(async (key: string) => {
    claims.delete(key);
    return 1;
  });
  const evalScript = vi.fn(
    async (_script: string, _keys: number, key: string, token: string, next: string) => {
      const current = claims.get(key);
      if (!current || !current.includes(`\"token\":\"${token}\"`)) return 0;
      if (next === '__DELETE__') claims.delete(key);
      else claims.set(key, next);
      return 1;
    },
  );
  return { set, get, del, eval: evalScript };
}

const ACCEPTED = {
  outcome: 'success',
  provider: 'resend',
  channel: 'email',
  providerMessageId: 're_1',
};

function makeDeps(row: unknown = reservation(), sendResult: unknown = ACCEPTED) {
  const sendEmail = vi.fn(
    async (_options: { to: string; subject: string; html: string }) => sendResult,
  );
  const dbMock = {
    reservation: { findFirst: vi.fn().mockResolvedValue(row) },
    reservationAuditLog: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  };
  const reconciliation = { add: vi.fn().mockResolvedValue({}) };
  const deps = {
    db: dbMock as unknown as PrismaClient,
    sendEmail: sendEmail as unknown as ReservationConfirmationEmailDependencies['sendEmail'],
    claimStore: makeClaimStore(),
    reconciliationQueue: reconciliation,
  } satisfies ReservationConfirmationEmailDependencies;
  return { deps, sendEmail, dbMock, reconciliation };
}

describe('confirmation e-mail after a web booking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(marketingEmailConsentStatus).mockResolvedValue('UNAVAILABLE');
    vi.mocked(createMarketingConsentToken).mockResolvedValue('token-1');
    vi.mocked(buildMarketingConsentUrl).mockReturnValue(
      'https://api.test/marketing/consent?token=token-1',
    );
  });

  it('sends a staff reservation confirmation', async () => {
    const { deps, sendEmail } = makeDeps(reservation({ channel: 'ADMIN' }));
    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('sent');
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('sends to the normalised address, without the consent line when it is not offered', async () => {
    const { deps, sendEmail, dbMock } = makeDeps();

    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('sent');

    const message = sendEmail.mock.calls[0][0];
    expect(message.to).toBe('client@example.com');
    expect(message.subject).toBe('Votre réservation au restaurant Chez Suppernote est confirmée');
    expect(message.html).not.toContain('/marketing/consent');
    expect(dbMock.reservationAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reservationId: 'res-1',
        event: CONFIRMATION_EMAIL_SENT_EVENT,
      }),
    });
  });

  it('adds the consent line with its link when the address may be offered', async () => {
    vi.mocked(marketingEmailConsentStatus).mockResolvedValue('OFFERABLE');
    const { deps, sendEmail } = makeDeps();

    await processReservationConfirmationEmail(ARGS, deps);

    expect(marketingEmailConsentStatus).toHaveBeenCalledWith({
      restaurantId: 'rest-1',
      customerId: 'cust-1',
      address: 'client@example.com',
    });
    expect(createMarketingConsentToken).toHaveBeenCalledWith({
      restaurantId: 'rest-1',
      customerId: 'cust-1',
      reservationId: 'res-1',
    });
    expect(sendEmail.mock.calls[0][0].html).toContain(
      'href="https://api.test/marketing/consent?token=token-1"',
    );
  });

  it('still sends the confirmation when the consent link cannot be built', async () => {
    vi.mocked(marketingEmailConsentStatus).mockResolvedValue('OFFERABLE');
    vi.mocked(createMarketingConsentToken).mockRejectedValueOnce(
      new Error('MARKETING_UNSUBSCRIBE_SECRET_NOT_CONFIGURED'),
    );
    const { deps, sendEmail } = makeDeps();

    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('sent');
    expect(sendEmail.mock.calls[0][0].html).not.toContain('/marketing/consent');
  });

  it.each([
    ['a channel other than WEB', { channel: 'PHONE' }],
    ['a test booking', { isTest: true }],
    ['a booking not yet confirmed', { state: 'PENDING' }],
    ['a booking without address', { customerEmail: null }],
    ['a booking whose slot has passed', { startsAt: new Date('2001-01-01T10:00:00.000Z') }],
  ])('sends nothing for %s', async (_label, overrides) => {
    const { deps, sendEmail, dbMock } = makeDeps(reservation(overrides));

    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('skipped');

    expect(sendEmail).not.toHaveBeenCalled();
    expect(dbMock.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it('does not send again a confirmation already audited', async () => {
    const { deps, sendEmail, dbMock } = makeDeps();
    dbMock.reservationAuditLog.findFirst.mockResolvedValueOnce({ id: 'audit-1' });

    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('skipped');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('holds one claim per reservation: a second attempt does not resend', async () => {
    const { deps, sendEmail } = makeDeps();

    await processReservationConfirmationEmail(ARGS, deps);
    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('skipped');

    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('lets BullMQ retry a certain provider refusal, without an audit trace', async () => {
    const { deps, dbMock } = makeDeps(reservation(), {
      outcome: 'failure_certain',
      provider: 'resend',
      channel: 'email',
    });

    await expect(processReservationConfirmationEmail(ARGS, deps)).rejects.toBeInstanceOf(
      NotificationProviderRefusedError,
    );
    expect(dbMock.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it('moves an unknown provider result to reconciliation instead of resending', async () => {
    const { deps, sendEmail, dbMock, reconciliation } = makeDeps(reservation(), {
      outcome: 'unknown',
      provider: 'resend',
      channel: 'email',
      providerMessageId: 're_1',
    });

    await expect(processReservationConfirmationEmail(ARGS, deps)).resolves.toBe('unknown');

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(reconciliation.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ provider: 'resend', channel: 'email', providerMessageId: 're_1' }),
      expect.objectContaining({ jobId: expect.any(String) }),
    );
    expect(dbMock.reservationAuditLog.create).not.toHaveBeenCalled();
  });
});

describe('confirmation e-mail content', () => {
  const base = {
    restaurantName: 'Chez <Suppernote>',
    date: 'mardi 27 octobre',
    time: '19:30',
    partySize: 2,
  };

  it('stays transactional and escapes the restaurant name', () => {
    const { html } = buildReservationConfirmationEmail(base);

    expect(html).toContain('Chez &lt;Suppernote&gt;');
    expect(html).toContain(
      'Vous avez réservé une table au restaurant <strong>Chez &lt;Suppernote&gt;</strong>',
    );
    expect(html).toContain('à <strong>19:30</strong>');
    expect(html).toContain('pour <strong>2 personnes</strong>');
    expect(html).not.toContain('offres');
  });

  it('shows the consent line only with its link', () => {
    const { html } = buildReservationConfirmationEmail({
      ...base,
      consentUrl: 'https://api.test/marketing/consent?token=t',
    });

    expect(html).toContain(
      'Recevoir les offres et actualités du restaurant Chez &lt;Suppernote&gt;',
    );
    expect(html).toContain('href="https://api.test/marketing/consent?token=t"');
  });

  it('offers the management link when the booking can be managed', () => {
    const withLink = buildReservationConfirmationEmail({
      ...base,
      managementUrl: 'https://api.test/manage/abc',
    });
    const withoutLink = buildReservationConfirmationEmail(base);

    expect(withLink.html).toContain('href="https://api.test/manage/abc"');
    expect(withoutLink.html).toContain('appelez le restaurant');
  });
});
