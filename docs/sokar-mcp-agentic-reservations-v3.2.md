# Suppernote Agentic Reservations Layer — Spec v3.2

> **Statut : LIVRÉ / DOCUMENT DE RÉFÉRENCE — vérifié le 12 septembre 2026.**
> Le serveur MCP Streamable HTTP, OAuth, les outils de disponibilité/hold/confirmation/annulation,
> l'idempotence, la gestion capacitaire et OpenAI Reserve sont implémentés. Des parcours E2E réels
> ont été exécutés avec ChatGPT et Claude. Les mentions « GO », « avant code » ou « P0 à lancer »
> ci-dessous appartiennent au plan d'origine et ne décrivent plus l'état du produit. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

> **Positionnement**: infrastructure qui rend les restaurants indépendants
> réservables par ChatGPT, Claude et les futurs agents, avec disponibilité
> réelle, politiques maîtrisées, et zéro lock-in marketplace.
>
> **Statut d'origine** : spec d'implémentation v3.2 — 3 micro-corrections intégrées.
> La contrainte « pas de code SQL avant GO » est conservée comme trace de la phase de conception.

---

## 0. Décisions validées

- Stack: Postgres + Redis + BullMQ + Fastify + Prisma + MCP SDK
- Architecture 3 couches: core / mcp-adapter / openai-reserve-adapter
- Postgres = source de vérité; Redis = cache/TTL/rate-limit
- RGPD intégré dès Phase 0
- OpenAI Reserve = risque externe tracké dès Phase 0
- Pilote: 15 restos à Lyon, mix bistrot/gastro/brunch/touristique/petite capacité
- Quote 5 min / Hold 7 min, configurables
- Widget Next.js dans `apps/widget`

---

## 1. Micro-corrections v3.1 → v3.2

### 1.1 Idempotence sur `Reservation` en nullable P0

`idempotencyScope` et `idempotencyKey` sont `String?` dans `Reservation` en
Phase 0. Aucun backfill des réservations existantes requis.

La contrainte d'unicité sur `(idempotencyScope, idempotencyKey)` est définie
uniquement en SQL sous forme d'index **partiel** nullable : la création d'un
`@@unique` dans Prisma n'est pas souhaitable ici (Prisma ne sait pas
modéliser un partial unique index, et une contrainte unique complète
interdirait plusieurs lignes `NULL` côté Postgres, ce qui casserait la
cohabitation avec les réservations legacy).

L'index partiel vit dans la migration `20260621000000_agentic_p0_columns` :

```sql
CREATE UNIQUE INDEX "reservations_idempotency_scope_idempotency_key_key"
ON "reservations"("idempotency_scope", "idempotency_key")
WHERE "idempotency_scope" IS NOT NULL AND "idempotency_key" IS NOT NULL;
```

Plusieurs lignes `NULL` sont donc autorisées (réservations legacy sans
clé d'idempotence), et deux réservations agentic avec la même
`(scope, key)` et même hash → contrainte partielle déclenchée.

L'obligation d'idempotence est **gérée au niveau service** : toute
réservation créée via un canal agentic (`MCP`, `OPENAI_RESERVE`, `API`)
doit fournir `idempotencyScope` + `idempotencyKey`. Les canaux legacy
(`PHONE`, `WEB`, `ADMIN`) restent sans idempotence.

```prisma
model Reservation {
  // ...champs existants...

  // Idempotence (Postgres source de vérité) — nullable en P0
  // Contrainte d'unicité partielle définie en SQL uniquement (cf. migration
  // 20260621000000_agentic_p0_columns). Pas de @@unique Prisma ici.
  idempotencyScope        String?  @map("idempotency_scope")
  idempotencyKey          String?  @map("idempotency_key")
  idempotencyPayloadHash  String?  @map("idempotency_payload_hash")
}
```

**Raffinement scope** : le scope inclut le `clientId` quand il existe :

```
restaurant:{restaurantId}:channel:{channel}:client:{clientId}
```

Si `clientId` n'est pas connu (canal legacy ou sans authentification
client), on utilise `client:unknown`.

