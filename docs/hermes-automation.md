# Hermes automation for Suppernote

> **Status: PARTIALLY VERIFIED — repository layer checked on 12 September 2026.**
> Husky hooks, review scripts and `verify:*` commands exist in the repository. Webhook
> subscriptions, the Cloudflare tunnel and cron jobs live outside the repository and must be
> checked with the verification commands below before claiming they are active. See
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

This repo is wired for three automation layers: local quality gates, event-driven Hermes webhooks, and weekly dogfood QA.

## 1. Local quality gates

Husky hooks:

- `.husky/pre-commit` → `scripts/precommit-review.sh`
  - scans staged added lines for likely secrets
  - blocks dangerous constructs (`eval`, `Function`, shell exec patterns, `innerHTML`)
  - blocks `console.log` / `console.debug`
  - blocks arbitrary hex Tailwind color classes in `apps/dashboard`
  - runs `lint-staged` and re-stages formatted files

- `.husky/pre-push` → `scripts/prepush-quality-gate.sh`
  - forces Node 22 via `/usr/local/opt/node@22/bin`
  - runs `pnpm node:check`
  - routes verification by changed area:
    - API/database/package changes → API typecheck, lint, tests
    - dashboard changes → dashboard typecheck, lint, tests
    - workspace/CI changes → full typecheck, tests, lint

Manual commands:

```bash
pnpm verify:precommit
pnpm verify:prepush
pnpm verify:ai
```

`pnpm verify:ai` calls `scripts/agent/hermes-diff-review.sh head` for an independent Hermes review of the current diff.

## 2. Event-driven webhooks

Hermes webhook platform is enabled on the default profile:

- local health: `http://localhost:8644/health`
- public tunnel health: `https://hermes.sokar.tech/health`
- public tunnel: Cloudflare tunnel `sokar` → `hermes.sokar.tech` → `localhost:8644`
- subscriptions live in `~/.hermes/webhook_subscriptions.json`
- do not commit webhook secrets; read them locally with `hermes webhook list` only when configuring an external service

Current subscriptions:

| Name                      | Public URL                                                   | Events                        | Purpose                                 |
| ------------------------- | ------------------------------------------------------------ | ----------------------------- | --------------------------------------- |
| `sokar-github-pr-review`  | `https://hermes.sokar.tech/webhooks/sokar-github-pr-review`  | `pull_request`                | Event-driven PR review / blocker triage |
| `sokar-github-ci-alert`   | `https://hermes.sokar.tech/webhooks/sokar-github-ci-alert`   | `workflow_run`, `check_suite` | CI failure triage                       |
| `sokar-telnyx-call-alert` | `https://hermes.sokar.tech/webhooks/sokar-telnyx-call-alert` | Telnyx call events            | Voice pipeline anomaly triage           |

GitHub repo hooks are configured for the two GitHub subscriptions above. GitHub webhook pings must return HTTP 200. Telnyx still needs to be configured in the Telnyx dashboard/API with the public Telnyx URL and its subscription secret.

Verification:

```bash
curl -fsS http://localhost:8644/health
curl -fsS https://hermes.sokar.tech/health
hermes webhook list
gh api repos/Sshindraa/Sokar/hooks --jq '.[] | select(.config.url|startswith("https://hermes.sokar.tech")) | {id,events,active,last_response,url:.config.url}'
hermes webhook test sokar-github-pr-review --payload '{"action":"opened"}'
```

## 3. Weekly dogfood QA

A Hermes cron job is scheduled:

- name: `Sokar Dogfood QA — Weekly`
- schedule: Monday 08:00 Europe/Paris
- target: `https://suppernote.com`
- output: `~/Projects/Sokar/.hermes/dogfood/YYYYMMDD-HHMM/report.md`
- delivery: Telegram

Manual equivalent:

```bash
pnpm dogfood:sokar
```

The dogfood pass checks landing/pricing/navigation/CTA flows, console errors, mobile/iPad layout risks, broken links, French-first copy, and visible UI regressions.

## 4. Daily production smoke

A no-agent Hermes cron job is scheduled:

- name: `Sokar Prod Smoke — Daily`
- schedule: daily 08:30 Europe/Paris
- script: `~/.hermes/scripts/sokar_prod_smoke.sh`
- delivery: Telegram only on failure (empty stdout = silent success)

It checks:

- `https://suppernote.com/`
- `https://suppernote.com/pricing`
- `https://suppernote.com/mcp`
- `https://suppernote.com/privacy`
- `https://api.suppernote.com/health`
- `https://api.suppernote.com/.well-known/oauth-protected-resource`
- `https://api.suppernote.com/.well-known/oauth-authorization-server`
- `https://hermes.sokar.tech/health`
