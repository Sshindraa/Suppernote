#!/usr/bin/env node
/**
 * Provisionne, de façon idempotente, le catalogue Stripe Suppernote 199/299.
 *
 * Les Price Stripe sont immuables : cette commande ne modifie ni n'archive les
 * anciens prix. Elle crée une version v3 sur les produits existants puis rend
 * les nouveaux `price_...` à synchroniser dans GitHub Actions.
 *
 * Par défaut, la commande est un aperçu. `--apply` est obligatoire pour créer
 * un prix. Une clé live exige en plus `--allow-live` et la variable de garde
 * `STRIPE_ALLOW_LIVE_CATALOG_MUTATION=CREATE_SOKAR_CATALOG_V3`.
 *
 * Les huit variables STRIPE_PRICE_* désignent les prix sources : elles servent
 * uniquement à retrouver le produit Stripe correspondant. Elles peuvent donc
 * encore pointer vers la grille historique au moment du premier lancement.
 *
 * Usage :
 *   node --env-file=apps/api/.env scripts/ops/provision-stripe-catalog.mjs
 *   node --env-file=apps/api/.env scripts/ops/provision-stripe-catalog.mjs --apply --env
 */

import { EXPECTED_CATALOG, comparePrice } from './verify-stripe-catalog.mjs';

const STRIPE_API = 'https://api.stripe.com/v1';
import catalogue from '../../packages/shared/src/pricing-catalog.cjs';
const CATALOG_VERSION = catalogue.PRICING_CATALOG_VERSION;

const PRICE_METADATA = {
  STRIPE_PRICE_ESSENTIAL_MONTHLY: { sokar_plan: 'essential', sokar_billing: 'monthly' },
  STRIPE_PRICE_ESSENTIAL_ANNUAL: { sokar_plan: 'essential', sokar_billing: 'annual' },
  STRIPE_PRICE_PRO_MONTHLY: { sokar_plan: 'pro', sokar_billing: 'monthly' },
  STRIPE_PRICE_PRO_ANNUAL: { sokar_plan: 'pro', sokar_billing: 'annual' },
  STRIPE_PRICE_MULTI_SITE_MONTHLY: { sokar_plan: 'multi-site', sokar_billing: 'monthly' },
  STRIPE_PRICE_MULTI_SITE_ANNUAL: { sokar_plan: 'multi-site', sokar_billing: 'annual' },
  STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY: {
    sokar_component: 'multi-site-addon',
    sokar_billing: 'monthly',
  },
  STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL: {
    sokar_component: 'multi-site-addon',
    sokar_billing: 'annual',
  },
};

function euro(amount) {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(amount / 100);
}

/** Une lookup key est stable entre les environnements test et live. */
export function lookupKeyFor(envName) {
  return `sokar_${envName.replace(/^STRIPE_PRICE_/, '').toLowerCase()}_${CATALOG_VERSION.replaceAll('-', '_')}`;
}

export function targetFor(entry) {
  const metadata = PRICE_METADATA[entry.env];
  if (!metadata) throw new Error(`Métadonnées absentes pour ${entry.env}`);

  return {
    ...entry,
    lookupKey: lookupKeyFor(entry.env),
    nickname: `${entry.label} — ${euro(entry.amount)}`,
    metadata: {
      sokar_managed: 'true',
      sokar_catalog_version: CATALOG_VERSION,
      sokar_price_env: entry.env,
      ...metadata,
    },
  };
}

export function creationFields(target, productId) {
  const fields = {
    product: productId,
    currency: 'eur',
    unit_amount: String(target.amount),
    tax_behavior: 'exclusive',
    lookup_key: target.lookupKey,
    nickname: target.nickname,
    'recurring[interval]': target.interval,
    'recurring[interval_count]': '1',
  };
  for (const [key, value] of Object.entries(target.metadata)) {
    fields[`metadata[${key}]`] = value;
  }
  return fields;
}

export function reusablePriceProblems(target, price, sourceProductId) {
  const problems = comparePrice(target, price, target.amount);
  if (price?.product !== sourceProductId) {
    problems.push('produit différent de celui du prix source');
  }
  if (price?.tax_behavior !== 'exclusive') {
    problems.push(`tax_behavior ${price?.tax_behavior ?? 'absent'} au lieu de exclusive`);
  }
  if (price?.billing_scheme !== 'per_unit') {
    problems.push(`billing_scheme ${price?.billing_scheme ?? 'absent'} au lieu de per_unit`);
  }
  for (const [key, value] of Object.entries(target.metadata)) {
    if (price?.metadata?.[key] !== value) {
      problems.push(`metadata.${key} absente ou différente`);
    }
  }
  return problems;
}

