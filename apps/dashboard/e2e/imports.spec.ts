import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * Parcours des deux imports par fichier (clients et tickets de caisse), avec une API simulée : le
 * dashboard tourne sans Clerk ni base, les réponses sont donc fabriquées ici, à l'image de l'API.
 * Le dossier `IMPORT_SHOTS_DIR`, s'il est défini, reçoit une capture de chaque étape.
 */

const XLSX_CLIENTS = readFileSync(path.resolve('e2e/fixtures/clients-excel.xlsx'));
const SHOTS = process.env.IMPORT_SHOTS_DIR;

type Body = {
  csv: string;
  dryRun: boolean;
  hasHeader?: boolean;
  lineOffset?: number;
  mapping?: Record<string, string | null>;
};

type Options = {
  /** Set by a test that wants one piece of a big import to fail the first time it is sent. */
  failPieceOnce?: boolean;
  /** Delay before a real import answers, so the progress bar can be seen. */
  importDelayMs?: number;
  pos?: boolean;
};

/** Mirrors the API's column detection enough for the screens: header names, then the mapping sent. */
function customersReply(body: Body) {
  const lines = body.csv.split('\n').filter((line) => line.trim() !== '');
  const withHeader = body.hasHeader !== false;
  const headers = withHeader
    ? lines[0]!.split(';')
    : lines[0]!.split(';').map((_, index) => `Colonne ${index + 1}`);
  const rows = withHeader ? lines.slice(1) : lines;
  const find = (...names: string[]) => headers.find((header) => names.includes(header));
  const detected = Object.fromEntries(
    Object.entries({
      lastName: find('Nom'),
      phone: find('Téléphone', 'Tel'),
      email: find('Email'),
    }).filter(([, column]) => column !== undefined),
  ) as Record<string, string>;
  const mapping = body.mapping
    ? (Object.fromEntries(Object.entries(body.mapping).filter(([, column]) => column)) as Record<
        string,
        string
      >)
    : detected;
  const phoneIndex = mapping.phone ? headers.indexOf(mapping.phone) : -1;
  const created =
    phoneIndex < 0 ? 0 : rows.filter((row) => row.split(';')[phoneIndex]?.trim()).length;
  return {
    data: {
      dryRun: body.dryRun,
      columns: { headers, headerLine: withHeader ? 1 : null, mapping, byContent: [] },
      counts: { created, completed: 0, skipped: rows.length - created },
      reasons: [],
      preview: rows.slice(0, 5).map((row) => {
        const cells = row.split(';');
        return {
          name: cells[0] ?? null,
          phone: phoneIndex >= 0 ? (cells[phoneIndex] ?? null) : null,
          email: null,
          birthMonth: null,
          birthDay: null,
        };
      }),
    },
  };
}

const TICKET_COLUMNS: Record<string, string> = {
  externalId: 'Numéro de ticket',
  openedAt: 'Ouverture',
  subtotal: 'Sous-total',
  tax: 'TVA',
  total: 'Total',
};

function ticketsReply(body: Body) {
  const lines = body.csv.split('\n').filter((line) => line.trim() !== '');
  const headers = lines[0]!.split(';');
  const rows = lines.slice(1);
  const mapping = Object.fromEntries(
    Object.entries(TICKET_COLUMNS).filter(([, column]) => headers.includes(column)),
  );
  const missing = Object.keys(TICKET_COLUMNS).filter((field) => !mapping[field]);
  return {
    data: {
      dryRun: body.dryRun,
      columns: { headers, headerLine: 1, mapping, byContent: [] },
      missing,
      counts: {
        imported: rows.length,
        skipped: 0,
        withReservation: 0,
        matched: 0,
        toReview: rows.length,
      },
      reasons: [],
      preview: rows.slice(0, 5).map((row) => {
        const cells = row.split(';');
        return { externalId: cells[0] ?? '', openedAt: '', tableReference: null, total: '13.50' };
      }),
    },
  };
}

/** Two tickets to check: one per decision, so a confirm and a reject can both be seen. */
const REVIEW_TICKETS = [ticketFixture('c3', 'T-3', '12'), ticketFixture('c4', 'T-4', '7')];

function ticketFixture(id: string, externalId: string, table: string) {
  return {
    id,
    externalId,
    openedAt: '2026-12-31T19:15:00.000Z',
    closedAt: null,
    tableReference: table,
    total: '13.50',
    currency: 'EUR',
    match: {
      status: 'REVIEW',
      confidence: 0.62,
      reservation: { id: `r-${id}`, at: '2026-12-31T19:15:00.000Z', partySize: 2, table },
    },
  };
}

