import { StrictMode, useEffect } from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scope = vi.hoisted(() => ({
  siteId: undefined as string | undefined,
  organizationId: 'org-one',
  sessionId: 'session-one',
}));
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: true, sessionId: scope.sessionId }),
  useOrganization: () => ({ organization: { id: scope.organizationId } }),
}));
vi.mock('@/features/sites/site-context', () => ({
  useSiteSelection: () => ({ activeSiteId: scope.siteId }),
}));
const fetchMock = vi.fn();
const response = (value: unknown = {}) => new Response(JSON.stringify(value), { status: 200 });

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_placeholder');
  vi.stubEnv('NEXT_PUBLIC_DEMO_RESTAURANT_ID', '');
  scope.siteId = undefined;
  scope.organizationId = 'org-one';
  scope.sessionId = 'session-one';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('useApi — lectures concurrentes', () => {
  it('ne transmet le défi Clerk que si la revérification est explicitement demandée', async () => {
    const { useApi } = await import('./api');
    const { result } = renderHook(() => useApi());
    const hint = {
      clerk_error: {
        type: 'forbidden',
        reason: 'reverification-error',
        metadata: { reverification: 'strict' },
      },
    };
    fetchMock.mockImplementation(async () => new Response(JSON.stringify(hint), { status: 403 }));
    await expect(
      result.current.post('sensitive', {}, { allowReverificationHint: true }),
    ).resolves.toEqual(hint);
    await expect(result.current.post('sensitive', {})).rejects.toThrow();
  });
  it('ne double pas une lecture au rejeu des effets en StrictMode', async () => {
    const { useApi } = await import('./api');
    let complete!: (value: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          complete = resolve;
        }),
    );
    function Probe() {
      const { get } = useApi();
      useEffect(() => {
        void get('reservations');
      }, [get]);
      return null;
    }
    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      complete(response([]));
    });
  });

  it('ne garde ni les succès ni les erreurs en cache après la fin de la requête', async () => {
    const { useApi } = await import('./api');
    const { result } = renderHook(() => useApi());
    fetchMock
      .mockRejectedValueOnce(new Error('réseau'))
      .mockImplementation(async () => response([]));
    await expect(result.current.get('reservations')).rejects.toThrow('réseau');
    await result.current.get('reservations');
    await result.current.get('reservations');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('ne partage pas de lecture entre organisations, sessions ou établissements', async () => {
    const { useApi } = await import('./api');
    fetchMock.mockImplementation(async () => response([]));
    const { result, rerender } = renderHook(() => useApi());
    const first = result.current.get('reservations');
    scope.organizationId = 'org-two';
    rerender();
    const organizationRead = result.current.get('reservations');
    scope.sessionId = 'session-two';
    rerender();
    const second = result.current.get('reservations');
    scope.siteId = 'site-two';
    rerender();
    const third = result.current.get('reservations');
    await Promise.all([first, organizationRead, second, third]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[3][1].headers['X-Suppernote-Site-ID']).toBe('site-two');
  });

  it('garde les annulations et les écritures indépendantes', async () => {
    const { useApi } = await import('./api');
    fetchMock.mockImplementation(async () => response({}));
    const { result } = renderHook(() => useApi());
    const controller = new AbortController();
    await Promise.all([
      result.current.get('reservations'),
      result.current.get('reservations', { signal: controller.signal }),
      result.current.post('reservations', { partySize: 2 }),
      result.current.post('reservations', { partySize: 2 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1][1].signal).toBe(controller.signal);
  });

  it('ne recharge pas le même établissement de démo après la résolution multi-site', async () => {
    vi.stubEnv('NEXT_PUBLIC_DEMO_RESTAURANT_ID', 'demo-site');
    const { useApi } = await import('./api');
    fetchMock.mockImplementation(async () => response([]));
    const { result, rerender } = renderHook(() => useApi());
    const firstGet = result.current.get;
    await firstGet('reservations');
    scope.siteId = 'demo-site';
    rerender();
    expect(result.current.get).toBe(firstGet);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].headers['X-Suppernote-Site-ID']).toBe('demo-site');
  });
});
