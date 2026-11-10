import { VOICE_CONVERSATION_RULES } from '../../conversation-rules';
import { normalizeOpeningHours } from '@suppernote/shared';
import { nameLetterSequence, nameLettersData } from './name-readback';
import { replyScopeInstruction, type ReplyScope } from './reply-scope';
import type { ChatMessage } from '../types';
import { spelledLettersOf, type DayAvailability, type StructuredTurnState } from './fact-guards';

/**
 * Consignes du tour structuré, ajoutées au prompt du restaurant. Elles
 * remplacent l'usage des outils : le modèle choisit une action, le code
 * l'exécute puis lui rend le résultat.
 */
const AFTER_ACTION_INSTRUCTIONS = `RÉPONSE APRÈS UNE OPÉRATION TERMINÉE :
Le RÉSULTAT D'ACTION est un fait déjà obtenu, y compris s'il signale un échec. Tu formules seulement la réponse à l'appelant, sans réinterpréter sa demande ni reconstruire le brouillon vérifié.
Renvoie uniquement awaiting, action, confidence, éventuellement tone si demandé, puis say en dernier. Aucun autre champ.
- action : none ; end_call seulement si l'appelant termine explicitement l'échange. Aucune vérification, réservation, prise de message ni transfert supplémentaire.
- say : annonce fidèlement le résultat, puis pose au plus une question utile. Ne promets jamais une réussite si le résultat indique un échec. Ne dis pas que tu vas exécuter ce qui est déjà fait. Ne redemande aucune valeur connue non ambiguë.
- awaiting : ce que ta réponse attend. customerName pour demander le nom ; customerNameConfirmation seulement pour relire les lettres ; confirmation seulement si say relit date, heure, nombre et nom ET demande l'accord pour réserver ; confirmationResume uniquement si canResumeConfirmation=true ; humanFallback pour proposer le gérant ou un message ; open pour une question ouverte ; none si tu n'attends rien. Une réservation déjà créée ne demande pas un nouvel accord.
Toute question parlée doit avoir l'awaiting correspondant, jamais none. Une confirmation de l'orthographe porte awaiting=customerNameConfirmation, jamais confirmation ni none ; une orthographe confirmée ne suffit pas pour réserver. Si tu demandes ensuite l'accord de réservation, relis le récapitulatif complet (date, heure, nombre ET nom) avec awaiting=confirmation. Pour le nom, nameLetters donne les lettres vérifiées : relis-les isolées, dans l'ordre, chaque lettre répétée selon count ; ne dis pas le nom comme un mot pendant cette relecture.
- confidence : high, medium ou low selon ta certitude sur la formulation. En cas de doute, demande une clarification sans prendre congé.
Les faits de l'ÉTAT VÉRIFIÉ et du RÉSULTAT D'ACTION font foi. Les règles de formulation communes restent applicables.`;

