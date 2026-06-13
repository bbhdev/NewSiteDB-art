<?php
/**
 * Canvas page runtime template — Phase 2 Slice 1.
 *
 * Reads two side-by-side per-page artefacts:
 *   - content/<page>/rects.json — the rect layout authored at /dev/page.
 *     Shape: {schemaVersion, chapters, rects}. See dev-page.js + the
 *     dev/page/save route for the canonical shape.
 *   - content/<page>/page.json   — Deco's per-page class config. We pick
 *     the widest entry in useClasses as the Slice-1 "primary class" and
 *     use its pageW × pageH as the canvas frame.
 *
 * Renders each rect as an absolutely-positioned <div> stub matching the
 * editor's visual language (same kind colours, same labels). Slice 1 has
 * no real content surface — Slice 2 attaches real text/image content.
 *
 * Total page height is derived: max(max(y+h) over rects, pageH) + 80px
 * bottom padding. pageH acts as a visual floor so an empty/shallow page
 * still occupies a reasonable canvas.
 */

$contentRoot = kirby()->root('content');

// Canvas dimensions from Deco's per-page config — single source of truth
// shared with the editor. Same primary-class rule as page.php.
$pageCfg = deco_load_page_config($page->root());
$primaryClassId = null;
$primaryPageW   = -1;
foreach ($pageCfg['useClasses'] as $cid) {
    $w = $pageCfg['dims'][$cid]['pageW'] ?? 0;
    if ($w > $primaryPageW) {
        $primaryPageW   = $w;
        $primaryClassId = $cid;
    }
}
if ($primaryClassId === null) {
    $primaryClassId = 'wide';
    $pageCfg['dims']['wide'] = deco_default_dims();
}
$primaryDims = $pageCfg['dims'][$primaryClassId];
$pageW = (int) $primaryDims['pageW'];
$pageH = (int) $primaryDims['pageH'];

// Rect data. Empty state if rects.json is absent — the page renders as
// an empty canvas at pageW × pageH.
$rectsPath = $page->root() . '/rects.json';
$rectsData = (is_file($rectsPath))
    ? (json_decode(file_get_contents($rectsPath), true) ?: [])
    : [];
$chapters = (isset($rectsData['chapters']) && is_array($rectsData['chapters']))
    ? $rectsData['chapters'] : [];
$rects    = (isset($rectsData['rects']) && is_array($rectsData['rects']))
    ? $rectsData['rects'] : [];

// Chapter id → name lookup (data-chapter-name on rendered rects so a
// future stylesheet can group-label without a JS pass).
$chapterNameByID = [];
foreach ($chapters as $c) {
    if (isset($c['id'], $c['name'])) {
        $chapterNameByID[$c['id']] = $c['name'];
    }
}

// Total height = max(max(y+h), pageH) + padding. Clamp negative coords
// to 0 for the calculation — the editor doesn't produce them but a
// hand-edited rects.json could.
$bottom = $pageH;
foreach ($rects as $r) {
    $y = isset($r['y']) ? (int) $r['y'] : 0;
    $h = isset($r['h']) ? (int) $r['h'] : 0;
    $b = max(0, $y) + max(0, $h);
    if ($b > $bottom) $bottom = $b;
}
$totalH = $bottom + 80;

$v = option('version', 'dev');

// Palette tokens for runtime CSS custom properties — same shared
// artefact as the editor. Falls back to project :root tokens defined
// in style.css if values are missing/unsafe.
$palette     = deco_load_palette($contentRoot);
$paletteByID = [];
foreach ($palette as $p) {
    if (is_array($p) && isset($p['id'])) $paletteByID[$p['id']] = $p['value'] ?? '';
}
$paletteSafe = function ($v, $fallback) {
    if (!is_string($v) || $v === '') return $fallback;
    $ok = preg_match(
        '/^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9_-]+\)|rgba?\([0-9.,%\s\/-]+\)|hsla?\([0-9.,%\s\/-]+\)|[a-zA-Z]+)$/',
        $v
    );
    return $ok ? $v : $fallback;
};
$paletteText = $paletteSafe($paletteByID['text'] ?? null, 'var(--text)');

// Typography tokens (Slice 3a) — same shared artefact + same emitter as
// the editor, so a text rect's typographyId renders identically here.
// $typoIds gates which refs are honoured at render time (a dangling
// token ref → no class → inherited defaults, graceful like a dangling
// image binding).
$typography = deco_load_typography($contentRoot);
$typoIds = [];
foreach ($typography as $t) {
    if (is_array($t) && isset($t['id'])) $typoIds[(string) $t['id']] = true;
}

