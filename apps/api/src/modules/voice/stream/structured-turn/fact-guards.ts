/**
 * Garde-fous de faits du tour structuré. Ils ne cherchent pas à comprendre
 * l'appelant : ils vérifient que les valeurs proposées par le modèle ont un
 * format valide, sont plausibles, et qu'une action à effet réel repose sur
 * des faits vérifiés (disponibilité réelle, récapitulatif accepté).
 */
import { normalizeOpeningHours } from '@suppernote/shared';
import { readbackInstruction } from './name-readback';
import type { StructuredTurnDraft, StructuredTurnOutput } from './schema';
import type { ReplyScope } from './reply-scope';

export type DraftField = keyof StructuredTurnDraft;

export interface StructuredTurnState {
  draft: StructuredTurnDraft;
  /** Ce que la dernière réponse parlée attendait de l'appelant. */
  lastAwaiting: StructuredTurnOutput['awaiting'];
  /** Brouillon lu au récapitulatif du tour précédent, s'il attendait un accord. */
  recapKey: string | null;
  /** Récapitulatif entendu et inchangé, conservé pendant une question annexe. */
  resumableRecapKey: string | null;
  /** Dernier résultat réel du moteur de disponibilité. */
  availability: { date: string; partySize: number; slots: string[] } | null;
  /**
   * Créneaux réels du jour du brouillon pour chaque taille de groupe, lus en
   * tâche de fond dès que la date est connue : le modèle répond en un passage.
   */
  dayAvailability: DayAvailability | null;
  reservationCreated: boolean;
  /** Début de phrase jugé inachevé par le modèle, recollé au tour suivant. */
  pendingFragment: string | null;
  /**
   * Début de phrase pris par la relance après silence, tant qu'elle n'a pas parlé. Si l'appelant reprend avant,
   * le tour suivant le récupère (appel bb50c0d3 : la lettre A d'une épellation perdue ainsi).
   */
  unansweredFragment?: string | null;
  /** Récapitulatif dont le « oui » a déjà été refusé une fois parce qu'il avait été coupé. */
  recapCutBlockedKey: string | null;
}

export interface DayAvailability {
  date: string;
  /** Aucun créneau généré pour ce jour : le restaurant n'ouvre pas. */
  closed: boolean;
  /** Créneaux libres par taille de groupe, de 1 au maximum vocal. */
  slotsBySize: Record<number, string[]>;
  /**
   * Tailles de groupe qu'AUCUNE table du restaurant n'accueille, quel que soit le jour (appel 03b19223 :
   * 7 personnes pour des tables de 6 au plus, annoncé « complet samedi »). Vide : inconnu ou toutes accueillies.
   */
  noTableSizes?: number[];
}

/**
 * Tailles (de 1 à `maxSize`) qu'aucune plage d'accueil ne couvre. Même critère que la disponibilité : une table
 * accueille N si `minCapacity <= N <= capacity`. Sans table connue, rien n'est affirmé (liste vide).
 */
export function sizesWithoutTable(
  ranges: ReadonlyArray<{ capacity: number; minCapacity: number }>,
  maxSize: number,
): number[] {
  if (!ranges.length) return [];
  const sizes: number[] = [];
  for (let size = 1; size <= maxSize; size++) {
    if (!ranges.some((range) => range.minCapacity <= size && size <= range.capacity))
      sizes.push(size);
  }
  return sizes;
}

/** Nom en casse normale (« Dupont », pas « DUPONT ») : la voix le lit comme un nom, pas lettre par lettre. */
export function speakableName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(
      /(^|[\s-])(\p{L})/gu,
      (_match, separator: string, letter: string) => separator + letter.toUpperCase(),
    );
}

/** Client reconnu : son nom est déjà au brouillon, à proposer à l'appelant au lieu de le redemander. */
export function createStructuredTurnStateWithName(name: string): StructuredTurnState {
  const state = createStructuredTurnState();
  return { ...state, draft: { ...state.draft, customerName: speakableName(name) } };
}

export function createStructuredTurnState(): StructuredTurnState {
  return {
    draft: { date: '', time: '', partySize: 0, customerName: '' },
    lastAwaiting: 'none',
    recapKey: null,
    resumableRecapKey: null,
    availability: null,
    dayAvailability: null,
    reservationCreated: false,
    pendingFragment: null,
    recapCutBlockedKey: null,
  };
}

