import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SiteProvider, useSiteSelection } from './site-context';

afterEach(() => vi.unstubAllGlobals());

it('annule le chargement du site précédent et ignore sa réponse après changement d’organisation', async () => {
  const pending: { signal: AbortSignal; resolve: (response: Response) => void }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((resolve) => {
          pending.push({ signal: options.signal as AbortSignal, resolve });
        }),
    ),
  );
  function Probe() {
    const { activeSiteId } = useSiteSelection();
    return <p>{activeSiteId ?? 'chargement'}</p>;
  }
  const view = render(
    <SiteProvider organizationId="org-first">
      <Probe />
    </SiteProvider>,
  );
  view.rerender(
    <SiteProvider organizationId="org-second">
      <Probe />
    </SiteProvider>,
  );
  expect(pending[0].signal.aborted).toBe(true);
  await act(async () => {
    for (const [index, request] of pending.entries()) {
      request.resolve(
        new Response(
          JSON.stringify({
            sites: [
              {
                id: index === 0 ? 'old-site' : 'new-site',
                name: 'Restaurant',
                siteStatus: 'ACTIVE',
              },
            ],
          }),
        ),
      );
    }
  });
  expect(screen.getByText('new-site')).toBeInTheDocument();
  expect(screen.queryByText('old-site')).not.toBeInTheDocument();
  view.unmount();
  expect(pending[1].signal.aborted).toBe(true);
});

it('garde le site actif pendant une actualisation de la même organisation', async () => {
  const sitesPayload = {
    sites: [
      { id: 'site-a', name: 'Salle A', siteStatus: 'ACTIVE' },
      { id: 'site-b', name: 'Salle B', siteStatus: 'ACTIVE' },
    ],
  };
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(sitesPayload)));
  vi.stubGlobal('fetch', fetchMock);
  const seen: (string | undefined)[] = [];
  function Probe() {
    const { activeSiteId, selectSite } = useSiteSelection();
    seen.push(activeSiteId);
    return (
      <button type="button" onClick={() => selectSite('site-b')}>
        {activeSiteId ?? 'chargement'}
      </button>
    );
  }
  // Session réelle simulée : aucune configuration de démo, une organisation Clerk.
  render(
    <SiteProvider organizationId="org-real">
      <Probe />
    </SiteProvider>,
  );
  await act(async () => undefined);
  await act(async () => screen.getByRole('button').click());
  expect(screen.getByText('site-b')).toBeInTheDocument();

  seen.length = 0;
  await act(async () => {
    window.dispatchEvent(new Event('suppernote:organization-synced'));
  });

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(seen).not.toContain(undefined);
  expect(screen.getByText('site-b')).toBeInTheDocument();
});
