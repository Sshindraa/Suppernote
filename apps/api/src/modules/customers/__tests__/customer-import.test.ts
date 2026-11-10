import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import {
  IMPORT_CSV_MAX_CHARS,
  applyCustomerImport,
  parseBirthday,
  readCustomerImport,
} from '../customer-import';
import { parseCsv } from '@suppernote/shared';

describe('customer-import: lecture CSV', () => {
  it('lit les guillemets, les points-virgules, les retours à la ligne et le BOM', () => {
    const csv = '﻿Nom;Notes\r\n"Dupont; Jean";"Ligne 1\nLigne 2 ""citée"""\r\n';
    const records = parseCsv(csv);
    expect(records).toEqual([
      { line: 1, cells: ['Nom', 'Notes'] },
      { line: 2, cells: ['Dupont; Jean', 'Ligne 1\nLigne 2 "citée"'] },
    ]);
  });

  it('détecte le séparateur virgule quand l’en-tête l’utilise', () => {
    const records = parseCsv('Name,Phone\nAlice,0612345678\n');
    expect(records[1].cells).toEqual(['Alice', '0612345678']);
  });

  it('détecte les colonnes par synonymes, accents et casse', () => {
    const reading = readCustomerImport(
      'Prénom;NOM;Téléphone mobile;E-mail;Date de naissance\nJean;Dupont;0612345678;a@b.fr;14/02\n',
    );
    expect(reading.mapping).toEqual({
      firstName: 'Prénom',
      lastName: 'NOM',
      phone: 'Téléphone mobile',
      email: 'E-mail',
      birthday: 'Date de naissance',
    });
    expect(reading.byContent).toEqual([]);
  });

  it('reconnaît le téléphone et l’e-mail par leur contenu quand l’en-tête est inconnu', () => {
    const reading = readCustomerImport(
      'Ref;Qui;Contact;Adresse\nA1;Jean;06 12 34 56 78;jean@example.com\nA2;Léa;0611223344;lea@example.com\n',
    );
    expect(reading.mapping).toMatchObject({ phone: 'Contact', email: 'Adresse' });
    expect(reading.byContent).toEqual(['phone', 'email']);
    expect(reading.lines[0]).toMatchObject({ phone: '+33612345678', email: 'jean@example.com' });
  });

  it('lit un fichier sans en-tête et saute les lignes de titre', () => {
    const headerless = readCustomerImport('Jean;0612345678\nLéa;0611223344\n');
    expect(headerless.headerLine).toBeNull();
    expect(headerless.lines.map((line) => line.phone)).toEqual(['+33612345678', '+33611223344']);

    const titled = readCustomerImport('Export du 10/11\n\nNom;Téléphone\nJean;0612345678\n');
    expect(titled.headerLine).toBe(3);
    expect(titled.lines[0]?.line).toBe(4);
  });

  it('rend le 0 ou le + qu’Excel retire aux téléphones saisis comme des nombres', () => {
    const reading = readCustomerImport(
      'Nom;Téléphone\nAlice;612345678\nBob;33612345678\nCléo;06 12 34 56 78\n',
    );
    expect(reading.lines.map((line) => line.phone)).toEqual([
      '+33612345678',
      '+33612345678',
      '+33612345678',
    ]);
  });

  it('reconnaît un téléphone à neuf chiffres par son contenu, mais pas un montant ou un total', () => {
    const byValues = readCustomerImport('Ref;Contact\nA1;612345678\nA2;611223344\n');
    expect(byValues.mapping.phone).toBe('Contact');
    expect(byValues.byContent).toEqual(['phone']);

    const amounts = readCustomerImport('Ref;Montant Total\nA1;612345678\nA2;611223344\n');
    expect(amounts.mapping.phone).toBeUndefined();
    expect(amounts.byContent).toEqual([]);
  });

  it('garde les numéros de ligne du fichier d’origine quand le fichier est découpé', () => {
    const reading = readCustomerImport('Nom;Téléphone\nJean;0612345678\n', undefined, {
      hasHeader: true,
      lineOffset: 999,
    });
    expect(reading.lines[0]?.line).toBe(1001);
  });

  it('normalise le téléphone, compose le nom et ignore les valeurs invalides', () => {
    const reading = readCustomerImport(
      'Prénom;Nom;Téléphone;Email;Anniversaire\nJean;Dupont;06 12 34 56 78;JEAN@Example.com;14/02\nSans;Numéro;abc;pas-un-mail;32/13\n',
    );
    expect(reading.lines[0]).toMatchObject({
      name: 'Jean Dupont',
      phone: '+33612345678',
      email: 'jean@example.com',
      birthMonth: 2,
      birthDay: 14,
    });
    expect(reading.lines[1]).toMatchObject({ phone: null, email: null, birthMonth: null });
  });

  it('accepte les dates JJ/MM/AAAA et AAAA-MM-JJ, refuse les dates impossibles', () => {
    expect(parseBirthday('05/07/1980')).toEqual({ month: 7, day: 5 });
    expect(parseBirthday('1990-11-30')).toEqual({ month: 11, day: 30 });
    expect(parseBirthday('31/02')).toBeNull();
  });

  it('refuse une correspondance vers une colonne absente du fichier', () => {
    expect(() => readCustomerImport('Nom;Téléphone\nA;0612345678\n', { phone: 'Mail' })).toThrow(
      'Colonne introuvable',
    );
  });
});

