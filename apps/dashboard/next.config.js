const { withSentryConfig } = require('@sentry/nextjs');
const createNextIntlPlugin = require('next-intl/plugin');

// next-intl 4 a besoin d'un plugin Next pour inliner les messages dans le
// bundle client. On pointe vers `src/i18n/request.ts` qui est l'entrée
// `getRequestConfig` documentée par next-intl pour App Router. La locale se
// résout côté serveur (pas de segment [locale], pas de middleware de
// réécriture) — cf. apps/dashboard/src/i18n/config.ts.
const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  // N'annonce pas la pile technique (en-tête x-powered-by).
  poweredByHeader: false,
  // Le bouton Next.js de développement recouvre la navigation tactile et
  // n'apporte rien à l'aperçu produit. Il n'est jamais généré dans un build
  // de production.
  devIndicators: false,
  // Les déploiements produisent une release dans un dossier isolé puis
  // basculent `.next` atomiquement. En local/CI, le dossier historique reste
  // `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Désactivé : sharp non disponible sur le VPS
  images: {
    unoptimized: true,
  },
  // parallelServerBuildTraces: true — parallélise le tracing sur 2 cores.
  // (Les build traces prenaient 1 min 37 s en séquentiel sur le VPS HDD.)
  // webpackBuildWorker: true — requis pour que parallelServerBuildTraces
  // s'active (Next 15 désactive le build worker dès qu'un plugin modifie
  // la config webpack, ce qui est le cas de next-intl/plugin).
  // ATTENTION : ces options sont désactivées car elles empêchent la génération
  // des chunks core (main-app.js, polyfills.js) en dev Next 15.5.20.
  // À ré-activer en prod uniquement après validation d'un build complet.
  experimental: {
    parallelServerBuildTraces: false,
    webpackBuildWorker: false,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
};

// Sentry n'est actif que si SENTRY_AUTH_TOKEN est présent.
// En prod le token n'est pas configuré → on évite le overhead de wrapping.
const sentryEnabled = !!process.env.SENTRY_AUTH_TOKEN;

module.exports = sentryEnabled
  ? withSentryConfig(
      withNextIntl(nextConfig),
      { silent: true, org: 'suppernote', project: 'suppernote-dashboard' },
      {
        widenClientFileUpload: true,
        transpileClientSDK: false,
        tunnelRoute: '/monitoring',
        hideSourceMaps: true,
        disableLogger: true,
        automaticVercelCronInstrumentation: true,
      },
    )
  : withNextIntl(nextConfig);
