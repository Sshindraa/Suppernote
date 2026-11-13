import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api-error';
import AdminHealthPage from './page';

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ orgId: 'org_test', get: apiMocks.get, post: apiMocks.post }),
}));

const restaurantsResponse = {
  ok: true,
  restaurants: [{ restaurantId: 'resto-1', restaurantName: 'Chez Suppernote' }],
};

const healthResponse = {
  ok: true,
  health: {
    restaurant: { id: 'resto-1', name: 'Chez Suppernote', slug: 'chez-sokar' },
    phone: {
      number: '+33451221528',
      carrier: 'telnyx',
      provisioningStatus: 'READY',
      telnyxPhoneNumberId: 'pn-123',
      forwardingConfiguredAt: '2026-07-20T10:00:00.000Z',
      testCallValidatedAt: '2026-07-21T09:00:00.000Z',
      firstCallAt: '2026-07-21T09:05:00.000Z',
      smsConfirmEnabled: true,
    },
    lastCall: {
      callSid: 'call-1',
      at: '2026-07-22T08:00:00.000Z',
      durationSec: 95,
      outcome: 'RESERVED',
      hasTranscript: true,
    },
    lastReservation: {
      id: 'resa-1',
      customerName: 'Martin Dupont',
      partySize: 4,
      reservedAt: '2026-07-22T19:30:00.000Z',
      createdAt: '2026-07-22T08:01:00.000Z',
      status: 'CONFIRMED',
      channel: 'PHONE',
    },
    lastSms: {
      kind: 'reservation_confirmation_sms_sent',
      at: '2026-07-22T08:01:30.000Z',
      reservationId: 'resa-1',
      customerName: null,
    },
    workers: [
      {
        queue: 'sms-client',
        waiting: 0,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: 0,
        status: 'ok',
      },
      {
        queue: 'dead-letter',
        waiting: 2,
        active: 0,
        delayed: 0,
        failed: 0,
        paused: 0,
        status: 'ok',
      },
      { queue: 'analytics', waiting: 0, active: 0, delayed: 0, failed: 7, paused: 0, status: 'ok' },
    ],
    generatedAt: '2026-07-22T10:00:00.000Z',
  },
};

