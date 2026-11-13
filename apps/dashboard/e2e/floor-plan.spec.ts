import { test, expect, type Page } from '@playwright/test';

const demoFloorPlan = {
  id: 'e2e-floor-plan',
  name: 'Salle démo',
  isDefault: true,
  isActive: true,
  width: 800,
  height: 500,
  sections: [
    {
      id: 'e2e-section-terrasse',
      name: 'Terrasse',
      position: 0,
      tables: [],
    },
    {
      id: 'e2e-section-salle',
      name: 'Salle',
      position: 1,
      tables: [],
    },
  ],
  tables: [
    {
      id: 'e2e-table-t1',
      name: 'T1',
      capacity: 2,
      minCapacity: 1,
      isActive: true,
      sectionId: 'e2e-section-terrasse',
      positionX: 96,
      positionY: 96,
      width: 80,
      height: 80,
      rotation: 0,
      shape: 'round',
    },
    {
      id: 'e2e-table-t3',
      name: 'T3',
      capacity: 4,
      minCapacity: 1,
      isActive: true,
      sectionId: 'e2e-section-salle',
      positionX: 280,
      positionY: 96,
      width: 96,
      height: 80,
      rotation: 0,
      shape: 'rect',
    },
    {
      id: 'e2e-table-t4',
      name: 'T4',
      capacity: 6,
      minCapacity: 1,
      isActive: true,
      sectionId: 'e2e-section-salle',
      positionX: 480,
      positionY: 96,
      width: 112,
      height: 80,
      rotation: 0,
      shape: 'rect',
    },
  ],
  walls: [],
};

const demoFloorPlans = [
  {
    id: demoFloorPlan.id,
    name: demoFloorPlan.name,
    isDefault: true,
    isActive: true,
    tableCount: demoFloorPlan.tables.length,
  },
];

const demoServicePulse = {
  date: '2026-09-20',
  generatedAt: '2026-09-20T18:00:00.000Z',
  isLiveDate: true,
  status: 'calm',
  headline: 'Service sous contrôle',
  lateArrivals: 0,
  arrivalsToSeat: 0,
  arrivalsNext30Minutes: 0,
  seatedTables: 0,
  pendingWaitingList: 0,
  confirmedReservations: 0,
};

function patchedTableResponse(
  floorPlan: typeof demoFloorPlan,
  pathname: string,
  updates: Record<string, unknown>,
) {
  const tableId = pathname.split('/').at(-1);
  const tableIndex = floorPlan.tables.findIndex((item) => item.id === tableId);
  if (tableIndex < 0) return null;

  const updatedTable = { ...floorPlan.tables[tableIndex], ...updates };
  floorPlan.tables[tableIndex] = updatedTable;
  return updatedTable;
}

async function mockTablePlacement(page: Page, tables: typeof demoFloorPlan.tables) {
  const plan = { ...demoFloorPlan, tables };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/proxy/**/floor-plan/tables/t5', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const updates = route.request().postDataJSON();
    writes.push(updates);
    await route.fulfill({ json: patchedTableResponse(plan, '/t5', updates) });
  });
  await page.route(`**/api/proxy/**/floor-plans/${plan.id}`, (route) =>
    route.fulfill({ json: plan }),
  );
  return writes;
}

type SimulationRequest = {
  partySize: number;
  startsAt: string;
  endsAt?: string;
  preferredSectionId?: string;
};

