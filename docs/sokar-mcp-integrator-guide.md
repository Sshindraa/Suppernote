# Guide intégrateur MCP Suppernote

> **Statut : ACTIF / PRODUCTION — métadonnées et appels de lecture vérifiés le 29 septembre 2026.**
> Des parcours OAuth et réservation E2E ont été exécutés avec ChatGPT et Claude ; la matrice
> complète et ses limites sont consignées dans [`la preuve de compatibilité`](./release/evidence/mcp-connector-compatibility-matrix-2026-09-29.md).
> Le transport actuel est JSON-RPC 2.0 stateless sur HTTP `POST /mcp`. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

Suppernote expose les restaurants opt-in via un serveur MCP générique. Un agent peut
découvrir un restaurant, vérifier une disponibilité, créer une réservation avec
consentement explicite, puis relire ou annuler la réservation.

## Endpoint

Local:

```http
POST http://localhost:4000/mcp
Content-Type: application/json
Authorization: Bearer sk_sokar_agent_xxx
Origin: https://claude.ai
```

Production:

```http
POST https://api.suppernote.com/mcp
Content-Type: application/json
Authorization: Bearer sk_sokar_agent_xxx
```

Staging : `POST https://api-staging.suppernote.com/mcp`. Ne pas mélanger les clients, tokens ni
redirect URIs entre staging et production.

Le body est un message JSON-RPC 2.0:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_restaurants",
    "arguments": {}
  }
}
```

Envoyez un seul message JSON-RPC par requête POST ; les batchs sont refusés.

## Authentification

Suppernote accepte un token OAuth 2.0 ou une API key dans le même header Bearer :

```http
Authorization: Bearer sk_sokar_agent_xxx
```

La clé est vérifiée via la table `AgentClient`:

- `keyHash`: hash scrypt salé de la clé complète (anciennes clés SHA-256 acceptées jusqu'à rotation)
- `keyPrefix`: préfixe affichable pour l'admin et les logs
- `restaurantId`: optionnel, limite le client à un restaurant
- `scopes`: `mcp:read`, `mcp:reserve`, `mcp:cancel` ou `mcp:*`
- `allowedOrigins`: allowlist par client si la requête browser envoie `Origin`
- `revokedAt`: révocation immédiate
- `lastUsedAt`: mis à jour à chaque appel réussi

Les tokens OAuth publics couvrent les restaurants qui ont activé MCP. L'intégration peut
demander `restaurant_id` à `/oauth/authorize` pour limiter le token à un seul restaurant,
mais ce paramètre ne donne aucun accès staff : pour lire, modifier ou annuler une
réservation avec un token OAuth, indiquez le numéro E.164 utilisé lors de sa création.
La réservation doit aussi provenir du même client MCP. Seules les clés API liées à un
restaurant peuvent agir sur toutes les réservations de ce restaurant sans cette preuve.
Quand `scope` est absent, OAuth accorde uniquement `mcp:read`.

L'enregistrement dynamique accepte les redirect URIs HTTPS, ainsi que les callbacks
HTTP sur `localhost`, `127.0.0.1` ou `[::1]` avec un port. Les clients peuvent utiliser
`client_secret_basic`, `client_secret_post` ou `none`; les clients `none` reposent sur
PKCE S256 et ne reçoivent pas de secret.

La découverte MCP publie le `resource` canonique et les scopes disponibles. Un client
qui envoie `resource` à `/oauth/authorize` doit renvoyer exactement la même valeur à
`/oauth/token`; Suppernote lie le jeton à cette audience et la vérifie sur chaque appel MCP.
Les parcours sans paramètre `resource` restent acceptés et les nouveaux jetons sont
quand même liés à l’issuer Suppernote courant. Les refresh tokens conservent cette audience.

La métadonnée d’autorisation annonce l’identification d’issuer RFC 9207. Suppernote renvoie
`iss` dans les redirections de succès et de refus. Chaque outil MCP déclare aussi son
scope OAuth dans `securitySchemes`; lorsqu’un appel échoue faute de scope, la réponse
MCP fournit `_meta["mcp/www_authenticate"]` pour proposer la liaison ou la
réautorisation. Les outils restent découvrables dans `tools/list`, mais le serveur
vérifie le scope avant toute exécution. Suppernote prend en charge le Dynamic Client
Registration (DCR) ; CIMD n’est pas annoncé.

Le fallback `AGENT_DEV_KEY` n'est accepté que lorsque `ENABLE_DEV_AUTH=true` et que la clé respecte
les contraintes de format et de longueur. Il doit rester désactivé sur les environnements partagés.
Le seed local peut créer un client `AgentClient` hashé pour la démo.

Le dashboard admin expose une page `Intégrations MCP` pour créer et révoquer les
clés en self-service. La clé complète est affichée une seule fois au moment de la
création; ensuite, seul `keyPrefix` reste visible.

Compatibilité: les anciens clients avec `mcp:write` restent acceptés pour les
actions de réservation et d'annulation, mais les nouvelles clés doivent utiliser
les scopes granulaires.

Les `Origin` browser acceptés aujourd'hui:

- `https://claude.ai`
- `https://chatgpt.com`
- `https://chat.mistral.ai`
- `https://cursor.sh`
- `http://localhost:3000`
- `http://localhost:4000`
- `http://127.0.0.1:3000`
- `http://127.0.0.1:4000`

