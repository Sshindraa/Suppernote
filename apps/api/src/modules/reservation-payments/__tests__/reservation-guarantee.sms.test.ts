import { Prisma, ReservationPaymentStatus, type PrismaClient } from '@prisma/client';
import type { Job } from 'bullmq';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const claims = vi.hoisted(() => ({
  acquire: vi.fn(),
  record: vi.fn(),
}));
vi.mock('../../../shared/queue/notification-idempotency', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  acquireNotificationClaim: claims.acquire,
  recordNotificationResult: claims.record,
}));

import { db } from '../../../shared/db/client';
import { queues } from '../../../shared/queue/queues';
import {
  enqueueCardGuaranteeSms,
  enqueueConfirmationAfterCardGuarantee,
  processCardGuaranteeSmsJob,
  type CardGuaranteeSmsJobData,
} from '../reservation-guarantee.sms';
import {
  requestCardGuaranteeByStaff,
  resendCardGuaranteeLink,
} from '../reservation-guarantee.staff';

const PAYMENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = new Date('2026-11-13T10:00:00.000Z');
const CLAIM_TOKEN = ['claim', 'test'].join('-');

function job(name: string, nonce = 'first'): Job<CardGuaranteeSmsJobData> {
  return { name, data: { paymentId: PAYMENT_ID, restaurantId: 'rest-1', nonce } } as never;
}

function paymentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYMENT_ID,
    restaurantId: 'rest-1',
    status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
    amount: new Prisma.Decimal('80.00'),
    expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    reservation: {
      state: 'PENDING',
      customerPhone: '+33600000000',
      partySize: 4,
      startsAt: new Date('2026-11-20T18:30:00.000Z'),
      reservedAt: new Date('2026-11-20T18:30:00.000Z'),
      restaurant: { name: 'Chez Test', slug: 'chez-test', timezone: 'Europe/Paris' },
    },
    ...overrides,
  };
}

describe('SMS de l’empreinte bancaire', () => {
  const sendSms = vi.fn();
  const deps = () => ({
    db: db as unknown as PrismaClient,
    sendSms,
    claimStore: {} as never,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'c'.repeat(64));
    vi.stubEnv('DASHBOARD_URL', 'https://suppernote.test');
    claims.acquire.mockResolvedValue({ acquired: true, token: CLAIM_TOKEN });
    claims.record.mockResolvedValue(true);
    sendSms.mockResolvedValue({ outcome: 'accepted', providerMessageId: 'msg-1' });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('envoie le lien signé, le montant maximal et l’heure limite', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(paymentRow() as never);

    await processCardGuaranteeSmsJob(job('card-guarantee-link'), deps());

    const [to, text] = sendSms.mock.calls[0]!;
    expect(to).toBe('+33600000000');
    expect(text).toMatch(
      /^Chez Test : pour confirmer votre table du 20\/11\/2026 à 19h30 \(4 pers\.\)/,
    );
    expect(text).toMatch(
      /https:\/\/suppernote\.test\/garantie\?r=chez-test&t=[0-9a-f]{32}\.[\w-]{43}/,
    );
    expect(text).toContain('Aucun montant n’est débité aujourd’hui (jusqu’à 80 €');
    expect(text).toContain('Sans carte avant 13h00, la table sera libérée.');
    expect(claims.acquire).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['carte déjà enregistrée', { status: ReservationPaymentStatus.AUTHORIZED }],
    ['délai passé', { expiresAt: new Date('2026-11-13T09:59:00.000Z') }],
  ])('n’envoie pas de lien : %s', async (_label, overrides) => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(paymentRow(overrides) as never);
    await processCardGuaranteeSmsJob(job('card-guarantee-link'), deps());
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('prévient que la table est libérée à l’expiration', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(
      paymentRow({
        status: ReservationPaymentStatus.EXPIRED,
        reservation: { ...paymentRow().reservation, state: 'EXPIRED' },
      }) as never,
    );
    await processCardGuaranteeSmsJob(job('card-guarantee-expired'), deps());
    expect(sendSms.mock.calls[0]![1]).toContain('n’est pas confirmée et la table a été libérée');
  });

  it('ne renvoie pas un SMS déjà parti', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(paymentRow() as never);
    claims.acquire.mockResolvedValue({ acquired: false });
    await processCardGuaranteeSmsJob(job('card-guarantee-link'), deps());
    expect(sendSms).not.toHaveBeenCalled();
  });

  it('confirme par SMS une réservation vocale, pas une réservation web', async () => {
    vi.mocked(db.reservation.findFirst).mockResolvedValueOnce({
      id: 'res-voice',
      channel: 'PHONE',
      customerPhone: '+33600000000',
    } as never);
    await enqueueConfirmationAfterCardGuarantee(db as never, {
      id: 'res-voice',
      restaurantId: 'rest-1',
    });
    vi.mocked(db.reservation.findFirst).mockResolvedValueOnce({
      id: 'res-web',
      channel: 'WEB',
      customerPhone: '+33600000000',
    } as never);
    await enqueueConfirmationAfterCardGuarantee(db as never, {
      id: 'res-web',
      restaurantId: 'rest-1',
    });

    expect(queues.smsClient.add).toHaveBeenCalledTimes(1);
    expect(queues.smsClient.add).toHaveBeenCalledWith(
      'client-confirm',
      { reservationId: 'res-voice' },
      expect.objectContaining({ jobId: expect.stringContaining('res-voice') }),
    );
  });

  it('distingue un renvoi de l’équipe d’une relivraison', async () => {
    await enqueueCardGuaranteeSms('link', { id: PAYMENT_ID, restaurantId: 'rest-1' });
    await enqueueCardGuaranteeSms('link', { id: PAYMENT_ID, restaurantId: 'rest-1' }, '42');
    const ids = vi.mocked(queues.smsClient.add).mock.calls.map(([, , options]) => options?.jobId);
    expect(ids).toEqual([
      `card-guarantee_link_${PAYMENT_ID}_first`,
      `card-guarantee_link_${PAYMENT_ID}_42`,
    ]);
  });
});

