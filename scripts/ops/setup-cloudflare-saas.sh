#!/usr/bin/env bash
# Configuration idempotente de Cloudflare for SaaS sur le VPS Suppernote (hôte sokar).
#
# Ajoute CLOUDFLARE_API_TOKEN, CLOUDFLARE_ZONE_ID, CLOUDFLARE_SAAS_FALLBACK_ORIGIN
# dans /opt/sokar/apps/api/.env (prod) ou /opt/sokar-staging/apps/api/.env (staging),
# backup automatique, redémarre sokar-api (ou sokar-staging-api), vérifie le health.
#
# Usage:
#   bash scripts/ops/setup-cloudflare-saas.sh --env prod --token "cf-token-xxx" --zone-id "zone-xxx"
#   bash scripts/ops/setup-cloudflare-saas.sh --env staging --token "..." --zone-id "..."
#   bash scripts/ops/setup-cloudflare-saas.sh --env prod --token "..." --zone-id "..." --fallback-origin "suppernote.com"
#
# Pré-requis:
#   - SSH access au VPS (deploy@sokar)
#   - Cloudflare for SaaS activé sur la zone (dashboard Cloudflare > SSL/TLS > Custom Hostnames)
#   - API Token créé (permissions Zone.SaaS:Edit + Zone.DNS:Read + Zone:Read)
#   - Zone ID récupéré (dashboard Cloudflare > Overview)

set -euo pipefail

# ── Source logging helpers ────────────────────────────────────────────────
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=ops/logging.sh
source "$SCRIPT_DIR/logging.sh"

# ── Variables par défaut ──────────────────────────────────────────────────
ENV=""
CF_TOKEN=""
CF_ZONE_ID=""
CF_FALLBACK_ORIGIN="suppernote.com"
VPS_HOST="sokar"
SSH_USER="deploy"

# ── Aide ──────────────────────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: bash scripts/ops/setup-cloudflare-saas.sh --env <prod|staging> --token <token> --zone-id <zone-id> [--fallback-origin <origin>]

Arguments:
  --env             Environnement cible : prod | staging (requis)
  --token           Cloudflare API Token (requis, ne sera JAMAIS loggé en clair)
  --zone-id         Cloudflare Zone ID (requis)
  --fallback-origin Origin qui reçoit le trafic des custom domains (défaut: suppernote.com)
  --help, -h        Affiche cette aide

Exemples:
  bash scripts/ops/setup-cloudflare-saas.sh --env prod --token "cf-token-xxx" --zone-id "zone-xxx"
  bash scripts/ops/setup-cloudflare-saas.sh --env staging --token "..." --zone-id "..." --fallback-origin "staging.suppernote.com"
EOF
}

# ── Parsing des arguments ─────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --env)
      ENV="$2"
      shift 2
      ;;
    --token)
      CF_TOKEN="$2"
      shift 2
      ;;
    --zone-id)
      CF_ZONE_ID="$2"
      shift 2
      ;;
    --fallback-origin)
      CF_FALLBACK_ORIGIN="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      log error "Argument inconnu : $1"
      usage
      exit 1
      ;;
  esac
done

# ── Validation des arguments ──────────────────────────────────────────────
if [ -z "$ENV" ]; then
  log error "--env est requis (prod | staging)"
  usage
  exit 1
fi

if [ "$ENV" != "prod" ] && [ "$ENV" != "staging" ]; then
  log error "--env doit être 'prod' ou 'staging' ( reçu : $ENV )"
  exit 1
fi

if [ -z "$CF_TOKEN" ]; then
  log error "--token est requis (Cloudflare API Token)"
  exit 1
fi

if [ -z "$CF_ZONE_ID" ]; then
  log error "--zone-id est requis (Cloudflare Zone ID)"
  exit 1
fi

# ── Détermination des chemins et services selon l'environnement ────────────
if [ "$ENV" = "prod" ]; then
  ENV_FILE="/opt/sokar/apps/api/.env"
  PM2_SERVICE="sokar-api"
  HEALTH_PORT=4000
else
  ENV_FILE="/opt/sokar-staging/apps/api/.env"
  PM2_SERVICE="sokar-staging-api"
  HEALTH_PORT=4100
fi

log_section "Configuration Cloudflare for SaaS — $ENV"
log info "VPS host      : $VPS_HOST (ssh $SSH_USER@$VPS_HOST)"
log info "Fichier .env  : $ENV_FILE"
log info "Service PM2   : $PM2_SERVICE"
log info "Health port   : $HEALTH_PORT"
log info "Fallback origin: $CF_FALLBACK_ORIGIN"
log info "API Token     : [REDACTED]"
log info "Zone ID       : $CF_ZONE_ID"

# ── Vérification de la connectivité SSH ────────────────────────────────────
log info "Vérification de la connectivité SSH vers $SSH_USER@$VPS_HOST..."
if ! ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_USER@$VPS_HOST" true 2>/dev/null; then
  log error "Impossible de se connecter en SSH à $SSH_USER@$VPS_HOST. Vérifiez votre accès SSH."
  exit 1
fi
log ok "Connexion SSH OK"

