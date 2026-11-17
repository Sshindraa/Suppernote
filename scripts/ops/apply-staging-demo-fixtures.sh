#!/usr/bin/env bash
# Applique les réglages des fiches de démo Paris sur la base de staging (idempotent).
# Usage : DATABASE_URL=… scripts/ops/apply-staging-demo-fixtures.sh
# DATABASE_URL vient de l'environnement uniquement ; refuse toute base autre que sokar_staging.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL_FILE="$ROOT/scripts/ops/staging-demo-fixtures.sql"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL absent de l'environnement." >&2
  exit 1
fi

# Nom de base = dernier segment du chemin, sans query string (?sslmode=…).
db_name="${DATABASE_URL%%\?*}"
db_name="${db_name##*/}"
if [ "$db_name" != "sokar_staging" ]; then
  echo "❌ Refus : la base visée est « $db_name », attendu exactement sokar_staging." >&2
  exit 1
fi

psql -v ON_ERROR_STOP=1 -X "$DATABASE_URL" -f "$SQL_FILE"
