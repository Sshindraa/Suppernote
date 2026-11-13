# Suppernote Agentic Reservations Layer — Spec v3 (prod-safe)

> **Positionnement**: infrastructure qui rend les restaurants indépendants
> réservables par ChatGPT, Claude et les futurs agents, avec disponibilité
> réelle, politiques maîtrisées, et zéro lock-in marketplace.
>
> **Statut**: plan d'implémentation v3 (post-revue critique prod-safe).
> **Pas de code avant validation explicite de Hamza.**
>
> **Changement majeur v3**: Postgres = source de vérité; Redis = cache/TTL
> uniquement; RGPD + audit conçus ensemble dès Phase 0; OpenAI Reserve =
> risque externe tracké dès le jour 1.

---

## 0. Fondements architecturaux (validés par l'état réel du repo)

### 0.1 Stack actuelle Suppernote

| Service                                | Fichier                                  | État                    |
| -------------------------------------- | ---------------------------------------- | ----------------------- |
| PostgreSQL + Prisma 6                  | `packages/database/prisma/schema.prisma` | OK                      |
| Redis (3 DBs: session / cache / queue) | `apps/api/src/shared/redis/client.ts`    | OK                      |
| BullMQ                                 | `apps/api/src/shared/queue/queues.ts`    | OK, 8 queues existantes |
| Pino logger (PII redaction)            | `apps/api/src/shared/logger/pino.ts`     | OK                      |
| Sentry                                 | présent côté API/dashboard               | OK                      |

### 0.2 Règles immuables du système agentic

1. **Postgres est la source de vérité** pour tout ce qui est transactionnel
   (idempotency, holds, réservations, audit, consentements).
2. **Redis est un accélérateur / TTL / rate-limit** : il peut disparaître,
   être flushé, ou tomber sans jamais créer de double booking.
3. **Toute opération write est idempotente** : `idempotency_key` + contrainte
   unique Postgres + payload hash.
4. **Toute transition de réservation est auditée** dans une table
   append-only, **sans PII brute** (IDs, hashes, snapshots minimisés).
5. **RGPD est un pilier du schéma**, pas une phase ultérieure : consentements,
   droit à l'effacement, durées de conservation, sous-traitants DPA.
6. **OpenAI Reserve est un risque externe** : spec beta, partenaires approuvés.
   On prépare l'adapter mais on ne dépend pas de l'approbation OpenAI.

---

## 1. Architecture en 3 couches (inchangée de v2)

