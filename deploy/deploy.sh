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
#   deploy/deploy.sh [<target>] [flags]
#
#   <target>                          # one of the names listed in deploy.env's
#                                     # TARGETS (e.g. newsitedbart.bbh.fr).
#                                     # Omit to use DEFAULT_TARGET.
#   -y, --yes                         # skip the confirmation prompt
#   --no-delete                       # upload/update only, never remove server files
#   --bootstrap                       # ONE-TIME: also push editor-written content
#                                     # data (drawings, layouts, images, …) that
#                                     # normal deploys leave alone. Use only when
#                                     # seeding a freshly-deployed server. After
#                                     # this, the content-sync layer owns those
#                                     # files. Confirms TWICE before transferring.
#   --host-config                     # ONLY push site/config/config.<target>.php
#                                     # (rsync-excluded from the normal mirror),
#                                     # then curl-verify the /dev/draw 403 gate.
#                                     # Mutually exclusive with the main deploy.
#   --skip-icloud-check               # bypass the iCloud-placeholder pre-check
#   -h, --help
#
# Two-layer sync model:
#   Layer 1 (this script, no --bootstrap):  code only — L → A, L → B.
#   Layer 2 (separate tool, TBD):           content bidirectional A↔B + L↔A/B,
#                                           per-page _sync stamps in page.json.
#   Bootstrap is the one-time bridge between them.
#
# Target naming convention: target name == site's SERVER_NAME (the domain
# browsers hit). This keeps the CLI arg, the resolve_target branch in
# deploy.env, and the host-scoped config filename
# site/config/config.<SERVER_NAME>.php in lockstep.
#
# iCloud pre-check: this project lives in iCloud Drive. If "Optimize Mac
# Storage" has evicted any file to a dataless placeholder stub, rsync will
# either stall forcing a download or silently skip it. Before transferring,
# the script scans for dataless files (BSD `find -flags +dataless`) and
# aborts if any are found, with instructions to materialize them first.
#
# One-time setup: create deploy/deploy.env (gitignored) from
# deploy/deploy.env.example, defining TARGETS, DEFAULT_TARGET, and a
# resolve_target() case branch per target.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXCLUDE_FILE="$SCRIPT_DIR/deploy-exclude.txt"
EXCLUDE_CONTENT_FILE="$SCRIPT_DIR/deploy-exclude-content.txt"

if [ ! -f "$SCRIPT_DIR/deploy.env" ]; then
  echo "✗ deploy/deploy.env is missing." >&2
  echo "  Copy deploy/deploy.env.example to deploy/deploy.env and fill in your targets." >&2
  exit 1
fi
# shellcheck disable=SC1091
. "$SCRIPT_DIR/deploy.env"

# ── Flags + positional target ─────────────────────────────────────────
ASSUME_YES=0
DELETE="--delete"
SKIP_ICLOUD_CHECK=0
BOOTSTRAP=0
HOST_CONFIG_ONLY=0
TARGET=""
for arg in "$@"; do
  case "$arg" in
    -y|--yes)             ASSUME_YES=1 ;;
    --no-delete)          DELETE="" ;;
    --bootstrap)          BOOTSTRAP=1 ;;
    --host-config)        HOST_CONFIG_ONLY=1 ;;
    --skip-icloud-check)  SKIP_ICLOUD_CHECK=1 ;;
    -h|--help)
      sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//; s/^#//'
      exit 0 ;;
    -*) echo "Unknown option: $arg (try --help)" >&2; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "✗ Multiple targets given ('$TARGET' and '$arg'); only one allowed." >&2
        exit 2
      fi
      TARGET="$arg"
      ;;
  esac
done

if [ "$BOOTSTRAP" -eq 1 ] && [ "$HOST_CONFIG_ONLY" -eq 1 ]; then
  echo "✗ --bootstrap and --host-config are mutually exclusive." >&2
  exit 2
fi

command -v rsync >/dev/null || { echo "✗ rsync not found in PATH" >&2; exit 1; }
[ -f "$EXCLUDE_FILE" ] || { echo "✗ Missing exclude file: $EXCLUDE_FILE" >&2; exit 1; }
[ -f "$EXCLUDE_CONTENT_FILE" ] \
  || { echo "✗ Missing content exclude file: $EXCLUDE_CONTENT_FILE" >&2; exit 1; }

