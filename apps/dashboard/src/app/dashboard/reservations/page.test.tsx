import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { Reservation, WaitingListEntry } from '@/types/api';
import { toApiError } from '@/lib/api-error';
import ReservationsPage from './page';

const mocks = vi.hoisted(() => ({
  orgId: 'org_test',
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  del: vi.fn(),
  isMobile: false,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  searchParams: new URLSearchParams(),
  replace: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

vi.mock('@/lib/api', () => ({
  useApi: () => mocks,
}));

vi.mock('@/lib/useMediaQuery', () => ({
  useIsMobile: () => mocks.isMobile,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => '/dashboard/reservations',
  useSearchParams: () => mocks.searchParams,
}));

vi.mock('@/components/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    onConfirm,
    confirmLabel,
  }: {
    open: boolean;
    onConfirm: () => void;
    confirmLabel: string;
  }) => (open ? <button onClick={onConfirm}>{confirmLabel}</button> : null),
}));

function makeReservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: 'r1',
    restaurantId: 'org_test',
    reservedAt: '2099-06-05T19:00:00.000Z',
    partySize: 2,
    customerName: 'Alice',
    customerPhone: null,
    status: 'CONFIRMED',
    estimatedRevenue: 70,
    tableId: null,
    table: null,
    ...overrides,
  };
}

function makeWaitingListEntry(overrides: Partial<WaitingListEntry> = {}): WaitingListEntry {
  return {
    id: 'wl1',
    partySize: 3,
    customerFirstName: 'Bob',
    customerLastName: 'Dylan',
    customerPhone: '+33612345678',
    customerEmail: null,
    slotStart: '2099-06-05T19:00:00.000Z',
    slotEnd: '2099-06-05T20:30:00.000Z',
    preferredSectionName: null,
    status: 'PENDING',
    position: 1,
    createdAt: '2099-06-05T10:00:00.000Z',
    promotedReservationId: null,
    ...overrides,
  };
}

