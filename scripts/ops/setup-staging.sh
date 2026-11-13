#!/usr/bin/env bash
# One-time setup de l'environnement de staging Suppernote sur le VPS sokar.
#
# Ce script est idempotent : il peut être relancé sans casser une install existante.
# Il ne déploie PAS automatiquement : il prépare le terrain et demande de remplir
# les .env avant de lancer le premier deploy.
#
# Prérequis (hors portée du script) :
#   - DNS `staging.suppernote.com` et `api-staging.suppernote.com` pointent vers le VPS.
#   - Secrets GitHub `STAGING_HOST` et `STAGING_SSH_KEY` configurés.
#   - Accès SSH root ou sudo sur sokar.
#
# Usage (sur sokar, avec un utilisateur ayant sudo) :
#   bash scripts/ops/setup-staging.sh

set -euo pipefail

if [ "$(hostname)" != "sokar" ]; then
  echo "❌ Ce script doit être exécuté sur le VPS sokar." >&2
  exit 1
fi

SOKAR_ROOT="/opt/sokar-staging"
REPO_URL="https://github.com/Sshindraa/Suppernote.git"
WEBROOT="/var/www/certbot"
DB_NAME="sokar_staging"
STAGING_HOST="staging.suppernote.com"
API_STAGING_HOST="api-staging.suppernote.com"

# ─── 1. Répertoire de staging ───────────────────────────────────────────────
echo "→ Création de ${SOKAR_ROOT}..."
if [ ! -d "${SOKAR_ROOT}" ]; then
  sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" "${SOKAR_ROOT}"
fi

# ─── 2. Clonage du repo ────────────────────────────────────────────────────
echo "→ Clonage du repo Suppernote..."
if [ ! -d "${SOKAR_ROOT}/.git" ]; then
  git clone "${REPO_URL}" "${SOKAR_ROOT}"
fi

cd "${SOKAR_ROOT}"
git checkout main

echo "→ Pull latest main..."
git pull origin main

# ─── 3. Swap (requis pour les builds Next.js) ───────────────────────────────
echo "→ Vérification du swap..."
if ! swapon --show | grep -q swapfile 2>/dev/null; then
  echo "⚠️  Pas de swap détecté. Les builds Next.js risquent d'être tués par OOM."
  echo "   Lancez en root : sudo bash scripts/ops/setup-swap.sh"
  read -r -p "Continuer quand même ? [y/N] " confirm || true
  if [ "${confirm:-}" != "y" ]; then
    exit 1
  fi
fi

# ─── 4. Base de données Postgres ─────────────────────────────────────────────
echo "→ Création de la base de données ${DB_NAME}..."
if sudo -u postgres psql -lqt | cut -d \| -f 1 | grep -qw "${DB_NAME}"; then
  echo "   ✅ Base ${DB_NAME} déjà existante."
else
  sudo -u postgres createdb "${DB_NAME}"
  echo "   ✅ Base ${DB_NAME} créée."
fi

# ─── 5. Fichiers .env ──────────────────────────────────────────────────────
echo "→ Préparation des fichiers .env (staging)..."
ENV_READY=true
for app in api dashboard connect; do
  example="apps/${app}/.env.staging.example"
  target="apps/${app}/.env"
  if [ -f "${target}" ]; then
    echo "   ✅ ${target} existe déjà."
  else
    echo "   📄 Copie de ${example} vers ${target}"
    cp "${example}" "${target}"
    chmod 0600 "${target}"
    ENV_READY=false
  fi
done

if [ "${ENV_READY}" = false ]; then
  echo ""
  echo "⚠️  DES FICHIERS .ENV ONT ÉTÉ CRÉÉS AVEC DES PLACEHOLDERS."
  echo "   Vous DEVEZ éditer les fichiers suivants avec les vraies clés staging :"
  echo "     - ${SOKAR_ROOT}/apps/api/.env"
  echo "     - ${SOKAR_ROOT}/apps/dashboard/.env"
  echo "     - ${SOKAR_ROOT}/apps/connect/.env"
  echo ""
  echo "   Règles :"
  echo "     - Clerk : pk_test / sk_test (jamais de clés prod)."
  echo "     - Stripe : pk_test / sk_test."
  echo "     - Telnyx / ElevenLabs / Cartesia : LAISSER VIDE (voice désactivée)."
  echo "     - DATABASE_URL doit pointer sur ${DB_NAME}."
  echo "     - REDIS_URL doit utiliser db=3 (isolé de prod db=0/1/2)."
  echo ""
  echo "   Relancez ce script après avoir rempli les .env."
  exit 0
fi

