#!/usr/bin/env bash
# rename-sokar-to-suppernote.sh — renommage serveur sokar → suppernote (palier 1), à lancer en ROOT.
#
# Usage :
#   sudo bash /root/rename/rename-sokar-to-suppernote.sh <commande> --env <staging|prod|all> [--dry-run]
#
# Commandes :
#   preflight        contrôles en lecture seule (rien n'est modifié)
#   apply            préflight + renommage de l'environnement (idempotent)
#   rollback         retour arrière complet de l'environnement (idempotent, reprend un apply interrompu)
#   status           état de chaque élément : ancien / nouveau / lien de compatibilité / absent
#   cleanup-compat   retire les liens de compatibilité et l'ancien chemin sudoers
#                    (refuse avant le 30/11/2026 sauf --force ; JAMAIS lancé par apply)
#
# Options : --dry-run (n'écrit rien, affiche chaque commande qui serait lancée),
#           --force (cleanup-compat avant le 30/11), --patch-debug-log-path (cleanup-compat : voir plus bas).
#
# Le script doit être copié HORS de /opt/sokar* (il déplace ces dossiers) : `cp` vers /root/rename/.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# PÉRIMÈTRE : palier 1 uniquement (chemins, PM2, nginx, cron, sbin, logrotate, sudoers).
# JAMAIS touchés : bases/rôles Postgres, buckets R2/remote rclone, variables d'environnement (noms
# et valeurs, dont les .env), secrets GitHub, slugs chez-sokar-demo, jobs Prometheus, hostname,
# domaines sokar.tech (certificats, server_name), upstreams nginx sokar_*, conteneurs et projet
# Docker du monitoring, dumps `sokar-*.dump`, message R2 « Backup offsite sokar terminé »,
# noms de variables shell (SOKAR_ROOT) des scripts installés.
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# PAR ENVIRONNEMENT (renommé par `--env` correspondant)           PARTAGÉ (renommé par la 1re exécution)
#   prod    : /opt/sokar, /var/backups/sokar, pm2 sokar-*,            /etc/sokar, /var/log/sokar, /var/lib/sokar,
#             site nginx sokar (available + enabled),                 sbin sokar-deploy-root (+ lien compat),
#             cron sokar-postgres-backup,                             sbin sokar-watchdog + cron sokar-watchdog,
#             sbin sokar-backup-postgres                              cron sokar-r2-backup, /etc/logrotate.d/sokar,
#   staging : /opt/sokar-staging, /var/backups/sokar-staging,         snippets nginx sokar-{proxy,security-headers,
#             pm2 sokar-staging-*, site nginx sokar-staging,          cloudflare-real-ip}.conf, ligne sudoers
#             cron sokar-staging-postgres-backup,                     suppernote-deploy-root (l'ancienne est gardée)
#             sbin sokar-staging-backup-postgres
#
# ORDRE : `apply --env staging` d'abord (il renomme aussi le PARTAGÉ), validation, puis `apply --env prod`.
# `apply --env all` enchaîne staging puis prod sans pause (déconseillé en fenêtre : préférez deux étapes).
# `rollback --env all` défait prod puis staging. `rollback --env prod` seul laisse staging (et le
# partagé) renommés ; le partagé n'est défait que quand le DERNIER environnement revient en arrière.
#
# La prod reste fonctionnelle sous ses anciens noms tant que `--env prod` n'a pas tourné :
#  - les dossiers partagés renommés gardent un lien ancien → nouveau (/etc/sokar, /var/log/sokar, …) ;
#  - SNIPPETS NGINX (solution retenue, la plus sûre) : renommés par la 1re exécution, avec un lien de
#    compatibilité `snippets/sokar-X.conf → suppernote-X.conf` tant qu'AU MOINS UN site nginx
#    référence encore l'ancien nom. Le site prod (71 includes) continue donc de passer `nginx -t`.
#    Les liens sont retirés automatiquement (grep des références) quand plus aucun site n'en a besoin ;
#    ils sont recréés si un retour arrière réintroduit un ancien nom. nginx suit les liens à
#    l'`include` comme pour sites-enabled ; le `nginx -t` réel est de toute façon exécuté avant
#    et après les modifications, et toute erreur déclenche la restauration automatique ;
#  - un fichier PARTAGÉ n'est patché que pour les chaînes dont la cible existe déjà : par exemple
#    `/opt/sokar` → `/opt/suppernote` dans le watchdog n'est écrit que quand /opt/suppernote existe
#    (donc au passage `--env prod`). Un contenu patché ne référence jamais un chemin absent ;
#  - les fichiers propres à un environnement (site nginx, cron, sbin de backup) ne sont touchés
#    que par l'exécution de cet environnement.
#
# SÉQUENCE `apply` par environnement :
#   préflight automatique → sauvegarde de l'ecosystem d'origine → suspension du cron watchdog
#   (renommage en `.rename-hold` : cron ignore les noms avec un point ; remis par un trap EXIT
#   même en cas d'échec) → pm2 stop (sudo -u deploy) de CET environnement seulement → renommage
#   des dossiers + liens → renommage des fichiers système (cron/sbin/logrotate/snippets/sites :
#   DÉPLACÉS, jamais copiés) → patch borné des fichiers (sed limité aux chaînes de la table, jamais
#   de sed global sur /etc, sauvegarde préalable de chaque fichier) → sudoers (visudo -cf avant
#   installation) → nginx -t (reload seulement si OK ; sinon RETOUR ARRIÈRE AUTOMATIQUE de
#   l'environnement et code de sortie 4) → pm2 delete des anciens noms + pm2 start des nouveaux
#   (ecosystem du dossier renommé, transformé en fichier temporaire si c'est l'ancienne version)
#   + pm2 save → remise du cron watchdog → vérifications (pm2 online, /health, curl local) + résumé.
#   Pas de recréation de conteneur : le préflight serveur (H22–H24) l'exclut (bind mounts conservés
#   par le mv, recréation attendue au prochain déploiement). Le préflight les liste seulement.
#
# JOURNAL : /root/rename-suppernote-<horodatage>/ (mode 0700) : run.log, manifest.tsv (actions),
# backup/ (copie de chaque fichier avant modification), ecosystem-orig/. Aucun secret n'est lu
# ni imprimé : les .env, watchdog.env, grafana.env ne sont jamais ouverts (seuls les noms de
# fichiers qui contiennent un ancien chemin sont signalés).
#
# ROLLBACK : piloté par l'ÉTAT RÉEL de chaque élément (pas par un rejeu aveugle du journal) :
# il fonctionne donc après un apply interrompu et peut être relancé sans effet. Il utilise
# l'ecosystem d'origine sauvegardé dans le journal (sinon l'ecosystem du dossier, retransformé).
#
# CODES DE SORTIE : 0 ok · 1 usage · 2 pas root · 3 préflight en échec (rien modifié)
#   4 nginx -t en échec (retour arrière automatique fait) · 5 apply fait mais vérifications en échec
#   (décision de retour arrière à prendre) · 6 erreur inattendue (retour arrière automatique tenté)
#
# TESTS : `RENAME_ROOT_PREFIX=/chemin/bac-a-sable` préfixe tous les chemins système ; pm2, nginx,
# systemctl, docker, sudo, visudo, curl, pgrep sont résolus par PATH (stubs). Voir
# scripts/ops/test-rename-sokar-to-suppernote.sh. Sans préfixe, root est obligatoire.

set -Eeuo pipefail

# ── Configuration ────────────────────────────────────────────────────────────────────────────
P="${RENAME_ROOT_PREFIX:-}"
P="${P%/}"
RUN_BASE="$P/root"
DEPLOY_HOME="$P/home/deploy"
LOCK_DIR="$P/var/lock/rename-sokar-to-suppernote.lock"
POLL_SLEEP="${RENAME_POLL_SLEEP:-3}"
VERIFY_TIMEOUT="${RENAME_VERIFY_TIMEOUT:-90}"
MIN_FREE_KB="${RENAME_MIN_FREE_KB:-1048576}"
CLEANUP_NOT_BEFORE="2026-11-30"
OLD_RX='(/opt|/var/log|/var/lib|/var/backups|/etc)/sokar|/usr/local/sbin/sokar|cron\.d/sokar|snippets/sokar-|logrotate\.d/sokar'

CMD=""
ENV_ARG=""
DRY=0
FORCE=0
PATCH_DEBUG=0
CUR_ENV=""
STEP="initialisation"
PHASE="pre"
CHANGED=0
AUTO_RB=0
ASSUME_SCOPES=""
RUN_DIR=""
LOG=""
MANIFEST=""
WORK=""
ECO_DIR=""
WD_HELD=0
LOCK_HELD=0
PM2_MODE="direct"
PF_FAIL=0
PF_WARN=0
PM2_CHANGED=0
NGINX_RELOADED=0
RB_FAIL=0
VERIFY_FAIL=0
SHARED_RB=0
DRY_DONE=" "

# ── Journal ──────────────────────────────────────────────────────────────────────────────────
log() {
    local m
    m="[$(date +%H:%M:%S)] $*"
    printf '%s\n' "$m"
    if [ -n "$LOG" ]; then
        printf '%s\n' "$m" >>"$LOG"
    fi
    return 0
}

die() {
    local code="$1"
    shift
    log "ERREUR : $*"
    exit "$code"
}

manifest() {
    if [ -n "$MANIFEST" ] && [ "$DRY" = 0 ]; then
        printf '%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${CUR_ENV:--}" "$1" "$2" >>"$MANIFEST"
    fi
    return 0
}

quote() { printf '%q ' "$@"; }

# Exécute la commande (échec fatal) ou l'affiche en --dry-run.
run() {
    local shown
    if [ "$1" = pm2_run ]; then
        shown="sudo -u deploy -H pm2 $(quote "${@:2}")"
    else
        shown="$(quote "$@")"
    fi
    if [ "$DRY" = 1 ]; then
        log "[dry-run] $shown"
        return 0
    fi
    log "+ $shown"
    if [ -n "$LOG" ]; then
        "$@" </dev/null 2>&1 | tee -a "$LOG"
    else
        "$@" </dev/null 2>&1
    fi
}

