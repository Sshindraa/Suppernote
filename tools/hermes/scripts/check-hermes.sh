#!/usr/bin/env zsh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERMES_BIN_DIR="$HOME/.local/bin"
export PATH="$HERMES_BIN_DIR:$PATH"

source "$REPO_ROOT/.env" 2>/dev/null || source "$REPO_ROOT/.env.local" 2>/dev/null || true

ok=0
fail=0

check() {
    local name="$1"
    local command="$2"
    if eval "$command" >/dev/null 2>&1; then
        echo "[OK] $name"
        ok=$((ok + 1))
    else
        echo "[MISSING] $name"
        fail=$((fail + 1))
    fi
}

check_env() {
    local name="$1"
    local value="${(P)name:-}"
    if [ -n "$value" ] && [[ "$value" != *"..."* ]] && [[ "$value" != *"ici"* ]]; then
        echo "[OK] $name"
        ok=$((ok + 1))
    else
        echo "[MISSING] $name"
        fail=$((fail + 1))
    fi
}

echo "=== Hermes Agent Suppernote — Healthcheck ==="
echo ""

check "hermes CLI" "command -v hermes"
check "Repo root" "test -d '$REPO_ROOT/tools/hermes'"

echo ""
echo "=== Variables ==="
check_env "DATABASE_URL"
check_env "OPENCODE_GO_API_KEY"

if [ -n "${GITHUB_TOKEN:-}" ]; then
  echo "[OK] GITHUB_TOKEN"
  ok=$((ok + 1))
else
  echo "[MISSING] GITHUB_TOKEN (optionnel, requis seulement pour MCP GitHub)"
fi

echo ""
echo "=== Résumé ==="
echo "[OK] $ok"
echo "[MISSING] $fail"

if [ "$fail" -gt 0 ]; then
    exit 1
fi
