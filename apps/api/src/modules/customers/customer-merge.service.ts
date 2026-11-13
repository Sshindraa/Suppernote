import { createHash } from 'node:crypto';
import {
  MarketingPermissionStatus,
  Prisma,
  type CustomerIdentity,
  type CustomerMetricSnapshot,
} from '@prisma/client';
import { db } from '../../shared/db/client';
import { redisCache } from '../../shared/redis/client';
import { loadCustomerVisitStats } from './customer-lifecycle';
import {
  CUSTOMER_PREFERENCE_KEYS,
  normalizeCustomerEmail,
  normalizeCustomerPhone,
} from './customer-crm.service';

const MAX_SOURCE_CUSTOMERS = 5;
const MAX_DUPLICATE_SCAN = 10_000;
const MAX_DUPLICATE_GROUP_SIZE = 100;
const MAX_MERGE_RETRIES = 5;

export type CustomerMergePreferenceResolution = 'target' | 'source' | 'latest';

export type CustomerMergeSummary = {
  sourceCount: number;
  sourceProfilesArchived: number;
  reservationsMoved: number;
  giftCardsMoved: number;
  experienceReservationsMoved: number;
  reputationFeedbackRequestsMoved: number;
  reputationFeedbacksMoved: number;
  reputationRecoveryTasksMoved: number;
  loyaltyGrantsMoved: number;
  consentsReassigned: number;
  identitiesMoved: number;
  identitiesDeduplicated: number;
  timelineEventsMoved: number;
  preferencesMoved: number;
  preferencesDeduplicated: number;
  preferencesResolved: number;
  tagsMoved: number;
  tagsDeduplicated: number;
  permissionsMoved: number;
  permissionsMerged: number;
  permissionEventsReassigned: number;
  suppressionsMoved: number;
  suppressionsMerged: number;
  automationDispatchesMoved: number;
  automationDispatchesMerged: number;
  frequencyWindowsMoved: number;
  frequencyWindowsMerged: number;
  attributionLinksMoved: number;
  attributionLinksMerged: number;
  campaignAudienceMembersMoved: number;
  campaignAudienceConflictsKept: number;
  campaignMessagesReassigned: number;
  conversionsReassigned: number;
  metricSnapshotsRebuilt: number;
  profileConflictsTargetWon: number;
};

export type CustomerMergeAuditResult = {
  auditId: string;
  targetCustomerId: string;
  sourceCustomerIds: string[];
  summary: CustomerMergeSummary;
  replayed: boolean;
};

export class CustomerMergeError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = 'CustomerMergeError';
  }
}

const mergeCustomerSelect = {
  id: true,
  restaurantId: true,
  phone: true,
  emailNormalized: true,
  feedbackEmailOptOutAt: true,
  feedbackEmailRequestedAt: true,
  birthMonth: true,
  birthDay: true,
  preferredLocale: true,
  mergedIntoId: true,
  archivedAt: true,
  name: true,
  isVip: true,
  notes: true,
  specialOccasion: true,
  lastSeenAt: true,
  lastCallAt: true,
  partySizeTypical: true,
  createdAt: true,
  updatedAt: true,
  identities: true,
  preferences: true,
  metricSnapshot: true,
  tagAssignments: { include: { tag: true } },
} satisfies Prisma.CustomerSelect;

type MergeCustomerRow = Prisma.CustomerGetPayload<{ select: typeof mergeCustomerSelect }>;

type MergeReservation = { id: string; customerId: string | null };
type MergeGiftCard = { id: string; customerId: string | null };
type MergeConsent = { id: string; customerId: string | null };
type MergeTimelineEvent = { id: string; customerId: string };
type MergePermission = {
  id: string;
  customerId: string;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP';
  status: MarketingPermissionStatus;
  source: string;
  proofVersion: string | null;
  proofHash: string | null;
  consentedAt: Date | null;
  withdrawnAt: Date | null;
};
type MergePermissionEvent = { id: string; customerId: string; permissionId: string | null };
type MergeSuppression = {
  id: string;
  customerId: string;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP' | null;
  reason: string;
  expiresAt: Date | null;
};
type MergeDispatch = {
  id: string;
  customerId: string;
  automationId: string;
  triggerKey: string;
  status: 'QUEUED' | 'SENT' | 'SKIPPED' | 'FAILED';
  reasonCode: string | null;
  occurredAt: Date;
};
type MergeAudience = {
  id: string;
  campaignId: string;
  customerId: string;
  message: { id: string; customerId: string } | null;
};
type MergeMessage = {
  id: string;
  campaignId: string;
  audienceMemberId: string;
  customerId: string;
};
type MergeConversion = { id: string; customerId: string };
type MergeFrequencyWindow = {
  id: string;
  customerId: string;
  channel: 'SMS' | 'EMAIL' | 'WHATSAPP';
  windowStart: Date;
  windowEnd: Date;
  sendCount: number;
};
type MergeAttributionLink = {
  id: string;
  customerId: string;
  campaignId: string;
  clickedAt: Date | null;
};

type MergeDb = Prisma.TransactionClient;

type MergeContext = {
  customers: MergeCustomerRow[];
  reservations: MergeReservation[];
  giftCards: MergeGiftCard[];
  consents: MergeConsent[];
  timelineEvents: MergeTimelineEvent[];
  permissions: MergePermission[];
  permissionEvents: MergePermissionEvent[];
  suppressions: MergeSuppression[];
  dispatches: MergeDispatch[];
  audiences: MergeAudience[];
  messages: MergeMessage[];
  conversions: MergeConversion[];
  frequencyWindows: MergeFrequencyWindow[];
  attributionLinks: MergeAttributionLink[];
};

export type DuplicateReason = {
  code: 'PHONE_MATCH' | 'EMAIL_MATCH' | 'NAME_MATCH';
  points: number;
  label: string;
};

export type DuplicateCandidate = {
  id: string;
  score: number;
  reasons: DuplicateReason[];
  left: DuplicateCustomerSummary;
  right: DuplicateCustomerSummary;
};

export type DuplicateCustomerSummary = {
  id: string;
  name: string | null;
  phone: string;
  emailNormalized: string | null;
  /** Honoured visits from the reservations; set on the duplicate list. */
  visits?: number;
  isVip: boolean;
  archivedAt: Date | null;
};

export type CustomerMergePreview = {
  target: DuplicateCustomerSummary & { notes: string | null };
  sources: Array<DuplicateCustomerSummary & { notes: string | null }>;
  conflicts: {
    identities: Array<{
      type: string;
      normalizedValue: string;
      customerIds: string[];
    }>;
    preferences: Array<{
      key: string;
      values: Array<{ customerId: string; value: unknown; updatedAt: string }>;
      resolutionRequired: true;
    }>;
    profileFields: Array<{
      field: string;
      values: Array<{ customerId: string; value: unknown }>;
      resolution: 'target_wins';
    }>;
    permissions: Array<{
      channel: string;
      statuses: Array<{ customerId: string; status: string }>;
      restrictiveStatus: string;
    }>;
    campaignAudience: Array<{ campaignId: string; customerIds: string[] }>;
  };
  impact: {
    reservations: number;
    giftCards: number;
    timelineEvents: number;
    identities: number;
    preferences: number;
    tags: number;
    permissions: number;
    marketingMessages: number;
    conversions: number;
  };
};

function normalizeIds(ids: string[]): string[] {
  const normalized = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean)));
  if (normalized.length === 0) throw new CustomerMergeError('MERGE_SOURCES_REQUIRED');
  if (normalized.length > MAX_SOURCE_CUSTOMERS) {
    throw new CustomerMergeError('MERGE_TOO_MANY_SOURCES');
  }
  return normalized.sort();
}

