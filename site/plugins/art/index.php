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
 * Read all site-wide master visual definitions (v4+). Empty array
 * when masters.json is absent (fresh clone before migration).
 *
 * @return list<array>
 */
function art_load_masters(string $contentDir): array
{
    $marker = $contentDir . '/_shared/masters.json';
    if (!is_file($marker)) return [];
    $data = json_decode(file_get_contents($marker), true);
    return is_array($data) ? $data : [];
}

/**
 * Read the site-wide design palette. v4+ canonical location is
 * content/_shared/palette.json; falls back to legacy
 * content/colors.json and finally content/colors.example.json so
 * pre-migration content + fresh clones still work.
 *
 * @return list<array>
 */
function art_load_palette(string $contentDir): array
{
    $candidates = [
        $contentDir . '/_shared/palette.json',
        $contentDir . '/colors.json',
        $contentDir . '/colors.example.json',
    ];
    foreach ($candidates as $path) {
        if (is_file($path)) {
            $data = json_decode(file_get_contents($path), true);
            if (is_array($data)) return $data;
        }
    }
    return [];
}

/**
 * Per-class instance records (v4+). Falls back to v3 lines.json (and
 * legacy locations) and wraps each entry as a master-less instance
 * so pre-migration content still renders something. Same chain for
 * groups.json (per-class).
 *
 * @return array{instances:list<array>,groups:list<array>}
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
    // Prefer v4 instances.json. If absent, wrap legacy lines.json so
    // every old-shape line becomes a master-less instance whose
    // overrides carry the full visual payload (matches what
    // art_resolve_instance would produce when masterId is null).
    $instances = $readFirst([$classDir . '/instances.json']);
    if (!$instances) {
        $legacy = $readFirst([
            $classDir . '/lines.json',
            $pageRoot . '/lines.json',
            $pageRoot . '/lines.example.json',
        ]);
        $instances = array_map(function ($line) {
            $line = is_array($line) ? $line : [];
            $behaviors = is_array($line['overrides'] ?? null) ? $line['overrides'] : [];
            $visual    = $line;
            unset($visual['id'], $visual['groupId'], $visual['hidden'], $visual['overrides']);
            return [
                'id'        => $line['id'] ?? null,
                'masterId'  => null,
                'visible'   => empty($line['hidden']),
                'groupId'   => $line['groupId'] ?? null,
                'overrides' => (object) array_merge($behaviors, $visual),
            ];
        }, $legacy);
    }
    $groups = $readFirst([
        $classDir . '/groups.json',
        $pageRoot . '/groups.json',
        $pageRoot . '/groups.example.json',
    ]);
    return ['instances' => $instances, 'groups' => $groups];
}

/**
 * Compose a fully-baked line record from a master + its instance
 * overrides. Same shape every line had pre-v4, so the runtime
 * consumes it unchanged. `masterId` is carried along, and the
 * original overrides map is preserved at line.overrides so the
 * runtime's behavior pipeline (translate / rotate / drawIn keys)
 * still finds its inputs.
 *
 * Resolution order: master visual props → instance overrides win.
 * Instance-specific fields (id, groupId, hidden) overlay on top.
 */
function art_resolve_instance(array $instance, array $mastersById): array
{
    // Behavior keys (per-class always) and the four position sub-keys
    // (per-class via positionOffset) sit outside the scope contract.
    static $BEHAVIOR_KEYS = [
        'translateX', 'translateY', 'rotate',
        'drawIn', 'drawInDirection',
        'rotateOriginX', 'rotateOriginY',
    ];
    static $POSITION_SUBKEYS = ['cx', 'cy', 'x', 'y'];

    $line = [];
    $masterId = $instance['masterId'] ?? null;
    $master   = null;
    if ($masterId && isset($mastersById[$masterId])) {
        $master = $mastersById[$masterId];
        $line   = $master;
        // master.id is the master's id; strip so it doesn't leak as
        // line.id below.
        unset($line['id']);
    }
    // master.scope: keyPath => 'local'. Missing key => canonical.
    $scope = [];
    if (is_array($master) && isset($master['scope']) && is_array($master['scope'])) {
        $scope = $master['scope'];
    }
    $overrides = $instance['overrides'] ?? null;
    $ovArr = [];
    if (is_array($overrides) || is_object($overrides)) {
        $ovArr = (array) $overrides;
        foreach ($ovArr as $k => $v) {
            // Behavior keys always apply — they're never canonical.
            if (in_array($k, $BEHAVIOR_KEYS, true)) {
                $line[$k] = $v;
                continue;
            }
            if ($k === 'params' && (is_array($v) || is_object($v))) {
                $vArr = (array) $v;
                if (!isset($line['params']) || !is_array($line['params'])) {
                    $line['params'] = [];
                }
                foreach ($vArr as $sk => $sv) {
                    // Position is expressed via positionOffset.
                    if (in_array($sk, $POSITION_SUBKEYS, true)) continue;
                    if (($scope['params.' . $sk] ?? null) === 'local') {
                        $line['params'][$sk] = $sv;
                    }
                }
                continue;
            }
            // `name` is structurally canonical — never apply a
            // per-instance name override even if stale data has one.
            if ($k === 'name') continue;
            // Other visual key — apply only when scope says local.
            if (($scope[$k] ?? null) === 'local') {
                $line[$k] = $v;
            }
        }
    }
    // positionOffset is passed through as a separate field; the
    // runtime composes it into the path's transform attribute (so the
    // canonical line.params can drive the rotation pivot correctly).
    $offset = $instance['positionOffset'] ?? null;
    $dx = (is_array($offset) && isset($offset['dx']) && is_numeric($offset['dx']))
        ? (float)$offset['dx'] : 0.0;
    $dy = (is_array($offset) && isset($offset['dy']) && is_numeric($offset['dy']))
        ? (float)$offset['dy'] : 0.0;
    $line['id']             = $instance['id'] ?? null;
    $line['groupId']        = $instance['groupId'] ?? null;
    $line['hidden']         = !($instance['visible'] ?? true);
    $line['overrides']      = $ovArr;
    $line['positionOffset'] = ['dx' => $dx, 'dy' => $dy];
    // Behaviors (v0.4.0): scroll-animation blocks, per-instance.
    // Pass through unchanged — the runtime applies them.
    $line['behaviors']      = isset($instance['behaviors']) && is_array($instance['behaviors'])
        ? $instance['behaviors']
        : [];
    // v0.8.231 / schema v12: scrollMode is per-instance ('flow' | 'static').
    // Absent field = 'flow' in the runtime; pass the raw value (or null)
    // so the runtime can distinguish "explicitly flow" vs "absent = flow".
    // The distinction doesn't matter today, but keeping the raw value avoids
    // baking an implicit default into the server output.
    if (isset($instance['scrollMode'])) {
        $line['scrollMode'] = $instance['scrollMode'];
    }
    // v0.8.275: per-object "Follow this object" — pass through the
    // donor's masterId so the runtime (app.js resolveInstanceJS) can
    // compose the donor's behaviors onto this line.
    if (isset($instance['followsMasterId']) && $instance['followsMasterId']) {
        $line['followsMasterId'] = $instance['followsMasterId'];
    }
    if ($masterId)  $line['masterId'] = $masterId;
    return $line;
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
