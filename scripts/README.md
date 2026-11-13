# Scripts Suppernote

Ce dossier contient uniquement les entrées d'exploitation et les helpers
réutilisables du monorepo. Les procédures ponctuelles et historiques sont
conservées dans [`docs/archive/operations/`](../docs/archive/operations/).

## Entrées publiques

Ces chemins sont stables et peuvent être appelés depuis la CI, les runbooks ou
les commandes `package.json` :

- `deploy.sh` — déploiement unifié (`--env prod|staging`) avec releases, snapshots et rollback.
- `ops/deploy-common.sh` — librairie partagée sourcée par `deploy.sh` (fonctions communes prod + staging).
- `ops/test-deploy-common.sh` — fixture locale d'activation/rollback des releases Next.js.
- `precommit-review.sh` — garde-fous secrets et code dangereux avant commit.
- `prepush-quality-gate.sh` — vérifications ciblées avant push.
- `agent/submit-pr.sh` — pousse la branche et crée ou réutilise sa PR, sans activer l'auto-merge.

## Organisation

- `build/` — helpers Next.js (`copy-static.sh`, `guard-next-build.sh`).
- `database/` — sauvegarde, restauration et test de restauration PostgreSQL/R2.
- `ops/` — installation et exploitation VPS, watchdog, TLS, staging et R2.
- `quality/` — diagnostics locaux utilisés par les hooks.
- `agent/` — outils d'automatisation pour les agents IA.
- `_archive/` — scripts one-time déjà exécutés, conservés pour référence (voir `_archive/README.md`).

Les diagnostics manuels voix/MCP et dogfood vivent sous `tools/diagnostics/` ;
les requêtes SQL d'audit et d'urgence vivent sous `infra/sql/`.

## Règle d'ajout

Avant d'ajouter un script, vérifier si une commande `package.json`, une tâche CI
ou un runbook suffit. Un nouveau script doit être réutilisable, avoir un
propriétaire (`build`, `database`, `ops`, `quality` ou `agent`)
et être référencé ici ou dans son runbook.
