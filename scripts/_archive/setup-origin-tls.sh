#!/usr/bin/env bash
# One-time origin hardening for the Sokar VPS.
# - Issues/renews a Let's Encrypt certificate for the two production hosts.
# - Restricts ports 80/443 to Cloudflare's published networks.

set -euo pipefail

if [ "$(hostname)" != "sokar" ]; then
  echo "❌ Ce script doit être exécuté sur le VPS sokar." >&2
  exit 1
fi

SOKAR_ROOT="${SOKAR_ROOT:-/opt/sokar}"
CERT_NAME="${CERT_NAME:-sokar.tech}"
EMAIL="${LETSENCRYPT_EMAIL:-contact@suppernote.com}"
WEBROOT="/var/www/certbot"

if ! command -v certbot >/dev/null; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq certbot
fi

install -d -m 0755 "${WEBROOT}"

if [ ! -f "/etc/letsencrypt/live/${CERT_NAME}/fullchain.pem" ]; then
  restart_nginx() {
    systemctl start nginx >/dev/null 2>&1 || true
  }
  trap restart_nginx EXIT
  systemctl stop nginx
  certbot certonly \
    --standalone \
    --non-interactive \
    --agree-tos \
    --email "${EMAIL}" \
    --preferred-challenges http \
    --cert-name "${CERT_NAME}" \
    -d sokar.tech \
    -d api.sokar.tech
  systemctl start nginx
  trap - EXIT
fi

# Persist webroot authentication so renewals do not need to stop Nginx.
certbot reconfigure \
  --cert-name "${CERT_NAME}" \
  --webroot \
  --webroot-path "${WEBROOT}" \
  --non-interactive

mapfile -t CF_RANGES < <(
  sed -n 's/^set_real_ip_from[[:space:]]\+\([^;]*\);/\1/p' \
    "${SOKAR_ROOT}/infra/nginx/snippets/suppernote-cloudflare-real-ip.conf"
)

for range in "${CF_RANGES[@]}"; do
  ufw allow proto tcp from "${range}" to any port 80 comment 'Cloudflare origin HTTP' >/dev/null
  ufw allow proto tcp from "${range}" to any port 443 comment 'Cloudflare origin HTTPS' >/dev/null
done

ufw --force delete allow 80/tcp >/dev/null 2>&1 || true
ufw --force delete allow 443/tcp >/dev/null 2>&1 || true

nginx -t
systemctl reload nginx
certbot renew \
  --cert-name "${CERT_NAME}" \
  --dry-run \
  --no-random-sleep-on-renew \
  --run-deploy-hooks \
  --deploy-hook 'systemctl reload nginx'

echo "✅ TLS origine et allowlist Cloudflare configurés."