function normalizeResolution(
  input: Record<string, CustomerMergePreferenceResolution> | undefined,
): Record<string, CustomerMergePreferenceResolution> {
  const result: Record<string, CustomerMergePreferenceResolution> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!(CUSTOMER_PREFERENCE_KEYS as readonly string[]).includes(key)) {
      throw new CustomerMergeError('MERGE_PREFERENCE_KEY_INVALID');
    }
    if (!['target', 'source', 'latest'].includes(value)) {
      throw new CustomerMergeError('MERGE_PREFERENCE_RESOLUTION_INVALID');
    }
    result[key] = value;
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function hashPayload(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function hashActor(value: string | undefined): string {
  return hashPayload(value?.trim() || 'unknown');
}

function toArray<T>(value: T[] | null | undefined): T[] {
  return value ?? [];
}

function countFor<T extends { customerId: string | null }>(rows: T[], ids: Set<string>): number {
  return rows.filter((row) => row.customerId !== null && ids.has(row.customerId)).length;
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Conflit de sérialisation à rejouer. Le verrou `FOR UPDATE` passe par `$queryRaw` : PostgreSQL y renvoie
 * 40001 sous le code Prisma P2010 (requête brute), pas P2034. Preuve : customer-crm.concurrency.integration.test.ts.
 */
function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2034' || error.code === 'P2028') return true;
  const meta = error.meta as { code?: unknown } | undefined;
  return error.code === 'P2010' && (meta?.code === '40001' || error.message.includes('40001'));
}

function maxDate(values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((current, value) => {
    if (!value) return current;
    return !current || value > current ? value : current;
  }, null);
}

function minDate(values: Array<Date | null | undefined>): Date | null {
  return values.reduce<Date | null>((current, value) => {
    if (!value) return current;
    return !current || value < current ? value : current;
  }, null);
}

function decimalSum(values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>((total, value) => {
    if (value === null || value === undefined) return total;
    return total.add(value);
  }, new Prisma.Decimal(0));
}

function decimalOrNull(values: Array<Prisma.Decimal | null | undefined>): Prisma.Decimal | null {
  return values.some((value) => value !== null && value !== undefined) ? decimalSum(values) : null;
}

function normalizeName(name: string | null): string | null {
  if (!name?.trim()) return null;
  return name
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function identityKey(type: string, normalizedValue: string): string {
  return `${type}:${normalizedValue}`;
}

function customerIdentityKeys(customer: {
  phone: string;
  emailNormalized: string | null;
  identities?: Array<Pick<CustomerIdentity, 'type' | 'normalizedValue'>>;
}): Array<{ type: string; normalizedValue: string }> {
  const keys = new Map<string, { type: string; normalizedValue: string }>();
  const phone = normalizeCustomerPhone(customer.phone);
  if (phone) keys.set(identityKey('PHONE', phone), { type: 'PHONE', normalizedValue: phone });
  const email = customer.emailNormalized ? normalizeCustomerEmail(customer.emailNormalized) : null;
  if (email) keys.set(identityKey('EMAIL', email), { type: 'EMAIL', normalizedValue: email });
  for (const identity of customer.identities ?? []) {
    keys.set(identityKey(identity.type, identity.normalizedValue), {
      type: identity.type,
      normalizedValue: identity.normalizedValue,
    });
  }
  return Array.from(keys.values());
}

function duplicateSummary(customer: {
  id: string;
  name: string | null;
  phone: string;
  emailNormalized: string | null;
  isVip: boolean;
  archivedAt: Date | null;
}): DuplicateCustomerSummary {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    emailNormalized: customer.emailNormalized,
    isVip: customer.isVip,
    archivedAt: customer.archivedAt,
  };
}

/**
 * Build an explainable duplicate list. Name similarity is only an extra
 * signal: a pair must share a normalized phone or email before it can appear.
 */
export function buildDuplicateCandidates(
  customers: Array<{
    id: string;
    name: string | null;
    phone: string;
    emailNormalized: string | null;
    isVip: boolean;
    archivedAt: Date | null;
    identities?: Array<Pick<CustomerIdentity, 'type' | 'normalizedValue'>>;
  }>,
): DuplicateCandidate[] {
  const active = customers.filter((customer) => !customer.archivedAt);
  const identityGroups = new Map<string, typeof active>();
  for (const customer of active) {
    for (const identity of customerIdentityKeys(customer)) {
      const group = identityGroups.get(identityKey(identity.type, identity.normalizedValue)) ?? [];
      // Keep one sentinel row beyond the cap so very common values (shared
      // placeholders, test numbers, etc.) are skipped instead of generating
      // an O(n²) list of false-positive pairs.
      if (group.length <= MAX_DUPLICATE_GROUP_SIZE) group.push(customer);
      identityGroups.set(identityKey(identity.type, identity.normalizedValue), group);
    }
  }

  const pairSignals = new Map<string, DuplicateReason[]>();
  for (const [key, group] of identityGroups) {
    const [type] = key.split(':', 1);
    if (group.length < 2 || group.length > MAX_DUPLICATE_GROUP_SIZE) continue;
    for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
        const left = group[leftIndex]!;
        const right = group[rightIndex]!;
        const [first, second] = [left.id, right.id].sort();
        const pairId = `${first}:${second}`;
        const reasons = pairSignals.get(pairId) ?? [];
        if (type === 'PHONE' && !reasons.some((reason) => reason.code === 'PHONE_MATCH')) {
          reasons.push({ code: 'PHONE_MATCH', points: 80, label: 'Téléphone normalisé identique' });
        }
        if (type === 'EMAIL' && !reasons.some((reason) => reason.code === 'EMAIL_MATCH')) {
          reasons.push({ code: 'EMAIL_MATCH', points: 70, label: 'Email normalisé identique' });
        }
        pairSignals.set(pairId, reasons);
      }
    }
  }

  const candidates: DuplicateCandidate[] = [];
  for (const [id, reasons] of pairSignals) {
    const [leftId, rightId] = id.split(':');
    const left = active.find((customer) => customer.id === leftId);
    const right = active.find((customer) => customer.id === rightId);
    if (!left || !right) continue;
    if (normalizeName(left.name) && normalizeName(left.name) === normalizeName(right.name)) {
      reasons.push({ code: 'NAME_MATCH', points: 10, label: 'Nom normalisé identique' });
    }
    const score = Math.min(
      100,
      reasons.reduce((total, reason) => total + reason.points, 0),
    );
    candidates.push({
      id,
      score,
      reasons,
      left: duplicateSummary(left),
      right: duplicateSummary(right),
    });
  }
  return candidates.sort(
    (left, right) => right.score - left.score || left.id.localeCompare(right.id),
  );
}

