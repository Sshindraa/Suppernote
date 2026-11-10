import { describe, expect, it } from 'vitest';
import { looksLikeDate, looksLikePhone, looksLikeEmail, looksLikeAmount } from './csv';
import { readTable, splitCsvText } from './csv-table';

const SYNONYMS = {
  phone: ['telephone', 'tel', 'mobile'],
  email: ['email', 'mail'],
  name: ['nom', 'client'],
} as const;
type F = keyof typeof SYNONYMS;
const FIELDS: F[] = ['name', 'phone', 'email'];
const TESTERS = { phone: looksLikePhone, email: looksLikeEmail };

describe('readTable', () => {
  it('lit l’en-tête par son nom et donne sa ligne', () => {
    const reading = readTable('Nom;Téléphone\nAlice;0612345678\n', {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
    });
    expect(reading.headerLine).toBe(1);
    expect(reading.mapping).toEqual({ name: 'Nom', phone: 'Téléphone' });
    expect(reading.byContent).toEqual([]);
    expect(reading.rows).toHaveLength(1);
  });

  it('saute les lignes de titre au-dessus de l’en-tête', () => {
    const reading = readTable('Export clients 2024\n\nNom;Téléphone\nAlice;0612345678\n', {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
    });
    expect(reading.headerLine).toBe(3);
    expect(reading.rows.map((row) => row.line)).toEqual([4]);
  });

  it('reconnaît une colonne téléphone et e-mail par son contenu quand l’en-tête est inconnu', () => {
    const csv = [
      'Ref;Qui;Contact;Adresse',
      'A1;Alice;0612345678;alice@example.fr',
      'A2;Bruno;06 11 22 33 44;bruno@example.fr',
      'A3;Chloé;+33 6 55 44 33 22;chloe@example.fr',
    ].join('\n');
    const reading = readTable(csv, {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
    });
    expect(reading.mapping.phone).toBe('Contact');
    expect(reading.mapping.email).toBe('Adresse');
    expect(reading.byContent).toEqual(['phone', 'email']);
    expect(reading.missing).toEqual([]);
  });

  it('garde l’en-tête quand il est reconnu, même si le contenu dit autre chose', () => {
    const reading = readTable('Nom;Mobile\nAlice;0612345678\n', {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
    });
    expect(reading.mapping.phone).toBe('Mobile');
    expect(reading.byContent).toEqual([]);
  });

  it('traite un fichier sans en-tête : toutes les lignes sont des données', () => {
    const csv = 'Alice;0612345678\nBruno;0611223344\n';
    const reading = readTable(csv, {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
      hasHeader: false,
    });
    expect(reading.headerLine).toBeNull();
    expect(reading.headers).toEqual(['Colonne 1', 'Colonne 2']);
    expect(reading.rows).toHaveLength(2);
    expect(reading.mapping.phone).toBe('Colonne 2');
    expect(reading.byContent).toEqual(['phone']);
  });

  it('ne devine pas quand deux colonnes ressemblent à un téléphone', () => {
    const csv = 'Ref;Tel1;Tel2\nA1;0612345678;0611223344\nA2;0622334455;0633445566\n';
    const reading = readTable(csv, {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      testers: TESTERS,
    });
    expect(reading.mapping.phone).toBeUndefined();
    expect(reading.missing).toEqual(['phone']);
  });

  it('applique la correspondance demandée sans rien deviner, et refuse une colonne absente', () => {
    const csv = 'Nom;Tel\nAlice;0612345678\n';
    const reading = readTable(csv, {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      requested: { phone: 'Tel', name: null, email: null },
    });
    expect(reading.mapping).toEqual({ phone: 'Tel' });
    expect(() =>
      readTable(csv, {
        synonyms: SYNONYMS,
        fields: FIELDS,
        required: [],
        requested: { phone: 'Absente' },
      }),
    ).toThrow('Colonne introuvable dans le fichier : Absente');
  });

  it('décale les numéros de ligne avec lineOffset', () => {
    const reading = readTable('Nom;Tel\nAlice;0612345678\n', {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      lineOffset: 100,
    });
    expect(reading.headerLine).toBe(101);
    expect(reading.rows[0]?.line).toBe(102);
  });
});

describe('testeurs de contenu', () => {
  it('reconnaît téléphones, e-mails, dates et montants', () => {
    expect(looksLikePhone('06 12 34 56 78')).toBe(true);
    expect(looksLikePhone('12345')).toBe(false);
    expect(looksLikeEmail('a@b.fr')).toBe(true);
    expect(looksLikeEmail('pas un mail')).toBe(false);
    expect(looksLikeDate('12/03/2026 19:30')).toBe(true);
    expect(looksLikeDate('2026-03-12 19:30:00')).toBe(true);
    expect(looksLikeDate('douze')).toBe(false);
    expect(looksLikeAmount('12,50')).toBe(true);
    expect(looksLikeAmount('12.50 €')).toBe(true);
    expect(looksLikeAmount('0612345678')).toBe(false);
  });
});

describe('splitCsvText', () => {
  const header = 'Nom;Téléphone';
  const rows = Array.from({ length: 7 }, (_, i) => `Client ${i + 1};06000000${i}`);
  const text = [header, ...rows].join('\n');

  it('répète l’en-tête et garde le numéro de ligne d’origine', () => {
    const pieces = splitCsvText(text, { headerLine: 1, maxChars: 10_000, maxRows: 3 });
    expect(pieces.map((piece) => piece.rows)).toEqual([3, 3, 1]);
    expect(pieces[0]?.csv.startsWith(`${header}\n`)).toBe(true);

    // La 2e pièce commence à la ligne 5 du fichier d’origine (en-tête + 3 lignes).
    const second = readTable(pieces[1]!.csv, {
      synonyms: SYNONYMS,
      fields: FIELDS,
      required: ['phone'],
      lineOffset: pieces[1]!.lineOffset,
    });
    expect(second.rows.map((row) => row.line)).toEqual([5, 6, 7]);
  });

  it('respecte la taille maximale et ne coupe jamais une ligne', () => {
    const pieces = splitCsvText(text, { headerLine: 1, maxChars: 60, maxRows: 100 });
    expect(pieces.length).toBeGreaterThan(1);
    const total = pieces.reduce((sum, piece) => sum + piece.rows, 0);
    expect(total).toBe(7);
    for (const piece of pieces) {
      const lines = piece.csv.split('\n');
      expect(lines[0]).toBe(header);
      for (const line of lines.slice(1)) expect(line).toMatch(/^Client \d;06000000\d$/);
    }
  });

  it('garde une cellule entre guillemets sur une seule pièce', () => {
    const quoted = `${header}\n"Dupont\nJean";0612345678\nAlice;0611223344\n`;
    const pieces = splitCsvText(quoted, { headerLine: 1, maxChars: 200, maxRows: 100 });
    expect(pieces.map((piece) => piece.rows)).toEqual([2]);
    expect(pieces[0]?.csv).toContain('"Dupont\nJean";0612345678');
  });

  it('sans en-tête, les pièces ne répètent aucune ligne', () => {
    const pieces = splitCsvText(rows.join('\n'), {
      headerLine: null,
      maxChars: 10_000,
      maxRows: 4,
    });
    expect(pieces.map((piece) => piece.rows)).toEqual([4, 3]);
    expect(pieces[1]?.csv.startsWith('Client 5')).toBe(true);
    expect(pieces[1]?.lineOffset).toBe(4);
  });
});
