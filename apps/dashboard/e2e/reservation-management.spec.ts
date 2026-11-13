import { test, expect } from '@playwright/test';

test('local fictional preview is interactive without requesting booking data', async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.CI,
    'The fictional preview is intentionally absent from production builds',
  );
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Development preview only',
  );
  let apiCalls = 0;
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('request', (request) => {
    if (request.url().includes('/api/reservation-management')) apiCalls++;
  });
  await page.goto('/r/demo');
  await expect(page.getByText('Restaurant Exemple')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Modifier ou annuler' })).toBeHidden();
  await expect(page.locator('summary').filter({ hasText: /^Modifier ou annuler$/ })).toBeVisible();
  await expect(page.getByText('Aperçu de démonstration')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Appeler le restaurant', includeHidden: true }),
  ).toBeDisabled();
  await expect(page.getByRole('switch')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Ajouter au calendrier' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Itinéraire' })).toBeDisabled();
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((node) => node.clientWidth),
  );
  expect(await page.locator('body').evaluate((node) => node.scrollHeight)).toBeLessThanOrEqual(
    page.viewportSize()!.height,
  );
  await page.screenshot({ path: testInfo.outputPath('reservation-demo.png'), fullPage: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.classList.remove('light', 'dark');
      document.documentElement.classList.add(theme);
    }, theme);
    await expect(page.locator('body')).toHaveJSProperty(
      'scrollWidth',
      await page.locator('body').evaluate((node) => node.clientWidth),
    );
    await page.screenshot({
      path: testInfo.outputPath(`reservation-${theme}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page
    .locator('summary')
    .filter({ hasText: /^Modifier ou annuler$/ })
    .click();
  await page.getByText('Préférences de rappel', { exact: true }).click();
  await expect(page.getByRole('switch')).toBeChecked();
  await page.getByRole('switch').click();
  await expect(page.getByRole('switch')).not.toBeChecked();
  await expect(page.getByText(/Votre accord a été retiré/)).toBeVisible();
  expect(apiCalls).toBe(0);
  expect(pageErrors).toEqual([]);
  await page.getByText('Préférences de rappel', { exact: true }).click();
  await expect(page.getByRole('switch')).toBeHidden();
  await page
    .locator('summary')
    .filter({ hasText: /^Modifier ou annuler$/ })
    .click();
  if (testInfo.project.name === 'desktop-1440') {
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 320, height: 568 },
      { width: 1280, height: 720 },
    ]) {
      await page.setViewportSize(viewport);
      await expect
        .poll(() => page.locator('body').evaluate((node) => node.scrollHeight))
        .toBeLessThanOrEqual(viewport.height);
      await expect
        .poll(() => page.locator('body').evaluate((node) => node.scrollWidth))
        .toBeLessThanOrEqual(viewport.width);
    }
  }
});

test('personal booking link survives reload and withdrawal is explicit', async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Local mocked qualification only',
  );
  const token = `${'a'.repeat(27)}.${'b'.repeat(43)}`;
  let enabled = true;
  let withdrawals = 0;
  await page.route('**/api/reservation-management', async (route) => {
    const body = route.request().postDataJSON();
    expect(body.token).toBe(token);
    expect(new URL(route.request().url()).search).toBe('');
    if (body.action === 'withdraw_whatsapp') {
      enabled = false;
      withdrawals++;
    }
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        restaurantName: 'Restaurant Exemple',
        restaurantPhone: '+33100000000',
        restaurantAddress: '12 rue de la Table, 75002 Paris',
        startsAt: '2026-10-18T17:00:00Z',
        endsAt: '2026-10-18T19:00:00Z',
        date: '2026-10-18',
        time: '19:00',
        partySize: 2,
        state: 'CONFIRMED',
        whatsappReminder: { visible: true, enabled },
      }),
    });
  });
  await page.goto(`/r#${token}`);
  await expect(page.getByText('12 rue de la Table, 75002 Paris')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Itinéraire' })).toHaveAttribute(
    'href',
    /destination=Restaurant%20Exemple/,
  );
  await expect(
    page.getByRole('link', { name: 'Modifier ou annuler', exact: true, includeHidden: true }),
  ).toHaveAttribute('href', 'tel:+33100000000');
  await expect(
    page.getByRole('link', { name: 'Appeler le restaurant', includeHidden: true }),
  ).toHaveAttribute('href', 'tel:+33100000000');
  const calendarButton = page.getByRole('button', { name: 'Ajouter au calendrier' });
  const directions = page.getByRole('link', { name: 'Itinéraire' });
  const manage = page.getByRole('link', {
    name: 'Modifier ou annuler',
    exact: true,
    includeHidden: true,
  });
  const phone = page.getByRole('link', { name: 'Appeler le restaurant', includeHidden: true });
  const management = page.locator('summary').filter({ hasText: /^Modifier ou annuler$/ });
  const preferences = page.locator('summary').filter({ hasText: 'Préférences de rappel' });
  for (const action of [directions]) {
    await expect(action).toHaveCSS('color', 'rgb(245, 245, 245)');
    await expect(action).toHaveCSS('opacity', '1');
    expect((await action.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await page.keyboard.press('Tab');
  await expect(calendarButton).toBeFocused();
  const downloadPromise = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const calendar = Buffer.concat(chunks).toString('utf8');
  expect(calendar).toContain('DTSTART:20261018T170000Z');
  expect(calendar).toContain('DTEND:20261018T190000Z');
  expect(calendar).toContain('LOCATION:12 rue de la Table\\, 75002 Paris');
  expect(calendar).not.toContain(token);
  await page.keyboard.press('Tab');
  await expect(directions).toBeFocused();
  expect(await directions.evaluate((n) => n.matches(':focus-visible'))).toBe(true);
  expect(await directions.evaluate((n) => getComputedStyle(n).boxShadow)).not.toBe('none');
  await page.screenshot({ path: testInfo.outputPath('keyboard-directions.png'), fullPage: true });
  // Verify the external navigation without contacting a real mapping service.
  await page.context().route('https://www.google.com/maps/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<title>Itinéraire de test</title>',
    }),
  );
  const popupPromise = page.waitForEvent('popup');
  await page.keyboard.press('Enter');
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/google\.com\/maps\/dir\//);
  await popup.close();
  await page.bringToFront();
  await page.keyboard.press('Tab');
  await expect(management).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  await expect(manage).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(phone).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(preferences).toBeFocused();
  await expect(preferences).toHaveCSS('outline-style', 'solid');
  await expect(preferences).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('switch')).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('switch')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(page.getByRole('switch')).toBeHidden();
  await page.keyboard.press('Shift+Tab');
  await expect(phone).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(manage).toBeFocused();
  await expect(manage).toHaveCSS('outline-style', 'solid');
  await expect(manage).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Tab');
  await expect(phone).toBeFocused();
  await expect(phone).toHaveCSS('color', 'rgb(245, 245, 245)');
  await expect(phone).toHaveCSS('opacity', '1');
  if (testInfo.project.name === 'desktop-1440') {
    for (const action of [calendarButton, directions, phone]) {
      const property = 'textDecorationColor';
      const initial = await action.evaluate(
        (n, property) => getComputedStyle(n)[property],
        property,
      );
      await action.hover();
      await expect
        .poll(() => action.evaluate((n, property) => getComputedStyle(n)[property], property))
        .not.toBe(initial);
      await page.screenshot({
        path: testInfo.outputPath(`hover-${await action.innerText()}.png`),
        fullPage: true,
      });
      await page.mouse.move(0, 0);
      await expect
        .poll(() => action.evaluate((n, property) => getComputedStyle(n)[property], property))
        .toBe(initial);
    }
  }
  await expect(page.getByRole('heading', { name: 'Ma réservation' })).toBeAttached();
  await expect(page.getByText('Restaurant Exemple')).toBeVisible();
  await page.getByText('Préférences de rappel', { exact: true }).click();
  await expect(page.getByRole('switch')).toBeChecked();
  expect(withdrawals).toBe(0);
  await page.reload();
  await expect(page.getByText('Restaurant Exemple')).toBeVisible();
  await management.click();
  await page.getByText('Préférences de rappel', { exact: true }).click();
  expect(withdrawals).toBe(0);
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((node) => node.clientWidth),
  );
  await page.screenshot({ path: testInfo.outputPath('my-reservation.png'), fullPage: true });
  await page.getByRole('switch').click();
  await expect(page.getByText(/Votre accord a été retiré/)).toBeVisible();
  expect(withdrawals).toBe(1);
  await page.reload();
  await management.click();
  await page.getByText('Préférences de rappel', { exact: true }).click();
  await expect(page.getByRole('switch')).not.toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath('my-reservation-withdrawn.png'),
    fullPage: true,
  });
});

