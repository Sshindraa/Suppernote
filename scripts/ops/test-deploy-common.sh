#!/usr/bin/env bash
set -Eeuo pipefail

# Teste les opérations de release qui ne nécessitent ni VPS ni PM2 réel.
# Usage : bash scripts/ops/test-deploy-common.sh

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d /tmp/sokar-deploy-test.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SOKAR_ROOT="$TMP_ROOT"
DEPLOY_ENV="staging"
source "$ROOT/scripts/ops/logging.sh"
source "$ROOT/scripts/ops/deploy-common.sh"

mkdir -p \
  "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard" \
  "$TMP_ROOT/apps/connect/.next/standalone/apps/connect" \
  "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/apps/dashboard" \
  "$TMP_ROOT/apps/connect/.next-deploy-fixture-connect/standalone/apps/connect"

printf 'dashboard-tsconfig\n' > "$TMP_ROOT/apps/dashboard/tsconfig.json"
printf 'dashboard-next-env\n' > "$TMP_ROOT/apps/dashboard/next-env.d.ts"

printf 'old-dashboard\n' > "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js"
printf 'old-connect\n' > "$TMP_ROOT/apps/connect/.next/standalone/apps/connect/server.js"
printf 'new-dashboard\n' > "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/apps/dashboard/server.js"
printf 'new-connect\n' > "$TMP_ROOT/apps/connect/.next-deploy-fixture-connect/standalone/apps/connect/server.js"

NEXT_DIST_DIR_DASHBOARD=".next-deploy-fixture-dashboard"
NEXT_DIST_DIR_CONNECT=".next-deploy-fixture-connect"

backup_next_build_configs
printf 'generated-dashboard-tsconfig\n' > "$TMP_ROOT/apps/dashboard/tsconfig.json"
printf 'generated-dashboard-next-env\n' > "$TMP_ROOT/apps/dashboard/next-env.d.ts"
printf 'generated-connect-next-env\n' > "$TMP_ROOT/apps/connect/next-env.d.ts"
restore_next_build_configs
test "$(cat "$TMP_ROOT/apps/dashboard/tsconfig.json")" = 'dashboard-tsconfig'
test "$(cat "$TMP_ROOT/apps/dashboard/next-env.d.ts")" = 'dashboard-next-env'
test ! -e "$TMP_ROOT/apps/connect/next-env.d.ts"

activate_next_builds
test -L "$TMP_ROOT/apps/dashboard/.next"
test "$(readlink "$TMP_ROOT/apps/dashboard/.next")" = "$NEXT_DIST_DIR_DASHBOARD"
test -L "$TMP_ROOT/apps/connect/.next"
test "$(readlink "$TMP_ROOT/apps/connect/.next")" = "$NEXT_DIST_DIR_CONNECT"
test "$(cat "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js")" = 'new-dashboard'
test "$(cat "$TMP_ROOT/apps/connect/.next/standalone/apps/connect/server.js")" = 'new-connect'
test -d "$NEXT_PREVIOUS_DIR_DASHBOARD"
test -d "$NEXT_PREVIOUS_DIR_CONNECT"
mkdir -p "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/node_modules/styled-jsx-target"
printf 'styled-jsx-fixture\n' > "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/node_modules/styled-jsx-target/package.json"
ln -s styled-jsx-target "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/node_modules/styled-jsx"
snapshot_artifacts "$TMP_ROOT/release" test "apps/dashboard/.next" "apps/connect/.next"
test -d "$TMP_ROOT/release/apps/dashboard/.next/standalone/apps/dashboard"
test -d "$TMP_ROOT/release/apps/connect/.next/standalone/apps/connect"
test -L "$TMP_ROOT/release/apps/dashboard/.next/standalone/node_modules/styled-jsx"
test "$(readlink "$TMP_ROOT/release/apps/dashboard/.next/standalone/node_modules/styled-jsx")" = 'styled-jsx-target'

mkdir -p \
  "$TMP_ROOT/apps/dashboard/.next-deploy-fixture2-dashboard/standalone/apps/dashboard" \
  "$TMP_ROOT/apps/connect/.next-deploy-fixture2-connect/standalone/apps/connect"
