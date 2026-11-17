import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toApiError } from '@/lib/api-error';
import SettingsPage from './page';

const mocks = vi.hoisted(() => ({
  orgId: 'org_test',
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));

vi.mock('@/lib/api', () => ({ useApi: () => mocks }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('@/features/onboarding/onboarding-guard', () => ({ OnboardingLockBanner: () => null }));
vi.mock('@/features/sites/site-management-card', () => ({ SiteManagementCard: () => null }));
vi.mock('@/features/team/team-card', () => ({ TeamCard: () => null }));
vi.mock('@/features/billing/trial', () => ({ TrialRecap: () => null, TrialTrack: () => null }));
vi.mock('@/features/sites/site-context', () => ({
  useSiteSelection: () => ({ accountId: null, activeSite: null }),
}));

const RESTAURANT = {
  id: 'org_test',
  name: 'Le Bistrot',
  plan: 'PRO',
  managerPhone: '',
  managerEmail: 'chef@bistrot.fr',
  phoneNumber: '+33400000000',
  giftCardEnabled: false,
  slug: 'le-bistrot',
  exposureSettings: { capacitySpecials: { waitingListEnabled: true } },
};
const PERSONALITY = {
  id: 'pers-1',
  restaurantId: 'org_test',
  profileType: 'BISTROT_BRASSERIE',
  fillerStyle: 'CASUAL',
  speakingRate: 1.2,
  volume: 1.1,
  voiceIdCa: 'ancienne-voix',
  pronunciationDictId: 'dict_1',
  emotion: 'calm',
  systemPromptExtra: null,
};

function loadSucceeds(crm: 'ok' | 'closed' = 'ok') {
  mocks.get.mockImplementation(async (path: string) => {
    if (path === 'restaurants/org_test') return RESTAURANT;
    if (path === 'restaurants/org_test/personality') return PERSONALITY;
    if (path === 'billing/status') return { plan: 'pro', subscriptionStatus: 'active' };
    if (path === 'crm/privacy') {
      if (crm === 'closed') throw toApiError(503, { error: 'CRM_ADVANCED_DISABLED' });
      return { data: { sensitiveNoteRoles: ['OWNER', 'MANAGER'], source: 'SITE' } };
    }
    return {};
  });
}

describe('SettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.patch.mockResolvedValue({});
  });

  it('n’affiche aucun formulaire quand le chargement échoue : « Enregistrer » écraserait les vrais réglages', async () => {
    mocks.get.mockRejectedValue(new Error('Le service est momentanément indisponible.'));

    render(<SettingsPage />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('momentanément indisponible');
    expect(alert).toHaveTextContent('Vos réglages n’ont pas été modifiés');
    expect(screen.queryByRole('button', { name: /enregistrer/i })).not.toBeInTheDocument();
    expect(screen.queryByText('Essential')).not.toBeInTheDocument();
  });

  it('recharge les paramètres avec « Réessayer »', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Panne'));
    mocks.get.mockRejectedValueOnce(new Error('Panne'));
    loadSucceeds();

    render(<SettingsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /réessayer/i }));

    expect(await screen.findByDisplayValue('Le Bistrot')).toBeInTheDocument();
  });

  it('transforme un numéro saisi à la française en numéro international', async () => {
    loadSucceeds();
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');

    fireEvent.change(screen.getByLabelText('Téléphone du gérant'), {
      target: { value: '06 12 34 56 78' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Enregistrer' })[0]);

    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith('restaurants/org_test', {
        name: 'Le Bistrot',
        managerPhone: '+33612345678',
        managerEmail: 'chef@bistrot.fr',
      });
    });
  });

  it('refuse un numéro invalide en français, sans appeler l’API', async () => {
    loadSucceeds();
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');

    fireEvent.change(screen.getByLabelText('Téléphone du gérant'), { target: { value: '12 34' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Enregistrer' })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Numéro de téléphone invalide');
    expect(mocks.patch).not.toHaveBeenCalled();
  });

  it('annulation : 2 h avant par défaut, et un autre délai garde les autres réglages', async () => {
    loadSucceeds();
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');

    expect(screen.getByRole('radio', { name: 'Gratuite jusqu’à 2 h avant' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(screen.getByRole('radio', { name: 'Gratuite jusqu’à 24 h avant' }));

    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith('restaurants/org_test', {
        capacitySpecials: {
          waitingListEnabled: true,
          cancellationPolicy: "Annulation gratuite jusqu'à 24 heures avant le service.",
        },
      });
    });
    expect(screen.getByRole('radio', { name: 'Gratuite jusqu’à 24 h avant' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('masque la carte des notes CRM quand le CRM avancé est fermé pour ce compte', async () => {
    loadSucceeds('closed');
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');

    await waitFor(() => {
      expect(screen.queryByText('Visibilité des notes CRM')).not.toBeInTheDocument();
    });
  });

  it('affiche la carte des notes CRM quand le réglage est disponible', async () => {
    loadSucceeds('ok');
    render(<SettingsPage />);

    expect(await screen.findByText('Visibilité des notes CRM')).toBeInTheDocument();
  });

  it('ne montre plus les réglages propres à l’ancienne voix, et garde leurs valeurs à l’enregistrement', async () => {
    loadSucceeds();
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');

    expect(screen.queryByText(/Cartesia/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Vitesse de parole/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Volume :/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer la personnalité' }));

    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith(
        'restaurants/org_test/personality',
        expect.objectContaining({
          speakingRate: 1.2,
          volume: 1.1,
          voiceIdCa: 'ancienne-voix',
          pronunciationDictId: 'dict_1',
          emotion: 'calm',
        }),
      );
    });
  });

  it('n’annonce plus de quota d’appels qui n’existe pas', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === 'restaurants/org_test') return { ...RESTAURANT, plan: 'STARTER' };
      if (path === 'restaurants/org_test/personality') return PERSONALITY;
      if (path === 'crm/privacy') throw toApiError(503, { error: 'CRM_ADVANCED_DISABLED' });
      return null;
    });
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');
    expect(screen.queryByText(/1 500 appels/)).not.toBeInTheDocument();
  });

  it('retire le lien « CRM » de la barre quand la carte n’existe pas', async () => {
    loadSucceeds('closed');
    render(<SettingsPage />);
    await screen.findByDisplayValue('Le Bistrot');
    const nav = screen.getByRole('navigation', { name: 'Sections des paramètres' });

    await waitFor(() => expect(nav).toHaveTextContent('Abonnement'));
    expect(nav).not.toHaveTextContent('CRM');
  });

  it('montre le lien « CRM » quand la carte est disponible', async () => {
    loadSucceeds('ok');
    render(<SettingsPage />);
    await screen.findByText('Visibilité des notes CRM');

    expect(screen.getByRole('link', { name: 'CRM' })).toHaveAttribute('href', '#settings-crm');
  });

  it('retire « Enregistré » dès que le champ est modifié', async () => {
    loadSucceeds('closed');
    render(<SettingsPage />);
    fireEvent.change(await screen.findByDisplayValue('Le Bistrot'), {
      target: { value: 'Le Bistrot 2' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Enregistrer' })[0]);
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('Le Bistrot 2'), {
      target: { value: 'Le Bistrot 3' },
    });

    expect(screen.queryByText('Enregistré')).not.toBeInTheDocument();
  });

  it('n’appelle plus Suppernote « assistant téléphonique » quand l’abonnement est terminé', async () => {
    mocks.get.mockImplementation(async (path: string) => {
      if (path === 'restaurants/org_test') return RESTAURANT;
      if (path === 'restaurants/org_test/personality') return PERSONALITY;
      if (path === 'billing/status') {
        return { plan: 'pro', subscriptionStatus: 'canceled', suspended: true };
      }
      if (path === 'crm/privacy') throw toApiError(503, { error: 'CRM_ADVANCED_DISABLED' });
      return {};
    });
    render(<SettingsPage />);

    expect(await screen.findByText(/Suppernote ne répond plus aux appels/)).toBeInTheDocument();
    expect(screen.queryByText(/assistant téléphonique/)).not.toBeInTheDocument();
  });

  describe('retour de paiement', () => {
    afterEach(() => {
      vi.useRealTimers();
      window.history.replaceState({}, '', '/');
    });

    it('relit le statut jusqu’à ce que la formule soit à jour, sans parler de webhook', async () => {
      window.history.replaceState({}, '', '/dashboard/settings?billing=success');
      let billingCalls = 0;
      mocks.get.mockImplementation(async (path: string) => {
        if (path === 'restaurants/org_test') return RESTAURANT;
        if (path === 'restaurants/org_test/personality') return PERSONALITY;
        if (path === 'billing/status') {
          billingCalls += 1;
          return billingCalls === 1
            ? { plan: 'pro', subscriptionStatus: null }
            : { plan: 'pro', subscriptionStatus: 'active' };
        }
        if (path === 'crm/privacy') throw toApiError(503, { error: 'CRM_ADVANCED_DISABLED' });
        return {};
      });
      render(<SettingsPage />);

      expect(
        await screen.findByText(/Votre formule s’affichera ici dans quelques instants/),
      ).toBeInTheDocument();
      expect(screen.queryByText(/webhook/i)).not.toBeInTheDocument();
      expect(
        await screen.findByText(
          'Souscription confirmée : votre formule est à jour.',
          {},
          { timeout: 6000 },
        ),
      ).toBeInTheDocument();
      expect(screen.getByText('Abonnement actif')).toBeInTheDocument();
    }, 15000);
  });
});