const MAX_BOOKING_HORIZON_DAYS = 366;
const MAX_NAME_LENGTH = 60;

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Date du jour dans le fuseau du restaurant, au format AAAA-MM-JJ. */
export function todayInTimezone(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Heure locale pleine et moment de la journée dans le fuseau du restaurant (« 15 h,
 * après-midi ») : un fait pour les formules de politesse. Sans les minutes, pour que la
 * requête spéculative reste identique à celle du tour final.
 */
export function dayPartInTimezone(timezone: string, now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(now)
      .find((part) => part.type === 'hour')?.value,
  );
  const part = hour < 5 ? 'nuit' : hour < 12 ? 'matin' : hour < 18 ? 'après-midi' : 'soir';
  return `${hour} h, ${part}`;
}

function isValidField(
  field: DraftField,
  value: StructuredTurnDraft[DraftField],
  context: { today: string },
): boolean {
  switch (field) {
    case 'date': {
      const date = value as string;
      return (
        isCalendarDate(date) &&
        date >= context.today &&
        date <= addDays(context.today, MAX_BOOKING_HORIZON_DAYS)
      );
    }
    case 'time':
      return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value as string);
    case 'partySize':
      return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 99;
    case 'customerName': {
      const name = (value as string).trim();
      return name.length <= MAX_NAME_LENGTH && /^[\p{L}][\p{L}\s'’-]*$/u.test(name);
    }
  }
}

function isUnset(field: DraftField, value: StructuredTurnDraft[DraftField]): boolean {
  return field === 'partySize' ? value === 0 : (value as string).trim() === '';
}

/**
 * Applique le brouillon proposé champ par champ. Une valeur invalide garde la
 * valeur précédente ; un champ vidé ne l'est que si le modèle interprète le
 * tour comme une correction.
 */
export function applyProposedDraft(
  previous: StructuredTurnDraft,
  output: Pick<StructuredTurnOutput, 'draft' | 'interpretation' | 'understanding'>,
  context: { today: string },
): { draft: StructuredTurnDraft; rejected: DraftField[]; changed: DraftField[] } {
  const draft = { ...previous };
  const rejected: DraftField[] = [];
  const changed: DraftField[] = [];
  // Le modèle déclare avoir deviné : rien n'entre dans le brouillon, quelle que soit la valeur proposée.
  const doubtful = output.understanding === 'doubtful';
  for (const field of Object.keys(previous) as DraftField[]) {
    const proposed = output.draft[field];
    if (proposed === previous[field]) continue;
    if (doubtful) {
      rejected.push(field);
      continue;
    }
    if (isUnset(field, proposed)) {
      if (output.interpretation === 'correction') {
        (draft as Record<DraftField, unknown>)[field] = field === 'partySize' ? 0 : '';
        changed.push(field);
      }
      continue;
    }
    const normalized = typeof proposed === 'string' ? proposed.trim() : proposed;
    if (!isValidField(field, normalized, context)) {
      rejected.push(field);
      continue;
    }
    (draft as Record<DraftField, unknown>)[field] = normalized;
    changed.push(field);
  }
  return { draft, rejected, changed };
}

const SPELLING_AWAITING: ReadonlySet<StructuredTurnOutput['awaiting']> = new Set([
  'customerName',
  'customerNameConfirmation',
  'confirmation',
]);

/** L'agent attend un nom ou sa relecture : une lettre seule de l'appelant appartient à l'épellation. */
export function expectsSpelledLetters(
  awaiting: StructuredTurnOutput['awaiting'] | undefined,
): boolean {
  return awaiting !== undefined && SPELLING_AWAITING.has(awaiting);
}

const stripToLetters = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}]/gu, '')
    .toUpperCase();

/**
 * Suites de lettres épelées d'une phrase (trois lettres au moins chacune) : des jetons d'une lettre, un chiffre
 * suivi d'une lettre doublant cette lettre (« a 2 k i f » = AKKIF). Un mot, ou un chiffre sans lettre derrière,
 * coupe la suite.
 */
function spelledRuns(transcript: string): string[] {
  const tokens = transcript
    .toLowerCase()
    .split(/[\s,.;:!?-]+/u)
    .filter(Boolean);
  const runs: string[] = [];
  let run = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (/^\p{L}$/u.test(token)) {
      run += token;
    } else if (/^[2-9]$/.test(token) && next && /^\p{L}$/u.test(next)) {
      run += next.repeat(Number(token));
      index++;
    } else {
      if (run.length >= 3) runs.push(run);
      run = '';
    }
  }
  if (run.length >= 3) runs.push(run);
  return runs.map(stripToLetters);
}

