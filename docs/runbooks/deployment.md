# Runbook — Deployment

> **Statut : ACTIF — réconcilié le 15 septembre 2026.** Staging, promotion production, snapshots,
> health checks et rollback correspondent aux workflows du dépôt. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md) et la
> [réconciliation des audits](../audits/2026-09-15-current-state.md).

## Policy

- **Staging:** deploys automatically after a green CI and its smoke tests.
- **Production:** deploys automatically once CI and staging are green (`.github/workflows/deploy-prod.yml` triggered on `Deploy Staging` success). The release snapshot, health checks and rollback path remain mandatory; DB migration, payment, auth, voice and critical configuration changes are flagged in the deployment report.
- **Roadmap hold (2026-09-13):** the full 199/299 € product chantier remains frozen until its roadmap gates and pilot evidence are closed. A scoped production release is allowed only when the manifest declares an explicit `productionRelease` profile, keeps every deferred capability disabled, and includes dated evidence. Intermediate work stays on a branch or staging until its own profile is qualified.
- **Hard gate:** `scripts/deploy.sh --env prod` runs `pnpm verify:product-gates` (via `node scripts/verify-product-gates.mjs`) before any build, migration or restart. The manifest is [`docs/release/product-gates.json`](../release/product-gates.json); `LOCAL_ONLY` entries are already delivered locally but still print their external blockers. A scoped profile checks only its required CLOSED gates, verifies the exact deferred-gate partition and rejects any deferred feature flag set to `true` in `apps/api/.env`. Without a profile, every gate must be CLOSED and `productionFreeze=false`. Rollback remains available while the freeze is active.
- Application rollback does not restore the database. See `docs/runbooks/rollback.md`.

## Unified deploy script

All deployments use `scripts/deploy.sh --env prod|staging`. The shared logic lives in `scripts/ops/deploy-common.sh` (sourced by `deploy.sh`).

### Disponibilité pendant un déploiement

Dashboard et Connect restent en ligne pendant toute la compilation Next.js.
Chaque application est construite dans un dossier `.next-deploy-*`, puis le
dossier `.next` actif est remplacé uniquement après la copie des assets, les
migrations et la validation Nginx. En cas d'échec avant la bascule, la release
actuelle continue de servir les visiteurs ; après la bascule, les health checks
peuvent restaurer automatiquement le snapshot précédent.

La bascule ne fait que repointer atomiquement le symlink `.next` : l'ancien
dossier `.next-deploy-*` reste à son chemin d'origine, car le processus PM2 en
cours a résolu son `NEXT_DIST_DIR` au démarrage. Il n'est supprimé
(`cleanup_previous_next_builds`) qu'après le redémarrage PM2 et des health
checks verts ; `cleanup_previous_next_builds` refuse de supprimer la cible
active. En prod, les health checks vérifient aussi que `/pricing` et sa
première feuille `/_next/static/css/*.css` répondent 200, sinon
`recover_services` repointe `.next` vers la release précédente
(incident du 2026-09-27 : CSS en 400 pendant ~1 min).

Le redémarrage PM2 final est limité aux applications réellement reconstruites.
Un déploiement qui ne touche qu'au Dashboard ou à Connect ne redémarre pas
l'API.

## Staging deployment

- CI/CD: `.github/workflows/deploy-staging.yml` triggered directly by the push to `main` (merge of a PR). The full CI is **not** re-run on `main`: the job `verify-ci` (`scripts/ops/verify-merged-tree-ci.mjs`) proves instead that the commit comes from a merged PR, that its Git tree is identical to the PR head, and that all six required checks on the PR head are green (pending checks are awaited up to 15 min). Optional checks such as CodeQL do not block staging. No proof, no deploy.
- Full CI on `main` remains available on demand (`gh workflow run ci.yml --ref main`) and runs every night (02:15 UTC) to catch drift. Only the secret scan runs on each push to `main`.
- If `verify-ci` fails (no merged PR, tree mismatch, or missing/failed required check), fix or rerun the required check on the PR head before retrying the deployment. Optional checks do not block staging.
- Protection of `main` must keep "Require branches to be up to date before merging" (`strict`); the script re-checks the tree identity anyway.
- GitHub secrets: `STAGING_SSH_KEY`, `STAGING_HOST`, `STAGING_USER`.
- Script on VPS: `scripts/deploy.sh --env staging`.
- Dry-run (staging only) : `deploy.sh --dry-run` ne modifie rien sur le VPS (voir la section ci-dessous).
- Déploiement manuel : lancer le workflow, jamais `git pull` à la main sur le VPS.
  ```zsh
  # Staging : relance le workflow sur main (smoke tests inclus)
  gh workflow run deploy-staging.yml --ref main
  ```
  Le checkout `/opt/sokar-staging` est un snapshot (commits `chore(staging): snapshot <sha>`, jamais poussés) : un `git pull origin main` y diverge et échoue.

