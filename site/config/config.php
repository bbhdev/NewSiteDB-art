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
