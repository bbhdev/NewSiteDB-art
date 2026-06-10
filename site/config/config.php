<?php

/**
 * Read the OpenType `name` table from a TTF/OTF file and return the
 * Typographic Family name (nameID 16) or, failing that, the Family
 * name (nameID 1). Returns null on parse failure.
 *
 * Minimal parser — reads the SFNT directory, locates the `name` table,
 * iterates its records, and prefers Windows-Unicode-English (3/1/0x409)
 * then Macintosh-Roman-English (1/0/0). UTF-16BE strings are decoded
 * to UTF-8; ASCII (Mac Roman) is returned as-is.
 *
 * Spec refs: OpenType `name` table — Apple TT spec & OpenType 1.9.
 * Used by dev/draw/local-fonts to surface real family names in the
 * font picker.
 */
function parseOpenTypeFamilyName(string $path): ?string {
  $fh = @fopen($path, 'rb');
  if (!$fh) return null;
  try {
    $head = fread($fh, 12);
    if (strlen($head) < 12) return null;
    $sfnt = substr($head, 0, 4);
    // 0x00010000 (TTF), 'OTTO' (OTF), 'true' (legacy TTF), 'typ1' (legacy).
    $okSig = ($sfnt === "\x00\x01\x00\x00" || $sfnt === 'OTTO'
              || $sfnt === 'true' || $sfnt === 'typ1');
    if (!$okSig) return null;
    $u = unpack('nnumTables', substr($head, 4, 2));
    $numTables = $u['numTables'];

    // Locate `name` table in the SFNT directory.
    $nameOffset = null;
    for ($i = 0; $i < $numTables; $i++) {
      $rec = fread($fh, 16);
      if (strlen($rec) < 16) return null;
      $tag = substr($rec, 0, 4);
      if ($tag === 'name') {
        $p = unpack('Nchecksum/Noffset/Nlength', substr($rec, 4, 12));
        $nameOffset = $p['offset'];
        $nameLength = $p['length'];
        break;
      }
    }
    if ($nameOffset === null) return null;

    if (fseek($fh, $nameOffset) !== 0) return null;
    $hdr = fread($fh, 6);
    if (strlen($hdr) < 6) return null;
    $p = unpack('nformat/ncount/nstringOffset', $hdr);
    $count = $p['count'];
    $stringStorage = $nameOffset + $p['stringOffset'];

    // Read all records; pick the best candidate by (nameID, platform).
    // Preference: nameID 16 (Typographic Family) > nameID 1 (Family);
    // within each, Windows-Unicode-English > Mac-Roman-English > first.
    $candidates = [];  // [nameID => [platformKey => entry]]
    for ($i = 0; $i < $count; $i++) {
      $rec = fread($fh, 12);
      if (strlen($rec) < 12) return null;
      $r = unpack(
        'nplatformID/nencodingID/nlanguageID/nnameID/nlength/noffset', $rec
      );
      if ($r['nameID'] !== 1 && $r['nameID'] !== 16) continue;
      // Platform priority key (lower is better).
      $key = 99;
      if ($r['platformID'] === 3 && $r['encodingID'] === 1
          && $r['languageID'] === 0x0409) $key = 0;  // Win, Unicode BMP, en-US
      elseif ($r['platformID'] === 3 && $r['encodingID'] === 1) $key = 1;  // Win, Unicode BMP
      elseif ($r['platformID'] === 1 && $r['encodingID'] === 0
              && $r['languageID'] === 0)  $key = 2;  // Mac, Roman, en
      elseif ($r['platformID'] === 0)     $key = 3;  // Unicode
      $candidates[$r['nameID']][$key] = $r;
    }
    if (empty($candidates)) return null;

    $order = isset($candidates[16]) ? [16, 1] : [1];
    foreach ($order as $nid) {
      if (!isset($candidates[$nid])) continue;
      ksort($candidates[$nid]);
      foreach ($candidates[$nid] as $key => $r) {
        if (fseek($fh, $stringStorage + $r['offset']) !== 0) continue;
        $raw = fread($fh, $r['length']);
        if ($raw === false || $raw === '') continue;
        // Decode: Windows + Unicode = UTF-16BE; Mac Roman ~ ASCII for
        // Latin family names; Unicode platform = UTF-16BE.
        if ($r['platformID'] === 3 || $r['platformID'] === 0) {
          $s = @mb_convert_encoding($raw, 'UTF-8', 'UTF-16BE');
        } else {
          $s = $raw;  // Mac Roman; ASCII subset is fine for our use
        }
        $s = trim((string)$s);
        if ($s !== '') return $s;
      }
    }
    return null;
  } finally {
    fclose($fh);
  }
}

/*
 * Sync secret — read from gitignored sidecar (Slice S4a, v0.10.149).
 *
 * The shared bearer-token secret used by all /sync/* endpoints lives
 * in a per-node sidecar file (site/config/sync.secret.php) that is:
 *   - listed in .gitignore (never tracked)
 *   - listed in deploy/deploy-exclude.txt (never rsync'd)
 * which means it must be provisioned on each node manually (sftp).
 * The sidecar's shape is dead-simple — a single PHP file returning
 * the secret string: `<?php return 'real-secret-value';`
 *
 * Behavior when the file is missing or unreadable:
 *   @include returns false → $syncSecret stays null → the 'secret'
 *   option below is null → sync_authorize_request() returns 503
 *   "sync not configured" on every /sync/* hit. Safe default — fail
 *   closed, not open.
 *
 * Why a sidecar and not env vars: Infomaniak shared hosting makes
 * env-var setup fragile across PHP version changes. A plain
 * gitignored PHP file works on every host, can be inspected without
 * an admin panel, and gets file-system permissions (chmod 600) for
 * defense in depth.
 *
 * Rotation: change the value in the sidecar on all three nodes
 * simultaneously (or accept a window of broken sync until the laggards
 * catch up). No code change required — config.php just re-reads on
 * every request.
 */
