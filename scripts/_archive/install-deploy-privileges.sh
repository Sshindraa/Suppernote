#!/bin/bash

set -Eeuo pipefail

[ "${EUID}" -eq 0 ] || { echo "Exécutez ce script en root." >&2; exit 1; }

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
WRAPPER_SOURCE="$ROOT_DIR/scripts/ops/suppernote-deploy-root.sh"
SUDOERS_SOURCE="$ROOT_DIR/infra/sudoers.d/deploy"
WRAPPER_TARGET="/usr/local/sbin/sokar-deploy-root"
SUDOERS_TARGET="/etc/sudoers.d/deploy"
SUDOERS_BACKUP="/etc/sudoers.d/deploy.sokar-backup"

install -o root -g root -m 0755 "$WRAPPER_SOURCE" "$WRAPPER_TARGET"
if [ -f "$SUDOERS_TARGET" ]; then
    install -o root -g root -m 0440 "$SUDOERS_TARGET" "$SUDOERS_BACKUP"
fi
install -o root -g root -m 0440 "$SUDOERS_SOURCE" "$SUDOERS_TARGET"

if ! visudo -c; then
    if [ -f "$SUDOERS_BACKUP" ]; then
        install -o root -g root -m 0440 "$SUDOERS_BACKUP" "$SUDOERS_TARGET"
    else
        rm -f "$SUDOERS_TARGET"
    fi
    echo "Configuration sudoers invalide, restauration effectuée." >&2
    exit 1
fi

if id -nG deploy | tr ' ' '\n' | grep -qx sudo; then
    echo "AVERTISSEMENT: deploy appartient encore au groupe sudo." >&2
fi
if id -nG deploy | tr ' ' '\n' | grep -qx docker; then
    echo "AVERTISSEMENT: deploy appartient encore au groupe docker." >&2
fi

echo "Wrapper et sudoers installés. Retirez les groupes sudo/docker après validation du déploiement."