// 6020 Slice 1: placeable-snippet whitelist. A snippet-kind rect only renders
// its bound snippet when the id is in this set — the load-bearing guard that a
// dangling/forged `snippet` value can never feed snippet() a structural partial
// or a missing file. Dangling → stub fallback, graceful like a dangling image.
$snippetIds = [];
if (function_exists('deco_placeable_snippets')) {
    foreach (deco_placeable_snippets() as $s) {
        if (is_array($s) && isset($s['id'])) $snippetIds[(string) $s['id']] = true;
    }
}

// v0.11.7 — image-kind content. The per-page image library is the child page
// with slug 'images' (content/<page>/images/, auto-provisioned by the
// page.create:after hook). Resolved via childrenAndDrafts() — the same lookup
// the dev/page/images API route uses — so a rect's bare `image` filename maps
// to a real File→url() here exactly as it does in the editor's bind picker. A
// dangling/absent binding resolves to null → kind stub, graceful like the
// dangling-snippet path. (Slice 1 of canvas-page only stubbed image rects;
// this is the deferred "attach real image content" step.)
$imgPageNode = $page->childrenAndDrafts()->findBy('slug', 'images');

?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= $page->title() ?> — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/style.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/canvas-page.css') ?>?v=<?= $v ?>">
  <?= deco_google_fonts_link($contentRoot) ?>
  <style>
<?= deco_typography_css($typography, $palette) /* element styles incl. palette-resolved colour */ ?>
<?= deco_palette_marks_css($palette) /* TS3-a: .mk-color-<id> per palette colour */ ?>
    :root {
      --cp-palette-text:    <?= $paletteText ?>;
      --cp-kind-text:       #cfe4ff;
      --cp-kind-image:      #ffe7b8;
      --cp-kind-drilldown:  #e6d4ff;
      --cp-kind-snippet:    #c8f0d8;
    }
  </style>
</head>
<body class="canvas-page-body">
  <?php /* 6020/runtime consolidation (v0.11.7): the canvas IS the page. The
          scroll-driven lines render as a fixed full-viewport background layer
          (#lines-layer, z-index:0, pointer-events:none — see style.css), exactly
          as on the flowing site pages. The rect canvas below sits above it in a
          z-index:1 column. Lines and rects are independent layers (the editor
          authors them in separate modes), so no coordinate reconciliation: the
          lines scale to the viewport, the rects occupy a pageW-wide centred
          column — the same lines-behind-content model home.php always used. */ ?>
  <?php snippet('lines-layer') ?>
  <div class="canvas-page"
       data-page-id="<?= esc($page->id()) ?>"
       data-class="<?= esc($primaryClassId) ?>"
       style="width: <?= $pageW ?>px; height: <?= $totalH ?>px; position: relative;">
<?php foreach ($rects as $r):
    $rid   = isset($r['id'])   ? (string) $r['id']   : '';
    $kind  = isset($r['kind']) ? (string) $r['kind'] : 'unknown';
    $x     = isset($r['x'])    ? (int) $r['x']       : 0;
    $y     = isset($r['y'])    ? (int) $r['y']       : 0;
    $w     = isset($r['w'])    ? (int) $r['w']       : 0;
    $h     = isset($r['h'])    ? (int) $r['h']       : 0;
    $chId  = isset($r['chapterId']) ? $r['chapterId'] : null;
    $chNm  = ($chId && isset($chapterNameByID[$chId])) ? $chapterNameByID[$chId] : null;
    // Typography token class for text rects (Slice 3a). Only honoured
    // when the ref resolves to a known token; a dangling ref renders
    // with no class (inherited defaults).
    $tyId  = (isset($r['typographyId']) && is_string($r['typographyId'])
              && isset($typoIds[$r['typographyId']])) ? $r['typographyId'] : null;
    // Slice T1: plain-text body content for text rects. Rendered with
    // white-space:pre-wrap (preserves the author's newlines/spacing) and
    // HTML-escaped via esc() — no markup is interpreted at this slice.
    // Empty/absent text falls back to the kind stub, exactly as before.
    $text  = ($kind === 'text' && isset($r['text']) && is_string($r['text'])
              && trim($r['text']) !== '') ? $r['text'] : null;
    // Slice TS1: style marks (offset ranges). Read defensively — the file
    // may predate marks (→ []), in which case the run render collapses to a
    // single esc($text), identical to the pre-TS1 output.
    $marks = ($kind === 'text' && isset($r['marks']) && is_array($r['marks']))
              ? $r['marks'] : [];
    // 6020 Slice 1: a snippet-kind rect renders a registered placeable snippet.
    // Resolved only when the bound id is whitelisted (see $snippetIds); a
    // dangling/unknown ref → null → kind stub, graceful like a dangling image.
    $snip  = ($kind === 'snippet' && isset($r['snippet']) && is_string($r['snippet'])
              && isset($snippetIds[$r['snippet']])) ? $r['snippet'] : null;
    // v0.11.7: bound image → resolved File url, mirroring the editor's bind
    // render. data-fit (cover|contain) drives object-fit; focusX/focusY (0–100,
    // default 50) drive object-position so a cover-crop shows the chosen region.
    $imgFile = null;
    if ($kind === 'image' && $imgPageNode !== null
        && isset($r['image']) && is_string($r['image']) && $r['image'] !== '') {
        $imgFile = $imgPageNode->image($r['image']); // null if the filename is gone
    }
    $imgUrl  = ($imgFile && $imgFile->exists()) ? $imgFile->url() : null;
    $imgFit  = (isset($r['fit']) && $r['fit'] === 'contain') ? 'contain' : 'cover';
    $imgFX   = isset($r['focusX']) ? max(0, min(100, (int) $r['focusX'])) : 50;
    $imgFY   = isset($r['focusY']) ? max(0, min(100, (int) $r['focusY'])) : 50;
    $rectClass = 'rect rect--' . esc($kind) . ($tyId ? ' ty-' . esc($tyId) : '')
               . ($text !== null ? ' has-text' : '')
               . ($snip !== null ? ' has-snippet' : '')
               . ($imgUrl !== null ? ' has-image' : '');
