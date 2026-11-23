#!/usr/bin/env node
/**
 * Rejoue les requêtes du jeu de comportements contre un modèle : celui de production (Cerebras, par défaut)
 * ou un modèle OpenRouter (pour juger un secours). À lancer sur le serveur : la clé est lue dans le .env de
 * l'API et ne sort jamais.
 *
 * ATTENTION, Cerebras : une seule clé (CEREBRAS_API_KEY) sert aux appels et aux rejeux : chaque rejeu consomme
 * le quota des appels réels (le 29/09, des rejeux l'ont épuisé : 402, plus aucune réponse vocale). Le plafond
 * de requêtes (VBE_MAX_REQUESTS) est le seul garde-fou : à vérifier avant de lancer, surtout quand le solde est
 * bas. OpenRouter : autre crédit (OPENROUTER_API_KEY), sans effet sur les appels tant que le secours n'est pas
 * sollicité, mais le secours en dépend.
 *
 *   node voice-behavior-replay.mjs requests.json [/opt/suppernote/apps/api/.env] > responses.json
 *   VBE_ARM_B=candidat.json node voice-behavior-replay.mjs reference.json … > ab.json    (rejeu A/B)
 *
 * Rejeu A/B : les deux jeux de requêtes (mêmes cas, mêmes tirages) sont tirés dans la MÊME session, une
 * requête de chaque bras à tour de rôle. Rien n'est jamais comparé à un score stocké.
 *
 * Variables (toutes facultatives ; sans elles, Cerebras comme avant) :
 *   VBE_PROVIDER=cerebras|openrouter   fournisseur
 *   VBE_MODEL=…                        modèle (défaut : VOICE_LLM_MODEL, ou le modèle de repli pour openrouter)
 *   VBE_BASE_URL=…                     adresse (OpenRouter UE : https://eu.openrouter.ai/api/v1)
 *   VBE_ARM_B=fichier.json             requêtes du bras candidat (même cas et mêmes tirages que le fichier de référence)
 *   VBE_PROVIDER_ORDER=DeepInfra,…     openrouter : hébergeurs autorisés, sans repli (même quantification d'un bout à l'autre)
 *   VBE_REASONING_OFF=1                openrouter : envoie reasoning:{enabled:false} (modèles à raisonnement
 *                                      optionnel comme DeepSeek ; les autres le refusent avec require_parameters)
 *   VBE_REASONING_NONE=1               openrouter : envoie reasoning:{effort:'none'} (GPT-6 Luna, comme en production)
 *   VBE_SAMPLING=false                 n'envoie pas temperature (refusée par GPT-6 Luna)
 */
import { readFileSync } from 'node:fs';

const [requestsFile, envFile = '/opt/suppernote/apps/api/.env'] = process.argv.slice(2);
if (!requestsFile) throw new Error('Usage : node voice-behavior-replay.mjs requests.json [.env]');
const env = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split('\n')
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => [
      line.slice(0, line.indexOf('=')),
      line.slice(line.indexOf('=') + 1).replace(/^["']|["']$/g, ''),
    ]),
);
const { requests } = JSON.parse(readFileSync(requestsFile, 'utf8'));
const armBFile = process.env.VBE_ARM_B;
const requestsB = armBFile ? JSON.parse(readFileSync(armBFile, 'utf8')).requests : null;
if (requestsB) {
  const same =
    requestsB.length === requests.length &&
    requests.every(
      (request, index) =>
        requestsB[index].id === request.id && requestsB[index].samples === request.samples,
    );
  if (!same) {
    process.stderr.write(
      'REFUS : les deux bras doivent avoir les mêmes cas et les mêmes tirages.\n',
    );
    process.exit(1);
  }
}
const providerOrder = (process.env.VBE_PROVIDER_ORDER || '').split(',').filter(Boolean);
const provider = process.env.VBE_PROVIDER || 'cerebras';
if (provider !== 'cerebras' && provider !== 'openrouter') {
  process.stderr.write(
    `REFUS : VBE_PROVIDER doit valoir cerebras ou openrouter (reçu : ${provider}).\n`,
  );
  process.exit(1);
}
const keyName = provider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'CEREBRAS_API_KEY';
const apiKey = env[keyName];
const armCount = requestsB ? 2 : 1;
const jobCount = armCount * requests.reduce((total, request) => total + request.samples, 0);
const maxRequests = Number(process.env.VBE_MAX_REQUESTS) || 150;
if (!apiKey) {
  process.stderr.write(`REFUS : ${keyName} absente du .env.\n`);
  process.exit(1);
}
if (jobCount > maxRequests) {
  process.stderr.write(
    `REFUS : ${jobCount} requêtes (~${Math.round((jobCount * 3.4) / 1000)} M de tokens en entrée), ` +
      `plafond ${maxRequests}. Rejouer quelques cas (VBE_ONLY=id1,id2) ou relever VBE_MAX_REQUESTS.\n`,
  );
  process.exit(1);
}
// ~3,3 caractères par token (mesuré : 11 260 caractères ≈ 3,4 k tokens). Les vrais comptes du fournisseur
// sont relevés plus bas (champ usage) : ils remplacent cette estimation dès le premier rejeu.
const promptChars = (list) =>
  list.reduce(
    (total, request) => total + request.samples * JSON.stringify(request.messages).length,
    0,
  );
