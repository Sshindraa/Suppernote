import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { readFileSync } from 'node:fs';
import { POST } from './route';

function request(body: string) {
  return new Request('http://localhost/api/reservation-management', {
    method: 'POST',
    body,
    headers: { cookie: 'session=private', authorization: 'Bearer private' },
  }) as NextRequest;
}

afterEach(() => vi.unstubAllGlobals());

describe('reservation management proxy', () => {
  it('forwards the requested modification date and rejects malformed dates', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ slots: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const body = {
      token: 'fixture',
      action: 'modification_options',
      partySize: 3,
      date: '2026-10-22',
    };
    expect((await POST(request(JSON.stringify(body)))).status).toBe(200);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(body);
    expect((await POST(request(JSON.stringify({ ...body, date: 123 })))).status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['null', '{', '{}', JSON.stringify({ token: 'x', action: 'cancel' })])(
    'rejects invalid input without an upstream request: %s',
    async (body) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      expect((await POST(request(body))).status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('forwards only the management action, without session credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ state: 'CONFIRMED' }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { token: 'fixture', action: 'view' };
    const response = await POST(request(JSON.stringify(body)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/reservation-management'),
      expect.objectContaining({
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        redirect: 'error',
      }),
    );
  });

  it('forwards confirmed modifications and bounded availability searches without identity', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ state: 'CONFIRMED' }));
    vi.stubGlobal('fetch', fetchMock);
    for (const body of [
      { token: 'fixture', action: 'modification_options', partySize: 3 },
      { token: 'fixture', action: 'modify', confirmed: true, proposalToken: 'offer' },
    ]) {
      expect(
        (await POST(request(JSON.stringify({ ...body, customerName: 'discarded' })))).status,
      ).toBe(200);
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.any(String),
        expect.objectContaining({ body: JSON.stringify(body) }),
      );
    }
    expect(
      (
        await POST(
          request(JSON.stringify({ token: 'fixture', action: 'modify', proposalToken: 'offer' })),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await POST(
          request(
            JSON.stringify({ token: 'fixture', action: 'modification_options', partySize: 51 }),
          ),
        )
      ).status,
    ).toBe(400);
  });
  it('does not expose upstream errors or the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('private credential')));
    const response = await POST(request(JSON.stringify({ token: 'fixture', action: 'view' })));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('private credential');
  });

  it.each(['suppernote-staging'])('keeps %s personal routes on the dashboard', (name) => {
    const config = readFileSync(`../../infra/nginx/${name}.conf`, 'utf8');
    for (const path of ['/r', '/api/reservation-management']) {
      const block = config.split(`location = ${path} {`)[1]?.split('}')[0];
      expect(block).toMatch(/proxy_pass http:\/\/sokar(?:_staging)?_dashboard;/);
      expect(block).not.toContain('proxy_cache');
    }
  });
});
