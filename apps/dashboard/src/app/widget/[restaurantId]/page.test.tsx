import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act, fireEvent } from '@testing-library/react';
import { getGiftCardOrigin } from '@/lib/gift-card-origin';
import ReservationWidget from './page';
import { getParentOrigin } from './post-message-security';

// ---------------------------------------------------------------------------
// Mocks next/navigation + next/link (le widget embarqué les utilise).
// ---------------------------------------------------------------------------

const navMocks = vi.hoisted(() => {
  let params: Record<string, string> = {};
  let search = '';
  return {
    setParams: (p: Record<string, string>) => {
      params = p;
    },
    setSearch: (s: string) => {
      search = s;
    },
    useParams: () => params,
    useSearchParams: () => new URLSearchParams(search),
  };
});

vi.mock('next/navigation', () => ({
  useParams: navMocks.useParams,
  useSearchParams: navMocks.useSearchParams,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// ---------------------------------------------------------------------------
// Polyfills jsdom (ResizeObserver n'existe pas en jsdom).
// ---------------------------------------------------------------------------

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mock `document.referrer` (lecture seule en jsdom). */
function setReferrer(referrer: string): void {
  Object.defineProperty(document, 'referrer', {
    configurable: true,
    value: referrer,
  });
}

/** Réponse restaurant minimale pour le fetch du widget. */
function restaurantResponse() {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        id: 'r1',
        name: 'Chez Suppernote',
        openingHours: { mon: { open: '12:00', close: '22:00' } },
      }),
  } as unknown as Response;
}

/** Réponse disponibilités (vide) pour le fetch availability. */
function availabilityResponse() {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        restaurantId: 'r1',
        date: '2030-01-15',
        partySize: 2,
        slots: [],
      }),
  } as unknown as Response;
}

/** fetch spy qui route selon l'URL (restaurant vs availability). */
function makeFetchSpy() {
  return vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/availability')) {
      return availabilityResponse();
    }
    return restaurantResponse();
  });
}

function dateParam(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(data),
  } as unknown as Response;
}

function bookingRestaurantResponse(): Response {
  return jsonResponse({
    id: 'r1',
    name: 'Chez Suppernote',
    openingHours: Object.fromEntries(
      ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => [
        day,
        { open: '12:00', close: '22:00' },
      ]),
    ),
  });
}

/** Configure un render du widget embarqué avec referrer + spy postMessage. */
async function setupEmbedded(referrer: string) {
  navMocks.setParams({ restaurantId: 'r1' });
  navMocks.setSearch('embedded=1');
  setReferrer(referrer);

  const postMessageSpy = vi.fn();
  vi.spyOn(window.parent, 'postMessage').mockImplementation(postMessageSpy);

  const fetchSpy = makeFetchSpy();
  vi.stubGlobal('fetch', fetchSpy);

  const utils = render(<ReservationWidget />);

  await waitFor(() => {
    expect(fetchSpy).toHaveBeenCalled();
  });
  // Laisse un tick pour les effets post-render (ResizeObserver, sendHeight).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

  return { postMessageSpy, fetchSpy, ...utils };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  setReferrer('');
  vi.restoreAllMocks();
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
});

afterEach(() => {
  setReferrer('');
  vi.unstubAllGlobals();
});

describe('origine du widget carte cadeau', () => {
  it('utilise Connect sur le port local 4002 en développement', () => {
    expect(getGiftCardOrigin('http://localhost:3000', 'development')).toBe('http://localhost:4002');
  });

  it('conserve la même origine derrière le routage de production', () => {
    expect(getGiftCardOrigin('https://suppernote.com', 'production')).toBe(
      'https://suppernote.com',
    );
  });
});

