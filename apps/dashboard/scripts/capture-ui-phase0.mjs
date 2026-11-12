import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Usage: UI_CAPTURE_BASE_URL=http://localhost:3100 UI_CAPTURE_PHASE=phase3 node scripts/capture-ui-phase0.mjs
// This is a local visual reference tool. All API responses are fictional fixtures.
const baseUrl = process.env.UI_CAPTURE_BASE_URL ?? 'http://localhost:3100';
if (!['localhost', '127.0.0.1', '::1'].includes(new URL(baseUrl).hostname)) {
  throw new Error('La capture de référence doit utiliser un serveur local.');
}

const capturePhase = process.env.UI_CAPTURE_PHASE ?? 'phase0';
if (!['phase0', 'phase2', 'phase3', 'phase4', 'phase5'].includes(capturePhase)) {
  throw new Error('La phase de capture doit être phase0, phase2, phase3, phase4 ou phase5.');
}
const outputDir = fileURLToPath(
  new URL(
    `../../../docs/audits/${capturePhase === 'phase0' ? 'phase0-2026-10-02' : `${capturePhase}-2026-10-03`}/`,
    import.meta.url,
  ),
);
const fixedNow = '2026-10-02T18:15:00.000Z';
const midnightNow = '2026-10-02T22:15:00.000Z';
const fixedDate = '2026-10-02';
const widgetDate = '2026-10-03';
const restaurantId = 'e2e-demo-restaurant';

const sizes = {
  desktop: { width: 1440, height: 1000 },
  ipad: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844 },
};

const floorPlan = {
  id: 'phase0-plan',
  name: 'Salle principale',
  isDefault: true,
  isActive: true,
  width: 800,
  height: 500,
  sections: [{ id: 'phase0-section', name: 'Salle', position: 0, tables: [] }],
  tables: [
    {
      id: 't1',
      name: 'T1',
      capacity: 4,
      minCapacity: 1,
      isActive: true,
      sectionId: 'phase0-section',
      positionX: 95,
      positionY: 90,
      width: 88,
      height: 88,
      rotation: 0,
      shape: 'round',
    },
    {
      id: 't2',
      name: 'T2',
      capacity: 2,
      minCapacity: 1,
      isActive: true,
      sectionId: 'phase0-section',
      positionX: 260,
      positionY: 90,
      width: 88,
      height: 88,
      rotation: 0,
      shape: 'round',
    },
    {
      id: 't3',
      name: 'T3',
      capacity: 4,
      minCapacity: 1,
      isActive: true,
      sectionId: 'phase0-section',
      positionX: 430,
      positionY: 90,
      width: 108,
      height: 82,
      rotation: 0,
      shape: 'rect',
    },
    {
      id: 't4',
      name: 'T4',
      capacity: 6,
      minCapacity: 1,
      isActive: true,
      sectionId: 'phase0-section',
      positionX: 120,
      positionY: 270,
      width: 116,
      height: 82,
      rotation: 0,
      shape: 'rect',
    },
    {
      id: 't5',
      name: 'T5',
      capacity: 2,
      minCapacity: 1,
      isActive: true,
      sectionId: 'phase0-section',
      positionX: 350,
      positionY: 270,
      width: 88,
      height: 88,
      rotation: 0,
      shape: 'round',
    },
  ],
  walls: [],
};

