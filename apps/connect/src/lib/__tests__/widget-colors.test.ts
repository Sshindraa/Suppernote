/**
 * Tests unitaires pour les helpers de couleurs et slugs du widget.
 */

import { describe, it, expect } from 'vitest';
import { toHexColor, isValidSlug } from '@/lib/widget-colors';

describe('toHexColor', () => {
  it('accepts a hex color without hash', () => {
    expect(toHexColor('0f172a', '#EA580C')).toBe('#0f172a');
  });

  it('accepts a hex color with hash', () => {
    expect(toHexColor('#f97316', '#0F172A')).toBe('#f97316');
  });

  it('falls back on invalid color', () => {
    expect(toHexColor('not-a-color', '#0F172A')).toBe('#0F172A');
  });

  it('falls back when value is missing', () => {
    expect(toHexColor(undefined, '#0F172A')).toBe('#0F172A');
  });

  it('falls back on empty string', () => {
    expect(toHexColor('', '#EA580C')).toBe('#EA580C');
  });

  it('falls back on short hex (3 chars)', () => {
    expect(toHexColor('#fff', '#EA580C')).toBe('#EA580C');
  });

  it('falls back on 8-char hex (with alpha)', () => {
    expect(toHexColor('#ff5588aa', '#EA580C')).toBe('#EA580C');
  });

  it('accepts uppercase hex', () => {
    expect(toHexColor('#AABBCC', '#EA580C')).toBe('#AABBCC');
  });

  it('accepts mixed-case hex', () => {
    expect(toHexColor('#aAbBcC', '#EA580C')).toBe('#aAbBcC');
  });

  it('falls back on non-hex characters', () => {
    expect(toHexColor('#gggggg', '#EA580C')).toBe('#EA580C');
  });
});

describe('isValidSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(isValidSlug('chez-sokar')).toBe(true);
  });

  it('accepts a slug with numbers', () => {
    expect(isValidSlug('restaurant-paris-16')).toBe(true);
  });

  it('accepts a single character slug', () => {
    expect(isValidSlug('a')).toBe(true);
  });

  it('accepts a slug starting with a number', () => {
    expect(isValidSlug('16e-arrondissement')).toBe(true);
  });

  it('accepts a long slug within the limit (80 chars)', () => {
    const slug = 'a' + '-b'.repeat(38) + '-c'; // 1 + 76 + 1 = 78 chars, valid
    expect(isValidSlug(slug)).toBe(true);
  });

  it('rejects empty string', () => {
    expect(isValidSlug('')).toBe(false);
  });

  it('rejects uppercase letters', () => {
    expect(isValidSlug('Chez Suppernote')).toBe(false);
  });

  it('rejects underscores', () => {
    expect(isValidSlug('chez_suppernote')).toBe(false);
  });

  it('rejects slashes', () => {
    expect(isValidSlug('chez/suppernote')).toBe(false);
  });

  it('rejects path traversal attempts', () => {
    expect(isValidSlug('../../../etc')).toBe(false);
  });

  it('rejects a slug starting with a hyphen', () => {
    expect(isValidSlug('-chez-suppernote')).toBe(false);
  });

  it('rejects a slug ending with a hyphen', () => {
    expect(isValidSlug('chez-suppernote-')).toBe(false);
  });

  it('rejects a slug with spaces', () => {
    expect(isValidSlug('chez suppernote')).toBe(false);
  });

  it('rejects a slug with special characters', () => {
    expect(isValidSlug('chez@suppernote')).toBe(false);
  });

  it('rejects a slug that is too long (>80 chars)', () => {
    const slug = 'a'.repeat(81);
    expect(isValidSlug(slug)).toBe(false);
  });

  it('rejects a slug with only a hyphen', () => {
    expect(isValidSlug('-')).toBe(false);
  });
});
