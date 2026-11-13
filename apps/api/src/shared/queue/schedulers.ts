/**
 * Inscription des jobs récurrents (BullMQ job schedulers).
 *
 * Extrait de `main.ts` pour que le même code serve les deux topologies :
 *  - développement : le process API démarre aussi les workers
 *    (`RUN_WORKERS_IN_PROCESS=true`) ;
 *  - production : le process `dist/worker.js` (PM2 `sokar-workers`) porte les
 *    workers et les schedulers, l'API ne fait que servir le HTTP.
 *
 * `upsertJobScheduler` est idempotent par identifiant : rejouer l'inscription
 * ne crée pas de doublon, et deux process ne se marchent pas dessus.
 */

import { db } from '../db/client';
import { logger } from '../logger/pino';
import { queues } from './queues';
import { env } from '../../env';

export async function registerJobSchedulers(): Promise<void> {
  // Chaque scheduler est inscrit dans son propre try/catch pour qu'un
  // échec (ex: DB pas prête au boot) n'empêche pas l'inscription des
  // autres. Sans ça, une seule upsertJobScheduler qui throw avorte
  // silencieusement les 10+ schedulers suivants → alertes system-health
  // qui disparaissent au prochain restart PM2.
  const register = (label: string, fn: () => Promise<unknown>): Promise<void> =>
    fn()
      .then(() => {})
      .catch((err) => {
        logger.error({ err, scheduler: label }, 'Failed to register scheduler (non-blocking)');
      });

  // Evening-report : un scheduler par restaurant. Staging n'a pas de Resend ;
  // retirer aussi les schedulers déjà présents évite d'accumuler des jobs morts
  // au prochain 23 h ou après un redémarrage du worker.
  if (env.EVENING_REPORTS_ENABLED) {
    try {
      // tenant-scoping: global — planification : un rapport par établissement.
      const restaurants = await db.restaurant.findMany({ select: { id: true } });
      for (const r of restaurants) {
        await register(`evening-report/${r.id}`, () =>
          queues.eveningReport.upsertJobScheduler(
            `nightly-${r.id}`,
            { pattern: '0 23 * * *', tz: 'Europe/Paris' },
            { name: 'nightly', data: { restaurantId: r.id } },
          ),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load restaurants for evening-report schedulers');
    }
  } else {
    try {
      const schedulers = await queues.eveningReport.getJobSchedulers(0, -1);
      const nightlySchedulers = schedulers.filter((scheduler) => scheduler.name === 'nightly');
      for (const scheduler of nightlySchedulers) {
        await register('evening-report/disable', () =>
          queues.eveningReport.removeJobScheduler(scheduler.key),
        );
      }
      logger.info(
        { removed: nightlySchedulers.length },
        'Evening-report schedulers disabled by configuration',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to remove disabled evening-report schedulers');
    }
  }

  await register('reconciliation/calls', () =>
    queues.reconciliation.upsertJobScheduler(
      'daily-call-reconciliation',
      { pattern: '20 3 * * *', tz: 'Europe/Paris' },
      { name: 'calls', data: { kind: 'calls' } },
    ),
  );
  await register('reconciliation/sms', () =>
    queues.reconciliation.upsertJobScheduler(
      'daily-sms-reconciliation',
      { pattern: '35 3 * * *', tz: 'Europe/Paris' },
      { name: 'sms', data: { kind: 'sms' } },
    ),
  );
  // Rattrapage fréquent des appels sans outcome : un appel terminé doit
  // produire un résultat exploitable même si le webhook de fin est perdu.
  await register('reconciliation/voice-finalization', () =>
    queues.reconciliation.upsertJobScheduler(
      'voice-finalization-sweep',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'voice-finalization', data: { kind: 'voice-finalization' } },
    ),
  );
  // Purge horaire des réservations test de plus de 24 h.
  await register('reconciliation/test-reservation-purge', () =>
    queues.reconciliation.upsertJobScheduler(
      'test-reservation-purge',
      { pattern: '5 * * * *', tz: 'Europe/Paris' },
      { name: 'test-reservation-purge', data: { kind: 'test-reservation-purge' } },
    ),
  );
  // Accueils vocaux : complète ceux qui manquent (nouveau restaurant, nouveau nom, changement de voix)
  // et prolonge les autres. Remplace le précache réservé au démarrage de l'API.
  await register('reconciliation/greeting-warm', () =>
    queues.reconciliation.upsertJobScheduler(
      'greeting-warm',
      { pattern: '25 * * * *', tz: 'Europe/Paris' },
      { name: 'greeting-warm', data: { kind: 'greeting-warm' } },
    ),
  );
  // Capacité vocale : pic d'appels simultanés sur 7 jours comparé au seuil, alerte à 50 % puis 70 %.
  await register('reconciliation/voice-capacity-check', () =>
    queues.reconciliation.upsertJobScheduler(
      'voice-capacity-check',
      { pattern: '40 * * * *', tz: 'Europe/Paris' },
      { name: 'voice-capacity-check', data: { kind: 'voice-capacity-check' } },
    ),
  );
  // Empreintes bancaires : libère chaque minute les places tenues dont la carte n'a pas été enregistrée.
  await register('reconciliation/reservation-payment-expiry', () =>
    queues.reconciliation.upsertJobScheduler(
      'reservation-payment-expiry',
      { every: 60 * 1000 },
      { name: 'reservation-payment-expiry', data: { kind: 'reservation-payment-expiry' } },
    ),
  );
  // Conservation marketing (runbook §4) : fichier de prospection et preuves, une fois par nuit.
  await register('reconciliation/marketing-retention-purge', () =>
    queues.reconciliation.upsertJobScheduler(
      'marketing-retention-purge',
      { pattern: '20 3 * * *', tz: 'Europe/Paris' },
      { name: 'marketing-retention-purge', data: { kind: 'marketing-retention-purge' } },
    ),
  );

  // SMS de rappel J-1 : envoie les SMS à 17h chaque jour
  await register('confirmation-sms/scan', () =>
    queues.confirmationSms.upsertJobScheduler(
      'daily-confirmation-scan',
      { pattern: '0 17 * * *', tz: 'Europe/Paris' },
      { name: 'confirmation-scan', data: { kind: 'scan' } },
    ),
  );

  // Rappel expiration carte cadeau : scan quotidien à 9h
  await register('gift-card-finance/reconcile', () =>
    queues.giftCardFinance.upsertJobScheduler(
      'gift-card-finance-reconcile',
      { every: 5 * 60 * 1000 },
      { name: 'gift-card-finance-scan', data: { kind: 'scan' } },
    ),
  );
  await register('gift-card-reminder/daily', () =>
    queues.giftCardReminder.upsertJobScheduler(
      'daily-gift-card-reminder',
      { pattern: '0 9 * * *', tz: 'Europe/Paris' },
      { name: 'gift-card-reminder-scan', data: { kind: 'scan' } },
    ),
  );

  // Réactivation VIP dormant : scan hebdo le lundi à 10h
  await register('reactivation/scan', () =>
    queues.reactivation.upsertJobScheduler(
      'weekly-vip-reactivation',
      { pattern: '0 10 * * 1', tz: 'Europe/Paris' },
      { name: 'reactivation-scan', data: { kind: 'scan' } },
    ),
  );

  // Automatisations marketing Pro : scan horaire à :15. Le worker
  // crée des campagnes snapshot mais ne met aucun fournisseur en jeu
  // tant que MARKETING_SENDS_ENABLED reste désactivé.
  await register('marketing-automation/hourly', () =>
    queues.marketingAutomation.upsertJobScheduler(
      'hourly-marketing-automation-scan',
      { pattern: '15 * * * *', tz: 'Europe/Paris' },
      { name: 'automation-scan', data: { kind: 'scan' } },
    ),
  );

  // Réconciliation des callbacks provider reçus avant la CampaignMessage :
  // elle ne contacte jamais le provider et ne dépend pas du flag d'envoi.
  await register('marketing-provider-reconciliation/5min', () =>
    queues.marketingProviderReconciliation.upsertJobScheduler(
      'marketing-provider-reconciliation-5min',
      { pattern: '*/5 * * * *', tz: 'Europe/Paris' },
      { name: 'reconcile-provider-events', data: { limit: 100 } },
    ),
  );

  // Expiration des liens de retour client : toutes les 15 minutes. Ce
  // nettoyage ne contacte aucun fournisseur et reste sûr pendant le gel.
  await register('reputation-feedback-expiry/15min', () =>
    queues.reputationFeedbackExpiry.upsertJobScheduler(
      'reputation-feedback-expiry-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'expire-feedback-requests', data: { limit: 500 } },
    ),
  );

  // Expiration des avantages émis : toutes les 15 minutes. Le worker ne
  // contacte aucun provider et ne modifie que les grants encore ISSUED.
  await register('loyalty-grant-expiry/15min', () =>
    queues.loyaltyGrantExpiry.upsertJobScheduler(
      'loyalty-grant-expiry-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'expire-loyalty-grants', data: { limit: 1_000 } },
    ),
  );

  // Fermeture des sessions d’expérience terminées : toutes les 15 minutes.
  // Le worker ne contacte aucun fournisseur et ne modifie que les sessions
  // encore ouvertes dont la date de fin est passée.
  await register('experience-session-expiry/15min', () =>
    queues.experienceSessionExpiry.upsertJobScheduler(
      'experience-session-expiry-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'expire-experience-sessions', data: { limit: 1_000 } },
    ),
  );

  // Fermeture des sessions d’événement terminées : toutes les 15 minutes.
  // Le worker ne contacte aucun fournisseur et expire aussi la liste
  // d’attente locale des sessions fermées.
  await register('event-session-expiry/15min', () =>
    queues.eventSessionExpiry.upsertJobScheduler(
      'event-session-expiry-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'expire-event-sessions', data: { limit: 1_000 } },
    ),
  );

  // Alert evaluation : toutes les 5 minutes. Lit les métriques Prometheus,
  // compare avec le snapshot précédent (Redis), déclenche les alertes
  // Sentry avec cooldown 30 min. Cf. alert-evaluation.worker.ts.
  await register('alert-evaluation/5min', () =>
    queues.alertEvaluation.upsertJobScheduler(
      'alert-evaluation-5min',
      { pattern: '*/5 * * * *', tz: 'Europe/Paris' },
      { name: 'evaluate-alerts' },
    ),
  );

  // Monitoring système : toutes les 5 minutes. Checks métier (files
  // BullMQ, appels sans transcription, réservations sans SMS) dispatchés
  // sur les canaux ALERT_* avec cooldown 30 min. Cf. system-health.worker.ts.
  await register('system-health/5min', () =>
    queues.systemHealth.upsertJobScheduler(
      'system-health-5min',
      { pattern: '*/5 * * * *', tz: 'Europe/Paris' },
      { name: 'system-health-checks' },
    ),
  );

  // Snapshot SQL en lecture seule des réservations vocales, indépendant des
  // alertes système et limité à un rafraîchissement toutes les 15 minutes.
  await register('voice-quality/15min', () =>
    queues.systemHealth.upsertJobScheduler(
      'voice-quality-metrics-15min',
      { pattern: '*/15 * * * *', tz: 'Europe/Paris' },
      { name: 'voice-quality-gauges' },
    ),
  );

  // Solde ElevenLabs : une lecture de subscription par heure, sans stocker ni
  // journaliser la clé et sans envoyer de transcription.
  await register('elevenlabs-subscription/hourly', () =>
    queues.elevenlabsSubscription.upsertJobScheduler(
      'elevenlabs-subscription-hourly',
      { pattern: '0 * * * *', tz: 'Europe/Paris' },
      { name: 'refresh-subscription' },
    ),
  );

  // Crédit OpenRouter (repli vocal, Jev, juge) : une lecture par heure, alerte sous 2 $ puis 0,5 $.
  await register('openrouter-credit/hourly', () =>
    queues.openrouterCredit.upsertJobScheduler(
      'openrouter-credit-hourly',
      { pattern: '15 * * * *', tz: 'Europe/Paris' },
      { name: 'check-credit' },
    ),
  );

  // Solde Telnyx : à zéro, plus d'appels ni de SMS. Lecture horaire.
  await register('provider-balance/hourly', () =>
    queues.providerBalance.upsertJobScheduler(
      'provider-balance-hourly',
      { pattern: '25 * * * *', tz: 'Europe/Paris' },
      { name: 'check-balances' },
    ),
  );

  // Les enregistrements sont privés et temporaires : purge quotidienne
  // des objets dont la rétention applicative est arrivée à échéance.
  await register('telnyx-webhooks/recordings-purge', () =>
    queues.telnyxWebhooks.upsertJobScheduler(
      'call-recordings-purge-daily',
      { pattern: '20 3 * * *', tz: 'Europe/Paris' },
      { name: 'purge-expired-recordings' },
    ),
  );

  // Dialogues des appels de test (restaurants de VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS) :
  // supprimés 14 jours après l'appel.
  await register('telnyx-webhooks/voice-debug-turns-purge', () =>
    queues.telnyxWebhooks.upsertJobScheduler(
      'voice-debug-turns-purge-daily',
      { pattern: '30 3 * * *', tz: 'Europe/Paris' },
      { name: 'purge-expired-voice-debug-turns' },
    ),
  );

  // Nettoyage des holds expirés (filet de sécurité, RES-008).
  await register('hold-cleanup/5min', () =>
    queues.holdCleanup.upsertJobScheduler(
      'hold-cleanup-5min',
      { pattern: '*/5 * * * *', tz: 'Europe/Paris' },
      { name: 'cleanup-expired-holds', data: {} },
    ),
  );

  // Nettoyage des entrées de liste d'attente expirées (filet de sécurité).
  await register('waiting-list-cleanup/5min', () =>
    queues.waitingListCleanup.upsertJobScheduler(
      'waiting-list-cleanup-5min',
      { pattern: '*/5 * * * *', tz: 'Europe/Paris' },
      { name: 'cleanup-expired-waiting-list', data: {} },
    ),
  );

  // Purge quotidienne des clés idempotency expirées (RES-005).
  await register('idempotency-purge/daily', () =>
    queues.idempotencyPurge.upsertJobScheduler(
      'daily-idempotency-purge',
      { pattern: '0 4 * * *', tz: 'Europe/Paris' },
      { name: 'purge-expired', data: {} },
    ),
  );

  // Publication des événements Postgres vers BullMQ. Le dispatcher est
  // relançable : les événements restent PENDING si Redis est indisponible.
  await register('outbox-dispatcher/minute', () =>
    queues.outboxDispatcher.upsertJobScheduler(
      'outbox-dispatch-minute',
      { pattern: '* * * * *', tz: 'Europe/Paris' },
      { name: 'dispatch', data: { limit: 100 } },
    ),
  );

  // Projection reconstructible du ledger : une panne ou une correction
  // de tarif peut être rejouée sans muter les événements bruts.
  await register('usage-rollup/hourly', () =>
    queues.usageRollup.upsertJobScheduler(
      'usage-rollup-hourly',
      { pattern: '15 * * * *', tz: 'Europe/Paris' },
      { name: 'rebuild-current-month', data: {} },
    ),
  );

  // Seuils de suivi interne 70/90/100 %. Ce worker n'impose aucun quota
  // client et reste désactivé par défaut ; la vue de marge opérateur est
  // la source de suivi principale.
  await register('usage-alerts/hourly', () =>
    queues.usageAlerts.upsertJobScheduler(
      'usage-alerts-hourly',
      { pattern: '30 * * * *', tz: 'Europe/Paris' },
      { name: 'scan', data: {} },
    ),
  );

  // Évaluation hebdomadaire en lecture seule des appels de test : elle reste
  // sans effet tant que VOICE_SEMANTIC_AUTO_EVAL_ENABLED n'est pas activé.
  await register('voice-semantic-auto-eval/weekly', () =>
    queues.voiceSemanticAutoEval.upsertJobScheduler(
      'weekly-voice-semantic-auto-eval',
      { pattern: '0 6 * * 1', tz: 'Europe/Paris' },
      { name: 'weekly-evaluation', data: {}, opts: { attempts: 1 } },
    ),
  );

  // Anonymisation RGPD (rétention 2 ans) : quotidienne à 3h. Le scheduler
  // tourne même quand l'opération est désactivée ; c'est le worker qui
  // refuse d'agir sans `RGPD_ANONYMIZATION_ENABLED=true`.
  await register('rgpd-anonymization/daily', () =>
    queues.rgpdAnonymization.upsertJobScheduler(
      'rgpd-anonymization-daily',
      { pattern: '0 3 * * *', tz: 'Europe/Paris' },
      { name: 'rgpd-anonymization-daily', data: {} },
    ),
  );
}