## Production deployment

- CI/CD: `.github/workflows/deploy-prod.yml` triggered on `Deploy Staging` workflow success (branch `main`).
- GitHub secrets: `PROD_SSH_KEY`, `PROD_HOST`, `PROD_USER` (or reuse `STAGING_*` if same VPS).
- Script on VPS: `scripts/deploy.sh --env prod --confirm-production`.
- Redundant runs are skipped (`workflow_run` only): the job exits 0 when the triggering staging run's `head_sha` is no longer the tip of `main` (a newer run will deploy it), or when `releases/.latest-hash` already equals the target SHA. `workflow_dispatch` always deploys. Runs are serialized by the `deploy-prod` concurrency group (`cancel-in-progress: false`).
- The production smoke-test job also fetches `https://suppernote.com/pricing` and requires its CSS asset to return 200.
- Déploiement manuel (fallback, seulement si la chaîne automatique a échoué) :
  ```zsh
  # `workflow_dispatch` redéploie même si le SHA est déjà actif : vérifier releases/.latest-hash avant
  gh workflow run deploy-prod.yml --ref main
  ```
- Privileged wrapper: `/usr/local/sbin/sokar-deploy-root`.
- The `deploy` account is **not** in `sudo` or `docker` groups.

## Rollback

```zsh
# Production
ssh deploy@sokar "cd /opt/sokar && bash scripts/deploy.sh --env prod --confirm-production rollback"

# Staging
ssh deploy@sokar "cd /opt/sokar-staging && bash scripts/deploy.sh --env staging rollback"
```

## Dry-run (staging only)

```zsh
ssh deploy@sokar "cd /opt/sokar-staging && bash scripts/deploy.sh --env staging --dry-run"
```

En dry-run, le script ne fait ni `git pull` ni `checkout` (il construit le checkout courant), ne réinstalle pas `/usr/local/sbin/sokar-deploy-root` et ne migre, ne redémarre ni ne touche à Nginx. Il peut en revanche installer les dépendances et compiler dans des dossiers isolés, supprimés en fin de run. Validé le 18/10 sur staging : sortie 0, aucun changement sur le wrapper, le checkout ou la release.

## Smoke tests

- `curl /health` and `/livez` on `api-staging.suppernote.com` (staging) / `api.suppernote.com` (prod) → 200.
- `curl /dashboard` → 200 or 302 (Clerk redirect).
- `curl /` and `/restaurant/chez-sokar-demo` → 200.
- Playwright E2E functional tests on staging are blocking: Dashboard smoke plus
  the public reservation widget (including availability) and the Connect
  restaurant page. The Connect confirmation flow and gift-card purchase are
  intentionally excluded because they write business data or require the demo
  restaurant's commercial feature flag; they belong to a controlled staging
  campaign with cleanup and payment/notification checks.
- The local CI dashboard smoke uses DOM readiness for the public widget instead
  of `networkidle`; remote restaurant imagery must not turn a valid release into
  a timeout. Business assertions remain blocking.
- To rehearse the promotion gate without touching production, dispatch
  `Deploy Staging` with `force_smoke_failure=true`. The staging deploy, rollback,
  health checks and public E2E still run, then the workflow fails deliberately;
  `Deploy Production` must not start because it requires a successful staging
  workflow. Use this only as a controlled release exercise.
- Production: no Playwright E2E (too risky); curl smoke tests only.

## Post-deploy notes (production)

- `deploy.sh --env prod` builds Next.js into isolated `apps/{dashboard,connect}/.next-deploy-*` directories; the active `.next` tree is kept intact until activation.
- Les fichiers `tsconfig.json` et `next-env.d.ts` éventuellement réécrits par Next pendant un build isolé sont restaurés avant la fin du déploiement.
- If `apps/<app>/.next/standalone/apps/<app>/server.js` is missing, the script forces a rebuild of that app.
- `deploy.sh --env staging` also does incremental build detection (same logic as prod).