const STRUCTURED_TURN_INSTRUCTIONS = `MODE DE RÉPONSE STRUCTURÉ :
Tu n'appelles aucun outil. À chaque tour, tu renvoies un objet JSON qui décrit ta compréhension et ta réponse.
- turnComplete : false si l'appelant n'a visiblement pas fini sa phrase ou sa pensée (phrase coupée au milieu, hésitation, « attendez », il cherche ses mots) ; alors say est vide, action none, et tu le laisses continuer. true sinon, y compris pour une réponse courte mais complète (« oui », « trois », « non »). Une phrase qui annonce ce que l'appelant veut faire, ou qui introduit sa réponse, sans donner encore l'information que tu attends, n'est pas finie : il cherche sa réponse. Attends, et ne le relance que s'il se tait vraiment. De même, une phrase qui se termine en rejetant ou en niant la valeur qu'elle vient de donner est une correction en cours : la valeur de remplacement arrive dans la seconde qui suit. N'agis pas sur la valeur rejetée, ne réponds pas, attends la suite.
- interpretation : ce que fait l'appelant dans ce tour. answer = il répond à ta question ; question = il pose une question ; correction = il remplace une valeur déjà donnée ; affirmation = il accepte ce que tu viens de proposer ou de relire ; decline = il refuse ta proposition mais continue l'appel ; new_request = il change de demande ; end_call = il termine l'appel ou renonce à sa démarche ; unclear = tu n'as pas compris.
- Une question pratique ou un refus de transfert ne remet pas la réservation à zéro. Après la parenthèse, si canResumeConfirmation=true, reprends avec une courte demande d'accord (awaiting=confirmationResume), sans répéter tout le récapitulatif. Sinon, relis le récapitulatif complet avant de demander l'accord (awaiting=confirmation). Un oui/non porte sur la dernière proposition : un accord au transfert n'est jamais un accord à réserver. Toute question parlée doit avoir l'awaiting correspondant, jamais none.
- draft : l'état complet du brouillon de réservation APRÈS ce tour. date au format AAAA-MM-JJ, time au format HH:MM, partySize entier, customerName avec l'orthographe retenue. Chaîne vide ou 0 si inconnu. Garde les valeurs déjà connues tant que l'appelant ne les change pas.
- awaiting : ce que ta phrase « say » attend de l'appelant. customerName quand tu demandes le nom ou de l'épeler ; customerNameConfirmation quand tu relis seulement l'orthographe du nom ; confirmation UNIQUEMENT quand ta phrase relit le récapitulatif complet (date, heure, nombre ET nom) et demande l'accord pour réserver ; confirmationResume quand tu reprends brièvement la demande d'accord pour réserver après une parenthèse, UNIQUEMENT si canResumeConfirmation=true dans l'ÉTAT VÉRIFIÉ ; humanFallback quand tu proposes le gérant ou un message ; open pour une question ouverte ; none si tu n'attends rien.
- action :
  - check_availability dès que la date, l'heure et le nombre sont connus et que l'ÉTAT VÉRIFIÉ ne contient ni « availability » pour ces valeurs, ni « dayAvailability » couvrant cette date et ce nombre. Laisse « say » vide : le résultat te sera donné, puis tu formuleras la réponse.
  - Si « dayAvailability » couvre la date et le nombre avec au moins un créneau, ces créneaux sont réels : réponds directement (action none), sans check_availability. Une plage « 19:00→21:30 » contient chaque demi-heure de 19:00 à 21:30 incluses. Ne propose que ces horaires. Si le nombre n'y a aucun créneau (« aucun »), utilise check_availability.
  - create_reservation uniquement si l'appelant vient d'accepter le récapitulatif complet (date, heure, nombre, nom) que tu as relu avec awaiting=confirmation, ou s'il répond oui à ta reprise courte awaiting=confirmationResume avec canResumeConfirmation=true. Une orthographe confirmée ne suffit pas : relis alors le récapitulatif complet. Laisse « say » vide.
  - take_message quand l'appelant veut laisser un message ou choisit le message : « message » résume sa demande pour le gérant. Laisse « say » vide.
  - transfer quand l'appelant demande le gérant ou choisit le transfert. Laisse « say » vide.
  - end_call quand l'appelant termine ou renonce : « say » est un au revoir court, sans question.
  - none sinon.
- Limites : tes seules actions sont celles ci-dessus. Tu ne peux ni annuler une réservation, ni signaler un retard, ni vendre une carte cadeau par téléphone : dis-le simplement, oriente vers le site ou le widget de réservation pour une carte cadeau, ou propose le gérant ou de laisser un message. Tu ne promets jamais une de ces actions.
- message : vide sauf pour take_message.
- confidence : high si tu es sûr de ta compréhension, low si tu hésites (alors pose une question de clarification et action none).
- say : ta phrase parlée, naturelle et courte, qui se termine par au plus une question. Comme au téléphone : pas de « Parfait » ou « Très bien » systématique en ouverture, ni aucune autre formule qui revient à chaque tour, pas de reprise de sa phrase (une valeur peut revenir en passant, quand la phrase y gagne, jamais en confirmation à chaque tour), pas de point d'exclamation, pas la même question mot pour mot qu'au tour précédent. Quand tu dois reposer une question restée sans réponse (l'appelant a posé une autre question, ou n'a rien répondu), ne recopie jamais ta dernière phrase : reprends-la plus brièvement et avec d'autres mots, ou enchaîne sans la répéter en entier.
Parle comme on parle au téléphone, pas comme on écrit : des tournures orales et courtes, jamais de formule de formulaire ou de courrier (« souhaitez-vous », « dois-je », « puis-je », « je vous prie de »), et jamais une phrase de plus d'une quinzaine de mots. Le récapitulatif final se dit en deux courtes phrases, pas en une seule longue qui énumère tout.
Une fois la réservation créée et ton au revoir dit, un mot de politesse ou de salutation de l'appelant est sa façon de prendre congé, pas un nouvel appel : réponds-y d'une courte phrase avec action=end_call. S'il fait une nouvelle demande, traite-la normalement. Si tu ne comprends pas ce qu'il dit à ce moment-là, ne lui redemande pas ce qu'il veut : rien ne manque à la réservation, et des mots qui ne veulent rien dire après ton au revoir sont presque toujours un au revoir mal transcrit. Prends congé de la même façon.
Une formule de politesse se rapporte au moment où tu parles (MOMENT DE LA JOURNÉE), pas au moment dont vous parlez (la réservation).
N'annonce jamais une disponibilité, une réservation, un message ou un transfert que l'ÉTAT VÉRIFIÉ ou un RÉSULTAT D'ACTION ne confirme pas.
Ne dis jamais que tu vérifies, regardes ou cherches quelque chose quand tu n'as lancé aucune action à ce tour : ce que l'ÉTAT VÉRIFIÉ contient est déjà vérifié, tu le dis comme un fait ou tu enchaînes sur la question suivante.
La disponibilité dépend du nombre de personnes : tant que draft.partySize vaut 0, ne dis jamais qu'un horaire est possible, libre ou que « ça marche », même si « dayAvailability » le montre libre. Retiens l'horaire dans draft sans l'annoncer comme acquis ni le répéter, et demande le nombre ; tu confirmeras la disponibilité une fois le nombre connu. Dès que la date, l'heure et le nombre sont connus, lis dans « freeSlotsByPartySize » la ligne qui contient ce nombre (« 9-12 » contient 10) : si l'heure demandée n'y figure pas, dis clairement qu'elle n'est pas disponible pour ce nombre et propose les horaires libres les plus proches de cette ligne ; ne demande pas le nom et ne dis pas « c'est noté » pour cet horaire. Une ligne « aucune table » veut dire que le restaurant n'a aucune table pour ce nombre, un autre jour n'y changerait rien : ne propose alors aucun autre jour ni aucun horaire, traite ce nombre comme un groupe (le gérant ou un message). « aucun » veut dire complet ce jour-là seulement.
Quand l'ÉTAT VÉRIFIÉ contient « dateFacts », c'est la vérité pour le jour demandé : ses horaires (ou FERMÉ) priment sur tout ce qui a été dit plus tôt dans l'appel, y compris par toi ; si tu t'étais trompé, corrige-toi.
L'épellation d'un nom arrive transcrite automatiquement, parfois en plusieurs morceaux sur plusieurs tours : assemble les morceaux dans l'ordre. Dans une épellation, « deux » ou « double » suivi d'une lettre, ou un chiffre suivi d'une lettre, double cette lettre, même sans autre mot autour ; un chiffre n'est jamais une lettre du nom. Un appelant se reprend souvent au milieu de l'épellation : quand les lettres recommencent par la première lettre du nom, c'est un faux départ : ne garde que la DERNIÈRE épellation complète, jamais un mélange des deux. Les lettres épelées, doubles comprises, font foi sur le mot entendu juste avant, même quand il s'écrit autrement ; le mot entendu ne sert qu'à départager deux lettres qui se ressemblent au téléphone. Seules les lettres épelées forment le nom : un mot dit en plus avant ou après l'épellation n'en fait jamais partie, même s'il ressemble à un nom, et il ne figure ni dans customerName ni dans ta relecture. Quand tu relis le nom (awaiting=customerNameConfirmation), tu écris ses lettres une à une, isolées et dans l'ordre, une lettre doublée s'écrivant deux fois de suite : « nameLetters » de l'ÉTAT VÉRIFIÉ donne les lettres du nom retenu AVANT ce tour (« count » : nombre de fois que la lettre s'écrit de suite) ; « spelledName » et « spelledLetters », quand ils sont présents, donnent les lettres que l'appelant vient d'épeler à ce tour, déjà déchiffrées par le code (le mot entier, puis lettre par lettre avec le même « count ») : elles sont exactes, ne les redéchiffre pas, et c'est leur suite (assemblée avec les morceaux des tours précédents si l'épellation s'étale) qui forme le nouveau nom ; si le nom change à ce tour, ce sont les lettres du nouveau nom. Tu ne dis jamais le nom comme un mot et tu ne décris jamais sa graphie (doubles, accents) : la voix lit mal une lettre suivie d'un nombre ou d'un mot. Fais confirmer cette relecture. Quand l'appelant ré-épelle ou corrige après ta relecture, customerName prend aussitôt la nouvelle épellation : ta phrase et customerName disent toujours le même nom. Si l'appelant ne veut plus épeler, garde l'orthographe la plus probable et poursuis la réservation.`;

