import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketingPermissionStatus } from '@prisma/client';
import { db } from '../../../shared/db/client';
import {
  buildMarketingConsentUrl,
  buildMarketingUnsubscribeUrl,
  consumeMarketingUnsubscribeToken,
  createMarketingConsentToken,
  createMarketingUnsubscribeToken,
  verifyMarketingConsentToken,
  verifyMarketingUnsubscribeToken,
} from '../marketing-unsubscribe.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(db)),
    customer: { findFirst: vi.fn(), findUnique: vi.fn() },
    marketingPermission: { upsert: vi.fn() },
    marketingPermissionEvent: { create: vi.fn() },
    marketingOptOut: {
      upsert: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerTimelineEvent: { create: vi.fn(), findUnique: vi.fn() },
    reservation: { findFirst: vi.fn() },
  },
}));

describe('marketing unsubscribe token', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(48);
    process.env.MARKETING_OPTOUT_HASH_SECRET = 'o'.repeat(48);
    process.env.MARKETING_UNSUBSCRIBE_BASE_URL =
      'https://api.suppernote.test/marketing/unsubscribe';
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      id: 'customer-1',
      emailNormalized: 'client@example.test',
    } as never);
    vi.mocked(db.customer.findUnique).mockResolvedValue({ restaurantId: 'restaurant-1' } as never);
    vi.mocked(db.customerTimelineEvent.create).mockResolvedValue({ id: 'timeline-1' } as never);
    vi.mocked(db.marketingPermission.upsert).mockResolvedValue({
      id: 'permission-1',
      status: MarketingPermissionStatus.OPTED_OUT,
      channel: 'EMAIL',
    } as never);
  });

  it('produit un lien opaque signé et refuse une altération', async () => {
    const token = await createMarketingUnsubscribeToken({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      issuedAt: new Date('2026-09-13T12:00:00.000Z'),
      expiresAt: new Date('2026-10-13T12:00:00.000Z'),
    });
    expect(token).toMatch(/^v1\./);
    expect(buildMarketingUnsubscribeUrl(token)).toContain('token=v1.');
    await expect(
      consumeMarketingUnsubscribeToken({
        token: `${token}x`,
        now: new Date('2026-09-13T12:00:00.000Z'),
      }),
    ).rejects.toThrow('INVALID_UNSUBSCRIBE_TOKEN');
  });

  it('retire immédiatement le canal et journalise la preuve', async () => {
    const token = await createMarketingUnsubscribeToken({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      issuedAt: new Date('2026-09-13T12:00:00.000Z'),
      expiresAt: new Date('2026-10-13T12:00:00.000Z'),
    });
    const result = await consumeMarketingUnsubscribeToken({
      token,
      now: new Date('2026-09-13T13:00:00.000Z'),
    });
    expect(result).toMatchObject({
      customerId: 'customer-1',
      restaurantId: 'restaurant-1',
      channel: 'EMAIL',
    });
    expect(db.marketingPermission.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          customerId_channel: { customerId: 'customer-1', channel: 'EMAIL' },
          restaurantId: 'restaurant-1',
        },
        create: expect.objectContaining({ status: MarketingPermissionStatus.OPTED_OUT }),
      }),
    );
  });
});

describe('marketing consent link token', () => {
  const DAY_MS = 86_400_000;
  const ISSUED_AT = new Date('2026-10-01T12:00:00.000Z');

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MARKETING_UNSUBSCRIBE_SECRET = 'u'.repeat(48);
    vi.mocked(db.reservation.findFirst).mockResolvedValue({ id: 'reservation-1' } as never);
  });

  function consentToken(): Promise<string> {
    return createMarketingConsentToken({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      reservationId: 'reservation-1',
      issuedAt: ISSUED_AT,
    });
  }

  it('ouvre la page de consentement sur l’origine de l’API', async () => {
    process.env.API_URL = 'https://api.suppernote.test/';
    const url = new URL(buildMarketingConsentUrl(await consentToken()));
    expect(`${url.origin}${url.pathname}`).toBe('https://api.suppernote.test/marketing/consent');
    expect(url.searchParams.get('token')).toMatch(/^c1\./);
  });

  it('est valable 30 jours puis expire', async () => {
    const token = await consentToken();
    expect(token).toMatch(/^c1\./);
    expect(verifyMarketingConsentToken(token, new Date(ISSUED_AT.getTime() + 29 * DAY_MS))).toEqual(
      {
        restaurantId: 'restaurant-1',
        customerId: 'customer-1',
        reservationId: 'reservation-1',
      },
    );
    expect(() =>
      verifyMarketingConsentToken(token, new Date(ISSUED_AT.getTime() + 31 * DAY_MS)),
    ).toThrow('UNSUBSCRIBE_TOKEN_EXPIRED');
  });

  it('refuse un jeton altéré ou re-signé avec un autre client', async () => {
    const token = await consentToken();
    expect(() => verifyMarketingConsentToken(`${token}x`, ISSUED_AT)).toThrow(
      'INVALID_UNSUBSCRIBE_TOKEN',
    );

    const [version, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({
        v: 1,
        restaurantId: 'restaurant-1',
        customerId: 'customer-2',
        channel: 'EMAIL',
        exp: Math.floor((ISSUED_AT.getTime() + 29 * DAY_MS) / 1000),
      }),
    ).toString('base64url');
    expect(() =>
      verifyMarketingConsentToken(`${version}.${forgedPayload}.${signature}`, ISSUED_AT),
    ).toThrow('INVALID_UNSUBSCRIBE_TOKEN');
  });

  it('ne se confond pas avec le jeton de désinscription, dans aucun sens', async () => {
    const consent = await consentToken();
    expect(() => verifyMarketingUnsubscribeToken(consent, ISSUED_AT)).toThrow(
      'INVALID_UNSUBSCRIBE_TOKEN',
    );

    const unsubscribe = await createMarketingUnsubscribeToken({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      issuedAt: ISSUED_AT,
      expiresAt: new Date(ISSUED_AT.getTime() + DAY_MS),
    });
    expect(() => verifyMarketingConsentToken(unsubscribe, ISSUED_AT)).toThrow(
      'INVALID_UNSUBSCRIBE_TOKEN',
    );
  });
});
