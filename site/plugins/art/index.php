<?php
/**
 * Art plugin — helpers shared between the editor template, the
 * runtime snippet, and the save endpoint. Centralized so future
 * schema phases extend a single source of truth.
 *
 * Schema (v3+):
 *   content/_shared/classes.json   — site-wide breakpoints
 *   content/<slug>/page.json       — { useClasses, dims:{<classId>:dims}, _schemaVersion }
 *   content/<slug>/<classId>/lines.json
 *   content/<slug>/<classId>/groups.json
 *
 * The helpers below tolerate missing files (fresh clones, unmigrated
 * content) by returning canonical defaults — the migration script is
 * still the canonical way to bring content forward, but the editor
 * and runtime won't crash on a half-set-up tree.
 */

Kirby::plugin('site/art', []);

/**
 * Canonical flat dimensions — the values the hardcoded viewBox used
 * before Phase 1. Returned for any class whose dims are missing.
 */
function art_default_dims(): array
{
    return ['pageW' => 1200, 'pageH' => 800, 'canvasW' => 2400, 'canvasH' => 1600];
}

/**
 * Default site-wide class breakpoints. Used when classes.json is
 * absent.
 */
function art_default_classes(): array
{
    return [
        ['id' => 'narrow', 'name' => 'Narrow', 'minWidth' => 0,    'maxWidth' => 640],
        ['id' => 'medium', 'name' => 'Medium', 'minWidth' => 641,  'maxWidth' => 1100],
        ['id' => 'wide',   'name' => 'Wide',   'minWidth' => 1101, 'maxWidth' => null],
    ];
}

/**
 * Read the site-wide class breakpoints. Falls back to defaults if
 * _shared/classes.json is missing or invalid.
 */
function art_load_classes(string $contentDir): array
{
    $marker = $contentDir . '/_shared/classes.json';
    if (!is_file($marker)) return art_default_classes();
    $data = json_decode(file_get_contents($marker), true);
    if (!is_array($data) || !$data) return art_default_classes();
    return $data;
}

/**
 * Read a page's drawing config (v3 shape: { useClasses, dims }). If
 * page.json is absent or in the v1/v2 flat shape, wraps the values
 * as a single-class wide-only v3 so callers can rely on the v3 API.
 *
 * Unknown top-level keys (like _schemaVersion) pass through.
 *
 * @return array{useClasses:list<string>, dims:array<string,array{pageW:float,pageH:float,canvasW:float,canvasH:float}>}
 */
function art_load_page_config(string $pageRoot): array
{
    $marker = $pageRoot . '/page.json';
    if (!is_file($marker)) {
        return [
            'useClasses' => ['wide'],
            'dims'       => ['wide' => art_default_dims()],
        ];
    }
    $data = json_decode(file_get_contents($marker), true);
    if (!is_array($data)) {
        return [
            'useClasses' => ['wide'],
            'dims'       => ['wide' => art_default_dims()],
        ];
    }
    // v3 (current) shape: nested.
    if (isset($data['useClasses']) && is_array($data['useClasses'])
        && isset($data['dims']) && is_array($data['dims'])) {
        $cfg = ['useClasses' => $data['useClasses'], 'dims' => []];
        foreach ($data['useClasses'] as $classId) {
            $cfg['dims'][$classId] = art_normalize_dims($data['dims'][$classId] ?? []);
        }
        // Carry _schemaVersion through so the migrator can see it
        // when reading back.
        if (isset($data['_schemaVersion'])) $cfg['_schemaVersion'] = $data['_schemaVersion'];
        return $cfg;
    }
    // v2 (flat) shape: wrap as single-class wide.
    return [
        'useClasses' => ['wide'],
        'dims'       => ['wide' => art_normalize_dims($data)],
        '_schemaVersion' => $data['_schemaVersion'] ?? 2,
    ];
}

/**
 * Pull the four known dim keys out of an arbitrary array, with
 * defaults for any missing/invalid values.
 */
function art_normalize_dims(array $raw): array
{
    $cfg = art_default_dims();
    foreach (['pageW', 'pageH', 'canvasW', 'canvasH'] as $k) {
        if (isset($raw[$k]) && is_numeric($raw[$k]) && $raw[$k] > 0) {
            $cfg[$k] = (float) $raw[$k];
        }
    }
    return $cfg;
}

/**
 * Read a single class's lines + groups for a given page. Resolution
 * walks a candidate list per file so all of these work without
 * special-casing:
 *
 *   - v3 live content    → <pageRoot>/<classId>/lines.json
 *   - v1/v2 unmigrated   → <pageRoot>/lines.json
 *   - fresh-clone seed   → <pageRoot>/lines.example.json
 *
 * Same chain for groups.json. Empty arrays returned on miss.
 *
 * @return array{lines:array,groups:array}
 */
function art_load_class_data(string $pageRoot, string $classId): array
{
    $classDir = $pageRoot . '/' . $classId;
    $readFirst = function (array $candidates): array {
        foreach ($candidates as $path) {
            if (is_file($path)) {
                $decoded = json_decode(file_get_contents($path), true);
                if (is_array($decoded)) return $decoded;
            }
        }
        return [];
    };
    return [
        'lines'  => $readFirst([
            $classDir . '/lines.json',
            $pageRoot . '/lines.json',
            $pageRoot . '/lines.example.json',
        ]),
        'groups' => $readFirst([
            $classDir . '/groups.json',
            $pageRoot . '/groups.json',
            $pageRoot . '/groups.example.json',
        ]),
    ];
}

/**
 * SVG viewBox for a single class's dims. Page area sits at (0,0);
 * canvas centers symmetrically around it.
 */
function art_viewbox(array $dims): array
{
    return [
        'x' => -($dims['canvasW'] - $dims['pageW']) / 2,
        'y' => -($dims['canvasH'] - $dims['pageH']) / 2,
        'w' => $dims['canvasW'],
        'h' => $dims['canvasH'],
    ];
}

function art_viewbox_attr(array $dims): string
{
    $vb = art_viewbox($dims);
    return $vb['x'] . ' ' . $vb['y'] . ' ' . $vb['w'] . ' ' . $vb['h'];
}
