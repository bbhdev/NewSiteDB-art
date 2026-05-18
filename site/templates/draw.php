<?php
/**
 * /dev/draw editor template.
 *
 * Loads ALL classes' lines + groups for the target page so the
 * editor can hot-swap class without a page reload. The target page
 * itself is URL-driven (?page=<slug>), falling back to the editor's
 * TargetPage field for first-load convenience.
 */

$requestedPage = kirby()->request()->get('page');
$targetSlug    = (is_string($requestedPage) && $requestedPage !== '')
    ? $requestedPage
    : $page->targetPage()->or('home')->value();
$targetPage    = kirby()->page($targetSlug);

// Fall back to home if the requested page doesn't exist, so a
// bookmarked-but-renamed page still loads something.
if (!$targetPage) {
    $targetSlug = 'home';
    $targetPage = kirby()->page('home');
}

// Build the page-picker options. Skip the /dev tree (the editor
// itself) and the error page.
$pageOptions = [];
foreach (kirby()->site()->index() as $p) {
    $id = $p->id();
    if ($id === 'dev' || strpos($id, 'dev/') === 0) continue;
    if ($id === 'error') continue;
    $pageOptions[] = [
        'id'    => $id,
        'title' => $p->title()->value(),
    ];
}

$readJson = function ($path) {
  if (!file_exists($path)) {
    $seed = preg_replace('/\.json$/', '.example.json', $path);
    if (file_exists($seed)) $path = $seed;
    else return [];
  }
  $decoded = json_decode(file_get_contents($path), true);
  return is_array($decoded) ? $decoded : [];
};

$classes   = art_load_classes(kirby()->root('content'));
$pageCfg   = $targetPage ? art_load_page_config($targetPage->root())
                        : ['useClasses' => ['wide'], 'dims' => ['wide' => art_default_dims()]];

// Load every class's lines + groups; the editor switches between
// them in-memory.
$byClass = [];
foreach ($pageCfg['useClasses'] as $cid) {
    $byClass[$cid] = $targetPage
        ? art_load_class_data($targetPage->root(), $cid)
        : ['lines' => [], 'groups' => []];
}

// Default initial class for first paint. JS may override from
// localStorage right after init so the user's last-used class for
// this session takes effect.
$initialClassId = in_array('wide', $pageCfg['useClasses'], true)
    ? 'wide'
    : ($pageCfg['useClasses'][0] ?? 'wide');
$initialDims    = $pageCfg['dims'][$initialClassId] ?? art_default_dims();

$palette   = $readJson(kirby()->root('content') . '/colors.json');

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
  'pages'              => $pageOptions,
  'classId'            => $initialClassId,
  'classes'            => $classes,
  'byClass'            => $byClass,
  'palette'            => $palette,
  'page'               => $pageCfg,
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
    <span class="ed-brand-mark">Lines</span>
    <label class="ed-page-picker" title="Switch target page (reloads the editor)">
      <select id="page-select">
        <?php foreach ($pageOptions as $opt): ?>
          <?php
            $title = $opt['title'] !== '' ? $opt['title'] : $opt['id'];
            $label = ($title !== $opt['id'])
                ? $title . ' (' . $opt['id'] . ')'
                : $opt['id'];
          ?>
          <option value="<?= esc($opt['id']) ?>"<?= $opt['id'] === $targetSlug ? ' selected' : '' ?>>
            <?= esc($label) ?>
          </option>
        <?php endforeach; ?>
      </select>
    </label>
    <div class="ed-class-tabs" role="tablist" aria-label="Screen class">
      <!-- DEBUG: pageCfg useClasses = <?= json_encode($pageCfg['useClasses'] ?? null) ?> ; targetPage root = <?= $targetPage ? esc($targetPage->root()) : 'null' ?> ; page.json exists = <?= ($targetPage && is_file($targetPage->root() . '/page.json')) ? 'yes' : 'no' ?> -->
      <?php foreach ($pageCfg['useClasses'] as $cid): ?>
        <?php
          $label = ucfirst($cid);
          foreach ($classes as $c) {
              if ($c['id'] === $cid) {
                  $label = $c['name'] ?: ucfirst($cid);
                  break;
              }
          }
          $isActive = $cid === $initialClassId;
        ?>
        <button type="button"
                class="ed-class-tab<?= $isActive ? ' is-active' : '' ?>"
                data-class-id="<?= esc($cid) ?>"
                role="tab"
                aria-selected="<?= $isActive ? 'true' : 'false' ?>"
                title="Edit the <?= esc($label) ?> class"><?= esc($label) ?></button>
      <?php endforeach; ?>
    </div>
    <span class="ed-version">v<?= esc($v) ?></span>
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

  <div class="ed-view" role="toolbar" aria-label="Save and settings">
    <button type="button" id="save-btn"     class="ed-save">Save</button>
    <button type="button" id="settings-btn" class="ed-settings" title="Settings — editor preferences and diagnostic toggles" aria-label="Settings">⚙</button>
    <span id="save-status" class="ed-status" aria-live="polite"></span>
  </div>

  <div class="ed-spacer"></div>
</header>

<div class="ed-body">
  <aside class="ed-sidebar">
    <section class="ed-panel" id="canvas-panel">
      <header class="ed-panel-head">
        <h3>Canvas</h3>
        <button type="button" id="clone-class-btn" class="ed-mini"
                title="Copy another class's lines + groups into this one as a starting point. The dims of this class are not changed.">Clone from…</button>
      </header>
      <div id="canvas-fields" class="ed-canvas-fields"></div>
    </section>

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
      <button type="button" id="clear-lines-btn" class="ed-mini ed-danger">Clear the canvas</button>
    </div>
  </aside>

  <div class="ed-mode-banner" id="set-origin-banner" hidden>
    Click anywhere on the canvas to set the rotation pivot · <kbd>Esc</kbd> to cancel
  </div>

<?php
  $dims = $initialDims;
  $vb   = art_viewbox($dims);
?>
  <main class="ed-canvas-wrap">
    <!-- Canvas geometry is driven by the current class's dims (from
         page.json's dims[<classId>]). The page area is the central
         pageW×pageH zone at (0, 0); the viewBox extends symmetrically
         around it to canvasW×canvasH so lines that drift on/off the
         page have room to live. 1px = 1 viewBox unit at zoom 1.0. -->
    <svg id="draw-surface"
         viewBox="<?= art_viewbox_attr($dims) ?>"
         width="<?= $dims['canvasW'] ?>" height="<?= $dims['canvasH'] ?>"
         preserveAspectRatio="xMidYMid meet"
         xmlns="http://www.w3.org/2000/svg">
      <g id="bg-layer">
        <rect class="bg-outer" x="<?= $vb['x'] ?>" y="<?= $vb['y'] ?>" width="<?= $dims['canvasW'] ?>" height="<?= $dims['canvasH'] ?>" />
        <rect class="bg-page"  x="0" y="0" width="<?= $dims['pageW'] ?>" height="<?= $dims['pageH'] ?>" />
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
