# Suppernote Agentic Reservations Layer — Spec v2

> **Positionnement**: l'infrastructure qui rend les restaurants indépendants
> réservables par ChatGPT, Claude et les futurs agents, avec disponibilité
> réelle, politiques maîtrisées, et zéro lock-in marketplace.
>
> **Statut**: spec d'implémentation v2 (post-revue critique).
> **Pas de code avant validation explicite de Hamza.**

---

## 0. Résumé exécutif

Trois couches strictement séparées :

```
┌──────────────────────────────────────────────────────────────┐
│  Adapters (transport / spec externe)                         │
│  ┌─────────────────────┐  ┌─────────────────────────────┐    │
│  │ MCP générique       │  │ OpenAI Apps SDK Reserve     │    │
│  │ (Claude, Cursor)    │  │ (widget + business feed)    │    │
│  └──────────┬──────────┘  └──────────┬──────────────────┘    │
│             │                        │                        │
│             └────────────┬───────────┘                        │
│                          ▼                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Core reservation engine (transport-agnostique)       │    │
│  │  tokens (quote/hold), idempotency, state machine,     │    │
│  │  audit log, policies                                  │    │
│  └──────────────────────────────────────────────────────┘    │
│                          ▲                                    │
│                          │                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Restaurant admin / opt-in / exposure settings        │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

**Règle d'or** : le core survit si OpenAI change sa spec, si MCP change de
transport, ou si on ajoute Perplexity/Google demain. Les adapters sont jetables.

---

## 1. Audit Prisma — état actuel vs besoins agentic

### 1.1 Ce qui existe déjà (réutilisable)

- `Restaurant` (id, name, plan, phone, openingHours, smsConfirmEnabled)
- `Reservation` (id, restaurantId, callId, customerId, reservedAt, partySize,
  customerName, customerPhone, status, revenue, googleEventId)
- `Customer` (id, restaurantId, phone, name, visitCount, isVip, notes)
- Enums : `Plan`, `ReservationStatus {CONFIRMED, CANCELLED, NO_SHOW, SEATED}`

### 1.2 Ce qui manque (bloquant pour agentic)

| Champ manquant                    | Pourquoi critique                       | Priorité |
| --------------------------------- | --------------------------------------- | -------- |
| `Restaurant.slug`                 | URL canonique pour OpenAI business feed | P0       |
| `Restaurant.canonicalUrl`         | Idem                                    | P0       |
| `Restaurant.lat` / `lng`          | Géo, distance, search                   | P0       |
| `Restaurant.timezone`             | Slots tz-aware, conversion correcte     | P0       |
| `Restaurant.phoneE164`            | Format international, SMS               | P0       |
| `Restaurant.formattedAddress`     | Business feed OpenAI                    | P0       |
| `Restaurant.cuisineType`          | Filtre search                           | P1       |
| `Restaurant.priceRange`           | Filtre budget                           | P1       |
| `Restaurant.ambiance[]`           | Filtre ambiance + data confidence       | P1       |
| `Restaurant.noiseLevel`           | Filtre calme/animé                      | P1       |
| `Restaurant.dietary[]`            | Filtre végé/sans gluten                 | P2       |
| `Restaurant.agenticOptIn`         | Bool opt-in MCP                         | P0       |
| `Restaurant.openaiReserveEnabled` | Bool opt-in OpenAI Reserve              | P0       |
| `Restaurant.policyVersion`        | Snapshot policies au moment de la résa  | P1       |

### 1.3 Côté `Reservation`

| Champ manquant                       | Pourquoi                                       | Priorité |
| ------------------------------------ | ---------------------------------------------- | -------- |
| `Reservation.channel`                | Attribution openai / mcp / web / phone / admin | P0       |
| `Reservation.startsAt` / `endsAt`    | Calcul durée, no-show window                   | P0       |
| `Reservation.holdExpiresAt`          | TTL du hold                                    | P0       |
| `Reservation.idempotencyKey`         | Anti-doublon (unique index)                    | P0       |
| `Reservation.cancellationPolicySnap` | Snapshot au moment T                           | P1       |
| `Reservation.noShowPolicySnap`       | Snapshot au moment T                           | P1       |
| `Reservation.specialRequests`        | Demandes spéciales client                      | P1       |
| `Reservation.createdByClient`        | Identifiant LLM/agent appelant                 | P0       |
| `Reservation.consents` (Json)        | RGPD structuré                                 | P0       |

### 1.4 Nouveaux modèles

- `AgenticHold` (quote + hold tokens, expiration, restaurant, slot, party_size)
- `ReservationAuditLog` (immutable, append-only)
- `RestaurantExposureSettings` (config opt-in par resto, voir §4)
- `AgentClient` (clients MCP/OpenAI approuvés, clés, quotas)

### 1.5 Migration S1 à prévoir

- Ajout champs `Restaurant` + `Reservation`
- Ajout enum `ReservationChannel`
- Ajout enum `ReservationState` plus riche (voir §5.2)
- Création tables `agentic_holds`, `reservation_audit_log`,
  `restaurant_exposure_settings`, `agent_clients`

---

## 2. Cible schéma Prisma — diff proposé

```prisma
// Extensions au modèle Restaurant existant
model Restaurant {
  // ...champs existants conservés...

  // Géo & identité externe
  slug                  String   @unique
  canonicalUrl          String?  @map("canonical_url")
  lat                   Decimal? @db.Decimal(9, 6)
  lng                   Decimal? @db.Decimal(9, 6)
  formattedAddress      String?  @map("formatted_address")
  timezone              String   @default("Europe/Paris")
  phoneE164             String?  @map("phone_e164")
  websiteUrl            String?  @map("website_url")

  // Attributs de découverte
  cuisineType           String[] @map("cuisine_type")
  priceRange            Int?     @map("price_range")          // 1-4 ($-$$$$)
  ambiance              String[] @default([])
  noiseLevel            NoiseLevel? @map("noise_level")
  dietary               String[] @default([])

  // Data quality par attribut (Json)
  // { "ambiance": { source: "merchant_declared", confidence: 0.9 }, ... }
  attributeConfidence   Json     @default("{}") @map("attribute_confidence")

  // Opt-in agentic
  agenticOptIn          Boolean  @default(false) @map("agentic_opt_in")
  openaiReserveEnabled  Boolean  @default(false) @map("openai_reserve_enabled")
  policyVersion         String   @default("2026-06-20") @map("policy_version")

  // ...relations existantes...
  exposureSettings      RestaurantExposureSettings?
}

