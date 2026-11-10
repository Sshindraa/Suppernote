import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toApiError } from '@/lib/api-error';
import CaissePage from './page';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  capabilities: null as Record<string, boolean> | null,
}));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post, orgId: 'org_test' }),
}));

vi.mock('@/lib/use-capabilities', () => ({
  useCapabilities: () => mocks.capabilities,
}));

describe('CaissePage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.capabilities = { 'pos.connect': true };
  });

  it('n’appelle pas l’API sans le droit pos.connect', async () => {
    mocks.capabilities = { 'pos.connect': false };
    render(<CaissePage />);

    expect(await screen.findByText('La caisse n’est pas incluse dans votre formule')).toBeTruthy();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('affiche un état vide explicite quand la fonction est coupée côté serveur', async () => {
    mocks.get.mockRejectedValue(toApiError(503, { error: 'POS_CONNECTORS_DISABLED' }));
    render(<CaissePage />);

    expect(await screen.findByText('Import de tickets pas encore ouvert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Importer un fichier CSV/ })).toBeNull();
  });

  it('explique que seuls les responsables peuvent importer', async () => {
    mocks.get.mockRejectedValue(toApiError(403, { error: 'POS_ROLE_REQUIRED' }));
    render(<CaissePage />);

    expect(await screen.findByText('Réservé aux responsables')).toBeTruthy();
  });

  it('propose de réessayer après une erreur API', async () => {
    mocks.get
      .mockRejectedValueOnce(new Error('Impossible de joindre le serveur API'))
      .mockResolvedValueOnce({ data: [] });
    render(<CaissePage />);

    const retry = await screen.findByRole('button', { name: /réessayer/i });
    fireEvent.click(retry);

    expect(await screen.findByRole('button', { name: /Importer un fichier CSV/ })).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('affiche la date du dernier import et ouvre la boîte d’import', async () => {
    mocks.get.mockResolvedValue({
      data: [
        {
          provider: 'csv-file',
          status: 'ACTIVE',
          lastSuccessAt: '2026-11-09T19:30:00.000Z',
        },
      ],
    });
    render(<CaissePage />);

    expect(await screen.findByText(/Dernier import/)).toBeTruthy();
    expect(screen.getByText(/prochaine version/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Importer un fichier CSV/ }));
    await waitFor(() => expect(screen.getByLabelText('Fichier CSV des tickets')).toBeTruthy());
  });
});
