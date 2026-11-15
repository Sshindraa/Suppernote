/**
 * Marketing consent wording, shared by the API (which hashes it as proof) and by every screen that
 * shows the checkbox, so the text a customer reads is the text that is kept as evidence.
 *
 * DRAFT wording, to be validated by the restaurant owner and legal counsel before real customers
 * see it (docs/runbooks/marketing-email-pilot.md, section "Texte de consentement"). Any change of
 * wording must come with a new version: an older proof must keep matching the text it was given for.
 */
export const MARKETING_CONSENT_VERSION = 'marketing-consent-2026-10-28';

export const MARKETING_CONSENT_CHANNELS = ['EMAIL', 'SMS'] as const;
export type MarketingConsentChannel = (typeof MARKETING_CONSENT_CHANNELS)[number];

const CHANNEL_WORDING: Record<MarketingConsentChannel, string> = {
  EMAIL: 'par e-mail',
  SMS: 'par SMS',
};

/** « du restaurant {nom} » ; « de ce restaurant » sans nom. Évite « de Le Bistrot ». */
function restaurantLabel(restaurantName: string): string {
  const name = restaurantName.trim();
  return name ? `du restaurant ${name}` : 'de ce restaurant';
}

/** The label shown next to an unchecked box. Never pre-checked, never required to book. */
export function buildMarketingConsentLabel(
  channel: MarketingConsentChannel,
  restaurantName: string,
): string {
  return `Recevoir les offres et actualités ${restaurantLabel(restaurantName)} ${CHANNEL_WORDING[channel]}`;
}

/**
 * The string that is hashed and stored as proof: version, channel and the exact sentence. The
 * server rebuilds it itself, a client-supplied text is never trusted.
 */
export function buildMarketingConsentProof(
  channel: MarketingConsentChannel,
  restaurantName: string,
): string {
  return `${MARKETING_CONSENT_VERSION}|${channel}|${buildMarketingConsentLabel(channel, restaurantName)}`;
}

/**
 * One box for every channel the form can reach (book page). Its sentence names those channels, so it
 * has its own version: the proof of each channel keeps the exact sentence the customer ticked.
 */
export const MARKETING_CONSENT_COMBINED_VERSION = 'marketing-consent-combined-2026-11-15';

export function buildCombinedMarketingConsentLabel(
  channels: readonly MarketingConsentChannel[],
  restaurantName: string,
): string {
  const ordered = MARKETING_CONSENT_CHANNELS.filter((channel) => channels.includes(channel));
  const wording = ordered.map((channel) => CHANNEL_WORDING[channel]).join(' et ');
  return `Recevoir les offres et actualités ${restaurantLabel(restaurantName)} ${wording}`;
}

export function buildCombinedMarketingConsentProof(
  channel: MarketingConsentChannel,
  channels: readonly MarketingConsentChannel[],
  restaurantName: string,
): string {
  return `${MARKETING_CONSENT_COMBINED_VERSION}|${channel}|${buildCombinedMarketingConsentLabel(channels, restaurantName)}`;
}

/** How a consent collected outside a form was obtained, chosen by the restaurant team. */
export const MARKETING_CONSENT_COLLECTION_METHODS = ['IN_PERSON', 'PHONE', 'PAPER'] as const;
export type MarketingConsentCollectionMethod =
  (typeof MARKETING_CONSENT_COLLECTION_METHODS)[number];

export const MARKETING_CONSENT_COLLECTION_LABELS: Record<MarketingConsentCollectionMethod, string> =
  {
    IN_PERSON: 'À l’oral, sur place',
    PHONE: 'Par téléphone',
    PAPER: 'Sur papier signé',
  };

/** Stored `source` values, with the label a restaurant team reads in the customer record. */
export const MARKETING_CONSENT_SOURCE_LABELS: Record<string, string> = {
  CONNECT: 'Page de réservation Suppernote Connect',
  BOOK_PAGE: 'Page de réservation du restaurant',
  WIDGET: 'Widget de réservation',
  CONFIRMATION_EMAIL: 'Lien de la confirmation de réservation',
  DASHBOARD_IN_PERSON: 'Saisi par le restaurant (à l’oral, sur place)',
  DASHBOARD_PHONE: 'Saisi par le restaurant (par téléphone)',
  DASHBOARD_PAPER: 'Saisi par le restaurant (sur papier signé)',
  DASHBOARD_WITHDRAWAL: 'Retiré par le restaurant',
  UNSUBSCRIBE_LINK: 'Lien de désinscription',
  UNSUBSCRIBE: 'Retrait enregistré',
};

export function describeMarketingConsentSource(source: string): string {
  return MARKETING_CONSENT_SOURCE_LABELS[source] ?? source;
}
