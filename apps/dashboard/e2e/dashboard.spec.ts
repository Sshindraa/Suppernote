import { test, expect, type Page } from '@playwright/test';

/**
 * Garde-fou non-régression du dashboard Suppernote.
 *
 * Contexte : deux incidents client-visibles ont eu lieu en juillet 2026 :
 *  1. Un header analytics chevauchait les widgets à cause d'une règle CSS
 *     globale `header { position: fixed }` dans globals.css.
 *  2. Le dashboard affichait un état Error car toutes les requêtes API étaient
 *     rate-limitées comme venant de 127.0.0.1 (proxy Next.js).
 *
 * Ce test vérifie sur 3 viewports (iPhone 14, iPad Mini, desktop 1440px) que :
 *  - le header analytics ne chevauche pas les widgets (pas de position fixed) ;
 *  - aucun bandeau Error n'est visible ;
 *  - les KPIs et les graphiques s'affichent.
 *
 * En dev sans clé Clerk (middleware bypass), le dashboard utilise les données
 * de démo — aucune API n'est appelée, donc pas de risque de rate-limit 429.
 */

async function loadDashboard(page: Page) {
  await page.goto('/dashboard', { waitUntil: 'networkidle' });
  // Le skeleton de chargement disparaît quand les données de démo sont prêtes.
  await expect(page.getByRole('heading', { name: 'Pilotage' })).toBeVisible();
}

