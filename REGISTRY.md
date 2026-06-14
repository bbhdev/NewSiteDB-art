# 📐 Work Registry — NewSiteDB-art

> **This file IS the canonical work registry** (band table + numbering convention
> + Rosetta + the live status list). Single source of truth — do NOT keep a second
> copy of the list anywhere else.
>
> **Split contract (Model B, 2026-06-14):** the *compact registry* lives HERE; the
> *deep per-item rationale* (decisions, gotchas, the "why") lives in `HANDOFF.md`,
> keyed by the same canonical ID. The ID is the join. HANDOFF prose may mention a
> status in passing but is never the authority for it — this file is.
>
> Read BOTH this file and `HANDOFF.md` at session start.
>
> **Frontier beacon:** `v0.11.7` · 2026-06-14 · branch `main` (the home/rendezvous branch).
> Update this line whenever the registry's authoritative branch or version advances —
> it is the cross-device staleness tripwire (see Multi-device protocol below).

---

## 🔀 Multi-device protocol (why this matters — read on any device switch)

**Root cause of cross-device divergence: branch-per-session.** Each Claude Code
cloud/web session works on its OWN auto-created `claude/<session-slug>` branch.
Two sessions = two branches, even for the "same" project. On 2026-06-14 an iPad
session (`…sync-convergence-gxliye`) and this Mac session
(`…moving-lines-animation-jvDgl`) **both forked from yesterday's tip** (`659022f`)
and never shared a branch. The iPad rebuilt a REGISTRY.md from the yesterday base,
structurally blind to the 4–5 commits already on the other branch that same
afternoon. The staleness was guaranteed by branch isolation — not merely by a
stale verbal reference. **You did not fork git; the harness did, per session.**

**The discipline that actually prevents it:**

0. **`main` is the home/rendezvous branch (since 2026-06-14).** Every device and
   every session works on `main` — branch off it for risky work, merge back
   promptly. A cloud session left alone SPAWNS its own `claude/<slug>` branch, so
   on the iPad the explicit first instruction must be: *"checkout `main`, pull,
   read REGISTRY + HANDOFF."* (This replaced the disposable session-slug branch
   `…moving-lines-animation-jvDgl`, renamed to `main`.)
1. **One home branch for registry/planning edits** — `main`. Don't let two device
   sessions each grow their own registry; they cannot both be true.
2. **Fetch-first on every device switch.** A new device session's FIRST move:
   `git fetch --all && git checkout main && git pull`. The session's "memory" of
   where things were is NOT authority; origin is.

**Mac → iPad handoff (the only safe path — git is the sole bridge; the Mac is not
a server, but `origin` is one both devices reach):**
- *Leaving the Mac:* promote anything that must travel into `REGISTRY.md` /
  `HANDOFF.md` (memory files under `~/.claude` and uncommitted edits do NOT cross —
  WIP-commit them), then `git push` on `main`. The push IS the handoff.
- *On the iPad:* checkout `main`, pull, read the two docs, confirm the frontier
  beacon matches. *Returning to the Mac:* `git pull` on `main` BEFORE resuming.
3. **Frontier beacon is the tripwire.** The beacon line above is git-tracked, so
   it travels with the file. If a device opens a REGISTRY.md whose beacon names an
   older date/version/branch than `origin` has, it is stale — stop and pull/rebase
   onto the home branch before editing.
4. **Memory files are NOT a reliable cross-device channel** — they live under
   `~/.claude` (per-machine), so a beacon kept only in memory may never reach
   another device. The authoritative beacon is THIS git-tracked line.
5. **Converge session branches promptly.** Treat `claude/*` branches as ephemeral:
   merge/rebase the keep-worthy work onto the home branch and let the rest die,
   so "latest" has one address.

## 🧭 Numbering convention (single coherent scheme, v0.10.242; hundreds-tier amendment 2026-06-14)

**Why this exists:** the project had drifted into THREE incompatible work-item
naming systems at once — sync "S4/S5", convergence "Slice 7/8", and tasks
"#36/#37" — so one piece of work often had two or three addresses and references
used different ones. That is how the way got lost (and how a diagnosis got
misframed). This scheme replaces all of them with ONE addressing axis.

**The rules:**

1. **One canonical ID per work item — a spaced integer.** The thousands "band"
   = the epic. Below the band the remaining digits form a **tier hierarchy**:
   **hundreds = major subtask, tens = sub-subtask, units = a tightly-linked +1
   follow-up.** So `6120` reads "epic 6000 › major subtask 6100 › sub-subtask
   6120". This ID is what you cite **everywhere** — chat, commits, memory, the docs.
