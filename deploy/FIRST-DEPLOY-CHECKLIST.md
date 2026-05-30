# First-deploy checklist

A linear walkthrough of everything needed to take this project from
"local-only" to "live on a hosted server" for the very first time.
Subsequent deploys are just step 7 — run `deploy/deploy.sh`.

Read [`deploy/README.md`](README.md) for the *why* behind each piece;
this file is the *what you do, in order*.

---

## 0 · Prerequisites on the server

You need these BEFORE running anything from your Mac.

- [ ] **SSH access** to the server with a username that can write to the
      web root.
- [ ] **rsync installed on the server.** Almost universal on Linux
      hosting; check with `ssh <host> rsync --version`.
- [ ] **PHP version** that Kirby 5.x supports (check `composer.json` for
      the exact constraint — currently `getkirby/cms ^5.2`, which needs
      PHP 8.2+). `ssh <host> php -v`.
- [ ] **A web root path** ready to receive the site (e.g.
      `/var/www/bondard.net`). The web server (Apache or nginx) should
      already be pointed at it — set up the vhost / server block before
      deploying, not after.

> **Heads-up.** The deploy script doesn't install PHP, configure the web
> server, or create the vhost. Those are server-admin steps. If you
> haven't done them, do them first — then come back here.

---

## 1 · SSH key-based access (one-time, on the Mac)

Eliminates password prompts and is required for the deploy script to
run cleanly.

- [ ] Generate an SSH key if you don't already have one:
      ```sh
      ls ~/.ssh/id_ed25519     # exists? skip the next line
      ssh-keygen -t ed25519 -C "your-email@example.com"
      ```

- [ ] Copy the public key to the server:
      ```sh
      ssh-copy-id user@your-server.example
      ```
      Or manually append `~/.ssh/id_ed25519.pub` to
      `~/.ssh/authorized_keys` on the server.

- [ ] Add a host alias to `~/.ssh/config` so commands stay short:
      ```
      Host bondard
        HostName bondard.net
        User youruser
        IdentityFile ~/.ssh/id_ed25519
      ```

- [ ] Test it:
      ```sh
      ssh bondard "hostname -f && pwd"
      ```
      Should print the server's hostname and your remote home, with no
      password prompt.

---

## 2 · Configure `deploy.env` (one-time, on the Mac)

- [ ] Copy the template:
      ```sh
      cp deploy/deploy.env.example deploy/deploy.env
      ```

- [ ] Edit `deploy/deploy.env`:
      ```sh
      REMOTE_HOST="bondard"            # your ~/.ssh/config alias
      REMOTE_PATH="/var/www/bondard.net"
      ```

- [ ] Confirm it's gitignored (it should already be — added in `.gitignore`):
      ```sh
      git status -- deploy/deploy.env   # → nothing listed
      ```

---

## 3 · Install the `/dev/draw` auth gate (one-time, on the server)

Without this step, the editor and all its write routes are publicly
accessible on the server. The deploy excludes match `config.*.php`, so
this file is never pushed by rsync — you copy it once, manually.

- [ ] SCP the template up:
      ```sh
      scp site/config/config.example-host.php \
          bondard:/var/www/bondard.net/site/config/
      ```

- [ ] Find the server's real hostname:
      ```sh
      ssh bondard "hostname -f"
      # e.g. "bondard.net"  or  "www.bondard.net"
      ```

      > Some hosts return short names (`web01`) instead of the public
      > domain. Use whatever Kirby will see as `$_SERVER['SERVER_NAME']`
      > at request time, not necessarily what `hostname -f` returns.
      > If unsure, see step 6: the verification step will tell you if
      > the rename matched.

- [ ] Rename on the server:
      ```sh
      ssh bondard "cd /var/www/bondard.net/site/config && \
        mv config.example-host.php config.<hostname-from-above>.php"
      ```

---

## 4 · Create a Kirby Panel user (one-time, on the server)

The gate from step 3 lets in any logged-in Panel user. You need at least
one.

- [ ] Visit `https://your-server.example/panel` in a browser.
- [ ] Kirby walks you through creating an admin user on first visit.
      Use a strong password — this is your editor login.
- [ ] Stay logged in for the verification step below.

---

## 5 · Materialize the project tree (every deploy, on the Mac)

This project lives in iCloud Drive. If any files are dataless
placeholder stubs, rsync will stall or silently skip them. `deploy.sh`
checks for this automatically and refuses to run if it finds any, but
it's faster to fix proactively.

- [ ] In Finder, right-click the project folder → **Download Now**.
- [ ] Wait for any cloud-download icons (the little cloud-with-arrow
      glyph) to disappear from the file list.
