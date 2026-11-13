/**
 * Routes pilot KPIs :
 *   - GET /api/internal/pilot-kpis : agrège les 5 KPIs cibles
 *
 * Ces KPIs passent par le vhost public de l'API : « interne » décrit leur
 * audience, pas leur accessibilité. La route exige donc une identité
 * opérateur Suppernote, comme les autres routes `/api/internal/*`.
 */

import type { FastifyInstance } from 'fastify';
import { PilotKpiService } from './pilot-kpis.service';
import { logger } from '../../shared/logger/pino';
import { db } from '../../shared/db/client';
import { requirePlatformOperator } from '../../plugins/clerk';

export async function pilotRoutes(app: FastifyInstance): Promise<void> {
  const service = new PilotKpiService(db);

  app.get(
    '/api/internal/pilot-kpis',
    { preHandler: requirePlatformOperator() },
    async (_req, reply) => {
      try {
        const kpis = await service.getKpis();
        return reply.send(kpis);
      } catch (err) {
        logger.error({ err }, 'pilot kpis failed');
        return reply.status(500).send({ error: 'Internal error' });
      }
    },
  );
}
