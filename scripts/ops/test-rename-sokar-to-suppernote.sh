#!/usr/bin/env bash
# Teste scripts/ops/rename-sokar-to-suppernote.sh dans un bac à sable local, sans root ni serveur.
#
# Le bac à sable est reconstitué à l'image du serveur (relevé ops du 23/11/2026, H01–H36) à partir des
# fichiers du dépôt ramenés à leurs anciens noms (to_old) : les fichiers « installés » (wrapper, watchdog,
# crons, logrotate, sites et snippets nginx, ecosystem) sont donc ceux de main avant renommage.
# RENAME_ROOT_PREFIX préfixe tous les chemins système ; pm2, nginx, systemctl, docker, sudo, visudo,
# curl, pgrep sont des stubs injectés par PATH. Le stub nginx -t vérifie réellement que chaque `include`
# des sites activés se résout (liens suivis), que les dossiers d'access_log existent et qu'aucun upstream
# n'est défini deux fois : un snippet renommé sans lien de compatibilité fait donc échouer le test.
#
# Usage : bash scripts/ops/test-rename-sokar-to-suppernote.sh
# shellcheck disable=SC2010,SC2012,SC2016
# (ls/grep sur des noms maîtrisés ; motifs littéraux entre quotes simples)
set -Eeuo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="${RENAME_SCRIPT_UNDER_TEST:-$REPO/scripts/ops/rename-sokar-to-suppernote.sh}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/rename-test.XXXXXX")"
trap 'chmod -R u+w "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

PASS=0
FAILED=0
SB=""
STATE=""
RC=0
OUT=""
NRUN=0
CANARY="CANARY_SECRET_9f3a7c"

MUTE=0
MUT_FAILS=0
pass() {
    if [ "$MUTE" = 1 ]; then return 0; fi
    PASS=$((PASS + 1))
    printf 'ok   - %s\n' "$1"
}
fail() {
    if [ "$MUTE" = 1 ]; then
        MUT_FAILS=$((MUT_FAILS + 1))
        return 0
    fi
    FAILED=$((FAILED + 1))
    printf 'FAIL - %s\n' "$1"
}
check() { # description commande… (en cas d'échec : début de la sortie de la commande)
    local d="$1" o="$TMP/check.out"
    shift
    if "$@" >"$o" 2>&1; then
        pass "$d"
    else
        fail "$d"
        if [ "$MUTE" = 0 ]; then head -n 12 "$o" | sed 's/^/       | /'; fi
    fi
}
check_not() {
    local d="$1"
    shift
    if "$@" >/dev/null 2>&1; then fail "$d"; else pass "$d"; fi
}
is_eq() { [ "$1" = "$2" ]; }
has_text() { grep -qF -- "$2" "$1"; }
no_text() { ! grep -qF -- "$2" "$1"; }

# ── Ancien nom d'un fichier du dépôt (indépendant des règles du script) ───────────────────────
to_old() {
    LC_ALL=C sed -E \
        -e 's#/opt/suppernote-staging#/opt/sokar-staging#g' \
        -e 's#/opt/suppernote([^A-Za-z0-9_-]|$)#/opt/sokar\1#g' \
        -e 's#/var/backups/suppernote-staging#/var/backups/sokar-staging#g' \
        -e 's#/var/backups/suppernote([^A-Za-z0-9_-]|$)#/var/backups/sokar\1#g' \
        -e 's#/var/log/suppernote([^A-Za-z0-9_-]|$)#/var/log/sokar\1#g' \
        -e 's#/var/lib/suppernote([^A-Za-z0-9_-]|$)#/var/lib/sokar\1#g' \
        -e 's#/etc/suppernote([^A-Za-z0-9_-]|$)#/etc/sokar\1#g' \
        -e 's#suppernote-(deploy-root|watchdog|backup-postgres|r2-backup|postgres-backup|staging-backup-postgres|staging-postgres-backup)#sokar-\1#g' \
        -e 's#logrotate\.d/suppernote#logrotate.d/sokar#g' \
        -e 's#logrotate/suppernote#logrotate/sokar#g' \
        -e 's#suppernote-(proxy|security-headers|cloudflare-real-ip)\.conf#sokar-\1.conf#g' \
        -e 's#VHOST="suppernote"#VHOST="sokar"#g' \
        -e 's#VHOST="suppernote-staging"#VHOST="sokar-staging"#g' \
        -e 's#suppernote-(staging-)?(api|workers|dashboard|connect)#sokar-\1\2#g' \
        -e 's#SUPPERNOTE_ROOT#SOKAR_ROOT#g'
}

# ── Stubs ────────────────────────────────────────────────────────────────────────────────────
make_stubs() {
    local d="$TMP/stubs"
    mkdir -p "$d"

    cat >"$d/pm2" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; L="$S/pm2.list"; PFX="${RENAME_ROOT_PREFIX:-}"
echo "pm2 $*" >>"$S/calls.log"
cmd="${1:-}"; shift || true
has() { grep -q "^$1|" "$L"; }
setst() { awk -F'|' -v n="$1" -v s="$2" 'BEGIN{OFS="|"} $1==n{$2=s} {print}' "$L" >"$L.tmp" && mv "$L.tmp" "$L"; }
case "$cmd" in
  -v) echo "7.0.3" ;;
  jlist)
    echo "[PM2] Spawning PM2 daemon with pm2_home=/home/deploy/.pm2"
    i=0; out="["; sep=""
    while IFS='|' read -r n st cwd; do
      out="$out$sep{\"pid\":$((1000 + i)),\"name\":\"$n\",\"pm2_env\":{\"name\":\"$n\",\"status\":\"$st\",\"pm_cwd\":\"$cwd\"},\"pm_id\":$i,\"monit\":{\"memory\":0,\"cpu\":0}}"
      sep=","; i=$((i + 1))
    done <"$L"
    # Comme le vrai pm2 jlist : la sortie ne se termine PAS par un saut de ligne (dernier octet = « ] »).
    if [ -f "$S/jlist_nonl" ]; then printf '%s]' "$out"; else echo "$out]"; fi
    ;;
  stop)
    for n in "$@"; do has "$n" || { echo "[PM2][ERROR] Process $n not found" >&2; exit 1; }; setst "$n" stopped; done
    ;;
  restart)
    for n in "$@"; do has "$n" || { echo "[PM2][ERROR] Process $n not found" >&2; exit 1; }; setst "$n" online; done
    ;;
  delete)
    for n in "$@"; do has "$n" || { echo "[PM2][ERROR] Process $n not found" >&2; exit 1; }; grep -v "^$n|" "$L" >"$L.tmp" || true; mv "$L.tmp" "$L"; done
    ;;
  start)
    eco="$1"; shift; only=""
    while [ $# -gt 0 ]; do case "$1" in --only) only="$2"; shift ;; esac; shift; done
    [ -f "$eco" ] || { echo "[PM2][ERROR] ecosystem introuvable : $eco" >&2; exit 1; }
    if [ -f "$S/pm2_fail_start_once" ]; then rm -f "$S/pm2_fail_start_once"; echo "[PM2][ERROR] échec de démarrage simulé" >&2; exit 1; fi
    cur=""
    sed -n "s/^[[:space:]]*name: '\([^']*\)'.*/N|\1/p; s/^[[:space:]]*cwd: '\([^']*\)'.*/C|\1/p" "$eco" | while IFS='|' read -r kind val; do
      if [ "$kind" = N ]; then cur="$val"; continue; fi
      case ",$only," in *",$cur,"*) ;; *) continue ;; esac
      has "$cur" && continue
      st=online; [ -d "$PFX$val" ] || st=errored
      echo "$cur|$st|$val" >>"$L"
    done
    ;;
  save)
    sort "$L" >"$S/pm2.saved"; mkdir -p "$PFX/home/deploy/.pm2"; sort "$L" >"$PFX/home/deploy/.pm2/dump.pm2"
    ;;
  *) echo "pm2 stub : commande inconnue $cmd" >&2; exit 1 ;;
esac
EOF

    cat >"$d/sudo" <<'EOF'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in -n | -H) shift ;; -u) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac
done
echo "sudo(deploy) $*" >>"$STUB_STATE/calls.log"
exec "$@"
EOF

    cat >"$d/nginx" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"; PFX="${RENAME_ROOT_PREFIX:-}"
