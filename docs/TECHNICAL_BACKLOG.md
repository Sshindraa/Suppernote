# Technical Backlog

> Phase 4 — Priorisation des résultats des audits (Sécurité, Réservations/Paiements, Déploiement/Infra, Qualité/Tests).

> **Statut : HISTORIQUE / CLÔTURÉ — vérifié le 12 septembre 2026.**
> Tous les éléments de cet audit sont marqués `Corrigé`. Ce fichier est une preuve de clôture,
> pas le backlog actif. Pour les chantiers courants, consulter
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md), les audits datés dans `docs/audits/` et
> [`roadmap-produit-crm-marketing-199-299.md`](./roadmap-produit-crm-marketing-199-299.md).

## Chantier en cours — Renommage sokar → suppernote

- **Palier 1 terminé (24-25/11/2026)** : staging renommé le 24/11 (09:21Z), prod le 24/11 (~11:09Z), `main` 967b12f5 déployé en prod le 25/11. Couvre : chemins serveur (`/opt`, `/var/log`, `/var/backups`, `/var/lib`, `/etc`), noms PM2, vhosts et snippets nginx, wrappers `/usr/local/sbin`, crons, logrotate, alias SSH. Le dépôt utilise uniquement les nouveaux noms ; le serveur garde des liens ancien → nouveau jusqu'au `cleanup-compat`. Runbook : [`runbooks/rename-suppernote-vps.md`](./runbooks/rename-suppernote-vps.md) (historique).
- **Restes du palier 1** : (1) `cleanup-compat` (jamais avant le 30/11, conditions §3.9 du runbook) ; (2) publication du correctif signal du script de renommage (retour arrière sur Ctrl-C/HUP/TERM, non publié : décision Hamza) ; (3) PR #796 (groupe de concurrence `deploy-prod-v2`, en attente du feu vert de Hamza), le workflow Deploy Production restant désactivé manuellement.
- **Palier 2 en attente de décision Hamza** (hostname du VPS, resté `sokar`, inclus). Occurrences réelles sur `origin/main` 967b12f5 (`git grep -I -i -E`, hors `docs/archive`, `docs/audits`, `Journal.md` ; lignes / fichiers) : `sokar` au total 2786 / 364 ; variables d'environnement `SOKAR_*` 472 / 116 (dont `SOKAR_OPERATOR_USER_IDS` 32 / 14) ; bases et rôles Postgres (`sokar`, `sokar_staging`, `sokar_api`…) 244 / 49 ; slugs `chez-sokar` 216 / 55 ; domaine `sokar.tech` 97 / 15 ; upstreams nginx et `log_format` 138 / 23 ; Cloudflare Pages `sokar-widget` 22 / 7 ; buckets R2 et remote rclone 18 / 7 ; Docker monitoring (`sokar-grafana`, `sokar-prometheus`, `sokar-monitoring`) 16 / 5 ; `job_name` Prometheus et champ de log pino `service` 12 / 7 ; package `@sokar/` 5 / 1 ; clé `localStorage` `sokar_pwa` 2 / 2. Secrets et variables GitHub à ajouter à l'inventaire au moment de la décision.
- Les chemins de fichiers cités plus bas ont été mis à jour vers les nouveaux noms (`infra/nginx/suppernote*.conf`, `scripts/ops/suppernote-deploy-root.sh`) ; le contenu historique des lignes n'a pas été réécrit.

## Règles de priorité

- **P0 — Bloquant ou risque critique** : perte de données, fuite de secrets, paiement incorrect, faille d'autorisation, production instable.
- **P1 — Important** : bug important, absence de test sur un parcours critique, déploiement fragile.
- **P2 — Amélioration** : dette technique, refactor, UX, optimisation non urgente.

**Légende des statuts :**

- `Corrigé` — le fix est dans `main`.
- `Non corrigé` — à traiter.

_Classification proposée, chaque item doit être re-vérifié avant exécution._

---

## P0 — Bloquant ou risque critique