enum NoiseLevel {
  CALME
  MODERE
  ANIME
}
```

```prisma
// Extension Reservation
model Reservation {
  // ...champs existants conservés...

  channel             ReservationChannel @default(PHONE)
  startsAt            DateTime?           @map("starts_at")
  endsAt              DateTime?           @map("ends_at")
  holdExpiresAt       DateTime?           @map("hold_expires_at")
  idempotencyKey      String?             @unique @map("idempotency_key")
  state               ReservationState    @default(PENDING)
  cancellationPolicySnap Json?            @map("cancellation_policy_snap")
  noShowPolicySnap    Json?               @map("no_show_policy_snap")
  specialRequests     String?             @map("special_requests")
  createdByClient     String?             @map("created_by_client") // agent client id
  consents            Json                @default("{}")
  auditLog            ReservationAuditLog[]
}

enum ReservationChannel {
  PHONE
  WEB
  MCP
  OPENAI_RESERVE
  ADMIN
  API
}

enum ReservationState {
  PENDING
  CONFIRMED
  SEATED
  HONORED
  CANCELLED
  NO_SHOW
  FAILED
  EXPIRED
}

model AgenticHold {
  id              String     @id @default(uuid())
  restaurantId    String     @map("restaurant_id")
  type            HoldType
  partySize       Int        @map("party_size")
  slotStart       DateTime   @map("slot_start")
  slotEnd         DateTime   @map("slot_end")
  channel         ReservationChannel
  quoteToken      String?    @unique @map("quote_token")
  holdToken       String?    @unique @map("hold_token")
  expiresAt       DateTime   @map("expires_at")
  consumedAt      DateTime?  @map("consumed_at")
  policyVersion   String     @map("policy_version")
  reservationId   String?    @map("reservation_id")
  createdAt       DateTime   @default(now()) @map("created_at")
  restaurant      Restaurant @relation(fields: [restaurantId], references: [id])

  @@index([restaurantId, slotStart])
  @@index([expiresAt])
  @@map("agentic_holds")
}

enum HoldType {
  QUOTE
  HOLD
}

model ReservationAuditLog {
  id            String   @id @default(uuid())
  reservationId String?  @map("reservation_id")
  holdId        String?  @map("hold_id")
  actor         String                            // 'agent:openai', 'agent:claude', 'resto:42', 'system'
  event         String                            // 'state_transition', 'hold_created', 'hold_consumed', 'hold_expired'
  fromState     String? @map("from_state")
  toState       String? @map("to_state")
  metadata      Json    @default("{}")
  createdAt     DateTime @default(now()) @map("created_at")

  reservation   Reservation? @relation(fields: [reservationId], references: [id])

  @@index([reservationId, createdAt])
  @@index([createdAt])
  @@map("reservation_audit_log")
}

