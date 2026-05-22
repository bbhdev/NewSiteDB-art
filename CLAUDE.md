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

## SCHEMA_VERSION bump protocol

`SCHEMA_VERSION` (root) is bumped by Claude, not the user — but only with
explicit per-bump authorization. The user is not best equipped to detect when
a data-structure change is backwards-incompatible; Claude is.

1. **When making any data structure change**, evaluate whether it is
   backwards-incompatible. The bar: older snapshot JSON, loaded by the new
   code, would fail to parse, silently lose data, or produce wrong runtime
   behavior. Additive changes (new optional field with a safe default) do
   NOT require a bump; renames, removals, type changes, or semantic
   redefinitions DO.

2. **If a bump is needed**, propose it to the user with:
   - description of the structural change
   - why it's not backwards-compatible
   - whether a migration in `scripts/migrate-content.php` is needed

3. **If a migration is needed**, list the names of the snapshots in
   `library/` that would need migrating, and ask the user to choose per
   snapshot (or in bulk):
   - **delete** the snapshot (it becomes unloadable under the new schema), or
   - **migrate** it — in which case Claude writes the migration code in
     `scripts/migrate-content.php` and runs it.

4. **Only after user authorization** does Claude bump `SCHEMA_VERSION` and
   apply any migration.
