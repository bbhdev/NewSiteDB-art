<?php
/**
 * Sync plugin — node activity timestamps + peer handshake (Slice S2).
 *
 * Purpose: every node (L, A, B) maintains a small per-node state file
 * recording its OWN last-activity timestamp plus its view of each
 * peer's last-activity timestamp. This is the foundation of the
 * "who's-ahead detection" mechanism documented in
 * sync-layer-topology-and-operations.md (memory):
 *
 *   - On every /dev/* save route firing, the node bumps its local
 *     `lastActivityAt` (sync_record_local_activity).
 *   - If this node has an upstream peer to report to (S2 rule: L
 *     reports to A; A and B don't push), the save handler ALSO
 *     fire-and-forget POSTs to the peer's /sync/ping endpoint with
 *     {role, at}. The peer records this in its own peerStamps[role].
 *   - GET /sync/state returns this node's state to any bearer-authed
 *     caller — enables L's editor to query A's lastActivityAt for
 *     the "peer ahead?" reconnect alert in later slices (S7).
 *
 * State file location: site/sync/state.json — NEVER synced (per-node
 * runtime state, like site/sessions/). Excluded from rsync deploy
 * via deploy-exclude.txt and (later) from the L↔A content sync.
 *
 * Concurrency: atomic-rename writes survive the common single-user
 * case. No file locking — multi-user concurrent saves on the same
 * node are not in scope for this project.
 *
 * Best-effort everywhere: peer pings have short timeouts and never
 * throw. A peer being offline must NEVER block a local save.
 */

Kirby::plugin('site/sync', []);

/**
 * Authorize an inbound /sync/* request via shared-secret bearer token.
 *
 * Returns null when the caller is authorized (route handler proceeds);
 * returns a Kirby\Http\Response carrying a 401/503 JSON error when not
 * (route handler immediately `return`s it).
 *
 * Header extraction handles the Infomaniak-shared-hosting quirks where
 * HTTP_AUTHORIZATION isn't always populated — see the long docblock on
 * the /sync/whoami route in config.php for the full rationale.
 */
function sync_authorize_request(): ?\Kirby\Http\Response
{
    $sync = option('sync');
    if (!is_array($sync) || empty($sync['secret'])) {
        return new \Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'sync not configured']),
            'application/json', 503
        );
    }
    $auth = $_SERVER['HTTP_AUTHORIZATION']
         ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
         ?? '';
    if ($auth === '' && function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $k => $v) {
            if (strcasecmp($k, 'Authorization') === 0) { $auth = $v; break; }
        }
    }
    $token = '';
    if (preg_match('/^\s*Bearer\s+(\S+)\s*$/i', (string)$auth, $m)) {
        $token = $m[1];
    }
    if ($token === '' || !hash_equals((string)$sync['secret'], $token)) {
        return new \Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'unauthorized']),
            'application/json', 401
        );
    }
    return null;
}

/**
 * State file schema version. Bump on incompatible shape changes;
 * sync_state_read() upgrades older shapes to defaults in memory.
 */
const SYNC_STATE_SCHEMA = 1;

/**
 * Roles in the topology. Used to validate /sync/ping payloads.
 */
function sync_known_roles(): array
{
    return ['L', 'A', 'B'];
}

/**
 * Canonical default state (used for first-write + missing-fields
 * merge). All timestamps null; peerStamps has every role keyed so
 * downstream reads can index without isset() everywhere.
 */
function sync_default_state(): array
{
    return [
        'schemaVersion'  => SYNC_STATE_SCHEMA,
        'lastActivityAt' => null,
        'lastActivityBy' => null,
        'peerStamps'     => [
            'L' => null,
            'A' => null,
            'B' => null,
        ],
    ];
}

/**
 * Returns the directory where per-node sync state lives. Creates it
 * (0755) on first call if missing.
 */
function sync_state_dir(): string
{
    // kirby()->root('site') resolves to .../site which is environment-
    // agnostic. Adding our /sync subdir there keeps the file next to
    // sessions/ and cache/ — peers in the per-node-state family.
    $dir = kirby()->root('site') . '/sync';
    if (!is_dir($dir)) {
        @mkdir($dir, 0755, true);
    }
    return $dir;
}

function sync_state_path(): string
{
    return sync_state_dir() . '/state.json';
}

/**
 * Read the state file, fill in any missing fields from defaults, and
 * return the merged array. Tolerates a missing file (first-run) and a
 * corrupt one (returns defaults, doesn't throw).
 */
function sync_state_read(): array
{
    $defaults = sync_default_state();
    $path = sync_state_path();
    if (!is_file($path)) {
        return $defaults;
    }
    $raw = @file_get_contents($path);
    if ($raw === false) {
        return $defaults;
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return $defaults;
    }
    // Shallow-merge top-level keys; peerStamps merges per-key so a
    // partial state file (e.g. only peerStamps.L set) still returns a
    // full {L,A,B} struct.
    $out = array_replace($defaults, $decoded);
    $out['peerStamps'] = array_replace(
        $defaults['peerStamps'],
        is_array($decoded['peerStamps'] ?? null) ? $decoded['peerStamps'] : []
    );
    return $out;
}

/**
 * Atomically write the state file (tmp + rename). Best-effort —
 * returns true on success, false on any I/O failure; never throws.
 * Callers in save handlers must NOT propagate a write failure into
 * the save's success/error path: a sync-state hiccup is invisible to
 * the author and self-heals on the next save.
 */
function sync_state_write(array $state): bool
{
    $path = sync_state_path();
    $tmp  = $path . '.tmp.' . bin2hex(random_bytes(4));
    $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    if ($json === false) {
        return false;
    }
    if (@file_put_contents($tmp, $json) === false) {
        return false;
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return false;
    }
    return true;
}

/**
 * This node's sync role ('L' | 'A' | 'B'), defaulting to 'L'. Reads the
 * sync block as one array and indexes it — option('sync.role') dot-
 * resolution is unreliable on some installs (see sync_record_local_activity
 * for the empirical note). Single source of truth for role-gated logic.
 */
function sync_role(): string
{
    $sync = option('sync');
    return is_array($sync) && !empty($sync['role']) ? (string) $sync['role'] : 'L';
}

/**
 * Is the PUBLIC node (B) currently frozen against direct author edits?
 *
 * Only B has a freeze concept — L and A are first-class edit surfaces and
 * always return false here. B is **frozen by default**: its served content
 * is defined entirely by the last A → B propagate, so direct authoring on B
 * is the rare unlock-B case (work-item 2080, Slice 2). The freeze is lifted
 * only when state.json carries an explicit `frozen === false` (written by the
 * unlock route). A missing/legacy field therefore reads as frozen — fail
 * CLOSED, which is the safe default for the public site.
 *
 * NB: this guards ONLY the /dev/* author-write routes (see
 * sync_assert_writable). It must NOT gate the machine-to-machine /sync/*
 * routes — A → B propagate is the SANCTIONED way B's content changes and
 * has to keep working while B is frozen; that is the entire point.
 */
function sync_b_is_frozen(): bool
{
    if (sync_role() !== 'B') {
        return false;
    }
    return sync_b_frozen_from_state(sync_state_read());
}

/**
 * PURE freeze decision over a given state array — no I/O, no persist.
 * Frozen when EITHER the explicit `frozen` field is anything other than a
 * literal false (default-frozen / fail-closed), OR the unlock window has
 * lapsed (`unlockExpiresAt` in the past). The lapsed-window arm is the
 * **lazy auto-lock** (2080 S2a): B has no reliable cron on shared hosting,
 * so instead of a timer firing server-side, every freeze check treats an
 * expired window as frozen. The instant anyone attempts a write past expiry,
 * the guard refuses — equivalent to an active re-lock, without a daemon.
 * sync_b_status() does the on-disk housekeeping (persist frozen=true +
 * autoLockedAt) so polls and cross-node reads converge.
 */
function sync_b_frozen_from_state(array $state): bool
{
    if (($state['frozen'] ?? true) !== false) {
        return true;
    }
    $exp = $state['unlockExpiresAt'] ?? null;
    if ($exp !== null) {
        $t = strtotime((string) $exp);
        if ($t !== false && time() >= $t) {
            return true;   // window lapsed → effectively frozen
        }
    }
    return false;
}

/**
 * Clamp a requested unlock duration to a sane band: 15 min … 24 h. A
 * zero/garbage value floors to 15 min (never an indefinite unlock); an
 * over-long request caps at a day (the public site should not sit writable
 * for longer without a deliberate re-unlock).
 */
function sync_b_clamp_hours($hours): float
{
    $h = is_numeric($hours) ? (float) $hours : 0.0;
    return max(0.25, min(24.0, $h));
}

