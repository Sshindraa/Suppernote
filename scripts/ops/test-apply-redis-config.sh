#!/usr/bin/env bash
set -Eeuo pipefail

# Teste les garde-fous de `apply-redis-config` (sokar-deploy-root.sh) avec un faux docker et un faux curl.
# Usage : bash scripts/ops/test-apply-redis-config.sh

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/suppernote-redis-config-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/root/infra"

# Extrait la fonction ; le chemin de docker est remplacé par la fonction simulée.
awk '/^apply_redis_config\(\) \{/,/^}/' "$ROOT_DIR/scripts/ops/sokar-deploy-root.sh" \
  | sed -e 's#/usr/bin/docker#docker#g' > "$TMP/fn.sh"
test -s "$TMP/fn.sh"

CALLS="$TMP/calls.log"
ENVIRONMENT=prod
ROOT="$TMP/root"
sleep() { :; }
usage() { echo usage >&2; exit 2; }

SESSIONS="sokar_voice_active_sessions 0"
PS_ID="abc123"
VOLUME_NAME="infra_redis-data"
curl() { printf '%s\n' "$SESSIONS"; }
docker() {
  local all="$*"
  echo "docker $all" >> "$CALLS"
  # Comme Compose, refuser de lire le fichier si un mot de passe obligatoire manque.
  [ -n "${POSTGRES_PASSWORD:-}" ] || { echo "POSTGRES_PASSWORD manquant" >&2; return 1; }
  [ -n "${GRAFANA_ADMIN_PASSWORD:-}" ] || { echo "GRAFANA_ADMIN_PASSWORD manquant" >&2; return 1; }
  case "$all" in
    *"ps -q redis"*) printf '%s\n' "$PS_ID" ;;
    *inspect*) printf '%s' "$VOLUME_NAME" ;;
    *"redis-cli ping"*) echo PONG ;;
    *"config get"*) echo 1073741824 ;;
  esac
}
# shellcheck disable=SC1091
source "$TMP/fn.sh"

# Chaque cas tourne dans un sous-shell : la fonction se termine par `exit` en cas d'abandon.
run() { : > "$CALLS"; ( apply_redis_config "${1:-apply}" >/dev/null 2>&1 ) && echo 0 || echo $?; }
not_touched() { ! grep -q "up -d" "$CALLS"; }

# 1. Appels en cours : abandon, Redis intact.
SESSIONS="sokar_voice_active_sessions 3"
test "$(run)" = 1; not_touched

# 2. Mesure indisponible : abandon.
SESSIONS=""
test "$(run)" = 1; not_touched
SESSIONS="sokar_voice_active_sessions 0"

# 3. Conteneur non géré par le compose : abandon.
PS_ID=""
test "$(run)" = 1; not_touched
PS_ID="abc123"

# 4. Données sans volume nommé : abandon.
VOLUME_NAME=""
test "$(run)" = 1; not_touched
VOLUME_NAME="infra_redis-data"

# 5. Mode check : tous les contrôles passent, rien n'est modifié.
test "$(run check)" = 0
grep -q "config --quiet" "$CALLS"
not_touched
! grep -q "redis-cli save" "$CALLS"

# 6. Mode inconnu : refusé.
test "$(run nimporte)" = 2

# 7. Chemin heureux : écriture sur disque, puis seulement le service redis, puis vérification.
test "$(run)" = 0
grep -q "exec -T redis redis-cli save" "$CALLS"
grep -q "up -d --no-deps redis" "$CALLS"
grep -q "config get maxmemory" "$CALLS"
test "$(grep -n 'redis-cli save' "$CALLS" | cut -d: -f1)" -lt "$(grep -n 'up -d' "$CALLS" | cut -d: -f1)"
# Aucun fichier d'environnement lu : l'application n'a pas le même (infra/.env), et aucun secret n'est touché.
! grep -E -- '--env-file ' "$CALLS" | grep -v -- '--env-file /dev/null'
grep -q -- '--env-file /dev/null' "$CALLS"

echo "apply-redis-config: OK"
