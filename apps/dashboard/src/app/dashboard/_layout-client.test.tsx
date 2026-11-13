import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/fr.json';
import { DashboardModeSwitcher, DashboardSidebar } from './_layout-client';
import { TooltipProvider } from '@/components/ui/tooltip';

const mocks = vi.hoisted(() => ({
  role: 'OWNER' as string | undefined,
  pathname: '/dashboard',
  searchParams: new URLSearchParams(),
}));
vi.mock('@/features/sites/site-context', () => ({
  useSiteSelection: () => ({ activeSite: { role: mocks.role } }),
}));
vi.mock('@/features/companion/CompanionPanel', () => ({
  CompanionPanel: () => <p>Panneau du Companion</p>,
}));
vi.mock('@/features/theme/dashboard-theme', () => ({
  DashboardThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useDashboardTheme: () => ({ theme: 'light', toggleTheme: vi.fn() }),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useSearchParams: () => mocks.searchParams,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

function switcherTree() {
  return (
    <NextIntlClientProvider locale="fr" messages={messages}>
      <DashboardModeSwitcher salleMode={false} />
    </NextIntlClientProvider>
  );
}

function renderSwitcher() {
  return render(switcherTree());
}

it('affiche les icônes en mode replié et permet de déployer le menu', () => {
  mocks.role = 'OWNER';
  const change = vi.fn();
  render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <TooltipProvider>
        <DashboardSidebar
          pathname="/dashboard"
          salleView="service-live"
          isPlatformOperator={false}
          onCreateOffer={vi.fn()}
          expanded={false}
          onExpandedChange={change}
        />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Déployer le menu' }));
  expect(change).toHaveBeenCalledWith(true);
  fireEvent.click(screen.getByRole('button', { name: 'Service' }));
  expect(change).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('link', { name: 'Réservations' })).not.toBeInTheDocument();
});

it('ferme le menu latéral au clic extérieur ou avec Échap, sans intercepter les actions', () => {
  mocks.role = 'OWNER';
  const outside = vi.fn();
  render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <TooltipProvider>
        <DashboardSidebar
          pathname="/dashboard"
          salleView="service-live"
          isPlatformOperator={false}
          onCreateOffer={vi.fn()}
        />
        <button onClick={outside}>Autre action</button>
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Service' });
  fireEvent.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  fireEvent.pointerDown(screen.getByRole('link', { name: 'Réservations' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const other = screen.getByRole('button', { name: 'Autre action' });
  fireEvent.pointerDown(other);
  fireEvent.click(other);
  expect(outside).toHaveBeenCalledOnce();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  fireEvent.click(trigger);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

it('déplie la section de la page active sans afficher les sections interdites au personnel', () => {
  mocks.role = 'OWNER';
  const { unmount } = render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <TooltipProvider>
        <DashboardSidebar
          pathname="/dashboard/reservations"
          salleView="service-live"
          isPlatformOperator={false}
          onCreateOffer={vi.fn()}
        />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Service' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('link', { name: 'Réservations' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  unmount();
  mocks.role = 'STAFF';
  render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <TooltipProvider>
        <DashboardSidebar
          pathname="/dashboard/reservations"
          salleView="service-live"
          isPlatformOperator={false}
          onCreateOffer={vi.fn()}
        />
      </TooltipProvider>
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole('link', { name: 'Réservations' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Marketing' })).not.toBeInTheDocument();
});

describe('DashboardModeSwitcher : Companion', () => {
  it('garde trois rubriques de même largeur et le menu des salles accessible', () => {
    mocks.role = 'OWNER';
    render(
      <NextIntlClientProvider locale="fr" messages={messages}>
        <DashboardModeSwitcher salleMode />
      </NextIntlClientProvider>,
    );

    const nav = screen.getByRole('navigation', { name: 'Espaces Suppernote' });
    for (const item of Array.from(nav.children)) expect(item).toHaveClass('flex-1');
    fireEvent.click(screen.getByRole('button', { name: 'Choisir un plan de salle' }));
    expect(screen.getByRole('listbox', { name: 'Plans de salle' })).toBeInTheDocument();
  });

  it.each(['STAFF', 'READ_ONLY'])('masque le bouton Companion pour le rôle %s', (role) => {
    mocks.role = role;
    renderSwitcher();

    expect(screen.queryByRole('button', { name: 'Companion' })).not.toBeInTheDocument();
  });

  it('ouvre le panneau Companion pour un responsable, et Échap le ferme', () => {
    mocks.role = 'OWNER';
    renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'Companion' }));
    expect(screen.getByRole('dialog', { name: 'Companion' })).toBeInTheDocument();
    expect(screen.getByText('Panneau du Companion')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Companion' })).not.toBeInTheDocument();
    // Fermé mais monté : une requête en cours n'est pas perdue.
    expect(screen.getByText('Panneau du Companion')).not.toBeVisible();
  });

  it('ferme le panneau Companion quand la page ou les paramètres changent', () => {
    mocks.role = 'OWNER';
    mocks.pathname = '/dashboard';
    mocks.searchParams = new URLSearchParams();
    const { rerender } = renderSwitcher();

    fireEvent.click(screen.getByRole('button', { name: 'Companion' }));
    expect(screen.getByRole('dialog', { name: 'Companion' })).toBeInTheDocument();

    mocks.pathname = '/dashboard/reservations';
    rerender(switcherTree());
    expect(screen.queryByRole('dialog', { name: 'Companion' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Companion' }));
    expect(screen.getByRole('dialog', { name: 'Companion' })).toBeInTheDocument();

    mocks.searchParams = new URLSearchParams({ date: '2026-10-30', reservation: 'res-1' });
    rerender(switcherTree());
    expect(screen.queryByRole('dialog', { name: 'Companion' })).not.toBeInTheDocument();
  });
});