/**
 * Build the client-facing unlock/freeze summary from a state array (pure).
 * `pendingBackProp` is the load-bearing field for the cross-node publish
 * guard (2080 S3): true when an unlock happened and no B→A back-propagate
 * has run SINCE it — i.e. B holds edits A does not have, so an A→B publish
 * would clobber them. Survives an auto-lock (unlockedAt/lastBackPropAt are
 * deliberately NOT cleared on auto-lock) so the "B is ahead" warning persists
 * until the author either back-propagates or does a clean gated re-freeze.
 */
function sync_b_status_fields(array $state): array
{
    $frozen     = sync_b_frozen_from_state($state);
    $exp        = $state['unlockExpiresAt'] ?? null;
    $unlockedAt = $state['unlockedAt'] ?? null;
    $lastBP     = $state['lastBackPropAt'] ?? null;

    $secs = null;
    if ($exp !== null && ($t = strtotime((string) $exp)) !== false) {
        $secs = max(0, $t - time());
    }
    $bpDone = false;
    if ($unlockedAt !== null && $lastBP !== null) {
        $lb = strtotime((string) $lastBP);
        $ua = strtotime((string) $unlockedAt);
        $bpDone = $lb !== false && $ua !== false && $lb >= $ua;
    }
    return [
        'role'                    => sync_role(),
        'frozen'                  => $frozen,
        'unlockedAt'              => $unlockedAt,
        'unlockExpiresAt'         => $exp,
        'unlockHours'             => $state['unlockHours'] ?? null,
        'secondsRemaining'        => $secs,
        'lastBackPropAt'          => $lastBP,
        'backPropDoneSinceUnlock' => $bpDone,
        'pendingBackProp'         => $unlockedAt !== null && !$bpDone,
        'autoLockedAt'            => $state['autoLockedAt'] ?? null,
    ];
}

/**
 * Read B's unlock/freeze status for the editor poll + cross-node reads.
 * Does the lazy auto-lock HOUSEKEEPING: if the window has lapsed while the
 * state still says frozen=false, persist frozen=true + stamp autoLockedAt
 * (and null the spent expiry) so on-disk state matches the pure decision.
 * unlockedAt/lastBackPropAt are intentionally preserved so pendingBackProp
 * still surfaces a B-ahead divergence after an auto-lock.
 */
function sync_b_status(): array
{
    $state = sync_state_read();
    if (sync_role() === 'B'
        && ($state['frozen'] ?? true) === false
        && sync_b_frozen_from_state($state)) {
        $state['frozen']          = true;
        $state['autoLockedAt']    = date('c');
        $state['unlockExpiresAt'] = null;
        sync_state_write($state);
    }
    $fields = sync_b_status_fields($state);

    // Divergence vs A — the SAME ahead/behind/equal evaluation L and A run on
    // their own pills (sync_direction_between over lastActivityAt), just with A
    // as the peer. `dirty` ("B holds edits A does not have") is direction ===
    // 'ahead'. This is the canonical signal, not a B-specific reinvention.
    // Fail-soft: if A has no peer URL or is unreachable we cannot tell, so we
    // report 'unknown' and the UI declines to nag (no amber) rather than guess.
    $fields['direction']   = 'unknown';
    $fields['peerReached'] = false;
    $fields['peerError']   = null;          // WHY the fetch failed (diagnostic; surfaced in the hint tooltip)
    if (sync_role() === 'B') {
        $peer = sync_fetch_peer_state('A');
        if (!empty($peer['ok']) && is_array($peer['state'] ?? null)) {
            $cmp = sync_direction_between(
                $state['lastActivityAt'] ?? null,
                $peer['state']['lastActivityAt'] ?? null
            );
            $fields['direction']   = $cmp['direction'];
            $fields['peerReached'] = true;
        } else {
            // Keep the underlying reason so the UI can stop collapsing five
            // distinct causes (not-configured / no-peer-URL / curl-missing /
            // HTTP-or-timeout / bad-shape) into a single false "unreachable".
            $fields['peerError'] = (string)($peer['error'] ?? 'unknown error')
                . ($peer['code'] ? ' (HTTP ' . $peer['code'] . ')' : '');
        }
    }
    $fields['dirty'] = ($fields['direction'] === 'ahead');
    return $fields;
}

/**
 * Unlock B for direct editing for a clamped number of hours. Records the
 * unlock instant + computed expiry and RESETS lastBackPropAt (a fresh unlock
 * starts with no back-prop credit — the author must back-propagate the new
 * edits before a clean re-freeze). Role-guarded: only B has a freeze.
 */
function sync_b_unlock($hours): array
{
    if (sync_role() !== 'B') {
        return ['ok' => false, 'code' => 400, 'error' => 'Only the public node (B) can be unlocked.'];
    }
    $h     = sync_b_clamp_hours($hours);
    $now   = time();
    $state = sync_state_read();
    $state['frozen']          = false;
    $state['unlockedAt']      = date('c', $now);
    $state['unlockHours']     = $h;
    $state['unlockExpiresAt'] = date('c', $now + (int) round($h * 3600));
    $state['lastBackPropAt']  = null;
    $state['autoLockedAt']    = null;
    sync_state_write($state);
    return ['ok' => true] + sync_b_status_fields($state);
}

/**
 * Extend B's unlock window to now + clamped hours (the author "prolongs" the
 * session, e.g. when the near-timeout alert fires or proactively mid-work).
 * Refuses if B is currently frozen (nothing to prolong — re-unlock instead).
 */
function sync_b_prolong($hours): array
{
    if (sync_role() !== 'B') {
        return ['ok' => false, 'code' => 400, 'error' => 'Only the public node (B) has an unlock window.'];
    }
    $state = sync_state_read();
    if (sync_b_frozen_from_state($state)) {
        return ['ok' => false, 'code' => 409, 'error' => 'B is frozen — nothing to prolong. Unlock it again instead.'];
    }
    $h   = sync_b_clamp_hours($hours);
    $now = time();
    $state['unlockHours']     = $h;
    $state['unlockExpiresAt'] = date('c', $now + (int) round($h * 3600));
    sync_state_write($state);
    return ['ok' => true] + sync_b_status_fields($state);
}

/**
 * Stamp lastBackPropAt = now. Called ONLY after a successful real (non-dry)
 * B→A back-propagate, so re-freeze gating and pendingBackProp can tell that
 * the edits made during THIS unlock have reached A.
 */
function sync_b_record_backprop(): void
{
    $state = sync_state_read();
    $state['lastBackPropAt'] = date('c');
    sync_state_write($state);
}

/**
 * Re-freeze B. GATED (2080 S2a, two-step UX): if an unlock is on record
 * (`unlockedAt` set) but no B→A back-propagate has run since it, refuse with
 * 409 — the author must back-propagate first, or those edits die on the next
 * A→B publish. On success, clears the whole unlock bookkeeping so B returns
 * to a clean default-frozen state.
 */
function sync_b_refreeze(): array
{
    if (sync_role() !== 'B') {
        return ['ok' => false, 'code' => 400, 'error' => 'Only the public node (B) is freezable.'];
    }
    $state  = sync_state_read();
    $fields = sync_b_status_fields($state);
    if ($fields['pendingBackProp']) {
        return [
            'ok'    => false,
            'code'  => 409,
            'error' => 'Back-propagate B → A before re-freezing — B holds edits A '
                     . 'does not have, and the next A → B publish would overwrite them.',
        ] + $fields;
    }
    $state['frozen']          = true;
    $state['unlockedAt']      = null;
    $state['unlockHours']     = null;
    $state['unlockExpiresAt'] = null;
    $state['lastBackPropAt']  = null;
    $state['autoLockedAt']    = null;
    sync_state_write($state);
    return ['ok' => true] + sync_b_status_fields($state);
}

/**
 * Shared gate for the B-unlock MUTATOR routes (unlock / prolong / backprop /
 * refreeze). Two checks: (1) role must be 'B' — these are meaningless on L/A;
 * (2) a Panel session is required, because they are author actions on a
 * PUBLIC node (same v0.10.252 rationale as the /sync/push public-node gate).
 * Returns a Response to short-circuit, or null to proceed.
 */
function sync_b_panel_guard(): ?\Kirby\Http\Response
{
    if (sync_role() !== 'B') {
        return new \Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'This action applies only to the public node (B).']),
            'application/json', 400
        );
    }
    if (kirby()->user() === null) {
        return new \Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'forbidden']),
            'application/json', 403
        );
    }
    return null;
}

/**
 * Author-write guard for the public node. Returns a 423 (Locked) Response
 * when this node is B and frozen; null when the write may proceed. Call it
 * at the TOP of every /dev/* route that mutates served content (editor save,
 * snapshot RESTORE, image upload/delete, workshop → page transfer) — before
 * any activity stamp or side effect. Read-only views (GET /dev/draw etc.)
 * and the bearer-gated /sync/* machine routes are intentionally NOT guarded.
 */
