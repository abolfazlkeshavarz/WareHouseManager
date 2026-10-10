#!/usr/bin/env bash
#
# Restores a backup made by backup-prod.sh into the production volume.
# STOPS the app, replaces the database, starts it again. The current database
# is first saved next to the volume's data as warehouse.db.before-restore.
#
# Usage:   make restore FILE=backups/warehouse-20261010-0230.db
set -euo pipefail

cd "$(dirname "$0")/.."

DOCKER="${DOCKER:-docker}"
FILE="${1:-${FILE:-}}"

[[ -n "$FILE" && -f "$FILE" ]] || { echo "Usage: make restore FILE=backups/warehouse-YYYYMMDD-HHMM.db" >&2; exit 1; }

# sanity check: must be a SQLite file
head -c 15 "$FILE" | grep -q "SQLite format 3" || { echo "Error: ${FILE} is not a SQLite database." >&2; exit 1; }

read -r -p "Replace the production database with ${FILE}? Type 'yes': " reply
[[ "$reply" == "yes" ]] || { echo "Cancelled."; exit 1; }

echo "==> Stopping the app"
make prod-down

abs="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
echo "==> Restoring"
MSYS_NO_PATHCONV=1 "$DOCKER" run --rm \
  -v warehouse-data:/data \
  -v "${abs}:/restore/backup.db:ro" \
  alpine sh -c '
    set -e
    [ -f /data/warehouse.db ] && cp /data/warehouse.db /data/warehouse.db.before-restore
    rm -f /data/warehouse.db-wal /data/warehouse.db-shm
    cp /restore/backup.db /data/warehouse.db
    chown 1000:1000 /data/warehouse.db
  '

echo "==> Starting the app"
make up-prebuilt
echo "Restored from ${FILE}."
