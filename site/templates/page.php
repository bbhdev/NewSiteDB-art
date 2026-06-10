<?php
/**
 * /dev/page editor template — Phase 2 Slice 1.
 *
 * Authoring surface for the absolute-coord rect-block layout that
 * defines a target Kirby page's structure. Mirrors /dev/draw's shape:
 * URL-driven target page (?page=<slug>), full editor state embedded
 * as JSON in #editor-data, vanilla-JS editor (assets/js/dev-page.js)
 * reads it on load.
 *
 * Canvas dimensions are NOT redefined here — Phase 2 positions rects
 * inside the SAME frame the Deco runtime uses. We read the target
 * page's Deco config (deco_load_page_config) and pick the widest
 * class in useClasses as the Slice-1 "primary class". `pageW × pageH`
 * from that class drives the editor canvas size. When the page has no
 * page.json yet, deco_default_dims() supplies sensible defaults.
 *
 * Slice 1 step 1 scope: empty-state load only. Toolbar + sidepanel
 * scaffolding are present; the editor verbs (add/move/resize/save)
 * arrive in subsequent steps.
 */

$requestedPage = kirby()->request()->get('page');
$targetSlug    = (is_string($requestedPage) && $requestedPage !== '')
    ? $requestedPage
    : $page->targetPage()->or('home')->value();
$targetPage    = kirby()->page($targetSlug);

// Fall back to home if the requested page is missing.
if (!$targetPage) {
    $targetSlug = 'home';
    $targetPage = kirby()->page('home');
}

$contentRoot = kirby()->root('content');
$classes     = deco_load_classes($contentRoot);
$classIds    = array_map(function ($c) { return $c['id']; }, $classes);

// Build the page-picker options. Same filtering as draw.php: skip
// the /dev editor tree, the error page, and any subpage that's
// really a Deco class folder.
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

// Pick the primary class for Slice 1 = the widest entry in
// useClasses. "Widest" = the class whose dims[pageW] is largest.
// Per-page override of which class is primary is deferred to
// Slice 7+; for now this rule is deterministic and visible to the
// author via the toolbar label.
$pageCfg = $targetPage
    ? deco_load_page_config($targetPage->root())
    : ['useClasses' => ['wide'], 'dims' => ['wide' => deco_default_dims()]];

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

// Load this target page's rects.json. Empty state if absent — the
// editor will paint an empty canvas and let the user start adding
// rects. (Add verbs arrive in step 2; for step 1 the empty state
// is the only state the editor knows.)
$rectsPath = $targetPage ? $targetPage->root() . '/rects.json' : null;
$rectsData = ($rectsPath && is_file($rectsPath))
    ? (json_decode(file_get_contents($rectsPath), true) ?: [])
    : [];
$schemaVersion = isset($rectsData['schemaVersion']) ? (int) $rectsData['schemaVersion'] : 2;
$chapters      = (isset($rectsData['chapters']) && is_array($rectsData['chapters']))
    ? $rectsData['chapters'] : [];
$rects         = (isset($rectsData['rects']) && is_array($rectsData['rects']))
    ? $rectsData['rects'] : [];

// Read-time rect-schema migration (the Phase-2 third version axis,
// distinct from CONTENT_SCHEMA_VERSION and the SCHEMA_VERSION
// envelope). Normalises older on-disk shapes to the current one so
// the editor + JS only ever see current-shape rects; the file on
// disk stays at its stored version until the next save flushes it.
//   v1 → v2 (v0.10.24): optional `note` (editor-only author label,
//                       never rendered at runtime).
//   v2 → v3 (v0.10.46): optional `image` (bound image filename,
//                       resolved against the page's images/ child;
//                       runtime <img> render lands in step 5).
// Both default missing → null. Forward-compat: current-shape rects
// pass through unchanged.
$rects = array_map(function ($r) {
    if (!is_array($r)) return $r;
    if (!array_key_exists('note',  $r)) $r['note']  = null;
    if (!array_key_exists('image', $r)) $r['image'] = null;
    // v0.10.47: `fit` is additive within schema v3 (behaviour-preserving
    // default 'cover'), so it does NOT advance the schema version — it
    // is normalised here the same way the save route does. Any absent or
    // unexpected value collapses to 'cover' = the pre-4c render.
    $r['fit'] = (isset($r['fit']) && $r['fit'] === 'contain') ? 'contain' : 'cover';
    // v0.10.50: `focusX`/`focusY` (0–100, default 50) drive the bound
    // image's object-position. Additive within schema v3 — 50/50 == the
    // pre-4d centred crop. Clamp to an int in [0,100] exactly as the save
    // route does; missing/garbage collapses to 50 (centred).
    foreach (['focusX', 'focusY'] as $fk) {
        $fv = $r[$fk] ?? 50;
        $fv = is_numeric($fv) ? (int) round((float) $fv) : 50;
        $r[$fk] = max(0, min(100, $fv));
    }
    // v0.10.75 (Slice 3a): `typographyId` — the typography token a text
    // rect renders with (null = inherit defaults). Additive within
    // schema v3 with a null default, so NOT a schema bump: a v3 file
    // without it behaves exactly as before. Only meaningful on text
    // rects; carried (null) on all kinds for grep-ability.
    if (!array_key_exists('typographyId', $r)) $r['typographyId'] = null;
    // v0.10.91 (Slice TS1): `marks` — atomic text-style ranges over the
    // rect's `text` (see the dev/page/save validator for the shape).
    // Additive within schema v3 with a [] default, so NOT a schema bump:
    // a v3 file predating marks reaches JS with marks:[] and the mark
    // engine renders a single unstyled run, identical to pre-TS1.
    if (!array_key_exists('marks', $r) || !is_array($r['marks'])) $r['marks'] = [];
    return $r;
}, $rects);
// Editor always emits the current schema version on save. Declaring 3
// to JS means a save of a previously-v1/v2 file writes back as v3
// transparently.
$schemaVersion = 3;

