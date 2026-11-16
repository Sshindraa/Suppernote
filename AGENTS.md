---
description: Sokar project context for Hermes CLI agents
---

# Suppernote Agent Context

Suppernote (formerly Sokar; private workspace packages use `@suppernote/*` and production still uses `/opt/sokar`) is a French-first restaurant platform: reservations on every channel (phone, web, widget, AI assistants via MCP), service organisation (floor plan, Service Copilot) and customer relationship (CRM, loyalty, gift cards, experiences). The AI voice agent is one feature, not the product definition. Brand: "Le chef de rang numérique de votre restaurant" (`packages/shared/src/brand.ts`); product scope and readiness: `docs/PROJECT_MAP.md#ce-quest-sokar`.
Keep this file short. Detailed docs are in `docs/runbooks/` and `docs/architecture/`.

## Stack

- Monorepo: pnpm 10.8 + Turbo, Node 20.9+, TypeScript 5.8.
- API: `apps/api` — Fastify 5, Prisma 6, Redis, BullMQ, Telnyx.
- Dashboard: `apps/dashboard` — Next.js 16 App Router, React 19, Tailwind 3, Shadcn UI, Lucide.
- Connect / Widget: `apps/connect` + `apps/widget` — Next.js, standalone/export.
- Packages: `packages/database`, `packages/config`, `packages/shared`.
- Voice: Telnyx Media Stream, ElevenLabs Scribe Realtime STT, Cartesia TTS.

## Structure

```text
sokar/
├── apps/
│   ├── api/              # Fastify backend
│   ├── dashboard/        # Next.js dashboard (Clerk)
│   ├── connect/          # Public site / widget
│   └── widget/           # Embeddable widget
├── packages/
│   ├── database/         # Prisma schema
│   ├── config/           # Shared config
│   └── shared/           # Shared utilities
├── docs/
│   ├── runbooks/         # Ops, deployment, env, tests
│   └── architecture/     # Domain architecture
└── scripts/              # Deployment & ops
```

## How to work

1. Check whether the feature/file already exists before adding new code.
2. Prefer boring explicit TypeScript over clever abstractions.
3. Never make breaking API/schema changes without explicit user confirmation.
4. Never commit secrets. Use env vars (`key_env` = secrets loaded from environment only, never from code), not plaintext keys.
5. Before saying done, run the smallest relevant verification: tests, build, lint, curl, or typecheck.
6. Git can be unstable on this Mac when multiple IDEs are open. Before bulk git ops, inspect active git/IDE processes and prefer scoped staging.
7. Session start: read the **`## TODOs actifs` section only** of `docs/obsidian/Context.md` (`sed -n '/^## TODOs actifs/,/^## Décisions récentes/p' docs/obsidian/Context.md`) plus the **last ~3 entries of `docs/obsidian/Journal.md`** (`tail -3`). Open the rest of `Context.md` only when you need a past decision, and never `cat` a whole vault file: these are append-only logs and reading them in full costs tens of thousands of tokens. The vault is cross-session memory; AGENTS.md is repo-specific, the vault is the running log.
8. After any significant change (architecture, schema, provider, feature flag, API route, decision, legacy removal), update the vault. Do not wait to be asked. Append a dated entry to `docs/obsidian/Journal.md` (the full log). Touch `docs/obsidian/Context.md` only for a TODO or a current-state change, and only with a decision — **never** an activity entry, which belongs in `Journal.md`. Keep `Context.md` under ~8 Ko; `scripts/quality/check-vault-size.sh` warns at pre-push.
9. After committing a change on a working branch, run `pnpm pr:submit`: it pushes the branch and creates or reuses its PR. It enables squash auto-merge: the PR merges by itself once the required checks are green (`PR_NO_AUTO_MERGE=1 pnpm pr:submit` to keep it open for review, e.g. DB migration, payment, auth). Never push directly to `main` (GitHub branch protection refuses it anyway).

## Token budget

These rules cut cost without cutting quality: if a rule would hide information you need, quality wins.

1. **One task per session, ~2 h max.** Past ~2 h, or when the task changes, append a handoff to `docs/obsidian/Journal.md` (done / next / key files / open questions) and start a fresh session. Don't cut mid-debug; don't resume a finished session for new work.
2. **Cap shell output, then target.** For output that can exceed ~50 lines, use `| tail -n 50` (errors, tests, builds) or `| head -n 50` (listings), `grep -n`, `git diff --stat`. Read files by range (`sed -n 'A,Bp'`), not whole. If the capped output is not enough, re-read exactly the useful part (`grep -n -C 5`, another range): never conclude from incomplete output.
3. **Targeted tests while iterating, full check before done.** While iterating, test only the changed file or package (`pnpm --filter <pkg> test -- <path> 2>&1 | tail -n 40`). Before saying done or pushing, run the full verification from "How to work".

## Commands

