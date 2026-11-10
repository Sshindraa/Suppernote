import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, render, screen, waitFor } from '@testing-library/react';
import {
  CustomerRealSpendCard,
  ReservationAdditionLine,
  formatEuro,
  tableLabel,
  useReservationAddition,
} from '@/components/pos/real-spend';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/lib/api', () => ({ useApi: () => ({ get: mocks.get, orgId: 'org_test' }) }));

const spend = {
  total: '90.50',
  checkCount: 2,
  averageAddition: '45.25',
  averagePerCover: '18.10',
  lastAddition: { at: '2026-11-08T20:30:00.000Z', amount: '30.50' },
};

describe('CustomerRealSpendCard', () => {
  it('n’affiche rien sans dépense réelle', () => {
    const { container } = render(<CustomerRealSpendCard spend={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('affiche total, addition moyenne, par couvert et dernière addition en euros', () => {
    render(<CustomerRealSpendCard spend={spend} />);

    expect(screen.getByRole('heading', { name: 'Dépense réelle' })).toBeInTheDocument();
    expect(screen.getByText(/^90,50\s€$/)).toBeInTheDocument();
    expect(screen.getByText(/^45,25\s€$/)).toBeInTheDocument();
    expect(screen.getByText(/^18,10\s€$/)).toBeInTheDocument();
    expect(screen.getByText(/^30,50\s€ · /)).toBeInTheDocument();
  });

  it('omet « Par couvert » quand il n’y a pas de couverts à diviser', () => {
    render(<CustomerRealSpendCard spend={{ ...spend, averagePerCover: null }} />);
    expect(screen.queryByText('Par couvert')).not.toBeInTheDocument();
  });
});

describe('ReservationAdditionLine', () => {
  it('n’affiche rien sans addition', () => {
    const { container } = render(
      <dl>
        <ReservationAdditionLine addition={null} />
      </dl>,
    );
    expect(container.querySelector('dt')).toBeNull();
  });

  it('affiche le total, l’heure et la table de l’addition', () => {
    render(
      <dl>
        <ReservationAdditionLine
          addition={{ total: '70.00', at: '2026-11-08T20:15:00.000Z', table: '4' }}
        />
      </dl>,
    );

    expect(screen.getByText('Addition')).toBeInTheDocument();
    expect(screen.getByText(/^70,00\s€ · .+ · Table 4$/)).toBeInTheDocument();
  });

  it('n’écrit pas « Table Table » quand le libellé de caisse porte déjà le mot', () => {
    render(
      <dl>
        <ReservationAdditionLine
          addition={{ total: '70.00', at: '2026-11-08T20:15:00.000Z', table: 'Table 12' }}
        />
      </dl>,
    );

    expect(screen.getByText(/· Table 12$/)).toBeInTheDocument();
    expect(screen.queryByText(/Table Table/)).not.toBeInTheDocument();
  });

  it('omet la table quand le ticket n’en porte pas', () => {
    render(
      <dl>
        <ReservationAdditionLine
          addition={{ total: '12.00', at: '2026-11-08T20:15:00.000Z', table: null }}
        />
      </dl>,
    );
    expect(screen.getByText(/^12,00\s€ · [^·]+$/)).toBeInTheDocument();
  });
});

describe('tableLabel', () => {
  it('préfixe « Table » aux numéros seuls et garde les libellés déjà nommés', () => {
    expect(tableLabel('12')).toBe('Table 12');
    expect(tableLabel('Table 12')).toBe('Table 12');
    expect(tableLabel('Terrasse')).toBe('Terrasse');
  });
});

describe('useReservationAddition', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.get.mockResolvedValue({
      data: { total: '70.00', at: '2026-11-08T20:15:00.000Z', table: '4' },
    });
  });

  it('n’appelle pas l’API sans droit pos.connect', () => {
    const { result } = renderHook(() => useReservationAddition('res-1', false));

    expect(mocks.get).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('lit l’addition de la réservation quand le droit est présent', async () => {
    const { result } = renderHook(() => useReservationAddition('res-1', true));

    await waitFor(() => expect(result.current).toMatchObject({ total: '70.00', table: '4' }));
    expect(mocks.get).toHaveBeenCalledWith('reservations/res-1/addition');
  });
});

describe('formatEuro', () => {
  it('formate les montants Decimal en euros français', () => {
    expect(formatEuro('1234.5')).toMatch(/^1\s234,50\s€$/);
  });
});
