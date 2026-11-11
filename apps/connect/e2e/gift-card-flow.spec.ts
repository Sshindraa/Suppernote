import { test, expect } from '@playwright/test';

/**
 * E2E — Flow d'achat de carte cadeau (/widget/[slug]/gift-card).
 *
 * Le widget de carte cadeau est sur /widget/[slug]/gift-card. Le flow :
 *   1. Étape "type" : choix du type de carte (montant libre, pack, cagnotte)
 *   2. Étape "info" : expéditeur, destinataire, message
 *   3. Étape "slots" (optionnel) : créneaux si "book now" activé
 *   4. Étape "template" : design de la carte
 *   5. Étape "payment" : paiement Stripe (non testé en E2E sans clé de test)
 *
 * On teste la navigation entre étapes et la validation des formulaires,
 * PAS le paiement final (Stripe nécessite une clé de test).
 *
 * Nécessite l'API + DB seedée. Skippée si l'API n'est pas disponible.
 */

const API_URL = process.env.API_URL || 'http://localhost:4000';
const RESTAURANT_SLUG = 'chez-suppernote-demo';

test.describe.configure({ mode: 'serial' });

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
  // tests.
  if (!apiAvailable && process.env.CI) {
    throw new Error(`API Suppernote indisponible sur ${API_URL} : le job CI doit la démarrer.`);
  }
});

test.beforeEach(() => {
  test.skip(!apiAvailable && !process.env.CI, `API Suppernote indisponible sur ${API_URL}`);
});

test.describe("Flow d'achat de carte cadeau", () => {
  test('le widget GiftCardPurchase se charge (étape type)', async ({ page }) => {
    const response = await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);
    expect(response?.status()).toBe(200);

    // Le nom du restaurant est affiché en H1 (mode non-embedded)
    const h1 = page.getByRole('heading', { level: 1 });
    await expect(h1).toBeVisible();
    await expect(h1).toContainText('Chez Suppernote');

    // L'étape 1 "Choisissez le type de carte" est visible
    await expect(page.getByRole('heading', { name: /choisissez le type de carte/i })).toBeVisible();

    // Les trois options de type sont présentes
    await expect(page.getByRole('button', { name: /montant libre/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /pack expérience/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /cagnotte collective/i })).toBeVisible();
  });

  test('sélectionne "montant libre" et saisit un montant', async ({ page }) => {
    await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);

    // Cliquer sur "Montant libre"
    await page.getByRole('button', { name: /montant libre/i }).click();

    // Le champ montant apparaît
    const amountInput = page.getByLabel(/montant/i);
    await expect(amountInput).toBeVisible();

    // Saisir un montant
    await amountInput.fill('50');

    // Vérifier que le bouton "Continuer" est présent
    await expect(page.getByRole('button', { name: /continuer/i })).toBeVisible();
  });

  test("passe à l'étape infos après validation du montant", async ({ page }) => {
    await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);

    // Sélectionner montant libre et saisir 50
    await page.getByRole('button', { name: /montant libre/i }).click();
    await page.getByLabel(/montant/i).fill('50');

    // Cliquer sur "Continuer"
    await page.getByRole('button', { name: /continuer/i }).click();

    // L'étape 2 "Informations" s'affiche
    await expect(page.getByRole('heading', { name: /informations/i })).toBeVisible();

    // Les champs expéditeur et destinataire sont présents
    // Les inputs ont des placeholders "Nom", "Email", "Téléphone"
    await expect(page.getByText('Expéditeur', { exact: true })).toBeVisible();
    await expect(page.getByText('Destinataire', { exact: true })).toBeVisible();
  });

  test('remplit les infos expéditeur et destinataire', async ({ page }) => {
    await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);

    // Étape type → montant libre → 50 → continuer
    await page.getByRole('button', { name: /montant libre/i }).click();
    await page.getByLabel(/montant/i).fill('50');
    await page.getByRole('button', { name: /continuer/i }).click();

    // Attendre l'étape infos
    await expect(page.getByRole('heading', { name: /informations/i })).toBeVisible();

    // Remplir l'expéditeur (placeholders: Nom, Email, Téléphone)
    const senderInputs = page.locator('input[placeholder="Nom"]');
    await senderInputs.first().fill('Jean Dupont');

    const emailInputs = page.locator('input[placeholder="Email"]');
    await emailInputs.first().fill('jean.dupont@example.com');

    const phoneInputs = page.locator('input[placeholder="Téléphone"]');
    await phoneInputs.first().fill('+33612345678');

    // Remplir le destinataire
    await senderInputs.nth(1).fill('Marie Martin');
    await emailInputs.nth(1).fill('marie.martin@example.com');

    // Le bouton "Continuer" de l'étape info est présent
    await expect(page.getByRole('button', { name: /continuer/i })).toBeVisible();
  });

  test('navigue entre étapes (back depuis infos vers type)', async ({ page }) => {
    await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);

    // Étape type → montant libre → 50 → continuer
    await page.getByRole('button', { name: /montant libre/i }).click();
    await page.getByLabel(/montant/i).fill('50');
    await page.getByRole('button', { name: /continuer/i }).click();

    // Vérifier qu'on est à l'étape infos
    await expect(page.getByRole('heading', { name: /informations/i })).toBeVisible();

    // Cliquer sur "Retour"
    await page.getByRole('button', { name: /retour/i }).click();

    // On revient à l'étape type
    await expect(page.getByRole('heading', { name: /choisissez le type de carte/i })).toBeVisible();
  });

  test('valide que le montant doit être supérieur à 0', async ({ page }) => {
    await page.goto(`/widget/${RESTAURANT_SLUG}/gift-card`);

    // Sélectionner montant libre sans saisir de montant
    await page.getByRole('button', { name: /montant libre/i }).click();

    // Cliquer sur "Continuer" sans montant
    await page.getByRole('button', { name: /continuer/i }).click();

    // Un message d'erreur doit s'afficher
    await expect(page.getByText(/le montant doit être supérieur à 0/i)).toBeVisible();

    // On doit rester à l'étape type
    await expect(page.getByRole('heading', { name: /choisissez le type de carte/i })).toBeVisible();
  });
});