# Comme run mais l'échec est compté et n'arrête pas (retour arrière : aller le plus loin possible).
try() {
    if run "$@"; then
        return 0
    fi
    RB_FAIL=$((RB_FAIL + 1))
    log "AVERTISSEMENT : commande en échec (poursuite du retour arrière) : $(quote "$@")"
    return 0
}

pf_ok() { log "  OK       $*"; }
pf_warn() {
    PF_WARN=$((PF_WARN + 1))
    log "  ATTENTION $*"
}
pf_fail() {
    PF_FAIL=$((PF_FAIL + 1))
    log "  ÉCHEC    $*"
}

# ── Table des éléments : id|portée|type|ancien|nouveau ───────────────────────────────────────
# Types : dir (mv + lien compat) · linkfile (mv + lien compat) · file (mv) · snippet (mv, lien
# compat géré par reconcile_snippets) · enabled (lien ou copie de sites-enabled).
elements() {
    cat <<EOF
etc|shared|dir|$P/etc/sokar|$P/etc/suppernote
varlog|shared|dir|$P/var/log/sokar|$P/var/log/suppernote
varlib|shared|dir|$P/var/lib/sokar|$P/var/lib/suppernote
bak_prod|prod|dir|$P/var/backups/sokar|$P/var/backups/suppernote
bak_staging|staging|dir|$P/var/backups/sokar-staging|$P/var/backups/suppernote-staging
opt_prod|prod|dir|$P/opt/sokar|$P/opt/suppernote
opt_staging|staging|dir|$P/opt/sokar-staging|$P/opt/suppernote-staging
sbin_deploy|shared|linkfile|$P/usr/local/sbin/sokar-deploy-root|$P/usr/local/sbin/suppernote-deploy-root
sbin_watchdog|shared|file|$P/usr/local/sbin/sokar-watchdog|$P/usr/local/sbin/suppernote-watchdog
sbin_backup|prod|file|$P/usr/local/sbin/sokar-backup-postgres|$P/usr/local/sbin/suppernote-backup-postgres
sbin_stbackup|staging|file|$P/usr/local/sbin/sokar-staging-backup-postgres|$P/usr/local/sbin/suppernote-staging-backup-postgres
cron_r2|shared|file|$P/etc/cron.d/sokar-r2-backup|$P/etc/cron.d/suppernote-r2-backup
cron_pgbackup|prod|file|$P/etc/cron.d/sokar-postgres-backup|$P/etc/cron.d/suppernote-postgres-backup
cron_stpgbackup|staging|file|$P/etc/cron.d/sokar-staging-postgres-backup|$P/etc/cron.d/suppernote-staging-postgres-backup
logrotate|shared|file|$P/etc/logrotate.d/sokar|$P/etc/logrotate.d/suppernote
snip_proxy|shared|snippet|$P/etc/nginx/snippets/sokar-proxy.conf|$P/etc/nginx/snippets/suppernote-proxy.conf
snip_headers|shared|snippet|$P/etc/nginx/snippets/sokar-security-headers.conf|$P/etc/nginx/snippets/suppernote-security-headers.conf
snip_realip|shared|snippet|$P/etc/nginx/snippets/sokar-cloudflare-real-ip.conf|$P/etc/nginx/snippets/suppernote-cloudflare-real-ip.conf
site_prod_av|prod|file|$P/etc/nginx/sites-available/sokar|$P/etc/nginx/sites-available/suppernote
site_prod_en|prod|enabled|$P/etc/nginx/sites-enabled/sokar|$P/etc/nginx/sites-enabled/suppernote
site_st_av|staging|file|$P/etc/nginx/sites-available/sokar-staging|$P/etc/nginx/sites-available/suppernote-staging
site_st_en|staging|enabled|$P/etc/nginx/sites-enabled/sokar-staging|$P/etc/nginx/sites-enabled/suppernote-staging
EOF
}

# Règles de contenu : porte (élément qui doit déjà exister côté nouveau)|portée|ancien|nouveau.
# Seules ces chaînes sont réécrites (borne droite : pas de [A-Za-z0-9_-]), jamais de sed global.
rules_table() {
    cat <<'EOF'
opt_staging|staging|/opt/sokar-staging|/opt/suppernote-staging
opt_prod|prod|/opt/sokar|/opt/suppernote
bak_staging|staging|/var/backups/sokar-staging|/var/backups/suppernote-staging
bak_prod|prod|/var/backups/sokar|/var/backups/suppernote
varlog|shared|/var/log/sokar|/var/log/suppernote
varlib|shared|/var/lib/sokar|/var/lib/suppernote
etc|shared|/etc/sokar|/etc/suppernote
sbin_deploy|shared|sokar-deploy-root|suppernote-deploy-root
sbin_watchdog|shared|sokar-watchdog|suppernote-watchdog
sbin_stbackup|staging|sokar-staging-backup-postgres|suppernote-staging-backup-postgres
sbin_backup|prod|sokar-backup-postgres|suppernote-backup-postgres
cron_r2|shared|sokar-r2-backup|suppernote-r2-backup
cron_stpgbackup|staging|sokar-staging-postgres-backup|suppernote-staging-postgres-backup
cron_pgbackup|prod|sokar-postgres-backup|suppernote-postgres-backup
logrotate|shared|logrotate.d/sokar|logrotate.d/suppernote
logrotate|shared|logrotate/sokar|logrotate/suppernote
snip_proxy|shared|sokar-proxy.conf|suppernote-proxy.conf
snip_headers|shared|sokar-security-headers.conf|suppernote-security-headers.conf
snip_realip|shared|sokar-cloudflare-real-ip.conf|suppernote-cloudflare-real-ip.conf
site_prod_av|prod|VHOST="sokar"|VHOST="suppernote"
site_st_av|staging|VHOST="sokar-staging"|VHOST="suppernote-staging"
opt_staging|staging|sokar-staging-api|suppernote-staging-api
opt_staging|staging|sokar-staging-workers|suppernote-staging-workers
opt_staging|staging|sokar-staging-dashboard|suppernote-staging-dashboard
opt_staging|staging|sokar-staging-connect|suppernote-staging-connect
opt_prod|prod|sokar-api|suppernote-api
opt_prod|prod|sokar-workers|suppernote-workers
opt_prod|prod|sokar-dashboard|suppernote-dashboard
opt_prod|prod|sokar-connect|suppernote-connect
EOF
}

# Noms PM2 : ancien/nouveau par environnement.
pm2_old_names() {
    if [ "$1" = prod ]; then
        echo "sokar-api sokar-workers sokar-dashboard sokar-connect"
    else
        echo "sokar-staging-api sokar-staging-workers sokar-staging-dashboard sokar-staging-connect"
    fi
}
pm2_new_names() {
    if [ "$1" = prod ]; then
        echo "suppernote-api suppernote-workers suppernote-dashboard suppernote-connect"
    else
        echo "suppernote-staging-api suppernote-staging-workers suppernote-staging-dashboard suppernote-staging-connect"
    fi
}

env_port_api() { if [ "$1" = prod ]; then echo 4000; else echo 4100; fi; }
env_port_dash() { if [ "$1" = prod ]; then echo 3000; else echo 3100; fi; }
env_port_connect() { if [ "$1" = prod ]; then echo 4002; else echo 4102; fi; }
env_host_api() { if [ "$1" = prod ]; then echo api.suppernote.com; else echo api-staging.suppernote.com; fi; }

# Charge un élément dans EL_*.
el_load() {
    local line
    line="$(elements | grep "^$1|" || true)"
    [ -n "$line" ] || return 1
    IFS='|' read -r _ EL_SCOPE EL_KIND EL_OLD EL_NEW <<<"$line"
}

# Éléments d'une portée (une ligne par élément) : 'shared' ou 'prod' ou 'staging'.
el_ids() { elements | awk -F'|' -v s="$1" '$2 == s {print $1}'; }
el_ids_kind() { elements | awk -F'|' -v s="$1" -v k="$2" '$2 == s && $3 == k {print $1}'; }

path_kind() { # none | link | real
    if [ -L "$1" ]; then
        echo link
    elif [ -e "$1" ]; then
        echo real
    else
        echo none
    fi
}

# État : todo | done | done-nolink | absent | conflict
el_state() {
    local kind="$1" old="$2" new="$3" o n
    o="$(path_kind "$old")"
    n="$(path_kind "$new")"
    case "$o/$n" in
        real/none) echo todo ;;
        link/none)
            if [ "$kind" = enabled ]; then echo todo; else echo conflict; fi
            ;;
        none/real | none/link)
            case "$kind" in
                dir | linkfile) echo done-nolink ;;
                *) echo 'done' ;;
            esac
            ;;
        link/real)
            case "$kind" in
                dir | linkfile | snippet)
                    if [ "$(readlink "$old")" = "$new" ]; then echo "done"; else echo conflict; fi
                    ;;
                *) echo conflict ;;
            esac
            ;;
        none/none) echo absent ;;
        *) echo conflict ;;
    esac
}

el_state_id() {
    el_load "$1"
    el_state "$EL_KIND" "$EL_OLD" "$EL_NEW"
}

# Chemin courant d'un élément (nouveau s'il existe, sinon ancien).
cur_path() {
    el_load "$1"
    if [ -e "$EL_NEW" ] || [ -L "$EL_NEW" ]; then echo "$EL_NEW"; else echo "$EL_OLD"; fi
}

# Une règle est applicable quand sa cible existe (ou est supposée l'être en --dry-run).
gate_ok() {
    el_load "$1" || return 1
    if [ -e "$EL_NEW" ] || [ -L "$EL_NEW" ]; then return 0; fi
    if [ "$DRY" = 1 ]; then
        case " $ASSUME_SCOPES " in *" $EL_SCOPE "*) return 0 ;; esac
    fi
    return 1
}

# shellcheck disable=SC2016
rx_escape() { printf '%s' "$1" | sed 's/[.[\*^$()+?{|]/\\&/g'; }

