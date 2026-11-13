import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post, put: mocks.put, orgId: 'restaurant' }),
}));
vi.mock('@/lib/use-capabilities', () => ({
  useCapabilities: () => ({ 'reservations.payments': true }),
}));
vi.mock('@/components/gift-cards/gift-card-stripe-connect', () => ({
  GiftCardStripeConnect: ({
    onReadinessChange,
  }: {
    onReadinessChange: (ready: boolean) => void;
  }) => {
    onReadinessChange(true);
    return <p>Compte Stripe prêt</p>;
  },
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));

import { ApiError } from '@/lib/api-error';
import { CardGuaranteeSettingsCard } from './card-guarantee-settings-card';
import { ReservationCardGuarantee } from './reservation-card-guarantee';

const SETTINGS = {
  enabled: false,
  minPartySize: 6,
  protectedDates: [],
  amountPerPerson: '20.00',
  cancellationHours: 24,
  version: null,
};

describe('réglages de l’empreinte bancaire', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('montre le texte client et active avec les valeurs choisies', async () => {
    mocks.get.mockResolvedValue({ data: SETTINGS });
    mocks.put.mockResolvedValue({ data: { ...SETTINGS, enabled: true, version: 1 } });
    render(<CardGuaranteeSettingsCard restaurantName="Chez Test" />);

    expect(await screen.findByText(/soit 120 € pour 6 personnes/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Date protégée'), { target: { value: '2026-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Activer l’empreinte bancaire' }));

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('reservation-guarantee/settings', {
        enabled: true,
        minPartySize: 6,
        protectedDates: ['2026-12-31'],
        amountPerPerson: '20.00',
        cancellationHours: 24,
      }),
    );
    expect(await screen.findByRole('button', { name: 'Couper' })).toBeInTheDocument();
  });

  it('ne s’affiche pas quand la fonction est coupée', async () => {
    mocks.get.mockRejectedValue(new ApiError('Indisponible', 503, 'RESERVATION_PAYMENTS_DISABLED'));
    const { container } = render(<CardGuaranteeSettingsCard restaurantName="Chez Test" />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});

describe('empreinte sur la fiche réservation', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  const payment = {
    status: 'AUTHORIZED',
    amount: '120.00',
    capturedAmount: null,
    refundedAmount: null,
    failureCode: null,
    disputeStatus: null,
    expiresAt: null,
  };

  it('prélève un montant réduit après confirmation, une fois l’absence marquée', async () => {
    mocks.get.mockResolvedValue({ data: payment });
    mocks.post.mockResolvedValue({ data: { outcome: 'PENDING_CONFIRMATION' } });
    render(
      <ReservationCardGuarantee
        reservation={{ id: 'res-1', reservedAt: new Date().toISOString(), state: 'NO_SHOW' }}
      />,
    );

    expect(await screen.findByText(/Carte enregistrée/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Montant (€)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Prélever 60 €' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prélever' }));

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith('reservations/res-1/payment/capture', {
        amount: '60.00',
      }),
    );
  });

  it('ne propose pas de prélever une réservation honorée', async () => {
    mocks.get.mockResolvedValue({ data: payment });
    render(
      <ReservationCardGuarantee
        reservation={{ id: 'res-1', reservedAt: new Date().toISOString(), state: 'CONFIRMED' }}
      />,
    );
    expect(await screen.findByText(/Carte enregistrée/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Prélever/ })).toBeNull();
  });

  it('explique un refus de la banque', async () => {
    mocks.get.mockResolvedValue({ data: payment });
    mocks.post.mockRejectedValue(new ApiError('Refus', 402, null));
    render(
      <ReservationCardGuarantee
        reservation={{ id: 'res-1', reservedAt: new Date().toISOString(), state: 'CANCELLED' }}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Prélever 120 €' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prélever' }));
    expect(await screen.findByText(/La banque a refusé le prélèvement/)).toBeInTheDocument();
  });

  it('propose de rembourser le reste prélevé', async () => {
    mocks.get.mockResolvedValue({
      data: {
        ...payment,
        status: 'PARTIALLY_REFUNDED',
        capturedAmount: '60.00',
        refundedAmount: '20.00',
      },
    });
    render(
      <ReservationCardGuarantee
        reservation={{ id: 'res-1', reservedAt: new Date().toISOString(), state: 'NO_SHOW' }}
      />,
    );
    expect(await screen.findByRole('button', { name: 'Rembourser 40 €' })).toBeInTheDocument();
  });

  it('ne montre rien sans empreinte', async () => {
    mocks.get.mockResolvedValue({ data: null });
    const { container } = render(
      <ReservationCardGuarantee
        reservation={{ id: 'res-1', reservedAt: new Date().toISOString(), state: 'CONFIRMED' }}
      />,
    );
    await waitFor(() => expect(mocks.get).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
