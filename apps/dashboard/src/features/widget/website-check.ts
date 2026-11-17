import type { useApi } from '@/lib/api';
import { buildWidgetSnippet, WIDGET_HOST } from '@/lib/widget-snippet';

// Contrat de l'API d'analyse (apps/api, PR séparée) : POST dashboard/website-check et
// GET dashboard/website-check/heartbeats.

export type WebsitePlatform =
  | 'wordpress'
  | 'wix'
  | 'squarespace'
  | 'webflow'
  | 'shopify'
  | 'unknown';
export type BookingTarget = 'suppernote' | 'zenchef' | 'thefork' | 'other';
export type BookingLink = { href: string; text: string; target: BookingTarget };
export type Heartbeat = {
  origin: string;
  at: string;
  version: string;
  mode: string;
  buttons: number;
};
export type FetchError =
  | 'timeout'
  | 'blocked'
  | 'not_html'
  | 'too_large'
  | 'http_error'
  | 'invalid_url';
export type WebsiteCheckResult = {
  url: string;
  platform: WebsitePlatform;
  providers: string[];
  bookingLinks: BookingLink[];
  scriptFound: boolean;
  slugMatches: boolean | null;
  framingBlocked: boolean | null;
  heartbeats: Heartbeat[];
  fetchError: FetchError | null;
};
export type InstallChoice = 'buttons' | 'form';
export type FallbackAnswer = 'yes' | 'no' | null;

type Api = Pick<ReturnType<typeof useApi>, 'get' | 'post'>;

export const STALE_AFTER_DAYS = 7;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const PROD_WIDGET_HOST = 'https://suppernote.com';

export const PLATFORM_LABELS: Record<WebsitePlatform, string> = {
  wordpress: 'WordPress',
  wix: 'Wix',
  squarespace: 'Squarespace',
  webflow: 'Webflow',
  shopify: 'Shopify',
  unknown: 'inconnu',
};

export const FETCH_ERROR_MESSAGES: Record<FetchError, string> = {
  timeout: 'Votre site met trop de temps à répondre.',
  blocked: 'Votre site refuse la lecture automatique de sa page.',
  not_html: 'Cette adresse ne mène pas à une page web classique.',
  too_large: 'La page de votre site est trop lourde pour être lue.',
  http_error: 'Votre site répond par une erreur. Vérifiez l’adresse.',
  invalid_url: 'Cette adresse n’est pas valide, par exemple https://www.votre-restaurant.fr.',
};

const BOOKING_TARGET_LABELS: Record<BookingTarget, string> = {
  suppernote: 'Suppernote',
  zenchef: 'Zenchef',
  thefork: 'TheFork',
  other: 'un autre service',
};

const COMPETITOR_LABELS: Record<string, string> = { zenchef: 'Zenchef', thefork: 'TheFork' };

const OTHER_GUIDE = [
  'Collez le code juste avant la balise </body> de vos pages.',
  'Ou transmettez ce message à la personne qui gère votre site.',
];

const PLATFORM_STEPS: Record<WebsitePlatform, string[]> = {
  wordpress: [
    'Ouvrez la page où afficher le bouton.',
    'Ajoutez un bloc « HTML personnalisé » et collez le code (ou placez-le dans l’en-tête du site).',
    'Enregistrez puis publiez la page.',
  ],
  wix: [
    'Ouvrez Paramètres > Code personnalisé.',
    'Ajoutez le code et choisissez les pages concernées.',
    'Publiez votre site.',
  ],
  squarespace: [
    'Ouvrez Paramètres > Injection de code.',
    'Collez le code dans l’en-tête ou le pied de page.',
    'Enregistrez puis publiez le site.',
  ],
  webflow: [
    'Ouvrez les paramètres du site > Custom code.',
    'Collez le code dans la zone « Head code » ou « Footer code ».',
    'Publiez le site.',
  ],
  shopify: OTHER_GUIDE,
  unknown: OTHER_GUIDE,
};

export function platformSteps(platform: WebsitePlatform): string[] {
  return PLATFORM_STEPS[platform];
}

export function buildBookingUrl(slug: string): string {
  return `${WIDGET_HOST}/restaurant/${encodeURIComponent(slug)}`;
}

/** Ligne à ajouter une seule fois sur le site pour que les boutons « Réserver » ouvrent la fenêtre. */
export function buildEmbedScriptLine(slug: string): string {
  const hostAttr = WIDGET_HOST === PROD_WIDGET_HOST ? '' : ` data-host="${WIDGET_HOST}"`;
  // data-mode="modal" : sans cet attribut, embed.js reste en mode formulaire intégré.
  return `<script src="${WIDGET_HOST}/embed.js" data-slug="${slug}"${hostAttr} data-mode="modal" defer></script>`;
}