# build_rules <fwd|rev> "<portées>" <fichier sed>
build_rules() {
    local dir="$1" scopes="$2" out="$3" gate scope old new from to
    : >"$out"
    while IFS='|' read -r gate scope old new; do
        case " $scopes " in *" $scope "*) ;; *) continue ;; esac
        if [ "$dir" = fwd ]; then
            gate_ok "$gate" || continue
            from="$old"
            to="$new"
        else
            from="$new"
            to="$old"
        fi
        printf 's#%s([^A-Za-z0-9_-]|$)#%s\\1#g\n' "$(rx_escape "$from")" "$to" >>"$out"
    done < <(rules_table)
}

backup_once() {
    local f="$1" dst
    [ -n "$RUN_DIR" ] || return 0
    dst="$RUN_DIR/backup${f#"$P"}"
    if [ -e "$dst" ] || [ -L "$dst" ]; then return 0; fi
    mkdir -p "$(dirname "$dst")"
    cp -pP "$f" "$dst"
}

# patch_file <fichier> <fwd|rev> "<portées>"
patch_file() {
    local f="$1" dir="$2" scopes="$3" rules tmp n
    if [ ! -f "$f" ] || [ -L "$f" ]; then return 0; fi
    rules="$WORK/rules.sed"
    tmp="$WORK/patch.tmp"
    build_rules "$dir" "$scopes" "$rules"
    [ -s "$rules" ] || return 0
    LC_ALL=C sed -E -f "$rules" "$f" >"$tmp"
    if cmp -s "$f" "$tmp"; then return 0; fi
    n="$(diff "$f" "$tmp" | grep -c '^>' || true)"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] patch ${f#"$P"} ($n ligne(s) modifiée(s))"
        return 0
    fi
    backup_once "$f"
    cat "$tmp" >"$f"
    CHANGED=1
    log "patch ${f#"$P"} ($n ligne(s))"
    manifest patch "${f#"$P"}"
}

# ── Utilitaires système ──────────────────────────────────────────────────────────────────────
fs_id() { stat -c %d "$1" 2>/dev/null || stat -f %d "$1" 2>/dev/null; }
free_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 {print $4}'; }

http_code() {
    local c
    c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$@" 2>/dev/null || true)"
    case "$c" in
        [0-9][0-9][0-9]) echo "$c" ;;
        *) echo 000 ;;
    esac
}

nginx_test() {
    if nginx -t >"$WORK/nginx.out" 2>&1; then return 0; fi
    return 1
}

nginx_show_error() {
    local l
    while IFS= read -r l; do log "    nginx: $l"; done < <(tail -n 8 "$WORK/nginx.out")
}

pm2_run() {
    # cd / : sudo -u deploy conserve le répertoire courant (souvent /root, illisible pour deploy) et
    # node plante sur process.cwd() dans un dossier inaccessible.
    if [ "$PM2_MODE" = login ]; then
        (cd / && sudo -n -u deploy -H bash -lc 'pm2 "$@"' pm2 "$@")
    else
        (cd / && sudo -n -u deploy -H pm2 "$@")
    fi
}

# Choisit l'invocation de pm2 pour l'utilisateur deploy : direct (sudo -u deploy pm2) sinon shell de login.
detect_pm2_mode() {
    PM2_MODE="direct"
    if pm2_run -v >/dev/null 2>&1 </dev/null; then return 0; fi
    PM2_MODE="login"
    if pm2_run -v >/dev/null 2>&1 </dev/null; then return 0; fi
    PM2_MODE="direct"
}

# Écrit dans $WORK/pm2.snap une ligne « nom statut » par process (jlist, parsing tolérant au bruit).
pm2_snapshot() {
    local raw line name rest st
    : >"$WORK/pm2.snap"
    raw="$WORK/pm2.raw"
    if ! pm2_run jlist >"$raw" 2>/dev/null </dev/null; then return 1; fi
    while IFS= read -r line; do
        case "$line" in
            '{"pid":'*)
                name="${line#*\"name\":\"}"
                name="${name%%\"*}"
                rest="${line#*\"status\":\"}"
                st="${rest%%\"*}"
                printf '%s %s\n' "$name" "$st" >>"$WORK/pm2.snap"
                ;;
        esac
    done < <(tr -d '\r' <"$raw" | sed 's/{"pid":/\
{"pid":/g')
    return 0
}

pm2_status() { # nom → online|stopped|…|absent
    local s
    s="$(awk -v n="$1" '$1 == n {print $2; exit}' "$WORK/pm2.snap")"
    echo "${s:-absent}"
}

# ── Watchdog : suspension du cron pendant l'opération ────────────────────────────────────────
WD_CRON_OLD=""
WD_CRON_NEW=""
init_wd_paths() {
    WD_CRON_OLD="$P/etc/cron.d/sokar-watchdog"
    WD_CRON_NEW="$P/etc/cron.d/suppernote-watchdog"
}

wd_wait_idle() {
    local i=0
    command -v pgrep >/dev/null 2>&1 || return 0
    while pgrep -f "$P/usr/local/sbin/(sokar|suppernote)-watchdog" >/dev/null 2>&1; do
        i=$((i + 1))
        if [ "$i" -gt 30 ]; then
            log "AVERTISSEMENT : un watchdog tourne encore après 60 s ; poursuite (cron suspendu)."
            return 0
        fi
        log "attente de la fin d'un passage du watchdog en cours…"
        sleep 2
    done
}

wd_suspend() {
    local src=""
    if [ "$WD_HELD" = 1 ]; then return 0; fi
    if [ -f "$WD_CRON_NEW.rename-hold" ] || [ -f "$WD_CRON_OLD.rename-hold" ]; then
        log "cron watchdog déjà suspendu par une exécution précédente : repris."
        WD_HELD=1
        return 0
    fi
    if [ -f "$WD_CRON_NEW" ]; then
        src="$WD_CRON_NEW"
    elif [ -f "$WD_CRON_OLD" ]; then
        src="$WD_CRON_OLD"
    fi
    if [ -z "$src" ]; then
        log "AVERTISSEMENT : aucun cron watchdog dans ${WD_CRON_OLD%/*} (rien à suspendre)."
        return 0
    fi
    wd_wait_idle
    run mv "$src" "$src.rename-hold"
    manifest watchdog-suspend "${src#"$P"}"
    if [ "$DRY" = 0 ]; then WD_HELD=1; fi
}

# Remet le cron watchdog sous le nom qui correspond à l'état réel du script sbin, après patch.
# WD_PASS_DIR / WD_PASS_SCOPES : sens et portées du patch à appliquer au contenu du cron.
WD_PASS_DIR="fwd"
WD_PASS_SCOPES="shared prod staging"
wd_finalize() {
    local held="" target
    [ "$WD_HELD" = 1 ] || return 0
    if [ -f "$WD_CRON_NEW.rename-hold" ]; then
        held="$WD_CRON_NEW.rename-hold"
    elif [ -f "$WD_CRON_OLD.rename-hold" ]; then
        held="$WD_CRON_OLD.rename-hold"
    fi
    if [ -z "$held" ]; then
        WD_HELD=0
        return 0
    fi
    patch_file "$held" "$WD_PASS_DIR" "$WD_PASS_SCOPES"
    if [ -e "$P/usr/local/sbin/suppernote-watchdog" ]; then
        target="$WD_CRON_NEW"
    else
        target="$WD_CRON_OLD"
    fi
    if [ "$held" != "$target.rename-hold" ]; then
        log "cron watchdog : ${held%.rename-hold} → ${target#"$P"}"
    fi
    mv "$held" "$target"
    manifest watchdog-resume "${target#"$P"}"
    log "cron watchdog remis en service : ${target#"$P"}"
    WD_HELD=0
}

# ── nginx : liens de compatibilité des snippets ──────────────────────────────────────────────
snippet_referenced() { # nom ancien du snippet → 0 si un fichier nginx le référence encore
    local base
    base="$(basename "$1")"
    grep -rIlF "snippets/$base" "$P/etc/nginx" --exclude-dir=snippets >/dev/null 2>&1
}

reconcile_snippets() {
    local id
    for id in $(el_ids_kind shared snippet); do
        el_load "$id"
        [ -e "$EL_NEW" ] && [ ! -L "$EL_NEW" ] || continue
        if snippet_referenced "$EL_OLD"; then
            if [ ! -e "$EL_OLD" ] && [ ! -L "$EL_OLD" ]; then
                run ln -s "$EL_NEW" "$EL_OLD"
                CHANGED=1
                manifest snippet-link "${EL_OLD#"$P"}"
            fi
        else
            if [ -L "$EL_OLD" ]; then
                run rm "$EL_OLD"
                CHANGED=1
                manifest snippet-unlink "${EL_OLD#"$P"}"
            fi
        fi
    done
}

# ── sudoers ──────────────────────────────────────────────────────────────────────────────────
SUDOERS="$P/etc/sudoers.d/deploy"
SUDO_RX_CODE='^[[:space:]]*[^#[:space:]].*'

sudoers_state() {
    if [ ! -f "$SUDOERS" ]; then
        echo absent
        return 0
    fi
    local o=0 n=0
    if grep -Eq "${SUDO_RX_CODE}sokar-deploy-root" "$SUDOERS"; then o=1; fi
    if grep -Eq "${SUDO_RX_CODE}suppernote-deploy-root" "$SUDOERS"; then n=1; fi
    case "$o$n" in
        10) echo ancien-seul ;;
        11) echo ancien+nouveau ;;
        01) echo nouveau-seul ;;
        *) echo aucun ;;
    esac
}

visudo_check_file() { visudo -cf "$1" >/dev/null 2>&1; }

sudoers_install() { # <candidat>
    local cand="$1"
    if ! visudo_check_file "$cand"; then
        log "ERREUR : visudo -cf refuse le candidat sudoers (rien n'est installé)."
        return 1
    fi
    backup_once "$SUDOERS"
    run install -m 0440 "$cand" "$SUDOERS"
    if ! visudo_check_file "$SUDOERS"; then
        log "ERREUR : visudo -cf refuse $SUDOERS après installation : restauration."
        if [ -n "$RUN_DIR" ] && [ -e "$RUN_DIR/backup${SUDOERS#"$P"}" ]; then
            install -m 0440 "$RUN_DIR/backup${SUDOERS#"$P"}" "$SUDOERS"
        fi
        return 1
    fi
    if [ -z "$P" ]; then
        visudo -c >/dev/null 2>&1 || {
            log "ERREUR : visudo -c global en échec."
            return 1
        }
    fi
    CHANGED=1
    manifest sudoers "$1"
}