function sync_assert_writable(): ?\Kirby\Http\Response
{
    if (!sync_b_is_frozen()) {
        return null;
    }
    return new \Kirby\Http\Response(
        json_encode([
            'ok'     => false,
            'frozen' => true,
            'role'   => 'B',
            'error'  => 'B is the public site and is frozen. Content reaches B '
                      . 'only via Publish (A → B). To edit B directly, unlock '
                      . 'it first (rare — requires back-propagating to A before '
                      . 're-freezing).',
        ], JSON_UNESCAPED_SLASHES),
        'application/json',
        423
    );
}

/**
 * Bump lastActivityAt to "now" (ISO 8601 with timezone offset) and
 * stamp lastActivityBy with the current node's role. Called from
 * every /dev/* save route handler that represents human authoring
 * activity.
 *
 * Returns the timestamp written (so the caller can pass it directly
 * into sync_notify_peers_of_local_activity without re-reading state).
 */
function sync_record_local_activity(): string
{
    $now   = date('c');
    // Read the sync block as one array — Kirby's option() dot-resolution
    // of nested keys is unreliable in some setups (observed empirically:
    // option('sync.role') returned null on the L install while
    // option('sync') correctly returned the full array). The working
    // /sync/* routes already use this pattern (option('sync') + index);
    // matching it here keeps behavior consistent across read paths.
    $sync  = option('sync');
    $role  = is_array($sync) && !empty($sync['role']) ? (string)$sync['role'] : 'L';
    $state = sync_state_read();
    $state['lastActivityAt']        = $now;
    $state['lastActivityBy']        = $role;
    $state['peerStamps'][$role]     = $now;  // own role in peerStamps too — convenient for /sync/state consumers
    sync_state_write($state);
    return $now;
}

/**
 * Record an inbound peer-stamp push. Called from POST /sync/ping
 * after the body has been validated. Returns true on a clean update,
 * false on any storage failure.
 */
function sync_record_peer_stamp(string $role, string $at): bool
{
    if (!in_array($role, sync_known_roles(), true)) return false;
    // ISO 8601 with timezone — accept any string strtotime() can parse,
    // re-stamp via date('c') so storage is canonical.
    $ts = strtotime($at);
    if ($ts === false) return false;
    $canonical = date('c', $ts);
    $state = sync_state_read();
    $state['peerStamps'][$role] = $canonical;
    return sync_state_write($state);
}

/**
 * Fire-and-forget POST to a peer's /sync/ping. Short timeouts so a
 * down peer NEVER blocks a save. Returns a diagnostic array — caller
 * MAY log it for visibility but MUST NOT propagate failures.
 *
 * The peer URL is taken at face value from option('sync.peers').<R>.
 * /sync/ping is appended; trailing slashes on the base are tolerated.
 */
function sync_ping_peer(string $peerUrl, string $secret, string $role, string $at): array
{
    $url = rtrim($peerUrl, '/') . '/sync/ping';
    $body = json_encode(['role' => $role, 'at' => $at]);
    if ($body === false) {
        return ['ok' => false, 'code' => 0, 'error' => 'encode failed'];
    }
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'code' => 0, 'error' => 'curl not available'];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Authorization: Bearer ' . $secret,
            // Identify our pings in server logs — useful for diagnosing
            // unexpected /sync/ping hits.
            'User-Agent: NewSiteDB-art-sync/' . (option('version') ?? 'dev'),
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    $resp = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    $ok = $code === 200 && $resp !== false;
    // Diagnostic — surfaces failures that are otherwise invisible due
    // to the fire-and-forget contract. Goes to PHP error log; for
    // `php -S` that's the terminal stderr where the server runs.
    // Remove (or gate behind a debug option) once handshake is
    // confirmed working on the L install.
    if (!$ok) {
        error_log(sprintf(
            '[sync_ping_peer] FAILED url=%s code=%d curl_err=%s resp=%s',
            $url, $code, $err !== '' ? $err : '(none)',
            $resp === false ? '(false)' : substr((string)$resp, 0, 200)
        ));
    }
    return [
        'ok'    => $ok,
        'code'  => $code,
        'error' => $err !== '' ? $err : null,
    ];
}

/**
 * After recording local activity, push the new timestamp to whichever
 * upstream peer this node reports to.
 *
 * S2 rule (intentionally conservative): L reports to A; A and B do
 * NOT push. The "upstream" relationship is hard-coded for now — a
 * future slice can generalize if A starts pushing somewhere too.
 *
 * The activity timestamp is passed in (already computed by
 * sync_record_local_activity) so caller has the canonical value.
 *
 * Returns a per-peer result map (for optional logging). Never throws.
 */
function sync_notify_peers_of_local_activity(string $at): array
{
    // See sync_record_local_activity for why we read option('sync') as
    // one array instead of using dot-key access — dot-resolution was
    // returning null for nested keys on the L install, silently bailing
    // the entire ping path with no diagnostic signal.
    $sync = option('sync');
    if (!is_array($sync)) {
        error_log('[sync_notify_peers] option("sync") is not an array — sync block missing from config?');
        return [];
    }
    $role   = (string)($sync['role']   ?? '');
    $secret = (string)($sync['secret'] ?? '');
    $peers  = is_array($sync['peers'] ?? null) ? $sync['peers'] : [];

    // S2: only L pushes, and only to A. Bail early for other roles to
    // keep the network quiet. Diagnostic logs make a silent bail
    // distinguishable from a successful no-op (other roles).
    if ($role !== 'L') {
        return [];  // expected silence for A/B
    }
    if ($secret === '' || empty($peers['A'])) {
        error_log(sprintf(
            '[sync_notify_peers] L bail — secret=%s peersA=%s',
            $secret === '' ? 'EMPTY' : 'set',
            empty($peers['A']) ? 'EMPTY' : (string)$peers['A']
        ));
        return [];
    }

    return ['A' => sync_ping_peer((string)$peers['A'], $secret, $role, $at)];
}

/*
 * ─────────────────────────────────────────────────────────────────
 * Slice S3 — per-page _sync stamps + diff manifest
 * ─────────────────────────────────────────────────────────────────
 *
 * Each page that's authored via /dev/* save routes gets a sidecar
 * `_sync.json` file in its content directory, recording when it was
 * last touched and by whom. This is the per-page complement to the
 * node-wide state introduced in S2: state.json answers "was the
 * NODE active?", _sync.json answers "was THIS PAGE modified?"
 *
 * Sidecar lives in the page's content dir, NEXT TO Kirby's content
 * files (not inside them). Keeps Kirby's content parser untouched
 * and means our format can evolve independently of the page schema.
 *
 * S3 intentionally records timestamps only, no contentHash — that's
 * S4's job, where the sync diff logic will actually consume it. The
 * shape includes a schemaVersion so we can add hash/conflict fields
 * in S4 without ambiguity about old vs new sidecars.
 */

const SYNC_PAGE_SIDECAR_SCHEMA = 1;
const SYNC_PAGE_SIDECAR_FILE   = '_sync.json';

/**
 * Pages excluded from the manifest. Match against page id prefix.
 *   'dev'   — the entire editor surface (incl. drafts under
 *             dev/image-workshop/*; those are author-staging
 *             content but until S4 designs draft sync, we don't
 *             include them in the manifest)
 *   'error' — Kirby's 404 page
 */
function sync_manifest_excluded_prefixes(): array
{
    return ['dev', 'error'];
}

function sync_page_is_manifest_eligible(string $pageId): bool
{
    foreach (sync_manifest_excluded_prefixes() as $prefix) {
        if ($pageId === $prefix || str_starts_with($pageId, $prefix . '/')) {
            return false;
        }
    }
    return true;
}

/**
 * Read a page's sidecar, returning null if it doesn't exist or is
 * unreadable. Tolerant of partial / corrupt files (returns null
 * rather than throwing — the manifest then reports "no sync record"
 * for that page, which is the correct interpretation).
 */
