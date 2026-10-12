#!/usr/bin/env bash
# Health check for the warehouse app.
#
#   bash scripts/health.sh                                # local/production container on this machine
#   API_URL=https://warehouse.example.com REMOTE=1 bash scripts/health.sh   # only the public side
#
# Exits non-zero if anything required is down, so it works as a post-deploy gate.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib.sh"
[[ -f "$ROOT_DIR/.env.prod" ]] && load_env "$ROOT_DIR/.env.prod" 2>/dev/null

API_URL="${API_URL:-http://127.0.0.1:${HTTP_PORT:-8090}}"
REMOTE="${REMOTE:-}"
CONTAINER="${CONTAINER:-warehouse-app}"
DOCKER="${DOCKER:-docker}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
failures=0; warnings=0
ok()   { echo "  ${GREEN}[OK]${NC}   $1"; }
bad()  { echo "  ${RED}[FAIL]${NC} $1"; failures=$((failures + 1)); }
warn() { echo "  ${YELLOW}[WARN]${NC} $1"; warnings=$((warnings + 1)); }

code_of() { local c; c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null)"; echo "${c:-000}"; }

echo ""
echo "Warehouse app health check"
echo "=========================="

if [[ -z "$REMOTE" ]]; then
  echo ""
  echo "Container"
  if ! command -v "$DOCKER" >/dev/null 2>&1; then
    warn "docker not found; skipping container checks"
  else
    state="$("$DOCKER" inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    health="$("$DOCKER" inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null || echo none)"
    if [[ "$state" == "running" && ( "$health" == "healthy" || "$health" == "none" ) ]]; then
      ok "$CONTAINER ($state, health: $health)"
    elif [[ "$state" == "running" ]]; then
      warn "$CONTAINER running but health=$health"
    else
      bad "$CONTAINER is $state (try: make prod-up)"
    fi

    if [[ "$state" == "running" ]]; then
      stats="$("$DOCKER" exec "$CONTAINER" node scripts/cli.js stats 2>/dev/null || true)"
      if [[ -n "$stats" ]]; then
        ok "database readable: $(echo "$stats" | tr '\n' ' ' | sed 's/  */ /g')"
      else
        bad "could not read the database inside the container"
      fi
    fi
  fi
fi

echo ""
echo "HTTP ($API_URL)"
c="$(code_of "$API_URL/health")"
[[ "$c" == "200" ]] && ok "GET /health -> 200" || bad "GET /health -> $c"

# automatic backup: the newest copy should be less than two days old
last_backup="$(curl -s --max-time 10 "$API_URL/health" 2>/dev/null | sed -n 's/.*"last_backup_at":"\([^"]*\)".*/\1/p')"
if [[ -z "$last_backup" ]]; then
  warn "no backup yet (the app makes one every day; or run: make backup)"
else
  age_h=$(( ( $(date -u +%s) - $(date -u -d "$last_backup" +%s 2>/dev/null || echo 0) ) / 3600 ))
  if (( age_h > 48 )); then warn "newest backup is ${age_h}h old ($last_backup)"; else ok "newest backup: $last_backup (${age_h}h ago)"; fi
fi

c="$(code_of "$API_URL/")"
[[ "$c" == "200" ]] && ok "GET / -> 200 (app shell)" || bad "GET / -> $c"

c="$(code_of "$API_URL/manifest.webmanifest")"
[[ "$c" == "200" ]] && ok "PWA manifest served" || bad "manifest -> $c"

c="$(code_of "$API_URL/api/items")"
[[ "$c" == "401" ]] && ok "GET /api/items without a session -> 401" || bad "GET /api/items without a session -> $c (expected 401)"

if [[ "$API_URL" == https://* ]]; then
  ok "served over https (phone camera allowed)"
else
  case "$API_URL" in
    http://127.0.0.1*|http://localhost*) ;;
    *) warn "not https — browsers will block the phone camera on this address" ;;
  esac
fi

echo ""
echo "=========================="
if (( failures > 0 )); then
  echo "${RED}${failures} failed${NC}, ${warnings} warning(s)"
  exit 1
fi
echo "${GREEN}All required checks passed${NC}, ${warnings} warning(s)"