/** Dernière suite de lettres épelées d'une phrase ; vide sans trois lettres (voir `spelledRuns`). */
export function spelledLettersOf(transcript: string): string {
  return spelledRuns(transcript).at(-1) ?? '';
}

/** `needle` est une suite de lettres prise dans `haystack`, dans l'ordre. */
function isSubsequence(needle: string, haystack: string): boolean {
  let position = 0;
  for (const letter of haystack) if (letter === needle[position]) position++;
  return position === needle.length;
}

/**
 * Mot(s) collé(s) APRÈS l'épellation dans le nom du modèle (« HOUET » épelé, nom écrit « HOUET DIMANCHE » :
 * un mot dit en plus, parasite ou erreur de reconnaissance, pris pour une partie du nom). Test structurel, sans
 * aucun mot connu : les premiers mots du nom, mis bout à bout, ne font QUE les lettres épelées et il en reste
 * d'autres derrière. Le modèle a lui-même séparé ce reste par un espace ; sans cette séparation (« DUPON »
 * épelé, « DUPONT » écrit) ou quand le reste précède l'épellation (pièces assemblées sur plusieurs tours), le
 * nom du modèle reste le sien. Renvoie le nom raccourci, ou null s'il n'y a rien à retirer.
 */
function dropUnspelledTail(name: string, spelled: string): string | null {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  for (let count = 1; count < words.length; count++) {
    if (stripToLetters(words.slice(0, count).join('')) === spelled) {
      return words.slice(0, count).join(' ');
    }
  }
  return null;
}

/**
 * Nom lu dans le flux JSON du modèle, comme `parseStreamedDraft` : lisible avant `say`. Null tant que le
 * brouillon n'est pas complet.
 */
export function parseStreamedCustomerName(streamed: string): string | null {
  const match = /"draft"\s*:\s*(\{[^{}]*\})/.exec(streamed);
  if (!match) return null;
  try {
    const name = (JSON.parse(match[1]) as Record<string, unknown>).customerName;
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}

/** Distance d'édition (insertion, suppression, substitution) entre deux courtes suites de lettres. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row++) {
    const current = [row];
    for (let column = 1; column <= b.length; column++) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Lettres d'une phrase faite UNIQUEMENT de lettres épelées (jetons d'une lettre, un chiffre suivi d'une
 * lettre doublant cette lettre). Vide dès qu'un mot s'en mêle : « non e t » et « et » ne sont pas épelés.
 */
function onlySpelledLetters(transcript: string): string {
  const tokens = transcript
    .toLowerCase()
    .split(/[\s,.;:!?-]+/u)
    .filter(Boolean);
  let letters = '';
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const next = tokens[index + 1];
    if (/^\p{L}$/u.test(token)) {
      letters += token;
    } else if (/^[2-9]$/.test(token) && next && /^\p{L}$/u.test(next)) {
      letters += next.repeat(Number(token));
      index++;
    } else {
      return '';
    }
  }
  return stripToLetters(letters);
}

/**
 * Après la relecture d'un nom, l'appelant ne donne que quelques lettres : celles qui manquaient, ou la fin du
 * nom qu'il reprend (« HOUT » relu, « e t » : le E avait été perdu). Où ces lettres tombent est un alignement de
 * chaînes, pas une question de sens : on cherche à partir de quelle lettre du nom relu elles le remplacent, au
 * plus petit nombre de différences ; à égalité, on garde le plus possible du nom relu. Suivre une lettre
 * tout au bout de la relecture est le cas particulier « elles s'ajoutent ». Autant de lettres que le nom
 * relu, ou plus : c'est une nouvelle épellation complète. Aucun mot connu ; la relecture de
 * confirmation qui suit protège d'un mauvais alignement. Null quand la phrase n'est pas faite que de lettres.
 */
export function respelledNameTail(previousName: string, transcript: string): string | null {
  const previous = stripToLetters(previousName);
  const spoken = onlySpelledLetters(transcript);
  if (previous.length < 2 || spoken.length < 1) return null;
  // Au moins autant de lettres que le nom relu : une épellation complète, pas la reprise d'une fin.
  if (spoken.length >= previous.length) return spoken;
  let start = previous.length;
  let distance = spoken.length;
  for (let from = previous.length - 1; from >= 0; from--) {
    const candidate = editDistance(previous.slice(from), spoken);
    if (candidate < distance) {
      start = from;
      distance = candidate;
    }
  }
  return previous.slice(0, start) + spoken;
}

