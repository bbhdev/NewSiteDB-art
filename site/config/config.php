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

/*
 * Sync ROLE — declared per node via gitignored sidecar (v0.10.220).
 *
 * Node identity (L | A | B) is a DECLARED property of each environment,
 * never inferred from the hostname or anything else. It lives in a
 * per-node sidecar file site/config/sync.role.php that is gitignored AND
 * rsync-excluded — exactly like sync.secret.php — so every node must
 * positively state who it is. The sidecar is dead simple:
 *   <?php return 'L';
 *
 * FAIL CLOSED — there is deliberately NO default. This block previously
 * defaulted to 'L' whenever no host-scoped config matched, which meant
 * any unconfigured environment (a fresh server, a restored backup, a
 * clone) would SILENTLY boot as the privileged authoring origin L — the
 * one role that renders the editor and can overwrite A and B. That
 * fail-open behavior is the footgun this guard closes: a missing or
 * invalid role now HALTS the whole app with "Server role undefined"
 * instead of granting L's powers by accident. Role is policy, not
 * address; it is declared explicitly or the app does not run.
 *
 * The guard lives HERE (not in a plugin or a host-scoped config) because
 * role now comes solely from the sidecar read below — it does not depend
 * on the host-config merge, so $syncRole is already final at this point.
 * die() during config load terminates boot before any route, the Panel,
 * or a sync endpoint can run. Fixing it is a filesystem action (create
 * the sidecar), not an in-app one, so hard-blocking the app is safe.
 */
$syncRole = @include __DIR__ . '/sync.role.php';
if (!in_array($syncRole, ['L', 'A', 'B'], true)) {
    http_response_code(500);
    header('Content-Type: text/plain; charset=utf-8');
    die('Server role undefined');
}

/*
 * Email transport — read from gitignored sidecar (v0.10.275).
 *
 * Infomaniak shared hosting DISABLES PHP mail() (it lands in
 * disable_functions — confirmed by /dev/email-test reporting
 * "Call to undefined function ... mail()"). So every node that must send
 * mail — 2FA codes and password resets ride on this — needs authenticated
 * SMTP (mail.infomaniak.com:465 SSL, auth = a real mailbox).
 *
 * Those credentials are secret, and the host configs (config.<host>.php) are
 * TRACKED in git — so the transport array lives in a per-node sidecar
 * site/config/email.secret.php that is gitignored AND rsync-excluded, exactly
 * like sync.secret.php. Provisioned per node via sftp; see
 * email.secret.example.php for the shape.
 *
 * Missing / unreadable / wrong-shape sidecar → empty array → Kirby falls back
 * to its default mail() transport (broken on Infomaniak, but that's the
 * pre-provisioning state, and /dev/email-test reports it cleanly rather than
 * failing silently).
 */
$emailConfig = @include __DIR__ . '/email.secret.php';
if (!is_array($emailConfig)) {
    $emailConfig = [];
}

/*
 * Two-factor auth (v0.10.277).
 *
 * MANDATORY on the net-exposed nodes (A/B); OFF on L (localhost — 2FA there is
 * pointless friction, and L may have no email sidecar, which would risk a local
 * lockout). Role drives it, so the same tracked config does the right thing on
 * each node.
 *
 *   methods ['password' => ['2fa' => true]] → after the password, Kirby demands
 *   a second factor. auth.challenges defaults to ['totp','email'], so it uses
 *   TOTP (authenticator app) once the user has enrolled one, and falls back to
 *   an emailed code before then. The email fallback is the BOOTSTRAP: the TOTP
 *   enroll affordance only appears once 2fa is on (System::is2FAWithTOTP), so the
 *   first post-flip login on A/B goes via an emailed code, after which the user
 *   enrolls TOTP from the Panel account view. Hence email had to work first.
 *
 *   challenge.email.from — Kirby defaults the code email's From to noreply@<host>
 *   (EmailChallenge.php), a domain the authenticated SMTP mailbox is NOT an alias
 *   of → Infomaniak rejects it. Pin From to the SMTP username (read from the
 *   gitignored sidecar, so no real address is hardcoded here and it auto-matches
 *   whatever mailbox each node uses) so 2FA codes ride the same DKIM-signed
 *   sender proven by /dev/email-test.
 *
 * Lockout recovery, if ever needed: set 2fa back to false here and redeploy, or
 * delete the user's TOTP secret in site/accounts/, then re-enroll.
 */