echo "nginx $*" >>"$S/calls.log"
case "${1:-}" in
  -v) echo "nginx version: nginx/1.24.0 (stub)" >&2; exit 0 ;;
  -t)
    n=$(cat "$S/nginx_t_count" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$S/nginx_t_count"
    if [ "${STUB_NGINX_FAIL_ON:-}" = "$n" ]; then
      echo "nginx: [emerg] échec simulé (appel $n)" >&2
      echo "nginx: configuration file /etc/nginx/nginx.conf test failed" >&2
      exit 1
    fi
    rc=0; ups=""
    for site in "$PFX"/etc/nginx/sites-enabled/*; do
      [ -e "$site" ] || { echo "nginx: [emerg] site activé introuvable : $site" >&2; rc=1; continue; }
      while IFS= read -r inc; do
        path="${inc#include }"; path="${path%;}"
        [ -f "$PFX$path" ] || { echo "nginx: [emerg] open() \"$path\" failed (2: No such file or directory) in $site" >&2; rc=1; }
      done < <(grep -oE 'include /[^;]+;' "$site" || true)
      while IFS= read -r al; do
        f="${al#access_log }"; f="${f%% *}"
        [ -d "$PFX$(dirname "$f")" ] || { echo "nginx: [emerg] open() \"$f\" failed in $site" >&2; rc=1; }
      done < <(grep -oE 'access_log /[^ ;]+' "$site" || true)
      ups="$ups
$(grep -oE '^upstream [A-Za-z0-9_]+' "$site" || true)"
    done
    dup=$(printf '%s\n' "$ups" | grep -v '^$' | sort | uniq -d || true)
    if [ -n "$dup" ]; then echo "nginx: [emerg] duplicate $dup" >&2; rc=1; fi
    [ "$rc" = 0 ] && echo "nginx: the configuration file syntax is ok" >&2
    exit "$rc"
    ;;
  *) exit 0 ;;
esac
EOF

    cat >"$d/systemctl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"
echo "systemctl $*" >>"$S/calls.log"
if [ "${1:-}" = reload ] && [ "${2:-}" = nginx ]; then
  n=$(cat "$S/reload_count" 2>/dev/null || echo 0); echo $((n + 1)) >"$S/reload_count"
fi
exit 0
EOF

    cat >"$d/visudo" <<'EOF'
#!/usr/bin/env bash
echo "visudo $*" >>"$STUB_STATE/calls.log"
case "${1:-}" in
  -cf)
    f="$2"
    if [ -n "${STUB_VISUDO_FAIL_CAND:-}" ]; then case "$f" in *sudoers.cand) exit 1 ;; esac; fi
    bad=$(grep -vE '^[[:space:]]*(#.*)?$|^deploy ALL=\(root\) NOPASSWD: /usr/local/sbin/(sokar|suppernote)-deploy-root \*$' "$f" || true)
    [ -z "$bad" ]
    ;;
  *) exit 0 ;;
esac
EOF

    cat >"$d/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_STATE/calls.log"
case "${1:-}" in
  ps) printf 'infra-postgres-1\nsokar-prometheus\n' ;;
  inspect)
    last="${*: -1}"
    if [ "$last" = sokar-prometheus ]; then printf '%s\n' "${RENAME_ROOT_PREFIX:-}/opt/sokar/infra/prometheus/prometheus.yml" "/var/lib/docker/volumes/prom/_data"; else printf '%s\n' "/var/lib/docker/volumes/pg/_data"; fi
    ;;
  *) echo "docker stub : $* interdit dans ce test" >&2; exit 1 ;;
esac
EOF

    cat >"$d/curl" <<'EOF'
#!/usr/bin/env bash
S="$STUB_STATE"
url=""
for a in "$@"; do case "$a" in http://* | https://*) url="$a" ;; esac; done
echo "curl $url" >>"$S/calls.log"
role=""; envn=""
case "$url" in
  http://127.0.0.1:4000/* | https://api.suppernote.com/*) role=api; envn=prod ;;
  http://127.0.0.1:4100/* | https://api-staging.suppernote.com/*) role=api; envn=staging ;;
  http://127.0.0.1:3000/*) role=dashboard; envn=prod ;;
  http://127.0.0.1:3100/*) role=dashboard; envn=staging ;;
  http://127.0.0.1:4002/*) role=connect; envn=prod ;;
  http://127.0.0.1:4102/*) role=connect; envn=staging ;;
esac
if [ "$envn" = prod ]; then re="^(sokar|suppernote)-$role\\|online"; else re="^(sokar|suppernote)-staging-$role\\|online"; fi
if [ -n "$role" ] && grep -Eq "$re" "$S/pm2.list"; then
  if [ "$role" = dashboard ]; then printf '307'; else printf '200'; fi
  exit 0
fi
printf '000'
exit 7
EOF

    cat >"$d/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF
    chmod +x "$d"/*
}

# ── Bac à sable ──────────────────────────────────────────────────────────────────────────────
mkold() { # source_dépôt destination [mode]
    mkdir -p "$(dirname "$2")"
    to_old <"$REPO/$1" >"$2"
    chmod "${3:-644}" "$2"
}

new_sandbox() {
    SB="$TMP/sb-$1"
    STATE="$TMP/state-$1"
    rm -rf "$SB" "$STATE"
    mkdir -p "$SB" "$STATE" "$TMP/tmpdir"
    local s
    mkdir -p "$SB/root" "$SB/tmp" "$SB/var/lock"
    # /opt/sokar et /opt/sokar-staging
    for s in sokar sokar-staging; do
        mkdir -p "$SB/opt/$s/infra" "$SB/opt/$s/scripts/ops" "$SB/opt/$s/scripts/database" \
            "$SB/opt/$s/apps/api" "$SB/opt/$s/apps/dashboard" "$SB/opt/$s/apps/connect" \
            "$SB/opt/$s/releases/r1" "$SB/opt/$s/infra/prometheus"
        printf 'DATABASE_URL=postgres://u:%s@db/x\nDEBUG_LOG_PATH=/opt/%s/apps/api/scratch/call_debug.log\n' "$CANARY" "$s" >"$SB/opt/$s/apps/api/.env"
        chmod 600 "$SB/opt/$s/apps/api/.env"
        printf '# build\nrequire("/opt/%s/apps/api/dist")\n' "$s" >"$SB/opt/$s/releases/r1/server.js"
        printf 'scrape_configs: []\n' >"$SB/opt/$s/infra/prometheus/prometheus.yml"
        printf '#!/usr/bin/env bash\n# logging helpers\nlog() { echo "$*"; }\n' >"$SB/opt/$s/scripts/ops/logging.sh"
    done
    mkold infra/ecosystem.config.js "$SB/opt/sokar/infra/ecosystem.config.js"
    mkold infra/ecosystem.staging.config.js "$SB/opt/sokar-staging/infra/ecosystem.staging.config.js"
    # Scripts du dépôt appelés par cron (état avant déploiement de la PR : anciens chemins).
    printf '#!/usr/bin/env bash\nBACKUP_DIR=/var/backups/sokar\nLOG=/var/log/sokar/postgres-r2-backup.log\n' >"$SB/opt/sokar/scripts/database/backup-postgres-r2.sh"
    # Journaux, état, config, sauvegardes.
    mkdir -p "$SB/var/log/sokar" "$SB/var/lib/sokar/watchdog" "$SB/etc/sokar" "$SB/var/backups/sokar" "$SB/var/backups/sokar-staging"
    printf 'api log line\n' >"$SB/var/log/sokar/api-out.log"
    printf 'legacy\n' >"$SB/var/log/sokar/nginx-legacy.log"
    printf 'watchdog log\n' >"$SB/var/log/sokar/watchdog.log"
    printf 'cooldown=1\n' >"$SB/var/lib/sokar/watchdog/state"
    printf 'HEALTHCHECKS_PING_URL=https://hc.example/%s\n' "$CANARY" >"$SB/etc/sokar/watchdog.env"
    printf 'GRAFANA_ADMIN_PASSWORD=%s\n' "$CANARY" >"$SB/etc/sokar/grafana.env"
    chmod 600 "$SB/etc/sokar/"*.env
    printf 'dump\n' >"$SB/var/backups/sokar/sokar-20261123-0320.dump"
    printf 'dump\n' >"$SB/var/backups/sokar-staging/sokar_staging-20261123-0420.dump"
    # sbin (anciens noms).
    mkdir -p "$SB/usr/local/sbin"
    mkold scripts/ops/suppernote-deploy-root.sh "$SB/usr/local/sbin/sokar-deploy-root" 755
    mkold scripts/ops/suppernote-watchdog.sh "$SB/usr/local/sbin/sokar-watchdog" 755
    mkold scripts/database/backup-postgres.sh "$SB/usr/local/sbin/sokar-backup-postgres" 750
    mkold scripts/database/backup-staging-postgres.sh "$SB/usr/local/sbin/sokar-staging-backup-postgres" 755
    # cron.d, logrotate.
    mkold infra/cron/suppernote-watchdog "$SB/etc/cron.d/sokar-watchdog"
    mkold infra/cron/suppernote-r2-backup "$SB/etc/cron.d/sokar-r2-backup"
    mkold infra/cron/suppernote-postgres-backup "$SB/etc/cron.d/sokar-postgres-backup"
    mkold infra/cron/suppernote-staging-postgres-backup "$SB/etc/cron.d/sokar-staging-postgres-backup"
    mkold infra/logrotate/suppernote "$SB/etc/logrotate.d/sokar"
    # nginx : snippets, sites (prod : lien ; staging : COPIE, H01).
    mkdir -p "$SB/etc/nginx/snippets" "$SB/etc/nginx/sites-available" "$SB/etc/nginx/sites-enabled"
    for s in proxy security-headers cloudflare-real-ip; do
        cp "$REPO/infra/nginx/snippets/suppernote-$s.conf" "$SB/etc/nginx/snippets/sokar-$s.conf"
    done
    mkold infra/nginx/suppernote.conf "$SB/etc/nginx/sites-available/sokar"
    mkold infra/nginx/suppernote-staging.conf "$SB/etc/nginx/sites-available/sokar-staging"
    ln -s ../sites-available/sokar "$SB/etc/nginx/sites-enabled/sokar"
    cp "$SB/etc/nginx/sites-available/sokar-staging" "$SB/etc/nginx/sites-enabled/sokar-staging"
    # sudoers (ancienne ligne seule), référence hors table plantée, dump pm2.
    mkdir -p "$SB/etc/sudoers.d" "$SB/etc/default" "$SB/home/deploy/.pm2"
    printf '# deploy\ndeploy ALL=(root) NOPASSWD: /usr/local/sbin/sokar-deploy-root *\n' >"$SB/etc/sudoers.d/deploy"
    chmod 440 "$SB/etc/sudoers.d/deploy"
    printf 'LEGACY_DIR=/opt/sokar/legacy\n' >"$SB/etc/default/legacy-tool"
    # pm2 : 8 process en ligne sous les anciens noms.
    {
        echo 'sokar-api|online|/opt/sokar/apps/api'
        echo 'sokar-workers|online|/opt/sokar/apps/api'
        echo 'sokar-dashboard|online|/opt/sokar/apps/dashboard'
        echo 'sokar-connect|online|/opt/sokar/apps/connect'
        echo 'sokar-staging-api|online|/opt/sokar-staging/apps/api'
        echo 'sokar-staging-workers|online|/opt/sokar-staging/apps/api'
        echo 'sokar-staging-dashboard|online|/opt/sokar-staging/apps/dashboard'
        echo 'sokar-staging-connect|online|/opt/sokar-staging/apps/connect'
    } >"$STATE/pm2.list"
    sort "$STATE/pm2.list" >"$SB/home/deploy/.pm2/dump.pm2"
    : >"$STATE/calls.log"
}

file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

snapshot() { # dossier → stdout (type, mode, cible des liens, cksum) hors journal et tmp ; chemin du bac normalisé
    (
        cd "$1"
        find . \( -path ./root -o -path ./tmp \) -prune -o -print | LC_ALL=C sort | while IFS= read -r f; do
            if [ -L "$f" ]; then
                printf 'L %s -> %s\n' "$f" "$(readlink "$f")"
            elif [ -d "$f" ]; then
                printf 'D %s %s\n' "$f" "$(file_mode "$f")"
            else
                printf 'F %s %s %s\n' "$f" "$(file_mode "$f")" "$(cksum <"$f")"
            fi
        done
    ) | sed "s#$(cd "$1" && pwd -P)#<SB>#g; s#$1#<SB>#g"
}

# run_script <args…> : lance le script dans le bac à sable ; sortie dans $OUT, code dans $RC.
run_script() {
    NRUN=$((NRUN + 1))
    OUT="$TMP/out-$NRUN.txt"
    RC=0
    env PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" RENAME_ROOT_PREFIX="$SB" RENAME_ALLOW_NONROOT=1 \
        RENAME_POLL_SLEEP=0 RENAME_VERIFY_TIMEOUT=2 RENAME_MIN_FREE_KB=1024 TMPDIR="$TMP/tmpdir" \
        STUB_NGINX_FAIL_ON="${STUB_NGINX_FAIL_ON:-}" STUB_VISUDO_FAIL_CAND="${STUB_VISUDO_FAIL_CAND:-}" \
        bash "$SCRIPT" "$@" >"$OUT" 2>&1 || RC=$?
    rm -f "$STATE/nginx_t_count"
}

pm2_sorted() { sort "$STATE/pm2.list"; }
count_calls() { grep -cE "$1" "$STATE/calls.log" || true; }
cron_count() { ls "$SB/etc/cron.d" | grep -c "$1" || true; }
journal_dirs() { ls -d "$SB"/root/rename-suppernote-* 2>/dev/null | wc -l | tr -d ' '; }

# Fichiers installés ne contenant plus aucun ancien chemin de la table (hors variables SOKAR_ROOT, dumps, etc.).
OLD_PATH_RX='(/opt|/var/log|/var/lib|/var/backups|/etc)/sokar|/usr/local/sbin/sokar|cron\.d/sokar|snippets/sokar-|logrotate\.d/sokar|VHOST="sokar|sokar-(api|workers|dashboard|connect|staging-)'
no_old_refs() { ! grep -Eq "$OLD_PATH_RX" "$@"; }

echo "== Tests du script rename-sokar-to-suppernote.sh =="
make_stubs
check "script : bash -n" bash -n "$SCRIPT"
if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck "$SCRIPT" >"$TMP/shellcheck.out" 2>&1; then
        pass "script : shellcheck propre ($(shellcheck --version | sed -n 's/^version: //p'))"
    elif [ "${SHELLCHECK_STRICT:-0}" = 1 ]; then
        fail "script : shellcheck"
        head -n 20 "$TMP/shellcheck.out"
    else
        echo "warn - shellcheck signale des points (non bloquant ici, SHELLCHECK_STRICT=1 pour bloquer) :"
        head -n 10 "$TMP/shellcheck.out"
    fi
else
    echo "skip - shellcheck absent"
fi

# ── 1. Refus si non root ─────────────────────────────────────────────────────────────────────
new_sandbox refus
snapshot "$SB" >"$TMP/refus.before"
RC=0
env PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" RENAME_ROOT_PREFIX="$SB" RENAME_TEST_EUID=1000 \
    bash "$SCRIPT" apply --env all >"$TMP/refus.out" 2>&1 || RC=$?
check "non root (préfixe + EUID 1000) : code 2" is_eq "$RC" 2
check "non root : message explicite" has_text "$TMP/refus.out" "doit être lancé en root"
RC=0
env PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" RENAME_TEST_EUID=1000 \
    bash "$SCRIPT" apply --env all >"$TMP/refus2.out" 2>&1 || RC=$?
check "non root (sans préfixe, chemins réels) : code 2" is_eq "$RC" 2
if [ "$(id -u)" != 0 ]; then
    RC=0
    env -u RENAME_ROOT_PREFIX -u RENAME_ALLOW_NONROOT PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" \
        bash "$SCRIPT" status --env all >"$TMP/refus3.out" 2>&1 || RC=$?
    check "non root réel (id -u != 0, sans préfixe) : code 2" is_eq "$RC" 2
fi
check "refus : aucune modification du bac à sable" diff -q "$TMP/refus.before" <(snapshot "$SB")
RC=0
bash "$SCRIPT" apply >"$TMP/usage.out" 2>&1 || RC=$?
check "usage : --env manquant → code 1" is_eq "$RC" 1
RC=0
bash "$SCRIPT" apply --env nimporte >"$TMP/usage.out" 2>&1 || RC=$?
check "usage : --env invalide → code 1" is_eq "$RC" 1

# ── 2. Préflight et dry-run : n'écrivent rien ────────────────────────────────────────────────
new_sandbox dry
snapshot "$SB" >"$TMP/dry.before"
pm2_sorted >"$TMP/dry.pm2.before"
run_script preflight --env all
check "preflight --env all : code 0" is_eq "$RC" 0
check "preflight : référence hors table signalée (/etc/default/legacy-tool)" has_text "$OUT" "/etc/default/legacy-tool"
check "preflight : bind mount docker signalé" has_text "$OUT" "sokar-prometheus"
check "preflight : même filesystem vérifié" has_text "$OUT" "même filesystem"
check "preflight : aucune écriture" diff -q "$TMP/dry.before" <(snapshot "$SB")
check "preflight : pas de journal créé" is_eq "$(journal_dirs)" 0
run_script apply --env all --dry-run
DRY_OUT="$OUT"
check "dry-run --env all : code 0" is_eq "$RC" 0
check "dry-run : aucune écriture dans le bac à sable" diff -q "$TMP/dry.before" <(snapshot "$SB")
check "dry-run : pas de journal ni de sauvegarde" is_eq "$(journal_dirs)" 0
check "dry-run : état pm2 inchangé" diff -q "$TMP/dry.pm2.before" <(pm2_sorted)
check "dry-run : aucun pm2 stop/delete/start/save/restart" is_eq "$(count_calls 'pm2 (stop|delete|start|save|restart)')" 0
check "dry-run : aucun reload nginx" is_eq "$(count_calls 'systemctl reload')" 0
check "dry-run : commandes affichées (mv)" has_text "$DRY_OUT" "[dry-run] mv "
check "dry-run : commandes pm2 affichées" has_text "$DRY_OUT" "sudo -u deploy -H pm2 stop"
check "dry-run : sudoers annoncé" has_text "$DRY_OUT" "sudoers : ajouterait"
check "dry-run : patch annoncé" has_text "$DRY_OUT" "[dry-run] patch"
check "dry-run : cron watchdog suspendu annoncé" has_text "$DRY_OUT" "rename-hold"
L1="$(grep -n 'APPLY staging' "$DRY_OUT" | head -1 | cut -d: -f1)"
L2="$(grep -n 'APPLY prod' "$DRY_OUT" | head -1 | cut -d: -f1)"
check "dry-run : staging planifié avant prod" test "${L1:-999}" -lt "${L2:-0}"
if [ -n "${TEST_KEEP_DRYRUN:-}" ]; then sed "s#$SB##g" "$DRY_OUT" >"$TEST_KEEP_DRYRUN"; fi
run_script apply --env staging --dry-run
DRY_ST_OUT="$OUT"
check "dry-run --env staging : code 0" is_eq "$RC" 0
check "dry-run --env staging : aucune écriture dans le bac à sable" diff -q "$TMP/dry.before" <(snapshot "$SB")
check "dry-run --env staging : pas de journal ni de sauvegarde" is_eq "$(journal_dirs)" 0
check "dry-run --env staging : prod non planifiée" no_text "$DRY_ST_OUT" "APPLY prod"
check "dry-run --env staging : aucun pm2 stop/delete/start/save/restart" is_eq "$(count_calls 'pm2 (stop|delete|start|save|restart)')" 0
if [ -n "${TEST_KEEP_DRYRUN_STAGING:-}" ]; then sed "s#$SB##g" "$DRY_ST_OUT" >"$TEST_KEEP_DRYRUN_STAGING"; fi

# ── 3. status avant ──────────────────────────────────────────────────────────────────────────
run_script status --env all
check "status initial : code 0" is_eq "$RC" 0
check "status initial : éléments ANCIEN" has_text "$OUT" "ANCIEN (à renommer)"
check "status initial : verdict prod état initial" has_text "$OUT" "verdict prod : état initial"
check_not "status initial : aucun NOUVEAU" has_text "$OUT" "NOUVEAU"

# ── 4. apply staging puis idempotence ────────────────────────────────────────────────────────
new_sandbox main
snapshot "$SB" >"$TMP/S0"
pm2_sorted >"$TMP/P0"
cp "$SB/etc/nginx/sites-available/sokar" "$TMP/prod-site.orig"
cp "$SB/usr/local/sbin/sokar-watchdog" "$TMP/watchdog.orig"
run_script apply --env staging
check "apply staging : code 0" is_eq "$RC" 0
cp "$OUT" "$TMP/apply-staging.out"
check "staging : /opt/sokar-staging lien → /opt/suppernote-staging" is_eq "$(readlink "$SB/opt/sokar-staging")" "$SB/opt/suppernote-staging"
check "staging : contenu déplacé (releases/r1/server.js)" test -f "$SB/opt/suppernote-staging/releases/r1/server.js"
check "staging : /var/backups/sokar-staging renommé + lien" test -L "$SB/var/backups/sokar-staging" -a -d "$SB/var/backups/suppernote-staging"
check "prod : /opt/sokar INTACT (vrai dossier)" test -d "$SB/opt/sokar" -a ! -L "$SB/opt/sokar"
check "prod : /var/backups/sokar INTACT" test -d "$SB/var/backups/sokar" -a ! -L "$SB/var/backups/sokar"
for d in etc var/log var/lib; do
    check "partagé : /$d/sokar → lien vers suppernote" test -L "$SB/$d/sokar" -a -d "$SB/$d/suppernote"
done
check "partagé : sbin deploy-root renommé + lien de compat" test -f "$SB/usr/local/sbin/suppernote-deploy-root" -a -L "$SB/usr/local/sbin/sokar-deploy-root"
check "partagé : sbin watchdog renommé (sans lien)" test -f "$SB/usr/local/sbin/suppernote-watchdog" -a ! -e "$SB/usr/local/sbin/sokar-watchdog"
check "staging : sbin staging-backup renommé" test -f "$SB/usr/local/sbin/suppernote-staging-backup-postgres" -a ! -e "$SB/usr/local/sbin/sokar-staging-backup-postgres"
check "prod : sbin backup-postgres intact" test -f "$SB/usr/local/sbin/sokar-backup-postgres" -a ! -e "$SB/usr/local/sbin/suppernote-backup-postgres"
check "cron : staging DÉPLACÉ (pas de doublon)" test -f "$SB/etc/cron.d/suppernote-staging-postgres-backup" -a ! -e "$SB/etc/cron.d/sokar-staging-postgres-backup"
check "cron : r2 déplacé" test -f "$SB/etc/cron.d/suppernote-r2-backup" -a ! -e "$SB/etc/cron.d/sokar-r2-backup"
check "cron : prod intact" test -f "$SB/etc/cron.d/sokar-postgres-backup" -a ! -e "$SB/etc/cron.d/suppernote-postgres-backup"
check "cron : un seul watchdog, remis en service (suppernote-watchdog)" is_eq "$(cron_count watchdog)" 1
check "cron : watchdog sous le nouveau nom" test -f "$SB/etc/cron.d/suppernote-watchdog"
check_not "cron : aucun .rename-hold laissé" bash -c "ls '$SB/etc/cron.d' | grep -q rename-hold"
check "logrotate : un seul fichier, nouveau nom" test -f "$SB/etc/logrotate.d/suppernote" -a ! -e "$SB/etc/logrotate.d/sokar"
check "nginx : snippets renommés (vrais fichiers)" test -f "$SB/etc/nginx/snippets/suppernote-proxy.conf" -a ! -L "$SB/etc/nginx/snippets/suppernote-proxy.conf"
check "nginx : liens de compat des snippets (le site prod en dépend)" test -L "$SB/etc/nginx/snippets/sokar-proxy.conf" -a -L "$SB/etc/nginx/snippets/sokar-security-headers.conf" -a -L "$SB/etc/nginx/snippets/sokar-cloudflare-real-ip.conf"
check "nginx : site staging renommé (available + enabled)" test -f "$SB/etc/nginx/sites-available/suppernote-staging" -a -f "$SB/etc/nginx/sites-enabled/suppernote-staging" -a ! -e "$SB/etc/nginx/sites-enabled/sokar-staging" -a ! -e "$SB/etc/nginx/sites-available/sokar-staging"
check "nginx : site prod intact (octet pour octet)" cmp -s "$TMP/prod-site.orig" "$SB/etc/nginx/sites-available/sokar"
check "nginx : sites-enabled/sokar toujours un lien vers sites-available/sokar" is_eq "$(readlink "$SB/etc/nginx/sites-enabled/sokar")" "../sites-available/sokar"
check "nginx : staging sans ancien chemin ni ancien snippet" no_old_refs "$SB/etc/nginx/sites-available/suppernote-staging"
check "nginx : include staging → snippets suppernote-*" has_text "$SB/etc/nginx/sites-available/suppernote-staging" "include /etc/nginx/snippets/suppernote-proxy.conf;"
check "nginx : upstreams sokar_staging_* conservés (hors périmètre)" has_text "$SB/etc/nginx/sites-available/suppernote-staging" "upstream sokar_staging_api"
check "nginx : domaines sokar.tech conservés" has_text "$SB/etc/nginx/sites-available/suppernote-staging" "server_name staging.sokar.tech;"
check "nginx : reload exécuté une fois" is_eq "$(cat "$STATE/reload_count")" 1
check "sudoers : ancienne ET nouvelle ligne" bash -c "grep -c 'deploy-root' '$SB/etc/sudoers.d/deploy' | grep -qx 2 && grep -q suppernote-deploy-root '$SB/etc/sudoers.d/deploy' && grep -q 'sokar-deploy-root' '$SB/etc/sudoers.d/deploy'"
check "sudoers : mode 0440 conservé" is_eq "$(file_mode "$SB/etc/sudoers.d/deploy")" 440
check "sudoers : validé par visudo -cf" has_text "$STATE/calls.log" "visudo -cf"
check "watchdog : contenu patché pour les chemins déjà renommés (/var/log/suppernote)" has_text "$SB/usr/local/sbin/suppernote-watchdog" "/var/log/suppernote/postgres-r2-backup.log"
check "watchdog : /opt/sokar (prod) PAS encore patché" has_text "$SB/usr/local/sbin/suppernote-watchdog" 'SOKAR_ROOT="${SOKAR_ROOT:-/opt/sokar}"'
check "watchdog : message R2 « Backup offsite sokar terminé » conservé" has_text "$SB/usr/local/sbin/suppernote-watchdog" "Backup offsite sokar terminé"
check "watchdog : dumps sokar-*.dump conservés" has_text "$SB/usr/local/sbin/suppernote-watchdog" "-name 'sokar-*.dump'"
check "wrapper : ROOT prod pas encore patché, ROOT staging patché" bash -c "grep -q 'ROOT=\"/opt/sokar\"' '$SB/usr/local/sbin/suppernote-deploy-root' && grep -q 'ROOT=\"/opt/suppernote-staging\"' '$SB/usr/local/sbin/suppernote-deploy-root'"
check "pm2 : staging aux nouveaux noms, 4 online" is_eq "$(grep -c '^suppernote-staging-.*|online|/opt/suppernote-staging' "$STATE/pm2.list")" 4
check "pm2 : plus aucun ancien process staging" is_eq "$(grep -c '^sokar-staging' "$STATE/pm2.list")" 0
check "pm2 : prod (4 anciens process) non touchée" is_eq "$(grep -c '^sokar-[a-z]*|online|/opt/sokar/' "$STATE/pm2.list")" 4
check "pm2 : aucun stop/delete/restart sur les process prod" is_eq "$(count_calls 'pm2 (stop|delete|restart) sokar-(api|workers|dashboard|connect)( |$)')" 0
check "pm2 : pm2 save exécuté" test -f "$STATE/pm2.saved"
check "pm2 : dump.pm2 mis à jour (nouveaux noms)" has_text "$SB/home/deploy/.pm2/dump.pm2" "suppernote-staging-api"
check "pm2 : commandes lancées via sudo -u deploy" has_text "$STATE/calls.log" "sudo(deploy) pm2 start"
check "docker : aucune commande de recréation (ps/inspect seulement)" is_eq "$(count_calls 'docker (run|start|stop|rm|restart|compose|up|create)')" 0
check "journal : un dossier horodaté dans /root" is_eq "$(journal_dirs)" 1
J="$(ls -d "$SB"/root/rename-suppernote-* | head -1)"
check "journal : run.log, manifest.tsv, backup/, ecosystem-orig/ présents" test -s "$J/run.log" -a -s "$J/manifest.tsv" -a -d "$J/backup" -a -f "$J/ecosystem-orig/staging.config.js"
check "journal : sauvegarde du sudoers d'origine" test -f "$J/backup/etc/sudoers.d/deploy"
check "journal : mode 0700" is_eq "$(file_mode "$J")" 700
check "secrets : aucun canari dans la sortie ni le journal" bash -c "! grep -rq '$CANARY' '$TMP/apply-staging.out' '$J'"
check ".env et watchdog.env intacts (non lus ni modifiés)" bash -c "grep -q '$CANARY' '$SB/etc/suppernote/watchdog.env' && grep -q '$CANARY' '$SB/opt/suppernote-staging/apps/api/.env'"
check "résumé : états affichés" has_text "$TMP/apply-staging.out" "Résumé staging"
check "vérifications : API staging 200" has_text "$TMP/apply-staging.out" "API /health 127.0.0.1:4100 → 200"
snapshot "$SB" >"$TMP/S1"
pm2_sorted >"$TMP/P1"

# Idempotence : relancer apply staging ne change rien.
: >"$STATE/calls.log"
run_script apply --env staging
check "apply staging (2e fois) : code 0" is_eq "$RC" 0
check "idempotence : arborescence identique" diff -q "$TMP/S1" <(snapshot "$SB")
check "idempotence : aucun pm2 stop/delete/start/restart/save" is_eq "$(count_calls 'pm2 (stop|delete|start|restart|save)')" 0
check "idempotence : aucun reload nginx supplémentaire" is_eq "$(cat "$STATE/reload_count")" 1
check "idempotence : état pm2 identique" diff -q "$TMP/P1" <(pm2_sorted)
check "idempotence : cron watchdog toujours unique" is_eq "$(cron_count watchdog)" 1

# ── 5. apply prod ────────────────────────────────────────────────────────────────────────────
run_script apply --env prod
check "apply prod : code 0" is_eq "$RC" 0
cp "$OUT" "$TMP/apply-prod.out"
check "prod : /opt/sokar lien → /opt/suppernote" is_eq "$(readlink "$SB/opt/sokar")" "$SB/opt/suppernote"
check "prod : /var/backups/sokar → lien" test -L "$SB/var/backups/sokar" -a -d "$SB/var/backups/suppernote"
check "prod : site renommé, enabled = lien vers le nouveau site" is_eq "$(readlink "$SB/etc/nginx/sites-enabled/suppernote")" "../sites-available/suppernote"
check "prod : anciens fichiers nginx absents" test ! -e "$SB/etc/nginx/sites-enabled/sokar" -a ! -e "$SB/etc/nginx/sites-available/sokar"
check "prod : cron et sbin backup-postgres déplacés" test -f "$SB/etc/cron.d/suppernote-postgres-backup" -a -f "$SB/usr/local/sbin/suppernote-backup-postgres" -a ! -e "$SB/etc/cron.d/sokar-postgres-backup" -a ! -e "$SB/usr/local/sbin/sokar-backup-postgres"
check "cron.d : exactement 4 fichiers, tous suppernote-*" bash -c "[ \$(ls '$SB/etc/cron.d' | wc -l) -eq 4 ] && [ \$(ls '$SB/etc/cron.d' | grep -c '^suppernote-') -eq 4 ]"
check "nginx : liens de compat des snippets retirés (plus aucune référence)" bash -c "! ls -l '$SB/etc/nginx/snippets' | grep -q 'sokar-'"
check "nginx : site prod sans ancien chemin ni ancien snippet" no_old_refs "$SB/etc/nginx/sites-available/suppernote"
check "nginx : site prod == infra/nginx/suppernote.conf du dépôt (hors commentaires)" bash -c "diff <(grep -v '^[[:space:]]*#' '$SB/etc/nginx/sites-available/suppernote') <(grep -v '^[[:space:]]*#' '$REPO/infra/nginx/suppernote.conf')"
check "nginx : access_log legacy pointe vers /var/log/suppernote" has_text "$SB/etc/nginx/sites-available/suppernote" "access_log /var/log/suppernote/nginx-legacy.log sokar_legacy;"
check "cron watchdog == dépôt" cmp -s "$SB/etc/cron.d/suppernote-watchdog" "$REPO/infra/cron/suppernote-watchdog"
check "cron r2 == dépôt" cmp -s "$SB/etc/cron.d/suppernote-r2-backup" "$REPO/infra/cron/suppernote-r2-backup"
check "cron postgres prod == dépôt" cmp -s "$SB/etc/cron.d/suppernote-postgres-backup" "$REPO/infra/cron/suppernote-postgres-backup"
check "cron postgres staging == dépôt" cmp -s "$SB/etc/cron.d/suppernote-staging-postgres-backup" "$REPO/infra/cron/suppernote-staging-postgres-backup"
check "logrotate == dépôt" cmp -s "$SB/etc/logrotate.d/suppernote" "$REPO/infra/logrotate/suppernote"
check "wrapper : plus aucun ancien chemin de la table" no_old_refs "$SB/usr/local/sbin/suppernote-deploy-root"
check "wrapper : le wrapper installé ne cible plus l'ancien nom (self-update n'écrase pas le lien)" has_text "$SB/usr/local/sbin/suppernote-deploy-root" 'PRIVILEGED_WRAPPER="/usr/local/sbin/suppernote-deploy-root"'
check "wrapper : lien de compat toujours un lien" test -L "$SB/usr/local/sbin/sokar-deploy-root"
check "wrapper : --project-name sokar-monitoring conservé (hors périmètre)" has_text "$SB/usr/local/sbin/suppernote-deploy-root" "--project-name sokar-monitoring"
check "watchdog : plus aucun ancien chemin ni ancien nom de cron" no_old_refs "$SB/usr/local/sbin/suppernote-watchdog"
check "watchdog : SOKAR_ROOT par défaut → /opt/suppernote" has_text "$SB/usr/local/sbin/suppernote-watchdog" 'SOKAR_ROOT="${SOKAR_ROOT:-/opt/suppernote}"'
check "watchdog : pg_isready -U sokar conservé (rôle Postgres)" has_text "$SB/usr/local/sbin/suppernote-watchdog" "pg_isready -U sokar"
check "backup prod : chemins patchés, rôle/base sokar conservés" bash -c "grep -q 'BACKUP_DIR=\"\${BACKUP_DIR:-/var/backups/suppernote}\"' '$SB/usr/local/sbin/suppernote-backup-postgres' && grep -q 'DB_NAME=\"\${POSTGRES_DB:-sokar}\"' '$SB/usr/local/sbin/suppernote-backup-postgres'"
check "backup staging : base sokar_staging conservée" has_text "$SB/usr/local/sbin/suppernote-staging-backup-postgres" 'POSTGRES_DB="${POSTGRES_DB:-sokar_staging}"'
check "pm2 : 8 process online, tous suppernote-*" bash -c "[ \$(grep -c '^suppernote-.*|online|/opt/suppernote' '$STATE/pm2.list') -eq 8 ] && ! grep -q '^sokar-' '$STATE/pm2.list'"
check "pm2 : prod démarrée depuis un ecosystem transformé (cwd /opt/suppernote)" is_eq "$(grep -c '^suppernote-[a-z]*|online|/opt/suppernote/apps' "$STATE/pm2.list")" 4
J2="$(ls -d "$SB"/root/rename-suppernote-* | tail -1)"
check "journal : 2e dossier distinct" is_eq "$(journal_dirs)" 3
check "ecosystem utilisé : aucun ancien nom ni chemin" no_old_refs "$J2/ecosystem-used-prod-fwd.js"
check "ecosystem utilisé == ecosystem du dépôt (hors commentaires)" bash -c "diff <(grep -v '^[[:space:]]*//' '$J2/ecosystem-used-prod-fwd.js') <(grep -v '^[[:space:]]*//' '$REPO/infra/ecosystem.config.js')"
check "sudoers : toujours les deux lignes (2e env : pas de doublon)" is_eq "$(grep -c 'deploy-root' "$SB/etc/sudoers.d/deploy")" 2
check "vérifications prod : API 200" has_text "$TMP/apply-prod.out" "API /health 127.0.0.1:4000 → 200"
check "secrets : aucun canari dans la sortie prod" no_text "$TMP/apply-prod.out" "$CANARY"
check "releases : builds contenant /opt/sokar non touchés (H18)" has_text "$SB/opt/suppernote/releases/r1/server.js" 'require("/opt/sokar/apps/api/dist")'
check ".env : DEBUG_LOG_PATH non touché (H19)" has_text "$SB/opt/suppernote/apps/api/.env" "DEBUG_LOG_PATH=/opt/sokar/apps/api/scratch/call_debug.log"
run_script status --env all
check "status final : NOUVEAU + lien de compatibilité" has_text "$OUT" "NOUVEAU + lien de compatibilité"
check "status final : verdicts RENOMMÉ" bash -c "grep -c 'RENOMMÉ' '$OUT' | grep -qx 2"
snapshot "$SB" >"$TMP/S2"

# ── 6. rollback prod puis staging ────────────────────────────────────────────────────────────
run_script rollback --env prod
check "rollback prod : code 0" is_eq "$RC" 0
check "rollback prod : retour à l'état d'après-staging (arborescence identique)" diff "$TMP/S1" <(snapshot "$SB")
check "rollback prod : pm2 identique à l'état d'après-staging" diff -q "$TMP/P1" <(pm2_sorted)
check "rollback prod : staging reste aux nouveaux noms" test -f "$SB/etc/nginx/sites-available/suppernote-staging" -a -d "$SB/opt/suppernote-staging"
check "rollback prod : cron watchdog unique" is_eq "$(cron_count watchdog)" 1
run_script rollback --env prod
check "rollback prod (2e fois, idempotent) : code 0, rien ne change" bash -c "[ $RC -eq 0 ]" 
check "rollback prod idempotent : arborescence identique" diff -q "$TMP/S1" <(snapshot "$SB")
run_script rollback --env staging
check "rollback staging : code 0" is_eq "$RC" 0
check "rollback staging : état INITIAL identique (arborescence complète : types, modes, liens, cksum)" diff "$TMP/S0" <(snapshot "$SB")
check "rollback staging : pm2 identique à l'état initial (noms, statuts, cwd)" diff "$TMP/P0" <(pm2_sorted)
check "rollback : prod site octet pour octet" cmp -s "$TMP/prod-site.orig" "$SB/etc/nginx/sites-available/sokar"
check "rollback : watchdog octet pour octet" cmp -s "$TMP/watchdog.orig" "$SB/usr/local/sbin/sokar-watchdog"
check "rollback : sudoers d'origine restauré" bash -c "[ \$(grep -c 'deploy-root' '$SB/etc/sudoers.d/deploy') -eq 1 ] && ! grep -q suppernote '$SB/etc/sudoers.d/deploy'"
run_script rollback --env all
check "rollback --env all (déjà revenu) : code 0" is_eq "$RC" 0
check "rollback --env all idempotent : état initial inchangé" diff -q "$TMP/S0" <(snapshot "$SB")
# Réapplication complète puis rollback --env all.
run_script apply --env all
check "apply --env all : code 0" is_eq "$RC" 0
check "apply --env all : 8 process online" is_eq "$(grep -c '^suppernote-.*|online' "$STATE/pm2.list")" 8
snapshot "$SB" >"$TMP/S2b"
check "apply --env all : même état final que staging puis prod séparés" diff -q "$TMP/S2" "$TMP/S2b"
run_script rollback --env all
check "rollback --env all après apply --env all : état initial identique" diff "$TMP/S0" <(snapshot "$SB")
check "rollback --env all : pm2 initial" diff "$TMP/P0" <(pm2_sorted)

# Ordre inverse : prod d'abord (il renomme alors le PARTAGÉ), staging ensuite ; rollback non LIFO.
new_sandbox prodfirst
snapshot "$SB" >"$TMP/R0"
pm2_sorted >"$TMP/RP0"
cp "$SB/etc/nginx/sites-available/sokar-staging" "$TMP/staging-site.orig"
run_script apply --env prod
check "prod d'abord : code 0" is_eq "$RC" 0
check "prod d'abord : staging intact (site, dossier, cron, pm2)" bash -c "cmp -s '$TMP/staging-site.orig' '$SB/etc/nginx/sites-available/sokar-staging' && [ -d '$SB/opt/sokar-staging' ] && [ ! -L '$SB/opt/sokar-staging' ] && [ -f '$SB/etc/cron.d/sokar-staging-postgres-backup' ] && [ \$(grep -c '^sokar-staging-.*|online' '$STATE/pm2.list') -eq 4 ]"
check "prod d'abord : liens de compat des snippets (le site staging en dépend)" test -L "$SB/etc/nginx/snippets/sokar-proxy.conf"
run_script apply --env staging
check "prod puis staging : code 0" is_eq "$RC" 0
check "prod puis staging : même état final que staging puis prod" diff -q "$TMP/S2" <(snapshot "$SB")
run_script rollback --env staging
check "rollback staging EN PREMIER (prod reste renommée) : code 0" is_eq "$RC" 0
check "rollback staging en premier : prod toujours aux nouveaux noms, partagé conservé" test -d "$SB/opt/suppernote" -a -f "$SB/usr/local/sbin/suppernote-watchdog" -a -f "$SB/etc/nginx/sites-available/suppernote" -a -f "$SB/etc/nginx/snippets/suppernote-proxy.conf"
check "rollback staging en premier : staging revenue aux anciens noms (site, dossier)" test -f "$SB/etc/nginx/sites-available/sokar-staging" -a -d "$SB/opt/sokar-staging" -a ! -L "$SB/opt/sokar-staging"
check "rollback staging en premier : snippets compat recréés pour le site staging" test -L "$SB/etc/nginx/snippets/sokar-proxy.conf"
check "rollback staging en premier : 4 process prod suppernote-* online, 4 staging sokar-staging-* online" bash -c "[ \$(grep -c '^suppernote-[a-z]*|online' '$STATE/pm2.list') -eq 4 ] && [ \$(grep -c '^sokar-staging-.*|online' '$STATE/pm2.list') -eq 4 ]"
run_script rollback --env prod
check "puis rollback prod : état initial identique" diff "$TMP/R0" <(snapshot "$SB")
check "puis rollback prod : pm2 initial" diff "$TMP/RP0" <(pm2_sorted)

# --dry-run de rollback et de cleanup-compat : n'écrivent rien.
new_sandbox drybis
run_script apply --env all
snapshot "$SB" >"$TMP/D1"
pm2_sorted >"$TMP/DP1"
run_script rollback --env all --dry-run
check "rollback --dry-run : code 0" is_eq "$RC" 0
check "rollback --dry-run : rien d'écrit" diff -q "$TMP/D1" <(snapshot "$SB")
check "rollback --dry-run : pm2 inchangé" diff -q "$TMP/DP1" <(pm2_sorted)
RENAME_NOW_DATE=2026-12-05 run_script cleanup-compat --env all --dry-run --force
check "cleanup-compat --dry-run : rien d'écrit" diff -q "$TMP/D1" <(snapshot "$SB")

# ── 7. nginx -t en échec → restauration automatique ─────────────────────────────────────────
new_sandbox nginxfail
snapshot "$SB" >"$TMP/F0"
pm2_sorted >"$TMP/FP0"
STUB_NGINX_FAIL_ON=2 run_script apply --env staging
check "nginx -t en échec : code de sortie 4" is_eq "$RC" 4
check "nginx -t en échec : message de retour arrière automatique" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
check "nginx -t en échec : erreur nginx affichée" has_text "$OUT" "échec simulé"
check "nginx -t en échec : arborescence restaurée à l'identique" diff "$TMP/F0" <(snapshot "$SB")
check "nginx -t en échec : pm2 restauré (anciens noms online)" diff "$TMP/FP0" <(pm2_sorted)
check "nginx -t en échec : cron watchdog remis, unique, ancien nom" test "$(cron_count watchdog)" = 1 -a -f "$SB/etc/cron.d/sokar-watchdog"
check "nginx -t en échec : aucun reload effectué" test ! -e "$STATE/reload_count"
check "nginx -t en échec : retour arrière terminé sans anomalie" has_text "$OUT" "l'environnement staging est revenu à son état initial"

# Échec de pm2 start → retour arrière automatique (code 6).
new_sandbox pm2fail
snapshot "$SB" >"$TMP/G0"
pm2_sorted >"$TMP/GP0"
: >"$STATE/pm2_fail_start_once"
run_script apply --env staging
check "pm2 start en échec : code 6" is_eq "$RC" 6
check "pm2 start en échec : retour arrière automatique" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
check "pm2 start en échec : arborescence restaurée" diff "$TMP/G0" <(snapshot "$SB")
check "pm2 start en échec : pm2 restauré (anciens noms online, ecosystem d'origine)" diff "$TMP/GP0" <(pm2_sorted)
check "pm2 start en échec : cron watchdog unique" is_eq "$(cron_count watchdog)" 1

# Échec visudo sur le candidat → rien d'installé, retour arrière.
new_sandbox sudofail
snapshot "$SB" >"$TMP/H0"
STUB_VISUDO_FAIL_CAND=1 run_script apply --env staging
check "visudo refuse le candidat : code 6" is_eq "$RC" 6
check "visudo refuse : sudoers d'origine intact" diff "$TMP/H0" <(snapshot "$SB")
check "visudo refuse : watchdog remis" is_eq "$(cron_count watchdog)" 1

# ── 8. Rollback d'un apply partiellement échoué (état intermédiaire créé à la main) ──────────
new_sandbox partial
snapshot "$SB" >"$TMP/Q0"
pm2_sorted >"$TMP/QP0"
(
    # Simule un apply interrompu après : pm2 stop staging, mv des dossiers partagés + staging, cron watchdog suspendu.
    cd "$SB"
    mv etc/sokar etc/suppernote && ln -s "$SB/etc/suppernote" etc/sokar
    mv var/log/sokar var/log/suppernote && ln -s "$SB/var/log/suppernote" var/log/sokar
    mv opt/sokar-staging opt/suppernote-staging && ln -s "$SB/opt/suppernote-staging" opt/sokar-staging
    mv etc/cron.d/sokar-watchdog etc/cron.d/sokar-watchdog.rename-hold
    mv usr/local/sbin/sokar-watchdog usr/local/sbin/suppernote-watchdog
    mv etc/nginx/snippets/sokar-proxy.conf etc/nginx/snippets/suppernote-proxy.conf
    ln -s "$SB/etc/nginx/snippets/suppernote-proxy.conf" etc/nginx/snippets/sokar-proxy.conf
)
sed -i.bak 's/^\(sokar-staging-[a-z]*\)|online/\1|stopped/' "$STATE/pm2.list" && rm -f "$STATE/pm2.list.bak"
run_script status --env all
check "état partiel : status signale le cron suspendu" has_text "$OUT" "SUSPENDU"
run_script rollback --env staging
check "rollback d'un apply partiel : code 0" is_eq "$RC" 0
check "rollback d'un apply partiel : état initial identique" diff "$TMP/Q0" <(snapshot "$SB")
check "rollback d'un apply partiel : process staging relancés (stopped → online)" diff "$TMP/QP0" <(pm2_sorted)

# ── 8b. Répétition : apply staging seul, puis rollback staging seul → état initial ──────────
new_sandbox repet
snapshot "$SB" >"$TMP/R0"
pm2_sorted >"$TMP/RP0"
run_script apply --env staging
check "répétition : apply staging : code 0" is_eq "$RC" 0
check "répétition : staging renommé (prod intacte)" bash -c "test -d '$SB/opt/suppernote-staging' && test -d '$SB/opt/sokar' && test ! -L '$SB/opt/sokar'"
run_script rollback --env staging
check "répétition : rollback staging seul : code 0" is_eq "$RC" 0
check "répétition : rollback staging seul : état initial identique (partagé défait aussi)" diff "$TMP/R0" <(snapshot "$SB")
check "répétition : rollback staging seul : pm2 initial" diff "$TMP/RP0" <(pm2_sorted)
run_script apply --env staging
check "répétition : nouvel apply staging après rollback : code 0" is_eq "$RC" 0
run_script rollback --env staging
check "répétition : second rollback : état initial identique" diff "$TMP/R0" <(snapshot "$SB")

# ── 9. Préflight en échec : rien n'est modifié ───────────────────────────────────────────────
new_sandbox pfail
mkdir -p "$SB/opt/suppernote-staging"
snapshot "$SB" >"$TMP/I0"
run_script apply --env staging
check "cible déjà présente : code 3" is_eq "$RC" 3
check "cible déjà présente : conflit signalé" has_text "$OUT" "conflit"
check "cible déjà présente : aucune modification" diff -q "$TMP/I0" <(snapshot "$SB")
check "cible déjà présente : aucun pm2 stop" is_eq "$(count_calls 'pm2 (stop|delete|start)')" 0
new_sandbox pfail2
cp "$SCRIPT" "$SB/opt/sokar/rename.sh"
snapshot "$SB" >"$TMP/I1"
RC=0
env PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" RENAME_ROOT_PREFIX="$SB" RENAME_ALLOW_NONROOT=1 TMPDIR="$TMP/tmpdir" \
    bash "$SB/opt/sokar/rename.sh" apply --env staging >"$TMP/pfail2.out" 2>&1 || RC=$?
check "script lancé depuis /opt/sokar : refusé (code 3)" is_eq "$RC" 3
check "script lancé depuis /opt/sokar : message" has_text "$TMP/pfail2.out" "copiez-le dans /root/rename/"
check "script lancé depuis /opt/sokar : rien modifié" diff -q "$TMP/I1" <(snapshot "$SB")
new_sandbox pfail3
sed -i.bak 's/^sokar-staging-api|online/other|online/' "$STATE/pm2.list" && rm -f "$STATE/pm2.list.bak"
run_script preflight --env staging
check "préflight : process pm2 partiellement absents → avertissement, pas d'échec" is_eq "$RC" 0
# nginx -t KO avant toute modification.
new_sandbox pfail4
rm "$SB/etc/nginx/snippets/sokar-proxy.conf"
snapshot "$SB" >"$TMP/I3"
run_script apply --env staging
check "nginx -t déjà KO : préflight refuse (code 3)" is_eq "$RC" 3
check "nginx -t déjà KO : rien modifié" diff -q "$TMP/I3" <(snapshot "$SB")

# ── 10. cleanup-compat ───────────────────────────────────────────────────────────────────────
new_sandbox cleanup
run_script apply --env all
check "cleanup : préparation apply --env all (code 0)" is_eq "$RC" 0
snapshot "$SB" >"$TMP/C0"
RENAME_NOW_DATE=2026-11-24 run_script cleanup-compat --env all
check "cleanup-compat avant le 30/11 : refusé (code 1)" is_eq "$RC" 1
check "cleanup-compat avant le 30/11 : rien modifié" diff -q "$TMP/C0" <(snapshot "$SB")
export RENAME_NOW_DATE=2026-12-01
run_script cleanup-compat --env all
check "cleanup-compat : refusé tant qu'une référence ancienne subsiste (code 3)" is_eq "$RC" 3
check "cleanup-compat : fichier fautif listé (/etc/default/legacy-tool)" has_text "$OUT" "/etc/default/legacy-tool"
check "cleanup-compat : scripts du dépôt non déployés listés" has_text "$OUT" "backup-postgres-r2.sh"
check "cleanup-compat refusé : rien modifié" diff -q "$TMP/C0" <(snapshot "$SB")
rm -f "$SB/etc/default/legacy-tool"
printf '#!/usr/bin/env bash\nBACKUP_DIR=/var/backups/suppernote\nLOG=/var/log/suppernote/postgres-r2-backup.log\n' >"$SB/opt/suppernote/scripts/database/backup-postgres-r2.sh"
run_script cleanup-compat --env staging
check "cleanup-compat --env staging : code 0" is_eq "$RC" 0
check "cleanup staging : liens staging retirés" test ! -e "$SB/opt/sokar-staging" -a ! -L "$SB/opt/sokar-staging" -a ! -L "$SB/var/backups/sokar-staging"
check "cleanup staging : liens prod et partagés conservés (prod en dépend encore)" test -L "$SB/opt/sokar" -a -L "$SB/var/log/sokar" -a -L "$SB/usr/local/sbin/sokar-deploy-root"
check "cleanup staging : ancienne ligne sudoers conservée" has_text "$SB/etc/sudoers.d/deploy" "sokar-deploy-root"
run_script cleanup-compat --env prod
check "cleanup-compat --env prod : code 0" is_eq "$RC" 0
check "cleanup : plus aucun lien de compatibilité" bash -c "[ -z \"\$(find '$SB' \\( -path '$SB/root' -o -path '$SB/tmp' \\) -prune -o -type l -name '*sokar*' -print)\" ]"
check "cleanup : les nouveaux chemins sont intacts" test -d "$SB/opt/suppernote" -a -d "$SB/opt/suppernote-staging" -a -d "$SB/var/log/suppernote" -a -f "$SB/usr/local/sbin/suppernote-deploy-root"
check "cleanup : sudoers = nouvelle ligne seule" bash -c "grep -q suppernote-deploy-root '$SB/etc/sudoers.d/deploy' && ! grep -q 'sokar-deploy-root' '$SB/etc/sudoers.d/deploy'"
check "cleanup : DEBUG_LOG_PATH non touché sans --patch-debug-log-path" has_text "$SB/opt/suppernote/apps/api/.env" "DEBUG_LOG_PATH=/opt/sokar/apps/api"
run_script cleanup-compat --env all --patch-debug-log-path
check "cleanup --patch-debug-log-path : préfixe corrigé" has_text "$SB/opt/suppernote/apps/api/.env" "DEBUG_LOG_PATH=/opt/suppernote/apps/api/scratch/call_debug.log"
check "cleanup --patch-debug-log-path : valeur jamais imprimée" no_text "$OUT" "call_debug.log"
check "cleanup --patch-debug-log-path : secrets conservés et non imprimés" bash -c "grep -q '$CANARY' '$SB/opt/suppernote/apps/api/.env' && ! grep -q '$CANARY' '$OUT'"
unset RENAME_NOW_DATE

# ── 11. pm2 jlist SANS saut de ligne final (vraie sortie du VPS) : le dernier process ne doit pas être perdu ──
# Régression : `while read` ne passait pas dans le corps de la boucle pour la dernière ligne sans \n,
# donc sokar-staging-connect (dernier de la liste) était invisible : ni arrêté, ni supprimé, port 4102 en conflit.
jlist_last_byte() { PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" pm2 jlist | tail -c 1; }
pm2_calls_mention() { grep -E "$1" "$STATE/calls.log" | grep -q -- "$2"; }
count_stop_names() { grep 'pm2 stop' "$1" | grep -o 'sokar-staging-[a-z]*' | sort -u | wc -l | tr -d ' '; }
no_old_staging_left() { ! grep -q '^sokar-staging' "$STATE/pm2.list"; }
no_new_staging_left() { ! grep -q '^suppernote-staging' "$STATE/pm2.list"; }

new_sandbox nonl
: >"$STATE/jlist_nonl"
check "jlist sans saut de ligne : le stub finit bien par « ] »" is_eq "$(jlist_last_byte)" "]"
run_script preflight --env staging
check "jlist sans saut de ligne : préflight staging code 0" is_eq "$RC" 0
check "jlist sans saut de ligne : préflight staging voit les 4 anciens process" has_text "$OUT" "4 ancien(s), 0 nouveau(x) process (sur 4 attendus)"
check "jlist sans saut de ligne : préflight, comptage brut = analysé" has_text "$OUT" "jlist : 8 process lus, 8 analysés"
run_script preflight --env prod
check "jlist sans saut de ligne : préflight prod voit les 4 anciens process" has_text "$OUT" "4 ancien(s), 0 nouveau(x) process (sur 4 attendus)"
run_script apply --env staging --dry-run
check "jlist sans saut de ligne : dry-run staging annonce l'arrêt de sokar-staging-connect" has_text "$OUT" "sokar-staging-connect"
check "jlist sans saut de ligne : dry-run staging annonce l'arrêt des 4 process staging" is_eq "$(count_stop_names "$OUT")" 4
run_script apply --env all --dry-run
check "jlist sans saut de ligne : dry-run all code 0" is_eq "$RC" 0
check "jlist sans saut de ligne : dry-run all annonce l'arrêt de sokar-staging-connect" bash -c 'grep "pm2 stop" "$1" | grep -q "sokar-staging-connect"' _ "$OUT"
check "jlist sans saut de ligne : dry-run all annonce l'arrêt de sokar-connect (prod)" bash -c 'grep "pm2 stop" "$1" | grep -qE "sokar-connect( |$)"' _ "$OUT"
check "jlist sans saut de ligne : dry-run all aucun pm2 stop/delete/start effectif" is_eq "$(count_calls 'pm2 (stop|delete|start|save|restart)')" 0
run_script apply --env staging
check "jlist sans saut de ligne : apply staging code 0" is_eq "$RC" 0
check "jlist sans saut de ligne : sokar-staging-connect arrêté" pm2_calls_mention 'pm2 stop' sokar-staging-connect
check "jlist sans saut de ligne : sokar-staging-connect supprimé" pm2_calls_mention 'pm2 delete' sokar-staging-connect
check "jlist sans saut de ligne : staging aux nouveaux noms, 4 online" is_eq "$(grep -c '^suppernote-staging-.*|online|/opt/suppernote-staging' "$STATE/pm2.list")" 4
check "jlist sans saut de ligne : aucun ancien process staging" no_old_staging_left
check "jlist sans saut de ligne : prod intacte (4 anciens online)" is_eq "$(grep -c '^sokar-[a-z]*|online|/opt/sokar/' "$STATE/pm2.list")" 4
run_script rollback --env staging
check "jlist sans saut de ligne : rollback staging code 0" is_eq "$RC" 0
check "jlist sans saut de ligne : rollback staging, 4 anciens online" is_eq "$(grep -c '^sokar-staging-.*|online' "$STATE/pm2.list")" 4
check "jlist sans saut de ligne : rollback staging, aucun nouveau process" no_new_staging_left

# Garde-fou : si la boucle de lecture perdait à nouveau un process, le préflight et l'apply doivent ÉCHOUER
# (comptage brut ≠ analysé). Mutation : on retire la correction `|| [ -n "$line" ]` du script testé ;
# la garde seule doit alors tout arrêter, avant la moindre modification.
new_sandbox nonlguard
: >"$STATE/jlist_nonl"
MUT="$TMP/mutant-rename.sh"
sed 's/ || \[ -n "\$line" \]; do$/; do/' "$SCRIPT" >"$MUT"
check "mutation : la correction a bien été retirée du mutant" bash -c '! cmp -s "$1" "$2"' _ "$SCRIPT" "$MUT"
SCRIPT_REAL="$SCRIPT"
SCRIPT="$MUT"
snapshot "$SB" >"$TMP/NG0"
run_script preflight --env staging
check "garde-fou : préflight en échec si un process est perdu (code 3)" is_eq "$RC" 3
check "garde-fou : message explicite (8 lus, 7 analysés)" has_text "$OUT" "jlist : 8 process lus, 7 analysés"
run_script apply --env staging
check "garde-fou : apply refusé (code 3)" is_eq "$RC" 3
check "garde-fou : apply refusé, rien modifié" diff -q "$TMP/NG0" <(snapshot "$SB")
check "garde-fou : aucun pm2 stop/delete/start/save/restart" is_eq "$(count_calls 'pm2 (stop|delete|start|save|restart)')" 0
SCRIPT="$SCRIPT_REAL"

# ── 12. pm2 jlist VIDE ([]) : régression QA B1' ────────────────────────────────────────────────
# `grep -o` à 0 correspondance rend 1 ; dans la substitution, l'ERR trap hérité par le sous-shell se
# déclenchait et apply lançait un « retour arrière automatique » parasite (pm2 start de l'ecosystem
# ancien + pm2 save AVANT le moindre pm2 stop). Attendu : refus propre du préflight (code 3), aucune
# commande pm2 d'écriture, aucune modification, aucun retour arrière.
no_rollback_noise() { ! grep -qiE 'retour arrière automatique|trap ERR|erreur inattendue' "$1"; }
new_sandbox pm2empty
: >"$STATE/pm2.list"
check "pm2 vide : le stub renvoie bien []" is_eq "$(PATH="$TMP/stubs:$PATH" STUB_STATE="$STATE" pm2 jlist | tail -n 1)" "[]"
snapshot "$SB" >"$TMP/PE0"
run_script preflight --env staging
check "pm2 vide : préflight staging refuse (code 3)" is_eq "$RC" 3
check "pm2 vide : préflight, 0 process lu, 0 analysé" has_text "$OUT" "jlist : 0 process lus, 0 analysés"
check "pm2 vide : préflight sans retour arrière parasite" no_rollback_noise "$OUT"
run_script apply --env staging
check "pm2 vide : apply staging refuse (code 3)" is_eq "$RC" 3
check "pm2 vide : apply staging sans retour arrière automatique" no_rollback_noise "$OUT"
check "pm2 vide : apply staging, aucune commande pm2 d'écriture" is_eq "$(count_calls 'pm2 (start|stop|delete|save|restart)')" 0
check "pm2 vide : apply staging, rien modifié" diff -q "$TMP/PE0" <(snapshot "$SB")
check "pm2 vide : apply staging, pm2 toujours vide" is_eq "$(wc -c <"$STATE/pm2.list" | tr -d ' ')" 0
run_script apply --env all
check "pm2 vide : apply all refuse (code 3)" is_eq "$RC" 3
check "pm2 vide : apply all sans retour arrière automatique" no_rollback_noise "$OUT"
check "pm2 vide : apply all, aucune commande pm2 d'écriture" is_eq "$(count_calls 'pm2 (start|stop|delete|save|restart)')" 0
check "pm2 vide : apply all, rien modifié" diff -q "$TMP/PE0" <(snapshot "$SB")


# ── 13. Signaux envoyés au GROUPE de process (vrai Ctrl-C au clavier, coupure SSH, kill) ────────
# Régression QA (t_192d48f9) : sans `trap … INT TERM HUP`, un Ctrl-C (SIGINT au groupe en avant-plan) ou une
# coupure SSH (SIGHUP au groupe) pendant `apply` tuait le script au milieu de l'opération : aucun retour
# arrière automatique, process pm2 laissés arrêtés. Attendu maintenant (pendant `apply`, avant que le
# trafic ne passe par les nouveaux process) : retour arrière automatique, code 6. Après (vérifications) et
# pendant un `rollback` : AUCUN retour arrière automatique, code 128+n, décision humaine (runbook §3.11).
# Signal pendant un retour arrière automatique déclenché par une ERREUR (nginx -t, pm2 start ; régression QA
# t_e9968759 B1) : ignoré, retour arrière mené à terme, code d'origine 4/6 conservé (cas X1/X2 plus bas).
#
# Lancement : `set -m` dans un sous-shell donne au script son propre groupe de process (pgid = pid), comme
# un shell de terminal ; le signal part par `kill -s SIG -- -pgid`, donc aussi vers la commande lente en
# cours (stub pm2/nginx/systemctl/curl). Portable bash 3.2 (Mac) et bash 5.2 (Linux), sans setsid ni python.
# Les stubs lents du dossier $TMP/slow se bloquent (sleep) au N-ième appel de la commande visée, après avoir
# posé un drapeau que le lanceur attend avant d'envoyer le signal.
SLOWDIR="$TMP/slow"
make_slow_stubs() {
    mkdir -p "$SLOWDIR"
    local c
    for c in pm2 systemctl nginx curl; do
        cat >"$SLOWDIR/$c" <<'EOF'
#!/usr/bin/env bash
# Stub lent : au SLOW_NTH-ième appel qui correspond à SLOW_ON (motif `nom:sous-commande`), pose un drapeau
# puis dort SLOW_SECS secondes (le signal de groupe le tue). Ensuite, délègue au stub normal.
S="$STUB_STATE"; name="$(basename "$0")"; sub="${1:-}"
case "$name:$sub" in
  $SLOW_ON)
    n=$(cat "$S/slow.n" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" >"$S/slow.n"
    if [ "$n" = "${SLOW_NTH:-1}" ]; then touch "$S/slow.flag"; sleep "${SLOW_SECS:-20}"; fi
    if [ -n "${SLOW_NTH2:-}" ] && [ "$n" = "$SLOW_NTH2" ]; then touch "$S/slow.flag2"; sleep "${SLOW_SECS2:-3}"; fi
    ;;
esac
exec "$TMP_STUBS/$name" "$@"
EOF
        chmod +x "$SLOWDIR/$c"
    done
}

# sig_run <commande> <env> <SLOW_ON> <nième appel> <signal> [signal2 envoyé quand le 2e drapeau apparaît]
# Résultat : RC (code de sortie du script, 999 = bloqué/tué), SENT (1 si le signal est parti), OUT.
sig_run() {
    local cmd="$1" envx="$2" slow="$3" nth="$4" sg="$5" sg2="${6:-}" rcf
    NRUN=$((NRUN + 1))
    OUT="$TMP/out-$NRUN.txt"
    rcf="$TMP/rc-$NRUN"
    rm -f "$STATE/slow.flag" "$STATE/slow.flag2" "$STATE/slow.n" "$rcf"
    (
        set -m
        env PATH="$SLOWDIR:$TMP/stubs:$PATH" TMP_STUBS="$TMP/stubs" STUB_STATE="$STATE" RENAME_ROOT_PREFIX="$SB" \
            RENAME_ALLOW_NONROOT=1 RENAME_POLL_SLEEP=0 RENAME_VERIFY_TIMEOUT=2 RENAME_MIN_FREE_KB=1024 TMPDIR="$TMP/tmpdir" \
            STUB_NGINX_FAIL_ON="${STUB_NGINX_FAIL_ON:-}" \
            SLOW_ON="$slow" SLOW_NTH="$nth" SLOW_NTH2="${sg2:+$((nth + 1))}" \
            bash "$SCRIPT" "$cmd" --env "$envx" >"$OUT" 2>&1 </dev/null &
        pid=$!
        i=0
        while [ ! -e "$STATE/slow.flag" ] && kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do
            sleep 0.1
            i=$((i + 1))
        done
        sent=0
        if [ -e "$STATE/slow.flag" ]; then
            sleep 0.3
            kill -s "$sg" -- "-$pid" 2>/dev/null || true
            sent=1
            if [ -n "$sg2" ]; then
                i=0
                while [ ! -e "$STATE/slow.flag2" ] && kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do
                    sleep 0.1
                    i=$((i + 1))
                done
                sleep 0.3
                kill -s "$sg2" -- "-$pid" 2>/dev/null || true
            fi
        fi
        i=0
        while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 400 ]; do
            sleep 0.1
            i=$((i + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            kill -s KILL -- "-$pid" 2>/dev/null || true
            echo 999 >"$rcf.tmp"
        else
            rc=0
            wait "$pid" 2>/dev/null || rc=$?
            echo "$rc" >"$rcf.tmp"
        fi
        kill -s KILL -- "-$pid" 2>/dev/null || true
        echo "$sent" >"$rcf.sent"
        mv "$rcf.tmp" "$rcf"
    ) >/dev/null 2>&1 || true
    RC="$(cat "$rcf" 2>/dev/null || echo 998)"
    SENT="$(cat "$rcf.sent" 2>/dev/null || echo 0)"
    rm -f "$STATE/nginx_t_count"
}

sig_n() { case "$1" in INT) echo 130 ;; HUP) echo 129 ;; TERM) echo 143 ;; esac; }
online_count() { grep -c "$1" "$STATE/pm2.list" || true; }
lock_free() { [ ! -e "$SB/var/lock/rename-sokar-to-suppernote.lock" ]; }
watchdog_back() { [ "$(cron_count rename-hold)" = 0 ] && [ "$(cron_count watchdog)" = 1 ]; }
rollbacks_in_out() { grep -c '══ ROLLBACK .* ══$' "$OUT" || true; }
# Lignes d'ouverture seules (« ══ ROLLBACK staging ══ ») : un rollback mené à terme écrit en plus « ══ ROLLBACK staging terminé … ══ ».
rollback_starts_in_out() { grep -c '══ ROLLBACK [A-Za-z-]* ══$' "$OUT" || true; }
log_has_sig() { has_text "$OUT" "interruption par SIG$1 à l'étape"; }
same_state() { # fichier-snapshot-avant fichier-pm2-avant
    diff -r "$1" <(snapshot "$SB") >/dev/null 2>&1 && diff "$2" <(pm2_sorted) >/dev/null 2>&1
}

