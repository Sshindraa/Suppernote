import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireSokarOperator } from '../../plugins/clerk';
import {
  CAPACITY_LIMIT_MAX,
  CAPACITY_LIMIT_MIN,
  clearCapacityLimit,
  getVoiceCapacityReport,
  setCapacityLimit,
} from '../voice/call-capacity';

const SetLimitSchema = z.object({
  limit: z.number().int().min(CAPACITY_LIMIT_MIN).max(CAPACITY_LIMIT_MAX),
});

/**
 * Pilotage de la capacité vocale depuis le dashboard admin (opérateurs Suppernote) : seuil courant,
 * usage (en cours, pic du jour, pic sur 7 jours) et réglage du seuil sans redéploiement.
 */
export async function voiceCapacityRoutes(app: FastifyInstance) {
  app.get('/admin/voice-capacity', { preHandler: requireSokarOperator() }, async (_req, reply) => {
    try {
      return reply.send({ ok: true, capacity: await getVoiceCapacityReport() });
    } catch (err: unknown) {
      app.log.error({ err }, 'Failed to build voice capacity report');
      return reply.status(500).send({ error: 'Erreur lors du chargement de la capacité vocale' });
    }
  });

  app.put('/admin/voice-capacity', { preHandler: requireSokarOperator() }, async (req, reply) => {
    const parsed = SetLimitSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: `Le seuil doit être un entier entre ${CAPACITY_LIMIT_MIN} et ${CAPACITY_LIMIT_MAX}`,
      });
    }
    const actor = (req as { userId?: string }).userId ?? 'operator';
    try {
      await setCapacityLimit(parsed.data.limit, actor);
      app.log.warn({ actor, limit: parsed.data.limit }, 'Voice capacity limit changed');
      return reply.send({ ok: true, capacity: await getVoiceCapacityReport() });
    } catch (err: unknown) {
      app.log.error({ err }, 'Failed to set voice capacity limit');
      return reply.status(500).send({ error: 'Impossible d’enregistrer le seuil' });
    }
  });

  app.delete(
    '/admin/voice-capacity',
    { preHandler: requireSokarOperator() },
    async (req, reply) => {
      const actor = (req as { userId?: string }).userId ?? 'operator';
      try {
        await clearCapacityLimit();
        app.log.warn({ actor }, 'Voice capacity limit reset to environment value');
        return reply.send({ ok: true, capacity: await getVoiceCapacityReport() });
      } catch (err: unknown) {
        app.log.error({ err }, 'Failed to reset voice capacity limit');
        return reply.status(500).send({ error: 'Impossible de rétablir le seuil' });
      }
    },
  );
}
