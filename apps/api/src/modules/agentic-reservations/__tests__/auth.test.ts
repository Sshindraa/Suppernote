import { createHash } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import {
  ALLOWED_ORIGINS,
  McpAuthError,
  getApiKeyPrefix,
  validateApiKeyFormat,
  validateClientOrigin,
  validateDevApiKey,
  validateApiKey,
  validateOrigin,
} from '../mcp/auth.js';
import { env } from '../../../env';
import { hashApiKey, verifyApiKeyHashAsync } from '../../../shared/crypto/api-key-hash';

describe('mcp auth', () => {
  const PREFIX = ['sk', '_sokar', '_agent_'].join('');
  const VALID_KEY = PREFIX + 'test_fixture_' + 'b'.repeat(32);

  beforeEach(() => {
    env.ENABLE_DEV_AUTH = 'false';
    env.AGENT_DEV_KEY = undefined;
  });

  describe('validateDevApiKey', () => {
    it('accepte une clé au bon format si ENABLE_DEV_AUTH=true', () => {
      env.ENABLE_DEV_AUTH = 'true';
      env.AGENT_DEV_KEY = VALID_KEY;
      const ctx = validateDevApiKey(env.AGENT_DEV_KEY);
      expect(ctx).toEqual({
        clientId: 'dev-client',
        clientName: 'dev',
        restaurantId: null,
        scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        allowedOrigins: [],
        credentialType: 'api_key',
      });
    });

    it('rejette une clé sans préfixe sk_sokar_agent_', () => {
      expect(validateDevApiKey('plain-key')).toBeNull();
    });

    it('rejette une clé trop courte', () => {
      expect(validateDevApiKey(PREFIX)).toBeNull();
    });

    it('rejette si ENABLE_DEV_AUTH=false', () => {
      env.AGENT_DEV_KEY = VALID_KEY;
      env.ENABLE_DEV_AUTH = 'false';
      const result = validateDevApiKey(env.AGENT_DEV_KEY);
      expect(result).toBeNull();
    });
  });

  describe('validateApiKey', () => {
    it('verifies current scrypt hashes asynchronously and rejects incorrect keys', async () => {
      const hash = hashApiKey(VALID_KEY);
      await expect(verifyApiKeyHashAsync(VALID_KEY, hash)).resolves.toBe(true);
      await expect(verifyApiKeyHashAsync(`${VALID_KEY}x`, hash)).resolves.toBe(false);
    });
    it('valide un client DB actif', async () => {
      const prisma = {
        agentClient: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: 'client-1',
              restaurantId: 'rest-1',
              name: 'Claude',
              scopes: ['mcp:read'],
              allowedOrigins: ['https://claude.ai'],
              revokedAt: null,
              keyHash: createHash('sha256').update(VALID_KEY).digest('hex'),
            },
          ]),
          update: vi.fn().mockResolvedValue({}),
        },
      } as unknown as PrismaClient;

      const ctx = await validateApiKey(VALID_KEY, prisma);

      expect(prisma.agentClient.findMany).toHaveBeenCalledWith({
        where: { keyPrefix: getApiKeyPrefix(VALID_KEY), revokedAt: null },
        select: {
          id: true,
          restaurantId: true,
          name: true,
          scopes: true,
          allowedOrigins: true,
          keyHash: true,
        },
      });
      expect(ctx).toEqual({
        clientId: 'client-1',
        clientName: 'Claude',
        restaurantId: 'rest-1',
        scopes: ['mcp:read'],
        allowedOrigins: ['https://claude.ai'],
        credentialType: 'api_key',
      });
    });

    it('rejette un client révoqué', async () => {
      const prisma = {
        agentClient: {
          findMany: vi.fn().mockResolvedValue([]),
          update: vi.fn(),
        },
      } as unknown as PrismaClient;

      await expect(validateApiKey(VALID_KEY, prisma)).resolves.toBeNull();
      expect(prisma.agentClient.update).not.toHaveBeenCalled();
    });
  });

  describe('validateApiKeyFormat', () => {
    it('valide le préfixe et la longueur minimale', () => {
      expect(validateApiKeyFormat(VALID_KEY)).toBe(true);
      expect(validateApiKeyFormat(PREFIX)).toBe(false);
      expect(validateApiKeyFormat('plain-key')).toBe(false);
    });

    it('accepte le nouveau préfixe Suppernote et garde l’ancien valable', () => {
      const NEW_PREFIX = ['sk', '_suppernote', '_agent_'].join('');
      const newKey = NEW_PREFIX + 'test_fixture_' + 'c'.repeat(32);
      expect(validateApiKeyFormat(newKey)).toBe(true);
      expect(getApiKeyPrefix(newKey)).toBe(newKey.slice(0, NEW_PREFIX.length + 8));
      expect(getApiKeyPrefix(VALID_KEY)).toBe(VALID_KEY.slice(0, PREFIX.length + 8));
    });
  });

  describe('validateOrigin', () => {
    it('accepte claude.ai', () => {
      expect(validateOrigin('https://claude.ai')).toBe(true);
    });
    it('accepte cursor.sh', () => {
      expect(validateOrigin('https://cursor.sh')).toBe(true);
    });
    it('accepte localhost en dev', () => {
      expect(validateOrigin('http://localhost:3000')).toBe(true);
    });
    it('rejette un origin inconnu', () => {
      expect(validateOrigin('https://evil.com')).toBe(false);
    });
    it('accepte si absent (requête non-browser)', () => {
      expect(validateOrigin(undefined)).toBe(true);
    });
  });

  describe('validateClientOrigin', () => {
    it('accepte tous les origins si la liste client est vide', () => {
      expect(validateClientOrigin('https://claude.ai', [])).toBe(true);
    });

    it('applique la liste client si elle existe', () => {
      expect(validateClientOrigin('https://claude.ai', ['https://claude.ai'])).toBe(true);
      expect(validateClientOrigin('https://cursor.sh', ['https://claude.ai'])).toBe(false);
    });
  });

  describe('ALLOWED_ORIGINS', () => {
    it('contient au moins claude.ai et cursor.sh', () => {
      expect(ALLOWED_ORIGINS.has('https://claude.ai')).toBe(true);
      expect(ALLOWED_ORIGINS.has('https://cursor.sh')).toBe(true);
    });
  });

  describe('McpAuthError', () => {
    it('expose statusCode et code', () => {
      const err = new McpAuthError('Forbidden', 403, 'X');
      expect(err.message).toBe('Forbidden');
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe('X');
      expect(err.name).toBe('McpAuthError');
    });
  });
});
