import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CardGuaranteeView from './card-guarantee-view';

const TOKEN = `${'a'.repeat(32)}.${'b'.repeat(43)}`;
const status = {
  status: 'awaiting_card',
  restaurantName: 'Restaurant Exemple',
  date: '2026-11-20',
  time: '19:00',
  partySize: 6,
  amountPerPerson: '20.00',
  totalAmount: '120.00',
  cancellationHours: 24,
  freeCancellationUntil: '2026-11-19T18:00:00.000Z',
  expiresAt: '2026-11-13T12:00:00.000Z',
};

function openAt(search: string) {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { search, assign, href: `https://suppernote.test/garantie${search}` },
  });
  return assign;
}

describe('page d’empreinte bancaire', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('demande l’acceptation avant d’ouvrir la page Stripe', async () => {
    const assign = openAt(`?r=exemple&t=${TOKEN}`);
    const fetch = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? Response.json({ checkoutUrl: 'https://checkout.stripe.test/cs_1' })
        : Response.json(status),
    );
    vi.stubGlobal('fetch', fetch);
    render(<CardGuaranteeView />);

    expect(await screen.findByText(/Aucun montant n’est débité aujourd’hui/)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Enregistrer ma carte' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByLabelText('J’accepte ces conditions d’annulation.'));
    fireEvent.click(button);

    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://checkout.stripe.test/cs_1'));
    expect(fetch).toHaveBeenCalledWith(
      `/api/proxy/public/r/exemple/card-guarantee/${TOKEN}/checkout`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ accepted: true }) }),
    );
  });

  it('confirme la réservation une fois la carte enregistrée', async () => {
    openAt(`?r=exemple&t=${TOKEN}&retour=ok`);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ ...status, status: 'confirmed' })),
    );
    render(<CardGuaranteeView />);
    expect(await screen.findByText('Votre réservation est confirmée')).toBeInTheDocument();
  });

  it('explique un lien incomplet', async () => {
    openAt('?r=exemple');
    vi.stubGlobal('fetch', vi.fn());
    render(<CardGuaranteeView />);
    expect(await screen.findByText('Lien introuvable')).toBeInTheDocument();
  });
});
