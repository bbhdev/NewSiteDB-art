# Project notes

Open architectural questions worth revisiting. Not a TODO list — items
here need analysis before they need work.


## Master / instance / scope — current state (v0.3.8+)

The propagation-by-side-effect model that drove this note's original
v0.2.20 entry is gone. v0.3.5 replaced it with a **scope-driven**
mutation model:

  - Every master carries a `scope` map: `keyPath → "local"`. Missing
    entry = canonical. Default on fresh masters: empty (all canonical).
  - One mutation entry point — `setVisualProp(lineId, keyPath, value)`
    — branches on `master.scope[keyPath]`. Canonical: write to master
    + propagate to every instance. Local: write to `instance.overrides`,
    this instance only.
  - **Position** is always per-class via `positionOffset` (not in
    scope, not toggleable). Primitive position-handle drags and
    selection drag-translate both feed `positionOffset`.
  - **Behavior keys** (translateX/Y, rotate, drawIn, drawInDirection,
    rotateOriginX/Y) are always per-class via `instance.overrides`
    (independent of scope).
  - **Structural keys** (`kind`, `d`, `points`, `segments`) have no
    scope toggle — toggling them local would either be redundant
    (`d` is derived) or break the master-as-canonical-shape contract.

`decomposeForSave` is now bookkeeping only: `instance.overrides` ==
behavior keys + scope-local visual keys, no divergence detection.
`resolveInstanceJS` and PHP `art_resolve_instance` consult
`master.scope` symmetrically. Migration v6→v7 strips legacy non-
behavior overrides and seeds `scope: {}` on every master.

The three concerns from the original note:

  - **Two sources of truth in memory** — still technically two
    (`state.masters` + `state.byClass[cid].lines`), but mutations no
    longer write to "the resolved line and then sync". They write to
    the master OR the instance based on scope, and `propagateLineToMaster`
    only runs from `regenerateLineD` (handle drags, panel edits that
    touch geometry) to keep siblings coherent with master changes.
    Position propagation was the messiest case; it's now strictly via
    `positionOffset`.
  - **Sub-key asymmetry** — `params` still has sub-key granularity;
    scalar visual keys are whole-key. The scope map naturally supports
    both (keyPath is `"params.r"` or `"stroke"`); no special-casing in
    the mutation path.
  - **Sync as side-effect coupling** — `propagateLineToMaster` is
    still implicit on `regenerateLineD`, but its scope is narrow
    (geometry changes only) and it now skips canonical-locked keys
    via `isLocal()`. The "did I remember to call sync?" surface is
    much smaller.


## Still on the table

  1. **Group defaults under scope.** Groups have their own per-class
     defaults (`stroke`, `width`, behavior keys). These are not in the
     scope contract — each class has its own copy. If we ever want
     a "site-wide group preset" abstraction, the scope contract could
     extend to groups. No demand for this yet.

  2. **Structural per-class adaptation.** If a class needs a different
     `kind` or `points` (e.g., simpler shape on mobile), the scope
     model can't express it — structural keys are non-toggleable by
     design. The current escape hatches are: (a) delete the instance
     on that class, (b) create a separate master per shape variant.
     If real per-class shape variants become a recurring need, scope
     could extend to structural keys — but the semantics get hairy
     ("same logical object, different shape per class" stops being
     the same object).

  3. **Behavior keys as canonical with overrides.** Right now behavior
     is per-class with no master fallback (group defaults play that
     role). Could become master-canonical with `scope: local` opt-in,
     parallel to visual keys. Would unify the model — at the cost of
     a small UX shift (the existing inherit/override checkbox pattern
     would become 🔗/✎ instead).

  4. **Undo log compaction.** Snapshots are full deep-copies of
     `state.byClass + state.masters + state.palette`. Lots of churn
     when scope toggles fire on every keystroke. Not a problem yet
     (HISTORY_MAX caps it) but if the editor scales, switch to a
     command-log model.

  5. **Web Components wrapper for snippets.** Deferred from the
     original site plan. Snippets work; wrapper would add nicer
     authoring syntax (`<rr-button>` etc.). No blocker.


## Misc operational notes

  - Sessions are ephemeral remote containers. Anything not committed +
    pushed is gone when the container is reclaimed.
  - The editor is mouse-shaped; mobile maintenance is realistically
    via the Kirby Panel for text/images, not `/dev/draw`.
  - `php -S` is dev-only. Production needs a real PHP-FPM + Apache/
    nginx setup, or a Docker compose with `php:8.2-apache`.


