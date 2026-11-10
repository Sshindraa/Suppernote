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

const CHECK = {
  id: 'c1',
  externalId: 'T-1',
  openedAt: '2026-12-31T19:15:00.000Z',
  tableReference: '12',
  total: '13.50',
  currency: 'EUR',
  match: {
    status: 'MATCHED',
    confidence: 0.85,
    reservation: { id: 'r1', at: '2026-12-31T19:15:00.000Z', partySize: 2, table: '12' },
  },
};

/** Answers each endpoint the page reads, by path. */
function answer(connections: unknown, checks: unknown = { data: { items: [], nextCursor: null } }) {
  mocks.get.mockImplementation((path: string) => {
    if (path.startsWith('pos/connections')) {
      return connections instanceof Error
        ? Promise.reject(connections)
        : Promise.resolve(connections);
    }
    if (path.startsWith('pos/checks')) {
      return checks instanceof Error ? Promise.reject(checks) : Promise.resolve(checks);
    }
    return Promise.reject(new Error(`unexpected ${path}`));
  });
}

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
    answer(toApiError(503, { error: 'POS_CONNECTORS_DISABLED' }));
    render(<CaissePage />);

    expect(await screen.findByText('Import de tickets pas encore ouvert')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Importer un fichier' })).toBeNull();
    expect(mocks.get.mock.calls.map(([path]) => path)).not.toContain('pos/checks?limit=50');
  });

  it('explique que seuls les responsables peuvent importer', async () => {
    answer(toApiError(403, { error: 'POS_ROLE_REQUIRED' }));
    render(<CaissePage />);

    expect(await screen.findByText('Réservé aux responsables')).toBeTruthy();
  });

  it('propose de réessayer après une erreur API', async () => {
    mocks.get
      .mockRejectedValueOnce(new Error('Impossible de joindre le serveur API'))
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.startsWith('pos/checks') ? { data: { items: [], nextCursor: null } } : { data: [] },
        ),
      );
    render(<CaissePage />);

    fireEvent.click(await screen.findByRole('button', { name: /réessayer/i }));

    expect(await screen.findByRole('button', { name: 'Importer un fichier' })).toBeTruthy();
  });

  it('affiche la ligne d’aide tant qu’aucun ticket n’est importé', async () => {
    answer({ data: [] });
    render(<CaissePage />);

    expect(
      await screen.findByText(
        'Exportez vos tickets depuis votre caisse (Excel ou CSV), puis déposez le fichier ici.',
      ),
    ).toBeTruthy();
  });

  it('masque la ligne d’aide dès qu’un import a eu lieu', async () => {
    answer({
      data: [{ provider: 'csv-file', status: 'ACTIVE', lastSuccessAt: '2026-11-09T19:30:00.000Z' }],
    });
    render(<CaissePage />);

    expect(await screen.findByText(/Dernier import/)).toBeTruthy();
    expect(screen.queryByText(/Exportez vos tickets/)).toBeNull();
  });

  it('affiche la date du dernier import et ouvre la boîte d’import', async () => {
    answer({
      data: [{ provider: 'csv-file', status: 'ACTIVE', lastSuccessAt: '2026-11-09T19:30:00.000Z' }],
    });
    render(<CaissePage />);

    expect(await screen.findByText(/Dernier import/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Importer un fichier' }));
    await waitFor(() => expect(screen.getByLabelText('Fichier à importer')).toBeTruthy());
  });

  it('liste les tickets avec leur rapprochement', async () => {
    answer(
      { data: [] },
      {
        data: {
          items: [
            CHECK,
            { ...CHECK, id: 'c2', externalId: 'T-2', match: null },
            { ...CHECK, id: 'c3', externalId: 'T-3', match: { ...CHECK.match, status: 'REVIEW' } },
          ],
          nextCursor: null,
        },
      },
    );
    render(<CaissePage />);

    expect(await screen.findByText('Ticket T-1 · table 12')).toBeTruthy();
    expect(screen.getByText(/Rapproché · /)).toBeTruthy();
    expect(screen.getByText('Non rapproché')).toBeTruthy();
    expect(screen.getByText(/À vérifier · /)).toBeTruthy();
  });

  it('confirme un ticket à vérifier en un clic, puis le marque rapproché', async () => {
    answer(
      { data: [] },
      {
        data: {
          items: [
            { ...CHECK, id: 'c3', externalId: 'T-3', match: { ...CHECK.match, status: 'REVIEW' } },
          ],
          nextCursor: null,
        },
      },
    );
    mocks.post.mockResolvedValueOnce({ data: { status: 'MATCHED' } });
    render(<CaissePage />);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Confirmer le rapprochement du ticket T-3' }),
    );

    expect(mocks.post).toHaveBeenCalledWith('pos/checks/c3/review', { decision: 'confirm' });
    expect(await screen.findByText(/Rapproché · /)).toBeTruthy();
  });

  it('affiche l’état vide de la liste quand aucun ticket n’est importé', async () => {
    answer({ data: [] });
    render(<CaissePage />);

    expect(await screen.findByText('Aucun ticket importé pour l’instant.')).toBeTruthy();
  });

  it('affiche une erreur de liste avec un nouvel essai', async () => {
    answer({ data: [] }, new Error('Réseau indisponible'));
    render(<CaissePage />);

    expect(await screen.findByText('Réseau indisponible')).toBeTruthy();
  });
});
