#!/usr/bin/env bash
# Idempotent VPS update driver used by the GitHub Actions deploy workflow
# (.github/workflows/deploy-vps.yml) and also safe to run by hand.
#
# Wraps the steps documented in docs/VPS_OPERATIONS.md §3 so CI can invoke
# them non-interactively. See the workflow for how it is called and which
# secrets must be configured.
#
# Usage:
#   scripts/vps-update.sh [--ref <git-ref>] [--service <systemd-unit>]
#
# Flags:
#   --ref       Git ref to deploy. Defaults to origin/master.
#   --service   systemd unit to restart. Defaults to reddwarf.
#
# Must be run from the repo root. Exits non-zero on any failed step.

set -euo pipefail

REF="origin/master"
SERVICE="reddwarf"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --ref)
      REF="$2"
      shift 2
      ;;
    --service)
      SERVICE="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,18p' "$0"
      exit 0
      ;;
    *)
      echo "error: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if [ ! -d .git ]; then
  echo "error: run from the repo root (no .git directory found in $PWD)" >&2
  exit 2
fi

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
fi

log() {
  printf '\n── %s ──\n' "$*"
}

log "Fetching ${REF}"
git fetch --prune origin

if git rev-parse --verify --quiet "${REF}" >/dev/null; then
  TARGET_SHA="$(git rev-parse "${REF}")"
else
  echo "error: ref '${REF}' not found after fetch" >&2
  exit 1
fi

CURRENT_SHA="$(git rev-parse HEAD)"
log "Current HEAD: ${CURRENT_SHA}"
log "Target SHA:   ${TARGET_SHA}"

if [ "${CURRENT_SHA}" != "${TARGET_SHA}" ]; then
  log "Incoming commits"
  git log --oneline "HEAD..${TARGET_SHA}" || true
fi

# Stay on the local `master` branch so post-deploy manual `git pull` still
# works. A hard reset is safe here: the VPS checkout never hosts local
# commits, and deploys are the only thing that should move HEAD.
log "Checking out master and resetting to ${TARGET_SHA}"
git checkout master
git reset --hard "${TARGET_SHA}"

log "Installing dependencies"
corepack pnpm install

log "Building workspace packages"
corepack pnpm build

log "Building dashboard"
corepack pnpm --filter @reddwarf/dashboard build

log "Fixing dashboard asset permissions for Caddy"
chmod -R o+rX packages/dashboard/dist

log "Restarting ${SERVICE}"
${SUDO} systemctl restart "${SERVICE}"

log "Post-restart status"
${SUDO} systemctl is-active "${SERVICE}" || {
  echo "error: ${SERVICE} is not active after restart" >&2
  ${SUDO} journalctl -u "${SERVICE}" -n 50 --no-pager || true
  exit 1
}

log "Deploy complete — ${SERVICE} active at ${TARGET_SHA}"