```
┌──────────────────────────────────────────────────────────────┐
│  Adapters (transport / spec externe)                         │
│  ┌─────────────────────┐  ┌─────────────────────────────┐    │
│  │ MCP générique       │  │ OpenAI Apps SDK Reserve     │    │
│  │ (Claude, Cursor)    │  │ (widget + business feed)    │    │
│  └──────────┬──────────┘  └──────────┬──────────────────┘    │
│             │                                  │                        │
│             └────────────┬───────────┘                        │
│                            ▼                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Core reservation engine (transport-agnostique)       │    │
│  │  – Postgres = source de vérité                      │    │
│  │  – Redis = cache/TTL/rate-limit                     │    │
│  │  – hold atomique, idempotence, state machine, audit  │    │
│  └──────────────────────────────────────────────────────┘    │
│                            ▲                                    │
│                            │                                    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Restaurant admin / opt-in / exposure settings        │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Modèles de données — Postgres comme source de vérité

### 2.1 Extension `Restaurant` (P0)

```prisma
model Restaurant {
  // ...champs existants préservés...

  // Identité externe / OpenAI Reserve
  slug                  String?  @unique @map("slug")
  canonicalUrl          String?  @map("canonical_url")
  websiteUrl            String?  @map("website_url")
  platformUrl           String?  @map("platform_url")

  // Géo / contact structurés
  lat                   Decimal? @db.Decimal(9, 6) @map("lat")
  lng                   Decimal? @db.Decimal(9, 6) @map("lng")
  formattedAddress      String?  @map("formatted_address")
  timezone              String   @default("Europe/Paris") @map("timezone")
  phoneE164             String?  @map("phone_e164")

  // Attributs de découverte (P1 sauf cuisineType P0 si feed OpenAI)
  cuisineType           String[] @default([]) @map("cuisine_type")
  priceRange            Int?     @map("price_range")
  ambiance              String[] @default([])
  noiseLevel            NoiseLevel? @map("noise_level")
  dietary               String[] @default([])
  attributeConfidence   Json     @default("{}") @map("attribute_confidence")

  // Opt-in agentic
  agenticOptIn          Boolean  @default(false) @map("agentic_opt_in")
  openaiReserveEnabled  Boolean  @default(false) @map("openai_reserve_enabled")
  policyVersion         String   @default("2026-06-20") @map("policy_version")

  exposureSettings      RestaurantExposureSettings?
}
```

### 2.2 Extension `Reservation` (P0)

```prisma
model Reservation {
  // ...champs existants préservés...

  channel                 ReservationChannel  @default(PHONE) @map("channel")
  state                   ReservationState    @default(CONFIRMED) @map("state")

  startsAt                DateTime?           @map("starts_at")
  endsAt                  DateTime?           @map("ends_at")

  specialRequests         String?             @map("special_requests")
  createdByClient         String?             @map("created_by_client")

  cancellationPolicySnap  Json?               @map("cancellation_policy_snap")
  noShowPolicySnap        Json?               @map("no_show_policy_snap")

  // RGPD
  consents                Json                @default("{}") @map("consents")
  privacyPolicyVersion    String              @default("2026-06-20") @map("privacy_policy_version")

  // Idempotence (source de vérité Postgres)
  idempotencyKey          String?             @unique @map("idempotency_key")
  idempotencyPayloadHash  String?             @map("idempotency_payload_hash")

  // Hold utilisé pour cette résa
  consumedHoldId          String?             @unique @map("consumed_hold_id")

  auditLog                ReservationAuditLog[]
}
```

### 2.3 `AgenticHold` (P0) — source de vérité du lock

```prisma
model AgenticHold {
  id              String     @id @default(uuid())
  restaurantId    String     @map("restaurant_id")

  type            HoldType   // QUOTE ou HOLD
  partySize       Int        @map("party_size")
  slotStart       DateTime   @map("slot_start")
  slotEnd         DateTime   @map("slot_end")

  channel         ReservationChannel

  // Tokens. L'agent ne voit que le token, jamais l'id interne.
  quoteToken      String?    @unique @map("quote_token")
  holdToken       String?    @unique @map("hold_token")

  // TTL logique géré par Postgres (worker expire les lignes)
  expiresAt       DateTime   @map("expires_at")
  consumedAt      DateTime?  @map("consumed_at")
  status          HoldStatus @default(ACTIVE) @map("status")

  policyVersion   String     @map("policy_version")

  reservationId   String?    @map("reservation_id")

  createdAt       DateTime   @default(now()) @map("created_at")
  restaurant      Restaurant @relation(fields: [restaurantId], references: [id])

  // Contrainte clé : un seul hold actif par slot, restaurant, party_size.
  // Postgres supporte les partial unique indexes.
  @@unique([restaurantId, slotStart, partySize, status], name: "one_active_hold_per_slot")
  @@index([restaurantId, slotStart])
  @@index([expiresAt])
  @@map("agentic_holds")
}