describe('présélection Connect', () => {
  it('ne présente pas une erreur de disponibilité comme un jour complet', async () => {
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateParam(new Date())}&partySize=2`);
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/availability')
          ? Promise.reject(new Error('réseau'))
          : Promise.resolve(bookingRestaurantResponse()),
      ),
    );
    const widget = render(<ReservationWidget />);
    await waitFor(() => expect(widget.getByText('Disponibilités indisponibles')).toBeTruthy());
    expect(widget.queryByText('Complet')).toBeNull();
  });

  it('permet de réessayer la disponibilité sans promettre une place sur un jour seulement ouvert', async () => {
    const date = dateParam(new Date());
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${date}&partySize=2`);
    let availabilityCalls = 0;
    const fetchSpy = vi.fn((url: string) => {
      if (!url.includes('/availability')) return Promise.resolve(bookingRestaurantResponse());
      availabilityCalls += 1;
      return availabilityCalls === 1
        ? Promise.reject(new Error('réseau'))
        : Promise.resolve(
            jsonResponse({ restaurantId: 'r1', date, partySize: 2, slots: ['20:30'] }),
          );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);
    fireEvent.click(await widget.findByRole('button', { name: 'Réessayer' }));
    expect(widget.getAllByRole('button', { name: /ouvert$/ }).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(widget.getByRole('button', { name: 'Choisir le créneau 20h30' })).toBeTruthy(),
    );
    expect(availabilityCalls).toBe(2);
    expect(widget.getByText('Créneaux disponibles')).toBeTruthy();
  });

  it('conserve date et couverts, puis sélectionne le créneau vérifié', async () => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateValue}&time=20%3A30&partySize=4`);

    let resolveAvailability!: (response: Response) => void;
    const fetchSpy = vi.fn((url: string) =>
      url.includes('/availability')
        ? new Promise<Response>((resolve) => {
            resolveAvailability = resolve;
          })
        : Promise.resolve(bookingRestaurantResponse()),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/proxy/restaurants/r1/availability?date=${dateValue}&partySize=4`,
        expect.any(Object),
      ),
    );
    expect(widget.getByRole('button', { name: '4 personnes' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(widget.queryByRole('button', { name: 'Choisir le créneau 20h30' })).toBeNull();

    await act(async () => {
      resolveAvailability(
        jsonResponse({
          restaurantId: 'r1',
          date: dateValue,
          partySize: 4,
          slots: ['20:00', '20:30'],
        }),
      );
    });

    await waitFor(() =>
      expect(
        widget
          .getByRole('button', { name: 'Choisir le créneau 20h30' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(widget.getByRole('button', { name: /Continuer · 20h30/ })).toBeTruthy();
  });

  it('explique un créneau devenu indisponible sans perdre date et groupe', async () => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateValue}&time=20%3A30&partySize=4`);
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('/availability')
        ? jsonResponse({ restaurantId: 'r1', date: dateValue, partySize: 4, slots: ['20:00'] })
        : bookingRestaurantResponse(),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    await waitFor(() =>
      expect(widget.getByRole('status').textContent).toContain(
        'Le créneau de 20h30 n’est plus disponible',
      ),
    );
    expect(widget.getByRole('button', { name: '4 personnes' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/proxy/restaurants/r1/availability?date=${dateValue}&partySize=4`,
      expect.any(Object),
    );
    expect(widget.getByRole('button', { name: 'Choisir le créneau 20h00' })).toBeTruthy();
    expect(widget.queryByRole('button', { name: 'Choisir le créneau 20h30' })).toBeNull();
  });

  it('affiche tel quel le message français du serveur quand la réservation est refusée pour délai minimum', async () => {
    const TOO_SOON =
      'Ce créneau est trop proche : ce restaurant accepte les réservations au moins 2 h à l’avance.';
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateValue}&time=20%3A30&partySize=4`);
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/availability')) {
        return jsonResponse({
          restaurantId: 'r1',
          date: dateValue,
          partySize: 4,
          slots: ['20:00', '20:30'],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/hold')) {
        return {
          ok: false,
          status: 409,
          text: async () =>
            JSON.stringify({
              error: TOO_SOON,
              code: 'INSUFFICIENT_LEAD_TIME',
              minLeadTimeMinutes: 120,
            }),
        } as unknown as Response;
      }
      return bookingRestaurantResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    fireEvent.click(await widget.findByRole('button', { name: /Continuer · 20h30/ }));
    fireEvent.change(await widget.findByLabelText('Nom complet *'), {
      target: { value: 'Alice Martin' },
    });
    fireEvent.change(widget.getByLabelText('Téléphone *'), { target: { value: '0600000000' } });
    fireEvent.click(widget.getByRole('button', { name: 'Valider la réservation' }));

    expect(await widget.findByText(TOO_SOON)).toBeTruthy();
    expect(
      widget.queryByText(/Une erreur est survenue|SLOT_NOT_AVAILABLE|INSUFFICIENT_LEAD_TIME/),
    ).toBeNull();
  });

  it('ignore les paramètres invalides et revient aux critères habituels', async () => {
    const today = dateParam(new Date());
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch('date=2026-02-30&time=25%3A00&partySize=99');
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('/availability')
        ? jsonResponse({ restaurantId: 'r1', date: today, partySize: 2, slots: ['20:30'] })
        : bookingRestaurantResponse(),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/proxy/restaurants/r1/availability?date=${today}&partySize=2`,
        expect.any(Object),
      ),
    );
    expect(widget.getByRole('button', { name: '2 personnes' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    await waitFor(() =>
      expect(
        widget
          .getByRole('button', { name: 'Choisir le créneau 20h30' })
          .getAttribute('aria-pressed'),
      ).toBe('false'),
    );
  });

  it('ne présélectionne pas un horaire lié à une date passée', async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const today = dateParam(new Date());
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateParam(yesterday)}&time=20%3A30&partySize=4`);
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('/availability')
        ? jsonResponse({ restaurantId: 'r1', date: today, partySize: 4, slots: ['20:30'] })
        : bookingRestaurantResponse(),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/proxy/restaurants/r1/availability?date=${today}&partySize=4`,
        expect.any(Object),
      ),
    );
    await waitFor(() =>
      expect(
        widget
          .getByRole('button', { name: 'Choisir le créneau 20h30' })
          .getAttribute('aria-pressed'),
      ).toBe('false'),
    );
  });

  it('ne réapplique pas une réponse lente après un changement manuel de groupe', async () => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateValue}&time=20%3A30&partySize=4`);
    let resolveFirst!: (response: Response) => void;
    const fetchSpy = vi.fn((url: string) => {
      if (!url.includes('/availability')) return Promise.resolve(bookingRestaurantResponse());
      if (url.includes('partySize=4')) {
        return new Promise<Response>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return Promise.resolve(
        jsonResponse({ restaurantId: 'r1', date: dateValue, partySize: 2, slots: ['20:00'] }),
      );
    });
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/proxy/restaurants/r1/availability?date=${dateValue}&partySize=4`,
        expect.any(Object),
      ),
    );
    fireEvent.click(widget.getByRole('button', { name: '2 personnes' }));
    await waitFor(() =>
      expect(widget.getByRole('button', { name: 'Choisir le créneau 20h00' })).toBeTruthy(),
    );

    await act(async () => {
      resolveFirst(
        jsonResponse({ restaurantId: 'r1', date: dateValue, partySize: 4, slots: ['20:30'] }),
      );
    });

    expect(widget.queryByRole('button', { name: 'Choisir le créneau 20h30' })).toBeNull();
    expect(widget.getByRole('button', { name: '2 personnes' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });
});

