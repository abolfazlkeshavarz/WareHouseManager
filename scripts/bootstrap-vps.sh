#!/usr/bin/env bash
#
# Zero-to-deployed setup on a brand-new Ubuntu/Debian server: installs Docker,
# creates .env.prod, brings the container up and configures this server's
# nginx + an SSL certificate — all in one run.
#
# The app runs fine alongside OTHER projects on the same server, each on its
# own (sub)domain: only this project's container is installed, and the TLS
# step reuses the host's single nginx + certbot (see deploy-host-nginx.sh).
#
# Usage (from the project root, after copying/cloning it to the server):
#   ./scripts/bootstrap-vps.sh
#
# Non-interactive:
#   DOMAIN=warehouse.example.com LETSENCRYPT_EMAIL=you@example.com ./scripts/bootstrap-vps.sh
#
# Other options:
#   APP_HTTP_PORT=8091   local port (default: first free one from 8090)
#   LAN_ONLY=1           no domain / no TLS: serve plain http on the LAN
#                        (the phone camera will NOT work without https)
#   VERSION=1.0.0        image tag
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
source scripts/lib.sh

# ------------------------------------------------------------- elevate to root
if [[ "$(id -u)" != "0" ]]; then
  echo "==> Root access is required to install Docker; re-running with sudo"
  exec sudo -E bash "$0" "$@"
fi

REAL_USER="${SUDO_USER:-root}"

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This script is written only for Ubuntu/Debian (apt)." >&2
  exit 1
fi

# --------------------------------------------------------- base packages
echo "==> Installing base packages"
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg make openssl

# --------------------------------------------------------------- Docker Engine
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker Engine"
  install -m 0755 -d /etc/apt/keyrings
  # shellcheck disable=SC1091
  . /etc/os-release
  distro="${ID}"; [[ "$distro" == "debian" || "$distro" == "ubuntu" ]] || distro=ubuntu
  curl -fsSL "https://download.docker.com/linux/${distro}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${distro} ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "==> Docker is already installed"
fi

if [[ "$REAL_USER" != "root" ]] && ! id -nG "$REAL_USER" | grep -qw docker; then
  echo "==> Adding user $REAL_USER to the docker group (log out/in to use docker without sudo)"
  usermod -aG docker "$REAL_USER"
fi

# --------------------------------------------------------------- domain / mode
LAN_ONLY="${LAN_ONLY:-0}"
if [[ "$LAN_ONLY" != "1" ]]; then
  if [[ -z "${DOMAIN:-}" ]]; then
    read -r -p "Domain whose A record points to this server (empty = LAN-only, no https): " DOMAIN
  fi
  if [[ -z "${DOMAIN:-}" ]]; then
    LAN_ONLY=1
  elif [[ -z "${LETSENCRYPT_EMAIL:-}" ]]; then
    read -r -p "Email for Let's Encrypt expiry warnings: " LETSENCRYPT_EMAIL
  fi
fi
if [[ "$LAN_ONLY" != "1" ]]; then
  : "${DOMAIN:?DOMAIN is required}"
  : "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL is required}"
fi

if [[ -z "${APP_HTTP_PORT:-}" ]]; then
  APP_HTTP_PORT="$(find_free_port 8090)"
  if [[ "$LAN_ONLY" != "1" && ( -d /etc/nginx || -x /usr/sbin/nginx ) ]]; then
    echo ""
    echo "nginx is already on this server (another project is likely deployed here)."
    echo "This app will publish its local port on 127.0.0.1:${APP_HTTP_PORT} (auto-picked as free)."
    read -r -p "Local port for this app [${APP_HTTP_PORT}]: " reply
    APP_HTTP_PORT="${reply:-$APP_HTTP_PORT}"
  fi
fi

# ------------------------------------------------------------------- .env.prod
echo "==> Creating .env.prod"
if [[ ! -f .env.prod ]]; then
  cp .env.prod.example .env.prod
  sed -i -e "s|^HTTP_PORT=.*|HTTP_PORT=${APP_HTTP_PORT}|" .env.prod
  if [[ "$LAN_ONLY" == "1" ]]; then
    sed -i -e "s|^HTTP_BIND=.*|HTTP_BIND=0.0.0.0|" -e "s|^TRUST_PROXY=.*|TRUST_PROXY=0|" .env.prod
  else
    sed -i -e "s|^APP_DOMAIN=.*|APP_DOMAIN=${DOMAIN}|" \
           -e "s|^LETSENCRYPT_EMAIL=.*|LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL}|" .env.prod
  fi
  [[ -n "${VERSION:-}" ]] && sed -i -e "s|^VERSION=.*|VERSION=${VERSION}|" .env.prod
else
  echo "    .env.prod already exists — leaving it as is."
fi

if [[ "$REAL_USER" != "root" ]]; then
  chown "$REAL_USER":"$REAL_USER" .env.prod
fi
chmod 600 .env.prod
load_env .env.prod
VERSION="${VERSION:-latest}"

# --------------------------------------------------------------- image
if docker image inspect "warehouse-app:${VERSION}" >/dev/null 2>&1; then
  echo "==> Prebuilt image warehouse-app:${VERSION} found; skipping the build"
else
  echo "==> Building the image (takes a minute or two; or build elsewhere with"
  echo "    ./scripts/build-images.sh and load it with ./scripts/load-images.sh)"
  make prod-build
fi

# ----------------------------------------------------------------- bring up
echo "==> Starting the app"
make up-prebuilt

echo "==> Waiting for it to become healthy"
if ! wait_for_http "http://127.0.0.1:${HTTP_PORT}/health" 90; then
  echo "The app did not answer on 127.0.0.1:${HTTP_PORT}/health. Check:  make prod-logs" >&2
  exit 1
fi

if [[ "$LAN_ONLY" != "1" ]]; then
  echo "==> Obtaining SSL certificate and configuring host nginx"
  make ssl
fi

echo ""
echo "================================================================"
if [[ "$LAN_ONLY" == "1" ]]; then
  echo " Up (LAN only, plain http) at  http://<this-server-ip>:${HTTP_PORT}"
  echo " NOTE: browsers only allow the phone camera over https. Put the app"
  echo " behind a domain + certificate (re-run with DOMAIN=...) to scan QR codes."
else
  echo " Up at  https://${APP_DOMAIN}"
fi
echo "================================================================"
echo ""
echo "First-run accounts (shown once; each must change its password at first login):"
echo ""
docker exec warehouse-app cat /data/FIRST-RUN-PASSWORDS.txt 2>/dev/null \
  || echo "  (already created earlier — to set a new one:  make prod-shell CMD='reset-password mokhtar')"
echo ""
echo "After you have noted them, remove the file:  make prod-clear-credentials"
echo "Check the deployment:   make deploy-health HOST=${APP_DOMAIN:+https://}${APP_DOMAIN:-http://localhost:${HTTP_PORT}}"
echo "Nightly backup:         make backup   (see README for the cron line)"
