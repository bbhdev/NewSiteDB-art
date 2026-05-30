#!/usr/bin/env bash
#
# deploy.sh — push the local NewSiteDB-art tree to the production server.
#
# Strategy: rsync over SSH, delta transfer, full mirror (--delete) guarded
# by deploy/deploy-exclude.txt so server-owned runtime state (accounts,
# sessions, cache, media) is never uploaded or deleted.
#
# Safety: ALWAYS runs a dry run first and shows exactly what would change,
# then asks for confirmation before the real transfer.
#
# Usage:
#   deploy/deploy.sh             # dry run, then prompt, then transfer
#   deploy/deploy.sh -y          # skip the confirmation prompt
#   deploy/deploy.sh --no-delete # upload/update only, never remove server files
#   deploy/deploy.sh --help
#
# One-time setup: create deploy/deploy.env (gitignored) exporting the
# target, e.g.
#   REMOTE_HOST="bondard"            # an alias from ~/.ssh/config
#   REMOTE_PATH="/var/www/bondard.net"

set -euo pipefail

# ── Defaults (override via env or deploy/deploy.env) ──────────────────
REMOTE_HOST="${REMOTE_HOST:-user@your-server.example}"
REMOTE_PATH="${REMOTE_PATH:-/var/www/bondard.net}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
[ -f "$SCRIPT_DIR/deploy.env" ] && . "$SCRIPT_DIR/deploy.env"
EXCLUDE_FILE="$SCRIPT_DIR/deploy-exclude.txt"

# ── Flags ─────────────────────────────────────────────────────────────
ASSUME_YES=0
DELETE="--delete"
for arg in "$@"; do
  case "$arg" in
    -y|--yes)    ASSUME_YES=1 ;;
    --no-delete) DELETE="" ;;
    -h|--help)
      sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//; s/^#//'
      exit 0 ;;
    *) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

command -v rsync >/dev/null || { echo "✗ rsync not found in PATH" >&2; exit 1; }
[ -f "$EXCLUDE_FILE" ] || { echo "✗ Missing exclude file: $EXCLUDE_FILE" >&2; exit 1; }
if [ "$REMOTE_HOST" = "user@your-server.example" ]; then
  echo "✗ REMOTE_HOST is still the placeholder." >&2
  echo "  Create deploy/deploy.env from deploy/deploy.env.example first." >&2
  exit 1
fi

# ── rsync flags ───────────────────────────────────────────────────────
#  -a  archive (recurse, symlinks, times, perms)
#  -z  compress over the wire
#  -h  human-readable sizes
#  -i  itemize each change (so the dry run is readable)
#  --delete-after + --delay-updates: stage updates and apply deletions at
#     the very end, shrinking the window where the live tree is mid-update.
#  --no-owner --no-group: shared hosting usually forbids chown-by-id.
#     Remove these if the deploy user owns the tree and you want exact perms.
COMMON=(
  -az -h -i
  $DELETE --delete-after --delay-updates
  --exclude-from="$EXCLUDE_FILE"
  --no-owner --no-group
)

SRC="$PROJECT_ROOT/"
DEST="$REMOTE_HOST:$REMOTE_PATH/"

echo "▶ DRY RUN   $SRC"
echo "        →   $DEST   (mirror=${DELETE:-off})"
echo "─────────────────────────────────────────────────────────────────"
rsync "${COMMON[@]}" --dry-run "$SRC" "$DEST"
echo "─────────────────────────────────────────────────────────────────"

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Proceed with the REAL transfer shown above? [y/N] '
  read -r reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Aborted — nothing was changed on the server."; exit 0 ;;
  esac
fi

echo "▶ DEPLOYING …"
rsync "${COMMON[@]}" "$SRC" "$DEST"
echo "✓ Deploy complete."