function sync_page_sidecar_read(string $contentDir): ?array
{
    $path = rtrim($contentDir, '/') . '/' . SYNC_PAGE_SIDECAR_FILE;
    if (!is_file($path)) return null;
    $raw = @file_get_contents($path);
    if ($raw === false) return null;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

/**
 * Atomic-rename write of a page's sidecar. Best-effort — returns
 * false on I/O failure, never throws. Save handlers must NOT
 * propagate sidecar failures into the save's success/error path
 * (same contract as state.json).
 */
function sync_page_sidecar_write(string $contentDir, array $data): bool
{
    $dir = rtrim($contentDir, '/');
    if (!is_dir($dir)) return false;
    $path = $dir . '/' . SYNC_PAGE_SIDECAR_FILE;
    $tmp  = $path . '.tmp.' . bin2hex(random_bytes(4));
    $json = json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . "\n";
    if ($json === false) return false;
    if (@file_put_contents($tmp, $json) === false) return false;
    if (!@rename($tmp, $path)) { @unlink($tmp); return false; }
    return true;
}

/**
 * Bump a page's _sync sidecar: set lastModifiedAt = now and
 * lastModifiedBy = this node's role. Preserves lastSyncedAt (set
 * by S4's sync action, not by author activity).
 *
 * Resolution: if $contentDir is omitted, looks up the Kirby page
 * via kirby()->page($pageId)->root(). Handlers that already hold a
 * Page object (e.g. image-workshop's draft batch) can pass
 * $page->root() directly — saves a lookup AND handles drafts that
 * kirby()->page() doesn't return.
 *
 * Returns the timestamp written, or null on any failure (page not
 * resolvable, dir not writable). Failure is silent — save handlers
 * never block on this.
 */
function sync_bump_page(string $pageId, ?string $contentDir = null): ?string
{
    if ($contentDir === null) {
        $page = kirby()->page($pageId);
        if (!$page) return null;
        $contentDir = $page->root();
    }
    if (!is_dir($contentDir)) return null;

    $now  = date('c');
    $sync = option('sync');
    $role = is_array($sync) && !empty($sync['role']) ? (string)$sync['role'] : 'L';

    $existing = sync_page_sidecar_read($contentDir) ?? [];
    $data = [
        'schemaVersion'  => SYNC_PAGE_SIDECAR_SCHEMA,
        'lastModifiedAt' => $now,
        'lastModifiedBy' => $role,
        'lastSyncedAt'   => $existing['lastSyncedAt'] ?? null,
    ];
    if (!sync_page_sidecar_write($contentDir, $data)) return null;
    return $now;
}

/**
 * Collect the diff manifest: one entry per eligible page (see
 * sync_manifest_excluded_prefixes) with its current sidecar data
 * (or null if the page has no sidecar yet).
 *
 * Drafts are NOT walked (kirby()->site()->index() excludes them).
 * Pages that exist but have never been saved post-S3 appear with
 * sync = null — the consumer treats null as "no sync history" and
 * decides accordingly (likely: pull from peer if peer has data).
 */
function sync_collect_manifest(): array
{
    $pages = [];
    foreach (kirby()->site()->index() as $p) {
        $id = $p->id();
        if (!sync_page_is_manifest_eligible($id)) continue;
        $pages[] = [
            'id'   => $id,
            'sync' => sync_page_sidecar_read($p->root()),
        ];
    }
    return $pages;
}

/**
 * Server-side GET of a peer's /sync/state, using this node's stored
 * shared secret as the bearer token. Used by L's editor-side
 * indicator (S2b) to surface A's lastActivityAt without leaking the
 * secret into browser JS or tripping CORS.
 *
 * Returns:
 *   ['ok' => true,  'state' => <peer's state array>, 'role' => <peer's reported role>, 'time' => <peer's wall clock>]
 *   ['ok' => false, 'error' => <short reason>, 'code' => <http code or 0>]
 *
 * Short timeouts — must NEVER block UI more than a couple seconds.
 */
function sync_fetch_peer_state(string $role): array
{
    $sync = option('sync');
    if (!is_array($sync) || empty($sync['secret'])) {
        return ['ok' => false, 'error' => 'sync not configured', 'code' => 0];
    }
    $peers = is_array($sync['peers'] ?? null) ? $sync['peers'] : [];
    if (empty($peers[$role])) {
        return ['ok' => false, 'error' => 'no peer URL for role ' . $role, 'code' => 0];
    }
    $url = rtrim((string)$peers[$role], '/') . '/sync/state';
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'curl not available', 'code' => 0];
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . (string)$sync['secret'],
            'User-Agent: NewSiteDB-art-sync/' . (option('version') ?? 'dev'),
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    $resp = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    if ($code !== 200 || $resp === false) {
        return ['ok' => false, 'error' => $err !== '' ? $err : ('HTTP ' . $code), 'code' => $code];
    }
    $decoded = json_decode((string)$resp, true);
    if (!is_array($decoded) || empty($decoded['ok'])) {
        return ['ok' => false, 'error' => 'bad response shape', 'code' => $code];
    }
    return [
        'ok'    => true,
        'state' => $decoded['state'] ?? null,
        'role'  => $decoded['role']  ?? $role,
        'time'  => $decoded['time']  ?? null,
    ];
}

/**
 * Pure comparison of two `lastActivityAt` timestamps from THIS node's
 * point of view. Returns the direction and the absolute gap in seconds.
 *
 *   'equal'   — both stamps resolve to the same instant (or both absent).
 *               Nodes are converged; nothing to propagate either way.
 *   'ahead'   — THIS node's stamp is newer than the peer's. Local has
 *               unpropagated work; calm/yellow on L, "push when done".
 *   'behind'  — the PEER's stamp is newer. The peer has work this node
 *               hasn't ingested; RED + nuclear-modal territory.
 *
 * Asymmetric-null handling:
 *   peer null, local set  → 'ahead'  (we have history, peer is blank)
 *   local null, peer set  → 'behind' (peer has history, we are blank)
 *   both null             → 'equal'
 *
 * Convergence note: after any propagate the destination adopts the
 * SOURCE's stamp (see sync_record_propagate_receipt), so a freshly
 * propagated pair reads 'equal' here rather than the destination
 * spuriously reading 'behind' against the source.
 *
 * `gapSeconds` is null when one side's stamp is absent/unparseable;
 * 0 when equal; otherwise the absolute difference in seconds (>= 0).
 */
function sync_direction_between(?string $localAt, ?string $peerAt): array
{
    $localTs = ($localAt !== null && $localAt !== '') ? strtotime($localAt) : false;
    $peerTs  = ($peerAt  !== null && $peerAt  !== '') ? strtotime($peerAt)  : false;

    // Both absent / unparseable → converged-by-default.
    if ($localTs === false && $peerTs === false) {
        return ['direction' => 'equal', 'gapSeconds' => null];
    }
    // Only one side has a stamp.
    if ($peerTs === false) {
        return ['direction' => 'ahead', 'gapSeconds' => null];
    }
    if ($localTs === false) {
        return ['direction' => 'behind', 'gapSeconds' => null];
    }

    if ($localTs === $peerTs) {
        return ['direction' => 'equal', 'gapSeconds' => 0];
    }
    $gap = abs($localTs - $peerTs);
    return [
        'direction'  => $localTs > $peerTs ? 'ahead' : 'behind',
        'gapSeconds' => $gap,
    ];
}

/**
 * Convenience for save routes: record local activity AND push to
 * upstream peer in one call. Returns the timestamp written so the
 * save handler can include it in its own response if desired.
 *
 * Failures are swallowed — see the docblock on sync_state_write /
 * sync_ping_peer for the rationale.
 */
function sync_record_activity_and_notify(): string
{
    $at = sync_record_local_activity();
    sync_notify_peers_of_local_activity($at);
    return $at;
}

/* ════════════════════════════════════════════════════════════════════
 * S4b — content propagation (strict-direction push, primary in-app path)
 * ════════════════════════════════════════════════════════════════════
 *
 * The pivoted model (sync-layer-topology-and-operations.md) is
 * PROPAGATE-only, never bidirectional: L → A (push), A → L (back), and
 * A → B (publish). Each propagate OVERWRITES the destination's content/
 * with the source's, after a MANDATORY pre-propagate snapshot of the
 * destination so the overwrite is always undoable.
 *
 * Transport (chosen in S4b.0's validation pass): a single POST carrying
 * a gzip-compressed tar of the SOURCE's content/ as the raw request
 * body. The source builds the archive with the same exclusions applied
 * (see below), so the archive root holds page directories directly
 * (NOT nested under a content/ folder).
 *
 * Exclusions — mirror deploy/propagate.sh's RSYNC_EXCLUDES exactly:
 *   --exclude=/dev/      → top-level `dev/`   only   (per-node staging)
 *   --exclude=/error/    → top-level `error/` only   (per-node staging)
 *   --exclude=_drafts/   → `_drafts/` at ANY depth   (Kirby draft dirs)
 * Dotfiles (.DS_Store, …) are always skipped. `_sync.json` sidecars are
 * NOT dotfiles and DO propagate (copied verbatim — refreshing them is a
 * later concern, same as the CLI fallback).
 *
 * This is the PRIMARY path the CLI fallback (propagate.sh) backs up.
 * Same destination-snapshot + overwrite semantics, driven by HTTP
 * instead of rsync-over-SSH.
 */