model RestaurantExposureSettings {
  restaurantId           String   @id @map("restaurant_id")
  mcpEnabled             Boolean  @default(false) @map("mcp_enabled")
  openaiReserveEnabled   Boolean  @default(false) @map("openai_reserve_enabled")

  // Créneaux exposés (défaut = tous)
  exposedCreneaux        Json     @default("[]") @map("exposed_creneaux")

  maxPartySize           Int      @default(12) @map("max_party_size")
  minLeadTimeMinutes     Int      @default(30) @map("min_lead_time_minutes")
  requireManualValidation Boolean @default(false) @map("require_manual_validation")

  // Quote token / hold token TTL (en secondes)
  quoteTtlSeconds        Int      @default(300)  @map("quote_ttl_seconds")   // 5 min
  holdTtlSeconds         Int      @default(420)  @map("hold_ttl_seconds")    // 7 min

  noShowPolicy           String   @default("warning") @map("no_show_policy")
  notificationChannels   String[] @default(["sms", "email"]) @map("notification_channels")

  capacitySpecials       Json     @default("{}") @map("capacity_specials")
  // { terrasse: 4, pmr: 2, chien: true, poussette: true }

  updatedAt              DateTime @updatedAt @map("updated_at")
  restaurant             Restaurant @relation(fields: [restaurantId], references: [id])

  @@map("restaurant_exposure_settings")
}

model AgentClient {
  id            String   @id @default(uuid())
  name          String                            // 'openai', 'claude-desktop', 'cursor', 'perplexity'
  type          AgentClientType
  apiKeyHash    String   @unique @map("api_key_hash")
  status        AgentClientStatus @default(ACTIVE)
  rateLimitRpm  Int      @default(60) @map("rate_limit_rpm")
  createdAt     DateTime @default(now()) @map("created_at")
  lastUsedAt    DateTime? @map("last_used_at")

  @@map("agent_clients")
}

enum AgentClientType {
  LLM_PARTNER
  THIRD_PARTY_AGENT
  INTERNAL
}

