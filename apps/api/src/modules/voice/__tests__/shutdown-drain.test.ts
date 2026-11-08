import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { waitForVoiceCallsToEnd } from '../stream/shutdown-drain';

describe('waitForVoiceCallsToEnd', () => {
  it('rend la main tout de suite sans appel en cours', async () => {
    const activeCount = vi.fn().mockResolvedValue(0);
    expect(await waitForVoiceCallsToEnd({ activeCount, pollMs: 1 })).toBe(0);
    expect(activeCount).toHaveBeenCalledTimes(1);
  });

  it('attend la fin des appels puis rend 0', async () => {
    const activeCount = vi
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1)
      .mockResolvedValue(0);
    expect(await waitForVoiceCallsToEnd({ activeCount, pollMs: 1, graceMs: 1_000 })).toBe(0);
    expect(activeCount).toHaveBeenCalledTimes(3);
  });

  it('abandonne à l’échéance et rend le nombre d’appels encore actifs', async () => {
    const activeCount = vi.fn().mockResolvedValue(3);
    expect(await waitForVoiceCallsToEnd({ activeCount, pollMs: 5, graceMs: 30 })).toBe(3);
  });
});
