<?php
/**
 * /dev/image-workshop/<batch> grid view — Phase 2 Slice 2 workshop
 * Step A (v0.10.33).
 *
 * Pure-inspection triage grid. For every image in the batch, renders
 * the original alongside a resized derivative at a chosen long-edge
 * size, with dimensions + file size + open-in-new-tab links for both.
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
 * Step B adds per-image verdict (ok / rework / dropped) + filter +
 * copy-filenames; Step C adds multi-size columns. Step A is inspection
 * only.
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

    <form method="get" class="iw-sizeform" action="<?= $page->url() ?>">
      <label class="iw-sizelabel" for="iw-size">Test long edge (px)</label>
      <input type="number" id="iw-size" name="size" class="iw-sizeinput"
             min="200" max="8000" step="10" value="<?= $size ?>"
             list="iw-size-presets" inputmode="numeric">
      <datalist id="iw-size-presets">
        <?php foreach ($presets as $p): ?>
          <option value="<?= $p ?>"></option>
        <?php endforeach; ?>
      </datalist>
      <button type="submit" class="iw-apply">Apply</button>
    </form>

    <span class="iw-version">v<?= esc($v) ?></span>
  </header>

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
      <div class="iw-grid">
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
          ?>
          <article class="iw-card">
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
          </article>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </main>

  <script>
    // Show the busy overlay on size-form submit. Vanilla, no build
    // step (matches /dev/draw + /dev/page). Message names the image
    // count + target size so the author knows what's happening.
    (function () {
      var form  = document.querySelector('.iw-sizeform');
      var busy  = document.getElementById('iw-busy');
      var msg   = document.getElementById('iw-busy-msg');
      var input = document.getElementById('iw-size');
      var count = <?= (int) $images->count() ?>;
      if (!form || !busy) return;
      form.addEventListener('submit', function () {
        var sz = input ? input.value : '';
        msg.textContent = 'Generating ' + count + ' derivative' +
          (count === 1 ? '' : 's') + ' at ' + sz + ' px…';
        busy.hidden = false;
      });
    })();
  </script>
  <!-- v<?= $v ?> -->
</body>
</html>
