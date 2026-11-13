#!/bin/zsh
# Suppernote Auto-Commit System
# Commits automatiquement avec des messages intelligents basés sur les fichiers modifiés
# Usage: ./auto-commit.sh [message_custom] [--push]

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" && [ -n "$REPO_ROOT" ] || REPO_ROOT="/Users/hamza/Projects/Sokar"
cd "$REPO_ROOT"

# ── Couleurs ──
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# ── Check git status ──
if git diff --cached --quiet && git diff --quiet; then
  echo "${YELLOW}Nothing to commit, working tree clean.${NC}"
  exit 0
fi

# ── Generate smart commit message ──
generate_message() {
  local msg=""
  local files=$(git diff --cached --name-only 2>/dev/null || git status --short | awk '{print $2}')
  
  # Detect module/type from changed files
  local has_api=$(echo "$files" | grep -c "apps/api" || true)
  local has_dashboard=$(echo "$files" | grep -c "apps/dashboard" || true)
  local has_db=$(echo "$files" | grep -c "packages/database" || true)
  local has_agent=$(echo "$files" | grep -c -E "agent/|tools/hermes/" || true)
  local has_docs=$(echo "$files" | grep -c "docs/" || true)
  local has_infra=$(echo "$files" | grep -c "infra/" || true)
  local has_config=$(echo "$files" | grep -c -E "(package\.json|tsconfig|turbo|pnpm)" || true)
  
  # Determine scope
  local scope=""
  if [[ $has_api -gt 0 ]]; then scope="api"; fi
  if [[ $has_dashboard -gt 0 ]]; then scope="dashboard"; fi
  if [[ $has_db -gt 0 ]]; then scope="database"; fi
  if [[ $has_agent -gt 0 ]]; then scope="hermes"; fi
  if [[ $has_docs -gt 0 ]]; then scope="docs"; fi
  if [[ $has_infra -gt 0 ]]; then scope="infra"; fi
  if [[ $has_config -gt 0 && -z "$scope" ]]; then scope="config"; fi
  
  # Determine type from file patterns
  local type="feat"
  if echo "$files" | grep -q "test"; then type="test"; fi
  if echo "$files" | grep -q "fix\|bug\|hotfix"; then type="fix"; fi
  if echo "$files" | grep -q "refactor"; then type="refactor"; fi
  if [[ $has_config -gt 0 && $has_api -eq 0 && $has_dashboard -eq 0 && $has_db -eq 0 ]]; then type="chore"; fi
  if [[ $has_docs -gt 0 && $has_api -eq 0 && $has_dashboard -eq 0 ]]; then type="docs"; fi
  
  # Count files
  local count=$(echo "$files" | wc -l | tr -d ' ')
  
  # Build message
  if [[ -n "$scope" ]]; then
    msg="${type}(${scope}): update ${count} file(s)"
  else
    msg="${type}: update ${count} file(s)"
  fi
  
  # Add file summary
  local summary=$(echo "$files" | head -5 | sed 's|^|  - |')
  if [[ $count -gt 5 ]]; then
    summary="${summary}\n  - ... and $((count - 5)) more"
  fi
  
  echo "$msg"
  echo ""
  echo "Files changed:"
  echo "$summary"
}

# ── Main ──
echo "${GREEN}Suppernote Auto-Commit${NC}"
echo "=================="

# Stage all changes
git add -A

# Custom message or auto-generated
if [[ -n "${1:-}" && "${1:-}" != "--push" ]]; then
  COMMIT_MSG="$1"
  shift
else
  COMMIT_MSG=$(generate_message | head -1)
  echo ""
  echo "${YELLOW}Auto-generated message:${NC} $COMMIT_MSG"
  echo ""
fi

# Commit
git commit -m "$COMMIT_MSG" || {
  echo "${RED}Commit failed.${NC}"
  exit 1
}

# Push if requested
if [[ "${1:-}" == "--push" || "${2:-}" == "--push" ]]; then
  echo ""
  echo "${GREEN}Pushing to GitHub...${NC}"
  git push origin main || {
    echo "${YELLOW}Push failed. Trying to pull first...${NC}"
    git pull origin main --rebase || true
    git push origin main || echo "${RED}Push still failed. Resolve manually.${NC}"
  }
fi

echo ""
echo "${GREEN}Done!${NC} Commit: $(git log -1 --oneline)"
