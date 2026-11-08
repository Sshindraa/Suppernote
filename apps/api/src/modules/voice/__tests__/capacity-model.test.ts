import { describe, expect, it } from 'vitest';
import {
  BOOTSTRAP_RSS_PER_SESSION_BYTES,
  MIN_ACTIVE_SAMPLES,
  computeCapacity,
  type CapacityStats,
} from '../capacity-model';

const MB = 1024 * 1024;
const empty: CapacityStats = {
  idleCpu: null,
  idleRss: null,
  activeSamples: 0,
  sumSessions: 0,
  sumDeltaCpu: 0,
  sumDeltaRss: 0,
};

describe('seuil calculé', () => {
  it('sans trafic mesuré : borne la mémoire avec le coût du rapport de charge, CPU inconnu', () => {
    const { limit, basis } = computeCapacity(empty, {
      memoryLimitBytes: 500 * MB,
      currentRssBytes: 218 * MB,
    });
    // (500 × 0,8 − 218) / 2,77 = 65,7 → 65
    expect(limit).toBe(Math.floor((500 * MB * 0.8 - 218 * MB) / BOOTSTRAP_RSS_PER_SESSION_BYTES));
    expect(limit).toBe(65);
    expect(basis).toMatchObject({
      binding: 'memory',
      cpuPerSession: null,
      cpuLimit: null,
      rssPerSessionSource: 'benchmark',
    });
  });

  it('ignore des coûts mesurés sur trop peu d’échantillons', () => {
    const { basis } = computeCapacity(
      {
        ...empty,
        activeSamples: MIN_ACTIVE_SAMPLES - 1,
        sumSessions: 100,
        sumDeltaCpu: 5,
        sumDeltaRss: 1e9,
      },
      { memoryLimitBytes: 500 * MB, currentRssBytes: 200 * MB },
    );
    expect(basis.cpuPerSession).toBeNull();
    expect(basis.rssPerSessionSource).toBe('benchmark');
  });

  it('retient la contrainte la plus basse, CPU ou mémoire', () => {
    const base = {
      idleCpu: 0.02,
      idleRss: 200 * MB,
      activeSamples: 500,
      sumSessions: 2_000,
    };
    // 0,5 % de cœur par appel → 140 en CPU ; 4 Mo par appel → 50 en mémoire.
    const memory = computeCapacity(
      { ...base, sumDeltaCpu: 10, sumDeltaRss: 2_000 * 4 * MB },
      { memoryLimitBytes: 500 * MB, currentRssBytes: 0 },
    );
    expect(memory.basis).toMatchObject({ cpuLimit: 140, memoryLimit: 50, binding: 'memory' });
    expect(memory.limit).toBe(50);

    // 2 % de cœur par appel → 35 en CPU ; 1 Mo par appel → 200 en mémoire.
    const cpu = computeCapacity(
      { ...base, sumDeltaCpu: 40, sumDeltaRss: 2_000 * MB },
      { memoryLimitBytes: 500 * MB, currentRssBytes: 0 },
    );
    expect(cpu.basis).toMatchObject({ cpuLimit: 35, memoryLimit: 200, binding: 'cpu' });
    expect(cpu.limit).toBe(35);
  });

  it('ne descend jamais sous un appel', () => {
    const { limit } = computeCapacity(empty, {
      memoryLimitBytes: 100 * MB,
      currentRssBytes: 400 * MB,
    });
    expect(limit).toBe(1);
  });
});
