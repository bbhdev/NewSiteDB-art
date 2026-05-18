<?php
/**
 * Lines layer — fixed-position SVG overlay that renders the page's
 * scroll-driven line system.
 *
 * Reads two JSON files alongside the page content:
 *
 *   groups.json   — list of groups. Each group has a scroll trigger
 *                   (CSS selector or null for page-wide) and default
 *                   behaviors (translateX/Y, rotate, drawIn).
 *
 *   lines.json    — list of lines. Each line has an SVG path "d" string,
 *                   a groupId, and optional per-line overrides of any
 *                   behavior field.
 *
 * Also picks up any *.svg files dropped into <page>/lines/ — each
 * <path> element inside such a file becomes an "imported" line in a
 * default group with gentle defaults. This is the design-app authoring
 * path (draw lines in Figma/Illustrator/etc., export, drop).
 *
 * Data is inlined in a <script type="application/json"> tag so the
 * runtime in app.js can read it without an extra HTTP round-trip and
 * without needing Kirby to expose /content/ over HTTP.
 */

$root = $page->root();

// Read the live .json file if it exists, otherwise fall back to the
// committed .example.json seed. The live files are gitignored (they're
// user-authored content written by /dev/draw/save) so a fresh clone
// gets the example data automatically and per-machine drawings never
// conflict with `git pull`.
$readJson = function ($path) {
  if (!file_exists($path)) {
    $seed = preg_replace('/\.json$/', '.example.json', $path);
    if (file_exists($seed)) $path = $seed;
    else return [];
  }
  $decoded = json_decode(file_get_contents($path), true);
  return is_array($decoded) ? $decoded : [];
};

$groups  = $readJson($root . '/groups.json');
$lines   = $readJson($root . '/lines.json');
$palette = $readJson(kirby()->root('content') . '/colors.json');
$pageCfg = art_load_page_config($root);

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

$payload = json_encode(
  ['groups' => $groups, 'lines' => $lines, 'palette' => $palette, 'page' => $pageCfg, 'svgImports' => $svgImports],
  JSON_UNESCAPED_SLASHES
);
?>
<svg id="lines-layer" viewBox="<?= art_viewbox_attr($pageCfg) ?>" preserveAspectRatio="xMidYMid meet" aria-hidden="true"></svg>
<script id="lines-data" type="application/json"><?= $payload ?></script>
