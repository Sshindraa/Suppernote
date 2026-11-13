# Suppernote Agentic Reservations Layer — Spec v3.1 (prêt Phase 0)

> **Positionnement**: infrastructure qui rend les restaurants indépendants
> réservables par ChatGPT, Claude et les futurs agents, avec disponibilité
> réelle, politiques maîtrisées, et zéro lock-in marketplace.
>
> **Statut**: spec d'implémentation v3.1 — 6 amendements intégrés.
> **Pas de code avant GO final de Hamza.**
>
> **Changement majeur v3/v3.1**: Postgres = source de vérité; Redis = cache/TTL
> uniquement; RGPD + audit conçus ensemble dès Phase 0; OpenAI Reserve =
> risque externe tracké dès le jour 1.

---

## 0. Fondements architecturaux

### 0.1 Stack actuelle Suppernote (confirmée dans le repo)

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
3. **Toute opération write est idempotente** : `idempotency_key` + scope +
   contrainte unique Postgres + payload hash.
4. **Toute transition de réservation est auditée** dans une table
   append-only, **sans PII brute** (IDs, hashes, snapshots minimisés).
5. **RGPD est un pilier du schéma**, pas une phase ultérieure : consentements,
   droit à l'effacement, durées de conservation, sous-traitants DPA.
6. **OpenAI Reserve est un risque externe** : spec beta, partenaires approuvés.
   On prépare l'adapter mais on ne dépend pas de l'approbation OpenAI.

---

## 1. Architecture en 3 couches

```
┌─────────────────────────────────────────────────────────────────────┐
│  Adapters (transport / spec externe)                                │
│  ┌──────────────────────┐  ┌─────────────────────────────────────┐  │
│  │ MCP générique        │  │ OpenAI Apps SDK Reserve             │  │
│  │ (Claude, Cursor)     │  │ (widget + business feed)            │  │
│  └──────────┬───────────┘  └──────────────┬──────────────────────┘  │
│             │                              │                         │
│             └──────────────┬───────────────┘                         │
│                            ▼                                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Core reservation engine (transport-agnostique)                │ │
│  │  – Postgres = source de vérité                                 │ │
│  │  – Redis = cache/TTL/rate-limit                                │ │
│  │  – hold atomique, idempotence, state machine, audit            │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                            ▲                                        │
│                            │                                        │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Restaurant admin / opt-in / exposure settings                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Modèles de données — Postgres source de vérité

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

  // Attributs de découverte
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

  // Idempotence (Postgres source de vérité)
  idempotencyScope        String              @map("idempotency_scope")
  idempotencyKey          String              @map("idempotency_key")
  idempotencyPayloadHash  String?             @map("idempotency_payload_hash")

  // Hold consommé pour cette résa
  consumedHoldId          String?             @unique @map("consumed_hold_id")

  auditLog                ReservationAuditLog[]

  @@unique([idempotencyScope, idempotencyKey])
  @@map("reservations")
}
```

