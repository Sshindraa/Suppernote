import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncOrganization } from './SyncOrganization';

const session = vi.hoisted(() => ({ signedIn: true, organizationId: 'org_first' }));
vi.mock('@clerk/nextjs', () => ({
  useAuth: () => ({ isSignedIn: session.signedIn }),
  useOrganization: () => ({ organization: { id: session.organizationId } }),
}));
const fetchMock = vi.fn();
let synced = vi.fn<() => void>();

beforeEach(() => {
  vi.useFakeTimers();
  session.signedIn = true;
  session.organizationId = 'org_first';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  synced = vi.fn();
  window.addEventListener('suppernote:organization-synced', synced);
});
afterEach(() => {
  cleanup();
  window.removeEventListener('suppernote:organization-synced', synced);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

it('ne confirme la synchronisation qu’après une réponse réussie', async () => {
  fetchMock.mockResolvedValue({ ok: true });
  const view = render(<SyncOrganization />);
  await tick();
  view.rerender(<SyncOrganization />);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(synced).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('reprend une panne réseau et une erreur serveur avant de confirmer', async () => {
  fetchMock
    .mockRejectedValueOnce(new TypeError('Network error'))
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: true });
  render(<SyncOrganization />);
  await tick();
  expect(synced).not.toHaveBeenCalled();
  await tick(1_000);
  expect(synced).not.toHaveBeenCalled();
  await tick(2_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(synced).toHaveBeenCalledTimes(1);
});

it('arrête les reprises après trois échecs et permet un nouvel essai explicite', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 503 });
  render(<SyncOrganization />);
  await tick(3_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(synced).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Impossible de préparer votre compte');
  await tick(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  fetchMock.mockResolvedValue({ ok: true });
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  await tick();
  expect(synced).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('ne retente pas automatiquement un refus d’accès', async () => {
  fetchMock.mockResolvedValue({ ok: false, status: 403 });
  render(<SyncOrganization />);
  await tick(10_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  expect(synced).not.toHaveBeenCalled();
});

it('annule une requête bloquée et reprend après le délai maximal', async () => {
  fetchMock
    .mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () => reject(new Error('Aborted')));
        }),
    )
    .mockResolvedValueOnce({ ok: true });
  render(<SyncOrganization />);
  await tick(10_000);
  expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
  expect(synced).not.toHaveBeenCalled();
  await tick(1_000);
  expect(synced).toHaveBeenCalledTimes(1);
});

it('synchronise la nouvelle organisation sans traiter la réponse de l’ancienne', async () => {
  let resolveOld!: (value: { ok: boolean }) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveOld = resolve;
      }),
  );
  const view = render(<SyncOrganization />);
  const oldSignal = fetchMock.mock.calls[0][1].signal;
  session.organizationId = 'org_second';
  fetchMock.mockResolvedValueOnce({ ok: true });
  view.rerender(<SyncOrganization />);
  await tick();
  expect(oldSignal.aborted).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(synced).toHaveBeenCalledTimes(1);
  await act(async () => {
    resolveOld({ ok: true });
  });
  expect(synced).toHaveBeenCalledTimes(1);
});

it('annule les reprises au démontage et ne provisionne pas sans connexion', async () => {
  fetchMock.mockRejectedValue(new TypeError('Network error'));
  const view = render(<SyncOrganization />);
  await tick();
  view.unmount();
  await tick(30_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  session.signedIn = false;
  render(<SyncOrganization />);
  await tick();
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(synced).not.toHaveBeenCalled();
});

it('attend le délai Retry-After annoncé par un 429 avant de reprendre', async () => {
  fetchMock
    .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'Retry-After': '5' } }))
    .mockResolvedValueOnce({ ok: true });
  render(<SyncOrganization />);
  await tick();
  await tick(4_000);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await tick(1_000);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(synced).toHaveBeenCalledTimes(1);
});
