import { test, expect, type Page } from '@playwright/test';
import {
  CHANGED_PARTY_SIZE,
  DEFAULT_PARTY_SIZE,
  FIRST_PARTY_SIZE,
  loadAvailability,
  noOpenDayError,
  noScenarioError,
  pickFirstOpenDay,
  pickScenario,
  restaurantNow,
  timeLabel,
  upcomingDays,
  type BookingScenario,
} from './support/widget-scenario';

const RESTAURANT_SLUG = 'chez-suppernote-demo';
// Staging : vraie API, restaurant fermé dimanche et lundi, créneaux passés retirés.
const AGAINST_REAL_API = Boolean(process.env.PLAYWRIGHT_BASE_URL);

const DEMO_RESTAURANT = {
  id: 'e2e-demo-restaurant',
  name: 'Chez Suppernote',
  openingHours: {
    sun: { open: '12:00', close: '22:00' },
    mon: { open: '12:00', close: '22:00' },
    tue: { open: '12:00', close: '22:00' },
    wed: { open: '12:00', close: '22:00' },
    thu: { open: '12:00', close: '22:00' },
    fri: { open: '12:00', close: '23:00' },
    sat: { open: '12:00', close: '23:00' },
  },
  city: 'Lyon',
  cuisine: 'Bistrot',
  address: '12 Rue de la République, 69001 Lyon',
  giftCardEnabled: true,
};

async function mockDemoApi(page: Page, partySize = 2, slots = ['12:00', '19:00']): Promise<void> {
  // The CI dashboard server has no API process. Keep this proof deterministic
  // while staging runs against the real API through the same page proxy.
  if (AGAINST_REAL_API) return;

  await page.route('**/api/proxy/public/widget/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(DEMO_RESTAURANT),
    });
  });

  await page.route('**/api/proxy/restaurants/*/availability**', async (route) => {
    const requestUrl = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        restaurantId: DEMO_RESTAURANT.id,
        date: requestUrl.searchParams.get('date') ?? new Date().toISOString().slice(0, 10),
        partySize,
        slots,
      }),
    });
  });
}

