<?php

/*
 * Email transport sidecar — TEMPLATE (tracked). v0.10.275.
 *
 * Copy this file to `email.secret.php` ON EACH NODE (L / A / B), fill in the
 * real mailbox + password, and `chmod 600` it. The real file is gitignored
 * AND rsync-excluded — never tracked, never deployed — so it must be
 * provisioned per node via sftp/scp, exactly like sync.secret.php.
 *
 * Why a sidecar and not the host config: config.<host>.php is TRACKED in git,
 * so an SMTP password placed there would be committed. This file is the only
 * secret-safe home for the credentials.
 *
 * The array returned here is used verbatim as Kirby's `email` option
 * (config.php → `'email' => $emailConfig`).
 *
 * ── Infomaniak SMTP ───────────────────────────────────────────────────────
 *   host     : mail.infomaniak.com
 *   port     : 465 with security 'ssl'   (or 587 with security 'tls')
 *   auth     : true
 *   username : a REAL Infomaniak mailbox (full address), e.g. noreply@danielbondard.fr
 *   password : that mailbox's password
 *
 * IMPORTANT — the `from` used when sending (the /dev/email-test route, and
 * Kirby's own 2FA / password-reset mails) must be this mailbox or one of its
 * authorized aliases, or Infomaniak rejects the message. Keep username on a
 * domain you control at Infomaniak.
 *
 * Same mailbox can be reused on all three nodes, or use a per-node mailbox —
 * each node's sidecar is independent.
 */

return [
    'transport' => [
        'type'     => 'smtp',
        'host'     => 'mail.infomaniak.com',
        'port'     => 465,
        'security' => 'ssl',          // 'ssl' for 465, 'tls' for 587
        'auth'     => true,
        'username' => 'noreply@example.tld',   // ← a real Infomaniak mailbox
        'password' => 'CHANGE-ME',             // ← that mailbox's password
    ],
];