function simulationResponse(input: SimulationRequest) {
  const endsAt = input.endsAt ?? '2026-07-22T19:30:00.000Z';
  const query = { partySize: input.partySize, startsAt: input.startsAt, endsAt };

  if (input.partySize === 2) {
    return {
      query,
      feasible: true,
      bestScenarioId: 'direct-t1',
      explanation: 'Table T1 disponible à 19:00 pour 2 couverts.',
      scenarios: [
        {
          id: 'direct-t1',
          type: 'direct',
          feasible: true,
          confidence: 'high',
          title: 'Table T1 disponible',
          reason: 'Table T1 (2 couverts) disponible à 19:00.',
          actions: [],
          metrics: {
            coversGained: 2,
            conflictsCreated: 0,
            estimatedWaitMinutes: 0,
            tablesImpacted: ['T1'],
            reservationsToMove: [],
          },
          table: {
            id: 'e2e-table-t1',
            name: 'T1',
            capacity: 2,
            sectionId: 'e2e-section-terrasse',
            sectionName: 'Terrasse',
            floorPlanName: 'Salle démo',
          },
        },
      ],
    };
  }

  if (input.partySize === 4 && input.preferredSectionId === 'e2e-section-terrasse') {
    return {
      query,
      feasible: true,
      bestScenarioId: 'change-section-salle',
      explanation:
        'Aucune table dans la section demandée, mais la section Salle peut accueillir ce groupe à 19:00.',
      scenarios: [
        {
          id: 'direct-unavailable',
          type: 'direct',
          feasible: false,
          confidence: 'high',
          title: 'Aucune table disponible',
          reason: 'Aucune table de la section demandée ne peut accueillir ce groupe à ce créneau.',
          actions: [],
          metrics: {
            coversGained: 0,
            conflictsCreated: 0,
            estimatedWaitMinutes: null,
            tablesImpacted: [],
            reservationsToMove: [],
          },
        },
        {
          id: 'change-section-salle',
          type: 'change-section',
          feasible: true,
          confidence: 'medium',
          title: 'Changement de section : Salle',
          reason:
            'Aucune table dans la section demandée, mais la section Salle peut accueillir ce groupe à 19:00.',
          actions: [],
          metrics: {
            coversGained: 4,
            conflictsCreated: 0,
            estimatedWaitMinutes: 0,
            tablesImpacted: ['T3'],
            reservationsToMove: [],
          },
          table: {
            id: 'e2e-table-t3',
            name: 'T3',
            capacity: 4,
            sectionId: 'e2e-section-salle',
            sectionName: 'Salle',
            floorPlanName: 'Salle démo',
          },
        },
      ],
    };
  }

  return {
    query,
    feasible: false,
    bestScenarioId: 'refuse-next-slot',
    explanation: 'Aucune table disponible. Prochain créneau crédible : 20:30 le 2026-07-22.',
    scenarios: [
      {
        id: 'direct-unavailable',
        type: 'direct',
        feasible: false,
        confidence: 'high',
        title: 'Aucune table disponible',
        reason: 'Aucune table ne peut accueillir ce groupe à ce créneau.',
        actions: [],
        metrics: {
          coversGained: 0,
          conflictsCreated: 0,
          estimatedWaitMinutes: null,
          tablesImpacted: [],
          reservationsToMove: [],
        },
      },
      {
        id: 'refuse-next-slot',
        type: 'refuse',
        feasible: false,
        confidence: 'low',
        title: 'Aucune table disponible',
        reason:
          'Aucune table disponible à ce créneau. Prochain créneau crédible : 20:30 le 2026-07-22.',
        actions: [],
        metrics: {
          coversGained: 0,
          conflictsCreated: 0,
          estimatedWaitMinutes: 90,
          tablesImpacted: [],
          reservationsToMove: [],
        },
        nextAvailableAt: '2026-07-22T18:30:00.000Z',
        nextAvailableSectionId: 'e2e-section-salle',
      },
    ],
  };
}

