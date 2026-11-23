#!/usr/bin/env bash
# Synchronise un groupe de réglages depuis les secrets ou variables du workflow
# vers les fichiers .env du VPS. Remplace les huit scripts sync-*.sh.
#
# Usage : scripts/ops/sync-env.sh <groupe> <staging|prod>
#
# Groupes (ancien script entre parenthèses) :
#   alerting        (sync-alerting-config)     optionnel
#   clerk           (sync-clerk-secret)        obligatoire, API + dashboard
#   demo-request    (sync-demo-request-config) optionnel
#   operator        (sync-operator-allowlist)  optionnel
#   reservation     (sync-reservation-token)   obligatoire
#   provider        (sync-staging-provider-config) optionnel, staging seulement
#   stripe-prices   (sync-stripe-prices)       obligatoire, contrôle du catalogue Stripe
#   voice-stt                                  optionnel, qualification STT et continuité voix
#   sentry-dashboard                           optionnel, DSN du projet suppernote-dashboard
#   sentry-connect                             optionnel, DSN du projet suppernote-connect
#
# Groupes sentry-* : la variable lue est SENTRY_DSN_DASHBOARD ou SENTRY_DSN_CONNECT
# (secrets GitHub). Ils sont écrits sous les noms attendus par l'application :
# SENTRY_DSN, SENTRY_ENVIRONMENT (staging|production), et pour le dashboard aussi
# NEXT_PUBLIC_SENTRY_DSN et NEXT_PUBLIC_SENTRY_ENVIRONMENT, que Next inline dans le
# bundle navigateur AU BUILD : la synchronisation doit donc précéder le build.
#
# Groupes optionnels : une variable vide est ignorée (configuration existante
# conservée). Groupes obligatoires : une variable vide ou invalide arrête le
# script. Toute valeur invalide arrête le script avant qu'un fichier change.
# Les valeurs ne sont jamais affichées. Les valeurs sont lues par ENVIRON, donc
# les antislashs sont écrits tels quels.

set -Eeuo pipefail
umask 077

GROUP="${1:-}"
DEPLOY_ENV="${2:-}"

case "$DEPLOY_ENV" in
  staging)
    API_ENV_FILE="${SOKAR_API_ENV_FILE:-/opt/sokar-staging/apps/api/.env}"
    DASHBOARD_ENV_FILE="${SOKAR_DASHBOARD_ENV_FILE:-/opt/sokar-staging/apps/dashboard/.env}"
    CONNECT_ENV_FILE="${SOKAR_CONNECT_ENV_FILE:-/opt/sokar-staging/apps/connect/.env}"
    CLERK_PREFIX='sk_test_'
    SENTRY_ENV_NAME='staging'
    ;;
  prod)
    API_ENV_FILE="${SOKAR_API_ENV_FILE:-/opt/sokar/apps/api/.env}"
    DASHBOARD_ENV_FILE="${SOKAR_DASHBOARD_ENV_FILE:-/opt/sokar/apps/dashboard/.env}"
    CONNECT_ENV_FILE="${SOKAR_CONNECT_ENV_FILE:-/opt/sokar/apps/connect/.env}"
    CLERK_PREFIX='sk_live_'
    SENTRY_ENV_NAME='production'
    ;;
  *)
    echo "Usage: $0 <groupe> staging|prod" >&2
    exit 2
    ;;
esac

# Définition de chaque groupe : mode, fichiers écrits, variables lues.
# FILES_FIRST=yes : le fichier cible est contrôlé avant le constat « rien à synchroniser ».
FILES_FIRST=no
# WRITE_KEYS : noms écrits dans les fichiers quand ils diffèrent des variables lues (KEYS).
WRITE_KEYS=""
case "$GROUP" in
  alerting)
    MODE=optional
    FILES_FIRST=yes
    FILES="api"
    KEYS="SENTRY_DSN ALERT_EMAIL_TO ALERT_WEBHOOK_URL ALERT_SMS_TO RESEND_RATE_LIMIT_REDIS_URL"
    ;;
  clerk)
    MODE=required
    FILES="api dashboard"
    KEYS="CLERK_SECRET_KEY"
    ;;
  demo-request)
    MODE=optional
    FILES="api"
    KEYS="DEMO_REQUEST_NOTIFY_TO"
    ;;
  operator)
    MODE=optional
    FILES="api"
    KEYS="SOKAR_OPERATOR_USER_IDS"
    ;;
  reservation)
    MODE=required
    FILES="api"
    KEYS="RESERVATION_SERVICE_TOKEN"
    ;;
  provider)
    MODE=optional
    FILES="api"
    KEYS="RESEND_API_KEY EMAIL_FROM EMAIL_TEST_ALLOWLIST PUBLIC_API_URL TELNYX_API_KEY TELNYX_PUBLIC_KEY TELNYX_CONNECTION_ID TELNYX_FROM_NUMBER"
    ;;
  voice-stt)
    MODE=optional
    FILES="api"
    KEYS="VOICE_STT_INK_RESTAURANT_IDS VOICE_STT_INK_REPLACE_RESTAURANT_IDS VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS"
    ;;
  stripe-prices)
    MODE=required
    FILES="api"
    KEYS="STRIPE_PRICE_ESSENTIAL_MONTHLY STRIPE_PRICE_ESSENTIAL_ANNUAL STRIPE_PRICE_PRO_MONTHLY STRIPE_PRICE_PRO_ANNUAL STRIPE_PRICE_MULTI_SITE_MONTHLY STRIPE_PRICE_MULTI_SITE_ANNUAL STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL"
    ;;
  sentry-dashboard)
    MODE=optional
    FILES="dashboard"
    KEYS="SENTRY_DSN_DASHBOARD"
    WRITE_KEYS="SENTRY_DSN NEXT_PUBLIC_SENTRY_DSN SENTRY_ENVIRONMENT NEXT_PUBLIC_SENTRY_ENVIRONMENT"
    ;;
  sentry-connect)
    MODE=optional
    FILES="connect"
    KEYS="SENTRY_DSN_CONNECT"
    WRITE_KEYS="SENTRY_DSN SENTRY_ENVIRONMENT"
    ;;
  *)
    echo "Groupe inconnu : '$GROUP'" >&2
    exit 2
    ;;
