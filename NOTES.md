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