Les requêtes non-browser sans header `Origin` sont acceptées.

## Exposition restaurant

Tous les tools MCP appliquent les règles d'exposition avant d'appeler le core:

- restaurant opt-in: `Restaurant.agenticOptIn = true`
- exposition MCP: `RestaurantExposureSettings.mcpEnabled = true`
- client lié à un restaurant: accès limité à ce `restaurantId`
- taille de groupe: `partySize <= maxPartySize`
- délai minimum: `startsAt` respecte `minLeadTimeMinutes`
- créneaux exposés: `exposedCreneaux` contient le slot demandé, sauf liste vide

Un restaurant non exposé est masqué comme s'il n'existait pas (`NOT_FOUND`).
Une contrainte non respectée retourne `POLICY_VIOLATION`.

## Handshake MCP

### initialize

Requête:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {}
}
```

Réponse:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2025-11-25",
    "capabilities": { "tools": {} },
    "serverInfo": { "name": "sokar-mcp", "version": "2.3.0" },
    "instructions": "Consignes conversationnelles fournies par Sokar…"
  }
}
```

### tools/list

Requête:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/list",
  "params": {}
}
```

Réponse: `result.tools` contient les outils publics. Chaque outil expose son
`inputSchema`, son `outputSchema` et ses annotations:

- `search_restaurants`
- `answer_availability`
- `get_restaurant_details`
- `check_availability`
- `create_quote`
- `create_hold`
- `create_reservation`
- `join_waiting_list`
- `cancel_waiting_list`
- `modify_reservation`
- `cancel_reservation`
- `get_reservation_status`

## Expérience conversationnelle

Les champs MCP (`restaurantId`, `holdToken`, `idempotencyKey`, dates ISO, etc.) sont
des détails entre l’assistant et le serveur. La personne formule son besoin en
langage courant; l’assistant extrait les informations fournies, demande seulement
ce qui manque et remplit lui-même ces champs. Il ne faut jamais demander à la
personne un identifiant de restaurant ou de réservation, un jeton, une clé
d’idempotence, du JSON ou un format de date/téléphone technique.

Après confirmation et consentement, l’assistant appelle les outils nécessaires,
en gardant leurs identifiants et résultats techniques internes. Il répond ensuite
brièvement dans la langue de la personne, par exemple : « C’est confirmé pour deux
personnes chez Chez Suppernote, jeudi 1er octobre à 19 h. » Il ne montre ni UUID, ni
`reused`, ni réponse JSON. En cas d’indisponibilité, il propose uniquement les
créneaux alternatifs retournés.

Quand la personne nomme un restaurant, l’assistant passe ce nom dans
`restaurantName`. `requestedRestaurant.status` distingue le restaurant trouvé
mais indisponible (`unavailable`) d’une fiche MCP introuvable dans cette ville
(`not_found`). Un tableau `restaurants` vide ne prouve pas que le restaurant
n’existe pas. L’assistant ne demande jamais un identifiant.

« Vers 19 h » est interprété comme un début à 19 h, sans décalage ni élargissement
du créneau. Si la personne n’a donné ni fin ni durée, l’assistant omet
`slotEnd`; le serveur complète alors 120 minutes par défaut.

Le serveur transmet ces règles dans `initialize.instructions` et dans les
descriptions des outils. Ce sont des consignes au modèle, pas une contrainte
d’affichage imposée par MCP : le client conserve la main sur sa réponse. Une
intégration qui exige une formulation garantie doit aussi appliquer ses propres
instructions système et vérifier le rendu dans son client.

Avec les versions MCP qui prennent en charge `structuredContent` (`2025-06-18`
et suivantes), le champ texte `content` d’un résultat d’outil est une phrase
courte destinée à la conversation; les informations machine, dont les UUID,
restent dans `structuredContent` pour les appels suivants. Le modèle doit
utiliser cette phrase comme base de réponse et ne pas afficher le JSON structuré
à la personne. Les erreurs suivent la même règle : `content` décrit simplement
le problème, tandis que le code de diagnostic reste dans les métadonnées. Pour
les clients `2025-03-26`, Suppernote conserve le texte JSON historique afin de ne pas
casser les intégrations qui n’exploitent pas `structuredContent`.

## Format tools/call

Tous les appels d'outil utilisent:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "tool_name",
    "arguments": {}
  }
}
```