function keyMode(secretKey) {
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

function errorMessage(body, status) {
  return body?.error?.message ? `${body.error.message} (HTTP ${status})` : `HTTP ${status}`;
}

async function stripeRequest(secretKey, path, options = {}) {
  const headers = { Authorization: `Bearer ${secretKey}` };
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(`${STRIPE_API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.form ? new URLSearchParams(options.form) : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorMessage(body, response.status));
  return body;
}

async function fetchPrice(secretKey, priceId) {
  return stripeRequest(secretKey, `/prices/${encodeURIComponent(priceId)}`);
}

async function findPriceByLookupKey(secretKey, lookupKey) {
  const params = new URLSearchParams({ active: 'true', limit: '2' });
  params.append('lookup_keys[]', lookupKey);
  const result = await stripeRequest(secretKey, `/prices?${params.toString()}`);
  if (result.data.length > 1) {
    throw new Error(`Plusieurs prix actifs portent la lookup key ${lookupKey}`);
  }
  return result.data[0] ?? null;
}

function sourcePriceProblems(target, source) {
  const problems = [];
  if (!source?.product || typeof source.product !== 'string')
    problems.push('produit source absent');
  if (source?.currency !== 'eur') problems.push('devise source différente de eur');
  if (source?.recurring?.interval !== target.interval) {
    problems.push(
      `cadence source ${source?.recurring?.interval ?? 'absente'} au lieu de ${target.interval}`,
    );
  }
  if (source?.recurring?.interval_count !== 1) {
    problems.push(
      `interval_count source ${source?.recurring?.interval_count ?? 'absent'} au lieu de 1`,
    );
  }
  if (source?.tax_behavior !== 'exclusive') {
    problems.push(`tax_behavior source ${source?.tax_behavior ?? 'absent'} au lieu de exclusive`);
  }
  return problems;
}

function printText(rows) {
  for (const row of rows) {
    const status = row.problems.length ? `ÉCART : ${row.problems.join(' ; ')}` : row.status;
    process.stdout.write(
      `${row.env.padEnd(43)} ${(row.priceId ?? 'à créer').padEnd(30)} ${status}\n`,
    );
  }
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = new Set(argv);
  const apply = args.has('--apply');
  const json = args.has('--json');
  const envOutput = args.has('--env');
  const secretKey = environment.STRIPE_SECRET_KEY?.trim();

  if (!secretKey) {
    process.stderr.write('STRIPE_SECRET_KEY absent : catalogue non provisionné.\n');
    return 2;
  }

  const mode = keyMode(secretKey);
  if (mode === 'unknown') {
    process.stderr.write('STRIPE_SECRET_KEY doit être une clé sk_test_ ou sk_live_.\n');
    return 2;
  }
  if (
    apply &&
    mode === 'live' &&
    (!args.has('--allow-live') ||
      environment.STRIPE_ALLOW_LIVE_CATALOG_MUTATION !== 'CREATE_SOKAR_CATALOG_V3')
  ) {
    process.stderr.write(
      'Clé live détectée : ajouter --allow-live et STRIPE_ALLOW_LIVE_CATALOG_MUTATION=CREATE_SOKAR_CATALOG_V3.\n',
    );
    return 2;
  }

  const targets = EXPECTED_CATALOG.map(targetFor);
  const rows = [];

  for (const target of targets) {
    const sourcePriceId = environment[target.env]?.trim();
    if (!sourcePriceId?.startsWith('price_')) {
      rows.push({
        env: target.env,
        lookupKey: target.lookupKey,
        priceId: null,
        status: 'source manquant',
        problems: [`${target.env} doit contenir le prix source`],
      });
      continue;
    }

    try {
      const source = await fetchPrice(secretKey, sourcePriceId);
      const sourceProblems = sourcePriceProblems(target, source);
      if (sourceProblems.length) {
        rows.push({
          env: target.env,
          lookupKey: target.lookupKey,
          priceId: null,
          status: 'source invalide',
          problems: sourceProblems,
        });
        continue;
      }

      // Reuse unchanged monthly prices on their original product, without metadata mutation.
      if (
        target.interval === 'month' &&
        comparePrice(target, source, target.amount).length === 0 &&
        source.billing_scheme === 'per_unit'
      ) {
        rows.push({
          env: target.env,
          lookupKey: target.lookupKey,
          priceId: source.id,
          status: 'source inchangée réutilisée',
          problems: [],
        });
        continue;
      }

      let price = await findPriceByLookupKey(secretKey, target.lookupKey);
      let status = 'prêt à créer';
      if (!price && apply) {
        price = await stripeRequest(secretKey, '/prices', {
          method: 'POST',
          form: creationFields(target, source.product),
          idempotencyKey: `sokar-catalog-${target.lookupKey}`,
        });
        status = 'créé';
      } else if (price) {
        status = 'réutilisé';
      }

      const problems = price ? reusablePriceProblems(target, price, source.product) : [];
      rows.push({
        env: target.env,
        lookupKey: target.lookupKey,
        priceId: price?.id ?? null,
        status,
        problems,
      });
    } catch (error) {
      rows.push({
        env: target.env,
        lookupKey: target.lookupKey,
        priceId: null,
        status: 'erreur Stripe',
        problems: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  const failures = rows.filter((row) => row.problems.length > 0);
  if (envOutput) {
    for (const row of rows) {
      if (row.priceId && row.problems.length === 0) {
        process.stdout.write(`${row.env}=${row.priceId}\n`);
      }
    }
  } else if (json) {
    process.stdout.write(
      `${JSON.stringify({ mode, apply, rows, failures: failures.length }, null, 2)}\n`,
    );
  } else {
    printText(rows);
  }

  if (failures.length) {
    process.stderr.write(`\n${failures.length} entrée(s) non provisionnée(s).\n`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('provision-stripe-catalog.mjs')) {
  process.exitCode = await main();
}
