#!/usr/bin/env bash
# Rejeu A/B du jeu de comportements : référence et candidat tirés dans la MÊME session, requêtes alternées.
# Jamais de comparaison à un score stocké : la référence est rejouée en même temps que la modification.
#
#   1. Sur l'arbre SANS la modification :
#        cd apps/api && VBE_UNDERSTANDING=1 npx tsx scripts/voice-behavior-eval.ts build --family-draws auto > /abs/ref.json
#   2. Après la modification, même commande vers /abs/cand.json (VBE_ONLY identique si on restreint les cas).
#   3. VBE_MAX_REQUESTS=<N approuvé> scripts/ops/voice-behavior-ab.sh /abs/ref.json /abs/cand.json [hôte-ssh]
#
# Sans VBE_MAX_REQUESTS explicite, rien n'est envoyé : une requête payante se décide avec un plan chiffré.
# Variables du rejeu (fournisseur, hébergeur fixé, raisonnement coupé) : voir voice-behavior-replay.mjs.
#   VBE_JSON_OUT=fichier.json   garde aussi le rejeu brut (chemin absolu, hors du dépôt)
#   VBE_AB_JUDGE=1              rejeu du juge de fin de tour (requêtes `build --judge`) : note avec `ab --judge`.
#                               Sans lui, les réponses `{complete}` sont notées avec les contrôles du tour complet : tout sort à 0 %.
set -euo pipefail
REF="${1:?référence : requests.json du bras de référence}"
CAND="${2:?candidat : requests.json du bras candidat}"
HOST="${3:-suppernote}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -z "${VBE_MAX_REQUESTS:-}" ]; then
  echo "REFUS : VBE_MAX_REQUESTS non défini. Chiffrer le rejeu (nombre de requêtes, tokens) et le faire approuver avant d'envoyer quoi que ce soit." >&2
  exit 1
fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; ssh "$HOST" "rm -f /tmp/vbe-ref.json /tmp/vbe-cand.json /tmp/vbe-replay.mjs" 2>/dev/null || true' EXIT
scp -q "$REF" "$HOST:/tmp/vbe-ref.json"
scp -q "$CAND" "$HOST:/tmp/vbe-cand.json"
scp -q "$ROOT/apps/api/scripts/voice-behavior-replay.mjs" "$HOST:/tmp/vbe-replay.mjs"
ssh "$HOST" "VBE_ARM_B=/tmp/vbe-cand.json VBE_MAX_REQUESTS=$VBE_MAX_REQUESTS VBE_PROVIDER='${VBE_PROVIDER:-}' VBE_MODEL='${VBE_MODEL:-}' VBE_PROVIDER_ORDER='${VBE_PROVIDER_ORDER:-}' VBE_REASONING_OFF='${VBE_REASONING_OFF:-}' VBE_REASONING_NONE='${VBE_REASONING_NONE:-}' VBE_SAMPLING='${VBE_SAMPLING:-}' VBE_BASE_URL='${VBE_BASE_URL:-}' node /tmp/vbe-replay.mjs /tmp/vbe-ref.json" > "$TMP/ab.json"
[ -n "${VBE_JSON_OUT:-}" ] && cp "$TMP/ab.json" "$VBE_JSON_OUT"
cd "$ROOT/apps/api"
npx tsx scripts/voice-behavior-eval.ts ab ${VBE_AB_JUDGE:+--judge} "$TMP/ab.json"
