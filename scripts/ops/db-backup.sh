#!/bin/bash
# Helper partagé pour backup/restore Postgres et notifications lors des déploiements Suppernote.
# Sourcé par scripts/deploy.sh (via scripts/ops/deploy-common.sh).
#
# Variables attendues en entrée :
#   - SOKAR_ROOT : racine de l'application
#   - DATABASE_URL : (optionnel) si absente, lit apps/api/.env
#   - ALERT_CMD (optionnel) : commande appelée avec le message de notification
#   - ALERT_WEBHOOK (optionnel) : URL webhook Slack-like appelée avec {"text":"message"}

set -Eeuo pipefail

# S'assure que les helpers partagés (notify, log_*) sont disponibles.
# db-backup.sh est normalement sourcé par deploy.sh après logging.sh, mais on
# garde une garde défensive pour les usages standalone.
if ! command -v notify >/dev/null 2>&1; then
  # shellcheck source=ops/logging.sh
  source "${SOKAR_ROOT}/scripts/ops/logging.sh"
fi

# Charge DATABASE_URL depuis apps/api/.env si elle n'est pas déjà exportée.
__load_db_env() {
  if [ -n "${DATABASE_URL:-}" ]; then
    return 0
  fi
  local env_file="${SOKAR_ROOT}/apps/api/.env"
  if [ ! -f "$env_file" ]; then
    echo "   ⚠️ apps/api/.env introuvable, impossible de charger DATABASE_URL" >&2
    return 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "$env_file"
  set +a
}

# Backup la base de données dans <target_dir>/db-backup.sql
backup_db() {
  local target_dir="${1:-}"
  if [ -z "$target_dir" ]; then
    echo "   ❌ backup_db: target_dir manquant" >&2
    return 1
  fi

  if ! __load_db_env; then
    return 1
  fi

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "   ⚠️ DATABASE_URL non défini, backup DB ignoré" >&2
    return 1
  fi

  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "   ⚠️ pg_dump non disponible, backup DB ignoré" >&2
    return 1
  fi

  local backup_file="$target_dir/db-backup.sql"
  install -d -m 0755 "$target_dir"
  local backup_tmp
  backup_tmp=$(mktemp "$target_dir/.db-backup.XXXXXX")
  echo "   → Backup DB vers $backup_file"

  if pg_dump --clean --if-exists --no-owner --no-privileges "$DATABASE_URL" > "$backup_tmp"; then
    mv -f "$backup_tmp" "$backup_file"
    local size
    size=$(wc -c < "$backup_file" | tr -d ' ')
    echo "   ✅ DB backup OK (${size} bytes)"
  else
    rm -f "$backup_tmp"
    echo "   ❌ pg_dump a échoué" >&2
    return 1
  fi
}

# Restore la base de données depuis <source_dir>/db-backup.sql
restore_db() {
  local source_dir="${1:-}"
  if [ -z "$source_dir" ]; then
    echo "   ❌ restore_db: source_dir manquant" >&2
    return 1
  fi

  local backup_file="$source_dir/db-backup.sql"
  if [ ! -f "$backup_file" ]; then
    echo "   ❌ DB backup introuvable: $backup_file" >&2
    return 1
  fi

  if ! __load_db_env; then
    return 1
  fi

  if [ -z "${DATABASE_URL:-}" ]; then
    echo "   ❌ DATABASE_URL non défini, restore DB impossible" >&2
    return 1
  fi

  if ! command -v psql >/dev/null 2>&1; then
    echo "   ❌ psql non disponible, restore DB impossible" >&2
    return 1
  fi

  echo "   → Restore DB depuis $backup_file"
  if psql --set ON_ERROR_STOP=1 "$DATABASE_URL" -f "$backup_file"; then
    echo "   ✅ DB restore OK"
  else
    echo "   ❌ psql restore a échoué" >&2
    return 1
  fi
}

# notify() est fournie par scripts/ops/logging.sh (sourcé en haut de ce fichier
# ou par le script appelant, ex. deploy.sh).
