import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketingPermissionStatus } from '@prisma/client';
import {
  buildMarketingConsentLabel,
  buildMarketingConsentProof,
  MARKETING_CONSENT_VERSION,
} from '@suppernote/shared';
import { db } from '../../../shared/db/client';
import { upsertCustomerIdentity } from '../../customers/customer-crm.service';
import { upsertMarketingPermission } from '../marketing-permission.service';
import {
  marketingEmailConsentStatus,
  recordBookingMarketingConsent,
  recordConfirmationEmailConsent,
  recordStaffMarketingConsent,
} from '../marketing-consent.service';
import { marketingOptOutHash } from '../marketing-opt-out.service';

vi.mock('../../../shared/db/client', () => ({
  db: {
    customer: { findFirst: vi.fn(), updateMany: vi.fn() },
    restaurant: { findUnique: vi.fn() },
    marketingPermission: { findFirst: vi.fn() },
    marketingOptOut: { findMany: vi.fn() },
    reservation: { findFirst: vi.fn() },
  },
}));
vi.mock('../../customers/customer-crm.service', async (importActual) => ({
  ...(await importActual<typeof import('../../customers/customer-crm.service')>()),
  upsertCustomerIdentity: vi.fn(),
}));
vi.mock('../marketing-permission.service', () => ({ upsertMarketingPermission: vi.fn() }));
vi.mock('../../../shared/logger/pino', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

const base = {
  restaurantId: 'restaurant-1',
  restaurantName: 'Chez Suppernote',
  customerId: 'customer-1',
  source: 'CONNECT' as const,
};
const OCCURRED_AT = new Date('2026-10-22T10:00:00.000Z');

describe('recordBookingMarketingConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.customer.findFirst).mockResolvedValue({ emailNormalized: null } as never);
    vi.mocked(db.customer.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue(null);
    vi.mocked(upsertCustomerIdentity).mockResolvedValue({ status: 'created' } as never);
    vi.mocked(upsertMarketingPermission).mockResolvedValue({} as never);
  });

  it('records nothing when no box is ticked, and never touches the customer', async () => {
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { email: false, sms: false, version: MARKETING_CONSENT_VERSION },
      email: 'client@example.com',
    });
    expect(result).toEqual({ EMAIL: 'NOT_REQUESTED', SMS: 'NOT_REQUESTED' });
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
    expect(db.customer.updateMany).not.toHaveBeenCalled();
    expect(await recordBookingMarketingConsent({ ...base, consent: undefined })).toEqual({
      EMAIL: 'NOT_REQUESTED',
      SMS: 'NOT_REQUESTED',
    });
  });

  it('records an e-mail opt-in with the versioned proof and attaches the address', async () => {
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { email: true, version: MARKETING_CONSENT_VERSION },
      email: ' Client@Example.com ',
      occurredAt: OCCURRED_AT,
    });

    expect(result.EMAIL).toBe('RECORDED');
    expect(upsertCustomerIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'EMAIL', source: 'BOOKING_CONSENT' }),
    );
    expect(db.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-1', restaurantId: 'restaurant-1', emailNormalized: null },
      data: { emailNormalized: 'client@example.com' },
    });
    expect(upsertMarketingPermission).toHaveBeenCalledWith({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      status: MarketingPermissionStatus.OPTED_IN,
      source: 'CONNECT',
      liftsOpposition: true,
      proofVersion: MARKETING_CONSENT_VERSION,
      proof: buildMarketingConsentProof('EMAIL', 'Chez Suppernote'),
      occurredAt: OCCURRED_AT,
    });
  });

  it('records an SMS opt-in without needing an e-mail address', async () => {
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { sms: true, version: MARKETING_CONSENT_VERSION },
    });
    expect(result).toEqual({ EMAIL: 'NOT_REQUESTED', SMS: 'RECORDED' });
    expect(upsertCustomerIdentity).not.toHaveBeenCalled();
    expect(upsertMarketingPermission).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'SMS', source: 'CONNECT' }),
    );
  });

  it('refuses an e-mail opt-in without a usable address', async () => {
    for (const email of [undefined, '', 'pas-une-adresse']) {
      const result = await recordBookingMarketingConsent({
        ...base,
        consent: { email: true, version: MARKETING_CONSENT_VERSION },
        email,
      });
      expect(result.EMAIL).toBe('EMAIL_REQUIRED');
    }
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });

  it('never overwrites another address already on file, nor steals one from another customer', async () => {
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      emailNormalized: 'ancienne@example.com',
    } as never);
    const mismatch = await recordBookingMarketingConsent({
      ...base,
      consent: { email: true, version: MARKETING_CONSENT_VERSION },
      email: 'nouvelle@example.com',
    });
    expect(mismatch.EMAIL).toBe('EMAIL_MISMATCH');

    vi.mocked(db.customer.findFirst).mockResolvedValue({ emailNormalized: null } as never);
    vi.mocked(upsertCustomerIdentity).mockResolvedValue({ status: 'conflict' } as never);
    const conflict = await recordBookingMarketingConsent({
      ...base,
      consent: { email: true, version: MARKETING_CONSENT_VERSION },
      email: 'autre@example.com',
    });
    expect(conflict.EMAIL).toBe('EMAIL_MISMATCH');
    expect(db.customer.updateMany).not.toHaveBeenCalled();
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });

  it('accepts the address already on file for this customer', async () => {
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      emailNormalized: 'client@example.com',
    } as never);
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { email: true, version: MARKETING_CONSENT_VERSION },
      email: 'CLIENT@example.com',
    });
    expect(result.EMAIL).toBe('RECORDED');
    expect(upsertCustomerIdentity).not.toHaveBeenCalled();
  });

  it('does not re-stamp a consent already granted under the same wording', async () => {
    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue({
      status: MarketingPermissionStatus.OPTED_IN,
      proofVersion: MARKETING_CONSENT_VERSION,
    } as never);
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { sms: true, version: MARKETING_CONSENT_VERSION },
    });
    expect(result.SMS).toBe('ALREADY_GRANTED');
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });

  it('records a new opt-in after a withdrawal: the customer ticked the box again', async () => {
    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue({
      status: MarketingPermissionStatus.OPTED_OUT,
      proofVersion: MARKETING_CONSENT_VERSION,
    } as never);
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { sms: true, version: MARKETING_CONSENT_VERSION },
    });
    expect(result.SMS).toBe('RECORDED');
  });

  it('ignores a page that shows an older wording instead of keeping a mismatching proof', async () => {
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { email: true, sms: true, version: 'marketing-consent-2020-01-01' },
      email: 'client@example.com',
    });
    expect(result).toEqual({ EMAIL: 'VERSION_MISMATCH', SMS: 'VERSION_MISMATCH' });
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });

  it('never throws: a database failure only marks the channel as failed', async () => {
    vi.mocked(upsertMarketingPermission).mockRejectedValue(
      new Error('db down for client@example.com'),
    );
    const result = await recordBookingMarketingConsent({
      ...base,
      consent: { sms: true, version: MARKETING_CONSENT_VERSION },
    });
    expect(result.SMS).toBe('FAILED');
    const { logger } = await import('../../../shared/logger/pino');
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('client@example.com');
  });

  it('does nothing without a customer record', async () => {
    const result = await recordBookingMarketingConsent({
      ...base,
      customerId: null,
      consent: { sms: true, version: MARKETING_CONSENT_VERSION },
    });
    expect(result.SMS).toBe('FAILED');
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });
});

