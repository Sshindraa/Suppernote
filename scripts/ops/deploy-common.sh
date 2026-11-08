#!/bin/bash
set -Eeuo pipefail
# Librairie partagée pour les déploiements Sokar (prod + staging).
# Sourcée par scripts/deploy.sh avant le parsing des arguments.
#
# Variables attendues (set par deploy.sh avant d'appeler les fonctions) :
#   DEPLOY_ENV              prod | staging
#   SOKAR_ROOT              /opt/sokar | /opt/sokar-staging
#   RELEASES_DIR            $SOKAR_ROOT/releases
#   PORT_API / PORT_DASH / PORT_CONNECT
#   PM2_API / PM2_WORKERS / PM2_DASH / PM2_CONNECT
#   ECOSYSTEM_FILE          infra/ecosystem.config.js | infra/ecosystem.staging.config.js
#   NGINX_CONFIG            sokar | sokar-staging (sans .conf)
#   DB_NAME                 sokar | sokar_staging
#   KEEP_RELEASES           5 | 3
#   CONFIRM_PRODUCTION      true | false
#   DRY_RUN                 true | false
#   FORCE                   true | false
#   HAS_LOCALSTACK          true | false
#   HAS_LOGROTATE           true | false
#   HAS_CERT_CHECK          true | false
#   EXTENDED_HEALTH_CHECKS  true | false
#   BRANCH                  branche git à déployer
#   PRIVILEGED_WRAPPER      /usr/local/sbin/sokar-deploy-root
#   WAIT_TIMEOUT            timeout en secondes pour wait_for_services
#
# Fonctions exposées :
#   parse_deploy_args(args...)
#   validate_deploy_env()
#   ensure_privileged_wrapper()
#   wait_for_services(timeout)
#   snapshot_artifacts(target, label, [paths...])
#   restore_artifacts(source)
#   cleanup_releases(keep)
#   list_releases()
#   clean_stale_next_types(app)
#   clean_next_artifacts(app)
#   recover_services()
#   detect_changed_apps(last_hash, new_hash)
#   build_packages_api(need_packages, need_api)
#   build_dashboard_connect(need_dash, need_connect)
#   copy_static(need_dash, need_connect)
#   apply_migrations(need_prisma)
#   install_nginx()
#   validate_nginx_config()
#   restart_services()
#   health_checks()
#   validate_env_files()

# Build Next.js hors du dossier actif afin que les services continuent de
# répondre pendant toute la compilation. Ces variables sont réinitialisées à
# chaque déploiement et ne sont jamais persistées dans le dépôt.
NEXT_DIST_DIR_DASHBOARD="${NEXT_DIST_DIR_DASHBOARD:-}"
NEXT_DIST_DIR_CONNECT="${NEXT_DIST_DIR_CONNECT:-}"
NEXT_BUILD_CONFIG_BACKUP_DIR="${NEXT_BUILD_CONFIG_BACKUP_DIR:-}"
NEXT_PREVIOUS_DIR_DASHBOARD="${NEXT_PREVIOUS_DIR_DASHBOARD:-}"
NEXT_PREVIOUS_DIR_CONNECT="${NEXT_PREVIOUS_DIR_CONNECT:-}"
NEXT_BUILD_ACTIVATED_DASHBOARD="${NEXT_BUILD_ACTIVATED_DASHBOARD:-false}"
NEXT_BUILD_ACTIVATED_CONNECT="${NEXT_BUILD_ACTIVATED_CONNECT:-false}"
NEXT_BUILDS_ACTIVATED="${NEXT_BUILDS_ACTIVATED:-false}"

# Artefacts à snapshoter (chemins relatifs à SOKAR_ROOT)
ARTIFACT_PATHS=(
    "apps/api/dist"
    "apps/dashboard/.next"
    "apps/dashboard/public"
    "apps/connect/.next"
    "apps/connect/public"
    # Les paquets partagés sont compilés dans le même build : un rollback qui
    # restaure l'API sans eux produit une paire incompatible. Le 22 septembre
    # 2026, l'ancien `dist/env.js` d'une release restaurée appelait un symbole
    # de configuration LLM retiré du paquet config par la release suivante :
    # l'API bouclait sur « Required » et le test de rollback échouait.
    "packages/config/dist"
    "packages/database/dist"
    "packages/shared/dist"
)

ensure_privileged_wrapper() {
    # Dry-run : aucune écriture privilégiée (ni self-update, ni installation).
    if [ "${DRY_RUN:-false}" = true ]; then
        if [ -x "$PRIVILEGED_WRAPPER" ]; then
            log info "🔎 Dry-run : wrapper présent, mise à jour ignorée."
        else
            log_warn "Dry-run : wrapper absent, il ne sera pas installé en simulation."
        fi
        return 0
    fi

    if [ -x "$PRIVILEGED_WRAPPER" ]; then
        log info "🔄 Mise à jour du wrapper privilégié..."
        if sudo -n "$PRIVILEGED_WRAPPER" self-update "$DEPLOY_ENV" >/dev/null 2>&1; then
            log_ok "Wrapper mis à jour."
        else
            log_warn "self-update indisponible ou échoué ; le wrapper existant sera utilisé."
        fi
    else
        log info "📦 Installation initiale du wrapper privilégié..."
        sudo install -o root -g root -m 0755 \
            "$SOKAR_ROOT/scripts/ops/sokar-deploy-root.sh" "$PRIVILEGED_WRAPPER"
    fi
}

# Attendre que les services soient up (health + livez), timeout configurable
wait_for_services() {
    local timeout=${1:-$WAIT_TIMEOUT}
    local WAIT_START WAIT_NOW API_HEALTH API_LIVEZ DASH_READY CONNECT_READY
    log info ""
    log info "⏳ Waiting for ${DEPLOY_ENV} services to be ready (timeout ${timeout}s)..."
    WAIT_START=$(date +%s)
    while true; do
        API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_API}/health" 2>/dev/null || echo "000")
        API_LIVEZ=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_API}/livez" 2>/dev/null || echo "000")
        DASH_READY=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_DASH}" 2>/dev/null || echo "000")
        CONNECT_READY=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_CONNECT}/restaurant/chez-sokar-demo" 2>/dev/null || echo "000")
        if [ "$API_HEALTH" = "200" ] && [ "$API_LIVEZ" = "200" ] && [ "$DASH_READY" = "200" ] && [ "$CONNECT_READY" = "200" ]; then
            log info "   API (health + livez) + Dashboard + Connect ready"
            break
        fi
        WAIT_NOW=$(date +%s)
        if [ $((WAIT_NOW - WAIT_START)) -ge "$timeout" ]; then
            log_warn "Timeout (health=$API_HEALTH livez=$API_LIVEZ dash=$DASH_READY connect=$CONNECT_READY)"
            break
        fi
        sleep 2
    done
}

