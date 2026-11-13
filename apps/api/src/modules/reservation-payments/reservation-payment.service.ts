import { Prisma, ReservationPaymentStatus, ReservationPaymentType } from '@prisma/client';
import { db } from '../../shared/db/client';
import { logger } from '../../shared/logger/pino';
import {
  chargeReservationGuarantee,
  createRefund,
  createReservationGuaranteeSetupSession,
  expireExperienceCheckoutSession,
  retrieveConnectedAccount,
} from '../gift-cards/stripe.service';
import {
  ReservationLifecycleService,
  type ReservationLifecycleResult,
} from '../reservations/reservation-lifecycle.service.js';

const reservationLifecycle = new ReservationLifecycleService(db);

export const PAYMENT_AMOUNT_MODES = ['FIXED', 'PER_PERSON'] as const;
export type ReservationPaymentAmountMode = (typeof PAYMENT_AMOUNT_MODES)[number];

const PAYMENT_STATUS_TRANSITIONS: Readonly<
  Record<ReservationPaymentStatus, readonly ReservationPaymentStatus[]>
> = {
  REQUIRES_PAYMENT_METHOD: [
    ReservationPaymentStatus.REQUIRES_ACTION,
    ReservationPaymentStatus.AUTHORIZED,
    ReservationPaymentStatus.CAPTURED,
    ReservationPaymentStatus.FAILED,
    ReservationPaymentStatus.CANCELLED,
    ReservationPaymentStatus.EXPIRED,
  ],
  REQUIRES_ACTION: [
    ReservationPaymentStatus.AUTHORIZED,
    ReservationPaymentStatus.CAPTURED,
    ReservationPaymentStatus.FAILED,
    ReservationPaymentStatus.CANCELLED,
    ReservationPaymentStatus.EXPIRED,
  ],
  AUTHORIZED: [
    ReservationPaymentStatus.CAPTURED,
    ReservationPaymentStatus.PARTIALLY_REFUNDED,
    ReservationPaymentStatus.REFUNDED,
    ReservationPaymentStatus.CANCELLED,
  ],
  CAPTURED: [ReservationPaymentStatus.PARTIALLY_REFUNDED, ReservationPaymentStatus.REFUNDED],
  PARTIALLY_REFUNDED: [ReservationPaymentStatus.REFUNDED],
  REFUNDED: [],
  FAILED: [ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD, ReservationPaymentStatus.CANCELLED],
  CANCELLED: [],
  EXPIRED: [],
};

const POLICY_SELECT = {
  id: true,
  restaurantId: true,
  version: true,
  type: true,
  amountMode: true,
  amount: true,
  minPartySize: true,
  cancellationHours: true,
  rules: true,
  activeFrom: true,
  activeUntil: true,
  createdAt: true,
} as const;

