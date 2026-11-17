import { describe, it, expect } from 'vitest';
import {
  HEARTBEAT_MAX_ORIGINS,
  originFromHeader,
  oldestOrigin,
  recordHeartbeat,
  type HeartbeatRedis,
} from '../embed-heartbeat.store';

// Hash en mémoire : seules les commandes utilisées par le store.
function memoryRedis() {
  const hashes = new Map<string, Map<string, string>>();
  const hash = (key: string) => {
    let value = hashes.get(key);
    if (!value) {
      value = new Map();
      hashes.set(key, value);
    }
    return value;
  };
  const redis = {
    hset: async (key: string, field: string, value: string) => {
      hash(key).set(field, value);
      return 1;
    },
    hdel: async (key: string, field: string) => (hash(key).delete(field) ? 1 : 0),
    hgetall: async (key: string) => Object.fromEntries(hash(key)),
    expire: async () => 1,
  };
  return { redis: redis as unknown as HeartbeatRedis, hashes };
}

const BASE = Date.UTC(2026, 10, 1);
const at = (seconds: number) => new Date(BASE + seconds * 1000);
const input = (origin: string) => ({ origin, version: '1.0', mode: 'inline' as const, buttons: 1 });

describe('recordHeartbeat — plafond d’origines', () => {
  it('remplace la plus ancienne origine quand le plafond est atteint', async () => {
    const { redis, hashes } = memoryRedis();
    for (let i = 0; i < HEARTBEAT_MAX_ORIGINS; i++) {
      await recordHeartbeat(redis, 'r1', input(`https://fake-${i}.test`), at(i));
    }
    await recordHeartbeat(redis, 'r1', input('https://vraie.chez-x.fr'), at(1000));

    const entries = hashes.get('embed:heartbeat:r1')!;
    expect(entries.size).toBe(HEARTBEAT_MAX_ORIGINS);
    expect(entries.has('https://vraie.chez-x.fr')).toBe(true);
    expect(entries.has('https://fake-0.test')).toBe(false);
    expect(entries.has('https://fake-1.test')).toBe(true);
  });

  it('ne supprime rien quand une origine déjà connue est mise à jour', async () => {
    const { redis, hashes } = memoryRedis();
    for (let i = 0; i < HEARTBEAT_MAX_ORIGINS; i++) {
      await recordHeartbeat(redis, 'r1', input(`https://fake-${i}.test`), at(i));
    }
    await recordHeartbeat(redis, 'r1', input('https://fake-10.test'), at(2000));

    const entries = hashes.get('embed:heartbeat:r1')!;
    expect(entries.size).toBe(HEARTBEAT_MAX_ORIGINS);
    expect(entries.has('https://fake-0.test')).toBe(true);
    expect(JSON.parse(entries.get('https://fake-10.test')!).at).toBe(at(2000).toISOString());
  });
});

describe('oldestOrigin', () => {
  it('considère une entrée illisible comme la plus ancienne', () => {
    expect(
      oldestOrigin({
        'https://a.test': JSON.stringify({ at: '2026-11-02T00:00:00.000Z' }),
        'https://b.test': 'pas du json',
      }),
    ).toBe('https://b.test');
  });

  it('renvoie undefined sans entrée', () => {
    expect(oldestOrigin({})).toBeUndefined();
  });
});

describe('originFromHeader', () => {
  it('garde seulement l’origine http(s)', () => {
    expect(originFromHeader('https://www.chez-x.fr')).toBe('https://www.chez-x.fr');
    expect(originFromHeader('http://chez-x.fr:8080/menu')).toBe('http://chez-x.fr:8080');
  });

  it.each([undefined, '', 'null', 'javascript:alert(1)'])('ignore %s', (value) => {
    expect(originFromHeader(value)).toBeUndefined();
  });
});