printf 'newer-dashboard\n' > "$TMP_ROOT/apps/dashboard/.next-deploy-fixture2-dashboard/standalone/apps/dashboard/server.js"
printf 'newer-connect\n' > "$TMP_ROOT/apps/connect/.next-deploy-fixture2-connect/standalone/apps/connect/server.js"
NEXT_DIST_DIR_DASHBOARD=".next-deploy-fixture2-dashboard"
NEXT_DIST_DIR_CONNECT=".next-deploy-fixture2-connect"
activate_next_builds
test -L "$TMP_ROOT/apps/dashboard/.next"
test "$(cat "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js")" = 'newer-dashboard'
test "$(cat "$TMP_ROOT/apps/connect/.next/standalone/apps/connect/server.js")" = 'newer-connect'
test "$(cat "$NEXT_PREVIOUS_DIR_DASHBOARD/standalone/apps/dashboard/server.js")" = 'new-dashboard'
test "$(cat "$NEXT_PREVIOUS_DIR_CONNECT/standalone/apps/connect/server.js")" = 'new-connect'
# Le dossier servi par l'ancien processus PM2 doit rester à son chemin d'origine
# tant que le redémarrage + health checks n'ont pas eu lieu (incident 2026-09-27).
test "$NEXT_PREVIOUS_DIR_DASHBOARD" = "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard"
test -f "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard/standalone/apps/dashboard/server.js"
test -f "$TMP_ROOT/apps/connect/.next-deploy-fixture-connect/standalone/apps/connect/server.js"
restore_activated_next_builds
test -L "$TMP_ROOT/apps/dashboard/.next"
test "$(readlink "$TMP_ROOT/apps/dashboard/.next")" = '.next-deploy-fixture-dashboard'
test "$(cat "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js")" = 'new-dashboard'
test "$(cat "$TMP_ROOT/apps/connect/.next/standalone/apps/connect/server.js")" = 'new-connect'

# Après bascule + health checks, le nettoyage supprime l'ancienne release
# mais jamais la cible active.
activate_next_builds
cleanup_previous_next_builds
test ! -e "$TMP_ROOT/apps/dashboard/.next-deploy-fixture-dashboard"
test ! -e "$TMP_ROOT/apps/connect/.next-deploy-fixture-connect"
test "$(cat "$TMP_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js")" = 'newer-dashboard'
NEXT_PREVIOUS_DIR_DASHBOARD="$TMP_ROOT/apps/dashboard/.next-deploy-fixture2-dashboard"
cleanup_previous_next_builds
test -d "$TMP_ROOT/apps/dashboard/.next-deploy-fixture2-dashboard"

# Élagage des vieux dossiers de build : garde les 2 plus récents et la cible active de `.next`.
SOKAR_ROOT_BEFORE_PRUNE="$SOKAR_ROOT"
SOKAR_ROOT="$TMP_ROOT/prune"
for app in dashboard connect; do
  mkdir -p "$SOKAR_ROOT/apps/$app"
  for stamp in 20260101T000000Z 20260102T000000Z 20260103T000000Z 20260104T000000Z 20260105T000000Z; do
    mkdir -p "$SOKAR_ROOT/apps/$app/.next-deploy-$stamp-1-$app"
  done
  ln -s ".next-deploy-20260101T000000Z-1-$app" "$SOKAR_ROOT/apps/$app/.next"
done
prune_stale_next_builds 2
for app in dashboard connect; do
  test -d "$SOKAR_ROOT/apps/$app/.next-deploy-20260105T000000Z-1-$app"
  test -d "$SOKAR_ROOT/apps/$app/.next-deploy-20260104T000000Z-1-$app"
  test -d "$SOKAR_ROOT/apps/$app/.next-deploy-20260101T000000Z-1-$app"
  test ! -e "$SOKAR_ROOT/apps/$app/.next-deploy-20260103T000000Z-1-$app"
  test ! -e "$SOKAR_ROOT/apps/$app/.next-deploy-20260102T000000Z-1-$app"
done
SOKAR_ROOT="$SOKAR_ROOT_BEFORE_PRUNE"

# Types générés par un build précédent : supprimés avant le build suivant, sans toucher au reste du
# build servi (ici `.next` est un lien vers le dernier build activé, comme sur le VPS).
mkdir -p "$TMP_ROOT/apps/connect/.next/types/app/widget/[slug]" "$TMP_ROOT/apps/connect/.next/dev/types"
printf 'import "../../../../../src/app/widget/[slug]/page.js"\n' > "$TMP_ROOT/apps/connect/.next/types/app/widget/[slug]/page.ts"
printf 'export {}\n' > "$TMP_ROOT/apps/connect/.next/dev/types/validator.ts"
clean_stale_next_types connect
test ! -e "$TMP_ROOT/apps/connect/.next/types"
test ! -e "$TMP_ROOT/apps/connect/.next/dev/types"
test -f "$TMP_ROOT/apps/connect/.next/standalone/apps/connect/server.js"
clean_stale_next_types connect # idempotent : rien à supprimer, pas d'erreur
clean_stale_next_types dashboard

