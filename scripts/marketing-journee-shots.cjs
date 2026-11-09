// Captures de la page d'accueil « une journée de service » : vraie interface, scène fictive.
// Les données sont modifiées dans le navigateur seulement, rien n'est écrit en base.
//
// Prérequis, en local uniquement :
//   API :       RUN_WORKERS_IN_PROCESS=false pnpm --filter @suppernote/api exec tsx src/main.ts
//   Dashboard : pnpm --filter dashboard exec next dev -p 3000 (démo locale, sans connexion)
// Usage :       node scripts/marketing-journee-shots.cjs <dossier des captures brutes>
//               MARKETING_SHOTS_CROP_ONLY=1 pour seulement recadrer des captures déjà prises.
//
// shortcut: les recadrages sont en coordonnées fixes et la scène repose sur les données de la démo
// locale du 3 novembre 2026 ; à reprendre si l'interface ou les données de démo changent.
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const fromDashboard = createRequire(path.join(root, 'apps/dashboard/package.json'));
const { chromium } = fromDashboard('@playwright/test');
const sharp = createRequire(fromDashboard.resolve('next/package.json'))('sharp');

const BASE_URL = 'http://localhost:3000';
const OUTPUT = path.join(root, 'apps/dashboard/public/marketing/journee-');

const rawDir = process.argv[2];
if (!rawDir) {
  throw new Error('Indiquer le dossier des captures brutes.');
}

const parisTime = (hour, minute) => new Date(Date.UTC(2026, 10, 3, hour - 1, minute)).toISOString();

const CAMILLE = 'Camille Robert';
const TRANSCRIPT = `Léa : Bonjour, ici Léa, l'assistante IA du restaurant. Que puis-je faire pour vous ?
Client : Bonjour, je voudrais une table pour quatre, ce soir vers 20 h 30.
Léa : Nous avons de la place à 20 h 30. À quel nom ?
Client : ${CAMILLE}.
Léa : C'est réservé, quatre personnes ce soir à 20 h 30, au nom de ${CAMILLE}. Bonne journée.`;

// [nom, couverts, forme, x, y]
const TABLES = [
  ['T1', 2, 'round', 60, 50],
  ['T2', 2, 'round', 240, 50],
  ['T3', 2, 'round', 420, 50],
  ['T4', 2, 'round', 600, 50],
  ['T5', 6, 'rectangle', 860, 50],
  ['T6', 4, 'rectangle', 70, 280],
  ['T7', 4, 'rectangle', 310, 250],
  ['T8', 4, 'round', 560, 300],
  ['T9', 4, 'rectangle', 800, 300],
  ['T10', 8, 'rectangle', 1040, 270],
  ['T11', 2, 'round', 60, 520],
  ['T12', 4, 'rectangle', 270, 520],
  ['T13', 4, 'rectangle', 520, 540],
  ['T14', 6, 'rectangle', 790, 540],
];

// [table, client, couverts, heure, minute, état]
const SEATINGS = [
  ['t1', 'Théo Petit', 2, 20, 0, 'SEATED'],
  ['t3', 'Zoé Martin', 2, 19, 45, 'SEATED'],
  ['t5', 'Sarah Faure', 6, 19, 45, 'SEATED'],
  ['t6', 'Julien Faure', 4, 20, 0, 'SEATED'],
  ['t7', 'Antoine Fontaine', 4, 20, 15, 'SEATED'],
  ['t8', 'Julie Fournier', 4, 19, 30, 'SEATED'],
  ['t9', CAMILLE, 4, 20, 30, 'SEATED'],
  ['t10', 'Romain Garnier', 8, 19, 45, 'SEATED'],
  ['t11', 'Quentin Garnier', 2, 20, 5, 'SEATED'],
  ['t13', 'Inès Girard', 4, 21, 0, 'CONFIRMED'],
  ['t2', 'Noémie Rousseau', 2, 21, 30, 'CONFIRMED'],
];

