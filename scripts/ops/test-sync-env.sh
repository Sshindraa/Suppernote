#!/usr/bin/env bash
# Teste le comportement de scripts/ops/sync-env.sh sans VPS.
# Usage : bash scripts/ops/test-sync-env.sh
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUNNER="$ROOT/scripts/ops/sync-env.sh"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/suppernote-sync-env-test.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

BASE='# commentaire
UNRELATED=valeur $HOME "guillemets"
PORT=4000'

failures=0
check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "  ok    $label"
  else
    echo "  FAIL  $label (attendu: $expected, obtenu: $actual)" >&2
    failures=$((failures + 1))
  fi
}

# Lance le runner dans un environnement vide. Les variables passées en arguments
# après `env -i` sont les seules visibles du script.
# Arguments : dossier de la fixture, groupe, environnement, puis VAR=VAL...
run() {
  local dir="$1" group="$2" environment="$3"
  shift 3
  local code=0
  env -i PATH="$PATH" HOME="$HOME" \
    SOKAR_API_ENV_FILE="$dir/api.env" \
    SOKAR_DASHBOARD_ENV_FILE="$dir/dashboard.env" \
    SOKAR_CONNECT_ENV_FILE="$dir/connect.env" \
    SUPPERNOTE_ROOT="$dir" \
    "$@" bash "$RUNNER" "$group" "$environment" >/dev/null 2>&1 || code=$?
  echo "$code"
}

fixture() {
  local dir
  dir="$(mktemp -d "$TMP_ROOT/case.XXXXXX")"
  printf '%s\n' "$BASE" > "$dir/api.env"
  printf '%s\n' "$BASE" > "$dir/dashboard.env"
  printf '%s\n' "$BASE" > "$dir/connect.env"
  echo "$dir"
}

echo "Groupe optionnel sans valeur : succès, fichier inchangé"
d="$(fixture)"; before="$(cat "$d/api.env")"
check "exit 0" 0 "$(run "$d" operator staging)"
check "contenu inchangé" "$before" "$(cat "$d/api.env")"

echo "Groupe obligatoire sans valeur : échec, fichier inchangé"
d="$(fixture)"; before="$(cat "$d/api.env")"
check "exit 1" 1 "$(run "$d" reservation staging)"
check "contenu inchangé" "$before" "$(cat "$d/api.env")"

echo "Valeur invalide : échec et aucun fichier modifié (même sur un autre groupe)"
d="$(fixture)"; before="$(cat "$d/api.env")"
check "exit 1" 1 "$(run "$d" operator staging SOKAR_OPERATOR_USER_IDS=oui)"
check "contenu inchangé" "$before" "$(cat "$d/api.env")"

echo "voice-stt : liste d'UUID acceptée, autre format refusé"
d="$(fixture)"
uuid=710309f4-d699-472d-a1db-f22d527fc4d0
check "exit 0" 0 "$(run "$d" voice-stt prod VOICE_STT_INK_RESTAURANT_IDS=$uuid VOICE_STT_INK_REPLACE_RESTAURANT_IDS=$uuid)"
check "valeur écrite" "VOICE_STT_INK_REPLACE_RESTAURANT_IDS=$uuid" "$(grep '^VOICE_STT_INK_REPLACE' "$d/api.env")"
check "exit 1" 1 "$(run "$d" voice-stt prod VOICE_STT_INK_RESTAURANT_IDS='*')"
check "continuité : UUID accepté" 0 "$(run "$d" voice-stt prod VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS=$uuid)"
check "continuité : valeur écrite" "VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS=$uuid" "$(grep '^VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS=' "$d/api.env")"
check "continuité : joker refusé" 1 "$(run "$d" voice-stt prod VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS='*')"

echo "Valeur valide : remplacement de la ligne existante ou ajout en fin de fichier"
d="$(fixture)"
printf 'SOKAR_OPERATOR_USER_IDS=user_ancien\n' >> "$d/api.env"
check "exit 0" 0 "$(run "$d" operator staging SOKAR_OPERATOR_USER_IDS=user_nouveau)"
check "ligne remplacée une seule fois" "1" "$(grep -c '^SOKAR_OPERATOR_USER_IDS=' "$d/api.env")"
check "valeur écrite" "SOKAR_OPERATOR_USER_IDS=user_nouveau" "$(grep '^SOKAR_OPERATOR_USER_IDS=' "$d/api.env")"
check "lignes non concernées conservées" "$BASE" "$(grep -v '^SOKAR_OPERATOR_USER_IDS=' "$d/api.env")"
mode_of() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
check "mode 600" "600" "$(mode_of "$d/api.env")"

echo "Antislashs : la valeur est écrite telle quelle"
d="$(fixture)"
check "exit 0" 0 "$(run "$d" alerting staging 'SENTRY_DSN=https://ex.test/a\b')"
check "antislash conservé" 'SENTRY_DSN=https://ex.test/a\b' "$(grep '^SENTRY_DSN=' "$d/api.env")"

echo "Clerk : la même clé est écrite dans l'API et le dashboard"
d="$(fixture)"
check "exit 0" 0 "$(run "$d" clerk prod CLERK_SECRET_KEY=sk_live_FIXTURE)"
check "API" "CLERK_SECRET_KEY=sk_live_FIXTURE" "$(grep '^CLERK_SECRET_KEY=' "$d/api.env")"
check "dashboard" "CLERK_SECRET_KEY=sk_live_FIXTURE" "$(grep '^CLERK_SECRET_KEY=' "$d/dashboard.env")"

