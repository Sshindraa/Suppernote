import { describe, expect, it } from 'vitest';
import {
  parseFrenchAmount,
  parseParisDateTime,
  POS_CSV_ROW_LIMIT,
  readPosCheckCsv,
} from '../pos-check-csv';

const HEADER =
  'Numéro de ticket;Ouverture;Clôture;Table;Sous-total;TVA;Pourboire;Remise;Total;Couverts';

describe('pos-check-csv: dates et montants', () => {
  it('lit les dates françaises comme heure de Paris, hiver et été', () => {
    expect(parseParisDateTime('31/12/2026 20:15')?.toISOString()).toBe('2026-12-31T19:15:00.000Z');
    expect(parseParisDateTime('01/07/2026 20:15')?.toISOString()).toBe('2026-07-01T18:15:00.000Z');
  });

  it('refuse une date sans heure et une date impossible', () => {
    expect(parseParisDateTime('31/12/2026')).toBeNull();
    expect(parseParisDateTime('31/02/2026 20:15')).toBeNull();
  });

  it('accepte les montants à virgule, espaces et symbole euro', () => {
    expect(parseFrenchAmount('12,50')).toBe('12.50');
    expect(parseFrenchAmount('1 234,5 €')).toBe('1234.5');
    expect(parseFrenchAmount('douze')).toBeNull();
    expect(parseFrenchAmount('-3,00')).toBeNull();
  });
});

describe('pos-check-csv: lecture du fichier', () => {
  it('reconnaît les colonnes par synonymes et lit les tickets', () => {
    const csv = [HEADER, 'T-1;31/12/2026 20:15;31/12/2026 21:00;12;12,50;2,08;1,00;0;13,50;2'].join(
      '\n',
    );
    const reading = readPosCheckCsv(csv);

    expect(reading.mapping).toMatchObject({ externalId: 'Numéro de ticket', total: 'Total' });
    expect(reading.skipped).toEqual([]);
    expect(reading.checks).toHaveLength(1);
    expect(reading.checks[0]).toMatchObject({
      externalId: 'T-1',
      tableReference: '12',
      subtotal: '12.50',
      tax: '2.08',
      tip: '1.00',
      total: '13.50',
      matchingHints: { partySize: 2 },
    });
  });

  it('ignore les lignes invalides avec leur numéro de ligne, sans bloquer le reste', () => {
    const csv = [
      HEADER,
      'T-1;31/12/2026 20:15;;12;12,50;2,08;;;13,50;2',
      'T-2;date bizarre;;12;12,50;2,08;;;13,50;2',
      ';31/12/2026 20:15;;12;12,50;2,08;;;13,50;2',
      'T-4;31/12/2026 20:15;;12;12,50;;;;13,50;2',
      'T-1;31/12/2026 20:45;;12;9,00;1,50;;;10,50;1',
    ].join('\n');
    const reading = readPosCheckCsv(csv);

    expect(reading.checks.map((check) => check.externalId)).toEqual(['T-1']);
    expect(reading.skipped).toEqual([
      { line: 3, reason: 'date d’ouverture invalide (attendu JJ/MM/AAAA HH:MM)' },
      { line: 4, reason: 'numéro de ticket manquant' },
      { line: 5, reason: 'montant manquant : TVA' },
      { line: 6, reason: 'ticket déjà présent dans le fichier' },
    ]);
  });

  it('signale les colonnes obligatoires absentes sans lever d’erreur', () => {
    const csv = 'Numéro de ticket;Ouverture;Sous-total;Total\nT-1;31/12/2026 20:15;12,50;13,50';
    const reading = readPosCheckCsv(csv);

    expect(reading.missing).toEqual(['tax']);
    expect(reading.skipped).toEqual([{ line: 2, reason: 'montant manquant : TVA' }]);
  });

  it('lève une erreur lisible si une colonne choisie n’existe pas', () => {
    expect(() =>
      readPosCheckCsv(HEADER + '\nT-1;31/12/2026 20:15;;12;12,50;2,08;0;13,50;2', {
        total: 'Montant absent',
      }),
    ).toThrow('Colonne introuvable dans le fichier : Montant absent');
  });

  it('lit une grosse journée en moins de deux secondes', () => {
    const rows = Array.from(
      { length: POS_CSV_ROW_LIMIT },
      (_, index) => `T-${index};31/12/2026 20:15;;${index % 40};12,50;2,08;;;13,50;2`,
    );
    const started = performance.now();
    const reading = readPosCheckCsv([HEADER, ...rows].join('\n'));
    const elapsed = performance.now() - started;

    expect(reading.checks).toHaveLength(POS_CSV_ROW_LIMIT);
    expect(elapsed).toBeLessThan(2000);
  });
});
