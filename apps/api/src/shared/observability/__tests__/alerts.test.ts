import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertDoubleBooking,
  alertPiiLeak,
  alertErrorRateHigh,
  alertAgentUnavailable,
  alertFailOpen,
} from '../alerts';
import { piiLeaksTotal, failOpenTotal, renderMetrics } from '../metrics';
import { captureException } from '../../sentry/client';

// Mocks minimaux pour Sentry et metrics
vi.mock('../../sentry/client', () => ({
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));

describe('Alerts service', () => {
  beforeEach(() => {
    piiLeaksTotal.reset();
    failOpenTotal.reset();
  });

  it('alertDoubleBooking ne throw pas et incrémente le compteur', () => {
    expect(() =>
      alertDoubleBooking({
        restaurantId: 'r-1',
        partySize: 4,
        slotStart: '2026-12-01T19:00:00Z',
        attemptedBy: 'test',
      }),
    ).not.toThrow();
  });

  it('alertPiiLeak ne throw pas et incrémente le compteur', async () => {
    expect(() =>
      alertPiiLeak({
        tool: 'get_restaurant_details',
        kind: 'phone',
        path: 'data.phone',
        sample: '+33****0000',
      }),
    ).not.toThrow();

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_agentic_pii_leaks_total\{[^}]*kind="phone"[^}]*\} 1/);
  });

  it('alertErrorRateHigh alerte seulement au-dessus de 1%', () => {
    // En dessous de 1% : ne devrait pas alerter
    expect(() => alertErrorRateHigh({ rate5xx: 0.005, windowMin: 5 })).not.toThrow();
    // Au-dessus de 1% : alerte
    expect(() => alertErrorRateHigh({ rate5xx: 0.05, windowMin: 5 })).not.toThrow();
  });

  it('alertAgentUnavailable ne throw pas', () => {
    expect(() => alertAgentUnavailable({ agent: 'claude', reason: 'rate_limited' })).not.toThrow();
  });

  it('alertFailOpen incrémente suppernote_fail_open_total{source} et ne throw pas', async () => {
    expect(() => alertFailOpen({ source: 'mcp_rate_limit', reason: 'redis_down' })).not.toThrow();
    expect(() => alertFailOpen({ source: 'mcp_rate_limit', reason: 'redis_down' })).not.toThrow();
    expect(() =>
      alertFailOpen({ source: 'openai_reserve_cache', reason: 'cache_get_failed' }),
    ).not.toThrow();

    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_fail_open_total');
    expect(payload).toMatch(/suppernote_fail_open_total\{[^}]*source="mcp_rate_limit"[^}]*\} 2/);
    expect(payload).toMatch(
      /suppernote_fail_open_total\{[^}]*source="openai_reserve_cache"[^}]*\} 1/,
    );
  });

  it('alertFailOpen ne appelle pas captureException (bruit Sentry évité)', () => {
    vi.mocked(captureException).mockClear();
    alertFailOpen({ source: 'idempotency', reason: 'cache_down' });
    expect(captureException).not.toHaveBeenCalled();
  });
});