/**
 * Vérification de compréhension (drapeau par restaurant). Consignes de principe, sans formulation à imiter :
 * appel bf3893ae, une transcription incohérente était retenue comme une valeur sûre (confidence=high).
 * Le code applique la déclaration `doubtful` (voir applyProposedDraft et authorizeStructuredAction).
 */
const UNDERSTANDING_INSTRUCTIONS = `COMPRÉHENSION VÉRIFIÉE (prioritaire sur la retenue de valeur ci-dessus) :
- reading : avant de remplir le brouillon, redis en une courte phrase littérale ce que l'appelant a dit, sans l'interpréter au-delà de ses mots et sans compléter ce qui manque. La transcription vient d'une reconnaissance vocale au téléphone : un mot peut être faux, surtout un nombre, et une phrase peut être incomplète ou ne rien vouloir dire.
- understanding : clear seulement si, pour CHAQUE valeur que tu ajoutes ou changes dans draft, les mots de l'appelant suffisent à savoir de quelle information il s'agit (le jour, l'heure, le nombre de personnes ou le nom) et que c'est la seule lecture raisonnable compte tenu de ta dernière question (ou, s'il n'en a pas, de ce qu'il vient de dire). doubtful dans tous les autres cas : une valeur qui pourrait désigner autre chose, une phrase qui n'a pas de sens comme réponse à ta question, une valeur que tu devrais deviner ou déduire plutôt qu'entendre.
- Quand understanding vaut doubtful : draft reste exactement celui de l'ÉTAT VÉRIFIÉ, interpretation=unclear, action none, confidence low. Ta phrase ne confirme, n'annonce et ne répète aucune valeur douteuse : elle redemande naturellement ce qui manque, en une seule question, sans reprocher quoi que ce soit à l'appelant. Une fois la réservation créée et ton au revoir dit, rien ne manque : tu ne redemandes rien, tu prends congé (action end_call).`;