describe('gestes de l’équipe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('RESERVATION_MANAGEMENT_SECRET', 'c'.repeat(64));
    vi.stubEnv('DASHBOARD_URL', 'https://suppernote.test');
    vi.mocked(db.reservation.findFirst).mockResolvedValue({
      id: 'res-1',
      state: 'CONFIRMED',
      partySize: 4,
      startsAt: new Date('2026-11-20T18:30:00.000Z'),
      reservedAt: new Date('2026-11-20T18:30:00.000Z'),
      customerPhone: '+33600000000',
      restaurant: { slug: 'chez-test', giftCardStripeAccountId: 'acct_resto' },
    } as never);
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue(null);
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue({ id: 'policy-1' } as never);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('demande une empreinte par SMS, 24 h au plus', async () => {
    vi.mocked(db.$transaction).mockImplementationOnce(async () => PAYMENT_ID);
    await expect(
      requestCardGuaranteeByStaff({ restaurantId: 'rest-1', reservationId: 'res-1', now: NOW }),
    ).resolves.toEqual({
      paymentId: PAYMENT_ID,
      expiresAt: new Date('2026-11-14T10:00:00.000Z'),
    });
    expect(queues.smsClient.add).toHaveBeenCalledWith(
      'card-guarantee-link',
      { paymentId: PAYMENT_ID, restaurantId: 'rest-1', nonce: 'first' },
      expect.anything(),
    );
  });

  it('refuse une seconde empreinte ouverte', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({ id: 'open' } as never);
    await expect(
      requestCardGuaranteeByStaff({ restaurantId: 'rest-1', reservationId: 'res-1', now: NOW }),
    ).rejects.toMatchObject({ code: 'PAYMENT_IDEMPOTENCY_CONFLICT' });
  });

  it('refuse sans politique d’empreinte active', async () => {
    vi.mocked(db.reservationPaymentPolicy.findFirst).mockResolvedValue(null);
    await expect(
      requestCardGuaranteeByStaff({ restaurantId: 'rest-1', reservationId: 'res-1', now: NOW }),
    ).rejects.toMatchObject({ code: 'RESERVATION_PAYMENT_POLICY_NOT_FOUND' });
  });

  it('renvoie le lien tant que la carte n’est pas enregistrée', async () => {
    vi.mocked(db.reservationPayment.findFirst).mockResolvedValue({
      id: PAYMENT_ID,
      restaurantId: 'rest-1',
      status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
      expiresAt: new Date('2026-11-13T12:00:00.000Z'),
    } as never);
    await resendCardGuaranteeLink({ restaurantId: 'rest-1', reservationId: 'res-1', now: NOW });
    expect(queues.smsClient.add).toHaveBeenCalledWith(
      'card-guarantee-link',
      expect.objectContaining({ nonce: String(NOW.getTime()) }),
      expect.anything(),
    );
  });
});
