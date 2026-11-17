/**
 * Lecture serveur d'une page client pour le contrôle de site (widget / bouton de réservation).
 *
 * Défense SSRF : http(s) seulement, adresses publiques uniquement (toutes les réponses DNS sont
 * vérifiées), l'adresse validée est épinglée à la connexion (pas de second DNS → pas de rebinding),
 * chaque redirection est revalidée, délai total 8 s, 2 Mo maximum.
 */
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIPv6 } from 'node:net';

export type SiteFetchError =
  | 'timeout'
  | 'blocked'
  | 'not_html'
  | 'too_large'
  | 'http_error'
  | 'invalid_url';

export const SITE_CHECK_TIMEOUT_MS = 8_000;
export const SITE_CHECK_MAX_BYTES = 2 * 1024 * 1024;
export const SITE_CHECK_MAX_REDIRECTS = 3;
const USER_AGENT = 'SuppernoteSiteCheck/1.0';
const HTML_CONTENT_TYPE = /^(text\/html|application\/xhtml\+xml)\b/i;

export class SiteFetchFailure extends Error {
  constructor(readonly code: SiteFetchError) {
    super(code);
    this.name = 'SiteFetchFailure';
  }
}

export interface PageFetch {
  finalUrl: string;
  headers: IncomingHttpHeaders;
  html: string;
}

// Listes séparées IPv4 / IPv6 : BlockList compare un IPv4 aux règles IPv6 mappées (::ffff:0:0/96)
// et bloquerait tout le web. Les adresses IPv4-mappées sont dépliées avant contrôle.
const BLOCKED_V4 = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
}

const BLOCKED_V6 = new BlockList();
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
] as const) {
  BLOCKED_V6.addSubnet(address, prefix, 'ipv6');
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isBlockedAddress(address: string): boolean {
  const mapped = MAPPED_V4.exec(address);
  if (mapped) return BLOCKED_V4.check(mapped[1], 'ipv4');
  if (isIPv6(address)) return BLOCKED_V6.check(address, 'ipv6');
  return BLOCKED_V4.check(address, 'ipv4');
}

/** URL acceptée : http(s), sans identifiants, port par défaut uniquement. Sans schéma → https. */
export function parseSiteUrl(raw: string): URL | null {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || !url.hostname) return null;
  if (url.port && url.port !== '80' && url.port !== '443') return null;
  return url;
}

async function resolvePublicAddress(hostname: string): Promise<LookupAddress> {
  const host = hostname.replace(/^\[|\]$/g, '');
  let addresses: LookupAddress[];
  try {
    addresses = await new Promise<LookupAddress[]>((resolve, reject) => {
      dnsLookup(host, { all: true }, (err, result) => (err ? reject(err) : resolve(result)));
    });
  } catch {
    throw new SiteFetchFailure('http_error');
  }
  // Une seule réponse non publique suffit à refuser : pas de « best effort » sur le DNS.
  if (addresses.length === 0 || addresses.some((a) => isBlockedAddress(a.address))) {
    throw new SiteFetchFailure('blocked');
  }
  return addresses[0];
}

function pinnedLookup(address: LookupAddress) {
  return (
    _hostname: string,
    options: LookupOptions,
    callback: (err: null, address: string | LookupAddress[], family?: number) => void,
  ) => {
    // Node peut demander la liste complète (autoSelectFamily) : on ne renvoie que l'adresse validée.
    if (options.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
}

function getPinned(
  url: URL,
  address: LookupAddress,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'GET',
        signal,
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          // Pas de compression : on lit le corps brut et on le plafonne octet par octet.
          'accept-encoding': 'identity',
        },
        lookup: pinnedLookup(address) as never,
      },
      resolve,
    );
    req.on('error', reject);
    req.end();
  });
}

function toFetchFailure(err: unknown): never {
  if (err instanceof SiteFetchFailure) throw err;
  if (err instanceof Error && err.name === 'AbortError') throw new SiteFetchFailure('timeout');
  throw new SiteFetchFailure('http_error');
}

async function readCapped(res: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > SITE_CHECK_MAX_BYTES) {
        res.destroy();
        throw new SiteFetchFailure('too_large');
      }
      chunks.push(buf);
    }
  } catch (err) {
    toFetchFailure(err);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function followRedirects(start: URL, signal: AbortSignal): Promise<PageFetch> {
  let current = start;
  for (let hop = 0; hop <= SITE_CHECK_MAX_REDIRECTS; hop++) {
    const address = await resolvePublicAddress(current.hostname);
    const res = await getPinned(current, address, signal).catch(toFetchFailure);
    const status = res.statusCode ?? 0;
    const location = res.headers.location;

    if (status >= 300 && status < 400 && location) {
      res.resume();
      if (hop === SITE_CHECK_MAX_REDIRECTS) throw new SiteFetchFailure('http_error');
      let next: URL | null = null;
      try {
        next = parseSiteUrl(new URL(location, current).href);
      } catch {
        next = null;
      }
      if (!next) throw new SiteFetchFailure('invalid_url');
      current = next;
      continue;
    }

    if (status < 200 || status >= 300) {
      res.resume();
      throw new SiteFetchFailure('http_error');
    }
    if (!HTML_CONTENT_TYPE.test(res.headers['content-type'] ?? '')) {
      res.resume();
      throw new SiteFetchFailure('not_html');
    }
    const html = await readCapped(res);
    return { finalUrl: current.href, headers: res.headers, html };
  }
  throw new SiteFetchFailure('http_error');
}

/** Télécharge la page HTML d'un site client. Lève `SiteFetchFailure` avec le code d'erreur exposé. */
export async function fetchSitePage(rawUrl: string): Promise<PageFetch> {
  const start = parseSiteUrl(rawUrl);
  if (!start) throw new SiteFetchFailure('invalid_url');

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Le délai couvre aussi le DNS, que `signal` n'interrompt pas.
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SiteFetchFailure('timeout'));
    }, SITE_CHECK_TIMEOUT_MS);
  });
  try {
    return await Promise.race([followRedirects(start, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
