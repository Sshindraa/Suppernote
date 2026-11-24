#!/usr/bin/env bash
# Helper partagé pour la vérification d'espace disque avant sauvegarde.
# Sourcé par scripts/database/backup-postgres.sh et backup-postgres-r2.sh.
#
# Usage:
#   source "$SCRIPT_DIR/ops/disk.sh"
#   check_disk_space "$BACKUP_DIR" "$REQUIRED_BYTES"

set -euo pipefail

# S'assure que les helpers de logging (log_error) sont disponibles.
if ! command -v log_error >/dev/null 2>&1; then
  # shellcheck source=ops/logging.sh
  source "${SUPPERNOTE_ROOT}/scripts/ops/logging.sh"
fi

# Vérifie l'espace disque disponible sur la partition de <target_dir>.
# Usage: check_disk_space <target_dir> <required_bytes>
# Exit 1 si l'espace disponible est inférieur à required_bytes.
check_disk_space() {
  local target_dir="$1"
  local required_bytes="$2"
  local available
  available=$(df -B1 --output=avail "$target_dir" | tail -1)
  if [ "$available" -lt "$required_bytes" ]; then
    log_error "Disk space check failed: $target_dir has $available bytes, required $required_bytes"
    exit 1
  fi
}