| ID      | Fichiers                                                                | Problème                                                              | Correction recommandée                                                                     | Test attendu                                                                                      | Statut  |
| ------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------- |
| SEC-001 | `apps/api/src/modules/whatsapp/whatsapp-webhook.routes.ts`              | Webhook WhatsApp sans vérification de signature                       | `telnyxWebhookGuard` en preHandler                                                         | Test unitaire payload signé / invalidé                                                            | Corrigé |
| SEC-002 | `apps/api/src/modules/agentic-reservations/mcp/oauth.ts`                | Rate limiting OAuth en `Map` mémoire (non distribué)                  | Migrer `oauthRateMap` vers Redis avec TTL                                                  | `oauth.integration.test.ts`                                                                       | Corrigé |
| SEC-003 | `apps/api/src/main.ts`                                                  | `trustProxy: true` sans validation des IPs proxy                      | `TRUSTED_PROXY_IPS` limité à `127.0.0.1`, `::1`, IP VPS                                    | Test de `req.ip` avec proxy non fiable                                                            | Corrigé |
| RES-001 | `apps/api/src/main.ts` + `agentic-reservations/workers/expire-*`        | Workers d'expiration non importés / scheduling non appelé             | Importer workers, appeler `scheduleHoldExpiration` / `scheduleQuoteExpiration`             | Test expiration end-to-end                                                                        | Corrigé |
| RES-002 | `apps/api/src/modules/floor-plan/table-allocation.service.ts`           | Allocation de tables non atomique                                     | `SELECT FOR UPDATE SKIP LOCKED` sur `floor_plan_tables`                                    | Test d'allocation concurrente                                                                     | Corrigé |
| RES-003 | `apps/api/src/modules/gift-cards/gift-card.service.ts`                  | Aucun remboursement cartes cadeaux                                    | Endpoint admin + Stripe Refunds + audit log                                                | Test de remboursement                                                                             | Corrigé |
| RES-004 | `apps/api/src/modules/agentic-reservations/core/reservation.service.ts` | Consommation du hold sans `SELECT FOR UPDATE`                         | Verrouiller le hold dans la transaction                                                    | `reservation.service.test.ts`                                                                     | Corrigé |
| DEP-001 | `scripts/database/backup-postgres.sh` + `infra/cron`                    | Pas de backup automatisé de `sokar_staging`                           | Script + cron staging + rétention 7 jours                                                  | Test end-to-end backup                                                                            | Corrigé |
| DEP-002 | `apps/api/.env.staging.example` + `scripts/ops/setup-staging.sh`        | Password `password` par défaut                                        | `CHANGE_ME_PASSWORD` + validation setup                                                    | `setup-staging.sh` dry-run                                                                        | Corrigé |
| QUA-001 | `packages/shared/src/jsonld.ts` + `apps/connect/src/lib/jsonld.tsx`     | `buildPublicRestaurantJsonLd` centralisé dans `@suppernote/shared`    | Re-exporté par `apps/connect/src/lib/jsonld.tsx`                                           | `packages/shared/src/__tests__/jsonld.test.ts` + `apps/connect/src/lib/__tests__/jsonld.test.tsx` | Corrigé |
| RES-006 | `apps/api/src/modules/gift-cards/gift-card.service.ts`                  | Application carte cadeau sans verrou (possibilité de sur-utilisation) | `SELECT FOR UPDATE` sur `GiftCard` + `CHECK remainingAmount >= 0`                          | `gift-card.service.test.ts`                                                                       | Corrigé |
| DEP-005 | `infra/ecosystem*.config.js`                                            | PM2 sans health checks                                                | `min_uptime`, `wait_ready` + `listen_timeout`, `kill_timeout`, `exp_backoff_restart_delay` | `node -e` + `apps/api` tests                                                                      | Corrigé |

---

## P1 — Important

