#!/usr/bin/env bash
# Watchdog Suppernote — exécuté toutes les 5 minutes par cron (/etc/cron.d/sokar-watchdog).
#
# Détecte ce que le monitoring in-app (worker system-health) ne peut pas voir :
#   - API, dashboard ou Suppernote Connect indisponibles
#   - Redis ou Postgres arrêtés
#   - sauvegarde quotidienne absente (> 26 h)
#   - disque ou mémoire critiques
#
# Notification : ALERT_WEBHOOK (Slack/Discord, payload {"text": "..."}) et/ou
# ALERT_CMD (commande appelée avec le message en $1 — permet de brancher
# n'importe quel canal : mail, SMS via curl Telnyx, etc.).
#
# Anti-spam : cooldown 30 min par check, état dans ${STATE_DIR}. Un message de
# rétablissement ✅ est envoyé quand un check repasse au vert.
#
# Heartbeat externe (panne totale du VPS) : si tous les checks passent et que
# HEALTHCHECKS_PING_URL est défini, l'URL est pingée. Chez un superviseur
# externe (healthchecks.io, Better Stack, Uptime Kuma…), configurer un
# heartbeat toutes les 10 min : si le VPS est totalement down, l'absence de
# ping déclenche l'alerte externe. C'est le seul mécanisme qui couvre la
# panne complète du serveur — Suppernote ne peut pas s'auto-alerter dans ce cas.
#
# Configuration : /etc/sokar/watchdog.env (sourcé si présent) :
#   ALERT_WEBHOOK="https://hooks.slack.com/..." ou webhook Discord
#   ALERT_CMD="/usr/local/bin/ma-commande-alerte"
#   HEALTHCHECKS_PING_URL="https://hc-ping.com/<uuid>"
#
# Installation : /usr/local/sbin/sokar-deploy-root install-runtime prod
#   (installe ce script dans /usr/local/sbin/sokar-watchdog et le cron
#   /etc/cron.d/sokar-watchdog).

set -uo pipefail

# Charge les helpers partagés (notify, log_*).
# En production ce script est installé standalone (/usr/local/sbin/sokar-watchdog) ;
# en dev il est lancé depuis le repo (scripts/ops/). On détecte le layout.
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
if [ -f "$SCRIPT_DIR/../ops/logging.sh" ]; then
  HELPERS_DIR="$SCRIPT_DIR/../ops"
else
  SOKAR_ROOT="${SOKAR_ROOT:-/opt/sokar}"
  HELPERS_DIR="$SOKAR_ROOT/scripts/ops"
fi
# shellcheck source=ops/logging.sh
source "$HELPERS_DIR/logging.sh"

ENV_FILE="${WATCHDOG_ENV_FILE:-/etc/sokar/watchdog.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

API_URL="${WATCHDOG_API_URL:-http://127.0.0.1:4000/health}"
DASHBOARD_URL="${WATCHDOG_DASHBOARD_URL:-http://127.0.0.1:3000}"
CONNECT_URL="${WATCHDOG_CONNECT_URL:-http://127.0.0.1:4002}"
REDIS_CONTAINER="${REDIS_CONTAINER:-infra-redis-1}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-infra-postgres-1}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/sokar}"
BACKUP_MAX_AGE_MIN="${BACKUP_MAX_AGE_MIN:-1560}" # 26 h
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-90}"
MEM_CRIT_PCT="${MEM_CRIT_PCT:-90}" # % de mémoire utilisée
STATE_DIR="${WATCHDOG_STATE_DIR:-/var/lib/sokar/watchdog}"
COOLDOWN_SECONDS="${WATCHDOG_COOLDOWN_SECONDS:-1800}"

install -d -m 0750 "$STATE_DIR" 2>/dev/null || true

ALL_OK=1

# notify() est fournie par scripts/ops/logging.sh (sourcé en haut de ce fichier).

# Émet une alerte pour un check, avec cooldown. Usage :
#   fail <check> <severity:CRITIQUE|WARNING> <message>
fail() {
  local check="$1" severity="$2" message="$3"
  ALL_OK=0
  local state_file="$STATE_DIR/$check.failed"
  local now last=0
  now=$(date +%s)
  if [ -f "$state_file" ]; then
    last=$(cat "$state_file" 2>/dev/null || echo 0)
  fi
  if [ $((now - last)) -lt "$COOLDOWN_SECONDS" ]; then
    echo "[watchdog] $check KO (cooldown actif, alerte déjà envoyée)"
    return 0
  fi
  echo "$now" >"$state_file" 2>/dev/null || true
  echo "[watchdog] $check KO — alerte envoyée"
  notify "🚨 [Suppernote $severity] $message"
}

# Marque un check comme rétabli. Usage : ok <check> <label lisible>
ok() {
  local check="$1" label="$2"
  local state_file="$STATE_DIR/$check.failed"
  if [ -f "$state_file" ]; then
    rm -f "$state_file"
    echo "[watchdog] $check rétabli — notification envoyée"
    notify "✅ [Suppernote] $label : rétabli."
  fi
}

check_http() {
  # Usage : check_http <check> <label> <url> <severity>
  local check="$1" label="$2" url="$3" severity="$4"
  if curl -fsS -m 8 -o /dev/null "$url"; then
    ok "$check" "$label"
  else
    fail "$check" "$severity" \
      "$label injoignable ($url). Vérifier : pm2 status, pm2 logs, puis scripts/deploy.sh --env prod --confirm-production rollback si nécessaire."
  fi
}

