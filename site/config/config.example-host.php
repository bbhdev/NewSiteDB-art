<?php
/*
 * ─────────────────────────────────────────────────────────────────────
 * Host-scoped Kirby config — TEMPLATE.
 * ─────────────────────────────────────────────────────────────────────
 *
 * WHAT THIS FILE IS
 *   Kirby loads `config.php` first, then merges this file *over* it IF
 *   its filename matches the current server hostname:
 *
 *       config.<SERVER_NAME>.php
 *
 *   So on a server whose hostname is `bondard.net`, rename a copy of
 *   this template to `config.bondard.net.php` (next to `config.php`).
 *   Kirby will then load both. On localhost the filename doesn't match,
 *   so this file is ignored — local dev is unaffected.
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
 *   2. Rename it to match the server's hostname:
 *         mv config.example-host.php config.<your-hostname>.php
 *      Find the hostname with `hostname -f` on the server.
 *   3. Create at least one Kirby Panel user (if you haven't already):
 *         php site/sandbox/users.php   # or via /panel after first login
 *      The Panel is at /panel — log in once, the session cookie then
 *      authenticates all /dev/draw requests until logout.
 *   4. Verify: visit /dev/draw logged-out → should get 403. Log in via
 *      /panel → /dev/draw should load normally.
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
