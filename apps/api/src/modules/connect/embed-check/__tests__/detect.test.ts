import { describe, it, expect } from 'vitest';
import {
  detectEmbedScript,
  detectFramingBlocked,
  detectPlatform,
  detectProviders,
  extractBookingLinks,
} from '../detect';

const PAGE = 'https://chez-x.fr/';

const WORDPRESS_PAGE = `<html><head>
<meta name="generator" content="WordPress 6.5.2">
</head><body>
<a href="/reserver">Réserver une table</a>
<a href="https://www.thefork.com/restaurant/chez-x">Book on TheFork</a>
<a href="mailto:contact@chez-x.fr">Écrire</a>
<a href="javascript:void(0)">Réservation</a>
<a href="https://suppernote.com/r/chez-x">Réserver</a>
<a href="/carte">La carte</a>
<script src="https://suppernote.com/embed.js" data-slug="chez-x"></script>
<iframe src="https://bookings.zenchef.com/widget?r=1"></iframe>
</body></html>`;

describe('detectPlatform', () => {
  it('lit le générateur WordPress', () => {
    expect(detectPlatform(WORDPRESS_PAGE)).toBe('wordpress');
  });

  it('reconnaît Wix via son CDN', () => {
    expect(detectPlatform('<img src="https://static.wixstatic.com/media/a.jpg">')).toBe('wix');
  });

  it('reconnaît Squarespace par le générateur', () => {
    expect(detectPlatform('<meta content="Squarespace" name="generator"><div></div>')).toBe(
      'squarespace',
    );
  });

  it('reconnaît Webflow, Shopify et WordPress par signature', () => {
    expect(detectPlatform('<html data-wf-site="abc">')).toBe('webflow');
    expect(detectPlatform('<link href="https://cdn.shopify.com/s/x.css">')).toBe('shopify');
    expect(detectPlatform('<link href="/wp-content/themes/x.css">')).toBe('wordpress');
  });

  it('renvoie unknown sans signal', () => {
    expect(detectPlatform('<html><body>Bonjour</body></html>')).toBe('unknown');
  });
});

describe('detectProviders', () => {
  it('repère les concurrents dans le HTML', () => {
    expect(detectProviders(WORDPRESS_PAGE)).toEqual(['zenchef', 'thefork']);
  });

  it('ne signale rien sur une page sans concurrent', () => {
    expect(detectProviders('<p>Carte du jour</p>')).toEqual([]);
  });
});

describe('extractBookingLinks', () => {
  const links = extractBookingLinks(WORDPRESS_PAGE, PAGE);

  it('résout les liens relatifs et classe la cible', () => {
    expect(links).toContainEqual({
      href: 'https://chez-x.fr/reserver',
      text: 'Réserver une table',
      target: 'other',
    });
    expect(links).toContainEqual({
      href: 'https://www.thefork.com/restaurant/chez-x',
      text: 'Book on TheFork',
      target: 'thefork',
    });
    expect(links).toContainEqual({
      href: 'https://suppernote.com/r/chez-x',
      text: 'Réserver',
      target: 'suppernote',
    });
  });

  it('ignore mailto, javascript et les liens sans rapport avec la réservation', () => {
    const hrefs = links.map((link) => link.href);
    // Contrôle sur le protocole analysé, pas sur un préfixe de chaîne.
    expect(hrefs.every((href) => ['http:', 'https:'].includes(new URL(href).protocol))).toBe(true);
    expect(hrefs).not.toContain('https://chez-x.fr/carte');
  });

  it('plafonne à 20 liens et dédoublonne', () => {
    const many = Array.from(
      { length: 25 },
      (_, i) => `<a href="/reserver-${i}">Réserver ${i}</a>`,
    ).join('');
    expect(extractBookingLinks(many, PAGE)).toHaveLength(20);
    expect(
      extractBookingLinks('<a href="/reserver">R</a><a href="/reserver">R</a>', PAGE),
    ).toHaveLength(1);
  });
});

describe('detectEmbedScript', () => {
  it('trouve embed.js Suppernote et compare le data-slug', () => {
    expect(detectEmbedScript(WORDPRESS_PAGE, PAGE, 'chez-x')).toEqual({
      scriptFound: true,
      slugMatches: true,
    });
    expect(detectEmbedScript(WORDPRESS_PAGE, PAGE, 'autre')).toEqual({
      scriptFound: true,
      slugMatches: false,
    });
  });

  it('ignore un embed.js hébergé ailleurs ou un data-src', () => {
    const html = `<script src="https://evil.example/embed.js" data-slug="chez-x"></script>
      <script data-src="https://suppernote.com/embed.js" data-slug="chez-x"></script>`;
    expect(detectEmbedScript(html, PAGE, 'chez-x')).toEqual({
      scriptFound: false,
      slugMatches: null,
    });
  });
});

describe('detectFramingBlocked', () => {
  it('renvoie null sans CSP', () => {
    expect(detectFramingBlocked(undefined)).toBeNull();
  });

  it('bloque quand script-src exclut suppernote.com', () => {
    expect(detectFramingBlocked("script-src 'self'")).toBe(true);
    expect(detectFramingBlocked("frame-src 'none'")).toBe(true);
    expect(detectFramingBlocked("default-src 'self'")).toBe(true);
  });

  it('laisse passer quand la source est autorisée', () => {
    expect(detectFramingBlocked("script-src 'self' https://suppernote.com")).toBe(false);
    expect(detectFramingBlocked('default-src *')).toBe(false);
    expect(detectFramingBlocked('frame-src https://*.suppernote.com')).toBe(false);
  });

  it('ne bloque pas une CSP sans directive concernée', () => {
    expect(detectFramingBlocked("img-src 'self'")).toBe(false);
  });

  it('bloque si une des politiques empêche le chargement', () => {
    expect(detectFramingBlocked(['default-src *', "script-src 'self'"])).toBe(true);
  });
});