enum AgentClientStatus {
  ACTIVE
  PAUSED
  REVOKED
}
```

---

## 3. Architecture cible

```
apps/api/src/modules/agentic-reservations/
├── core/                            # TRANSPORT-AGNOSTIQUE
│   ├── availability.service.ts      # check coarse + precise, quote tokens
│   ├── hold.service.ts              # quote → hold atomique
│   ├── reservation.service.ts       # state machine, idempotency
│   ├── state-machine.ts             # transitions autorisées
│   ├── idempotency.service.ts       # Redis idempotency_key → reservation_id
│   ├── audit-log.service.ts         # append-only log
│   ├── policies.service.ts          # resolve policies versionnées
│   └── confidence.service.ts        # data quality par attribut
│
├── mcp/                             # ADAPTER MCP GÉNÉRIQUE
│   ├── server.ts                    # StreamableHTTP MCP server
│   ├── auth.ts                      # agent client auth + rate limit
│   ├── tools/
│   │   ├── search-restaurants.tool.ts
│   │   ├── get-restaurant-details.tool.ts
│   │   ├── check-availability.tool.ts
│   │   ├── create-reservation.tool.ts
│   │   ├── cancel-reservation.tool.ts
│   │   └── get-reservation-status.tool.ts   # interne
│   └── schemas.ts
│
├── openai-reserve/                  # ADAPTER OPENAI APPS SDK
│   ├── business-feed.controller.ts  # /v1/businesses (OpenAI matching/ranking)
│   ├── restaurant-reservation.tool.ts       # tool OpenAI conforme spec
│   ├── widget-resource.ts           # ui://widget/restaurant-reservation.html
│   ├── schemas.ts
│   └── auth.ts                      # OpenAI Apps SDK auth flow
│
├── admin/                           # RESTAURATEUR — opt-in & settings
│   ├── opt-in.controller.ts         # POST /api/agentic/opt-in
│   ├── exposure-settings.controller.ts
│   └── schemas.ts
│
└── __tests__/                       # tests d'intégration
```

**Règle** : aucun adapter (mcp/ ou openai-reserve/) n'appelle directement la DB.
Tout passe par `core/`. Le core ne sait pas ce qu'est MCP ou OpenAI.

---

## 4. Opt-in & exposure settings

### 4.1 Default conservateur

- `mcp_enabled: false` (opt-in obligatoire)
- `openai_reserve_enabled: false` (opt-in obligatoire)
- `agenticOptIn: false` (opt-in obligatoire)

**Justification** : permettre à un agent tiers de réserver au nom d'un
restaurateur sans son accord explicite est juridiquement et
commercialement risqué. On vend le opt-in comme du **contrôle**, pas une
contrainte.

### 4.2 Paramètres configurables par resto

| Paramètre                   | Type     | Défaut       | Description                     |
| --------------------------- | -------- | ------------ | ------------------------------- |
| `mcp_enabled`               | bool     | false        | Exposé via MCP générique        |
| `openai_reserve_enabled`    | bool     | false        | Exposé via OpenAI Reserve       |
| `exposed_creneaux`          | json[]   | tous         | Liste créneaux exposés          |
| `max_party_size`            | int      | 12           | Plafond taille groupe           |
| `min_lead_time_minutes`     | int      | 30           | Anti last-minute abuse          |
| `require_manual_validation` | bool     | false        | Résa validée par humain         |
| `quote_ttl_seconds`         | int      | 300          | 5 min, configurable             |
| `hold_ttl_seconds`          | int      | 420          | 7 min, configurable             |
| `no_show_policy`            | enum     | warning      | warning / fee_15 / fee_30       |
| `notification_channels`     | string[] | [sms, email] | Canaux notification             |
| `capacity_specials`         | json     | {}           | terrasse, pmr, chien, poussette |

### 4.3 Gating rules (anti-abus)

Une réservation MCP/OpenAI est rejetée si :

- Resto a `mcp_enabled: false` → 404 (comme si le resto n'existait pas)
- Slot dans moins de `min_lead_time_minutes` → 422
- `party_size > max_party_size` → 422
- Slot hors `exposed_creneaux` → 422
- Channel non autorisé (ex: MCP alors que seul OpenAI activé) → 403

---

## 5. Core reservation engine

### 5.1 Quote vs Hold (DEUX niveaux de token)

#### Quote token

- **Usage** : "ce slot est proposé à l'instant T" — affichage, ranking, suggestion
- **TTL** : `quote_ttl_seconds` (défaut 5 min, configurable)
- **Garantie** : aucune réservation, mais probabilité haute de dispo
- **Stockage** : Redis avec TTL auto
- **Flow** : `check_availability` retourne des slots[], chacun avec `quote_token`

#### Hold token

- **Usage** : verrou atomique sur capacité, durée courte
- **TTL** : `hold_ttl_seconds` (défaut 7 min, configurable)
- **Garantie** : bloque réellement le slot (DB transaction + capacity lock)
- **Stockage** : table `agentic_holds` + Redis
- **Flow** : `create_hold(quote_token)` → `create_reservation(hold_token, ...)`

#### Pourquoi deux

Quote seul = tu crois verrouiller, en fait non. Hold seul = trop coûteux
pour chaque suggestion de slot dans un search. Quote pour la découverte,
hold pour la transaction.

### 5.2 State machine

```
PENDING ──manual_validation──> PENDING  (stays PENDING until validated)
   │                                  │
   │ auto                            │ approved
   ▼                                  ▼
CONFIRMED ────────► SEATED ────────► HONORED
   │                  │
   │                  └──────────► NO_SHOW
   ▼
CANCELLED