async function openSimulator(page: Page) {
  await page.getByRole('button', { name: 'Simuler', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Simuler un placement' })).toBeVisible();
}

/**
 * Garde-fou non-régression du plan de salle (/dashboard/floor-plan).
 *
 * En mode demo local (NEXT_PUBLIC_DEMO_RESTAURANT_ID défini), le dashboard
 * utilise le restaurant "Chez Suppernote" et appelle l'API via le proxy Next.js.
 * Ce test vérifie que :
 *  - la vue Live s'affiche sans bandeau d'erreur ;
 *  - la navigation vers l'édition fonctionne ;
 *  - les onglets "Tables" et "Plan visuel" s'affichent ;
 *  - les tables du plan demo (T1, T3, T4) sont rendues.
 */

test.describe('/dashboard/floor-plan — navigation et données demo', () => {
  test.beforeEach(async ({ page }) => {
    const currentFloorPlan = structuredClone(demoFloorPlan);

    await page.route('**/api/proxy/**', async (route) => {
      const { pathname } = new URL(route.request().url());
      const requestMethod = route.request().method();
      const isSimulation =
        requestMethod === 'POST' && pathname.includes('/service-copilot/simulate');
      const isTablePatch = requestMethod === 'PATCH' && pathname.includes('/floor-plan/tables/');
      const response = pathname.endsWith('/entitlements')
        ? {
            restaurantId:
              route.request().headers()['x-sokar-site-id'] ||
              process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID ||
              'e2e-demo-restaurant',
            capabilities: { 'floorPlan.copilot': true },
          }
        : isSimulation
          ? simulationResponse(route.request().postDataJSON() as SimulationRequest)
          : isTablePatch
            ? patchedTableResponse(
                currentFloorPlan,
                pathname,
                route.request().postDataJSON() as Record<string, unknown>,
              )
            : pathname.endsWith('/floor-plans')
              ? demoFloorPlans
              : pathname.includes(`/floor-plans/${demoFloorPlan.id}`)
                ? currentFloorPlan
                : pathname.includes('/floor-plan/reservations')
                  ? []
                  : pathname.includes('/waiting-list')
                    ? []
                    : pathname.includes('/service-copilot/delay-recoveries')
                      ? { recoveries: [] }
                      : pathname.includes('/service-copilot/pulse')
                        ? demoServicePulse
                        : // Carte « Ce soir » du Companion, montée même panneau fermé.
                          pathname.endsWith('/companion/tonight')
                          ? {
                              service: 'soir',
                              date: '2026-10-30',
                              covers: 0,
                              usualCovers: null,
                              specialRequestsCount: 0,
                              waitlistCount: 0,
                              watch: [],
                              attention: [],
                            }
                          : null;

      await route.fulfill({
        status: response ? 200 : 404,
        contentType: 'application/json',
        body: JSON.stringify(response ?? { error: 'Route démo non mockée' }),
      });
    });
  });

  test('Essential conserve la salle et le placement sans charger les fonctions avancées', async ({
    page,
  }) => {
    let advancedRequests = 0;
    await page.route('**/api/proxy/entitlements', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          restaurantId:
            route.request().headers()['x-sokar-site-id'] ||
            process.env.NEXT_PUBLIC_DEMO_RESTAURANT_ID ||
            'e2e-demo-restaurant',
          capabilities: { 'floorPlan.copilot': false },
        }),
      }),
    );
    page.on('request', (request) => {
      if (/service-copilot\/(?!pulse)/.test(request.url())) advancedRequests++;
    });
    await page.addInitScript(() => localStorage.setItem('theme', 'light'));
    await page.goto('/dashboard/floor-plan?view=service-live&floorPlanId=e2e-floor-plan');
    await expect(page.getByLabel('Date du service')).toBeVisible();
    // L'écran de service ne porte ni annonce de formule ni « vérification du copilote » : le plan reste en haut.
    await expect(page.getByRole('button', { name: 'T1 · 2 places' })).toBeVisible();
    await expect(page.getByText('Le copilote de service accompagne la formule Pro.')).toHaveCount(
      0,
    );
    expect(advancedRequests).toBe(0);
  });

  test('passe de Live service à Salle édition, Tables puis Plan visuel', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'iphone-13', 'Parcours de navigation tactile iPhone 13.');

    await page.goto('/dashboard/floor-plan', { waitUntil: 'domcontentloaded' });

    // Vue Live par défaut : le plan et l'accès à la liste d'attente sont disponibles.
    await expect(page.getByTestId('floor-plan-live-stage')).toBeVisible();
    await expect(page.getByRole('button', { name: "Liste d'attente" })).toBeVisible();

    // Bascule vers Salle édition via la navigation tactile.
    await page.getByRole('link', { name: 'Édition' }).click();
    await expect(page.getByRole('tab', { name: 'Plan visuel' })).toBeVisible();

    // Onglet Tables.
    await page.getByRole('tab', { name: 'Tables' }).click();
    await expect(page.getByText('Tables du plan')).toBeVisible();

    // Retour au Plan visuel : les tables demo doivent s'afficher.
    await page.getByRole('tab', { name: 'Plan visuel' }).click();
    const tableT1 = page.getByText('T1').first();
    await tableT1.scrollIntoViewIfNeeded();
    await expect(tableT1).toBeVisible();

    // Aucun bandeau d'erreur ne doit être présent.
    await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
    await expect(page.getByText(/Impossible de charger/)).toHaveCount(0);
    await expect(page.getByText('Route démo non mockée')).toHaveCount(0);
  });

  test('survole une table et dépose à destination seulement si elle est libre', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Glisser-déposer à la souris.');

    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan');
    const table = page.getByRole('button', { name: 'T1 · 2 places' });
    const other = page.getByRole('button', { name: 'T3 · 4 places' });
    await expect(table).toBeVisible();
    await expect(other).toBeVisible();
    const start = (await table.boundingBox())!;
    const obstacle = (await other.boundingBox())!;
    const startX = start.x + start.width / 2;
    const startY = start.y + start.height / 2;
    const obstacleX = obstacle.x + obstacle.width / 2;
    const obstacleY = obstacle.y + obstacle.height / 2;
    const overlap =
      /Plateaux superposés avec T3\. Sera posée à côté\. Alt désactive l’alignement\./;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(obstacleX, obstacleY, { steps: 12 });
    await expect(page.getByText(overlap)).toBeVisible();
    expect(Math.abs((await table.boundingBox())!.x + start.width / 2 - obstacleX)).toBeLessThan(2);
    await page.mouse.up();
    // Dépôt sur T3 : la table est posée à côté, elle ne revient pas en arrière.
    await expect(page.getByText(/Sera posée à côté/)).toHaveCount(0);
    await expect(table).not.toHaveCSS('left', '96px');
    await page.keyboard.press('Meta+z');
    await expect(table).toHaveCSS('left', '96px');
    await expect(table).toHaveCSS('top', '96px');

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(obstacleX, obstacleY, { steps: 12 });
    await expect(page.getByText(overlap)).toBeVisible();
    await page.mouse.move(obstacleX + 45, obstacleY + 245, { steps: 12 });
    await expect(page.getByText(/Sera posée à côté/)).toHaveCount(0);
    const [left, top] = await table.evaluate((node) => [node.style.left, node.style.top]);
    expect(parseInt(left, 10)).toBeGreaterThan(280);
    await page.mouse.up();
    await expect(table).toHaveCSS('left', left);
    await expect(table).toHaveCSS('top', top);
    await page.keyboard.press('Meta+z');
    await expect(table).toHaveCSS('left', '96px');
    await expect(table).toHaveCSS('top', '96px');
  });

  test('signale les chaises proches et enregistre la position affichée', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Glisser-déposer à la souris.');
    const base = { ...demoFloorPlan.tables[1], width: 144, height: 104 };
    const writes = await mockTablePlacement(page, [
      { ...base, id: 't3', name: 'T3', positionX: 252, positionY: 250 },
      { ...base, id: 't5', name: 'T5', positionX: 252, positionY: 80 },
    ]);

    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan');
    const table = page.getByRole('button', { name: 'T5 · 4 places' });
    await expect(table).toBeVisible();
    const box = (await table.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + (76 * box.width) / 144, { steps: 12 });
    const message = 'T5 · Chaises proches de T3';
    const viewport = page.getByRole('region', { name: 'Vue du plan' });
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
    await expect(viewport.getByText(message)).toHaveCount(0);
    const highlighted = '[data-floor-seat-conflict]';
    await expect(table.locator(highlighted)).toHaveCount(2);
    await expect(
      page.getByRole('button', { name: 'T3 · 4 places' }).locator(highlighted),
    ).toHaveCount(2);
    await page.mouse.up();
    await expect(viewport.locator(highlighted)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
    await expect
      .poll(() => writes)
      .toEqual([expect.objectContaining({ positionX: 252, positionY: 156 })]);
    await expect(table).toHaveCSS('top', '156px');
  });

  test('Alt suspend l’alignement et conserve le signal de passage serré', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Glisser-déposer à la souris.');
    const base = { ...demoFloorPlan.tables[1], width: 144, height: 104 };
    const writes = await mockTablePlacement(page, [
      { ...base, id: 't2', name: 'T2', positionX: 100, positionY: 250 },
      { ...base, id: 't13', name: 'T13', positionX: 257, positionY: 390 },
      { ...base, id: 't5', name: 'T5', positionX: 252, positionY: 80 },
    ]);
    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan');
    const table = page.getByRole('button', { name: 'T5 · 4 places' });
    await expect(table).toBeVisible();
    const box = (await table.boundingBox())!;
    const zoom = box.width / base.width;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 7 * zoom, y + 177 * zoom, { steps: 12 });
    await expect(table).toHaveCSS('top', '257px');
    await expect(table).toHaveCSS('left', '257px');
    const message = 'T5 · Passage serré près de T2';
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
    await page.keyboard.down('Alt');
    await expect(table).toHaveCSS('left', '259px');
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible();
    await page.mouse.up();
    await page.keyboard.up('Alt');
    await expect
      .poll(() => writes)
      .toEqual([expect.objectContaining({ positionX: 259, positionY: 257 })]);
    await expect(table).toHaveCSS('left', '259px');
    await expect(table).toHaveCSS('top', '257px');
  });

  test('garde le cadrage au bord pendant un glisser et permet de déplacer la vue', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Déplacement de vue à la souris.');
    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan');
    const viewport = page.getByRole('region', { name: 'Vue du plan' });
    const table = page.getByRole('button', { name: 'T3 · 4 places' });
    await expect(table).toBeVisible();
    await page.getByRole('button', { name: 'T1 · 2 places' }).click();
    await expect(
      page.getByText('Plateau', { exact: false }).filter({ hasText: 'm' }).first(),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fermer la fiche' })).toBeVisible();
    const readScroll = () => viewport.evaluate((element) => element.scrollLeft);
    await viewport.evaluate((element) => {
      element.scrollLeft = 140;
    });
    const before = await readScroll();
    expect(before).toBeGreaterThan(40);
    const view = (await viewport.boundingBox())!;
    const box = (await table.locator('[data-floor-top]').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(view.x + 18, box.y + box.height / 2, { steps: 10 });
    await page.waitForTimeout(260);
    expect(await readScroll()).toBe(before);
    await expect(page.getByRole('button', { name: 'Fermer la fiche' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();

    const pan = page.getByRole('button', { name: 'Déplacer la vue' });
    // Le capteur neutralise encore le clic de fin de glisser pendant 50 ms.
    await page.waitForTimeout(70);
    await pan.click();
    await expect(pan).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(view.x + 280, view.y + 120);
    await page.mouse.down();
    await page.mouse.move(view.x + 340, view.y + 120, { steps: 8 });
    await page.mouse.up();
    expect(await readScroll()).toBeLessThan(before);
    await page.keyboard.press('Escape');
    await expect(pan).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Voir toute la salle' }).click();
    const scale = () =>
      table.evaluate((node) => {
        const stage = node.closest('[style*="scale("]')!;
        return new DOMMatrix(getComputedStyle(stage).transform).a;
      });
    const fittedScale = await scale();
    await page.getByRole('button', { name: 'Zoom arrière' }).click();
    await expect.poll(scale).toBeLessThan(fittedScale);
    await page.keyboard.press('f');
    await expect.poll(scale).toBe(fittedScale);
  });

  test('affiche une table ronde et une fiche tactile dans le viewport iPhone', async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'iphone-13',
      'Validation spécifique au viewport iPhone 13.',
    );

    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan', {
      waitUntil: 'domcontentloaded',
    });

    const table = page.getByRole('button', { name: 'T1 · 2 places' });
    await table.click();

    const tableBody = table.locator('.bg-floor-table-surface').first();
    await expect(tableBody).toHaveClass(/rounded-full/);

    const sheet = page.getByLabel('Actions pour T1');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByLabel('Nom de la table')).toBeVisible();
    await expect(sheet.getByLabel('Augmenter la capacité')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Zoom arrière' })).toBeHidden();

    const sheetBox = await sheet.boundingBox();
    const viewport = page.viewportSize();
    expect(sheetBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect((sheetBox?.y ?? Number.POSITIVE_INFINITY) + (sheetBox?.height ?? 0)).toBeLessThanOrEqual(
      viewport?.height ?? 0,
    );

    await sheet.getByLabel('Augmenter la capacité').click();
    await expect(page.getByRole('button', { name: 'T1 · 3 places' })).toBeVisible();

    const tableName = sheet.getByLabel('Nom de la table');
    await tableName.fill('T1 bis');
    await tableName.blur();
    await expect(page.getByRole('button', { name: 'T1 bis · 3 places' })).toBeVisible();
  });

  test('adapte la hauteur du plan et garde les commandes dans la fenêtre', async ({
    page,
  }, testInfo) => {
    await page.goto('/dashboard/floor-plan?view=service-live&floorPlanId=e2e-floor-plan', {
      waitUntil: 'domcontentloaded',
    });

    const bar = page.getByRole('region', { name: 'État du service' });
    const plan = page.locator('#service-content');
    await expect(bar.getByLabel('Date du service')).toBeVisible();
    await expect(bar.getByRole('button', { name: "Liste d'attente" })).toBeVisible();
    await expect(plan.getByTestId('floor-plan-live-stage')).toBeVisible();

    const viewport = page.viewportSize()!;
    const box = (await plan.boundingBox())!;
    const bottomGap = viewport.height - box.y - box.height;
    expect(bottomGap).toBeGreaterThanOrEqual(0);
    expect(bottomGap).toBeLessThan(testInfo.project.name === 'desktop-1440' ? 40 : 110);

    const commandsFit = await bar.evaluate((element) => element.scrollWidth <= element.clientWidth);
    expect(commandsFit).toBe(true);

    await page.setViewportSize({ ...viewport, height: viewport.height + 150 });
    await expect
      .poll(async () => (await plan.boundingBox())!.height)
      .toBeGreaterThan(box.height + 140);
  });

  test('décale le plan à gauche de la fiche sans masquer de table', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Fiche latérale sur ordinateur.');
    await page.goto('/dashboard/floor-plan?view=service-live&floorPlanId=e2e-floor-plan');
    const stage = page.getByTestId('floor-plan-live-stage');
    const viewport = stage.locator('..');
    const table = stage.getByRole('button', { name: 'T4 · 6 places' });
    await expect(table).toBeVisible();
    const original = (await viewport.boundingBox())!;
    await table.click();
    const close = page.getByRole('button', { name: 'Fermer la fiche de la table' });
    await expect(close).toBeVisible();
    await expect(page.getByRole('button', { name: 'Walk-in' })).toBeVisible();
    await expect
      .poll(async () => (await viewport.boundingBox())!.width)
      .toBeLessThan(original.width - 250);
    await expect
      .poll(async () => {
        const bounds = (await viewport.boundingBox())!;
        const tables = await stage.getByRole('button', { name: /^T[134] ·/ }).all();
        const boxes = await Promise.all(tables.map((item) => item.boundingBox()));
        return (
          boxes.length === 3 &&
          boxes.every(
            (box) =>
              box && box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1,
          )
        );
      })
      .toBe(true);
    await close.click();
    await expect
      .poll(async () => (await viewport.boundingBox())!.width)
      .toBeCloseTo(original.width);
  });

  test('libère le canvas avec une fiche tactile sur iPad portrait', async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'ipad-mini',
      'Validation spécifique au viewport iPad Mini.',
    );

    await page.goto('/dashboard/floor-plan?view=edit-plan&floorPlanId=e2e-floor-plan', {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('button', { name: 'T1 · 2 places' }).click();

    const sheet = page.getByLabel('Actions pour T1');
    await expect(sheet).toBeVisible();
    await expect(page.getByText('Inspecteur', { exact: true })).toBeHidden();

    const sheetBox = await sheet.boundingBox();
    const viewport = page.viewportSize();
    expect(sheetBox).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(sheetBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(672);
    expect((sheetBox?.y ?? Number.POSITIVE_INFINITY) + (sheetBox?.height ?? 0)).toBeLessThanOrEqual(
      viewport?.height ?? 0,
    );
  });

  test('simule un placement direct sans ajouter de refus contradictoire', async ({ page }) => {
    await page.goto('/dashboard/floor-plan', { waitUntil: 'domcontentloaded' });
    await openSimulator(page);

    await page.locator('#sim-party-size').fill('2');
    await page.locator('#sim-starts-at').fill('2026-07-22T19:00');
    await page.getByRole('button', { name: 'Trouver une table' }).click();

    await expect(page.getByRole('heading', { name: 'Table T1 disponible' })).toBeVisible();
    await expect(page.getByText('Aucune table disponible', { exact: true })).toHaveCount(0);
  });

  test('propose une autre section quand la section préférée est pleine', async ({ page }) => {
    await page.goto('/dashboard/floor-plan', { waitUntil: 'domcontentloaded' });
    await openSimulator(page);

    await page.locator('#sim-party-size').fill('4');
    await page.locator('#sim-starts-at').fill('2026-07-22T19:00');
    await page.getByRole('combobox', { name: 'Zone souhaitée' }).click();
    await page.getByRole('option', { name: 'Terrasse' }).click();
    await page.getByRole('button', { name: 'Trouver une table' }).click();

    await expect(
      page.getByRole('heading', { name: 'Changement de section : Salle' }),
    ).toBeVisible();
  });

  test('propose le prochain créneau quand le restaurant est complet', async ({ page }) => {
    await page.goto('/dashboard/floor-plan', { waitUntil: 'domcontentloaded' });
    await openSimulator(page);

    await page.locator('#sim-party-size').fill('6');
    await page.locator('#sim-starts-at').fill('2026-07-22T19:00');
    await page.getByRole('button', { name: 'Trouver une table' }).click();

    // Le rendu suit le fuseau du navigateur (UTC en CI, Europe/Paris en local).
    await expect(page.getByText(/Prochain créneau : 22 juil\. \d{2}:30/)).toBeVisible();
  });
});
