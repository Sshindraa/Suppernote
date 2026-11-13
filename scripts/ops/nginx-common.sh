#!/usr/bin/env bash
set -Eeuo pipefail
# Helpers partagés pour l'installation et restauration des vhosts Nginx Suppernote.
# Sourcé par scripts/ops/sokar-deploy-root.sh.
#
# Extrait de install_nginx() et restore_nginx() de sokar-deploy-root.sh (P2 scripts refactor).

# ── Source défensif de logging.sh ─────────────────────────
# En dev ce script est lancé depuis le repo (scripts/ops/) ;
# en prod il est sourcé par /usr/local/sbin/sokar-deploy-root depuis le repo.
# On utilise BASH_SOURCE pour obtenir le chemin de ce fichier (pas $0).
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -f "$SCRIPT_DIR/logging.sh" ]; then
  HELPERS_DIR="$SCRIPT_DIR"
else
  SOKAR_ROOT="${SOKAR_ROOT:-/opt/sokar}"
  HELPERS_DIR="$SOKAR_ROOT/scripts/ops"
fi
# shellcheck source=ops/logging.sh
source "$HELPERS_DIR/logging.sh"

# ── Install Nginx vhost ──────────────────────────────────
# Extrait de install_nginx() de sokar-deploy-root.sh.
# Migre les echo vers log_* pour cohérence.
#
# Paramètres :
#   $1 — root       : /opt/sokar | /opt/sokar-staging
#   $2 — vhost      : sokar | sokar-staging
#   $3 — environment : prod | staging
#   $4 — cert_root  : /etc/letsencrypt/live/suppernote.com (certificat d'origine Cloudflare *.suppernote.com, prod et staging)
#
# Retourne 0 en cas de succès, 1 si nginx -t échoue.
install_nginx_vhost() {
    local root="$1"
    local vhost="$2"
    local environment="$3"
    local cert_root="$4"
    local _nginx_restore_done=false
    cleanup_install_nginx() {
        if [ "$_nginx_restore_done" = false ]; then
            restore_nginx_vhost "$vhost" "$environment"
        fi
    }
    # Ensure the previous Nginx vhost is restored if any command below fails
    # before the new config is confirmed valid (DEP-013).
    trap cleanup_install_nginx EXIT

    log info "Installing Nginx vhost '$vhost' ($environment)..."
    install -d -m 0755 /etc/nginx/snippets /etc/nginx/sites-available /etc/nginx/sites-enabled
    install -m 0644 "$root/infra/nginx/snippets/sokar-proxy.conf" /etc/nginx/snippets/sokar-proxy.conf
    install -m 0644 "$root/infra/nginx/snippets/sokar-cloudflare-real-ip.conf" /etc/nginx/snippets/sokar-cloudflare-real-ip.conf
    install -m 0644 "$root/infra/nginx/snippets/sokar-security-headers.conf" /etc/nginx/snippets/sokar-security-headers.conf

    if [ -f "/etc/nginx/sites-available/$vhost" ]; then
        install -m 0644 "/etc/nginx/sites-available/$vhost" "/etc/nginx/sites-available/$vhost.bak"
    fi

    if [ "$environment" = "prod" ]; then
        install -m 0644 "$root/infra/nginx/sokar.conf" "/etc/nginx/sites-available/$vhost"
        ln -sfn "/etc/nginx/sites-available/$vhost" "/etc/nginx/sites-enabled/$vhost"
    else
        install -m 0644 "$root/infra/nginx/sokar-staging.conf" "/etc/nginx/sites-available/$vhost"
        install -m 0644 "$root/infra/nginx/sokar-staging.conf" "/etc/nginx/sites-enabled/$vhost"
    fi

    if ! nginx -t; then
        log_error "nginx -t failed — restoring previous vhost"
        restore_nginx_vhost "$vhost" "$environment"
        _nginx_restore_done=true
        if nginx -t; then
            systemctl reload nginx || true
        fi
        trap - EXIT
        return 1
    fi

    find "/etc/nginx/sites-available" -maxdepth 1 -type f -name "$vhost.bak" -delete
    _nginx_restore_done=true
    trap - EXIT
    log_ok "Nginx vhost '$vhost' installed"
}

# ── Restore Nginx vhost ──────────────────────────────────
# Extrait de restore_nginx() de sokar-deploy-root.sh.
#
# Paramètres :
#   $1 — vhost       : sokar | sokar-staging
#   $2 — environment : prod | staging
restore_nginx_vhost() {
    local vhost="$1"
    local environment="$2"
    if [ -f "/etc/nginx/sites-available/$vhost.bak" ]; then
        log info "Restoring Nginx vhost '$vhost' from backup..."
        install -m 0644 "/etc/nginx/sites-available/$vhost.bak" "/etc/nginx/sites-available/$vhost"
        if [ "$environment" = "prod" ]; then
            ln -sfn "/etc/nginx/sites-available/$vhost" "/etc/nginx/sites-enabled/$vhost"
        else
            install -m 0644 "/etc/nginx/sites-available/$vhost.bak" "/etc/nginx/sites-enabled/$vhost"
        fi
    fi
}
