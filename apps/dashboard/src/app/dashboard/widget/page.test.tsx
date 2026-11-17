import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import WidgetIntegrationPage from './page';
import type { Heartbeat, WebsiteCheckResult } from '@/features/widget/website-check';

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  orgId: 'org_test_123',
}));

vi.mock('@/lib/api', () => ({
  useApi: () => ({
    orgId: apiMocks.orgId,
    get: apiMocks.get,
    post: apiMocks.post,
  }),
}));

vi.mock('@/features/onboarding/onboarding-guard', () => ({
  OnboardingLockBanner: () => <div data-testid="onboarding-lock-banner" />,
}));

const validSettings = {
  restaurantId: 'resto-1',
  slug: 'chez-suppernote-demo',
  name: 'Chez Suppernote',
  connectPublished: true,
};

const siteUrl = 'https://www.chez-suppernote.fr';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function analysis(overrides: Partial<WebsiteCheckResult> = {}): WebsiteCheckResult {
  return {
    url: siteUrl,
    platform: 'wordpress',
    providers: [],
    bookingLinks: [],
    scriptFound: false,
    slugMatches: null,
    framingBlocked: null,
    heartbeats: [],
    fetchError: null,
    ...overrides,
  };
}

/** Réglages du restaurant et statut d'installation, selon le chemin appelé. */
function mockApi({
  settings = validSettings,
  heartbeats = [],
}: {
  settings?: unknown;
  heartbeats?: Heartbeat[];
} = {}) {
  apiMocks.get.mockImplementation(async (path: string) =>
    path.includes('heartbeats') ? { heartbeats } : settings,
  );
}

describe('WidgetIntegrationPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.orgId = 'org_test_123';
    mockApi();
  });

  it('affiche un état de chargement initial (skeletons)', () => {
    apiMocks.get.mockReturnValue(new Promise(() => {})); // pending promise
    const { container } = render(<WidgetIntegrationPage />);

    expect(screen.getByRole('heading', { name: 'Widget' })).toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('affiche le message invitant à sélectionner un restaurant si orgId est absent', async () => {
    apiMocks.orgId = undefined as unknown as string;
    render(<WidgetIntegrationPage />);

    expect(
      await screen.findByText('Sélectionnez un restaurant pour configurer le widget.'),
    ).toBeInTheDocument();
    expect(apiMocks.get).not.toHaveBeenCalled();
  });

  it('charge et affiche le snippet et l’aperçu du widget avec succès', async () => {
    apiMocks.get.mockReset();
    apiMocks.get.mockResolvedValueOnce(validSettings);
    render(<WidgetIntegrationPage />);

    await waitFor(() => {
      expect(apiMocks.get).toHaveBeenCalledWith('restaurants/org_test_123/connect');
    });

    expect(await screen.findByText('Code à intégrer')).toBeInTheDocument();
    expect(screen.getByText('Aperçu')).toBeInTheDocument();

    const snippetInput = screen.getByLabelText('Code du widget') as HTMLInputElement;
    expect(snippetInput.value).toContain('data-slug="chez-suppernote-demo"');
    expect(snippetInput.value).toContain('/embed.js');

    const iframe = screen.getByTitle('Aperçu du widget Suppernote');
    expect(iframe).toHaveAttribute(
      'src',
      expect.stringContaining('/widget/chez-suppernote-demo?embedded=1'),
    );
  });

  it('affiche une carte d’erreur explicite avec bouton de relance quand l’API échoue', async () => {
    apiMocks.get.mockReset();
    apiMocks.get.mockRejectedValueOnce(
      new Error('Impossible de joindre le serveur API (service indisponible ou hors ligne)'),
    );
    render(<WidgetIntegrationPage />);

    expect(
      await screen.findByText(
        'Impossible de joindre le serveur API (service indisponible ou hors ligne)',
      ),
    ).toBeInTheDocument();

    const retryButton = screen.getByRole('button', { name: /Réessayer/i });
    expect(retryButton).toBeInTheDocument();
    expect(
      screen.queryByText('Aucune donnée disponible pour ce restaurant.'),
    ).not.toBeInTheDocument();
  });

  it('permet de recharger les données en cliquant sur Réessayer après une erreur', async () => {
    apiMocks.get.mockReset();
    apiMocks.get.mockRejectedValueOnce(new Error('Erreur réseau'));
    render(<WidgetIntegrationPage />);

    expect(await screen.findByText('Erreur réseau')).toBeInTheDocument();

    mockApi();
    const retryButton = screen.getByRole('button', { name: /Réessayer/i });
    fireEvent.click(retryButton);

    expect(await screen.findByText('Code à intégrer')).toBeInTheDocument();
    expect(screen.queryByText('Erreur réseau')).not.toBeInTheDocument();
  });

  it('permet de copier le snippet dans le presse-papier', async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: {
        writeText: writeTextMock,
      },
    });

    render(<WidgetIntegrationPage />);

    const copyButton = await screen.findByRole('button', { name: /Copier le code/i });
    fireEvent.click(copyButton);

    expect(writeTextMock).toHaveBeenCalledWith(
      expect.stringContaining('data-slug="chez-suppernote-demo"'),
    );
    expect(await screen.findByText('Code copié')).toBeInTheDocument();
  });

  it('ne propose plus de couleurs qui ne changeraient rien', async () => {
    render(<WidgetIntegrationPage />);

    await screen.findByText('Code à intégrer');

    expect(screen.queryByText('Couleur principale')).not.toBeInTheDocument();
    expect(screen.queryByText(/Couleur d.accent/)).not.toBeInTheDocument();
    expect(screen.queryByText(/snippet/i)).not.toBeInTheDocument();
  });

  it('affiche l’état vide si les settings sont null sans erreur', async () => {
    mockApi({ settings: null });
    render(<WidgetIntegrationPage />);

    expect(
      await screen.findByText('Aucune donnée disponible pour ce restaurant.'),
    ).toBeInTheDocument();
  });
});