async function installApi(page: Page, options: Options = {}) {
  let failed = false;
  const imports: Body[] = [];
  const decisions: string[] = [];
  await page.route('**/api/proxy/**', async (route: Route) => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.replace('/api/proxy/', '');
    const reply = (status: number, json: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });

    if (endpoint.startsWith('companion/')) return reply(503, { error: 'indisponible' });
    if (endpoint === 'entitlements') {
      return reply(200, {
        capabilities: { 'customers.basic': true, 'pos.connect': options.pos === true },
      });
    }
    if (endpoint === 'customers/import' && request.method() === 'POST') {
      const body = request.postDataJSON() as Body;
      imports.push(body);
      if (!body.dryRun) {
        if (options.importDelayMs)
          await new Promise((resolve) => setTimeout(resolve, options.importDelayMs));
        if (options.failPieceOnce && !failed && (body.lineOffset ?? 0) > 0) {
          failed = true;
          return reply(500, {
            error: 'TIMEOUT',
            message: 'Le serveur a mis trop de temps à répondre.',
          });
        }
      }
      return reply(200, customersReply(body));
    }
    if (endpoint === 'pos/connections') {
      return reply(200, {
        data: [
          { provider: 'csv-file', status: 'ACTIVE', lastSuccessAt: '2026-11-09T19:30:00.000Z' },
        ],
      });
    }
    if (endpoint === 'pos/checks/csv-import' && request.method() === 'POST') {
      const body = request.postDataJSON() as Body;
      imports.push(body);
      return reply(200, ticketsReply(body));
    }
    // The path has no query string: the list is read from `pos/checks?limit=…`.
    if (endpoint === 'pos/checks' && request.method() === 'GET') {
      return reply(200, {
        data: { items: REVIEW_TICKETS.filter((t) => !decisions.includes(t.id)), nextCursor: null },
      });
    }
    const review = /^pos\/checks\/([^/]+)\/review$/.exec(endpoint);
    if (review && request.method() === 'POST') {
      const { decision } = request.postDataJSON() as { decision: 'confirm' | 'reject' };
      decisions.push(review[1]!);
      return reply(200, { data: { status: decision === 'confirm' ? 'MATCHED' : 'UNMATCHED' } });
    }
    return reply(200, { data: [], items: [], nextCursor: null, total: 0 });
  });
  return { imports, decisions };
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
}

function csvFile(content: string, name = 'clients.csv') {
  return { name, mimeType: 'text/csv', buffer: Buffer.from(content, 'utf-8') };
}

