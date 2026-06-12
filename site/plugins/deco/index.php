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
 * Element-styles (typography) save — extracted (v0.10.247, [conv] 3065) from the
 * former inline dev/draw/typography POST so the unified save seam
 * (dev/editor/save) can write site-wide typography in the SAME atomic request as
 * lines+layout+palette — exactly as deco_save_lines() already writes the
 * site-wide palette through that seam. Both the legacy route and the seam
 * delegate here, so there is ONE validator + writer.
 *
 * $body: { tokens: [ {id,name,family,sizePx,weight,lineHeight,letterSpacingPx,
 *          italic,color,isDefault}, … ] }. Writes content/_shared/typography-
 *          tokens.json atomically (tmp + rename).
 *
 * Validation is format-only + numeric CLAMPS, matching deco_typography_css()'s
 * sanitiser (so a hand-edited/buggy POST can't inject CSS), plus the one-layer
 * totality invariants: ≥1 token, exactly one default, and that default carries a
 * concrete colour (it is the root fallback and cannot itself inherit).
 *
 * Returns ['ok'=>true,'tokens'=>$clean,'count'=>N] on success, or
 *         ['ok'=>false,'error'=>…,'code'=>4xx/5xx] — the same array shape
 *         deco_save_lines()/deco_save_layout() use, so the seam routes it
 *         uniformly.
 */
function deco_save_typography(array $body): array
{
    $raw = isset($body['tokens']) && is_array($body['tokens']) ? $body['tokens'] : null;
    if ($raw === null) {
        return ['ok' => false, 'error' => 'Missing or invalid "tokens" array in body.', 'code' => 400];
    }

    $clamp = function ($v, $lo, $hi, $def) {
        if (!is_numeric($v)) return $def;
        $v = (float) $v;
        return max($lo, min($hi, $v));
    };
    $clean   = [];
    $seenIds = [];
    foreach ($raw as $t) {
        if (!is_array($t)) {
            return ['ok' => false, 'error' => 'Each token must be an object.', 'code' => 400];
        }
        $id = isset($t['id']) ? (string) $t['id'] : '';
        if (!preg_match('/^[a-z0-9_-]{1,64}$/', $id)) {
            return ['ok' => false, 'error' => 'Invalid token id: "' . $id . '" (lowercase a-z, 0-9, _ or -, 1-64 chars).', 'code' => 400];
        }
        if (isset($seenIds[$id])) {
            return ['ok' => false, 'error' => 'Duplicate token id: "' . $id . '".', 'code' => 400];
        }
        $seenIds[$id] = true;

        $name = isset($t['name']) ? trim((string) $t['name']) : '';
        if ($name === '' || mb_strlen($name) > 64 || !preg_match("/^[\p{L}\p{N} _.,'()\[\]\\-]+$/u", $name)) {
            return ['ok' => false, 'error' => 'Invalid token name for "' . $id . '".', 'code' => 400];
        }

        $family = isset($t['family']) ? trim((string) $t['family']) : '';
        if ($family !== '' && !preg_match("/^[A-Za-z0-9 '_-]{1,64}$/", $family)) {
            return ['ok' => false, 'error' => 'Invalid font family for "' . $id . '".', 'code' => 400];
        }

        // Colour: optional palette-ID reference. Empty/absent → null (inherit).
        // Format-only check; membership NOT enforced — a dangling ref degrades
        // gracefully (no colour emitted → inherit), like a dangling typographyId.
        $colorRaw = isset($t['color']) ? trim((string) $t['color']) : '';
        if ($colorRaw !== '' && !preg_match('/^[a-z0-9_-]{1,64}$/', $colorRaw)) {
            return ['ok' => false, 'error' => 'Invalid colour ref for "' . $id . '" (palette id: lowercase a-z, 0-9, _ or -).', 'code' => 400];
        }

        $clean[] = [
            'id'              => $id,
            'name'            => $name,
            'family'          => $family,
            'sizePx'          => $clamp($t['sizePx']          ?? null, 1.0,   400.0, 16.0),
            'weight'          => (int) $clamp($t['weight']     ?? null, 100,   900,   400),
            'lineHeight'      => $clamp($t['lineHeight']       ?? null, 0.5,   4.0,   1.4),
            'letterSpacingPx' => $clamp($t['letterSpacingPx']  ?? null, -20.0, 50.0,  0.0),
            'italic'          => !empty($t['italic']),
            'color'           => $colorRaw !== '' ? $colorRaw : null,
            'isDefault'       => !empty($t['isDefault']),
        ];
    }

    // Totality (A2): the one-layer model forbids an "undefined style".
    if (count($clean) === 0) {
        return ['ok' => false, 'error' => 'At least one element style is required (there is no “undefined style”).', 'code' => 400];
    }
    $defaults = array_values(array_filter($clean, function ($t) { return $t['isDefault']; }));
    if (count($defaults) === 0) {
        return ['ok' => false, 'error' => 'One element style must be marked as the default.', 'code' => 400];
    }
    if (count($defaults) > 1) {
        return ['ok' => false, 'error' => 'Only one element style can be the default.', 'code' => 400];
    }
    if ($defaults[0]['color'] === null) {
        return ['ok' => false, 'error' => 'The default style “' . $defaults[0]['name'] . '” must have a colour (it is the root fallback and cannot inherit).', 'code' => 400];
    }

    $sharedDir  = kirby()->root('content') . '/_shared';
    $tokensPath = $sharedDir . '/typography-tokens.json';
    if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) {
        return ['ok' => false, 'error' => 'Could not create _shared directory.', 'code' => 500];
    }
    $payload = [
        'schemaVersion' => 1,
        'tokens'        => $clean,
        'savedAt'       => date('c'),
        'count'         => count($clean),
    ];
    $tmpPath = $tokensPath . '.tmp';
    $bytes   = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    if (@file_put_contents($tmpPath, $bytes) === false || !@rename($tmpPath, $tokensPath)) {
        return ['ok' => false, 'error' => 'Failed to write typography-tokens.json.', 'code' => 500];
    }
    return ['ok' => true, 'tokens' => $clean, 'count' => count($clean)];
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
        } elseif ($attr === 'elementStyle') {
            // Slice C (2026-06, decision A): runtime mirror of classForMark()
            // in dev-page.js. An `elementStyle` range mark carries a COMPLETE
            // element-style id and emits the SAME bare `.ty-<id>` class the
            // rect's default style uses — one registry, one emitter
            // (deco_typography_css already emits the rule). Applied DIRECTLY on
            // the run span, `.ty-<id>` (0,1,0) beats the rect's INHERITED
            // `.ty-<id>` base (direct > inherited, no specificity needed) →
            // range overrides rect-default; and loses to the atomic
            // `.rect-text .mk-*` axes (0,2,0) → strong/em/underline still win.
            // The element-style's own colour ties the atomic `.mk-color-<id>`;
            // that tie is broken in deco_palette_marks_css (atomic colour
            // qualified to (0,2,0)). Unknown id → no class (degrades like a
            // dangling typographyId).
            $id = preg_replace('/[^a-z0-9_-]/i', '', (string) $val);
            if ($id !== '') $c = 'ty-' . $id;
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
        // Slice B (2026-06): qualify the atomic colour mark with its container
        // class in BOTH contexts so its specificity is (0,2,0) — one notch above
        // the (0,1,0) `.ty-<id>` an `elementStyle` range mark applies directly on
        // the same run. Without this, an element-style's own colour would TIE the
        // atomic colour escape-hatch and source-order would decide; with it the
        // per-instance colour override always wins (escape-hatch > element style).
        // Both prefixes are emitted (editor `.pe-rect-text`, runtime `.rect-text`)
        // mirroring the static atomic strong/em rules; the irrelevant-context
        // selector simply never matches. Covers run <span>s and link <a>s alike.
        $out .= '.pe-rect-text .mk-color-' . $id . ', .rect-text .mk-color-' . $id
              . ' { color: ' . $val . '; }' . "\n";
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

/* ===================================================================
 * Convergence Slice 5a-1 — shared save logic
 *
 * The editor's two historical save endpoints (dev/draw/save for the
 * lines/drawing layer, dev/page/save for the rect-block layout layer)
 * grew up as separate route handlers. 5a gives the editor ONE save
 * seam (dev/editor/save) that dispatches to both, WITHOUT changing the
 * on-disk data shape. To make that possible the two handler bodies are
 * extracted here as pure functions that take a decoded request body and
 * return a plain result array:
 *
 *   ['ok' => true]                                    on success
 *   ['ok' => false, 'error' => string, 'code' => int] on failure
 *
 * The route wrappers (config.php) keep ownership of the per-request
 * concerns that must fire exactly once regardless of how many layers a
 * save touches: sync_record_activity_and_notify() at entry, and turning
 * the result array back into a Kirby\Http\Response. The success-path
 * sync_bump_page() lives INSIDE each helper (it's per-layer/per-page,
 * and only the success path should reach it — identical to the
 * pre-5a behaviour).
 *
 * These are byte-for-byte ports of the former route bodies; any change
 * to validation/normalisation/write logic must stay in lock-step with
 * what the editor and runtime expect.
 * =================================================================== */

/**
 * Lines/drawing layer save (former dev/draw/save body).
 *
 * $body keys: page (string, required), byClass (map classId →
 *   {instances, groups}, required), masters? (array), palette? (array),
 *   pageCfg? (array {useClasses, dims}).
 */
function deco_save_lines(array $body): array
{
    $kirby = kirby();

    $pageId  = $body['page']    ?? null;
    $byClass = $body['byClass'] ?? null;  // map of classId → { instances, groups }
    $masters = $body['masters'] ?? null;  // optional — site-wide visual definitions
    $palette = $body['palette'] ?? null;  // optional — site-wide
    $pageCfg = $body['pageCfg'] ?? null;  // optional — nested page config

    if (!is_string($pageId) || !is_array($byClass) || !$byClass) {
        return ['ok' => false, 'error' => 'Missing or invalid body fields.', 'code' => 400];
    }

    $page = $kirby->page($pageId);
    if (!$page) {
        return ['ok' => false, 'error' => 'Unknown page: ' . $pageId, 'code' => 404];
    }

    $root = $page->root();
    $opts = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES;

    // Per-class files: instances + groups for every class in the
    // payload. Each classId is validated against [a-z0-9_-]+ so a
    // malicious payload can't escape into parent directories.
    $writeOk = true;
    foreach ($byClass as $classId => $cls) {
        if (!is_string($classId) || !preg_match('/^[a-z0-9_-]+$/i', $classId)) {
            return ['ok' => false, 'error' => 'Invalid classId: ' . $classId, 'code' => 400];
        }
        if (!is_array($cls) || !isset($cls['instances']) || !isset($cls['groups'])
            || !is_array($cls['instances']) || !is_array($cls['groups'])) {
            return ['ok' => false, 'error' => 'Class ' . $classId . ' missing instances/groups arrays', 'code' => 400];
        }
        $classDir = $root . '/' . $classId;
        if (!is_dir($classDir) && !mkdir($classDir, 0755, true)) {
            return ['ok' => false, 'error' => 'Could not create class dir: ' . $classId, 'code' => 500];
        }
        $writeOk = $writeOk
            && file_put_contents($classDir . '/groups.json',    json_encode($cls['groups'],    $opts) . "\n") !== false
            && file_put_contents($classDir . '/instances.json', json_encode($cls['instances'], $opts) . "\n") !== false;
        if (!$writeOk) break;
    }

    // Site-wide masters (visual definitions). The editor sends
    // the full list every save so deletions propagate; we
    // overwrite atomically. Skipped silently when the body omits
    // it (older clients / probe requests).
    if (is_array($masters)) {
        $sharedDir = $kirby->root('content') . '/_shared';
        if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) {
            return ['ok' => false, 'error' => 'Could not create _shared directory.', 'code' => 500];
        }
        $writeOk = $writeOk && (
            file_put_contents($sharedDir . '/masters.json',
                json_encode($masters, $opts) . "\n") !== false
        );
    }

    // Per-page nested config (v3+): { useClasses, dims:{<classId>:{...}} }.
    // Merge into existing page.json so unknown fields (like
    // _schemaVersion, future per-page settings) survive untouched.
    if (is_array($pageCfg)) {
        $existing = is_file($root . '/page.json')
            ? (json_decode(file_get_contents($root . '/page.json'), true) ?: [])
            : [];
        $merged = $existing;
        if (isset($pageCfg['useClasses']) && is_array($pageCfg['useClasses'])) {
            $merged['useClasses'] = array_values(array_filter(
                $pageCfg['useClasses'], 'is_string'
            ));
        }
        if (isset($pageCfg['dims']) && is_array($pageCfg['dims'])) {
            $merged['dims'] = isset($merged['dims']) && is_array($merged['dims'])
                ? $merged['dims'] : [];
            foreach ($pageCfg['dims'] as $cid => $dims) {
                if (!is_string($cid) || !is_array($dims)) continue;
                $clean = isset($merged['dims'][$cid]) && is_array($merged['dims'][$cid])
                    ? $merged['dims'][$cid] : [];
                foreach (['pageW', 'pageH', 'canvasW', 'canvasH'] as $k) {
                    if (isset($dims[$k]) && is_numeric($dims[$k]) && $dims[$k] > 0) {
                        $clean[$k] = (float) $dims[$k];
                    }
                }
                $merged['dims'][$cid] = $clean;
            }
        }
        $writeOk = $writeOk && (
            file_put_contents($root . '/page.json',
                json_encode($merged, $opts) . "\n") !== false
        );
    }

    // Site-wide palette (v4 canonical location).
    if (is_array($palette)) {
        $sharedDir = $kirby->root('content') . '/_shared';
        if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) {
            return ['ok' => false, 'error' => 'Could not create _shared directory.', 'code' => 500];
        }
        $writeOk = $writeOk && (
            file_put_contents($sharedDir . '/palette.json',
                json_encode($palette, $opts) . "\n") !== false
        );
    }

    if (!$writeOk) {
        return ['ok' => false, 'error' => 'Failed to write files.', 'code' => 500];
    }

    // Sync S3: bump this page's _sync sidecar. Reached only on the
    // success path — failed validation / write returns above don't
    // get here, so the sidecar timestamp reliably means "this page
    // WAS modified at this time" rather than "someone tried to save
    // and failed."
    sync_bump_page($pageId);

    return ['ok' => true];
}

