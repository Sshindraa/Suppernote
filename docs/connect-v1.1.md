# Sokar Connect — Agent-Ready Pages (Spec d'implémentation v1.1)

> **Statut : LIVRÉ / DOCUMENT DE RÉFÉRENCE — vérifié le 12 septembre 2026.**
> L'app Connect, les routes publiques, la réservation hold/confirm idempotente, les pages
> restaurant et ville, JSON-LD, sitemap, robots, `llms.txt`, widget et domaines personnalisés
> existent dans le dépôt. Les cases `[ ]` de la section « Tickets dev » sont les critères écrits
> avant l'implémentation ; elles ne constituent plus le backlog. Restent la preuve d'un pilote sur
> de vrais restaurants et les optimisations SEO/conversion. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

> Spec d'implémentation stricte, pas un brief stratégique. Anti-hype,
> audit-first, transports séparés du métier.

- Auteur: Hermes (review Hamza)
- Cible Sokar: monorepo Fastify 5 + Prisma 6 + Next.js 15 (Next.js 14 à la rédaction)
- Domaine public: `suppernote.com` (anciennement `sokar.tech`, avant le passage à Suppernote du 3 novembre 2026 ; corrigé depuis `sokar.app` du brief)
- v1 → v1.1 corrections: cf. §15 (changelog)
- Décisions v1.1: `apps/connect` Next standalone · `agentic_reuse` · `suppernote.com` · `phase_1_seed_puis_attendre` · `redis_prometheus` · `optin_double_volet` corrigé · VPS + Nginx + Cloudflare proxy cache

---

## 1. Résumé exécutif + architecture en couches

**Thèse.** Sokar doit être un réseau public de restaurants réservables par
IA. Le client final n'installe rien. Google, ChatGPT Search, Perplexity et
les crawlers OpenAI découvrent le resto, lisent la page, et envoient
l'utilisateur vers un lien Sokar prérempli pour confirmer.

**Anti-harde.** Pas de revendication "ChatGPT réserve chez vous". Le claim
est: "votre restaurant devient lisible et réservable depuis les moteurs
et assistants IA". C'est conforme aux règles Google sur les données
structurées et au fonctionnement réel d'OAI-SearchBot.

### Diagramme (3 couches)

```
┌─────────────────────────────────────────────────────────────────┐
│ COUCHE PUBLIQUE — apps/connect (Next.js 14, output:standalone)   │
│ Hébergement: VPS Node self-hosté + Nginx reverse proxy           │
│ Cloudflare devant en proxy/CDN cache (pas static export)        │
│                                                                 │
│  /r/[slug]                  page restaurant (SSR + ISR 60s)     │
│  /r/[slug]/book             page booking (SSR, deep-link)       │
│  /restaurants/[city]        page locale (noindex si <5)         │
│  /restaurants/[city]/[..]   page cuisine/intent                 │
│  /sitemap.xml               sitemap dynamique                   │
│  /robots.txt                robots.txt dynamique                │
│  /llms.txt (P5, opt)        hint pour LLMs                      │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS JSON (no Clerk, no auth)
┌────────────────────────┴────────────────────────────────────────┐
│ COUCHE API — apps/api (Fastify 5)                               │
│  Module agentic-reservations/core/  HoldService (réutilisé)     │
│  Module agentic-reservations/core/  ReservationService          │
│  Module agentic-reservations/core/  PoliciesService             │
│  Module agentic-reservations/core/  AuditLogService             │
│  Module connect/  endpoint public GET /public/r/[slug]          │
│  Module connect/  endpoint public GET availability + hold +     │
│                   confirm (channel=WEB)                         │
└────────────────────────┬────────────────────────────────────────┘
                         │ Prisma
┌────────────────────────┴────────────────────────────────────────┐
│ COUCHE DONNÉES — packages/database (Postgres)                   │
│  Restaurant  (slug, cuisineType, openingHours, etc.)            │
│  RestaurantExposureSettings  (connectPublished, connectAgentic)  │
│  Reservation  (channel=WEB, state machine)                      │
│  AgenticHold  (HOLD/QUOTE, partial unique index)                │
│  CustomerConsent  (RGPD structured)                             │
│  ReservationAuditLog  (append-only, métier seulement)           │
└─────────────────────────────────────────────────────────────────┘
```

**Pourquoi 3 couches** : la couche publique ne doit jamais connaître
Clerk, l'API ne doit jamais servir de HTML indexable (perf, séparation
des caches), les données portent déjà la vérité du métier. Sokar Connect
**consomme** les services agentic existants, **ne les duplique pas**.

### Pourquoi Next standalone (et pas static export)

La spec demande :

- ISR `revalidate=60` sur `/r/[slug]` (Next ISR requiert le runtime Node)
- SSR avec `searchParams` sur `/r/[slug]/book` (deep-link)
- Route handlers dynamiques pour `/sitemap.xml` et `/robots.txt`
- Pages locales avec règles d'indexation calculées au render

Static export (`output: 'export'`) ne supporte ni ISR ni route handlers
non-GET, ni la lecture de `searchParams` au runtime. C'est incompatible
avec la spec.

**Hébergement P0** : `apps/connect` en `output: 'standalone'` (Next.js
Node server) sur le VPS, derrière Nginx comme reverse proxy
(sécurité, rate limit, validation transport, gestion requêtes lentes),
Cloudflare devant en proxy/CDN cache pour l'edge. C'est exactement le
pattern recommandé par Next pour un self-hosting prod-safe.

### Pourquoi pas de `basePath: '/r'`

`basePath: '/r'` aurait forcé l'API publique à servir aussi
`/restaurants`, `/sitemap.xml` et `/robots.txt` sous `/r/`, ce qui est
moche. À la place :

- `apps/connect` sert nativement `/r/*`, `/restaurants/*`,
  `/sitemap.xml`, `/robots.txt`
- Le reverse proxy route `suppernote.com/{r,restaurants,sitemap.xml,robots.txt}`
  vers `apps/connect`
- `apps/dashboard` reste sur `suppernote.com/{login,dashboard,onboarding,pricing,...}`

---

## 2. Audit du schéma existant (Prisma / DB / API)

### 2.1 Champs `Restaurant` réutilisables tels quels

| Champ spec                         | Champ Prisma              | Type            | OK ?                                    |
| ---------------------------------- | ------------------------- | --------------- | --------------------------------------- |
| `name`                             | `name`                    | String          | ✓                                       |
| `slug`                             | `slug`                    | String? @unique | ✓ nullable, à backfiller                |
| `description`                      | (manquant)                | —               | ❌ P0                                   |
| `addressLine1`                     | `formattedAddress`        | String?         | ⚠️ structurel à plat vs structuré       |
| `city`                             | (manquant)                | —               | ❌ P0                                   |
| `country`                          | (manquant)                | —               | ❌ P0                                   |
| `postalCode`                       | (manquant)                | —               | ❌ P0                                   |
| `latitude`                         | `lat`                     | Decimal?        | ✓                                       |
| `longitude`                        | `lng`                     | Decimal?        | ✓                                       |
| `phone`                            | `phoneNumber`/`phoneE164` | String/String?  | ✓                                       |
| `cuisineTypes`                     | `cuisineType`             | String[]        | ✓                                       |
| `priceRange` `€`/`€€`/`€€€`/`€€€€` | `priceRange`              | Int? (1..4)     | ✓ sémantique à clarifier                |
| `openingHours`                     | `openingHours`            | Json            | ✓ structure JSON libre                  |
| `acceptsReservations`              | `agenticOptIn`            | Boolean         | ✓ utilisé comme flag métier legacy      |
| `coverImageUrl`                    | (manquant)                | —               | ❌ P0                                   |
| `publishedAt`                      | (manquant)                | —               | ❌ P0                                   |
| `images`                           | (manquant côté table)     | —               | ❌ P0 — modèle séparé `RestaurantImage` |
| `ambiance`, `dietary`              | `ambiance`, `dietary`     | String[]        | ✓                                       |
| `noiseLevel`                       | `noiseLevel`              | NoiseLevel?     | ✓                                       |

### 2.2 Champs ajoutés à `Restaurant` (P0, données publiques uniquement)

