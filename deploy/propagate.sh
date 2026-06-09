#!/usr/bin/env bash
#
# propagate.sh — last-resort content-propagate fallback (Sync layer S4b.1).
#
# WHEN TO USE: only when the primary in-app propagate path (/sync/propagate/*
# endpoints driven from L's editor UI) is broken or unavailable. This is a
# CLI escape hatch — same destination-snapshot + atomic-overwrite semantics
# as the primary, but driven by rsync-over-SSH instead of chunked HTTP POST.
#
# Why "implement now, not later": a fallback that doesn't exist when the
# primary breaks is no fallback at all. Resilience principle — if the
# in-app path fails (server config drift, infra outage, expired secret,
# whatever), the user must be able to keep the L → A → B workflow alive
# without dropping back into "wait while Claude builds a tool urgently."
#
# Strategy:
#   1. Take a pre-propagate snapshot ON THE DESTINATION node, named
#      library/auto-pre-propagate-<UTC-iso>-from-<source>/. Format matches
#      the manual draw-library snapshots (meta.json + content/) so S7
#      retention will eventually see both kinds uniformly.
#   2. rsync the source's content/ to the destination's content/ with
#      --delete (mirror) and these excludes: /dev/, /error/, /_drafts/
#      (mirrors sync_manifest_excluded_prefixes — per-node staging that
#      MUST NOT propagate). Top-level only — a page directory called
#      "my-drafts" would still propagate; only the literal `_drafts`
#      subtrees Kirby uses for draft pages are blocked.
#   3. Bump destination's site/sync/state.json: lastActivityAt=now,
#      lastActivityBy=<source>-propagate-sh. This keeps the L-side
#      direction-detection pill accurate after a fallback use (without
#      it, the destination would look stale and L would warn to push
#      again).
#
# Caveats (intentional for v1 fallback — primary path closes these gaps):
#   • Per-page _sync sidecars are NOT refreshed. They'll read stale until
#     a normal /dev/save touches each page. The /sync/manifest endpoint
#     uses sidecar mtimes for its "changed-since" display only; sync
#     direction itself still works (lastActivityAt is the only state
#     direction-detection reads).
#   • No txn ID, no abort mid-flight, no progress UI — this is a CLI tool.
#     If rsync fails partway, the destination's content/ is in whatever
#     state rsync left it; restore from the snapshot via the library UI.
#   • A-to-B routes through the source host's filesystem (rsync sees A
#     and B as paths on the same SSH alias). No L-as-intermediary.
#
# Usage:
#   deploy/propagate.sh <direction> [flags]
#
#   <direction>     L-to-A | A-to-L | A-to-B
#   -y, --yes       skip confirmation prompt
#   --dry-run       show what would change; take no snapshot, run no real
#                   rsync, write no state. Safe to run anytime.
#   -h, --help      show this help
#
# Examples:
#   deploy/propagate.sh L-to-A                  # interactive, asks before doing it
#   deploy/propagate.sh L-to-A -y               # auto-confirm (scriptable)
#   deploy/propagate.sh A-to-B --dry-run        # preview the publish without committing
#
# Requires: deploy/deploy.env (gitignored) — sourced for SSH config.

set -euo pipefail

# ── Resolve paths ───────────────────────────────────────────────────────
SCRIPT_DIR="$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"
DEPLOY_ENV="$SCRIPT_DIR/deploy.env"

[[ -f "$DEPLOY_ENV" ]] || {
  echo "✗ $DEPLOY_ENV not found. Copy deploy/deploy.env.example and configure it." >&2
  exit 1
}
# shellcheck disable=SC1090
source "$DEPLOY_ENV"

command -v rsync >/dev/null || { echo "✗ rsync not found in PATH" >&2; exit 1; }
command -v php   >/dev/null || { echo "✗ php not found in PATH (needed for state.json bump)" >&2; exit 1; }

# ── Arg parsing ─────────────────────────────────────────────────────────
DIRECTION=""
ASSUME_YES=0
DRY_RUN=0