```zsh
# Node (>=20.9 <23, strict via .npmrc)
pnpm node:check

# Dev / build / test
pnpm dev        # API + dashboard dev
pnpm build      # production build
pnpm test       # Vitest
pnpm lint       # turbo lint + stylelint
pnpm lint:css   # guard CSS dashboard
pnpm test:e2e   # Playwright dashboard
pnpm test:visual # visual regression

# Database
pnpm db:push    # sync schema
pnpm db:seed    # create demo restaurant "Chez Sokar"
pnpm db:studio  # Prisma Studio

# Agent
hermes          # interactive agent
hermes -z "task" # one-shot task
pnpm pr:submit  # push branch, create or reuse its PR, squash auto-merge when CI is green
```

## Code conventions

- Prettier: `semi=true`, `singleQuote=true`, `trailingComma=all`, `printWidth=100`.
- API: Fastify plugins, Zod validation where applicable, typed Prisma calls.
- Prisma: keep migrations/schema changes explicit; verify generated client when schema changes.
- Queues/cache: BullMQ + Redis; make retries/idempotency explicit.
- French copy: `vous` everywhere, never `tu` (user-facing). Test `onboarding-tone.test.ts` enforces this.

## Code Review Rules

Read by Codex Code Review and by human reviewers. These complement CI (Prettier, stylelint, Tailwind tokens, `onboarding-tone.test.ts`, gitleaks); they do not replace it.

### Integration surfaces

Do not rename or remove anything consumed outside the repo: public routes and response fields in `apps/api`, the widget embed contract, MCP tool schemas, analytics event names.
Safe path: additive change, or a new versioned route/tool.

### Secrets

No key, token or credential in plaintext, including in a script, a test fixture or an example.
Safe path: environment variable (`key_env`), documented in `docs/runbooks/environment.md`.

### Database

No destructive operation and no `db push` against a remote database without explicit confirmation.
Safe path: review the diff with `prisma migrate diff --from-url --to-schema-datamodel --script`, check for `DROP`/`TRUNCATE`, back up first.

### Demo data

A seed or fixture must never be able to publish fake listings to a remote database.
Safe path: guard on the `DATABASE_URL` host, explicit opt-in for a remote target.

### PII

No personal data (phone number, name, address) in logs, Sentry extras or analytics events.
Safe path: `redactPii()`.

## Dashboard constraints

- Tailwind colors must use design tokens (`bg-background`, `text-muted-foreground`, `border-border`). No arbitrary hex classes.
- Shadcn UI from `@/components/ui/*`; icons from `lucide-react`; class composition via `cn()`.
- Components must handle loading, empty, error, and data states.
- Layouts should be spacious (`p-6`/`p-8`) and responsive at iPad width.
- Interactive elements should include `transition-all duration-200`.
- Marketing pages should stay static when possible (`○`, not `ƒ`).
- See `docs/architecture/dashboard.md` for the full style and CSS rules.
- Public site pages (home, feature, SEO, pricing): read `docs/architecture/marketing-site.md` first. The home page is the only visual reference.

## Security & deployment

- **Staging:** deploys automatically after a green CI and its smoke tests.
- **Production:** autonomous deployment is authorized once CI and staging are green. Keep the release snapshot, health checks and rollback path; flag any DB migration, payment, auth, voice, or critical config change in commentary, but do not wait for a separate confirmation.
- **Rollback:** application rollback restores artefacts only by default. Add `--with-db-rollback` to `scripts/deploy.sh --env prod|staging rollback` to also restore the Postgres backup timestamped in the release directory. See `docs/runbooks/rollback.md`.
- **Deploy account:** privileged operations use `/usr/local/sbin/sokar-deploy-root`. The `deploy` account is not in `sudo` or `docker` groups.
- **Secrets:** never commit secrets. Use env vars (`key_env` convention = secrets live in environment variables, never in code).

## Where to look

- **Project map:** `docs/PROJECT_MAP.md` — architecture, flux, points sensibles.
- **Vault (Obsidian):** `docs/obsidian/` — `Context.md` (current state), `Journal.md` (chronological log), `Architecture.md`, `API Endpoints.md`, `Sokar Connect P0.md`, `Telnyx Pipeline.md`. Mounted via `OBSIDIAN_VAULT_PATH` in Hermes.
- **Runbooks:** `docs/runbooks/` — staging, deployment, rollback, environment, tests, migration.
- **Architecture:** `docs/architecture/` — dashboard, voice, plus product specs in `docs/*.md`.
- **Specs:** `docs/gift-cards-spec.md`, `docs/floor-plan-spec.md`, `docs/connect-v1.1.md`, `docs/sokar-mcp-agentic-reservations-v3.2.md`.

## Environment

- **Dev:** `.env.local` (root), `packages/database/.env`, per-app `.env`.
- **Staging:** `https://staging.suppernote.com` / `api-staging.suppernote.com` on VPS `sokar`.
- **Prod:** `https://suppernote.com` / `api.suppernote.com` on VPS `sokar`.
- One `.env` per app, no `.env.prod`. `NEXT_PUBLIC_*` is baked at build time.
- See `docs/runbooks/environment.md` for details.

## Agent skills

### Issue tracker

GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
