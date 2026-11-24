/**
 * Point d'entrée du process workers (PM2 `suppernote-workers`).
 *
 * Ce process ne sert aucun HTTP : il consomme les files BullMQ et porte
 * l'inscription des jobs récurrents. Séparer les deux topologies évite qu'un
 * crash de worker fasse tomber l'API, et permet de redémarrer l'un sans
 * l'autre.
 *
 * En développement, l'API démarre aussi les workers (`RUN_WORKERS_IN_PROCESS`),
 * pour que `pnpm dev` reste utilisable sans second terminal.
 */

import { closeSentry, initSentry } from './shared/sentry/client';
import { logger } from './shared/logger/pino';
import { queues } from './shared/queue/queues';
import { registerJobSchedulers } from './shared/queue/schedulers';
import { closeRegisteredWorkers } from './shared/queue/workers/registry';
import { redisCache, redisQueue, redisSession } from './shared/redis/client';
import {
  startMetricsServer,
  type MetricsServerHandle,
} from './shared/observability/metrics-server';
import { startWorkerHeartbeat } from './shared/health/watchtower';
import './workers/index';

initSentry();

let shuttingDown = false;
let metricsServer: MetricsServerHandle | null = null;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Workers shutting down gracefully...');

  // 0. L'endpoint de métriques d'abord : pendant que les workers terminent
  //    leur job en cours, Prometheus peut encore lire leur état.
  if (metricsServer) {
    await metricsServer.close().catch(() => undefined);
    metricsServer = null;
  }

  // 1. Les workers d'abord : ils terminent le job en cours avant de rendre la
  //    main, ce qui évite de laisser un job actif orphelin.
  const closed = await closeRegisteredWorkers();

  // 2. Les files et les trois connexions Redis (session, cache, queue).
  await Promise.all(Object.values(queues).map((queue) => queue.close().catch(() => undefined)));
  await Promise.all(
    [redisSession, redisCache, redisQueue].map((client) => client.quit().catch(() => undefined)),
  );

  await closeSentry();
  logger.info({ closed }, 'Workers stopped');
  process.exit(0);
}

async function start(): Promise<void> {
  logger.info('Suppernote workers starting');

  // Endpoint de métriques (R1-6) : sans lui, les jauges de files et de SLO
  // publiées par ce process ne sont lisibles par personne.
  metricsServer = await startMetricsServer();

  await registerJobSchedulers();
  // Battement lu par l'API : sans lui pendant 3 minutes, alerte « workers arrêtés ».
  startWorkerHeartbeat();

  logger.info('Suppernote workers ready');
  // PM2 `wait_ready` attend ce signal avant de considérer le process démarré.
  if (typeof process.send === 'function') {
    process.send('ready');
  }

  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch((err) => logger.error({ err }, 'SIGTERM shutdown failed'));
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT').catch((err) => logger.error({ err }, 'SIGINT shutdown failed'));
  });
}

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[workers][unhandledRejection]');
});

if (!process.env.VITEST) {
  start().catch((err) => {
    logger.error({ err }, '[workers] start failed');
    process.exitCode = 1;
  });
}