usage() {
  sed -n '2,/^set -e/p' "${BASH_SOURCE[0]}" | sed -n '1,/^set -e/p' | head -n -1 | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    L-to-A|A-to-L|A-to-B) DIRECTION="$arg" ;;
    -y|--yes)             ASSUME_YES=1 ;;
    --dry-run)            DRY_RUN=1 ;;
    -h|--help)            usage; exit 0 ;;
    *)                    echo "✗ unknown arg: $arg" >&2; echo "Try --help" >&2; exit 1 ;;
  esac
done
[[ -n "$DIRECTION" ]] || { echo "✗ direction required (L-to-A | A-to-L | A-to-B)"; exit 1; }

# ── Resolve source/destination endpoints ───────────────────────────────
# SRC_KIND / DST_KIND: "local" (no SSH) or "remote" (uses SSH alias).
# SRC_PATH / DST_PATH: project root on that side (content at PATH/content,
# library at PATH/library, sync state at PATH/site/sync/state.json).
# SOURCE_NODE_NAME: short role tag stamped into the snapshot name and the
# destination's lastActivityBy.

SRC_KIND=""; SRC_PATH=""; SRC_HOST=""; SRC_LABEL=""; SOURCE_NODE_NAME=""
DST_KIND=""; DST_PATH=""; DST_HOST=""; DST_LABEL=""

case "$DIRECTION" in
  L-to-A)
    SRC_KIND="local";  SRC_PATH="$PROJECT_ROOT"; SRC_LABEL="L (local)"; SOURCE_NODE_NAME="L"
    resolve_target newsitedbart.bbh.fr || { echo "✗ target A not in deploy.env" >&2; exit 1; }
    DST_KIND="remote"; DST_HOST="$REMOTE_HOST"; DST_PATH="$REMOTE_PATH"; DST_LABEL="A (newsitedbart.bbh.fr)"
    ;;
  A-to-L)
    resolve_target newsitedbart.bbh.fr || { echo "✗ target A not in deploy.env" >&2; exit 1; }
    SRC_KIND="remote"; SRC_HOST="$REMOTE_HOST"; SRC_PATH="$REMOTE_PATH"; SRC_LABEL="A (newsitedbart.bbh.fr)"; SOURCE_NODE_NAME="A"
    DST_KIND="local";  DST_PATH="$PROJECT_ROOT"; DST_LABEL="L (local)"
    ;;
  A-to-B)
    # Both A and B live on the same Infomaniak SSH account → rsync runs
    # locally on the shared host between two sibling project dirs. No
    # L-as-intermediary, full bandwidth.
    resolve_target newsitedbart.bbh.fr || { echo "✗ target A not in deploy.env" >&2; exit 1; }
    SRC_KIND="remote"; SRC_HOST="$REMOTE_HOST"; SRC_PATH="$REMOTE_PATH"; SRC_LABEL="A (newsitedbart.bbh.fr)"; SOURCE_NODE_NAME="A"
    A_HOST="$REMOTE_HOST"  # remember A's SSH alias before we overwrite REMOTE_HOST
    resolve_target danielbondard.fr || { echo "✗ target B not in deploy.env" >&2; exit 1; }
    DST_KIND="remote"; DST_HOST="$REMOTE_HOST"; DST_PATH="$REMOTE_PATH"; DST_LABEL="B (danielbondard.fr)"
    # Sanity: A and B must share an SSH alias for the same-host fast path.
    if [[ "$A_HOST" != "$DST_HOST" ]]; then
      echo "✗ A-to-B requires A and B on the same SSH alias (got A=$A_HOST, B=$DST_HOST)." >&2
      echo "  Cross-host A-to-B is not implemented in v1 of propagate.sh." >&2
      exit 1
    fi
    ;;
esac

# rsync source/dest specifier strings (with trailing slash on directories).
build_rsync_path() {
  local kind="$1" host="$2" path="$3" subdir="$4"
  if [[ "$kind" == "local" ]]; then
    printf '%s/%s/' "$path" "$subdir"
  else
    printf '%s:%s/%s/' "$host" "$path" "$subdir"
  fi
}
SRC_CONTENT_RSYNC="$(build_rsync_path "$SRC_KIND" "$SRC_HOST" "$SRC_PATH" content)"
DST_CONTENT_RSYNC="$(build_rsync_path "$DST_KIND" "$DST_HOST" "$DST_PATH" content)"