# ─── 5a. Validation du mot de passe DATABASE_URL ───────────────────────────
echo "→ Vérification que DATABASE_URL n'utilise pas de mot de passe par défaut..."
if grep -qE 'DATABASE_URL=.*:(CHANGE_ME_PASSWORD|password)@' apps/api/.env; then
  echo ""
  echo "❌ Le mot de passe de DATABASE_URL dans apps/api/.env est un placeholder." >&2
  echo "   Remplacez le mot de passe par une valeur forte avant de continuer." >&2
  exit 1
fi

# ─── 6. Répertoire de logs PM2 ─────────────────────────────────────────────
echo "→ Création du répertoire de logs PM2..."
sudo install -d -m 0755 -o "$(whoami)" -g "$(whoami)" /var/log/sokar

# ─── 6a. Backup automatique de sokar_staging ───────────────────────────────
echo "→ Installation du backup automatique de sokar_staging..."
sudo install -d -m 0755 -o root -g root /var/backups/sokar-staging
sudo install -o root -g root -m 0755 \
  "${SOKAR_ROOT}/scripts/database/backup-staging-postgres.sh" \
  /usr/local/sbin/sokar-staging-backup-postgres
sudo install -o root -g root -m 0644 \
  "${SOKAR_ROOT}/infra/cron/sokar-staging-postgres-backup" \
  /etc/cron.d/sokar-staging-postgres-backup


# ─── 7. Nginx snippets partagés ────────────────────────────────────────────
echo "→ Installation des snippets Nginx..."
sudo install -d -m 0755 /etc/nginx/snippets
sudo install -m 0644 "${SOKAR_ROOT}/infra/nginx/snippets/sokar-proxy.conf" \
  /etc/nginx/snippets/sokar-proxy.conf 2>/dev/null || true
sudo install -m 0644 "${SOKAR_ROOT}/infra/nginx/snippets/sokar-cloudflare-real-ip.conf" \
  /etc/nginx/snippets/sokar-cloudflare-real-ip.conf 2>/dev/null || true

# ─── 8. Vhost staging ───────────────────────────────────────────────────────
echo "→ Installation du vhost staging..."
sudo install -d -m 0755 /etc/nginx/sites-available /etc/nginx/sites-enabled
sudo install -m 0644 "${SOKAR_ROOT}/infra/nginx/sokar-staging.conf" \
  /etc/nginx/sites-available/sokar-staging
sudo ln -sfn /etc/nginx/sites-available/sokar-staging /etc/nginx/sites-enabled/sokar-staging

# ─── 9. TLS pour staging ───────────────────────────────────────────────────
echo "→ Vérification du certificat TLS..."
if [ ! -f "/etc/letsencrypt/live/${STAGING_HOST}/fullchain.pem" ]; then
  echo "⚠️  Aucun certificat pour ${STAGING_HOST}."
  echo "   Deux options :"
  echo "     a) Certbot séparé (si le DNS pointe déjà vers ce VPS) :"
  echo "        sudo certbot --nginx -d ${STAGING_HOST} -d ${API_STAGING_HOST}"
  echo "     b) Cloudflare Origin Certificate + config manuelle dans le vhost."
  read -r -p "Voulez-vous lancer certbot maintenant ? [y/N] " certbot_now || true
  if [ "${certbot_now:-}" = "y" ]; then
    sudo certbot --nginx -d "${STAGING_HOST}" -d "${API_STAGING_HOST}"
  fi
fi

# ─── 10. Validation Nginx ─────────────────────────────────────────────────
echo "→ Validation de la configuration Nginx..."
if sudo nginx -t; then
  sudo systemctl reload nginx || true
else
  echo "❌ Configuration Nginx invalide. Corrigez le vhost avant de continuer." >&2
  exit 1
fi

# ─── 11. Premier déploiement ? ─────────────────────────────────────────────
echo ""
echo "✅ Setup de base terminé."
echo ""
echo "Prochaines étapes :"
echo "  1. Vérifiez que les .env sont correctement remplis :"
echo "       grep -E '^(CLERK_SECRET_KEY|STRIPE_SECRET_KEY|DATABASE_URL|REDIS_URL)=' apps/api/.env apps/dashboard/.env apps/connect/.env"
echo "  2. Lancez le premier déploiement :"
echo "       cd ${SOKAR_ROOT} && bash scripts/deploy.sh --env staging"
echo "  3. Ajoutez les secrets GitHub :"
echo "       STAGING_HOST=${STAGING_HOST}  (ou l'IP publique si pas de DNS)"
echo "       STAGING_SSH_KEY=<clé privée SSH de l'utilisateur deploy>"
echo "  4. Poussez un commit sur main pour tester le workflow CI."
echo ""
