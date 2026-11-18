import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { headers } from 'next/headers';
import Page from './page';

vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
}));

const token = `${'a'.repeat(27)}.${'b'.repeat(43)}`;
const code = 'Ab12Cd34';

function visit(incoming: Record<string, string>) {
  vi.mocked(headers).mockResolvedValue(new Headers(incoming) as never);
  return Page({ params: Promise.resolve({ code }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('lien court de réservation', () => {
  it('transmet l’IP du visiteur à l’API et redirige vers le fragment signé', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ token }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      visit({ 'x-forwarded-for': '203.0.113.7', 'x-request-id': 'req-42' }),
    ).rejects.toThrow(`NEXT_REDIRECT:/r#${token}`);
    expect(fetch.mock.calls[0][1].headers).toEqual({
      'X-Forwarded-For': '203.0.113.7',
      'X-Request-Id': 'req-42',
    });
  });

  it('affiche un message d’attente sur 429 au lieu de « lien plus valide »', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 429 })));
    render(await visit({ 'x-forwarded-for': '203.0.113.7' }));
    expect(
      screen.getByRole('heading', {
        name: 'Trop de tentatives, veuillez réessayer dans une minute.',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/plus valide/)).not.toBeInTheDocument();
  });

  it('affiche « lien plus valide » sur 404', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    render(await visit({}));
    expect(screen.getByRole('heading', { name: /Ce lien n’est plus valide/ })).toBeInTheDocument();
  });
});
