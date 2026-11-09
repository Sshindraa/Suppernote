import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SectionTabs } from '../SectionTabs';

const pathnameState = vi.hoisted(() => ({ value: '/dashboard' }));
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));

const roleState = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock('@/features/sites/site-context', () => ({
  useSiteSelection: () => ({
    activeSite: roleState.value ? { id: 'site', role: roleState.value } : undefined,
  }),
}));

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => {
    const map: Record<string, string> = {
      service: 'Service',
      reservations: 'Réservations',
      briefing: 'Briefing',
      calls: 'Appels',
      floorPlan: 'Salle',
      customers: 'Clients',
      loyalty: 'Fidélité',
      reactivation: 'Réactivation',
      growth: 'Marketing',
      marketing: 'Campagnes',
      reputation: 'Avis',
      offers: 'Offres',
      experiences: 'Expériences',
      events: 'Événements',
      giftCards: 'Cartes cadeaux',
      channels: 'Canaux',
    };
    return map[key] ?? key;
  },
}));

function tabLabels() {
  return screen
    .getAllByRole('link')
    .filter((link) => link.closest('nav'))
    .map((link) => link.textContent);
}

describe('SectionTabs', () => {
  beforeEach(() => {
    pathnameState.value = '/dashboard';
    roleState.value = undefined;
  });

  it('affiche les onglets de la section et marque la page courante', () => {
    pathnameState.value = '/dashboard/calls';
    render(<SectionTabs />);

    expect(screen.getByRole('navigation', { name: 'Service' })).toBeInTheDocument();
    expect(tabLabels()).toEqual(['Réservations', 'Briefing', 'Appels']);
    expect(screen.getByRole('link', { name: 'Appels' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Briefing' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Briefing' })).toHaveAttribute(
      'href',
      '/dashboard/briefing',
    );
  });

  it("garde l'onglet Campagnes actif sur une sous-page de marketing", () => {
    pathnameState.value = '/dashboard/marketing/segments';
    render(<SectionTabs />);

    expect(screen.getByRole('navigation', { name: 'Marketing' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Campagnes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Avis' })).not.toHaveAttribute('aria-current');
  });

  it('garde Cartes cadeaux actif sur les packs cadeaux', () => {
    pathnameState.value = '/dashboard/gift-card-packs';
    render(<SectionTabs />);

    expect(tabLabels()).toEqual(['Expériences', 'Événements', 'Cartes cadeaux']);
    expect(screen.getByRole('link', { name: 'Cartes cadeaux' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it("n'affiche rien sur la Salle ni sur Pilotage", () => {
    pathnameState.value = '/dashboard/floor-plan';
    const salle = render(<SectionTabs />);
    expect(salle.container).toBeEmptyDOMElement();
    salle.unmount();

    pathnameState.value = '/dashboard';
    const pilotage = render(<SectionTabs />);
    expect(pilotage.container).toBeEmptyDOMElement();
  });

  it("ne montre à l'équipe de service que les onglets qu'elle peut ouvrir", () => {
    pathnameState.value = '/dashboard/reservations';
    roleState.value = 'STAFF';
    render(<SectionTabs />);

    expect(tabLabels()).toEqual(['Réservations', 'Briefing']);
    expect(screen.queryByRole('link', { name: 'Appels' })).not.toBeInTheDocument();
  });
});
