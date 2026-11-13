/**
 * Tests for the RGPD export service (Article 15 — droit d'accès).
 *
 * Retourne toutes les données d'un sujet dans un payload JSON portable.
 * Le caller fournit le téléphone exact utilisé lors des résas.
 *
 * Si aucune résa et aucun consent → ExportSubjectNotFoundError.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ExportService, ExportSubjectNotFoundError } from '../export.service';

function makePrisma() {
  return {
    reservation: { findMany: vi.fn() },
    customerConsent: { findMany: vi.fn() },
    call: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaClient;
}

describe('ExportService.exportSubject', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ExportService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new ExportService(prisma);
  });

  it('lève ExportSubjectNotFoundError si aucune résa et aucun consent', async () => {
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    await expect(service.exportSubject({ subject: '+336****0000' })).rejects.toBeInstanceOf(
      ExportSubjectNotFoundError,
    );
  });

  it('retrouve les formes nationale et internationale et accepte un sujet avec appels seuls', async () => {
    vi.mocked(prisma.reservation.findMany).mockResolvedValue([]);
    vi.mocked(prisma.customerConsent.findMany).mockResolvedValue([]);
    vi.mocked(prisma.call.findMany).mockResolvedValue([
      {
        id: 'call-1',
        restaurantId: 'r-1',
        outcome: null,
        intent: null,
        durationSec: 5,
        createdAt: new Date('2026-01-01'),
      },
    ] as never);

    const result = await service.exportSubject({ subject: '+33601020304' });
    const phoneFilter = { in: ['+33601020304', '0601020304'] };
    expect(prisma.reservation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerPhone: phoneFilter } }),
    );
    expect(prisma.call.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callerPhone: phoneFilter } }),
    );
    expect(prisma.customerConsent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subjectHash: { in: expect.arrayContaining([expect.any(String)]) } },
      }),
    );
    expect(result.calls).toHaveLength(1);
  });

  it('export les résas triées desc par date avec profil de la première résa', async () => {
    const future = new Date('2026-07-15T19:00:00Z');
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'res-1',
        restaurantId: 'rest-1',
        startsAt: future,
        endsAt: future,
        partySize: 4,
        state: 'CONFIRMED',
        channel: 'PHONE',
        customerName: 'Alice',
        customerPhone: '+336****1111',
        specialRequests: 'Allergie gluten',
        createdAt: new Date('2026-07-01T10:00:00Z'),
        restaurant: { name: 'Chez Suppernote' },
      },
    ]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await service.exportSubject({ subject: '+336****1111' });

    expect(result.reservations).toHaveLength(1);
    expect(result.reservations[0]).toMatchObject({
      id: 'res-1',
      restaurantName: 'Chez Suppernote',
      partySize: 4,
      customerName: 'Alice',
    });
    // Le profile vient de la première résa
    expect(result.profile).toEqual({
      customerName: 'Alice',
      customerPhone: '+336****1111',
      customerEmail: null,
    });
  });

  it('export les consents avec privacy policy version', async () => {
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'c-1',
        restaurantId: 'rest-1',
        channel: 'MCP',
        context: 'openai_reserve',
        reservationProcessing: true,
        transactionalSms: false,
        transactionalEmail: false,
        marketingOptIn: true,
        privacyPolicyVersion: '2026-01-01',
        consentedAt: new Date('2026-06-15T10:00:00Z'),
      },
    ]);

    const result = await service.exportSubject({ subject: '+336****2222' });

    expect(result.consents).toHaveLength(1);
    expect(result.consents[0]).toMatchObject({
      id: 'c-1',
      channel: 'MCP',
      marketingOptIn: true,
    });
  });

  it('exporte les appels rattachés au numéro appelant', async () => {
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'c-1',
        restaurantId: 'rest-1',
        channel: 'VOICE',
        context: 'voice_call',
        reservationProcessing: true,
        transactionalSms: false,
        transactionalEmail: false,
        marketingOptIn: false,
        privacyPolicyVersion: '2026-01-01',
        consentedAt: new Date('2026-06-15T10:00:00Z'),
      },
    ]);
    (prisma.call.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'call-1',
        restaurantId: 'rest-1',
        outcome: 'MESSAGE',
        intent: 'RESERVATION',
        durationSec: 61,
        createdAt: new Date('2026-09-20T19:00:00Z'),
      },
    ]);

    const result = await service.exportSubject({ subject: '+336****2222' });

    expect(prisma.call.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { callerPhone: '+336****2222' } }),
    );
    expect(result.calls).toEqual([
      {
        id: 'call-1',
        restaurantId: 'rest-1',
        outcome: 'MESSAGE',
        intent: 'RESERVATION',
        durationSec: 61,
        createdAt: '2026-09-20T19:00:00.000Z',
      },
    ]);
  });

  it("profile est null si le sujet n'a aucune résa (mais a des consents)", async () => {
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'c-1',
        restaurantId: 'rest-1',
        channel: 'WEB',
        context: 'web_form',
        reservationProcessing: true,
        transactionalSms: false,
        transactionalEmail: false,
        marketingOptIn: false,
        privacyPolicyVersion: '2026-01-01',
        consentedAt: new Date(),
      },
    ]);

    const result = await service.exportSubject({ subject: '+336****3333' });

    expect(result.profile).toBeNull();
    expect(result.consents).toHaveLength(1);
  });

  it("retourne le hash prefix (8 premiers chars hex) et le timestamp d'export", async () => {
    (prisma.reservation.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'res-1',
        restaurantId: 'rest-1',
        startsAt: new Date('2026-07-01'),
        endsAt: new Date('2026-07-01'),
        partySize: 2,
        state: 'CONFIRMED',
        channel: 'PHONE',
        customerName: 'X',
        customerPhone: '+336****9999',
        specialRequests: null,
        createdAt: new Date('2026-06-15'),
        restaurant: { name: 'Resto' },
      },
    ]);
    (prisma.customerConsent.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await service.exportSubject({ subject: '+336****9999' });

    expect(result.subject.hashPrefix).toMatch(/^[0-9a-f]{8}$/);
    expect(result.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.privacyPolicyVersion).toMatch(/.+/);
  });

  it('inclut les permissions par canal et les messages marketing du profil CRM', async () => {
    const crmPrisma = {
      reservation: { findMany: vi.fn().mockResolvedValue([]) },
      customerConsent: { findMany: vi.fn().mockResolvedValue([]) },
      customer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'customer-1',
            restaurantId: 'rest-1',
            phone: '+33601020304',
            emailNormalized: 'alice@example.test',
            birthMonth: 4,
            birthDay: 12,
            preferredLocale: 'fr-FR',
            identities: [],
            preferences: [],
            tagAssignments: [],
            createdAt: new Date('2026-01-01'),
          },
        ]),
      },
      marketingPermission: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'permission-1',
            restaurantId: 'rest-1',
            customerId: 'customer-1',
            channel: 'EMAIL',
            status: 'OPTED_IN',
            source: 'WEB_FORM',
            proofVersion: 'privacy-2026-09',
            proofHash: 'a'.repeat(64),
            consentedAt: new Date('2026-02-01'),
            withdrawnAt: null,
            updatedAt: new Date('2026-02-01'),
          },
        ]),
      },
      campaignMessage: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'message-1',
            campaignId: 'campaign-1',
            channel: 'EMAIL',
            status: 'DELIVERED',
            provider: 'resend',
            providerMessageId: 'provider-1',
            renderedBody: 'Bonjour Alice',
            acceptedAt: new Date('2026-02-02'),
            sentAt: new Date('2026-02-02'),
            deliveredAt: new Date('2026-02-02'),
            createdAt: new Date('2026-02-02'),
          },
        ]),
      },
      marketingAutomationDispatch: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'dispatch-1',
            automationId: 'automation-1',
            restaurantId: 'rest-1',
            customerId: 'customer-1',
            triggerKey: 'first-honored:reservation-1',
            campaignId: 'campaign-1',
            status: 'QUEUED',
            reasonCode: null,
            occurredAt: new Date('2026-02-01'),
            createdAt: new Date('2026-02-01'),
          },
        ]),
      },
      customerMergeAudit: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'merge-audit-1',
            restaurantId: 'rest-1',
            targetCustomerId: 'customer-1',
            sourceCustomerIds: ['customer-2'],
            preferenceResolution: { preferred_language: 'target' },
            summary: { sourceCount: 1, reservationsMoved: 2 },
            createdAt: new Date('2026-02-03'),
          },
        ]),
      },
    } as unknown as PrismaClient;

    const result = await new ExportService(crmPrisma).exportSubject({ subject: '+33601020304' });

    expect(result.marketingPermissions).toEqual([
      expect.objectContaining({ id: 'permission-1', channel: 'EMAIL', status: 'OPTED_IN' }),
    ]);
    expect(result.marketingMessages).toEqual([
      expect.objectContaining({
        id: 'message-1',
        status: 'DELIVERED',
        renderedBody: 'Bonjour Alice',
      }),
    ]);
    expect(result.marketingAutomationDispatches).toEqual([
      expect.objectContaining({
        id: 'dispatch-1',
        triggerKey: 'first-honored:reservation-1',
        status: 'QUEUED',
      }),
    ]);
    expect(result.crmMergeAudits).toEqual([
      expect.objectContaining({
        id: 'merge-audit-1',
        targetCustomerId: 'customer-1',
        sourceCustomerIds: ['customer-2'],
      }),
    ]);
  });

  it('exporte les réservations d expériences rattachées au sujet', async () => {
    const experienceReservations = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'experience-reservation-1',
          restaurantId: 'rest-1',
          experienceId: 'experience-1',
          sessionId: 'session-1',
          quantity: 2,
          unitPriceCents: 4500,
          totalPriceCents: 9000,
          currency: 'EUR',
          status: 'CONFIRMED',
          createdAt: new Date('2026-09-14T10:00:00Z'),
          session: {
            startsAt: new Date('2026-09-20T18:00:00Z'),
            endsAt: new Date('2026-09-20T19:30:00Z'),
          },
        },
      ]),
    };
    const experiencePrisma = {
      reservation: { findMany: vi.fn().mockResolvedValue([]) },
      customerConsent: { findMany: vi.fn().mockResolvedValue([]) },
      experienceReservation: experienceReservations,
    };

    const result = await new ExportService(
      experiencePrisma as unknown as PrismaClient,
    ).exportSubject({
      subject: '+33601020304',
    });

    expect(result.experienceReservations).toMatchObject([
      {
        id: 'experience-reservation-1',
        quantity: 2,
        totalPriceCents: 9000,
        startsAt: '2026-09-20T18:00:00.000Z',
      },
    ]);
    expect(experienceReservations.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ OR: expect.any(Array) }) }),
    );
  });

  it('exporte les commandes événement et la liste d attente du profil CRM', async () => {
    const eventOrder = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'event-order-1',
          restaurantId: 'rest-1',
          eventId: 'event-1',
          sessionId: 'session-1',
          ticketTypeId: 'ticket-type-1',
          customerId: 'customer-1',
          reservationId: null,
          quantity: 2,
          unitPriceCents: 2500,
          totalPriceCents: 5000,
          currency: 'EUR',
          status: 'CONFIRMED',
          invoiceNumber: 'SOKAR-EVT-1',
          invoicedAt: new Date('2026-09-14T11:00:00Z'),
          refundedAt: null,
          cancelledAt: null,
          createdAt: new Date('2026-09-14T10:00:00Z'),
        },
      ]),
    };
    const eventWaitlistEntry = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'event-wait-1',
          restaurantId: 'rest-1',
          eventId: 'event-1',
          sessionId: 'session-1',
          customerId: 'customer-1',
          quantity: 1,
          status: 'WAITING',
          promotedAt: null,
          createdAt: new Date('2026-09-14T10:00:00Z'),
        },
      ]),
    };
    const eventPrisma = {
      reservation: { findMany: vi.fn().mockResolvedValue([]) },
      customerConsent: { findMany: vi.fn().mockResolvedValue([]) },
      customer: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'customer-1',
            restaurantId: 'rest-1',
            phone: '+33601020304',
            emailNormalized: null,
            birthMonth: null,
            birthDay: null,
            preferredLocale: 'fr-FR',
            identities: [],
            preferences: [],
            tagAssignments: [],
            createdAt: new Date('2026-01-01'),
          },
        ]),
      },
      eventOrder,
      eventWaitlistEntry,
    };

    const result = await new ExportService(eventPrisma as unknown as PrismaClient).exportSubject({
      subject: '+33601020304',
    });

    expect(result.eventOrders).toMatchObject([
      { id: 'event-order-1', quantity: 2, invoiceNumber: 'SOKAR-EVT-1' },
    ]);
    expect(result.eventWaitlistEntries).toMatchObject([
      { id: 'event-wait-1', status: 'WAITING', quantity: 1 },
    ]);
  });
});
