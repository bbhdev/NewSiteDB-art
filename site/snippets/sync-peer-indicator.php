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

<?php /* S4b.4 — primary in-app "Push L → A" control + dark confirm modal.
        L-only (the whole snippet returns early for A/B). Self-contained,
        no framework deps, matching the indicator pill's style. Flow:
        click → dry-run preview (what would be replaced on A) → confirm →
        real push → result. The push OVERWRITES A's content/, but A takes
        a mandatory pre-propagate snapshot first (see /sync/propagate). */ ?>
<style>
  /* Shared look for the two propagate controls (push + pull). Each
     button keeps its own id for JS wiring + vertical position; the
     pull button stacks above the push button and is tinted toward red
     because it overwrites the machine you're sitting at. */
  .sync-prop-btn{
    position:fixed; right:8px; z-index:9999;
    font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#2a2a2a; color:#fff; border:1px solid #3d3d3d;
    padding:7px 11px; border-radius:6px; cursor:pointer;
    display:inline-flex; align-items:center; gap:6px;
    /* Push and Pull carry different labels ("→ A" vs "← A"); a shared
       min-width keeps the two stacked pills the same size, and the
       icon+label stay flush-left so they line up vertically. */
    min-width:6.5rem; justify-content:flex-start; box-sizing:border-box;
    transition:background-color .15s, border-color .15s;
  }
  .sync-prop-btn:hover{ background:#343434; border-color:#4a4a4a; }
  .sync-prop-btn:disabled{ opacity:.55; cursor:default; }
  .sync-prop-btn svg{ width:14px; height:14px; display:block; }
  #sync-push-btn{ bottom:34px; }
  #sync-pull-btn{ bottom:68px; border-color:#5a3a3a; }
  #sync-pull-btn:hover{ background:#3a2a2a; border-color:#7a4a4a; }

  /* z-index 10001 (was 10000) so the push/pull modals layer ABOVE the
     S5.2 nuclear overlay (10000) — the nuclear "Pull A → L now" button
     opens the pull preview modal, which must sit on top of the scrim. */
  .sync-prop-modal{ position:fixed; inset:0; z-index:10001;
    display:flex; align-items:center; justify-content:center;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; }
  .sync-prop-modal[hidden]{ display:none; }
  .sync-prop-modal .spm-backdrop{ position:absolute; inset:0; background:rgba(0,0,0,.6); }
  .sync-prop-modal .spm-panel{ position:relative; width:min(420px,92vw);
    background:#202020; border:1px solid #3a3a3a; border-radius:10px;
    box-shadow:0 12px 40px rgba(0,0,0,.55); color:#ececec; padding:18px 18px 14px; }
  .sync-prop-modal .spm-title{ font-size:15px; font-weight:600; color:#fff; margin-bottom:10px; }
  .sync-prop-modal .spm-title b{ color:#f5c518; }
  .sync-prop-modal .spm-title b.danger{ color:#ff8d7a; }
  .sync-prop-modal .spm-body{ color:#cfcfcf; min-height:42px; }
  .sync-prop-modal .spm-body b{ color:#fff; }
  .sync-prop-modal .spm-body .spm-warn{ color:#ff8d7a; }
  .sync-prop-modal .spm-body .spm-ok{ color:#7ddca0; }
  .sync-prop-modal .spm-actions{ display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
  .sync-prop-modal button{ font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    padding:8px 13px; border-radius:6px; cursor:pointer; border:1px solid transparent; }
  .sync-prop-modal .spm-cancel{ background:#2e2e2e; color:#ddd; border-color:#444; }
  .sync-prop-modal .spm-cancel:hover{ background:#383838; }
  .sync-prop-modal .spm-confirm{ background:#f5c518; color:#1c1c1c; }
  .sync-prop-modal .spm-confirm:hover{ background:#ffd23b; }
  .sync-prop-modal .spm-confirm:disabled{ opacity:.45; cursor:default; }
  /* Danger confirm — pull overwrites THIS machine's content. */
  .sync-prop-modal .spm-confirm.danger{ background:#c0392b; color:#fff; }
  .sync-prop-modal .spm-confirm.danger:hover{ background:#e04a3a; }

  /* ── S5.2 — nuclear "A is ahead" blocking overlay ─────────────────
     Full-screen scrim shown on L's editor whenever A is ahead (the
     'behind' direction). Editing now is unsafe — the next pull would
     overwrite it and L's edits can't be merged back — so the overlay
     BLOCKS the editor until the author either pulls (converge) or takes
     the deliberate "I know what I'm doing" escape hatch. z-index 10000
     sits above the editor, pill, and prop buttons (9999) but below the
     prop modals (10001) so the reused pull modal can stack on top.
     Buttons are full-width and generously padded — touch-first sizing
     for the planned tablet editor (no reliance on hover or keyboard). */
  .sync-nuclear{ position:fixed; inset:0; z-index:10000;
    display:flex; align-items:center; justify-content:center;
    background:rgba(10,8,8,.82); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px);
    font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif; }
  .sync-nuclear[hidden]{ display:none; }
  .sync-nuclear .snuc-panel{ width:min(460px,92vw);
    background:#1f1c1c; border:1px solid #5a3a3a; border-radius:12px;
    box-shadow:0 18px 60px rgba(0,0,0,.65); color:#ececec; padding:22px 22px 18px; }
  .sync-nuclear .snuc-title{ font-size:18px; font-weight:700; color:#ff8d7a; margin:0 0 12px; }
  .sync-nuclear .snuc-body p{ margin:0 0 12px; color:#dcdcdc; }
  .sync-nuclear .snuc-body b{ color:#fff; }
  .sync-nuclear .snuc-advice{ color:#f5c518; }
  .sync-nuclear .snuc-stamps{ background:#161414; border:1px solid #3a3232;
    border-radius:8px; padding:10px 12px; margin:0 0 12px; }
  .sync-nuclear .snuc-stamps div{ display:flex; justify-content:space-between; gap:12px; }
  .sync-nuclear .snuc-stamps div + div{ margin-top:6px; }
  .sync-nuclear .snuc-k{ color:#9a9a9a; white-space:nowrap; }
  .sync-nuclear .snuc-v{ text-align:right; }
  .sync-nuclear .snuc-actions{ display:flex; flex-direction:column; gap:10px; margin-top:6px; }
  .sync-nuclear button{ font:600 14px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;
    padding:13px 16px; border-radius:8px; cursor:pointer; border:1px solid transparent;
    width:100%; box-sizing:border-box; }
  .sync-nuclear .snuc-pull{ background:#c0392b; color:#fff; }
  .sync-nuclear .snuc-pull:hover{ background:#e04a3a; }
  .sync-nuclear .snuc-escape{ background:#262323; color:#bdbdbd; border-color:#444; font-weight:500; }
  .sync-nuclear .snuc-escape:hover{ background:#302c2c; color:#dadada; }

  /* ── S5.3 — non-blocking "unpropagated work" leave reminder ───────────
     A calm sticky note shown when the author steps away from the editor
     (tab hidden / window blur / pagehide) while L is AHEAD of A — i.e.
     there's local work that hasn't been pushed. Unlike the nuclear overlay
     this does NOT block: it's an opt-in nudge ("push before you forget"),
     stacked just above the push/pull buttons, dismissible, re-armed each
     load. Amber accent = attention, not alarm — pushing is reversible, so
     no danger-red here. Touch-sized button + × for the tablet editor. */
  .sync-leave-toast{ position:fixed; right:8px; bottom:102px; z-index:9999;
    width:min(290px,calc(100vw - 16px)); box-sizing:border-box;
    background:#232020; border:1px solid #5a4a2a; border-left:3px solid #f5c518;
    border-radius:8px; box-shadow:0 8px 26px rgba(0,0,0,.5);
    color:#ececec; padding:12px 12px 12px 13px;
    font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif; }
  .sync-leave-toast[hidden]{ display:none; }
  .sync-leave-toast .slt-head{ display:flex; align-items:flex-start; gap:8px; }
  .sync-leave-toast .slt-title{ font-weight:700; color:#f5c518; flex:1; }
  .sync-leave-toast .slt-x{ flex:none; appearance:none; -webkit-appearance:none;
    background:transparent; border:0; color:#9a9a9a; cursor:pointer;
    font-size:18px; line-height:1; padding:2px; margin:-2px -2px 0 0;
    width:26px; height:26px; border-radius:5px;
    display:flex; align-items:center; justify-content:center; }
  .sync-leave-toast .slt-x:hover{ background:#322c2c; color:#dcdcdc; }
  .sync-leave-toast .slt-body{ color:#cfcfcf; margin:6px 0 11px; }
  .sync-leave-toast .slt-body b{ color:#fff; }
  .sync-leave-toast .slt-push{ width:100%; box-sizing:border-box;
    font:600 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#f5c518; color:#1c1c1c; border:1px solid transparent;
    padding:11px 14px; border-radius:7px; cursor:pointer; }
  .sync-leave-toast .slt-push:hover{ background:#ffd23b; }
</style>

<button id="sync-push-btn" class="sync-prop-btn" type="button"
        title="Push L → A — overwrites A's content (A is snapshotted first)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7"/>
  </svg>
  <span>Push&nbsp;→&nbsp;A</span>
</button>

<div id="sync-push-modal" class="sync-prop-modal" hidden role="dialog" aria-modal="true" aria-label="Push content to A">
  <div class="spm-backdrop" data-role="backdrop"></div>
  <div class="spm-panel">
    <div class="spm-title">Push&nbsp;<b>L → A</b></div>
    <div class="spm-body" data-role="body">Checking what would change on A…</div>
    <div class="spm-actions">
      <button type="button" class="spm-cancel"  data-role="cancel">Cancel</button>
      <button type="button" class="spm-confirm" data-role="confirm" disabled>Push to A</button>
    </div>
  </div>
</div>

<?php /* S4c.3 — primary in-app "Pull A → L" control + dark confirm modal.
        The reverse direction of Push: L FETCHES A's content (via the
        bearer-authed /sync/pull/A → A's /sync/export) and overwrites ITS
        OWN content/. Destructive to *this* machine, so the confirm is red
        and the copy says "overwrite THIS machine". L takes a mandatory
        pre-propagate snapshot of its own content first (the snapshot lands
        on the destination, which here is L). Flow mirrors Push:
        click → dry-run preview (what A would send) → confirm → real pull. */ ?>
<button id="sync-pull-btn" class="sync-prop-btn" type="button"
        title="Pull A → L — overwrites THIS machine's content (L is snapshotted first)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M19 12H5M11 18l-6-6 6-6"/>
  </svg>
  <span>Pull&nbsp;←&nbsp;A</span>
</button>

<div id="sync-pull-modal" class="sync-prop-modal" hidden role="dialog" aria-modal="true" aria-label="Pull content from A">
  <div class="spm-backdrop" data-role="backdrop"></div>
  <div class="spm-panel">
    <div class="spm-title">Pull&nbsp;<b class="danger">A → L</b></div>
    <div class="spm-body" data-role="body">Asking A what it would send…</div>
    <div class="spm-actions">
      <button type="button" class="spm-cancel"  data-role="cancel">Cancel</button>
      <button type="button" class="spm-confirm danger" data-role="confirm" disabled>Overwrite L with A</button>
    </div>
  </div>
</div>
<?php /* S5.2 — nuclear "A is ahead of L" blocking overlay. Shown by the
        poller whenever /sync/peer/A reports direction 'behind'. role=
        alertdialog (not dialog): it's an alert the user must resolve, not
        a routine dialog. No backdrop-click and no Esc dismissal — the
        only ways out are an explicit Pull (converge) or the deliberate
        escape-hatch button. Re-fires on every editor load (the dismissal
        is in-memory only, reset whenever direction leaves 'behind'). */ ?>
<div id="sync-nuclear" class="sync-nuclear" hidden role="alertdialog" aria-modal="true"
     aria-labelledby="snuc-title" aria-describedby="snuc-desc">
  <div class="snuc-panel">
    <div class="snuc-title" id="snuc-title">⚠ A is ahead of this machine</div>
    <div class="snuc-body" id="snuc-desc">
      <p>A (staging) has newer content than L. <b>Anything you edit here now
      would be overwritten</b> the next time you pull A → L — and edits made
      on L can’t be merged back into A.</p>
      <div class="snuc-stamps">
        <div><span class="snuc-k">A last edited</span><span class="snuc-v" data-role="peer-when">—</span></div>
        <div><span class="snuc-k">L last edited</span><span class="snuc-v" data-role="local-when">—</span></div>
      </div>
      <p class="snuc-advice">Pull A → L first so this machine matches A, then edit.</p>
    </div>
    <div class="snuc-actions">
      <button type="button" class="snuc-pull"   data-role="pull">Pull&nbsp;A → L&nbsp;now</button>
      <button type="button" class="snuc-escape" data-role="escape">I know what I’m doing — let me edit anyway</button>
    </div>
  </div>
</div>

<?php /* S5.3 — non-blocking "unpropagated work" leave reminder. Surfaced by
        the leave-intent handlers (visibilitychange→hidden / blur / pagehide)
        whenever the last poll reported direction 'ahead' (L has local work
        not yet on A). Opt-in and reversible — it never blocks the editor;
        the inline "Push L → A" reuses the S4b push preview→confirm flow.
        role=status + aria-live=polite: informational, not an alert. */ ?>
<div id="sync-leave-toast" class="sync-leave-toast" hidden role="status" aria-live="polite">
  <div class="slt-head">
    <span class="slt-title">Unpropagated work</span>
    <button type="button" class="slt-x" data-role="dismiss" aria-label="Dismiss reminder">×</button>
  </div>
  <div class="slt-body" data-role="msg">L has local work not yet on A.</div>
  <button type="button" class="slt-push" data-role="push">Push&nbsp;L → A</button>
</div>

<script>
(function () {
  // Self-contained polling — no framework deps so this snippet drops
  // cleanly into any editor template (draw, page, image-workshop).
  var el = document.getElementById('sync-peer-indicator');
  if (!el) return;
  var label = el.querySelector('[data-role="label"]');

  // S5.2 — shared hook to open the S4c pull preview modal from the
  // nuclear overlay. The pull flow lives inside its own conditional
  // block below; it assigns this once wired. Stays null if the pull
  // control isn't present (then the nuclear "Pull now" button no-ops
  // gracefully — the escape hatch still works).
  var openPull = null;

  // S5.3 — hook to open the push preview from the leave-reminder toast
  // (mirror of openPull). Assigned by the push control block below; stays
  // null if that control isn't present (then the toast's Push button no-ops
  // gracefully). `lastPeer` caches the most recent /sync/peer/A poll so the
  // leave-intent handlers can read direction/gap without re-fetching.
  var openPush = null;
  var lastPeer = null;

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
  //   ok    — calm dark pill: EQUAL (converged), or AHEAD but stale
  //   warn  — yellow: AHEAD with recent local work (push when done)
  //   error — red: BEHIND (A ahead — pull before editing), or unreachable
  // S5.1 maps the server-computed `direction` (ahead/behind/equal, from
  // THIS node's perspective) onto these; see poll() below.
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

  // S5.1 — text is now the full, self-contained relationship summary
  // (the messages name A where it matters), so no fixed "A:" prefix.
  function setLabel(text, state) {
    label.textContent = text;
    var s = STYLES[state] || STYLES.ok;
    el.style.background = s.bg;
    el.style.color = s.fg;
  }

  // ── S5.2 — nuclear overlay machinery ──────────────────────────────
  var nuc        = document.getElementById('sync-nuclear');
  var nucPeerWhen  = nuc && nuc.querySelector('[data-role="peer-when"]');
  var nucLocalWhen = nuc && nuc.querySelector('[data-role="local-when"]');
  var nucPull    = nuc && nuc.querySelector('[data-role="pull"]');
  var nucEscape  = nuc && nuc.querySelector('[data-role="escape"]');
  // In-memory only: the escape hatch suppresses the overlay for the
  // current "behind" episode (this page load). Reset whenever direction
  // leaves 'behind', so a NEW behind episode re-arms it; and gone on
  // reload, so the overlay re-fires on every editor load (the spec).
  var nuclearDismissed = false;

  // Relative + absolute rendering of a stamp for the nuclear panel.
  function formatWhen(iso) {
    if (!iso) return 'never';
    var rel = relTime(iso);
    var d = new Date(iso);
    if (isNaN(d.getTime())) return rel;
    return rel + ' · ' + d.toLocaleString();
  }

  // Show/hide the overlay from the polled peer JSON. Only ever shown for
  // direction 'behind' (A ahead of L). Any other direction converges the
  // state and re-arms the escape hatch.
  function applyNuclear(j) {
    if (!nuc) return;
    if (j && j.direction === 'behind') {
      if (nuclearDismissed) return;            // suppressed this episode
      if (nucPeerWhen)  nucPeerWhen.textContent  = formatWhen(j.peerAt);
      if (nucLocalWhen) nucLocalWhen.textContent = formatWhen(j.localAt);
      nuc.hidden = false;
    } else {
      nuclearDismissed = false;                // re-arm for a future behind
      nuc.hidden = true;
    }
  }

  if (nuc && nucPull) {
    nucPull.addEventListener('click', function () {
      // Reuse the S4c pull preview→confirm flow. The pull modal (z 10001)
      // opens above this overlay (z 10000); on a successful pull the pull
      // handler re-polls, direction flips to 'equal', and applyNuclear
      // hides this overlay. No-op (but the escape hatch still works) if
      // the pull control isn't wired on this page.
      if (openPull) openPull();
    });
  }
  if (nuc && nucEscape) {
    nucEscape.addEventListener('click', function () {
      nuclearDismissed = true;
      nuc.hidden = true;
    });
  }

  // ── S5.3 — "unpropagated work" leave reminder ──────────────────────
  var toast     = document.getElementById('sync-leave-toast');
  var toastMsg  = toast && toast.querySelector('[data-role="msg"]');
  var toastX    = toast && toast.querySelector('[data-role="dismiss"]');
  var toastPush = toast && toast.querySelector('[data-role="push"]');
  // Per-load: the × suppresses the toast until the next page load (and is
  // re-armed early whenever direction leaves 'ahead' — e.g. after a push
  // converges to equal — so a fresh ahead-episode can nudge again).
  var toastDismissed = false;

  // Humanise a gap in seconds as an approximate duration. Output is plain
  // ASCII (~Nmin / ~Nh / ~Nd / "under a minute") — safe to drop into HTML
  // without escaping.
  function fmtGap(sec) {
    if (sec == null) return null;
    if (sec < 60)    return 'under a minute';
    if (sec < 3600)  return '~' + Math.round(sec / 60) + 'min';
    if (sec < 86400) return '~' + Math.round(sec / 3600) + 'h';
    return '~' + Math.round(sec / 86400) + 'd';
  }

  // Show the reminder iff L is currently ahead and it wasn't dismissed this
  // load. Called from the leave-intent handlers; reads the cached last poll.
  function maybeShowLeaveToast() {
    if (!toast || toastDismissed) return;
    if (!lastPeer || lastPeer.direction !== 'ahead') return;
    if (toastMsg) {
      var gap = fmtGap(lastPeer.gapSeconds);
      toastMsg.innerHTML = gap
        ? 'L is <b>' + gap + '</b> ahead of A — push before you forget?'
        : 'L has local work <b>not yet on A</b> — push before you forget?';
    }
    toast.hidden = false;
  }
  function hideLeaveToast() { if (toast) toast.hidden = true; }

  if (toastX)    toastX.addEventListener('click', function () {
    toastDismissed = true; hideLeaveToast();
  });
  if (toastPush) toastPush.addEventListener('click', function () {
    if (openPush) openPush();   // reuse the S4b push preview→confirm flow
  });

  function poll() {
    fetch('/sync/peer/A', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j || !j.ok || !j.state) {
          setLabel('A unreachable', 'error');
          return;
        }
        lastPeer = j;   // S5.3 — cache for the leave-intent handlers
        // S5.1 — drive the pill off the server-computed direction (this
        // node's perspective). 'ahead' = L has unpropagated work; 'behind'
        // = A is ahead of L (danger: editing now would be lost on the next
        // pull); 'equal' = converged. Fall back to the old recency check
        // only if a stale server somehow omits `direction`.
        var dir = j.direction;
        if (dir === 'behind') {
          // A is ahead — the dangerous state. Red pill now; the blocking
          // nuclear modal lands in S5.2.
          setLabel('A ahead — pull before editing', 'error');
        } else if (dir === 'ahead') {
          // L is ahead. Gently flag when local work is recent (you'll want
          // to push soon); otherwise stay calm.
          var lage = ageSeconds(j.localAt);
          var st = (lage !== null && lage <= WARN_THRESHOLD_SECONDS) ? 'warn' : 'ok';
          setLabel("you're ahead — push when done", st);
        } else if (dir === 'equal') {
          setLabel('in sync', 'ok');
        } else {
          // Legacy/unknown shape — preserve prior behaviour.
          var iso = j.state.lastActivityAt;
          var age = ageSeconds(iso);
          var state = (age !== null && age <= WARN_THRESHOLD_SECONDS) ? 'warn' : 'ok';
          setLabel('A active ' + relTime(iso), state);
        }
        applyNuclear(j);   // S5.2 — block the editor when A is ahead
        // S5.3 — once L is no longer ahead (pushed → equal, or A pulled
        // ahead → behind), the reminder is moot: hide it and re-arm the
        // dismiss so a future ahead-episode can nudge again.
        if (j.direction !== 'ahead') { toastDismissed = false; hideLeaveToast(); }
      })
      .catch(function () { setLabel('A unreachable', 'error'); });
  }

  poll();
  // Refresh once a minute. Cheap — A's /sync/state is just a JSON
  // file read on the server side.
  setInterval(poll, 60000);
  // Refresh immediately when the editor tab gets focus / becomes
  // visible — the moment you switch back from another tool is when
  // a stale indicator is most misleading.
  window.addEventListener('focus', poll);
  // visibilitychange does double duty: becoming visible re-polls (a stale
  // pill is most misleading right when you switch back); becoming hidden is
  // a leave-intent signal for the S5.3 reminder.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) poll();
    else maybeShowLeaveToast();
  });
  // S5.3 — other ways of stepping away: app/window switch (blur) and
  // navigation / bfcache (pagehide). Each surfaces the leave reminder when
  // L is ahead, so it's waiting when the author returns to the editor.
  window.addEventListener('blur', maybeShowLeaveToast);
  window.addEventListener('pagehide', maybeShowLeaveToast);

  // ── S4b.4 — "Push L → A" control ──────────────────────────────────
  // Two-step: a dry-run preview (no snapshot, no swap) populates the
  // modal with what WOULD change on A; confirm then fires the real push.
  // Keyboard: Enter = confirm (when armed & visible), Esc = close —
  // matching the project's dialog key-default convention.
  var pushBtn   = document.getElementById('sync-push-btn');
  var modal     = document.getElementById('sync-push-modal');
  if (pushBtn && modal) {
    var mBody    = modal.querySelector('[data-role="body"]');
    var mConfirm = modal.querySelector('[data-role="confirm"]');
    var mCancel  = modal.querySelector('[data-role="cancel"]');
    var mBack    = modal.querySelector('[data-role="backdrop"]');
    var busy     = false;

    function esc(s){ return String(s).replace(/[&<>]/g, function(c){
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]; }); }
    function fmtBytes(n){
      if (n == null) return '?';
      if (n < 1024) return n + ' B';
      if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
      return (n/1048576).toFixed(2) + ' MB';
    }
    function showError(msg){
      mBody.innerHTML = '<span class="spm-warn">✗ ' + esc(msg).replace(/\n/g, '<br>') + '</span>';
      mConfirm.disabled = true;
    }
    // Build a diagnostic message from a failed push/dry-run response.
    // Surfaces the peer's HTTP status + a body snippet so "non-JSON
    // response" reveals e.g. a 404 error page (peer missing the
    // /sync/propagate route — usually an out-of-date deploy on A).
    function errMsg(j, fallback){
      if (!j) return fallback;
      var m = j.error || fallback;
      if (j.code) {
        m += ' (HTTP ' + j.code + ')';
        if (j.code === 404) m += ' — A has no /sync/propagate route; deploy current code to A.';
      }
      if (j.body) {
        var snip = String(j.body).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (snip) m += '\n' + snip;
      }
      return m;
    }
    function resetModal(){
      mConfirm.style.display = '';
      mConfirm.textContent = 'Push to A';
      mConfirm.disabled = true;
      mCancel.textContent = 'Cancel';
      mCancel.disabled = false;
    }
    function closeModal(){ if (busy) return; resetModal(); modal.hidden = true; }

    // Step 1 — dry-run preview.
    function preview(){
      busy = true;
      resetModal();
      mBody.textContent = 'Checking what would change on A…';
      modal.hidden = false;
      fetch('/sync/push/A?dryRun=1', { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          busy = false;
          if (!j || !j.ok){ showError(errMsg(j, 'dry-run failed')); return; }
          var w = j.wouldReplace || {};
          var sent = (j.sent && j.sent.bytes != null) ? fmtBytes(j.sent.bytes) : '?';
          mBody.innerHTML =
            'This will <span class="spm-warn">overwrite A’s content</span> with L’s:<br>'
            + '<b>' + (w.pages||0) + '</b> pages · <b>' + (w.files||0) + '</b> files · '
            + fmtBytes(w.bytes) + ' <span style="opacity:.8">(' + sent + ' gzipped on the wire)</span>.<br>'
            + 'A snapshot of A’s current content is taken first.';
          mConfirm.disabled = false;
        })
        .catch(function(){ busy = false; showError('network error'); });
    }

    // Step 2 — real push.
    function doPush(){
      if (busy || mConfirm.disabled) return;
      busy = true;
      mConfirm.disabled = true; mCancel.disabled = true;
      mConfirm.textContent = 'Pushing…';
      mBody.textContent = 'Pushing content to A…';
      fetch('/sync/push/A', { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          busy = false; mCancel.disabled = false; mCancel.textContent = 'Close';
          mConfirm.style.display = 'none';
          if (!j || !j.ok){ showError(errMsg(j, 'push failed')); return; }
          var r = j.replaced || {};
          mBody.innerHTML =
            '<span class="spm-ok">✓ Pushed to A.</span><br>'
            + 'A now has <b>' + (r.pages||0) + '</b> pages · <b>' + (r.files||0) + '</b> files.<br>'
            + 'Snapshot: <b>' + esc(j.snapshot || '?') + '</b>';
          poll();   // refresh the peer-activity pill — A just changed
        })
        .catch(function(){
          busy = false; mCancel.disabled = false; mCancel.textContent = 'Close';
          mConfirm.style.display = 'none'; showError('network error during push');
        });
    }

    // S5.3 — expose the preview opener so the leave-reminder toast's
    // "Push L → A" button reuses this exact flow.
    openPush = preview;

    pushBtn.addEventListener('click', preview);
    mConfirm.addEventListener('click', doPush);
    mCancel.addEventListener('click', closeModal);
    mBack.addEventListener('click', closeModal);
    document.addEventListener('keydown', function(e){
      if (modal.hidden) return;
      if (e.key === 'Escape'){ e.preventDefault(); closeModal(); }
      else if (e.key === 'Enter' && !mConfirm.disabled && mConfirm.style.display !== 'none'){
        e.preventDefault(); doPush();
      }
    });
  }

  // ── S4c.3 — "Pull A → L" control ──────────────────────────────────
  // Mirror of Push, reversed: L fetches A's content and overwrites ITS
  // OWN content/. Reuses esc()/fmtBytes() from the closure above. The
  // dry-run reports A's `wouldSend` (what L would receive), NOT the push
  // shape's `wouldReplace`; the real pull returns the same `replaced` +
  // `snapshot` shape as a push (both go through sync_ingest_content_tarball).
  var pullBtn   = document.getElementById('sync-pull-btn');
  var pullModal = document.getElementById('sync-pull-modal');
  if (pullBtn && pullModal) {
    var pBody    = pullModal.querySelector('[data-role="body"]');
    var pConfirm = pullModal.querySelector('[data-role="confirm"]');
    var pCancel  = pullModal.querySelector('[data-role="cancel"]');
    var pBack    = pullModal.querySelector('[data-role="backdrop"]');
    var pBusy    = false;

    // Same diagnostic shape as the push errMsg, but the 404 hint points
    // at /sync/export (the route A serves for a pull) rather than
    // /sync/propagate.
    function pErrMsg(j, fallback){
      if (!j) return fallback;
      var m = j.error || fallback;
      if (j.code){
        m += ' (HTTP ' + j.code + ')';
        if (j.code === 404) m += ' — A has no /sync/export route; deploy current code to A.';
      }
      if (j.body){
        var snip = String(j.body).replace(/\s+/g, ' ').trim().slice(0, 120);
        if (snip) m += '\n' + snip;
      }
      return m;
    }
    function pShowError(msg){
      pBody.innerHTML = '<span class="spm-warn">✗ ' + esc(msg).replace(/\n/g, '<br>') + '</span>';
      pConfirm.disabled = true;
    }
    function pReset(){
      pConfirm.style.display = '';
      pConfirm.textContent = 'Overwrite L with A';
      pConfirm.disabled = true;
      pCancel.textContent = 'Cancel';
      pCancel.disabled = false;
    }
    function pClose(){ if (pBusy) return; pReset(); pullModal.hidden = true; }

    // Step 1 — dry-run preview: ask A (via L's pull proxy) what it WOULD send.
    function pPreview(){
      pBusy = true;
      pReset();
      pBody.textContent = 'Asking A what it would send…';
      pullModal.hidden = false;
      fetch('/sync/pull/A?dryRun=1', { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          pBusy = false;
          if (!j || !j.ok){ pShowError(pErrMsg(j, 'dry-run failed')); return; }
          var w = j.wouldSend || {};
          pBody.innerHTML =
            'This will <span class="spm-warn">overwrite THIS machine’s content</span> with A’s:<br>'
            + '<b>' + (w.pages||0) + '</b> pages · <b>' + (w.files||0) + '</b> files · ' + fmtBytes(w.bytes) + '.<br>'
            + 'A snapshot of L’s current content is taken first.';
          pConfirm.disabled = false;
        })
        .catch(function(){ pBusy = false; pShowError('network error'); });
    }

    // Step 2 — real pull.
    function pDoPull(){
      if (pBusy || pConfirm.disabled) return;
      pBusy = true;
      pConfirm.disabled = true; pCancel.disabled = true;
      pConfirm.textContent = 'Pulling…';
      pBody.textContent = 'Fetching A’s content and applying locally…';
      fetch('/sync/pull/A', { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          pBusy = false; pCancel.disabled = false; pCancel.textContent = 'Close';
          pConfirm.style.display = 'none';
          if (!j || !j.ok){ pShowError(pErrMsg(j, 'pull failed')); return; }
          var r = j.replaced || {};
          pBody.innerHTML =
            '<span class="spm-ok">✓ Pulled A → L.</span><br>'
            + 'L now has <b>' + (r.pages||0) + '</b> pages · <b>' + (r.files||0) + '</b> files.<br>'
            + 'Snapshot: <b>' + esc(j.snapshot || '?') + '</b><br>'
            + '<span style="opacity:.8">Reload the editor to see A’s content.</span>';
          // S5.2 — L just adopted A's stamp; re-poll so the pill flips to
          // 'equal' and the nuclear overlay (if it triggered this pull)
          // clears itself.
          poll();
        })
        .catch(function(){
          pBusy = false; pCancel.disabled = false; pCancel.textContent = 'Close';
          pConfirm.style.display = 'none'; pShowError('network error during pull');
        });
    }

    // S5.2 — expose the preview opener so the nuclear overlay's
    // "Pull A → L now" button reuses this exact flow.
    openPull = pPreview;

    pullBtn.addEventListener('click', pPreview);
    pConfirm.addEventListener('click', pDoPull);
    pCancel.addEventListener('click', pClose);
    pBack.addEventListener('click', pClose);
    document.addEventListener('keydown', function(e){
      if (pullModal.hidden) return;
      if (e.key === 'Escape'){ e.preventDefault(); pClose(); }
      else if (e.key === 'Enter' && !pConfirm.disabled && pConfirm.style.display !== 'none'){
        e.preventDefault(); pDoPull();
      }
    });
  }
})();
</script>
