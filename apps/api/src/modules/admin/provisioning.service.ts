import telnyx, { placeOutboundCall } from '../../shared/telnyx/client';
import { db } from '../../shared/db/client';
import { invalidateRestaurantContextCache } from '../restaurants/restaurant.service';
import { requestGreetingWarm } from '../../shared/queue/greeting-warm';
import {
  hasUsablePhone,
  computeOnboardingState,
  normalizeTasks,
  socleCompletedAt,
} from '../restaurants/onboarding.service';
import { trackOnboardingEvent } from '../analytics/events.service';
import pino from 'pino';
import { Prisma } from '@prisma/client';

const logger = pino({ name: 'provisioning-service' });

export interface TelnyxNumberItem {
  id: string;
  phoneNumber: string;
  nationalFormat?: string;
  status: string;
  assignedToRestaurantId?: string | null;
  assignedToRestaurantName?: string | null;
}

/** D'où vient la liste des numéros : le compte Telnyx, un jeu fictif de développement, ou rien. */
export type AvailableNumbersSource = 'telnyx' | 'dev-fallback' | 'unavailable';

/**
 * État du lien entre le numéro et l'application voix Telnyx (celle qui envoie les appels à Suppernote).
 * Sans lien, le numéro est attribué dans Suppernote mais le restaurant ne reçoit aucun appel.
 */
export type VoiceAppLinkState =
  | 'linked'
  | 'failed'
  | 'skipped_no_connection_id'
  | 'skipped_manual_number'
  | 'skipped_no_telnyx';

export interface ProvisioningStatusView {
  restaurantId: string;
  restaurantName: string;
  /** Ville du restaurant (pas une donnée du gérant). */
  city: string | null;
  phoneNumber: string;
  hasAssignedPhone: boolean;
  provisioningStatus: string;
  telnyxPhoneNumberId: string | null;
  forwardingConfiguredAt: string | null;
  testCallValidatedAt: string | null;
  firstCallAt: string | null;
  /** Fin de la salle (la plus récente des tâches restaurant, hours, floor), `null` si inachevée. */
  floorCompletedAt: string | null;
  testCallControlId: string | null;
  forwardingCode: string | null;
  steps: {
    assignment: {
      completed: boolean;
      phoneNumber: string;
      /** `null` : numéro attribué avant que le lien ne soit enregistré (état inconnu). */
      voiceAppLink: VoiceAppLinkState | null;
    };
    webhook: {
      completed: boolean;
      webhookUrl: string;
    };
    forwarding: {
      completed: boolean;
      configuredAt: string | null;
      ussdCode: string | null;
    };
    testCall: {
      completed: boolean;
      validatedAt: string | null;
    };
  };
}

const VOICE_APP_LINK_STATES: readonly VoiceAppLinkState[] = [
  'linked',
  'failed',
  'skipped_no_connection_id',
  'skipped_manual_number',
  'skipped_no_telnyx',
];

function readVoiceAppLink(tasks: unknown): VoiceAppLinkState | null {
  const value = normalizeTasks(tasks).phone.metadata?.voiceAppLink;
  return VOICE_APP_LINK_STATES.find((state) => state === value) ?? null;
}

/** Le jeu de numéros fictifs ne sert qu'en développement, jamais face à un compte Telnyx réel. */
function allowDevFallbackNumbers(): boolean {
  return (
    !process.env.TELNYX_API_KEY && ['development', 'test', undefined].includes(process.env.NODE_ENV)
  );
}

const TELNYX_PAGE_SIZE = 100;
const TELNYX_MAX_PAGES = 20;

export class ProvisioningNotReadyError extends Error {
  readonly code = 'PROVISIONING_NOT_READY';

  constructor(readonly missing: string[]) {
    super(`Provisioning incomplet. Prérequis manquants : ${missing.join(', ')}.`);
    this.name = 'ProvisioningNotReadyError';
  }
}

export class ProvisioningTestCallNotPendingError extends Error {
  readonly code = 'TEST_CALL_NOT_PENDING';

  constructor(message = 'Aucun appel test en attente de confirmation pour ce restaurant.') {
    super(message);
    this.name = 'ProvisioningTestCallNotPendingError';
  }
}

