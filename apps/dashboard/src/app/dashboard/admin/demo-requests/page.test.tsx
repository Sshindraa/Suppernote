import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DemoRequestsPage from './page';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  patch: vi.fn(),
  post: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  useApi: () => api,
}));

const notifiedRequest = {
  id: 'dr_1',
  pageVersion: 'demo-assistant-tel-v1',
  establishmentName: 'Le Bistrot du Coin',
  contactEmail: 'contact@bistrot.example',
  contactPhone: '+33 6 12 34 56 78',
  currentTool: 'Cahier',
  mainProblem: 'Appels pendant le service',
  status: 'NEW',
  isTest: false,
  notifiedAt: '2026-10-13T10:01:00.000Z',
  contactedAt: null,
  lastInteractionAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
};

const unnotifiedRequest = {
  ...notifiedRequest,
  id: 'dr_2',
  establishmentName: 'La Table du Marché',
  contactPhone: null,
  currentTool: null,
  mainProblem: null,
  notifiedAt: null,
};

describe('DemoRequestsPage', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.patch.mockReset();
    api.post.mockReset();
  });

  it('affiche ensemble les phases et les tests, et conserve la fiche après marquage', async () => {
    const test = { ...unnotifiedRequest, isTest: true, status: 'CLOSED' };
    api.get.mockResolvedValue({ data: [notifiedRequest, test] });
    api.patch.mockResolvedValue({ data: { ...notifiedRequest, isTest: true } });
    render(<DemoRequestsPage />);
    expect(await screen.findByText('La Table du Marché')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/demo-requests?limit=200');
    expect(screen.getByLabelText('Phase de La Table du Marché')).toHaveValue('CLOSED');
    expect(screen.getByText('Test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Marquer comme test' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/admin/demo-requests/dr_1/test', { isTest: true }),
    );
    expect(screen.getByText('Le Bistrot du Coin')).toBeInTheDocument();
  });

  it('affiche chaque demande avec son état de notification', async () => {
    api.get.mockResolvedValue({ data: [notifiedRequest, unnotifiedRequest] });

    render(<DemoRequestsPage />);

    expect(await screen.findByText('Le Bistrot du Coin')).toBeInTheDocument();
    expect(screen.getByText('La Table du Marché')).toBeInTheDocument();
    expect(screen.getAllByText('Source : démo du téléphone')).toHaveLength(2);
    expect(screen.getByText('Envoi accepté')).toBeInTheDocument();
    expect(screen.getByText('Envoi non confirmé')).toBeInTheDocument();
  });

  it("enregistre le nouveau statut d'une demande", async () => {
    api.get.mockResolvedValue({ data: [notifiedRequest] });
    api.patch.mockResolvedValue({ data: { ...notifiedRequest, status: 'CONTACTED' } });

    render(<DemoRequestsPage />);
    const select = await screen.findByLabelText('Phase de Le Bistrot du Coin');
    fireEvent.change(select, { target: { value: 'CONTACTED' } });

    await waitFor(() => {
      expect(api.patch).toHaveBeenCalledWith('/admin/demo-requests/dr_1', {
        status: 'CONTACTED',
      });
    });
    expect(await screen.findByLabelText('Phase de Le Bistrot du Coin')).toHaveValue('CONTACTED');
  });

  it('signale les demandes à examiner et peut enregistrer le dernier échange', async () => {
    const staleRequest = {
      ...notifiedRequest,
      createdAt: '2024-01-10T10:00:00.000Z',
    };
    api.get.mockResolvedValue({ data: [staleRequest] });
    api.post.mockResolvedValue({
      data: { ...staleRequest, lastInteractionAt: '2026-10-14T09:00:00.000Z' },
    });

    render(<DemoRequestsPage />);

    expect(await screen.findByText(/À examiner depuis/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole('button', { name: 'Enregistrer un échange pour Le Bistrot du Coin' }),
    );

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/demo-requests/dr_1/interaction', undefined);
    });
    await waitFor(() => {
      expect(screen.queryByText(/À examiner depuis/)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Dernier échange enregistré le 14\/10\/2026/)).toBeInTheDocument();
  });

  it('permet de corriger la date après vérification de la messagerie', async () => {
    const staleRequest = {
      ...notifiedRequest,
      createdAt: '2024-01-10T10:00:00.000Z',
    };
    api.get.mockResolvedValue({ data: [staleRequest] });
    api.post.mockResolvedValue({
      data: { ...staleRequest, lastInteractionAt: '2026-10-14T07:00:00.000Z' },
    });

    render(<DemoRequestsPage />);
    await screen.findByText(/À examiner depuis/);
    fireEvent.click(screen.getByRole('button', { name: 'Corriger la date' }));
    fireEvent.change(screen.getByLabelText('Date du dernier échange pour Le Bistrot du Coin'), {
      target: { value: '2026-10-14T09:00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la date' }));

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/admin/demo-requests/dr_1/interaction', {
        occurredAt: new Date('2026-10-14T09:00').toISOString(),
      });
    });
    expect(await screen.findByText(/Dernier échange enregistré le/)).toBeInTheDocument();
  });

  it('propose de réessayer quand le chargement échoue', async () => {
    api.get
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: [notifiedRequest] });

    render(<DemoRequestsPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de charger les demandes',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('Le Bistrot du Coin')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledTimes(2);
  });

  it('affiche un état vide quand aucune demande ne correspond au filtre', async () => {
    api.get.mockResolvedValue({ data: [] });

    render(<DemoRequestsPage />);

    expect(await screen.findByText('Aucune demande pour le moment.')).toBeInTheDocument();
  });

  it('charge les demandes au-delà de 200', async () => {
    api.get
      .mockResolvedValueOnce({
        data: Array.from({ length: 200 }, (_, index) => ({
          ...notifiedRequest,
          id: `request-${index}`,
          establishmentName: `Établissement ${index}`,
        })),
      })
      .mockResolvedValueOnce({ data: [unnotifiedRequest] });
    render(<DemoRequestsPage />);
    expect(await screen.findByText('La Table du Marché')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/admin/demo-requests?limit=200&cursor=request-199');
  });
});
