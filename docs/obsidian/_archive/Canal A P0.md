# Canal A — Agent-Ready Pages (Phase 0)

> **Statut** : Phase 0 en cours (2026-06-24). Spec validée v1.1, T1 écrit, ⏸ STOP pour `migrate deploy`.
> **Spec complète** : `docs/canal-a-v1.1.md` (60 KB)
> **v1 archivée** : `docs/canal-a-v1.md.archived` (45 KB)
> **Module API** : `apps/api/src/modules/canal-a/` (à créer en T2)
> **App publique** : `apps/canal-a/` (à créer en T4)

## Thèse

Transformer Suppernote en **réseau public de restaurants réservables par IA**.
Le client final n'installe rien. Google, ChatGPT Search, Perplexity et
les crawlers OpenAI découvrent le resto, lisent la page, et envoient
l'utilisateur vers un lien Suppernote prérempli pour confirmer.

**Anti-hype** : on ne prétend pas que ChatGPT réserve tout seul. On dit
"votre restaurant devient lisible et réservable depuis les moteurs et
assistants IA". C'est conforme aux règles Google (données structurées)
et au fonctionnement réel d'OAI-SearchBot.

## Architecture (3 couches strictes)

```
┌─────────────────────────────────────────────────────────────────┐
│ apps/canal-a (Next.js 15, output:standalone)                    │
│ /r/[slug]              page restaurant (SSR + ISR 60s)          │
│ /r/[slug]/book         page booking (SSR, deep-link)            │
│ /restaurants/[city]    page locale (noindex si <5 restos)       │
│ /sitemap.xml           sitemap dynamique                        │
│ /robots.txt            robots.txt dynamique                     │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS JSON (no Clerk, no auth)
┌────────────────────────┴────────────────────────────────────────┐
│ apps/api (Fastify 5) — module canal-a/                          │
│ GET  /public/r/:slug          PublicRestaurantDto               │
│ GET  /public/r/:slug/availability                                  │
│ POST /public/r/:slug/hold                                          │
│ POST /public/r/:slug/confirm  (header Idempotency-Key requis)   │
└────────────────────────┬────────────────────────────────────────┘
                         │ Prisma
┌────────────────────────┴────────────────────────────────────────┐
│ Restaurant + RestaurantExposureSettings + Reservation           │
│ + AgenticHold (réutilisé, channel=WEB) + CustomerConsent        │
└─────────────────────────────────────────────────────────────────┘
```

**Hébergement** : VPS + Nginx reverse proxy + Cloudflare proxy/cache
devant. **Pas de static export** (incompatible avec ISR/SSR).

## Gating double volet

| Flag                                 | Rôle                                                                   | Défaut |
| ------------------------------------ | ---------------------------------------------------------------------- | ------ |
| `canalAPublished` (ExposureSettings) | autorise page publique + réservation web                               | false  |
| `canalAAgentic` (ExposureSettings)   | autorise JSON-LD `ReserveAction` + OAI-SearchBot + deep-link `source=` | false  |
| `agenticOptIn` (Restaurant)          | legacy, non utilisé pour Canal A                                       | false  |

3 prédicats calculés :

- `canPublicPageRender` = `canalAPublished && slug && publishedAt`
- `canWebBookingWork` = `canalAPublished && acceptsReservations && publishedAt`
- `canAgenticMetadataExpose` = `canalAPublished && canalAAgentic`

## Plan d'exécution (5 semaines)

| Sem | Phase                 | Tickets         | STOP revue |
| --- | --------------------- | --------------- | ---------- |
| 1   | P0 DB                 | T1              | ✓          |
| 1-2 | P0 API                | T2 + T3         | ✓          |
| 2   | P0 App + Nginx        | T4              | ✓          |
| 2-3 | P0 Pages              | T5 + T6         | ✓          |
| 3   | P0 Pages locales      | T7              | ✓          |
| 3-4 | P0 Sitemap + Tracking | T8 + T9         | ✓          |
| 4   | P0 RGPD + sécurité    | T10             | ✓          |
| 5   | P1 Pilote fermé       | 10 restos réels | Go/no-go   |

## T1 — Migration DB (EN COURS)

3 migrations additives écrites (2026-06-24) :

1. `20260624000001_canal_a_columns_restaurant` — colonnes nullable
2. `20260624000002_canal_a_backfill` — Chez Suppernote → Lyon/69001/FR
3. `20260624000003_canal_a_restaurant_images` — table `RestaurantImage`

**Schéma `prisma` étendu** :

- `Restaurant` : + `description`, `city`, `country`, `postalCode`,
  `coverImageUrl`, `publishedAt`, relation `images[]`
- `RestaurantExposureSettings` : + `canalAPublished`, `canalAAgentic`,
  `canalAPublishedAt`, `canalADescription`
- `Reservation` : + `source` (String?)
- Nouveau modèle `RestaurantImage` (Cascade delete, index `isCover,position`)

**Vérifications** :

- `prisma generate` ✅ (exit 0)
- `pnpm typecheck` global ✅ (api, dashboard, widget, database, types, shared)

**STOP obligatoire** : `migrate deploy` non lancé. Hamza doit confirmer
`packages/database/.env` (déjà présent, chmod 600, 59 bytes, pointant
sur `postgresql://sokar:***@localhost:5432/sokar`).

## Anti-patterns rappelés

- ❌ Ne pas inventer `aggregateRating`
- ❌ Ne pas afficher "Disponible ce soir 20h" en HTML statique
- ❌ Ne pas exposer `managerEmail` dans le HTML public
- ❌ Ne pas indexer pages <5 restos
- ❌ Ne pas dupliquer les routes (un seul canonical par resto)
- ❌ Ne pas sur-vendre l'IA
- ❌ Ne pas pré-remplir `.env`
- ❌ Ne pas utiliser `prisma migrate dev` (utiliser `migrate deploy`)
- ❌ Ne pas autoriser `Origin: null` en CORS
- ❌ Ne pas utiliser `output: 'export'`
- ❌ Ne pas activer `canalAAgentic` dans le seed
- ❌ Ne pas mettre de faux restos en prod
- ❌ Ne pas utiliser `reservation_audit_log` comme table analytics

## Liens

- Spec v1.1 : `docs/canal-a-v1.1.md`
- Runbook transversal : `docs/runbook.md`
- Spec agentic-reservations v3.2 (réutilisation moteur) : `docs/sokar-mcp-agentic-reservations-v3.2.md`
- Module API (à venir) : `apps/api/src/modules/canal-a/`
- App publique (à venir) : `apps/canal-a/`
