import { describe, expect, it } from 'vitest';
import { looksLikeAmount, looksLikePhone } from './csv';
import {
  applyColumnSuggestion,
  columnShapes,
  columnValues,
  looksLikeReference,
  maskValueShape,
} from './csv-column-ai';

describe('maskValueShape', () => {
  it('keeps the form and drops every digit and letter of the original', () => {
    expect(maskValueShape('06 12 34 56')).toBe('99 99 99 99');
    expect(maskValueShape('+33 6 12')).toBe('+99 9 99');
    expect(maskValueShape('Jean Dupont')).toBe('Aaaa Aaaaaa');
    expect(maskValueShape('jean.dupont@mail.fr')).toBe('aaaa.aaaaaa@…');
  });

  it('never leaves an original digit or letter in the shape', () => {
    const shape = maskValueShape('Léa 0612345678 é x');
    expect(shape).not.toMatch(/[0-8]/);
    expect(shape).not.toMatch(/[é]/);
    expect(shape).not.toMatch(/[Lx]/);
  });

  it('caps the length and marks the cut', () => {
    expect(maskValueShape('1234567890123456')).toBe('999999999999…');
    expect(maskValueShape('123456789012')).toBe('999999999999');
  });

  it('is empty for an empty value', () => {
    expect(maskValueShape('   ')).toBe('');
  });
});

describe('looksLikeReference', () => {
  it('accepts a short token with a digit, refuses names and sentences', () => {
    expect(looksLikeReference('TK-00123')).toBe(true);
    expect(looksLikeReference('2026/11/0042')).toBe(true);
    expect(looksLikeReference('Jean Dupont')).toBe(false);
    expect(looksLikeReference('Pas de chiffre')).toBe(false);
    expect(looksLikeReference('x'.repeat(41) + '1')).toBe(false);
  });
});

describe('columnShapes and columnValues', () => {
  it('returns at most a few distinct shapes', () => {
    expect(columnShapes(['0612345678', '0698765432', 'Jean', 'Paul', 'Luc'])).toEqual([
      '9999999999',
      'Aaaa',
      'Aaa',
    ]);
  });

  it('reads the values of each column below the header, in memory only', () => {
    const csv = 'Nom;Tel\nAlice;0612345678\n;0698765432\nBob;';
    const values = columnValues(csv, ['Nom', 'Tel'], 1, 10);
    expect(values).toEqual([
      ['Alice', 'Bob'],
      ['0612345678', '0698765432'],
    ]);
  });
});

describe('applyColumnSuggestion', () => {
  const headers = ['Nom', 'Mobile', 'Total', 'Ref'];
  const values = [
    ['Alice', 'Bob'],
    ['0612345678', '0698765432'],
    ['12,50', '8,00'],
    ['A1', 'A2'],
  ];
  const base = {
    fields: ['phone', 'total'] as const,
    headers,
    values,
    byContent: [] as ('phone' | 'total')[],
    testers: { phone: looksLikePhone, total: looksLikeAmount },
  };

  it('accepts a pick whose values look like the field', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: {},
      suggestion: { phone: { column: 'Mobile', confidence: 'high' } },
    });
    expect(result).toEqual({ mapping: { phone: 'Mobile' }, accepted: ['phone'] });
  });

  it('refuses a pick whose values do not look like the field', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: {},
      suggestion: { phone: { column: 'Nom', confidence: 'high' } },
    });
    expect(result.mapping).toEqual({});
    expect(result.accepted).toEqual([]);
  });

  it('rejects a column name that is not in the file', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: {},
      suggestion: { phone: { column: 'Telephone inconnu', confidence: 'high' } },
    });
    expect(result.accepted).toEqual([]);
  });

  it('never replaces a column recognised by its header', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: { phone: 'Ref' },
      byContent: [],
      suggestion: { phone: { column: 'Mobile', confidence: 'high' } },
    });
    expect(result.mapping).toEqual({ phone: 'Ref' });
  });

  it('replaces a column found only by its content, when the pick is coherent', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: { phone: 'Nom' },
      byContent: ['phone'],
      suggestion: { phone: { column: 'Mobile', confidence: 'medium' } },
    });
    expect(result).toEqual({ mapping: { phone: 'Mobile' }, accepted: ['phone'] });
  });

  it('ignores a low-confidence pick and a column already used by another field', () => {
    const low = applyColumnSuggestion({
      ...base,
      mapping: {},
      suggestion: { phone: { column: 'Mobile', confidence: 'low' } },
    });
    expect(low.accepted).toEqual([]);

    const taken = applyColumnSuggestion({
      ...base,
      mapping: { total: 'Mobile' },
      suggestion: { phone: { column: 'Mobile', confidence: 'high' } },
    });
    expect(taken.mapping).toEqual({ total: 'Mobile' });
  });

  it('refuses a field with no shape test', () => {
    const result = applyColumnSuggestion({
      ...base,
      testers: {},
      mapping: {},
      suggestion: { phone: { column: 'Mobile', confidence: 'high' } },
    });
    expect(result.accepted).toEqual([]);
  });

  it('refuses a column whose header a field rejects', () => {
    const result = applyColumnSuggestion({
      ...base,
      mapping: {},
      rejects: { phone: /mobile/ },
      suggestion: { phone: { column: 'Mobile', confidence: 'high' } },
    });
    expect(result.accepted).toEqual([]);
  });
});