test('long restaurant name wraps without overlapping booking details or actions', async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Local mocked qualification only',
  );
  const name = 'La Grande Maison des Saveurs de Provence';
  await page.route('**/api/reservation-management', async (route) => {
    await route.fulfill({
      json: {
        restaurantName: name,
        restaurantPhone: '+33100000000',
        restaurantAddress: '12 rue de la Table, 75002 Paris',
        startsAt: '2026-10-18T17:00:00Z',
        date: '2026-10-18',
        time: '19:00',
        partySize: 2,
        state: 'CONFIRMED',
        whatsappReminder: { visible: true, enabled: true },
      },
    });
  });
  await page.goto(`/r#${'a'.repeat(27)}.${'b'.repeat(43)}`);
  const title = page.getByRole('heading', { name });
  await expect(title).toBeVisible();
  const viewports =
    testInfo.project.name === 'desktop-1440'
      ? [page.viewportSize()!, { width: 320, height: 568 }]
      : [page.viewportSize()!];
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await expect
      .poll(() => page.locator('body').evaluate((n) => n.scrollWidth))
      .toBeLessThanOrEqual(viewport.width);
    const titleBounds = await title.boundingBox();
    const addressBounds = await page.getByText('12 rue de la Table, 75002 Paris').boundingBox();
    expect(addressBounds!.y).toBeGreaterThan(titleBounds!.y + titleBounds!.height);
    const lines = await title.evaluate(
      (n) => n.getBoundingClientRect().height / parseFloat(getComputedStyle(n).lineHeight),
    );
    expect(lines).toBeGreaterThanOrEqual(1.9);
    expect(lines).toBeLessThanOrEqual(3.1);
    await expect(page.getByRole('button', { name: 'Ajouter au calendrier' })).toBeVisible();
    await expect(
      page.locator('summary').filter({ hasText: /^Modifier ou annuler$/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`long-name-${viewport.width}.png`),
      fullPage: true,
    });
  }
});