# ── Helpers release dirs ─────────────────────────────────
# snapshot_artifacts <target> <label> [paths...]
# Si paths est omis, utilise ARTIFACT_PATHS (tous les apps).
# Si paths est fourni (ex. "apps/dashboard/.next apps/dashboard/public"),
# ne snapshot que ces apps — utile pour le snapshot pré-build quand
# seul un app a été rebuild.
snapshot_artifacts() {
    local target="$1"
    local label="${2:-snapshot}"
    shift 2
    local paths=("$@")
    if [ ${#paths[@]} -eq 0 ]; then
        paths=("${ARTIFACT_PATHS[@]}")
    fi
    log info "   → Snapshot artefacts vers $target ($label)"
    install -d -m 0755 "$target"
    for p in "${paths[@]}"; do
        local source="$SOKAR_ROOT/$p"
        local destination="$target/$p"
        if [ -e "$source" ]; then
            install -d -m 0755 "$target/$(dirname "$p")"
            if [ -L "$source" ]; then
                # `.next` peut être un symlink vers la release active. On
                # dereference uniquement ce lien de premier niveau, tout en
                # conservant les symlinks pnpm internes du standalone.
                local resolved_source
                resolved_source="$(readlink "$source")"
                if [[ "$resolved_source" != /* ]]; then
                    resolved_source="$(cd "$(dirname "$source")" && cd "$resolved_source" && pwd)"
                fi
                install -d -m 0755 "$destination"
                cp -a "$resolved_source"/. "$destination"/
            else
                cp -a "$source" "$target/$(dirname "$p")/"
            fi
        fi
    done
    # Metadata
    {
        echo "timestamp=$(basename "$target")"
        echo "label=$label"
        echo "date=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        echo "git_hash=$(cd "$SOKAR_ROOT" && git rev-parse HEAD 2>/dev/null || echo 'unknown')"
        echo "git_branch=$(cd "$SOKAR_ROOT" && git branch --show-current 2>/dev/null || echo 'unknown')"
    } > "$target/META"
}

# Le rollback restaure les artefacts, pas node_modules. Sans le lockfile et les
# package.json de la release restaurée, pnpm réinstalle les dépendances de la
# version courante et l'ancien code ne démarre pas (module manquant).
snapshot_dependencies() {
    local target="$1"
    local commit="$2"
    if [ -z "$commit" ]; then
        log_warn "   Pas de commit connu : dépendances non sauvegardées pour $target"
        return 0
    fi
    local manifests
    manifests="$(cd "$SOKAR_ROOT" && git ls-tree -r --name-only "$commit" \
        | grep -E '^(pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|(apps|packages)/[^/]+/package\.json)$' || true)"
    if [ -z "$manifests" ]; then
        log_warn "   Aucun lockfile dans $commit : dépendances non sauvegardées pour $target"
        return 0
    fi
    install -d -m 0755 "$target/deps"
    # shellcheck disable=SC2086 # liste de chemins, un par ligne, sans espaces
    (cd "$SOKAR_ROOT" && git archive --format=tar "$commit" $manifests) | tar -x -C "$target/deps"
}

restore_release_manifests() {
    local source="$1"
    (cd "$source/deps" && tar -cf - .) | (cd "$SOKAR_ROOT" && tar -xf -)
}

restore_artifacts() {
    local source="$1"
    shift
    local paths=("$@")
    if [ ${#paths[@]} -eq 0 ]; then
        paths=("${ARTIFACT_PATHS[@]}")
    fi
    if [ ! -d "$source" ]; then
        log_error "Release $source introuvable" >&2
        return 1
    fi
    log info "   → Restore artefacts depuis $source"
    for p in "${paths[@]}"; do
        if [ -e "$source/$p" ]; then
            rm -rf "$SOKAR_ROOT/$p"
            install -d -m 0755 "$SOKAR_ROOT/$(dirname "$p")"
            cp -a "$source/$p" "$SOKAR_ROOT/$(dirname "$p")/"
        fi
    done
}

cleanup_releases() {
    local keep="${1:-$KEEP_RELEASES}"
    local count
    count=$(ls -1 "$RELEASES_DIR" 2>/dev/null | grep -E '^[0-9]{8}T[0-9]{6}Z' | sort -r | wc -l)
    if [ "$count" -le "$keep" ]; then
        return
    fi
    log info "   → Nettoyage releases (garde $keep sur $count)"
    ls -1 "$RELEASES_DIR" 2>/dev/null \
        | grep -E '^[0-9]{8}T[0-9]{6}Z' \
        | sort -r \
        | tail -n +"$((keep + 1))" \
        | while read -r old; do
            rm -rf "$RELEASES_DIR/$old"
            log info "     supprimé: $old"
        done
}

list_releases() {
    log info "Releases disponibles (plus récent en premier) :"
    ls -1 "$RELEASES_DIR" 2>/dev/null \
        | grep -E '^[0-9]{8}T[0-9]{6}Z' \
        | sort -r \
        | while read -r ts; do
            local meta="$RELEASES_DIR/$ts/META"
            local hash="" branch=""
            if [ -f "$meta" ]; then
                hash=$(grep '^git_hash=' "$meta" | cut -d= -f2- | cut -c1-8)
                branch=$(grep '^git_branch=' "$meta" | cut -d= -f2-)
            fi
            printf "   %s  %s  %s\n" "$ts" "${hash:-????????}" "${branch:-?}"
        done
}

# Supprime les types générés par le build précédent. `tsconfig.json` inclut
# `.next/types/**` et `.next/dev/types/**` : une page supprimée depuis laisse un fichier de
# types qui l'importe, et le type-check du build suivant échoue sur ce fichier fantôme
# (staging 26/10/2026, après la suppression de /widget/[slug] dans Connect). Next les
# régénère à chaque build ; le serveur en production ne les lit jamais.
clean_stale_next_types() {
    local app="$1"
    local app_dir="$SOKAR_ROOT/apps/$app"
    rm -rf "$app_dir/.next/types" "$app_dir/.next/dev/types" \
        || log warn "   Types générés de $app non supprimés (droits ?) : le type-check peut échouer."
}

clean_next_artifacts() {
    local app="$1"
    local app_dir="$SOKAR_ROOT/apps/$app"
    if [ -d "$app_dir/.next" ]; then
        rm -rf "$app_dir/.next/standalone" "$app_dir/.next/server" "$app_dir/.next/static" "$app_dir/.next/types"
        rm -f "$app_dir/.next/BUILD_ID"
        rm -rf "$app_dir"/.next/eslint*
        find "$app_dir/.next" -maxdepth 1 -name '*.nft.json' -delete
        find "$app_dir/.next/server" -name '*.nft.json' -delete 2>/dev/null || true
    fi
}

# Next réécrit parfois tsconfig.json et next-env.d.ts lorsqu'un distDir
# différent de `.next` est utilisé. Les sauvegarder évite de laisser le dépôt
# de production modifié après un build et garantit que les chemins redeviennent
# corrects après la bascule atomique.
backup_next_build_configs() {
    NEXT_BUILD_CONFIG_BACKUP_DIR="$(mktemp -d /tmp/sokar-next-config.XXXXXX)"
    for app in dashboard connect; do
        for file in tsconfig.json next-env.d.ts; do
            if [ -f "$SOKAR_ROOT/apps/$app/$file" ]; then
                cp -a "$SOKAR_ROOT/apps/$app/$file" \
                    "$NEXT_BUILD_CONFIG_BACKUP_DIR/${app}-${file}"
            else
                touch "$NEXT_BUILD_CONFIG_BACKUP_DIR/.absent-${app}-${file}"
            fi
        done
    done
}

restore_next_build_configs() {
    if [ -z "${NEXT_BUILD_CONFIG_BACKUP_DIR:-}" ] || [ ! -d "$NEXT_BUILD_CONFIG_BACKUP_DIR" ]; then
        return 0
    fi
    for app in dashboard connect; do
        for file in tsconfig.json next-env.d.ts; do
            local backup="$NEXT_BUILD_CONFIG_BACKUP_DIR/${app}-${file}"
            if [ -f "$backup" ]; then
                cp -a "$backup" "$SOKAR_ROOT/apps/$app/$file"
            elif [ -f "$NEXT_BUILD_CONFIG_BACKUP_DIR/.absent-${app}-${file}" ]; then
                rm -f "$SOKAR_ROOT/apps/$app/$file"
            fi
        done
    done
    rm -rf "$NEXT_BUILD_CONFIG_BACKUP_DIR"
    NEXT_BUILD_CONFIG_BACKUP_DIR=""
}

cleanup_next_build_dirs() {
    for app in dashboard connect; do
        local dist_dir=""
        if [ "$app" = dashboard ]; then
            dist_dir="${NEXT_DIST_DIR_DASHBOARD:-}"
        else
            dist_dir="${NEXT_DIST_DIR_CONNECT:-}"
        fi
        if [ -n "$dist_dir" ] && [[ "$dist_dir" == .next-deploy-* ]]; then
            rm -rf "$SOKAR_ROOT/apps/$app/$dist_dir"
        fi
    done
    restore_next_build_configs
}

# Remplace atomiquement le symlink `<app_dir>/.next` par `<target>` (rename(2)
# via `mv -T` sur le VPS Linux ; repli `ln -sfn` pour les fixtures macOS).
swap_next_symlink() {
    local app_dir="$1" target="$2"
    local tmp_link="$app_dir/.next-swap-$$"
    rm -f "$tmp_link"
    ln -s "$target" "$tmp_link" || return 1
    if mv -Tf "$tmp_link" "$app_dir/.next" 2>/dev/null; then
        return 0
    fi
    rm -f "$tmp_link"
    ln -sfn "$target" "$app_dir/.next"
}

# Expose les dossiers `.next-deploy-*` via un symlink `.next` uniquement après
# compilation et validation. Le serveur standalone conserve ainsi le distDir
# sérialisé par Next.js tout en permettant un changement atomique de cible.
activate_next_builds() {
    local stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
    local app dist_dir active_dir previous_dir app_dir active_target
    local activated_dashboard=false
    local activated_connect=false

    for app in dashboard connect; do
        if [ "$app" = dashboard ]; then
            dist_dir="${NEXT_DIST_DIR_DASHBOARD:-}"
        else
            dist_dir="${NEXT_DIST_DIR_CONNECT:-}"
        fi
        [ -n "$dist_dir" ] || continue
        active_dir="$SOKAR_ROOT/apps/$app/.next"
        previous_dir="$SOKAR_ROOT/apps/$app/.next-previous-$stamp-$app"

        if [ ! -f "$SOKAR_ROOT/apps/$app/$dist_dir/standalone/apps/$app/server.js" ]; then
            log_error "Build $app invalide : server.js standalone introuvable."
            restore_activated_next_builds
            return 1
        fi
        if [ ! -e "$active_dir" ]; then
            log_error "Dossier .next actif introuvable pour $app."
            restore_activated_next_builds
            return 1
        fi

        app_dir="$SOKAR_ROOT/apps/$app"
        if [ -L "$active_dir" ]; then
            active_target="$(readlink "$active_dir")"
            case "$active_target" in
                .next-deploy-*) ;;
                *)
                    log_error "Symlink .next inattendu pour $app : $active_target"
                    restore_activated_next_builds
                    return 1
                    ;;
            esac
            # Le processus PM2 en cours a résolu son distDir au démarrage
            # (NEXT_DIST_DIR=.next-deploy-...) : ce dossier doit rester intact,
            # à son chemin d'origine, jusqu'au redémarrage sur la nouvelle release
            # et à la réussite des health checks (incident 2026-09-27, CSS en 400).
            # On ne fait donc que basculer le symlink, de façon atomique.
            previous_dir="$app_dir/$active_target"
            if ! swap_next_symlink "$app_dir" "$dist_dir"; then
                restore_activated_next_builds
                return 1
            fi
        else
            # Ancien format (.next réel, sans symlink) : déplacement nécessaire.
            rm -rf "$previous_dir"
            mv "$active_dir" "$previous_dir"
            if ! ln -s "$dist_dir" "$active_dir"; then
                rm -f "$active_dir"
                mv "$previous_dir" "$active_dir" 2>/dev/null || true
                restore_activated_next_builds
                return 1
            fi
        fi

        if [ "$app" = dashboard ]; then
            NEXT_PREVIOUS_DIR_DASHBOARD="$previous_dir"
            NEXT_BUILD_ACTIVATED_DASHBOARD=true
            activated_dashboard=true
        else
            NEXT_PREVIOUS_DIR_CONNECT="$previous_dir"
            NEXT_BUILD_ACTIVATED_CONNECT=true
            activated_connect=true
        fi
    done

    if [ "$activated_dashboard" = true ] || [ "$activated_connect" = true ]; then
        NEXT_BUILDS_ACTIVATED=true
    else
        NEXT_BUILDS_ACTIVATED=false
    fi
    restore_next_build_configs
}

restore_activated_next_builds() {
    local app previous_dir active_dir app_dir
    for app in dashboard connect; do
        if [ "$app" = dashboard ]; then
            previous_dir="${NEXT_PREVIOUS_DIR_DASHBOARD:-}"
        else
            previous_dir="${NEXT_PREVIOUS_DIR_CONNECT:-}"
        fi
        [ -n "$previous_dir" ] || continue
        app_dir="$SOKAR_ROOT/apps/$app"
        active_dir="$app_dir/.next"
        [ -e "$previous_dir" ] || continue
        case "${previous_dir##*/}" in
            .next-deploy-*)
                # Release précédente restée en place : on repointe le symlink.
                swap_next_symlink "$app_dir" "${previous_dir##*/}"
                ;;
            *)
                rm -rf "$active_dir"
                mv "$previous_dir" "$active_dir"
                ;;
        esac
    done
    NEXT_PREVIOUS_DIR_DASHBOARD=""
    NEXT_PREVIOUS_DIR_CONNECT=""
    NEXT_BUILD_ACTIVATED_DASHBOARD=false
    NEXT_BUILD_ACTIVATED_CONNECT=false
    NEXT_BUILDS_ACTIVATED=false
}

# À appeler uniquement après restart PM2 + health checks OK : supprime la
# release Next précédente. Ne supprime jamais la cible actuelle de `.next`.
cleanup_previous_next_builds() {
    local app previous_dir active_target
    for app in dashboard connect; do
        if [ "$app" = dashboard ]; then
            previous_dir="${NEXT_PREVIOUS_DIR_DASHBOARD:-}"
        else
            previous_dir="${NEXT_PREVIOUS_DIR_CONNECT:-}"
        fi
        [ -n "$previous_dir" ] || continue
        active_target="$(readlink "$SOKAR_ROOT/apps/$app/.next" 2>/dev/null || true)"
        if [ -n "$active_target" ] && [ "${previous_dir##*/}" = "$active_target" ]; then
            log_warn " $app : $previous_dir est la release active, conservée."
            continue
        fi
        rm -rf "$previous_dir"
    done
    NEXT_PREVIOUS_DIR_DASHBOARD=""
    NEXT_PREVIOUS_DIR_CONNECT=""
}

# Supprime les vieux dossiers `.next-deploy-*` : `cleanup_previous_next_builds` ne connaît que
# la release précédente, donc quand `.next` n'était pas un lien symbolique (staging) chaque
# déploiement laissait ~750 Mo par application (46 Go et 90 % du disque le 2026-09-30).
# Garde les $1 plus récents (défaut 2) et la cible active de `.next`. Les noms portent
# l'horodatage UTC : le tri par nom est le tri par date.
prune_stale_next_builds() {
    local keep="${1:-2}" app app_dir active build count
    for app in dashboard connect; do
        app_dir="$SOKAR_ROOT/apps/$app"
        active="$(readlink "$app_dir/.next" 2>/dev/null || true)"
        count=0
        while IFS= read -r build; do
            count=$((count + 1))
            if [ "$count" -le "$keep" ]; then continue; fi
            if [ "${build##*/}" = "$active" ]; then continue; fi
            rm -rf "$build"
        done < <(ls -1d "$app_dir"/.next-deploy-* 2>/dev/null | sort -r)
    done
}

# Trap ERR — remet les services en ligne après un échec de déploiement.
# Utilise RESTORE_ON_FAIL (snapshot pré-build) et les variables PM2_*.
recover_services() {
    local exit_code=${1:-$?}
    trap - ERR
    log info ""
    log_error "Déploiement ${DEPLOY_ENV} interrompu (code ${exit_code})."

    # Tant que la nouvelle release n'est pas activée, l'ancienne version est
    # toujours servie : on nettoie uniquement les artefacts temporaires.
    if [ -n "${RESTORE_ON_FAIL:-}" ] && [ -d "${RESTORE_ON_FAIL}" ]; then
        log info "   → Restore artefacts pré-build (${RESTORE_ON_FAIL##*/})..."
        if [ "${NEXT_BUILDS_ACTIVATED:-false}" = true ]; then
            pm2 stop "$PM2_DASH" "$PM2_CONNECT" 2>/dev/null || true
            restore_artifacts "${RESTORE_ON_FAIL}"
            restore_activated_next_builds
        else
            # L'API est encore le seul artefact construit en place ; restaurer
            # uniquement son dist évite de toucher aux serveurs Next actifs.
            restore_artifacts "${RESTORE_ON_FAIL}" "apps/api/dist"
        fi
    fi

    log info "   → Remise en ligne des services ${DEPLOY_ENV}..."
    if [ "${NEXT_BUILDS_ACTIVATED:-false}" = true ]; then
        pm2 restart "$PM2_API" "$PM2_WORKERS" "$PM2_DASH" "$PM2_CONNECT" 2>/dev/null \
            || pm2 resurrect 2>/dev/null \
            || true
    elif [ "${NEED_API:-false}" = true ]; then
        pm2 restart "$PM2_API" "$PM2_WORKERS" 2>/dev/null || true
    fi

    if [ "$DEPLOY_ENV" = "prod" ]; then
        log info "   Rollback Nginx vers la configuration précédente..."
        sudo "$PRIVILEGED_WRAPPER" restore-nginx "$DEPLOY_ENV"
        sudo "$PRIVILEGED_WRAPPER" reload-nginx "$DEPLOY_ENV" || true
        sudo "$PRIVILEGED_WRAPPER" start-localstack "$DEPLOY_ENV" 2>/dev/null || true
    fi

    # Nettoyer le snapshot pré-build (il n'a pas servi)
    rm -rf "${RESTORE_ON_FAIL}" 2>/dev/null || true
    cleanup_next_build_dirs
    cleanup_previous_next_builds

    log info ""
    log_error "Services ${DEPLOY_ENV} restaurés à l'état pré-build. Le déploiement a échoué."
    notify "🔴 Sokar ${DEPLOY_ENV} deploy failed (branch ${BRANCH}, exit ${exit_code})"
    exit "$exit_code"
}

# Détecte quels apps ont changé entre last_hash et new_hash.
# Set les variables globales : NEED_PACKAGES, NEED_API, NEED_DASH, NEED_CONNECT,
# NEED_INSTALL, NEED_PRISMA, SKIP_ALL_BUILDS.
detect_changed_apps() {
    local last_hash="$1"
    local new_hash="$2"

    NEED_DASHBOARD=false
    NEED_CONNECT=false
    NEED_API=false
    NEED_PACKAGES=false
    NEED_INSTALL=false
    NEED_PRISMA=false
    SKIP_ALL_BUILDS=false

    if [ -z "$last_hash" ]; then
        # Premier déploiement → build tout
        NEED_DASHBOARD=true; NEED_CONNECT=true; NEED_API=true; NEED_PACKAGES=true
        NEED_INSTALL=true; NEED_PRISMA=true
        log info "   📎 Build complet (premier déploiement)"
    elif [ "$last_hash" = "$new_hash" ]; then
        # Même hash → rien à builder, juste restart + nginx
        SKIP_ALL_BUILDS=true
        log info "   ⏭️  Hash inchangé ($new_hash) — skip tous les builds"
    else
        local changed_files
        changed_files=$(git diff --name-only "$last_hash" "$new_hash" 2>/dev/null || echo "")
        if [ -z "$changed_files" ]; then
            NEED_DASHBOARD=true; NEED_CONNECT=true; NEED_API=true; NEED_PACKAGES=true
            NEED_INSTALL=true; NEED_PRISMA=true
            if [ "$DEPLOY_ENV" = "prod" ]; then
                log info "   📎 Build complet (diff indisponible)"
            else
                log info "   📎 Build complet (diff indisponible)"
            fi
        else
            # Afficher les fichiers modifiés
            local local_count
            local_count=$(echo "$changed_files" | wc -l)
            log info "   📎 $local_count fichier(s) modifié(s) depuis $last_hash"
            echo "$changed_files" | head -10 | sed 's/^/      /'
            [ "$local_count" -gt 10 ] && log info "      ... et $((local_count - 10)) autre(s)"

            echo "$changed_files" | grep -qE '^apps/dashboard/' && NEED_DASHBOARD=true
            echo "$changed_files" | grep -qE '^apps/connect/' && NEED_CONNECT=true
            echo "$changed_files" | grep -qE '^apps/api/' && NEED_API=true
            # Config PM2 (env) et dépendances runtime de l'API : redémarrage requis.
            echo "$changed_files" | grep -qE '^(infra/ecosystem|pnpm-lock\.yaml$|package\.json$|pnpm-workspace\.yaml$)' && NEED_API=true
            # Les bundles Next embarquent les dépendances : une version changée impose de les reconstruire.
            if echo "$changed_files" | grep -qE '^(pnpm-lock\.yaml|pnpm-workspace\.yaml)$'; then
                NEED_DASHBOARD=true; NEED_CONNECT=true
            fi
            # Prisma schema/migrations changent → generate + migrate
            if echo "$changed_files" | grep -qE '^packages/database/prisma/'; then
                NEED_PRISMA=true
            fi

            # Packages non-test changent → rebuild packages et dépendants
            local non_test_pkg_files
            non_test_pkg_files=$(echo "$changed_files" | grep -E '^packages/' | grep -vE '/__tests__/' | grep -vE '\.test\.(ts|tsx|js|jsx)$' || true)
            if [ -n "$non_test_pkg_files" ]; then
                NEED_DASHBOARD=true; NEED_CONNECT=true; NEED_API=true; NEED_PACKAGES=true
            fi

            # turbo.json change → rebuild tout (pipeline/build config changed)
            if echo "$changed_files" | grep -qE '^turbo\.json'; then
                NEED_DASHBOARD=true; NEED_CONNECT=true; NEED_API=true; NEED_PACKAGES=true
            fi
            echo "$changed_files" | grep -qE '^pnpm-lock\.yaml|^package\.json' && NEED_INSTALL=true

            # Si un build précédent a nettoyé les artefacts sans rebatcher l'app,
            # on force le rebuild pour restaurer le standalone.
            if [ "$NEED_DASHBOARD" = false ] && [ ! -f "$SOKAR_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js" ]; then
                NEED_DASHBOARD=true
                log_warn "Dashboard standalone manquant — build forcé"
            fi
            if [ "$NEED_CONNECT" = false ] && [ ! -f "$SOKAR_ROOT/apps/connect/.next/standalone/apps/connect/server.js" ]; then
                NEED_CONNECT=true
                log_warn "Connect standalone manquant — build forcé"
            fi
            # Le build TypeScript de l'API doit produire l'entrée que PM2
            # démarre. Cela vaut pour les deux environnements : une release
            # restaurée ou un artefact nettoyé ne doit jamais laisser PM2
            # redémarrer un dist/main.js absent ou obsolète.
            if [ "$NEED_API" = false ] && [ ! -f "$SOKAR_ROOT/apps/api/dist/main.js" ]; then
                NEED_API=true
                log_warn "API entrypoint manquant — build forcé"
            fi

            log info "   📎 Apps à builder :$([ "$NEED_DASHBOARD" = true ] && echo ' dashboard')$([ "$NEED_CONNECT" = true ] && echo ' connect')$([ "$NEED_API" = true ] && echo ' api')"
            if [ "$NEED_DASHBOARD" = false ] && [ "$NEED_CONNECT" = false ] && [ "$NEED_API" = false ] && [ "$NEED_PACKAGES" = false ]; then
                SKIP_ALL_BUILDS=true
                log info "   ⏭️  Aucun app modifié — skip build"
            fi
        fi
    fi
}

# Build Phase 1 : packages + API (séquentiel — dépendances)
build_packages_api() {
    local need_packages="$1"
    local need_api="$2"

    # `tsconfig.json` active la compilation incrémentale : un `.tsbuildinfo`
    # périmé fait croire à `tsc` qu'un fichier déjà émis l'est encore, et un
    # fichier *nouveau* peut alors ne jamais être écrit dans `dist`. C'est ce qui
    # a fait échouer le déploiement du 22 septembre 2026 : `reservation-state.js`
    # manquait, l'API bouclait sur `MODULE_NOT_FOUND`, et le rollback laissait un
    # `dist` mixte (ancien API + nouveau package) donc un second crash.
    # Repartir d'un état incrémental propre coûte quelques secondes de build.
    find "$SOKAR_ROOT/apps" "$SOKAR_ROOT/packages" -maxdepth 2 -name 'tsconfig.tsbuildinfo' -delete 2>/dev/null || true

    if [ "$need_packages" = true ] || [ "$need_api" = true ]; then
        # config imports the shared catalogue; database imports config.
        NODE_OPTIONS="--max-old-space-size=1536" pnpm --filter @suppernote/shared build
        NODE_OPTIONS="--max-old-space-size=1536" pnpm --filter @suppernote/config build
        NODE_OPTIONS="--max-old-space-size=1536" pnpm --filter @suppernote/database build
    fi
    if [ "$need_api" = true ]; then
        # `tsc` sur l'API consomme ~2 Go de mémoire (mesuré le 27/09/2026 avec
        # --extendedDiagnostics) : avec 1536 Mo le build échouait au hasard du GC
        # (OOM, exit 134). Le VPS a ~5,7 Go disponibles pendant le build.
        NODE_OPTIONS="--max-old-space-size=3072" pnpm --filter @suppernote/api build
        if [ ! -f "$SOKAR_ROOT/apps/api/dist/main.js" ]; then
            log_error "API build terminé sans apps/api/dist/main.js (entrypoint PM2 manquant)."
            return 1
        fi
    fi
}

# Build Phase 2 : dashboard + connect (en parallèle si les deux sont nécessaires)
build_dashboard_connect() {
    local need_dash="$1"
    local need_connect="$2"

    NEXT_DIST_DIR_DASHBOARD=""
    NEXT_DIST_DIR_CONNECT=""
    if [ "$need_dash" = true ] || [ "$need_connect" = true ]; then
        backup_next_build_configs
        local build_stamp="$(date -u '+%Y%m%dT%H%M%SZ')-$$"
        if [ "$need_dash" = true ]; then
            NEXT_DIST_DIR_DASHBOARD=".next-deploy-${build_stamp}-dashboard"
            rm -rf "$SOKAR_ROOT/apps/dashboard/$NEXT_DIST_DIR_DASHBOARD"
            clean_stale_next_types dashboard
        fi
        if [ "$need_connect" = true ]; then
            NEXT_DIST_DIR_CONNECT=".next-deploy-${build_stamp}-connect"
            rm -rf "$SOKAR_ROOT/apps/connect/$NEXT_DIST_DIR_CONNECT"
            clean_stale_next_types connect
        fi
    fi

    local build_dash_cmd=""
    local build_connect_cmd=""
    if [ "$need_dash" = true ]; then
        build_dash_cmd="NODE_OPTIONS='--max-old-space-size=2048' NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_ALLOW_DEV=1 NEXT_DIST_DIR='$NEXT_DIST_DIR_DASHBOARD' SENTRY_SUPPRESS_GLOBAL_ERROR_HANDLER_FILE_WARNING=1 pnpm --filter @suppernote/dashboard build"
    fi
    if [ "$need_connect" = true ]; then
        build_connect_cmd="NODE_OPTIONS='--max-old-space-size=1024' NEXT_TELEMETRY_DISABLED=1 NEXT_BUILD_ALLOW_DEV=1 NEXT_DIST_DIR='$NEXT_DIST_DIR_CONNECT' pnpm --filter @suppernote/connect build"
    fi

    # Les services restent actifs pendant le build : les sorties sont écrites
    # dans les dossiers .next-deploy-* et ne remplacent `.next` qu'après
    # validation. Le garde-fou de build est explicitement levé ici, et jamais
    # dans les commandes de développement usuelles.

    if [ -n "$build_dash_cmd" ] && [ -n "$build_connect_cmd" ]; then
        log info "   → Lancement dashboard + connect en parallèle..."
        eval "$build_dash_cmd" &
        local dash_pid=$!
        eval "$build_connect_cmd" &
        local connect_pid=$!
        # Attendre les deux. Si l'un échoue, on kill l'autre et on fail.
        local dash_exit=0
        local connect_exit=0
        wait "$dash_pid" || dash_exit=$?
        wait "$connect_pid" || connect_exit=$?
        if [ "$dash_exit" -ne 0 ]; then
            log_error "Dashboard build échoué (exit $dash_exit)"
            kill "$connect_pid" 2>/dev/null || true
            cleanup_next_build_dirs
            exit 1
        fi
        if [ "$connect_exit" -ne 0 ]; then
            log_error "Connect build échoué (exit $connect_exit)"
            cleanup_next_build_dirs
            exit 1
        fi
    elif [ -n "$build_dash_cmd" ]; then
        log info "   → Dashboard build seul..."
        if ! eval "$build_dash_cmd"; then
            cleanup_next_build_dirs
            return 1
        fi
    elif [ -n "$build_connect_cmd" ]; then
        log info "   → Connect build seul..."
        if ! eval "$build_connect_cmd"; then
            cleanup_next_build_dirs
            return 1
        fi
    else
        log info "   ⏭️  Aucun build Next.js nécessaire"
    fi
}

# Copier les static assets dans standalone
copy_static() {
    local need_dash="$1"
    local need_connect="$2"

    if [ "$need_dash" = true ]; then
        NEXT_DIST_DIR="$NEXT_DIST_DIR_DASHBOARD" \
            bash "$SOKAR_ROOT/apps/dashboard/scripts/copy-static.sh"
    else
        log info "   ⏭️  Dashboard non rebuild — static déjà en place"
    fi
    if [ "$need_connect" = true ]; then
        NEXT_DIST_DIR="$NEXT_DIST_DIR_CONNECT" \
            bash "$SOKAR_ROOT/apps/connect/scripts/copy-static.sh"
    else
        log info "   ⏭️  Connect non rebuild — static déjà en place"
    fi
}

# Appliquer les migrations Prisma (prod : backup DB via wrapper avant)
apply_migrations() {
    local need_prisma="$1"

    if [ "$DEPLOY_ENV" = "prod" ]; then
        log info ""
        log info "📦 Backing up database..."
        sudo "$PRIVILEGED_WRAPPER" install-runtime "$DEPLOY_ENV"
        sudo "$PRIVILEGED_WRAPPER" backup-db "$DEPLOY_ENV"
    fi

    log info ""
    log info "📦 Applying database migrations${DEPLOY_ENV:+ ($DEPLOY_ENV DB)}..."
    export DATABASE_URL=$(grep '^DATABASE_URL=' apps/api/.env | cut -d= -f2- | sed "s/^[\"'[:space:]]*//;s/[\"'[:space:]]*$//")
    pnpm exec prisma migrate deploy --schema=packages/database/prisma/schema.prisma
    unset DATABASE_URL
}

# Installer la configuration Nginx
install_nginx() {
    log info ""
    log info "📦 Installing Nginx ${DEPLOY_ENV} routing..."
    sudo "$PRIVILEGED_WRAPPER" install-nginx "$DEPLOY_ENV"

    # Prod : vérifier qu'un seul virtual host déclare api.suppernote.com
    if [ "$DEPLOY_ENV" = "prod" ]; then
        if ! sudo "$PRIVILEGED_WRAPPER" check-prod-vhost "$DEPLOY_ENV"; then
            log_error "Le nombre de virtual hosts déclarant api.suppernote.com est incorrect (attendu: 1)."
            log info "   Supprime l'ancien fichier dans /etc/nginx/sites-enabled avant de relancer."
            exit 1
        fi
    fi

    # Valider que le catch-all a default_server sur 443 (avant le reload).
    validate_nginx_config
}

# Vérifier que le catch-all Nginx déclare default_server sur 443.
# Bug PR #67 : les sous-domaines *.suppernote.com tombaient sur le dashboard au lieu
# de Connect car default_server manquait sur le listen 443 du server_name _.
validate_nginx_config() {
    # Staging n'a pas de catch-all (pas de subdomains) — skip la validation.
    if [ "$DEPLOY_ENV" != "prod" ]; then
        return 0
    fi

    local conf_file="/etc/nginx/sites-available/sokar"

    if ! grep -q "listen 443 ssl http2 default_server" "$conf_file" 2>/dev/null; then
        log_error "Nginx catch-all missing 'default_server' on listen 443."
        log_error "Subdomains *.suppernote.com will be routed to the wrong server block."
        log_error "Check $conf_file — the server_name _ block must have default_server on 443."
        exit 1
    fi
    log info "   ✅ Nginx catch-all default_server 443 — OK"
}

api_env_fingerprint() {
    if [ -f "$1" ]; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        printf '%s\n' missing
    fi
}

# Redémarrer les services PM2 + Nginx (+ LocalStack en prod)
# Attend la fin des appels vocaux en cours avant de remplacer l'API : ce process garde les sessions en
# mémoire, un redémarrage coupe donc les appels. Au-delà du délai on déploie quand même (correctif urgent).
# Sans mesure (API arrêtée, métrique absente) il n'y a rien à attendre.
wait_for_voice_idle() {
    local max="${VOICE_DRAIN_MAX_SECONDS:-300}" step="${VOICE_DRAIN_POLL_SECONDS:-5}" waited=0 sessions
    [ -n "${PORT_API:-}" ] || return 0
    while :; do
        sessions="$(curl -fsS -m 3 "http://127.0.0.1:${PORT_API}/metrics" 2>/dev/null \
            | awk '/^sokar_voice_active_sessions /{print $2; exit}' || true)"
        case "$sessions" in
            ''|*[!0-9.]*) return 0 ;;
            0|0.0) return 0 ;;
        esac
        if [ "$waited" -ge "$max" ]; then
            log_warn "Appels encore en cours après ${max}s (${sessions}) : déploiement quand même."
            return 0
        fi
        log info "⏳ ${sessions} appel(s) vocal(aux) en cours, attente avant de remplacer l'API..."
        sleep "$step"
        waited=$((waited + step))
    done
}