# ── Resolve target → REMOTE_HOST + REMOTE_PATH ────────────────────────
: "${TARGETS:?TARGETS not set in deploy.env}"
: "${DEFAULT_TARGET:?DEFAULT_TARGET not set in deploy.env}"
command -v resolve_target >/dev/null \
  || { echo "✗ resolve_target() not defined in deploy.env" >&2; exit 1; }

[ -z "$TARGET" ] && TARGET="$DEFAULT_TARGET"

# Verify the target name is in the declared TARGETS list (catches typos
# even when resolve_target has a stray branch the list doesn't mention).
known=0
for t in $TARGETS; do
  [ "$t" = "$TARGET" ] && { known=1; break; }
done
if [ "$known" -ne 1 ]; then
  echo "✗ Unknown target: '$TARGET'" >&2
  echo "  Known targets: $TARGETS" >&2
  exit 2
fi

REMOTE_HOST=""
REMOTE_PATH=""
if ! resolve_target "$TARGET"; then
  echo "✗ resolve_target('$TARGET') failed — add a case branch in deploy.env." >&2
  exit 1
fi
if [ -z "$REMOTE_HOST" ] || [ -z "$REMOTE_PATH" ]; then
  echo "✗ resolve_target('$TARGET') did not set REMOTE_HOST and REMOTE_PATH." >&2
  exit 1
fi
echo "▶ Target: $TARGET  →  $REMOTE_HOST:$REMOTE_PATH"

# ── --host-config: SCP one file + curl-verify gate, then exit ─────────
# The host-scoped Kirby config (site/config/config.<SERVER_NAME>.php) is
# rsync-excluded from the normal mirror so each environment keeps its
# own copy. This branch is the one-command push for that single file,
# plus a logged-out curl to confirm the /dev/draw 403 gate is active.
# No iCloud pre-check, no .htaccess staging — just one short SCP.
if [ "$HOST_CONFIG_ONLY" -eq 1 ]; then
  LOCAL_HC="$PROJECT_ROOT/site/config/config.$TARGET.php"
  REMOTE_HC="$REMOTE_PATH/site/config/config.$TARGET.php"
  if [ ! -f "$LOCAL_HC" ]; then
    echo "✗ Local host-scoped config not found: $LOCAL_HC" >&2
    echo "  Each target needs site/config/config.<target>.php (see existing siblings)." >&2
    exit 1
  fi
  echo "▶ Pushing host-scoped config:"
  echo "    $LOCAL_HC"
  echo "  → $REMOTE_HOST:$REMOTE_HC"
  if [ "$ASSUME_YES" -ne 1 ]; then
    printf 'Proceed? [y/N] '
    read -r reply
    case "$reply" in
      [yY]|[yY][eE][sS]) ;;
      *) echo "Aborted."; exit 0 ;;
    esac
  fi
  # scp preserves source mode by default; the in-repo file is 644 from
  # git, no chmod gymnastics needed (unlike the staged .htaccess).
  scp -p "$LOCAL_HC" "$REMOTE_HOST:$REMOTE_HC"
  echo "✓ Host-scoped config uploaded."

  # Verify the /dev/draw gate returns 403 when logged out. Uses HEAD
  # so no body is downloaded; -o /dev/null silences any redirect chain
  # output; -w '%{http_code}' prints just the status code.
  GATE_URL="https://$TARGET/dev/draw"
  echo "▶ Verifying gate: curl $GATE_URL  (expecting 403)"
  status=$(curl -sSL -o /dev/null -w '%{http_code}' --max-time 10 "$GATE_URL" || echo "000")
  case "$status" in
    403) echo "  ✓ Gate active (HTTP $status)." ;;
    200) echo "  ✗ Gate INERT — got HTTP 200. Check site/config/config.$TARGET.php loaded." >&2; exit 1 ;;
    000) echo "  ✗ curl failed to reach $GATE_URL (network / DNS / TLS)." >&2; exit 1 ;;
    *)   echo "  ⚠ Unexpected HTTP $status — investigate." >&2; exit 1 ;;
  esac
  exit 0
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