Succès:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "{\"available\":true}" }],
    "structuredContent": { "available": true },
    "isError": false
  }
}
```

Erreur métier:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "{\"ok\":false,\"error\":\"...\",\"code\":\"INVALID_INPUT\"}" }
    ],
    "_meta": {
      "com.sokar/error": { "code": "INVALID_INPUT", "message": "..." }
    },
    "isError": true
  }
}
```

Le code et le message lisibles par machine sont dans `_meta["com.sokar/error"]`.
Le bloc texte JSON reste présent pour les anciens clients. Sur un succès, Suppernote
valide `structuredContent` contre l'`outputSchema` publié avant de répondre.

Les dates invalides ou les plages inversées renvoient le code métier
`INVALID_DATETIME` avec un message indiquant le format attendu.

Erreurs JSON-RPC transport:

- `-32700`: body vide ou parse error
- `-32600`: requête JSON-RPC invalide
- `-32601`: méthode inconnue
- `-32602`: paramètres invalides
- `-32603`: erreur interne

Erreurs HTTP auth:

- `401 UNAUTHORIZED`: header Authorization manquant
- `401 INVALID_API_KEY`: clé invalide
- `403 ORIGIN_NOT_ALLOWED`: Origin non autorisé

## Outils

### answer_availability

Recherche un horaire demandé pour une question simple en langage courant et ne renvoie qu’un
champ `message`, prêt à être affiché à la personne. La réponse ne contient pas les données
structurées de recherche, les identifiants internes ni la borne de fin utilisée pour vérifier la
disponibilité.

Utilisez cet outil pour une question comme « Vous auriez une table pour deux demain vers 19 h au
restaurant Chez Suppernote à Lyon ? ». Utilisez `search_restaurants` si la personne demande une
comparaison détaillée ou si le parcours doit réutiliser des données structurées pour une réservation.

Certains clients MCP gardent en cache la liste des outils. Après un déploiement qui ajoute un outil,
actualisez la liste du connecteur puis ouvrez une nouvelle conversation. Dans Claude, ouvrez
**Settings → Customize → Connectors → Suppernote Staging → More options → Refresh tools list**. Sans
cette actualisation, Claude peut continuer à appeler `search_restaurants` et ne pas proposer
`answer_availability`.

### search_restaurants

Recherche les restaurants opt-in exposés MCP.

Arguments:

```json
{
  "city": "Lyon",
  "restaurantName": "Chez Suppernote",
  "partySize": 2,
  "slotStart": "2026-06-23T17:00:00.000Z",
  "slotEnd": "2026-06-23T19:00:00.000Z",
  "timezone": "Europe/Paris",
  "cuisineType": ["Française"],
  "maxResults": 5
}
```

Contraintes:

- `city`: string, 1 à 100 caractères
- `partySize`: entier, 1 à 50
- `restaurantName`: optionnel; nom fourni par la personne. Lorsqu’elle nomme un restaurant, transmettez-le pour rechercher cette fiche précise.
- `slotStart`: date-time ISO avec `Z`/offset, ou date/heure locale ISO sans offset
- `slotEnd`: optionnel; même format que `slotStart`. S’il est omis, Suppernote applique une durée de 120 minutes.
- `timezone`: optionnel pour les valeurs locales (fuseau IANA, par ex. `Europe/Paris`) ; Europe/Paris est utilisé par défaut
- `cuisineType`: optionnel, maximum 10 valeurs
- `maxResults`: optionnel, entier 1 à 20, défaut 5

Réponse:

