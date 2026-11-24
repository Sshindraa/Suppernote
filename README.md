# Suppernote

French-first restaurant platform: reservations on every channel, service organisation and customer relationship. The AI voice agent is one of its features. See `docs/PROJECT_MAP.md`.

## Stack

- API: Fastify 5, Prisma 6, Redis, BullMQ, Telnyx.
- Dashboard: Next.js 16 App Router, React 19, Tailwind 3, Shadcn UI.
- Voice: Telnyx Media Stream, ElevenLabs Scribe Realtime STT, Cartesia TTS.
- Monorepo: pnpm 10.8, Turbo, TypeScript 5.8.

## Repository layout

```text
apps/api            Fastify API
apps/dashboard      Next.js dashboard/marketing app
apps/connect        Next.js public pages / widget embed
apps/widget         standalone reservation widget
packages/database   Prisma schema/client
packages/config     shared config
packages/shared     shared TypeScript helpers
docs                product and implementation notes
```

## Commands

```zsh
pnpm dev        # API + dashboard dev
pnpm build      # production build
pnpm test       # Vitest
pnpm lint       # lint
pnpm db:push    # Prisma db push
pnpm db:studio  # Prisma Studio
pnpm deploy:prod    # deploy main to production (VPS suppernote)
pnpm deploy:staging # deploy main to staging (VPS suppernote)
hermes          # interactive agent
hermes -z "task" # one-shot agent task
```

## Ops scripts

Les entrées d'exploitation sont regroupées dans [`scripts/README.md`](scripts/README.md).
Les procédures historiques, comme l'ancien déploiement ponctuel des cartes-cadeaux,
sont archivées sous `docs/archive/operations/` et ne constituent pas une surface de production.

## Agent context

`AGENTS.md` is the only project markdown intended to be injected into every Hermes session. Keep it compact and stable.
Detailed historical notes stay under `docs/`; old provider/IDE-orchestration notes are historical unless explicitly re-enabled.

For Hermes model/provider setup, use the live config as source of truth:

```zsh
hermes config
hermes model
hermes doctor
```