// ---------------------------------------------------------------------------
// 1. getParentOrigin()
// ---------------------------------------------------------------------------

describe('getParentOrigin', () => {
  it("retourne l'origin du referrer quand il est valide", () => {
    setReferrer('https://resto.example.com/reservations');
    expect(getParentOrigin()).toBe('https://resto.example.com');
  });

  it("retourne l'origin avec un port explicite", () => {
    setReferrer('http://localhost:5173/booking');
    expect(getParentOrigin()).toBe('http://localhost:5173');
  });

  it("retourne '' quand le referrer est vide", () => {
    setReferrer('');
    expect(getParentOrigin()).toBe('');
  });

  it("retourne '' quand le referrer est invalide", () => {
    setReferrer('not-a-valid-url');
    expect(getParentOrigin()).toBe('');
  });

  it('utilise explicitParentOrigin en priorité sur le referrer', () => {
    setReferrer('https://referrer.example.com/');
    expect(getParentOrigin('https://explicit.example.com')).toBe('https://explicit.example.com');
  });

  it('retombe sur le referrer quand explicitParentOrigin est invalide', () => {
    setReferrer('https://referrer.example.com/');
    expect(getParentOrigin('not-a-url')).toBe('https://referrer.example.com');
  });

  it("retourne '' quand explicitParentOrigin est file:// (non-HTTP)", () => {
    setReferrer('');
    expect(getParentOrigin('file:///path/to/page.html')).toBe('');
  });

  it("retourne '' quand explicitParentOrigin et referrer sont tous deux vides", () => {
    setReferrer('');
    expect(getParentOrigin(null)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. postMessage sortant n'est pas appelé quand parentOrigin est vide
// ---------------------------------------------------------------------------

describe('widget embarqué — postMessage sortant', () => {
  it("n'appelle pas window.parent.postMessage quand le referrer est vide", async () => {
    const { postMessageSpy } = await setupEmbedded('');

    const resizeCalls = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    );
    expect(resizeCalls).toHaveLength(0);
  });

  it("cible l'origine du referrer (pas '*') quand le referrer est valide", async () => {
    const { postMessageSpy } = await setupEmbedded('https://resto.example.com/');

    const resizeCalls = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    );
    expect(resizeCalls.length).toBeGreaterThan(0);
    for (const call of resizeCalls) {
      const targetOrigin = call[1] as string;
      expect(targetOrigin).toBe('https://resto.example.com');
      expect(targetOrigin).not.toBe('*');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Listener entrant rejette event.origin !== window.location.origin
// ---------------------------------------------------------------------------

describe('widget embarqué — listener entrant', () => {
  it("ignore les messages dont l'origin diffère de window.location.origin", async () => {
    const { postMessageSpy } = await setupEmbedded('https://resto.example.com/');

    const resizeCallsBefore = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;

    // Message depuis une origine étrangère : ne doit rien déclencher.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example.com',
          data: { type: 'sokar-widget-resize', height: 999 },
        }),
      );
    });

    const resizeCallsAfterHostile = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;
    expect(resizeCallsAfterHostile).toBe(resizeCallsBefore);
  });

  it("ignore les messages same-origin sans source correspondant à l'iframe gift-card", async () => {
    const { postMessageSpy } = await setupEmbedded('https://resto.example.com/');

    const resizeCallsBefore = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;

    // Message same-origin mais sans source (l'iframe gift-card n'est pas ouverte) :
    // ne doit rien déclencher.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: null,
          data: { type: 'sokar-widget-resize', height: 4242 },
        }),
      );
    });

    const resizeCallsAfter = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;
    expect(resizeCallsAfter).toBe(resizeCallsBefore);
  });

  it('ignore les messages same-origin dont la source est une fenêtre étrangère', async () => {
    const { postMessageSpy } = await setupEmbedded('https://resto.example.com/');

    const resizeCallsBefore = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;

    // Message same-origin mais la source est une autre fenêtre (pas l'iframe gift-card).
    const fakeWindow = {} as Window;
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: fakeWindow,
          data: { type: 'sokar-widget-resize', height: 4242 },
        }),
      );
    });

    const resizeCallsAfter = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;
    expect(resizeCallsAfter).toBe(resizeCallsBefore);
  });

  it("accepte un message same-origin dont la source est l'iframe gift-card et forward au parent", async () => {
    const { postMessageSpy, container } = await setupEmbedded('https://resto.example.com/');

    // Ouvre la modal gift-card pour que l'iframe soit rendue et le ref assigné.
    const giftCardButton = container.querySelector('button[class*="gift"], button[class*="carte"]');
    // Fallback : cherche par texte
    const button =
      giftCardButton ??
      Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('carte cadeau'),
      );
    expect(button).toBeTruthy();
    await act(async () => {
      fireEvent.click(button!);
    });

    // Récupère l'iframe renderée et son contentWindow.
    const iframe = container.querySelector('iframe') as HTMLIFrameElement | null;
    expect(iframe).toBeTruthy();
    const iframeWindow = iframe!.contentWindow;
    expect(iframeWindow).toBeTruthy();

    const resizeCallsBefore = postMessageSpy.mock.calls.filter(
      ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
    ).length;

    // Message same-origin avec source === iframe.contentWindow : doit être accepté.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: window.location.origin,
          source: iframeWindow,
          data: { type: 'sokar-widget-resize', height: 5555 },
        }),
      );
    });

    // Le message doit être forwardé au parent (resizeCalls augmente).
    await waitFor(() => {
      const resizeCallsAfter = postMessageSpy.mock.calls.filter(
        ([msg]) => (msg as { type?: string })?.type === 'sokar-widget-resize',
      ).length;
      expect(resizeCallsAfter).toBeGreaterThan(resizeCallsBefore);
    });
  });
});

