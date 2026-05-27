# Project-level instructions

## Read this on session start

Read `HANDOFF.md` at the repo root before doing substantive work. It's a
project-specific briefing covering the architecture, recent decisions,
known limitations, diagnostic tools, and per-block runtime semantics that
aren't all obvious from the code.

`project-hierarchy.csv` at the repo root maps every file/dir to its role.

## Behavioral rule

When acting on an assumption that's BOTH (a) central to the current subject
AND (b) has strong consequences if wrong — pause and confirm before proceeding.
The bar: "if this assumption is wrong, the next several minutes go in the
wrong direction and have to be backed out." Not every assumption — only the
high-leverage ones.

## Workflow

- The user works on a Mac. They edit code via the Claude desktop app's
  local-directory mode (when set up). This session may be cloud-hosted (git
  push/pull) or local; ask if uncertain.
- Content data (`content/*.json`) is gitignored by design. If you need to
  inspect actual user data, ask them to share specific files.
- Commit messages are the design journal — write them detailed enough that a
  future Claude reading them can understand the why, not just the what.
- **Commit vs push are separate.** Commit every update locally (cheap, full
  design journal, safe recovery). Push only when a coherent functional unit
  has been validated by the user. Batching commits to reduce effort is a
  false economy — local commits are essentially free.

## Progressive disclosure — UI rule

Optional features that aren't always used must be hidden by default and
opened on demand. Don't surface a fixed block of fields for a property
most objects won't carry — it bloats the panel and signals "this is
required" when it isn't.

Reference pattern: the "Also control other objects" section inside a
behavior block (`ed-behavior-also-btn` opens, `ed-behavior-also-close`
[×] removes the section and clears any saved values).

Two states:

1. **Empty / closed** — show a single `+ <Feature>` button that opens
   the section. No fields visible.

2. **Open** — title row with a [×] close affordance + the feature's
   fields. Close discards the feature: clears the underlying values
   AND removes the session-disclosure flag so the section stays hidden
   on the next render. This makes the close button safe to undo a
   mistake (vs. the user being stuck with empty fields they can't get
   rid of).

Auto-open rule: if the underlying values are already populated
(loaded from disk or a prior session), the section opens automatically
on render — the user never sees data they can't see the UI for.

Session-only disclosure state lives in a `Set` of identifiers (block
id, line id, master id, whatever's stable) keyed at the right scope.
Don't persist it — re-deriving "is anything set?" from the data is the
source of truth on next load.

This rule applies to every property with this shape: optional, sparse
across the dataset, multi-field. Examples: text overlay on objects,
side-effects on behavior blocks. New properties added later should
follow the same pattern unless every object reliably uses them.

## Schema versioning — two-tier model

There are **two separate schema version axes**; do not confuse them:

### Axis 1 — `CONTENT_SCHEMA_VERSION` (in `scripts/migrate-content.php`)

Versions the **per-page content shape** — the structure inside each
`content/<page>/page.json` (groups, lines, behaviors, master refs, etc.).
Each page.json carries a `_schemaVersion` marker; the migrate runner walks
the chain of v(N) → v(N+1) callables and stamps the marker as it goes.

Bumped on **every breaking content-shape change**: field rename, removal,
type change, semantic redefinition. Additive changes (new optional field
with a safe default) do NOT require a bump.

This is the axis that bumps frequently — currently at v10, and most data-
shape work in this project moves it forward.

### Axis 2 — `SCHEMA_VERSION` file at repo root

Versions the **library / snapshot envelope** — the `meta.json` under
`library/<name>/` and the snapshot loader gate in `site/config/config.php`
(refuses to load a snapshot whose envelope schema doesn't match). Currently
at **1**; bumped only when the *container shape* (not the inner content
shape) changes. Rare.

### Bump protocol — applies to either axis

Both axes are bumped by Claude, not the user, and only with explicit
per-bump authorization. The user is not best equipped to detect when a
data-structure change is backwards-incompatible; Claude is.

1. **When making any data structure change**, evaluate whether it is
   backwards-incompatible. The bar: older JSON, loaded by the new code,
   would fail to parse, silently lose data, or produce wrong runtime
   behavior. Decide WHICH axis is affected:
   - inner content shape → `CONTENT_SCHEMA_VERSION`
   - snapshot envelope / loader contract → `SCHEMA_VERSION`

2. **If a bump is needed**, propose it to the user with:
   - which axis is bumping (and from / to what)
   - description of the structural change
   - why it's not backwards-compatible
   - whether a migration in `scripts/migrate-content.php` is needed
     (content-axis bumps almost always need one; envelope-axis bumps may
     need separate library-side handling)

3. **If a content migration is needed**, list the snapshots in `library/`
   that would need migrating, plus the live `content/`, and ask the user
   to choose per snapshot (or in bulk):
   - **delete** the snapshot (it becomes unloadable under the new schema), or
   - **migrate** it — in which case Claude adds the v(N)→v(N+1) callable
     in `scripts/migrate-content.php` and runs it.

4. **Only after user authorization** does Claude bump the chosen version
   constant and apply any migration.