async function loadMergeContext(
  client: MergeDb,
  restaurantId: string,
  customerIds: string[],
): Promise<MergeContext> {
  const where = { restaurantId, customerId: { in: customerIds } };
  const customers = await client.customer.findMany({
    where: { restaurantId, id: { in: customerIds } },
    select: mergeCustomerSelect,
  });
  const [
    reservations,
    giftCards,
    consents,
    timelineEvents,
    permissions,
    permissionEvents,
    suppressions,
    dispatches,
  ] = await Promise.all([
    client.reservation.findMany({ where, select: { id: true, customerId: true } }),
    client.giftCard.findMany({ where, select: { id: true, customerId: true } }),
    client.customerConsent.findMany({ where, select: { id: true, customerId: true } }),
    client.customerTimelineEvent.findMany({ where, select: { id: true, customerId: true } }),
    client.marketingPermission.findMany({
      where,
      select: {
        id: true,
        customerId: true,
        channel: true,
        status: true,
        source: true,
        proofVersion: true,
        proofHash: true,
        consentedAt: true,
        withdrawnAt: true,
      },
    }),
    client.marketingPermissionEvent.findMany({
      where,
      select: { id: true, customerId: true, permissionId: true },
    }),
    client.marketingSuppression.findMany({
      where,
      select: { id: true, customerId: true, channel: true, reason: true, expiresAt: true },
    }),
    client.marketingAutomationDispatch.findMany({
      where,
      select: {
        id: true,
        customerId: true,
        automationId: true,
        triggerKey: true,
        status: true,
        reasonCode: true,
        occurredAt: true,
      },
    }),
  ]);
  const [audiences, messages, conversions, frequencyWindows, attributionLinks] = await Promise.all([
    client.campaignAudienceMember.findMany({
      where: {
        customerId: { in: customerIds },
        campaign: { restaurantId },
      },
      select: {
        id: true,
        campaignId: true,
        customerId: true,
        message: { select: { id: true, customerId: true } },
      },
    }),
    client.campaignMessage.findMany({
      where: {
        customerId: { in: customerIds },
        campaign: { restaurantId },
      },
      select: { id: true, campaignId: true, audienceMemberId: true, customerId: true },
    }),
    client.marketingConversion.findMany({
      where: {
        customerId: { in: customerIds },
        campaign: { restaurantId },
      },
      select: { id: true, customerId: true },
    }),
    client.marketingFrequencyWindow.findMany({
      where,
      select: {
        id: true,
        customerId: true,
        channel: true,
        windowStart: true,
        windowEnd: true,
        sendCount: true,
      },
    }),
    client.marketingAttributionLink.findMany({
      where,
      select: { id: true, customerId: true, campaignId: true, clickedAt: true },
    }),
  ]);

  return {
    customers: toArray(customers),
    reservations: toArray(reservations) as MergeReservation[],
    giftCards: toArray(giftCards) as MergeGiftCard[],
    consents: toArray(consents) as MergeConsent[],
    timelineEvents: toArray(timelineEvents) as MergeTimelineEvent[],
    permissions: toArray(permissions) as MergePermission[],
    permissionEvents: toArray(permissionEvents) as MergePermissionEvent[],
    suppressions: toArray(suppressions) as MergeSuppression[],
    dispatches: toArray(dispatches) as MergeDispatch[],
    audiences: toArray(audiences) as MergeAudience[],
    messages: toArray(messages) as MergeMessage[],
    conversions: toArray(conversions) as MergeConversion[],
    frequencyWindows: toArray(frequencyWindows) as MergeFrequencyWindow[],
    attributionLinks: toArray(attributionLinks) as MergeAttributionLink[],
  };
}

function assertMergeContext(
  context: MergeContext,
  restaurantId: string,
  targetCustomerId: string,
  sourceCustomerIds: string[],
): { target: MergeCustomerRow; sources: MergeCustomerRow[] } {
  if (sourceCustomerIds.includes(targetCustomerId)) {
    throw new CustomerMergeError('MERGE_TARGET_IN_SOURCES');
  }
  const expectedIds = new Set([targetCustomerId, ...sourceCustomerIds]);
  const byId = new Map(context.customers.map((customer) => [customer.id, customer]));
  if (byId.size !== expectedIds.size || Array.from(expectedIds).some((id) => !byId.has(id))) {
    throw new CustomerMergeError('CUSTOMER_NOT_FOUND');
  }
  const target = byId.get(targetCustomerId)!;
  const sources = sourceCustomerIds.map((id) => byId.get(id)!);
  if ([target, ...sources].some((customer) => customer.restaurantId !== restaurantId)) {
    throw new CustomerMergeError('CRM_TENANT_MISMATCH');
  }
  if ([target, ...sources].some((customer) => customer.archivedAt || customer.mergedIntoId)) {
    throw new CustomerMergeError('CUSTOMER_NOT_ACTIVE');
  }
  return { target, sources };
}

function summaryForCustomer(
  customer: MergeCustomerRow,
): DuplicateCustomerSummary & { notes: string | null } {
  return {
    ...duplicateSummary(customer),
    notes: customer.notes,
  };
}

function groupedPreferenceConflicts(customers: MergeCustomerRow[]) {
  const groups = new Map<string, Array<{ customerId: string; value: unknown; updatedAt: Date }>>();
  for (const customer of customers) {
    for (const preference of customer.preferences) {
      const values = groups.get(preference.key) ?? [];
      values.push({
        customerId: customer.id,
        value: preference.value,
        updatedAt: preference.updatedAt,
      });
      groups.set(preference.key, values);
    }
  }
  return Array.from(groups.entries())
    .filter(([, values]) => new Set(values.map((value) => stableStringify(value.value))).size > 1)
    .map(([key, values]) => ({
      key,
      values: values.map((value) => ({
        customerId: value.customerId,
        value: value.value,
        updatedAt: value.updatedAt.toISOString(),
      })),
      resolutionRequired: true as const,
    }));
}

function buildProfileConflicts(customers: MergeCustomerRow[]) {
  const fields: Array<
    keyof Pick<
      MergeCustomerRow,
      | 'name'
      | 'emailNormalized'
      | 'birthMonth'
      | 'birthDay'
      | 'preferredLocale'
      | 'specialOccasion'
      | 'notes'
    >
  > = [
    'name',
    'emailNormalized',
    'birthMonth',
    'birthDay',
    'preferredLocale',
    'specialOccasion',
    'notes',
  ];
  return fields.flatMap((field) => {
    const values = customers
      .map((customer) => ({ customerId: customer.id, value: customer[field] }))
      .filter(({ value }) => value !== null && value !== undefined && value !== '');
    if (new Set(values.map(({ value }) => stableStringify(value))).size <= 1) return [];
    return [{ field, values, resolution: 'target_wins' as const }];
  });
}

function buildPermissionConflicts(customers: MergeCustomerRow[], permissions: MergePermission[]) {
  const customerIds = new Set(customers.map((customer) => customer.id));
  const groups = new Map<
    string,
    Array<{ customerId: string; status: MarketingPermissionStatus }>
  >();
  for (const permission of permissions) {
    if (!customerIds.has(permission.customerId)) continue;
    const values = groups.get(permission.channel) ?? [];
    values.push({ customerId: permission.customerId, status: permission.status });
    groups.set(permission.channel, values);
  }
  return Array.from(groups.entries())
    .filter(([, values]) => new Set(values.map((value) => value.status)).size > 1)
    .map(([channel, values]) => ({
      channel,
      statuses: values.map((value) => ({ customerId: value.customerId, status: value.status })),
      restrictiveStatus: values.reduce<MarketingPermissionStatus>(
        (current, value) => moreRestrictiveStatus(current, value.status),
        MarketingPermissionStatus.OPTED_IN,
      ),
    }));
}

function buildIdentityConflicts(customers: MergeCustomerRow[]) {
  const groups = new Map<string, string[]>();
  for (const customer of customers) {
    for (const identity of customerIdentityKeys(customer)) {
      const key = identityKey(identity.type, identity.normalizedValue);
      const ids = groups.get(key) ?? [];
      if (!ids.includes(customer.id)) ids.push(customer.id);
      groups.set(key, ids);
    }
  }
  return Array.from(groups.entries())
    .filter(([, customerIds]) => customerIds.length > 1)
    .map(([key, customerIds]) => {
      const separator = key.indexOf(':');
      return {
        type: key.slice(0, separator),
        normalizedValue: key.slice(separator + 1),
        customerIds,
      };
    });
}