sudoers_add_new() {
    local st cand
    st="$(sudoers_state)"
    case "$st" in
        absent)
            log "AVERTISSEMENT : $SUDOERS absent : ligne sudoers non ajoutée."
            return 0
            ;;
        ancien+nouveau | nouveau-seul) return 0 ;;
        aucun)
            log "AVERTISSEMENT : aucune ligne sokar-deploy-root dans sudoers : rien à doubler."
            return 0
            ;;
    esac
    cand="$WORK/sudoers.cand"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] sudoers : ajouterait la ligne suppernote-deploy-root à côté de l'ancienne (visudo -cf avant installation)"
        return 0
    fi
    sed -E "/${SUDO_RX_CODE}sokar-deploy-root/{
p
s#sokar-deploy-root#suppernote-deploy-root#
}" "$SUDOERS" >"$cand"
    sudoers_install "$cand"
}

sudoers_remove() { # <ancien|nouveau> : retire les lignes de code de ce chemin
    local which="$1" name cand
    case "$which" in
        ancien) name="sokar-deploy-root" ;;
        *) name="suppernote-deploy-root" ;;
    esac
    [ -f "$SUDOERS" ] || return 0
    grep -Eq "${SUDO_RX_CODE}${name}" "$SUDOERS" || return 0
    cand="$WORK/sudoers.cand"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] sudoers : retirerait la ligne $name (visudo -cf avant installation)"
        return 0
    fi
    sed -E "/${SUDO_RX_CODE}${name}/d" "$SUDOERS" >"$cand"
    sudoers_install "$cand"
}

# ── Renommage des éléments ───────────────────────────────────────────────────────────────────
retarget_link() { # <lien existant> <nouveau lien> <base de départ> <base d'arrivée>
    local t nt
    t="$(readlink "$1")"
    nt="$(printf '%s' "$t" | sed "s#/$3\$#/$4#")"
    run ln -s "$nt" "$2"
    run rm "$1"
}

rename_forward() { # kind old new
    local kind="$1" old="$2" new="$3"
    case "$kind" in
        dir | linkfile)
            run mv "$old" "$new"
            run ln -s "$new" "$old"
            ;;
        file | snippet) run mv "$old" "$new" ;;
        enabled)
            if [ -L "$old" ]; then
                retarget_link "$old" "$new" "$(basename "$old")" "$(basename "$new")"
            else
                run mv "$old" "$new"
            fi
            ;;
    esac
    CHANGED=1
    manifest rename "${old#"$P"} -> ${new#"$P"}"
}

rename_backward() { # kind old new
    local kind="$1" old="$2" new="$3"
    case "$kind" in
        dir | linkfile | snippet)
            if [ -L "$old" ]; then try rm "$old"; fi
            try mv "$new" "$old"
            ;;
        file) try mv "$new" "$old" ;;
        enabled)
            if [ -L "$new" ]; then
                retarget_link "$new" "$old" "$(basename "$new")" "$(basename "$old")" || RB_FAIL=$((RB_FAIL + 1))
            else
                try mv "$new" "$old"
            fi
            ;;
    esac
    CHANGED=1
    manifest unrename "${new#"$P"} -> ${old#"$P"}"
}

# Ordre d'application : dossiers, puis fichiers.
KIND_ORDER="dir linkfile file snippet enabled"

apply_elements_of() { # portée
    local scope="$1" kind id st
    for kind in $KIND_ORDER; do
        for id in $(el_ids_kind "$scope" "$kind"); do
            el_load "$id"
            st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
            # --dry-run : un élément déjà « renommé » par l'environnement précédent du plan n'est pas rejoué.
            if [ "$DRY" = 1 ]; then
                case "$DRY_DONE" in *" $id "*) st='done' ;; esac
                if [ "$st" = todo ]; then DRY_DONE="$DRY_DONE$id "; fi
            fi
            case "$st" in
                todo) rename_forward "$EL_KIND" "$EL_OLD" "$EL_NEW" ;;
                done) ;;
                done-nolink)
                    log "lien de compatibilité manquant, recréé : ${EL_OLD#"$P"}"
                    run ln -s "$EL_NEW" "$EL_OLD"
                    CHANGED=1
                    ;;
                absent) log "AVERTISSEMENT : $id absent (ni ancien ni nouveau) : ignoré." ;;
                conflict) die 6 "$id en conflit : ${EL_OLD#"$P"} et ${EL_NEW#"$P"} existent." ;;
            esac
        done
    done
}

# Fichiers patchés par une exécution (propriétaire shared + env).
patch_targets() { # env
    local e="$1" id
    for id in sbin_deploy sbin_watchdog cron_r2 logrotate; do cur_path "$id"; done
    if [ "$e" = prod ]; then
        for id in sbin_backup cron_pgbackup site_prod_av site_prod_en; do cur_path "$id"; done
    else
        for id in sbin_stbackup cron_stpgbackup site_st_av site_st_en; do cur_path "$id"; done
    fi
}

# ── Ecosystem PM2 ────────────────────────────────────────────────────────────────────────────
eco_name() { if [ "$1" = prod ]; then echo ecosystem.config.js; else echo ecosystem.staging.config.js; fi; }

eco_root_new() { if [ "$1" = prod ]; then echo "$P/opt/suppernote"; else echo "$P/opt/suppernote-staging"; fi; }
eco_root_old() { if [ "$1" = prod ]; then echo "$P/opt/sokar"; else echo "$P/opt/sokar-staging"; fi; }

# Sauvegarde l'ecosystem d'origine (version à anciens noms) dans le journal.
save_ecosystem() {
    local e="$1" src dst
    [ "$DRY" = 0 ] || return 0
    src="$(eco_root_old "$e")/infra/$(eco_name "$e")"
    [ -f "$src" ] || src="$(eco_root_new "$e")/infra/$(eco_name "$e")"
    [ -f "$src" ] || return 0
    if grep -Eq "name:[[:space:]]*['\"]sokar-" "$src"; then
        dst="$RUN_DIR/ecosystem-orig/$e.config.js"
        mkdir -p "$RUN_DIR/ecosystem-orig"
        cp -p "$src" "$dst"
        log "ecosystem d'origine sauvegardé : ${dst#"$P"}"
    fi
}

# Retrouve le dernier ecosystem d'origine sauvegardé (anciens noms) pour un env.
find_saved_ecosystem() {
    local e="$1" f found=""
    for f in "$RUN_BASE"/rename-suppernote-*/ecosystem-orig/"$e".config.js; do
        [ -f "$f" ] || continue
        if grep -Eq "name:[[:space:]]*['\"]sokar-" "$f"; then found="$f"; fi
    done
    [ -n "$found" ] || return 1
    echo "$found"
}

# make_ecosystem <env> <fwd|rev> → positionne ECO_OUT : fichier lisible par deploy.
ECO_OUT=""
make_ecosystem() {
    local e="$1" dir="$2" src out rules
    if [ -z "$ECO_DIR" ]; then
        mkdir -p "$P/tmp"
        ECO_DIR="$(mktemp -d "$P/tmp/rename-suppernote-eco.XXXXXX")"
        chmod 0755 "$ECO_DIR"
    fi
    out="$ECO_DIR/$(eco_name "$e")"
    rules="$WORK/eco.sed"
    if [ "$dir" = fwd ]; then
        src="$(eco_root_new "$e")/infra/$(eco_name "$e")"
        [ -f "$src" ] || src="$(eco_root_old "$e")/infra/$(eco_name "$e")"
        build_rules fwd "shared prod staging" "$rules"
    else
        src="$(find_saved_ecosystem "$e" || true)"
        if [ -z "$src" ]; then
            src="$(eco_root_old "$e")/infra/$(eco_name "$e")"
            [ -f "$src" ] || src="$(eco_root_new "$e")/infra/$(eco_name "$e")"
        fi
        build_rules rev "shared prod staging" "$rules"
    fi
    [ -f "$src" ] || die 6 "ecosystem introuvable pour $e (cherché : ${src#"$P"})"
    LC_ALL=C sed -E -f "$rules" "$src" >"$out"
    chmod 0644 "$out"
    ECO_OUT="$out"
    if cmp -s "$src" "$out"; then
        log "ecosystem $e : ${src#"$P"} utilisé tel quel (déjà aux bons noms)"
    else
        log "ecosystem $e : ${src#"$P"} transformé → fichier temporaire"
    fi
    if [ -n "$RUN_DIR" ]; then
        cp -p "$out" "$RUN_DIR/ecosystem-used-$e-$dir.js"
    fi
}

# ── PM2 : arrêt, suppression, démarrage ──────────────────────────────────────────────────────
pm2_stop_env() { # env
    local e="$1" n list=""
    pm2_snapshot || die 6 "pm2 jlist inaccessible via sudo -u deploy"
    for n in $(pm2_old_names "$e"); do
        if [ "$(pm2_status "$n")" = online ]; then list="$list $n"; fi
    done
    if [ -z "$list" ]; then
        log "pm2 : aucun process ancien en ligne pour $e (rien à arrêter)"
        return 0
    fi
    # shellcheck disable=SC2086
    run pm2_run stop $list
    manifest pm2-stop "$list"
    PM2_CHANGED=1
    CHANGED=1
}

pm2_delete_olds() { # env
    local e="$1" n list=""
    pm2_snapshot || die 6 "pm2 jlist inaccessible"
    for n in $(pm2_old_names "$e"); do
        if [ "$(pm2_status "$n")" != absent ]; then list="$list $n"; fi
    done
    [ -n "$list" ] || return 0
    # shellcheck disable=SC2086
    run pm2_run delete $list
    manifest pm2-delete "$list"
    PM2_CHANGED=1
    CHANGED=1
}