esac

# Valeur normalisée d'une variable. Seule la liste de destinataires perd ses espaces.
value_of() {
  local value="${!1:-}"
  if [[ "$1" == DEMO_REQUEST_NOTIFY_TO ]]; then
    value="${value// /}"
  fi
  printf '%s' "$value"
}

# Format attendu par variable. Une valeur hors format est refusée sans être affichée.
is_valid() {
  local key="$1"
  local value="$2"
  case "$key" in
    RESEND_RATE_LIMIT_REDIS_URL)
      SOKAR_REDIS_CANDIDATE="$value" node -e '
        try {
          const raw = process.env.SOKAR_REDIS_CANDIDATE;
          const url = new URL(raw);
          const unsafe = /\s/.test(raw) || [...raw].some(c => [34, 39, 92, 36, 96, 35].includes(c.charCodeAt(0)));
          if (unsafe || !["redis:", "rediss:"].includes(url.protocol) || !url.hostname ||
              !/^\/[0-9]+$/.test(url.pathname) || url.search || url.hash) process.exit(1);
        } catch { process.exit(1); }
      '
      ;;
    SENTRY_DSN|ALERT_WEBHOOK_URL)
      [[ "$value" =~ ^https://[^[:space:]]+$ ]] ;;
    SENTRY_DSN_DASHBOARD|SENTRY_DSN_CONNECT)
      # https://<clé publique>@<hôte d'ingestion>/<id projet>
      [[ "$value" =~ ^https://[A-Za-z0-9]+@[A-Za-z0-9.-]+/[0-9]+$ ]] ;;
    ALERT_EMAIL_TO)
      [[ "$value" =~ ^[^[:space:],@]+@[^[:space:],@]+(,[[:space:]]*[^[:space:],@]+@[^[:space:],@]+)*$ ]] ;;
    ALERT_SMS_TO)
      [[ "$value" =~ ^\+[0-9]{7,15}(,[[:space:]]*\+[0-9]{7,15})*$ ]] ;;
    DEMO_REQUEST_NOTIFY_TO)
      [[ "$value" =~ ^[^[:space:],@]+@[^[:space:],@]+(,[^[:space:],@]+@[^[:space:],@]+)*$ ]] ;;
    VOICE_STT_INK_RESTAURANT_IDS|VOICE_STT_INK_REPLACE_RESTAURANT_IDS|VOICE_CONVERSATION_CONTINUITY_RESTAURANT_IDS)
      [[ "$value" =~ ^[0-9a-f-]{36}(,[0-9a-f-]{36})*$ ]] ;;
    SOKAR_OPERATOR_USER_IDS)
      [[ "$value" =~ ^user_[A-Za-z0-9_-]+(,user_[A-Za-z0-9_-]+)*$ ]] ;;
    RESERVATION_SERVICE_TOKEN)
      [[ "$value" =~ ^[^[:space:]]{32,}$ ]] ;;
    EMAIL_FROM)
      [[ "$value" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] ;;
    EMAIL_TEST_ALLOWLIST)
      [[ "$value" =~ ^[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+(,[^[:space:]@,]+@[^[:space:]@,]+\.[^[:space:]@,]+)*$ ]] ;;
    PUBLIC_API_URL)
      [[ "$value" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]] ;;
    TELNYX_FROM_NUMBER)
      [[ "$value" =~ ^\+[1-9][0-9]{7,14}$ ]] ;;
    STRIPE_PRICE_*)
      [[ "$value" =~ ^price_[A-Za-z0-9]+$ ]] ;;
    CLERK_SECRET_KEY)
      [[ "$value" == "$CLERK_PREFIX"* ]] ;;
    *)
      [[ "$value" =~ ^[^[:space:]]{8,}$ ]] ;;
  esac
}