async function openCustomerImport(page: Page) {
  await page.goto('/dashboard/customers');
  await page.getByRole('button', { name: 'Importer', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Importer des clients' })).toBeVisible();
}

test.describe('Import clients', () => {
  test('CSV reconnu : le résumé s’affiche tout seul, sans écran de colonnes', async ({ page }) => {
    await installApi(page);
    await openCustomerImport(page);

    await page
      .getByLabel('Fichier à importer')
      .setInputFiles(
        csvFile(
          'Nom;Téléphone;Email\nAlice Martin;0612345678;alice@example.fr\nBruno Petit;0611223344;\n',
        ),
      );

    await expect(page.getByText('2 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Modifier les colonnes' })).toBeVisible();
    await expect(page.getByLabel('Téléphone', { exact: true })).toHaveCount(0);
    await shot(page, 'clients-reconnu');

    await page.getByRole('button', { name: 'Importer 2 client(s)' }).click();
    await expect(page.getByText('2 créé(s) · 0 complété(s) · 0 ignoré(s)')).toBeVisible();
  });

  test('colonne inconnue : l’écran des colonnes s’ouvre et l’import attend le choix', async ({
    page,
  }) => {
    await installApi(page);
    await openCustomerImport(page);

    await page
      .getByLabel('Fichier à importer')
      .setInputFiles(csvFile('Ref;Qui;Contact\nA1;Alice;0612345678\n'));

    await expect(page.getByText(/Choisissez une colonne pour Téléphone/)).toBeVisible();
    const importButton = page.getByRole('button', { name: /Importer/ });
    await expect(importButton).toBeDisabled();
    await shot(page, 'clients-colonne-inconnue');

    await page.getByLabel('Téléphone', { exact: true }).selectOption('Contact');

    await expect(page.getByText('1 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();
    await expect(importButton).toBeEnabled();
  });

  test('Excel .xlsx accepté tel quel : le numéro sans 0 est lu comme un téléphone', async ({
    page,
  }) => {
    const api = await installApi(page);
    await openCustomerImport(page);

    await page.getByLabel('Fichier à importer').setInputFiles({
      name: 'clients-excel.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer: XLSX_CLIENTS,
    });

    await expect(page.getByText('2 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();
    // The browser converted the first sheet: the phone cell arrives as text, without its 0.
    expect(api.imports[0]?.csv).toContain('Alice Martin;612345678;alice@example.fr');
    await shot(page, 'clients-xlsx');
  });

  test('gros fichier : découpé en morceaux avec progression et compte rendu cumulé', async ({
    page,
  }) => {
    const api = await installApi(page, { importDelayMs: 500 });
    await openCustomerImport(page);
    const rows = Array.from(
      { length: 12_000 },
      (_, i) => `Client ${i};06${String(i).padStart(8, '0')}`,
    );

    await page
      .getByLabel('Fichier à importer')
      .setInputFiles(csvFile(['Nom;Téléphone', ...rows].join('\n'), 'gros.csv'));
    await expect(page.getByText('12000 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();
    expect(api.imports.filter((body) => body.dryRun).length).toBeGreaterThan(2);
    await expect(page.getByText(/découpez/i)).toHaveCount(0);

    await page.getByRole('button', { name: 'Importer 12000 client(s)' }).click();
    await expect(page.getByRole('progressbar', { name: 'Avancement de l’import' })).toBeVisible();
    await shot(page, 'clients-progression');

    await expect(page.getByText(/Fichier importé en \d+ morceaux\./)).toBeVisible();
    await expect(page.getByText('12000 créé(s) · 0 complété(s) · 0 ignoré(s)')).toBeVisible();
    // Line numbers of the original file are kept: a later piece starts after the first ones.
    const lineOffsets = api.imports
      .filter((body) => !body.dryRun)
      .map((body) => body.lineOffset ?? 0);
    expect(lineOffsets[0]).toBe(0);
    expect(Math.max(...lineOffsets)).toBeGreaterThan(0);
  });

  test('un morceau en échec : les précédents restent, et on peut reprendre', async ({ page }) => {
    await installApi(page, { failPieceOnce: true });
    await openCustomerImport(page);
    const rows = Array.from(
      { length: 12_000 },
      (_, i) => `Client ${i};06${String(i).padStart(8, '0')}`,
    );
    await page
      .getByLabel('Fichier à importer')
      .setInputFiles(csvFile(['Nom;Téléphone', ...rows].join('\n'), 'gros.csv'));
    await expect(page.getByText('12000 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();

    await page.getByRole('button', { name: 'Importer 12000 client(s)' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText(/Le morceau 2 sur \d+ n’a pas pu être importé/);
    await expect(alert).toContainText('Les morceaux précédents sont bien enregistrés');
    await shot(page, 'clients-echec-morceau');

    await page.getByRole('button', { name: 'Reprendre à partir du morceau 2' }).click();
    await expect(page.getByText(/Fichier importé en \d+ morceaux\./)).toBeVisible();
  });

  test('clavier seul : Entrée ouvre le choix du fichier, Échap ferme le dialogue', async ({
    page,
  }) => {
    await installApi(page);
    await openCustomerImport(page);

    const dropzone = page.getByRole('button', {
      name: 'Déposer un fichier, ou cliquer pour le choisir',
    });
    await dropzone.focus();
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.keyboard.press('Enter'),
    ]);
    await chooser.setFiles(csvFile('Nom;Téléphone\nAlice;0612345678\n'));
    await expect(page.getByText('1 à créer · 0 à compléter · 0 ignorée(s)')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Importer des clients' })).toHaveCount(0);
  });
});

test.describe('Import tickets de caisse', () => {
  test('tickets : importer, puis confirmer et rejeter un ticket à vérifier', async ({ page }) => {
    const api = await installApi(page, { pos: true });
    await page.goto('/dashboard/caisse');

    await page.getByRole('button', { name: 'Importer un fichier CSV' }).click();
    await page
      .getByLabel('Fichier à importer')
      .setInputFiles(
        csvFile(
          'Numéro de ticket;Ouverture;Sous-total;TVA;Total\nT-1;31/12/2026 20:15;12,50;2,08;13,50\n',
          'tickets.csv',
        ),
      );
    await expect(page.getByText('1 ticket(s) à importer · 0 ignoré(s)')).toBeVisible();
    await shot(page, 'tickets-resume');
    await page.getByRole('button', { name: 'Importer 1 ticket(s)' }).click();
    await expect(page.getByText(/1 importé\(s\) · 0 ignoré\(s\)/)).toBeVisible();
    expect(api.imports.at(-1)?.csv).toContain('T-1');

    // Close the dialog, then decide on the tickets waiting for a review.
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Confirmer le rapprochement du ticket T-3' }),
    ).toBeVisible();
    await shot(page, 'tickets-a-verifier');

    await page.getByRole('button', { name: 'Confirmer le rapprochement du ticket T-3' }).click();
    await expect(
      page.getByRole('button', { name: 'Confirmer le rapprochement du ticket T-3' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Rejeter le rapprochement du ticket T-4' }).click();
    await expect(
      page.getByRole('button', { name: 'Rejeter le rapprochement du ticket T-4' }),
    ).toHaveCount(0);
    await expect(page.getByText('Rapproché · ')).toBeVisible();
    await expect(page.getByText('Non rapproché')).toBeVisible();
    await shot(page, 'tickets-decides');
  });
});