restart_services() {
    log info ""
    log info "📦 Restarting ${DEPLOY_ENV} services..."

    # Le build a été préparé hors ligne. La coupure éventuelle est limitée au
    # remplacement du processus, pas à toute la durée de compilation.
    if [ "${NEXT_BUILD_ACTIVATED_DASHBOARD:-false}" = true ]; then
        pm2 stop "$PM2_DASH" 2>/dev/null || true
    fi
    if [ "${NEXT_BUILD_ACTIVATED_CONNECT:-false}" = true ]; then
        pm2 stop "$PM2_CONNECT" 2>/dev/null || true
    fi

    # `pm2 start <ecosystem>` redémarre aussi les apps déjà en ligne : on ne le
    # lance qu'app par app, pour celles qui sont réellement remplacées, une seule
    # fois. Un déploiement Dashboard/Connect ne coupe donc pas le backend.
    local TO_START=""
    if [ "${NEXT_BUILD_ACTIVATED_DASHBOARD:-false}" = true ]; then
        TO_START="$PM2_DASH"
    fi
    if [ "${NEXT_BUILD_ACTIVATED_CONNECT:-false}" = true ]; then
        TO_START="$TO_START $PM2_CONNECT"
    fi
    if [ "${NEED_API:-false}" = true ] || { [ -n "${SOKAR_API_ENV_BEFORE:-}" ] && [ "$SOKAR_API_ENV_BEFORE" != "$(api_env_fingerprint "$SOKAR_ROOT/apps/api/.env")" ]; }; then
        TO_START="$TO_START $PM2_API $PM2_WORKERS"
    fi
    case " $TO_START " in *" $PM2_API "*) wait_for_voice_idle ;; esac
    # Une app absente ou arrêtée (pm2 delete, plantage) est aussi relancée : l'ancien
    # `pm2 start <ecosystem>` la remontait, et le runbook impose un `pm2 delete`.
    local APP PID
    for APP in "$PM2_API" "$PM2_WORKERS" "$PM2_DASH" "$PM2_CONNECT"; do
        PID="$(pm2 pid "$APP" 2>/dev/null | tr -d '[:space:]' || true)"
        case " $TO_START " in
            *" $APP "*) ;;
            *) if [ -n "$PID" ] && [ "$PID" != 0 ]; then continue; fi ;;
        esac
        pm2 start "$ECOSYSTEM_FILE" --only "$APP"
    done
    pm2 save
    sudo "$PRIVILEGED_WRAPPER" reload-nginx "$DEPLOY_ENV"

    if [ "$HAS_LOCALSTACK" = true ]; then
        log info ""
        log info "📦 Restarting LocalStack..."
        sudo "$PRIVILEGED_WRAPPER" start-localstack "$DEPLOY_ENV" 2>/dev/null || true
    fi
}

