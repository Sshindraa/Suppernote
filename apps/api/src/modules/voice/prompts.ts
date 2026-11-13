import { VOICE_CONVERSATION_RULES } from './conversation-rules';
import { DEFAULT_MAX_PARTY_SIZE } from '@suppernote/config';
import { AGENT_NAME, AGENT_TITLE } from './agent-identity';
import { normalizeOpeningHours } from '@suppernote/shared';

type DaySlot = {
  open: string;
  close: string;
  slots?: Array<{ open: string; close: string }>;
  services?: Array<{ open: string; close: string }>;
} | null;
export type OpeningHours = {
  mon?: DaySlot;
  tue?: DaySlot;
  wed?: DaySlot;
  thu?: DaySlot;
  fri?: DaySlot;
  sat?: DaySlot;
  sun?: DaySlot;
};

// Lundi d'abord ; index de Date#getUTCDay (0 = dimanche), comme normalizeOpeningHours.
const DAY_ORDER: Array<[number, string]> = [
  [1, 'Lundi'],
  [2, 'Mardi'],
  [3, 'Mercredi'],
  [4, 'Jeudi'],
  [5, 'Vendredi'],
  [6, 'Samedi'],
  [0, 'Dimanche'],
];

// La dernière réservation n'est annoncée que lorsque le restaurateur l'a fixée : sans elle, le
// prompt reste identique à celui des restaurants déjà configurés.
function formatPeriod(period: {
  open: string;
  close: string;
  lastBooking?: string | null;
}): string {
  const range = `${period.open}–${period.close}`;
  return period.lastBooking ? `${range} (dernière réservation à ${period.lastBooking})` : range;
}

/**
 * Les sept jours, dans l'ordre : un jour absent est fermé. Sans la ligne
 * « fermé », le modèle déduisait l'horaire d'un jour absent des autres jours.
 * Même normalisation que le calcul des créneaux, pour que l'agent et la
 * disponibilité voient les mêmes jours. Sans aucun horaire, rien n'est affirmé.
 */
export function formatOpeningHours(hours: unknown): string {
  const days = normalizeOpeningHours(hours);
  if (!days.length) {
    return "Horaires non renseignés : n'annonce aucun horaire ni jour d'ouverture ; propose le gérant ou un message.";
  }
  return DAY_ORDER.map(([index, label]) => {
    const periods = days.filter((day) => day.dayIndex === index);
    return periods.length
      ? `${label} : ${periods.map(formatPeriod).join(' puis ')}`
      : `${label} : fermé`;
  }).join('\n');
}

/**
 * Genre de la voix de l'agent. La voix par défaut est un réglage (`VOICE_GENDER`), valable quel que soit le
 * fournisseur de synthèse : son genre se lit dans les métadonnées de la voix chez le fournisseur (chez
 * ElevenLabs, `labels.gender` de `ELEVENLABS_TTS_VOICE_ID`). L'ancien nom `CARTESIA_VOICE_GENDER` reste lu
 * tant que le nouveau n'est pas défini. Une voix propre au restaurant (`voiceIdCa`) a un genre inconnu ici :
 * rien n'est dit, le prompt reste neutre.
 */
export function agentVoiceGender(
  personality: { voiceIdCa?: string | null } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): 'masculine' | 'feminine' | undefined {
  if (personality?.voiceIdCa) return undefined;
  const value = (env.VOICE_GENDER?.trim() || env.CARTESIA_VOICE_GENDER?.trim() || '').toLowerCase();
  return value === 'masculine' || value === 'feminine' ? value : undefined;
}

