#!/usr/bin/env bash
# Restaure un dump Suppernote dans une base explicitement nommée.
# Refuse d'écraser la base de production `sokar`.

set -euo pipefail

BACKUP_PATH="${1:-}"
TARGET_DB="${2:-}"
CONTAINER="${POSTGRES_CONTAINER:-infra-postgres-1}"
DB_USER="${POSTGRES_USER:-sokar}"

if [ -z "${BACKUP_PATH}" ] || [ -z "${TARGET_DB}" ]; then
  echo "Usage: $0 /var/backups/sokar/sokar-YYYYMMDDTHHMMSSZ.dump base_cible" >&2
  exit 1
fi

if [ "${TARGET_DB}" = "sokar" ] && [ "${SKIP_PROD_GUARD:-0}" != "1" ]; then
  echo "❌ Restauration directe sur la production interdite par ce script." >&2
  echo "   En cas d'urgence P0 confirmée, relance avec SKIP_PROD_GUARD=1" >&2
  exit 1
fi
if [ "${TARGET_DB}" = "sokar" ] && [ "${SKIP_PROD_GUARD:-0}" = "1" ]; then
  echo "⚠️  SKIP_PROD_GUARD=1 — restauration sur la prod sokar autorisée" >&2
fi

test -s "${BACKUP_PATH}"

docker exec "${CONTAINER}" dropdb --if-exists --force -U "${DB_USER}" "${TARGET_DB}"
docker exec "${CONTAINER}" createdb -U "${DB_USER}" "${TARGET_DB}"
docker exec -i "${CONTAINER}" pg_restore \
  --exit-on-error \
  --no-owner \
  --no-acl \
  --username="${DB_USER}" \
  --dbname="${TARGET_DB}" <"${BACKUP_PATH}"

echo "✅ Dump restauré dans ${TARGET_DB}"