describe('recordStaffMarketingConsent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      emailNormalized: 'client@example.com',
    } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ name: 'Chez Suppernote' } as never);
    vi.mocked(upsertMarketingPermission).mockResolvedValue({ id: 'permission-1' } as never);
  });

  it('stores the collection method in the source and in the rebuilt proof', async () => {
    await recordStaffMarketingConsent({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'EMAIL',
      method: 'IN_PERSON',
    });
    expect(upsertMarketingPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        status: MarketingPermissionStatus.OPTED_IN,
        source: 'DASHBOARD_IN_PERSON',
        proofVersion: MARKETING_CONSENT_VERSION,
        proof: `${buildMarketingConsentProof('EMAIL', 'Chez Suppernote')}|IN_PERSON`,
      }),
    );
  });

  it('requires an address on file for e-mail, not for SMS', async () => {
    vi.mocked(db.customer.findFirst).mockResolvedValue({ emailNormalized: null } as never);
    await expect(
      recordStaffMarketingConsent({
        restaurantId: 'restaurant-1',
        customerId: 'customer-1',
        channel: 'EMAIL',
        method: 'PHONE',
      }),
    ).rejects.toThrow('CUSTOMER_EMAIL_REQUIRED');
    await recordStaffMarketingConsent({
      restaurantId: 'restaurant-1',
      customerId: 'customer-1',
      channel: 'SMS',
      method: 'PHONE',
    });
    expect(upsertMarketingPermission).toHaveBeenCalledTimes(1);
  });

  it('refuses a customer of another restaurant', async () => {
    vi.mocked(db.customer.findFirst).mockResolvedValue(null);
    await expect(
      recordStaffMarketingConsent({
        restaurantId: 'restaurant-1',
        customerId: 'customer-x',
        channel: 'SMS',
        method: 'PAPER',
      }),
    ).rejects.toThrow('CUSTOMER_NOT_FOUND');
  });
});

describe('marketing consent wording', () => {
  it('names the restaurant and the channel', () => {
    expect(buildMarketingConsentLabel('EMAIL', 'Chez Suppernote')).toBe(
      'Recevoir les offres et actualités du restaurant Chez Suppernote par e-mail',
    );
    expect(buildMarketingConsentLabel('SMS', '  ')).toContain('ce restaurant');
  });
});

