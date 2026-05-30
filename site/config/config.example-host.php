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
 *   this template should be renamed to `config.newsitedbart.bbh.fr.php`
 *   (next to `config.php`) on the server. Kirby will then load both.
 *   On localhost the filename doesn't match, so this file is ignored —
 *   local dev is unaffected.
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
 *   localhost; on a public server it means anyone who finds the URL can
 *   overwrite content. This file installs an auth gate that returns
 *   403 Forbidden for any dev/draw/* request unless a Kirby Panel user
 *   is logged in.
 *
 * HOW IT WORKS
 *   The `ready` callback runs once at app boot and returns extra config
 *   merged into Kirby's settings. We return a `routes` array whose
 *   single entry is a wildcard guard at `dev/draw/(:all?)`. Kirby
 *   resolves routes in registration order; routes from `ready` are
 *   registered before the ones in config.php, so the guard sees the
 *   request first. If the user is logged in, the guard returns `false`,
 *   which tells Kirby "no match — try the next route" → the real
 *   dev/draw handler runs as normal. If not logged in, the guard
 *   returns a 403 Response and the request stops there.
 *
 * SETUP CHECKLIST (one time, on the server)
 *   1. SCP this file to site/config/ on the server (it is excluded from
 *      the rsync deploy by design — see deploy/deploy-exclude.txt).
 *   2. Rename it to match the WEB hostname:
 *         mv config.example-host.php config.newsitedbart.bbh.fr.php
 *      (NOT what `hostname -f` returns — that's the SSH backend host
 *       on shared hosting and Kirby won't match against it.)
 *   3. Create at least one Kirby Panel user via /panel — on first
 *      visit Kirby walks you through user creation. The session
 *      cookie then authenticates all /dev/draw requests until logout.
 *   4. Verify: visit /dev/draw logged-out → should get 403. Log in via
 *      /panel → /dev/draw should load normally.
 *
 *   If the 403 doesn't appear (editor loads even when logged out), the
 *   hostname doesn't match. Drop a one-line probe into config.php to
 *   confirm what Kirby actually sees:
 *      error_log('SERVER_NAME=' . ($_SERVER['SERVER_NAME'] ?? 'unset'));
 *   Hit /dev/draw once, check the Infomaniak Manager → Logs → PHP
 *   error log, then rename this file to match that string exactly.
 *
 * SANITY-CHECK ESCAPE HATCH
 *   If you somehow lock yourself out (Panel session lost, can't get
 *   back in), SSH to the server and either rename this file (gate is
 *   removed) or delete the Panel session in site/sessions/. The gate
 *   does NOT affect /panel itself, so resetting your Panel password
 *   via Kirby's CLI tools is always possible.
 */

return [
    'ready' => function ($kirby) {
        return [
            'routes' => [
                [
                    'pattern' => 'dev/draw/(:all?)',
                    'method'  => 'ALL',
                    'action'  => function ($rest = null) {
                        // Logged-in Panel user → fall through to the real route.
                        if (kirby()->user() !== null) {
                            return false;
                        }
                        // Anonymous → 403 Forbidden.
                        return new \Kirby\Http\Response(
                            "Forbidden — /dev/draw requires a logged-in Kirby Panel user.\n"
                            . "Log in at /panel and reload this page.\n",
                            'text/plain',
                            403
                        );
                    },
                ],
            ],
        ];
    },
];
