import { MarketingPermissionStatus, type MarketingPermission } from '@prisma/client';
import {
  buildCombinedMarketingConsentProof,
  buildEmailMarketingConsentProof,
  MARKETING_CONSENT_EMAIL_VERSION,
  buildMarketingConsentProof,
  MARKETING_CONSENT_COMBINED_VERSION,
  MARKETING_CONSENT_VERSION,
  type MarketingConsentChannel,
  type MarketingConsentCollectionMethod,
} from '@suppernote/shared';
import { db } from '../../shared/db/client';
import { logger } from '../../shared/logger/pino';
import { normalizeCustomerEmail, upsertCustomerIdentity } from '../customers/customer-crm.service';
import {
  isMarketingOptedOut,
  isMarketingOptOutRegisterConfigured,
} from './marketing-opt-out.service';
import { upsertMarketingPermission } from './marketing-permission.service';

/** Where a consent tick came from. Stored as `MarketingPermission.source`. */
export type BookingConsentSource = 'CONNECT' | 'BOOK_PAGE' | 'WIDGET' | 'CONFIRMATION_EMAIL';

/** Optional block added to the public booking requests. Unticked or absent means "not asked". */
export type BookingMarketingConsent = {
  email?: boolean;
  sms?: boolean;
  version: string;
};

export type BookingConsentOutcome =
  | 'RECORDED'
  | 'ALREADY_GRANTED'
  | 'NOT_REQUESTED'
  | 'VERSION_MISMATCH'
  | 'EMAIL_REQUIRED'
  | 'EMAIL_MISMATCH'
  | 'FAILED';

export type BookingConsentResult = Record<MarketingConsentChannel, BookingConsentOutcome>;

/**
 * The address a customer ticks the box for must be the address the campaign will reach. A public
 * booking form never overwrites an email already on file, and never takes one from another customer.
 */
async function attachBookingEmail(args: {
  restaurantId: string;
  customerId: string;
  email: string | null | undefined;
}): Promise<'OK' | 'EMAIL_REQUIRED' | 'EMAIL_MISMATCH'> {
  const normalized = args.email ? normalizeCustomerEmail(args.email) : null;
  if (!normalized) return 'EMAIL_REQUIRED';

  const customer = await db.customer.findFirst({
    where: { id: args.customerId, restaurantId: args.restaurantId, archivedAt: null },
    select: { emailNormalized: true },
  });
  if (!customer) return 'EMAIL_REQUIRED';
  if (customer.emailNormalized) {
    return customer.emailNormalized === normalized ? 'OK' : 'EMAIL_MISMATCH';
  }

  const identity = await upsertCustomerIdentity({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    type: 'EMAIL',
    value: args.email!,
    source: 'BOOKING_CONSENT',
  });
  if (identity.status === 'conflict') return 'EMAIL_MISMATCH';

  const updated = await db.customer.updateMany({
    where: { id: args.customerId, restaurantId: args.restaurantId, emailNormalized: null },
    data: { emailNormalized: normalized },
  });
  if (updated.count === 1) return 'OK';

  const raced = await db.customer.findFirst({
    where: { id: args.customerId, restaurantId: args.restaurantId },
    select: { emailNormalized: true },
  });
  return raced?.emailNormalized === normalized ? 'OK' : 'EMAIL_MISMATCH';
}

async function grantChannel(args: {
  restaurantId: string;
  customerId: string;
  restaurantName: string;
  channel: MarketingConsentChannel;
  source: BookingConsentSource;
  occurredAt: Date;
  proofVersion: string;
  proof: string;
}): Promise<'RECORDED' | 'ALREADY_GRANTED'> {
  const existing = await db.marketingPermission.findFirst({
    where: {
      restaurantId: args.restaurantId,
      customerId: args.customerId,
      channel: args.channel,
    },
    select: { status: true, proofVersion: true },
  });
  if (
    existing?.status === MarketingPermissionStatus.OPTED_IN &&
    existing.proofVersion === args.proofVersion
  ) {
    return 'ALREADY_GRANTED';
  }
  await upsertMarketingPermission({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    channel: args.channel,
    status: MarketingPermissionStatus.OPTED_IN,
    source: args.source,
    proofVersion: args.proofVersion,
    proof: args.proof,
    liftsOpposition: true,
    occurredAt: args.occurredAt,
  });
  return 'RECORDED';
}

