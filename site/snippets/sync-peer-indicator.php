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

// ── A-side informational pill ────────────────────────────────────────
// A (and B) cannot reach L over the network, but L pings its
// lastActivityAt to A on every save, so A already knows when L was last
// authored. GET /sync/self compares A's own activity against that stored
// stamp and returns ahead/behind/equal. A is PASSIVE in the L↔A
// relationship — L drives both push (L→A) and pull (A→L) — so this pill
// only INFORMS ("L is ahead — newer work upstream"); it carries no
// controls. The L code further below is left entirely untouched.
if ($role === 'A'):
?>
<div id="sync-self-indicator"
     style="position:fixed;bottom:8px;right:8px;z-index:9999;
            font:11px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;
            background:#2a2a2a;color:#fff;
            padding:4px 8px;border-radius:4px;
            pointer-events:none;user-select:none;
            transition:background-color 0.2s, color 0.2s;">
  <span data-role="label">L: …</span>
</div>
<script>
(function(){
  var el = document.getElementById('sync-self-indicator');
  if (!el) return;
  var label = el.querySelector('[data-role="label"]');
  // Same calm-dark-pill + coloured-TEXT scheme as L's indicator: amber
  // #f5c518 for "attention" (L has work not yet here / A is ahead), white
  // for converged, red #ff8d7a only for a genuine read failure.
  var STYLES = {
    ok:    { bg:'#2a2a2a', fg:'#ffffff' },
    amber: { bg:'#2a2a2a', fg:'#f5c518' },
    error: { bg:'#2a2a2a', fg:'#ff8d7a' }
  };
  function setLabel(text, s){
    label.textContent = text;
    var c = STYLES[s] || STYLES.ok;
    el.style.background = c.bg; el.style.color = c.fg;
  }
  function poll(){
    // Local route — no outbound request to L. Reads peerStamps['L'] that
    // L's save-time pings deposited on this node.
    fetch('/sync/self', { cache:'no-store' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false }; }); })
      .then(function(j){
        if (!j || !j.ok){ setLabel('sync state unavailable', 'error'); return; }
        var dir = j.direction;
        if (dir === 'behind')     setLabel('L is ahead — newer work upstream', 'amber');
        else if (dir === 'ahead') setLabel('ahead of L — L can pull', 'amber');
        else if (dir === 'equal') setLabel('in sync with L', 'ok');
        else                      setLabel('L: state unknown', 'ok');
      })
      .catch(function(){ setLabel('sync state unavailable', 'error'); });
  }
  poll();
  setInterval(poll, 60000);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) poll(); });
})();
</script>

<?php /* ── 2060 — "Publish A → B" control (publish epic, Slice 2) ──────────
        A is the SINGLE physical source of B's content (provenance rule:
        B is only ever written by A; there is no L→B). This button is the
        local trigger for that A→B propagate. It mirrors L's "Push L → A"
        flow exactly (dry-run preview → confirm → real push) but targets
        /sync/push/B. The route is reachable here because A's editor lives
        under the Panel-gated /dev surface, so the same-origin fetch carries
        the session cookie and clears the v0.10.252 public-node guard.

        Self-contained on purpose: the CSS below duplicates the minimal
        button+modal rules from L's branch rather than hoisting shared CSS,
        keeping L's validated UI untouched (the informational pill above is
        already duplicated the same way). Only the classes this control needs
        are included — no nuclear overlay, no is-ahead/is-behind tinting. */ ?>