```json
{
  "searchOutcome": "available",
  "requestedRestaurant": {
    "id": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba",
    "name": "Chez Suppernote",
    "status": "available"
  },
  "restaurants": [
    {
      "id": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba",
      "name": "Chez Suppernote",
      "slug": "chez-suppernote-demo",
      "formattedAddress": "12 Rue de la République, 69001 Lyon",
      "cuisineType": ["Bistrot", "Française"],
      "priceRange": 2,
      "maxOnlinePartySize": 6,
      "availableSlots": [
        {
          "startsAt": "2026-06-23T17:00:00.000Z",
          "endsAt": "2026-06-23T19:00:00.000Z"
        }
      ]
    }
  ],
  "capacityLimits": []
}
```

Chaque résultat disponible reprend le créneau exact demandé. `capacityLimits`
identifie séparément les restaurants opt-in dont la capacité en ligne est trop
basse ; ces entrées ne sont pas présentées comme disponibles.

`searchOutcome` vaut `available`, `capacity_exceeded` ou
`no_exact_slot_available`. Une recherche exacte vide ne prouve pas qu’un
restaurant nommé n’existe pas : elle ne trouve pas de correspondance pour la
ville, le groupe et le créneau fournis.

Quand `restaurantName` est fourni, `requestedRestaurant.status` vaut
`available`, `unavailable`, `capacity_exceeded` ou `not_found`. Cette valeur
distingue un restaurant connu mais sans place à l’heure exacte d’une fiche
introuvable dans la ville; l’ID reste réservé aux appels MCP internes.

### get_restaurant_details

Retourne les informations publiques d'un restaurant.

Arguments:

```json
{
  "restaurantId": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba"
}
```

Réponse:

```json
{
  "id": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba",
  "name": "Chez Suppernote",
  "slug": "chez-suppernote-demo",
  "formattedAddress": "12 Rue de la République, 69001 Lyon",
  "phoneE164": "[REDACTED]",
  "websiteUrl": null,
  "cuisineType": ["Bistrot", "Française"],
  "priceRange": 2,
  "ambiance": ["Convivial", "Branché"],
  "noiseLevel": "ANIME",
  "dietary": ["Végétarien", "Sans gluten"],
  "openingHours": {
    "tue": { "open": "12:00", "close": "22:00" }
  }
}
```

Les champs PII ou sensibles sont redacted avant retour.

### check_availability

Vérifie un créneau pour un restaurant.

Arguments:

```json
{
  "restaurantId": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba",
  "partySize": 2,
  "slotStart": "2026-06-23T17:30:00.000Z",
  "slotEnd": "2026-06-23T19:30:00.000Z",
  "timezone": "Europe/Paris"
}
```

Réponse:

```json
{
  "available": true,
  "alternativeSlots": [],
  "decision": "available",
  "recommendedAction": "create_hold"
}
```

Si le créneau est indisponible, `alternativeSlots` propose jusqu'à cinq horaires
du même jour compatibles avec l'exposition du restaurant. `recommendedAction`
vaut `choose_alternative_slot` si une alternative existe, ou
`choose_another_slot` sinon. Si la taille du groupe dépasse le maximum en ligne,
l'outil renvoie l'erreur métier `POLICY_VIOLATION` avec le `maxPartySize` exact
dans son message ; réduisez le groupe. Les identifiants internes de holds et de
réservations ne sont pas renvoyés.

Pour un créneau disponible, `recommendedAction` vaut `create_hold` si le jeton
dispose du scope `mcp:reserve`, et `request_reserve_scope` sinon.

### create_quote et create_hold

Ces outils prennent les mêmes arguments que `check_availability`. `create_quote`
crée un enregistrement informatif temporaire. Il ne bloque pas la capacité et
son `quoteId` ne permet pas de réserver ; le créneau peut être pris avant la
réservation. Revérifiez la disponibilité ou utilisez `create_hold` pour garder
le créneau. `create_hold`
renvoie `holdToken` et `expiresAt` ;
transmettez le token à `create_reservation` avant expiration. Le hold est lié au
restaurant, à la taille du groupe et aux deux bornes exactes du créneau.

### create_reservation

Crée une réservation. L'agent doit avoir obtenu le consentement explicite de
l'utilisateur avant cet appel.

Arguments:

```json
{
  "restaurantId": "ba5be41b-eb72-4e05-bb9c-b576e39e33ba",
  "partySize": 2,
  "startsAt": "2026-06-23T17:30:00.000Z",
  "endsAt": "2026-06-23T19:30:00.000Z",
  "timezone": "Europe/Paris",
  "customerName": "Claude Test",
  "customerPhone": "+33612345678",
  "specialRequests": "Table en terrasse si possible",
  "holdToken": "optional-hold-token",
  "idempotencyKey": "agent-session-unique-key",
  "consents": {
    "reservationProcessing": true,
    "transactionalSms": false,
    "transactionalEmail": false,
    "marketingOptIn": false
  }
}
```