const PAYMENT_SELECT = {
  id: true,
  restaurantId: true,
  reservationId: true,
  policyId: true,
  status: true,
  amount: true,
  currency: true,
  stripeAccountId: true,
  stripeSetupIntentId: true,
  stripePaymentIntentId: true,
  stripeCustomerId: true,
  stripePaymentMethodId: true,
  stripeCheckoutSessionId: true,
  capturedAmount: true,
  refundedAmount: true,
  termsAcceptedAt: true,
  disputeStatus: true,
  idempotencyKey: true,
  policySnapshot: true,
  expiresAt: true,
  failureCode: true,
  lastProviderEventAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type PolicyRow = Prisma.ReservationPaymentPolicyGetPayload<{ select: typeof POLICY_SELECT }>;
type PaymentRow = Prisma.ReservationPaymentGetPayload<{ select: typeof PAYMENT_SELECT }>;

export class ReservationPaymentInputError extends Error {
  constructor(
    readonly code:
      | 'PAYMENT_POLICY_INVALID'
      | 'PAYMENT_AMOUNT_INVALID'
      | 'PAYMENT_IDEMPOTENCY_INVALID'
      | 'PAYMENT_EXPIRY_INVALID'
      | 'PAYMENT_EVENT_INVALID'
      | 'PAYMENT_PROVIDER_MISMATCH'
      | 'PAYMENT_CURRENCY_MISMATCH'
      | 'PAYMENT_AMOUNT_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'ReservationPaymentInputError';
  }
}

export class ReservationPaymentNotFoundError extends Error {
  readonly code = 'RESERVATION_PAYMENT_NOT_FOUND';

  constructor() {
    super('Reservation payment not found');
    this.name = 'ReservationPaymentNotFoundError';
  }
}

export class ReservationPaymentPolicyNotFoundError extends Error {
  readonly code = 'RESERVATION_PAYMENT_POLICY_NOT_FOUND';

  constructor() {
    super('Reservation payment policy not found');
    this.name = 'ReservationPaymentPolicyNotFoundError';
  }
}

export class ReservationPaymentReservationNotFoundError extends Error {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor() {
    super('Reservation not found');
    this.name = 'ReservationPaymentReservationNotFoundError';
  }
}

const STATE_ERROR_MESSAGES = {
  PAYMENT_TRANSITION_INVALID: 'Reservation payment transition is not allowed',
  PAYMENT_IDEMPOTENCY_CONFLICT: 'Payment idempotency key already belongs to another payment',
  PAYMENT_POLICY_VERSION_CONFLICT: 'Reservation payment policy version already exists',
  PAYMENT_PROVIDER_NOT_READY: 'Le compte Stripe du restaurant ne peut pas encore encaisser.',
  PAYMENT_CAPTURE_NOT_ALLOWED: 'Cette empreinte ne peut pas être prélevée.',
  PAYMENT_CAPTURE_IN_PROGRESS: 'Un prélèvement est déjà en cours pour cette réservation.',
  PAYMENT_REFUND_NOT_ALLOWED: 'Ce prélèvement ne peut pas être remboursé de ce montant.',
} as const;

export class ReservationPaymentStateError extends Error {
  constructor(
    readonly code:
      | 'PAYMENT_TRANSITION_INVALID'
      | 'PAYMENT_IDEMPOTENCY_CONFLICT'
      | 'PAYMENT_POLICY_VERSION_CONFLICT'
      | 'PAYMENT_PROVIDER_NOT_READY'
      | 'PAYMENT_CAPTURE_NOT_ALLOWED'
      | 'PAYMENT_CAPTURE_IN_PROGRESS'
      | 'PAYMENT_REFUND_NOT_ALLOWED',
  ) {
    super(STATE_ERROR_MESSAGES[code]);
    this.name = 'ReservationPaymentStateError';
  }
}

export interface CreateReservationPaymentPolicyInput {
  restaurantId: string;
  type: ReservationPaymentType;
  amountMode: ReservationPaymentAmountMode;
  amount: string | number;
  minPartySize?: number | null;
  cancellationHours?: number;
  rules?: Record<string, unknown>;
  activeFrom?: Date;
  activeUntil?: Date | null;
  version?: number;
}

export interface ReservationPaymentPolicyView {
  id: string;
  restaurantId: string;
  version: number;
  type: ReservationPaymentType;
  amountMode: ReservationPaymentAmountMode;
  amount: string;
  minPartySize: number | null;
  cancellationHours: number;
  rules: Record<string, unknown>;
  activeFrom: Date;
  activeUntil: Date | null;
  createdAt: Date;
}

export interface ReservationPaymentView {
  id: string;
  restaurantId: string;
  reservationId: string;
  policyId: string;
  status: ReservationPaymentStatus;
  amount: string;
  currency: string;
  hasStripeAccount: boolean;
  hasSetupIntent: boolean;
  hasPaymentIntent: boolean;
  hasSavedCard: boolean;
  capturedAmount: string | null;
  refundedAmount: string | null;
  disputeStatus: string | null;
  idempotencyKey: string;
  expiresAt: Date | null;
  failureCode: string | null;
  lastProviderEventAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReservationPaymentPreparation {
  id: string | null;
  reservationId: string;
  policyId: string;
  type: ReservationPaymentType;
  status: ReservationPaymentStatus;
  amount: string;
  currency: string;
  idempotencyKey: string;
  expiresAt: Date;
  dryRun: boolean;
  provider: 'stripe';
  providerConfigured: false;
  requiresProviderSetup: true;
}

export interface ReservationPaymentProviderEventInput {
  restaurantId: string;
  paymentId: string;
  providerEventId: string;
  eventType: string;
  occurredAt: Date;
  payloadHash: string;
  amount?: string | number;
  currency?: string;
  stripeSetupIntentId?: string;
  stripePaymentIntentId?: string;
  stripeAccountId?: string | null;
  stripeCustomerId?: string;
  stripePaymentMethodId?: string;
  refundedAmount?: string | number;
  failureCode?: string;
  disputeStatus?: string;
}

export interface ReservationPaymentProviderEventResult {
  eventId: string;
  paymentId: string;
  resultingStatus: ReservationPaymentStatus | null;
  changed: boolean;
  duplicate: boolean;
  stale: boolean;
  reservationConfirmed: boolean;
  ignoredReason?: 'UNSUPPORTED_EVENT' | 'STALE_EVENT';
}

function assertPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Les règles de paiement doivent être un objet JSON.',
    );
  }
  return value as Record<string, unknown>;
}

function normalizeRules(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const rules = value ?? {};
  assertPlainObject(rules);
  let serialized: string;
  try {
    serialized = JSON.stringify(rules);
  } catch {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Les règles de paiement doivent être sérialisables.',
    );
  }
  if (serialized.length > 8_192) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Les règles de paiement sont trop volumineuses.',
    );
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

function normalizeMoney(value: string | number): Prisma.Decimal {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_AMOUNT_INVALID',
      'Le montant doit être positif et contenir au plus deux décimales.',
    );
  }
  const amount = new Prisma.Decimal(raw);
  if (!amount.greaterThan(0) || amount.greaterThanOrEqualTo(100_000)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_AMOUNT_INVALID',
      'Le montant doit être compris entre 0 et 100 000 euros.',
    );
  }
  return amount;
}

function normalizeIdempotencyKey(value: string): string {
  const key = value.trim();
  if (key.length < 8 || key.length > 200 || /[\u0000-\u001f\u007f]/.test(key)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_IDEMPOTENCY_INVALID',
      'La clé d’idempotence doit contenir entre 8 et 200 caractères sûrs.',
    );
  }
  return key;
}

function normalizeCurrency(value: string | undefined): string {
  const currency = (value ?? 'EUR').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'La devise doit être un code ISO 4217.',
    );
  }
  return currency;
}

function normalizeProviderId(value: string, field: string): string {
  const id = value.trim();
  if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ReservationPaymentInputError('PAYMENT_EVENT_INVALID', `${field} est invalide.`);
  }
  return id;
}

function normalizePayloadHash(value: string): string {
  const hash = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new ReservationPaymentInputError('PAYMENT_EVENT_INVALID', 'payloadHash est invalide.');
  }
  return hash;
}

function policySnapshot(policy: PolicyRow): Prisma.InputJsonObject {
  return {
    id: policy.id,
    version: policy.version,
    type: policy.type,
    amountMode: policy.amountMode,
    amount: policy.amount.toFixed(2),
    minPartySize: policy.minPartySize,
    cancellationHours: policy.cancellationHours,
    rules: normalizeRules(policy.rules as Record<string, unknown>) as Prisma.InputJsonValue,
    activeFrom: policy.activeFrom.toISOString(),
    activeUntil: policy.activeUntil?.toISOString() ?? null,
  };
}