function buildCampaignAudienceConflicts(
  targetCustomerId: string,
  sourceCustomerIds: string[],
  audiences: MergeAudience[],
) {
  const sourceSet = new Set(sourceCustomerIds);
  const byCampaign = new Map<string, Set<string>>();
  for (const audience of audiences) {
    if (audience.customerId !== targetCustomerId && !sourceSet.has(audience.customerId)) continue;
    const ids = byCampaign.get(audience.campaignId) ?? new Set<string>();
    ids.add(audience.customerId);
    byCampaign.set(audience.campaignId, ids);
  }
  return Array.from(byCampaign.entries())
    .filter(([, ids]) => ids.has(targetCustomerId) && ids.size > 1)
    .map(([campaignId, ids]) => ({ campaignId, customerIds: Array.from(ids).sort() }));
}

function impactForContext(context: MergeContext, ids: Set<string>) {
  return {
    reservations: countFor(context.reservations, ids),
    giftCards: countFor(context.giftCards, ids),
    timelineEvents: context.timelineEvents.filter((event) => ids.has(event.customerId)).length,
    identities: context.customers
      .filter((customer) => ids.has(customer.id))
      .reduce((total, customer) => total + customer.identities.length, 0),
    preferences: context.customers
      .filter((customer) => ids.has(customer.id))
      .reduce((total, customer) => total + customer.preferences.length, 0),
    tags: context.customers
      .filter((customer) => ids.has(customer.id))
      .reduce((total, customer) => total + customer.tagAssignments.length, 0),
    permissions: context.permissions.filter((permission) => ids.has(permission.customerId)).length,
    marketingMessages: context.messages.filter((message) => ids.has(message.customerId)).length,
    conversions: context.conversions.filter((conversion) => ids.has(conversion.customerId)).length,
  };
}

/** Build the full read-only merge preview used by the dashboard confirmation step. */
export function buildCustomerMergePreview(
  context: MergeContext,
  restaurantId: string,
  targetCustomerId: string,
  sourceCustomerIds: string[],
): CustomerMergePreview {
  const { target, sources } = assertMergeContext(
    context,
    restaurantId,
    targetCustomerId,
    sourceCustomerIds,
  );
  const allCustomers = [target, ...sources];
  const ids = new Set(allCustomers.map((customer) => customer.id));
  return {
    target: summaryForCustomer(target),
    sources: sources.map((source) => summaryForCustomer(source)),
    conflicts: {
      identities: buildIdentityConflicts(allCustomers),
      preferences: groupedPreferenceConflicts(allCustomers),
      profileFields: buildProfileConflicts(allCustomers),
      permissions: buildPermissionConflicts(allCustomers, context.permissions),
      campaignAudience: buildCampaignAudienceConflicts(
        targetCustomerId,
        sourceCustomerIds,
        context.audiences,
      ),
    },
    impact: impactForContext(context, ids),
  };
}

async function lockCustomers(
  tx: MergeDb,
  restaurantId: string,
  customerIds: string[],
): Promise<void> {
  const orderedIds = [...customerIds].sort();
  await tx.$queryRaw(
    Prisma.sql`SELECT "id" FROM "customers" WHERE "restaurant_id" = ${restaurantId} AND "id" IN (${Prisma.join(orderedIds)}) ORDER BY "id" FOR UPDATE`,
  );
}

function emptySummary(sourceCount: number): CustomerMergeSummary {
  return {
    sourceCount,
    sourceProfilesArchived: 0,
    reservationsMoved: 0,
    giftCardsMoved: 0,
    experienceReservationsMoved: 0,
    reputationFeedbackRequestsMoved: 0,
    reputationFeedbacksMoved: 0,
    reputationRecoveryTasksMoved: 0,
    loyaltyGrantsMoved: 0,
    consentsReassigned: 0,
    identitiesMoved: 0,
    identitiesDeduplicated: 0,
    timelineEventsMoved: 0,
    preferencesMoved: 0,
    preferencesDeduplicated: 0,
    preferencesResolved: 0,
    tagsMoved: 0,
    tagsDeduplicated: 0,
    permissionsMoved: 0,
    permissionsMerged: 0,
    permissionEventsReassigned: 0,
    suppressionsMoved: 0,
    suppressionsMerged: 0,
    automationDispatchesMoved: 0,
    automationDispatchesMerged: 0,
    frequencyWindowsMoved: 0,
    frequencyWindowsMerged: 0,
    attributionLinksMoved: 0,
    attributionLinksMerged: 0,
    campaignAudienceMembersMoved: 0,
    campaignAudienceConflictsKept: 0,
    campaignMessagesReassigned: 0,
    conversionsReassigned: 0,
    metricSnapshotsRebuilt: 0,
    profileConflictsTargetWon: 0,
  };
}

function moreRestrictiveStatus(
  left: MarketingPermissionStatus,
  right: MarketingPermissionStatus,
): MarketingPermissionStatus {
  const rank: Record<MarketingPermissionStatus, number> = {
    [MarketingPermissionStatus.OPTED_IN]: 1,
    [MarketingPermissionStatus.UNKNOWN]: 2,
    [MarketingPermissionStatus.OPTED_OUT]: 3,
  };
  return rank[right] > rank[left] ? right : left;
}

function mergeNotes(target: string | null, sources: string[]): string | null {
  const values = [target, ...sources]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const unique = Array.from(new Set(values));
  if (unique.length === 0) return null;
  return unique.join('\n\n');
}

function metricMerge(
  target: CustomerMetricSnapshot | null,
  sources: Array<CustomerMetricSnapshot | null>,
  now: Date,
) {
  const all = [target, ...sources].filter((metric): metric is CustomerMetricSnapshot =>
    Boolean(metric),
  );
  if (all.length === 0) return null;
  return {
    lastHonoredAt: maxDate(all.map((metric) => metric.lastHonoredAt)),
    nextReservationAt: minDate(all.map((metric) => metric.nextReservationAt)),
    honored30d: all.reduce((sum, metric) => sum + metric.honored30d, 0),
    honored90d: all.reduce((sum, metric) => sum + metric.honored90d, 0),
    honored365d: all.reduce((sum, metric) => sum + metric.honored365d, 0),
    cancelled365d: all.reduce((sum, metric) => sum + metric.cancelled365d, 0),
    noShow365d: all.reduce((sum, metric) => sum + metric.noShow365d, 0),
    covers365d: all.reduce((sum, metric) => sum + metric.covers365d, 0),
    estimatedSpend365d: decimalSum(all.map((metric) => metric.estimatedSpend365d)),
    actualSpend365d: decimalOrNull(all.map((metric) => metric.actualSpend365d)),
    actualLifetimeSpend: decimalOrNull(all.map((metric) => metric.actualLifetimeSpend)),
    projectionVersion: Math.max(...all.map((metric) => metric.projectionVersion), 1) + 1,
    calculatedAt: now,
  };
}

async function mergeMetrics(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  restaurantId: string,
  now: Date,
): Promise<number> {
  const target = context.customers.find((customer) => customer.id === targetCustomerId)!;
  const sources = sourceCustomerIds.map(
    (id) => context.customers.find((customer) => customer.id === id)!,
  );
  const merged = metricMerge(
    target.metricSnapshot,
    sources.map((source) => source.metricSnapshot),
    now,
  );
  if (!merged) return 0;
  await tx.customerMetricSnapshot.deleteMany({ where: { customerId: { in: sourceCustomerIds } } });
  await tx.customerMetricSnapshot.upsert({
    where: { customerId: targetCustomerId },
    create: { customerId: targetCustomerId, restaurantId, ...merged },
    update: { restaurantId, ...merged },
  });
  return 1;
}

