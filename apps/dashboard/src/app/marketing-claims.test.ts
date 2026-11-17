import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Garde-fou des pages publiques (docs/architecture/marketing-site.md). Une page publique est une
// page qui tire ses metadata de marketing-metadata.ts : elle est trouvée ici sans liste à tenir.

const APP_DIR = dirname(fileURLToPath(import.meta.url));

// Affirmations retirées faute de preuve (COPY-01). Témoignage, garantie et statistique sans source
// ne reviennent pas sur les pages publiques sans preuve versée au rapport de qualification.
const UNPROVEN_CLAIMS = [
  'Taux de réponse garanti',
  '98.4%',
  '+18.4%',
  'Appels traités ce mois',
  'Chef Matthieu',
  'Bistrot L’Ardoise',
  'Partenaire Certifié',
  'Suppernote gère 100%',
  'Simulation temps réel',
  'sans limite',
  'Vos clients reconnus',
  'client reconnu',
  'Support prioritaire 7j/7',
  'Réservable depuis ChatGPT',
  'Toujours disponible',
  '24h/24',
  'zéro débordement',
  'Suppernote est conforme au RGPD',
];

// Vocabulaire de marque : Suppernote est « le chef de rang digital », l'agent vocal « Léa ».
const OFF_BRAND = [/assistant téléphonique/i];

// Pages publiques hors gabarit marketing, relues pour leurs affirmations seulement.
const OTHER_PUBLIC_COPY = [
  'constants.ts',
  'register/[[...slug]]/page.tsx',
  'login/[[...slug]]/page.tsx',
  'mcp/page.tsx',
  'privacy/page.tsx',
];

function pageFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return pageFiles(path);
    return entry.name === 'page.tsx' ? [path] : [];
  });
}

// Un niveau d'imports locaux suffit : le texte des pages vit dans leurs sections directes.
function localImports(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/from '(@\/app\/[^']+|\.\.?\/[^']+)'/g)].flatMap(([, spec]) => {
    const base = spec.startsWith('@/app/')
      ? join(APP_DIR, spec.slice('@/app/'.length))
      : resolve(dirname(file), spec);
    return ['.tsx', '.ts'].map((ext) => base + ext).filter((path) => existsSync(path));
  });
}

const MARKETING_PAGES = pageFiles(APP_DIR).filter((file) =>
  readFileSync(file, 'utf8').includes("from '@/app/marketing-metadata'"),
);

const MARKETING_COPY = [
  ...new Set(MARKETING_PAGES.flatMap((page) => [page, ...localImports(page)])),
].filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'));

const rel = (file: string) => relative(APP_DIR, file);

describe('pages publiques', () => {
  it('trouve les pages marketing', () => {
    expect(MARKETING_PAGES.map(rel)).toEqual(
      expect.arrayContaining(['page.tsx', 'pricing/page.tsx']),
    );
  });

  it.each(MARKETING_PAGES.map(rel))('%s utilise l’habillage commun MarketingShell', (file) => {
    const source = readFileSync(join(APP_DIR, file), 'utf8');

    expect(source).toContain("from '@/app/MarketingShell'");
    // Menu, polices et pied de page viennent de MarketingShell, jamais d'une copie locale.
    expect(source).not.toMatch(/<nav\b|next\/font|SiteFooter|<footer\b/);
    // Palette bleu-gris seulement : pas de noir pur ni de couleur en dur.
    expect(source).not.toMatch(/\b(bg|from|via|to)-black\b|\[#[0-9a-fA-F]{3,8}\]/);
  });

  it.each(MARKETING_COPY.map(rel))('%s écrit ses titres h1 et h2 en serif de marque', (file) => {
    const source = readFileSync(join(APP_DIR, file), 'utf8');
    const headings = [...source.matchAll(/<h[12]\b[^>]*className="([^"]*)"/g)].map(
      ([, cls]) => cls,
    );

    expect(headings.filter((cls) => !cls.includes('font-brand'))).toEqual([]);
  });

  it.each([...MARKETING_COPY.map(rel), ...OTHER_PUBLIC_COPY])(
    '%s ne reprend aucune affirmation sans preuve ni terme hors marque',
    (file) => {
      const source = readFileSync(join(APP_DIR, file), 'utf8');

      expect(UNPROVEN_CLAIMS.filter((claim) => source.includes(claim))).toEqual([]);
      expect(OFF_BRAND.filter((pattern) => pattern.test(source))).toEqual([]);
    },
  );
});