# ── Vérification de l'existence du fichier .env ───────────────────────────
log info "Vérification du fichier .env sur le VPS..."
if ! ssh "$SSH_USER@$VPS_HOST" "test -f '$ENV_FILE'"; then
  log error "Le fichier $ENV_FILE n'existe pas sur le VPS. Déployez d'abord l'application."
  exit 1
fi
log ok "Fichier .env trouvé"

# ── Backup du .env ─────────────────────────────────────────────────────────
log info "Backup du fichier .env..."
BACKUP_TIMESTAMP=$(date +%Y%m%d%H%M%S)
ssh "$SSH_USER@$VPS_HOST" "cp '$ENV_FILE' '${ENV_FILE}.backup.${BACKUP_TIMESTAMP}'"
log ok "Backup créé : ${ENV_FILE}.backup.${BACKUP_TIMESTAMP}"

# ── Vérification de l'état actuel des vars ─────────────────────────────────
# On récupère les valeurs actuelles pour déterminer si un changement est nécessaire.
log info "Vérification des vars Cloudflare existantes..."
CURRENT_STATE=$(ssh "$SSH_USER@$VPS_HOST" bash -s <<REMOTE_SCRIPT
ENV_FILE="$ENV_FILE"
has_token=0
has_zone=0
has_fallback=0
token_match=0
zone_match=0
fallback_match=0

if grep -qE '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  has_token=1
  current_token=$(grep -E '^CLOUDFLARE_API_TOKEN=' "$ENV_FILE" | head -1 | sed 's/^CLOUDFLARE_API_TOKEN=//' | tr -d '"' || true)
  if [ "\$current_token" = "$CF_TOKEN" ]; then
    token_match=1
  fi
fi

if grep -qE '^CLOUDFLARE_ZONE_ID=' "$ENV_FILE" 2>/dev/null; then
  has_zone=1
  current_zone=$(grep -E '^CLOUDFLARE_ZONE_ID=' "$ENV_FILE" | head -1 | sed 's/^CLOUDFLARE_ZONE_ID=//' | tr -d '"' || true)
  if [ "\$current_zone" = "$CF_ZONE_ID" ]; then
    zone_match=1
  fi
fi

if grep -qE '^CLOUDFLARE_SAAS_FALLBACK_ORIGIN=' "$ENV_FILE" 2>/dev/null; then
  has_fallback=1
  current_fallback=$(grep -E '^CLOUDFLARE_SAAS_FALLBACK_ORIGIN=' "$ENV_FILE" | head -1 | sed 's/^CLOUDFLARE_SAAS_FALLBACK_ORIGIN=//' | tr -d '"' || true)
  if [ "\$current_fallback" = "$CF_FALLBACK_ORIGIN" ]; then
    fallback_match=1
  fi
fi

echo "has_token=\$has_token has_zone=\$has_zone has_fallback=\$has_fallback token_match=\$token_match zone_match=\$zone_match fallback_match=\$fallback_match"
REMOTE_SCRIPT
)

log debug "État actuel : $CURRENT_STATE"

# Parse the current state
has_token=$(echo "$CURRENT_STATE" | grep -oE 'has_token=[01]' | cut -d= -f2)
has_zone=$(echo "$CURRENT_STATE" | grep -oE 'has_zone=[01]' | cut -d= -f2)
has_fallback=$(echo "$CURRENT_STATE" | grep -oE 'has_fallback=[01]' | cut -d= -f2)
token_match=$(echo "$CURRENT_STATE" | grep -oE 'token_match=[01]' | cut -d= -f2)
zone_match=$(echo "$CURRENT_STATE" | grep -oE 'zone_match=[01]' | cut -d= -f2)
fallback_match=$(echo "$CURRENT_STATE" | grep -oE 'fallback_match=[01]' | cut -d= -f2)

# ── Détermination des actions nécessaires ──────────────────────────────────
needs_update=false
actions=()

# Token
if [ "$has_token" = "1" ] && [ "$token_match" = "1" ]; then
  log ok "CLOUDFLARE_API_TOKEN déjà présent et identique — aucune modification"
  actions+=("token:noop")
elif [ "$has_token" = "1" ]; then
  log warn "CLOUDFLARE_API_TOKEN présent mais différent — mise à jour"
  needs_update=true
  actions+=("token:update")
else
  log info "CLOUDFLARE_API_TOKEN absent — ajout"
  needs_update=true
  actions+=("token:add")
fi

# Zone ID
if [ "$has_zone" = "1" ] && [ "$zone_match" = "1" ]; then
  log ok "CLOUDFLARE_ZONE_ID déjà présent et identique — aucune modification"
  actions+=("zone:noop")
elif [ "$has_zone" = "1" ]; then
  log warn "CLOUDFLARE_ZONE_ID présent mais différent — mise à jour"
  needs_update=true
  actions+=("zone:update")
else
  log info "CLOUDFLARE_ZONE_ID absent — ajout"
  needs_update=true
  actions+=("zone:add")
fi

# Fallback origin
if [ "$has_fallback" = "1" ] && [ "$fallback_match" = "1" ]; then
  log ok "CLOUDFLARE_SAAS_FALLBACK_ORIGIN déjà présent et identique — aucune modification"
  actions+=("fallback:noop")
