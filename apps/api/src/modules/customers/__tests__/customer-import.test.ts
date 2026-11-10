import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';
import {
  applyCustomerImport,
  detectMapping,
  parseBirthday,
  parseCsv,
  readCustomerImport,
} from '../customer-import';

vi.mock('../customer-crm.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../customer-crm.service')>();
  return { ...actual, upsertCustomerIdentity: vi.fn(async () => ({ status: 'created' })) };
});

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
    const mapping = detectMapping([
      'Prénom',
      'NOM',
      'Téléphone mobile',
      'E-mail',
      'Date de naissance',
    ]);
    expect(mapping).toEqual({
      firstName: 'Prénom',
      lastName: 'NOM',
      phone: 'Téléphone mobile',
      email: 'E-mail',
      birthday: 'Date de naissance',
    });
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('dryRun ne fait aucune écriture', async () => {
    vi.mocked(db.customer.findMany).mockResolvedValue([] as never);
    const outcome = await applyCustomerImport(restaurantId, readCustomerImport(csv), true);
    expect(outcome.counts).toEqual({ created: 2, completed: 0, skipped: 1 });
    expect(outcome.reasons).toEqual([{ line: 4, reason: 'Téléphone absent ou invalide' }]);
    expect(outcome.preview[0]).toMatchObject({ name: 'Nouveau', phone: '+33612345678' });
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it('complète un client existant sans jamais écraser un champ rempli', async () => {
    const tx = {
      customer: {
        create: vi.fn(async () => ({ id: 'new' })),
        update: vi.fn(async () => ({ id: 'c1' })),
      },
    };
    vi.mocked(db.$transaction).mockImplementation((async (fn: (t: unknown) => unknown) =>
      fn(tx)) as never);
    vi.mocked(db.customer.findMany).mockResolvedValue([
      {
        id: 'c1',
        phone: '+33612345678',
        name: 'Alice',
        emailNormalized: null,
        birthMonth: null,
        notes: 'Note du gérant',
        archivedAt: null,
        mergedIntoId: null,
      },
    ] as never);

    const reading = readCustomerImport(
      'Nom;Téléphone;Email;Notes;Anniversaire\nAutre nom;0612345678;a@example.com;Autre note;05/07\n',
    );
    const outcome = await applyCustomerImport(restaurantId, reading, false);

    expect(outcome.counts).toEqual({ created: 0, completed: 1, skipped: 0 });
    expect(tx.customer.create).not.toHaveBeenCalled();
    expect(tx.customer.update).toHaveBeenCalledWith({
      where: { id: 'c1', restaurantId: 'test-rest-1' },
      data: { emailNormalized: 'a@example.com', birthMonth: 7, birthDay: 5 },
    });
  });

  it('ignore une ligne déjà à jour et une ligne en double dans le fichier', async () => {
    vi.mocked(db.customer.findMany).mockResolvedValue([
      {
        id: 'c1',
        phone: '+33612345678',
        name: 'Alice',
        emailNormalized: 'a@example.com',
        birthMonth: 1,
        notes: 'Déjà',
        archivedAt: null,
        mergedIntoId: null,
      },
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

  it('refuse un corps invalide', async () => {
    const response = await post('OWNER', { csv: '', dryRun: true });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('INVALID_CUSTOMER_IMPORT');
  });
});
