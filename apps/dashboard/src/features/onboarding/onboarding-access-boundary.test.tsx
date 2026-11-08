import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { OnboardingAccessBoundary } from './onboarding-access-boundary';
import { ONBOARDING_TASK_KEYS, type OnboardingState, type OnboardingStatus } from './types';
import { readStoredPlanChoice } from './pending-plan';

const mocks = vi.hoisted(() => ({
  state: null as OnboardingState | null,
  loading: false,
  refresh: vi.fn(),
  pathname: '/dashboard',
  replace: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  usePathname: () => mocks.pathname,
  useRouter: () => ({ replace: mocks.replace }),
}));
vi.mock('./onboarding-provider', () => ({ useOnboarding: () => mocks }));

function stateWith(status: OnboardingStatus): OnboardingState {
  return {
    voiceOnboardingDone: true,
    connectOnboardingDone: true,
    steps: ONBOARDING_TASK_KEYS.map((key) => ({ key, status })),
  } as OnboardingState;
}
function mount(enforceAccess = true) {
  return render(
    <OnboardingAccessBoundary
      enforceAccess={enforceAccess}
      onboarding={<p>Parcours de configuration</p>}
    >
      <p>Réservations accessibles</p>
    </OnboardingAccessBoundary>,
  );
}
beforeEach(() => {
  mocks.state = stateWith('pending');
  mocks.loading = false;
  mocks.pathname = '/dashboard';
  vi.clearAllMocks();
});
it('ne monte pas les fonctionnalités même si les indicateurs globaux annoncent une complétion', () => {
  mount();
  expect(screen.queryByText('Réservations accessibles')).not.toBeInTheDocument();
  expect(screen.getByText('Parcours de configuration')).toBeInTheDocument();
});
it.each(['skipped', 'blocked', 'current'] as const)('refuse une étape %s', (status) => {
  mocks.state = stateWith('completed');
  mocks.state.steps[4].status = status;
  mount();
  expect(screen.queryByText('Réservations accessibles')).not.toBeInTheDocument();
});
it('refuse une étape absente', () => {
  mocks.state = stateWith('completed');
  mocks.state.steps.pop();
  mount();
  expect(screen.queryByText('Réservations accessibles')).not.toBeInTheDocument();
});
it('laisse accéder au dashboard de prévisualisation sans vérifier un onboarding inexistant', () => {
  mount(false);
  expect(screen.getByText('Réservations accessibles')).toBeInTheDocument();
  expect(screen.queryByText('Parcours de configuration')).not.toBeInTheDocument();
  expect(mocks.replace).not.toHaveBeenCalled();
});
it('déverrouille immédiatement quand les dix étapes sont terminées', () => {
  const view = mount();
  mocks.state = stateWith('completed');
  view.rerender(
    <OnboardingAccessBoundary onboarding={<p>Parcours de configuration</p>}>
      <p>Réservations accessibles</p>
    </OnboardingAccessBoundary>,
  );
  expect(screen.getByText('Réservations accessibles')).toBeInTheDocument();
  expect(screen.queryByText('Parcours de configuration')).not.toBeInTheDocument();
});
it('attend la vérification même avec un ancien état complet', () => {
  mocks.state = stateWith('completed');
  mocks.loading = true;
  mount();
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(screen.queryByText('Réservations accessibles')).not.toBeInTheDocument();
});
it('reste fermé et propose une nouvelle tentative si l’état est indisponible', () => {
  mocks.state = null;
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
  expect(mocks.refresh).toHaveBeenCalled();
  expect(screen.queryByText('Réservations accessibles')).not.toBeInTheDocument();
});

it('redirige un dashboard incomplet vers la route onboarding', async () => {
  mocks.pathname = '/dashboard/reservations';
  mount();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/onboarding'));
});
it('ouvre le dashboard du restaurant de test sans valider ses étapes', () => {
  mocks.state = stateWith('pending');
  mocks.state.restaurant = {
    id: 'org_3ITQ1oVrrbAPwz0xJKAq084CBAc',
  } as OnboardingState['restaurant'];
  mount();
  expect(screen.getByText('Réservations accessibles')).toBeInTheDocument();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(mocks.state.steps.every((step) => step.status === 'pending')).toBe(true);
});
it('retourne au dashboard une fois toutes les étapes validées', async () => {
  mocks.state = stateWith('completed');
  mocks.pathname = '/onboarding';
  mount();
  await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith('/dashboard'));
});