/** Top-level-only propagation excludes (anchored at content/ root). */
function sync_propagate_excluded_top(): array { return ['dev', 'error']; }

/** Propagation excludes matched at ANY depth in the tree. */
function sync_propagate_excluded_anywhere(): array { return ['_drafts']; }

/**
 * Recursively copy a content tree from $src into $dst, applying the
 * propagation exclusions. $topLevel marks the content/ root, where the
 * top-only excludes (dev/, error/) apply; the any-depth excludes
 * (_drafts/) apply at every level. Dotfiles are skipped.
 *
 * Returns ['files'=>int, 'bytes'=>int] copied, or null on I/O failure.
 */
function sync_copy_content_tree(string $src, string $dst, bool $topLevel = true): ?array
{
    if (!is_dir($dst) && !@mkdir($dst, 0755, true)) return null;
    $items = @scandir($src);
    if ($items === false) return null;

    $exclTop = sync_propagate_excluded_top();
    $exclAny = sync_propagate_excluded_anywhere();
    $files = 0; $bytes = 0;

    foreach ($items as $it) {
        if ($it === '.' || $it === '..' || $it[0] === '.') continue;
        if (in_array($it, $exclAny, true)) continue;                  // _drafts/ anywhere
        if ($topLevel && in_array($it, $exclTop, true)) continue;     // dev/ error/ top-level

        $s = $src . '/' . $it;
        $d = $dst . '/' . $it;
        if (is_dir($s)) {
            $sub = sync_copy_content_tree($s, $d, false);
            if ($sub === null) return null;
            $files += $sub['files']; $bytes += $sub['bytes'];
        } elseif (is_file($s)) {
            if (@copy($s, $d) === false) return null;
            $files++; $bytes += (int) @filesize($s);
        }
    }
    return ['files' => $files, 'bytes' => $bytes];
}

/**
 * Measure an already-extracted content tree (the incoming upload):
 * total files, total bytes, and top-level page-directory count. Used to
 * report "what would be replaced" without mutating anything.
 */
function sync_measure_content_tree(string $root): array
{
    $files = 0; $bytes = 0; $topPages = 0;
    $top = @scandir($root);
    if ($top !== false) {
        foreach ($top as $it) {
            if ($it === '.' || $it === '..' || $it[0] === '.') continue;
            if (is_dir($root . '/' . $it)) $topPages++;
        }
    }
    if (is_dir($root)) {
        $rii = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($root, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($rii as $f) {
            if ($f->isFile()) { $files++; $bytes += (int) $f->getSize(); }
        }
    }
    return ['files' => $files, 'bytes' => $bytes, 'topPages' => $topPages];
}

/** Recursive rmdir (best-effort; never throws). */
function sync_rrmdir(string $dir): void
{
    if (!is_dir($dir)) return;
    $items = @scandir($dir);
    if ($items === false) { @rmdir($dir); return; }
    foreach ($items as $it) {
        if ($it === '.' || $it === '..') continue;
        $p = $dir . '/' . $it;
        if (is_dir($p)) sync_rrmdir($p);
        else @unlink($p);
    }
    @rmdir($dir);
}

/** Project root (parent of content/) — where library/ lives and where
 *  temp staging dirs must go so a later atomic rename into content/
 *  stays on one filesystem. */
function sync_project_root(): string
{
    return dirname(kirby()->root('content'));
}

/**
 * Take the MANDATORY pre-propagate snapshot of THIS node's current
 * content/ before it is overwritten. Snapshot format matches the manual
 * draw-library snapshots (library/<name>/{meta.json, content/}) so S7
 * retention sees both kinds uniformly. The propagation exclusions are
 * applied to the snapshot too (we only snapshot what gets replaced).
 *
 * Name: auto-pre-propagate-<UTC-iso>-from-<sourceRole> (with a short
 * random suffix if that collides within the same second).
 *
 * Returns ['ok'=>true, 'name'=>…, 'files'=>…, 'bytes'=>…] or
 *         ['ok'=>false, 'error'=>…].
 */
function sync_pre_propagate_snapshot(string $fromRole): array
{
    $contentSrc = kirby()->root('content');
    $libRoot    = sync_project_root() . '/library';
    if (!is_dir($libRoot) && !@mkdir($libRoot, 0755, true)) {
        return ['ok' => false, 'error' => 'cannot create library/'];
    }

    $name = 'auto-pre-propagate-' . gmdate('Ymd\THis\Z') . '-from-' . $fromRole;
    $dest = $libRoot . '/' . $name;
    if (is_dir($dest)) {
        $name .= '-' . bin2hex(random_bytes(2));
        $dest  = $libRoot . '/' . $name;
    }
    $contentDest = $dest . '/content';
    if (!@mkdir($contentDest, 0755, true)) {
        return ['ok' => false, 'error' => 'cannot create snapshot directory'];
    }

    $counts = sync_copy_content_tree($contentSrc, $contentDest, true);
    if ($counts === null) {
        return ['ok' => false, 'error' => 'snapshot content copy failed'];
    }

    $meta = [
        'name'          => $name,
        'savedAt'       => date('c'),
        'appVersion'    => option('version'),
        'schemaVersion' => option('schemaVersion'),
        'kind'          => 'auto-pre-propagate',
        'fromRole'      => $fromRole,
    ];
    @file_put_contents(
        $dest . '/meta.json',
        json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
    );

    // S7 / 2070 — enforce retention right after adding this snapshot, so the
    // auto-snapshot history can't grow without bound. Best-effort: a prune
    // failure must never fail the snapshot (and thus the propagate) it rode in
    // on, so we ignore its result here beyond surfacing it for observability.
    $prune = sync_prune_auto_snapshots();

    return ['ok' => true, 'name' => $name, 'files' => $counts['files'],
            'bytes' => $counts['bytes'], 'pruned' => $prune['pruned'] ?? []];
}

/**
 * S7 / 2070 — retention. Keep only the most recent $keep (default 30)
 * auto-pre-propagate snapshots in THIS node's library/, deleting older ones.
 * Each node maintains its own library/, so "per node" is automatic. Manual
 * snapshots are NEVER touched and don't count toward the limit.
 *
 * Identification is deliberately conservative: a directory is pruned ONLY
 * when BOTH (a) its name carries the 'auto-pre-propagate-' prefix AND (b) its
 * meta.json kind === 'auto-pre-propagate'. Anything we cannot positively
 * confirm as auto is KEPT — so a corrupt/missing meta can at worst leak a
 * stale auto snapshot (harmless), never delete a manual one.
 *
 * Best-effort, never throws. Returns
 *   ['ok'=>true,'kept'=>int,'pruned'=>[names]]  or  ['ok'=>false,'error'=>…].
 */
function sync_prune_auto_snapshots(int $keep = 30): array
{
    $libRoot = sync_project_root() . '/library';
    if (!is_dir($libRoot)) return ['ok' => true, 'kept' => 0, 'pruned' => []];

    $items = @scandir($libRoot);
    if ($items === false) return ['ok' => false, 'error' => 'cannot read library/'];

    $auto = [];   // name => savedAt (chronological sort key, ISO-8601 string)
    foreach ($items as $e) {
        if ($e === '.' || $e === '..' || $e[0] === '.') continue;
        if (strncmp($e, 'auto-pre-propagate-', 19) !== 0) continue;   // (a) name gate
        $dir = $libRoot . '/' . $e;
        if (!is_dir($dir)) continue;
        $metaPath = $dir . '/meta.json';
        if (!is_file($metaPath)) continue;
        $meta = json_decode((string) @file_get_contents($metaPath), true);
        if (!is_array($meta) || ($meta['kind'] ?? null) !== 'auto-pre-propagate') continue; // (b) kind gate
        // savedAt is always written for autos (date('c')); fall back to the
        // name (which embeds the UTC stamp) only if it's somehow absent.
        $auto[$e] = (string) ($meta['savedAt'] ?? $e);
    }

    if (count($auto) <= $keep) {
        return ['ok' => true, 'kept' => count($auto), 'pruned' => []];
    }

    arsort($auto);                              // newest first (savedAt desc)
    $stale  = array_slice(array_keys($auto), $keep);
    $pruned = [];
    foreach ($stale as $name) {
        sync_rrmdir($libRoot . '/' . $name);
        if (!is_dir($libRoot . '/' . $name)) $pruned[] = $name;
    }
    return ['ok' => true, 'kept' => $keep, 'pruned' => $pruned];
}

/** Verbatim recursive copy (keeps dotfiles; no exclusions). Used to
 *  preserve this node's own dev/ and error/ staging across a swap.
 *  Returns true/false. */
function sync_copy_verbatim(string $src, string $dst): bool
{
    if (!is_dir($dst) && !@mkdir($dst, 0755, true)) return false;
    $items = @scandir($src);
    if ($items === false) return false;
    foreach ($items as $it) {
        if ($it === '.' || $it === '..') continue;
        $s = $src . '/' . $it;
        $d = $dst . '/' . $it;
        if (is_dir($s)) {
            if (!sync_copy_verbatim($s, $d)) return false;
        } elseif (is_file($s)) {
            if (@copy($s, $d) === false) return false;
        }
    }
    return true;
}

/** Walk $dir (rooted at $contentRoot) and copy every `_drafts/` subtree
 *  it finds into $finalRoot at the same relative path — preserving
 *  Kirby draft holding dirs at any depth across a swap (they are
 *  excluded from the propagated tree, like rsync --exclude=_drafts/).
 *  Does not descend into a _drafts/ once copied. Returns true/false. */
function sync_preserve_drafts(string $dir, string $contentRoot, string $finalRoot): bool
{
    $items = @scandir($dir);
    if ($items === false) return false;
    foreach ($items as $it) {
        if ($it === '.' || $it === '..' || $it[0] === '.') continue;
        $p = $dir . '/' . $it;
        if (!is_dir($p)) continue;
        if ($it === '_drafts') {
            $rel  = ltrim(substr($p, strlen($contentRoot)), '/');
            $dest = $finalRoot . '/' . $rel;
            if (!sync_copy_verbatim($p, $dest)) return false;
            continue;   // don't descend into a _drafts subtree
        }
        if (!sync_preserve_drafts($p, $contentRoot, $finalRoot)) return false;
    }
    return true;
}

/** Count top-level page directories under a content tree. */
function sync_count_top_pages(string $root): int
{
    $n = 0;
    $items = @scandir($root);
    if ($items === false) return 0;
    foreach ($items as $it) {
        if ($it === '.' || $it === '..' || $it[0] === '.') continue;
        if (is_dir($root . '/' . $it)) $n++;
    }
    return $n;
}

/**
 * Apply an extracted incoming content tree over THIS node's content/,
 * with rsync---delete-mirror semantics and the propagation exclusions
 * PRESERVED on the destination:
 *   - top-level dev/ and error/ are kept from the current content/
 *     (per-node staging; on A this includes the editor's own dev/ pages)
 *   - _drafts/ dirs at any depth are kept from the current content/
 *   - everything else is replaced wholesale by the incoming tree
 *     (pages absent from incoming therefore disappear — the --delete)
 *
 * Strategy: assemble the final tree in a temp dir (incoming, excludes
 * re-applied defensively, + the preserved dirs), then two atomic
 * renames to swap it into place. Same filesystem (project root) makes
 * rename() atomic and the move-aside reversible on failure.
 *
 * Returns ['ok'=>true,'pages'=>int,'files'=>int,'bytes'=>int] or
 *         ['ok'=>false,'error'=>…].
 */
function sync_apply_propagate(string $extractDir): array
{
    $content  = kirby()->root('content');
    $root     = sync_project_root();
    $tag      = gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(3));
    $finalDir = $root . '/.sync-final-' . $tag;

    // 1. Incoming → final (excludes re-applied; strips any dev/error/
    //    _drafts that slipped into the archive).
    $counts = sync_copy_content_tree($extractDir, $finalDir, true);
    if ($counts === null) {
        sync_rrmdir($finalDir);
        return ['ok' => false, 'error' => 'failed assembling new content tree'];
    }

    // 2. Preserve this node's top-level dev/ and error/.
    foreach (sync_propagate_excluded_top() as $top) {
        $s = $content . '/' . $top;
        if (is_dir($s) && !sync_copy_verbatim($s, $finalDir . '/' . $top)) {
            sync_rrmdir($finalDir);
            return ['ok' => false, 'error' => "failed preserving {$top}/"];
        }
    }

    // 3. Preserve _drafts/ at any depth.
    if (!sync_preserve_drafts($content, $content, $finalDir)) {
        sync_rrmdir($finalDir);
        return ['ok' => false, 'error' => 'failed preserving _drafts/'];
    }

    // 4. Atomic swap: move current aside, move final into place; roll
    //    back the move-aside if the second rename fails.
    $aside = $root . '/.sync-old-' . $tag;
    if (!@rename($content, $aside)) {
        sync_rrmdir($finalDir);
        return ['ok' => false, 'error' => 'could not move current content/ aside'];
    }
    if (!@rename($finalDir, $content)) {
        @rename($aside, $content);          // rollback
        sync_rrmdir($finalDir);
        return ['ok' => false, 'error' => 'could not move new content/ into place (rolled back)'];
    }
    sync_rrmdir($aside);

    return [
        'ok'    => true,
        'pages' => sync_count_top_pages($content),
        'files' => $counts['files'],
        'bytes' => $counts['bytes'],
    ];
}

