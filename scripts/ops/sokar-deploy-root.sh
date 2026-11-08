#!/usr/bin/env bash

set -Eeuo pipefail

if [ "${EUID}" -ne 0 ]; then
    echo "Ce wrapper doit être exécuté en root." >&2
    exit 1
fi

PRIVILEGED_WRAPPER="/usr/local/sbin/sokar-deploy-root"
SUDOERS_DST="/etc/sudoers.d/deploy"

usage() {
    echo "Usage: $0 {check-cert|clean-next|install-nginx|restore-nginx|reload-nginx|install-runtime|configure-watchdog|configure-grafana|self-update|check-prod-vhost|start-localstack|stop-localstack|validate-monitoring|start-prometheus|start-grafana|apply-redis-config|backup-db|restore-test} {prod|staging} [dashboard|connect|check]" >&2
    exit 2
}

[ "$#" -ge 2 ] || usage
ACTION="$1"
ENVIRONMENT="$2"

case "$ENVIRONMENT" in
    prod)
        ROOT="/opt/sokar"
        VHOST="sokar"
        CERT_ROOT="/etc/letsencrypt/live/suppernote.com"
        ;;
    staging)
        ROOT="/opt/sokar-staging"
        VHOST="sokar-staging"
        CERT_ROOT="/etc/letsencrypt/live/suppernote.com"
        ;;
    *)
        usage
        ;;
esac

# ── Source nginx-common.sh (install_nginx_vhost, restore_nginx_vhost) ─
# En prod le wrapper est à /usr/local/sbin/ ; nginx-common.sh est dans le repo.
if [ -f "$ROOT/scripts/ops/nginx-common.sh" ]; then
    # shellcheck source=ops/nginx-common.sh
    source "$ROOT/scripts/ops/nginx-common.sh"
else
    echo "Erreur: nginx-common.sh introuvable dans $ROOT/scripts/ops/" >&2
    exit 1
fi

clean_next() {
    [ "$#" -eq 1 ] || usage
    case "$1" in
        dashboard) APP_DIR="$ROOT/apps/dashboard" ;;
        connect) APP_DIR="$ROOT/apps/connect" ;;
        *) usage ;;
    esac
    for sub in standalone server static types; do
        rm -rf "$APP_DIR/.next/$sub"
    done
    rm -f "$APP_DIR/.next/BUILD_ID"
    rm -rf "$APP_DIR"/.next/eslint*
    find "$APP_DIR/.next" -maxdepth 1 -name '*.nft.json' -delete
    find "$APP_DIR/.next/server" -name '*.nft.json' -delete 2>/dev/null || true
}

check_prod_vhost() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    [ "$(grep -lE '^[[:space:]]*server_name[[:space:]]+api\.sokar\.tech' /etc/nginx/sites-enabled/* 2>/dev/null | wc -l)" -eq 1 ]
}

localstack() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    case "$ACTION" in
        start-localstack) /usr/bin/docker start infra-localstack-1 ;;
        stop-localstack) /usr/bin/docker stop infra-localstack-1 ;;
        *) usage ;;
    esac
}

install_runtime() {
    if [ "$ENVIRONMENT" = "prod" ]; then
        install -d -m 0700 -o deploy -g deploy /var/backups/sokar
        install -m 0750 "$ROOT/scripts/database/backup-postgres.sh" /usr/local/sbin/sokar-backup-postgres
        install -m 0644 "$ROOT/infra/cron/sokar-postgres-backup" /etc/cron.d/sokar-postgres-backup
        # Le backup offsite R2 vivait uniquement sur le serveur : sans ce
        # fichier versionné, une reconstruction du VPS perdait la copie
        # hors-site sans que rien ne le signale.
        install -m 0644 "$ROOT/infra/cron/sokar-r2-backup" /etc/cron.d/sokar-r2-backup
        # Watchdog monitoring (toutes les 5 min) : API/dashboard/Redis/backup/disque/mémoire.
        install -d -m 0750 /var/lib/sokar/watchdog
        install -m 0755 "$ROOT/scripts/ops/sokar-watchdog.sh" /usr/local/sbin/sokar-watchdog
        install -m 0644 "$ROOT/infra/cron/sokar-watchdog" /etc/cron.d/sokar-watchdog
        install -d -m 0755 -o www-data -g www-data /var/cache/nginx/connect
        install -m 0644 "$ROOT/infra/logrotate/sokar" /etc/logrotate.d/sokar
    elif [ "$ENVIRONMENT" = "staging" ]; then
        install -d -m 0755 -o root -g root /var/backups/sokar-staging
        install -m 0755 "$ROOT/scripts/database/backup-staging-postgres.sh" /usr/local/sbin/sokar-staging-backup-postgres
        install -m 0644 "$ROOT/infra/cron/sokar-staging-postgres-backup" /etc/cron.d/sokar-staging-postgres-backup
        install -d -m 0755 -o www-data -g www-data /var/cache/nginx/connect
        install -m 0644 "$ROOT/infra/logrotate/sokar" /etc/logrotate.d/sokar
    else
        usage
    fi
}

