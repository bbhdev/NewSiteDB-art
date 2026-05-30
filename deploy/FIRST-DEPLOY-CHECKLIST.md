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
      `/home/clients/<account-hash>/sites/newsitedbart.bbh.fr` on
      Infomaniak shared hosting). The web server is already pointed at
      it via the Infomaniak Manager — set up there, not via the deploy.

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
      ssh-keygen -t ed25519 -C "newsitedbart@newsitedbart.bbh.fr"
      ```
      The `-C` comment is just a label for the key — it shows up in
      `~/.ssh/authorized_keys` on the server so you can later identify
      which Mac / which purpose a key belongs to. Use something
      descriptive (`project-name@hostname` is conventional).

- [ ] **When prompted for a passphrase: USE ONE.** Not empty.

      Why: a passphraseless key file = anyone who reads
      `~/.ssh/id_ed25519` (malware, a stolen Mac, a leaked backup) has
      immediate server access with no second factor. A passphrase
      makes the keyfile useless on its own. The macOS Keychain
      integration (next two steps) removes the daily friction reason
      people skip the passphrase in the first place — you'll type the
      passphrase **once**, ever (or once per reboot at most), not on
      every deploy.

      Choose something you can actually remember; store it in your
      password manager as a backup. If you lose it, you can always
      regenerate a new keypair and re-copy the public key to the
      server — but only if you still have server access via the old
      key, so don't lose both at the same time.

- [ ] Configure ssh-agent + Keychain integration. Add this block at the
      **top** of `~/.ssh/config` (create the file if it doesn't exist),
      *before* any `Host` blocks:
      ```
      Host *
        AddKeysToAgent yes
        UseKeychain yes
        IdentityFile ~/.ssh/id_ed25519
      ```
      - `AddKeysToAgent yes` — first `ssh` invocation that needs the
        key prompts for the passphrase once and hands the unlocked key
        to ssh-agent for the rest of the session.
      - `UseKeychain yes` — the macOS-specific setting that stores
        the passphrase in your login Keychain, so even after a reboot
        the key unlocks automatically when you log into your Mac
        account (Keychain is unlocked by your account password).
      - `IdentityFile` — tells ssh which keyfile to offer; explicit
        is better than relying on the default search order.

- [ ] Pre-load the key into the Keychain once now, so the first
      deploy doesn't prompt:
      ```sh
      ssh-add --apple-use-keychain ~/.ssh/id_ed25519
      ```
      You'll be asked for the passphrase one time. After this, it's
      stored in Keychain and ssh uses it transparently.

- [ ] Copy the public key to the server:
      ```sh
      ssh-copy-id 1m5eb_from_infomaniak@1m5eb.ftp.infomaniak.com
      ```
      This appends `~/.ssh/id_ed25519.pub` to
      `~/.ssh/authorized_keys` on the server. You'll be asked for the
      server password once during this step — that's the *Infomaniak
      SSH/SFTP account* password, not the SSH-key passphrase. After
      this, the server lets you in via the key.

      If `ssh-copy-id` isn't installed, the manual equivalent:
      ```sh
      cat ~/.ssh/id_ed25519.pub | ssh 1m5eb_from_infomaniak@1m5eb.ftp.infomaniak.com \
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
         cat >> ~/.ssh/authorized_keys && \
         chmod 600 ~/.ssh/authorized_keys"
      ```

- [ ] Add a host alias to `~/.ssh/config` (below the `Host *` block
      from earlier) so commands stay short:
      ```
      Host newsitedbart
        HostName 1m5eb.ftp.infomaniak.com
        User 1m5eb_from_infomaniak
      ```
      (No need to repeat `IdentityFile` here — the `Host *` block
      already covers it. Note: `HostName` is the *Infomaniak SSH
      backend*, NOT the public web hostname `newsitedbart.bbh.fr` —
      those are two different things on shared hosting.)

- [ ] Test it — should print the backend hostname (`h2web499` or
      similar — that's the Infomaniak cluster node, not the web
      hostname) and your remote home,
      **with no password and no passphrase prompt**:
      ```sh
      ssh newsitedbart "hostname && pwd"
      ```
      Expected output approximately:
      ```
      h2web499
      /home/clients/94e3ce6271e3648b7b00d6c32be0a6e2
      ```

      If you get a passphrase prompt here, the Keychain wiring didn't
      take. Re-check the `Host *` block in `~/.ssh/config` (must be
      `UseKeychain yes`, not commented out) and re-run
      `ssh-add --apple-use-keychain ~/.ssh/id_ed25519`.

      If you get a *password* prompt (for the server account), the
      public key wasn't copied successfully. Re-run `ssh-copy-id`.

---

## 2 · Configure `deploy.env` (one-time, on the Mac)

- [ ] Copy the template:
      ```sh
      cp deploy/deploy.env.example deploy/deploy.env
      ```

- [ ] Edit `deploy/deploy.env`:
      ```sh
      REMOTE_HOST="newsitedbart"   # your ~/.ssh/config alias
      REMOTE_PATH="/home/clients/94e3ce6271e3648b7b00d6c32be0a6e2/sites/newsitedbart.bbh.fr"
      ```
      (The example file ships with these exact values for this
      project, so on first setup you can `cp` and proceed.)

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
          newsitedbart:/home/clients/94e3ce6271e3648b7b00d6c32be0a6e2/sites/newsitedbart.bbh.fr/site/config/
      ```