const patchJson = (page, pattern, change) =>
  page.route(pattern, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    return route.fulfill({ response, json: change(await response.json()) });
  });

// Une cliente de la démo porte le même prénom que l'assistante.
const renameLea = (reservations) => {
  for (const reservation of reservations) {
    if (reservation.customerName === 'Léa Girard') reservation.customerName = 'Inès Girard';
  }
  return reservations;
};

const withCamille = (reservations) => {
  renameLea(reservations);
  reservations.push({
    ...reservations[1],
    id: 'scene-camille',
    customerName: CAMILLE,
    customerPhone: '+33639981019',
    customerEmail: null,
    partySize: 4,
    channel: 'PHONE',
    source: 'PHONE',
    createdByClient: null,
    estimatedRevenue: '176',
    reservedAt: parisTime(20, 30),
    startsAt: parisTime(20, 30),
    endsAt: parisTime(22, 0),
  });
  return reservations.sort((a, b) => (a.reservedAt < b.reservedAt ? -1 : 1));
};

const withAllergy = (response) => {
  const last = response.data.at(-1);
  if (last?.badges[0]) last.badges.push({ ...last.badges[0], kind: 'allergy', label: 'Sans noix' });
  return response;
};

const hideBottomNav = (page) =>
  page.evaluate(() => {
    for (const element of document.querySelectorAll('body *')) {
      const isFixed = getComputedStyle(element).position === 'fixed';
      const isLow = element.getBoundingClientRect().top > innerHeight * 0.7;
      if (isFixed && isLow && !element.closest('[role=dialog]')) element.style.display = 'none';
    }
  });

async function captureBriefing(context, tag) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(parisTime(11, 0)));
  await patchJson(page, /\/api\/proxy\/v2\/reservations\/day\?date/, renameLea);
  await patchJson(page, /customers\/service-cards/, withAllergy);
  await page.goto(`${BASE_URL}/dashboard/briefing`, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  await hideBottomNav(page);
  await page.screenshot({ path: `${rawDir}/${tag}-briefing.png` });
  await page.close();
}