# ── Stage a comment-stripped .htaccess ───────────────────────────────
# The in-repo .htaccess carries a top-of-file commentary block that is
# useful for future maintenance but is a complete tech-stack reveal
# online (mentions Kirby, Infomaniak, the panel surface, etc.). We
# keep the commented file locally (sole source of truth) and ship a
# stripped version: all lines starting with `#` removed, blank lines
# collapsed. Apache's directives are unchanged.
#
# CRITICAL: mktemp creates files with mode 0600 (owner-only read/write).
# rsync -a preserves the source mode, so without an explicit chmod the
# .htaccess lands on the server as mode 600 and Apache (running as a
# different user on shared hosting) cannot read it. The visible
# symptom is that EVERY url under the site returns HTTP 403 — Apache's
# response to an unreadable .htaccess in a directory is to forbid the
# whole directory. We chmod 644 immediately to avoid this.
STAGED_HTACCESS="$(mktemp -t htaccess-deploy.XXXXXX)"
trap 'rm -f "$STAGED_HTACCESS"' EXIT
sed -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d' \
    "$PROJECT_ROOT/.htaccess" > "$STAGED_HTACCESS"
chmod 644 "$STAGED_HTACCESS"

# ── rsync flags ───────────────────────────────────────────────────────
#  -a  archive (recurse, symlinks, times, perms)
#  -z  compress over the wire
#  -h  human-readable sizes
#  -i  itemize each change (so the dry run is readable)
#  --delete-after + --delay-updates: stage updates and apply deletions at
#     the very end, shrinking the window where the live tree is mid-update.
#  --no-owner --no-group: shared hosting usually forbids chown-by-id.
#     Remove these if the deploy user owns the tree and you want exact perms.
#  --exclude=/.htaccess: the in-repo .htaccess is NOT pushed — we send the
#     stripped version separately after the main rsync.
COMMON=(
  -az -h -i
  $DELETE --delete-after --delay-updates
  --exclude-from="$EXCLUDE_FILE"
  --exclude=/.htaccess
  --no-owner --no-group
)
# Layer 2 separation: in normal mode, the content-data exclude file is
# loaded as a SECOND --exclude-from so editor-written files are left
# alone (servers can edit them; the content-sync layer arbitrates).
# --bootstrap drops this exclude for one run so a freshly-seeded server
# can be replaced with local state in a single pass.
if [ "$BOOTSTRAP" -ne 1 ]; then
  COMMON+=( --exclude-from="$EXCLUDE_CONTENT_FILE" )
fi

SRC="$PROJECT_ROOT/"
DEST="$REMOTE_HOST:$REMOTE_PATH/"

if [ "$BOOTSTRAP" -eq 1 ]; then
  cat >&2 <<EOF
─────────────────────────────────────────────────────────────────────
⚠  --bootstrap: editor-written content data WILL be pushed and (with
   --delete) WILL overwrite/remove the server's existing content.
   This is the one-time obsolete-seed replacement. Use ONLY when the
   target server's content is known-obsolete; otherwise the
   content-sync layer (not yet built) is the right tool.

   Target: $TARGET  →  $REMOTE_HOST:$REMOTE_PATH
─────────────────────────────────────────────────────────────────────
EOF
fi

echo "▶ DRY RUN   $SRC"
echo "        →   $DEST   (mirror=${DELETE:-off}${BOOTSTRAP:+, bootstrap=ON})"
echo "        +   .htaccess  (sent separately, comments stripped)"
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
  if [ "$BOOTSTRAP" -eq 1 ]; then
    printf '⚠  Second confirmation for --bootstrap. Type the target name (%s) to proceed: ' "$TARGET"
    read -r reply2
    if [ "$reply2" != "$TARGET" ]; then
      echo "Aborted — target name not matched."; exit 0
    fi
  fi
fi

echo "▶ DEPLOYING …"
rsync "${COMMON[@]}" "$SRC" "$DEST"
echo "▶ Pushing stripped .htaccess …"
rsync -az -h -i --no-owner --no-group \
    "$STAGED_HTACCESS" "$REMOTE_HOST:$REMOTE_PATH/.htaccess"
echo "✓ Deploy complete."
