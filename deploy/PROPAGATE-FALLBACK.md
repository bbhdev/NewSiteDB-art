# Propagate fallback — when the in-app path fails

The normal way to move content between **L** (local Mac, port 8765),
**A** (newsitedbart.bbh.fr, staging) and **B** (danielbondard.fr, public)
is the **in-app propagate** — buttons in the L editor's sync pill that
drive `/sync/propagate/*` endpoints. That path uses chunked HTTP POST,
shows progress, refreshes per-page `_sync` sidecars, and is generally
what you want.

**This file is for when that path doesn't work.** Server config drift,
expired secret, infra outage, browser CORS weirdness, anything that
makes the editor button fail. The fallback (`deploy/propagate.sh`)
does the same job over `rsync`-over-`SSH` from your terminal — slower,
no progress UI, but it survives anything that breaks the HTTP route
short of SSH itself being down.

**Failures here are rare.** You won't have details in head when one
hits. That's the entire reason this doc exists — open it, follow the
steps, you're back to working.

---

## TL;DR — the three commands

```sh
# Push your local work to A (most common — "I edited on L, I need A to catch up")
deploy/propagate.sh L-to-A

# Pull A's content back to L (less common — "I edited on A, now I want to keep going on L")
deploy/propagate.sh A-to-L

# Publish A to B (the "go live" step — only when A is the version you want public)
deploy/propagate.sh A-to-B
```

Each command dry-runs first, shows you what would change, asks `y/N`.
You can also pass `--dry-run` to see the plan without ever being asked
to confirm.

---

## When the editor shows a propagate failure

The editor's sync pill will (in a future slice) show a red banner when
a `/sync/propagate/*` call fails — something like:

> ✗ Propagate L → A failed: HTTP 502 from server.
> **Fallback:** run `deploy/propagate.sh L-to-A` in a terminal.
> See `deploy/PROPAGATE-FALLBACK.md` for details.

The banner will be one click → opens this file. You don't have to
remember the command.

If you're reading this without an editor banner — that's also fine.
You came here on purpose to refresh your memory. Same instructions
apply.

---

## Step-by-step — L → A (push)

You edited on L. You want A to have the same content.

1. **Open a terminal** in the project root:
   ```sh
   cd ~/Library/Mobile\ Documents/com~apple~CloudDocs/DEV\ :icl/Claude\ CODE/NewSiteDB-art
   ```

2. **Dry-run first** (optional but reassuring — shows what would change
   without doing anything):
   ```sh
   deploy/propagate.sh L-to-A --dry-run
   ```
   You'll see a list of files. `dev/` and `error/` should NOT appear —
   they're excluded by design (per-node staging).

3. **Run for real:**
   ```sh
   deploy/propagate.sh L-to-A
   ```
   You'll be asked to confirm; type `y` and press Enter.

4. **What happens** (in order, on screen):
   - Dry-run rsync preview again (so you see the diff one more time).
   - Confirmation prompt.
   - **Snapshot taken on A** — A's current `content/` is saved to
     `library/auto-pre-propagate-<UTC-iso>-from-L/` so you can roll
     back if anything looks wrong.
   - **rsync L's `content/` → A's `content/`** with `--delete`.
   - **State bump on A** — `site/sync/state.json` updated so the
     direction-detection pill on L is accurate.

5. **Confirm it worked:**
   - Open `https://newsitedbart.bbh.fr/dev/draw` (or whichever page you
     edited) — your changes should be there.
   - Check A's state:
     ```sh
     SECRET=$(php -r '$s = include "site/config/sync.secret.php"; echo $s;')
     curl -sS "https://newsitedbart.bbh.fr/sync/state" -H "Authorization: Bearer $SECRET"
     ```
     `lastActivityBy` should read `L-propagate-sh` and `lastActivityAt`
     should be within the last minute.

---

## Step-by-step — A → L (pull back)

You edited on A. You want L to catch up so you can resume on desktop.

1. **Terminal in project root** (same as above).

2. **Dry-run:**
   ```sh
   deploy/propagate.sh A-to-L --dry-run
   ```
   Look at the list carefully — anything marked `deleting` on the L
   side will be removed from L's working tree. That's the whole point
   of pulling back, but it's worth a glance.

3. **Run:**
   ```sh
   deploy/propagate.sh A-to-L
   ```

4. **What happens:**
   - Snapshot taken on **L** — L's current `content/` is saved to
     `library/auto-pre-propagate-<UTC-iso>-from-A/`.
   - rsync A → L.
   - State bump on L.

5. **Confirm it worked:**
   - Open `http://127.0.0.1:8765/dev/draw` — should reflect A's content.
   - Run the curl on L's `http://127.0.0.1:8765/sync/state` —
     `lastActivityBy` should read `A-propagate-sh`.

---

## Step-by-step — A → B (publish)

You finished work on A. You want B (the public site) to match.

1. **First** open `https://newsitedbart.bbh.fr/` (or your A editor)
   and confirm A is in the state you want public. **The whole point
   of the L→A→B pipeline is that A is your final preview before
   publish.** Don't skip this step.