pm2_delete_news() { # env (retour arrière)
    local e="$1" n list=""
    pm2_snapshot || {
        RB_FAIL=$((RB_FAIL + 1))
        log "AVERTISSEMENT : pm2 jlist inaccessible"
        return 0
    }
    for n in $(pm2_new_names "$e"); do
        if [ "$(pm2_status "$n")" != absent ]; then list="$list $n"; fi
    done
    [ -n "$list" ] || return 0
    # shellcheck disable=SC2086
    try pm2_run delete $list
    manifest pm2-delete "$list"
    PM2_CHANGED=1
}

# pm2_ensure <env> <old|new> <fwd|rev> : démarre ce qui manque, relance ce qui est arrêté.
pm2_ensure() {
    local e="$1" which="$2" dir="$3" n names st only=""
    if [ "$which" = new ]; then names="$(pm2_new_names "$e")"; else names="$(pm2_old_names "$e")"; fi
    pm2_snapshot || {
        RB_FAIL=$((RB_FAIL + 1))
        log "AVERTISSEMENT : pm2 jlist inaccessible"
        return 1
    }
    for n in $names; do
        st="$(pm2_status "$n")"
        case "$st" in
            online) ;;
            absent) only="${only:+$only,}$n" ;;
            *)
                try pm2_run restart "$n"
                PM2_CHANGED=1
                CHANGED=1
                ;;
        esac
    done
    if [ -n "$only" ]; then
        make_ecosystem "$e" "$dir"
        try pm2_run start "$ECO_OUT" --only "$only"
        manifest pm2-start "$only"
        PM2_CHANGED=1
        CHANGED=1
    fi
}

pm2_save() {
    if [ "$PM2_CHANGED" = 1 ]; then
        try pm2_run save
    else
        log "pm2 : aucun changement, pm2 save inutile"
    fi
}

# ── Vérifications ────────────────────────────────────────────────────────────────────────────
wait_online() { # nom… → 0 si tous online avant le délai
    local waited=0 n bad
    while :; do
        pm2_snapshot || return 1
        bad=""
        for n in "$@"; do
            [ "$(pm2_status "$n")" = online ] || bad="$bad $n"
        done
        [ -z "$bad" ] && return 0
        [ "$waited" -ge "$VERIFY_TIMEOUT" ] && {
            log "    pas online :$bad"
            return 1
        }
        sleep "$POLL_SLEEP"
        waited=$((waited + POLL_SLEEP + 1))
    done
}

wait_http() { # url attendu_ok(200|lt500) → code final sur stdout
    local url="$1" mode="$2" waited=0 code
    while :; do
        code="$(http_code "$url")"
        if [ "$mode" = 200 ] && [ "$code" = 200 ]; then break; fi
        if [ "$mode" = lt500 ] && [ "$code" != 000 ] && [ "$code" -lt 500 ]; then break; fi
        [ "$waited" -ge "$VERIFY_TIMEOUT" ] && break
        sleep "$POLL_SLEEP"
        waited=$((waited + POLL_SLEEP + 1))
    done
    echo "$code"
}

vcheck() { # libellé résultat(0=ok)
    if [ "$2" = 0 ]; then
        log "  OK       $1"
    else
        VERIFY_FAIL=$((VERIFY_FAIL + 1))
        log "  ÉCHEC    $1"
    fi
}

verify_env() { # env old|new
    local e="$1" which="$2" names code host
    if [ "$DRY" = 1 ]; then
        log "[dry-run] vérifications finales : pm2 online, /health (127.0.0.1:$(env_port_api "$e")), dashboard, connect, nginx local"
        return 0
    fi
    if [ "$which" = new ]; then names="$(pm2_new_names "$e")"; else names="$(pm2_old_names "$e")"; fi
    log "Vérifications $e ($which) :"
    # shellcheck disable=SC2086
    if wait_online $names; then vcheck "pm2 : 4 process online ($names)" 0; else vcheck "pm2 : process pas tous online ($names)" 1; fi
    code="$(wait_http "http://127.0.0.1:$(env_port_api "$e")/health" 200)"
    if [ "$code" = 200 ]; then vcheck "API /health 127.0.0.1:$(env_port_api "$e") → $code" 0; else vcheck "API /health 127.0.0.1:$(env_port_api "$e") → $code (attendu 200)" 1; fi
    code="$(wait_http "http://127.0.0.1:$(env_port_dash "$e")/" lt500)"
    if [ "$code" != 000 ] && [ "$code" -lt 500 ]; then vcheck "dashboard 127.0.0.1:$(env_port_dash "$e") → $code" 0; else vcheck "dashboard 127.0.0.1:$(env_port_dash "$e") → $code" 1; fi
    code="$(wait_http "http://127.0.0.1:$(env_port_connect "$e")/" lt500)"
    if [ "$code" != 000 ] && [ "$code" -lt 500 ]; then vcheck "connect 127.0.0.1:$(env_port_connect "$e") → $code" 0; else vcheck "connect 127.0.0.1:$(env_port_connect "$e") → $code" 1; fi
    host="$(env_host_api "$e")"
    code="$(http_code -k --resolve "$host:443:127.0.0.1" "https://$host/health")"
    if [ "$code" = 200 ]; then
        log "  OK       nginx local https://$host/health → $code"
    else
        log "  ATTENTION nginx local https://$host/health → $code (à contrôler : certificat, règles Cloudflare)"
    fi
}

# ── Préflight ────────────────────────────────────────────────────────────────────────────────
script_dir() { cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P; }

scan_unknown_refs() {
    local known hits
    known="$WORK/known.txt"
    {
        elements | awk -F'|' '{print $4; print $5}'
        echo "$WD_CRON_OLD"
        echo "$WD_CRON_NEW"
        echo "$WD_CRON_OLD.rename-hold"
        echo "$WD_CRON_NEW.rename-hold"
        echo "$SUDOERS"
    } >"$known"
    hits="$(
        {
            grep -rIlE "$OLD_RX" "$P/etc" "$P/usr/local/sbin" "$P/usr/local/bin" "$P/var/spool/cron" \
                "$DEPLOY_HOME/.bashrc" "$DEPLOY_HOME/.profile" "$P/root/.bashrc" "$P/root/.profile" \
                --exclude-dir=live --exclude-dir=archive --exclude-dir=private 2>/dev/null || true
        } | grep -vxF -f "$known" | sort -u || true
    )"
    printf '%s\n' "$hits"
}

