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
#   deploy/deploy.sh                   # dry run, then prompt, then transfer
#   deploy/deploy.sh -y                # skip the confirmation prompt
#   deploy/deploy.sh --no-delete       # upload/update only, never remove server files
#   deploy/deploy.sh --skip-icloud-check  # bypass the iCloud-placeholder pre-check
#   deploy/deploy.sh --help
#
# iCloud pre-check: this project lives in iCloud Drive. If "Optimize Mac
# Storage" has evicted any file to a dataless placeholder stub, rsync will
# either stall forcing a download or silently skip it. Before transferring,
# the script scans for dataless files (BSD `find -flags +dataless`) and
# aborts if any are found, with instructions to materialize them first.
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
SKIP_ICLOUD_CHECK=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes)             ASSUME_YES=1 ;;
    --no-delete)          DELETE="" ;;
    --skip-icloud-check)  SKIP_ICLOUD_CHECK=1 ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//; s/^#//'
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

# ── iCloud-placeholder pre-check ──────────────────────────────────────
# This project lives in iCloud Drive. With "Optimize Mac Storage" enabled,
# macOS can evict files to dataless stubs (zero physical bytes, full logical
# size). rsync will either stall forcing a download or skip them — either
# way the deploy is unreliable. BSD `find -flags +dataless` lists any such
# files in the tree. We abort if found, with a clear remediation.
#
# We scan the project root with the same exclude shape as rsync's transfer
# (skip .git, library/, deploy/, site/{accounts,sessions,cache}, media/) so
# server-owned state or local-only backups don't trigger false positives.
if [ "$SKIP_ICLOUD_CHECK" -ne 1 ]; then
  echo "▶ Scanning for iCloud placeholder stubs …"
  dataless_files=$(
    find "$PROJECT_ROOT" \
      \( -path "$PROJECT_ROOT/.git" \
         -o -path "$PROJECT_ROOT/library" \
         -o -path "$PROJECT_ROOT/deploy" \
         -o -path "$PROJECT_ROOT/site/accounts" \
         -o -path "$PROJECT_ROOT/site/sessions" \
         -o -path "$PROJECT_ROOT/site/cache" \
         -o -path "$PROJECT_ROOT/media" \
      \) -prune -o \
      -type f -flags +dataless -print 2>/dev/null | head -20
  )
  if [ -n "$dataless_files" ]; then
    echo "✗ Found iCloud placeholder stubs (dataless flag set):" >&2
    echo "$dataless_files" | sed 's|^|    |' >&2
    echo >&2
    echo "  These files exist as stubs but their contents aren't on disk." >&2
    echo "  rsync would stall or skip them, producing an unreliable deploy." >&2
    echo >&2
    echo "  Fix options:" >&2
    echo "  - In Finder: right-click the project folder → Download Now," >&2
    echo "    then re-run deploy/deploy.sh." >&2
    echo "  - Materialize the whole tree from the CLI:" >&2
    echo "      find \"$PROJECT_ROOT\" -type f -flags +dataless -exec brctl download {} \\;" >&2
    echo "  - System Settings → Apple Account → iCloud → iCloud Drive →" >&2
    echo "    turn OFF \"Optimize Mac Storage\" for this Mac (recommended" >&2
    echo "    if you deploy from here regularly)." >&2
    echo >&2
    echo "  Or bypass with --skip-icloud-check (not recommended)." >&2
    exit 1
  fi
  echo "  ✓ No placeholder stubs found."
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