describe('parcours d’installation du widget', () => {
  beforeEach(() => {
    apiMocks.get.mockReset();
    apiMocks.post.mockReset();
    apiMocks.orgId = 'org_test_123';
    mockApi({ settings: { ...validSettings, websiteUrl: siteUrl } });
  });

  async function analyseSite(result: WebsiteCheckResult) {
    apiMocks.post.mockResolvedValueOnce(result);
    render(<WidgetIntegrationPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Analyser mon site' }));
    await waitFor(() => expect(apiMocks.post).toHaveBeenCalled());
  }

  it('pré-remplit l’adresse du site et envoie l’analyse à l’API', async () => {
    apiMocks.post.mockResolvedValueOnce(analysis());
    render(<WidgetIntegrationPage />);

    const input = (await screen.findByLabelText('Adresse de votre site')) as HTMLInputElement;
    expect(input.value).toBe(siteUrl);

    fireEvent.click(screen.getByRole('button', { name: 'Analyser mon site' }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('dashboard/website-check', { url: siteUrl });
    });
  });

  it('présélectionne « Garder vos boutons » quand des boutons Réserver existent', async () => {
    await analyseSite(
      analysis({
        bookingLinks: [
          {
            href: 'https://www.chez-suppernote.fr/reserver',
            text: 'Réserver',
            target: 'suppernote',
          },
        ],
      }),
    );

    expect(await screen.findByText('1 bouton Réserver trouvé')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Garder vos boutons/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Recommandé')).toBeInTheDocument();
    expect((screen.getByLabelText('Lien de réservation') as HTMLInputElement).value).toMatch(
      /\/restaurant\/chez-suppernote-demo$/,
    );
  });

  it('affiche le script « Garder vos boutons » en mode modal', async () => {
    await analyseSite(
      analysis({
        bookingLinks: [
          {
            href: 'https://www.chez-suppernote.fr/reserver',
            text: 'Réserver',
            target: 'suppernote',
          },
        ],
      }),
    );

    const script = await screen.findByText(
      /^<script src="[^"]*\/embed\.js" data-slug="chez-suppernote-demo"(?: data-host="[^"]*")? data-mode="modal" defer><\/script>$/,
    );
    expect(script.tagName).toBe('CODE');
  });

  it('garde le snippet formulaire inchangé, sans data-mode', async () => {
    render(<WidgetIntegrationPage />);

    const snippetInput = (await screen.findByLabelText('Code du widget')) as HTMLTextAreaElement;
    expect(snippetInput.value).not.toContain('data-mode');
  });

  it('présélectionne le formulaire quand aucun bouton Réserver n’est trouvé', async () => {
    await analyseSite(analysis());

    expect(
      await screen.findByText('Aucun bouton Réserver trouvé sur cette page.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Afficher le formulaire/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByText('Recommandé')).not.toBeInTheDocument();
  });

  it('avertit de retirer un outil concurrent encore présent', async () => {
    await analyseSite(
      analysis({
        bookingLinks: [{ href: 'https://zenchef.com/x', text: 'Réserver', target: 'zenchef' }],
        providers: ['zenchef'],
      }),
    );

    expect(
      await screen.findByText(
        'Retirez l’ancien module Zenchef pour éviter des réservations en double.',
      ),
    ).toBeInTheDocument();
  });

  it('avertit aussi pour SevenRooms, Resy, OpenTable et Guestonline listés dans providers', async () => {
    await analyseSite(
      analysis({ providers: ['sevenrooms', 'Resy', 'opentable', 'guestonline', 'constructor'] }),
    );

    expect(
      await screen.findByText(
        'Retirez l’ancien module SevenRooms pour éviter des réservations en double.',
      ),
    ).toBeInTheDocument();
    for (const name of ['Resy', 'OpenTable', 'Guestonline']) {
      expect(
        screen.getByText(`Retirez l’ancien module ${name} pour éviter des réservations en double.`),
      ).toBeInTheDocument();
    }
    // « constructor » n'est pas un concurrent : seulement les 4 avertissements attendus.
    expect(screen.getAllByText(/Retirez l’ancien module/)).toHaveLength(4);
  });

  it('avertit quand le site bloque l’affichage dans une autre page', async () => {
    await analyseSite(analysis({ framingBlocked: true }));

    expect(
      await screen.findByText(/Votre site empêche d’afficher le formulaire/),
    ).toBeInTheDocument();
  });

  it('affiche les deux questions de secours quand l’analyse échoue', async () => {
    await analyseSite(analysis({ platform: 'unknown', fetchError: 'timeout' }));

    expect(await screen.findByText('Votre site met trop de temps à répondre.')).toBeInTheDocument();
    expect(
      screen.getByText('Avez-vous déjà un bouton Réserver sur votre site ?'),
    ).toBeInTheDocument();
    expect(screen.getByText('Garder ce bouton ou afficher le formulaire ?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Oui' }));

    expect(screen.getByRole('button', { name: /Garder vos boutons/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('signale un widget qui n’a plus été vu depuis plus de 7 jours', async () => {
    mockApi({
      settings: { ...validSettings, websiteUrl: siteUrl },
      heartbeats: [
        {
          origin: 'https://www.chez-suppernote.fr',
          at: new Date(Date.now() - 10 * DAY_MS).toISOString(),
          version: '1',
          mode: 'button',
          buttons: 2,
        },
      ],
    });
    render(<WidgetIntegrationPage />);

    expect(
      await screen.findByText('Plus vu depuis 10 jours, votre site a peut-être changé.'),
    ).toBeInTheDocument();
  });

  it('affiche l’installation récente avec le nombre de boutons connectés', async () => {
    mockApi({
      settings: { ...validSettings, websiteUrl: siteUrl },
      heartbeats: [
        {
          origin: 'https://www.chez-suppernote.fr',
          at: new Date(Date.now() - 2 * HOUR_MS).toISOString(),
          version: '1',
          mode: 'button',
          buttons: 2,
        },
      ],
    });
    render(<WidgetIntegrationPage />);

    expect(
      await screen.findByText(
        'Installé sur https://www.chez-suppernote.fr, vu il y a 2 h, 2 boutons connectés.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Vérifier l’installation/ }),
    ).not.toBeInTheDocument();
  });

  it('propose de vérifier l’installation quand aucun signal n’est reçu', async () => {
    apiMocks.post.mockResolvedValue(analysis());
    render(<WidgetIntegrationPage />);

    expect(await screen.findByText('Pas encore détecté')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Vérifier l’installation/ }));

    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith('dashboard/website-check', { url: siteUrl });
    });
  });

  it('transmet au webmaster par un mailto sans destinataire, avec le slug', async () => {
    render(<WidgetIntegrationPage />);

    const link = await screen.findByRole('link', { name: /Transmettre à mon webmaster/ });
    const href = link.getAttribute('href') ?? '';
    expect(href.startsWith('mailto:?subject=')).toBe(true);
    expect(decodeURIComponent(href)).toContain('chez-suppernote-demo');
  });
});