$emailFrom   = $emailConfig['transport']['username'] ?? null;
$authOptions = [
    'methods' => ($syncRole === 'L') ? ['password'] : ['password' => ['2fa' => true]],
];
if (is_string($emailFrom) && $emailFrom !== '') {
    $authOptions['challenge'] = ['email' => ['from' => $emailFrom]];
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
   * Email transport (v0.10.275). Sourced from the gitignored per-node
   * email.secret.php sidecar (see the $emailConfig block above). Empty
   * until a node is provisioned → Kirby's default mail() transport (which
   * Infomaniak disables, so unprovisioned nodes can't send — by design,
   * surfaced via /dev/email-test).
   */
  'email' => $emailConfig,

  /*
   * Two-factor auth — role-gated (mandatory on A/B, off on L). Built above
   * as $authOptions, with the challenge-email From pinned to the SMTP mailbox
   * for DKIM-signed deliverability. See the $authOptions block for rationale.
   */
  'auth' => $authOptions,

  /*
   * Sync layer — node identity + shared-secret auth (v0.10.140, Slice S1).
   *
   * The forthcoming content-sync layer (per topology memory:
   * sync-layer-topology-and-operations.md) treats this project's three
   * runtime nodes as named participants:
   *
   *   L  = local Mac — the desktop dev / authoring origin.
   *   A  = newsitedbart.bbh.fr — STAGING.
   *   B  = danielbondard.fr — PUBLIC, frozen by default.
   *
   * `role` is sourced from the gitignored per-node sidecar
   * site/config/sync.role.php (see the $syncRole block above) — it is
   * NOT defaulted here and NOT set by the host-scoped configs anymore.
   * The host-scoped configs (config.<SERVER_NAME>.php, rsync-excluded)
   * still override `host`/`peers` per environment; Kirby merges them
   * OVER this base via array_replace_recursive. A node with no valid
   * role sidecar never reaches this array — config load die()s first.
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
    'role'   => $syncRole,
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
        // v0.11.2 — prominent "go to the live site" link. The Panel's two
        // built-in root affordances (the 'site' entry below + the sidebar
        // header title "NewSiteDB Art") BOTH land on the Panel home; neither
        // opens the front-end runtime. The top-right "open" icon does, but
        // it's a minor affordance and the header title isn't reachable from
        // config (it's baked into the compiled k-panel-menu SPA component —
        // repointing it would need a fragile JS plugin override). So clone
        // the runtime link as a labeled sidebar entry instead: an ABSOLUTE
        // URL (with host) the Panel SPA treats as external → same-tab nav to
        // the front end, exactly like the dev-tool entries below.
        'view-site' => [
          'label' => 'View site',
          'icon'  => 'open',
          'link'  => $base,
        ],
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
        // v0.10.193 — point at the Panel page (batches list + "add batch"),
        // not the front-end template route. Panel encodes the page id's
        // "/" as "+", so dev/image-workshop → pages/dev+image-workshop. A
        // Panel-relative link keeps the in-Panel SPA navigation (no full
        // reload), and from a batch the "Open batch in Deco" button jumps
        // into the editor's Images mode.
        'dev-image-workshop' => [
          'label' => 'Image workshop',
          'icon'  => 'images',
          'link'  => 'pages/dev+image-workshop',
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
        $imgChild = Kirby\Cms\Page::create([
          'parent'   => $page,
          'slug'     => 'images',
          'template' => 'image-container',
          'content'  => [
            'title' => 'Image library',
          ],
        ]);
        // Page::create() defaults to a DRAFT → content/<page>/_drafts/images/,
        // which the L→A sync propagate strips (it excludes _drafts/ at ANY
        // depth, by design, for genuine unpublished pages). But the image
        // library is durable per-page assets, NOT unpublished work — every
        // comment here and in the blueprint always described its home as
        // content/<page>/images/ (unlisted). The draft location was only ever
        // an accident of Page::create()'s default. Publish to UNLISTED so the
        // library travels with its parent on push. The blueprint locks
        // changeStatus:false against AUTHORS, so impersonate the almighty
        // 'kirby' user for this system-level publish. (v0.10.240)
        $page->kirby()->impersonate('kirby', function () use ($imgChild) {
          if ($imgChild->isDraft()) {
            $imgChild->changeStatus('unlisted');
          }
        });
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
     * Convergence Slice 1d (v0.10.212) — serve /dev/editor from a VIRTUAL
     * page, not a content/dev/editor/ folder.
     *
     * WHY: content/dev/* is excluded from BOTH delivery paths to a server.
     * deploy.sh excludes all content (only --bootstrap carries it), and the
     * sync propagate excludes the `dev` top-level. So a disk-backed anchor
     * page only ever reached A via the one-time `deploy.sh --bootstrap`
     * seed — which PREDATED /dev/editor (created in Slice 1a, v0.10.157).
     * Result: every post-convergence server showed the opaque error page at
     * /dev/editor because Kirby couldn't resolve the URL to a page.
     * (Diagnosed live on A at v0.10.211; a one-off rsync of the anchor page
     * was the stopgap, this route is the cure.)
     *
     * The editor is a TOOL, not content; it must not depend on a content
     * anchor. Rendering the `editor` template through an in-memory Page makes
     * /dev/editor behave identically on L, A and B with zero content
     * dependency — and every future /dev/* tool can follow the same shape.
     * The template only reads $page->targetPage() (defaulted to 'home') and
     * the ?page= query override, both supplied here.
     *
     * Routes match before page resolution, so this also supersedes any
     * leftover content/dev/editor/ folder on disk (now vestigial — safe to
     * delete from content/, but harmless if left).
     */
    [
      'pattern' => 'dev/editor',
      'method'  => 'GET',
      'action'  => function () {
        $virtual = Kirby\Cms\Page::factory([
          'slug'     => 'editor',
          'template' => 'editor',
          'content'  => [
            'title'      => 'Editor',
            'targetpage' => 'home',
          ],
        ]);
        return $virtual->render();
      },
    ],

    /*
     * GET dev/email-test[?to=<addr>] — prove the email channel works on THIS
     * node before 2FA is made mandatory (2FA's challenge + password-reset
     * fallback ride on email; a node that can't send mail is a lockout waiting
     * to happen). Kirby ships NO "send test" affordance, so this is it.
     *
     * Sends one plain-text message to the logged-in author's address (the
     * inbox that will receive 2FA codes), or to ?to= for an ad-hoc check.
     *
     * Auth: requires a Panel session. The host-scoped 403 gate already blocks
     * anonymous /dev/* on A and B, but L carries no such gate — so we re-check
     * kirby()->user() here too (defense-in-depth; a test mailer must never be
     * anonymously triggerable).
     *
     * Transport: no `email` option block is configured yet, so this exercises
     * Kirby's DEFAULT transport — PHP mail(). A green result means PHP ACCEPTED
     * the message for delivery, NOT that it landed: the real test is the inbox
     * (check spam). If mail() doesn't deliver on Infomaniak, the next step is an
     * authenticated-SMTP sidecar (email.secret.php — gitignored, like
     * sync.secret.php, since host configs are tracked and must not hold creds).
     */
    [
      'pattern' => 'dev/email-test',
      'method'  => 'GET',
      'action'  => function () {
        $kirby = kirby();
        if ($kirby->user() === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'forbidden']),
            'application/json', 403
          );
        }
        $sync = option('sync');
        $role = is_array($sync) && !empty($sync['role']) ? (string)$sync['role'] : 'L';

        // Recipient: the author's own address by default; ?to= overrides.
        // Validate up front so a malformed value fails here, not deep in the
        // mailer with an opaque error.
        $to = trim((string) (get('to') ?? ''));
        if ($to === '') {
          $to = (string) $kirby->user()->email();
        }
        if (filter_var($to, FILTER_VALIDATE_EMAIL) === false) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Invalid recipient address: ' . $to], JSON_UNESCAPED_SLASHES),
            'application/json', 400
          );
        }

        // From must be the authenticated SMTP mailbox (or an authorized alias)
        // or Infomaniak rejects the send; fall back to noreply@<host> only when
        // no SMTP username is configured (the broken default-transport state).
        $host      = parse_url($kirby->url(), PHP_URL_HOST) ?: 'localhost';
        $from      = option('email.transport.username') ?: ('noreply@' . $host);
        $transport = option('email.transport.type', 'mail()');
        $now       = date('c');

        try {
          $kirby->email([
            'from'    => $from,
            'to'      => $to,
            'subject' => 'Kirby email test — ' . $role . ' (' . $host . ')',
            'body'    => "Kirby email-transport test.\n\n"
                       . 'Node role: '  . $role . "\n"
                       . 'Host: '       . $host . "\n"
                       . 'Transport: '  . $transport . "\n"
                       . 'App version: '. (option('version') ?? '?') . "\n"
                       . 'Sent: '       . $now . "\n\n"
                       . "If this reached your inbox, the email channel works — 2FA "
                       . "codes and password resets will be deliverable to this address.\n",
          ]);
        } catch (\Throwable $e) {
          return new Kirby\Http\Response(
            json_encode([
              'ok'        => false,
              'role'      => $role,
              'transport' => $transport,
              'from'      => $from,
              'to'        => $to,
              'error'     => $e->getMessage(),
            ], JSON_UNESCAPED_SLASHES),
            'application/json', 502
          );
        }

        return new Kirby\Http\Response(
          json_encode([
            'ok'        => true,
            'role'      => $role,
            'transport' => $transport,
            'from'      => $from,
            'to'        => $to,
            'sentAt'    => $now,
            'note'      => 'Accepted for delivery — now confirm it ARRIVES in the inbox (check spam). mail()=true does not guarantee delivery.',
          ], JSON_UNESCAPED_SLASHES),
          'application/json'
        );
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
              'schemaVersion'  => $meta['schemaVersion']  ?? null,
              // 2070 Slice 2: classify so the panel can group auto snapshots
              // into a display-only subfolder, keeping them from polluting the
              // user's named saves. 'kind' / 'fromRole' come from meta.json
              // (auto snapshots write kind='auto-pre-propagate' + fromRole;
              // manual saves write neither).
              'kind'           => $meta['kind']           ?? null,
              'fromRole'       => $meta['fromRole']       ?? null
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
        // B-freeze guard (2080 S1): loading a snapshot OVERWRITES content/,
        // so it is a content write — refuse on the frozen public node.
        if ($resp = sync_assert_writable()) return $resp;
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
        // 2095: a snapshot load wholesale-replaced content/ (propagate scope) —
        // advance the L/A ahead-behind clock so the pill reflects that L now
        // differs from A. After the wipe+copy succeeded, never on the failure
        // path above.
        sync_record_activity_and_notify();
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'restored' => $meta]),
          'application/json'
        );
      }
    ],
    /*
     * Snapshot DELETE — S7 first slice (v0.10.213).
     *
     * Body { names: [<string>, …] } (also accepts a single { name }).
     * Batch so the snapshots panel's "Delete checked" can clear several
     * accumulated auto-pre-propagate snapshots in one request. Lets the
     * user do snapshot housekeeping from the editor on A instead of
     * needing FTP/SSH on the server — and delivers per-snapshot delete,
     * which never existed before.
     *
     * Returns { ok, deleted: [names], errors: [{name, error}] }. ok is
     * true only when every requested name was deleted; partial batches
     * still 200 with the breakdown so the client can report precisely.
     *
     * SAFETY: this route does a recursive delete on a server path, so it
     * is guarded twice — (1) the same name validation as save/load (bars
     * '..', leading dot, slashes, FS-unsafe chars), and (2) a
     * path-containment check: the realpath of each target MUST be a
     * DIRECT child of library/ (dirname === realpath(library)). That
     * defeats symlink-escape and any traversal that slipped the regex —
     * nothing outside library/ can ever be removed.
     */
    [
      'pattern' => 'dev/draw/library/delete',
      'method'  => 'POST',
      'action'  => function () {
        $body  = kirby()->request()->body()->toArray();
        $names = [];
        if (isset($body['names']) && is_array($body['names'])) {
          $names = $body['names'];
        } elseif (isset($body['name'])) {
          $names = [$body['name']];
        }
        $names = array_values(array_unique(array_map(
          function ($n) { return trim((string) $n); }, $names
        )));
        if (count($names) === 0) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'No snapshot names given.']),
            'application/json', 400
          );
        }
        $libRoot     = __DIR__ . '/../../library';
        $libRootReal = realpath($libRoot);
        if ($libRootReal === false) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'No library/ directory.']),
            'application/json', 404
          );
        }
        // Identical to save/load so a name accepted on write is always
        // deletable.
        $invalid = function ($name) {
          return
               $name === ''
            || mb_strlen($name) > 80
            || $name === '.' || $name === '..'
            || $name[0] === '.'
            || strpos($name, '..') !== false
            || preg_match('#[\\\\/:\*\?"<>\|\x00-\x1f]#', $name) === 1
            || preg_match('/^[\p{L}\p{N} _.,\'()\[\]\-]+$/u', $name) !== 1;
        };
        // Recursive delete INCLUDING the directory itself (the load
        // endpoint's $wipe keeps the root; here we remove it).
        $rmrf = function ($dir) use (&$rmrf) {
          if (!is_dir($dir)) return true;
          $items = scandir($dir);
          if ($items === false) return false;
          foreach ($items as $it) {
            if ($it === '.' || $it === '..') continue;
            $p = $dir . '/' . $it;
            if (is_dir($p)) {
              if (!$rmrf($p)) return false;
            } else {
              if (@unlink($p) === false) return false;
            }
          }
          return @rmdir($dir);
        };
        $deleted = [];
        $errors  = [];
        foreach ($names as $name) {
          if ($invalid($name)) {
            $errors[] = ['name' => $name, 'error' => 'invalid name'];
            continue;
          }
          $targetReal = realpath($libRoot . '/' . $name);
          // Must resolve to a direct child of library/ that is a dir.
          if ($targetReal === false
              || dirname($targetReal) !== $libRootReal
              || !is_dir($targetReal)) {
            $errors[] = ['name' => $name, 'error' => 'not found'];
            continue;
          }
          if ($rmrf($targetReal)) {
            $deleted[] = $name;
          } else {
            $errors[] = ['name' => $name, 'error' => 'delete failed'];
          }
        }
        return new Kirby\Http\Response(
          json_encode(['ok' => count($errors) === 0, 'deleted' => $deleted, 'errors' => $errors]),
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
     * Typography tokens (Slice 3b-1, v0.10.76; POST retired v0.10.250).
     *
     * Site-wide named type styles, stored at
     * content/_shared/typography-tokens.json with shape
     *   { schemaVersion, tokens: [ {id,name,family,sizePx,weight,
     *     lineHeight,letterSpacingPx,italic,color,isDefault}, ... ],
     *     savedAt, count }
     * — the same _shared pattern as palette.json / font-bundle.json.
     * Read everywhere via deco_load_typography() and emitted as CSS via
     * deco_typography_css() (Slice 3a).
     *
     *   GET dev/draw/typography → { ok, tokens: [...] }
     *
     * READ-ONLY. This used to be a GET|POST route whose POST validated +
     * wrote the file. As of [conv] 3065 (v0.10.247–250) typography is part
     * of the UNIFIED save: the client posts it under the `styles` section of
     * /dev/editor/save, which calls deco_save_typography() (the validator +
     * writer extracted from this route's old POST body — see
     * site/plugins/deco/index.php). The standalone POST is gone; this GET
     * survives as a read-only diagnostic endpoint, symmetric with the
     * sibling dev/draw/typography/usage GET. To change validation, edit
     * deco_save_typography(), not this route.
     */
    [
      'pattern' => 'dev/draw/typography',
      'method'  => 'GET',
      'action'  => function () {
        $tokens = deco_load_typography(kirby()->root('content'));
        return new Kirby\Http\Response(
          json_encode(['ok' => true, 'tokens' => $tokens]),
          'application/json', 200, ['Content-Type' => 'application/json']
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

    /*
     * Convergence Slice 6b (v0.10.200) — the two legacy save routes
     * `dev/draw/save` (lines layer) and `dev/page/save` (layout layer)
     * were DELETED here. They had been reduced to thin wrappers in 5a-1;
     * now that dev-draw.js + dev-page.js are a single dev-editor.js with
     * one save coordinator (Section 3) that POSTs once to dev/editor/save,
     * nothing calls them anymore. The save LOGIC still lives untouched in
     * deco_save_lines() / deco_save_layout() (site/plugins/deco/index.php)
     * — only the per-layer HTTP entry points are gone. The validation +
     * atomic rects.json/lines write semantics they documented (e.g.
     * schemaVersion 1→2 note normalisation) are unchanged inside those
     * helpers and exercised via dev/editor/save below.
     */

    /*
     * Convergence Slice 5a-1 (v0.10.197) — unified editor save seam.
     *
     *   POST dev/editor/save
     *   body: {
     *     page:   "<pageId>",                  // shared target page
     *     lines?:  { byClass, masters?, palette?, pageCfg? },
     *     layout?: { schemaVersion, chapters, rects }
     *   }
     *
     * Dispatches to the SAME deco_save_lines() / deco_save_layout()
     * helpers the legacy dev/draw/save and dev/page/save routes now wrap.
     * The on-disk data shape is unchanged — this only collapses the two
     * client POSTs into one. Either section is optional; at least one
     * must be present. The shared `page` is injected into each section's
     * body so the client needn't repeat it.
     *
     * Response: { ok, lines?: {ok, error?}, layout?: {ok, error?} }.
     * Overall ok = every present section ok. HTTP code = the first
     * failing section's code (else 200). sync_record_activity_and_notify()
     * fires once per request (a save click is one author action regardless
     * of how many layers it touches); sync_bump_page() fires per
     * succeeding section inside the helpers (idempotent — a double bump on
     * the same page just rewrites the same sidecar timestamp).
     *
     * 5b (data-shape alignment) is explicitly deferred — this slice does
     * NOT touch rects.json / lines schema.
     */
    [
      'pattern' => 'dev/editor/save',
      'method'  => 'POST',
      'action'  => function () {
        // B-freeze guard (2080 S1): refuse direct content writes on the
        // frozen public node. Must precede the activity stamp below.
        if ($resp = sync_assert_writable()) return $resp;
        sync_record_activity_and_notify();

        $body = kirby()->request()->body()->toArray();
        $page = $body['page'] ?? null;

        $hasLines  = isset($body['lines'])  && is_array($body['lines']);
        $hasLayout = isset($body['layout']) && is_array($body['layout']);
        // v0.10.247 ([conv] 3065): typography (site-wide element styles) now
        // rides this same atomic POST as a third optional section — no separate
        // "Save styles" request. Written via deco_save_typography() to
        // content/_shared/typography-tokens.json, the same site-wide _shared
        // pattern as the palette that the lines section already writes here.
        $hasStyles = isset($body['styles']) && is_array($body['styles']);

        if (!$hasLines && !$hasLayout && !$hasStyles) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'Nothing to save: provide a lines, layout and/or styles section.']),
            'application/json',
            400
          );
        }

        $out  = ['ok' => true];
        $code = 200;

        if ($hasLines) {
          $lb = $body['lines'];
          $lb['page'] = $page;          // inject shared target page
          $res = deco_save_lines($lb);
          $out['lines'] = $res['ok'] ? ['ok' => true] : ['ok' => false, 'error' => $res['error']];
          if (!$res['ok']) {
            $out['ok'] = false;
            $code = $res['code'] ?? 400;
          }
        }

        if ($hasLayout) {
          $yb = $body['layout'];
          $yb['page'] = $page;          // inject shared target page
          $res = deco_save_layout($yb);
          $out['layout'] = $res['ok'] ? ['ok' => true] : ['ok' => false, 'error' => $res['error']];
          if (!$res['ok']) {
            $out['ok'] = false;
            if ($code === 200) $code = $res['code'] ?? 400;  // first failure wins
          }
        }

        // Styles section is site-wide — no `page` injection (the helper
        // ignores it, writing content/_shared/typography-tokens.json). Echo
        // back the server-normalised tokens so the client adopts the clamped
        // set as its new on-disk baseline, exactly as the standalone
        // /dev/draw/typography POST route did.
        if ($hasStyles) {
          $res = deco_save_typography($body['styles']);
          $out['styles'] = $res['ok']
            ? ['ok' => true, 'tokens' => $res['tokens']]
            : ['ok' => false, 'error' => $res['error']];
          if (!$res['ok']) {
            $out['ok'] = false;
            if ($code === 200) $code = $res['code'] ?? 400;  // first failure wins
          }
        }

        return new Kirby\Http\Response(
          json_encode($out),
          'application/json',
          $code
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
        // B-freeze guard (2080 S1): page-image upload mutates served content.
        if ($resp = sync_assert_writable()) return $resp;
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

        // Resolve the per-page image library (slug 'images') via
        // childrenAndDrafts() so we find it whether it's the new UNLISTED
        // page (content/<page>/images/) or a legacy draft not yet migrated.
        // It's auto-created + published-to-unlisted by the page.create:after
        // hook, but ONLY for canvas-page pages. A page authored under a
        // different template (or created before the hook existed) won't have
        // one — so we lazily provision it here at the filesystem level rather
        // than erroring. Page::create would hit permission checks (this route
        // runs with no Panel user — the same reason we move_uploaded_file
        // rather than createFile below), so we mkdir the unlisted dir directly
        // (content/<page>/images/, NOT _drafts/, so the sync propagate includes
        // it) and drop an image-container content file so Panel recognises it
        // as a page. A subsequent dev/page/images refetch (fresh request,
        // re-reads disk) then sees the new child. (v0.10.240)
        $imgPage = $page->childrenAndDrafts()->findBy('slug', 'images');
        if ($imgPage) {
          $dir = $imgPage->root();
        } else {
          $dir = $page->root() . '/images';
          if (!is_dir($dir) && !@mkdir($dir, 0755, true)) {
            return $json(['ok' => false, 'error' => 'Could not create the image library.'], 500);
          }
          $containerTxt = $dir . '/image-container.txt';
          if (!file_exists($containerTxt)) {
            @file_put_contents($containerTxt, "Title: Image library\n");
          }
        }

        $file = $_FILES['file'] ?? null;
        // When the POST body exceeds post_max_size, PHP discards both $_POST
        // and $_FILES — but the page id check above already passed, so reaching
        // here with an empty $_FILES while CONTENT_LENGTH is large means the
        // upload blew the *total* request cap, not just the per-file one.
        if (!is_array($file)) {
          $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
          if ($len > 0) {
            return $json(['ok' => false, 'error' =>
              'Upload too large for the server: the request (' . round($len / 1048576, 1)
              . ' MB) exceeds PHP post_max_size (' . ini_get('post_max_size')
              . '). Set a smaller "max long edge" so the browser shrinks it first.'], 413);
          }
          return $json(['ok' => false, 'error' => 'No file was received.'], 400);
        }
        $errCode = $file['error'] ?? UPLOAD_ERR_NO_FILE;
        if ($errCode !== UPLOAD_ERR_OK || !isset($file['tmp_name'])) {
          $msg = 'Upload failed.';
          if ($errCode === UPLOAD_ERR_INI_SIZE) {
            $msg = 'Image too large for the server: it exceeds PHP upload_max_filesize ('
              . ini_get('upload_max_filesize') . '). Set a smaller "max long edge" so the '
              . 'browser shrinks it before uploading.';
          } elseif ($errCode === UPLOAD_ERR_FORM_SIZE) {
            $msg = 'Image exceeds the form size limit. Set a smaller "max long edge".';
          } elseif ($errCode === UPLOAD_ERR_PARTIAL) {
            $msg = 'Upload was interrupted — only part of the file arrived. Try again.';
          } elseif ($errCode === UPLOAD_ERR_NO_FILE) {
            $msg = 'No file was selected.';
          } elseif ($errCode === UPLOAD_ERR_NO_TMP_DIR || $errCode === UPLOAD_ERR_CANT_WRITE) {
            $msg = 'Server could not store the upload (temp directory issue).';
          }
          return $json(['ok' => false, 'error' => $msg], $errCode === UPLOAD_ERR_INI_SIZE ? 413 : 400);
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

        // 2095: a page image just landed in content/<page>/images/, which is
        // in propagate scope — advance the L/A ahead-behind clock so the pill
        // doesn't read a false "in sync" while L holds an unpushed image.
        // Placed AFTER the write (unlike editor/save's at-entry stamp): this
        // route has heavy pre-write validation that often bails, and an
        // entry-stamp would itself be a false "ahead" on every rejected upload.
        sync_record_activity_and_notify();
        return $json(['ok' => true, 'filename' => $filename, 'resizedTo' => $resizedTo]);
      }
    ],

    /**
     * Slice 4f — delete one image from a page's library.
     *
     *   POST dev/page/delete-image
     *   body: { page: "<pageId>", filename: "<name.ext>" }
     *
     * Removes the binary plus its Kirby meta sidecar (<name.ext>.txt) from
     * content/<page>/images/. Runs with NO Panel user (same reason
     * as upload-image / use-image), so we unlink at the filesystem level
     * rather than via $file->delete(). The caller (editor Images mode) is
     * responsible for warning the user when the image is still in use; this
     * endpoint just performs the deletion and reports success. Any rects
     * still bound to the filename become dangling and render as "not found
     * in library" — that's the warned-about consequence, not an error here.
     */
    [
      'pattern' => 'dev/page/delete-image',
      'method'  => 'POST',
      'action'  => function () {
        // B-freeze guard (2080 S1): page-image deletion mutates served content.
        if ($resp = sync_assert_writable()) return $resp;
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        $body = $kirby->request()->body()->toArray();

        $pageId   = $body['page'] ?? null;
        $filename = $body['filename'] ?? null;
        if (!is_string($pageId) || !preg_match('~^[a-z0-9][a-z0-9/_-]*$~i', $pageId)) {
          return $json(['ok' => false, 'error' => 'Invalid or missing page id.'], 400);
        }
        // Filename must be a bare basename (no traversal) of an allowed type.
        if (!is_string($filename) || $filename === '' || basename($filename) !== $filename
            || strpos($filename, "\0") !== false) {
          return $json(['ok' => false, 'error' => 'Invalid filename.'], 400);
        }
        $allowedExt = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'];
        $ext = strtolower(pathinfo($filename, PATHINFO_EXTENSION));
        if (!in_array($ext, $allowedExt, true)) {
          return $json(['ok' => false, 'error' => 'Refusing to delete a non-image file.'], 400);
        }

        $page = $kirby->page($pageId);
        if (!$page) {
          return $json(['ok' => false, 'error' => 'Unknown page: ' . $pageId], 404);
        }
        $imgPage = $page->childrenAndDrafts()->findBy('slug', 'images');
        $dir = $imgPage ? $imgPage->root() : ($page->root() . '/images');
        $path = $dir . '/' . $filename;

        if (!is_file($path)) {
          return $json(['ok' => false, 'error' => 'Image not found in this page’s library.'], 404);
        }
        if (!@unlink($path)) {
          return $json(['ok' => false, 'error' => 'Could not delete the image file.'], 500);
        }
        // Kirby stores file metadata in a sibling "<filename>.txt" content
        // file — remove it too so no orphan meta lingers.
        if (is_file($path . '.txt')) { @unlink($path . '.txt'); }

        // 2095: removed a page image from content/<page>/images/ (propagate
        // scope) — advance the L/A ahead-behind clock. After the unlink, so a
        // not-found / failed delete never bumps it.
        sync_record_activity_and_notify();
        return $json(['ok' => true, 'filename' => $filename]);
      }
    ],

    /**
     * v0.10.35 — Image-workshop triage persistence.
     * v0.10.182 (Convergence Slice 4g-1) — MODEL PIVOT: the 3-state verdict
     * (ok/rework/dropped) collapses to a single "use it" boolean, persisted
     * to useit.json (was verdicts.json).
     *
     *   POST dev/image-workshop/save
     *   body: { batch: "<batch page id>", useIt: { "<filename>": true, ... } }
     *
     * Stores the use-it flags for a workshop batch in a per-batch sidecar
     * content/<batch>/useit.json. Mirrors dev/page/save: full-shape
     * validation, atomic tmp+rename write. Batches are Panel DRAFTS, so the
     * page is resolved via the container's childrenAndDrafts() (a plain
     * kirby()->page() would miss drafts).
     *
     * The map is authoritative-by-replacement: the client always sends the
     * complete current map, and off images are simply absent (or falsy) and
     * dropped on write — so useit.json only ever holds files that are ON.
     */
    [
      'pattern' => 'dev/image-workshop/save',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $body  = $kirby->request()->body()->toArray();

        // 2095: NO ahead-behind advance here. useit.json lives under
        // dev/image-workshop/, excluded from BOTH propagate (top-level dev/)
        // and the manifest — it never reaches A/B. Advancing would flag false
        // "unpushed work" for a save that propagates nothing. The propagating
        // act is use-image (the copy into content/), which advances instead.
        $batchId = $body['batch'] ?? null;
        $useIt   = $body['useIt'] ?? null;

        $fail = function (string $msg, int $code = 400) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => $msg]),
            'application/json',
            $code
          );
        };

        if (!is_string($batchId) || $batchId === '' || !is_array($useIt)) {
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

        // Validate against the batch's actual files. Off images (falsy) are
        // dropped; only ON files survive into the saved map.
        $fileNames = $batchPage->files()->pluck('filename');
        $clean     = [];
        foreach ($useIt as $fname => $on) {
          if (!is_string($fname)) {
            return $fail('Use-it key is not a filename string.');
          }
          if (!$on) {
            continue; // off — omit from the saved map
          }
          if (!in_array($fname, $fileNames, true)) {
            return $fail('Unknown file in batch: ' . $fname);
          }
          $clean[$fname] = true;
        }

        $payload = [
          'schemaVersion' => 1,
          'useIt'         => (object) $clean, // {} not [] when empty
        ];
        $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

        $target = $batchPage->root() . '/useit.json';
        $tmp    = $target . '.tmp';
        if (file_put_contents($tmp, $json) === false || !rename($tmp, $target)) {
          @unlink($tmp);
          return $fail('Failed to write useit.json.', 500);
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
        // B-freeze guard (2080 S1): "Use this" copies a workshop image into a
        // page's image library — a served-content mutation.
        if ($resp = sync_assert_writable()) return $resp;
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
          $dir = $target->root() . '/images';
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

        // 2095: this is the workshop's RESULT — a derivative copied into
        // content/<target>/images/ (propagate scope) — so advance the L/A
        // ahead-behind clock here. The workshop's own scratch (useit/sizes/sent
        // under dev/) does NOT advance; only this transfer into content/ does.
        // After the copy, before the sent.json sidecar bookkeeping (itself
        // scratch), so a sidecar miss still leaves the clock correctly bumped.
        sync_record_activity_and_notify();

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

    /**
     * v0.10.185 — Image-workshop "Dropped" delete (Convergence Slice 4g-2).
     *
     *   POST dev/image-workshop/delete-image
     *   body: { batch: "<batch page id>", filename: "<file>" }
     *
     * Permanently removes a source image from a workshop batch — and "the
     * resized if it exists": we delete via Kirby's $file->delete() (under
     * impersonate('kirby'), since routes run with no Panel user), which in
     * one call removes the source file, its sibling "<file>.txt" content
     * meta, AND the file's media-cache folder (every resized derivative the
     * grid/editor ever generated). A raw unlink would leave those media
     * derivatives orphaned, so we deliberately go Kirby-native here (unlike
     * the editor's page-library delete, which has no derivative-purge need).
     *
     * After the file is gone we rekey the per-batch sidecars: drop the
     * filename from useit.json (so a deleted ON image doesn't linger as a
     * phantom pull target) and from sent.json (its transfer history is moot).
     */
    [
      'pattern' => 'dev/image-workshop/delete-image',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        $body = $kirby->request()->body()->toArray();

        // 2095: NO ahead-behind advance — a workshop batch lives under
        // dev/image-workshop/, excluded from propagate and the manifest, so
        // deleting a scratch image changes nothing that reaches A/B. (The
        // page-library delete that DOES propagate is dev/page/delete-image,
        // which advances.)
        $batchId  = $body['batch']    ?? null;
        $filename = $body['filename'] ?? null;

        if (!is_string($batchId) || $batchId === ''
            || !is_string($filename) || $filename === '') {
          return $json(['ok' => false, 'error' => 'Missing or invalid body fields.'], 400);
        }

        // Resolve the batch (drafts included), scoped to the workshop
        // container so an arbitrary page id can't be targeted.
        $container = $kirby->page('dev/image-workshop');
        $batchPage = $container ? $container->childrenAndDrafts()->find($batchId) : null;
        if (!$batchPage || $batchPage->intendedTemplate()->name() !== 'image-workshop-batch') {
          return $json(['ok' => false, 'error' => 'Unknown image-workshop batch: ' . $batchId], 404);
        }

        $img = $batchPage->image($filename);
        if (!$img) {
          return $json(['ok' => false, 'error' => 'Unknown image in batch: ' . $filename], 404);
        }

        // Delete via Kirby so the media-cache derivatives are purged too.
        // Routes carry no Panel user → impersonate the almighty kirby user
        // for the permission check.
        try {
          $kirby->impersonate('kirby');
          $img->delete();
        } catch (\Throwable $e) {
          return $json(['ok' => false, 'error' => 'Could not delete the image: ' . $e->getMessage()], 500);
        }

        // ── Rekey sidecars: drop the deleted filename ────────────────────
        $rekey = function (string $path, string $key) use ($filename) {
          if (!is_file($path)) return;
          $decoded = json_decode(file_get_contents($path), true);
          if (!is_array($decoded) || !isset($decoded[$key]) || !is_array($decoded[$key])) return;
          if (!array_key_exists($filename, $decoded[$key])) return;
          unset($decoded[$key][$filename]);
          $decoded[$key] = (object) $decoded[$key]; // {} not [] when empty
          $jsonStr = json_encode($decoded, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
          $tmp = $path . '.tmp';
          if (file_put_contents($tmp, $jsonStr) !== false) {
            if (!rename($tmp, $path)) { @unlink($tmp); }
          }
        };
        $rekey($batchPage->root() . '/useit.json', 'useIt');
        $rekey($batchPage->root() . '/sent.json',  'sent');
        $rekey($batchPage->root() . '/sizes.json', 'sizes'); // 4g-3f: drop stale per-image size too

        // Sync S3: bump the batch _sync sidecar (draft page → pass root()).
        sync_bump_page($batchPage->id(), $batchPage->root());

        return $json(['ok' => true, 'filename' => $filename]);
      }
    ],

    /**
     * v0.10.189 — Image-workshop per-image long edge (Convergence Slice 4g-3a).
     *
     *   POST dev/image-workshop/resize
     *   body: { batch: "<batch page id>", filename: "<file>", size: <px> }
     *
     * Re-renders ONE image's resized derivative at the given long edge and
     * persists that per-image size to a per-batch sizes.json sidecar
     * ({ schemaVersion, sizes: { "<filename>": px } }). Returns the fresh
     * derivative URL + dims + niceSize + pct/no-shrink note so the card can
     * swap its preview WYSIWYG without a page reload. resize() is read-only
     * generation (no Panel user needed), identical to the grid render.
     *
     * The size is clamped to [200, 8000] to match the image blueprint's
     * maxLongEdge bounds (same clamp as the old global ?size form and
     * use-image). $img->resize($size,$size) fits inside a $size-square box:
     * long edge binds, aspect preserved, no crop.
     */
    [
      'pattern' => 'dev/image-workshop/resize',
      'method'  => 'POST',
      'action'  => function () {
        $kirby = kirby();
        $json  = function ($data, int $code = 200) {
          return new Kirby\Http\Response(json_encode($data), 'application/json', $code);
        };
        $body = $kirby->request()->body()->toArray();

        // 2095: NO ahead-behind advance — resizing a workshop derivative only
        // touches scratch under dev/image-workshop/ (sizes.json + the cached
        // derivative), excluded from propagate and the manifest. Nothing
        // reaches A/B until use-image copies a result into content/.
        $batchId  = $body['batch']    ?? null;
        $filename = $body['filename'] ?? null;
        $sizeRaw  = $body['size']     ?? null;

        if (!is_string($batchId) || $batchId === ''
            || !is_string($filename) || $filename === ''
            || !is_numeric($sizeRaw)) {
          return $json(['ok' => false, 'error' => 'Missing or invalid body fields.'], 400);
        }
        $size = max(200, min(8000, (int) $sizeRaw));

        // Resolve the batch (drafts included), scoped to the workshop
        // container so an arbitrary page id can't be targeted.
        $container = $kirby->page('dev/image-workshop');
        $batchPage = $container ? $container->childrenAndDrafts()->find($batchId) : null;
        if (!$batchPage || $batchPage->intendedTemplate()->name() !== 'image-workshop-batch') {
          return $json(['ok' => false, 'error' => 'Unknown image-workshop batch: ' . $batchId], 404);
        }

        $img = $batchPage->image($filename);
        if (!$img) {
          return $json(['ok' => false, 'error' => 'Unknown image in batch: ' . $filename], 404);
        }

        // Render (or cache-hit) the derivative — byte-identical to a grid
        // render at the same size.
        $resized = $img->resize($size, $size);

        // Persist this image's size into sizes.json (merge, atomic write).
        $sizesPath = $batchPage->root() . '/sizes.json';
        $sizes = [];
        if (is_file($sizesPath)) {
          $decoded = json_decode(@file_get_contents($sizesPath), true);
          if (is_array($decoded) && isset($decoded['sizes']) && is_array($decoded['sizes'])) {
            $sizes = $decoded['sizes'];
          }
        }
        $sizes[$filename] = $size;
        $payload = ['schemaVersion' => 1, 'sizes' => (object) $sizes];
        $jsonStr = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
        $tmp = $sizesPath . '.tmp';
        $sidecarOk = (file_put_contents($tmp, $jsonStr) !== false && rename($tmp, $sizesPath));
        if (!$sidecarOk) { @unlink($tmp); }

        // Sync S3: bump the batch _sync sidecar (draft page → pass root()).
        sync_bump_page($batchPage->id(), $batchPage->root());

        $origLong = max($img->width(), $img->height());
        $noShrink = $size >= $origLong;
        $pct = $origLong > 0
          ? (int) round(($size <= $origLong ? $size : $origLong) / $origLong * 100)
          : 100;

        return $json([
          'ok'       => true,
          'filename' => $filename,
          'size'     => $size,
          'url'      => $resized->url(),
          'width'    => $resized->width(),
          'height'   => $resized->height(),
          'niceSize' => $resized->niceSize(),
          'pct'      => $pct,
          'noShrink' => $noShrink,
          'sidecar'  => $sidecarOk,
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
     * batch's images with a small (320px long-edge) thumbnail, the use-it
     * flag (4g-1; the editor pulls only use-it=on images), and — when
     * ?target is given — whether the image has already been sent to that
     * page (read from the batch's sent.json sidecar).
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

        // Use-it flags (4g-1). Read useit.json; migrate on read from the
        // legacy verdicts.json (verdict 'ok' → use it = on).
        $useIt = [];
        $uPath = $batchPage->root() . '/useit.json';
        if (is_file($uPath)) {
          $d = json_decode(@file_get_contents($uPath), true);
          if (is_array($d) && isset($d['useIt']) && is_array($d['useIt'])) {
            foreach ($d['useIt'] as $fn => $on) { if ($on) $useIt[$fn] = true; }
          }
        } else {
          $vPath = $batchPage->root() . '/verdicts.json';
          if (is_file($vPath)) {
            $d = json_decode(@file_get_contents($vPath), true);
            if (is_array($d) && isset($d['verdicts']) && is_array($d['verdicts'])) {
              foreach ($d['verdicts'] as $fn => $verd) { if ($verd === 'ok') $useIt[$fn] = true; }
            }
          }
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

        // sizes.json (4g-3a): { sizes: { "<filename>": px } }. The per-image
        // workshop long edge. 4g-3f surfaces it so the editor's pull imports
        // at the user's chosen (WYSIWYG) size, not the original.
        $sizes = [];
        $szPath = $batchPage->root() . '/sizes.json';
        if (is_file($szPath)) {
          $d = json_decode(@file_get_contents($szPath), true);
          if (is_array($d) && isset($d['sizes']) && is_array($d['sizes'])) {
            foreach ($d['sizes'] as $fn => $px) {
              if (is_numeric($px)) $sizes[$fn] = max(200, min(8000, (int) $px));
            }
          }
        }

        $images = [];
        foreach ($batchPage->images()->sortBy('filename', 'asc') as $img) {
          $fn = $img->filename();
          $thumb = $img->resize(320, 320);
          $images[] = [
            'filename' => $fn,
            'thumb'    => $thumb->url(),
            'full'     => $img->url(), // 4g-2b: original, for click-to-view lightbox
            'width'    => $img->width(),
            'height'   => $img->height(),
            'useIt'    => !empty($useIt[$fn]),
            'sent'     => $sentTo($fn),
            'size'     => $sizes[$fn] ?? null, // 4g-3f: workshop long edge, null = pull original
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

        // S5.1 — fold in the direction from THIS node's perspective so the
        // poller (sync-peer-indicator snippet) gets ahead/behind/equal
        // without re-deriving the comparison client-side. localAt is this
        // node's lastActivityAt; peerAt comes from the fetched peer state.
        // On a failed fetch peerAt is null → direction collapses to
        // 'ahead'/'equal' (never a spurious 'behind' off a network error).
        $localAt = (string) (sync_state_read()['lastActivityAt'] ?? '');
        $peerAt  = is_array($result['state'] ?? null)
          ? (string) ($result['state']['lastActivityAt'] ?? '')
          : '';
        $dir = sync_direction_between($localAt !== '' ? $localAt : null,
                                      $peerAt  !== '' ? $peerAt  : null);
        $result['peerRole']   = (string) $role;
        $result['localAt']    = $localAt !== '' ? $localAt : null;
        $result['peerAt']     = $peerAt  !== '' ? $peerAt  : null;
        $result['direction']  = $dir['direction'];
        $result['gapSeconds'] = $dir['gapSeconds'];

        return new Kirby\Http\Response(
          json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json',
          $status
        );
      }
    ],

    /*
     * GET /sync/self — this node's direction vs L, computed from LOCAL
     * state only (no outbound fetch). The counterpart to /sync/peer/<role>:
     *
     * L polls /sync/peer/A because L CAN reach A. A (and B) cannot reach L
     * — L is a laptop behind no public address. But L pings its
     * lastActivityAt to A on every save (sync_notify_peers_of_local_activity
     * → A stores it in peerStamps['L']), so A already holds L's latest
     * timestamp. This route compares A's own lastActivityAt against that
     * stored peer stamp and returns the same {direction, gapSeconds} shape,
     * letting A render an informational "L is ahead / in sync" pill with
     * zero network round-trips.
     *
     * Same loopback-only safety as /sync/peer: read-only, a few timestamps,
     * no write surface, no secret exposure.
     */
    [
      'pattern' => 'sync/self',
      'method'  => 'GET',
      'action'  => function () {
        $state    = sync_state_read();
        $localAt  = (string) ($state['lastActivityAt'] ?? '');
        $peers    = is_array($state['peerStamps'] ?? null) ? $state['peerStamps'] : [];
        $peerRole = 'L';   // the upstream this node tracks (A/B both watch L)
        $peerAt   = (string) ($peers[$peerRole] ?? '');
        $dir = sync_direction_between($localAt !== '' ? $localAt : null,
                                      $peerAt  !== '' ? $peerAt  : null);
        $sync = option('sync');
        $role = is_array($sync) ? (string) ($sync['role'] ?? '') : '';
        return new Kirby\Http\Response(
          json_encode([
            'ok'         => true,
            'role'       => $role,
            'peerRole'   => $peerRole,
            'localAt'    => $localAt !== '' ? $localAt : null,
            'peerAt'     => $peerAt  !== '' ? $peerAt  : null,
            'direction'  => $dir['direction'],
            'gapSeconds' => $dir['gapSeconds'],
          ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
          'application/json',
          200
        );
      }
    ],

    /*
     * POST /sync/propagate?from=<role> — receive a content/ push (S4b).
     *
     * The PRIMARY in-app propagate path (the CLI deploy/propagate.sh is
     * the fallback). Strict-direction-only model: this endpoint is the
     * RECEIVE side that the source POSTs to. Body = a gzip tar of the
     * source's content/ (page dirs at the archive root), built with the
     * propagation exclusions already applied. Auth = shared-secret
     * bearer, same as every other /sync/* route.
     *
     * Server steps:
     *   1. authorize + validate ?from=<role>
     *   2. buffer the raw body to a temp .tar.gz under the project root
     *      (same filesystem as content/ so the atomic rename works)
     *   3. extract with PharData to a temp dir; reject empty/unreadable
     *   4. ?dryRun=1 → report what WOULD be replaced, clean up, STOP
     *      (no snapshot, no swap — for the UI confirm/preview + S5).
     *   5. else → take the MANDATORY pre-propagate snapshot of this
     *      node's current content/ (library/auto-pre-propagate-<UTC>-
     *      from-<src>), then atomically swap content/ to the incoming
     *      tree (preserving this node's dev/, error/ and _drafts/), then
     *      bump state.json so the dest no longer looks behind.
     *
     * On a post-snapshot failure the response carries the snapshot name
     * so the user can restore. The swap itself rolls back its move-aside
     * if the second rename fails, so a failed swap leaves content/ intact.
     */
    [
      'pattern' => 'sync/propagate',
      'method'  => 'POST',
      'action'  => function () {
        if ($resp = sync_authorize_request()) return $resp;

        $from = (string) (get('from') ?? '');
        if (!in_array($from, sync_known_roles(), true)) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'missing or invalid ?from=<role> (L|A|B)']),
            'application/json', 400
          );
        }

        // Single-POST transport (S4b.0 verdict): the tar.gz is the raw
        // request body. The client MUST send a binary Content-Type
        // (application/gzip or application/octet-stream) — NOT
        // form-urlencoded/multipart, under which PHP consumes the input
        // stream into $_POST and php://input reads empty (→ a safe but
        // wrong "empty body" 400). S4b.3's L-side push sets it correctly.
        $raw = @file_get_contents('php://input');
        if ($raw === false || strlen($raw) === 0) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'empty request body (expected a content/ tar.gz)']),
            'application/json', 400
          );
        }

        // The buffer → extract → snapshot → atomic-swap → receipt dance
        // is shared with the pull path (sync_ingest_content_tarball), so
        // both directions wipe-and-replace content/ identically. (S4c
        // refactor — behavior unchanged from S4b's inline version.)
        // ?srcActivityAt=<iso8601> carries the SOURCE's lastActivityAt so
        // the destination can ADOPT it on ingest (convergence: both nodes
        // read EQUAL after the swap, not a spurious "behind"). Absent on a
        // legacy/CLI push → ingest falls back to now(). See
        // sync_record_propagate_receipt.
        $r = sync_ingest_content_tarball($raw, $from, (bool) get('dryRun'), (string) get('srcActivityAt'));
        return new Kirby\Http\Response(
          json_encode($r['payload'], JSON_UNESCAPED_SLASHES),
          'application/json', $r['status']
        );
      }
    ],

    /*
     * GET /sync/export[?dryRun=1] — hand THIS node's content/ to a puller
     * (S4c, the A→L back-propagate SEND side).
     *
     * Strict-direction model recap: L has no public URL, so A→L cannot be
     * a push (A can't POST to L). Instead L PULLS — it fetches this
     * endpoint on the source (A) and applies the bytes locally. This is
     * the read-only SEND counterpart to the POST /sync/propagate receive
     * route: it never mutates the node it runs on.
     *
     * Bearer-gated (same shared secret as every /sync/* route) — it
     * exposes content/, so it must not be open. The tarball is the exact
     * wire format /sync/propagate consumes: a gzip tar with page dirs at
     * the archive root and the propagation exclusions already applied
     * (built by sync_build_propagate_tarball()).
     *
     *   ?dryRun=1 → JSON measure of what WOULD be sent (pages/files/bytes,
     *               no tarball) — lets the puller preview the overwrite.
     *   else      → raw gzip body, Content-Type application/gzip.
     */
    [
      'pattern' => 'sync/export',
      'method'  => 'GET',
      'action'  => function () {
        if ($resp = sync_authorize_request()) return $resp;

        $sync = option('sync');
        $role = is_array($sync) ? (string)($sync['role'] ?? '') : '';

        // Build the tarball once (applies exclusions, returns counts).
        // For dryRun we read the counts and discard it; for a real export
        // we stream its bytes. Reusing the push builder keeps the wire
        // format and the exclusion logic identical on both directions.
        $built = sync_build_propagate_tarball();
        if (!$built['ok']) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => $built['error']]),
            'application/json', 500
          );
        }

        if (get('dryRun')) {
          @unlink($built['path']);
          return new Kirby\Http\Response(
            json_encode([
              'ok'     => true,
              'dryRun' => true,
              'role'   => $role,
              'wouldSend' => [
                'pages' => $built['pages'],
                'files' => $built['files'],
                'bytes' => $built['bytes'],
              ],
            ], JSON_UNESCAPED_SLASHES),
            'application/json'
          );
        }

        $body = @file_get_contents($built['path']);
        @unlink($built['path']);
        if ($body === false) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'could not read built tarball']),
            'application/json', 500
          );
        }
        // Raw binary body — the puller reads it whole and feeds it to the
        // shared ingest path (Slice 2). Advertise the counts in headers so
        // a transport-level client can sanity-check without unpacking.
        // X-Sync-Activity-At carries THIS (source) node's lastActivityAt so
        // the puller can ADOPT it on ingest — same convergence rule as the
        // push path's ?srcActivityAt= param. The puller captures it via a
        // CURLOPT_HEADERFUNCTION and threads it into sync_ingest_content_tarball.
        return new Kirby\Http\Response($body, 'application/gzip', 200, [
          'X-Sync-Role'        => $role,
          'X-Sync-Pages'       => (string) $built['pages'],
          'X-Sync-Files'       => (string) $built['files'],
          'X-Sync-Activity-At' => (string) (sync_state_read()['lastActivityAt'] ?? ''),
        ]);
      }
    ],

    /*
     * POST /sync/push/<toRole>[?dryRun=1] — SEND side trigger (S4b.3).
     *
     * Runs ON the source node (L). Tars this node's content/ and POSTs it
     * to <toRole>'s /sync/propagate. This is the route the editor's
     * "Push L → A" button calls (S4b.4). It is a LOCAL action — the
     * authenticated, secret-bearing request is the OUTBOUND one this
     * route makes to the peer; the trigger itself is same-origin from
     * L's own editor surface, so it is not bearer-gated here. (L is the
     * local authoring box; /dev and these triggers are not exposed
     * publicly. A real deployment would additionally firewall it.)
     *
     * ?dryRun=1 forwards as a dry-run to the peer: the peer reports what
     * WOULD be replaced and takes no snapshot / no swap. Used by the UI
     * to preview before the user confirms the real push.
     *
     * Returns the peer's JSON verdict (with httpCode + sent annotations).
     * A transport/local failure returns ok:false with a 502.
     */
    [
      'pattern' => 'sync/push/(:any)',
      'method'  => 'POST',
      'action'  => function (string $toRole) {
        $sync = option('sync');
        if (!is_array($sync) || empty($sync['secret'])) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'sync not configured']),
            'application/json', 503
          );
        }
        // SECURITY (v0.10.252) — local-trigger gate on public nodes.
        // /sync/push is a SAME-ORIGIN editor trigger: the secret-bearing
        // request is the OUTBOUND one this route makes to the peer, so the
        // trigger itself carries no bearer. On L (local authoring box, no
        // public URL) that is fine. On a PUBLIC node (A/B) an
        // unauthenticated caller could otherwise fire a push at will — so
        // require a Panel session there, mirroring the /dev/* host gate.
        // Bearer-gated machine-to-machine routes (/sync/propagate,
        // /sync/export, /sync/relay-push) are deliberately NOT covered here.
        if (($sync['role'] ?? null) !== 'L' && kirby()->user() === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'forbidden']),
            'application/json', 403
          );
        }
        $dryRun = (bool) get('dryRun');
        // force=1 — the explicit "publish anyway" escape hatch for the A→B
        // guard (Slice 3): bypass the unlocked/ahead block on B. Ignored for
        // non-B destinations and dry-runs.
        $force  = (bool) get('force');
        $result = sync_propagate_to_peer($toRole, $dryRun, $force);

        // Map a local/transport failure to 502 (bad upstream); a peer
        // that answered keeps the peer's own ok/error verbatim at 200 so
        // the client can read the structured result either way. An explicit
        // code (e.g. the guard's 409) is honoured ahead of the 502 default.
        $status = 200;
        if (($result['ok'] ?? false) !== true && !isset($result['httpCode'])) {
          $status = $result['code'] ?? 502;
        }
        return new Kirby\Http\Response(
          json_encode($result, JSON_UNESCAPED_SLASHES),
          'application/json', $status
        );
      }
    ],

    /*
     * POST /sync/pull/<fromRole>[?dryRun=1] — RECEIVE side trigger (S4c).
     *
     * The back-propagate counterpart to /sync/push. Runs ON the puller
     * (L): fetches <fromRole>'s /sync/export and applies the bytes to THIS
     * node's content/ (mandatory pre-propagate snapshot lands HERE, since
     * L is now the destination). This is the route the editor's
     * "Pull ← A" button calls.
     *
     * Same trigger semantics as /sync/push: a LOCAL action, same-origin
     * from L's own editor, so not bearer-gated here — the secret rides on
     * the OUTBOUND fetch to the peer's /sync/export (which IS gated). On
     * A/B the route still exists but pulling a role with no configured
     * peer URL is a safe no-op error (A's peers has only B, etc.).
     *
     * ?dryRun=1 forwards to the peer's export dry-run: it reports what it
     * WOULD send and L takes no snapshot / no swap — for the UI preview
     * before the user confirms overwriting local content.
     *
     * Returns the ingest verdict (snapshot name + replaced counts) or the
     * peer's measure (dryRun). A transport/local failure returns 502.
     */
    [
      'pattern' => 'sync/pull/(:any)',
      'method'  => 'POST',
      'action'  => function (string $fromRole) {
        $sync = option('sync');
        if (!is_array($sync) || empty($sync['secret'])) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'sync not configured']),
            'application/json', 503
          );
        }
        // SECURITY (v0.10.252) — local-trigger gate on public nodes.
        // Same rationale as /sync/push above: a same-origin editor trigger
        // with no bearer of its own (the secret rides the OUTBOUND fetch to
        // the peer's /sync/export). Open on L; require a Panel session on a
        // public node (A/B) so it can't be fired unauthenticated.
        if (($sync['role'] ?? null) !== 'L' && kirby()->user() === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'forbidden']),
            'application/json', 403
          );
        }
        $dryRun = (bool) get('dryRun');
        $result = sync_pull_from_peer($fromRole, $dryRun);

        // Same status mapping as push: a local/transport failure → 502;
        // anything the peer/ingest answered keeps its own ok/error at 200.
        $status = 200;
        if (($result['ok'] ?? false) !== true && !isset($result['httpCode'])) {
          $status = 502;
        }
        return new Kirby\Http\Response(
          json_encode($result, JSON_UNESCAPED_SLASHES),
          'application/json', $status
        );
      }
    ],

    /*
     * POST /sync/relay-push/<toRole>[?dryRun=1] — REMOTE publish trigger
     * (publish epic, Slice 3 / 2060). Runs ON the receiving node (A).
     *
     * BEARER-GATED (unlike /sync/push and /sync/pull, which are
     * same-origin local triggers): this is a CROSS-NODE call. A
     * secret-holding peer (L) asks THIS node to push ITS OWN content to
     * <toRole>. The bytes travel from THIS node — on A, relay-push/B runs
     * A→B. This is how "finished on L, publish to B" reaches the public
     * site WITHOUT a physical L→B: L pushes L→A first (so A is current),
     * then calls A's /sync/relay-push/B so A — the single physical source
     * of B's content — publishes A→B. B therefore only ever has one
     * provenance (A) and can never lead a stale A.
     *
     * Returns this node's sync_propagate_to_peer(<toRole>) result verbatim
     * (the destination's /sync/propagate verdict + httpCode + sent), so the
     * caller reads the same {ok,replaced,snapshot} shape as a direct push.
     */
    [
      'pattern' => 'sync/relay-push/(:any)',
      'method'  => 'POST',
      'action'  => function (string $toRole) {
        if ($gate = sync_authorize_request()) return $gate;
        $dryRun = (bool) get('dryRun');
        // force=1 rides the relay too: L → A's relay-push/B carries it so A's
        // own A→B guard can be overridden by the same "publish anyway" intent.
        $force  = (bool) get('force');
        $result = sync_propagate_to_peer($toRole, $dryRun, $force);
        $status = 200;
        if (($result['ok'] ?? false) !== true && !isset($result['httpCode'])) {
          $status = $result['code'] ?? 502;   // honour the guard's 409
        }
        return new Kirby\Http\Response(
          json_encode($result, JSON_UNESCAPED_SLASHES),
          'application/json', $status
        );
      }
    ],

    /*
     * POST /sync/push-via/<viaRole>/<toRole>[?dryRun=1] — LOCAL trigger
     * that fires a peer's relay-push (publish epic, Slice 3 / 2060).
     *
     * Runs ON the requesting node (L). Same-origin editor trigger, so —
     * like /sync/push and /sync/pull — it carries no bearer of its own;
     * the secret rides the OUTBOUND relay call this route makes (via
     * sync_request_relay_push) to <viaRole>'s bearer-gated
     * /sync/relay-push/<toRole>. It is the route L's "Publish to B" button
     * calls AFTER its L→A push, to have A publish A→B. Open on L; the same
     * v0.10.252 public-node guard applies (Panel session required on A/B)
     * so it can't be fired unauthenticated where the node is public.
     */
    [
      'pattern' => 'sync/push-via/(:any)/(:any)',
      'method'  => 'POST',
      'action'  => function (string $viaRole, string $toRole) {
        $sync = option('sync');
        if (!is_array($sync) || empty($sync['secret'])) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'sync not configured']),
            'application/json', 503
          );
        }
        if (($sync['role'] ?? null) !== 'L' && kirby()->user() === null) {
          return new Kirby\Http\Response(
            json_encode(['ok' => false, 'error' => 'forbidden']),
            'application/json', 403
          );
        }
        $dryRun = (bool) get('dryRun');
        $force  = (bool) get('force');   // "publish anyway" → forwarded down the relay
        $result = sync_request_relay_push($viaRole, $toRole, $dryRun, $force);
        $status = 200;
        if (($result['ok'] ?? false) !== true
            && !isset($result['httpCode']) && !isset($result['relayHttpCode'])) {
          $status = $result['code'] ?? 502;   // honour the guard's 409 through the relay
        }
        return new Kirby\Http\Response(
          json_encode($result, JSON_UNESCAPED_SLASHES),
          'application/json', $status
        );
      }
    ],

    /*
     * ── B-unlock state machine (2080 Slice 2a) ────────────────────────
     *
     * B is the public node, frozen by default (sync_b_is_frozen +
     * sync_assert_writable, Slice 1). Direct editing on B is a rare,
     * discouraged edge case that requires UNLOCKING B for a bounded window,
     * editing, BACK-PROPAGATING B→A (so A — the single source for A→B
     * publishes — has the edits), then RE-FREEZING. The re-freeze is GATED
     * behind a successful back-prop (two-step UX, user's call 2026-06-12).
     *
     * The window auto-expires: sync_b_frozen_from_state treats a lapsed
     * unlockExpiresAt as frozen (lazy auto-lock — no cron on shared hosting).
     *
     * GATING: all four mutators are author actions on a PUBLIC node, so they
     * require a Panel session (same rationale as /sync/push's v0.10.252 gate)
     * AND role === 'B'. b-status is an informational GET (no secret in it),
     * read by B's own editor poll and — in Slice 3 — by A/L to block A→B
     * publish while B is unlocked.
     */
    [
      'pattern' => 'sync/b-status',
      'method'  => 'GET',
      'action'  => function () {
        return new Kirby\Http\Response(
          json_encode(sync_b_status(), JSON_UNESCAPED_SLASHES),
          'application/json', 200
        );
      }
    ],
    [
      'pattern' => 'sync/unlock-b',
      'method'  => 'POST',
      'action'  => function () {
        if ($r = sync_b_panel_guard()) return $r;
        $body  = kirby()->request()->body()->toArray();
        $res   = sync_b_unlock($body['hours'] ?? null);
        return new Kirby\Http\Response(
          json_encode($res, JSON_UNESCAPED_SLASHES),
          'application/json', $res['ok'] ? 200 : ($res['code'] ?? 400)
        );
      }
    ],
    [
      'pattern' => 'sync/prolong-b',
      'method'  => 'POST',
      'action'  => function () {
        if ($r = sync_b_panel_guard()) return $r;
        $body  = kirby()->request()->body()->toArray();
        $res   = sync_b_prolong($body['hours'] ?? null);
        return new Kirby\Http\Response(
          json_encode($res, JSON_UNESCAPED_SLASHES),
          'application/json', $res['ok'] ? 200 : ($res['code'] ?? 400)
        );
      }
    ],
    [
      'pattern' => 'sync/backprop-b',
      'method'  => 'POST',
      'action'  => function () {
        if ($r = sync_b_panel_guard()) return $r;
        // The mandatory B→A leg. Reuses the same transport as every other
        // propagate; A (destination) takes its own pre-propagate snapshot.
        // ?dryRun=1 → preview ("would replace N on A"), no stamp. On a real
        // success, stamp lastBackPropAt so the re-freeze gate opens.
        $dryRun = (bool) get('dryRun');
        $result = sync_propagate_to_peer('A', $dryRun);
        if (!$dryRun && ($result['ok'] ?? false) === true) {
          sync_b_record_backprop();
        }
        $result['bStatus'] = sync_b_status_fields(sync_state_read());
        $status = 200;
        if (($result['ok'] ?? false) !== true && !isset($result['httpCode'])) {
          $status = 502;
        }
        return new Kirby\Http\Response(
          json_encode($result, JSON_UNESCAPED_SLASHES),
          'application/json', $status
        );
      }
    ],
    [
      'pattern' => 'sync/refreeze-b',
      'method'  => 'POST',
      'action'  => function () {
        if ($r = sync_b_panel_guard()) return $r;
        $res = sync_b_refreeze();
        return new Kirby\Http\Response(
          json_encode($res, JSON_UNESCAPED_SLASHES),
          'application/json', $res['ok'] ? 200 : ($res['code'] ?? 400)
        );
      }
    ]
  ]
];
