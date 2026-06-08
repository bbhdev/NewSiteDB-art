<?php
/*
 * ─────────────────────────────────────────────────────────────────────
 * Host-scoped Kirby config — TEMPLATE (danielbondard.fr).
 * ─────────────────────────────────────────────────────────────────────
 *
 * Sibling of config.newsitedbart.bbh.fr.php. Identical body; the only
 * difference is the filename, which must match the WEB hostname Kirby
 * sees in $_SERVER['SERVER_NAME'] at request time:
 *
 *     config.<SERVER_NAME>.php
 *
 * For this target the web hostname is `danielbondard.fr`, so this file
 * sits on the server as `config.danielbondard.fr.php` (next to
 * `config.php`). On localhost the filename doesn't match, so this file
 * is ignored — local dev is unaffected.
 *
 * The rsync deploy excludes `/site/config/config.*.php` so each
 * environment keeps its own host config; this file in the repo is the
 * source-of-truth / template, not actively served in production (the
 * deployed server has its own copy that may diverge).
 *
 * IMPORTANT: on shared hosting (Infomaniak, etc.) the SSH backend
 * hostname is NOT the same as the web hostname. Running `hostname -f`
 * while SSH'd in returns something like `h2web499` (the backend
 * server), but Kirby sees `danielbondard.fr` because that's the Host
 * header from the visitor's browser. The config file MUST be named
 * after the WEB hostname, not the backend hostname.
 *
 * For the WHY and the full implementation history, read the long
 * docblock in config.newsitedbart.bbh.fr.php — it's the same gate.
 *
 * SETUP CHECKLIST (one time, on a new server)
 *   1. Push this file via `deploy/deploy.sh --host-config danielbondard.fr`
 *      (rsync-excluded from the main mirror by design).
 *   2. On first deploy, set `panel.install => true` in this file
 *      TEMPORARILY so Kirby allows the Panel installer to run on a
 *      public server. Visit /panel, create the first user, then REMOVE
 *      the line (or set it to false).
 *   3. Verify the gate: log out of /panel, then `curl https://danielbondard.fr/dev/draw`
 *      → expect HTTP 403 + the plain-text body. Log in via /panel →
 *      /dev/draw loads normally.
 *
 * SANITY-CHECK ESCAPE HATCH: if you lock yourself out (Panel session
 * lost, can't get back in), SSH to the server and either rename this
 * file (gate is removed) or delete the Panel sessions in
 * site/sessions/. The gate does NOT affect /panel itself.
 */

return [
    'ready' => function ($kirby) {
        // Strip PHP fingerprint from EVERY response (not just /dev/draw).
        // `expose_php = Off` in php.ini would also do this server-wide,
        // but Infomaniak shared hosting doesn't always honor user overrides;
        // doing it in PHP guarantees the header is gone for this app.
        header_remove('X-Powered-By');

        $path = $kirby->request()->path()->toString();
        // v0.10.33 — generalised gate: protect the ENTIRE /dev tree
        // rather than enumerating individual surfaces (dev/draw,
        // dev/page, dev/image-workshop, …). Every page under /dev is an
        // authoring/editor tool that must never be reachable without a
        // Panel session on a public server; none is meant for public
        // consumption. Matching `dev` exactly OR `dev/` as a prefix
        // (note the trailing slash) avoids false positives on unrelated
        // top-level slugs that merely begin with "dev" (e.g. a
        // hypothetical "development-notes" page). This means no future
        // dev tool needs to edit this rsync-excluded host-scoped file.
        if ($path === 'dev' || str_starts_with($path, 'dev/')) {
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
