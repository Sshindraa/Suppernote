/**
 * Page Connect d'un restaurant : l'aperçu « Disponibilités aujourd'hui » se demande pour le jour qu'il
 * est CHEZ le restaurant, pas pour le jour UTC. La page est un composant serveur : on l'appelle comme
 * une fonction et on vérifie la date envoyée à l'API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicRestaurantDto } from '@/lib/api-client';

const mocks = vi.hoisted(() => ({
  fetchPublicRestaurant: vi.fn(),
  fetchAvailability: vi.fn(),
  PageViewTracker: vi.fn(() => null),
}));

vi.mock('@/components/page-view-tracker', () => ({ PageViewTracker: mocks.PageViewTracker }));

vi.mock('@/lib/api-client', () => ({
  fetchPublicRestaurant: mocks.fetchPublicRestaurant,
  fetchAvailability: mocks.fetchAvailability,
  fetchPublishedSlugs: vi.fn().mockResolvedValue([]),
}));
vi.mock('@/lib/api/experiences', () => ({
  fetchPublicExperiences: vi.fn().mockResolvedValue({ experiences: [] }),
}));
vi.mock('@/lib/tracking', () => ({ trackPageView: vi.fn(), trackEvent: vi.fn() }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import { trackEvent } from '@/lib/tracking';
import RestaurantPage, { generateMetadata } from '../page';

const restaurant: PublicRestaurantDto = {
  id: 'r1',
  slug: 'chez-suppernote-demo',
  name: 'Chez Suppernote',
  address: { line1: '12 Rue de la République', city: 'Lyon', country: 'FR' },
  phone: '+33102030405',
  cuisineTypes: ['Bistrot'],
  openingHours: [],
  reservationUrl: 'https://suppernote.com/book/chez-suppernote-demo',
  images: { gallery: [] },
  acceptsReservations: true,
  publishedAt: '2026-06-24T00:00:00.000Z',
  connectAgentic: false,
};

async function render(overrides: Partial<PublicRestaurantDto> = {}) {
  mocks.fetchPublicRestaurant.mockResolvedValue({ ...restaurant, ...overrides });
  await RestaurantPage({
    params: Promise.resolve({ slug: 'chez-suppernote-demo' }),
    searchParams: Promise.resolve({}),
  });
}

const askedDate = () => mocks.fetchAvailability.mock.calls[0][1].date as string;

describe('page restaurant Connect : « aujourd’hui »', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchAvailability.mockResolvedValue({ slots: [] });
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('00:30 à Paris : demande les créneaux du jour de Paris, pas de la veille UTC', async () => {
    vi.setSystemTime(new Date('2026-07-02T22:30:00.000Z')); // 00:30 le 3 à Paris, encore le 2 en UTC

    await render({ timezone: 'Europe/Paris' });

    expect(askedDate()).toBe('2026-07-03');
  });

  it('01:59 à Paris, juste avant 2 h : toujours le jour de Paris', async () => {
    vi.setSystemTime(new Date('2026-07-02T23:59:00.000Z')); // 01:59 le 3 à Paris

    await render({ timezone: 'Europe/Paris' });

    expect(askedDate()).toBe('2026-07-03');
  });

  it('utilise Europe/Paris quand la réponse n’indique pas de fuseau (ancienne réponse en cache)', async () => {
    vi.setSystemTime(new Date('2026-07-02T22:30:00.000Z'));

    await render({ timezone: undefined });

    expect(askedDate()).toBe('2026-07-03');
  });

  it('se cale sur le fuseau du restaurant quand il n’est pas à Paris', async () => {
    vi.setSystemTime(new Date('2026-07-02T22:30:00.000Z')); // encore le 2 à New York

    await render({ timezone: 'America/New_York' });

    expect(askedDate()).toBe('2026-07-02');
  });

  it('en journée, rien ne change : le jour de Paris est le jour UTC', async () => {
    vi.setSystemTime(new Date('2026-07-02T13:00:00.000Z'));

    await render({ timezone: 'Europe/Paris' });

    expect(askedDate()).toBe('2026-07-02');
  });
});

describe('indexabilité des fiches', () => {
  it.each([
    ['chez-suppernote-demo', false],
    ['chez-sokar-bistrot-paris', false],
    ['chez-sokar', true],
  ])('%s index=%s, sans exclusion par préfixe', async (slug, index) => {
    mocks.fetchPublicRestaurant.mockResolvedValue({ ...restaurant, slug });
    const meta = await generateMetadata({
      params: Promise.resolve({ slug }),
      searchParams: Promise.resolve({}),
    });
    expect(meta.robots).toMatchObject({ index, follow: true, googleBot: { index } });
  });
});

describe('parcours de réservation test depuis l’onboarding', () => {
  beforeEach(() => vi.clearAllMocks());

  async function markup(searchParams: Record<string, string>, slots: unknown[] = []) {
    const { renderToStaticMarkup } = await import('react-dom/server');
    mocks.fetchPublicRestaurant.mockResolvedValue(restaurant);
    mocks.fetchAvailability.mockResolvedValue({ slots });
    const page = await RestaurantPage({
      params: Promise.resolve({ slug: 'chez-suppernote-demo' }),
      searchParams: Promise.resolve(searchParams),
    });
    return renderToStaticMarkup(page);
  }

  const bookHrefs = (html: string) =>
    [...html.matchAll(/href="(\/book\/[^"]+)"/g)].map(([, href]) => href);

  const token = `${'a'.repeat(27)}.${'b'.repeat(43)}`;
  const banner =
    'Réservation test : vous voyez ce que voient vos clients. Les notifications dépendent des options du restaurant ; cette réservation n’apparaîtra pas dans votre planning.';

  it('transmet le jeton à tous les liens de réservation et affiche le bandeau', async () => {
    const html = await markup({ testBooking: token });
    const hrefs = bookHrefs(html);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain(`testBooking=${encodeURIComponent(token)}`);
    expect(html).toContain(banner);
    expect(mocks.PageViewTracker).not.toHaveBeenCalled();
  });

  it('reste en mode test avec une valeur mal formée : bandeau et valeur transmise à l’API', async () => {
    const html = await markup({ testBooking: '1' });
    const hrefs = bookHrefs(html);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) expect(href).toContain('testBooking=1');
    expect(html).toContain(banner);
    expect(mocks.PageViewTracker).not.toHaveBeenCalled();
  });

  it.each([
    ['vide', ''],
    ['de plus de 100 caractères', 'a'.repeat(101)],
  ])('refuse une valeur %s sans revenir au parcours réel', async (_label, value) => {
    const html = await markup({ testBooking: value });
    expect(bookHrefs(html).length).toBeGreaterThan(0);
    for (const href of bookHrefs(html)) expect(href).toContain('testBooking=invalid');
    expect(html).toContain(banner);
    expect(mocks.PageViewTracker).not.toHaveBeenCalled();
  });

  it('ne compte pas l’aperçu des disponibilités en mode test', async () => {
    await markup({ testBooking: token }, [{ time: '19:30', available: true }]);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('compte l’aperçu des disponibilités hors mode test', async () => {
    await markup({}, [{ time: '19:30', available: true }]);
    expect(trackEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'availability_preview_shown' }),
    );
  });

  it('ne change rien sans le paramètre', async () => {
    const html = await markup({});
    expect(bookHrefs(html).length).toBeGreaterThan(0);
    expect(html).not.toContain('testBooking');
    expect(html).not.toContain('Réservation test');
  });
});