/**
 * Layout (rect-block) layer save (former dev/page/save body).
 *
 * $body keys: page (string, required), schemaVersion (1|2|3, required),
 *   chapters (array, required), rects (array, required). Validates the
 *   full shape, normalises, and writes content/<pageId>/rects.json
 *   atomically (always as schemaVersion 3).
 */
function deco_save_layout(array $body): array
{
    $kirby = kirby();

    $pageId        = $body['page']          ?? null;
    $schemaVersion = $body['schemaVersion'] ?? null;
    $chapters      = $body['chapters']      ?? null;
    $rects         = $body['rects']         ?? null;

    $fail = function (string $msg, int $code = 400): array {
        return ['ok' => false, 'error' => $msg, 'code' => $code];
    };

    if (!is_string($pageId) || $pageId === ''
        || !is_int($schemaVersion)
        || ($schemaVersion !== 1 && $schemaVersion !== 2 && $schemaVersion !== 3)
        || !is_array($chapters) || !is_array($rects)) {
        return $fail('Missing or invalid body fields.');
    }

    $targetPage = $kirby->page($pageId);
    if (!$targetPage) {
        return $fail('Unknown page: ' . $pageId, 404);
    }

    // Validate chapters. id is a lowercase slug; name is the
    // same Unicode-tolerant pattern dev/draw/save uses for
    // snapshot names so apostrophes / accents / parens all
    // work for chapter labels.
    $chapterIds = [];
    foreach ($chapters as $ch) {
        if (!is_array($ch)
            || !isset($ch['id'])   || !is_string($ch['id'])
            || !preg_match('/^[a-z0-9_-]+$/i', $ch['id'])
            || !isset($ch['name']) || !is_string($ch['name'])
            || !preg_match('/^[\p{L}\p{N} _.,\'()\[\]\-]+$/u', $ch['name'])) {
            return $fail('Invalid chapter entry.');
        }
        if (isset($chapterIds[$ch['id']])) {
            return $fail('Duplicate chapter id: ' . $ch['id']);
        }
        $chapterIds[$ch['id']] = true;
    }

    // Validate rects.
    // Convergence Slice 2: 'deco-mount' retired (dead affordance, no
    // distinct rendering). The editor coerces any stray deco-mount
    // rect → 'text' at read time, so a saved payload never carries it;
    // narrowing the validator here closes the back door (a direct POST
    // of a deco-mount rect is now rejected). Not a schema bump — kind
    // is a tolerated free string on read, so old data still parses.
    $allowedKinds = ['text', 'image', 'drilldown'];
    $rectIds      = [];
    foreach ($rects as $r) {
        if (!is_array($r)) return $fail('Rect entry is not an object.');
        if (!isset($r['id']) || !is_string($r['id'])
            || !preg_match('/^r-[a-z0-9]+$/', $r['id'])) {
            return $fail('Invalid rect id.');
        }
        if (isset($rectIds[$r['id']])) {
            return $fail('Duplicate rect id: ' . $r['id']);
        }
        $rectIds[$r['id']] = true;
        if (!isset($r['kind']) || !in_array($r['kind'], $allowedKinds, true)) {
            return $fail('Invalid rect kind: ' . ($r['kind'] ?? 'null'));
        }
        foreach (['x', 'y', 'w', 'h'] as $k) {
            if (!isset($r[$k]) || !is_numeric($r[$k])) {
                return $fail('Rect ' . $r['id'] . ' missing/invalid ' . $k);
            }
        }
        if (isset($r['chapterId']) && $r['chapterId'] !== null) {
            if (!is_string($r['chapterId']) || !isset($chapterIds[$r['chapterId']])) {
                return $fail('Rect references unknown chapter: ' . $r['chapterId']);
            }
        }
        // v0.10.24: optional `note` field — short author-only label
        // surfaced in the editor for navigability. Plain string, no
        // markup, capped at 120 chars. Null/missing both fine.
        if (isset($r['note']) && $r['note'] !== null) {
            if (!is_string($r['note'])) {
                return $fail('Rect note must be a string or null.');
            }
            if (mb_strlen($r['note']) > 120) {
                return $fail('Rect note exceeds 120 characters.');
            }
        }
        // v0.10.46 (schema 3): optional `image` field — the bound
        // image's bare filename, resolved at runtime against the
        // page's `images/` child. Format-only validation: must be a
        // filename (no path separators, no `..`), ≤255 chars, so the
        // runtime resolver can never be steered outside the library
        // dir. Existence is NOT checked — a binding may legitimately
        // dangle if the file is later renamed/removed (the runtime
        // degrades gracefully); the editor's library refresh surfaces
        // the mismatch. Allowed on any kind for forward-compat (the
        // editor only sets it on image rects).
        if (isset($r['image']) && $r['image'] !== null) {
            if (!is_string($r['image'])) {
                return $fail('Rect image must be a string or null.');
            }
            if (mb_strlen($r['image']) > 255
                || strpos($r['image'], '/')  !== false
                || strpos($r['image'], '\\') !== false
                || strpos($r['image'], '..') !== false) {
                return $fail('Rect image must be a bare filename.');
            }
        }
        // v0.10.47: optional `fit` field — how a bound image fills
        // its rect when their aspect ratios differ. 'cover' (default,
        // fill+crop) or 'contain' (fit+letterbox). Additive with a
        // behaviour-preserving default, so NOT a schema bump: a v3
        // file without `fit` renders exactly as before. Anything other
        // than the two allowed values is rejected (rather than
        // silently coerced) so a typo surfaces instead of masking.
        if (isset($r['fit']) && $r['fit'] !== null) {
            if ($r['fit'] !== 'cover' && $r['fit'] !== 'contain') {
                return $fail("Rect fit must be 'cover' or 'contain'.");
            }
        }
        // v0.10.50: optional `focusX`/`focusY` (image object-position,
        // 0–100). Additive within schema v3 with a behaviour-preserving
        // default of 50 (centred), so NOT a schema bump. Reject out-of-
        // range / non-numeric values so a bug surfaces rather than
        // silently clamping to an unexpected crop.
        foreach (['focusX', 'focusY'] as $fk) {
            if (isset($r[$fk]) && $r[$fk] !== null) {
                if (!is_numeric($r[$fk]) || $r[$fk] < 0 || $r[$fk] > 100) {
                    return $fail("Rect $fk must be a number in 0..100.");
                }
            }
        }
        // v0.10.75 (Slice 3a): optional `typographyId` — the id of a
        // typography token (content/_shared/typography-tokens.json) a
        // text rect renders with. Additive within schema v3 with a
        // null default, so NOT a schema bump. FORMAT-only validation
        // (slug chars, ≤64): existence is intentionally NOT checked so
        // a ref may dangle if a token is later deleted — the runtime
        // degrades to inherited defaults, exactly like a dangling image
        // binding. Allowed on any kind for forward-compat (the editor
        // only sets it on text rects).
        if (isset($r['typographyId']) && $r['typographyId'] !== null) {
            if (!is_string($r['typographyId'])
                || !preg_match('/^[a-z0-9_-]+$/i', $r['typographyId'])
                || mb_strlen($r['typographyId']) > 64) {
                return $fail('Rect typographyId must be a token slug or null.');
            }
        }
        // v0.10.82 (Slice T1): optional `text` field — plain-text body
        // content for a text rect (textarea-authored, multiline). Stored
        // verbatim (whitespace/newlines preserved); the runtime renders
        // it with white-space:pre-wrap and HTML-escapes it. No markup is
        // interpreted at this slice — rich/styled runs are a separately-
        // parked discussion. FORMAT-only validation: must be a string,
        // capped at 5000 chars so a runaway paste can't bloat rects.json.
        // Additive within schema v3 with a null default (typographyId
        // precedent), so NOT a schema bump. Allowed on any kind for
        // forward-compat (the editor only sets it on text rects).
        if (isset($r['text']) && $r['text'] !== null) {
            if (!is_string($r['text'])) {
                return $fail('Rect text must be a string or null.');
            }
            if (mb_strlen($r['text']) > 5000) {
                return $fail('Rect text exceeds 5000 characters.');
            }
        }
        // v0.10.91 (Slice TS1): optional `marks` field — atomic text-style
        // ranges over the rect's `text`. Shape per element:
        //   { start:int, end:int, attr:string, value:(true|string) }
        // over the half-open interval [start,end). The editor's mark
        // engine always emits NORMALIZED, in-bounds marks; this is a
        // defensive SHAPE-only gate (a hand-edited or stale rects.json
        // can't inject garbage). Like `typographyId`, attr-registry
        // membership is intentionally NOT enforced — an unknown attr
        // simply maps to no CSS class at render and degrades gracefully.
        // Additive within schema v3 with a [] default → NOT a schema bump.
        // Bounds use mb_strlen on the (already validated) text; a marks
        // array on a rect with no/empty text is rejected since there are
        // no valid offsets to anchor to.
        if (isset($r['marks']) && $r['marks'] !== null && $r['marks'] !== []) {
            if (!is_array($r['marks']) || array_keys($r['marks']) !== range(0, count($r['marks']) - 1)) {
                return $fail('Rect marks must be a JSON array.');
            }
            $textLen = (isset($r['text']) && is_string($r['text'])) ? mb_strlen($r['text']) : 0;
            if (count($r['marks']) > 1000) {
                return $fail('Rect marks exceeds 1000 entries.');
            }
            foreach ($r['marks'] as $m) {
                if (!is_array($m)
                    || !isset($m['start'], $m['end'], $m['attr'])
                    || !array_key_exists('value', $m)) {
                    return $fail('Rect mark must have start, end, attr, value.');
                }
                if (!is_int($m['start']) || !is_int($m['end'])
                    || $m['start'] < 0 || $m['start'] >= $m['end'] || $m['end'] > $textLen) {
                    return $fail('Rect mark range must satisfy 0 <= start < end <= text length.');
                }
                // Attr is a code-controlled axis identifier, not user
                // content. Most are lowercase slugs (strong/em/underline/
                // color/link); `elementStyle` is camelCase — so the body
                // allows [a-zA-Z0-9_-]. First char stays lowercase. DO NOT
                // narrow this back to strictly-lowercase: the camelCase
                // `elementStyle` mark axis depends on it (this same pattern
                // originally landed for the retired TS4 `charStyle` axis,
                // removed in Slice D — but elementStyle now relies on it).
                if (!is_string($m['attr'])
                    || !preg_match('/^[a-z][a-zA-Z0-9_-]{0,31}$/', $m['attr'])) {
                    return $fail('Rect mark attr must be a slug starting lowercase (1..32 chars).');
                }
                $mv = $m['value'];
                if ($mv !== true && !(is_string($mv) && mb_strlen($mv) <= 256)) {
                    return $fail('Rect mark value must be true or a string (<=256 chars).');
                }
                // v0.10.99 (TS3-b-2): link href governance at SAVE time. The
                // runtime renderer already applies the same allowlist via
                // deco_safe_href (render-time defence-in-depth), but enforcing
                // it here too means a forged save body can never persist a
                // javascript:/data:/etc. link into rects.json in the first
                // place. The editor only ever emits string hrefs for `link`.
                if ($m['attr'] === 'link') {
                    $safe = function_exists('deco_safe_href') ? deco_safe_href($mv) : null;
                    if (!is_string($mv) || $safe === null) {
                        return $fail('Rect link mark value must be a safe URL '
                            . '(relative, #anchor, or http(s)/mailto/tel).');
                    }
                }
            }
        }
    }

    // Normalise on write: ensure each rect carries an explicit
    // `note` key (null when unset) and a `chapterId` key (null
    // when unset). Editor and runtime both tolerate missing keys
    // — explicit nulls just make grepping a saved rects.json
    // unambiguous.
    $normRects = array_map(function ($r) {
        $r['chapterId'] = $r['chapterId'] ?? null;
        $r['note']      = (isset($r['note']) && $r['note'] !== '') ? $r['note'] : null;
        $r['image']     = (isset($r['image']) && $r['image'] !== '') ? $r['image'] : null;
        $r['fit']       = (isset($r['fit']) && $r['fit'] === 'contain') ? 'contain' : 'cover';
        // v0.10.50: image focus — clamp to int 0..100, default 50.
        foreach (['focusX', 'focusY'] as $fk) {
            $fv = $r[$fk] ?? 50;
            $fv = is_numeric($fv) ? (int) round((float) $fv) : 50;
            $r[$fk] = max(0, min(100, $fv));
        }
        // v0.10.75: typography token ref — empty string normalises to
        // null so the on-disk shape is unambiguous (null vs "").
        $r['typographyId'] = (isset($r['typographyId']) && $r['typographyId'] !== '')
            ? $r['typographyId'] : null;
        // v0.10.82 (Slice T1): text body — empty/whitespace-only string
        // normalises to null so an "empty" text rect stores no key value
        // (and the runtime falls back to its stub). Whitespace WITHIN
        // non-empty content is preserved verbatim; only a wholly-blank
        // value collapses to null.
        $r['text'] = (isset($r['text']) && is_string($r['text']) && trim($r['text']) !== '')
            ? $r['text'] : null;
        // v0.10.91 (Slice TS1): marks — re-index to a clean JSON array
        // (array_values strips any non-sequential keys), and force [] when
        // the rect ended up with no text (no offsets to anchor to). The
        // engine already normalizes/sorts client-side; this only fixes the
        // on-disk shape to an unambiguous list.
        $r['marks'] = ($r['text'] !== null && isset($r['marks']) && is_array($r['marks']))
            ? array_values($r['marks']) : [];
        return $r;
    }, $rects);

    // Persist. Atomic write so a half-written file can never be
    // read by the next editor load. schemaVersion always written
    // as 3 (current); v1/v2 inputs are accepted but upgraded on
    // first save (v2→3 adds the optional per-rect `image` binding).
    $payload = [
        'schemaVersion' => 3,
        'chapters'      => $chapters,
        'rects'         => $normRects,
    ];
    $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

    $root   = $targetPage->root();
    $target = $root . '/rects.json';
    $tmp    = $target . '.tmp';
    if (file_put_contents($tmp, $json) === false || !rename($tmp, $target)) {
        @unlink($tmp);
        return $fail('Failed to write rects.json.', 500);
    }

    // Sync S3: bump this page's _sync sidecar on success path.
    sync_bump_page($pageId);

    return ['ok' => true];
}
