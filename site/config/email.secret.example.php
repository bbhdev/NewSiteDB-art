<?php

/*
 * Email transport sidecar — TEMPLATE (tracked). v0.10.276.
 *
 * Copy this file to `email.secret.php` ON EACH NODE (L / A / B), fill in the
 * real mailbox + password, and `chmod 600` it. The real file is gitignored
 * AND rsync-excluded — never tracked, never deployed — so it must be
 * provisioned per node via sftp/scp, exactly like sync.secret.php.
 *
 * ⚠ NEVER put real credentials in THIS .example file — it is TRACKED in git.
 *   Real values go only in email.secret.php (gitignored).
 *
 * Why a sidecar and not the host config: config.<host>.php is TRACKED in git,
 * so an SMTP password placed there would be committed. This sidecar is the
 * only secret-safe home for the credentials.
 *
 * The array returned here is used verbatim as Kirby's `email` option
 * (config.php → `'email' => $emailConfig`).
 *
 * ── Infomaniak authenticated SMTP ─────────────────────────────────────────
 *   host     : mail.infomaniak.com
 *   port     : 587 with security 'tls'   (STARTTLS — the default below)
 *              or 465 with security 'ssl'  (implicit TLS)
 *   auth     : true
 *   username : a REAL Infomaniak mailbox (full address), e.g. noreply@yourdomain.tld
 *   password : that mailbox's password
 *
 * ⚠ security VALUE vs PROTOCOL NAME — no conflict, just two labels:
 *   Infomaniak documents port 587 as "STARTTLS". Kirby/PHPMailer's config
 *   token for that exact method is the string 'tls' (it maps to PHPMailer's
 *   ENCRYPTION_STARTTLS, whose literal value IS 'tls'). So write 'tls', not
 *   'STARTTLS' — the literal 'STARTTLS' is unrecognized and falls back to
 *   PHPMailer's opportunistic auto-TLS (encryption not guaranteed). Use 'ssl'
 *   only for the implicit-TLS port 465.
 *
 * IMPORTANT — the `from` used when sending (the /dev/email-test route, and
 * Kirby's own 2FA / password-reset mails) must be this mailbox or one of its
 * authorized aliases, or Infomaniak rejects the message. Keep username on a
 * domain whose DNS Infomaniak manages so SPF/DKIM signing applies.
 *
 * Same mailbox can be reused on all three nodes, or use a per-node mailbox —
 * each node's sidecar is independent.
 */

return [
    'transport' => [
        'type'     => 'smtp',
        'host'     => 'mail.infomaniak.com',
        'port'     => 587,
        'security' => 'tls',          // 'tls' for 587 (STARTTLS), 'ssl' for 465
        'auth'     => true,
        'username' => 'noreply@example.tld',   // ← a real Infomaniak mailbox
        'password' => 'CHANGE-ME',             // ← that mailbox's password
    ],
];
