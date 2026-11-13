/**
 * Erreurs de l'API vues par le restaurateur.
 *
 * L'API répond de trois façons : un message français rédigé pour l'utilisateur (« La modification des
 * notes client est réservée aux responsables. »), un code stable (`CAPABILITY_NOT_INCLUDED`,
 * `DISTRIBUTION_DISABLED`…), ou un texte technique anglais (« Authentication required », « Validation Error »).
 * Seul le premier cas est lisible tel quel : les deux autres sont traduits ici, une fois pour toutes les
 * pages, au lieu d'afficher « Erreur 409 » ou du jargon.
 */

export type ApiErrorKind =
  | 'session'
  | 'forbidden'
  /** La fonction n'est pas dans la formule du restaurant. */
  | 'not-included'
  /** La fonction existe mais n'est pas encore ouverte (réglage serveur, qualification en cours). */
  | 'not-ready'
  | 'not-found'
  | 'conflict'
  | 'invalid'
  | 'rate-limited'
  | 'unavailable'
  | 'other';

export interface ApiErrorPayload {
  status: number;
  code: string | null;
  message: string | null;
  details: Array<{ path?: string; message?: string }>;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly kind: ApiErrorKind;

  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.kind = classifyApiError(status, code);
  }
}

const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;

/** Code stable de l'API : le champ `code`, ou le champ `error` quand il a la forme d'un code. */
export function extractApiCode(data: Record<string, unknown>): string | null {
  for (const key of ['code', 'error']) {
    const value = data[key];
    if (typeof value === 'string' && CODE_PATTERN.test(value)) return value;
  }
  return null;
}

export function classifyApiError(status: number, code: string | null): ApiErrorKind {
  // Le jeton de vérification d'identité (export RGPD) n'est pas la session : ne pas renvoyer vers la connexion.
  if (code === 'IDENTITY_REQUIRED') return 'other';
  if (status === 401) return 'session';
  if (code === 'CAPABILITY_NOT_INCLUDED') return 'not-included';
  if (code && (code.endsWith('_DISABLED') || code.endsWith('_NOT_CONFIGURED'))) return 'not-ready';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'unavailable';
  return 'other';
}

