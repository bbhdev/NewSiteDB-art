<?php
/**
 * /dev/image-workshop container index — Phase 2 Slice 2 workshop
 * (v0.10.33).
 *
 * Lists the batch child pages with a link into each batch's grid
 * view. Pure navigation; the actual triage UI lives in
 * image-workshop-batch.php. Authoring (create batch, drop images)
 * happens in the Panel.
 */
$v       = option('version', 'dev');
// childrenAndDrafts() — batches created in the Panel start life as
// DRAFTS (Kirby's default for new pages until explicitly published).
// children() excludes drafts, which is why a freshly-created batch
// was reachable by direct URL (drafts are visible to logged-in
// users) yet absent from this index. For a dev tool we want every
// batch listed regardless of status; drafts are flagged below.
$batches = $page->childrenAndDrafts()->sortBy('title', 'asc');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Image workshop — <?= $site->title() ?></title>
  <link rel="stylesheet" href="<?= url('assets/css/image-workshop.css') ?>?v=<?= $v ?>">
</head>
<body class="iw-body">
  <header class="iw-toolbar">
    <a class="iw-back" href="<?= esc(kirby()->url() . '/' . kirby()->option('panel.slug', 'panel')) ?>" title="Back to the Kirby Panel">‹ Panel</a>
    <span class="iw-brand">Image workshop</span>
    <span class="iw-version">v<?= esc($v) ?></span>
  </header>

  <main class="iw-index">
    <p class="iw-lead">
      Out-of-workflow batch testbench. Each batch is a pile of
      candidate images you can compare against their resized
      derivatives. Create batches and drop images in the
      <a href="<?= $page->panel()->url() ?>">Panel</a>.
    </p>

    <?php if ($batches->count() === 0): ?>
      <p class="iw-empty">No batches yet. Create one in the Panel, then drop candidate images into it.</p>
    <?php else: ?>
      <ul class="iw-batch-list">
        <?php foreach ($batches as $b): ?>
          <li class="iw-batch-row">
            <a class="iw-batch-link" href="<?= $b->url() ?>">
              <span class="iw-batch-name">
                <?= esc($b->title()) ?>
                <?php if ($b->isDraft()): ?><span class="iw-batch-draft">draft</span><?php endif; ?>
              </span>
              <span class="iw-batch-count"><?= $b->files()->count() ?> image(s)</span>
            </a>
          </li>
        <?php endforeach; ?>
      </ul>
    <?php endif; ?>
  </main>
  <!-- v<?= $v ?> -->
</body>
</html>
