<?php
/**
 * /dev/image-workshop/<batch> grid view — Phase 2 Slice 2 workshop
 * Steps A + B (v0.10.35).
 *
 * v0.10.36 — fix: size picker moved from the top toolbar into the
 * single control bar, so its dropdown is no longer hidden behind the
 * sticky verdict subbar.
 * v0.10.37 — fix: replaced the type=number + datalist combobox (which a
 * browser filters down to options matching the pre-filled value, hiding
 * all other presets) with an explicit <select> of presets that all show,
 * beside the number field for custom entry.
 * v0.10.38 — UX: standard type-or-pick combo. Number field + disclosure
 * caret opening a preset menu; choosing a preset only FILLS the field
 * (no auto-submit), then the user clicks Apply. Replaces the <select>
 * (which showed its own value and executed immediately — confusing).
 *
 * Triage grid. For every image in the batch, renders the original
 * alongside a resized derivative at a chosen long-edge size, with
 * dimensions + file size + open-in-new-tab links for both.
 *
 * Resize semantics mirror the canvas-page runtime and the maxLongEdge
 * commit hook exactly: $file->resize($size, $size) fits the image
 * inside a $size-square box (long edge binds, aspect preserved, no
 * crop — verified against Kirby Dimensions::fitWidthAndHeight). So the
 * derivative shown here is byte-identical to what a commit at the same
 * value would produce.
 *
 * NOTE (perf): resize() is eager — loading this page generates a thumb
 * for every image at the chosen size on first visit, then serves from
 * the /media cache thereafter. For a 20-image batch that's 20 one-time
 * generations. Intended: the whole point is to materialise and inspect
 * the batch. Changing the size regenerates at the new size (the old
 * size stays cached).
 *
 * Step B (v0.10.35) — per-image VERDICT triage: each card carries an
 * ok / rework / dropped toggle, persisted to a per-batch sidecar
 * (verdicts.json) via POST dev/image-workshop/save. A filter bar narrows
 * the grid by verdict, and "Copy rework filenames" yields the bulk
 * Photoshop-handoff list. Verdicts are author judgement, never touch the
 * source files.
 */
$v = option('version', 'dev');

// Test long edge: ?size=NNNN, default 1000, clamped to [200, 8000] to
// match the image blueprint's maxLongEdge bounds.
$sizeRaw = kirby()->request()->get('size');
$size    = is_numeric($sizeRaw) ? (int) $sizeRaw : 1000;
$size    = max(200, min(8000, $size));

$images = $page->images()->sortBy('filename', 'asc');

// Preset sizes offered in the datalist (author can still type any
// value in the number input).
$presets = [800, 1000, 1200, 1600, 2400];

// Load existing verdicts sidecar (written by dev/image-workshop/save).
// Shape: { schemaVersion, verdicts: { "<filename>": "ok|rework|dropped" } }.
$verdictsPath = $page->root() . '/verdicts.json';
$verdicts     = [];
if (is_file($verdictsPath)) {
  $decoded = json_decode(file_get_contents($verdictsPath), true);
  if (is_array($decoded) && isset($decoded['verdicts']) && is_array($decoded['verdicts'])) {
    $verdicts = $decoded['verdicts'];
  }
}

$verdictKinds = ['ok', 'rework', 'dropped'];

// Load the "sent" sidecar (written by dev/image-workshop/use-image).
// Shape: { schemaVersion, sent: { "<filename>": [ {page,title}, ... ] } }.
// Drives the per-card "Sent to …" badges and disables already-sent pages
// in that card's target dropdown.
$sentPath = $page->root() . '/sent.json';
$sentMap  = [];
if (is_file($sentPath)) {
  $decodedSent = json_decode(file_get_contents($sentPath), true);
  if (is_array($decodedSent) && isset($decodedSent['sent']) && is_array($decodedSent['sent'])) {
    $sentMap = $decodedSent['sent'];
  }
}

// Enumerate canvas pages — the transfer targets offered by "Use this".
// Only canvas-page pages are valid (the route enforces this too); their
// `images` children use the image-container template and are skipped
// automatically by the template-name filter.
$canvasPages = [];
foreach (kirby()->site()->index() as $cp) {
  if ($cp->intendedTemplate()->name() !== 'canvas-page') { continue; }
  $canvasPages[] = ['id' => $cp->id(), 'title' => $cp->title()->value()];
}

