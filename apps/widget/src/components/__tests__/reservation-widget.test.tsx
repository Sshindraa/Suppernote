import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fetchWithTimeout } from '@suppernote/shared';
import { ReservationWidget } from '../reservation-widget';

interface WindowWithOpenAI extends Window {
  openai?: {
    toolInput?: unknown;
    toolOutput?: unknown;
    setWidgetState?: (state: unknown) => void;
  };
}

// Les conditions d'empreinte ont leur propre double : la file des autres appels reste inchangée.
const network = vi.hoisted(() => ({ fetch: vi.fn(), guarantee: vi.fn() }));
vi.mock('@suppernote/shared', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  fetchWithTimeout: (url: string, init?: RequestInit) =>
    url.includes('/card-guarantee') ? network.guarantee(url, init) : network.fetch(url, init),
}));

const mockFetch = vi.mocked(network.fetch as unknown as typeof fetchWithTimeout);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Remplace `window.location.search` (jsdom ne permet pas l'écriture directe). */
function setSearch(search: string): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search, href: `https://localhost/${search}` },
  });
}

/** Restaure `window.location` d'origine (minimal, suffisant pour les tests). */
function restoreLocation(): void {
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search: '', href: 'https://localhost/' },
  });
}

/** Réponse availability standard avec deux créneaux (un dispo, un indispo). */
function availabilityResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      restaurantId: 'r1',
      date: '2030-01-15',
      partySize: 2,
      slots: [
        { time: '19:00', available: true },
        { time: '19:30', available: false },
      ],
    }),
  } as unknown as Response;
}

/** Réponse hold standard. */
function holdResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      holdId: 'h1',
      holdToken: 'tk-abc',
      expiresAt: '2030-01-15T19:05:00Z',
      status: 'pending' as const,
    }),
  } as unknown as Response;
}

/** Réponse confirm standard. */
function confirmResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      reservationId: 'res-123',
      status: 'confirmed' as const,
      restaurantName: 'Chez Suppernote',
      date: '2030-01-15',
      time: '19:00',
      partySize: 2,
    }),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockFetch.mockReset();
  network.guarantee.mockReset().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ cardGuarantee: null, bookingUrl: 'https://suppernote.test/book/demo' }),
  });
  restoreLocation();
  delete (window as unknown as WindowWithOpenAI).openai;
});

afterEach(() => {
  restoreLocation();
  delete (window as unknown as WindowWithOpenAI).openai;
});

// ---------------------------------------------------------------------------
// 1. Rendu initial
// ---------------------------------------------------------------------------

