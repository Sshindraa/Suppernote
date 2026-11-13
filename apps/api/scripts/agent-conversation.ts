/**
 * Exemple next-level : conversation multi-tours avec un LLM (Mistral / Gemini / OpenAI)
 * branché sur l'API generic-agent de Suppernote.
 *
 * Prérequis (un seul suffit) :
 *   MISTRAL_API_KEY=... pnpm exec tsx scripts/agent-conversation.ts
 *   OPENAI_API_KEY=...  pnpm exec tsx scripts/agent-conversation.ts
 *   GOOGLE_API_KEY=...  pnpm exec tsx scripts/agent-conversation.ts
 *
 * Si aucune clé LLM n'est configurée, l'exemple bascule en mode mock et joue
 * un scénario end-to-end (search → check → create) sans dépendre d'un provider.
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { env } from '../src/env.js';
import {
  SuppernoteAgentClient,
  SuppernoteAgentRunner,
  OpenAICompatibleAdapter,
  GeminiAdapter,
  MockAdapter,
  findToolResult,
  parseToolResult,
  type LLMAdapter,
  type Message,
  type MockStep,
} from '@suppernote/agent-client';

const SOKAR_API_KEY = env.AGENT_DEV_KEY ?? process.env.AGENT_STAGING_KEY;
const SOKAR_BASE_URL = process.env.SOKAR_BASE_URL ?? 'http://localhost:4000';

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message);
}

const SLOT_START = '2026-07-14T19:00:00+02:00';
const SLOT_END = '2026-07-14T21:00:00+02:00';

function buildRealLLM(): LLMAdapter | null {
  if (process.env.MISTRAL_API_KEY) {
    return new OpenAICompatibleAdapter({
      provider: 'mistral',
      apiKey: process.env.MISTRAL_API_KEY,
      model: process.env.MISTRAL_MODEL ?? 'mistral-large-latest',
      baseUrl: process.env.MISTRAL_BASE_URL,
    });
  }

  if (process.env.OPENAI_API_KEY) {
    return new OpenAICompatibleAdapter({
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL ?? 'gpt-4o',
      baseUrl: process.env.OPENAI_BASE_URL,
    });
  }

  if (process.env.GOOGLE_API_KEY) {
    return new GeminiAdapter({
      apiKey: process.env.GOOGLE_API_KEY,
      model: process.env.GEMINI_MODEL ?? 'gemini-2.0-flash',
    });
  }

  return null;
}

function buildMockLLM(): LLMAdapter {
  const steps: MockStep[] = [
    // 1. Search restaurants
    () => ({
      toolCalls: [
        {
          id: 'mock-search',
          name: 'search_restaurants',
          arguments: {
            city: 'Lyon',
            partySize: 2,
            slotStart: SLOT_START,
            slotEnd: SLOT_END,
            maxResults: 5,
          },
        },
      ],
    }),

    // 2. Check availability on the first restaurant returned
    ({ messages }) => {
      const searchMsg = findToolResult(messages, 'search_restaurants');
      const searchResult = searchMsg
        ? (parseToolResult(searchMsg) as { restaurants?: Array<{ id: string; name: string }> })
        : undefined;
      const restaurant = searchResult?.restaurants?.[0];

      if (!restaurant) {
        return { message: 'Aucun restaurant trouvé.', done: true };
      }

      return {
        toolCalls: [
          {
            id: 'mock-check',
            name: 'check_availability',
            arguments: {
              restaurantId: restaurant.id,
              partySize: 2,
              slotStart: SLOT_START,
              slotEnd: SLOT_END,
            },
          },
        ],
      };
    },

    // 3. Create reservation if available
    ({ messages }) => {
      const checkMsg = findToolResult(messages, 'check_availability');
      const checkResult = checkMsg
        ? (parseToolResult(checkMsg) as { available?: boolean; restaurantId?: string })
        : undefined;

      const searchMsg = findToolResult(messages, 'search_restaurants');
      const searchResult = searchMsg
        ? (parseToolResult(searchMsg) as { restaurants?: Array<{ id: string }> })
        : undefined;
      const restaurantId = checkResult?.restaurantId ?? searchResult?.restaurants?.[0]?.id;

      if (!checkResult?.available || !restaurantId) {
        return { message: "Le créneau demandé n'est pas disponible.", done: true };
      }

      return {
        toolCalls: [
          {
            id: 'mock-create',
            name: 'create_reservation',
            arguments: {
              restaurantId,
              partySize: 2,
              startsAt: SLOT_START,
              endsAt: SLOT_END,
              customerName: 'Alice Dupont',
              customerPhone: '+33612345678',
              specialRequests: 'Terrasse si possible',
              idempotencyKey: randomUUID(),
              consents: { reservationProcessing: true },
            },
          },
        ],
      };
    },

    // 4. Final answer
    ({ messages }) => {
      const createMsg = findToolResult(messages, 'create_reservation');
      const createResult = createMsg
        ? (parseToolResult(createMsg) as { reservationId?: string })
        : undefined;

      if (createResult?.reservationId) {
        return {
          message: `Réservation confirmée sous le numéro ${createResult.reservationId}.`,
          done: true,
        };
      }

      return { message: "Je n'ai pas pu finaliser la réservation.", done: true };
    },
  ];

  return new MockAdapter(steps);
}

function buildLLM(): LLMAdapter {
  const real = buildRealLLM();
  if (real) return real;

  log('Aucune clé LLM détectée (MISTRAL_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY).');
  log('Mode mock : scénario search → check → create.\n');
  return buildMockLLM();
}

async function main() {
  if (!SOKAR_API_KEY) {
    console.error('SOKAR_API_KEY manquant. Définissez AGENT_DEV_KEY ou AGENT_STAGING_KEY.');
    process.exit(1);
  }

  const client = new SuppernoteAgentClient({
    baseUrl: SOKAR_BASE_URL,
    apiKey: SOKAR_API_KEY,
    toolFormat: 'openai',
  });

  const llm = buildLLM();
  const runner = new SuppernoteAgentRunner(client);

  log('Provider LLM : ' + llm.provider);
  log('Suppernote base URL : ' + SOKAR_BASE_URL + '\n');

  const userMessage = process.argv.slice(2).join(' ');
  if (userMessage) {
    // Mode one-shot
    log('Utilisateur : ' + userMessage);
    await runSingleTurn(runner, llm, userMessage);
    return;
  }

  // Mode conversationnel (REPL)
  log('Mode conversationnel. Tapez votre message, ou "exit" pour quitter.\n');
  await runRepl(runner, llm);
}

async function runSingleTurn(runner: SuppernoteAgentRunner, llm: LLMAdapter, userMessage: string) {
  try {
    const result = await runner.run({ llm, userMessage });
    log('--- Réponse finale ---');
    log(result.finalMessage);
    log(`Appels d'outils exécutés : ${result.toolCallsCount}`);
  } catch (err) {
    console.error('\nErreur pendant la conversation :', err);
    process.exit(1);
  }
}

async function runRepl(runner: SuppernoteAgentRunner, llm: LLMAdapter) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let history: Message[] = [];

  try {
    while (true) {
      let input: string;
      try {
        input = await rl.question('Vous : ');
      } catch (err) {
        if ((err as { code?: string }).code === 'ERR_USE_AFTER_CLOSE') {
          break;
        }
        throw err;
      }

      const userMessage = input.trim();
      if (!userMessage) continue;
      if (userMessage.toLowerCase() === 'exit') break;

      try {
        const result = await runner.run({ llm, userMessage, history });
        history = result.history;
        log('Suppernote : ' + result.finalMessage);
        log(`(outils exécutés : ${result.toolCallsCount})\n`);
      } catch (err) {
        console.error('\nErreur pendant la conversation :', err);
        log('Une erreur est survenue. Vous pouvez réessayer.\n');
      }
    }
  } finally {
    rl.close();
  }
}

main();