| Besoin               | Proposition                | Type                  | Raison                                                              |
| -------------------- | -------------------------- | --------------------- | ------------------------------------------------------------------- |
| `description` courte | `Restaurant.description`   | String?               | SEO + JSON-LD `description`                                         |
| `city` structuré     | `Restaurant.city`          | String?               | pages locales, pas d'analyse de `formattedAddress`                  |
| `country`            | `Restaurant.country`       | String @default("FR") | structuration                                                       |
| `postalCode`         | `Restaurant.postalCode`    | String?               | structuration + page locale                                         |
| `coverImageUrl`      | `Restaurant.coverImageUrl` | String?               | JSON-LD image principale + OG                                       |
| `publishedAt`        | `Restaurant.publishedAt`   | DateTime?             | sitemap lastmod (≠ connectPublishedAt qui est sur ExposureSettings) |

**Pas** de `Restaurant.connectPublished` — la source de vérité unique
pour le gating est `RestaurantExposureSettings.connectPublished`. Voir
§4.1 et §15.4.

### 2.3 Champs ajoutés à `RestaurantExposureSettings` (P0)

| Champ                | Type      | Default | Rôle                                                                                            |
| -------------------- | --------- | ------- | ----------------------------------------------------------------------------------------------- |
| `connectPublished`   | Boolean   | false   | autorise la page publique + réservation web                                                     |
| `connectAgentic`     | Boolean   | false   | autorise l'exposition agentic avancée (JSON-LD `ReserveAction`, OAI-SearchBot allow, deep-link) |
| `connectPublishedAt` | DateTime? | —       | date de première publication (audit)                                                            |
| `connectDescription` | String?   | —       | override éditorial de la description publique                                                   |

**Source de vérité unique** : tous les flags de gating Sokar Connect vivent
ici. Pas de duplication sur `Restaurant`.

### 2.4 Tables à créer (P0)

**`RestaurantImage`** — galerie de photos (cover + galerie), URLs externes ou uploads.

```prisma
model RestaurantImage {
  id           String     @id @default(uuid())
  restaurantId String     @map("restaurant_id")
  url          String
  alt          String?
  isCover      Boolean    @default(false) @map("is_cover")
  position     Int        @default(0)
  createdAt    DateTime   @default(now()) @map("created_at")
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id])

  @@index([restaurantId, isCover, position])
  @@map("restaurant_images")
}
```

> Note: on évite un upload handler custom en P0. `url` pointe vers une
> URL externe (Cloudinary, S3, ou ce que le restaurateur fournit). Si
> upload nécessaire, c'est un ticket Phase 2 séparé.

**`ConnectEvent`** — **NON en P0**. Tout passe par Redis (queue
BullMQ `connect_analytics`) + prom-client. Si besoin d'historique
requêtable à long terme, table en P2.

**`CityPage`** et `CityCuisinePage` — **NON**. On dérive ces pages
d'une aggregation en mémoire depuis `Restaurant`. Pas de
dénormalisation prématurée.

### 2.5 Migration strategy

Additive, 3 fichiers SQL:

1. `20260624000001_connect_columns_restaurant` — colonnes nullable
   sur `restaurants` (description, city, country, postalCode,
   coverImageUrl, publishedAt) + colonnes sur
   `restaurant_exposure_settings` (connectPublished, connectAgentic,
   connectPublishedAt, connectDescription)
2. `20260624000002_connect_backfill` — backfill `Chez Sokar` (Lyon,
   69001, FR, description courte)
3. `20260624000003_connect_restaurant_images` — nouvelle table

Pas de colonne NOT NULL forcée tant que <100% des restos ont la valeur.

### 2.6 État API actuelle

- `restaurant.routes.ts` a `GET /restaurants/:id/public` (auth Clerk).
  **Pas utilisable** pour Sokar Connect (auth + retourne l'ID pas le slug).
- Pas de route `bySlug`.
- Pas de route `/public/availability` exposée.
- L'agentic-reservations a déjà `hold.service.ts` et
  `reservation.service.ts` qui prennent `channel: ReservationChannel`.
  On a juste à leur passer `WEB` au lieu de `MCP` ou `OPENAI_RESERVE`.

### 2.7 État frontend actuelle

- `apps/dashboard` (port 3000) — privé, Clerk
- `apps/widget` (port 4001) — B2B widget embed sur site du restaurateur
- **Aucun** consommateur public de l'API pour le SEO

---

## 3. Architecture cible — arborescence de fichiers

```
apps/
├── connect/                          # NOUVELLE APP
│   ├── package.json                  # @suppernote/connect
│   ├── next.config.js                # output: 'standalone', PAS basePath
│   ├── tailwind.config.js            # design tokens Shadcn
│   ├── tsconfig.json                 # strict
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx            # HTML root, OpenGraph defaults
│   │   │   ├── page.tsx              # / -> redirect vers /pricing (ou landing)
│   │   │   ├── not-found.tsx
│   │   │   ├── r/
│   │   │   │   └── [slug]/
│   │   │   │       ├── page.tsx      # /r/[slug] — restaurant public
│   │   │   │       ├── book/
│   │   │   │       │   └── page.tsx  # /r/[slug]/book — booking SSR
│   │   │   │       └── _components/
│   │   │   │           ├── JsonLd.tsx
│   │   │   │           ├── OpeningHoursTable.tsx
│   │   │   │           ├── BookingCta.tsx
│   │   │   │           └── MetaTags.tsx
│   │   │   ├── restaurants/
│   │   │   │   └── [city]/
│   │   │   │       ├── page.tsx      # /restaurants/[city]
│   │   │   │       └── [cuisine]/
│   │   │   │           └── page.tsx  # /restaurants/[city]/[cuisine]
│   │   │   ├── sitemap.xml/
│   │   │   │   └── route.ts          # Route handler dynamique
│   │   │   ├── robots.txt/
│   │   │   │   └── route.ts          # Route handler dynamique
│   │   │   └── llms.txt/             # Phase 5
│   │   │       └── route.ts
│   │   ├── lib/
│   │   │   ├── api-client.ts         # fetch /public/r/[slug]
│   │   │   ├── seo.ts                # helpers title/description/canonical
│   │   │   ├── jsonld.tsx            # buildPublicRestaurantJsonLd()
│   │   │   ├── index-rules.ts        # shouldIndexCollectionPage()
│   │   │   ├── analytics.ts          # emit ConnectEvent via fetch
│   │   │   └── env.ts                # API_PUBLIC_URL, SITE_URL
│   │   └── __tests__/                # Vitest, tests SEO + JSON-LD
│   │       ├── jsonld.test.tsx
│   │       ├── seo.test.ts
│   │       └── index-rules.test.ts
│   └── public/
│       └── og-default.png            # OG image par défaut
│
└── api/
    └── src/
        └── modules/
            ├── connect/              # NOUVEAU MODULE
            │   ├── connect.routes.ts # routes publiques SSR-friendly (disponibilités via CapacityAwareAvailabilityService)
            │   ├── connect.service.ts
            │   ├── sitemap.service.ts
            │   ├── robots.service.ts
            │   └── __tests__/
            │       ├── connect.routes.test.ts
            │       └── sitemap.service.test.ts
            └── agentic-reservations/ # INCHANGÉ mais réutilisé
                └── core/             # hold, reservation, policies
```

### 3.1 `next.config.js` (référence)

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // PAS 'export' — spec demande SSR/ISR
  // Pas de basePath: l'app sert /r/*, /restaurants/*, /sitemap.xml, /robots.txt
  images: {
    unoptimized: true, // on utilise Next/Image mais sans le loader Next
  },
  experimental: {
    // Optimisations ISR si besoin
  },
};