# For A-to-B the rsync runs ENTIRELY on the remote host; we ssh in and run
# a local rsync there. Override the rsync paths to be host-local in that
# code path (handled at rsync invocation time).

# Snapshot naming + paths.
NOW_UTC="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
SNAPSHOT_NAME="auto-pre-propagate-${NOW_UTC}-from-${SOURCE_NODE_NAME}"
SNAPSHOT_PATH="$DST_PATH/library/$SNAPSHOT_NAME"

# Local timezone-aware ISO timestamp for meta.json (matches the manual
# library snapshot format produced by dev/draw/library/save).
SAVED_AT_LOCAL="$(date +"%Y-%m-%dT%H:%M:%S%z" | sed -E 's/([+-][0-9]{2})([0-9]{2})$/\1:\2/')"

# App version from the local checkout — the source-of-truth file.
APP_VERSION="$(cat "$PROJECT_ROOT/VERSION" | head -1 | tr -d '[:space:]')"

# rsync exclusion list — mirrors sync_manifest_excluded_prefixes (dev/,
# error/) plus Kirby's _drafts/ which are inherently per-node.
RSYNC_EXCLUDES=( --exclude='/dev/' --exclude='/error/' --exclude='_drafts/' )

# ── Summary header ──────────────────────────────────────────────────────
echo "▶ propagate.sh — $DIRECTION   (v1, last-resort fallback)"
echo "  Source:      $SRC_LABEL"
echo "  Destination: $DST_LABEL"
echo "  Snapshot:    library/$SNAPSHOT_NAME"
echo "  Excludes:    ${RSYNC_EXCLUDES[*]}"
[[ "$DRY_RUN" == 1 ]] && echo "  *** DRY RUN — no changes will be made ***"
echo ""

# ── Dry-run rsync preview ───────────────────────────────────────────────
echo "▶ Dry-run rsync preview …"
if [[ "$DIRECTION" == "A-to-B" ]]; then
  # Remote-to-remote on the same host — ssh and run the dry-run there.
  # shellcheck disable=SC2029
  ssh "$DST_HOST" "rsync -avh --delete --dry-run ${RSYNC_EXCLUDES[*]} '$SRC_PATH/content/' '$DST_PATH/content/'" \
    2>&1 | tail -40 | sed 's/^/    /' || true
else
  rsync -avh --delete --dry-run "${RSYNC_EXCLUDES[@]}" "$SRC_CONTENT_RSYNC" "$DST_CONTENT_RSYNC" \
    2>&1 | tail -40 | sed 's/^/    /' || true
fi
echo ""

# ── Confirmation ────────────────────────────────────────────────────────
if [[ "$ASSUME_YES" != 1 ]] && [[ "$DRY_RUN" != 1 ]]; then
  echo "⚠ This will OVERWRITE $DST_LABEL's content/ with $SRC_LABEL's content/."
  echo "  A snapshot of $DST_LABEL's current content will be saved first."
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in y|Y|yes|YES) ;; *) echo "Aborted."; exit 0 ;; esac
fi

if [[ "$DRY_RUN" == 1 ]]; then
  echo "Dry run only — exiting without changes."
  exit 0
fi

# ── Step 1: Snapshot destination ────────────────────────────────────────
# Format mirrors dev/draw/library/save: library/<name>/{meta.json, content/}.
# The schemaVersion field is set to null because this snapshot was made
# externally (without running the migrate-content.php chain); the library
# UI will refuse to load it back via the normal "Load snapshot" path until
# the user explicitly opts in. That's intentional — restore is a manual,
# attention-paying action, not an automatic mechanism the fallback tool
# should presume to invoke.

META_JSON=$(cat <<EOF
{
    "name": "$SNAPSHOT_NAME",
    "savedAt": "$SAVED_AT_LOCAL",
    "appVersion": "$APP_VERSION",
    "schemaVersion": null,
    "source": "propagate.sh",
    "direction": "$DIRECTION",
    "sourceNode": "$SOURCE_NODE_NAME"
}
EOF
)

