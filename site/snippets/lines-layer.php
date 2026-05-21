<?php
/**
 * Lines layer — fixed-position SVG overlay that renders the page's
 * scroll-driven line system.
 *
 * Reads (v4+):
 *
 *   content/_shared/classes.json
 *     — site-wide screen-class breakpoints.
 *
 *   content/_shared/masters.json
 *     — site-wide canonical visual definitions per object.
 *
 *   content/_shared/palette.json
 *     — site-wide color palette.
 *
 *   content/<slug>/page.json
 *     — { useClasses, dims:{<classId>:{pageW,pageH,canvasW,canvasH}} }
 *
 *   content/<slug>/<classId>/instances.json + groups.json
 *     — per-class authored content. Instances reference masters by
 *       id and carry per-class overrides; the snippet resolves them
 *       to fully-baked line records before inlining for app.js.
 *
 * The runtime in app.js picks a class by viewport width, applies
 * that class's dims to the SVG, and renders the class's lines. On
 * window resize across a class boundary it re-picks and re-renders.
 *
 * Also picks up any *.svg files dropped into <pageRoot>/lines/ (not
 * per-class) — each <path> inside such a file becomes an "imported"
 * line in a default group with gentle defaults.
 *
 * Data is inlined in a <script type="application/json"> tag so the
 * runtime in app.js can read it without an extra HTTP round-trip and
 * without exposing /content/ over HTTP.
 */

$root        = $page->root();
$contentRoot = kirby()->root('content');

$classes = art_load_classes($contentRoot);
$pageCfg = art_load_page_config($root);
$palette = art_load_palette($contentRoot);
$masters = art_load_masters($contentRoot);
$mastersById = [];
foreach ($masters as $m) {
    if (isset($m['id'])) $mastersById[$m['id']] = $m;
}

// Per-class resolved lines: each instance is composed with its
// master so the runtime keeps consuming flat line records (no
// awareness of the master/instance split needed there).
$byClass = [];
foreach ($pageCfg['useClasses'] as $classId) {
    $data = art_load_class_data($root, $classId);
    $lines = [];
    foreach ($data['instances'] as $inst) {
        if (!is_array($inst)) continue;
        $lines[] = art_resolve_instance($inst, $mastersById);
    }
    $byClass[$classId] = ['lines' => $lines, 'groups' => $data['groups']];
}

// SVG imports stay page-level (rare, not class-varying).
$svgImports = [];
$svgDir = $root . '/lines';
if (is_dir($svgDir)) {
  foreach (glob($svgDir . '/*.svg') as $svgPath) {
    $svgImports[] = [
      'id'      => 'svg-' . basename($svgPath, '.svg'),
      'content' => file_get_contents($svgPath)
    ];
  }
}

// Initial viewBox: pick the wide class's dims as a server-side
// default so the SVG paints something sensible before JS picks the
// real class for this viewport. JS will rewrite the viewBox once it
// reads the viewport width.
$initialClass = in_array('wide', $pageCfg['useClasses'], true)
    ? 'wide'
    : ($pageCfg['useClasses'][0] ?? 'wide');
$initialDims  = $pageCfg['dims'][$initialClass] ?? art_default_dims();

$payload = json_encode([
    'classes'    => $classes,
    'page'       => $pageCfg,
    'byClass'    => $byClass,
    'palette'    => $palette,
    'svgImports' => $svgImports,
    'version'    => option('version', 'dev'),
], JSON_UNESCAPED_SLASHES);
?>
<svg id="lines-layer" viewBox="<?= art_viewbox_attr($initialDims) ?>" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
<script id="lines-data" type="application/json"><?= $payload ?></script>
