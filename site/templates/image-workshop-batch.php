<?php
/**
 * /dev/image-workshop/<batch> grid view — Phase 2 workshop.
 *
 * v0.10.35 — Step B introduced a per-image VERDICT triage (ok / rework /
 * dropped) persisted to verdicts.json, plus a verdict filter bar and a
 * per-card "Use this" push-to-page transfer.
 *
 * v0.10.182 (Convergence Slice 4g-1) — MODEL PIVOT. The 3-state verdict
 * collapses to a single "Use it" boolean per image:
 *   - One toggle per card (on/off), persisted to a new useit.json sidecar
 *     ({ schemaVersion, useIt: { "<filename>": true } } — only ON files
 *     are listed; absence = off). Migrated on read from the legacy
 *     verdicts.json (verdict 'ok' → use it = on); the first save writes
 *     useit.json and the legacy file is thereafter ignored.
 *   - Filter pills become All / Use it = on / Use it = off.
 *   - "ok" and "rework" buttons are gone (rework is now implicit in off).
 *   - "Copy filenames" now copies the OFF set (the rejection list).
 *   - The push-to-page transfer (target picker + sent-list) is REMOVED:
 *     transfer ownership moves to the editor, which pulls only the
 *     use-it=on images via /dev/image-workshop/list (consumer-side filter).
 *
 * v0.10.189 (Convergence Slice 4g-3a) — PER-IMAGE LONG EDGE. Each card gets
 * its own long-edge input + "Apply": Apply POSTs to dev/image-workshop/resize,
 * which re-renders only that image's derivative, persists the size to a new
 * per-batch sizes.json sidecar ({ schemaVersion, sizes: { "<file>": px } }),
 * and returns the fresh url/dims/niceSize/pct so the card swaps its preview
 * WYSIWYG with no page reload. The global long-edge input is the DEFAULT for
 * files without their own size entry.
 *
 * v0.10.190 (Convergence Slice 4g-3b) — GLOBAL BULK HELPERS. The old
 * page-reload "Apply" form is replaced by two buttons beside the global
 * long-edge input: "Copy to all" seeds every card's long-edge field with the
 * global value (pure DOM, no render); "Apply to all" then re-renders +
 * persists every card sequentially (busy overlay with N-of-M progress).
 *
 * v0.10.191 — Display polish: both preview cells share a fixed-height box
 * (the original is a 900px thumb, not 420, so it matches the resized
 * derivative at the same scale); the use-it=on card gets a FULL green ring
 * (was a left-only stripe); the global bulk button reads "Reapply all sizes"
 * (was "Apply to all", which read as referring to the left input).
 *
 * Deferred to later 4g slices: in-workshop file rename (4g-5), editable
 * batch names (4g-6).
 *
 * Resize semantics mirror the canvas-page runtime and the maxLongEdge
 * commit hook exactly: $file->resize($size, $size) fits the image inside a
 * $size-square box (long edge binds, aspect preserved, no crop). The
 * derivative shown here is byte-identical to what a commit at the same
 * value would produce.
 *
 * NOTE (perf): resize() is eager — first visit at a size generates a thumb
 * per image, then serves from /media cache. Changing the size regenerates
 * at the new size (the old size stays cached).
 */
$v = option('version', 'dev');

// Test long edge: ?size=NNNN, default 1000, clamped to [200, 8000] to
// match the image blueprint's maxLongEdge bounds. Since 4g-3a this is the
// DEFAULT for files without their own size in sizes.json; per-image sizes
// override it per card.
$sizeRaw = kirby()->request()->get('size');
$size    = is_numeric($sizeRaw) ? (int) $sizeRaw : 1000;
$size    = max(200, min(8000, $size));

$images = $page->images()->sortBy('filename', 'asc');

// Preset sizes offered in the type-or-pick combo.
$presets = [800, 1000, 1200, 1600, 2400];