- [ ] Rename on the server to match the **web hostname** (NOT the SSH
      backend hostname — they differ on Infomaniak):
      ```sh
      ssh newsitedbart "cd ~/sites/newsitedbart.bbh.fr/site/config && \
        mv config.example-host.php config.newsitedbart.bbh.fr.php"
      ```

      > Why the web hostname and not what `hostname -f` returns:
      > Kirby loads `config.<X>.php` where `X` is
      > `$_SERVER['SERVER_NAME']` at request time — i.e. the Host
      > header from the browser, which for this project is
      > `newsitedbart.bbh.fr`. The SSH backend hostname Infomaniak
      > returns (`h2web499` or similar) is the *cluster node*, not
      > what Kirby sees. Naming the file after the backend hostname
      > would silently never activate the gate.
      >
      > If you ever need to verify what `$_SERVER['SERVER_NAME']`
      > actually is at runtime, see step 7's diagnostic.

---

## 4 · Create a Kirby Panel user (one-time, on the server)

The gate from step 3 lets in any logged-in Panel user. You need at least
one.

- [ ] Visit `https://newsitedbart.bbh.fr/panel` in a browser.
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
        `site/cache/` and `media/` dirs. On Infomaniak the web root
        is owned by your SSH user, so writability is automatic.
      - If you see PHP errors on the homepage, check the Infomaniak
        PHP error log (Infomaniak Manager → your site → **Logs** →
        **PHP error log**). The deploy moved files; it didn't change
        any server-level config (`.htaccess`, `.user.ini`, PHP
        version) — those stay as Infomaniak has them.

---

## 7 · Verify the auth gate

- [ ] **Logged in (Panel session active from step 4):** visit
      `https://newsitedbart.bbh.fr/dev/draw` — editor should load
      normally, exactly like localhost.

- [ ] **Logged out:** open a private/incognito window and visit the
      same URL. Expect a plain-text **403 Forbidden** page with the
      message:
      > Forbidden — /dev/draw requires a logged-in Kirby Panel user.
      > Log in at /panel and reload this page.

- [ ] If the logged-out test loads the editor → the gate is NOT
      active. Most likely cause: the renamed config file's hostname
      doesn't match `$_SERVER['SERVER_NAME']`. Diagnostic:

      1. SSH in and temporarily prepend one line to `config.php`:
         ```sh
         ssh newsitedbart "sed -i.bak '1a\\
         error_log(\"SERVER_NAME=\" . (\$_SERVER[\"SERVER_NAME\"] ?? \"unset\"));
         ' ~/sites/newsitedbart.bbh.fr/site/config/config.php"
         ```
      2. Hit `https://newsitedbart.bbh.fr/dev/draw` once.
      3. Read the value back from the Infomaniak Manager → Logs →
         PHP error log. Look for the `SERVER_NAME=…` line.
      4. Rename your config file to match that exact string:
         ```sh
         ssh newsitedbart "cd ~/sites/newsitedbart.bbh.fr/site/config && \
           mv config.<old>.php config.<actual-SERVER_NAME>.php"
         ```
      5. Revert the probe:
         ```sh
         ssh newsitedbart "mv ~/sites/newsitedbart.bbh.fr/site/config/config.php.bak \
           ~/sites/newsitedbart.bbh.fr/site/config/config.php"
         ```

- [ ] If you get a 500 Internal Server Error → likely a PHP syntax
      issue in `config.<hostname>.php`. SSH in and lint:
      ```sh
      ssh newsitedbart "php -l ~/sites/newsitedbart.bbh.fr/site/config/config.newsitedbart.bbh.fr.php"
      ```
      Fix the typo locally in `site/config/config.example-host.php`,
      re-SCP, re-rename.

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
      ssh newsitedbart "cp -al ~/sites/newsitedbart.bbh.fr ~/sites/newsitedbart.bbh.fr.pre-$(date +%Y%m%d-%H%M%S)"
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
