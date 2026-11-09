import { fireEvent, render, screen } from '@testing-library/react';
import { format } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toApiError } from '@/lib/api-error';
import BriefingPage from './page';

const apiMocks = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ get: apiMocks.get, orgId: 'org_test_123' }),
}));

const today = format(new Date(), 'yyyy-MM-dd');

function reservation(overrides: Record<string, unknown>) {
  return {
    id: 'r1',
    restaurantId: 'org_test_123',
    reservedAt: '2026-10-27T19:30:00.000Z',
    partySize: 2,
    customerName: 'Client',
    customerPhone: null,
    status: 'CONFIRMED',
    state: 'CONFIRMED',
    estimatedRevenue: null,
    tableId: null,
    ...overrides,
  };
}

describe('BriefingPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('affiche le résumé du jour et les allergies, sans les réservations annulées', async () => {
    apiMocks.get.mockImplementation((path: string) => {
      if (path === `v2/reservations/day?date=${today}`) {
        return Promise.resolve([
          reservation({ id: 'r1', customerName: 'Alice Martin', partySize: 4 }),
          reservation({
            id: 'r2',
            customerName: 'Bruno Dupont',
            state: 'CANCELLED',
            status: 'CANCELLED',
          }),
          reservation({
            id: 'r3',
            customerName: 'Chloé Petit',
            partySize: 2,
            state: 'SEATED',
            status: 'SEATED',
          }),
        ]);
      }
      if (path.startsWith('customers/service-cards?')) {
        return Promise.resolve({
          data: [
            {
              reservationId: 'r1',
              customerId: 'customer-1',
              lifecycle: null,
              badges: [{ kind: 'allergy', label: 'Allergie', detail: 'noix' }],
            },
          ],
        });
      }
      return Promise.reject(new Error(`route inattendue : ${path}`));
    });

    render(<BriefingPage />);

    expect(await screen.findByRole('link', { name: 'Alice Martin' })).toHaveAttribute(
      'href',
      '/dashboard/customers/crm/customer-1',
    );
    expect(screen.getByText('Chloé Petit')).toBeInTheDocument();
    expect(screen.queryByText('Bruno Dupont')).not.toBeInTheDocument();
    expect(screen.getByText('Réservations').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('Couverts').nextElementSibling).toHaveTextContent('6');
    expect(screen.getByText('Allergies').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Allergie')).toBeInTheDocument();
  });

  it('dit clairement quand rien n’est à servir aujourd’hui', async () => {
    apiMocks.get.mockImplementation(async (path: string) =>
      path.endsWith('/floor-plan') ? { sections: [] } : [],
    );

    render(<BriefingPage />);

    expect(await screen.findByText('Aucune réservation à servir aujourd’hui.')).toBeInTheDocument();
  });

  it('affiche les statistiques de salle et recharge les données à la date choisie', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.endsWith('/floor-plan')) {
        return { sections: [], tables: [{ id: 't1', capacity: 4, isActive: true }] };
      }
      return [];
    });

    render(<BriefingPage />);
    expect(await screen.findByText('0 / 4 places')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date des statistiques'), {
      target: { value: '2026-11-07' },
    });
    expect(await screen.findByText('0 / 4 places')).toBeInTheDocument();
    expect(apiMocks.get).toHaveBeenCalledWith(
      'restaurants/org_test_123/floor-plan/reservations?date=2026-11-07',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('propose de réessayer après une erreur de chargement', async () => {
    const loadBriefing = vi
      .fn()
      .mockRejectedValueOnce(toApiError(500, { message: 'Le briefing est indisponible.' }))
      .mockResolvedValue([]);
    apiMocks.get.mockImplementation((path: string) => {
      if (path.startsWith('v2/reservations/day')) return loadBriefing();
      return Promise.resolve(path.endsWith('/floor-plan') ? { sections: [] } : []);
    });

    render(<BriefingPage />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Le briefing est indisponible.');
    fireEvent.click(screen.getByRole('button', { name: /Réessayer/ }));
    expect(await screen.findByText('Aucune réservation à servir aujourd’hui.')).toBeInTheDocument();
    expect(loadBriefing).toHaveBeenCalledTimes(2);
  });
});