test('cancellation requires a second deliberate action and survives reload', async ({ page }) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Local mocked qualification only',
  );
  let cancelled = false;
  let writes = 0;
  await page.route('**/api/reservation-management', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'cancel') {
      expect(body.confirmed).toBe(true);
      expect(body.confirmationToken).toBe('offer');
      writes++;
      cancelled = true;
    }
    await route.fulfill({
      json: {
        restaurantName: 'Le Très Long Nom du Restaurant et de sa Belle Terrasse',
        restaurantPhone: '+33100000000',
        date: '2026-10-20',
        time: '19:30',
        partySize: 2,
        startsAt: '2026-10-20T17:30:00Z',
        endsAt: null,
        state: cancelled ? 'CANCELLED' : 'CONFIRMED',
        whatsappReminder: { visible: false, enabled: false },
        cancellation: {
          available: !cancelled,
          deadline: '2026-10-19T17:30:00Z',
          confirmationToken: 'offer',
          terms: 'Annulation gratuite jusqu’à 24 heures avant le service.',
          message: 'Après cette limite, veuillez contacter le restaurant.',
        },
      },
    });
  });
  await page.goto(`/r#${'a'.repeat(27)}.${'b'.repeat(43)}`);
  await page
    .locator('summary')
    .filter({ hasText: /^Modifier ou annuler$/ })
    .click();
  await page.getByRole('button', { name: 'Annuler la réservation' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(writes).toBe(0);
  await expect(dialog).toContainText('24 heures');
  await page.getByRole('button', { name: 'Conserver ma réservation' }).click();
  expect(writes).toBe(0);
  await page.getByRole('button', { name: 'Annuler la réservation' }).click();
  await expect(dialog).toBeInViewport();
  await expect(page.locator('body')).toHaveJSProperty(
    'scrollWidth',
    await page.locator('body').evaluate((node) => node.clientWidth),
  );
  await page.getByRole('button', { name: 'Confirmer l’annulation' }).click();
  await expect(page.getByRole('status')).toHaveText('Annulée');
  expect(writes).toBe(1);
  await page.reload();
  await expect(page.getByRole('status')).toHaveText('Annulée');
  expect(writes).toBe(1);
  await expect(page.getByRole('button', { name: 'Ajouter au calendrier' })).toHaveCount(0);
});

