import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WebSocket } from 'ws';
import { db } from '../../shared/db/client';
import { RestaurantService } from '../restaurants/restaurant.service';
import { CustomerService } from '../customers/customer.service';
import { buildSystemPrompt, type OpeningHours } from '../voice/prompts';
import { CallSessionManager } from '../voice/stream/manager';
import { logger } from '../../shared/logger/pino';

const SimulateCallSchema = z.object({
  /** Numéro de l'appelant */
  callerPhone: z.string().min(5),
  /** Optionnel : numéro du restaurant (sans numéro, utilise le numéro de test par défaut) */
  restaurantPhone: z.string().min(5).optional(),
  /** Mode enregistré sur l'appel de test (le mode « mock » à outils n'existe plus : simple libellé). */
  mode: z.enum(['auto', 'mock']).default('auto'),
});

/**
 * Crée un faux WebSocket utilisable par CallSessionManager en mode simulation.
 * Il ignore les messages audio/TTS et logue ce qui serait envoyé à Telnyx.
 */
function createFakeTelnyxWs(): WebSocket {
  const ws = {
    readyState: WebSocket.OPEN,
    send: (data: unknown) => {
      try {
        const parsed = JSON.parse(typeof data === 'string' ? data : String(data));
        if (parsed.event === 'media') {
          // En mode simulation on ignore le flux audio retourné.
          return;
        }
        logger.debug({ telnyxMsg: parsed }, '[test-sim] WS -> Telnyx');
      } catch {
        logger.debug({ raw: data }, '[test-sim] WS -> Telnyx (raw)');
      }
    },
    close: () => {
      // noop
    },
    on: () => {
      // noop
    },
  } as unknown as WebSocket;
  return ws;
}

/**
 * Routes de test pour simuler un appel vocal sans Telnyx ni providers audio.
 *
 * Usage :
 *   curl -X POST http://localhost:4000/api/test/simulate-call \
 *     -H 'Content-Type: application/json' \
 *     -d '{"callerPhone": "+336****5678", "mode": "mock"}'
 */
export async function testRoutes(app: FastifyInstance) {
  app.post(
    '/api/test/simulate-call',
    // Route de test uniquement (ENABLE_TEST_ROUTES=true, jamais en production).
    // Le harnais de charge R1-3 doit pouvoir créer N sessions d'affilée ; le
    // budget global de 100 req/min le plafonnerait à 99.
    { config: { rateLimit: { max: 2_000, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const body = SimulateCallSchema.parse(req.body);
      const { callerPhone, restaurantPhone, mode } = body;

      const phone = restaurantPhone ?? '+331****0405';
      const restaurant = await db.restaurant.findUnique({
        where: { phoneNumber: phone },
        include: { personality: true },
      });

      if (!restaurant) {
        return reply.status(404).send({ error: 'Restaurant not found', phone });
      }

      const ctx = await RestaurantService.loadContext(phone);
      await RestaurantService.recordMonthlyCall(ctx.id);

      const caller = await CustomerService.lookupOrCreate(ctx.id, callerPhone);
      const customer = await CustomerService.withVoiceProfile(ctx.id, caller);
      const customerExtra = CustomerService.buildVipPromptExtra(customer, {
        timezone: ctx.timezone,
      });
      const systemPrompt = buildSystemPrompt({
        ...ctx,
        openingHours: ctx.openingHours as OpeningHours,
        customerExtra,
      });

      // Créer un Call record en DB
      const callControlId = `test-call-${Date.now()}`;
      const callSessionId = `test-session-${Date.now()}`;
      await db.call.create({
        data: {
          id: callControlId,
          callSid: callControlId,
          restaurantId: ctx.id,
          carrier: 'test-simulation',
          sttProvider: 'test',
          llmProvider: mode,
          ttsProvider: 'test',
        },
      });

      // Créer la session en mémoire
      const mgr = CallSessionManager.getInstance();
      mgr.create({
        callControlId,
        callSessionId,
        from: callerPhone,
        to: phone,
        restaurantId: ctx.id,
        restaurantName: ctx.name,
        giftCardMinimumAmount: ctx.giftCardMinimumAmount ?? undefined,
        systemPrompt,
        isVip: customer?.isVip ?? false,
        telnyxWs: createFakeTelnyxWs(),
        callLegId: callControlId,
        codec: 'PCMU',
        personality: restaurant.personality
          ? {
              fillerStyle: restaurant.personality.fillerStyle,
              systemPromptExtra: restaurant.personality.systemPromptExtra,
            }
          : null,
      });

      return reply.send({
        test: true,
        mode,
        callControlId,
        restaurant: { id: ctx.id, name: ctx.name, plan: ctx.plan },
        caller: {
          phone: callerPhone,
          name: customer?.name ?? null,
          isVip: customer?.isVip ?? false,
        },
      });
    },
  );

  /**
   * GET /api/test/simulate-call/:callControlId/reservations
   * Vérifier les réservations créées pendant un appel simulé.
   */
  app.get('/api/test/simulate-call/:callControlId/reservations', async (req, reply) => {
    const { callControlId } = req.params as { callControlId: string };
    const reservations = await db.reservation.findMany({
      where: { callId: callControlId },
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(reservations);
  });

  /**
   * GET /api/test/restaurants — lister les restaurants test créés
   */
  app.get('/api/test/restaurants', async (_req, reply) => {
    const restaurants = await db.restaurant.findMany({
      where: { id: { startsWith: 'test-' } },
      include: {
        personality: true,
        _count: { select: { calls: true, reservations: { where: { isTest: false } } } },
      },
    });
    return reply.send(restaurants);
  });

  /**
   * DELETE /api/test/restaurants — nettoyer les restaurants test
   */
  app.delete('/api/test/restaurants', async (_req, reply) => {
    const result = await db.restaurant.deleteMany({
      where: { id: { startsWith: 'test-' } },
    });
    return reply.send({ deleted: result.count });
  });
}