describe('réservation publique sur le widget réellement servi par /book', () => {
  async function submitTest(
    token: string | undefined,
    rejectHold = false,
    legacyId = false,
    giftCode?: string,
  ) {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: legacyId ? 'r1' : 'chez-sokar' });
    navMocks.setSearch(
      new URLSearchParams({
        date: dateValue,
        time: '20:30',
        partySize: '2',
        ...(token === undefined ? {} : { testBooking: token }),
        marketingAttributionToken: 'a'.repeat(24),
        ...(giftCode ? { giftCardCode: giftCode } : {}),
      }).toString(),
    );
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/availability'))
        return jsonResponse({
          restaurantId: 'r1',
          date: dateValue,
          partySize: 2,
          slots: ['20:30'],
        });
      if (url.endsWith('/hold'))
        return rejectHold
          ? ({
              ok: false,
              status: 403,
              text: async () => JSON.stringify({ error: 'Ce lien de test a expiré.' }),
            } as Response)
          : jsonResponse({ holdToken: crypto.randomUUID() });
      if (url.endsWith('/confirm'))
        return jsonResponse({
          reservationId: 'test-reservation',
          status: 'confirmed',
          managementUrl: '/r?test',
        });
      if (legacyId)
        return jsonResponse({
          id: 'r1',
          slug: 'chez-sokar',
          name: 'Chez Suppernote',
          openingHours: Object.fromEntries(
            ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => [
              day,
              { open: '12:00', close: '22:00' },
            ]),
          ),
        });
      return bookingRestaurantResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);
    fireEvent.click(await widget.findByRole('button', { name: /Continuer · 20h30/ }));
    fireEvent.change(await widget.findByLabelText('Nom complet *'), {
      target: { value: 'Recette Suppernote' },
    });
    fireEvent.change(widget.getByLabelText('Téléphone *'), { target: { value: '0600000000' } });
    fireEvent.click(widget.getByRole('button', { name: 'Valider la réservation' }));
    return { widget, fetchSpy };
  }

  it('confirme une réservation publique sans identifiant de service et conserve l’attribution', async () => {
    const { widget, fetchSpy } = await submitTest(undefined);
    expect(await widget.findByText('Confirmée')).toBeTruthy();
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual([
      '/api/proxy/marketing/attribution/click',
      '/api/proxy/public/r/chez-sokar/hold',
      '/api/proxy/public/r/chez-sokar/confirm',
    ]);
    const hold = JSON.parse(posts[1][1]!.body as string);
    const confirmation = JSON.parse(posts[2][1]!.body as string);
    expect(hold).not.toHaveProperty('testBookingToken');
    expect(confirmation).not.toHaveProperty('testBookingToken');
    expect(confirmation.marketingAttributionToken).toBe('a'.repeat(24));
    expect(confirmation.customer).toEqual({
      firstName: 'Recette Suppernote',
      phone: '+33600000000',
    });
    expect(confirmation.holdToken).toBeTruthy();
    expect(widget.queryByText(/supprimée automatiquement sous 24 h/)).toBeNull();
  });

  it('fait accepter l’empreinte bancaire puis ouvre la page Stripe', async () => {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(
      new URLSearchParams({ date: dateValue, time: '20:30', partySize: '6' }).toString(),
    );
    const terms = {
      amountPerPerson: '20.00',
      totalAmount: '120.00',
      currency: 'EUR',
      cancellationHours: 24,
    };
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/availability'))
        return jsonResponse({
          restaurantId: 'r1',
          date: dateValue,
          partySize: 6,
          slots: ['20:30'],
        });
      if (url.includes('/card-guarantee?')) return jsonResponse({ cardGuarantee: terms });
      if (url.endsWith('/hold')) return jsonResponse({ holdToken: crypto.randomUUID() });
      if (url.endsWith('/confirm'))
        return jsonResponse({
          reservationId: 'pending-reservation',
          status: 'awaiting_card_guarantee',
          cardGuarantee: {
            checkoutUrl: 'https://checkout.stripe.test/cs_1',
            pageUrl: 'https://suppernote.test/garantie?r=chez-sokar&t=x',
          },
        });
      return bookingRestaurantResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);
    const original = window.location;
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign, href: original.href, origin: original.origin },
    });
    try {
      const widget = render(<ReservationWidget />);
      fireEvent.click(await widget.findByRole('button', { name: /Continuer · 20h30/ }));
      fireEvent.change(await widget.findByLabelText('Nom complet *'), {
        target: { value: 'Groupe Suppernote' },
      });
      fireEvent.change(widget.getByLabelText('Téléphone *'), { target: { value: '0600000000' } });
      expect(await widget.findByText(/soit 120 € pour 6 personnes/)).toBeTruthy();
      const submit = widget.getByRole('button', {
        name: 'Continuer vers l’enregistrement de la carte',
      });
      expect((submit as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(widget.getByLabelText('J’accepte ces conditions d’annulation.'));
      fireEvent.click(submit);

      await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_1'));
      const confirm = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/confirm'));
      expect(JSON.parse((confirm![1] as RequestInit).body as string).cardGuarantee).toEqual({
        accepted: true,
        totalAmount: '120.00',
      });
      expect(widget.queryByText('Confirmée')).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original });
    }
  });

  it('résout le slug public pour une ancienne URL de widget par identifiant', async () => {
    const { widget, fetchSpy } = await submitTest(undefined, false, true);
    expect(await widget.findByText('Confirmée')).toBeTruthy();
    expect(widget.getByRole('link', { name: 'Retour' }).getAttribute('href')).toBe(
      '/restaurant/chez-sokar',
    );
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toContain('/api/proxy/public/r/chez-sokar/confirm');
    expect(posts.some(([url]) => url.includes('/public/r/r1/'))).toBe(false);
    fireEvent.click(widget.getByRole('button', { name: 'Offrir une carte cadeau' }));
    expect(widget.container.querySelector('iframe')?.getAttribute('src')).toContain(
      '/widget/chez-sokar/gift-card?embedded=1',
    );
  });

  it('associe le code cadeau fourni au parcours normal, sans montant de débit', async () => {
    const { widget, fetchSpy } = await submitTest(undefined, false, false, 'SKR-TEST-01');
    expect(await widget.findByText('Confirmée')).toBeTruthy();
    const call = fetchSpy.mock.calls.find(([url]) => url.endsWith('/confirm'));
    const body = JSON.parse(call![1]!.body as string);
    expect(body.giftCardCode).toBe('SKR-TEST-01');
    expect(body.giftCardReservationAmount).toBeUndefined();
  });

  it('ne transmet pas de carte cadeau depuis un lien de test', async () => {
    const { widget, fetchSpy } = await submitTest(crypto.randomUUID(), false, false, 'SKR-TEST-01');
    expect(await widget.findByText('Confirmée')).toBeTruthy();
    const call = fetchSpy.mock.calls.find(([url]) => url.endsWith('/confirm'));
    expect(JSON.parse(call![1]!.body as string).giftCardCode).toBeUndefined();
  });

  it('bloque le formulaire avant les coordonnées si la publication ne permet pas de réserver', async () => {
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          id: 'r1',
          name: 'Chez Suppernote',
          bookingEnabled: false,
          openingHours: {},
        }),
      ),
    );
    const widget = render(<ReservationWidget />);
    expect(await widget.findByText(/La réservation en ligne n’est pas disponible/)).toBeTruthy();
    expect(widget.queryByLabelText('Nom complet *')).toBeNull();
    expect(widget.queryByRole('button', { name: /Continuer/ })).toBeNull();
  });

  it('retire aussi un ancien formulaire ouvert quand le restaurant suivant est indisponible', async () => {
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    const fetchSpy = vi.fn(async (url: string) =>
      url.includes('/availability') ? availabilityResponse() : bookingRestaurantResponse(),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const widget = render(<ReservationWidget />);
    await widget.findByText(/Nombre de personnes/i);
    fetchSpy.mockImplementation(async () =>
      jsonResponse({ id: 'other', name: 'Autre', bookingEnabled: false, openingHours: {} }),
    );
    navMocks.setParams({ restaurantId: 'unpublished' });
    widget.rerender(<ReservationWidget />);
    expect(await widget.findByText(/La réservation en ligne n’est pas disponible/)).toBeTruthy();
    expect(widget.queryByRole('button', { name: /Continuer/ })).toBeNull();
  });

  it('ne confirme pas et ne contourne pas un refus du hold public', async () => {
    const { widget, fetchSpy } = await submitTest(undefined, true);
    expect(await widget.findByText('Ce lien de test a expiré.')).toBeTruthy();
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual([
      '/api/proxy/marketing/attribution/click',
      '/api/proxy/public/r/chez-sokar/hold',
    ]);
  });

  it('transmet le jeton au hold puis à la confirmation, sans création réelle ni attribution', async () => {
    const token = crypto.randomUUID();
    const { widget, fetchSpy } = await submitTest(token);
    expect(await widget.findByText('Confirmée')).toBeTruthy();
    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url]) => url)).toEqual([
      '/api/proxy/public/r/chez-sokar/hold',
      '/api/proxy/public/r/chez-sokar/confirm',
    ]);
    for (const [, init] of posts) {
      const body = JSON.parse(init!.body as string);
      expect(body.testBookingToken).toBe(token);
      expect(body).not.toHaveProperty('marketingAttributionToken');
      expect(body).not.toHaveProperty('whatsappReminderConsent');
    }
    expect(widget.getByText(/supprimée automatiquement sous 24 h/)).toBeTruthy();
    expect(widget.queryByRole('link', { name: 'Gérer ma réservation' })).toBeNull();
    expect(widget.container.querySelector('dl')?.textContent).toContain('20:30');
    expect(widget.getByRole('button', { name: 'Ajouter au calendrier' })).toBeTruthy();
    expect(widget.getByRole('link', { name: 'Retour' }).getAttribute('href')).toContain(
      'testBooking=',
    );
    expect(widget.queryByRole('button', { name: 'Offrir une carte cadeau' })).toBeNull();
  });

  it.each(['', 'expired'])(
    'ne revient jamais à une réservation réelle si le jeton est refusé : %j',
    async (token) => {
      const { widget, fetchSpy } = await submitTest(token, true);
      expect(await widget.findByText('Ce lien de test a expiré.')).toBeTruthy();
      expect(widget.queryByText('Confirmée')).toBeNull();
      const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST');
      expect(posts.map(([url]) => url)).toEqual(['/api/proxy/public/r/chez-sokar/hold']);
      expect(JSON.parse(posts[0][1]!.body as string).testBookingToken).toBe(token);
    },
  );
});