# Valider les fichiers .env de staging avant le build.
# Vérifie : présence des fichiers, pas de placeholder, DATABASE_URL sur sokar_staging,
# REDIS_URL sur db=3, secret Service Copilot ≥ 32 chars.
validate_env_files() {
    local required_files=(
        "apps/api/.env"
        "apps/dashboard/.env"
        "apps/connect/.env"
    )
    local errors=0
    log info ""
    log info "🔍 Validating env files..."

    for env_file in "${required_files[@]}"; do
        if [ ! -f "$env_file" ]; then
            log_error "Env file manquant : $env_file" >&2
            errors=$((errors + 1))
            continue
        fi
        chmod 0600 "$env_file"
    done

    if [ "$errors" -gt 0 ]; then
        log info "   Créez-les sur le VPS staging avec les valeurs de staging (voir .env.staging.example)." >&2
        exit 1
    fi

    # DATABASE_URL : pas de placeholder de mot de passe et doit pointer sur sokar_staging
    if grep -qE 'DATABASE_URL=.*:(CHANGE_ME_PASSWORD|password)@' apps/api/.env; then
        log_error "Le mot de passe de DATABASE_URL dans apps/api/.env est un placeholder." >&2
        log info "   Remplacez-le par une valeur forte avant de déployer." >&2
        exit 1
    fi

    if ! grep -qE 'DATABASE_URL=.*sokar_staging' apps/api/.env; then
        log_error "DATABASE_URL dans apps/api/.env doit pointer sur la base sokar_staging." >&2
        exit 1
    fi

    # REDIS_URL : staging utilise db=3 (isolé de prod db=0/1/2)
    if ! grep -qE 'REDIS_URL=.*:6379/3' apps/api/.env; then
        log_error "REDIS_URL dans apps/api/.env doit utiliser db=3 (REDIS_URL=...:6379/3)." >&2
        exit 1
    fi

    # Le Service Copilot signe les événements navigateur avec ce secret.
    # Valider avant d'arrêter les services évite une boucle PM2 au redémarrage.
    local copilot_secret
    copilot_secret=$(grep -E '^SERVICE_COPILOT_TELEMETRY_SECRET=' apps/api/.env \
        | tail -n 1 | cut -d= -f2- | sed "s/^[\"'[:space:]]*//;s/[\"'[:space:]]*$//" || true)
    if [ "${#copilot_secret}" -lt 32 ]; then
        log_error "SERVICE_COPILOT_TELEMETRY_SECRET doit contenir au moins 32 caractères." >&2
        exit 1
    fi

    # Recherche de placeholders restants (CHANGE_ME ou ...)
    local placeholders
    placeholders=$(grep -nE '=(.*CHANGE_ME|.*\.\.\.)' apps/api/.env apps/dashboard/.env apps/connect/.env 2>/dev/null || true)
    if [ -n "$placeholders" ]; then
        log_error "Des valeurs placeholder sont présentes dans les fichiers .env :" >&2
        log_warn "$placeholders" | sed 's/^/   /'
        exit 1
    fi

    log info "   ✅ Env files validés."
}