$v = option('version', 'dev');

// Palette integration (v0.10.17): the project palette is Deco's
// existing shared artifact at content/_shared/palette.json (loaded via
// deco_load_palette). Phase 2 consumes it rather than re-authoring.
// Today the palette carries 'text' + 'accent' tokens — both are wired
// to editor chrome: 'accent' drives the selection highlight, 'text'
// drives rect-stub typography. Kind-background colours don't have
// dedicated palette tokens yet; they're still defaults baked here as
// CSS custom properties so a future palette schema with a kindColors
// field replaces them in one file.
$palette       = deco_load_palette($contentRoot);
$paletteByID   = [];
foreach ($palette as $p) {
    if (is_array($p) && isset($p['id'])) $paletteByID[$p['id']] = $p['value'] ?? '';
}
// Validate values before emitting inside <style>: hex, var(), rgb*,
// hsl*, or a CSS named colour. Falls back to the project's :root
// tokens (defined in style.css) if anything looks unsafe.
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

// Typography tokens (Slice 3a) — the same shared artefact the runtime
// template reads, so a text rect's typographyId renders identically in
// editor and on the public page. Emitted both as .ty-<id> CSS rules
// (below, inside <style>) AND as data in the payload so the selection
// panel can build its "Type" dropdown + live preview.
$typography = deco_load_typography($contentRoot);

$payload = json_encode([
    'pageId'        => $targetSlug,
    'pages'         => $pageOptions,
    'canvas'        => [
        'pageW'   => $primaryDims['pageW'],
        'pageH'   => $primaryDims['pageH'],
        'classId' => $primaryClassId,
    ],
    'schemaVersion' => $schemaVersion,
    'chapters'      => $chapters,
    'rects'         => $rects,
    'typography'    => $typography,
    'palette'       => $palette,
    'version'       => $v,
], JSON_UNESCAPED_SLASHES);
// v0.10.82: harden the inline JSON against </script> breakout. This blob
// is embedded verbatim inside <script id="editor-data" type="application/
// json">…</script>; with JSON_UNESCAPED_SLASHES a string field containing
// the literal "</script>" (now realistic since text rects carry free-form
// body copy — Slice T1) would close the script element early and corrupt
// every following field. Escaping "<" to its \\u003c JSON escape prevents
// any "</script>", "<!--", or "<script" breakout while remaining valid
// JSON — JSON.parse decodes \\u003c straight back to "<". (The runtime
// template is unaffected: it renders text via esc(), not a JSON blob.)
$payload = str_replace('<', '\\u003c', $payload);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page editor — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/style.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/material-icons.css') ?>?v=<?= $v ?>">
  <!-- 6b-2a: dev-page.css merged into dev-editor.css. NB: this template
       is dead — /dev/page redirects to /dev/editor (Slice 1c) — kept only
       to avoid a dangling stylesheet ref; remove with the template. -->
  <link rel="stylesheet" href="<?= url('assets/css/dev-editor.css') ?>?v=<?= $v ?>">
  <?= deco_google_fonts_link($contentRoot) ?>
  <style>
    /* Typography tokens (Slice 3a) — one .ty-<id> rule per token, the
       SAME emitter the runtime template uses, so a text rect's chosen
       token previews here exactly as it renders on the public page. */
<?= deco_typography_css($typography, $palette) ?>
    /* TS3-a: one .mk-color-<id> rule per palette colour, the SAME
       emitter the runtime uses, so a colour mark previews here exactly
       as it renders on the public page (WYSIWYG colour parity). */
<?= deco_palette_marks_css($palette) ?>
    /* Palette-driven custom properties — emitted at template time so
       the editor's accent/text track the project palette without a
       JS round-trip. Kind-background defaults stay here too so a
       future palette schema with kindColors replaces all four in one
       file. See HANDOFF "integrate, don't drift" principle. */
    :root {
      --pe-palette-accent: <?= $paletteAccent ?>;
      --pe-palette-text:   <?= $paletteText ?>;
      --pe-kind-text:       #cfe4ff;
      --pe-kind-image:      #ffe7b8;
      --pe-kind-drilldown:  #e6d4ff;
    }
  </style>
