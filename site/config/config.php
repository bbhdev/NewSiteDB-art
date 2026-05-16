<?php

return [
  /*
   * Routes for the /dev/draw editor.
   *
   *   POST /dev/draw/save  — persists groups + lines for a given page
   *                          to content/<page>/groups.json + lines.json.
   *                          Body: { page: "home", groups: [...], lines: [...] }
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
