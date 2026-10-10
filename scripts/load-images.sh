#!/usr/bin/env bash
#
# Loads the bundle produced by scripts/build-images.sh. Run this ON THE SERVER
# after copying the tarball across.
#
# Usage (from the project root on the server):
#   ./scripts/load-images.sh [path/to/warehouse-image.tar.gz]
#   make load-images
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION="${VERSION:-latest}"
DOCKER="${DOCKER:-docker}"

BUNDLE="${1:-}"
if [[ -z "$BUNDLE" ]]; then
  for candidate in warehouse-image.tar.gz dist/warehouse-image.tar.gz; do
    if [[ -f "$candidate" ]]; then
      BUNDLE="$candidate"
      break
    fi
  done
fi

if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "Error: image bundle not found." >&2
  echo "Build it on your own machine first:  ./scripts/build-images.sh" >&2
  echo "then copy it here:  scp dist/warehouse-image.tar.gz USER@THIS_SERVER:$(pwd)/" >&2
  exit 1
fi

echo "==> Loading image from ${BUNDLE}"
gunzip -c "$BUNDLE" | "$DOCKER" load

echo ""
echo "==> Checking the image matches this machine's architecture"
host_arch="$("$DOCKER" info --format '{{.Architecture}}' 2>/dev/null || uname -m)"
case "$host_arch" in
  x86_64|amd64)  host_arch=amd64 ;;
  aarch64|arm64) host_arch=arm64 ;;
esac

img="warehouse-app:${VERSION}"
got="$("$DOCKER" image inspect "$img" --format '{{.Architecture}}' 2>/dev/null || echo missing)"
if [[ "$got" == "missing" ]]; then
  echo "Error: ${img} is not present after loading the bundle." >&2
  echo "       If it was built with another VERSION, re-run with VERSION=that-tag" >&2
  exit 1
fi
if [[ "$got" != "$host_arch" ]]; then
  echo "Error: ${img} is ${got}, but this server is ${host_arch} (it would fail with \"exec format error\")." >&2
  echo "       Rebuild with:  PLATFORM=linux/${host_arch} ./scripts/build-images.sh" >&2
  exit 1
fi
echo "    ${img}: ${got} - matches this server"

echo ""
echo "Image loaded. Start (or restart) the stack without building:"
echo "    VERSION=${VERSION} make up-prebuilt"
echo "First-time setup (also creates .env.prod and TLS): ./scripts/bootstrap-vps.sh"
