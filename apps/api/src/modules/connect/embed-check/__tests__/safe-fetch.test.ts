import { describe, it, expect, beforeEach, vi } from 'vitest';

// Transport et DNS simulés : aucun trafic réseau réel pendant les tests.
const fake = vi.hoisted(() => ({
  dns: new Map<string, string | string[]>(),
  seen: [] as string[],
  respond: (_href: string) => ({
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' } as Record<string, string>,
    body: Buffer.from('<html>ok</html>'),
  }),
}));

vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: (host: string, _opts: unknown, cb: (err: null, addrs: unknown) => void) => {
    const mapped = fake.dns.get(host) ?? (/^[\d.]+$|:/.test(host) ? host : '93.184.216.34');
    const addresses = (Array.isArray(mapped) ? mapped : [mapped]).map((address) => ({
      address,
      family: address.includes(':') ? 6 : 4,
    }));
    cb(null, addresses);
  },
}));

vi.mock('node:https', async (importOriginal) => {
  const { EventEmitter } = await import('node:events');
  const { Readable } = await import('node:stream');
  return {
    ...(await importOriginal<typeof import('node:https')>()),
    request: (url: URL, _opts: unknown, cb: (res: unknown) => void) => {
      fake.seen.push(url.href);
      const req = new EventEmitter() as import('node:events').EventEmitter & { end: () => void };
      req.end = () => {
        const r = fake.respond(url.href);
        queueMicrotask(() =>
          cb(Object.assign(Readable.from([r.body]), { statusCode: r.status, headers: r.headers })),
        );
      };
      return req;
    },
  };
});

import {
  fetchSitePage,
  isBlockedAddress,
  parseSiteUrl,
  SiteFetchFailure,
  SITE_CHECK_MAX_BYTES,
} from '../safe-fetch';

function page(body: string, contentType = 'text/html') {
  return { status: 200, headers: { 'content-type': contentType }, body: Buffer.from(body) };
}

async function failureCode(url: string): Promise<string | undefined> {
  try {
    await fetchSitePage(url);
    return undefined;
  } catch (err) {
    return err instanceof SiteFetchFailure ? err.code : `unexpected:${String(err)}`;
  }
}

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    '::ffff:10.0.0.1',
    '::ffff:127.0.0.1',
    '64:ff9b::a00:1',
  ])('bloque %s', (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.216.34', '2606:4700:4700::1111'])('laisse passer %s', (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe('parseSiteUrl', () => {
  it('accepte http(s) et ajoute https sans schéma', () => {
    expect(parseSiteUrl('chez-x.fr')?.href).toBe('https://chez-x.fr/');
    expect(parseSiteUrl(' http://chez-x.fr/menu ')?.href).toBe('http://chez-x.fr/menu');
  });

  it.each([
    'ftp://chez-x.fr',
    'file:///etc/passwd',
    'https://user:pw@chez-x.fr',
    'https://chez-x.fr:8443',
    'javascript:alert(1)',
    '',
  ])('refuse %s', (raw) => {
    expect(parseSiteUrl(raw)).toBeNull();
  });
});

describe('fetchSitePage — SSRF', () => {
  beforeEach(() => {
    fake.dns.clear();
    fake.seen.length = 0;
    fake.respond = () => page('<html>ok</html>');
  });

  it.each([
    ['http://127.0.0.1/', undefined],
    ['http://10.1.2.3/', undefined],
    ['http://169.254.169.254/latest/meta-data/', undefined],
    ['http://[::1]/', undefined],
    ['http://localhost/', '127.0.0.1'],
    ['https://metadata.test/', '169.254.169.254'],
    ['https://mixed.test/', ['93.184.216.34', '10.0.0.5']],
  ])('refuse %s avant toute connexion', async (url, resolvesTo) => {
    const host = new URL(url).hostname;
    if (resolvesTo) fake.dns.set(host, resolvesTo);
    expect(await failureCode(url)).toBe('blocked');
    expect(fake.seen).toEqual([]);
  });

  it('refuse une redirection vers une IP privée', async () => {
    fake.respond = (href) =>
      href === 'https://site.test/'
        ? {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/' },
            body: Buffer.alloc(0),
          }
        : page('<html>metadata</html>');
    expect(await failureCode('https://site.test/')).toBe('blocked');
    expect(fake.seen).toEqual(['https://site.test/']);
  });

  it('refuse une redirection vers un nom qui résout en privé', async () => {
    fake.dns.set('internal.test', '192.168.1.10');
    fake.respond = (href) =>
      href === 'https://site.test/'
        ? {
            status: 301,
            headers: { location: 'https://internal.test/admin' },
            body: Buffer.alloc(0),
          }
        : page('<html>internal</html>');
    expect(await failureCode('https://site.test/')).toBe('blocked');
  });

  it('suit une redirection publique puis renvoie l’URL finale', async () => {
    fake.respond = (href) =>
      href === 'https://site.test/'
        ? {
            status: 301,
            headers: { location: 'https://www.site.test/accueil' },
            body: Buffer.alloc(0),
          }
        : page('<html>accueil</html>');
    const result = await fetchSitePage('https://site.test/');
    expect(result.finalUrl).toBe('https://www.site.test/accueil');
    expect(result.html).toBe('<html>accueil</html>');
  });

  it('abandonne après 3 redirections', async () => {
    fake.respond = () => ({
      status: 302,
      headers: { location: 'https://loop.test/' },
      body: Buffer.alloc(0),
    });
    expect(await failureCode('https://loop.test/')).toBe('http_error');
    expect(fake.seen).toHaveLength(4);
  });

  it('refuse un schéma non HTTP dans une redirection', async () => {
    fake.respond = () => ({
      status: 302,
      headers: { location: 'file:///etc/passwd' },
      body: Buffer.alloc(0),
    });
    expect(await failureCode('https://site.test/')).toBe('invalid_url');
  });

  it('refuse une URL invalide sans réseau', async () => {
    expect(await failureCode('ftp://site.test/')).toBe('invalid_url');
    expect(fake.seen).toEqual([]);
  });
});

describe('fetchSitePage — réponses', () => {
  beforeEach(() => {
    fake.dns.clear();
    fake.seen.length = 0;
  });

  it('renvoie le HTML d’une page publique', async () => {
    fake.respond = () => page('<html>ok</html>');
    const result = await fetchSitePage('https://site.test/');
    expect(result.finalUrl).toBe('https://site.test/');
    expect(result.html).toBe('<html>ok</html>');
  });

  it('refuse un type non HTML', async () => {
    fake.respond = () => page('%PDF', 'application/pdf');
    expect(await failureCode('https://site.test/')).toBe('not_html');
  });

  it('refuse une page au-delà de 2 Mo', async () => {
    fake.respond = () => page('x'.repeat(SITE_CHECK_MAX_BYTES + 1));
    expect(await failureCode('https://site.test/')).toBe('too_large');
  });

  it('signale une erreur HTTP', async () => {
    fake.respond = () => ({
      status: 503,
      headers: { 'content-type': 'text/html' },
      body: Buffer.alloc(0),
    });
    expect(await failureCode('https://site.test/')).toBe('http_error');
  });
});
