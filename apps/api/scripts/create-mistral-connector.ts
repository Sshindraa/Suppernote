import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@suppernote/database';
import { env } from '../src/env.js';

const MISTRAL_API_URL = 'https://api.mistral.ai/v1/connectors';

function log(message: string) {
  // eslint-disable-next-line no-console
  console.log(message);
}

function generateAgentKey(): string {
  const prefix = 'sk_suppernote_agent_';
  const random = randomBytes(32).toString('hex');
  return prefix + random;
}

function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function validateApiKeyFormat(key: string): boolean {
  const prefix = 'sk_suppernote_agent_';
  return key.startsWith(prefix) && key.length >= prefix.length + 16;
}

async function createMistralConnector(key: string) {
  const mistralApiKey = process.env.MISTRAL_API_KEY;
  if (!mistralApiKey) {
    return { created: false, error: 'MISTRAL_API_KEY manquante (connector à créer manuellement)' };
  }

  const serverUrl = process.env.SOKAR_MCP_SERVER_URL ?? 'https://api-staging.suppernote.com/mcp';
  const name = process.env.MISTRAL_CONNECTOR_NAME ?? 'suppernote-mistral';

  const visibility =
    (process.env.MISTRAL_CONNECTOR_VISIBILITY as 'private' | 'shared_workspace' | 'shared_org') ??
    'shared_workspace';

  const body = {
    name,
    description: 'Connector Mistral pour réserver un restaurant via Suppernote',
    server: serverUrl,
    visibility,
    headers: {
      Authorization: `Bearer ${key}`,
    },
  };

  const res = await fetch(MISTRAL_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${mistralApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { created: false, error: `HTTP ${res.status}: ${JSON.stringify(data)}` };
  }

  return { created: true, connectorId: data.id as string };
}

async function main() {
  const providedKey = process.env.MISTRAL_CONNECTOR_KEY;
  const key = providedKey && validateApiKeyFormat(providedKey) ? providedKey : generateAgentKey();
  if (!validateApiKeyFormat(key)) {
    throw new Error('Clé générée invalide');
  }

  const keyPrefix = key.slice(0, 16);
  const keyHash = hashApiKey(key);

  // Env.ts charge apps/api/.env ou .env.local — DATABASE_URL doit être définie.
  const prisma = new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
  });
  try {
    await prisma.agentClient.upsert({
      where: { keyHash },
      update: {
        name: 'Mistral Connector',
        scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        allowedOrigins: ['https://chat.mistral.ai'],
        revokedAt: null,
      },
      create: {
        name: 'Mistral Connector',
        keyPrefix,
        keyHash,
        scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        allowedOrigins: ['https://chat.mistral.ai'],
      },
    });
  } finally {
    await prisma.$disconnect();
  }

  log('AgentClient créé dans la base.');
  log(`MISTRAL_CONNECTOR_KEY=${key}`);

  const { created, error, connectorId } = await createMistralConnector(key);

  if (!created) {
    log(`Connector Mistral non créé via API : ${error}`);
    log('Vous pouvez créer le connector manuellement dans Mistral Studio :');
    log(
      `  Server URL : ${process.env.SOKAR_MCP_SERVER_URL ?? 'https://api-staging.suppernote.com/mcp'}`,
    );
    log(`  Header     : Authorization: Bearer ${key}`);
    process.exit(0);
  }

  log(`Connector Mistral créé avec succès : ${connectorId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
