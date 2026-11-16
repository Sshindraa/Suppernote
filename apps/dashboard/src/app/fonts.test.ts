import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const pagePath = resolve(__dirname, './MarketingShell.tsx');
const fontsDirectory = resolve(__dirname, './fonts');

describe('Dashboard font loading', () => {
  it('uses bundled fonts without depending on Google Fonts during builds', () => {
    const page = readFileSync(pagePath, 'utf8');

    expect(page).toContain("from 'next/font/local'");
    expect(page).not.toContain('next/font/google');
    expect(existsSync(resolve(fontsDirectory, 'outfit-latin.woff2'))).toBe(true);
    expect(existsSync(resolve(fontsDirectory, 'fraunces-latin.woff2'))).toBe(true);
    expect(existsSync(resolve(fontsDirectory, 'plus-jakarta-sans-latin.woff2'))).toBe(true);
  });
});
