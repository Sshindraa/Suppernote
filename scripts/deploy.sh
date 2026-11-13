#!/usr/bin/env bash
# Script de déploiement unifié Suppernote (prod + staging).
#
# Usage:
#   bash scripts/deploy.sh --env prod --confirm-production [branch]
#   bash scripts/deploy.sh --env prod --confirm-production rollback [--with-db-rollback] [release-timestamp]
#   bash scripts/deploy.sh --env staging [branch]
#   bash scripts/deploy.sh --env staging --dry-run
#   bash scripts/deploy.sh --env staging --force
#   bash scripts/deploy.sh --env staging --force-build
#   bash scripts/deploy.sh --env staging rollback [--with-db-rollback] [release-timestamp]
#   bash scripts/deploy.sh --help
#
# Ce script remplace scripts/deploy-vps.sh (prod) et scripts/deploy-staging.sh (staging).
# La logique commune est dans scripts/ops/deploy-common.sh.
#
# Zero-downtime : les trois services restent en ligne pendant la compilation.
# Dashboard et Suppernote Connect sont construits dans des dossiers .next-deploy-*
# puis basculés seulement après les validations. Le redémarrage final est
# limité à quelques secondes.
#
# Release dirs: snapshot des artefacts avant/après build dans
# $RELEASES_DIR/. Rollback instantané si build échoue ou sur commande.
#
# NOTE: Si ce script casse, les anciens scripts sont récupérables via:
#   git show <commit>:scripts/deploy-vps.sh > /tmp/deploy-vps.sh
#   git show <commit>:scripts/deploy-staging.sh > /tmp/deploy-staging.sh

set -Eeuo pipefail

# ── Variables par défaut ─────────────────────────────────
DEPLOY_ENV=""
CONFIRM_PRODUCTION=false
DRY_RUN=false
FORCE=false
FORCE_BUILD=false
BRANCH="main"
COMMAND="deploy"
WITH_DB_ROLLBACK=false
TARGET_RELEASE=""
PRIVILEGED_WRAPPER="/usr/local/sbin/sokar-deploy-root"
WAIT_TIMEOUT=${WAIT_TIMEOUT:-60}

# ── Source libs ──────────────────────────────────────────
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ops/logging.sh
source "$SCRIPT_DIR/ops/logging.sh"
# shellcheck source=ops/db-backup.sh
source "$SCRIPT_DIR/ops/db-backup.sh"
# shellcheck source=ops/deploy-common.sh
source "$SCRIPT_DIR/ops/deploy-common.sh"

# ── Aide ─────────────────────────────────────────────────
print_usage() {
    cat <<'EOF'
Usage: bash scripts/deploy.sh --env prod|staging [options] [command] [branch]

Environments:
  --env prod       Déploiement production (/opt/sokar)
  --env staging    Déploiement staging (/opt/sokar-staging)

Commands:
  deploy           Déploiement complet (défaut)
  rollback         Rollback vers la release précédente (ou spécifiée)

Options:
  --confirm-production   Requis pour --env prod (safety check)
  --dry-run              Simulation (staging only — pas de restart ni migrations)
  --force                Ignore les modifications locales trackées (staging only)
  --force-build          Force le rebuild de tous les apps même si le hash est inchangé
                         (utile quand le cache .next/ est stale). Fonctionne en prod + staging.
  --with-db-rollback     Rollback inclut la restauration DB (avec rollback)
  --help, -h             Affiche cette aide

Examples:
  bash scripts/deploy.sh --env prod --confirm-production
  bash scripts/deploy.sh --env prod --confirm-production rollback
  bash scripts/deploy.sh --env prod --confirm-production rollback --with-db-rollback
  bash scripts/deploy.sh --env prod --confirm-production rollback 20260726T194319Z
  bash scripts/deploy.sh --env staging
  bash scripts/deploy.sh --env staging --dry-run
  bash scripts/deploy.sh --env staging --force-build
  bash scripts/deploy.sh --env staging rollback
EOF
}

