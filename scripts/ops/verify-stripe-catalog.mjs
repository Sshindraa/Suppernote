#!/usr/bin/env node
/**
 * Vérifie que le catalogue Stripe configuré correspond au catalogue produit.
 *
 * Pourquoi : le code ne contrôle que le préfixe `price_` des identifiants. Rien
 * n'empêche aujourd'hui de pointer `STRIPE_PRICE_ESSENTIAL_MONTHLY` vers l'ancien
 * prix 149 € et d'encaisser le mauvais montant. Ce script lit chaque prix côté
 * Stripe et compare montant, devise, cadence et état.
 *
 * Lecture seule : aucune création, modification ou suppression côté Stripe.
 *
 * Usage (les identifiants sont lus dans l'environnement) :
 *   node --env-file=/opt/suppernote/apps/api/.env scripts/ops/verify-stripe-catalog.mjs
 *   node --env-file=.env scripts/ops/verify-stripe-catalog.mjs --json
 *
 * Les tarifs et le calcul annuel viennent du catalogue partagé en centimes.
 */

const STRIPE_API = 'https://api.stripe.com/v1/prices';

import catalogue from '../../packages/shared/src/pricing-catalog.cjs';
const { PRICING_CATALOG, ANNUAL_DISCOUNT_PERCENT, annualPriceCents } = catalogue;

export const EXPECTED_CATALOG = Object.values(PRICING_CATALOG).flatMap((entry) => [
  {
    env: `STRIPE_PRICE_${entry.stripeSuffix}_MONTHLY`,
    label: `${entry.label} mensuel`,
    interval: 'month',
    amount: entry.monthlyCents,
  },
  {
    env: `STRIPE_PRICE_${entry.stripeSuffix}_ANNUAL`,
    label: `${entry.label} annuel (-${ANNUAL_DISCOUNT_PERCENT} %)`,
    interval: 'year',
    amount: annualPriceCents(entry.monthlyCents),
  },
]);

/** `STRIPE_PRICE_ESSENTIAL_MONTHLY` → `STRIPE_EXPECTED_ESSENTIAL_MONTHLY`. */
export function expectedAmountEnvName(envName) {
  return envName.replace(/^STRIPE_PRICE_/, 'STRIPE_EXPECTED_');
}

/**
 * Compare un prix attendu à la réponse Stripe. Retourne la liste des écarts
 * (vide si conforme). `expectedAmount: null` signifie « montant non contrôlé ».
 */
export function comparePrice(expected, actual, expectedAmount = null) {
  if (!actual || actual.error) {
    return [`prix introuvable côté Stripe (${actual?.error ?? 'réponse vide'})`];
  }

  const problems = [];
  if (actual.active === false) problems.push('prix archivé (active=false)');
  if ((actual.currency ?? '').toLowerCase() !== 'eur') {
    problems.push(`devise ${actual.currency ?? 'inconnue'} au lieu de eur`);
  }
  if (actual.recurring?.interval !== expected.interval) {
    problems.push(
      `cadence ${actual.recurring?.interval ?? 'absente'} au lieu de ${expected.interval}`,
    );
  }
  if (actual.recurring?.interval_count != null && actual.recurring.interval_count !== 1) {
    problems.push(`interval_count ${actual.recurring.interval_count} au lieu de 1`);
  }
  if (expectedAmount != null && actual.unit_amount !== expectedAmount) {
    problems.push(
      `montant ${actual.unit_amount ?? 'absent'} au lieu de ${expectedAmount} centimes`,
    );
  }

  return problems;
}

async function fetchPrice(id, secretKey) {
  try {
    const response = await fetch(`${STRIPE_API}/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    if (response.status === 404) return { error: '404' };
    if (!response.ok) return { error: `HTTP ${response.status}` };
    return await response.json();
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const json = process.argv.includes('--json');
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim();

  if (!secretKey) {
    process.stderr.write('STRIPE_SECRET_KEY absent : rien à vérifier.\n');
    return 2;
  }

  const missing = EXPECTED_CATALOG.filter((entry) => !process.env[entry.env]?.trim());
  if (missing.length > 0) {
    process.stderr.write(
      `Identifiants manquants : ${missing.map((entry) => entry.env).join(', ')}\n`,
    );
    return 1;
  }

  const ids = EXPECTED_CATALOG.map((entry) => process.env[entry.env].trim());
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

  const rows = [];
  const products = new Map();
  for (const entry of EXPECTED_CATALOG) {
    const id = process.env[entry.env].trim();
    const expectedAmount = entry.amount;

    const actual = await fetchPrice(id, secretKey);
    const problems = comparePrice(entry, actual, expectedAmount);
    if (actual?.tax_behavior !== 'exclusive')
      problems.push('prix non HT (tax_behavior différent de exclusive)');
    if (actual?.billing_scheme !== 'per_unit')
      problems.push('billing_scheme différent de per_unit');
    const suffix = entry.env.replace(/^STRIPE_PRICE_/, '').replace(/_(MONTHLY|ANNUAL)$/, '');
    const expectedAssociation =
      suffix === 'MULTI_SITE_ADDON'
        ? 'multi-site-addon'
        : suffix.toLowerCase().replaceAll('_', '-');
    const association =
      suffix === 'MULTI_SITE_ADDON'
        ? actual?.metadata?.sokar_component
        : actual?.metadata?.sokar_plan;
    if (association !== expectedAssociation) problems.push('association à l’offre incorrecte');
    if (products.has(suffix) && products.get(suffix) !== actual?.product)
      problems.push('produits mensuel et annuel différents');
    products.set(suffix, actual?.product);

    if (duplicates.includes(id)) problems.push('identifiant dupliqué entre deux variables');

    rows.push({
      label: entry.label,
      env: entry.env,
      priceId: id,
      amount: actual?.unit_amount ?? null,
      currency: actual?.currency ?? null,
      interval: actual?.recurring?.interval ?? null,
      active: actual?.active ?? null,
      expectedAmount,
      problems,
    });
  }

  const failures = rows.filter((row) => row.problems.length > 0);

  if (json) {
    process.stdout.write(`${JSON.stringify({ rows, failures: failures.length }, null, 2)}\n`);
  } else {
    for (const row of rows) {
      const amount =
        row.amount == null ? '?' : `${(row.amount / 100).toFixed(2)} ${row.currency ?? ''}`.trim();
      const expected =
        row.expectedAmount == null ? 'non contrôlé' : `${(row.expectedAmount / 100).toFixed(2)} €`;
      const status = row.problems.length === 0 ? 'ok' : `ÉCART : ${row.problems.join(' ; ')}`;
      process.stdout.write(
        `${row.label.padEnd(32)} ${row.priceId.padEnd(28)} ${amount.padEnd(14)} attendu ${expected.padEnd(12)} ${status}\n`,
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(
      `\n${failures.length} prix non conformes. Corriger les prix avant de les synchroniser.\n`,
    );
    return 1;
  }

  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('verify-stripe-catalog.mjs')) {
  process.exitCode = await main();
}