configure_watchdog() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    # Le déploiement transmet les valeurs par stdin sous la forme
    # KEY<TAB>VALUE. Cela évite de placer les secrets dans la ligne de
    # commande ou dans les logs SSH. Seules les deux variables watchdog
    # documentées sont acceptées.
    local env_dir="/etc/sokar"
    local env_file="$env_dir/watchdog.env"
    local tmp_file
    local key value extra
    local count=0

    install -d -m 0750 -o root -g root "$env_dir"
    tmp_file=$(mktemp "$env_dir/.watchdog.env.XXXXXX")
    cleanup_watchdog_tmp() {
        rm -f "$tmp_file"
    }
    trap cleanup_watchdog_tmp RETURN
    chmod 0600 "$tmp_file"
    chown root:root "$tmp_file"

    while IFS=$'\t' read -r key value extra; do
        [ -n "$key" ] || continue
        [ -z "${extra:-}" ] || {
            echo "Entrée watchdog invalide (trop de colonnes)." >&2
            return 1
        }
        case "$key" in
            ALERT_WEBHOOK|HEALTHCHECKS_PING_URL) ;;
            *)
                echo "Variable watchdog non autorisée: $key" >&2
                return 1
                ;;
        esac
        case "$value" in
            *$'\n'*|*$'\r'*)
                echo "Valeur watchdog invalide (retour à la ligne)." >&2
                return 1
                ;;
        esac
        # %q produit une affectation shell sûre pour le fichier sourcé par
        # sokar-watchdog.sh, y compris si l'URL contient des caractères spéciaux.
        printf '%s=%q\n' "$key" "$value" >> "$tmp_file"
        count=$((count + 1))
    done

    [ "$count" -gt 0 ] || {
        echo "Aucune configuration watchdog reçue." >&2
        return 1
    }
    bash -n "$tmp_file"
    install -o root -g root -m 0600 "$tmp_file" "$env_file"
    echo "Configuration watchdog installée."
}

configure_grafana() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    # Valeur transmise uniquement par stdin, jamais en argument ou dans les logs.
    bash "$ROOT/scripts/ops/configure-grafana-env.sh" /etc/sokar/grafana.env
}

self_update() {
    [ "$ENVIRONMENT" = "prod" ] || [ "$ENVIRONMENT" = "staging" ] || usage
    local wrapper_src="$ROOT/scripts/ops/sokar-deploy-root.sh"
    local sudoers_src="$ROOT/infra/sudoers.d/deploy"
    local wrapper_backup="$PRIVILEGED_WRAPPER.bak"
    local sudoers_backup="$SUDOERS_DST.bak"

    install -m 0755 "$PRIVILEGED_WRAPPER" "$wrapper_backup"

    if [ -f "$SUDOERS_DST" ]; then
        install -m 0440 "$SUDOERS_DST" "$sudoers_backup"
    fi

    install -o root -g root -m 0755 "$wrapper_src" "$PRIVILEGED_WRAPPER"

    if [ -f "$sudoers_src" ]; then
        install -o root -g root -m 0440 "$sudoers_src" "$SUDOERS_DST"
        if ! visudo -c >/dev/null 2>&1; then
            install -o root -g root -m 0755 "$wrapper_backup" "$PRIVILEGED_WRAPPER"
            if [ -f "$sudoers_backup" ]; then
                install -o root -g root -m 0440 "$sudoers_backup" "$SUDOERS_DST"
            fi
            echo "❌ visudo a détecté une erreur. Restauration effectuée." >&2
            exit 1
        fi
    fi

    rm -f "$wrapper_backup" "$sudoers_backup"
    echo "✅ Wrapper sokar-deploy-root mis à jour depuis $wrapper_src"
}

