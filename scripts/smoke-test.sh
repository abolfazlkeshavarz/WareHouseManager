#!/usr/bin/env bash
# End-to-end smoke test against a running instance (dev, local container or a
# deployed server). READ-ONLY: it never creates or changes warehouse data.
#
#   make smoke                                   # against http://127.0.0.1:${HTTP_PORT:-8090}
#   API_URL=https://warehouse.example.com make smoke
#
# Optional, for the authenticated part (use an admin account):
#   SMOKE_USER=mokhtar SMOKE_PASSWORD=... make smoke
#
# Exits non-zero on any failure, so it works as a deploy gate.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/lib.sh"
[[ -f "$ROOT_DIR/.env.prod" ]] && load_env "$ROOT_DIR/.env.prod" 2>/dev/null

API_URL="${API_URL:-http://127.0.0.1:${HTTP_PORT:-8090}}"
API_URL="${API_URL%/}"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
passed=0; failed=0
pass() { echo "  ${GREEN}[PASS]${NC} $1"; passed=$((passed + 1)); }
fail() { echo "  ${RED}[FAIL]${NC} $1"; failed=$((failed + 1)); }
info() { echo "  ${YELLOW}[..]${NC}   $1"; }

JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

# req <method> <path> [json-body] [extra curl args...] -> "<body>\n<status>"
req() {
  local method="$1" path="$2" body="${3:-}"; shift 3 2>/dev/null || shift $#
  local args=(-sS -X "$method" --max-time 20 -b "$JAR" -c "$JAR" -H "x-wh: 1" -w $'\n%{http_code}')
  [[ -n "$body" ]] && args+=(-H "Content-Type: application/json" -d "$body")
  curl "${args[@]}" "$@" "$API_URL$path" 2>/dev/null || echo $'\n000'
}
status_of() { tail -n1 <<<"$1"; }
body_of()   { sed '$d' <<<"$1"; }
expect() { [[ "$2" == "$3" ]] && pass "$1 (HTTP $3)" || fail "$1 — expected HTTP $2, got $3"; }

echo ""
echo "Warehouse app smoke test"
echo "========================"
echo "Target: $API_URL"

# ------------------------------------------------------------ reachability
echo ""
echo "1. Reachability and static files"
r="$(req GET /health)"
if [[ "$(status_of "$r")" != "200" ]]; then
  echo ""
  echo "${RED}Not reachable at $API_URL (HTTP $(status_of "$r")). Start it with: make prod-up (or make run)${NC}"
  exit 1
fi
pass "GET /health -> 200"

html="$(curl -sS --max-time 10 "$API_URL/" 2>/dev/null)"
grep -q 'lang="fa"' <<<"$html" && grep -q 'dir="rtl"' <<<"$html" && pass "app shell is Persian/RTL" || fail "app shell is missing lang=fa dir=rtl"

for f in /manifest.webmanifest /sw.js /css/app.css /js/app.js /vendor/jsQR.js /fonts/Vazirmatn.woff2 /icons/icon-192.png /icons/icon-512.png; do
  c="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$API_URL$f" 2>/dev/null || echo 000)"
  [[ "$c" == "200" ]] && pass "static $f" || fail "static $f -> $c"
done

if curl -sS --max-time 10 "$API_URL/manifest.webmanifest" 2>/dev/null | grep -q '"display": *"standalone"'; then
  pass "manifest is installable (display: standalone)"
else
  fail "manifest.webmanifest is not a standalone PWA manifest"
fi

# ---------------------------------------------------------------- headers
echo ""
echo "2. Security headers"
hdrs="$(curl -sS -D - -o /dev/null --max-time 10 "$API_URL/" 2>/dev/null | tr -d '\r')"
for h in "x-content-type-options: nosniff" "x-frame-options: DENY" "content-security-policy:" "permissions-policy:"; do
  grep -qi "^$h" <<<"$hdrs" && pass "header $h" || fail "missing header $h"
done

# ----------------------------------------------------- authentication / authz
echo ""
echo "3. Authentication boundary (no session)"
for p in /api/items /api/documents /api/summary /api/users /api/export/full /api/settings /api/audit; do
  expect "GET $p requires a session" 401 "$(status_of "$(req GET "$p")")"
done

r="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'Content-Type: application/json' \
  -d '{"username":"x","password":"y"}' "$API_URL/api/auth/login" 2>/dev/null || echo 000)"
expect "login without the CSRF header is refused" 403 "$r"

r="$(req POST /api/auth/login '{"username":"no-such-user","password":"whatever"}')"
expect "unknown user rejected" 401 "$(status_of "$r")"
r2="$(req POST /api/auth/login '{"username":"mokhtar","password":"definitely-wrong-password"}')"
expect "wrong password rejected" 401 "$(status_of "$r2")"
if [[ "$(body_of "$r")" == "$(body_of "$r2")" ]]; then
  pass "login errors do not reveal whether an account exists"
