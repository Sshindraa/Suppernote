import { defineConfig } from '@playwright/test';

/**
 * Configuration Playwright pour Suppernote Connect.
 *
 * Tests E2E des flows critiques de Connect (pages publiques) :
 *  - restaurant-page.spec.ts : page restaurant publique (/restaurant/[slug])
 *  - booking-flow.spec.ts    : flow de réservation via le widget (/widget/[slug])
 *  - gift-card-flow.spec.ts  : flow d'achat de carte cadeau (/widget/[slug]/gift-card)
 *
 * Contrairement au dashboard, Connect nécessite l'API Fastify (localhost:4100 en
 * staging, localhost:4000 en dev) + une DB seedée (restaurant de démo
 * "chez-suppernote-demo"). Les tests utilisent un test.beforeAll qui vérifie la
 * santé de l'API et skippe tout le fichier si elle n'est pas disponible —
 * non-bloquant en CI sans infra.
 *
 * On commence simple : 1 projet desktop Chromium (1280x720). On ajoutera les
 * projets mobile (iPhone 14, iPad Mini) plus tard.
 *
 * Pas de régression visuelle pour l'instant (contrairement au dashboard).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },

  use: {
    // PLAYWRIGHT_BASE_URL permet de cibler un environnement distant (staging)
    // sans démarrer le dev server local.
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:4002',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'desktop-1280',
      use: {
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  // webServer : démarre le dev server Connect pour les tests E2E.
  // Skip si PLAYWRIGHT_BASE_URL est défini (tests contre un environnement
  // distant comme staging — le serveur est déjà en ligne).
  ...(process.env.PLAYWRIGHT_BASE_URL
    ? {}
    : {
        webServer: {
          command: 'pnpm --filter @suppernote/connect dev',
          url: 'http://localhost:4002',
          timeout: 60_000,
          reuseExistingServer: !process.env.CI,
          cwd: __dirname,
        },
      }),
});
