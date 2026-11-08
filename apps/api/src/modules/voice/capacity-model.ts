/**
 * Seuil d'appels simultanés CALCULÉ, jamais posé à la main.
 *
 * Deux contraintes physiques du processus API (Node mono-thread, redémarré par PM2 au-delà d'une
 * mémoire donnée) :
 *  - CPU : un appel coûte une fraction de cœur, mesurée sur le trafic réel (capacity-sampler.ts) ;
 *  - mémoire : un appel coûte des octets de RSS, mesurés de même, avant que PM2 ne redémarre le
 *    processus (ce qui coupe tous les appels).
 * Le seuil est le plus bas des deux. Seules les marges de sécurité ci-dessous sont des choix.
 */

/** Marge : le cœur de l'API ne dépasse pas 70 % de son temps, le reste absorbe les pointes. */
export const CPU_TARGET_UTILIZATION = 0.7;
/** Marge : le RSS reste sous 80 % de la limite de redémarrage PM2. */
export const MEMORY_TARGET_RATIO = 0.8;
/** Échantillons (10 s chacun, au moins un appel actif) avant de croire les coûts mesurés : 30 min d'appels. */
export const MIN_ACTIVE_SAMPLES = 180;
/**
 * Coût mémoire par appel avant toute mesure en production : le plus haut relevé du rapport de charge du
 * 21/09/2026 (2,77 Mo à 20 sessions, docs/audits/2026-09-21-voice-load-report.md). Remplacé par la
 * mesure réelle dès qu'elle existe.
 */
export const BOOTSTRAP_RSS_PER_SESSION_BYTES = 2.77 * 1024 * 1024;

export interface CapacityStats {
  /** Fraction de cœur consommée sans aucun appel, et RSS au repos (moyennes glissantes). */
  idleCpu: number | null;
  idleRss: number | null;
  /** Échantillons avec au moins un appel actif, et cumuls pour les ratios. */
  activeSamples: number;
  sumSessions: number;
  sumDeltaCpu: number;
  sumDeltaRss: number;
}

export interface CapacityBasis {
  samples: number;
  /** Fraction de cœur par appel ; null tant que le trafic réel n'a pas été assez mesuré. */
  cpuPerSession: number | null;
  rssPerSessionBytes: number;
  rssPerSessionSource: 'measured' | 'benchmark';
  baselineRssBytes: number;
  memoryLimitBytes: number;
  cpuLimit: number | null;
  memoryLimit: number;
  binding: 'cpu' | 'memory';
}

export function computeCapacity(
  stats: CapacityStats,
  context: { memoryLimitBytes: number; currentRssBytes: number },
): { limit: number; basis: CapacityBasis } {
  const measured = stats.activeSamples >= MIN_ACTIVE_SAMPLES && stats.sumSessions > 0;
  const cpuPerSession =
    measured && stats.sumDeltaCpu > 0 ? stats.sumDeltaCpu / stats.sumSessions : null;
  const measuredRss =
    measured && stats.sumDeltaRss > 0 ? stats.sumDeltaRss / stats.sumSessions : null;
  const rssPerSessionBytes = measuredRss ?? BOOTSTRAP_RSS_PER_SESSION_BYTES;
  const baselineRssBytes = stats.idleRss ?? context.currentRssBytes;

  const memoryLimit = Math.max(
    1,
    Math.floor(
      (context.memoryLimitBytes * MEMORY_TARGET_RATIO - baselineRssBytes) / rssPerSessionBytes,
    ),
  );
  const cpuLimit =
    cpuPerSession !== null ? Math.max(1, Math.floor(CPU_TARGET_UTILIZATION / cpuPerSession)) : null;
  const binding = cpuLimit !== null && cpuLimit < memoryLimit ? 'cpu' : 'memory';

  return {
    limit: binding === 'cpu' ? (cpuLimit as number) : memoryLimit,
    basis: {
      samples: stats.activeSamples,
      cpuPerSession,
      rssPerSessionBytes,
      rssPerSessionSource: measuredRss !== null ? 'measured' : 'benchmark',
      baselineRssBytes,
      memoryLimitBytes: context.memoryLimitBytes,
      cpuLimit,
      memoryLimit,
      binding,
    },
  };
}
