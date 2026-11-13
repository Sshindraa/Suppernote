#!/usr/bin/env bash
# mac-migration-2026-07-01/install.sh
# Cible: nouveau Mac. Déchiffre le bundle et restore Hermes + SSH + .env + alias.
#
# Usage:  ./install.sh <chemin-vers-sokar-mac-migration-*.tar.gz.enc>
# Sortie: Hermes, profils, SSH, alias .zshrc, et clone Suppernote si absent.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ENC="${1:-}"
[[ -f "$ENC" ]] || { echo "usage: $0 <bundle.tar.gz.enc>"; exit 1; }

# ---------- Verif checksum ----------
SUM_FILE="${ENC%.tar.gz.enc}.sha256"
if [[ -f "$SUM_FILE" ]]; then
  echo "== Vérification du checksum =="
  if command -v shasum >/dev/null; then
    shasum -a 256 -c "$SUM_FILE"
  else
    sha256sum -c "$SUM_FILE"
  fi
  echo
else
  echo "!! Pas de .sha256 à côté de l'archive (continue quand même)"
  echo
fi

# ---------- Stage ----------
WORK="$(mktemp -d -t sokar-mig.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT

echo "== Déchiffrement =="
# Support non-interactive via INSTALL_PASS env var (used in tests)
if [[ -n "${INSTALL_PASS:-}" ]]; then
  PASS="$INSTALL_PASS"
else
  read -rs -p "passphrase : " PASS; echo
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -in "$ENC" -out "$WORK/bundle.tar.gz" -pass pass:"$PASS"
unset PASS

echo "== Décompression =="
tar -xzf "$WORK/bundle.tar.gz" -C "$WORK"
BUNDLE="$WORK/mac-migration"
[[ -d "$BUNDLE" ]] || { echo "bundle mal formé"; exit 1; }
echo

# ---------- 1. Hermes racine ----------
echo "== 1/5 Restauration Hermes racine =="
mkdir -p ~/.hermes
[[ -f "$BUNDLE/hermes/config.yaml" ]] && cp -p "$BUNDLE/hermes/config.yaml" ~/.hermes/config.yaml
[[ -f "$BUNDLE/hermes/auth.json"    ]] && cp -p "$BUNDLE/hermes/auth.json"    ~/.hermes/auth.json
[[ -f "$BUNDLE/hermes/.env"         ]] && cp -p "$BUNDLE/hermes/.env"         ~/.hermes/.env
chmod 600 ~/.hermes/.env ~/.hermes/auth.json 2>/dev/null || true
[[ -f "$BUNDLE/hermes/context_length_cache.yaml" ]] && cp -p "$BUNDLE/hermes/context_length_cache.yaml" ~/.hermes/
[[ -d "$BUNDLE/hermes/memories" ]] && cp -pR "$BUNDLE/hermes/memories" ~/.hermes/
[[ -f "$BUNDLE/hermes/kanban.db" ]] && cp -p "$BUNDLE/hermes/kanban.db" ~/.hermes/
[[ -f "$BUNDLE/hermes/cron_jobs.json" ]] && mkdir -p ~/.hermes/cron && cp -p "$BUNDLE/hermes/cron_jobs.json" ~/.hermes/cron/jobs.json
[[ -d "$BUNDLE/hermes/plugins" ]] && cp -pR "$BUNDLE/hermes/plugins" ~/.hermes/
[[ -d "$BUNDLE/hermes/skills" ]] && cp -pR "$BUNDLE/hermes/skills" ~/.hermes/

# ---------- 2. Profils custom ----------
# (le profil "default" est la racine ~/.hermes/ déjà restaurée en [1])
echo "== 2/5 Restauration profils Hermes custom =="
for p in backend dashboard database supervisor; do
  src="$BUNDLE/profiles/$p"
  [[ -d "$src" ]] || { echo "  (skip $p : absent du bundle)"; continue; }
  dst=~/.hermes/profiles/$p
  mkdir -p "$dst"
  for f in config.yaml auth.json auth.lock bin state.db lsp models_dev_cache.json .update_check; do
    if [[ -e "$src/$f" ]]; then
      cp -pR "$src/$f" "$dst/"
    fi
  done
  echo "  ✓ $p"
done