<style>
  .sync-prop-btn{
    position:fixed; right:8px; bottom:34px; z-index:9999;
    font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#2a2a2a; color:#fff; border:1px solid #3d3d3d;
    padding:7px 11px; border-radius:6px; cursor:pointer;
    display:inline-flex; align-items:center; gap:6px;
    min-width:6.5rem; justify-content:flex-start; box-sizing:border-box;
    transition:background-color .15s, border-color .15s;
  }
  .sync-prop-btn:hover{ background:#343434; border-color:#4a4a4a; }
  .sync-prop-btn:disabled{ opacity:.55; cursor:default; }
  .sync-prop-btn svg{ width:14px; height:14px; display:block; }
  /* Publishing to the PUBLIC site is the heaviest action this node offers —
     give the button a steady amber tint so it never blends into chrome. */
  #sync-publish-btn{ border-color:#6a5a1f; }
  #sync-publish-btn:hover{ background:#343012; border-color:#8a7420; }

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
  .sync-prop-modal .spm-body{ color:#cfcfcf; min-height:42px; }
  .sync-prop-modal .spm-body b{ color:#fff; }
  .sync-prop-modal .spm-body .spm-warn{ color:#ff8d7a; }
  .sync-prop-modal .spm-body .spm-ok{ color:#7ddca0; }
  .sync-prop-modal .spm-body .spm-unsaved{
    color:#f5c518; background:#2e2818; border:1px solid #6a5a1f;
    border-radius:6px; padding:8px 10px; margin-bottom:10px; line-height:1.4;
  }
  .sync-prop-modal .spm-body .spm-unsaved b{ color:#ffe08a; }
  /* 2070 Slice 3a — B-state publish guard. Red block banner when B is unlocked
     or ahead of A (publishing would clobber B's own edits); amber "warn" when
     B's lock state couldn't be verified (allow-on-unknown — we don't fail
     closed, but we say so). */
  .sync-prop-modal .spm-body .spm-guard{
    color:#ffb3a6; background:#2e1714; border:1px solid #7a2f26;
    border-radius:6px; padding:9px 11px; margin-bottom:10px; line-height:1.45;
  }
  .sync-prop-modal .spm-body .spm-guard b{ color:#ffd2c8; }
  .sync-prop-modal .spm-body .spm-guard.warn{
    color:#f5c518; background:#2e2818; border-color:#6a5a1f;
  }
  .sync-prop-modal .spm-body .spm-guard.warn b{ color:#ffe08a; }
  .sync-prop-modal .spm-actions{ display:flex; justify-content:flex-end; gap:8px; margin-top:16px; }
  .sync-prop-modal button{ font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    padding:8px 13px; border-radius:6px; cursor:pointer; border:1px solid transparent; }
  .sync-prop-modal .spm-cancel{ background:#2e2e2e; color:#ddd; border-color:#444; }
  .sync-prop-modal .spm-cancel:hover{ background:#383838; }
  .sync-prop-modal .spm-confirm{ background:#f5c518; color:#1c1c1c; }
  .sync-prop-modal .spm-confirm:hover{ background:#ffd23b; }
  .sync-prop-modal .spm-confirm:disabled{ opacity:.45; cursor:default; }
  /* Publish-anyway escape hatch — danger fill, mirrors L's pull-danger confirm. */
  .sync-prop-modal .spm-confirm.danger{ background:#c0392b; color:#fff; }
  .sync-prop-modal .spm-confirm.danger:hover{ background:#e04a3a; }
</style>

<button id="sync-publish-btn" class="sync-prop-btn" type="button"
        title="Publish A → B — copies A's content to the PUBLIC site (B is snapshotted first)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 19V5M5 12l7-7 7 7"/>
  </svg>
  <span>Publish&nbsp;→&nbsp;B</span>
</button>

<div id="sync-publish-modal" class="sync-prop-modal" hidden role="dialog" aria-modal="true" aria-label="Publish content to B">
  <div class="spm-backdrop" data-role="backdrop"></div>
  <div class="spm-panel">
    <div class="spm-title">Publish&nbsp;<b>A → B</b></div>
    <div class="spm-body" data-role="body">Checking what would change on B…</div>
    <div class="spm-actions">
      <button type="button" class="spm-cancel"  data-role="cancel">Cancel</button>
      <button type="button" class="spm-confirm" data-role="confirm" disabled>Publish to B</button>
    </div>
  </div>
</div>

<script>
(function(){
  // Self-contained publish flow — mirrors L's push closure but targets B
  // via /sync/push/B. A→B is the only physical path that writes B.
  var pubBtn   = document.getElementById('sync-publish-btn');
  var modal    = document.getElementById('sync-publish-modal');
  if (!pubBtn || !modal) return;
  var mBody    = modal.querySelector('[data-role="body"]');
  var mConfirm = modal.querySelector('[data-role="confirm"]');
  var mCancel  = modal.querySelector('[data-role="cancel"]');
  var mBack    = modal.querySelector('[data-role="backdrop"]');
  var busy     = false;
  var forced   = false;   // Slice 3a — B-guard escape hatch armed this open

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
  function errMsg(j, fallback){
    if (!j) return fallback;
    var m = j.error || fallback;
    if (j.code){
      m += ' (HTTP ' + j.code + ')';
      if (j.code === 404) m += ' — B has no /sync/propagate route; deploy current code to B.';
    }
    if (j.body){
      var snip = String(j.body).replace(/\s+/g, ' ').trim().slice(0, 120);
      if (snip) m += '\n' + snip;
    }
    return m;
  }
  // Unsaved-editor-data warning — a publish sends A's content AS ON DISK;
  // unsaved in-editor edits on A wouldn't travel to B.
  function unsavedNote(){
    try {
      if (typeof window.edHasUnsavedData === 'function' && window.edHasUnsavedData()) {
        return '<div class="spm-unsaved">⚠ You have <b>local unsaved data</b> on A. '
          + 'Publishing sends only what’s saved to disk — unsaved edits won’t reach B. '
          + 'Save first to include them.</div>';
      }
    } catch (e) {}
    return '';
  }
  // Slice 3a — B-state guard banner from the dry-run's `bGuard` (server probed
  // B's /sync/b-status). Returns '' when B is safe to overwrite (frozen, equal).
  //   block (unlocked / B-ahead) → RED banner; publishing clobbers B's own edits.
  //   !reachable                 → amber WARN banner (allow-on-unknown: we don't
  //                                fail closed, but we say we couldn't verify).
  function guardBanner(g){
    if (!g || !g.applicable) return '';
    if (g.block){
      var why = (g.ahead && g.unlocked) ? 'is <b>unlocked and holds edits A doesn’t have</b>'
              : g.ahead                 ? 'holds <b>edits A doesn’t have</b> (B is ahead)'
              :                           'is currently <b>unlocked for direct editing</b>';
      return '<div class="spm-guard">⛔ <b>B ' + why + '.</b> '
        + 'Publishing A → B would <b>overwrite B’s own edits</b>. '
        + 'Back-propagate B → A and re-freeze B first — or use <b>Publish anyway</b> to '
        + 'discard B’s edits (B is snapshotted, so it’s recoverable).</div>';
    }
    if (!g.reachable){
      return '<div class="spm-guard warn">⚠ Couldn’t verify B’s lock state'
        + (g.error ? ' (' + esc(g.error) + ')' : '') + '. '
        + 'Publishing is allowed but unverified — if B was unlocked, its edits would be overwritten.</div>';
    }
    return '';
  }
  // Arm/disarm the escape hatch: a blocking guard turns the confirm into a
  // red "Publish anyway" (force=1); otherwise the normal amber confirm.
  function armForce(block){
    forced = !!block;
    if (block){
      mConfirm.textContent = 'Publish anyway';
      mConfirm.classList.add('danger');
    } else {
      mConfirm.textContent = 'Publish to B';
      mConfirm.classList.remove('danger');
    }
  }
  function resetModal(){
    mConfirm.style.display = '';
    mConfirm.textContent = 'Publish to B';
    mConfirm.classList.remove('danger');
    mConfirm.disabled = true;
    mCancel.textContent = 'Cancel';
    mCancel.disabled = false;
    forced = false;
  }
  function closeModal(){ if (busy) return; resetModal(); modal.hidden = true; }

  // Step 1 — dry-run preview (what would change on B; no snapshot, no swap).
  function preview(){
    busy = true; resetModal();
    mBody.textContent = 'Checking what would change on B…';
    modal.hidden = false;
    fetch('/sync/push/B?dryRun=1', { method:'POST', cache:'no-store' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
      .then(function(j){
        busy = false;
        if (!j || !j.ok){ showError(errMsg(j, 'dry-run failed')); return; }
        var w = j.wouldReplace || {};
        var sent = (j.sent && j.sent.bytes != null) ? fmtBytes(j.sent.bytes) : '?';
        var g = j.bGuard;
        mBody.innerHTML =
          guardBanner(g)
          + unsavedNote()
          + 'This will <span class="spm-warn">overwrite the PUBLIC site (B)</span> with A’s content:<br>'
          + '<b>' + (w.pages||0) + '</b> pages · <b>' + (w.files||0) + '</b> files · '
          + fmtBytes(w.bytes) + ' <span style="opacity:.8">(' + sent + ' gzipped on the wire)</span>.<br>'
          + 'A snapshot of B’s current content is taken first.';
        armForce(g && g.block);   // blocking guard → red "Publish anyway" (force)
        mConfirm.disabled = false;
      })
      .catch(function(){ busy = false; showError('network error'); });
  }

  // Step 2 — real publish. `force=1` only when the dry-run armed the escape
  // hatch (B unlocked / ahead) and the author chose "Publish anyway".
  function doPublish(){
    if (busy || mConfirm.disabled) return;
    busy = true;
    mConfirm.disabled = true; mCancel.disabled = true;
    mConfirm.textContent = forced ? 'Publishing anyway…' : 'Publishing…';
    mBody.textContent = 'Publishing A → B…';
    fetch('/sync/push/B' + (forced ? '?force=1' : ''), { method:'POST', cache:'no-store' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
      .then(function(j){
        // Defense-in-depth: the server can still 409 with a fresh bGuard (B's
        // state changed between dry-run and now). Re-arm the escape hatch and
        // let the author confirm again rather than dead-ending.
        if (j && j.code === 409 && j.bGuard){
          busy = false; mCancel.disabled = false;
          mBody.innerHTML = guardBanner(j.bGuard);
          armForce(true); mConfirm.disabled = false;
          return;
        }
        busy = false; mCancel.disabled = false; mCancel.textContent = 'Close';
        mConfirm.style.display = 'none';
        if (!j || !j.ok){ showError(errMsg(j, 'publish failed')); return; }
        var r = j.replaced || {};
        mBody.innerHTML =
          '<span class="spm-ok">✓ Published to B (public).</span><br>'
          + 'B now has <b>' + (r.pages||0) + '</b> pages · <b>' + (r.files||0) + '</b> files.<br>'
          + 'Snapshot: <b>' + esc(j.snapshot || '?') + '</b>';
      })
      .catch(function(){
        busy = false; mCancel.disabled = false; mCancel.textContent = 'Close';
        mConfirm.style.display = 'none'; showError('network error during publish');
      });
  }

  pubBtn.addEventListener('click', preview);
  mConfirm.addEventListener('click', doPublish);
  mCancel.addEventListener('click', closeModal);
  mBack.addEventListener('click', closeModal);
  document.addEventListener('keydown', function(e){
    if (modal.hidden) return;
    if (e.key === 'Escape'){ e.preventDefault(); closeModal(); }
    else if (e.key === 'Enter' && !mConfirm.disabled && mConfirm.style.display !== 'none'){
      e.preventDefault(); doPublish();
    }
  });
})();
</script>
<?php
return;  // A: informational pill + Publish A→B control. No push/pull (L-only).
endif;

/* ── 2080 S2b — B freeze / unlock control (PUBLIC node only) ───────────────
   B is frozen by default (server: sync_assert_writable → 423 on every /dev/*
   write). This pill is the author's surface to UNLOCK B for a bounded window,
   BACK-PROPAGATE B→A (mandatory), and RE-FREEZE (gated behind the back-prop).
   Drives off GET /sync/b-status; every mutation is a Panel-gated
   POST /sync/{unlock,prolong,backprop,refreeze}-b (S2a). Self-contained CSS/JS,
   same convention as the A/L branches. COMPACT in the common (frozen) state —
   just "🔒 B" + Unlock; the action cluster only appears while unlocked (rare),
   keeping the bottom-right corner light. Touch-first sizing per the tablet
   north star. */
if ($role === 'B'):
?>
<style>
  /* Horizontal bar glued to the bottom-right corner (survives editor scroll).
     Flush right rather than centred so it reads as a status strip, not a
     modal banner — less intrusive over the canvas. Keeps the calm dark bg +
     outline; layout is row not column to stop eating vertical space.
     Order L→R: lock+timer · hint · Back B→A · Prolong · Re-freeze. */
  #sync-b-pill{
    position:fixed; right:14px; bottom:0; z-index:9999;
    font:600 12px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#2a2a2a; color:#fff; border:1px solid #3d3d3d; border-bottom:none;
    border-radius:10px 10px 0 0; padding:7px 14px; box-sizing:border-box;
    display:flex; flex-direction:row; align-items:center; gap:14px;
    max-width:96vw;
    transition:background-color .15s, border-color .15s, color .15s;
  }
  #sync-b-pill .sbp-head{ display:flex; align-items:center; gap:7px; white-space:nowrap; }
  #sync-b-pill .sbp-ico{ font-size:15px; line-height:1; }
  #sync-b-pill .sbp-label{ white-space:nowrap; }
  #sync-b-pill .sbp-timer{ color:#ffe08a; font-variant-numeric:tabular-nums; }
  /* Unlocked / pending-backprop → amber chrome so the rare writable state
     never blends into the editor. Frozen-clean → calm dark. */
  #sync-b-pill.is-unlocked{ border-color:#6a5a1f; background:#2e2818; }
  #sync-b-pill.is-pending{ border-color:#6a5a1f; background:#2e2818; }
  /* Actions in a horizontal cluster on the right of the bar. */
  #sync-b-pill .sbp-actions{ display:flex; flex-direction:row; align-items:center; gap:8px; }
  /* Touch-first: ≥40px tall tap targets, icon+label. */
  #sync-b-pill button{
    font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    min-height:40px; padding:0 12px; border-radius:7px; cursor:pointer;
    background:#343434; color:#fff; border:1px solid #4a4a4a;
    display:inline-flex; align-items:center; gap:6px;
    transition:background-color .12s, border-color .12s, opacity .12s;
  }
  #sync-b-pill button:hover{ background:#3d3d3d; border-color:#585858; }
  #sync-b-pill button:disabled{ opacity:.5; cursor:default; }
  #sync-b-pill button.sbp-primary{ background:#3a3212; border-color:#6a5a1f; color:#ffe08a; }
  #sync-b-pill button.sbp-primary:hover{ background:#463c16; border-color:#8a7420; }
  #sync-b-pill button.sbp-danger{ border-color:#7a3a30; }
  /* Re-freeze, while gated by un-back-propagated B edits, is STRUCK THROUGH —
     an unusual treatment chosen on purpose to read as "intentionally inhibited",
     not merely greyed-out-broken. Higher specificity than the generic :disabled
     rule, so it stays legible (not faded to .5) while clearly non-actionable. */
  #sync-b-pill button.sbp-refreeze:disabled{
    opacity:.9; cursor:default; text-decoration:line-through;
    color:#c9b97a; border-color:#6a5a1f; background:#2c2814;
  }
  /* Back B→A pill — five visual states off two axes (on-disk direction ×
     unsaved editor buffer). "light" = amber/red TEXT+OUTLINE on dark; "full"
     = saturated amber/red BACKGROUND (a stronger call-to-action / stronger
     stop). See render()'s backVisual() for the state→class mapping. */
  #sync-b-pill button.sbp-amber-light{ background:#2e2818; border-color:#8a7420; color:#ffd966; }
  #sync-b-pill button.sbp-amber-light:hover{ background:#372f17; border-color:#a78a26; }
  #sync-b-pill button.sbp-amber-full{ background:#f5c518; border-color:#f5c518; color:#1a1500; }
  #sync-b-pill button.sbp-amber-full:hover{ background:#ffd233; border-color:#ffd233; }
  #sync-b-pill button.sbp-red-light{ background:#2c1a17; border-color:#a04a3c; color:#ff9d8c; }
  #sync-b-pill button.sbp-red-light:hover{ background:#371f1b; border-color:#bd5747; }
  #sync-b-pill button.sbp-red-full{ background:#b53326; border-color:#b53326; color:#fff; }
  #sync-b-pill button.sbp-red-full:hover{ background:#c93a2b; border-color:#c93a2b; }
  /* State hint — now an inline bar item between the lock+timer and the actions
     (parallels L/A's hint text). Single line; wraps only if the viewport is tiny. */
  #sync-b-pill .sbp-hint{ font:600 11px/1.3 -apple-system,BlinkMacSystemFont,sans-serif;
    white-space:nowrap; max-width:22rem; }
  #sync-b-pill .sbp-hint[hidden]{ display:none; }
  #sync-b-pill .sbp-hint.sbh-gray{ color:#c4c4c4; }
  #sync-b-pill .sbp-hint.sbh-amber{ color:#ffd966; }
  #sync-b-pill .sbp-hint.sbh-red{ color:#ff8d7a; }

  .sb-modal{ position:fixed; inset:0; z-index:10001; display:flex;
    align-items:center; justify-content:center;
    font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif; }
  .sb-modal[hidden]{ display:none; }
  .sb-modal .sb-back{ position:absolute; inset:0; background:rgba(0,0,0,.6); }
  .sb-modal .sb-panel{ position:relative; width:min(440px,92vw);
    background:#202020; border:1px solid #3a3a3a; border-radius:12px;
    box-shadow:0 12px 40px rgba(0,0,0,.55); color:#ececec; padding:18px; }
  .sb-modal .sb-title{ font-size:15px; font-weight:600; color:#fff; margin-bottom:8px; }
  .sb-modal .sb-title b{ color:#f5c518; }
  .sb-modal .sb-body{ color:#cfcfcf; min-height:38px; }
  .sb-modal .sb-body b{ color:#fff; }
  .sb-modal .sb-body .sb-w{ color:#ff8d7a; }
  .sb-modal .sb-body .sb-ok{ color:#7ddca0; }
  .sb-modal .sb-body .sb-hint{ color:#ffe08a; }
  .sb-chips{ display:flex; gap:10px; margin:14px 0 4px; }
  .sb-chips button{ flex:1; min-height:52px; border-radius:9px;
    background:#2a2a2a; border:1px solid #3d3d3d; color:#fff;
    font:600 15px/1 -apple-system,BlinkMacSystemFont,sans-serif; cursor:pointer;
    transition:background-color .12s, border-color .12s; }
  .sb-chips button:hover{ background:#333; border-color:#4a4a4a; }
  .sb-chips button.sel{ background:#3a3212; border-color:#8a7420; color:#ffe08a; }
  .sb-actions{ display:flex; justify-content:flex-end; gap:8px; margin-top:18px; }
  .sb-actions button{ min-height:40px; padding:0 14px; border-radius:7px; cursor:pointer;
    font:600 12px/1 -apple-system,BlinkMacSystemFont,sans-serif;
    background:#2c2c2c; color:#ddd; border:1px solid #3d3d3d; }
  /* Full-amber confirm, matching L/A's .spm-confirm — the primary action in
     every sync dialog reads the same across nodes. */
  .sb-actions button.sb-go{ background:#f5c518; border-color:#f5c518; color:#1c1c1c; }
  .sb-actions button.sb-go:hover{ background:#ffd23b; border-color:#ffd23b; }
  .sb-actions button:disabled{ opacity:.5; cursor:default; }
</style>

<div id="sync-b-pill" role="status" aria-live="polite">
  <div class="sbp-head">
    <span class="sbp-ico" data-role="ico">🔒</span>
    <span class="sbp-label" data-role="label">B · checking…</span>
    <span class="sbp-timer" data-role="timer"></span>
  </div>
  <div class="sbp-hint" data-role="hint" hidden></div>
  <div class="sbp-actions" data-role="actions"></div>
</div>

<!-- Unlock / Prolong duration modal (chips) -->
<div id="sync-b-modal" class="sb-modal" hidden role="dialog" aria-modal="true" aria-label="Unlock B">
  <div class="sb-back" data-role="back"></div>
  <div class="sb-panel">
    <div class="sb-title" data-role="title">Unlock&nbsp;<b>B</b> for editing</div>
    <div class="sb-body" data-role="body">
      Editing B directly is rare — B’s content normally arrives via
      <b>Publish (A → B)</b>. Pick how long to keep it unlocked; it re-locks
      automatically when the time is up (you can prolong it any time).
      <br><br><b class="sb-hint">When you’re done, Back&nbsp;B→A before re-freezing.</b>
      Otherwise the next Publish (A → B) overwrites the edits you make here.
    </div>
    <div class="sb-chips" data-role="chips"></div>
    <div class="sb-actions">
      <button type="button" data-role="cancel">Cancel</button>
      <button type="button" class="sb-go" data-role="go">Unlock</button>
    </div>
  </div>
</div>

<!-- Back-propagate B → A modal (dry-run preview → confirm) -->
<div id="sync-b-bp-modal" class="sb-modal" hidden role="dialog" aria-modal="true" aria-label="Push B to A">
  <div class="sb-back" data-role="back"></div>
  <div class="sb-panel">
    <div class="sb-title">Push&nbsp;<b>B → A</b></div>
    <div class="sb-body" data-role="body">Checking what would change on A…</div>
    <div class="sb-actions">
      <button type="button" data-role="cancel">Cancel</button>
      <button type="button" class="sb-go" data-role="confirm" disabled>Push B → A</button>
    </div>
  </div>
</div>

<script>
(function(){
  var pill = document.getElementById('sync-b-pill');
  if (!pill) return;
  var ico   = pill.querySelector('[data-role="ico"]');
  var label = pill.querySelector('[data-role="label"]');
  var timer = pill.querySelector('[data-role="timer"]');
  var hint  = pill.querySelector('[data-role="hint"]');
  var acts  = pill.querySelector('[data-role="actions"]');

  var dur   = document.getElementById('sync-b-modal');
  var dBack = dur.querySelector('[data-role="back"]');
  var dTitle= dur.querySelector('[data-role="title"]');
  var dChips= dur.querySelector('[data-role="chips"]');
  var dGo   = dur.querySelector('[data-role="go"]');
  var dCancel = dur.querySelector('[data-role="cancel"]');

  var bp    = document.getElementById('sync-b-bp-modal');
  var bBack = bp.querySelector('[data-role="back"]');
  var bBody = bp.querySelector('[data-role="body"]');
  var bConfirm = bp.querySelector('[data-role="confirm"]');
  var bCancel  = bp.querySelector('[data-role="cancel"]');

  var HOURS = [1, 2, 4];
  var st = null;             // last /sync/b-status payload
  var localSecs = null;      // locally-ticked secondsRemaining
  var durMode = 'unlock';    // 'unlock' | 'prolong'
  var picked = 2;            // selected chip hours
  var busy = false;

  function esc(s){ return String(s == null ? '' : s).replace(/[&<>]/g, function(c){
    return { '&':'&amp;', '<':'&lt;', '>':'&gt;' }[c]; }); }
  function fmtBytes(n){ if (n == null) return '?';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n/1024).toFixed(1) + ' KB';
    return (n/1048576).toFixed(2) + ' MB'; }
  function fmtLeft(s){
    if (s == null) return '';
    if (s <= 0) return '0m';
    var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), ss = s%60;
    if (h > 0) return h + 'h' + (m<10?'0':'') + m + 'm';
    if (m > 0) return m + 'm' + (ss<10?'0':'') + ss + 's';
    return ss + 's';
  }

  // Unsaved in-editor buffer? Same signal L/A read — defined in dev-editor.js;
  // absent during early boot → treat as clean. This is the SECOND axis (the
  // editor save-button state), distinct from on-disk divergence.
  function isDirty(){
    try { return typeof window.edHasUnsavedData === 'function' && !!window.edHasUnsavedData(); }
    catch (e) { return false; }
  }

  // Back B→A visual = f(on-disk direction, unsaved buffer). Five states:
  //   a) equal  & clean → gray,        "in sync with A"
  //   b) equal  & dirty → light amber, "save before pushing to A"
  //   c) A>B  (behind)  → full red,    "A is ahead — do not push"  (push would clobber A)
  //   d) B>A  & clean   → full amber,  "data ready to push to A"   (the call to action)
  //   e) B>A  & dirty   → light red,   "save before pushing to A"  (saved part pushable, but buffer would be left behind)
  // "light" = coloured text+outline on dark; "full" = saturated background.
  // Hint colours per the spec: a gray, b/d/e amber, c red.
  function backVisual(){
    var dir = st && st.direction;        // 'equal' | 'ahead'(B>A) | 'behind'(A>B)
    var buf = isDirty();
    // direction is now computed locally against the unlock-time snapshot of A
    // (v0.10.272), so the old per-poll "unknown/unreachable" hot path is gone.
    // The one remaining "couldn't check A" case is peerSnapshotFailed — A was
    // unreachable AT UNLOCK, so the baseline is a guess. We surface that honestly
    // on the otherwise-calm equal state rather than claiming a verified sync.
    var unverified = !!(st && st.peerSnapshotFailed);
    if (dir === 'behind')                                                       // c
      return { btn:'sbp-red-full',   hint:'A is ahead — do not push',  hc:'sbh-red'   };
    if (dir === 'ahead')                                                        // d / e
      return buf ? { btn:'sbp-red-light',   hint:'save before pushing to A', hc:'sbh-amber' }
                 : { btn:'sbp-amber-full',  hint:'data ready to push to A',  hc:'sbh-amber' };
    if (dir === 'equal')                                                        // a / b
      return buf ? { btn:'sbp-amber-light', hint:'save before pushing to A', hc:'sbh-amber' }
                 : unverified ? { btn:'', hint:'couldn’t verify A at unlock', hc:'sbh-gray',
                                  title:'A was unreachable when B was unlocked — divergence is a guess until the next Push B→A.' }
                              : { btn:'', hint:'in sync with A',           hc:'sbh-gray'  };
    // Defensive only — direction should never be anything else now.
    return { btn:'', hint:'can’t compare with A', hc:'sbh-gray' };
  }
  // The single inline hint slot (between lock+timer and the actions cluster).
  // `title` = optional hover tooltip (used to expose the raw peer-fetch error
  // behind an "unknown" state without cluttering the bar).
  function setHint(text, hc, title){
    hint.textContent = text || '';
    hint.className = 'sbp-hint' + (hc ? ' ' + hc : '');
    if (title) hint.title = title; else hint.removeAttribute('title');
    hint.hidden = !text;
  }

  // ── render the bar from `st` ───────────────────────────────────────────
  // Horizontal order L→R: lock+timer · hint · Back B→A · Prolong · Re-freeze.
  function render(){
    pill.classList.remove('is-unlocked', 'is-pending');
    acts.innerHTML = '';
    setHint('', '');
    timer.textContent = '';
    if (!st){ setHead('🔒', 'B'); return; }

    var diverged = !!st.dirty;                     // on-disk: B is ahead of A (direction==='ahead')
    var v        = backVisual();

    if (st.frozen && !diverged){
      // Resting state (the 99% case). Hint carries the (a/b) "in sync" line.
      setHead('🔒', 'B frozen');
      setHint(v.hint, v.hc, v.title);
      acts.appendChild(mkBtn('Unlock to edit', 'sbp-primary', openUnlock));
      return;
    }
    if (st.frozen && diverged){
      // Re-locked (auto or manual) but B still holds edits A lacks — recoverable.
      // The hint becomes the danger line (why Back B→A matters here).
      pill.classList.add('is-pending');
      setHead('⚠️', st.autoLockedAt ? 'B re-locked' : 'B frozen');
      setHint('B has unpushed edits — Push B→A before the next Publish overwrites them.', 'sbh-red');
      acts.appendChild(mkBtn('Push B→A', v.btn, openBackprop));
      acts.appendChild(mkBtn('Unlock again', '', openUnlock));
      return;
    }
    // Unlocked — open-lock icon + countdown carry the state; no detail text.
    pill.classList.add('is-unlocked');
    setHead('🔓', '');
    timer.textContent = fmtLeft(localSecs);
    setHint(v.hint, v.hc, v.title);
    acts.appendChild(mkBtn('Push B→A', v.btn, openBackprop));   // FIRST action (encourage pushing to A)
    acts.appendChild(mkBtn('＋ Prolong', '', openProlong));
    // Re-freeze gate now keys on the DIVERGENCE axis (direction==='ahead'), the
    // same signal the Back B→A pill reads — "the code is the same everywhere".
    // It blocks ONLY on a confirmed B-ahead (you'd relock unsent edits that the
    // next A→B Publish would clobber). equal / behind / unknown all allow it:
    // re-freeze isn't the anti-clobber layer (A's publish guard is), so on an
    // unreachable A we don't fail-closed — relocking shrinks B's public-editable
    // surface, the safe direction. Struck-through while inhibited so the block
    // reads as deliberate, not broken.
    var rf = mkBtn('Re-freeze', 'sbp-danger sbp-refreeze', doRefreeze);
    rf.disabled = diverged;
    rf.title = diverged ? 'Push B→A first — then B can re-freeze' : 'Re-freeze B';
    acts.appendChild(rf);
  }
  function setHead(icon, text){
    ico.textContent = icon;
    label.textContent = text;
    label.style.display = text ? '' : 'none';
  }
  function mkBtn(text, cls, fn){
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  }

  // ── status poll + local countdown ──────────────────────────────────────
  function adopt(j){
    st = j;
    localSecs = (j && typeof j.secondsRemaining === 'number') ? j.secondsRemaining : null;
    render();
  }
  function poll(){
    fetch('/sync/b-status', { cache:'no-store' })
      .then(function(r){ return r.json().catch(function(){ return null; }); })
      .then(function(j){ if (j) adopt(j); })
      .catch(function(){ /* leave last-known state */ });
  }
  var pollAccum = 0;
  function tick(){
    if (st && !st.frozen && localSecs != null){
      localSecs = Math.max(0, localSecs - 1);
      timer.textContent = fmtLeft(localSecs);   // the countdown IS the timeout signal (no detail text)
      if (localSecs === 0) poll();   // window lapsed → confirm the re-lock with the server
    }
    // While UNLOCKED, re-poll every ~5s. As of v0.10.272 /sync/b-status is a CHEAP
    // LOCAL read (divergence is computed against the unlock snapshot, no live A
    // fetch), so this is just a low-cost refresh to pick up an auto-lock or an
    // out-of-band state change — NOT a peer check (B no longer chases A-side
    // changes; Slice 3's publish guard owns that). The instant signals are the
    // editor events wired below: ed:editor-saved → poll (local stamp moved →
    // recompute vs snapshot), ed:dirty-changed → render (buffer axis live).
    if (st && !st.frozen){
      if (++pollAccum >= 5){ pollAccum = 0; poll(); }
    } else {
      pollAccum = 0;
    }
  }
  setInterval(tick, 1000);
  setInterval(poll, 30000);
  window.addEventListener('focus', poll);
  document.addEventListener('visibilitychange', function(){ if (!document.hidden) poll(); });
  // Editor axis (same events L's pill listens to): a save moves B's on-disk
  // state (re-poll to recompute direction); a buffer dirty/clean flip repaints
  // the Back B→A pill instantly (light-amber/light-red) without a round-trip.
  window.addEventListener('ed:editor-saved', poll);
  window.addEventListener('ed:dirty-changed', render);
  poll();

  // ── duration modal (unlock / prolong) ──────────────────────────────────
  function buildChips(){
    dChips.innerHTML = '';
    HOURS.forEach(function(h){
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = h + 'h';
      if (h === picked) b.className = 'sel';
      b.addEventListener('click', function(){
        picked = h;
        Array.prototype.forEach.call(dChips.children, function(c){ c.className = ''; });
        b.className = 'sel';
      });
      dChips.appendChild(b);
    });
  }
  function openUnlock(){ durMode='unlock'; picked=2;
    dTitle.innerHTML = 'Unlock&nbsp;<b>B</b> for editing';
    dGo.textContent = 'Unlock'; buildChips(); dur.hidden=false; }
  function openProlong(){ durMode='prolong'; picked=2;
    dTitle.innerHTML = 'Prolong&nbsp;<b>B</b> unlock';
    dGo.textContent = 'Prolong'; buildChips(); dur.hidden=false; }
  function durClose(){ if (busy) return; dur.hidden=true; }
  dCancel.addEventListener('click', durClose);
  dBack.addEventListener('click', durClose);
  dGo.addEventListener('click', function(){
    if (busy) return; busy = true; dGo.disabled = true;
    var url = durMode === 'unlock' ? '/sync/unlock-b' : '/sync/prolong-b';
    fetch(url, { method:'POST', headers:{ 'Content-Type':'application/json' },
                 body: JSON.stringify({ hours: picked }) })
      .then(function(r){ return r.json().catch(function(){ return { ok:false }; }); })
      .then(function(j){
        busy=false; dGo.disabled=false;
        if (j && j.ok){ adopt(j); dur.hidden=true; }
        else { dGo.disabled=false; alert((j && j.error) || 'Action failed.'); }
      })
      .catch(function(){ busy=false; dGo.disabled=false; alert('Network error.'); });
  });

  // ── back-propagate modal (dry-run → confirm) ───────────────────────────
  var bpStaged = false;
  function bpReset(){ bpStaged=false; bConfirm.disabled=true;
    bBody.innerHTML = 'Checking what would change on A…'; }
  function openBackprop(){
    bpReset(); bp.hidden=false;
    fetch('/sync/backprop-b?dryRun=1', { method:'POST' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false }; }); })
      .then(function(j){
        if (!j || (j.ok === false && !j.wouldReplace)){
          bBody.innerHTML = '<span class="sb-w">'+esc((j && j.error) || 'dry-run failed')+'</span>'; return;
        }
        var w = j.wouldReplace || {};
        bBody.innerHTML =
          'This overwrites <b>A</b>’s content with <b>B</b>’s — the mandatory step '
          + 'before re-freezing. A snapshots itself first.<br><br>'
          + 'Would replace on A: <b>'+(w.pages!=null?w.pages:'?')+'</b> pages, <b>'
          + (w.files!=null?w.files:'?')+'</b> files ('+fmtBytes(w.bytes)+').';
        bpStaged=true; bConfirm.disabled=false;
      })
      .catch(function(){ bBody.innerHTML = '<span class="sb-w">Network error.</span>'; });
  }
  function bpClose(){ if (busy) return; bp.hidden=true; }
  bCancel.addEventListener('click', bpClose);
  bBack.addEventListener('click', bpClose);
  bConfirm.addEventListener('click', function(){
    if (busy || bConfirm.disabled || !bpStaged) return;
    busy=true; bConfirm.disabled=true; bBody.innerHTML='Pushing B → A…';
    fetch('/sync/backprop-b', { method:'POST' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false }; }); })
      .then(function(j){
        busy=false;
        if (j && j.ok){
          bBody.innerHTML = '<span class="sb-ok">Done — A now matches B. You can re-freeze.</span>';
          if (j.bStatus) adopt(j.bStatus); else poll();
          setTimeout(function(){ bp.hidden=true; }, 1100);
        } else {
          bConfirm.disabled=false;
          bBody.innerHTML = '<span class="sb-w">'+esc((j && j.error) || 'back-propagate failed')+'</span>';
        }
      })
      .catch(function(){ busy=false; bConfirm.disabled=false;
        bBody.innerHTML = '<span class="sb-w">Network error.</span>'; });
  });

  // ── re-freeze (gated) ──────────────────────────────────────────────────
  function doRefreeze(){
    if (busy) return; busy=true;
    fetch('/sync/refreeze-b', { method:'POST' })
      .then(function(r){ return r.json().catch(function(){ return { ok:false }; }); })
      .then(function(j){ busy=false;
        if (j && j.ok){ adopt(j); }
        else { if (j && j.bStatus) adopt(j.bStatus); alert((j && j.error) || 'Re-freeze failed.'); }
      })
      .catch(function(){ busy=false; alert('Network error.'); });
  }
})();
</script>
<?php
return;  // B: freeze/unlock control. No L↔A push/pull pill.
endif;

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
    /* Push / Pull / Publish carry different labels ("→ A", "← A", "→ B")
       and "Publish" is the longest; a shared min-width sized to the widest
       keeps all three stacked pills identical, and the icon+label stay
       flush-left so they line up vertically. */
    min-width:8rem; justify-content:flex-start; box-sizing:border-box;
    transition:background-color .15s, border-color .15s;
  }
  .sync-prop-btn:hover{ background:#343434; border-color:#4a4a4a; }
  .sync-prop-btn:disabled{ opacity:.55; cursor:default; }
  .sync-prop-btn svg{ width:14px; height:14px; display:block; }
  #sync-push-btn{ bottom:34px; }
  #sync-pull-btn{ bottom:68px; border-color:#5a3a3a; }
  #sync-pull-btn:hover{ background:#3a2a2a; border-color:#7a4a4a; }
  /* 2060 — "Publish to B" (L → A → B). Third stacked control, amber-tinted
     border like A's publish button since it ends at the PUBLIC site. */
  #sync-publish-btn{ bottom:102px; border-color:#6a5a1f; }
  #sync-publish-btn:hover{ background:#343012; border-color:#8a7420; }

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
  /* Unsaved-data warning — amber, boxed, above the push summary. */
  .sync-prop-modal .spm-body .spm-unsaved{
    color:#f5c518; background:#2e2818; border:1px solid #6a5a1f;
    border-radius:6px; padding:8px 10px; margin-bottom:10px; line-height:1.4;
  }
  .sync-prop-modal .spm-body .spm-unsaved b{ color:#ffe08a; }
  /* 2070 Slice 3b — B-state publish guard (same red/amber as A's branch). */
  .sync-prop-modal .spm-body .spm-guard{
    color:#ffb3a6; background:#2e1714; border:1px solid #7a2f26;
    border-radius:6px; padding:9px 11px; margin-bottom:10px; line-height:1.45;
  }
  .sync-prop-modal .spm-body .spm-guard b{ color:#ffd2c8; }
  .sync-prop-modal .spm-body .spm-guard.warn{
    color:#f5c518; background:#2e2818; border-color:#6a5a1f;
  }
  .sync-prop-modal .spm-body .spm-guard.warn b{ color:#ffe08a; }
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

  /* ── S5.3 — "ahead" highlight: amber Push button ──────────────────────
     The unpropagated-work reminder is zero-footprint by design: instead of
     a separate toast (abandoned — leave-intent can't be detected reliably:
     tab-close can't render UI, and blur/visibilitychange fire on any glance
     elsewhere), the existing controls just turn amber whenever L is ahead
     of A, and revert to calm dark once converged. The pill text uses the
     'warn' style (handled in JS); the Push button — the L→A action you
     should take — picks up `.is-ahead` here. Persistent until push, costs
     no extra screen space. */
  .sync-prop-btn.is-ahead{ background:#e8b22b; color:#1c1c1c; border-color:#caa01f; }
  .sync-prop-btn.is-ahead:hover{ background:#f3bf32; border-color:#d8ad22; }
  /* Mirror of .is-ahead for the opposite direction: when A is ahead, the
     Pull (A → L) button — the action to take — turns red fill. */
  .sync-prop-btn.is-behind{ background:#c0392b; color:#fff; border-color:#c0392b; }
  .sync-prop-btn.is-behind:hover{ background:#d2452f; border-color:#d2452f; }
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
    <path d="M12 5v14M5 12l7 7 7-7"/>
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

<?php /* 2060 — "Publish to B" control (publish epic, Slice 3). One button,
        with a confirm step (the user's chosen flow). Clicking runs a REAL
        L→A push first (A is staging, snapshotted), shows A's resulting
        state, and only on the explicit confirm signals A to publish itself
        A→B (the public site) via /sync/push-via/A/B → A's bearer-gated
        /sync/relay-push/B. There is NO physical L→B: B's content always
        comes from A, so it can never lead a stale A. The L→A-then-confirm
        ordering puts the eyeball/commit moment exactly before going
        public. */ ?>
<button id="sync-publish-btn" class="sync-prop-btn" type="button"
        title="Publish to B — pushes L → A, then publishes A → the PUBLIC site (B)">
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9"/>
    <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18"/>
  </svg>
  <span>Publish&nbsp;→&nbsp;B</span>
</button>

<div id="sync-publish-modal" class="sync-prop-modal" hidden role="dialog" aria-modal="true" aria-label="Publish to the public site B">
  <div class="spm-backdrop" data-role="backdrop"></div>
  <div class="spm-panel">
    <div class="spm-title">Publish&nbsp;<b>L → A → B</b></div>
    <div class="spm-body" data-role="body">Pushing L → A…</div>
    <div class="spm-actions">
      <button type="button" class="spm-cancel"  data-role="cancel">Cancel</button>
      <button type="button" class="spm-confirm" data-role="confirm" disabled>Publish to B</button>
    </div>
  </div>
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
    // S5.3 — 'ahead' keeps the calm dark pill but turns the TEXT amber, so
    // the "you're ahead" signal is persistent yet minimal (no amber fill).
    // Distinct from 'warn' (amber fill), which the legacy branch still uses.
    ahead: { bg: '#2a2a2a', fg: '#f5c518' },
    warn:  { bg: '#e8b22b', fg: '#1f1f1f' },
    // S5.3 — same treatment for the danger states (A ahead / unreachable):
    // calm dark pill, RED TEXT — never a red fill. A filled pill reads as a
    // clickable button; the pill is a passive label (the Pull button is the
    // actual control). Red text #ff8d7a is the project's meaningful-red.
    error: { bg: '#2a2a2a', fg: '#ff8d7a' }
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

  // ── S5.3 — "ahead" amber highlight on the Push button ──────────────
  // The unpropagated-work reminder is the persistent-but-minimal kind: the
  // existing Push (L → A) control turns amber whenever L is ahead, signalling
  // the action to take, and reverts to calm dark once converged. Toggled
  // from poll() alongside the pill's own amber state. No extra DOM.
  // Likewise the Pull button turns red fill when A is ahead ('behind').
  var pushBtnEl = document.getElementById('sync-push-btn');
  var pullBtnEl = document.getElementById('sync-pull-btn');

  // Last direction seen by poll() ('ahead' | 'behind' | 'equal' | null).
  // The Pull dialog reads it to warn when L is ahead — pulling then
  // overwrites L's newer, unpropagated work with A's older content.
  var lastDirection = null;

  // Is the editor holding unsaved in-memory changes? Defined in dev-editor.js
  // Section 3; may be absent during early boot → treat as clean.
  function isDirty() {
    try { return typeof window.edHasUnsavedData === 'function' && !!window.edHasUnsavedData(); }
    catch (e) { return false; }
  }

  // v0.10.235 — the pill combines TWO axes:
  //   • propagation direction (lastDirection: on-disk L vs A, moves only on
  //     save) — supplied by the server poll;
  //   • local dirty (isDirty: unsaved in-editor work) — supplied by the
  //     editor via the 'ed:dirty-changed' event.
  // Folding dirty in means an unsaved edit shows up the instant you make it
  // ('equal + dirty' → amber "unsaved changes") instead of looking "in sync"
  // until you save. Only acts on the three known directions — for null
  // (unreachable / legacy) poll() owns the label and this is a no-op.
  function renderPill() {
    var dir = lastDirection;
    if (dir === 'behind') {
      // A is ahead — the dangerous state. Red pill + the S5.2 nuclear modal
      // block the editor. Dominates regardless of local dirty.
      setLabel('A is ahead — pull before editing', 'error');
    } else if (dir === 'ahead') {
      // L is ahead = unpropagated saved work. Persistent amber until a push
      // converges to 'equal'. If ALSO dirty, name the extra unsaved work so
      // the user knows a save-then-push (not just push) is needed.
      setLabel(isDirty() ? "you're ahead + unsaved work"
                         : "you're ahead — push when done", 'ahead');
    } else if (dir === 'equal') {
      // On disk L and A match. If the editor holds unsaved edits, surface
      // them in amber rather than the calm "in sync" — saving is the next
      // step before the on-disk state actually matches what's on screen.
      var d = isDirty();
      setLabel(d ? 'unsaved changes' : 'in sync', d ? 'ahead' : 'ok');
    }
  }

  function poll() {
    fetch('/sync/peer/A', { cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return { ok: false }; }); })
      .then(function (j) {
        if (!j || !j.ok || !j.state) {
          setLabel('A unreachable', 'error');
          lastDirection = null;
          if (pushBtnEl) pushBtnEl.classList.remove('is-ahead');
          if (pullBtnEl) pullBtnEl.classList.remove('is-behind');
          return;
        }
        // S5.1 — drive the pill off the server-computed direction (this
        // node's perspective). 'ahead' = L has unpropagated work; 'behind'
        // = A is ahead of L (danger: editing now would be lost on the next
        // pull); 'equal' = converged. Fall back to the old recency check
        // only if a stale server somehow omits `direction`.
        var dir = j.direction;
        var ahead = (dir === 'ahead');
        var behind = (dir === 'behind');
        if (dir === 'ahead' || dir === 'behind' || dir === 'equal') {
          lastDirection = dir;
          renderPill();   // pill = f(direction, local dirty)
        } else {
          // Legacy/unknown shape — preserve prior behaviour. No known
          // direction, so renderPill() can't help; paint directly here.
          lastDirection = null;
          var iso = j.state.lastActivityAt;
          var age = ageSeconds(iso);
          var state = (age !== null && age <= WARN_THRESHOLD_SECONDS) ? 'warn' : 'ok';
          setLabel('A active ' + relTime(iso), state);
        }
        // S5.3 — mirror the direction onto the action buttons: Push glows
        // amber when L is ahead, Pull glows red when A is ahead. Each reverts
        // to calm dark once that direction no longer holds.
        if (pushBtnEl) pushBtnEl.classList.toggle('is-ahead', ahead);
        if (pullBtnEl) pullBtnEl.classList.toggle('is-behind', behind);
        applyNuclear(j);   // S5.2 — block the editor when A is ahead
      })
      .catch(function () {
        setLabel('A unreachable', 'error');
        if (pushBtnEl) pushBtnEl.classList.remove('is-ahead');
        if (pullBtnEl) pullBtnEl.classList.remove('is-behind');
      });
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
  // v0.10.235 — react to local editor events instead of waiting up to 60s:
  //   • a save moves L's on-disk content → re-poll (direction may now differ);
  //   • a dirty-axis change (edit / undo-to-clean) → re-paint the pill with
  //     the direction we already know (no server round-trip needed).
  window.addEventListener('ed:editor-saved', poll);
  window.addEventListener('ed:dirty-changed', renderPill);

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
    // Unsaved-editor-data warning. A push propagates content/ AS IT IS ON
    // DISK; in-editor edits not yet saved do NOT travel — yet the post-push
    // indicator would read "in sync", a false-converged state w.r.t. that
    // unsaved work. So if the editor reports unsaved data, warn (non-blocking
    // — the user may intend to push only the saved state).
    function unsavedNote(){
      try {
        if (typeof window.edHasUnsavedData === 'function' && window.edHasUnsavedData()) {
          return '<div class="spm-unsaved">⚠ You have <b>local unsaved data</b>. '
            + 'A push sends only what’s saved to disk — unsaved edits won’t travel, '
            + 'and A will read as “in sync” without them. Save first to include them.</div>';
        }
      } catch (e) {}
      return '';
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
            unsavedNote()
            + 'This will <span class="spm-warn">overwrite A’s content</span> with L’s:<br>'
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
    // "L is ahead" warning. Pull overwrites THIS machine's content with A's.
    // When L is ahead, that older A content clobbers L's newer, unpropagated
    // work — the symmetric danger to pushing-while-dirty. Non-blocking (a
    // snapshot of L is taken first, and the user may genuinely want to
    // discard local work), but loud. Reuses the amber .spm-unsaved box.
    function aheadNote(){
      if (lastDirection === 'ahead') {
        var dirty = false;
        try { dirty = (typeof window.edHasUnsavedData === 'function') && window.edHasUnsavedData(); } catch (e) {}
        // When the editor is also dirty, spell out BOTH kinds of at-risk work:
        // saved-but-unpushed (the 'ahead' state) AND unsaved in-editor edits.
        var has = dirty
          ? 'it has <b>saved work not yet pushed to A</b> and also <b>some unsaved work</b>'
          : 'it has work not yet pushed to A';
        // Suggest saving only when there's unsaved work to save.
        var advice = dirty ? 'Consider saving and pushing L → A first.'
                           : 'Consider pushing L → A first.';
        return '<div class="spm-unsaved">⚠ <b>This machine (L) is ahead</b> — ' + has + '. '
          + 'Pulling will <b>overwrite those local changes</b> with A’s older content. '
          + advice + ' (A snapshot of L is taken first, so this is recoverable.)</div>';
      }
      return '';
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
            aheadNote()
            + 'This will <span class="spm-warn">overwrite THIS machine’s content</span> with A’s:<br>'
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
            + '<span style="opacity:.8">Reloading the editor with A’s content…</span>';
          // S5.2 — L just adopted A's stamp; re-poll so the pill flips to
          // 'equal' and the nuclear overlay (if it triggered this pull)
          // clears itself.
          poll();
          // v0.10.236 — the pull overwrote content/ ON DISK, but the editor
          // still holds the pre-pull state in memory; previously the user
          // had to reload by hand to see A's content. Auto-reload after a
          // beat so the success message is readable first. A full reload is
          // the robust choice: the editor re-boots and re-reads disk, rather
          // than trying to surgically re-hydrate in-memory state.
          setTimeout(function(){ window.location.reload(); }, 1500);
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

  // ── 2060 — "Publish to B" control (L → A → B) ─────────────────────
  // One button, confirm step before going public. On click: a REAL L→A
  // push (A is staging + snapshotted), then the modal shows A's resulting
  // state; only the explicit confirm signals A to publish A→B via
  // /sync/push-via/A/B (→ A's bearer-gated /sync/relay-push/B). No L→B —
  // B's content always comes from A. Reuses esc()/fmtBytes()/poll() from
  // this closure.
  var publishBtn   = document.getElementById('sync-publish-btn');
  var publishModal = document.getElementById('sync-publish-modal');
  if (publishBtn && publishModal) {
    var qBody    = publishModal.querySelector('[data-role="body"]');
    var qConfirm = publishModal.querySelector('[data-role="confirm"]');
    var qCancel  = publishModal.querySelector('[data-role="cancel"]');
    var qBack    = publishModal.querySelector('[data-role="backdrop"]');
    var qBusy    = false;
    var qStaged  = false;   // L→A done this open → A→B confirm armed
    var qForced  = false;   // Slice 3b — B-guard escape hatch armed this open

    function qErrMsg(j, fallback){
      if (!j) return fallback;
      var m = j.error || fallback;
      if (j.code){ m += ' (HTTP ' + j.code + ')'; }
      if (j.body){ var snip = String(j.body).replace(/\s+/g,' ').trim().slice(0,120); if (snip) m += '\n'+snip; }
      return m;
    }
    function qShowError(msg){
      qBody.innerHTML = '<span class="spm-warn">✗ ' + esc(msg).replace(/\n/g, '<br>') + '</span>';
      qConfirm.disabled = true;
    }
    // Slice 3b — B-state guard banner from the relayed `bGuard` (A probed B's
    // /sync/b-status). Mirrors the A-branch guardBanner(): red when B is
    // unlocked/ahead (publish clobbers B's edits), amber when unverifiable.
    function qGuardBanner(g){
      if (!g || !g.applicable) return '';
      if (g.block){
        var why = (g.ahead && g.unlocked) ? 'is <b>unlocked and holds edits A doesn’t have</b>'
                : g.ahead                 ? 'holds <b>edits A doesn’t have</b> (B is ahead)'
                :                           'is currently <b>unlocked for direct editing</b>';
        return '<div class="spm-guard">⛔ <b>B ' + why + '.</b> '
          + 'Publishing would <b>overwrite B’s own edits</b>. Back-propagate B → A and '
          + 're-freeze B first — or use <b>Publish anyway</b> to discard B’s edits '
          + '(B is snapshotted, so it’s recoverable).</div>';
      }
      if (!g.reachable){
        return '<div class="spm-guard warn">⚠ Couldn’t verify B’s lock state'
          + (g.error ? ' (' + esc(g.error) + ')' : '') + '. '
          + 'Publishing is allowed but unverified — if B was unlocked, its edits would be overwritten.</div>';
      }
      return '';
    }
    function qArmForce(block){
      qForced = !!block;
      if (block){
        qConfirm.textContent = 'Publish anyway';
        qConfirm.classList.add('danger');
      } else {
        qConfirm.textContent = 'Publish to B';
        qConfirm.classList.remove('danger');
      }
    }
    function qReset(){
      qConfirm.style.display = '';
      qConfirm.textContent = 'Publish to B';
      qConfirm.classList.remove('danger');
      qConfirm.disabled = true;
      qCancel.textContent = 'Cancel';
      qCancel.disabled = false;
      qStaged = false;
      qForced = false;
    }
    function qClose(){ if (qBusy) return; qReset(); publishModal.hidden = true; }

    // Step 1 (on open) — REAL L→A push, then present A's resulting state.
    function qStart(){
      var wasDirty = false;
      try { wasDirty = (typeof window.edHasUnsavedData === 'function') && window.edHasUnsavedData(); } catch (e) {}
      qBusy = true; qReset();
      qBody.textContent = 'Pushing L → A…';
      publishModal.hidden = false;
      fetch('/sync/push/A', { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          qBusy = false;
          if (!j || !j.ok){ qShowError(qErrMsg(j, 'L → A push failed')); return; }
          poll();   // A just changed — refresh the peer pill
          var r = j.replaced || {};
          var unsaved = wasDirty
            ? '<div class="spm-unsaved">⚠ You had <b>unsaved edits</b> — only saved-to-disk content '
              + 'reached A, so it won’t reach B either. Cancel, save, and Publish again to include them.</div>'
            : '';
          qBody.innerHTML =
            unsaved
            + '<span class="spm-ok">✓ Pushed L → A.</span> A now has '
            + '<b>' + (r.pages||0) + '</b> pages · <b>' + (r.files||0) + '</b> files.<br>'
            + '<div class="spm-unsaved" style="margin-top:10px;">Confirm to <b>publish A → B</b> '
            + '(the <b>PUBLIC</b> site). B is snapshotted first. '
            + '<a href="https://newsitedbart.bbh.fr" target="_blank" rel="noopener" '
            + 'style="color:#ffe08a;text-decoration:underline;">Open A to check ↗</a></div>';
          qConfirm.disabled = false;
          qStaged = true;
        })
        .catch(function(){ qBusy = false; qShowError('network error during L → A push'); });
    }

    // Step 2 (on confirm) — signal A to publish itself A→B. `force=1` only when
    // the B-guard already blocked once this open and the author chose "Publish
    // anyway"; A forwards it down to its own A→B guard.
    function qPublish(){
      if (qBusy || qConfirm.disabled || !qStaged) return;
      qBusy = true;
      qConfirm.disabled = true; qCancel.disabled = true;
      qConfirm.textContent = qForced ? 'Publishing anyway…' : 'Publishing…';
      qBody.textContent = 'Asking A to publish A → B…';
      fetch('/sync/push-via/A/B' + (qForced ? '?force=1' : ''), { method:'POST', cache:'no-store' })
        .then(function(r){ return r.json().catch(function(){ return { ok:false, error:'bad response' }; }); })
        .then(function(j){
          // B-guard block (Slice 3b): A refused A→B with 409 (B unlocked/ahead)
          // and the verdict relayed back. The refusal is cheap (no tarball was
          // built), so re-arm the escape hatch and let the author confirm again.
          if (j && j.code === 409 && j.bGuard){
            qBusy = false; qCancel.disabled = false;
            qBody.innerHTML = qGuardBanner(j.bGuard);
            qArmForce(true); qConfirm.disabled = false;
            return;
          }
          qBusy = false; qCancel.disabled = false; qCancel.textContent = 'Close';
          qConfirm.style.display = 'none';
          if (!j || !j.ok){ qShowError(qErrMsg(j, 'publish A → B failed')); return; }
          var r = j.replaced || {};
          qBody.innerHTML =
            '<span class="spm-ok">✓ Published to B (public).</span><br>'
            + 'B now has <b>' + (r.pages||0) + '</b> pages · <b>' + (r.files||0) + '</b> files.<br>'
            + 'Snapshot: <b>' + esc(j.snapshot || '?') + '</b>';
        })
        .catch(function(){
          qBusy = false; qCancel.disabled = false; qCancel.textContent = 'Close';
          qConfirm.style.display = 'none'; qShowError('network error during publish');
        });
    }

    publishBtn.addEventListener('click', qStart);
    qConfirm.addEventListener('click', qPublish);
    qCancel.addEventListener('click', qClose);
    qBack.addEventListener('click', qClose);
    document.addEventListener('keydown', function(e){
      if (publishModal.hidden) return;
      if (e.key === 'Escape'){ e.preventDefault(); qClose(); }
      else if (e.key === 'Enter' && !qConfirm.disabled && qConfirm.style.display !== 'none'){
        e.preventDefault(); qPublish();
      }
    });
  }
})();
</script>