describe('customer-import: application', () => {
  const restaurantId = 'test-rest-1';
  const csv =
    'Nom;Téléphone;Email;Notes\nNouveau;0612345678;new@example.com;Note\n;0611111111;;\n;abc;;\n';

  type StoredRow = { id: string; phone: string; emailNormalized: string | null };

  /** Transaction client that remembers what each batch inserted, like the database would. */
  function fakeTx() {
    let stored: StoredRow[] = [];
    const tx = {
      customer: {
        createMany: vi.fn(async (args: { data: StoredRow[] }) => {
          stored = args.data;
          return { count: args.data.length };
        }),
        findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
          stored.filter((row) => args.where.id.in.includes(row.id)),
        ),
        update: vi.fn(async () => ({ id: 'c1' })),
      },
      customerIdentity: { createMany: vi.fn(async () => ({ count: 0 })) },
    };
    vi.mocked(db.$transaction).mockImplementation((async (fn: (t: unknown) => unknown) =>
      fn(tx)) as never);
    return tx;
  }

  const existingRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'c1',
    phone: '+33612345678',
    name: 'Alice',
    emailNormalized: null,
    birthMonth: null,
    notes: 'Note du gérant',
    archivedAt: null,
    mergedIntoId: null,
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.customer.findMany).mockResolvedValue([] as never);
  });

  it('dryRun ne fait aucune écriture', async () => {
    const tx = fakeTx();
    const outcome = await applyCustomerImport(restaurantId, readCustomerImport(csv), true);
    expect(outcome.counts).toEqual({ created: 2, completed: 0, skipped: 1 });
    expect(outcome.reasons).toEqual([{ line: 4, reason: 'Téléphone absent ou invalide' }]);
    expect(outcome.preview[0]).toMatchObject({ name: 'Nouveau', phone: '+33612345678' });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(tx.customer.createMany).not.toHaveBeenCalled();
  });

  it('complète un client existant sans jamais écraser un champ rempli', async () => {
    const tx = fakeTx();
    vi.mocked(db.customer.findMany).mockResolvedValue([existingRow()] as never);

    const reading = readCustomerImport(
      'Nom;Téléphone;Email;Notes;Anniversaire\nAutre nom;0612345678;a@example.com;Autre note;05/07\n',
    );
    const outcome = await applyCustomerImport(restaurantId, reading, false);

    expect(outcome.counts).toEqual({ created: 0, completed: 1, skipped: 0 });
    expect(tx.customer.createMany).not.toHaveBeenCalled();
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1', restaurantId },
      select: { id: true },
      data: { emailNormalized: 'a@example.com', birthMonth: 7, birthDay: 5 },
    });
  });

  it('n’écrit l’identité e-mail que si l’e-mail a été posé sur la fiche', async () => {
    const tx = fakeTx();
    vi.mocked(db.customer.findMany).mockResolvedValue([
      existingRow({ name: null, emailNormalized: 'ancien@example.com' }),
    ] as never);

    const outcome = await applyCustomerImport(
      restaurantId,
      readCustomerImport('Nom;Téléphone;Email\nAlice;0612345678;nouveau@example.com\n'),
      false,
    );

    expect(outcome.counts.completed).toBe(1);
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1', restaurantId },
      select: { id: true },
      data: { name: 'Alice' },
    });
    expect(tx.customerIdentity.createMany).not.toHaveBeenCalled();
  });

  it('rapproche un ancien numéro « 06… » sans créer de doublon', async () => {
    const tx = fakeTx();
    vi.mocked(db.customer.findMany).mockResolvedValue([
      existingRow({ phone: '0612345678', name: null }),
    ] as never);

    const outcome = await applyCustomerImport(
      restaurantId,
      readCustomerImport('Nom;Téléphone\nAlice;+33612345678\n'),
      false,
    );

    expect(vi.mocked(db.customer.findMany).mock.calls[0][0]).toMatchObject({
      where: { restaurantId, phone: { in: ['+33612345678', '0612345678'] } },
    });
    expect(outcome.counts).toEqual({ created: 0, completed: 1, skipped: 0 });
    expect(tx.customer.createMany).not.toHaveBeenCalled();
  });

  it('ignore une ligne déjà à jour et une ligne en double dans le fichier', async () => {
    vi.mocked(db.customer.findMany).mockResolvedValue([
      existingRow({ emailNormalized: 'a@example.com', birthMonth: 1 }),
    ] as never);
    const reading = readCustomerImport(
      'Nom;Téléphone;Email\nAlice;0612345678;a@example.com\nBob;0612345678;\n',
    );
    const outcome = await applyCustomerImport(restaurantId, reading, true);
    expect(outcome.counts).toEqual({ created: 0, completed: 0, skipped: 2 });
    expect(outcome.reasons).toEqual([
      { line: 2, reason: 'Client existant, rien à compléter' },
      { line: 3, reason: 'Numéro déjà présent plus haut dans le fichier' },
    ]);
  });

  it('crée par lots de 1 000 clients', async () => {
    const tx = fakeTx();
    const rows = Array.from({ length: 2_500 }, (_, i) => `C${i};06${String(i).padStart(8, '0')}`);
    const reading = readCustomerImport(`Nom;Téléphone\n${rows.join('\n')}\n`);

    const outcome = await applyCustomerImport(restaurantId, reading, false);

    expect(outcome.counts).toEqual({ created: 2_500, completed: 0, skipped: 0 });
    const batches = tx.customer.createMany.mock.calls.map(([args]) => args.data.length);
    expect(batches).toEqual([1_000, 1_000, 500]);
  });

  it('ne compte comme créée que la ligne réellement insérée (création concurrente)', async () => {
    const tx = fakeTx();
    tx.customer.findMany.mockImplementation(async () => []);
    const reading = readCustomerImport('Nom;Téléphone\nAlice;0612345678\nBob;0611111111\n');

    const outcome = await applyCustomerImport(restaurantId, reading, false);

    expect(outcome.counts).toEqual({ created: 0, completed: 0, skipped: 2 });
    expect(outcome.reasons).toEqual([
      { line: 2, reason: 'Client créé en même temps par une autre saisie' },
      { line: 3, reason: 'Client créé en même temps par une autre saisie' },
    ]);
    expect(tx.customerIdentity.createMany).not.toHaveBeenCalled();
  });

  it('ne déclare aucun client créé quand la transaction du lot échoue', async () => {
    vi.mocked(db.$transaction).mockRejectedValue(new Error('connexion perdue'));
    const reading = readCustomerImport('Nom;Téléphone\nAlice;0612345678\n');

    const outcome = await applyCustomerImport(restaurantId, reading, false);

    expect(outcome.counts).toEqual({ created: 0, completed: 0, skipped: 1 });
    expect(outcome.reasons).toEqual([{ line: 2, reason: 'Enregistrement impossible' }]);
  });
});