enum HoldStatus {
  ACTIVE
  CONSUMED
  EXPIRED
  RELEASED
}
```

### 2.4 `ReservationAuditLog` (P0) — sans PII brute

```prisma
model ReservationAuditLog {
  id            String   @id @default(uuid())

  // Liens internes (pas de PII)
  reservationId String?  @map("reservation_id")
  holdId        String?  @map("hold_id")

  actor         String   // ex: 'agent:openai', 'agent:mcp:cursor', 'system', 'resto:42'
  actorHash     String?  @map("actor_hash") // hash anonymisé si nécessaire

  event         String   // 'hold_created', 'hold_consumed', 'state_transition', 'consent_recorded'

  fromState     String?  @map("from_state")
  toState       String?  @map("to_state")

  // Snapshot minimal (pas de nom/email/téléphone client)
  metadata      Json     @default("{}")

  createdAt     DateTime @default(now()) @map("created_at")

  reservation   Reservation? @relation(fields: [reservationId], references: [id])

  @@index([reservationId, createdAt])
  @@index([createdAt])
  @@map("reservation_audit_log")
}
```

### 2.5 `IdempotencyRecord` (P0) — source de vérité Postgres

```prisma
model IdempotencyRecord {
  key            String   @id @map("key")
  payloadHash    String   @map("payload_hash")
  reservationId  String?  @map("reservation_id")
  status         String   // 'pending', 'completed', 'failed'
  responseHash   String?  @map("response_hash")
  createdAt      DateTime @default(now()) @map("created_at")
  expiresAt      DateTime @map("expires_at") // cleanup job après 24h

  @@index([expiresAt])
  @@map("idempotency_records")
}
```

### 2.6 `CustomerConsent` (P0) — RGPD historisé

```prisma
model CustomerConsent {
  id            String   @id @default(uuid())
  restaurantId  String   @map("restaurant_id")
  channel       ReservationChannel
  context       String   // ex: 'mcp_create_reservation', 'openai_widget'

  reservationProcessing Boolean @map("reservation_processing")
  transactionalSms      Boolean @map("transactional_sms")
  transactionalEmail    Boolean @map("transactional_email")
  marketingOptIn        Boolean @map("marketing_opt_in")

  privacyPolicyVersion  String  @map("privacy_policy_version")
  consentedAt           DateTime @map("consented_at")
  consentIpHash         String? @map("consent_ip_hash")

  createdAt             DateTime @default(now()) @map("created_at")

  @@index([restaurantId, createdAt])
  @@map("customer_consents")
}
```

### 2.7 `RestaurantExposureSettings` (P0)

Identique à v2 (voir spec précédente).

### 2.8 Enums P0

```prisma
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

enum ReservationChannel {
  PHONE
  WEB
  MCP
  OPENAI_RESERVE
  ADMIN
  API
}

enum HoldType {
  QUOTE
  HOLD
}

enum NoiseLevel {
  CALME
  MODERE
  ANIME
}
```

---

## 3. Core reservation engine

### 3.1 Idempotence (Postgres first)

**Flow**:

```
create_reservation(idempotency_key, payload)
  → hash(payload)
  → SELECT * FROM idempotency_records WHERE key = ?
    • Si existe ET payloadHash différent → 409 Conflict
    • Si existe ET payloadHash identique → retourne résa existante (cache de Redis si dispo)
    • Si n'existe pas → INSERT pending
  → exécute create_reservation atomique
  → UPDATE idempotency_records SET status='completed', reservationId=...
  → retourne résa
```

**Redis**:

- `redisCache` stocke `idempotency:{key} → reservation_id` (TTL 24h)
- En cas de cache miss / Redis down, on requête Postgres
- Jamais de décision d'idempotence basée uniquement sur Redis

### 3.2 Quote vs Hold (Postgres first)

#### Quote

- Table `AgenticHold` avec `type = QUOTE`
- `status = ACTIVE`, `expiresAt = now() + quoteTtlSeconds`
- Pas de lock capacité réel, juste une "citation"
- Utilisé par `check_availability`

#### Hold

- Table `AgenticHold` avec `type = HOLD`
- `status = ACTIVE`, `expiresAt = now() + holdTtlSeconds`
- Contrainte partielle Postgres : un seul `HOLD` actif par `(restaurantId, slotStart, partySize)`
- Worker BullMQ `expire-hold` passe `status → EXPIRED` après `expiresAt`
- `check_availability` IGNORE systématiquement les holds expirés, même si le worker est en retard

**Flow**:

```
check_availability() → retourne slots[] + quote_tokens

use_quote(quote_token) → quote_token valide ?
  → crée HOLD atomique (transaction + partial unique index)
  → retourne hold_token
  → invalide quote_token

create_reservation(hold_token, customer, idempotency_key)
  → hold_token valide ?
  → consume_hold (status → CONSUMED, consumedAt)
  → crée Reservation (state = PENDING ou CONFIRMED)
  → audit log
  → notif BullMQ
