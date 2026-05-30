# HANDOFF — NewSiteDB-art

A briefing for whoever (next Claude session, or human) picks this project up
without the context of the conversation that produced versions ~v0.8.5–0.9.8.
Read this top-to-bottom once; reference back as needed.

**Current state (v0.9.14):** Phase 1 complete (v0.9.0 milestone).
Deployment infrastructure landed (v0.9.1–v0.9.14) — rsync deploy tooling,
iCloud-placeholder pre-check, first-deploy checklist with diagnostics
captured from the actual first live run, a working `/dev/draw` auth gate
via host-scoped Kirby config (early-exit-in-ready strategy after the
route-based v0.9.2 attempt failed live), and a repo-owned `.htaccess`
carrying Kirby's mod_rewrite rules (without which `/panel` and every
other virtual route 404s on Apache). First live deploy executed
successfully against `https://newsitedbart.bbh.fr/` (Infomaniak shared
hosting); Panel installed, first user created, gate verified end-to-end
(curl /dev/draw → 403 logged out, editor HTML logged in). Next phase:
Phase 2 — actual Kirby pages and content authoring.

## What this project is

A Kirby-based site where the visual identity is a layer of animated SVG line
art. Two surfaces:

- **Runtime** (`assets/js/app.js`) — public-facing renderer that reads a JSON
  payload inlined by `site/snippets/lines-layer.php`, paints SVG paths into
  `#lines-layer`, and animates them with GSAP / ScrollTrigger as the user
  scrolls.
- **Editor** (`assets/js/dev-draw.js`) — reached at `/dev/draw`. Lets the
  designer draw, group, palette-pick, set per-line behaviors, snapshot data,
  clean up orphans. Saves to disk via custom Kirby routes in `site/config/config.php`.

The user (designer/dev) interacts almost entirely with the editor; the runtime
is the publishing target.

`project-hierarchy.csv` (at repo root) maps every file/dir to its role.
`scripts/migrate-content.php` is the schema-migration CLI for porting old
content shapes.

## Versioning conventions

- `VERSION` (root) — app semver. Bumped on every commit. Used by
  `site/config/config.php` as `option('version')` → cache-buster `?v=…` on
  every CSS/JS include.
- `SCHEMA_VERSION` (root) — integer. Bumped **only** when the on-disk content
  shape changes incompatibly with older snapshots. Snapshots embed the schema
  version in their `meta.json`; load refuses on mismatch. Currently `1`.
- Commit messages are detailed for a reason — they're the project's design
  journal. Write them that way; the next session will read them.

## Architecture, top-level

### Content / data model

Per the v4 schema:

- `content/_shared/masters.json` — site-wide master definitions (`id`, `name`,
  `kind`, `params`/`points`/`segments`/`d`, `stroke`, `width`, `scope`). Shared
  identity across classes.
- `content/<page>/<class>/instances.json` — per-class instances. Each has
  `{ id, masterId, groupId, positionOffset, behaviors[], overrides }`. Different
  classes have different per-class `id`s for the "same" line, but they share
  the `masterId`.
- `content/<page>/<class>/groups.json` — per-class group records.
- `content/<page>/page.json` — page-level config (`useClasses`, `dims`).
- `content/_shared/palette.json` — site-wide color palette.

**Crucial cross-class identity rules:**

- Lines: `masterId` is the cross-class identity. Per-class `id` is class-local.
- Groups: `name` is the cross-class identity. `id` is class-local.
- Master `name` is also a useful cross-class identity (the `pathRef` fallback uses
  it; see "pathFollow" below).

### Behavior model (per-block)

Each line has a `behaviors[]` array. Each block has:

- **Trigger** — `trigger.when` ∈ scroll-range / page-load / scroll-key /
  in-view-partial / in-view-full / after-previous / scroll-stop / scroll-start.
  With `range`, `selector`, `delay`, `viewportAt`, `repeat`.