## Roadmap (from the v0.3.9 planning chat)

Ordered. Targets are tentative; small items can re-shuffle.

### Quick wins (v0.3.x patches)

  - **v0.3.10 — default object name.** `Object N` (sequential across
    the page or site-wide; decide on scope) assigned in
    `commitLine` / `mintMasterForLine`. Fixes labels-don't-render
    cases that need a non-empty name to behave correctly.

  - **v0.3.11 — button kit polish.** Rename `circle-button` →
    `c-button`. Add `e-button` (ellipse: `radiusX`, `radiusY`). Make
    `rr-button` accept `width`, `height`, `cornerRadius` overrides
    instead of fixed CSS. Self-documenting PHPDoc headers on each
    snippet listing every param.

  - **v0.3.12 — clone UI.** Move "Clone from…" out of the Canvas
    section to a small copy-icon next to the class tabs. Replace
    wholesale-copy with per-group cherry-pick: dialog lists source
    class's groups with checkboxes (default all checked); on apply,
    same-name groups in dest are replaced, new ones are added.


### Behavior model refactor (the big one — v0.4.x)

  - **v0.4.0 — `behaviors: []` per instance.** Each line gets a list
    of behavior blocks, each `{ range, kind, params }`. `range` is
    a scroll-progress interval (later, a time interval too). Runtime
    registers N ScrollTriggers per line. Authoring UI warns on
    overlap. Migration: every existing single-block line becomes a
    single-element `behaviors[]` with range covering the full
    trigger window. Unlocks chained motions per object.

  - **v0.4.1 — time-based trigger.** Behavior `kind` gains a
    `trigger.type: 'time'` variant (delay + duration) alongside
    scroll. Independent of scroll progress; uses a GSAP timeline.
    Enables on-its-own animations.

  - **v0.4.2 — sticky behavior kind.** New `kind: 'sticky'`. The
    line gets pulled out of the scrolling SVG into a fixed-position
    sibling layer for the duration of its range. Useful for
    HUD-style overlays that should pin while everything else moves.

  - **v0.4.3 — translate-to with viewport tokens.** `kind:
    'translate-to'` with `from` / `to` accepting tokens —
    `viewTop`, `viewBottom`, `viewLeft`, `viewRight`, `pageStart`,
    `pageEnd`, `selector:#foo.top`. Resolved per-frame at runtime.
    Cleaner authoring than length deltas for "cross the screen"
    effects.

  - **v0.4.4 — draw-in over time.** Already progressive over scroll;
    pair with v0.4.1 so a path can draw itself on a timeline
    instead of with scroll. Composing v0.4.0 + v0.4.1 mostly gets
    this for free.


### Independent features (v0.5.x)

  - **v0.5.0 — SVG import as first-class objects.** User's stated
    top feature. Drop an SVG into the editor; parse `<path>`,
    `<rect>`, `<circle>`, `<ellipse>`, `<polygon>`, `<polyline>`,
    `<line>`. Flatten `transform=` on parents into the geometry.
    Map each element to either a `PRIMITIVES.*` kind (when shape
    matches) or `kind: 'manual'` with explicit segments. New group
    per import (filename → group name). Unknown colors get added
    to the palette automatically. Each imported path becomes a
    master + an instance in the current class — full scope/
    behavior contract from the moment it lands.

  - **v0.5.1 — photo primitive.** New `kind: 'image'`. Params:
    `{ x, y, w, h, src, fit }`. Editor: drag-create like rect;
    panel exposes src (Kirby file picker if we wire into the Panel,
    otherwise URL text). Runtime: SVG `<image>` with
    `preserveAspectRatio`. Inherits full scope + behavior contract.

  - **v0.5.2 — bezier with control-point handles.** Infrastructure
    already in place (`kind: 'manual'`, segments `cmd: 'C'` with
    cp1/cp2). Add an authoring mode where each anchor exposes its
    in/out control handles for direct drag. Could absorb the
    current `kind: 'bezier'` (auto-smoothed) or live alongside.


### Bigger workflow surfaces (v0.6.x+)

  - **v0.6.0 — master library overlay.** Full-canvas modal triggered
    from the toolbar. Sortable + searchable list; each row = preview
    + name + class-usage chips + scope summary. Inline rename,
    delete (cascading), scope flip. Not a sidebar — takes over the
    canvas because library work is occasional and visual.
