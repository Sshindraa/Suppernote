#!/usr/bin/env node
/**
 * Vérifie ou complète les événements Stripe requis par la facturation Suppernote.
 *
 * Stripe ne livre que les événements explicitement cochés sur un endpoint. Un
 * Checkout peut donc sembler fonctionner tout en laissant le compte bloqué en
 * `past_due` si invoice.payment_failed / invoice.paid ne sont pas abonnés.
 * Cette commande préserve les événements déjà activés (cartes cadeaux incluses)
 * et ajoute seulement ceux qui manquent après `--apply`.
 *
 * Usage :
 *   STRIPE_WEBHOOK_ENDPOINT_URL=https://api-staging.suppernote.com/webhooks/stripe \
 *     node --env-file=apps/api/.env scripts/ops/ensure-stripe-webhook-events.mjs
 *   STRIPE_WEBHOOK_ENDPOINT_URL=https://api-staging.suppernote.com/webhooks/stripe \
 *     node --env-file=apps/api/.env scripts/ops/ensure-stripe-webhook-events.mjs --apply
 */

const STRIPE_API = 'https://api.stripe.com/v1';

export const REQUIRED_BILLING_EVENTS = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
  'invoice.payment_succeeded',
];

export function missingRequiredEvents(enabledEvents) {
  const enabled = new Set(enabledEvents);
  return REQUIRED_BILLING_EVENTS.filter((event) => !enabled.has(event) && !enabled.has('*'));
}

export function mergedEnabledEvents(enabledEvents) {
  return [...new Set([...enabledEvents, ...REQUIRED_BILLING_EVENTS])].sort();
}

function keyMode(secretKey) {
  if (secretKey.startsWith('sk_test_')) return 'test';
  if (secretKey.startsWith('sk_live_')) return 'live';
  return 'unknown';
}

async function stripeRequest(secretKey, path, options = {}) {
  const headers = { Authorization: `Bearer ${secretKey}` };
  if (options.form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.form ? new URLSearchParams(options.form) : undefined,
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      body?.error?.message
        ? `${body.error.message} (HTTP ${response.status})`
        : `HTTP ${response.status}`,
    );
  }
  return body;
}

async function endpointForUrl(secretKey, endpointUrl) {
  let startingAfter;
  const endpoints = [];
  do {
    const params = new URLSearchParams({ limit: '100' });
    if (startingAfter) params.set('starting_after', startingAfter);
    const page = await stripeRequest(secretKey, `/webhook_endpoints?${params.toString()}`);
    endpoints.push(...page.data);
    startingAfter = page.has_more ? page.data.at(-1)?.id : undefined;
  } while (startingAfter);

  const matching = endpoints.filter((endpoint) => endpoint.url === endpointUrl);
  if (matching.length === 0) throw new Error(`Aucun endpoint Stripe configuré pour ${endpointUrl}`);
  if (matching.length > 1)
    throw new Error(`Plusieurs endpoints Stripe configurés pour ${endpointUrl}`);
  return matching[0];
}

function printText(result) {
  process.stdout.write(`Endpoint : ${result.url}\n`);
  process.stdout.write(`Mode : ${result.mode}\n`);
  process.stdout.write(
    result.missing.length === 0
      ? 'Événements billing : conformes\n'
      : `Événements billing manquants : ${result.missing.join(', ')}\n`,
  );
  if (result.updated) process.stdout.write('Endpoint Stripe mis à jour.\n');
}

export async function main(argv = process.argv.slice(2), environment = process.env) {
  const args = new Set(argv);
  const apply = args.has('--apply');
  const json = args.has('--json');
  const secretKey = environment.STRIPE_SECRET_KEY?.trim();
  const endpointUrl = environment.STRIPE_WEBHOOK_ENDPOINT_URL?.trim();

  if (!secretKey || !endpointUrl) {
    process.stderr.write('STRIPE_SECRET_KEY et STRIPE_WEBHOOK_ENDPOINT_URL sont requis.\n');
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
      environment.STRIPE_ALLOW_LIVE_WEBHOOK_MUTATION !== 'ENSURE_SOKAR_BILLING_EVENTS')
  ) {
    process.stderr.write(
      'Clé live détectée : ajouter --allow-live et STRIPE_ALLOW_LIVE_WEBHOOK_MUTATION=ENSURE_SOKAR_BILLING_EVENTS.\n',
    );
    return 2;
  }

  try {
    let endpoint = await endpointForUrl(secretKey, endpointUrl);
    let missing = missingRequiredEvents(endpoint.enabled_events ?? []);
    let updated = false;

    if (apply && missing.length > 0) {
      const form = new URLSearchParams();
      for (const event of mergedEnabledEvents(endpoint.enabled_events ?? [])) {
        form.append('enabled_events[]', event);
      }
      endpoint = await stripeRequest(
        secretKey,
        `/webhook_endpoints/${encodeURIComponent(endpoint.id)}`,
        {
          method: 'POST',
          form,
        },
      );
      missing = missingRequiredEvents(endpoint.enabled_events ?? []);
      updated = true;
    }

    const result = {
      mode,
      url: endpoint.url,
      endpointId: endpoint.id,
      status: endpoint.status,
      apply,
      updated,
      missing,
      enabledEvents: endpoint.enabled_events ?? [],
    };
    if (json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else printText(result);
    return missing.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (process.argv[1] && process.argv[1].endsWith('ensure-stripe-webhook-events.mjs')) {
  process.exitCode = await main();
}