/**
 * Records the optional marketing ticks of a public booking form. It is a best-effort side effect of
 * a reservation: it never throws and never blocks the booking, and an unticked box changes nothing
 * (a previous opt-in or withdrawal stays as it is). No address, phone number or name is logged.
 */
export async function recordBookingMarketingConsent(args: {
  restaurantId: string;
  restaurantName: string;
  customerId: string | null;
  source: BookingConsentSource;
  consent: BookingMarketingConsent | undefined;
  email?: string | null;
  occurredAt?: Date;
}): Promise<BookingConsentResult> {
  const result: BookingConsentResult = { EMAIL: 'NOT_REQUESTED', SMS: 'NOT_REQUESTED' };
  const requested: MarketingConsentChannel[] = [];
  if (args.consent?.email === true) requested.push('EMAIL');
  // La version e-mail seule n'enregistre jamais de SMS, même si le client en envoie un.
  if (args.consent?.sms === true && args.consent?.version !== MARKETING_CONSENT_EMAIL_VERSION) {
    requested.push('SMS');
  }
  if (requested.length === 0) return result;

  const version = args.consent?.version;
  if (
    version !== MARKETING_CONSENT_VERSION &&
    version !== MARKETING_CONSENT_COMBINED_VERSION &&
    version !== MARKETING_CONSENT_EMAIL_VERSION
  ) {
    // An outdated page showed other wording: nothing is recorded rather than a proof that
    // would not match what the customer read.
    for (const channel of requested) result[channel] = 'VERSION_MISMATCH';
    logger.warn(
      { restaurantId: args.restaurantId, source: args.source },
      '[marketing-consent] unknown wording version',
    );
    return result;
  }
  if (!args.customerId) {
    for (const channel of requested) result[channel] = 'FAILED';
    return result;
  }

  const occurredAt = args.occurredAt ?? new Date();
  for (const channel of requested) {
    try {
      if (channel === 'EMAIL') {
        const attached = await attachBookingEmail({
          restaurantId: args.restaurantId,
          customerId: args.customerId,
          email: args.email,
        });
        if (attached !== 'OK') {
          result.EMAIL = attached;
          continue;
        }
      }
      result[channel] = await grantChannel({
        restaurantId: args.restaurantId,
        customerId: args.customerId,
        restaurantName: args.restaurantName,
        channel,
        source: args.source,
        occurredAt,
        proofVersion: version,
        // The single box ticks every channel it named, so the ticked channels rebuild its sentence.
        proof:
          version === MARKETING_CONSENT_EMAIL_VERSION
            ? buildEmailMarketingConsentProof(args.restaurantName)
            : version === MARKETING_CONSENT_COMBINED_VERSION
              ? buildCombinedMarketingConsentProof(channel, requested, args.restaurantName)
              : buildMarketingConsentProof(channel, args.restaurantName),
      });
    } catch (error) {
      result[channel] = 'FAILED';
      logger.warn(
        {
          restaurantId: args.restaurantId,
          channel,
          source: args.source,
          err: error instanceof Error ? error.name : 'unknown',
        },
        '[marketing-consent] booking consent not recorded',
      );
    }
  }
  return result;
}

/**
 * Consent collected by the restaurant team outside a form (at the table, by phone, on paper). The
 * team picks how it was obtained; the stored proof is rebuilt here from the versioned wording plus
 * that method, never taken from the client.
 */
export async function recordStaffMarketingConsent(args: {
  restaurantId: string;
  customerId: string;
  channel: MarketingConsentChannel;
  method: MarketingConsentCollectionMethod;
  /** The team member who recorded the agreement, kept with the proof. */
  actorUserId?: string | null;
  occurredAt?: Date;
}): Promise<MarketingPermission> {
  const customer = await db.customer.findFirst({
    where: { id: args.customerId, restaurantId: args.restaurantId, archivedAt: null },
    select: { emailNormalized: true },
  });
  if (!customer) throw new Error('CUSTOMER_NOT_FOUND');
  if (args.channel === 'EMAIL' && !customer.emailNormalized) {
    throw new Error('CUSTOMER_EMAIL_REQUIRED');
  }
  const restaurant = await db.restaurant.findUnique({
    where: { id: args.restaurantId },
    select: { name: true },
  });
  if (!restaurant) throw new Error('RESTAURANT_NOT_FOUND');

  return upsertMarketingPermission({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    channel: args.channel,
    status: MarketingPermissionStatus.OPTED_IN,
    source: `DASHBOARD_${args.method}`,
    proofVersion: MARKETING_CONSENT_VERSION,
    proof: `${buildMarketingConsentProof(args.channel, restaurant.name)}|${args.method}`,
    actorUserId: args.actorUserId,
    occurredAt: args.occurredAt,
  });
}