# Cas A : signal pendant `apply` (phase pre) → retour arrière automatique, code 6, état initial, apply relançable.
sig_case_apply() { # signal env slow_on nth libellé
    local sg="$1" envx="$2" slow="$3" nth="$4" lbl="$5" old_rx
    if [ "$envx" = staging ]; then old_rx='^sokar-staging-.*|online|/opt/sokar-staging'; else old_rx='^sokar-[a-z]*|online|/opt/sokar/'; fi
    new_sandbox "sig-$sg-$envx"
    snapshot "$SB" >"$TMP/sigA.snap"
    pm2_sorted >"$TMP/sigA.pm2"
    sig_run apply "$envx" "$slow" "$nth" "$sg"
    local p="$lbl [$envx, SIG$sg]"
    check "$p : le signal est parti pendant la commande lente" is_eq "$SENT" 1
    check "$p : code 6 (retour arrière automatique)" is_eq "$RC" 6
    check "$p : journal « interruption par SIG$sg »" log_has_sig "$sg"
    check "$p : journal « RETOUR ARRIÈRE AUTOMATIQUE »" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
    check "$p : retour arrière terminé sans anomalie" has_text "$OUT" "revenu à son état initial"
    check "$p : 4 process anciens online" is_eq "$(online_count "$old_rx")" 4
    check "$p : état identique à l'initial (fichiers, liens, modes, pm2)" same_state "$TMP/sigA.snap" "$TMP/sigA.pm2"
    check "$p : verrou libéré" lock_free
    check "$p : cron watchdog remis (un seul, pas de .rename-hold)" watchdog_back
    run_script apply --env "$envx"
    check "$p : apply relancé ensuite : code 0" is_eq "$RC" 0
}