/** Les lettres `letters` écrites comme le nom `like` : majuscules partout, ou initiale seule. */
function styledLike(letters: string, like: string): string {
  const original = like.trim();
  return original === original.toLocaleUpperCase('fr-FR')
    ? letters
    : letters.charAt(0) + letters.slice(1).toLocaleLowerCase('fr-FR');
}

/**
 * Fait à donner au modèle quand le nom qu'il s'apprête à relire n'est pas celui que le garde-fou de
 * l'épellation retiendrait (`reconcileSpelledName`) : lettres épelées absentes, mot non épelé collé derrière.
 * Il se tait, le brouillon est déjà corrigé, et le second passage relit le bon nom : ce que l'appelant entend est
 * ce que le brouillon contient, sans aucun exemple dans le prompt. Null quand le garde-fou ne change rien :
 * même test structurel, aucun mot connu, les mêmes limites (un nom assemblé sur plusieurs tours n'est pas touché).
 */
export function spelledNameFact(
  proposedName: string,
  transcript: string,
  previousAwaiting: StructuredTurnOutput['awaiting'],
  previousName?: string,
): string | null {
  const reconciled = reconcileSpelledName(
    { date: '', time: '', partySize: 0, customerName: proposedName },
    transcript,
    previousAwaiting,
    previousName,
  ).customerName;
  if (stripToLetters(reconciled) === stripToLetters(proposedName)) return null;
  if (previousAwaiting === 'customerNameConfirmation' && previousName?.trim()) {
    const tail = respelledNameTail(previousName, transcript);
    if (tail !== null && stripToLetters(reconciled) === tail) {
      return (
        `Les lettres que l'appelant vient de donner reprennent la fin du nom que tu viens de relire (« ${previousName.trim()} ») ; ` +
        `le nom que tu t'apprêtais à relire (« ${proposedName.trim()} ») ne les place pas bien. ` +
        `Aligné sur ta relecture, le nom est : customerName = « ${reconciled} ». ` +
        readbackInstruction(reconciled)
      );
    }
  }
  return (
    `Le nom que tu t'apprêtais à relire (« ${proposedName.trim()} ») ne correspond pas aux lettres que l'appelant vient d'épeler. ` +
    `Les lettres épelées font foi : customerName = « ${reconciled} ». ` +
    readbackInstruction(reconciled)
  );
}

/**
 * Plus de différences que cela entre le nom du modèle et les lettres épelées : ce n'est plus une lettre mal lue
 * (un chiffre pris pour une lettre, deux lettres proches) mais un autre nom, que le code ne tranche pas.
 */
const MAX_SUBSTITUTIONS = 2;

/**
 * Même nombre de lettres que l'épellation, mais pas les mêmes : le modèle a lu un chiffre ou une lettre de travers
 * (« a 2 k i f » → AAKIF). Quand l'épellation se lit sans ambiguïté, le nom que le code en tire l'emporte. Sans
 * ambiguïté veut dire : une seule suite de lettres épelées dans la phrase, aucun nom déjà retenu avant ce tour
 * (sinon c'est un nom assemblé sur plusieurs tours), et au plus MAX_SUBSTITUTIONS lettres de différence. Test
 * structurel : aucun mot connu.
 */
function resolveSubstitution(
  draft: StructuredTurnDraft,
  spelled: string,
  named: string,
  transcript: string,
  previousName?: string,
): StructuredTurnDraft {
  if (previousName?.trim() || spelledRuns(transcript).length !== 1) return draft;
  if (editDistance(named, spelled) > MAX_SUBSTITUTIONS) return draft;
  const original = draft.customerName.trim();
  const upper = original === original.toLocaleUpperCase('fr-FR');
  const customerName = upper
    ? spelled
    : spelled.charAt(0) + spelled.slice(1).toLocaleLowerCase('fr-FR');
  return { ...draft, customerName };
}

