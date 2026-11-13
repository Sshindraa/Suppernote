/**
 * Test anti-régression : domaines hors allowlist.
 *
 * Scanne récursivement apps/api/src, apps/connect/src, apps/widget/src et
 * packages/database/prisma/seed.ts (exclut __tests__, node_modules, .next,
 * dist, out) et vérifie qu'aucun domaine interdit n'apparaît dans le code.
 *
 * `suppernote.com` est le domaine canonique de production. `sokar.app` était
 * l'ancien nom du brief initial (cf. docs/connect-v1.1.md ligne 8).
 * `sokar.com` n'est pas possédé par l'entreprise.
 *
 * Ces domaines ont causé plusieurs bugs en prod (liens morts RGPD, feed
 * OpenAI Reserve pointant vers un domaine inexistant, fallbacks dispersés
 * sans garde-fou). Ce test verrouille le code source pour empêcher une
 * régression.
 *
 * Faux positifs connus (exclus du scan) :
 * - docs/ — documentation historique qui explique les changements de domaine
 * - apps/widget/README.md — documente explicitement que le widget est un
 *   prototype non fonctionnel et mentionne les anciens domaines à corriger
 *
 * Si ce test échoue : un nouveau `sokar.com` ou `sokar.app` a été introduit
 * dans le code source. Le message d'erreur liste les fichiers et lignes en
 * faute. Remplacer par `suppernote.com` (ou un sous-domaine : api.suppernote.com,
 * app.suppernote.com, widget.suppernote.com) selon le contexte.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SCAN_ROOTS = [
  path.resolve(__dirname, '../../..'), // apps/api/src, apps/connect/src, apps/widget/src
];

// Répertoires à exclure du scan
const EXCLUDE_DIRS = ['node_modules', '.next', 'dist', 'out', '__tests__'];

// Extensions de fichiers à scanner
const SCAN_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// Pattern : sokar.com ou sokar.app (pas suppernote.com qui est valide)
const FORBIDDEN_DOMAIN = /sokar\.(com|app)\b/g;

// Faux positifs explicites (chemin relatif depuis la racine du monorepo)
const ALLOWED_FALS_POSITIVES: string[] = [
  // apps/widget/README.md documente les anciens domaines à corriger
  'apps/widget/README.md',
];

function scanDirectory(
  dir: string,
  violations: Array<{ file: string; line: number; content: string }>,
): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.includes(entry.name)) continue;
      scanDirectory(fullPath, violations);
    } else if (entry.isFile() && SCAN_EXTENSIONS.includes(path.extname(entry.name))) {
      scanFile(fullPath, violations);
    }
  }
}

function scanFile(
  filePath: string,
  violations: Array<{ file: string; line: number; content: string }>,
): void {
  // Exclure les fichiers de test (.test.ts, .test.tsx, .spec.ts) — ils peuvent
  // légitimement mentionner ces domaines dans des assertions ou commentaires.
  const basename = path.basename(filePath);
  if (basename.includes('.test.') || basename.includes('.spec.')) return;

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matches = line.match(FORBIDDEN_DOMAIN);
    if (!matches) continue;

    // Chemin relatif pour comparaison avec l'allowlist
    const relPath = path.relative(process.cwd(), filePath);
    // Normaliser les séparateurs pour la comparaison
    const normalizedPath = relPath.split(path.sep).join('/');

    if (ALLOWED_FALS_POSITIVES.includes(normalizedPath)) continue;

    violations.push({
      file: relPath,
      line: i + 1,
      content: line.trim(),
    });
  }
}

describe('domain-allowlist — anti-régression sokar.com / sokar.app', () => {
  it('ne trouve aucun sokar.com ou sokar.app dans le code source (hors allowlist)', () => {
    const violations: Array<{ file: string; line: number; content: string }> = [];

    // Scanner les 3 racines d'apps
    const rootsToScan = [
      path.resolve(__dirname, '..', '..'), // apps/api/src
      path.resolve(__dirname, '..', '..', '..', 'connect', 'src'), // apps/connect/src
      path.resolve(__dirname, '..', '..', '..', 'widget', 'src'), // apps/widget/src
    ];

    for (const root of rootsToScan) {
      scanDirectory(root, violations);
    }
    scanFile(path.resolve(__dirname, '../../../../packages/database/prisma/seed.ts'), violations);

    if (violations.length > 0) {
      const formatted = violations.map((v) => `  ${v.file}:${v.line} → ${v.content}`).join('\n');
      expect.fail(
        `Domaines interdits (sokar.com / sokar.app) trouvés dans le code source.\n` +
          `Remplacer par suppernote.com (ou un sous-domaine : api.suppernote.com, app.suppernote.com, widget.suppernote.com).\n` +
          `Faux positifs connus : docs/ et apps/widget/README.md.\n\n` +
          `Occurrences trouvées :\n${formatted}`,
      );
    }

    expect(violations).toHaveLength(0);
  });
});