# Cas B : signal pendant la vérification finale (phase post) → pas de retour arrière, code 128+n, état renommé intact.
sig_case_post() { # signal env
    local sg="$1" envx="$2" n p
    n="$(sig_n "$sg")"
    p="vérification finale [$envx, SIG$sg]"
    new_sandbox "sigref-$envx"
    run_script apply --env "$envx"
    snapshot "$SB" >"$TMP/sigB.snap"
    pm2_sorted >"$TMP/sigB.pm2"
    new_sandbox "sigpost-$sg-$envx"
    sig_run apply "$envx" 'curl:*' 1 "$sg"
    check "$p : le signal est parti pendant le curl lent" is_eq "$SENT" 1
    check "$p : code $n (128+n), pas 6" is_eq "$RC" "$n"
    check "$p : journal « interruption par SIG$sg » en phase post" has_text "$OUT" "interruption par SIG$sg à l'étape « vérifications » (phase post)"
    check_not "$p : aucun retour arrière automatique" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
    check "$p : message de décision humaine (§3.11)" has_text "$OUT" "décision humaine"
    check "$p : état « renommé » intact (identique à un apply abouti)" same_state "$TMP/sigB.snap" "$TMP/sigB.pm2"
    check "$p : verrou libéré" lock_free
    check "$p : cron watchdog remis" watchdog_back
}

