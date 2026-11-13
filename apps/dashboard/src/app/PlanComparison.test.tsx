import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import PlanComparison from './PlanComparison';
import { CATALOG_FEATURES } from './pricing-catalog';

function rowFor(label: string): HTMLElement {
  const table = screen.getByRole('table');
  const row = within(table).getByRole('rowheader', { name: label }).closest('tr');
  if (!row) throw new Error(`Ligne introuvable : ${label}`);
  return row;
}

describe('PlanComparison', () => {
  it('présente les trois formules et chaque fonctionnalité du catalogue', () => {
    render(<PlanComparison />);
    const table = screen.getByRole('table');

    for (const name of ['Essential', 'Pro', 'Multi-restaurant']) {
      expect(within(table).getByRole('columnheader', { name })).toBeInTheDocument();
    }
    for (const feature of CATALOG_FEATURES) {
      expect(within(table).getByRole('rowheader', { name: feature.label })).toBeInTheDocument();
    }
  });

  it('marque disponible une intégration livrée, incluse à partir de Pro', () => {
    render(<PlanComparison />);
    const row = rowFor('Synchronisation ZenChef, TheFork, Lightspeed');

    expect(within(row).getAllByText('Inclus')).toHaveLength(2);
    expect(within(row).getByText('Non inclus')).toBeInTheDocument();
    expect(within(row).queryByText('Bientôt')).not.toBeInTheDocument();
  });

  it('marque disponible une fonctionnalité livrée, incluse dans les trois formules', () => {
    render(<PlanComparison />);
    const row = rowFor('Rapport quotidien des appels');

    expect(within(row).getAllByText('Inclus')).toHaveLength(3);
    expect(within(row).queryByText('Non inclus')).not.toBeInTheDocument();
    expect(within(row).queryByText('Bientôt')).not.toBeInTheDocument();
  });

  it('réserve les fonctionnalités Multi-restaurant à la formule Multi-restaurant', () => {
    render(<PlanComparison />);
    const row = rowFor('Facturation groupée');

    expect(within(row).getAllByText('Non inclus')).toHaveLength(2);
    expect(within(row).getByText('Inclus')).toBeInTheDocument();
  });
});
