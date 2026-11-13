#!/usr/bin/env bash
# mac-migration-2026-07-01/bundle.sh
# Source: ancien Mac (MacBookPro.lan). Crée une archive chiffrée AES-256
# contenant tout ce qu'il faut pour recréer l'environnement sur le nouveau Mac.
#
# Usage:  ./bundle.sh
# Output: ./sokar-mac-migration-<timestamp>.tar.gz.enc + checksum + README.txt
#
# Chiffrement : openssl enc -aes-256-cbc -pbkdf2 -iter 200000
# Saisie passphrase interactive (2 fois) au début du script.

set -eo pipefail

# ---------- Config ----------
HERE="$(cd "$(dirname "$0")" && pwd)"
TS="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="$HERE/out"
STAGE="$OUT_DIR/stage-$TS"
ARCHIVE="$OUT_DIR/sokar-mac-migration-$TS.tar.gz"
ENC="$OUT_DIR/sokar-mac-migration-$TS.tar.gz.enc"
SUM="$OUT_DIR/sokar-mac-migration-$TS.sha256"
README="$OUT_DIR/sokar-mac-migration-$TS.README.txt"

# Profils Hermes à migrer (config + auth + bin, on jette les sessions debug)
PROFILES=(default backend dashboard database supervisor)

# ---------- Préflight ----------
command -v openssl >/dev/null || { echo "openssl manquant"; exit 1; }
command -v tar     >/dev/null || { echo "tar manquant"; exit 1; }
command -v shasum  >/dev/null || command -v sha256sum >/dev/null \
  || { echo "shasum/sha256sum manquant"; exit 1; }

mkdir -p "$OUT_DIR" "$STAGE"
echo "== mac-migration bundle =="
echo "  OUT_DIR : $OUT_DIR"
echo "  TS      : $TS"
echo

