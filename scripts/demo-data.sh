#!/usr/bin/env bash
#
# Populates a running instance with demo data over its public API.
# Run it on YOUR OWN machine (needs Node 22+); it talks to the server over
# HTTPS exactly like a browser. Refuses to run on a warehouse that already has
# documents unless FORCE=1.
#
# Required:
#   ADMIN_USER, ADMIN_PASSWORD     an admin that already changed its temporary password
# Optional:
#   API_URL                        default http://127.0.0.1:8090
#   KEEPER_USER, KEEPER_PASSWORD   storekeeper — adds pending requests to approve
#
# Example:
#   API_URL=https://warehouse.example.com ADMIN_USER=mokhtar ADMIN_PASSWORD=... \
#   KEEPER_USER=anbardar KEEPER_PASSWORD=... ./scripts/demo-data.sh
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null 2>&1 || {
  echo "Error: node not found on PATH (Node 22+ is needed to run this script from your machine)." >&2
  exit 1
}

: "${ADMIN_USER:?ADMIN_USER is required}"
: "${ADMIN_PASSWORD:?ADMIN_PASSWORD is required}"

exec node scripts/demo-data.mjs