/**
 * Le nom du brouillon doit dire les lettres que l'appelant vient d'épeler. Le modèle lit
 * parfois les bonnes lettres à voix haute mais écrit un nom auquel il en manque (« hoët h o
 * u e t » → HOËT, « a 2 k i f » → AKIF) : le récapitulatif et la réservation lisent ce champ.
 * On ne corrige que ce cas précis, un nom auquel il manque une ou deux des lettres épelées.
 * Un nom plus long que l'épellation (morceaux répartis sur plusieurs tours) ou qui en est la
 * fin (faux départ suivi de la bonne épellation) reste celui du modèle. À nombre de lettres égal mais avec une
 * ou deux lettres de travers (un chiffre lu comme une lettre), une épellation sans ambiguïté l'emporte
 * (`resolveSubstitution`).
 */
export function reconcileSpelledName(
  draft: StructuredTurnDraft,
  transcript: string,
  previousAwaiting: StructuredTurnOutput['awaiting'],
  /** Nom du brouillon avant ce tour : celui que l'agent vient de relire. */
  previousName?: string,
): StructuredTurnDraft {
  if (!SPELLING_AWAITING.has(previousAwaiting)) return draft;
  if (previousAwaiting === 'customerNameConfirmation' && previousName?.trim()) {
    const tail = respelledNameTail(previousName, transcript);
    if (tail !== null) return { ...draft, customerName: styledLike(tail, previousName) };
  }
  const spelled = spelledLettersOf(transcript);
  if (spelled.length >= 3) {
    const trimmed = dropUnspelledTail(draft.customerName, spelled);
    if (trimmed !== null) return { ...draft, customerName: trimmed };
  }
  const named = stripToLetters(draft.customerName);
  if (spelled.length < 3 || named.length < 2 || named === spelled) return draft;
  const missing = spelled.length - named.length;
  if (missing === 0) return resolveSubstitution(draft, spelled, named, transcript, previousName);
  if (missing < 1 || missing > 2) return draft;
  if (spelled.endsWith(named) || !isSubsequence(named, spelled)) return draft;
  const original = draft.customerName.trim();
  const upper = original === original.toLocaleUpperCase('fr-FR');
  const customerName = upper
    ? spelled
    : spelled.charAt(0) + spelled.slice(1).toLocaleLowerCase('fr-FR');
  return { ...draft, customerName };
}

export function isBookingComplete(draft: StructuredTurnDraft): boolean {
  return Boolean(draft.date && draft.time && draft.partySize > 0 && draft.customerName.trim());
}

export function bookingKey(draft: StructuredTurnDraft): string {
  return [
    draft.date,
    draft.time,
    draft.partySize,
    draft.customerName.trim().toLocaleLowerCase('fr-FR'),
  ].join(':');
}

export function isSlotVerified(state: StructuredTurnState, draft: StructuredTurnDraft): boolean {
  return Boolean(
    state.availability &&
    state.availability.date === draft.date &&
    state.availability.partySize === draft.partySize &&
    state.availability.slots.includes(draft.time),
  );
}

/**
 * Brouillon lu dans le flux JSON du modèle : `draft` précède `say` dans le schéma, il est donc
 * lisible avant la première phrase. Null tant qu'il n'est pas complet ou s'il est illisible.
 */
export function parseStreamedDraft(
  streamed: string,
): { date: string; time: string; partySize: number } | null {
  const match = /"draft"\s*:\s*(\{[^{}]*\})/.exec(streamed);
  if (!match) return null;
  try {
    const draft = JSON.parse(match[1]) as Record<string, unknown>;
    return {
      date: typeof draft.date === 'string' ? draft.date : '',
      time: typeof draft.time === 'string' ? draft.time : '',
      partySize: typeof draft.partySize === 'number' ? draft.partySize : 0,
    };
  } catch {
    return null;
  }
}

/**
 * L'appelant vient de donner l'heure et le nombre de personnes vaut encore 0 (lu dans le flux du modèle, avant
 * `say`) : la disponibilité dépend du nombre, donc la phrase ne doit rien accepter ni répéter de l'heure ; elle se
 * réduit à sa question. Critère de forme, sans mot : brouillon avec date et heure, heure changée à ce tour, nombre à
 * 0, interprétation « answer ». Appels 03b19223 (« Samedi à 20 heures, ça marche. Vous êtes combien ? ») et c5d6b07d.
 */