describe('ReservationWidget — rendu initial', () => {
  it("affiche un message d'attente sans slug (pas de toolInput, pas d'URL param)", async () => {
    render(<ReservationWidget />);
    // useEffect passe input à null → message d'attente
    expect(await screen.findByText(/En attente des données du restaurant/)).toBeInTheDocument();
  });

  it("affiche l'étape details avec le sélecteur de date et party size via ?slug=", async () => {
    setSearch('?slug=chez-suppernote-demo');
    render(<ReservationWidget />);

    // Le formulaire details doit être présent
    expect(
      await screen.findByRole('form', { name: 'Détails de la réservation' }),
    ).toBeInTheDocument();
    // Date picker
    expect(screen.getByLabelText(/Choisissez une date/)).toBeInTheDocument();
    // Party size selector (span avec aria-live)
    expect(screen.getByText('Nombre de personnes')).toBeInTheDocument();
    // Bouton "Voir les créneaux"
    expect(screen.getByRole('button', { name: 'Voir les créneaux' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Étape details
// ---------------------------------------------------------------------------

describe('ReservationWidget — étape details', () => {
  beforeEach(() => {
    setSearch('?slug=chez-suppernote-demo');
  });

  it('incrémente et décrémente le nombre de personnes', async () => {
    const user = userEvent.setup();
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    // Valeur initiale = 2
    const partySizeDisplay = screen.getByText('2');
    expect(partySizeDisplay).toBeInTheDocument();

    // Incrément
    const incBtn = screen.getByRole('button', { name: 'Augmenter le nombre de personnes' });
    await user.click(incBtn);
    expect(screen.getByText('3')).toBeInTheDocument();

    // Décrément
    const decBtn = screen.getByRole('button', { name: 'Diminuer le nombre de personnes' });
    await user.click(decBtn);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('bloque le décrément à 1 (min)', async () => {
    const user = userEvent.setup();
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    const decBtn = screen.getByRole('button', { name: 'Diminuer le nombre de personnes' });
    // Valeur initiale 2 → on descend à 1
    await user.click(decBtn);
    expect(screen.getByText('1')).toBeInTheDocument();
    // Le bouton doit être désactivé à 1
    expect(decBtn).toBeDisabled();
  });

  it("bloque l'incrément à 20 (max)", async () => {
    const user = userEvent.setup();
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    const incBtn = screen.getByRole('button', { name: 'Augmenter le nombre de personnes' });
    // On clique 18 fois pour passer de 2 à 20
    for (let i = 0; i < 18; i++) {
      await user.click(incBtn);
    }
    expect(screen.getByText('20')).toBeInTheDocument();
    // Le bouton doit être désactivé à 20
    expect(incBtn).toBeDisabled();
  });

  it('a un champ date requis', async () => {
    render(<ReservationWidget />);
    const dateInput = await screen.findByLabelText(/Choisissez une date/);
    expect(dateInput).toBeRequired();
  });

  it('désactive le bouton "Voir les créneaux" si pas de date', async () => {
    render(<ReservationWidget />);
    const submitBtn = await screen.findByRole('button', { name: 'Voir les créneaux' });
    expect(submitBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 3. Étape slots
// ---------------------------------------------------------------------------

describe('ReservationWidget — étape slots', () => {
  beforeEach(() => {
    setSearch('?slug=chez-suppernote-demo');
  });

  it('appelle fetchWithTimeout avec les bons params (slug, date, partySize)', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    // Date + submit
    const dateInput = screen.getByLabelText(/Choisissez une date/);
    fireEvent.change(dateInput, { target: { value: '2030-01-15' } });
    const submitBtn = screen.getByRole('button', { name: 'Voir les créneaux' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).toContain('/public/r/chez-suppernote-demo/availability');
    expect(calledUrl).toContain('date=2030-01-15');
    expect(calledUrl).toContain('partySize=2');
  });

  it('affiche les créneaux disponibles', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));

    // Le créneau 19:00 doit apparaître comme bouton cliquable
    expect(await screen.findByRole('button', { name: '19:00' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '19:30' })).toBeInTheDocument();
  });

  it("désactive le bouton d'un créneau indisponible", async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));

    const slotBtn = await screen.findByRole('button', { name: '19:30' });
    expect(slotBtn).toBeDisabled();
  });

  it('affiche "aucun créneau" si slots vides', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ restaurantId: 'r1', date: '2030-01-15', partySize: 2, slots: [] }),
    } as unknown as Response);
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));

    expect(await screen.findByText(/Aucun créneau disponible/)).toBeInTheDocument();
  });

  it("passe à l'étape customer au clic sur un créneau disponible", async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });

    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));

    const slotBtn = await screen.findByRole('button', { name: '19:00' });
    fireEvent.click(slotBtn);

    // L'étape customer affiche le formulaire "Vos coordonnées"
    expect(await screen.findByRole('form', { name: 'Vos coordonnées' })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. Étape customer
// ---------------------------------------------------------------------------

describe('ReservationWidget — étape customer', () => {
  beforeEach(() => {
    setSearch('?slug=chez-suppernote-demo');
  });

  /** Navigue jusqu'à l'étape customer avec un créneau sélectionné. */
  async function goToCustomerStep() {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    const utils = render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });
    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));
    const slotBtn = await screen.findByRole('button', { name: '19:00' });
    fireEvent.click(slotBtn);
    await screen.findByRole('form', { name: 'Vos coordonnées' });
    return utils;
  }

  it('renvoie vers la page du restaurant quand une empreinte bancaire est demandée', async () => {
    network.guarantee.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        cardGuarantee: {
          amountPerPerson: '20.00',
          totalAmount: '40.00',
          currency: 'EUR',
          cancellationHours: 24,
        },
        bookingUrl: 'https://suppernote.test/book/chez-suppernote-demo',
      }),
    });
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });
    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));
    fireEvent.click(await screen.findByRole('button', { name: '19:00' }));

    const link = await screen.findByRole('link', { name: 'Terminer sur la page du restaurant' });
    expect(link).toHaveAttribute(
      'href',
      'https://suppernote.test/book/chez-suppernote-demo?date=2030-01-15&partySize=2&time=19%3A00',
    );
    expect(screen.getByText(/Aucun montant n’est débité aujourd’hui/)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Vos coordonnées' })).not.toBeInTheDocument();
  });

  it('affiche les champs firstName (requis), phone (requis), email, specialRequests', async () => {
    await goToCustomerStep();

    const firstNameInput = screen.getByLabelText(/Prénom/);
    expect(firstNameInput).toBeRequired();

    const phoneInput = screen.getByLabelText(/Téléphone/);
    expect(phoneInput).toBeRequired();

    // Email — label sans astérisque (optionnel)
    const emailInput = screen.getByLabelText(/E-mail/);
    expect(emailInput).not.toBeRequired();

    // Special requests
    expect(screen.getByLabelText(/Demandes particulières/)).toBeInTheDocument();
  });

  it('cache le honeypot "website" (tabIndex -1, aria-hidden)', async () => {
    const { container } = await goToCustomerStep();

    const honeypot = container.querySelector('#website') as HTMLInputElement | null;
    expect(honeypot).not.toBeNull();
    expect(honeypot?.tabIndex).toBe(-1);
    // Le parent est aria-hidden
    expect(honeypot?.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('affiche une erreur si le prénom est vide au submit', async () => {
    await goToCustomerStep();

    // Téléphone valide + prénom rempli d'espaces (passe le required natif,
    // mais échoue au check firstName.trim() dans handleConfirm)
    fireEvent.change(screen.getByLabelText(/Prénom/), { target: { value: '   ' } });
    fireEvent.change(screen.getByLabelText(/Téléphone/), { target: { value: '+33612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la réservation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Indiquez votre prénom/);
  });

  it("affiche une erreur si le téléphone n'est pas au format E.164", async () => {
    await goToCustomerStep();

    fireEvent.change(screen.getByLabelText(/Prénom/), { target: { value: 'Marie' } });
    fireEvent.change(screen.getByLabelText(/Téléphone/), { target: { value: '0612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la réservation' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Numéro de téléphone invalide/);
  });

  it('soumet POST /hold puis POST /confirm et affiche la confirmation', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    mockFetch.mockResolvedValueOnce(holdResponse());
    mockFetch.mockResolvedValueOnce({
      ...confirmResponse(),
      json: async () => ({
        reservationId: 'res-123',
        status: 'confirmed',
        restaurantName: 'Chez Suppernote',
        date: '2030-01-15',
        time: '19:00',
        partySize: 2,
        managementUrl: 'https://suppernote.com/r#test',
      }),
    });

    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });
    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));
    const slotBtn = await screen.findByRole('button', { name: '19:00' });
    fireEvent.click(slotBtn);
    await screen.findByRole('form', { name: 'Vos coordonnées' });

    fireEvent.change(screen.getByLabelText(/Prénom/), { target: { value: 'Marie' } });
    fireEvent.change(screen.getByLabelText(/Téléphone/), { target: { value: '+33612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la réservation' }));

    // 3 appels : availability, hold, confirm
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    // Vérifie que le 2e appel cible /hold
    const holdUrl = mockFetch.mock.calls[1][0] as string;
    expect(holdUrl).toContain('/hold');
    // Vérifie que le 3e appel cible /confirm
    const confirmUrl = mockFetch.mock.calls[2][0] as string;
    expect(confirmUrl).toContain('/confirm');

    // Écran confirmation avec reservationId
    expect(await screen.findByText(/res-123/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Gérer ma réservation' })).toHaveAttribute(
      'href',
      'https://suppernote.com/r#test',
    );
  });
});

// ---------------------------------------------------------------------------
// 4 bis. Créneau trop proche (délai minimum) ou déjà pris : deux 409 différents
// ---------------------------------------------------------------------------

describe('ReservationWidget — refus 409 du hold et de la confirmation', () => {
  const TOO_SOON_MESSAGE =
    'Ce créneau est trop proche : ce restaurant accepte les réservations au moins 2 h à l’avance.';

  beforeEach(() => {
    setSearch('?slug=chez-suppernote-demo');
  });

  function conflict(body: Record<string, unknown>) {
    return { ok: false, status: 409, json: async () => body } as unknown as Response;
  }

  /** Jusqu'au formulaire « Vos coordonnées » rempli, puis clic sur Confirmer. */
  async function submitFromCustomerStep() {
    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });
    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));
    fireEvent.click(await screen.findByRole('button', { name: '19:00' }));
    await screen.findByRole('form', { name: 'Vos coordonnées' });
    fireEvent.change(screen.getByLabelText(/Prénom/), { target: { value: 'Marie' } });
    fireEvent.change(screen.getByLabelText(/Téléphone/), { target: { value: '+33612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la réservation' }));
  }

  it('affiche le message français du serveur quand le hold est refusé pour délai minimum', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    mockFetch.mockResolvedValueOnce(
      conflict({
        error: TOO_SOON_MESSAGE,
        code: 'INSUFFICIENT_LEAD_TIME',
        minLeadTimeMinutes: 120,
      }),
    );

    await submitFromCustomerStep();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TOO_SOON_MESSAGE);
    expect(alert).not.toHaveTextContent(/vient d'être réservé/);
    // Retour aux horaires : le créneau refusé n'est plus proposé (le widget masque les indisponibles).
    expect(screen.queryByRole('button', { name: '19:00' })).not.toBeInTheDocument();
  });

  it('garde « vient d’être réservé » pour un 409 sans code de délai', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    mockFetch.mockResolvedValueOnce(conflict({ error: 'Slot taken' }));

    await submitFromCustomerStep();

    expect(await screen.findByRole('alert')).toHaveTextContent(/vient d'être réservé/);
  });

  it('affiche le message français quand la confirmation est refusée pour délai minimum', async () => {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    mockFetch.mockResolvedValueOnce(holdResponse());
    mockFetch.mockResolvedValueOnce(
      conflict({
        error: TOO_SOON_MESSAGE,
        code: 'INSUFFICIENT_LEAD_TIME',
        minLeadTimeMinutes: 120,
      }),
    );

    await submitFromCustomerStep();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(TOO_SOON_MESSAGE);
    expect(alert).not.toHaveTextContent(/vient d'être réservé|Une erreur/);
  });
});