# Cas C : signal pendant `rollback` → pas de rollback récursif, code 128+n, watchdog remis, `rollback` relançable.
sig_case_rollback() { # signal env slow_on libellé
    local sg="$1" envx="$2" slow="$3" lbl="$4" n p
    n="$(sig_n "$sg")"
    p="$lbl [rollback $envx, SIG$sg]"
    new_sandbox "sigrb-$sg-$envx"
    snapshot "$SB" >"$TMP/sigC.snap"
    pm2_sorted >"$TMP/sigC.pm2"
    run_script apply --env "$envx"
    sig_run rollback "$envx" "$slow" 1 "$sg"
    check "$p : le signal est parti pendant la commande lente" is_eq "$SENT" 1
    check "$p : code $n (128+n)" is_eq "$RC" "$n"
    check "$p : journal « interruption par SIG$sg »" log_has_sig "$sg"
    check_not "$p : aucun retour arrière automatique" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
    check "$p : un seul rollback (pas de rollback récursif)" is_eq "$(rollbacks_in_out)" 1
    check "$p : message de décision humaine (§3.11)" has_text "$OUT" "décision humaine"
    check "$p : verrou libéré" lock_free
    check "$p : cron watchdog remis" watchdog_back
    run_script rollback --env "$envx"
    check "$p : rollback relancé ensuite : code 0" is_eq "$RC" 0
    check "$p : état initial identique après le 2e rollback" same_state "$TMP/sigC.snap" "$TMP/sigC.pm2"
}