| ID      | Fichiers                                                                                                               | Problème                                                               | Correction recommandée                                                                                                      | Test attendu                                   | Statut  |
| ------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| SEC-004 | `apps/api/src/plugins/rate-limit.ts` + `modules/rgpd/rgpd.routes.ts`                                                   | Rate limit global 100 req/min sans distinction des endpoints sensibles | `config.rateLimit` sur `/api/rgpd/{request-verification,confirm-verification,confirm-link,erase,export,withdraw-marketing}` | `rgpd.rate-limit.test.ts`                      | Corrigé |
| SEC-005 | `apps/api/src/main.ts` + `env.ts` + `test/test.routes.ts`                                                              | Routes de test protégées uniquement par `NODE_ENV`                     | `ENABLE_TEST_ROUTES` explicite + default false                                                                              | `test.routes.guard.test.ts`                    | Corrigé |
| SEC-006 | `apps/api/src/shared/observability/observability.routes.ts` + `env.ts`                                                 | `/metrics` public sans auth                                            | Auth basique (METRICS*BASIC_AUTH*\*) ou allowlist IP (METRICS_ALLOWLIST_IPS)                                                | `observability.routes.test.ts`                 | Corrigé |
| SEC-007 | `apps/api/src/modules/agentic-reservations/mcp/auth.ts` + `env.ts`                                                     | Fallback `AGENT_DEV_KEY` basé sur `NODE_ENV`                           | `ENABLE_DEV_AUTH` explicite + default false + `AGENT_DEV_KEY` dans `env.ts`                                                 | `auth.test.ts` + `mcp.server.test.ts`          | Corrigé |
| SEC-008 | `apps/api/src/modules/connect/connect.routes.ts` + `connect.types.ts`                                                  | Mix `.parse()` et `.safeParse()`                                       | Toutes les routes `.safeParse()` + gestion 400                                                                              | `connect.routes.test.ts`                       | Corrigé |
| RES-005 | `apps/api/src/shared/queue/queues.ts` + `modules/agentic-reservations/workers/idempotency-purge.worker.ts` + `main.ts` | `purgeExpired()` non appelé par un cron                                | Queue `idempotency-purge` + scheduler quotidien 04h + worker supprimant `expiresAt < now`                                   | `idempotency-purge.worker.test.ts`             | Corrigé |
| RES-007 | `apps/api/src/modules/agentic-reservations/openai-reserve/signature.ts` + `openai-reserve.routes.ts` + `env.ts`        | Feed `/v1/businesses` public sans signature                            | HMAC-SHA256(base64url) optionnel via `?signature` + rate limit 10 req/min/IP                                                | `openai-reserve.routes.test.ts`                | Corrigé |
| RES-008 | `apps/api/src/modules/agentic-reservations/core/hold.service.ts`                                                       | Cleanup des holds expirés non systématique                             | Worker cron + index `(status, expiresAt)`                                                                                   | Test de cleanup                                | Corrigé |
| RES-009 | `packages/database/prisma/schema.prisma`                                                                               | Pas d'index sur `actorHash` dans `ReservationAuditLog`                 | `@@index([actorHash])` + `(event, createdAt)`                                                                               | Vérifier requêtes d'audit                      | Corrigé |
| RES-010 | `apps/api/src/modules/agentic-reservations/core/state-machine.ts`                                                      | Transitions sans validation d'invariants                               | Vérifier `tableId` non null pour `SEATED`, `startsAt` passé, etc.                                                           | Tests de transitions invalides                 | Corrigé |
| RES-011 | `packages/database/prisma/schema.prisma`                                                                               | Index partiel idempotence non visible dans Prisma                      | Commentaire dans `schema.prisma` + test de migration                                                                        | Vérifier migration                             | Corrigé |
| RES-012 | `apps/api/src/modules/gift-cards/gift-card.service.ts`                                                                 | `generateUniqueShortCode` sans retry P2002                             | `try/catch` + retry sur violation unique                                                                                    | Test de collision de code                      | Corrigé |
| RES-013 | `apps/api/src/modules/floor-plan/availability-capacity-aware.service.ts`                                               | Pas de cache Redis pour disponibilité                                  | Cache TTL court + invalidation sur mutation                                                                                 | Tests de cache                                 | Corrigé |
| DEP-003 | `scripts/deploy-vps.sh` / `deploy-staging.sh`                                                                          | Rollback sans restauration DB                                          | Option `--with-db-rollback` + backup timestampé                                                                             | Test de rollback DB                            | Corrigé |
| DEP-004 | `scripts/deploy-staging.sh`                                                                                            | Vérification `git diff` après `git pull`                               | Vérifier avant le pull, option `--force`                                                                                    | Test de déploiement avec modifications locales | Corrigé |
| DEP-007 | `scripts/deploy-vps.sh` / `deploy-staging.sh`                                                                          | `sleep 8` après `pm2 restart`                                          | Boucle `/health` + `/livez` avec timeout configurable                                                                       | Test de déploiement                            | Corrigé |
| DEP-008 | `scripts/ops/setup-staging.sh`                                                                                         | `.env` copiés sans validation des placeholders                         | `validate_env_files()` dans `deploy-staging.sh`                                                                             | Test de validation `.env`                      | Corrigé |
| DEP-009 | `infra/nginx/suppernote-staging.conf`                                                                                  | Pas de `limit_req` en staging                                          | Copier/adapter les zones de prod                                                                                            | Test de rate limit Nginx                       | Corrigé |
| QUA-002 | `apps/api/src/modules/voice/__tests__/`                                                                                | 17 tests voice cassés (mocks obsolètes)                                | Session dédiée pour mettre à jour les mocks                                                                                 | Voice tests passants                           | Corrigé |
| QUA-003 | `apps/dashboard/src/app/dashboard/reservations/page.tsx` + `components/gift-cards/gift-card-list.tsx`                  | `@ts-ignore` date-fns                                                  | Résoudre résolution types date-fns                                                                                          | Typecheck dashboard                            | Corrigé |
| QUA-004 | `apps/api/src/modules/rgpd/erasure.service.ts`                                                                         | `@ts-expect-error` sur `Call.customerPhone`                            | Vérifier schema Prisma + type guard                                                                                         | Typecheck API                                  | Corrigé |
| QUA-005 | `apps/api/src/modules/connect/connect.routes.ts`                                                                       | `slugifyCity` / `slugifyCuisine` locales                               | Extraire dans `@suppernote/shared` si Connect en a besoin                                                                   | Tests unitaires                                | Corrigé |

