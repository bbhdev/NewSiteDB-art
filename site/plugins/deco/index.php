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

Kirby::plugin('site/deco', []);

/**
 * Canonical flat dimensions — the values the hardcoded viewBox used
 * before Phase 1. Returned for any class whose dims are missing.
 */
function deco_default_dims(): array
{
    return ['pageW' => 1200, 'pageH' => 800, 'canvasW' => 2400, 'canvasH' => 1600];
}

/**
 * Default site-wide class breakpoints. Used when classes.json is
 * absent.
 */
function deco_default_classes(): array
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
function deco_load_classes(string $contentDir): array
{
    $marker = $contentDir . '/_shared/classes.json';
    if (!is_file($marker)) return deco_default_classes();
    $data = json_decode(file_get_contents($marker), true);
    if (!is_array($data) || !$data) return deco_default_classes();
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
function deco_load_page_config(string $pageRoot): array
{
    $marker = $pageRoot . '/page.json';
    if (!is_file($marker)) {
        return [
            'useClasses' => ['wide'],
            'dims'       => ['wide' => deco_default_dims()],
        ];
    }
    $data = json_decode(file_get_contents($marker), true);
    if (!is_array($data)) {
        return [
            'useClasses' => ['wide'],
            'dims'       => ['wide' => deco_default_dims()],
        ];
    }
    // v3 (current) shape: nested.
    if (isset($data['useClasses']) && is_array($data['useClasses'])
        && isset($data['dims']) && is_array($data['dims'])) {
        $cfg = ['useClasses' => $data['useClasses'], 'dims' => []];
        foreach ($data['useClasses'] as $classId) {
            $cfg['dims'][$classId] = deco_normalize_dims($data['dims'][$classId] ?? []);
        }
        // Carry _schemaVersion through so the migrator can see it
        // when reading back.
        if (isset($data['_schemaVersion'])) $cfg['_schemaVersion'] = $data['_schemaVersion'];
        return $cfg;
    }
    // v2 (flat) shape: wrap as single-class wide.
    return [
        'useClasses' => ['wide'],
        'dims'       => ['wide' => deco_normalize_dims($data)],
        '_schemaVersion' => $data['_schemaVersion'] ?? 2,
    ];
}

/**
 * Pull the four known dim keys out of an arbitrary array, with
 * defaults for any missing/invalid values.
 */
function deco_normalize_dims(array $raw): array
{
    $cfg = deco_default_dims();
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
function deco_load_masters(string $contentDir): array
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
function deco_load_palette(string $contentDir): array
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
 * Phase-2 ELEMENT STYLES (one-layer model, v0.10.112+). A style is a
 * named, COMPLETE text-style container — family / size / weight /
 * line-height / letter-spacing / italic / COLOUR — that an author
 * applies to any text sequence (the offset-marks range method), with one
 * style designated the text object's default. There is a single styles
 * registry (this one); the earlier relative "char-style" middle layer is
 * retired and its range-mark mechanism repurposed to carry these complete
 * styles. The atomic inline marks (strong/em/underline/color) remain as
 * the sparse escape hatch and win per-axis over a style.
 *
 * `color` is a PALETTE-ID reference (governance: colours come from the
 * palette, never free hex) or null/absent → inherit. Resolved to a CSS
 * value at emit time via the palette (deco_typography_css below). Earlier
 * tokens with no `color` key keep inheriting — additive, no migration.
 *
 * The on-disk file + canonical location are unchanged for now
 * (typography-tokens.json, shape { schemaVersion, tokens }) — renaming
 * the artefact is a later cleanup slice, not worth a migration here.
 *
 * Canonical location is content/_shared/typography-tokens.json with
 * shape { schemaVersion, tokens: [...] } — the same site-wide _shared
 * pattern as palette.json / font-bundle.json. The file is authored in
 * the draw editor (Slice 3b); until then deco_default_typography()
 * supplies a seed set so the system works end-to-end with no file
 * present (mirrors deco_default_dims()).
 *
 * Token-ref integrity is intentionally NOT enforced at save time (a
 * rect's typographyId may dangle if a token is later deleted) — the
 * editor/runtime degrade gracefully (no class applied → inherited
 * defaults), exactly like a dangling image binding.
 *
 * @return list<array>
 */
function deco_default_typography(): array
{
    return [
        // Totality (A2): exactly one style is the DEFAULT — every text falls
        // back to it, there is no "undefined style". The default MUST carry a
        // concrete palette colour (it is the root fallback and cannot itself
        // inherit). Body is the natural default; its colour is the palette
        // 'text' id (the conventional site text colour).
        ['id' => 'heading',  'name' => 'Heading',    'family' => 'Playfair Display',   'sizePx' => 48, 'weight' => 600, 'lineHeight' => 1.1, 'letterSpacingPx' => 0,   'italic' => false, 'color' => null,   'isDefault' => false],
        ['id' => 'subhead',  'name' => 'Subheading', 'family' => 'Cormorant Garamond', 'sizePx' => 30, 'weight' => 500, 'lineHeight' => 1.2, 'letterSpacingPx' => 0.5, 'italic' => false, 'color' => null,   'isDefault' => false],
        ['id' => 'body',     'name' => 'Body',       'family' => 'Inter',              'sizePx' => 18, 'weight' => 400, 'lineHeight' => 1.5, 'letterSpacingPx' => 0,   'italic' => false, 'color' => 'text', 'isDefault' => true],
        ['id' => 'caption',  'name' => 'Caption',    'family' => 'Inter',              'sizePx' => 13, 'weight' => 400, 'lineHeight' => 1.4, 'letterSpacingPx' => 0.4, 'italic' => false, 'color' => null,   'isDefault' => false],
    ];
}

/**
 * Enforce the totality invariant on an element-style list: EXACTLY ONE
 * style carries isDefault=true. Pure normalisation, no I/O:
 *   - coerce every isDefault to bool;
 *   - if several are true, keep the FIRST and clear the rest;
 *   - if none is true, make the FIRST style the default.
 * An empty list is returned unchanged (the caller decides whether to seed).
 * Does NOT invent a colour for a colourless default — that's enforced at
 * authoring time (the save route / panel); a legacy default with no colour
 * degrades to inherit until the author sets one.
 *
 * @param  list<array> $tokens
 * @return list<array>
 */
function deco_normalize_typography(array $tokens): array
{
    $seen = false;
    foreach ($tokens as &$t) {
        if (!is_array($t)) { $t = []; continue; }
        $isDef = !empty($t['isDefault']);
        if ($isDef && !$seen) { $t['isDefault'] = true; $seen = true; }
        else                  { $t['isDefault'] = false; }
    }
    unset($t);
    if (!$seen && count($tokens) > 0) {
        // No default declared (e.g. legacy file predating isDefault) → first.
        $tokens[0]['isDefault'] = true;
    }
    return $tokens;
}

/**
 * @return list<array>
 */
function deco_load_typography(string $contentDir): array
{
    $path = $contentDir . '/_shared/typography-tokens.json';
    if (is_file($path)) {
        $data = json_decode(file_get_contents($path), true);
        if (is_array($data) && isset($data['tokens']) && is_array($data['tokens'])
            && count($data['tokens']) > 0) {
            // Normalise the totality invariant so callers (CSS emit, the page
            // editor's default-style resolution) can rely on exactly one
            // default — even for files written before isDefault existed.
            return deco_normalize_typography($data['tokens']);
        }
    }
    // No file, or an empty/invalid registry → the seed set (which already
    // satisfies totality: one default, concrete colour). "Zero styles" is
    // not a valid state under the one-layer model.
    return deco_default_typography();
}

/**
 * Emit one CSS rule per token — `.ty-<id> { … }` — as a plain string
 * (no <style> wrapper; the caller wraps it). Both the editor template
 * and the runtime template call this with the same token list, so a
 * text rect carrying typographyId=<id> renders identically in both —
 * visual parity is automatic, no duplicated rule authoring.
 *
 * Every field is sanitised/clamped before it reaches the stylesheet so
 * a hand-edited tokens file can never inject arbitrary CSS: id and
 * family are character-whitelisted, numerics are range-clamped.
 */
function deco_typography_css(array $tokens, array $palette = []): string
{
    $num = function (float $v): string {
        // Trim trailing zeros so "1.10" → "1.1", "0.00" → "0".
        $s = rtrim(rtrim(number_format($v, 3, '.', ''), '0'), '.');
        return $s === '' ? '0' : $s;
    };
    // Palette id → safe CSS colour value (same allow-list as
    // deco_palette_marks_css, so a hand-edited file can't inject CSS).
    $colourSafe = function ($v) {
        if (!is_string($v) || $v === '') return null;
        $ok = preg_match(
            '/^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9_-]+\)|rgba?\([0-9.,%\s\/-]+\)|hsla?\([0-9.,%\s\/-]+\)|[a-zA-Z]+)$/',
            $v
        );
        return $ok ? $v : null;
    };
    $paletteValue = [];
    foreach ($palette as $p) {
        if (!is_array($p) || !isset($p['id'])) continue;
        $pid = preg_replace('/[^a-z0-9_-]/i', '', (string) $p['id']);
        if ($pid === '') continue;
        $pv = $colourSafe($p['value'] ?? null);
        if ($pv !== null) $paletteValue[$pid] = $pv;
    }
    $out = '';
    foreach ($tokens as $t) {
        if (!is_array($t) || !isset($t['id'])) continue;
        $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $t['id']);
        if ($id === '') continue;
        $family = isset($t['family']) ? preg_replace('/[^A-Za-z0-9 _-]/', '', (string) $t['family']) : '';
        $size   = max(1.0,   min(400.0, isset($t['sizePx'])          ? (float) $t['sizePx']          : 16.0));
        $weight = max(100,   min(900,   isset($t['weight'])          ? (int)   $t['weight']          : 400));
        $lh     = max(0.5,   min(4.0,   isset($t['lineHeight'])      ? (float) $t['lineHeight']      : 1.4));
        $ls     = max(-20.0, min(50.0,  isset($t['letterSpacingPx']) ? (float) $t['letterSpacingPx'] : 0.0));
        $italic = !empty($t['italic']);
        $fam    = ($family !== '') ? ("'" . $family . "', ") : '';
        // Colour: a palette id resolved to its value. Unset / dangling →
        // no `color` declaration → text inherits (page default), exactly
        // like a dangling typographyId degrades gracefully.
        $colId  = isset($t['color']) ? preg_replace('/[^a-z0-9_-]/i', '', (string) $t['color']) : '';
        $colCss = ($colId !== '' && isset($paletteValue[$colId]))
                ? (' color: ' . $paletteValue[$colId] . ';')
                : '';
        $out .= '.ty-' . $id . ' {'
              . ' font-family: ' . $fam . 'sans-serif;'
              . ' font-size: ' . $num($size) . 'px;'
              . ' font-weight: ' . $weight . ';'
              . ' line-height: ' . $num($lh) . ';'
              . ' letter-spacing: ' . $num($ls) . 'px;'
              . ' font-style: ' . ($italic ? 'italic' : 'normal') . ';'
              . $colCss
              . " }\n";
    }
    return $out;
}

/**
 * Slice TS1 — derive rich-text runs from offset marks (runtime parity).
 *
 * PHP mirror of segments() in assets/js/dev-page.js: split $text at every
 * mark boundary and tag each run with the attrs that FULLY cover it, so the
 * runtime (canvas-page.php) and the editor produce byte-identical run
 * structure. Returns [['text'=>…, 'attrs'=>[…]], …]; empty marks → a single
 * unstyled run.
 *
 * Offsets are treated as character indices (mb_*). The editor emits UTF-16
 * code-unit offsets, which match for the BMP (all ordinary design copy);
 * astral characters (emoji) could mis-slice — acceptable for TS1's
 * strong/em scope and noted in HANDOFF.
 *
 * TS3-a: each run's `attrs` is now a list of VALUE-BEARING descriptors
 * ['attr'=>string, 'value'=>(true|string)] (was a bare list of attr
 * names). Atomic axes (strong/em) carry value===true; valued axes
 * (color → palette id) carry the string value. deco_marks_classes()
 * consumes the value to emit value-specific classes (mk-color-<id>).
 */
function deco_text_segments(string $text, $marks): array
{
    $len = mb_strlen($text, 'UTF-8');
    if ($len === 0) return [];
    $ms = is_array($marks) ? $marks : [];
    if (count($ms) === 0) return [['text' => $text, 'attrs' => []]];
    $bset = [0 => true, $len => true];
    foreach ($ms as $m) {
        if (!is_array($m)) continue;
        $s = isset($m['start']) ? (int) $m['start'] : 0;
        $e = isset($m['end'])   ? (int) $m['end']   : 0;
        if ($s > 0 && $s < $len) $bset[$s] = true;
        if ($e > 0 && $e < $len) $bset[$e] = true;
    }
    $bounds = array_keys($bset);
    sort($bounds, SORT_NUMERIC);
    $segs = [];
    for ($k = 0; $k < count($bounds) - 1; $k++) {
        $s = $bounds[$k];
        $e = $bounds[$k + 1];
        if ($e <= $s) continue;
        $attrs = [];
        $seen  = [];
        foreach ($ms as $m) {
            if (!is_array($m)) continue;
            $msS = isset($m['start']) ? (int) $m['start'] : 0;
            $msE = isset($m['end'])   ? (int) $m['end']   : 0;
            $a   = isset($m['attr'])  ? (string) $m['attr'] : '';
            if ($a === '' || $msS > $s || $msE < $e) continue;
            $val = array_key_exists('value', $m) ? $m['value'] : true;
            $vk  = is_bool($val) ? ($val ? 'true' : 'false') : (string) $val;
            $key = $a . "\0" . $vk;
            if (isset($seen[$key])) continue;
            $seen[$key] = true;
            $attrs[] = ['attr' => $a, 'value' => $val];
        }
        $segs[] = ['text' => mb_substr($text, $s, $e - $s, 'UTF-8'), 'attrs' => $attrs];
    }
    return $segs;
}

/**
 * Slice TS1/TS3-a — map a run's value-bearing attrs to CSS classes.
 * Ordered table (mirrors MARK_ATTR_CLASS in dev-page.js) so M2 layers
 * slot in later unchanged. Atomic axes map by name; valued axes map by
 * name+value (color → mk-color-<sanitised id>). Tolerates the legacy
 * bare-string element shape defensively.
 */
function deco_marks_classes(array $attrs): array
{
    static $map = ['strong' => 'mk-strong', 'em' => 'mk-em', 'underline' => 'mk-underline'];
    $cls = [];
    foreach ($attrs as $a) {
        if (is_array($a)) {
            $attr = isset($a['attr']) ? (string) $a['attr'] : '';
            $val  = array_key_exists('value', $a) ? $a['value'] : true;
        } else {
            $attr = (string) $a;
            $val  = true;
        }
        $c = null;
        if ($attr === 'color') {
            $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $val);
            if ($id !== '') $c = 'mk-color-' . $id;
        } elseif ($attr === 'charStyle') {
            // TS4: valued axis like `color`. value = a char-style id →
            // .mk-cs-<id> (emitted by deco_charstyle_marks_css). The class
            // is span-level (bare, specificity 0,1,0) so it BEATS the rect's
            // inherited .ty-<id> base token (direct > inherited) but LOSES to
            // the atomic axes (.rect-text .mk-strong, 0,2,0) — that is the
            // `rect base < char-style < atomic` cascade, achieved purely by
            // selector specificity, no resolver logic. Unknown id → no class
            // (degrades like a dangling typographyId).
            $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $val);
            if ($id !== '') $c = 'mk-cs-' . $id;
        } elseif (isset($map[$attr])) {
            $c = $map[$attr];
        }
        if ($c !== null && !in_array($c, $cls, true)) $cls[] = $c;
    }
    return $cls;
}

