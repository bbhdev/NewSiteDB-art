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
    $role  = (string)(option('sync.role') ?? 'L');
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
    curl_close($ch);
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
    $role   = (string)(option('sync.role') ?? 'L');
    $secret = (string)(option('sync.secret') ?? '');
    $peers  = option('sync.peers') ?? [];

    // S2: only L pushes, and only to A. Bail early for other roles to
    // keep the network quiet.
    if ($role !== 'L' || !is_array($peers) || empty($peers['A']) || $secret === '') {
        return [];
    }

    return ['A' => sync_ping_peer((string)$peers['A'], $secret, $role, $at)];
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
