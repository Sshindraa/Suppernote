/**
 * Suppernote Connect — Middleware sécurité.
 *
 * Headers ajoutés sur toutes les réponses :
 * - Strict-Transport-Security (HSTS)
 * - X-Content-Type-Options: nosniff
 * - X-Frame-Options: DENY (anti-clickjacking) — relaxé en SAMEORIGIN si ?preview=1
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Content-Security-Policy nonce-based pour les scripts exécutables, Cloudinary images
 *
 * CSP : utilise un nonce par requête pour autoriser uniquement les scripts
 * exécutables inline légitimes. Plus de 'unsafe-inline' sur script-src (audit
 * sécurité Phase 2). style-src garde 'unsafe-inline' (Tailwind inline styles).
 *
 * En mode preview (?preview=1), on autorise l'embedding iframe depuis le
 * dashboard (cf. spec connect-v1.1 §13.5). DASHBOARD_URL (env) contient
 * l'origine du dashboard — en prod c'est le même domaine (suppernote.com),
 * en dev c'est http://localhost:3000.
 *
 * Cf. spec connect-v1.1 §21.4 (sécurité) et §17.3 (performance).
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Bots IA à tracker (pour mesurer l'efficacité réelle du web crawl).
// Loggué côté serveur via console.log (récupéré par PM2 / Docker logs).
const IA_BOTS = [
  'OAI-SearchBot',
  'GPTBot',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Bytespider',
  'CCBot',
  'Googlebot',
  'Bingbot',
  'Applebot',
];

function detectBot(userAgent: string): string | null {
  for (const bot of IA_BOTS) {
    if (userAgent.includes(bot)) return bot;
  }
  return null;
}

export function proxy(request: NextRequest) {
  // Generate a per-request nonce for CSP script-src (audit sécurité Phase 2).
  // crypto.randomUUID() is available in Edge Runtime.
  const nonce = crypto.randomUUID();

  // Forward the nonce to Server Components via a request header.
  // Server Components read it via headers() from 'next/headers'.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  // Next extracts its script nonce from the request CSP, not x-nonce. Privacy
  // renders per request so its inline bootstrap matches the response policy.
  if (request.nextUrl.pathname === '/privacy') {
    requestHeaders.set('Content-Security-Policy', `script-src 'nonce-${nonce}'`);
  }
  const isPreview = request.nextUrl.searchParams.get('preview') === '1';

  // Suppernote Connect P2 — Premium subdomain detection.
  // Si le host n'est pas suppernote.com (ou www.), on vérifie si c'est un custom domain.
  // Le lookup DB se fait via l'API interne (Edge Runtime ne peut pas accéder à Prisma).
  // On fire-and-forget le lookup et on rewrite si match.
  const host = request.headers.get('host') ?? '';
  const siteUrl = process.env.SITE_URL ?? 'https://suppernote.com';
  const primaryHost = new URL(siteUrl).host; // suppernote.com
  const isPrimaryHost =
    host === primaryHost ||
    host === `www.${primaryHost}` ||
    host.startsWith('localhost:') ||
    host.startsWith('127.0.0.1:');

  // Subdomain gratuit : *.suppernote.com (ex: chezmario.suppernote.com)
  // Zero config — basé sur le slug du restaurant. Détecté AVANT les custom domains
  // pour éviter un lookup DB inutile sur les subdomains Suppernote.
  //
  // Sécurité (defense-in-depth) : le middleware Edge ne peut pas faire de DB lookup
  // pour vérifier que le restaurant est publié. La validation se fait dans la page
  // /restaurant/[slug]/page.tsx via fetchPublicRestaurant() qui retourne notFound()
  // si le restaurant n'existe pas ou n'est pas publié. Le middleware ne fait donc
  // qu'une rewrite neutre — pas de fuite de données sur les restaurants non publiés.
  const isSubdomain = !isPrimaryHost && host.endsWith(`.${primaryHost}`);

  if (isSubdomain && host) {
    // Extraire le slug du subdomain (ex: chezmario.suppernote.com → chezmario)
    const slug = host.slice(0, host.length - primaryHost.length - 1);
    if (slug && slug !== 'www') {
      // Cloner nextUrl et forcer le protocole en http:// pour éviter le proxy
      // interne HTTPS (EPROTO) derrière Nginx (X-Forwarded-Proto: https).
      // Next.js 15 requiert une URL absolue ; on garde le même host mais en http.
      const url = request.nextUrl.clone();
      url.protocol = 'http:';
      url.pathname = `/restaurant/${slug}`;
      const rewriteResponse = NextResponse.rewrite(url, {
        request: { headers: requestHeaders },
      });
      applySecurityHeaders(rewriteResponse, request, nonce, false, false, false);
      return rewriteResponse;
    }
  }

  if (!isPrimaryHost && host) {
    // Custom domain potentiel — rewrite vers /restaurant/[slug] via lookup API.
    // L'API interne résout customDomain → slug et on rewrite silencieusement.
    // On ne peut pas faire d'async ici (middleware sync), donc on passe le host
    // à l'API et on rewrite vers une route dynamique qui fera le lookup.
    const apiUrl = process.env.API_URL;
    if (apiUrl) {
      // Fire-and-forget : on ne peut pas attendre la réponse en middleware sync.
      // À la place, on rewrite vers /custom-domain qui fera le lookup server-side.
      // Forcer http:// (cf. subdomain ci-dessus).
      const url = request.nextUrl.clone();
      url.protocol = 'http:';
      url.pathname = '/custom-domain';
      url.searchParams.set('host', host);
      const rewriteResponse = NextResponse.rewrite(url, {
        request: { headers: requestHeaders },
      });
      // Custom domain : pas de X-Frame-Options DENY (le restaurateur peut vouloir embed)
      // mais frame-ancestors 'none' par défaut via isWidget=false, isPreview=false.
      applySecurityHeaders(rewriteResponse, request, nonce, false, false, false);
      return rewriteResponse;
    }
  }

  const requestOptions = { request: { headers: requestHeaders } };
  const response = NextResponse.next(requestOptions);

  // Instrumentation : log les hits par bot IA sur les pages publiques.
  // Permet de savoir quels bots crawlent réellement Suppernote (vs hypothèse).
  const userAgent = request.headers.get('user-agent') ?? '';
  const bot = detectBot(userAgent);
  if (bot) {
    const path = request.nextUrl.pathname;
    // Ne log que les pages intéressantes (pas les assets)
    if (
      path.startsWith('/restaurant/') ||
      path === '/llms.txt' ||
      path === '/robots.txt' ||
      path === '/sitemap.xml' ||
      path.startsWith('/.well-known/')
    ) {
      // Log structuré pour PM2/Docker logs (instrumentation bots IA).
      // console.log est supporté par l'Edge Runtime (pas process.stdout).
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          type: 'ia_bot_hit',
          bot,
          path,
          method: request.method,
          ts: new Date().toISOString(),
        }),
      );

      // Forward en fire-and-forget vers l'API analytics pour incrémenter
      // la métrique Prometheus sokar_connect_ia_bot_hits_total (cf. Phase 1
      // observabilité). Best-effort : ne bloque pas la réponse.
      const apiUrl = process.env.API_URL;
      if (apiUrl) {
        fetch(`${apiUrl}/public/analytics/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'ia_bot_hit', bot, path }),
          cache: 'no-store',
          keepalive: true,
        }).catch(() => {
          // Best-effort : on ignore les erreurs (API down, réseau)
        });
      }
    }
  }

  // ?preview=1 — mode preview dashboard (noindex, framing autorisé)
  // Pages widget — autorisées à être embarquées dans un iframe sur n'importe quel domaine
  const isWidget = request.nextUrl.pathname.startsWith('/widget/');

  applySecurityHeaders(response, request, nonce, !isWidget, isWidget, isPreview);

  return response;
}

function applySecurityHeaders(
  response: NextResponse,
  request: NextRequest,
  nonce: string,
  setXFrameDeny: boolean,
  isWidget: boolean,
  isPreview: boolean,
) {
  // HSTS — force HTTPS pendant 2 ans (aligné avec nginx, spec §8.2)
  response.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');

  // Anti-MIME sniffing
  response.headers.set('X-Content-Type-Options', 'nosniff');

  // X-Frame-Options ne permet pas de déclarer une origine dashboard précise.
  // Le preview cross-origin s'appuie donc uniquement sur CSP frame-ancestors.
  // Sur /widget/* on ne met PAS X-Frame-Options : la directive CSP
  // frame-ancestors * suffit et est la seule valeur standard cross-browser
  // pour autoriser l'embedding depuis n'importe quel domaine.
  if (setXFrameDeny && !isPreview) {
    response.headers.set('X-Frame-Options', 'DENY');
  }

  // Pas de referrer vers des sites tiers non approuvés
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  // Permissions-Policy : pas d'accès aux APIs sensibles du navigateur
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  );

  // frame-ancestors : '*' sur /widget/*, 'self' + DASHBOARD_URL en preview, 'none' sinon
  const dashboardUrl = process.env.DASHBOARD_URL;
  const frameAncestors = isWidget
    ? '*'
    : isPreview
      ? dashboardUrl
        ? `'self' ${dashboardUrl}`
        : "'self'"
      : "'none'";

  const apiOrigin = getConfiguredApiOrigin();
  const connectSources = ["'self'", apiOrigin].filter((source): source is string =>
    Boolean(source),
  );

  // CSP : nonce-based pour script-src (audit sécurité Phase 2 — supprime 'unsafe-inline').
  // Les blocs JSON-LD sont des données inertes et n'ont pas besoin d'un nonce par requête.
  // Le runtime webpack de Next en mode dev utilise eval pour le hot reload ; cette
  // exception reste limitée au développement et n'est jamais envoyée en production.
  // style-src garde 'unsafe-inline' (Tailwind injecte des styles inline au runtime).
  const scriptSources = [
    "'self'",
    `'nonce-${nonce}'`,
    'https://js.stripe.com',
    ...(process.env.NODE_ENV === 'development' ? ["'unsafe-eval'"] : []),
  ];
  const frameSources = ["'self'", 'https://js.stripe.com', 'https://hooks.stripe.com'];
  const apiConnectSources = [...connectSources, 'https://api.stripe.com', 'https://r.stripe.com'];
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSources.join(' ')}`,
    "style-src 'self' 'unsafe-inline'", // Tailwind inline styles
    "img-src 'self' https://res.cloudinary.com https://images.unsplash.com data:",
    "font-src 'self' data:",
    `connect-src ${apiConnectSources.join(' ')}`,
    `frame-src ${frameSources.join(' ')}`,
    `frame-ancestors ${frameAncestors}`,
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
  response.headers.set('Content-Security-Policy', csp);
}

function getConfiguredApiOrigin(): string | null {
  const configuredApiUrl = process.env.NEXT_PUBLIC_API_URL ?? process.env.API_URL;
  if (!configuredApiUrl) return null;

  try {
    return new URL(configuredApiUrl).origin;
  } catch {
    return null;
  }
}

export const config = {
  matcher: [
    /*
     * Match toutes les routes SAUF les assets statiques (Next les sert
     * sans passer par le middleware pour la perf).
     */
    '/((?!connect-assets|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico)).*)',
  ],
};