### 2.3 `AgenticHold` (P0)

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

  @@index([restaurantId, slotStart])
  @@index([expiresAt])
  @@map("agentic_holds")
}
```

> **Note sur la contrainte d'unicité partielle** : Prisma 6 ne supporte pas
> nativement les partial unique indexes. Dans la migration SQL, on ajoute :
>
> ```sql
> CREATE UNIQUE INDEX one_active_hold_per_slot
> ON agentic_holds (restaurant_id, slot_start, party_size)
> WHERE status = 'ACTIVE' AND type = 'HOLD';
> ```
>
> Cela garantit qu'un seul hold actif existe par slot/party_size, sans bloquer
> les quotes ni les lignes expirées/consommées.

### 2.4 Limitation MVP capacité (à documenter explicitement)

La contrainte `one_active_hold_per_slot` est **intentionnellement
ultra-conservatrice** pour le pilote. Elle interdit deux holds actifs sur le
même créneau pour la même taille de groupe, même si le restaurant a plusieurs
tables disponibles.

**Pourquoi acceptable en P0** :

- Pilote = 15 restos, on veut zéro risque de surbooking
- La plupart des petits restaurants indépendants ont 1-2 tables par créneau
- Facile à relâcher plus tard sans casser le modèle

**P1** : introduire `RestaurantCapacity` / `SlotCapacity` pour modéliser le
nombre réel de tables/couverts par créneau.

```prisma
// Modèle P1 (pas en Phase 0)
model RestaurantCapacity {
  id            String   @id @default(uuid())
  restaurantId  String   @map("restaurant_id")
  dayOfWeek     Int      @map("day_of_week")
  startTime     String   @map("start_time")
  endTime       String   @map("end_time")
  maxCovers     Int      @map("max_covers")
  maxTables     Int      @map("max_tables")
  effectiveFrom DateTime @map("effective_from")
  effectiveTo   DateTime? @map("effective_to")

  @@map("restaurant_capacities")
}
```

### 2.5 `ReservationAuditLog` (P0)

```prisma
model ReservationAuditLog {
  id            String   @id @default(uuid())

  reservationId String?  @map("reservation_id")
  holdId        String?  @map("hold_id")

  actor         String   // ex: 'agent:openai', 'agent:mcp:cursor', 'system', 'resto:42'
  actorHash     String?  @map("actor_hash")

  event         String   // 'hold_created', 'hold_consumed', 'state_transition', 'consent_recorded'

  fromState     String?  @map("from_state")
  toState       String?  @map("to_state")

  metadata      Json     @default("{}")

  createdAt     DateTime @default(now()) @map("created_at")

  reservation   Reservation? @relation(fields: [reservationId], references: [id])

  @@index([reservationId, createdAt])
  @@index([createdAt])
  @@map("reservation_audit_log")
}
```

> **Append-only + rétention** : trigger SQL interdit UPDATE/DELETE sur la table.
> La rétention à 1 an s'effectue par **rotation de partitions mensuelles**
> (`reservation_audit_log_YYYYMM`), dropées par un job système via rôle
> maintenance. Pas de DELETE sur des lignes individuelles.

### 2.6 `IdempotencyRecord` (P0)

```prisma
model IdempotencyRecord {
  scope           String   @map("scope")
  key             String   @map("key")
  payloadHash     String   @map("payload_hash")
  reservationId   String?  @map("reservation_id")
  status          String   // 'pending', 'completed', 'failed'
  responseHash    String?  @map("response_hash")
  createdAt       DateTime @default(now()) @map("created_at")
  expiresAt       DateTime @map("expires_at")

  @@id([scope, key])
  @@index([expiresAt])
  @@map("idempotency_records")
}
```

**Scope** : pour `create_reservation`, `scope = "restaurant:{restaurantId}:channel:{channel}"`.
Ainsi deux clients externes ne peuvent pas collisionner sur la même clé.

**Flow**:

```
create_reservation(idempotency_scope, idempotency_key, payload)
  → hash(payload)
  → SELECT * FROM idempotency_records WHERE scope = ? AND key = ?
    • Si existe ET payloadHash différent → 409 Conflict
    • Si existe ET payloadHash identique → retourne résa existante (cache Redis si dispo)
    • Si n'existe pas → INSERT pending
  → exécute create_reservation atomique
  → UPDATE idempotency_records SET status='completed', reservationId=...
  → retourne résa
```

### 2.7 `CustomerConsent` (P0)

```prisma
model CustomerConsent {
  id              String   @id @default(uuid())

  // Référence au sujet
  restaurantId    String   @map("restaurant_id")
  customerId      String?  @map("customer_id")
  reservationId   String?  @map("reservation_id")
  subjectHash     String   @map("subject_hash") // hash(phone + email + restaurantId)

  channel         ReservationChannel
  context         String   // ex: 'mcp_create_reservation', 'openai_widget'

  reservationProcessing Boolean @map("reservation_processing")
  transactionalSms      Boolean @map("transactional_sms")
  transactionalEmail    Boolean @map("transactional_email")
  marketingOptIn        Boolean @map("marketing_opt_in")

  privacyPolicyVersion  String  @map("privacy_policy_version")
  consentedAt           DateTime @map("consented_at")
  consentIpHash         String? @map("consent_ip_hash")

  createdAt             DateTime @default(now()) @map("created_at")

  @@index([restaurantId, subjectHash])
  @@index([reservationId])
  @@index([createdAt])
  @@map("customer_consents")
}
```

### 2.8 `RestaurantExposureSettings` (P0) — modèle complet

```prisma
model RestaurantExposureSettings {
  restaurantId            String   @id @map("restaurant_id")

  mcpEnabled              Boolean  @default(false) @map("mcp_enabled")
  openaiReserveEnabled    Boolean  @default(false) @map("openai_reserve_enabled")

  // Créneaux exposés (défaut = tous)
  // [{ "day": 0, "from": "19:00", "to": "22:30" }, ...]
  exposedCreneaux         Json     @default("[]") @map("exposed_creneaux")

  maxPartySize            Int      @default(12) @map("max_party_size")
  minLeadTimeMinutes      Int      @default(30) @map("min_lead_time_minutes")
  requireManualValidation Boolean  @default(false) @map("require_manual_validation")

  // TTL tokens (en secondes)
  quoteTtlSeconds         Int      @default(300)  @map("quote_ttl_seconds")   // 5 min
  holdTtlSeconds          Int      @default(420)  @map("hold_ttl_seconds")    // 7 min

  noShowPolicy            String   @default("warning") @map("no_show_policy")
  notificationChannels    String[] @default(["sms", "email"]) @map("notification_channels")

  capacitySpecials        Json     @default("{}") @map("capacity_specials")
  // { terrasse: 4, pmr: 2, chien: true, poussette: true }

  updatedAt               DateTime @updatedAt @map("updated_at")
  restaurant              Restaurant @relation(fields: [restaurantId], references: [id])

  @@map("restaurant_exposure_settings")
}
```

### 2.9 Enums P0

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

enum HoldStatus {
  ACTIVE
  CONSUMED
  EXPIRED
  RELEASED
}

enum NoiseLevel {
  CALME
  MODERE
  ANIME
}
```