echo "▶ Snapshotting destination → library/$SNAPSHOT_NAME …"

snapshot_local() {
  mkdir -p "$SNAPSHOT_PATH"
  rsync -a --delete "${RSYNC_EXCLUDES[@]}" "$DST_PATH/content/" "$SNAPSHOT_PATH/content/"
  printf '%s\n' "$META_JSON" > "$SNAPSHOT_PATH/meta.json"
}

snapshot_remote() {
  ssh "$DST_HOST" "mkdir -p '$SNAPSHOT_PATH' && rsync -a --delete ${RSYNC_EXCLUDES[*]} '$DST_PATH/content/' '$SNAPSHOT_PATH/content/'"
  printf '%s\n' "$META_JSON" | ssh "$DST_HOST" "cat > '$SNAPSHOT_PATH/meta.json'"
}

if [[ "$DST_KIND" == "local" ]]; then
  snapshot_local
else
  snapshot_remote
fi
echo "  ✓ snapshot written"
echo ""

# ── Step 2: rsync content/ → destination ────────────────────────────────
echo "▶ rsync content/ → destination …"
if [[ "$DIRECTION" == "A-to-B" ]]; then
  # shellcheck disable=SC2029
  ssh "$DST_HOST" "rsync -avh --delete --delete-after --delay-updates ${RSYNC_EXCLUDES[*]} '$SRC_PATH/content/' '$DST_PATH/content/'" \
    2>&1 | tail -20 | sed 's/^/    /'
else
  rsync -avh --delete --delete-after --delay-updates "${RSYNC_EXCLUDES[@]}" "$SRC_CONTENT_RSYNC" "$DST_CONTENT_RSYNC" \
    2>&1 | tail -20 | sed 's/^/    /'
fi
echo "  ✓ rsync complete"
echo ""

# ── Step 3: Bump destination state.json ─────────────────────────────────
# The destination just had its content/ rewritten out-of-band; without a
# state-bump, /sync/state on the destination would still report its
# pre-propagate lastActivityAt, and the source-side direction-detection UI
# would incorrectly think the source is still ahead.

PHP_BUMP_SCRIPT='
$path = $argv[1];
$source = $argv[2];
$dir = $path . "/site/sync";
if (!is_dir($dir)) { @mkdir($dir, 0755, true); }
$f = $dir . "/state.json";
$s = is_file($f) ? json_decode(file_get_contents($f), true) : null;
if (!is_array($s)) {
    $s = ["schemaVersion" => 1, "peerStamps" => ["L" => null, "A" => null, "B" => null]];
}
if (!isset($s["peerStamps"]) || !is_array($s["peerStamps"])) {
    $s["peerStamps"] = ["L" => null, "A" => null, "B" => null];
}
$now = date("c");
$s["lastActivityAt"] = $now;
$s["lastActivityBy"] = $source . "-propagate-sh";
$tmp = $f . ".tmp." . bin2hex(random_bytes(4));
file_put_contents($tmp, json_encode($s, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
rename($tmp, $f);
echo "  lastActivityAt = " . $now . PHP_EOL;
echo "  lastActivityBy = " . $s["lastActivityBy"] . PHP_EOL;
'

echo "▶ Bumping destination state.json …"
if [[ "$DST_KIND" == "local" ]]; then
  php -r "$PHP_BUMP_SCRIPT" -- "$DST_PATH" "$SOURCE_NODE_NAME"
else
  # shellcheck disable=SC2029
  ssh "$DST_HOST" "php -r $(printf '%q' "$PHP_BUMP_SCRIPT") -- $(printf '%q' "$DST_PATH") $(printf '%q' "$SOURCE_NODE_NAME")"
fi
echo "  ✓ state bumped"
echo ""

echo "✓ Propagate $DIRECTION complete."
echo "  Snapshot path on $DST_LABEL: library/$SNAPSHOT_NAME"
echo "  If something looks wrong, restore from the snapshot via the library UI on $DST_LABEL"
echo "  (or by rsyncing library/$SNAPSHOT_NAME/content/ back over content/)."
