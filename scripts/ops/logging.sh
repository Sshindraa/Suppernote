#!/bin/bash
# Lightweight structured logging helpers for Suppernote deploy/ops scripts.
# Sourced by deploy.sh, deploy-common.sh, db-backup.sh, etc.
#
# Usage:
#   source "$(dirname "$0")/ops/logging.sh"
#   log info "Starting deploy"
#   log warn "Swap not configured"
#   log error "Build failed" && exit 1

log() {
  local level="${1:-info}"
  local message="${2:-}"
  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  # Ensure valid level
  case "$level" in
    debug|info|warn|error) ;;
    *)
      message="$level ${message}"
      level="info"
      ;;
  esac
  # Uppercase level, pad to 5 chars
  local level_upper
  level_upper=$(printf '%-5s' "$(echo "$level" | tr 'a-z' 'A-Z')")
  if [ "$level" = "error" ]; then
    echo "${timestamp} [${level_upper}] ${message}" >&2
  else
    echo "${timestamp} [${level_upper}] ${message}"
  fi
}

log_section() {
  local title="${1:-}"
  log info ""
  log info "=== ${title} ==="
}

log_ok() {
  log info "✅ ${1:-}"
}

log_warn() {
  log warn "⚠️  ${1:-}"
}

log_error() {
  log error "❌ ${1:-}"
}

# Envoie une notification via ALERT_WEBHOOK (Slack/Discord) et/ou ALERT_CMD.
# Usage: notify "message de notification"
#
# Variables d'env (optionnelles, no-op silencieux si vides) :
#   ALERT_WEBHOOK — URL webhook Slack-like, payload {"text": "message"}
#   ALERT_CMD     — commande appelée avec le message en $1
notify() {
  local message="${1:-}"
  if [ -z "$message" ]; then
    return 0
  fi

  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    # Échappement des guillemets et newlines pour un payload JSON valide.
    local json_message
    json_message=$(printf '%s' "$message" | sed 's/"/\\"/g' | sed ':a;N;$!ba;s/\n/\\n/g')
    curl -s -m 10 -X POST -H 'Content-type: application/json' \
      --data "{\"text\":\"${json_message}\"}" \
      "$ALERT_WEBHOOK" >/dev/null 2>&1 || true
  fi
  if [ -n "${ALERT_CMD:-}" ]; then
    $ALERT_CMD "$message" >/dev/null 2>&1 || true
  fi
}
