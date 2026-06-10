<?php
/**
 * /dev/editor template — unified editor surface.
 *
 * Slice 1a (v0.10.157): skeleton route. Body = verbatim copy of
 *   /dev/draw.
 * Slice 1b (v0.10.158): mode toggle + page-editor merged in as a
 *   second mode.
 * Slice 2  (v0.10.161): deco-mount rect kind retired.
 * Slice 3a (v0.10.162): third mode "Styles". The palette + element-
 *   styles editors (global, page-independent design tokens) move out of
 *   the Lines sidebar into a dedicated .ed-mode-pane--styles. Mode
 *   visibility CSS generalised to a :not(.ed-mode-X) form so it scales
 *   past two modes.
 * Slice 3a redesign (v0.10.164): the typography UI is split into three
 *   distinct affordances. (a) LIST stays in the side panel (name · ★ default
 *   · × delete). (b) DISPLAY fills the canvas — one outlined card per style in
 *   list order, header = name · ty-<id> · font-family name (plain text, NOT
 *   rendered in that font) · ↑↓ reorder · Edit; below, the demo text rendered
 *   in the style. (c) EDIT opens a standalone floating panel with every
 *   property. Palette has NO canvas display — it stays compact in the side
 *   panel (tablet screen space). The display is rendered by dev-draw.js's
 *   renderElementStyleDisplay() (native access to state + live #ed-typography-
 *   css-live), superseding the v0.10.163 MutationObserver preview. Slice 3b
 *   adds the cross-page usage audit alongside.
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
 *  - One stylesheet, dev-editor.css (6b-2a merge of the former
 *    dev-draw.css + dev-page.css). Both editor classes on <body> so
 *    each section's body-scoped rules apply.
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
    // Convergence Slice 2: 'deco-mount' kind retired (dead affordance —
    // it never had distinct rendering, just a stub colour). Coerce any
    // stray deco-mount rect → 'text' at read time. This is a WITHIN-v3
    // defensive normalisation (same pattern as note/fit/focusX below),
    // NOT a schema bump: kind is a tolerated free string on read, so old
    // data still parses; geometry/position/text survive, only the dead
    // label changes. A coerced rect re-saves cleanly as 'text' (the save
    // validator no longer accepts 'deco-mount'). No snapshot carries it.
    if (($r['kind'] ?? null) === 'deco-mount') $r['kind'] = 'text';
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

// Palette validation for inline :root vars (used by dev-editor.css, Section B).
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
  <!-- Slice 6b-2a: dev-draw.css + dev-page.css merged → dev-editor.css
       (Sections A + B). material-icons.css still loads separately. -->
  <link rel="stylesheet" href="<?= url('assets/css/dev-editor.css') ?>?v=<?= $v ?>">
  <link rel="stylesheet" href="<?= url('assets/css/material-icons.css') ?>?v=<?= $v ?>">
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
    }
  </style>
  <style id="ed-mode-css">
    /* Slice 1b mode-toggle rules. Still inline here; could migrate into
       dev-editor.css later — kept inline for now since they're small and
       co-located with the mode markup. */

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
    /* Toolbar groups: each `ed-<mode>-only` group shows only while body is
       in that mode. The :not() form scales to three modes (lines / layout /
       styles) without an N×N matrix of pairwise hide rules — adding a 4th
       mode later is one more line, not three. */
    body:not(.ed-mode-lines)  .ed-lines-only  { display: none !important; }
    body:not(.ed-mode-layout) .ed-layout-only { display: none !important; }
    body:not(.ed-mode-styles) .ed-styles-only { display: none !important; }
    body:not(.ed-mode-images) .ed-images-only { display: none !important; }
    /* Body panes: same rule shape — exactly one pane visible per mode. */
    body:not(.ed-mode-lines)  .ed-mode-pane--lines  { display: none !important; }
    body:not(.ed-mode-layout) .ed-mode-pane--layout { display: none !important; }
    body:not(.ed-mode-styles) .ed-mode-pane--styles { display: none !important; }
    body:not(.ed-mode-images) .ed-mode-pane--images { display: none !important; }

    /* Styles-mode surface = the canvas area beside the (compact) list panel.
       It hosts the ELEMENT-STYLE DISPLAY: one outlined card per style, in the
       same order as the side-panel list. Each card's header repeats the name,
       the ty-<id>, the font-family name (as PLAIN TEXT — not rendered in that
       font), reorder arrows and an Edit button; below, the demo text rendered
       in the style (the .ty-<id> class is auto-styled by dev-draw.js's injected
       #ed-typography-css-live). Palette has NO canvas display — it stays compact
       in the side panel (tablet screen space). Rendered by dev-draw.js's
       renderElementStyleDisplay(); Edit opens a standalone floating panel. */
    .ed-styles-surface {
      flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 40px;
    }
    .ed-es-display { display: flex; flex-direction: column; gap: 18px; }
    .ed-es-empty { opacity: .5; font-size: 13px; }
    /* One outlined card per style — reserved space, not floating. */
    .ed-es-card {
      border: 1px solid rgba(127,127,127,.32); border-radius: 10px;
      overflow: hidden; background: rgba(127,127,127,.04);
    }
    /* Unsaved-change marker: a style created or edited since the last save.
       Yellow outline + faint glow so changed cards stand out on the canvas. */
    .ed-es-card.is-modified {
      border-color: #f5c518;
      /* outline-offset gives a 2px gap so the ring reads as a frame around the
         card rather than merging into the white demo background; 3px thick. */
      outline: 3px solid #f5c518;
      outline-offset: 2px;
      box-shadow: 0 0 10px rgba(245,197,24,.3);
    }
    .ed-es-card-head {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      padding: 8px 12px; border-bottom: 1px solid rgba(127,127,127,.22);
      font-size: 12px;
    }
    .ed-es-card-name { font-weight: 600; font-size: 13px; }
    .ed-es-card-default { color: #f5c518; }
    .ed-es-card-id { font-family: ui-monospace, monospace; font-size: 11px; opacity: .6; }
    .ed-es-card-family { font-size: 12px; opacity: .8; font-style: italic; }
    .ed-es-card-spacer { flex: 1; }
    /* Slice 3b usage badge: per-card count of objects referencing this style,
       populated after "Check usage". Neutral by default; orphan (0 uses) goes
       amber to flag it. The default style shows "+N via default" for null refs. */
    .ed-es-card-usage {
      font-size: 11px; padding: 2px 8px; border-radius: 999px;
      background: rgba(127,127,127,.18); color: inherit; white-space: nowrap;
    }
    .ed-es-card-usage.is-orphan { background: rgba(245,197,24,.22); color: #f5c518; }
    /* Demo rendered in the style — on a neutral light card so palette-driven
       text colours read faithfully (as on a page). The .ty-<id> class supplies
       size/weight/family/colour, so the demo shows the real, larger style. */
    .ed-es-card-demo {
      background: #ffffff; color: #111; padding: 18px 16px; word-break: break-word;
    }

    /* Standalone floating Edit panel (user chose standalone, not PanelManager,
       to keep coupling out before the Slice-6 JS consolidation). One open at a
       time; backdrop click / × / Esc closes. */
    .ed-es-panel-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,.45); z-index: 900;
    }
    .ed-es-panel {
      position: fixed; z-index: 901; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: min(420px, 92vw); max-height: 86vh; overflow: auto;
      background: var(--bg, #1a1a1a); color: var(--text, #eee);
      border: 1px solid rgba(127,127,127,.4); border-radius: 12px;
      box-shadow: 0 18px 50px rgba(0,0,0,.5);
    }
    .ed-es-panel-head {
      display: flex; align-items: center; gap: 10px;
      padding: 12px 14px; border-bottom: 1px solid rgba(127,127,127,.25);
      position: sticky; top: 0; background: inherit;
    }
    .ed-es-panel-title { margin: 0; font-size: 14px; flex: 1; }
    .ed-es-panel-close { font-size: 18px; line-height: 1; min-width: 32px; min-height: 32px; }
    .ed-es-panel-body { padding: 14px; display: flex; flex-direction: column; gap: 12px; }
    .ed-es-panel-save { align-self: flex-end; }

    /* Slice 3b usage-report modal — reuses the floating-panel chrome, wider.
       Sections: dangling refs (problems first), then per-style usage list. */
    .ed-es-report { width: min(560px, 94vw); }
    .ed-es-report-summary { font-size: 12px; opacity: .8; margin: 0 0 4px; }
    .ed-es-report-sect { margin: 0; padding: 0; border: 0; }
    .ed-es-report-sect h4 {
      margin: 14px 0 6px; font-size: 12px; text-transform: uppercase;
      letter-spacing: .04em; opacity: .7;
    }
    .ed-es-report-row {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      padding: 6px 0; border-top: 1px solid rgba(127,127,127,.18);
    }
    .ed-es-report-name { font-weight: 600; }
    .ed-es-report-id { font-family: ui-monospace, monospace; font-size: 11px; opacity: .55; }
    .ed-es-report-count { margin-left: auto; font-size: 12px; opacity: .85; }
    .ed-es-report-objs {
      flex-basis: 100%; margin: 2px 0 0; padding-left: 14px;
      font-size: 11px; opacity: .7; list-style: disc;
    }
    .ed-es-report-warn { color: #f5c518; }
    .ed-es-report-ok { color: #6ec06e; }
    .ed-es-report-empty { font-size: 12px; opacity: .6; padding: 6px 0; }

    /* ── Images mode (Slice 4) ───────────────────────────────────────────
       Page-scoped image-library grid. Full-width surface (no side panel yet;
       the import sub-panel arrives in 4c via progressive disclosure). */
    .ed-images-surface {
      flex: 1; min-height: 0; overflow: auto; padding: 14px 22px 40px;
      display: flex; flex-direction: column;
    }
    .ed-images-head {
      display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 4px 0 12px; position: sticky; top: 0; z-index: 2;
      background: var(--bg, #111);
    }
    .ed-images-title { margin: 0; font-size: 15px; }
    .ed-images-meta { font-size: 12px; opacity: .65; }
    .ed-images-grid {
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    }
    /* v0.10.194 — empty/hint text was opacity:.55 (≈#949496 on #242528):
       too low contrast, the negative "no use-it" hint was nearly invisible.
       Raise the neutral baseline (still dimmer than headings → hierarchy
       kept) and give meaningful states real colour. */
    .ed-images-empty { opacity: .82; font-size: 13px; padding: 8px 0; }
    .ed-images-empty.is-warn  { opacity: 1; color: #f5c518; font-weight: 600; } /* negative-but-not-error (amber, matches orphan/modified) */
    .ed-images-empty.is-error { opacity: 1; color: #ff8d7a; font-weight: 600; } /* load failure */
    .ed-img-card {
      position: relative;
      border: 1px solid rgba(127,127,127,.3); border-radius: 10px;
      overflow: hidden; background: rgba(127,127,127,.05);
      display: flex; flex-direction: column;
    }
    /* Slice 4f — per-card delete affordance. Hidden until card hover/focus
       so the grid stays calm; always visible on touch (no hover) via the
       coarse-pointer query, since the tablet editor is a first-class target. */
    .ed-img-del {
      position: absolute; top: 6px; right: 6px; z-index: 2;
      width: 30px; height: 30px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; cursor: pointer;
      color: #fff; background: rgba(20,20,24,.62);
      opacity: 0; transition: opacity .12s, background .12s;
    }
    .ed-img-card:hover .ed-img-del,
    .ed-img-card:focus-within .ed-img-del,
    .ed-img-del:focus-visible { opacity: 1; }
    .ed-img-del:hover { background: rgba(200,60,60,.92); }
    @media (hover: none) { .ed-img-del { opacity: 1; background: rgba(20,20,24,.5); } }
    /* 4g-2b — page-library zoom: view full image in the shared lightbox.
       Top-LEFT so it never overlaps the top-right delete affordance. Same
       hover/touch visibility policy as delete (tablet-first). */
    .ed-img-zoom {
      position: absolute; top: 6px; left: 6px; z-index: 2;
      width: 32px; height: 32px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; cursor: zoom-in;
      color: #fff; background: rgba(20,20,24,.62);
      opacity: 0; transition: opacity .12s, background .12s;
    }
    .ed-img-zoom svg { width: 22px; height: 22px; display: block; }
    .ed-img-card:hover .ed-img-zoom,
    .ed-img-card:focus-within .ed-img-zoom,
    .ed-img-zoom:focus-visible { opacity: 1; }
    .ed-img-zoom:hover { background: rgba(40,90,170,.92); }
    @media (hover: none) { .ed-img-zoom { opacity: 1; background: rgba(20,20,24,.5); } }
    .ed-img-thumb {
      width: 100%; aspect-ratio: 4 / 3; object-fit: contain;
      background: #ffffff; display: block;
    }
    /* Flex column + equal-height cards (grid stretches each row) means the
       badge, pushed down with margin-top:auto, sits on a common baseline
       across every card in a row regardless of how many lines the name wraps. */
    .ed-img-info {
      padding: 8px 10px; font-size: 11px; line-height: 1.45;
      flex: 1 1 auto; display: flex; flex-direction: column;
    }
    .ed-img-name {
      font-weight: 600; font-size: 12px; word-break: break-all;
      display: block; margin-bottom: 2px;
    }
    .ed-img-dim { display: block; opacity: .65; }
    /* 4g-3f: the long edge this image will import at (workshop size, or
       "original"). Meaningful info → readable accent, not low-opacity grey. */
    .ed-img-size { display: block; color: #7fd0c8; font-weight: 600; font-size: 11px; margin-top: 1px; }
    .ed-img-size.is-orig { color: #b8babd; font-weight: 500; }
    /* Slice 4b usage badge — count of rects on this page referencing the image.
       Orphan (0 uses) goes amber, matching the Styles audit. */
    .ed-img-usage {
      align-self: flex-start; margin-top: auto; font-size: 10px;
      padding: 3px 7px 1px; border-radius: 999px; background: rgba(127,127,127,.2);
    }
    .ed-img-usage.is-orphan { background: rgba(245,197,24,.22); color: #f5c518; }
    /* Amber frame on an orphan image card (parallels .ed-es-card.is-modified). */
    .ed-img-card.is-orphan { outline: 2px solid rgba(245,197,24,.55); outline-offset: -1px; }

    /* Slice 4c — import-from-workshop sub-panel (progressive disclosure). */
    .ed-import {
      border: 1px solid rgba(127,127,127,.3); border-radius: 10px;
      background: rgba(127,127,127,.06); padding: 10px 12px 14px; margin-bottom: 16px;
    }
    .ed-import-head {
      display: flex; align-items: flex-end; gap: 12px; flex-wrap: wrap; margin-bottom: 10px;
    }
    .ed-import-title { margin: 0 6px 0 0; font-size: 13px; align-self: center; }
    /* 4g-2b — label LEFT of the select (was stacked above). */
    .ed-import-field {
      display: flex; flex-direction: row; align-items: center; gap: 6px;
      font-size: 11px; opacity: .85;
    }
    .ed-import-field-label { white-space: nowrap; }
    /* 4g-2d — custom dark dropdown. Native <select> popups can't be themed
       on macOS/Opera, so the native control is hidden and we render our own
       button + list (guaranteed dark, per the all-dark-UI rule). */
    .ed-dd { position: relative; display: inline-block; }
    .ed-dd-native { display: none; }
    .ed-dd-btn {
      display: inline-flex; align-items: center; gap: 8px;
      font: inherit; font-size: 12px; padding: 3px 8px;
      border: 1px solid rgba(127,127,127,.4); border-radius: 6px;
      background: var(--bg, #111); color: inherit; cursor: pointer;
    }
    .ed-dd-btn:hover { border-color: rgba(127,127,127,.7); }
    .ed-dd-caret { font-size: 9px; opacity: .7; }
    .ed-dd-list {
      position: absolute; top: calc(100% + 4px); left: 0; z-index: 1100;
      margin: 0; padding: 4px; list-style: none; min-width: 100%;
      max-height: 280px; overflow: auto;
      background: #1a1c20; border: 1px solid rgba(127,127,127,.45);
      border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.5);
      white-space: nowrap;
    }
    .ed-dd-list[hidden] { display: none; }
    .ed-dd-opt {
      padding: 5px 10px; border-radius: 5px; font-size: 12px;
      color: #e8e8e8; cursor: pointer;
    }
    .ed-dd-opt:hover { background: rgba(120,170,255,.18); }
    .ed-dd-opt.is-sel { background: rgba(120,170,255,.28); color: #fff; }
    .ed-import-hint { font-size: 11px; opacity: .55; align-self: center; }
    .ed-import-status { font-size: 11px; opacity: .7; }
    .ed-import-grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
    /* Import cards are clickable (send on click); show affordance + sent state. */
    .ed-import .ed-img-card { cursor: pointer; transition: outline-color .12s; }
    .ed-import .ed-img-card:hover { outline: 2px solid rgba(120,170,255,.7); outline-offset: -1px; }
    .ed-import .ed-img-card.is-sent { opacity: .6; }
    .ed-import .ed-img-card.is-busy { pointer-events: none; opacity: .5; }
    /* 4g-2b — per-card zoom: view full image in a lightbox (NOT import).
       Hidden until hover/focus on fine pointers; always shown on touch,
       since the tablet editor is a first-class target. */
    .ed-import-zoom {
      position: absolute; top: 6px; right: 6px; z-index: 2;
      width: 32px; height: 32px; padding: 0;
      display: flex; align-items: center; justify-content: center;
      border: none; border-radius: 8px; cursor: zoom-in;
      color: #fff; background: rgba(20,20,24,.62);
      opacity: 0; transition: opacity .12s, background .12s;
    }
    .ed-import-zoom svg { width: 22px; height: 22px; display: block; }
    .ed-import .ed-img-card:hover .ed-import-zoom,
    .ed-import .ed-img-card:focus-within .ed-import-zoom,
    .ed-import-zoom:focus-visible { opacity: 1; }
    .ed-import-zoom:hover { background: rgba(40,90,170,.92); }
    @media (hover: none) { .ed-import-zoom { opacity: 1; background: rgba(20,20,24,.5); } }

    /* Lightbox overlay (4g-2b). */
    .ed-img-lightbox {
      position: fixed; inset: 0; z-index: 1000;
      display: flex; align-items: center; justify-content: center;
      padding: 40px; cursor: zoom-out;
      background: rgba(10,11,13,.9); backdrop-filter: blur(2px);
    }
    .ed-img-lightbox[hidden] { display: none; }
    .ed-img-lightbox-img {
      max-width: 100%; max-height: 100%; object-fit: contain; cursor: default;
      box-shadow: 0 8px 40px rgba(0,0,0,.6);
    }
    .ed-img-lightbox-close {
      position: absolute; top: 12px; right: 16px;
      width: 40px; height: 40px; display: flex; align-items: center; justify-content: center;
      font-size: 28px; line-height: 1; color: #e8e8e8; cursor: pointer;
      background: rgba(40,42,47,.85); border: 1px solid rgba(127,127,127,.4); border-radius: 50%;
    }
    .ed-img-lightbox-close:hover { background: rgba(60,62,68,.95); color: #fff; }
    .ed-import-badge {
      align-self: flex-start; margin-top: auto; font-size: 10px;
      padding: 3px 7px 1px; border-radius: 999px; background: rgba(127,127,127,.2);
    }
    .ed-import-badge.is-sent  { background: rgba(120,200,120,.22); color: #7ec97e; }
    .ed-import-badge.v-ok     { background: rgba(120,200,120,.18); color: #7ec97e; }
    .ed-import-badge.v-rework { background: rgba(245,197,24,.20);  color: #f5c518; }
    .ed-import-badge.v-dropped{ background: rgba(220,90,90,.20);   color: #e07070; }

    /* Slice 4e — direct upload. Primary "Add image" button + drop zone + the
       resize-confirm modal (reuses the .ed-es-panel chrome). */
    .ed-mini-primary {
      background: rgba(120,170,255,.16); border-color: rgba(120,170,255,.5);
    }
    .ed-images-grid.is-dragover {
      outline: 2px dashed rgba(120,170,255,.8); outline-offset: 6px; border-radius: 8px;
    }
    .ed-upload-preview {
      width: 100%; max-height: 240px; object-fit: contain; background: #fff;
      border-radius: 8px; display: block; margin-bottom: 10px;
    }
    .ed-upload-dims { font-size: 12px; opacity: .7; margin: 0 0 10px; }
    .ed-upload-result {
      font-size: 12px; margin: 0 0 12px; min-height: 1.2em;
      color: rgba(120,200,140,.95);
    }
    .ed-upload-result.is-warn { color: #f5c518; }
    /* Slice 4f — delete-confirm modal. */
    .ed-del-warn { font-size: 13px; color: #f5c518; margin: 0 0 8px; }
    .ed-del-ok   { font-size: 13px; opacity: .8; margin: 0 0 8px; }
    .ed-del-uses {
      margin: 0 0 6px; padding: 8px 10px 8px 26px; font-size: 12px; opacity: .85;
      background: rgba(127,127,127,.12); border-radius: 8px; max-height: 160px; overflow: auto;
    }
    .ed-del-uses li { margin: 2px 0; }
    .ed-del-confirm { border-color: rgba(200,60,60,.6); background: rgba(200,60,60,.18); color: #ff9b9b; }
    .ed-del-confirm:hover { background: rgba(200,60,60,.32); }
    .ed-upload-field {
      display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-bottom: 14px;
    }
    .ed-upload-field input {
      font: inherit; font-size: 13px; padding: 5px 8px; width: 140px;
      border: 1px solid rgba(127,127,127,.4); border-radius: 6px;
      background: var(--bg, #111); color: inherit;
    }
    .ed-upload-field .ed-upload-note { opacity: .55; font-size: 11px; }
    .ed-upload-actions { display: flex; gap: 8px; justify-content: flex-end; }
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
      <button type="button" class="ed-mode-btn"           data-mode="styles"  role="tab" aria-selected="false"><span>Styles</span></button>
      <button type="button" class="ed-mode-btn"           data-mode="images"  role="tab" aria-selected="false"><span>Images</span></button>
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

    <!-- Slice 3a: "Design colors" + "Element styles" relocated to the
         Styles mode pane (below). They are global, page-independent design
         tokens and never belonged to Lines. -->

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

<!-- ─────────── STYLES MODE PANE ─────────── -->
<!-- Slice 3a (v0.10.162): the palette + element-styles editors, relocated
     verbatim out of the Lines sidebar. These are GLOBAL design tokens shared
     across every page, so they get their own mode rather than living inside
     Lines. Ids are unchanged → dev-draw.js wires them exactly as before
     (all getElementById, document-wide); save still goes to the existing
     /dev/draw/palette and /dev/draw/typography routes. The right-hand
     surface is a placeholder explainer in 3a; Slice 3b fills it with the
     cross-page usage audit (which objects use each token, orphans, dangling
     refs). Reuses .ed-body / .ed-sidebar / .ed-panel so styling is identical
     and free; this pane sits AFTER the Lines pane in document order, so the
     load-error banner's querySelector('.ed-sidebar') still targets Lines. -->
<div class="ed-mode-pane ed-mode-pane--styles">
<div class="ed-body">
  <aside class="ed-sidebar">
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
        <button type="button" id="new-typo-btn" class="ed-mini" title="Add an element style">+ Style</button>
      </header>
      <!-- Slice 3a Step 2 (v0.10.165): the list is a minimal index now (name ·
           ★ · ×). Editing + reorder live on the canvas cards / floating panel. -->
      <ul id="typography-list" class="ed-typo-list"></ul>
      <button type="button" id="view-typo-btn" class="ed-mini ed-typo-view-btn"
              title="Preview every style as real paragraphs">View all in panel</button>
      <!-- Slice 3b: cross-page usage audit. Scans every published page and
           reports per-style usage counts (also shown as a badge on each
           canvas card), orphans, and dangling refs. -->
      <button type="button" id="audit-typo-btn" class="ed-mini ed-typo-view-btn"
              title="Scan every page: which objects use each style, orphans, dangling refs">Check usage</button>
      <!-- The single Save control. The duplicate sticky save-bar + per-row
           inline saves were removed; this top button is made full-width and
           prominent (it doubles as the dirty indicator via .is-dirty). -->
      <button type="button" id="save-typography-btn" class="ed-mini ed-typo-save-main"
              title="Write typography-tokens.json">Save styles</button>
    </section>
  </aside>

  <main class="ed-styles-surface">
    <!-- Element-style DISPLAY cards, rendered by dev-draw.js's
         renderElementStyleDisplay() in state.typography order. Edit opens a
         standalone floating panel. Palette is intentionally NOT shown here. -->
    <div id="ed-styles-display" class="ed-es-display"></div>
  </main>
</div>
</div>
<!-- ─────────── END STYLES MODE PANE ─────────── -->

<!-- ─────────── IMAGES MODE PANE (Slice 4) ─────────── -->
<!-- Slice 4a: this page's image library (content/<page>/_drafts/images/),
     loaded lazily on first entry to Images mode from GET dev/page/images/<id>.
     4b adds per-image usage badges + audit; 4c adds the import-from-workshop
     sub-panel. Page-scoped, matching the editor's one-target-page model. -->
<div class="ed-mode-pane ed-mode-pane--images">
  <main class="ed-images-surface">
    <header class="ed-images-head">
      <h3 class="ed-images-title">Image library</h3>
      <span class="ed-images-meta" id="ed-images-meta"></span>
      <span class="ed-es-card-spacer"></span>
      <button type="button" id="ed-images-add" class="ed-mini ed-mini-primary"
              title="Upload an image straight into this page's library">＋ Add image</button>
      <input type="file" id="ed-images-file" accept="image/png,image/jpeg,image/gif,image/webp,image/avif" hidden>
      <button type="button" id="ed-images-import-toggle" class="ed-mini"
              title="Bring an image in from an image-workshop batch">From workshop…</button>
      <button type="button" id="ed-images-audit" class="ed-mini"
              title="Which objects use each image, orphans, dangling refs">Check usage</button>
      <button type="button" id="ed-images-refresh" class="ed-mini"
              title="Reload this page's image library">Refresh</button>
    </header>

    <!-- Import-from-workshop sub-panel (progressive disclosure: closed by
         default, opened by the "+ Import images" button). Pulls a resized
         derivative from a workshop batch into THIS page's library via
         POST dev/image-workshop/use-image. -->
    <section id="ed-images-import" class="ed-import" hidden>
      <header class="ed-import-head">
        <h4 class="ed-import-title">Import from workshop</h4>
        <span class="ed-import-field"><span class="ed-import-field-label">Batch</span>
          <span class="ed-dd" id="ed-import-dd">
            <!-- Native select kept as the state source (value + change event)
                 but hidden; the custom button/list below renders a guaranteed
                 dark popup (native popups ignore CSS on macOS/Opera). -->
            <select id="ed-import-batch" class="ed-import-select ed-dd-native"></select>
            <button type="button" class="ed-dd-btn" id="ed-import-batch-btn" aria-haspopup="listbox" aria-expanded="false">
              <span class="ed-dd-label">— choose a batch —</span><span class="ed-dd-caret" aria-hidden="true">▾</span>
            </button>
            <ul class="ed-dd-list" id="ed-import-batch-list" role="listbox" hidden></ul>
          </span>
        </span>
        <span class="ed-import-hint">Each image comes in at its workshop size (→ Npx), or original if none was set.</span>
        <span class="ed-es-card-spacer"></span>
        <span class="ed-import-status" id="ed-import-status"></span>
        <button type="button" id="ed-images-import-close" class="ed-mini" title="Close import">×</button>
      </header>
      <div id="ed-import-grid" class="ed-images-grid ed-import-grid">
        <div class="ed-images-empty">Choose a batch to browse its images…</div>
      </div>
    </section>

    <div id="ed-images-grid" class="ed-images-grid">
      <div class="ed-images-empty">Switch to this tab to load the page’s images…</div>
    </div>
  </main>
</div>

<!-- Click-to-view lightbox (4g-2b). Import cards import on click, so a
     dedicated zoom button (not card-click) opens this overlay. -->
<div id="ed-img-lightbox" class="ed-img-lightbox" hidden role="dialog" aria-modal="true" aria-label="Image preview">
  <button type="button" class="ed-img-lightbox-close" id="ed-img-lightbox-close" aria-label="Close preview">×</button>
  <img class="ed-img-lightbox-img" id="ed-img-lightbox-img" src="" alt="">
</div>
<!-- ─────────── END IMAGES MODE PANE ─────────── -->

<!-- v0.8.110: floating-panel host (Lines mode). Fixed full-viewport overlay
     that never intercepts pointer events itself; individual floating
     panels (added by PanelManager in dev-draw.js) opt back in via
     their own pointer-events:auto. -->
<div id="panel-host" class="ed-panel-host" aria-hidden="false"></div>

<script id="editor-data" type="application/json"><?= $payload ?></script>
<!-- The whole editor is now ONE file: dev-editor.js. Slice 6a merged
     dev-draw.js + dev-page.js (Sections 1–2); 6b added the unified save
     coordinator (Section 3); 6b-2 folded the former inline mode-toggle
     and images-pane scripts in as Sections 4–5. Nothing inline remains
     below except the editor-data JSON blob above. -->
<script src="<?= url('assets/js/dev-editor.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
<?php snippet('sync-peer-indicator') ?>
</body>
</html>