- **Duration** — `duration.mode` ∈ scroll / time / loop / pingpong / loopTo.
- **Visual contributions:**
  - `tx`, `ty`, `rot` (per-block progress-weighted deltas)
  - `translateMode` ∈ fixed / driftX / driftY / driftBoth / pathFollow
  - `fadeOpacity` + `opacityFrom` / `opacityTo`
  - `drawIn` / `drawInDirection`
  - `pathRef`, `pathRefName`, `pathAlignToTangent`, `pathEndMode` (path-follow)
  - `rotateOriginX` / `rotateOriginY` (pivot — but only block 0's is honored, see "Known Limitations")

### Composition rules (in `app.js#computeAt`)

- **translate / rotate**: SUM across blocks each frame. bp=0 contributes 0 —
  the contribution-based model handles bp=0 naturally.
- **opacity**: last-active block wins (reverse-walk, first active with
  fadeOpacity sets opacity = lerp(from, to, bp)).
- **pathFollow**: last-active wins, similar to opacity. The chosen block's
  contribution REPLACES the block's own tx/ty in computeAt; other blocks'
  Fixed/Drift deltas still sum on top. Also replaces `positionOffset` in
  writeAt (path drives absolute position).
- **loopTo**: contributes `-bp * snapshotted_chain_offset`. At bp=1, cancels
  the chain exactly, parking the line at the target block's start position.

### Frame-loop architecture

For each line: `computeAt(scrollP, nowSec) → { tx, ty, rot, opacity, pathFollowActive }`.
`writeAt` calls computeAt and applies as a single SVG transform + opacity
setAttribute.

- ScrollTrigger fires `onUpdate(self)` → calls `writeAt(self.progress, now)`.
- For time-driven blocks (any duration ≠ scroll, or any drift), additionally
  `gsap.ticker.add(tick)` runs writeAt every frame.
- **First frame priming (v0.8.71):** `writeAt(st.progress || 0, now)` is called
  once explicitly right after `ScrollTrigger.create`. Without this, ScrollTrigger
  doesn't fire onUpdate at setup when scroll=0 + range.start=0, so behaviors
  that have a non-default state at bp=0 (e.g. opacity 0.5→1) would jump on
  first scroll. This is a pattern worth remembering.

### Scroll-stop / scroll-start triggers (v0.8.77, simplified v0.8.78)

Event-driven triggers fed by a single global passive-scroll listener with a
150 ms debounce. The watcher emits two events to every subscriber:

- `scroll-stop` — user was scrolling, then no scroll event for 150 ms.
- `scroll-start` — user resumes scrolling after a stopped state.

Each subscribed block has a `delay` (seconds). On the watcher event it
schedules its fire at `t + delay`. The OPPOSITE event before the delay
elapses CANCELS the pending fire (symmetric). On fire, the block's own
`activationState[i]` is set to now — its duration starts running normally,
identical to any other trigger.

`hasTime` is force-true for any block with these triggers, so the ticker
runs and the block's progression gets painted even when the user isn't
scrolling.

### Cross-object Start / Stop side effects (v0.8.79)

Every trigger (not just scroll-stop/start) carries optional `startObjectId`
and `stopObjectId` fields. The target is identified by class name
(`masterId` for lines; `name` for groups — v1 implements line/masterId
only). When the host block's trigger fires, the runtime calls
`applyObjectEffects(trigger)` which dispatches to each matching
controller registered in the shared `objectRegistry` keyed by masterId.

- **Start** — re-arms target's triggers and fires them. Page-load fires
  immediately; in-view + scroll-key re-evaluate. No-op if the target is
  already animating normally (won't interrupt a healthy animation).
  Implementation: `armTrigger(i, b)` extracted from the original
  `blocks.forEach` setup; `rearm()` tears down per-block listeners
  (`blockTriggerTeardown[i]`) and re-runs `armTrigger` for every block.
- **Stop** — clean reset to neutral pre-fire state (NOT pause). Optional
  cleanups: `stopFadeOut` (opacity → 0) and `stopReturnHome` (translation
  + rotation → 0), sharing `stopDurationSec` + `stopEasing`. The
  cleanup tween snapshots `lastContribution` (captured at end of every
  `writeAt`) and scales tx/ty/rot/opacity toward zero by
  `easing(elapsed/dur)`. At finalize, all per-block trigger state clears
  and the target ends ready to fire again from frame zero. Re-stop during
  cleanup is ignored; re-start during cleanup cancels and re-arms.
- **Init ordering**: page-load triggers fire during per-line init, but
  target controllers may not exist yet. `pendingObjectEffects` queues
  effects while `objectInitFlushing === true`; the queue flushes after
  all lines are registered (end of `renderClassContent`).
- **Cleanup paint without permanent ticker**: lines whose blocks are all
  scroll-driven don't run `gsap.ticker`. `requestStop` installs a
  temporary `cleanupTicker` (`gsap.ticker.add(writeAt)`) removed at
  cleanup finalization or on `requestStart`.

Authored in editor via Start object / Stop object dropdowns (one per
trigger). When Stop is set, four sub-fields appear: Fade-out checkbox,
Return-home checkbox, Cleanup duration (s), Cleanup easing. Self is
excluded from the picker; the picker enumerates unique masterIds across
`state.lines`. Re-render gate in `updateBehaviorTrigger` includes
`startObjectId` / `stopObjectId` so sub-field visibility updates.

Earlier v0.8.77 same-line `startBlockIndex` / `stopBlockIndex`
side effects were ripped out in v0.8.78 as architecturally wrong —
acting on other blocks of the same object is pointless (each block has
its own trigger).

## Recent architectural decisions and why

### Phase 1 close — v0.9.0 milestone (v0.8.300 → v0.9.0)

Phase 1 is the sequential drawIn feature plus its editor surface, with a
cleanup pass on the surrounding UI. The v0.9.0 bump marks "phase 1 done";
no behavioral or schema change vs v0.8.322 — it is purely a milestone marker.

**Sequential drawIn fragment ordering (v0.8.300–0.8.318).** A `master.d`
that contains multiple `M…` subpaths is now drawable as an ordered sequence
of fragments rather than one continuous tween. Storage lives on the master
as `master.seqOrder = [fragIdx, …]` — a permutation of fragment indices
addressing the natural split of `master.d` on uppercase `M`. Renderer
splits at draw time, paints each fragment as a child `<path>` inside a
`<g>` wrapper added under `#lines-layer`, and tweens them in the stored
order with the standard drawIn dash machinery (dasharray=99999 99999,
dashoffset = BIG − reveal · L) per fragment.

The CSS-vs-wrapper trap documented in `~/.claude/CLAUDE.md` ("CSS
descendant selectors vs. wrapper-based rendering") was hit here: setting
`style.stroke` on the wrapper `<g>` was clobbered by
`#lines-layer path { stroke: var(--line-stroke) }` matching the child
paths directly. Fix: write stroke/width as **inline style on each
fragment path** (not on the group), so direct child CSS doesn't override.
The same discipline applies to the order-editor overlay (see below) and
to any future feature that wraps painted children in a styled group.

**Order editor (`mountSeqOrderOverlay` + `showSeqOrderModal`,
v0.8.312–0.8.318).** Opens from the line's behavior block. Visually:
- Body gets `ed-seq-order-editing` — toolbar / sidebar / panel host go
  pointer-events:none + opacity 0.25 + grayscale; `#handles-layer`
  hidden; `#lines-layer` pointer-events:none. The line being edited
  remains its real geometry; all OTHER `[data-line-id]` elements are
  hidden via savedHide (opacity/display) and restored on close.
- Canvas overlay mounts inside `anchorEl.parentNode` (= linesG) and
  mirrors the anchor's CSS `style.transform` + `transformBox` +
  `transformOrigin` so the bbox + fragments register exactly over the
  real line. Source for the split is `(line && line.d) || master.d` —
  `line.d` differs from `master.d` once the instance has been moved
  (`shiftLineBy` rewrites line.d, no transform); using master.d here
  produces a displaced overlay.
- bbox uses inline `style.stroke = '#ffffff'` and `style.fill = '#000'`
  (black backdrop so other content is hidden behind it); fragments use
  inline `style.stroke = '#e76f00'` (SEQ_ACCENT). No numbered badges
  (intentionally — user wants the canvas uncluttered).
- The modal `backdrop` (renamed from `overlay` to free that name) uses
  `pointerEvents: 'auto'` to block underlying clicks.

Modal layout follows the project's state-button convention:
- Header `<h3>` is on its own line with the `×` close button.
- A separate `.ed-seq-order-headtools` sub-toolbar below the header
  hosts the "Scan fragments" toggle, styled as the standard outline-
  always / label-swap state button (`ed-overview-alldetails-btn`).

Two highlight modes coexist:
- **Click** — clicking a list row pins `clickedFragIdx`, outlines the
  row + colors the fragment.
- **Scan** — entering scan mode clears `clickedFragIdx` and suppresses
  row clicks; hovering a row sets `hoveredFragIdx` for transient
  highlight. Cursor becomes crosshair via
  `.ed-seq-order-list.is-scanning .ed-seq-order-row`.

Drag-to-reorder uses the project's standard idiom (not bespoke):
`ed-seq-order-dragging` (opacity 0.45), `ed-drop-above` / `ed-drop-below`
inset box-shadow bars to indicate the **gap** the drop will land in,
move happens on `drop` only (not on `dragover`). `clearDropMarkers()`
helper resets between gestures.

**Group panel slimming (v0.8.319).** Now that a group can carry a
behavior-template object, the group's own appearance defaults are
redundant. `renderGroupPanel` keeps only Name, Visible, Behavior
template; removed Trigger, Appearance divider, Color (g.defaults.stroke),
Line width (g.defaults.width). Legacy fields are still tolerated in
data — they're simply not surfaced in the UI. Groups are allowed to
have no behavior template (no properties) or to have one.

**Snapshot name validation (v0.8.319).** The old regex was ASCII-only
and rejected common accented characters. Replaced with a multi-check:
empty / >80 chars / `.` / `..` / leading-dot / contains `..` /
filesystem-unsafe chars (`\\/:*?"<>|` + control chars) are all
rejected, then the name must match
`/^[\p{L}\p{N} _.,'()\[\]\-]+$/u`. Filesystem-traversal safety is
preserved; Unicode letters and common punctuation are now accepted.
Applied to both `/dev/draw/library/save` and `/dev/draw/library/load`
in `site/config/config.php`.

**Misc UI cleanups.**
- v0.8.320 — hairline divider before the duplicate-group action block
  in the side panel (project rule: non-directly-related items are
  separated by the standard thin-line divider).
- v0.8.321 — removed the leftover "🪟 Demo floating panel" launcher
  in `renderCanvasPanel` (v0.8.110 dev stub).
- v0.8.322 — relabel "Template object" → "Object" in the group panel
  (the divider above the field already says "Behavior template", so
  the word was redundant and was forcing a wrap). Note: do **not**
  widen this single field to take advantage of the extra room — the
  `.ed-field` uniform label/data column width across the panel is
  sacrosanct; widening one field is bad UI.

### Deployment infrastructure + first auth gate (v0.9.1–v0.9.14)

This stretch is a self-contained slice that gives the project a
reliable, one-command path from "local working tree" to the live host
at `https://newsitedbart.bbh.fr/` (Infomaniak shared hosting), plus the
minimum auth needed to make that safe. No editor or runtime behavior
changed — these versions are infrastructure only.

**What landed:**

- **`deploy/deploy.sh`** — rsync-over-SSH delta mirror with
  `--delete-after --delay-updates` and a `--exclude-from` file. Always
  runs a dry-run first and prompts for confirmation before the real
  transfer. Flags: `-y` skip prompt, `--no-delete` upload-only,
  `--skip-icloud-check` bypass the pre-check.
- **iCloud-placeholder pre-check** (v0.9.1) — project lives in iCloud
  Drive. With "Optimize Mac Storage" on, macOS can evict files to
  dataless placeholder stubs; rsync would stall or skip them silently.
  The script scans the tree with BSD `find -flags +dataless` (with the
  same path exclusions as the rsync transfer) and aborts with a clear
  remediation if any are found.
- **`deploy/deploy-exclude.txt`** — anchored exclusions for
  server-owned runtime state (`/site/accounts/`, `/site/sessions/`,
  `/site/cache/`, `/media/`), local-only tooling/backups
  (`/library/`, `/scripts/`, `/deploy/`), design-journal docs
  (`HANDOFF.md`, `CLAUDE.md`, `project-hierarchy.csv`), the
  host-managed PHP config (`/.user.ini`), Infomaniak landing /
  maintenance pages (`/__index.html`, `/.infomaniak-maintenance.html`
  — v0.9.10) and a hand-deployed SERVER_NAME probe (`/x.php`). NOTE:
  `.htaccess` is intentionally **not** excluded as of v0.9.13 — see
  the next bullet.
- **Repo-owned `.htaccess`** (v0.9.13). The very first deploy went
  through cleanly and the home page rendered, but `/panel` 404'd.
  Diagnosis: Infomaniak's default `.htaccess` ships only DEFLATE
  compression rules and a `RedirectMatch 404 /\.git`; it has no
  `RewriteEngine` block, so Apache treats `/panel` (and every other
  Kirby virtual route) as a literal filesystem path. The v0.9.6
  exclude that protected this file from deletion was protecting a
  broken state. Resolution: commit a combined `.htaccess` at the
  repo root carrying Kirby's standard mod_rewrite block + Infomaniak's
  DEFLATE list + the `.git` redirect (preserved verbatim from the
  server). Remove `/.htaccess` from the exclude list so deploy pushes
  it. The repo now owns the routing layer — any future host-side
  drift gets restored on the next deploy. Locally the file is inert
  (`php -S` doesn't read `.htaccess`).
- **`deploy/deploy.env.example`** — template for the gitignored
  `deploy.env` carrying `REMOTE_HOST` (an SSH alias, not a raw
  user@host) and `REMOTE_PATH` (web root absolute path).
- **`deploy/FIRST-DEPLOY-CHECKLIST.md`** (v0.9.3, iteratively expanded
  v0.9.4 → v0.9.13 as each step actually fired in the live run).
  Linear walkthrough from zero to live, with diagnostics for every
  common failure mode encountered. Lessons folded in:
  - SSH-config Host-scoped vs `Host *` (recommends scoped — explains
    `Host` syntax, `HostName` vs alias).
  - macOS Keychain seeding now requires explicit
    `ssh-add --apple-use-keychain` (no more auto-prompt since Monterey);
    `ssh-add --apple-load-keychain` for fresh-terminal cases where
    `ssh-add -l` shows the key but ssh still prompts.
  - Infomaniak-specific `ssh-copy-id` failure (`Connection closed by
    ... port 22` even with correct password) — manual one-liner
    fallback `cat ~/.ssh/id_ed25519.pub | ssh newsitedbart 'mkdir -p
    ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys &&
    chmod 600 ~/.ssh/authorized_keys && echo OK'`.
  - `pwd`-shows-home-not-web-root clarification (SSH lands in `$HOME`;
    web root is `$HOME/sites/newsitedbart.bbh.fr/`, addressed via
    `REMOTE_PATH`).
  - Gitignore verification via `git check-ignore -v` +
    `git ls-files --error-unmatch` instead of an ambiguous
    `git status` glance (v0.9.7).
  - **Step ordering correction (v0.9.10)** — the original draft put
    "Create Panel user" before "Deploy", which was impossible: `/panel`
    doesn't exist on the server until Kirby code is uploaded. Reordered
    to 3 (gate) → 4 (iCloud) → 5 (deploy) → 6 (Panel user) → 7 (verify).
  - **"Run on Mac, not in SSH session" warning** on the deploy step
    (v0.9.11) — a real mis-step in the live run: user ran
    `deploy/deploy.sh` from inside the server's SSH session (`uid…@h2web499:~/sites/…$`).
    deploy.sh must run on the Mac; the SSH session has neither the
    local working tree nor the BSD `find -flags +dataless` macOS-only
    pre-check.
  - **Three files saved from `--delete`** (v0.9.10): the first live
    dry-run flagged `x.php` (user's hand-deployed SERVER_NAME probe)
    and Infomaniak's `__index.html` + `.infomaniak-maintenance.html`
    for deletion. All three added to `deploy-exclude.txt`.
  - **`/panel` 404 root cause + fix** (v0.9.13): the Infomaniak
    default `.htaccess` lacks Kirby's mod_rewrite rules; resolution
    is the repo-owned `.htaccess` described above.
- **`deploy/README.md`** — the *why* behind every choice in the
  tooling; the checklist is the *what you do, in order*.

**The `/dev/draw` auth gate (v0.9.2 → v0.9.14, strategy pivot).**
Phase 3 in the roadmap below remains the comprehensive auth pass over
the whole `dev/draw/*` namespace. But for the very first deploy we
needed *something*, and the something is a **host-scoped Kirby config
file**, not a modification to the shared `config.php`. The repo's copy
lives at `site/config/config.newsitedbart.bbh.fr.php` (also serves as
the template — copy & rename for new hosts). Workflow:

1. SCP the file to the server's `site/config/`, rename to
   `config.<SERVER_NAME>.php` — on this host
   `config.newsitedbart.bbh.fr.php`. Kirby's host-scoped config loader
   reads `$_SERVER['SERVER_NAME']` (the HTTP Host header) at request
   time and merges that file over `config.php` if the filename matches.
2. The `ready` callback checks `$kirby->request()->path()` against
   `dev/draw` prefix and `$kirby->user() === null`. On match: emit
   `http_response_code(403)`, a plain-text body, and `exit()`. The
   route table is bypassed entirely.
3. Excluded from rsync by `/site/config/config.*.php` in
   `deploy-exclude.txt` — never pushed, never deleted. Each
   environment owns its own host config.

**Why the strategy pivot (v0.9.2 → v0.9.14).** The v0.9.2 implementation
registered a wildcard guard route at `dev/draw/(:all?)` via a `routes`
array returned from the `ready` callback, with `return false` for
logged-in users (fall-through to the real route) and a 403 Response
for anonymous. The first live test (v0.9.13, panel.install run +
fresh-browser logout) showed the gate inert — `curl /dev/draw` returned
200 + editor HTML with no cookie. Two reasons the route-based gate
couldn't work in Kirby v5.2 + this codebase:

- The shared `config.php` declares specific `dev/draw/library/...`,
  `dev/draw/save`, `dev/draw/font-bundle`, `dev/draw/local-fonts`
  routes at top-level options. Those win over routes registered from
  a `ready` callback (Kirby's route option merge order).
- The bare `/dev/draw` URL doesn't resolve via a route at all — it
  resolves via PAGE resolution (`content/dev/draw/` → `template
  draw.php`), which never consults the route table.

Diagnosis trail (worth keeping for future similar puzzles):
1. **Hostname check.** Probe via `probe.php` at the web root dumping
   `$_SERVER['SERVER_NAME']` confirmed it equals `newsitedbart.bbh.fr`
   — matches the filename exactly.
2. **File-loaded check.** Injecting an unconditional
   `file_put_contents('/tmp/marker.txt', ...)` at the top of the
   host-scoped config and curling two URLs showed the marker file
   accumulating one line per request → file IS being loaded.
3. **Route-registration check.** Injecting a probe route at pattern
   `gate-probe` into the same `ready` array and curling `/gate-probe`
   returned 404 → the routes from `ready` weren't reachable for this
   URL at all. Combined with the editor-HTML evidence on
   `/dev/draw`, the conclusion was that the `routes` option merge
   from `ready` is either appended (so config.php's specifics win
   first) or ignored — either way the gate was unreachable.

The fix is mechanically simple but architecturally different: do the
authorization decision INSIDE the `ready` callback BEFORE returning,
using `$kirby->request()->path()` + `$kirby->user()`, and `exit()` on
denial. `ready` runs after the core (including session handling) is
initialized, so `user()` correctly resolves from the cookie. No route
registration is involved.

Live verification after the pivot (v0.9.14):

```
$ curl -sS -o /dev/null -w "%{http_code}\n" https://newsitedbart.bbh.fr/dev/draw
403
$ curl -sS -o /dev/null -w "%{http_code}\n" -X POST https://newsitedbart.bbh.fr/dev/draw/save
403
$ curl -sS -o /dev/null -w "%{http_code}\n" https://newsitedbart.bbh.fr/
200
$ curl -sS -o /dev/null -w "%{http_code}\n" https://newsitedbart.bbh.fr/panel
302
```

`/panel` is untouched (Kirby has its own auth on it); home and other
public pages unaffected; every `/dev/draw/*` URL — page and route —
returns 403 to anonymous requests.

**Panel installer on a public server (v0.9.13).** Kirby refuses to
run the Panel installer on a non-localhost host by default
("The panel installer is disabled on public servers by default"). To
bootstrap the first user, set `'panel.install' => true` as a top-level
option inside the host-scoped config TEMPORARILY, visit `/panel`,
create the first user, then immediately remove the line. The setup
section of `site/config/config.newsitedbart.bbh.fr.php` documents the
exact one-shot procedure. Do not leave the option set; with it on,
anyone hitting `/panel` while `site/accounts/` is empty can create
a new admin.

**Critical filename trap.** On Infomaniak shared hosting,
`hostname -f` on the SSH backend returns the cluster-node name (e.g.
`h2web499`), which is **not** what Kirby's `$_SERVER['SERVER_NAME']`
contains (`newsitedbart.bbh.fr` — the public web hostname). Naming the
config file after the backend hostname silently never activates the
gate. The template's docblock + the checklist both spell out:
**name after the web hostname**, and there's an `error_log()` probe
diagnostic in checklist step 7 for confirming what Kirby actually sees
when in doubt.

**Why this is not Phase 3.** This gate covers the *editor surface* of
`dev/draw/*` with a single check (logged-in Panel user yes/no). It
does NOT yet:
- audit every individual save/upload endpoint for proper auth
  semantics (CSRF, request-method gating, etc.),
- validate MIME/extension on uploaded files (font-bundle POST,
  any future image upload),
- distinguish Panel-user roles (currently any Panel user gets full
  editor access).

Those remain Phase 3 work. The host-scoped gate is the "good enough
to expose to the open internet during early testing" minimum.

**Infomaniak topology, captured once.** Two separate hostnames in
play; future sessions should not confuse them:

| Name | Service | Where it's used |
|---|---|---|
| `newsitedbart.bbh.fr` | HTTPS web frontend | What browsers hit; what Kirby sees in `$_SERVER['SERVER_NAME']`; **what the host-scoped config filename must match** |
| `1m5eb.ftp.infomaniak.com` | SSH/SFTP backend | `HostName` in `~/.ssh/config`; how `deploy.sh` reaches the server |

`deploy.env` carries the alias `newsitedbart` (defined in
`~/.ssh/config` against the SSH backend). `REMOTE_PATH` is
`/home/clients/94e3ce6271e3648b7b00d6c32be0a6e2/sites/newsitedbart.bbh.fr`
— the account-hash directory is stable across the hosting plan.

**Process artifact.** During this slice the
"clarify high-leverage assumptions before acting" rule was violated
once (papered-over unknown SSH user + REMOTE_PATH with TODO comments
instead of asking). User flagged it; recovered by asking and
collecting the real values. Worth re-reading the user's behavioral
preference section below if you're not the same Claude.

### Why `isBlockActive` instead of `bp <= 0` to gate contribution (v0.8.54, v0.8.67)

When a block has `bp === 0` (legitimate start-of-animation state, like scroll
range 0–X at scroll=0), it MUST still contribute its starting value. Old code
used `if (bp <= 0) continue` which skipped this case → default value displayed
→ jump on first scroll. `isBlockActive(i, scrollP, nowSec)` correctly returns
true at bp=0 (when the trigger has fired) and false only pre-trigger. This
pattern lives in two places — opacity composition and pathFollow reverse pass.
Any future "active block contribution" code should use `isBlockActive`, never
`bp <= 0`.

### pathFollow guide resolution chain (v0.8.57, v0.8.60, v0.8.61)

The guide is resolved by trying, in order:

1. `layer.querySelector('[data-master-id="…"]')` where pathRef is a master id.
2. Fallback: line-name lookup if `pathRefName` is set. Walks current class's
   lines, finds match by `(l.name || l.id) === pathRefName`, then finds its
   DOM element by line id.

Hidden lines that are referenced as guides are rendered invisibly
(`visibility: hidden + pointer-events: none`) so the runtime can sample their
geometry without showing them. See `guideMastersNeeded` / `guideNamesNeeded`
pre-scan at the top of `renderClassContent`.

Why the name fallback: per-class master drift exists in some datasets (the
"same" logical line ends up with different masterIds across classes due to
historical save/re-mint cycles). Master id is the canonical identity; name is
the practical fallback.

### Drag-to-reorder and Z-stacking (v0.8.28–v0.8.30)

Sidebar order is the canonical Z. `state.lines` is kept flattened-by-group via
`rebuildLinesInGroupOrder` after every structural mutation. Renderer iterates
`state.lines` in order → SVG paint order → canvas Z. Top of sidebar = first
in array = drawn first = furthest back.

Drag handles:
- Behavior block: title strip is the drag handle. `moveBehaviorBlock` splices
  the array and remaps `loopTo.duration.target` indices via id-preserving lookup.
- Line row: above/below drop reorders within group OR cross-group (changes groupId).
- Group row: distinct drag type (`text/x-group-id`). Cross-class fan-out via
  `forSiblingGroupsByName` (groups identified by name).

ALL-mode fan-out for line/group reorders uses `applyReorderToSibling` which
preserves orphans (items in sibling that don't exist in current) by anchoring
them to their immediate-predecessor shared item from the pre-reorder sibling
sequence.

### Snapshot library (v0.8.34)

`library/<name>/meta.json + content/` is a local backup of the entire content
tree. Gitignored. The editor's Master library modal exposes Save and Load.
Load wipes content/, copies the snapshot's content/ back, then `location.reload()`s.
Schema-version-locked: a snapshot taken under one schema can't be loaded into
another.

### Editor UX batch — Parameters, duplication, relationships, label drag (v0.8.89–v0.8.108)

This batch hardened the editor around editing primitives, understanding
linked objects, and working with dense drawings.

**Parameters section unified (v0.8.93–v0.8.96).** Position X/Y is now
shown for every object kind (primitives AND poly/path/etc.), not just
primitives. For non-primitives the position is the bbox top-left in
absolute coords (was: relative offset, which confused everyone).
v0.8.96 fixed a compounding-delta bug where manual entry of Position
X/Y applied the delta on top of the current `positionOffset` instead
of replacing the absolute value — the writeable target is the offset,
but the field reads/writes in absolute terms.

**Duplicate object / group from side panel (v0.8.92).** The duplicate
clones to a new line (and new master if cloning the only instance of
a master), preserving behaviors. Linked duplicates (Alt-drag of a
linked instance — see below) share the master.

**Group-delete cascade warning (v0.8.97–v0.8.98).** Deleting a group
that holds the only home of certain linked instances WOULD cascade-
delete sibling instances in other classes. The dialog now lists those
collateral instances and offers a three-way choice: Keep (remove only
local lines, masters survive), Delete too (cascade), Cancel.
"Cancel/Delete anyway" was renamed Keep/Delete too because "cancel"
read as "cancel the whole operation". Companion: the line panel now
has a Group selector so a linked object can be moved between groups
without delete-and-recreate.

**Dense-drawing translate affordances (v0.8.99–v0.8.100).** A path
with many vertex handles had no place to grab for translation — every
pixel was a handle. Three orthogonal solutions, all shipped:

1. Arrow keys nudge by `state.nudgeStepMM` (default 1 mm, configurable
   in canvas panel). Shift × 10. Uses `shiftLineBy` + `forSiblingsOf`
   for ALL-mode fan-out.
2. Bbox move grip — orange ✥ square positioned JUST OUTSIDE the bbox
   top-left (offset by its own size + a gap) so it doesn't conflict
   with the bbox handles that conventionally sit at top-left. Its
   pointermove writes via `nudgeSelectionBy(dx, dy, {snapshot: false})`
   to avoid re-rendering handles mid-drag.
3. Alt-drag on ANY handle translates instead of editing the handle.
   Implemented as an early `if (e.altKey) return;` in the vertex/
   primitive handle pointerdown handlers, so the event bubbles to
   the svg-level translate path. Shift is reserved for multi-select;
   Alt is the standard "modify gesture" modifier.

**Linked-duplicate naming (v0.8.100).** When the user creates a
linked duplicate (vs an unlinked copy), the new instance's name gets
a " linked" suffix (no double-append on repeat), making it visually
distinct in the sidebar without changing the underlying master name.

**Instance↔master relationships display (v0.8.101–v0.8.108).** The
big one. To understand a drawing the user needs to see at a glance
which objects share a master. The system:

- `computeMasterRelationships()` walks `state.pageConfig.useClasses`
  to count instances per masterId across the active class set. Masters
  with ≥2 instances anywhere get a sequential letter badge (A, B, …
  AA, AB) via `letterBadge(idx)`. Singletons get no badge.
- **Color**: hues are assigned by golden-angle walk
  `(25° + idx × 137.508°) mod 360`, NOT by hashing the master id.
  Hashing gave color collisions on consecutive letters; golden-angle
  guarantees max perceptual separation. Saturation 70% / lightness 32%
  so white text reads cleanly.
- **Sidebar row badge**: in the line list, every row gets a circle
  slot in the right-side column. The badge gates on **in-class**
  sibling count (filtered to `state.lines`), not the global rel.count.
  Reason: clicking the badge / master chip selects in-class siblings
  only, so cross-class siblings would promise something the action
  can't deliver. Singletons get a hollow neutral gray ring (`.is-empty`)
  instead of nothing — keeps the column visually aligned, reads as
  "nothing to say here".
- **Canvas badge** (`renderLinkBadges`): same gating, same hollow-ring
  for singletons. Visibility gate: showLabels on → all instances; off
  → only selected ones. Pointer events disabled (purely informational).
- **Master chip** in the line panel header: visible only when in-class
  count ≥ 2; clicking selects every sibling in the current class.
  Singletons get no chip (no relationship to surface).
- **Label block now carries the short master ID** as a `[abc12]` prefix
  between the group tag and the name (v0.8.103). Was originally a
  separate floating text element next to the canvas badge — moved into
  the label block for legibility (white background, no hue tint).

**Draggable labels (v0.8.104–v0.8.108) — three SVG gotchas worth
remembering.**

When labels overlap because objects cluster, the user can drag any
label to reposition it. `line.labelOffset = {x, y}` (optional,
additive — no SCHEMA_VERSION bump) stores the displacement; a 2 px
leader in the label border color connects the moved label back to
its anchor. Drag the label back within 2 units of the anchor to clear
the offset (no explicit reset affordance).

The implementation went through three failed attempts. Each surfaced
a real SVG / DOM gotcha:

1. **`pointer-events: all` on a `<g>` is a no-op.** SVG groups are
   not painted, so there's no hit surface. The cursor changes
   (CSS applies) but pointerdown never fires unless a CHILD is hit.
   Fix: put `pointer-events: all` on the painted `.ed-label-bg-outer`
   rect. Children with `pointer-events: none` correctly pass through
   to the rect underneath.
2. **Calling a layer-clearing render mid-drag kills the gesture.**
   `renderLabels()` does `labelsG.innerHTML = ''` — that destroyed
   the dragged `<g>`, released the pointer capture, and silently
   dropped subsequent pointermove events. Fix: mutate `transform` and
   the leader's `x2`/`y2` in-place during pointermove; only call
   `renderLabels()` on pointerup. This pattern applies anywhere else
   where a drag operates on a re-rendered layer.
3. **Lazy leader-line creation.** If the label starts at offset (0,0)
   (no leader yet rendered), the first pointermove has to create the
   leader element on the fly and insert it into `labelsG` before the
   label group. Tag with `data-line-id` so subsequent drags find it.

CSS cache-busting note: `assets/css/dev-draw.css` is included with
`?v=…` in `site/templates/draw.php`, so a `VERSION` bump invalidates
the cache. If a CSS-only change doesn't visually take effect after
hard-reload, check that `VERSION` was bumped.

### Floating-panel infrastructure (v0.8.110, Step 1)

Side-panel disclosure was getting overloaded — keeping everything open
forced the user to hold the whole panel layout in their head. Rather
than redesign the sidebar around progressive disclosure alone, the
direction taken is **free-floating, draggable, non-modal panels**
opened on demand. The side panel will eventually become a high-level
navigator/launcher; topic editors (Behaviors, Parameters, Style,
Master info, Library/Snapshots, per-class Overview) migrate one at a
time to the floating system in subsequent steps.

**v0.8.110 ships only the framework + a stub `demo` panel** — no
existing UI moved — so drag / resize / pin / close / per-class
persistence got validated end-to-end before any user-visible risk.

Architecture:
- `<div id="panel-host">` in `draw.php`: fixed full-viewport overlay,
  `pointer-events: none` itself; individual `.ed-floating-panel`
  children opt back in. Sits outside `.ed-body` so panels can fly
  over the toolbar/sidebar/canvas without fighting the grid.
- `PANEL_REGISTRY` (in `dev-draw.js`): `{ type → { title,
  defaultSize, defaultPos, followsSelection?, render(body, ctx) } }`.
  `register(type, def)` allows late additions.
- `PanelManager`: `open / close / togglePin / bringToFront /
  notifySelection / notifyDataChanged / restore / listOpen`. New
  panels of the same type cascade by +24px and are bumped to the top
  of the z-stack via a monotonically-increasing counter (no actual
  CSS-managed stack — we own it).
- Per-panel state: `{ id, type, objectId?, pinned, x, y, w, h, z }`.
  Persisted as a JSON array under `ed-panels-${pageId}-${classId}` —
  **scoped per class**, since class switches change what's
  selectable. Stale persisted types (a removed registry entry) are
  silently dropped on restore.
- Drag uses the header with pointer-capture; resize uses a corner
  grip element (not CSS `resize:` — that's textarea-only and can't
  coexist with persist). Both persist **on pointerup only**, never
  on every move. Position is clamped so ≥ 40px of header stays in
  the viewport (panels can't be dragged unreachable).
- Pin semantics: clicking 📌 binds the panel to the current primary
  selection's `objectId` and freezes that binding. Pinned panels
  ignore selection changes and look the object up across all
  `byClass` buckets (so a pinned panel survives class switches).
  Unpinning clears `objectId` and re-follows selection.
- Selection hook: a single inline `PanelManager.notifySelection()`
  at the end of `renderSelectionPanel` (already the convergence
  point of ~20 selection-mutation sites). **Do not** try to hook by
  reassigning the function — strict mode + function-declaration
  bindings make that unreliable. Direct inline call is also easier
  to grep for.
- Class switch: `switchClass` ends with `PanelManager.restore()` so
  the new class's persisted panel layout is rebuilt.

Narrow-screen (<768px) fallback: `.ed-panel-host` becomes
`position: static` and floating panels collapse into document-flow
blocks (no drag/resize). Untested in practice; the editor isn't
really usable on a phone anyway.

**v0.8.111** bumped sidebar to 15px and floater base to 15px (from
0.88em ~12.3px). Both were too small for sustained reading.

**v0.8.112 (Step 2a)** lifted the single-select line panel out of
the sidebar into a floating `object` panel that auto-opens on
single-select. `renderLinePanel(line, host, panelState)` — the same
function paints either into the sidebar (legacy) or a floating
panel body. Sidebar's single-select slot now shows just a compact
hint (`name · group · kind` + 🪟 Open/focus button).

**v0.8.113 (Step 2b+c, bundled)** rebuilt the BEHAVIORS section
inside the object panel as a block-name list. One row per block:
`Block N · <trigger> · <effect>` (auto-generated by
`behaviorAutoName`, derived from `trigger.when` and the dominant
param actually set) + ✕ delete button. Clicking a row opens
(or re-binds) a `behavior-block` floating panel positioned to the
right of the parent object panel. One child per parent — clicking
another row re-uses the same child panel. PanelManager gained
`updatePanel(panelId, patch)`, `closeChildrenOf(parentId)`, and
parent/child fields in panel state (`parentId`, `blockId`).
`close()` cascades to children. Binding-change cascade
(`prevBound !== nextBound` for unpinned `object` panels)
auto-closes stale children — moved into `renderPanel` so it fires
regardless of which notify path triggered the re-render.
`renderSelectionPanel`'s fan-out switched from `notifySelection`
to `notifyDataChanged` so non-followsSelection panels
(like `behavior-block`) re-render on block edits / deletes / moves.

Visual: the base panel ring is now the former pinned blue (2px,
`#4f8acb`) so floaters stand off the canvas clearly; pinned panels
take a stronger warm accent (3px, `#e08a2c`).

**v0.8.114 / v0.8.115 (testing-feedback batch on Step 2b+c)**

- `behaviorAutoName` audit: derived effect list from a grep of every
  key written by `updateBehaviorParam` / `updateBehaviorTrigger`.
  Surfaces multi-effect blocks ("translate + stops Brown dotty") and
  cross-object side effects (`trigger.stopObjectId` / `startObjectId`)
  that the v0.8.113 detector missed. Stop/start effects resolve the
  target's master.name (falls back to lines.name, then masterId).
- Always-on multi-block additive paragraph collapsed into an ⓘ icon
  on the BEHAVIORS divider (native `title` tooltip). New
  `.ed-help-icon` style for reuse.
- Group picker stages + confirms before calling `moveLinesToGroup`;
  cancel reverts via `notifyDataChanged`. Single-membership model
  confirmed (no multi-group UI needed).
- Hard-stick parent/child panels: dragging any panel in a tree moves
  every member by the same delta (root resolved via
  `findRootPanelId`, snapshot via `collectTree`, applied in
  `onMove`). Resizing a parent slides children to track the new
  right edge (`repositionChildrenOf`).
- Behavior-block panels get a brighter teal ring (3px, `#4fe0c8`) via
  `.ed-floating-panel--block` so the child/peer distinction reads at
  a glance.
- **Bug fix in `close()`**: delete-before-recurse + self-exclude. Old
  order (recurse → delete) opened a stack-overflow door if any
  parentId cycle ever existed in `panels`. Cycles shouldn't be
  reachable today, but defense-in-depth — the recursive close should
  not depend on `parentId` graph correctness.
- **v0.8.116**: re-clicking an already-selected single object on the
  canvas now reopens its closed floating panel (canvas click handler
  short-circuits `renderSelectionPanel` when selection doesn't change,
  so the auto-spawn check is mirrored inline in the
  `pressedSelected` branch).
- **v0.8.117**: per-type "last seen" geometry memory. On close, a
  parent-less panel's `(x, y, w, h)` is saved under
  `ed-panel-lastpos-<pageId>-<classId>` (one slot per panel type).
  On open without explicit geometry, that slot wins over the
  registry default — so a close-then-reopen (whether for the same
  object or a different one) lands the panel where the user last
  parked it. Child panels skip this — their position is derived
  from the parent via hard-stick.

**v0.8.119 (Step 2d)** lands the multi-select fan-out: every time the
selection set grows to 2+ objects, one pinned 'object' panel opens
per selected object (skipping objects that already have a pinned
panel). When the new-panel count exceeds
`state.multiSelectPanelLimit` (Settings → "Multi-select panel limit",
persisted via `ed-multi-panel-limit`, default 5), a confirm() asks
the user before fan-out. Dedup memo `lastMultiSpawnKey` (sorted-ids
joined) prevents re-firing on every render of the same set;
collapsing to single/empty selection clears the memo. Default
positions cascade via the existing `open()` +24px-per-same-type
nudge. Settings dialog grew a new `settingNumberRow` helper for
the numeric input.

**v0.8.120 (Step 2d polish)**: cascade restored on top of `lastPos`
(multi-spawn panels were stacking at the remembered position because
`lp.x/y` overrode `defPos + dx`); confirm() deferred via
`requestAnimationFrame` so the selection paint lands before the modal
blocks the UI. `lastMultiSpawnKey` is set immediately at the top of
`spawnMultiSelectObjectPanels` so the deferred body can't re-fire.

**v0.8.127 (behaviors Phase A — progressive disclosure + block nav)**:
first slice of the behaviors-block redesign (#10).

1. Progressive disclosure inside `renderBehaviorBlock`. Replaces the
   v0.8.19 `setInactive`-dim approach with conditional rendering:
   - Range row only when `when === 'scroll-range'`
   - Trigger-key / Reaches / Repeat only when `when === 'scroll-key'`
   - Delay only when not the scroll-range × scroll-driven combo
   - Seconds + Easing only when `dmode !== 'scroll'`
   - Pivot Δx/Δy + set-origin only when resolved rotate ≠ 0
   - Opacity from/to only when Fade-opacity is on
   - Direction only when resolved drawIn is true
   Values for hidden axes stay in the data model so flipping a mode
   back restores the inputs intact — same persistence guarantee the
   dim approach gave, with a cleaner panel.

2. Block prev/next nav in the card head (‹ ›). Rebinds the current
   block panel to the adjacent block instead of opening a second
   panel — keeps "one floating panel per block" while letting the
   user step through the sequence without bouncing back to the
   parent object panel. Disabled at the ends; only shown when
   `panelState` is passed and there's more than one block. Title
   now reads "Block N / M" to make position visible.

   `renderBehaviorBlock(line, blockIdx, group)` gained a 4th arg
   `panelState`. The 'behavior-block' panel registry render passes
   `ctx.panelState` through. CSS for `.ed-behavior-nav` /
   `.ed-behavior-nav-btn` added next to `.ed-behavior-remove`.

Phase B (effects "+ Effect" menu, removable rows, opt-in tracking)
is the next slice, deferred until A is validated.

**v0.8.125 (no auto fan-out, objectId-aware opt-click)**: two fixes
to the gesture model:

1. Removed the auto multi-select fan-out call inside
   `renderSelectionPanel`. shift-click in the canvas or sidebar to
   extend a selection no longer auto-spawns N pinned object panels —
   selection and panel-opening are independent intents.
   `spawnMultiSelectObjectPanels` is kept as a callable helper for a
   future explicit "open panels for all" affordance, but never auto-
   fires.

2. opt-click panel toggle now matches by `objectId` instead of just
   "is there an unpinned follower." Previously, opt-clicking an
   object that already had a pinned panel (e.g. from an earlier
   manual pin, or from the now-removed auto fan-out) opened a
   *second* unpinned panel for the same object. New logic in
   `toggleObjectPanelFor(objectId)`:
   - if a pinned panel exists with `objectId === target` → close it
   - else if the unpinned follower exists AND target is
     `selectedIds[0]` → close it
   - else open one — unpinned if target is the primary selection,
     pinned-for-target otherwise
   
   The call site passes the actually-clicked id (the topmost hit at
   the click point), not `selectedIds[0]`, so opt-clicking a non-
   primary object in a multi-select opens a panel for the object
   the user actually pointed at.

**v0.8.124 (opt-click for panel, cmd/shift back to multi-select)**:
corrected v0.8.123's modifier map per user feedback. cmd-click and
shift-click are standard multi-select extend gestures and shouldn't
have been repurposed. opt (alt) is now the panel-toggle modifier.
The "plain re-click reopens a closed panel" gesture from v0.8.123
was dropped — too implicit, conflicts with selection-cycle. Final
map: alt → panel toggle; shift/cmd/ctrl → multi-select extend;
plain → pure selection cycle, no panel side effects. No deferred
logic in the click path — toggle fires immediately on the pointerup
that recognized opt-click.

**v0.8.123 (explicit panel-open gesture)**: removed the single-select
auto-spawn of the 'object' follower panel. First click on an object
now JUST selects — the user might be about to drag, extend the
selection, or open the panel, and the previous "open on every fresh
selection" behavior fought drag-to-move and shift-extend. The panel
is now opened by an explicit gesture handled in the canvas pointerup
code:

- Plain re-click on the *already-selected single* object → toggle
  the follower panel (open if closed, close if open).
- Cmd-click (alone, no shift) on any object → one-shot select +
  panel toggle. If the hit object isn't selected, it becomes the
  sole selection; the follower panel is then toggled. Cmd-click on
  an already-selected object with panel open → closes it.
- Shift-click keeps its existing multi-select extend semantics
  (toggleInSelection) — split out from the old combined
  "modifier-click" branch.
- Empty-area click → clear selection (unchanged).

Mechanics: `selectionAtPointerDown` is snapshotted at pointerdown,
*before* any implicit selectOnly fires for the first-click-on-an-
unselected-line case. pointerup compares the post-click new
selection against that pre-down snapshot; the toggle only fires
when the object was already selected before the gesture started,
which cleanly separates first-click-to-select from re-click-to-
toggle. `toggleObjectFollowerPanel` is the shared helper. The
v0.8.116 inline auto-open inside the pointerdown `pressedSelected`
branch was removed — its job is now done by the pointerup toggle.

Multi-select fan-out (Step 2d) is intentionally kept — shift-click
extending past 1 is itself an explicit "I want to work with multiple
objects" gesture, so auto-spawning per-object panels there is still
aligned with user intent.

**v0.8.122 (double-rAF for multi-spawn confirm)**: single rAF in
v0.8.120 fired pre-paint, so `confirm()` still beat the highlight to
the screen. Double rAF defers the body to the start of the next
frame, guaranteed after the current frame paints.

**v0.8.121 (lastPos drift fix)**: applying `+dx` to `lastPos` (v0.8.120)
created a subtle drift bug — a cascaded multi-spawn panel closed in
place would persist `lastPos + 24px`, then the next spawn would cascade
off the new position, then close → `+48`, etc. Each multi-select cycle
walked the memory away from where the user actually parked panels.
Fix: track `userPositioned` per panel state. Set true only in the
header drag `onUp` (for the entire tree via `collectTree`) and the
resize `onUp` (single panel). `close()` gates `rememberLastPos`
behind this flag, so auto-positioned panels (default / lastPos
restore / multi-spawn cascade) leave the memory untouched on close;
only panels the user actually dragged or resized overwrite it.
`userPositioned` is included in the `persist()` snapshot and threaded
back through `open()` from `restore()` so the flag survives reloads.

Next sub-step (none locked).
Subsequent steps: Parameters / Style / Master info as separate
panel types if the object panel grows unwieldy; per-class Overview;
final sidebar redesign as a navigator over the launchers.

### Panel UX polish batch (v0.8.128–v0.8.152)

Follow-ups on the floating-panel system once it carried real
content. Notable mechanics:

- **Block panel head replaced by nav strip (v0.8.128–v0.8.130).**
  Inside the floating-panel variant the legacy "Block N / M · ×"
  head duplicated the panel title bar. Strip it (`.ed-behavior-block--inpanel`
  zeroes background/border) and render `.ed-behavior-nav` at the
  top of the body: full-width Previous / Next buttons that rebind
  the panel to the adjacent block (one panel per block, navigation
  in place). Buttons stretch with `flex: 1 1 0` so they fill the
  card width (v0.8.150); labels are full words, not glyphs
  (v0.8.151).
- **Per-type "last-seen" geometry (v0.8.117) refined further.**
  `userPositioned` flag now gates `rememberLastPos` so auto-
  positioned panels (cascade / default / restore) don't pollute the
  memory slot — only drag/resize commits a new position.
  Persisted along with the panel snapshot.
- **Restore guards (v0.8.152).** `PanelManager.restore()` skips
  follows-selection panel types when no selection exists on
  startup — used to spawn an empty object panel every page load.
- **Opt-click is the panel-toggle modifier (v0.8.123 → v0.8.148).**
  Iterated map: shift/cmd/ctrl = multi-select extend; alt (opt) =
  panel toggle. `toggleObjectPanelFor(objectId)` resolves
  pinned-for-target / unpinned-follower / open-new based on
  `objectId`, not `selectedIds[0]`, so the click hits the object
  the user actually pointed at (v0.8.125). Empty-canvas opt-click
  closes the unpinned object panel (v0.8.143). Opt-click on a
  different object lets an existing unpinned follower rebind
  rather than close+reopen — keeps geometry stable (v0.8.145).
  v0.8.146 fixed the missed-rebind case for already-selected
  objects.
- **Sidebar 🪟 button: four-state correctness (v0.8.140–v0.8.142).**
  No panel / unpinned matching / unpinned other-object / pinned-
  for-target. Switching objects from a stale rebound unpinned
  panel needed an explicit close-then-open sequence (v0.8.142)
  because rebinding an unpinned follower mid-flight would silently
  cancel the new-target open.
- **Keyboard nudges split (v0.8.147–v0.8.148).** Arrow keys nudge
  selected objects (existing behavior); Shift+Arrow pans canvas
  *and* every floating panel in lockstep (so panels don't drift
  off-screen relative to objects after a pan); Option+Arrow moves
  the focused panel only. Arrow-key focus targets the panel, not
  the canvas, when a panel has focus — avoids the panel-vs-canvas
  intent ambiguity. Help modal lists Option+Arrow under Panels
  (v0.8.149).

### Behavior block — progressive disclosure redesign (v0.8.153–v0.8.169)

The largest UX redesign of the block panel since v0.8.127's first
slice of conditional rendering. The block panel now reads as a
short guided wizard: pick activation → pick progress → configure
effects, with previous choices locked behind a back-arrow and the
options for the current step shown inline.

- **Four-phase model.** `behaviorBlockPhases` (session-only
  in-memory `Map<blockId, 0|1|2|3>`):
  - **Phase 0** — trigger picker visible, no chip active.
  - **Phase 1** — trigger picked → collapsed to a single chip +
    small back-arrow; trigger-specific options + delay/treatAsFilled
    visible; a Continue → button advances to phase 2.
  - **Phase 2** — progress picker visible (all options, none
    active); chips/back-arrows for trigger remain; "Also" section
    opt-in row visible.
  - **Phase 3** — progress collapsed to chip + back-arrow; progress
    config (Seconds / Easing / loopTo target) visible; "What
    changes" effects section visible. Default phase for already-
    saved blocks (`getBlockPhase` defaults to 3) so opening an
    existing block doesn't replay the wizard.
  - `setBlockPhase` can decrease (back-arrows do this);
    `advanceBlockPhase` is monotonic with a fallback to 3 — fixes
    the v0.8.160 bug where existing blocks regressed to phase 1
    on edit.
- **Summary strip + flash (v0.8.153).** `behaviorSummaryText` builds
  a plain-English description of the (activation × progress)
  combo, painted in a warm red strip at the top of the card. A
  separate `behaviorDriftSummaryText` line covers translateMode
  (drift / path-follow). `refreshBehaviorSummary` updates them in
  place when a field changes without a full panel re-render, with
  a 1s flash so the eye notices. Hooked from `updateBehaviorParam`
  for translateX/Y, translateMode, pathRef, pathRefName,
  pathAlignToTangent, pathEndMode.
- **Locked chip + back-arrow pattern (v0.8.163–v0.8.165).** Once
  the user picks a trigger or progress mode, the picker collapses
  immediately (not at Continue) to a single highlighted chip. The
  chip itself is display-only (`.is-locked-chip` — no cursor, no
  hover effect); the only back affordance is a small arrow button
  (`makeBehaviorChipBack` → `.ed-behavior-chip-back`) rendered
  flush right of the chip via `appendLockedChip(card, value,
  label, onBack, tooltip)`. Single consistent back path at both
  trigger and progress steps; no double affordance (chip-click +
  Back button was the v0.8.165 fix).
- **Continue with validation refusal (v0.8.158–v0.8.159).** Phase 1
  → 2 advancement is gated. scroll-key requires a non-empty
  selector; refusal triggers a shake animation on the Continue
  button (`behaviorContinueShake` keyframes) and a red border on
  the required input. Once typing begins, the red border clears.
- **Disabled-with-explainer pattern.** Trigger / progress buttons
  that don't apply in the current combo are shown
  `.is-disabled` (dashed grey) instead of hidden; clicking them
  triggers an `alert()` with a sentence-long reason. Two such
  rules currently:
  - "After previous ends" needs a prior block whose progress is
    Timed.
  - "Scroll-driven" needs activation = Scroll range.
  - "Loop back to earlier block" needs a prior Timed block.
- **"Also control other objects" opt-in (v0.8.158).** The
  cross-object Start/Stop fields (`startObjectId` / `stopObjectId`)
  used to occupy permanent panel real estate. Now hidden behind a
  dashed `+ Also control other objects` button at phase ≥ 2. Once
  expanded, an SVG × button on the section title row collapses it
  back and clears both target ids (so the section stays hidden on
  next render). Backward-compat: if a saved block already has
  side-effect values, the section auto-opens. Session-only opt-in
  Set: `behaviorShowSideEffects`.
- **In-panel spacing + dividers (v0.8.168–v0.8.169).**
  `.ed-behavior-block--inpanel` becomes a flex column with
  `gap: 0.5rem` so every child (fields, button groups, chips,
  section titles) gets the same vertical rhythm as the object
  panel's `.ed-settings` grid. Within the "What changes" section,
  unrelated property groups (rotate / opacity / draw-in) are
  separated by a thin `.ed-behavior-prop-divider` (1px #333 — same
  hairline as section-title border-tops, so within-section and
  between-section dividers read as the same separator system).
- **Other touch-ups in this batch:**
  - Field-row sizing inside the block panel: number/checkbox fields
    use `1fr 5em` / `1fr auto` grids; select/text fields use
    `minmax(5em, max-content) 1fr` so labels like "At end of path"
    don't wrap (v0.8.156, v0.8.166).
  - SVG × on "Also" section title row replaces the old 1.1em
    glyph (was nearly invisible). Sized to match the back-arrow
    (1.5rem button, 75% SVG fill). Prompted the new global
    "Icon sizing — never ship microscopic icons" rule (in
    `~/.claude/CLAUDE.md`, with `.ed-behavior-chip-back` cited as
    the size benchmark for icon-only buttons).
  - Trigger button labels use `white-space: nowrap` to prevent
    multi-word labels (e.g. "Loop back to earlier block") from
    wrapping mid-button (v0.8.164).
  - Modal z-index lifted above floating panels — the explainer
    alerts and confirms were rendering underneath (v0.8.161).

### Sidebar group rows + group panel polish (v0.8.171)

Two small ergonomic fixes after the main block-panel batch:

- **Group panel action buttons stacked.** The group's settings
  panel (sidebar) used the unstacked `.ed-actions` layout — three
  long labels ("Duplicate group, new masters" /
  "Duplicate group, same masters" / "Delete group") sitting
  side-by-side wrapped mid-button. Switched to
  `.ed-actions ed-actions--stack` (same idiom the object panel
  uses) for full-width stacked buttons. Renamed the formerly
  "(linked)" variant to "same masters" to read as a clearer
  counterpart to "new masters".
- **Auto-fit group names in the sidebar list.** Long group names
  ("Group 4 copy 2") used to wrap inside their row. Post-append
  fit pass in `renderGroupsList`: for each `.ed-group-name`,
  temporarily force `white-space: nowrap` and read
  `scrollWidth > clientWidth`; if overflowing, try one font
  shrink of 2px (≈1.5pt, within the user-specified 2pt budget at
  the editor's ~15px base) and re-measure. If it fits → keep
  nowrap + smaller size. If still doesn't fit → fully restore
  (let it wrap at the original size, same as before). Robust
  against the row's other children — the available width is
  measured directly from the flex layout, not estimated.

### Project hub modal — slice 1 (v0.8.173)

The toolbar's "▦ Library" button was renamed to "▦ Project" and now
opens a new hub modal (`showProjectDialog`) that supersedes
`showLibraryDialog`. The previous library modal had been accreting
unrelated affordances (Snapshots, Orphans) because there was no
better home for them — the rename and refactor address that drift.

Architecture:

- **Home view** — 2×2 tile grid: **Master library**, **Overview**,
  **Orphans**, **Snapshots**. Each tile shows a label + one-line
  hint and routes via `setView(view)`.
- **Sub-section view** — header swaps title + reveals a Back chip
  (`‹ Back`) returning to home. Top-right `×` always cleans up the
  whole overlay regardless of depth.
- **Master library** sub-section reuses the original library body
  (search input + class-filter chips in the header + master rows
  with preview/meta/chips/actions). Class-filter row is created
  once in the header and shown/hidden per view. `renderRows()`
  guards against being invoked before the masters body is mounted.
- **Overview** sub-section: stub message — its dedicated panel
  (stacked *above* the Project modal) ships in slice 2.
- **Orphans / Snapshots** tiles currently close the Project hub and
  launch their existing sibling overlays (`showOrphansDialog`,
  `showSnapshotsDialog`). Folding them into proper inline
  sub-sections is a later slice — the existing overlays already work
  and have their own state machines; absorbing them now would bloat
  this slice.

HTML id `library-btn` is kept for backward compat; only the
`textContent` and click handler changed. Existing CSS for
`.ed-library-*` (rows, search, filters, etc.) is untouched and
inherited by the Master library sub-section — new CSS is scoped to
`.ed-project-*` (modal width, header, back chip, tile grid, stub).

### Overview panel — slice 2 (v0.8.176–v0.8.191)

The Overview tile on the Project hub opens a dedicated panel that
stacks **above** the hub overlay (z-index 60 vs the standard
modal's 50). Both overlays stay in the DOM simultaneously, so
**Back** removes only the overview and the hub is immediately
interactive again — no rebuild, no lost state.

Layout (v0.8.177 settled sizing):

- Panel sizes to `98vw × 95vh` (no min/max) — Overview is the
  primary thing on screen while open; small breathing margin only.
- Header: Back chip · "Overview" title · class chips
  (defaults to `state.classId`) · close × (closes BOTH layers).
- Search row directly under the header (above the scrolling body)
  so filters stay visible while scrolling.

Per-class body (single-class default — diff mode is slice 3):

- Iterates `state.groups` order. Group rows reuse the editor's
  `.ed-group` / `.ed-group-row` / `.ed-group-toggle` / `.ed-group-name`
  / `.ed-group-count` classes — same visual language as the
  sidebar. Read-only: eye / delete buttons aren't rendered.
  Group head is `position: sticky` so its context stays visible.
- Hidden groups and hidden lines are excluded.
- Each line row is two columns:
  - **Vignette** — left, reuses the Master library's
    `buildPreview(master|line)` helper (hoisted to module scope in
    v0.8.177 specifically for this reuse). Visual continuity
    between Master library and Overview rows. Falls back to using
    the line itself when there's no master link.
  - **Main** — object name (jumps on click) · `N block(s)` chip ·
    `Details ▾` toggle (only when blocks present) · one-line per
    behavior via `behaviorAutoName(block, idx)`.

Details toggle: clicking expands an inline detail panel under the
row showing, per block, `behaviorAutoName` as a sub-header and
`behaviorSummaryText(block)` as a prose paragraph (same content the
sidebar's behavior block summary uses). Toggling re-collapses.
Centralizing through these two formatters means future block-
semantics changes flow into the overview automatically — no
parallel change list to maintain.

Jump-to-canvas hide-and-resume:

- Clicking the vignette OR the object name calls `jumpToLine(line)`:
  switches class if needed (`switchClass`), opens the line's group,
  `selectOnly(line.id)`, `renderAll()`, then sets `display: none`
  on both the overview overlay and the hub overlay.
- A floating "Resume overview" chip appears centered at the bottom
  of the viewport (`z-index: 70`). `↩ Resume overview` re-shows
  both layers and removes the chip; the `×` closes both layers for
  good.
- Because layers are hidden (not removed), search query, class
  selection, scroll position and any expanded Details panels are
  all preserved across the jump.

Helper hoist (v0.8.177): `buildPreview(master)` and
`previewViewBox(line)` moved from `showProjectDialog`'s closure to
module scope. Both depend only on module-level helpers
(`computeLineD`, `resolveStroke`, `SVG_NS`), so the hoist was
mechanical — no API change. The inner duplicates in
`showProjectDialog` were removed.

Drag + resize (v0.8.179): the overview is movable (drag the header
row anywhere except buttons/inputs) and resizable (bottom-right grip
handle). Implemented inline in `showOverviewPanel` — lightweight,
not registered with `PanelManager`, no per-page persistence. The
overlay's flex-centering is disabled so the panel can be absolutely
positioned (`initGeometry` centers it at 98vw × 95vh on open).
Header `cursor: move`; clicks on `button/input/select/a` inside the
header don't initiate a drag. Mouse listeners are removed on close.

Click mapping (v0.8.180 → v0.8.181): the row's two affordances were
swapped from the slice-2 default. The button to the right is now
**On canvas** and calls `jumpToLine(line)` (rendered on every row,
since jumping is useful even when there are no behaviors). Toggling
details is the row's own click — the WHOLE row is the click target
(v0.8.181 widened this from "object + name only" because aiming at
the small name was fiddly). The "On canvas" button's handler calls
`e.stopPropagation()` so clicking it does not also toggle details.
Rows with zero blocks are non-clickable for toggling (cursor stays
default). v0.8.183: row no longer carries a `title=` tooltip — it
fired on every hover and was intrusive; the pointer cursor + the
adjacent "On canvas" button already communicate the affordance.

Per-class data rendering (v0.8.190–191): groups are stored
per-class (`state.byClass[cid].groups`, each with a distinct id —
the addGroup fanout assigns a fresh id per class even when names
match). The overview's renderBody reads from
`state.byClass[activeClassId]` for both lines AND groups; the
earlier `state.groups` getter pointed at the EDITOR's currently-
selected class, which produced wrong (or absent) groups when the
user switched class chips in the overview. Empty groups now render
(sidebar parity) — the prior "skip if no lines" rule made distinct
class group lists visually identical when their extra groups
happened to be empty. Search-filter still drops groups that match
neither by name nor by any line. Group names and object names now
include "(id)" — same disambiguation rule as the behavior side-
effect labels.

Header toolbar state-button convention (v0.8.189): the "All details"
button uses an outline-always-visible style — accent border is shown
in both states; only the label changes ("All details" ↔ "Hide
details"). This differs from the per-row `.ed-overview-details-btn`
(neutral border off / accent on) and the top-toolbar `.ed-tool`
(same neutral-off/accent-on). The user's explicit convention call:
outline = "this is a toggle", label = "current state". Dedicated
class `.ed-overview-alldetails-btn` keeps it from drifting into the
per-row toggles.

Header toolbar (v0.8.184–185): "All details" state-button sits on
the LEFT, grouped with the class chips — the toolbar reads left-to-
right (navigation chips → global action → close × at the far right).
A flex-grow `ed-overview-toolbar-spacer` between the button and ×
pushes the close to the edge. Button follows the app-wide state-
button convention: accent outline when active + label swap ("All
details" ↔ "Hide details"). Clicking toggles `is-details-open` on
every existing row; `allDetailsOpen` flag also seeds rows freshly
built by search-filter re-renders.

Detail body composition (v0.8.182): the block's detail box renders
up to three lines — `behaviorSummaryText` (trigger × duration +
cross-object side effects), `behaviorEffectsText` (per-effect
values: translate / rotate / fade / opacity / draw-in), and
`behaviorDriftLineText` (drift or path-follow, when applicable).
The translate part of effects is suppressed when `translateMode`
is a drift, since the drift line covers it. behaviorEffectsText
returns null when there are no animated params, so the line is
skipped instead of rendering an empty placeholder. All three
helpers are reused by the sidebar block-summary too — single
source of truth.

ID display in detail prose (v0.8.179): `behaviorSummaryText` and
`behaviorAutoName` both resolve `startObjectId` / `stopObjectId` to
`name (id)` rather than either bare. Earlier code emitted the raw
masterId for stops (`stops "m-bnpe9wzv"`). Decision rationale: the
ID is useless on its own but indispensable as a disambiguator when
multiple objects share a name, so neither pole works alone — combined
format is the rule everywhere these labels are formatted.

Project hub button labels for Orphans / Snapshots now route through
those dialogs' optional `onBack` callback (v0.8.174), which prepends
a `‹ Back` chip to the dialog header. Because `.ed-modal-header`
uses `justify-content: space-between` with no gap (unlike
`.ed-project-header` which has `gap: 0.5rem`), the inline back chip
is given `marginRight: 0.5rem` to match the visual rhythm of the
hub's own header (v0.8.175).

### Text overlays + Google Fonts bundle (v0.8.180–v0.8.209)

**Slice 1 (text overlay):** masters can carry an optional `text` property
(string + fontFamily + fontSize + fill + offsetX/Y). When set, the editor
and runtime both render an SVG `<text>` anchored at the line's natural
center (centroid for paths, geometric center for primitives), offset by
the master's offsetX/Y. Side-effects (translate/rotate/fade) inherited
from the parent group; text is a child of the line's `<g>`, not a
sibling.

Disclosure pattern (per the "progressive disclosure" rule in CLAUDE.md):
TEXT section in the object panel is hidden by default; `+ Add text`
button discloses it; the `[×]` close button clears the text object and
hides the section again. Section auto-opens if `master.text` exists on
load.

**Slice 2 (Google Fonts bundle) — basic flow shipped at v0.8.207–v0.8.209:**

The runtime/editor need to know which Google Fonts to load (preview in
editor; render at runtime). Initial design explored a bookmarklet
running on fonts.google.com (curate → POST to local endpoint) — the
code still ships (`assets/js/fonts-bookmarklet.js` + `dev/draw/fonts-bundle`
generator page) but the flow is fragile due to mixed-content blocking
when the dev server is HTTP and Google Fonts is HTTPS.

**Pivoted to a basic flow:** Settings modal has a "Font bundle" textarea
where the user pastes family names (one per line). Save POSTs to
`/dev/draw/font-bundle`, which validates each name against
`^[A-Za-z0-9 '\-]{1,64}$`, dedupes, sorts, and writes
`content/_shared/font-bundle.json` (gitignored).

- Editor loads the bundle once at startup via `loadFontBundle()` →
  populates `state.fontBundle` array.
- `injectGoogleFontsLink()` unions the bundle with content-used
  families when building the `<link rel="stylesheet">` for editor
  preview.
- The TEXT section's "Font family" field is a combobox
  (`fontFamilyField` in dev-draw.js, v0.8.208/209): free-text input
  + explicit `▾` button opening a custom popup. Each option is
  rendered in its own face so the user previews the typography
  in-place. Dark-themed (`#2a2a2a` bg, `#e8e8e8` text) to match the
  editor.
- A bare `<datalist>` was tried first and rejected — discoverability
  is too poor across browsers (Safari requires typing; Chrome shows a
  faint marker; no way to force-open programmatically).

**Endpoint contract** (`site/config/config.php`):
- `GET  /dev/draw/font-bundle` → `{ok, fonts: [...]}`
- `POST /dev/draw/font-bundle` (body: `{fonts: [...]}`) → validates,
  writes, returns `{ok, fonts, count}`.
- CORS: only `https://fonts.google.com` is allowed as cross-origin
  (legacy bookmarklet path).

**Pending Slice 2a-4:** runtime (`app.js`) needs to fetch / be served
the same font-bundle.json so its `<link>` includes bundled families
even when no content master currently uses them. Currently the editor
side is the only beneficiary; the runtime only loads families actually
referenced by content masters.

**Deferred:** server-side validation against the Google Fonts
Developer API (would catch typos, return richer metadata). The current
regex validation just protects against malformed input; a typo silently
passes.

### textBlock + scrollMode + group templates + block disable + move-on-canvas (v0.8.210–v0.8.272)

The most recent work batch. Several independent threads, listed in
roughly the order they shipped.

**Group behavior template (v0.8.210–v0.8.224, tasks #23–#25).** Groups
gained an optional `behaviorTemplate` array — same shape as a line's
`behaviors[]`. Lines inside a group that has a template adopt the
template's behaviors at runtime resolution time (in
`resolveInstanceJS`), unless the line carries its own behaviors (line
behaviors win — explicit override). Editor: group panel picker lets
the user pick a "donor" line whose behaviors become the template;
visual marking on member lines indicates "this line is following the
group's template." Schema bumped v10→v11 to drop the old
"per-group-default-behaviors" shape (the unused predecessor). Bump
was authorized.

**scrollMode (v0.8.225–v0.8.231, tasks #29–#31).** New page-level
config: `pageConfig.scrollMode` ∈ `'standard' | 'windowed'`. Standard
= existing pin/long-scroll behavior. Windowed = the page acts as a
fixed viewport; scroll range maps to a virtual longer scroll without
the body actually growing — useful for "scene"-style pages where
content is layered, not stacked. Schema bumped v11→v12; existing
content silently defaults to `'standard'` via migration.

**textBlock kind (v0.8.232–v0.8.258, tasks #26–#28).** A new line
kind, complementary to the master-`.text` overlay shipped in
v0.8.180-batch:

- **Slice 1a** (v0.8.232–v0.8.234): geometry. `kind: 'textBlock'`
  with `params { x, y, w, h }` — a rect on the canvas. Editor draws
  the frame as a white outline (`stroke="#fff"`, low opacity) so the
  user sees where text will land.
- **Slice 1b** (v0.8.232–v0.8.241): text rendering inside the rect.
  Multi-line input → `<tspan>` per line with `x=` re-anchored and
  `dy` per line; `xml:space="preserve"`. Anchor = top-left at the
  rect origin offset by `text.offsetX/Y` (not first-line baseline —
  v0.8.234–v0.8.237 walked through the various baseline attempts and
  settled on top-edge as the simplest mental model). Color comes
  from the palette (v0.8.238). Runtime hides text overlays until
  fonts load to avoid FOUT flash (v0.8.239). Word-wrap + clipPath
  for overflow at the rect bounds (v0.8.241): `<clipPath
  id="ed-tbclip-<lineId>">` containing a rect matching the
  textBlock frame; the text element gets `clip-path="url(#…)"`. Any
  text that exceeds the frame is clipped.
- **Slice 1c** (v0.8.258): htmlKey field + duplicate detection. Each
  textBlock can carry an `htmlKey` string identifying it as the
  authoring source for a named slot on a Kirby page (groundwork for
  Phase 2 wiring). Editor flags duplicate keys per page.
- **stroke-width 0 accepted on all kinds incl. textBlock** (v0.8.242)
  — the textBlock frame needs to be hideable.

**Block disable (v0.8.259–v0.8.263, Slice 1).** Per-block design-time
mute. Each behavior block can be toggled OFF (`disabled: true`) from
its row in the BEHAVIORS list — a small power-icon toggle on each
row. Disabled blocks are skipped at runtime via
`isBehaviorBlockDisabled(block)`. Visual: row gains
`.ed-block-row.is-disabled` (background `#770033`, outline
`#ff0000`, diagonal stripe overlay — v0.8.263). `cloneBehavior`
preserves the `disabled` flag through `resolveInstanceJS`'s
behavior-cloning pass so the runtime sees it.

Two regressions from the v0.8.260 first pass, both fixed in v0.8.261:

1. **"Cannot disable nor reactivate a block."** The toggle handler
   queried `selectionPanel.querySelector(...)` to find the row to
   update, but block rows live in the **floating** object panel, not
   the sidebar selectionPanel — the query returned null, no UI
   update happened, and the user clicked twice (which double-toggled
   the data, returning it to its original state). Fix: pass the
   clicked `row` element from the click handler directly + fall back
   to a document-wide `querySelectorAll` for any other open panel
   showing the same block.
2. **"Block 1 disabled; add a block: block 1 becomes enabled."** Same
   root cause — double-click on a non-updating UI flipped the
   underlying data.

**Panel scroll-jump fix (v0.8.262).** Many actions
(`notifyDataChanged()`) trigger `renderPanel(p)` on every open
floating panel, which does `p.body.innerHTML = ''`. innerHTML reset
zeroes `scrollTop`, so an object panel scrolled to the middle of a
long block list would snap back to the top every time the user
toggled disabled, added a block, deleted a block, etc. — even on
panels the action wasn't aimed at. Fix: save `p.body.scrollTop`
before the wipe, restore after re-render. Same pattern in
`renderSelectionPanel` (sidebar). Cheap; preserves scroll across
arbitrary panel re-renders.

**Move-on-canvas (v0.8.264–v0.8.272).** New textBlock affordance.
Below the existing "Set on canvas" button in the textBlock's text
section, a "Move on canvas →" button enters a transient drag mode:

- Overlay rect (amber dashed, `#ffaa00`, `cursor: grab`) is painted
  over the visible text bbox in `handlesG`.
- Dragging the overlay updates the text's `offsetX/Y` live via a
  transient `transform="translate(dx,dy)"` on the SVG text element
  (avoids a full `renderLines()` mid-drag — same lesson as the
  draggable-labels batch v0.8.107–v0.8.108).
- On pointerup the offset is committed, mirrored to every instance
  of the master, and `renderLines()` runs once.
- The button itself relabels to "✓ Validate this position" while
  active, with a pulsing accent treatment.
- Esc cancels (snapshots `entryOffsetX/Y` at mode entry,
  `cancelMoveTextOffset` reverts) — the Esc-cancels-button-validates
  asymmetry is the standard editor pattern (v0.8.265).
- **clipPath sync fix** (v0.8.265): `syncTextOverlayPosition` was
  updating the SVG `<text>` element's `x/y` but not the
  `clipPath id="ed-tbclip-<lineId>"`'s rect. After dragging a
  textBlock far from its original position the text would disappear
  — still clipped at the **frozen** original rect. Fix: rewrite the
  clipPath rect's `x/y/w/h` whenever `syncTextOverlayPosition`
  updates a textBlock's frame. Lives at `dev-draw.js` ~line 688.

**Out-of-bounds band (v0.8.266–v0.8.271).** Strong visual hint that
text dragged outside the textBlock rect will be clipped: a striped
red ring 30 user-units wide hugging the textBlock frame on all four
sides. **Implementation gotcha worth flagging**: the first three
attempts used `<path fill-rule="evenodd">` with two subpaths (outer
rect, inner rect) for the ring shape, with `fill="url(#stripes)"`
for the pattern. None of them rendered — the band was completely
invisible while a sibling amber `<rect>` rendered fine. v0.8.270
diagnostic confirmed a plain `<rect>` in svg root renders, while
`<path> + <pattern> + evenodd` does not in whatever combination of
renderer / DOM context this editor lives in. v0.8.271 final
implementation: 4 plain `<rect>` strips (top / bottom / left /
right), each backed by a translucent-red solid rect under a striped
overlay rect. Inserted on svg root (bypassing `handlesG`).

**Click-outside exits move mode (v0.8.272).** A capture-phase
`pointerdown` listener on document is installed while move mode is
active; if the click target is anything other than the overlay rect
or the panel's Move/Validate button, the mode exits and
`PanelManager.notifyDataChanged()` refreshes the button label.
Without this the band + pulsing button persisted forever for users
whose "I'm done" gesture was a click somewhere else on the canvas.

### Follow this object — per-object behavior inheritance (v0.8.274–v0.8.285)

Object-level composition primitive. An object X can "follow" another
object D, inheriting D's `behaviors[]` as if X had them — plus X's own
behaviors layered on top. Donor is identified by **masterId** (the
cross-class identity), so following an object follows it across every
class instance.

**Why not just use a group's behavior template?** A group template
applies to every member. Follow is per-object — useful for "object X
should behave like D plus a bit more" without conscripting D's whole
group. Per-object follow **takes precedence** over the group template
when both apply.

**Data shape.** One new field on the line: `followsMasterId: string |
null`. Persisted via the standard three-place pattern (matches
scrollMode v0.8.231):

1. `decomposeForSave` in dev-draw.js writes `instRecord.followsMasterId`
   when non-null (omitted otherwise) on save.
2. `composeLineFromInstance` reads it back at load.
3. `deco_resolve_instance` in `site/plugins/deco/index.php` passes it
   through to the runtime line object.

No schema bump — additive optional field with safe default.

**Runtime composition (`resolveInstanceJS` in app.js, ~line 1093).**
The donor's behaviors are prepended to X's own. The walk is multi-hop:
A→B→C→… up to 16 hops (hard ceiling) with cycle detection (seen-set).
Composition is bottom-up: each ancestor's behaviors prepend onto the
accumulator with **pathFollow suppression** — once any closer-to-X
level carries a pathFollow block, deeper ancestors' pathFollow blocks
are dropped (geometrically nonsense to follow two paths at once;
closest intent wins). Sum effects (translate, rotate, drawIn flag)
remain order-independent. The group template path still exists as the
`else if` branch when no follow is set, and the donor for pivot
inheritance is the direct donor (`followChain[0]`) under either path.

**Editor depth cap (`state.followsDepthCap`).** Default 4, persisted
in localStorage as `ed-follows-depth-cap`. Editor UI walks at most
this many hops — purely a panel-readability soft limit. The runtime
walks the full chain (up to 16) regardless. Configurable in the
Settings dialog (`"Follow" chain depth`).

**Editor UI surfaces.**

- **Follows picker** (renderLinePanel, under a new FOLLOWS divider).
  Only shown when `line.masterId` is set (donor lookup is by masterId).
  Picker enumerates one entry per unique other masterId in this class.
  Cycle guard walks the prospective donor's full chain up to 16 hops
  and refuses any donor whose chain would reach this line's masterId.
  Setter (`updateLineFollowsMaster`) reapplies the same check and
  fans out to siblings in ALL mode (`forSiblingsOf(masterId, fn)`).

- **Inherited section in the object panel.** Above own behaviors:
  one sub-group per ancestor in the chain, rendered **deepest first**
  (top-to-bottom matches run order). Each header carries a `(depth N)`
  label and an `Open donor` button that selects+focuses the donor.
  Rows are read-only with a leading `↪` glyph in the same column the
  power toggle occupies on own-block rows (`.ed-inherited-glyph`
  matches `.ed-block-toggle` geometry at 2.0rem). Muted slate
  background (`.ed-block-row.is-inherited`).

- **Truncation warning** (mitigation #1, v0.8.282). When the editor
  cap clips a deeper real chain, an amber italic row surfaces it.
  Repeated in **every chain member's panel** under the FOLLOWS divider
  via `chainTruncatesBelow(line, cap)` — not just the head's, which
  was easy to miss.

- **Canvas follow badge.** Teal circle with `↪` glyph at the bbox
  top-right + a stroke-haloed donor name label. For chains of length
  ≥ 2, the name is prefixed with `#pos/total` so chain order reads at
  a glance (mitigation #2). **Clickable** — pointerdown selects the
  donor and focuses its group, so users walk the chain by repeatedly
  clicking each new badge. Handler is on `pointerdown` (not click)
  because canvas selection runs on pointerdown — a click handler fires
  after the canvas deselect (v0.8.284 → v0.8.285 fix).

- **Sidebar follow-chain pill.** Each line row carries a fixed-width
  slot (`.ed-follow-chain-slot`, 2.6em) reserved for a pill, so chain
  and non-chain rows align. Pill shows position only (`↪N`) — total
  lives on the canvas badge. **Per-chain color** via `chainIdOf(line)`:
  computes the connected component in the follow graph (union of
  follow-edges between masters) and picks from a six-hue palette
  (`CHAIN_PALETTE`). Independent chains read as distinct groups
  (mitigation #3).

**Shared helpers** (dev-draw.js, near `updateLineFollowsMaster`):
- `chainPositionOf(line)` — 1 = chain head (follower no one follows),
  increments going up to the deepest donor.
- `upWalkLength(line)` — runtime hops to deepest reachable donor.
- `chainLengthAt(line)` — total length of the chain this line is in.
- `chainTruncatesBelow(line, cap)` — first descendant whose up-walk
  exceeds cap, or null.
- `chainIdOf(line)` — stable connected-component id, or -1.

**Object panel block-detail persistence (v0.8.280).** Adjacent UX
improvement landed in the same slice: when an unpinned object panel
rebinds to a new selection, its attached behavior-block child no
longer closes — it retargets to the new object's first block. Falls
back to closeChildrenOf when the new object has no behaviors.

### Orphan cleanup (v0.8.43–v0.8.44)

`🔍 Orphans` button in the Master library header opens a dialog that scans for:
- Orphan masters (no instances anywhere)
- Unused palette colors
- Empty groups (per-class; checkbox opt-in since often intentional)
- Orphan instances (lines with dangling masterId or groupId)

Plus an in-place "0 instances" badge on master library rows.

## Roadmap — the larger plan beyond the current editor

The /dev/draw editor is the first of three project phases. Calling
them out here so future sessions (and future me) read the work in
context — individual decisions in the editor make more sense once
you know what comes next.

### Phase 1 — Geometric / animating object editor (current, nearing completion)

Everything in `/dev/draw` so far: masters + instances, groups, layers,
behaviors (translate/rotate/drift/drawIn/fadeOpacity/pathFollow),
text overlays, font bundles (Google + local). The output is a set of
JSON files in `content/` that the runtime (`app.js`) replays as
scroll-driven SVG animations.

**Important framing.** Deco's primary purpose is **background
decoration and animation** — moving graphic elements that frame the
real page content. With significant exceptions: the text abilities
— and the main one, **textBlock** — can carry **actual page content**
rather than decoration, but content that retains the full power of
Deco's animation system (scroll-driven, drift, drawIn, fadeOpacity,
pathFollow, follow-this-object, group templates). This is what makes
Deco more than a decoration layer: it doubles as an animated
content-authoring surface, adding real power to the site as a whole.

### Phase 2 — Page structure: HTML pages / content holders

Phase 2 generates the site's actual **page structure** — the HTML
pages visitors land on. The output is either real final content, or
**content holders with placeholders** waiting for content to be
written/loaded later; the goal of this phase is to lay down the
**structure(s)** of the future site, not necessarily to populate
every word and image.

Plain Kirby work for the skeleton: `site/blueprints/`,
`site/templates/`, `site/snippets/`, navigation, layout primitives.

Crossover with Phase 1: where a page (or page region) needs
animated text content, the **textBlock** mechanism authored in
`/dev/draw` is the carrier — Phase 2 wires Kirby pages to consume
those textBlocks (via `htmlKey` slots — see v0.8.258) so a single
authoring surface produces both decorative motion and real content
in motion. Asset paths, JSON shapes, and slot conventions need to
resolve under both `/dev/draw` and public URLs.

This is also where any "geometric object as part of a page" gets
done — embedding the SVG animation as a block within a Kirby page
template, alongside text blocks, image blocks, etc.

### Phase 3 — Safety: auth for the web-hosted editing tools

Both Phases 1 and 2 currently assume a local development model.
The /dev/draw editor and the entire `dev/draw/*` route namespace
have no authentication — fine on `localhost`, unacceptable on a
public host. Once the site is deployed and the user wants to edit
**on the live server** (the natural workflow for site tweaks,
especially in the first year), all of this needs an auth gate.

Concretely:
- Every `dev/draw/*` route needs a `kirby()->user()` check (or
  equivalent) refusing access to anonymous requests.
- The editor page itself needs the same gate.
- File-upload endpoints (font uploads, image uploads, snapshot
  saves) need both auth AND MIME/extension validation to prevent
  writing executable files into web-served directories.
- Existing endpoints to audit: `dev/draw/save`, `dev/draw/library/*`,
  `dev/draw/font-bundle` (POST), `dev/draw/local-fonts` (currently
  read-only — safe-ish, but will gain upload/delete in the on-
  server-editing milestone).

**Recommended sequencing**: do Phase 3 (or at least the auth gate)
as a single cohesive slice rather than per-feature. Building auth
incrementally as each feature graduates to "needs upload UI" leads
to inconsistent gating and easy mistakes. One audit pass over the
whole route namespace + one editor-page check + a session-aware
upload helper used everywhere is cleaner.

Until Phase 3 lands, the operational rule is: **never expose a
public host with the `dev/draw/*` routes reachable**. Deploy with
either the routes stripped from `config.php`, or with an
htaccess/server-config rule blocking the namespace.

**Update (v0.9.14):** A minimum-viable version of this gate has been
implemented — a host-scoped Kirby config (`site/config/config.<SERVER_NAME>.php`,
rsync-excluded, lives only on the server) that gates the entire
`dev/draw/*` URL prefix on `kirby()->user()` via an early-exit inside
the `ready` callback. (The v0.9.2 attempt that registered a guard route
turned out inert in Kirby v5 — see the "Deployment infrastructure +
first auth gate" subsection in *Recent architectural decisions* for
why and what replaced it.) This unblocks first deployment but does NOT
replace Phase 3 — endpoint-by-endpoint auth audit, MIME validation,
and role distinction are all still pending.

### Parked: Panel IP allowlist via dynamic DNS

Idea floated during the v0.10.x security batch, **not needed now,
worth looking into later**. Layer an IP-based restriction on top
of the `/panel` route (and possibly `/dev/draw/*`) so that even
with valid credentials, the surface is unreachable from arbitrary
IPs. The hard part on a home/consumer connection is that the
public IP changes; the standard solution is a dynamic-DNS service
that resolves a stable hostname to the current IP, and a server-
side check that resolves that hostname per request and compares.

Sketch of the moving parts (for the future implementer):
- A dyndns provider with a free or low-cost tier and a client
  that runs on the user's machine/router updating the A record
  when the IP changes (Dynu, DuckDNS, No-IP, Cloudflare
  ddclient — all viable; the user has used such a service in
  the past, exact provider TBD at implementation time).
- A `.htaccess` `Require host <hostname>` block on `/panel`
  (Apache resolves the hostname per request — TTL-bounded
  cache, acceptable on Infomaniak), OR a Kirby `ready`-callback
  IP check that does `gethostbyname()` on the dyndns hostname
  and compares against `$_SERVER['REMOTE_ADDR']`. The Kirby-side
  approach has more flexibility (custom error response, can
  bypass for known-good user tokens, etc.) but adds a DNS
  lookup to every gated request.
- Decide whether to gate just `/panel` (cheap, blocks the
  primary attack surface) or also `/dev/draw/*` (heavier; the
  v0.10.2 opaque 403 already neutralizes the public reveal,
  and a logged-in user check is the existing auth layer).

Why parked: the v0.10.x batch (opaque 403, X-Powered-By stripped,
.htaccess comment-stripped, Kirby upgraded, ErrorDocument lines)
already removes the obvious reveals and CVE exposure. IP-based
hardening is defence-in-depth, not blocking any current concern.
Worth revisiting if (a) an attacker is observed probing the
Panel, or (b) the user wants to relax some other security
constraint and needs the network-layer fence as a tradeoff.

### On-server editing pre-requisites (small running list)

Things that need building when Phase 3 happens — captured here so
they're not lost:

- Font upload UI in Settings → "Local fonts" section: file input
  POSTing to `dev/draw/local-fonts/upload`, which writes into
  `assets/fonts/local/` after MIME validation and regenerates
  `manifest.json`.
- Font delete UI: list with × buttons, calls
  `dev/draw/local-fonts/delete` (auth required, validates the
  filename is inside the directory — no path traversal).
- Similar upload/delete affordances for images (whenever images
  become first-class content in Phase 2).
- The Google Fonts bundle Settings textarea (already exists) needs
  no UI change but its endpoint needs the same auth gate.

## Known limitations to be aware of

### Remaining geometric limitation on drawIn

| Property | Multi-block aware? | Notes |
|---|---|---|
| drawIn | Yes — per-block, last-active-wins (v0.8.91) | Each block contributes its own dashoffset; the last active drawIn block this frame wins. Sequential whole-path passes work (forward → reverse, scroll-then-loop). **Geometric limitation remaining:** each block still controls the *whole* path's dashoffset — the "draw segment A over scroll 0–0.3, then segment B over 0.3–0.6" subdivision use case would need geometric path-splitting at the renderer level, not a runtime fix. |

### Editor canvas doesn't animate

`/dev/draw` renders lines statically. Animation is runtime-only. If a user
edits a behavior and asks "why isn't it moving in the editor?", that's why.
They have to test on the live page (`/`).

## Limitations removed by user decisions

These were once listed as multi-block restrictions. They are no longer
limitations — each was settled by an explicit semantic decision. Kept here
for historical context (future-Claude reading old commits or earlier
HANDOFF revisions will see the older framing and wonder if anything still
needs doing — nothing does).

| Property | Resolution | Decision |
|---|---|---|
| translateX/Y | **Sum across active blocks** | Logical: independent translation contributions add. Multiple translate blocks compose into a single net offset. |
| rotate | **Sum across active blocks** (v0.8.220) | Logical: independent rotations add into a single net angle. Pivot is resolved once per object (first block with finite `rotateOriginX/Y` wins; falls back to follow-donor / group template pivot; final default is the natural center). The editor still shows the pivot field on every block but the resolver picks one. Per-block pivots were intentionally dropped — multi-block rotations spin around the one chosen pivot. |
| Drift X/Y | **Multi-block, sum** | Logical: drift accumulates the same way translate does. |
| pathFollow | **Last active block wins** | Logical: pathFollow positions the object along a path; "last active wins" matches the user's mental model when more than one pathFollow block exists. |
| fadeOpacity | **Last active block wins** | Logical: same as pathFollow — the most recently activated opacity intent is the one that should be visible. |

### Per-class master drift — resolved on this dataset

Earlier datasets carried per-class master IDs that had diverged (the "same"
logical line had different masterIds in narrow / medium / wide), a leftover
from earlier save/re-mint cycles. Symptoms when it occurred: ALL-mode
behavior fan-out would write across classes but pathRef of one class's
masterId wouldn't resolve in another → pathFollow name-fallback kicked in.

The current `content/home/*/instances.json` has been audited (v0.8.287)
and shows no name-vs-masterId drift across classes. A group-level drift
was also found and cleaned up in the same pass: medium and narrow had
duplicate "Group A" entries (3 each) plus an unused "Group 1" (`ambient`),
with instances dangling-referencing wide's group id. Resolved by
unifying every class onto `g-cq9hd6` (Group A) and deleting the
duplicates. `_dumpAllBlocks()` in the editor console remains the
diagnostic if drift reappears.

## Diagnostic tools

Available in the EDITOR console after v0.8.33:

- `_dumpLine('blob 1')` — search across every class for a line by id/name/masterId.
  Returns matches + the resolved master records.
- `_dumpAllBlocks()` — per-class table of every line's behavior block ids.

The runtime page area diagnostic (toggled via the editor's "Show page area"
button) displays version + active class:
- v0.8.31: version badge
- v0.8.58: also shows `class: Wide` / `Medium` / `Narrow`

In `app.js` v0.8.56–v0.8.59 added one-shot per-block console logs on the
pathFollow code path. Look for `[pathFollow blk N on lineId]` lines if path
follow ever misbehaves silently.

If a feature silently does nothing in the runtime:
1. Open DevTools console — gsap.ticker traps per-callback errors and prints
   them but doesn't break the page. Errors there explain a lot.
2. Check `data-master-id` exists on the target line (`layer.querySelectorAll('[data-master-id]')`).
3. Check initial-frame priming — does the feature need the v0.8.71 pattern of
   "call writeAt explicitly after ScrollTrigger.create"?

## User's behavioral preference

> **Clarify high-leverage assumptions before acting.** When you're about to do
> something based on an assumption that is BOTH (a) central to the current
> subject AND (b) has strong consequences if wrong, pause and confirm. Not
> every assumption — only the high-leverage ones. The bar: "if this is wrong,
> the next several minutes go in the wrong direction and have to be backed out."

This was explicitly requested as a stable preference; honor it.

Past examples where I should have clarified (and didn't):

- Assumed cross-class master drift was the pathFollow cause, when the real
  cause was a hidden guide line. Spent 3 versions chasing the wrong thing.
- Assumed v0.8.68's `block0params` removal was safe without grepping for
  remaining usages.

Past examples where clarifying first was correct:

- Z-order convention (SVG-natural vs Photoshop-natural) — asked which model.
- ALL-mode fan-out semantics — asked about orphan handling first.

## Misc gotchas worth knowing

- **Content data is gitignored.** `.gitignore` excludes `content/*` JSON files
  (data is local-only by design). I can't see the user's actual line data
  unless they force-add a file or paste content.
- **`_dumpLine` only exists in the editor session**, not in the public-site
  console. They're separate.
- **Snapshot save/load** writes to `library/<name>/` which is gitignored
  (except `.gitkeep`). Snapshots are local backups, not source.
- **`hasMotion`** in app.js gates `writeAt` registration. If a new behavior
  property is added that affects rendering, add it to the `hasMotion` test
  (see v0.8.26 for fadeOpacity, v0.8.53 for pathFollow).
- **drawIn legacy single-tween:** v0.8.68 lifted the "block 0 only" data-side
  restriction but the rendering is still single-tween. If you build "the
  drawings" feature you'll be touching this code.
- **SVG `<g>` is not paintable** — `pointer-events: all` on a group does
  nothing. Put it on a painted child instead. Cursor CSS on the group
  inherits visually, so a hand cursor without a working pointerdown is
  the diagnostic signature. See v0.8.107 label-drag fix.
- **`<path fill-rule="evenodd">` + `<pattern>` fill silently fails** in
  this editor's SVG rendering context. Three attempts at a ring-shaped
  out-of-bounds band (v0.8.266 / v0.8.267 / v0.8.269) all produced an
  invisible element while sibling plain `<rect>` elements with the
  same pattern fill rendered fine. Workaround: build the ring out of 4
  plain `<rect>` strips (T/B/L/R). See v0.8.271 for the canonical
  implementation. The diagnostic that isolated this is in v0.8.270 —
  shrink to a single fully-opaque magenta `<rect>` to confirm the code
  path runs at all, then add complexity until something breaks.
- **`PanelManager.renderPanel`'s `innerHTML = ''` resets `scrollTop`.**
  Any cross-panel notify (notifyDataChanged) re-renders every open
  panel and snaps each one to scroll position 0 unless you save/restore
  `body.scrollTop` around the wipe. v0.8.262 patched this in both
  `PanelManager.renderPanel` and `renderSelectionPanel`. New
  panel-render paths added later should preserve scroll the same way.
- **Block-row click handlers must pass the DOM row to data updaters
  when the panel may live in multiple containers.** The block-disable
  toggle (v0.8.260 regression) queried `selectionPanel.querySelector`,
  but block rows render in floating object panels too. Either fall
  back to `document.querySelectorAll('.ed-block-row[data-…]')`, or
  thread the clicked row through the handler (v0.8.261 does both).
- **Don't re-render the dragged layer mid-gesture.** If a pointermove
  handler triggers a `layerG.innerHTML = ''` re-render, the dragged
  element disappears, pointer capture releases, and subsequent
  pointermoves are dropped silently. Mutate the live attributes in
  place during the gesture; re-render only on pointerup. See v0.8.108.

## Vocabulary

**Lines** : initially all the graphical objects were lines and this 
designation was always used. 
Later geometric primitives were added and user often uses the 
designation **objects** which is more general and appropriate.
The meaning of both is the same: the word addresses the elementary
graphical items referenced in masters.json and instances.json,
which are the holders of behavior blocks.  