(n'importe quel état, sauf HONORED) ──TTL───► EXPIRED
(n'importe quel état) ──erreur─► FAILED
```

**Transitions autorisées** (toute autre = throw) :

- `PENDING → CONFIRMED | CANCELLED | EXPIRED | FAILED`
- `CONFIRMED → SEATED | CANCELLED | NO_SHOW | EXPIRED`
- `SEATED → HONORED | NO_SHOW`
- `HONORED` : terminal
- `CANCELLED`, `NO_SHOW`, `EXPIRED`, `FAILED` : terminaux

**Toute transition** = entrée dans `reservation_audit_log` (immutable).

### 5.3 Idempotency

- Client fournit `idempotency_key: UUID` sur `create_reservation`
- Backend garde `idempotency_key → reservation_id` en Redis (24h)
- Même key + même payload → retourne la résa existante
- Même key + payload différent → 409 conflict
- Index unique `Reservation.idempotencyKey` côté DB (safety net)

### 5.4 Concurrence / capacity lock

- `create_hold` ouvre une transaction Prisma
- Verrou optimiste ou pessimiste sur la capacité du resto pour ce slot
- Contrainte unique `(restaurant_id, slot_start, party_size, status=CONFIRMED)` ?
  → Pas viable (la capa n'est pas une résa unique)
- Approche pragmatique : table `agentic_holds` avec contrainte unique
  `(restaurant_id, slot_start, type=HOLD, consumed_at IS NULL)` partielle
  → bloque un seul hold actif par slot

### 5.5 Data confidence

Chaque attribut de découverte porte une source + confidence :

```ts
type AttributeConfidence = {
  source: 'merchant_declared' | 'review_inferred' | 'manual' | 'ocr_menu' | 'unknown';
  confidence: number; // 0-1
  verifiedAt?: string;
};
```

Stocké en JSON dans `Restaurant.attributeConfidence` :

```json
{
  "ambiance": { "source": "merchant_declared", "confidence": 0.9, "verifiedAt": "2026-05-01" },
  "noiseLevel": { "source": "review_inferred", "confidence": 0.62 },
  "cuisineType": { "source": "merchant_declared", "confidence": 0.95 }
}
```

Règle : `search_restaurants` retourne `confidence_score` par resto, calculé
comme la moyenne pondérée des attributs matchés. Les attributs à faible
confidence sont flaggués "à confirmer auprès du resto".

### 5.6 Policies versionnées

À la création d'une résa, on snapshot :

```json
{
  "cancellation": {
    "freeUntilHours": 24,
    "feeAfter": 15.0
  },
  "noShow": {
    "type": "warning",
    "feeAmount": 0
  },
  "policyVersion": "2026-06-20"
}
```

Stoké dans `Reservation.cancellationPolicySnap` / `noShowPolicySnap`. Si
le resto change ses policies, seules les nouvelles résas sont impactées.

---

## 6. Outils MCP (5 publics + 1 interne)

### 6.1 `search_restaurants`

**Input** :

```ts
{
  city?: string,
  lat?: number, lng?: number, radius_km?: number,
  date: string,                          // ISO date
  time_window: { from: string, to: string },
  party_size: number,
  budget_per_person?: number,
  cuisine?: string[],
  ambiance?: string[],
  noise_level?: 'CALME' | 'MODERE' | 'ANIME',
  dietary?: string[],
  locale?: string,                       // 'fr-FR' par défaut
  max_results?: number                   // défaut 10
}
```

**Output** :

- Seulement restos où `agenticOptIn = true` ET `exposureSettings.mcp_enabled = true`
- `confidence_score` (0-1) basé sur data quality + coarse availability
- Tri : coarse availability > confidence > note
- ⚠️ Pas de "dispo réelle garantie" — juste "dispo candidate"

### 6.2 `get_restaurant_details`

**Input** : `restaurant_id`

**Output** : adresse structurée, lat/lng, téléphone E.164, timezone,
horaires, menu, photos, **policies complètes** (cancellation, no-show,
accessibilité, capacity_specials), `attributeConfidence` par champ.

### 6.3 `check_availability`

**Input** : `restaurant_id, date, time_window, party_size`

**Output** :

```ts
{
  slots: [
    {
      time: '20:30',
      quote_token: 'qt_xxx', // opaque, single-use, 5 min
      expires_at: '2026-06-20T20:35:00Z',
      capacity_remaining_estimate: 3,
      price_policy: { currency: 'EUR', avgPerPerson: 35 },
      cancellation_policy: { freeUntilHours: 24, feeAfter: 15 },
      confidence: 0.85,
    },
  ];
}
```

### 6.4 `create_reservation`

**Input** :

```ts
{
  hold_token: string,                // OBLIGATOIRE (issu d'un hold)
  customer: { name: string, phone: string, email?: string },
  idempotency_key: string,           // OBLIGATOIRE
  special_requests?: string,
  consents: {
    reservation_processing: true,    // OBLIGATOIRE
    transactional_sms: boolean,
    transactional_email?: boolean,
    marketing_opt_in?: boolean,
    privacy_policy_version: string   // ex: "2026-06-20"
  }
}
```

**Output** : `reservation_id, state, audit_url`

### 6.5 `cancel_reservation`

**Input** :

```ts
{
  reservation_id: string,
  customer_phone: string,
  verification_code: string,         // code OTP envoyé au téléphone
  reason?: string
}
```

**Output** : `state: 'CANCELLED', refund_policy`

### 6.6 `get_reservation_status` (interne)

**Input** : `reservation_id` (ou `idempotency_key` + `customer_phone`)

**Output** : state actuel + transitions (audit log filtré). Réservé
debug/support/admin.

---

## 7. Adapter OpenAI Apps SDK — Reserve flow

### 7.1 Périmètre (vs MCP générique)

- ❌ PAS de tools `search_restaurants` / `check_availability` exposés à OpenAI
- ✅ Business feed `/v1/businesses` (matching/ranking fait par OpenAI)
- ✅ Widget `ui://widget/restaurant-reservation.html` (bas de funnel)
- ✅ Tool `restaurant_reservation` (conformité spec OpenAI)
- ✅ Tool `refresh_availability` (optionnel, recommandé par OpenAI)
- ✅ Tool `make_reservation` (optionnel, recommandé par OpenAI)
- ✅ Tool `reservation_confirmation` (optionnel, recommandé par OpenAI)

### 7.2 Flow

```
User ChatGPT : "resto romantique Annecy ce soir 20h"
  → ChatGPT match via /v1/businesses (notre feed)
  → User clique un resto
  → ChatGPT ouvre widget (notre UI embedded)
  → Widget appelle /api/agentic/check-availability
  → User choisit un slot
  → Widget appelle /api/agentic/create-hold
  → User entre infos + consent
  → Widget appelle /api/agentic/create-reservation(hold_token, ...)
  → Confirmation + audit
```

### 7.3 Business feed `/v1/businesses`

Format aligné spec OpenAI :

- Filtre : `agenticOptIn = true AND openaiReserveEnabled = true`
- Rate limit spécifique
- Données : nom, adresse, lat/lng, cuisine, priceRange, ambiance (avec confidence),
  horaires, capacité, contact, photos
- Refresh incrémental (champ `updatedAt`)

### 7.4 Widget

`ui://widget/restaurant-reservation.html` — ressource MCP exposée
conforme spec OpenAI. Le widget :

- Affiche les slots disponibles (via `check_availability`)
- Collecte nom, téléphone, email
- Collecte consentements RGPD
- Appelle `create_hold` puis `create_reservation`
- Affiche confirmation

### 7.5 Pourquoi ne pas juste exposer les tools MCP

La spec OpenAI actuelle décrit un contrat widget + tool qui n'est pas
strictement MCP générique. Si on s'aligne, on a une chance d'être
approuvé en tant que partenaire. Si on ne s'aligne pas, on reste un
serveur MCP quelconque que OpenAI peut ignorer.

---

## 8. Sécurité

### 8.1 Auth — trois niveaux distincts

| Contexte           | Authentification                            | Qui                      |
| ------------------ | ------------------------------------------- | ------------------------ |
| Restaurant admin   | Clerk (déjà en place)                       | Le restaurateur          |
| Agent client (MCP) | API key hashé en DB, header `X-Sokar-Key`   | OpenAI, Claude, agents   |
| OpenAI Apps SDK    | Flow d'auth Apps SDK                        | OpenAI                   |
| Public search      | Aucun (limité) ou clé publique rate-limited | Pas de données sensibles |

**Pas d'API key par restaurant pour le MCP public** : le client est l'agent
(ChatGPT), pas le resto. Le resto gère son opt-in via le dashboard
(Clerk auth).

### 8.2 StreamableHTTP MCP hardening (spec MCP)

- ✅ Validation `Origin` header (allowlist)
- ✅ Allowlist clients (par `AgentClient.name`)
- ✅ Session ID opaque, expiré
- ✅ Auth correcte sur POST endpoints
- ✅ DNS rebinding protection
- ✅ Pas de secrets dans tool responses (redaction)

### 8.3 Rate limits

- **Par agent client** (API key) : 600 req/min
- **Par IP** : 60 req/min
- **Par restaurant** (writes) : 30 req/min
- **Détection patterns** :
  - Spam booking (création annulation en boucle)
  - Cancellation bombing
  - Scraping de menus/photos
  - Tentatives d'injection dans `special_requests` (XSS dans rendu widget)
- **Action** : pause automatique + alerte Sentry + email admin

### 8.4 Idempotency obligatoire

Toute opération write (`create_reservation`, `cancel_reservation`)
exige `idempotency_key`. Sans clé → 400.

### 8.5 Audit log immuable

- Table `reservation_audit_log`, append-only (pas d'UPDATE/DELETE autorisé
  côté app, seulement via migration)
- Chaque transition de state, chaque hold, chaque action agent logué
- Format : `actor, event, fromState, toState, metadata, timestamp`

### 8.6 Prompt injection defense

- `special_requests` : longueur max (500 chars), sanitization HTML/JS
- Menus/avis : source de confiance flaggée, jamais exécutée comme instruction
- Description resto (merchant-declared) : trusted, mais on log tout ce qui
  est passé au LLM

### 8.7 Pas de secrets dans tool responses

- API keys, tokens internes, hashes : JAMAIS dans une réponse tool
- Redaction automatique côté serveur avant envoi LLM

---

## 9. RGPD — section concrète

### 9.1 Consents structurés

```ts
type Consents = {
  reservation_processing: true; // OBLIGATOIRE (base légale : exécution contrat)
  transactional_sms?: boolean; // opt-in (base légale : consentement)
  transactional_email?: boolean; // opt-in
  marketing_opt_in?: boolean; // opt-in, séparé
  privacy_policy_version: string; // ex: "2026-06-20"
  consented_at: string; // ISO timestamp
  consent_ip_hash?: string; // hash IP, pas l'IP brute
};
```

### 9.2 Conservation

- Données résa : conservées tant que la résa est active + 2 ans (obligation comptable)
- Après 2 ans : anonymisation (suppression nom, phone, email, special_requests)
- Logs/audit : 1 an, puis archivage froid
- Pas de profilage marketing sans consentement marketing_opt_in

### 9.3 Sous-traitants (DPA à valider)

- SMS transactionnel : Twilio / Telnyx (déjà DPA Sokar)
- Email transactionnel : Brevo / Postmark (DPA à signer)
- Stockage DB : hébergeur Sokar (PostgreSQL, conforme)
- Cache : Redis (idem)

### 9.4 Right to erasure

Endpoint `POST /api/agentic/delete-my-data` :

- Input : téléphone ou email + vérif OTP
- Action : anonymisation des résas + suppression des customer notes
- Réponse : confirmation + délai (J+30 max)

### 9.5 Privacy by default

- Recherche publique : pas de PII retournée (pas de nom de client dans
  les tool responses de `search_restaurants`)
- Données client dans `get_reservation_status` : seulement pour le
  propriétaire de la résa (vérif par téléphone/OTP) ou un admin

---

## 10. Modèle économique (pilote)

### 10.1 Phase 1 — Pilote fondateur (8-12 semaines)

**0€ de commission.**

Positionné comme : "Pilote fondateur sans commission, en échange de
feedback, données d'usage, et droit d'utiliser les résultats agrégés."

Pas "gratuit" — on évite d'attirer les restos opportunistes.

### 10.2 Phase 2 — Choix par restaurateur

- **Option A** : 0,50€ à 1,00€ par couvert **honoré** via MCP/OpenAI
- **Option B** : Abonnement "Agent-ready" 19-49€/mois
- **Tracking** : booking créé → confirmé → honoré
- **Règle d'or** : seul "honoré" facture. Zéro friction sur no-show.

### 10.3 Critères go/no-go du pilote (sem 8)

Le pilote passe en Phase 2 si :

- ≥ 10 restos opt-in actifs
- ≥ 100 réservations créées
- ≥ 50% taux réservation honorée
- ≤ 15% taux no-show
- ≤ 5 incidents critiques (double booking, PII leak, etc.)
- Latence p95 check_availability < 800ms

Sinon, on reboucle sur les problèmes avant d'ouvrir.

---

## 11. Plan d'exécution 8 semaines

### Sem 1-2 : Data readiness + spec core

- [ ] Migration Prisma (champs Restaurant + Reservation + nouveaux modèles)
- [ ] Génération client Prisma + test build
- [ ] `core/policies.service.ts` (resolve + snapshot)
- [ ] `core/state-machine.ts` (transitions autorisées)
- [ ] `core/idempotency.service.ts` (Redis)
- [ ] Tests unitaires state machine + policies
- [ ] Décision : OpenAI approval en parallèle ou après pilote ?
- [ ] Ville pilote : Lyon confirmé

### Sem 3-4 : Moteur transactionnel

- [ ] `core/availability.service.ts` (coarse search + precise check)
- [ ] `core/hold.service.ts` (quote → hold, capacity lock)
- [ ] `core/reservation.service.ts` (state transitions + audit)
- [ ] `core/audit-log.service.ts` (append-only)
- [ ] `core/confidence.service.ts` (data quality par attribut)
- [ ] Tests d'intégration : 100 req simultanées sur même slot
- [ ] Tests concurrence : race conditions, double-booking
- [ ] Red-team prompts : injection, abuse, edge cases

### Sem 5 : Adapter MCP générique

- [ ] `mcp/server.ts` (StreamableHTTP)
- [ ] `mcp/auth.ts` (agent client + rate limit)
- [ ] 5 tools + 1 interne
- [ ] Tests avec Claude Desktop + Cursor
- [ ] Tests de sécurité : Origin validation, abuse detection
- [ ] Documentation OpenAPI pour les tools

### Sem 6 : Adapter OpenAI Reserve

- [ ] `openai-reserve/business-feed.controller.ts`
- [ ] `openai-reserve/widget-resource.ts` (HTML conforme spec)
- [ ] `openai-reserve/restaurant-reservation.tool.ts`
- [ ] `openai-reserve/auth.ts` (Apps SDK auth flow)
- [ ] Dossier partenaire OpenAI (review longue, on accepte)

### Sem 7 : Admin & opt-in

- [ ] `admin/opt-in.controller.ts` (dashboard flow)
- [ ] `admin/exposure-settings.controller.ts`
- [ ] UI dashboard : toggle MCP, toggle OpenAI Reserve, settings
- [ ] Tests bout-en-bout

### Sem 8 : Pilote fermé

- [ ] Onboarding 10-20 restos, 1 zone Lyon
- [ ] KPIs temps réel
- [ ] Daily standup 15 min avec les restos
- [ ] Documentation runbook opérationnel

---

## 12. Métriques de succès (12 sem)

| KPI                            | Cible                |
| ------------------------------ | -------------------- |
| Restos opt-in actifs           | 50+                  |
| Recherches/sem                 | 1000+                |
| Taux search → reservation      | > 8%                 |
| Taux reservation honorée       | > 50%                |
| Taux no-show                   | < 15%                |
| Latence p95 check_availability | < 800ms              |
| OpenAI approval                | obtenue ou en review |
| Incidents PII leak             | 0                    |
| Doubles bookings               | 0                    |

---

## 13. Risques & mitigations

| Risque                      | Impact   | Mitigation                            |
| --------------------------- | -------- | ------------------------------------- |
| OpenAI approval très lente  | Élevé    | MCP générique shippable sans OpenAI   |
| Spec OpenAI change          | Moyen    | Core indépendant, adapter jetable     |
| Doubles bookings            | Critique | Hold atomique + capacity lock + audit |
| PII leak via tool responses | Critique | Redaction + audit + rate limit        |
| Restos réticents opt-in     | Moyen    | Pilote 0€, démo live dans locaux      |
| Latence LLM                 | Moyen    | Cache check_availability 30s Redis    |
| Abuse / scraping            | Moyen    | Rate limit + pattern detection        |
| RGPD non-conforme           | Élevé    | Consents structurés, right to erasure |
| State machine bypass        | Élevé    | Tests transitions + service unique    |

---

## 14. Liens & références

- OpenAI Apps SDK MCP : https://developers.openai.com/apps-sdk/concepts/mcp-server
- OpenAI Reserve spec : https://developers.openai.com/apps-sdk/guides/restaurant-reservation-conversion-spec
- MCP transports spec : https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- OpenTable ChatGPT : https://www.opentable.com/blog/chatgpt/
- Zenchef AI : https://www.zenchef.com/solution/ai-solutions-for-restaurants

---

## 15. Décisions en attente (Hamza)

1. **GO migration Prisma S1** : on ajoute tous les champs manquants en une
   seule migration additive, ou on fait minimal d'abord (P0 seulement) ?

2. **OpenAI Reserve en parallèle ou après** : la review OpenAI peut prendre
   3-6 mois. Mon avis : on lance le pilote MCP générique sans attendre
   l'approbation OpenAI. L'adapter OpenAI est un bonus, pas un blocage.

3. **10 ou 20 restos pilote** : 10 pour aller vite, 20 pour avoir des
   données significatives. Mon avis : 15, en mixant profils (bistrot /
   gastro / brunch) pour valider plusieurs attributs.

4. **Lyon confirmé** comme ville pilote ?

5. **Quote TTL 5 min / Hold TTL 7 min** : OK comme défauts, ou tu veux
   d'autres valeurs ?

6. **Data confidence source-of-truth** : `merchant_declared` reste
   toujours confiance haute (0.9) ? `review_inferred` plafonné à 0.7 ?
   Mon avis : oui, sinon le LLM va promettre n'importe quoi.

Une fois ces 6 points tranchés, je passe en S1.
