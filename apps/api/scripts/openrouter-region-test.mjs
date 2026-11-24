#!/usr/bin/env node
/**
 * Compare le routage OpenRouter mondial, UE et (option) US pour le secours vocal du tour structuré.
 * Reproduit l'appel de `fetchFallbackStreaming` (manager.ts) : même modèle, même ordre d'hébergeurs, même
 * JSON Schema strict, en flux. Données SYNTHÉTIQUES uniquement : aucune donnée personnelle ne part.
 *
 * Mesure, par adresse : accès (auth), hébergeurs proposés pour le modèle, puis N appels structurés
 * (statut, JSON valide, hébergeur qui a répondu, délai du premier fragment et total), puis l'API `decisions` de Jev.
 * Les adresses sont alternées appel par appel pour ne pas biaiser par l'heure. Coût : quelques centimes
 * d'OpenRouter, jamais de crédit Cerebras.
 *
 * Usage (sur le VPS, la clé reste dans l'environnement) :
 *   node --env-file=/opt/suppernote-staging/apps/api/.env openrouter-region-test.mjs [--runs 10] [--us]
 * Ne modifie aucune configuration.
 */
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const RUNS = Number(flag('--runs', '10'));
const apiKey = process.env.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error('OPENROUTER_API_KEY absente de l’environnement.');
  process.exit(1);
}
const MODEL = process.env.VOICE_STRUCTURED_FALLBACK_MODEL || 'deepseek/deepseek-v4-flash-0731';
const ORDER = (process.env.VOICE_STRUCTURED_FALLBACK_PROVIDER_ORDER ?? 'Cohere,Wafer,Baidu')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);
const ENDPOINTS = [
  { name: 'mondial', base: 'https://openrouter.ai/api' },
  { name: 'UE', base: 'https://eu.openrouter.ai/api' },
  ...(args.includes('--us') ? [{ name: 'US', base: 'https://us.openrouter.ai/api' }] : []),
];
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    turnComplete: { type: 'boolean' },
    interpretation: {
      type: 'string',
      enum: [
        'answer',
        'question',
        'correction',
        'affirmation',
        'decline',
        'new_request',
        'end_call',
        'unclear',
      ],
    },
    draft: {
      type: 'object',
      additionalProperties: false,
      properties: {
        date: { type: 'string' },
        time: { type: 'string' },
        partySize: { type: 'integer' },
        customerName: { type: 'string' },
      },
      required: ['date', 'time', 'partySize', 'customerName'],
    },
    awaiting: {
      type: 'string',
      enum: [
        'none',
        'date',
        'time',
        'partySize',
        'customerName',
        'customerNameConfirmation',
        'confirmation',
        'humanFallback',
        'open',
      ],
    },
    action: {
      type: 'string',
      enum: [
        'none',
        'check_availability',
        'create_reservation',
        'take_message',
        'transfer',
        'end_call',
      ],
    },
    message: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    say: { type: 'string' },
  },
  required: [
    'turnComplete',
    'interpretation',
    'draft',
    'awaiting',
    'action',
    'message',
    'confidence',
    'say',
  ],
};
const MESSAGES = [
  {
    role: 'system',
    content:
      "Tu es l'assistant vocal du restaurant Test. Tu renvoies un objet JSON qui décrit ta compréhension et ta réponse. Nous sommes le 2026-10-01.",
  },
  { role: 'user', content: 'bonjour je voudrais réserver une table pour demain soir' },
];
const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)]
    : null;
};

async function structuredCall(base) {
  const startedAt = performance.now();
  const result = {
    status: null,
    ttfbMs: null,
    totalMs: null,
    provider: null,
    validJson: false,
    error: null,
  };
  try {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        model: MODEL,
        messages: MESSAGES,
        max_tokens: 400,
        temperature: 0.3,
        top_p: 0.8,
        reasoning: { enabled: false },
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'voice_turn', strict: true, schema: SCHEMA },
        },
        provider: ORDER.length
          ? { require_parameters: true, order: ORDER, allow_fallbacks: true }
          : { require_parameters: true, sort: 'latency' },
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    result.status = response.status;
    if (!response.ok || !response.body) {
      result.error = (await response.text().catch(() => '')).slice(0, 160);
      result.totalMs = performance.now() - startedAt;
      return result;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (value && result.ttfbMs === null) result.ttfbMs = performance.now() - startedAt;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const chunk = JSON.parse(line.slice(5));
          if (chunk.provider) result.provider = chunk.provider;
          content += chunk.choices?.[0]?.delta?.content ?? '';
        } catch {
          /* commentaires SSE */
        }
      }
    }
    result.totalMs = performance.now() - startedAt;
    try {
      const parsed = JSON.parse(content);
      result.validJson = SCHEMA.required.every((key) => key in parsed);
    } catch {
      result.validJson = false;
    }
  } catch (error) {
    result.error =
      error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 160) : String(error);
    result.totalMs = performance.now() - startedAt;
  }
  return result;
}