const dashboardReservations = [
  {
    id: 'res-1',
    restaurantId,
    reservedAt: '2026-10-02T17:55:00.000Z',
    partySize: 4,
    customerName: 'Camille Martin',
    customerPhone: null,
    status: 'CONFIRMED',
    state: 'CONFIRMED',
    estimatedRevenue: 144,
    tableId: 't1',
    table: { name: 'T1' },
  },
  {
    id: 'res-2',
    restaurantId,
    reservedAt: '2026-10-02T18:30:00.000Z',
    partySize: 2,
    customerName: 'Léa Bernard',
    customerPhone: null,
    status: 'CONFIRMED',
    state: 'PENDING',
    estimatedRevenue: 72,
    tableId: null,
    table: null,
  },
  {
    id: 'res-3',
    restaurantId,
    reservedAt: '2026-10-02T17:15:00.000Z',
    partySize: 4,
    customerName: 'Nora Petit',
    customerPhone: null,
    status: 'SEATED',
    state: 'SEATED',
    estimatedRevenue: 132,
    tableId: 't3',
    table: { name: 'T3' },
  },
  {
    id: 'res-4',
    restaurantId,
    reservedAt: '2026-10-02T16:15:00.000Z',
    partySize: 6,
    customerName: 'Julien Moreau',
    customerPhone: null,
    status: 'SEATED',
    state: 'HONORED',
    estimatedRevenue: 225,
    tableId: 't4',
    table: { name: 'T4' },
  },
  {
    id: 'res-5',
    restaurantId,
    reservedAt: '2026-10-02T19:00:00.000Z',
    partySize: 2,
    customerName: 'Émilie Laurent',
    customerPhone: null,
    status: 'CANCELLED',
    state: 'CANCELLED',
    estimatedRevenue: 65,
    tableId: null,
    table: null,
  },
  {
    id: 'res-6',
    restaurantId,
    reservedAt: '2026-10-02T18:00:00.000Z',
    partySize: 2,
    customerName: 'Thomas Faure',
    customerPhone: null,
    status: 'NO_SHOW',
    state: 'NO_SHOW',
    estimatedRevenue: 68,
    tableId: 't2',
    table: { name: 'T2' },
  },
];

const planningReservations = [
  {
    id: 'res-1',
    tableId: 't1',
    tableName: 'T1',
    sectionName: 'Salle',
    startsAt: '2026-10-02T17:55:00.000Z',
    endsAt: '2026-10-02T19:55:00.000Z',
    partySize: 4,
    customerName: 'Camille Martin',
    state: 'CONFIRMED',
    seatedAt: null,
  },
  {
    id: 'res-3',
    tableId: 't3',
    tableName: 'T3',
    sectionName: 'Salle',
    startsAt: '2026-10-02T17:15:00.000Z',
    endsAt: '2026-10-02T19:15:00.000Z',
    partySize: 4,
    customerName: 'Nora Petit',
    state: 'SEATED',
    seatedAt: '2026-10-02T17:20:00.000Z',
  },
  {
    id: 'res-2',
    tableId: null,
    tableName: null,
    sectionName: null,
    startsAt: '2026-10-02T18:30:00.000Z',
    endsAt: '2026-10-02T20:30:00.000Z',
    partySize: 2,
    customerName: 'Léa Bernard',
    state: 'PENDING',
    seatedAt: null,
  },
];

const recommendations = [
  {
    id: 'phase0-late',
    occurrenceKey: 'late-reservation:res-1:2026-10-02T17:55:00.000Z',
    ruleVersion: 'v1',
    kind: 'late-reservation',
    priority: 'high',
    title: 'Camille Martin est en retard de 20 min — appeler / marquer absent',
    reason: "Le client n'est pas arrivé et le créneau a débuté il y a 20 minutes.",
    action: { type: 'link', label: 'Gérer la réservation', href: '/dashboard/reservations' },
    entityId: 'res-1',
    expiresAt: '2026-10-02T18:55:00.000Z',
    metrics: { minutesLate: 20 },
  },
  {
    id: 'phase0-table',
    occurrenceKey: 'table-soon-free:res-3:2026-10-02T17:20:00.000Z',
    ruleVersion: 'v1',
    kind: 'table-soon-free',
    priority: 'medium',
    title: 'Table T3 devrait se libérer vers 20:25 — prévenir Léa Bernard',
    reason: 'Libération estimée selon la durée du service.',
    action: { type: 'link', label: 'Voir le plan', href: '/dashboard/floor-plan' },
    entityId: 'res-3',
    expiresAt: '2026-10-02T18:25:00.000Z',
    metrics: {
      estimatedFreeAt: '2026-10-02T18:25:00.000Z',
      tableName: 'T3',
      predictionSource: 'scheduled',
    },
  },
  {
    id: 'phase0-wait',
    occurrenceKey: 'waiting-list-compatible:wait-1',
    ruleVersion: 'v1',
    kind: 'waiting-list-compatible',
    priority: 'medium',
    title: 'Léa Bernard, 2 couverts, devient compatible dans ~15 min — proposer une table',
    reason: 'Une table est disponible vers 20:30 pour 2 couverts.',
    action: { type: 'link', label: 'Proposer une table', href: '/dashboard/floor-plan' },
    entityId: 'wait-1',
    expiresAt: '2026-10-02T18:30:00.000Z',
    metrics: { covers: 2, customerName: 'Léa Bernard' },
  },
];

