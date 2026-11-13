import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AdminMarginPage from './page';

const apiMocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));

vi.mock('@/lib/api', () => ({
  useApi: () => ({ get: apiMocks.get, post: apiMocks.post }),
}));

function currentMonthKey(): string {
  const now = new Date();
  return String(now.getUTCFullYear()) + '-' + String(now.getUTCMonth() + 1).padStart(2, '0');
}

function previousMonthKey(): string {
  const now = new Date();
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return (
    String(previous.getUTCFullYear()) + '-' + String(previous.getUTCMonth() + 1).padStart(2, '0')
  );
}

function report(rows: unknown[], month = currentMonthKey()) {
  return {
    month,
    priceSource: 'LOCAL_CATALOG',
    revenueStatus: 'NOT_STRIPE_RECONCILED',
    rows,
  };
}

function pricedRow(overrides: Record<string, unknown> = {}) {
  return {
    restaurantId: 'restaurant-1',
    restaurantName: 'Chez Suppernote',
    plan: 'PRO',
    catalogPriceEur: 299,
    estimatedCostEur: '12.500000',
    adjustedCostEur: '12.500000',
    knownAdjustedCostEur: '12.500000',
    approvedAdjustmentCostEur: '0.000000',
    approvedAdjustmentCount: 0,
    pricedEventCount: 1,
    unpricedEventCount: 0,
    costStatus: 'PRICED',
    grossMarginEur: '286.500000',
    grossMarginPercent: '95.82',
    categories: [
      {
        category: 'TELEPHONY_SECONDS',
        quantity: '120.000000',
        estimatedCostEur: '12.500000',
        pricedCostEur: '12.500000',
        costStatus: 'PRICED',
        pricedEvents: 1,
        unpricedEvents: 0,
      },
    ],
    ...overrides,
  };
}

const adjustment = {
  id: 'adjustment-1',
  reportHash: 'a'.repeat(64),
  evidenceRef: 'vault://invoice.json',
  scopeKey: 'restaurant:rest-1',
  restaurantId: 'rest-1',
  category: 'SMS_SEGMENTS',
  provider: 'telnyx',
  unit: 'segments',
  periodStart: '2026-09-01T00:00:00.000Z',
  periodEnd: '2026-10-01T00:00:00.000Z',
  quantityDelta: '-2.000000',
  costDeltaEur: '0.015000',
  status: 'OPEN',
  reason: 'Écart relevé sur la facture.',
  decisionReason: null,
  createdAt: '2026-09-14T12:00:00.000Z',
  updatedAt: '2026-09-14T12:00:00.000Z',
};