# Health checks — étendus en prod, simples en staging
health_checks() {
    log info ""
    log info "📦 Verifying ${DEPLOY_ENV}..."
    pm2 status
    wait_for_services

    log info ""
    log_section "Checking ${DEPLOY_ENV} HTTP endpoints"
    local API_STATUS DASH_STATUS CONNECT_STATUS
    API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_API}/health" 2>/dev/null || echo "FAIL")
    DASH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_DASH}" 2>/dev/null || echo "FAIL")
    CONNECT_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_CONNECT}/restaurant/chez-sokar-demo" 2>/dev/null || echo "FAIL")
    log info "   api (127.0.0.1:${PORT_API}/health) → $API_STATUS"
    log info "   dashboard (127.0.0.1:${PORT_DASH})  → $DASH_STATUS"
    log info "   connect (127.0.0.1:${PORT_CONNECT}/restaurant/chez-sokar-demo) → $CONNECT_STATUS"

    if [ "$EXTENDED_HEALTH_CHECKS" = true ]; then
        # Checks étendus prod
        local API_VHOST_STATUS WIDGET_API_STATUS PUBLIC_PAGE_STATUS
        API_VHOST_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: api.suppernote.com" \
            http://127.0.0.1/health 2>/dev/null || echo "FAIL")
        WIDGET_API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: suppernote.com" \
            http://127.0.0.1/api/proxy/public/widget/chez-sokar-demo 2>/dev/null || echo "FAIL")
        PUBLIC_PAGE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: suppernote.com" \
            http://127.0.0.1/restaurant/chez-sokar-demo 2>/dev/null || echo "FAIL")
        log info "   api.suppernote.com/health via Nginx → $API_VHOST_STATUS"
        log info "   widget slug API via Next proxy → $WIDGET_API_STATUS"
        log info "   public Sokar Connect page via Nginx → $PUBLIC_PAGE_STATUS"

        local WIDGET_HEADERS WIDGET_IFRAME_STATUS
        WIDGET_HEADERS=$(curl -sSI -H "Host: suppernote.com" \
            http://127.0.0.1/widget/chez-sokar-demo 2>/dev/null || true)
        if printf '%s' "$WIDGET_HEADERS" | grep -Eqi '^X-Frame-Options:'; then
            WIDGET_IFRAME_STATUS="FAIL"
        else
            WIDGET_IFRAME_STATUS="OK"
        fi
        if ! printf '%s' "$WIDGET_HEADERS" | grep -Eqi '^Content-Security-Policy:.*frame-ancestors \*'; then
            WIDGET_IFRAME_STATUS="FAIL"
        fi
        log info "   widget iframe headers → $WIDGET_IFRAME_STATUS"

        # Vérification de la page achat carte cadeau (P1.4) — route /widget/[slug]/gift-card.
        local GIFT_CARD_WIDGET_STATUS
        GIFT_CARD_WIDGET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: suppernote.com" \
            http://127.0.0.1/widget/chez-sokar-demo/gift-card 2>/dev/null || echo "FAIL")
        log info "   gift-card widget page → $GIFT_CARD_WIDGET_STATUS"

        # Subdomain routing check — verify *.suppernote.com middleware routes to Connect
        # (not the dashboard). Bug historique : default_server manquant sur 443 →
        # les sous-domaines tombaient sur le dashboard au lieu de Connect.
        local SUBDOMAIN_STATUS
        SUBDOMAIN_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Host: chez-sokar-demo.suppernote.com" "http://127.0.0.1/" 2>/dev/null || echo "FAIL")
        log info "   subdomain (Host: chez-sokar-demo.suppernote.com) → $SUBDOMAIN_STATUS"

        # Vérification post-déploiement : un asset CSS/JS réel doit répondre 200.
        # Bug historique : `curl -I /` répond 200 même si .next/static n'a pas été
        # copié dans le standalone → page blanche côté client. On extrait le premier
        # chunk JS du HTML rendu et on vérifie qu'il est servi.
        local DASH_CSS_STATUS FIRST_CHUNK
        DASH_CSS_STATUS="N/A"
        FIRST_CHUNK=$(curl -s -H "Host: suppernote.com" http://127.0.0.1/ 2>/dev/null \
          | grep -oE '/_next/static/[^\"]+\.(js|css)' \
          | head -1 || true)
        if [ -n "$FIRST_CHUNK" ]; then
          DASH_CSS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Host: suppernote.com" "http://127.0.0.1${FIRST_CHUNK}" 2>/dev/null || echo "FAIL")
          log info "   dashboard asset ${FIRST_CHUNK} → $DASH_CSS_STATUS"
        else
          log_warn " Aucun chunk JS/CSS trouvé dans le HTML du dashboard (build cassé ?)"
        fi

        # /pricing doit être servi avec sa feuille de style (incident 2026-09-27 :
        # HTML 200 mais /_next/static/css/*.css en 400 → page sans CSS).
        local PRICING_CSS_STATUS PRICING_CSS
        PRICING_CSS_STATUS="FAIL"
        PRICING_CSS=$(curl -s -H "Host: suppernote.com" http://127.0.0.1/pricing 2>/dev/null \
          | grep -oE '/_next/static/css/[^"]+\.css' \
          | head -1 || true)
        if [ -n "$PRICING_CSS" ]; then
          PRICING_CSS_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Host: suppernote.com" "http://127.0.0.1${PRICING_CSS}" 2>/dev/null || echo "FAIL")
          log info "   /pricing CSS ${PRICING_CSS} → $PRICING_CSS_STATUS"
        else
          log_warn " Aucune feuille CSS trouvée dans le HTML de /pricing"
        fi

        local FREE_AFTER
        FREE_AFTER=$(free -m | awk '/^Mem:/ {print $4}')
        log info "   Memory free: ${FREE_AFTER}MB"

        # Le dashboard est OK SEULELEMENT si l'HTML et un asset statique répondent 200.
        # Si l'asset est 404, c'est le bug pitfall #29 (static non copiés dans standalone).
        if [ "$API_STATUS" = "200" ] \
            && [ "$DASH_STATUS" = "200" ] \
            && [ "$CONNECT_STATUS" = "200" ] \
            && [ "$API_VHOST_STATUS" = "200" ] \
            && [ "$WIDGET_API_STATUS" = "200" ] \
            && [ "$PUBLIC_PAGE_STATUS" = "200" ] \
            && [ "$WIDGET_IFRAME_STATUS" = "OK" ] \
            && [ "$GIFT_CARD_WIDGET_STATUS" = "200" ] \
            && [ "$SUBDOMAIN_STATUS" = "200" ] \
            && [ "$DASH_CSS_STATUS" = "200" ] \
            && [ "$PRICING_CSS_STATUS" = "200" ]; then
            DEPLOY_HEALTH_OK=true
        elif [ "$DASH_STATUS" = "200" ] \
            && { [ "$DASH_CSS_STATUS" != "200" ] || [ "$PRICING_CSS_STATUS" != "200" ]; }; then
            log info ""
            log_error "Deploy REGRESSED : dashboard HTML répond 200 mais assets statiques en échec (dashboard=$DASH_CSS_STATUS, /pricing CSS=$PRICING_CSS_STATUS)."
            log info "   Cause probable : scripts/copy-static.sh non exécuté ou .next/static manquant."
            log info "   Fix manuel : cd /opt/sokar/apps/dashboard && bash scripts/copy-static.sh && pm2 restart sokar-dashboard"
            notify "🔴 Sokar production deploy REGRESSED (static assets 404, branch ${BRANCH})"
            DEPLOY_HEALTH_OK=false
            DEPLOY_HEALTH_REGRESSED=true
        else
            DEPLOY_HEALTH_OK=false
        fi
    else
        # Checks simples staging
        local LIVEZ_STATUS STAGING_API_VHOST STAGING_DASH_VHOST
        LIVEZ_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_API}/livez" 2>/dev/null || echo "FAIL")
        log info "   api (/livez)       → $LIVEZ_STATUS"

        # Vérifier via Nginx (Host header)
        STAGING_API_VHOST=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: staging.suppernote.com" \
            http://127.0.0.1/health 2>/dev/null || echo "FAIL")
        STAGING_DASH_VHOST=$(curl -s -o /dev/null -w "%{http_code}" -H "Host: staging.suppernote.com" \
            http://127.0.0.1/ 2>/dev/null || echo "FAIL")
        log info "   staging.suppernote.com/health via Nginx → $STAGING_API_VHOST"
        log info "   staging.suppernote.com/ via Nginx       → $STAGING_DASH_VHOST"

        if [ "$API_STATUS" = "200" ] \
            && [ "$LIVEZ_STATUS" = "200" ] \
            && [ "$DASH_STATUS" = "200" ] \
            && [ "$CONNECT_STATUS" = "200" ]; then
            DEPLOY_HEALTH_OK=true
        else
            DEPLOY_HEALTH_OK=false
            # Staging : appeler recover_services explicitement (exit 1 n'émet pas ERR)
            log info ""
            log_error "Staging deploy finished but checks failed"
            log info "   API=$API_STATUS Livez=$LIVEZ_STATUS Dash=$DASH_STATUS Connect=$CONNECT_STATUS"
            recover_services 1
        fi
    fi
}

