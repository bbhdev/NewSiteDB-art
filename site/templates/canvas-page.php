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
 * no real content surface — Slice 2 attaches real text/image content,
 * Slice 4 wires the Deco bootstrapper into deco-mount rects, etc.
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
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title><?= $page->title() ?> — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/style.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/canvas-page.css') ?>?v=<?= $v ?>">
  <style>
    :root {
      --cp-palette-text:    <?= $paletteText ?>;
      --cp-kind-text:       #cfe4ff;
      --cp-kind-image:      #ffe7b8;
      --cp-kind-drilldown:  #e6d4ff;
      --cp-kind-deco-mount: #d4f1d6;
    }
  </style>
</head>
<body class="canvas-page-body">
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
?>
    <div class="rect rect--<?= esc($kind) ?>"
         data-rect-id="<?= esc($rid) ?>"
         <?php if ($chId): ?>data-chapter="<?= esc($chId) ?>"<?php endif; ?>
         <?php if ($chNm): ?>data-chapter-name="<?= esc($chNm) ?>"<?php endif; ?>
         style="position: absolute;
                left: <?= $x ?>px; top: <?= $y ?>px;
                width: <?= $w ?>px; height: <?= $h ?>px;">
      <span class="rect-stub-label"><?= esc($kind) ?></span>
      <span class="rect-stub-id"><?= esc($rid) ?></span>
    </div>
<?php endforeach; ?>
  </div>
<!-- v<?= $v ?> · class=<?= esc($primaryClassId) ?> · canvas=<?= $pageW ?>×<?= $totalH ?>px (pageH floor=<?= $pageH ?>) · <?= count($rects) ?> rect(s) -->
</body>
</html>