function resolvePreferenceWinner(
  targetCustomerId: string,
  rows: Array<MergeCustomerRow['preferences'][number] & { customerId: string }>,
  resolution: CustomerMergePreferenceResolution | undefined,
): MergeCustomerRow['preferences'][number] & { customerId: string } {
  const target = rows.find((row) => row.customerId === targetCustomerId);
  const sources = rows.filter((row) => row.customerId !== targetCustomerId);
  if (resolution === 'target' && target) return target;
  if (resolution === 'source' && sources.length > 0) {
    return [...sources].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    )[0]!;
  }
  if (resolution === 'latest' || (!target && sources.length > 1)) {
    return [...rows].sort(
      (left, right) => right.updatedAt.getTime() - left.updatedAt.getTime(),
    )[0]!;
  }
  return target ?? sources[0]!;
}

async function mergePreferences(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  resolution: Record<string, CustomerMergePreferenceResolution>,
  summary: CustomerMergeSummary,
): Promise<void> {
  const customers = context.customers;
  const rowsByKey = new Map<
    string,
    Array<MergeCustomerRow['preferences'][number] & { customerId: string }>
  >();
  for (const customer of customers) {
    for (const preference of customer.preferences) {
      const rows = rowsByKey.get(preference.key) ?? [];
      rows.push({ ...preference, customerId: customer.id });
      rowsByKey.set(preference.key, rows);
    }
  }
  for (const [key, rows] of rowsByKey) {
    if (rows.length === 0) continue;
    const different = new Set(rows.map((row) => stableStringify(row.value))).size > 1;
    if (different && !resolution[key]) {
      throw new CustomerMergeError('MERGE_PREFERENCE_RESOLUTION_REQUIRED');
    }
    const winner = resolvePreferenceWinner(targetCustomerId, rows, resolution[key]);
    for (const row of rows) {
      if (row.id === winner.id) continue;
      await tx.customerPreference.delete({ where: { id: row.id } });
      summary.preferencesDeduplicated += 1;
    }
    if (winner.customerId !== targetCustomerId) {
      await tx.customerPreference.update({
        where: { id: winner.id },
        data: { customerId: targetCustomerId },
      });
      summary.preferencesMoved += 1;
    }
    if (different) summary.preferencesResolved += 1;
  }
}

async function mergeTags(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  summary: CustomerMergeSummary,
): Promise<void> {
  const rowsByTag = new Map<string, Array<{ customerId: string; assignedAt: Date }>>();
  for (const customer of context.customers) {
    for (const assignment of customer.tagAssignments) {
      const rows = rowsByTag.get(assignment.tagId) ?? [];
      rows.push({ customerId: customer.id, assignedAt: assignment.assignedAt });
      rowsByTag.set(assignment.tagId, rows);
    }
  }
  for (const [tagId, rows] of rowsByTag) {
    const target = rows.find((row) => row.customerId === targetCustomerId);
    const winner =
      target ??
      [...rows].sort((left, right) => left.assignedAt.getTime() - right.assignedAt.getTime())[0]!;
    for (const row of rows) {
      if (row.customerId === winner.customerId && row === winner) continue;
      await tx.customerTagAssignment.delete({
        where: { customerId_tagId: { customerId: row.customerId, tagId } },
      });
      summary.tagsDeduplicated += 1;
    }
    if (winner.customerId !== targetCustomerId) {
      await tx.customerTagAssignment.update({
        where: { customerId_tagId: { customerId: winner.customerId, tagId } },
        data: { customerId: targetCustomerId },
      });
      summary.tagsMoved += 1;
    }
  }
}

async function mergeIdentities(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  summary: CustomerMergeSummary,
): Promise<void> {
  const target = context.customers.find((customer) => customer.id === targetCustomerId)!;
  const targetKeys = new Set(
    target.identities.map((identity) => identityKey(identity.type, identity.normalizedValue)),
  );
  for (const customer of context.customers.filter((item) => item.id !== targetCustomerId)) {
    for (const identity of customer.identities) {
      const key = identityKey(identity.type, identity.normalizedValue);
      if (targetKeys.has(key)) {
        await tx.customerIdentity.delete({ where: { id: identity.id } });
        summary.identitiesDeduplicated += 1;
        continue;
      }
      try {
        await tx.customerIdentity.update({
          where: { id: identity.id },
          data: { customerId: targetCustomerId },
        });
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new CustomerMergeError('MERGE_IDENTITY_CONFLICT');
        }
        throw error;
      }
      targetKeys.add(key);
      summary.identitiesMoved += 1;
    }
  }
}

async function mergePermissions(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const targetPermissions = new Map(
    context.permissions
      .filter((permission) => permission.customerId === targetCustomerId)
      .map((permission) => [permission.channel, permission]),
  );
  for (const sourcePermission of context.permissions.filter((permission) =>
    sourceCustomerIds.includes(permission.customerId),
  )) {
    const targetPermission = targetPermissions.get(sourcePermission.channel);
    if (!targetPermission) {
      await tx.marketingPermission.update({
        where: { id: sourcePermission.id },
        data: { customerId: targetCustomerId },
      });
      await tx.marketingPermissionEvent.updateMany({
        where: { permissionId: sourcePermission.id },
        data: { customerId: targetCustomerId },
      });
      targetPermissions.set(sourcePermission.channel, {
        ...sourcePermission,
        customerId: targetCustomerId,
      });
      summary.permissionsMoved += 1;
      summary.permissionEventsReassigned += context.permissionEvents.filter(
        (event) => event.permissionId === sourcePermission.id,
      ).length;
      continue;
    }
    const restrictive = moreRestrictiveStatus(targetPermission.status, sourcePermission.status);
    const winner = restrictive === sourcePermission.status ? sourcePermission : targetPermission;
    await tx.marketingPermissionEvent.updateMany({
      where: { permissionId: sourcePermission.id },
      data: { permissionId: targetPermission.id, customerId: targetCustomerId },
    });
    await tx.marketingPermission.update({
      where: { id: targetPermission.id },
      data: {
        status: restrictive,
        source:
          restrictive === targetPermission.status ? targetPermission.source : 'MERGE_RESTRICTIVE',
        proofVersion: winner.proofVersion,
        proofHash: winner.proofHash,
        consentedAt: restrictive === MarketingPermissionStatus.OPTED_IN ? winner.consentedAt : null,
        withdrawnAt:
          restrictive === MarketingPermissionStatus.OPTED_OUT
            ? maxDate([targetPermission.withdrawnAt, sourcePermission.withdrawnAt])
            : null,
      },
    });
    await tx.marketingPermission.delete({ where: { id: sourcePermission.id } });
    targetPermissions.set(sourcePermission.channel, {
      ...targetPermission,
      status: restrictive,
      source:
        restrictive === targetPermission.status ? targetPermission.source : 'MERGE_RESTRICTIVE',
      proofVersion: winner.proofVersion,
      proofHash: winner.proofHash,
      consentedAt: restrictive === MarketingPermissionStatus.OPTED_IN ? winner.consentedAt : null,
      withdrawnAt:
        restrictive === MarketingPermissionStatus.OPTED_OUT
          ? maxDate([targetPermission.withdrawnAt, sourcePermission.withdrawnAt])
          : null,
    });
    summary.permissionsMerged += 1;
    summary.permissionEventsReassigned += context.permissionEvents.filter(
      (event) => event.permissionId === sourcePermission.id,
    ).length;
  }
  const sourceEvents = context.permissionEvents.filter((event) =>
    sourceCustomerIds.includes(event.customerId),
  );
  if (sourceEvents.length > 0) {
    await tx.marketingPermissionEvent.updateMany({
      where: { customerId: { in: sourceCustomerIds } },
      data: { customerId: targetCustomerId },
    });
  }
}