Cela évite qu'un client OpenAI et un client Cursor collisionnent sur la
même clé pour le même restaurant.

### 1.2 `Restaurant.slug` reste nullable en P0

Le modèle Prisma et la migration P0 utilisent le même contrat :
`slug String? @unique`.

- Pas de backfill forcé vers NOT NULL
- Backfill recommandé : slug auto-généré depuis `name` + id court
- NOT NULL sera envisagé en P1, uniquement si 100% des restos ont une URL
  publique

```prisma
model Restaurant {
  // ...
  slug  String?  @unique @map("slug")
  // ...
}
```

### 1.3 `ReservationAuditLog` : table simple en P0, pas de partitionnement

Le partitionnement par `created_at` est reporté en P1/P2 (avant pilote de
production à grande échelle).

Pour P0, `ReservationAuditLog` est une table PostgreSQL standard,
append-only via trigger SQL.

Raison : Prisma + PostgreSQL imposent que les contraintes uniques/PK d'une
table partitionnée incluent la clé de partition. Un `@id id` simple ne
fonctionne pas avec un partitionnement par `created_at`. Concevoir la table
partitionnée hors Prisma est possible mais inutile pour 15 restos pilote.

```prisma
model ReservationAuditLog {
  id            String   @id @default(uuid())
  reservationId String?  @map("reservation_id")
  holdId        String?  @map("hold_id")
  actor         String
  actorHash     String?  @map("actor_hash")
  event         String
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

La rétention 1 an reste un objectif P1, via partitionnement ou outil
d'archivage, pas de promesse de purge automatique en P0.

---

## 2. Schéma Prisma P0 corrigé

### 2.1 `Restaurant`

```prisma
model Restaurant {
  // ...champs existants préservés (lignes 16-44 du schema actuel)...

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

  // ...relations existantes conservées...
  @@map("restaurants")
}
```

### 2.2 `Reservation`

```prisma
model Reservation {
  // ...champs existants préservés (lignes 69-94 du schema actuel)...

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

  // Idempotence (Postgres source de vérité) — nullable en P0
  idempotencyScope        String?             @map("idempotency_scope")
  idempotencyKey          String?             @map("idempotency_key")
  idempotencyPayloadHash  String?             @map("idempotency_payload_hash")

  // Hold consommé pour cette résa
  consumedHoldId          String?             @unique @map("consumed_hold_id")

  auditLog                ReservationAuditLog[]

  // Contrainte d'unicité (idempotencyScope, idempotencyKey) définie en SQL
  // via partial unique index (cf. migration 20260621000000_agentic_p0_columns).
  // Pas de @@unique Prisma : on veut autoriser plusieurs lignes NULL
  // (réservations legacy sans clé d'idempotence).
  @@map("reservations")
}
```

### 2.3 `AgenticHold`

```prisma
model AgenticHold {
  id              String     @id @default(uuid())
  restaurantId    String     @map("restaurant_id")

  type            HoldType   // QUOTE ou HOLD
  partySize       Int        @map("party_size")
  slotStart       DateTime   @map("slot_start")
  slotEnd         DateTime   @map("slot_end")

  channel         ReservationChannel

  quoteToken      String?    @unique @map("quote_token")
  holdToken       String?    @unique @map("hold_token")

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

> Partial unique index SQL à créer dans la migration :
>
> ```sql
> CREATE UNIQUE INDEX one_active_hold_per_slot
> ON agentic_holds (restaurant_id, slot_start, party_size)
> WHERE status = 'ACTIVE' AND type = 'HOLD';
> ```

### 2.4 `ReservationAuditLog`

```prisma
model ReservationAuditLog {
  id            String   @id @default(uuid())
  reservationId String?  @map("reservation_id")
  holdId        String?  @map("hold_id")
  actor         String
  actorHash     String?  @map("actor_hash")
  event         String
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

> Trigger SQL append-only dans la migration. Pas de partitionnement en P0.

### 2.5 `IdempotencyRecord`

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

### 2.6 `CustomerConsent`

```prisma
model CustomerConsent {
  id              String   @id @default(uuid())

  restaurantId    String   @map("restaurant_id")
  customerId      String?  @map("customer_id")
  reservationId   String?  @map("reservation_id")
  subjectHash     String   @map("subject_hash")

  channel         ReservationChannel
  context         String

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

### 2.7 `RestaurantExposureSettings`

```prisma
model RestaurantExposureSettings {
  restaurantId            String   @id @map("restaurant_id")

  mcpEnabled              Boolean  @default(false) @map("mcp_enabled")
  openaiReserveEnabled    Boolean  @default(false) @map("openai_reserve_enabled")

  exposedCreneaux         Json     @default("[]") @map("exposed_creneaux")

  maxPartySize            Int      @default(8) @map("max_party_size")
  minLeadTimeMinutes      Int      @default(30) @map("min_lead_time_minutes")
  requireManualValidation Boolean  @default(false) @map("require_manual_validation")

  quoteTtlSeconds         Int      @default(300)  @map("quote_ttl_seconds")
  holdTtlSeconds          Int      @default(420)  @map("hold_ttl_seconds")

  noShowPolicy            String   @default("warning") @map("no_show_policy")
  notificationChannels    String[] @default(["sms", "email"]) @map("notification_channels")

  capacitySpecials        Json     @default("{}") @map("capacity_specials")

  updatedAt               DateTime @updatedAt @map("updated_at")
  restaurant              Restaurant @relation(fields: [restaurantId], references: [id])

  @@map("restaurant_exposure_settings")
}
```

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

## 3. Migrations P0 v3.2 — 5 fichiers

| #   | Fichier                                   | Contenu                                                                                                 |
| --- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | `20260621000000_agentic_p0_columns`       | Champs Restaurant + Reservation + enums                                                                 |
| 2   | `20260621001000_agentic_p0_models`        | Tables AgenticHold, ReservationAuditLog, IdempotencyRecord, CustomerConsent, RestaurantExposureSettings |
| 3   | `20260621002000_agentic_p0_backfill_slug` | Colonne `slug` nullable + backfill                                                                      |
| 4   | `20260621003000_agentic_p0_extensions`    | `pg_trgm`, `cube`, `earthdistance`                                                                      |
| 5   | `20260621004000_agentic_p0_constraints`   | Partial unique index `agentic_holds` + trigger append-only audit                                        |

### 3.1 Contenu migration 5 (détail)

```sql
-- Partial unique index : un seul hold actif par slot/party_size
CREATE UNIQUE INDEX one_active_hold_per_slot
ON agentic_holds (restaurant_id, slot_start, party_size)
WHERE status = 'ACTIVE' AND type = 'HOLD';

-- Trigger append-only sur reservation_audit_log
CREATE OR REPLACE FUNCTION disallow_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'reservation_audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reservation_audit_log_append_only
BEFORE UPDATE OR DELETE ON reservation_audit_log
FOR EACH ROW EXECUTE FUNCTION disallow_audit_modification();
```

---

## 4. Plan Phase 0 corrigé (Sem 1-2)

1. Créer les 5 migrations SQL
2. Modifier `schema.prisma` (additif)
3. `prisma generate` + `prisma migrate dev`
4. `core/state-machine.ts` (pure logic)
5. `core/policies.service.ts`
6. `core/idempotency.service.ts` (Postgres first, scope avec clientId)
7. Tests Vitest : state machine + policies + idempotence
8. `pnpm typecheck` + `pnpm test`
9. **STOP — revue Hamza avant Phase 1**

---

## 5. Décision finale d'origine

Toutes les décisions produit sont validées. Les 3 micro-corrections sont
intégrées.

**Clôture au 12 septembre 2026** : le GO a été donné, les migrations et le code ont été livrés. La
formulation initiale est conservée dans les sections précédentes pour expliquer les choix de phase.
