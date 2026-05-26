<?php

return [
  /*
   * App version (semver). Read from the /VERSION file at the repo
   * root. Used as a cache-busting query string on every CSS/JS asset
   * include so a bump invalidates the browser cache automatically.
   * The patch number bumps on every commit; major / minor are author-
   * controlled.
   */
  'version' => trim(@file_get_contents(__DIR__ . '/../../VERSION')) ?: 'dev',

  /*
   * Schema version (integer). Bumped manually when the on-disk
   * content/ shape changes in a way that older snapshots can't be
   * loaded into. Read once here; used by the snapshot library so a
   * snapshot taken at schema=N refuses to load on schema=N+1.
   */
  'schemaVersion' => (int)(trim(@file_get_contents(__DIR__ . '/../../SCHEMA_VERSION')) ?: '1'),

  /*
   * Routes for the /dev/draw editor.
   *
   *   POST /dev/draw/save  — persists, atomically per save, every
   *                          class's groups + instances for the target
   *                          page (so unsaved edits to a non-active
   *                          class can't be lost when the editor
   *                          switches class), the site-wide masters
   *                          file, the per-page nested drawing config
   *                          to page.json, and the site-wide palette
   *                          to _shared/palette.json.
   *                          Body: {
   *                            page, masters?, palette?, pageCfg?,
   *                            byClass: { <classId>: { instances, groups } }
   *                          }
   */
  'routes' => [
    /*
     * Snapshot library — local backup/restore of content/.
     *
     *   GET  dev/draw/library/list   → { ok, schemaVersion, snapshots: [...] }
     *   POST dev/draw/library/save   body { name } — copy content/ → library/<name>/content/
     *   POST dev/draw/library/load   body { name } — refuse on schema mismatch, else
     *                                                replace content/ from library/<name>/content/
     *
     * Snapshot folder layout:
     *   library/<name>/meta.json     { savedAt, appVersion, schemaVersion }
     *   library/<name>/content/      recursive copy of content/
     *
     * Names are validated against [A-Za-z0-9 _.-]{1,80} so a payload can't
     * escape into a parent directory or shell-confuse the FS.
     */
    [
      'pattern' => 'dev/draw/library/list',
      'method'  => 'GET',
      'action'  => function () {
        $libRoot = realpath(__DIR__ . '/../../library') ?: (__DIR__ . '/../../library');
        $out = [];
        if (is_dir($libRoot)) {
          $entries = scandir($libRoot);
          if ($entries === false) $entries = [];
          foreach ($entries as $e) {
            if ($e === '.' || $e === '..' || $e[0] === '.') continue;
            $p = $libRoot . '/' . $e;
            if (!is_dir($p)) continue;
            $meta = [];
            $metaPath = $p . '/meta.json';
            if (is_file($metaPath)) {
              $meta = json_decode(@file_get_contents($metaPath), true) ?: [];
            }
            $out[] = [
              'name'           => $e,
              'savedAt'        => $meta['savedAt']        ?? null,
              'appVersion'     => $meta['appVersion']     ?? null,
              'schemaVersion'  => $meta['schemaVersion']  ?? null
            ];
          }
          usort($out, function ($a, $b) {
            return strcmp((string)($b['savedAt'] ?? ''), (string)($a['savedAt'] ?? ''));
          });
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'schemaVersion' => option('schemaVersion'), 'snapshots' => $out]),
          'application/json'
        );
      }
    ],
    [
      'pattern' => 'dev/draw/library/save',
      'method'  => 'POST',
      'action'  => function () {
        $body = kirby()->request()->body()->toArray();
        $name = isset($body['name']) ? trim((string)$body['name']) : '';
        if (!preg_match('/^[A-Za-z0-9 _.\-]{1,80}$/', $name)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Invalid snapshot name. Use letters, digits, space, underscore, dot, or hyphen (1–80 chars).']),
            'application/json', 400
          );
        }
        $libRoot = __DIR__ . '/../../library';
        if (!is_dir($libRoot) && !mkdir($libRoot, 0755, true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Could not create library/ directory.']),
            'application/json', 500
          );
        }
        $dest = $libRoot . '/' . $name;
        if (is_dir($dest)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'A snapshot with that name already exists.']),
            'application/json', 409
          );
        }
        $contentSrc  = kirby()->root('content');
        $contentDest = $dest . '/content';
        if (!mkdir($contentDest, 0755, true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Could not create snapshot directory.']),
            'application/json', 500
          );
        }
        // Recursive copy — content/ is small (JSON + .txt), simple
        // iteration is fine. Skip dotfiles so .DS_Store and friends
        // don't pollute the snapshot.
        $copy = function ($srcDir, $dstDir) use (&$copy) {
          if (!is_dir($dstDir) && !mkdir($dstDir, 0755, true)) return false;
          $items = scandir($srcDir);
          if ($items === false) return false;
          foreach ($items as $it) {
            if ($it === '.' || $it === '..' || $it[0] === '.') continue;
            $s = $srcDir . '/' . $it;
            $d = $dstDir . '/' . $it;
            if (is_dir($s)) {
              if (!$copy($s, $d)) return false;
            } else if (is_file($s)) {
              if (copy($s, $d) === false) return false;
            }
          }
          return true;
        };
        if (!$copy($contentSrc, $contentDest)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Failed to copy content into snapshot.']),
            'application/json', 500
          );
        }
        $meta = [
          'name'           => $name,
          'savedAt'        => date('c'),
          'appVersion'     => option('version'),
          'schemaVersion'  => option('schemaVersion')
        ];
        @file_put_contents($dest . '/meta.json',
          json_encode($meta, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'snapshot' => $meta]),
          'application/json'
        );
      }
    ],
    [
      'pattern' => 'dev/draw/library/load',
      'method'  => 'POST',
      'action'  => function () {
        $body = kirby()->request()->body()->toArray();
        $name = isset($body['name']) ? trim((string)$body['name']) : '';
        if (!preg_match('/^[A-Za-z0-9 _.\-]{1,80}$/', $name)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Invalid snapshot name.']),
            'application/json', 400
          );
        }
        $libRoot = __DIR__ . '/../../library';
        $src     = $libRoot . '/' . $name;
        if (!is_dir($src) || !is_dir($src . '/content')) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Snapshot not found.']),
            'application/json', 404
          );
        }
        $meta = is_file($src . '/meta.json')
          ? (json_decode(file_get_contents($src . '/meta.json'), true) ?: [])
          : [];
        $snapSchema = isset($meta['schemaVersion']) ? (int)$meta['schemaVersion'] : 0;
        $curSchema  = (int) option('schemaVersion');
        if ($snapSchema !== $curSchema) {
          return new Kirby\Http\Response(
            json_encode([
              'ok' => false,
              'error' => 'Schema mismatch: snapshot=' . $snapSchema . ', current=' . $curSchema
                . '. Refusing to load — bumping SCHEMA_VERSION is your signal that the data shape changed.'
            ]),
            'application/json', 409
          );
        }
        $contentRoot = kirby()->root('content');
        // Wipe the current content/ then copy the snapshot's content/
        // over it. Wipe + copy (rather than rsync-style merge) so a
        // snapshot taken before a file existed actually reverts to
        // "no such file". Dotfiles in the live content/ (e.g. .git
        // artifacts in dev setups) are left in place.
        $wipe = function ($dir) use (&$wipe) {
          if (!is_dir($dir)) return true;
          $items = scandir($dir);
          if ($items === false) return false;
          foreach ($items as $it) {
            if ($it === '.' || $it === '..' || $it[0] === '.') continue;
            $p = $dir . '/' . $it;
            if (is_dir($p)) {
              if (!$wipe($p)) return false;
              @rmdir($p);
            } else {
              if (@unlink($p) === false) return false;
            }
          }
          return true;
        };
        $copy = function ($srcDir, $dstDir) use (&$copy) {
          if (!is_dir($dstDir) && !mkdir($dstDir, 0755, true)) return false;
          $items = scandir($srcDir);
          if ($items === false) return false;
          foreach ($items as $it) {
            if ($it === '.' || $it === '..' || $it[0] === '.') continue;
            $s = $srcDir . '/' . $it;
            $d = $dstDir . '/' . $it;
            if (is_dir($s)) {
              if (!$copy($s, $d)) return false;
            } else if (is_file($s)) {
              if (copy($s, $d) === false) return false;
            }
          }
          return true;
        };
        if (!$wipe($contentRoot) || !$copy($src . '/content', $contentRoot)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Failed to restore content from snapshot.']),
            'application/json', 500
          );
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'restored' => $meta]),
          'application/json'
        );
      }
    ],
    /*
     * Font-bundle bookmarklet generator page (Slice 2a-2, v0.8.200).
     *
     * Returns a small HTML page with:
     *   • a draggable <a href="javascript:..."> bookmarklet whose
     *     payload is assets/js/fonts-bookmarklet.js wrapped in an IIFE
     *     with ENDPOINT baked in (this site's /dev/draw/font-bundle URL,
     *     derived from the current request so it works for any host:port).
     *   • a snapshot of the bundle currently on disk (loaded via the
     *     GET endpoint in the same response — no second round-trip).
     *   • instructions for the install-once / re-clickable workflow.
     *
     * The user can revisit this page any number of times to re-install
     * the bookmarklet in different browsers / after a reset; it's
     * stable across visits (the endpoint URL is the only baked-in
     * value, derived from the request).
     */
    [
      'pattern' => 'dev/draw/fonts-bundle',
      'method'  => 'GET',
      'action'  => function () {
        $src = @file_get_contents(__DIR__ . '/../../assets/js/fonts-bookmarklet.js');
        if ($src === false) {
          return new Kirby\Http\Response(
            '<h1>fonts-bookmarklet.js missing</h1>', 'text/html', 500
          );
        }
        // Derive this site's base URL from the request so the bookmarklet
        // POSTs back to the exact host:port that served the page.
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        if (!empty($_SERVER['REQUEST_SCHEME'])) $scheme = $_SERVER['REQUEST_SCHEME'];
        $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
        $endpoint = $scheme . '://' . $host . '/dev/draw/font-bundle';

        // Wrap the source in a thin outer IIFE so the ENDPOINT var
        // doesn't pollute fonts.google.com's global namespace. The
        // source's own inner IIFE picks it up via closure scope.
        $payload = '(function(){var ENDPOINT=' . json_encode($endpoint) . ';' . $src . '})();';
        // Bookmarklets must be a single-line javascript: URL. Use
        // rawurlencode so spaces become %20 (not '+', which a few
        // browsers misinterpret in javascript: URLs).
        $bookmarklet = 'javascript:' . rawurlencode($payload);

        // Current bundle (file may not exist yet).
        $bundlePath = kirby()->root('content') . '/_shared/font-bundle.json';
        $fonts = [];
        $savedAt = null;
        if (is_file($bundlePath)) {
          $j = json_decode(@file_get_contents($bundlePath), true);
          if (is_array($j)) {
            if (isset($j['fonts']) && is_array($j['fonts'])) {
              $fonts = array_values(array_filter($j['fonts'], 'is_string'));
            }
            if (isset($j['savedAt'])) $savedAt = $j['savedAt'];
          }
        }

        $h = function ($s) { return htmlspecialchars($s, ENT_QUOTES, 'UTF-8'); };
        $rows = '';
        foreach ($fonts as $f) {
          $rows .= '<li style="font-family:\'' . $h($f) . '\',sans-serif;font-size:18px;line-height:1.6;">'
                 . $h($f) . '</li>';
        }
        if ($rows === '') {
          $rows = '<li style="color:#888;font-style:italic;">(empty — no bundle saved yet)</li>';
        }

        // Inject one Google Fonts <link> for the preview list so the
        // names render in their actual face. Building the family list
        // mirrors what app.js does at runtime.
        $cssFamilies = '';
        if (!empty($fonts)) {
          $parts = [];
          foreach ($fonts as $f) {
            $parts[] = 'family=' . str_replace(' ', '+', $f);
          }
          $cssFamilies = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?'
                       . $h(implode('&', $parts)) . '&display=swap">';
        }

        $bookmarkletAttr = $h($bookmarklet);
        $endpointShown = $h($endpoint);
        $savedAtShown = $savedAt ? $h($savedAt) : 'never';
        $count = count($fonts);
        $plural = $count === 1 ? '' : 's';

        $html = <<<HTML
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Font bundle curation</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
{$cssFamilies}
<style>
  body { font:14px/1.5 system-ui,-apple-system,sans-serif; max-width:720px; margin:2rem auto; padding:0 1rem; color:#222; }
  h1 { font-size:1.5rem; margin-bottom:0.25rem; }
  .subtitle { color:#666; margin-bottom:1.5rem; }
  .install { padding:1rem; background:#fff7f0; border:2px dashed #ff5500; border-radius:6px; margin-bottom:1.5rem; }
  .install a.bookmarklet { display:inline-block; padding:0.5rem 1rem; background:#ff5500; color:#fff; text-decoration:none; border-radius:4px; font-weight:600; cursor:grab; }
  .install a.bookmarklet:active { cursor:grabbing; }
  ol { padding-left:1.2rem; }
  ol li { margin:0.4rem 0; }
  .bundle { padding:1rem; background:#f7f7f7; border-radius:6px; }
  .bundle h2 { font-size:1.1rem; margin:0 0 0.5rem 0; }
  .bundle ul { list-style:disc; padding-left:1.4rem; margin:0; }
  .meta { color:#666; font-size:0.9em; margin-bottom:0.5rem; }
  code { background:#eee; padding:0.1em 0.3em; border-radius:3px; font-size:0.9em; }
</style>
</head>
<body>
<h1>Font bundle curation</h1>
<p class="subtitle">Curate Google Fonts available for text overlays on this site.</p>

<div class="install">
  <p><strong>Drag this link to your bookmarks bar:</strong></p>
  <p><a class="bookmarklet" href="{$bookmarkletAttr}">📚 Font bundle picker</a></p>
  <ol>
    <li>Drag the orange button above to your browser's bookmarks bar.</li>
    <li>Visit <a href="https://fonts.google.com" target="_blank" rel="noopener">fonts.google.com</a> and apply whichever filters you want (category, language, weights, slant…).</li>
    <li>Click the bookmark. A floating panel appears with the visible fonts auto-detected.</li>
    <li>Uncheck any you don't want, add manual entries if needed, then click <strong>Add to bundle</strong> (merge with what's saved) or <strong>Replace bundle</strong>.</li>
  </ol>
  <p class="meta">The bookmarklet posts to <code>{$endpointShown}</code>. Re-visit this page to reinstall in another browser — the bookmarklet is stable across visits.</p>
</div>

<div class="bundle">
  <h2>Current bundle <span style="color:#888;font-weight:normal;">({$count} font{$plural})</span></h2>
  <p class="meta">Last saved: {$savedAtShown}</p>
  <ul>{$rows}</ul>
</div>
</body>
</html>
HTML;
        return new Kirby\Http\Response($html, 'text/html', 200);
      }
    ],
    /*
     * Google Fonts curation bundle (Slice 2a-1, v0.8.199).
     *
     * The font-bundle lives at content/_shared/font-bundle.json and is
     * a flat list of Google Fonts family names that the site author has
     * curated as available for text overlays:
     *   { "fonts": ["Inter", "Roboto", "Playfair Display", ...] }
     *
     * Two endpoints:
     *   GET  dev/draw/font-bundle   → { ok, fonts: [...] }
     *   POST dev/draw/font-bundle   body { fonts: [...] } → writes file
     *
     * The POST endpoint must be reachable from a bookmarklet running on
     * https://fonts.google.com (Slice 2a-2). Permissive CORS for that
     * origin only; OPTIONS preflight handled.
     *
     * Family-name validation: each entry must be a non-empty string of
     * letters / digits / spaces / hyphens / apostrophes up to 64 chars
     * (covers every published Google Fonts family name). Duplicates are
     * folded; output is sorted alphabetically.
     */
    [
      'pattern' => 'dev/draw/font-bundle',
      'method'  => 'GET|POST|OPTIONS',
      'action'  => function () {
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        $corsOrigin = ($origin === 'https://fonts.google.com') ? $origin : '';
        $corsHeaders = [];
        if ($corsOrigin !== '') {
          $corsHeaders = [
            'Access-Control-Allow-Origin'  => $corsOrigin,
            'Access-Control-Allow-Methods' => 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers' => 'Content-Type',
            'Vary'                         => 'Origin',
          ];
        }

        // Preflight: respond 204 with CORS headers, no body.
        if ($method === 'OPTIONS') {
          return new Kirby\Http\Response('', 'text/plain', 204, $corsHeaders);
        }

        $sharedDir = kirby()->root('content') . '/_shared';
        $bundlePath = $sharedDir . '/font-bundle.json';

        if ($method === 'GET') {
          $fonts = [];
          if (is_file($bundlePath)) {
            $j = json_decode(@file_get_contents($bundlePath), true);
            if (is_array($j) && isset($j['fonts']) && is_array($j['fonts'])) {
              $fonts = array_values(array_filter($j['fonts'], 'is_string'));
            }
          }
          return new Kirby\Http\Response(
            json_encode(['ok' => true, 'fonts' => $fonts]),
            'application/json', 200,
            array_merge(['Content-Type' => 'application/json'], $corsHeaders)
          );
        }

        // POST: write the bundle.
        $body = kirby()->request()->body()->toArray();
        $raw = isset($body['fonts']) && is_array($body['fonts']) ? $body['fonts'] : null;
        if ($raw === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Missing or invalid "fonts" array in body.']),
            'application/json', 400,
            array_merge(['Content-Type' => 'application/json'], $corsHeaders)
          );
        }
        $clean = [];
        foreach ($raw as $name) {
          if (!is_string($name)) continue;
          $name = trim($name);
          if ($name === '') continue;
          // Letters / digits / spaces / hyphens / apostrophes; up to 64.
          // Covers every published Google Fonts family name (e.g.
          // "Playfair Display", "Caveat", "M PLUS Rounded 1c").
          if (!preg_match("/^[A-Za-z0-9 '\\-]{1,64}$/", $name)) continue;
          $clean[$name] = true;  // dedupe via key
        }
        $clean = array_keys($clean);
        sort($clean, SORT_STRING | SORT_FLAG_CASE);

        if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Could not create _shared directory.']),
            'application/json', 500,
            array_merge(['Content-Type' => 'application/json'], $corsHeaders)
          );
        }
        $payload = [
          'fonts'    => $clean,
          'savedAt'  => date('c'),
          'count'    => count($clean),
        ];
        $ok = @file_put_contents(
          $bundlePath,
          json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        );
        if ($ok === false) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Failed to write font-bundle.json.']),
            'application/json', 500,
            array_merge(['Content-Type' => 'application/json'], $corsHeaders)
          );
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'fonts' => $clean, 'count' => count($clean)]),
          'application/json', 200,
          array_merge(['Content-Type' => 'application/json'], $corsHeaders)
        );
      }
    ],
    [
      'pattern' => 'dev/draw/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        $pageId  = $body['page']    ?? null;
        $byClass = $body['byClass'] ?? null;  // map of classId → { instances, groups }
        $masters = $body['masters'] ?? null;  // optional — site-wide visual definitions
        $palette = $body['palette'] ?? null;  // optional — site-wide
        $pageCfg = $body['pageCfg'] ?? null;  // optional — nested page config

        if (!is_string($pageId) || !is_array($byClass) || !$byClass) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Missing or invalid body fields.']),
            'application/json',
            400
          );
        }

        $page = $kirby->page($pageId);
        if (!$page) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Unknown page: ' . $pageId]),
            'application/json',
            404
          );
        }

        $root = $page->root();
        $opts = JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES;

        // Per-class files: instances + groups for every class in the
        // payload. Each classId is validated against [a-z0-9_-]+ so a
        // malicious payload can't escape into parent directories.
        $writeOk = true;
        foreach ($byClass as $classId => $cls) {
          if (!is_string($classId) || !preg_match('/^[a-z0-9_-]+$/i', $classId)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Invalid classId: ' . $classId]),
              'application/json', 400
            );
          }
          if (!is_array($cls) || !isset($cls['instances']) || !isset($cls['groups'])
              || !is_array($cls['instances']) || !is_array($cls['groups'])) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Class ' . $classId . ' missing instances/groups arrays']),
              'application/json', 400
            );
          }
          $classDir = $root . '/' . $classId;
          if (!is_dir($classDir) && !mkdir($classDir, 0755, true)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Could not create class dir: ' . $classId]),
              'application/json', 500
            );
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
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Could not create _shared directory.']),
              'application/json', 500
            );
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
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Could not create _shared directory.']),
              'application/json', 500
            );
          }
          $writeOk = $writeOk && (
            file_put_contents($sharedDir . '/palette.json',
              json_encode($palette, $opts) . "\n") !== false
          );
        }

        if (!$writeOk) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Failed to write files.']),
            'application/json',
            500
          );
        }

        return new Kirby\Http\Response(
          json_encode(['ok' => true]),
          'application/json'
        );
      }
    ]
  ]
];
