/**
 * Types TypeScript pour les réponses API consommées par le dashboard.
 *
 * Ces interfaces ne couvrent que les champs réellement utilisés côté dashboard.
 * Elles sont volontairement simples et pragmatiques — pour les types complets,
 * voir les schémas Prisma (packages/database/prisma/schema.prisma) et les
 * types API (apps/api/src/modules/.../types.ts).
 */

// ─── Restaurant ─────────────────────────────────────────────────────────

export type Plan = 'STARTER' | 'PRO' | 'PREMIUM';

export type BillingPlan = 'essential' | 'pro' | 'multi-site';
export type BillingInterval = 'monthly' | 'annual';

export interface BillingStatus {
  plan: BillingPlan | null;
  subscriptionStatus: string | null;
  billingInterval: BillingInterval | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  entitledSiteCount: number;
  accountScoped: boolean;
  /** True once a subscription ended: the phone assistant no longer answers. */
  suspended?: boolean;
  /** Present while the subscription is in its free trial. */
  trial?: BillingTrial;
}

export interface BillingDetails {
  hasCustomer: boolean;
  hasPaymentMethod: boolean;
  subscription: {
    status: string;
    canUpdatePlan: boolean;
    plan: BillingPlan | null;
    recurringAmount: number | null;
    currency: string;
    interval: string | null;
    intervalCount: number | null;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string | null;
  } | null;
  paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null;
  invoices: {
    number: string | null;
    createdAt: string;
    status: string | null;
    total: number;
    currency: string;
    pdfUrl: string | null;
    hostedUrl: string | null;
  }[];
  hasMoreInvoices: boolean;
}

export interface BillingTrial {
  startedAt: string;
  endsAt: string;
  totalDays: number;
  /** Whole days left, rounded up; 0 on the last day. */
  daysLeft: number;
  recap?: {
    calls: number;
    reservations: number;
    covers: number;
    phoneReservations: number;
  };
}

export type OpeningHours = {
  open: string;
  close: string;
  slots?: Array<{ open: string; close: string }>;
  services?: Array<{ open: string; close: string }>;
};

export interface Restaurant {
  id: string;
  name: string;
  plan: Plan;
  managerPhone: string;
  managerEmail: string;
  phoneNumber: string;
  giftCardMinimumAmount: number | null;
  giftCardCommissionRate: number;
  giftCardEnabled: boolean;
  slug: string | null;
  openingHours?: Record<string, OpeningHours | null>;
  exposureSettings?: RestaurantExposureSettings | null;
}

// ─── AgentPersonality ───────────────────────────────────────────────────

export type ProfileType = 'BISTROT_BRASSERIE' | 'GASTRONOMIQUE' | 'SEMI_GASTRO';
export type FillerStyle = 'CASUAL' | 'WARM' | 'FORMAL';

export interface AgentPersonality {
  id: string;
  restaurantId: string;
  profileType: ProfileType;
  speakingRate: number;
  volume?: number;
  fillerStyle: FillerStyle;
  systemPromptExtra: string | null;
  voiceIdCa: string | null;
  pronunciationDictId?: string | null;
  emotion?: string | null;
}

// ─── Reservation ────────────────────────────────────────────────────────

export type ReservationStatus = 'CONFIRMED' | 'CANCELLED' | 'SEATED' | 'NO_SHOW';
export type ReservationState =
  | 'PENDING'
  | 'CONFIRMED'
  | 'SEATED'
  | 'HONORED'
  | 'CANCELLED'
  | 'NO_SHOW'
  | 'FAILED'
  | 'EXPIRED';

export interface Reservation {
  id: string;
  restaurantId: string;
  reservedAt: string;
  partySize: number;
  customerName: string;
  customerPhone: string | null;
  status: ReservationStatus;
  /** `state` is the business source of truth; legacy rows may omit it. */
  state?: ReservationState;
  estimatedRevenue: number | null;
  specialRequests?: string | null;
  overbooked?: boolean;
  channel?: 'PHONE' | 'WEB' | 'MCP' | 'OPENAI_RESERVE' | 'ADMIN' | 'API' | null;
  tableId: string | null;
  table?: { name: string } | null;
}