// Load the "use it" sidecar. Shape: { schemaVersion, useIt: { "<filename>": true } }.
// Only ON files are listed; absence means off. Migration: when useit.json
// is absent, derive from the legacy verdicts.json (verdict 'ok' → on). The
// first save writes useit.json and the legacy file is thereafter ignored.
$useItPath = $page->root() . '/useit.json';
$useIt     = [];
if (is_file($useItPath)) {
  $decoded = json_decode(file_get_contents($useItPath), true);
  if (is_array($decoded) && isset($decoded['useIt']) && is_array($decoded['useIt'])) {
    foreach ($decoded['useIt'] as $fn => $on) {
      if ($on) { $useIt[$fn] = true; }
    }
  }
} else {
  $vPath = $page->root() . '/verdicts.json';
  if (is_file($vPath)) {
    $d = json_decode(file_get_contents($vPath), true);
    if (is_array($d) && isset($d['verdicts']) && is_array($d['verdicts'])) {
      foreach ($d['verdicts'] as $fn => $verdict) {
        if ($verdict === 'ok') { $useIt[$fn] = true; }
      }
    }
  }
}

// Per-image long edge (4g-3a). sizes.json shape:
// { schemaVersion, sizes: { "<filename>": px } }. Absence for a file means
// "use the page default" ($size, the global ?size / 1000 fallback). Each card
// renders its resized derivative at its own size; the global form remains the
// default for files without their own entry. Per-card Apply persists here.
$sizesPath = $page->root() . '/sizes.json';
$sizes     = [];
if (is_file($sizesPath)) {
  $decoded = json_decode(file_get_contents($sizesPath), true);
  if (is_array($decoded) && isset($decoded['sizes']) && is_array($decoded['sizes'])) {
    foreach ($decoded['sizes'] as $fn => $px) {
      if (is_numeric($px)) { $sizes[$fn] = max(200, min(8000, (int) $px)); }
    }
  }
}

// Counts for the filter pills.
$onCount = 0;
foreach ($images as $img) {
  if (!empty($useIt[$img->filename()])) { $onCount++; }
}
$offCount = $images->count() - $onCount;
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= esc($page->title()) ?> — Image workshop</title>
  <link rel="stylesheet" href="<?= url('assets/css/image-workshop.css') ?>?v=<?= $v ?>">
