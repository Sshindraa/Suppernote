/**
 * Tests d'intégration du Generic Agent REST adapter.
 *
 * Vérifie :
 *   - POST /v1/agents avec tool + arguments
 *   - Auth Bearer (même clés que MCP)
 *   - 401 / 403 / 400
 *   - Response shape { result: ... } ou { error, code }
 *   - Reuse des tools MCP (redaction, validation, gating)
 */

import { createHash } from 'crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import { env } from '../../../env';
import { __resetMetrics, renderMetrics } from '../../../shared/observability/metrics';

const VALID_KEY = ['sk', '_sokar', '_agent_'].join('') + 'test_fixture_' + 'b'.repeat(32);
const AUTH = {
  authorization: `Bearer ${VALID_KEY}`,
  origin: 'https://claude.ai',
};

function callAgent(tool: string, args: Record<string, unknown>) {
  return {
    tool,
    arguments: args,
  };
}

describe('Generic Agent REST adapter', () => {
  beforeAll(() => {
    env.ENABLE_DEV_AUTH = 'true';
    env.AGENT_DEV_KEY = VALID_KEY;
  });

  afterAll(async () => {
    await closeApp();
    env.ENABLE_DEV_AUTH = 'false';
    env.AGENT_DEV_KEY = undefined;
  });

  beforeEach(() => {
    env.ENABLE_DEV_AUTH = 'true';
    env.AGENT_DEV_KEY = VALID_KEY;
    vi.clearAllMocks();
  });

  describe('auth', () => {
    it('retourne 401 sans Authorization', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json' },
        payload: callAgent('search_restaurants', { city: 'Paris' }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('retourne 401 avec une clé invalide', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer invalid-key',
        },
        payload: callAgent('search_restaurants', { city: 'Paris' }),
      });
      expect(res.statusCode).toBe(401);
    });

    it('retourne 403 si Origin non allowlisté', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: {
          'content-type': 'application/json',
          ...AUTH,
          origin: 'https://evil.com',
        },
        payload: callAgent('search_restaurants', { city: 'Paris' }),
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe('validation', () => {
    it('retourne 400 pour un tool inconnu', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('unknown_tool', {}),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toContain('Invalid input');
    });

    it('retourne 400 pour des params invalides', async () => {
      __resetMetrics();
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('search_restaurants', { city: '' }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('INVALID_INPUT');

      const metrics = await renderMetrics();
      expect(metrics).toMatch(
        /suppernote_mcp_tool_calls_by_auth_type_total\{tool="search_restaurants",status="error",auth_type="api_key",transport="generic_agent"\} 1/,
      );
    });
  });

  describe('tools', () => {
    it('get_restaurant_details retourne les infos et redacte le téléphone', async () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';

      vi.mocked(db.restaurant.findFirst).mockResolvedValueOnce({
        timezone: 'Europe/Paris',
        exposureSettings: {
          maxPartySize: 12,
          minLeadTimeMinutes: 0,
          exposedCreneaux: [],
        },
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findFirst>>);
      vi.mocked(db.restaurant.findUnique).mockResolvedValueOnce({
        id: validUuid,
        name: 'Le Bistrot',
        slug: 'le-bistrot',
        formattedAddress: '1 rue de Paris',
        phoneE164: '+33612345678',
        websiteUrl: 'https://example.com',
        cuisineType: ['french'],
        priceRange: 2,
        ambiance: [],
        noiseLevel: null,
        dietary: [],
        openingHours: {},
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('get_restaurant_details', { restaurantId: validUuid }),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result).toBeDefined();
      expect(body.result.name).toBe('Le Bistrot');
      expect(body.result.phoneE164).toBe('[REDACTED]');
      expect(body.result).not.toHaveProperty('holdToken');
    });

    it('masque un restaurant non exposé MCP', async () => {
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';

      vi.mocked(db.restaurant.findFirst).mockResolvedValueOnce(null);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('get_restaurant_details', { restaurantId: validUuid }),
      });
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.code).toBe('NOT_FOUND');
    });

    it('refuse create_reservation avec un client read-only', async () => {
      delete process.env.AGENT_DEV_KEY;

      vi.mocked(db.agentClient.findMany).mockResolvedValueOnce([
        {
          id: 'client-readonly',
          restaurantId: null,
          name: 'Read only',
          scopes: ['mcp:read'],
          allowedOrigins: ['https://claude.ai'],
          revokedAt: null,
          keyHash: createHash('sha256').update(VALID_KEY).digest('hex'),
        },
      ] as unknown as Awaited<ReturnType<typeof db.agentClient.findMany>>);

      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('create_reservation', {
          restaurantId: '550e8400-e29b-41d4-a716-446655440000',
          partySize: 2,
          startsAt: '2026-12-01T19:00:00Z',
          endsAt: '2026-12-01T21:00:00Z',
          customerName: 'Test',
          customerPhone: '+33600000000',
          idempotencyKey: 'k1',
          consents: { reservationProcessing: true },
        }),
      });
      expect(res.statusCode).toBe(403);
      const body = res.json();
      expect(body.code).toBe('FORBIDDEN');
    });

    it('create_reservation exige reservationProcessing=true', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('create_reservation', {
          restaurantId: 'r-1-uuid',
          partySize: 4,
          startsAt: '2026-12-01T19:00:00Z',
          endsAt: '2026-12-01T21:00:00Z',
          customerName: 'Test',
          customerPhone: '+33600000000',
          idempotencyKey: 'k1',
          consents: { reservationProcessing: false },
        }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('INVALID_INPUT');
    });

    it('create_reservation exige customerPhone E.164', async () => {
      const app = await getApp();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'content-type': 'application/json', ...AUTH },
        payload: callAgent('create_reservation', {
          restaurantId: 'r-1-uuid',
          partySize: 4,
          startsAt: '2026-12-01T19:00:00Z',
          endsAt: '2026-12-01T21:00:00Z',
          customerName: 'Test',
          customerPhone: '0600000000',
          idempotencyKey: 'k1',
          consents: { reservationProcessing: true },
        }),
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code).toBe('INVALID_INPUT');
    });
  });
});
