import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '../../../messages/fr.json';
import { ApiError } from '@/lib/api-error';
import { CompanionPanel } from './CompanionPanel';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  get: vi.fn(),
  siteId: 'site_1' as string | undefined,
}));
vi.mock('@/lib/api', () => ({
  useApi: () => ({ post: mocks.post, get: mocks.get, siteId: mocks.siteId }),
}));

const TONIGHT = {
  service: 'soir',
  date: '2026-10-30',
  covers: 14,
  usualCovers: 16,
  specialRequestsCount: 1,
  waitlistCount: 0,
  watch: [
    {
      reservationId: 'res-1',
      name: 'Léa Martin',
      time: '20:00',
      partySize: 6,
      reasons: ['largeParty'],
    },
  ],
  attention: [
    {
      reservationId: 'res-2',
      name: 'Paul Durand',
      time: '19:30',
      partySize: 2,
      reasons: ['vip'],
    },
  ],
};
const EMPTY_TONIGHT = {
  ...TONIGHT,
  covers: 0,
  usualCovers: null,
  specialRequestsCount: 0,
  watch: [],
  attention: [],
};

const WEEK_QUESTION = 'Comment se présentent les 7 prochains jours ?';
const RESPONSE_ID = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7c45';
const OTHER_RESPONSE_ID = '8a1d5e7f-2b3c-4d9e-8f0a-1c2b3d4e5f60';

function renderPanel() {
  return render(
    <NextIntlClientProvider locale="fr" messages={messages}>
      <CompanionPanel />
    </NextIntlClientProvider>,
  );
}