async function simpleGet(url) {
  const startedAt = performance.now();
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = await response.text();
    return { status: response.status, ms: performance.now() - startedAt, text };
  } catch (error) {
    return { status: null, ms: performance.now() - startedAt, text: String(error).slice(0, 120) };
  }
}

async function decisionsCall(base) {
  const startedAt = performance.now();
  try {
    const response = await fetch(`${base}/alpha/decisions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        model: 'typesafe/jev-1.13-20260917',
        state: 'MESSAGE DU CLIENT À ÉVALUER : bonjour',
        questions: {
          salue: {
            type: 'noul',
            instructions: 'Le client salue-t-il ?',
            criteria: { true: 'Il dit bonjour', false: 'Il ne salue pas' },
          },
        },
      }),
    });
    return {
      status: response.status,
      ms: performance.now() - startedAt,
      body: (await response.text()).slice(0, 120),
    };
  } catch (error) {
    return { status: null, ms: performance.now() - startedAt, body: String(error).slice(0, 120) };
  }
}

const report = {};
for (const endpoint of ENDPOINTS)
  report[endpoint.name] = { calls: [], providers: null, auth: null };

// 1. Accès et hébergeurs proposés pour le modèle.
for (const endpoint of ENDPOINTS) {
  const auth = await simpleGet(`${endpoint.base}/v1/auth/key`);
  report[endpoint.name].auth = { status: auth.status, ms: Math.round(auth.ms) };
  const providers = await simpleGet(`${endpoint.base}/v1/models/${MODEL}/endpoints`);
  try {
    const list = JSON.parse(providers.text)?.data?.endpoints ?? [];
    report[endpoint.name].providers = {
      status: providers.status,
      names: list.map((item) => item.provider_name),
    };
  } catch {
    report[endpoint.name].providers = { status: providers.status, names: null };
  }
}

// 2. Appels structurés alternés (mondial, UE, mondial, UE…).
for (let run = 0; run < RUNS; run++) {
  for (const endpoint of ENDPOINTS)
    report[endpoint.name].calls.push(await structuredCall(endpoint.base));
}

// 3. API decisions de Jev (hors /v1).
for (const endpoint of ENDPOINTS)
  report[endpoint.name].decisions = await decisionsCall(endpoint.base);

console.log(
  `Modèle : ${MODEL} | ordre d'hébergeurs : ${ORDER.join(',') || '(tri par latence)'} | ${RUNS} appels par adresse\n`,
);
for (const endpoint of ENDPOINTS) {
  const data = report[endpoint.name];
  const ok = data.calls.filter((call) => call.status === 200);
  const valid = ok.filter((call) => call.validJson);
  const providers = {};
  for (const call of ok)
    providers[call.provider ?? '?'] = (providers[call.provider ?? '?'] ?? 0) + 1;
  const statuses = {};
  for (const call of data.calls)
    statuses[call.status ?? 'erreur'] = (statuses[call.status ?? 'erreur'] ?? 0) + 1;
  const ttfb = ok.map((call) => call.ttfbMs).filter((value) => value !== null);
  const total = ok.map((call) => call.totalMs);
  const fmt = (value) => (value === null ? 'n/a' : `${Math.round(value)} ms`);
  console.log(`== ${endpoint.name} (${endpoint.base})`);
  console.log(
    `  accès : auth HTTP ${data.auth.status} (${data.auth.ms} ms) ; hébergeurs du modèle : HTTP ${data.providers.status} ${data.providers.names ? data.providers.names.join(', ') : '(illisible)'}`,
  );
  console.log(
    `  appels structurés : statuts ${JSON.stringify(statuses)} ; JSON conforme ${valid.length}/${data.calls.length}`,
  );
  console.log(`  hébergeur ayant répondu : ${JSON.stringify(providers)}`);
  console.log(
    `  premier fragment : p50 ${fmt(percentile(ttfb, 0.5))} / p95 ${fmt(percentile(ttfb, 0.95))} ; total : p50 ${fmt(percentile(total, 0.5))} / p95 ${fmt(percentile(total, 0.95))}`,
  );
  const failed = data.calls.find((call) => call.status !== 200);
  if (failed) console.log(`  exemple d'échec : ${failed.status ?? ''} ${failed.error ?? ''}`);
  console.log(
    `  Jev (decisions) : HTTP ${data.decisions.status} en ${Math.round(data.decisions.ms)} ms ${data.decisions.status === 200 ? '' : data.decisions.body}\n`,
  );
}