Contraintes:

- `customerPhone`: format E.164
- `reservationProcessing`: obligatoire et doit valoir `true`
- `idempotencyKey`: obligatoire, stable pour la tentative de création
- `specialRequests`: optionnel, maximum 500 caractères, filtré anti-injection
- `holdToken`: optionnel ; permet de consommer un hold créé par `create_hold`
- `startsAt`, `endsAt`: date-time ISO avec `Z`/offset, ou date/heure locale ISO sans offset
- `timezone`: optionnel pour les valeurs locales ; sans offset ni timezone, le fuseau du restaurant est utilisé

Réponse:

```json
{
  "reservationId": "d7aa8415-cec7-4cb0-b7ef-267e14f46993",
  "state": "CONFIRMED",
  "reused": false
}
```

### get_reservation_status

Relit l'état d'une réservation.

Arguments:

```json
{
  "reservationId": "d7aa8415-cec7-4cb0-b7ef-267e14f46993",
  "customerPhone": "+33612345678"
}
```

Réponse:

```json
{
  "id": "d7aa8415-cec7-4cb0-b7ef-267e14f46993",
  "state": "CONFIRMED",
  "partySize": 2,
  "startsAt": "2026-06-23T17:30:00.000Z",
  "endsAt": "2026-06-23T19:30:00.000Z",
  "createdAt": "2026-06-22T19:35:41.000Z"
}
```

### modify_reservation

Prend `reservationId`, `customerPhone` pour un token public, puis au moins un des
champs `partySize`, `startsAt`/`endsAt` ou `customerName`. Le nouveau créneau et la
capacité sont vérifiés dans une transaction avant la mise à jour.
Renvoyer le même changement est sûr : après la première réussite, la réponse
indique `changed: false` et aucune seconde écriture ni entrée d'audit n'est créée.

### cancel_reservation

Annule une réservation existante.
Un appel répété après l'annulation réussie renvoie `cancelled: true` sans rejouer
la transition ni ses effets secondaires.

Arguments:

```json
{
  "reservationId": "d7aa8415-cec7-4cb0-b7ef-267e14f46993",
  "customerPhone": "+33612345678",
  "reason": "Utilisateur indisponible"
}
```

Réponse:

```json
{
  "cancelled": true
}
```

### join_waiting_list

Rejoint la liste d'attente quand le créneau est complet et que le restaurateur
l'a activée (`capacitySpecials.waitingListEnabled`). Sur un créneau encore
disponible, l'outil renvoie `SLOT_AVAILABLE` et invite à réserver directement.

Arguments:

```json
{
  "restaurantId": "550e8400-e29b-41d4-a716-446655440000",
  "partySize": 4,
  "slotStart": "2026-09-10T20:00:00+02:00",
  "slotEnd": "2026-09-10T22:00:00+02:00",
  "customerFirstName": "Alice",
  "customerPhone": "+33612345678",
  "consents": {
    "waitingListProcessing": true,
    "reservationProcessing": true,
    "transactionalSms": true,
    "transactionalEmail": false,
    "marketingOptIn": false
  }
}
```

Réponse: `{ "entryId": "…", "position": 2, "actionToken": "…" }`. L'`actionToken`
est nécessaire pour retirer l'entrée, conservez-le jusqu'à la réponse du client.
`waitingListProcessing` et `reservationProcessing` sont obligatoires car une promotion
peut créer automatiquement la réservation.

### cancel_waiting_list

Retire une entrée de liste d'attente avec `entryId` et l'`actionToken` renvoyé à
l'inscription. Le code de retrait est `INVALID_STATE` si la table a déjà été
proposée entre-temps.

## Rate limit et sécurité

Chaque outil est rate-limité par client MCP, et `POST /mcp` applique en plus un
budget global de 60 requêtes par minute et par client, vérifié avant tout
traitement (HTTP 429 avec `Retry-After`). Les identifiants invalides répétés
depuis une même IP sont limités avant le calcul de hash du secret. Les réponses
sont filtrées avant sortie:

- secrets et tokens remplacés par `[REDACTED]`
- emails inline remplacés par `[REDACTED_EMAIL]`
- téléphones inline remplacés par `[REDACTED_PHONE]`
- longues chaînes hexadécimales remplacées par `[REDACTED_HEX]`