---

## P2 — Amélioration

| ID      | Fichiers                                                                         | Problème                                                   | Statut  |
| ------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| SEC-009 | `apps/api/src/modules/rgpd/identity-verification.service.ts`                     | OTP RGPD sans captcha                                      | Corrigé |
| SEC-010 | `apps/api/src/env.ts`                                                            | `localhost` dans `PROD_HOST_ALLOWLIST`                     | Corrigé |
| SEC-011 | `apps/api/src/modules/rgpd/rgpd.routes.ts`                                       | Champs `string` sans `max()`                               | Corrigé |
| SEC-012 | `apps/api/src/main.ts`                                                           | Logger redaction : secrets Stripe/SMTP/Google manquants    | Corrigé |
| SEC-013 | `apps/api/src/modules/sms/sms-inbound.routes.ts`                                 | Validation minimale du payload Telnyx                      | Corrigé |
| SEC-014 | `apps/api/src/plugins/cors.ts`                                                   | Origines CORS non validées comme URLs                      | Corrigé |
| SEC-015 | `AGENTS.md`                                                                      | Mention de `key_env` sans contexte                         | Corrigé |
| RES-014 | `apps/api/src/shared/db/transaction-options.ts`                                  | Timeout de transaction 10s peut être court                 | Corrigé |
| RES-015 | `packages/database/prisma/schema.prisma`                                         | `ReservationAuditLog` sans `correlationId`                 | Corrigé |
| DEP-006 | `infra/nginx/snippets/suppernote-cloudflare-real-ip.conf`                        | IPs Cloudflare hardcodées                                  | Corrigé |
| DEP-010 | `.env.staging.example` (API, dashboard)                                          | Patterns `pk_test_...` / `sk_test_...`                     | Corrigé |
| DEP-011 | `scripts/database/backup-postgres.sh` / `scripts/database/backup-postgres-r2.sh` | Pas de vérification d'espace disque                        | Corrigé |
| DEP-012 | `scripts/deploy-*.sh` + workflows                                                | Pas de notification d'échec                                | Corrigé |
| DEP-013 | `scripts/ops/suppernote-deploy-root.sh`                                          | Restauration nginx non garantie                            | Corrigé |
| DEP-014 | `scripts/deploy-vps.sh` / `deploy-staging.sh`                                    | Logs non structurés                                        | Corrigé |
| DEP-015 | `scripts/deploy-*.sh`                                                            | Pas de vérification de version Node                        | Corrigé |
| QUA-006 | `apps/connect/e2e/*.spec.ts`                                                     | E2E Connect skippés si API down                            | Corrigé |
| QUA-007 | `apps/api/src/modules/agentic-reservations/__tests__/concurrency.test.ts`        | `describe.skip` conditionnel `AGENTIC_INT_TESTS`           | Corrigé |
| QUA-008 | `apps/api/src`                                                                   | 559 occurrences de `any`                                   | Corrigé |
| QUA-009 | `apps/connect/src/components/gift-card/use-gift-card-flow.ts`                    | `err: any` dans catch                                      | Corrigé |
| QUA-010 | `apps/api/vitest.config.ts`                                                      | Monkey-patch `fs.readFileSync`                             | Corrigé |
| QUA-011 | `packages/config/eslint.config.mjs` + `.eslintrc.json`                           | ESLint incohérent (flat vs legacy)                         | Corrigé |
| QUA-012 | `packages/config/.stylelintrc.json`                                              | Config stylelint non centralisée                           | Corrigé |
| QUA-013 | `.prettierrc.json`                                                               | Prettier config dans `package.json`                        | Corrigé |
| QUA-014 | `apps/dashboard/src`                                                             | Tests unitaires dashboard complétés (widgets + composants) | Corrigé |
| QUA-015 | `docs/obsidian/Context.md`                                                       | tsserver lock 100% CPU                                     | Corrigé |

---

## Prochaines étapes

1. Tous les P0 sont corrigés.
2. **Valider les P1** avec le product owner / pilote avant implémentation.
3. **Ne pas traiter les P2** avant que P0 et P1 soient résolus.
4. **Mettre à jour ce fichier** à chaque correction (changer `Statut` en `Corrigé` et ajouter le test/PR).
5. **Re-auditer** après les corrections pour vérifier les non-régressions.
