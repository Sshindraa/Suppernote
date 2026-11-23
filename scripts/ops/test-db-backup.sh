#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/pg_dump" <<'EOF'
#!/usr/bin/env bash
printf 'fixture dump\n'
exit "${DUMP_EXIT:-0}"
EOF
chmod +x "$TMP_ROOT/bin/pg_dump"
export PATH="$TMP_ROOT/bin:$PATH" DATABASE_URL=fixture SUPPERNOTE_ROOT="$ROOT"
source "$ROOT/scripts/ops/logging.sh"
source "$ROOT/scripts/ops/db-backup.sh"

umask 002
backup_db "$TMP_ROOT/release"
test -s "$TMP_ROOT/release/db-backup.sql"
test -z "$(find "$TMP_ROOT/release/db-backup.sql" -perm -077 -print)"
export DUMP_EXIT=1
if backup_db "$TMP_ROOT/release"; then exit 1; fi
test "$(cat "$TMP_ROOT/release/db-backup.sql")" = 'fixture dump'
test -z "$(find "$TMP_ROOT/release" -name '.db-backup.*' -print)"
echo 'DB backup tests passed'