// ---------------------------------------------------------------------------
// 5. Écran confirmation
// ---------------------------------------------------------------------------

describe('ReservationWidget — écran confirmation', () => {
  beforeEach(() => {
    setSearch('?slug=chez-suppernote-demo');
  });

  /** Navigue jusqu'à l'écran de confirmation (flow complet mocké). */
  async function goToConfirmation() {
    mockFetch.mockResolvedValueOnce(availabilityResponse());
    mockFetch.mockResolvedValueOnce(holdResponse());
    mockFetch.mockResolvedValueOnce(confirmResponse());

    render(<ReservationWidget />);
    await screen.findByRole('form', { name: 'Détails de la réservation' });
    fireEvent.change(screen.getByLabelText(/Choisissez une date/), {
      target: { value: '2030-01-15' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Voir les créneaux' }));
    fireEvent.click(await screen.findByRole('button', { name: '19:00' }));
    await screen.findByRole('form', { name: 'Vos coordonnées' });
    fireEvent.change(screen.getByLabelText(/Prénom/), { target: { value: 'Marie' } });
    fireEvent.change(screen.getByLabelText(/Téléphone/), { target: { value: '+33612345678' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la réservation' }));
    return screen.findByRole('status');
  }

  it('affiche le nom du restaurant, la date/heure et le nombre de personnes', async () => {
    await goToConfirmation();

    const status = screen.getByRole('status');
    // Nom du restaurant
    expect(status).toHaveTextContent('Chez Suppernote');
    // Heure du créneau (19:00 apparaît dans le label formaté)
    expect(status).toHaveTextContent('19:00');
    // Party size = 2 → "2 personnes"
    expect(status).toHaveTextContent(/2\s+personnes/);
  });

  it('affiche le reservationId', async () => {
    await goToConfirmation();
    expect(screen.getByText(/res-123/)).toBeInTheDocument();
  });

  it('a role="status" et aria-live="polite"', async () => {
    await goToConfirmation();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });
});