/**
 * Record that this node's content/ was just overwritten by a propagate
 * from $fromRole.
 *
 * S5.1 convergence rule: the destination adopts the SOURCE's content
 * timestamp ($srcActivityAt), NOT "now". After a propagate the two nodes
 * hold identical content, so they must read as EQUAL in direction-
 * detection. Stamping "now" (the pre-S5 behavior) overshot the source —
 * right after a push L→A, A.lastActivityAt > L.lastActivityAt, which the
 * pill/modal would read as "A is ahead" and fire the nuclear warning on L
 * immediately after a successful sync (a false positive). Adopting the
 * source's timestamp makes both sides equal in BOTH directions while only
 * ever writing the destination (the sole writable node in a push AND in a
 * pull). lastActivityBy keeps the "<role>-propagate" marker for provenance.
 *
 * Falls back to now() only when the source supplied no parseable timestamp
 * (e.g. a source that has never recorded activity). Best-effort; never
 * throws.
 */
function sync_record_propagate_receipt(string $fromRole, ?string $srcActivityAt = null): string
{
    $ts    = ($srcActivityAt !== null && $srcActivityAt !== '') ? strtotime($srcActivityAt) : false;
    $now   = $ts !== false ? date('c', $ts) : date('c');
    $state = sync_state_read();
    $state['lastActivityAt'] = $now;
    $state['lastActivityBy'] = $fromRole . '-propagate';
    sync_state_write($state);
    return $now;
}

/**
 * ─────────────────────────────────────────────────────────────────
 * Shared RECEIVE/INGEST path (S4c) — apply an incoming content/ tarball
 * to THIS node, with the mandatory pre-propagate snapshot.
 * ─────────────────────────────────────────────────────────────────
 *
 * This is the single destructive ingest used by BOTH directions:
 *   - POST /sync/propagate  (push receive — $raw is the request body)
 *   - POST /sync/pull/<from> (back-propagate — $raw is the gzip body
 *     fetched from the source's /sync/export)
 *
 * Factoring it means the snapshot → atomic-swap → receipt dance exists
 * in exactly one place; push and pull cannot drift in how they wipe and
 * replace content/. Behavior is identical to S4b's inline receive route.
 *
 * $raw           gzip-tar bytes (page dirs at the archive root)
 * $fromRole      source role (already validated by the caller)
 * $dryRun        true → measure only, no snapshot, no swap
 * $srcActivityAt source node's lastActivityAt (S5.1) — the destination
 *                adopts it as its own so the two read EQUAL post-propagate.
 *                Travels in the ?srcActivityAt= query param (push) or the
 *                X-Sync-Activity-At response header (pull). Null → receipt
 *                falls back to now().
 *
 * Returns ['status' => <http code>, 'payload' => <json-able array>].
 * Cleans up its own temp files in every branch. Never throws.
 */