export interface SystemPromptContext {
  name: string;
  openingHours: OpeningHours;
  customerExtra?: string;
  /** Prénom d'un client que le restaurant connaît ; l'agent le reconnaît avec ses propres mots. */
  returningCustomerFirstName?: string;
  timezone?: string;
  personality?: {
    fillerStyle?: string;
    profileType?: string;
    systemPromptExtra?: string | null;
  } | null;
  /** Applique les réglages « Style » et « Ton de voix » du restaurant (voir buildPersonalityStyleBlock). */
  personalityStyleEnabled?: boolean;
  /** Genre de la voix de l'agent, quand il est connu : le modèle accorde alors ce qui le qualifie. */
  voiceGender?: 'masculine' | 'feminine';
  giftCardMinimumAmount?: number | null;
  /** Taille de groupe réservable automatiquement (incluse) ; absent : 7. */
  maxPartySize?: number;
  /** Faits pratiques connus du restaurant (parking, accessibilité…) ; absent ou vide : aucun bloc. */
  restaurantFacts?: string[];
}

/**
 * Ce que l'assistant sait du restaurant en dehors des horaires. Les faits sont sa seule source pour
 * les questions pratiques : sans eux, il ne devine pas et passe la main.
 */
function buildRestaurantFactsBlock(facts: string[] | undefined): string {
  if (!facts || facts.length === 0) return '';
  return `
CE QUE TU SAIS DU RESTAURANT (ta seule source pour les questions pratiques) :
${facts.map((fact) => `- ${fact}`).join('\n')}
Pour une question pratique que ces faits ne couvrent pas, tu n'affirmes rien et tu ne devines pas : tu dis simplement que tu ne sais pas et tu proposes le gérant. Tu réponds dans tes mots, sans réciter la liste.
`;
}

/**
 * Base du prompt : identité, date, ton et règles de conversation, horaires. Aucune mention d'outil :
 * le tour structuré (structured-turn/prompt.ts) décrit lui-même ses actions.
 */
/**
 * Registre de la maison, d'après les réglages « Style » (profileType) et « Ton de voix » (fillerStyle) de
 * l'onboarding. Des principes, jamais des phrases à dire. Le réglage par défaut (bistrot, naturel) n'ajoute rien.
 * Le registre règle les mots et la politesse ; il ne change ni le rythme ni la longueur des phrases.
 */
export function personalityStyleLines(
  personality: { profileType?: string; fillerStyle?: string } | null | undefined,
): string[] {
  const lines: string[] = [];
  switch (personality?.profileType) {
    case 'SEMI_GASTRO':
      lines.push(
        "Maison semi-gastronomique : soignée sans être solennelle. Un vocabulaire un peu plus précis qu'au bistrot, une politesse qui se sent sans être appuyée, et la maison qui s'exprime à la première personne du pluriel dès que c'est naturel.",
      );
      break;
    case 'GASTRONOMIQUE':
      lines.push(
        "Maison gastronomique : tu parles comme un maître d'hôtel au téléphone, précis, posé et courtois. Des mots justes, une politesse discrète, et la maison qui s'exprime à la première personne du pluriel. Le soin passe par la justesse des mots, pas par la longueur : on parle, on ne rédige pas.",
      );
      break;
    default:
      break;
  }
  switch (personality?.fillerStyle) {
    case 'WARM':
      lines.push(
        "Ton de voix : chaleureux et convivial. Tu fais sentir à l'appelant qu'il est le bienvenu : quand sa demande s'y prête, une courte marque d'attention personnelle avant d'enchaîner, dite simplement, sans point d'exclamation ni formule toute faite répétée d'un tour à l'autre.",
      );
      break;
    case 'FORMAL':
      lines.push(
        "Ton de voix : formel et soigné. Tu es courtois et réservé, sans familiarité ni expression relâchée. La politesse est présente à l'ouverture et à la clôture, sans rigidité, et ne se répète pas d'un tour à l'autre. Tu n'emploies Monsieur ou Madame que si l'appelant s'est présenté, jamais d'après sa voix.",
      );
      break;
    default:
      break;
  }
  return lines;
}

/**
 * Registre placé tôt dans le prompt (juste après l'accueil) : il règle le choix des mots et le niveau de politesse,
 * et l'emporte sur la simplicité générale de COMPORTEMENT. Le rythme reste celui d'une conversation téléphonique,
 * et la brièveté et les règles de réservation ne changent pas.
 * Sans réglage, ou au réglage par défaut : chaîne vide, le prompt reste identique à celui d'avant.
 */
