/**
 * Tests d'intégration des routes admin agentic-reservations.
 *
 * Utilise buildApp() avec un mock Prisma pour exercer les routes
 * sans toucher la DB. Vérifie le contrat HTTP (status codes, payloads).
 */

import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { getApp, closeApp } from '../../../test/helpers';

const AUTH = { authorization: 'Bearer fake-token' };

describe('agentic admin routes', () => {
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('GET /api/agentic/opt-in', () => {
    it('retourne 401 sans auth', async () => {
      const app = await getApp();
      const res = await app.inject({ method: 'GET', url: '/api/agentic/opt-in' });
      expect(res.statusCode).toBe(401);
    });

    it('retourne les flags par défaut', async () => {
      const { db } = await import('../../../shared/db/client');
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce({
        agenticOptIn: false,
        openaiReserveEnabled: false,
        policyVersion: '2026-06-20',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agentic/opt-in',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.mcp).toBe(false);
      expect(body.openaiReserve).toBe(false);
    });
  });

  describe('POST /api/agentic/opt-in', () => {
    it('refuse 401 sans auth', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agentic/opt-in',
        payload: { mcp: true, openaiReserve: false },
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuse 400 si payload invalide', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agentic/opt-in',
        headers: AUTH,
        payload: { mcp: 'not-a-bool' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuse 409 si OpenAI Reserve activé sans champs requis', async () => {
      const { db } = await import('../../../shared/db/client');
      vi.mocked(db.restaurant.findUniqueOrThrow).mockResolvedValueOnce({
        agenticOptIn: false,
        openaiReserveEnabled: false,
        lat: null,
        lng: 4.85,
        websiteUrl: 'https://example.com',
        formattedAddress: '1 rue de la Paix',
        phoneE164: '+336****0000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUniqueOrThrow>>);
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agentic/opt-in',
        headers: AUTH,
        payload: { mcp: true, openaiReserve: true },
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.code).toBe('OPENAI_RESERVE_MISSING_FIELDS');
    });
  });

  describe('GET /api/agentic/exposure-settings', () => {
    it('retourne 401 sans auth', async () => {
      const app = await getApp();
      const res = await app.inject({ method: 'GET', url: '/api/agentic/exposure-settings' });
      expect(res.statusCode).toBe(401);
    });

    it('retourne les défauts si pas de settings', async () => {
      const { db } = await import('../../../shared/db/client');
      vi.mocked(db.restaurantExposureSettings.findUnique).mockResolvedValueOnce(null);
      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agentic/exposure-settings',
        headers: AUTH,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.maxPartySize).toBe(7);
    });
  });

  describe('PUT /api/agentic/exposure-settings', () => {
    it('refuse 401 sans auth', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/agentic/exposure-settings',
        payload: { maxPartySize: 8 },
      });
      expect(res.statusCode).toBe(401);
    });

    it('refuse 400 sur payload invalide (maxPartySize=0)', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/agentic/exposure-settings',
        headers: AUTH,
        payload: { maxPartySize: 0 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('refuse 400 sur holdTtlSeconds <= quoteTtlSeconds (validation Zod)', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'PUT',
        url: '/api/agentic/exposure-settings',
        headers: AUTH,
        payload: { quoteTtlSeconds: 300, holdTtlSeconds: 300 },
      });
      // La validation est dans le schema Zod (refine), pas dans le service.
      // 400 est le code correct pour un payload invalide.
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/agentic/mcp-clients', () => {
    it('retourne les clients actifs', async () => {
      const { db } = await import('../../../shared/db/client');
      vi.mocked(db.agentClient.findMany).mockResolvedValueOnce([
        {
          id: 'client-1',
          name: 'Claude Desktop',
          keyPrefix: 'sk_sokar_agent_abcd1234',
          scopes: ['mcp:read', 'mcp:reserve'],
          allowedOrigins: ['https://claude.ai'],
          lastUsedAt: null,
          createdAt: new Date('2026-06-23T10:00:00Z'),
        } as unknown as Awaited<ReturnType<typeof db.agentClient.findMany>>[number],
      ]);

      const app = await getApp();
      const res = await app.inject({
        method: 'GET',
        url: '/api/agentic/mcp-clients',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.clients).toHaveLength(1);
      expect(body.clients[0].keyPrefix).toBe('sk_sokar_agent_abcd1234');
    });
  });

  describe('POST /api/agentic/mcp-clients', () => {
    it('crée une clé et retourne le secret one-shot', async () => {
      const { db } = await import('../../../shared/db/client');
      (
        vi.mocked(db.$transaction) as unknown as Mock<(...args: unknown[]) => unknown>
      ).mockImplementationOnce(async (...args: unknown[]) => {
        const fn = args[0];
        return (fn as unknown as (tx: PrismaClient) => Promise<unknown>)({
          agentClient: {
            create: vi.fn().mockResolvedValueOnce({
              id: 'client-1',
              name: 'Claude Desktop',
              keyPrefix: 'sk_sokar_agent_abcd1234',
              scopes: ['mcp:read', 'mcp:reserve'],
              allowedOrigins: ['https://claude.ai'],
              lastUsedAt: null,
              createdAt: new Date('2026-06-23T10:00:00Z'),
            } as unknown as Awaited<ReturnType<typeof db.agentClient.create>>),
          },
          reservationAuditLog: { create: vi.fn() },
        } as unknown as PrismaClient);
      });

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agentic/mcp-clients',
        headers: AUTH,
        payload: {
          name: 'Claude Desktop',
          scopes: ['mcp:read', 'mcp:reserve'],
          allowedOrigins: ['https://claude.ai'],
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.client.id).toBe('client-1');
      expect(body.apiKey).toMatch(/^sk_suppernote_agent_/);
    });

    it('refuse une origin invalide', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/agentic/mcp-clients',
        headers: AUTH,
        payload: {
          name: 'Bad client',
          scopes: ['mcp:read'],
          allowedOrigins: ['not-an-origin'],
        },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/agentic/mcp-clients/:id', () => {
    it('révoque une clé', async () => {
      const { db } = await import('../../../shared/db/client');
      vi.mocked(db.agentClient.findFirst).mockResolvedValueOnce({
        id: 'client-1',
        keyPrefix: 'sk_sokar_agent_abcd1234',
        scopes: ['mcp:read'],
        allowedOrigins: [],
      } as unknown as Awaited<ReturnType<typeof db.agentClient.findFirst>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/agentic/mcp-clients/client-1',
        headers: AUTH,
      });

      expect(res.statusCode).toBe(204);
    });
  });
});