# ── Exercice de restauration (R1-5) ──────────────────────────────
# Le compte `deploy` n'a ni le groupe docker ni les clients PostgreSQL
# (`psql`, `pg_restore`, `createdb` sont absents de l'hôte) : l'exercice de
# restauration documenté ne peut donc s'exécuter qu'en root, via cette action.
# Le script crée une base temporaire, restaure le dernier dump R2, vérifie
# tables / contraintes / index critiques, puis supprime la base. Il ne touche
# jamais la base de production.
restore_test() {
    local script="$ROOT/scripts/database/test-restore-vierge.sh"
    if [ ! -f "$script" ]; then
        echo "Erreur: $script introuvable dans $ROOT." >&2
        exit 1
    fi
    bash "$script"
}

start_prometheus() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    /usr/bin/docker compose \
        --project-name sokar-monitoring \
        -f "$ROOT/infra/prometheus-compose.yml" \
        up -d prometheus

    local attempt
    for attempt in $(seq 1 30); do
        if curl -fsS --max-time 2 http://127.0.0.1:9090/-/ready >/dev/null; then
            echo "Prometheus est opérationnel."
            return 0
        fi
        sleep 1
    done
    echo "Prometheus n'a pas passé son health check en 30 secondes." >&2
    exit 1
}

# Applique la définition de Redis de infra/docker-compose.yml (plafond mémoire) en recréant le conteneur :
# Redis est coupé environ 5 secondes. Garde-fous : aucun appel vocal en cours, le conteneur actuel est bien
# géré par ce fichier et garde son volume de données (sinon la file BullMQ serait perdue), et les données sont
# écrites sur disque juste avant. Seul le service redis est touché.
# Mode `check` : exécute tous les contrôles sans rien modifier.
apply_redis_config() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    local mode="${1:-apply}"
    case "$mode" in apply|check) ;; *) usage ;; esac

    # Le compose décrit aussi Postgres et Grafana, dont les mots de passe sont obligatoires pour interpréter
    # le fichier. Ils ne servent pas à recréer Redis et Compose ne touche que le service nommé : on fournit des
    # valeurs neutres plutôt que de lire des fichiers de secrets. `--env-file /dev/null` empêche Compose de
    # lire infra/.env, qui est le fichier d'environnement de l'application et non celui de ce compose.
    # (Texte neutre, pas un secret : aucun service autre que redis n'est jamais créé ni modifié.)
    local unused_by_redis="non-utilise-par-redis"
    export POSTGRES_PASSWORD=$unused_by_redis GRAFANA_ADMIN_PASSWORD=$unused_by_redis
    local compose=(/usr/bin/docker compose --project-name infra
        --env-file /dev/null -f "$ROOT/infra/docker-compose.yml")

    local sessions
    sessions="$(curl -fsS --max-time 3 http://127.0.0.1:4000/metrics 2>/dev/null \
        | awk '/^sokar_voice_active_sessions /{print $2; exit}' || true)"
    case "$sessions" in
        0|0.0) ;;
        *)
            echo "Abandon : appels vocaux en cours ou mesure indisponible (${sessions:-aucune})." >&2
            exit 1
            ;;
    esac

    "${compose[@]}" config --quiet
    local container
    container="$("${compose[@]}" ps -q redis)"
    if [ -z "$container" ]; then
        echo "Abandon : le conteneur Redis en cours n'est pas géré par infra/docker-compose.yml." >&2
        exit 1
    fi
    if [ -z "$(/usr/bin/docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container")" ]; then
        echo "Abandon : /data de Redis n'est pas un volume nommé, les données seraient perdues." >&2
        exit 1
    fi

    if [ "$mode" = "check" ]; then
        echo "Contrôles réussis : conteneur Redis géré par le compose, volume nommé, aucun appel en cours. Rien modifié."
        return 0
    fi

    "${compose[@]}" exec -T redis redis-cli save
    "${compose[@]}" up -d --no-deps redis

    local attempt
    for attempt in $(seq 1 30); do
        if [ "$("${compose[@]}" exec -T redis redis-cli ping 2>/dev/null | tr -d '\r')" = "PONG" ]; then
            "${compose[@]}" exec -T redis redis-cli config get maxmemory
            "${compose[@]}" exec -T redis redis-cli config get maxmemory-policy
            return 0
        fi
        sleep 1
    done
    echo "Redis n'a pas répondu dans les 30 secondes." >&2
    exit 1
}