# ── Parse args ───────────────────────────────────────────
parse_deploy_args "$@"

# ── Validation env ───────────────────────────────────────
validate_deploy_env

DATE=$(date '+%Y-%m-%d %H:%M:%S')

# ── Lock anti-déploiements concurrents ───────────────────
# Placé après le source des libs (pour log_error) et avant toute opération.
LOCK_FILE="/tmp/sokar-deploy-${DEPLOY_ENV}.lock"
exec 200>"$LOCK_FILE"
if ! flock -n 200; then
    log_error "Un déploiement ${DEPLOY_ENV} est déjà en cours (lock: $LOCK_FILE)"
    exit 1
fi

# ── Validation flags (prod) ──────────────────────────────
if [ "$DEPLOY_ENV" = "prod" ] && [ "$CONFIRM_PRODUCTION" != true ]; then
    log_error "Confirmation production requise : relancez avec --confirm-production." >&2
    exit 2
fi

# Le gel des chantiers 199/299 est une porte technique, pas seulement une
# convention documentaire. Les rollbacks restent autorisés. Une promotion
# production peut utiliser un profil scoped explicitement déclaré, qui ne
# requiert que ses portes CLOSED et vérifie que les flags différés restent
# désactivés ; sans profil, toutes les portes doivent être CLOSED.
if [ "$DEPLOY_ENV" = "prod" ] && [ "$COMMAND" = "deploy" ]; then
    if ! DEPLOY_ENV="$DEPLOY_ENV" node "$SOKAR_ROOT/scripts/verify-product-gates.mjs"; then
        log_error "Déploiement production refusé : le profil de release ou ses portes ne sont pas valides."
        exit 3
    fi
fi

# ══════════════════════════════════════════════════════════
# Commande ROLLBACK
# ══════════════════════════════════════════════════════════
if [ "$COMMAND" = "rollback" ]; then
    handle_rollback
    exit 0
fi

# ══════════════════════════════════════════════════════════
# Commande DEPLOY
# ══════════════════════════════════════════════════════════
log_section "Suppernote ${DEPLOY_ENV^} Deploy $DATE"
log info "Root: $SOKAR_ROOT"
log info "Branch: $BRANCH"
[ "$DRY_RUN" = true ] && log warn "Mode: DRY-RUN (pas de restart ni migrations)"

# ── 1. Hostname check ────────────────────────────────────
# Vérifier qu'on est sur le VPS (accepte pmbtc et sokar — transition FRA VPS)
HOSTNAME=$(hostname)
if [ "$HOSTNAME" != "sokar" ] && [ "$HOSTNAME" != "pmbtc" ]; then
    log_error "Ce script s'exécute uniquement sur le VPS (sokar/pmbtc)"
    exit 1
fi

cd "$SOKAR_ROOT"
ensure_privileged_wrapper

# ── 2. Swap check ────────────────────────────────────────
# Le VPS a 4GB RAM ; sans swap les builds Next.js sont tués par OOM (exit 137).
if ! swapon --show | grep -q swapfile 2>/dev/null; then
    log_error "Aucun swap détecté. Les builds Next.js seront tués par OOM."
    log info "   Lance d'abord (en root) : sudo bash scripts/ops/setup-swap.sh"
    exit 1
fi

# ── 3. Cert check (prod only) ────────────────────────────
if [ "$HAS_CERT_CHECK" = true ]; then
    if ! sudo "$PRIVILEGED_WRAPPER" check-cert "$DEPLOY_ENV"; then
        log_error "Certificat origine absent. Lance d'abord :"
        log info "   sudo bash scripts/_archive/setup-origin-tls.sh"
        exit 1
    fi
fi

# ── 4. Node check ────────────────────────────────────────
log info "🔍 Checking Node version..."
if ! pnpm node:check; then
    log_error "Node version check failed. Use Node >=20 <23 (see .nvmrc)." >&2
    exit 1
fi