function sync_ingest_content_tarball(string $raw, string $fromRole, bool $dryRun = false, ?string $srcActivityAt = null): array
{
    $received = strlen($raw);
    if ($received === 0) {
        return ['status' => 400, 'payload' =>
            ['ok' => false, 'error' => 'empty payload (expected a content/ tar.gz)']];
    }

    $root       = sync_project_root();
    $tag        = gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(3));
    $tarPath    = $root . '/.sync-incoming-' . $tag . '.tar.gz';
    $extractDir = $root . '/.sync-extract-' . $tag;

    $cleanup = function () use ($tarPath, $extractDir) {
        @unlink($tarPath);
        sync_rrmdir($extractDir);
    };

    if (@file_put_contents($tarPath, $raw) === false) {
        return ['status' => 500, 'payload' =>
            ['ok' => false, 'error' => 'could not buffer upload to disk']];
    }

    // Extract. PharData reads/extracts data tar archives even under
    // phar.readonly=1 (that ini only gates executable .phar).
    try {
        $phar = new PharData($tarPath);
        @mkdir($extractDir, 0755, true);
        $phar->extractTo($extractDir, null, true);
        $phar = null;   // release handle before cleanup unlinks $tarPath
    } catch (\Throwable $e) {
        $cleanup();
        return ['status' => 400, 'payload' =>
            ['ok' => false, 'error' => 'tarball extract failed: ' . $e->getMessage()]];
    }

    $measure = sync_measure_content_tree($extractDir);
    if ($measure['files'] === 0) {
        $cleanup();
        return ['status' => 400, 'payload' =>
            ['ok' => false, 'error' => 'uploaded archive contained no files']];
    }

    // ?dryRun=1 — report only, no snapshot, no swap. (UI confirm /
    // preview, and S5 direction detection.)
    if ($dryRun) {
        $cleanup();
        return ['status' => 200, 'payload' => [
            'ok'           => true,
            'dryRun'       => true,
            'from'         => $fromRole,
            'received'     => ['bytes' => $received],
            'wouldReplace' => [
                'pages' => $measure['topPages'],
                'files' => $measure['files'],
                'bytes' => $measure['bytes'],
            ],
        ]];
    }

    // Real propagate. Mandatory pre-propagate snapshot FIRST.
    $snap = sync_pre_propagate_snapshot($fromRole);
    if (!$snap['ok']) {
        $cleanup();
        return ['status' => 500, 'payload' =>
            ['ok' => false, 'error' => 'pre-propagate snapshot failed: ' . $snap['error']]];
    }

    // Atomic swap content/ → incoming (preserving dev/, error/,
    // _drafts/). On failure the swap rolls back its move-aside, so
    // content/ is left intact; the snapshot exists regardless.
    $applied = sync_apply_propagate($extractDir);
    if (!$applied['ok']) {
        $cleanup();
        return ['status' => 500, 'payload' => [
            'ok'       => false,
            'error'    => 'propagate failed: ' . $applied['error'],
            'snapshot' => $snap['name'],   // restore point
        ]];
    }

    // Destination is now up to date — adopt the source's content timestamp
    // (S5.1) so the two nodes read EQUAL, not "this one ahead", afterward.
    $at = sync_record_propagate_receipt($fromRole, $srcActivityAt);
    $cleanup();

    return ['status' => 200, 'payload' => [
        'ok'            => true,
        'from'          => $fromRole,
        'snapshot'      => $snap['name'],
        'received'      => ['bytes' => $received],
        'replaced'      => [
            'pages' => $applied['pages'],
            'files' => $applied['files'],
            'bytes' => $applied['bytes'],
        ],
        'stateBumpedAt' => $at,
    ]];
}

/**
 * PULL side (S4c, runs on L): fetch $fromRole's /sync/export and apply it
 * to THIS node via sync_ingest_content_tarball(). The mirror of
 * sync_propagate_to_peer() — but L pulls because it has no inbound URL.
 *
 * $dryRun=true fetches the peer's measure (no local snapshot/swap) for
 * the editor confirm/preview.
 *
 * Returns the ingest payload (real) or the peer's measure (dryRun),
 * annotated with 'httpCode' and (real) 'fetched' bytes. On a
 * local/transport failure returns ['ok'=>false,'error'=>…[,'code']].
 * Never throws.
 */
function sync_pull_from_peer(string $fromRole, bool $dryRun = false): array
{
    $sync = option('sync');
    if (!is_array($sync) || empty($sync['secret'])) {
        return ['ok' => false, 'error' => 'sync not configured'];
    }
    $secret = (string) $sync['secret'];
    $peers  = is_array($sync['peers'] ?? null) ? $sync['peers'] : [];
    if (!in_array($fromRole, sync_known_roles(), true)) {
        return ['ok' => false, 'error' => 'unknown source role: ' . $fromRole];
    }
    $peerUrl = (string) ($peers[$fromRole] ?? '');
    if ($peerUrl === '') {
        return ['ok' => false, 'error' => "no peer URL configured for {$fromRole}"];
    }
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'curl not available'];
    }

    $url = rtrim($peerUrl, '/') . '/sync/export' . ($dryRun ? '?dryRun=1' : '');
    $ch  = curl_init($url);
    // S5.1 — capture the source's content timestamp from its response header
    // so the local ingest can adopt it (both nodes read EQUAL post-pull).
    $srcActivityAt = null;
    curl_setopt_array($ch, [
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . $secret,
            'User-Agent: NewSiteDB-art-sync/' . (option('version') ?? 'dev'),
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => 120,           // content (with images) can be MBs
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_HEADERFUNCTION => function ($curl, $header) use (&$srcActivityAt) {
            $parts = explode(':', $header, 2);
            if (count($parts) === 2 && strcasecmp(trim($parts[0]), 'X-Sync-Activity-At') === 0) {
                $srcActivityAt = trim($parts[1]);
            }
            return strlen($header);
        },
    ]);
    $resp  = curl_exec($ch);
    $code  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = (string) curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    $err   = curl_error($ch);

    if ($resp === false) {
        return ['ok' => false, 'code' => $code,
                'error' => 'request failed: ' . ($err !== '' ? $err : 'unknown transport error')];
    }
    if ($code !== 200) {
        // Peer answered an error (almost always JSON). Surface its message.
        $decoded = json_decode((string) $resp, true);
        return ['ok' => false, 'code' => $code,
                'error' => is_array($decoded) ? ($decoded['error'] ?? 'peer error')
                                              : 'peer returned HTTP ' . $code,
                'body'  => is_array($decoded) ? null : substr((string) $resp, 0, 300)];
    }

    // dryRun → the peer replied with a JSON measure; pass it through.
    if ($dryRun) {
        $decoded = json_decode((string) $resp, true);
        if (!is_array($decoded)) {
            return ['ok' => false, 'code' => $code, 'error' => 'non-JSON dry-run response from peer',
                    'body' => substr((string) $resp, 0, 300)];
        }
        $decoded['httpCode'] = $code;
        $decoded['from']     = $fromRole;
        return $decoded;
    }

    // Real pull. Guard: a 200 that is JSON means the peer sent an error
    // payload where we expected a tarball — don't feed that to PharData.
    if (stripos($ctype, 'json') !== false) {
        $decoded = json_decode((string) $resp, true);
        return ['ok' => false, 'code' => $code,
                'error' => is_array($decoded) ? ($decoded['error'] ?? 'peer sent JSON, not a tarball')
                                              : 'peer sent JSON, not a tarball'];
    }

    $r = sync_ingest_content_tarball((string) $resp, $fromRole, false, $srcActivityAt);
    $payload = $r['payload'];
    $payload['httpCode'] = $code;
    $payload['fetched']  = ['bytes' => strlen((string) $resp)];

    // v0.10.237 — converge the SOURCE's view after a successful pull.
    // The ingest made THIS node adopt the source's lastActivityAt, so the
    // two now hold identical content. But the source doesn't know that: its
    // peerStamps['L'] still reflects L's PRE-pull activity (older than the
    // source's own stamp), so the source's /sync/self pill would falsely
    // read "ahead of L" forever. Push L's newly-adopted stamp back to the
    // source so its peerStamps['L'] catches up and it reads 'equal'.
    // Reuses the save-time notify path (L→A only; a no-op for other roles).
    // Fire-and-forget: sync_ping_peer short-timeouts and swallows failures,
    // so a slow/absent source never blocks the pull's own success.
    if (($r['status'] ?? 0) === 200) {
        $adopted = (string) (sync_state_read()['lastActivityAt'] ?? '');
        if ($adopted !== '') sync_notify_peers_of_local_activity($adopted);
    }
    return $payload;
}

/*
 * ─────────────────────────────────────────────────────────────────
 * Slice S4b.3 — SEND side: tar this node's content/ and POST it to a
 * peer's /sync/propagate receive endpoint.
 * ─────────────────────────────────────────────────────────────────
 *
 * The PRIMARY in-app push (deploy/propagate.sh is the CLI fallback).
 * sync_build_propagate_tarball() produces the exact wire format the
 * receiver expects: a gzip tar with page dirs at the archive root and
 * the propagation exclusions ALREADY applied (the receiver re-applies
 * them too — belt and suspenders — but pre-filtering keeps drafts and
 * the editor surface off the wire). sync_propagate_to_peer() reads the
 * peer URL + shared secret from option('sync'), POSTs the tarball as a
 * raw binary body (Content-Type: application/gzip — NOT form-encoded,
 * or PHP empties php://input on the far side), and returns the peer's
 * own JSON verdict annotated with the HTTP code and sent size.
 */

/**
 * Stage content/ (excludes applied) and build a gzip tarball of it under
 * the project root. Returns ['ok'=>true,'path'=>…,'files'=>…,'bytes'=>…]
 * (caller MUST unlink ['path'] when done) or ['ok'=>false,'error'=>…].
 */
