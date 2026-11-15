/**
 * Tests for the RGPD erasure service (Article 17 — droit à l'effacement).
 *
 * Stratégie Phase 5 MVP : on anonymise au lieu de supprimer (préserve
 * stats et obligations comptables). Champs anonymisés :
 *   - reservation.customerName → "ANON"
 *   - reservation.customerPhone → null
 *   - reservation.customerId → null
 *   - reservation.specialRequests → null
 *   - message.customerPhone → null (best-effort)
 *   - call.callerPhone → null (best-effort)
 *
 * Les customer_consents sont conservés (preuve légale).
 * Un audit log 'rgpd_erasure' est créé (preuve légale + observabilité).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ErasureService, ErasureSubjectNotFoundError } from '../erasure.service';

// L'erasure service importe trackRgpdEvent (depuis analytics/events.service)
// et AuditLogService (depuis agentic-reservations/core/audit-log.service).
// Ces deux dépendances utilisent des mocks globaux de setup.ts :
//   - queues.analytics.add (mocké en no-op)
//   - reservationAuditLog.create (mocké en no-op)
// Donc on n'a rien d'autre à mocker ici.

function makePrisma() {
  return {
    reservation: {
      findFirst: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    customerConsent: {
      findFirst: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    message: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $queryRaw: vi.fn(),
    voiceDebugTurn: { deleteMany: vi.fn() },
    call: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'call-1',
          recordingStatus: 'NOT_REQUESTED',
          recordingStorageKey: null,
          recordingProviderId: null,
        },
      ]),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    reservationAuditLog: {
      create: vi.fn().mockResolvedValue({}),
    },
    $transaction: vi.fn(),
  } as unknown as PrismaClient;
}

describe('ErasureService.eraseSubject', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let service: ErasureService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    service = new ErasureService(prisma);
  });

  it('lève ErasureSubjectNotFoundError si aucune résa et aucun consent', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(
      service.eraseSubject({
        subject: '+336****0000',
        reason: 'Article 17',
        actor: 'user:self-service',
      }),
    ).rejects.toBeInstanceOf(ErasureSubjectNotFoundError);
  });

  it('anonymise les résas via une transaction (atomicité)', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'res-1',
    });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    // La transaction prend une fonction callback, on l'exécute avec un tx mock.
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );
    (prisma.reservation.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });

    const result = await service.eraseSubject({
      subject: '+336****1111',
      reason: 'GDPR right to erasure',
      actor: 'admin:hamza',
    });

    expect(prisma.reservation.updateMany).toHaveBeenCalledWith({
      where: { customerPhone: { in: ['+336****1111'] } },
      data: {
        customerName: 'ANON',
        customerPhone: null,
        customerEmail: null,
        customerId: null,
        specialRequests: null,
      },
    });
    expect(result.reservationsAnonymized).toBe(3);
  });

  it('efface aussi les lignes enregistrées au format national « 06… »', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'res-1' });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );
    (prisma.reservation.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });

    await service.eraseSubject({
      subject: '+33612345678',
      reason: 'GDPR right to erasure',
      actor: 'admin:hamza',
    });

    expect(prisma.reservation.findFirst).toHaveBeenCalledWith({
      where: { customerPhone: { in: expect.arrayContaining(['+33612345678', '0612345678']) } },
      select: { id: true },
    });
    expect(prisma.reservation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerPhone: { in: expect.arrayContaining(['+33612345678', '0612345678']) } },
      }),
    );
  });

  it('anonymise les messages d appels (Message a customerPhone/customerName)', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'res-1' });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );
    (prisma.message.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });

    const result = await service.eraseSubject({
      subject: '+336****2222',
      reason: 'r',
      actor: 'a',
    });

    expect(result.callsAnonymized).toBe(2);
  });

  it('anonymise aussi le numéro d’appelant persisté sur Call', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'res-1' });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );
    (prisma.message.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 2 });
    (prisma.call.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 3 });

    const result = await service.eraseSubject({
      subject: '+336****4444',
      reason: 'r',
      actor: 'a',
    });

    expect(prisma.call.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['call-1'] } },
      data: {
        callerPhone: null,
        transcript: null,
        recordingStatus: 'DELETED',
        recordingStorageKey: null,
        recordingProviderId: null,
        recordingError: null,
        recordingContentType: null,
        recordingSizeBytes: null,
      },
    });
    expect(result.callsAnonymized).toBe(5);
  });

  it.each(['message', 'call'] as const)("échoue si l'anonymisation de %s échoue", async (table) => {
    vi.mocked(prisma.reservation.findFirst).mockResolvedValue({ id: 'res-1' } as never);
    vi.mocked(prisma.customerConsent.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: typeof prisma) => unknown)(prisma),
    );
    vi.mocked(prisma[table].updateMany).mockRejectedValue(new Error('database unavailable'));

    await expect(
      service.eraseSubject({ subject: '+336****3333', reason: 'r', actor: 'a' }),
    ).rejects.toThrow('database unavailable');
    expect(prisma.reservationAuditLog.create).not.toHaveBeenCalled();
  });

  it("échoue si la trace d'audit ne peut pas être enregistrée", async () => {
    vi.mocked(prisma.reservation.findFirst).mockResolvedValue({ id: 'res-1' } as never);
    vi.mocked(prisma.customerConsent.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.$transaction).mockImplementation(async (fn) =>
      (fn as (tx: typeof prisma) => unknown)(prisma),
    );
    vi.mocked(prisma.reservationAuditLog.create).mockRejectedValue(new Error('audit unavailable'));

    await expect(
      service.eraseSubject({ subject: '+336****3333', reason: 'r', actor: 'a' }),
    ).rejects.toThrow('audit unavailable');
  });

  it('conserve les consents (preuve légale) et les compte', async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'res-1' });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'c-1' });
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );
    (prisma.customerConsent.count as ReturnType<typeof vi.fn>).mockResolvedValue(4);

    const result = await service.eraseSubject({
      subject: '+336****4444',
      reason: 'r',
      actor: 'a',
    });

    expect(result.consentsRetained).toBe(4);
    expect(prisma.customerConsent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ marketingOptIn: true }),
        data: { marketingOptIn: false },
      }),
    );
  });

  it("retourne le hash du subject (SHA-256 hex 64 chars) et la date d'effacement", async () => {
    (prisma.reservation.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 'res-1' });
    (prisma.customerConsent.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: { reservation: typeof prisma.reservation }) => unknown) => fn(prisma),
    );

    const result = await service.eraseSubject({
      subject: '+336****5555',
      reason: 'r',
      actor: 'a',
    });

    expect(result.subjectHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.subjectHash).toHaveLength(64);
    expect(result.erasedAt).toBeInstanceOf(Date);
  });

  it('efface les projections CRM et marketing rattachées au sujet', async () => {
    const crmPrisma = {
      reservation: {
        findFirst: vi.fn().mockResolvedValue({ id: 'res-1' }),
        updateMany: vi.fn().mockResolvedValue({ count: 2 }),
      },
      customerConsent: {
        findFirst: vi.fn().mockResolvedValue(null),
        count: vi.fn().mockResolvedValue(0),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      customer: {
        findMany: vi.fn().mockResolvedValue([{ id: 'customer-1', phone: '+33601020304' }]),
        update: vi.fn(),
      },
      $queryRaw: vi.fn(),
      customerIdentity: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customerPreference: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      customerTagAssignment: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketingPermission: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      marketingPermissionEvent: { deleteMany: vi.fn().mockResolvedValue({ count: 2 }) },
      marketingSuppression: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      campaignAudienceMember: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      campaignMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketingConversion: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketingFrequencyWindow: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketingAttributionLink: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      marketingAutomationDispatch: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
      experienceReservation: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) },
      waitingListEntry: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      eventOrder: { updateMany: vi.fn().mockResolvedValue({ count: 3 }) },
      eventWaitlistEntry: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      message: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      voiceDebugTurn: { deleteMany: vi.fn() },
      call: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([]),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      reservationAuditLog: { create: vi.fn().mockResolvedValue({}) },
      $transaction: vi.fn(),
    } as unknown as PrismaClient;
    (crmPrisma.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (fn: (tx: typeof crmPrisma) => unknown) => fn(crmPrisma),
    );

    const result = await new ErasureService(crmPrisma).eraseSubject({
      subject: '+33601020304',
      reason: 'Article 17',
      actor: 'admin:hamza',
    });

    expect(result).toMatchObject({
      crmProfilesAnonymized: 1,
      crmIdentitiesRemoved: 1,
      crmPreferencesRemoved: 1,
      crmTagsRemoved: 1,
      marketingPermissionsRemoved: 1,
      marketingPermissionEventsRemoved: 2,
      campaignAudienceMembersRemoved: 1,
      campaignMessagesRemoved: 1,
      marketingConversionsRemoved: 1,
      marketingFrequencyWindowsRemoved: 1,
      marketingAttributionLinksRemoved: 1,
      marketingAutomationDispatchesRemoved: 1,
      experienceReservationsDetached: 2,
      eventOrdersDetached: 3,
      eventWaitlistEntriesDetached: 1,
    });
    expect(crmPrisma.customer.update).toHaveBeenCalledWith({
      where: { id: 'customer-1' },
      data: expect.objectContaining({ name: 'ANON', archivedAt: expect.any(Date) }),
    });
    expect(
      vi.mocked(crmPrisma.experienceReservation.updateMany).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(crmPrisma.reservation.updateMany).mock.invocationCallOrder[0]);
    expect(
      vi.mocked(crmPrisma.experienceReservation.updateMany).mock.invocationCallOrder[0],
    ).toBeLessThan(vi.mocked(crmPrisma.customer.update).mock.invocationCallOrder[0]);
    expect(crmPrisma.experienceReservation.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ OR: expect.any(Array) }),
      data: {
        customerId: null,
        reservationId: null,
        customerName: 'ANON',
        customerEmail: null,
        customerPhone: null,
      },
    });
    expect(crmPrisma.waitingListEntry.updateMany).toHaveBeenCalledWith({
      where: { OR: expect.any(Array) },
      data: expect.objectContaining({
        customerFirstName: 'ANON',
        customerLastName: null,
        customerEmail: null,
        consents: {},
      }),
    });
    expect(crmPrisma.eventOrder.updateMany).toHaveBeenCalledWith({
      where: { customerId: { in: ['customer-1'] } },
      data: { customerId: null },
    });
    expect(crmPrisma.eventWaitlistEntry.updateMany).toHaveBeenCalledWith({
      where: { customerId: { in: ['customer-1'] } },
      data: { customerId: null },
    });
  });
});