async function mergeSuppressions(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const targetByKey = new Map(
    context.suppressions
      .filter((row) => row.customerId === targetCustomerId)
      .map((row) => [`${row.channel ?? 'ALL'}:${row.reason}`, row]),
  );
  for (const source of context.suppressions.filter((row) =>
    sourceCustomerIds.includes(row.customerId),
  )) {
    const key = `${source.channel ?? 'ALL'}:${source.reason}`;
    const target = targetByKey.get(key);
    if (!target) {
      await tx.marketingSuppression.update({
        where: { id: source.id },
        data: { customerId: targetCustomerId },
      });
      targetByKey.set(key, { ...source, customerId: targetCustomerId });
      summary.suppressionsMoved += 1;
      continue;
    }
    await tx.marketingSuppression.update({
      where: { id: target.id },
      data: {
        expiresAt:
          target.expiresAt === null || source.expiresAt === null
            ? null
            : maxDate([target.expiresAt, source.expiresAt]),
      },
    });
    await tx.marketingSuppression.delete({ where: { id: source.id } });
    summary.suppressionsMerged += 1;
  }
}

function dispatchRank(status: MergeDispatch['status']): number {
  return { FAILED: 1, SKIPPED: 2, QUEUED: 3, SENT: 4 }[status];
}

async function mergeAutomationDispatches(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const targetByKey = new Map(
    context.dispatches
      .filter((row) => row.customerId === targetCustomerId)
      .map((row) => [`${row.automationId}:${row.triggerKey}`, row]),
  );
  for (const source of context.dispatches.filter((row) =>
    sourceCustomerIds.includes(row.customerId),
  )) {
    const key = `${source.automationId}:${source.triggerKey}`;
    const target = targetByKey.get(key);
    if (!target) {
      await tx.marketingAutomationDispatch.update({
        where: { id: source.id },
        data: { customerId: targetCustomerId },
      });
      targetByKey.set(key, { ...source, customerId: targetCustomerId });
      summary.automationDispatchesMoved += 1;
      continue;
    }
    const winner = dispatchRank(source.status) > dispatchRank(target.status) ? source : target;
    await tx.marketingAutomationDispatch.update({
      where: { id: target.id },
      data: {
        status: winner.status,
        reasonCode: winner.reasonCode,
        occurredAt: minDate([target.occurredAt, source.occurredAt]) ?? target.occurredAt,
      },
    });
    await tx.marketingAutomationDispatch.delete({ where: { id: source.id } });
    targetByKey.set(key, { ...target, ...winner, customerId: targetCustomerId });
    summary.automationDispatchesMerged += 1;
  }
}

async function mergeFrequencyWindows(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const targetByKey = new Map(
    context.frequencyWindows
      .filter((row) => row.customerId === targetCustomerId)
      .map((row) => [`${row.channel}:${row.windowStart.toISOString()}`, row]),
  );
  for (const source of context.frequencyWindows.filter((row) =>
    sourceCustomerIds.includes(row.customerId),
  )) {
    const key = `${source.channel}:${source.windowStart.toISOString()}`;
    const target = targetByKey.get(key);
    if (!target) {
      await tx.marketingFrequencyWindow.update({
        where: { id: source.id },
        data: { customerId: targetCustomerId },
      });
      targetByKey.set(key, { ...source, customerId: targetCustomerId });
      summary.frequencyWindowsMoved += 1;
      continue;
    }
    await tx.marketingFrequencyWindow.update({
      where: { id: target.id },
      data: {
        sendCount: target.sendCount + source.sendCount,
        windowEnd: maxDate([target.windowEnd, source.windowEnd]) ?? target.windowEnd,
      },
    });
    await tx.marketingFrequencyWindow.delete({ where: { id: source.id } });
    targetByKey.set(key, { ...target, sendCount: target.sendCount + source.sendCount });
    summary.frequencyWindowsMerged += 1;
  }
}

async function mergeAttributionLinks(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const targetByCampaign = new Map(
    context.attributionLinks
      .filter((row) => row.customerId === targetCustomerId)
      .map((row) => [row.campaignId, row]),
  );
  for (const source of context.attributionLinks.filter((row) =>
    sourceCustomerIds.includes(row.customerId),
  )) {
    const target = targetByCampaign.get(source.campaignId);
    if (!target) {
      await tx.marketingAttributionLink.update({
        where: { id: source.id },
        data: { customerId: targetCustomerId },
      });
      targetByCampaign.set(source.campaignId, { ...source, customerId: targetCustomerId });
      summary.attributionLinksMoved += 1;
      continue;
    }
    await tx.marketingAttributionLink.update({
      where: { id: target.id },
      data: {
        clickedAt: minDate([target.clickedAt, source.clickedAt]),
      },
    });
    await tx.marketingAttributionLink.delete({ where: { id: source.id } });
    summary.attributionLinksMerged += 1;
  }
}

async function mergeCampaignAudience(
  tx: MergeDb,
  context: MergeContext,
  targetCustomerId: string,
  sourceCustomerIds: string[],
  summary: CustomerMergeSummary,
): Promise<void> {
  const sourceSet = new Set(sourceCustomerIds);
  const targetCampaigns = new Set(
    context.audiences
      .filter((audience) => audience.customerId === targetCustomerId)
      .map((audience) => audience.campaignId),
  );
  const movedMemberIds: string[] = [];
  for (const source of context.audiences.filter((audience) => sourceSet.has(audience.customerId))) {
    if (targetCampaigns.has(source.campaignId)) {
      // Keep the source audience/member row and its provider message intact.
      // The compound campaign/customer key cannot represent both histories;
      // retaining the source row avoids deleting delivery evidence.
      summary.campaignAudienceConflictsKept += 1;
      continue;
    }
    await tx.campaignAudienceMember.update({
      where: { id: source.id },
      data: { customerId: targetCustomerId },
    });
    targetCampaigns.add(source.campaignId);
    movedMemberIds.push(source.id);
    summary.campaignAudienceMembersMoved += 1;
  }
  if (movedMemberIds.length > 0) {
    const result = await tx.campaignMessage.updateMany({
      where: { audienceMemberId: { in: movedMemberIds }, customerId: { in: sourceCustomerIds } },
      data: { customerId: targetCustomerId },
    });
    summary.campaignMessagesReassigned += result.count;
  }
}