module.exports = nextConfig;
```

### 3.2 `package.json` (référence)

```json
{
  "name": "@suppernote/connect",
  "version": "0.0.1",
  "private": true,
  "scripts": {
    "dev": "next dev -p 4002",
    "build": "next build",
    "start": "next start -p 4002",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@suppernote/shared": "workspace:*",
    "@suppernote/types": "workspace:*",
    "clsx": "^2.1.1",
    "date-fns": "^4.1.0",
    "lucide-react": "^0.460.0",
    "next": "^14.2.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "tailwind-merge": "^3.5.0"
  }
}
```

### 3.3 Reverse proxy Nginx

La configuration canonique est `infra/nginx/sokar.conf` :

- `/r/*`, `/restaurants/*`, `/sitemap.xml`, `/robots.txt` → Sokar Connect `:4002`
- `/api/proxy/*`, `/api/auth/sync` → route handlers Next.js `:3000`
- `/api/*` et `api.suppernote.com/*` → Fastify `:4000`
- `/widget/*` → dashboard `:3000` avec politique iframe dédiée
- le reste de `suppernote.com` → dashboard `:3000`
- TLS origine Let’s Encrypt sur `:443`, accès direct filtré par UFW

`apps/dashboard` et `apps/widget` continuent d'exister tels quels.
Aucune modification de leur code. Cloudflare est devant le VPS
comme proxy/CDN cache (le widget reste en static export sur
Cloudflare Pages en parallèle).

### 3.4 Pourquoi `apps/connect` et pas un module dans `apps/dashboard`

1. **Build standalone obligatoire** (`output: 'standalone'`). Empiler
   les rôles = risque de régression silencieux (cf. incident MCP
   juin 2026).
2. **Zéro Clerk dans le HTML rendu** aux crawlers. Le `layout.tsx`
   actuel de `apps/dashboard` injecte `Providers` Clerk et un Header.
3. **Perf <100KB de HTML initial** sans le bundle dashboard.
4. **Tests isolés** (jsonld, SEO, index-rules) sans pollution des
   tests dashboard.

---

## 4. Opt-in & configuration (double volet corrigé)

### 4.1 Deux flags distincts sur `RestaurantExposureSettings`

```prisma
model RestaurantExposureSettings {
  restaurantId            String   @id @map("restaurant_id")
  // Existant (P0 agentic-reservations)
  mcpEnabled              Boolean  @default(false) @map("mcp_enabled")
  openaiReserveEnabled    Boolean  @default(false) @map("openai_reserve_enabled")
  exposedCreneaux         Json     @default("[]") @map("exposed_creneaux")
  maxPartySize            Int      @default(8) @map("max_party_size")
  minLeadTimeMinutes      Int      @default(30) @map("min_lead_time_minutes")
  // NOUVEAU Sokar Connect (v1.1)
  connectPublished         Boolean  @default(false) @map("connect_published")
  connectAgentic           Boolean  @default(false) @map("connect_agentic")
  connectPublishedAt       DateTime? @map("connect_published_at")
  connectDescription       String?  @map("connect_description")
  // ... autres champs existants à préserver
}
```

### 4.2 Gating rules (corrigé v1.1)

Trois prédicats calculés côté service:

```ts
canPublicPageRender =
  exposure.connectPublished === true && restaurant.slug != null && restaurant.publishedAt != null;

canWebBookingWork =
  exposure.connectPublished === true &&
  restaurant.acceptsReservations === true &&
  restaurant.publishedAt != null;

canAgenticMetadataExpose = exposure.connectPublished === true && exposure.connectAgentic === true;
```

**Différence avec v1** : `/book` ne dépend plus de `connectAgentic`.
Un restaurateur peut activer la page publique + réservation web sans
activer l'exposition agentic avancée. `connectAgentic` ne contrôle
**que** :

- l'inclusion du JSON-LD `ReserveAction` + `EntryPoint.urlTemplate`
- l'autorisation explicite OAI-SearchBot dans robots.txt
- la propagation du paramètre `source=` dans les réservations
- les deep-links agentic pré-remplis (sortie en search results)

| Page / Action                        | Condition                                                      | Réponse si KO                                                                                     |
| ------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/r/[slug]` GET                      | `canPublicPageRender`                                          | 404 (slug inexistant) ou noindex (preview restaurateur via `?preview=...`)                        |
| `/r/[slug]/book` GET (page)          | `canPublicPageRender`                                          | 404                                                                                               |
| `/r/[slug]/book` POST (hold/confirm) | `canWebBookingWork`                                            | 503 formulaire lecture seule + message "page publique désactivée"                                 |
| `/r/[slug]` JSON-LD `ReserveAction`  | `canAgenticMetadataExpose`                                     | JSON-LD sans `potentialAction` (la page reste visible et le CTA marche, mais sans signal agentic) |
| `robots.txt` allow OAI-SearchBot     | `canAgenticMetadataExpose` global (au moins 1 resto du réseau) | robots.txt ne mentionne pas OAI-SearchBot                                                         |
| `Reservation.source` tracking        | `canAgenticMetadataExpose`                                     | source=`web` par défaut, pas `chatgpt`/`perplexity`                                               |

### 4.3 Defaults

Tout à `false` en P0. Le restaurateur active depuis son dashboard
(onboarding step 6+ ou settings page). **Pas d'opt-out par défaut**
pour les features transactionnelles — règle de la skill
`feature-spec-strict` § hard limits.

### 4.4 Sortie de `agenticOptIn` du gating Sokar Connect

`agenticOptIn` reste sur `Restaurant` comme flag **legacy** (utilisé
par l'agentic-reservations MCP pour la première vague). Sokar Connect ne
l'utilise **pas** comme prédicat. Si Hamza veut aligner les deux
plus tard, c'est une migration dédiée, pas un hack dans Sokar Connect.

`acceptsReservations` est la propriété publique sémantique. Elle est
déjà sur `Restaurant` (champ `agenticOptIn` — **renommage à
discuter en P2** pour clarifier, mais hors scope Sokar Connect).

### 4.5 API publiques — auth

| Endpoint                            | Auth requise                      | Rate limit                       |
| ----------------------------------- | --------------------------------- | -------------------------------- |
| `GET /public/r/[slug]`              | **Aucune**                        | 60 req/IP/min                    |
| `GET /public/r/[slug]/availability` | Aucune                            | 30 req/IP/min                    |
| `POST /public/r/[slug]/hold`        | Aucune                            | 10 req/IP/min, 20 req/phone/jour |
| `POST /public/r/[slug]/confirm`     | Aucune + header `Idempotency-Key` | 5 req/phone/heure                |
| `GET /sitemap.xml`                  | Aucune                            | bypass                           |
| `GET /robots.txt`                   | Aucune                            | bypass                           |

Les endpoints publics ne sont **pas** derrière Clerk. Le risque
d'abus est couvert par rate limit + anti-spam (voir §8).

---

## 5. Core engine — réutilisation du moteur agentic

### 5.1 Quote vs Hold (déjà en place)

Le moteur agentic distingue déjà `QUOTE` (TTL court, pas de lock) et
`HOLD` (TTL plus long, contrainte partielle SQL). On réutilise tel quel.

### 5.2 State machine (déjà en place)

`ReservationState` = PENDING → CONFIRMED → SEATED → HONORED (ou
CANCELLED/NO_SHOW/FAILED/EXPIRED). Pour Sokar Connect, on entre par
`state=PENDING` quand le user clique "Confirmer" et que la
confirmation SMS/email n'est pas faite, puis on bascule en
`CONFIRMED` immédiatement (comme l'agentic) ou en `PENDING` si on
attend une vérif OTP (à ajouter si Phase 2).

> Pour Sokar Connect MVP, on **ne demande pas d'OTP** (phone déjà collecté
>
> - email en option). Le client est `CONFIRMED` direct. RGPD: le
>   `CustomerConsent` est créé en `web_booking_intent` avec
>   `reservation_processing=true`.

### 5.3 Idempotency (déjà en place)

`IdempotencyRecord` avec clé composite `(scope, key)`. Pour Sokar Connect:
`scope = "web:{restaurantId}:{clientFingerprint}"` où `clientFingerprint`
est un cookie first-party posé au premier GET. Si le user reclique
"Confirmer", même clé, même réponse.

### 5.4 Concurrency / capacity lock (déjà en place)

Contrainte partielle `one_active_hold_per_slot` sur `agentic_holds`.
On la **garde** pour les réservations web, pas de lock séparé.

### 5.5 Data confidence

Le champ `attributeConfidence` existe déjà sur `Restaurant` (Json).
Pour Sokar Connect, on consomme cette confidence pour décider quoi exposer:

| Attribut       | Confidence min pour exposer                |
| -------------- | ------------------------------------------ |
| `cuisineType`  | 0.5 (merchant_declared ou review_inferred) |
| `priceRange`   | 0.7                                        |
| `openingHours` | 0.9 (merchant_declared)                    |
| `ambiance`     | 0.5                                        |
| `dietary`      | 0.7                                        |
| `noiseLevel`   | 0.5                                        |

Si confidence < seuil, on n'inclut pas dans JSON-LD. Le HTML visible
reste autorisé mais on évite les claims que le moteur pourrait juger
trompeurs (cf. Google `sd-policies` sur aggregateRating inventé).

### 5.6 Policies versioning (déjà en place)

`policyVersion` snapshot au moment du hold. Pas de changement pour
Sokar Connect.

### 5.7 Channel = WEB

Toute réservation créée via Sokar Connect porte `ReservationChannel.WEB`.
L'audit log et le dashboard distinguent déjà `PHONE`, `MCP`,
`OPENAI_RESERVE`, `ADMIN`, `API`. On ajoute `WEB` à l'enum (additif,
pas breaking).

### 5.8 Ajout enum (additif)

```prisma
enum ReservationChannel {
  PHONE
  WEB         // NOUVEAU
  MCP
  OPENAI_RESERVE
  ADMIN
  API
}
```

### 5.9 `Reservation.source` (nouveau champ, additif)

```prisma
model Reservation {
  // ... existants
  source           String?  @map("source") // google|chatgpt|perplexity|bing|restaurant_website|instagram|qr_code|direct|unknown|web
  // ... existants
}
```

`source` est déduit du `?source=` query param. Si `connectAgentic=true`
sur le resto, on accepte les valeurs agentic (chatgpt, perplexity,
bing, google). Sinon, on force `source=web` pour ne pas fausser les
attributions.

---

## 6. Adapter public — module `connect`

### 6.1 Scope

- Expose la fiche restaurant (HTML rendu côté `apps/connect`)
- Expose la disponibilité en temps réel
- Expose le hold + confirm (réutilise `HoldService` + `ReservationService`)
- Génère JSON-LD, sitemap, robots.txt
- **N'expose PAS**: hold tokens complets, agent clients, OAuth, voice config,
  personality, internal IDs

### 6.2 Endpoints API

| Method | Path                           | Body / Query                                             | Response                         | Notes                                |
| ------ | ------------------------------ | -------------------------------------------------------- | -------------------------------- | ------------------------------------ |
| GET    | `/public/r/:slug`              | —                                                        | `PublicRestaurantDto`            | 200 ou 404                           |
| GET    | `/public/r/:slug/availability` | `?date=YYYY-MM-DD&partySize=N`                           | `AvailabilityDto`                | respecte horaires + capacity + holds |
| POST   | `/public/r/:slug/hold`         | `{date, time, partySize, source}`                        | `{holdId, holdToken, expiresAt}` | TTL 5 min                            |
| POST   | `/public/r/:slug/confirm`      | `{holdToken, customer, specialRequests, idempotencyKey}` | `{reservationId, status}`        | PENDING→CONFIRMED                    |

### 6.3 Fichiers

```
apps/api/src/modules/connect/
├── connect.routes.ts         # Fastify plugin, public, no Clerk ; `/availability` utilise CapacityAwareAvailabilityService (floor-plan)
├── connect.service.ts        # agrégateur (slug → restaurant + exposure + images)
├── sitemap.service.ts        # buildSitemap() (utilisé aussi par apps/connect pour rendre /sitemap.xml)
├── robots.service.ts         # buildRobots()
└── __tests__/
    ├── connect.routes.test.ts
    └── sitemap.service.test.ts
```

### 6.4 Wire-up

Enregistrement dans `apps/api/src/main.ts` (ou via le router global),
préfixe `/public`. Le module s'enregistre **sans** `requireOrg` et
**sans** Clerk.

### 6.5 Cache

`/public/r/:slug` est caché 60s en Redis. `stale-while-revalidate=300`.
L'invalidation se fait sur `Restaurant.update` et
`RestaurantExposureSettings.update` (le hook de cache existant dans
`restaurant.service.ts` doit être étendu, voir §10 ticket 2).

### 6.6 Sitemap & robots : générés côté `apps/connect`

Le sitemap et robots sont rendus par `apps/connect` (route handlers
Next.js), pas par l'API. L'API peut exposer un endpoint batch
`GET /public/sitemap-data` que `apps/connect` appelle au build/ISR
pour récupérer la liste des slugs publiés. Plus simple que de
recréer un route handler Fastify et plus cohérent avec la stack
Next.

---

## 7. Pages publiques — `apps/connect`

### 7.1 `/r/[slug]` (page restaurant)

**Rendu** : Server Component, ISR `revalidate=60`. `generateStaticParams`
pré-calcule les slugs publiés au build pour les pages les plus
trafic, le reste est rendu à la demande.

**Props visibles** :

- H1: `{name} — Restaurant {cuisineType[0]} à {city}`
- Adresse, téléphone cliquable (`tel:`)
- Horaires (table jour-par-jour)
- Prix (`€€` = 2e de priceRange)
- Galerie (cover + 3-4 vignettes, lazy load)
- CTA "Réserver une table" → `/r/[slug]/book?source={referrerSource}`
- Description courte (1-2 phrases, pas d'invention)
- Lien menu externe si `websiteUrl`
- Lien Instagram si `instagramUrl`

**Sémantique** :

- `<main>` racine
- `<h1>` unique
- Sections `<section>` avec `<h2>` explicites
- Schema.org JSON-LD `<script type="application/ld+json">`
- `<link rel="canonical">` sans query params
- OpenGraph + Twitter Card

**Meta** :

- title: `{name} — Réservation en ligne à {city} | Sokar`
- description: `Réservez une table chez {name}, restaurant {cuisineType[0]} à {city}. Horaires, adresse et réservation en ligne via Sokar.`
- robots: `index, follow` si published, sinon `noindex, follow`

### 7.2 `/r/[slug]/book` (page booking)

**Rendu** : SSR. Lit `searchParams`: `partySize`, `date`, `time`, `source`,
`utm_source`, `utm_medium`, `utm_campaign`.

**Flow** :

1. Read querystring → préremplir le state
2. Stepper 3 étapes: `Choisis ton créneau` → `Tes coordonnées` → `Confirmation`
3. Step 1: date picker + party size picker → fetch
   `/public/r/:slug/availability` → afficher slots
4. User clique un slot → POST `/public/r/:slug/hold` → reçoit `holdToken`
5. Step 2: nom + téléphone + email (opt) + demandes spéciales
6. Step 3: POST `/public/r/:slug/confirm` avec `Idempotency-Key`
7. Success page: confirmation avec numéro de réservation
8. Restaurant reçoit notification (BullMQ `restaurant_notification` queue
   existante côté agentic — à étendre pour `channel=WEB`)

**Sources tracking** : `source` query param → propagé jusqu'à
`Reservation.source` (nouveau champ nullable). Valeurs normalisées:
`google`, `chatgpt`, `perplexity`, `bing`, `restaurant_website`,
`instagram`, `qr_code`, `direct`, `unknown`, `web`.

Gating : la valeur `source` agentic (chatgpt, perplexity, etc.) n'est
acceptée que si `connectAgentic=true` sur le resto (cf. §4.4 et §5.9).

**Analytics** : `booking_page_view`, `availability_requested`,
`availability_slot_selected`, `reservation_hold_created`,
`reservation_confirmed`, `reservation_failed` — émis vers la queue
BullMQ `connect_analytics` (nouvelle, créée en P0).

### 7.3 `/restaurants/[city]` (page locale)

**Rendu** : SSR, cache 5 min.

**Règle indexation** : `count(published restaurants in city) >= 5`.
Sinon, retourne 200 mais avec `<meta name="robots" content="noindex,follow">`.

**Sections** :

- H1: `Restaurants réservables à {city}`
- Texte SEO court (généré, pas inventé): "{n} restaurants à {city}
  réservables en ligne via Sokar."
- Grid de cartes (cover, nom, cuisine, quartier, prix, CTA)
- Sections internes: "Cuisines populaires", "Avec terrasse", "Pour groupes"
  (chacune calculée à partir des `Restaurant.*` fields, max 6 items)

**Liens internes** vers `/restaurants/[city]/[cuisine]` (cuisines avec
≥3 restos), vers `/r/[slug]` pour les cartes.

### 7.4 `/restaurants/[city]/[cuisine]` (page cuisine)

**Règle indexation** : `count(in city AND cuisine) >= 10`.
Sinon noindex.

**H1** : `Restaurants {cuisine} réservables à {city}`

**Texte** : "Découvrez des restaurants {cuisine} à {city} réservables
en ligne via Sokar. Consultez les horaires, adresses et disponibilités
avant de réserver votre table."

### 7.5 `/sitemap.xml` (route handler Next.js)

```ts
// apps/connect/src/app/sitemap.xml/route.ts
export const dynamic = 'force-dynamic';

export async function GET() {
  const urls = await sitemapService.buildAll();
  return new Response(generateSitemapXml(urls), {
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });
}
```

Inclut : pages `/r/[slug]` publiées, pages `/restaurants/[city]`
indexables, pages `/restaurants/[city]/[cuisine]` indexables, homepage
suppernote.com. `lastmod` basé sur `Restaurant.updatedAt` et
`connectPublishedAt`. `changefreq=daily` pour pages resto, `weekly`
pour locales.

### 7.6 `/robots.txt` (route handler Next.js)

```
User-agent: *
Allow: /

# OAI-SearchBot autorisé uniquement si au moins 1 resto du réseau
# a connectAgentic=true (signal faible, à durcir P5).
User-agent: OAI-SearchBot
Allow: /

# GPTBot : décision P5 (training vs search). P0 = allow par défaut.
User-agent: GPTBot
Allow: /

Sitemap: https://suppernote.com/sitemap.xml
```

### 7.7 `/llms.txt` (Phase 5)

Fichier texte décrivant le réseau Sokar en langage naturel pour les
LLMs qui le liraient. Phase 5 — pas en P0.

---

## 8. Sécurité

### 8.1 Auth model (3 niveaux)

- **Routes publiques Sokar Connect**: aucune auth. Rate limit par IP.
- **Routes back-office restaurateur**: Clerk + `requireOrg` (existant).
- **Routes agent (MCP, OpenAI Reserve)**: OAuth 2.0 + API key (existant).

### 8.2 Transport hardening

- HTTPS obligatoire (Cloudflare + Nginx avec certificat d'origine)
- HSTS sur `suppernote.com`
- CORS: origines autorisées (cf. §8.7, **pas de `Origin: null` en P0**)
- `Content-Security-Policy`: `default-src 'self'; img-src 'self' https: data:;`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

### 8.3 Rate limits (par IP, par phone, par slot)

| Endpoint              | Limite                           |
| --------------------- | -------------------------------- |
| `GET /public/r/:slug` | 60 req/IP/min                    |
| `GET availability`    | 30 req/IP/min                    |
| `POST hold`           | 10 req/IP/min, 20 req/phone/jour |
| `POST confirm`        | 5 req/phone/heure, 1 req/IP/sec  |

Implémentation: Redis `INCR` + `EXPIRE` (même pattern que les autres
rate limits Sokar). Pas de Redis Cluster pour P0.

### 8.4 Idempotency obligation

`POST /confirm` exige un header `Idempotency-Key` (UUID v4 généré
côté front). Le serveur vérifie dans `IdempotencyRecord` avant tout
traitement. Si la clé existe avec le même payload hash → renvoie la
réponse stockée. Si payload différent → 409 Conflict.

### 8.5 Audit log (corrigé v1.1)

**Le `reservation_audit_log` ne devient PAS une table analytics.** Il
documente les transitions métier liées à un hold ou une réservation.

| Événement                     | Destination                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `restaurant_page_view`        | Redis (queue `connect_analytics`) — 30j rolling                                        |
| `restaurant_book_cta_clicked` | Redis                                                                                  |
| `booking_page_view`           | Redis                                                                                  |
| `availability_requested`      | Redis + prom-client counter `connect_availability_requested_total`                     |
| `availability_slot_selected`  | Redis                                                                                  |
| `reservation_hold_created`    | Redis + `reservation_audit_log` (event=`hold_created`)                                 |
| `reservation_hold_expired`    | Redis + `reservation_audit_log` (event=`hold_expired`)                                 |
| `reservation_confirmed`       | Redis + `reservation_audit_log` (event=`reservation_confirmed`) + DB `Reservation` row |
| `reservation_failed`          | Redis + `reservation_audit_log` (event=`reservation_failed`) si lié à un hold          |

Les `page_view` n'écrivent **jamais** en DB. Le coût de stockage
serait prohibitif (1 visit = 1 row) et ça n'apporte rien d'analytique
que les compteurs Redis ne sachent déjà compter.

### 8.6 Anti-spam réservation

- Phone validation E.164 + check `phone.length >= 8`
- Email optionnel mais validé si fourni (regex simple, pas de check MX)
- Bloquer les téléphones en `+000…` ou préfixes d'IVR spammy
- Honeypot field `<input name="company" hidden>` (bots le remplissent)
- Si >3 confirmations échouées pour un même phone en 1h → blocage 24h
- Hold expire 5 min, libère le slot

### 8.7 CORS (corrigé v1.1)

**Origins autorisées P0** (côté `apps/api` et `apps/connect`) :

```
https://suppernote.com
https://www.suppernote.com
```

**Pas de `Origin: null` en P0.** Un fetch server-side n'a pas besoin
de CORS navigateur. `Origin: null` peut venir de contextes sandboxés
(sandboxed iframes, fichiers locaux `file://`, Workers opaques) qui
n'ont aucune raison légitime d'appeler nos endpoints publics depuis
un browser classique. Si un vrai cas technique l'exige (par exemple
un embed dans une app mobile via WebView transparente), on l'ajoute
plus tard avec justification dans le code et le changelog.

Pour les appels server-to-server (Cloudflare workers, scripts
internes, etc.) : pas de CORS, on utilise l'API key ou le JWT de
service.

### 8.8 Pas de prompt injection defense en P0

Les endpoints publics ne sont pas LLM-facing. Pas besoin de filtre
d'injection. Si on appelle LLM (synthèse description, P5), ajouter
alors.

### 8.9 Secret redaction

Les logs API ne doivent pas log les `holdToken` ou `customer.phone`.
`pino` redact patterns à étendre.

---

## 9. RGPD

### 9.1 Structured consents (déjà en place)

`CustomerConsent` est déjà structuré. Pour Sokar Connect:

```ts
await db.customerConsent.create({
  data: {
    restaurantId: restaurant.id,
    customerId: null, // pas encore créé
    reservationId: null, // créé après confirm
    subjectHash: hashPhone(body.customer.phone),
    channel: 'WEB',
    context: 'web_booking_intent',
    reservationProcessing: true,
    transactionalSms: true,
    transactionalEmail: !!body.customer.email,
    marketingOptIn: false, // double opt-in séparé
    privacyPolicyVersion: restaurant.policyVersion,
    consentIpHash: hashIp(req.ip),
  },
});
```

### 9.2 Données publiques

Peuvent être publics (parce que publiées par le restaurateur):

- nom, adresse, téléphone pro, horaires, cuisine, photos fournies,
  lien réservation, prix, ambiance, dietary, noiseLevel, websiteUrl,
  instagramUrl.

### 9.3 Données NON publiques

- `managerEmail`, `managerPhone`
- IDs internes, `restaurant.id` (jamais exposé dans le HTML public,
  on utilise `slug`)
- `googleRefreshToken` (déjà non exposé par sérialisation Prisma select)
- Liste clients, no-show rate, revenue

### 9.4 Conservation

- `Reservation` : 2 ans (cf. conservation comptable légale)
- `CustomerConsent` : 3 ans (preuve consentement)
- `connect_analytics` (Redis) : 30 jours rolling
- `page_view` analytics : 90 jours anonymisés (hashed sessionId)

### 9.5 Right to erasure

Le `RGPD Phase 5` (juin 2026) a déjà codé `/api/rgpd/erase`. Le
endpoint public `/public/r/:slug/erase-request` n'existe pas. **À
ne pas exposer publiquement** (cf. memory RGPD: erase téléphone seul
= OK MVP interne, BLOQUANT pilote/prod). Le client qui veut effacer
ses données contacte `dpo@suppernote.com`.

### 9.6 Sous-traitants

| Sous-traitant            | Finalité                                                    | DPA                     |
| ------------------------ | ----------------------------------------------------------- | ----------------------- |
| Telnyx (carrier voix)    | Pas utilisé par Sokar Connect direct, mais SMS confirmation | À formaliser            |
| Twilio / autre SMS       | SMS confirmation (futur)                                    | À formaliser            |
| Cloudflare (CDN + proxy) | Servir `apps/connect` static + edge cache                   | DPA Cloudflare standard |
| VPS hébergeur            | Host Next standalone                                        | DPA VPS                 |

> Le brief a noté "DPA sous-traitants à formaliser". Sokar Connect n'ajoute
> pas de nouveau sous-traitant par rapport à l'existant. À cocher
> dans la checklist RGPD globale.

---

## 10. Tickets dev d'origine (Phase 0 livré)

> Les cases ci-dessous ont été écrites comme critères d'acceptation avant implémentation. Elles
> n'ont pas été rétro-cochées et ne doivent pas être importées dans un outil de suivi.

10 tickets. Phasage en §11.

### Ticket 1 — Migration DB Sokar Connect (P0)

**Scope** :

- 3 migrations additives sous `packages/database/prisma/migrations/`:
  - `20260624000001_connect_columns_restaurant` — colonnes nullable:
    `description`, `city`, `country`, `postalCode`, `coverImageUrl`,
    `publishedAt` sur `restaurants` ; `connectPublished`,
    `connectAgentic`, `connectPublishedAt`, `connectDescription` sur
    `restaurant_exposure_settings`
  - `20260624000002_connect_backfill` — backfill `Chez Sokar` (Lyon,
    69001, FR, description courte)
  - `20260624000003_connect_restaurant_images` — table
- Modifier `schema.prisma` (additif)
- Étendre `ReservationChannel` enum avec `WEB`
- Ajouter `Reservation.source` (String? nullable)
- `pnpm db:generate` OK
- Migration déployée en local

**STOP** : avant `migrate deploy`, demande à Hamza de confirmer
`packages/database/.env`. Ne pas pré-remplir. Cf. skill
`sokar-prisma-migrate` § ".env : ne JAMAIS pré-remplir par l'agent".

**Acceptance** :

- [ ] `prisma migrate deploy` applique les 3 fichiers sans erreur
- [ ] `RestaurantExposureSettings.connectPublished` existe, default false
- [ ] `Restaurant.description`, `city`, `country`, `postalCode`,
      `coverImageUrl`, `publishedAt` existent
- [ ] `Reservation.source` existe, nullable
- [ ] `RestaurantImage` existe
- [ ] Seed tourne toujours (avec backfill Lyon/69001)
- [ ] `_prisma_migrations` à jour

### Ticket 2 — API publique Sokar Connect (P0)

**Scope** :

- Créer `apps/api/src/modules/connect/`
- `connect.routes.ts` enregistré dans `main.ts` (ou router global)
  sous le préfixe `/public`
- 4 endpoints publics (§6.2) — sitemap/robots sont rendus par
  `apps/connect`, pas par l'API
- Pas de Clerk, pas de `requireOrg`
- Cache Redis sur `/public/r/:slug` (60s TTL, 300s SWR)
- `Idempotency-Key` header obligatoire sur POST confirm
- Tests Vitest (route-level + service-level)
- CORS: origines `https://suppernote.com`, `https://www.suppernote.com` (cf. §8.7)

**Acceptance** :

- [ ] `GET /public/r/chez-suppernote-demo` retourne 200 + DTO
- [ ] `GET /public/r/inexistant` retourne 404
- [ ] `GET /public/r/chez-suppernote-demo/availability?date=...&partySize=2`
      retourne slots valides
- [ ] `POST /hold` puis `POST /confirm` avec `Idempotency-Key` crée
      une reservation avec `channel=WEB`
- [ ] Replay du même `Idempotency-Key` + payload = même réponse
- [ ] Replay avec payload différent = 409 Conflict
- [ ] Rate limit 429 sur 11e POST /hold en 1 min
- [ ] 401 abs (pas d'auth) — appels anonymes OK
- [ ] `source=chatgpt` accepté si `connectAgentic=true`, sinon
      forcé à `source=web`

### Ticket 3 — JSON-LD Service (P0)

**Scope** :

- `packages/shared/src/jsonld.ts` exporte `buildPublicRestaurantJsonLd(restaurant, opts)`, re-exporté par `apps/connect/src/lib/jsonld.tsx`
- Respecte `attributeConfidence` (§5.5) : pas de claims non sourcés
- Inclut `Restaurant`, `PostalAddress`, `GeoCoordinates` si lat/lng,
  `openingHoursSpecification`, `acceptsReservations` (URL `/book`),
  `potentialAction` avec `ReserveAction` et `EntryPoint.urlTemplate`
  **uniquement si `canAgenticMetadataExpose`**
- `aggregateRating` JAMAIS inclus en P0 (pas d'avis propriétaires)
- Tests : parse JSON-LD avec `JSON.parse`, vérifier chaque champ,
  tester le cas sans lat/lng, tester le cas sans openingHours, tester
  le cas `connectAgentic=false` (pas de `potentialAction`)

**Acceptance** :

- [ ] JSON.parse du output = OK
- [ ] `acceptsReservations` est l'URL `/book` (pas un booléen)
- [ ] `potentialAction.target.urlTemplate` contient `{partySize}`,
      `{date}`, `{time}` literals
- [ ] `openingHoursSpecification` respecte la structure schema.org
- [ ] `geo` absent si pas de lat/lng (pas `null`)
- [ ] `potentialAction` absent si `connectAgentic=false`

### Ticket 4 — `apps/connect` setup + Nginx (P0)

**Scope** :

- Nouvelle app Next.js 14 App Router
- `package.json` `@suppernote/connect` + workspace dep sur
  `@suppernote/shared` (pour les types)
- `next.config.js` avec `output: 'standalone'`, **PAS de basePath**,
  `images: { unoptimized: true }`
- `tailwind.config.js` (réutilise les design tokens du dashboard —
  `bg-background`, `text-foreground`, etc.)
- `tsconfig.json` strict
- `pnpm-workspace.yaml` déjà OK (apps/\* wildcard)
- Turbo task `connect#dev` (port 4002), `connect#build`,
  `connect#typecheck`
- Lint config cohérente avec le reste
- `infra/nginx/sokar.conf` mis à jour pour router
  `/r/*`, `/restaurants/*`, `/sitemap.xml`, `/robots.txt` vers
  `apps/connect` (cf. §3.3)
- HSTS sur suppernote.com

**Acceptance** :

- [ ] `pnpm --filter @suppernote/connect dev` lance l'app sur :4002
- [ ] `pnpm --filter @suppernote/connect build` produit
      `apps/connect/.next/standalone/`
- [ ] `pnpm --filter @suppernote/connect typecheck` passe
- [ ] `pnpm turbo build` global passe
- [ ] `curl -I https://suppernote.com/r/chez-suppernote-demo` (après deploy)
      répond 200 avec HSTS

### Ticket 5 — Page `/r/[slug]` (P0)

**Scope** :

- `apps/connect/src/app/r/[slug]/page.tsx` Server Component
- `generateStaticParams` lit `/public/r/index` (nouveau endpoint
  batch) ou cache les slugs
- ISR `revalidate=60`
- `generateMetadata` dynamique (title, description, OG, Twitter)
- Composants: `JsonLd`, `OpeningHoursTable`, `BookingCta`, `MetaTags`
- Respecte `canPublicPageRender` (404 si non publié, 200 noindex si
  restaurateur en preview via `?preview=...` header)
- French-first copy, design tokens Shadcn
- LCP < 2.5s, HTML initial < 100KB

**Acceptance** :

- [ ] `curl -s localhost:4002/r/chez-suppernote-demo` → HTML avec H1
- [ ] JSON-LD `<script type="application/ld+json">` présent
- [ ] `<link rel="canonical">` présent, sans query params
- [ ] `<meta name="robots" content="index, follow">` si publié
- [ ] Lighthouse mobile: Performance > 90, SEO > 95
- [ ] HTML visible contient le nom, adresse, horaires (cohérent JSON-LD)

### Ticket 6 — Page `/r/[slug]/book` (P0)

**Scope** :

- `apps/connect/src/app/r/[slug]/book/page.tsx`
- Lit `searchParams` (partySize, date, time, source, utm\_\*)
- Composants: `BookingStepper`, `DatePicker`, `PartySizePicker`,
  `SlotGrid`, `CustomerForm`, `ConfirmationView`
- Appels API: `GET availability`, `POST hold`, `POST confirm`
- Émet événements analytics (queue BullMQ `connect_analytics`)
- `Idempotency-Key` généré côté client (uuidv4)
- Gestion d'erreurs: slot pris entre hold et confirm, hold expiré,
  capacity exceeded

**Acceptance** :

- [ ] Deep-link
      `/r/chez-suppernote-demo/book?partySize=4&date=2026-06-24&time=20:00&source=chatgpt`
      pré-remplit le formulaire
- [ ] Slot demandé en premier dans la grille
- [ ] Hold expiré (5 min) → retour step 1 avec message clair
- [ ] Reservation confirmée → page de confirmation avec ID
- [ ] `source=chatgpt` est propagé jusqu'à `Reservation.source`
      **uniquement si `connectAgentic=true`**, sinon forcé à `web`

### Ticket 7 — Pages locales `/restaurants/[city]` (P0, noindex par défaut)

**Scope** :

- `apps/connect/src/app/restaurants/[city]/page.tsx`
- `apps/connect/src/app/restaurants/[city]/[cuisine]/page.tsx`
- `index-rules.ts` (Phase 1 code la mécanique, threshold à 5/10/20
  par défaut — Hamza peut ajuster)
- **Seed Lyon 5 restos** ajouté à `packages/database/prisma/seed.ts`
  avec `connectPublished=true` ET `connectAgentic=false` (juste
  suffisant pour tester le seuil ville). **Le seed ne doit JAMAIS
  activer `connectAgentic=true`** — ça reste un acte de production
  explicite par resto.
- Composant `RestaurantCard` (cover, nom, cuisine, prix, CTA)
- Sections internes: "Cuisines populaires", "Avec terrasse", etc.

**Acceptance** :

- [ ] Avec <5 restos dans une ville: 200 noindex
- [ ] Avec ≥5 restos: 200 index
- [ ] Page cuisine: ≥10 index, <10 noindex
- [ ] Liens internes entre pages (city → cuisine → resto)
- [ ] City extraite de `Restaurant.city`, fallback parsing
      `formattedAddress` si manquant (mais backfill déjà fait)
- [ ] Les 5 restos seedés sont présents en local/staging et
      testent l'indexation. **En production, le seed est désactivé
      ou noindex forcé** (cf. §11.1, environnement `NODE_ENV=production`
      → seed ne publie pas)

### Ticket 8 — Sitemap + Robots (P0)

**Scope** :

- Route handlers Next.js : `apps/connect/src/app/sitemap.xml/route.ts`
  et `apps/connect/src/app/robots.txt/route.ts`
- `sitemapService` et `robotsService` consommés par Next (ré-export
  depuis l'API ou réimplémentés côté Next ? — **ré-export depuis
  l'API** pour éviter la duplication, on appelle
  `apps/api/src/modules/connect/sitemap.service.ts` directement
  depuis le route handler Next via `@suppernote/api` workspace dep)
- Pas d'inclusion des pages `noindex`
- Sitemap par défaut `https://suppernote.com/sitemap.xml`
- Robots référence le sitemap
- `OAI-SearchBot` explicit allow (sera conditionnel P5)

**Acceptance** :

- [ ] `GET /sitemap.xml` retourne XML valide
- [ ] URLs canonical uniquement (pas de query params)
- [ ] `<lastmod>` ISO 8601
- [ ] Restaurants non publiés absents
- [ ] Pages locales <5 restos absentes
- [ ] `GET /robots.txt` retourne `User-agent: *` + `Allow: /` + sitemap
- [ ] `User-agent: OAI-SearchBot` présent

### Ticket 9 — Tracking Sokar Connect (P0)

**Scope** :

- Nouvelle queue BullMQ `connect_analytics` dans
  `apps/api/src/shared/queue/queues.ts`
- Helper `emitConnectEvent(event, payload)` côté API
- `connect_*` prom-client counters dans `/api/metrics`
- Côté front `apps/connect`, helper `analytics.ts` qui POST à
  `/public/events/connect` (nouveau endpoint batch)
- Workers: agrégation horaire (compte par source, par city, par resto)
- Tests unitaires sur `emitConnectEvent`
- **Distinction explicite** Redis (page_view, cta_click) vs
  audit log (hold/confirm/failed/expired) cf. §8.5

**Acceptance** :

- [ ] `reservation_confirmed` avec `source=chatgpt` apparaît dans
      le compteur `connect_reservations_confirmed_total{source="chatgpt"}`
- [ ] `page_view` n'est PAS enregistré en DB (Redis uniquement)
- [ ] `GET /api/metrics` retourne les compteurs
- [ ] Pas de PII dans les labels prom-client
- [ ] `reservation_audit_log` ne contient QUE des events métier
      (hold_created, hold_expired, reservation_confirmed, etc.)

### Ticket 10 — RGPD + sécurité (P0)

**Scope** :

- Headers sécurité sur `apps/connect` (CSP, HSTS, X-Content-Type-Options,
  Referrer-Policy)
- Cookies first-party uniquement (no third-party)
- Phone validation E.164
- Honeypot field dans le formulaire
- Rate limits implémentés (cf. §8.3)
- Redaction tokens dans pino (extend `redact` patterns)
- Privacy policy link dans le footer de chaque page publique
- CORS: origines autorisées `https://suppernote.com`,
  `https://www.suppernote.com` (cf. §8.7 — **PAS de `Origin: null`**)

**Acceptance** :

- [ ] `curl -I` sur `/r/chez-suppernote-demo` montre les headers
- [ ] POST `/hold` rate-limited à 11e req/min = 429
- [ ] Phone `+000000` refusé en validation
- [ ] Pas de `holdToken` dans les logs
- [ ] Test CORS: requête avec `Origin: null` → refusée
- [ ] Test CORS: requête avec `Origin: https://suppernote.com` → OK

---

## 11. Plan d'exécution — 5 semaines

| Semaine | Phase                 | Livrables                                       | Stop revue                       |
| ------- | --------------------- | ----------------------------------------------- | -------------------------------- |
| 1       | P0 DB                 | Ticket 1                                        | ✓ Revue schema + migrations      |
| 1-2     | P0 API publique       | Ticket 2 + 3                                    | ✓ Revue endpoints + JSON-LD      |
| 2       | P0 App + Nginx        | Ticket 4                                        | ✓ Revue scaffold + reverse proxy |
| 2-3     | P0 Pages              | Ticket 5 + 6                                    | ✓ Revue page resto + book        |
| 3       | P0 Pages locales      | Ticket 7                                        | ✓ Revue seuils indexation + seed |
| 3-4     | P0 Sitemap + Tracking | Ticket 8 + 9                                    | ✓ Revue SEO + analytics          |
| 4       | P0 RGPD + sécurité    | Ticket 10                                       | ✓ Revue sécurité                 |
| 5       | P1 Pilote fermé       | 10 restos réels, sitemap soumis GSC, monitoring | ✓ Go/no-go pilote                |

### 11.1 Distinction local / staging / production pour le seed

| Env        | Seed Lyon 5 restos | `connectPublished` | `connectAgentic` | Dans sitemap       |
| ---------- | ------------------ | ------------------ | ---------------- | ------------------ |
| local dev  | oui                | true               | **false**        | oui (noindex test) |
| staging    | oui                | true               | **false**        | oui (noindex test) |
| production | **non**            | n/a                | n/a              | n/a                |

Le seed `packages/database/prisma/seed.ts` check `process.env.NODE_ENV` :

- `development` ou `staging` : seed 5 restos Lyon avec `connectPublished=true`,
  `connectAgentic=false`, dans le sitemap
- `production` : seed le seul "Chez Sokar" canonique (backfill), les
  4 restos "Chez Sokar 2-5" sont **skippés** (commentaire
  `// skipped in production: avoid polluting public index`)

Le dashboard P2 permet à un restaurateur d'activer `connectAgentic=true`
en production. Le seed ne le fait jamais.

### 11.2 Pilote fermé (semaine 5-6)

- 10 restos réels onboardés manuellement
- Soumission sitemap à Google Search Console
- Monitoring: erreurs 5xx, latence p95 `/public/r/:slug`, taux
  hold→confirm
- Critère go/no-go pour P2 (pages locales, premium subdomain, agent
  enhancements):
  - ≥30% des réservations web confirmées
  - p95 < 500ms
  - 0 fuite PII dans logs
  - 0 page dans Search Console avec `aggregateRating` inventé (audit)

### 11.3 P2 (post-pilote)

- Pages locales indexées (Lyon, Paris si ≥5)
- Premium subdomain (`reserve.chezmario.fr`)
- Dashboard Sokar Connect dans `apps/dashboard/dashboard/connect`
- Plus d'intent pages (`/terrasse`, `/groupe`, `/vegetarien`)

### 11.4 P5 (post-P2)

- `/llms.txt`
- OAI-SearchBot log analysis
- Schema.org `Menu` et `MenuSection`
- `aggregateRating` si on lance un système d'avis
- Renommage `agenticOptIn` → `acceptsReservations` sur `Restaurant`

---

## 12. Métriques de succès + Risques

### 12.1 KPIs Phase 1

| Métrique                          | Cible MVP    | Source                |
| --------------------------------- | ------------ | --------------------- |
| Pages `/r/[slug]` indexées        | 10/10        | Google Search Console |
| Rich Results Test                 | 10/10 OK     | Google Rich Results   |
| Lighthouse Perf mobile            | > 90         | Lighthouse            |
| LCP p75                           | < 2.5s       | RUM (P2)              |
| Taux page_view → book click       | > 8%         | Redis analytics       |
| Taux book → hold                  | > 60%        | Redis analytics       |
| Taux hold → confirm               | > 50%        | DB                    |
| Réservations `channel=WEB` / jour | > 5 (pilote) | DB                    |
| 0 PII dans prom-client labels     | 100%         | Audit mensuel         |

### 12.2 Risques × Impact × Mitigation

| Risque                                                       | Impact                    | Mitigation                                                                                 |
| ------------------------------------------------------------ | ------------------------- | ------------------------------------------------------------------------------------------ |
| Google ne crawl/indexe pas `/r/[slug]`                       | Aucun trafic              | Soumission sitemap, backlinks depuis `apps/dashboard`, demander indexation manuelle 5 URLs |
| ChatGPT search n'utilise pas OAI-SearchBot sur notre domaine | Pas d'acquisition agent   | Étude P5, test avec 5 URLs dans Perplexity/ChatGPT manuellement                            |
| Restaurateur publie infos fausses (adresse, horaires)        | Réputation, SEO négatif   | Backoffice: validation manuelle avant `connectPublished=true`, signalement utilisateur     |
| Spam de réservations                                         | Capacity épuisée, no-show | Rate limit phone, honeypot, blocage si >3 echec/heure                                      |
| Double booking (race condition hold→confirm)                 | UX dégradée               | Contrainte partielle SQL existe déjà                                                       |
| `attributeConfidence` < 0.5 partout                          | Pages maigres             | Onboarding force la saisie; minimum 4 champs requis pour publier                           |
| Drain SEO par pages locales pauvres                          | Pénalité Google           | `noindex` strict si <seuil; pas d'URLs en double                                           |
| Faux restos seed en prod                                     | Pollution index           | `NODE_ENV=production` skip le seed 5 restos Lyon (§11.1)                                   |
| VPS down                                                     | Tout Sokar Connect down   | On est sur `suppernote.com` qui est déjà monitoré                                          |
| Vitest suite timeout sur 10 fichiers                         | CI rouge                  | Background + notify_on_complete pattern (cf. skill)                                        |
| `aggregateRating` inventé par erreur                         | Pénalité Google           | Test unitaire strict, lint custom qui refuse le mot `aggregateRating` hors contexte        |

---

## 13. Décisions en attente (à acter avant Phase 0)

1. **Domaine final**: `suppernote.com` confirmé.
   - Action: mettre à jour `openai-reserve.service.ts` ligne 172
     (`https://app.sokar.com/r/${slug}` → `https://suppernote.com/r/${slug}`)
   - Action: Nginx `suppernote.com` avec HSTS et certificat d'origine
   - **Mon avis**: cleanup, pas une nouvelle décision.

2. **Phase 1 seed Lyon ≥5 restos**: oui, mais noindex par défaut et
   `connectAgentic=false` (§11.1). C'est juste assez pour tester
   l'indexation conditionnelle de `/restaurants/lyon`. **Aucun
   faux resto en production.**

3. **Reverse proxy**: Nginx est la source canonique et le seul proxy actif.

4. **Tracking event durée de vie Redis**: 30 jours rolling.
   - **Mon avis**: OK, conforme aux autres analytics Sokar.

5. **Opt-in UI côté dashboard**: nouvelle page
   `apps/dashboard/src/app/dashboard/connect/page.tsx` dans la nav
   latérale, avec toggle `connectPublished` et `connectAgentic` +
   preview de la page publique (iframe sur `https://suppernote.com/r/[slug]?preview=...`).
   - **Mon avis**: à faire en P0.5 (semaine 4-5) — pas bloquant
     pour le GO Phase 0, mais bloquant pour le pilote.

6. **Sitemap racine `/sitemap.xml` ou sous-sitemap ?**
   - **Mon avis**: `/sitemap.xml` racine pour P0, разделение en
     sous-sitemaps en P2 si >5000 URLs.

7. **Renommage `agenticOptIn` → `acceptsReservations`**: hors scope
   Sokar Connect, à faire en P5 dans une migration dédiée. Pour l'instant
   on lit `agenticOptIn` comme sémantique legacy.

---

## 14. Anti-patterns rappelés

- ❌ Ne pas inventer `aggregateRating` (cf. Google `sd-policies`)
- ❌ Ne pas afficher "Disponible ce soir 20h" en HTML statique
- ❌ Ne pas exposer `managerEmail` dans le HTML public
- ❌ Ne pas indexer les pages `<5` restos (porte ouverte à la pénalité)
- ❌ Ne pas dupliquer les routes (un seul canonical par resto)
- ❌ Ne pas sur-vendre l'IA ("ChatGPT réserve chez vous")
- ❌ Ne pas pré-remplir `.env` de DATABASE_URL
- ❌ Ne pas utiliser `prisma migrate dev` (utiliser `migrate deploy`)
- ❌ Ne pas autoriser `Origin: null` en CORS par défaut
- ❌ Ne pas utiliser `output: 'export'` (incompatible avec ISR/SSR)
- ❌ Ne pas activer `connectAgentic` dans le seed
- ❌ Ne pas mettre de faux restos en prod
- ❌ Ne pas utiliser `reservation_audit_log` comme table analytics
- ❌ Ne pas appeler l'API publique depuis le code de l'API elle-même
  (sinon layering cassé)

---

## 15. Changelog

### v1.1 (depuis v1)

8 corrections intégrées suite à la review de Hamza. v1 reste
archivée dans `connect-v1.md.archived`.

1. **Static export → standalone** : remplacé `output: 'export'` par
   `output: 'standalone'`. La spec demande SSR/ISR, route handlers
   dynamiques pour sitemap/robots, et `searchParams` au runtime,
   ce qui est incompatible avec static export. Hébergement P0 =
   VPS Node self-hosté + Nginx reverse proxy + Cloudflare proxy
   cache.
2. **Suppression de `basePath: '/r'`** : l'app sert nativement
   `/r/*`, `/restaurants/*`, `/sitemap.xml`, `/robots.txt`. Le
   reverse proxy route vers `apps/connect` selon le préfixe.
3. **Hébergement P0 clarifié** : VPS + Node Next standalone + Nginx
   - Cloudflare proxy cache. Pas de static export.
4. **Gating corrigé** : `connectPublished` autorise page publique +
   réservation web. `connectAgentic` autorise exposition agentic
   avancée (JSON-LD `ReserveAction`, OAI-SearchBot, deep-link
   tracking `source=`). `/book` ne dépend plus de `connectAgentic`.
   `agenticOptIn` sorti du gating Sokar Connect (legacy).
5. **Source de vérité unique** : tous les flags de gating Sokar Connect
   sont sur `RestaurantExposureSettings`. Pas de duplication
   `Restaurant.connectPublished` (supprimé).
6. **Seed local/staging uniquement** : `NODE_ENV=production`
   skip le seed 5 restos Lyon. Aucun faux resto en prod.
7. **Tracking rééquilibré** : `reservation_audit_log` n'est plus
   une table analytics. Page views = Redis uniquement. Audit log
   uniquement pour les transitions métier hold/reservation.
8. **CORS durci** : `Origin: null` retiré de la liste P0. Seules
   `https://suppernote.com` et `https://www.suppernote.com` sont
   autorisées en P0.

### v1 (initiale)

Première rédaction. v1 reste comme trace d'itération.

---

## 16. Fichiers de référence

- `apps/api/src/modules/agentic-reservations/core/hold.service.ts` —
  mécanique HOLD à réutiliser
- `apps/api/src/modules/agentic-reservations/core/reservation.service.ts` —
  mécanique reservation à réutiliser
- `apps/api/src/modules/restaurants/restaurant.routes.ts:240` — modèle
  pour `GET /restaurants/:id/public` à transformer
- `apps/widget/next.config.js` — modèle `output: 'export'` (pour
  apps/widget qui reste en static, **PAS pour apps/connect**)
- `apps/dashboard/src/app/layout.tsx` — design tokens Shadcn à
  réutiliser (mais sans Clerk/Header)
- Skill `sokar-feature-design` §3 (pièges Prisma) et §4 (anti-patterns)
- Skill `feature-spec-strict` §1-13 (structure spec stricte)
- Skill `sokar-prisma-migrate` §"Micro-rituel avant prisma migrate"

---

**Statut actuel** : socle v1.1 livré. La spec reste numérotée pour la traçabilité.

**Étape actuelle** : exécuter et documenter le pilote réel, puis prioriser les écarts observés. Le
GO Phase 0 et l'ordre des tickets ci-dessus appartiennent à l'historique de réalisation.
