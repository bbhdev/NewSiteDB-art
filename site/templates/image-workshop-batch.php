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
 * Deferred to later 4g slices: Dropped=delete (4g-2), per-image long edge
 * (4g-3), in-workshop file rename (4g-5), editable batch names (4g-6).
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
// match the image blueprint's maxLongEdge bounds. (Still global in 4g-1;
// per-image long edge arrives in 4g-3.)
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
    <form method="get" class="iw-sizeform" action="<?= $page->url() ?>">
      <label class="iw-sizelabel" for="iw-size">Test long edge (px)</label>
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
      <button type="submit" class="iw-apply">Apply</button>
    </form>

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
            // Eager resize — generates + caches the derivative.
            $resized = $img->resize($size, $size);
            $rw = $resized->width();
            $rh = $resized->height();
            $origLong = max($ow, $oh);
            $pct = $origLong > 0 ? round(($size <= $origLong ? $size : $origLong) / $origLong * 100) : 100;
            $noShrink = $size >= $origLong;
            $on = !empty($useIt[$img->filename()]);
          ?>
          <article class="iw-card" data-filename="<?= esc($img->filename()) ?>" data-useit="<?= $on ? '1' : '0' ?>">
            <div class="iw-card-head">
              <span class="iw-fname" title="<?= esc($img->filename()) ?>"><?= esc($img->filename()) ?></span>
            </div>

            <div class="iw-pair">
              <figure class="iw-cell">
                <a class="iw-thumblink" href="<?= $img->url() ?>" target="_blank" rel="noopener">
                  <img class="iw-thumb" src="<?= $img->resize(420, 420)->url() ?>" alt="" loading="lazy">
                </a>
                <figcaption class="iw-cap">
                  <span class="iw-cap-tag">original</span>
                  <span class="iw-cap-dims"><?= $ow ?>×<?= $oh ?></span>
                  <span class="iw-cap-size"><?= esc($img->niceSize()) ?></span>
                </figcaption>
              </figure>

              <figure class="iw-cell">
                <a class="iw-thumblink" href="<?= $resized->url() ?>" target="_blank" rel="noopener">
                  <img class="iw-thumb" src="<?= $resized->url() ?>" alt="" loading="lazy">
                </a>
                <figcaption class="iw-cap">
                  <span class="iw-cap-tag iw-cap-tag--resized">resized <?= $size ?></span>
                  <span class="iw-cap-dims"><?= $rw ?>×<?= $rh ?></span>
                  <span class="iw-cap-size"><?= esc($resized->niceSize()) ?></span>
                  <?php if ($noShrink): ?>
                    <span class="iw-cap-note" title="The test size is at or above the source's long edge, so no downscale happened.">≥ source — no shrink</span>
                  <?php else: ?>
                    <span class="iw-cap-note"><?= $pct ?>% of source</span>
                  <?php endif; ?>
                </figcaption>
              </figure>
            </div>

            <!-- Use-it toggle (4g-1). On = the editor will pull this image;
                 off = it stays in the workshop (implicit "rework"). -->
            <div class="iw-controls">
              <button type="button" class="iw-use" aria-pressed="<?= $on ? 'true' : 'false' ?>" aria-label="Toggle Use it for <?= esc($img->filename()) ?>">Use it</button>
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
  </script>
  <!-- v<?= $v ?> -->
  <?php snippet('sync-peer-indicator') ?>
</body>
</html>
