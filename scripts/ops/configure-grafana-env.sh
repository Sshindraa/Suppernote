#!/usr/bin/env bash
# Privileged helper called only by suppernote-deploy-root configure-grafana.
# Reads GRAFANA_ADMIN_PASSWORD over stdin as KEY<TAB>VALUE and atomically
# updates the root-only monitoring env file without putting the value in
# command arguments or output.

set -Eeuo pipefail

env_file="${1:?usage: configure-grafana-env.sh /path/to/grafana.env}"
env_dir="$(dirname "$env_file")"

if [[ -L "$env_dir" || -L "$env_file" || ( -e "$env_file" && ! -f "$env_file" ) ]]; then
  echo "Fichier ou répertoire d'environnement Grafana invalide." >&2
  exit 1
fi
install -d -o root -g root -m 0750 "$env_dir"

secret_file="$(mktemp "$env_dir/.grafana-password.XXXXXX")"
tmp_file="$(mktemp "$env_dir/.env.grafana.XXXXXX")"
cleanup() {
  rm -f "$secret_file" "$tmp_file"
}
trap cleanup EXIT
chmod 0600 "$secret_file" "$tmp_file"

count=0
while IFS=$'\t' read -r key value extra; do
  [[ -n "$key" ]] || continue
  [[ "$key" == GRAFANA_ADMIN_PASSWORD && -z "${extra:-}" ]] || {
    echo "Entrée Grafana invalide." >&2
    exit 1
  }
  [[ "$value" =~ ^[a-f0-9]{64}$ ]] || {
    echo "Le secret Grafana doit être un hexadécimal aléatoire de 32 octets." >&2
    exit 1
  }
  printf '%s\n' "$value" > "$secret_file"
  count=$((count + 1))
done

[[ "$count" -eq 1 ]] || {
  echo "Une seule valeur GRAFANA_ADMIN_PASSWORD est requise." >&2
  exit 1
}

source_file=/dev/null
[[ ! -e "$env_file" ]] || source_file="$env_file"
awk -v secret_file="$secret_file" '
  BEGIN {
    getline password < secret_file
    close(secret_file)
    prefix = "GRAFANA_ADMIN_PASSWORD="
    replacement = prefix password
  }
  index($0, prefix) == 1 {
    if (!replaced) print replacement
    replaced = 1
    next
  }
  { print }
  END { if (!replaced) print replacement }
' "$source_file" > "$tmp_file"

chown root:root "$tmp_file"
chmod 0600 "$tmp_file"
mv -f "$tmp_file" "$env_file"
rm -f "$secret_file"
echo "Secret Grafana installé dans l'environnement ops root-only."
