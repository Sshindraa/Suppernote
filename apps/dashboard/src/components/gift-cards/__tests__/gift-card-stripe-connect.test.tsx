import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GiftCardStripeConnect } from '../gift-card-stripe-connect';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  initialize: vi.fn(),
  logout: vi.fn(),
  update: vi.fn(),
  reverify: vi.fn(),
}));
vi.mock('@clerk/nextjs', () => ({
  useReverification: (fetcher: (...args: unknown[]) => Promise<unknown>) => mocks.reverify(fetcher),
}));
vi.mock('@/lib/api', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post, orgId: 'restaurant' }),
}));
vi.mock('@stripe/connect-js/pure', () => ({ loadConnectAndInitialize: mocks.initialize }));
vi.mock('@stripe/react-connect-js', () => ({
  ConnectComponentsProvider: ({ children }: { children: React.ReactNode }) => children,
  ConnectAccountOnboarding: ({
    onExit,
    onLoadError,
  }: {
    onExit: () => void;
    onLoadError: () => void;
  }) => (
    <div aria-label="Formulaire Stripe intégré">
      <button onClick={onExit}>Terminer le formulaire</button>
      <button onClick={onLoadError}>Simuler une erreur Stripe</button>
    </div>
  ),
}));

describe('embedded gift card onboarding', () => {
  it('uses Clerk reverification for an existing managed account', async () => {
    vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', 'pk_test_placeholder');
    vi.stubEnv('NEXT_PUBLIC_DEMO_STAGING', '');
    mocks.get.mockResolvedValue({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      canConfigure: true,
      managedTest: true,
    });
    mocks.post.mockResolvedValue({ clientSecret: 'mock', publishableKey: 'pk_test' });
    mocks.reverify.mockImplementation((fetcher) => fetcher);
    try {
      render(<GiftCardStripeConnect />);
      fireEvent.click(await screen.findByRole('button', { name: 'Gérer Stripe' }));
      await screen.findByLabelText('Formulaire Stripe intégré');
      expect(mocks.reverify).toHaveBeenCalled();
      expect(mocks.post).toHaveBeenCalledWith(
        'restaurants/restaurant/gift-cards/stripe-connect/session',
        {},
        expect.objectContaining({ allowReverificationHint: true }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('asks for explicit consent before creating a sandbox account token', async () => {
    mocks.get.mockResolvedValue({
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      canConfigure: true,
      managedTestPublishableKey: 'pk_test_example',
    });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ id: ['accttok', 'example'].join('_') }),
    } as Response);
    try {
      render(<GiftCardStripeConnect />);
      fireEvent.click(await screen.findByRole('button', { name: 'Configurer Stripe' }));
      const next = screen.getByRole('button', { name: 'Continuer' });
      expect(next).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(next);
      await screen.findByLabelText('Formulaire Stripe intégré');
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.stripe.com/v2/core/account_tokens',
        expect.objectContaining({ method: 'POST' }),
      );
      expect(mocks.post).toHaveBeenCalledWith(
        'restaurants/restaurant/gift-cards/stripe-connect/managed-test',
        { accountToken: ['accttok', 'example'].join('_') },
      );
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('distinguishes active payments from payouts still being verified', async () => {
    mocks.get.mockResolvedValue({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: false,
      canConfigure: true,
      onboardingState: 'verification_pending',
      actionItems: [],
    });
    render(<GiftCardStripeConnect />);
    await screen.findByText('Vérification en cours');
    expect(screen.getByText('Encaissements')).toBeInTheDocument();
    expect(screen.getByText('Versements')).toBeInTheDocument();
    expect(screen.getAllByText('Actifs')).toHaveLength(1);
    expect(screen.getByText('En attente')).toBeInTheDocument();
    expect(screen.queryByText('Stripe connecté')).not.toBeInTheDocument();
  });

  it('keeps correction requests actionable even when payments and payouts are enabled', async () => {
    mocks.get.mockResolvedValue({
      connected: true,
      chargesEnabled: true,
      payoutsEnabled: true,
      canConfigure: true,
      onboardingState: 'action_required',
      actionItems: ['Fournir ou corriger les justificatifs demandés'],
      deadline: '2026-10-08T12:00:00.000Z',
    });
    render(<GiftCardStripeConnect />);
    await screen.findByText('Action requise');
    expect(screen.getByText('Fournir ou corriger les justificatifs demandés')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Traiter les demandes Stripe' })).toBeInTheDocument();
    expect(screen.getByText(/08\/10\/2026/)).toBeInTheDocument();
  });

  it('refreshes visible pages automatically and does not poll hidden pages', async () => {
    mocks.get
      .mockResolvedValueOnce({
        connected: true,
        chargesEnabled: false,
        payoutsEnabled: false,
        canConfigure: true,
        onboardingState: 'verification_pending',
      })
      .mockResolvedValue({
        connected: true,
        chargesEnabled: true,
        payoutsEnabled: true,
        canConfigure: true,
        onboardingState: 'ready',
      });
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const { unmount } = render(<GiftCardStripeConnect />);
    try {
      await act(async () => {
        await Promise.resolve();
      });
      expect(mocks.get).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Vérification en cours')).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mocks.get).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Stripe connecté')).toBeInTheDocument();
      visibility.mockReturnValue('hidden');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(mocks.get).toHaveBeenCalledTimes(2);
      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(mocks.get).toHaveBeenCalledTimes(3);
    } finally {
      unmount();
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it('marks old data as unconfirmed after a refresh failure', async () => {
    render(<GiftCardStripeConnect />);
    await screen.findByText('Configuration à terminer');
    mocks.get.mockRejectedValueOnce(new Error('Statut indisponible'));
    fireEvent(window, new Event('focus'));
    await screen.findByRole('alert');
    expect(screen.getByText('Le statut Stripe n’a pas pu être actualisé.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
  });
  beforeEach(() => {
    document.documentElement.style.setProperty('--primary', '0 0% 6.7%');
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({
      connected: true,
      chargesEnabled: false,
      payoutsEnabled: false,
      canConfigure: true,
    });
    mocks.post.mockResolvedValue({ clientSecret: 'mock', publishableKey: 'pk_test' });
    mocks.logout.mockResolvedValue(undefined);
    mocks.initialize.mockReturnValue({ logout: mocks.logout, update: mocks.update });
  });

  it('repasse les couleurs à Stripe quand le thème change pendant la configuration', async () => {
    render(<GiftCardStripeConnect />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reprendre la configuration' }));
    await screen.findByLabelText('Formulaire Stripe intégré');
    const root = document.documentElement;
    root.style.setProperty('--background', '0 0% 100%');
    root.classList.add('light');
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith({
        appearance: expect.objectContaining({
          variables: expect.objectContaining({ colorBackground: 'hsl(0, 0%, 100%)' }),
        }),
      }),
    );
    root.classList.remove('light');
    root.style.removeProperty('--background');
  });

  it('opens inline in French, renews the session, then closes and refreshes without claiming activation', async () => {
    render(<GiftCardStripeConnect />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reprendre la configuration' }));
    await screen.findByLabelText('Formulaire Stripe intégré');
    expect(mocks.post).toHaveBeenCalledWith(
      'restaurants/restaurant/gift-cards/stripe-connect/session',
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const options = mocks.initialize.mock.calls[0][0];
    expect(options.locale).toBe('fr-FR');
    expect(options.appearance.variables.colorPrimary).toBe('hsl(0, 0%, 6.7%)');
    expect(await options.fetchClientSecret()).toBe('mock');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await options.fetchClientSecret();
    expect(mocks.post).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Terminer le formulaire' }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    expect(mocks.logout).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('Formulaire Stripe intégré')).not.toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Reprendre la configuration' }),
    ).toBeInTheDocument();
  });

  it('lets the owner retry a failed session request and close for later', async () => {
    mocks.post.mockRejectedValueOnce(new Error('Connexion interrompue'));
    render(<GiftCardStripeConnect />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reprendre la configuration' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connexion interrompue');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer la configuration' }));
    await screen.findByLabelText('Formulaire Stripe intégré');
    fireEvent.click(screen.getByRole('button', { name: 'Fermer et reprendre plus tard' }));
    expect(
      await screen.findByRole('button', { name: 'Reprendre la configuration' }),
    ).toBeInTheDocument();
  });

  it('exposes a retry when Stripe cannot load the form', async () => {
    render(<GiftCardStripeConnect />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reprendre la configuration' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Simuler une erreur Stripe' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('n’a pas pu être chargé');
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer la configuration' }));
    await screen.findByLabelText('Formulaire Stripe intégré');
    expect(mocks.initialize).toHaveBeenCalledTimes(2);
  });

  it('does not expose configuration to other roles', async () => {
    mocks.get.mockResolvedValue({
      connected: false,
      chargesEnabled: false,
      payoutsEnabled: false,
      canConfigure: false,
    });
    render(<GiftCardStripeConnect />);
    await screen.findByText('Le propriétaire de l’établissement doit terminer la configuration.');
    expect(
      screen.queryByRole('button', { name: 'Activer les encaissements' }),
    ).not.toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
