import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePlatformOperator } from '../../plugins/clerk';
import {
  previewCustomerMetricSnapshotRepair,
  repairCustomerMetricSnapshot,
} from '../customers/customer-crm.service';
import { projectionRepairErrorResponse } from '../customers/customer-crm.routes';

const ParamsSchema = z.object({
  restaurantId: z.string().trim().min(1).max(128),
  customerId: z.string().trim().min(1).max(128),
});

/**
 * Recalcul des chiffres d'un client (visites, couverts, no-show) depuis ses réservations,
 * réservé aux opérateurs Suppernote : l'outil a quitté la fiche du restaurateur.
 */
export async function adminCustomerRepairRoutes(app: FastifyInstance) {
  app.get(
    '/admin/restaurants/:restaurantId/customers/:customerId/projection-repair-preview',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      const { restaurantId, customerId } = ParamsSchema.parse(req.params);
      try {
        return reply.send({
          data: await previewCustomerMetricSnapshotRepair({ restaurantId, customerId }),
        });
      } catch (error) {
        const response = projectionRepairErrorResponse(error, reply);
        if (response) return response;
        throw error;
      }
    },
  );

  app.post(
    '/admin/restaurants/:restaurantId/customers/:customerId/projection-repair',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      const { restaurantId, customerId } = ParamsSchema.parse(req.params);
      const header = req.headers['idempotency-key'];
      try {
        const result = await repairCustomerMetricSnapshot({
          restaurantId,
          customerId,
          idempotencyKey: (Array.isArray(header) ? header[0] : header) ?? '',
          actor: req.userId ? `operator:${req.userId}` : undefined,
        });
        return reply.status(result.replayed ? 200 : 201).send({ data: result });
      } catch (error) {
        const response = projectionRepairErrorResponse(error, reply);
        if (response) return response;
        throw error;
      }
    },
  );
}