# ---------- 3. SSH ----------
echo "== 3/5 Restauration SSH =="
mkdir -p ~/.ssh
chmod 700 ~/.ssh
for f in config known_hosts known_hosts.old; do
  [[ -f "$BUNDLE/ssh/$f" ]] && cp -p "$BUNDLE/ssh/$f" ~/.ssh/ && chmod 644 ~/.ssh/$f 2>/dev/null
done
for pub in "$BUNDLE"/ssh/*.pub; do
  [[ -f "$pub" ]] || continue
  name=$(basename "$pub")
  cp -p "$pub" ~/.ssh/ && chmod 644 ~/.ssh/$name
  priv="${pub%.pub}"
  if [[ -f "$priv" ]]; then
    cp -p "$priv" ~/.ssh/ && chmod 600 ~/.ssh/$(basename "$priv")
  fi
done

# ---------- 4. Suppernote .env + clone ----------
echo "== 4/5 Suppernote repo + .env =="
SOKAR_DIR="/Users/hamza/Desktop/Sokar"
if [[ ! -d "$SOKAR_DIR/.git" ]]; then
  echo "  → clone Suppernote depuis GitHub (Sshindraa/Sokar)"
  git clone https://github.com/Sshindraa/Sokar.git "$SOKAR_DIR"
else
  echo "  ✓ repo déjà présent, pas de re-clone"
fi
# Restore .env UNIQUEMENT si les fichiers cibles n'existent pas
[[ -f "$BUNDLE/sokar/.env.local" && ! -f "$SOKAR_DIR/.env.local" ]] && \
  cp -p "$BUNDLE/sokar/.env.local" "$SOKAR_DIR/.env.local" && echo "  ✓ .env.local restauré"
[[ -f "$BUNDLE/sokar/database.env" && ! -f "$SOKAR_DIR/packages/database/.env" ]] && \
  mkdir -p "$SOKAR_DIR/packages/database" && \
  cp -p "$BUNDLE/sokar/database.env" "$SOKAR_DIR/packages/database/.env" && echo "  ✓ packages/database/.env restauré"

# ---------- 5. Shell ----------
echo "== 5/5 Alias & PATH dans .zshrc =="
ZSHRC=~/.zshrc
touch "$ZSHRC"
MARK="# --- sokar-mac-migration ---"
END="# --- /sokar-mac-migration ---"
# Strip ancien bloc s'il existe
if grep -qF "$MARK" "$ZSHRC"; then
  # Mac sed -i ''
  sed -i '' "/$MARK/,/$END/d" "$ZSHRC"
fi
printf "\n%s\n%s\n%s\n" "$MARK" "$(cat "$BUNDLE/shell/extras.zsh")" "$END" >> "$ZSHRC"
echo "  ✓ bloc alias ajouté à $ZSHRC"
echo

# ---------- 6. Hermes via pipx (si pas déjà là) ----------
if ! command -v hermes >/dev/null 2>&1; then
  echo "!! Hermes n'est pas dans le PATH."
  echo "   Installe-le avec :  pipx install hermes-agent"
  echo "   (puis relance ce script si besoin, ou simplement :  hermes doctor)"
  echo
else
  echo "== Hermes déjà installé =="
  hermes --version
fi

# ---------- 7. Vérifs post-install ----------
echo
echo "== Vérifications =="
echo -n "  config.yaml: "; [[ -s ~/.hermes/config.yaml ]] && echo "OK ($(wc -c <~/.hermes/config.yaml) B)" || echo "MANQUANT"
echo -n "  auth.json:   "; [[ -s ~/.hermes/auth.json ]] && echo "OK" || echo "MANQUANT"
echo -n "  SSH suppernote:   "; [[ -f ~/.ssh/sokar_ovh ]] && echo "OK" || echo "MANQUANT"
echo -n "  SSH config:  "; [[ -f ~/.ssh/config ]] && echo "OK" || echo "MANQUANT"
echo -n "  profiles:    "; ls -1 ~/.hermes/profiles/ 2>/dev/null | tr '\n' ' '; echo "(default = racine)"

echo
echo "== Prochaines étapes =="
cat <<'TXT'
  1. Relance le terminal (ou:  source ~/.zshrc)
  2. hermes doctor
  3. ssh pmbtc 'hostname && pwd'    # teste le VPS
  4. cd /Users/hamza/Desktop/Sokar
  5. PATH="/usr/local/opt/node@22/bin:$PATH" pnpm install   # si pas fait
  6. pnpm dev
TXT