function typeInDraft(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.siteId = 'site_1';
  mocks.get.mockResolvedValue(TONIGHT);
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('CompanionPanel', () => {
  it('déploie la saisie au focus et conserve le brouillon après la perte du focus', () => {
    renderPanel();
    const field = screen.getByRole('textbox');
    expect(field).toHaveAttribute('rows', '1');
    fireEvent.focus(field);
    expect(field).toHaveAttribute('rows', '3');
    fireEvent.change(field, { target: { value: 'Mes réservations' } });
    fireEvent.blur(field);
    expect(field).toHaveAttribute('rows', '3');
    expect(field).toHaveValue('Mes réservations');
  });

  it('envoie la suggestion comme question et affiche la réponse avec un seul lien par écran', async () => {
    mocks.post.mockResolvedValue({
      reply: 'Vous avez 12 couverts prévus.',
      sources: [
        { tool: 'upcoming_days', href: '/dashboard' },
        { tool: 'reservation_stats', href: '/dashboard' },
      ],
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));

    expect(mocks.post).toHaveBeenCalledWith('companion/chat', {
      messages: [{ role: 'user', content: WEEK_QUESTION }],
    });
    expect(await screen.findByText('Vous avez 12 couverts prévus.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Voir dans le tableau de bord' });
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/dashboard');
  });

  it('envoie avec Entrée, sans Maj+Entrée', () => {
    mocks.post.mockResolvedValue({ reply: 'OK.', sources: [] });
    renderPanel();

    typeInDraft('Combien de no-shows ?');
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true });
    expect(mocks.post).not.toHaveBeenCalled();

    fireEvent.keyDown(field, { key: 'Enter' });
    expect(mocks.post).toHaveBeenCalledWith('companion/chat', {
      messages: [{ role: 'user', content: 'Combien de no-shows ?' }],
    });
  });

  it('affiche le message d’erreur de l’API, puis Réessayer renvoie la même question', async () => {
    mocks.post.mockRejectedValueOnce(
      new ApiError(
        'Vous avez atteint la limite de 100 messages pour aujourd’hui. Réessayez demain.',
        429,
        'COMPANION_DAILY_LIMIT',
      ),
    );
    mocks.post.mockResolvedValueOnce({ reply: 'Réponse après réessai.', sources: [] });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Vous avez atteint la limite de 100 messages pour aujourd’hui.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(mocks.post).toHaveBeenLastCalledWith('companion/chat', {
      messages: [{ role: 'user', content: WEEK_QUESTION }],
    });
    expect(await screen.findByText('Réponse après réessai.')).toBeInTheDocument();
  });

  it('restaure l’historique du site depuis sessionStorage et le sépare par site', () => {
    window.sessionStorage.setItem(
      'suppernote.companion.site_1',
      JSON.stringify([
        { role: 'user', content: 'Question ancienne' },
        { role: 'assistant', content: 'Réponse ancienne', sources: [] },
      ]),
    );
    const first = renderPanel();
    expect(screen.getByText('Réponse ancienne')).toBeInTheDocument();
    first.unmount();

    mocks.siteId = 'site_2';
    renderPanel();
    expect(screen.queryByText('Réponse ancienne')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: WEEK_QUESTION })).toBeInTheDocument();
  });

  it('lit une entrée ancienne qui contient toolRuns sans ce champ', async () => {
    window.sessionStorage.setItem(
      'suppernote.companion.site_1',
      JSON.stringify([
        { role: 'user', content: 'Question ancienne' },
        {
          role: 'assistant',
          content: 'Réponse ancienne',
          sources: [],
          toolRuns: [{ name: 'upcoming_days', arguments: '{}', result: '{}' }],
        },
      ]),
    );
    mocks.post.mockResolvedValue({ reply: 'Suite.', sources: [] });
    renderPanel();

    expect(screen.getByText('Réponse ancienne')).toBeInTheDocument();
    typeInDraft('Et la suite ?');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(await screen.findByText('Suite.')).toBeInTheDocument();
    expect(mocks.post).toHaveBeenLastCalledWith('companion/chat', {
      messages: [
        { role: 'user', content: 'Question ancienne' },
        { role: 'assistant', content: 'Réponse ancienne' },
        { role: 'user', content: 'Et la suite ?' },
      ],
    });
  });

  it('pouce bas : envoie l’avis avec le responseId, puis verrouille les boutons', async () => {
    mocks.post.mockResolvedValueOnce({
      reply: 'Sept jours.',
      sources: [],
      responseId: RESPONSE_ID,
    });
    mocks.post.mockResolvedValueOnce(undefined);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));
    await screen.findByText('Sept jours.');
    fireEvent.click(screen.getByRole('button', { name: 'Réponse peu utile' }));

    expect(mocks.post).toHaveBeenLastCalledWith('companion/feedback', {
      responseId: RESPONSE_ID,
      rating: 'down',
    });
    expect(screen.getByRole('button', { name: 'Réponse peu utile' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Réponse peu utile' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Réponse utile' })).toBeDisabled();
  });

  it('échec de l’avis : silencieux, les boutons redeviennent disponibles', async () => {
    mocks.post.mockResolvedValueOnce({
      reply: 'Sept jours.',
      sources: [],
      responseId: RESPONSE_ID,
    });
    mocks.post.mockRejectedValueOnce(new ApiError('Erreur réseau', 500, null));
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));
    await screen.findByText('Sept jours.');
    fireEvent.click(screen.getByRole('button', { name: 'Réponse utile' }));

    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Réponse utile' })).toBeEnabled(),
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('une entrée sans responseId n’affiche pas de boutons d’avis', () => {
    window.sessionStorage.setItem(
      'suppernote.companion.site_1',
      JSON.stringify([
        { role: 'user', content: 'Question ancienne' },
        { role: 'assistant', content: 'Réponse ancienne', sources: [] },
      ]),
    );
    renderPanel();

    expect(screen.getByText('Réponse ancienne')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réponse utile' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réponse peu utile' })).not.toBeInTheDocument();
  });

  it('un avis donné pendant une question en cours n’est pas effacé par la réponse suivante', async () => {
    let resolveSecond!: (value: unknown) => void;
    mocks.post.mockResolvedValueOnce({
      reply: 'Première réponse.',
      sources: [],
      responseId: RESPONSE_ID,
    });
    mocks.post.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSecond = resolve;
      }),
    );
    mocks.post.mockResolvedValueOnce(undefined);
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));
    await screen.findByText('Première réponse.');
    typeInDraft('Et les no-shows ?');
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: 'Réponse utile' }));
    resolveSecond({ reply: 'Deuxième réponse.', sources: [], responseId: OTHER_RESPONSE_ID });

    expect(await screen.findByText('Deuxième réponse.')).toBeInTheDocument();
    const [first] = screen.getAllByRole('button', { name: 'Réponse utile' });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(first).toBeDisabled();
    const feedbackCalls = mocks.post.mock.calls.filter(([path]) => path === 'companion/feedback');
    expect(feedbackCalls).toEqual([
      ['companion/feedback', { responseId: RESPONSE_ID, rating: 'up' }],
    ]);
  });

  it('Nouvelle conversation vide l’historique du site', () => {
    window.sessionStorage.setItem(
      'suppernote.companion.site_1',
      JSON.stringify([{ role: 'user', content: 'Question ancienne' }]),
    );
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Nouvelle conversation' }));

    expect(window.sessionStorage.getItem('suppernote.companion.site_1')).toBeNull();
    expect(screen.queryByText('Question ancienne')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: WEEK_QUESTION })).toBeInTheDocument();
  });
});