---

## 3. Core reservation engine

### 3.1 Idempotence (Postgres source de vérité)

- Clé composite `(scope, key)` dans `IdempotencyRecord`
- Scope inclut `restaurantId` + `channel` pour éviter collisions inter-restaurants/inter-clients
- Redis cache = `sokar:idem:{scope}:{key}` (TTL 24h), fallback Postgres
- Jamais de décision d'idempotence uniquement sur Redis

### 3.2 Quote vs Hold (Postgres source de vérité)

- `AgenticHold` stocke quotes et holds
- Contrainte partielle SQL : un seul hold actif par `(restaurantId, slotStart, partySize)`
- Worker BullMQ `expire-hold` passe `status → EXPIRED` après `expiresAt`
- `check_availability` IGNORE les holds expirés, même si worker en retard

### 3.3 State machine (8 états)

```
PENDING ──manual_validation──> PENDING
   │                                  │
   │ auto                             │ approved
   ▼                                  ▼
CONFIRMED ───────────────> SEATED ───────────────> HONORED
   │                       │
   │                       └───────────────────> NO_SHOW
   ▼
CANCELLED

(n'importe quel état, sauf HONORED) ──TTL──> EXPIRED
(n'importe quel état) ──erreur──> FAILED
```

### 3.4 Audit log append-only + rétention par partitions

- Trigger SQL interdit UPDATE/DELETE sur `reservation_audit_log`
- Pas de PII brute : IDs internes, hashes, snapshots minimisés
- Partitions mensuelles `reservation_audit_log_YYYYMM`
- Purge annuelle par drop de partition (rôle maintenance), jamais DELETE

### 3.5 RGPD intégré au core

- `CustomerConsent` enregistre chaque consentement avec référence au sujet
- `Reservation.consents` = snapshot rapide (JSON)
- Droit à l'effacement : anonymise PII de `Reservation`, conserve métadonnées
- `ReservationAuditLog` n'a déjà pas de PII
- Anonymisation automatique après 2 ans via cron BullMQ

---

## 4. Redis — utilisation strictement limitée

| Usage              | Key pattern                         | TTL         | Fallback        |
| ------------------ | ----------------------------------- | ----------- | --------------- |
| Cache idempotency  | `sokar:idem:{scope}:{key}`          | 24h         | Postgres        |
| Cache quote data   | `sokar:quote:{token}`               | 5 min       | Postgres        |
| Cache hold data    | `sokar:hold:{token}`                | 7 min       | Postgres        |
| Cache availability | `sokar:avail:{resto}:{date}:{slot}` | 30s         | Compute DB      |
| Rate limit         | `sokar:ratelimit:{clientId}`        | 60s sliding | Reject          |
| BullMQ jobs        | natif BullMQ                        | selon job   | Pas de fallback |

---

## 5. Adapters

### 5.1 MCP générique

5 tools publics + 1 interne. `create_reservation` prend un `hold_token`.

### 5.2 OpenAI Apps SDK Reserve

