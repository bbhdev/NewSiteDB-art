# HANDOFF — NewSiteDB-art

A briefing for whoever (next Claude session, or human) picks this project up
without the context of the conversation that produced versions ~v0.8.5–0.8.72.
Read this top-to-bottom once; reference back as needed.

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
  in-view-partial / in-view-full / after-previous. With `range`, `selector`,
  `delay`, `viewportAt`, `repeat`.
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

## Recent architectural decisions and why

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

### Orphan cleanup (v0.8.43–v0.8.44)

`🔍 Orphans` button in the Master library header opens a dialog that scans for:
- Orphan masters (no instances anywhere)
- Unused palette colors
- Empty groups (per-class; checkbox opt-in since often intentional)
- Orphan instances (lines with dangling masterId or groupId)

Plus an in-place "0 instances" badge on master library rows.

## Known limitations to be aware of

### Multi-block restrictions still in the runtime

| Property | Multi-block aware? | Notes |
|---|---|---|
| translateX/Y/rotate | Yes (sum) | |
| Drift X/Y | Yes | |
| pathFollow | Yes (last active wins) | |
| fadeOpacity | Yes (last active wins) | |
| drawIn | **Flag from any block (v0.8.68); single tween** | The flag reads from any block, but the dashoffset tween itself is single. Multi-block sequential drawIn (e.g., "draw segment A over scroll 0–0.3, then segment B over 0.3–0.6") would need a per-block ScrollTrigger composition refactor. Planned as "the drawings" feature. |
| rotate pivot (rotateOriginX/Y) | **Block 0 only** (v0.8.70 comment) | The editor exposes per-block pivot, but the runtime uses only block 0's. Multi-block pivot requires switching from `rotate(angle, ox, oy)` shorthand to `matrix(a b c d e f)` composition. See "details on multi-block pivot" discussion in commit messages around v0.8.70. |

### Per-class master drift

Some datasets have per-class master IDs that diverged from each other (the
"same" logical line has different masterIds in narrow / medium / wide). This
came from earlier save/re-mint cycles. Symptoms:
- ALL-mode behavior fan-out writes the same value across classes; pathRef of
  one class's masterId doesn't resolve in another → pathFollow name-fallback
  kicks in.
- `_dumpAllBlocks()` in the editor console reveals this.

If you do a structural data cleanup later, normalizing master ids by name
would prevent a class of weird-cross-class bugs.

### Editor canvas doesn't animate

`/dev/draw` renders lines statically. Animation is runtime-only. If a user
edits a behavior and asks "why isn't it moving in the editor?", that's why.
They have to test on the live page (`/`).

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

## Where to start, generically

1. `git log --oneline -30` — read recent commits to absorb the latest decisions.
2. Skim `assets/js/app.js` and `assets/js/dev-draw.js` headers/comments —
   they're heavily annotated.
3. If a specific feature: search for the v0.8.X version that introduced it via
   `git log --grep "feature-name"` — commit message has the design rationale.
4. Diagnostics first — when something's broken, run `_dumpLine` / check DOM
   `data-master-id` / check console for trapped errors before guessing causes.
