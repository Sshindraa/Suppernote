import {
  hasUsablePhone,
  type OnboardingStateView,
  type OnboardingTask,
} from './onboarding.service';

/**
 * Relances e-mail du parcours d'inscription. Le parcours suit « Votre salle », puis deux canaux
 * obligatoires (Téléphone, En ligne) dans l'ordre choisi par le restaurateur : les relances en
 * décrivent l'état réel au moment de l'envoi, pas celui du moment où elles ont été programmées.
 * Même découpage que le dashboard (`apps/dashboard/src/features/onboarding/tracks.ts`).
 */
const ROOM_STEPS = ['restaurant', 'hours', 'floor'] as const satisfies readonly OnboardingTask[];
const PHONE_STEPS = ['knowledge', 'phone'] as const satisfies readonly OnboardingTask[];
const ONLINE_STEPS = [
  'connect-identity',
  'connect-activation',
] as const satisfies readonly OnboardingTask[];

type RoomStep = (typeof ROOM_STEPS)[number];
export type ReminderChannel = 'phone' | 'online';

export type ReminderAction =
  /** Les sept tâches sont terminées : l'espace est ouvert, il n'y a rien à relancer. */
  | { kind: 'complete' }
  | { kind: 'room'; step: RoomStep }
  /** La salle est prête mais le numéro Suppernote n'est pas attribué : c'est Suppernote qui doit agir. */
  | { kind: 'waiting-number' }
  | { kind: 'channels'; remaining: ReminderChannel[]; step: OnboardingTask | null };

export type ReminderKind = 'stalled' | 'inactive';

export type ReminderEmail = { subject: string; html: string };

function isCompleted(state: OnboardingStateView, key: OnboardingTask): boolean {
  return state.steps.some((step) => step.key === key && step.status === 'completed');
}

function firstOpen(state: OnboardingStateView, keys: readonly OnboardingTask[]) {
  return keys.find((key) => !isCompleted(state, key)) ?? null;
}

/** Ce qu'il reste à faire pour ouvrir l'espace, à partir de l'état d'onboarding calculé. */
export function resolveReminderAction(
  state: OnboardingStateView,
  phoneNumber: string | null | undefined,
): ReminderAction {
  const room = ROOM_STEPS.find((key) => !isCompleted(state, key));
  if (room) return { kind: 'room', step: room };

  const phoneOpen = firstOpen(state, PHONE_STEPS);
  const onlineOpen = firstOpen(state, ONLINE_STEPS);
  if (!phoneOpen && !onlineOpen) return { kind: 'complete' };

  // Sans numéro Suppernote, le téléphone ne peut pas se terminer : le restaurateur attend l'équipe
  // Suppernote, pas l'inverse. On ne le relance pas.
  if (!hasUsablePhone(phoneNumber)) return { kind: 'waiting-number' };

  const remaining: ReminderChannel[] = [];
  if (phoneOpen) remaining.push('phone');
  if (onlineOpen) remaining.push('online');
  return {
    kind: 'channels',
    remaining,
    step: remaining.length === 1 ? (phoneOpen ?? onlineOpen) : null,
  };
}

const ROOM_STEP_LABEL: Record<RoomStep, string> = {
  restaurant: 'les informations de votre restaurant',
  hours: 'vos horaires de réservation',
  floor: 'votre salle et vos règles de réservation',
};

