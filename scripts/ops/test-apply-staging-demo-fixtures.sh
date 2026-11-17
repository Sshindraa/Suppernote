#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER="$ROOT/scripts/ops/apply-staging-demo-fixtures.sh"
SQL="$ROOT/scripts/ops/staging-demo-fixtures.sql"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/bin"
cat > "$TMP_ROOT/bin/psql" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$PSQL_LOG"
EOF
chmod +x "$TMP_ROOT/bin/psql"
export PATH="$TMP_ROOT/bin:$PATH" PSQL_LOG="$TMP_ROOT/psql.log"

# Le SQL ne doit contenir aucune suppression (commentaires exclus).
if grep -v '^[[:space:]]*--' "$SQL" | grep -qiE '\b(drop|truncate|delete)\b'; then
  echo 'FAIL: DROP/TRUNCATE/DELETE dans staging-demo-fixtures.sql' >&2
  exit 1
fi

refused() {
  rm -f "$PSQL_LOG"
  if DATABASE_URL="$1" bash "$WRAPPER" >/dev/null 2>&1; then
    echo "FAIL: base acceptée à tort" >&2
    exit 1
  fi
  test ! -e "$PSQL_LOG"
}

accepted() {
  rm -f "$PSQL_LOG"
  DATABASE_URL="$1" bash "$WRAPPER" >/dev/null 2>&1
  grep -q -- '-v ON_ERROR_STOP=1' "$PSQL_LOG"
  grep -q -- "$SQL" "$PSQL_LOG"
}

unset DATABASE_URL
if bash "$WRAPPER" >/dev/null 2>&1; then echo 'FAIL: DATABASE_URL absent accepté' >&2; exit 1; fi
refused 'postgresql://u:p@localhost:5432/sokar'
refused 'postgresql://u:p@localhost:5432/sokar_staging_copy'
refused 'postgresql://u:p@localhost:5432/other?dbname=sokar_staging'
refused 'postgresql://u:p@localhost:5432/'
accepted 'postgresql://u:p@localhost:5432/sokar_staging'
accepted 'postgresql://u:p@localhost:5432/sokar_staging?sslmode=require'
echo 'Staging demo fixtures tests passed'
