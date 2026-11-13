#!/usr/bin/env zsh
# Setup Hermes Agent pour Suppernote
# Usage: zsh tools/hermes/scripts/setup.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HERMES_BIN_DIR="$HOME/.local/bin"

# Couleurs
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── 1. Vérifier PATH ─────────────────────────────────────────────────────────
log "Vérification du PATH..."
if [[ ":$PATH:" != *":$HERMES_BIN_DIR:"* ]]; then
    log "Ajout de $HERMES_BIN_DIR au PATH dans ~/.zshrc"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
    export PATH="$HERMES_BIN_DIR:$PATH"
fi

# ── 2. Vérifier Hermes ─────────────────────────────────────────────────────
log "Vérification d'Hermes Agent..."
if ! command -v hermes &> /dev/null; then
    error "Hermes non trouvé. Installe-le manuellement:"
    echo "  python3 -m venv ~/.venvs/hermes && source ~/.venvs/hermes/bin/activate"
    echo "  pip install hermes-agent"
    exit 1
fi
hermes_version=$(hermes --version 2>&1 || true)
log "Hermes installé: $hermes_version"

# ── 3. Vérifier Docker ─────────────────────────────────────────────────────
log "Vérification de Docker..."
if ! docker info &> /dev/null; then
    warn "Docker Desktop n'est pas lancé (optionnel pour Hermes CLI)"
else
    log "Docker OK"
fi

# ── 4. Vérifier variables d'environnement ────────────────────────────────────
log "Vérification des variables d'environnement..."
source "$REPO_ROOT/.env" 2>/dev/null || source "$REPO_ROOT/.env.local" 2>/dev/null || true

missing=0
if [ -z "${OPENCODE_GO_API_KEY:-}" ]; then
    error "OPENCODE_GO_API_KEY non défini."
    echo "  Ajoute-le dans $REPO_ROOT/.env ou dans votre shell."
    missing=1
fi

if [ $missing -eq 1 ]; then
    error "Corrige les variables ci-dessus puis relance ce script."
    exit 1
fi

# ── 5. Créer les liens de configuration ────────────────────────────────────────
log "Création des liens de configuration..."

if [ ! -f "$HOME/.hermes/config.yaml" ]; then
    mkdir -p "$HOME/.hermes"
    cp "$REPO_ROOT/tools/hermes/config/hermes-config.yaml" "$HOME/.hermes/config.yaml"
    log "Hermes config copiée"
else
    warn "~/.hermes/config.yaml existe déjà ; template projet non copié"
fi

log ""
log "✅ Setup terminé !"
log ""
log "Utilisation:"
log "  hermes -z \"votre tâche ici\""
log "  zsh $REPO_ROOT/tools/hermes/scripts/start-hermes.sh"
log ""
