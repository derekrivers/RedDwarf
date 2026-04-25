#!/usr/bin/env bash
# Build the RedDwarf OpenClaw toolchain image.
#
# Produces a derived image that adds the universal build chain, common DB /
# cache clients, and `mise` (polyglot runtime version manager) on top of
# the upstream OpenClaw gateway image. The image is stack-agnostic — it
# does not bake in Ruby / Node / Python / Go specifically. Projects pin
# runtimes via `.tool-versions` or `mise.toml`; the agent runs
# `mise install` once per stack and the result is cached on the named
# volumes mounted by docker-compose.
#
# Usage:
#   infra/docker/openclaw/build.sh                          # uses default base
#   OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:2026.4.23 \
#       infra/docker/openclaw/build.sh
#   MISE_VERSION=v2025.7.0 infra/docker/openclaw/build.sh   # pin mise
#   TOOLCHAIN_IMAGE_TAG=reddwarf/openclaw-toolchains:dev \
#       infra/docker/openclaw/build.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

OPENCLAW_BASE_IMAGE="${OPENCLAW_BASE_IMAGE:-ghcr.io/openclaw/openclaw:2026.4.23}"
MISE_VERSION="${MISE_VERSION:-}"

# Derive a tag from the base image tag so multiple base versions can coexist.
DEFAULT_BASE_TAG="${OPENCLAW_BASE_IMAGE##*:}"
TOOLCHAIN_IMAGE_TAG="${TOOLCHAIN_IMAGE_TAG:-reddwarf/openclaw-toolchains:${DEFAULT_BASE_TAG}}"

echo "Building toolchain image:"
echo "  base         = ${OPENCLAW_BASE_IMAGE}"
echo "  mise version = ${MISE_VERSION:-(latest)}"
echo "  tag          = ${TOOLCHAIN_IMAGE_TAG}"
echo

BUILD_ARGS=(
    --build-arg "OPENCLAW_BASE_IMAGE=${OPENCLAW_BASE_IMAGE}"
)
if [ -n "${MISE_VERSION}" ]; then
    BUILD_ARGS+=(--build-arg "MISE_VERSION=${MISE_VERSION}")
fi

docker build \
    "${BUILD_ARGS[@]}" \
    --tag "${TOOLCHAIN_IMAGE_TAG}" \
    "${SCRIPT_DIR}"

echo
echo "Built ${TOOLCHAIN_IMAGE_TAG}"
echo
echo "To use it, set in .env:"
echo "  OPENCLAW_IMAGE=${TOOLCHAIN_IMAGE_TAG}"