make_slow_stubs

# Précondition : INT/HUP/TERM ne doivent pas être ignorés à l'entrée du test (lancé via `nohup` ou en tâche de
# fond `&` sans job control, bash ne peut alors plus les piéger et le test mesurerait autre chose que le script).
sig_ignored_at_entry() { # signal → 0 si le signal est ignoré dans l'environnement du test
    local rc=0
    bash -c 'trap "exit 77" "$1"; kill -s "$1" $$; sleep 0.3' _ "$1" || rc=$?
    [ "$rc" != 77 ]
}
for sg in INT HUP TERM; do
    check_not "précondition : SIG$sg non ignoré à l'entrée du test (pas de nohup ni de & sans job control)" sig_ignored_at_entry "$sg"
done
echo "-- signaux de groupe : apply interrompu (matrice SIG × étape × environnement) --"
SIG_STEPS="pm2:stop:1:pm2-stop pm2:delete:1:pm2-delete pm2:start:1:pm2-start nginx:-t:2:nginx--t systemctl:reload:1:systemctl-reload-nginx"
for sgenv in staging prod; do
    for sg in INT HUP TERM; do
        for st in $SIG_STEPS; do
            slow="${st%%:*}:$(echo "$st" | cut -d: -f2)"
            nth="$(echo "$st" | cut -d: -f3)"
            lbl="$(echo "$st" | cut -d: -f4- | tr '-' ' ')"
            sig_case_apply "$sg" "$sgenv" "$slow" "$nth" "$lbl"
        done
    done