describe('ligne « recevoir les offres » de l’e-mail de confirmation', () => {
  const ids = { restaurantId: 'restaurant-1', customerId: 'customer-1' };
  const reservation = { ...ids, reservationId: 'reservation-1' };
  const address = 'client@example.com';

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.MARKETING_OPTOUT_HASH_SECRET = 'o'.repeat(48);
    vi.mocked(db.customer.findFirst).mockResolvedValue({
      emailNormalized: address,
    } as never);
    vi.mocked(db.reservation.findFirst).mockResolvedValue({ customerEmail: address } as never);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ name: 'Chez Suppernote' } as never);
    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue(null);
    vi.mocked(db.marketingOptOut.findMany).mockResolvedValue([]);
    vi.mocked(upsertMarketingPermission).mockResolvedValue({} as never);
    vi.mocked(upsertCustomerIdentity).mockResolvedValue({ status: 'created' } as never);
  });

  it('n’est proposée qu’à l’adresse de la confirmation, sans accord, sans retrait ni opposition', async () => {
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('OFFERABLE');
    expect(await marketingEmailConsentStatus({ ...ids, address: null })).toBe('UNAVAILABLE');

    vi.mocked(db.customer.findFirst).mockResolvedValueOnce({
      emailNormalized: 'autre@example.com',
    } as never);
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('UNAVAILABLE');

    vi.mocked(db.customer.findFirst).mockResolvedValueOnce({ emailNormalized: null } as never);
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('OFFERABLE');

    vi.mocked(db.marketingPermission.findFirst).mockResolvedValueOnce({
      status: MarketingPermissionStatus.OPTED_IN,
    } as never);
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('ALREADY_OPTED_IN');

    vi.mocked(db.marketingPermission.findFirst).mockResolvedValueOnce({
      status: MarketingPermissionStatus.OPTED_OUT,
    } as never);
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('UNAVAILABLE');

    vi.mocked(db.marketingOptOut.findMany).mockResolvedValueOnce([
      { addressHash: marketingOptOutHash('restaurant-1', 'EMAIL', address) },
    ] as never);
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('UNAVAILABLE');

    delete process.env.MARKETING_OPTOUT_HASH_SECRET;
    expect(await marketingEmailConsentStatus({ ...ids, address })).toBe('UNAVAILABLE');
  });

  it('enregistre une seule fois : la deuxième soumission ne réécrit ni preuve ni événement', async () => {
    expect(await recordConfirmationEmailConsent({ ...reservation, occurredAt: OCCURRED_AT })).toBe(
      'RECORDED',
    );
    expect(upsertMarketingPermission).toHaveBeenCalledTimes(1);
    expect(upsertMarketingPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'EMAIL',
        status: MarketingPermissionStatus.OPTED_IN,
        source: 'CONFIRMATION_EMAIL',
        proofVersion: MARKETING_CONSENT_VERSION,
        proof: buildMarketingConsentProof('EMAIL', 'Chez Suppernote'),
      }),
    );

    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue({
      status: MarketingPermissionStatus.OPTED_IN,
    } as never);
    expect(await recordConfirmationEmailConsent(reservation)).toBe('ALREADY_GRANTED');
    expect(upsertMarketingPermission).toHaveBeenCalledTimes(1);
  });

  it('rattache l’adresse de la confirmation à la case cochée, jamais en remplacement', async () => {
    vi.mocked(db.customer.findFirst).mockResolvedValue({ emailNormalized: null } as never);
    vi.mocked(db.customer.updateMany).mockResolvedValue({ count: 1 } as never);

    expect(await recordConfirmationEmailConsent(reservation)).toBe('RECORDED');
    expect(db.customer.updateMany).toHaveBeenCalledWith({
      where: { id: 'customer-1', restaurantId: 'restaurant-1', emailNormalized: null },
      data: { emailNormalized: address },
    });

    vi.mocked(db.customer.findFirst).mockResolvedValue({
      emailNormalized: 'autre@example.com',
    } as never);
    expect(await recordConfirmationEmailConsent(reservation)).toBe('NOT_RECORDED');
    expect(upsertMarketingPermission).toHaveBeenCalledTimes(1);
  });

  it('n’enregistre rien sans réservation, sans adresse ou pour un client désinscrit', async () => {
    vi.mocked(db.reservation.findFirst).mockResolvedValueOnce(null);
    expect(await recordConfirmationEmailConsent(reservation)).toBe('NOT_RECORDED');

    vi.mocked(db.reservation.findFirst).mockResolvedValueOnce({ customerEmail: null } as never);
    expect(await recordConfirmationEmailConsent(reservation)).toBe('NOT_RECORDED');

    vi.mocked(db.marketingPermission.findFirst).mockResolvedValue({
      status: MarketingPermissionStatus.OPTED_OUT,
    } as never);
    expect(await recordConfirmationEmailConsent(reservation)).toBe('NOT_RECORDED');
    expect(upsertMarketingPermission).not.toHaveBeenCalled();
  });
});
