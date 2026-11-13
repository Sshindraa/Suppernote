import { Worker } from 'bullmq';
import { redisQueue } from '../../redis/client';
import { db } from '../../db/client';
import { sendEmail } from '../../email';
import { setupWorkerListeners, jobLogger } from './helper';
import type { MessagingUsageContext } from '../../../modules/usage/messaging-usage.service';
import { computeOnboardingState } from '../../../modules/restaurants/onboarding.service';
import { loadFloorStats } from '../../../modules/restaurants/onboarding-floor.service';
import { resolveAccountOwnerEmail } from '../../../modules/restaurants/account-email.service';
import {
  buildReminderEmail,
  resolveReminderAction,
  type ReminderKind,
} from '../../../modules/restaurants/onboarding-reminder';

export interface ReengagementJobData {
  restaurantId: string;
  // type : "stalled" (J+3 sans avancée) | "inactive" (J+7, parcours terminé sans appel test validé).
  // Le texte envoyé dépend de l'état réel au moment de l'envoi, pas du type programmé.
  type: ReminderKind;
}

const MS_DAY = 24 * 60 * 60 * 1000;

export type ReengagementOutcome =
  | 'sent'
  | 'restaurant-not-found'
  | 'no-email'
  | 'recently-active'
  | 'already-complete'
  | 'waiting-number';

function hasEmailAddress(value: string | null | undefined): value is string {
  return Boolean(value && /^\S+@\S+\.\S+$/.test(value.trim()));
}

/**
 * Envoie la relance si elle a encore un sens. Aucune adresse ni numéro ne sont journalisés : le
 * résultat est un simple code.
 */
export async function processReengagement(
  data: ReengagementJobData,
  jobId: string,
): Promise<ReengagementOutcome> {
  const restaurant = await db.restaurant.findUnique({
    where: { id: data.restaurantId },
    include: { personality: true, exposureSettings: true, images: true },
  });
  if (!restaurant) return 'restaurant-not-found';

  // Le restaurateur est revenu de lui-même : on ne le relance pas.
  if (
    restaurant.onboardingLastSeenAt &&
    Date.now() - new Date(restaurant.onboardingLastSeenAt).getTime() < MS_DAY
  ) {
    return 'recently-active';
  }

  const floorStats = await loadFloorStats(db, restaurant.id);
  const state = computeOnboardingState({ ...restaurant, floorStats });
  const action = resolveReminderAction(state, restaurant.phoneNumber);
  if (action.kind === 'waiting-number') return 'waiting-number';

  // Parcours terminé : "stalled" n'a plus d'objet ; "inactive" ne vaut que sans appel test validé.
  if (action.kind === 'complete' && (data.type !== 'inactive' || restaurant.firstCallAt)) {
    return 'already-complete';
  }

  // Un restaurateur bloqué à la première étape n'a pas encore enregistré d'adresse : on prend celle
  // de sa connexion.
  const recipient = hasEmailAddress(restaurant.managerEmail)
    ? restaurant.managerEmail.trim()
    : await resolveAccountOwnerEmail(restaurant.accountId);
  if (!recipient) return 'no-email';

  const email = buildReminderEmail({
    kind: data.type,
    action,
    restaurantName: restaurant.name,
    assistantPhoneNumber: restaurant.phoneNumber,
    dashboardUrl: process.env.DASHBOARD_URL ?? 'https://suppernote.com',
  });
  if (!email) return 'already-complete';

  const usageContext: MessagingUsageContext = {
    restaurantId: data.restaurantId,
    sourceType: 'onboarding_reengagement',
    sourceId: `${data.restaurantId}:${data.type}:${jobId}`,
    metadata: { messageType: 'onboarding_reengagement', reengagementType: data.type },
  };

  await sendEmail({
    to: recipient,
    subject: email.subject,
    html: email.html,
    usage: usageContext,
  });
  return 'sent';
}

export const reengagementWorker = new Worker(
  'onboarding',
  async (job) => {
    const log = jobLogger(job);
    const data = job.data as ReengagementJobData;
    const outcome = await processReengagement(data, String(job.id ?? 'manual'));
    log.info({ type: data.type, outcome }, 'reengagement processed');
  },
  { connection: redisQueue },
);

setupWorkerListeners(reengagementWorker);