Les mutations sont auditées via le core agentic. Les outils de lecture
(`search_restaurants`, `check_availability`) ne sont pas écrits dans le journal
d'audit, ils sont comptés dans les métriques.

## Observabilité des outils MCP

Prometheus expose les appels par outil, résultat, transport, type d’authentification
(`oauth`, `api_key`, `unknown`) et les codes d’erreur normalisés :

- `sokar_mcp_tool_calls_total{tool,status}` : compteur historique commun aux appels MCP et à l’adaptateur `generic_agent` ;
- `sokar_mcp_tool_calls_by_auth_type_total{tool,status,auth_type,transport}` : volumes détaillés ;
- `sokar_mcp_tool_errors_by_code_total{tool,error_code,auth_type,transport}` : erreurs par code stable.

`transport` vaut `mcp`, `generic_agent` ou `unknown`. Filtrez `transport="mcp"`
pour isoler le trafic MCP.

Les labels sont bornés. Aucun `clientId`, nom OAuth libre, numéro de réservation ou
autre donnée client n’est ajouté aux métriques. La dimension d’auth distingue OAuth
d’une API key, mais ne différencie pas encore ChatGPT de Claude.
Les codes d’erreur sont une allowlist stable ; tout nouveau code non répertorié est
regroupé sous `OTHER` jusqu’à son ajout explicite.

Pour comparer les volumes du parcours, additionnez les compteurs par outil :

```promql
sum(increase(sokar_mcp_tool_calls_by_auth_type_total{transport="mcp",tool="search_restaurants"}[7d]))
sum(increase(sokar_mcp_tool_calls_by_auth_type_total{transport="mcp",tool="check_availability"}[7d]))
sum(increase(sokar_mcp_tool_calls_by_auth_type_total{transport="mcp",tool=~"create_hold|create_reservation"}[7d]))
```

Ces valeurs décrivent les volumes agrégés de chaque étape. Le protocole ne fournit
pas d’identifiant de parcours partagé entre appels ; elles ne mesurent donc pas une
conversion individuelle recherche → disponibilité → réservation.

## Test local E2E

Terminal 1:

```zsh
cd ~/Projects/Sokar/apps/api
PATH="/usr/local/opt/node@22/bin:$PATH" \
pnpm --filter @suppernote/api exec tsx src/main.ts
```

Terminal 2:

```zsh
cd ~/Projects/Sokar
DATABASE_URL="$(awk -F= '$1=="DATABASE_URL"{sub(/^[^=]*=/,""); gsub(/^"|"$/,""); print; exit}' .env.local)" \
PATH="/usr/local/opt/node@22/bin:$PATH" \
pnpm db:seed

cd ~/Projects/Sokar/apps/api
SOKAR_MCP_KEY="${SOKAR_MCP_KEY:?Définissez une clé MCP locale générée par le dashboard}" \
PATH="/usr/local/opt/node@22/bin:$PATH" \
pnpm --filter @suppernote/api exec tsx ../../tools/diagnostics/test-mcp-client.ts
```

Le client de test exécute:

1. `initialize`
2. `tools/list`
3. `search_restaurants`
4. `get_restaurant_details`
5. `check_availability`
6. `create_reservation`
7. `get_reservation_status`

## Claude Desktop via stdio

Le bridge stdio local expose les mêmes outils et proxy les appels vers
`POST /mcp`. L'API Suppernote doit tourner à côté.

Commande manuelle:

```zsh
cd ~/Projects/Sokar/apps/api
SOKAR_API_BASE="http://localhost:4000" \
SOKAR_MCP_KEY="${SOKAR_MCP_KEY:?Définissez une clé MCP locale générée par le dashboard}" \
PATH="/usr/local/opt/node@22/bin:$PATH" \
pnpm --filter @suppernote/api exec tsx ../../tools/diagnostics/sokar-mcp-stdio.ts
```

Exemple `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "sokar-restaurants": {
      "command": "/Users/hamza/.npm-global/bin/pnpm",
      "args": [
        "--dir",
        "~/Projects/Sokar/apps/api",
        "exec",
        "tsx",
        "../../tools/diagnostics/sokar-mcp-stdio.ts"
      ],
      "env": {
        "PATH": "/usr/local/opt/node@22/bin:/usr/local/bin:/usr/bin:/bin",
        "SOKAR_API_BASE": "http://localhost:4000",
        "SOKAR_MCP_KEY": "REPLACE_WITH_LOCAL_MCP_KEY"
      }
    }
  }
}
```
