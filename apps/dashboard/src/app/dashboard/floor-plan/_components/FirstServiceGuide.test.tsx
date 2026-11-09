import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRST_SERVICE_GUIDE_STORAGE_KEY, FirstServiceGuide } from './FirstServiceGuide';

describe('FirstServiceGuide', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pointe les deux gestes la première fois, puis se ferme et s’en souvient', () => {
    const { unmount } = render(<FirstServiceGuide />);
    const guide = screen.getByRole('complementary', { name: 'Guide du premier service' });
    expect(guide).toHaveTextContent('Walk-in');
    expect(guide).toHaveTextContent('Libérer la table');

    fireEvent.click(screen.getByRole('button', { name: 'Compris' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(window.localStorage.getItem(FIRST_SERVICE_GUIDE_STORAGE_KEY)).toBe('1');

    unmount();
    render(<FirstServiceGuide />);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('s’affiche et se ferme normalement quand le stockage est indisponible', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('stockage bloqué');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('stockage bloqué');
    });

    render(<FirstServiceGuide />);
    expect(screen.getByRole('complementary', { name: 'Guide du premier service' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Compris' }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });
});
