#!/usr/bin/env bash
# Configure un fichier de swap sur le VPS.
#
# Le VPS a 4GB RAM et 0 swap → les builds Next.js (dashboard + Suppernote Connect)
# sont tués par l'OOM killer (exit 137). 2GB de swap sur disque suffisent
# car le swap n'est utilisé que pendant les pics de build.
#
# Usage (en root) :
#   bash scripts/ops/setup-swap.sh
#
# Idempotent : ne recrée pas le swap s'il existe déjà.

set -euo pipefail

SWAPFILE="/swapfile"
SIZE_GB="${1:-2}"

if swapon --show | grep -q "$SWAPFILE"; then
    echo "✅ Swap déjà actif :"
    swapon --show
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "❌ Ce script doit être lancé en root (sudo)."
    exit 1
fi

echo "→ Création de ${SWAPFILE} (${SIZE_GB}G)..."
fallocate -l "${SIZE_GB}G" "$SWAPFILE"
chmod 600 "$SWAPFILE"
mkswap "$SWAPFILE"
swapon "$SWAPFILE"

# Persister au redémarrage
if ! grep -q "$SWAPFILE" /etc/fstab; then
    echo "${SWAPFILE} none swap sw 0 0" >> /etc/fstab
fi

echo "✅ Swap activé et persisté :"
swapon --show
free -m