/** Nom du restaurant, repris dans la preuve ; `null` si le restaurant n'existe plus. */
export async function restaurantNameForConsent(restaurantId: string): Promise<string | null> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: restaurantId },
    select: { name: true },
  });
  return restaurant?.name ?? null;
}

export type MarketingEmailConsentStatus = 'OFFERABLE' | 'ALREADY_OPTED_IN' | 'UNAVAILABLE';

/**
 * Dit si la ligne « recevoir les offres » peut être proposée à cette adresse, celle qui a reçu la
 * confirmation. Non sans adresse, si un accord ou un retrait existe, si l'adresse figure au registre
 * d'opposition, ou si le client en a déjà une autre : elle n'est jamais remplacée. Sans registre
 * configuré, rien n'est proposé : l'opposition ne peut pas être vérifiée.
 */
export async function marketingEmailConsentStatus(args: {
  restaurantId: string;
  customerId: string;
  address: string | null;
}): Promise<MarketingEmailConsentStatus> {
  if (!args.address) return 'UNAVAILABLE';
  const customer = await db.customer.findFirst({
    where: { id: args.customerId, restaurantId: args.restaurantId, archivedAt: null },
    select: { emailNormalized: true },
  });
  if (!customer || (customer.emailNormalized && customer.emailNormalized !== args.address)) {
    return 'UNAVAILABLE';
  }

  const permission = await db.marketingPermission.findFirst({
    where: { restaurantId: args.restaurantId, customerId: args.customerId, channel: 'EMAIL' },
    select: { status: true },
  });
  if (permission?.status === MarketingPermissionStatus.OPTED_IN) return 'ALREADY_OPTED_IN';
  if (permission?.status === MarketingPermissionStatus.OPTED_OUT) return 'UNAVAILABLE';
  if (!isMarketingOptOutRegisterConfigured()) return 'UNAVAILABLE';

  const optedOut = await isMarketingOptedOut({
    restaurantId: args.restaurantId,
    channel: 'EMAIL',
    address: args.address,
  });
  return optedOut ? 'UNAVAILABLE' : 'OFFERABLE';
}

/**
 * Enregistre l'accord coché depuis le lien de la confirmation. L'adresse de la réservation n'est
 * rattachée au client qu'à ce moment, la case cochée, et jamais en remplacement. Un accord déjà donné
 * ne réécrit rien : ni nouvelle preuve, ni nouvel événement, même si le formulaire part deux fois.
 */
export async function recordConfirmationEmailConsent(args: {
  restaurantId: string;
  customerId: string;
  reservationId: string;
  occurredAt?: Date;
}): Promise<'RECORDED' | 'ALREADY_GRANTED' | 'NOT_RECORDED'> {
  const restaurantName = await restaurantNameForConsent(args.restaurantId);
  if (!restaurantName) return 'NOT_RECORDED';
  const reservation = await db.reservation.findFirst({
    where: { id: args.reservationId, restaurantId: args.restaurantId, customerId: args.customerId },
    select: { customerEmail: true },
  });
  const address = reservation?.customerEmail
    ? normalizeCustomerEmail(reservation.customerEmail)
    : null;
  const status = await marketingEmailConsentStatus({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    address,
  });
  if (!address || status === 'UNAVAILABLE') return 'NOT_RECORDED';
  if (status === 'ALREADY_OPTED_IN') return 'ALREADY_GRANTED';
  const attached = await attachBookingEmail({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    email: address,
  });
  if (attached !== 'OK') return 'NOT_RECORDED';
  return grantChannel({
    restaurantId: args.restaurantId,
    customerId: args.customerId,
    restaurantName,
    channel: 'EMAIL',
    source: 'CONFIRMATION_EMAIL',
    occurredAt: args.occurredAt ?? new Date(),
    proofVersion: MARKETING_CONSENT_VERSION,
    proof: buildMarketingConsentProof('EMAIL', restaurantName),
  });
}