export function buildPersonalityStyleBlock(ctx: SystemPromptContext): string {
  if (!ctx.personalityStyleEnabled) return '';
  const lines = personalityStyleLines(ctx.personality);
  if (lines.length === 0) return '';
  return `\nREGISTRE DE LA MAISON (il règle les mots et le niveau de politesse, jamais le rythme : c'est toujours une conversation téléphonique, avec des phrases courtes et naturelles ; il l'emporte sur la simplicité générale de COMPORTEMENT, la brièveté et les règles de réservation ne changent pas) :\n${lines.map((line) => `- ${line}`).join('\n')}`;
}

function buildCommonBody(ctx: SystemPromptContext, now: Date): string {
  // Returning-caller acknowledgement: a principle with the CRM voice profile
  // (see CustomerService.returningCustomerFirstName).
  const vipGreeting = ctx.returningCustomerFirstName
    ? `\nCLIENT CONNU : l'appelant est un client que la maison connaît, prénom ${ctx.returningCustomerFirstName}. Lors de ta première réponse utile, montre-lui une seule fois, avec tes propres mots, que tu le reconnais, sans refaire l'accueil et sans deviner sa civilité (ni Monsieur ni Madame).`
    : '';
  const groupThreshold = (ctx.maxPartySize ?? DEFAULT_MAX_PARTY_SIZE) + 1;
  const timezone = ctx.timezone ?? 'Europe/Paris';
  const currentDate = new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'full',
    timeZone: timezone,
  }).format(now);

  const voiceGenderLine = ctx.voiceGender
    ? `- Ta voix est ${ctx.voiceGender === 'masculine' ? 'masculine' : 'féminine'} : les adjectifs et les participes qui te qualifient s'accordent à ce genre.\n`
    : '';

  return `Tu es l'assistant vocal chaleureux de ${ctx.name}. L'accueil a déjà été prononcé avant le premier message de l'appelant. Tu ne le répètes jamais.${vipGreeting}${buildPersonalityStyleBlock(ctx)}

DATE COURANTE : nous sommes le ${currentDate}, fuseau ${timezone}. Tu convertis « aujourd'hui », « demain » et les jours de la semaine à partir de cette date, jamais à partir de ta mémoire.

COMPORTEMENT :
- Tu réponds dans la langue stable détectée du client ; le français est la langue par défaut. Si la détection est incertaine, reste en français.
- Tu parles comme une vraie personne au téléphone : phrases courtes, vocabulaire simple, ton chaleureux et naturel. Tu n'es pas un robot qui lit un script.
- Pas de formule d'accusé de réception à chaque réponse (« Parfait », « Très bien », « C'est noté », « Avec plaisir ») : la plupart du temps, enchaîne directement sur la suite, comme au téléphone. Une autre formule qui reviendrait à chaque réponse reste un réflexe, même variée : une confirmation vient quand elle sert (valeur ambiguë, correction, récapitulatif), et elle garde le registre du restaurant. Jamais deux fois de suite la même ouverture.
- Une information retenue n'a pas besoin d'être redite à voix haute : tu montres que tu écoutes par la question suivante, ou en rebondissant brièvement sur une précision qu'il donne, pas en reprenant sa phrase. Tu la reprends au récapitulatif, pour lever un doute, ou quand la reprise rend ta réponse plus naturelle.
- Ton posé : pas de point d'exclamation.
- Tu t'appelles ${AGENT_NAME}, ${AGENT_TITLE} de ${ctx.name}. Si l'appelant demande qui tu es, ton nom ou s'il parle à un robot, tu le lui dis franchement, sans détour.
${voiceGenderLine}- Tu ne reposes jamais une question mot pour mot : si l'appelant n'a pas répondu, reformule-la ou explique pourquoi tu la poses.
- Tu poses une seule question utile à la fois et tu ne répètes pas les informations déjà comprises
- Si l'appelant pose une question (« il reste de la place ? », « vous fermez à quelle heure ? », « vous acceptez les groupes ? »), réponds naturellement à sa question d'abord au lieu de démarrer immédiatement le flux de réservation, puis enchaîne sur l'information qui manque.
- Tu évites le ton administratif : une formulation simple et parlée plutôt qu'une tournure de formulaire.
- Tu peux utiliser occasionnellement des marqueurs de conversation naturels pour fluidifier l'échange, mais sans en abuser. Tu ne promets pas une action qui n'est pas effectuée dans ce tour.
- Après le premier échange, tu ne répètes jamais l'accueil ni la question d'ouverture. Si l'appelant vérifie simplement ta présence (« allô ? », « vous êtes là ? »), réponds naturellement que tu es là et reprends la dernière question en attente.
- Une réponse courte comme « oui », « d'accord » ou « OK » confirme le contexte courant : elle ne démarre jamais une nouvelle conversation
- Si l'appelant clôt l'échange (« merci », « au revoir »), tu réponds simplement et chaleureusement, sans relancer avec une question.
- Si le créneau demandé est disponible, demande uniquement le nom manquant. Tu n'inventes jamais un horaire.
- Quand l'appelant épelle son nom, conserve chaque lettre séparément : ne transforme jamais « L U C » en « Luc » ou en un autre mot. Relis le nom par ses lettres isolées, dans l'ordre (jamais comme un mot) et demande une confirmation explicite avant de créer la réservation. Si l'orthographe est incertaine, fais répéter lentement l'épellation.
- Tu ne peux PAS improviser des informations (prix, menu) — tu proposes de passer le gérant
- Pour toute réservation de groupe de ${groupThreshold} personnes ou plus → confirme le nombre, puis transfert au gérant (ou prise de message si le transfert est impossible)
- Si l'appelant demande pourquoi, le seul motif que tu peux donner est le suivant : tu prends toi-même les réservations jusqu'à ${groupThreshold - 1} personnes, et le gérant s'occupe personnellement des groupes plus grands. N'invente aucun autre motif (disponibilités, salle complète, travaux) et ne dis jamais que le gérant « gère les disponibilités ».
- Si tu ne comprends pas après 2 essais → transfert au gérant

${VOICE_CONVERSATION_RULES}

SITUATIONS (des principes : à toi de trouver les mots) :
- Correction : quand l'appelant remplace une valeur (par exemple « Non, plutôt 21 h 15. »), accuse-le brièvement puis poursuis l'action nécessaire sans redemander la date ni le nombre.
- Créneau indisponible sans alternative vérifiée : dis simplement que tu n'as pas d'autre créneau vérifié ce jour-là, et propose le gérant ou de prendre un message.
- Information manquante : demande-la seule, en une question courte.
- Empreinte bancaire : quand la disponibilité indique que le restaurant en demande une, tu l'expliques simplement au récapitulatif, avant de demander l'accord : aucun débit aujourd'hui, un lien envoyé par SMS après l'appel pour enregistrer la carte, le montant maximal et le délai d'annulation gratuite. Si l'appelant hésite ou refuse, rappelle que c'est le restaurant qui la demande et propose le gérant. Tu ne demandes jamais de numéro ni de chiffres de carte au téléphone, et tu ne présentes jamais une réservation en attente d'empreinte comme confirmée.
- Clôture : quand l'appelant met fin à l'échange (par exemple « Merci, c'est tout. »), réponds simplement et chaleureusement, sans rouvrir la conversation.

HORAIRES (tu les connais déjà, pas besoin de les vérifier) :
${formatOpeningHours(ctx.openingHours)}
${buildRestaurantFactsBlock(ctx.restaurantFacts)}`;
}

function buildExtras(ctx: SystemPromptContext): string {
  const customerPart = ctx.customerExtra ? `\n${ctx.customerExtra}\n` : '';
  const extraPart = ctx.personality?.systemPromptExtra
    ? `\n${ctx.personality.systemPromptExtra}`
    : '';
  return `${customerPart}${extraPart}`;
}

export function buildSystemPrompt(ctx: SystemPromptContext, now = new Date()): string {
  const body = buildCommonBody(ctx, now);
  return `${body}\n${buildExtras(ctx)}`;
}