const CHANNEL_LABEL: Record<ReminderChannel, string> = {
  phone: 'le téléphone',
  online: 'la réservation en ligne',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `+33451221999` → `04 51 22 19 99` ; tout autre format est renvoyé tel quel. */
export function formatFrenchPhoneNumber(e164: string): string {
  const match = /^\+33(\d{9})$/.exec(e164);
  if (!match) return e164;
  return `0${match[1]}`.replace(/(\d{2})(?=\d)/g, '$1 ');
}

function layout(args: {
  title: string;
  paragraphs: string[];
  cta: { label: string; href: string };
  restaurantName: string;
}): string {
  const paragraphs = args.paragraphs
    .map((text) => `<p style="margin:0 0 12px;line-height:1.5">${text}</p>`)
    .join('\n        ');
  return `
      <div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;color:#0f172a">
        <h1 style="font-size:22px;margin:0 0 12px">${args.title}</h1>
        ${paragraphs}
        <a href="${escapeHtml(args.cta.href)}"
           style="display:inline-block;margin-top:4px;background:#0f172a;color:white;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600">
          ${args.cta.label} →
        </a>
        <p style="margin-top:24px;color:#64748b;font-size:13px">
          Vous recevez cet e-mail parce que vous avez créé le compte Suppernote de ${escapeHtml(args.restaurantName)}.
        </p>
      </div>
    `;
}

/** `null` quand il n'y a rien à envoyer : parcours terminé, ou en attente de notre numéro. */
export function buildReminderEmail(args: {
  kind: ReminderKind;
  action: ReminderAction;
  restaurantName: string;
  /** Numéro Suppernote du restaurant, quand il est attribué. */
  assistantPhoneNumber?: string | null;
  dashboardUrl: string;
}): ReminderEmail | null {
  const { action } = args;
  const name = escapeHtml(args.restaurantName);
  const base = args.dashboardUrl.replace(/\/+$/, '');

  if (action.kind === 'waiting-number') return null;

  if (action.kind === 'room') {
    return {
      subject: `${args.restaurantName} : terminez la configuration de votre salle`,
      html: layout({
        restaurantName: args.restaurantName,
        title: `${name}, votre salle n’est pas encore prête`,
        paragraphs: [
          `Vous avez commencé à configurer ${name} sur Suppernote. La prochaine étape : ${ROOM_STEP_LABEL[action.step]}.`,
          'Votre salle (horaires, tables et règles) sert ensuite au téléphone comme à la réservation en ligne : vous la réglez une seule fois.',
        ],
        cta: { label: 'Reprendre la configuration', href: `${base}/onboarding` },
      }),
    };
  }

  if (action.kind === 'channels') {
    const both = action.remaining.length === 2;
    const remainingLabel = action.remaining.map((channel) => CHANNEL_LABEL[channel]).join(' et ');
    return {
      subject: `${args.restaurantName} : il vous reste ${both ? 'deux canaux' : 'un canal'} à activer`,
      html: layout({
        restaurantName: args.restaurantName,
        title: `${name}, votre salle est prête`,
        paragraphs: [
          both
            ? `Il reste à activer deux canaux pour ouvrir votre espace Suppernote : ${remainingLabel}. Vous les faites dans l’ordre de votre choix.`
            : `Il reste à activer ${remainingLabel} pour ouvrir votre espace Suppernote.`,
        ],
        cta: {
          label: both ? 'Choisir mon canal' : 'Reprendre la configuration',
          href: `${base}/onboarding?step=${both || !action.step ? 'canaux' : action.step}`,
        },
      }),
    };
  }

  // Parcours terminé : seule la relance « inactive » (aucun appel test validé) a encore un sens.
  if (args.kind !== 'inactive') return null;
  const number = args.assistantPhoneNumber
    ? escapeHtml(formatFrenchPhoneNumber(args.assistantPhoneNumber))
    : null;
  return {
    subject: `${args.restaurantName} : entendez votre assistant`,
    html: layout({
      restaurantName: args.restaurantName,
      title: 'Votre assistant vous attend',
      paragraphs: [
        `La configuration de ${name} est terminée.${
          number
            ? ` Pour entendre votre assistant, appelez votre numéro Suppernote depuis votre téléphone : <strong>${number}</strong>.`
            : ''
        }`,
        'Pour que vos clients tombent sur lui, renvoyez les appels de votre ligne vers ce numéro depuis votre opérateur.',
      ],
      cta: { label: 'Ouvrir mon espace', href: `${base}/dashboard` },
    }),
  };
}