function snapshotType(value: Prisma.JsonValue): string | null {
  const type = asRules(value).type;
  return typeof type === 'string' ? type : null;
}

function asRules(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function serializePolicy(row: PolicyRow): ReservationPaymentPolicyView {
  return {
    id: row.id,
    restaurantId: row.restaurantId,
    version: row.version,
    type: row.type,
    amountMode: row.amountMode as ReservationPaymentAmountMode,
    amount: row.amount.toFixed(2),
    minPartySize: row.minPartySize,
    cancellationHours: row.cancellationHours,
    rules: asRules(row.rules),
    activeFrom: row.activeFrom,
    activeUntil: row.activeUntil,
    createdAt: row.createdAt,
  };
}

function serializePayment(row: PaymentRow): ReservationPaymentView {
  return {
    id: row.id,
    restaurantId: row.restaurantId,
    reservationId: row.reservationId,
    policyId: row.policyId,
    status: row.status,
    amount: row.amount.toFixed(2),
    currency: row.currency,
    hasStripeAccount: Boolean(row.stripeAccountId),
    hasSetupIntent: Boolean(row.stripeSetupIntentId),
    hasPaymentIntent: Boolean(row.stripePaymentIntentId),
    hasSavedCard: Boolean(row.stripePaymentMethodId),
    capturedAmount: row.capturedAmount?.toFixed(2) ?? null,
    refundedAmount: row.refundedAmount?.toFixed(2) ?? null,
    disputeStatus: row.disputeStatus,
    idempotencyKey: row.idempotencyKey,
    expiresAt: row.expiresAt,
    failureCode: row.failureCode,
    lastProviderEventAt: row.lastProviderEventAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function computeReservationPaymentAmount(
  policy: Pick<PolicyRow, 'amount' | 'amountMode'>,
  partySize: number,
): Prisma.Decimal {
  if (!Number.isInteger(partySize) || partySize < 1 || partySize > 100) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Le nombre de couverts doit être compris entre 1 et 100.',
    );
  }
  const amount = policy.amountMode === 'PER_PERSON' ? policy.amount.mul(partySize) : policy.amount;
  if (!amount.greaterThan(0) || amount.greaterThanOrEqualTo(100_000)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_AMOUNT_INVALID',
      'Le montant calculé est hors limites.',
    );
  }
  return amount.toDecimalPlaces(2);
}

export function canTransitionReservationPayment(
  from: ReservationPaymentStatus,
  to: ReservationPaymentStatus,
): boolean {
  return from === to || PAYMENT_STATUS_TRANSITIONS[from].includes(to);
}

export function reservationPaymentStatusForProviderEvent(
  eventType: string,
): ReservationPaymentStatus | null {
  switch (eventType) {
    case 'setup_intent.succeeded':
      return ReservationPaymentStatus.AUTHORIZED;
    case 'payment_intent.requires_action':
      return ReservationPaymentStatus.REQUIRES_ACTION;
    case 'payment_intent.succeeded':
      return ReservationPaymentStatus.CAPTURED;
    case 'payment_intent.payment_failed':
      return ReservationPaymentStatus.FAILED;
    case 'payment_intent.canceled':
      return ReservationPaymentStatus.CANCELLED;
    case 'payment_intent.expired':
      return ReservationPaymentStatus.EXPIRED;
    case 'charge.refunded':
      return ReservationPaymentStatus.REFUNDED;
    default:
      return null;
  }
}

function assertPolicyInput(input: CreateReservationPaymentPolicyInput): {
  amount: Prisma.Decimal;
  rules: Record<string, unknown>;
  activeFrom: Date;
  activeUntil: Date | null;
} {
  if (!Object.values(ReservationPaymentType).includes(input.type)) {
    throw new ReservationPaymentInputError('PAYMENT_POLICY_INVALID', 'Type de paiement invalide.');
  }
  if (!PAYMENT_AMOUNT_MODES.includes(input.amountMode)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Le mode de montant doit être FIXED ou PER_PERSON.',
    );
  }
  const amount = normalizeMoney(input.amount);
  const minPartySize = input.minPartySize ?? null;
  if (
    minPartySize !== null &&
    (!Number.isInteger(minPartySize) || minPartySize < 1 || minPartySize > 100)
  ) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Le seuil de couverts est compris entre 1 et 100.',
    );
  }
  const cancellationHours = input.cancellationHours ?? 24;
  if (!Number.isInteger(cancellationHours) || cancellationHours < 0 || cancellationHours > 720) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'Le délai d’annulation est compris entre 0 et 720 heures.',
    );
  }
  const activeFrom = input.activeFrom ?? new Date();
  if (Number.isNaN(activeFrom.getTime())) {
    throw new ReservationPaymentInputError('PAYMENT_POLICY_INVALID', 'activeFrom est invalide.');
  }
  const activeUntil = input.activeUntil ?? null;
  if (activeUntil && (Number.isNaN(activeUntil.getTime()) || activeUntil <= activeFrom)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_POLICY_INVALID',
      'activeUntil doit être postérieur à activeFrom.',
    );
  }
  return { amount, rules: normalizeRules(input.rules), activeFrom, activeUntil };
}