// ─── Call ───────────────────────────────────────────────────────────────

export type CallIntent = 'RESERVATION' | 'HOURS' | 'MENU' | 'CANCEL' | 'OTHER';
export type CallOutcome = 'RESERVED' | 'INFO' | 'MESSAGE' | 'HANDOFF' | 'NO_ACTION' | 'ERROR';
export type CallRecordingStatus = 'NOT_REQUESTED' | 'PENDING' | 'AVAILABLE' | 'FAILED' | 'DELETED';

export interface VoiceCallTelemetry {
  llmProvider: string | null;
  llmModel: string | null;
  totalSpeechMs: number | null;
  totalTranscriptionMs: number | null;
  totalLlmMs: number | null;
  totalAvailabilityMs: number | null;
  totalTtsMs: number | null;
  firstLlmFirstTokenMs: number | null;
  firstLlmFirstPhraseMs: number | null;
  firstTtsFirstAudioMs: number | null;
  firstSttFinalToAudioMs: number | null;
  turnCount: number;
  llmTurnCount: number;
  deterministicTurnCount: number;
  fallbackTurnCount: number;
  availabilitySearchCount: number;
  availabilityFailureCount: number;
  loopCount: number;
  reservationConfirmed: boolean;
  reservationIntentAbandoned: boolean;
  finalizedAt: string | null;
}