describe('AdminMarginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith('admin/usage/margin')) {
        return report([pricedRow()], path.split('month=')[1] ?? currentMonthKey());
      }
      return { data: [], hasMore: false, nextCursor: null };
    });
    apiMocks.post.mockResolvedValue({});
  });

  it('affiche les coûts confirmés, la marge indicative et un export lié au mois courant', async () => {
    render(<AdminMarginPage />);

    expect(await screen.findByRole('heading', { name: 'Coût opérationnel' })).toBeInTheDocument();
    expect(screen.getByText('Chez Suppernote')).toBeInTheDocument();
    expect(screen.getByText('Tarifé')).toBeInTheDocument();
    expect(screen.getAllByText(/12,50/).length).toBeGreaterThan(0);
    expect(screen.getByText(/286,50/)).toBeInTheDocument();
    expect(screen.getByText(/revenus Stripe non rapprochés/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Télécharger le suivi interne/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeDisabled();
    expect(apiMocks.get).toHaveBeenCalledWith('admin/usage/margin?month=' + currentMonthKey());
  });

  it('recharge rapport et export quand la période change', async () => {
    render(<AdminMarginPage />);
    await screen.findByText('Établissements', { exact: true });

    fireEvent.change(screen.getByLabelText('Période du rapport'), {
      target: { value: '2026-09' },
    });

    await waitFor(() =>
      expect(apiMocks.get).toHaveBeenCalledWith('admin/usage/margin?month=2026-09'),
    );
    // L'export suit la période choisie.
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(['a']) });
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:csv');
    URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole('button', { name: /Télécharger le suivi interne/ }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/proxy/admin/usage/accounting-export.csv?month=2026-09',
      ),
    );
    vi.unstubAllGlobals();
  });

  it('n’interroge pas l’API tant que le mois saisi est incomplet (Firefox, Safari)', async () => {
    render(<AdminMarginPage />);
    await screen.findByText('Établissements', { exact: true });
    const callsBefore = apiMocks.get.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Période du rapport'), { target: { value: '2026-1' } });

    expect(apiMocks.get.mock.calls.length).toBe(callsBefore);
    expect(screen.queryByText(/month must use/)).toBeNull();
  });

  it('affiche l’échec d’un export dans la page, sans la quitter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    render(<AdminMarginPage />);
    await screen.findByText('Établissements', { exact: true });

    fireEvent.click(screen.getByRole('button', { name: /Télécharger le suivi interne/ }));

    expect(
      await screen.findByText('Cet export est réservé à l’équipe Suppernote.'),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
  });

  it('ignore une réponse de rapport obsolète après un changement de mois', async () => {
    const selectedMonth = previousMonthKey();
    let resolveCurrentMonth: ((value: ReturnType<typeof report>) => void) | undefined;
    apiMocks.get.mockImplementation((path: string) => {
      if (!path.startsWith('admin/usage/margin')) {
        return Promise.resolve({ data: [], hasMore: false, nextCursor: null });
      }
      if (path.endsWith(`month=${currentMonthKey()}`)) {
        return new Promise((resolve) => {
          resolveCurrentMonth = resolve;
        });
      }
      return Promise.resolve(
        report([pricedRow({ restaurantName: 'Restaurant du mois choisi' })], selectedMonth),
      );
    });

    render(<AdminMarginPage />);
    await waitFor(() => expect(resolveCurrentMonth).toBeTypeOf('function'));
    fireEvent.change(screen.getByLabelText('Période du rapport'), {
      target: { value: selectedMonth },
    });

    expect(await screen.findByText('Restaurant du mois choisi')).toBeInTheDocument();
    await act(async () => {
      resolveCurrentMonth!(report([pricedRow({ restaurantName: 'Ancienne réponse' })]));
    });

    expect(screen.getByText('Restaurant du mois choisi')).toBeInTheDocument();
  });

  it('signale les usages non tarifés sans fabriquer une marge ni un coût nul', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith('admin/usage/margin')) {
        return report([
          pricedRow({
            estimatedCostEur: '0.000000',
            adjustedCostEur: '0.000000',
            knownAdjustedCostEur: '0.000000',
            pricedEventCount: 0,
            unpricedEventCount: 2,
            costStatus: 'UNPRICED',
            grossMarginEur: null,
            grossMarginPercent: null,
            categories: [],
          }),
        ]);
      }
      return { data: [], hasMore: false, nextCursor: null };
    });

    render(<AdminMarginPage />);

    expect(await screen.findByText('Non tarifé')).toBeInTheDocument();
    expect(screen.getByText('2 usage(s) à rapprocher')).toBeInTheDocument();
    expect(screen.getAllByText('À rapprocher')).toHaveLength(2);
    expect(screen.getByText('Usages à rapprocher')).toBeInTheDocument();
  });

  it('ouvre le détail des usages sans encombrer le tableau', async () => {
    render(<AdminMarginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Détail de Chez Suppernote' }));

    expect(await screen.findByText(/Détail des usages/)).toBeInTheDocument();
    expect(screen.getByText('TELEPHONY_SECONDS')).toBeInTheDocument();
    expect(screen.getByText('120.000000')).toBeInTheDocument();
  });

  it('permet d’examiner et décider une correction avec un motif', async () => {
    apiMocks.get.mockImplementation(async (path: string) => {
      if (path.startsWith('admin/usage/margin')) return report([]);
      return { data: [adjustment], hasMore: false, nextCursor: null };
    });

    render(<AdminMarginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Examiner' }));
    expect(await screen.findByText('Écart relevé sur la facture.')).toBeInTheDocument();
    expect(screen.getByText('vault://invoice.json')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approuver' }));
    fireEvent.change(screen.getByLabelText('Motif de la décision'), {
      target: { value: 'Vérifié sur la facture fournisseur.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Confirmer la décision' }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'admin/usage/reconciliation-adjustments/adjustment-1/decision',
        { status: 'APPROVED', reason: 'Vérifié sur la facture fournisseur.' },
      ),
    );
  });

  it('crée une correction à valider avec sa preuve et sa portée', async () => {
    render(<AdminMarginPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Nouvelle correction' }));

    fireEvent.change(screen.getByLabelText('Hash SHA-256 du rapport'), {
      target: { value: 'b'.repeat(64) },
    });
    fireEvent.change(screen.getByLabelText('Référence de preuve'), {
      target: { value: 'vault://facture-test' },
    });
    fireEvent.change(screen.getByLabelText('Fournisseur'), { target: { value: 'telnyx' } });
    fireEvent.change(screen.getByLabelText('Unité'), { target: { value: 'segments' } });
    fireEvent.change(screen.getByLabelText('Delta de coût (€)'), { target: { value: '0.15' } });
    fireEvent.change(screen.getByLabelText('Motif'), { target: { value: 'Correction de test' } });
    fireEvent.change(screen.getByLabelText('Portée'), { target: { value: 'global' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer à valider' }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith(
        'admin/usage/reconciliation-adjustments',
        expect.objectContaining({
          reportHash: 'b'.repeat(64),
          evidenceRef: 'vault://facture-test',
          scopeKey: 'global',
          restaurantId: null,
          category: 'TELEPHONY_SECONDS',
          provider: 'telnyx',
          unit: 'segments',
          costDeltaEur: '0.15',
          reason: 'Correction de test',
        }),
      ),
    );
  });
});