/**
 * TS3-b — governance for a `link` mark's href value. Returns a safe href, or
 * null to reject. Mirrors safeHref() in dev-page.js exactly: relative /
 * anchor / root-relative always safe; http(s):, mailto:, tel: are the only
 * permitted explicit schemes; any other scheme-like prefix (javascript:,
 * data:, vbscript:, file:, …) is rejected; a bare value with no scheme is a
 * relative path (browser-safe). Render-time defence-in-depth: even a
 * hand-edited rects.json can never emit a javascript: anchor.
 */
function deco_safe_href($v): ?string
{
    if (!is_string($v)) return null;
    $v = trim($v);
    if ($v === '') return null;
    if (preg_match('/^(#|\/|\.\/|\.\.\/)/', $v)) return $v;       // relative / anchor
    if (preg_match('/^(https?:|mailto:|tel:)/i', $v)) return $v;  // allowed schemes
    if (preg_match('/^[a-z][a-z0-9+.-]*:/i', $v)) return null;    // any other scheme → reject
    return $v;                                                    // bare relative path
}

/**
 * The safe href carried by a run's value-bearing attrs (first `link`), or
 * null. Tolerates the legacy bare-string attr shape defensively.
 */
function deco_marks_href(array $attrs): ?string
{
    foreach ($attrs as $a) {
        if (is_array($a) && isset($a['attr']) && $a['attr'] === 'link') {
            return deco_safe_href(array_key_exists('value', $a) ? $a['value'] : null);
        }
    }
    return null;
}

