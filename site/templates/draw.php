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

$readJson = function ($path) {
  if (!file_exists($path)) return [];
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

  <div class="ed-tools" role="toolbar" aria-label="Drawing tools">
    <button type="button" class="ed-tool" data-tool="freehand" title="Freehand (F)">Freehand</button>
    <button type="button" class="ed-tool" data-tool="line"     title="Line (L)">Line</button>
    <button type="button" class="ed-tool" data-tool="lineChain" title="Line chain (C) — click to extend, Esc/double-click to finish">Chain</button>
  </div>

  <div class="ed-tool-settings" id="tool-settings"></div>

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

    <p class="ed-help">
      <strong>Tips:</strong> Click an empty space in the canvas with a tool to draw. Click an existing line to select it and edit overrides. In chain mode, click to add segments; Esc or double-click to finish.
    </p>
  </aside>

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
      <g id="preview-layer"></g>
    </svg>
  </main>
</div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<script src="<?= url('assets/js/dev-draw.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
</body>
</html>
