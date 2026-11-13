import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getVisibleOnboardingState, ONBOARDING_TASK_KEYS } from './types';
import type { OnboardingState, OnboardingStep, OnboardingTaskKey } from './types';
import { OnboardingWizard } from './onboarding-wizard';

const mocks = vi.hoisted(() => ({
  state: null as OnboardingState | null,
  updateTask: vi.fn(),
  Step: () => null,
}));

vi.mock('./onboarding-provider', () => ({
  useOnboarding: () => ({ state: mocks.state, error: '', updateTask: mocks.updateTask }),
}));

vi.mock('./steps', () => ({
  STEP_COMPONENTS: new Proxy({}, { get: () => mocks.Step }),
}));

function createState(): OnboardingState {
  const keys: OnboardingTaskKey[] = [
    'restaurant',
    'hours',
    'floor',
    'knowledge',
    'phone',
    'channels',
    'connect-identity',
    'connect-location',
    'connect-cuisine',
    'connect-activation',
  ];
  const steps = keys.map((key, index) => {
    const status = key === 'restaurant' || key === 'hours' ? 'completed' : 'pending';
    return {
      key,
      title: key,
      description: '',
      required: false,
      group: index < 6 ? 'voice' : 'connect',
      index: index < 6 ? index + 1 : index - 5,
      status,
      state: { status },
    } as OnboardingStep;
  });

  return {
    onboardingDone: false,
    voiceOnboardingDone: false,
    connectOnboardingDone: false,
    minimumViableDone: false,
    onboardingCompletedAt: null,
    onboardingActivatedAt: null,
    onboardingLastSeenAt: null,
    firstCallAt: null,
    currentStep: steps[2],
    completedCount: 2,
    totalCount: 10,
    progress: 20,
    voiceProgress: 33,
    connectProgress: 0,
    steps,
    defaultHours: {},
    restaurant: {
      id: 'restaurant-1',
      name: 'Chez Suppernote',
      managerPhone: '',
      managerEmail: '',
      phoneNumber: '',
      phoneAssigned: false,
      openingHours: {},
      personality: null,
    },
  };
}

const SOCLE: OnboardingTaskKey[] = ['restaurant', 'hours', 'floor'];

function withCompleted(keys: OnboardingTaskKey[]) {
  const state = createState();
  state.steps = state.steps.map((step) => {
    const status = keys.includes(step.key) ? 'completed' : 'pending';
    return { ...step, status, state: { status } };
  });
  return state;
}

function EmptyStep() {
  return null;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/onboarding');
  vi.clearAllMocks();
  mocks.state = createState();
  mocks.Step = EmptyStep;
});

afterEach(() => {
  window.history.replaceState(null, '', '/onboarding');
  vi.unstubAllEnvs();
});

it('ouvre un lien Connect en production sans démarrer une autre étape', () => {
  mocks.state = withCompleted(SOCLE);
  vi.stubEnv('NODE_ENV', 'production');
  window.history.replaceState(null, '', '/onboarding?step=connect-identity');
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Votre page' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  expect(mocks.updateTask).toHaveBeenCalledWith('start', 'connect-identity');
  expect(mocks.updateTask).not.toHaveBeenCalledWith('start', 'floor');
});

it('garde l’étape affichée dans l’adresse pour la retrouver au rechargement', async () => {
  window.history.replaceState(null, '', '/onboarding?step=hours&utm_source=email');
  render(<OnboardingWizard />);
  expect(new URLSearchParams(window.location.search).get('step')).toBe('hours');

  fireEvent.click(screen.getByRole('button', { name: 'Salle et règles' }));
  await waitFor(() => {
    expect(new URLSearchParams(window.location.search).get('step')).toBe('floor');
  });
  expect(new URLSearchParams(window.location.search).get('utm_source')).toBe('email');
  expect(window.location.pathname).toBe('/onboarding');
});

it('remonte les étapes une à une avec le bouton Retour du navigateur', async () => {
  window.history.replaceState(null, '', '/onboarding?step=restaurant');
  render(<OnboardingWizard />);
  const lengthBefore = window.history.length;

  fireEvent.click(screen.getByRole('button', { name: 'Vos horaires' }));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('hours'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Salle et règles' }));
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('floor'),
  );
  expect(window.history.length).toBe(lengthBefore + 2);

  window.history.back();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Vos horaires' })).toHaveAttribute(
      'aria-current',
      'step',
    ),
  );
  expect(new URLSearchParams(window.location.search).get('step')).toBe('hours');

  window.history.back();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Votre restaurant' })).toHaveAttribute(
      'aria-current',
      'step',
    ),
  );

  window.history.forward();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Vos horaires' })).toHaveAttribute(
      'aria-current',
      'step',
    ),
  );
  // Revenir en arrière n'ajoute pas d'entrée : l'historique « Suivant » reste intact.
  expect(window.history.length).toBe(lengthBefore + 2);
});

