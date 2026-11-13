import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function log(message: string) {
  console.error(message);
}

function logError(message: string) {
  console.error(message);
}

function getIssuer(): string {
  const url = process.env.OAUTH_ISSUER_URL || process.env.PUBLIC_URL;
  if (url) return url.replace(/\/$/, '');
  return 'https://api-staging.suppernote.com';
}

function getRedirectUris(): string[] {
  const raw = process.env.MISTRAL_REDIRECT_URIS || process.env.MISTRAL_REDIRECT_URI;
  if (raw)
    return raw
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);
  // Valeurs par defaut raisonnables pour Mistral. A mettre a jour quand Mistral confirme le redirect_uri exact.
  return [
    'https://chat.mistral.ai/mcp/callback',
    'https://chat.mistral.ai/mcp/auth_callback',
    'https://console.mistral.ai/build/connectors/debugger/oauth-callback',
  ];
}

async function main() {
  const issuer = getIssuer();
  const registerUrl = `${issuer}/oauth/register`;
  const redirectUris = getRedirectUris();

  log(`Registering Mistral marketplace client at ${registerUrl}`);
  log(`Redirect URIs : ${redirectUris.join(', ')}`);

  const res = await fetch(registerUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Mistral Marketplace',
      redirect_uris: redirectUris,
    }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    client_id?: string;
    client_secret?: string;
    client_name?: string;
    redirect_uris?: string[];
  };

  if (!res.ok || !data.client_id || !data.client_secret) {
    logError(`OAuth register failed: HTTP ${res.status} ${JSON.stringify(data)}`);
    process.exit(1);
  }

  const { client_id, client_secret } = data;

  log(`\nClient OAuth cree : ${client_id}`);
  log(`Client secret (confidentiel, ne pas commiter) : ${client_secret}\n`);

  const docPath = resolve(__dirname, '../../../docs/mistral-marketplace-submission.md');
  await mkdir(dirname(docPath), { recursive: true });

  const defaultRedirectUri = redirectUris[0];
  const redirectUrisMd = redirectUris.map((u) => `  - ${u}`).join('\n');

  const templateLines = [
    '# Dossier de soumission — Connector Mistral Marketplace (Suppernote)',
    '',
    '> **Statut : DRAFT EXTERNE / NON VÉRIFIÉ.** Le serveur MCP/OAuth existe, mais ce dossier',
    "> n'est pas une preuve de soumission ni d'acceptation Marketplace. Revalider le client, les",
    "> redirect URIs, l'icône, le contact et les exigences Mistral juste avant la soumission.",
    '> **Ne pas committer le client secret.** Voir',
    '> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).',
    '',
    '## 1. Informations generales',
    '',
    '- **Nom du connector** : `suppernote` (ou `suppernote-restaurant-reservations`)',
    '- **Description** : Reservez une table dans un restaurant partenaire Suppernote directement depuis Mistral Le Chat.',
    '- **Server URL** : `{{ISSUER}}/mcp`',
    '- **Icon URL** : (a fournir, ex: https://staging.suppernote.com/favicon.ico)',
    '- **System prompt** : (optionnel — prompt injecte quand les outils sont utilises)',
    '',
    '## 2. Endpoints OAuth',
    '',
    '- **Issuer** : `{{ISSUER}}`',
    '- **Authorization endpoint** : `{{ISSUER}}/oauth/authorize`',
    '- **Token endpoint** : `{{ISSUER}}/oauth/token`',
    '- **Registration endpoint** (Dynamic Client Registration) : `{{ISSUER}}/oauth/register`',
    '- **Protected resource metadata** : `{{ISSUER}}/.well-known/oauth-protected-resource`',
    '- **Authorization server metadata** : `{{ISSUER}}/.well-known/oauth-authorization-server`',
    '',
    '## 3. Credentials OAuth',
    '',
    '- **client_id** : `{{CLIENT_ID}}`',
    '- **client_secret** : `__MISTRAL_CLIENT_SECRET__` (remplacer par le secret affiche dans la console)',
    '- **redirect_uris** :',
    '{{REDIRECT_URIS}}',
    '- **scopes** : `mcp:read mcp:reserve mcp:cancel`',
    '- **grant_types** : `authorization_code`, `refresh_token`',
    '- **response_type** : `code`',
    '- **code_challenge_method** : `S256` (PKCE supporte)',
    '- **token_endpoint_auth_method** : `client_secret_basic` ou `client_secret_post`',
    '',
    '## 4. Exemple de payload `auth_data`',
    '',
    '```json',
    '{',
    '  "client_id": "{{CLIENT_ID}}",',
    '  "client_secret": "__MISTRAL_CLIENT_SECRET__",',
    '  "scopes": ["mcp:read", "mcp:reserve", "mcp:cancel"],',
    '  "redirect_uri": "{{DEFAULT_REDIRECT_URI}}"',
    '}',
    '```',
    '',
    '## 5. Notes pour Mistral',
    '',
    '- Le MCP server Suppernote implemente **StreamableHTTP** (POST /mcp) et refuse le GET /mcp (405), conformement a la spec MCP 2025-03-26.',
    "- L'authentification se fait via OAuth 2.0 Authorization Code avec PKCE.",
    "- Le consentement est public (pas de login Clerk cote client final) : l'utilisateur approuve/deny sur une page Suppernote.",
    '- Le scoping se fait au niveau des tools : le token donne acces a tous les restaurants ayant active MCP dans leur dashboard.',
    '',
    '## 6. Contact',
    '',
    '- **Email support** : support@suppernote.com (a remplacer)',
    '- **Page produit** : https://staging.suppernote.com (a remplacer par prod)',
  ];

  const doc = templateLines
    .join('\n')
    .replace(/{{ISSUER}}/g, issuer)
    .replace(/{{CLIENT_ID}}/g, client_id)
    .replace(/{{REDIRECT_URIS}}/g, redirectUrisMd)
    .replace(/{{DEFAULT_REDIRECT_URI}}/g, defaultRedirectUri);

  await writeFile(docPath, doc, 'utf-8');

  log(`Dossier de soumission ecrit : ${docPath}`);
  log('\n--- JSON auth_data a envoyer a Mistral ---');
  log(
    JSON.stringify(
      {
        client_id,
        client_secret,
        scopes: ['mcp:read', 'mcp:reserve', 'mcp:cancel'],
        redirect_uri: defaultRedirectUri,
      },
      null,
      2,
    ),
  );
  log('---');
}

main().catch((err) => {
  logError(err);
  process.exit(1);
});
