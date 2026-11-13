import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requirePlatformOperator } from '../../plugins/clerk';
import { db } from '../../shared/db/client';
import {
  ProvisioningNotReadyError,
  ProvisioningService,
  ProvisioningTestCallNotPendingError,
} from './provisioning.service';

const AssignPhoneSchema = z.object({
  phoneNumber: z.string().regex(/^\+[1-9]\d{9,14}$/, 'Numéro E.164 requis (ex: +33612345678)'),
  telnyxPhoneNumberId: z.string().optional(),
});

const TestCallSchema = z.object({
  targetPhoneNumber: z
    .string()
    .regex(/^\+[1-9]\d{9,14}$/, 'Numéro E.164 requis (ex: +33612345678)')
    .optional(),
});

const ValidateTestCallSchema = z.object({
  callControlId: z.string().trim().min(1).max(128),
});

const provisioningMutationRateLimit = {
  max: 30,
  timeWindow: '1 minute',
} as const;

export async function provisioningRoutes(app: FastifyInstance) {
  // Liste des numéros Telnyx disponibles dans l'inventaire
  app.get(
    '/admin/provisioning/available-numbers',
    { preHandler: requirePlatformOperator() },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const { numbers, source } = await ProvisioningService.listAvailableNumbers();
        return reply.send({ ok: true, numbers, source });
      } catch (err: unknown) {
        app.log.error({ err }, 'Failed to fetch available Telnyx numbers');
        return reply
          .status(500)
          .send({ error: 'Erreur lors de la récupération des numéros Telnyx' });
      }
    },
  );

  // Liste globale de tous les restaurants avec leur statut de provisioning
  app.get(
    '/admin/provisioning/restaurants',
    { preHandler: requirePlatformOperator() },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      try {
        const restaurants = await db.restaurant.findMany({
          select: {
            id: true,
            name: true,
            managerEmail: true,
            managerPhone: true,
            phoneNumber: true,
            provisioningStatus: true,
            forwardingConfiguredAt: true,
            testCallValidatedAt: true,
            firstCallAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        });

        const items = await Promise.all(
          restaurants.map((r) => ProvisioningService.getProvisioningStatus(r.id)),
        );

        return reply.send({ ok: true, count: items.length, restaurants: items });
      } catch (err: unknown) {
        app.log.error({ err }, 'Failed to list restaurants provisioning status');
        return reply
          .status(500)
          .send({ error: 'Erreur lors du chargement des statuts de provisioning' });
      }
    },
  );

  // Obtenir le statut détaillé d'un restaurant spécifique
  app.get<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      const { restaurantId } = req.params;
      try {
        const status = await ProvisioningService.getProvisioningStatus(restaurantId);
        return reply.send({ ok: true, status });
      } catch (err: unknown) {
        app.log.error({ err, restaurantId }, 'Failed to get restaurant provisioning status');
        return reply.status(404).send({ error: 'Restaurant non trouvé ou statut indisponible' });
      }
    },
  );

  // 1. Attribution d'un numéro Telnyx à un restaurant
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/assign-phone',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;
      const body = AssignPhoneSchema.parse(req.body ?? {});

      try {
        const status = await ProvisioningService.assignPhoneNumber(
          restaurantId,
          body.phoneNumber,
          body.telnyxPhoneNumberId,
        );
        return reply.send({
          ok: true,
          message: `Numéro ${body.phoneNumber} attribué avec succès au restaurant.`,
          status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error(
          {
            err,
            restaurantId,
            hasPhoneNumber: Boolean(body.phoneNumber),
            hasTelnyxPhoneNumberId: Boolean(body.telnyxPhoneNumberId),
          },
          'Failed to assign phone number',
        );
        return reply.status(400).send({ error: message });
      }
    },
  );

  // 2. Vérification du Webhook
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/verify-webhook',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;

      try {
        const status = await ProvisioningService.verifyWebhook(restaurantId);
        return reply.send({
          ok: true,
          message: 'Webhook vérifié avec succès.',
          status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err, restaurantId }, 'Failed to verify webhook');
        return reply.status(400).send({ error: message });
      }
    },
  );

  // 3. Attestation du renvoi d'appel par l'opérateur du restaurant
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/mark-forwarding',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;

      try {
        const status = await ProvisioningService.markForwardingConfigured(restaurantId);
        return reply.send({
          ok: true,
          message: "Renvoi d'appel marqué comme configuré.",
          status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error({ err, restaurantId }, 'Failed to mark call forwarding');
        return reply.status(400).send({ error: message });
      }
    },
  );

  // 4. Déclenchement de l'appel test (la validation est une action distincte)
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/test-call',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;
      const body = TestCallSchema.parse(req.body ?? {});

      const restaurant = await db.restaurant.findUnique({
        where: { id: restaurantId },
        select: { managerPhone: true },
      });

      const targetPhone = body.targetPhoneNumber ?? restaurant?.managerPhone;
      if (!targetPhone) {
        return reply.status(400).send({
          error:
            'Numéro de téléphone cible manquant. Renseignez targetPhoneNumber ou le numéro du gérant.',
        });
      }

      try {
        const result = await ProvisioningService.triggerTestCall(restaurantId, targetPhone);
        return reply.send({
          ok: true,
          callControlId: result.callControlId,
          message: `Appel test déclenché vers ${targetPhone}.`,
          status: result.status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        app.log.error(
          { err, restaurantId, hasTargetPhone: Boolean(targetPhone) },
          'Failed to trigger test call',
        );
        return reply.status(502).send({ error: message });
      }
    },
  );

  // 5. Confirmation manuelle de l'appel reçu et entendu
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/validate-test-call',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;
      const body = ValidateTestCallSchema.parse(req.body ?? {});

      try {
        const status = await ProvisioningService.validateTestCall(restaurantId, body.callControlId);
        return reply.send({
          ok: true,
          message: 'Appel test confirmé comme reçu et entendu.',
          status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ProvisioningTestCallNotPendingError) {
          app.log.warn({ restaurantId }, 'Test call validation rejected');
          return reply.status(409).send({ error: message, code: err.code });
        }
        app.log.error({ err, restaurantId }, 'Failed to validate test call');
        return reply.status(400).send({ error: message });
      }
    },
  );

  // 6. Finaliser et marquer le pilote comme 100% actif
  app.post<{ Params: { restaurantId: string } }>(
    '/admin/provisioning/:restaurantId/complete',
    { preHandler: requirePlatformOperator(), config: { rateLimit: provisioningMutationRateLimit } },
    async (req, reply) => {
      const { restaurantId } = req.params;

      try {
        const status = await ProvisioningService.completeProvisioning(restaurantId);
        return reply.send({
          ok: true,
          message: 'Pilote restaurant finalisé et activé avec succès.',
          status,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (err instanceof ProvisioningNotReadyError) {
          app.log.warn({ restaurantId, missing: err.missing }, 'Provisioning is not ready');
          return reply.status(409).send({ error: message, code: err.code, missing: err.missing });
        }
        app.log.error({ err, restaurantId }, 'Failed to complete provisioning');
        return reply.status(400).send({ error: message });
      }
    },
  );
}