async function applyMerge(
  tx: MergeDb,
  context: MergeContext,
  args: {
    restaurantId: string;
    targetCustomerId: string;
    sourceCustomerIds: string[];
    preferenceResolution: Record<string, CustomerMergePreferenceResolution>;
    actor?: string;
    idempotencyKey: string;
    payloadHash: string;
  },
): Promise<{
  audit: { id: string; targetCustomerId: string; sourceCustomerIds: string[]; summary: unknown };
  replayed: boolean;
}> {
  const now = new Date();
  const summary = emptySummary(args.sourceCustomerIds.length);
  const { target, sources } = assertMergeContext(
    context,
    args.restaurantId,
    args.targetCustomerId,
    args.sourceCustomerIds,
  );
  const conflicts = buildCustomerMergePreview(
    context,
    args.restaurantId,
    args.targetCustomerId,
    args.sourceCustomerIds,
  ).conflicts;
  for (const conflict of conflicts.preferences) {
    if (!args.preferenceResolution[conflict.key]) {
      throw new CustomerMergeError('MERGE_PREFERENCE_RESOLUTION_REQUIRED');
    }
  }
  summary.profileConflictsTargetWon = conflicts.profileFields.length;

  summary.reservationsMoved = (
    await tx.reservation.updateMany({
      where: { restaurantId: args.restaurantId, customerId: { in: args.sourceCustomerIds } },
      data: { customerId: args.targetCustomerId },
    })
  ).count;
  summary.giftCardsMoved = (
    await tx.giftCard.updateMany({
      where: { restaurantId: args.restaurantId, customerId: { in: args.sourceCustomerIds } },
      data: { customerId: args.targetCustomerId },
    })
  ).count;
  // Aucune de ces tables n'a d'unicité sur le client : un simple déplacement suffit.
  const bySource = {
    where: { restaurantId: args.restaurantId, customerId: { in: args.sourceCustomerIds } },
    data: { customerId: args.targetCustomerId },
  };
  summary.experienceReservationsMoved = (await tx.experienceReservation.updateMany(bySource)).count;
  summary.reputationFeedbackRequestsMoved = (
    await tx.reputationFeedbackRequest.updateMany(bySource)
  ).count;
  summary.reputationFeedbacksMoved = (await tx.reputationFeedback.updateMany(bySource)).count;
  summary.reputationRecoveryTasksMoved = (
    await tx.reputationRecoveryTask.updateMany(bySource)
  ).count;
  summary.loyaltyGrantsMoved = (await tx.loyaltyGrant.updateMany(bySource)).count;
  summary.consentsReassigned = (
    await tx.customerConsent.updateMany({
      where: { restaurantId: args.restaurantId, customerId: { in: args.sourceCustomerIds } },
      data: { customerId: args.targetCustomerId },
    })
  ).count;
  summary.timelineEventsMoved = (
    await tx.customerTimelineEvent.updateMany({
      where: { restaurantId: args.restaurantId, customerId: { in: args.sourceCustomerIds } },
      data: { customerId: args.targetCustomerId },
    })
  ).count;
  summary.conversionsReassigned = (
    await tx.marketingConversion.updateMany({
      where: {
        customerId: { in: args.sourceCustomerIds },
        campaign: { restaurantId: args.restaurantId },
      },
      data: { customerId: args.targetCustomerId },
    })
  ).count;

  await mergeIdentities(tx, context, args.targetCustomerId, summary);
  await mergePreferences(tx, context, args.targetCustomerId, args.preferenceResolution, summary);
  await mergeTags(tx, context, args.targetCustomerId, summary);
  await mergePermissions(tx, context, args.targetCustomerId, args.sourceCustomerIds, summary);
  await mergeSuppressions(tx, context, args.targetCustomerId, args.sourceCustomerIds, summary);
  await mergeAutomationDispatches(
    tx,
    context,
    args.targetCustomerId,
    args.sourceCustomerIds,
    summary,
  );
  await mergeFrequencyWindows(tx, context, args.targetCustomerId, args.sourceCustomerIds, summary);
  await mergeAttributionLinks(tx, context, args.targetCustomerId, args.sourceCustomerIds, summary);
  await mergeCampaignAudience(tx, context, args.targetCustomerId, args.sourceCustomerIds, summary);
  summary.metricSnapshotsRebuilt = await mergeMetrics(
    tx,
    context,
    args.targetCustomerId,
    args.sourceCustomerIds,
    args.restaurantId,
    now,
  );

  const targetPartySize = target.partySizeTypical ? Number(target.partySizeTypical) : null;
  const sourcePartySizes = sources
    .map((source) => (source.partySizeTypical ? Number(source.partySizeTypical) : null))
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const partySizes = [targetPartySize, ...sourcePartySizes].filter(
    (value): value is number => value !== null && Number.isFinite(value),
  );
  const mergedPartySize =
    partySizes.length > 0
      ? new Prisma.Decimal(partySizes.reduce((sum, value) => sum + value, 0) / partySizes.length)
      : null;
  await tx.customer.update({
    where: { id: args.targetCustomerId },
    data: {
      name: target.name ?? sources.find((source) => source.name)?.name ?? null,
      emailNormalized:
        target.emailNormalized ??
        sources.find((source) => source.emailNormalized)?.emailNormalized ??
        null,
      feedbackEmailOptOutAt: maxDate([
        target.feedbackEmailOptOutAt,
        ...sources.map((source) => source.feedbackEmailOptOutAt),
      ]),
      feedbackEmailRequestedAt: maxDate([
        target.feedbackEmailRequestedAt,
        ...sources.map((source) => source.feedbackEmailRequestedAt),
      ]),
      birthMonth:
        target.birthMonth ??
        sources.find((source) => source.birthMonth !== null)?.birthMonth ??
        null,
      birthDay:
        target.birthDay ?? sources.find((source) => source.birthDay !== null)?.birthDay ?? null,
      preferredLocale:
        target.preferredLocale ??
        sources.find((source) => source.preferredLocale)?.preferredLocale ??
        null,
      isVip: [target, ...sources].some((customer) => customer.isVip),
      notes: mergeNotes(
        target.notes,
        sources.map((source) => source.notes).filter((note): note is string => note !== null),
      ),
      specialOccasion:
        target.specialOccasion ??
        sources.find((source) => source.specialOccasion)?.specialOccasion ??
        null,
      lastSeenAt: maxDate([target.lastSeenAt, ...sources.map((source) => source.lastSeenAt)]),
      lastCallAt: maxDate([target.lastCallAt, ...sources.map((source) => source.lastCallAt)]),
      partySizeTypical: mergedPartySize,
    },
  });
  await tx.customer.updateMany({
    where: { restaurantId: args.restaurantId, id: { in: args.sourceCustomerIds } },
    data: { mergedIntoId: args.targetCustomerId, archivedAt: now },
  });
  summary.sourceProfilesArchived = sources.length;

  const audit = await tx.customerMergeAudit.create({
    data: {
      restaurantId: args.restaurantId,
      targetCustomerId: args.targetCustomerId,
      sourceCustomerIds: args.sourceCustomerIds,
      idempotencyKey: args.idempotencyKey,
      payloadHash: args.payloadHash,
      actorHash: hashActor(args.actor),
      preferenceResolution: args.preferenceResolution as Prisma.InputJsonValue,
      summary: summary as unknown as Prisma.InputJsonValue,
    },
    select: { id: true, targetCustomerId: true, sourceCustomerIds: true, summary: true },
  });
  await tx.customerTimelineEvent.create({
    data: {
      restaurantId: args.restaurantId,
      customerId: args.targetCustomerId,
      eventType: 'CUSTOMER_MERGED',
      sourceType: 'customer_merge',
      sourceId: audit.id,
      dedupeKey: `crm:merge:${audit.id}`,
      occurredAt: now,
      summaryCode: 'customer.merged',
      metadata: {
        sourceCount: summary.sourceCount,
        reservationsMoved: summary.reservationsMoved,
        identitiesMoved: summary.identitiesMoved,
        preferencesResolved: summary.preferencesResolved,
      },
    },
  });
  await tx.outboxEvent.create({
    data: {
      restaurantId: args.restaurantId,
      topic: 'crm',
      aggregateType: 'customer',
      aggregateId: args.targetCustomerId,
      eventType: 'CUSTOMER_PROFILES_MERGED',
      schemaVersion: 1,
      payload: {
        auditId: audit.id,
        targetCustomerId: args.targetCustomerId,
        sourceCustomerIds: args.sourceCustomerIds,
        summary,
      } as Prisma.InputJsonValue,
      idempotencyKey: `crm:merge:${audit.id}`,
      status: 'PENDING',
      availableAt: now,
    },
  });
  return { audit, replayed: false };
}

