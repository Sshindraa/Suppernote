import { test, expect } from '@playwright/test';

/**
 * E2E — Page restaurant publique (/restaurant/[slug]).
 *
 * Test la page la plus simple de Connect : la fiche restaurant publique.
 * Vérifie que la page charge, que le nom du restaurant s'affiche, que les
 * informations pratiques (adresse, téléphone) sont présentes, et que le CTA
 * "Réserver une table" est visible.
 *
 * Nécessite l'API Fastify (localhost:4000 en dev, 4100 en staging) + DB seedée
 * avec le restaurant de démo "chez-suppernote-demo".
 * Si l'API n'est pas disponible, la suite est skippée (non bloquant pour un job
 * CI sans infra) plutôt que marquée en échec.
 */

const API_URL = process.env.API_URL || 'http://localhost:4000';
const RESTAURANT_SLUG = 'chez-suppernote-demo';

let apiAvailable = false;
test.beforeAll(async () => {
  try {
    const res = await fetch(`${API_URL}/health`);
    apiAvailable = res.ok;
  } catch {
    apiAvailable = false;
  }

  // En CI, l'API et la base seedée sont fournies par le job : une API
  // injoignable est une panne d'infrastructure, pas une raison de sauter les
  // tests. Le skip silencieux masquerait une régression du parcours public.
  if (!apiAvailable && process.env.CI) {
    throw new Error(`API Suppernote indisponible sur ${API_URL} : le job CI doit la démarrer.`);
  }
});

test.beforeEach(() => {
  test.skip(!apiAvailable && !process.env.CI, `API Suppernote indisponible sur ${API_URL}`);
});

test.describe('Page restaurant publique', () => {
  test('charge la page et affiche le nom du restaurant', async ({ page }) => {
    const response = await page.goto(`/restaurant/${RESTAURANT_SLUG}`);
    expect(response?.status()).toBe(200);

    // Le H1 contient le nom du restaurant
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('Chez Suppernote');
  });

  test('affiche le CTA "Réserver une table"', async ({ page }) => {
    await page.goto(`/restaurant/${RESTAURANT_SLUG}`);

    const cta = page.getByRole('link', { name: /réserver une table/i });
    await expect(cta).toBeVisible();
  });

  test('affiche les informations du restaurant (adresse et téléphone)', async ({ page }) => {
    await page.goto(`/restaurant/${RESTAURANT_SLUG}`);

    // Section "Informations"
    const infoHeading = page.getByRole('heading', { name: /informations/i });
    await expect(infoHeading).toBeVisible();

    // L'adresse est un lien vers Google Maps
    const addressLink = page.getByRole('link', { name: /maps/i });
    // L'adresse contient au moins un lien dans la section informations
    // On vérifie que le label "Adresse" est présent
    await expect(page.getByText('Adresse')).toBeVisible();
    // Le téléphone est un lien tel:
    await expect(page.getByText('Téléphone')).toBeVisible();
  });

  test('affiche la section disponibilités ou horaires', async ({ page }) => {
    await page.goto(`/restaurant/${RESTAURANT_SLUG}`);

    // La page affiche soit "Disponibilités aujourd'hui" soit "Horaires"
    const availHeading = page.getByRole('heading', { name: /disponibilités aujourd/i });
    const hoursHeading = page.getByRole('heading', { name: /horaires/i });

    // Au moins une des deux sections doit être présente
    const availVisible = await availHeading.isVisible().catch(() => false);
    const hoursVisible = await hoursHeading.isVisible().catch(() => false);
    expect(availVisible || hoursVisible).toBeTruthy();
  });

  test('affiche le widget de réservation (aperçu inline ou lien)', async ({ page }) => {
    await page.goto(`/restaurant/${RESTAURANT_SLUG}`);

    // La page contient un lien vers le widget de réservation
    // Soit "Voir tous les créneaux" soit "Vérifier un autre jour" soit "Réserver une table"
    const bookingLink = page.getByRole('link', {
      name: /voir tous les créneaux|vérifier un autre jour|réserver une table/i,
    });
    await expect(bookingLink.first()).toBeVisible();
  });
});