/** Messages propres à un code, quand le texte de l'API parle de « pilote », de « chantier » ou de réglages. */
const CODE_MESSAGES: Record<string, string> = {
  IDENTITY_REQUIRED: 'La vérification d’identité a expiré. Demandez un nouveau code.',
  MARKETING_SENDS_DISABLED: 'L’envoi de messages n’est pas encore ouvert sur votre compte.',
  RESERVATION_PAYMENTS_DISABLED:
    'Le paiement des réservations n’est pas encore ouvert sur votre compte.',
  REACTIVATION_AUTOMATION_ACTIVE:
    'La relance automatique des clients dormants est déjà active dans Marketing : ces clients y sont déjà pris en charge.',
  REACTIVATION_AUDIENCE_EMPTY: 'Aucun de ces clients n’a accepté de recevoir des SMS.',
  REACTIVATION_AUDIENCE_TOO_LARGE:
    'Cette liste est trop longue pour un envoi direct : passez par Marketing.',
  MARKETING_QUEUE_ENQUEUE_UNKNOWN:
    'L’envoi n’a pas pu être programmé. Réessayez dans quelques minutes.',
  AUDIENCE_TOO_LARGE:
    'Cette audience dépasse la taille maximale d’une campagne. Choisissez un segment plus restreint.',
  SEGMENT_NOT_FOUND: 'Ce segment n’existe plus. Choisissez-en un autre.',
  CAMPAIGN_NOT_FOUND: 'Cette campagne n’existe plus. Actualisez la page.',
  // Vérification d'identité (export RGPD d'un client)
  EXPIRED: 'Le code a expiré. Demandez-en un nouveau.',
  INVALID_CODE: 'Le code saisi est incorrect.',
  MAX_ATTEMPTS: 'Trop d’essais. Demandez un nouveau code.',
  RATE_LIMITED: 'Trop de demandes de code. Réessayez dans un instant.',
  INVALID_CAPTCHA: 'La vérification anti-robot a échoué. Réessayez.',
  SUBJECT_MISMATCH: 'Le code ne correspond pas à ce client.',
  SUBJECT_NOT_FOUND: 'Aucune donnée trouvée pour ce client.',
  // Fiche client et fusion de doublons
  CUSTOMER_NOT_FOUND: 'Ce client n’existe plus ou a été fusionné avec un autre profil.',
  CRM_TENANT_MISMATCH: 'Ce profil est introuvable. Actualisez la liste.',
  CUSTOMER_NOT_ACTIVE: 'Ce profil a déjà été fusionné ou archivé. Actualisez la liste.',
  TAG_ASSIGNMENT_NOT_FOUND: 'Ce tag a déjà été retiré de la fiche.',
  PREFERENCE_NOT_FOUND: 'Cette préférence a déjà été supprimée.',
  MERGE_IDENTITY_CONFLICT:
    'Ces profils partagent une coordonnée incompatible. La fusion n’est pas possible automatiquement.',
  MERGE_PREFERENCE_RESOLUTION_REQUIRED:
    'Les préférences ont changé. Relancez l’aperçu et choisissez une résolution pour chaque conflit.',
  MERGE_IDEMPOTENCY_KEY_REUSED: 'La fusion n’a pas pu aboutir. Réessayez dans un instant.',
  MERGE_SERIALIZATION_RETRY_EXHAUSTED: 'La fusion n’a pas pu aboutir. Réessayez dans un instant.',
  // Suivi des coûts (opérateur)
  USAGE_ADJUSTMENT_CONFLICT: 'Une correction identique existe déjà.',
  USAGE_ADJUSTMENT_STATE_CONFLICT:
    'Un autre opérateur a déjà tranché cette correction. Actualisez la page.',
  // Attentions clients
  LOYALTY_CUSTOMER_NOT_ELIGIBLE: 'Ce client ne remplit pas la condition de cette attention.',
  LOYALTY_GRANT_LIMIT_REACHED:
    'Ce client a déjà reçu cette attention autant de fois que le permet sa configuration.',
  LOYALTY_BENEFIT_KEY_CONFLICT: 'Une attention porte déjà ce nom. Choisissez un autre nom.',
  LOYALTY_GRANT_EXPIRED: 'Cette attribution a expiré.',
  LOYALTY_GRANT_ALREADY_REDEEMED: 'Cette attention a déjà été utilisée.',
  LOYALTY_GRANT_CODE_INVALID: 'Le code saisi ne correspond pas à cette attention.',
  LOYALTY_GRANT_VOID: 'Cette attribution a été annulée.',
  LOYALTY_GRANT_REDEMPTION_CONFLICT: 'Cette attention vient d’être utilisée. Actualisez la page.',
  LOYALTY_RESERVATION_INVALID: 'Cette réservation ne correspond pas à ce client.',
  LOYALTY_ROLE_REQUIRED: 'Cette action est réservée aux responsables.',
  // Réputation
  REPUTATION_ROLE_REQUIRED: 'Cette action est réservée aux responsables.',
  REPUTATION_RECOVERY_TRANSITION_INVALID: 'Cette demande a déjà été traitée. Actualisez la liste.',
  REPUTATION_RECOVERY_TASK_NOT_FOUND: 'Cette demande n’existe plus. Actualisez la liste.',
  // Événements
  EVENT_CAPACITY_EXCEEDED: 'Il n’y a plus assez de places pour cette date.',
  EVENT_KEY_CONFLICT: 'Un événement porte déjà ce nom. Choisissez un autre nom.',
  EVENT_SESSION_CONFLICT: 'Une date existe déjà à cet horaire pour cet événement.',
  EVENT_SESSION_IN_PAST: 'Cette date est déjà passée.',
  EVENT_SESSION_CLOSED: 'Cette date n’est plus ouverte à la réservation.',
  EVENT_NOT_ACTIVE: 'Cet événement n’est pas encore actif.',
  EVENT_TICKET_CHECKED_IN: 'Ce billet a déjà été contrôlé.',
  EVENT_TICKET_NOT_FOUND: 'Billet introuvable. Vérifiez le code.',
  EVENT_TICKET_CODE_INVALID: 'Billet introuvable. Vérifiez le code.',
  EVENT_TICKET_UNAVAILABLE: 'Ce billet n’est plus valable.',
  EVENT_TICKET_TYPE_INACTIVE: 'Ce tarif n’est plus proposé.',
  EVENT_ORDER_CANCELLED: 'Cette commande a été annulée.',
  EVENT_ORDER_REFUNDED: 'Cette commande est déjà remboursée.',
  EVENT_WAITLIST_CLOSED: 'La liste d’attente de cette date est fermée.',
  EVENT_WAITLIST_ALREADY_PROMOTED: 'Cette demande a déjà reçu sa place.',
  // Expériences
  EXPERIENCE_CAPACITY_EXCEEDED: 'Il n’y a plus assez de places pour cette date.',
  EXPERIENCE_KEY_CONFLICT: 'Une expérience porte déjà ce nom. Choisissez un autre nom.',
  EXPERIENCE_SESSION_CONFLICT: 'Une date existe déjà à cet horaire pour cette expérience.',
  EXPERIENCE_SESSION_IN_PAST: 'Cette date est déjà passée.',
  EXPERIENCE_SESSION_CLOSED: 'Cette date n’est plus ouverte à la réservation.',
  EXPERIENCE_NOT_ACTIVE: 'Cette expérience n’est pas active.',
  EXPERIENCE_RESERVATION_CANCELLED: 'Cette réservation est déjà annulée.',
  EXPERIENCE_REFUND_FAILED:
    'Le remboursement a échoué. Réessayez, ou remboursez depuis votre compte Stripe.',
  EXPERIENCE_PAYMENT_NOT_CONFIGURED:
    'Le paiement n’est pas encore configuré. Connectez Stripe dans les réglages des cartes cadeaux.',
  EXPERIENCE_STRIPE_NOT_READY:
    'Le paiement n’est pas encore configuré. Connectez Stripe dans les réglages des cartes cadeaux.',
  EXPERIENCE_DELETE_CONFLICT:
    'Cette expérience ne peut pas être supprimée : elle a déjà des réservations. Archivez-la.',
  EXPERIENCE_DELETE_NOT_ALLOWED:
    'Cette expérience ne peut pas être supprimée : elle a déjà des réservations. Archivez-la.',
};

