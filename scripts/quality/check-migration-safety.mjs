#!/usr/bin/env node
/**
 * Contrôle de sûreté des migrations (R1-5).
 *
 * `AGENTS.md` demande de relire chaque migration avec
 * `prisma migrate diff --from-url … --to-schema-datamodel … --script` et de
 * vérifier l'absence de `DROP` / `TRUNCATE` avant de déployer. C'était une
 * consigne de revue, donc contournable par distraction. Ce script l'automatise
 * pour les migrations **ajoutées par la branche courante** : une migration
 * destructive doit porter une ligne d'acquittement explicite.
 *
 * Acquittement (dans le fichier `migration.sql`, avec une raison) :
 *
 *   -- suppernote:destructive-ok — colonne remplacée par une vue, backfill vérifié
 *
 * Les migrations déjà sur `main` ne sont pas rescannées : la dette historique
 * n'empêche pas de travailler, comme pour la baseline de scoping tenant.
 *
 * Usage:
 *   node scripts/quality/check-migration-safety.mjs              # migrations de la branche
 *   node scripts/quality/check-migration-safety.mjs --all        # inventaire complet (informatif)
 *   node scripts/quality/check-migration-safety.mjs --self-test   # teste la logique
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Sortie CLI : le depot interdit console.log dans les scripts versionnes. */
const writeOut = (message = '') => process.stdout.write(`${message}\n`);
const writeErr = (message = '') => process.stderr.write(`${message}\n`);
const MIGRATIONS_DIR = path.join(ROOT, 'packages/database/prisma/migrations');
const MIGRATION_PATH = /^packages\/database\/prisma\/migrations\/[^/]+\/migration\.sql$/;

export const ACK_MARKER = /--\s*(?:suppernote|sokar):destructive-ok\b/;

/**
 * Motifs considérés destructifs. Volontairement conservateur : un `DROP INDEX`
 * ou un `SET NOT NULL` ne sont pas listés, car ils se relisent en une ligne et
 * bloqueraient le travail pour rien. Ce qui est listé peut perdre des données.
 */
export const DESTRUCTIVE_PATTERNS = [
  { label: 'DROP TABLE', regex: /\bDROP\s+TABLE\b/i },
  { label: 'DROP COLUMN', regex: /\bDROP\s+COLUMN\b/i },
  { label: 'DROP SCHEMA', regex: /\bDROP\s+SCHEMA\b/i },
  { label: 'DROP DATABASE', regex: /\bDROP\s+DATABASE\b/i },
  { label: 'TRUNCATE', regex: /\bTRUNCATE\b/i },
  { label: 'DELETE FROM', regex: /\bDELETE\s+FROM\b/i },
  { label: 'ALTER COLUMN … TYPE', regex: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b/i },
];

/** Retire les commentaires SQL : ils ne doivent pas déclencher de faux positif. */
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function findDestructiveStatements(sql) {
  const statements = stripSqlComments(sql)
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  const findings = [];
  for (const statement of statements) {
    for (const pattern of DESTRUCTIVE_PATTERNS) {
      if (pattern.regex.test(statement)) {
        findings.push({
          label: pattern.label,
          excerpt: statement.replace(/\s+/g, ' ').slice(0, 120),
        });
        break;
      }
    }
  }
  return findings;
}

