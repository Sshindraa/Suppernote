import { FastifyInstance } from 'fastify';
import { requirePlatformOperator } from '../../plugins/clerk';
import { buildRestaurantHealth } from './restaurant-health.service';

/**
 * Route admin « santé du restaurant » — consommée par la page dashboard
 * /dashboard/admin/health. Lecture seule.
 */
export async function restaurantHealthRoutes(app: FastifyInstance) {
  app.get<{ Params: { restaurantId: string } }>(
    '/admin/restaurants/:restaurantId/health',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      const { restaurantId } = req.params;
      try {
        const health = await buildRestaurantHealth(restaurantId);
        if (!health) {
          return reply.status(404).send({ error: 'Restaurant non trouvé' });
        }
        return reply.send({ ok: true, health });
      } catch (err: unknown) {
        app.log.error({ err, restaurantId }, 'Failed to build restaurant health');
        return reply
          .status(500)
          .send({ error: 'Erreur lors du chargement de la santé du restaurant' });
      }
    },
  );
}