const estimatedPromptTokens = Math.round(
  (promptChars(requests) + (requestsB ? promptChars(requestsB) : 0)) / 3.3,
);
process.stderr.write(
  `Rejeu : ${jobCount} requêtes${requestsB ? ' (A/B alternés)' : ''}, ~${(estimatedPromptTokens / 1e6).toFixed(2)} M de tokens en entrée (estimation).\n`,
);
const model =
  process.env.VBE_MODEL ||
  (provider === 'openrouter'
    ? env.VOICE_STRUCTURED_FALLBACK_MODEL || 'deepseek/deepseek-v4-flash-0731'
    : env.VOICE_LLM_MODEL || 'qwen-3.8-27b');
const baseUrl =
  process.env.VBE_BASE_URL ||
  (provider === 'openrouter'
    ? env.OPENROUTER_FALLBACK_BASE_URL || env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
    : env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1');
process.stderr.write(`Fournisseur : ${provider} | modèle : ${model} | adresse : ${baseUrl}\n`);
/** Hébergeurs OpenRouter qui ont répondu (pour savoir qui a servi les tirages), par bras. */
const served = { reference: {}, candidate: {} };
/** Jetons comptés par le fournisseur, par bras (les 402 et les réponses vides n'y comptent pas). */
const usage = {
  reference: { requests: 0, promptTokens: 0, completionTokens: 0 },
  candidate: { requests: 0, promptTokens: 0, completionTokens: 0 },
};
if (provider === 'openrouter' && process.env.VBE_REASONING_OFF !== '1') {
  process.stderr.write(
    'ATTENTION : OpenRouter sans VBE_REASONING_OFF=1 : un modèle à raisonnement peut produire bien plus de jetons de sortie.\n',
  );
}
// VBE_CONCURRENCY=1 : mesure de durée sans charge concurrente (requêtes l'une après l'autre).
const CONCURRENCY = Number(process.env.VBE_CONCURRENCY) || 6;
/** Durée de chaque réponse valide (ms), dans l'ordre des tâches ; sortie en `latencyMs` par cas. */
const latency = new Map();

const MAX_ATTEMPTS = 6;

/**
 * Crédit épuisé (402) ou clé refusée (401/403) : inutile de continuer, chaque requête suivante échouerait
 * et le rejeu renverrait des réponses vides que rien ne distingue d'un modèle muet. Le 30/09, trois passages
 * sur six sont partis ainsi en silence et ont épuisé le crédit partagé avec les appels réels.
 */
let fatal = null;
const FATAL_STATUSES = new Set([401, 402, 403]);
/** Au-delà, trop de réponses vides pour que les taux mesurés aient un sens. */
const MAX_EMPTY_RATE = 0.25;

/** Cerebras limite les tokens par minute : un 429 se rattrape en attendant, il n'est pas un verdict. */
async function sample(request, arm = 'reference') {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const startedAt = performance.now();
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: request.messages,
          ...(request.format ? { response_format: request.format } : {}),
          ...(process.env.VBE_SAMPLING === 'false' ? {} : { temperature: 0.3 }),
          max_tokens: request.maxTokens ?? 400,
          ...(provider === 'openrouter'
            ? {
                ...(process.env.VBE_REASONING_OFF === '1' ? { reasoning: { enabled: false } } : {}),
                ...(process.env.VBE_REASONING_NONE === '1'
                  ? { reasoning: { effort: 'none' } }
                  : {}),
                provider: {
                  require_parameters: true,
                  ...(providerOrder.length ? { order: providerOrder, allow_fallbacks: false } : {}),
                },
              }
            : { reasoning_effort: 'none' }),
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (FATAL_STATUSES.has(response.status)) {
        fatal ??= `HTTP ${response.status} du fournisseur (${response.status === 402 ? 'crédit épuisé' : 'clé refusée'})`;
        return null;
      }
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        const waitS = Number(response.headers.get('retry-after')) || 5 * attempt;
        await new Promise((resolve) => setTimeout(resolve, waitS * 1000));
        continue;
      }
      const body = await response.json();
      if (body.provider) served[arm][body.provider] = (served[arm][body.provider] ?? 0) + 1;
      if (body.usage) {
        usage[arm].requests += 1;
        usage[arm].promptTokens += body.usage.prompt_tokens ?? 0;
        usage[arm].completionTokens += body.usage.completion_tokens ?? 0;
      }
      const parsed = JSON.parse(body.choices[0].message.content);
      latency.set(request, [
        ...(latency.get(request) ?? []),
        Math.round(performance.now() - startedAt),
      ]);
      return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

// Test préalable : une requête minimale. Un refus arrête tout avant de dépenser quoi que ce soit.
await sample({
  messages: [{ role: 'user', content: 'ok' }],
  format: undefined,
  maxTokens: 3,
});
if (fatal) {
  process.stderr.write(`ARRÊT : ${fatal}. Aucune requête du jeu n'a été envoyée.\n`);
  process.exit(2);
}
// Le test préalable n'est pas une requête du jeu : il ne compte pas dans les jetons du bras.
usage.reference = { requests: 0, promptTokens: 0, completionTokens: 0 };

// Bras alternés tirage par tirage : le candidat ne passe jamais « après » la référence dans la session.
const jobs = requests.flatMap((request, index) =>
  Array.from({ length: request.samples }, () =>
    requestsB
      ? [
          { request, arm: 'reference' },
          { request: requestsB[index], arm: 'candidate' },
        ]
      : [{ request, arm: 'reference' }],
  ).flat(),
);
const results = new Array(jobs.length);
let cursor = 0;
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (!fatal && cursor < jobs.length) {
      const index = cursor++;
      results[index] = await sample(jobs[index].request, jobs[index].arm);
    }
  }),
);
if (fatal) {
  process.stderr.write(
    `ARRÊT : ${fatal}. Rejeu interrompu, aucune sortie écrite (elle serait faussée par des réponses vides).\n`,
  );
  process.exit(2);
}
const empty = results.filter((result) => result == null).length;
if (empty / jobs.length > MAX_EMPTY_RATE) {
  process.stderr.write(
    `ARRÊT : ${empty}/${jobs.length} réponses vides (réseau, quota ou format ?). Sortie non écrite.\n`,
  );
  process.exit(3);
}
const collect = (arm) => {
  const responses = {};
  jobs.forEach((job, index) => {
    if (job.arm === arm) (responses[job.request.id] ??= []).push(results[index]);
  });
  return responses;
};
const latencyOf = (list) =>
  Object.fromEntries(list.map((request) => [request.id, latency.get(request) ?? []]));
const report = (arm) =>
  `${arm} : ${usage[arm].requests} requêtes comptées, ${usage[arm].promptTokens} tokens en entrée, ${usage[arm].completionTokens} en sortie`;
process.stderr.write(
  `Jetons comptés par le fournisseur — ${report('reference')}${requestsB ? ` | ${report('candidate')}` : ''}\n`,
);
if (requestsB) {
  process.stdout.write(
    JSON.stringify({
      runId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      startedAt: new Date().toISOString(),
      model,
      provider,
      baseUrl,
      served,
      arms: {
        reference: {
          model,
          usage: usage.reference,
          responses: collect('reference'),
          latencyMs: latencyOf(requests),
        },
        candidate: {
          model,
          usage: usage.candidate,
          responses: collect('candidate'),
          latencyMs: latencyOf(requestsB),
        },
      },
    }),
  );
} else {
  process.stdout.write(
    JSON.stringify({
      model,
      provider,
      baseUrl,
      served: served.reference,
      usage: usage.reference,
      responses: collect('reference'),
      latencyMs: latencyOf(requests),
    }),
  );
}
