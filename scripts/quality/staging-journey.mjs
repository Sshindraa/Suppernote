#!/usr/bin/env node
/**
 * Parcours de nuit sur le site de test : vérifie que la chaîne réelle fonctionne de bout en bout,
 * indépendamment des déploiements (une dérive de configuration ou d'un fournisseur se voit ici).
 *
 * Aucune donnée durable : la réservation est un créneau gardé (« hold ») qui expire seul en
 * quelques minutes ; aucune réservation, aucun paiement, aucun SMS.
 *
 * Usage : node scripts/quality/staging-journey.mjs
 * Variables : JOURNEY_API_URL (défaut https://api-staging.suppernote.com),
 *             JOURNEY_SITE_URL (défaut https://staging.suppernote.com),
 *             JOURNEY_RESTAURANT_SLUG (défaut chez-suppernote-demo).
 */

const API = (process.env.JOURNEY_API_URL ?? 'https://api-staging.suppernote.com').replace(
  /\/+$/,
  '',
);
const SITE = (process.env.JOURNEY_SITE_URL ?? 'https://staging.suppernote.com').replace(/\/+$/, '');
const SLUG = process.env.JOURNEY_RESTAURANT_SLUG ?? 'chez-suppernote-demo';
const TIMEOUT_MS = 15_000;

const results = [];

/** Rapport lisible dans les journaux GitHub Actions. */
function print(line) {
  process.stdout.write(`${line}\n`);
}

async function call(url, init = {}) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true });
    print(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ name, ok: false });
    print(`❌ ${name} — ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Date à J+offset dans le fuseau du restaurant (Europe/Paris), au format AAAA-MM-JJ. */
function dateInParis(offsetDays) {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000));
}

await step('API en bonne santé (base, Redis, files, workers)', async () => {
  const { status, body } = await call(`${API}/health`);
  assert(status === 200, `HTTP ${status}`);
  for (const name of ['db', 'redis', 'queues', 'workers']) {
    const check = body?.checks?.[name];
    assert(check?.status === 'ok', `${name} : ${check?.status ?? 'absent'} ${check?.error ?? ''}`);
  }
  return `telnyx ${body?.checks?.telnyx?.status}, elevenlabs ${body?.checks?.elevenlabs?.status}`;
});

let slots = [];
let date = null;

await step('Page publique du restaurant', async () => {
  const { status, body } = await call(`${API}/public/r/${SLUG}`);
  assert(status === 200, `HTTP ${status}`);
  assert(body && (body.name || body.restaurant?.name), 'réponse sans nom de restaurant');
});

await step('Disponibilités sur les 7 prochains jours (2 personnes)', async () => {
  // Le restaurant ferme certains jours : on prend le premier jour ouvert avec un créneau libre.
  for (let offset = 1; offset <= 7; offset++) {
    const day = dateInParis(offset);
    const { status, body } = await call(
      `${API}/public/r/${SLUG}/availability?date=${day}&partySize=2`,
    );
    assert(status === 200, `HTTP ${status} pour ${day}`);
    const free = (body?.slots ?? []).filter((item) => item.available);
    if (free.length > 0) {
      date = day;
      // Milieu de journée d'abord, puis les créneaux voisins : un autre client (ou le lancement précédent)
      // peut déjà garder un créneau identique pendant quelques minutes.
      const middle = Math.floor(free.length / 2);
      slots = free
        .map((item, index) => ({ time: item.time, index }))
        .sort((a, b) => Math.abs(a.index - middle) - Math.abs(b.index - middle))
        .map((item) => item.time);
      return `${day} : ${free.length} créneaux libres`;
    }
  }
  throw new Error('aucun créneau libre sur 7 jours');
});

await step('Créneau gardé (expire seul, aucune réservation créée)', async () => {
  assert(slots.length > 0, 'pas de créneau à garder');
  let lastFailure = '';
  for (const slot of slots.slice(0, 5)) {
    const { status, body } = await call(`${API}/public/r/${SLUG}/hold`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ date, time: slot, partySize: 2, source: 'web', website: '' }),
    });
    if (status === 200 || status === 201) {
      assert(
        typeof body?.holdToken === 'string' && body.holdToken.length >= 10,
        'pas de holdToken',
      );
      return `${slot}, expire à ${body.expiresAt}`;
    }
    // 409 : créneau déjà gardé par quelqu'un d'autre, on essaie le suivant ; toute autre réponse est une panne.
    lastFailure = `HTTP ${status} ${JSON.stringify(body)?.slice(0, 120)}`;
    if (status !== 409) break;
  }
  throw new Error(`aucun créneau n'a pu être gardé (${lastFailure})`);
});

await step('Facturation Stripe active (statut lisible)', async () => {
  const { status, body } = await call(`${API}/billing/status`);
  assert(status === 200, `HTTP ${status} ${JSON.stringify(body)?.slice(0, 160)}`);
  assert(typeof body?.plan === 'string', 'réponse sans formule');
});

await step('Serveur MCP protégé et documenté', async () => {
  const mcp = await call(`${API}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
  });
  assert(mcp.status === 401, `/mcp sans jeton : HTTP ${mcp.status}`);
  assert(
    /resource_metadata|oauth-protected-resource/.test(mcp.headers.get('www-authenticate') ?? ''),
    'WWW-Authenticate absent',
  );
  const meta = await call(`${API}/.well-known/oauth-protected-resource`);
  assert(meta.status === 200, `métadonnées : HTTP ${meta.status}`);
  const doc = meta.body?.resource_documentation;
  assert(typeof doc === 'string', 'resource_documentation absent');
  const page = await fetch(doc, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  assert(page.status === 200, `documentation ${doc} : HTTP ${page.status}`);
});

for (const path of ['/', '/pricing', '/assistants-ia', `/restaurant/${SLUG}`]) {
  await step(`Page ${path}`, async () => {
    const response = await fetch(`${SITE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    assert(response.status === 200, `HTTP ${response.status}`);
  });
}

const failed = results.filter((item) => !item.ok);
print(`\n${results.length - failed.length}/${results.length} étapes réussies`);
process.exit(failed.length ? 1 : 0);
