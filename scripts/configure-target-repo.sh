#!/usr/bin/env bash
# Configure a target repo with the secret + variable that
# .github/workflows/reddwarf-advance.yml needs to advance the project
# ticket queue after every PR merge.
#
# Without this, reddwarf-advance.yml installs cleanly and looks healthy,
# but exits 1 on every PR merge because of its own pre-condition guard
# — and the operator-API never receives the /projects/advance callback,
# so the ticket queue silently stops advancing.
#
# The pre-flight check in executeProjectApproval (M25 commit 966f4f5)
# logs a clear warning naming this script. The script reads the
# operator token + API URL from the local .env and pushes them to the
# target repo as an Actions secret + variable.
#
# Usage:
#   ./scripts/configure-target-repo.sh <owner>/<repo>
#
# Optional env overrides (otherwise read from .env):
#   REDDWARF_OPERATOR_TOKEN — bearer token the workflow sends to /projects/advance
#   REDDWARF_PUBLIC_API_URL — public URL where GitHub Actions can reach the
#                              operator API (e.g. https://reddwarf.example.com).
#                              Falls back to REDDWARF_API_URL from .env, but
#                              that's typically a 127.0.0.1 loopback URL which
#                              GitHub runners can't reach — so override or set
#                              REDDWARF_DASHBOARD_ORIGIN to the public host
#                              that fronts the operator API.
#
# Requires:
#   - gh (GitHub CLI), authenticated against an account with admin perms on
#     the target repo. `gh auth status` should print "Logged in to github.com".
#
# Idempotent: GitHub's Actions API replaces existing secrets/variables on
# re-set, so re-running the script after rotating the token Just Works.

set -euo pipefail

if [ "$#" -ne 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  sed -n '2,32p' "$0"
  exit 2
fi

REPO="$1"

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh (GitHub CLI) is not installed. Install with 'sudo apt install gh' or see https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "error: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# Locate .env relative to this script (lives in scripts/, .env is at repo root).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"

if [ -f "$ENV_FILE" ]; then
  # Pull values from .env without polluting the shell with everything in it.
  # Strips quotes around values.
  read_env() {
    local key="$1"
    grep -E "^${key}=" "$ENV_FILE" 2>/dev/null \
      | tail -1 \
      | sed -E "s/^${key}=//; s/^['\"]//; s/['\"]$//"
  }
  TOKEN="${REDDWARF_OPERATOR_TOKEN:-$(read_env REDDWARF_OPERATOR_TOKEN)}"
  API_URL="${REDDWARF_PUBLIC_API_URL:-$(read_env REDDWARF_PUBLIC_API_URL)}"
  if [ -z "$API_URL" ]; then
    # Fall back to REDDWARF_DASHBOARD_ORIGIN — usually the public host fronting
    # both the dashboard and the operator API behind Caddy.
    API_URL="$(read_env REDDWARF_DASHBOARD_ORIGIN)"
  fi
  if [ -z "$API_URL" ]; then
    API_URL="$(read_env REDDWARF_API_URL)"
  fi
else
  TOKEN="${REDDWARF_OPERATOR_TOKEN:-}"
  API_URL="${REDDWARF_PUBLIC_API_URL:-${REDDWARF_API_URL:-}}"
fi

if [ -z "$TOKEN" ]; then
  echo "error: REDDWARF_OPERATOR_TOKEN not found in env or $ENV_FILE" >&2
  exit 1
fi

if [ -z "$API_URL" ]; then
  echo "error: no operator API URL found. Set REDDWARF_PUBLIC_API_URL in your environment, or REDDWARF_DASHBOARD_ORIGIN / REDDWARF_API_URL in $ENV_FILE" >&2
  exit 1
fi

# Sanity check the URL — GitHub runners can't reach 127.0.0.1 / localhost / docker hostnames.
case "$API_URL" in
  *127.0.0.1*|*localhost*|*://host.docker.internal*|*://postgres:*)
    echo "warning: REDDWARF_PUBLIC_API_URL='$API_URL' looks like a loopback / internal address." >&2
    echo "         GitHub Actions runners cannot reach loopback URLs." >&2
    echo "         Override with REDDWARF_PUBLIC_API_URL=https://<your-public-domain> and re-run." >&2
    exit 1
    ;;
esac

echo "Setting REDDWARF_OPERATOR_TOKEN secret on $REPO ..."
printf '%s' "$TOKEN" | gh secret set REDDWARF_OPERATOR_TOKEN \
  --repo "$REPO" \
  --body -

echo "Setting REDDWARF_OPERATOR_API_URL variable on $REPO to $API_URL ..."
gh variable set REDDWARF_OPERATOR_API_URL \
  --repo "$REPO" \
  --body "$API_URL"

echo
echo "Done. Verify with: gh secret list --repo $REPO ; gh variable list --repo $REPO"
echo "If reddwarf-advance.yml was failing on this repo, re-trigger the most recent failed run from the Actions tab and the queue should resume."