validate_monitoring() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    /usr/bin/docker compose \
        --project-name sokar-monitoring \
        -f "$ROOT/infra/prometheus-compose.yml" \
        config --quiet
    /usr/bin/docker compose \
        --project-name sokar-monitoring \
        --env-file /etc/sokar/grafana.env \
        -f "$ROOT/infra/grafana-compose.yml" \
        config --quiet
}

start_grafana() {
    [ "$ENVIRONMENT" = "prod" ] || usage
    /usr/bin/docker compose \
        --project-name sokar-monitoring \
        --env-file /etc/sokar/grafana.env \
        -f "$ROOT/infra/grafana-compose.yml" \
        up -d grafana

    local attempt
    for attempt in $(seq 1 60); do
        if curl -fsS --max-time 2 http://127.0.0.1:3030/api/health >/dev/null; then
            echo "Grafana est opérationnel sur la loopback."
            return 0
        fi
        sleep 1
    done
    echo "Grafana n'a pas passé son health check en 60 secondes." >&2
    exit 1
}

case "$ACTION" in
    check-cert)
        [ "$#" -eq 2 ] || usage
        test -f "$CERT_ROOT/fullchain.pem" && test -f "$CERT_ROOT/privkey.pem"
        ;;
    clean-next)
        [ "$#" -eq 3 ] || usage
        clean_next "$3"
        ;;
    install-nginx)
        [ "$#" -eq 2 ] || usage
        install_nginx_vhost "$ROOT" "$VHOST" "$ENVIRONMENT" "$CERT_ROOT"
        ;;
    restore-nginx)
        [ "$#" -eq 2 ] || usage
        restore_nginx_vhost "$VHOST" "$ENVIRONMENT"
        ;;
    reload-nginx)
        [ "$#" -eq 2 ] || usage
        nginx -t
        systemctl reload nginx
        ;;
    install-runtime)
        [ "$#" -eq 2 ] || usage
        install_runtime
        ;;
    configure-watchdog)
        [ "$#" -eq 2 ] || usage
        configure_watchdog
        ;;
    configure-grafana)
        [ "$#" -eq 2 ] || usage
        configure_grafana
        ;;
    backup-db)
        [ "$#" -eq 2 ] || usage
        if [ "$ENVIRONMENT" = "prod" ]; then
            /usr/local/sbin/sokar-backup-postgres
        else
            /usr/local/sbin/sokar-staging-backup-postgres
        fi
        ;;
    restore-test)
        [ "$#" -eq 2 ] || usage
        restore_test
        ;;
    self-update)
        [ "$#" -eq 2 ] || usage
        self_update
        ;;
    check-prod-vhost)
        [ "$#" -eq 2 ] || usage
        check_prod_vhost
        ;;
    start-localstack|stop-localstack)
        [ "$#" -eq 2 ] || usage
        localstack
        ;;
    start-prometheus)
        [ "$#" -eq 2 ] || usage
        start_prometheus
        ;;
    validate-monitoring)
        [ "$#" -eq 2 ] || usage
        validate_monitoring
        ;;
    apply-redis-config)
        { [ "$#" -eq 2 ] || [ "$#" -eq 3 ]; } || usage
        apply_redis_config "${3:-apply}"
        ;;
    start-grafana)
        [ "$#" -eq 2 ] || usage
        start_grafana
        ;;
    *)
        usage
        ;;
esac