# ── 5. Git status check ──────────────────────────────────
if [ "$FORCE" = true ]; then
    log_warn "--force : reset des modifications locales trackées..."
    git checkout -- .
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
    log_error "Fichiers suivis modifiés sur le VPS ${DEPLOY_ENV}. Refus de les stasher automatiquement."
    if [ "$DEPLOY_ENV" = "staging" ]; then
        log info "   Relancez avec --force pour ignorer."
    fi
    git status --short
    exit 1
fi

UNTRACKED_FILES=$(git ls-files --others --exclude-standard)
if [ -n "$UNTRACKED_FILES" ]; then
    log_warn " Fichiers non suivis conservés sur le VPS :"
    printf '%s\n' "$UNTRACKED_FILES" | sed 's/^/   /'
fi

# ── 6. Snapshot pré-build + backup DB (skip si DRY_RUN) ──
if [ "$DRY_RUN" = false ]; then
    PREV_TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')-pre"
    PREV_RELEASE="$RELEASES_DIR/$PREV_TIMESTAMP"
    install -d -m 0755 "$RELEASES_DIR"
    log info ""
    log info "📦 Snapshot pré-build (rollback safety net)..."
    snapshot_artifacts "$PREV_RELEASE" "pre-build"
    # Le pré-build décrit le dernier déploiement réussi, pas le checkout déjà synchronisé.
    snapshot_dependencies "$PREV_RELEASE" "$(cat "$RELEASES_DIR/.latest-hash" 2>/dev/null || true)"
    backup_db "$PREV_RELEASE"

    # Variable globale pour le trap ERR
    RESTORE_ON_FAIL="$PREV_RELEASE"
fi

# ── 7. Trap ERR + recover_services (skip si DRY_RUN) ─────
if [ "$DRY_RUN" = false ]; then
    trap recover_services ERR
fi

# ── 8. Free memory (LocalStack si prod) ──────────────────
log info ""
log info "📦 Freeing memory before build..."

# Dashboard et Connect restent servis pendant le build : les nouveaux
# artefacts sont écrits dans des dossiers isolés puis activés atomiquement.
log info "   Dashboard + Connect restent en ligne pendant la compilation..."

if [ "$HAS_LOCALSTACK" = true ]; then
    # Stop LocalStack (libère ~420MB)
    log info "   Stopping LocalStack..."
    sudo "$PRIVILEGED_WRAPPER" stop-localstack "$DEPLOY_ENV" 2>/dev/null || true
fi

# PM2 tourne désormais comme deploy → plus de caches root-owned.
# ── Cache webpack persistant ──────────────────────────────────
# On NE détruit PAS .next/cache/ : c'est le cache webpack qui permet
# les incremental builds (3 min → ~1 min sur le compile). On ne supprime
# que les artefacts de build (standalone, server, static, BUILD_ID).
# Les caches root-owned (legacy PM2 root) sont nettoyés avec sudo.

FREE_BEFORE=$(free -m | awk '/^Mem:/ {print $4}')
log info "   Memory free: ${FREE_BEFORE}MB"

# ── 9. Pull code + re-exec ───────────────────────────────
log info ""
log info "📦 Pulling latest code${DEPLOY_ENV:+ from $BRANCH}..."
PREV_HASH=$(git rev-parse HEAD 2>/dev/null || log info "")
if [ "$DRY_RUN" = true ]; then
    # Dry-run : on construit le checkout tel quel. Un pull ici échoue sur le
    # checkout snapshot du VPS et modifierait l'arbre que la simulation doit lire.
    NEW_HASH=$(git rev-parse HEAD)
    log info "   Dry-run : aucun git pull, build du checkout courant ($NEW_HASH)"
elif [ "${SOKAR_SKIP_GIT_PULL:-0}" = "1" ]; then
    NEW_HASH=$(git rev-parse HEAD)
    log info "   Git pull skipped: source snapshot already synchronized ($NEW_HASH)"
else
    git checkout "$BRANCH"
    git pull origin "$BRANCH"
    NEW_HASH=$(git rev-parse HEAD)