- [ ] For a project you deploy from regularly, consider:
      *System Settings → Apple Account → iCloud → iCloud Drive →
      turn OFF "Optimize Mac Storage" for this Mac.*

---

## 6 · First deploy (on the Mac)

- [ ] From the project root:
      ```sh
      deploy/deploy.sh
      ```

- [ ] **The script will:**
      1. Run the iCloud-placeholder pre-check (should pass after step 5).
      2. Run `rsync --dry-run` and print an itemized list of every file
         it *would* add/update/delete.
      3. Ask `Proceed with the REAL transfer shown above? [y/N]`.

- [ ] **Review the dry-run output carefully** the first time. Look for:
      - Anything in `site/accounts/` being uploaded → BAD (would clobber
        server-side users). Should not happen — verify the exclude list.
      - The `content/` directory transferring → GOOD (your drawings).
      - Any large unexpected files → check what they are before
        proceeding.

- [ ] Type `y` to proceed. rsync transfers the delta.

- [ ] First-deploy quirks:
      - Kirby may take a moment on the first request to create
        `site/cache/` and `media/` dirs. Make sure the web root is
        writable by the server user.
      - If you see PHP errors on the homepage, check error logs first
        (`tail -f /var/log/apache2/error.log` or equivalent). The
        deploy moved files; it didn't change web-server config.

---

## 7 · Verify the auth gate

- [ ] **Logged in (Panel session active from step 4):** visit
      `https://your-server.example/dev/draw` — editor should load
      normally, exactly like localhost.

- [ ] **Logged out:** open a private/incognito window and visit the
      same URL. Expect a plain-text **403 Forbidden** page with the
      message:
      > Forbidden — /dev/draw requires a logged-in Kirby Panel user.
      > Log in at /panel and reload this page.

- [ ] If the logged-out test loads the editor → the gate is NOT
      active. Most likely cause: the renamed config file's hostname
      doesn't match `$_SERVER['SERVER_NAME']`. To diagnose, SSH in and
      temporarily add `error_log('host=' . $_SERVER['SERVER_NAME']);`
      to `config.php`, hit the page, check the PHP error log to see
      what hostname Kirby actually sees, then rename your config file
      to match.

- [ ] If you get a 500 Internal Server Error → likely a PHP syntax
      issue in `config.<hostname>.php`. SSH in,
      `php -l site/config/config.<hostname>.php` to confirm, fix the
      typo, retry.

---

## 8 · Routine deploys (every time after the first)

The whole flow collapses to:

```sh
# (Mac, before deploying) make sure iCloud tree is materialized
deploy/deploy.sh
# review dry-run → y → done
```

Optional flags:

- `deploy/deploy.sh -y` — skip the confirmation prompt (CI / scripted).
- `deploy/deploy.sh --no-delete` — upload/update only, never delete
  server files. Useful if you're nervous about a particular run.
- `deploy/deploy.sh --skip-icloud-check` — bypass the placeholder scan
  if you're certain the tree is materialized and the scan is slow.

## 9 · Backup discipline (recommended)

- [ ] **Before any large content change**, take a Snapshot in the
      editor (Project → Snapshots → Save). Snapshots are local-only;
      they're your rollback for content-shape mistakes.
- [ ] **Before any large code change**, commit locally. Commits are the
      design journal — write detailed messages.
- [ ] **For server-side rollback**, the deploy is unversioned. If you
      need instant rollback on the server, take a hardlink snapshot
      *before* deploying:
      ```sh
      ssh bondard "cp -al /var/www/bondard.net /var/www/bondard.net.pre-$(date +%Y%m%d-%H%M%S)"
      ```
      Costs almost no disk (hardlinks); restores by swapping symlinks
      or `rsync -a` back.

---

## Common pitfalls (kept short, expand in README if you hit one)

| Symptom | Likely cause | See |
|---|---|---|
| `✗ rsync not found in PATH` | rsync not installed on the Mac | `brew install rsync` |
| `✗ Missing exclude file` | Running from wrong directory | Run from project root |
| `✗ Found iCloud placeholder stubs` | Files not materialized | Step 5 |
| Dry-run shows no changes when changes exist | Wrong `REMOTE_PATH` or excludes too aggressive | Check `deploy/deploy.env` and `deploy/deploy-exclude.txt` |
| `/dev/draw` works logged-out on server | Hostname mismatch in config filename | Step 7 diagnostic |
| 500 errors after deploy | PHP version mismatch, missing extensions, or syntax in `config.<host>.php` | `php -l` on server, check error log |
| Panel login keeps redirecting back to login | `site/sessions/` not writable by server user | `chmod` on server |
