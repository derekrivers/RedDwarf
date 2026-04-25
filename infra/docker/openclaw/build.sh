#!/usr/bin/env bash
# Build the RedDwarf OpenClaw toolchain image.
#
# Produces a derived image that adds Ruby/Rails, Python, pnpm/yarn, and
# common build dependencies on top of the upstream OpenClaw gateway image.
# After running this script, set OPENCLAW_IMAGE in your .env to the printed
# tag so docker-compose picks up the toolchain layer.
#
# Usage:
#   infra/docker/openclaw/build.sh                          # uses default base
#   OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:2026.4.23 \
#       infra/docker/openclaw/build.sh
#   TOOLCHAIN_IMAGE_TAG=reddwarf/openclaw-toolchains:dev \
#       infra/docker/openclaw/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENCLAW_BASE_IMAGE="${OPENCLAW_BASE_IMAGE:-ghcr.io/openclaw/openclaw:2026.4.23}"

# Derive a tag from the base image tag so multiple base versions can coexist.
DEFAULT_BASE_TAG="${OPENCLAW_BASE_IMAGE##*:}"
TOOLCHAIN_IMAGE_TAG="${TOOLCHAIN_IMAGE_TAG:-reddwarf/openclaw-toolchains:${DEFAULT_BASE_TAG}}"

echo "Building toolchain image:"
echo "  base = ${OPENCLAW_BASE_IMAGE}"
echo "  tag  = ${TOOLCHAIN_IMAGE_TAG}"
echo

docker build \
    --build-arg "OPENCLAW_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}" \
    --tag "${TOOLCHAIN_IMAGE_TAG}" \
    "${SCRIPT_DIR}"

echo
echo "Built ${TOOLCHAIN_IMAGE_TAG}"
echo
echo "To use it, set in .env:"
echo "  OPENCLAW_IMAGE=${TOOLCHAIN_IMAGE_TAG}"
