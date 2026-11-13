/**
 * Routes admin — funnel d'onboarding.
 *
 * GET /admin/onboarding-funnel  : agrège les onboarding_events en funnel
 *   de conversion par étape. Permet de mesurer le taux de complétion
 *   avant/après les changements (aha moment, pre-permission, etc.).
 *
 * Retourne :
 *   - totalRestaurants : nombre de restaurants ayant au moins 1 event
 *   - steps : par étape, le count d'events started/completed/skipped/blocked
 *   - demoCallPlayed : count d'events onboarding_demo_call_played
 *   - conversionRates : % de restaurants ayant complété chaque étape
 *     parmi ceux qui l'ont started
 *
 * Auth : requireOrg() (Clerk). Lecture seule.
 */

import { FastifyInstance } from 'fastify';
import { requireOrg, requirePlatformOperator } from '../../plugins/clerk';
import { db } from '../../shared/db/client';
import {
  aggregateOnboardingCohort,
  perRestaurantProgress,
  type RestaurantTimeline,
} from './onboarding-funnel.service';

const STEP_ORDER = [
  'restaurant',
  'hours',
  'floor',
  'knowledge',
  'phone',
  'channels',
  'connect-identity',
  'connect-location',
  'connect-cuisine',
  'connect-activation',
] as const;

export async function onboardingFunnelRoutes(app: FastifyInstance) {
  /**
   * Vue cohorte, réservée à l'opérateur : elle agrège tous les établissements,
   * donc elle n'est pas scopée par organisation. C'est ce que la page
   * /dashboard/admin/onboarding consomme pour mesurer le pilote (R2-5).
   */
  app.get(
    '/admin/onboarding-funnel/cohort',
    { preHandler: requirePlatformOperator() },
    async (req, reply) => {
      try {
        // tenant-scoping: global — funnel opérateur agrégé, pas une lecture tenant.
        const events = await db.onboardingEvent.findMany({
          select: { restaurantId: true, event: true, task: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        });

        // tenant-scoping: global — première réservation par établissement, agrégat opérateur.
        const firstReservations = await db.reservation.groupBy({
          by: ['restaurantId'],
          _min: { reservedAt: true },
        });
        const timelines: RestaurantTimeline[] = firstReservations.map((row) => ({
          restaurantId: row.restaurantId,
          firstReservationAt: row._min.reservedAt ?? null,
        }));

        const progress = perRestaurantProgress(events, timelines);
        // tenant-scoping: global — noms des établissements du funnel, pour que l'opérateur sache chez qui agir.
        const names = await db.restaurant.findMany({
          where: { id: { in: progress.map((row) => row.restaurantId) } },
          select: { id: true, name: true },
        });
        const nameById = new Map(names.map((row) => [row.id, row.name]));

        return reply.send({
          funnel: aggregateOnboardingCohort(events, timelines),
          // Champ ajouté (additif) : `restaurantName`, null si l'établissement a été supprimé.
          restaurants: progress.map((row) => ({
            ...row,
            restaurantName: nameById.get(row.restaurantId) ?? null,
          })),
        });
      } catch (err) {
        req.log.error({ err }, 'onboarding-funnel: failed to aggregate cohort');
        return reply.status(500).send({ error: 'Failed to read onboarding cohort funnel' });
      }
    },
  );

  app.get('/admin/onboarding-funnel', { preHandler: requireOrg() }, async (req, reply) => {
    const restaurantId = req.restaurantId as string;

    try {
      const events = await db.onboardingEvent.findMany({
        where: { restaurantId },
        select: { event: true, task: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });

      // Agrégation par étape
      const steps = STEP_ORDER.map((stepKey) => {
        const stepEvents = events.filter((e) => e.task === stepKey);
        return {
          step: stepKey,
          started: stepEvents.filter((e) => e.event === 'onboarding_step_started').length,
          completed: stepEvents.filter((e) => e.event === 'onboarding_step_completed').length,
          skipped: stepEvents.filter((e) => e.event === 'onboarding_step_skipped').length,
          blocked: stepEvents.filter((e) => e.event === 'onboarding_step_blocked').length,
        };
      });

      // Events globaux (non liés à une étape spécifique)
      const activated = events.filter((e) => e.event === 'onboarding_activated').length;
      const firstCall = events.filter((e) => e.event === 'onboarding_first_call').length;
      const demoCallPlayed = events.filter((e) => e.event === 'onboarding_demo_call_played').length;

      // Rates de conversion : % completed parmi started
      const conversionRates = steps.map((s) => ({
        step: s.step,
        rate: s.started > 0 ? Math.round((s.completed / s.started) * 100) : 0,
      }));

      // Funnel global : % de restaurants ayant complété chaque étape
      // parmi le total d'étapes started (premier event = entrée dans le funnel)
      const totalStarted = steps[0]?.started ?? 0;

      return reply.send({
        restaurantId,
        totalEvents: events.length,
        totalStarted,
        steps,
        conversionRates,
        milestones: {
          activated,
          firstCall,
          demoCallPlayed,
        },
        funnelCompletionRate:
          totalStarted > 0
            ? Math.round((steps.filter((s) => s.completed > 0).length / STEP_ORDER.length) * 100)
            : 0,
      });
    } catch (err) {
      req.log.error({ err, restaurantId }, 'onboarding-funnel: failed to aggregate events');
      return reply.status(500).send({ error: 'Failed to read onboarding funnel' });
    }
  });
}