async function captureCallAndBook(context, tag) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(parisTime(13, 0)));
  await patchJson(page, /\/api\/proxy\/v2\/reservations\/day\?date/, withCamille);
  await patchJson(page, /customers\/service-cards/, withAllergy);
  await patchJson(page, /\/api\/proxy\/calls(\?|$)/, (response) => {
    Object.assign(response.data[0], {
      transcript: TRANSCRIPT,
      createdAt: parisTime(12, 40),
      durationSec: 58,
      callerPhone: '+33639981019',
    });
    return response;
  });

  await page.goto(`${BASE_URL}/dashboard/calls`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const row = page.locator('tbody tr').first();
  if ((await row.count()) && (await row.isVisible())) await row.click();
  else await page.getByText('+33 6 39 98 10 19').first().click();
  await page.waitForTimeout(1000);
  await page
    .getByRole('dialog', { name: 'Appel' })
    .screenshot({ path: `${rawDir}/${tag}-call.png` });

  await page.goto(`${BASE_URL}/dashboard/reservations`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  await page.evaluate((camille) => {
    const kept = ['Sarah Faure', camille, 'Inès Girard'];
    for (const row of document.querySelectorAll('tbody tr')) {
      if (!kept.some((name) => row.textContent.includes(name))) row.style.display = 'none';
      if (row.textContent.includes(camille)) row.style.background = 'hsl(213 28% 30%)';
    }
    const columns = 'th:last-child,td:last-child,th:nth-child(4),td:nth-child(4)';
    for (const cell of document.querySelectorAll(columns)) cell.style.display = 'none';
    // Sur téléphone, le carnet est une liste de cartes : seule celle de Camille reste.
    for (const card of document.querySelectorAll('article,[class*=rounded]')) {
      const text = card.textContent;
      const isOtherCard = /Revenu estim/.test(text) && text.length < 300 && !text.includes(camille);
      if (isOtherCard && card.children.length > 1) card.style.display = 'none';
    }
  }, CAMILLE);
  await page.waitForTimeout(300);
  const table = page.locator('table').first();
  if ((await table.count()) && (await table.isVisible())) {
    await table.screenshot({ path: `${rawDir}/${tag}-carnet.png` });
  }
  await hideBottomNav(page);
  await page.screenshot({ path: `${rawDir}/${tag}-carnet-full.png` });

  await page.goto(`${BASE_URL}/dashboard/customers`, { waitUntil: 'load' });
  await page.waitForTimeout(3000);
  const href = await page
    .locator('a[href*="/customers/crm/"]', { hasText: CAMILLE })
    .first()
    .getAttribute('href');
  await page.close();
  return href;
}

async function captureClientFile(context, tag, href) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(parisTime(23, 30)));
  await patchJson(page, /crm\/customers\/[0-9a-f-]{36}(\?|$)/, (response) => {
    const updatedAt = parisTime(23, 30);
    const base = {
      source: 'STAFF',
      confidence: 1,
      confirmedAt: updatedAt,
      expiresAt: null,
      updatedAt,
    };
    response.data.preferences = [
      { id: 'a', key: 'occasion_type', value: 'Anniversaire, 3 novembre', ...base },
      { id: 'b', key: 'dietary_restrictions', value: ['Sans noix'], ...base },
      { id: 'c', key: 'preferred_table', value: 'T9, près de la fenêtre', ...base },
    ];
    if (response.data.visitSummary) response.data.visitSummary.lastVisitAt = parisTime(20, 30);
    return response;
  });
  await page.goto(`${BASE_URL}${href}`, { waitUntil: 'load' });
  await page.waitForTimeout(3500);
  await page.getByRole('tab', { name: /Préférences/ }).click();
  await page.waitForTimeout(600);
  // Interface simplifiée pour la page publique : ni boutons d'édition ni chiffres vides.
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('main button,[role=main] button')) {
      if (button.getAttribute('role') !== 'tab') button.style.visibility = 'hidden';
    }
    for (const input of document.querySelectorAll('input')) input.style.visibility = 'hidden';
    for (const action of document.querySelectorAll('a,button')) {
      if (/^(Doublons|Ajouter)/.test(action.textContent.trim())) action.style.display = 'none';
    }
    const stats = [...document.querySelectorAll('*')].filter(
      (element) =>
        element.children.length === 0 &&
        /Dépense encaissée|Couverts|No-show/.test(element.textContent),
    );
    for (const stat of stats) {
      let block = stat;
      for (let depth = 0; depth < 3; depth += 1) {
        if (!block.parentElement || block.parentElement.children.length >= 5) break;
        block = block.parentElement;
      }
      block.style.display = 'none';
    }
    document.activeElement?.blur();
  });
  await hideBottomNav(page);
  await page.mouse.move(2, 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${rawDir}/${tag}-fiche.png` });
  await page.close();
}

async function capturePlan(context, tag) {
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date(parisTime(20, 35)));
  await patchJson(page, /floor-plans\/[0-9a-f-]{36}(\?|$)/, (plan) => {
    const template = plan.tables[0];
    plan.tables = TABLES.map(([name, capacity, shape, positionX, positionY], index) => ({
      ...template,
      id: `t${index + 1}`,
      name,
      capacity,
      shape,
      positionX,
      positionY,
      width: capacity >= 6 ? 210 : capacity === 4 ? 150 : 110,
      height: capacity === 4 && shape === 'round' ? 130 : 110,
    }));
    return { ...plan, sections: [], walls: [], zones: [], tableCombinations: [] };
  });
  await patchJson(page, /floor-plan\/reservations/, () =>
    SEATINGS.map(([tableId, customerName, partySize, hour, minute, state], index) => ({
      id: `r${index}`,
      tableId,
      tableName: null,
      sectionName: null,
      startsAt: parisTime(hour, minute),
      endsAt: parisTime(hour + 1, minute + 30),
      partySize,
      customerName,
      state,
      seatedAt: state === 'SEATED' ? parisTime(hour, minute) : null,
    })),
  );
  await page.goto(`${BASE_URL}/dashboard/floor-plan`, { waitUntil: 'load' });
  await page.waitForTimeout(4500);
  await page.getByRole('button', { name: /Ajuster le plan/ }).click();
  await page.waitForTimeout(800);
  await page.getByText('T9', { exact: true }).first().click();
  await page.waitForTimeout(1200);
  await hideBottomNav(page);
  await page.screenshot({ path: `${rawDir}/${tag}-plan-t9.png` });
  await page.close();
}

async function capture() {
  const browser = await chromium.launch();
  const formats = [
    ['desk', 1280, 800],
    ['mob', 390, 1000],
  ];
  for (const [tag, width, height] of formats) {
    const isMobile = tag === 'mob';
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
      hasTouch: isMobile,
      isMobile,
    });
    await context.addInitScript(() => {
      localStorage.setItem('sokar:first-service-guide:dismissed', '1');
    });
    await captureBriefing(context, tag);
    const href = await captureCallAndBook(context, tag);
    await captureClientFile(context, tag, href);
    await capturePlan(context, tag);
    await context.close();
  }
  await browser.close();
}

// Recadrages en pixels de capture.
const DESKTOP_SCALE = 1.28;
const MOBILE_SCALE = 3.125;
const desktopBox = (x0, y0, x1, y1) => ({
  left: Math.round(x0 * DESKTOP_SCALE),
  top: Math.round(y0 * DESKTOP_SCALE),
  width: Math.round((x1 - x0) * DESKTOP_SCALE),
  height: Math.round((y1 - y0) * DESKTOP_SCALE),
});

async function exportImage(source, name, box) {
  const image = sharp(`${rawDir}/${source}.png`);
  if (box) image.extract(box);
  await image.webp({ quality: 82 }).toFile(`${OUTPUT}${name}.webp`);
}

// Assemble des bandes d'une capture téléphone, pour retirer les vides de l'interface.
async function exportMobileBands(source, name, bands) {
  const parts = [];
  let height = 0;
  for (const [start, end] of bands) {
    const bandHeight = Math.round((end - start) * MOBILE_SCALE);
    const input = await sharp(`${rawDir}/${source}.png`)
      .extract({ left: 0, top: Math.round(start * MOBILE_SCALE), width: 780, height: bandHeight })
      .png()
      .toBuffer();
    parts.push({ input, left: 0, top: height });
    height += bandHeight;
  }
  await sharp({
    create: { width: 780, height, channels: 3, background: { r: 12, g: 12, b: 12 } },
  })
    .composite(parts)
    .webp({ quality: 82 })
    .toFile(`${OUTPUT}${name}.webp`);
}

async function crop() {
  await exportImage('desk-briefing', 'briefing-desktop', desktopBox(132, 190, 1968, 1085));
  await exportImage('desk-call', 'appel-desktop');
  await exportImage('desk-carnet', 'carnet-desktop');
  await exportImage('desk-plan-t9', 'plan-desktop', desktopBox(145, 372, 1955, 1075));
  await exportImage('desk-fiche', 'fiche-desktop', desktopBox(132, 275, 1968, 1105));
  await exportMobileBands('mob-briefing', 'briefing-mobile', [[68, 520]]);
  await exportImage('mob-call', 'appel-mobile');
  await exportMobileBands('mob-carnet-full', 'carnet-mobile', [[196, 334]]);
  await exportMobileBands('mob-plan-t9', 'plan-mobile', [
    [182, 318],
    [478, 592],
  ]);
  await exportMobileBands('mob-fiche', 'fiche-mobile', [
    [100, 165],
    [226, 478],
  ]);
}

(async () => {
  if (process.env.MARKETING_SHOTS_CROP_ONLY !== '1') await capture();
  await crop();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