describe('ReservationsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    Element.prototype.scrollIntoView = vi.fn();
    mocks.get.mockResolvedValue([]);
    mocks.post.mockResolvedValue({});
    mocks.del.mockResolvedValue(undefined);
  });

  it('affiche l’état de chargement', () => {
    mocks.get.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ReservationsPage />);
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('affiche la liste vide', async () => {
    mocks.get.mockResolvedValue([]);
    render(<ReservationsPage />);
    await waitFor(() => {
      expect(screen.getByText(/Aucune réservation le /)).toBeInTheDocument();
    });
  });

  describe('création par l’équipe', () => {
    beforeEach(() => {
      mocks.get.mockImplementation((path: string) => {
        if (path.startsWith('reservations/staff-availability'))
          return Promise.resolve({
            slots: [
              { time: '19:00', available: true },
              { time: '19:30', available: false },
            ],
          });
        if (path === 'restaurants/org_test') return Promise.resolve({ timezone: 'Europe/Paris' });
        if (path.startsWith('customers/suggestions?'))
          return Promise.resolve({
            data: [
              {
                id: 'c1',
                name: 'Alice Martin',
                phone: '+33612345678',
                email: 'alice@example.com',
                visitCount: 5,
                lastVisitAt: '2026-10-12T12:00:00Z',
                badges: [
                  { kind: 'allergy', label: 'Allergie', detail: 'Arachides' },
                  {
                    kind: 'no_show_risk',
                    label: '1 absence',
                    detail: 'Absent une fois en 12 mois',
                  },
                ],
              },
            ],
          });
        return Promise.resolve([]);
      });
    });
    async function openForm() {
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      await screen.findByRole('button', { name: '19:00' });
      fireEvent.click(screen.getByRole('button', { name: '19:00' }));
      fireEvent.change(screen.getByLabelText('Téléphone'), { target: { value: '06 12 34 56 78' } });
      fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Alice' } });
    }
    it('valide les champs, retrouve un client et enregistre', async () => {
      mocks.post.mockResolvedValue({ reservationId: 'new-id' });
      await openForm();
      expect(await screen.findByText('6e visite · dernière le 12/10')).toBeInTheDocument();
      expect(screen.getAllByText('Allergie').some((node) => node.closest('li'))).toBe(true);
      expect(screen.getByText('1 absence')).toBeInTheDocument();
      fireEvent.click(await screen.findByRole('button', { name: /Alice Martin/ }));
      expect(screen.getByLabelText('Téléphone')).toHaveValue('+33 6 12 34 56 78');
      expect(screen.getByLabelText('E-mail (facultatif)')).toHaveValue('alice@example.com');
      expect(screen.getAllByText('Allergie').some((node) => node.closest('li'))).toBe(true);
      expect(screen.getByText('1 absence')).toBeInTheDocument();
      expect(mocks.get).toHaveBeenCalledWith('customers/suggestions?search=Alice&limit=5');
      fireEvent.click(screen.getByRole('button', { name: 'Anniversaire' }));
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await waitFor(() =>
        expect(mocks.post).toHaveBeenCalledWith(
          'reservations/staff',
          expect.objectContaining({
            customerName: 'Alice Martin',
            specialRequests: 'Anniversaire',
            idempotencyKey: expect.any(String),
          }),
        ),
      );
      const startsAt = new Date(mocks.post.mock.calls[0][1].startsAt);
      expect(
        new Intl.DateTimeFormat('fr-FR', {
          timeZone: 'Europe/Paris',
          hour: '2-digit',
          minute: '2-digit',
          hourCycle: 'h23',
        }).format(startsAt),
      ).toBe('19:00');
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Réservation créée.');
    });
    it('conserve la clé après une erreur réseau et la renouvelle après un 409', async () => {
      mocks.post
        .mockRejectedValueOnce(new Error('Réseau indisponible'))
        .mockRejectedValueOnce(toApiError(409, { error: 'Ce créneau est complet.' }))
        .mockResolvedValueOnce({ reservationId: 'new-id' });
      await openForm();
      const save = screen.getByRole('button', { name: 'Enregistrer' });
      fireEvent.click(save);
      expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible');
      const first = mocks.post.mock.calls[0][1].idempotencyKey;
      fireEvent.click(save);
      expect(await screen.findByRole('alert')).toHaveTextContent('Ce créneau est complet.');
      expect(mocks.post.mock.calls[1][1].idempotencyKey).toBe(first);
      fireEvent.click(save);
      await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(3));
      expect(mocks.post.mock.calls[2][1].idempotencyKey).not.toBe(first);
    });
    it('ignore un deuxième clic pendant la requête', async () => {
      let resolve!: (result: { reservationId: string }) => void;
      mocks.post.mockReturnValue(
        new Promise((done) => {
          resolve = done;
        }),
      );
      await openForm();
      const save = screen.getByRole('button', { name: 'Enregistrer' });
      fireEvent.click(save);
      fireEvent.click(save);
      expect(mocks.post).toHaveBeenCalledTimes(1);
      resolve({ reservationId: 'new-id' });
      await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalled());
    });
    it('demande confirmation pour un créneau complet et crée en surbooking', async () => {
      mocks.post.mockResolvedValue({ reservationId: 'new-id' });
      await openForm();
      fireEvent.click(screen.getByRole('button', { name: '19:30 — complet' }));
      expect(mocks.post).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Forcer la réservation' }));
      await waitFor(() =>
        expect(mocks.post).toHaveBeenCalledWith(
          'reservations/staff',
          expect.objectContaining({ overbook: true, idempotencyKey: expect.any(String) }),
        ),
      );
    });
    it('cache les heures passées et montre un message si elles sont toutes passées', async () => {
      mocks.get.mockImplementation((path: string) =>
        path.startsWith('reservations/staff-availability')
          ? Promise.resolve({
              slots: [
                { time: '12:00', available: false, past: true },
                { time: '19:00', available: false, past: false },
              ],
            })
          : path === 'restaurants/org_test'
            ? Promise.resolve({ timezone: 'Europe/Paris' })
            : Promise.resolve([]),
      );
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      await screen.findByRole('button', { name: '19:00 — complet' });
      expect(screen.queryByRole('button', { name: /12:00/ })).not.toBeInTheDocument();
      mocks.get.mockImplementation((path: string) =>
        path.startsWith('reservations/staff-availability')
          ? Promise.resolve({ slots: [{ time: '12:00', available: false, past: true }] })
          : path === 'restaurants/org_test'
            ? Promise.resolve({ timezone: 'Europe/Paris' })
            : Promise.resolve([]),
      );
      fireEvent.click(screen.getByRole('button', { name: '3' }));
      expect(await screen.findByText('Aucun créneau restant aujourd’hui')).toBeInTheDocument();
    });
    it('indique le surbooking sélectionné avant enregistrement', async () => {
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      fireEvent.click(await screen.findByRole('button', { name: '19:30 — complet' }));
      fireEvent.click(screen.getByRole('button', { name: 'Forcer la réservation' }));
      expect(
        screen.getByText('Surbooking : la réservation sera créée sans table.'),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '19:30 — complet' })).not.toHaveClass(
        'text-muted-foreground',
      );
    });
    it('place les suggestions en superposition sous le champ recherché', async () => {
      await openForm();
      const suggestion = await screen.findByRole('button', { name: /Alice Martin/ });
      expect(suggestion.parentElement).toHaveClass('absolute', 'top-full');
      expect(suggestion.parentElement?.parentElement).toContainElement(
        screen.getByLabelText('Nom'),
      );
    });
    it('masque les visites non disponibles et retire les badges si l’identité est modifiée', async () => {
      mocks.get.mockImplementation((path: string) => {
        if (path.startsWith('customers/suggestions?'))
          return Promise.resolve({
            data: [
              {
                id: 'c1',
                name: 'Alice Martin',
                phone: '+33612345678',
                email: null,
                visitCount: null,
                lastVisitAt: null,
                badges: [{ kind: 'allergy', label: 'Allergie', detail: 'Arachides' }],
              },
            ],
          });
        if (path.startsWith('reservations/staff-availability'))
          return Promise.resolve({ slots: [{ time: '19:00', available: true, past: false }] });
        if (path === 'restaurants/org_test') return Promise.resolve({ timezone: 'Europe/Paris' });
        return Promise.resolve([]);
      });
      await openForm();
      const suggestion = await screen.findByRole('button', { name: /Alice Martin/ });
      expect(suggestion).not.toHaveTextContent('visite');
      fireEvent.click(suggestion);
      expect(screen.getAllByText('Allergie').some((node) => node.closest('li'))).toBe(true);
      fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Autre' } });
      expect(screen.getAllByText('Allergie').some((node) => node.closest('li'))).toBe(false);
    });
    it('affiche une erreur de recherche sous le champ téléphone sans déplacer le formulaire', async () => {
      mocks.get.mockImplementation((path: string) =>
        path.startsWith('customers/suggestions?')
          ? Promise.reject(new Error('CRM indisponible'))
          : path.startsWith('reservations/staff-availability')
            ? Promise.resolve({ slots: [{ time: '19:00', available: true, past: false }] })
            : path === 'restaurants/org_test'
              ? Promise.resolve({ timezone: 'Europe/Paris' })
              : Promise.resolve([]),
      );
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      fireEvent.change(screen.getByLabelText('Téléphone'), { target: { value: '0612' } });
      const message = await screen.findByText('Recherche client indisponible.');
      expect(message.parentElement).toHaveClass('absolute', 'top-full');
      expect(message.parentElement?.parentElement).toContainElement(
        screen.getByLabelText('Téléphone'),
      );
    });
    it('affiche le jour fermé ou une erreur de chargement', async () => {
      mocks.get.mockImplementation((path: string) =>
        path.startsWith('reservations/staff-availability')
          ? Promise.resolve({ slots: [] })
          : path === 'restaurants/org_test'
            ? Promise.resolve({ timezone: 'Europe/Paris' })
            : Promise.resolve([]),
      );
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      expect(await screen.findByText('Aucun créneau ce jour')).toBeInTheDocument();
    });
    it('propose de réessayer si les créneaux sont indisponibles', async () => {
      mocks.get.mockImplementation((path: string) =>
        path.startsWith('reservations/staff-availability')
          ? Promise.reject(new Error('Réseau indisponible'))
          : path === 'restaurants/org_test'
            ? Promise.resolve({ timezone: 'Europe/Paris' })
            : Promise.resolve([]),
      );
      render(<ReservationsPage />);
      fireEvent.click(await screen.findByRole('button', { name: '+ Réservation' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Réseau indisponible');
      expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
    });
    it('ouvre avec N sans intercepter la saisie', async () => {
      render(<ReservationsPage />);
      await screen.findByRole('button', { name: '+ Réservation' });
      fireEvent.keyDown(window, { key: 'n' });
      expect(
        await screen.findByRole('dialog', { name: 'Nouvelle réservation' }),
      ).toBeInTheDocument();
      const name = screen.getByLabelText('Nom');
      fireEvent.keyDown(name, { key: 'n' });
      expect(screen.getAllByRole('dialog', { name: 'Nouvelle réservation' })).toHaveLength(1);
    });
  });

  it('affiche le badge Sans table et le bouton Allouer quand tableId est null', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    render(<ReservationsPage />);
    await waitFor(() => {
      expect(screen.getByText('Sans table')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Attribuer une table' })).toBeInTheDocument();
  });
  it('montre le badge surbooking en liste et dans le panneau', async () => {
    mocks.get.mockResolvedValue([makeReservation({ overbooked: true })]);
    render(<ReservationsPage />);
    expect(await screen.findByText('Surbooking')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Alice'));
    expect(screen.getAllByText('Surbooking')).toHaveLength(2);
  });
  it('affiche le surbooking sur la carte mobile', async () => {
    mocks.isMobile = true;
    mocks.get.mockResolvedValue([makeReservation({ overbooked: true })]);
    render(<ReservationsPage />);
    expect(await screen.findByText('Surbooking')).toBeInTheDocument();
  });
  it('ouvre la création avec N depuis une ligne et accorde le compteur', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    render(<ReservationsPage />);
    const row = (await screen.findByText('Alice')).closest('tr')!;
    expect(screen.getByText('1 réservation · 2 couverts')).toBeInTheDocument();
    fireEvent.keyDown(row, { key: 'n' });
    expect(screen.getByRole('dialog', { name: 'Nouvelle réservation' })).toBeInTheDocument();
  });

  it('exclut les réservations annulées et absentes du nombre de couverts', async () => {
    mocks.get.mockResolvedValue([
      makeReservation({ partySize: 2 }),
      makeReservation({ id: 'r2', state: 'CANCELLED', partySize: 4 }),
      makeReservation({ id: 'r3', state: 'NO_SHOW', partySize: 3 }),
      makeReservation({ id: 'r4', state: 'HONORED', partySize: 5 }),
    ]);
    render(<ReservationsPage />);
    expect(await screen.findByText(/2 réservations · 7 couverts/)).toBeInTheDocument();
  });

  it('masque le revenu sans données et le montre dès qu’une valeur existe, même zéro', async () => {
    mocks.get.mockResolvedValue([makeReservation({ estimatedRevenue: null })]);
    const { unmount } = render(<ReservationsPage />);
    await screen.findByText('Alice');
    expect(screen.queryByRole('columnheader', { name: 'Revenu estimé' })).not.toBeInTheDocument();
    unmount();
    mocks.get.mockResolvedValue([makeReservation({ estimatedRevenue: 0 })]);
    render(<ReservationsPage />);
    expect(await screen.findByRole('columnheader', { name: 'Revenu estimé' })).toBeInTheDocument();
  });

  it('garde les informations mobiles dans l’ordre et affiche la note sur deux lignes', async () => {
    mocks.isMobile = true;
    mocks.get.mockImplementation((path: string) =>
      path.startsWith('customers/service-cards')
        ? Promise.resolve({
            data: [{ reservationId: 'r1', badges: [{ kind: 'regular', label: 'Habitué' }] }],
          })
        : Promise.resolve([
            makeReservation({
              specialRequests: 'Une longue note pour la réservation',
              estimatedRevenue: null,
            }),
          ]),
    );
    render(<ReservationsPage />);
    const note = await screen.findByText('Une longue note pour la réservation');
    expect(note).toHaveClass('line-clamp-2', 'whitespace-normal');
    expect(note.closest('[data-state]')).toBeNull();
    await screen.findByText('Fiche');
    const grid = screen.getByText('Heure').parentElement?.parentElement;
    expect(Array.from(grid!.children).map((item) => item.firstElementChild?.textContent)).toEqual([
      'Heure',
      'Couverts',
      'Table',
      'Notes',
      'Fiche',
    ]);
    expect(screen.queryByText('Revenu estimé')).not.toBeInTheDocument();
  });

  it('affiche les notes dans la cellule client', async () => {
    mocks.get.mockResolvedValue([makeReservation({ specialRequests: 'Terrasse au calme' })]);
    render(<ReservationsPage />);
    const note = await screen.findByText('Terrasse au calme');
    expect(note.closest('td')).toHaveTextContent('Alice');
    expect(note).toHaveClass('truncate');
    expect(screen.queryByRole('columnheader', { name: 'Notes' })).not.toBeInTheDocument();
  });

  it('bloque les couverts invalides sans afficher NaN', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Bob' } });
    for (const value of ['', '0', '21', '1.5']) {
      fireEvent.change(screen.getByLabelText('Couverts'), { target: { value } });
      expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    }
    fireEvent.change(screen.getByLabelText('Couverts'), { target: { value: '4' } });
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeEnabled();
  });

  it('annonce le déplacement avec la date et l’heure', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '18:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(mocks.toastSuccess).toHaveBeenCalledWith('Réservation déplacée au 05/06 à 18:15'),
    );
  });

  it('affiche les détails et conserve la saisie après un conflit', async () => {
    mocks.get.mockResolvedValue([
      makeReservation({ channel: 'WEB', specialRequests: 'Fenêtre', customerPhone: '0102030405' }),
    ]);
    mocks.post.mockRejectedValueOnce(
      toApiError(409, { error: 'Ce créneau est complet pour 3 couverts.' }),
    );
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByText('Alice'));
    expect(screen.getByRole('dialog', { name: 'Détail de la réservation' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Couverts'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Terrasse' } });
    expect(screen.getByText('Couverts : 2 → 3')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ce créneau est complet pour 3 couverts.',
    );
    expect(screen.getByLabelText('Notes')).toHaveValue('Terrasse');
    expect(mocks.post).toHaveBeenCalledWith('reservations/r1/staff-modification', {
      partySize: 3,
      specialRequests: 'Terrasse',
    });
  });

  it('enregistre puis recharge les réservations', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    mocks.post.mockResolvedValue({ changed: true });
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByText('Alice'));
    fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
    fireEvent.change(screen.getByLabelText('Nom'), { target: { value: 'Alice Martin' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('reservations/r1/staff-modification', {
        customerName: 'Alice Martin',
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Détail de la réservation' }),
      ).not.toBeInTheDocument(),
    );
    expect(
      mocks.get.mock.calls.filter(([path]) => String(path).startsWith('v2/reservations/day?')),
    ).toHaveLength(2);
  });

  it('ouvre le panneau depuis une carte mobile sans déclencher son action', async () => {
    mocks.isMobile = true;
    mocks.get.mockResolvedValue([makeReservation()]);
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByText('Alice'));
    expect(screen.getByRole('dialog', { name: 'Détail de la réservation' })).toBeInTheDocument();
    expect(document.querySelector('.fixed.inset-0')).toHaveClass(
      'bg-black/40',
      'backdrop-blur-none',
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it('affiche le nom de la table quand tableId est renseigné', async () => {
    mocks.get.mockResolvedValue([
      makeReservation({ tableId: 't1', table: { name: 'Terrasse 1' } }),
    ]);
    render(<ReservationsPage />);
    await waitFor(() => {
      expect(screen.getByText('Terrasse 1')).toBeInTheDocument();
    });
    expect(screen.queryByText('Sans table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attribuer une table' })).not.toBeInTheDocument();
  });

  it('cliquer sur Allouer appelle le endpoint et met à jour la ligne', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    const updated = makeReservation({ tableId: 't1', table: { name: 'Terrasse 1' } });
    mocks.post.mockResolvedValue(updated);
    render(<ReservationsPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Attribuer une table' })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Attribuer une table' }));

    await waitFor(() => {
      expect(screen.getByText('Terrasse 1')).toBeInTheDocument();
    });
    expect(mocks.post).toHaveBeenCalledWith('reservations/r1/allocate-table');
    expect(screen.queryByText('Sans table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attribuer une table' })).not.toBeInTheDocument();
  });

  it("n'affiche pas le badge Sans table ni le bouton Allouer quand le statut n'est pas actif", async () => {
    mocks.get.mockResolvedValue([makeReservation({ status: 'CANCELLED' })]);
    render(<ReservationsPage />);
    await waitFor(() => {
      expect(screen.getByText('Annulée')).toBeInTheDocument();
    });
    expect(screen.queryByText('Sans table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Attribuer une table' })).not.toBeInTheDocument();
  });

  it('annule une réservation via le contrat status du dashboard', async () => {
    mocks.get.mockResolvedValue([makeReservation()]);
    mocks.patch.mockResolvedValue(makeReservation({ status: 'CANCELLED', state: 'CANCELLED' }));
    render(<ReservationsPage />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Autres actions pour Alice' })).toBeInTheDocument();
    });

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Autres actions pour Alice' }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Annuler' }));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));

    await waitFor(() => {
      expect(mocks.patch).toHaveBeenCalledWith('reservations/r1', { status: 'CANCELLED' });
      expect(screen.getByText('Annulée')).toBeInTheDocument();
    });
  });

  it('ne propose pas de transition sur un état terminal', async () => {
    mocks.get.mockResolvedValue([makeReservation({ state: 'HONORED', status: 'SEATED' })]);
    render(<ReservationsPage />);
    await waitFor(() => expect(screen.getByText('Alice')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Terminer' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Autres actions pour Alice' }),
    ).not.toBeInTheDocument();
  });

  it('termine le service via la transition canonique et recharge la réponse serveur', async () => {
    const seated = makeReservation({ state: 'SEATED', status: 'SEATED', tableId: 't1' });
    mocks.get
      .mockResolvedValueOnce([seated])
      .mockResolvedValueOnce([
        makeReservation({ state: 'HONORED', status: 'SEATED', tableId: 't1' }),
      ]);
    mocks.patch.mockResolvedValue(undefined);
    render(<ReservationsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Terminer' }));
    await waitFor(() =>
      expect(mocks.patch).toHaveBeenCalledWith(
        'restaurants/org_test/floor-plan/reservations/r1/state',
        { state: 'HONORED' },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Terminer' })).not.toBeInTheDocument(),
    );
  });

  it('garde le statut et bloque une seconde action pendant une mutation échouée', async () => {
    let rejectMutation!: (reason: Error) => void;
    mocks.get.mockResolvedValue([makeReservation({ state: 'PENDING' })]);
    mocks.patch.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectMutation = reject;
      }),
    );
    render(<ReservationsPage />);
    const confirm = await screen.findByRole('button', { name: 'Confirmer' });
    fireEvent.click(confirm);
    expect(screen.getByRole('button', { name: 'En cours…' })).toBeDisabled();
    rejectMutation(new Error('Service indisponible'));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Service indisponible'));
    expect(screen.getByText('En attente')).toBeInTheDocument();
    expect(mocks.patch).toHaveBeenCalledTimes(1);
  });

  it('traduit un conflit d’état (créneau terminé, liste périmée) et rafraîchit la liste', async () => {
    mocks.get.mockResolvedValue([
      makeReservation({ state: 'CONFIRMED', tableId: 't1', table: { name: 'Terrasse 1' } }),
    ]);
    mocks.patch.mockRejectedValue(
      toApiError(409, { error: 'Cannot seat a reservation that has already ended' }),
    );
    render(<ReservationsPage />);

    fireEvent.click(await screen.findByRole('button', { name: 'Installer' }));

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Cette réservation a changé entre-temps ou son créneau est terminé. Liste actualisée.',
      ),
    );
    expect(screen.queryByText(/Cannot seat/)).toBeNull();
    // Chargement initial + rafraîchissement après le conflit.
    expect(
      mocks.get.mock.calls.filter(([path]) => String(path).startsWith('v2/reservations/day?')),
    ).toHaveLength(2);
  });

  it('donne sur mobile la même prochaine action et cache celles des états terminaux', async () => {
    mocks.isMobile = true;
    mocks.get.mockResolvedValue([
      makeReservation({ id: 'pending', state: 'PENDING', customerName: 'Alice' }),
      makeReservation({
        id: 'seated',
        state: 'SEATED',
        status: 'SEATED',
        customerName: 'Bob',
        tableId: 't1',
      }),
      makeReservation({
        id: 'honored',
        state: 'HONORED',
        status: 'SEATED',
        customerName: 'Charles',
      }),
    ]);
    render(<ReservationsPage />);
    await waitFor(() => expect(screen.getByText('Charles')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Confirmer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminer' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Afficher les actions' })).toHaveLength(2);
  });

  describe("File d'attente", () => {
    it("permet de basculer vers l'onglet File d'attente", async () => {
      mocks.get.mockResolvedValue([]);
      render(<ReservationsPage />);

      await waitFor(() => {
        expect(screen.getByText(/Aucune réservation le /)).toBeInTheDocument();
      });

      fireEvent.mouseDown(screen.getByRole('tab', { name: /File d'attente/i }), { button: 0 });

      await waitFor(() => {
        expect(screen.getByText(/Aucune demande en attente le /)).toBeInTheDocument();
      });
      expect(
        screen.getByRole('button', { name: 'Choisir une date dans le calendrier' }),
      ).toBeInTheDocument();
    });

    it('affiche les entrées et permet de proposer une table', async () => {
      const entry = makeWaitingListEntry();
      mocks.get.mockImplementation((path: string) => {
        if (path.includes('waiting-list')) return Promise.resolve([entry]);
        return Promise.resolve([]);
      });
      mocks.post.mockResolvedValue({ id: 'res1' });

      render(<ReservationsPage />);

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /File d'attente/i })).toBeInTheDocument();
      });

      fireEvent.mouseDown(screen.getByRole('tab', { name: /File d'attente/i }), { button: 0 });

      await waitFor(() => {
        expect(screen.getByText('Bob Dylan')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Proposer une table' }));

      await waitFor(() => {
        expect(mocks.toastSuccess).toHaveBeenCalledWith('Table proposée');
      });
      expect(mocks.post).toHaveBeenCalledWith('restaurants/org_test/waiting-list/wl1/promote');
    });

    it('affiche une erreur inline si aucune table compatible', async () => {
      const entry = makeWaitingListEntry();
      mocks.get.mockImplementation((path: string) => {
        if (path.includes('waiting-list')) return Promise.resolve([entry]);
        return Promise.resolve([]);
      });
      mocks.post.mockRejectedValue(new Error('no_compatible_table'));

      render(<ReservationsPage />);

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /File d'attente/i })).toBeInTheDocument();
      });

      fireEvent.mouseDown(screen.getByRole('tab', { name: /File d'attente/i }), { button: 0 });

      await waitFor(() => {
        expect(screen.getByText('Bob Dylan')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Proposer une table' }));

      await waitFor(() => {
        expect(mocks.toastError).toHaveBeenCalledWith('Aucune table compatible');
      });
    });

    it('dit qu’une demande a déjà reçu une table au lieu d’afficher already_promoted', async () => {
      const entry = makeWaitingListEntry();
      mocks.get.mockImplementation((path: string) =>
        Promise.resolve(path.includes('waiting-list') ? [entry] : []),
      );
      mocks.post.mockRejectedValue(new Error('already_promoted'));

      render(<ReservationsPage />);
      fireEvent.mouseDown(await screen.findByRole('tab', { name: /File d'attente/i }), {
        button: 0,
      });
      await screen.findByText('Bob Dylan');
      fireEvent.click(screen.getByRole('button', { name: 'Proposer une table' }));

      await waitFor(() =>
        expect(mocks.toastError).toHaveBeenCalledWith('Cette demande a déjà reçu une table'),
      );
      expect(screen.queryByText(/already_promoted/)).toBeNull();
    });

    it('affiche la file d’attente en cartes sur téléphone, avec le compteur au bon accord', async () => {
      mocks.isMobile = true;
      const entries = [
        makeWaitingListEntry({ id: 'wl1', position: 1 }),
        makeWaitingListEntry({ id: 'wl2', position: 2, customerFirstName: 'Carla' }),
      ];
      mocks.get.mockImplementation((path: string) =>
        Promise.resolve(path.includes('waiting-list') ? entries : []),
      );
      render(<ReservationsPage />);

      fireEvent.mouseDown(await screen.findByRole('tab', { name: /File d'attente/i }), {
        button: 0,
      });

      expect(await screen.findByRole('tab', { name: /File d'attente 2/i })).toBeInTheDocument();
      expect(screen.queryByText(/en attentes/)).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      const proposer = screen.getAllByRole('button', { name: 'Proposer une table' });
      expect(proposer).toHaveLength(2);
      mocks.post.mockResolvedValue({});
      fireEvent.click(proposer[0]);
      await waitFor(() =>
        expect(mocks.post).toHaveBeenCalledWith('restaurants/org_test/waiting-list/wl1/promote'),
      );
    });

    it("permet de retirer une entrée de la file d'attente", async () => {
      const entry = makeWaitingListEntry();
      mocks.get.mockImplementation((path: string) => {
        if (path.includes('waiting-list')) return Promise.resolve([entry]);
        return Promise.resolve([]);
      });

      render(<ReservationsPage />);

      await waitFor(() => {
        expect(screen.getByRole('tab', { name: /File d'attente/i })).toBeInTheDocument();
      });

      fireEvent.mouseDown(screen.getByRole('tab', { name: /File d'attente/i }), { button: 0 });

      await waitFor(() => {
        expect(screen.getByText('Bob Dylan')).toBeInTheDocument();
      });

      fireEvent.pointerDown(screen.getByRole('button', { name: 'Autres actions pour Bob Dylan' }), {
        button: 0,
        ctrlKey: false,
      });
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Retirer' }));
      fireEvent.click(screen.getByRole('button', { name: 'Confirmer le retrait' }));

      await waitFor(() => {
        expect(screen.queryByText('Bob Dylan')).not.toBeInTheDocument();
      });
      expect(mocks.del).toHaveBeenCalledWith('restaurants/org_test/waiting-list/wl1');
    });
  });
});

describe('ReservationsPage — jour affiché', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    Element.prototype.scrollIntoView = vi.fn();
    mocks.get.mockResolvedValue([]);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 17, 10, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('charge les réservations du jour, pas tout l’historique du compte', async () => {
    render(<ReservationsPage />);
    await waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith('v2/reservations/day?date=2026-10-17');
    });
    expect(mocks.get).not.toHaveBeenCalledWith(expect.stringContaining('limit=100'));
    expect(await screen.findByText(/Aucune réservation le samedi 17 octobre/i)).toBeInTheDocument();
  });

  it('affiche toutes les réservations du jour au-delà de 50 à la même heure', async () => {
    const rows = Array.from({ length: 51 }, (_, index) =>
      makeReservation({
        id: `r-${index}`,
        customerName: `Client ${index}`,
        reservedAt: '2026-10-17T19:00:00.000Z',
      }),
    );
    mocks.get.mockImplementation((path: string) => {
      if (path === 'v2/reservations/day?date=2026-10-17') return Promise.resolve(rows);
      return Promise.resolve([]);
    });
    render(<ReservationsPage />);
    expect(await screen.findByText('Client 50')).toBeInTheDocument();
    for (const row of rows) expect(screen.getAllByText(row.customerName)).toHaveLength(1);
  });

  it('passe au jour suivant en gardant la barre de dates à l’écran', async () => {
    render(<ReservationsPage />);
    await screen.findByText(/Aucune réservation le samedi 17 octobre/i);

    fireEvent.click(screen.getByRole('button', { name: 'Jour suivant' }));

    await waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith('v2/reservations/day?date=2026-10-18');
    });
    expect(
      await screen.findByText(/Aucune réservation le dimanche 18 octobre/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Jour précédent' })).toBeInTheDocument();
  });

  it('change la date depuis le calendrier', async () => {
    render(<ReservationsPage />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Choisir une date dans le calendrier' }),
    );
    fireEvent.click(screen.getByRole('button', { name: /dimanche 18 octobre 2026/i }));
    await waitFor(() =>
      expect(mocks.get).toHaveBeenCalledWith('v2/reservations/day?date=2026-10-18'),
    );
  });

  it('actualise le compteur de la file dès le chargement et au changement de jour', async () => {
    mocks.get.mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('waiting-list') && path.includes('2026-10-17')
          ? [makeWaitingListEntry()]
          : [],
      ),
    );
    render(<ReservationsPage />);
    expect(await screen.findByRole('tab', { name: /File d'attente 1/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Jour suivant' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: /File d'attente 0/i })).toBeInTheDocument(),
    );
    expect(mocks.get).toHaveBeenCalledWith('restaurants/org_test/waiting-list?date=2026-10-18');
  });

  it('partage le jour avec la file d’attente', async () => {
    render(<ReservationsPage />);
    await screen.findByText(/Aucune réservation le samedi 17 octobre/i);

    fireEvent.mouseDown(screen.getByRole('tab', { name: /file d.attente/i }), { button: 0 });

    await waitFor(() => {
      expect(mocks.get).toHaveBeenCalledWith('restaurants/org_test/waiting-list?date=2026-10-17');
    });
  });
});

describe('ReservationsPage — lien depuis la carte « Ce soir »', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isMobile = false;
    Element.prototype.scrollIntoView = vi.fn();
    mocks.searchParams = new URLSearchParams();
  });

  it('ouvre la réservation de l’URL dans le jour demandé', async () => {
    mocks.searchParams = new URLSearchParams({ date: '2099-06-05', reservation: 'r1' });
    mocks.get.mockResolvedValue([makeReservation({ id: 'r1', customerName: 'Alice' })]);
    render(<ReservationsPage />);

    expect(
      await screen.findByRole('dialog', { name: 'Détail de la réservation' }),
    ).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('v2/reservations/day?date=2099-06-05');
  });

  it('retire la réservation et le jour de l’URL à la fermeture, pour les rouvrir au clic suivant', async () => {
    mocks.searchParams = new URLSearchParams({ date: '2099-06-05', reservation: 'r1' });
    mocks.get.mockResolvedValue([makeReservation({ id: 'r1' })]);
    render(<ReservationsPage />);
    await screen.findByRole('dialog', { name: 'Détail de la réservation' });

    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));

    expect(mocks.replace).toHaveBeenCalledTimes(1);
    const [url, options] = mocks.replace.mock.calls[0];
    expect(url).not.toContain('reservation=');
    expect(url).not.toContain('date=');
    expect(options).toEqual({ scroll: false });
  });
});
