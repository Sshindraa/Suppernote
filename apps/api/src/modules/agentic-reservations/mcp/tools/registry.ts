/**
 * Tool handler dispatch + exécution.
 *
 * Chaque tool expose une fonction `execute(args, ctx) → result`.
 * Ce module :
 *   1. valide l'input via Zod
 *   2. vérifie le rate limit
 *   3. sanitize specialRequests (anti prompt injection)
 *   4. appelle le service métier
 *   5. redacte la réponse (PII, secrets)
 *   6. log un audit event
 */

import { env } from '../../../../env';
import { utcToZonedParts } from '../../../../shared/timezone/restaurant-time';
import { findCardGuaranteeTerms } from '../../../reservation-payments/reservation-guarantee.public';
import type { PrismaClient } from '@prisma/client';
import { canonicalDemoSlug } from '@suppernote/shared';
import { logger } from '../../../../shared/logger/pino';
import { type ReservationChannel } from '../../core/state-machine';
import { AuditLogService } from '../../core/audit-log.service';
import {
  AvailabilityService,
  resolveEffectiveMaxPartySize,
  type CapacityLimitHint,
} from '../../core/availability.service';
import { HoldService } from '../../core/hold.service';
import { WaitingListService } from '../../core/waiting-list.service';
import { TableAllocationService } from '../../../floor-plan/table-allocation.service';
import { IdempotencyService } from '../../core/idempotency.service';
import { PrismaIdempotencyStore } from '../../core/prisma-store';
import { ReservationService } from '../../core/reservation.service';
import { computeIdempotencyScope, hashPayload } from '../../core/idempotency.service';
import { redactPiiInString, redactResponse } from '../response-redaction';
import { McpRateLimiter } from '../rate-limit';
import { canHoldSlot } from '../../core/hold-slot-limit';
import { getToolOutputSchema } from './tool-definitions';
import { formatMcpSuccessMessage } from '../presentation';
import { assertNoPiiLeak } from '../../../../shared/observability/pii-leak';
import {
  checkAvailabilityDuration,
  recordMcpToolCall,
} from '../../../../shared/observability/metrics';
import {
  CancelReservationInputSchema,
  CheckAvailabilityInputSchema,
  CreateHoldInputSchema,
  CreateQuoteInputSchema,
  JoinWaitingListInputSchema,
  CancelWaitingListInputSchema,
  ModifyReservationInputSchema,
  CreateReservationInputSchema,
  GetRestaurantDetailsInputSchema,
  GetReservationStatusInputSchema,
  SearchRestaurantsInputSchema,
  type CancelReservationInput,
  type CheckAvailabilityInput,
  type CreateReservationInput,
  type GetRestaurantDetailsInput,
  type GetReservationStatusInput,
  type SearchRestaurantsInput,
} from './schemas';
import {
  DEFAULT_MCP_SEARCH_DURATION_MINUTES,
  DEFAULT_MCP_TIMEZONE,
  parseMcpDateRange,
} from './date-time';

export type ToolContext = {
  clientId: string;
  clientName: string;
  restaurantId: string | null;
  scopes: string[];
  actor: string;
  credentialType?: 'api_key' | 'oauth';
  transport?: 'mcp' | 'generic_agent';
  channel?: ReservationChannel;
  /** Restaurant-scoped API keys act as trusted staff; OAuth tokens do not. */
  trustedRestaurantAccess?: boolean;
  /** IP du client HTTP : plafonne les holds par client et par créneau. */
  clientIp?: string;
};

export type ToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
    }
  | {
      ok: false;
      error: string;
      code: string;
    };

const INJECTION_PATTERNS = [
  /ignore (previous|above|all) instructions/i,
  /system\s*:/i,
  /<\s*script/i,
  /onerror=/i,
];

export function sanitizeSpecialRequests(input: string | undefined): string {
  if (!input) return '';
  let out = input;
  for (const pat of INJECTION_PATTERNS) {
    if (pat.test(out)) {
      out = out.replace(pat, '[FILTERED]');
    }
  }
  return out.slice(0, 500);
}

function toolError(error: string, code: string): ToolResult {
  return { ok: false, error: redactPiiInString(error), code };
}

function ok<T>(data: T): ToolResult<T> {
  return { ok: true, data };
}

type McpScope = 'mcp:read' | 'mcp:reserve' | 'mcp:cancel';

function hasScope(ctx: ToolContext, scope: McpScope): boolean {
  if (ctx.scopes.includes(scope) || ctx.scopes.includes('mcp:*')) return true;
  if ((scope === 'mcp:reserve' || scope === 'mcp:cancel') && ctx.scopes.includes('mcp:write')) {
    return true;
  }
  return false;
}

function assertScope(ctx: ToolContext, scope: McpScope): ToolResult | null {
  return hasScope(ctx, scope) ? null : toolError(`Missing scope: ${scope}`, 'FORBIDDEN');
}