it('n’ajoute pas d’entrée d’historique pour l’étape d’arrivée', async () => {
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=channels');
  const lengthBefore = window.history.length;
  render(<OnboardingWizard />);
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('connect-identity'),
  );
  expect(window.history.length).toBe(lengthBefore);
});

it('écrit l’étape de reprise dans une adresse sans paramètre', async () => {
  render(<OnboardingWizard />);
  await waitFor(() => {
    expect(new URLSearchParams(window.location.search).get('step')).toBe('floor');
  });
});

it('remplace un ancien nom d’étape par son nom actuel', async () => {
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=channels');
  render(<OnboardingWizard />);
  await waitFor(() => {
    expect(new URLSearchParams(window.location.search).get('step')).toBe('connect-identity');
  });
});

it('accepte le lien historique channels dans le parcours Connect', () => {
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=channels');
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Votre page' })).toHaveAttribute(
    'aria-current',
    'step',
  );
});

it('ignore un paramètre d’étape inconnu et reprend le parcours', () => {
  window.history.replaceState(null, '', '/onboarding?step=unknown');
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Salle et règles' })).toHaveAttribute(
    'aria-current',
    'step',
  );
});

it('garde le point actif quand l’étape courante est déjà marquée terminée', () => {
  render(<OnboardingWizard />);
  const hours = screen.getByRole('button', { name: 'Vos horaires' });
  fireEvent.click(hours);

  expect(hours).toHaveAttribute('aria-current', 'step');
  expect(screen.queryByText('Étape 2 sur 5')).not.toBeInTheDocument();
  expect(
    screen.getByText('Réglez chaque service une fois : le choix s’applique aux jours ouverts.'),
  ).toBeInTheDocument();
});

it('termine le parcours téléphone par les appels sans finalisation intermédiaire', () => {
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=phone');
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Appels' })).toHaveAttribute('aria-current', 'step');
  expect(screen.getByRole('heading', { name: 'Votre accueil au téléphone' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Finalisation' })).not.toBeInTheDocument();
});

it('n’affiche que les étapes de la salle tant qu’elle n’est pas prête', () => {
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Salle et règles' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Consignes & démo' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Votre page' })).not.toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Vos canaux' })).toBeInTheDocument();
});

it('ouvre l’écran des canaux une fois la salle prête, sans démarrer de tâche', async () => {
  mocks.state = withCompleted(SOCLE);
  render(<OnboardingWizard />);
  expect(screen.getByRole('heading', { name: 'Choisissez vos canaux' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Configurer : Téléphone' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Configurer : En ligne' })).toBeInTheDocument();
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('canaux'),
  );
  expect(mocks.updateTask).not.toHaveBeenCalled();
});

it('laisse le restaurateur commencer par la réservation en ligne', () => {
  mocks.state = withCompleted(SOCLE);
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Configurer : En ligne' }));
  expect(screen.getByRole('button', { name: 'Votre page' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  expect(mocks.updateTask).toHaveBeenCalledWith('start', 'connect-identity');
  expect(screen.getByRole('button', { name: 'Vos canaux' })).toBeInTheDocument();
});

it('revient aux canaux à la fin de la salle plutôt que d’enchaîner sur le téléphone', async () => {
  function FinishingStep({ onComplete }: { onComplete: (next: OnboardingTaskKey | null) => void }) {
    return (
      <button type="button" onClick={() => onComplete('knowledge')}>
        Terminer l’étape
      </button>
    );
  }
  mocks.Step = FinishingStep as unknown as () => null;
  // Comme dans l'app : l'étape enregistre sa complétion avant d'appeler `onComplete`.
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=floor');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Terminer l’étape' }));
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Choisissez vos canaux' })).toBeInTheDocument(),
  );
  expect(mocks.updateTask).not.toHaveBeenCalledWith('start', 'knowledge');
});