function sync_build_propagate_tarball(): array
{
    $content = kirby()->root('content');
    $root    = sync_project_root();
    $tag     = gmdate('Ymd\THis\Z') . '-' . bin2hex(random_bytes(3));
    $stage   = $root . '/.sync-outgoing-' . $tag;
    $tarPath = $root . '/.sync-send-' . $tag . '.tar';   // .gz appended by compress()
    $gzPath  = $tarPath . '.gz';

    // 1. Stage with exclusions → page dirs land at the staging root, which
    //    becomes the archive root (matches the receiver's extract layout).
    $counts = sync_copy_content_tree($content, $stage, true);
    if ($counts === null) {
        sync_rrmdir($stage);
        return ['ok' => false, 'error' => 'failed staging content/ for send'];
    }
    if (($counts['files'] ?? 0) === 0) {
        sync_rrmdir($stage);
        return ['ok' => false, 'error' => 'nothing to send (0 files after exclusions)'];
    }

    // 2. tar then gzip. PharData reads/creates DATA archives even under
    //    phar.readonly=1 (that ini only gates executable .phar).
    try {
        @unlink($tarPath); @unlink($gzPath);
        $phar = new PharData($tarPath);
        $phar->buildFromDirectory($stage);
        $phar->compress(Phar::GZ);     // writes $gzPath alongside $tarPath
        $phar = null;
    } catch (\Throwable $e) {
        @unlink($tarPath); @unlink($gzPath);
        sync_rrmdir($stage);
        return ['ok' => false, 'error' => 'tar build failed: ' . $e->getMessage()];
    }

    // Count top-level page dirs from the STAGE (excludes already applied)
    // before we remove it — pull's dry-run preview reports this so the
    // user sees "would replace N pages" symmetric with the push side.
    $pages = sync_count_top_pages($stage);

    @unlink($tarPath);     // keep only the compressed archive
    sync_rrmdir($stage);
    if (!is_file($gzPath)) {
        return ['ok' => false, 'error' => 'compressed tarball not produced'];
    }
    return ['ok' => true, 'path' => $gzPath, 'pages' => $pages,
            'files' => $counts['files'], 'bytes' => $counts['bytes']];
}

/**
 * Push this node's content/ to $toRole's /sync/propagate endpoint.
 * $dryRun=true asks the peer to report what WOULD be replaced without
 * snapshotting or swapping (for the editor confirm/preview).
 *
 * Returns the peer's decoded JSON response with two fields added:
 *   'httpCode' — the HTTP status from the peer
 *   'sent'     — ['bytes'=>int,'files'=>int] actually uploaded
 * On a local/transport failure returns ['ok'=>false,'error'=>…[,'code']].
 * Never throws.
 */
function sync_propagate_to_peer(string $toRole, bool $dryRun = false): array
{
    $sync = option('sync');
    if (!is_array($sync) || empty($sync['secret'])) {
        return ['ok' => false, 'error' => 'sync not configured'];
    }
    $role   = (string) ($sync['role'] ?? '');
    $secret = (string) $sync['secret'];
    $peers  = is_array($sync['peers'] ?? null) ? $sync['peers'] : [];
    if ($role === '') {
        return ['ok' => false, 'error' => 'this node has no sync role'];
    }
    if (!in_array($toRole, sync_known_roles(), true)) {
        return ['ok' => false, 'error' => 'unknown destination role: ' . $toRole];
    }
    $peerUrl = (string) ($peers[$toRole] ?? '');
    if ($peerUrl === '') {
        return ['ok' => false, 'error' => "no peer URL configured for {$toRole}"];
    }
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'curl not available'];
    }

    $built = sync_build_propagate_tarball();
    if (!$built['ok']) {
        return $built;
    }
    $gzPath = $built['path'];

    // Read the archive into memory and send it as the raw POST body. A
    // STRING in CURLOPT_POSTFIELDS is sent verbatim with the given
    // Content-Type — no form/multipart encoding. Symmetric with the
    // receiver, which reads the whole body via file_get_contents().
    $body = @file_get_contents($gzPath);
    @unlink($gzPath);
    if ($body === false) {
        return ['ok' => false, 'error' => 'could not read built tarball'];
    }
    $size = strlen($body);

    // S5.1 — carry THIS node's content timestamp so the receiver can adopt
    // it and the two read EQUAL post-push (see sync_record_propagate_receipt).
    $srcAt = (string) (sync_state_read()['lastActivityAt'] ?? '');

    $url = rtrim($peerUrl, '/') . '/sync/propagate?from=' . rawurlencode($role)
         . ($srcAt !== '' ? '&srcActivityAt=' . rawurlencode($srcAt) : '')
         . ($dryRun ? '&dryRun=1' : '');

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $body,
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/gzip',   // BINARY — see /sync/propagate note
            'Authorization: Bearer ' . $secret,
            'User-Agent: NewSiteDB-art-sync/' . (option('version') ?? 'dev'),
            'Expect:',                           // avoid the 100-continue stall
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT        => 120,           // content (with images) can be MBs
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    $resp = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);

    if ($resp === false) {
        return ['ok' => false, 'code' => $code,
                'error' => 'request failed: ' . ($err !== '' ? $err : 'unknown transport error')];
    }
    $decoded = json_decode((string) $resp, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'code' => $code, 'error' => 'non-JSON response from peer',
                'body' => substr((string) $resp, 0, 300)];
    }
    $decoded['httpCode'] = $code;
    $decoded['sent']     = ['bytes' => $size, 'files' => $built['files']];
    return $decoded;
}

/**
 * Remote-trigger a peer's OWN propagate (publish epic, Slice 3 / 2060).
 *
 * Runs on THIS node (L). Authenticated by the shared secret, it asks
 * $viaRole to push ITS content to $toRole — i.e. L calls A's
 * /sync/relay-push/B so that A (the single physical source of B's
 * content) publishes A→B. No bytes leave L here; the content travels
 * A→B on the via-node. This is the "additional trigger living on A"
 * that lets finished-on-L work reach the public site WITHOUT a physical
 * L→B (which would give B a second provenance and risk B leading a stale
 * A). The mandatory order is enforced by the caller: L→A first (so A is
 * current), then this relay.
 *
 * Returns the via-node's relayed result (which is its own
 * sync_propagate_to_peer($toRole) output — peer B's /sync/propagate
 * verdict with httpCode + sent), plus 'relayHttpCode' = the HTTP status
 * of THIS L→via relay call. On a local/transport failure returns
 * ['ok'=>false,'error'=>…[,'code']]. Never throws.
 */
function sync_request_relay_push(string $viaRole, string $toRole, bool $dryRun = false): array
{
    $sync = option('sync');
    if (!is_array($sync) || empty($sync['secret'])) {
        return ['ok' => false, 'error' => 'sync not configured'];
    }
    $secret = (string) $sync['secret'];
    $peers  = is_array($sync['peers'] ?? null) ? $sync['peers'] : [];
    if (!in_array($viaRole, sync_known_roles(), true)) {
        return ['ok' => false, 'error' => 'unknown via role: ' . $viaRole];
    }
    if (!in_array($toRole, sync_known_roles(), true)) {
        return ['ok' => false, 'error' => 'unknown destination role: ' . $toRole];
    }
    $viaUrl = (string) ($peers[$viaRole] ?? '');
    if ($viaUrl === '') {
        return ['ok' => false, 'error' => "no peer URL configured for {$viaRole}"];
    }
    if (!function_exists('curl_init')) {
        return ['ok' => false, 'error' => 'curl not available'];
    }
    $url = rtrim($viaUrl, '/') . '/sync/relay-push/' . rawurlencode($toRole)
         . ($dryRun ? '?dryRun=1' : '');
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => '',
        CURLOPT_HTTPHEADER     => [
            'Authorization: Bearer ' . $secret,
            'User-Agent: NewSiteDB-art-sync/' . (option('version') ?? 'dev'),
            'Expect:',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        // The via-node builds AND uploads its own tarball to $toRole while
        // this call blocks, so allow the same 120s ceiling as a direct push.
        CURLOPT_TIMEOUT        => 120,
        CURLOPT_FOLLOWLOCATION => false,
    ]);
    $resp = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);

    if ($resp === false) {
        return ['ok' => false, 'code' => $code,
                'error' => 'relay request failed: ' . ($err !== '' ? $err : 'unknown transport error')];
    }
    $decoded = json_decode((string) $resp, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'code' => $code, 'error' => 'non-JSON response from ' . $viaRole,
                'body' => substr((string) $resp, 0, 300)];
    }
    $decoded['relayHttpCode'] = $code;
    return $decoded;
}
