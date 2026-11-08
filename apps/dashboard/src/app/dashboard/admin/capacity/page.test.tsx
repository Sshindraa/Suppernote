import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AdminCapacityPage from './page';

const mocks = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), del: vi.fn() }));
vi.mock('@/lib/api', () => ({ useApi: () => mocks }));

const report = {
  limit: 60,
  source: 'calculated' as const,
  basis: {
    samples: 40,
    cpuPerSession: null,
    rssPerSessionBytes: 2.77 * 1024 * 1024,
    rssPerSessionSource: 'benchmark' as const,
    baselineRssBytes: 218 * 1024 * 1024,
    memoryLimitBytes: 500 * 1024 * 1024,
    cpuLimit: null,
    memoryLimit: 65,
    binding: 'memory' as const,
  },
  activeNow: 3,
  peakToday: 9,
  peak7d: 31,
  utilization: 31 / 60,
  level: 'warning' as const,
  thresholds: { warning: 0.5, critical: 0.7 },
  history: [
    { day: '2026-11-07', peak: 12 },
    { day: '2026-11-08', peak: 9 },
  ],
  cpuMeasured: false,
  generatedAt: '2026-11-08T12:00:00.000Z',
};

describe('capacité vocale (admin)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue({ ok: true, capacity: report });
  });

  it('affiche le seuil, l’usage et le niveau d’alerte', async () => {
    render(<AdminCapacityPage />);
    expect(await screen.findByText('Capacité vocale')).toBeTruthy();
    expect(await screen.findByText(/52 % du seuil/)).toBeTruthy();
    expect(screen.getByText(/Anticiper/)).toBeTruthy();
    expect(screen.getByText('Calculé sur les mesures')).toBeTruthy();
    expect(screen.getByText('Comment le seuil est calculé')).toBeTruthy();
    expect(screen.getByText(/Mémoire : 65 appels/)).toBeTruthy();
    expect(screen.getByText(/CPU : pas encore mesuré/)).toBeTruthy();
    expect(screen.getByText(/40 mesures de 10 s/)).toBeTruthy();
    expect(mocks.get).toHaveBeenCalledWith('admin/voice-capacity');
  });

  it('enregistre un nouveau seuil, et seulement s’il est valide et modifié', async () => {
    mocks.put.mockResolvedValue({
      ok: true,
      capacity: { ...report, limit: 90, source: 'dashboard', setBy: 'user_1' },
    });
    render(<AdminCapacityPage />);
    const input = (await screen.findByLabelText(/Appels simultanés/)) as HTMLInputElement;
    const button = screen.getByRole('button', { name: 'Enregistrer' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(input, { target: { value: '0' } });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Entrez un entier entre 1 et 500.')).toBeTruthy();

    fireEvent.change(input, { target: { value: '90' } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);

    await waitFor(() =>
      expect(mocks.put).toHaveBeenCalledWith('admin/voice-capacity', { limit: 90 }),
    );
    expect(await screen.findByText(/Seuil enregistré/)).toBeTruthy();
    expect(screen.getByText('Réglé depuis cette page')).toBeTruthy();
  });

  it('propose de revenir à la valeur du serveur quand le seuil vient du dashboard', async () => {
    mocks.get.mockResolvedValue({
      ok: true,
      capacity: { ...report, limit: 90, source: 'dashboard', setBy: 'user_1' },
    });
    mocks.del.mockResolvedValue({ ok: true, capacity: report });
    render(<AdminCapacityPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revenir à la valeur du serveur' }));
    await waitFor(() => expect(mocks.del).toHaveBeenCalledWith('admin/voice-capacity'));
  });

  it('montre l’erreur et permet de réessayer', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Service indisponible'));
    render(<AdminCapacityPage />);
    expect(await screen.findByText('Service indisponible')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByText(/52 % du seuil/)).toBeTruthy();
  });
});