test.describe('Dashboard /dashboard — stabilité visuelle', () => {
  test.beforeEach(async ({ page }) => {
    await loadDashboard(page);
  });

  test('le header analytics ne chevauche pas les widgets', async ({ page }) => {
    // Le <header> de la page dashboard contient le titre "Pilotage".
    // L'incident venait d'une règle `header { position: fixed }` qui
    // le sortait du flux et le superposait aux KPIs.
    const header = page.locator('header', { hasText: 'Pilotage' });
    await expect(header).toBeVisible();

    // Le header ne doit PAS être en position fixed/absolute (sinon chevauchement).
    const position = await header.evaluate((el) => window.getComputedStyle(el).position);
    expect(position).not.toBe('fixed');
    expect(position).not.toBe('absolute');

    // La première carte KPI doit commencer sous le bas du header.
    const headerBox = await header.boundingBox();
    expect(headerBox).not.toBeNull();

    const firstWidget = page.getByRole('article', { name: 'Indicateur Réservations', exact: true });
    await expect(firstWidget).toBeVisible();
    const widgetBox = await firstWidget.boundingBox();
    expect(widgetBox).not.toBeNull();

    // Le haut du widget doit être >= au bas du header (pas de chevauchement).
    expect(widgetBox!.y).toBeGreaterThanOrEqual(headerBox!.y + headerBox!.height - 1);
  });

  test("aucun bandeau Error n'est visible", async ({ page }) => {
    // L'ErrorState affiche un bouton "Réessayer" et un message d'erreur.
    // En mode démo (sans Clerk), aucune requête API n'échoue → pas d'erreur.
    await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
    await expect(page.getByText(/Impossible de charger les analytics/)).toHaveCount(0);
  });

  test("les KPIs et graphiques s'affichent", async ({ page }) => {
    // KPIs — labels des cartes KpiCard (exact pour éviter les matches multiples
    // avec d'autres textes comme "des appels reçus").
    await expect(
      page.getByRole('article', { name: 'Indicateur Réservations', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: 'Indicateur Couverts', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('article', { name: 'Indicateur CA estimé', exact: true }),
    ).toBeVisible();

    const phoneReservations = page.getByRole('article', {
      name: 'Indicateur Réservations téléphone',
      exact: true,
    });
    await expect(phoneReservations).toContainText('50');
    await expect(phoneReservations).toContainText('140 appels reçus');
    await expect(page.getByText('Conversion appels', { exact: true })).toHaveCount(0);

    // Graphiques — DashboardCharts (dynamic import recharts).
    // Les titres des cartes graphique sont rendus une fois recharts hydraté.
    await expect(page.getByRole('heading', { name: 'Réservations et couverts' })).toBeVisible();

    // recharts rend un <svg class="recharts-surface"> — preuve que le graphique
    // est effectivement dessiné (pas juste le conteneur vide).
    await expect(page.locator('.recharts-surface').first()).toBeVisible();
  });

  test('les définitions s’ouvrent depuis le chiffre concerné au clavier', async ({ page }) => {
    const help = page.getByRole('button', { name: 'Comprendre CA estimé', exact: true });
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await help.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'CA estimé', exact: true });
    await expect(dialog.getByText(/ne mesure ni les encaissements/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(help).toBeFocused();
  });

  test('la période ne présente qu’une seule synthèse chiffrée', async ({ page }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), 'Valeurs de démonstration locale.');
    await expect(
      page.getByRole('region', { name: 'Indicateurs clés' }).getByRole('article'),
    ).toHaveCount(4);
    await expect(page.getByRole('region', { name: 'Activité Suppernote' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Analyser l’impact' })).toHaveCount(0);
    if (page.viewportSize()!.width < 640) {
      await page.getByRole('combobox', { name: 'Période d’analyse' }).selectOption('30d');
    } else {
      await page.getByRole('button', { name: '30 jours', exact: true }).click();
    }
    await expect(
      page.getByRole('article', { name: 'Indicateur Réservations', exact: true }),
    ).toContainText('301');
  });

  test('le graphique est dominant et précède les canaux sur petit écran', async ({ page }) => {
    const chart = page
      .getByRole('heading', { name: 'Réservations et couverts' })
      .locator('..')
      .locator('..');
    const channels = page.getByRole('region', { name: 'Réservations par canal', exact: true });
    await expect(chart).toBeVisible();
    const chartBox = (await chart.boundingBox())!;
    const channelBox = (await channels.boundingBox())!;
    if (page.viewportSize()!.width >= 1280) {
      expect(chartBox.width).toBeGreaterThan(channelBox.width);
    } else {
      expect(chartBox.y).toBeLessThan(channelBox.y);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
  });
});

const isRemoteTarget = Boolean(process.env.PLAYWRIGHT_BASE_URL);

test.describe('Espace administration Suppernote — preview local', () => {
  test.skip(isRemoteTarget, 'Le mock API ne crée pas de session Clerk sur un serveur distant.');
  async function mockOperatorAccess(page: Page, allowed: boolean) {
    await page.route('**/api/proxy/admin/access', async (route) => {
      if (allowed) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ allowed: true }),
        });
        return;
      }

      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Suppernote operator access required' }),
      });
    });
  }

  async function mockOperatorOverview(page: Page) {
    await page.route('**/api/proxy/admin/provisioning/restaurants', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ count: 0, restaurants: [] }),
      }),
    );
    await page.route('**/api/proxy/admin/demo-requests/summary', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ byStatus: { NEW: 2 }, notificationUnconfirmed: 1 }),
      }),
    );
    await page.route('**/api/proxy/admin/onboarding-funnel/cohort', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ funnel: { timeToFirstReservation: { pending: 1 } } }),
      }),
    );
    await page.route('**/api/proxy/admin/usage/margin**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rows: [{ unpricedEventCount: 3 }] }),
      }),
    );
  }

  test('ouvre un shell séparé sans contexte restaurant', async ({ page }) => {
    await mockOperatorAccess(page, true);
    await mockOperatorOverview(page);
    await page.goto('/admin', { waitUntil: 'networkidle' });

    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole('heading', { name: 'Espace administration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Vue générale' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'À traiter' })).toBeVisible();
    await expect(page.locator('main a[href="/admin/demo-requests"]')).toBeVisible();
    await expect(page.locator('main a[href="/admin/onboarding"]')).toBeVisible();
    await expect(page.locator('main a[href="/admin/margin"]')).toBeVisible();
    await expect(page.getByText('Chez Suppernote HQ')).toHaveCount(0);
  });

  test('redirige une ancienne URL opérateur vers le nouvel espace', async ({ page }) => {
    await mockOperatorAccess(page, true);
    await page.goto('/dashboard/admin/margin', { waitUntil: 'networkidle' });

    await expect(page).toHaveURL(/\/admin\/margin$/);
    await expect(page.getByRole('heading', { name: 'Espace administration' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Coût opérationnel' })).toBeVisible();
  });

  test('renvoie un compte restaurant vers son dashboard', async ({ page }) => {
    await mockOperatorAccess(page, false);
    await page.goto('/admin', { waitUntil: 'domcontentloaded' });

    await page.waitForURL('**/dashboard', { timeout: 15_000 });
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(page.getByRole('heading', { name: 'Pilotage' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin Suppernote' })).toHaveCount(0);
  });
});

test.describe('Accès opérateur distant sans session', () => {
  test.skip(!isRemoteTarget, 'Ce contrôle exige le middleware Clerk réellement déployé.');

  for (const path of ['/admin', '/admin/provisioning', '/dashboard/admin/margin']) {
    test(`protège ${path} malgré un faux résultat API côté navigateur`, async ({ page }) => {
      await page.route('**/api/proxy/admin/access', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ allowed: true }),
        }),
      );
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(/\/login(?:\?|$)/);
      await expect(page.getByRole('heading', { name: 'Ravis de vous revoir' })).toBeVisible();
      await expect(
        page.getByRole('textbox', { name: 'Adresse e-mail', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Espace administration' })).toHaveCount(0);
    });
  }
});
