vi.mock('@/lib/use-service-copilot-access', () => ({
  useServiceCopilotAccess: () => ({ allowed: true, loading: false, error: false, retry: vi.fn() }),
}));
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FloorPlanPage from './page';

const mocks = vi.hoisted(() => {
  let searchParamsString = '';

  return {
    replace: vi.fn(),
    getSearchParams: () => new URLSearchParams(searchParamsString),
    setSearchParams: (query: string) => {
      searchParamsString = query;
    },
  };
});

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));

const canvasMock = vi.hoisted(() =>
  vi.fn(({ mode, floorPlanId }: { mode: string; floorPlanId?: string }) => (
    <div data-mode={mode} data-floor-plan-id={floorPlanId}>
      {mode}
    </div>
  )),
);

const crudMock = vi.hoisted(() =>
  vi.fn(({ floorPlanId }: { floorPlanId?: string }) => (
    <div data-testid="floor-plan-crud" data-floor-plan-id={floorPlanId}>
      crud
    </div>
  )),
);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => '/dashboard/floor-plan',
  useSearchParams: mocks.getSearchParams,
}));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ orgId: 'org_test', get: apiMocks.get, post: apiMocks.post }),
}));

vi.mock('./_components/FloorPlanCanvas', () => ({
  FloorPlanCanvas: canvasMock,
}));

vi.mock('./_components/FloorPlanCrud', () => ({
  FloorPlanCrud: crudMock,
}));

const floorPlansFixture = [
  { id: 'fp-1', name: 'Salle principale', isDefault: true, isActive: true, tableCount: 3 },
  { id: 'fp-2', name: 'Terrasse', isDefault: false, isActive: true, tableCount: 1 },
];

