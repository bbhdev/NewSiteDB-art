<?php
/**
 * /dev/editor template — unified editor surface.
 *
 * Slice 1a (v0.10.157): skeleton route. Body = verbatim copy of
 *   /dev/draw.
 * Slice 1b (v0.10.158): mode toggle + page-editor merged in as a
 *   second mode.
 *
 * What 1b does:
 *  - One toolbar. Mode toggle [Lines | Layout] sits next to the
 *    brand. Toolbar groups are flagged either `ed-lines-only` or
 *    `ed-layout-only`; a body class (`ed-mode-lines` / `ed-mode-
 *    layout`) drives which group is visible.
 *  - Shared #save-btn, #save-status, #page-select live in the
 *    toolbar (single DOM nodes). Both dev-draw.js and dev-page.js
 *    bind to them via addEventListener; one click fires BOTH saves.
 *  - Two body panes (.ed-mode-pane--lines and .ed-mode-pane--
 *    layout). Mode toggle CSS-hides the inactive pane.
 *  - Payload is the union of both editors' input keys. Common
 *    keys (pageId, pages, palette, typography, version) coincide
 *    by design; new keys from page-editor (canvas, schemaVersion,
 *    chapters, rects) added alongside.
 *  - Both dev-draw.css and dev-page.css load. Both editor classes
 *    on <body> so each stylesheet's body-scoped rules apply.
 *
 * Deferred to later slices:
 *  - 1c: redirect /dev/draw and /dev/page here with ?mode= preselected.
 *  - 2:  drop deco-mount rect kind.
 *  - 6:  fold dev-page.js into dev-draw.js (renamed dev-editor.js).
 *  - True canvas overlay (rects + lines in one frame). Today the
 *    two canvases (#draw-surface, #page-editor-surface) stay
 *    separate, swapped by the mode toggle.
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

// ─────────────────────────────────────────────────────────────
// Shared inputs (used by both Lines and Layout modes).
// ─────────────────────────────────────────────────────────────
$contentRoot = kirby()->root('content');
$classes     = deco_load_classes($contentRoot);
$classIds    = array_map(function ($c) { return $c['id']; }, $classes);

// Build the page-picker options. Skip the /dev tree (the editor
// itself), the error page, and any "subpage" that's really a
// class folder our migration created inside each page (Kirby
// treats every folder as a page).
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

$pageCfg     = $targetPage ? deco_load_page_config($targetPage->root())
                          : ['useClasses' => ['wide'], 'dims' => ['wide' => deco_default_dims()]];
$masters     = deco_load_masters($contentRoot);

$palette   = deco_load_palette($contentRoot);
// Default palette if the file doesn't exist yet.
if (empty($palette)) {
  $palette = [
    ['id' => 'text',   'name' => 'Text',   'value' => 'var(--text)'],
    ['id' => 'accent', 'name' => 'Accent', 'value' => 'var(--accent)']
  ];
}

$typography = deco_load_typography($contentRoot);

$v = option('version', 'dev');

// ─────────────────────────────────────────────────────────────
// Lines-mode (draw) inputs.
// ─────────────────────────────────────────────────────────────

// Per-class instances + groups (v4 shape).
$byClass = [];
foreach ($pageCfg['useClasses'] as $cid) {
    $byClass[$cid] = $targetPage
        ? deco_load_class_data($targetPage->root(), $cid)
        : ['instances' => [], 'groups' => []];
}

// Default initial class for first paint.
$initialClassId = in_array('wide', $pageCfg['useClasses'], true)
    ? 'wide'
    : ($pageCfg['useClasses'][0] ?? 'wide');
$initialDims    = $pageCfg['dims'][$initialClassId] ?? deco_default_dims();

// Trigger-field suggestions (selectors that exist in the target template).
$triggerSuggestions = [];
$templatePath = kirby()->root('templates') . '/' . $targetSlug . '.php';
if (file_exists($templatePath)) {
  preg_match_all('/\bid\s*=\s*["\']([^"\']+)["\']/i', file_get_contents($templatePath), $m);
  foreach ($m[1] as $id) $triggerSuggestions[] = '#' . $id;
  $triggerSuggestions = array_values(array_unique($triggerSuggestions));
}

// Image source suggestions for the "Image URL" panel field.
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

// ─────────────────────────────────────────────────────────────
// Layout-mode (page) inputs.
// ─────────────────────────────────────────────────────────────

// Pick the primary class for Slice-1 page-editor = widest in useClasses.
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

// Load rects.json + chapter list + read-time rect-schema migration.
$rectsPath = $targetPage ? $targetPage->root() . '/rects.json' : null;
$rectsData = ($rectsPath && is_file($rectsPath))
    ? (json_decode(file_get_contents($rectsPath), true) ?: [])
    : [];
$rectsSchemaVersion = isset($rectsData['schemaVersion']) ? (int) $rectsData['schemaVersion'] : 2;
$chapters           = (isset($rectsData['chapters']) && is_array($rectsData['chapters']))
    ? $rectsData['chapters'] : [];
$rects              = (isset($rectsData['rects']) && is_array($rectsData['rects']))
    ? $rectsData['rects'] : [];

$rects = array_map(function ($r) {
    if (!is_array($r)) return $r;
    if (!array_key_exists('note',  $r)) $r['note']  = null;
    if (!array_key_exists('image', $r)) $r['image'] = null;
    $r['fit'] = (isset($r['fit']) && $r['fit'] === 'contain') ? 'contain' : 'cover';
    foreach (['focusX', 'focusY'] as $fk) {
        $fv = $r[$fk] ?? 50;
        $fv = is_numeric($fv) ? (int) round((float) $fv) : 50;
        $r[$fk] = max(0, min(100, $fv));
    }
    if (!array_key_exists('typographyId', $r)) $r['typographyId'] = null;
    if (!array_key_exists('marks', $r) || !is_array($r['marks'])) $r['marks'] = [];
    return $r;
}, $rects);
$rectsSchemaVersion = 3;

// Palette validation for inline :root vars (used by dev-page.css).
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
$paletteAccent = $paletteSafe($paletteByID['accent'] ?? null, 'var(--accent)');
$paletteText   = $paletteSafe($paletteByID['text']   ?? null, 'var(--text)');

// ─────────────────────────────────────────────────────────────
// Merged payload — union of both editors' input keys.
// ─────────────────────────────────────────────────────────────

$payload = json_encode([
  // Shared.
  'pageId'             => $targetSlug,
  'pages'              => $pageOptions,
  'palette'            => $palette,
  'typography'         => $typography,
  'version'            => $v,
  // Lines mode (draw).
  'classId'            => $initialClassId,
  'classes'            => $classes,
  'masters'            => $masters,
  'byClass'            => $byClass,
  'page'               => $pageCfg,
  'triggerSuggestions' => $triggerSuggestions,
  'imageSources'       => $imageSources,
  // Layout mode (page).
  'canvas'             => [
    'pageW'   => $primaryDims['pageW'],
    'pageH'   => $primaryDims['pageH'],
    'classId' => $primaryClassId,
  ],
  'schemaVersion'      => $rectsSchemaVersion,
  'chapters'           => $chapters,
  'rects'              => $rects,
], JSON_UNESCAPED_SLASHES);
// Harden the inline JSON against </script> breakout (same as page.php).
$payload = str_replace('<', '\\u003c', $payload);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Editor — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/style.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/dev-draw.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/material-icons.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/dev-page.css') ?>?v=<?= $v ?>">
  <?= deco_google_fonts_link($contentRoot) ?>
  <style id="ed-typography-css"><?= deco_typography_css($typography, $palette) ?></style>
  <style id="ed-page-marks-css">
<?= deco_palette_marks_css($palette) ?>
    :root {
      --pe-palette-accent: <?= $paletteAccent ?>;
      --pe-palette-text:   <?= $paletteText ?>;
      --pe-kind-text:       #cfe4ff;
      --pe-kind-image:      #ffe7b8;
      --pe-kind-drilldown:  #e6d4ff;
      --pe-kind-deco-mount: #d4f1d6;
    }
  </style>
  <style id="ed-mode-css">
    /* Slice 1b mode-toggle rules. Inline here for now; will migrate to
       dev-draw.css (renamed dev-editor.css) in Slice 6. */

    /* Mode-pane = transparent flex pass-through. Both .ed-body (flex:1)
       and .pe-body (flex:1 1 auto) were authored as DIRECT flex children
       of body.editor / body.page-editor (display:flex; flex-direction:
       column; 100vh). Wrapping each in a .ed-mode-pane broke that chain:
       the wrapper defaulted to display:block / flex:0 1 auto, collapsed
       to content height, and the inner body's flex:1 no longer resolved
       — so .ed-canvas-wrap got ~zero height and the canvas couldn't be
       panned. Restoring flex:1 + min-height:0 + flex-column on the pane
       re-establishes the chain so the inner body fills the viewport
       exactly as before. (Inactive pane is display:none !important via
       the rules below, which override this display:flex.) */
    .ed-mode-pane {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .ed-mode-toggle {
      display: inline-flex; gap: 2px; margin: 0 8px;
      border: 1px solid currentColor; border-radius: 4px; opacity: .85;
    }
    .ed-mode-btn {
      background: transparent; color: inherit; border: 0;
      padding: 4px 10px; font: inherit; cursor: pointer;
      min-width: 60px; min-height: 32px; /* touch target */
    }
    .ed-mode-btn.is-active { background: currentColor; }
    .ed-mode-btn.is-active > span { color: var(--bg, #111); mix-blend-mode: difference; }
    /* Toolbar groups visible per mode. */
    body.ed-mode-layout .ed-lines-only { display: none !important; }
    body.ed-mode-lines  .ed-layout-only { display: none !important; }
    /* Body panes. */
    body.ed-mode-lines  .ed-mode-pane--layout { display: none !important; }
    body.ed-mode-layout .ed-mode-pane--lines  { display: none !important; }
  </style>
</head>
<body class="editor page-editor ed-mode-lines">

<header class="ed-toolbar">
  <div class="ed-brand">
    <a class="ed-back" href="<?= esc(kirby()->url() . '/' . kirby()->option('panel.slug', 'panel')) ?>" title="Back to the Kirby Panel">‹ Panel</a>
    <span class="ed-brand-mark">Editor</span>
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
    <div class="ed-mode-toggle" role="tablist" aria-label="Editor mode">
      <button type="button" class="ed-mode-btn is-active" data-mode="lines"   role="tab" aria-selected="true"><span>Lines</span></button>
      <button type="button" class="ed-mode-btn"           data-mode="layout"  role="tab" aria-selected="false"><span>Layout</span></button>
    </div>
    <div class="ed-class-tabs ed-lines-only" role="tablist" aria-label="Screen class">
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

  <div class="ed-tools ed-lines-only" role="toolbar" aria-label="Selection">
    <button type="button" class="ed-tool" data-tool="select" title="Select (S) — no drawing; click to select, drag to move">↖ Select</button>
    <button type="button" class="ed-tool" id="select-all-btn" title="Select every object on this page — drag any one to move them all together. Cmd/Shift-click objects to build a custom multi-selection.">Select all</button>
  </div>

  <div class="ed-tools ed-lines-only" role="toolbar" aria-label="Create">
    <button type="button" id="create-object-btn" class="ed-create-btn"
            title="Create a new object — opens a panel to pick the shape type or import an SVG file, and choose which classes it should appear in">+ Create object</button>
    <input type="file" id="import-svg-input" accept=".svg,image/svg+xml" multiple hidden>
    <button type="button" id="library-btn" class="ed-create-btn"
            title="Project hub: Master library, Overview, Orphans, Snapshots.">▦ Project</button>
  </div>

  <div class="ed-tools ed-layout-only" role="toolbar" aria-label="Layout create">
    <label class="pe-add-rect">
      <select id="add-rect-select" class="pe-create-btn">
        <option value="" disabled selected>+ Add rect</option>
        <option value="text">+ Text</option>
        <option value="image">+ Image</option>
        <option value="drilldown">+ Drilldown</option>
        <option value="deco-mount">+ Deco mount</option>
      </select>
    </label>
    <button type="button" id="place-image-btn" class="pe-create-btn"
            title="Pick an image first — creates a rect already bound and sized to it">+ Place image…</button>
  </div>

  <div class="ed-tool-settings ed-lines-only" id="tool-settings"></div>

  <div class="ed-view" role="toolbar" aria-label="Save and settings">
    <button type="button" id="save-btn"     class="ed-save">Save</button>
    <button type="button" id="settings-btn" class="ed-icon-btn ed-settings ed-lines-only" title="Settings — editor preferences and diagnostic toggles" aria-label="Settings"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>
    <button type="button" id="help-btn" class="ed-icon-btn ed-help ed-lines-only" title="Editor tips — tools, selection, gestures, shortcuts" aria-label="Help"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg></button>
    <span id="save-status" class="ed-status" aria-live="polite"></span>
  </div>

  <span class="ed-version">v<?= esc($v) ?></span>
</header>

<!-- ─────────── LINES MODE PANE ─────────── -->
<div class="ed-mode-pane ed-mode-pane--lines">
<div class="ed-body">
  <aside class="ed-sidebar">
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

    <section class="ed-panel" id="element-styles-section">
      <header class="ed-panel-head">
        <h3>Element styles</h3>
        <span class="ed-typo-head-btns">
          <button type="button" id="new-typo-btn" class="ed-mini" title="Add an element style">+ Style</button>
          <button type="button" id="save-typography-btn" class="ed-mini" title="Write typography-tokens.json">Save styles</button>
        </span>
      </header>
      <ul id="typography-list" class="ed-typo-list"></ul>
      <button type="button" id="view-typo-btn" class="ed-mini ed-typo-view-btn"
              title="Preview every style as real paragraphs">View all in panel</button>
    </section>

    <div class="ed-typo-save-bar" id="typo-save-bar" hidden>
      <button type="button" id="typo-save-bar-btn" class="ed-mini">Save styles</button>
    </div>

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
</div>
<!-- ─────────── END LINES MODE PANE ─────────── -->

<!-- ─────────── LAYOUT MODE PANE ─────────── -->
<div class="ed-mode-pane ed-mode-pane--layout">
<div class="pe-body">
  <aside class="pe-sidebar">
    <section class="pe-panel">
      <header class="pe-panel-head"><h3>Chapters</h3></header>
      <ul id="chapters-list" class="pe-chapters"></ul>
      <form id="chapter-add-form" class="pe-chapter-add" autocomplete="off">
        <input type="text" id="chapter-add-input" class="pe-input"
               placeholder="New chapter name" maxlength="64">
        <button type="submit" class="pe-create-btn">+</button>
      </form>
    </section>

    <!-- Slice 1b: id="selection-panel" renamed to "pe-selection-panel" so
         the HTML doesn't have two elements with the same id (draw's
         selection-panel is the one dev-draw.js queries; dev-page.js
         queries "selection-body" inside this panel, so the panel's own
         id can change freely). -->
    <section class="pe-panel" id="pe-selection-panel">
      <header class="pe-panel-head"><h3>Selection</h3></header>
      <div id="selection-body"></div>
    </section>

    <section class="pe-panel" id="objects-panel">
      <header class="pe-panel-head pe-objects-head">
        <h3>Objects</h3>
        <div class="pe-objects-sort" role="group" aria-label="Sort objects">
          <button type="button" id="objects-sort-type" class="pe-sort-btn"
                  title="Group by type">T</button>
          <button type="button" id="objects-sort-z" class="pe-sort-btn"
                  title="Sort by layer (Z)">Z</button>
        </div>
      </header>
      <div id="objects-body"></div>
    </section>
  </aside>

  <main class="pe-canvas-wrap">
    <div class="pe-canvas-col">
      <div class="pe-canvas-dims">Page area: <?= (int)$primaryDims['pageW'] ?>, <?= (int)$primaryDims['pageH'] ?> — Canvas: <?= (int)$primaryDims['canvasW'] ?>, <?= (int)$primaryDims['canvasH'] ?></div>
      <div id="page-editor-surface"
           class="pe-canvas-surface"
           style="width: <?= (int)$primaryDims['pageW'] ?>px; min-height: <?= (int)$primaryDims['pageH'] ?>px;">
        <!-- rects render here -->
      </div>
    </div>
  </main>
</div>
</div>
<!-- ─────────── END LAYOUT MODE PANE ─────────── -->

<!-- v0.8.110: floating-panel host (Lines mode). Fixed full-viewport overlay
     that never intercepts pointer events itself; individual floating
     panels (added by PanelManager in dev-draw.js) opt back in via
     their own pointer-events:auto. -->
<div id="panel-host" class="ed-panel-host" aria-hidden="false"></div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<script src="<?= url('assets/js/dev-draw.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/dev-page.js') ?>?v=<?= $v ?>"></script>
<script id="ed-mode-toggle-js">
  // Slice 1b mode toggle. Inline here for now; will move to dev-editor.js
  // in Slice 6. Persists last mode in localStorage so reloads stay put.
  (function () {
    var KEY = 'dev-editor:mode';
    var initial = (function () {
      var q = new URLSearchParams(location.search).get('mode');
      if (q === 'lines' || q === 'layout') return q;
      var s = null;
      try { s = localStorage.getItem(KEY); } catch (e) {}
      return (s === 'layout') ? 'layout' : 'lines';
    })();
    function apply(mode) {
      document.body.classList.toggle('ed-mode-lines',  mode === 'lines');
      document.body.classList.toggle('ed-mode-layout', mode === 'layout');
      var btns = document.querySelectorAll('.ed-mode-btn');
      for (var i = 0; i < btns.length; i++) {
        var on = btns[i].getAttribute('data-mode') === mode;
        btns[i].classList.toggle('is-active', on);
        btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
      }
      try { localStorage.setItem(KEY, mode); } catch (e) {}
    }
    apply(initial);
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest && ev.target.closest('.ed-mode-btn');
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      if (mode === 'lines' || mode === 'layout') apply(mode);
    });
  })();
</script>
<!-- v<?= $v ?> -->
<?php snippet('sync-peer-indicator') ?>
</body>
</html>
