#!/usr/bin/env bash
set -Eeuo pipefail

# Teste les garde-fous de `apply-redis-config` (sokar-deploy-root.sh) avec un faux docker et un faux curl.
# Usage : bash scripts/ops/test-apply-redis-config.sh

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d /tmp/sokar-redis-config-test.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

# Faux serveur : infra/.env (Postgres, sans retour à la ligne final) et fichier d'environnement de Grafana.
mkdir -p "$TMP/root/infra"
printf 'POSTGRES_PASSWORD=pg-secret' > "$TMP/root/infra/.env"
printf 'GRAFANA_ADMIN_PASSWORD=gf-secret\n' > "$TMP/grafana.env"

# Extrait la fonction ; le chemin de docker et celui du fichier Grafana sont remplacés pour le test.
awk '/^apply_redis_config\(\) \{/,/^}/' "$ROOT_DIR/scripts/ops/sokar-deploy-root.sh" \
  | sed -e 's#/usr/bin/docker#docker#g' -e "s#/etc/sokar/grafana.env#$TMP/grafana.env#g" > "$TMP/fn.sh"
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
# Chemin du fichier fusionné connu du test, pour vérifier qu'il est supprimé en sortie.
MERGED_ENV="$TMP/merged.env"
mktemp() { : > "$MERGED_ENV"; echo "$MERGED_ENV"; }
docker() {
  local all="$*" envfile="" prev=""
  echo "docker $all" >> "$CALLS"
  for arg in "$@"; do
    [ "$prev" = "--env-file" ] && envfile="$arg"
    prev="$arg"
  done
  # Comme Compose, refuser de lire le fichier si un mot de passe obligatoire manque (ou si les deux
  # fichiers ont été collés sur une seule ligne faute de retour à la ligne).
  if [ -n "$envfile" ]; then
    grep -q '^POSTGRES_PASSWORD=pg-secret$' "$envfile" || { echo "POSTGRES_PASSWORD manquant" >&2; return 1; }
    grep -q '^GRAFANA_ADMIN_PASSWORD=gf-secret$' "$envfile" || { echo "GRAFANA_ADMIN_PASSWORD manquant" >&2; return 1; }
  fi
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
# Jamais deux --env-file sur une même commande (cette version de Compose n'utilise que le dernier).
! grep -E -- '--env-file.*--env-file' "$CALLS"
# Le fichier fusionné contenait les deux mots de passe (vérifié par le faux docker) puis est supprimé en sortie.
test ! -e "$MERGED_ENV"

echo "apply-redis-config: OK"
