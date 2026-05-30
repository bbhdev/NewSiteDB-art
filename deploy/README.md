# Deploying local → server

Source of truth is your Mac. The server is a publish target. Deployment is
a one-command **rsync mirror** of the project tree, with a protective
exclude list so the server's own runtime state is never touched.

## Why rsync (and not git)

The actual artwork data lives in `content/**.json`, which is **gitignored**
by design (see the project `.gitignore` — it keeps pulls from colliding with
locally-saved drawings). A git-based deploy would therefore ship the *code*
but **not the drawings**. rsync moves the real on-disk files regardless of
git, in a single delta transfer, and can mirror deletions — so it's both
simpler and more complete here than git-pull-on-server or a CI pipeline.

## One-time setup

1. Set up key-based SSH to the server (recommended: a `Host` alias in
   `~/.ssh/config` so no passwords are needed).
2. Copy the env template and fill in your host + path:
   ```sh
   cp deploy/deploy.env.example deploy/deploy.env
   $EDITOR deploy/deploy.env      # set REMOTE_HOST and REMOTE_PATH
   ```
   `deploy/deploy.env` is gitignored.

## Deploy

```sh
deploy/deploy.sh                     # dry run → shows changes → asks → transfers
deploy/deploy.sh -y                  # skip the confirmation prompt
deploy/deploy.sh --no-delete         # upload/update only, never delete on server
deploy/deploy.sh --skip-icloud-check # bypass the iCloud pre-check (not recommended)
```

The script **always dry-runs first** and prints an itemized list of every
file it would add/update/delete, then waits for your `y`. Nothing changes on
the server until you confirm.

## iCloud-placeholder pre-check (macOS / iCloud Drive)

This project lives in iCloud Drive. With **Optimize Mac Storage** on, macOS
can evict files to dataless placeholder stubs (zero physical bytes, full
logical size). rsync then either stalls forcing a download or silently
skips them — either way the deploy is unreliable.

Before each run, `deploy.sh` scans the project tree with BSD
`find -flags +dataless` and aborts if any placeholders are found, listing
up to 20 of them with remediation instructions:

- Finder → right-click the project folder → **Download Now**.
- Or from the CLI: `find <root> -type f -flags +dataless -exec brctl download {} \;`
- Or turn **Optimize Mac Storage** off for this Mac in System Settings →
  Apple Account → iCloud → iCloud Drive (recommended if you deploy from
  here regularly).

Bypass with `--skip-icloud-check` only if you're certain (e.g. you've just
manually materialized the tree and the placeholder scan is slow on a large
project). Server-owned and excluded paths (`.git`, `library/`, `deploy/`,
`site/{accounts,sessions,cache}`, `media/`) are skipped by the scan, so
those don't produce false positives.

## What gets excluded (and why)

See `deploy/deploy-exclude.txt`. Summary:

- **Server-owned runtime state — never pushed or deleted:**
  `site/accounts/` (Panel logins), `site/sessions/`, `site/cache/`,
  `media/` (Kirby regenerates thumbnails on demand). Because they're
  *excluded*, the `--delete` mirror leaves them intact.
- **VCS / OS junk:** `.git/`, `.gitignore`, `.DS_Store`, `Thumbs.db`.
- **Local-only:** `library/` (snapshot backups), `scripts/`
  (`migrate-content.php` — run migrations locally, then push the migrated
  content), `deploy/` itself, `zoom*.html` scratch files.
- **Design-journal docs / spreadsheets:** `HANDOFF.md`, `NOTES.md`,
  `CLAUDE.md`, the `*-hierarchy.*` and `deco-inventory.*` files.
- **Host-scoped config overrides:** `config.<host>.php` (see below).

## About `config.php`

`site/config/config.php` is **synced** (it is *not* excluded). Today it is
environment-agnostic — it only reads `VERSION`/`SCHEMA_VERSION` and defines
the `/dev/draw` routes — so the same file is correct on both sides. Keeping
it synced means route/logic changes reach the server automatically.

If you ever need settings that must differ per environment (e.g. `debug`,
`url`, SMTP credentials, or a production editor gate — see Security below),
**don't fork `config.php`**. Kirby natively loads an optional
`site/config/config.<SERVER_NAME>.php` and merges it *over* `config.php`.
Put environment-specific values there; the exclude list keeps that file
environment-local (never pushed, never deleted).

## ⚠️ Security — the editor is currently ungated

The `/dev/draw` editor and its write routes (`dev/draw/save`,
`dev/draw/library/{save,load}`, `dev/draw/font-bundle` POST) have **no
authentication gate** in the code today. Locally that's fine; on a public
server it means anyone who finds the URL can overwrite your content or load
snapshots. Before (or right after) the first production deploy, gate it.
Options, cheapest first:

- **Web-server auth** on the `/dev` path (HTTP Basic via `.htaccess`/nginx),
  or block `/dev` entirely at the server and only open it when editing.
- **Kirby-level gate**: in a host-scoped `config.<SERVER_NAME>.php`, add a
  route guard (or a flag the routes check) that returns 403 for
  `dev/draw/*` unless a Panel user is logged in. This keeps the gate
  environment-local and out of the shared `config.php`.

This is independent of the deploy mechanism, but it's the main risk the
first deploy exposes, so it's flagged here.

## Notes & gotchas

- **First deploy to a fresh server:** the excluded `site/{accounts,cache,
  sessions}` and `media/` dirs aren't shipped; Kirby creates them at
  runtime. Ensure the web root is writable by the server user.
- **Permissions:** the script passes `--no-owner --no-group` (shared hosts
  usually forbid chown-by-id). If the deploy user owns the tree and you want
  exact perms, remove those flags in `deploy.sh`.
- **PHP version / extensions:** rsync only moves files; make sure the server
  PHP version satisfies `composer.json`'s Kirby requirement.
- **Rollback:** rsync isn't versioned. Take a Snapshot (editor → Project →
  Snapshots) before a big content change, and/or keep a timestamped
  `cp -al` backup of the server tree if you want instant rollback.