# ── Parse args ───────────────────────────────────────────
# Extrait du bloc inline de deploy.sh.
# Set les variables globales : DEPLOY_ENV, CONFIRM_PRODUCTION, DRY_RUN, FORCE,
# FORCE_BUILD, BRANCH, COMMAND, WITH_DB_ROLLBACK, TARGET_RELEASE, BRANCH_SET.
# Appelle print_usage (définie par deploy.sh) sur --help.
parse_deploy_args() {
    while [ $# -gt 0 ]; do
        case "${1:-}" in
            --env)
                DEPLOY_ENV="${2:-}"
                shift 2
                ;;
            --env=*)
                DEPLOY_ENV="${1#*=}"
                shift
                ;;
            --confirm-production)
                CONFIRM_PRODUCTION=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --force)
                FORCE=true
                shift
                ;;
            --force-build)
                FORCE_BUILD=true
                shift
                ;;
            --with-db-rollback)
                WITH_DB_ROLLBACK=true
                shift
                ;;
            --help|-h)
                print_usage
                exit 0
                ;;
            rollback)
                COMMAND="rollback"
                shift
                ;;
            deploy)
                COMMAND="deploy"
                shift
                ;;
            *)
                # Argument non-flag : en mode rollback c'est la release cible,
                # sinon c'est la branche git à déployer.
                if [ "$COMMAND" = "rollback" ]; then
                    if [ -z "$TARGET_RELEASE" ]; then
                        TARGET_RELEASE="$1"
                    fi
                else
                    if [ -z "${BRANCH_SET:-}" ]; then
                        BRANCH="$1"
                        BRANCH_SET=1
                    fi
                fi
                shift
                ;;
        esac
    done
}

