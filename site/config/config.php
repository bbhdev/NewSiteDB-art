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
   *   POST /dev/draw/save  — persists groups + lines for a given page
   *                          to content/<page>/groups.json + lines.json,
   *                          the per-page drawing config (page area +
   *                          canvas dimensions) to page.json, and the
   *                          site-wide palette to content/colors.json.
   *                          Body: { page, groups, lines, palette?, pageCfg? }
   */
  'routes' => [
    [
      'pattern' => 'dev/draw/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        $pageId  = $body['page']    ?? null;
        $groups  = $body['groups']  ?? null;
        $lines   = $body['lines']   ?? null;
        $palette = $body['palette'] ?? null;  // optional — site-wide
        $pageCfg = $body['pageCfg'] ?? null;  // optional — per-page drawing dims

        if (!is_string($pageId) || !is_array($groups) || !is_array($lines)) {
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

        // Per-page files: lines + groups go alongside the page content.
        $writeOk = (
          file_put_contents($root . '/groups.json', json_encode($groups, $opts) . "\n") !== false &&
          file_put_contents($root . '/lines.json',  json_encode($lines,  $opts) . "\n") !== false
        );

        // Per-page drawing config: page area + canvas dimensions. Only
        // the four known dim keys are written; the _schemaVersion field
        // on disk is preserved (managed by the migrator, not the editor).
        if (is_array($pageCfg)) {
          $existing = is_file($root . '/page.json')
            ? (json_decode(file_get_contents($root . '/page.json'), true) ?: [])
            : [];
          $merged = $existing;
          foreach (['pageW', 'pageH', 'canvasW', 'canvasH'] as $k) {
            if (isset($pageCfg[$k]) && is_numeric($pageCfg[$k]) && $pageCfg[$k] > 0) {
              $merged[$k] = (float) $pageCfg[$k];
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