it.each(['knowledge', 'connect-identity', 'canaux'])(
  'renvoie vers la salle un lien %s tant qu’elle n’est pas prête',
  async (step) => {
    window.history.replaceState(null, '', `/onboarding?step=${step}`);
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: 'Salle et règles' })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.queryByRole('button', { name: 'Votre page' })).not.toBeInTheDocument();
    expect(mocks.updateTask).toHaveBeenCalledWith('start', 'floor');
    expect(mocks.updateTask).not.toHaveBeenCalledWith('start', step);
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('step')).toBe('floor'),
    );
  },
);

it('remplace l’adresse sans entrée d’historique quand une étape fermée renvoie à la salle', async () => {
  function LinkingStep({ onNavigate }: { onNavigate: (step: OnboardingTaskKey) => void }) {
    return (
      <button type="button" onClick={() => onNavigate('connect-identity')}>
        Ouvrir votre page
      </button>
    );
  }
  mocks.Step = LinkingStep as unknown as () => null;
  window.history.replaceState(null, '', '/onboarding?step=hours');
  render(<OnboardingWizard />);
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('hours'),
  );
  const lengthBefore = window.history.length;

  fireEvent.click(screen.getByRole('button', { name: 'Ouvrir votre page' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Salle et règles' })).toHaveAttribute(
      'aria-current',
      'step',
    ),
  );
  expect(new URLSearchParams(window.location.search).get('step')).toBe('floor');
  expect(window.history.length).toBe(lengthBefore);
});

it('reprend un canal commencé plutôt que l’écran des canaux', () => {
  mocks.state = withCompleted(['restaurant', 'hours', 'floor', 'knowledge']);
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Appels' })).toHaveAttribute('aria-current', 'step');
});

it('ramène aux canaux depuis la première étape d’un canal et via le lien direct', () => {
  mocks.state = withCompleted(SOCLE);
  mocks.state.restaurant.phoneAssigned = true;
  window.history.replaceState(null, '', '/onboarding?step=knowledge');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getAllByRole('button', { name: /Vos canaux/ })[0]);
  expect(screen.getByRole('heading', { name: 'Choisissez vos canaux' })).toBeInTheDocument();
  expect(screen.getByText(/Activez vos deux canaux/)).toBeInTheDocument();
});

it('ne bloque pas les anciens comptes sur la tâche channels', () => {
  const state = createState();
  state.steps = state.steps.map((step) => ({
    ...step,
    status: step.group === 'voice' && step.key !== 'channels' ? 'completed' : 'pending',
  }));
  state.currentStep = state.steps.find((step) => step.key === 'channels')!;
  const visible = getVisibleOnboardingState(state);
  expect(visible.steps).toHaveLength(7);
  expect(visible.totalCount).toBe(7);
  expect(visible.voiceOnboardingDone).toBe(true);
  expect(visible.voiceProgress).toBe(100);
  expect(visible.currentStep.key).toBe('connect-identity');
});

it('réserve la finalisation à la dernière étape de Suppernote Connect', () => {
  mocks.state = getVisibleOnboardingState(createState());
  mocks.state.currentStep = mocks.state.steps.find((step) => step.key === 'connect-activation')!;
  mocks.state.steps = mocks.state.steps.map((step) => ({
    ...step,
    status: step.key === 'connect-activation' ? 'current' : 'completed',
  }));
  render(<OnboardingWizard />);
  expect(screen.getByRole('button', { name: 'Règles et diffusion' })).toHaveAttribute(
    'aria-current',
    'step',
  );
  expect(screen.queryByText('Étape 2 sur 2')).not.toBeInTheDocument();
});