it('garde la formule choisie sur la page Tarifs avant de renvoyer vers l’inscription', () => {
  window.localStorage.clear();
  window.history.replaceState(null, '', '/dashboard?subscribe_plan=essential&billing=monthly');
  mocks.state = stateWith('pending');
  mount();

  expect(mocks.replace).toHaveBeenCalledWith('/onboarding');
  expect(readStoredPlanChoice()).toEqual({ plan: 'essential', billing: 'monthly' });
  window.history.replaceState(null, '', '/');
  window.localStorage.clear();
});

function qualificationState() {
  const state = stateWith('pending');
  state.restaurant = { id: 'qualification-site' } as OnboardingState['restaurant'];
  for (const step of state.steps) {
    if (['restaurant', 'hours', 'floor'].includes(step.key)) step.status = 'completed';
  }
  return state;
}

function mountQualification(ids = ['qualification-site']) {
  return render(
    <OnboardingAccessBoundary
      crmQualificationRestaurantIds={ids}
      onboarding={<p>Parcours de configuration</p>}
    >
      <p>CRM accessible</p>
    </OnboardingAccessBoundary>,
  );
}

it.each(['/dashboard/customers', '/dashboard/customers/crm', '/dashboard/customers/crm/client'])(
  'ouvre uniquement le CRM qualifié après le socle : %s',
  (pathname) => {
    mocks.state = qualificationState();
    mocks.pathname = pathname;
    mountQualification();
    expect(screen.getByText('CRM accessible')).toBeInTheDocument();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.state.steps.find((step) => step.key === 'phone')?.status).toBe('pending');
  },
);

it.each(['/dashboard', '/dashboard/settings', '/dashboard/customers-other', '/dashboard/connect'])(
  'conserve le verrou hors du CRM : %s',
  (pathname) => {
    mocks.state = qualificationState();
    mocks.pathname = pathname;
    mountQualification();
    expect(screen.queryByText('CRM accessible')).not.toBeInTheDocument();
    expect(mocks.replace).toHaveBeenCalledWith('/onboarding');
  },
);

it.each([[], ['another-site'], ['*']])('refuse une qualification sans ID exact : %j', (...ids) => {
  mocks.state = qualificationState();
  mocks.pathname = '/dashboard/customers/crm';
  mountQualification(ids.flat());
  expect(screen.queryByText('CRM accessible')).not.toBeInTheDocument();
});

it.each(['pending', 'skipped', 'blocked', 'current'] as const)(
  'refuse un socle incomplet : %s',
  (status) => {
    mocks.state = qualificationState();
    mocks.state.steps.find((step) => step.key === 'floor')!.status = status;
    mocks.pathname = '/dashboard/customers/crm';
    mountQualification();
    expect(screen.queryByText('CRM accessible')).not.toBeInTheDocument();
  },
);

it('attend le chargement même sur le CRM qualifié', () => {
  mocks.state = qualificationState();
  mocks.pathname = '/dashboard/customers/crm';
  mocks.loading = true;
  mountQualification();
  expect(screen.queryByText('CRM accessible')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toBeInTheDocument();
});

it('referme le CRM si le restaurant courant sort de la liste', () => {
  mocks.state = qualificationState();
  mocks.pathname = '/dashboard/customers/crm';
  const view = mountQualification();
  mocks.state = { ...qualificationState(), restaurant: { id: 'another-site' } } as OnboardingState;
  view.rerender(
    <OnboardingAccessBoundary
      crmQualificationRestaurantIds={['qualification-site']}
      onboarding={<p>Parcours de configuration</p>}
    >
      <p>CRM accessible</p>
    </OnboardingAccessBoundary>,
  );
  expect(screen.queryByText('CRM accessible')).not.toBeInTheDocument();
});
