#!/usr/bin/env bash
#
# Configures the HOST's nginx (not a container) as the reverse proxy and TLS
# terminator for this app, and obtains its Let's Encrypt certificate.
#
# Why host-level: the app container only speaks plain HTTP on a loopback-only
# port; it does not terminate TLS. A server can run several projects, each on
# its own (sub)domain, all needing port 443 — only one process can bind it, so
# nginx lives on the host and each project gets its own vhost file named after
# its domain. This script never touches another project's vhost.
#
# Usage:
#   make ssl                  # HTTP-01 challenge (default) — auto-renews
#   make ssl CHALLENGE=dns    # DNS-01, manual TXT record — does NOT auto-renew
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ "$(id -u)" != "0" ]]; then
  echo "==> Root access is required to configure nginx/certbot; re-running with sudo"
  exec sudo -E bash "$0" "$@"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script is written only for Ubuntu/Debian (apt)." >&2
  exit 1
fi

# shellcheck disable=SC1091
source scripts/lib.sh

load_env .env.prod || exit 1

: "${APP_DOMAIN:?Set APP_DOMAIN in .env.prod}"
DOMAIN="$APP_DOMAIN"
: "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL in .env.prod}"
APP_HTTP_PORT="${HTTP_PORT:-8090}"

CHALLENGE="${CHALLENGE:-http}"
if [[ "$CHALLENGE" != "http" && "$CHALLENGE" != "dns" ]]; then
  echo "Error: CHALLENGE must be \"http\" or \"dns\" (got \"${CHALLENGE}\")." >&2
  exit 1
fi

STAGING_FLAG=()
if [[ "${LETSENCRYPT_STAGING:-false}" == "true" ]]; then
  echo "Let's Encrypt staging mode is enabled (certificate will not be valid)."
  STAGING_FLAG=(--staging)
fi

VHOST_PATH="/etc/nginx/sites-available/${DOMAIN}.conf"
VHOST_LINK="/etc/nginx/sites-enabled/${DOMAIN}.conf"
CERT_PATH="/etc/letsencrypt/live/${DOMAIN}"
WEBROOT="/var/www/certbot"

echo "==> Installing nginx/certbot if needed (leaves any existing install alone)"
apt-get update
apt-get install -y --no-install-recommends nginx certbot gettext-base

if [[ ! -d /etc/nginx/sites-enabled ]]; then
  echo "Error: /etc/nginx/sites-enabled not found (expects the Debian/Ubuntu nginx layout)." >&2
  exit 1
fi

systemctl enable --now nginx
mkdir -p "$WEBROOT"

echo "==> Installing the shared certbot-renewal nginx-reload hook"
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
# Shared across every project on this host that uses host-level nginx + certbot webroot.
nginx -t && systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

if [[ "$CHALLENGE" == "http" ]]; then
  echo "==> Checking that ${DOMAIN} points to this server"
  server_ip="$(curl -fsS --max-time 10 https://api.ipify.org || echo '')"
  domain_ip="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -1 || echo '')"
  if [[ -n "$server_ip" && -n "$domain_ip" && "$server_ip" != "$domain_ip" ]]; then
    echo "Warning: ${DOMAIN} points to ${domain_ip} but this server's IP is ${server_ip}."
    echo "         If you just changed the DNS record, wait a bit; otherwise certbot will fail."
    read -r -p "         Continue anyway? [y/N] " reply
    [[ "$reply" == "y" || "$reply" == "Y" ]] || exit 1
  fi
fi

if [[ -d "$CERT_PATH" ]]; then
  echo "==> Certificate for ${DOMAIN} already exists — skipping issuance, just re-rendering the vhost"
else
  if [[ "$CHALLENGE" == "http" ]]; then
    echo "==> Writing a temporary HTTP-only vhost so the ACME challenge can be answered"
    cat > "$VHOST_PATH" <<VHOST
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type "text/plain";
    }

    location / {
        proxy_pass http://127.0.0.1:${APP_HTTP_PORT};
        proxy_set_header Host \$host;
    }
}
VHOST
    ln -sf "$VHOST_PATH" "$VHOST_LINK"
    nginx -t
    systemctl reload nginx

    echo "==> Requesting the certificate from Let's Encrypt (HTTP-01)"
    certbot certonly --webroot -w "$WEBROOT" \
      "${STAGING_FLAG[@]}" \
      --email "${LETSENCRYPT_EMAIL}" \
      -d "${DOMAIN}" \
      --agree-tos --no-eff-email --non-interactive
  else
    echo "==> Requesting the certificate from Let's Encrypt (DNS-01, manual)"
    certbot certonly --manual --preferred-challenges dns \
      "${STAGING_FLAG[@]}" \
      --email "${LETSENCRYPT_EMAIL}" \
      -d "${DOMAIN}" \
      --agree-tos --no-eff-email
  fi
fi

echo "==> Writing the full HTTPS vhost from deploy/nginx/app.conf.template"
DOMAIN="$DOMAIN" APP_HTTP_PORT="$APP_HTTP_PORT" \
  envsubst '${DOMAIN} ${APP_HTTP_PORT}' < deploy/nginx/app.conf.template > "$VHOST_PATH"
ln -sf "$VHOST_PATH" "$VHOST_LINK"

nginx -t
systemctl reload nginx

echo ""
echo "Done: https://${DOMAIN} is now served by the host nginx and proxies to"
echo "127.0.0.1:${APP_HTTP_PORT} (this project's app container)."
echo "Renewal is automatic via certbot's own systemd timer (certbot.timer)."
