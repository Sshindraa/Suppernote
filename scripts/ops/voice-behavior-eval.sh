#!/usr/bin/env bash
# Jeu de test de comportements du tour structuré : prompt courant → modèle de production → seuils.
# Compose les requêtes ici, les rejoue sur le VPS (la clé y reste), note ici. ~2 minutes, quelques centimes.
#   scripts/ops/voice-behavior-eval.sh [hôte-ssh]      (défaut : suppernote)
#   VBE_SUITE=default|perturb|all   suite rejouée (défaut : default ; perturb = variantes dégradées générées, informatives)
#   VBE_JSON_OUT=fichier.json       écrit aussi les résultats et indicateurs (chemin absolu, hors du dépôt). Pour juger une modification : rejeu A/B, voir voice-behavior-ab.sh
# Une seule clé Cerebras (CEREBRAS_API_KEY) : le rejeu consomme le crédit des appels réels. Seul garde-fou :
# plafond de 150 requêtes (VBE_MAX_REQUESTS), ~3,4 k tokens chacune ; vérifier le solde avant de lancer.
set -euo pipefail
HOST="${1:-suppernote}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; ssh "$HOST" "rm -f /tmp/vbe-requests.json /tmp/vbe-replay.mjs" 2>/dev/null || true' EXIT
cd "$ROOT/apps/api"
SUITE="${VBE_SUITE:-default}"
npx tsx scripts/voice-behavior-eval.ts build --suite "$SUITE" > "$TMP/requests.json"
scp -q "$TMP/requests.json" "$ROOT/apps/api/scripts/voice-behavior-replay.mjs" "$HOST:/tmp/" 
ssh "$HOST" "mv /tmp/voice-behavior-replay.mjs /tmp/vbe-replay.mjs && mv /tmp/requests.json /tmp/vbe-requests.json && VBE_MAX_REQUESTS=${VBE_MAX_REQUESTS:-} node /tmp/vbe-replay.mjs /tmp/vbe-requests.json" > "$TMP/responses.json"
if [ -n "${VBE_JSON_OUT:-}" ]; then
  npx tsx scripts/voice-behavior-eval.ts score --suite "$SUITE" --json "$TMP/responses.json" > "$VBE_JSON_OUT" || true
fi
npx tsx scripts/voice-behavior-eval.ts score --suite "$SUITE" "$TMP/responses.json"