export function timeGivenWithoutPartySize(streamed: string, before: { time: string }): boolean {
  const draft = parseStreamedDraft(streamed);
  if (!draft || draft.partySize !== 0 || !draft.date || !/^\d{2}:\d{2}$/.test(draft.time)) {
    return false;
  }
  if (draft.time === before.time) return false;
  return /"interpretation"\s*:\s*"answer"/.test(streamed);
}

/**
 * Appel 90834d63 : « Quatre. Ah non, cinq. » arrive « 4 » puis « un non 5 ». Le modèle attendait le nom, jugeait
 * l'énoncé douteux et redemandait le NOM : la correction du nombre de personnes était perdue, la réservation partait
 * pour 4. Le prompt seul ne l'évite pas (mesure au banc : 25 à 60 % de reprise du nombre).
 *
 * Critère de structure, aucun mot : le modèle déclare le tour douteux (`understanding`), le brouillon streamé garde la
 * taille de groupe déjà notée, on n'attendait pas ce nombre, et l'énoncé porte un nombre (chiffres) différent de cette
 * taille. Rend le fait à donner au second passage, ou null.
 */
export function partySizeCorrectionFact(
  streamed: string,
  transcript: string,
  known: { partySize: number },
): string | null {
  if (known.partySize <= 0) return null;
  if (!/"understanding"\s*:\s*"doubtful"/.test(streamed)) return null;
  const awaiting = /"awaiting"\s*:\s*"([A-Za-z]+)"/.exec(streamed)?.[1];
  if (!awaiting || awaiting === 'partySize') return null;
  const draft = parseStreamedDraft(streamed);
  if (!draft || draft.partySize !== known.partySize) return null;
  const numbers = (transcript.match(/\d+/g) ?? [])
    .map(Number)
    .filter((value) => value >= 1 && value <= 99 && value !== known.partySize);
  if (!numbers.length) return null;
  return (
    `Énoncé douteux : l'appelant a dit « ${transcript.trim()} », qui contient le nombre ${numbers[0]}, alors que ` +
    `${known.partySize} personnes sont déjà notées. Ce nombre est peut-être la correction du nombre de personnes : ` +
    `ne passe pas à la question suivante, redemande-lui le nombre de personnes (une seule question, awaiting=partySize), brouillon inchangé.`
  );
}