else
  fail "login error message differs between unknown user and wrong password"
fi

# ------------------------------------------------------ authenticated part
echo ""
echo "4. Authenticated checks"
if [[ -z "${SMOKE_USER:-}" || -z "${SMOKE_PASSWORD:-}" ]]; then
  info "SMOKE_USER / SMOKE_PASSWORD not set — skipping (use an admin account for full coverage)"
else
  r="$(req POST /api/auth/login "{\"username\":\"${SMOKE_USER}\",\"password\":\"${SMOKE_PASSWORD}\"}")"
  if [[ "$(status_of "$r")" != "200" ]]; then
    fail "login as ${SMOKE_USER} failed (HTTP $(status_of "$r"))"
  else
    pass "login as ${SMOKE_USER}"
    if grep -q '"must_change_password":true' <<<"$(body_of "$r")"; then
      info "account still has a temporary password — change it in the UI first; skipping the rest"
    else
      role="$(sed -n 's/.*"role":"\([a-z]*\)".*/\1/p' <<<"$(body_of "$r")" | head -1)"

      r="$(req GET /api/meta)"
      expect "meta" 200 "$(status_of "$r")"

      r="$(req GET /api/items)"
      expect "list items" 200 "$(status_of "$r")"
      n="$(grep -o '"qr_token"' <<<"$(body_of "$r")" | wc -l | tr -d ' ')"
      (( n > 0 )) && pass "$n items, each with a QR token" || fail "no items returned"

      first="$(sed -n 's/.*"qr_token":"\([A-Z0-9]*\)".*/\1/p' <<<"$(body_of "$r")" | head -1)"
      if [[ -n "$first" ]]; then
        expect "QR lookup by scanned payload" 200 "$(status_of "$(req GET "/api/items/lookup?code=WH%3A${first}")")"
        c="$(curl -sS -o /dev/null -w '%{http_code}' -b "$JAR" "$API_URL/api/qr/${first}.svg" 2>/dev/null)"
        expect "QR image renders" 200 "$c"
      fi

      expect "summary" 200 "$(status_of "$(req GET /api/summary)")"
      expect "documents list" 200 "$(status_of "$(req GET '/api/documents?limit=5')")"
      expect "movements list" 200 "$(status_of "$(req GET '/api/movements?limit=5')")"
      expect "bad Jalali date is rejected" 400 "$(status_of "$(req GET '/api/movements?from=garbage')")"

      if [[ "$role" == "admin" ]]; then
        expect "admin: users list" 200 "$(status_of "$(req GET /api/users)")"
        expect "admin: audit log" 200 "$(status_of "$(req GET '/api/audit?limit=5')")"

        tmp="$(mktemp)"
        c="$(curl -sS -o "$tmp" -w '%{http_code}' --max-time 60 -b "$JAR" "$API_URL/api/export/full" 2>/dev/null)"
        magic="$(head -c 2 "$tmp")"
        size="$(wc -c < "$tmp" | tr -d ' ')"
        rm -f "$tmp"
        if [[ "$c" == "200" && "$magic" == "PK" && "$size" -gt 4000 ]]; then
          pass "full Excel export is a real .xlsx (${size} bytes)"
        else
          fail "full export looks wrong (HTTP $c, ${size} bytes)"
        fi
      else
        expect "non-admin is blocked from the users API" 403 "$(status_of "$(req GET /api/users)")"
      fi

      req POST /api/auth/logout "{}" >/dev/null
      expect "session is closed after logout" 401 "$(status_of "$(req GET /api/items)")"
    fi
  fi
fi

# ----------------------------------------------------------- rate limiting
echo ""
echo "5. Login rate limiting"
limited=0
for _ in $(seq 1 10); do
  c="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
        -H 'x-wh: 1' -H 'Content-Type: application/json' \
        -d '{"username":"smoke-rate-limit","password":"wrong"}' "$API_URL/api/auth/login" 2>/dev/null || echo 000)"
  [[ "$c" == "429" ]] && { limited=1; break; }
done
[[ "$limited" == "1" ]] && pass "repeated failed logins are rate limited (429)" || fail "10 failed logins were never rate limited"

# ----------------------------------------------------------------- summary
echo ""
echo "========================"
echo "Passed: ${GREEN}${passed}${NC}   Failed: ${RED}${failed}${NC}"
if (( failed > 0 )); then
  echo "${RED}Smoke test FAILED${NC}"
  exit 1
fi
echo "${GREEN}Smoke test PASSED${NC}"
