import { describe, expect, it, vi } from 'vitest';
import { readEntitlements } from './entitlements';

describe('readEntitlements', () => {
  it('partage une seule requête entre lecteurs concurrents, puis relit ensuite', async () => {
    let resolve: (value: unknown) => void = () => {};
    const get = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );

    const first = readEntitlements('org_1', get as never);
    const second = readEntitlements('org_1', get as never);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('entitlements');

    resolve({ restaurantId: 'org_1', capabilities: { 'pos.connect': true } });
    await expect(first).resolves.toMatchObject({ capabilities: { 'pos.connect': true } });
    await expect(second).resolves.toMatchObject({ restaurantId: 'org_1' });

    const later = readEntitlements('org_1', get as never);
    expect(get).toHaveBeenCalledTimes(2);
    resolve({ restaurantId: 'org_1', capabilities: {} });
    await later;
  });

  it('libère la requête en cas d’échec pour que le nouvel essai parte', async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new Error('réseau'))
      .mockResolvedValueOnce({ restaurantId: 'org_1', capabilities: {} });

    await expect(readEntitlements('org_1', get)).rejects.toThrow('réseau');
    await expect(readEntitlements('org_1', get)).resolves.toMatchObject({ capabilities: {} });
    expect(get).toHaveBeenCalledTimes(2);
  });
});