/** La phrase se termine par un point d'interrogation (guillemets ou parenthèse fermante tolérés). */
export function endsWithQuestion(phrase: string): boolean {
  return /\?[\s"»”')]*$/u.test(phrase);
}

/**
 * Garde-fou « seule la question est dite » (voir `timeGivenWithoutPartySize`), phrase par phrase, dans l'ordre du
 * flux. Tant qu'il est actif, une phrase qui ne se termine pas par un point d'interrogation est retenue ; quand la
 * question arrive, les phrases retenues sont retirées (`onDrop` les reçoit, pour le journal de débogage). Sans
 * question à la fin, elles sont dites telles quelles : jamais de silence.
 */
export class QuestionOnlyGuard {
  private deferred: string[] = [];
  private questionSpoken = false;
  private droppedCount = 0;

  constructor(private readonly onDrop: (phrase: string) => void = () => undefined) {}

  /** Phrases à dire maintenant pour cette phrase du flux. */
  push(phrase: string, active: boolean): string[] {
    if (!active) return [phrase];
    if (!endsWithQuestion(phrase)) {
      this.deferred.push(phrase);
      return [];
    }
    this.drop();
    this.questionSpoken = true;
    return [phrase];
  }

  /** Phrases à dire en fin de flux : celles retenues sans question derrière, sinon aucune (retirées). */
  finish(): string[] {
    if (this.questionSpoken) {
      this.drop();
      return [];
    }
    return this.deferred.splice(0);
  }

  /** Nombre de phrases retirées : l'historique garde ce qui a été dit, pas ce que le modèle avait écrit. */
  get dropped(): number {
    return this.droppedCount;
  }

  private drop(): void {
    for (const phrase of this.deferred.splice(0)) {
      this.droppedCount++;
      this.onDrop(phrase);
    }
  }
}

/**
 * Vrai quand les créneaux du jour, déjà lus pour ce nombre de personnes, ne contiennent pas
 * l'heure du brouillon : le modèle ne doit pas annoncer ce créneau comme libre (appel 1b3f85e9 :
 * « Pour 5, 15 h 30 est libre » alors que 15 h à 18 h était complet). Faux quand on ne sait pas
 * (brouillon incomplet, jour non lu, taille de groupe hors lecture) : le modèle reste libre.
 */
export function requestedSlotConflict(
  dayAvailability: DayAvailability | null,
  draft: { date: string; time: string; partySize: number },
): boolean {
  if (!dayAvailability || dayAvailability.date !== draft.date) return false;
  if (!/^\d{2}:\d{2}$/.test(draft.time) || draft.partySize < 1) return false;
  const slots = dayAvailability.slotsBySize[draft.partySize];
  return Array.isArray(slots) && !slots.includes(draft.time);
}

/**
 * L'heure du brouillon tombe hors du service du jour ouvert de sa date (« mardi à 20 heures »
 * pour un restaurant ouvert 12 h–14 h 30 ce jour-là) : le modèle, sans raisonnement, répondait
 * « ça tombe bien » 5 fois sur 6 sur ce profil. Sans nombre de personnes ni lecture de créneaux, seul
 * le code peut le savoir à ce stade. Renvoie le fait à donner au modèle, ou null quand tout est
 * compatible ou inconnu (horaires absents, jour fermé traité par le calendrier, service de nuit).
 */
export function outsideOpeningHoursFact(
  openingHours: unknown,
  draft: { date: string; time: string },
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time)) return null;
  const days = normalizeOpeningHours(openingHours);
  if (!days.length) return null;
  const [year, month, day] = draft.date.split('-').map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day));
  const periods = days.filter((entry) => entry.dayIndex === utc.getUTCDay());
  if (!periods.length || periods.some((period) => period.close <= period.open)) return null;
  const weekday = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(
    utc,
  );
  const service = periods.find((period) => draft.time >= period.open && draft.time <= period.close);
  if (service) {
    // Dans le service, mais après la dernière réservation que le restaurateur a fixée.
    const lastBooking = service.lastBooking;
    if (!lastBooking || draft.time <= lastBooking) return null;
    return (
      `L'heure demandée (${draft.time}) est après la dernière réservation du ${weekday} ` +
      `pour ce service (${lastBooking}, service ${service.open}–${service.close}). ` +
      "Ne l'accepte pas et ne demande pas encore le nombre de personnes : dis-le simplement à l'appelant " +
      `et laisse-le choisir une heure jusqu'à ${lastBooking}.`
    );
  }
  const ranges = periods.map((period) => `${period.open}–${period.close}`).join(' puis ');
  return (
    `L'heure demandée (${draft.time}) est en dehors des horaires du ${weekday} (${ranges}). ` +
    "Ne l'accepte pas et ne demande pas encore le nombre de personnes : dis-le simplement à l'appelant " +
    'et laisse-le choisir une heure dans ces horaires.'
  );
}

export type ActionDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Autorise une action à effet réel. La création exige un récapitulatif complet
 * lu au tour précédent, accepté par l'appelant selon le modèle, sur un créneau
 * vérifié. Aucune action à effet ne part sur un plan peu sûr.
 */
/**
 * Au-delà de ce nombre de mots, ce que le modèle n'a pas compris n'est pas un au revoir. Un au revoir mal
 * transcrit est court (« dix nous » pour « bisous ») ; une longue phrase sans sens peut être une vraie demande.
 * Critère de longueur seulement, aucun mot connu. RÉSERVE : le seuil repose sur UN seul appel réel (6a70dff9,
 * deux mots) et sur des phrases inventées ; il n'a pas été étalonné sur des au revoir transcrits de travers.
 */
export const FAREWELL_MAX_WORDS = 6;

/** Nombre de mots d'une phrase transcrite. */
export function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}

/** La reprise courte ne vaut que pour un récapitulatif complet déjà entendu. */
export function canResumeConfirmation(state: StructuredTurnState, recapHeard = true): boolean {
  if (state.reservationCreated || !isBookingComplete(state.draft)) return false;
  const key = bookingKey(state.draft);
  if (state.lastAwaiting === 'confirmation') return recapHeard && state.recapKey === key;
  return (
    state.resumableRecapKey === key && (state.lastAwaiting !== 'confirmationResume' || recapHeard)
  );
}