</head>
<body class="iw-body">
  <header class="iw-toolbar">
    <a class="iw-back" href="<?= $page->parent()->url() ?>" title="Back to batches">‹ Batches</a>
    <span class="iw-brand"><?= esc($page->title()) ?></span>
    <span class="iw-count"><?= $images->count() ?> image(s)</span>
    <span class="iw-version">v<?= esc($v) ?></span>
  </header>

  <!-- Single control bar: size picker (always) + use-it filter/copy
       (only when the batch has images). The size picker lives HERE, not
       in the top toolbar, so its preset popup opens into the grid below
       rather than behind the sticky opaque bar. -->
  <div class="iw-subbar">
    <!-- Global long edge (4g-3b): a seeder for the per-card inputs, NOT a
         page-reload form. "Copy to all" fills every card's long-edge field
         with this value (no render); "Apply to all" then re-renders +
         persists every card. The combo input still defaults the size for
         brand-new cards on load. -->
    <div class="iw-sizeform">
      <label class="iw-sizelabel" for="iw-size">Long edge — all (px)</label>
      <div class="iw-sizecombo">
        <input type="number" id="iw-size" name="size" class="iw-sizeinput"
               min="200" max="8000" step="10" value="<?= $size ?>"
               inputmode="numeric" autocomplete="off">
        <button type="button" class="iw-sizecaret" id="iw-sizecaret"
                aria-haspopup="listbox" aria-expanded="false" aria-controls="iw-sizemenu"
                aria-label="Choose a preset size">▾</button>
        <ul class="iw-sizemenu" id="iw-sizemenu" role="listbox" hidden>
          <?php foreach ($presets as $p): ?>
            <li class="iw-sizeopt" role="option" data-value="<?= $p ?>" tabindex="-1"><?= $p ?> px</li>
          <?php endforeach; ?>
        </ul>
      </div>
      <?php if ($images->count() > 0): ?>
        <button type="button" class="iw-apply iw-apply--ghost" id="iw-copy-all"
                title="Fill every card's long-edge field with this value (no re-render)">Copy to all</button>
        <button type="button" class="iw-apply" id="iw-apply-all"
                title="Re-render + save every card at its current long-edge value">Reapply all sizes</button>
      <?php endif; ?>
    </div>

    <?php if ($images->count() > 0): ?>
    <span class="iw-subbar-sep" aria-hidden="true"></span>
    <div class="iw-filterbar" role="group" aria-label="Filter by use-it state">
      <span class="iw-filter-label">Show</span>
      <button type="button" class="iw-filter is-active" data-filter="all">All <span class="iw-filter-n"><?= $images->count() ?></span></button>
      <button type="button" class="iw-filter iw-filter--on"  data-filter="on">Use it = on <span class="iw-filter-n" data-count="on"><?= $onCount ?></span></button>
      <button type="button" class="iw-filter iw-filter--off" data-filter="off">Use it = off <span class="iw-filter-n" data-count="off"><?= $offCount ?></span></button>
    </div>
    <div class="iw-subbar-actions">
      <span class="iw-savestate" id="iw-savestate" aria-live="polite"></span>
      <button type="button" class="iw-copy" id="iw-copy" title="Copy newline-separated filenames of every image with Use it = off">
        Copy filenames (off) <span class="iw-copy-n" id="iw-copy-n"><?= $offCount ?></span>
      </button>
    </div>
    <?php endif; ?>
  </div>

  <!-- Long-operation feedback for size regeneration (synchronous GD/Imagick
       pass per image on first visit at a given size). -->
  <div id="iw-busy" class="iw-busy" hidden aria-live="polite">
    <div class="iw-busy-box">
      <div class="iw-spinner" aria-hidden="true"></div>
      <div class="iw-busy-msg" id="iw-busy-msg">Generating derivatives…</div>
      <div class="iw-busy-sub">First time at this size only — cached afterwards.</div>
    </div>
  </div>

  <!-- Destructive-delete confirmation (4g-2). Named per-file at open time. -->
  <div id="iw-confirm" class="iw-confirm" hidden role="dialog" aria-modal="true" aria-labelledby="iw-confirm-title">
    <div class="iw-confirm-box">
      <h2 class="iw-confirm-title" id="iw-confirm-title">Delete this image?</h2>
      <p class="iw-confirm-msg">
        <strong id="iw-confirm-name"></strong> and any resized derivative will be
        <strong>permanently deleted</strong>. This cannot be undone.
      </p>
      <div class="iw-confirm-actions">
        <button type="button" class="iw-confirm-cancel" id="iw-confirm-cancel">Cancel</button>
        <button type="button" class="iw-confirm-del" id="iw-confirm-del">Delete</button>
      </div>
    </div>
  </div>

  <!-- Click-to-view lightbox (4g-2b). Click a thumb → full image in an
       overlay (no new tab). Click anywhere / Esc closes. -->
  <div id="iw-lightbox" class="iw-lightbox" hidden role="dialog" aria-modal="true" aria-label="Image preview">
    <button type="button" class="iw-lightbox-close" id="iw-lightbox-close" aria-label="Close preview">×</button>
    <img class="iw-lightbox-img" id="iw-lightbox-img" src="" alt="">
  </div>

  <main class="iw-grid-wrap">
    <?php if ($images->count() === 0): ?>
      <p class="iw-empty">
        No images in this batch yet. Drop candidate images into it in the
        <a href="<?= $page->panel()->url() ?>">Panel</a>, then reload.
      </p>
    <?php else: ?>
      <div class="iw-grid" id="iw-grid">
        <?php foreach ($images as $img): ?>
          <?php
            $ow = $img->width();
            $oh = $img->height();
            // Per-image long edge (4g-3a): this card's own size, or the page
            // default for files without an entry in sizes.json.
            $cardSize = $sizes[$img->filename()] ?? $size;
            // Eager resize — generates + caches the derivative.
            $resized = $img->resize($cardSize, $cardSize);
            $rw = $resized->width();
            $rh = $resized->height();
            $origLong = max($ow, $oh);
            $pct = $origLong > 0 ? round(($cardSize <= $origLong ? $cardSize : $origLong) / $origLong * 100) : 100;
            $noShrink = $cardSize >= $origLong;
            $on = !empty($useIt[$img->filename()]);
          ?>
          <article class="iw-card" data-filename="<?= esc($img->filename()) ?>" data-useit="<?= $on ? '1' : '0' ?>">
            <div class="iw-card-head">
              <span class="iw-fname" title="<?= esc($img->filename()) ?>"><?= esc($img->filename()) ?></span>
            </div>

            <div class="iw-pair">
              <figure class="iw-cell">
                <a class="iw-thumblink" href="<?= $img->url() ?>" target="_blank" rel="noopener">
                  <img class="iw-thumb" src="<?= $img->resize(900, 900)->url() ?>" alt="" loading="lazy">
                </a>
                <figcaption class="iw-cap">
                  <span class="iw-cap-tag">original</span>
                  <span class="iw-cap-dims"><?= $ow ?>×<?= $oh ?></span>
                  <span class="iw-cap-size"><?= esc($img->niceSize()) ?></span>
                </figcaption>
              </figure>

              <figure class="iw-cell">
                <a class="iw-thumblink" href="<?= $resized->url() ?>" target="_blank" rel="noopener">
                  <img class="iw-thumb" data-role="rimg" src="<?= $resized->url() ?>" alt="" loading="lazy">
                </a>
                <figcaption class="iw-cap">
                  <span class="iw-cap-tag iw-cap-tag--resized">resized</span>
                  <span class="iw-cap-dims" data-role="rdims"><?= $rw ?>×<?= $rh ?></span>
                  <span class="iw-cap-size" data-role="rsize"><?= esc($resized->niceSize()) ?></span>
                  <span class="iw-cap-note" data-role="rnote"<?= $noShrink ? ' title="The test size is at or above the source\'s long edge, so no downscale happened."' : '' ?>><?= $noShrink ? '≥ source — no shrink' : $pct . '% of source' ?></span>
                </figcaption>
                <!-- Per-image long edge (4g-3a): set + Apply re-renders THIS
                     card's resized preview only, and persists to sizes.json. -->
                <div class="iw-sizerow">
                  <label class="iw-sizerow-label" for="iw-edge-<?= esc($img->filename()) ?>">Long edge</label>
                  <input type="number" class="iw-edge" id="iw-edge-<?= esc($img->filename()) ?>"
                         min="200" max="8000" step="10" value="<?= $cardSize ?>"
                         inputmode="numeric" autocomplete="off"
                         aria-label="Long edge (px) for <?= esc($img->filename()) ?>">
                  <button type="button" class="iw-edge-apply">Apply</button>
                </div>
              </figure>
            </div>

            <!-- Use-it toggle (4g-1). On = the editor will pull this image;
                 off = it stays in the workshop (implicit "rework").
                 Dropped (4g-2) = permanently delete the original + any
                 resized derivative. -->
            <div class="iw-controls">
              <button type="button" class="iw-use" aria-pressed="<?= $on ? 'true' : 'false' ?>" aria-label="Toggle Use it for <?= esc($img->filename()) ?>">Use it</button>
              <button type="button" class="iw-drop" aria-label="Delete <?= esc($img->filename()) ?> (original and resized)">Delete</button>
            </div>
          </article>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </main>

  <script>
    // Size picker (type-or-pick combo) + busy overlay. Vanilla, no build step.
    (function () {
      var form  = document.querySelector('.iw-sizeform');
      var busy  = document.getElementById('iw-busy');
      var msg   = document.getElementById('iw-busy-msg');
      var input = document.getElementById('iw-size');
      var caret = document.getElementById('iw-sizecaret');
      var menu  = document.getElementById('iw-sizemenu');
      var count = <?= (int) $images->count() ?>;
      if (!form) return;

      if (caret && menu && input) {
        var opts = Array.prototype.slice.call(menu.querySelectorAll('.iw-sizeopt'));

        function openMenu() {
          menu.hidden = false;
          caret.setAttribute('aria-expanded', 'true');
          document.addEventListener('click', onDocClick, true);
          document.addEventListener('keydown', onKey, true);
        }
        function closeMenu() {
          menu.hidden = true;
          caret.setAttribute('aria-expanded', 'false');
          document.removeEventListener('click', onDocClick, true);
          document.removeEventListener('keydown', onKey, true);
        }
        function toggleMenu() { menu.hidden ? openMenu() : closeMenu(); }
        function onDocClick(e) {
          if (!menu.contains(e.target) && e.target !== caret) closeMenu();
        }
        function onKey(e) {
          if (e.key === 'Escape') { closeMenu(); input.focus(); }
        }
        function pick(value) {
          input.value = value;   // fill only — do NOT submit
          closeMenu();
          input.focus();
        }

        caret.addEventListener('click', function (e) { e.preventDefault(); toggleMenu(); });
        opts.forEach(function (li) {
          li.addEventListener('click', function () { pick(li.getAttribute('data-value')); });
        });
      }

      if (busy) {
        form.addEventListener('submit', function () {
          var sz = input ? input.value : '';
          msg.textContent = 'Generating ' + count + ' derivative' +
            (count === 1 ? '' : 's') + ' at ' + sz + ' px…';
          busy.hidden = false;
        });
      }
    })();

    // Use-it triage (4g-1): per-card toggle, client-side filter,
    // copy-off-filenames, debounced persistence to useit.json.
    (function () {
      var grid = document.getElementById('iw-grid');
      if (!grid) return;

      var SAVE_URL = <?= json_encode(url('dev/image-workshop/save')) ?>;
      var BATCH_ID = <?= json_encode($page->id()) ?>;

      // Cross-tab freshness (4g-1b): announce use-it changes so an editor
      // import panel open in another tab can re-pull this batch without a
      // reload. The editor also refetches on tab-focus as a fallback.
      var useitChannel = ('BroadcastChannel' in window) ? new BroadcastChannel('iw-useit') : null;

      var cards      = Array.prototype.slice.call(grid.querySelectorAll('.iw-card'));
      var filterBtns = Array.prototype.slice.call(document.querySelectorAll('.iw-filter'));
      var saveState  = document.getElementById('iw-savestate');
      var copyBtn    = document.getElementById('iw-copy');
      var copyN      = document.getElementById('iw-copy-n');

      function isOn(card) { return card.getAttribute('data-useit') === '1'; }

      // In-memory use-it map, seeded from the rendered DOM (server is the
      // source of truth on load).
      var useIt = {};
      cards.forEach(function (card) {
        if (isOn(card)) useIt[card.getAttribute('data-filename')] = true;
      });

      // ── Counts + copy-button badge ───────────────────────────────
      function recount() {
        var on = 0;
        cards.forEach(function (c) { if (isOn(c)) on++; });
        var off = cards.length - on;
        filterBtns.forEach(function (b) {
          var key = b.getAttribute('data-filter');
          var n   = b.querySelector('.iw-filter-n');
          if (!n) return;
          if (key === 'all')      n.textContent = cards.length;
          else if (key === 'on')  n.textContent = on;
          else if (key === 'off') n.textContent = off;
        });
        if (copyN) copyN.textContent = off;
        if (copyBtn) copyBtn.disabled = off === 0;
      }

      // ── Persistence (debounced; sends the whole map) ─────────────
      var saveTimer = null;
      function flash(msg, isErr) {
        if (!saveState) return;
        saveState.textContent = msg;
        saveState.classList.toggle('is-error', !!isErr);
      }
      function scheduleSave() {
        flash('Saving…', false);
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(doSave, 450);
      }
      function doSave() {
        fetch(SAVE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: BATCH_ID, useIt: useIt })
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) {
              flash('Saved ✓', false);
              // Server is now current → tell any editor tab to re-pull.
              if (useitChannel) useitChannel.postMessage({ type: 'useit-changed', batch: BATCH_ID });
            }
            else { flash('Save failed: ' + ((j && j.error) || 'unknown'), true); }
          })
          .catch(function () { flash('Save failed (network)', true); });
      }
      // Flush any pending debounced save the instant this tab is hidden, so
      // the server is current before the user lands on the editor tab. The
      // post-save broadcast then nudges the editor to refetch.
      function flushSave() {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; doSave(); }
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushSave();
      });
      window.addEventListener('pagehide', flushSave);

      // ── Use-it toggle ────────────────────────────────────────────
      grid.addEventListener('click', function (e) {
        var btn = e.target.closest('.iw-use');
        if (!btn) return;
        var card = btn.closest('.iw-card');
        if (!card) return;
        var fname = card.getAttribute('data-filename');
        var next  = !isOn(card);

        card.setAttribute('data-useit', next ? '1' : '0');
        btn.setAttribute('aria-pressed', next ? 'true' : 'false');
        if (next) useIt[fname] = true; else delete useIt[fname];

        recount();
        applyFilter(); // a now-filtered-out card hides immediately
        scheduleSave();
      });

      // ── Dropped = permanent delete (4g-2) ────────────────────────
      // Two-step: clicking "Dropped" opens a named confirm modal; only the
      // modal's Delete actually hits the server. On success the card is
      // removed from the DOM + the in-memory cards list, the use-it map is
      // cleaned, counts/filter refresh, and we broadcast so an editor tab
      // re-pulls (a now-deleted ON image must vanish from its import list).
      var DELETE_URL  = <?= json_encode(url('dev/image-workshop/delete-image')) ?>;
      var confirmEl   = document.getElementById('iw-confirm');
      var confirmName = document.getElementById('iw-confirm-name');
      var confirmDel  = document.getElementById('iw-confirm-del');
      var confirmCancel = document.getElementById('iw-confirm-cancel');
      var pendingCard = null;

      function openConfirm(card) {
        pendingCard = card;
        if (confirmName) confirmName.textContent = card.getAttribute('data-filename');
        if (confirmEl) confirmEl.hidden = false;
        if (confirmDel) confirmDel.focus();
      }
      function closeConfirm() {
        pendingCard = null;
        if (confirmEl) confirmEl.hidden = true;
        if (confirmDel) { confirmDel.disabled = false; confirmDel.textContent = 'Delete'; }
      }
      if (confirmCancel) confirmCancel.addEventListener('click', closeConfirm);
      if (confirmEl) confirmEl.addEventListener('click', function (e) {
        if (e.target === confirmEl) closeConfirm(); // click on backdrop
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && confirmEl && !confirmEl.hidden) closeConfirm();
      });

      if (confirmDel) confirmDel.addEventListener('click', function () {
        if (!pendingCard) return;
        var card  = pendingCard;
        var fname = card.getAttribute('data-filename');
        confirmDel.disabled = true;
        confirmDel.textContent = 'Deleting…';
        fetch(DELETE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: BATCH_ID, filename: fname })
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (!j || !j.ok) { flash('Delete failed: ' + ((j && j.error) || 'unknown'), true); closeConfirm(); return; }
            // Drop from DOM + state.
            cards = cards.filter(function (c) { return c !== card; });
            if (card.parentNode) card.parentNode.removeChild(card);
            delete useIt[fname];
            recount();
            applyFilter();
            flash('Deleted “' + fname + '” ✓', false);
            // Server state changed → nudge any editor import tab to re-pull.
            if (useitChannel) useitChannel.postMessage({ type: 'useit-changed', batch: BATCH_ID });
            closeConfirm();
          })
          .catch(function () { flash('Delete failed (network)', true); closeConfirm(); });
      });

      grid.addEventListener('click', function (e) {
        var btn = e.target.closest('.iw-drop');
        if (!btn) return;
        var card = btn.closest('.iw-card');
        if (card) openConfirm(card);
      });

      // ── Filtering (client-side) ──────────────────────────────────
      var activeFilter = 'all';
      function applyFilter() {
        cards.forEach(function (card) {
          var show;
          if (activeFilter === 'all')     show = true;
          else if (activeFilter === 'on') show = isOn(card);
          else                            show = !isOn(card);
          card.hidden = !show;
        });
      }
      filterBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          activeFilter = b.getAttribute('data-filter');
          filterBtns.forEach(function (x) { x.classList.toggle('is-active', x === b); });
          applyFilter();
        });
      });

      // ── Copy off-set filenames (the rejection / handoff list) ────
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var names = cards
            .filter(function (c) { return !isOn(c); })
            .map(function (c) { return c.getAttribute('data-filename'); });
          if (!names.length) { flash('No images with Use it = off', false); return; }
          var text = names.join('\n');
          var done = function () { flash('Copied ' + names.length + ' filename' + (names.length === 1 ? '' : 's') + ' ✓', false); };
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
          } else { fallbackCopy(text, done); }
        });
      }
      function fallbackCopy(text, done) {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (err) { flash('Copy failed', true); }
        document.body.removeChild(ta);
      }

      recount();
    })();

    // Per-image long edge (4g-3a): each card has a long-edge input + Apply.
    // Apply re-renders THAT image's resized derivative server-side, persists
    // the size to sizes.json, and swaps the card's preview WYSIWYG — no page
    // reload, no effect on other cards.
    (function () {
      var grid = document.getElementById('iw-grid');
      if (!grid) return;

      var RESIZE_URL = <?= json_encode(url('dev/image-workshop/resize')) ?>;
      var BATCH_ID   = <?= json_encode($page->id()) ?>;
      var saveState  = document.getElementById('iw-savestate');

      function flash(msg, isErr) {
        if (!saveState) return;
        saveState.textContent = msg;
        saveState.classList.toggle('is-error', !!isErr);
      }

      function clampSize(v) {
        var s = parseInt(v, 10);
        if (!s || s < 200) s = 200;
        if (s > 8000) s = 8000;
        return s;
      }

      // Resize one card. Returns a Promise resolving true/false (applied ok).
      // `quiet` suppresses the per-card flash (the bulk handler shows its own
      // progress) — the button spinner still runs so each card gives feedback.
      function applyCard(card, btn, quiet) {
        var fname = card.getAttribute('data-filename');
        var input = card.querySelector('.iw-edge');
        if (!input) return Promise.resolve(false);
        var size = clampSize(input.value);
        input.value = size;

        var oldLabel = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = '…'; }
        if (!quiet) flash('Resizing “' + fname + '”…', false);

        return fetch(RESIZE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: BATCH_ID, filename: fname, size: size })
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
            if (!j || !j.ok) {
              if (!quiet) flash('Resize failed: ' + ((j && j.error) || 'unknown'), true);
              return false;
            }
            var img  = card.querySelector('[data-role="rimg"]');
            var link = card.querySelector('.iw-pair .iw-cell:last-child .iw-thumblink');
            var dims = card.querySelector('[data-role="rdims"]');
            var sz   = card.querySelector('[data-role="rsize"]');
            var note = card.querySelector('[data-role="rnote"]');
            if (img)  img.src = j.url;
            if (link) link.setAttribute('href', j.url);
            if (dims) dims.textContent = j.width + '×' + j.height;
            if (sz)   sz.textContent = j.niceSize;
            if (note) {
              if (j.noShrink) {
                note.textContent = '≥ source — no shrink';
                note.setAttribute('title', "The test size is at or above the source's long edge, so no downscale happened.");
              } else {
                note.textContent = j.pct + '% of source';
                note.removeAttribute('title');
              }
            }
            input.value = j.size;
            if (!quiet) flash('Resized “' + fname + '” → ' + j.size + ' px ✓' + (j.sidecar ? '' : ' (size not saved)'), !j.sidecar);
            return true;
          })
          .catch(function () {
            if (btn) { btn.disabled = false; btn.textContent = oldLabel; }
            if (!quiet) flash('Resize failed (network)', true);
            return false;
          });
      }

      grid.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.iw-edge-apply') : null;
        if (!btn) return;
        var card = btn.closest('.iw-card');
        if (card) applyCard(card, btn, false);
      });
      // Enter inside a long-edge input applies that card.
      grid.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var input = e.target.closest ? e.target.closest('.iw-edge') : null;
        if (!input) return;
        e.preventDefault();
        var card = input.closest('.iw-card');
        if (card) applyCard(card, card.querySelector('.iw-edge-apply'), false);
      });

      // ── Global helpers (4g-3b) ───────────────────────────────────
      var globalInput = document.getElementById('iw-size');
      var copyAllBtn  = document.getElementById('iw-copy-all');
      var applyAllBtn = document.getElementById('iw-apply-all');
      var busy        = document.getElementById('iw-busy');
      var busyMsg     = document.getElementById('iw-busy-msg');

      function allCards() {
        return Array.prototype.slice.call(grid.querySelectorAll('.iw-card'));
      }

      // Copy to all — pure DOM seed: fill every card's long-edge field with
      // the global value. No render, no server. Apply still has to be hit.
      if (copyAllBtn && globalInput) {
        copyAllBtn.addEventListener('click', function () {
          var size = clampSize(globalInput.value);
          globalInput.value = size;
          var cards = allCards();
          cards.forEach(function (c) {
            var input = c.querySelector('.iw-edge');
            if (input) input.value = size;
          });
          flash('Set ' + cards.length + ' field' + (cards.length === 1 ? '' : 's') + ' to ' + size + ' px — hit “Apply to all” to render', false);
        });
      }

      // Apply to all — re-render + persist every card at its current input
      // value, sequentially (one GD pass at a time), with a busy overlay.
      if (applyAllBtn) {
        applyAllBtn.addEventListener('click', function () {
          var cards = allCards();
          if (!cards.length) { flash('No images to resize', false); return; }
          applyAllBtn.disabled = true;
          if (copyAllBtn) copyAllBtn.disabled = true;
          var done = 0, failed = 0;
          function setBusy() {
            if (busyMsg) busyMsg.textContent = 'Resizing ' + (done + 1) + ' of ' + cards.length + '…';
            if (busy) busy.hidden = false;
          }
          setBusy();
          var chain = Promise.resolve();
          cards.forEach(function (card) {
            chain = chain.then(function () {
              var b = card.querySelector('.iw-edge-apply');
              return applyCard(card, b, true).then(function (ok) {
                if (!ok) failed++;
                done++;
                setBusy();
              });
            });
          });
          chain.then(function () {
            if (busy) busy.hidden = true;
            applyAllBtn.disabled = false;
            if (copyAllBtn) copyAllBtn.disabled = false;
            if (failed) flash('Applied to ' + (done - failed) + ' / ' + done + ' — ' + failed + ' failed', true);
            else flash('Applied to all ' + done + ' image' + (done === 1 ? '' : 's') + ' ✓', false);
          });
        });
      }
    })();

    // Click-to-view lightbox (4g-2b). Both thumb cells (original + resized)
    // are <a href="<full url>">; intercept the click and show that image in
    // an overlay instead of opening a new tab. The href stays as a no-JS
    // fallback.
    (function () {
      var grid  = document.getElementById('iw-grid');
      var box   = document.getElementById('iw-lightbox');
      var imgEl = document.getElementById('iw-lightbox-img');
      var close = document.getElementById('iw-lightbox-close');
      if (!grid || !box || !imgEl) return;

      function open(href) { imgEl.src = href; box.hidden = false; }
      function shut() { box.hidden = true; imgEl.src = ''; }

      grid.addEventListener('click', function (e) {
        var a = e.target.closest('.iw-thumblink');
        if (!a) return;
        e.preventDefault();
        open(a.getAttribute('href'));
      });
      if (close) close.addEventListener('click', shut);
      box.addEventListener('click', function (e) {
        if (e.target === box) shut(); // click on backdrop (not the image)
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !box.hidden) shut();
      });
    })();
  </script>
  <!-- v<?= $v ?> -->
  <?php snippet('sync-peer-indicator') ?>
</body>
</html>
