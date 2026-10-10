#!/usr/bin/env bash
#
# Builds the app image HERE (your own machine) and packs it into one tarball to
# carry to the server, so a small VPS never has to build anything.
#
# Usage (from the project root):
#   ./scripts/build-images.sh
#   make images-bundle
#
# Options (environment variables):
#   PLATFORM=linux/arm64       target architecture, if the server is not x86-64
#   VERSION=1.2.0              image tag (default: latest)
#   OUT=path/to/file.tar.gz    where to write the bundle
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM="${PLATFORM:-linux/amd64}"
VERSION="${VERSION:-latest}"
OUT="${OUT:-dist/warehouse-image.tar.gz}"
IMAGE="warehouse-app:${VERSION}"
DOCKER="${DOCKER:-docker}"

echo "==> Building ${IMAGE} for ${PLATFORM}"
DOCKER_DEFAULT_PLATFORM="$PLATFORM" "$DOCKER" build \
  -t "$IMAGE" \
  --build-arg "VERSION=${VERSION}" \
  .

echo ""
echo "==> Verifying the image really is ${PLATFORM}"
# A mismatch does not fail the build; it loads fine on the server and then dies
# at startup with a bare "exec format error". Catch it here instead.
want="${PLATFORM%%/*}/${PLATFORM##*/}"
got="$("$DOCKER" image inspect "$IMAGE" --format '{{.Os}}/{{.Architecture}}')"
if [[ "$got" != "$want" ]]; then
  echo "Error: ${IMAGE} is ${got}, but ${PLATFORM} was requested." >&2
  exit 1
fi
echo "    ${IMAGE}: ${got}"

echo ""
echo "==> Packing into ${OUT}"
mkdir -p "$(dirname "$OUT")"
"$DOCKER" save "$IMAGE" | gzip -1 > "$OUT"

size="$(du -h "$OUT" | cut -f1)"
echo ""
echo "================================================================"
echo " Built: ${size}  ->  ${OUT}"
echo "================================================================"
echo ""
echo "Next, copy it to the server and load it there:"
echo ""
echo "  scp ${OUT} USER@YOUR_SERVER:/opt/warehouse/"
echo "  ssh USER@YOUR_SERVER"
echo "  cd /opt/warehouse && ./scripts/load-images.sh"
echo "  ./scripts/bootstrap-vps.sh      # first time only: .env.prod, TLS, start"
echo "  make up-prebuilt                # later updates: just restart on the new image"