```

### 3.3 State machine (8 états)

Identique à v2. Toute transition loggée dans `ReservationAuditLog`.

### 3.4 Audit log immuable

- Append-only : trigger SQL interdit UPDATE/DELETE sur
  `reservation_audit_log`
- Correction v3 : **pas de PII brute**. IDs internes, hashes,
  snapshots minimisés. Les données client (nom/tél/email) restent dans
  `Reservation` (droit à l'effacement + anonymisation après 2 ans).
- Purge automatique du log après 1 an, sauf si résa litigeuse (flag
  `retainUntil`).

### 3.5 RGPD intégré au core

- Consentements enregistrés dans `CustomerConsent` à chaque résa
- `Reservation.consents` = snapshot rapide (JSON) pour lectures rapides
- Droit à l'effacement : endpoint `POST /api/agentic/delete-my-data`
  - Supprime PII de `Reservation` (name, phone, email, specialRequests)
  - Conserve métadonnées anonymisées (partySize, slotStart, channel)
  - Ne supprime PAS `ReservationAuditLog` (n'a déjà pas de PII)
- Anonymisation automatique : cron BullMQ après 2 ans

---

## 4. Redis — utilisation strictement limitée

| Usage              | Key pattern                         | TTL         | Fallback                   |
| ------------------ | ----------------------------------- | ----------- | -------------------------- |
| Cache idempotency  | `sokar:idem:{key}`                  | 24h         | Postgres                   |
| Cache quote data   | `sokar:quote:{token}`               | 5 min       | Postgres                   |
| Cache hold data    | `sokar:hold:{token}`                | 7 min       | Postgres                   |
| Cache availability | `sokar:avail:{resto}:{date}:{slot}` | 30s         | Compute DB                 |
| Rate limit         | `sokar:ratelimit:{clientId}`        | 60s sliding | Reject (hard limit)        |
| BullMQ jobs        | natif BullMQ                        | selon job   | Pas de fallback nécessaire |

**Règle absolue** : si Redis disparaît, le système continue de marcher,
même avec dégradation de perfs. Jamais de double booking.

---

## 5. Adapters

### 5.1 MCP générique

5 tools publics + 1 interne (inchangé v2), mais `create_reservation`
prend maintenant un `hold_token` (pas quote_token).

### 5.2 OpenAI Apps SDK Reserve

Adapter conforme à la spec officielle (publiée 14 mai 2026) :

- `ui://widget/restaurant-reservation.html` via `_meta.ui.resourceUri`
- Tool `restaurant_reservation`
- Business feed `/v1/businesses`
- Widget : privilégier le bridge MCP Apps standard, `window.openai`
  seulement pour capacités ChatGPT spécifiques

**Risque externe** : OpenAI beta + partenaires approuvés. Dossier
partenaire à soumettre dès que possible (dès Sem 1, pas Sem 8-9).

---

## 6. Plan général step-by-step (12 semaines)

### Phase 0 — Fondations DB + RGPD + state machine (Sem 1-2)

**Objectif** : schema prod-safe + core logique, sans dépendance externe.

Livrables :

1. Migrations Prisma P0 (additives, 4 fichiers)
2. Modèles `AgenticHold`, `ReservationAuditLog`, `IdempotencyRecord`, `CustomerConsent`, `RestaurantExposureSettings`
3. Extensions Postgres : `pg_trgm`, `cube`, `earthdistance`
4. Trigger SQL : `reservation_audit_log` append-only
5. `core/state-machine.ts` (pure logic)
6. `core/policies.service.ts` (resolve + snapshot)
7. `core/idempotency.service.ts` (Postgres first, Redis cache)
8. Tests Vitest : state machine + idempotence (90%+)

**RGPD en Phase 0** : modèle `CustomerConsent`, champs `Reservation.consents`,
`privacyPolicyVersion`, endpoint effacement spécifié.

**OpenAI Reserve en Phase 0** : création du dossier partenaire et suivi
externe (pas de code, juste application).

Vérification :

- `pnpm typecheck` clean
- `prisma migrate deploy` OK
- `pnpm test` : 100% transitions valides/invalides + idempotence

### Phase 1 — Moteur transactionnel (Sem 3-4)

**Objectif** : quote/hold atomique, audit, workers.

Livrables :

1. `core/hold.service.ts` (Postgres capacity lock)
2. `core/availability.service.ts` (coarse + precise)
3. `core/reservation.service.ts` (state transitions + audit)
4. `core/audit-log.service.ts` (append-only)
5. `core/confidence.service.ts` (data quality)
6. Workers BullMQ : `expire-quote`, `expire-hold`, `agentic-notify`
7. Tests chaos : 1000 req concurrentes sur même slot
8. Tests Redis down : vérifier 0 double booking sans Redis

