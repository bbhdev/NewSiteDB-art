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