/** Conserver les faits lus ne signifie pas conserver un consentement à réserver. */
export function updateConfirmationState(
  state: StructuredTurnState,
  output: StructuredTurnOutput,
  recapHeard: boolean,
): void {
  const key = isBookingComplete(state.draft) ? bookingKey(state.draft) : null;
  let resumable = canResumeConfirmation(state, recapHeard) ? key : null;
  const decliningBooking =
    output.interpretation === 'decline' &&
    (state.lastAwaiting === 'confirmation' || state.lastAwaiting === 'confirmationResume');
  if (
    state.reservationCreated ||
    decliningBooking ||
    output.interpretation === 'new_request' ||
    output.action === 'end_call' ||
    output.action === 'transfer'
  )
    resumable = null;
  state.resumableRecapKey = output.awaiting === 'confirmation' ? null : resumable;
  state.lastAwaiting = output.awaiting;
  state.recapKey = output.awaiting === 'confirmation' ? key : null;
}

export function authorizeStructuredAction(
  state: StructuredTurnState,
  output: StructuredTurnOutput,
  draft: StructuredTurnDraft,
  context: {
    maxPartySize: number;
    recapHeard?: boolean;
    transcriptWords?: number;
    replyScope?: ReplyScope;
  },
): ActionDecision {
  if (
    context.replyScope &&
    (output.action !== 'none' ||
      output.awaiting === 'none' ||
      bookingKey(output.draft) !== bookingKey(state.draft))
  ) {
    return { allowed: false, reason: 'reply_scope_required' };
  }
  // Une fois la réservation créée, rien n'est en jeu : un énoncé COURT que le modèle ne comprend pas est un au
  // revoir mal transcrit (appel 6a70dff9 : « Bisous » transcrit « dix-nous »). Un long reste un doute.
  // Et seulement si la phrase précédente de l'agent n'attendait rien : après une question (« Autre chose ? »),
  // un court énoncé mal compris est peut-être une vraie question, pas un au revoir.
  const shortFarewell =
    output.action === 'end_call' &&
    state.reservationCreated &&
    state.lastAwaiting === 'none' &&
    context.transcriptWords !== undefined &&
    context.transcriptWords <= FAREWELL_MAX_WORDS;
  // Compréhension douteuse : aucune action, pas même une vérification de disponibilité sur une valeur devinée.
  if (output.understanding === 'doubtful' && output.action !== 'none' && !shortFarewell) {
    return { allowed: false, reason: 'doubtful_understanding' };
  }
  // Sans vérification de compréhension : un congé que le modèle dit lui-même ne pas avoir compris ne ferme
  // l'appel que s'il est court.
  if (
    output.action === 'end_call' &&
    output.interpretation === 'unclear' &&
    (context.transcriptWords ?? Number.POSITIVE_INFINITY) > FAREWELL_MAX_WORDS
  ) {
    return { allowed: false, reason: 'long_unclear_farewell' };
  }
  const sideEffect = output.action !== 'none' && output.action !== 'check_availability';
  // Un mot mal transcrit donne une confiance faible : le congé court (conditions ci-dessus) passe aussi ce garde.
  if (sideEffect && output.confidence === 'low' && !shortFarewell) {
    return { allowed: false, reason: 'low_confidence' };
  }
  switch (output.action) {
    case 'none':
    case 'take_message':
    case 'transfer':
    case 'end_call':
      return { allowed: true };
    case 'check_availability':
      return draft.date && draft.partySize > 0
        ? { allowed: true }
        : { allowed: false, reason: 'missing_date_or_party_size' };
    case 'create_reservation': {
      if (state.reservationCreated) return { allowed: false, reason: 'already_created' };
      if (!isBookingComplete(draft)) return { allowed: false, reason: 'incomplete_booking' };
      if (draft.partySize > context.maxPartySize) {
        return { allowed: false, reason: 'group_above_threshold' };
      }
      if (!isSlotVerified(state, draft)) return { allowed: false, reason: 'slot_not_verified' };
      const recapAccepted =
        (state.lastAwaiting === 'confirmation' && state.recapKey === bookingKey(draft)) ||
        (state.lastAwaiting === 'confirmationResume' &&
          state.resumableRecapKey === bookingKey(draft));
      if (!recapAccepted) {
        return { allowed: false, reason: 'recap_not_read' };
      }
      if (output.interpretation !== 'affirmation') {
        return { allowed: false, reason: 'recap_not_accepted' };
      }
      // Coupé avant la fin de son contenu : le « oui » ne porte que sur ce qui a été entendu.
      if (context.recapHeard === false) return { allowed: false, reason: 'recap_not_heard' };
      return { allowed: true };
    }
  }
}