done

echo "-- signaux de groupe : avant toute modification (préflight) --"
new_sandbox sigpf
snapshot "$SB" >"$TMP/sigpf.snap"
pm2_sorted >"$TMP/sigpf.pm2"
sig_run apply staging 'nginx:-t' 1 INT
check "préflight [SIGINT] : le signal est parti" is_eq "$SENT" 1
check "préflight [SIGINT] : code 130, pas de retour arrière" is_eq "$RC" 130
check "préflight [SIGINT] : journal « interruption par SIGINT »" log_has_sig INT
check_not "préflight [SIGINT] : aucun retour arrière automatique" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
check "préflight [SIGINT] : rien n'a été modifié" same_state "$TMP/sigpf.snap" "$TMP/sigpf.pm2"
check "préflight [SIGINT] : verrou libéré" lock_free

# Commande en lecture seule (`preflight`) : code 128+n, message dédié, rien modifié.
new_sandbox sigpf2
snapshot "$SB" >"$TMP/sigpf2.snap"
pm2_sorted >"$TMP/sigpf2.pm2"
sig_run preflight staging 'nginx:-t' 1 TERM
check "commande preflight [SIGTERM] : le signal est parti" is_eq "$SENT" 1
check "commande preflight [SIGTERM] : code 143" is_eq "$RC" 143
check "commande preflight [SIGTERM] : journal « interruption par SIGTERM »" log_has_sig TERM
check "commande preflight [SIGTERM] : message « lecture seule »" has_text "$OUT" "lecture seule"
check "commande preflight [SIGTERM] : rien n'a été modifié" same_state "$TMP/sigpf2.snap" "$TMP/sigpf2.pm2"

