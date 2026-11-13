#!/usr/bin/env zsh
# Lance Hermes Agent avec la config Suppernote
# Usage: zsh tools/hermes/scripts/start-hermes.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERMES_BIN_DIR="$HOME/.local/bin"
export PATH="$HERMES_BIN_DIR:$PATH"

# Charger les variables du projet
set -a
source "$REPO_ROOT/.env" 2>/dev/null || source "$REPO_ROOT/.env.local" 2>/dev/null || true
set +a

# Vérifications
if ! command -v hermes &> /dev/null; then
    echo "[ERROR] Hermes non trouvé. Lance d'abord: zsh $REPO_ROOT/tools/hermes/scripts/setup.sh"
    exit 1
fi

if [ -z "${OPENCODE_GO_API_KEY:-}" ]; then
    echo "[ERROR] OPENCODE_GO_API_KEY non défini."
    echo "  Ajoute-le dans $REPO_ROOT/.env ou exportez-le dans votre shell."
    exit 1
fi

echo "[SUPPERNOTE-AGENT] Démarrage d'Hermes..."
echo "  Live config: ~/.hermes/config.yaml"
echo "  Project template: $REPO_ROOT/tools/hermes/config/hermes-config.yaml"
echo ""

# Lancer Hermes (lit ~/.hermes/config.yaml)
hermes
