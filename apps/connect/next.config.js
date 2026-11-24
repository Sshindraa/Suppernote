const { withSentryConfig } = require('@sentry/nextjs/config');

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Suppernote Connect est servi par un Node Next standalone derrière Nginx
  // (cf. spec connect-v1.1 §3.3 hébergement). PAS static export.
  output: 'standalone',
  // Le déploiement peut construire une release isolée avant de remplacer
  // atomiquement le dossier actif `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Pas de basePath global (cf. spec v1.1 §2.1) : le reverse-proxy route
  // /restaurant/*, /restaurants/*, /sitemap.xml, /robots.txt vers ce serveur.
  poweredByHeader: false,
  assetPrefix: '/connect-assets',
  // Redirect de sécurité : /r/[slug](/book) → /restaurant/[slug](/book).
  // L'ancien préfixe /r/ a été renommé en /restaurant/ (cohérence URL).
  // Redirect permanent (308) : aucun contenu indexé sous /r/ en prod, mais
  // protège si un lien /r/ a fuité dans un cache IA ou un bookmark.
  async redirects() {
    return [
      {
        source: '/r/:slug*',
        destination: '/restaurant/:slug*',
        permanent: true,
      },
    ];
  },
  // Sécurité — headers ajoutés via proxy.ts (CSP/HSTS/Stripe-frame-blockers).
  // next.config ne les porte pas car ils dépendent du contexte request.
  images: {
    // Pas d'optimisation Next/Image : on sert des URLs externes (Cloudinary, etc.).
    // L'optimisation est gérée par le CDN upstream (Cloudflare).
    unoptimized: true,
    // Domaines autorisés pour les <Image src="https://..."> externes.
    remotePatterns: [
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: 'images.unsplash.com' },
    ],
  },
  // Server Actions : allowedOrigins est auto-détecté en Next 15.
  // parallelServerBuildTraces: true — parallélise le tracing sur 2 cores. Désactivé quand
  // Sentry enveloppe la config (SENTRY_AUTH_TOKEN) : le plugin webpack retire le build
  // worker dont cette option dépend, et le build échoue sinon.
  experimental: {
    parallelServerBuildTraces: !process.env.SENTRY_AUTH_TOKEN,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

// Sentry : upload des source maps au build, seulement si SENTRY_AUTH_TOKEN est fourni
// (Organization token injecté par le workflow de déploiement, jamais écrit dans un
// .env). Pas de tunnel navigateur : Connect n'initialise Sentry que côté serveur.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

module.exports = sentryAuthToken
  ? withSentryConfig(nextConfig, {
      org: 'suppernote',
      project: 'suppernote-connect',
      silent: true,
      widenClientFileUpload: true,
      webpack: { treeshake: { removeDebugLogging: true } },
      // Un upload en échec ne doit pas bloquer un déploiement.
      errorHandler: (error) => {
        process.stderr.write(`[sentry] upload des source maps échoué : ${error.message}\n`);
      },
    })
  : nextConfig;
