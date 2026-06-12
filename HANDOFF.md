# HANDOFF — NewSiteDB-art

A briefing for whoever (next Claude session, or human) picks this project up
without the context of the conversation that produced versions ~v0.8.5–0.9.8.
Read this top-to-bottom once; reference back as needed.

> ## ⛳ PROJECT NORTH STAR — tablet (iPad) live editing is a first-class phase
>
> **Re-stated emphatically by the user (v0.10.68) because earlier exchanges drifted
> toward a "user works on a large screen" assumption.** That assumption is WRONG as
> a design premise. Editing the **live site from a tablet (iPad today, other tablets
> later)** is a planned, important phase of this project — not a nice-to-have, not a
> someday-maybe.
>
> Concrete implications, to weigh in EVERY editor/UI decision from now on:
> - **A simple homothety (uniform scale-up of the desktop UI) will not work.** The
>   tablet editor needs a genuinely reworked interaction model — touch targets,
>   gestures, panel layout — not a zoomed desktop layout.
> - **The self-hosted icon library (v0.10.64) exists partly to serve this** — icon
>   affordances are more tablet-friendly than text-dense controls.
> - **Likely shape: an alternative UI *layer*** over the same editor core/state, not
>   a fork. (Exact architecture is still TBD — to be discussed before building.)
> - **Why this is recorded so loudly:** decisions that strongly contradict tablet
>   editing (desktop-only gestures, hover-dependent affordances, fixed pixel layouts
>   that assume a wide viewport, mouse-only drag semantics) are **disproportionately
>   expensive to unwind later.** Prefer choices that keep the touch/tablet path open
>   even while building the desktop editor. When a choice would foreclose the tablet
>   path, flag it.
>
> **Timing (v0.10.68):** the tablet layer itself is **later** — likely once Deco /
> Phase-2 page-building is well advanced. The user will say when ready; do not start
> it unprompted. What matters NOW is only *not foreclosing* it.
>
> **Companion idea, also later (v0.10.68):** when the tablet layer is built, also
> imagine a **feature-reduced iPhone layer derived from the tablet one** (less
> power, smaller surface) — motivated by wanting to demo Deco's power *unexpectedly*
> from a phone. So design the tablet UI layer with a further reduction step in mind,
> not as a hard floor.
>
> **The Apple Pencil 2 is a primary reason — not just convenience (v0.10.210).**
> The earlier framing leaned on "tablet = working away from the Mac." That
> undersells it. The Pencil 2's capabilities are *genuinely superior to a mouse
> for most graphical work*: freehand strokes, loops, Bézier curves, SVG path
> authoring — anything that isn't a plain geometric primitive is better with the
> stylus (pressure, tilt, direct hand-on-surface precision). Geometric shapes
> (rects, aligned lines) gain less. **So the tablet is first-class for very
> significant work even when the user is sitting at the office with the Mac in
> front of them** — it's the *preferred* surface for a whole class of authoring,
> not a fallback for when L is unreachable. Any editor capability touching
> freehand / curve / path drawing should assume the stylus is the best input and
> design the interaction around it, not retrofit it onto mouse semantics.

> This is a standing constraint on Phase 2 editor work. Carry it forward in every
> handoff.

> ## ⛳ PROJECT NORTH STAR — staging-on-A → publish-to-B is a first-class workflow
>
> **Re-stated by the user (v0.10.208) as a standing consideration for ALL
> evaluations and decisions, alongside the tablet constraint above.**
>
> The three nodes are NOT "L is where you author, A and B are dumb mirrors."
> The real workflow:
> - **L** — local Mac authoring (the everyday, at-the-office surface).
> - **A** — staging / live editing surface. **Editing directly on A is
>   first-class**, not a fallback. You stage changes on A, then **publish A → B**.
> - **B** — public production site.
>
> **The decisive link to the tablet north star:** the tablet layer is
> first-class (above), and **working on a tablet means working on A** — because
> the situations that motivate tablet editing are precisely the ones away from
> the Mac: convenience, travel, an urgent update while not at the office. The
> tablet doesn't reach L; it reaches A. So "tablet editing is first-class" and
> "editing on A is first-class" are the **same requirement** seen from two
> angles. Any decision that quietly assumes A is non-interactive (read-only
> mirror, no auth-gated editor surface, ops that only make sense from L) breaks
> the tablet path too.
>
> **Smartphone is explicitly NOT first-class** (companion note, for a complete
> picture): the phone layer is a *demo of Deco's capabilities for other people*
> (showing off the power unexpectedly), not a real editing target. Tablet =
> first-class editing; phone = reducible demo surface derived from it.
>
> Implications to weigh in EVERY decision:
> - A must carry a real, auth-gated editing surface and a real **publish-to-B**
>   affordance — both reachable from a tablet (touch-friendly, not desktop-only).
> - The sync model's **A → B publish** direction is a primary path, not an
>   afterthought (see the sync slices: S6 publish A → B, S8 B-freeze + back-prop,
>   S9 "Published: <date>"). Staging-on-A is *why* that direction is first-class.
> - Conversely, anything that is genuinely L-only (e.g. shell-out ops — see the
>   parked PHP shell-out note) must NOT be assumed available when the user is
>   working on A from a tablet. A's affordances have to stand on their own.

---

## 🧭 Work tracking convention (single coherent scheme, v0.10.242)

**Why this exists:** the project had drifted into THREE incompatible work-item
naming systems at once — sync "S4/S5", convergence "Slice 7/8", and tasks
"#36/#37" — so one piece of work often had two or three addresses and references
used different ones. That is how the way got lost (and how a diagnosis got
misframed). This scheme replaces all of them with ONE addressing axis.

**The rules:**

1. **One canonical ID per work item — a spaced integer.** The thousands "band"
   = the epic; within a band, items are spaced (×10) so there is always room to
   insert. Example: `2041`. This ID is what you cite **everywhere** — chat,
   commits, memory, this doc.
2. **Epic = a `[tag]`, never a number.** The tag (and the band digit) carry
   grouping; they are not addresses. Bands past 9000 are 5-digit — the tag still
   identifies the epic.
3. **Spacing & insertion.** New item near an existing one → take a nearby free
   slot, and the proximity *is* the grouping (e.g. a follow-up to `2040` is
   `2041`). Tightly-linked sub-slices use +1 (`2040/2041/2042`).
4. **Genuine subdivision of one item → dotted decimals:** `2041.1`, `2041.2`,
   then `2041.2.a`, `2041.2.b`. A child never renumbers its parent; the parent
   closes only when its children do.
5. **The TaskList tool's own `#N` is ignorable noise.** The tool stamps its own
   sequential id and can't emit `2041`, so the canonical ID **leads the task
   subject**. Read the `2041 [sync] …`, ignore the `#N` prefix the tool shows.
6. **Legacy names (S1–S9, Slice 1–8, 4g-1–6, 3a/3b) are FROZEN** — never
   extended. The Rosetta below keeps old commits/docs/memory legible.

**Bands:**

| Band | `[tag]` | Subject |
|---|---|---|
| 1000 | `[deploy]` | deploy pipeline / targets / host config |
| 2000 | `[sync]` | L↔A↔B propagate layer (push/pull/publish, freeze, snapshots) |
| 3000 | `[conv]` | editor convergence (draw+page → one /dev/editor) |
| 4000 | `[workshop]` | image workshop |
| 5000 | `[dirty]` | unified dirty/save signal (derived, approach B) |
| 6000 | `[editor]` | the editor itself — a core pillar (interaction, dialogs, modes) |
| 7000 | `[cleanup]` | maintenance / cache pruning / tech-debt |
| 8000 | `[backgrounds]` | site backgrounds — processing + editor + runtime |
| 9000 | `[ui]` | cross-cutting UI / design system — flows down to tablet + phone |
| 10000 | `[tablet]` | iPad first-class editing layer (standing constraint) |
| 11000 | `[phone]` | smartphone demo mode (reduced from tablet) |
| 12000 | `[bedit]` | safe fallback editing on B (cross-links 2080) |
| 13000 | `[behaviors]` | new behavior-type ideas (backlog) |

**Rosetta — legacy → canonical (frozen, do not extend):**

