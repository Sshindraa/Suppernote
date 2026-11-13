#!/usr/bin/env node
/**
 * Tenant-scoping guard (R0-6).
 *
 * Suppernote isolates tenants in application code: every query on a tenant-scoped
 * model must filter by `restaurantId` / `accountId` (or an equivalent relation
 * filter). PostgreSQL has no row-level security yet, so a single forgotten
 * `where` clause leaks another restaurant's data.
 *
 * This checker scans `apps/api/src` for Prisma calls on tenant-scoped models and
 * compares the result with a committed baseline. It fails only when a file
 * gains a *new* unscoped call, which makes the guard usable on an existing
 * codebase without freezing work: the baseline ratchets down as the debt is
 * paid.
 *
 * Usage:
 *   node scripts/quality/check-tenant-scoping.mjs            # verify
 *   node scripts/quality/check-tenant-scoping.mjs --json      # machine output
 *   node scripts/quality/check-tenant-scoping.mjs --write     # refresh baseline
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCHEMA_PATH = path.join(ROOT, 'packages/database/prisma/schema.prisma');
const SRC_DIR = path.join(ROOT, 'apps/api/src');
const BASELINE_PATH = path.join(ROOT, 'scripts/quality/tenant-scoping-baseline.json');

const TENANT_KEYS = /\b(restaurantId|accountId|siteId)\b/;
const TENANT_RELATION = /\brestaurant\s*:\s*\{|\baccount\s*:\s*\{/;
const IGNORED_PATH_SEGMENTS = ['__tests__', '/test/', '.test.ts', '.spec.ts'];

/**
 * Exception explicite, à écrire au-dessus ou sur la ligne de l'appel :
 *   // tenant-scoping: global — métrique agrégée, pas une lecture tenant.
 * Elle rend l'exception visible en revue au lieu de la cacher dans la baseline.
 */
const EXEMPTION_MARKER = /tenant-scoping:\s*global/;

/**
 * Noms de variables qui portent réellement un client Prisma dans ce dépôt
 * (`db` partagé, `prisma` injecté, `tx` transactionnel, `client` ponctuel).
 * Sans cette liste, une chaîne comme `queues.marketingAutomation.upsert...`
 * serait confondue avec le modèle `MarketingAutomation`.
 */
const PRISMA_RECEIVERS = new Set(['db', 'prisma', 'tx', 'trx', 'client']);

/** Models carrying `restaurantId` or `accountId` in the Prisma schema. */
export function readTenantScopedModels(schemaText) {
  const models = new Set();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  for (const match of schemaText.matchAll(modelRe)) {
    const [, name, body] = match;
    if (/^\s*(restaurantId|accountId)\s+\S/m.test(body)) models.add(name);
  }
  return models;
}

/** Extracts the argument list of a call starting at `openIndex` (the `(`). */
export function extractCallArguments(source, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    const char = source[index];
    if (char === '(') depth++;
    else if (char === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, index);
    }
  }
  return '';
}

export function findUnscopedCalls(source, tenantModels) {
  const findings = [];
  // Le client Prisma est nommé `db`, `prisma`, `tx` ou `this.prisma` selon le
  // fichier : on discrimine sur le nom du modèle (deuxième segment), pas sur le
  // nom de la variable cliente.
  const callRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(callRe)) {
    const [, receiver, modelAccessor, method] = match;
    if (!PRISMA_RECEIVERS.has(receiver)) continue;
    const model = tenantModels.get(modelAccessor);
    if (!model) continue;
    const openIndex = match.index + match[0].length - 1;
    const args = extractCallArguments(source, openIndex);
    if (TENANT_KEYS.test(args) || TENANT_RELATION.test(args)) continue;

    // Le marqueur peut être sur la ligne de l'appel ou juste au-dessus : on
    // regarde une fenêtre courte en amont plutôt qu'une seule ligne, sinon un
    // commentaire posé avant un `Promise.all` n'exempterait que le premier appel.
    const context = source.slice(Math.max(0, match.index - 400), match.index + 200);
    if (EXEMPTION_MARKER.test(context)) continue;

    findings.push({
      model,
      method,
      line: source.slice(0, match.index).split('\n').length,
    });
  }
  return findings;
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, files);
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

export function collectFindings() {
  const schemaModels = readTenantScopedModels(readFileSync(SCHEMA_PATH, 'utf8'));
  // `Customer` dans le schéma devient `prisma.customer` dans le code.
  const tenantModels = new Map(
    [...schemaModels].map((name) => [name.charAt(0).toLowerCase() + name.slice(1), name]),
  );
  const perFile = {};

  for (const file of walk(SRC_DIR)) {
    const relative = path.relative(ROOT, file);
    if (IGNORED_PATH_SEGMENTS.some((segment) => relative.includes(segment))) continue;

    const findings = findUnscopedCalls(readFileSync(file, 'utf8'), tenantModels);
    if (findings.length === 0) continue;

    perFile[relative] = {};
    for (const finding of findings) {
      const key = `${finding.model}.${finding.method}`;
      perFile[relative][key] = (perFile[relative][key] ?? 0) + 1;
    }
  }

  return { tenantModels: tenantModels.size, perFile };
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')).files ?? {};
}

function main() {
  const args = process.argv.slice(2);
  const { tenantModels, perFile } = collectFindings();

  if (args.includes('--write')) {
    writeFileSync(
      BASELINE_PATH,
      `${JSON.stringify(
        {
          note: 'Baseline du garde-fou de scoping tenant (R0-6). Compte les appels Prisma non scopés par fichier et par modèle.méthode. La faire baisser quand la dette est payée ; ne jamais l’augmenter sans justification en revue.',
          files: perFile,
        },
        null,
        2,
      )}\n`,
    );
    const total = Object.values(perFile).reduce(
      (sum, methods) => sum + Object.values(methods).reduce((inner, count) => inner + count, 0),
      0,
    );
    process.stdout.write(
      `Baseline écrite : ${total} appel(s) non scopé(s) dans ${Object.keys(perFile).length} fichier(s).\n`,
    );
    return 0;
  }

  const baseline = readBaseline();
  const regressions = [];
  const improvements = [];

  for (const [file, methods] of Object.entries(perFile)) {
    for (const [key, count] of Object.entries(methods)) {
      const allowed = baseline[file]?.[key] ?? 0;
      if (count > allowed) regressions.push({ file, key, count, allowed });
    }
  }
  for (const [file, methods] of Object.entries(baseline)) {
    for (const [key, allowed] of Object.entries(methods)) {
      const count = perFile[file]?.[key] ?? 0;
      if (count < allowed) improvements.push({ file, key, count, allowed });
    }
  }

  if (args.includes('--json')) {
    process.stdout.write(
      `${JSON.stringify({ tenantModels, regressions, improvements }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `Scoping tenant : ${tenantModels} modèles porteurs d’un tenant, ${Object.keys(perFile).length} fichier(s) avec du legacy non scopé.\n`,
    );
    for (const item of improvements) {
      process.stdout.write(
        `  à la baisse : ${item.file} ${item.key} ${item.allowed} → ${item.count} (baisser la baseline)\n`,
      );
    }
    for (const item of regressions) {
      process.stdout.write(
        `  RÉGRESSION : ${item.file} ${item.key} ${item.allowed} → ${item.count} appel(s) non scopé(s)\n`,
      );
    }
  }

  if (regressions.length > 0) {
    process.stdout.write(
      `\n${regressions.length} régression(s) de scoping tenant. Ajouter le filtre restaurantId/accountId, ou justifier explicitement l’exception dans la baseline.\n`,
    );
    return 1;
  }

  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