describe('POST /customers/import', () => {
  afterAll(async () => {
    await closeApp();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({ plan: 'ESSENTIAL' } as never);
    vi.mocked(db.customer.findMany).mockResolvedValue([] as never);
  });

  const post = async (role: string, payload: unknown) => {
    const app = await getApp();
    return app.inject({
      method: 'POST',
      url: '/customers/import',
      headers: { authorization: 'Bearer test', 'x-test-site-role': role },
      payload: payload as Record<string, unknown>,
    });
  };

  it('refuse un non-propriétaire', async () => {
    const response = await post('MANAGER', { csv: 'Nom;Téléphone\nA;0612345678\n', dryRun: true });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe('CUSTOMER_IMPORT_OWNER_REQUIRED');
  });

  it('répond aux compteurs en dryRun, sans donnée personnelle dans les raisons', async () => {
    const response = await post('OWNER', { csv: 'Nom;Téléphone\nA;abc\n', dryRun: true });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.counts).toEqual({ created: 0, completed: 0, skipped: 1 });
    expect(response.json().data.reasons).toEqual([
      { line: 2, reason: 'Téléphone absent ou invalide' },
    ]);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuse plus de 10 000 lignes sans rien importer', async () => {
    const rows = Array.from(
      { length: 10_001 },
      (_, i) => `C${i};0600${String(i).padStart(6, '0')}`,
    );
    const response = await post('OWNER', {
      csv: `Nom;Téléphone\n${rows.join('\n')}\n`,
      dryRun: false,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe('CUSTOMER_IMPORT_TOO_LARGE');
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('refuse un CSV au-delà de la taille que nginx laisse passer', async () => {
    const response = await post('OWNER', {
      csv: `Nom;Téléphone\n${'x'.repeat(IMPORT_CSV_MAX_CHARS)}`,
      dryRun: true,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_CUSTOMER_IMPORT');
  });

  it('refuse un corps invalide', async () => {
    const response = await post('OWNER', { csv: '', dryRun: true });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_CUSTOMER_IMPORT');
  });
});