check_container() {
  # Usage : check_container <check> <label> <container> <commande...>
  local check="$1" label="$2" container="$3"
  shift 3
  if docker exec "$container" "$@" >/dev/null 2>&1; then
    ok "$check" "$label"
  else
    fail "$check" "CRITIQUE" \
      "$label arrêté ou en erreur (conteneur $container). Vérifier : docker ps, docker compose -f infra/docker-compose.yml up -d, logs du conteneur."
  fi
}

check_backup() {
  if [ ! -d "$BACKUP_DIR" ]; then
    fail "backup" "CRITIQUE" \
      "Répertoire de sauvegarde $BACKUP_DIR introuvable. Vérifier le cron sokar-postgres-backup et /usr/local/sbin/sokar-backup-postgres."
    return 0
  fi
  local recent
  recent=$(find "$BACKUP_DIR" -maxdepth 1 -name 'sokar-*.dump' -mmin "-$BACKUP_MAX_AGE_MIN" -print -quit 2>/dev/null)
  if [ -n "$recent" ]; then
    ok "backup" "Sauvegarde Postgres"
  else
    fail "backup" "CRITIQUE" \
      "Aucune sauvegarde Postgres depuis plus de $((BACKUP_MAX_AGE_MIN / 60))h dans $BACKUP_DIR. Vérifier : /var/log/sokar/postgres-backup.log, cron sokar-postgres-backup, espace disque."
  fi
}

# Le backup offsite R2 est la copie qui survit à une perte du VPS. Rien ne le
# surveillait : ce watchdog ne regardait que le dump local, donc un upload R2
# arrêté silencieusement laissait la production sans copie hors-site. On lit le
# journal (pas de réseau toutes les 5 minutes) et on exige la ligne de succès,
# car un échec précoce réécrit aussi le fichier.
check_offsite_backup() {
  local log="${OFFSITE_BACKUP_LOG:-/var/log/sokar/postgres-r2-backup.log}"
  local max_age="${OFFSITE_BACKUP_MAX_AGE_MIN:-1560}"
  if [ ! -f "$log" ]; then
    fail "offsite-backup" "CRITIQUE" \
      "Journal de backup offsite introuvable ($log). Vérifier le cron sokar-r2-backup."
    return 0
  fi
  local recent last
  recent=$(find "$log" -mmin "-$max_age" -print -quit 2>/dev/null)
  last=$(tail -n 1 "$log" 2>/dev/null)
  if [ -n "$recent" ] && [ "${last#*Backup offsite sokar terminé}" != "$last" ]; then
    ok "offsite-backup" "Backup offsite R2"
  else
    fail "offsite-backup" "CRITIQUE" \
      "Backup offsite R2 absent ou en échec depuis plus de $((max_age / 60))h. Vérifier $log et le cron sokar-r2-backup."
  fi
}

check_disk() {
  local usage
  usage=$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
  if [ -z "$usage" ]; then
    return 0
  fi
  if [ "$usage" -ge "$DISK_CRIT_PCT" ]; then
    fail "disk" "CRITIQUE" \
      "Disque / à ${usage}% (seuil ${DISK_CRIT_PCT}%). Libérer : anciennes releases /opt/sokar/releases, dumps /var/backups/sokar, logs /var/log/sokar, docker system prune."
  elif [ "$usage" -ge "$DISK_WARN_PCT" ]; then
    fail "disk" "WARNING" \
      "Disque / à ${usage}% (seuil d'attention ${DISK_WARN_PCT}%). Prévoir un nettoyage avant saturation."
  else
    ok "disk" "Disque /"
  fi
}

check_memory() {
  local total available used_pct
  total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null)
  available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo 2>/dev/null)
  if [ -z "${total:-}" ] || [ -z "${available:-}" ] || [ "$total" -eq 0 ]; then
    return 0
  fi
  used_pct=$(( (total - available) * 100 / total ))
  if [ "$used_pct" -ge "$MEM_CRIT_PCT" ]; then
    fail "memory" "CRITIQUE" \
      "Mémoire utilisée à ${used_pct}% (disponible $((available / 1024)) Mo). Vérifier : pm2 status (fuites), free -m, redémarrage ciblé pm2 restart sokar-api si nécessaire."
  else
    ok "memory" "Mémoire"
  fi
}

echo "[watchdog] $(date -u '+%Y-%m-%dT%H:%M:%SZ') début des checks"

check_http "api" "API Suppernote" "$API_URL" "CRITIQUE"
check_http "dashboard" "Dashboard Suppernote" "$DASHBOARD_URL" "CRITIQUE"
check_http "connect" "Suppernote Connect" "$CONNECT_URL" "WARNING"
check_container "redis" "Redis (BullMQ)" "$REDIS_CONTAINER" redis-cli ping
check_container "postgres" "Postgres" "$POSTGRES_CONTAINER" pg_isready -U sokar
check_backup
check_offsite_backup
check_disk
check_memory

if [ "$ALL_OK" -eq 1 ] && [ -n "${HEALTHCHECKS_PING_URL:-}" ]; then
  curl -fsS -m 10 -o /dev/null "$HEALTHCHECKS_PING_URL" 2>/dev/null || \
    echo "[watchdog] ping heartbeat externe en échec (non bloquant)"
fi

echo "[watchdog] $(date -u '+%Y-%m-%dT%H:%M:%SZ') fin des checks (ALL_OK=$ALL_OK)"