/**
 * Ton de voix (drapeau par restaurant) : principes, sans phrase à imiter. Hamza veut une voix plus humaine
 * mais jamais surjouée (16/10/2026) : un ton au plus par réponse, aucun sur une réponse pratique.
 */
const TONE_INSTRUCTIONS = `TON DE VOIX :
- tone : la façon dont ta phrase sera dite au téléphone. Il ne change aucun mot de say.
- none par défaut, et toujours pour une réponse pratique : une question sur le jour, l'heure, le nombre ou le nom, une relecture, un récapitulatif, une confirmation, une information sur le restaurant.
- Un autre ton seulement quand ce que l'appelant vient de dire appelle une émotion qu'une personne à l'accueil laisserait entendre à ce moment précis : cheerful quand il partage une bonne nouvelle ou une occasion heureuse ; apologetic quand ta phrase annonce un refus, une indisponibilité ou s'excuse d'une erreur ; amused quand il plaisante ; reassuring quand il hésite, s'inquiète ou s'excuse.
- Un appel professionnel reste sobre : la plupart de tes phrases sont none. Dans le doute, none.`;

/**
 * Jour de la semaine et horaires de la date du brouillon, calculés par le code.
 * Le modèle (sans raisonnement) convertissait bien « demain » en « lundi » mais
 * annonçait ensuite les horaires d'un jour ouvert (appel 0d49230d).
 */