export interface VoiceTurnTelemetry {
  id: string;
  turnId: string;
  sequence: number;
  path: 'unknown' | 'deterministic' | 'llm' | 'availability' | 'fallback';
  transcriptLength: number;
  speechDurationMs: number | null;
  transcriptionDurationMs: number | null;
  speechToSttFinalMs: number | null;
  llmFirstTokenMs: number | null;
  llmFirstPhraseMs: number | null;
  llmDurationMs: number | null;
  availabilityDurationMs: number | null;
  ttsFirstByteMs: number | null;
  sttFinalToAudioMs: number | null;
  ttsDurationMs: number | null;
  totalE2eMs: number | null;
  sttProvider: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  ttsProvider: string | null;
  loopDetected: boolean;
  interrupted: boolean;
  completed: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface Call {
  callerPhone: string | null;
  id: string;
  callSid: string;
  durationSec: number | null;
  transcript: string | null;
  intent: CallIntent | null;
  outcome: CallOutcome | null;
  carrier: string | null;
  recordingStatus: CallRecordingStatus;
  recordingStartedAt: string | null;
  recordingEndedAt: string | null;
  recordingExpiresAt: string | null;
  createdAt: string;
  latencyTrace?: {
    vadEndMs: number | null;
    sttFinalMs: number | null;
    llmFirstToken: number | null;
    ttsFirstByte: number | null;
    audioPlayingMs: number | null;
    totalE2eMs: number | null;
  } | null;
  voiceTelemetry?: VoiceCallTelemetry | null;
  voiceTurns?: VoiceTurnTelemetry[];
}

export interface CallListResponse {
  data: Call[];
  total: number;
}

// ─── Customer ───────────────────────────────────────────────────────────

export interface Customer {
  id: string;
  name: string | null;
  phone: string;
  emailNormalized?: string | null;
  isVip: boolean;
  notes: string | null;
  lastSeenAt: string | null;
  /** Computed from real visits; null when the visit history could not be read. */
  lifecycle?: CustomerLifecycle | null;
  /** Honoured visits from the reservations; null when the history could not be read. */
  visitSummary?: CustomerVisitSummary | null;
}

/**
 * The one visit count shown on every customer screen. `lastSeenAt` moves with every call:
 * never display it as the last visit.
 */
export interface CustomerVisitSummary {
  visits: number;
  visits365d: number;
  noShows365d: number;
  lastVisitAt: string | null;
}

export type CustomerLifecycleStatus = 'new' | 'active' | 'regular' | 'at_risk' | 'dormant';

export interface CustomerLifecycle {
  status: CustomerLifecycleStatus;
  reason: string;
}

export interface ServiceCardBadge {
  kind: 'regular' | 'allergy' | 'diet' | 'accessibility' | 'occasion' | 'no_show_risk';
  label: string;
  detail: string;
}

export interface ServiceCard {
  reservationId: string;
  customerId: string | null;
  lifecycle: CustomerLifecycle | null;
  badges: ServiceCardBadge[];
}

// ─── GiftCard & GiftCardPack ────────────────────────────────────────────
// (Les types complets sont dans `@/lib/api/gift-cards` — on ré-exporte ici
// pour centraliser, mais on évite la duplication.)

// ─── FloorPlan ──────────────────────────────────────────────────────────

export type TableShape = 'rect' | 'round';
export type WallType = 'wall' | 'door' | 'window' | 'bar' | 'plant';

export interface FloorPlanWall {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  type: WallType;
  name: string | null;
}

export interface FloorPlanZone {
  id: string;
  floorPlanId: string;
  sectionId: string | null;
  sectionName?: string | null;
  section?: { id: string; name: string } | null;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface FloorPlanTableCombination {
  id: string;
  floorPlanId: string;
  name: string | null;
  members: Array<{ tableId: string }>;
}

export interface FloorPlanTable {
  id: string;
  name: string;
  capacity: number;
  minCapacity: number;
  isActive: boolean;
  positionX: number | null;
  positionY: number | null;
  width: number | null;
  height: number | null;
  rotation: number;
  shape: TableShape | null;
  assignedServer?: string | null;
  sectionId?: string | null;
  sectionName?: string | null;
}

export interface FloorPlanSection {
  id: string;
  name: string;
  position: number;
  tables: FloorPlanTable[];
}

export interface FloorPlan {
  id: string;
  name: string | null;
  isDefault: boolean;
  isActive: boolean;
  width: number;
  height: number;
  sections: FloorPlanSection[];
  tables?: FloorPlanTable[];
  walls?: FloorPlanWall[];
  zones?: FloorPlanZone[];
  tableCombinations?: FloorPlanTableCombination[];
}

export interface FloorPlanSummary {
  id: string;
  name: string;
  isDefault: boolean;
  isActive: boolean;
  tableCount: number;
}

export interface PlanningReservation {
  id: string;
  tableId: string | null;
  tableName: string | null;
  sectionName: string | null;
  startsAt: string;
  endsAt: string;
  partySize: number;
  customerName: string | null;
  state: string;
  seatedAt: string | null;
  /** Addition clôturée en caisse depuis l'installation ; la table reste occupée. */
  paidAt?: string | null;
}

// ─── ReactivationCampaign ───────────────────────────────────────────────

export interface ReactivationCustomer {
  id: string;
  name: string;
  phone: string | null;
  visitCount: number;
  lastSeenAt: string | null;
}

export interface ReactivationCampaign {
  id: string;
  status: 'PENDING' | 'SENT' | 'DISMISSED';
  sentCount: number;
  sentAt: string | null;
  createdAt: string;
  customerCount: number;
  customers: ReactivationCustomer[];
}

// ─── RestaurantExposureSettings (agentic) ───────────────────────────────

export type NoShowPolicy = 'warning' | 'fee' | 'block';

export interface ExposedCreneau {
  day: number;
  from: string;
  to: string;
}

export interface CapacitySpecials {
  terrasse?: number;
  pmr?: number;
  chien?: boolean;
  poussette?: boolean;
  serviceDurationMinutes?: number;
  defaultServiceDurationMinutes?: number;
  waitingListEnabled?: boolean;
  waitingListMaxEntriesPerSlot?: number;
}

export interface RestaurantExposureSettings {
  maxPartySize: number;
  minLeadTimeMinutes: number;
  requireManualValidation: boolean;
  quoteTtlSeconds: number;
  holdTtlSeconds: number;
  noShowPolicy: NoShowPolicy;
  notificationChannels: ('sms' | 'email')[];
  exposedCreneaux: ExposedCreneau[];
  capacitySpecials: CapacitySpecials;
}

// ─── Agentic MCP clients ────────────────────────────────────────────────

export interface McpClient {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  allowedOrigins: string[];
  lastUsedAt: string | null;
  createdAt: string;
}

export interface McpClientListResponse {
  clients: McpClient[];
}

export interface McpClientCreateResponse {
  client: McpClient;
  apiKey: string;
}

export interface OptInStatus {
  mcp: boolean;
  openaiReserve: boolean;
  policyVersion: string;
}

// ─── WaitingList ────────────────────────────────────────────────────────

export type WaitingListStatus = 'PENDING' | 'PROMOTED' | 'CANCELLED' | 'EXPIRED';

export interface WaitingListEntry {
  id: string;
  partySize: number;
  customerFirstName: string;
  customerLastName?: string | null;
  customerPhone: string;
  customerEmail?: string | null;
  source?: string | null;
  slotStart: string;
  slotEnd: string;
  preferredSectionName?: string | null;
  status: WaitingListStatus;
  position: number;
  createdAt: string;
  promotedReservationId?: string | null;
}

// ─── Service Copilot ────────────────────────────────────────────────────

export type ServiceCopilotRecommendationKind =
  | 'reported-delay'
  | 'late-reservation'
  | 'table-soon-free'
  | 'waiting-list-compatible'
  | 'server-rebalance';

export type ServiceCopilotPriority = 'critical' | 'high' | 'medium' | 'low';

export interface ServiceCopilotRecommendation {
  id: string;
  occurrenceKey: string;
  ruleVersion: string;
  telemetryToken?: string;
  kind: ServiceCopilotRecommendationKind;
  priority: ServiceCopilotPriority;
  title: string;
  reason: string;
  action: {
    type: 'link' | 'call' | 'api';
    label: string;
    href?: string;
    method?: 'PATCH' | 'POST' | 'DELETE';
    path?: string;
    body?: Record<string, unknown>;
  };
  entityId?: string;
  expiresAt: string;
  metrics?: {
    minutesLate?: number;
    estimatedFreeAt?: string;
    covers?: number;
    tableName?: string;
    customerName?: string;
    estimatedDurationMinutes?: number;
    predictionConfidence?: 'high' | 'medium' | 'low';
    predictionSource?: 'historical-table' | 'historical-restaurant' | 'scheduled';
    predictionSampleSize?: number;
    fromServer?: string;
    toServer?: string;
    activeTables?: number;
  };
}

export interface ServiceCopilotRecommendationsResponse {
  recommendations: ServiceCopilotRecommendation[];
}

export type ServiceCopilotTelemetryStatus =
  | 'observed'
  | 'opened'
  | 'applied'
  | 'reverted'
  | 'conflicted'
  | 'expired'
  | 'ignored';

export type ServiceCopilotTelemetryTotals = Record<ServiceCopilotTelemetryStatus, number>;

export interface ServiceCopilotTelemetrySummary {
  from: string;
  to: string;
  totals: ServiceCopilotTelemetryTotals;
  byKind: Array<{
    kind: ServiceCopilotRecommendationKind | string;
    totals: ServiceCopilotTelemetryTotals;
  }>;
}

export interface ServiceCopilotTelemetryReviewItem {
  id: string;
  kind: ServiceCopilotRecommendationKind | string;
  status: Extract<ServiceCopilotTelemetryStatus, 'opened' | 'expired'>;
  createdAt: string;
  expiresAt: string | null;
}

export interface ServiceCopilotTelemetryReviewResponse {
  occurrences: ServiceCopilotTelemetryReviewItem[];
}

export type ServiceCopilotPulseStatus = 'calm' | 'attention' | 'urgent';

export interface ServiceCopilotPulse {
  date: string;
  generatedAt: string;
  isLiveDate: boolean;
  status: ServiceCopilotPulseStatus;
  headline: string;
  lateArrivals: number;
  arrivalsToSeat: number;
  arrivalsNext30Minutes: number;
  seatedTables: number;
  pendingWaitingList: number;
  confirmedReservations: number;
}

export interface ServiceCopilotDelayImpact {
  feasible: boolean;
  summary: string;
  delayMinutes: number;
  delayedReservation?: {
    id: string;
    customerName: string;
    originalTableName: string;
    originalStartsAt: string;
    proposedStartsAt: string;
    customerFacingProposedStartsAt?: string;
  };
  alternativeTable?: {
    id: string;
    name: string;
    capacity: number;
    sectionId: string | null;
  };
  waitingListEntry?: {
    id: string;
    customerName: string;
    partySize: number;
    requestedStartsAt: string;
    proposedStartsAt: string;
    proposedEndsAt: string;
    isAvailableNow: boolean;
    customerFacingRequestedStartsAt?: string;
  };
  safeguards: string[];
}

export interface ServiceCommunicationDraft {
  recipient: 'delayed-reservation' | 'waiting-list';
  customerName: string;
  message: string;
  delivery: 'review-required';
  eligibleChannel: 'sms' | 'email' | null;
  deliveryBlocker?: 'no-contact' | 'no-transactional-consent';
  reason: string;
  confidence: 'medium';
}

export interface ServiceCommunicationDraftsResponse {
  impact: ServiceCopilotDelayImpact;
  drafts: ServiceCommunicationDraft[];
}

export type ServiceCopilotDelayRecoveryStatus = 'applied' | 'reverted' | 'blocked';

export interface ServiceCopilotDelayRecoveryHistoryItem {
  operationId: string;
  delayedReservationId: string;
  promotedReservationId: string;
  waitingListEntryId: string;
  delayedCustomerName: string;
  waitingCustomerName: string;
  originalTableName: string;
  alternativeTableName: string;
  delayMinutes: number;
  originalStartsAt: string;
  appliedStartsAt: string;
  appliedAt: string;
  revertedAt?: string;
  status: ServiceCopilotDelayRecoveryStatus;
  revertible: boolean;
  blockedReason?: string;
}

export interface ServiceCopilotDelayRecoveryHistoryResponse {
  recoveries: ServiceCopilotDelayRecoveryHistoryItem[];
}

export type SimulationScenarioType = 'direct' | 'change-section' | 'refuse';

export interface SimulationAction {
  type: 'link' | 'api';
  label: string;
  href?: string;
  method?: 'PATCH' | 'POST';
  path?: string;
  body?: Record<string, unknown>;
}

export interface SimulationMetrics {
  coversGained: number;
  conflictsCreated: number;
  estimatedWaitMinutes: number | null;
  tablesImpacted: string[];
  reservationsToMove: {
    id: string;
    customerName?: string;
    fromTableName?: string;
    toTableName?: string;
    newStartsAt?: string;
  }[];
}

export interface SimulationScenario {
  id: string;
  type: SimulationScenarioType;
  feasible: boolean;
  confidence: 'high' | 'medium' | 'low';
  title: string;
  reason: string;
  actions: SimulationAction[];
  metrics: SimulationMetrics;
  table?: {
    id: string;
    name: string;
    capacity: number;
    sectionId: string | null;
    sectionName?: string | null;
    floorPlanName?: string | null;
  };
  nextAvailableAt?: string;
  nextAvailableSectionId?: string;
}

export interface SimulationResult {
  query: { partySize: number; startsAt: string; endsAt: string };
  feasible: boolean;
  scenarios: SimulationScenario[];
  bestScenarioId?: string;
  explanation: string;
}

// ─── Utilitaire : extraction de message d'erreur ────────────────────────

/**
 * Extrait un message lisible d'une erreur catchée (catch (err: unknown)).
 * Préférez cette fonction à `err.message` direct pour respecter le narrowing.
 */
export function getErrorMessage(err: unknown, fallback = 'Une erreur est survenue'): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err;
  return fallback;
}
