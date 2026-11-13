import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformOperator } from '../../plugins/clerk';
import { getSystemMetrics } from './system-metrics.service';

const QuerySchema = z.object({ range: z.enum(['6h', '24h', '7d']).default('24h') });

/** Courbes de supervision (Prometheus) pour la page admin Capacité et système, réservées aux opérateurs. */
export async function systemMetricsRoutes(app: FastifyInstance) {
  app.get(
    '/admin/system-metrics',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Période invalide (6h, 24h ou 7d)' });
      }
      try {
        const panels = await getSystemMetrics(parsed.data.range);
        return reply.send({
          ok: true,
          range: parsed.data.range,
          panels,
          generatedAt: new Date().toISOString(),
        });
      } catch (err: unknown) {
        app.log.error({ err }, 'Failed to build system metrics');
        return reply.status(500).send({ error: 'Erreur lors du chargement des courbes' });
      }
    },
  );
}
