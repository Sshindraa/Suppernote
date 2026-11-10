import { beforeEach, describe, expect, it } from 'vitest';
import { recallColumns, rememberColumns, rowsToCsv } from './import-file';

describe('rowsToCsv (Excel converti en texte)', () => {
  it('joint les cellules avec « ; » et ignore les lignes vides', () => {
    expect(
      rowsToCsv([
        ['Nom', 'Téléphone'],
        [null, null],
        ['Alice', 612345678],
      ]),
    ).toBe('Nom;Téléphone\nAlice;612345678');
  });

  it('entoure de guillemets une cellule qui contient un séparateur, un guillemet ou un retour', () => {
    expect(
      rowsToCsv([
        ['Nom', 'Notes'],
        ['Dupont; Jean', 'Dit "bonjour"\nSuite'],
      ]),
    ).toBe('Nom;Notes\n"Dupont; Jean";"Dit ""bonjour""\nSuite"');
  });

  it('écrit les dates au format JJ/MM/AAAA, avec l’heure seulement si elle existe', () => {
    const day = new Date(2026, 11, 31);
    const evening = new Date(2026, 11, 31, 19, 15);
    expect(rowsToCsv([[day, evening]])).toBe('31/12/2026;31/12/2026 19:15');
  });
});

describe('colonnes mémorisées', () => {
  beforeEach(() => window.localStorage.clear());

  it('retrouve les colonnes dont le nom existe encore dans le fichier', () => {
    rememberColumns('customers:site-1', { phone: 'Contact', email: 'Mail', name: null });
    expect(recallColumns('customers:site-1', ['Nom', 'Contact'])).toEqual({ phone: 'Contact' });
  });

  it('ne mélange pas deux restaurants et ne lit rien d’anormal', () => {
    rememberColumns('customers:site-1', { phone: 'Contact' });
    expect(recallColumns('customers:site-2', ['Contact'])).toEqual({});
    window.localStorage.setItem('suppernote:import-columns:customers:site-3', '{pas du json');
    expect(recallColumns('customers:site-3', ['Contact'])).toEqual({});
  });
});
