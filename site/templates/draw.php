<?php
/**
 * /dev/draw editor template.
 *
 * Loads the current groups + lines for the target page (set via the
 * page's TargetPage field), inlines them as JSON, and hands off to
 * dev-draw.js for the editor UI.
 */

$targetSlug = $page->targetPage()->or('home')->value();
$targetPage = kirby()->page($targetSlug);

// Read the live .json file if it exists, otherwise fall back to the
// committed .example.json seed. Live files are gitignored — see
// site/snippets/lines-layer.php for the full rationale.
$readJson = function ($path) {
  if (!file_exists($path)) {
    $seed = preg_replace('/\.json$/', '.example.json', $path);
    if (file_exists($seed)) $path = $seed;
    else return [];
  }
  $decoded = json_decode(file_get_contents($path), true);
  return is_array($decoded) ? $decoded : [];
};

$groups  = $targetPage ? $readJson($targetPage->root() . '/groups.json') : [];
$lines   = $targetPage ? $readJson($targetPage->root() . '/lines.json')  : [];
$palette = $readJson(kirby()->root('content') . '/colors.json');

// Default palette if the file doesn't exist yet — gives the editor
// something to pick from on first run.
if (empty($palette)) {
  $palette = [
    ['id' => 'text',   'name' => 'Text',   'value' => 'var(--text)'],
    ['id' => 'accent', 'name' => 'Accent', 'value' => 'var(--accent)']
  ];
}

// Scan the target page's template for `id="…"` attributes so the
// trigger-field combobox can suggest selectors that actually exist
// (e.g. "#projects" if the home template has <h2 id="projects">).
$triggerSuggestions = [];
$templatePath = kirby()->root('templates') . '/' . $targetSlug . '.php';
if (file_exists($templatePath)) {
  preg_match_all('/\bid\s*=\s*["\']([^"\']+)["\']/i', file_get_contents($templatePath), $m);
  foreach ($m[1] as $id) $triggerSuggestions[] = '#' . $id;
  $triggerSuggestions = array_values(array_unique($triggerSuggestions));
}

$v = option('version', 'dev');

$payload = json_encode([
  'pageId'             => $targetSlug,
  'groups'             => $groups,
  'lines'              => $lines,
  'palette'            => $palette,
  'triggerSuggestions' => $triggerSuggestions,
  'version'            => $v
], JSON_UNESCAPED_SLASHES);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Draw — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/style.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/dev-draw.css') ?>?v=<?= $v ?>">
</head>
<body class="editor">

