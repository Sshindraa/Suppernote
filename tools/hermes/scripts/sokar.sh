#!/bin/zsh
# =============================================================================
# sokar.sh — Wrapper Hermes CLI pour Suppernote
#
# Concatène tous les arguments en une tâche, exécute hermes -z,
# journalise l'activité dans Context.md + Journal.md (Obsidian),
# puis affiche le résultat.
#
# Usage:
#   sokar Ajoute Zod validation aux routes API
#   sokar Crée le composant KPI latency dans le dashboard
#
# Alias recommandé dans ~/.zshrc :
#   alias sokar='zsh ~/Library/Mobile\ Documents/com~apple~CloudDocs/Desktop/Sokar/tools/hermes/scripts/sokar.sh'
# =============================================================================

set -euo pipefail

SOKAR_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
SCRIPT_DIR="${SOKAR_ROOT}/tools/hermes/scripts"
OBSIDIAN_SKILL="${SOKAR_ROOT}/tools/hermes/skills/obsidian"
OBSIDIAN_DOC="${OBSIDIAN_SKILL}/auto_doc.py"
OBSIDIAN_VAULT="${SOKAR_ROOT}/docs/obsidian"

# ── 1. Charger .env ──────────────────────────────────────────────────────────
if [[ -f "${SOKAR_ROOT}/.env" ]]; then
  set -a
  source "${SOKAR_ROOT}/.env"
  set +a
fi

# ── 2. Concaténer les arguments en une tâche ────────────────────────────────
TASK="${*}"
if [[ -z "$TASK" ]]; then
  echo "❌ Usage: sokar <description de la tâche>"
  exit 1
fi

# ── 3. Détecter le module Suppernote pour la journalisation ─────────────────
MODULE=$(python3 "${OBSIDIAN_DOC}" detect "${TASK}" 2>/dev/null || echo "general")

# ── 4. Exécuter hermes -z et capturer le résultat ────────────────────────────
echo "🚀 Suppernote — Exécution : ${TASK}"
echo "   Module détecté : ${MODULE}"
echo ""

RESULT=$(hermes -z "${TASK}" 2>&1)
EXIT_CODE=$?

# ── 5. Journalisation ────────────────────────────────────────────────────────
TIMESTAMP=$(date "+%Y-%m-%d %H:%M")
SUMMARY="\`${TASK}\` (module: ${MODULE})"

# 5a. Context.md — update_context
python3 "${OBSIDIAN_DOC}" update_context "${TASK}" 2>/dev/null || true

# 5b. Journal.md — ajouter une ligne au tableau
JOURNAL="${OBSIDIAN_VAULT}/Journal.md"
if [[ -f "$JOURNAL" ]]; then
  # Échapper les pipes dans le résumé pour ne pas casser le tableau
  SAFE_TASK=$(echo "${TASK}" | sed 's/|/\\|/g')
  python3 -c "
path = '${JOURNAL}'
safe_task = '''${SAFE_TASK}'''
status = '✅' if ${EXIT_CODE} == 0 else '❌'
line = f'| ${TIMESTAMP} | {safe_task} | {status} | ${MODULE} |\n'
with open(path, 'a') as f:
    f.write(line)
print(f'Journal.md: {status}')
" 2>/dev/null || true
fi

echo "📝 Contexte mis à jour."

# ── 6. Afficher le résultat d'Hermes ────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════"
echo "  RÉSULTAT HERMES"
echo "══════════════════════════════════════════"
echo "${RESULT}"
echo ""
echo "══════════════════════════════════════════"
echo "  FIN — code: ${EXIT_CODE}"
echo "══════════════════════════════════════════"

exit ${EXIT_CODE}