TMP_FILES=()
cleanup() {
  for tmp_file in "${TMP_FILES[@]:-}"; do
    rm -f "$tmp_file"
  done
}
trap cleanup EXIT

# Contrôle du catalogue Stripe : le checkout est toujours ouvert, donc sans cette étape un
# identifiant pointant vers l'ancien prix 149/249 € vendrait au mauvais montant.
check_stripe_catalog() {
  local tmp_file="$1"
  local root="${SOKAR_ROOT:-$(cd "$(dirname "$API_ENV_FILE")/../.." && pwd)}"
  local verify_script="$root/scripts/ops/verify-stripe-catalog.mjs"
  if [[ "$GROUP" != stripe-prices ]]; then
    return 0
  fi
  if [[ ! -f "$verify_script" ]] || ! command -v node >/dev/null 2>&1; then
    echo "Contrôle du catalogue indisponible : synchronisation des prix refusée." >&2
    exit 1
  fi
  if ! node --env-file="$tmp_file" "$verify_script"; then
    echo "Catalogue Stripe non conforme : corriger les prix avant de les synchroniser." >&2
    exit 1
  fi
}

# 1. Valeurs : normalisation et validation avant toute écriture.
SELECTED=""
for key in $KEYS; do
  value="$(value_of "$key")"
  if [[ -z "$value" ]]; then
    if [[ "$MODE" == required ]]; then
      echo "Valeur manquante ou invalide pour $key" >&2
      exit 1
    fi
    continue
  fi
  if ! is_valid "$key" "$value"; then
    echo "Valeur invalide pour $key" >&2
    exit 1
  fi
  export "$key=$value"
  SELECTED="$SELECTED $key"
done
SELECTED="${SELECTED# }"

# Variables lues sous un nom, écrites sous un autre (groupes sentry-*).
if [[ -n "$SELECTED" && -n "$WRITE_KEYS" ]]; then
  dsn="$(value_of "$KEYS")"
  export SENTRY_DSN="$dsn" NEXT_PUBLIC_SENTRY_DSN="$dsn"
  export SENTRY_ENVIRONMENT="$SENTRY_ENV_NAME" NEXT_PUBLIC_SENTRY_ENVIRONMENT="$SENTRY_ENV_NAME"
  SELECTED="$WRITE_KEYS"
fi

# 2. Fichiers cibles : tous doivent exister avant toute écriture.
TARGET_FILES=""
for file_role in $FILES; do
  case "$file_role" in
    api) target="$API_ENV_FILE" ;;
    dashboard) target="$DASHBOARD_ENV_FILE" ;;
    connect) target="$CONNECT_ENV_FILE" ;;
  esac
  TARGET_FILES="$TARGET_FILES $target"
done
TARGET_FILES="${TARGET_FILES# }"

check_target_files() {
  local target
  for target in $TARGET_FILES; do
    if [[ ! -f "$target" ]]; then
      echo "Fichier .env absent: $target" >&2
      exit 1
    fi
  done
}

if [[ "$FILES_FIRST" == yes ]]; then
  check_target_files
fi

if [[ -z "$SELECTED" ]]; then
  echo "Aucune valeur fournie pour $GROUP ; configuration existante conservée pour $DEPLOY_ENV"
  exit 0
fi

if [[ "$FILES_FIRST" != yes ]]; then
  check_target_files
fi

# 3. Écriture : chaque fichier est préparé dans un temporaire, puis publié.
# awk lit les valeurs par ENVIRON : aucune séquence d'échappement n'est interprétée.
for target in $TARGET_FILES; do
  tmp_file=$(mktemp "${target}.sync.XXXXXX")
  TMP_FILES+=("$tmp_file")
  chmod 0600 "$tmp_file"
  SELECTED_KEYS="$SELECTED" awk '
    BEGIN {
      n = split(ENVIRON["SELECTED_KEYS"], names, " ")
      for (i = 1; i <= n; i++) { done[names[i]] = 0 }
    }
    {
      handled = 0
      for (i = 1; i <= n; i++) {
        k = names[i]
        if (index($0, k "=") == 1) {
          print k "=" ENVIRON[k]
          done[k] = 1
          handled = 1
          break
        }
      }
      if (!handled) print
    }
    END {
      for (i = 1; i <= n; i++) {
        k = names[i]
        if (!done[k]) print k "=" ENVIRON[k]
      }
    }
  ' "$target" > "$tmp_file"
  chmod 0600 "$tmp_file"
  if [[ "$target" == "$API_ENV_FILE" ]]; then
    check_stripe_catalog "$tmp_file"
  fi
done

# 4. Publication : tous les fichiers sont prêts, on les remplace.
index=0
for target in $TARGET_FILES; do
  index=$((index + 1))
  mv -f "${TMP_FILES[$((index - 1))]}" "$target"
done
TMP_FILES=()

echo "$GROUP synchronisé pour $DEPLOY_ENV : $SELECTED"