| Legacy | Canonical |
|---|---|
| deploy Slice 1–4 | 1010 · 1020 · 1030 · 1040 |
| sync S1 · S2 · S3 | 2010 · 2020 · 2030 |
| sync S4a · S4b · S4c | 2040 · 2041 · 2042 |
| sync S5 · S6 · S7 · S8 · S9 | 2050 · 2060 · 2070 · 2080 · 2090 |
| sync protocol review | 2095 |
| conv Slice 1a/1b/1c | 3010 · 3011 · 3012 |
| conv Slice 2 · 3 · 4 · 5 · 6 | 3020 · 3030 · 3040 · 3050 · 3060 |
| conv Slice 7 · 8 · "All" | 3070 · 3080 · 3090 |
| workshop 4g-1 · 4g-1b | 4010 · 4011 |
| workshop 4g-2 · 4g-3 · 4g-5 · 4g-6 | 4020 · 4030 · 4050 · 4060 |
| dirty lines (B) · layout (B) | 5010 · 5020 |
| dirty styles (#36) · images (#37) | 5030 · 5040 |
| editor dialogs (#33) | 6010 |
| media cleanup (#39) | 7010 |

> NOTE: sync's canonical order (S5→S6→S7→S8→S9 = 2050→2090) fixes a tracker
> wart — S8/S9 were *filed* before S6/S7, so creation-order lied about sequence.
> The spaced IDs encode true sequence regardless of when each was filed.

---

## 📍 Current frontier (v0.10.255)

> The long prose block immediately below this section is a **historical
> snapshot (~v0.10.96–136 era)** — accurate for the typography / text-marks
> work of that period, but it predates the entire sync + dirty + convergence
> arc. Do NOT read it as the frontier. The live frontier is the **relabeled
> task list** (canonical IDs, see the Work-tracking-convention section above)
> + the **memory files** (MEMORY.md index) + the **commit journal**. This
> block summarizes where each epic actually stands.

Status by epic (canonical IDs; ✅ done · ▶ pending):

- **`[deploy]` 1000** — ✅ 1010–1040 (named targets, host config, excludes/bootstrap,
  first mirror). Note: B mirror within 1040 still pending.
- **`[sync]` 2000** — ✅ 2010 node id · 2020 activity/handshake · 2030 per-page
  `_sync` stamps + diff manifest · 2040 secret sidecar · 2041 L→A push · 2042
  A→L pull · 2050 direction-detection UI (ahead/behind + nuclear modal). ✅
  **2060 publish A→B — VALIDATED (transport, dry-run) v0.10.252–255.** The full
  L→A→B relay path was proven end-to-end via the safe dry-run on the live nodes:
  A built+sent its tarball (37 files, ~1.34 MB) and B replied `httpCode:200`
  with a "would replace 9 pages / 37 files" verdict, nothing written.
  **Gotcha found + fixed (v0.10.255): A runs PHP 8.5, where `curl_close()` is
  deprecated (no-op since 8.0). The A→B dry-run was the first time
  `sync_propagate_to_peer()` ran ON A (L→A always built/sent from L's older
  PHP), so the deprecated call had never fired — Whoops escalated it to the
  generic `{"code":8192}` production fatal. Removed all 5 `curl_close($ch)` in
  the sync plugin (behavior-preserving on every PHP version).** Still pending: a
  REAL (non-dry) publish writing B — drive it from the UI button (the intended
  UX), not a curl; and note B is same-host PHP 8.5, so B must also run v0.10.255+
  before a real publish (its receive/notify-back path uses curl). Built as
  3 slices: **(1, v0.10.252)** Panel-auth gate on the same-origin local
  triggers `/sync/push`+`/sync/pull` for public nodes (they sit outside the
  `/dev/*` 403 gate) — open on L, 403 on A/B without a session. **(2,
  v0.10.253)** "Publish → B" button + dry-run/confirm modal on A's editor →
  `/sync/push/B`. **(3, v0.10.254)** L signals A→B: new bearer-gated
  `/sync/relay-push/<to>` (runs the receiver's own push; on A = A→B) + L-local
  `/sync/push-via/<via>/<to>` trigger + `sync_request_relay_push()` helper; L's
  "Publish → B" is ONE button with a confirm — real L→A, show A's state, then
  confirm → A→B. **Provenance rule (drove the whole design): B is only ever
  written by A; no physical L→B. Because A→B always runs after L→A, B can never
  lead a stale A.** ◐ **2070 snapshot retention** — S7 first slice (v0.10.213)
  shipped per-snapshot/batch DELETE + the snapshots panel. **Slice 1 (v0.10.258):
  auto-retention** — `sync_prune_auto_snapshots($keep=30)` runs at the tail of
  `sync_pre_propagate_snapshot()`, keeping the newest 30 `auto-pre-propagate`
  snapshots in THIS node's `library/`. Conservative gating: prune only when BOTH
  name-prefix AND meta `kind==='auto-pre-propagate'` match — manual snapshots
  never touched/counted; unconfirmable (corrupt-meta) autos kept. **Slice 2
  (v0.10.259): display-only folder** — `library/list` now returns `kind`+`fromRole`;
  the panel partitions snapshots so manual saves stay flat while autos collapse
  into a closed-by-default `<details>` "⟳ Auto snapshots (N)" folder (friendly
  "Pre-sync snapshot (from <role>)" labels, raw name on hover). Disk stays FLAT —
  pure presentation; Load/Delete still target real names. **→ 2070 done** (live
  UI check pending next deploy). ◐ **2080 B-freeze + unlock + B→A back-prop** —
  **Slice 1 (v0.10.260): write-route freeze enforcement.** Until now B was only
  Panel-session-gated against the public; a logged-in author could still POST
  edits to B. New sync-plugin helpers `sync_role()`, `sync_b_is_frozen()`
  (fail-closed: role B + no explicit `frozen===false` in state.json ⇒ frozen, so
  a fresh B is frozen with no migration), `sync_assert_writable()` (423 Locked).
  Guard wired into the 5 `/dev/*` routes that mutate B's SERVED content
  (editor/save, library/load = snapshot RESTORE, page upload/delete-image,
  workshop use-image). NOT on `/sync/*` — A→B propagate (`POST /sync/propagate`,
  bearer-gated) must keep writing B while frozen; that's the only sanctioned way
  B changes. **Slice 2a (v0.10.261): B-unlock state machine (server).** Routes
  `GET /sync/b-status` (informational) + Panel-gated `POST /sync/{unlock-b,
  prolong-b,backprop-b,refreeze-b}`. **Two-step UX (user's call):** unlock takes
  a planned duration (hours, clamped 15min–24h); re-freeze is GATED (409) until a
  B→A back-prop has run since the unlock. **Timed unlock + lazy auto-lock (no cron
  — B is shared hosting):** `sync_b_frozen_from_state` treats a lapsed
  `unlockExpiresAt` as frozen, so any write past expiry is refused = an active
  re-lock without a daemon; `sync_b_status()` persists the re-freeze on poll. The
  author can Prolong the window. **"Is it lost?" guarantee:** auto-lock blocks
  only NEW writes; B's content/ is untouched + still served, and the B→A back-prop
  (a `/sync/*` route, not freeze-gated) stays available even AFTER auto-lock — so
  edits are always recoverable. `pendingBackProp` (unlockedAt set, no back-prop
  since) survives auto-lock → drives S3's publish-block. State fields (additive,
  no schema bump): frozen, unlockedAt, unlockExpiresAt, unlockHours,
  lastBackPropAt, autoLockedAt. Validated by a 14-check isolation lifecycle test.
  ✅ **Slice 2b (v0.10.262 layout, v0.10.263 compact pass): B editor UI** — a
  bottom-right pill in `sync-peer-indicator.php` (B-branch, parallels A/L). Compact +
  **flush-right stacked** (resting frozen state is just `🔒 B frozen` + "Unlock to
  edit"). Unlocking opens a modal with **preset duration chips (1h/2h/4h, default
  2h)** — presets are safe because the author can Prolong — and a **strong amber hint
  ("Back B→A before re-freezing")**. **v0.10.267 — the pill is now a HORIZONTAL BAR
  glued to the bottom edge** (`left:50%`/`translateX(-50%)`/`bottom:0`), not a
  flush-right stacked column — the column + detail text was too vertically greedy.
  Same calm-dark bg + outline (amber when unlocked). Order L→R: **lock+timer · hint ·
  Back B→A · ＋Prolong · Re-freeze**. The hint is one inline slot (the 5-state Back
  B→A line; in frozen-dirty it becomes the red danger line). The timeout DETAIL text
  ("re-locks in … — Prolong") was removed — the `🔓 <countdown>` IS the timeout
  signal. Touch targets ≥40px (chips 52px).
  Back-prop modal: dry-run preview (wouldReplace pages/files/bytes) → confirm.
  **DIRTY signal = the canonical one (v0.10.263 correction).** Earlier draft computed
  a bespoke `dirty` from `lastBackPropAt ?? unlockedAt` baselines — reverted. B is the
  same binary as L/A and the divergence eval already exists: `sync_b_status()` now
  attaches `direction` (ahead/behind/equal) by running `sync_direction_between()` over
  `lastActivityAt`, fetched from A via `sync_fetch_peer_state('A')` — the SAME path
  L↔A use, just A as the peer. `dirty = direction === 'ahead'`. Fail-soft: A
  unreachable/unconfigured → `direction:'unknown'`, `peerReached:false`, UI shows no
  amber (won't guess). **Dependency:** needs A in B's `sync.peers` map (config, same
  plumbing L has; B/A same host). **Dependency:** needs A in B's `sync.peers` map.
  **v0.10.265 — Back B→A is a 5-STATE pill off TWO axes** (superseding the earlier
  one-axis `dirty===ahead`→amber). Axis 1 = on-disk `direction` (server poll).
  Axis 2 = unsaved editor BUFFER — the SAME signal L/A use: `window.edHasUnsavedData()`
  + repaint on `ed:dirty-changed`, re-poll on `ed:editor-saved`. (This was the whole
  point of the correction: B is the L-analog; the buffer axis already existed, B just
  wasn't reading it.) "light" = coloured text+outline on dark; "full" = saturated bg:
  a) equal & clean → gray, "in sync with A"; b) equal & dirty → light-amber, "save
  before pushing to A"; c) A>B (behind) → **full-red, "A is ahead — do not push"**
  (push would clobber A's newer content); d) B>A & clean → **full-amber, "data ready
  to push to A"** (the call-to-action); e) B>A & dirty → light-red, "save before
  pushing to A" (the saved part is pushable but the buffer would be left behind).
  Each state carries a little hint line under the pill, mirroring L/A's hint text
  (hint colour: gray / amber / red per spec). `backVisual()` in the snippet is the
  single state→class map; `appendBack()` renders button+hint in both the unlocked
  and frozen-dirty branches. Unreachable A (`direction:'unknown'`) → gray pill, hint
  "A unreachable — can't compare" (won't false-claim "in sync"). **Re-freeze is
  struck-through (line-through, not greyed) while inhibited** to read as deliberate.
  **GATE UNCHANGED:** re-freeze *enable* still keys on the server
  `pendingBackProp`/`backPropDoneSinceUnlock` (409 gate from S2a) — NOT on the
  divergence axis. So a freshly-unlocked-unedited B shows a gray "in sync" Back B→A
  but a struck-through Re-freeze (server forces a back-prop after any unlock). That
  transient mismatch is INTENTIONALLY deferred to the **lock-mechanism / safe-unlock
  discussion** (next): decide whether the gate should read the divergence axis so
  "nothing changed ⇒ re-freeze freely". (The earlier "compact the crowded
  bottom-right affordances" deferral is DONE — see the v0.10.267 horizontal bar
  above.) **v0.10.264 poll fix:** while
  UNLOCKED the pill re-polls every ~5s (safety net + catches A-side Publishes); 30s
  baseline kept for the frozen resting pill.
  ▶ **Lock-mechanism discussion** (gate-on-dirty? unlock safety) — NEXT, before S3. ·
  ▶ **Slice 3** (A/L block A→B publish + banner while B unlocked, via
  pendingBackProp/dirty). · 2090 "Published: <date>" snippet · 2095 holistic protocol
  review.
  Topology + operations + role-sidecar detail live in the sync memory files.
- **`[conv]` 3000** — ✅ 3010–3012 (editor route, mode toggle, redirects) ·
  3020 drop deco-mount · 3030 Styles mode · 3040 Images mode (workshop folded in) ·
  3050 data-aligned saves · 3060 consolidated `dev-editor.js`. ✅ **3065 fold STYLES
  into the unified save** (the save *action*, distinct from the already-done dirty
  *signal*) — **DONE, user-validated v0.10.249 ("save is good"); cleanup v0.10.250.**
  One Save button + Cmd-S now write lines+layout+**typography** in a single
  `/dev/editor/save` POST → a full L→A→B push is one action. **Slice A (v0.10.247,
  server):** extracted `deco_save_typography()` (one validator+writer, in
  `deco/index.php`); `/dev/editor/save` accepts a third optional `styles` section
  and echoes the normalised tokens; curl-proven. **Slice B (v0.10.248, client):**
  `styles` participant promoted to a full member (`wants:typographyDirty` +
  gather/apply); `'styles'` appended to coordinator ORDER; `reflectSaveButton()`
  now lights the shared header button for dirty typography (reads the participant's
  `dirty()` off the bus — NOT the `typographyDirty` binding, which is in TDZ at the
  boot-time first call); the standalone "Save styles" button removed from
  `editor.php` + its wiring; `saveTypography()` reduced to a `__edUnifiedSave()`
  alias. Precedent that justified it: `deco_save_lines()` already writes the
  site-wide palette through this seam, so "site-wide ⇒ separate" was never real.
  **Cleanup DONE v0.10.250:** the bare `/dev/draw/typography` route is now
  GET-only (read-only diagnostic, symmetric with `/usage`); its ~135-line POST
  validator — a duplicate of `deco_save_typography()` — is deleted, so that helper
  is the SINGLE typography writer (edit validation there). Removed too:
  `draw.php`'s dead `save-typography-btn` and the orphaned
  `.ed-typo-save-main`/`#save-typography-btn` CSS in the live stylesheet.
  **Two app-falsehood fixes v0.10.249** (per the user's rule "never give wrong
  info to the user of an app"): (1) the former cosmetic edge — typography dirty in
  Layout mode (or layout dirty in Lines mode) might leave the shared `#save-btn`
  falsely grey under the pre-6c two-scope button model — is FIXED: both
  `reflectSaveButton` (lines scope) and `syncSaveButton` (layout scope) now OR in
  the full union via `window.edHasUnsavedData()` (typeof-guarded), so the button
  reflects EVERY participant's dirtiness in EVERY mode. (2) the rect selection
  overlay (`.pe-overlay` z:2147483647) was occluding the push/pull modal — fixed by
  `isolation: isolate` on `.pe-canvas-surface`, confining that ceiling to the canvas
  stacking context (above rects, below app modals at 10000+) rather than raising
  modal z. · ▶ ~~3070 library repositioning~~ **RECLASSIFIED → 9020 (folded into
  the [ui] rework, 2026-06-12)** — analysis showed the snapshot/"library" UI is
  only a *symptom*: the whole project's initial path turned around the **draw**
  section (the mode still *named* "Lines" is semantically "Draw"; rename pending in
  9000), so 3070 is structure-behind-the-UI and can't be sliced apart from the UI
  rework. · ▶ 3080 library propagation · 3090 "All" mode (both stay in [conv] for
  now; revisit whether they also belong under the [ui]/draw-structure rework once
  9020 scopes it).
- **`[workshop]` 4000** — ✅ 4010/4011/4020/4030/4050/4060 (all landed).
- **`[dirty]` 5000** — ✅ **EPIC COMPLETE** (user-validated v0.10.246): 5010 lines
  (B) · 5020 layout (B) · 5030 styles (3a wiring + **3b derived-dirty, v0.10.245**
  — typographyDirty now = signature(state.typography) vs on-disk baseline, so a
  manual revert clears it; **v0.10.246** follow-up: a clean revert also clears the
  per-card .is-modified amber outline, not just the Save button; closes the "same
  save behavior in all 4 modes" objective) · 5040 images (RESOLVED — was a
  propagate-location bug, not a dirty gap; see the unified-dirty memory's
  2026-06-11 correction).
- **`[editor]` 6000** — ▶ 6010 dialog key-defaults + JS-vs-Panel consistency (deferred).
- **`[cleanup]` 7000** — ▶ 7010 media/ cache prune (low urgency, near project end).
- **Forward epics, registered not started** — 8010 `[backgrounds]` · **9000 `[ui]`**
  (starts by refining editor UI, then studies tablet/phone deltas): 9010 general
  editor-UI refinement · **9020 draw/library structure rework** (absorbs former
  3070 — the snapshot/"library" UI is a symptom of the project's draw-centric
  origin; reworking it *is* UI work, not a [conv] slice) · **9030 rename "Lines"
  mode → "Draw"** (the current name is an artifact of the initial path; "Draw" is
  its real semantics — do it as part of the UI pass so labels/ids/docs move
  together). · **9050 layout-mode undo** (lines & styles have snapshot undo
  → derived-dirty clears on undo-to-baseline; LAYOUT has a baseline + derived
  dirty but NO undo stack, so Cmd-Z can't walk layout content back to [0] and
  the buffer-dirty axis stays lit. Diagnosed while testing the B pill: the
  "undo doesn't return to non-dirty on B" report was THIS, not any L↔B
  divergence — re-test the B buffer axis once layout undo exists.) ·
  **9040 icon audit/refresh** (self-hosted icon library; first
  concrete nit logged: the B-pill *unlocked* glyph reads as a *closed* lock —
  needs a clearly-open-lock icon; touch-target sizing per global icon rule) ·
  10010 `[tablet]` · 11010 `[phone]` · 12010 `[bedit]` (safe fallback
  edit on B) · 13010 `[behaviors]` idea backlog.
  - **9010 nit (RESOLVED v0.10.267):** the B-pill header/pills misalignment is moot
    now that the pill is a single horizontal bottom bar (all items on one row).

Notable landings since the snapshot below: full sync layer 2010–2050; derived-dirty
B for lines/layout + styles wiring; the **image-library-unlisted fix** (v0.10.240:
the per-page image library is now an unlisted Kirby page `content/<page>/images/`
so it rides the propagate — previously a draft, excluded, so A was never seeded) +
guard template + snapshot migration (v0.10.241); sync role declared via gitignored
`sync.role.php` sidecar (fail-closed); and the work-item numbering unification
(v0.10.242–243). For the *why* behind any of these, read the matching memory file
or `git log`.

---

**Historical state snapshot (~v0.10.96–136, superseded — see Current frontier above):** Phase 1 complete (v0.9.0 milestone).
Phase 2 Slice 1 complete; Slice 2 complete; Slice 3a (typography
tokens — seed + select) landed; Slice 3b-1 (typography panel in draw
— read-only list + `dev/draw/typography` save round-trip), 3b-2
(create / rename / delete tokens), a 3b-2 follow-up "View in panel"
token preview modal (v0.10.78), and **3b-3 (per-token field editor —
family picker + size/weight/lineHeight/letterSpacing/italic, v0.10.79)**
landed. **Typography authoring is now feature-complete.** See the
Slice 3a / 3b entries below.
**Slice T1 (plain-text content on text rects, v0.10.82) landed** —
text rects now carry author-entered body copy (textarea-first), styled
by their typography token, rendered on both editor canvas and runtime.
See the Slice T1 entry below. **Slice T2 (inline on-canvas text
editing, v0.10.84; double-click fixed v0.10.85) landed** — double-click
a text rect to edit its body copy directly on the canvas
(`contenteditable="plaintext-only"`); the side-panel textarea remains as
a secondary surface. This is the tablet-first-class editing path
(double-tap on touch). See the Slice T2 entry below. **Slice TS1
(governed rich text — offset-marks engine + live WYSIWYG + strong/em
B/I toolbar, v0.10.86 → v0.10.91) landed** — text rects now carry a
`marks` field (additive within schema v3, no bump); the contenteditable
surface is now `true` (live styled spans while typing); a floating B/I
toolbar applies/composes/removes atomic styles over a selection; render
parity in JS + PHP. **Two post-TS1 fixes followed user testing:**
(v0.10.92) ⌘B/⌘I are now intercepted (preventDefault) and routed
through the mark engine — `contenteditable="true"` runs native
`execCommand('bold'/'italic')` on those shortcuts, which would inject
foreign `<b>`/`<i>`/`style=` nodes OUTSIDE the marks model and silently
corrupt saved data; routing them through `toggleStyle` also fixes the
toolbar pressed-state not updating after a keyboard toggle. (Note: a
single-master display font like Bungee Hairline has no bold weight, so
`font-weight:700` is visually imperceptible on a heading token — that's
the font, not a bug; test bold on a body/Inter token.) (v0.10.93) The
editor renders `.pe-rect-text` in a neutral high-contrast dark
(`rgba(0,0,0,0.85)`) instead of the inherited palette `text` token —
editor stylesheet ONLY, runtime (canvas-page.css) still honours the real
palette colour. Rationale: the palette `text` token is currently
`#FFDD00` (yellow), unreadable on pale pastel kind backgrounds, and there
is no per-text colour UI yet (that's TS3). **CORRECTION (2026-06): this
is NOT a removable temporary, and the "remove once TS3" premise was
wrong.** Investigation while planning the retirement found the override is
LOAD-BEARING: kind-colour backgrounds (`--*-kind-text` etc., the pale
`#cfe4ff` fill) are a Slice-1 placeholder used as the rect fill on BOTH
surfaces (editor `.pe-rect--text` and runtime `.rect--text`), and the
palette `text` token is authored to pair with a *general page background*
that does not exist yet. TS3 colour marks only colour SOME runs; uncoloured
runs still inherit the yellow token on the pale kind fill → unreadable. So
coloured `mk-color-*` runs already override this rule (direct child class
beats inherited parent colour); it only affects uncoloured text, where it
supplies a legible editor default. **The real fix is the general
background** (see the dedicated decision note further down) — once text
rects render transparent over a real general background, the override
falls out naturally. Until then it stays. **Slice TS2 (toolbar completeness, v0.10.94 →
v0.10.95) landed** — two pieces (underline / a 3rd atomic axis was
explicitly deferred): (TS2-a, v0.10.94) the B/I buttons are now
THREE-state — `rangeAttrCoverage → none|some|all` drives off /
`.is-mixed` (dashed accent, indeterminate) / `.is-active`, so a
selection spanning bold + plain no longer reads as "nothing bold."
Editor-only. (TS2-b, v0.10.95) **collapsed-caret pending format**:
toggling with just a caret sets `pendingAttrs` (a Set, or null), applied
to the NEXT typed chars in `handleEditInput`. Non-obvious bits worth
remembering: an EMPTY Set is a real "type unstyled here" override (vs
null = natural inheritance) — that's how "caret inside bold, hit B, type"
splits the run; pending PERSISTS across consecutive typing (normalize
coalesces per-keystroke marks); the live-WYSIWYG repaint is SKIPPED
during IME composition (`ev.isComposing`) because rebuilding the node
aborts composition; and the clearing policy deliberately AVOIDS
`selectionchange` (it races with `input`) — pending clears on
caret-moving keys, a caret-repositioning pointerdown, and a non-empty
selection. `effAttrsAt(caret)` also lights the toolbar when a bare caret
sits inside a run. The M1/M2 cascade roadmap (named char-styles as the
governed default, atomic overrides as the escape hatch) + deferred
TS3/TS4 are in the Slice TS1 entry's roadmap callout below.
**Slice TS3-a (valued `color` marks — palette-ref text colour,
v0.10.96) landed** — the first VALUED mark axis (vs TS1/TS2's atomic
boolean strong/em). Scope was narrowed by two decisions: build **color
first** (link is TS3-b), and **defer the `token` axis to TS4** (it
overlaps M2 named character-styles — build it once there). What changed:
(1) **Segment shape evolved from bare attr names to value-bearing
descriptors** — `segments()`/`deco_text_segments()` now emit
`attrs: [{attr, value}]` (was `['strong']`), deduped by attr+value, in
BOTH JS and PHP. Class mappers (`attrsToClasses`/`deco_marks_classes`)
consume the value: `color` → `mk-color-<id>` (id char-whitelisted),
atomic axes → static `mk-strong`/`mk-em`; both tolerate the legacy
bare-string shape for safety. (2) **Dynamic CSS emitter**
`deco_palette_marks_css($palette)` (in `deco/index.php`, modeled on
`deco_typography_css`) emits `.mk-color-<id>{color:<val>}` per palette
entry — value validated against the safe-CSS-colour regex, unsafe values
skipped. Wired into BOTH `canvas-page.php` (runtime) and `page.php`
(editor, for WYSIWYG parity); `page.php` also now passes `palette` in the
editor JSON payload. (3) **Engine op `setMark` (OVERWRITE, not toggle)** —
valued axes are one-value-per-char: `setMark` clears the attr over
`[a,b)` then adds the new value, so applying a colour over part of an
existing colour SPLITS the run (validated: black over "round" inside
green "roundtrip" → black "round" + green "trip"). Atomic axes keep
`applyMark`/toggle. (4) **Palette-swatch toolbar** — `buildTextToolbar`
appends a divider, a clear chip (diagonal-slash, `applyColor(null)`), and
one chip per palette colour FILLED with its real colour;
`updateToolbarPressed` lights the active swatch via `currentMarkValue`.
`applyColor` is selection-only (no-op on a collapsed caret — pending-color
deferred). Governance: shape-only validation in the save route (NO
change needed — `value` already accepts `<=256`-char strings); a dangling
palette id degrades gracefully (no rule → inherited colour), same as a
dangling `typographyId`. **No schema bump** (additive within rects
schema v3; save still writes `schemaVersion: 3`). **The v0.10.93
neutral-editor-colour override is KEPT** — still needed so UNcoloured
editor text stays readable on pale backgrounds; retiring it is a separate
WYSIWYG-background concern, not unblocked by TS3-a. Validated end-to-end:
PHP runtime spans + emitted rules, editor render-from-disk, interactive
swatch apply, overwrite-split, clear, and computed-RGB parity. Next:
**TS3-b (link)**, then **TS4 (M2 named char-styles, incl. the `token`
axis)**.
**Slice TS3-b-1 (link marks — render + runtime parity + governance,
v0.10.97) landed.** The `link` valued axis needs ZERO new engine ops —
`setMark`/`segments`/`currentMarkValue`/`normalizeMarks` are already
generic over valued attrs. Link differs from colour in three ways only,
all at the render/governance edges: (1) **renders as a real `<a href>`**,
not a `<span class>` — the value is an href (attribute), not a class
fragment. `renderRunsInto` (JS) and the `canvas-page.php` loop emit
`<a class="mk-link …" href>` for a link segment, with any atomic/colour
classes riding on the SAME `<a>` (a bold-coloured link styles correctly;
validated: link+colour+strong over "four" split at the strong boundary
into two anchors `mk-link mk-color-… [mk-strong]`). `classForMark`/
`deco_marks_classes` return null for `link` (no class); `mk-link` is added
explicitly at render. (2) **Governance:** `safeHref` (JS) /
`deco_safe_href` (PHP) — IDENTICAL allowlist: relative/anchor/root-
relative always safe; `http(s):`/`mailto:`/`tel:` the only permitted
explicit schemes; ANY other scheme-like prefix (`javascript:`, `data:`,
`vbscript:`, `file:`, incl. uppercase/whitespace-padded) → rejected → the
run renders as PLAIN TEXT (no anchor). Render-time defence-in-depth
(independent of the save-route check in TS3-b-2), so a hand-edited
rects.json can't emit a `javascript:` link. `linkHref`/`deco_marks_href`
pull the first safe href from a segment's attrs. (3) **CSS:**
`.mk-link { text-decoration: underline }` ONLY (both dev-page.css and
canvas-page.css) — NO colour, deliberately. Link = underline affordance;
colour stays the separate `color` axis, so a link inherits the typography/
colour-mark colour with ZERO cascade fight (sidesteps the equal-
specificity `.mk-link` vs `.mk-color-*` problem entirely). The editor `<a>`
sits in contenteditable so a plain click places the caret (doesn't
navigate); `cursor:text` reinforces that. Validated: safeHref allowlist
unit cases; runtime + editor render BYTE-IDENTICAL structure (anchor,
escaped href, `javascript:` stripped, link+colour+strong composition,
computed underline). Link marks were hand-seeded for that sub-slice; the
authoring UI is TS3-b-2 (below).
**Slice TS3-b-2 (link authoring UI + save-route gate, v0.10.99) landed.**
The text toolbar gained a chain-link button + an inline URL editor, plus a
save-route scheme check. Three things made link's UI genuinely different
from the colour swatches (which apply on click and never take focus):
(1) **The URL `<input>` must take focus** — and focusing it blurs the
editable, whose `blur`→`commitEdit` would otherwise tear down the whole
edit before the author can type. Fix: the editable's blur handler checks
`ev.relatedTarget` — if focus moved INTO `#pe-text-toolbar` (the input or
its Apply/Cancel buttons) it skips the commit; every other blur commits as
before. The Apply/Cancel buttons still use the `pointerdown`+`mousedown`
preventDefault focus-guard (like B/I) so clicking them keeps focus in the
input. (2) **Selection capture timing** — the Link button preventDefaults
its pointerdown (selection stays alive), `openLinkInput` snapshots the
range into `savedLinkRange` BEFORE moving focus to the input, and
apply/remove operate on that saved range (the live DOM selection is gone
once the input has focus). On close, focus + the saved selection are
restored to the editable so editing continues seamlessly. (3) **Progressive
disclosure** — closed = just the link button; open = the button + a
full-width input row (wraps under the buttons; the toolbar is flex-wrap)
with Apply (✓) and Cancel (×). The input PREFILLS the existing href when
the selection is one uniform link (`currentMarkValue(...,'link')`); empty +
Apply REMOVES the link; an unsafe/unsupported scheme is rejected inline
(`safeHref` returns null → red `.pe-tt-link-err`, editor stays open) so a
bad value never even becomes a mark. The link button reuses the generic
`rangeAttrCoverage` pressed-state loop (`dataset.attr='link'`) — it lights
when the selection is fully linked, for free. Apply/remove go through the
SAME generic `setMark(…,'link',value|null)` engine op — zero new engine
code. **Save-route gate** (config.php): after the generic mark-shape
validation, `attr==='link'` values are run through `deco_safe_href` (the
same allowlist as render); a value that fails → the route `$fail`s BEFORE
writing, so a forged save body can't persist a `javascript:`/`data:` link.
Validated end-to-end via preview eval (synchronous-pointerdown edit entry):
open/prefill/apply (renders `<a class="mk-link mk-color-… mk-strong" href>`
— composes with colour+strong), `javascript:` rejected inline with the
existing safe link intact, empty-Apply removes the link leaving colour+
strong, Cancel closes + restores selection, pressed-state toggles, blur
guard keeps the edit alive; and the save route rejects a `javascript:`
link with NO write (file byte-identical).
**Underline — 3rd atomic axis (v0.10.104):** completes the atomic-toggle set
(strong/em/underline). Pure additive wiring, no schema bump (same `value:true`
shape inside rects-content v3). Five touch points, all symmetric to strong/em:
(1) `MARK_ATTR_CLASS` in dev-page.js gains `underline:'mk-underline'`;
(2) `buildTextToolbar` `defs` gains `{attr:'underline',label:'U',title:'Underline (selection)'}`
— pressed-state (none/some/all → is-active/is-mixed) works for free via
`rangeAttrCoverage`/`dataset.attr`; (3) ⌘/Ctrl+U routed to `toggleStyle('underline')`
in the editable keydown (preventDefault stops native `execCommand('underline')`
injecting foreign `<u>` outside the model — same correctness hazard as ⌘B/⌘I);
(4) `.mk-underline{text-decoration:underline}` added to BOTH dev-page.css
(`.pe-rect-text`) and canvas-page.css (`.rect-text`) for editor↔runtime parity;
(5) PHP `deco_marks_classes` static `$map` gains `'underline'=>'mk-underline'`.
NO save-route change — the route validates mark *shape* only (slug regex
`/^[a-z][a-z0-9_-]{0,31}$/` + `value===true`), no attr allowlist, so `underline`
passes already. Validated via preview synthetic test: edit-entry → select "T2" →
U button → `<span class="mk-underline">` with computed `text-decoration:underline`,
button `is-active`, composes with existing colour/strong/em marks; reloaded to
discard the in-memory mutation (no Save fired, fixture untouched). Runtime PHP
parity relied on symmetry with strong/em (already render at runtime) since
verifying it would require persisting an underline mark to the shared fixture.
**TS4 Slice 1 — M2 named character-styles, engine+render+cascade (v0.10.106):**
A **char-style** is a NAMED, **RELATIVE**, **type-only** style applied to a text
RANGE via a new valued mark axis `charStyle` (string value = style id). This is
the deliberate counter to a trap we named explicitly: reusing absolute rect-role
typography tokens (e.g. "Heading 48px") *inline* would blow up a few words to
heading size. So char-styles express **deltas in CSS-native relative units** —
`sizeEm`→`font-size:<n>em`, `weight`→`font-weight:bolder|lighter`,
`italic`→`font-style:italic|normal`, `letterSpacingEm`→`letter-spacing:<n>em`.
Colour is deliberately NOT a char-style field (it stays the orthogonal `color`
axis), exactly like typography tokens. Honest limitations baked in: bolder/lighter
are coarse (no arbitrary +200); letter-spacing replaces, not adds.

The **cascade — rect base token < named char-style < atomic override — needs NO
resolver logic; it falls out of CSS specificity:**
- atomic axes emit as descendant selectors `.pe-rect-text .mk-strong` / runtime
  `.rect-text .mk-strong` → specificity **(0,2,0)**;
- char-styles emit as a BARE single class `.mk-cs-<id>` → **(0,1,0)**;
- the rect's typography token `.ty-<id>` sets font props on the rect and reaches
  the run only by *inheritance* — a direct class on the child always beats it.
So `.mk-cs-<id>` (0,1,0) beats the inherited token; the atomic `.mk-*` (0,2,0)
beats `.mk-cs-<id>`. Verified empirically (synthetic fixture under a real
`.pe-rect-text`, base 20px/400): char-style alone → 100 (bare beats inherited);
char-style **+ strong** → 700 (atomic wins). That is the full M1/M2 ordering.

Registry mirrors typography-tokens.json: `_shared/char-styles.json` shape
`{schemaVersion, styles:[{id,name,sizeEm?,weight?,italic?,letterSpacingEm?}]}`,
with `deco_default_charstyles()` seeding `lead-in`/`fine-print`/`quote` so the
axis works end-to-end with **no file present**. Slice 1 touch points (all
symmetric to the `color` axis): PHP `deco_load_charstyles`/`deco_charstyle_marks_css`
+ a `charStyle` branch in `deco_marks_classes` (index.php); both templates load
`$charStyles` and emit `deco_charstyle_marks_css($charStyles)` in their `<style>`
block (page.php editor + canvas-page.php runtime — verified identical 3 rules on
both surfaces); editor JS `classForMark` gains a `charStyle`→`mk-cs-<id>` branch
and `state.charStyles`/`csById` normalization (consumed by the Slice-2 picker).
**No schema bump** (additive within rects-content v3). **No save-route change** —
`charStyle` is a string-valued mark; the route validates mark *shape* only
(slug regex + value ≤256 chars), no attr allowlist, so it passes already.
There is **no authoring UI yet** — a charStyle mark can't be *created* in the
editor until Slice 2, so this slice was verified at the CSS/render+parity layer
(no mark persisted to the shared fixture, no Save fired).

**TS4 Slice 2 — toolbar char-style picker (v0.10.107):** the authoring surface
for *applying* (not yet creating) char-styles. Three additions to dev-page.js,
each a structural clone of the proven `color` axis:
- `applyCharStyle(value)` — identical to `applyColor` but attr `'charStyle'`:
  selection-only, OVERWRITE semantics via `setMark` (one char-style per char),
  rebuilds spans + restores the selection. `value === null` clears.
- chip row in `buildTextToolbar` (after the colour swatches): a divider, an `×`
  clear chip, then one `.pe-tt-cs` pill per `state.charStyles` entry. Each pill's
  label is wrapped in a `.mk-cs-<id>` span so it **previews the actual style**
  (Lead-in bold, Fine print small, Quote italic) — same WYSIWYG principle as the
  colour swatches. Same `pointerdown`/`mousedown` `preventDefault` focus-guard.
- active-state loop in `updateToolbarPressed` (mirrors the swatch loop): lights
  the chip whose value uniformly covers the selection via `currentMarkValue(...,
  'charStyle')`; lights `×` when a selection carries no single char-style.
CSS: `.pe-tt-cs` pills in dev-page.css (2rem tall = button height, auto width,
accent `.is-active`) — sized as real touch targets for the tablet editor.

Verified through the **actual toolbar UI** in preview (synthetic double-tap to
enter edit mode — NB the rect node is replaced on the select-render, so re-query
the element between the two taps; a stale ref silently no-ops the 2nd tap): the
chips render with correct labels+preview classes; selecting a range + clicking
"Quote" produces a `mk-cs-quote` run (italic, 31.5px = 1.05em × the subhead 30px
base) and lights the chip; applying **strong** over it yields one run with
`mk-cs-quote mk-strong` → italic (char-style) **+** 700 (atomic wins) + 31.5px,
proving compose+cascade through the real UI. Reloaded to discard (no Save fired;
on-disk marks unchanged). No schema/save-route change (still a string-valued
mark). **No authoring UI for the registry yet** — char-styles come from
`deco_default_charstyles()` until Slice 3 builds the editor.

**TS4 Slice 2 bugfix — save rejected `charStyle` marks (v0.10.108):** the very
first real save of a char-style failed with `save failed · Rect mark attr must
be a lowercase slug (1..32 chars)`. Root cause: the save-route attr validator in
`config.php` (~L1429) was `/^[a-z][a-z0-9_-]{0,31}$/` — **strictly lowercase**,
written when every axis name (strong/em/underline/color/link) was a lowercase
slug. TS4 introduced the FIRST camelCase attr, `charStyle`, and nothing updated
the validator. Fix: body now allows `[a-zA-Z0-9_-]` (first char still lowercase):
`/^[a-z][a-zA-Z0-9_-]{0,31}$/`; message reworded to "slug starting lowercase".
Verified end-to-end via a real save-route round-trip (curl POST with a `charStyle`
mark → `{"ok":true}`, persisted on disk, then restored original — content left
byte-identical). **Lesson:** the attr namespace is camelCase-capable now; any
future axis name is fine as long as it starts lowercase.

Same iteration also fixed the **save-error toast UX** (author missed the failure
because it was discreet and auto-vanished): save failures now render as a
**sticky red pill** (`.pe-status.is-error`, white/bold on `#c4283b`) that persists
until the next save attempt or a success — instead of the grey, glanced-past,
4s-auto-clearing line. Mechanism: `setTransient(text, ms, isError)` — `ms <= 0`
→ `until = Infinity` (sticky); `isError` toggles the `is-error` class in
`writeStatus`; `doSave` clears `transientStatus` at the start of each attempt so
a fixed error doesn't linger. Success/info toasts stay transient as before.

**TS4 Slice 3 — char-style authoring panel (v0.10.109 backend + v0.10.110 UI):**
the surface for CREATING/editing/deleting char-styles, in the DRAW editor
(`/dev/draw`) — NOT the page editor. Modeled on the typography panel but adapted
for the char-style **omit-unset** data model.
- **Slice 3.1 — save route (v0.10.109, config.php):** new `dev/draw/charstyles`
  GET|POST, a clone of `dev/draw/typography`. POST validates+persists
  `_shared/char-styles.json` (`{schemaVersion:1, styles, savedAt, count}`, atomic
  .tmp+rename). The KEY difference from typography: **omit-unset** — every field
  (`sizeEm`/`weight`/`italic`/`letterSpacingEm`) is OPTIONAL; only set fields are
  written to the stored entry, so an unset key is ABSENT (→ inherits), never a
  zero/empty placeholder. `italic` is **tri-state**: key absent (inherit) ≠
  `false`/"upright" ≠ `true`. Clamps: sizeEm 0.1–10, letterSpacingEm −2..2;
  `weight` only `bolder`|`lighter`; id `/^[a-z0-9_-]{1,64}$/` with dup rejection.
  GET returns `{ok, styles}`. This envelope's `schemaVersion:1` is its own axis
  (mirrors typography-tokens.json) — NOT the rects-content axis, so no bump/auth.
- **Slice 3.2 — panel UI (v0.10.110, dev-draw.js + draw.php + dev-draw.css):**
  draw.php loads `$charStyles = deco_load_charstyles(...)`, passes it in the JSON
  payload, and emits an `#ed-charstyle-css` `<style>`. The panel reuses the
  `.ed-typo-*` row/header/spec CSS (DRY) with a "Character styles" section
  (`+ Style` / `Save`, `#charstyle-list`). Each row: name input (slugify-renames
  the id for UNSAVED styles only), `cs-<id>` tag, sample `Base text <span
  class="mk-cs-<id>">styled Ag</span>`, a spec line (set fields joined, or
  "inherit (no overrides)"), and expanded fields = `csEmField` Size (em),
  select Weight, select Italic, `csEmField` Letter spacing (em). `csEmField`
  blanks→`onChange(null)`; each handler does `delete c.field` when unset, so the
  in-memory object stays omit-unset too. `rebuildCharstyleClientCss()` mirrors the
  PHP `deco_charstyle_marks_css()` emitter into `#ed-charstyle-css-live` for live
  preview (only set fields, same clamps). `addCharStyle()` pushes `{id, name:'New
  style'}` only (no fields). Save POSTs `{styles}`, adopts `j.styles`, locks the
  new-id slugify-rename. Dirty state: amber `#save-charstyles-btn.is-dirty`.
  Verified end-to-end through the real UI: add → slug-rename → set sizeEm (live
  preview + spec update, omit-unset confirmed) → Save (file written with only set
  fields, tri-state italic intact) → Delete; then the test file was removed to
  restore the no-file seed-fallback state (content left as found).

**Style-panel UI polish (v0.10.111):** three principle-violations the author
flagged on the Character-styles panel (and shared `.ed-typo-*` styling, so the
Typography panel benefited too): (a) the panel-head title wrapped mid-phrase →
`.ed-panel-head` now `flex-wrap: wrap` + `h3 { white-space: nowrap }`, so the
title stays on one line and the buttons drop to their own row only if cramped;
(b) `.ed-mini` buttons wrapped their own labels → `white-space: nowrap`; (c) the
per-row edit affordance was a tiny grey `▸` triangle the author couldn't find
("I thought edit is impossible") → now a clearly bordered accent **"Edit ▸"**
button (label + chevron, amber when open) — a labelled control, not an icon-only
micro-glyph (icon-sizing rule). JS: the toggle textContent is now `Edit ▾`/`Edit ▸`.

**ARCHITECTURE — "Element styles" one-layer model (decided 2026-06, supersedes the
TS4 relative-char-style direction).** The author rethought what "a project style"
is. Conclusion: a project defines **COMPLETE, named styles for each kind of text
element** ("normal text is so-and-so, titles so-and-so, subtitles…") with **no
opportunity to diverge** — a style carries EVERYTHING, *in particular colour*, not
just typography. The designer's mental model is **ONE layer**: a single registry of
named complete-property containers. The relative em-delta "char-style" middle layer
(TS4 Slices 1–3) is **RETIRED as a concept**; its **range-mark MECHANISM is
repurposed** to carry complete-style ids. Key decisions:
- **Applied to ANY text sequence via the offset-marks range method** — NOT snapped to
  paragraph granularity. (Author correction: text is first-class content; forcing many
  positioned blocks for what is mentally one text element is backwards. The range engine
  already proven in TS1–TS4 is exactly right.) Each text rect keeps a DEFAULT element
  style (today's `typographyId`); a range mark overrides it for a sub-sequence.
- **Colour is a PALETTE-ID reference** on the style (never free hex), resolved to a CSS
  value at emit time via the palette — mirrors the atomic `color` mark.
- **Escape hatch retained but NOT first-class (author precision, 2026-06):** atomic inline
  marks (strong/em/underline/color) stay as the sparse per-axis override, winning over the
  element style — but the UI **must not encourage them**. The primary styles panel presents
  **ONLY the named element styles, as buttons** (the governed path). The atomic overrides
  are **hidden behind an icon** that opens a **separate overrides panel** containing all of
  them. Two reasons: (1) deliberately de-emphasise divergence; (2) the full set of overrides
  may be too much to show on the primary panel. → This is a Slice-B change: the existing
  TS1 B/I toolbar + TS4 char-style picker on the page editor must be reworked into
  "element-style buttons (primary) + an icon that reveals the overrides panel (secondary)".
- **Editing styles panel = moveable + viewport-fixed (author precision, 2026-06):** the
  styles panel shown *while editing text* must be **draggable** (the user drops it wherever
  suits the current work) and **`position: fixed` to the viewport — it must NOT scroll with
  the page**. Rationale: for tall text blocks a scroll-following / rect-anchored panel
  scrolls out of view, stranding the author mid-edit. → Slice-B implication: the current
  TS1 toolbar is a small floating bar anchored near the rect; replace with a **fixed,
  user-positioned panel** (remember its position for the session). The icon-opened overrides
  panel (above) lives under the same moveable/fixed surface so the whole styling affordance
  stays put.
- **Totality — one DEFAULT, no undefined style (author precision, 2026-06):** the registry
  **declares exactly ONE style as the default**, and **there is NO possibility of an
  undefined/unset style**. Every text resolves to a *defined* element style: a rect's
  default and every range both fall back to the **declared default style**, NOT to
  browser-inherited defaults. → This **revises A1's degradation note**: a dangling/absent
  style ref must resolve to the **default element style**, not "inherit" (the
  graceful-inherit framing was for the old typographyId model; under totality the fallback
  is the default style). **Style-level colour "— inherit —" — CONFIRMED by author
  (2026-06): it stays.** A *defined* style declaring inherit-colour is a governed choice,
  not divergence (divergence = the per-instance escape hatch). BUT the **default style must
  carry a concrete palette colour** (it's the root fallback — it can't itself inherit, or
  there's nothing to resolve to). A2 enforces this: the default style's colour field has no
  "— inherit —" option (or validation rejects a null colour on the default); non-default
  styles keep it.
- **One registry (target):** unify `typography-tokens.json` (`.ty-<id>`) as THE element-
  style registry; the separate `char-styles.json` / `.mk-cs-<id>` layer is retired. The
  registry must guarantee exactly one `isDefault` style (seed one; forbid deleting the last
  / the default without reassigning).
- **Why "Element styles", not "Styles" — naming encodes a direction (author, 2026-06).**
  "Styles" silently asserts *text*; **"element styles"** keeps the registry conceptually
  applicable to **any element**, text being just one kind. The name is a deliberate guard
  against re-baking a text-only assumption into the model. It ties to a divergence the
  author considers accidental and wants to converge: today a **Page text block**
  (`kind=text`, `rect.text` + marks) and a **Draw text block** are two parallel text
  mechanisms — an unintended fork. **Intended convergence:** a Page **deco-mount** block
  starts as a **neutral, non-content-typed element**, and acquires content-type by what it
  *mounts* — mounting a Draw text block makes it **behave like a native Page text block**.
  So the deco-mount is the generic "element"; "text" (or image, …) is an acquired role, not
  a birth `kind`. **Slice-B+ implication:** keep element-style application element-generic —
  apply styles to an element / its text ranges without assuming the element is permanently a
  `kind==='text'` rect, so the SAME registry later applies uniformly to a deco-mounted Draw
  text block, not only to today's native Page text rects. Don't foreclose this (avoid new
  hard `kind==='text'` gates beyond what the current mechanism already has). The full
  Draw↔Page convergence is its own future track, not Slice B — but B must not dig the fork
  deeper.
- **The convergence payoff is a property *union*, not just "behaves like a text block"
  (author refinement, 2026-06).** The two forks today carry **complementary, non-overlapping
  capability sets:** a **Draw text block has behaviors** (animation / interaction) **but
  limited style;** a **Page text block has (rich element) style but no behaviors.** So
  mounting a Draw text block inside a Page **deco-mount** isn't merely "make Page-text behave
  like Draw" — it lets a *single piece of text* carry **both** Draw's behaviors **and** the
  Page element-style system at once. That combination is the interesting capability the
  convergence unlocks; it's the actual reason to pursue deco-mount over duplicating features
  on either side. **Caveat flagged by the author:** the Draw text block's *own* limited
  styling "may have become outdated" now that the Element-styles registry exists — so part of
  convergence is likely **retiring Draw's bespoke text styling in favour of the shared
  Element-styles registry**, leaving Draw to own *behaviors* and the registry to own *style*
  (clean separation of concerns). Not actioned now; recorded so the convergence track
  doesn't re-entrench Draw's old style layer.

**Revised slice plan (replaces "TS4 Slice 4"):**
- **A1 — add `color` (palette-ref) to the element style** ✅ DONE (v0.10.112). Data +
  panel field + CSS emitter + runtime read. *This is the author's "in particular it
  should include colours," shippable on its own.* (entry below.)
- **A2** — collapse to one registry. Sub-sliced:
  - **A2-1 — totality / one DEFAULT style** ✅ DONE (v0.10.113). `isDefault` on each style;
    seed + load-normalisation guarantee exactly one; save-route enforces it + default-carries-
    concrete-colour; draw panel "Make default" radio-badge + delete-guard + default's colour
    field drops "— inherit —". (entry below.)
  - **A2-2 + A2-3 — one panel** ✅ DONE (v0.10.114). Renamed the DRAW panel to **"Element
    styles"** (`+ Style`; file/route/`.ty-` class unchanged) AND removed the separate
    **Character-styles authoring panel** (done together to avoid a confusing dual-panel
    state). The char-styles data + `.mk-cs-<id>` rendering + page-editor picker survive until
    Slice B repurposes the range-mark; the now-unreachable char-style JS in dev-draw.js is
    guarded (no-ops) and removed in Slice D. (entry below.)
- **B** — per-RANGE application in the PAGE editor. Sub-sliced:
  - **B1 — data + render layer** ✅ DONE (v0.10.125). New `elementStyle` range mark carrying
    a COMPLETE element-style id; `classForMark` emits the SAME `.ty-<id>` class directly on the
    run span; the atomic-colour tie broken in the shared emitter. (entry below.)
  - **B2 — rect default-style resolution (type axes)** ✅ DONE (v0.10.126). `typographyId ==
    null` (and any dangling ref) now resolves to the **declared default** element style, not
    browser defaults. *Colour axis at container level is masked by the load-bearing
    `.pe-rect-text` editor override until Slice D — see entry below.* (entry below.)
  - **B3** — toolbar/panel rework (HANDOFF "one-layer" arch notes), in sub-slices:
    - **B3-1 — element-style BUTTONS (governed primary picker)** ✅ DONE (v0.10.127). Replaces the
      retired TS4 char-style chips with one button per registered element style (+ a "clear"
      chip → revert range to rect default), each previewing via `.ty-<id>`. (entry below.)
    - **B3-2 — atomic overrides behind an fx disclosure** ✅ DONE (v0.10.128). B/I/U, colour
      swatches, link all moved into a collapsible secondary row; element-style buttons + an fx
      toggle are the always-visible primary row. (entry below.)
    - **B3-3 — draggable panel + remembered position + null-option relabel** ✅ DONE (v0.10.129).
      A drag grip moves the whole `position:fixed` toolbar (pointer events → touch-ready);
      session-remembered position (viewport-clamped, double-tap grip to reset); the selection-
      panel typography picker null option relabelled "none" → "— Default (<name>) —". (entry below.)
    - **B3-4 — floating-panel restyle: link first-class + computed pill layout** ✅ DONE
      (v0.10.130). The bar is now a vertical row-stack: a TITLE BAR (drag grip + first-class
      link & fx buttons), a PILLS row whose width is COMPUTED so the element-style pills tile on
      the fewest rows that fit the viewport, then full-width link read-out / link input rows, then
      the collapsible overrides. The link button left the overrides disclosure (it's first-class
      now); the overrides inherit the bar's computed width so colour swatches stop wrapping. (entry below.)
    - **B3 COMPLETE.**
    - **C — runtime parity (element-style ranges render on the public page)** ✅ DONE
      (v0.10.133). The single remaining gap was a one-branch addition: PHP `deco_marks_classes`
      now maps `elementStyle` → bare `ty-<id>`, mirroring `classForMark()` in dev-page.js. The
      rest of the runtime pipeline was already in place (`deco_text_segments` segmentation,
      `deco_typography_css` already emits the `.ty-<id>` rules, canvas-page.php already renders
      runs via `deco_marks_classes`, the save route already accepts `elementStyle` marks via the
      lenient slug+value validation). (entry below.)
- **D** — remove the stranded TS4 relative-char-style subsystem (sliced D1/D2/D3), then
  escape-hatch reconciliation + dangling-style-ref governance; **then general page
  background** (below).
    - **D1 — page editor** ✅ DONE (v0.10.134). Removed `state.charStyles`/`csById` normalize,
      the `charStyle` branch in `classForMark`, and the orphaned `applyCharStyle()` from
      dev-page.js. (entry below.)
    - **D2 — Draw editor authoring surface** ✅ DONE (v0.10.135). Removed the dead char-style
      panel JS from dev-draw.js (state init, `rebuildCharstyleClientCss`, `renderCharStyleList`,
      `addCharStyle`, `deleteCharStyle`, `saveCharStyles`, dirty flags, init wiring) + its CSS in
      dev-draw.css (`#save-charstyles-btn.is-dirty`, `.ed-cs-sample`). The panel HTML was already
      retired in A2-3, so this was pure dead-code removal — the init wiring was guarded null-checks
      hitting non-existent DOM. (entry below.)
    - **D3 — backend + registry** ✅ DONE (v0.10.136). Removed `deco_load_charstyles`/
      `deco_charstyle_marks_css`/`deco_default_charstyles` + the `charStyle` branch in
      `deco_marks_classes` (`site/plugins/deco/index.php`); the `dev/draw/charstyles` save+GET
      route (`config.php`, now 404); the `$charStyles` loading + `deco_charstyle_marks_css(...)`
      emission + `#ed-charstyle-css` `<style>` in `canvas-page.php` / `page.php` / `draw.php`.
      **KEPT** (deliberately) the camelCase attr-slug pattern `/^[a-z][a-zA-Z0-9_-]{0,31}$/` in
      config.php — `elementStyle` marks depend on it (comment updated to say so). The orphaned
      `content/_shared/char-styles.json` is gitignored USER DATA — left on disk UNTOUCHED (nothing
      reads it now; the user can delete it manually). Verified: all PHP lints clean; /dev/draw,
      /dev/page, /test-page-3 all 200 with zero char-style refs; GET /dev/draw/charstyles → 404;
      both editors init (page: rects render; draw: 7 typo + 7 palette rows) with no console errors.
    - **SLICE D COMPLETE.** The stranded TS4 relative-char-style subsystem is fully removed across
      page editor, Draw editor, and backend/runtime. Remaining D-bucket work (escape-hatch
      reconciliation, dangling-style-ref governance, the `.pe-rect-text` colour-override retirement)
      is independent and tracked separately below.

> **Working rule — legacy/test data has no value (2026-06).** Existing
> `content/*` is disposable test data, not real content. Do NOT spend effort fixing
> how legacy/unstyled rects render, and do NOT pre-compute fix options before
> confirming the issue is worth solving — establishing value comes first.
> *Recorded dead end (don't re-investigate):* unstyled text shows differently
> editor vs runtime — editor forces `.pe-rect-text { color: rgba(0,0,0,0.85) }`
> (black) on uncoloured runs, while the runtime applies NO style to a null/dangling
> `typographyId` rect (canvas-page.php never mirrored B2 totality → text inherits
> the block/palette colour, and browser-default family/size). Only bites legacy
> `typographyId:null` test rects; real styled content never hits it. Intentionally
> NOT fixed.

**Element styles C — runtime parity: element-style ranges render on the public page (v0.10.133).**
The last piece of the element-styles unit. An `elementStyle` range mark carries a complete
element-style id and (decision A) emits the SAME bare `.ty-<id>` class the rect's default style
uses. The editor already did this (`classForMark` in dev-page.js); the public runtime did not —
`deco_marks_classes` had branches for strong/em/underline/color/charStyle but no `elementStyle`,
so a styled range fell through to no class and rendered as the rect default on the public page.
Fix = one branch in `deco_marks_classes` (`site/plugins/deco/index.php`): `elementStyle` → `ty-`
+ sanitised id, exactly mirroring the JS. **Everything else was already in place** and needed no
change:
- `deco_text_segments` already segments marks identically to the JS `segments`.
- `deco_typography_css` already emits the bare `.ty-<id>` rules (0,1,0) — so the class an
  elementStyle range emits already HAS a styled rule at runtime; canvas-page.php already calls it.
- canvas-page.php already renders each run via `deco_marks_classes` → `<span class="…">`.
- The save route already persists `elementStyle` marks (attr matches the lenient
  `/^[a-z][a-zA-Z0-9_-]{0,31}$/` slug; a style-id string value ≤256 chars is allowed).
- The colour tie-break (atomic `.mk-color-<id>` qualified to (0,2,0) so it beats an element
  style's own colour) was already done back in B1 (v0.10.125) — "pre-satisfies the runtime side".
**Cascade at runtime** (pure CSS specificity, no resolver): rect base `.ty-<id>` (inherited) <
range `.ty-<id>` on the span (direct, 0,1,0) < atomic `.rect-text .mk-*` (0,2,0). **Live-verified**
on the public page `/test-page-3` (which carries three real elementStyle ranges): rendered
`<span class="ty-heading">`, `<span class="ty-caption">`, `<span class="ty-test-style">` with the
correct text slices, and the matching `.ty-test-style { … Bodoni Moda 25px italic; color:#FF88FF }`
rule present in the page `<style>`. Text content is `esc()`-escaped (no markup honoured). HTTP 200,
no errors. With C done, the element-styles unit (B1→B6 + C) is functionally complete editor→runtime;
only Slice D (dead-code cleanup + the load-bearing `.pe-rect-text` colour override retirement)
remains before the whole unit can clear the push bar.

**Element styles B3-6 — specimen readability via HOVER-REVEAL, not always-paper (v0.10.132).**
Follow-up to B3-5: the author found the always-paper chips "very readable but bad for the UI
feeling" — a row of bright paper chips on the dark toolbar broke the dark aesthetic. New approach:
restore the dark resting chip and REVEAL the specimen on hover. Implemented with `@media (hover:
hover)` so it's device-aware:
- **Base rule (touch / `hover: none`)** = the v0.10.131 always-paper surface — on a phone there's
  no hover to lift the chip, so paper-at-rest stays the only way to read a dark specimen.
- **`@media (hover: hover)` (mouse, and Apple Pencil hover on iPad later)** = dark resting chip
  (`.pe-tt-es` → `#2c2c2e`/`#e8e8ea`, restoring the dark look); on `:hover` the chip lifts to a
  light paper-tinted surface `#efe9dd` with dark text, where the style's own (often dark) colour
  becomes legible. The clear-× chip is re-asserted dark-on-hover (it's a UI action, not a specimen,
  so it must NOT lift to paper — the generic `.pe-tt-es:hover` would otherwise catch it). The
  is-active chip is re-asserted accent-fill on hover (the paper reveal must not override the
  selected state).
Applied the identical pattern to the Draw row sample (`.ed-typo-sample`): paper base, dark box
(`#1b1e24`) at rest under `hover:hover`, paper `#efe9dd` reveal on hover. **Live-verified** via
CSSOM + computed style at v0.10.132 (desktop reports `hover:hover`): Draw sample resting bg
`#1b1e24` with the style's pink colour showing through, `:hover` rule = `#efe9dd`/`#1b1d21`; Page
floater base = paper, `hover:hover` resting = dark, `:hover` = paper reveal, clear chip dark, active
white-on-accent. No console errors. (Tradeoff for the Draw panel: it's a vertical LIST, so the
author now reads dark specimens one at a time by hovering, rather than all at a glance — acceptable
given the names are always shown separately in the row head and the dark aesthetic was the explicit
ask; revisit if the list browse-ability suffers.)

**Element styles B3-5 — readable specimen previews on a light "paper" surface (v0.10.131,
SUPERSEDED by B3-6 on hover-capable devices; still the touch/no-hover base).**
Author report: a style whose own colour is dark (e.g. Body3 #1b1d21, Caption6 #774411) was
unreadable in the dark-toolbar pill previews and the dark Draw row sample — dark text on a dark
chip. Two offered fixes (artificially lighten the text vs. lighten the background); chose the
BACKGROUND, both because it's more faithful (page text normally sits on a light background, so the
pill now shows what the run actually becomes) and because it reuses an existing precedent: the Draw
"View in panel" preview modal already renders specimens on a `#f7f6f3` paper surface. Applied that
same paper tone in two places: (1) the Page floater element-style pills (`.pe-tt-es` → bg `#f7f6f3`,
default text `#1b1d21`, dark-alpha border) — the `.ty-<id>` preview span's own colour still wins,
so light AND dark style colours are now legible; the "clear ×" chip is a UI ACTION not a specimen so
it KEEPS the dark toolbar palette; the is-active state is unchanged (accent-orange fill + white
text, still readable). (2) the Draw element-styles row sample (`.ed-typo-sample` → same paper bg +
dark default text). **Live-verified**: floater pills show dark Body3 (27,29,33) / Caption6
(119,68,17) and light pink/blue styles all readable on paper; active pill = white-on-orange; the
clear chip stays dark; Draw samples render on paper with dark colours now visible. No console
errors. (Tradeoff noted: a style designed in a LIGHT colour for a dark page would be the inverse
problem on paper — but that's rare and the preview modal already made the same paper choice.)

**Element styles B3-4 — floating-panel restyle: link first-class + computed pill layout
(v0.10.130).** Two author-driven asks: (1) the link button was hidden inside the fx-overrides
disclosure but is first-class, and (2) the element-style pills wrapped "every which way". Reshapes
`buildTextToolbar` from a single flex-wrap bar into a VERTICAL ROW-STACK
(`.pe-text-toolbar { flex-direction:column; align-items:stretch }`):
- **(1) Title bar** (`.pe-tt-titlebar`) — the new drag handle. The grip is now a non-interactive
  `<span>` (the whole title bar is the drag surface; pointerdown/dblclick handlers skip when the
  target is a button so the link/fx clicks pass through). The first-class **link** button and the
  **fx** toggle live in `.pe-tt-title-actions` on the right. Link is therefore ALWAYS visible; it
  is no longer built into `ovr`.
- **(2) Pills row** (`.pe-tt-pills`) — element-style buttons, with a width COMPUTED by the new
  `layoutToolbarPills(bar, pills)`. Algorithm: the pills are a contiguous order-preserving list;
  for a target row-count R the narrowest the container can be is the smallest max-row-width that
  greedy-packs into ≤ R rows (found by BINARY SEARCH on that width, `minCapForRows`); iterate
  R = 1,2,… and take the first whose minimal width ≤ the viewport-available span
  (`innerWidth − 24 − barPadding`, floored at the widest single pill). This gives "one line if
  there's room, else two, …" AND packs each chosen row-count as tightly as possible. The chosen
  width is set on BOTH the pills and the bar, so the overrides row (a stretched column child)
  inherits the generous width — the side benefit the author noted: colour swatches stop wrapping.
  A `MIN_CONTENT` (184px) floor keeps the title bar from being crushed when few/narrow pills exist.
- **Link read-out / input rows** (`.pe-tt-linkinfo`, `.pe-tt-link-row`) are now direct full-width
  bar children (column-stretched) instead of `flex-basis:100%` wrap items.
- **Overrides** (`.pe-tt-overrides`) hold ONLY the atomic escape hatch now (B/I/U + colour); the
  link moved out. Dropped its `flex-basis:100%` (unneeded as a column child).
- **Positioning fix**: now that the bar can be much wider (pills on one row), `positionTextToolbar`'s
  AUTO branch clamps horizontally + vertically (was: only the remembered-position branch clamped),
  so a wide bar never spills past the viewport's right edge.
**Live-verified** (transient rect, reloaded to discard): with 7 element styles + 7 palette colours,
pills fit ONE row at 855px (bar 646px, no overflow); the packing math (replicated against the real
pill widths) yields 1 row @855, 2 rows @600/420, 3 rows @375/300 — minimum rows that fit, tightest
width within that. Link + fx confirmed in the title bar, link absent from overrides; overrides
colour swatches sit on a single row at the inherited wide width. No console errors.

**Element styles B3-3 — draggable panel, remembered position, null-option relabel (v0.10.129);
B3 COMPLETE.** Three pieces. (1) **Drag grip**: a six-dot grip is the bar's first child;
`startToolbarDrag` uses POINTER events + a document-level move/up (not mouse) so it works with
touch — the tablet editor is a first-class target (CLAUDE.md). preventDefault on pointerdown
keeps the editable focused (no blur→commit mid-drag). (2) **Remembered position**: a session
`toolbarPos {left,top}` (module-level, not persisted); once set, `positionTextToolbar` honours it
— viewport-CLAMPED so the bar can never be lost off-screen — instead of auto-hugging the
editable; it survives the selectionchange rebuilds. The grip tints (`pe-tt-grip-moved`, accent)
once moved, both live (set in the drag `move`) and on rebuild (built from `toolbarPos`).
Double-tap the grip → `toolbarPos = null` → back to auto-position + un-tint. `overridesOpen`
resets per edit but `toolbarPos` deliberately does NOT (it's a placement preference that should
persist across edits in the session). (3) **Null-option relabel**: the selection-panel
typography `<select>`'s null option was "— none —"; under B2 totality `typographyId == null`
means "follow the registry DEFAULT element style", so it now reads "— Default (<name>) —"
(name resolved via `defaultStyleId()` + `typoById`). **Live-verified** (transient rect, reloaded
to discard): grip drags the bar by an exact delta and clamps on release; position + tint persist
across a selectionchange rebuild; double-tap resets to auto; the panel select's first option
reads "— Default (Default text style0) —" and is selected for a null-typographyId rect. No
console errors. **Whole B3 (toolbar/panel rework) now complete** — element styles are the
governed primary, atomics are the disclosed escape hatch, the panel is movable & touch-ready.

**Element styles B3-2 — atomic overrides behind an fx disclosure (v0.10.128).** Reshapes the
text toolbar to match the governance posture: the GOVERNED element-style buttons (B3-1) are the
always-visible PRIMARY row; the ATOMIC overrides (B/I/U, colour swatches, link) — the escape
hatch — move into a collapsible SECONDARY row revealed by an `fx` (sliders) toggle. Progressive-
disclosure rule applied to formatting: the prepared styles are in your face, raw overrides are
one tap away. In `dev-page.js` `buildTextToolbar` now builds two containers: atomic controls
append to a `pe-tt-overrides` div (was `bar`); element-style buttons + the fx toggle append to
`bar` directly, so the element styles are the bar's first children. The fx click toggles a
session `overridesOpen` flag + the `pe-tt-show-ovr` class on the bar and repositions (height
changed). `overridesOpen` persists across the selectionchange-driven rebuilds and resets in
`enterEditMode` so every fresh edit foregrounds the governed path. CSS: `.pe-tt-overrides`
display:none → flex with `flex-basis:100%` (its own line under the buttons) when shown; the fx
sliders icon sized per the icon rule (~1.2rem in the 2rem button). **Gotcha fixed:** the fx
button carries `.pe-tt-btn` for styling but has no `dataset.attr`; `updateToolbarPressed`'s
`.pe-tt-btn` pressed-loop was clobbering its `is-active` (driven by `overridesOpen`, not mark
coverage) on every refresh → added an `if (!attr) continue` guard (also protects the link
Apply/Cancel buttons, harmlessly). **Live-verified** (transient rect, reloaded to discard): bar
child order = 8 ES buttons · sep · fx · overrides(hidden); fx opens the row (B/I/U + 8 swatches +
link), B still applies `strong`; open state + fx highlight survive a selectionchange rebuild; fx
closes it. No console errors.

**Element styles B3-1 — element-style buttons, the governed primary picker (v0.10.127).** The
first user-facing authoring UI of Slice B. In `dev-page.js`: a new `applyElementStyle(value)`
(structural twin of `applyCharStyle`/`applyColor`; only the attr differs — `setMark(...,
'elementStyle', value)` with overwrite semantics, selection-required, collapsed-caret no-op).
`value === null` CLEARS the mark → the range reverts to the rect's DEFAULT element style
(totality: there is no "no style"). In `buildTextToolbar` the retired `.pe-tt-cs` char-style
chip block is REPLACED by a `.pe-tt-es` block: a divider, a `×` clear chip, then one button per
`state.typography` entry. Each button label is wrapped in its own `.ty-<id>` span so it PREVIEWS
the complete style (family / weight / italic / colour) — but `.pe-tt-es > span` pins font-size /
line-height / letter-spacing (`!important`, (0,1,1) beats the `.ty-<id>` (0,1,0)) so a 48px
style can't blow up the toolbar. The lone default style is flagged with a trailing `◦`.
`updateToolbarPressed`'s old `csChips` loop now reads `currentMarkValue(marks, sel,
'elementStyle')` over `.pe-tt-es` (lights the covering style, or the clear chip when the
selection carries no single element style → it's showing the rect default). CSS for `.pe-tt-es`
in `dev-page.css` mirrors `.pe-tt-cs` geometry, a shade heavier border to read as primary.
**Live-verified** (in-memory transient text rect, never saved, reloaded to discard): toolbar
builds 8 buttons + 0 old chips; clicking `heading` sets `{start:0,end:20,attr:'elementStyle',
value:'heading'}` and renders `<span class="ty-heading">`; computed style confirms the full
six-axis override of the rect default (GFS Didot 48px, italic→normal, #6666FF, ls −2px vs
container Bodoni Moda 16px); clicking `×` empties the marks. The retired `charStyle` mechanism
(`applyCharStyle`, the `classForMark` charStyle branch) stays as a guarded no-op until Slice D
removes the dead relative-char-style code. *NOTE: first authoring UI — may warrant on-device
validation before pushing (still local).*

**Element styles B2 — rect default-style resolution, type axes (v0.10.126).** Consumes A2's
totality guarantee at render time. Two helpers added in `dev-page.js` (right after `typoById`):
`defaultStyleId()` (the registry's lone `isDefault` style, re-derived fresh each call;
defensive fallback to the first style) and `effectiveStyleId(rect)` (the rect's own
`typographyId` when set+resolvable, ELSE the default). `renderRect` now always adds a concrete
`.ty-<id>` to a text rect's container — for `typographyId == null` AND for a dangling ref —
instead of falling to browser defaults. `has-typo` still marks "an explicit token is set" (it
has no CSS/JS consumer — purely informational). The stored `typographyId: null` is kept as a
meaningful state: "follow whatever the default is" (the rect tracks a later default change),
distinct from an explicit pin. The selection-panel picker still labels null as "none" — fixing
that label to read "— Default (<name>) —" is folded into the B3 panel rework (the panel is
reworked wholesale there).

**Colour-axis caveat (applies to B1 + B2; resolved in Slice D).** The six TYPE axes resolve
correctly everywhere. COLOUR has an asymmetry caused by the load-bearing `.pe-rect-text {
color: rgba(0,0,0,0.85) }` editor override (v0.10.93):
- **Container level (rect-default colour):** `.ty-<id>` (0,1,0) TIES `.pe-rect-text` (0,1,0) on
  the same container element → source order wins → the rect's default/explicit element-style
  COLOUR is masked (renders the editor's near-black). The TYPE axes are unaffected
  (`.pe-rect-text` doesn't set them).
- **Span level (range colour):** a range's `.ty-<id>` (or atomic `.mk-color-<id>`) sits on the
  run `<span>` and beats the container's INHERITED colour (inheritance has no specificity) →
  range colours DO show (B1 verified: a `heading` range rendered #6666FF; atomic colour #FFDD00).
- A **colour-inherit** range therefore currently inherits the container's near-black, not the
  default style's concrete colour. Once Slice D retires/reworks the `.pe-rect-text` colour
  override, the container will carry the default style's concrete colour and the whole
  inherit-chain bottoms out correctly at it (the totality intent). Do NOT just delete the
  override — it's load-bearing (see the Slice-D / general-page-background entry).

**Element styles B1 — per-range application, data + render layer (v0.10.125).** The first
Slice-B sub-slice: a text range can now carry a COMPLETE element style, rendered on the editor
canvas. Additive, no schema bump (the `marks` array already accepts any attr — the save-route
attr pattern `^[a-z][a-zA-Z0-9_-]{0,31}$` admits `elementStyle`, and registry membership is
intentionally NOT enforced; so `config.php` needed NO change). Decisions (author-confirmed):

- **Decision A — reuse the `.ty-<id>` class, ONE registry, no second emitter.** A range mark
  `{attr:'elementStyle', value:'<ty-id>'}` makes `classForMark` (dev-page.js) return the SAME
  `ty-<id>` class the rect-default uses. Applied DIRECTLY on the run `<span>`, `.ty-<id>`
  (0,1,0) beats the rect container's INHERITED `.ty-<id>` (inheritance has no specificity) →
  **range overrides rect-default**; and loses to the atomic `.pe-rect-text .mk-*` axes (0,2,0)
  → **strong/em/underline escape-hatch still wins**. The cascade is pure specificity; no
  resolver code, no second CSS rule-set. *Rejected* alt: a separate `.mk-es-<id>` emitter —
  it buys zero cascade advantage (direct-vs-inherited does the work either way) while creating
  a permanent dual-emitter sync burden for one registry. Why A is safe: `deco_typography_css`
  writes **all six type axes explicitly** (family/size/weight/line-height/letter-spacing/
  font-style), so a direct-on-span application fully overrides with no leakage — verified. The
  ONE incomplete axis is `color` (omitted when the style is colour-inherit), which is exactly
  the intended behaviour: a colour-inherit range inherits up to the rect's concrete colour
  (and, once B2 lands, the rect's null→default style guarantees that concrete colour exists).
- **Decision — new `elementStyle` attr** (not overloading the legacy `charStyle` attr). Clean
  break in persisted data; the old `charStyle` mark/`mk-cs-<id>` path stays as a guarded no-op
  removed in Slice D.
- **Colour tie-break (the one required change beyond the class map).** A range element-style's
  own colour (`.ty-<id>`, 0,1,0) would TIE the atomic `.mk-color-<id>` (0,1,0) on the same run
  → source-order would decide. Fixed by qualifying the atomic colour with its container class
  in BOTH contexts: `deco_palette_marks_css` now emits
  `.pe-rect-text .mk-color-<id>, .rect-text .mk-color-<id> { … }` (0,2,0) — so the per-instance
  colour override always beats the element style's colour. (Mirrors how the static atomic
  strong/em rules are written per-context; covers run `<span>`s and link `<a>`s alike. Also
  pre-satisfies the runtime side, shrinking Slice C.)

Touched: `assets/js/dev-page.js` (`classForMark` +`elementStyle` branch); `deco/index.php`
(`deco_palette_marks_css` dual-prefix colour rule); `VERSION` → 0.10.125. **Not yet touched
(deferred):** PHP `deco_marks_classes` `elementStyle`→`ty-<id>` mapping = Slice C (runtime
parity); the toolbar picker that lets authors APPLY an element style to a range = B3 (B1 was
validated by hand-seeding a mark in-memory, never saved). Verified live (preview kirby, home
page, in-memory test rect: rect-default `body` Inter/18px; a `heading` range rendered GFS
Didot/48px/#6666FF overriding it; a `heading`+atomic-`color` range rendered GFS Didot/48px but
the atomic #FFDD00 colour — escape-hatch beats element-style colour). No console errors;
reloaded to discard the test rect.

**Element styles A1 — colour on the element style (v0.10.112).** Additive, no schema bump
(the typography envelope keeps `schemaVersion:1`; `color` is an optional field defaulting
to `null` = inherit). Touched:
- `deco/index.php`: `deco_default_typography()` seeds gain `'color' => null`;
  `deco_typography_css(array $tokens, array $palette = [])` now takes the palette and
  resolves a token's `color` (a palette id) to its value via a `$colourSafe` allow-list
  (same regex as `deco_palette_marks_css` — blocks e.g. `javascript:…`), emitting
  `color: <value>;` into the `.ty-<id>` rule. Unset/dangling/unsafe → no `color` →
  inherit (graceful, like a dangling `typographyId`). Verified all four cases via a
  standalone harness.
- Templates `canvas-page.php` / `page.php` / `draw.php` now pass `$palette` to the emitter.
- `config.php` `dev/draw/typography` POST route: `$clean[]` gains a validated optional
  `color` (palette-id format `/^[a-z0-9_-]{1,64}$/` or `null`; format-only, membership not
  enforced — dangling degrades gracefully). Invalid format → 400.
- `dev-draw.js`: typography token editor gains a **Colour** `selectField` ("— inherit —"
  + palette entries); `rebuildTypographyClientCss()` and `typoSpecLine()` resolve the
  palette-id colour for the live preview + spec line; new-token seed gets `color:null`.
  Verified in the live editor: selecting "Accent" → live `.ty-heading` rule gains
  `color: var(--accent)`, sample renders orange, spec shows "· Accent". (Not saved — user
  data untouched.)

**Element styles A2-1 — totality / one DEFAULT style (v0.10.113).** Enforces the
one-layer model's "no undefined style": exactly one style is the project default; every
text falls back to it (the page-editor consumption of that fallback is Slice B). Additive
field `isDefault`, no schema bump. Touched:
- `deco/index.php`: seed marks **Body** the default with a concrete colour (`'text'` palette
  id); others `isDefault:false`. New **`deco_normalize_typography($tokens)`** guarantees
  exactly one default (multiple → first wins; none → first becomes default; coerces bool) —
  pure, no I/O. `deco_load_typography()` applies it on the file branch and now returns the
  **seed** for an empty/invalid/zero-token registry ("zero styles" is not a valid state).
  It does NOT invent a colour for a colourless legacy default (that's authoring-time).
- `config.php` `dev/draw/typography` POST: `$clean[]` captures `isDefault`; after the loop
  the route **rejects** (400, before any write) an empty registry, zero defaults, multiple
  defaults, or a default whose `color` is null. Governance contract at the boundary; the
  panel upholds it so a violation = hand-edited/buggy POST. Verified all four 400s.
- `dev-draw.js`: each row gets a **"Make default" / "★ Default"** badge-button in the head
  (filled amber + disabled when current). `setDefaultTypo()` clears the flag on all others
  and, if the promoted style was inherit-colour, auto-assigns a concrete palette colour
  (prefers `'text'`, else first entry) so it stays saveable. The **default row's Colour
  field omits "— inherit —"**. `deleteTypographyToken()` **blocks deleting the default**
  (alert: make another default first). New-token seed gets `isDefault:false`.
- `dev-draw.css`: `.ed-typo-default` (quiet outline) + `.is-default` (filled amber badge).
- Verified live: a legacy file (6 tokens, no `isDefault`) loads with exactly one default
  (the first, `heading`); "Make default" on Body moved the flag, forced Body's colour to
  `text`, and stripped its inherit option; deleting the default was blocked, a non-default
  reached `confirm()`. Not saved — user data untouched. NB: the seed default is Body, but a
  legacy file's default normalises to its FIRST token until the author picks one and saves.

**Element styles A2-2 + A2-3 — collapse to one panel (v0.10.114).** The author's
one-layer mental model made the two side-by-side panels ("Typography" + "Character
styles") contradictory, so both moved in one step. `draw.php`: the typography `<section>`
heading is now **"Element styles"**, its add button **"+ Style"** (title "Add an element
style"); the entire **Character styles `<section>` is removed**. `dev-draw.js`: user-facing
"token" wording → "style" (delete confirm, both empty-states, new-style default name). The
file (`typography-tokens.json`), route (`dev/draw/typography`), and CSS class (`.ty-<id>`)
are deliberately UNCHANGED — only the label is "Element styles" (per the A1 decision; a
file/class rename isn't worth a migration). The char-style JS (renderCharStyleList,
addCharStyle, saveCharStyles, the live-CSS mirror, etc.) is now unreachable from the UI but
**left in place, guarded** (its init checks `if (newCsBtn)` and `renderCharStyleList`
early-returns on the missing `#charstyle-list`) — verified no console errors. Dead-code
removal is Slice D. Verified live: panels are Groups / Canvas / Design colors / **Element
styles** only; no "Character styles"; `#charstyle-list` gone; 6 style rows still render;
add button reads "+ Style"; console clean.

**Element-styles panel UI polish — post-A2 on-device feedback (U1 v0.10.115, U2 v0.10.116).**
On-device A2 testing surfaced six issues, all in the DRAW element-styles panel; fixed in two
small slices (DRAW-only; no data/route/schema change).
- **Root cause of four of them was one thing:** the head row was crowded by the wide
  "Make default" text button, which squeezed the style **name `<input>` to a ~0-width
  sliver** (it read as a mysterious "small item" right of Edit, and made it look like styles
  had no name — they always did: names live in `t.name`, the field was just invisible) and
  pushed the delete **×** off the right edge (row-dependent overflow → "jiggle").
- **U1 (v0.10.115):** name input given `flex: 1 1 7rem; min-width: 4.5rem` (placeholder
  "Style name") so it always has presence; **"Make default"/"★ Default" text button → a
  compact STAR icon** (`.ed-typo-default` now 1.7rem square, 1.05rem glyph — above
  micro-glyph per the icon rule): **☆** outline (quiet) = promotable, **★** filled near-black
  on the amber badge = is-default (`aria-label` carries meaning). Freeing that width fixed
  the name sliver AND the × overflow (verified `delRightOverflow == 0` on all 6 rows). The
  expanded field editor (`.ed-typo-edit`) got a distinctive "editing this style" look:
  `#050505` inset background + full amber outline `#c79a3a` (matches the open Edit button),
  replacing the old hairline left rule.
- **U2 (v0.10.116):** the Colour field was a native `<select>` → **white popup on the dark
  UI**, and showed colour **names only, not the colours**. New **`typoColourField()`** = an
  inline palette-**swatch** picker (mirrors `strokeField`, reuses `.ed-color-picker`/`.swatch`
  CSS): each palette colour shown as a real circular swatch (name as title). Inline ⇒ **no
  popup at all** ⇒ white-popup gone by construction, colours visible. **Totality preserved:**
  the "inherit" pill is gated by `allowInherit` — the **default style gets no inherit pill**
  (root fallback, must carry a concrete colour); non-default styles keep it. Also added
  `color-scheme: dark` to `.ed-field select` so the remaining native selects (Weight,
  font-family fallback) get dark OS dropdowns. *Note: the author's on-disk typography file
  currently has `color: null` on every style (no colours picked yet) — the picker reflects
  that as inherit/none until they choose; the save route enforces a colour on the default.*

**Element-styles panel UI polish — second feedback round (V1 .117, V2 .118, V3 .119).**
- **V1 (v0.10.117) — two-row head.** The single head row crammed 5 controls wider than the
  side panel and kept the name short. `.ed-typo-head` is now `flex-direction: column`:
  **row 1** = the style NAME (full width) + the default star; **row 2** = Edit toggle +
  `ty-<id>` chip + ×. (`.ed-typo-head-top` / `.ed-typo-head-bottom`.) Verified row overflow 0.
- **V2 (v0.10.118) — dark dropdowns.** (a) The font-family picker **trigger** button (▾) was
  a browser-default white button → styled dark (its popup was already a dark custom div).
  (b) The Weight field was a native `<select>`: `color-scheme: dark` themes its popup on
  desktop WebKit but **iOS ignores it** (renders a system white menu/wheel). Added a new
  **`darkSelectField()`** — a div-based custom dropdown (same pop pattern as the font
  picker: dark trigger + dark `.ed-dark-select-pop` option list) that is dark on EVERY
  platform and friendlier for the tablet-first-class target than a native wheel. Swapped the
  element-style Weight field to it; **`selectField()` is untouched elsewhere** (only Weight
  migrated — other native selects can migrate later if their popups matter on iOS).
- **V3 (v0.10.119) — in-panel Save = dirty indicator.** The global Save button scrolls out
  of view once styles fill the panel, and dirtiness only showed on that off-screen button.
  Added a Save button at the **foot of each open edit subpanel** (`.ed-typo-edit-save`):
  saves the whole registry (same `saveTypography()` route) AND doubles as the dirty light —
  clean = greyed/disabled "Saved", dirty = filled-amber/enabled "Save changes".
  `markTypographyDirty()`/`clearTypographyDirty()` now refresh every such button via the new
  `applyTypoEditSaveState()` so all open rows + the post-save re-render stay in sync.
  *(The author floated a "big outline around all styles" as an alternative dirty cue; the
  in-panel save button was their preferred option and is what shipped. If a global always-
  visible dirty cue is still wanted for the collapsed case, revisit.)* → **revisited in V4.**

**Element-styles panel UI polish — third feedback round (V4 .120).**
- **V4 (v0.10.120) — section-level dirty cue + filled top Save.** Two fixes:
  (a) The in-panel Save (V3) vanishes when the user **closes the edit subpanel without
  saving** → with every row collapsed there was *no* dirty signal unless the panel-head
  Save happened to be in view (the author called this a danger). Added an **always-visible
  section cue**: `#element-styles-section.is-dirty` gets a 2px amber outline + a
  **"● unsaved"** header badge (`#typo-dirty-badge`). Toggled by a new
  `applyTypoSectionDirty()` called from both `markTypographyDirty()`/`clearTypographyDirty()`.
  (b) BUG the author reported: the panel-head Save "does not become active when dirty."
  It *did* get `.is-dirty` + "Save •", but the dirty CSS was only a faint border/text-colour
  tint over a transparent bg — read as inactive. Changed `#save-typography-btn.is-dirty`
  (and `#save-charstyles-btn.is-dirty`) to the **filled amber** style (same as the in-panel
  save + default-star badge) so "active" is unambiguous. Verified live: clean→dirty toggles
  outline+badge+filled button; reload discards (no data mutation).
  *(V4's section outline + badge were superseded one round later — see V5.)*

**Element-styles panel UI polish — fourth feedback round (V5 .121).**
- **V5 (v0.10.121) — sticky header replaces outline+pill; relabel; ORDERING.** Three changes:
  (a) **Dirty cue reworked.** The author found V4's section outline only ever showed its
  TOP edge (a tall panel clips the side/bottom edges off-screen) and the "● unsaved" pill
  was redundant — it sat on the same header row as the Save button, adding nothing. Both
  removed. Instead the element-styles **panel header is now `position: sticky; top:0`**
  inside the scrolling `.ed-sidebar` (solid #1f1f1f bg, negative-margin bleed over the
  panel padding). The Save button — already the dirty light — pins to the sidebar top, so
  it stays visible while scrolling the styles list. This is the real fix for the original
  "danger" (dirty signal scrolling out of view) without extra chrome. `applyTypoSectionDirty()`
  and the `#typo-dirty-badge` / `#element-styles-section.is-dirty` CSS were deleted.
  (b) **Top Save relabelled** "Save •" → **"Save changes"** when dirty (matches the in-panel
  save for consistency); clean label stays "Save".
  (c) **Ordering (new capability).** Element-style list order IS the authored hierarchy
  (Heading1 → Subheading → Body …) and was previously uneditable. Added single-step **↑/↓
  icon buttons** flush right on each row's second header line (`.ed-typo-move`, pushed right
  by `.ed-typo-right-start{margin-left:auto}`). `moveTypo(t, dir)` swaps the array neighbour,
  marks dirty, re-renders; first row's ↑ and last row's ↓ are `disabled`. Chose arrows over
  drag deliberately: drag is imprecise + poor on the tablet-first-class target, and there are
  only ever a handful of styles so move-to-top/bottom isn't warranted. Order persists through
  the normal `saveTypography()` array serialization (no schema change). Verified live: reorder
  swaps + dirties; end-buttons disable correctly; sticky header pins at sidebar top when
  scrolled; reload discards the in-memory reorder (user data untouched); no console errors.
  *(The sticky-HEADER dirty cue was superseded the next round — see V6.)*

**Element-styles panel UI polish — fifth feedback round (V6 .122).**
- **V6 (v0.10.122) — dirty cue is now a sticky-BOTTOM save bar, dirty-only.** The author
  found two flaws in V5's sticky header: (a) it only solved the scroll-DOWN case — scrolling
  UP to other sidebar sections slid the whole element-styles panel (and its pinned header)
  below the fold, so the Save action vanished again; (b) the header stayed glued to the top
  even when clean, which read as strange. Replaced the sticky header entirely with a
  **`.ed-typo-save-bar` (`#typo-save-bar`)**: a full-width amber "Save changes" button in a
  bar that is `position: sticky; bottom: 0` and, as the **sidebar's last child**, pins to the
  bottom of the scroll viewport from ANY scroll position. It is rendered (`hidden` toggled in
  `markTypographyDirty()`/`clearTypographyDirty()`) **only while dirty** — no permanent chrome,
  so the "stays glued when clean" complaint is moot. Bound to the same `saveTypography()` as
  the header button. The panel-head Save still reflects dirty when in view (unchanged); the
  sticky-header CSS (`#element-styles-section .ed-panel-head{position:sticky…}`) was removed.
  Verified live: bar hidden when clean, shown when dirty; scrolled to sidebar TOP it stays
  pinned at the viewport bottom (barBottom≈sidebarBottom); reload discards; no console errors.
- **V6.1 (v0.10.123) — stale "Saved." label fix.** `saveTypography(btn)` sets the passed
  button to "Saved." on success but its 1800ms reset only targets `#save-typography-btn`
  (the header). Since the bar HIDES immediately on save, the sticky button kept the stale
  "Saved." text and it resurfaced — spuriously — the next time an edit re-showed the bar.
  Fix: `markTypographyDirty()` now resets `#typo-save-bar-btn` to "Save styles" + enabled
  every time it un-hides the bar. Verified: forced the stale state, fired a new edit → bar
  reopens reading "Save styles".
- **V6.2 (v0.10.124) — relabel all element-style save buttons "Save styles".** "Save changes"
  (and the bare header "Save") was ambiguous: the toolbar has its own Save, and other objects
  are editable too. All three element-style save controls — panel-head `#save-typography-btn`,
  the in-panel `.ed-typo-edit-save`, and the sticky-bar `#typo-save-bar-btn` — now read
  **"Save styles"** in their action state (header shows it both clean and dirty, differing only
  by the amber fill; in-panel clean stays the status word "Saved" disabled; transient
  "Saving…"/"Saved."/"Failed" unchanged). The retired char-styles panel's save buttons were
  left as-is. Verified live: header (clean+dirty), in-panel (dirty), and bar all read
  "Save styles"; in-panel clean = "Saved"; reload clean; no console errors.

**Then: general page background** (see decision note below) — which is the
real retirement path for the v0.10.93 override (do NOT just delete the
override; it's load-bearing — confirmed 2026-06).

**DECISION — general page background (planned, sequenced AFTER TS4).**
Context: the v0.10.93 editor text-colour override exists only because there
is no real page background yet — kind-colour fills are a Slice-1 placeholder
and the palette `text` token has nothing legible to sit on. The principled
fix is a **general (site) background**, the near-universal styling item.
Trap that was caught while planning (do not repeat): a website has ONE
general background; blocks are normally **transparent over it** or
*intentionally* styled as exceptions. Giving a text block its OWN reference
background inverts common usage. So Deco **text rects render transparent
over the general background** (both editor and runtime, fed from one source
— no editor-only "reference background" that would drift). Decisions taken:
(1) **Data home = per-page config** (`pageCfg`) with a **site-wide default
fallback** — a cascade (site default < page override) from the start, not a
single palette token. (2) Once it lands: text rects transparent over the
general background → palette `text` legible by author pairing → true
editor↔runtime WYSIWYG → **the v0.10.93 override is then deleted as a side
effect.** (3) Editor kind-identification for text rects moves off the fill
(which becomes transparent) onto the kind label + a border/stripe; image /
drilldown / deco-mount keep their pastel placeholder fills (content
stand-ins = the "intentional exceptions"). Pulled EARLIER than originally
planned because it's the foundation that unblocks the override retirement.
**Side-panel tweak (v0.10.98):** the TYPE row's font preview was wrapping
to multiple lines and sitting in the narrow content column (5.5rem label +
flex content), pushing the TEXT/NOTE/coords affordances below the fold.
Fix: `row()` gained an optional 3rd `modifier` param; the Type row passes
`pe-selection-row--stack` (`flex-direction:column; align-items:stretch`,
label `width:auto`) so the preview spans the FULL panel width — the one
deliberate exception to the label-column layout. The `.pe-typo-sample`
preview is now single-line (`white-space:nowrap; overflow:hidden;
text-overflow:clip`; removed `max-height`/`word-break`) so a long sample
clips at the panel edge instead of wrapping. Editor-only; no runtime
parity needed.
**Side-panel tweak (v0.10.100):** the TEXT field is no longer rendered as
an always-visible textarea — that reclaims ~4 rows + a hint of panel space
for a value the author can already see ON the canvas. Closed (the default
now) the TEXT row is a single full-width `+`-style button "✎ Edit text
here" (`.pe-text-disclose`, pencil SVG sized to the icon rule); clicking it
adds `r.id` to the session-only `panelTextOpen` Set, re-renders, and focuses
the textarea with caret-to-end. Open shows a `.pe-text-edit-stack` (header
row: "Text" label + a `×` collapse that removes the id from `panelTextOpen`
and re-renders; then the full-width textarea + hint), laid out via the
`pe-selection-row--stack pe-selection-row--nolabel` modifiers so it spans
the whole panel. This is a DELIBERATE deviation from the project's
auto-open-if-populated progressive-disclosure rule: the text is primary
content and is always visible on the canvas, so there's no risk of "data
the author can't see," and close only HIDES the editor (never clears
`r.text` — unlike the optional-feature close which discards values).
Editor-only; no runtime parity needed.
**(v0.10.101 refinement)** the closed affordance is now a COMPACT button on
the TEXT label's own row (label-left layout, button in the content column —
not stacked full-width), and the open state's collapse control is a labelled
"Done" text button (was a bare "×", which read as delete/cancel; it only
hides the editor and the text already committed on blur).
**Side-panel link read-out (v0.10.102):** addresses "once a URL is entered
there's no apparent way to read/check or change it." The text toolbar now
carries a live link READ-OUT (`.pe-tt-linkinfo`, built hidden in
`buildTextToolbar`, populated + toggled in `updateToolbarPressed`): whenever
the selection is a single uniform link (and the editor isn't already open),
it shows the URL text (underlined; click → `openLinkInput` to change it), an
"open in a new tab" anchor (href = `safeHref`'d URL, to VERIFY the
destination), and a pencil edit button. It hides when the editor is open
(the prefilled input shows the URL then) or when the selection isn't a
uniform link. The toolbar is repositioned (`positionTextToolbar`) only on a
visibility TRANSITION, so its height change never overlaps the editable while
selection-drag doesn't cause per-event jitter. The verify anchor lives inside
`#pe-text-toolbar`, so the editable's blur guard skips `commitEdit` when focus
moves to it — the edit session survives a verify click. Validated via preview
(synthetic edit-entry + programmatic selection): apply a link → read-out
shows the URL + verify-href + pencil, chain button lit; pencil/URL-click
reopens the editor prefilled; read-out hides while editing and when the
selection leaves the link. Editor-only; no runtime parity needed.
**(v0.10.103 fix)** the read-out resolves a link at a COLLAPSED caret (via
`currentMarkValue`, which checks a caret strictly inside a mark), but
`openLinkInput` had bailed on any caret without a selection — so clicking the
edit pencil / URL with the cursor merely placed inside a link did nothing.
Fixed with a `markRangeAt(marks, pos, attr)` helper: a collapsed caret inside
a link now expands to that link's full run and edits the whole label (the
natural "click in a link to edit it" gesture); a real selection still
edits/creates over the selection; a collapsed caret NOT on a link stays a
no-op (creating a link needs a span). Validated via preview: caret-only inside
a link → pencil opens the editor prefilled, and applying changes the entire
link run (the restored selection spans the whole label).
Slice 2 brought the image pipeline + out-of-workflow image workshop
(see the Slice 2 entry below).
A navigation-cleanup batch (v0.10.39→0.10.44) re-homed the dev-tool
links into the Panel sidebar, added "‹ Panel" back-links to all
three editors, and tidied the draw toolbar (see the nav-cleanup
entry below).
Deployment infrastructure landed (v0.9.1–v0.9.14) — rsync deploy tooling,
iCloud-placeholder pre-check, first-deploy checklist with diagnostics
captured from the actual first live run, a working `/dev/draw` auth gate
via host-scoped Kirby config (early-exit-in-ready strategy after the
route-based v0.9.2 attempt failed live), and a repo-owned `.htaccess`
carrying Kirby's mod_rewrite rules (without which `/panel` and every
other virtual route 404s on Apache). First live deploy executed
successfully against `https://newsitedbart.bbh.fr/` (Infomaniak shared
hosting); Panel installed, first user created, gate verified end-to-end.

**Security hardening batch (v0.10.2–v0.10.7):** prompted by a Kirby
CVSS 8.8 CVE. Five tracked production-surface changes: opaque 403
body (no framework reveal); `header_remove('X-Powered-By')` in the
host-scoped ready callback (covers ALL responses); deploy.sh now
ships a comment-stripped `.htaccess` (in-repo file remains the
commented master; sed strips the commentary, separate rsync sends
the staged file at deploy-end); Kirby upgraded 5.4.0 → 5.4.2;
ErrorDocument 403/404 with inline plain-text bodies. **Critical
gotcha embedded in deploy.sh**: the staged `.htaccess` MUST be
`chmod 644` before rsync — mktemp's default 0600 is preserved by
rsync -a and Apache (different user on shared hosting) cannot read
mode-600 .htaccess, returning directory-wide 403 for EVERY URL.
This bit us once and is now both fixed and documented inline in
deploy.sh. See the "Security hardening batch" subsection below for
full architectural details.

**Phase 2 direction (v0.10.9–v0.10.12):** decided shape recorded
without code yet. Kirby pages own page-level rendering; small JS
bootstrapper mounts Deco regions into `<div data-deco="…">`
placeholders. No separate display layer (rationale, including the
Divi/Elementor anti-pattern, captured in the Phase 2 section so it
isn't relitigated). Shared-artifact JSON files (rectangles, htmlKey
slots, typography tokens) read by both PHP and JS — Phase 2 owns
the schemas, Phase 1 inherits. Project-wide principle: phases must
be reentrant (authors discover/invent during work; one-way pipelines
are corrosive). Workflow ordering: Phase 2 → Phase 1 in production
authoring (reverse of how they were built). Concrete next step
(user-side): small 100% Kirby learning exercise before any Phase 2
code.

**Phase 2 planning — first concrete page + slicing (v0.10.14):**
Kirby exercise done (enough to move forward, not exhaustive). User
described the first concrete page; slicing plan landed. Page model
is a **monopage absolutely-positioned canvas**: chapters are
author-mental groupings (and a UI gesture for bulk-move), not flow
units; any rect can sit anywhere on the page; ordering is managed by
the editor recalculating coords when the author rearranges. This is
significantly cleaner than a flowing-HTML-chapters model and matches
Deco's existing absolute-coord world. Rect-block authoring is
canvas-only — there is no hand-JSON stage (parallels Deco). Slice 1
combines data shape + runtime template + minimum rect-editor canvas;
slices 2–8 layer content editing, typography tokens, Deco bootstrapper,
textBlock binding, drill-down (overlay), custom polish, responsiveness,
second blueprint. Sub-decisions: drill-down behavior = overlay (push
parked; freeze+darken TBD on first real test); responsiveness offers
both per-breakpoint coords AND responsive rules (author picks per
case), single-breakpoint for slices 1–2; chapter IDs are
author-declared (inference would break too often).

**Slice 1 implementation begun (v0.10.15):** detailed Slice 1 plan
landed (`/Users/bbh/.claude/plans/flickering-watching-mccarthy.md`).
Architectural refinement during planning: canvas dimensions are NOT
redefined in `rects.json` — Phase 2 reads Deco's existing per-page
config (`deco_load_page_config` → `dims[primaryClassId]` →
`{pageW, pageH}`) and positions rects inside *the same frame* the
Deco runtime uses. Single source of truth. Slice 1 step 1 ships
the editor skeleton: `site/templates/page.php`, `assets/js/dev-page.js`,
`assets/css/dev-page.css`, plus local-only Kirby page records
`content/dev/page/page.txt` and `content/test/test.txt` (gitignored).
Empty-state load only — toolbar + sidebar scaffolding visible, canvas
sized to the primary class's `pageW × pageH`, no rects rendered yet.
The add-rect button and Save button are visible-but-disabled to keep
the toolbar geometry stable across upcoming steps.

**Slice 1 step 2 — editor verbs phase A (v0.10.17):** add/select/move
landed. Kind picker is a `<select>` collapsed into one toolbar slot
(`+ Add rect` → text/image/drilldown/deco-mount). Selection on
pointerdown (accent-coloured outline). Drag with a 3px click-vs-drag
threshold; live position update via direct style mutation during
pointermove, canonical `render()` only on pointerup commit. Document-
level pointermove/up listeners so the drag continues even when the
pointer leaves the rect bounds. Palette integration shipped here too:
the project's existing `content/_shared/palette.json` (already used by
Deco) is consumed by the template — `accent` drives the selection
outline + save-button-dirty colour; `text` drives rect-body
typography. Kind-background defaults stay as CSS custom properties
emitted from PHP until a `kindColors` palette field exists. Canvas
stripe colours fixed (v0.10.16) — originals were darker than body
bg so the stripes read as flat dark.

**Slice 1 step 3 — Save + endpoint (v0.10.18):** `dev/page/save` POST
route in `site/config/config.php`. Validates `pageId`, `schemaVersion
=== 1`, chapter `id` matches `/^[a-z0-9_-]+$/i`, chapter `name`
matches the Unicode-tolerant `/^[\p{L}\p{N} _.,'()\[\]\-]+$/u`
regex (same one the draw-save route uses for snapshot names), rect
`id` matches `/^r-[a-z0-9]+$/`, rect `kind` in the four-kind set,
no duplicate ids, no dangling `chapterId`. Atomic tmp-write +
rename. Payload shape persisted is `{schemaVersion, chapters,
rects}` — canvas dimensions deliberately absent (they come from
Deco's per-page config). JS side: `dirty` + `saving` state with
Cmd/Ctrl-S shortcut; `addRect()` and the drag commit branch call
`markDirty()`. Editor-chrome label colours (kind label + id tag)
hardcoded to high-contrast dark — they need to read on every kind
background regardless of the palette text token, which can be
mid-toned. Rect body colour stays palette-bound for Slice 2 real
content.

**Slice 1 step 3.5 — Save UX polish (v0.10.19):** Save button now
reflects dirty state via colour (accent when there are pending
edits, default dark when clean) so the author doesn't have to
read the status line to know whether a save is needed. On a
successful save the button briefly pulses green via the `.is-flash`
class — the moment-of-save is visible even when the status line is
glanced past. Reflow trick (`void btn.offsetWidth`) used to restart
the CSS animation when two saves fire in quick succession.

**Slice 1 step 4 — editor verbs phase B (v0.10.20):** resize (8
handles: 4 corners + 4 edge mid-points, with direction-appropriate
cursors and N/W anchoring on the opposite edge), delete (button in
selection panel + Delete/Backspace key, guarded against firing
while focus is in a text input), Escape deselects, and full chapter
management (sidebar list with inline-editable names; add form;
delete with confirm showing affected member count — members are
unassigned not deleted; rect→chapter assignment via dropdown on
selected rect). Drag state extended with `mode: 'move' | 'resize'`
+ direction; resize math floors size at 20px so a rect can't
collapse below grabbable. Client-side chapter-name validation
mirrors the server regex for instant feedback.

**Slice 1 step 5 — blueprint + runtime template (v0.10.21):**
`site/blueprints/pages/canvas-page.yml` introduced. Single Notes
textarea field + an info panel pointing the author at
`/dev/page?page={{ page.slug }}`. Deliberately carries NO
pageWidth/pageHeight fields — canvas dimensions come from Deco's
per-page config exactly the same way the editor reads them.
`site/templates/canvas-page.php` reads `rects.json` + the page's
Deco config, picks the widest useClasses entry as primary class,
emits the canvas as a `position:relative` container at
`pageW × max(max(y+h), pageH) + 80px` with absolutely-positioned
stub rects matching the editor's visual language.
`assets/css/canvas-page.css` duplicates the kind-colour block from
`dev-page.css` (single source of truth deferred to Slice 7 polish);
palette text token wired the same way as the editor.

Author workflow: create a page in Panel with the `canvas-page`
blueprint → visit `/dev/page?page=<slug>` → author rects → Save →
visit `/<slug>` to see the runtime render. Editor and runtime are
visually identical except for editor chrome (handles, selection
outline, toolbar, sidebar).

Next: Slice 1 step 6 — auth gate extension in
`site/config/config.newsitedbart.bbh.fr.php` to cover `dev/page`
the way it already covers `dev/draw`. Local-first; deployed via
SCP per the host-scoped config protocol.

**Slice 1 step 6 — auth gate extension (v0.10.22):**
`site/config/config.newsitedbart.bbh.fr.php` prefix check now
matches `dev/draw` OR `dev/page`. One-line change; same 403
behaviour applies to the new editor surface and its `dev/page/save`
endpoint. File is rsync-excluded — activation on the live server
requires manual SCP. Local dev untouched (host-scoped filename
doesn't match localhost).

**Slice 1 step 6.5 — runtime footer diagnostics (v0.10.23):**
runtime template footer comment extended from `v… · class=… · N
rect(s)` to also include `canvas=<W>×<H>px (pageH floor=<F>)` so
the computed page height is visible in view-source without needing
DevTools. Useful for quick verification that the
`max(max(y+h), pageH) + 80` math gave the expected result.

**Slice 1 complete (v0.10.15 → v0.10.23).** End-to-end
canvas-authored rect-block layout: editor at `/dev/page`, runtime
template `canvas-page.php`, save endpoint, auth gate, all sharing
Deco's per-page config + palette as common data (the
"integrate, don't drift" principle held).

**Slice 2 — in progress (v0.10.24 → v0.10.38).** Real content +
image pipeline. Landed so far:

- **Step 1 — author note + rect-schema bump 1→2 (v0.10.24).** New
  optional per-rect `note` field (editor-only label, never rendered
  at runtime). Rect schema (the Phase-2 third version axis, distinct
  from CONTENT_SCHEMA_VERSION and the SCHEMA_VERSION envelope) bumped
  1→2. Read-time migration in both `page.php` (editor) and the save
  route normalises missing `note` to null; editor always emits v2.
- **UX iterations (v0.10.25–0.10.28).** Selected rect's chapter is
  highlighted in the side panel (`.is-current`). Editor text contrast
  raised to match Deco tier (`#eaeaea`→`#f0f0f0`, etc.) so /dev/draw
  and /dev/page read identically. Manual numeric x/y/w/h inputs in
  the selection panel (surgical update — no full re-render, Tab keeps
  focus) + shift-drag corner aspect-lock (live shiftKey check). Geom
  fields later given full panel width (dropped the redundant
  "Geometry" left-label; X/Y/W/H key labels already identify them).
- **Step 3 — image pipeline, preserve-originals model (v0.10.29).**
  Architectural decision (judged via a Workflow panel earlier):
  **keep source intact, derive lazily** via `$file->thumb()`. NO
  destructive upload-time resize / no Kirby `create:` transform.
  New `site/blueprints/files/image.yml` (mime image/* only; fields
  alt, caption, maxLongEdge). New
  `site/blueprints/pages/image-container.yml` — a locked-down leaf
  page (slug `images`) that hosts a canvas-page's image files in a
  per-page `content/<page>/images/` subdir. `canvas-page.yml` sidebar
  switched from inline `files:` to a `children:` pages section
  listing the image-container. **First `hooks` block in the project**
  added to `config.php`: `page.create:after` auto-creates the
  `images` child for any new `canvas-page` (filter:
  `intendedTemplate()->name()`); `file.update:after` applies the
  optional one-time `maxLongEdge` cap and clears the field so it
  can't recur. `'thumbs' => ['quality' => 82]` set globally.
- **Step 3.5 — preview-before-commit (v0.10.30→0.10.32).** Added
  `previewLongEdge` + a `previewInfo` info block to `image.yml`: a
  non-destructive trial. Author sets a trial long edge, clicks the
  generated thumb link to inspect, then copies the value into
  `maxLongEdge` to commit. Key correctness finding: `resize($n, $n)`
  (same value both args) fits the image inside an n×n box — the LONG
  EDGE binds, aspect preserved, NO crop — verified against Kirby
  `Dimensions::fitWidthAndHeight` source. This is orientation-free, so
  a single link replaces an earlier two-link (landscape/portrait)
  design, and halves generated thumbs (resize is eager — it generates
  to build the URL). The `maxLongEdge` commit hook was simplified to
  the same `resize($max,$max)` call so preview and commit are
  byte-identical. (Note: Kirby's media cache keeps preview thumbs;
  harmless — gitignored, regenerable, orphaned on source change.)
- **Image workshop — out-of-workflow batch testbench, Step A
  (v0.10.33→0.10.34).** A SEPARATE triage tool at
  `/dev/image-workshop`, distinct from the in-workflow per-file
  preview. Author drops 10–20 candidate images into a *batch* child
  page, then views a grid comparing each original vs. its resized
  derivative at a chosen long edge — to find early & in bulk which
  images don't survive the auto-resize and need external (Photoshop)
  rework, so all the rework happens in one pass. Files:
  `site/blueprints/pages/image-workshop.yml` (container) +
  `image-workshop-batch.yml` (batch, files use the shared `image`
  template) + `site/templates/image-workshop.php` (batch index) +
  `image-workshop-batch.php` (the grid; editable size picker =
  number input + datalist presets; busy overlay on size change since
  resize generation blocks) + `assets/css/image-workshop.css`.
  Index uses `childrenAndDrafts()` (Panel-created batches start as
  drafts → `children()` would hide them). Resize uses the same
  `resize($size,$size)` semantics as the commit hook, so the grid is
  faithful to what a commit would produce.
- **Auth gate generalised (v0.10.33).** The host-scoped gate in
  `config.newsitedbart.bbh.fr.php` no longer enumerates surfaces
  (`dev/draw`||`dev/page`||…) — it now gates `path === 'dev' ||
  starts_with('dev/')`, covering the whole `/dev` tree (and any
  future dev tool) in one rule. Trailing-slash match avoids false
  positives on unrelated `dev*` slugs. **Requires manual SCP to the
  live server** (config.*.php is rsync-excluded). Local dev untouched
  (host-scoped filename doesn't match localhost).
- **Panel dev-tools links (v0.10.34).** `site.yml` gained a "Dev
  tools" info block on the Panel dashboard linking Draw / Page /
  Image-workshop (new tab) — so the author never types a /dev URL by
  hand to reach a tool.
- **Image workshop — Step B: verdict triage (v0.10.35→0.10.38).**
  Each batch-grid card carries an `OK / Rework / Dropped` toggle
  (re-click the active one to clear). Verdicts persist to a per-batch
  sidecar `content/dev/image-workshop/<batch>/verdicts.json`
  (`{schemaVersion, verdicts:{filename→verdict}}`, gitignored as batch
  stock) via `POST dev/image-workshop/save` — full validation + atomic
  tmp+rename, mirroring `dev/page/save`; the batch resolves through
  `childrenAndDrafts()` since batches are drafts. A filter bar
  (All/Unrated/OK/Rework/Dropped, live counts) narrows the grid
  client-side; "Copy rework filenames" yields the newline list for the
  bulk Photoshop handoff. Cards tint by verdict (left stripe; dropped
  dims). Save is debounced 450ms with a Saving…/Saved ✓ indicator.
  Verdicts are author judgement only — they never touch source files.
  - *Size-picker fixes folded in here (v0.10.36→38):* the Step-B sticky
    verdict bar covered the toolbar size input's datalist popup, so the
    size picker moved into that single control bar; the
    `number+datalist` combobox (a browser filters its presets down to
    the pre-filled value, hiding the rest) was then replaced by a
    standard type-or-pick combo — number field + disclosure caret
    opening a preset menu whose choice only *fills* the field, then
    Apply commits (no auto-submit).

**Slice 2 Step 4 — image binding (v0.10.45→0.10.46).** Lets a canvas
`image` rect carry a bound image filename, resolved against the page's
`images/` library, previewed in-rect in the editor. Two sub-slices:
  - *4a — listing endpoint (v0.10.45).* `GET dev/page/images/(:all)`
    (in `config.php`, alongside `dev/page/save`). Returns
    `{ok, page, imagesPage, images:[{filename,url,thumb,width,height,
    ratio,size,alt}]}` with eager 240px thumbs. **Placed under `dev/`,
    NOT `/api/`, deliberately** — the host-scoped auth gate covers the
    whole `/dev` tree, so an `/api/` route would have been unauthenticated.
    The per-page `images/` child is a Panel-created draft → resolved via
    `$page->childrenAndDrafts()->findBy('slug','images')` (plain
    `children()` would miss it). Page-id validated `~^[a-z0-9][a-z0-9/_-]*$~i`;
    unknown page → 404, no library → `imagesPage:null, images:[]`.
  - *4b — picker + rect-schema bump 2→3 (v0.10.46).* New optional
    `image` rect field (bare filename, ≤255, no `/ \ ..`). **Rect-schema
    third axis bumped v2→v3** (user-authorized) with read-time migration
    in BOTH `page.php` (editor template) and the `dev/page/save` route —
    older files default `image`→null and upgrade to v3 on first save; the
    editor always emits v3. Editor UI: a "Bind image…" picker (modal thumb
    grid, capture-phase Escape, refresh) on selected image rects, with
    Change…/Unbind; bound rects render an in-rect `<img class="pe-rect-img">`
    (absolute inset:0, object-fit:cover, z-index:0) with labels lifted to
    z-index:1 as translucent dark pills for legibility over the photo; a
    rect whose bound file is missing from the library shows a dashed-red
    `is-img-missing` outline. The library is fetched async on load via 4a's
    endpoint into `imageByFilename`; render re-runs when it arrives.
    Verified end-to-end through a reload: on-disk `rects.json` writes
    `schemaVersion:3`, the bound filename (leading spaces preserved)
    survives, and the in-rect `<img>` re-decodes cold.

**Slice 2 Step 4c-i — image-fit handling (v0.10.47).** Handles the
aspect mismatch between a bound image and its rect. New optional
`rect.fit` field, `'cover'` (default, fill+crop) | `'contain'`
(fit+letterbox). **NOT a schema bump** — additive within v3 with a
behaviour-preserving default, so an old v3 file renders identically;
`fit` is normalised at read time (page.php), validated + normalised on
save (config.php), and defaulted in the JS bootstrap, while
`schemaVersion` stays 3. (This is the schema protocol's "additive
optional field, no bump" case, in contrast to `note`/`image` which were
bumped more conservatively.) Editor UI (selection panel): a Cover/
Contain segmented toggle (shown whenever the bound file resolves in the
library); when the rect and image aspect ratios differ by >0.5%, an
"Aspect: rect R vs image R" readout plus a **Match rect to image**
action that resizes the rect to the image ratio (keeps width, recomputes
height, clamped to MIN_SIZE) — after which the mismatch readout + button
self-hide. `renderRect` drives `object-fit` via a `data-fit` attribute;
`contain` letterbox bands get a neutral `#14171c` backdrop so the image
reads as framed, not tinted. Verified end-to-end (toggle, match, save,
reload) — `fit` persists at schema v3.

**Slice 2 Step 4c-ii — image-first "Place image" flow (v0.10.48).**
A "+ Place image…" toolbar button (beside "+ Add rect") opens the image
picker in *create mode* (title "Place image"); choosing a file creates a
new image rect already bound AND sized to the image's aspect ratio
(default width, height = round(w / ratio)) so it lands with zero
mismatch. `openImagePicker(rectId)` gained a null-rectId branch
(`placeMode`) that routes the cell click to `placeImageRect()` instead of
`setRectImage()`. `addRect` now also initialises `image:null` /
`fit:'cover'` so every rect carries the full current shape from birth
(the bootstrap normaliser only runs on load). This completes the Step 4
image arc: **4a** listing endpoint → **4b** binding + picker → **4c-i**
fit handling → **4c-ii** image-first placement → **4d** focal-dot pan
(`object-position`; see the dedicated 4d entry below for the full design).

Next: **Step 5** — runtime
`canvas-page.php` renders real text + image via
`$file->thumb(rect.w * dpr)`, per-rect `dpr` field. **Canvas background**
(color/image-scaled/image-tiled) is parked (option B) to land alongside
the Step 4 picker it reuses. **Image-workshop lightbox** (in-page
full-derivative view instead of open-in-new-tab) queued for Step C polish.

**Navigation cleanup batch (v0.10.39 → v0.10.43).** Done before
resuming Slice 2 feature work because hopping between the three dev
surfaces (`/dev/draw`, `/dev/page`, `/dev/image-workshop`) was
friction-heavy during dev and needs doing for a finished product
anyway. Five things landed:

- **Dev links moved to the Panel left sidebar (v0.10.39).** The
  former "Dev tools" dashboard info-section (added v0.10.34) was
  removed from `site.yml` and re-homed as a `panel.menu` config in
  `config.php` — three custom entries (Draw editor / Page editor /
  Image workshop), delineated from the native areas (`site`,
  `users`, `system`, …) by a `'-'` separator. **Kirby 5.4's
  `panel.menu` is a FLAT list** (verified in
  `kirby/src/Panel/Menu.php`): entries are area-IDs, `'-'`
  separators, or custom `id => [label, icon, link, …]` maps. **There
  is no native titled-subgroup / group-heading support** — a literal
  "DEV" heading would require overriding the Vue menu component
  (fragile across updates). The separator is the chosen delineation.
  Links use absolute URLs (with host) so the Panel treats them as
  external and navigates **same-tab** (deliberate — the editors now
  carry a "‹ Panel" back-link, so same-tab is a clean there-and-back
  loop; `target:'_blank'` was intentionally NOT used). Icons:
  `brush` / `template` / `images` (Kirby names, no `icon-` prefix,
  verified present in `panel/dist/img/icons.svg`). Note: setting
  `panel.menu` REPLACES default area ordering; missing areas (e.g.
  `languages` on this single-lang site) are silently skipped by Kirby.
- **Back-links on all three editors (v0.10.39).** Each editor gained
  a "‹ Panel" pill linking to `kirby()->url() . '/' .
  option('panel.slug','panel')`: `.ed-back` (draw, first child of
  `.ed-brand`), `.pe-back` (page, first child of `.pe-brand`),
  `.iw-back` (image-workshop, first child of `.iw-toolbar`). Image
  workshop was previously "a one-way trip"; the batch grid already
  had `‹ Batches` → index, so the full chain is batch → index →
  Panel.
- **Draw brand renamed "Lines" → "Draw" (v0.10.40)** — top-left
  `.ed-brand-mark` label, matching the route name.
- **Version label flush-right in draw + page (v0.10.40→0.10.42)** —
  to match image-workshop's flush-right version (the better
  location). Page was trivial (`.pe-spacer{flex:1}` + version after
  it). **Draw needed an absolute-positioned solution**: the draw
  toolbar's natural width overflows the viewport even on a ~1728px
  16" MBP, so a `margin-left:auto` version landed off-screen right.
  Fix: `.ed-toolbar` got `flex-wrap:wrap` + a reserved right gutter
  (`padding-right:4.75rem`), and `.ed-version` is
  `position:absolute; top:0.7rem; right:0.85rem` — pinned to the
  right edge in that gutter regardless of content width (verified
  robust at 1728 and 1280, where the toolbar wraps but the version
  stays pinned, no overlap).
- **Draw zoom + undo/redo moved toolbar → sidebar top (v0.10.43).**
  After the version fix the draw toolbar had become a wasteful
  near-empty second row. Per the user's idea, `.ed-zoom` and
  `.ed-undo` were relocated out of `.ed-toolbar` into a new
  `.ed-panel--controls` section at the top of the scrollable
  `.ed-sidebar` (zoom left, undo/redo pushed right via
  `margin-left:auto`). The toolbar's natural width dropped to
  ~1470px → single row at the user's window width again (graceful
  wrap retained as the narrow-window fallback). JS bindings survive
  the move (zoom/undo buttons bound by ID, which DOM relocation
  preserves).

**Top-row UX — flagged for later (user, v0.10.43).** When the
project is near completion, the draw editor's top toolbar row
"merits being optimised UX wise." Not urgent; recorded here so it
isn't lost. (The current single-row state is the baseline; the open
question is the overall layout/affordance design of that row, not a
specific bug.)

**"DEV" sidebar heading — resolved (keep as-is).** The sidebar dev
links stay delineated by the `'-'` separator only, with NO "DEV"
heading. Decided against the Vue menu-component override (option c):
overriding CMS internals for cosmetics is a slippery slope and the
separator reads clearly enough. General principle reaffirmed by the
user here: **don't touch any part of the CMS** unless genuinely
necessary — it's nearly always a bad trade.

**Version vertical-centre fix (v0.10.44).** Draw's flush-right
`.ed-version` switched from a fixed `top:0.7rem` (which read as
"flush up" against the screen edge) to `top:50%` +
`translateY(-50%)`, so it centres on the toolbar row aligned with
Save/settings/info — matching the page editor. Verified: version
centre Y = 24px, same as the other toolbar items, single 49px row.

**Icon-set UI optim — flagged for later (user, v0.10.44).** During
the near-end-of-project UI pass, consider replacing the ad-hoc
Unicode glyph buttons (`↶ ↷ ‹ − +`) and other chrome with a real
icon set for a cleaner, consistent UI. Explored: Google **Material
Symbols** (Apache-2.0, free commercial use) — you do NOT need the
500 MB repo; each icon's SVG is ~1–2 KB and downloadable
individually (per-icon from fonts.google.com/icons or raw-fetched
from `google/material-design-icons`). Recommended approach when the
time comes: build a project-owned SVG **sprite** (`assets/img/
ui-icons.svg`, each icon a `<symbol id>`, referenced via
`<use href="…#id">`), mirroring the Kirby Panel's existing
`icons.svg` pattern — `currentColor`-themeable, one cached request,
zero build step, zero runtime/CDN dependency. **Trap to avoid:**
`npm install material-symbols` or loading the full Material Symbols
variable font from Google's CDN — both reintroduce the bloat (and
the CDN adds a third-party runtime dependency on a production-
hardened site). Static SVGs we own win on size, privacy, and
offline reliability for a small fixed icon set. (A subset variable
font is the right call ONLY if the icon count later grows to 30+.)
Natural slice: pick the set → build the sprite → swap glyph buttons
one surface at a time (draw → page → image-workshop).

**Cross-editor UI consistency polish (v0.10.49).** Small fixes from a
testing pass: (1) **Draw brand mark now orange** (`.ed-brand-mark`
#f0a060) to match Page (`.pe-brand-mark`) and Image-workshop
(`.iw-brand`) — keep all three top-left labels the same orange; don't
revert Draw to grey. (2) **Plain `s` saves the page editor** (outside
text fields), mirroring the draw editor's bare-key save; Cmd/Ctrl+S
already worked. (3) **Page selection-panel rows are flush-top**
(`.pe-selection-row` `align-items: flex-start`) so a row that grows
taller on demand — the FIT row gaining the "Match rect to image" button,
or the bound-image card — no longer pushes its label downward between
renders. (4) **Discreet row separators** (`.pe-selection-row +
.pe-selection-row` 1px #26282d top border) added to the page side panel,
mirroring the draw sidebar's section dividers.

**Slice 2 Step 4d — image focal-dot pan (v0.10.50).** Lets the author
choose *which part* of a cover-cropped image is visible (the missing
half of "cover crops well but I can't pick the crop"). Data: two new
per-rect fields **`focusX` / `focusY`** (ints 0–100, default 50 =
centred), applied as the bound image's CSS `object-position`. **Additive
within schema v3 — NO bump** (50/50 reproduces the pre-4d centred crop
exactly; same reasoning as `fit` in 4c-i). Normalised identically in
three places: JS bootstrap (`clampFocus`), `page.php` read-time map, and
the `dev/page/save` route (validate 0–100 + clamp in normRects).

UI is a **draggable focal dot** (`.pe-focus-dot`) appended in
`renderRect` to a rect that is **selected AND `fit:'cover'` AND has a
real aspect mismatch** (same >0.5% rel-diff test the Fit panel uses).
Rationale for the gate: in contain mode, or when rect/image ratios
match, *nothing is hidden*, so a pan control would be a no-op affordance
— suppressed. The dot slides along the **single overflow axis** only
(`maybeAddFocusDot` computes `axis = imgRatio > rectRatio ? 'x' : 'y'`;
in cover exactly one axis overflows, the other is locked because
object-position on a non-overflowing axis has no effect — class
`pe-focus-dot--x` / `--y` shows a directional bar).

Drag uses pointer capture on the dot + `ev.stopPropagation()` on
pointerdown so the surface's rect-move handler never fires; `focusDrag`
state is independent of the rect-move `drag`. During the gesture the
image's `objectPosition` is updated **imperatively (no `render()`)** — a
full render would destroy the dot element and drop its pointer capture
mid-drag; `markDirty()` + canonical `render()` run once on pointerup, and
only if the focus actually changed (so a bare click on the dot doesn't
dirty the doc). See the v0.10.52 entry below for the current grab-handle
model and the two-bug fix that produced it.

**Tiny-rect chrome lift (v0.10.51).** A rect under 100px in either
dimension can't hold its kind label + id inside without them
overlapping/mangling, so `renderRect` tags it `is-tiny` and the CSS
lifts the chrome OUT: kind + id become two left-aligned dark pills
stacked just above the rect (kind directly above the top edge, id one
fixed 22px step higher — a px step, not em, because the id's smaller
font would otherwise not clear the taller kind pill). The optional note
is hidden for tiny rects (secondary meta, would add a cramped third
line). The *detached* focal dot is parked **outside the right edge,
vertically centred** (`left: calc(100% + 17px)`; the +17 clears the dot's
own half-width so its near edge sits ~8px past the rect) so it never
collides with the lifted chrome (which is above the rect).

**Focal-dot model rework + two-bug fix (v0.10.52).** Two defects in the
4d/4.51 dot, both fixed by treating the dot as a pure **grab handle**
rather than a live position readout:

1. *Dot stranded outside the rect during a pan, never reappearing.* The
   old large-rect path used **absolute** mapping (dot follows the
   pointer); dragging the finger past the rect edge pinned the dot at the
   clamped edge, half-clipped and hard to re-grab. **Fix:** on
   pointerdown the rect gets `.is-panning`, which (CSS) **hides the dot**
   (`opacity:0`) and flips the outline to a **dashed accent** — the live
   image crop is now the sole feedback, so the dot can't be stranded. It
   reappears at the committed focal point on pointerup (render() rebuilds
   it). Mapping is now **relative** (drag-delta, range floored at 140px)
   in *both* attached and detached cases — unified, and what makes
   hide-during-drag possible (no need to keep the dot under the finger).
   At rest the attached dot is **inset-clamped** by its 10px radius so it
   never half-clips off an edge at focus 0/100.

2. *Dot not moved outside the rect for small images.* The detach cutoff
   (was `FOCUS_DOT_MIN = 70`) differed from the chrome-lift cutoff (100),
   so a **70–100px** rect lifted its chrome but kept the dot **inside** —
   read as "the dot isn't moved out for small images." **Fix:** one
   shared `TINY_MAX = 100` governs *both* `is-tiny` (chrome) and the dot
   detach, so `detached ⟺ is-tiny`. Small ⇒ chrome out (top-left-above)
   **and** dot out (right edge), together; large (≥100 both dims) ⇒ both
   inside. The standalone 70px threshold is gone.

**Live resize chrome + dot/type z-order (v0.10.53).** Two follow-ups:
- *Chrome/dot lagged a resize.* `is-tiny` and the focal-dot detach were
  only recomputed by the canonical `render()` on pointerup, so while
  resizing a rect across the 100px line the type/id and dot snapped out
  only after release. Added `refreshSizeChrome(el, rect)` — mirrors the
  `is-tiny` + `maybeAddFocusDot` logic but mutates the existing node — and
  call it from the resize branch of the surface `pointermove`. (Can't
  `render()` mid-resize: it would destroy the handle and drop its pointer
  capture, same constraint as the focus drag.) Now the chrome lifts and
  the dot detaches *live* as the handle crosses the threshold.
- *Dot drawn over the type.* The dot (z:3) painted over the kind/id chrome
  (z:1). Raised `.pe-rect.has-image > .pe-rect-label/-id` to **z:4** (above
  the dot, matching the lifted tiny chrome). Both labels are
  `pointer-events:none`, so the type is now legible over the dot *and* the
  dot stays fully grabbable through them.

**In-editor image upload — minimal slice (v0.10.54).** Until now, adding an
image to a page's library meant dropping a file into
`content/<page>/_drafts/images/` on disk — fine locally, but post-deploy it
would force parallel FTP work. Added a direct upload path inside the image
picker:
- *Route* `dev/page/upload-image` (POST, in `config.php`, right after the
  `dev/page/images/(:all)` GET). Reads `$_POST['page']` + `$_FILES['file']`.
  Validates: page-id regex, `UPLOAD_ERR_OK`, 25 MB cap, extension whitelist
  (`jpg jpeg png gif webp avif`), `@getimagesize()` sanity. Resolves the
  per-page library via `$page->childrenAndDrafts()->findBy('slug','images')`
  and writes with **`move_uploaded_file()` straight into `$imgPage->root()`** —
  *not* `$page->createFile()`. Rationale: the dev route runs with no Panel
  user, so Kirby's `createFile` permission checks would reject it; we validate
  by hand and write the raw file instead. `$imgPage->root()` correctly resolves
  the draft path (`content/<page>/_drafts/images/`).
- *Clash policy:* **auto-rename** (Kirby default) — a `while
  (file_exists(...))` loop appends `-1`, `-2`, … to the sanitized basename.
- *Picker UI:* an `Upload…` button (`.pe-create-btn`) + hidden `<input
  type=file>` in the picker header. On success it reloads the image library,
  then either `placeImageRect(newName)` (place-mode) or `setRectImage(...)`
  and closes the picker. Failures surface in a `uploadError` line in the
  picker body; the empty-state text now points at `Upload…`.
- Verified server-side via curl (valid upload, auto-rename on re-upload,
  `.bmp` rejected, fake-`.png` rejected) and client-side via an injected
  `File`. Deferred follow-up (recorded in memory): transfer an image from the
  **image workshop** (`dev/image-workshop/*` batch/triage subsystem) into a
  page via a page-target dropdown.

**Upload library auto-provision + panning rings (v0.10.55).** Two fixes
from testing the upload slice:
- *"This page has no image library."* The upload (and picker) assume an
  `images` child exists, but the `page.create:after` hook only creates one
  for **canvas-page**-blueprint pages. A page authored under another
  template (e.g. "Test page", template `test`) — or created before the hook
  existed — has none, so upload errored. Fix: the `dev/page/upload-image`
  route now **lazily provisions** the child when missing — `mkdir
  content/<page>/_drafts/images/` + a `Title: Image library`
  `image-container.txt` — at the filesystem level (Page::create would hit
  permission checks with no Panel user, same reason we move_uploaded_file
  rather than createFile). A subsequent `dev/page/images` refetch is a fresh
  request that re-reads disk and sees the new child. Verified end-to-end via
  curl against slug `test` (created the child, listed the file with a
  generated thumb); test artifacts cleaned up. Note for users: a Panel
  *Files* upload on a page lands in that page's **own** files, NOT the
  `images` child the editor reads — use the picker's `Upload…` button
  instead (it targets the right place and provisions the library if needed).
- *Panning outline.* Replaced the single dashed override with the user's
  design: the rect keeps its usual solid selected outline (inner line) and
  two concentric **dotted** rings are added just outside it via `::before`
  / `::after`, each 2px dotted accent — reads as "moving". Removed on
  drag-end with the `is-panning` class. *(v0.10.56:* respaced to inset
  −7px / −14px — bands 5–7px and 12–14px out — so the inner ring clears
  the 2–4px solid outline instead of being swallowed by it, and the two
  dotted bands sit a visible 5px apart. The earlier −5/−8px put the inner
  ring under the solid outline and the bands only ~1px apart, reading as
  one ring.)*
- *(v0.10.57:* the focal-dot pan's move/end were handled **on the dot**,
  relying on `setPointerCapture` to retarget the release back to the dot.
  Capture was being lost when the user released outside the rect / near a
  corner, so `pointerup` targeted a different element, `endFocusDrag`
  never ran, and the `is-panning` chrome (hidden dot + rings) lingered.
  Moved the move/up/cancel handling to the **document level** — the same
  capture-independent mechanism the main rect drag uses — so the gesture
  ends no matter where or on what element the pointer is released.
  `endFocusDrag` now clears `is-panning` from *any* element still
  carrying it. The dot keeps only its `pointerdown` (+ a now-non-
  load-bearing `setPointerCapture`).)*
- *(v0.10.58:* the dot used to **rest at the focal point** (`left:focusX%`
  / `top:focusY%`). Since v0.10.52 it's a pure grab handle (crop is the
  feedback), so that placement bought nothing and caused two bugs: it
  **wandered** to a different spot each pan, and at a centred focal point
  it sat dead-centre **under the kind label** — invisible (label z:4 > dot
  z:3) yet still the hit target (label is `pointer-events:none`), so
  clicking the type secretly started a pan. Now parked at a **fixed spot
  just outside the rect**, on the edge parallel to the pan axis (x → below
  bottom-centre, y → outside right-centre), always `is-detached`. Never
  wanders, never under the label; the relative drag-delta mapping means
  the handle's position needn't track the focal point. The old size-gated
  `detached`/attached split (and the `insetX/insetY` clamp) is gone —
  `TINY_MAX` still drives the separate `is-tiny` chrome lift.)*

**Upload file-type filter (v0.10.56).** The picker's `Upload…` input had
`accept="image/*"`, which let the OS picker offer `.heic` — then the
server whitelist (jpg/jpeg/png/gif/webp/avif) rejected it, a confusing
"offer-then-reject" UX. Synced `accept` to the exact server whitelist
(extensions + MIME types) so unsupported types (notably HEIC, which the
GD/Imagick thumb engine can't decode) are greyed out up front. The
server whitelist remains the backstop.

**Image-workshop → page "Use this" transfer (v0.10.59 backend / v0.10.60
UI).** The deferred image-workshop→page transfer step. From a workshop
batch grid, an author can send a triaged image into a canvas page's
`images` library so it becomes pickable in the page editor.

- *Flow (user-chosen):* the verdict row stays 3 buttons until a card is
  marked **OK**, then a 4th accent button **"Use this"** appears
  immediately right of OK — CSS-gated via
  `.iw-card[data-verdict="ok"] .iw-use { display:block }` plus the verdict
  grid widening `repeat(3,1fr)`→`repeat(4,1fr)` in the OK state (no JS
  toggles visibility). "Use this" reveals an inline picker: a dropdown of
  every canvas page + Send/Cancel.
- *Only the RESIZED derivative is sent, never the original* (user
  constraint — originals are huge; a 13MB 1320×2868 source → ~595KB
  368×800 at size=800). The client posts the current test long edge
  (`SIZE`), and the route reproduces `$img->resize($size,$size)` — the
  exact derivative the grid shows — then copies that cached thumb file.
- *Route:* `POST dev/image-workshop/use-image`, body
  `{ batch, filename, size, targetPage }`. Mirrors `dev/page/upload-image`
  for the destination side: runs with **no Panel user**, so it resolves +
  resizes via Kirby (read-only) then `copy()`s the derivative raw into the
  library dir (lazily provisioned — mkdir `_drafts/images` +
  `image-container.txt` when the child is absent), auto-renaming on clash.
  Source batch resolved via the workshop container's `childrenAndDrafts()`
  (batches are drafts) and validated to `image-workshop-batch`; target
  validated to `canvas-page` — both enforced server-side, not just in the
  dropdown.
- *Sent state:* recorded in a per-batch `sent.json` sidecar
  (`{ schemaVersion, sent: { "<filename>": [{page,title}, …] } }`, atomic
  tmp+rename like `verdicts.json`, de-duped by target page id). The
  template reads it on load → renders green "Sent to: <title>" chips
  (`is-sent` green right-stripe on the card) and pre-disables already-sent
  pages in that card's dropdown. After a live send, JS appends the chip
  and disables the option so a second send can't write a duplicate copy.
  Multiple targets stack as multiple chips.
- *Gotcha for verification:* a batch page is a **Panel draft**, so it
  404s over plain HTTP / in the preview browser (no Panel session) — the
  grid only renders for a logged-in user. To smoke-test the template
  headlessly, render the draft directly via a Kirby bootstrap harness
  (`(new Kirby)->page('dev/image-workshop')->childrenAndDrafts()
  ->find('<batch>')->render()`); the route itself is curl-testable because
  routes bypass draft visibility.

**Page-editor Z-depth fix + dims caption (v0.10.62 / v0.10.63).** Two
small follow-ups in the `/dev/page` editor:

- *Z-depth mixing (v0.10.62).* `.pe-rect` set no z-index, so it created
  no stacking context and its z-indexed chrome (kind label z:4, focal dot
  z:3, panning rings z:2, image z:0) escaped into the surface's ROOT
  context — one rect's label could paint over a different rect. Fix:
  `isolation: isolate` on `.pe-rect` (and mirrored to `.rect` in
  `canvas-page.css`). Each rect is now its own stacking context, bounding
  every child's z to its own rect ("rect Z + 1"). Inter-rect order still
  = DOM order + `.is-selected{z-index:1}`. This is the global-CLAUDE.md
  CSS-stacking-context trap in the wild.
- *Flush-top-left kind label (v0.10.62).* `.pe-rect` switched to
  `justify-content/align-items: flex-start` + `padding:.25rem .4rem` so
  the kind label (and author note) flow top-left instead of centred over
  bound-image / deco-mount content. Padding insets only in-flow chrome —
  the full-bleed image (`inset:0`), absolute top-right id, and edge
  resize handles reference the padding box and are untouched.
- *Dims caption (v0.10.63).* A caption above the surface, top-left,
  reads `Page area: W, H — Canvas: W, H` (all four from
  `$primaryDims`/Deco config). Caption + surface wrapped in
  `.pe-canvas-col` (`width:max-content; margin:0 auto`) so the caption's
  left edge aligns flush with the surface regardless of pageW. Medium
  white, no background box (+ a subtle text-shadow for legibility over
  the striped wrap).

**Self-hosted Material Icons (v0.10.64).** Introduced a project-wide icon
system so editor chrome can move off ad-hoc glyphs. Google's *classic*
"Material Icons" font (126 KB woff2, ~2,100 glyphs) self-hosted at
`assets/fonts/MaterialIcons.woff2`, wired by a standalone
`assets/css/material-icons.css` (`@font-face` + `.material-icons` base
class using the `liga` ligature API — `<span class="material-icons">name
</span>` renders the named glyph). Size helpers `.mi-sm/md/lg`
(18/20/28px); `pointer-events:none` so clicks fall through to the wrapping
button. Chose classic over Material Symbols (3.96 MB) because no subsetting
toolchain (fonttools/pyftsubset) is installed and 126 KB needs none. Slice 1
links it into the page editor only (`page.php`); other surfaces adopt it as
their glyphs migrate. The font binary IS committed (unlike the gitignored
`assets/fonts/local/` workshop fonts).

**Page-editor author-managed Z order (v0.10.65).** Z = `state.rects` array
order is already the paint model — `render()` empties the surface and
re-appends in array order, so DOM order = paint order. This slice surfaces
and edits that order; no schema change (pure array splice).
- *Canvas z badge.* Each rect's kind label carries a trailing `zN`
  (`.pe-rect-z`), N = index+1; frontmost rect = end of array = highest.
  `renderRect(rect, index)` computes it; `render()` passes the index.
- *Selection "Layer" row.* Four reorder buttons (`.pe-layer-btn`, 1.9rem
  chips, 20px Material Icon glyphs), one line, no wrap:
  `vertical_align_bottom` send-to-back, `arrow_downward` backward,
  `arrow_upward` forward, `vertical_align_top` to-front. Single-step moves
  use plain directional arrows, NOT `keyboard_arrow_*` chevrons (those read
  as a dropdown/disclosure caret — v0.10.66 fix). Endpoint buttons disable
  at the extremes. Reorder → `markDirty()` + `render()`, selection preserved.
  The `z N / M` readout sits on the **Kind** row (`.pe-kind-z`), trailing the
  kind — this frees the Layer row's width so the four buttons fit one line.
- *Reorder helpers* after `deleteRect`: `rectIndex(id)` +
  `moveRectToTop/Bottom/Up/Down`, each splice/swap on `state.rects`.
- *Selection-lift conflict.* `.is-selected` no longer raises z-index
  (outline only) so layer-button effects aren't masked by a selected rect
  sitting on top; manipulation lift moved to `.is-dragging/.is-panning`
  (z-index:999).

**Page-editor always-on-top selection chrome (v0.10.67).** Step 2 of the Z
work ("Figma-style overlay"): once authors can bury a rect under a higher-Z
one, its resize handles (children of the rect, inside the rect's own
`isolation:isolate` stacking context) got covered and became ungrabbable.
Fix: a single `.pe-overlay` layer appended LAST to the surface in `render()`
(z-index:1000, `pointer-events:none` so clicks fall through to rects). When
something is selected it holds one `.pe-overlay-box` — the accent outline,
sized/positioned to the selected rect — carrying the eight `.pe-resize-handle`
nubs (`pointer-events:auto`). Handles no longer emitted per-rect.
- *Hit-resolution.* The pointerdown handler resolves a handle hit via
  `selectedId` (the handle's DOM ancestor is the overlay box, not a `.pe-rect`,
  so `findRectElement` would miss it) — resize works even when buried.
  Verified: `elementFromPoint` over a covering rect returns the handle, and
  dragging it resizes the buried rect.
- *Live tracking.* `updateOverlayBox(r)` repositions the box during
  move/resize. The box is identified by **class** (not `data-rect-id`) so the
  drag handler's `[data-rect-id=…]` querySelector still resolves the rect, not
  the box; `render()` rebuilds the box fresh on pointerup.
- *Deferred & named.* Body-drag-to-MOVE a fully-buried rect (its body is still
  under the covering rect) — **RESOLVED in v0.10.69 via the move grip** (see the
  "Move grip" entry below). The grip approach was chosen over a draggable box body
  to preserve click-through selection and to suit the planned tablet UI.

**Focal-pan dot into the overlay + z-index ceiling (v0.10.68).** Finishes the
always-on-top work: the focal-pan dot (image cover-mode crop handle) had stayed
a child of the rect, so a buried image rect's dot was covered and ungrabbable —
the same isolation-context trap the handles had. Changes:
- *Dot relocated.* `maybeAddFocusDot(host, rect, imgRatio)` now appends to the
  overlay **box** (the `host`), not the rect. `renderOverlay()` calls it via a
  new `maybeAddOverlayDot(box, r)` gate (kind=image · fit=cover · ratio known),
  and the per-rect emit in `renderRect` is gone. The dot still parks just
  outside the box edge parallel to its overflow axis (the box has the rect's
  exact geometry, so the offsets land identically).
- *Live rebuild on resize.* `updateOverlayBox(r)` calls `refreshOverlayDot(box,
  r)`, which rebuilds the dot — resizing can flip the overflow axis (x↔y) or
  cross the no-pan threshold, so a reposition isn't enough. Safe because
  `updateOverlayBox` runs only during move/resize, never during a pan, so it
  can't tear down an in-flight pan's captured element. Verified: widening the
  rect past square flips the dot `--x`→`--y` mid-drag.
- *`pointer-events:auto` on the dot (the bug that bit).* The box is
  `pointer-events:none` (click-through); a child does NOT inherit pointer events
  back, so the relocated dot was initially unclickable. Added `pointer-events:
  auto` to `.pe-focus-dot` — same opt-back-in the handles needed.
- *Panning chrome retargeted.* The hide-dot / cursor:grabbing / dotted-ring
  (`::before`/`::after`) CSS moved from `.pe-rect.is-panning` to
  `.pe-overlay-box.is-panning` so it rides on top. The rect *also* still gets
  `is-panning` (line ~307) purely for its 999 z-lift, so the live image crop —
  the sole pan feedback — rises above neighbours even when buried.
  `endFocusDrag` cleans up via `surface.querySelectorAll('.is-panning')` (both
  box and rect). Verified end-to-end: objectPosition 50%→100% on a 200px drag,
  dot hidden during pan, no stranded `is-panning` after pointerup.
- *Z-index ceiling.* `.pe-overlay` bumped 1000 → 2147483647 (max 32-bit signed)
  so the chrome is unconditionally on top regardless of how rect z-indices
  evolve under author-managed layering.

**Move grip — drag a buried rect (v0.10.69).** Closes the last named deferral of
the always-on-top work: a fully-buried rect's body was unreachable for a MOVE
(only resize/pan worked, via the overlay handles/dot). Added a `.pe-move-grip` —
an `open_with` icon tab in the overlay box (so at the z ceiling) parked centred
just above the box top edge (`bottom: calc(100% + 10px)`, clearing the 'n' handle
which reaches 6px above). `pointerdown` on it (resolved with `closest('.pe-move-
grip')` so a hit on the inner icon span counts) starts a `mode:'move'` drag
against `selectedId` — same path as the rect-body move and the resize-handle
branch. The buried rect still gets its 999 z-lift during the drag, so it rises
above its sibling and you see it move while the overlay stays on top.
- *Why a grip, not a draggable box body.* Making the box body itself draggable was
  the simpler option but would have swallowed click-through selection of any rect
  overlapping the selected one's footprint. The explicit grip preserves
  click-through AND is the touch-friendly path for the planned tablet UI (a
  text-dense body-drag target is poor on touch; an icon affordance is exactly what
  the tablet layer wants — see the PROJECT NORTH STAR callout).
- *No clipping risk.* `.pe-canvas-surface` has no `overflow:hidden`, so a rect at
  the very top floats its grip onto the striped wrap — visible, not clipped.
- Verified on live preview (home page, buried drilldown z1 under deco-mount z2):
  grip on top (`pointer-events:auto`, z:4, 10px above the box top edge); grip-drag
  moved the buried rect (361,173)→(241,233) = exactly the −120/+60 delta, with the
  rect lifted to z 999 during the drag.

**OBJECTS side-panel section (v0.10.70).** A navigation/help affordance — the
counterpart to the move grip. The grip lets you *act* on a buried rect once
selected; the OBJECTS list lets you *find and select* a rect that is fully hidden
behind another (or simply forgotten — you don't know it's there). It's
deliberately the **last** sidebar section (after Chapters and Selection): a help
list, not a first-class verb. New `#objects-panel` section in `page.php`; rendered
by `renderObjects()` in dev-page.js (called from `render()` after
`renderSelection()`); styled `.pe-objects*` in dev-page.css.
- *Name shown = the NOTE field*, falling back to the rect id when no note is set
  (`objectDisplayName(r)`). The note field exists precisely to give objects a
  semantic label — this is its first read-side payoff. Unnamed rows render the id
  dim+italic (`.is-unnamed`) so "needs a label" reads at a glance.
- *Two display modes*, session-only (`objectsSortMode`, not persisted), toggled by
  two flush-right header buttons labelled **T** / **Z** (`#objects-sort-type`,
  `#objects-sort-z`), active state in accent. **T** = grouped by kind
  (`KIND_ORDER = [text, image, drilldown, deco-mount]`, unknown kinds appended
  alphabetically; only non-empty groups shown; a `kind (N)` subhead per group).
  **Z** = one flat list. Both sort **Z-descending (frontmost first)** like a
  layers panel — the top row is the object on top.
- Each row: name-or-id (left, ellipsis-truncated) + `z<N>` (right, where N =
  `rectIndex(id)+1`). Click → `selectedId = id; render()`; the selected row gets
  `.is-current` (accent tint + inset bar, same treatment as the chapters list).
- Verified on live preview (home: drilldown r-djeyos3m unnamed→id z1; deco-mount
  r-ocmv55ac note "mounto - deco" z2): T mode shows both kind groups in order; Z
  mode shows the flat z2→z1 list; clicking a row selects the rect and highlights
  the row.

**UI consistency: page scrollbar + draw save button (v0.10.71).** Two small
cross-editor polish fixes.
- *Page editor dark scrollbars.* `/dev/draw` had dark scrollbars (`body.editor`
  scrollbar-color + `::-webkit-scrollbar*` rules) but `/dev/page` didn't — the
  bright OS chrome read as broken against the `#1f2024` backdrop. Mirrored the
  treatment under `body.page-editor` in dev-page.css (thin; thumb `#444`, track
  `#1a1b1f`). Verified: `scrollbar-color` now `rgb(68,68,68) rgb(26,27,31)`.
- *Draw save button is now dirty-aware.* Draw's `.ed-save` was hard-coded to the
  accent (`background: var(--accent)`) and never disabled on clean, so it was
  **always highlighted even with nothing to save** — the page editor's Save was
  already dirty-aware; draw was the odd one out. Fix mirrors the page editor:
  clean → inherits the dark `.ed-toolbar button` look + disabled; `.is-dirty` →
  accent + enabled. The catch: draw assigns `state.dirty = true` raw in ~30 call
  sites (no `markDirty()` helper). Rather than touch all of them, `state.dirty`
  was converted to an **accessor** (`Object.defineProperty` get/set over a
  `_dirty` backing) whose setter calls `reflectSaveButton()` — every existing
  assignment now updates the button for free. A `_saving` flag forces disabled
  during an in-flight save; `save()`'s three manual `saveBtn.disabled` toggles now
  drive `_saving` + reflect. The success flash keyframe was retargeted to settle
  on the dark clean colours (was ending on accent) and forces opacity:1 so the
  green pulse stays vivid over the now-disabled button. Verified: clean = dark
  `#3a3a3a` + disabled; clicking "new color" (a real `state.dirty=true` site)
  flips it to accent + enabled, proving the accessor fires end-to-end.

**Selection-panel coord separators + OBJECTS type-title band (v0.10.72).** Two
page-editor panel-polish tweaks.
- *Coord separators restored.* The selection panel draws discreet hairlines
  between properties via `.pe-selection-row + .pe-selection-row { border-top }`.
  But the geometry block (x/y/w/h) is a `.pe-geom-fields`, not a
  `.pe-selection-row`, so it fell out of that adjacency chain — no hairline
  before the coords, and (because the Note row below it follows a
  `.pe-geom-fields`, not a row) no hairline after them either. Added
  `.pe-selection-row + .pe-geom-fields, .pe-geom-fields + .pe-selection-row`
  with the same border-top to bridge the block back in. Gotcha to remember: any
  non-`.pe-selection-row` block dropped into that panel breaks the sibling chain
  on *both* sides and must re-declare the separator.
- *OBJECTS type titles banded.* The `.pe-objects-subhead` (kind headers in the
  T/by-type view) were plain text on the sidebar. Gave them a background
  lighter than the sidebar (`#1a1b1f` + `070707` = `#212226`, dialled in over
  three rounds: `030303` was too faint → `060606` → `+010101`) + small radius so
  each type reads as a section band.

**Slice 3a — typography tokens, seed + select (v0.10.75).** The missing
middle layer between the font bundle (21 Google families) + local fonts and a
text rect: a named, **type-only** style a text rect points at. Decisions
locked with the user: (a) a token carries *only* family / size / weight /
line-height / letter-spacing / italic — **no colour** (colour stays the
orthogonal palette concern, so one token is reusable in any colour); (b) this
slice is **seed + select** (authoring UI deferred to Slice 3b); (c) Slice 3b's
authoring UI will live in the **draw editor** (which already owns font-bundle +
palette as the shared "design system" surface).
- *Data + storage.* Canonical file `content/_shared/typography-tokens.json`
  (`{schemaVersion, tokens:[…]}`), the same site-wide `_shared` pattern as
  palette.json / font-bundle.json. Until the draw UI writes it,
  `deco_default_typography()` supplies a 4-token seed (Heading=Playfair
  Display 48/600, Subheading=Cormorant Garamond 30/500, Body=Inter 18/400,
  Caption=Inter 13/400) so the system works with no file present (mirrors
  `deco_default_dims()`).
- *Shared PHP helpers* (all in `site/plugins/deco/index.php`, next to
  `deco_load_palette`): `deco_load_typography()` (file → fallback to defaults),
  `deco_typography_css()` (emits one `.ty-<id> { … }` rule per token, every
  field sanitised/clamped so a hand-edited file can't inject CSS), and
  `deco_google_fonts_link()` (builds the `<link>` for the font bundle — the
  standalone Phase-2 templates don't run app.js, so they must load the
  webfonts themselves or a token's family won't render).
- *Same emitter, both templates.* `page.php` (editor) and `canvas-page.php`
  (runtime) both call `deco_typography_css($typography)` + `deco_google_fonts_link()`,
  so a token previews in the editor exactly as it renders on the public page —
  visual parity is automatic, no duplicated rule authoring.
- *Rect field.* `typographyId` on text rects (null = inherit). **Additive
  within rects-schema v3 with a null default → NOT a schema bump** (same
  rationale as `fit` / `focusX`/`focusY`). Normalised at read time (page.php),
  on save (save route), and client-side (dev-page.js). Save-route validation is
  **format-only** (`^[a-z0-9_-]+$`, ≤64) — existence is NOT checked, so a ref
  may dangle if a token is later deleted; runtime/editor degrade to inherited
  defaults, exactly like a dangling image binding.
- *Editor UI.* The selection panel shows a **Type** row for text rects only
  (symmetric with the image rows for image rects): a token dropdown + a live
  preview line rendered in the chosen token's actual face (`.ty-<id>`), plus a
  spec meta line (family · size · weight · lh · ls). A dangling ref stays
  selectable and shows a flagged "(missing)" / red preview. On the canvas, a
  text rect with a resolvable token gets `ty-<id> has-typo` classes.
- *Verified end-to-end* on sandbox `test-page-3`: assign token → Save → on-disk
  `rects.json` carries `typographyId` → runtime `/test-page-3` renders
  `class="rect rect--text ty-body"` with the `.ty-body` rule, no PHP errors.
- *Deferred to Slice 3b:* the token authoring UI in draw (create / rename /
  delete tokens, family picker from font-bundle + local, size/weight/etc.
  fields, a `dev/draw/typography` save route writing typography-tokens.json).
  Until then, more tokens are added by hand-editing the JSON (or extending
  `deco_default_typography()`).

**Slice 3b-1 — typography panel in draw, read-only + save plumbing (v0.10.76).**
First sub-slice of the authoring UI. Stands up the panel surface and the
persistence round-trip; create / rename / delete (3b-2) and field editing
(3b-3) come next.
- *Save route.* New `dev/draw/typography` (GET|POST) in `site/config/config.php`,
  mirroring the `dev/draw/font-bundle` route. GET returns
  `deco_load_typography()` (seed when no file). POST validates **format-only**
  and writes `content/_shared/typography-tokens.json` (`{schemaVersion:1,
  tokens, savedAt, count}`, atomic tmp+rename). Validation: id
  `^[a-z0-9_-]{1,64}$` (same contract as a rect's `typographyId`) + duplicate-id
  reject; name non-empty Unicode ≤64 (chapter-name set); family `'' | [A-Za-z0-9
  '_-]` ≤64; numerics **clamped not rejected** (sizePx 1–400, weight 100–900,
  lineHeight 0.5–4, letterSpacingPx −20–50); italic→bool. Token-ref integrity
  intentionally NOT enforced (refs may dangle, like image bindings).
- *Editor surface.* `draw.php` now loads `$typography = deco_load_typography()`,
  embeds it in the JSON payload, and — crucially — emits
  `deco_google_fonts_link()` + `<style>deco_typography_css()</style>` in its
  `<head>`, so each panel row's `.ty-<id>` sample previews in the **real
  webfont** (same emitter the page editor & runtime use → automatic parity).
  New `#typography-list` panel section (after Design colors) + a Save button.
- *JS.* `state.typography` from the payload (NOT in the undo/snapshot history —
  it is shared/site-wide and persists via its own route, not the per-page draw
  save). `renderTypographyList()` paints read-only rows (name + `ty-<id>` chip +
  live sample + compact spec line); `saveTypography()` POSTs and adopts the
  server-normalised set back. Rendered once at init (kept out of `renderAll`'s
  per-edit churn).
- *CSS.* `.ed-typo-*` rules in `dev-draw.css`; the spec line forces the panel UI
  font with `!important` so it stays legible even if a `.ty-*` ancestor appears
  later (descendant-selector / inheritance footgun — see CLAUDE.md).
- *Verified end-to-end* via curl + the live draw UI: GET seed (4 tokens) → POST
  → on-disk JSON → GET reads it back; bad-id and duplicate-id rejected; numerics
  clamped (9999→400, weight 5→100, lh 99→4); panel renders 4 rows with correct
  computed `.ty-` styles; the Save button shows "Saved." and writes the file.
- *Next:* 3b-2 (create/rename/delete tokens) → 3b-3 (family picker + field
  editing). Then priority #3 (real text content on text rects).

**Slice 3b-2 — create / rename / delete typography tokens (v0.10.77).**
Adds the mutation verbs to the 3b-1 panel. No new route — reuses
`dev/draw/typography` POST.
- *Create.* `+ Token` button in the panel head appends a token with default
  fields (16px / 400 / lh 1.4) and focuses its name input.
- *Stable-id discipline.* A token's `id` is its permanent identity (rects
  reference it via `typographyId`, and `.ty-<id>` is the CSS hook), so rename
  changes only `name`, never `id`. BUT to avoid ugly auto-ids: a freshly
  created, not-yet-saved id is held in a session set `newTypoIds`, and while
  it's in that set renaming re-derives the id from the name
  (`slugifyTypoId` + `uniqueTypoId` dedupe) — so typing "Hero Title" gives you
  `.ty-hero-title`. On successful Save the set is cleared and every id locks
  forever. Result: clean ids for new tokens, zero ref-breakage on later rename.
- *Delete.* Per-row `×` with confirm; removes from `state.typography`. Rect
  refs to the deleted token dangle gracefully by design (no cleanup).
- *Dirty indicator.* Create/rename/delete set a `typographyDirty` flag → the
  panel Save button shows "Save •" with an amber `.is-dirty` style; cleared on
  successful save. (Distinct from the per-page draw Save — typography is
  shared/site-wide and out of the undo history.)
- *Live WYSIWYG previews.* New `rebuildTypographyClientCss()` injects a
  `<style id="ed-typography-css-live">` mirroring `deco_typography_css()`,
  appended after the server's `#ed-typography-css` so it wins and also covers
  ids the server didn't emit at page load (new tokens). PHP emitter stays the
  source of truth for what ships; this only keeps the live editor accurate.
  (This is the hook 3b-3's field editing will drive.)
- *Verified* via the live draw UI: create (4→5), rename id-tracking
  (token→hero-title, chip + sample class follow), Save (writes 5-token file,
  clears dirty, locks ids), post-save rename keeps id locked + re-flags dirty,
  delete removes the row. Test file removed → default stays seed-fallback.
- *Next:* 3b-3 (family picker from font-bundle + local fonts, and size /
  weight / lineHeight / letterSpacing / italic field editing — driving
  `rebuildTypographyClientCss` live). Then priority #3 (real text content).

**Slice 3b-2 follow-up — "View in panel" token preview modal (v0.10.78).**
A small addition requested after 3b-2 validated: the side-panel rows show each
token as a one-line sample, which isn't enough to judge a font as body text.
- *Trigger.* A `View in panel` button (`#view-typo-btn`, `.ed-typo-view-btn`)
  below `#typography-list` → `showTypographyPreview()`.
- *Modal.* Lightweight `.ed-modal-overlay` / `.ed-modal` pattern (not a
  PanelManager dock) — `.ed-typo-pv-overlay` + `.ed-modal.ed-typo-pv-modal`.
  One `.ed-typo-pv-block` per token: a UI-font caption bar
  (`.ed-typo-pv-cap` — name + id chip + spec line) above a styled specimen
  (`.ed-typo-pv-specimen ty-<id>`) containing a heading line
  (`TYPO_PREVIEW_HEADING`) + a full paragraph (`TYPO_PREVIEW_PARAGRAPH`,
  pangram + digits + punctuation). The whole specimen carries the token's
  `.ty-<id>` class, so heading AND paragraph render in that token's actual
  style — a 48px heading token shows big text, an 18px body token shows
  real page text. Reads the **live** client CSS, so unsaved edits preview.
- *Dismiss.* Esc + click-outside, both via a `cleanup()` that removes the
  overlay and the keydown listener. Verified working.
- *Two CSS gotchas hit + fixed (worth remembering):*
  1. **em on a styled element.** `.ed-typo-pv-specimen` first used
     `max-width: 38em` for the reading column — but the element carries the
     token's own font-size (48px for a heading token), so `38em` resolved to
     ~1824px and blew the column out. Fixed to `max-width: 620px`. Lesson:
     any length in `em`/`%` on an element whose font-size is itself the thing
     under test resolves against that font-size — use px/rem for a constant
     measure. (Same family of trap as the descendant-selector footgun.)
  2. **base `.ed-modal` wins at equal specificity.** `.ed-typo-pv-modal`
     (single class, defined ~line 2630) lost to the base `.ed-modal`
     (`max-width:30rem; width:90%`, defined ~line 2789, later in source).
     Fixed by doubling specificity to `.ed-modal.ed-typo-pv-modal` — the
     same trick the codebase already uses for `.ed-modal.ed-overview-panel`
     (see the comment near line 1741).
- *Constants* live at the top of the typography block in `dev-draw.js`
  (`TYPO_PREVIEW_HEADING`, `TYPO_PREVIEW_PARAGRAPH` — the paragraph includes
  an ALL-CAPS run, v0.10.80, so caps/title usage is visible).
- *Two modes (v0.10.81).* `showTypographyPreview(only)` takes an optional
  token: the panel-head **"View all in panel"** button calls it with no arg
  (all tokens); a per-row **"View in panel"** button (`.ed-typo-row-view`,
  below each token's spec line) calls it with that token (single block, title
  "Typography preview — <name>"). ⚠ Gotcha fixed: the head button was wired
  as `addEventListener('click', showTypographyPreview)`, which once `only`
  existed passed the click Event AS `only` → a bogus single "token". Now
  wrapped in `function(){ showTypographyPreview(); }`. Per-row buttons pass
  the token explicitly so they're unaffected.

**Slice 3b-3 — per-token field editor: family + size/weight/lh/ls/italic
(v0.10.79).** Completes typography authoring — tokens are now fully editable
on-canvas (no hand-JSON). Reuses the existing route; no schema change.
- *Collapsible editor per row.* A chevron toggle (`.ed-typo-toggle`) on each
  row reveals an `.ed-typo-edit` body with six fields. Collapsed by default
  (progressive-disclosure rule — six fields × N tokens would bloat the narrow
  panel). Expand state is a session map `expandedTypoIds`, NOT persisted.
  A freshly-created token auto-expands so its fields are immediately ready.
- *Fields.* `fontFamilyField('Family', …)` is **reused as-is** — its popup
  already unions the Google bundle (`state.fontBundle`) and local fonts
  (`state.localFonts`, the `/dev/draw/local-fonts` faces), so typography gets
  the same picker as the TEXT section for free. Then `numberField` (Size,
  Line height, Letter spacing), `selectField` (Weight, from `TYPO_WEIGHTS`
  100–900 labelled; values are numbers so they match `t.weight` strictly),
  `checkboxField` (Italic).
- *In-place updates — the focus-keeping rule.* Field `onChange`s call a local
  `afterFieldEdit()` that does three things and NOTHING else: rebuild the live
  client CSS (which restyles the `.ty-<id>` sample automatically), refresh the
  `.ed-typo-spec` line text, and mark dirty. It deliberately does **not**
  `renderTypographyList()` — re-rendering mid-keystroke would blur the active
  input. Numeric handlers store only finite values (empty/NaN keeps the prior
  value); `rebuildTypographyClientCss` still clamps when emitting CSS.
- *Rename × expand-state interaction.* When an unsaved token's id re-derives
  on rename (3b-2 behaviour), the expand-state key is migrated old-id→new-id
  so the open editor stays open. Verified: `token`→`lead-para` keeps the
  editor expanded.
- *Verified* in preview: expand shows 6 fields with correct pre-filled values
  (weight select pre-selected at the token's weight); editing size/weight/
  italic restyles the sample + spec + dirty flag live; family popup lists 23
  families (bundle ∪ local incl. a local "BROWEN"), picking applies; collapse
  persists across a re-render; new token auto-expands; no console errors.
- *Next:* priority #3 — real text content on text rects (the `ty-<id>` class
  already styles whatever text goes in). Then the parked drilldown
  restructure (see the callout below).

**Slice T1 — plain-text content on text rects (v0.10.82).** Priority #3,
first slice: a text rect can now carry author-entered body copy, rendered in
its typography face on both editor canvas and the public page. Four layers,
all additive within schema **v3 (NO bump — `typographyId` precedent)**:
- *Save route* (`dev/page/save`, `config.php`): optional `text` field —
  string, ≤5000 chars, format-only validation. Normalised on write:
  whitespace-only collapses to `null` (so an "empty" text rect stores no
  content), but whitespace **within** non-empty copy is preserved verbatim
  (newlines + runs of spaces matter — the rect renders pre-wrap).
- *Editor panel* (`dev-page.js`): a multiline `<textarea>` (`.pe-rect-textarea`)
  under the Type row, text-kind only. Commits on **blur and Cmd/Ctrl+Enter**;
  plain Enter inserts a newline (the textarea is the one place Enter must mean
  newline, not submit — note the user's standing gripe about send-key UX).
  Escape reverts. `setRectText` mirrors `setRectNote`'s null discipline + caps
  at 5000. Deliberately **NOT** styled with the rect's `.ty-<id>` token — a
  48px heading token would make the narrow-panel field unusable; the live
  canvas already shows the styled result.
- *Editor canvas* (`renderRect`): a `.pe-rect-text` div behind the chrome
  (kind/z badge + note + id), `textContent` (never innerHTML), pre-wrap. The
  `.ty-<id>` class on the parent rect cascades its font down (font props
  inherit) — so DO NOT set font-size/family on `.pe-rect-text` or the token
  face is lost. Empty text → no node, kind stub stands in. `.has-text` hook.
- *Runtime* (`canvas-page.php`): emits `<div class="rect-text"><?= esc($text) ?></div>`
  with pre-wrap; falls back to the stub label/id when empty. Same inherit-the-
  ty-font discipline in `canvas-page.css`.
- ⚠ **Gotcha found + fixed (the valuable bit): `</script>` breakout in the
  editor template.** `page.php` embeds the rects blob verbatim inside
  `<script id="editor-data" type="application/json">…</script>`, with
  `JSON_UNESCAPED_SLASHES`. Free-form body text is the first field that can
  realistically contain the literal `</script>` — which closed the script
  element early and made the WHOLE editor-data blob unparseable (`JSON.parse`
  → "Unterminated string", editor loads 0 rects). Fix: after `json_encode`,
  `str_replace('<', '<', $payload)` — the `<` JSON escape prevents
  any `</script>`/`<!--`/`<script` breakout while staying valid JSON
  (`JSON.parse` decodes it back to `<`). The runtime template was never
  affected — it renders via `esc()`, not a JSON blob. This is a general
  trap for any future free-form string field surfaced through the editor's
  JSON island; the escape now guards all of them.
- *Verified* end-to-end in preview: textarea authoring → pre-wrap on canvas
  → save → `rects.json` shows `text` with preserved `\n`+spaces, other rects
  `null`, schema still 3 → runtime renders pre-wrap → an `<b>…<script>…`
  payload renders as literal escaped text (no injection) AND round-trips
  cleanly back through the hardened editor JSON.
- *Follow-up fix (v0.10.83) — chrome inheriting the token face.* Because
  `.ty-<id>` lives on `.pe-rect` and font props inherit, the editor chrome
  (kind/z label, note, id) rendered in the content's typography — an
  unreadable handwriting token made the metadata illegible. Chrome is editor
  UI, not content, so it must reset to the UI font unconditionally. Fix: a
  named `--pe-ui-font` stack, applied (with `font-style`/`letter-spacing`
  resets) directly on `.pe-rect-label` (the `.pe-rect-z` badge is its child
  → inherits the reset), `.pe-rect-id`, and `.pe-rect-note`. Direct CSS on
  the child beats the inherited token face (the weakest cascade layer). The
  runtime never had this problem — when text is present it replaces the stub
  chrome entirely, so nothing UI inherits over content.
- *Deferred (named):* ~~T2~~ (landed v0.10.84, see below); **T3** overflow /
  vertical-alignment options. Rich inline styled runs are now superseded by
  the parked discussion below.

**Slice T2 — inline on-canvas text editing (v0.10.84).** The
tablet-first-class editing path: edit a text rect's body copy *directly on
the canvas* instead of (only) in the side panel. **Double-click** a text
rect (double-tap on touch) to enter edit mode; the rect's `.pe-rect-text`
node becomes `contenteditable="plaintext-only"` (WebKit/Blink-native
plain-text editor — strips paste formatting, newlines round-trip through
`textContent` under `white-space: pre-wrap`, native iPad WebKit support). The
T1 side-panel textarea is retained as a secondary surface; a `.pe-field-hint`
under it advertises the canvas gesture.
- *State:* one module-level `editingId` (alongside `selectedId`). `renderRect`
  marks the rect editable when `rect.id === editingId`, attaching the
  contenteditable, an Escape/⌘↵ keydown handler, and a blur handler.
- *Helpers:* `enterEditMode(id)` (clears any drag, selects + sets `editingId`,
  `render()`, then `focusEditable()`); `commitEdit(doRender)` (reads the live
  `.pe-rect-text.is-editing` `textContent`, applies the same null/5000-cap
  discipline as `setRectText`, clears `editingId`); `cancelEdit()` (drops
  `editingId`, re-renders → reverts to last-committed text); `focusEditable()`
  (re-focuses the live editable after each `render()` — called at the end of
  `render()`) and `placeCaretEnd(el)`.
- *Gesture de-confliction* (the crux — single-click must still select/drag):
  (1) **double-click** (not click) enters edit, so single-click drag is
  untouched; (2) the `pointerdown` handler bails early if the target is inside
  the live editable (lets the caret land), otherwise `commitEdit(false)` and
  proceeds — so clicking away commits; (3) `renderOverlay()` early-returns
  while `editingId != null`, suppressing the move grip + resize handles so they
  can't intercept caret clicks; (4) `deleteRect` clears `editingId` if it
  deletes the rect being edited. The pre-existing global keydown handler
  already bails on `isContentEditable`, so Backspace/Escape/⌘S don't fight the
  inline editor.
- *Double-click detection — the v0.10.84→.85 gotcha.* The original T2 used a
  native `dblclick` listener on `surface`. **It never fired**: the
  `pointerdown` handler calls `ev.preventDefault()` on every rect hit, and
  *preventDefault on pointerdown suppresses the browser's synthesized
  `click`/`dblclick` compatibility events* — so double-click was dead on real
  input (a synthetic `dblclick` dispatched straight at the node in testing
  hid this — false positive). **Fix (v0.10.85):** detect the double-tap
  manually inside `pointerdown` — module state `lastTapTime`/`lastTapId` +
  `DOUBLE_TAP_MS` (350); the second pointerdown on the same text rect within
  the window calls `enterEditMode` and returns (skips drag setup), the first
  falls through to select+drag. The dead `dblclick` listener was removed. This
  also hands the future tablet layer a real **double-tap** (the native
  `dblclick` would never have worked on touch either). Lesson: never rely on
  `click`/`dblclick` alongside a `preventDefault`-ing pointer handler — and
  test gestures by dispatching the *real* event sequence (pointerdown/up
  pairs), not the synthetic high-level event.
- *Commit/cancel:* blur → commit; ⌘↵ (or Ctrl-Enter) → commit; Escape →
  cancel (revert). Plain Enter inserts a newline (plaintext-only).
- *Verified (preview MCP, v0.10.85, via real pointerdown/up pairs):*
  double-tap → focused editable with caret, overlay handles gone, newlines
  preserved; single tap does NOT edit; ⌘↵ commits + marks dirty; Escape
  reverts; click-away commits; Save → reload round-trips the inline-edited
  text (with `\n`) to disk; no console errors. Schema unchanged (still writes
  3) — T2 is pure editor UX over the T1 `text` field, no save-route change.

**Slice TS1 — rich text via offset-marks + live WYSIWYG (strong/em)
(v0.10.86 → v0.10.91).** Landed. The first end-to-end proof of the
governed rich-text engine the user asked for ("complete and fine-grained
text styling, as HTML does" — but authors apply *prepared* styles, never
raw code). TS1 ships the data model, the edit-time mark algebra,
render-from-marks parity (editor + runtime), and the two atomic styles
`strong`/`em` via a floating B/I toolbar, with **live WYSIWYG while
typing** (the user's chosen edit surface). Approved plan:
`.claude/plans/flickering-watching-mccarthy.md`.

- **Data model — offset marks (the NSAttributedString shape).** A text
  rect keeps its plain string `rect.text` (T1/T2 untouched) PLUS a new
  sibling `rect.marks`: an array of `{start,end,attr,value}` over the
  half-open interval `[start,end)`. TS1 attrs are `strong`/`em` with
  `value:true`. *Runs* (contiguous same-style segments) are **derived at
  render time** by `segments()`, never stored or hand-edited — this is
  what lets marks survive arbitrary text edits.
- **Why a flat sibling field, NOT nested `{text,marks}` — and why no
  schema bump.** `marks` is additive within rects-content **schema v3**
  with a safe default `[]`, exactly how `text` and `typographyId` were
  added before it (read-time normalization fills the default; old code
  ignores the field; the save route keeps writing `schemaVersion:3`).
  So: **no CONTENT_SCHEMA_VERSION bump, no migration script, no
  per-snapshot authorization.** Old data → `marks:[]` → a single
  unstyled run, byte-identical to pre-TS1 output.
- **Mark shape is forward-compatible.** The composition rule that drives
  everything: **same `attr` → overwrite/coalesce; different `attr` →
  compose.** `value` is `true` today but the validator already accepts a
  `<=256`-char string, so TS3's valued attrs (`color`/`token`/`link`)
  drop into the same shape with no model change.
- **The 5-op mark algebra (the engine, `assets/js/dev-page.js`).** Pure
  functions, client-side only (PHP never edits marks, only renders +
  validates). All ops keep marks normalized:
  - `diffText(old,new) → {p,d,i}` — common prefix/suffix diff → one edit
    (delete `d`, insert `i` at `p`). Covers type/delete/paste/replace
    uniformly against the `input` event's before/after text.
  - `remapMarks(marks,p,d,i)` — shift after `p` by `Δ=i−d`; **insertion
    strictly inside a mark grows it**; **boundary insertion leaves the new
    text unstyled**; deletion clips survivors; fully-covered marks drop.
    Survivors keep their attr — this is how runs persist across edits.
  - `applyMark(marks,a,b,attr)` — toggle: if `[a,b)` is uniformly covered
    → remove over `[a,b)` (a mark that *strictly contains* `[a,b)`
    **splits into two** — this is precisely how partial-removal creates
    new runs); else add `{a,b,attr,true}`.
  - `normalizeMarks(marks,len)` — drop empty/`start>=end`, clamp to
    `[0,len]`, per-`(attr,value)` merge of adjacent/overlapping ranges,
    deterministic sort for stable serialization.
  - `segments(text,marks)` — boundary-union segmentation → the runs;
    reimplemented in PHP for runtime parity.
  - Caret helpers `getCaretOffset`/`locateOffset`/`setSelectionRange`
    walk text nodes to read/restore the selection across a span rebuild.
- **Edit surface — `contenteditable="true"` (was `plaintext-only`).**
  Typing **patches the DOM in place** — no re-render on keystroke, so
  IME / dead-keys / accents are safe. The styled `mk-*` child spans are
  rebuilt **only on style apply/remove and on commit**, never on input.
  Because `true` (unlike `plaintext-only`) reintroduces rich paste and
  `<div>`/`<br>` on Enter, TS1 adds two guards: **paste → insert as
  text/plain** and **Enter → insert a literal `\n`** (both via
  `insertPlainTextAtCaret`, which does the Range edit then calls
  `handleEditInput` because a manual DOM edit doesn't fire `input`).
  `handleEditInput` is the live tracker: diff `el.textContent` vs the
  last-known `editText`, `r.marks = normalizeMarks(remapMarks(...),len)`,
  update `editText`, `markDirty()` — **no `render()`** (preserves caret +
  composition). `enterEditMode` seeds `editText`; `commitEdit` syncs
  marks to the committed text length.
- **Floating B/I toolbar (`toggleStyle`/`buildTextToolbar`).** Shown
  while a rect is being edited; `position:fixed` above the editable
  (flips below if it would clip the viewport top), rebuilt from
  `render()` right after `focusEditable()`. **CRITICAL focus-guard:**
  each button binds BOTH `pointerdown` and `mousedown` with
  `preventDefault`, so pressing it never blurs the editable (without
  this, blur → `commitEdit` fires → `editingId` clears before the click
  handler runs, and the toolbar silently does nothing). The `click`
  carries the action. `toggleStyle` reads the selection, applies
  `applyMark`, normalizes against `editText.length` (NOT `r.text` —
  that's stale until commit; marks track the live editable), repaints the
  runs, then restores the selection so successive clicks compose on the
  same range. A one-time `selectionchange` listener (`selChangeBound`
  guard) keeps the B/I `.is-active` pressed-state in sync via
  `rangeHasAttr`. **Collapsed caret (end<=start) is a deliberate no-op**
  — pending-format is deferred to TS2.
- **Render parity — one algorithm, implemented twice.** `segments()` in
  JS (editor canvas) and `deco_text_segments()` in PHP
  (`site/plugins/deco/index.php`, runtime) produce identical span
  structure; `deco_marks_classes()` mirrors the JS `MARK_ATTR_CLASS`
  ordered map (`strong→mk-strong`, `em→mk-em`). Static CSS in BOTH
  stylesheets — `.mk-strong{font-weight:700}` / `.mk-em{font-style:
  italic}` in `dev-page.css` (`.pe-rect-text …`) and `canvas-page.css`
  (`.rect-text …`). No dynamic emitter yet (that's TS3, modeled on
  `deco_typography_css()`). **The CSS cascade works in our favour:** a
  direct `.mk-*` class on the child span beats the `.ty-<id>` typography
  token *inherited* from the parent rect — the CLAUDE.md
  descendant-selector / inheritance footgun, here pointing the right way.
- **⚠ UTF-16 vs code-point parity caveat.** JS offsets are UTF-16
  code-units; PHP `segments()` uses `mb_*` code-point indices. **Identical
  for the BMP** (all ordinary design copy) but **astral characters
  (emoji, some CJK ext) could mis-slice** a mark boundary. Acceptable for
  TS1's strong/em scope; revisit if/when text styling meets emoji-heavy
  content (options: store code-point offsets on save, or grapheme-aware
  segmentation).
- **Save-route governance (`config.php` `dev/page/save`).** Shape-only
  validation, lenient like `typographyId` (no attr-registry membership
  check — an unknown attr just maps to no class and degrades): `marks`
  must be a genuine JSON list (assoc object / string rejected); each
  element needs `start`/`end`/`attr`/`value`; int `0 <= start < end <=
  mb_strlen(text)` (a marks array on a textless rect fails — no offsets
  to anchor); `attr` matches `/^[a-z][a-z0-9_-]{0,31}$/`; `value === true`
  or a `<=256`-char string; `<=1000` marks/rect. Normalization re-indexes
  via `array_values` and forces `[]` when text is null. `page.php`
  read-time default fills `marks:[]` when absent/non-array.
- **Verified end-to-end (port 8799):** valid marks round-trip (persist,
  `schemaVersion` still 3, non-text rects → `marks:[]`); 7 malformed
  shapes rejected with precise errors; runtime renders
  `"T2 <span class=mk-strong>roundtrip</span> \n<span class=mk-em>line
  one</span>…"` identical to the editor; XSS — `"<b>x</b> </script> &"`
  renders fully `esc()`'d with the mark span wrapping the escaped run.
  **Gotcha caught during verification (not a code bug):** an editor page
  left open with stale in-memory marks can overwrite a programmatic disk
  save on blur/autosave — a test-harness artifact. The runtime faithfully
  renders whatever is on disk, which is the parity proof.

> **Roadmap — governed rich text beyond TS1 (M1/M2 cascade).** The
> long-term posture (agreed with the user, NOT built yet): **named
> character-styles (M2) become the design-system default**, with **atomic
> composable overrides (M1, = TS1's strong/em) as the escape hatch** for
> genuine special cases. Both live on the same `marks` storage, resolved
> by a **cascade**: rect base typography token < named char-style <
> atomic override. This rhymes with palette + typography-tokens and with
> the progressive-disclosure principle. The TS1 engine is already
> layer-aware (the attr→class map is an ordered list, not a flat switch)
> so M2 drops in with no algebra change. Deferred slices, named so they
> aren't lost:
> - **TS2** — toolbar completeness: collapsed-caret **pending format**
>   (type-then-styled), ⌘B/⌘I keyboard shortcuts, indeterminate/mixed
>   pressed-state, any further atomic axes.
> - **TS3** — **valued prepared styles**: `color` (palette ref), `token`
>   (typography ref), `link` (href); a dynamic `.mk-*` CSS emitter
>   referencing the registries (modeled on `deco_typography_css()`);
>   registry-aware governance validation.
> - **TS4** — **M2 named character-styles** as the governed default: a
>   `charStyle` axis + prepared-charStyle registry + authoring panel (like
>   the typography panel), resolved as the cascade's middle layer (atomic
>   overrides still win).
> - **Possibly-accept-some-HTML** (`<p>`/`<br>`) was on the table but the
>   offset-marks model supersedes it — governance is kept, no
>   sanitisation surface, `esc()` on every run. Revisit only if a hard
>   requirement for author-pasted HTML appears.

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

**Deploy-UX future work (not urgent — flagged by user v0.10.34).**
Two improvements to fold in when the deploy tooling is next touched:

1. **Host-scoped config push should not rely on memory.** Updating
   the gate (`config.<SERVER_NAME>.php`) currently means a hand-typed
   SCP the user has to re-derive each time. Fold it into the deploy
   flow: e.g. `deploy.sh --host-config` (or a dedicated
   `deploy/push-host-config.sh`) that SCPs the per-host config to
   `$REMOTE_PATH/site/config/` and runs the logged-out `curl` 403
   verification automatically. The file stays rsync-excluded for the
   normal mirror; this is a deliberate, separate, one-command push.
2. **Two-server (staging + production) deploy.** The user has set up
   TWO test servers. `deploy.env` is currently single-target
   (`REMOTE_HOST` + `REMOTE_PATH`). Generalise to named targets
   (e.g. `deploy.sh staging` / `deploy.sh prod`, each with its own
   host alias, REMOTE_PATH, and host-scoped `config.<name>.php`).
   Each server has a distinct `SERVER_NAME`, so each needs its own
   host-scoped config filename — the gate generalisation (v0.10.33)
   already makes that file env-agnostic in content, only the filename
   differs per host.

**Process artifact.** During this slice the
"clarify high-leverage assumptions before acting" rule was violated
once (papered-over unknown SSH user + REMOTE_PATH with TODO comments
instead of asking). User flagged it; recovered by asking and
collecting the real values. Worth re-reading the user's behavioral
preference section below if you're not the same Claude.

### Security hardening batch (v0.10.2–v0.10.7)

Triggered by a Kirby CVSS 8.8 CVE notification mid-Phase-2-planning.
Five tracked production-surface changes; all aimed at reducing what
the deployed surface reveals to anyone probing it, plus the upstream
patch.

**1. Opaque 403 body for `/dev/draw` auth gate (v0.10.2).** Earlier
body was developer-friendly but a tech-stack beacon:
`"Forbidden — /dev/draw requires a logged-in Kirby Panel user. Log
in at /panel and reload this page."` — named the framework, named
the admin surface, named the login path. Replaced with the single
neutral line `"Forbidden\n"`. Lives in
`site/config/config.<SERVER_NAME>.php`'s `ready` callback. That
file is rsync-excluded; the in-repo copy is the template / source
of truth, the server copy is updated manually via SCP.

**2. `header_remove('X-Powered-By')` globally (v0.10.3).** Added at
the very top of the host-scoped `ready` callback so it covers
EVERY response, not just `/dev/draw`. Reason: `expose_php = Off`
in php.ini would also do this, but Infomaniak shared hosting
doesn't reliably honor user php.ini overrides. Doing it in PHP
guarantees the header is gone for this app.

**3. deploy.sh ships a comment-stripped `.htaccess` (v0.10.3).**
The in-repo `.htaccess` carries a substantial commentary block at
the top (rationale for each directive, history of the ErrorDocument
experiment, etc.) — useful locally, a complete tech-stack reveal
online (Kirby, Infomaniak, `/panel`, the deploy mechanism, all
named). Pipeline:
- `mktemp` a staging file
- `sed -E '/^[[:space:]]*#/d; /^[[:space:]]*$/d'` strips comments + blank lines
- `chmod 644 "$STAGED_HTACCESS"` — **CRITICAL** (see below)
- Main rsync uses `--exclude=/.htaccess`
- Separate rsync at deploy-end pushes the staged file to
  `$REMOTE_PATH/.htaccess`
- `trap 'rm -f "$STAGED_HTACCESS"' EXIT` cleans up on any path

**4. THE MODE-0600 GOTCHA (v0.10.7) — critical, save yourself
hours.** `mktemp` creates files with mode 0600 (owner-only). `rsync
-a` preserves source mode. Without the explicit `chmod 644`, the
deployed `.htaccess` lands on the server as mode 0600. Apache on
shared hosting runs as a DIFFERENT user from the deploy account
and cannot read it. Apache's response to an unreadable `.htaccess`
in a directory is to return **HTTP 403 for EVERY URL in that
directory** — the whole site goes dark with no obvious cause
upstream. The chmod 644 line in deploy.sh has a CRITICAL comment
block explaining this. If a future deploy ever produces a
site-wide 403, the first check is the mode of the deployed
`.htaccess`.

**5. ErrorDocument 403/404 with inline plain-text bodies
(v0.10.7).** Apache's default 403/404 templates leak
`mailto:webmaster@bbh.fr` and a visible "Apache" string in the
body. Override with `ErrorDocument 403 "Forbidden"` and
`ErrorDocument 404 "Not Found"` in `.htaccess`. **Important:
Infomaniak DOES allow these — the v0.10.5 attempt that appeared
to fail was actually the mode-0600 bug above masquerading as an
AllowOverride rejection.** A clean retest after the chmod 644
fix confirmed they work (`curl /.git/config` → HTTP 403 with the
9-byte "Forbidden" body, no mailto, no Apache reference). Note:
Kirby's rewrite catches every virtual URL and routes through
`index.php`, so the 404 ErrorDocument only fires for things
Apache itself refuses (e.g. the protected dotfiles); for in-app
404s, Kirby's own error template renders (currently
`<h1>Error</h1>` — minor leak, no framework name, customizable
later via a Kirby `error.php` template if desired).

**6. Kirby 5.4.0 → 5.4.2 (v0.10.4).** Straight folder swap (no
custom modifications inside `kirby/`). 5.4.1 fixed the CVSS 8.8
issue; 5.4.2 picked up a same-day symfony/yaml security release.
Local smoke test (home 200, /panel 302, /dev/draw 200, no PHP
errors) confirmed clean before commit. Backup of 5.4.0 sits at
`../kirby-5.4.0-bak` outside the repo.

**Accepted leaks (documented, not fixable here).**
- `Server: Apache` response header — cannot be stripped on shared
  hosting without mod_security access.
- Kirby's `<h1>Error</h1>` 404 template body (in-app 404s only);
  customizable later via `site/templates/error.php`.

**Parked for later (v0.10.8).** Panel IP allowlist via dynamic
DNS — captured in the Phase 3 area, not currently needed. See
the "Parked: Panel IP allowlist via dynamic DNS" subsection.

### Phase 2 planning — first concrete page + slice plan (v0.10.14)

Coming off the user's small 100% Kirby learning exercise
(complete enough to move forward, not exhaustive). This slice
records the first concrete page description and the slicing plan
that fell out of it. No code yet.

**The concrete page (the user's words, summarised).**
- Primary surface is a **monopage**: chapters that would be separate
  pages on a more usual site are merged vertically; a long scroll
  reaches everything.
- A few **secondary pages** (legal, policy) are necessary but
  second-class — reached via small links at the bottom, not via a
  menu (a menu implicitly signals first-class items).
- **Menu existence is deferred** — depends on how the main page
  designs out.
- This is a **fine-art portfolio**, so photos are first-class; text
  is equally first-class.
- Main-page sections, top to bottom:
  - **(a)** title (+ maybe subtitle/slogan) + hero image (rotating
    later if wanted, not planned early)
  - **(b)** some text below
  - **(c)** several images with titles and short descriptions —
    variable count (page is scrollable, so adding/removing is cheap)
  - **(d)** blog-like paragraphs with or without smaller images —
    but none of the standard blog properties (not a blog)
  - **(e)** the not-a-blog parts may have **drill-down** — additional
    text/images not initially visible (don't overload the page).
    Author wants to avoid splitting into separate pages; if drill-down
    feels worse in practice than expected, the fallback is small
    separate pages with a back-link that returns to exact prior scroll
    position
  - **(f)** all sections should be **easily reorderable**
  - **(g)** the description deliberately says nothing about
    *positions* of items — that is the role of the foundational
    rect-blocks
  - **(h)** at the end, the few small technical links nobody reads

**The architectural insight from (f)+(g).** A first instinct was to
model the page as a flowing-HTML stack of chapter blocks (Kirby's
native blocks field, reorderable in Panel). User corrected: rect-blocks
have **absolute coords** on a tall canvas; chapters exist visually for
author and visitor but technically any item can sit anywhere; the
editor recalculates coords when the author rearranges. This is the
whole point of having a rect-block layer — free placement, not
constrained by HTML flow. It also matches Deco's coord world exactly,
so the Deco↔HTML coexistence becomes seamless: both layers speak
absolute coordinates.

**Sub-decisions made in the planning conversation.**

- **Drill-down behavior = overlay** (recommended, accepted). The
  reveal sits over the page; nothing below shifts. Keeps the
  absolute-coord model pure. **Push** (rest of page shifts down on
  reveal) is parked; revisitable if overlay feels wrong in practice.
  **Reserve-max-height** (rect pre-allocates expanded height) was
  rejected because authors can't reliably predict expanded height.
  Open sub-question for first real test: does the rest of the page
  also freeze + darken while the overlay is open? Decide after
  feeling it.
- **Responsiveness: both modes available.** Per-breakpoint coords
  (each rect carries `{ wide:{x,y,w,h}, medium:{...}, narrow:{...} }`)
  AND responsive rules (one canonical coord + behavioral rules) —
  author picks per rect / per page based on whether the result is
  worth the extra work. Responsive rules are cheap to support, so
  no reason to omit them. Slices 1–2 single-breakpoint to defer
  the complexity.
- **Chapter IDs = author-declared.** Each rect carries an optional
  chapter ID; author groups rects into chapters explicitly.
  Inference from spatial proximity was considered and rejected:
  inference is guaranteed to break in at least some real cases
  (artist places a small note rect between chapters, ambiguous
  edges between chapters of similar size, etc.).
- **Vocabulary fix.** "Hand-authored" in this project means
  *author's hand manipulating objects on a canvas*, not
  *typed into JSON by hand*. Rect coords are exclusively
  canvas-authored. Recorded in the DECIDED block of the Phase 2
  roadmap section.
- **Second blueprint timing.** Multiple page blueprints are a
  necessity (secondary pages and the monopage have different
  designs), but late in Phase 2. Scaffolding is best prepared
  early — Slice 1's data shape needs to be blueprint-agnostic
  so adding a second blueprint later is a configuration change,
  not a data-shape refactor.

**The slicing plan.**

1. **Slice 1 — Data shape + runtime template + minimum rect-editor
   canvas.** Three pieces land together because they only make sense
   together. Data: per-page list of rects
   `{ id, kind, x, y, w, h, chapterId?, contentRef? }` + a chapter
   list `[{ id, name }]` at page scope. Runtime: Kirby template
   iterates rects, renders each as a `position:absolute` div with
   stub content (kind-labeled coloured box, no real text/image yet);
   container height = `max(y+h)`. Editor: a page surface
   (working name `/dev/page/<page-id>`) that loads page JSON, lets
   author add / move / resize / delete rects and assign kind +
   chapter ID, saves back. **Initial kinds**: `text`, `image`,
   `drilldown`, `deco-mount` (all stubs at this slice — content
   editing is Slice 2). Outcome: one page exists end-to-end,
   authored on canvas, rendered by Kirby. Stubs everywhere but
   the spatial + structural model is real.
2. **Slice 2 — Kirby Panel can edit rect content** (text fields,
   image uploads). Positions stay in the data shape but aren't
   edited in Panel — that remains the rect-editor's job. Two
   surfaces, same data. Establishes the multi-surface story
   early per the reentrancy principle.
3. **Slice 3 — Typography tokens** (shared artifact #1). JSON →
   PHP-emitted CSS classes → token select field on text rects.
   Single source of truth, Deco doesn't read it yet.
   **3a DONE (v0.10.75): seed + select** — token JSON + PHP emitter
   (`deco_*_typography`) + Type dropdown/preview on text rects (see
   the Slice 3a entry above). **3b — authoring UI in draw**, sub-sliced:
   **3b-1 DONE (v0.10.76)**: read-only panel + `dev/draw/typography`
   save round-trip. **3b-2 DONE (v0.10.77)**: create / rename / delete
   tokens (stable-id discipline + live previews — see the 3b-2 entry
   above). **3b-2 follow-up DONE (v0.10.78)**: "View in panel" preview
   modal (each token as heading + full paragraph). **3b-3 DONE
   (v0.10.79)**: per-token collapsible field editor — family picker +
   size / weight / lineHeight / letterSpacing / italic. Typography
   authoring is feature-complete.
4. **Slice 4 — Deco bootstrapper + htmlKey slots** (shared artifacts
   #2 + #3). `deco-mount` rects render as `<div data-deco="…">`;
   JS bootstrapper mounts the Deco runtime per rect against the
   right snapshot. Phase 1 `/dev/draw` accepts a parameter so the
   editor opens against the rect's snapshot. End-to-end Deco
   inside Kirby for the first time.
5. **Slice 5 — textBlock content binding.** Resolves the deferred
   sub-decision (Kirby field with Deco rendering vs Deco JSON with
   Kirby referencing) once Slices 1–4 reveal which feels more
   natural.
6. **Slice 6 — Drill-down mechanism.** Overlay implementation
   (push parked). Pure HTML/CSS/JS reveal inside the `drilldown`
   rect kind. Watch-out for the parked fallback path
   (separate-pages-with-back-link): preserving scroll on back
   navigation is browser-level work, not Kirby — park unless the
   fallback is actually invoked.
7. **Slice 7 — Custom polish + UX iteration on the rect-editor.**
   Whatever sharp edges Slices 1–6 surface.
8. **Slice 8 — Responsiveness landed.** Per-breakpoint coords +
   responsive rules; rect-editor learns to switch breakpoints
   like Deco's class chips.
9. **Slice 9+ — Second blueprint(s) for secondary pages.** Data
   shapes from Slice 1 carry over; this is mostly a Kirby
   blueprint exercise plus a small page-type selector in the
   editor.

> **⏸ Parked architectural consideration — drilldown: kind → property
> (raised v0.10.76, to act on AFTER typography 3b is done).** The user
> flagged that the `drilldown` rect *kind* has no content axis of its own,
> so it's meaningless on its own and bolting a content type onto it would
> just badly duplicate text/image/deco-mount. Root cause: `drilldown`
> conflates **what a block contains** (text / image / deco-mount) with
> **what it does on tap** (reveal an overlay) — orthogonal concerns. The
> agreed direction: **remove the `drilldown` kind and add an optional
> `drilldown` *property* to all other kinds** (hidden by default → fits the
> progressive-disclosure rule: a `+ Drilldown` discloser on any block).
> When picked up this is a real fork (rects-schema migration for existing
> `drilldown` rects, validator change, editor UI, runtime overlay wiring,
> the `KIND_ORDER`/z-stub code at HANDOFF ~line 893) and gets the full
> fork-in-the-road treatment + its own slice plan then. **Not started.**

**Behavioral artefact from this conversation.** I (Claude) initially
proposed a Slice 1 with hand-typed JSON and no editor, deferring the
rect-editor to a much later slice. User pushed back: the canvas is
already a decided part of Phase 2 (HANDOFF mentions it under the
DECIDED block); deferring it was the kind of high-leverage
assumption that should have been confirmed first. The HANDOFF was
not wrong but was under-specified — it did not say "exclusively
canvas-authored," leaving room for the shortcut. The DECIDED block
has been tightened in this same update; the lesson worth holding:
when a planning sub-decision contradicts what looks like already-
settled architecture, surface it as a question, don't quietly slice
around it.

### Slice 1 step 1 — editor skeleton + Deco-config canvas read (v0.10.15)

First Phase 2 code lands. Three new files in the repo, two local-only
Kirby page records (gitignored):

- `site/templates/page.php` — editor template, mirrors `draw.php`'s
  shape. Resolves target page from `?page=<slug>` query (falls back to
  the editor page's `TargetPage` field, then `home`). Loads target's
  rects.json (empty if absent), reads target's Deco config via
  `deco_load_page_config()`, picks the widest entry in `useClasses`
  as the Slice-1 "primary class", embeds everything as JSON in
  `<script id="editor-data">`. Toolbar: brand + version + page picker
  + class-label badge + disabled +Add-rect + disabled Save + status.
  Body: sidebar with placeholders for Chapters + Selection panels;
  main `#page-editor-surface` sized to `pageW × pageH` (canvas).
- `assets/js/dev-page.js` — vanilla JS bootstrapper. Parses
  `#editor-data`, defensively normalises (so a stale-cached editor
  doesn't throw), wires the page-select reload, renders `state.rects`
  into the surface, writes a status line. `window.__pageEditor`
  exposed for console debugging — removed once real UI replaces it
  in step 4+.
- `assets/css/dev-page.css` — chrome styling. Toolbar at top, 260px
  sidebar on the left, scrollable canvas wrap with a striped
  background so the white canvas-surface visually pops. Kind-colour
  palette for rect stubs: text=blue, image=amber, drilldown=violet,
  deco-mount=mint. Duplicated to the runtime `canvas-page.css` when
  that lands in step 5; refactor to a shared tokens file in Slice 7
  if patterns recur.
- `content/dev/page/page.txt` (gitignored) — Kirby page record so
  `/dev/page` resolves. `TargetPage: home` for first-load convenience.
- `content/test/test.txt` (gitignored) — sandbox target page used for
  step-by-step testing before a real `canvas-page` blueprint exists.

**Architectural refinement landed in step 1 — canvas dimensions
come from Deco, not from Phase 2.** The user pointed out during
planning that Deco's class registry already defines canvas dimensions
per page (per-class) — having Phase 2 redefine a width would either
duplicate that data or quietly diverge from it. Recommendation
accepted: Phase 2 reads `deco_load_page_config($targetPage->root())`
and uses the widest class's `pageW × pageH` as the editor canvas
size. `rects.json` carries no width/height of its own. Slice 8
(responsiveness) extends this with per-class coord sets inside
`rects.json` — no coordinate translation needed at the Slice 8
boundary because coords are already (x,y) inside the Deco frame.
File merge (`rects.json` into `page.json`) is parked for after both
phases stabilize — flag, not decision.

**Behavioral pattern carried forward from `draw.php`:** filtering
the page-picker to skip the `/dev` tree, the error page, and any
"subpage" that's really a class folder. Same filter, same regex,
copy-pasted intentionally so the two editor surfaces stay
behaviourally aligned.

**No commit / no push yet.** Step 1 is implemented locally; the user
tests before deciding to commit and move to step 2. Per the global
rule: commits are not autonomous.

**Principle flagged after step 1 — integrate, don't drift.** The
canvas-dimensions integration (read from Deco's `dims[classId]`) was
applied. The kind-colour palette was NOT — `dev-page.css` hardcodes
the four kind colours (text=blue, image=amber, drilldown=violet,
deco-mount=mint) instead of reading from `deco_load_palette()` /
`content/_shared/palette.json`, which already carries the project's
design colour tokens. Not a functional problem now (the hardcoded
defaults work as placeholders) but it IS exactly the kind of quiet
duplication that compounds.

**The rule (decided here, applies to every future slice).** Any
affordance that already exists in any Deco phase — palette, masters,
classes, page config, anything in `content/_shared/*.json` or
exposed by a `deco_*` helper — is **common data by default**. Phase 2
consumes it; it does not re-author it. If a Phase 2 need requires
extending the existing data shape (e.g. palette gains a "page-kind
tag" field), the extension goes into the shared data and the helper,
not into a Phase-2-only parallel. **Starting with the next update**,
the first question on any new Phase 2 piece is "does Deco already
have this?" — if yes, integrate.

**Concrete debt to clear next iteration.** Replace the hardcoded
kind colours in `dev-page.css` (and the future `canvas-page.css`
runtime copy) with values drawn from the project palette. Likely
shape: add a `kindColors` (or similar) field to the palette JSON
mapping rect kinds → palette token IDs, emit the resulting CSS
custom properties from PHP at template time, reference them from
the kind selectors. Same single-source-of-truth shape Deco already
uses for its line colours.

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

**Parked design direction (not yet decided, captured so it isn't
lost):** the favored integration shape is **Deco-and-Kirby
coexisting on the same page** along a continuum from 0% Deco
(pure Kirby page — legal, privacy, contact) to 100% Deco (full
canvas — landing, showcase), with hybrid pages in between where
first-class HTML and Deco regions share the surface, both
clickable, the author managing layout conflicts and Deco warning
about overlaps. `htmlKey` slots are the spatial bridge: a
Phase-2 page-planning canvas lays down rectangles (content
holders); each rectangle has a key; Kirby templates reference
the key; at runtime the slot is filled with either inert HTML
or a live Deco mount.

**Phase-2 rectangles flow back into Phase 1.** The same rectangle
list authored in the Phase 2 planning canvas must surface inside
the `/dev/draw` Deco editor too — rendered alongside the
existing page-area outline, but as nested blocks within it.
Phase 1 doesn't create them; it inherits them as authored
constraints (visible reference for placing Deco objects relative
to where content will live). Technically light (the rectangle
list is JSON; Deco already renders a page-area outline; nested
rectangles are the same render path with one more layer).
Architecturally important because it pins the directionality:
**Phase 2 is upstream of Phase 1 on this axis**, even though
Phase 1 came first chronologically.

**DECIDED (v0.10.12): Kirby pages manage the mix. No separate
display layer.** A Kirby template emits HTML containing the
rect-blocks as `<div data-rect="…" [data-deco="…"]>` placeholders.
A small JS bootstrapper finds `[data-deco]` divs and mounts the
Deco runtime in each, pointing at the JSON. Inert rects are
ordinary HTML filled by Kirby field values. CSS (per rect class)
owns responsive layout of the boxes; Deco's per-class snapshots
continue to handle responsive animation inside each region.

The shared-artifact JSON files (rectangles, slot keys, typography
tokens — see below) live in known paths, read by PHP at template
render time AND by JS at Deco mount time. One source of truth,
two readers — clean, not messy.

**Rect coords are authored exclusively via the Phase-2 canvas
editor — there is no hand-JSON stage.** This parallels Deco's
authoring model: the canvas IS the editing surface, the JSON is
its persistence format. "Hand-authored" in this project's
vocabulary means *author's hand manipulating objects on a canvas*,
NOT *typed into JSON by hand*. (Updated v0.10.14 — earlier wording
left this ambiguous and a slicing proposal slipped a JSON-first
shortcut past the rule; user corrected.) Typography tokens generate CSS
classes (`.style-heading-xl` etc.) that the templates apply, and
the Deco textBlock runtime reads the same JSON to render in-canvas
text matching those tokens.

Why NOT a separate display layer (rejected, documented so it
isn't relitigated): going headless throws away Kirby's value
proposition (Panel + flat files + simple PHP rendering) and
forces rebuilding everything Kirby gives free (controllers,
snippets, navigation helpers, image pipelines, multilingual
machinery, SEO surface, browser back/forward semantics, link
sharing, RSS, sitemaps, print stylesheets). It is precisely
the path Divi/Elementor took to bloat. The "more open / could
swap Kirby later" argument is theoretical: by the time swap
mattered, the display layer would be entangled with Kirby's
content shape and the abstraction would be illusory.

Watch-outs for staying on Option A:
1. **Keep the generated Kirby template dumb.** Phase 2's page-
   planning canvas emits a template that does nothing but write
   divs with classes and `data-deco` attributes. All intelligence
   lives in the JSON artifacts (PHP+JS readers) and hand-written
   CSS. A template that grows logic is the first step down the
   Divi slope.
2. **Convention, not freedom, for shared-JSON locations and
   shapes.** Pick file paths, naming, schema early; future
   Phase 2 work extends them but does not invent new locations
   or shapes ad-hoc.

Cross-page Deco continuity (browser navigation = reload) is
acceptable as default; if true continuum-across-pages becomes a
real requirement later, add a small SPA-style fetch+swap shim
(~200 lines) without restructuring. Defer that cost.

Remaining open sub-decisions, deferred until concrete pages
exist:
- responsiveness model FOR DECO INSIDE EACH REGION (per-class
  snapshots as today vs. one-snapshot + per-object responsive
  rules — page-level responsive is now CSS's job, decided)
- textBlock content source-of-truth (Kirby field with Deco
  rendering it, vs. Deco JSON with Kirby referencing it)
- multi-page navigation (each page is a fresh canvas vs. SPA
  shim for canvas continuity — defer)
- editing surface progression (start simple: edit Deco regions
  by opening `/dev/draw` against the page's snapshot; in-page
  edit mode later)

Resolution strategy: build a small 100% Kirby exercise first to
get a real feel for Kirby's content model, then describe one
concrete page in prose, then let the sub-decisions fall out of
that page.

**Workflow ordering (separate from architecture).** Phase 1 was
built first because the project started as an exploration of
what's possible with animated SVG — feature-driven, not
production-driven. The natural *authoring* workflow once both
phases exist is the reverse: **start in Phase 2 thinking content
and page structure, then move to Phase 1 to make those content
holders come alive, then back-and-forth** as the design evolves.
Phase 2 is therefore upstream of Phase 1 on two axes (the
content-structure axis already noted, AND the authoring workflow
axis). This will inform UX decisions later — e.g. the natural
entry point for creating a new page is Phase 2, with Phase 1
opened from within Phase 2 to populate a specific rectangle.

**Project-wide principle: phases must be reentrant.** This is the
most load-bearing meta-rule. Authors discover/invent things during
work — it's the dominant mode for any creative project, not a
corner case. A one-way pipeline (Phase 2 finishes, then Phase 1
begins, no looking back) would force authors to either exit and
re-enter upstream every time a new need surfaces, or work around
it inline and accumulate drift between the actual design and the
system meant to govern it. Both are corrosive.

Reentrancy concretely means:
- A Phase 1 session that needs a new typography token can add
  the token there; it propagates to Phase 2's Kirby select
  fields and to any textBlock referencing it.
- A Phase 2 session that wants a new rectangle on a page
  already being animated can add it; Phase 1 sees the new
  inherited block on next open (or live if loaded).
- A new `htmlKey` slot invented in either phase becomes
  immediately referenceable from both.
- Removing a shared artifact (token / rectangle / slot)
  triggers a usage check — warning, not block; author decides.

Implications:
- **Storage**: each shared artifact lives in one canonical place;
  both phases write to it; no copies.
- **Editing surface**: cross-phase jumps are first-class (an
  "edit this token" affordance in Phase 1 hops to the token
  editor, edits, returns — no hard modal lock).
- **Warnings**: the warning system already planned for layout
  overlap extends to artifact lifecycle ("token X removed, used
  by 3 textBlocks"; "rectangle Y deleted, Phase 1 has objects
  placed inside it").

**The shared-artifact list (Phase 2 owns the schemas; Phase 1
inherits and consumes; both can write).** Three artifacts so far,
likely to grow:

1. **Page-planning rectangles** — content holders authored on
   the Phase 2 canvas, surfaced in Phase 1 as nested blocks
   within the page-area outline. Pin the spatial structure of
   real content; Phase 1 places animation around/within them.
2. **`htmlKey` slot conventions** — the spatial bridge between
   Kirby HTML and Deco regions. Each slot has a key; Kirby
   templates reference the key; runtime fills with inert HTML
   or a live Deco mount.
3. **Typography token / style set** — `heading-xl`, `heading-l`,
   `lead`, `body`, `eyebrow`, `caption`, … Each token defines
   family / size / weight / line-height / letter-spacing /
   color. **Tight integration**: both Kirby select fields and
   Deco's content-carrying textBlocks (those bound to an
   `htmlKey`) pick from this list. Purely decorative text in
   Deco (over-titles, kinetic display effects) may remain
   free-form; content textBlocks must use a token. One JSON
   file, read by both layers (Kirby CSS generation, Deco
   runtime).

Likely future additions to the shared-artifact list: color
tokens, spacing scale, image-treatment rules, breakpoint
definitions. Worth keeping the list explicit so it grows
coherently rather than as ad-hoc accretion.

This three-artifact (and growing) set is the concrete shape of
"Phase 2 is upstream of Phase 1" — not a vague architectural
claim but a specific list of JSON files Phase 2 owns and Phase 1
reads, all reentrantly editable from either side.

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

### Parked: PHP shell-out for ops affordances (L-side only)

Floated during the S4b sync work, **parked, not building now** — but
worth doing before any wrap-up of the sync layer so the reasoning isn't
lost.

The capability is real: PHP can shell out (`exec`, `shell_exec`,
`system`, `passthru`, `proc_open`, `popen`), so a Deco/Kirby route can
launch shell scripts. That would unlock git operations, deploys,
invoking `deploy/propagate.sh` from a button, image/video tooling
(ImageMagick/ffmpeg), etc.

**Why the sync transport deliberately does NOT shell out:** the
propagate path uses `PharData` + `curl`, both native PHP, zero shell.
That's portable to locked-down shared hosts (Infomaniak often *disables*
`exec()`) and carries no shell/SSH dependency on the public servers.
`deploy/propagate.sh` (shell + SSH + rsync) exists only as the **L-driven
CLI fallback**, never as something A/B run on a request.

**The boundary.** Shell-out is fine on **L** (local Mac, single-user,
behind the user's login). It is a remote-code-execution surface on **A
and B** (public servers): any untrusted input reaching the shell =
command injection, and a leaked secret stops being "can overwrite
content" and becomes "can run arbitrary commands." So: shell-out lives
on L only, ideally for L-only ops, never on the request path A/B serve.
If ever used, never interpolate input into a shell string — use
`proc_open` with an argument **array** (no shell parsing) or
`escapeshellarg`.

**The genuine tension the user raised (record this — it's the crux).**
For **dev**, a terminal is no problem: the work is continuous, the
commands are in muscle memory. For **production**, activity is sporadic
(not every day, not all-day), so *human memory of the right CLI
incantation is unreliable* — which is exactly the case where an in-app
button would help most. That argues *for* an affordance on production…
but production is also where shell-out is most dangerous. The
resolution already in hand: **the S4b.4 HTTP "Push → A" button solves
the production-memory problem WITHOUT shell-out** — native PHP
(`PharData`+`curl`), no shell, safe on a public host, and there's a
button so nothing has to be remembered. So the production memory concern
is already addressed by the safe path; shell-out remains a pure L-side
convenience (e.g. wiring `propagate.sh`, `git`, or a deploy to an L-only
editor button) with no reason to ever cross onto A/B.

If revisited: build an L-only "ops" affordance gated on `role === 'L'`
(same gate the peer indicator uses), shelling out only to vetted local
scripts with arg arrays — and stop there.

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

### No undo in the page editor (known gap, v0.10.102)

The Phase 2 page editor (`/dev/page`, `dev-page.js`) has **no undo/redo**.
Destructive verbs — delete rect, and any state mutation (move/resize/text
edit/mark apply) — cannot be reverted; the only recourse is to re-do the edit
by hand or reload before saving (reload discards unsaved in-memory state).
User flagged this as "not urgent but obviously necessary" (delete-then-undo).
It is a SUBSTANTIAL feature, not a quick fix — it needs its own slice. Likely
shape: a bounded undo stack of state snapshots (or inverse-ops) keyed to the
mutation points that already call `markDirty()` (`addRect`, delete,
geometry commits, `setRectText`, the mark-engine ops `applyMark`/`setMark`,
image binding). Snapshot-of-`state.rects` is simplest and robust given the
data is small; ⌘Z / ⌘⇧Z bindings + a stack depth cap. Defer until it's
scheduled — do NOT fold it into an unrelated slice.

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
- **A single-process `php -S` dev server self-deadlocks on a
  self-referential request.** The sync push trigger (`POST /sync/push/A`,
  S4b.3) runs ON L and then makes an OUTBOUND HTTP call to the peer. If
  the peer URL is pointed at the *same* dev server (e.g. localhost
  loopback testing), that inbound request can never be served — the
  single PHP worker is still busy handling the push — so it hangs until
  the curl timeout (observed: a 120s stall, mistaken at first for a code
  bug). In production L and A are distinct hosts so this never happens.
  **To loopback-test the push, drive it from a SEPARATE process** (a
  `php -r` CLI script that bootstraps Kirby and calls
  `sync_propagate_to_peer()`), so the dev server is free to handle the
  inbound `/sync/propagate`. A dry-run (`?dryRun=1`) is the safe form —
  no snapshot, no swap. See the S4b.3 commit (v0.10.205).
- **`php -S` picks up PHP changes per-request, but the BROWSER DOM is
  stale until you reload.** Editing a `.php` template/snippet/route takes
  effect on the next *server* request with no rebuild — but a page
  already open in the preview keeps its old DOM (and old inline JS/CSS)
  until `location.reload()`. Symptom: a freshly-added element "isn't
  there" via `preview_eval` even though the source is correct (this bit
  the S4b.4 "Push → A" button check — the snippet's older peer-pill was
  present, the new button wasn't, purely because the tab predated the
  edit). Reload before concluding a PHP-side change didn't render. (JS/CSS
  asset files likewise need a reload — there's no HMR here.)
- **iCloud conflict-copy dirs (`dev 2`, `home 2`, …) can appear under
  `content/`.** The project lives in iCloud Drive; a sync conflict
  spawns a `<name> 2` duplicate. The propagation excludes
  (`sync_propagate_excluded_top` = `dev`, `error`) are **literal-match**,
  so `dev 2`/`home 2` are NOT excluded and a live L→A push *would* carry
  a non-empty conflict copy to A as a bogus page. They're usually empty
  (only `.DS_Store`, which is dropped), so the round-trip silently
  discards them — but keep `content/` free of `* 2` artifacts before a
  real push, or teach the excludes to skip the conflict-copy pattern.

## Vocabulary

**Lines** : initially all the graphical objects were lines and this 
designation was always used. 
Later geometric primitives were added and user often uses the 
designation **objects** which is more general and appropriate.
The meaning of both is the same: the word addresses the elementary
graphical items referenced in masters.json and instances.json,
which are the holders of behavior blocks.  