$syncSecret = @include __DIR__ . '/sync.secret.php';
if (!is_string($syncSecret) || $syncSecret === '') {
    $syncSecret = null;
}

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
   * Thumb engine quality (v0.10.29 — Phase 2 Slice 2 step 3).
   *
   * Kirby defaults to JPEG quality 90 for thumbs. 82 is the
   * empirically established sweet spot for web photography (close
   * to visually identical at typical viewing sizes, ~25% smaller
   * file). Phase 2's image-rect runtime will request thumbs at
   * exact rect display dimensions (and per-rect dpr for retina);
   * a single quality knob applied here keeps every derived size
   * consistent without per-call configuration. Bump back to 88–90
   * if banding appears on gradient-heavy photos.
   */
  'thumbs' => [
    'quality' => 82,
  ],

  /*
   * Sync layer — node identity + shared-secret auth (v0.10.140, Slice S1).
   *
   * The forthcoming content-sync layer (per topology memory:
   * sync-layer-topology-and-operations.md) treats this project's three
   * runtime nodes as named participants:
   *
   *   L  = local Mac (this code path when SERVER_NAME doesn't match a
   *        host-scoped override; the desktop dev environment).
   *   A  = newsitedbart.bbh.fr — STAGING. Host-scoped config overrides
   *        `role` to 'A' there.
   *   B  = danielbondard.fr — PUBLIC, frozen by default. Host-scoped
   *        config overrides `role` to 'B' there.
   *
   * This block is the DEFAULT — role='L'. Host-scoped configs
   * (config.<SERVER_NAME>.php, rsync-excluded) override these values
   * per environment. Kirby merges host config OVER base via
   * array_replace_recursive, so a host-scoped override may set just
   * the differing keys (role, host) and inherit the rest.
   *
   * Slice S1 SCOPE: this block + the /sync/whoami route that
   * reads it. No actual content sync yet — those slices follow.
   *
   * SECRET — read from gitignored sidecar (S4a, v0.10.149/150).
   *   The actual value lives in site/config/sync.secret.php which is
   *   gitignored AND rsync-excluded; see the $syncSecret block at the
   *   top of this file for full rationale. The 'secret' key below
   *   pulls from that variable. Missing sidecar → secret is null →
   *   503 from /sync/*. As of v0.10.150 (S4a.3) the sidecar holds a
   *   real `openssl rand -hex 32` secret, the same value on all three
   *   nodes. The original S1 placeholder is retired — present only in
   *   pre-S4a commit history (which is acceptable because it never
   *   gated anything sensitive). Future rotations are a config-only
   *   change: replace the value in the sidecar on every node at the
   *   same time; no code change, no version bump required.
   *
   * AUTH MODEL — single shared bearer token across L, A, B.
   *   All sync endpoints require `Authorization: Bearer <secret>`
   *   matching `option('sync.secret')`. One token everywhere keeps
   *   S1–S3 simple; per-pair secrets are a future refinement if
   *   security review warrants it.
   *
   * ROUTE NAMESPACE — top-level /sync/* (NOT /dev/sync/* or /api/sync/*).
   *   Two constraints squeeze the choice:
   *   (a) The host-scoped 403 gate (config.<HOST>.php) blocks every
   *       /dev/* path that lacks a Panel session. Sync endpoints are
   *       machine-to-machine and bearer-authed, so /dev/sync/* is out.
   *   (b) Kirby RESERVES /api/* for its own internal API router. A
   *       custom route at api/sync/whoami never reaches us — Kirby's
   *       API router strips the prefix and 404s on "sync/whoami". So
   *       /api/sync/* is out too.
   *   Top-level /sync/* sidesteps both: outside the gate, outside
   *   Kirby's API router.
   */
  'sync' => [
    'role'   => 'L',
    'host'   => 'localhost',
    'secret' => $syncSecret,
    'peers'  => [
      // L's only peer is A (staging). L pushes to A; never receives.
      'A' => 'https://newsitedbart.bbh.fr',
    ],
  ],

  /*
   * Panel left-sidebar menu (v0.10.39 — Phase 2 nav cleanup).
   *
   * Replaces the former dashboard info-section ("Dev tools") with
   * proper sidebar entries — the standard place for navigation in the
   * Panel. We list the default core areas first (site / languages /
   * users / system; languages is silently skipped on single-language
   * installs), then a separator, then the three dev-tool links.
   *
   * Kirby's native sidebar menu is a FLAT list of <k-button>s and
   * <hr> separators (see kirby/src/Panel/Menu.php) — it has no
   * concept of a titled sub-group. A literal "DEV" heading row would
   * require overriding the Panel's Vue menu component, which is
   * fragile across Kirby updates. The separator delineates the dev
   * group instead; the entries use the same button component as the
   * core areas, so the visual style matches exactly.
   *
   * Links are built as absolute site URLs (with host) so the Panel
   * SPA treats them as external and does a normal same-tab navigation
   * to the front-end dev tool. Each tool carries a "‹ Panel" link
   * back (see draw.php / page.php / image-workshop.php), closing the
   * loop without piling up browser tabs.
   */
  'panel' => [
    'menu' => function ($kirby) {
      $base = $kirby->url();
      return [
        'site',
        'languages',
        'users',
        'system',
        '-',
        // Convergence Slice 1c: one unified Editor entry. The former
        // separate "Draw editor" / "Page editor" links collapsed into
        // this single entry — /dev/editor opens in the last-used mode
        // (localStorage) or Lines by default; the in-app toggle switches
        // Lines/Layout. (Old /dev/draw + /dev/page still 302 here.)
        'dev-editor' => [
          'label' => 'Editor',
          'icon'  => 'edit',
          'link'  => $base . '/dev/editor',
        ],
        'dev-image-workshop' => [
          'label' => 'Image workshop',
          'icon'  => 'images',
          'link'  => $base . '/dev/image-workshop',
        ],
      ];
    },
  ],

  /*
   * Hooks (v0.10.29 — Phase 2 Slice 2 step 3).
   *
   * 1) page.create:after — when a canvas-page is created in Panel,
   *    auto-create its 'images' child page (blueprint:
   *    image-container). This guarantees every canvas-page has a
   *    well-known per-page image-library subdirectory at
   *    content/<page>/images/ without the author having to remember
   *    to add it. The canvas editor's bind-image picker (Slice 2
   *    step 4) reads files from this child via /api/page-images/...
   *
   * 2) file.update:after — when an author sets the optional
   *    `maxLongEdge` field on an image and saves, perform a one-
   *    time downscale on the source file in place, then clear the
   *    field so the resize doesn't recur. The architectural model
   *    is preserve-originals-derive-lazily — this hook is the
   *    explicit opt-out for the rare case where a 24MP source is
   *    overkill and capping it permanently is the right call.
   *    Implemented via the same GD/Imagick path Kirby's thumb
   *    engine uses (via $file->thumb + replacement); safer than
   *    hand-rolling image processing here.
   */
  'hooks' => [
    'page.create:after' => function ($page) {
      // Only auto-provision on canvas-page. Other blueprints are
      // unaffected. Use intendedTemplate() so we see the slot the
      // author chose in Panel even before any save flushes.
      if ($page->intendedTemplate()->name() !== 'canvas-page') {
        return;
      }
      // Guard against double-creation if the hook re-fires (e.g.
      // duplicate page workflows).
      if ($page->find('images')) {
        return;
      }
      try {
        Kirby\Cms\Page::create([
          'parent'   => $page,
          'slug'     => 'images',
          'template' => 'image-container',
          'content'  => [
            'title' => 'Image library',
          ],
        ]);
      } catch (\Throwable $e) {
        // Don't fail the parent page creation if the child can't
        // be made (e.g. permissions). The author can create the
        // child manually with the same blueprint as a fallback.
      }
    },

    'file.update:after' => function ($newFile, $oldFile) {
      // Only act on files using the 'image' blueprint, and only
      // when maxLongEdge has just been set to a positive integer.
      if ($newFile->template() !== 'image') {
        return;
      }
      $max = (int) $newFile->maxLongEdge()->value();
      if ($max < 200) {
        return;
      }
      // Compute the current long edge. If already at or below the
      // cap, just clear the field and exit — no resize needed.
      $dims = $newFile->dimensions();
      $longEdge = max((int) $dims->width(), (int) $dims->height());
      if ($longEdge <= $max) {
        try {
          $newFile->update(['maxLongEdge' => null]);
        } catch (\Throwable $e) { /* swallow */ }
        return;
      }
      try {
        // Generate a downscaled copy at the requested long edge, then
        // overwrite the original with its bytes. resize($max, $max)
        // fits the image inside a $max-square box: the long edge binds
        // and the short edge scales proportionally, no cropping —
        // orientation-agnostic, identical to the Panel preview link
        // (image.yml previewInfo) so what the author inspected is
        // exactly what gets committed. Verified against Kirby's
        // Dimensions::fitWidthAndHeight (no crop unless 'crop' set).
        $thumb     = $newFile->resize($max, $max);
        $thumbRoot = $thumb->root();
        if ($thumbRoot && is_file($thumbRoot)) {
          // Atomic replace: copy thumb bytes over the source.
          $srcRoot = $newFile->root();
          $tmp     = $srcRoot . '.tmp';
          if (copy($thumbRoot, $tmp) && rename($tmp, $srcRoot)) {
            // Clear the cap field so re-saving doesn't re-resize.
            $newFile->update(['maxLongEdge' => null]);
          } else {
            @unlink($tmp);
          }
        }
      } catch (\Throwable $e) {
        // Swallow — the author still has the original; they can
        // retry. Don't break the Panel update flow.
      }
    },
  ],

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
     * Convergence Slice 1c — hard redirect of the old editor surfaces
     * to the unified /dev/editor. /dev/draw and /dev/page no longer
     * serve their own templates; they bounce (302) to /dev/editor with
     * the matching mode preselected, preserving the ?page= target.
     *
     * Patterns are EXACT (no trailing wildcard) so only the bare editor
     * URLs redirect — the sub-routes (dev/draw/save, dev/draw/library/*,
     * dev/page/save, dev/page/upload-image, …) keep their own handlers
     * below. Kirby matches routes in array order, but an exact pattern
     * can't shadow a longer one, so placing these first is safe.
     *
     * The draw.php / page.php templates are now dead (nothing routes to
     * them); they're pending deletion in Slice 6 alongside the JS
     * consolidation. The content/dev/draw and content/dev/page pages
     * stay on disk for now — harmless, and removing them is a separate
     * tidy-up.
     */
    [
      'pattern' => 'dev/draw',
      'action'  => function () {
        $p = get('page');
        $q = (is_string($p) && $p !== '')
            ? '?mode=lines&page=' . urlencode($p)
            : '?mode=lines';
        go('dev/editor' . $q);
      },
    ],
    [
      'pattern' => 'dev/page',
      'action'  => function () {
        $p = get('page');
        $q = (is_string($p) && $p !== '')
            ? '?mode=layout&page=' . urlencode($p)
            : '?mode=layout';
        go('dev/editor' . $q);
      },
    ],

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
        // v0.8.319: snapshot names accept any Unicode letter / digit,
        // plus a generous set of safe punctuation (space, dash,
        // underscore, dot, comma, parens, brackets, apostrophe). The
        // previous ASCII-only regex barred accented letters and
        // common punctuation for no real reason — the constraint
        // exists only because the name becomes a directory name on
        // disk, so we just need to bar the characters real
        // filesystems reject + the path-traversal / hidden-file
        // shapes. Length cap 1..80 retained.
        $bad =
             $name === ''
          || mb_strlen($name) > 80
          || $name === '.' || $name === '..'
          || $name[0] === '.'                              // hidden dir
          || strpos($name, '..') !== false                 // path traversal
          || preg_match('#[\\\\/:\*\?"<>\|\x00-\x1f]#', $name) === 1
          || preg_match('/^[\p{L}\p{N} _.,\'()\[\]\-]+$/u', $name) !== 1;
        if ($bad) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Invalid snapshot name. Letters (any script), digits, spaces and . , - _ \' ( ) [ ] are allowed (1–80 chars). Cannot start with a dot or contain "..".']),
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
        // v0.8.319: mirror the save endpoint's loosened validation —
        // any Unicode letter/digit + safe punctuation, with
        // path-traversal / hidden-file guards. Keep identical to
        // /save so a name accepted on write stays valid on read.
        $bad =
             $name === ''
          || mb_strlen($name) > 80
          || $name === '.' || $name === '..'
          || $name[0] === '.'
          || strpos($name, '..') !== false
          || preg_match('#[\\\\/:\*\?"<>\|\x00-\x1f]#', $name) === 1
          || preg_match('/^[\p{L}\p{N} _.,\'()\[\]\-]+$/u', $name) !== 1;
        if ($bad) {
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
        //
        // EXCEPTION (v0.10.156): the top-level `dev/` and `error/`
        // subtrees are code-side scaffolding (editor route records +
        // Kirby's required error page), NOT content data. They live
        // in git, ride with deploy.sh, and must survive a snapshot
        // load even if the snapshot pre-dates their existence. Mirror
        // the same exclusion list that deploy/deploy-exclude-content.txt
        // uses ('+ /content/dev/' and '+ /content/error/' allow-list)
        // and sync_manifest_excluded_prefixes (['dev', 'error']). The
        // exclusion applies ONLY at the content root — a hypothetical
        // page named 'dev' nested inside another page would still wipe
        // normally (recursion passes an empty exclude list).
        $wipe = function ($dir, $excludeNames = []) use (&$wipe) {
          if (!is_dir($dir)) return true;
          $items = scandir($dir);
          if ($items === false) return false;
          foreach ($items as $it) {
            if ($it === '.' || $it === '..' || $it[0] === '.') continue;
            if (in_array($it, $excludeNames, true)) continue;
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
        if (!$wipe($contentRoot, ['dev', 'error']) || !$copy($src . '/content', $contentRoot)) {
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
  .install a.external { display:inline-block; padding:0.5rem 1rem; background:#fff; color:#ff5500; text-decoration:none; border:2px solid #ff5500; border-radius:4px; font-weight:600; }
  .install a.external:hover { background:#fff7f0; }
  .install button.copy { padding:0.5rem 1rem; background:#fff; color:#222; border:1px solid #aaa; border-radius:4px; font:inherit; font-weight:600; cursor:pointer; }
  .install button.copy:hover { background:#f6f6f6; }
  .install ul.methods { padding-left:1.2rem; margin:0.5rem 0 1rem; }
  .install ul.methods li { margin:0.25rem 0; }
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
  <p><strong>Step 1 — get the bookmarklet onto your bookmarks bar.</strong> Try the easiest method your browser allows:</p>
  <p style="display:flex;gap:0.5rem;flex-wrap:wrap;align-items:center;">
    <a class="bookmarklet" href="{$bookmarkletAttr}">📚 Font bundle picker</a>
    <button class="copy" id="copy-bookmarklet" type="button">📋 Copy bookmarklet URL</button>
    <span id="copy-status" style="color:#666;font-size:0.85em;"></span>
  </p>
  <ul class="methods">
    <li><strong>Drag</strong> the orange button to your bookmarks bar (works in some browsers, not all).</li>
    <li><strong>Right-click</strong> the orange button → <em>Bookmark this link</em> / <em>Add to favorites</em>.</li>
    <li><strong>Copy & paste</strong>: click the Copy button above, then in your browser open <em>Bookmark Manager → Add bookmark</em> and paste into the URL field (name it whatever you like).</li>
  </ul>
  <p><strong>Step 2 — use it.</strong></p>
  <p><a class="external" href="https://fonts.google.com/" target="_blank" rel="noopener">↗ Open Google Fonts</a></p>
  <ol>
    <li>On the Google Fonts tab, apply whichever filters you want (category, language, weights, slant…).</li>
    <li>Click the bookmark <em>on that tab</em>. A floating panel appears with the visible fonts auto-detected.</li>
    <li>Uncheck any you don't want, add manual entries if needed, then click <strong>Add to bundle</strong> (merge with what's saved) or <strong>Replace bundle</strong>.</li>
  </ol>
  <p class="meta">Clicking the orange button on <em>this</em> page just runs the bookmarklet here (no fonts to scan — useful only as a sanity check that the panel appears). The bookmark only works while on the Google Fonts tab.</p>
  <p class="meta">The bookmarklet posts to <code>{$endpointShown}</code>. Re-visit this page to reinstall in another browser — the bookmarklet is stable across visits.</p>
</div>
<script>
(function(){
  var btn = document.getElementById('copy-bookmarklet');
  var status = document.getElementById('copy-status');
  var bm = document.querySelector('a.bookmarklet');
  if (!btn || !status || !bm) return;
  btn.addEventListener('click', function(){
    var url = bm.getAttribute('href');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function(){
        status.textContent = 'Copied — paste into a new bookmark\'s URL field.';
      }, function(){
        fallback();
      });
    } else {
      fallback();
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); status.textContent = 'Copied.'; }
      catch (e) { status.textContent = 'Copy failed — select the URL from the bookmarklet link manually.'; }
      document.body.removeChild(ta);
    }
  });
})();
</script>

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
    /*
     * Local fonts directory scan (Slice 3-1, v0.8.214).
     *
     * Companion to font-bundle.json (which lists Google Fonts families).
     * This endpoint scans assets/fonts/local/*.{otf,ttf,woff,woff2} and
     * returns, for each file, the embedded family name read from the
     * OpenType `name` table — so the editor / runtime can emit @font-face
     * declarations and surface the family in the same picker the bundle
     * populates.
     *
     *   GET dev/draw/local-fonts → { ok, fonts: [{file, family, format}] }
     *
     * Parser scope: native TTF (0x00010000) and OTF ('OTTO') are parsed
     * directly. WOFF and WOFF2 fall back to a filename-derived family
     * name with a warning flag — parsing those requires zlib/brotli
     * decompression that isn't justified for an internal dev tool.
     * If the family name in the OTF/TTF is wrong, rename the file or
     * use the regenerated OTF; we don't expose a manual-name override
     * because the file is the source of truth.
     */
    [
      'pattern' => 'dev/draw/local-fonts',
      'method'  => 'GET',
      'action'  => function () {
        $dir = kirby()->root('index') . '/assets/fonts/local';
        $hdrs = ['Content-Type' => 'application/json'];
        if (!is_dir($dir)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => true, 'fonts' => []]),
            'application/json', 200, $hdrs
          );
        }
        $exts = ['otf', 'ttf', 'woff', 'woff2'];
        $out = [];
        foreach (scandir($dir) as $name) {
          if ($name === '.' || $name === '..' || $name[0] === '.') continue;
          $path = $dir . '/' . $name;
          if (!is_file($path)) continue;
          $ext = strtolower(pathinfo($name, PATHINFO_EXTENSION));
          if (!in_array($ext, $exts, true)) continue;

          $family = null;
          $parsed = false;
          if ($ext === 'otf' || $ext === 'ttf') {
            $family = parseOpenTypeFamilyName($path);
            $parsed = $family !== null;
          }
          if ($family === null) {
            // Filename fallback: strip extension, normalize separators.
            $base = pathinfo($name, PATHINFO_FILENAME);
            $family = trim(preg_replace('/[-_]+/', ' ', $base));
          }
          $out[] = [
            'file'   => $name,
            'family' => $family,
            'format' => $ext,
            'parsed' => $parsed,
          ];
        }
        // Stable order by family name (case-insensitive).
        usort($out, function ($a, $b) {
          return strcasecmp($a['family'], $b['family']);
        });

        // v0.8.218: also persist the result as a static manifest.json
        // in the same directory. The runtime (app.js) reads this file
        // directly so deployed/static hosts without the /dev/draw/*
        // routes still resolve local fonts. Atomic write via tmp+rename
        // so a concurrent GET never sees a half-written file. Failures
        // are non-fatal — the endpoint still returns the live list.
        $manifest = [
          'fonts'      => $out,
          'generatedAt'=> date('c'),
          'count'      => count($out),
        ];
        $manifestPath = $dir . '/manifest.json';
        $tmpPath = $manifestPath . '.tmp';
        $bytes = json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        if (@file_put_contents($tmpPath, $bytes) !== false) {
          @rename($tmpPath, $manifestPath);
        }

        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'fonts' => $out]),
          'application/json', 200, $hdrs
        );
      }
    ],
    /*
     * Typography tokens (Slice 3b-1, v0.10.76).
     *
     * Site-wide named type styles, stored at
     * content/_shared/typography-tokens.json with shape
     *   { schemaVersion, tokens: [ {id,name,family,sizePx,weight,
     *     lineHeight,letterSpacingPx,italic}, ... ], savedAt, count }
     * — the same _shared pattern as palette.json / font-bundle.json.
     * Authored in the draw editor (this route is its persistence layer);
     * read everywhere via deco_load_typography() and emitted as CSS via
     * deco_typography_css() (Slice 3a).
     *
     *   GET  dev/draw/typography → { ok, tokens: [...] }
     *   POST dev/draw/typography   body { tokens: [...] } → writes file
     *
     * Validation is format-only and matches the CSS emitter's sanitiser:
     * id  : ^[a-z0-9_-]{1,64}$  (also the rect typographyId contract);
     *       duplicates rejected (CSS classes would collide).
     * name: non-empty, Unicode-tolerant, ≤64 (same set as chapter names).
     * family: '' or [A-Za-z0-9 '_-], ≤64 (empty → falls back to sans-serif).
     * numerics are CLAMPED, not rejected (sizePx 1–400, weight 100–900,
     * lineHeight 0.5–4, letterSpacingPx -20–50); italic coerced to bool.
     * Token-ref integrity (rects pointing at a token) is intentionally
     * NOT enforced here — refs may dangle and degrade gracefully.
     */
    [
      'pattern' => 'dev/draw/typography',
      'method'  => 'GET|POST',
      'action'  => function () {
        $method     = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $hdrs       = ['Content-Type' => 'application/json'];
        $sharedDir  = kirby()->root('content') . '/_shared';
        $tokensPath = $sharedDir . '/typography-tokens.json';

        if ($method === 'GET') {
          $tokens = deco_load_typography(kirby()->root('content'));
          return new Kirby\Http\Response(
            json_encode(['ok' => true, 'tokens' => $tokens]),
            'application/json', 200, $hdrs
          );
        }

        // POST: validate + write.
        $body = kirby()->request()->body()->toArray();
        $raw  = isset($body['tokens']) && is_array($body['tokens']) ? $body['tokens'] : null;
        if ($raw === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Missing or invalid "tokens" array in body.']),
            'application/json', 400, $hdrs
          );
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
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Each token must be an object.']),
              'application/json', 400, $hdrs
            );
          }
          $id = isset($t['id']) ? (string) $t['id'] : '';
          if (!preg_match('/^[a-z0-9_-]{1,64}$/', $id)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Invalid token id: "' . $id . '" (lowercase a-z, 0-9, _ or -, 1-64 chars).']),
              'application/json', 400, $hdrs
            );
          }
          if (isset($seenIds[$id])) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Duplicate token id: "' . $id . '".']),
              'application/json', 400, $hdrs
            );
          }
          $seenIds[$id] = true;

          $name = isset($t['name']) ? trim((string) $t['name']) : '';
          if ($name === '' || mb_strlen($name) > 64 || !preg_match("/^[\p{L}\p{N} _.,'()\[\]\\-]+$/u", $name)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Invalid token name for "' . $id . '".']),
              'application/json', 400, $hdrs
            );
          }

          $family = isset($t['family']) ? trim((string) $t['family']) : '';
          if ($family !== '' && !preg_match("/^[A-Za-z0-9 '_-]{1,64}$/", $family)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Invalid font family for "' . $id . '".']),
              'application/json', 400, $hdrs
            );
          }

          // Colour: optional palette-ID reference. Empty/absent → null
          // (inherit). Format-only check (matches the palette id contract);
          // membership is NOT enforced — a dangling ref degrades gracefully
          // (no colour emitted → inherit), like a dangling typographyId.
          $colorRaw = isset($t['color']) ? trim((string) $t['color']) : '';
          if ($colorRaw !== '' && !preg_match('/^[a-z0-9_-]{1,64}$/', $colorRaw)) {
            return new Kirby\Http\Response(
              json_encode(['ok' => false, 'error' => 'Invalid colour ref for "' . $id . '" (palette id: lowercase a-z, 0-9, _ or -).']),
              'application/json', 400, $hdrs
            );
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

        // Totality (A2): the one-layer model forbids an "undefined style", so
        // the registry must be non-empty and declare EXACTLY ONE default, and
        // that default must carry a concrete colour (it is the root fallback —
        // it can't itself inherit). These are governance contracts; the panel
        // UI upholds them, so a violation here means a hand-edited / buggy POST.
        if (count($clean) === 0) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'At least one element style is required (there is no “undefined style”).']),
            'application/json', 400, $hdrs
          );
        }
        $defaults = array_values(array_filter($clean, function ($t) { return $t['isDefault']; }));
        if (count($defaults) === 0) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'One element style must be marked as the default.']),
            'application/json', 400, $hdrs
          );
        }
        if (count($defaults) > 1) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Only one element style can be the default.']),
            'application/json', 400, $hdrs
          );
        }
        if ($defaults[0]['color'] === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'The default style “' . $defaults[0]['name'] . '” must have a colour (it is the root fallback and cannot inherit).']),
            'application/json', 400, $hdrs
          );
        }

        if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Could not create _shared directory.']),
            'application/json', 500, $hdrs
          );
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
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Failed to write typography-tokens.json.']),
            'application/json', 500, $hdrs
          );
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'tokens' => $clean, 'count' => count($clean)]),
          'application/json', 200, $hdrs
        );
      }
    ],

    /**
     * Cross-page element-style usage audit (Slice 3b).
     *
     *   GET dev/draw/typography/usage → {
     *     ok, scannedPages, textRects, defaultId, nullRefCount,
     *     tokens:   { <id>: { name, isDefault, explicit, viaDefault,
     *                         orphan, objects: [{page,rect,note}] } },
     *     dangling: [ {page, rect, typographyId, note} ],
     *     orphans:  [ <id>, … ]
     *   }
     *
     * Walks every PUBLISHED page (kirby()->site()->index() — drafts excluded,
     * matching the sync manifest) and reads its rects.json. Counts, per token:
     *   - explicit  : text rects whose typographyId === <id> (resolvable);
     *   - viaDefault: for the default token only, text rects with a null/empty
     *                 typographyId (they resolve to the default at render time).
     * A text rect whose typographyId points at a non-existent token is DANGLING
     * (degrades to the default at render — see effectiveStyleId in dev-page.js —
     * but worth surfacing so the author can fix or delete it).
     * A token is an ORPHAN when explicit === 0 AND it isn't the default
     * absorbing null refs (default + viaDefault>0 is genuinely in use).
     *
     * Read-only; no side effects. Inherits the host-scoped panel-auth gate
     * like the sibling dev/draw routes.
     */
    [
      'pattern' => 'dev/draw/typography/usage',
      'method'  => 'GET',
      'action'  => function () {
        $hdrs   = ['Content-Type' => 'application/json'];
        $tokens = deco_load_typography(kirby()->root('content'));

        // Index tokens by id; find the default.
        $byId      = [];
        $defaultId = null;
        foreach ($tokens as $t) {
          $id = $t['id'] ?? null;
          if (!is_string($id) || $id === '') continue;
          $byId[$id] = [
            'name'       => $t['name'] ?? $id,
            'isDefault'  => !empty($t['isDefault']),
            'explicit'   => 0,
            'viaDefault' => 0,
            'orphan'     => false,
            'objects'    => [],
          ];
          if (!empty($t['isDefault'])) $defaultId = $id;
        }

        $scannedPages = 0;
        $textRects    = 0;
        $nullRefCount = 0;
        $dangling     = [];

        foreach (kirby()->site()->index() as $p) {
          $rectsPath = $p->root() . '/rects.json';
          if (!is_file($rectsPath)) continue;
          $data = json_decode(@file_get_contents($rectsPath), true);
          if (!is_array($data) || !isset($data['rects']) || !is_array($data['rects'])) continue;
          $scannedPages++;
          $pageId = $p->id();
          foreach ($data['rects'] as $r) {
            if (!is_array($r)) continue;
            if (($r['kind'] ?? null) !== 'text') continue;   // only text rects carry typography
            $textRects++;
            $tid  = $r['typographyId'] ?? null;
            $note = isset($r['note']) ? (string) $r['note'] : '';
            $rid  = isset($r['id'])   ? (string) $r['id']   : '';
            if ($tid === null || $tid === '') {
              // Resolves to the default style at render time.
              $nullRefCount++;
              if ($defaultId !== null) $byId[$defaultId]['viaDefault']++;
              continue;
            }
            $tid = (string) $tid;
            if (isset($byId[$tid])) {
              $byId[$tid]['explicit']++;
              $byId[$tid]['objects'][] = ['page' => $pageId, 'rect' => $rid, 'note' => $note];
            } else {
              $dangling[] = ['page' => $pageId, 'rect' => $rid, 'typographyId' => $tid, 'note' => $note];
            }
          }
        }

        // Derive orphans: explicit==0 and not the default absorbing null refs.
        $orphans = [];
        foreach ($byId as $id => &$row) {
          $isOrphan = ($row['explicit'] === 0)
                    && !($row['isDefault'] && $row['viaDefault'] > 0);
          $row['orphan'] = $isOrphan;
          if ($isOrphan) $orphans[] = $id;
        }
        unset($row);

        return new Kirby\Http\Response(
          json_encode([
            'ok'           => true,
            'scannedPages' => $scannedPages,
            'textRects'    => $textRects,
            'defaultId'    => $defaultId,
            'nullRefCount' => $nullRefCount,
            'tokens'       => $byId,
            'dangling'     => $dangling,
            'orphans'      => $orphans,
          ]),
          'application/json', 200, $hdrs
        );
      }
    ],

    [
      'pattern' => 'dev/draw/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        // Sync S2: record local authoring activity + fire-and-forget
        // ping to upstream peer (L→A in the current topology). Best-
        // effort — see sync plugin for the no-throw contract. Done at
        // entry rather than gated on success: a clicked Save IS author
        // activity even when validation fails, and gating would require
        // threading the call through every return path in this handler.
        sync_record_activity_and_notify();

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

        // Sync S3: bump this page's _sync sidecar. Reached only on
        // the success path — failed validation / write returns above
        // don't get here, so the sidecar timestamp reliably means
        // "this page WAS modified at this time" rather than "someone
        // tried to save and failed."
        sync_bump_page($pageId);

        return new Kirby\Http\Response(
          json_encode(['ok' => true]),
          'application/json'
        );
      }
    ],

    /*
     * Phase 2 / Slice 1 / step 3 (v0.10.18) — persist a target page's
     * rect-block layout.
     *
     *   POST dev/page/save
     *   body: { page, schemaVersion, chapters, rects }
     *
     * Validates the full shape before writing. Atomic write to
     * content/<pageId>/rects.json via tmp + rename so a torn save
     * never leaves a half-JSON file on disk. The page itself is
     * resolved via kirby()->page() — same affordance as dev/draw/save.
     *
     * Canvas dimensions are NOT in this payload (see HANDOFF Slice 1
     * step 1: dims come from Deco's existing per-page config).
     *
     * v0.10.24 — Slice 2 step 1: schemaVersion bumped 1 → 2 to add
     * an optional `note` field per rect (editor-only author note,
     * never rendered at runtime). Inbound schemaVersion may be 1 OR
     * 2 — v1 payloads from older editor sessions are accepted and
     * normalised on write (note defaults to null). Output is always
     * written as v2.
     */
    [
      'pattern' => 'dev/page/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        // Sync S2: see dev/draw/save for rationale on placement at entry.
        sync_record_activity_and_notify();

        $pageId        = $body['page']          ?? null;
        $schemaVersion = $body['schemaVersion'] ?? null;
        $chapters      = $body['chapters']      ?? null;
        $rects         = $body['rects']         ?? null;

        $fail = function (string $msg, int $code = 400) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => $msg]),
            'application/json',
            $code
          );
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

        return new Kirby\Http\Response(
          json_encode(['ok' => true]),
          'application/json'
        );
      }
    ],

    /**
     * v0.10.45 — Per-page image library listing (Slice 2 step 4a).
     *
     *   GET dev/page/images/(:all)
     *   → { ok, page, imagesPage, images: [ {filename, url, thumb,
     *        width, height, ratio, size, alt}, … ] }
     *
     * Read-only enumeration of the canvas-page's image library — the
     * auto-created `images` child page (image-container blueprint,
     * provisioned by the page.create:after hook). The canvas editor's
     * "Bind image…" picker (step 4b) fetches this to populate its
     * chooser; the runtime renderer (step 5) resolves a rect's bound
     * filename against the same child.
     *
     * Placed under `dev/` (NOT `/api/…` as the original slice sketch
     * had it) so it inherits the host-scoped auth gate
     * (config.<host>.php gates `dev` + `dev/`) for free — otherwise it
     * would be an unauthenticated file-enumeration surface on the
     * production-hardened site. "Integrate, don't drift."
     *
     * The `images` child is a Panel DRAFT (Page::create defaults to
     * draft), so it's resolved via childrenAndDrafts(), exactly as the
     * image-workshop batch routes resolve their draft batches — a plain
     * $page->find('images') / children()->find() would miss it.
     *
     * Thumbs are generated eagerly at 240px width to build the picker
     * grid URLs; Kirby caches them after first request (gitignored,
     * regenerable), so repeat calls are cheap.
     */
    [
      'pattern' => 'dev/page/images/(:all)',
      'method'  => 'GET',
      'action'  => function (string $pageId) {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };

        // Page ids are lowercase slugs joined by '/'. Reject anything
        // else before touching the page tree.
        if (!preg_match('~^[a-z0-9][a-z0-9/_-]*$~i', $pageId)) {
          return $json(['ok' => false, 'error' => 'Invalid page id.'], 400);
        }

        $page = $kirby->page($pageId);
        if (!$page) {
          return $json(['ok' => false, 'error' => 'Unknown page: ' . $pageId], 404);
        }

        // Resolve the per-page image library child (slug 'images').
        // It's a draft → childrenAndDrafts(). findBy('slug', …) avoids
        // having to reconstruct the full nested id.
        $imgPage = $page->childrenAndDrafts()->findBy('slug', 'images');

        $images = [];
        if ($imgPage) {
          foreach ($imgPage->images() as $f) {
            $dims = $f->dimensions();
            $w    = (int) $dims->width();
            $h    = (int) $dims->height();
            $images[] = [
              'filename' => $f->filename(),
              'url'      => $f->url(),
              // 240px-wide derivative for the picker grid. Long-edge
              // semantics aren't needed here — the picker just wants a
              // small consistent preview.
              'thumb'    => $f->thumb(['width' => 240])->url(),
              'width'    => $w,
              'height'   => $h,
              'ratio'    => $h > 0 ? round($w / $h, 4) : 0,
              'size'     => $f->niceSize(),
              'alt'      => $f->alt()->value(),
            ];
          }
        }

        return $json([
          'ok'         => true,
          'page'       => $page->id(),
          'imagesPage' => $imgPage ? $imgPage->id() : null,
          'images'     => $images,
        ]);
      }
    ],

    /**
     * Per-page image-library usage audit (Slice 4b).
     *
     *   GET dev/page/image-usage/<pageId> → {
     *     ok, page, libraryCount, imageRects,
     *     images:   { <filename>: { count, objects: [{rect,note}] } },
     *     orphans:  [ <filename>, … ],          // in library, referenced by 0 rects
     *     dangling: [ {rect, image, note}, … ]  // rect.image not in the library
     *   }
     *
     * Image refs are bare filenames resolved against the rect's OWN page
     * library (see the rects save route), so usage is page-scoped — unlike the
     * cross-page typography audit. Reads the latest saved rects.json (disk
     * truth), so it reflects in-session saves. Read-only.
     *
     * Pattern is dev/page/image-usage/… (NOT dev/page/images/usage/…) so it
     * can't be swallowed by the dev/page/images/(:all) catch-all above.
     */
    [
      'pattern' => 'dev/page/image-usage/(:all)',
      'method'  => 'GET',
      'action'  => function (string $pageId) {
        $json = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        if (!preg_match('~^[a-z0-9][a-z0-9/_-]*$~i', $pageId)) {
          return $json(['ok' => false, 'error' => 'Invalid page id.'], 400);
        }
        $page = kirby()->page($pageId);
        if (!$page) {
          return $json(['ok' => false, 'error' => 'Unknown page: ' . $pageId], 404);
        }

        // Library filenames (the page's images child, a draft).
        $imgPage = $page->childrenAndDrafts()->findBy('slug', 'images');
        $images  = [];
        if ($imgPage) {
          foreach ($imgPage->images() as $f) {
            $images[$f->filename()] = ['count' => 0, 'objects' => []];
          }
        }

        // Rects on this page.
        $rectsPath = $page->root() . '/rects.json';
        $imageRects = 0;
        $dangling   = [];
        if (is_file($rectsPath)) {
          $data = json_decode(@file_get_contents($rectsPath), true);
          if (is_array($data) && isset($data['rects']) && is_array($data['rects'])) {
            foreach ($data['rects'] as $r) {
              if (!is_array($r)) continue;
              $img = isset($r['image']) ? (string) $r['image'] : '';
              if ($img === '') continue;             // unbound rect — not a reference
              $imageRects++;
              $rid  = isset($r['id'])   ? (string) $r['id']   : '';
              $note = isset($r['note']) ? (string) $r['note'] : '';
              if (isset($images[$img])) {
                $images[$img]['count']++;
                $images[$img]['objects'][] = ['rect' => $rid, 'note' => $note];
              } else {
                $dangling[] = ['rect' => $rid, 'image' => $img, 'note' => $note];
              }
            }
          }
        }

        $orphans = [];
        foreach ($images as $fn => $row) {
          if ($row['count'] === 0) $orphans[] = $fn;
        }

        return $json([
          'ok'           => true,
          'page'         => $page->id(),
          'libraryCount' => count($images),
          'imageRects'   => $imageRects,
          'images'       => $images,
          'orphans'      => $orphans,
          'dangling'     => $dangling,
        ]);
      }
    ],

    /**
     * v0.10.54 — In-editor image upload (Slice 2, upload step).
     *
     *   POST dev/page/upload-image   (multipart/form-data)
     *   form fields: page=<canvas page id>, file=<the image>
     *   → { ok, filename }  |  { ok:false, error }
     *
     * Writes the uploaded image straight into the canvas page's
     * auto-created `images` child — the same directory a local file-drop
     * or a Panel upload lands in ("three doors, one storage") — then the
     * editor re-lists the library via the existing GET
     * dev/page/images/<id> and the new image becomes bindable, no Panel
     * round-trip.
     *
     * Raw filesystem write into $imgPage->root() (mirrors how
     * dev/page/save writes rects.json) rather than $page->createFile():
     * this route runs WITHOUT a Panel user in local dev, and createFile()'s
     * permission checks would reject it. Validation is therefore done here
     * — extension whitelist, size cap, and a getimagesize() sanity check so
     * a renamed non-image can't slip through. Filename clashes auto-rename
     * (suffix -1, -2, …) so an upload never silently overwrites an
     * already-bound image (the user's chosen clash policy).
     *
     * Under the `dev/page` prefix → inherits the host-scoped auth gate.
     */
    [
      'pattern' => 'dev/page/upload-image',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };

        $pageId = $_POST['page'] ?? null;
        if (!is_string($pageId) || !preg_match('~^[a-z0-9][a-z0-9/_-]*$~i', $pageId)) {
          return $json(['ok' => false, 'error' => 'Invalid or missing page id.'], 400);
        }

        $page = $kirby->page($pageId);
        if (!$page) {
          return $json(['ok' => false, 'error' => 'Unknown page: ' . $pageId], 404);
        }

        // The per-page image library is a draft → childrenAndDrafts().
        // It's auto-created by the page.create:after hook, but ONLY for
        // canvas-page pages. A page authored under a different template
        // (or created before the hook existed) won't have one — so we
        // lazily provision it here at the filesystem level rather than
        // erroring. Page::create would hit permission checks (this route
        // runs with no Panel user — the same reason we move_uploaded_file
        // rather than createFile below), so we mkdir the draft directly
        // and drop an image-container content file so Panel recognises it
        // as a page. A subsequent dev/page/images refetch (fresh request,
        // re-reads disk) then sees the new child.
        $imgPage = $page->childrenAndDrafts()->findBy('slug', 'images');
        if ($imgPage) {
          $dir = $imgPage->root();
        } else {
          $dir = $page->root() . '/_drafts/images';
          if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
            return $json(['ok' => false, 'error' => 'Could not create the image library.'], 500);
          }
          $containerTxt = $dir . '/image-container.txt';
          if (!file_exists($containerTxt)) {
            @file_put_contents($containerTxt, "Title: Image library\n");
          }
        }

        $file = $_FILES['file'] ?? null;
        if (!is_array($file) || !isset($file['tmp_name'])
            || ($file['error'] ?? 1) !== UPLOAD_ERR_OK) {
          return $json(['ok' => false, 'error' => 'No file uploaded, or upload failed.'], 400);
        }

        // Size cap — 25 MB.
        if (($file['size'] ?? 0) > 25 * 1024 * 1024) {
          return $json(['ok' => false, 'error' => 'File too large (max 25 MB).'], 400);
        }

        // Extension whitelist + content sanity (must decode as an image).
        $allowedExt = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
        $origName   = (string) ($file['name'] ?? '');
        $ext        = strtolower(pathinfo($origName, PATHINFO_EXTENSION));
        if (!in_array($ext, $allowedExt, true)) {
          return $json(['ok' => false, 'error' => 'Unsupported file type: .' . $ext], 400);
        }
        if (@getimagesize($file['tmp_name']) === false) {
          return $json(['ok' => false, 'error' => 'File is not a valid image.'], 400);
        }

        // Safe base name: strip path, lowercase, keep [a-z0-9_-], collapse.
        $base = strtolower(pathinfo($origName, PATHINFO_FILENAME));
        $base = preg_replace('/[^a-z0-9_-]+/', '-', $base);
        $base = trim($base, '-_');
        if ($base === '') $base = 'image';

        $filename = $base . '.' . $ext;
        // Auto-rename on clash so an existing binding is never overwritten.
        $n = 1;
        while (file_exists($dir . '/' . $filename)) {
          $filename = $base . '-' . $n . '.' . $ext;
          $n++;
        }

        $dest = $dir . '/' . $filename;
        if (!move_uploaded_file($file['tmp_name'], $dest)) {
          return $json(['ok' => false, 'error' => 'Could not write the uploaded file.'], 500);
        }

        // Optional resize-on-the-way-in (Slice 4e). The editor's direct-upload
        // flow may pass `maxLongEdge`; blank/absent → keep original. We resize
        // in place via kirby()->thumb on raw paths (no File/Page object needed,
        // which this no-Panel-user route can't reliably build for a brand-new
        // file). thumb fits the image inside a max×max box (long edge binds, no
        // crop, no upscale) — identical geometry to File::resize and the
        // maxLongEdge hook. On any failure the original stays put.
        $resizedTo = null;
        $maxRaw = $_POST['maxLongEdge'] ?? null;
        if (is_numeric($maxRaw)) {
          $max = max(200, min(8000, (int) $maxRaw));
          $info = @getimagesize($dest);
          $longEdge = $info ? max((int) $info[0], (int) $info[1]) : 0;
          if ($longEdge > $max) {
            try {
              $tmpOut = $dest . '.rsz';
              kirby()->thumb($dest, $tmpOut, ['width' => $max, 'height' => $max]);
              if (is_file($tmpOut) && rename($tmpOut, $dest)) {
                $resizedTo = $max;
              } else {
                @unlink($tmpOut);
              }
            } catch (\Throwable $e) {
              @unlink($dest . '.rsz');
              // Swallow — original remains; the upload still succeeded.
            }
          }
        }

        return $json(['ok' => true, 'filename' => $filename, 'resizedTo' => $resizedTo]);
      }
    ],

    /**
     * v0.10.35 — Image-workshop verdict persistence (Slice 2 step B).
     *
     *   POST dev/image-workshop/save
     *   body: { batch: "<batch page id>", verdicts: { "<filename>": "ok|rework|dropped", ... } }
     *
     * Stores triage verdicts for a workshop batch in a per-batch sidecar
     * content/<batch>/verdicts.json. Mirrors dev/page/save: full-shape
     * validation, atomic tmp+rename write. Batches are Panel DRAFTS, so
     * the page is resolved via the container's childrenAndDrafts() (a
     * plain kirby()->page() would miss drafts).
     *
     * The verdict map is authoritative-by-replacement: the client always
     * sends the complete current map, and entries cleared in the UI are
     * simply absent (or null) and dropped on write — so a verdicts.json
     * only ever holds files that currently carry a verdict.
     */
    [
      'pattern' => 'dev/image-workshop/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        // Sync S2: see dev/draw/save for rationale on placement at entry.
        sync_record_activity_and_notify();

        $batchId  = $body['batch']    ?? null;
        $verdicts = $body['verdicts'] ?? null;

        $fail = function (string $msg, int $code = 400) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => $msg]),
            'application/json',
            $code
          );
        };

        if (!is_string($batchId) || $batchId === '' || !is_array($verdicts)) {
          return $fail('Missing or invalid body fields.');
        }

        // Resolve the batch page, including drafts (Panel-created batches
        // start as drafts). Scope the lookup to the workshop container so
        // an arbitrary page id can't be targeted.
        $container = $kirby->page('dev/image-workshop');
        $batchPage = $container ? $container->childrenAndDrafts()->find($batchId) : null;
        if (!$batchPage || $batchPage->intendedTemplate()->name() !== 'image-workshop-batch') {
          return $fail('Unknown image-workshop batch: ' . $batchId, 404);
        }

        // Validate against the batch's actual files + the 3-value enum.
        // Drop empty/null verdicts (an "unset" in the UI).
        $allowed   = ['ok', 'rework', 'dropped'];
        $fileNames = $batchPage->files()->pluck('filename');
        $clean     = [];
        foreach ($verdicts as $fname => $verdict) {
          if (!is_string($fname)) {
            return $fail('Verdict key is not a filename string.');
          }
          if ($verdict === null || $verdict === '') {
            continue; // cleared — omit from the saved map
          }
          if (!is_string($verdict) || !in_array($verdict, $allowed, true)) {
            return $fail('Invalid verdict for ' . $fname . ': ' . (is_string($verdict) ? $verdict : gettype($verdict)));
          }
          if (!in_array($fname, $fileNames, true)) {
            return $fail('Unknown file in batch: ' . $fname);
          }
          $clean[$fname] = $verdict;
        }

        $payload = [
          'schemaVersion' => 1,
          'verdicts'      => (object) $clean, // {} not [] when empty
        ];
        $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

        $target = $batchPage->root() . '/verdicts.json';
        $tmp    = $target . '.tmp';
        if (file_put_contents($tmp, $json) === false || !rename($tmp, $target)) {
          @unlink($tmp);
          return $fail('Failed to write verdicts.json.', 500);
        }

        // Sync S3: bump the batch page's _sync sidecar. $batchPage
        // is a draft Kirby page (image-workshop batches start as
        // drafts) so kirby()->page() can't resolve it — pass the
        // root() directly to bypass the lookup. Note that
        // dev/image-workshop/* is currently excluded from the
        // manifest (sync_manifest_excluded_prefixes), so this
        // sidecar exists but is invisible to sync until S4
        // designs draft/image sync. Keeping the hook now keeps the
        // contract consistent across the three save handlers.
        sync_bump_page($batchPage->id(), $batchPage->root());

        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'count' => count($clean)]),
          'application/json'
        );
      }
    ],

    /**
     * v0.10.59 — Image-workshop "Use this" transfer (Slice 2).
     *
     *   POST dev/image-workshop/use-image
     *   body: { batch, filename, size, targetPage }
     *
     * Copies the RESIZED derivative (long-edge $size — the exact fit the
     * workshop grid shows at the current test size) of a batch image into
     * a target canvas page's `images` child library. Originals are never
     * sent (too large — the user's explicit constraint). Records the
     * transfer in a per-batch sent.json sidecar so the workshop can show,
     * per image, which page(s) it has already been sent to.
     *
     * Like upload-image, this runs with NO Panel user: we resolve + resize
     * via Kirby (read-only ops), then copy the cached derivative file raw
     * into the target library dir (lazily provisioned, identical to
     * upload-image), auto-renaming on clash. createFile would hit the
     * permission checks that no-user context fails.
     */
    [
      'pattern' => 'dev/image-workshop/use-image',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        $body  = $kirby->request()->body()->toArray();

        $batchId  = $body['batch']      ?? null;
        $filename = $body['filename']   ?? null;
        $targetId = $body['targetPage'] ?? null;
        $sizeRaw  = $body['size']       ?? null;

        if (!is_string($batchId) || $batchId === ''
            || !is_string($filename) || $filename === ''
            || !is_string($targetId) || $targetId === '') {
          return $json(['ok' => false, 'error' => 'Missing or invalid body fields.'], 400);
        }

        // Long edge. When `size` is omitted / non-numeric the source is copied
        // at ORIGINAL resolution (the editor's import panel relies on this —
        // it pulls originals and lets the page runtime resize for display).
        // A numeric `size` (the workshop's own "Use this", and later its
        // per-image long edge) resizes to that long edge, clamped to the
        // image blueprint bounds.
        $useOriginal = !is_numeric($sizeRaw);
        $size = $useOriginal ? 0 : max(200, min(8000, (int) $sizeRaw));

        // Resolve the batch (drafts included), scoped to the workshop
        // container so an arbitrary page id can't be targeted as a source.
        $container = $kirby->page('dev/image-workshop');
        $batchPage = $container ? $container->childrenAndDrafts()->find($batchId) : null;
        if (!$batchPage || $batchPage->intendedTemplate()->name() !== 'image-workshop-batch') {
          return $json(['ok' => false, 'error' => 'Unknown image-workshop batch: ' . $batchId], 404);
        }

        // The source must be an actual image file in that batch.
        $img = $batchPage->image($filename);
        if (!$img) {
          return $json(['ok' => false, 'error' => 'Unknown image in batch: ' . $filename], 404);
        }

        // Resolve + validate the target. Any real content page is a valid
        // transfer target (its image library is lazily provisioned below,
        // exactly as upload-image does) — we only exclude the system pages
        // (the /dev editor tree and the error page). NOTE: we deliberately
        // do NOT require the canvas-page template here. Project content uses
        // the `default` template; gating on canvas-page rejected every real
        // page and left the workshop's target dropdown empty.
        $target = $kirby->page($targetId);
        $tid    = $target ? $target->id() : '';
        $isSystem = $tid === 'dev' || strpos($tid, 'dev/') === 0
                 || $tid === 'error' || strpos($tid, 'error/') === 0;
        if (!$target || $isSystem) {
          return $json(['ok' => false, 'error' => 'Invalid target page: ' . $targetId], 404);
        }

        // Original → copy the source file as-is. Otherwise generate (or
        // cache-hit) the resized derivative — byte-identical to the grid.
        if ($useOriginal) {
          $srcPath = $img->root();
        } else {
          $resized = $img->resize($size, $size);
          $srcPath = $resized->root();
        }
        if (!is_string($srcPath) || !is_file($srcPath)) {
          return $json(['ok' => false, 'error' => 'Could not resolve the source image.'], 500);
        }

        // Target image library — lazily provisioned, identical to upload-image.
        $imgPage = $target->childrenAndDrafts()->findBy('slug', 'images');
        if ($imgPage) {
          $dir = $imgPage->root();
        } else {
          $dir = $target->root() . '/_drafts/images';
          if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
            return $json(['ok' => false, 'error' => 'Could not create the image library.'], 500);
          }
          $containerTxt = $dir . '/image-container.txt';
          if (!file_exists($containerTxt)) {
            @file_put_contents($containerTxt, "Title: Image library\n");
          }
        }

        // Destination name: source base + the derivative's actual extension.
        // Auto-rename on clash so a transfer never overwrites a bound image.
        $ext = strtolower(pathinfo($srcPath, PATHINFO_EXTENSION));
        if ($ext === '') $ext = strtolower($img->extension());
        $base = strtolower(pathinfo($filename, PATHINFO_FILENAME));
        $base = preg_replace('/[^a-z0-9_-]+/', '-', $base);
        $base = trim($base, '-_');
        if ($base === '') $base = 'image';

        $outName = $base . '.' . $ext;
        $n = 1;
        while (file_exists($dir . '/' . $outName)) {
          $outName = $base . '-' . $n . '.' . $ext;
          $n++;
        }

        if (!@copy($srcPath, $dir . '/' . $outName)) {
          return $json(['ok' => false, 'error' => 'Could not write the image into the target library.'], 500);
        }

        // Record the transfer in the per-batch sent.json sidecar.
        // Shape: { schemaVersion, sent: { "<filename>": [ {page,title}, ... ] } }.
        $sentPath = $batchPage->root() . '/sent.json';
        $sent = [];
        if (is_file($sentPath)) {
          $decoded = json_decode(file_get_contents($sentPath), true);
          if (is_array($decoded) && isset($decoded['sent']) && is_array($decoded['sent'])) {
            $sent = $decoded['sent'];
          }
        }
        if (!isset($sent[$filename]) || !is_array($sent[$filename])) {
          $sent[$filename] = [];
        }
        // De-dupe by page id — a repeat send to the same page adds nothing.
        $already = false;
        foreach ($sent[$filename] as $entry) {
          if (is_array($entry) && ($entry['page'] ?? null) === $target->id()) { $already = true; break; }
        }
        if (!$already) {
          $sent[$filename][] = ['page' => $target->id(), 'title' => $target->title()->value()];
        }

        $payload = ['schemaVersion' => 1, 'sent' => (object) $sent];
        $jsonStr = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        $tmp = $sentPath . '.tmp';
        if (file_put_contents($tmp, $jsonStr) === false || !rename($tmp, $sentPath)) {
          @unlink($tmp);
          // The copy already landed — report success, flag the sidecar miss.
          return $json([
            'ok' => true, 'filename' => $outName,
            'page' => $target->id(), 'title' => $target->title()->value(),
            'warning' => 'Image copied but sent.json could not be written.',
          ]);
        }

        return $json([
          'ok' => true, 'filename' => $outName,
          'page' => $target->id(), 'title' => $target->title()->value(),
        ]);
      }
    ],

    /*
     * GET dev/image-workshop/list            (Convergence Slice 4c)
     *   ?batch=<id>      — optional; when omitted, lists batches
     *   ?target=<pageId> — optional; marks images already sent to that page
     *
     * Read-only enumeration backing the editor's "Import images" sub-panel.
     * Without ?batch it returns the batch index ({id,title,isDraft,count}),
     * sorted like the workshop landing page. With ?batch it returns that
     * batch's images with a small (320px long-edge) thumbnail, the recorded
     * verdict, and — when ?target is given — whether the image has already
     * been sent to that page (read from the batch's sent.json sidecar).
     *
     * The actual transfer still goes through POST dev/image-workshop/use-image
     * at the user-chosen long-edge size; the thumb here is display-only.
     */
    [
      'pattern' => 'dev/image-workshop/list',
      'method'  => 'GET',
      'action'  => function () {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        $container = $kirby->page('dev/image-workshop');
        if (!$container) {
          return $json(['ok' => false, 'error' => 'Image workshop not found.'], 404);
        }
        $batchId  = $kirby->request()->get('batch');
        $targetId = $kirby->request()->get('target');

        // Batch index.
        if (!is_string($batchId) || $batchId === '') {
          $batches = [];
          foreach ($container->childrenAndDrafts()->sortBy('title', 'asc') as $b) {
            if ($b->intendedTemplate()->name() !== 'image-workshop-batch') continue;
            $batches[] = [
              'id'      => $b->id(),
              'title'   => $b->title()->value(),
              'isDraft' => $b->isDraft(),
              'count'   => $b->images()->count(),
            ];
          }
          return $json(['ok' => true, 'batches' => $batches]);
        }

        // Single batch — its images, with verdicts + sent-to-target flags.
        $batchPage = $container->childrenAndDrafts()->find($batchId);
        if (!$batchPage || $batchPage->intendedTemplate()->name() !== 'image-workshop-batch') {
          return $json(['ok' => false, 'error' => 'Unknown image-workshop batch: ' . $batchId], 404);
        }

        $verdicts = [];
        $vPath = $batchPage->root() . '/verdicts.json';
        if (is_file($vPath)) {
          $d = json_decode(@file_get_contents($vPath), true);
          if (is_array($d) && isset($d['verdicts']) && is_array($d['verdicts'])) $verdicts = $d['verdicts'];
        }

        // sent.json: { sent: { "<filename>": [ {page,title}, ... ] } }
        $sent = [];
        $sPath = $batchPage->root() . '/sent.json';
        if (is_file($sPath)) {
          $d = json_decode(@file_get_contents($sPath), true);
          if (is_array($d) && isset($d['sent']) && is_array($d['sent'])) $sent = $d['sent'];
        }
        $sentTo = function (string $fn) use ($sent, $targetId): bool {
          if (!is_string($targetId) || $targetId === '' || !isset($sent[$fn]) || !is_array($sent[$fn])) return false;
          foreach ($sent[$fn] as $e) { if (is_array($e) && ($e['page'] ?? null) === $targetId) return true; }
          return false;
        };

        $images = [];
        foreach ($batchPage->images()->sortBy('filename', 'asc') as $img) {
          $fn = $img->filename();
          $thumb = $img->resize(320, 320);
          $images[] = [
            'filename' => $fn,
            'thumb'    => $thumb->url(),
            'width'    => $img->width(),
            'height'   => $img->height(),
            'verdict'  => is_string($verdicts[$fn] ?? null) ? $verdicts[$fn] : '',
            'sent'     => $sentTo($fn),
          ];
        }
        return $json([
          'ok'    => true,
          'batch' => $batchPage->id(),
          'title' => $batchPage->title()->value(),
          'images'=> $images,
        ]);
      }
    ],

    /*
     * Sync layer — node identity probe (v0.10.140, Slice S1).
     *
     *   GET /sync/whoami
     *   Authorization: Bearer <sync.secret>
     *   →  200 { ok, role, host, appVersion, schemaVersion, time, peers }
     *      401 { ok:false, error:"unauthorized" }      — missing/bad token
     *      503 { ok:false, error:"sync not configured" } — option block missing
     *
     * Purpose: prove that L, A, and B each correctly identify
     * themselves under their host-scoped Kirby config. No content
     * exchange yet; the response is purely a self-description so
     * later slices (timestamp handshake, manifest diff, page sync)
     * can be layered on a verified foundation.
     *
     * Namespace choice — top-level `/sync/*`:
     *   /dev/sync/* trips the host-scoped Panel-auth 403 gate, and
     *   /api/sync/* is intercepted by Kirby's reserved API router
     *   (which 404s on unknown patterns it doesn't own). Top-level
     *   /sync/* avoids both — see the sync option block above.
     *
     * Auth: shared bearer token (see option('sync.secret')). The
     * comparison uses hash_equals to avoid leaking timing info on a
     * partial-match guess. Missing/blank Authorization → 401.
     *
     * No PII / secrets in the response: role + host + version
     * timestamps + peer URLs only. Peers are URLs (already publicly
     * known DNS names); leaking them to a token-holder is
     * acceptable since they hold the token anyway.
     */
    [
      'pattern' => 'sync/whoami',
      'method'  => 'GET',
      'action'  => function () {
        // Bearer-auth + header-extraction logic lives in the sync
        // plugin (sync_authorize_request) for DRY across whoami /
        // state / ping. See the original v0.10.140 inline version
        // in git history for the header-extraction rationale.
        if ($err = sync_authorize_request()) return $err;

        $sync = option('sync');
        return new Kirby\Http\Response(
          json_encode([
            'ok'             => true,
            'role'           => $sync['role'] ?? null,
            'host'           => $sync['host'] ?? ($_SERVER['SERVER_NAME'] ?? null),
            'appVersion'     => option('version'),
            'schemaVersion'  => option('schemaVersion'),
            'time'           => date('c'),
            'peers'          => $sync['peers'] ?? [],
          ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json'
        );
      }
    ],

    /*
     * GET /sync/state — return this node's sync state (Slice S2).
     *
     * Body: { ok, role, host, time, state: { schemaVersion,
     *   lastActivityAt, lastActivityBy, peerStamps: {L,A,B} } }
     *
     * Authoritative read for "is my peer ahead of me?" — the L editor
     * (in a later slice) will poll A's /sync/state on focus / reconnect
     * and compare A's lastActivityAt with L's lastActivityAt to
     * decide whether to show a strong reconnect alert.
     *
     * Auth: same shared-secret bearer token as whoami.
     */
    [
      'pattern' => 'sync/state',
      'method'  => 'GET',
      'action'  => function () {
        if ($err = sync_authorize_request()) return $err;
        $sync = option('sync');
        return new Kirby\Http\Response(
          json_encode([
            'ok'    => true,
            'role'  => $sync['role'] ?? null,
            'host'  => $sync['host'] ?? ($_SERVER['SERVER_NAME'] ?? null),
            'time'  => date('c'),
            'state' => sync_state_read(),
          ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json'
        );
      }
    ],

    /*
     * POST /sync/ping — receive a peer's activity timestamp (Slice S2).
     *
     * Body (JSON): { role: 'L'|'A'|'B', at: ISO-8601 string }
     *
     * Side-effect: stores peerStamps[role] = at in this node's
     * site/sync/state.json. No content sync, no manifest exchange —
     * just "peer X was authoring at time T, FYI." The pinging peer
     * uses fire-and-forget; we respond quickly and idempotently.
     *
     * Validation: role must be in {L,A,B}; `at` must be parseable by
     * strtotime() (re-stamped via date('c') for canonical storage).
     * Invalid payloads → 400 with diagnostic message.
     *
     * Auth: same shared-secret bearer token.
     */
    [
      'pattern' => 'sync/ping',
      'method'  => 'POST',
      'action'  => function () {
        if ($err = sync_authorize_request()) return $err;
        $raw  = file_get_contents('php://input');
        $body = json_decode((string)$raw, true);
        if (!is_array($body)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'invalid JSON body']),
            'application/json', 400
          );
        }
        $role = (string)($body['role'] ?? '');
        $at   = (string)($body['at']   ?? '');
        if ($role === '' || $at === '') {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'missing role or at']),
            'application/json', 400
          );
        }
        if (!sync_record_peer_stamp($role, $at)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'rejected (bad role or unparsable timestamp)']),
            'application/json', 400
          );
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'time' => date('c')]) . "\n",
          'application/json'
        );
      }
    ],

    /*
     * GET /sync/manifest — per-page _sync stamps (Slice S3).
     *
     * Returns:
     *   { ok, role, host, time, pages: [ { id, sync: {...}|null }, ... ] }
     *
     * Excludes pages under 'dev' or 'error' prefixes — see
     * sync_manifest_excluded_prefixes(). Drafts are not walked
     * (kirby's site()->index() returns published pages only); this
     * is a deliberate S3 limitation that S4 may revisit if draft
     * sync turns out to matter.
     *
     * For each page: sync = the sidecar content (schemaVersion,
     * lastModifiedAt, lastModifiedBy, lastSyncedAt) or null if the
     * page has never been saved via /dev/* post-S3. Consumers
     * interpret null as "no sync history" rather than "in sync."
     *
     * Auth: same shared-secret bearer token as the other /sync/*
     * routes.
     */
    [
      'pattern' => 'sync/manifest',
      'method'  => 'GET',
      'action'  => function () {
        if ($err = sync_authorize_request()) return $err;
        $sync = option('sync');
        return new Kirby\Http\Response(
          json_encode([
            'ok'    => true,
            'role'  => $sync['role'] ?? null,
            'host'  => $sync['host'] ?? ($_SERVER['SERVER_NAME'] ?? null),
            'time'  => date('c'),
            'pages' => sync_collect_manifest(),
          ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json'
        );
      }
    ],

    /*
     * GET /sync/peer/<role> — proxy a peer's /sync/state through this
     * node, using THIS node's stored shared secret to authenticate
     * upstream. Used by L's editor-side indicator (Slice S2b) to
     * surface A's lastActivityAt to the browser without leaking the
     * shared secret into page source and without CORS friction
     * (browser hits same origin).
     *
     * Auth: NONE on this proxy route. Rationale:
     *   - L's local PHP server binds loopback-only (`php -S` defaults
     *     to 127.0.0.1), so the route is only reachable from the
     *     same machine — the browser running the editor. No remote
     *     client can hit it, with or without auth.
     *   - Adding bearer auth here would require embedding the shared
     *     secret in page source for the JS to use, which defeats
     *     the whole point of the proxy (keeping the secret server-
     *     side).
     *   - The proxy returns READ-ONLY peer state (a few timestamps)
     *     — no write surface, no PII.
     *   - Caveat: anyone who explicitly binds the local server to a
     *     non-loopback address (e.g. `php -S 0.0.0.0:8765` for a
     *     LAN demo) takes on the responsibility to gate it
     *     themselves. The default binding is what makes this safe.
     *
     * The route is registered globally but the role-gated snippet
     * (snippets/sync-peer-indicator.php) only emits a polling call
     * on the L node, so A and B never invoke it in normal use.
     */
    [
      'pattern' => 'sync/peer/(:any)',
      'method'  => 'GET',
      'action'  => function ($role) {
        $result = sync_fetch_peer_state((string)$role);
        $status = $result['ok'] ? 200 : 502;
        return new Kirby\Http\Response(
          json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json',
          $status
        );
      }
    ]
  ]
];