export function evaluateMigration(sql) {
  const findings = findDestructiveStatements(sql);
  if (findings.length === 0) return { safe: true, findings };
  return { safe: ACK_MARKER.test(sql), acknowledged: ACK_MARKER.test(sql), findings };
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function resolveBaseRef() {
  const candidates = [process.env.SOKAR_BASE_REF, 'origin/main', 'HEAD~1'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      git(['rev-parse', '--verify', `${candidate}^{commit}`]);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function listCandidateMigrations(baseRef) {
  const paths = new Set();

  if (baseRef) {
    try {
      for (const file of git(['diff', '--name-only', '--diff-filter=A', `${baseRef}...HEAD`]).split(
        '\n',
      )) {
        if (MIGRATION_PATH.test(file.trim())) paths.add(file.trim());
      }
    } catch {
      // diff indisponible : on retombe sur l'état de travail ci-dessous.
    }
  }

  try {
    // `-uall` est indispensable : sans lui, git replie un dossier non suivi en
    // une seule ligne (`?? …/20990101000000_probe/`) et le fichier de migration
    // passe sous le radar du contrôle.
    for (const line of git(['status', '--porcelain', '--untracked-files=all']).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const status = trimmed.slice(0, 2);
      const file = trimmed.slice(3).trim();
      if ((status.includes('A') || status === '??') && MIGRATION_PATH.test(file)) paths.add(file);
    }
  } catch {
    // hors dépôt git : rien à faire.
  }

  return [...paths].sort();
}

function listAllMigrations() {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name !== 'migration_lock.toml')
    .map((name) => `packages/database/prisma/migrations/${name}/migration.sql`)
    .filter((file) => existsSync(path.join(ROOT, file)))
    .sort();
}

function report(files, { failOnFindings }) {
  let failures = 0;
  let destructive = 0;

  for (const file of files) {
    const sql = readFileSync(path.join(ROOT, file), 'utf8');
    const result = evaluateMigration(sql);
    if (result.findings.length === 0) continue;
    destructive += 1;

    if (result.acknowledged) {
      writeOut(
        `  ⚠️  ${file} — ${result.findings.length} instruction(s) destructive(s), acquittée(s)`,
      );
      for (const finding of result.findings) writeOut(`      ${finding.label}: ${finding.excerpt}`);
      continue;
    }

    failures += 1;
    writeErr(
      `  ❌ ${file} — ${result.findings.length} instruction(s) destructive(s) sans acquittement`,
    );
    for (const finding of result.findings) writeErr(`      ${finding.label}: ${finding.excerpt}`);
  }

  if (failures > 0) {
    writeErr('');
    writeErr('   Une migration destructive est autorisée, mais elle doit être assumée :');
    writeErr('   1. vérifier le diff complet :');
    writeErr(
      '      pnpm exec prisma migrate diff --from-url "$DATABASE_URL" \\\n' +
        '        --to-schema-datamodel packages/database/prisma/schema.prisma --script',
    );
    writeErr('   2. prendre une sauvegarde avant le déploiement ;');
    writeErr('   3. ajouter dans le fichier migration.sql :');
    writeErr('      -- suppernote:destructive-ok — <raison et vérification faite>');
    writeErr('   Voir docs/runbooks/migration.md.');
    writeErr('');
    if (failOnFindings) process.exit(1);
  }

  return { failures, destructive };
}

function runSelfTest() {
  const checks = [
    {
      name: 'migration additive → sûre',
      sql: 'ALTER TABLE "restaurant_billing" ADD COLUMN "subscription_billing_interval" TEXT;',
      safe: true,
      findings: 0,
    },
    {
      name: 'DROP COLUMN sans acquittement → refusée',
      sql: 'ALTER TABLE "reservations" DROP COLUMN "legacy_status";',
      safe: false,
      findings: 1,
    },
    {
      name: 'DROP TABLE avec nouvel acquittement → acceptée',
      sql: '-- suppernote:destructive-ok — table vidée depuis 6 mois\nDROP TABLE "tmp_import";',
      safe: true,
      findings: 1,
    },
    {
      name: 'ancien acquittement toujours accepté',
      sql: '-- sokar:destructive-ok — migration déjà présente\nDROP TABLE "tmp_import";',
      safe: true,
      findings: 1,
    },
    {
      name: 'TRUNCATE dans un commentaire → ignoré',
      sql: '-- TRUNCATE "reservations";\nSELECT 1;',
      safe: true,
      findings: 0,
    },
    {
      name: 'ALTER COLUMN … TYPE multi-lignes → refusée',
      sql: 'ALTER TABLE "reservations"\n  ALTER COLUMN "party_size"\n  TYPE bigint;',
      safe: false,
      findings: 1,
    },
    {
      name: 'DELETE FROM → refusée',
      sql: 'DELETE FROM "agentic_holds" WHERE "expires_at" < now();',
      safe: false,
      findings: 1,
    },
    {
      name: 'acquittement approximatif → refusée',
      sql: '-- destructive ok\nDROP TABLE "tmp";',
      safe: false,
      findings: 1,
    },
  ];

  let failures = 0;
  for (const check of checks) {
    const result = evaluateMigration(check.sql);
    if (result.safe !== check.safe || result.findings.length !== check.findings) {
      failures += 1;
      writeErr(
        `  ❌ ${check.name} — attendu ${check.safe}/${check.findings}, obtenu ${result.safe}/${result.findings.length}`,
      );
    }
  }

  if (failures > 0) {
    writeErr(`check-migration-safety: ${failures}/${checks.length} cas en échec`);
    process.exit(1);
  }
  writeOut(`check-migration-safety: ${checks.length}/${checks.length} cas OK`);
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest();
    return;
  }

  if (process.argv.includes('--all')) {
    const files = listAllMigrations();
    writeOut(`check-migration-safety: inventaire de ${files.length} migrations (informatif)`);
    const { destructive } = report(files, { failOnFindings: false });
    writeOut(`  ${destructive} migration(s) contiennent une instruction destructive.`);
    return;
  }

  const baseRef = resolveBaseRef();
  const files = listCandidateMigrations(baseRef);

  if (files.length === 0) {
    writeOut(
      baseRef
        ? `check-migration-safety: aucune migration ajoutée depuis ${baseRef}`
        : 'check-migration-safety: aucune migration ajoutée (base de comparaison indisponible)',
    );
    return;
  }

  writeOut(
    `check-migration-safety: ${files.length} migration(s) ajoutée(s) depuis ${baseRef ?? 'HEAD'}`,
  );
  const { failures } = report(files, { failOnFindings: true });
  if (failures === 0) {
    writeOut('check-migration-safety: aucune instruction destructive non acquittée');
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  main();
}
