/**
 * Admin service pour l'agentic reservations.
 *
 * - getOptIn / setOptIn : toggle MCP (mcpEnabled, et agenticOptIn à l'activation) / openaiReserveEnabled
 * - getExposureSettings / setExposureSettings : CRUD sur RestaurantExposureSettings
 * - Sécurité : OpenAI Reserve ne peut être activé que si MCP est activé
 *   (le feed OpenAI consomme la même policy que MCP, et la résa MCP est
 *   un pré-requis de la résa OpenAI côté UX)
 * - Garde-fou : si le restaurant n'a pas lat/lng/websiteUrl, on refuse
 *   d'activer OpenAI Reserve (requis par le business feed OpenAI).
 * - Audit : chaque mutation log un event opt_in_changed ou
 *   exposure_settings_changed avec diff before/after.
 */

import type { PrismaClient, Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { logger } from '../../../shared/logger/pino';
import { hashApiKey } from '../../../shared/crypto/api-key-hash';
import { AGENT_KEY_PREFIX, getApiKeyPrefix } from '../mcp/auth.js';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { PolicyValidationError, validateExposureSettings } from '../core/policies.service.js';
import { AuditLogService } from '../core/audit-log.service.js';
import {
  type AgentClientCreateInput,
  type ExposureSettingsInput,
  type OptInInput,
} from './schemas.js';
import { invalidateRestaurantContextCache } from '../../restaurants/restaurant.service';

export class OptInGuardError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OptInGuardError';
  }
}

