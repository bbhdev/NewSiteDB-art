<?php
/**
 * Per-page image-library container — guard template (v0.10.241).
 *
 * The 'images' child page (one per canvas-page, slug 'images') is
 * plumbing: it exists only to host a page's image files on disk at
 * content/<page>/images/. As of v0.10.240 it is an UNLISTED page (so
 * the L→A sync propagate includes it — drafts are excluded), which
 * means its URL, <page>/images, is now publicly reachable. Without a
 * template Kirby falls back to a bare "<h1>Image library</h1>" render —
 * a stray public page (notably on B once A→B publish ships).
 *
 * It should never be a destination. Bounce any direct hit to the parent
 * canvas page. The library's *files* are still served normally from
 * /media/... and listed by the editor via GET dev/page/images/<id>; only
 * the container PAGE is redirected.
 */
$parent = $page->parent();
go($parent ? $parent->url() : site()->url());
