<?php
/**
 * Sync peer indicator (Slice S2b).
 *
 * A small fixed-position pill rendered on L's editor pages showing
 * when A was last authored on. Lets the L author notice that A has
 * staging work they may want to pull before saving over it (the
 * later S7 slice turns this into a hard reconnect alert; here it's
 * just a passive light).
 *
 * Renders ONLY when this node's role is 'L' — on A or B the
 * snippet emits nothing. This keeps the editor templates clean
 * (they can include the snippet unconditionally without worrying
 * about per-node rendering rules).
 *
 * Data source: GET /sync/peer/A on the same origin (L itself).
 * That proxy route uses L's stored shared secret server-side to
 * fetch A's /sync/state. Browser never sees the secret.
 *
 * Polling: every 60s + immediately on focus/visibility change.
 */

$syncOpt = option('sync');
$role = is_array($syncOpt) ? (string)($syncOpt['role'] ?? '') : '';
if ($role !== 'L') return;
?>
<div id="sync-peer-indicator"
     style="position:fixed;bottom:8px;right:8px;z-index:9999;
            font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;
            background:#2a2a2a;color:#fff;
            padding:4px 8px;border-radius:4px;
            pointer-events:none;user-select:none;
            transition:background-color 0.2s, color 0.2s;">
  <span data-role="label">A: …</span>
</div>
<script>
(function () {
  // Self-contained polling — no framework deps so this snippet drops
  // cleanly into any editor template (draw, page, image-workshop).
  var el = document.getElementById('sync-peer-indicator');
  if (!el) return;
  var label = el.querySelector('[data-role="label"]');

  // Activity-age threshold below which the indicator turns yellow
  // (S2b feedback): when both L and A have been authored very
  // recently, the risk of concurrent-edit conflicts is real and
  // worth flagging passively. 2h is generous enough to cover a
  // distracted "I'll continue tomorrow" pattern without yelling
  // about it; below that, the author should pause and check.
  var WARN_THRESHOLD_SECONDS = 2 * 3600;

  // Three visual states. Solid backgrounds (no opacity) — earlier
  // semi-transparent styling washed into the page-area outline and
  // was harder to read than necessary.
  //   ok    — calm dark pill, the steady state
  //   warn  — yellow, A was active very recently (≤ WARN_THRESHOLD)
  //   error — red, A unreachable / proxy failure
  var STYLES = {
    ok:    { bg: '#2a2a2a', fg: '#ffffff' },
    warn:  { bg: '#e8b22b', fg: '#1f1f1f' },
    error: { bg: '#c93333', fg: '#ffffff' }
  };

  function relTime(iso) {
    if (!iso) return 'no activity yet';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return 'invalid time';
    var now = Date.now();
    var diff = (now - d.getTime()) / 1000;  // seconds
    if (diff < 0) diff = 0;  // clock skew tolerance
    if (diff < 60)      return Math.floor(diff) + 's ago';
    if (diff < 3600)    return Math.floor(diff / 60) + 'min ago';
    if (diff < 86400)   return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400*7) return Math.floor(diff / 86400) + 'd ago';
    // Older than a week: absolute date, dropping time component
    return d.toISOString().slice(0, 10);
  }

  // Seconds since the given ISO timestamp, or null if missing/invalid.
  function ageSeconds(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return Math.max(0, (Date.now() - d.getTime()) / 1000);
  }

  function setLabel(text, state) {
    label.textContent = 'A: ' + text;
    var s = STYLES[state] || STYLES.ok;
    el.style.background = s.bg;
    el.style.color = s.fg;
  }

  function poll() {
    fetch('/sync/peer/A', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j || !j.ok || !j.state) {
          setLabel('unreachable', 'error');
          return;
        }
        var iso = j.state.lastActivityAt;
        var age = ageSeconds(iso);
        var state = (age !== null && age <= WARN_THRESHOLD_SECONDS) ? 'warn' : 'ok';
        setLabel('active ' + relTime(iso), state);
      })
      .catch(function () { setLabel('unreachable', 'error'); });
  }

  poll();
  // Refresh once a minute. Cheap — A's /sync/state is just a JSON
  // file read on the server side.
  setInterval(poll, 60000);
  // Refresh immediately when the editor tab gets focus / becomes
  // visible — the moment you switch back from another tool is when
  // a stale indicator is most misleading.
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
  });
})();
</script>