describe('carte « Ce soir »', () => {
  it('affiche le chargement tant que le service n’est pas reçu', () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    renderPanel();

    expect(screen.getByRole('status')).toHaveTextContent('Chargement du service…');
  });

  it('affiche « Aucune réservation pour ce service » quand le service est vide', async () => {
    mocks.get.mockResolvedValue(EMPTY_TONIGHT);
    renderPanel();

    expect(await screen.findByText('Aucune réservation pour ce service')).toBeInTheDocument();
  });

  it('affiche l’erreur, puis Réessayer recharge le service', async () => {
    mocks.get.mockRejectedValueOnce(new Error('réseau'));
    mocks.get.mockResolvedValueOnce(TONIGHT);
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Impossible de charger le service pour le moment.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));

    expect(await screen.findByText('Léa Martin')).toBeInTheDocument();
    expect(
      mocks.get.mock.calls.filter(([path]) => path === 'companion/tonight?lang=fr'),
    ).toHaveLength(2);
    expect(mocks.get).toHaveBeenCalledWith('companion/tonight?lang=fr');
  });

  it('affiche chaque réservation une seule fois, avec ses motifs et son lien vers les réservations', async () => {
    mocks.get.mockResolvedValue({
      ...TONIGHT,
      watch: [...TONIGHT.watch, { ...TONIGHT.attention[0], reasons: ['unconfirmed'] }],
      attention: [{ ...TONIGHT.attention[0], reasons: ['vip'] }],
    });
    renderPanel();

    expect(await screen.findByText('Paul Durand')).toBeInTheDocument();
    expect(screen.getAllByText('Paul Durand')).toHaveLength(1);
    expect(screen.getByText('Non confirmée')).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
    expect(screen.getByText('14 couverts · habituellement 16 couverts')).toBeInTheDocument();
    expect(screen.getByText('Léa Martin').closest('a')).toHaveAttribute(
      'href',
      '/dashboard/reservations?date=2026-10-30&reservation=res-1',
    );
  });

  it('disparaît dès la première question', async () => {
    mocks.post.mockResolvedValue({ reply: 'Vous avez 14 couverts.', sources: [] });
    renderPanel();

    expect(await screen.findByText('Léa Martin')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));

    expect(await screen.findByText('Vous avez 14 couverts.')).toBeInTheDocument();
    expect(screen.queryByText('Léa Martin')).not.toBeInTheDocument();
    expect(screen.queryByText('Ce soir')).not.toBeInTheDocument();
  });
});

describe('brouillon de relance dans Companion', () => {
  it('propose d’ouvrir l’éditeur de campagne, et y garde le brouillon sans URL de données', async () => {
    mocks.post.mockResolvedValue({
      reply: 'Relance prête pour l’éditeur.',
      sources: [],
      responseId: RESPONSE_ID,
      draft: {
        channel: 'SMS',
        name: 'Relance midi',
        objective: 'Remplir le service',
        body: 'Il reste des tables ce midi. {{unsubscribeUrl}}',
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));
    const link = await screen.findByRole('link', { name: "Ouvrir dans l'éditeur de campagne" });

    expect(link).toHaveAttribute('href', '/dashboard/marketing/campaigns/new');
    fireEvent.click(link);
    expect(
      JSON.parse(window.sessionStorage.getItem('sokar:campaign-draft') ?? 'null'),
    ).toMatchObject({ name: 'Relance midi', channel: 'SMS' });
  });

  it('propose de remplir le service du soir, avec le même texte, sans URL de données', async () => {
    mocks.post.mockResolvedValue({
      reply: 'Relance prête pour l’éditeur.',
      sources: [],
      responseId: RESPONSE_ID,
      draft: {
        channel: 'SMS',
        name: 'Relance midi',
        objective: 'Remplir le service',
        body: 'Il reste des tables ce soir. {{unsubscribeUrl}}',
      },
    });
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: WEEK_QUESTION }));
    const link = await screen.findByRole('link', { name: 'Remplir ce service' });

    expect(link.getAttribute('href')).toMatch(
      /^\/dashboard\/marketing\/fill-service\?date=\d{4}-\d{2}-\d{2}&service=soir$/,
    );
    fireEvent.click(link);
    expect(
      JSON.parse(window.sessionStorage.getItem('sokar:campaign-draft') ?? 'null'),
    ).toMatchObject({ body: 'Il reste des tables ce soir. {{unsubscribeUrl}}' });
  });
});
