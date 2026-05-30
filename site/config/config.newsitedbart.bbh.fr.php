<?php
/*
 * ─────────────────────────────────────────────────────────────────────
 * Host-scoped Kirby config — TEMPLATE.
 * ─────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE IS
 *   Kirby loads `config.php` first, then merges this file *over* it IF
 *   its filename matches the WEB hostname Kirby sees in
 *   $_SERVER['SERVER_NAME'] at request time:
 *
 *       config.<SERVER_NAME>.php
 *
 *   For this project, the web hostname is `newsitedbart.bbh.fr`, so
 *   this file should sit on the server as `config.newsitedbart.bbh.fr.php`
 *   (next to `config.php`). On localhost the filename doesn't match,
 *   so this file is ignored — local dev is unaffected.
 *
 *   The rsync deploy excludes `/site/config/config.*.php` so each
 *   environment keeps its own host config; this file in the repo is
 *   the source-of-truth / template, not actively served in production
 *   (the deployed server has its own copy that may diverge).
 *
 *   IMPORTANT: on shared hosting (Infomaniak, etc.) the SSH backend
 *   hostname is NOT the same as the web hostname. Running `hostname -f`
 *   while SSH'd in returns something like `h2web499` (the backend
 *   server), but Kirby sees `newsitedbart.bbh.fr` because that's the
 *   Host header from the visitor's browser. The config file MUST be
 *   named after the WEB hostname, not the backend hostname.
 *
 * WHY IT EXISTS
 *   The /dev/draw editor and its write endpoints (dev/draw/save,
 *   dev/draw/library/{save,load}, dev/draw/font-bundle POST, etc.) have
 *   NO authentication check in the shared config.php. That's fine on
 *   localhost; on a public server it means anyone who finds the URL
 *   can overwrite content. This file installs an auth gate that
 *   returns 403 Forbidden for any dev/draw/* request unless a Kirby
 *   Panel user is logged in.
 *
 * HOW IT WORKS — implementation history
 *
 *   Attempt 1 (v0.9.2, DID NOT WORK): registered a wildcard guard
 *   route at `dev/draw/(:all?)` via a `routes` array returned from
 *   the `ready` callback. The hope was that Kirby would resolve the
 *   guard before the real `dev/draw/*` handlers and `return false`
 *   from the guard would fall through to the real route when the
 *   user was logged in.
 *
 *   In practice (Kirby v5.2 + this codebase), the guard never fired:
 *     - The shared config.php registers specific `dev/draw/library/...`,
 *       `dev/draw/save`, `dev/draw/font-bundle`, etc. route patterns
 *       at top-level options. Those win over routes registered from
 *       a `ready` callback.
 *     - The bare `/dev/draw` URL doesn't resolve via a route at all —
 *       it resolves via PAGE resolution (`content/dev/draw/` →
 *       `template draw.php`), which never touches the route table.
 *
 *   Live test (v0.9.13, server cleanly logged out): curl /dev/draw
 *   returned 200 + the editor HTML. The gate was inert.
 *
 *   Attempt 2 (v0.9.14, WORKING): do the auth check INSIDE the `ready`
 *   callback body itself, BEFORE returning. `ready` runs on every
 *   request after the core (including session) is initialized, so
 *   `$kirby->user()` resolves correctly. If the request path starts
 *   with `dev/draw` and no Panel user is logged in, emit HTTP 403 +
 *   a plain-text body and `exit()`. The route table is bypassed
 *   entirely — neither route ordering nor page resolution can route
 *   around the gate.
 *
 *   `/panel` itself is NOT gated here — Kirby has its own auth on the
 *   Panel routes. Our gate only covers the editor surface.
 *
 * SETUP CHECKLIST (one time, on a new server)
 *   1. SCP this file to site/config/ on the server. Rename it to
 *      match the WEB hostname (e.g. `config.newsitedbart.bbh.fr.php`).
 *      `/site/config/config.*.php` is excluded from rsync by design.
 *   2. On first deploy, set `panel.install => true` in this file
 *      TEMPORARILY so Kirby allows the Panel installer to run on a
 *      public server. Visit /panel, create the first user, then
 *      REMOVE the line (or set it to false).
 *   3. Verify the gate: log out of /panel, then `curl /dev/draw`
 *      (or hit it from a fresh browser) → expect HTTP 403 + the
 *      plain-text body. Log in via /panel → /dev/draw loads normally.
 *
 *   If the 403 doesn't appear, the host-scoped file isn't being
 *   loaded — Kirby's expected filename comes from $_SERVER['SERVER_NAME']
 *   which on some setups differs from what you'd guess. Drop a probe:
 *      <?php header('Content-Type: text/plain');
 *      echo 'SERVER_NAME=' . ($_SERVER['SERVER_NAME'] ?? 'unset');
 *   at the web root as probe.php, hit it, and rename the config file
 *   to match exactly.
 *
 * SANITY-CHECK ESCAPE HATCH
 *   If you lock yourself out (Panel session lost, can't get back in),
 *   SSH to the server and either rename this file (gate is removed)
 *   or delete the Panel sessions in site/sessions/. The gate does NOT
 *   affect /panel itself, so resetting your Panel password via Kirby's
 *   CLI tools is always possible.
 */

return [
    'ready' => function ($kirby) {
        // Strip PHP fingerprint from EVERY response (not just /dev/draw).
        // `expose_php = Off` in php.ini would also do this server-wide,
        // but Infomaniak shared hosting doesn't always honor user overrides;
        // doing it in PHP guarantees the header is gone for this app.
        header_remove('X-Powered-By');

        $path = $kirby->request()->path()->toString();
        if (str_starts_with($path, 'dev/draw')) {
            if ($kirby->user() === null) {
                // Neutral 403 — do NOT name the framework, the admin surface,
                // or hint at a login path. Knowing the stack lets an attacker
                // target known CVEs; the response stays opaque on purpose.
                http_response_code(403);
                header('Content-Type: text/plain; charset=utf-8');
                echo "Forbidden\n";
                exit;
            }
        }
        return [];
    },
];
