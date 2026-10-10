#!/usr/bin/env bash
#
# Consistent online backup of the production database (safe while the app is
# running): creates a SQLite snapshot inside the container, copies it to
# ./backups on the host, keeps the newest KEEP (default 30).
#
# Usage:   make backup        or      ./scripts/backup-prod.sh
# Cron (nightly, 02:30):
#   30 2 * * * cd /opt/warehouse && ./scripts/backup-prod.sh >> backups/backup.log 2>&1
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-docker}"
CONTAINER="${CONTAINER:-warehouse-app}"
DEST="${DEST:-backups}"
KEEP="${KEEP:-30}"

mkdir -p "$DEST"

if ! "$DOCKER" inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "Error: container ${CONTAINER} is not running (make prod-up)." >&2
  exit 1
fi

out="$(MSYS_NO_PATHCONV=1 "$DOCKER" exec "$CONTAINER" node scripts/backup.js /data/backups)"
echo "$out"
file="$(basename "$(echo "$out" | sed -n 's/^Backup written: //p' | tr -d '\r')")"
[[ -n "$file" ]] || { echo "Could not determine the backup file name." >&2; exit 1; }

MSYS_NO_PATHCONV=1 "$DOCKER" cp "${CONTAINER}:/data/backups/${file}" "${DEST}/${file}"
echo "Copied to ${DEST}/${file} ($(du -h "${DEST}/${file}" | cut -f1))"

# prune old copies on the host
ls -1t "${DEST}"/warehouse-*.db 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