2. **Terminal:**
   ```sh
   deploy/propagate.sh A-to-B --dry-run        # preview first
   deploy/propagate.sh A-to-B                  # then the real thing
   ```

3. **What happens:**
   - Snapshot taken on **B** — B's current `content/` saved to
     `library/auto-pre-propagate-<UTC-iso>-from-A/`. This is the
     emergency rollback if the publish lands wrong.
   - rsync A → B (runs entirely on the Infomaniak host — A and B
     are sibling project dirs under one SSH account, so no
     L-as-intermediary).
   - State bump on B.

4. **Confirm it worked:**
   - Open `https://danielbondard.fr/` in a private window (so caching
     doesn't lie to you) — should reflect A's content.

---

## Rolling back from a snapshot

Every propagate creates a destination-side snapshot BEFORE making changes.
If the propagate landed wrong, you have a complete copy of the previous
state.

The snapshot lives at:
```
library/auto-pre-propagate-<UTC-iso>-from-<source>/
  ├── meta.json
  └── content/
```

### Rollback on a remote node (A or B):

```sh
# Replace SNAPSHOT_DIR and REMOTE_PATH with actual values.
ssh newsitedbart bash -c "'
  set -e
  cd /home/clients/.../sites/newsitedbart.bbh.fr     # or danielbondard.fr
  SNAPSHOT_DIR=library/auto-pre-propagate-2026-06-09T13-11-15Z-from-L
  # Sanity check first:
  ls \$SNAPSHOT_DIR/content/ | head
  # Then restore:
  rsync -a --delete \$SNAPSHOT_DIR/content/ content/
'"
```

### Rollback on L:

```sh
SNAPSHOT_DIR="library/auto-pre-propagate-2026-06-09T13-11-15Z-from-A"
ls "$SNAPSHOT_DIR/content/" | head    # sanity check
rsync -a --delete "$SNAPSHOT_DIR/content/" content/
```

### What does NOT roll back automatically:

- The destination's `site/sync/state.json` (will still show the
  failed propagate's `lastActivityAt`). Either edit it back by hand
  or just save anything in the editor to bump it naturally.
- Per-page `_sync` sidecars — they read stale until the next save
  on each page.

These are cosmetic; the actual content is recovered.

---

## Troubleshooting

### "✗ deploy.env not found"

You need `deploy/deploy.env` — copy from `deploy/deploy.env.example` and
fill in your SSH host/path. See `deploy/README.md`.

### "✗ rsync not found"

Install rsync. `brew install rsync` on Mac.

### "Permission denied (publickey)"

Your `~/.ssh/config` doesn't have a working entry for the SSH alias.
`ssh newsitedbart` (or whichever alias is in `deploy.env`) should land
you on the server without a password prompt. Fix that first.

### rsync hangs or partially transfers

Could be the iCloud-placeholder problem (some files have been evicted
to stubs by macOS). `deploy.sh` checks for this; `propagate.sh` does
not (yet). Run:

```sh
find content/ -flags +dataless
```

Any output = evicted files. Right-click in Finder → **Download Now**
on the parent folder.

### "✗ A-to-B requires A and B on the same SSH alias"

This means `deploy.env` resolves A and B to different `REMOTE_HOST`
values. The v1 fallback doesn't implement cross-host A → B (would
need to route through L). For now, deploy A and B under the same
SSH alias (typically the same shared-hosting account).

### Editor still shows old content after propagate succeeded

Browser cache. Hard refresh (Cmd-Shift-R on Mac).

### `lastActivityBy` shows the wrong value

The state-bump step may have failed (PHP not in remote PATH, or
write permission issue). The content/ transfer still succeeded; the
state mismatch is cosmetic. Save any file via the destination's
editor to bump naturally, OR ssh in and edit
`site/sync/state.json` by hand.

---

## When to NOT use the fallback

- **When the primary path is working.** The fallback skips per-page
  `_sync` sidecar updates and has no progress UI — the in-app path
  is better when available.
- **When you only want to push one page.** Both paths are
  whole-`content/` propagates by design (see
  `sync-layer-topology-and-operations.md`). If you don't want all
  changes on the destination, this isn't the tool.
- **When the destination is supposed to stay frozen** (i.e. you're
  considering propagating to B while B is unlocked for direct
  editing). Don't — back-propagate B → A first via the unlock-B
  flow (see S8 when implemented).

---

## Where this lives in the design

- `deploy/propagate.sh` — the script itself.
- `deploy/PROPAGATE-FALLBACK.md` — this file.
- `site/plugins/sync/index.php` + routes in `site/config/config.php` —
  the in-app primary path (`/sync/propagate/*`, implemented across
  S4b.2 / S4b.3 / S4b.4).
- `library/auto-pre-propagate-*/` — auto-snapshots written by both
  the primary path AND this fallback. Retention policy (S7) will
  eventually trim these to the last N per destination.

For the design rationale (why propagate not sync, why mandatory
snapshot, why no per-page selection) see
`sync-layer-topology-and-operations.md`.