?>
    <div class="<?= $rectClass ?>"
         data-rect-id="<?= esc($rid) ?>"
         <?php if ($chId): ?>data-chapter="<?= esc($chId) ?>"<?php endif; ?>
         <?php if ($chNm): ?>data-chapter-name="<?= esc($chNm) ?>"<?php endif; ?>
         <?php if ($imgUrl !== null): ?>data-fit="<?= esc($imgFit) ?>"<?php endif; ?>
         style="position: absolute;
                left: <?= $x ?>px; top: <?= $y ?>px;
                width: <?= $w ?>px; height: <?= $h ?>px;">
      <?php if ($snip !== null): ?>
      <?php snippet($snip) /* 6020 Slice 1: render the bound placeable snippet at this rect's position. */ ?>
      <?php elseif ($imgUrl !== null): ?>
      <img class="rect-img" src="<?= esc($imgUrl) ?>" alt="<?= esc($imgFile->alt()->value() ?? '') ?>"
           style="object-position: <?= $imgFX ?>% <?= $imgFY ?>%;"
           draggable="false" loading="lazy">
      <?php elseif ($text !== null): ?>
      <div class="rect-text"><?php
        // TS1/TS3: render derived runs — a link run as <a class="mk-link …"
        // href>, a styled run as <span class="mk-…">, a plain run as escaped
        // text. Mirrors the editor's renderRunsInto. esc() on every run AND on
        // the (already safeHref'd) href keeps it XSS-safe (no markup honoured).
        $segs = deco_text_segments($text, $marks);
        if (empty($segs)) {
            echo esc($text);
        } else {
            foreach ($segs as $seg) {
                $cls  = deco_marks_classes($seg['attrs']);
                $href = deco_marks_href($seg['attrs']);
                if ($href !== null) {
                    $allCls = trim('mk-link ' . implode(' ', $cls));
                    echo '<a class="' . esc($allCls) . '" href="' . esc($href) . '">'
                       . esc($seg['text']) . '</a>';
                } elseif (empty($cls)) {
                    echo esc($seg['text']);
                } else {
                    echo '<span class="' . esc(implode(' ', $cls)) . '">'
                       . esc($seg['text']) . '</span>';
                }
            }
        }
      ?></div>
      <?php else: ?>
      <span class="rect-stub-label"><?= esc($kind) ?></span>
      <span class="rect-stub-id"><?= esc($rid) ?></span>
      <?php endif; ?>
    </div>
<?php endforeach; ?>
  </div>
<?php /* "Published: <date>" badge — same gated snippet the flowing footer emits;
        renders nothing until the first propagate has landed (lastPropagateAt). */ ?>
<?php snippet('published-date') ?>
<?php /* Animation stack — identical to footer.php. app.js reads #lines-data
        (emitted by lines-layer above) and renders the scroll-driven lines; the
        scatter-button wiring no-ops on a page without [data-scatter-btn]. */ ?>
<script src="<?= url('assets/js/gsap.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/ScrollTrigger.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/Draggable.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/InertiaPlugin.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/app.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> · class=<?= esc($primaryClassId) ?> · canvas=<?= $pageW ?>×<?= $totalH ?>px (pageH floor=<?= $pageH ?>) · <?= count($rects) ?> rect(s) -->
</body>
</html>
