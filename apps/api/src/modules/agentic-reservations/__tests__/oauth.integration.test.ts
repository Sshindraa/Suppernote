/**
 * Test d'intégration du flow OAuth 2.0 MCP complet.
 *
 * Simule le flow Claude.ai :
 *   1. Dynamic Client Registration (POST /oauth/register)
 *   2. Authorize (GET → consent page, POST → redirect with code)
 *   3. Token exchange (POST /oauth/token avec form-urlencoded)
 *   4. MCP call avec le token OAuth (POST /mcp)
 *
 * Le test critique : vérifie que les scopes envoyés en form-urlencoded
 * (où les espaces sont encodés avec +) sont correctement parsés en
 * scopes séparés, pas une seule string collée.
 *
 * Bug historique : le parser custom form-urlencoded ne décodait pas
 * + en espace, ce qui donnait scopes=["mcp:read+mcp:reserve+mcp:cancel"]
 * au lieu de scopes=["mcp:read","mcp:reserve","mcp:cancel"].
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { getApp, closeApp } from '../../../test/helpers';
import { redisCache } from '../../../shared/redis/client';
import { db } from '../../../shared/db/client';

const OLD_ACCESS = 'old-access-test';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
const CHATGPT_REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const MCP_RESOURCE = 'http://localhost:4000';
const SCOPES = 'mcp:read mcp:reserve mcp:cancel';
const PKCE_VERIFIER = 'sokar-test-pkce-verifier-with-more-than-43-characters';
const PKCE_CHALLENGE = createHash('sha256').update(PKCE_VERIFIER).digest('base64url');

describe('OAuth MCP integration flow', () => {
  let clientId: string;
  let clientSecret: string;
  let authCode: string;
  let accessToken: string;
  let refreshToken: string;
  let csrfToken: string;

  beforeAll(() => {
    process.env.NODE_ENV = 'development';
    process.env.OAUTH_ISSUER_URL = 'http://localhost:4000';
  });

  afterAll(async () => {
    await closeApp();
  });

  // ── 1. Metadata discovery ────────────────────────────
  it('GET /.well-known/oauth-authorization-server returns metadata', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issuer).toBe('http://localhost:4000');
    expect(body.authorization_response_iss_parameter_supported).toBe(true);
    expect(body.authorization_endpoint).toContain('/oauth/authorize');
    expect(body.token_endpoint).toContain('/oauth/token');
    expect(body.registration_endpoint).toContain('/oauth/register');
    expect(body.code_challenge_methods_supported).toContain('S256');
    expect(body.token_endpoint_auth_methods_supported).toEqual(
      expect.arrayContaining(['client_secret_basic', 'client_secret_post', 'none']),
    );
    expect(body.client_id_metadata_document_supported).toBeUndefined();
  });

  it('GET /.well-known/oauth-protected-resource declares the MCP resource and scopes', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      resource: MCP_RESOURCE,
      authorization_servers: [MCP_RESOURCE],
      scopes_supported: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
    });
    expect(res.json().resource_documentation).toMatch(/\/assistants-ia$/);
  });

  // ── 2. Dynamic Client Registration ───────────────────
  it('POST /oauth/register creates a client', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_name: 'test-claude',
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: 'client_secret_post',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.client_id).toBeDefined();
    expect(body.client_secret).toBeDefined();
    expect(body.redirect_uris).toContain(REDIRECT_URI);
    clientId = body.client_id;
    clientSecret = body.client_secret;
  });

  // ── 3. Authorize (consent page) ──────────────────────
  it('GET /oauth/authorize returns consent HTML', async () => {
    // Mock: at least one restaurant with MCP enabled
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&resource=${encodeURIComponent(MCP_RESOURCE)}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&state=test-state`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Autoriser');
    expect(res.body).toContain('/icon.svg');
    expect(res.body).toContain('<span>Suppernote</span>');
    expect(res.body).toContain('Plus+Jakarta+Sans');
    expect(res.body).toContain("font-family: 'Outfit'");
    expect(res.body).toContain('--suppernote-blue: #0284c7');
    expect(res.body).not.toContain('#f97316');
    expect(res.body).not.toContain('#0369a1');
    expect(res.body).not.toContain('#38bdf8');
    expect(res.body).not.toContain('Restaurant connect'); // no restaurant block

    // Extract CSRF token from the hidden input
    const csrfMatch = res.body.match(/name="csrf_token" value="([^"]+)"/);
    expect(csrfMatch).not.toBeNull();
    csrfToken = csrfMatch![1];
  });

  it('defaults an omitted OAuth scope to mcp:read', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&state=default-scope`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatch(/name="scope" value="mcp:read"/);
  });

  it('rejects a resource that does not match protected-resource metadata', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp%3Aread&state=wrong-resource&resource=${encodeURIComponent('https://other.example/mcp')}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Ressource invalide');
  });

  it('rejects a scope change after consent was rendered', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);
    const app = await getApp();
    const get = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp%3Aread&state=read-only&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });
    const csrf = get.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(csrf).toBeDefined();
    const post = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=approve&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=read-only&scope=${encodeURIComponent(SCOPES)}&csrf_token=${csrf}`,
    });
    expect(post.statusCode).toBe(403);
  });

  // ── 4. Authorize (process consent → redirect with code) ──
  it('POST /oauth/authorize (form-urlencoded) redirects with code', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=approve&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=test-state&scope=${encodeURIComponent(SCOPES)}&csrf_token=${csrfToken}`,
    });

    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    expect(location).toContain(REDIRECT_URI);
    expect(location).toContain('code=');
    expect(location).toContain('state=test-state');
    expect(new URL(location).searchParams.get('iss')).toBe(MCP_RESOURCE);

    // Extract the code
    const url = new URL(location);
    authCode = url.searchParams.get('code')!;
    expect(authCode).toBeDefined();
  });

  // ── 5. Token exchange (THE CRITICAL TEST) ─────────────
  it('POST /oauth/token (form-urlencoded) exchanges code for token with correct scopes', async () => {
    const app = await getApp();
    const missingRedirect = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${authCode}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}`,
    });
    expect(missingRedirect.statusCode).toBe(400);

    const missingResource = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${authCode}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}`,
    });
    expect(missingResource.statusCode).toBe(400);
    expect(missingResource.json().error).toBe('invalid_target');

    const wrongResource = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${authCode}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}&resource=${encodeURIComponent('https://other.example/mcp')}`,
    });
    expect(wrongResource.statusCode).toBe(400);
    expect(wrongResource.json().error).toBe('invalid_target');

    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${authCode}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}&resource=${encodeURIComponent(MCP_RESOURCE)}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeDefined();
    expect(body.token_type).toBe('Bearer');
    expect(body.refresh_token).toBeDefined();
    accessToken = body.access_token;
    refreshToken = body.refresh_token;

    // CRITICAL: scopes must be space-separated, not + separated
    const returnedScopes = body.scope.split(' ');
    expect(returnedScopes).toContain('mcp:read');
    expect(returnedScopes).toContain('mcp:reserve');
    expect(returnedScopes).toContain('mcp:cancel');
    expect(returnedScopes).toHaveLength(3);
    // The bug would have produced ["mcp:read+mcp:reserve+mcp:cancel"] (1 element)
    expect(returnedScopes).not.toContain('mcp:read+mcp:reserve+mcp:cancel');
    const stored = await redisCache.get(`sokar:oauth:token:${accessToken}`);
    expect(JSON.parse(stored!)).toMatchObject({ resource: MCP_RESOURCE });
  });

  it('a single authorization code cannot be exchanged twice concurrently', async () => {
    const app = await getApp();
    const code = 'concurrent-test-code';
    await redisCache.set(
      `sokar:oauth:code:${code}`,
      JSON.stringify({
        clientId,
        restaurantId: null,
        restaurantName: null,
        scopes: ['mcp:read'],
        redirectUri: REDIRECT_URI,
        resource: MCP_RESOURCE,
        codeChallenge: PKCE_CHALLENGE,
        codeChallengeMethod: 'S256',
      }),
      'EX',
      '600',
    );
    const payload = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}&resource=${encodeURIComponent(MCP_RESOURCE)}`;
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: '/oauth/token',
          remoteAddress: '192.0.2.41',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
  });

  it('rotates a refresh token at most once when requests overlap', async () => {
    const app = await getApp();
    const oldRefresh = 'concurrent-refresh-test';
    await redisCache.set(
      `sokar:oauth:refresh:${oldRefresh}`,
      JSON.stringify({
        clientId,
        restaurantId: null,
        restaurantName: null,
        scopes: ['mcp:read'],
        resource: MCP_RESOURCE,
        accessToken: OLD_ACCESS,
        refreshToken: oldRefresh,
      }),
      'EX',
      '600',
    );
    const payload = `grant_type=refresh_token&refresh_token=${oldRefresh}&client_id=${clientId}&client_secret=${clientSecret}&resource=${encodeURIComponent(MCP_RESOURCE)}`;
    const responses = await Promise.all(
      [1, 2].map(() =>
        app.inject({
          method: 'POST',
          url: '/oauth/token',
          remoteAddress: '192.0.2.42',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          payload,
        }),
      ),
    );
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 400]);
  });

  // ── 6. MCP call with OAuth token ──────────────────────
  it('POST /mcp with OAuth token calls tools/list successfully', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.result).toBeDefined();
    expect(body.result.tools).toHaveLength(12);

    // Verify tool annotations are present
    for (const tool of body.result.tools) {
      expect(tool.title).toBeDefined();
      expect(tool.annotations).toBeDefined();
    }
  });

  // ── 7. MCP call with OAuth token can call a read tool ──
  it('POST /mcp with OAuth token can call search_restaurants (mcp:read scope)', async () => {
    vi.mocked(db.restaurant.findMany).mockResolvedValue([]);
    vi.mocked(db.restaurant.count).mockResolvedValue(0);

    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'search_restaurants',
          arguments: {
            city: 'Paris',
            partySize: 2,
            slotStart: '2026-06-24T19:00:00Z',
            slotEnd: '2026-06-24T21:00:00Z',
          },
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Should NOT get a scope error
    expect(body.result?.isError).toBeFalsy();
    expect(body.error).toBeUndefined();
  });

  it('issues a restaurant-scoped token when restaurant_id is requested', async () => {
    const restaurantId = '550e8400-e29b-41d4-a716-446655440001';
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValueOnce({
      restaurantId,
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);
    vi.mocked(db.restaurant.findUnique).mockResolvedValueOnce({
      name: 'Chez Suppernote',
      agenticOptIn: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    const app = await getApp();
    const get = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp%3Aread&state=scoped&restaurant_id=${restaurantId}&resource=${encodeURIComponent(MCP_RESOURCE)}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });
    expect(get.statusCode).toBe(200);
    expect(get.body).toContain('Chez Suppernote');
    const csrf = get.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const post = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=approve&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&state=scoped&scope=mcp%3Aread&csrf_token=${csrf}`,
    });
    expect(post.statusCode).toBe(302);
    const code = new URL(post.headers.location as string).searchParams.get('code');
    const token = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&client_id=${clientId}&client_secret=${clientSecret}&code_verifier=${PKCE_VERIFIER}&resource=${encodeURIComponent(MCP_RESOURCE)}`,
    });
    expect(token.statusCode).toBe(200);
    const stored = await redisCache.get(`sokar:oauth:token:${token.json().access_token}`);
    expect(JSON.parse(stored!)).toMatchObject({
      restaurantId,
      scopes: ['mcp:read'],
      resource: MCP_RESOURCE,
    });

    const accessToken = token.json().access_token as string;
    const toolsList = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: { jsonrpc: '2.0', id: 8, method: 'tools/list' },
    });
    const listedReservationTool = toolsList
      .json()
      .result.tools.find((tool: { name: string }) => tool.name === 'create_reservation');
    expect(listedReservationTool.securitySchemes).toEqual([
      { type: 'oauth2', scopes: ['mcp:reserve'] },
    ]);

    const insufficientScopeCall = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: {
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: { name: 'create_reservation', arguments: {} },
      },
    });
    expect(insufficientScopeCall.json().result._meta['mcp/www_authenticate'][0]).toContain(
      'scope="mcp:reserve"',
    );

    const wrongRefresh = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=refresh_token&refresh_token=${token.json().refresh_token}&client_id=${clientId}&client_secret=${clientSecret}&resource=${encodeURIComponent('https://other.example/mcp')}`,
    });
    expect(wrongRefresh.statusCode).toBe(400);
    expect(wrongRefresh.json().error).toBe('invalid_target');

    const refresh = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=refresh_token&refresh_token=${token.json().refresh_token}&client_id=${clientId}&client_secret=${clientSecret}&resource=${encodeURIComponent(MCP_RESOURCE)}`,
    });
    expect(refresh.statusCode).toBe(200);
    const refreshedAccessToken = refresh.json().access_token as string;
    const refreshed = await redisCache.get(`sokar:oauth:token:${refreshedAccessToken}`);
    expect(JSON.parse(refreshed!)).toMatchObject({ resource: MCP_RESOURCE });

    const wrongAudienceData = JSON.parse(refreshed!) as Record<string, unknown>;
    wrongAudienceData.resource = 'https://other.example/mcp';
    await redisCache.set(
      `sokar:oauth:token:${refreshedAccessToken}`,
      JSON.stringify(wrongAudienceData),
      'EX',
      '3600',
    );
    const wrongAudienceCall = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${refreshedAccessToken}`,
      },
      payload: { jsonrpc: '2.0', id: 10, method: 'tools/list' },
    });
    expect(wrongAudienceCall.statusCode).toBe(401);
  });

  it('includes iss in a denied authorization response', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);
    const app = await getApp();
    const consent = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=mcp%3Aread&state=denied&resource=${encodeURIComponent(MCP_RESOURCE)}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });
    const csrf = consent.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    expect(csrf).toBeDefined();

    const denied = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=deny&csrf_token=${csrf}`,
    });
    expect(denied.statusCode).toBe(302);
    const response = new URL(denied.headers.location as string);
    expect(response.searchParams.get('error')).toBe('access_denied');
    expect(response.searchParams.get('state')).toBe('denied');
    expect(response.searchParams.get('iss')).toBe(MCP_RESOURCE);
  });

  // ── 8. 405 sur GET /mcp (pas de SSE pour StreamableHTTP) ───
  it('GET /mcp without auth returns 405 (no SSE stream)', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: '/mcp',
    });
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toContain('POST');
  });

  // ── 9. Known redirect URI works without DCR ──────────
  it('GET /oauth/authorize accepts Claude.ai callback without DCR client in dev/test', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=nonexistent&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=known-state&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Autoriser');
    expect(res.body).toContain('/icon.svg');
    expect(res.body).toContain('<span>Suppernote</span>');
    expect(res.body).toContain('Plus+Jakarta+Sans');
    expect(res.body).toContain("font-family: 'Outfit'");
    expect(res.body).toContain('--suppernote-blue: #0284c7');
    expect(res.body).not.toContain('#f97316');
    expect(res.body).not.toContain('#0369a1');
    expect(res.body).not.toContain('#38bdf8');
  });

  it('GET /oauth/authorize explains missing state for a known MCP callback', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=nonexistent&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Paramètre state manquant');
    expect(res.body).toContain('Relancez la connexion depuis Claude');
  });

  it('GET /oauth/authorize accepts ChatGPT connector callback without DCR', async () => {
    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=chatgpt-client&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=chatgpt-state&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Autoriser');
    expect(res.body).toContain('ChatGPT');
  });

  // ── 10. Public consent in production (no Clerk required) ──
  it('GET /oauth/authorize shows consent page in production without Clerk login', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const app = await getApp();
    const res = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}&state=production-state&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256`,
    });

    // No redirect to login — consent page shows directly
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Autoriser');

    process.env.NODE_ENV = previousNodeEnv;
  });

  it('rejects unsafe dynamic-registration redirect URIs', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_name: 'unsafe-client',
        redirect_uris: ['javascript:alert(1)'],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_client_metadata');
  });

  it('supports a registered public client with token_endpoint_auth_method=none', async () => {
    const publicRedirectUri = 'https://example.com/oauth/callback';
    const app = await getApp();
    const registration = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_name: 'public-mcp-client',
        redirect_uris: [publicRedirectUri],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
    });
    expect(registration.statusCode).toBe(201);
    expect(registration.json().client_secret).toBeUndefined();
    const publicClientId = registration.json().client_id;

    vi.mocked(db.restaurantExposureSettings.findFirst).mockResolvedValue({
      restaurantId: 'test-resto-1',
      mcpEnabled: true,
    } as unknown as Awaited<ReturnType<typeof db.restaurantExposureSettings.findFirst>>);

    const get = await app.inject({
      method: 'GET',
      url: `/oauth/authorize?response_type=code&client_id=${publicClientId}&redirect_uri=${encodeURIComponent(publicRedirectUri)}&scope=mcp%3Aread&code_challenge=${PKCE_CHALLENGE}&code_challenge_method=S256&state=public-client`,
    });
    expect(get.statusCode).toBe(200);
    const csrf = get.body.match(/name="csrf_token" value="([^"]+)"/)?.[1];
    const post = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `action=approve&csrf_token=${csrf}`,
    });
    expect(post.statusCode).toBe(302);
    const code = new URL(post.headers.location as string).searchParams.get('code');

    const token = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(publicRedirectUri)}&client_id=${publicClientId}&code_verifier=${PKCE_VERIFIER}`,
    });
    expect(token.statusCode).toBe(200);
    expect(token.json().scope).toBe('mcp:read');
  });

  it('rejects refresh-token use by another client', async () => {
    const app = await getApp();
    const res = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `grant_type=refresh_token&refresh_token=${refreshToken}&client_id=another-client`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_grant');
  });

  it('revokes a token only for its authenticated client', async () => {
    const app = await getApp();
    const foreignRevoke = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `client_id=another-client&token=${accessToken}`,
    });
    expect(foreignRevoke.statusCode).toBe(200);

    const stillValid = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(stillValid.statusCode).toBe(200);

    const ownerRevoke = await app.inject({
      method: 'POST',
      url: '/oauth/revoke',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `client_id=${clientId}&client_secret=${clientSecret}&token=${accessToken}`,
    });
    expect(ownerRevoke.statusCode).toBe(200);

    const revoked = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    expect(revoked.statusCode).toBe(401);
  });
});