describe('FloorPlanPage — switch desktop', () => {
  beforeEach(() => {
    mocks.replace.mockClear();
    mocks.setSearchParams('');
    canvasMock.mockClear();
    crudMock.mockClear();
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.get.mockResolvedValue(floorPlansFixture);
    apiMocks.post.mockResolvedValue({ id: 'fp-3', name: 'Nouveau plan' });
  });

  it('charge la liste des plans et sélectionne le plan par défaut actif', async () => {
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('restaurants/org_test/floor-plans');
    });

    expect(canvasMock.mock.lastCall?.[0]).toEqual(
      expect.objectContaining({ mode: 'service', floorPlanId: 'fp-1' }),
    );
  });

  it('permet de réessayer après une panne sans laisser le skeleton affiché', async () => {
    apiMocks.get
      .mockRejectedValueOnce(new Error('Impossible de joindre le serveur API'))
      .mockResolvedValueOnce(floorPlansFixture);

    render(<FloorPlanPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Impossible de joindre le serveur API');
    expect(screen.queryByTestId('floor-plan-selector')).not.toBeInTheDocument();

    apiMocks.get.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    await waitFor(() => {
      expect(screen.getByText('service')).toBeInTheDocument();
    });
    expect(
      apiMocks.get.mock.calls.filter((call) => call[0] === 'restaurants/org_test/floor-plans'),
    ).toHaveLength(1);
  });

  it('transmet le signalement vocal puis nettoie son URL après application', async () => {
    mocks.setSearchParams(
      'reservationId=res-1&delayMinutes=25&delayReportId=report-1&serviceDate=2026-07-21&foo=bar',
    );
    render(<FloorPlanPage />);

    await waitFor(() => expect(canvasMock).toHaveBeenCalled());
    const props = canvasMock.mock.calls.at(-1)?.[0] as unknown as {
      initialDelayImpact: {
        reservationId: string;
        delayMinutes: number;
        delayReportId: string;
        serviceDate: string;
      };
      onInitialDelayApplied: () => void;
    };
    expect(props.initialDelayImpact).toEqual({
      reservationId: 'res-1',
      delayMinutes: 25,
      delayReportId: 'report-1',
      serviceDate: '2026-07-21',
    });

    props.onInitialDelayApplied();
    expect(mocks.replace).toHaveBeenCalledWith('/dashboard/floor-plan?foo=bar', {
      scroll: false,
    });
  });

  it('utilise le plan demandé dans la query floorPlanId', async () => {
    mocks.setSearchParams('floorPlanId=fp-2');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(canvasMock.mock.lastCall?.[0]).toEqual(
        expect.objectContaining({ mode: 'service', floorPlanId: 'fp-2' }),
      );
    });
  });

  it('ouvre l’édition du plan courant depuis l’état vide Live', async () => {
    render(<FloorPlanPage />);

    await waitFor(() => expect(canvasMock).toHaveBeenCalled());
    const props = canvasMock.mock.calls.at(-1)?.[0] as unknown as {
      onRequestEdit: () => void;
    };

    props.onRequestEdit();

    expect(mocks.replace).toHaveBeenCalledWith(
      '/dashboard/floor-plan?view=edit-plan&floorPlanId=fp-1',
      { scroll: false },
    );
  });

  it('affiche la vue Live sans en-tête ni contrôles d’édition', async () => {
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByText('service')).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Service en salle' })).not.toBeInTheDocument();
    expect(screen.queryByText('Suivez le service en temps réel.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'En direct' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modifier la salle' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('create-floor-plan')).not.toBeInTheDocument();
  });

  it('affiche la vue Edition sans en-tête ni bascule redondante', async () => {
    mocks.setSearchParams('view=edit-plan');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByText('design')).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Modifier la salle' })).not.toBeInTheDocument();
    expect(screen.queryByText('Organisez vos plans et vos tables.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'En direct' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Modifier la salle' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Fil d’Ariane' })).not.toBeInTheDocument();
    expect(screen.getByTestId('create-floor-plan')).toBeInTheDocument();
  });

  it('affiche les onglets design en mode edit-plan avec Plan visuel actif', async () => {
    mocks.setSearchParams('view=edit-plan');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Plan visuel' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
    expect(screen.getByRole('tab', { name: 'Tables' })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByText('design')).toBeInTheDocument();
  });

  it('affiche FloorPlanCrud en cliquant sur Tables', async () => {
    mocks.setSearchParams('view=edit-plan');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Tables' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));

    expect(screen.getByTestId('floor-plan-crud')).toBeInTheDocument();
    expect(screen.queryByText('design')).not.toBeInTheDocument();
  });

  it('ré-affiche le canvas design en cliquant sur Plan visuel', async () => {
    mocks.setSearchParams('view=edit-plan');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: 'Tables' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Tables' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Plan visuel' }));

    expect(screen.getByText('design')).toBeInTheDocument();
    expect(screen.queryByTestId('floor-plan-crud')).not.toBeInTheDocument();
  });

  it('n’affiche pas les onglets design en mode service-live', async () => {
    mocks.setSearchParams('');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByText('service')).toBeInTheDocument();
    });

    expect(screen.queryByRole('tab', { name: 'Plan visuel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Tables' })).not.toBeInTheDocument();
  });

  it('ouvre la boîte de dialogue de création et crée un plan', async () => {
    mocks.setSearchParams('view=edit-plan');
    render(<FloorPlanPage />);

    await waitFor(() => {
      expect(screen.getByTestId('create-floor-plan')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('create-floor-plan'));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Créer un plan de salle' })).toBeInTheDocument();
  });

  it('garde la fenêtre de création ouverte et affiche l’erreur dedans quand la création échoue', async () => {
    mocks.setSearchParams('view=edit-plan');
    apiMocks.post.mockRejectedValue(new Error('Un plan porte déjà ce nom.'));
    render(<FloorPlanPage />);

    fireEvent.click(await screen.findByTestId('create-floor-plan'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Nom du plan'), {
      target: { value: 'Terrasse' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Créer' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Un plan porte déjà ce nom.',
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Créer' })).toBeEnabled();

    fireEvent.change(within(dialog).getByLabelText('Nom du plan'), {
      target: { value: 'Terrasse 2' },
    });
    expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('propose de créer un premier plan dès la vue service, sans second encadré vide', async () => {
    apiMocks.get.mockResolvedValue([]);
    render(<FloorPlanPage />);

    expect(await screen.findByText('Aucun plan de salle')).toBeInTheDocument();
    expect(screen.getByText(/Dessinez votre salle/)).toBeInTheDocument();
    expect(screen.queryByText('Aucun plan de salle sélectionné.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Créer votre premier plan' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
