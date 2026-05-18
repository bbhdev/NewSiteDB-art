# Project notes

Open architectural questions worth revisiting. Not a TODO list — items
here need analysis before they need work.


## Master / instance / override propagation

### Where we are (as of v0.2.20)

The editor's working model is per-class **resolved lines**:

    state.byClass[cid].lines[i]  =  master visual props  ⊕  instance.overrides

Mutations happen on the resolved line. A sync function pushes geometry
changes back up to the master and out to sibling instances on every
`regenerateLineD`. The on-disk shape is master + instances; the
in-memory shape is the resolved view + an explicit `line.overrides`
map.

The rule we converged on:

  - **Drag-to-translate** writes per-class overrides on position
    sub-keys only (`params.cx/cy` or `points`/`segments`).
  - **Panel param edits** go through `setMasterParamSubkey`: they
    propagate to master + all classes and clear stale sub-key
    overrides everywhere.
  - **Handle drags** (shape edits) propagate via the sync.
  - **Master-link toggle** on `stroke / width / name` flips per-property
    between linked (propagates) and overridden (local).

`instance.overrides.params` is a SUB-KEY map — splitting a position
override on `cx/cy` from a shape override on `points` (the
star-points-count kind), which the v0.2.19 whole-blob model couldn't
do.


### Why this is uncomfortable

  - Two source-of-truths in memory (`state.masters` and
    `state.byClass[cid].lines`) need to stay coherent. Every mutation
    site has to know which one to write to (or trigger the sync).
  - Sub-key behavior diverges between `params` (sub-key overrides)
    and other visual keys (whole-key overrides). Future visual keys
    might want sub-key handling too, escalating special-casing.
  - "Sync after mutation" is a side-effect coupling — easy to forget
    when adding a new mutation site, easy to fire spuriously, and
    invisible to anyone reading the mutation code without finding
    `regenerateLineD`.
  - Pre-migration data carrying whole-blob `params` overrides still
    works but doesn't model the user's intent — the user needs to
    use the "Reset to master" affordance to clean it up.

This works for now and matches the user's mental model, but the
plumbing is gaining surface area faster than the concept. Worth
revisiting before adding more sub-key behaviors.


### To re-analyze (no rush, but soon)

  1. **Restate the current model.** Walk through every mutation site
     (translateLine, handle drag, panel param edit, link-toggle, freehand
     point drag, manual segment drag) and trace where the data flows:
     line, override, master, siblings. Look for asymmetries.

  2. **Consider the canonical-master rewrite.** Editor state holds only
     `state.masters` + `state.byClass[cid].instances`. Render composes
     on the fly. Mutations write directly to master or to an instance
     override based on explicit intent (button, modifier, mode). No
     resolved-line cache; no sync function.

     - Render code reads `(master, override)` instead of a flat line.
     - Drag/handle/panel handlers consult intent: "edit master" vs
       "edit this instance".
     - Migration: in-memory state is fundamentally different; tools
       and rendering need adapting.

  3. **Compare.** Lines-of-code touched, asymmetries removed, edge
     cases that disappear (or appear), velocity of future features.
     The propagation approach has worked through Phase 4b + 5 + 5b;
     it'd need to start cracking somewhere before the rewrite pays
     for itself.

A reasonable trigger: the moment we need ANOTHER visual key to behave
like sub-key params (e.g., per-class behavior overrides at a per-key
granularity), revisit. If the special-cases keep stacking, switch.