<header class="ed-toolbar">
  <div class="ed-brand">
    Lines · <span class="ed-target"><?= esc($targetSlug) ?></span>
    · <span class="ed-version">v<?= esc($v) ?></span>
  </div>

  <div class="ed-tools" role="toolbar" aria-label="Selection">
    <button type="button" class="ed-tool" data-tool="select" title="Select (S) — no drawing; click to select, drag to move">↖ Select</button>
    <button type="button" class="ed-tool" id="select-all-btn" title="Select every object on this page — drag any one to move them all together. Cmd/Shift-click objects to build a custom multi-selection.">Select all</button>
  </div>

  <div class="ed-tools" role="toolbar" aria-label="Drawing tools">
    <button type="button" class="ed-tool" data-tool="freehand"       title="Freehand (F)">Freehand</button>
    <button type="button" class="ed-tool" data-tool="freehandClosed" title="Closed loop (O) — freehand stroke auto-closes and fills">Loop</button>
    <button type="button" class="ed-tool" data-tool="line"           title="Line (L)">Line</button>
    <button type="button" class="ed-tool" data-tool="lineChain"      title="Line chain (C) — click to extend, Esc/double-click to finish">Chain</button>
    <button type="button" class="ed-tool" data-tool="bezier"         title="Bezier (B) — click anchors, smooth curve through them; Esc/double-click to finish">Bezier</button>
  </div>

  <div class="ed-tools" role="toolbar" aria-label="Geometric primitives">
    <button type="button" class="ed-tool" data-tool="circle"  title="Circle — click center, drag for radius">Circle</button>
    <button type="button" class="ed-tool" data-tool="ellipse" title="Ellipse — click center, drag for rx/ry">Ellipse</button>
    <button type="button" class="ed-tool" data-tool="rect"    title="Rectangle — click corner, drag for size">Rect</button>
    <button type="button" class="ed-tool" data-tool="polygon" title="Polygon (triangle / diamond / pentagon / N-gon by setting Sides)">Polygon</button>
    <button type="button" class="ed-tool" data-tool="star"    title="N-pointed star">Star</button>
  </div>

  <div class="ed-tool-settings" id="tool-settings"></div>

  <div class="ed-zoom" role="toolbar" aria-label="Zoom">
    <button type="button" id="zoom-out"   title="Zoom out (−)">−</button>
    <span    id="zoom-level" title="Click to enter an exact zoom percentage">100%</span>
    <button type="button" id="zoom-in"    title="Zoom in (+)">+</button>
  </div>

  <div class="ed-undo" role="toolbar" aria-label="Undo / redo">
    <button type="button" id="undo-btn" title="Undo (Cmd+Z)">↶</button>
    <button type="button" id="redo-btn" title="Redo (Cmd+Shift+Z)">↷</button>
  </div>

  <div class="ed-view" role="toolbar" aria-label="View options">
    <button type="button" id="labels-btn" title="Show / hide name labels on every named line">Labels</button>
    <button type="button" id="grid-btn"   title="Show / hide diagnostic coordinate grid (cyan, 50px step, coords every 100px). Renders on the live site too — useful for comparing where authored coords land in each surface.">Grid</button>
    <button type="button" id="dump-btn"   title="Live site only: when on, dump a console.table of every named line's expected center (params), actual bbox center, shift, and transform attribute at page load. Useful for diagnosing position drift between editor and runtime.">Dump</button>
  </div>

  <div class="ed-spacer"></div>

  <button type="button" id="save-btn" class="ed-save">Save</button>
  <span id="save-status" class="ed-status" aria-live="polite"></span>
</header>

<div class="ed-body">
  <aside class="ed-sidebar">
    <section class="ed-panel">
      <header class="ed-panel-head">
        <h3>Design colors</h3>
        <button type="button" id="new-color-btn" class="ed-mini">+ Color</button>
      </header>
      <ul id="palette-list" class="ed-palette-list"></ul>
    </section>

    <section class="ed-panel">
      <header class="ed-panel-head">
        <h3>Groups</h3>
        <button type="button" id="new-group-btn" class="ed-mini">+ New group</button>
      </header>
      <ul id="groups-list" class="ed-groups"></ul>
    </section>

    <section class="ed-panel" id="selection-panel">
      <!-- Populated dynamically: group settings or line overrides -->
    </section>

    <div class="ed-sidebar-footer">
      <button type="button" id="help-btn"        class="ed-mini">? Help</button>
      <button type="button" id="clear-lines-btn" class="ed-mini ed-danger">Clear all lines</button>
    </div>
  </aside>

  <div class="ed-mode-banner" id="set-origin-banner" hidden>
    Click anywhere on the canvas to set the rotation pivot · <kbd>Esc</kbd> to cancel
  </div>

  <main class="ed-canvas-wrap">
    <!-- viewBox spans -600..1800 horizontally and -400..1200 vertically.
         The central 1200×800 area (0,0 → 1200,800) is the live page
         viewport; everything outside is off-page space, useful for
         lines that slide in via scroll-triggered translates.
         Surface is rendered at 1px=1 viewBox unit (2400×1600px) and
         lives inside an overflow:auto wrap so the user can scroll. -->
    <svg id="draw-surface"
         viewBox="-600 -400 2400 1600"
         width="2400" height="1600"
         preserveAspectRatio="xMidYMid meet"
         xmlns="http://www.w3.org/2000/svg">
      <g id="bg-layer">
        <rect class="bg-outer" x="-600" y="-400" width="2400" height="1600" />
        <rect class="bg-page"  x="0"    y="0"    width="1200" height="800" />
      </g>
      <g id="grid"></g>
      <g id="committed-lines"></g>
      <g id="handles-layer"></g>
      <g id="preview-layer"></g>
      <g id="labels-layer"></g>
    </svg>
  </main>
</div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<script src="<?= url('assets/js/dev-draw.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
</body>
</html>
