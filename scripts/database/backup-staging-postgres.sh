#!/usr/bin/env bash
# Sauvegarde PostgreSQL de la base staging (sokar_staging).
#
# Wrapper autour de scripts/database/backup-postgres.sh qui positionne les variables
# d'environnement par défaut pour staging.
#
# Usage:
#   /usr/local/sbin/suppernote-staging-backup-postgres
#   BACKUP_DIR=/tmp/staging-dumps bash scripts/database/backup-staging-postgres.sh

set -euo pipefail

SUPPERNOTE_ROOT="${SUPPERNOTE_ROOT:-/opt/suppernote-staging}"
POSTGRES_DB="${POSTGRES_DB:-sokar_staging}"
POSTGRES_USER="${POSTGRES_USER:-sokar}"
POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-infra-postgres-1}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/suppernote-staging}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

export POSTGRES_DB POSTGRES_USER POSTGRES_CONTAINER BACKUP_DIR RETENTION_DAYS

exec "${SUPPERNOTE_ROOT}/scripts/database/backup-postgres.sh"
