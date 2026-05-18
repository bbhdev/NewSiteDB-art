<?php
/**
 * Lines layer — fixed-position SVG overlay that renders the page's
 * scroll-driven line system.
 *
 * Reads (v3+):
 *
 *   content/_shared/classes.json
 *     — site-wide screen-class breakpoints.
 *
 *   content/<slug>/page.json
 *     — { useClasses, dims:{<classId>:{pageW,pageH,canvasW,canvasH}} }
 *
 *   content/<slug>/<classId>/{lines.json,groups.json}
 *     — per-class authored content.
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

$classes   = art_load_classes($contentRoot);
$pageCfg   = art_load_page_config($root);
$palette   = is_file($contentRoot . '/colors.json')
    ? (json_decode(file_get_contents($contentRoot . '/colors.json'), true) ?: [])
    : (is_file($contentRoot . '/colors.example.json')
        ? (json_decode(file_get_contents($contentRoot . '/colors.example.json'), true) ?: [])
        : []);

// Load each class's lines + groups. byClass is keyed by classId so
// the runtime can switch classes without a network round-trip.
$byClass = [];
foreach ($pageCfg['useClasses'] as $classId) {
    $byClass[$classId] = art_load_class_data($root, $classId);
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
], JSON_UNESCAPED_SLASHES);
?>
<svg id="lines-layer" viewBox="<?= art_viewbox_attr($initialDims) ?>" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
<script id="lines-data" type="application/json"><?= $payload ?></script>