export class AgenticAdminService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditLogService,
  ) {}

  async getOptIn(restaurantId: string): Promise<{
    mcp: boolean;
    openaiReserve: boolean;
    policyVersion: string;
  }> {
    const r = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: {
        agenticOptIn: true,
        openaiReserveEnabled: true,
        policyVersion: true,
      },
    });
    return {
      mcp: await this.isMcpActive(restaurantId, r.agenticOptIn),
      openaiReserve: r.openaiReserveEnabled,
      policyVersion: r.policyVersion,
    };
  }

  async setOptIn(args: { restaurantId: string; input: OptInInput; actor: string }): Promise<void> {
    const current = await this.prisma.restaurant.findUniqueOrThrow({
      where: { id: args.restaurantId },
      select: {
        agenticOptIn: true,
        openaiReserveEnabled: true,
        lat: true,
        lng: true,
        websiteUrl: true,
        formattedAddress: true,
        phoneE164: true,
      },
    });

    // Garde-fou : OpenAI Reserve requiert lat/lng/websiteUrl/phone/address à son activation. Un
    // OpenAI Reserve déjà actif ne bloque pas les autres réglages (MCP) : le flux écarte lui-même
    // les restaurants incomplets.
    if (args.input.openaiReserve && !current.openaiReserveEnabled) {
      // Libellés lisibles par le restaurateur ; le code d'erreur reste inchangé pour les clients de l'API.
      const missing: string[] = [];
      if (current.lat == null || current.lng == null) missing.push('coordonnées GPS');
      if (!current.websiteUrl) missing.push('site web');
      if (!current.formattedAddress) missing.push('adresse');
      if (!current.phoneE164) missing.push('téléphone');
      if (missing.length > 0) {
        throw new OptInGuardError(
          `Pour activer OpenAI Reserve, complétez les informations du restaurant : ${missing.join(', ')}.`,
          'OPENAI_RESERVE_MISSING_FIELDS',
        );
      }
    }

    // La publication Suppernote Connect pose `agenticOptIn` sans `mcpEnabled` : on compare l'état
    // réellement actif (les deux drapeaux) pour qu'une activation resynchronise `mcpEnabled`.
    const currentMcp = await this.isMcpActive(args.restaurantId, current.agenticOptIn);
    const mcpChanged = args.input.mcp !== currentMcp;
    const openaiChanged = args.input.openaiReserve !== current.openaiReserveEnabled;

    if (!mcpChanged && !openaiChanged) return;

    await this.prisma.$transaction(async (tx) => {
      // `agenticOptIn` sert aussi de condition à la page publique Connect et au widget
      // (`PUBLIC_CONNECT_WHERE`) : couper MCP ne retire que `mcpEnabled`, sans éteindre la page.
      // Activer MCP pose les deux drapeaux.
      await tx.restaurant.update({
        where: { id: args.restaurantId },
        data: args.input.mcp
          ? { agenticOptIn: true, openaiReserveEnabled: args.input.openaiReserve }
          : // Si MCP est désactivé, OpenAI Reserve doit l'être aussi
            { openaiReserveEnabled: false },
      });

      // Synchroniser mcpEnabled sur RestaurantExposureSettings dans la même
      // transaction. L'OAuth consent flow et le MCP registry checkent
      // exposureSettings.mcpEnabled, pas restaurant.agenticOptIn. Sans ce
      // upsert, le toggle dashboard MCP n'a aucun effet sur le flow OAuth.
      await tx.restaurantExposureSettings.upsert({
        where: { restaurantId: args.restaurantId },
        create: {
          restaurant: { connect: { id: args.restaurantId } },
          mcpEnabled: args.input.mcp,
        },
        update: {
          mcpEnabled: args.input.mcp,
        },
      });

      await tx.reservationAuditLog.create({
        data: {
          event: 'opt_in_changed',
          actor: args.actor,
          metadata: {
            restaurantId: args.restaurantId,
            before: {
              mcp: currentMcp,
              openaiReserve: current.openaiReserveEnabled,
            },
            after: {
              mcp: args.input.mcp,
              openaiReserve: args.input.mcp ? args.input.openaiReserve : false,
            },
          },
        },
      });
    });
  }

  /** MCP n'est réservable que si l'opt-in restaurant et `exposureSettings.mcpEnabled` sont posés. */
  private async isMcpActive(restaurantId: string, agenticOptIn: boolean): Promise<boolean> {
    if (!agenticOptIn) return false;
    const settings = await this.prisma.restaurantExposureSettings.findUnique({
      where: { restaurantId },
      select: { mcpEnabled: true },
    });
    return settings?.mcpEnabled ?? false;
  }

  async getExposureSettings(restaurantId: string): Promise<{
    maxPartySize: number;
    minLeadTimeMinutes: number;
    requireManualValidation: boolean;
    quoteTtlSeconds: number;
    holdTtlSeconds: number;
    noShowPolicy: string;
    notificationChannels: string[];
    exposedCreneaux: unknown[];
    capacitySpecials: Record<string, unknown>;
  }> {
    const s = await this.prisma.restaurantExposureSettings.findUnique({
      where: { restaurantId },
    });
    if (!s) {
      // Retourne les défauts sans créer de ligne en DB
      return {
        maxPartySize: DEFAULT_MAX_PARTY_SIZE,
        minLeadTimeMinutes: 30,
        requireManualValidation: false,
        quoteTtlSeconds: 300,
        holdTtlSeconds: 420,
        noShowPolicy: 'warning',
        notificationChannels: ['sms', 'email'],
        exposedCreneaux: [],
        capacitySpecials: {},
      };
    }
    return {
      maxPartySize: s.maxPartySize,
      minLeadTimeMinutes: s.minLeadTimeMinutes,
      requireManualValidation: s.requireManualValidation,
      quoteTtlSeconds: s.quoteTtlSeconds,
      holdTtlSeconds: s.holdTtlSeconds,
      noShowPolicy: s.noShowPolicy,
      notificationChannels: [...s.notificationChannels],
      exposedCreneaux: (s.exposedCreneaux as unknown[]) ?? [],
      capacitySpecials: (s.capacitySpecials as Record<string, unknown>) ?? {},
    };
  }

  async setExposureSettings(args: {
    restaurantId: string;
    input: ExposureSettingsInput;
    actor: string;
  }): Promise<void> {
    const before = await this.prisma.restaurantExposureSettings.findUnique({
      where: { restaurantId: args.restaurantId },
    });

    const mergedSettings = {
      maxPartySize: args.input.maxPartySize ?? before?.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE,
      minLeadTimeMinutes: args.input.minLeadTimeMinutes ?? before?.minLeadTimeMinutes ?? 30,
      requireManualValidation:
        args.input.requireManualValidation ?? before?.requireManualValidation ?? false,
      quoteTtlSeconds: args.input.quoteTtlSeconds ?? before?.quoteTtlSeconds ?? 300,
      holdTtlSeconds: args.input.holdTtlSeconds ?? before?.holdTtlSeconds ?? 420,
      noShowPolicy: args.input.noShowPolicy ?? before?.noShowPolicy ?? 'warning',
      notificationChannels: args.input.notificationChannels ??
        before?.notificationChannels ?? ['sms', 'email'],
      capacitySpecials:
        args.input.capacitySpecials ??
        (before?.capacitySpecials as Record<string, unknown> | null) ??
        {},
    };

    // Validation sur l'état final, pas seulement sur le patch entrant.
    try {
      validateExposureSettings(mergedSettings);
    } catch (err) {
      if (err instanceof PolicyValidationError) {
        throw err;
      }
      throw err;
    }

    // Garde-fou : si des réservations futures existent avec partySize > nouveau max,
    // on refuse pour éviter de les invalider silencieusement
    if (args.input.maxPartySize !== undefined) {
      const future = await this.prisma.reservation.count({
        where: {
          restaurantId: args.restaurantId,
          partySize: { gt: args.input.maxPartySize },
          reservedAt: { gte: new Date() },
          state: { in: ['PENDING', 'CONFIRMED', 'SEATED'] },
        },
      });
      if (future > 0) {
        throw new PolicyValidationError(
          `${future} réservation(s) future(s) dépassent le nouveau maxPartySize=${args.input.maxPartySize}. Annule ou déplace ces résas avant de réduire la limite.`,
          'FUTURE_RESERVATIONS_EXCEED_MAX',
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      const updateData: Prisma.RestaurantExposureSettingsUpdateInput = {};
      if (args.input.maxPartySize !== undefined) updateData.maxPartySize = args.input.maxPartySize;
      if (args.input.minLeadTimeMinutes !== undefined)
        updateData.minLeadTimeMinutes = args.input.minLeadTimeMinutes;
      if (args.input.requireManualValidation !== undefined)
        updateData.requireManualValidation = args.input.requireManualValidation;
      if (args.input.quoteTtlSeconds !== undefined)
        updateData.quoteTtlSeconds = args.input.quoteTtlSeconds;
      if (args.input.holdTtlSeconds !== undefined)
        updateData.holdTtlSeconds = args.input.holdTtlSeconds;
      if (args.input.noShowPolicy !== undefined) updateData.noShowPolicy = args.input.noShowPolicy;
      if (args.input.notificationChannels !== undefined)
        updateData.notificationChannels = args.input.notificationChannels;
      if (args.input.exposedCreneaux !== undefined)
        updateData.exposedCreneaux = args.input.exposedCreneaux as Prisma.InputJsonValue;
      if (args.input.capacitySpecials !== undefined)
        updateData.capacitySpecials = args.input.capacitySpecials as Prisma.InputJsonValue;

      await tx.restaurantExposureSettings.upsert({
        where: { restaurantId: args.restaurantId },
        create: {
          restaurant: { connect: { id: args.restaurantId } },
          maxPartySize: args.input.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE,
          minLeadTimeMinutes: args.input.minLeadTimeMinutes ?? 30,
          requireManualValidation: args.input.requireManualValidation ?? false,
          quoteTtlSeconds: args.input.quoteTtlSeconds ?? 300,
          holdTtlSeconds: args.input.holdTtlSeconds ?? 420,
          noShowPolicy: args.input.noShowPolicy ?? 'warning',
          notificationChannels: args.input.notificationChannels ?? ['sms', 'email'],
          exposedCreneaux: (args.input.exposedCreneaux ?? []) as Prisma.InputJsonValue,
          capacitySpecials: (args.input.capacitySpecials ?? {}) as Prisma.InputJsonValue,
        },
        update: updateData,
      });

      await tx.reservationAuditLog.create({
        data: {
          event: 'exposure_settings_changed',
          actor: args.actor,
          metadata: {
            restaurantId: args.restaurantId,
            before: before ?? null,
            after: args.input,
          },
        },
      });
    });

    logger.info(
      {
        restaurantId: args.restaurantId,
        actor: args.actor,
        keys: Object.keys(args.input),
      },
      'exposure settings updated',
    );

    // Le seuil de groupe sert aussi au téléphone, dont le contexte est en cache.
    if (args.input.maxPartySize !== undefined) {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: args.restaurantId },
        select: { phoneNumber: true },
      });
      await invalidateRestaurantContextCache(restaurant?.phoneNumber);
    }
  }

  async listAgentClients(restaurantId: string): Promise<
    Array<{
      id: string;
      name: string;
      keyPrefix: string;
      scopes: string[];
      allowedOrigins: string[];
      lastUsedAt: Date | null;
      createdAt: Date;
    }>
  > {
    const clients = await this.prisma.agentClient.findMany({
      where: {
        restaurantId,
        revokedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        allowedOrigins: true,
        lastUsedAt: true,
        createdAt: true,
      },
    });

    return clients.map((c) => ({
      ...c,
      scopes: [...c.scopes],
      allowedOrigins: [...c.allowedOrigins],
    }));
  }

  async createAgentClient(args: {
    restaurantId: string;
    input: AgentClientCreateInput;
    actor: string;
  }): Promise<{
    client: {
      id: string;
      name: string;
      keyPrefix: string;
      scopes: string[];
      allowedOrigins: string[];
      lastUsedAt: Date | null;
      createdAt: Date;
    };
    apiKey: string;
  }> {
    const apiKey = this.generateApiKey();
    const keyPrefix = this.getApiKeyPrefix(apiKey);
    const keyHash = this.hashApiKey(apiKey);

    const client = await this.prisma.$transaction(async (tx) => {
      const created = await tx.agentClient.create({
        data: {
          restaurantId: args.restaurantId,
          name: args.input.name,
          keyPrefix,
          keyHash,
          scopes: args.input.scopes,
          allowedOrigins: args.input.allowedOrigins,
        },
        select: {
          id: true,
          name: true,
          keyPrefix: true,
          scopes: true,
          allowedOrigins: true,
          lastUsedAt: true,
          createdAt: true,
        },
      });

      await tx.reservationAuditLog.create({
        data: {
          event: 'agent_client_created',
          actor: args.actor,
          metadata: {
            restaurantId: args.restaurantId,
            clientId: created.id,
            keyPrefix: created.keyPrefix,
            scopes: created.scopes,
            allowedOrigins: created.allowedOrigins,
          },
        },
      });

      return created;
    });

    return {
      client: {
        ...client,
        scopes: [...client.scopes],
        allowedOrigins: [...client.allowedOrigins],
      },
      apiKey,
    };
  }

  async revokeAgentClient(args: {
    restaurantId: string;
    clientId: string;
    actor: string;
  }): Promise<void> {
    const existing = await this.prisma.agentClient.findFirst({
      where: {
        id: args.clientId,
        restaurantId: args.restaurantId,
        revokedAt: null,
      },
      select: {
        id: true,
        keyPrefix: true,
        scopes: true,
        allowedOrigins: true,
      },
    });

    if (!existing) {
      throw new OptInGuardError('Client MCP introuvable', 'AGENT_CLIENT_NOT_FOUND');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.agentClient.update({
        where: { id: args.clientId },
        data: { revokedAt: new Date() },
      });

      await tx.reservationAuditLog.create({
        data: {
          event: 'agent_client_revoked',
          actor: args.actor,
          metadata: {
            restaurantId: args.restaurantId,
            clientId: existing.id,
            keyPrefix: existing.keyPrefix,
            scopes: existing.scopes,
            allowedOrigins: existing.allowedOrigins,
          },
        },
      });
    });
  }

  private generateApiKey(): string {
    return `${AGENT_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  }

  private hashApiKey(apiKey: string): string {
    return hashApiKey(apiKey);
  }

  private getApiKeyPrefix(apiKey: string): string {
    return getApiKeyPrefix(apiKey);
  }
}
