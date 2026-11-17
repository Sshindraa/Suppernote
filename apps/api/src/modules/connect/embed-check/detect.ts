/**
 * Détection pure sur le HTML d'un site client : plateforme, concurrents de réservation, liens de
 * réservation, script Suppernote, CSP. Regex volontairement simples (pas de parseur DOM) : c'est un
 * indice pour le tableau de bord, pas une preuve.
 */
import type { IncomingHttpHeaders } from 'node:http';

export type SitePlatform = 'wordpress' | 'wix' | 'squarespace' | 'webflow' | 'shopify' | 'unknown';
export type ReservationProvider =
  | 'zenchef'
  | 'thefork'
  | 'sevenrooms'
  | 'resy'
  | 'opentable'
  | 'guestonline';
export type BookingTarget = 'suppernote' | 'zenchef' | 'thefork' | 'other';

export interface BookingLink {
  href: string;
  text: string;
  target: BookingTarget;
}

const GENERATOR_PATTERNS: Array<[SitePlatform, RegExp]> = [
  ['wordpress', /wordpress/i],
  ['wix', /\bwix\b/i],
  ['squarespace', /squarespace/i],
  ['webflow', /webflow/i],
  ['shopify', /shopify/i],
];

const SIGNATURE_PATTERNS: Array<[SitePlatform, RegExp]> = [
  ['wix', /static\.wixstatic\.com|parastorage\.com/i],
  ['squarespace', /static1\.squarespace\.com|squarespace-cdn/i],
  ['webflow', /assets\.website-files\.com|data-wf-(site|page)=/i],
  ['shopify', /cdn\.shopify\.com|Shopify\.theme/i],
  ['wordpress', /wp-content\/|wp-includes\//i],
];

const PROVIDER_PATTERNS: Array<[ReservationProvider, RegExp]> = [
  ['zenchef', /zenchef/i],
  ['thefork', /thefork|lafourchette/i],
  ['sevenrooms', /sevenrooms/i],
  ['resy', /resy\.com|resy-widget/i],
  ['opentable', /opentable/i],
  ['guestonline', /guestonline/i],
];

const BOOKING_HINT = /r[ée]serv|book|\btable/i;

/** Lit un attribut dans une balise ouvrante (`name="…"` ou `name='…'`), sans confondre data-name. */
function attr(tag: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag);
  return match?.[1];
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectPlatform(html: string): SitePlatform {
  const generators = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /name\s*=\s*["']generator["']/i.test(tag))
    .map((tag) => attr(tag, 'content') ?? '')
    .join(' ');
  for (const [platform, pattern] of GENERATOR_PATTERNS) {
    if (pattern.test(generators)) return platform;
  }
  for (const [platform, pattern] of SIGNATURE_PATTERNS) {
    if (pattern.test(html)) return platform;
  }
  return 'unknown';
}

export function detectProviders(html: string): ReservationProvider[] {
  return PROVIDER_PATTERNS.filter(([, pattern]) => pattern.test(html)).map(([name]) => name);
}

function isSuppernoteHost(hostname: string): boolean {
  return hostname === 'suppernote.com' || hostname.endsWith('.suppernote.com');
}

function classifyTarget(hostname: string): BookingTarget {
  if (isSuppernoteHost(hostname)) return 'suppernote';
  if (/zenchef/i.test(hostname)) return 'zenchef';
  if (/thefork|lafourchette/i.test(hostname)) return 'thefork';
  return 'other';
}

/** Liens `<a>` dont le texte ou l'adresse évoque une réservation. Max 20, dédupliqués. */
export function extractBookingLinks(html: string, pageUrl: string, max = 20): BookingLink[] {
  const seen = new Set<string>();
  const links: BookingLink[] = [];
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    if (links.length >= max) break;
    const rawHref = attr(match[1], 'href');
    if (!rawHref) continue;
    let absolute: URL;
    try {
      absolute = new URL(rawHref.trim().replace(/&amp;/g, '&'), pageUrl);
    } catch {
      continue;
    }
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
    const text = stripTags(match[2]).slice(0, 120);
    if (!BOOKING_HINT.test(text) && !BOOKING_HINT.test(absolute.href)) continue;
    if (seen.has(absolute.href)) continue;
    seen.add(absolute.href);
    links.push({ href: absolute.href, text, target: classifyTarget(absolute.hostname) });
  }
  return links;
}

/** Présence de `embed.js` hébergé sur Suppernote, et concordance de son `data-slug`. */
export function detectEmbedScript(
  html: string,
  pageUrl: string,
  slug: string,
): { scriptFound: boolean; slugMatches: boolean | null } {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attr(match[0], 'src');
    if (!src) continue;
    let absolute: URL;
    try {
      absolute = new URL(src, pageUrl);
    } catch {
      continue;
    }
    if (!isSuppernoteHost(absolute.hostname) || !/\/embed\.js$/.test(absolute.pathname)) continue;
    return { scriptFound: true, slugMatches: attr(match[0], 'data-slug') === slug };
  }
  return { scriptFound: false, slugMatches: null };
}

const FRAME_OR_SCRIPT_DIRECTIVES = (directives: Map<string, string[]>) => ({
  frame:
    directives.get('frame-src') ?? directives.get('child-src') ?? directives.get('default-src'),
  script: directives.get('script-src') ?? directives.get('default-src'),
});

function allowsSuppernote(sources: string[]): boolean {
  return sources.some(
    (source) =>
      source === '*' ||
      source.toLowerCase() === 'https:' ||
      /^(https?:\/\/)?(\*\.)?suppernote\.com$/i.test(source),
  );
}

function parseDirectives(policy: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), sources);
  }
  return directives;
}

/**
 * `true` si la CSP du site ne laisse pas Suppernote charger son script ou s'afficher dans un iframe
 * (frame-src → child-src → default-src ; script-src → default-src). `null` si aucune CSP.
 */
export function detectFramingBlocked(csp: string | string[] | undefined): boolean | null {
  if (csp === undefined) return null;
  const policies = Array.isArray(csp) ? csp : [csp];
  if (policies.length === 0) return null;
  return policies.some((policy) => {
    const { frame, script } = FRAME_OR_SCRIPT_DIRECTIVES(parseDirectives(policy));
    return (frame && !allowsSuppernote(frame)) || (script && !allowsSuppernote(script)) || false;
  });
}

export function cspHeader(headers: IncomingHttpHeaders): string | string[] | undefined {
  return headers['content-security-policy'];
}