async function revealSlotService(page: Page, slot: string): Promise<void> {
  await expect(page.getByRole('group', { name: 'Créneaux horaires' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const hour = Number(slot.split(/[h:]/)[0]);
  const service = hour >= 18 ? 'Dîner' : hour >= 11 && hour < 15 ? 'Déjeuner' : 'Autres horaires';
  const serviceButton = page.getByRole('button', { name: service, exact: true });
  // A single service has a plain label rather than a service switch.
  if (await serviceButton.count()) await serviceButton.click();
}

/**
 * Mocks : aujourd'hui puis demain à 20:30, comme avant. Vraie API : la date et les créneaux sont
 * choisis parmi ses disponibilités, et le test échoue avec un message explicite s'il n'y en a pas.
 */
async function bookingScenario(page: Page): Promise<BookingScenario> {
  if (!AGAINST_REAL_API) {
    const [today, tomorrow] = await upcomingDays(page, 2);
    return {
      firstDate: today.param,
      firstTime: '20:30',
      secondDate: tomorrow.param,
      secondLabel: tomorrow.label,
      secondTime: '20:30',
    };
  }
  const now = await restaurantNow(page);
  const days = await loadAvailability(
    page,
    RESTAURANT_SLUG,
    [FIRST_PARTY_SIZE, CHANGED_PARTY_SIZE],
    (loaded) => pickScenario(loaded, now) !== null,
  );
  const scenario = pickScenario(days, now);
  if (!scenario) throw noScenarioError(RESTAURANT_SLUG, days, now);
  return scenario;
}

test.describe('Widget réservation public', () => {
  // Preuve d'indépendance au jour et à l'heure : E2E_FAKE_NOW (ISO) règle l'horloge du navigateur,
  // par exemple un lundi ou un mardi à 21:10. L'horloge de l'API se règle côté serveur.
  test.beforeEach(async ({ page }) => {
    if (process.env.E2E_FAKE_NOW)
      await page.clock.install({ time: new Date(process.env.E2E_FAKE_NOW) });
  });

  test('reprend depuis /book la date, le groupe et le créneau vérifié', async ({ page }) => {
    test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), 'Scénario déterministe local uniquement');
    await mockDemoApi(page, 4, ['20:00', '20:30']);
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    await page.goto(
      `/book/${RESTAURANT_SLUG}?source=restaurant&date=${date}&time=20:30&partySize=4`,
      { waitUntil: 'domcontentloaded' },
    );

    await expect(page.getByText('Chez Suppernote').first()).toBeVisible();
    await expect(page.getByRole('button', { name: '4 personnes' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: 'Choisir le créneau 20h30' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('button', { name: /Continuer · 20h30/ })).toBeVisible();
  });

  test('charge le widget et ses disponibilités sans erreur', async ({ page }) => {
    await mockDemoApi(page);
    // Le widget charge des visuels distants ; attendre `networkidle` rend le
    // smoke flaky sur le runner CI lorsque ces images restent en vol. Les
    // assertions ci-dessous attendent les données et l'interface utile.
    await page.goto(`/widget/${RESTAURANT_SLUG}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByText('Chez Suppernote').first()).toBeVisible();
    await expect(page.getByText('Nombre de personnes')).toBeVisible();
    await expect(page.getByText('Sélectionner la date')).toBeVisible();
    await expect(page.getByText('Créneau horaire')).toBeVisible();

    // Les états « aucun service », « complet » et les créneaux sont légitimes
    // selon le jour. Une erreur d'appel API ne l'est pas.
    await expect(page.getByText('Disponibilités indisponibles.')).toHaveCount(0);
    await expect(
      page.getByText(/Aucun service ce jour-là|Complet ce jour-là|Déjeuner|Dîner/).first(),
    ).toBeVisible();

    // Mocks : tous les jours sont ouverts avec 12:00 et 19:00. Vraie API : le jour et le créneau
    // viennent de ses disponibilités, car aujourd'hui peut être fermé ou déjà passé.
    let openDate = page.getByRole('button', { name: /\bouvert$/i }).first();
    let expectedSlot = '12h00';
    if (AGAINST_REAL_API) {
      const now = await restaurantNow(page);
      const days = await loadAvailability(
        page,
        RESTAURANT_SLUG,
        [DEFAULT_PARTY_SIZE],
        (loaded) => pickFirstOpenDay(loaded, now) !== null,
      );
      const target = pickFirstOpenDay(days, now);
      if (!target) throw noOpenDayError(RESTAURANT_SLUG, days, now);
      openDate = page.getByRole('button', { name: new RegExp(`${target.label} ouvert`, 'i') });
      expectedSlot = timeLabel(target.time);
    }
    await expect(openDate).toBeVisible();
    await openDate.click();
    await revealSlotService(page, expectedSlot);
    await expect(
      page.getByRole('button', { name: `Choisir le créneau ${expectedSlot}` }),
    ).toBeVisible();
  });

  test('préserve les coordonnées au retour et confirme après le succès API', async ({ page }) => {
    let reservationPayload: Record<string, unknown> | undefined;
    let holdPayload: Record<string, unknown> | undefined;
    const holdToken = crypto.randomUUID();
    await page.route('**/api/proxy/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() === 'POST' && url.pathname.endsWith('/hold')) {
        holdPayload = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ holdToken }),
        });
        return;
      }
      if (request.method() === 'POST' && url.pathname.endsWith('/confirm')) {
        reservationPayload = request.postDataJSON() as Record<string, unknown>;
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            reservationId: 'e2e-confirmed-reservation',
            status: 'CONFIRMED',
          }),
        });
        return;
      }
      await route.fallback();
    });
    await mockDemoApi(page, CHANGED_PARTY_SIZE, ['20:00', '20:30']);

    const scenario = await bookingScenario(page);
    const date = scenario.firstDate;
    const firstSlot = timeLabel(scenario.firstTime);
    const secondSlot = timeLabel(scenario.secondTime);
    const secondDateParam = scenario.secondDate;
    const secondLabel = scenario.secondLabel;

    await page.goto(
      `/book/${RESTAURANT_SLUG}?source=restaurant&date=${date}&time=${scenario.firstTime}&partySize=${FIRST_PARTY_SIZE}`,
      { waitUntil: 'domcontentloaded' },
    );
    await expect(page.getByRole('button', { name: `Continuer · ${firstSlot}` })).toBeVisible();
    await page.getByRole('button', { name: `Continuer · ${firstSlot}` }).click();

    const customerName = page.getByLabel('Nom complet *');
    const customerPhone = page.getByLabel('Téléphone *');
    await customerName.fill('Alice Martin');
    await customerPhone.fill('0600000000');
    await page.getByRole('button', { name: 'Retour aux créneaux' }).click();

    const groupAvailability = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/availability') &&
        url.searchParams.get('date') === date &&
        url.searchParams.get('partySize') === String(CHANGED_PARTY_SIZE)
      );
    });
    await page.getByRole('button', { name: `${CHANGED_PARTY_SIZE} personnes` }).click();
    await (await groupAvailability).finished();
    await revealSlotService(page, firstSlot);
    const slotAfterGroupChange = page.getByRole('button', {
      name: `Choisir le créneau ${firstSlot}`,
    });
    await expect(slotAfterGroupChange).toHaveAttribute('aria-pressed', 'false');
    const secondDate = page.getByRole('button', {
      name: new RegExp(`${secondLabel} ouvert`, 'i'),
    });
    const secondAvailability = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname.endsWith('/availability') &&
        url.searchParams.get('date') === secondDateParam &&
        url.searchParams.get('partySize') === String(CHANGED_PARTY_SIZE)
      );
    });
    await secondDate.click();
    await (await secondAvailability).finished();
    await revealSlotService(page, secondSlot);
    const verifiedSecondSlot = page.getByRole('button', {
      name: `Choisir le créneau ${secondSlot}`,
    });
    await expect(verifiedSecondSlot).toBeVisible();
    await expect(verifiedSecondSlot).toHaveAttribute('aria-pressed', 'false');
    await verifiedSecondSlot.click();
    await page.getByRole('button', { name: `Continuer · ${secondSlot}` }).click();

    await expect(customerName).toHaveValue('Alice Martin');
    await expect(customerPhone).toHaveValue('0600000000');
    await page.getByRole('button', { name: 'Valider la réservation' }).click();
    await expect(page.getByText('Confirmée', { exact: true })).toBeVisible();
    expect(holdPayload).toMatchObject({
      date: secondDateParam,
      time: scenario.secondTime,
      partySize: CHANGED_PARTY_SIZE,
    });
    expect(reservationPayload).toMatchObject({
      holdToken,
      customer: { firstName: 'Alice Martin', phone: '+33600000000' },
    });
  });
});
