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
// itself), the error page, and any "subpage" that's really a
// class folder our migration created inside each page (Kirby
// treats every folder as a page).
$contentRoot = kirby()->root('content');
$classes     = deco_load_classes($contentRoot);
$classIds    = array_map(function ($c) { return $c['id']; }, $classes);
$pageOptions = [];
foreach (kirby()->site()->index() as $p) {
    $id = $p->id();
    if ($id === 'dev' || strpos($id, 'dev/')   === 0) continue;
    if ($id === 'error' || strpos($id, 'error/') === 0) continue;
    $segments = explode('/', $id);
    $last = end($segments);
    if (in_array($last, $classIds, true)) continue;
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

$pageCfg     = $targetPage ? deco_load_page_config($targetPage->root())
                          : ['useClasses' => ['wide'], 'dims' => ['wide' => deco_default_dims()]];
$masters     = deco_load_masters($contentRoot);

// Per-class instances + groups (v4 shape: { instances, groups }).
$byClass = [];
foreach ($pageCfg['useClasses'] as $cid) {
    $byClass[$cid] = $targetPage
        ? deco_load_class_data($targetPage->root(), $cid)
        : ['instances' => [], 'groups' => []];
}

// Default initial class for first paint. JS may override from
// localStorage right after init so the user's last-used class for
// this session takes effect.
$initialClassId = in_array('wide', $pageCfg['useClasses'], true)
    ? 'wide'
    : ($pageCfg['useClasses'][0] ?? 'wide');
$initialDims    = $pageCfg['dims'][$initialClassId] ?? deco_default_dims();

$palette   = deco_load_palette($contentRoot);

// Default palette if the file doesn't exist yet — gives the editor
// something to pick from on first run.
if (empty($palette)) {
  $palette = [
    ['id' => 'text',   'name' => 'Text',   'value' => 'var(--text)'],
    ['id' => 'accent', 'name' => 'Accent', 'value' => 'var(--accent)']
  ];
}

// Typography tokens (Slice 3b). deco_load_typography() returns the seed
// set when the file is absent, so the panel always has something to show.
$typography = deco_load_typography($contentRoot);

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

// Image source suggestions for the "Image URL" panel field — list
// of public URLs the user is likely to want, so they can pick from
// a datalist autocomplete instead of typing a path from memory.
// Sources: files attached to the target page (Kirby's $page->images())
// + anything in assets/images/. Free-form URL still works (external
// CDN, full URL, whatever) — this just removes friction for the
// common "image already on the server" case.
$imageSources = [];
$pageObj = $targetSlug ? page($targetSlug) : null;
if ($pageObj) {
  foreach ($pageObj->images() as $img) {
    $imageSources[] = (string)$img->url();
  }
}
$assetsImgDir = kirby()->root('assets') . '/images';
if (is_dir($assetsImgDir)) {
  $imgExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif'];
  foreach (scandir($assetsImgDir) as $f) {
    if ($f === '.' || $f === '..') continue;
    $full = $assetsImgDir . '/' . $f;
    if (!is_file($full)) continue;
    $ext = strtolower(pathinfo($f, PATHINFO_EXTENSION));
    if (!in_array($ext, $imgExts, true)) continue;
    $imageSources[] = '/assets/images/' . $f;
  }
}
$imageSources = array_values(array_unique($imageSources));
sort($imageSources);

$v = option('version', 'dev');

$payload = json_encode([
  'pageId'             => $targetSlug,
  'pages'              => $pageOptions,
  'classId'            => $initialClassId,
  'classes'            => $classes,
  'masters'            => $masters,
  'byClass'            => $byClass,
  'palette'            => $palette,
  'typography'         => $typography,
  'page'               => $pageCfg,
  'triggerSuggestions' => $triggerSuggestions,
  'imageSources'       => $imageSources,
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
  <?php /* Slice 3b: load the curated webfonts + emit one .ty-<id> rule per
           token so the typography panel's per-row previews render with the
           real family/size — same emitter the page editor & runtime use. */ ?>
  <?= deco_google_fonts_link($contentRoot) ?>
  <style id="ed-typography-css"><?= deco_typography_css($typography) ?></style>
</head>
<body class="editor">

<header class="ed-toolbar">
  <div class="ed-brand">
    <a class="ed-back" href="<?= esc(kirby()->url() . '/' . kirby()->option('panel.slug', 'panel')) ?>" title="Back to the Kirby Panel">‹ Panel</a>
    <span class="ed-brand-mark">Draw</span>
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
      <button type="button"
              id="clone-class-btn"
              class="ed-icon-btn ed-class-clone"
              title="Clone groups from another class into this one — pick which groups to bring across."
              aria-label="Clone groups from another class"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <button type="button"
              id="scope-mode-btn"
              class="ed-scope-mode is-mode-all"
              title="Scope: ALL classes — edits apply across every class. Click to restrict to the current class only."
              aria-label="Toggle edit scope">A</button>
    </div>
  </div>

  <div class="ed-tools" role="toolbar" aria-label="Selection">
    <button type="button" class="ed-tool" data-tool="select" title="Select (S) — no drawing; click to select, drag to move">↖ Select</button>
    <button type="button" class="ed-tool" id="select-all-btn" title="Select every object on this page — drag any one to move them all together. Cmd/Shift-click objects to build a custom multi-selection.">Select all</button>
  </div>

  <div class="ed-tools" role="toolbar" aria-label="Create">
    <button type="button" id="create-object-btn" class="ed-create-btn"
            title="Create a new object — opens a panel to pick the shape type or import an SVG file, and choose which classes it should appear in">+ Create object</button>
    <!-- v0.8.36: the SVG import affordance moved INTO the Create
         object modal so the toolbar isn't crowded with two
         logically-similar "give me a new object" actions. The
         file input stays at page scope so the change handler bound
         in dev-draw.js still works — the modal's new Import button
         just triggers .click() on it. -->
    <input type="file" id="import-svg-input" accept=".svg,image/svg+xml" multiple hidden>
    <button type="button" id="library-btn" class="ed-create-btn"
            title="Project hub: Master library, Overview, Orphans, Snapshots.">▦ Project</button>
  </div>

  <div class="ed-tool-settings" id="tool-settings"></div>

  <div class="ed-view" role="toolbar" aria-label="Save and settings">
    <button type="button" id="save-btn"     class="ed-save">Save</button>
    <button type="button" id="settings-btn" class="ed-icon-btn ed-settings" title="Settings — editor preferences and diagnostic toggles" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button type="button" id="help-btn" class="ed-icon-btn ed-help" title="Editor tips — tools, selection, gestures, shortcuts" aria-label="Help"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg></button>
    <span id="save-status" class="ed-status" aria-live="polite"></span>
  </div>

  <span class="ed-version">v<?= esc($v) ?></span>
</header>

<div class="ed-body">
  <aside class="ed-sidebar">
    <!-- v0.10.43: zoom + undo/redo relocated here from the top toolbar.
         They're low-frequency relative to the canvas itself, and the
         sidebar scrolls, so a control row here costs no layout budget
         and lets the top toolbar stay a single row. IDs are unchanged
         so dev-draw.js bindings still resolve. -->
    <section class="ed-panel ed-panel--controls">
      <div class="ed-zoom" role="toolbar" aria-label="Zoom">
        <button type="button" id="zoom-out"   title="Zoom out (−)">−</button>
        <span    id="zoom-level" title="Click to enter an exact zoom percentage">100%</span>
        <button type="button" id="zoom-in"    title="Zoom in (+)">+</button>
      </div>
      <div class="ed-undo" role="toolbar" aria-label="Undo / redo">
        <button type="button" id="undo-btn" title="Undo (Cmd+Z)">↶</button>
        <button type="button" id="redo-btn" title="Redo (Cmd+Shift+Z)">↷</button>
      </div>
    </section>

    <!-- Working panels first: groups list + the contextual selection
         panel are what the user touches most. -->
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

    <!-- Setup panels last: canvas dims + palette are configured once
         at the start of a page and rarely revisited, so they live at
         the bottom of the sidebar out of the active-work line of
         sight. -->
    <section class="ed-panel" id="canvas-panel">
      <header class="ed-panel-head">
        <h3>Canvas</h3>
        <button type="button" id="clear-lines-btn" class="ed-mini ed-danger">Clear</button>
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
        <h3>Typography</h3>
        <span class="ed-typo-head-btns">
          <button type="button" id="new-typo-btn" class="ed-mini" title="Add a typography token">+ Token</button>
          <button type="button" id="save-typography-btn" class="ed-mini" title="Write typography-tokens.json">Save</button>
        </span>
      </header>
      <ul id="typography-list" class="ed-typo-list"></ul>
      <button type="button" id="view-typo-btn" class="ed-mini ed-typo-view-btn"
              title="Preview every token as real paragraphs">View all in panel</button>
    </section>

  </aside>

  <div class="ed-mode-banner" id="set-origin-banner" hidden>
    Click anywhere on the canvas to set the rotation pivot · <kbd>Esc</kbd> to cancel
  </div>

  <div class="ed-mode-banner ed-wizard-banner" id="wizard-banner" hidden>
    <span id="wizard-banner-label">Drafting new object</span>
    <button type="button" id="wizard-save-btn"   class="ed-mini ed-primary">Save object</button>
    <button type="button" id="wizard-cancel-btn" class="ed-mini ed-danger">Cancel</button>
  </div>

<?php
  $dims = $initialDims;
  $vb   = deco_viewbox($dims);
?>
  <main class="ed-canvas-wrap">
    <!-- Canvas geometry is driven by the current class's dims (from
         page.json's dims[<classId>]). The page area is the central
         pageW×pageH zone at (0, 0); the viewBox extends symmetrically
         around it to canvasW×canvasH so lines that drift on/off the
         page have room to live. 1px = 1 viewBox unit at zoom 1.0. -->
    <svg id="draw-surface"
         viewBox="<?= deco_viewbox_attr($dims) ?>"
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

<!-- v0.8.110: floating-panel host. Fixed full-viewport overlay that
     never intercepts pointer events itself; individual floating
     panels (added by PanelManager in dev-draw.js) opt back in via
     their own pointer-events:auto. Lives outside .ed-body so panels
     can float over the entire editor (toolbar included if dragged
     up) without fighting the sidebar/canvas grid. -->
<div id="panel-host" class="ed-panel-host" aria-hidden="false"></div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<script src="<?= url('assets/js/dev-draw.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
</body>
</html>
