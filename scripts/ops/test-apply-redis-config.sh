#!/usr/bin/env bash
set -Eeuo pipefail

# Teste les garde-fous de `apply-redis-config` (sokar-deploy-root.sh) avec un faux docker et un faux curl.
# Usage : bash scripts/ops/test-apply-redis-config.sh

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sokar-redis-config-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Extrait la fonction et remplace le chemin absolu de docker par la fonction simulée.
awk '/^apply_redis_config\(\) \{/,/^}/' "$ROOT_DIR/scripts/ops/sokar-deploy-root.sh" \
  | sed 's#/usr/bin/docker#docker#g' > "$TMP/fn.sh"
test -s "$TMP/fn.sh"

CALLS="$TMP/calls.log"
ENVIRONMENT=prod
ROOT=/opt/sokar
sleep() { :; }
usage() { echo usage >&2; exit 2; }

SESSIONS="sokar_voice_active_sessions 0"
PS_ID="abc123"
VOLUME_NAME="infra_redis-data"
curl() { printf '%s\n' "$SESSIONS"; }
docker() {
  echo "docker $*" >> "$CALLS"
  case "$*" in
    *"ps -q redis"*) printf '%s\n' "$PS_ID" ;;
    *inspect*) printf '%s' "$VOLUME_NAME" ;;
    *"redis-cli ping"*) echo PONG ;;
    *"config get"*) echo 1073741824 ;;
  esac
}
# shellcheck disable=SC1091
source "$TMP/fn.sh"

run() { : > "$CALLS"; ( apply_redis_config >/dev/null 2>&1 ) && echo 0 || echo $?; }
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

# 5. Chemin heureux : écriture sur disque, puis seulement le service redis, puis vérification.
test "$(run)" = 0
grep -q "exec -T redis redis-cli save" "$CALLS"
grep -q "up -d --no-deps redis" "$CALLS"
# Les deux fichiers d'environnement sont transmis : le compose exige aussi le mot de passe de Grafana.
grep -q -- "--env-file /opt/sokar/infra/.env --env-file /etc/sokar/grafana.env" "$CALLS"
grep -q "config get maxmemory" "$CALLS"
test "$(grep -n 'redis-cli save' "$CALLS" | cut -d: -f1)" -lt "$(grep -n 'up -d' "$CALLS" | cut -d: -f1)"

echo "apply-redis-config: OK"