echo "-- signaux de groupe : vérification finale (phase post) --"
for sg in INT HUP TERM; do
    sig_case_post "$sg" staging
done
sig_case_post INT prod

echo "-- signaux de groupe : rollback interrompu --"
for sg in INT HUP TERM; do
    for st in pm2:delete pm2:start systemctl:reload; do
        sig_case_rollback "$sg" staging "$st" "$st"
    done
done
sig_case_rollback INT prod pm2:start "pm2:start"
sig_case_rollback INT prod systemctl:reload "systemctl:reload"

echo "-- signaux de groupe : second signal pendant le retour arrière automatique --"
# apply staging interrompu au 1er `pm2 start` (SIGINT) ; le 2e `pm2 start` (celui du retour arrière) est lent à son
# tour et reçoit un 2e Ctrl-C : le retour arrière doit aller au bout (code 6, état initial).
new_sandbox sig2
snapshot "$SB" >"$TMP/sig2.snap"
pm2_sorted >"$TMP/sig2.pm2"
sig_run apply staging 'pm2:start' 1 INT INT
check "2 Ctrl-C : les deux signaux sont partis" bash -c "[ '$SENT' = 1 ] && [ -e '$STATE/slow.flag2' ]"
check "2 Ctrl-C : code 6 (retour arrière mené à terme)" is_eq "$RC" 6
check "2 Ctrl-C : retour arrière terminé sans anomalie" has_text "$OUT" "revenu à son état initial"
check "2 Ctrl-C : état identique à l'initial" same_state "$TMP/sig2.snap" "$TMP/sig2.pm2"
check "2 Ctrl-C : verrou libéré" lock_free
check "2 Ctrl-C : cron watchdog remis" watchdog_back

echo "-- signaux de groupe : signal pendant le retour arrière déclenché par une ERREUR (nginx -t, pm2 start) --"
# Cas D (X1/X2 de la QA t_e9968759, B1) : le retour arrière automatique est ici déclenché par abort_apply sur ERREUR,
# pas par un signal. Un INT/HUP/TERM envoyé au groupe pendant ce retour arrière doit être ignoré (abort_apply pose
# `trap '' INT TERM HUP`) : le retour arrière va au bout et le code d'ORIGINE est conservé (4 nginx, 6 pm2),
# pas 128+n. Le stub lent garde son `sleep` (signal ignoré, hérité) : SLOW_SECS=3 limite la durée du test.
#   X1 : le 2e `nginx -t` (1er après les modifications) échoue ; le signal part pendant le 3e (celui du rollback).
#   X2 : le 1er `pm2 start` échoue ; le signal part pendant le 2e (celui du rollback).
sig_case_errrb() { # signal nginx|pm2
    local sg="$1" kind="$2" want p old_rx
    old_rx='^sokar-staging-.*|online|/opt/sokar-staging'
    new_sandbox "errrb-$kind-$sg"
    snapshot "$SB" >"$TMP/sigD.snap"
    pm2_sorted >"$TMP/sigD.pm2"
    if [ "$kind" = nginx ]; then
        want=4
        p="X1 nginx -t en échec puis SIG$sg pendant le rollback"
        STUB_NGINX_FAIL_ON=2 SLOW_SECS=3 sig_run apply staging 'nginx:-t' 3 "$sg"
    else
        want=6
        p="X2 pm2 start en échec puis SIG$sg pendant le rollback"
        : >"$STATE/pm2_fail_start_once"
        SLOW_SECS=3 sig_run apply staging 'pm2:start' 2 "$sg"
    fi
    check "$p : le signal est parti pendant la commande lente du retour arrière" is_eq "$SENT" 1
    check "$p : code d'origine $want conservé (ni 128+n, ni blocage)" is_eq "$RC" "$want"
    if [ "$kind" = nginx ]; then
        check "$p : l'échec d'origine est bien nginx -t" has_text "$OUT" "ÉCHEC : nginx -t échoue après les modifications"
    else
        check "$p : l'échec d'origine est bien pm2 start" has_text "$OUT" "ÉCHEC : pm2 start a échoué"
    fi
    check "$p : journal « RETOUR ARRIÈRE AUTOMATIQUE »" has_text "$OUT" "RETOUR ARRIÈRE AUTOMATIQUE"
    check_not "$p : signal ignoré (aucune ligne « interruption par SIG$sg »)" log_has_sig "$sg"
    check_not "$p : pas de « Aucun retour arrière automatique à ce stade »" has_text "$OUT" "Aucun retour arrière automatique"
    check "$p : retour arrière terminé sans anomalie" has_text "$OUT" "revenu à son état initial"
    check "$p : un seul rollback (une seule ligne d'ouverture « ══ ROLLBACK … ══ »)" is_eq "$(rollback_starts_in_out)" 1
    check "$p : 4 process anciens online" is_eq "$(online_count "$old_rx")" 4
    check "$p : état identique à l'initial (fichiers, liens, modes, pm2)" same_state "$TMP/sigD.snap" "$TMP/sigD.pm2"
    check "$p : verrou libéré" lock_free
    check "$p : cron watchdog remis (un seul, pas de .rename-hold)" watchdog_back
    run_script apply --env staging
    check "$p : apply relancé ensuite : code 0" is_eq "$RC" 0
}
for sg in INT HUP TERM; do
    sig_case_errrb "$sg" nginx
    sig_case_errrb "$sg" pm2
done

# La commande `rollback` MANUELLE reste interruptible (code 128+n, un seul rollback, pas de récursion) : couverte plus
# haut par sig_case_rollback. Le correctif d'abort_apply ne doit pas la rendre sourde aux signaux.

# Garde AUTO_RB du gestionnaire : avec abort_apply sourd aux signaux, on_signal ne peut plus s'exécuter pendant un
# retour arrière automatique (AUTO_RB=1) ; la garde est une défense en profondeur que seul un test unitaire de la
# fonction atteint. Le script est chargé sans `main`, abort_apply est remplacé par une sentinelle : avec AUTO_RB=1,
# on_signal ne doit PAS relancer de retour arrière (sortie 130, sentinelle jamais appelée).
guard_on_signal_case() {
    local lib="$TMP/script-lib-$NRUN.sh" o="$TMP/guard-$NRUN.out" rc=0
    NRUN=$((NRUN + 1))
    grep -v '^main "\$@"$' "$SCRIPT" >"$lib"
    bash -c '
        . "$1"
        trap - ERR EXIT
        set +eu
        log() { :; }
        abort_apply() { echo ABORT_APPELE; exit 6; }
        CMD=apply; PHASE=pre; AUTO_RB=1; DRY=0; CUR_ENV=staging; STEP=test; ENV_ARG=staging
        on_signal INT
    ' _ "$lib" >"$o" 2>&1 || rc=$?
    check "garde AUTO_RB : on_signal pendant un retour arrière automatique sort 130" is_eq "$rc" 130
    check_not "garde AUTO_RB : pas de second retour arrière (abort_apply non rappelé)" has_text "$o" "ABORT_APPELE"
}
guard_on_signal_case

# Mutation : sans les `trap … INT TERM HUP` (l'état du script avant correction), les cas ci-dessus doivent ÉCHOUER.
# On rejoue un échantillon sur le mutant avec MUTE=1 (les échecs sont comptés, pas affichés) : chaque scénario
# doit produire au moins un échec.
echo "-- mutation : le script sans trap de signal doit faire échouer ces cas --"
MUT_SIG="$TMP/mutant-signal.sh"
grep -v "^[[:space:]]*trap 'on_signal " "$SCRIPT" >"$MUT_SIG"
check "mutation signaux : les 3 trap ont bien été retirés du mutant" bash -c "! cmp -s '$SCRIPT' '$MUT_SIG' && ! grep -q 'trap .on_signal' '$MUT_SIG'"
SCRIPT_REAL="$SCRIPT"
SCRIPT="$MUT_SIG"
mutant_must_fail() { # description commande…
    local d="$1" before
    shift
    MUTE=1
    MUT_FAILS=0
    "$@" >/dev/null 2>&1 || true
    before="$MUT_FAILS"
    MUTE=0
    if [ "$before" -gt 0 ]; then pass "mutation : $d → échoue sans trap ($before contrôle(s) rouge(s))"; else fail "mutation : $d devrait échouer sans trap"; fi
}
mutant_must_fail "apply staging, SIGINT pendant pm2 delete" sig_case_apply INT staging pm2:delete 1 "mutant pm2 delete"
mutant_must_fail "apply staging, SIGHUP pendant systemctl reload" sig_case_apply HUP staging systemctl:reload 1 "mutant reload"
mutant_must_fail "apply prod, SIGTERM pendant pm2 start" sig_case_apply TERM prod pm2:start 1 "mutant pm2 start"
mutant_must_fail "apply staging, SIGINT pendant nginx -t" sig_case_apply INT staging nginx:-t 2 "mutant nginx -t"
mutant_must_fail "vérification finale, SIGINT" sig_case_post INT staging
mutant_must_fail "rollback interrompu, SIGHUP" sig_case_rollback HUP staging pm2:start "mutant rollback"
SCRIPT="$SCRIPT_REAL"

# Mutation B1 : sans le `trap '' INT TERM HUP` d'abort_apply (état de 499e1279), les cas X1/X2 doivent ÉCHOUER
# (retour arrière d'erreur interrompu : code 130/129/143 au lieu de 4/6). Le mutant ne retire que la ligne
# d'abort_apply ; celle d'on_signal reste.
MUT_B1="$TMP/mutant-b1.sh"
sed "/^abort_apply() {/,/^}/{/^[[:space:]]*trap '' INT TERM HUP\$/d;}" "$SCRIPT" >"$MUT_B1"
count_ignore_traps() { grep -c "^[[:space:]]*trap '' INT TERM HUP\$" "$1" || true; }
mutant_b1_ok() {
    [ "$(count_ignore_traps "$SCRIPT")" = 2 ] && [ "$(count_ignore_traps "$MUT_B1")" = 1 ] &&
        ! sed -n '/^abort_apply() {/,/^}/p' "$MUT_B1" | grep -q "trap '' INT"
}
check "mutation B1 : la ligne a bien été retirée d'abort_apply seul (on_signal garde la sienne)" mutant_b1_ok
SCRIPT="$MUT_B1"
for sg in INT HUP TERM; do
    mutant_must_fail "X1 nginx -t en échec, SIG$sg pendant le rollback" sig_case_errrb "$sg" nginx
    mutant_must_fail "X2 pm2 start en échec, SIG$sg pendant le rollback" sig_case_errrb "$sg" pm2
done
SCRIPT="$SCRIPT_REAL"

# Mutation M3 : garde AUTO_RB retirée du gestionnaire on_signal (survivant de la QA, inatteignable par un vrai signal
# une fois abort_apply sourd) : le test unitaire ci-dessus doit le tuer.
MUT_M3="$TMP/mutant-m3.sh"
sed '/^    if \[ "\$CMD" = apply \] && \[ "\$PHASE" = pre \] && \[ "\$AUTO_RB" = 0 \]/s/ && \[ "\$AUTO_RB" = 0 \]//' "$SCRIPT" >"$MUT_M3"
count_autorb_guards() { grep -c 'AUTO_RB" = 0' "$1" || true; }
mutant_m3_ok() { [ "$(count_autorb_guards "$SCRIPT")" = "$(($(count_autorb_guards "$MUT_M3") + 1))" ]; }
check "mutation M3 : la garde AUTO_RB du gestionnaire a bien été retirée (et seulement elle)" mutant_m3_ok
SCRIPT="$MUT_M3"
mutant_must_fail "garde AUTO_RB du gestionnaire retirée" guard_on_signal_case
SCRIPT="$SCRIPT_REAL"

if [ -n "${TEST_KEEP_DIR:-}" ]; then
    mkdir -p "$TEST_KEEP_DIR"
    for f in apply-staging apply-prod; do
        sed "s#$TMP/sb-[a-z0-9]*##g" "$TMP/$f.out" >"$TEST_KEEP_DIR/$f.txt"
    done
fi

echo
echo "== Résultat : $PASS réussis, $FAILED échoués =="
[ "$FAILED" -eq 0 ]