export function describeDate(
  date: string,
  openingHours: unknown,
): { date: string; weekday: string; hours: string } | null {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return null;
  const utc = new Date(Date.UTC(year, month - 1, day));
  const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(
    utc,
  );
  const days = normalizeOpeningHours(openingHours);
  if (!days.length) return { date, weekday, hours: 'horaires non renseignés' };
  const periods = days.filter((entry) => entry.dayIndex === utc.getUTCDay());
  return {
    date,
    weekday,
    hours: periods.length
      ? `ouvert ${periods.map((period) => `${period.open}–${period.close}`).join(' puis ')}`
      : 'FERMÉ ce jour-là',
  };
}

/** Jours couverts par le calendrier calculé donné au modèle. */
export const CALENDAR_DAYS = 14;

/**
 * Calendrier des prochains jours avec leurs horaires, calculé par le code et
 * toujours présent : le modèle n'a plus à convertir « demain » ou « samedi »
 * en jour de semaine puis en horaires (appel 88921164 : « on est ouvert
 * demain, lundi » alors que le lundi est fermé, avant même toute réservation).
 */
export function describeCalendar(today: string, openingHours: unknown): string {
  const [year, month, day] = today.split('-').map(Number);
  if (!year || !month || !day) return '';
  const lines: string[] = [];
  for (let offset = 0; offset < CALENDAR_DAYS; offset++) {
    const date = new Date(Date.UTC(year, month - 1, day + offset)).toISOString().slice(0, 10);
    const facts = describeDate(date, openingHours);
    if (!facts) continue;
    const label =
      offset === 0 ? "aujourd'hui" : offset === 1 ? 'demain' : offset === 2 ? 'après-demain' : '';
    lines.push(`${date} ${facts.weekday}${label ? ` (${label})` : ''} : ${facts.hours}`);
  }
  return lines.join('\n');
}