elif [ "$has_fallback" = "1" ]; then
  log warn "CLOUDFLARE_SAAS_FALLBACK_ORIGIN présent mais différent — mise à jour"
  needs_update=true
  actions+=("fallback:update")
else
  log info "CLOUDFLARE_SAAS_FALLBACK_ORIGIN absent — ajout"
  needs_update=true
  actions+=("fallback:add")
fi

# ── Idempotence : si rien à changer, on ne redémarre pas ───────────────────
if [ "$needs_update" = false ]; then
  log_section "Résultat"
  log ok "Toutes les vars Cloudflare SaaS sont déjà configurées avec les mêmes valeurs."
  log ok "Aucune modification nécessaire — service non redémarré (idempotent)."
  exit 0
fi

# ── Application des modifications sur le VPS ───────────────────────────────
log_section "Application des modifications sur le VPS"

# On passe les valeurs via des variables d'env SSH pour éviter qu'elles
# apparaissent dans la ligne de commande (ps/audit logs).
# Le token n'est jamais echo/loggé en clair.
SSH_CF_TOKEN="$CF_TOKEN" \
SSH_CF_ZONE_ID="$CF_ZONE_ID" \
SSH_CF_FALLBACK_ORIGIN="$CF_FALLBACK_ORIGIN" \
SSH_ENV_FILE="$ENV_FILE" \
ssh "$SSH_USER@$VPS_HOST" \
  'SSH_CF_TOKEN SSH_CF_ZONE_ID SSH_CF_FALLBACK_ORIGIN SSH_ENV_FILE' \
  bash -s <<'REMOTE_SCRIPT'
set -euo pipefail

ENV_FILE="$SSH_ENV_FILE"

# Fonction pour mettre à jour ou ajouter une var dans le .env
# $1 = nom de la var, $2 = valeur
update_or_add() {
  local var_name="$1"
  local var_value="$2"
  if grep -qE "^${var_name}=" "$ENV_FILE"; then
    # Met à jour la ligne existante (sed in-place)
    # Utilise un délimiteur improbable pour éviter les conflits avec les valeurs
    sed -i "s|^${var_name}=.*|${var_name}=\"${var_value}\"|" "$ENV_FILE"
  else
    # Ajoute à la fin du fichier
    echo "" >> "$ENV_FILE"
    echo "${var_name}=\"${var_value}\"" >> "$ENV_FILE"
  fi
}

update_or_add "CLOUDFLARE_API_TOKEN" "$SSH_CF_TOKEN"
update_or_add "CLOUDFLARE_ZONE_ID" "$SSH_CF_ZONE_ID"
update_or_add "CLOUDFLARE_SAAS_FALLBACK_ORIGIN" "$SSH_CF_FALLBACK_ORIGIN"

echo "done"
REMOTE_SCRIPT

log ok "Variables mises à jour dans $ENV_FILE"

# ── Redémarrage du service PM2 ─────────────────────────────────────────────
log_section "Redémarrage du service $PM2_SERVICE"
log info "pm2 restart $PM2_SERVICE..."
ssh "$SSH_USER@$VPS_HOST" "pm2 restart '$PM2_SERVICE' --update-env"
log ok "Service $PM2_SERVICE redémarré"

# ── Vérification du health check ──────────────────────────────────────────
log_section "Health check"
log info "curl -fsS http://localhost:$HEALTH_PORT/livez..."

# Attendre 3 secondes que le service soit prêt
sleep 3

if ssh "$SSH_USER@$VPS_HOST" "curl -fsS 'http://localhost:$HEALTH_PORT/livez'" 2>/dev/null; then
  log ok "Health check OK — $PM2_SERVICE répond sur le port $HEALTH_PORT"
else
  log error "Health check FAIL — $PM2_SERVICE ne répond pas sur le port $HEALTH_PORT"
  log error "Vérifiez les logs : ssh $SSH_USER@$VPS_HOST 'pm2 logs $PM2_SERVICE --lines 50'"
  exit 1
fi

# ── Résumé final ───────────────────────────────────────────────────────────
log_section "Résumé"
log info "Environnement   : $ENV"
log info "Fichier .env    : $ENV_FILE"
log info "Backup          : ${ENV_FILE}.backup.${BACKUP_TIMESTAMP}"
for action in "${actions[@]}"; do
  var_name=$(echo "$action" | cut -d: -f1)
  action_type=$(echo "$action" | cut -d: -f2)
  case "$action_type" in
    add)    log ok "$var_name : ajouté" ;;
    update) log ok "$var_name : mis à jour" ;;
    noop)   log info "$var_name : inchangé" ;;
  esac
done
log ok "Service         : $PM2_SERVICE redémarré"
log ok "Health          : OK (port $HEALTH_PORT)"
log info "API Token       : [REDACTED]"
log info "Zone ID         : $CF_ZONE_ID"
log info "Fallback origin : $CF_FALLBACK_ORIGIN"
log ok "Configuration Cloudflare for SaaS terminée avec succès."
