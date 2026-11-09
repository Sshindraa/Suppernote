import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FloorPlanCrud } from './FloorPlanCrud';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  put: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  orgId: 'org_test',
}));

vi.mock('@/lib/api', () => ({
  useApi: () => apiMocks,
}));

vi.mock('@/lib/useMediaQuery', () => ({
  useIsMobile: () => false,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title, description }: any) =>
    open ? (
      <div data-testid="confirm-dialog" data-title={title}>
        <span data-testid="confirm-description">{description}</span>
        <button data-testid="confirm-yes" onClick={onConfirm}>
          Confirmer
        </button>
        <button data-testid="confirm-no" onClick={onCancel}>
          Annuler
        </button>
      </div>
    ) : null,
}));

const floorPlanFixture = {
  id: 'fp',
  name: 'Plan test',
  sections: [
    {
      id: 's1',
      name: 'Terrasse',
      position: 1,
      tables: [
        {
          id: 't1',
          name: 'T1',
          capacity: 4,
          minCapacity: 2,
          isActive: true,
          positionX: null,
          positionY: null,
          shape: null,
        },
        {
          id: 't2',
          name: 'T2',
          capacity: 2,
          minCapacity: 1,
          isActive: false,
          positionX: null,
          positionY: null,
          shape: null,
        },
      ],
    },
    {
      id: 's2',
      name: 'Salle principale',
      position: 2,
      tables: [
        {
          id: 't3',
          name: 'T3',
          capacity: 6,
          minCapacity: 4,
          isActive: true,
          positionX: null,
          positionY: null,
          shape: null,
        },
      ],
    },
  ],
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  apiMocks.get.mockResolvedValue(floorPlanFixture);
  apiMocks.post.mockResolvedValue({});
  apiMocks.put.mockResolvedValue({});
  apiMocks.patch.mockResolvedValue({});
  apiMocks.del.mockResolvedValue({});
});