const publicRestaurant = {
  id: restaurantId,
  name: 'Chez Sokar',
  city: 'Lyon',
  cuisine: 'Bistrot',
  address: 'Adresse fictive, Lyon',
  openingHours: Object.fromEntries(
    ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].map((day) => [
      day,
      { open: '12:00', close: '22:00' },
    ]),
  ),
  heroImageUrl:
    'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?auto=format&fit=crop&w=1200&q=80',
  tags: ['Cuisine française', 'Bistrot'],
};
const publicRestaurantWithoutContent = {
  ...publicRestaurant,
  heroImageUrl: undefined,
  coverImageUrl: undefined,
  imageUrl: undefined,
  galleryImages: [],
  cuisine: undefined,
  city: undefined,
  address: undefined,
  tags: [],
};

const manifest = {
  capturedAt: new Date().toISOString(),
  baseline:
    capturePhase === 'phase0'
      ? 'Interface courante après la phase 1, avant toute retouche visuelle'
      : `Interface après la phase ${capturePhase.slice(-1)}, mêmes scénarios et dimensions que la phase 0`,
  browser: 'Playwright Chromium',
  referenceClock: fixedNow,
  timezone: 'Europe/Paris',
  viewports: { ...sizes },
  screenshots: [],
  unexpectedApiRequests: [],
};
if (capturePhase === 'phase5') {
  manifest.viewports['mobile-hauteur-reduite'] = { width: 390, height: 500 };
}

