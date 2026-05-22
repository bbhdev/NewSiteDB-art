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