fi

# ── 9a. Re-exec si le script lui-même a été modifié ──────
# Bash charge le script en mémoire au démarrage. Si le git pull met à jour
# deploy.sh, la version en cours d'exécution est l'ANCIENNE. On re-exec
# pour charger la nouvelle version (une seule fois, tracée par SOKAR_REEXECED).
if [ "${SOKAR_REEXECED:-0}" != "1" ] && [ "$PREV_HASH" != "$NEW_HASH" ]; then
    if git diff --name-only "$PREV_HASH" "$NEW_HASH" 2>/dev/null | grep -qE '^scripts/deploy\.sh$'; then
        log info "   📎 deploy.sh mis à jour par le pull — re-exec pour charger la nouvelle version..."
        export SOKAR_REEXECED=1
        exec bash "$0" --env "$DEPLOY_ENV" \
            $([ "$CONFIRM_PRODUCTION" = true ] && echo "--confirm-production") \
            $([ "$DRY_RUN" = true ] && echo "--dry-run") \
            $([ "$FORCE" = true ] && echo "--force") \
            $([ "$FORCE_BUILD" = true ] && echo "--force-build") \
            $([ "$WITH_DB_ROLLBACK" = true ] && echo "--with-db-rollback") \
            "$BRANCH"
    fi
fi

# ── 10. Detect changed apps ──────────────────────────────
# Compare le hash actuel avec le hash du dernier déploiement réussi.
# Si un app n'a pas changé, on skip son build (gain ~5 min sur le dashboard).
LAST_DEPLOYED_HASH=$(cat "$RELEASES_DIR/.latest-hash" 2>/dev/null || echo "")
detect_changed_apps "$LAST_DEPLOYED_HASH" "$NEW_HASH"

# ── 10a. --force-build : bypass le skip basé sur le hash ─
# Utile quand le cache .next/ est stale mais le hash git est inchangé.
if [ "$FORCE_BUILD" = true ]; then
    log_warn "--force-build : rebuild de tous les apps (hash skip bypassé)"
    SKIP_ALL_BUILDS=false
    NEED_DASHBOARD=true
    NEED_CONNECT=true
    NEED_API=true
    NEED_PACKAGES=true
    NEED_INSTALL=true
    NEED_PRISMA=true
fi

# ── 11. Install deps (conditionnel) ──────────────────────
if [ "$SKIP_ALL_BUILDS" = true ]; then
    log info ""
    log info "⏭️  Skip pnpm install (aucun changement de code)"
elif [ "$NEED_INSTALL" = true ]; then
    log info ""
    log info "📦 Installing dependencies..."
    pnpm install --frozen-lockfile
else
    log info ""
    log info "⏭️  Skip pnpm install (lockfile inchangé)"
fi

# ── 12. validate_env_files (staging only) ────────────────
if [ "$DEPLOY_ENV" = "staging" ]; then
    validate_env_files

    # La configuration est validée avant toute préparation de release ; une
    # erreur ne doit jamais interrompre Dashboard ou Connect.
    log info ""
    log info "📦 Freeing memory before build..."
    log info "   Staging Dashboard + Connect restent en ligne..."

    FREE_BEFORE=$(free -m | awk '/^Mem:/ {print $4}')
    log info "   Memory free: ${FREE_BEFORE}MB"
fi

# ── 13. Env files check (prod) ───────────────────────────
if [ "$DEPLOY_ENV" = "prod" ]; then
    # Env files critiques — fail fast si absent (silence = app démarre sans config)
    REQUIRED_ENV_FILES=(
        "apps/api/.env"
        "apps/dashboard/.env"
        "apps/connect/.env"
    )
    OPTIONAL_ENV_FILES=(
        "infra/.env"
    )

    for env_file in "${REQUIRED_ENV_FILES[@]}"; do
        if [ ! -f "$env_file" ]; then
            log_error "Env file manquant : $env_file — l'app correspondante démarrera sans config."
            log info "   Créez-le sur le VPS avec les valeurs de prod (voir apps/api/.env.example du repo)."
            FAIL_MISSING_ENV=1
        else
            chmod 0600 "$env_file"
        fi
    done
    for env_file in "${OPTIONAL_ENV_FILES[@]}"; do
        [ -f "$env_file" ] && chmod 0600 "$env_file"
    done
    if [ "${FAIL_MISSING_ENV:-0}" = "1" ]; then
        exit 1
    fi