/**
 * TS3-a — emit one CSS rule per palette colour: `.mk-color-<id> { color:
 * <value>; }`. The dynamic sibling of deco_typography_css(): both the
 * editor template (page.php) and the runtime template (canvas-page.php)
 * call this with the SAME palette list, so a text rect's colour marks
 * render identically in both — visual parity is automatic.
 *
 * Every id is character-whitelisted and every value is validated against
 * the same safe-CSS-colour pattern used for the palette custom props, so
 * a hand-edited palette.json can never inject arbitrary CSS. A palette
 * entry with an unsafe value is skipped (its id then renders with no rule
 * → inherited colour, graceful like a dangling typography ref).
 */
function deco_palette_marks_css(array $palette): string
{
    $safe = function ($v) {
        if (!is_string($v) || $v === '') return null;
        $ok = preg_match(
            '/^(#[0-9a-fA-F]{3,8}|var\(--[a-zA-Z0-9_-]+\)|rgba?\([0-9.,%\s\/-]+\)|hsla?\([0-9.,%\s\/-]+\)|[a-zA-Z]+)$/',
            $v
        );
        return $ok ? $v : null;
    };
    $out = '';
    foreach ($palette as $p) {
        if (!is_array($p) || !isset($p['id'])) continue;
        $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $p['id']);
        if ($id === '') continue;
        $val = $safe($p['value'] ?? null);
        if ($val === null) continue;
        $out .= '.mk-color-' . $id . ' { color: ' . $val . '; }' . "\n";
    }
    return $out;
}

