# Suppernote — Guide de Démarrage

> **Vault Obsidian** : `/Users/hamza/Projects/Sokar/docs/obsidian/`
> **Dernière mise à jour** : 2026-06-24
> **Statut** : vault ré-activé après rétro-documentation des 5 semaines
> 2026-05-22 → 2026-06-23 (cf. [[Journal]]).

Ce vault centralise la documentation vivante du projet Suppernote. Il est
versionné avec le code, donc toute modif passe par `write_file` /
`patch` (skill `obsidian` Hermes).

---

## Architecture

Suppernote est un monorepo (pnpm workspace + Turborepo) de la plateforme
restaurant Suppernote : réservations multicanal, organisation du service et relation client
(l’assistant vocal IA en est une fonction).

- **Backend API** : Fastify 5 + Prisma 6 + Redis + BullMQ + Telnyx
- **Dashboard** : Next.js 15 (App Router) + React 19 + Tailwind 3 — privé, Clerk auth
- **Widget B2B** : Next.js 15, port 4001, `output: 'export'`, Cloudflare CDN
- **Suppernote Connect** : Next.js 15, port 4002, `output: 'standalone'`, VPS + Nginx + Cloudflare
- **Voice Pipeline** : Telnyx (carrier), minimax-m3 via opencode-go (LLM), Cartesia Sonic 3.6 continu `sonic-3.6` (TTS)
- **Jobs Queue** : BullMQ (evening report, SMS confirmation, outbound confirm)
- **Agent IA** : Hermes CLI sur `minimax-m3` via `opencode-go` (depuis 2026-06-23)

Voir [[Architecture]] pour les détails.

## API Endpoints

L'API Fastify expose **~30 routes** réparties dans :

| Module                  | Fichier                         | Rôle                                                          |
| ----------------------- | ------------------------------- | ------------------------------------------------------------- |
| Restaurants             | `modules/restaurants/`          | CRUD + onboarding + sign-in + availability                    |
| Reservations            | `modules/reservations/`         | Création, confirmation, annulation                            |
| Calls                   | `modules/calls/`                | Historique des appels, transcripts                            |
| Customers               | `modules/customers/`            | Profil clients, VIP, loyalty                                  |
| Dashboard               | `modules/dashboard/`            | Métriques temps réel (KPIs)                                   |
| Analytics               | `modules/analytics/`            | ROI, KPIs agrégés                                             |
| Voice                   | `modules/voice/`                | Webhooks Telnyx, Scribe Pipeline, Fillers cache               |
| Agentic Reservations    | `modules/agentic-reservations/` | Core (hold/reservation/policies/audit) + MCP + OpenAI Reserve |
| Auth                    | `modules/auth/`                 | Sync Clerk                                                    |
| RGPD                    | `modules/rgpd/`                 | Identity verification, erase, export                          |
| Admin                   | `modules/admin/`                | Flags, configcat, feature toggles                             |
| Suppernote Connect (T2) | `modules/connect/` (à créer)    | Pages publiques, JSON-LD, hold/confirm web                    |
| Pilot                   | `modules/pilot/`                | KPIs internes pilote                                          |

Voir [[API Endpoints]] pour la doc exhaustive (générée depuis le code).

## Database Schema

Prisma 6 + PostgreSQL. Modèles actifs (cf. `packages/database/prisma/schema.prisma`) :

- **Restaurant** — Établissement, slug, cuisineType, priceRange, ambiance, dietary, lat/lng, agenticOptIn, exposureSettings, **Suppernote Connect fields** (description, city, country, postalCode, coverImageUrl, publishedAt)
- **Reservation** — channel (PHONE/WEB/MCP/OPENAI_RESERVE/ADMIN/API), state machine (PENDING/CONFIRMED/SEATED/HONORED/CANCELLED/NO_SHOW/FAILED/EXPIRED), **source** (Google/ChatGPT/Perplexity/etc.), idempotency scoped
- **Call** — Transcript, intent, outcome, latencies, carrier (telnyx)
- **Customer** — Phone, name, visitCount, loyaltyScore, isVip
- **AgenticHold** — Quote 5min / Hold 7min, partial unique index `one_active_hold_per_slot`
- **RestaurantExposureSettings** — mcpEnabled, openaiReserveEnabled, **connectPublished**, **connectAgentic**, etc.
- **CustomerConsent** — Structured RGPD consents, channel-scoped
- **ReservationAuditLog** — Append-only state transitions
- **IdentityVerificationOtp** + **SignedTokenUsage** — Three-token pattern (RGPD)
- **RestaurantImage** — Galerie photos (Suppernote Connect)
- Tables legacy : AgentPersonality, CallQuota, LatencyTrace, IdempotencyRecord, AgentClient

> User/Session/Account/Verification : supprimées du schema Prisma (Clerk gère 100%).

## Notes principales du vault

| Note                                | Rôle                                                |
| ----------------------------------- | --------------------------------------------------- | ----------------------------- |
| [[Context]]                         | Décisions récentes, TODOs actifs, dernière activité |
| [[Journal]]                         | Log chronologique des tâches Hermes                 |
| [[Architecture]]                    | Stack globale, monorepo                             |
| [[Telnyx Pipeline]]                 | ai_config, machine à états, webhooks                |
| [[Scribe Pipeline Media Stream]]    | Pipeline Scribe custom + barge-in                   |
| [[Fillers Audio]]                   | Cache RAM + Redis pour silences LLM                 |
| [[Sokar Connect P0                  | Suppernote Connect P0]]                             | Spec phase 0 + tickets T1-T10 |
| [[API Endpoints]]                   | Routes Fastify exhaustives                          |
| [[Session Telnyx Debug 2026-06-10]] | Post-mortem bugs Telnyx + clés API                  |

Notes legacy (Vapi, Sprint 1, stubs, Git Auto-Commit) : retirées du vault lors de la migration Desktop → Projects.

## Liens externes

- Spec Suppernote Connect v1.1 : `docs/connect-v1.1.md`
- Spec agentic-reservations v3.2 : `docs/sokar-mcp-agentic-reservations-v3.2.md`
- Runbook transversal : `docs/runbook.md`
- Audit migration P0 : `docs/sokar-mcp-p0-migration-audit.md`
- Guide intégrateurs externes (Claude/ChatGPT/Mistral) : `docs/sokar-mcp-integrator-guide.md`
- Automation Hermes : `docs/hermes-automation.md`
