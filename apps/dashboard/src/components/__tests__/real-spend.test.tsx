import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  CustomerRealSpendCard,
  ReservationAdditionLine,
  formatEuro,
} from '@/components/pos/real-spend';

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

describe('formatEuro', () => {
  it('formate les montants Decimal en euros français', () => {
    expect(formatEuro('1234.5')).toMatch(/^1\s234,50\s€$/);
  });
});