echo "Clerk : préfixe incompatible avec l'environnement, rien n'est écrit"
d="$(fixture)"; before="$(cat "$d/dashboard.env")"
check "exit 1" 1 "$(run "$d" clerk prod CLERK_SECRET_KEY=sk_test_FIXTURE)"
check "dashboard inchangé" "$before" "$(cat "$d/dashboard.env")"

echo "Stripe : prix synchronisés sans contrôle du catalogue disponible, refus et fichier inchangé"
d="$(fixture)"; before="$(cat "$d/api.env")"
prices=(STRIPE_PRICE_ESSENTIAL_MONTHLY=price_a1 STRIPE_PRICE_ESSENTIAL_ANNUAL=price_a2
  STRIPE_PRICE_PRO_MONTHLY=price_a3 STRIPE_PRICE_PRO_ANNUAL=price_a4
  STRIPE_PRICE_MULTI_SITE_MONTHLY=price_a5 STRIPE_PRICE_MULTI_SITE_ANNUAL=price_a6
  STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY=price_a7 STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL=price_a8)
check "exit 1" 1 "$(run "$d" stripe-prices prod "${prices[@]}")"
check "contenu inchangé" "$before" "$(cat "$d/api.env")"

echo "Sentry dashboard : DSN écrit côté serveur et navigateur, environnement staging, API et connect intacts"
d="$(fixture)"
api_before="$(cat "$d/api.env")"; connect_before="$(cat "$d/connect.env")"
dash_dsn='https://cledash123@o1.ingest.de.sentry.io/11'
check "exit 0" 0 "$(run "$d" sentry-dashboard staging SENTRY_DSN_DASHBOARD=$dash_dsn SENTRY_DSN=https://autre@o1.ingest.de.sentry.io/99)"
check "SENTRY_DSN" "SENTRY_DSN=$dash_dsn" "$(grep '^SENTRY_DSN=' "$d/dashboard.env")"
check "NEXT_PUBLIC_SENTRY_DSN" "NEXT_PUBLIC_SENTRY_DSN=$dash_dsn" "$(grep '^NEXT_PUBLIC_SENTRY_DSN=' "$d/dashboard.env")"
check "SENTRY_ENVIRONMENT" "SENTRY_ENVIRONMENT=staging" "$(grep '^SENTRY_ENVIRONMENT=' "$d/dashboard.env")"
check "NEXT_PUBLIC_SENTRY_ENVIRONMENT" "NEXT_PUBLIC_SENTRY_ENVIRONMENT=staging" "$(grep '^NEXT_PUBLIC_SENTRY_ENVIRONMENT=' "$d/dashboard.env")"
check "API inchangée" "$api_before" "$(cat "$d/api.env")"
check "connect inchangé" "$connect_before" "$(cat "$d/connect.env")"
check "lignes non concernées conservées" "$BASE" "$(grep -vE '^(NEXT_PUBLIC_)?SENTRY_' "$d/dashboard.env")"
run "$d" sentry-dashboard staging SENTRY_DSN_DASHBOARD=$dash_dsn >/dev/null
check "ré-exécution : une seule ligne par clé" "4" "$(grep -cE '^(NEXT_PUBLIC_)?SENTRY_' "$d/dashboard.env")"

echo "Sentry connect : DSN serveur seul, environnement production, aucune variable NEXT_PUBLIC_"
d="$(fixture)"
api_before="$(cat "$d/api.env")"; dash_before="$(cat "$d/dashboard.env")"
connect_dsn='https://cleconn456@o1.ingest.de.sentry.io/22'
check "exit 0" 0 "$(run "$d" sentry-connect prod SENTRY_DSN_CONNECT=$connect_dsn)"
check "SENTRY_DSN" "SENTRY_DSN=$connect_dsn" "$(grep '^SENTRY_DSN=' "$d/connect.env")"
check "SENTRY_ENVIRONMENT" "SENTRY_ENVIRONMENT=production" "$(grep '^SENTRY_ENVIRONMENT=' "$d/connect.env")"
check "aucun NEXT_PUBLIC_SENTRY" "0" "$(grep -c '^NEXT_PUBLIC_SENTRY' "$d/connect.env" || true)"
check "API inchangée" "$api_before" "$(cat "$d/api.env")"
check "dashboard inchangé" "$dash_before" "$(cat "$d/dashboard.env")"

echo "Sentry : sans DSN, fichier inchangé ; DSN hors format ou fichier absent, refus"
d="$(fixture)"; before="$(cat "$d/dashboard.env")"
check "sans valeur : exit 0" 0 "$(run "$d" sentry-dashboard staging)"
check "sans valeur : inchangé" "$before" "$(cat "$d/dashboard.env")"
check "http refusé" 1 "$(run "$d" sentry-dashboard staging SENTRY_DSN_DASHBOARD=http://cle@o1.ingest.de.sentry.io/1)"
check "sans identifiant de projet refusé" 1 "$(run "$d" sentry-dashboard staging SENTRY_DSN_DASHBOARD=https://cle@o1.ingest.de.sentry.io)"
check "inchangé après refus" "$before" "$(cat "$d/dashboard.env")"
rm "$d/connect.env"
check "fichier .env connect absent : exit 1" 1 "$(run "$d" sentry-connect staging SENTRY_DSN_CONNECT=$connect_dsn)"

echo "Arguments invalides"
d="$(fixture)"
check "groupe inconnu : exit 2" 2 "$(run "$d" inconnu staging)"
check "environnement inconnu : exit 2" 2 "$(run "$d" operator demo)"

echo ""
if [[ "$failures" -gt 0 ]]; then
  echo "sync-env : $failures échec(s)" >&2
  exit 1
fi
echo "sync-env : OK"