describe('AdminHealthPage', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.includes('/health') ? healthResponse : restaurantsResponse),
    );
  });

  it('charge la liste des restaurants puis la santé du premier', async () => {
    render(<AdminHealthPage />);

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('admin/provisioning/restaurants');
      expect(apiMocks.get).toHaveBeenCalledWith('admin/restaurants/resto-1/health');
    });

    expect(screen.getByRole('heading', { name: 'Santé du restaurant' })).toBeInTheDocument();
    expect(await screen.findByText('+33451221528')).toBeInTheDocument();
    expect(screen.getByText('Martin Dupont')).toBeInTheDocument();
    expect(screen.getByText('Réservation prise')).toBeInTheDocument();
    expect(screen.getByText('SMS de confirmation')).toBeInTheDocument();
  });

  it('signale les files en échec dans le tableau des workers', async () => {
    render(<AdminHealthPage />);

    await screen.findByText('sms-client');
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('1 file(s) à vérifier')).toBeInTheDocument();
  });

  it('affiche les états vides quand le restaurant n’a aucune activité', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('/health')
          ? {
              ok: true,
              health: {
                ...healthResponse.health,
                lastCall: null,
                lastReservation: null,
                lastSms: null,
              },
            }
          : restaurantsResponse,
      ),
    );
    render(<AdminHealthPage />);

    expect(await screen.findByText('Aucun appel reçu pour le moment.')).toBeInTheDocument();
    expect(screen.getByText('Aucune réservation pour le moment.')).toBeInTheDocument();
    expect(screen.getByText('Aucun SMS tracé pour le moment.')).toBeInTheDocument();
  });

  it('affiche une erreur avec relance quand l’API échoue', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      path.includes('/health')
        ? Promise.reject(new Error('Erreur 500'))
        : Promise.resolve(restaurantsResponse),
    );
    render(<AdminHealthPage />);

    expect(await screen.findByText('Erreur 500')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });

  it('affiche des libellés français, jamais les codes techniques', async () => {
    apiMocks.get.mockImplementation((path: string) =>
      Promise.resolve(path.includes('provisioning') ? restaurantsResponse : healthResponse),
    );
    render(<AdminHealthPage />);

    expect(await screen.findByText('Confirmée')).toBeInTheDocument();
    expect(screen.getByText('Téléphone')).toBeInTheDocument();
    expect(screen.queryByText('CONFIRMED')).toBeNull();
    expect(screen.queryByText('PHONE')).toBeNull();
    expect(screen.queryByText('READY')).toBeNull();
  });

  it('n’affiche plus l’ancienne santé pendant qu’une nouvelle est en cours de chargement', async () => {
    let calls = 0;
    apiMocks.get.mockImplementation((path: string) => {
      if (path.includes('provisioning')) return Promise.resolve(restaurantsResponse);
      calls += 1;
      return calls === 1 ? Promise.resolve(healthResponse) : new Promise(() => undefined);
    });
    render(<AdminHealthPage />);
    await screen.findByText('Martin Dupont');

    fireEvent.click(screen.getByRole('button', { name: /Actualiser/ }));

    await waitFor(() => expect(screen.queryByText('Martin Dupont')).toBeNull());
    expect(screen.getByText(/Chargement de la santé/)).toBeInTheDocument();
  });

  describe('recalcul des chiffres d’un client', () => {
    const previewPath = 'admin/restaurants/resto-1/customers/cust-42/projection-repair-preview';
    const repairPath = 'admin/restaurants/resto-1/customers/cust-42/projection-repair';

    function mockPreview(preview: { changed: boolean; reservationCount: number }) {
      apiMocks.get.mockImplementation((path: string) => {
        if (path.endsWith('/projection-repair-preview')) {
          return Promise.resolve({ data: { ...preview, current: null, expected: {} } });
        }
        return Promise.resolve(path.includes('/health') ? healthResponse : restaurantsResponse);
      });
    }

    async function enterCustomerId() {
      fireEvent.change(await screen.findByLabelText('ID du client'), {
        target: { value: 'cust-42' },
      });
    }

    it('vérifie le client sur le chemin du restaurant sélectionné', async () => {
      mockPreview({ changed: false, reservationCount: 3 });
      render(<AdminHealthPage />);

      await enterCustomerId();
      fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

      expect(await screen.findByText('Chiffres à jour (3 réservations).')).toBeInTheDocument();
      expect(apiMocks.get).toHaveBeenCalledWith(previewPath);
      expect(screen.queryByRole('button', { name: 'Recalculer' })).toBeNull();
    });

    it('propose Recalculer seulement quand il y a un écart', async () => {
      mockPreview({ changed: true, reservationCount: 1 });
      render(<AdminHealthPage />);

      await enterCustomerId();
      fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

      expect(await screen.findByText('Écart sur 1 réservation.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Recalculer' })).toBeInTheDocument();
    });

    it('envoie le recalcul avec une clé d’idempotence', async () => {
      mockPreview({ changed: true, reservationCount: 2 });
      apiMocks.post.mockResolvedValue({ data: { changed: true, reservationCount: 2 } });
      render(<AdminHealthPage />);

      await enterCustomerId();
      fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Recalculer' }));

      expect(await screen.findByText('Chiffres recalculés.')).toBeInTheDocument();
      expect(apiMocks.post).toHaveBeenCalledWith(repairPath, undefined, {
        headers: { 'Idempotency-Key': expect.stringMatching(/^[0-9a-f-]{36}$/) },
      });
    });

    it('affiche un message clair quand le client est introuvable', async () => {
      apiMocks.get.mockImplementation((path: string) =>
        path.endsWith('/projection-repair-preview')
          ? Promise.reject(new ApiError('Not found', 404, null))
          : Promise.resolve(path.includes('/health') ? healthResponse : restaurantsResponse),
      );
      render(<AdminHealthPage />);

      await enterCustomerId();
      fireEvent.click(screen.getByRole('button', { name: 'Vérifier' }));

      expect(await screen.findByText('Client introuvable dans ce restaurant.')).toBeInTheDocument();
    });
  });
});