/**
 * TS4 — named character-styles (M2), the cascade's middle layer. A char-style
 * is a NAMED, RELATIVE, type-only style applied to a text RANGE (a `charStyle`
 * mark), as opposed to a typography token (absolute, applied to the whole
 * rect). "Relative" is the key decision: deltas are expressed in CSS-native
 * relative units so an inline style never forces an absolute size jump on a
 * few words (the trap that ruled out reusing rect-level typography tokens):
 *   - sizeEm          → font-size: <n>em      (× the inherited rect-base size)
 *   - weight          → font-weight: bolder|lighter (relative to inherited)
 *   - italic (bool)   → font-style: italic|normal
 *   - letterSpacingEm → letter-spacing: <n>em (scales with the relative size)
 * Colour is deliberately NOT part of a char-style (it stays the orthogonal
 * `color` mark axis), exactly like typography tokens. Authored later (Slice 3)
 * in content/_shared/char-styles.json with shape { schemaVersion, styles }
 * mirroring typography-tokens.json; until then deco_default_charstyles()
 * seeds a set so the axis works end-to-end with no file present.
 *
 * @return list<array>
 */
function deco_default_charstyles(): array
{
    return [
        ['id' => 'lead-in',    'name' => 'Lead-in',    'sizeEm' => 1.2,  'weight' => 'bolder'],
        ['id' => 'fine-print', 'name' => 'Fine print', 'sizeEm' => 0.8],
        ['id' => 'quote',      'name' => 'Quote',      'sizeEm' => 1.05, 'italic' => true],
    ];
}