describe('consentement marketing et liste d’attente', () => {
  function bookingFetch(holdResponse?: Response) {
    const date = new Date();
    date.setDate(date.getDate() + 2);
    const dateValue = dateParam(date);
    navMocks.setParams({ restaurantId: 'chez-sokar' });
    navMocks.setSearch(`date=${dateValue}&time=20%3A30&partySize=2`);
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/availability')) {
        return jsonResponse({
          restaurantId: 'r1',
          date: dateValue,
          partySize: 2,
          slots: ['20:30'],
        });
      }
      if (init?.method === 'POST' && url.endsWith('/hold')) {
        return holdResponse ?? jsonResponse({ holdToken: 'hold-1' });
      }
      if (init?.method === 'POST' && url.endsWith('/confirm')) {
        return jsonResponse({ reservationId: 'res-1', status: 'CONFIRMED' });
      }
      if (init?.method === 'POST' && url.endsWith('/waiting-list')) {
        return jsonResponse({ entryId: 'wl-1', position: 2, actionToken: 'tok', expiresAt: '' });
      }
      return bookingRestaurantResponse();
    });
    vi.stubGlobal('fetch', fetchSpy);
    return { fetchSpy, dateValue };
  }

  async function fillContact(widget: ReturnType<typeof render>, email = '') {
    fireEvent.click(await widget.findByRole('button', { name: /Continuer · 20h30/ }));
    fireEvent.change(await widget.findByLabelText('Nom complet *'), {
      target: { value: 'Alice Martin' },
    });
    fireEvent.change(widget.getByLabelText('Téléphone *'), { target: { value: '0600000000' } });
    if (email)
      fireEvent.change(widget.getByLabelText(/Adresse Email/), { target: { value: email } });
  }

  function bodyOf(fetchSpy: ReturnType<typeof vi.fn>, suffix: string) {
    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith(suffix));
    return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
  }

  it('n’envoie que les accords cochés, jamais pré-cochés', async () => {
    const { fetchSpy } = bookingFetch();
    const widget = render(<ReservationWidget />);
    await fillContact(widget, 'alice@example.com');

    const email = widget.getByRole('checkbox', { name: /e-mail/i }) as HTMLInputElement;
    const sms = widget.getByRole('checkbox', { name: /SMS/i }) as HTMLInputElement;
    expect(email.checked).toBe(false);
    expect(sms.checked).toBe(false);
    fireEvent.click(email);
    fireEvent.click(widget.getByRole('button', { name: 'Valider la réservation' }));

    await waitFor(() => expect(bodyOf(fetchSpy, '/confirm').marketingConsent).toBeDefined());
    expect(bodyOf(fetchSpy, '/confirm').marketingConsent).toEqual({
      email: true,
      version: expect.any(String),
    });
  });

  it('propose la liste d’attente quand le créneau vient d’être pris', async () => {
    const { fetchSpy, dateValue } = bookingFetch({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: 'no_table_available', waitingListEnabled: true }),
    } as unknown as Response);
    const widget = render(<ReservationWidget />);
    await fillContact(widget);
    fireEvent.click(widget.getByRole('button', { name: 'Valider la réservation' }));

    fireEvent.click(await widget.findByRole('button', { name: "Rejoindre la liste d'attente" }));
    expect(await widget.findByText(/position indicative/)).toBeTruthy();
    expect(bodyOf(fetchSpy, '/waiting-list')).toMatchObject({
      date: dateValue,
      time: '20:30',
      partySize: 2,
      customer: { firstName: 'Alice Martin', phone: '+33600000000' },
    });
    expect(widget.queryByText(/no_table_available/)).toBeNull();
  });
});