</head>
<body class="page-editor">

<header class="pe-toolbar">
  <div class="pe-brand">
    <a class="pe-back" href="<?= esc(kirby()->url() . '/' . kirby()->option('panel.slug', 'panel')) ?>" title="Back to the Kirby Panel">‹ Panel</a>
    <span class="pe-brand-mark">Page</span>
    <label class="pe-page-picker" title="Switch target page (reloads the editor)">
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
    <span class="pe-class-label" title="Slice 1 single-breakpoint: the widest class in this page's useClasses drives the canvas size. Per-class authoring arrives in Slice 8.">
      class: <strong><?= esc($primaryClassId) ?></strong>
      <span class="pe-dims">(<?= (int)$primaryDims['pageW'] ?>×<?= (int)$primaryDims['pageH'] ?>)</span>
    </span>
  </div>

  <div class="pe-tools" role="toolbar" aria-label="Create">
    <!-- Step 2: kind picker as a <select>. Choosing a kind adds a new
         rect of that kind at the canvas top-left and resets the
         picker back to the placeholder. Step 4 adds delete + chapter
         binding; step 3 adds save. -->
    <label class="pe-add-rect">
      <select id="add-rect-select" class="pe-create-btn">
        <option value="" disabled selected>+ Add rect</option>
        <option value="text">+ Text</option>
        <option value="image">+ Image</option>
        <option value="drilldown">+ Drilldown</option>
      </select>
    </label>
    <!-- Step 4c-ii: image-first flow. Opens the image picker directly;
         choosing a file creates a new image rect already bound and
         sized to that image's aspect ratio. -->
    <button type="button" id="place-image-btn" class="pe-create-btn"
            title="Pick an image first — creates a rect already bound and sized to it">
      + Place image…
    </button>
  </div>

  <div class="pe-view" role="toolbar" aria-label="Save and status">
    <!-- Step 3: Save POSTs to dev/page/save. Button is disabled until
         there are unsaved changes (JS toggles it). -->
    <button type="button" id="save-btn" class="pe-save" disabled
            title="Save the current layout to rects.json">Save</button>
    <span id="save-status" class="pe-status" aria-live="polite"></span>
  </div>

  <div class="pe-spacer"></div>
  <span class="pe-version">v<?= esc($v) ?></span>
</header>

<div class="pe-body">
  <aside class="pe-sidebar">
    <!-- Step 4: chapter list + selected-rect properties are populated
         by JS. Container DOM is stable; rows are wiped/repainted on
         every render(). Chapter add form sits below the list. -->
    <section class="pe-panel">
      <header class="pe-panel-head"><h3>Chapters</h3></header>
      <ul id="chapters-list" class="pe-chapters"></ul>
      <form id="chapter-add-form" class="pe-chapter-add" autocomplete="off">
        <input type="text" id="chapter-add-input" class="pe-input"
               placeholder="New chapter name" maxlength="64">
        <button type="submit" class="pe-create-btn">+</button>
      </form>
    </section>

    <section class="pe-panel" id="selection-panel">
      <header class="pe-panel-head"><h3>Selection</h3></header>
      <div id="selection-body"></div>
    </section>

    <!-- OBJECTS — a navigation/help section (last, not a first-class
         control). Lists every rect so an object fully hidden behind
         another stays reachable (click a row to select it, then the
         move grip / handles let you act on it). Two display modes
         chosen by the flush-right T (by type) / Z (by layer) buttons.
         "Name" = the rect's NOTE field, falling back to its id. -->
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
    <!-- The column hugs the surface (width:max-content) and is centred
         in the scroll wrap, so the dims caption above it aligns flush
         with the surface's top-left edge regardless of pageW. -->
    <div class="pe-canvas-col">
      <!-- Page-area + canvas dimensions, drawn above the page rect
           top-left (v0.10.63). Same frame the Deco runtime uses:
           page area = visible page rect; canvas = the larger Deco
           drawing frame it sits inside. Static — only changes on
           reload (different page / class). -->
      <div class="pe-canvas-dims">Page area: <?= (int)$primaryDims['pageW'] ?>, <?= (int)$primaryDims['pageH'] ?> — Canvas: <?= (int)$primaryDims['canvasW'] ?>, <?= (int)$primaryDims['canvasH'] ?></div>
      <!-- Canvas surface sized to the primary class's pageW × pageH.
           Step 1: empty surface, nothing rendered inside. Step 2+
           renders rects here as position:absolute children. -->
      <div id="page-editor-surface"
           class="pe-canvas-surface"
           style="width: <?= (int)$primaryDims['pageW'] ?>px; min-height: <?= (int)$primaryDims['pageH'] ?>px;">
        <!-- rects render here -->
      </div>
    </div>
  </main>
</div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<script src="<?= url('assets/js/dev-page.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
<?php snippet('sync-peer-indicator') ?>
</body>
</html>