2. **Epic = a `[tag]`, never a number.** The tag (and the band digit) carry
   grouping; they are not addresses. Bands past 9000 are 5-digit — the tag still
   identifies the epic.
3. **Spacing & insertion — claim the WIDEST free tier (use the hundreds).** A
   NEW major subtask takes a **hundreds** slot (`6100`, `6200`, `6300`) — this
   reserves the 99 IDs beneath it for its own children, so it can grow a deep
   sub-tree without colliding. Its children take **tens** (`6110`, `6120`);
   tightly-linked grandchildren take **+1** (`6111`, `6112`). Do NOT spend a bare
   tens slot (`6040`) on something that will sprout sub-subtasks — its children
   would have nowhere to live. (This amends the original "×10 off the band"
   habit, which wasted the entire hundreds digit — a loss of addressing domain.)
   A genuinely small, childless item may still take a tens slot directly off the
   band. **Grandfathered:** the existing tens-off-band items (`6010/6020`,
   `2040/2041/2042`, etc.) keep their IDs unchanged — the hundreds tier is
   forward-looking only, not a retroactive renumber. (Exception by choice: an
   UNSTARTED tens item later judged major MAY be promoted to a hundreds slot —
   `6030`→`6500` was done 2026-06-14 — but this is a deliberate per-item call,
   not a sweep.)
4. **Genuine deep subdivision → dotted decimals:** when the integer tiers are
   exhausted, go dotted — `6121.1`, `6121.2`, then `6121.2.a`, `6121.2.b`. A
   child never renumbers its parent; the parent closes only when its children do.
5. **The TaskList tool's own `#N` is ignorable noise.** The tool stamps its own
   sequential id and can't emit `2041`, so the canonical ID **leads the task
   subject**. Read the `2041 [sync] …`, ignore the `#N` prefix the tool shows.
6. **Legacy names (S1–S9, Slice 1–8, 4g-1–6, 3a/3b) are FROZEN** — never
   extended. The Rosetta below keeps old commits/docs/memory legible. **No new
   work is ever named "Slice/step/part" — every item is a canonical integer.**

## Bands

| Band | `[tag]` | Subject |
|---|---|---|
| 1000 | `[deploy]` | deploy pipeline / targets / host config |
| 2000 | `[sync]` | L↔A↔B propagate layer (push/pull/publish, freeze, snapshots) |
| 3000 | `[conv]` | editor convergence (draw+page → one /dev/editor) |
| 4000 | `[workshop]` | image workshop |
| 5000 | `[dirty]` | unified dirty/save signal (derived, approach B) |
| 6000 | `[editor]` | the editor itself — a core pillar (interaction, dialogs, modes) |
| 7000 | `[i18n]` | bilingual / multilingual sites — content model + editor + runtime |
| 8000 | `[backgrounds]` | site backgrounds — processing + editor + runtime |
| 9000 | `[ui]` | cross-cutting UI / design system — flows down to tablet + phone |
| 10000 | `[tablet]` | iPad first-class editing layer (standing constraint) |
| 11000 | `[phone]` | smartphone demo mode (reduced from tablet) |
| 12000 | `[bedit]` | safe fallback editing on B (cross-links 2080) |
| 13000 | `[behaviors]` | new behavior-type ideas (backlog) |
| 20000 | `[cleanup]` | maintenance / cache pruning / tech-debt — runs last, at project end |

