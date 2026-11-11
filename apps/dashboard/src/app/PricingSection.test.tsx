import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PricingSection from './PricingSection';

vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: { children: ReactNode; href: string }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

describe('PricingSection', () => {
  it('affiche un CTA pour chaque formule avec la cadence annuelle sélectionnée', () => {
    render(<PricingSection />);

    expect(screen.getByText('179')).toBeInTheDocument();
    expect(screen.getAllByText('269')).toHaveLength(2);

    expect(screen.getByRole('link', { name: 'Choisir Essential' })).toHaveAttribute(
      'href',
      '/register?plan=essential&billing=annual',
    );
    expect(screen.getByRole('link', { name: 'Choisir Pro' })).toHaveAttribute(
      'href',
      '/register?plan=pro&billing=annual',
    );
    expect(screen.getByRole('link', { name: 'Choisir Multi-restaurant' })).toHaveAttribute(
      'href',
      '/register?plan=multi-site&billing=annual&sites=2',
    );
  });

  it('met à jour la cadence transmise quand le visiteur passe au mensuel', () => {
    render(<PricingSection />);

    fireEvent.click(screen.getByRole('switch'));

    expect(screen.getByRole('link', { name: 'Choisir Pro' })).toHaveAttribute(
      'href',
      '/register?plan=pro&billing=monthly',
    );
    expect(screen.getByRole('link', { name: 'Choisir Multi-restaurant' })).toHaveAttribute(
      'href',
      '/register?plan=multi-site&billing=monthly&sites=2',
    );
  });

  it('affiche les montants avec une espace insécable et le prix par site du Multi-restaurant', () => {
    const { container } = render(<PricingSection />);
    const text = container.textContent ?? '';

    expect(text).toContain('+ 89\u00a0€/site par adresse supplémentaire');
    expect(text).not.toContain('HT');
    expect(text).not.toContain('Économisez');
  });

  it('précise le paiement annuel et distingue le mensuel', () => {
    render(<PricingSection />);
    expect(screen.queryByText(/Équivalents mensuels arrondis/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Engagement 12 mois')).toHaveLength(3);
    expect(
      screen.queryByText('Plus aucune réservation perdue, même en plein service.'),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.queryByText(/engagement 12 mois/i)).not.toBeInTheDocument();
    expect(screen.getAllByText('Sans engagement')).toHaveLength(3);
  });

  it('calcule le total multi-site et transmet le nombre sélectionné', () => {
    render(<PricingSection />);
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.change(screen.getByLabelText('Nombre d’établissements'), { target: { value: '3' } });
    expect(screen.getByText(/Total pour 3 établissements : 497/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Choisir Multi-restaurant' })).toHaveAttribute(
      'href',
      '/register?plan=multi-site&billing=monthly&sites=3',
    );
    fireEvent.click(screen.getByRole('switch'));
    expect(screen.getByText(/Total pour 3 établissements : 447/)).toBeInTheDocument();
    expect(screen.queryByText(/,\d{2}.*€\/mois/)).not.toBeInTheDocument();
  });

  it('masque le prix barré et les économies en mensuel', () => {
    const { container } = render(<PricingSection />);

    fireEvent.click(screen.getByRole('switch'));

    const text = container.textContent ?? '';
    expect(screen.getAllByText('299')[0]).toBeInTheDocument();
    expect(text).toContain('+ 99\u00a0€/site');
    expect(text).not.toContain('Économisez');
    expect(text).not.toContain('-10% annuel');
  });

  it('ne marque que le non livré, d’un simple « Bientôt »', () => {
    render(<PricingSection />);

    expect(screen.queryByText('Disponible')).not.toBeInTheDocument();
    expect(screen.queryByText('Prévu')).not.toBeInTheDocument();
    expect(screen.getAllByText('Bientôt').length).toBeGreaterThan(0);
  });

  it('ne présente aucune formule comme « Recommandé »', () => {
    render(<PricingSection />);

    expect(screen.queryByText('Recommandé')).not.toBeInTheDocument();
  });
});
