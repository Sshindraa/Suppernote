import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';

/**
 * Tests de régression visuelle — Phase 2 du plan qualité Suppernote.
 *
 * Pour chaque page critique et chaque viewport (iPhone 14, iPad Mini, desktop
 * 1440px), on capture un screenshot et on le compare au baseline stocké dans
 * `e2e/__snapshots__/`. Seuil de tolérance : 0.2 % de diff pixel.
 *
 * Pages testées :
 *  - /dashboard              — cockpit avec données de démo (sans Clerk)
 *  - /dashboard/reservations — skeleton (loading sans Clerk, état stable)
 *  - /dashboard/calls        — skeleton
 *  - /dashboard/gift-cards   — skeleton
 *  - /                       — homepage marketing (hero section)
 *  - /pricing                — page tarifs
 *
 * Stabilité :
 *  - `animations: 'disabled'` (config expect.toHaveScreenshot) →
 *    CSS animations neutralisées par Playwright.
 *  - `stylePath` injecte un CSS qui désactive les transitions, force
 *    -webkit-font-smoothing: antialiased, et masque le caret texte.
 *  - `waitUntil: 'networkidle'` + attente de sélecteurs stables avant capture.
 *  - Les pages dashboard sans Clerk affichent les données de démo ou un
 *    skeleton — pas de contenu aléatoire ni d'appel API.
 *  - Pour /dashboard, on attend .recharts-surface (graphiques SVG rendus) en
 *    plus du h1, puis settleMs: 3000ms pour laisser recharts stabiliser son
 *    rendu (le SVG est dessiné de façon asynchrone après l'hydratation).
 *
 * Mettre à jour les baselines après un changement visuel intentionnel :
 *   pnpm test:visual -- --update-snapshots
 * Puis review le diff dans `e2e/__snapshots__/` et committer.
 */

const STABILITY_CSS = path.resolve(__dirname, 'visual-stability.css');

interface VisualPage {
  name: string;
  url: string;
  /** Sélecteur(s) Playwright à attendre avant de capturer le screenshot.
   * Tous les sélecteurs doivent être visibles avant la capture. */
  waitFor: string | string[];
  /** Temps d'attente supplémentaire (ms) après le sélecteur pour laisser les
   * composants dynamiques (recharts, framer-motion) atteindre leur état final. */
  settleMs?: number;
}

const PAGES: VisualPage[] = [
  {
    name: 'dashboard',
    url: '/dashboard',
    // Le heading "Pilotage" apparaît une fois les données de
    // démo chargées. On attend AUSSI .recharts-surface car les graphiques
    // recharts sont rendus de façon asynchrone (dynamic import + SVG draw) —
    // sans cette attente, le screenshot peut capturer un graphique vide ou
    // partiellement dessiné, causant jusqu'à 2 % de diff pixel (flaky).
    // settleMs: 3000ms pour laisser recharts stabiliser son rendu SVG après
    // l'apparition de .recharts-surface (le SVG continue de se dessiner après
    // l'insertion du nœud dans le DOM).
    waitFor: ['h1:has-text("Pilotage")', '.recharts-surface'],
    settleMs: 3000,
  },
  {
    name: 'dashboard-reservations',
    url: '/dashboard/reservations',
    // Le serveur API peut être indisponible en local : on attend le titre,
    // puis l'état vide ou l'état d'erreur actionnable, jamais un skeleton
    // dont la durée dépend du réseau.
    waitFor: 'h1:has-text("Réservations")',
    settleMs: 500,
  },
  {
    name: 'dashboard-calls',
    url: '/dashboard/calls',
    waitFor: 'h1:has-text("Appels")',
    settleMs: 500,
  },
  {
    name: 'dashboard-gift-cards',
    url: '/dashboard/gift-cards',
    waitFor: 'h1:has-text("Cartes cadeaux")',
    settleMs: 500,
  },
  {
    name: 'homepage',
    url: '/',
    // Le hero de la homepage contient le h1 « Le chef de rang numérique de votre restaurant ».
    // On attend ce heading pour s'assurer que le hero est rendu.
    waitFor: 'h1:has-text("chef de rang")',
    settleMs: 2000,
  },
  {
    name: 'pricing',
    url: '/pricing',
    // Le titre principal confirme le rendu de la page tarifs.
    waitFor: '.pricing-hero h1',
    settleMs: 2000,
  },
];

test.describe('Régression visuelle — pages critiques', () => {
  for (const page of PAGES) {
    test(`${page.name} correspond au baseline`, async ({ page: pwPage }: { page: Page }) => {
      // L'invite d'installation PWA est un onboarding interactif, pas le
      // contenu testé. La neutraliser rend les captures comparables sans
      // imposer une écriture de localStorage au restaurateur.
      await pwPage.addInitScript(() => {
        window.localStorage.setItem('suppernote_pwa_dismissed', 'true');
      });

      if (page.name === 'pricing') {
        await pwPage.addInitScript(() => window.localStorage.setItem('theme', 'light'));
      }

      // 1. Naviguer vers la page et attendre que le réseau soit inactif.
      await pwPage.goto(page.url, { waitUntil: 'networkidle' });

      // 2. Attendre que tous les contenus clés soient rendus (heading,
      //    skeleton, graphiques recharts, etc.). On attend chaque sélecteur
      //    séquentiellement pour s'assurer que tous les composants dynamiques
      //    sont présents dans le DOM avant la capture.
      const selectors = Array.isArray(page.waitFor) ? page.waitFor : [page.waitFor];
      for (const selector of selectors) {
        await pwPage.waitForSelector(selector, { state: 'visible', timeout: 15_000 });
      }

      // 3. Laisser les composants dynamiques (recharts, framer-motion) atteindre
      //    leur état final après la désactivation des animations.
      if (page.settleMs) {
        await pwPage.waitForTimeout(page.settleMs);
      }

      // 4. Capturer le screenshot et le comparer au baseline.
      //    - maxDiffPixelRatio: 0.002 (0.2 %) — configurable globalement dans
      //      playwright.config.ts (expect.toHaveScreenshot).
      //    - animations: 'disabled' — neutralise les CSS animations.
      //    - caret: 'hide' — masque le caret texte.
      //    - stylePath: désactive les transitions CSS restantes.
      //    - fullPage: false — capture uniquement le viewport visible (plus
      //      stable qu'un full-page qui dépend du contenu below-the-fold).
      await expect(pwPage).toHaveScreenshot(`${page.name}.png`, {
        maxDiffPixelRatio: 0.002,
        animations: 'disabled',
        caret: 'hide',
        stylePath: STABILITY_CSS,
        fullPage: page.name === 'pricing',
      });
      if (page.name === 'pricing') {
        expect(
          await pwPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        ).toBe(true);
        await pwPage.getByRole('switch').click();
        await pwPage.getByLabel('Nombre d’établissements').selectOption('3');
        await expect(pwPage.getByText(/Total pour 3 établissements : 497 €\/mois/)).toBeVisible();
        await expect(
          pwPage.getByRole('link', { name: 'Choisir Multi-restaurant' }),
        ).toHaveAttribute('href', '/register?plan=multi-site&billing=monthly&sites=3');
      }
    });
  }
});