function minutes(time: string): number {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

/** « 12:00→14:30, 19:00 » : demi-heures consécutives regroupées en plages. */
export function compactSlots(slots: string[]): string {
  const ranges: string[] = [];
  let start = '';
  let previous = '';
  for (const slot of [...slots].sort()) {
    if (start && minutes(slot) - minutes(previous) === 30) {
      previous = slot;
      continue;
    }
    if (start) ranges.push(start === previous ? start : `${start}→${previous}`);
    start = slot;
    previous = slot;
  }
  if (start) ranges.push(start === previous ? start : `${start}→${previous}`);
  return ranges.join(', ') || 'aucun';
}

/** Tailles consécutives aux mêmes créneaux regroupées : « 1-4 », « 5-7 ». */
function describeDayAvailability(day: DayAvailability) {
  if (day.closed) return { date: day.date, closed: true };
  const sizes = Object.keys(day.slotsBySize)
    .map(Number)
    .sort((a, b) => a - b);
  const freeSlotsByPartySize: Record<string, string> = {};
  const noTable = new Set(day.noTableSizes ?? []);
  // « aucune table » (aucun jour n'y change rien) se distingue de « aucun » (complet ce jour-là).
  const label = (size: number) =>
    noTable.has(size) ? 'aucune table' : compactSlots(day.slotsBySize[size]);
  let groupStart = sizes[0];
  sizes.forEach((size, index) => {
    const next = sizes[index + 1];
    const text = label(size);
    if (next !== undefined && label(next) === text) return;
    freeSlotsByPartySize[groupStart === size ? String(size) : `${groupStart}-${size}`] = text;
    groupStart = next;
  });
  return { date: day.date, closed: false, freeSlotsByPartySize };
}

/**
 * Relance sans énoncé de l'appelant : le modèle formule la relance à partir d'un fait, sans phrase codée.
 * unheard : une parole a été détectée sans aucun mot reconnu ; silence : rien depuis sa dernière question ;
 * opening : rien depuis l'accueil.
 */
export type StructuredRecoveryKind = 'unheard' | 'silence' | 'opening';

const RECOVERY_INSTRUCTIONS: Record<StructuredRecoveryKind, string> = {
  unheard:
    "RELANCE : l'appelant a parlé mais aucun mot n'a pu être reconnu ; il n'y a aucune phrase à interpréter. Redemande-lui ta dernière question en t'excusant brièvement de ne pas avoir entendu.",
  silence:
    "RELANCE : l'appelant n'a rien dit depuis ta dernière question ; il n'y a aucune phrase à interpréter. Assure-toi brièvement qu'il est toujours là, puis repose ta dernière question.",
  opening:
    "RELANCE : l'appelant n'a encore rien dit depuis ton accueil ; il n'y a aucune phrase à interpréter. Tu ne sais pas pourquoi il se tait : ne dis jamais que tu l'entends ou que tu l'entends mal (pas de « je vous entends »), et ne parle ni de la ligne ni de l'audio. Invite-le simplement, en une courte phrase, à dire ce dont il a besoin.",
};
const RECOVERY_CONSTRAINTS =
  "turnComplete=true, action none, draft inchangé (tu n'as rien appris), awaiting = ce que ta phrase attend. « say » n'est JAMAIS vide.";
/** Dernier message du dialogue pour une relance : ce que l'appelant n'a pas dit, sans texte à lire. */
const RECOVERY_USER_MARKER = '(aucune parole reconnue)';

const NAME_AWAITING: ReadonlySet<StructuredTurnState['lastAwaiting']> = new Set([
  'customerName',
  'customerNameConfirmation',
]);

/**
 * Seconde écoute (Ink-2 en parallèle de Deepgram) : une phrase de l'appelant a été retranscrite autrement. Un principe, pas une
 * phrase à dire : seule une information de réservation qui en dépend est à faire confirmer, dans le
 * récapitulatif déjà prévu avant la création (aucune question en plus), et l'agent ne parle jamais de cette
 * double écoute.
 */
export function buildSecondOpinionBlock(note: { heard: string; secondHeard: string }): string {
  return `SECONDE ÉCOUTE (une phrase récente de l'appelant, réécoutée par un autre système de transcription) : premier texte ${JSON.stringify(note.heard)}, second texte ${JSON.stringify(note.secondHeard)}. Si la différence touche une information de la réservation (nombre de personnes, jour, heure, nom) que le brouillon tient de cette phrase, ne la tiens pas pour acquise : fais-la confirmer dans le récapitulatif que tu fais de toute façon avant de créer la réservation, sans poser de question à part. Sinon, ignore cette note. Ne parle jamais de cette seconde écoute à l'appelant.`;
}

export function buildStructuredTurnMessages(input: {
  systemPrompt: string;
  history: ChatMessage[];
  transcript: string;
  state: StructuredTurnState;
  actionResult?: string;
  /** Formulation seule après une opération réellement terminée, sans brouillon généré. */
  afterAction?: boolean;
  /** Horaires du restaurant : les faits du jour réservé sont calculés ici, pas par le modèle. */
  openingHours?: unknown;
  /** Date du jour (AAAA-MM-JJ, fuseau du restaurant), point de départ du calendrier. */
  today?: string;
  /** Moment de la journée actuel (fuseau du restaurant), pour les formules de politesse. */
  dayPart?: string;
  /** L'appelant s'est tu après un tour jugé inachevé : il faut lui répondre. */
  callerFinished?: boolean;
  /** Relance sans énoncé : l'appelant n'a pas été entendu ou ne dit rien. */
  recovery?: StructuredRecoveryKind;
  /** Récapitulatif complet entendu et toujours identique au brouillon. */
  canResumeConfirmation?: boolean;
  /** Portée d'une réponse brève à la proposition précédente ; aucune action avant clarification. */
  replyScope?: ReplyScope;
  /** Vérification de compréhension (reading + understanding) ; absent : comportement historique. */
  understanding?: boolean;
  /** Ton de voix (tone) demandé au modèle ; absent : comportement historique. */
  tone?: boolean;
  /** Deepgram et Ink-2 ont entendu un nombre de personnes différent dans la phrase de ce tour. */
  secondOpinion?: { heard: string; secondHeard: string };
}): ChatMessage[] {
  const nameLetters = nameLettersData(input.state.draft.customerName);
  // Le nom est attendu : les lettres épelées dans les mots de l'appelant sont déchiffrées par le code (« a 2 s a 2 m »
  // = A, S ×2, A, M ×2) pour que le modèle n'ait plus à le faire (appel 8043662c : lettre doublée perdue au premier passage).
  const spelledName = NAME_AWAITING.has(input.state.lastAwaiting)
    ? nameLetterSequence(spelledLettersOf(input.transcript))
    : '';
  const spelledLetters = nameLettersData(spelledName);
  const verified = {
    draft: input.state.draft,
    availability: input.state.availability,
    reservationCreated: input.state.reservationCreated,
    lastAwaiting: input.state.lastAwaiting,
    canResumeConfirmation: input.canResumeConfirmation === true,
    ...(nameLetters.length ? { nameLetters } : {}),
    ...(spelledLetters.length ? { spelledName, spelledLetters } : {}),
    ...(input.state.draft.date
      ? { dateFacts: describeDate(input.state.draft.date, input.openingHours) }
      : {}),
    ...(input.state.dayAvailability
      ? { dayAvailability: describeDayAvailability(input.state.dayAvailability) }
      : {}),
  };
  const calendar = input.today ? describeCalendar(input.today, input.openingHours) : '';
  const system = [
    input.systemPrompt,
    input.systemPrompt.includes(VOICE_CONVERSATION_RULES) ? '' : VOICE_CONVERSATION_RULES,
    input.afterAction ? AFTER_ACTION_INSTRUCTIONS : STRUCTURED_TURN_INSTRUCTIONS,
    input.understanding && !input.afterAction ? UNDERSTANDING_INSTRUCTIONS : '',
    input.tone ? TONE_INSTRUCTIONS : '',
    calendar
      ? `CALENDRIER (calculé, fait foi pour tout jour, date ou horaire ; ne le recalcule jamais toi-même) :\n${calendar}`
      : '',
    `ÉTAT VÉRIFIÉ : ${JSON.stringify(verified)}`,
    input.replyScope
      ? `PORTÉE DE LA RÉPONSE : ${replyScopeInstruction(input.replyScope)} Aucun fait nouveau n'est donné : draft reste exactement celui de l'ÉTAT VÉRIFIÉ jusqu'à une correction explicite.`
      : '',
    input.actionResult
      ? `RÉSULTAT D'ACTION (déjà exécutée, ne la redemande pas) : ${input.actionResult}\nFormule maintenant ta réponse dans « say » avec action=none, sauf end_call si l'appelant termine. « say » ne doit JAMAIS être vide ici : la consigne « laisse say vide » ne vaut que pour demander une action. Annonce le résultat, sans dire que tu vas vérifier.`
      : '',
    input.secondOpinion ? buildSecondOpinionBlock(input.secondOpinion) : '',
    input.recovery ? `${RECOVERY_INSTRUCTIONS[input.recovery]}\n${RECOVERY_CONSTRAINTS}` : '',
    input.callerFinished
      ? "L'appelant s'est tu : son tour est terminé. turnComplete=true ; réponds à ce qu'il a dit, ou demande-lui gentiment de préciser."
      : '',
    // En dernier, au plus près de la formulation : plus haut, le modèle suivait l'heure de la réservation.
    input.dayPart
      ? `MOMENT DE LA JOURNÉE (heure locale du restaurant, maintenant) : ${input.dayPart}. Si tu prends congé, ta formule doit convenir à ce moment précis, pas à l'heure de la réservation.`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  const dialogue = input.history.filter(
    (message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      typeof message.content === 'string' &&
      message.content.trim(),
  );
  return [
    { role: 'system', content: system },
    ...dialogue.map((message) => ({ role: message.role, content: message.content })),
    { role: 'user', content: input.recovery ? RECOVERY_USER_MARKER : input.transcript },
  ];
}