# Dépendances : le lockfile d'une release suit son commit, pas le checkout courant.
DEPS_REPO="$TMP_ROOT/deps-repo"
mkdir -p "$DEPS_REPO/apps/api/src" "$DEPS_REPO/packages/config"
printf 'lockfileVersion: v1\n' > "$DEPS_REPO/pnpm-lock.yaml"
printf 'packages:\n  - apps/*\n' > "$DEPS_REPO/pnpm-workspace.yaml"
printf '{"name":"root"}\n' > "$DEPS_REPO/package.json"
printf '{"name":"api"}\n' > "$DEPS_REPO/apps/api/package.json"
printf '{"name":"config"}\n' > "$DEPS_REPO/packages/config/package.json"
printf 'export {}\n' > "$DEPS_REPO/apps/api/src/index.ts"
git -C "$DEPS_REPO" init -q
git -C "$DEPS_REPO" add -A
git -C "$DEPS_REPO" -c user.name=test -c user.email=test@example.com commit -q -m v1
COMMIT_V1="$(git -C "$DEPS_REPO" rev-parse HEAD)"
printf 'lockfileVersion: v2\n' > "$DEPS_REPO/pnpm-lock.yaml"
git -C "$DEPS_REPO" -c user.name=test -c user.email=test@example.com commit -q -am v2
(
  SOKAR_ROOT="$DEPS_REPO"
  snapshot_dependencies "$TMP_ROOT/release-v1" "$COMMIT_V1"
)
test "$(cat "$TMP_ROOT/release-v1/deps/pnpm-lock.yaml")" = 'lockfileVersion: v1'
test -f "$TMP_ROOT/release-v1/deps/pnpm-workspace.yaml"
test -f "$TMP_ROOT/release-v1/deps/apps/api/package.json"
test -f "$TMP_ROOT/release-v1/deps/packages/config/package.json"
test ! -e "$TMP_ROOT/release-v1/deps/apps/api/src/index.ts"
mkdir -p "$TMP_ROOT/restore-root"
(
  SOKAR_ROOT="$TMP_ROOT/restore-root"
  restore_release_manifests "$TMP_ROOT/release-v1"
)
test "$(cat "$TMP_ROOT/restore-root/pnpm-lock.yaml")" = 'lockfileVersion: v1'
test -f "$TMP_ROOT/restore-root/apps/api/package.json"

# Redémarrages PM2 : une seule fois par app remplacée, l'API seulement si elle a changé.
PM2_API=sokar-api PM2_WORKERS=sokar-workers PM2_DASH=sokar-dashboard PM2_CONNECT=sokar-connect
ECOSYSTEM_FILE=eco.js PRIVILEGED_WRAPPER=/bin/true HAS_LOCALSTACK=false
PM2_CALLS="$TMP_ROOT/pm2-calls.log"
PM2_DOWN=""
pm2() {
    if [ "$1" = pid ]; then
        case " $PM2_DOWN " in *" $2 "*) echo 0 ;; *) echo 4242 ;; esac
        return 0
    fi
    echo "pm2 $*" >> "$PM2_CALLS"
}
sudo() { :; }
: > "$PM2_CALLS"
NEXT_BUILD_ACTIVATED_DASHBOARD=false NEXT_BUILD_ACTIVATED_CONNECT=false NEED_API=false restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = 'pm2 save'
: > "$PM2_CALLS"
NEXT_BUILD_ACTIVATED_DASHBOARD=true NEXT_BUILD_ACTIVATED_CONNECT=false NEED_API=false restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = "$(printf 'pm2 stop sokar-dashboard\npm2 start eco.js --only sokar-dashboard\npm2 save')"
: > "$PM2_CALLS"
NEXT_BUILD_ACTIVATED_DASHBOARD=false NEXT_BUILD_ACTIVATED_CONNECT=false NEED_API=true restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = "$(printf 'pm2 start eco.js --only sokar-api\npm2 start eco.js --only sokar-workers\npm2 save')"

