import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import PwaInstallBanner from '../PwaInstallBanner';

const pathnameState = vi.hoisted(() => ({ value: '/dashboard' }));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));

// Mock triggerHaptic (évite d'appeler navigator.vibrate)
vi.mock('@/lib/utils', () => ({
  triggerHaptic: vi.fn(),
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
}));

describe('PwaInstallBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pathnameState.value = '/dashboard';
    localStorage.clear();
    // Default: desktop userAgent, pas standalone
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'standalone', {
      value: false,
      configurable: true,
    });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ne s'affiche pas si déjà dismiss (localStorage)", () => {
    localStorage.setItem('sokar_pwa_dismissed', 'true');
    // iOS userAgent pour vérifier que le dismiss prend le pas
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });

    render(<PwaInstallBanner />);
    // Avance les timers au-delà du délai de 1.5s
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });

  it("s'affiche sur iOS Safari après le délai", () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });

    render(<PwaInstallBanner />);

    // Pas encore affiché (délai 1.5s)
    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(screen.getByText('Installer Suppernote AI')).toBeInTheDocument();
  });

  it("ne s'affiche pas sur desktop (non-iOS)", () => {
    // userAgent desktop (défini dans beforeEach)
    render(<PwaInstallBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });

  it('ne recouvre pas les écrans opérationnels secondaires', () => {
    pathnameState.value = '/dashboard/reservations';
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });

    render(<PwaInstallBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });

  it("ne s'affiche pas si déjà en standalone (PWA installée)", () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'standalone', {
      value: true,
      configurable: true,
    });

    render(<PwaInstallBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });

  it.each(['SuppernoteIOS', 'SokarIOS'])("ne s'affiche pas dans l'appli iOS (%s)", (appMarker) => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: `Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 ${appMarker}`,
      configurable: true,
    });

    render(<PwaInstallBanner />);
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });

  it('clic dismiss sauvegarde dans localStorage', () => {
    Object.defineProperty(window.navigator, 'userAgent', {
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      configurable: true,
    });

    render(<PwaInstallBanner />);

    act(() => {
      vi.advanceTimersByTime(1600);
    });

    expect(screen.getByText('Installer Suppernote AI')).toBeInTheDocument();
    expect(localStorage.getItem('sokar_pwa_dismissed')).toBeNull();

    const dismissBtn = screen.getByRole('button', { name: 'Dismiss banner' });
    // fireEvent fonctionne avec les fake timers (pas de delay interne)
    fireEvent.click(dismissBtn);

    expect(localStorage.getItem('sokar_pwa_dismissed')).toBe('true');
    expect(screen.queryByText('Installer Suppernote AI')).not.toBeInTheDocument();
  });
});