describe('FloorPlanCrud', () => {
  it('affiche les skeletons pendant le chargement', () => {
    apiMocks.get.mockImplementation(() => new Promise(() => {}));

    const { container } = render(<FloorPlanCrud />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
    expect(screen.queryByRole('heading', { name: 'Plan de salle' })).not.toBeInTheDocument();
  });

  it('affiche le message vide quand le plan est vide', async () => {
    apiMocks.get.mockResolvedValue({ id: 'fp', name: 'Plan', sections: [] });

    render(<FloorPlanCrud />);

    await waitFor(() => {
      expect(screen.getByText('Aucune table dans ce plan.')).toBeInTheDocument();
    });
  });

  it('affiche les tables historiques dans la liste du plan', async () => {
    render(<FloorPlanCrud />);

    await screen.findByRole('heading', { name: 'Plan de salle' });

    expect(screen.queryByText('Terrasse')).not.toBeInTheDocument();
    expect(screen.queryByText('Salle principale')).not.toBeInTheDocument();
    expect(screen.getByText('T1')).toBeInTheDocument();
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(screen.getByText('4 couverts (min. 2)')).toBeInTheDocument();
    expect(screen.getByText('6 couverts (min. 4)')).toBeInTheDocument();
  });

  it('active et désactive une table', async () => {
    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    const switches = screen.getAllByRole('switch');
    const tableSwitch = switches[0];

    expect(tableSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(tableSwitch);

    await waitFor(() => {
      expect(tableSwitch).toHaveAttribute('aria-checked', 'false');
    });

    expect(apiMocks.patch).toHaveBeenNthCalledWith(1, 'restaurants/org_test/floor-plan/tables/t1', {
      isActive: false,
    });

    fireEvent.click(tableSwitch);

    await waitFor(() => {
      expect(tableSwitch).toHaveAttribute('aria-checked', 'true');
    });

    expect(apiMocks.patch).toHaveBeenNthCalledWith(2, 'restaurants/org_test/floor-plan/tables/t1', {
      isActive: true,
    });
  });

  it('crée une table dans le plan', async () => {
    apiMocks.post.mockResolvedValue({
      id: 't4',
      name: 'T4',
      capacity: 8,
      minCapacity: 1,
      isActive: true,
      positionX: null,
      positionY: null,
      shape: null,
    });

    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    const tableInput = screen.getByLabelText('Nom de la table');
    const capacityInput = screen.getByLabelText('Couverts');

    fireEvent.change(tableInput, { target: { value: 'T4' } });
    fireEvent.change(capacityInput, { target: { value: '8' } });
    fireEvent.submit(tableInput.closest('form') as HTMLFormElement);

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables', {
        name: 'T4',
        capacity: 8,
      });
    });

    expect(await screen.findByText('T4')).toBeInTheDocument();
    expect(screen.getByText('8 couverts')).toBeInTheDocument();
  });

  it('supprime une table avec confirmation', async () => {
    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la table T3' }));

    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-yes'));

    await waitFor(() => {
      expect(apiMocks.del).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables/t3');
    });

    await waitFor(() => {
      expect(screen.queryByText('T3')).not.toBeInTheDocument();
    });
  });

  it('affiche une erreur avec « Réessayer » si le chargement échoue, sans formulaire', async () => {
    apiMocks.get.mockRejectedValueOnce(new Error('network error'));

    render(<FloorPlanCrud />);

    expect(await screen.findByText('network error')).toBeInTheDocument();
    expect(screen.queryByLabelText('Nom de la table')).not.toBeInTheDocument();

    apiMocks.get.mockResolvedValueOnce({
      id: 'plan-1',
      name: 'Plan',
      sections: [{ id: 'section-1', name: 'Salle', position: 0, tables: [] }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('Tables du plan')).toBeInTheDocument();
    expect(screen.getByLabelText('Nom de la table')).toBeInTheDocument();
  });

  it('affiche une erreur si la création de table échoue', async () => {
    apiMocks.post.mockRejectedValue(new Error('create table failed'));

    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    const tableInput = screen.getByLabelText('Nom de la table');
    const capacityInput = screen.getByLabelText('Couverts');

    fireEvent.change(tableInput, { target: { value: 'T4' } });
    fireEvent.change(capacityInput, { target: { value: '8' } });
    fireEvent.submit(tableInput.closest('form') as HTMLFormElement);

    expect(await screen.findByText('create table failed')).toBeInTheDocument();
    expect(screen.queryByText('T4')).not.toBeInTheDocument();
    expect(apiMocks.post).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables', {
      name: 'T4',
      capacity: 8,
    });
  });

  it('affiche une erreur si la suppression de table échoue', async () => {
    apiMocks.del.mockRejectedValue(new Error('delete table failed'));

    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    fireEvent.click(screen.getByRole('button', { name: 'Supprimer la table T3' }));

    await screen.findByTestId('confirm-dialog');
    fireEvent.click(screen.getByTestId('confirm-yes'));

    expect(await screen.findByText('delete table failed')).toBeInTheDocument();
    expect(screen.getByText('T3')).toBeInTheDocument();
    expect(apiMocks.del).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables/t3');
  });

  it('affiche une erreur si le changement d’état d’une table échoue', async () => {
    apiMocks.patch.mockRejectedValue(new Error('toggle table failed'));

    render(<FloorPlanCrud />);
    await screen.findByRole('heading', { name: 'Plan de salle' });

    const tableSwitch = screen.getAllByRole('switch')[0];
    expect(tableSwitch).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(tableSwitch);

    expect(await screen.findByText('toggle table failed')).toBeInTheDocument();
    await waitFor(() => {
      expect(tableSwitch).toHaveAttribute('aria-checked', 'true');
    });
    expect(apiMocks.patch).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables/t1', {
      isActive: false,
    });
  });

  it('récupère le plan ciblé quand floorPlanId est fourni', async () => {
    render(<FloorPlanCrud floorPlanId="fp" />);

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('restaurants/org_test/floor-plans/fp');
    });

    expect(screen.getByRole('heading', { name: 'Plan de salle' })).toBeInTheDocument();
  });

  describe('tables sans section', () => {
    const loose = {
      id: 't9',
      name: 'Bar 1',
      capacity: 2,
      minCapacity: 1,
      isActive: true,
      positionX: 10,
      positionY: 10,
      shape: null,
    };

    it('affiche les tables dessinées dans « Plan visuel » sans section, au lieu de « Aucune section »', async () => {
      apiMocks.get.mockResolvedValue({ id: 'fp', name: 'Plan', sections: [], tables: [loose] });

      render(<FloorPlanCrud />);

      await screen.findByRole('heading', { name: 'Tables du plan' });
      expect(screen.getByText('Bar 1')).toBeInTheDocument();
      expect(screen.queryByText('Aucune table dans ce plan.')).not.toBeInTheDocument();
    });

    it('permet de désactiver une table sans section', async () => {
      apiMocks.get.mockResolvedValue({ id: 'fp', name: 'Plan', sections: [], tables: [loose] });
      render(<FloorPlanCrud />);

      await screen.findByRole('heading', { name: 'Tables du plan' });
      const toggle = screen.getByRole('switch');
      fireEvent.click(toggle);

      await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'false'));
      expect(apiMocks.patch).toHaveBeenCalledWith('restaurants/org_test/floor-plan/tables/t9', {
        isActive: false,
      });
    });
  });
});