# ---------- Passphrase ----------
if [[ -n "${BUNDLE_PASS:-}" ]]; then
  PASS1="$BUNDLE_PASS"
  [[ ${#PASS1} -ge 12 ]] || { echo "  ! BUNDLE_PASS trop courte (min 12)"; exit 1; }
  echo "[1/5] Passphrase fournie via BUNDLE_PASS (len=${#PASS1})"
else
  echo "[1/5] Saisie passphrase (tu la réutilises sur le nouveau Mac)"
  read -rs -p "  passphrase (min 12 car) : " PASS1; echo
  read -rs -p "  confirmation           : " PASS2; echo
  [[ ${#PASS1} -ge 12 ]] || { echo "  ! trop courte (min 12)"; exit 1; }
  [[ "$PASS1" == "$PASS2" ]] || { echo "  ! ne matche pas"; exit 1; }
  unset PASS2
fi
echo

# ---------- Stage ----------
echo "[2/5] Stage des fichiers"
ROOT="$STAGE/mac-migration"
mkdir -p "$ROOT"/{hermes,profiles,ssh,sokar,shell}

# 2a. Hermes racine
cp -p ~/.hermes/config.yaml           "$ROOT/hermes/"
cp -p ~/.hermes/auth.json              "$ROOT/hermes/"
cp -p ~/.hermes/.env                   "$ROOT/hermes/"
cp -p ~/.hermes/context_length_cache.yaml "$ROOT/hermes/" 2>/dev/null || true
# Memories (perso + user)
[[ -d ~/.hermes/memories ]] && cp -pR ~/.hermes/memories "$ROOT/hermes/"
# Kanban db (suppernote tasks)
cp -p ~/.hermes/kanban.db              "$ROOT/hermes/" 2>/dev/null || true
# Cron jobs.json (déclencheurs)
cp -p ~/.hermes/cron/jobs.json         "$ROOT/hermes/cron_jobs.json" 2>/dev/null || true
# Plugins (kanban etc.)
[[ -d ~/.hermes/plugins ]] && cp -pR ~/.hermes/plugins "$ROOT/hermes/" 2>/dev/null || true
# Skills (catalogue SKILL.md + curator state + usage)
[[ -d ~/.hermes/skills ]] && cp -pR ~/.hermes/skills "$ROOT/hermes/" 2>/dev/null || true

# 2b. Profils Hermes : on garde config + auth + bin + state.db + lsp (sans sessions)
# Le profil "default" n'est pas dans ~/.hermes/profiles/, c'est la racine ~/.hermes/
# déjà capturée en 2a. On liste donc les profils custom seulement.
for p in "${PROFILES[@]}"; do
  if [[ "$p" == "default" ]]; then
    # Déjà capturé en 2a
    continue
  fi
  src=~/.hermes/profiles/$p
  [[ -d "$src" ]] || { echo "  (skip profil $p : absent)"; continue; }
  dst="$ROOT/profiles/$p"
  mkdir -p "$dst"
  # Fichiers racine du profil
  for f in config.yaml auth.json auth.lock bin state.db lsp models_dev_cache.json; do
    if [[ -e "$src/$f" ]]; then
      cp -pR "$src/$f" "$dst/"
    fi
  done
  echo "  profil $p: $(du -sh "$dst" 2>/dev/null | cut -f1)"
done

# 2c. SSH (config + clés privées + pub + known_hosts)
mkdir -p "$ROOT/ssh"
chmod 700 "$ROOT/ssh"
for f in config known_hosts known_hosts.old; do
  [[ -f ~/.ssh/$f ]] && cp -p ~/.ssh/$f "$ROOT/ssh/"
done
# Clés privées + publiques — on garde tout ce qui a un .pub
for pub in ~/.ssh/*.pub; do
  [[ -f "$pub" ]] || continue
  priv="${pub%.pub}"
  cp -p "$pub"   "$ROOT/ssh/"
  [[ -f "$priv" ]] && cp -p "$priv" "$ROOT/ssh/"
done
chmod 600 "$ROOT/ssh"/* 2>/dev/null || true
chmod 644 "$ROOT/ssh"/*.pub 2>/dev/null || true

# 2d. Suppernote .env (projet)
mkdir -p "$ROOT/sokar"
cp -p /Users/hamza/Desktop/Sokar/.env.local            "$ROOT/sokar/" 2>/dev/null || true
cp -p /Users/hamza/Desktop/Sokar/packages/database/.env "$ROOT/sokar/database.env" 2>/dev/null || true

# 2e. Extraits shell (alias Hermes/Sokar utiles — pas tout .zshrc, juste les blocs pertinents)
# On sauvegarde des blocs nommés plutôt que tout .zshrc pour éviter de réinjecter du bruit.
cat > "$ROOT/shell/extras.zsh" <<'ZSH'
# --- sokar-mac-migration : PATH & alias (ajoutés par install.sh) ---
export PATH="/usr/local/opt/node@22/bin:$PATH"
export PATH="$HOME/.npm-global/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
alias sokar-tunnel="ssh -i ~/.ssh/sokar_ovh -L 3002:127.0.0.1:3002 deploy@57.131.148.179 -N"
alias sokar="cd /Users/hamza/Desktop/Sokar"
ZSH
echo

# ---------- Tar ----------
echo "[3/5] Compression tar.gz"
tar -czf "$ARCHIVE" -C "$STAGE" "mac-migration"
du -h "$ARCHIVE"
echo

# ---------- Chiffrement ----------
echo "[4/5] Chiffrement AES-256-CBC + PBKDF2 (200k iter)"
openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 \
  -in "$ARCHIVE" -out "$ENC" -pass pass:"$PASS1"
# Note: PASS1 is kept around — used at the end if BUNDLE_PASS_AUTO=1 to write PASSPHRASE-<TS>.txt
rm -f "$ARCHIVE"

# Checksum sur l'archive chiffrée (pour intégrité après transport)
if command -v shasum >/dev/null; then
  shasum -a 256 "$ENC" | tee "$SUM"
else
  sha256sum "$ENC" | tee "$SUM"
fi
echo

# ---------- README ----------
cat > "$README" <<EOF
=== Sokar Mac Migration Bundle ===
Date      : $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Source Mac: $(hostname)  ($(ipconfig getifaddr en0 2>/dev/null || echo "n/a"))
User      : $USER
macOS     : $(sw_vers -productVersion)

=== Contenu ===
  mac-migration/
    hermes/         config.yaml, auth.json, .env, memories/, kanban.db, cron_jobs.json, skills/
    profiles/       default + backend + dashboard + database + supervisor (config+auth+bin+state)
    ssh/            config, known_hosts, sokar_ovh{,.pub}, mac_tunnel_key
    sokar/          .env.local + database.env
    shell/extras.zsh PATH & alias à sourcer

=== Restauration sur le nouveau Mac ===
  1. Recopie le .tar.gz.enc + ce README + le .sha256 sur le nouveau Mac
     (AirDrop dézippe, garde l'archive .enc originale).
  2. Vérifie le checksum :  shasum -a 256 sokar-mac-migration-*.tar.gz.enc
  3. Lance install.sh (présent à côté de bundle.sh dans ce repo) — il te
     demandera la passphrase, installera Hermes via pipx, replacera les
     profils, SSH, .env, alias et clonera Sokar si pas déjà fait.
  4. Relance le terminal, fais:  hermes doctor
     puis:                            ssh sokar 'hostname && pwd'

=== Notes ===
  - Les sessions de debug des profils ont été droppées (sessions/, request_dump_*).
    Ça économise ~500 MB et elles sont régénérées à l'usage.
  - Les hooks/, lsp/package-lock.json optionnels sont inclus s'ils existent.
  - Le VPS OVH est joignable depuis l'ancien Mac à l'écriture de ce bundle;
    le test était :  ssh -i ~/.ssh/sokar_ovh deploy@57.131.148.179
EOF
cp -p "$README" "$OUT_DIR/README-LATEST.txt"

# ---------- Cleanup stage ----------
rm -rf "$STAGE"

# Sauvegarde la passphrase dans un fichier 0600 à côté, pour qu'on puisse la retrouver
# Uniquement si on est en mode auto (sinon l'utilisateur la connaît)
if [[ "${BUNDLE_PASS_AUTO:-0}" == "1" && -n "${PASS1:-}" ]]; then
  PASS_FILE="$OUT_DIR/PASSPHRASE-$TS.txt"
  {
    printf "Suppernote Mac Migration passphrase\n"
    printf "Date: %s\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    printf "Source: %s\n" "$(hostname)"
    printf "Bundle: %s\n\n" "$(basename "$ENC")"
    printf "%s\n" "$PASS1"
  } > "$PASS_FILE"
  chmod 600 "$PASS_FILE"
  echo
  echo "############################################################"
  echo "#  PASSPHRASE (à noter et stocker dans un endroit sûr) :"
  echo "#"
  echo "#    $PASS1"
  echo "#"
  echo "#  Copie aussi dans : $PASS_FILE (chmod 600)"
  echo "############################################################"
  echo
fi
unset PASS1 2>/dev/null || true

echo "[5/5] Terminé."
echo "  archive chiffrée : $ENC"
echo "  checksum          : $SUM"
echo "  README            : $README"
echo
echo "Avant AirDrop : vérifie la taille et la passphrase."
echo "  $ENC : $(du -h "$ENC" | cut -f1)"
echo
echo "Prochaine étape : lance 'install.sh' sur le nouveau Mac après transfert."