preflight_env() { # env
    local e="$1" id st n o nw free sdir pp fsdir ids
    PF_FAIL=0
    PF_WARN=0
    log "Préflight $e :"

    # Script hors des dossiers déplacés.
    sdir="$(script_dir)"
    pp=""
    if [ -n "$P" ]; then pp="$(cd "$P" && pwd -P)"; fi
    case "$sdir" in
        "$pp"/opt/sokar | "$pp"/opt/sokar/* | "$pp"/opt/sokar-staging | "$pp"/opt/sokar-staging/* | "$pp"/opt/suppernote | "$pp"/opt/suppernote/* | "$pp"/opt/suppernote-staging | "$pp"/opt/suppernote-staging/*)
            pf_fail "le script tourne depuis ${sdir#"$pp"} (déplacé par le renommage) : copiez-le dans /root/rename/"
            ;;
        *) pf_ok "script hors de /opt (${sdir#"$pp"})" ;;
    esac

    # Outils.
    for n in nginx sudo curl sed awk grep df stat visudo systemctl; do
        if command -v "$n" >/dev/null 2>&1; then pf_ok "commande $n"; else pf_fail "commande $n introuvable"; fi
    done

    # Espace disque (le mv est atomique : seuls journal et sauvegardes consomment).
    fsdir="$RUN_BASE"
    [ -d "$fsdir" ] || fsdir="${P:-/}"
    free="$(free_kb "$fsdir")"
    if [ -n "$free" ] && [ "$free" -ge "$MIN_FREE_KB" ]; then
        pf_ok "espace libre sur ${fsdir#"$P"}/ : $((free / 1024)) Mo"
    else
        pf_fail "espace libre insuffisant sur ${fsdir#"$P"}/ (${free:-?} Ko, minimum $MIN_FREE_KB Ko)"
    fi

    # Même filesystem pour chaque dossier à déplacer (mv = rename(2) atomique).
    for id in $(el_ids_kind shared dir) $(el_ids_kind "$e" dir); do
        el_load "$id"
        st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
        if [ "$st" = todo ]; then
            o="$(fs_id "$EL_OLD")"
            nw="$(fs_id "$(dirname "$EL_NEW")")"
            if [ -n "$o" ] && [ "$o" = "$nw" ]; then
                pf_ok "même filesystem : ${EL_OLD#"$P"} (dev $o)"
            else
                pf_fail "filesystems différents pour ${EL_OLD#"$P"} ($o) et $(dirname "${EL_NEW#"$P"}") ($nw) : mv non atomique"
            fi
        fi
    done

    # État des éléments : conflits, cibles déjà présentes.
    ids="$(el_ids shared) $(el_ids "$e")"
    for id in $ids; do
        el_load "$id"
        st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
        case "$st" in
            conflict) pf_fail "$id : conflit entre ${EL_OLD#"$P"} et ${EL_NEW#"$P"} (cible déjà présente ?)" ;;
            absent) pf_warn "$id : ni ${EL_OLD#"$P"} ni ${EL_NEW#"$P"} (ignoré)" ;;
        esac
    done
    el_load "opt_$e"
    st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
    case "$st" in
        todo) pf_ok "dossier ${EL_OLD#"$P"} présent, ${EL_NEW#"$P"} inexistant" ;;
        done | done-nolink) pf_ok "dossier déjà renommé (${EL_NEW#"$P"}) : apply sera un no-op pour les dossiers" ;;
        *) pf_fail "dossier applicatif de $e introuvable ou en conflit" ;;
    esac

    # Cron watchdog : un seul exemplaire.
    n=0
    for o in "$WD_CRON_OLD" "$WD_CRON_NEW" "$WD_CRON_OLD.rename-hold" "$WD_CRON_NEW.rename-hold"; do
        if [ -f "$o" ]; then n=$((n + 1)); fi
    done
    if [ "$n" -le 1 ]; then pf_ok "cron watchdog : $n exemplaire"; else pf_fail "cron watchdog en $n exemplaires (doublon sokar/suppernote)"; fi
    if [ -f "$WD_CRON_OLD.rename-hold" ] || [ -f "$WD_CRON_NEW.rename-hold" ]; then
        pf_warn "un cron watchdog suspendu (.rename-hold) traîne : sera remis en service par apply/rollback"
    fi

    # sudoers.
    st="$(sudoers_state)"
    case "$st" in
        absent) pf_fail "$SUDOERS introuvable" ;;
        aucun) pf_warn "sudoers : aucune ligne code mentionnant sokar-deploy-root ni suppernote-deploy-root" ;;
        *) pf_ok "sudoers : $st" ;;
    esac
    if [ -f "$SUDOERS" ]; then
        if visudo_check_file "$SUDOERS"; then pf_ok "visudo -cf $SUDOERS"; else pf_fail "visudo -cf refuse le sudoers actuel"; fi
    fi

    # nginx actuel.
    if nginx_test; then
        pf_ok "nginx -t (état courant)"
    else
        pf_fail "nginx -t échoue avant toute modification"
        nginx_show_error
    fi

    # pm2 via deploy.
    detect_pm2_mode
    if pm2_run -v >/dev/null 2>&1 </dev/null; then
        if [ "$PM2_MODE" = login ]; then
            pf_warn "pm2 introuvable dans le PATH sudo : utilisation d'un shell de login deploy"
        else
            pf_ok "pm2 accessible via sudo -u deploy"
        fi
    else
        pf_fail "pm2 inaccessible via sudo -u deploy"
    fi
    if pm2_snapshot; then
        local found_old=0 found_new=0
        for n in $(pm2_old_names "$e"); do [ "$(pm2_status "$n")" = absent ] || found_old=$((found_old + 1)); done
        for n in $(pm2_new_names "$e"); do [ "$(pm2_status "$n")" = absent ] || found_new=$((found_new + 1)); done
        if [ $((found_old + found_new)) -eq 0 ]; then
            pf_fail "aucun process pm2 attendu pour $e (anciens ni nouveaux) : jlist non analysable ?"
        else
            pf_ok "pm2 $e : $found_old ancien(s), $found_new nouveau(x) process (sur 4 attendus)"
        fi
        if [ "$found_old" -gt 0 ] && [ "$found_new" -gt 0 ]; then
            pf_warn "pm2 $e : anciens ET nouveaux noms présents (apply partiel ?)"
        fi
    fi

    # Aucun déploiement en cours.
    if command -v pgrep >/dev/null 2>&1 && pgrep -f 'scripts/deploy\.sh|(sokar|suppernote)-deploy-root' >/dev/null 2>&1; then
        pf_fail "un déploiement semble en cours (deploy.sh ou *-deploy-root) : attendre ou geler les workflows"
    else
        pf_ok "aucun déploiement en cours (pgrep)"
    fi

    # Docker : informatif seulement.
    if command -v docker >/dev/null 2>&1; then
        local c cnt
        for c in $(docker ps --format '{{.Names}}' 2>/dev/null || true); do
            cnt="$(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$c" 2>/dev/null | grep -c "^$P/opt/sokar" || true)"
            if [ "${cnt:-0}" -gt 0 ]; then
                pf_warn "conteneur $c : $cnt bind mount(s) sous /opt/sokar* (inode conservé par le mv ; recréation au prochain déploiement, non requise ici)"
            fi
        done
        pf_ok "docker ps/inspect (lecture seule, aucune recréation de conteneur par ce script)"
    else
        pf_warn "docker absent du PATH : mounts non listés"
    fi

    # Références hors table (noms de fichiers uniquement, jamais de contenu).
    local unknown
    unknown="$(scan_unknown_refs)"
    if [ -n "$unknown" ]; then
        while IFS= read -r o; do
            [ -n "$o" ] || continue
            pf_warn "référence à un ancien chemin hors table (NON traitée par ce script) : ${o#"$P"}"
        done <<<"$unknown"
    else
        pf_ok "aucune référence à un ancien chemin hors table (/etc, sbin, crontabs)"
    fi
    if command -v crontab >/dev/null 2>&1 && [ -z "$P" ]; then
        if crontab -l -u root 2>/dev/null | grep -Eq "$OLD_RX"; then
            pf_warn "crontab root : référence à un ancien chemin (NON traitée : à adapter à la main)"
        else
            pf_ok "crontab root : aucune référence à un ancien chemin"
        fi
    fi

    log "Préflight $e : $PF_FAIL échec(s), $PF_WARN avertissement(s)."
}

# ── Apply ────────────────────────────────────────────────────────────────────────────────────
abort_apply() { # code message
    local code="$1"
    shift
    trap - ERR
    set +e
    log "ÉCHEC : $*"
    if [ "$PHASE" = pre ] && [ "$AUTO_RB" = 0 ] && [ "$DRY" = 0 ]; then
        AUTO_RB=1
        log "RETOUR ARRIÈRE AUTOMATIQUE de l'environnement $CUR_ENV (étape en cours : $STEP)…"
        rollback_env "$CUR_ENV"
        if [ "$RB_FAIL" -gt 0 ]; then
            log "ATTENTION : retour arrière incomplet ($RB_FAIL anomalie(s)). Voir le journal ${RUN_DIR#"$P"} et l'option B du runbook."
        else
            log "Retour arrière terminé : l'environnement $CUR_ENV est revenu à son état initial."
        fi
    else
        log "Aucun retour arrière automatique à ce stade (phase : $PHASE). Décision humaine : voir le runbook."
    fi
    exit "$code"
}

on_err() {
    local rc="$1" line="$2"
    trap - ERR
    if [ "$CMD" = apply ]; then
        abort_apply 6 "erreur inattendue (code $rc, ligne $line) à l'étape « $STEP »"
    fi
    log "ERREUR : code $rc ligne $line à l'étape « $STEP »"
    exit "$rc"
}

apply_env() { # env [skip-preflight]
    local e="$1" skip_pf="${2:-0}" id
    CUR_ENV="$e"
    PHASE="pre"
    CHANGED=0
    PM2_CHANGED=0
    NGINX_RELOADED=0
    ASSUME_SCOPES="${ASSUME_SCOPES:-shared} $e"
    log "══ APPLY $e ══"
    if [ "$DRY" = 1 ] && [ "$skip_pf" = 1 ] && [ "$e" != "$(envs_for apply | awk '{print $1}')" ]; then
        log "[dry-run] plan du 2e environnement : les éléments partagés déjà planifiés ne sont pas rejoués ; les comptes de lignes des patchs sont cumulés (les fichiers ne sont pas réellement modifiés)."
    fi

    STEP="préflight"
    if [ "$skip_pf" = 0 ]; then
        preflight_env "$e"
        if [ "$PF_FAIL" -gt 0 ]; then die 3 "préflight $e en échec : rien n'a été modifié."; fi
    fi

    STEP="sauvegarde de l'ecosystem"
    save_ecosystem "$e"

    STEP="suspension du watchdog"
    wd_suspend

    STEP="pm2 stop"
    pm2_stop_env "$e"

    STEP="renommage des dossiers et fichiers"
    apply_elements_of shared
    apply_elements_of "$e"

    STEP="patch des fichiers"
    WD_PASS_DIR="fwd"
    WD_PASS_SCOPES="shared prod staging"
    while IFS= read -r id; do
        [ -n "$id" ] || continue
        patch_file "$id" fwd "shared prod staging"
    done < <(patch_targets "$e")

    STEP="sudoers"
    sudoers_add_new

    STEP="liens de compatibilité nginx"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] snippets nginx : liens sokar-*.conf → suppernote-*.conf créés tant qu'un site référence l'ancien nom, retirés dès que plus aucun ne le fait"
    else
        reconcile_snippets
    fi

    STEP="nginx -t"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] nginx -t puis systemctl reload nginx (si OK) ; en cas d'échec : retour arrière automatique"
    elif nginx_test; then
        log "nginx -t OK"
        if [ "$CHANGED" = 1 ]; then
            run systemctl reload nginx
            NGINX_RELOADED=1
        fi
    else
        nginx_show_error
        abort_apply 4 "nginx -t échoue après les modifications (fichiers nginx restaurés par le retour arrière)."
    fi

    STEP="pm2 delete + start"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] pm2 delete $(pm2_old_names "$e") (s'ils existent) ; pm2 start <ecosystem transformé> --only $(pm2_new_names "$e" | tr ' ' ',') ; pm2 save"
    else
        pm2_delete_olds "$e"
        pm2_ensure "$e" new fwd
        if [ "$RB_FAIL" -gt 0 ]; then abort_apply 6 "pm2 start a échoué"; fi
        PHASE="post"
        pm2_save
    fi

    STEP="remise du watchdog"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] cron watchdog : patch du contenu puis remise sous le nom suppernote-watchdog (trap EXIT garantit la remise même en cas d'échec)"
    else
        wd_finalize
    fi

    STEP="vérifications"
    VERIFY_FAIL=0
    verify_env "$e" new
    if [ "$DRY" = 1 ]; then
        log "══ APPLY $e (dry-run) : plan affiché, rien n'a été modifié ══"
        return 0
    fi
    summary_env "$e"
    if [ "$VERIFY_FAIL" -gt 0 ]; then
        log "ATTENTION : $VERIFY_FAIL vérification(s) en échec pour $e. Règle du runbook : si l'API ne répond pas 200 à T+5 min, lancer rollback --env $e."
        exit 5
    fi
    log "══ APPLY $e terminé : tout est OK ══"
}

summary_env() { # env
    local e="$1" id st line
    log "Résumé $e (état des éléments) :"
    for id in $(el_ids shared) $(el_ids "$e"); do
        el_load "$id"
        st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
        line="$(printf '    %-16s %-12s %s' "$id" "$st" "${EL_NEW#"$P"}")"
        log "$line"
    done
    log "    sudoers          $(sudoers_state)"
    if [ "$DRY" = 0 ]; then
        log "    journal          ${RUN_DIR#"$P"}"
    fi
}

# ── Rollback ─────────────────────────────────────────────────────────────────────────────────
env_applied() { # env → 0 si le dossier applicatif est renommé
    local st
    st="$(el_state_id "opt_$1")"
    case "$st" in done | done-nolink) return 0 ;; esac
    return 1
}

rollback_env() { # env
    local e="$1" other scopes_shared id st
    CUR_ENV="$e"
    CHANGED=0
    PM2_CHANGED=0
    RB_FAIL=0
    set +e
    log "══ ROLLBACK $e ══"
    if [ "$e" = prod ]; then other=staging; else other=prod; fi
    if env_applied "$other"; then SHARED_RB=0; else SHARED_RB=1; fi
    if [ "$SHARED_RB" = 1 ]; then
        log "L'autre environnement ($other) n'est pas renommé : les éléments PARTAGÉS reviennent aussi en arrière."
        scopes_shared="shared $e"
    else
        log "L'autre environnement ($other) est renommé : les éléments PARTAGÉS restent aux nouveaux noms."
        scopes_shared="$e"
    fi

    STEP="rollback : suspension du watchdog"
    wd_suspend
    ASSUME_SCOPES=""

    STEP="rollback : pm2 delete des nouveaux noms"
    pm2_snapshot
    local n list=""
    for n in $(pm2_old_names "$e"); do
        if [ "$(pm2_status "$n")" = online ]; then list="$list $n"; fi
    done
    pm2_delete_news "$e"
    if [ -n "$list" ]; then log "(process anciens déjà en ligne : $list)"; fi

    STEP="rollback : contenu des fichiers"
    WD_PASS_DIR="rev"
    WD_PASS_SCOPES="$scopes_shared"
    # Fichiers de l'env : retour complet ; fichiers partagés : seulement les portées défaites.
    for id in $(if [ "$e" = prod ]; then echo "sbin_backup cron_pgbackup site_prod_av site_prod_en"; else echo "sbin_stbackup cron_stpgbackup site_st_av site_st_en"; fi); do
        patch_file "$(cur_path "$id")" rev "shared prod staging"
    done
    for id in sbin_deploy sbin_watchdog cron_r2 logrotate; do
        patch_file "$(cur_path "$id")" rev "$scopes_shared"
    done
    if [ "$SHARED_RB" = 1 ]; then sudoers_remove nouveau || RB_FAIL=$((RB_FAIL + 1)); fi

    STEP="rollback : renommage inverse"
    local kinds_rev="enabled snippet file linkfile dir" kind
    # Env d'abord (sites, sbin, cron, dossiers), partagé ensuite si concerné.
    for kind in $kinds_rev; do
        for id in $(el_ids_kind "$e" "$kind"); do
            el_load "$id"
            st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
            case "$st" in
                done | done-nolink) rename_backward "$EL_KIND" "$EL_OLD" "$EL_NEW" ;;
                conflict) log "AVERTISSEMENT : $id en conflit, ignoré"; RB_FAIL=$((RB_FAIL + 1)) ;;
            esac
        done
    done
    if [ "$SHARED_RB" = 1 ]; then
        for kind in $kinds_rev; do
            for id in $(el_ids_kind shared "$kind"); do
                el_load "$id"
                st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
                case "$st" in
                    done | done-nolink) rename_backward "$EL_KIND" "$EL_OLD" "$EL_NEW" ;;
                    conflict) log "AVERTISSEMENT : $id en conflit, ignoré"; RB_FAIL=$((RB_FAIL + 1)) ;;
                esac
            done
        done
    fi

    STEP="rollback : liens snippets"
    reconcile_snippets

    STEP="rollback : nginx"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] nginx -t puis systemctl reload nginx"
    elif nginx_test; then
        log "nginx -t OK"
        # Reload seulement si nginx a déjà rechargé la configuration renommée (ou si l'état est inconnu :
        # rollback lancé à la main) ; après un échec de nginx -t, la configuration active n'a jamais changé.
        if [ "$CHANGED" = 1 ] && { [ "$CMD" = rollback ] || [ "$NGINX_RELOADED" = 1 ]; }; then
            try systemctl reload nginx
        fi
    else
        RB_FAIL=$((RB_FAIL + 1))
        nginx_show_error
        log "ATTENTION : nginx -t échoue APRÈS le retour arrière : intervention manuelle (sauvegardes dans ${RUN_DIR#"$P"}/backup)."
    fi

    STEP="rollback : pm2 start des anciens noms"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] pm2 start <ecosystem d'origine> --only $(pm2_old_names "$e" | tr ' ' ',') ; pm2 save"
    else
        pm2_ensure "$e" old rev
        pm2_save
    fi

    STEP="rollback : remise du watchdog"
    if [ "$DRY" = 1 ]; then
        log "[dry-run] cron watchdog remis sous le nom correspondant au script sbin"
    else
        wd_finalize
    fi

    if [ "$DRY" = 0 ]; then
        VERIFY_FAIL=0
        verify_env "$e" old
        RB_FAIL=$((RB_FAIL + VERIFY_FAIL))
    fi
    set -e
    log "══ ROLLBACK $e terminé : $RB_FAIL anomalie(s) ══"
}

# ── Status ───────────────────────────────────────────────────────────────────────────────────
cmd_status() {
    local e id st n o wdn
    log "ÉTAT (préfixe : '${P:-/}')"
    for id in $(elements | awk -F'|' '{print $1}'); do
        el_load "$id"
        case "$ENV_ARG" in
            all) ;;
            *)
                if [ "$EL_SCOPE" != shared ] && [ "$EL_SCOPE" != "$ENV_ARG" ]; then continue; fi
                ;;
        esac
        st="$(el_state "$EL_KIND" "$EL_OLD" "$EL_NEW")"
        case "$st" in
            todo) o="ANCIEN (à renommer)" ;;
            done)
                if [ -L "$EL_OLD" ]; then o="NOUVEAU + lien de compatibilité"; else o="NOUVEAU"; fi
                ;;
            done-nolink) o="NOUVEAU (lien de compatibilité absent)" ;;
            absent) o="ABSENT" ;;
            *) o="CONFLIT" ;;
        esac
        log "$(printf '  %-15s %-9s %-38s %s' "$id" "[$EL_SCOPE]" "$o" "${EL_NEW#"$P"}")"
    done
    n=0
    wdn=""
    for o in "$WD_CRON_OLD" "$WD_CRON_NEW" "$WD_CRON_OLD.rename-hold" "$WD_CRON_NEW.rename-hold"; do
        if [ -f "$o" ]; then
            n=$((n + 1))
            wdn="$wdn ${o#"$P/etc/cron.d/"}"
        fi
    done
    log "  cron watchdog   :$wdn ($n fichier(s)$(if [ "$n" -gt 1 ]; then echo ', DOUBLON'; fi)$(case "$wdn" in *rename-hold*) echo ', SUSPENDU : lancer apply ou rollback pour le remettre' ;; esac))"
    log "  sudoers         : $(sudoers_state)"
    if pm2_snapshot 2>/dev/null; then
        for e in prod staging; do
            if [ "$ENV_ARG" != all ] && [ "$ENV_ARG" != "$e" ]; then continue; fi
            wdn=""
            for n in $(pm2_old_names "$e") $(pm2_new_names "$e"); do
                st="$(pm2_status "$n")"
                [ "$st" = absent ] || wdn="$wdn $n=$st"
            done
            log "  pm2 $e :${wdn:- aucun process connu}"
        done
    else
        log "  pm2             : inaccessible via sudo -u deploy"
    fi
    if nginx_test; then log "  nginx -t        : OK"; else log "  nginx -t        : ÉCHEC"; fi
    for e in prod staging; do
        if [ "$ENV_ARG" != all ] && [ "$ENV_ARG" != "$e" ]; then continue; fi
        if env_applied "$e"; then log "  verdict $e : RENOMMÉ"; else log "  verdict $e : état initial (ancien nom)"; fi
    done
}

# ── cleanup-compat ───────────────────────────────────────────────────────────────────────────
cmd_cleanup() {
    local e id refs problems=0 other other_clean=1 f
    local today="${RENAME_NOW_DATE:-$(date +%Y-%m-%d)}"
    if [ "$today" \< "$CLEANUP_NOT_BEFORE" ] && [ "$FORCE" = 0 ]; then
        die 1 "cleanup-compat refusé avant le $CLEANUP_NOT_BEFORE (aujourd'hui : $today). --force pour passer outre en connaissance de cause."
    fi
    log "══ CLEANUP-COMPAT ($ENV_ARG) ══"
    log "Conditions du runbook §3.9 (non vérifiables par le script) : au moins un déploiement complet staging+prod avec les nouveaux chemins ; plus de rollback vers les anciennes releases (builds Next avec /opt/sokar en dur, H18) ; H19 et H28 corrigés."
    for e in $(envs_for cleanup); do
        env_applied "$e" || die 3 "$e n'est pas renommé : rien à nettoyer."
    done
    # Aucune référence résiduelle aux anciens chemins dans ce que le script manipule.
    refs="$(scan_unknown_refs)"
    if [ -n "$refs" ]; then
        problems=1
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            log "  RÉFÉRENCE ancien chemin hors table : ${f#"$P"}"
        done <<<"$refs"
    fi
    for e in $(envs_for cleanup); do
        while IFS= read -r f; do
            [ -n "$f" ] || continue
            if [ -f "$f" ] && grep -Eq "$OLD_RX" "$f"; then
                problems=1
                log "  RÉFÉRENCE ancien chemin dans ${f#"$P"}"
            fi
        done < <(patch_targets "$e")
    done
    for f in "$P/opt/suppernote/scripts/database/backup-postgres-r2.sh" "$P/opt/suppernote/scripts/ops/logging.sh"; do
        if [ -f "$f" ] && grep -Eq "$OLD_RX" "$f"; then
            problems=1
            log "  RÉFÉRENCE ancien chemin dans ${f#"$P"} (script du dépôt appelé par cron/watchdog : déployer d'abord la PR)"
        fi
    done
    if [ -f "$DEPLOY_HOME/.pm2/dump.pm2" ] && grep -Eq "$OLD_RX" "$DEPLOY_HOME/.pm2/dump.pm2"; then
        problems=1
        log "  RÉFÉRENCE ancien chemin dans ${DEPLOY_HOME#"$P"}/.pm2/dump.pm2 (pm2 save manquant)"
    fi
    if pm2_run jlist 2>/dev/null </dev/null | grep -Eq "$OLD_RX"; then
        problems=1
        log "  RÉFÉRENCE ancien chemin dans pm2 jlist (cwd ou logs d'un process encore sous l'ancien chemin)"
    fi
    if [ "$problems" = 1 ] && [ "$FORCE" = 0 ]; then
        die 3 "des références aux anciens chemins subsistent : cleanup-compat refusé (corriger puis relancer ; --force pour passer outre)."
    fi

    for e in $(envs_for cleanup); do
        for id in $(el_ids "$e"); do cleanup_link "$id"; done
    done
    # Éléments partagés : seulement quand plus aucun environnement ne dépend de ses liens.
    for other in prod staging; do
        for id in $(el_ids "$other"); do
            el_load "$id"
            if [ -L "$EL_OLD" ]; then other_clean=0; fi
        done
    done
    if [ "$other_clean" = 1 ]; then
        log "Plus aucun lien d'environnement : nettoyage des éléments partagés."
        for id in $(el_ids shared); do cleanup_link "$id"; done
        reconcile_snippets
        sudoers_remove ancien
    else
        log "Liens de l'autre environnement encore présents : éléments partagés conservés."
    fi

    if [ "$PATCH_DEBUG" = 1 ]; then
        patch_debug_log_path
    else
        log "DEBUG_LOG_PATH (H19) non touché (option --patch-debug-log-path, décision Hamza Q9)."
    fi
    log "À vérifier à la main : H28 (code lisant /var/log/sokar par défaut : rapports d'appel vides sans erreur si le lien disparaît), releases de rollback (H18)."
    log "══ CLEANUP-COMPAT terminé ══"
}

cleanup_link() { # id
    local id="$1"
    el_load "$id"
    case "$EL_KIND" in
        dir | linkfile)
            if [ -L "$EL_OLD" ]; then
                run rm "$EL_OLD"
                manifest cleanup-link "${EL_OLD#"$P"}"
            elif [ -e "$EL_OLD" ]; then
                log "AVERTISSEMENT : ${EL_OLD#"$P"} n'est pas un lien (fichier régulier, ex. self-update) : conservé, à traiter à la main."
            fi
            ;;
    esac
}

patch_debug_log_path() {
    local f="$P/opt/suppernote/apps/api/.env"
    [ -f "$f" ] || return 0
    if grep -Eq '^DEBUG_LOG_PATH=/opt/sokar/' "$f"; then
        if [ "$DRY" = 1 ]; then
            log "[dry-run] DEBUG_LOG_PATH : remplacerait le préfixe /opt/sokar/ par /opt/suppernote/ (valeur non affichée)"
            return 0
        fi
        backup_once "$f"
        sed -E 's#^(DEBUG_LOG_PATH=)/opt/sokar/#\1/opt/suppernote/#' "$f" >"$WORK/env.tmp"
        cat "$WORK/env.tmp" >"$f"
        log "DEBUG_LOG_PATH : préfixe de chemin corrigé (valeur non affichée)."
    fi
}

# ── Commandes ────────────────────────────────────────────────────────────────────────────────
envs_for() { # apply|rollback|cleanup|preflight
    case "$ENV_ARG" in
        prod) echo prod ;;
        staging) echo staging ;;
        all)
            if [ "$1" = rollback ]; then echo "prod staging"; else echo "staging prod"; fi
            ;;
    esac
}

cmd_preflight() {
    local e total=0
    for e in $(envs_for preflight); do
        preflight_env "$e"
        total=$((total + PF_FAIL))
    done
    if [ "$total" -gt 0 ]; then die 3 "préflight en échec ($total)."; fi
    log "Préflight OK."
}

banner_apply() {
    log "Rappels avant de continuer : workflows deploy-staging/deploy-prod désactivés (gh workflow disable), aucune PR en auto-merge,"
    log "check Healthchecks.io en pause (action UI), aucun appel en cours. Le cron watchdog est suspendu/remis par ce script."
}

cmd_apply() {
    local e total=0
    banner_apply
    ASSUME_SCOPES="shared"
    for e in $(envs_for apply); do
        preflight_env "$e"
        total=$((total + PF_FAIL))
    done
    if [ "$total" -gt 0 ]; then die 3 "préflight en échec : rien n'a été modifié."; fi
    AUTO_RB=0
    local first=1
    for e in $(envs_for apply); do
        # Le préflight de tous les environnements a déjà été fait ; il est refait pour les suivants
        # car l'état (nginx, dossiers) a changé entre-temps.
        if [ "$DRY" = 1 ]; then
            apply_env "$e" 1
        else
            apply_env "$e" "$first"
        fi
        first=0
    done
    log "APPLY terminé. Étapes suivantes : voir docs/runbooks/rename-suppernote-vps.md (validation, puis prod, ou §4)."
}

cmd_rollback() {
    local e total=0
    for e in $(envs_for rollback); do
        rollback_env "$e"
        total=$((total + RB_FAIL))
    done
    if [ "$total" -gt 0 ]; then
        die 6 "retour arrière terminé avec $total anomalie(s) : voir le journal et l'option B manuelle du runbook."
    fi
    log "Retour arrière terminé sans anomalie."
}

# ── Verrou, trap, démarrage ──────────────────────────────────────────────────────────────────
acquire_lock() {
    mkdir -p "$(dirname "$LOCK_DIR")"
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        echo "$$" >"$LOCK_DIR/pid"
        LOCK_HELD=1
        return 0
    fi
    local pid
    pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
    if [ -n "$pid" ] && ! kill -0 "$pid" 2>/dev/null; then
        log "verrou périmé (pid $pid absent) : repris."
        rm -rf "$LOCK_DIR"
        mkdir "$LOCK_DIR"
        echo "$$" >"$LOCK_DIR/pid"
        LOCK_HELD=1
        return 0
    fi
    die 1 "une autre exécution est en cours (verrou $LOCK_DIR, pid ${pid:-?})."
}

on_exit() {
    local rc=$?
    trap - EXIT ERR
    set +e
    if [ "$WD_HELD" = 1 ]; then
        log "trap EXIT : remise du cron watchdog (ne jamais le laisser désactivé)."
        wd_finalize
    fi
    if [ -n "$ECO_DIR" ] && [ -d "$ECO_DIR" ]; then rm -rf "$ECO_DIR"; fi
    if [ "$LOCK_HELD" = 1 ]; then rm -rf "$LOCK_DIR"; fi
    if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi
    if [ "$rc" -ne 0 ] && [ -n "$LOG" ]; then
        printf '[%s] sortie avec le code %s\n' "$(date +%H:%M:%S)" "$rc" >>"$LOG"
    fi
    exit "$rc"
}

usage() {
    sed -n '2,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit "${1:-1}"
}

parse_args() {
    [ $# -ge 1 ] || usage 1
    while [ $# -gt 0 ]; do
        case "$1" in
            preflight | apply | rollback | status | cleanup-compat)
                [ -z "$CMD" ] || usage 1
                CMD="$1"
                ;;
            --env)
                [ $# -ge 2 ] || usage 1
                ENV_ARG="$2"
                shift
                ;;
            --env=*) ENV_ARG="${1#--env=}" ;;
            --dry-run) DRY=1 ;;
            --force) FORCE=1 ;;
            --patch-debug-log-path) PATCH_DEBUG=1 ;;
            -h | --help) usage 0 ;;
            *) usage 1 ;;
        esac
        shift
    done
    [ -n "$CMD" ] || usage 1
    case "$ENV_ARG" in staging | prod | all) ;; *)
        echo "--env <staging|prod|all> est obligatoire." >&2
        exit 1
        ;;
    esac
}

require_root() {
    local euid="${RENAME_TEST_EUID:-$(id -u)}"
    if [ "$euid" -eq 0 ]; then return 0; fi
    if [ -n "$P" ] && [ "${RENAME_ALLOW_NONROOT:-}" = 1 ] && [ -z "${RENAME_TEST_EUID:-}" ]; then return 0; fi
    echo "Ce script doit être lancé en root (sudo bash $0 …)." >&2
    exit 2
}

init_run() {
    local ts n
    WORK="$(mktemp -d "${TMPDIR:-/tmp}/rename-suppernote-work.XXXXXX")"
    init_wd_paths
    case "$CMD" in
        apply | rollback | cleanup-compat)
            if [ "$DRY" = 0 ]; then
                acquire_lock
                ts="$(date +%Y%m%d-%H%M%S)"
                RUN_DIR="$RUN_BASE/rename-suppernote-$ts"
                n=0
                while [ -e "$RUN_DIR" ]; do
                    n=$((n + 1))
                    RUN_DIR="$RUN_BASE/rename-suppernote-$ts-$n"
                done
                mkdir -p "$RUN_DIR"
                chmod 0700 "$RUN_DIR"
                LOG="$RUN_DIR/run.log"
                MANIFEST="$RUN_DIR/manifest.tsv"
                : >"$LOG"
                : >"$MANIFEST"
                log "Journal : ${RUN_DIR#"$P"} (commande : $CMD --env $ENV_ARG)"
            else
                log "DRY-RUN : aucune écriture (ni journal, ni sauvegarde, ni modification système)."
            fi
            ;;
    esac
}

main() {
    parse_args "$@"
    require_root
    trap on_exit EXIT
    trap 'on_err $? $LINENO' ERR
    init_run
    detect_pm2_mode
    case "$CMD" in
        status) cmd_status ;;
        preflight) cmd_preflight ;;
        apply) cmd_apply ;;
        rollback) cmd_rollback ;;
        cleanup-compat) cmd_cleanup ;;
    esac
}

main "$@"