function readTestCallControlId(tasks: unknown): string | null {
  const normalized = normalizeTasks(tasks);
  const value = normalized.phone.metadata?.testCallControlId;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

export class ProvisioningService {
  /**
   * Liste les numéros du compte Telnyx (toutes les pages), avec leur éventuelle attribution.
   * Sans clé Telnyx, uniquement en développement, un jeu fictif permet de tester l'écran ; en
   * production (ou si Telnyx échoue), la liste est vide et `source` le dit : on ne propose jamais
   * un numéro qui n'existe pas chez Telnyx.
   */
  static async listAvailableNumbers(): Promise<{
    numbers: TelnyxNumberItem[];
    source: AvailableNumbersSource;
  }> {
    const assignedRestaurants = await db.restaurant.findMany({
      select: { id: true, name: true, phoneNumber: true, telnyxPhoneNumberId: true },
    });

    const assignedMap = new Map<string, { id: string; name: string }>();
    for (const r of assignedRestaurants) {
      if (r.phoneNumber && !r.phoneNumber.startsWith('+000')) {
        assignedMap.set(r.phoneNumber, { id: r.id, name: r.name });
      }
    }

    const toItem = (id: string, phoneNumber: string, status: string): TelnyxNumberItem => {
      const assigned = assignedMap.get(phoneNumber);
      return {
        id,
        phoneNumber,
        status,
        assignedToRestaurantId: assigned?.id ?? null,
        assignedToRestaurantName: assigned?.name ?? null,
      };
    };

    if (process.env.TELNYX_API_KEY) {
      try {
        const telnyxClient = telnyx as unknown as {
          phoneNumbers: {
            list: (params?: Record<string, unknown>) => Promise<{
              data: Array<Record<string, unknown>>;
              meta?: { total_pages?: number };
            }>;
          };
        };
        const items: TelnyxNumberItem[] = [];
        for (let page = 1; page <= TELNYX_MAX_PAGES; page++) {
          const response = await telnyxClient.phoneNumbers.list({
            page: { number: page, size: TELNYX_PAGE_SIZE },
          });
          const rawList = response?.data ?? [];
          for (const num of rawList) {
            const rawPhone = (num.phone_number as string) ?? '';
            if (!rawPhone) continue;
            items.push(
              toItem((num.id as string) ?? '', rawPhone, (num.status as string) ?? 'active'),
            );
          }
          const totalPages = response?.meta?.total_pages;
          const lastPage =
            totalPages !== undefined ? page >= totalPages : rawList.length < TELNYX_PAGE_SIZE;
          if (lastPage) break;
        }
        return { numbers: items, source: 'telnyx' };
      } catch (err) {
        logger.warn({ err }, 'Failed to fetch Telnyx numbers from Telnyx API');
        return { numbers: [], source: 'unavailable' };
      }
    }

    if (allowDevFallbackNumbers()) {
      const fallbackPool = [
        { id: 'tnx_dev_01', phoneNumber: '+33100000001' },
        { id: 'tnx_dev_02', phoneNumber: '+33100000002' },
        { id: 'tnx_dev_03', phoneNumber: '+33100000003' },
      ];
      return {
        numbers: fallbackPool.map((item) => toItem(item.id, item.phoneNumber, 'active')),
        source: 'dev-fallback',
      };
    }

    return { numbers: [], source: 'unavailable' };
  }

  /**
   * Attribue un numéro Telnyx à un restaurant et met à jour l'état de provisioning & onboarding.
   */
  static async assignPhoneNumber(
    restaurantId: string,
    phoneNumber: string,
    telnyxPhoneNumberId?: string,
  ): Promise<ProvisioningStatusView> {
    const formattedPhone = phoneNumber.trim();
    if (!/^\+[1-9]\d{9,14}$/.test(formattedPhone)) {
      throw new Error('Numéro E.164 invalide. Format requis : +33612345678');
    }

    const existingWithPhone = await db.restaurant.findFirst({
      where: {
        phoneNumber: formattedPhone,
        id: { not: restaurantId },
      },
      select: { id: true, name: true },
    });

    if (existingWithPhone) {
      throw new Error(
        `Le numéro ${formattedPhone} est déjà attribué au restaurant "${existingWithPhone.name}" (${existingWithPhone.id}).`,
      );
    }

    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    // Invalider l'ancien cache Redis
    if (restaurant.phoneNumber) {
      await invalidateRestaurantContextCache(restaurant.phoneNumber);
    }

    // Tâches d'onboarding existantes
    const tasks = normalizeTasks(restaurant.onboardingTasks);
    tasks.phone = {
      ...tasks.phone,
      status: tasks.phone.status === 'completed' ? 'completed' : 'current',
      metadata: {
        ...(tasks.phone.metadata ?? {}),
        assignedPhone: formattedPhone,
        assignedAt: new Date().toISOString(),
        telnyxPhoneNumberId: telnyxPhoneNumberId ?? null,
      },
    };

    const nextOnboardingState = computeOnboardingState({
      ...restaurant,
      phoneNumber: formattedPhone,
      onboardingTasks: tasks,
    });

    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        phoneNumber: formattedPhone,
        carrier: 'telnyx',
        telnyxPhoneNumberId: telnyxPhoneNumberId ?? restaurant.telnyxPhoneNumberId,
        provisioningStatus: 'PHONE_ASSIGNED',
        onboardingTasks: tasks as unknown as Prisma.InputJsonValue,
        onboardingDone: nextOnboardingState.onboardingDone,
      },
    });

    // Invalider le nouveau cache Redis
    await invalidateRestaurantContextCache(formattedPhone);
    // Un numéro attribué = un restaurant qui reçoit des appels : son accueil doit être prêt.
    requestGreetingWarm();

    // Relier le numéro à l'application voix Telnyx : sans ce lien, le numéro est attribué dans Suppernote
    // mais les appels n'arrivent pas. Un échec ne bloque pas l'attribution ; l'état est enregistré
    // pour que l'écran de l'opérateur l'affiche.
    const voiceAppLink = await this.linkVoiceApp(restaurantId, telnyxPhoneNumberId);
    const linkedTasks = normalizeTasks(updated.onboardingTasks);
    linkedTasks.phone = {
      ...linkedTasks.phone,
      metadata: { ...(linkedTasks.phone.metadata ?? {}), voiceAppLink },
    };
    await db.restaurant.update({
      where: { id: restaurantId },
      data: { onboardingTasks: linkedTasks as unknown as Prisma.InputJsonValue },
    });

    return this.getProvisioningStatus(updated.id);
  }

  private static async linkVoiceApp(
    restaurantId: string,
    telnyxPhoneNumberId: string | undefined,
  ): Promise<VoiceAppLinkState> {
    if (!process.env.TELNYX_API_KEY) return 'skipped_no_telnyx';
    if (!telnyxPhoneNumberId) return 'skipped_manual_number';
    if (!process.env.TELNYX_CONNECTION_ID) return 'skipped_no_connection_id';
    try {
      const telnyxClient = telnyx as unknown as {
        phoneNumbers: {
          update: (id: string, params: Record<string, unknown>) => Promise<unknown>;
        };
      };
      await telnyxClient.phoneNumbers.update(telnyxPhoneNumberId, {
        connection_id: process.env.TELNYX_CONNECTION_ID,
      });
      logger.info(
        { restaurantId, telnyxPhoneNumberId },
        'Telnyx phone number connection_id updated',
      );
      return 'linked';
    } catch (err) {
      logger.warn(
        { err, restaurantId, telnyxPhoneNumberId },
        'Could not update Telnyx connection_id via Telnyx SDK',
      );
      return 'failed';
    }
  }

  /**
   * Vérifie le webhook Telnyx et marque uniquement l'étape Webhook comme validée.
   *
   * Le renvoi opérateur est une preuve distincte : il ne doit pas être marqué
   * implicitement par un probe HTTP du webhook.
   */
  static async verifyWebhook(restaurantId: string): Promise<ProvisioningStatusView> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    if (!hasUsablePhone(restaurant.phoneNumber)) {
      throw new Error("Attribution d'un numéro Telnyx requise avant la vérification du webhook.");
    }

    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        provisioningStatus:
          restaurant.provisioningStatus === 'TEST_CALL_COMPLETED' ||
          restaurant.provisioningStatus === 'TEST_CALL_PENDING' ||
          restaurant.provisioningStatus === 'ACTIVE'
            ? restaurant.provisioningStatus
            : 'WEBHOOK_READY',
      },
    });

    return this.getProvisioningStatus(updated.id);
  }

  /**
   * Enregistre l'attestation opérateur du renvoi d'appel après que le code USSD
   * a été composé sur le téléphone du restaurant.
   */
  static async markForwardingConfigured(restaurantId: string): Promise<ProvisioningStatusView> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    if (!hasUsablePhone(restaurant.phoneNumber)) {
      throw new Error("Attribution d'un numéro Telnyx requise avant le renvoi d'appel.");
    }

    if (
      !['WEBHOOK_READY', 'TEST_CALL_PENDING', 'TEST_CALL_COMPLETED', 'ACTIVE'].includes(
        restaurant.provisioningStatus,
      )
    ) {
      throw new Error('Le webhook doit être vérifié avant de confirmer le renvoi d’appel.');
    }

    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        forwardingConfiguredAt: restaurant.forwardingConfiguredAt ?? new Date(),
      },
    });

    return this.getProvisioningStatus(updated.id);
  }

  /**
   * Déclenche un appel test. Le déclenchement ne vaut pas validation : un
   * opérateur doit confirmer que l'appel a été reçu et que l'IA a répondu.
   */
  static async triggerTestCall(
    restaurantId: string,
    targetPhoneNumber: string,
  ): Promise<{ callControlId: string; status: ProvisioningStatusView }> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    if (!hasUsablePhone(restaurant.phoneNumber)) {
      throw new Error(
        "Aucun numéro Suppernote attribué. Attribuez un numéro avant de lancer l'appel test.",
      );
    }

    if (
      !['WEBHOOK_READY', 'TEST_CALL_PENDING', 'TEST_CALL_COMPLETED', 'ACTIVE'].includes(
        restaurant.provisioningStatus,
      )
    ) {
      throw new Error('Le webhook doit être vérifié avant de lancer l’appel test.');
    }

    if (!restaurant.forwardingConfiguredAt) {
      throw new Error("Le renvoi d'appel doit être confirmé avant de lancer l'appel test.");
    }

    const formattedTarget = targetPhoneNumber.trim();
    if (!/^\+[1-9]\d{9,14}$/.test(formattedTarget)) {
      throw new Error('Numéro E.164 du gérant invalide (ex: +33612345678).');
    }

    const baseUrl = process.env.PUBLIC_API_URL ?? 'https://api.suppernote.com';
    const webhookUrl = `${baseUrl}/voice/telnyx`;

    const { callControlId } = await placeOutboundCall(formattedTarget, {
      webhookUrl,
      clientState: {
        kind: 'onboarding_test_call',
        restaurantId,
        targetManagerPhone: formattedTarget,
      },
      timeoutSecs: 30,
    });

    const tasks = normalizeTasks(restaurant.onboardingTasks);
    tasks.phone = {
      ...tasks.phone,
      metadata: {
        ...(tasks.phone.metadata ?? {}),
        testCallControlId: callControlId,
        testCallRequestedAt: new Date().toISOString(),
      },
    };

    const nextOnboardingState = computeOnboardingState({ ...restaurant, onboardingTasks: tasks });

    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        provisioningStatus: restaurant.testCallValidatedAt
          ? restaurant.provisioningStatus
          : 'TEST_CALL_PENDING',
        onboardingTasks: tasks as unknown as Prisma.InputJsonValue,
        onboardingDone: nextOnboardingState.onboardingDone,
      },
    });

    const status = await this.getProvisioningStatus(updated.id);
    return { callControlId, status };
  }

  /**
   * Confirme explicitement qu'un appel test déclenché a été reçu et entendu.
   * L'identifiant Telnyx est conservé dans les métadonnées d'onboarding pour
   * empêcher la confirmation d'un appel différent ou inventé.
   */
  static async validateTestCall(
    restaurantId: string,
    callControlId: string,
  ): Promise<ProvisioningStatusView> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    const normalizedCallControlId = callControlId.trim();
    const pendingCallControlId = readTestCallControlId(restaurant.onboardingTasks);
    if (!pendingCallControlId) throw new ProvisioningTestCallNotPendingError();
    if (pendingCallControlId !== normalizedCallControlId) {
      throw new ProvisioningTestCallNotPendingError(
        'L’identifiant fourni ne correspond pas au dernier appel test déclenché.',
      );
    }
    if (restaurant.testCallValidatedAt) {
      return this.getProvisioningStatus(restaurant.id);
    }
    if (!hasUsablePhone(restaurant.phoneNumber)) {
      throw new ProvisioningTestCallNotPendingError(
        "Aucun numéro Suppernote attribué pour valider l'appel test.",
      );
    }

    const now = new Date();
    const tasks = normalizeTasks(restaurant.onboardingTasks);
    tasks.phone = {
      ...tasks.phone,
      status: 'completed',
      completedAt: tasks.phone.completedAt ?? now.toISOString(),
      metadata: {
        ...(tasks.phone.metadata ?? {}),
        testCallValidatedAt: now.toISOString(),
      },
    };
    const nextOnboardingState = computeOnboardingState({
      ...restaurant,
      firstCallAt: restaurant.firstCallAt ?? now,
      onboardingTasks: tasks,
    });

    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        firstCallAt: restaurant.firstCallAt ?? now,
        testCallValidatedAt: restaurant.testCallValidatedAt ?? now,
        provisioningStatus:
          restaurant.provisioningStatus === 'ACTIVE' ? 'ACTIVE' : 'TEST_CALL_COMPLETED',
        onboardingTasks: tasks as unknown as Prisma.InputJsonValue,
        onboardingDone: nextOnboardingState.onboardingDone,
        onboardingCompletedAt:
          nextOnboardingState.onboardingDone && !restaurant.onboardingCompletedAt
            ? now
            : restaurant.onboardingCompletedAt,
      },
    });

    await trackOnboardingEvent({
      event: 'onboarding_first_call',
      restaurantId,
      task: 'phone',
      metadata: {
        callControlId: normalizedCallControlId,
        provisioningStatus: updated.provisioningStatus,
      },
    }).catch((err) =>
      logger.error({ err, restaurantId }, 'Failed to track onboarding_first_call event'),
    );

    return this.getProvisioningStatus(updated.id);
  }

  /**
   * Finalise l'activation uniquement après les preuves locales du parcours.
   * Le bouton d'administration ne doit jamais fabriquer une validation d'appel
   * ou de renvoi en écrivant directement `ACTIVE`.
   */
  static async completeProvisioning(restaurantId: string): Promise<ProvisioningStatusView> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    const missing: string[] = [];
    if (!hasUsablePhone(restaurant.phoneNumber)) missing.push('phone_assignment');
    if (!restaurant.forwardingConfiguredAt) missing.push('forwarding');
    if (
      !['WEBHOOK_READY', 'TEST_CALL_COMPLETED', 'ACTIVE'].includes(restaurant.provisioningStatus)
    ) {
      missing.push('webhook');
    }
    if (!restaurant.testCallValidatedAt) {
      missing.push('test_call');
    }

    if (missing.length > 0) throw new ProvisioningNotReadyError(missing);

    const now = new Date();
    const updated = await db.restaurant.update({
      where: { id: restaurantId },
      data: {
        provisioningStatus: 'ACTIVE',
        onboardingActivatedAt: restaurant.onboardingActivatedAt ?? now,
      },
    });

    return this.getProvisioningStatus(updated.id);
  }

  /**
   * Retourne le statut de provisioning consolidé d'un restaurant.
   */
  static async getProvisioningStatus(restaurantId: string): Promise<ProvisioningStatusView> {
    const restaurant = await db.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
    });

    const isAssigned = hasUsablePhone(restaurant.phoneNumber);
    const baseUrl = process.env.PUBLIC_API_URL ?? 'https://api.suppernote.com';
    const webhookUrl = `${baseUrl}/voice/telnyx`;

    const ussdCode = isAssigned ? `*21*${restaurant.phoneNumber}#` : null;

    const assignmentCompleted = isAssigned;
    const webhookCompleted =
      isAssigned &&
      (restaurant.provisioningStatus === 'WEBHOOK_READY' ||
        restaurant.provisioningStatus === 'TEST_CALL_COMPLETED' ||
        restaurant.provisioningStatus === 'ACTIVE');

    const forwardingCompleted = Boolean(restaurant.forwardingConfiguredAt);
    const testCallCompleted = Boolean(restaurant.testCallValidatedAt);

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      city: restaurant.city ?? null,
      phoneNumber: restaurant.phoneNumber,
      hasAssignedPhone: isAssigned,
      provisioningStatus: restaurant.provisioningStatus,
      telnyxPhoneNumberId: restaurant.telnyxPhoneNumberId,
      forwardingConfiguredAt: restaurant.forwardingConfiguredAt
        ? restaurant.forwardingConfiguredAt.toISOString()
        : null,
      testCallValidatedAt: restaurant.testCallValidatedAt
        ? restaurant.testCallValidatedAt.toISOString()
        : null,
      firstCallAt: restaurant.firstCallAt ? restaurant.firstCallAt.toISOString() : null,
      floorCompletedAt: socleCompletedAt(normalizeTasks(restaurant.onboardingTasks)),
      testCallControlId: readTestCallControlId(restaurant.onboardingTasks),
      forwardingCode: ussdCode,
      steps: {
        assignment: {
          completed: assignmentCompleted,
          phoneNumber: restaurant.phoneNumber,
          voiceAppLink: isAssigned ? readVoiceAppLink(restaurant.onboardingTasks) : null,
        },
        webhook: {
          completed: webhookCompleted,
          webhookUrl,
        },
        forwarding: {
          completed: forwardingCompleted,
          configuredAt: restaurant.forwardingConfiguredAt
            ? restaurant.forwardingConfiguredAt.toISOString()
            : null,
          ussdCode,
        },
        testCall: {
          completed: testCallCompleted,
          validatedAt: restaurant.testCallValidatedAt
            ? restaurant.testCallValidatedAt.toISOString()
            : null,
        },
      },
    };
  }
}