# ── Validation env ───────────────────────────────────────
# Extrait du bloc inline de deploy.sh.
# Set les variables globales : SOKAR_ROOT, RELEASES_DIR, PORT_API, PORT_DASH,
# PORT_CONNECT, PM2_API, PM2_WORKERS, PM2_DASH, PM2_CONNECT, ECOSYSTEM_FILE, NGINX_CONFIG,
# DB_NAME, KEEP_RELEASES, HAS_LOCALSTACK, HAS_LOGROTATE, HAS_CERT_CHECK,
# EXTENDED_HEALTH_CHECKS.
# Appelle print_usage et exit 1 si --env est manquant ou invalide.
validate_deploy_env() {
    if [ -z "$DEPLOY_ENV" ]; then
        echo "Erreur: --env est requis." >&2
        echo "" >&2
        print_usage >&2
        exit 1
    fi

    case "$DEPLOY_ENV" in
        prod)
            SOKAR_ROOT="/opt/sokar"
            RELEASES_DIR="$SOKAR_ROOT/releases"
            PORT_API=4000
            PORT_DASH=3000
            PORT_CONNECT=4002
            PM2_API="sokar-api"
            PM2_DASH="sokar-dashboard"
            PM2_CONNECT="sokar-connect"
            PM2_WORKERS="sokar-workers"
            ECOSYSTEM_FILE="infra/ecosystem.config.js"
            NGINX_CONFIG="sokar"
            DB_NAME="sokar"
            KEEP_RELEASES=5
            HAS_LOCALSTACK=true
            HAS_LOGROTATE=true
            HAS_CERT_CHECK=true
            EXTENDED_HEALTH_CHECKS=true
            # Prod : --dry-run non supporté
            if [ "$DRY_RUN" = true ]; then
                echo "Erreur: --dry-run n'est pas supporté en production." >&2
                exit 1
            fi
            # Prod : --force non supporté
            if [ "$FORCE" = true ]; then
                echo "Erreur: --force n'est pas supporté en production." >&2
                exit 1
            fi
            ;;
        staging)
            SOKAR_ROOT="/opt/sokar-staging"
            RELEASES_DIR="$SOKAR_ROOT/releases"
            PORT_API=4100
            PORT_DASH=3100
            PORT_CONNECT=4102
            PM2_API="sokar-staging-api"
            PM2_DASH="sokar-staging-dashboard"
            PM2_CONNECT="sokar-staging-connect"
            PM2_WORKERS="sokar-staging-workers"
            ECOSYSTEM_FILE="infra/ecosystem.staging.config.js"
            NGINX_CONFIG="sokar-staging"
            DB_NAME="sokar_staging"
            KEEP_RELEASES=3
            HAS_LOCALSTACK=false
            HAS_LOGROTATE=false
            HAS_CERT_CHECK=false
            EXTENDED_HEALTH_CHECKS=false
            # Staging : --confirm-production non requis (ignoré silencieusement)
            ;;
        *)
            echo "Erreur: --env doit être 'prod' ou 'staging' (reçu: '$DEPLOY_ENV')." >&2
            echo "" >&2
            print_usage >&2
            exit 1
            ;;
    esac
}

