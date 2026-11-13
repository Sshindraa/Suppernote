# Dossier de soumission — Connector Mistral Marketplace (Suppernote)

> **Statut : DRAFT EXTERNE / NON VÉRIFIÉ — audité le 12 septembre 2026.**
> Le serveur MCP/OAuth existe, mais ce dossier n'est pas une preuve de soumission ni
> d'acceptation Marketplace. Créer ou revalider le client, les redirect URIs, l'icône, le contact
> et les exigences Mistral juste avant la soumission. Ne jamais réutiliser aveuglément un
> `client_id` de staging. **Ne pas committer le client secret.** Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

## 1. Informations generales

- **Nom du connector** : `suppernote` (ou `suppernote-restaurant-reservations`)
- **Description** : Reservez une table dans un restaurant partenaire Suppernote directement depuis Mistral Le Chat.
- **Server URL** : `https://api-staging.suppernote.com/mcp`
- **Icon URL** : (a fournir, ex: https://staging.suppernote.com/favicon.ico)
- **System prompt** : (optionnel — prompt injecte quand les outils sont utilises)

## 2. Endpoints OAuth

- **Issuer** : `https://api-staging.suppernote.com`
- **Authorization endpoint** : `https://api-staging.suppernote.com/oauth/authorize`
- **Token endpoint** : `https://api-staging.suppernote.com/oauth/token`
- **Registration endpoint** (Dynamic Client Registration) : `https://api-staging.suppernote.com/oauth/register`
- **Protected resource metadata** : `https://api-staging.suppernote.com/.well-known/oauth-protected-resource`
- **Authorization server metadata** : `https://api-staging.suppernote.com/.well-known/oauth-authorization-server`

## 3. Credentials OAuth

- **client_id** : `2bcdfa2d-f812-4b84-8bfe-7f600661dea4`
- **client_secret** : `__MISTRAL_CLIENT_SECRET__` (remplacer par le secret affiche dans la console)
- **redirect_uris** :
  - https://chat.mistral.ai/mcp/callback
  - https://chat.mistral.ai/mcp/auth_callback
  - https://console.mistral.ai/build/connectors/debugger/oauth-callback
- **scopes** : `mcp:read mcp:reserve mcp:cancel`
- **grant_types** : `authorization_code`, `refresh_token`
- **response_type** : `code`
- **code_challenge_method** : `S256` (PKCE supporte)
- **token_endpoint_auth_method** : `client_secret_basic` ou `client_secret_post`

## 4. Exemple de payload `auth_data`

```json
{
  "client_id": "2bcdfa2d-f812-4b84-8bfe-7f600661dea4",
  "client_secret": "__MISTRAL_CLIENT_SECRET__",
  "scopes": ["mcp:read", "mcp:reserve", "mcp:cancel"],
  "redirect_uri": "https://chat.mistral.ai/mcp/callback"
}
```

## 5. Notes pour Mistral

- Le MCP server Suppernote implemente **StreamableHTTP** (POST /mcp) et refuse le GET /mcp (405), conformement a la spec MCP 2025-03-26.
- L'authentification se fait via OAuth 2.0 Authorization Code avec PKCE.
- Le consentement est public (pas de login Clerk cote client final) : l'utilisateur approuve/deny sur une page Suppernote.
- Le scoping se fait au niveau des tools : le token donne acces a tous les restaurants ayant active MCP dans leur dashboard.

## 6. Contact

- **Email support** : support@suppernote.com (a remplacer)
- **Page produit** : https://staging.suppernote.com (a remplacer par prod)