function mockResponse(pathname, query, variant) {
  if (pathname.endsWith('/admin/access')) return { allowed: false };
  if (pathname.endsWith('/restaurants/sites')) {
    return {
      accountId: restaurantId,
      activeSiteId: restaurantId,
      sites: [
        {
          id: restaurantId,
          name: 'Chez Sokar',
          siteStatus: 'ACTIVE',
          isPrimary: true,
          role: 'OWNER',
        },
      ],
    };
  }
  if (pathname.endsWith(`/restaurants/${restaurantId}`))
    return variant === 'widget-no-content' ? publicRestaurantWithoutContent : publicRestaurant;
  if (pathname.includes('/public/widget/'))
    return variant === 'widget-no-content' ? publicRestaurantWithoutContent : publicRestaurant;
  if (pathname.includes('/availability')) {
    return {
      restaurantId,
      date: query.get('date') ?? widgetDate,
      partySize: Number(query.get('partySize') ?? 4),
      slots:
        variant === 'widget-full'
          ? []
          : variant === 'widget-unavailable'
            ? ['19:00', '20:00']
            : ['19:00', '20:00', '20:30', '21:00'],
    };
  }
  if (pathname.endsWith('/floor-plans')) {
    return [
      {
        id: floorPlan.id,
        name: floorPlan.name,
        isDefault: true,
        isActive: true,
        tableCount: floorPlan.tables.length,
      },
    ];
  }
  if (pathname.endsWith(`/floor-plans/${floorPlan.id}`) || pathname.endsWith('/floor-plan')) {
    return variant === 'salle-long-name'
      ? {
          ...floorPlan,
          tables: floorPlan.tables.map((table) =>
            table.id === 't1' ? { ...table, displayName: 'Table fenêtre panoramique' } : table,
          ),
        }
      : floorPlan;
  }
  if (pathname.includes('/floor-plan/reservations'))
    return variant === 'salle-long-name'
      ? planningReservations.map((reservation) =>
          reservation.id === 'res-1'
            ? { ...reservation, customerName: 'Alexandre Jean-Baptiste de Montmorency' }
            : reservation,
        )
      : planningReservations;
  if (pathname.endsWith('/reservations')) {
    if (variant === 'reservations-empty') return [];
    if (variant === 'reservations-short') return dashboardReservations.slice(0, 2);
    if (variant === 'reservations-long') {
      return dashboardReservations.map((reservation, index) => ({
        ...reservation,
        customerName:
          index === 0 ? 'Alexandre Jean-Baptiste de Montmorency' : reservation.customerName,
        customerPhone: index === 0 ? '+33 6 00 00 00 01' : reservation.customerPhone,
      }));
    }
    return dashboardReservations;
  }
  if (pathname.includes('/service-copilot/recommendations')) {
    if (variant === 'salle-zero' || variant === 'salle-long-name') return { recommendations: [] };
    const phaseRecommendations =
      capturePhase !== 'phase0'
        ? recommendations.map((rec) => ({
            ...rec,
            action: {
              ...rec.action,
              label:
                rec.kind === 'late-reservation'
                  ? 'Ouvrir les réservations'
                  : rec.kind === 'waiting-list-compatible'
                    ? 'Ouvrir la Salle'
                    : rec.action.label,
            },
          }))
        : recommendations;
    if (variant === 'salle-midnight') {
      return {
        recommendations: [
          {
            ...phaseRecommendations[0],
            id: 'phase0-midnight',
            title: 'Une arrivée à suivre après minuit',
            expiresAt: '2026-10-02T22:55:00.000Z',
          },
        ],
      };
    }
    return {
      recommendations:
        variant === 'salle-three' ? phaseRecommendations : phaseRecommendations.slice(0, 1),
    };
  }
  if (pathname.includes('/service-copilot/pulse')) {
    return {
      date: query.get('date') ?? fixedDate,
      generatedAt: variant === 'salle-midnight' ? midnightNow : fixedNow,
      isLiveDate: true,
      status: 'attention',
      headline: 'Une arrivée à suivre',
      lateArrivals: 1,
      arrivalsToSeat: 1,
      arrivalsNext30Minutes: 1,
      seatedTables: 1,
      pendingWaitingList: 0,
      confirmedReservations: 1,
    };
  }
  if (pathname.includes('/service-copilot/delay-recoveries')) return { recoveries: [] };
  if (pathname.includes('/waiting-list')) return [];
  return undefined;
}

async function makePage(browser, sizeName, variant, viewportOverride = sizes[sizeName]) {
  const viewport = viewportOverride;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    isMobile: sizeName === 'mobile',
    hasTouch: sizeName !== 'desktop',
    locale: 'fr-FR',
    timezoneId: 'Europe/Paris',
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await page.clock.install({
    time: new Date(variant === 'salle-midnight' ? midnightNow : fixedNow),
  });
  await page.addInitScript(() => {
    localStorage.setItem('sokar_pwa_dismissed', 'true');
  });
  await page.route('**/api/proxy/**', async (route) => {
    const url = new URL(route.request().url());
    if (
      variant.startsWith('widget-') &&
      route.request().method() === 'POST' &&
      url.pathname.endsWith('/reservations')
    ) {
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'phase5-confirmed-reservation',
          restaurantId,
          reservedAt: '2026-10-03T18:30:00.000Z',
          partySize: 4,
          customerName: 'Alice Martin',
          customerPhone: '+33600000000',
          status: 'CONFIRMED',
        }),
      });
      return;
    }
    if (variant === 'reservations-loading' && url.pathname.endsWith('/reservations')) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route
        .fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(dashboardReservations),
        })
        .catch(() => undefined);
      return;
    }
    if (variant === 'reservations-error' && url.pathname.endsWith('/reservations')) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Service de démonstration indisponible' }),
      });
      return;
    }
    if (
      (variant === 'salle-copilot-error' &&
        url.pathname.endsWith('/service-copilot/recommendations')) ||
      (variant === 'widget-availability-error' && url.pathname.endsWith('/availability'))
    ) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Disponibilités indisponibles' }),
      });
      return;
    }
    const response = mockResponse(url.pathname, url.searchParams, variant);
    if (response === undefined) {
      manifest.unexpectedApiRequests.push(
        `${variant}: ${route.request().method()} ${url.pathname}`,
      );
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Fixture absente' }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  });
  return { page, context };
}

