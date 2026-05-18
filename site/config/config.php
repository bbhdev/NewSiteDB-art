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
   *   POST /dev/draw/save  — persists per-class groups + lines for a
   *                          given (page, classId) into
   *                          content/<page>/<classId>/{groups,lines}.json,
   *                          the per-page nested drawing config to
   *                          page.json, and the site-wide palette to
   *                          content/colors.json.
   *                          Body: { page, classId, groups, lines, palette?, pageCfg? }
   */
  'routes' => [
    [
      'pattern' => 'dev/draw/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        $pageId  = $body['page']    ?? null;
        $classId = $body['classId'] ?? null;  // which class's lines/groups we're writing
        $groups  = $body['groups']  ?? null;
        $lines   = $body['lines']   ?? null;
        $palette = $body['palette'] ?? null;  // optional — site-wide
        $pageCfg = $body['pageCfg'] ?? null;  // optional — nested page config

        if (!is_string($pageId) || !is_string($classId) || $classId === ''
            || !is_array($groups) || !is_array($lines)
            || !preg_match('/^[a-z0-9_-]+$/i', $classId)) {
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

        // Per-class files: lines + groups for the class being edited.
        // The classId is validated above to match [a-z0-9_-]+; reject
        // anything outside that to avoid escaping into parent dirs.
        $classDir = $root . '/' . $classId;
        if (!is_dir($classDir) && !mkdir($classDir, 0755, true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Could not create class dir: ' . $classId]),
            'application/json', 500
          );
        }
        $writeOk = (
          file_put_contents($classDir . '/groups.json', json_encode($groups, $opts) . "\n") !== false &&
          file_put_contents($classDir . '/lines.json',  json_encode($lines,  $opts) . "\n") !== false
        );

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

        // Site-wide file: the design palette is shared across pages, so
        // it lives at the content root rather than under any one page.
        if (is_array($palette)) {
          $writeOk = $writeOk && (
            file_put_contents($kirby->root('content') . '/colors.json',
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
