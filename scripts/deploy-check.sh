#!/usr/bin/env bash
# Pre-flight checks to run before deploying to a server.
#
#   make deploy-check
#
# Catches the mistakes that are cheap to find here and expensive in production:
# committed secrets/data, missing files, a broken compose file, failing tests.
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[1;33m'; NC=$'\033[0m'
errors=0; warnings=0
ok()   { echo "  ${GREEN}[OK]${NC}    $1"; }
bad()  { echo "  ${RED}[BLOCK]${NC} $1"; errors=$((errors + 1)); }
warn() { echo "  ${YELLOW}[WARN]${NC}  $1"; warnings=$((warnings + 1)); }

DOCKER="${DOCKER:-docker}"

echo ""
echo "Warehouse app deploy pre-flight"
echo "==============================="

# ------------------------------------------------------------------- files
echo ""
echo "1. Required files"
for f in Dockerfile docker-compose.prod.yml .env.prod.example package.json package-lock.json \
         server/index.js server/seed/parts.json public/index.html public/manifest.webmanifest \
         public/sw.js public/vendor/jsQR.js public/fonts/Vazirmatn.woff2 public/icons/icon-512.png \
         deploy/nginx/app.conf.template; do
  [[ -f "$f" ]] && ok "$f" || bad "$f is missing"
done

# ----------------------------------------------------------------- secrets
echo ""
echo "2. Secrets and data"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  for f in .env.prod data/warehouse.db data/FIRST-RUN-PASSWORDS.txt; do
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      bad "$f is tracked by git (git rm --cached $f)"
    fi
  done
  ok "no secrets/data tracked by git"
  n="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$n" != "0" ]] && warn "$n uncommitted change(s) — the image is built from the working tree"
else
  info() { :; }
  warn "not a git repository — skipped tracked-file checks"
fi

if [[ -f data/FIRST-RUN-PASSWORDS.txt ]]; then
  warn "data/FIRST-RUN-PASSWORDS.txt exists locally (never copy data/ to the server)"
fi

if [[ -f .env.prod ]]; then
  if grep -q '^APP_DOMAIN=warehouse.example.com' .env.prod; then
    warn ".env.prod still has the example domain"
  else
    ok ".env.prod has a real domain"
  fi
  [[ "$(stat -c '%a' .env.prod 2>/dev/null)" =~ ^[0-7]00$ ]] || warn ".env.prod permissions are loose (chmod 600 .env.prod)"
else
  warn ".env.prod not present here (bootstrap-vps.sh creates it on the server)"
fi

# ------------------------------------------------------------------- build
echo ""
echo "3. Code"
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if (( major > 22 || (major == 22 && minor >= 13) )); then
    ok "node $(node -v) (>= 22.13, has built-in SQLite)"
  else
    bad "node $(node -v) is too old; need >= 22.13"
  fi

  if [[ -d node_modules ]]; then
    if npm test --silent >/dev/null 2>&1; then
      ok "automated tests pass"
    else
      bad "automated tests FAIL (run: npm test)"
    fi
  else
    warn "node_modules missing — run npm install to run the tests"
  fi
else
  warn "node not found locally; skipped tests (the image itself ships Node)"
fi

# ------------------------------------------------------------------ docker
echo ""
echo "4. Docker"
if command -v "$DOCKER" >/dev/null 2>&1 && "$DOCKER" info >/dev/null 2>&1; then
  ok "docker daemon reachable"
  envfile=".env.prod"; [[ -f "$envfile" ]] || envfile=".env.prod.example"
  if "$DOCKER" compose -f docker-compose.prod.yml --env-file "$envfile" config -q >/dev/null 2>&1; then
    ok "docker-compose.prod.yml is valid ($envfile)"
  else
    bad "docker compose config fails for docker-compose.prod.yml"
  fi
  if "$DOCKER" image inspect "warehouse-app:${VERSION:-latest}" >/dev/null 2>&1; then
    ok "image warehouse-app:${VERSION:-latest} exists locally"
  else
    warn "image not built yet (make images)"
  fi
else
  warn "docker not available here — skipped (the server needs it; bootstrap installs it)"
fi

echo ""
echo "==============================="
if (( errors > 0 )); then
  echo "${RED}${errors} blocker(s)${NC}, ${warnings} warning(s) — do not deploy yet"
  exit 1
fi
echo "${GREEN}No blockers${NC}, ${warnings} warning(s)"
echo ""
echo "Next:"
echo "  server with enough RAM:   copy the project, then  DOMAIN=... LETSENCRYPT_EMAIL=... ./scripts/bootstrap-vps.sh"
echo "  small server:             ./scripts/build-images.sh  here, scp dist/warehouse-image.tar.gz,"
echo "                            then on the server ./scripts/load-images.sh && ./scripts/bootstrap-vps.sh"
