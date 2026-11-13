/**
 * Service d'export RGPD (Article 15 — droit d'accès, Article 20 — portabilité).
 *
 * Retourne toutes les données personnelles d'un sujet dans un format
 * JSON portable et lisible (pour que le client puisse les transmettre
 * à un autre service).
 *
 * Le payload contient :
 *   - Profil (ce qu'on sait du sujet)
 *   - Réservations (avec PII, jamais anonymisées pour l'export)
 *   - Consentements (preuve de ce qui a été consenti)
 *   - Appels (si applicable, anonymisés en PII si besoin)
 */

import { withMergedCustomers } from './merged-customers';
import type { PrismaClient } from '@prisma/client';
import { ConsentService } from './consent.service';
import { CURRENT_PRIVACY_POLICY_VERSION } from './privacy-policy';
import {
  customerPhoneLookupValues,
  normalizeCustomerPhone,
} from '../customers/customer-crm.service';

export class ExportSubjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExportSubjectNotFoundError';
  }
}

export type ExportPayload = {
  exportedAt: string;
  privacyPolicyVersion: string;
  subject: {
    hashPrefix: string;
    // On ne stocke pas le téléphone en clair dans l'export final
    // sauf si le caller l'a explicitement demandé.
  };
  profile: {
    customerName: string | null;
    customerPhone: string | null;
    customerEmail: string | null;
  } | null;
  reservations: Array<{
    id: string;
    restaurantId: string;
    restaurantName: string | null;
    startsAt: string;
    endsAt: string;
    partySize: number;
    state: string;
    channel: string;
    customerName: string;
    customerPhone: string | null;
    specialRequests: string | null;
    createdAt: string;
  }>;
  /**
   * Appels téléphoniques rattachés au numéro appelant. Exporté parce que la
   * table `calls` porte désormais `callerPhone` : le périmètre annoncé au
   * client inclut ces données.
   */
  calls: Array<{
    id: string;
    restaurantId: string;
    outcome: string | null;
    intent: string | null;
    durationSec: number | null;
    createdAt: string;
  }>;
  experienceReservations: Array<{
    id: string;
    restaurantId: string;
    experienceId: string;
    sessionId: string;
    startsAt: string;
    endsAt: string;
    quantity: number;
    unitPriceCents: number;
    totalPriceCents: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
  eventOrders: Array<{
    id: string;
    restaurantId: string;
    eventId: string;
    sessionId: string;
    ticketTypeId: string;
    customerId: string | null;
    reservationId: string | null;
    quantity: number;
    unitPriceCents: number;
    totalPriceCents: number;
    currency: string;
    status: string;
    invoiceNumber: string | null;
    invoicedAt: string | null;
    refundedAt: string | null;
    cancelledAt: string | null;
    createdAt: string;
  }>;
  eventWaitlistEntries: Array<{
    id: string;
    restaurantId: string;
    eventId: string;
    sessionId: string;
    customerId: string | null;
    quantity: number;
    status: string;
    promotedAt: string | null;
    createdAt: string;
  }>;
  consents: Array<{
    id: string;
    restaurantId: string;
    channel: string;
    context: string;
    reservationProcessing: boolean;
    transactionalSms: boolean;
    transactionalEmail: boolean;
    marketingOptIn: boolean;
    privacyPolicyVersion: string;
    consentedAt: string;
  }>;
  crmProfiles: Array<{
    id: string;
    restaurantId: string;
    phone: string;
    emailNormalized: string | null;
    birthMonth: number | null;
    birthDay: number | null;
    preferredLocale: string | null;
    identities: Array<{
      id: string;
      type: string;
      value: string;
      normalizedValue: string;
      verifiedAt: string | null;
      source: string;
    }>;
    preferences: Array<{
      key: string;
      value: unknown;
      source: string;
      confidence: number | null;
      confirmedAt: string | null;
      expiresAt: string | null;
    }>;
    tags: Array<{ id: string; key: string; label: string; source: string }>;
  }>;
  crmMergeAudits: Array<{
    id: string;
    restaurantId: string;
    targetCustomerId: string;
    sourceCustomerIds: string[];
    preferenceResolution: unknown;
    summary: unknown;
    createdAt: string;
  }>;
  marketingPermissions: Array<{
    id: string;
    restaurantId: string;
    customerId: string;
    channel: string;
    status: string;
    source: string;
    proofVersion: string | null;
    proofHash: string | null;
    consentedAt: string | null;
    withdrawnAt: string | null;
    updatedAt: string;
  }>;
  marketingMessages: Array<{
    id: string;
    campaignId: string;
    channel: string;
    status: string;
    provider: string | null;
    providerMessageId: string | null;
    renderedBody: string | null;
    acceptedAt: string | null;
    sentAt: string | null;
    deliveredAt: string | null;
    createdAt: string;
  }>;
  marketingAttributionLinks: Array<{
    id: string;
    campaignId: string;
    issuedAt: string;
    expiresAt: string;
    clickedAt: string | null;
  }>;
  marketingAutomationDispatches: Array<{
    id: string;
    automationId: string;
    restaurantId: string;
    customerId: string;
    triggerKey: string;
    campaignId: string | null;
    status: string;
    reasonCode: string | null;
    occurredAt: string;
    createdAt: string;
  }>;
};

export class ExportService {
  constructor(private readonly prisma: PrismaClient) {}

  async exportSubject(args: { subject: string }): Promise<ExportPayload> {
    const subjectHash = ConsentService.hashSubject(args.subject);
    const phones = customerPhoneLookupValues(args.subject);
    const phoneFilter = phones.length === 1 ? phones[0] : { in: phones };
    const hashes = phones.map((phone) => ConsentService.hashSubject(phone));

    // Récupérer les résas (toutes les résas avec ce téléphone)
    const reservations = await this.prisma.reservation.findMany({
      where: { customerPhone: phoneFilter },
      select: {
        id: true,
        restaurantId: true,
        startsAt: true,
        endsAt: true,
        partySize: true,
        state: true,
        channel: true,
        customerName: true,
        customerPhone: true,
        customerEmail: true,
        specialRequests: true,
        createdAt: true,
        restaurant: { select: { name: true } },
      },
      orderBy: { startsAt: 'desc' },
    });

    // Récupérer les consents
    const consents = await this.prisma.customerConsent.findMany({
      where: { subjectHash: hashes.length === 1 ? subjectHash : { in: hashes } },
      orderBy: { consentedAt: 'desc' },
    });

    // Appels rattachés au numéro appelant. Le modèle est optionnel pendant la
    // fenêtre de déploiement (colonne additive), donc on le garde défensif.
    const callModel = (
      this.prisma as unknown as {
        call?: {
          findMany: (args: unknown) => Promise<Array<Record<string, unknown>>>;
        };
      }
    ).call;
    const calls = callModel
      ? await callModel.findMany({
          where: { callerPhone: phoneFilter },
          select: {
            id: true,
            restaurantId: true,
            outcome: true,
            intent: true,
            durationSec: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        })
      : [];

    // Customer CRM projections are optional during the expand/backfill window.
    // Guard the model so older test fixtures and pre-migration workers can still
    // execute the legacy export path.
    const normalizedPhone = normalizeCustomerPhone(args.subject);
    const foundCrmProfiles = this.prisma.customer
      ? ((await this.prisma.customer.findMany({
          where: normalizedPhone
            ? {
                OR: [
                  { phone: phoneFilter },
                  { identities: { some: { type: 'PHONE', normalizedValue: normalizedPhone } } },
                ],
              }
            : { phone: args.subject },
          select: { id: true, restaurantId: true, phone: true },
        })) ?? [])
      : [];
    const crmProfileIds = this.prisma.customer
      ? (await withMergedCustomers(this.prisma.customer, foundCrmProfiles)).map((c) => c.id)
      : [];
    const crmProfiles = this.prisma.customer
      ? ((await this.prisma.customer.findMany({
          where: { id: { in: crmProfileIds } },
          select: {
            id: true,
            restaurantId: true,
            phone: true,
            emailNormalized: true,
            feedbackEmailOptOutAt: true,
            feedbackEmailRequestedAt: true,
            birthMonth: true,
            birthDay: true,
            preferredLocale: true,
            identities: {
              select: {
                id: true,
                type: true,
                value: true,
                normalizedValue: true,
                verifiedAt: true,
                source: true,
              },
              orderBy: { createdAt: 'asc' },
            },
            preferences: {
              select: {
                key: true,
                value: true,
                source: true,
                confidence: true,
                confirmedAt: true,
                expiresAt: true,
              },
              orderBy: { key: 'asc' },
            },
            tagAssignments: {
              select: {
                source: true,
                tag: { select: { id: true, key: true, label: true } },
              },
              orderBy: { assignedAt: 'asc' },
            },
          },
          orderBy: { createdAt: 'asc' },
        })) ?? [])
      : [];

    const crmCustomerIds = crmProfiles.map((customer) => customer.id);
    const marketingPermissionModel = (
      this.prisma as unknown as {
        marketingPermission?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).marketingPermission;
    const campaignMessageModel = (
      this.prisma as unknown as {
        campaignMessage?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).campaignMessage;
    const attributionLinkModel = (
      this.prisma as unknown as {
        marketingAttributionLink?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).marketingAttributionLink;
    const automationDispatchModel = (
      this.prisma as unknown as {
        marketingAutomationDispatch?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).marketingAutomationDispatch;
    const mergeAuditModel = (
      this.prisma as unknown as {
        customerMergeAudit?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).customerMergeAudit;
    const experienceReservationModel = (
      this.prisma as unknown as {
        experienceReservation?: {
          findMany: (args: unknown) => Promise<unknown[]>;
        };
      }
    ).experienceReservation;
    const experienceReservations = experienceReservationModel
      ? ((await experienceReservationModel.findMany({
          where: {
            OR: [
              ...(crmCustomerIds.length > 0 ? [{ customerId: { in: crmCustomerIds } }] : []),
              { customer: { phone: phoneFilter } },
              { reservation: { customerPhone: phoneFilter } },
            ],
          },
          select: {
            id: true,
            restaurantId: true,
            experienceId: true,
            sessionId: true,
            quantity: true,
            unitPriceCents: true,
            totalPriceCents: true,
            currency: true,
            status: true,
            createdAt: true,
            session: { select: { startsAt: true, endsAt: true } },
          },
          orderBy: { createdAt: 'desc' },
        })) ?? [])
      : [];
    const eventOrderModel = (
      this.prisma as unknown as {
        eventOrder?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).eventOrder;
    const eventWaitlistModel = (
      this.prisma as unknown as {
        eventWaitlistEntry?: { findMany: (args: unknown) => Promise<unknown[]> };
      }
    ).eventWaitlistEntry;
    const customerFilter = crmCustomerIds.length
      ? { customerId: { in: crmCustomerIds } }
      : undefined;
    const [eventOrders, eventWaitlistEntries] = await Promise.all([
      eventOrderModel && customerFilter
        ? eventOrderModel.findMany({
            where: customerFilter,
            select: {
              id: true,
              restaurantId: true,
              eventId: true,
              sessionId: true,
              ticketTypeId: true,
              customerId: true,
              reservationId: true,
              quantity: true,
              unitPriceCents: true,
              totalPriceCents: true,
              currency: true,
              status: true,
              invoiceNumber: true,
              invoicedAt: true,
              refundedAt: true,
              cancelledAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      eventWaitlistModel && customerFilter
        ? eventWaitlistModel.findMany({
            where: customerFilter,
            select: {
              id: true,
              restaurantId: true,
              eventId: true,
              sessionId: true,
              customerId: true,
              quantity: true,
              status: true,
              promotedAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);
    const [
      marketingPermissions,
      marketingMessages,
      marketingAttributionLinks,
      marketingAutomationDispatches,
      crmMergeAudits,
    ] = await Promise.all([
      marketingPermissionModel && crmCustomerIds.length > 0
        ? marketingPermissionModel.findMany({
            where: { customerId: { in: crmCustomerIds } },
            orderBy: { updatedAt: 'desc' },
          })
        : Promise.resolve([]),
      campaignMessageModel && crmCustomerIds.length > 0
        ? campaignMessageModel.findMany({
            where: { customerId: { in: crmCustomerIds } },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
      attributionLinkModel && crmCustomerIds.length > 0
        ? attributionLinkModel.findMany({
            where: { customerId: { in: crmCustomerIds } },
            orderBy: { issuedAt: 'desc' },
          })
        : Promise.resolve([]),
      automationDispatchModel && crmCustomerIds.length > 0
        ? automationDispatchModel.findMany({
            where: { customerId: { in: crmCustomerIds } },
            orderBy: { occurredAt: 'desc' },
          })
        : Promise.resolve([]),
      mergeAuditModel && crmCustomerIds.length > 0
        ? mergeAuditModel.findMany({
            where: {
              OR: [
                { targetCustomerId: { in: crmCustomerIds } },
                { sourceCustomerIds: { hasSome: crmCustomerIds } },
              ],
            },
            orderBy: { createdAt: 'desc' },
          })
        : Promise.resolve([]),
    ]);

    if (
      reservations.length === 0 &&
      calls.length === 0 &&
      consents.length === 0 &&
      crmProfiles.length === 0 &&
      crmMergeAudits.length === 0 &&
      experienceReservations.length === 0 &&
      eventOrders.length === 0 &&
      eventWaitlistEntries.length === 0
    ) {
      throw new ExportSubjectNotFoundError(
        `No data found for subject hash ${subjectHash.slice(0, 8)}…`,
      );
    }

    // Profile : on prend la première résa comme référence
    const first = reservations[0];
    const firstCrmProfile = crmProfiles[0];
    const profile = first
      ? {
          customerName: first.customerName,
          customerPhone: first.customerPhone,
          customerEmail: first.customerEmail ?? null,
        }
      : firstCrmProfile
        ? {
            customerName: null,
            customerPhone: firstCrmProfile.phone,
            customerEmail: firstCrmProfile.emailNormalized,
          }
        : null;

    return {
      exportedAt: new Date().toISOString(),
      privacyPolicyVersion: CURRENT_PRIVACY_POLICY_VERSION,
      subject: { hashPrefix: subjectHash.slice(0, 8) },
      profile,
      reservations: reservations.map((r) => ({
        id: r.id,
        restaurantId: r.restaurantId,
        restaurantName: r.restaurant?.name ?? null,
        startsAt: (r.startsAt ?? r.createdAt).toISOString(),
        endsAt: (r.endsAt ?? r.createdAt).toISOString(),
        partySize: r.partySize,
        state: r.state,
        channel: r.channel,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
        specialRequests: r.specialRequests,
        createdAt: r.createdAt.toISOString(),
      })),
      calls: (calls as Array<Record<string, unknown>>).map((call) => ({
        id: String(call.id),
        restaurantId: String(call.restaurantId),
        outcome: (call.outcome as string | null) ?? null,
        intent: (call.intent as string | null) ?? null,
        durationSec: (call.durationSec as number | null) ?? null,
        createdAt:
          call.createdAt instanceof Date
            ? call.createdAt.toISOString()
            : String(call.createdAt ?? ''),
      })),
      experienceReservations: (experienceReservations as Array<Record<string, unknown>>).map(
        (reservation) => {
          const session = (reservation.session ?? {}) as Record<string, unknown>;
          const asIso = (value: unknown): string =>
            value instanceof Date ? value.toISOString() : String(value ?? '');
          return {
            id: String(reservation.id),
            restaurantId: String(reservation.restaurantId),
            experienceId: String(reservation.experienceId),
            sessionId: String(reservation.sessionId),
            startsAt: asIso(session.startsAt),
            endsAt: asIso(session.endsAt),
            quantity: Number(reservation.quantity),
            unitPriceCents: Number(reservation.unitPriceCents),
            totalPriceCents: Number(reservation.totalPriceCents),
            currency: String(reservation.currency),
            status: String(reservation.status),
            createdAt: asIso(reservation.createdAt),
          };
        },
      ),
      eventOrders: (eventOrders as Array<Record<string, unknown>>).map((order) => ({
        id: String(order.id),
        restaurantId: String(order.restaurantId),
        eventId: String(order.eventId),
        sessionId: String(order.sessionId),
        ticketTypeId: String(order.ticketTypeId),
        customerId:
          order.customerId === null || order.customerId === undefined
            ? null
            : String(order.customerId),
        reservationId:
          order.reservationId === null || order.reservationId === undefined
            ? null
            : String(order.reservationId),
        quantity: Number(order.quantity),
        unitPriceCents: Number(order.unitPriceCents),
        totalPriceCents: Number(order.totalPriceCents),
        currency: String(order.currency),
        status: String(order.status),
        invoiceNumber:
          order.invoiceNumber === null || order.invoiceNumber === undefined
            ? null
            : String(order.invoiceNumber),
        invoicedAt: order.invoicedAt instanceof Date ? order.invoicedAt.toISOString() : null,
        refundedAt: order.refundedAt instanceof Date ? order.refundedAt.toISOString() : null,
        cancelledAt: order.cancelledAt instanceof Date ? order.cancelledAt.toISOString() : null,
        createdAt:
          order.createdAt instanceof Date
            ? order.createdAt.toISOString()
            : String(order.createdAt ?? ''),
      })),
      eventWaitlistEntries: (eventWaitlistEntries as Array<Record<string, unknown>>).map(
        (entry) => ({
          id: String(entry.id),
          restaurantId: String(entry.restaurantId),
          eventId: String(entry.eventId),
          sessionId: String(entry.sessionId),
          customerId:
            entry.customerId === null || entry.customerId === undefined
              ? null
              : String(entry.customerId),
          quantity: Number(entry.quantity),
          status: String(entry.status),
          promotedAt: entry.promotedAt instanceof Date ? entry.promotedAt.toISOString() : null,
          createdAt:
            entry.createdAt instanceof Date
              ? entry.createdAt.toISOString()
              : String(entry.createdAt ?? ''),
        }),
      ),
      consents: consents.map((c) => ({
        id: c.id,
        restaurantId: c.restaurantId,
        channel: c.channel,
        context: c.context,
        reservationProcessing: c.reservationProcessing,
        transactionalSms: c.transactionalSms,
        transactionalEmail: c.transactionalEmail,
        marketingOptIn: c.marketingOptIn,
        privacyPolicyVersion: c.privacyPolicyVersion,
        consentedAt: c.consentedAt.toISOString(),
      })),
      crmProfiles: crmProfiles.map((customer) => ({
        id: customer.id,
        restaurantId: customer.restaurantId,
        phone: customer.phone,
        emailNormalized: customer.emailNormalized,
        birthMonth: customer.birthMonth,
        birthDay: customer.birthDay,
        preferredLocale: customer.preferredLocale,
        identities: customer.identities.map((identity) => ({
          id: identity.id,
          type: identity.type,
          value: identity.value,
          normalizedValue: identity.normalizedValue,
          verifiedAt: identity.verifiedAt?.toISOString() ?? null,
          source: identity.source,
        })),
        preferences: customer.preferences.map((preference) => ({
          key: preference.key,
          value: preference.value,
          source: preference.source,
          confidence: preference.confidence === null ? null : Number(preference.confidence),
          confirmedAt: preference.confirmedAt?.toISOString() ?? null,
          expiresAt: preference.expiresAt?.toISOString() ?? null,
        })),
        tags: customer.tagAssignments.map((assignment) => ({
          id: assignment.tag.id,
          key: assignment.tag.key,
          label: assignment.tag.label,
          source: assignment.source,
        })),
      })),
      crmMergeAudits: (crmMergeAudits as Array<Record<string, unknown>>).map((audit) => ({
        id: String(audit.id),
        restaurantId: String(audit.restaurantId),
        targetCustomerId: String(audit.targetCustomerId),
        sourceCustomerIds: Array.isArray(audit.sourceCustomerIds)
          ? audit.sourceCustomerIds.map(String)
          : [],
        preferenceResolution: audit.preferenceResolution ?? {},
        summary: audit.summary ?? {},
        createdAt:
          audit.createdAt instanceof Date
            ? audit.createdAt.toISOString()
            : String(audit.createdAt ?? ''),
      })),
      marketingPermissions: (marketingPermissions as Array<Record<string, unknown>>).map(
        (permission) => ({
          id: String(permission.id),
          restaurantId: String(permission.restaurantId),
          customerId: String(permission.customerId),
          channel: String(permission.channel),
          status: String(permission.status),
          source: String(permission.source),
          proofVersion:
            typeof permission.proofVersion === 'string' ? permission.proofVersion : null,
          proofHash: typeof permission.proofHash === 'string' ? permission.proofHash : null,
          consentedAt:
            permission.consentedAt instanceof Date ? permission.consentedAt.toISOString() : null,
          withdrawnAt:
            permission.withdrawnAt instanceof Date ? permission.withdrawnAt.toISOString() : null,
          updatedAt:
            permission.updatedAt instanceof Date
              ? permission.updatedAt.toISOString()
              : String(permission.updatedAt ?? ''),
        }),
      ),
      marketingMessages: (marketingMessages as Array<Record<string, unknown>>).map((message) => ({
        id: String(message.id),
        campaignId: String(message.campaignId),
        channel: String(message.channel),
        status: String(message.status),
        provider: typeof message.provider === 'string' ? message.provider : null,
        providerMessageId:
          typeof message.providerMessageId === 'string' ? message.providerMessageId : null,
        renderedBody: typeof message.renderedBody === 'string' ? message.renderedBody : null,
        acceptedAt: message.acceptedAt instanceof Date ? message.acceptedAt.toISOString() : null,
        sentAt: message.sentAt instanceof Date ? message.sentAt.toISOString() : null,
        deliveredAt: message.deliveredAt instanceof Date ? message.deliveredAt.toISOString() : null,
        createdAt:
          message.createdAt instanceof Date
            ? message.createdAt.toISOString()
            : String(message.createdAt ?? ''),
      })),
      marketingAttributionLinks: (marketingAttributionLinks as Array<Record<string, unknown>>).map(
        (link) => ({
          id: String(link.id),
          campaignId: String(link.campaignId),
          issuedAt:
            link.issuedAt instanceof Date
              ? link.issuedAt.toISOString()
              : String(link.issuedAt ?? ''),
          expiresAt:
            link.expiresAt instanceof Date
              ? link.expiresAt.toISOString()
              : String(link.expiresAt ?? ''),
          clickedAt: link.clickedAt instanceof Date ? link.clickedAt.toISOString() : null,
        }),
      ),
      marketingAutomationDispatches: (
        marketingAutomationDispatches as Array<Record<string, unknown>>
      ).map((dispatch) => ({
        id: String(dispatch.id),
        automationId: String(dispatch.automationId),
        restaurantId: String(dispatch.restaurantId),
        customerId: String(dispatch.customerId),
        triggerKey: String(dispatch.triggerKey),
        campaignId: typeof dispatch.campaignId === 'string' ? dispatch.campaignId : null,
        status: String(dispatch.status),
        reasonCode: typeof dispatch.reasonCode === 'string' ? dispatch.reasonCode : null,
        occurredAt:
          dispatch.occurredAt instanceof Date
            ? dispatch.occurredAt.toISOString()
            : String(dispatch.occurredAt ?? ''),
        createdAt:
          dispatch.createdAt instanceof Date
            ? dispatch.createdAt.toISOString()
            : String(dispatch.createdAt ?? ''),
      })),
    };
  }
}