const KIND_MESSAGES: Record<ApiErrorKind, string> = {
  session: 'Votre session a expiré. Reconnectez-vous pour continuer.',
  forbidden: 'Vous n’avez pas accès à cette fonction avec votre rôle.',
  'not-included': 'Cette fonctionnalité n’est pas incluse dans votre formule.',
  'not-ready': 'Cette fonctionnalité n’est pas encore ouverte sur votre compte.',
  'not-found': 'Élément introuvable. Il a peut-être été supprimé : actualisez la page.',
  conflict:
    'Cette action n’est plus possible : l’élément a changé entre-temps. Actualisez la page.',
  invalid: 'Certains champs ne sont pas valides. Vérifiez votre saisie.',
  'rate-limited': 'Trop de requêtes en peu de temps. Réessayez dans un instant.',
  unavailable: 'Le service est momentanément indisponible. Réessayez dans quelques instants.',
  other: 'Une erreur est survenue. Réessayez.',
};

/** Noms de champs de l'API, en français, pour dire quoi corriger après une validation refusée. */
const FIELD_LABELS: Record<string, string> = {
  phone: 'numéro de téléphone',
  managerPhone: 'numéro de téléphone',
  customerPhone: 'numéro de téléphone',
  email: 'adresse e-mail',
  managerEmail: 'adresse e-mail',
  customerEmail: 'adresse e-mail',
  name: 'nom',
  customerName: 'nom',
  partySize: 'nombre de couverts',
  date: 'date',
  time: 'heure',
  slug: 'adresse publique',
  domain: 'nom de domaine',
  subject: 'objet',
  body: 'message',
};