fi

# ── 14. Prisma generate (conditionnel) ───────────────────
if [ "$SKIP_ALL_BUILDS" = true ] || [ "$NEED_PRISMA" = false ]; then
    log info ""
    log info "⏭️  Skip Prisma generate (schema inchangé)"
else
    log info ""
    log info "📦 Generating Prisma client..."
    NODE_OPTIONS="--max-old-space-size=1536" pnpm --filter @suppernote/database generate
fi

# ── 15. Build (incrémental) ──────────────────────────────
if [ "$SKIP_ALL_BUILDS" = true ]; then
    log info ""
    log info "⏭️  Skip tous les builds (hash inchangé)"
else
    log info ""
    log info "📦 Building..."

    # Phase 1 : packages + API (séquentiel — dépendances)
    build_packages_api "$NEED_PACKAGES" "$NEED_API"

    # Phase 2 : dashboard + connect en parallèle (si les deux sont nécessaires).
    build_dashboard_connect "$NEED_DASHBOARD" "$NEED_CONNECT"
fi

# ── 16. Copy static assets to standalone ─────────────────
if [ "$SKIP_ALL_BUILDS" = true ]; then
    log info ""
    log info "⏭️  Skip copy-static (aucun rebuild)"
else
    log info ""
    log info "📦 Copying static assets to standalone..."
    copy_static "$NEED_DASHBOARD" "$NEED_CONNECT"
fi

# ── 17. DB backup + migrations (skip si DRY_RUN) ─────────
if [ "$DRY_RUN" = true ]; then
    log info ""
    log info "⏭️  Skip DB migrations (dry-run)"
elif [ "$SKIP_ALL_BUILDS" = true ]; then
    log info ""
    log info "⏭️  Skip DB backup + migrations (aucun changement de code)"
elif [ "$NEED_PRISMA" = false ]; then
    # Des fichiers de code ont changé mais pas le schema/migrations → pas besoin de backup
    log info ""
    log info "⏭️  Skip DB backup (aucune migration Prisma modifiée)"
else
    apply_migrations "$NEED_PRISMA"
fi

# ── 18. Nginx install (skip si DRY_RUN) ──────────────────
if [ "$DRY_RUN" = true ]; then
    log info ""
    log info "⏭️  Skip Nginx install (dry-run)"
else
    install_nginx
fi

# ── 19. Logrotate (prod only) ────────────────────────────
if [ "$HAS_LOGROTATE" = true ] && [ "$DRY_RUN" = false ]; then
    log info ""
    log info "📦 Installing logrotate..."
    sudo "$PRIVILEGED_WRAPPER" install-runtime "$DEPLOY_ENV"
fi

# Activer les dossiers Next.js préparés seulement après une copie complète des
# assets, les migrations et la validation Nginx.
if [ "$DRY_RUN" = false ] && [ "$SKIP_ALL_BUILDS" = false ]; then
    log info ""
    log info "📦 Activating validated Next.js releases..."
    activate_next_builds
elif [ "$DRY_RUN" = true ] && [ "$SKIP_ALL_BUILDS" = false ]; then
    # Un dry-run ne doit laisser ni release temporaire ni modification des
    # fichiers de configuration générés par Next.js.
    cleanup_next_build_dirs
fi

# ── 20. Restart services (skip si DRY_RUN) ───────────────
if [ "$DRY_RUN" = true ]; then
    log info ""
    log info "⏭️  Skip PM2 restart (dry-run)"
    log info ""
    log_ok "Dry-run terminé — build OK, aucun changement appliqué"
    exit 0