### Phase 2 — Admin restaurateur (Sem 5)

Livrables :

1. Controllers opt-in + exposure settings
2. UI dashboard toggles/config
3. Tests bout-en-bout

### Phase 3 — Adapter MCP générique (Sem 6-7)

Livrables :

1. `mcp/server.ts` (StreamableHTTP)
2. `mcp/auth.ts` + `mcp/rate-limit.ts`
3. 5 tools + 1 interne
4. `mcp/response-redaction.ts`
5. Tests Claude Desktop / Cursor
6. Red-team : injection, abuse, Origin validation

### Phase 4 — Adapter OpenAI Reserve (Sem 8-9)

Livrables :

1. Business feed `/v1/businesses`
2. Widget Next.js `apps/widget`
3. Tool `restaurant_reservation` conforme spec
4. Tests intégration flow ChatGPT

### Phase 5 — RGPD & droits (Sem 9)

Livrables :

1. `POST /api/agentic/delete-my-data` (OTP vérif)
2. `POST /api/agentic/export-my-data`
3. Cron anonymisation 2 ans
4. DPA sous-traitants validé
5. Tests RGPD complets

### Phase 6 — Observabilité (Sem 10)

Livrables :

1. Métriques Prometheus custom
2. Dashboard Grafana
3. Alertes Sentry

### Phase 7 — Pilote fermé 15 restos à Lyon (Sem 11-12)

Livrables :

1. Onboarding 15 restos mix
2. Formation + support
3. KPIs temps réel
4. Runbook
5. Feedback loop

---

## 7. Timeline visuelle

```
Sem 1-2  ██████░░░░░░░░░░░░  Phase 0  Fondations DB + RGPD + state machine
Sem 3-4  ░░██████░░░░░░░░░░  Phase 1  Moteur transactionnel
Sem 5    ░░░░░███░░░░░░░░░░  Phase 2  Admin restaurateur
Sem 6-7  ░░░░░░░██████░░░░░  Phase 3  Adapter MCP
Sem 8-9  ░░░░░░░░░░██████░░  Phase 4  OpenAI Reserve
Sem 9    ░░░░░░░░░░░░██░░░░  Phase 5  RGPD (overlap)
Sem 10   ░░░░░░░░░░░░░███░░  Phase 6  Observabilité
Sem 11-12░░░░░░░░░░░░░░███  Phase 7  Pilote 15 restos
```

---

## 8. Différences clés v2 → v3

| Sujet              | v2                                        | v3                                                     |
| ------------------ | ----------------------------------------- | ------------------------------------------------------ |
| Source idempotence | Redis principal, contrainte DB safety net | Postgres source de vérité, Redis cache                 |
| Hold atomique      | Redis TTL + DB                            | Postgres partial unique index + transaction            |
| Audit log          | PII brute possible                        | IDs + hashes + snapshots minimisés                     |
| RGPD               | Phase 5                                   | Phase 0 (CustomerConsent, privacy version, effacement) |
| Redis              | Source de vérité temporaire               | Cache/TTL/rate-limit uniquement                        |
| OpenAI Reserve     | Phase 4 (Sem 8-9)                         | Dossier partenaire dès Phase 0, code Sem 8-9           |
| Widget             | Simple HTML mentionné                     | Next.js `apps/widget` conforme MCP Apps                |
| Geo                | earthdistance suggéré                     | lat/lng/address structurés P0 (exigence OpenAI)        |

---

## 9. Décisions en attente (Hamza)

1. **Valider la migration P0 v3** (modèles `IdempotencyRecord`, `CustomerConsent`, champs OpenAI feed P0)
2. **Valider le choix widget Next.js** dans `apps/widget` (vs HTML statique)
3. **Valider le dépôt immédiat du dossier partenaire OpenAI** (même sans code)
4. **Valider Lyon + mix 15 restos** inchangé
5. **Valider quote 5 min / hold 7 min** configurable

**Tu valides v3 et je lance Phase 0.** Sinon, qu'est-ce qui te bloque ?