// Counts per verdict, for the filter-bar badges.
$counts = ['ok' => 0, 'rework' => 0, 'dropped' => 0, 'unrated' => 0];
foreach ($images as $img) {
  $vv = $verdicts[$img->filename()] ?? '';
  if (in_array($vv, $verdictKinds, true)) { $counts[$vv]++; }
  else                                    { $counts['unrated']++; }
}
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

  <!-- Single control bar: size picker (always) + verdict filter/copy
       (only when the batch has images). The size picker lives HERE, not
       in the top toolbar: when it was in the toolbar its datalist popup
       opened downward straight into this sticky opaque bar, which hid
       the dropdown (v0.10.35 regression). With the input inside the bar,
       the popup opens into the grid below — nothing opaque covers it. -->
  <div class="iw-subbar">
    <form method="get" class="iw-sizeform" action="<?= $page->url() ?>">
      <label class="iw-sizelabel" for="iw-size">Test long edge (px)</label>
      <!-- Type-or-pick combo: the number field holds the value; the
           disclosure caret opens a preset list whose choice only FILLS
           the field (no submit). Apply commits. -->
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
    <div class="iw-filterbar" role="group" aria-label="Filter by verdict">
      <span class="iw-filter-label">Show</span>
      <button type="button" class="iw-filter is-active" data-filter="all">All <span class="iw-filter-n"><?= $images->count() ?></span></button>
      <button type="button" class="iw-filter" data-filter="unrated">Unrated <span class="iw-filter-n" data-count="unrated"><?= $counts['unrated'] ?></span></button>
      <button type="button" class="iw-filter iw-filter--ok"      data-filter="ok">OK <span class="iw-filter-n" data-count="ok"><?= $counts['ok'] ?></span></button>
      <button type="button" class="iw-filter iw-filter--rework"  data-filter="rework">Rework <span class="iw-filter-n" data-count="rework"><?= $counts['rework'] ?></span></button>
      <button type="button" class="iw-filter iw-filter--dropped" data-filter="dropped">Dropped <span class="iw-filter-n" data-count="dropped"><?= $counts['dropped'] ?></span></button>
    </div>
    <div class="iw-subbar-actions">
      <span class="iw-savestate" id="iw-savestate" aria-live="polite"></span>
      <button type="button" class="iw-copy" id="iw-copy" title="Copy newline-separated filenames of every image marked Rework">
        Copy rework filenames <span class="iw-copy-n" id="iw-copy-n"><?= $counts['rework'] ?></span>
      </button>
    </div>
    <?php endif; ?>
  </div>

  <!-- Long-operation feedback. Changing the test size regenerates a
       derivative for every image at the new size; on first request
       that's a synchronous GD/Imagick pass per image and can take a
       few seconds for a large batch. The form submit is a normal GET
       navigation, so without this the page would just sit blank with
       only the browser's own tab spinner. This overlay appears the
       instant Apply (or Enter) fires and stays until the regenerated
       page replaces it. -->
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
            // Percentage of the original long edge the derivative keeps.
            $origLong = max($ow, $oh);
            $pct = $origLong > 0 ? round(($size <= $origLong ? $size : $origLong) / $origLong * 100) : 100;
            $noShrink = $size >= $origLong;
            // Current verdict for this file ('' when unrated).
            $verdict = $verdicts[$img->filename()] ?? '';
            if (!in_array($verdict, $verdictKinds, true)) { $verdict = ''; }
            // Pages this image has already been sent to (for badges + to
            // disable those options in this card's dropdown).
            $sentEntries = (isset($sentMap[$img->filename()]) && is_array($sentMap[$img->filename()]))
              ? $sentMap[$img->filename()] : [];
            $sentIds = [];
            foreach ($sentEntries as $se) {
              if (is_array($se) && !empty($se['page'])) { $sentIds[] = $se['page']; }
            }
          ?>
          <article class="iw-card<?= !empty($sentEntries) ? ' is-sent' : '' ?>" data-filename="<?= esc($img->filename()) ?>" data-verdict="<?= esc($verdict) ?>">
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

            <!-- Verdict toggle (Step B). Click the active one again to
                 clear back to unrated. The "Use this" button (Slice 2)
                 appears only when the verdict is OK (CSS-gated on the
                 card's data-verdict) and sits immediately right of OK. -->
            <div class="iw-verdict" role="group" aria-label="Verdict for <?= esc($img->filename()) ?>">
              <button type="button" class="iw-vbtn iw-vbtn--ok"      data-verdict="ok"<?=      $verdict === 'ok'      ? ' aria-pressed="true"' : '' ?>>OK</button>
              <button type="button" class="iw-use" aria-haspopup="true" aria-expanded="false" title="Send the resized image to a page">Use it</button>
              <button type="button" class="iw-vbtn iw-vbtn--rework"  data-verdict="rework"<?=  $verdict === 'rework'  ? ' aria-pressed="true"' : '' ?>>Rework</button>
              <button type="button" class="iw-vbtn iw-vbtn--dropped" data-verdict="dropped"<?= $verdict === 'dropped' ? ' aria-pressed="true"' : '' ?>>Dropped</button>
            </div>

            <!-- Transfer affordance (Slice 2). The picker stays hidden
                 until "Use this" is clicked. The sent-list shows which
                 page(s) this resized image has already been sent to;
                 those pages are pre-disabled in the dropdown. -->
            <div class="iw-send">
              <div class="iw-send-picker" hidden>
                <select class="iw-send-select" aria-label="Choose target page">
                  <option value="">Choose a page…</option>
                  <?php foreach ($canvasPages as $cpi): $isSent = in_array($cpi['id'], $sentIds, true); ?>
                    <option value="<?= esc($cpi['id']) ?>"<?= $isSent ? ' disabled' : '' ?>><?= esc($cpi['title']) ?><?= $isSent ? ' (sent)' : '' ?></option>
                  <?php endforeach; ?>
                </select>
                <button type="button" class="iw-send-go">Send</button>
                <button type="button" class="iw-send-cancel" aria-label="Cancel">✕</button>
              </div>
              <div class="iw-sent-list"<?= empty($sentEntries) ? ' hidden' : '' ?>>
                <span class="iw-sent-label">Sent to:</span>
                <?php foreach ($sentEntries as $se): if (!is_array($se)) continue; ?>
                  <span class="iw-sent-chip" data-page="<?= esc($se['page'] ?? '') ?>"><?= esc($se['title'] ?? ($se['page'] ?? '?')) ?></span>
                <?php endforeach; ?>
              </div>
            </div>
          </article>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </main>

  <script>
    // Size picker (type-or-pick combo) + busy overlay. Vanilla, no build
    // step.
    (function () {
      var form  = document.querySelector('.iw-sizeform');
      var busy  = document.getElementById('iw-busy');
      var msg   = document.getElementById('iw-busy-msg');
      var input = document.getElementById('iw-size');
      var caret = document.getElementById('iw-sizecaret');
      var menu  = document.getElementById('iw-sizemenu');
      var count = <?= (int) $images->count() ?>;
      if (!form) return;

      // Disclosure combo: caret toggles the preset list; choosing an
      // option only fills the input (the standard pattern — no auto-
      // submit). The user then clicks Apply.
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

    // Verdict triage (Step B): per-card toggle, client-side filter,
    // copy-rework, debounced persistence.
    (function () {
      var grid = document.getElementById('iw-grid');
      if (!grid) return;

      var SAVE_URL = <?= json_encode(url('dev/image-workshop/save')) ?>;
      var BATCH_ID = <?= json_encode($page->id()) ?>;
      var KINDS    = ['ok', 'rework', 'dropped'];

      var cards     = Array.prototype.slice.call(grid.querySelectorAll('.iw-card'));
      var filterBtns= Array.prototype.slice.call(document.querySelectorAll('.iw-filter'));
      var saveState = document.getElementById('iw-savestate');
      var copyBtn   = document.getElementById('iw-copy');
      var copyN     = document.getElementById('iw-copy-n');

      // Seed in-memory verdict map from the rendered DOM (source of truth
      // on load is what the server wrote).
      var verdicts = {};
      cards.forEach(function (card) {
        var v = card.getAttribute('data-verdict') || '';
        if (KINDS.indexOf(v) !== -1) verdicts[card.getAttribute('data-filename')] = v;
      });

      // ── Counts + copy-button badge ───────────────────────────────
      function recount() {
        var c = { ok: 0, rework: 0, dropped: 0, unrated: 0 };
        cards.forEach(function (card) {
          var v = card.getAttribute('data-verdict') || '';
          if (KINDS.indexOf(v) !== -1) c[v]++; else c.unrated++;
        });
        filterBtns.forEach(function (b) {
          var key = b.getAttribute('data-filter');
          var n   = b.querySelector('.iw-filter-n');
          if (!n) return;
          if (key === 'all') n.textContent = cards.length;
          else if (c.hasOwnProperty(key)) n.textContent = c[key];
        });
        if (copyN) copyN.textContent = c.rework;
        if (copyBtn) copyBtn.disabled = c.rework === 0;
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
          body: JSON.stringify({ batch: BATCH_ID, verdicts: verdicts })
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok) { flash('Saved ✓', false); }
            else { flash('Save failed: ' + ((j && j.error) || 'unknown'), true); }
          })
          .catch(function () { flash('Save failed (network)', true); });
      }

      // ── Verdict toggle ───────────────────────────────────────────
      grid.addEventListener('click', function (e) {
        var btn = e.target.closest('.iw-vbtn');
        if (!btn) return;
        var card = btn.closest('.iw-card');
        if (!card) return;
        var fname   = card.getAttribute('data-filename');
        var picked  = btn.getAttribute('data-verdict');
        var current = card.getAttribute('data-verdict') || '';
        var next    = (current === picked) ? '' : picked; // re-click clears

        card.setAttribute('data-verdict', next);
        // Reflect aria-pressed on the three buttons in this card.
        card.querySelectorAll('.iw-vbtn').forEach(function (b) {
          if (b.getAttribute('data-verdict') === next) b.setAttribute('aria-pressed', 'true');
          else b.removeAttribute('aria-pressed');
        });

        if (next) verdicts[fname] = next; else delete verdicts[fname];

        recount();
        applyFilter(); // a now-filtered-out card hides immediately
        scheduleSave();
      });

      // ── Filtering (client-side) ──────────────────────────────────
      var activeFilter = 'all';
      function applyFilter() {
        cards.forEach(function (card) {
          var v = card.getAttribute('data-verdict') || '';
          var show;
          if (activeFilter === 'all')          show = true;
          else if (activeFilter === 'unrated') show = (KINDS.indexOf(v) === -1);
          else                                 show = (v === activeFilter);
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

      // ── Copy rework filenames ────────────────────────────────────
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var names = cards
            .filter(function (c) { return c.getAttribute('data-verdict') === 'rework'; })
            .map(function (c) { return c.getAttribute('data-filename'); });
          if (!names.length) { flash('No images marked Rework', false); return; }
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

    // "Use this" transfer (Slice 2): per-card, send the RESIZED image (at
    // the current test long edge) to a chosen canvas page. The button is
    // CSS-gated to appear only when the card's verdict is OK. A second
    // grid-level click listener — disjoint from the verdict one above
    // (.iw-use / .iw-send-* selectors never match .iw-vbtn).
    (function () {
      var grid = document.getElementById('iw-grid');
      if (!grid) return;

      var USE_URL  = <?= json_encode(url('dev/image-workshop/use-image')) ?>;
      var BATCH_ID = <?= json_encode($page->id()) ?>;
      var SIZE     = <?= (int) $size ?>;

      function setOpen(card, on) {
        var picker = card.querySelector('.iw-send-picker');
        var useBtn = card.querySelector('.iw-use');
        if (picker) picker.hidden = !on;
        if (useBtn) useBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) { var sel = card.querySelector('.iw-send-select'); if (sel) sel.focus(); }
      }

      grid.addEventListener('click', function (e) {
        var card = e.target.closest('.iw-card');
        if (!card) return;

        if (e.target.closest('.iw-use')) {
          var picker = card.querySelector('.iw-send-picker');
          setOpen(card, picker ? picker.hidden : true);
          return;
        }
        if (e.target.closest('.iw-send-cancel')) { setOpen(card, false); return; }

        var goBtn = e.target.closest('.iw-send-go');
        if (!goBtn) return;

        var sel    = card.querySelector('.iw-send-select');
        var pageId = sel ? sel.value : '';
        if (!pageId) { if (sel) sel.focus(); return; }
        var fname = card.getAttribute('data-filename');

        goBtn.disabled = true; goBtn.textContent = 'Sending…';
        fetch(USE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ batch: BATCH_ID, filename: fname, size: SIZE, targetPage: pageId })
        }).then(function (r) { return r.json(); })
          .then(function (j) {
            goBtn.disabled = false; goBtn.textContent = 'Send';
            if (!j || !j.ok) { alert('Send failed: ' + ((j && j.error) || 'unknown')); return; }
            markSent(card, j.page, j.title);
            setOpen(card, false);
          })
          .catch(function () {
            goBtn.disabled = false; goBtn.textContent = 'Send';
            alert('Send failed (network).');
          });
      });

      function markSent(card, pageId, title) {
        card.classList.add('is-sent');
        var list = card.querySelector('.iw-sent-list');
        if (list) {
          list.hidden = false;
          var esc = String(pageId).replace(/["\\]/g, '\\$&');
          if (!list.querySelector('.iw-sent-chip[data-page="' + esc + '"]')) {
            var chip = document.createElement('span');
            chip.className = 'iw-sent-chip';
            chip.setAttribute('data-page', pageId);
            chip.textContent = title || pageId;
            list.appendChild(chip);
          }
        }
        // Disable that page in this card's dropdown (avoids a duplicate copy).
        var sel = card.querySelector('.iw-send-select');
        if (sel) {
          Array.prototype.forEach.call(sel.options, function (o) {
            if (o.value === pageId) {
              o.disabled = true;
              if (o.textContent.indexOf('(sent)') === -1) o.textContent += ' (sent)';
            }
          });
          sel.value = '';
        }
      }
    })();
  </script>
  <!-- v<?= $v ?> -->
</body>
</html>