async function capture(page, screen, sizeName, state, viewportName = sizeName) {
  const filename = `${screen}-${sizeName}-${state}.png`;
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' });
  await page.screenshot({ path: path.join(outputDir, filename), animations: 'disabled' });
  manifest.screenshots.push({
    filename,
    screen,
    viewport: viewportName,
    state,
    route: new URL(page.url()).pathname,
  });
  process.stdout.write(`${filename}\n`);
}

async function run() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const sizeName of Object.keys(sizes)) {
      if (!['phase4', 'phase5'].includes(capturePhase)) {
        const { page, context } = await makePage(browser, sizeName, 'salle-one');
        await page.goto(
          `${baseUrl}/dashboard/floor-plan?view=service-live&floorPlanId=${floorPlan.id}`,
          { waitUntil: 'domcontentloaded', timeout: 45_000 },
        );
        await page
          .getByText('Camille Martin est en retard de 20 min', { exact: false })
          .first()
          .waitFor({ state: 'visible', timeout: 45_000 });
        await page.getByRole('tab', { name: 'Plan' }).waitFor({ state: 'visible' });
        await capture(page, 'salle', sizeName, 'une-recommandation');
        await context.close();
      }
      if (!['phase3', 'phase5'].includes(capturePhase)) {
        const { page, context } = await makePage(browser, sizeName, 'reservations-filled');
        await page.goto(`${baseUrl}/dashboard/reservations`, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await page
          .getByText('Camille Martin', { exact: true })
          .first()
          .waitFor({ state: 'visible', timeout: 45_000 });
        await capture(page, 'reservations', sizeName, 'liste-remplie');
        await context.close();
      }
      if (!['phase3', 'phase4'].includes(capturePhase)) {
        const { page, context } = await makePage(browser, sizeName, 'widget-selected');
        await page.goto(
          `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant`,
          { waitUntil: 'domcontentloaded', timeout: 45_000 },
        );
        await page
          .getByRole('button', { name: 'Choisir le créneau 20h30', pressed: true })
          .waitFor({ state: 'visible', timeout: 45_000 });
        await capture(page, 'widget', sizeName, 'creneau-selectionne');
        if (sizeName !== 'ipad' || capturePhase === 'phase5') {
          await page.getByRole('button', { name: /Continuer · 20h30/ }).click();
          await page.getByLabel('Nom complet *').waitFor({ state: 'visible' });
          await capture(page, 'widget', sizeName, 'coordonnees');
        }
        await context.close();
      }
    }

    for (const [screen, sizeName, state, variant, url, ready] of [
      [
        'salle',
        'mobile',
        'trois-recommandations',
        'salle-three',
        `/dashboard/floor-plan?view=service-live&floorPlanId=${floorPlan.id}`,
        'Léa Bernard, 2 couverts',
      ],
      [
        'reservations',
        'desktop',
        'liste-vide',
        'reservations-empty',
        '/dashboard/reservations',
        'Aucune réservation pour le moment',
      ],
      [
        'reservations',
        'mobile',
        'erreur',
        'reservations-error',
        '/dashboard/reservations',
        'Service de démonstration indisponible',
      ],
      [
        'widget',
        'mobile',
        'creneau-indisponible',
        'widget-unavailable',
        `/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant`,
        'Le créneau de 20h30 n’est plus disponible',
      ],
      [
        'widget',
        'mobile',
        'jour-complet',
        'widget-full',
        `/book/chez-suppernote-demo?date=${widgetDate}&partySize=4&source=restaurant`,
        'Complet ce jour-là',
      ],
      [
        'salle',
        'desktop',
        'apres-minuit',
        'salle-midnight',
        `/dashboard/floor-plan?view=service-live&floorPlanId=${floorPlan.id}`,
        'Une arrivée à suivre après minuit',
      ],
    ]) {
      if (
        (capturePhase === 'phase3' && screen !== 'salle') ||
        (capturePhase === 'phase4' && screen !== 'reservations') ||
        (capturePhase === 'phase5' && screen !== 'widget')
      )
        continue;
      const { page, context } = await makePage(browser, sizeName, variant);
      await page.goto(`${baseUrl}${url}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await page
        .getByText(ready, { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(page, screen, sizeName, state);
      await context.close();
    }

    if (capturePhase === 'phase2') {
      for (const [screen, variant, url, ready] of [
        [
          'salle',
          'salle-copilot-error',
          `/dashboard/floor-plan?view=service-live&floorPlanId=${floorPlan.id}`,
          'Recommandations indisponibles',
        ],
        [
          'widget',
          'widget-availability-error',
          `/book/chez-suppernote-demo?date=${widgetDate}&partySize=4&source=restaurant`,
          'Disponibilités indisponibles',
        ],
      ]) {
        const { page, context } = await makePage(browser, 'mobile', variant);
        await page.goto(`${baseUrl}${url}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page
          .getByText(ready, { exact: false })
          .first()
          .waitFor({ state: 'visible', timeout: 45_000 });
        await capture(page, screen, 'mobile', 'erreur-disponibilite');
        await context.close();
      }

      const { page, context } = await makePage(browser, 'mobile', 'reservations-filled');
      await page.goto(`${baseUrl}/dashboard/reservations`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page
        .getByText('Camille Martin', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 });
      await page.getByRole('button', { name: 'Afficher les actions' }).first().click();
      await capture(page, 'reservations', 'mobile', 'actions-ouvertes');
      await page.getByRole('button', { name: 'Annuler', exact: true }).first().click();
      await page
        .getByRole('dialog', { name: 'Annuler la réservation' })
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(page, 'reservations', 'mobile', 'confirmation-annulation');
      await context.close();
    }

    if (capturePhase === 'phase3') {
      const salleUrl = `${baseUrl}/dashboard/floor-plan?view=service-live&floorPlanId=${floorPlan.id}`;
      for (const [sizeName, variant, state, tableName] of [
        ['mobile', 'salle-zero', 'zero-recommandation', null],
        ['desktop', 'salle-one', 'table-occupee-selectionnee', /Camille Martin · 4 ·/],
        ['mobile', 'salle-one', 'table-occupee-selectionnee', /Camille Martin · 4 ·/],
        ['mobile', 'salle-one', 'table-libre-selectionnee', 'T2 · 2 places'],
        [
          'mobile',
          'salle-long-name',
          'nom-long-selectionne',
          /Alexandre Jean-Baptiste de Montmorency/,
        ],
      ]) {
        const { page, context } = await makePage(browser, sizeName, variant);
        await page.goto(salleUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page
          .getByRole('tab', { name: 'Plan' })
          .waitFor({ state: 'visible', timeout: 45_000 });
        if (tableName) {
          const table = page.getByRole('button', { name: tableName }).first();
          await table.click();
          await page
            .getByRole('button', { name: tableName, pressed: true })
            .first()
            .waitFor({ state: 'visible', timeout: 45_000 });
        }
        await capture(page, 'salle', sizeName, state);
        await context.close();
      }
    }

    if (capturePhase === 'phase4') {
      for (const [sizeName, variant, state] of [
        ['desktop', 'reservations-long', 'nom-long'],
        ['ipad', 'reservations-long', 'nom-long'],
        ['mobile', 'reservations-long', 'nom-long'],
        ['mobile', 'reservations-short', 'liste-courte'],
      ]) {
        const { page, context } = await makePage(browser, sizeName, variant);
        await page.goto(`${baseUrl}/dashboard/reservations`, {
          waitUntil: 'domcontentloaded',
          timeout: 45_000,
        });
        await page
          .getByText(
            variant === 'reservations-short'
              ? 'Camille Martin'
              : 'Alexandre Jean-Baptiste de Montmorency',
            { exact: variant === 'reservations-short' },
          )
          .first()
          .waitFor({ state: 'visible', timeout: 45_000 });
        await capture(page, 'reservations', sizeName, state);
        await context.close();
      }
    }

    if (capturePhase === 'phase5') {
      const { page, context } = await makePage(browser, 'mobile', 'widget-availability-error');
      await page.goto(
        `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&partySize=4&source=restaurant`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await page
        .getByText('Disponibilités indisponibles', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(page, 'widget', 'mobile', 'erreur-disponibilite');
      await context.close();

      const noContent = await makePage(browser, 'mobile', 'widget-no-content');
      await noContent.page.goto(
        `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await noContent.page
        .getByRole('button', { name: 'Choisir le créneau 20h30', pressed: true })
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(noContent.page, 'widget', 'mobile', 'sans-contenu-optionnel');
      await noContent.context.close();

      const embedded = await makePage(browser, 'mobile', 'widget-selected');
      await embedded.page.goto(
        `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant&embedded=1`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await embedded.page
        .getByRole('button', { name: 'Choisir le créneau 20h30', pressed: true })
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(embedded.page, 'widget', 'mobile', 'integre');
      await embedded.context.close();

      const success = await makePage(browser, 'mobile', 'widget-submit');
      await success.page.goto(
        `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await success.page.getByRole('button', { name: /Continuer · 20h30/ }).click();
      await success.page.getByLabel('Nom complet *').fill('Alice Martin');
      await success.page.getByLabel('Téléphone *').fill('0600000000');
      await success.page.getByRole('button', { name: 'Valider la réservation' }).click();
      await success.page
        .getByRole('heading', { name: 'Table réservée !' })
        .waitFor({ state: 'visible', timeout: 45_000 });
      await capture(success.page, 'widget', 'mobile', 'reservation-confirmee');
      await success.context.close();

      const reducedMobile = await makePage(browser, 'mobile', 'widget-submit', {
        width: 390,
        height: 500,
      });
      await reducedMobile.page.goto(
        `${baseUrl}/book/chez-suppernote-demo?date=${widgetDate}&time=20:30&partySize=4&source=restaurant`,
        { waitUntil: 'domcontentloaded', timeout: 45_000 },
      );
      await reducedMobile.page.getByRole('button', { name: /Continuer · 20h30/ }).click();
      const phoneInput = reducedMobile.page.getByLabel('Téléphone *');
      await phoneInput.focus();
      await phoneInput.evaluate((element) =>
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' }),
      );
      const [phoneBounds, reducedViewportHeight] = await Promise.all([
        phoneInput.boundingBox(),
        reducedMobile.page.evaluate(() => window.innerHeight),
      ]);
      if (
        !phoneBounds ||
        phoneBounds.y < 0 ||
        phoneBounds.y + phoneBounds.height > reducedViewportHeight
      ) {
        throw new Error('Le champ téléphone sort de la zone visible à hauteur réduite.');
      }
      await capture(
        reducedMobile.page,
        'widget',
        'mobile',
        'formulaire-vue-reduite',
        'mobile-hauteur-reduite',
      );
      await reducedMobile.context.close();
    }

    if (!['phase3', 'phase4', 'phase5'].includes(capturePhase)) {
      const { page, context } = await makePage(browser, 'desktop', 'reservations-loading');
      await page.goto(`${baseUrl}/dashboard/reservations`, {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.locator('.animate-pulse').first().waitFor({ state: 'visible', timeout: 45_000 });
      await capture(page, 'reservations', 'desktop', 'chargement');
      await context.close();
    }
  } finally {
    await browser.close();
    await writeFile(
      path.join(outputDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
  }
}

await run();
