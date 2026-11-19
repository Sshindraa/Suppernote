import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  CustomerChangesBanner,
  describeCustomerChange,
  latestChangeByReservation,
  type CustomerChange,
} from './customer-changes';

vi.mock('@/lib/api', () => ({ useApi: () => ({ orgId: 'rest-1', get: vi.fn() }) }));

const at = (h: number, m = 0) => new Date(2099, 5, 5, h, m).toISOString();
const modified: CustomerChange = {
  reservationId: 'r1',
  kind: 'modified',
  at: at(18, 2),
  customerName: 'Alice',
  partySize: 4,
  startsAt: at(21, 30),
  previousStartsAt: at(20),
  previousPartySize: 2,
};
const cancelled: CustomerChange = {
  ...modified,
  reservationId: 'r2',
  kind: 'cancelled',
  at: at(17),
  customerName: 'Bob',
  previousStartsAt: null,
  previousPartySize: null,
};

describe('customer changes', () => {
  beforeEach(() => localStorage.clear());

  it('décrit l’ancien et le nouvel horaire', () => {
    expect(describeCustomerChange(modified)).toContain('20:00 → 21:30, 2 → 4 pers.');
    expect(describeCustomerChange(cancelled)).toContain('Bob a annulé');
  });

  it('garde le dernier changement de chaque réservation', () => {
    const older = { ...modified, at: at(10) };
    expect(latestChangeByReservation([modified, older, cancelled]).get('r1')).toBe(modified);
  });

  it('masque le bandeau après « J’ai vu » et le réaffiche pour un nouveau changement', () => {
    const { rerender } = render(<CustomerChangesBanner changes={[modified, cancelled]} />);
    expect(screen.getByText('2 changements faits par des clients')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'J’ai vu' }));
    expect(screen.queryByRole('status')).toBeNull();
    const later = { ...cancelled, reservationId: 'r3', at: at(19) };
    rerender(<CustomerChangesBanner changes={[later, modified, cancelled]} />);
    expect(screen.getByText('1 changement fait par un client')).toBeTruthy();
  });
});
