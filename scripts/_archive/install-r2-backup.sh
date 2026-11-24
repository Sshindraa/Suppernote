#!/usr/bin/env bash
# Déploie le backup R2 sur le VPS de production.
#
# Usage (depuis le Mac dev):
#   VPS_HOST=suppernote bash scripts/ops/install-r2-backup.sh
#
# Étapes :
#   1. Vérifie la présence locale du script et de la config rclone
#   2. Pousse le script et la config sur le VPS via scp
#   3. Installe rclone dans ~/bin sur le VPS (si absent, sans sudo)
#   4. Active le cron quotidien à 04:00 UTC
#   5. Teste un premier backup (optionnel via --test)

set -euo pipefail

VPS_HOST="${VPS_HOST:?Usage: VPS_HOST=user@host bash scripts/ops/install-r2-backup.sh}"
VPS_PATH="${VPS_PATH:-/opt/sokar}"
RUN_TEST=0

for arg in "$@"; do
    case "$arg" in
        --test) RUN_TEST=1 ;;
    esac
done

SCRIPT_LOCAL="$(cd "$(dirname "$0")/../database" && pwd)/backup-postgres-r2.sh"
RCLONE_CONF="$HOME/.config/rclone/rclone.conf"

# ── 1. Pré-checks locaux ─────────────────────────────────
[ -f "$SCRIPT_LOCAL" ] || { echo "❌ $SCRIPT_LOCAL introuvable"; exit 1; }
[ -f "$RCLONE_CONF" ] || { echo "❌ $RCLONE_CONF introuvable. Lance d'abord: rclone config"; exit 1; }

echo "→ Pré-checks OK"

# ── 2. Push script + config sur le VPS ───────────────────
echo "→ Push du script sur $VPS_HOST:${VPS_PATH}/scripts/"
ssh "$VPS_HOST" "mkdir -p ${VPS_PATH}/scripts /var/log/sokar"
ssh "$VPS_HOST" "mkdir -p ${VPS_PATH}/scripts/database"
scp "$SCRIPT_LOCAL" "$VPS_HOST:${VPS_PATH}/scripts/database/backup-postgres-r2.sh"
ssh "$VPS_HOST" "chmod +x ${VPS_PATH}/scripts/database/backup-postgres-r2.sh"

echo "→ Push de la config rclone"
scp "$RCLONE_CONF" "$VPS_HOST:/tmp/rclone.conf"
ssh "$VPS_HOST" "mkdir -p ~/.config/rclone && mv /tmp/rclone.conf ~/.config/rclone/rclone.conf && chmod 600 ~/.config/rclone/rclone.conf"

# ── 3. Installer rclone si absent ─────────────────────────
echo "→ Vérification rclone sur le VPS"
if ! ssh "$VPS_HOST" "export PATH=\$HOME/bin:\$PATH && command -v rclone >/dev/null 2>&1"; then
    echo "→ Installation de rclone v1.69.0 dans ~/bin (sans sudo)"
    ssh "$VPS_HOST" "set -e; mkdir -p ~/bin; curl -fsSL https://github.com/rclone/rclone/releases/download/v1.69.0/rclone-v1.69.0-linux-amd64.zip -o /tmp/rclone.zip; cd /tmp; unzip -oq rclone.zip; cp /tmp/rclone-v1.69.0-linux-amd64/rclone ~/bin/rclone; chmod +x ~/bin/rclone; grep -q 'export PATH=\$HOME/bin' ~/.bashrc || echo 'export PATH=\$HOME/bin:\$PATH' >> ~/.bashrc"
else
    echo "✓ rclone déjà installé: $(ssh "$VPS_HOST" 'export PATH=$HOME/bin:$PATH && rclone version | head -1')"
fi

# ── 4. Test accès R2 ─────────────────────────────────────
echo "→ Test accès bucket R2"
ssh "$VPS_HOST" "export PATH=\$HOME/bin:\$PATH && rclone lsd r2: 2>&1 | grep -q sokar-backups" \
    || { echo "❌ Le bucket sokar-backups n'est pas visible depuis le VPS"; exit 1; }
echo "✓ Bucket sokar-backups accessible"

# ── 5. Activer le cron quotidien à 04:00 UTC ─────────────
echo "→ Installation du cron"
CRON_LINE="0 4 * * * export PATH=\$HOME/bin:/usr/bin:/bin && /opt/sokar/scripts/database/backup-postgres-r2.sh >> /var/log/sokar/postgres-r2-backup.log 2>&1"
ssh "$VPS_HOST" "(crontab -l 2>/dev/null | grep -v backup-postgres-r2 || true; echo '$CRON_LINE') | crontab -"
echo "✓ Cron installé:"
ssh "$VPS_HOST" "crontab -l | grep backup-postgres-r2"

# ── 6. Test optionnel ─────────────────────────────────────
if [ "$RUN_TEST" = 1 ]; then
    echo "→ Test de backup (mode --test)"
    ssh "$VPS_HOST" "bash ${VPS_PATH}/scripts/database/backup-postgres-r2.sh"
fi

echo ""
echo "✅ Déploiement terminé"
echo ""
echo "Vérifications :"
echo "  ssh $VPS_HOST 'crontab -l | grep backup'"
echo "  ssh $VPS_HOST 'tail -20 /var/log/sokar/postgres-r2-backup.log'"
echo "  rclone ls r2:sokar-backups/postgres/"
