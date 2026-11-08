import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../../shared/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../shared/email')>()),
  sendEmail: vi.fn(),
}));

import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { sendEmail } from '../../../shared/email';

const KEY = '00000000-0000-4000-8000-000000000001';
const OPERATOR_HEADERS = { authorization: 'Bearer test' };

const VALID_BODY = {
  idempotencyKey: KEY,
  establishmentName: 'Le Bistrot du Coin',
  contactEmail: '  Contact@Bistrot.example ',
  contactPhone: '+33 6 12 34 56 78',
  currentTool: 'Cahier',
  mainProblem: 'Trop d’appels pendant le service',
  pageVersion: 'demo-2026-10',
};

function demoRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dr_1',
    status: 'NEW',
    idempotencyKey: KEY,
    establishmentName: 'Le Bistrot du Coin',
    contactEmail: 'contact@bistrot.example',
    notifiedAt: null,
    createdAt: new Date('2026-10-13T10:00:00Z'),
    ...overrides,
  };
}

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: '6.19.3',
    meta: { target: ['idempotency_key'] },
  });
}

describe('demo-request.routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.DEMO_REQUEST_NOTIFY_TO;
  });

  afterAll(async () => {
    await closeApp();
  });

  describe('POST /public/demo-requests', () => {
    it('enregistre la demande normalisée, sans compte, et répond 201', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockResolvedValue(demoRequest() as never);

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ data: { id: 'dr_1', status: 'NEW', replayed: false } });
      expect(db.demoRequest.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          idempotencyKey: KEY,
          establishmentName: 'Le Bistrot du Coin',
          contactEmail: 'contact@bistrot.example',
          contactPhone: '+33 6 12 34 56 78',
          currentTool: 'Cahier',
          pageVersion: 'demo-2026-10',
        }),
      });
    });

    it('répond 200 sans créer de doublon quand la clé d’idempotence est déjà connue', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockRejectedValue(uniqueViolation());
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(demoRequest() as never);

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ data: { id: 'dr_1', status: 'NEW', replayed: true } });
      expect(sendEmail).not.toHaveBeenCalled();
    });

    it('rejette une adresse e-mail invalide sans toucher à la base et ne cite que le champ fautif', async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: { ...VALID_BODY, contactEmail: 'pas-une-adresse' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'VALIDATION_ERROR', fields: ['contactEmail'] });
      expect(db.demoRequest.create).not.toHaveBeenCalled();
    });

    it('accepte sans persister une soumission qui remplit le champ piège', async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: { ...VALID_BODY, website: 'https://spam.example' },
      });

      expect(res.statusCode).toBe(202);
      expect(db.demoRequest.create).not.toHaveBeenCalled();
    });

    it('répond par une erreur réessayable quand la base est indisponible', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockRejectedValue(new Error('connection refused'));

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: 'DEMO_REQUEST_UNAVAILABLE' });
    });

    it('notifie chaque destinataire configuré et marque la notification comme envoyée', async () => {
      process.env.DEMO_REQUEST_NOTIFY_TO = 'ops@sokar.test, sales@sokar.test';
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockResolvedValue(demoRequest() as never);
      vi.mocked(sendEmail).mockResolvedValue({
        outcome: 'success',
        provider: 'resend',
        channel: 'email',
      } as never);
      vi.mocked(db.demoRequest.update).mockResolvedValue(demoRequest() as never);

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(201);
      expect(sendEmail).toHaveBeenCalledTimes(2);
      expect(vi.mocked(sendEmail).mock.calls.map(([opts]) => opts.to)).toEqual([
        'ops@sokar.test',
        'sales@sokar.test',
      ]);
      expect(db.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr_1' },
        data: { notifiedAt: expect.any(Date) },
      });
    });

    it("ne marque pas la notification quand l'envoi est refusé, et garde la demande", async () => {
      process.env.DEMO_REQUEST_NOTIFY_TO = 'ops@sokar.test';
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockResolvedValue(demoRequest() as never);
      vi.mocked(sendEmail).mockResolvedValue({
        outcome: 'failure_certain',
        provider: 'resend',
        channel: 'email',
      } as never);

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(201);
      expect(db.demoRequest.create).toHaveBeenCalledTimes(1);
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it("garde la demande même si l'envoi de notification échoue, sans marquer l'envoi", async () => {
      process.env.DEMO_REQUEST_NOTIFY_TO = 'ops@sokar.test';
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockResolvedValue(demoRequest() as never);
      vi.mocked(sendEmail).mockRejectedValue(new Error('provider down'));

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(201);
      expect(db.demoRequest.create).toHaveBeenCalledTimes(1);
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it("n'envoie rien quand aucun destinataire n'est configuré", async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.create).mockResolvedValue(demoRequest() as never);

      const res = await app.inject({
        method: 'POST',
        url: '/public/demo-requests',
        payload: VALID_BODY,
      });

      expect(res.statusCode).toBe(201);
      expect(sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('suivi opérateur', () => {
    it('refuse la liste à un visiteur non authentifié', async () => {
      const app = await getApp();

      const res = await app.inject({ method: 'GET', url: '/admin/demo-requests' });

      expect(res.statusCode).toBe(401);
      expect(db.demoRequest.findMany).not.toHaveBeenCalled();
    });

    it("refuse la liste à un utilisateur qui n'est pas opérateur Suppernote", async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'GET',
        url: '/admin/demo-requests',
        headers: { ...OPERATOR_HEADERS, 'x-test-not-operator': '1' },
      });

      expect(res.statusCode).toBe(403);
      expect(db.demoRequest.findMany).not.toHaveBeenCalled();
    });

    it('expose uniquement des compteurs opérateur sans les coordonnées des demandes', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.groupBy).mockResolvedValue([
        { status: 'NEW', _count: { _all: 2 } },
        { status: 'CONTACTED', _count: { _all: 1 } },
      ] as never);
      vi.mocked(db.demoRequest.count).mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/admin/demo-requests/summary',
        headers: OPERATOR_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        total: 3,
        byStatus: { NEW: 2, CONTACTED: 1, DEMO_DONE: 0, CLOSED: 0 },
        notificationUnconfirmed: 1,
      });
      expect(JSON.stringify(res.json())).not.toContain('contactEmail');
      expect(db.demoRequest.groupBy).toHaveBeenCalledWith({
        by: ['status'],
        _count: { _all: true },
      });
      expect(db.demoRequest.count).toHaveBeenCalledWith({ where: { notifiedAt: null } });
    });

    it('réserve le résumé des demandes aux opérateurs', async () => {
      const app = await getApp();

      const unauthorized = await app.inject({ method: 'GET', url: '/admin/demo-requests/summary' });
      const forbidden = await app.inject({
        method: 'GET',
        url: '/admin/demo-requests/summary',
        headers: { ...OPERATOR_HEADERS, 'x-test-not-operator': '1' },
      });

      expect(unauthorized.statusCode).toBe(401);
      expect(forbidden.statusCode).toBe(403);
      expect(db.demoRequest.groupBy).not.toHaveBeenCalled();
      expect(db.demoRequest.count).not.toHaveBeenCalled();
    });

    it('liste les demandes les plus récentes, filtrables par statut', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findMany).mockResolvedValue([demoRequest()] as never);

      const res = await app.inject({
        method: 'GET',
        url: '/admin/demo-requests?status=NEW&limit=20',
        headers: OPERATOR_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data).toHaveLength(1);
      expect(db.demoRequest.findMany).toHaveBeenCalledWith({
        where: { status: 'NEW' },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('filtre les demandes actives et les tests avant la limite', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findMany).mockResolvedValue([]);
      const res = await app.inject({
        method: 'GET',
        url: '/admin/demo-requests?active=true&isTest=false&limit=20',
        headers: OPERATOR_HEADERS,
      });
      expect(res.statusCode).toBe(200);
      expect(db.demoRequest.findMany).toHaveBeenCalledWith({
        where: { status: { in: ['NEW', 'CONTACTED'] }, isTest: false },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
    });

    it('réserve le marquage test aux opérateurs et accepte uniquement un booléen', async () => {
      const app = await getApp();
      const forbidden = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/dr_1/test',
        payload: { isTest: true },
      });
      expect(forbidden.statusCode).toBe(401);
      const invalid = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/dr_1/test',
        headers: OPERATOR_HEADERS,
        payload: { isTest: 'true' },
      });
      expect(invalid.statusCode).toBe(400);
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(demoRequest() as never);
      vi.mocked(db.demoRequest.update).mockResolvedValue(demoRequest({ isTest: true }) as never);
      const ok = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/dr_1/test',
        headers: OPERATOR_HEADERS,
        payload: { isTest: true },
      });
      expect(ok.statusCode).toBe(200);
      expect(db.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr_1' },
        data: { isTest: true },
      });
    });

    it('horodate le premier passage à CONTACTED et refuse un statut inconnu', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(demoRequest() as never);
      vi.mocked(db.demoRequest.update).mockResolvedValue(
        demoRequest({ status: 'CONTACTED' }) as never,
      );

      const ok = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/dr_1',
        headers: OPERATOR_HEADERS,
        payload: { status: 'CONTACTED' },
      });
      expect(ok.statusCode).toBe(200);
      expect(db.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr_1' },
        data: { status: 'CONTACTED', contactedAt: expect.any(Date) },
      });

      const invalid = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/dr_1',
        headers: OPERATOR_HEADERS,
        payload: { status: 'GAGNE' },
      });
      expect(invalid.statusCode).toBe(400);
    });

    it('répond 404 quand la demande n’existe pas', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'PATCH',
        url: '/admin/demo-requests/absent',
        headers: OPERATOR_HEADERS,
        payload: { status: 'CLOSED' },
      });

      expect(res.statusCode).toBe(404);
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it('enregistre la date réelle du dernier échange pour un opérateur', async () => {
      const app = await getApp();
      const occurredAt = new Date('2026-10-14T09:00:00.000Z');
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(demoRequest() as never);
      vi.mocked(db.demoRequest.update).mockResolvedValue(
        demoRequest({ lastInteractionAt: occurredAt }) as never,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/dr_1/interaction',
        headers: OPERATOR_HEADERS,
        payload: { occurredAt: occurredAt.toISOString() },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().data.lastInteractionAt).toBe(occurredAt.toISOString());
      expect(db.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr_1' },
        data: { lastInteractionAt: occurredAt },
      });
    });

    it('refuse de dater un échange dans le futur sans toucher à la base', async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/dr_1/interaction',
        headers: OPERATOR_HEADERS,
        payload: { occurredAt: '2999-01-01T00:00:00.000Z' },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'VALIDATION_ERROR' });
      expect(db.demoRequest.findUnique).not.toHaveBeenCalled();
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it('réserve aussi l’enregistrement du dernier échange aux opérateurs', async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/dr_1/interaction',
      });

      expect(res.statusCode).toBe(401);
      expect(db.demoRequest.findUnique).not.toHaveBeenCalled();
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it('refuse l’enregistrement à un compte authentifié qui n’est pas opérateur', async () => {
      const app = await getApp();

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/dr_1/interaction',
        headers: { ...OPERATOR_HEADERS, 'x-test-not-operator': '1' },
      });

      expect(res.statusCode).toBe(403);
      expect(db.demoRequest.findUnique).not.toHaveBeenCalled();
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });

    it('utilise l’heure serveur quand aucun horodatage n’est fourni', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(demoRequest() as never);
      vi.mocked(db.demoRequest.update).mockResolvedValue(
        demoRequest({ lastInteractionAt: new Date() }) as never,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/dr_1/interaction',
        headers: OPERATOR_HEADERS,
      });

      expect(res.statusCode).toBe(200);
      expect(db.demoRequest.update).toHaveBeenCalledWith({
        where: { id: 'dr_1' },
        data: { lastInteractionAt: expect.any(Date) },
      });
    });

    it('répond 404 si la demande à mettre à jour n’existe plus', async () => {
      const app = await getApp();
      vi.mocked(db.demoRequest.findUnique).mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST',
        url: '/admin/demo-requests/absent/interaction',
        headers: OPERATOR_HEADERS,
      });

      expect(res.statusCode).toBe(404);
      expect(db.demoRequest.update).not.toHaveBeenCalled();
    });
  });
});