- `ui://widget/restaurant-reservation.html` via `_meta.ui.resourceUri`
- Tool `restaurant_reservation`
- Business feed `/v1/businesses`
- Widget Next.js dans `apps/widget`, bridge MCP Apps standard

**Risque externe** : OpenAI beta + partenaires approuvés. Dossier partenaire
à soumettre dès Phase 0.

---

## 6. Plan général step-by-step (12 semaines)

### Phase 0 — Fondations DB + RGPD + state machine (Sem 1-2)

Livrables :

1. Migrations Prisma P0 (additives, 5 fichiers)
2. Modèles : `AgenticHold`, `ReservationAuditLog`, `IdempotencyRecord`, `CustomerConsent`, `RestaurantExposureSettings`
3. Extensions Postgres : `pg_trgm`, `cube`, `earthdistance`
4. Partial unique index SQL sur `agentic_holds`
5. Trigger SQL append-only sur `reservation_audit_log`
6. Partition mensuelle `reservation_audit_log`
7. `core/state-machine.ts`
8. `core/policies.service.ts`
9. `core/idempotency.service.ts` (Postgres first)
10. Tests Vitest : state machine + idempotence
11. Dépôt dossier partenaire OpenAI (tracking externe)

### Phase 1 — Moteur transactionnel (Sem 3-4)

Livrables : `core/hold.service.ts`, `core/availability.service.ts`,
`core/reservation.service.ts`, `core/audit-log.service.ts`,
`core/confidence.service.ts`, workers BullMQ, tests chaos, tests Redis down.

### Phase 2 — Admin restaurateur (Sem 5)

Livrables : controllers opt-in + exposure settings, UI dashboard toggles/config.

### Phase 3 — Adapter MCP générique (Sem 6-7)

Livrables : serveur MCP, auth, rate-limit, 5 tools + 1 interne, redaction,
tests Claude Desktop / Cursor, red-team.

### Phase 4 — Adapter OpenAI Reserve (Sem 8-9)

Livrables : business feed, widget Next.js, tool conforme spec, tests intégration.

### Phase 5 — RGPD & droits (Sem 9)

Livrables : endpoints delete-my-data / export-my-data, cron anonymisation,
DPA sous-traitants validé.

### Phase 6 — Observabilité (Sem 10)

Livrables : métriques Prometheus, dashboard Grafana, alertes Sentry.

### Phase 7 — Pilote fermé 15 restos à Lyon (Sem 11-12)

Livrables : onboarding, formation, KPIs temps réel, runbook, feedback loop.

---

## 7. Migrations P0 — 5 fichiers

1. `20260621000000_agentic_p0_columns` → champs Restaurant + Reservation + enums
2. `20260621001000_agentic_p0_models` → nouveaux modèles
3. `20260621002000_agentic_p0_backfill_slug` → backfill slug + contrainte unique
4. `20260621003000_agentic_p0_extensions` → pg_trgm, cube, earthdistance
5. `20260621004000_agentic_p0_constraints` → partial unique index + audit trigger + partitions

---

## 8. Différences v3 → v3.1

| #   | Amendement        | v3                           | v3.1                                                                   |
| --- | ----------------- | ---------------------------- | ---------------------------------------------------------------------- |
| 1   | Contrainte hold   | `@@unique` Prisma incorrect  | Partial unique index SQL `WHERE status='ACTIVE' AND type='HOLD'`       |
| 2   | Capacité          | Non modélisée, mention floue | Modèle `RestaurantCapacity` P1 documenté, simplification MVP explicite |
| 3   | Idempotency       | Clé globale `key`            | Clé composite `(scope, key)` avec scope = restaurant + channel         |
| 4   | Consent           | Pas de référence sujet       | `customerId`, `reservationId`, `subjectHash`                           |
| 5   | Audit purge       | Contradiction trigger/purge  | Rétention par partitions mensuelles, drop partition rôle maintenance   |
| 6   | Exposure settings | "identique à v2"             | Modèle complet intégré dans v3.1                                       |

---

## 9. Décisions en attente (Hamza)

Toutes les décisions produit restent validées :

- Lyon + mix 15 restos ✓
- Quote 5 min / Hold 7 min configurables ✓
- Widget Next.js `apps/widget` ✓
- Dossier partenaire OpenAI dès Phase 0 ✓
- Migration P0 additive ✓

**Question unique avant implémentation** : valides-tu les 6 amendements
intégrés en v3.1 ? Si oui, je crée les 5 migrations et je commence Phase 0.