# Appels vocaux en cours : le remplacement de l'API attend leur fin, puis part ; au-delà du délai, il part quand même.
VOICE_POLLS="$TMP_ROOT/voice-polls.log"
voice_metrics=""
curl() { printf '.' >> "$VOICE_POLLS"; printf '%s\n' "$voice_metrics"; }
log_warn() { echo "WARN $*" >&2; }
PORT_API=4100 VOICE_DRAIN_POLL_SECONDS=0
voice_metrics='sokar_voice_active_sessions 0'
: > "$VOICE_POLLS"; wait_for_voice_idle >/dev/null
test "$(wc -c < "$VOICE_POLLS" | tr -d ' ')" = 1
voice_metrics=''
: > "$VOICE_POLLS"; wait_for_voice_idle >/dev/null
test "$(wc -c < "$VOICE_POLLS" | tr -d ' ')" = 1
voice_metrics='sokar_voice_active_sessions 3'
: > "$VOICE_POLLS"; VOICE_DRAIN_MAX_SECONDS=0 wait_for_voice_idle >/dev/null 2>&1
test "$(wc -c < "$VOICE_POLLS" | tr -d ' ')" = 1
voice_metrics='sokar_voice_active_sessions 3'
: > "$VOICE_POLLS"; VOICE_DRAIN_MAX_SECONDS=2 VOICE_DRAIN_POLL_SECONDS=1 wait_for_voice_idle >/dev/null 2>&1
test "$(wc -c < "$VOICE_POLLS" | tr -d ' ')" = 3
unset -f curl
unset PORT_API VOICE_DRAIN_POLL_SECONDS

# Une app absente (pm2 delete, plantage) est relancée même sans changement de code.
PM2_DOWN=sokar-api
: > "$PM2_CALLS"
NEXT_BUILD_ACTIVATED_DASHBOARD=false NEXT_BUILD_ACTIVATED_CONNECT=false NEED_API=false restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = "$(printf 'pm2 start eco.js --only sokar-api\npm2 save')"
PM2_DOWN=""

# Une modification de .env impose aussi le redémarrage sans changement de code.
mkdir -p "$TMP_ROOT/apps/api"
printf 'VALUE=before\n' > "$TMP_ROOT/apps/api/.env"
SOKAR_ROOT="$TMP_ROOT"
SOKAR_API_ENV_BEFORE="$(api_env_fingerprint "$SOKAR_ROOT/apps/api/.env")"
NEXT_BUILD_ACTIVATED_DASHBOARD=false NEXT_BUILD_ACTIVATED_CONNECT=false
: > "$PM2_CALLS"
NEED_API=false restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = 'pm2 save'
printf 'VALUE=after\n' > "$TMP_ROOT/apps/api/.env"
: > "$PM2_CALLS"
NEED_API=false restart_services >/dev/null
test "$(cat "$PM2_CALLS")" = "$(printf 'pm2 start eco.js --only sokar-api\npm2 start eco.js --only sokar-workers\npm2 save')"

# Une dépendance modifiée reconstruit Dashboard et Connect ; un script seul, non.
DETECT_REPO="$TMP_ROOT/detect-repo"
mkdir -p "$DETECT_REPO/scripts"
git -C "$DETECT_REPO" init -q
printf 'a\n' > "$DETECT_REPO/pnpm-lock.yaml"
printf 'a\n' > "$DETECT_REPO/scripts/x.sh"
git -C "$DETECT_REPO" add -A
git -C "$DETECT_REPO" -c user.name=t -c user.email=t@t commit -qm base
DETECT_BASE="$(git -C "$DETECT_REPO" rev-parse HEAD)"
printf 'b\n' > "$DETECT_REPO/scripts/x.sh"
git -C "$DETECT_REPO" -c user.name=t -c user.email=t@t commit -qam script
DETECT_SCRIPT="$(git -C "$DETECT_REPO" rev-parse HEAD)"
printf 'b\n' > "$DETECT_REPO/pnpm-lock.yaml"
git -C "$DETECT_REPO" -c user.name=t -c user.email=t@t commit -qam lock
DETECT_LOCK="$(git -C "$DETECT_REPO" rev-parse HEAD)"
SOKAR_ROOT="$TMP_ROOT/detect-root"
mkdir -p "$SOKAR_ROOT/apps/dashboard/.next/standalone/apps/dashboard" \
  "$SOKAR_ROOT/apps/connect/.next/standalone/apps/connect" "$SOKAR_ROOT/apps/api/dist"
touch "$SOKAR_ROOT/apps/dashboard/.next/standalone/apps/dashboard/server.js" \
  "$SOKAR_ROOT/apps/connect/.next/standalone/apps/connect/server.js" \
  "$SOKAR_ROOT/apps/api/dist/main.js"
cd "$DETECT_REPO"
detect_changed_apps "$DETECT_BASE" "$DETECT_SCRIPT" >/dev/null
test "$NEED_DASHBOARD" = false
test "$NEED_CONNECT" = false
detect_changed_apps "$DETECT_SCRIPT" "$DETECT_LOCK" >/dev/null
test "$NEED_DASHBOARD" = true
test "$NEED_CONNECT" = true
cd - >/dev/null

echo 'deploy-common release activation/rollback: OK'