/**
 * @return list<array>
 */
function deco_load_charstyles(string $contentDir): array
{
    $path = $contentDir . '/_shared/char-styles.json';
    if (is_file($path)) {
        $data = json_decode(file_get_contents($path), true);
        // Authored shape is { schemaVersion, styles:[...] }; tolerate a bare
        // list too. Empty/absent → seed defaults (mirrors deco_load_typography).
        if (is_array($data)) {
            $styles = (isset($data['styles']) && is_array($data['styles'])) ? $data['styles'] : $data;
            if (is_array($styles) && $styles !== []) return array_values($styles);
        }
    }
    return deco_default_charstyles();
}

/**
 * Emit one `.mk-cs-<id>` rule per char-style — the SAME emitter editor and
 * runtime use, so a char-style mark previews identically (WYSIWYG). Each rule
 * is a BARE single class (specificity 0,1,0): beats the rect's inherited
 * .ty-<id> token, loses to the atomic `.rect-text .mk-strong` axes (0,2,0).
 * That ordering IS the M1/M2 cascade — no resolver code. All units relative;
 * unset fields are simply omitted so the inherited value shows through.
 */
function deco_charstyle_marks_css(array $styles): string
{
    $num = function (float $v): string {
        $s = rtrim(rtrim(number_format($v, 4, '.', ''), '0'), '.');
        return $s === '' ? '0' : $s;
    };
    $out = '';
    foreach ($styles as $s) {
        if (!is_array($s) || !isset($s['id'])) continue;
        $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $s['id']);
        if ($id === '') continue;
        $decls = [];
        if (isset($s['sizeEm'])) {
            $em = max(0.1, min(10.0, (float) $s['sizeEm']));
            $decls[] = 'font-size: ' . $num($em) . 'em';
        }
        if (isset($s['weight'])) {
            $w = (string) $s['weight'];
            if ($w === 'bolder' || $w === 'lighter') $decls[] = 'font-weight: ' . $w;
        }
        if (array_key_exists('italic', $s)) {
            $decls[] = 'font-style: ' . (!empty($s['italic']) ? 'italic' : 'normal');
        }
        if (isset($s['letterSpacingEm'])) {
            $ls = max(-2.0, min(2.0, (float) $s['letterSpacingEm']));
            $decls[] = 'letter-spacing: ' . $num($ls) . 'em';
        }
        if ($decls) $out .= '.mk-cs-' . $id . ' { ' . implode('; ', $decls) . '; }' . "\n";
    }
    return $out;
}

