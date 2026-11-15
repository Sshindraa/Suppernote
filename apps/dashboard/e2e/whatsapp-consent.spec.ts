import { test, expect } from '@playwright/test';

test('WhatsApp choice and withdrawal are explicit and do not send provider traffic', async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL && !process.env.PLAYWRIGHT_BASE_URL.includes('localhost'),
    'Local mocked qualification only',
  );
  const date = new Date();
  date.setDate(date.getDate() + 2);
  const day = date.toISOString().slice(0, 10);
  await page.route('**/api/proxy/**', async (route) => {
    const url = route.request().url();
    let body: unknown;
    if (url.includes('/whatsapp-consent/withdraw')) {
      expect(new URL(url).pathname).toBe(
        '/api/proxy/public/r/restaurant-exemple/whatsapp-consent/withdraw',
      );
      expect(route.request().postDataJSON()).toMatchObject({
        reservationId: 'local-test-reservation',
      });
      body = { status: 'withdrawn' };
    } else if (url.includes('/availability')) {
      body = { restaurantId: 'local-test-restaurant', date: day, partySize: 2, slots: ['20:30'] };
    } else if (url.endsWith('/hold')) {
      body = { holdToken: crypto.randomUUID() };
    } else if (url.endsWith('/confirm')) {
      const request = route.request().postDataJSON();
      expect(request.whatsappReminderConsent).toEqual({
        accepted: true,
        version: 'whatsapp-reminder-2026-10-17',
      });
      body = {
        ...request,
        reservationId: 'local-test-reservation',
        status: 'CONFIRMED',
        whatsappWithdrawalToken: ['local', 'test', 'receipt'].join('-'),
      };
    } else {
      body = {
        id: 'local-test-restaurant',
        name: 'Restaurant Exemple',
        whatsappReminderOptInEnabled: true,
        openingHours: Object.fromEntries(
          ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((key) => [
            key,
            { open: '12:00', close: '23:00' },
          ]),
        ),
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });
  await page.goto(`/book/restaurant-exemple?date=${day}&time=20:30&partySize=2`);
  await page.getByRole('button', { name: /Continuer · 20h30/ }).click();
  const choice = page.getByRole('checkbox', { name: /J’accepte le rappel/ });
  await expect(choice).not.toBeChecked();
  await page.getByLabel('Nom complet *').fill('Exemple Test');
  await page.getByLabel('Téléphone *').fill('0600000000');
  await choice.check();
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((node) => node.clientWidth),
  );
  await page.screenshot({ path: testInfo.outputPath('whatsapp-choice.png'), fullPage: true });
  await page.getByRole('button', { name: 'Réserver ma table' }).click();
  await expect(page.getByText('Confirmée')).toBeVisible();
  await page.locator('summary').filter({ hasText: 'Modifier ou annuler' }).click();
  await page.getByText('Préférences de rappel').click();
  await expect(page.getByText('Rappel autorisé.')).toBeVisible();
  await page.getByRole('switch', { name: 'Rappel WhatsApp' }).click();
  await expect(
    page.getByText('Votre accord a été retiré. Un rappel déjà en cours peut encore arriver.'),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('whatsapp-withdrawn.png'), fullPage: true });
});
