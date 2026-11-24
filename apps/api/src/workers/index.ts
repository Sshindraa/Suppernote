/**
 * Point de chargement unique des workers BullMQ.
 *
 * Chaque fichier `*.worker.ts` crée un `Worker` au moment de l'évaluation du
 * module : importer ce fichier, c'est démarrer la consommation des files. Il
 * est donc le seul endroit où la liste des workers est maintenue, partagé par
 * les deux topologies :
 *
 *  - `src/worker.ts` (production, PM2 `suppernote-workers`) ;
 *  - `src/main.ts` en développement, via `RUN_WORKERS_IN_PROCESS=true`.
 *
 * Le test `workers/__tests__/worker-registry.test.ts` échoue si un nouveau
 * `*.worker.ts` n'est pas importé ici : sans lui, le worker ne démarrerait
 * jamais silencieusement.
 */

import '../shared/queue/workers/evening-report.worker';
import '../shared/queue/workers/sms-confirmation.worker';
import '../shared/queue/workers/outbound-confirm.worker';
import '../shared/queue/workers/analytics.worker';
import '../shared/queue/workers/outbox-dispatcher.worker';
import '../shared/queue/workers/outbox-delivery.worker';
import '../shared/queue/workers/usage-rollup.worker';
import '../shared/queue/workers/usage-alerts.worker';
import '../shared/queue/workers/reengagement.worker';
import '../modules/billing/billing-notification.worker';
import '../shared/queue/workers/reconciliation.worker';
import '../shared/queue/workers/telnyx-webhook.worker';
import '../shared/queue/workers/call-recovery.worker';
import '../shared/queue/workers/connect-analytics.worker';
import '../shared/queue/workers/confirmation-sms.worker';
import '../shared/queue/workers/reactivation.worker';
import '../shared/queue/workers/google-places-sync.worker';
import '../shared/queue/workers/alert-evaluation.worker';
import '../shared/queue/workers/system-health.worker';
import '../shared/queue/workers/elevenlabs-subscription.worker';
import '../shared/queue/workers/openrouter-credit.worker';
import '../shared/queue/workers/provider-balance.worker';
import '../modules/marketing/marketing-campaign.worker';
import '../modules/marketing/marketing-automation.worker';
import '../modules/marketing/marketing-provider-reconciliation.worker';
import '../modules/reputation/reputation-feedback-expiry.worker';
import '../modules/loyalty/loyalty-grant-expiry.worker';
import '../modules/experiences/experience-session-expiry.worker';
import '../modules/events/event-session-expiry.worker';
import '../modules/agentic-reservations/workers/expire-hold.worker';
import '../modules/agentic-reservations/workers/agentic-notify.worker';
import '../modules/agentic-reservations/workers/expire-quote.worker';
import '../modules/agentic-reservations/workers/hold-cleanup.worker';
import '../modules/agentic-reservations/workers/idempotency-purge.worker';
import '../modules/agentic-reservations/workers/expire-waiting-list.worker';
import '../modules/agentic-reservations/workers/cleanup-waiting-list.worker';
import '../modules/agentic-reservations/workers/waiting-list-promote.worker';
import '../modules/gift-cards/workers/gift-card-reminder.worker';
import '../modules/gift-cards/workers/gift-card-finance.worker';
import '../shared/queue/workers/rgpd-anonymization.worker';
import '../shared/queue/workers/voice-semantic-auto-eval.worker';