async function findExistingAudit(idempotencyKey: string, payloadHash: string) {
  const existing = await db.customerMergeAudit.findUnique({
    where: { idempotencyKey },
    select: {
      id: true,
      targetCustomerId: true,
      sourceCustomerIds: true,
      payloadHash: true,
      summary: true,
    },
  });
  if (!existing) return null;
  if (existing.payloadHash !== payloadHash) {
    throw new CustomerMergeError('MERGE_IDEMPOTENCY_KEY_REUSED');
  }
  return existing;
}

export async function previewCustomerMerge(args: {
  restaurantId: string;
  targetCustomerId: string;
  sourceCustomerIds: string[];
}): Promise<CustomerMergePreview> {
  const sourceCustomerIds = normalizeIds(args.sourceCustomerIds);
  const context = await loadMergeContext(db as unknown as MergeDb, args.restaurantId, [
    args.targetCustomerId,
    ...sourceCustomerIds,
  ]);
  return buildCustomerMergePreview(
    context,
    args.restaurantId,
    args.targetCustomerId,
    sourceCustomerIds,
  );
}

export async function listCustomerDuplicates(args: {
  restaurantId: string;
  minScore?: number;
  limit?: number;
  cursor?: string;
}): Promise<{ data: DuplicateCandidate[]; nextCursor: string | null }> {
  const customers = await db.customer.findMany({
    where: { restaurantId: args.restaurantId, archivedAt: null, mergedIntoId: null },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: MAX_DUPLICATE_SCAN,
    select: {
      id: true,
      name: true,
      phone: true,
      emailNormalized: true,
      isVip: true,
      archivedAt: true,
      identities: { select: { type: true, normalizedValue: true } },
    },
  });
  const minScore = Math.min(Math.max(args.minScore ?? 60, 0), 100);
  const all = buildDuplicateCandidates(toArray(customers)).filter(
    (candidate) => candidate.score >= minScore,
  );
  const start = args.cursor
    ? Math.max(0, all.findIndex((candidate) => candidate.id === args.cursor) + 1)
    : 0;
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const page = all.slice(start, start + limit);
  // Same visit count as the lists and the profile: honoured visits, not the legacy counter.
  const now = new Date();
  const stats = await loadCustomerVisitStats(
    args.restaurantId,
    page.flatMap((candidate) => [candidate.left.id, candidate.right.id]),
    now,
  );
  const withVisits = (summary: DuplicateCustomerSummary): DuplicateCustomerSummary => ({
    ...summary,
    visits: stats.get(summary.id)?.visitDates.length ?? 0,
  });
  return {
    data: page.map((candidate) => ({
      ...candidate,
      left: withVisits(candidate.left),
      right: withVisits(candidate.right),
    })),
    nextCursor: start + limit < all.length ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function mergeCustomerProfiles(args: {
  restaurantId: string;
  targetCustomerId: string;
  sourceCustomerIds: string[];
  preferenceResolution?: Record<string, CustomerMergePreferenceResolution>;
  actor?: string;
  idempotencyKey: string;
}): Promise<CustomerMergeAuditResult> {
  if (!args.idempotencyKey?.trim()) throw new CustomerMergeError('IDEMPOTENCY_KEY_REQUIRED');
  if (args.idempotencyKey.trim().length > 255)
    throw new CustomerMergeError('IDEMPOTENCY_KEY_INVALID');
  const sourceCustomerIds = normalizeIds(args.sourceCustomerIds);
  const preferenceResolution = normalizeResolution(args.preferenceResolution);
  const payloadHash = hashPayload({
    restaurantId: args.restaurantId,
    targetCustomerId: args.targetCustomerId,
    sourceCustomerIds,
    preferenceResolution,
  });

  for (let attempt = 0; attempt < MAX_MERGE_RETRIES; attempt += 1) {
    try {
      const result = await db.$transaction(
        async (tx) => {
          const existing = await tx.customerMergeAudit.findUnique({
            where: { idempotencyKey: args.idempotencyKey.trim() },
            select: {
              id: true,
              targetCustomerId: true,
              sourceCustomerIds: true,
              payloadHash: true,
              summary: true,
            },
          });
          if (existing) {
            if (existing.payloadHash !== payloadHash) {
              throw new CustomerMergeError('MERGE_IDEMPOTENCY_KEY_REUSED');
            }
            return { audit: existing, replayed: true };
          }
          await lockCustomers(tx, args.restaurantId, [args.targetCustomerId, ...sourceCustomerIds]);
          const context = await loadMergeContext(tx, args.restaurantId, [
            args.targetCustomerId,
            ...sourceCustomerIds,
          ]);
          return applyMerge(tx, context, {
            restaurantId: args.restaurantId,
            targetCustomerId: args.targetCustomerId,
            sourceCustomerIds,
            preferenceResolution,
            actor: args.actor,
            idempotencyKey: args.idempotencyKey.trim(),
            payloadHash,
          });
        },
        {
          maxWait: 10_000,
          timeout: 30_000,
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );

      const summary = result.audit.summary as unknown as CustomerMergeSummary;
      if (!result.replayed) {
        const customers = await db.customer.findMany({
          where: {
            restaurantId: args.restaurantId,
            id: { in: [args.targetCustomerId, ...sourceCustomerIds] },
          },
          select: { phone: true },
        });
        await Promise.all(
          customers.flatMap((customer) => {
            const normalized = normalizeCustomerPhone(customer.phone);
            return [
              redisCache.del(`customer:${args.restaurantId}:${normalized ?? customer.phone}`),
            ];
          }),
        );
      }
      return {
        auditId: result.audit.id,
        targetCustomerId: result.audit.targetCustomerId,
        sourceCustomerIds: result.audit.sourceCustomerIds,
        summary,
        replayed: result.replayed,
      };
    } catch (error) {
      if (isSerializationFailure(error) && attempt < MAX_MERGE_RETRIES - 1) {
        // Petit délai aléatoire : des fusions rejouées ensemble ne se recroisent pas au même instant.
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.floor(Math.random() * 60)));
        continue;
      }
      if (isUniqueConstraint(error)) {
        const existing = await findExistingAudit(args.idempotencyKey.trim(), payloadHash);
        if (existing) {
          return {
            auditId: existing.id,
            targetCustomerId: existing.targetCustomerId,
            sourceCustomerIds: existing.sourceCustomerIds,
            summary: existing.summary as unknown as CustomerMergeSummary,
            replayed: true,
          };
        }
      }
      throw error;
    }
  }
  throw new CustomerMergeError('MERGE_SERIALIZATION_RETRY_EXHAUSTED');
}

export type CustomerMergeAuditListItem = {
  id: string;
  targetCustomerId: string;
  sourceCustomerIds: string[];
  summary: unknown;
  createdAt: Date;
};

export async function listCustomerMergeAudits(args: {
  restaurantId: string;
  targetCustomerId?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ data: CustomerMergeAuditListItem[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 100);
  const rows = await db.customerMergeAudit.findMany({
    where: {
      restaurantId: args.restaurantId,
      ...(args.targetCustomerId ? { targetCustomerId: args.targetCustomerId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    ...(args.cursor ? { cursor: { id: args.cursor }, skip: 1 } : {}),
    take: limit + 1,
    select: {
      id: true,
      targetCustomerId: true,
      sourceCustomerIds: true,
      summary: true,
      createdAt: true,
    },
  });
  const page = rows.length > limit ? rows.slice(0, limit) : rows;
  return {
    data: page,
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
}
