import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './page';
import ReservationView from './reservation-view';

const token = `${'a'.repeat(27)}.${'b'.repeat(43)}`;
const data = {
  restaurantName: 'Restaurant Exemple',
  restaurantPhone: '+33100000000',
  date: '2026-10-18',
  time: '19:00',
  partySize: 2,
  state: 'CONFIRMED',
  whatsappReminder: { visible: true, enabled: true },
};
describe('Ma reservation', () => {
  it('shows the booking confirmation without a management link or an API request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(
      <ReservationView
        confirmation={{
          reservation: { ...data, whatsappReminder: { visible: false, enabled: false } },
        }}
      />,
    );
    expect(await screen.findByText('Confirmée')).toBeInTheDocument();
    expect(screen.getByText('Restaurant Exemple')).toBeInTheDocument();
    expect(screen.getByText('19h00')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('loads management actions directly in the confirmation without navigating', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ ...data, state: 'CANCELLED' }));
    vi.stubGlobal('fetch', fetch);
    render(
      <ReservationView
        confirmation={{ reservation: data, managementUrl: `https://suppernote.com/r#${token}` }}
      />,
    );
    expect(await screen.findByText('Annulée')).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ token, action: 'view' });
  });
  it('keeps the confirmed booking visible when loading management fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connexion interrompue')));
    render(
      <ReservationView
        confirmation={{ reservation: data, managementUrl: `https://suppernote.com/r#${token}` }}
      />,
    );
    expect(await screen.findByText('Connexion interrompue')).toBeInTheDocument();
    expect(screen.getByText('Confirmée')).toBeInTheDocument();
  });
  it('withdraws WhatsApp consent from the confirmation when management is disabled', async () => {
    const fetch = vi.fn();
    const withdrawWhatsapp = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetch);
    render(<ReservationView confirmation={{ reservation: data, withdrawWhatsapp }} />);
    await screen.findByText('Confirmée');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByText('Préférences de rappel'));
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/Votre accord a été retiré/)).toBeInTheDocument();
    expect(withdrawWhatsapp).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('previews the same UI without network calls or a dialable phone', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ReservationView demo />);
    expect(await screen.findByText('Restaurant Exemple')).toBeInTheDocument();
    expect(screen.getByText('Aperçu de démonstration')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Appeler le restaurant', hidden: true }),
    ).toBeDisabled();
    expect(screen.getByText('Préférences de rappel').closest('details')).not.toHaveAttribute(
      'open',
    );
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByText('Préférences de rappel'));
    fireEvent.click(screen.getByRole('switch'));
    expect(await screen.findByText(/Votre accord a été retiré/)).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('lets the demo modify and cancel without calling the API', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ReservationView demo />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    fireEvent.click(await screen.findByRole('button', { name: /^3 personnes$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le créneau 20h00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuer · 20h00' }));
    // Le carton garde l'heure actuelle tant que la modification n'est pas confirmée.
    expect(screen.getAllByText('19h30', { selector: 'dd span' })).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('20h00')).toBeInTheDocument();
    expect(document.querySelector('dl')).toHaveTextContent('3personnes');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    expect(screen.getByText('Annuler votre réservation ?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conserver ma réservation' }));
    expect(screen.getByText('Confirmée')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(await screen.findByText('Annulée')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Modifier la réservation' }),
    ).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    window.history.replaceState(null, '', `/r#${token}`);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });
  it('reads details without posting any mutation and puts the token only in the POST body', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json(data));
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    expect(await screen.findByText('Restaurant Exemple')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      '/api/reservation-management',
      expect.objectContaining({
        body: JSON.stringify({ token, action: 'view' }),
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      }),
    );
    expect(
      screen.getByRole('link', { name: 'Appeler le restaurant', hidden: true }),
    ).toHaveAttribute('href', 'tel:+33100000000');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('flags a test reservation only when the server says so', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...data, test: true }))
      .mockResolvedValueOnce(Response.json({ ...data, test: false }));
    vi.stubGlobal('fetch', fetch);
    const first = render(<Page />);
    expect(
      await screen.findByText('Réservation test · supprimée automatiquement sous 24 h'),
    ).toBeInTheDocument();
    first.unmount();
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    expect(screen.queryByText(/Réservation test/)).not.toBeInTheDocument();
  });
  it('only announces withdrawal after server acknowledgement', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(data))
      .mockResolvedValueOnce(
        Response.json({ ...data, whatsappReminder: { visible: true, enabled: false } }),
      );
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByText('Préférences de rappel'));
    fireEvent.click(screen.getByRole('switch', { name: 'Rappel WhatsApp' }));
    expect(await screen.findByText(/Votre accord a été retiré/)).toBeInTheDocument();
    expect(fetch.mock.calls[1][1].body).toBe(
      JSON.stringify({ token, action: 'withdraw_whatsapp' }),
    );
    expect(screen.getByRole('switch')).not.toBeChecked();
  });
  it('keeps the previous state when withdrawal fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(data))
        .mockResolvedValueOnce(new Response(null, { status: 503 })),
    );
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByText('Préférences de rappel'));
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Le retrait n’a pas pu être confirmé'),
    );
    expect(screen.getByRole('switch')).toBeChecked();
    expect(screen.queryByText(/Votre accord a été retiré/)).not.toBeInTheDocument();
  });
  it('requires explicit confirmation and updates the carton only after cancellation succeeds', async () => {
    const cancellation = {
      available: true,
      deadline: '2026-10-18T15:00:00Z',
      message: 'Annulation gratuite avant 17 h.',
      terms: 'Conditions enregistrées.',
      confirmationToken: 'quote',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...data, cancellation }))
      .mockResolvedValueOnce(
        Response.json({
          ...data,
          state: 'CANCELLED',
          cancellation: { ...cancellation, available: false },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Conserver ma réservation' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(await screen.findByText('Annulée')).toBeInTheDocument();
    expect(fetch.mock.calls[1][1].body).toBe(
      JSON.stringify({ token, action: 'cancel', confirmed: true, confirmationToken: 'quote' }),
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Ajouter au calendrier' })).not.toBeInTheDocument();
  });
  it('recovers the actual cancellation state after a lost server response', async () => {
    const cancellation = {
      available: true,
      deadline: null,
      message: 'Annulation gratuite.',
      confirmationToken: 'quote',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...data, cancellation }))
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(
        Response.json({
          ...data,
          state: 'CANCELLED',
          cancellation: { ...cancellation, available: false },
        }),
      );
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler la réservation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer l’annulation' }));
    expect(await screen.findByText('Annulée')).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[2][1].body).action).toBe('view');
  });
  it('changes the day in the shared widget while preserving the current hour when available', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ReservationView demo />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    const next = new Date();
    next.setDate(next.getDate() + 4);
    const french = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(next);
    const dateButton = await screen.findByRole('button', { name: new RegExp(french, 'i') });
    fireEvent.click(dateButton);
    const continueButton = await screen.findByRole('button', {
      name: 'Continuer · 19h30',
    });
    await waitFor(() => expect(continueButton).toBeEnabled());
    fireEvent.click(continueButton);
    expect(screen.getByRole('dialog')).toHaveTextContent('Mardi 20 octobre');
    expect(screen.getByRole('dialog')).toHaveTextContent(new RegExp(french, 'i'));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('19h30')).toBeInTheDocument();
    const summary = document.querySelector('dl')!;
    expect(summary).toHaveTextContent(String(next.getDate()));
    expect(fetch).not.toHaveBeenCalled();
  });
  it('shows every bookable day in one strip and accepts a date two months away in the calendar', async () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<ReservationView demo />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    const calendar = await screen.findByRole('button', {
      name: 'Choisir une date dans le calendrier',
    });
    const shortcutPattern = /^(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)/i;
    expect(screen.getAllByRole('button', { name: shortcutPattern }).length).toBeGreaterThan(7);
    const later = new Date();
    later.setDate(later.getDate() + 60);
    fireEvent.click(calendar);
    const picker = await screen.findByRole('dialog', { name: 'Choisir une date' });
    const label = new Intl.DateTimeFormat('fr-FR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(later);
    // The month the picker opens on depends on today's date: browse until the target appears.
    for (let i = 0; i < 24 && !within(picker).queryByRole('button', { name: label }); i++)
      fireEvent.click(within(picker).getByRole('button', { name: 'Mois suivant' }));
    fireEvent.click(within(picker).getByRole('button', { name: label }));
    const next = await screen.findByRole('button', { name: 'Continuer · 19h30' });
    await waitFor(() => expect(next).toBeEnabled());
    expect(screen.getAllByRole('button', { name: shortcutPattern }).length).toBeGreaterThan(7);
    fireEvent.click(next);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.querySelector('dl')).toHaveTextContent(
      new Intl.DateTimeFormat('fr-FR', { month: 'long' }).format(later),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('browses days without changing the booking and opens the existing cancellation confirmation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ReservationView demo />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    const browse = await screen.findByRole('button', { name: 'Jours suivants' });
    fireEvent.click(browse);
    expect(
      screen.getByRole('button', {
        name: 'Continuer',
      }),
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Jours précédents' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler ma réservation' }));
    expect(await screen.findByText('Annuler votre réservation ?')).toBeInTheDocument();
    expect(document.querySelector('dl')).toHaveTextContent('19h30');
    fireEvent.click(screen.getByRole('button', { name: 'Conserver ma réservation' }));
    expect(screen.getByText('Confirmée')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves the current carton during selection and only modifies after review and confirmation', async () => {
    const initial = {
      ...data,
      modification: { available: true, message: 'Réservation conservée.' },
    };
    const choices = {
      date: data.date,
      partySize: 2,
      maxPartySize: 4,
      slots: [{ time: '20:00', proposalToken: 'offer' }],
      message: 'Réservation conservée.',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(Response.json(choices))
      .mockResolvedValueOnce(Response.json({ ...initial, time: '20:00' }));
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le créneau 20h00' }));
    expect(document.querySelector('dl')).toHaveTextContent('19h00');
    expect(fetch.mock.calls.map((call) => JSON.parse(call[1].body).action)).toEqual([
      'view',
      'view',
      'modification_options',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Continuer · 20h00' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Votre nouveau choix');
    expect(fetch).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('20h00')).toBeInTheDocument();
    expect(JSON.parse(fetch.mock.calls[3][1].body)).toEqual({
      token,
      action: 'modify',
      confirmed: true,
      proposalToken: 'offer',
    });
  });
  it('does not mutate when the customer closes the modification dialog', async () => {
    const initial = { ...data, modification: { available: true, message: 'Conservée' } };
    const fetch = vi.fn().mockImplementation(async (_url, options) =>
      JSON.parse(options.body).action === 'modification_options'
        ? Response.json({
            date: data.date,
            partySize: 2,
            maxPartySize: 4,
            slots: [],
            message: 'Aucun autre créneau disponible.',
          })
        : Response.json(initial),
    );
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    await screen.findByText('Aucun autre créneau disponible.');
    fireEvent.click(screen.getByRole('button', { name: 'Quitter sans modifier' }));
    expect(fetch.mock.calls.every((call) => JSON.parse(call[1].body).action !== 'modify')).toBe(
      true,
    );
    expect(document.querySelector('dl')).toHaveTextContent('19h00');
  });
  it('recovers an applied modification after a lost response without sending it twice', async () => {
    const initial = { ...data, modification: { available: true, message: 'Conservée' } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(
        Response.json({
          date: data.date,
          partySize: 2,
          maxPartySize: 4,
          slots: [{ time: '20:00', proposalToken: 'offer' }],
          message: 'Conservée',
        }),
      )
      .mockRejectedValueOnce(new Error('Connection lost'))
      .mockResolvedValueOnce(Response.json({ ...initial, time: '20:00' }));
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le créneau 20h00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuer · 20h00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('20h00')).toBeInTheDocument();
    expect(
      fetch.mock.calls.filter((call) => JSON.parse(call[1].body).action === 'modify'),
    ).toHaveLength(1);
  });
  it('keeps an unconfirmed change visible as an error in French after a network failure', async () => {
    const initial = { ...data, modification: { available: true, message: 'Conservée' } };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(Response.json(initial))
      .mockResolvedValueOnce(
        Response.json({
          date: data.date,
          partySize: 2,
          maxPartySize: 4,
          slots: [{ time: '20:00', proposalToken: 'offer' }],
          message: 'Conservée',
        }),
      )
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json(initial));
    vi.stubGlobal('fetch', fetch);
    render(<Page />);
    await screen.findByText('Restaurant Exemple');
    fireEvent.click(document.querySelector('details > summary')!);
    fireEvent.click(screen.getByRole('button', { name: 'Modifier la réservation' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Choisir le créneau 20h00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continuer · 20h00' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la modification' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'La modification n’a pas pu être confirmée',
    );
    expect(document.querySelector('dl')).toHaveTextContent('19h00');
    expect(
      fetch.mock.calls.filter((call) => JSON.parse(call[1].body).action === 'modify'),
    ).toHaveLength(1);
  });
  it('shows an expired link without disclosing stale details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    render(<Page />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Ce lien est invalide ou a expiré');
    expect(screen.queryByText('Restaurant Exemple')).not.toBeInTheDocument();
  });
  it.each([
    ['PENDING', 'En attente'],
    ['CANCELLED', 'Annulée'],
  ])('does not label a %s booking as confirmed', async (state, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...data, state })));
    render(<Page />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.queryByText('Réservation confirmée')).not.toBeInTheDocument();
  });
});