function requiresPublicReservationProof(ctx: ToolContext): boolean {
  return !ctx.trustedRestaurantAccess;
}

function localDayAndMinutes(date: Date, timeZone: string): { day: string; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const weekday =
    parts
      .find((p) => p.type === 'weekday')
      ?.value.toLowerCase()
      .slice(0, 3) ?? '';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { day: weekday, minutes: hour * 60 + minute };
}

const DAY_INDEX_TO_NAME = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseTimeToMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function normalizeCreneauDay(value: unknown): string | null {
  if (typeof value === 'number') return DAY_INDEX_TO_NAME[value] ?? null;
  if (typeof value !== 'string') return null;
  const lower = value.toLowerCase();
  if (DAY_INDEX_TO_NAME.includes(lower)) return lower;
  return null;
}

function isWithinExposedCreneaux(args: {
  exposedCreneaux: unknown;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
}): boolean {
  if (!Array.isArray(args.exposedCreneaux) || args.exposedCreneaux.length === 0) return true;

  const startLocal = localDayAndMinutes(args.startsAt, args.timezone);
  const endLocal = localDayAndMinutes(args.endsAt, args.timezone);
  if (startLocal.day !== endLocal.day) return false;

  return args.exposedCreneaux.some((raw) => {
    if (!raw || typeof raw !== 'object') return false;
    const item = raw as Record<string, unknown>;
    const day = normalizeCreneauDay(item.day);
    const from = parseTimeToMinutes(item.from ?? item.start);
    const to = parseTimeToMinutes(item.to ?? item.end);
    if (!day || from === null || to === null) return false;
    return day === startLocal.day && startLocal.minutes >= from && endLocal.minutes <= to;
  });
}