/**
 * Build the Google-Fonts <link> for the site's font bundle
 * (content/_shared/font-bundle.json). The standalone Phase-2 templates
 * (page.php editor, canvas-page.php runtime) are NOT the main site shell
 * and don't run app.js, so they must load the webfonts themselves for a
 * typography token's family to actually render. Mirrors the family-list
 * construction used by app.js and the fonts-bundle route. Returns '' if
 * the bundle is absent/empty (graceful: tokens fall back to sans-serif).
 */
function deco_google_fonts_link(string $contentDir): string
{
    $path = $contentDir . '/_shared/font-bundle.json';
    if (!is_file($path)) return '';
    $j = json_decode(file_get_contents($path), true);
    if (!is_array($j) || !isset($j['fonts']) || !is_array($j['fonts'])) return '';
    $parts = [];
    foreach ($j['fonts'] as $f) {
        if (!is_string($f) || $f === '') continue;
        $parts[] = 'family=' . str_replace(' ', '+', $f);
    }
    if (!$parts) return '';
    $href = 'https://fonts.googleapis.com/css2?'
          . htmlspecialchars(implode('&', $parts), ENT_QUOTES, 'UTF-8')
          . '&display=swap';
    return '<link rel="stylesheet" href="' . $href . '">';
}

/**
 * Per-class instance records (v4+). Falls back to v3 lines.json (and
 * legacy locations) and wraps each entry as a master-less instance
 * so pre-migration content still renders something. Same chain for
 * groups.json (per-class).
 *
 * @return array{instances:list<array>,groups:list<array>}
 */
function deco_load_class_data(string $pageRoot, string $classId): array
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
    // deco_resolve_instance would produce when masterId is null).
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
function deco_resolve_instance(array $instance, array $mastersById): array
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
function deco_viewbox(array $dims): array
{
    return [
        'x' => -($dims['canvasW'] - $dims['pageW']) / 2,
        'y' => -($dims['canvasH'] - $dims['pageH']) / 2,
        'w' => $dims['canvasW'],
        'h' => $dims['canvasH'],
    ];
}

function deco_viewbox_attr(array $dims): string
{
    $vb = deco_viewbox($dims);
    return $vb['x'] . ' ' . $vb['y'] . ' ' . $vb['w'] . ' ' . $vb['h'];
}