# ── Handle rollback ──────────────────────────────────────
# Extrait du bloc inline de deploy.sh (P2 scripts refactor).
#
# Variables globales attendues (set par validate_deploy_env / parse_deploy_args) :
#   DEPLOY_ENV         prod | staging
#   SOKAR_ROOT         /opt/sokar | /opt/sokar-staging
#   RELEASES_DIR       $SOKAR_ROOT/releases
#   WITH_DB_ROLLBACK   true | false
#   TARGET_RELEASE     release cible (peut être vide → calculée automatiquement)
#   PM2_WORKERS        nom du process PM2 des workers BullMQ (R1-1)
#   PM2_DASH           nom du process PM2 dashboard
#   PM2_CONNECT        nom du process PM2 connect
#   ECOSYSTEM_FILE     infra/ecosystem.config.js | infra/ecosystem.staging.config.js
#   PORT_API           port de l'API
#   PORT_DASH          port du dashboard
#   PRIVILEGED_WRAPPER /usr/local/sbin/sokar-deploy-root
#
# Variables globales set :
#   TARGET_RELEASE  (calculée si vide — comportement existant)
#
# Fonctions appelées (déjà disponibles via sourcing) :
#   list_releases(), restore_artifacts(), wait_for_services() — deploy-common.sh
#   restore_db()                                               — db-backup.sh
#   log_section(), log, log_ok, log_error, notify()            — logging.sh
#
# Retourne 0 en cas de succès, 1 en cas d'échec.
# L'appelant (deploy.sh) gère le exit 0 final.
handle_rollback() {
    cd "$SOKAR_ROOT"
    log_section "${DEPLOY_ENV^} Rollback"

    # TARGET_RELEASE est désormais parsé par la boucle d'arguments principale
    # (le prochain argument non-flag après "rollback" est traité comme release cible).

    if [ -z "$TARGET_RELEASE" ]; then
        # Pas de release spécifiée → prendre l'avant-dernière
        # (la dernière est potentiellement celle qui vient de casser)
        list_releases
        log info ""
        TARGET_RELEASE=$(ls -1 "$RELEASES_DIR" 2>/dev/null \
            | grep -E '^[0-9]{8}T[0-9]{6}Z' \
            | sort -r \
            | sed -n '2p')
        if [ -z "$TARGET_RELEASE" ]; then
            log_error "Aucune release précédente trouvée dans $RELEASES_DIR"
            return 1
        fi
        log info "→ Rollback vers : $TARGET_RELEASE"
    fi

    local RELEASE_PATH="$RELEASES_DIR/$TARGET_RELEASE"
    if [ ! -d "$RELEASE_PATH" ]; then
        log_error "Release $TARGET_RELEASE introuvable"
        list_releases
        return 1
    fi
    # Vérifié avant d'arrêter les services : une release sans lockfile ne peut
    # pas être restaurée proprement (voir snapshot_dependencies).
    if [ ! -f "$RELEASE_PATH/deps/pnpm-lock.yaml" ]; then
        log_error "Release $TARGET_RELEASE sans lockfile : rollback impossible, utiliser git revert + redéploiement"
        return 1
    fi

    log info "→ Stop services..."
    pm2 stop "$PM2_DASH" "$PM2_CONNECT" 2>/dev/null || true

    log info "→ Restore artefacts..."
    restore_artifacts "$RELEASE_PATH"

    log info "→ Restore dépendances (lockfile de la release)..."
    restore_release_manifests "$RELEASE_PATH"
    if ! (cd "$SOKAR_ROOT" && pnpm install --frozen-lockfile); then
        log_error "pnpm install a échoué pendant le rollback — services à l'arrêt, intervention manuelle"
        return 1
    fi

    if [ "$WITH_DB_ROLLBACK" = true ]; then
        log info "→ Restore DB..."
        if ! restore_db "$RELEASE_PATH"; then
            log_error "DB restore échoué — rollback annulé"
            return 1
        fi
    fi

    log info "→ Restart services..."
    # `pm2 start <ecosystem>` redémarre les apps déjà connues puis affiche son
    # tableau. Si une app boucle en crash, la CLI plante elle-même (TypeError
    # dans speedList) et faisait échouer tout le rollback — alors que le verdict
    # réel vient de wait_for_services juste après. On trace l'avertissement et
    # on laisse la vérification de santé décider.
    pm2 start "$ECOSYSTEM_FILE" ||
        log_warn "pm2 start a retourné une erreur ; la vérification des services suit"
    wait_for_services
    pm2 save
    sudo "$PRIVILEGED_WRAPPER" reload-nginx "$DEPLOY_ENV" 2>/dev/null || true

    log info ""
    log info "→ Vérification..."
    API_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_API}/health" 2>/dev/null || echo "FAIL")
    DASH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${PORT_DASH}" 2>/dev/null || echo "FAIL")
    log info "   api → $API_STATUS | dashboard → $DASH_STATUS"

    if [ "$API_STATUS" = "200" ] && [ "$DASH_STATUS" = "200" ]; then
        log info ""
        log_ok "Rollback vers $TARGET_RELEASE terminé"
        log info "   Meta: $(cat "$RELEASE_PATH/META" 2>/dev/null | tr '\n' ' ')"
        notify "✅ Sokar ${DEPLOY_ENV} rollback OK (${TARGET_RELEASE})"
    else
        log info ""
        log_error "Rollback terminé mais vérifications échouées — investiguer manuellement"
        notify "🔴 Sokar ${DEPLOY_ENV} rollback failed (${TARGET_RELEASE})"
        return 1
    fi
    return 0
}