export class McpToolRegistry {
  private readonly reservationService: ReservationService;
  private readonly holdService: HoldService;
  private readonly waitingListService: WaitingListService;
  private readonly availabilityService: AvailabilityService;
  private readonly audit: AuditLogService;
  private readonly idem: IdempotencyService;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly rateLimiter: McpRateLimiter,
  ) {
    this.audit = new AuditLogService(prisma);
    this.holdService = new HoldService(prisma, this.audit);
    this.waitingListService = new WaitingListService(
      prisma,
      new TableAllocationService(prisma),
      this.audit,
    );
    this.availabilityService = new AvailabilityService(prisma);
    const idemStore = new PrismaIdempotencyStore(prisma);
    this.idem = new IdempotencyService(idemStore);
    this.reservationService = new ReservationService(
      prisma,
      this.audit,
      this.holdService,
      this.idem,
    );
  }

  async searchRestaurants(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:read');
    if (scopeError) return scopeError;

    const parsed = SearchRestaurantsInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: SearchRestaurantsInput = parsed.data;

    const cursorId = input.cursor
      ? Buffer.from(input.cursor, 'base64url').toString('utf8')
      : undefined;
    if (
      cursorId &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursorId)
    ) {
      return toolError('Invalid cursor', 'INVALID_INPUT');
    }

    const rl = await this.rateLimiter.check(ctx.clientId, 'search_restaurants');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    try {
      const range = parseMcpDateRange({
        start: input.slotStart,
        end: input.slotEnd,
        defaultDurationMinutes: DEFAULT_MCP_SEARCH_DURATION_MINUTES,
        timezone: input.timezone,
        defaultTimezone: DEFAULT_MCP_TIMEZONE,
      });
      if (!range.ok) return toolError(range.error, range.code);
      const { start: slotStart, end: slotEnd } = range;
      const exposedResults: Array<{
        restaurantId: string;
        name: string;
        slug: string | null;
        formattedAddress: string | null;
        cuisineType: string[];
        priceRange: number | null;
        maxOnlinePartySize: number;
      }> = [];
      const namedRestaurantMatches = new Map<string, string>();
      let scanCursor = cursorId;
      for (let page = 0; page < 10 && exposedResults.length <= input.maxResults; page++) {
        const batch = await this.availabilityService.searchAvailableRestaurantsPage({
          city: input.city,
          ...(input.restaurantName ? { restaurantName: input.restaurantName } : {}),
          partySize: input.partySize,
          slotStart,
          slotEnd,
          cuisineType: input.cuisineType,
          maxResults: input.maxResults + 1,
          cursor: scanCursor,
        });
        for (const match of batch.restaurantMatches ?? []) {
          if (namedRestaurantMatches.size > 0) break;
          const exposure = await this.getMcpExposure(match.restaurantId, ctx);
          if (exposure.ok) {
            namedRestaurantMatches.set(match.restaurantId, match.name);
            break;
          }
        }
        for (const result of batch.results) {
          const exposure = await this.getMcpExposure(result.restaurantId, ctx);
          if (!exposure.ok) continue;
          if (input.restaurantName && !namedRestaurantMatches.has(result.restaurantId)) {
            namedRestaurantMatches.set(result.restaurantId, result.name);
          }
          const violation = this.validateExposureConstraints(exposure.settings, {
            partySize: input.partySize,
            startsAt: slotStart,
            endsAt: slotEnd,
          });
          if (!violation) {
            exposedResults.push({
              ...result,
              formattedAddress: result.formattedAddress ?? null,
              cuisineType: result.cuisineType ?? [],
              priceRange: result.priceRange ?? null,
              maxOnlinePartySize: exposure.settings.maxPartySize,
            });
            if (exposedResults.length > input.maxResults) break;
          }
        }
        scanCursor = batch.nextCursor;
        if (!scanCursor) break;
      }

      // Keep a named restaurant discoverable when the requested group is too
      // large. An empty restaurants array alone makes assistants report a
      // misleading "restaurant not found" message.
      const capacityLimits =
        exposedResults.length === 0
          ? await this.availabilityService.findCapacityLimits({
              city: input.city,
              ...(input.restaurantName ? { restaurantName: input.restaurantName } : {}),
              partySize: input.partySize,
              cuisineType: input.cuisineType,
              maxResults: input.maxResults,
            })
          : [];
      const exposedCapacityLimits: CapacityLimitHint[] = [];
      for (const hint of capacityLimits) {
        const exposure = await this.getMcpExposure(hint.restaurantId, ctx);
        if (exposure.ok) {
          exposedCapacityLimits.push(hint);
          if (input.restaurantName && !namedRestaurantMatches.has(hint.restaurantId)) {
            namedRestaurantMatches.set(hint.restaurantId, hint.name);
          }
        }
      }

      // Pagination cursor: si on a exactement maxResults résultats,
      // on encode le dernier ID comme cursor pour la page suivante.
      const hasMore = exposedResults.length > input.maxResults || Boolean(scanCursor);
      const nextCursor = hasMore
        ? Buffer.from(
            exposedResults.length >= input.maxResults
              ? exposedResults[input.maxResults - 1].restaurantId
              : scanCursor!,
          ).toString('base64url')
        : undefined;
      const namedMatches = [...namedRestaurantMatches.entries()];
      const namedRestaurantMatch =
        namedMatches.find(([id]) =>
          exposedResults.some((restaurant) => restaurant.restaurantId === id),
        ) ??
        namedMatches.find(([id]) =>
          exposedCapacityLimits.some((restaurant) => restaurant.restaurantId === id),
        ) ??
        namedMatches[0];
      const requestedRestaurant = input.restaurantName
        ? {
            ...(namedRestaurantMatch ? { id: namedRestaurantMatch[0] } : {}),
            name: namedRestaurantMatch?.[1] ?? input.restaurantName,
            status: !namedRestaurantMatch
              ? ('not_found' as const)
              : exposedResults.some(
                    (restaurant) => restaurant.restaurantId === namedRestaurantMatch[0],
                  )
                ? ('available' as const)
                : exposedCapacityLimits.some(
                      (restaurant) => restaurant.restaurantId === namedRestaurantMatch[0],
                    )
                  ? ('capacity_exceeded' as const)
                  : ('unavailable' as const),
          }
        : undefined;

      return ok({
        searchOutcome:
          exposedResults.length > 0
            ? 'available'
            : exposedCapacityLimits.length > 0
              ? 'capacity_exceeded'
              : 'no_exact_slot_available',
        ...(requestedRestaurant ? { requestedRestaurant } : {}),
        restaurants: exposedResults.slice(0, input.maxResults).map((r) => ({
          id: r.restaurantId,
          name: r.name,
          slug: r.slug,
          formattedAddress: r.formattedAddress,
          cuisineType: r.cuisineType,
          priceRange: r.priceRange,
          maxOnlinePartySize: r.maxOnlinePartySize,
          availableSlots: [
            {
              startsAt: slotStart.toISOString(),
              endsAt: slotEnd.toISOString(),
            },
          ],
        })),
        capacityLimits: exposedCapacityLimits.map((hint) => ({
          id: hint.restaurantId,
          name: hint.name,
          slug: hint.slug,
          formattedAddress: hint.formattedAddress ?? null,
          cuisineType: hint.cuisineType ?? [],
          priceRange: hint.priceRange ?? null,
          maxOnlinePartySize: hint.maxOnlinePartySize,
        })),
        nextCursor,
      });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'search_restaurants failed');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async getRestaurantDetails(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:read');
    if (scopeError) return scopeError;

    const parsed = GetRestaurantDetailsInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: GetRestaurantDetailsInput = parsed.data;

    const rl = await this.rateLimiter.check(ctx.clientId, 'get_restaurant_details');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;

      const r = await this.prisma.restaurant.findUnique({
        where: { id: input.restaurantId },
        select: {
          id: true,
          name: true,
          slug: true,
          formattedAddress: true,
          websiteUrl: true,
          cuisineType: true,
          priceRange: true,
          ambiance: true,
          noiseLevel: true,
          dietary: true,
          openingHours: true,
        },
      });
      if (!r) return toolError('Restaurant not found', 'NOT_FOUND');

      return ok({
        ...r,
        slug: r.slug ? canonicalDemoSlug(r.slug) : null,
        maxOnlinePartySize: exposure.settings.maxPartySize,
      });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'get_restaurant_details failed');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async checkAvailability(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:read');
    if (scopeError) return scopeError;

    const parsed = CheckAvailabilityInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: CheckAvailabilityInput = parsed.data;

    const rl = await this.rateLimiter.check(ctx.clientId, 'check_availability');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    const start = performance.now();
    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;

      const range = parseMcpDateRange({
        start: input.slotStart,
        end: input.slotEnd,
        defaultDurationMinutes: DEFAULT_MCP_SEARCH_DURATION_MINUTES,
        timezone: input.timezone,
        defaultTimezone: exposure.settings.timezone,
      });
      if (!range.ok) return toolError(range.error, range.code);
      const { start: slotStart, end: slotEnd } = range;
      const violation = this.validateExposureConstraints(exposure.settings, {
        partySize: input.partySize,
        startsAt: slotStart,
        endsAt: slotEnd,
      });
      if (violation) return violation;

      const result = await this.availabilityService.checkAvailability({
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        slotStart,
        slotEnd,
      });
      const alternativeSlots = result.alternativeSlots?.filter(
        (slot) =>
          !this.validateExposureConstraints(exposure.settings, {
            partySize: input.partySize,
            startsAt: new Date(slot.startsAt),
            endsAt: new Date(slot.endsAt),
          }),
      );
      const decision = result.available
        ? 'available'
        : result.reason === 'party_size_exceeds_capacity'
          ? 'capacity_exceeded'
          : 'unavailable';
      const recommendedAction = result.available
        ? ctx.scopes.includes('mcp:reserve')
          ? 'create_hold'
          : 'request_reserve_scope'
        : decision === 'capacity_exceeded'
          ? 'reduce_party_size'
          : alternativeSlots && alternativeSlots.length > 0
            ? 'choose_alternative_slot'
            : 'choose_another_slot';

      return ok({
        available: result.available,
        alternativeSlots: alternativeSlots ?? [],
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.maxOnlinePartySize !== undefined
          ? { maxOnlinePartySize: result.maxOnlinePartySize }
          : {}),
        decision,
        recommendedAction,
      });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'check_availability failed');
      return toolError('Internal error', 'INTERNAL');
    } finally {
      checkAvailabilityDuration.observe(performance.now() - start);
    }
  }

  async createReservation(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:reserve');
    if (scopeError) return scopeError;

    const parsed = CreateReservationInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: CreateReservationInput = parsed.data;

    const rl = await this.rateLimiter.check(ctx.clientId, 'create_reservation');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    const cleanSpecialRequests = sanitizeSpecialRequests(input.specialRequests);

    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;

      const range = parseMcpDateRange({
        start: input.startsAt,
        end: input.endsAt,
        timezone: input.timezone,
        defaultTimezone: exposure.settings.timezone,
      });
      if (!range.ok) return toolError(range.error, range.code);
      const { start: startsAt, end: endsAt } = range;
      const violation = this.validateExposureConstraints(exposure.settings, {
        partySize: input.partySize,
        startsAt,
        endsAt,
      });
      if (violation) return violation;

      // Empreinte bancaire (spec v1) : jamais de carte via un assistant ; la réservation se
      // termine sur la page du restaurant.
      const guarantee = await findCardGuaranteeTerms({
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        localDate: utcToZonedParts(startsAt, exposure.settings.timezone).date,
      });
      if (guarantee) {
        const restaurant = await this.prisma.restaurant.findUnique({
          where: { id: input.restaurantId },
          select: { slug: true },
        });
        return toolError(
          `Ce restaurant demande une empreinte bancaire pour cette réservation : elle se termine sur sa page de réservation${restaurant?.slug ? ` (${env.SITE_URL}/book/${restaurant.slug})` : ''}.`,
          'CARD_GUARANTEE_REQUIRED',
        );
      }

      const { policy } = await this.availabilityService.getPolicyFor(input.restaurantId);

      const scope = computeIdempotencyScope({
        restaurantId: input.restaurantId,
        channel: 'MCP',
        clientId: ctx.clientId,
      });

      const payloadHash = hashPayload({
        ...input,
        specialRequests: cleanSpecialRequests,
      });

      const result = await this.reservationService.createReservation(
        {
          restaurantId: input.restaurantId,
          partySize: input.partySize,
          startsAt,
          endsAt,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          channel: ctx.channel ?? 'MCP',
          policy,
          actor: ctx.actor,
          holdToken: input.holdToken,
          specialRequests: cleanSpecialRequests,
          consents: input.consents,
        },
        {
          scope,
          key: input.idempotencyKey,
          payloadHash,
          ttlSeconds: 24 * 60 * 60,
        },
      );

      return ok({
        reservationId: result.reservationId,
        state: result.state,
        reused: result.reused,
      });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'create_reservation failed');
      const errName = (err as { name?: string })?.name;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errName === 'InvalidStateTransitionError') return toolError(errMsg, 'INVALID_STATE');
      if (errName === 'PolicyValidationError') return toolError(errMsg, 'POLICY_VIOLATION');
      if (errName === 'IdempotencyConflictError') return toolError(errMsg, 'IDEMPOTENCY_CONFLICT');
      if (errName === 'HoldNotFoundError')
        return toolError('Invalid or expired hold', 'INVALID_HOLD');
      if (errName === 'HoldConflictError') return toolError('Slot unavailable', 'SLOT_UNAVAILABLE');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async createQuoteOrHold(
    rawInput: unknown,
    ctx: ToolContext,
    kind: 'quote' | 'hold',
  ): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:reserve');
    if (scopeError) return scopeError;
    const parsed = (kind === 'hold' ? CreateHoldInputSchema : CreateQuoteInputSchema).safeParse(
      rawInput,
    );
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input = parsed.data;
    const rl = await this.rateLimiter.check(ctx.clientId, `create_${kind}`);
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;
      const range = parseMcpDateRange({
        start: input.slotStart,
        end: input.slotEnd,
        timezone: input.timezone,
        defaultTimezone: exposure.settings.timezone,
      });
      if (!range.ok) return toolError(range.error, range.code);
      const violation = this.validateExposureConstraints(exposure.settings, {
        partySize: input.partySize,
        startsAt: range.start,
        endsAt: range.end,
      });
      if (violation) return violation;
      const available = await this.availabilityService.checkAvailability({
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        slotStart: range.start,
        slotEnd: range.end,
      });
      if (!available.available) return toolError('Slot unavailable', 'SLOT_UNAVAILABLE');
      const { policy } = await this.availabilityService.getPolicyFor(input.restaurantId);
      const args = {
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        slotStart: range.start,
        slotEnd: range.end,
        channel: ctx.channel ?? 'MCP',
        policy,
        actor: ctx.actor,
      } as const;
      if (kind === 'quote') {
        const quote = await this.holdService.createQuote(args);
        return ok({ quoteId: quote.id, expiresAt: quote.expiresAt.toISOString() });
      }
      if (
        kind === 'hold' &&
        !(await canHoldSlot({
          restaurantId: input.restaurantId,
          slotStart: range.start,
          clientIp: ctx.clientIp ?? ctx.clientId,
        }))
      ) {
        return toolError('Too many holds for this slot', 'RATE_LIMITED');
      }
      const hold = await this.holdService.createHold(args);
      return ok({ holdToken: hold.holdToken, expiresAt: hold.expiresAt.toISOString() });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, `create_${kind} failed`);
      if ((err as { name?: string })?.name === 'HoldConflictError') {
        return toolError('Slot unavailable', 'SLOT_UNAVAILABLE');
      }
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async joinWaitingList(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:reserve');
    if (scopeError) return scopeError;
    const parsed = JoinWaitingListInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input = parsed.data;
    const rl = await this.rateLimiter.check(ctx.clientId, 'join_waiting_list');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');
    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;
      const range = parseMcpDateRange({
        start: input.slotStart,
        end: input.slotEnd,
        timezone: input.timezone,
        defaultTimezone: exposure.settings.timezone,
      });
      if (!range.ok) return toolError(range.error, range.code);
      const violation = this.validateExposureConstraints(exposure.settings, {
        partySize: input.partySize,
        startsAt: range.start,
        endsAt: range.end,
      });
      if (violation) return violation;
      const availability = await this.availabilityService.checkAvailability({
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        slotStart: range.start,
        slotEnd: range.end,
      });
      if (availability.available) {
        return toolError('Slot available; book directly', 'SLOT_AVAILABLE');
      }
      const settings = await this.prisma.restaurantExposureSettings.findUnique({
        where: { restaurantId: input.restaurantId },
        select: { capacitySpecials: true },
      });
      const capacitySpecials = (settings?.capacitySpecials ?? {}) as Record<string, unknown>;
      if (capacitySpecials.waitingListEnabled !== true) {
        return toolError('Waiting list disabled', 'WAITING_LIST_DISABLED');
      }
      const joined = await this.waitingListService.join({
        restaurantId: input.restaurantId,
        partySize: input.partySize,
        customerFirstName: input.customerFirstName,
        customerLastName: input.customerLastName,
        customerPhone: input.customerPhone,
        customerEmail: input.customerEmail,
        consents: input.consents,
        slotStart: range.start,
        source: `mcp:${ctx.clientId}`,
        waitingListEnabled: true,
        waitingListMaxEntriesPerSlot:
          typeof capacitySpecials.waitingListMaxEntriesPerSlot === 'number'
            ? capacitySpecials.waitingListMaxEntriesPerSlot
            : 5,
      });
      return ok({
        entryId: joined.entry.id,
        position: joined.entry.position,
        actionToken: joined.actionToken,
      });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'join_waiting_list failed');
      const name = (err as { name?: string })?.name;
      if (name === 'WaitingListAlreadyExistsError')
        return toolError('Already joined', 'ALREADY_EXISTS');
      if (name === 'WaitingListSlotFullError')
        return toolError('Waiting list full', 'WAITING_LIST_FULL');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async cancelWaitingList(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:cancel');
    if (scopeError) return scopeError;
    const parsed = CancelWaitingListInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input = parsed.data;
    const rl = await this.rateLimiter.check(ctx.clientId, 'cancel_waiting_list');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');
    try {
      const exposure = await this.getMcpExposure(input.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;
      const entry = await this.waitingListService.cancelByToken(input);
      return ok({ entryId: entry.id, status: entry.status });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'cancel_waiting_list failed');
      const name = (err as { name?: string })?.name;
      if (name === 'WaitingListEntryNotFoundError')
        return toolError('Entry not found', 'NOT_FOUND');
      if (name === 'WaitingListAlreadyPromotedError')
        return toolError('Entry already promoted', 'INVALID_STATE');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async modifyReservation(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:reserve');
    if (scopeError) return scopeError;
    const parsed = ModifyReservationInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input = parsed.data;
    const rl = await this.rateLimiter.check(ctx.clientId, 'modify_reservation');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');
    try {
      const current = await this.prisma.reservation.findUnique({
        where: { id: input.reservationId },
        select: {
          restaurantId: true,
          createdByClient: true,
          customerPhone: true,
          startsAt: true,
          endsAt: true,
          partySize: true,
        },
      });
      if (
        !current ||
        (ctx.restaurantId && ctx.restaurantId !== current.restaurantId) ||
        (requiresPublicReservationProof(ctx) &&
          (current.createdByClient !== ctx.actor ||
            !input.customerPhone ||
            current.customerPhone !== input.customerPhone))
      ) {
        return toolError('Reservation not found', 'NOT_FOUND');
      }
      const exposure = await this.getMcpExposure(current.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;
      const range = input.startsAt
        ? parseMcpDateRange({
            start: input.startsAt,
            end: input.endsAt!,
            timezone: input.timezone,
            defaultTimezone: exposure.settings.timezone,
          })
        : null;
      if (range && !range.ok) return toolError(range.error, range.code);
      const startsAt = range?.ok ? range.start : current.startsAt;
      const endsAt = range?.ok ? range.end : current.endsAt;
      if (!startsAt || !endsAt)
        return toolError('Reservation has no editable slot', 'INVALID_STATE');
      const violation = this.validateExposureConstraints(exposure.settings, {
        partySize: input.partySize ?? current.partySize,
        startsAt,
        endsAt,
      });
      if (violation) return violation;
      return ok(
        await this.reservationService.modifyReservation({
          reservationId: input.reservationId,
          restaurantId: current.restaurantId,
          actor: ctx.actor,
          publicClient: requiresPublicReservationProof(ctx),
          customerPhone: input.customerPhone,
          partySize: input.partySize,
          startsAt: range?.ok ? range.start : undefined,
          endsAt: range?.ok ? range.end : undefined,
          customerName: input.customerName,
        }),
      );
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'modify_reservation failed');
      const name = (err as { name?: string })?.name;
      if (name === 'ReservationNotFoundError')
        return toolError('Reservation not found', 'NOT_FOUND');
      if (name === 'ReservationModificationNotAllowedError') {
        return toolError('Reservation cannot be modified', 'INVALID_STATE');
      }
      if (name === 'ReservationSlotUnavailableError') {
        return toolError('Slot unavailable', 'SLOT_UNAVAILABLE');
      }
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async cancelReservation(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:cancel');
    if (scopeError) return scopeError;

    const parsed = CancelReservationInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: CancelReservationInput = parsed.data;

    const rl = await this.rateLimiter.check(ctx.clientId, 'cancel_reservation');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    try {
      const reservation = await this.prisma.reservation.findUnique({
        where: { id: input.reservationId },
        select: { restaurantId: true, createdByClient: true, customerPhone: true, state: true },
      });
      if (!reservation) return toolError('Reservation not found', 'NOT_FOUND');

      // IDOR protection: un client lié à un restaurant ne peut agir
      // que sur les réservations de SON restaurant.
      if (ctx.restaurantId && ctx.restaurantId !== reservation.restaurantId) {
        return toolError('Reservation not found', 'NOT_FOUND');
      }
      if (
        requiresPublicReservationProof(ctx) &&
        (reservation.createdByClient !== ctx.actor ||
          !input.customerPhone ||
          reservation.customerPhone !== input.customerPhone)
      ) {
        return toolError('Reservation not found', 'NOT_FOUND');
      }

      const exposure = await this.getMcpExposure(reservation.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;

      // A retry after a successful cancellation is an idempotent success.
      if (reservation.state === 'CANCELLED') return ok({ cancelled: true });

      try {
        await this.reservationService.cancelReservation({
          reservationId: input.reservationId,
          restaurantId: reservation.restaurantId,
          actor: ctx.actor,
          reason: input.reason,
        });
      } catch (err: unknown) {
        // Two identical requests can both read the active state. If the other
        // request wins the lifecycle lock, confirm its final state and return
        // the same successful result without repeating side effects.
        if ((err as { name?: string })?.name === 'InvalidStateTransitionError') {
          const latest = await this.prisma.reservation.findUnique({
            where: { id: input.reservationId },
            select: { restaurantId: true, state: true },
          });
          if (latest?.restaurantId === reservation.restaurantId && latest.state === 'CANCELLED') {
            return ok({ cancelled: true });
          }
        }
        throw err;
      }
      return ok({ cancelled: true });
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'cancel_reservation failed');
      const errName = (err as { name?: string })?.name;
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errName === 'InvalidStateTransitionError') return toolError(errMsg, 'INVALID_STATE');
      if (errName === 'ReservationNotFoundError') return toolError(errMsg, 'NOT_FOUND');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  async getReservationStatus(rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
    const scopeError = assertScope(ctx, 'mcp:read');
    if (scopeError) return scopeError;

    const parsed = GetReservationStatusInputSchema.safeParse(rawInput);
    if (!parsed.success) return toolError(parsed.error.message, 'INVALID_INPUT');
    const input: GetReservationStatusInput = parsed.data;

    const rl = await this.rateLimiter.check(ctx.clientId, 'get_reservation_status');
    if (!rl.allowed) return toolError('Rate limit exceeded', 'RATE_LIMITED');

    try {
      const reservation = await this.prisma.reservation.findUnique({
        where: { id: input.reservationId },
        select: {
          id: true,
          restaurantId: true,
          createdByClient: true,
          customerPhone: true,
          state: true,
          partySize: true,
          startsAt: true,
          endsAt: true,
          createdAt: true,
        },
      });
      if (!reservation) return toolError('Reservation not found', 'NOT_FOUND');

      // IDOR protection: même check que cancel_reservation
      if (ctx.restaurantId && ctx.restaurantId !== reservation.restaurantId) {
        return toolError('Reservation not found', 'NOT_FOUND');
      }
      if (
        requiresPublicReservationProof(ctx) &&
        (reservation.createdByClient !== ctx.actor ||
          !input.customerPhone ||
          reservation.customerPhone !== input.customerPhone)
      ) {
        return toolError('Reservation not found', 'NOT_FOUND');
      }

      const exposure = await this.getMcpExposure(reservation.restaurantId, ctx);
      if (!exposure.ok) return exposure.error;

      const {
        restaurantId: _restaurantId,
        createdByClient: _createdByClient,
        customerPhone: _customerPhone,
        ...publicReservation
      } = reservation;
      return ok(publicReservation);
    } catch (err: unknown) {
      logger.error({ err, clientId: ctx.clientId }, 'get_reservation_status failed');
      return toolError('Internal error', 'INTERNAL');
    }
  }

  private async getMcpExposure(
    restaurantId: string,
    ctx: ToolContext,
  ): Promise<
    | {
        ok: true;
        settings: {
          timezone: string;
          maxPartySize: number;
          minLeadTimeMinutes: number;
          exposedCreneaux: unknown;
        };
      }
    | { ok: false; error: ToolResult }
  > {
    if (ctx.restaurantId && ctx.restaurantId !== restaurantId) {
      return { ok: false, error: toolError('Restaurant not found', 'NOT_FOUND') };
    }

    const restaurant = await this.prisma.restaurant.findFirst({
      where: {
        id: restaurantId,
        agenticOptIn: true,
        exposureSettings: { is: { mcpEnabled: true } },
      },
      select: {
        timezone: true,
        exposureSettings: {
          select: {
            maxPartySize: true,
            minLeadTimeMinutes: true,
            exposedCreneaux: true,
          },
        },
        floorPlans: {
          where: { isActive: true },
          select: {
            tables: {
              where: { isActive: true },
              select: { capacity: true },
            },
          },
        },
      },
    });

    if (!restaurant?.exposureSettings) {
      return { ok: false, error: toolError('Restaurant not found', 'NOT_FOUND') };
    }

    const maxOnlinePartySize =
      resolveEffectiveMaxPartySize({
        policyMaxPartySize: restaurant.exposureSettings.maxPartySize,
        floorPlans: restaurant.floorPlans,
      }) ?? restaurant.exposureSettings.maxPartySize;

    return {
      ok: true,
      settings: {
        timezone: restaurant.timezone,
        maxPartySize: maxOnlinePartySize,
        minLeadTimeMinutes: restaurant.exposureSettings.minLeadTimeMinutes,
        exposedCreneaux: restaurant.exposureSettings.exposedCreneaux,
      },
    };
  }

  private validateExposureConstraints(
    settings: {
      timezone: string;
      maxPartySize: number;
      minLeadTimeMinutes: number;
      exposedCreneaux: unknown;
    },
    request: { partySize: number; startsAt: Date; endsAt: Date },
  ): ToolResult | null {
    if (request.partySize > settings.maxPartySize) {
      return toolError(
        `partySize ${request.partySize} dépasse maxPartySize ${settings.maxPartySize} (capacité maximale en ligne)`,
        'POLICY_VIOLATION',
      );
    }

    const minutesBefore = (request.startsAt.getTime() - Date.now()) / 60_000;
    if (minutesBefore < settings.minLeadTimeMinutes) {
      return toolError(
        `Insufficient lead time: minimum ${settings.minLeadTimeMinutes}min requis`,
        'POLICY_VIOLATION',
      );
    }

    if (
      !isWithinExposedCreneaux({
        exposedCreneaux: settings.exposedCreneaux,
        startsAt: request.startsAt,
        endsAt: request.endsAt,
        timezone: settings.timezone,
      })
    ) {
      return toolError('Slot is not exposed via MCP', 'POLICY_VIOLATION');
    }

    return null;
  }
}

/**
 * Helper : exécute un tool et redacte la réponse.
 */
export async function executeTool(
  registry: McpToolRegistry,
  toolName: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  let result: ToolResult;
  switch (toolName) {
    case 'answer_availability': {
      const searchResult = await registry.searchRestaurants(rawInput, ctx);
      result = searchResult.ok
        ? ok({
            message: formatMcpSuccessMessage('search_restaurants', searchResult.data, rawInput),
          })
        : searchResult;
      break;
    }
    case 'search_restaurants':
      result = await registry.searchRestaurants(rawInput, ctx);
      break;
    case 'get_restaurant_details':
      result = await registry.getRestaurantDetails(rawInput, ctx);
      break;
    case 'check_availability':
      result = await registry.checkAvailability(rawInput, ctx);
      break;
    case 'create_reservation':
      result = await registry.createReservation(rawInput, ctx);
      break;
    case 'create_quote':
      result = await registry.createQuoteOrHold(rawInput, ctx, 'quote');
      break;
    case 'create_hold':
      result = await registry.createQuoteOrHold(rawInput, ctx, 'hold');
      break;
    case 'join_waiting_list':
      result = await registry.joinWaitingList(rawInput, ctx);
      break;
    case 'cancel_waiting_list':
      result = await registry.cancelWaitingList(rawInput, ctx);
      break;
    case 'modify_reservation':
      result = await registry.modifyReservation(rawInput, ctx);
      break;
    case 'cancel_reservation':
      result = await registry.cancelReservation(rawInput, ctx);
      break;
    case 'get_reservation_status':
      result = await registry.getReservationStatus(rawInput, ctx);
      break;
    default:
      recordMcpToolCall(toolName, 'error', ctx.credentialType, 'UNKNOWN_TOOL', ctx.transport);
      return toolError(`Unknown tool: ${toolName}`, 'UNKNOWN_TOOL');
  }

  // Redact and validate the exact payload exposed to the MCP client. Output
  // schemas are strict, so validation cannot silently strip undeclared fields.
  if (result.ok) {
    const data = redactResponse(result.data);
    // The hold token is an intentional one-time capability returned only by
    // create_hold. The generic redactor hides every other token field.
    if (typeof result.data === 'object' && result.data !== null) {
      if (toolName === 'create_hold') {
        (data as { holdToken?: string | null }).holdToken = (
          result.data as { holdToken?: string | null }
        ).holdToken;
      }
      if (toolName === 'join_waiting_list') {
        (data as { actionToken?: string }).actionToken = (
          result.data as { actionToken?: string }
        ).actionToken;
      }
    }
    assertNoPiiLeak(data, toolName);
    if (ctx.transport === 'mcp') {
      const outputSchema = getToolOutputSchema(toolName);
      const output = outputSchema?.safeParse(data);
      if (!outputSchema || !output || !output.success) {
        logger.error(
          {
            toolName,
            issues:
              output && !output.success
                ? output.error.issues.map((issue) => ({
                    code: issue.code,
                    path: issue.path.map(String),
                  }))
                : undefined,
          },
          'MCP tool output did not match its declared output schema',
        );
        result = toolError('Tool output failed schema validation', 'INTERNAL');
      } else {
        result = { ...result, data };
      }
    } else {
      result = { ...result, data };
    }
  }

  recordMcpToolCall(
    toolName,
    result.ok ? 'success' : 'error',
    ctx.credentialType,
    result.ok ? undefined : result.code,
    ctx.transport,
  );

  return result;
}
