<?php
/**
 * Art plugin — helpers shared between the editor template, the
 * runtime snippet, and the save endpoint. Lives here (vs duplicated
 * inline) so future schema phases can extend a single source of
 * truth.
 */

Kirby::plugin('site/art', []);

/**
 * Default per-page drawing config. Matches the values the hardcoded
 * viewBox used before Phase 1, so a page with no page.json on disk
 * renders identically to v1.
 */
function art_default_page_config(): array
{
    return ['pageW' => 1200, 'pageH' => 800, 'canvasW' => 2400, 'canvasH' => 1600];
}

/**
 * Read a page's drawing config (page area + canvas dimensions).
 * Falls back to defaults when page.json is absent (v1 content) or
 * malformed. Unknown keys in the file (e.g. _schemaVersion) are
 * passed through untouched.
 *
 * @return array{pageW:float,pageH:float,canvasW:float,canvasH:float}
 */
function art_load_page_config(string $pageRoot): array
{
    $cfg = art_default_page_config();
    $marker = $pageRoot . '/page.json';
    if (!is_file($marker)) return $cfg;
    $data = json_decode(file_get_contents($marker), true);
    if (!is_array($data)) return $cfg;
    foreach (['pageW', 'pageH', 'canvasW', 'canvasH'] as $k) {
        if (isset($data[$k]) && is_numeric($data[$k]) && $data[$k] > 0) {
            $cfg[$k] = (float) $data[$k];
        }
    }
    return $cfg;
}

/**
 * SVG viewBox tuple for a config. Canvas-sized, centered so the page
 * area sits at (0, 0) – (pageW, pageH). Asymmetric canvas/page gaps
 * (odd differences) produce non-integer offsets, which SVG handles.
 *
 * @return array{x:float,y:float,w:float,h:float}
 */
function art_viewbox(array $cfg): array
{
    return [
        'x' => -($cfg['canvasW'] - $cfg['pageW']) / 2,
        'y' => -($cfg['canvasH'] - $cfg['pageH']) / 2,
        'w' => $cfg['canvasW'],
        'h' => $cfg['canvasH'],
    ];
}

/**
 * Render the four-number viewBox string for SVG.
 */
function art_viewbox_attr(array $cfg): string
{
    $vb = art_viewbox($cfg);
    return $vb['x'] . ' ' . $vb['y'] . ' ' . $vb['w'] . ' ' . $vb['h'];
}