fi

restart_services

# ── 21. Health checks ────────────────────────────────────
health_checks

# ── 22. Résultat + snapshot post-build ───────────────────
if [ "$EXTENDED_HEALTH_CHECKS" = true ]; then
    # Prod : checks étendus
    if [ "${DEPLOY_HEALTH_REGRESSED:-false}" = true ]; then
        if [ "$DRY_RUN" = false ]; then
            recover_services 1
        fi
        exit 1
    elif [ "${DEPLOY_HEALTH_OK:-false}" = true ]; then
        log info ""
        log_ok "Deploy complete — API + dashboard + Suppernote Connect + routing OK"
        notify "✅ Suppernote ${DEPLOY_ENV} deploy OK (branch ${BRANCH}, hash $(git rev-parse --short HEAD))"
        trap - ERR

        # ── Snapshot post-build réussi + cleanup ─────────
        # Skip le snapshot si rien n'a été rebuild (les artefacts sont identiques
        # à la release précédente — pas besoin d'un nouveau snapshot).
        if [ "$SKIP_ALL_BUILDS" = true ]; then
            log info ""
            log info "⏭️  Skip snapshot post-build (aucun changement)"
        else
            NEW_TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
            NEW_RELEASE="$RELEASES_DIR/$NEW_TIMESTAMP"
            log info ""
            log info "📦 Snapshot post-build (release $NEW_TIMESTAMP)..."
            snapshot_artifacts "$NEW_RELEASE" "deploy-ok"
            snapshot_dependencies "$NEW_RELEASE" "$(git rev-parse HEAD)"
            echo "$NEW_TIMESTAMP" > "$RELEASES_DIR/.latest"
            cleanup_releases "$KEEP_RELEASES"
        fi
        cleanup_previous_next_builds
        prune_stale_next_builds
        # Sauvegarder le hash pour le prochain déploiement incrémental
        git rev-parse HEAD > "$RELEASES_DIR/.latest-hash"

        log info ""
        log info "📦 Releases disponibles pour rollback :"
        list_releases
        log info ""
        log info "   Pour rollback : bash scripts/deploy.sh --env $DEPLOY_ENV rollback"
    else
        log info ""
        log_error "Deploy finished but routing or application checks failed"
        notify "🔴 Suppernote ${DEPLOY_ENV} deploy finished with failed checks (branch ${BRANCH})"
        if [ "$DRY_RUN" = false ]; then
            recover_services 1
        fi
        exit 1
    fi
else
    # Staging : checks simples
    if [ "${DEPLOY_HEALTH_OK:-false}" = true ]; then
        # ── Snapshot post-build réussi ───────────────────
        NEW_TIMESTAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
        NEW_RELEASE="$RELEASES_DIR/$NEW_TIMESTAMP"
        log info ""
        log info "📦 Snapshot post-build (release $NEW_TIMESTAMP)..."
        snapshot_artifacts "$NEW_RELEASE" "deploy-ok"
        snapshot_dependencies "$NEW_RELEASE" "$(git rev-parse HEAD)"
        echo "$NEW_TIMESTAMP" > "$RELEASES_DIR/.latest"

        # Cleanup old releases (garde KEEP_RELEASES)
        cleanup_releases "$KEEP_RELEASES"

        cleanup_previous_next_builds
        prune_stale_next_builds

        # ── Résultat ─────────────────────────────────────
        log info ""
        log_ok "Staging deploy complete — API + Dashboard + Connect OK"
        log info "   URLs : https://staging.suppernote.com (dashboard)"
        log info "          https://api-staging.suppernote.com (API)"
        log info "   Rollback : bash scripts/deploy.sh --env staging rollback"
        notify "✅ Suppernote staging deploy OK (branch ${BRANCH}, hash $(git rev-parse --short HEAD))"
        # Sauvegarder le hash pour le prochain déploiement incrémental
        git rev-parse HEAD > "$RELEASES_DIR/.latest-hash"
        trap - ERR
    fi
fi