## Rosetta — legacy → canonical (frozen, do not extend)

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
| media cleanup (#39) | 20010 |

> NOTE: sync's canonical order (S5→S6→S7→S8→S9 = 2050→2090) fixes a tracker
> wart — S8/S9 were *filed* before S6/S7, so creation-order lied about sequence.
> The spaced IDs encode true sequence regardless of when each was filed.

---

## Status by epic  · ✅ done · ◐ partial / in-progress · ▶ not started · ⟶ reclassified

Deep rationale for any item → `HANDOFF.md`, under the same ID.

### `1000 [deploy]`
- **1010–1040** ✅ named targets · host config · excludes/bootstrap · first mirror *(B mirror within 1040 still pending)*

### `2000 [sync]`
- **2010** ✅ node id · **2020** ✅ activity/handshake · **2030** ✅ per-page `_sync` stamps + diff manifest
- **2040** ✅ secret sidecar · **2041** ✅ L→A push · **2042** ✅ A→L pull
- **2050** ✅ direction-detection UI (ahead/behind + nuclear modal)
- **2060** ◐ publish A→B — transport validated (dry-run); real non-dry publish still pending. Publish→B button now carries the two-tier amber glow (dirty=light, saved-since-publish=full), session-scoped — ✅ live-validated on A (v0.11.8)
- **2061** ▶ robust Publish→B glow — real A-vs-B compare that survives reload (needs a server publish-stamp + a cheap A-vs-B read; 2060's glow is a session signal only)
- **2070** ✅ snapshot retention (auto-retention + display folder) — *live UI check pending*
- **2080** ✅ B-freeze + unlock + B→A back-prop (all slices) — *awaiting live validation*
- **2090** ✅ "Published: \<date>" snippet — *awaiting live validation*
- **2095** ✅ holistic ahead/behind protocol audit — *awaiting live validation*
- **2100** ▶ snapshot names overly restricted — relax the constraint

### `3000 [conv]`
- **3010–3012** ✅ editor route · mode toggle · redirects
- **3020** ✅ drop deco-mount · **3030** ✅ Styles mode · **3040** ✅ Images mode (workshop folded in)
- **3050** ✅ data-aligned saves · **3060** ✅ consolidated `dev-editor.js` · **3065** ✅ fold Styles into the unified save
- **3070** ⟶ reclassified → **9020**
- **3080** ▶ library propagation · **3090** ▶ "All" mode

### `4000 [workshop]`
- **4010 / 4011 / 4020 / 4030 / 4050 / 4060** ✅ all landed

### `5000 [dirty]` — ✅ **EPIC COMPLETE**
- **5010** lines (B) · **5020** layout (B) · **5030** styles · **5040** images

### `6000 [editor]`
- **6010** ▶ dialog key-defaults + JS-vs-Panel consistency *(deferred)*
- **6020** snippet rect-block placement primitive
  - **6021** ✅ snippet kind wired end-to-end + runtime validated (v0.11.7)
  - **6022** ▶ per-snippet parameter authoring *(next)*
  - **6023** ▶ polish (canvas preview, picker descriptions, placeable-vs-structural enforcement)
- **6040** ▶ layout image rect Change→upload bypasses workshop resize (loads full original)
- **6050** ▶ "get from workshop" shows dimensions but not byte size
- **6060** ▶ Kirby-created pages lack the 3 screen classes
- **6070** ▶ Lines reload jumps scroll to mid-page, loses work position
- **6080** ▶ typography weight/size ranges too narrow
- **6090** ▶ draw fill option lost/unclear (`freehandClosed` renders filled, no toggle)
- **6100** ▶ **(major)** global "Site" settings mode — move canvas dims out of Lines + audit · children: 6110 create mode · 6120 move canvas dims · 6130 audit + migrate
- **6200** ▶ **(major)** drill-down becomes a property of ALL rect-blocks (retire the kind)
- **6300** ▶ **(major)** zoom & Lines↔Layout parity — layout zoom + clamp ≥1% + audit · children: 6310 layout zoom · 6320 zoom range ≥1% · 6330 parity audit
- **6400** ▶ rotate the base object after freehand draw (2-phase origin→rotate affordance)
- **6500** ▶ **(major)** Lines↔Layout capability convergence — Lines' text/image gain Layout's styles + image resize *(was 6030)* · children: 6510 text styles into Lines text · 6520 image fit/focus/resize into Lines image

### `7000 [i18n]`
- **7000** ▶ **(BIG)** bilingual/multilingual sites — UI switch = easy snippet; infrastructure (multilingual text representation + content model + editor + runtime + propagate) needs decisions first · **7010** decision/spike first

### `8000 [backgrounds]`
- **8010** ▶ not started

### `9000 [ui]`
- **9010** ▶ general editor-UI refinement *(one nit resolved v0.10.267)*
- **9020** ▶ draw/library structure rework *(absorbs former 3070)*
- **9030** ▶ rename "Lines" mode → "Draw"
- **9040** ▶ icon audit/refresh
- **9050** ▶ layout-mode undo

### `10000 [tablet]` · `11000 [phone]` · `12000 [bedit]` · `13000 [behaviors]`
- **10010** ▶ iPad first-class editing layer · **11010** ▶ phone demo mode · **12010** ▶ safe fallback edit on B · **13010** ▶ behavior-type idea backlog

### `20000 [cleanup]` — runs LAST, at project end
- **20010** ▶ media/cache prune (low urgency)
- **20020** ▶ end-of-project cruft sweep