test('personal modification keeps the current carton through selection and review', async ({
  page,
}, testInfo) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Local mocked qualification only',
  );
  let modifications = 0;
  let time = '19:30';
  let partySize = 2;
  await page.route('**/api/reservation-management', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'modification_options') {
      return route.fulfill({
        json: {
          date: '2026-10-20',
          partySize: body.partySize,
          maxPartySize: 7,
          slots: [
            { time: '20:00', proposalToken: `offer-${body.partySize}` },
            { time: '21:00', proposalToken: `late-${body.partySize}` },
          ],
          message: 'Votre réservation actuelle est conservée.',
        },
      });
    }
    if (body.action === 'modify') {
      expect(body.confirmed).toBe(true);
      expect(body.proposalToken).toBe('offer-3');
      modifications++;
      time = '20:00';
      partySize = 3;
    }
    await route.fulfill({
      json: {
        restaurantName: 'La Très Belle Table du Restaurant et de sa Terrasse',
        restaurantPhone: '+33100000000',
        date: '2026-10-20',
        time,
        partySize,
        state: 'CONFIRMED',
        whatsappReminder: { visible: false, enabled: false },
        modification: { available: true, message: 'Conservée' },
      },
    });
  });
  await page.goto(`/r#${'a'.repeat(27)}.${'b'.repeat(43)}`);
  await page
    .locator('summary')
    .filter({ hasText: /^Modifier ou annuler$/ })
    .click();
  await page.getByRole('button', { name: 'Modifier la réservation', exact: true }).click();
  const refreshedOptions = page.waitForResponse((response) => {
    if (
      !response.url().includes('/api/reservation-management') ||
      response.request().method() !== 'POST'
    )
      return false;
    const body = response.request().postDataJSON();
    return body.action === 'modification_options' && body.partySize === 3;
  });
  await page.getByRole('button', { name: '3 personnes', exact: true }).click();
  await (await refreshedOptions).finished();
  await expect(page.getByRole('group', { name: 'Créneaux horaires' })).toHaveAttribute(
    'aria-busy',
    'false',
  );
  const early = page.getByRole('button', { name: 'Choisir le créneau 20h00' });
  const late = page.getByRole('button', { name: 'Choisir le créneau 21h00' });
  await early.focus();
  await expect(early).toBeFocused();
  await page.keyboard.press('Space');
  await expect(early).toHaveAttribute('aria-pressed', 'true');
  await late.focus();
  await late.press('Space');
  await expect(late).toHaveAttribute('aria-pressed', 'true');
  await early.press('Space');
  await page.getByRole('button', { name: 'Continuer · 20h00' }).click();
  expect(modifications).toBe(0);
  await expect(page.locator('dl').first()).toContainText('19:30');
  await expect(page.getByRole('dialog')).toContainText('20h00');
  await expect(page.getByRole('dialog')).toContainText('3 personnes');
  await page.screenshot({
    path: testInfo.outputPath('reservation-modification-review.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Confirmer la modification' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('dl').first()).toContainText('20:00');
  expect(modifications).toBe(1);
  await page.reload();
  await expect(page.locator('dl').first()).toContainText('20:00');
  expect(modifications).toBe(1);
});

test('a taken modification slot leaves the current booking intact', async ({ page }) => {
  test.skip(
    !!process.env.PLAYWRIGHT_BASE_URL &&
      !new URL(process.env.PLAYWRIGHT_BASE_URL).hostname.match(/^(localhost|127\.0\.0\.1)$/),
    'Local mocked qualification only',
  );
  await page.route('**/api/reservation-management', async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === 'modification_options')
      return route.fulfill({
        json: {
          date: '2026-10-20',
          partySize: 2,
          maxPartySize: 4,
          slots: [{ time: '20:00', proposalToken: 'offer' }],
          message: 'Conservée',
        },
      });
    if (body.action === 'modify')
      return route.fulfill({
        status: 409,
        json: { error: 'Ce créneau vient d’être pris. Votre réservation initiale est conservée.' },
      });
    await route.fulfill({
      json: {
        restaurantName: 'Chez Suppernote',
        restaurantPhone: '+33100000000',
        date: '2026-10-20',
        time: '19:30',
        partySize: 2,
        state: 'CONFIRMED',
        whatsappReminder: { visible: false, enabled: false },
        modification: { available: true, message: 'Conservée' },
      },
    });
  });
  await page.goto(`/r#${'a'.repeat(27)}.${'b'.repeat(43)}`);
  await page
    .locator('summary')
    .filter({ hasText: /^Modifier ou annuler$/ })
    .click();
  await page.getByRole('button', { name: 'Modifier la réservation', exact: true }).click();
  await page.getByRole('button', { name: 'Choisir le créneau 20h00' }).click();
  await page.getByRole('button', { name: 'Continuer · 20h00' }).click();
  await page.getByRole('button', { name: 'Confirmer la modification' }).click();
  await expect(page.getByRole('alert')).toContainText('réservation initiale est conservée');
  await page.getByRole('button', { name: 'Quitter sans modifier' }).click();
  await expect(page.locator('dl').first()).toContainText('19:30');
});