/** Sans réponse de secours, on suit l'analyse : des boutons trouvés → on les garde. */
export function pickDefaultChoice(
  analysis: WebsiteCheckResult | null,
  answer: FallbackAnswer,
): InstallChoice {
  if (answer) return answer === 'yes' ? 'buttons' : 'form';
  if (analysis && !analysis.fetchError && analysis.bookingLinks.length > 0) return 'buttons';
  return 'form';
}

export function needsFallback(analysis: WebsiteCheckResult | null): boolean {
  return analysis !== null && (analysis.fetchError !== null || analysis.platform === 'unknown');
}

export function findCompetitors(analysis: WebsiteCheckResult): string[] {
  const keys = [
    ...analysis.bookingLinks.map((link) => link.target),
    ...analysis.providers.map((provider) => provider.toLowerCase()),
  ];
  const labels = keys.flatMap((key) => (COMPETITOR_LABELS[key] ? [COMPETITOR_LABELS[key]] : []));
  return [...new Set(labels)];
}

export function bookingTargetLabel(target: BookingTarget): string {
  return BOOKING_TARGET_LABELS[target];
}

export type InstallStatus = { tone: 'empty' | 'ok' | 'stale'; message: string };

function latestHeartbeat(heartbeats: Heartbeat[]): Heartbeat | null {
  let latest: Heartbeat | null = null;
  for (const heartbeat of heartbeats) {
    const time = new Date(heartbeat.at).getTime();
    if (!Number.isFinite(time)) continue;
    if (!latest || time > new Date(latest.at).getTime()) latest = heartbeat;
  }
  return latest;
}

function relativeAge(ageMs: number): string {
  if (ageMs < HOUR_MS) return 'il y a moins d’une heure';
  if (ageMs < DAY_MS) return `il y a ${Math.floor(ageMs / HOUR_MS)} h`;
  return `il y a ${Math.floor(ageMs / DAY_MS)} j`;
}

export function describeInstallStatus(heartbeats: Heartbeat[], now: Date): InstallStatus {
  const latest = latestHeartbeat(heartbeats);
  if (!latest) return { tone: 'empty', message: 'Pas encore détecté' };

  const ageMs = now.getTime() - new Date(latest.at).getTime();
  if (ageMs > STALE_AFTER_DAYS * DAY_MS) {
    const days = Math.floor(ageMs / DAY_MS);
    return {
      tone: 'stale',
      message: `Plus vu depuis ${days} jours, votre site a peut-être changé.`,
    };
  }
  const buttons =
    latest.buttons === 0
      ? 'aucun bouton connecté'
      : `${latest.buttons} bouton${latest.buttons > 1 ? 's' : ''} connecté${latest.buttons > 1 ? 's' : ''}`;
  return {
    tone: 'ok',
    message: `Installé sur ${latest.origin}, vu ${relativeAge(Math.max(ageMs, 0))}, ${buttons}.`,
  };
}

/** mailto sans destinataire : le restaurateur envoie lui-même le message à son webmaster. */
export function buildWebmasterMailto(
  slug: string,
  choice: InstallChoice,
  platform: WebsitePlatform,
): string {
  const code =
    choice === 'buttons'
      ? [
          `Lien de réservation : ${buildBookingUrl(slug)}`,
          `Ligne à ajouter une seule fois : ${buildEmbedScriptLine(slug)}`,
        ]
      : [`Code à coller dans le HTML de la page : ${buildWidgetSnippet(slug)}`];
  const steps = platformSteps(platform).map((step, index) => `${index + 1}. ${step}`);
  const body = [
    'Bonjour,',
    '',
    'Pourriez-vous ajouter la réservation en ligne sur notre site ?',
    '',
    ...code,
    '',
    'Étapes :',
    ...steps,
    '',
    'Merci d’avance.',
  ].join('\n');
  const subject = 'Ajouter la réservation en ligne à notre site';
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

export async function analyseWebsite(api: Api, url: string): Promise<WebsiteCheckResult> {
  return api.post<WebsiteCheckResult>('dashboard/website-check', { url });
}

export async function fetchHeartbeats(api: Api): Promise<Heartbeat[]> {
  const response = await api.get<{ heartbeats: Heartbeat[] }>('dashboard/website-check/heartbeats');
  return response?.heartbeats ?? [];
}