/** Texte technique ou générique : à remplacer, jamais à montrer. */
const TECHNICAL_MESSAGE =
  /^(rate limit exceeded|too many requests|authentication required|organization required|forbidden|unauthorized|not found|bad request|validation error|internal server error|service unavailable|authentication provider not configured|erreur \d+|error|internalservererror|badrequesterror)\b/i;

/** Phrase anglaise de l'API (« Restaurant not found », « Slug is required ») : jamais lisible par le restaurateur. */
const ENGLISH_MESSAGE =
  /\b(not found|is required|are required|required|invalid|failed|failure|must be|cannot|unable to|denied|missing|already exists|not allowed|not configured|is not|are not|please)\b/i;

function isTechnicalMessage(message: string | null): boolean {
  if (!message) return true;
  const text = message.trim();
  return (
    !text || TECHNICAL_MESSAGE.test(text) || ENGLISH_MESSAGE.test(text) || CODE_PATTERN.test(text)
  );
}

function invalidFieldsHint(details: ApiErrorPayload['details']): string {
  const labels = new Set<string>();
  for (const detail of details) {
    const field = detail.path?.split('.').pop();
    const label = field ? FIELD_LABELS[field] : undefined;
    if (label) labels.add(label);
  }
  return labels.size > 0 ? ` À vérifier : ${[...labels].join(', ')}.` : '';
}

/** Message à montrer au restaurateur pour une réponse d'erreur de l'API. */
export function describeApiError(payload: ApiErrorPayload): string {
  const kind = classifyApiError(payload.status, payload.code);
  if (kind === 'session' || kind === 'not-included') return KIND_MESSAGES[kind];
  if (payload.code && CODE_MESSAGES[payload.code]) return CODE_MESSAGES[payload.code];
  const rateLimitDelay =
    kind === 'rate-limited' &&
    payload.message?.match(/^Rate limit exceeded, retry in (\d+) seconds?$/i);
  if (rateLimitDelay) {
    const seconds = rateLimitDelay[1];
    return `Trop de requêtes. Réessayez dans ${seconds} seconde${seconds === '1' ? '' : 's'}.`;
  }
  if (kind === 'not-ready') return KIND_MESSAGES['not-ready'];
  if (kind === 'invalid' && isTechnicalMessage(payload.message)) {
    return `${KIND_MESSAGES.invalid}${invalidFieldsHint(payload.details)}`;
  }
  if (!isTechnicalMessage(payload.message)) return payload.message!.trim();
  return KIND_MESSAGES[kind];
}

/** Construit l'erreur levée par le client API depuis la réponse JSON. */
export function toApiError(status: number, data: Record<string, unknown>): ApiError {
  const code = extractApiCode(data);
  const message =
    [data.message, data.error, data.detail].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    ) ?? null;
  const details = Array.isArray(data.details)
    ? (data.details as ApiErrorPayload['details']).filter(
        (item) => item && typeof item === 'object',
      )
    : [];
  return new ApiError(describeApiError({ status, code, message, details }), status, code);
}

export interface FeatureLock {
  kind: 'not-included' | 'not-ready';
  message: string;
}

/**
 * Vrai blocage de fonctionnalité (formule ou ouverture), à présenter calmement : ce n'est ni une panne ni
 * une erreur à réessayer. `null` pour toute autre erreur.
 */
export function featureLockFromError(error: unknown): FeatureLock | null {
  if (error instanceof ApiError && (error.kind === 'not-included' || error.kind === 'not-ready')) {
    return { kind: error.kind, message: error.message };
  }
  return null;
}

export function isSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.kind === 'session';
}