it.each(['connect-location', 'connect-cuisine'])(
  'ouvre l’éditeur depuis l’ancien lien %s',
  (step) => {
    mocks.state = withCompleted(SOCLE);
    window.history.replaceState(null, '', `/onboarding?step=${step}`);
    render(<OnboardingWizard />);
    expect(screen.getByRole('button', { name: 'Votre page' })).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(screen.queryByRole('button', { name: 'Votre adresse' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cuisine et ambiance' })).not.toBeInTheDocument();
    expect(screen.queryByText('Étape 1 sur 2')).not.toBeInTheDocument();
  },
);
it('termine Connect sans les anciennes tâches adresse et cuisine', () => {
  const state = createState();
  state.steps = state.steps.map((step) => ({
    ...step,
    status: ['connect-identity', 'connect-activation'].includes(step.key) ? 'completed' : 'pending',
  }));
  state.currentStep = state.steps.find((step) => step.key === 'connect-location')!;
  const visible = getVisibleOnboardingState(state);
  expect(visible.connectOnboardingDone).toBe(true);
  expect(visible.connectProgress).toBe(100);
  expect(visible.steps.map((step) => step.key)).not.toContain('connect-location');
});

it('transmet l’attribution du numéro Suppernote à l’écran des canaux', () => {
  mocks.state = withCompleted(SOCLE);
  render(<OnboardingWizard />);
  expect(screen.getByText('Numéro Suppernote en cours d’attribution')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Configurer : Téléphone' })).toBeEnabled();
});

// ─── Formule : proposée une fois, juste après l'appel test ───────────────────────────────────────

const PHONE_DONE: OnboardingTaskKey[] = [...SOCLE, 'knowledge', 'phone'];

function FinishingPhoneStep({
  onComplete,
}: {
  onComplete: (next: OnboardingTaskKey | null) => void;
}) {
  return (
    <button type="button" onClick={() => onComplete(null)}>
      Terminer l’appel test
    </button>
  );
}

it('propose la formule juste après la fin du téléphone', async () => {
  mocks.Step = FinishingPhoneStep as unknown as () => null;
  mocks.state = withCompleted(PHONE_DONE);
  window.history.replaceState(null, '', '/onboarding?step=phone');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Terminer l’appel test' }));

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Choisissez votre formule' })).toBeInTheDocument(),
  );
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('formule'),
  );
});

it('ne repropose pas la formule à qui a choisi « Plus tard »', async () => {
  window.localStorage.setItem('sokar:onboarding:plan-dismissed:restaurant-1', '1');
  mocks.Step = FinishingPhoneStep as unknown as () => null;
  mocks.state = withCompleted(PHONE_DONE);
  window.history.replaceState(null, '', '/onboarding?step=phone');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Terminer l’appel test' }));

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Choisissez vos canaux' })).toBeInTheDocument(),
  );
  window.localStorage.removeItem('sokar:onboarding:plan-dismissed:restaurant-1');
});

it('ne propose pas la formule à la fin d’une étape qui n’est pas la dernière du téléphone', async () => {
  mocks.Step = FinishingPhoneStep as unknown as () => null;
  mocks.state = withCompleted(SOCLE);
  window.history.replaceState(null, '', '/onboarding?step=knowledge');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Terminer l’appel test' }));

  await waitFor(() =>
    expect(
      screen.queryByRole('heading', { name: 'Choisissez votre formule' }),
    ).not.toBeInTheDocument(),
  );
});

it('ne propose pas la formule à la fin du canal en ligne', async () => {
  mocks.Step = FinishingPhoneStep as unknown as () => null;
  mocks.state = withCompleted([...SOCLE, 'connect-activation']);
  window.history.replaceState(null, '', '/onboarding?step=connect-identity');
  render(<OnboardingWizard />);
  fireEvent.click(screen.getByRole('button', { name: 'Terminer l’appel test' }));

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Choisissez vos canaux' })).toBeInTheDocument(),
  );
});

it('rouvre l’écran de formule par son adresse, mais pas avant que la salle soit prête', async () => {
  mocks.state = withCompleted(PHONE_DONE);
  window.history.replaceState(null, '', '/onboarding?step=formule');
  const { unmount } = render(<OnboardingWizard />);
  expect(screen.getByRole('heading', { name: 'Choisissez votre formule' })).toBeInTheDocument();
  unmount();

  mocks.state = createState();
  window.history.replaceState(null, '', '/onboarding?step=formule');
  render(<OnboardingWizard />);
  expect(
    screen.queryByRole('heading', { name: 'Choisissez votre formule' }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(new URLSearchParams(window.location.search).get('step')).toBe('floor'),
  );
});

it('confirme le paiement au retour de Stripe, sur l’écran des canaux', () => {
  mocks.state = withCompleted(PHONE_DONE);
  window.history.replaceState(
    null,
    '',
    '/onboarding?step=canaux&billing=success&session_id=cs_test_123',
  );
  window.localStorage.setItem(
    'sokar:onboarding:plan-choice',
    JSON.stringify({ plan: 'pro', billing: 'annual' }),
  );
  render(<OnboardingWizard />);

  expect(screen.getByText('Merci, votre paiement a bien été pris en compte.')).toBeInTheDocument();
  expect(window.localStorage.getItem('sokar:onboarding:plan-choice')).toBeNull();
});
