# Suppernote Connect — Agent-Ready Pages (Phase 0)

> **Statut** : Phase 0 en cours (2026-06-24). Spec validée v1.1, T1 **déployé** (`migrate deploy` + backfill Chez Suppernote → Lyon/69001/FR, vérifié vert le 2026-06-24). T1-T10 écrits, testés et **déployés en prod** (cf. Journal). T4 app + Nginx déployé en prod (vérifié 2026-07-27 : PM2 sokar-connect online, endpoints 200, HSTS, JSON-LD, CSP). Reste : P1 pilote fermé (10 restos réels, sitemap GSC, monitoring).
> **Spec complète** : `docs/connect-v1.1.md` (60 KB)
> **v1 archivée** : `docs/connect-v1.md.archived` (45 KB)
> **Module API** : `apps/api/src/modules/connect/` (à créer en T2)
> **App publique** : `apps/connect/` (à créer en T4)

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
│ apps/connect (Next.js 15, output:standalone)                    │
│ /r/[slug]              page restaurant (SSR + ISR 60s)          │
│ /r/[slug]/book         page booking (SSR, deep-link)            │
│ /restaurants/[city]    page locale (noindex si <5 restos)       │
│ /sitemap.xml           sitemap dynamique                        │
│ /robots.txt            robots.txt dynamique                     │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTPS JSON (no Clerk, no auth)
┌────────────────────────┴────────────────────────────────────────┐
│ apps/api (Fastify 5) — module connect/                          │
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

| Flag                                  | Rôle                                                                                                                             | Défaut |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `connectPublished` (ExposureSettings) | autorise page publique + réservation web                                                                                         | false  |
| `connectAgentic` (ExposureSettings)   | autorise JSON-LD `ReserveAction` + OAI-SearchBot + deep-link `source=`                                                           | false  |
| `agenticOptIn` (Restaurant)           | **requis pour qu'une page existe** (voir ci-dessous), et source de `acceptsReservations` ; piloté par le toggle MCP du dashboard | false  |

3 prédicats calculés :

- `canPublicPageRender` = `connectPublished && slug && publishedAt && agenticOptIn`
- `canWebBookingWork` = `connectPublished && acceptsReservations && publishedAt`
- `canAgenticMetadataExpose` = `connectPublished && connectAgentic`

> **Correction du 2026-09-21** — `agenticOptIn` figurait ici comme « legacy, non
> utilisé », et `canPublicPageRender` était documenté sans lui. C'était faux : la
> page Connect est une surface de réservation, donc un restaurant qui n'accepte
> pas les réservations n'a pas de page (`connect.routes.test.ts` ›
> « retourne 404 si agenticOptIn=false »). Comme le sitemap et les listes de
> villes n'appliquaient que deux ou trois conditions, une fiche publiée dont MCP
> était désactivé restait annoncée aux crawlers tout en répondant 404 : le
> sitemap promettait des URL mortes. L'invariant est désormais déclaré une seule
> fois dans `apps/api/src/modules/connect/connect.types.ts`
> (`PUBLIC_CONNECT_WHERE` + `isPublicConnectPage`) et réutilisé par le sitemap,
> les pages villes et la page détail. Toute modification de la règle se fait là.

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

1. `20260624000001_connect_columns_restaurant` — colonnes nullable
2. `20260624000002_connect_backfill` — Chez Suppernote → Lyon/69001/FR
3. `20260624000003_connect_restaurant_images` — table `RestaurantImage`

**Schéma `prisma` étendu** :

- `Restaurant` : + `description`, `city`, `country`, `postalCode`,
  `coverImageUrl`, `publishedAt`, relation `images[]`
- `RestaurantExposureSettings` : + `connectPublished`, `connectAgentic`,
  `connectPublishedAt`, `connectDescription`
- `Reservation` : + `source` (String?)
- Nouveau modèle `RestaurantImage` (Cascade delete, index `isCover,position`)

**Vérifications** :

- `prisma generate` ✅ (exit 0)
- `pnpm typecheck` global ✅ (api, dashboard, widget, database, types, shared)

**État** : `migrate deploy` **effectué le 2026-06-24** (4 migrations appliquées : 3 Suppernote Connect + `20260623225209_add_customer_call_activity_fields`). Backfill Chez Suppernote → Lyon/69001/FR OK. `prisma generate` + `typecheck` API + `prisma db seed` verts (cf. Journal 2026-06-24 17:01).

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
- ❌ Ne pas activer `connectAgentic` dans le seed
- ❌ Ne pas mettre de faux restos en prod
- ❌ Ne pas utiliser `reservation_audit_log` comme table analytics

## Liens

- Spec v1.1 : `docs/connect-v1.1.md`
- Runbook transversal : `docs/runbook.md`
- Spec agentic-reservations v3.2 (réutilisation moteur) : `docs/sokar-mcp-agentic-reservations-v3.2.md`
- Module API (à venir) : `apps/api/src/modules/connect/`
- App publique (à venir) : `apps/connect/`