export async function createReservationPaymentPolicy(
  input: CreateReservationPaymentPolicyInput,
): Promise<ReservationPaymentPolicyView> {
  const normalized = assertPolicyInput(input);
  let version = input.version;
  if (version === undefined) {
    const latest = await db.reservationPaymentPolicy.findFirst({
      where: { restaurantId: input.restaurantId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    version = (latest?.version ?? 0) + 1;
  }
  if (!Number.isInteger(version) || version < 1 || version > 10_000) {
    throw new ReservationPaymentInputError('PAYMENT_POLICY_INVALID', 'version est invalide.');
  }

  let row: PolicyRow;
  try {
    row = await db.reservationPaymentPolicy.create({
      data: {
        restaurantId: input.restaurantId,
        version,
        type: input.type,
        amountMode: input.amountMode,
        amount: normalized.amount,
        minPartySize: input.minPartySize ?? null,
        cancellationHours: input.cancellationHours ?? 24,
        rules: normalized.rules as Prisma.InputJsonValue,
        activeFrom: normalized.activeFrom,
        activeUntil: normalized.activeUntil,
      },
      select: POLICY_SELECT,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ReservationPaymentStateError('PAYMENT_POLICY_VERSION_CONFLICT');
    }
    throw error;
  }
  return serializePolicy(row);
}

export async function listReservationPaymentPolicies(
  restaurantId: string,
): Promise<ReservationPaymentPolicyView[]> {
  const rows = await db.reservationPaymentPolicy.findMany({
    where: { restaurantId },
    orderBy: [{ version: 'desc' }],
    select: POLICY_SELECT,
  });
  return rows.map(serializePolicy);
}

async function findPolicy(
  restaurantId: string,
  policyId: string | undefined,
  at: Date,
): Promise<PolicyRow> {
  const row = policyId
    ? await db.reservationPaymentPolicy.findFirst({
        where: { id: policyId, restaurantId },
        select: POLICY_SELECT,
      })
    : await db.reservationPaymentPolicy.findFirst({
        where: {
          restaurantId,
          activeFrom: { lte: at },
          OR: [{ activeUntil: null }, { activeUntil: { gt: at } }],
        },
        orderBy: { version: 'desc' },
        select: POLICY_SELECT,
      });
  if (!row) throw new ReservationPaymentPolicyNotFoundError();
  return row;
}

export async function prepareReservationPayment(input: {
  restaurantId: string;
  reservationId: string;
  policyId?: string;
  idempotencyKey: string;
  currency?: string;
  expiresAt?: Date;
  now?: Date;
  dryRun?: boolean;
}): Promise<ReservationPaymentPreparation | ReservationPaymentView> {
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = input.now ?? new Date();
  const reservation = await db.reservation.findFirst({
    where: { id: input.reservationId, restaurantId: input.restaurantId },
    select: {
      id: true,
      restaurantId: true,
      partySize: true,
      status: true,
      state: true,
    },
  });
  if (!reservation) throw new ReservationPaymentReservationNotFoundError();
  if (reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW') {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }

  const policy = await findPolicy(input.restaurantId, input.policyId, now);
  if (policy.minPartySize !== null && reservation.partySize < policy.minPartySize) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  const amount = computeReservationPaymentAmount(policy, reservation.partySize);
  const currency = normalizeCurrency(input.currency);
  const expiresAt = input.expiresAt ?? new Date(now.getTime() + 30 * 60 * 1000);
  if (
    Number.isNaN(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt > new Date(now.getTime() + 24 * 60 * 60 * 1000)
  ) {
    throw new ReservationPaymentInputError(
      'PAYMENT_EXPIRY_INVALID',
      'expiresAt doit être dans les prochaines 24 heures.',
    );
  }

  if (input.dryRun !== false) {
    return {
      id: null,
      reservationId: reservation.id,
      policyId: policy.id,
      type: policy.type,
      status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
      amount: amount.toFixed(2),
      currency,
      idempotencyKey,
      expiresAt,
      dryRun: true,
      provider: 'stripe',
      providerConfigured: false,
      requiresProviderSetup: true,
    };
  }

  const existing = await db.reservationPayment.findUnique({
    where: { idempotencyKey },
    select: PAYMENT_SELECT,
  });
  if (existing) {
    if (
      existing.restaurantId !== input.restaurantId ||
      existing.reservationId !== reservation.id ||
      existing.policyId !== policy.id ||
      !existing.amount.equals(amount) ||
      existing.currency !== currency
    ) {
      throw new ReservationPaymentStateError('PAYMENT_IDEMPOTENCY_CONFLICT');
    }
    return serializePayment(existing);
  }

  try {
    const row = await db.reservationPayment.create({
      data: {
        restaurantId: input.restaurantId,
        reservationId: reservation.id,
        policyId: policy.id,
        status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
        amount,
        currency,
        idempotencyKey,
        policySnapshot: policySnapshot(policy),
        expiresAt,
      },
      select: PAYMENT_SELECT,
    });
    return serializePayment(row);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const replay = await db.reservationPayment.findUnique({
        where: { idempotencyKey },
        select: PAYMENT_SELECT,
      });
      if (replay) {
        if (
          replay.restaurantId !== input.restaurantId ||
          replay.reservationId !== reservation.id ||
          replay.policyId !== policy.id ||
          !replay.amount.equals(amount) ||
          replay.currency !== currency
        ) {
          throw new ReservationPaymentStateError('PAYMENT_IDEMPOTENCY_CONFLICT');
        }
        return serializePayment(replay);
      }
    }
    throw error;
  }
}

export async function getReservationPayment(
  restaurantId: string,
  reservationId: string,
): Promise<ReservationPaymentView | null> {
  const row = await db.reservationPayment.findFirst({
    where: { restaurantId, reservationId },
    orderBy: [{ createdAt: 'desc' }],
    select: PAYMENT_SELECT,
  });
  return row ? serializePayment(row) : null;
}

export async function transitionReservationPayment(input: {
  restaurantId: string;
  paymentId: string;
  to: ReservationPaymentStatus;
  failureCode?: string | null;
}): Promise<ReservationPaymentView> {
  const current = await db.reservationPayment.findFirst({
    where: { id: input.paymentId, restaurantId: input.restaurantId },
    select: PAYMENT_SELECT,
  });
  if (!current) throw new ReservationPaymentNotFoundError();
  if (!canTransitionReservationPayment(current.status, input.to)) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  if (current.status === input.to) return serializePayment(current);
  const row = await db.reservationPayment.update({
    where: { id: current.id },
    data: {
      status: input.to,
      failureCode: input.failureCode ?? null,
    },
    select: PAYMENT_SELECT,
  });
  return serializePayment(row);
}

export async function applyReservationPaymentProviderEvent(
  input: ReservationPaymentProviderEventInput,
): Promise<ReservationPaymentProviderEventResult> {
  const providerEventId = normalizeProviderId(input.providerEventId, 'providerEventId');
  const eventType = normalizeProviderId(input.eventType, 'eventType');
  const payloadHash = normalizePayloadHash(input.payloadHash);

  const outcome = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM reservation_payments WHERE id = ${input.paymentId} AND restaurant_id = ${input.restaurantId} FOR UPDATE`;
    const existingEvent = await tx.reservationPaymentEvent.findUnique({
      where: { providerEventId },
      select: { id: true, paymentId: true, resultingStatus: true },
    });
    if (existingEvent) {
      return {
        result: {
          eventId: existingEvent.id,
          paymentId: existingEvent.paymentId,
          resultingStatus: existingEvent.resultingStatus,
          changed: false,
          duplicate: true,
          stale: false,
          reservationConfirmed: false,
        },
        lifecycle: null,
        reservationId: null,
      };
    }
    const payment = await tx.reservationPayment.findFirst({
      where: { id: input.paymentId, restaurantId: input.restaurantId },
      select: PAYMENT_SELECT,
    });
    if (!payment) throw new ReservationPaymentNotFoundError();
    const isGuarantee =
      snapshotType(payment.policySnapshot) === ReservationPaymentType.CARD_GUARANTEE;
    const isIntentEvent = eventType.startsWith('payment_intent.');
    const isChargeEvent = eventType.startsWith('charge.');
    // Une tentative de prélèvement refaite après un refus crée un nouveau PaymentIntent : tant que
    // l'empreinte n'est pas prélevée, la métadonnée signée suffit à rattacher l'événement.
    const sameIntent =
      !payment.stripePaymentIntentId ||
      payment.stripePaymentIntentId === input.stripePaymentIntentId;
    if (
      (input.stripeAccountId ?? null) !== payment.stripeAccountId ||
      ((isIntentEvent || isChargeEvent) && !input.stripePaymentIntentId) ||
      (isChargeEvent && input.stripePaymentIntentId !== payment.stripePaymentIntentId) ||
      (isIntentEvent &&
        !sameIntent &&
        !(isGuarantee && payment.status === ReservationPaymentStatus.AUTHORIZED)) ||
      (eventType.startsWith('setup_intent.') &&
        (!input.stripeSetupIntentId ||
          (payment.stripeSetupIntentId !== null &&
            input.stripeSetupIntentId !== payment.stripeSetupIntentId) ||
          (isGuarantee && !input.stripePaymentMethodId) ||
          (payment.stripeCustomerId !== null &&
            input.stripeCustomerId !== undefined &&
            input.stripeCustomerId !== payment.stripeCustomerId)))
    ) {
      throw new ReservationPaymentInputError(
        'PAYMENT_PROVIDER_MISMATCH',
        'Le paiement Stripe ne correspond pas au paiement enregistré.',
      );
    }

    let resultingStatus = reservationPaymentStatusForProviderEvent(eventType);
    let capturedAmount: Prisma.Decimal | undefined;
    let refundedAmount: Prisma.Decimal | undefined;
    // Montant de référence : le prélèvement réel d'une empreinte, sinon le montant préparé.
    const chargedBase = payment.capturedAmount ?? payment.amount;
    if (
      isGuarantee &&
      payment.status === ReservationPaymentStatus.AUTHORIZED &&
      (eventType === 'payment_intent.payment_failed' ||
        eventType === 'payment_intent.requires_action')
    ) {
      // Refus ou 3DS exigée hors session : la carte reste enregistrée, l'équipe peut réessayer.
      resultingStatus = sameIntent ? ReservationPaymentStatus.AUTHORIZED : null;
    } else if (
      isGuarantee &&
      eventType === 'payment_intent.canceled' &&
      payment.status === ReservationPaymentStatus.AUTHORIZED
    ) {
      resultingStatus = null;
    }
    if (eventType === 'charge.refunded') {
      if (input.refundedAmount === undefined) {
        throw new ReservationPaymentInputError(
          'PAYMENT_EVENT_INVALID',
          'Le montant remboursé est requis.',
        );
      }
      const refunded = normalizeMoney(input.refundedAmount);
      if (refunded.lte(0) || refunded.gt(chargedBase)) {
        throw new ReservationPaymentInputError(
          'PAYMENT_AMOUNT_MISMATCH',
          'Le remboursement ne correspond pas au paiement.',
        );
      }
      refundedAmount = refunded;
      resultingStatus = refunded.equals(chargedBase)
        ? ReservationPaymentStatus.REFUNDED
        : ReservationPaymentStatus.PARTIALLY_REFUNDED;
    }
    if (
      resultingStatus &&
      input.currency &&
      normalizeCurrency(input.currency) !== payment.currency
    ) {
      throw new ReservationPaymentInputError(
        'PAYMENT_CURRENCY_MISMATCH',
        'La devise du provider ne correspond pas au paiement.',
      );
    }
    if (resultingStatus && input.amount !== undefined) {
      const providerAmount = normalizeMoney(input.amount);
      const guaranteeCapture = isGuarantee && eventType === 'payment_intent.succeeded';
      const amountOk = guaranteeCapture
        ? providerAmount.lte(payment.amount) &&
          (!payment.capturedAmount || !sameIntent || providerAmount.equals(payment.capturedAmount))
        : providerAmount.equals(chargedBase);
      if (!amountOk) {
        throw new ReservationPaymentInputError(
          'PAYMENT_AMOUNT_MISMATCH',
          'Le montant du provider ne correspond pas au paiement.',
        );
      }
      if (guaranteeCapture) capturedAmount = providerAmount;
    }
    if (isGuarantee && eventType === 'payment_intent.succeeded' && !capturedAmount) {
      throw new ReservationPaymentInputError(
        'PAYMENT_AMOUNT_MISMATCH',
        'Le montant prélevé est requis.',
      );
    }
    const stale = Boolean(
      resultingStatus &&
      payment.lastProviderEventAt &&
      input.occurredAt < payment.lastProviderEventAt,
    );
    if (!resultingStatus || stale) {
      if (input.disputeStatus && eventType.startsWith('charge.dispute.')) {
        await tx.reservationPayment.update({
          where: { id: payment.id, restaurantId: payment.restaurantId },
          data: { disputeStatus: input.disputeStatus.slice(0, 40) },
        });
      }
      const event = await tx.reservationPaymentEvent.create({
        data: {
          restaurantId: input.restaurantId,
          paymentId: payment.id,
          providerEventId,
          eventType,
          resultingStatus: stale ? payment.status : null,
          payloadHash,
          occurredAt: input.occurredAt,
        },
        select: { id: true },
      });
      return {
        result: {
          eventId: event.id,
          paymentId: payment.id,
          resultingStatus: stale ? payment.status : null,
          changed: false,
          duplicate: false,
          stale,
          reservationConfirmed: false,
          ignoredReason: stale ? ('STALE_EVENT' as const) : ('UNSUPPORTED_EVENT' as const),
        },
        lifecycle: null,
        reservationId: null,
      };
    }
    if (!canTransitionReservationPayment(payment.status, resultingStatus)) {
      throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
    }
    await tx.reservationPayment.update({
      where: { id: payment.id },
      data: {
        status: resultingStatus,
        lastProviderEventAt: input.occurredAt,
        ...(input.failureCode ? { failureCode: input.failureCode.slice(0, 120) } : {}),
        ...(eventType === 'setup_intent.succeeded'
          ? {
              stripeSetupIntentId: input.stripeSetupIntentId,
              ...(input.stripePaymentMethodId
                ? { stripePaymentMethodId: input.stripePaymentMethodId }
                : {}),
              ...(input.stripeCustomerId ? { stripeCustomerId: input.stripeCustomerId } : {}),
            }
          : {}),
        ...(capturedAmount
          ? {
              capturedAmount,
              stripePaymentIntentId: input.stripePaymentIntentId,
              failureCode: null,
            }
          : {}),
        ...(refundedAmount ? { refundedAmount } : {}),
      },
    });
    const event = await tx.reservationPaymentEvent.create({
      data: {
        restaurantId: input.restaurantId,
        paymentId: payment.id,
        providerEventId,
        eventType,
        resultingStatus,
        payloadHash,
        occurredAt: input.occurredAt,
      },
      select: { id: true },
    });
    let lifecycle: ReservationLifecycleResult | null = null;
    if (
      resultingStatus === ReservationPaymentStatus.AUTHORIZED ||
      resultingStatus === ReservationPaymentStatus.CAPTURED
    ) {
      lifecycle = await reservationLifecycle.transitionInTransaction(tx, {
        reservationId: payment.reservationId,
        restaurantId: input.restaurantId,
        toState: 'CONFIRMED',
        onlyIfFromState: 'PENDING',
        actor: 'payment:provider-webhook',
        auditEvent: 'reservation_confirmed',
        operation: 'confirmation',
        observationSource: 'direct',
        metadata: {
          paymentId: payment.id,
          providerEventId,
          resultingPaymentStatus: resultingStatus,
        },
      });
    }
    return {
      result: {
        eventId: event.id,
        paymentId: payment.id,
        resultingStatus,
        changed: payment.status !== resultingStatus,
        duplicate: false,
        stale: false,
        reservationConfirmed: lifecycle?.mutated === true,
      },
      lifecycle,
      reservationId: payment.reservationId,
    };
  });
  if (outcome.lifecycle && outcome.reservationId) {
    await reservationLifecycle.finalizeTransition(
      {
        reservationId: outcome.reservationId,
        restaurantId: input.restaurantId,
        toState: 'CONFIRMED',
        actor: 'payment:provider-webhook',
        operation: 'confirmation',
        observationSource: 'direct',
      },
      outcome.lifecycle,
    );
  }
  return outcome.result;
}

export const RESERVATION_GUARANTEE_METADATA_TYPE = 'reservation_guarantee';
/** L'équipe peut prélever jusqu'à 7 jours après l'heure de la réservation (spec §4). */
export const GUARANTEE_CAPTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Stripe refuse une session Checkout qui expire dans moins de 30 minutes. */
const CHECKOUT_MIN_LIFETIME_MS = 31 * 60 * 1000;

const OPEN_PAYMENT_STATUSES = [
  ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
  ReservationPaymentStatus.REQUIRES_ACTION,
];

function guaranteeMetadata(payment: {
  id: string;
  restaurantId: string;
  reservationId: string;
}): Record<string, string> {
  return {
    type: RESERVATION_GUARANTEE_METADATA_TYPE,
    restaurantId: payment.restaurantId,
    reservationPaymentId: payment.id,
    reservationId: payment.reservationId,
  };
}

function toCents(amount: Prisma.Decimal): number {
  return amount.mul(100).toDecimalPlaces(0).toNumber();
}

const GUARANTEE_SELECT = {
  ...PAYMENT_SELECT,
  updatedAt: true,
  reservation: {
    select: { status: true, state: true, startsAt: true, reservedAt: true, customerEmail: true },
  },
} as const;

/**
 * Écrit l'empreinte d'une réservation qui vient d'être créée `PENDING`, dans la transaction de
 * création. Le montant et le délai annoncés au client sont figés dans le snapshot.
 */
export async function createCardGuaranteePaymentInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    reservationId: string;
    policyId: string;
    partySize: number;
    expiresAt: Date;
  },
): Promise<string> {
  const policy = await tx.reservationPaymentPolicy.findFirst({
    where: { id: input.policyId, restaurantId: input.restaurantId },
    select: POLICY_SELECT,
  });
  if (!policy || policy.type !== ReservationPaymentType.CARD_GUARANTEE) {
    throw new ReservationPaymentPolicyNotFoundError();
  }
  const row = await tx.reservationPayment.create({
    data: {
      restaurantId: input.restaurantId,
      reservationId: input.reservationId,
      policyId: policy.id,
      status: ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD,
      amount: computeReservationPaymentAmount(policy, input.partySize),
      currency: 'EUR',
      idempotencyKey: `card-guarantee:${input.reservationId}`,
      policySnapshot: policySnapshot(policy),
      expiresAt: input.expiresAt,
    },
    select: { id: true },
  });
  return row.id;
}

async function findGuarantee(
  restaurantId: string,
  target: { id: string } | { reservationId: string },
) {
  const row = await db.reservationPayment.findFirst({
    where: { restaurantId, ...target },
    orderBy: [{ createdAt: 'desc' }],
    select: GUARANTEE_SELECT,
  });
  if (!row) throw new ReservationPaymentNotFoundError();
  if (snapshotType(row.policySnapshot) !== ReservationPaymentType.CARD_GUARANTEE) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  return row;
}

/**
 * Ouvre la page Stripe d'enregistrement de carte pour une empreinte en attente. Chaque appel
 * ouvre une session neuve (lien SMS cliqué plusieurs fois) et ferme la précédente.
 */
export async function startCardGuaranteeSetup(input: {
  restaurantId: string;
  paymentId: string;
  successUrl: string;
  cancelUrl: string;
  customText: string;
  termsAcceptedAt: Date;
  now?: Date;
}): Promise<{ url: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const payment = await findGuarantee(input.restaurantId, { id: input.paymentId });
  if (
    payment.status !== ReservationPaymentStatus.REQUIRES_PAYMENT_METHOD ||
    !payment.expiresAt ||
    payment.expiresAt <= now
  ) {
    throw new ReservationPaymentStateError('PAYMENT_TRANSITION_INVALID');
  }
  const restaurant = await db.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: { giftCardStripeAccountId: true },
  });
  const accountId = restaurant?.giftCardStripeAccountId ?? null;
  if (!accountId || (payment.stripeAccountId && payment.stripeAccountId !== accountId)) {
    throw new ReservationPaymentStateError('PAYMENT_PROVIDER_NOT_READY');
  }
  const account = await retrieveConnectedAccount(accountId);
  if (!account.chargesEnabled) throw new ReservationPaymentStateError('PAYMENT_PROVIDER_NOT_READY');

  if (payment.stripeCheckoutSessionId) {
    await expireExperienceCheckoutSession(payment.stripeCheckoutSessionId, accountId).catch(
      (error: unknown) =>
        logger.warn(
          { paymentId: payment.id, err: error instanceof Error ? error.message : String(error) },
          'reservation guarantee: previous checkout session not expired',
        ),
    );
  }
  const sessionExpiresAt = new Date(
    Math.max(payment.expiresAt.getTime(), now.getTime() + CHECKOUT_MIN_LIFETIME_MS),
  );
  const session = await createReservationGuaranteeSetupSession({
    stripeAccountId: accountId,
    stripeCustomerId: payment.stripeCustomerId,
    metadata: guaranteeMetadata(payment),
    customerEmail: payment.reservation.customerEmail,
    successUrl: input.successUrl,
    cancelUrl: input.cancelUrl,
    expiresAt: sessionExpiresAt,
    customText: input.customText,
    customerIdempotencyKey: `reservation-guarantee-customer:${payment.id}`,
    idempotencyKey: `reservation-guarantee-setup:${payment.id}:${now.getTime()}`,
  });
  await db.reservationPayment.update({
    where: { id: payment.id, restaurantId: payment.restaurantId },
    data: {
      stripeAccountId: accountId,
      stripeCustomerId: session.customerId,
      stripeCheckoutSessionId: session.sessionId,
      termsAcceptedAt: payment.termsAcceptedAt ?? input.termsAcceptedAt,
    },
  });
  return { url: session.url, expiresAt: payment.expiresAt };
}

export type CardGuaranteeCaptureResult =
  | { outcome: 'PENDING_CONFIRMATION'; amount: string }
  | { outcome: 'DECLINED'; failureCode: string };

/**
 * Prélève une empreinte sur décision de l'équipe, après une absence. Le statut `CAPTURED`
 * n'est écrit que par le webhook `payment_intent.succeeded`.
 */
export async function captureCardGuarantee(input: {
  restaurantId: string;
  reservationId: string;
  actorUserId: string;
  amount?: string | number;
  now?: Date;
}): Promise<CardGuaranteeCaptureResult> {
  const now = input.now ?? new Date();
  const payment = await findGuarantee(input.restaurantId, { reservationId: input.reservationId });
  const reservationAt = payment.reservation.startsAt ?? payment.reservation.reservedAt;
  // Une annulation dans le délai gratuit ferme l'empreinte (`CANCELLED`) : une réservation annulée
  // dont l'empreinte est encore `AUTHORIZED` a donc été annulée trop tard.
  if (
    payment.status !== ReservationPaymentStatus.AUTHORIZED ||
    !payment.stripeAccountId ||
    !payment.stripeCustomerId ||
    !payment.stripePaymentMethodId ||
    (payment.reservation.status !== 'NO_SHOW' && payment.reservation.status !== 'CANCELLED') ||
    now.getTime() > reservationAt.getTime() + GUARANTEE_CAPTURE_WINDOW_MS
  ) {
    throw new ReservationPaymentStateError('PAYMENT_CAPTURE_NOT_ALLOWED');
  }
  if (payment.capturedAmount && !payment.failureCode) {
    throw new ReservationPaymentStateError('PAYMENT_CAPTURE_IN_PROGRESS');
  }
  const amount = input.amount === undefined ? payment.amount : normalizeMoney(input.amount);
  if (amount.gt(payment.amount)) {
    throw new ReservationPaymentInputError(
      'PAYMENT_AMOUNT_INVALID',
      'Le montant dépasse l’empreinte annoncée au client.',
    );
  }
  const result = await chargeReservationGuarantee({
    stripeAccountId: payment.stripeAccountId,
    stripeCustomerId: payment.stripeCustomerId,
    stripePaymentMethodId: payment.stripePaymentMethodId,
    amountCents: toCents(amount),
    currency: payment.currency,
    metadata: guaranteeMetadata(payment),
    receiptEmail: payment.reservation.customerEmail,
    // updatedAt change après chaque refus : un double clic est dédoublonné, un nouvel essai non.
    idempotencyKey: `reservation-guarantee-capture:${payment.id}:${payment.updatedAt.getTime()}`,
  });
  await db.reservationPayment.update({
    where: { id: payment.id, restaurantId: payment.restaurantId },
    data: result.ok
      ? {
          stripePaymentIntentId: result.paymentIntentId,
          capturedAmount: amount,
          capturedByUserId: input.actorUserId,
          failureCode: null,
        }
      : {
          ...(result.paymentIntentId ? { stripePaymentIntentId: result.paymentIntentId } : {}),
          capturedAmount: null,
          failureCode: result.failureCode,
        },
  });
  return result.ok
    ? { outcome: 'PENDING_CONFIRMATION', amount: amount.toFixed(2) }
    : { outcome: 'DECLINED', failureCode: result.failureCode };
}

/** Rembourse tout ou partie d'un prélèvement. `charge.refunded` met le statut à jour. */
export async function refundCardGuarantee(input: {
  restaurantId: string;
  reservationId: string;
  amount?: string | number;
}): Promise<{ refundId: string; amount: string }> {
  const payment = await findGuarantee(input.restaurantId, { reservationId: input.reservationId });
  const captured = payment.capturedAmount;
  const remaining = captured?.sub(payment.refundedAmount ?? 0);
  const amount = input.amount === undefined ? remaining : normalizeMoney(input.amount);
  if (
    (payment.status !== ReservationPaymentStatus.CAPTURED &&
      payment.status !== ReservationPaymentStatus.PARTIALLY_REFUNDED) ||
    !payment.stripePaymentIntentId ||
    !payment.stripeAccountId ||
    !remaining ||
    !amount ||
    amount.lte(0) ||
    amount.gt(remaining)
  ) {
    throw new ReservationPaymentStateError('PAYMENT_REFUND_NOT_ALLOWED');
  }
  const refund = await createRefund({
    paymentIntentId: payment.stripePaymentIntentId,
    amount: toCents(amount),
    stripeAccountId: payment.stripeAccountId,
    idempotencyKey: `reservation-guarantee-refund:${payment.id}:${payment.updatedAt.getTime()}:${toCents(amount)}`,
  });
  return { refundId: refund.id, amount: amount.toFixed(2) };
}

/**
 * Expire les empreintes non enregistrées à temps et libère la place tenue (`PENDING` →
 * `EXPIRED`) dans la même transaction, puis ferme la page Stripe encore ouverte.
 */
export async function expireReservationPayments(now = new Date(), limit = 200): Promise<number> {
  const due = await db.reservationPayment.findMany({
    where: { status: { in: OPEN_PAYMENT_STATUSES }, expiresAt: { lte: now } },
    orderBy: [{ expiresAt: 'asc' }],
    take: limit,
    select: {
      id: true,
      restaurantId: true,
      reservationId: true,
      stripeAccountId: true,
      stripeCheckoutSessionId: true,
    },
  });
  let expired = 0;
  for (const row of due) {
    const transition = {
      reservationId: row.reservationId,
      restaurantId: row.restaurantId,
      toState: 'EXPIRED' as const,
      onlyIfFromState: 'PENDING' as const,
      actor: 'payment:expiry-worker',
      operation: 'release' as const,
      observationSource: 'worker' as const,
      metadata: { paymentId: row.id },
    };
    const lifecycle = await db.$transaction(async (tx) => {
      // Garde contre un webhook arrivé entre la lecture et l'écriture.
      const updated = await tx.reservationPayment.updateMany({
        where: { id: row.id, status: { in: OPEN_PAYMENT_STATUSES } },
        data: { status: ReservationPaymentStatus.EXPIRED },
      });
      if (updated.count === 0) return null;
      return reservationLifecycle.transitionInTransaction(tx, transition);
    });
    if (!lifecycle) continue;
    expired += 1;
    await reservationLifecycle.finalizeTransition(transition, lifecycle);
    if (row.stripeCheckoutSessionId && row.stripeAccountId) {
      await expireExperienceCheckoutSession(row.stripeCheckoutSessionId, row.stripeAccountId).catch(
        (error: unknown) =>
          logger.warn(
            { paymentId: row.id, err: error instanceof Error ? error.message : String(error) },
            'reservation guarantee: checkout session not expired',
          ),
      );
    }
  }
  return expired;
}

export { PAYMENT_SELECT, POLICY_SELECT, serializePayment, serializePolicy };
